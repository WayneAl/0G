import { configDir, readUserConfig, resolve, type UserConfig } from "@acu/config";
import { Directory, HttpAgentIdResolver } from "@acu/seal";
import { BASE_SEPOLIA_RPC, BASE_SEPOLIA_USDC, CIRCLE_FAUCET } from "@acu/underwriter";
import { OG_TESTNET_INDEXER, OG_TESTNET_RPC } from "@acu/storage/publish";

/**
 * Everything the toolkit needs, resolved exactly once: **env >
 * `~/.acu/config.json` > built-in default**.
 *
 * The file half is what makes `claude mcp add acu -- npx -y @acu/mcp` need no
 * environment variables at all: `acu init` wrote the key, and this server reads
 * the same file. MCP configuration is fixed at install time, so a key that
 * arrived later used to mean removing and re-adding the server; now it does not.
 *
 * The whole surface of "who am I and what am I allowed to spend" lives here, so
 * no tool handler ever reaches for `process.env`. A key that is simply absent is
 * a supported configuration — it makes every paid tool stop at the quote — but a
 * key that is present and malformed is a fault, and throws, wherever it came
 * from.
 */
export interface McpConfig {
  /** ACU_AGENT_KEY > the file's agentKey. Absent → paid tools stop at the quote. */
  agentKey: `0x${string}` | null;
  /** ACU_AGENT_ID, default "1". */
  agentId: string;
  /** ACU_AUDITOR_URL, default "http://localhost:4021/audit". */
  auditorUrl: string;
  /** ACU_AUDITOR_AGENT_ID, default "2". */
  auditorAgentId: string;
  /** ACU_DIRECTORY_JSON (inline), else fetched from ACU_DIRECTORY_URL / the file. */
  directory: Directory;
  /** ACU_REGISTRY. */
  registry: `0x${string}` | null;
  /** ACU_RPC_URL, default OG_TESTNET_RPC. */
  rpcUrl: string;
  /** ACU_INDEXER_URL, default OG_TESTNET_INDEXER. */
  indexerUrl: string;
  /** ACU_PAYMENT_NETWORK, default "eip155:84532". */
  network: `${string}:${string}`;
  /** ACU_LEDGER_PATH, default `<ACU_HOME or ~/.acu>/budget-ledger.json`. */
  ledgerPath: string;
  /** ACU_ALLOWED_PAYTO (comma list); default: the directory's auditor signers. */
  allowedPayTo: `0x${string}`[];
  /** ACU_PUBLISH, default "true". */
  publish: boolean;
  /** ACU_WEB_URL — where `shareUrl` points. Default the project's Pages site. */
  webUrl: string;
  /** ACU_USDC, default Base Sepolia USDC. */
  usdc: `0x${string}`;
  /** ACU_FAUCET_URL, default the Circle faucet. */
  faucetUrl: string;
  /** ACU_PAYMENT_RPC_URL, default Base Sepolia. Where the balance is read. */
  paymentRpcUrl: string;
  /** Where the config came from, so `agent_status` can name it. */
  directoryUrl: string | null;
}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const DEFAULT_WEB_URL = "https://wayneal.github.io/0G";

/**
 * A key the dry-run path can hand to viem without ever using it.
 *
 * `underwrite()` builds its deps before it knows whether it will sign, so it
 * needs *an* account object even when there is nothing to sign with. This is
 * private key 1 — the smallest valid secp256k1 scalar, public knowledge, funded
 * nowhere we care about, and never reached, because `dryRun` is forced true
 * whenever `agentKey` is null.
 */
export const DRY_RUN_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

function requireHex(value: string, name: string, pattern: RegExp, what: string): `0x${string}` {
  if (!pattern.test(value)) throw new Error(`${name} must be ${what}, got ${value.slice(0, 12)}…`);
  return value.toLowerCase() as `0x${string}`;
}

/**
 * The directory, from wherever it was configured.
 *
 * Inline JSON wins over a URL: it is the more explicit of the two, and it is
 * what a test or an air-gapped run supplies. Neither present is a hard error —
 * a resolver with no agents would report every seal as `AGENT_ID_NOT_LIVE`,
 * which reads as "the seals are bad" rather than "you forgot to configure me".
 */
async function loadDirectory(
  env: NodeJS.ProcessEnv,
  url: string | null,
  fetchImpl?: typeof fetch,
): Promise<Directory> {
  const inline = env["ACU_DIRECTORY_JSON"];
  if (inline !== undefined && inline.trim() !== "") {
    return Directory.parse(JSON.parse(inline));
  }
  if (url !== null && url.trim() !== "") {
    return new HttpAgentIdResolver(url, fetchImpl ?? globalThis.fetch).directory();
  }
  throw new Error("ACU_DIRECTORY_URL or ACU_DIRECTORY_JSON is required");
}

export async function loadConfig(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<McpConfig> {
  // The file the CLI wrote. Reading it is what makes zero-env installs work;
  // a file that exists and will not parse throws rather than reading as empty.
  const user: UserConfig = readUserConfig(env);

  const directoryUrl = resolve<string | null>(env["ACU_DIRECTORY_URL"], user.directoryUrl, null);
  const directory = await loadDirectory(env, directoryUrl, fetchImpl);

  const rawKey = resolve<string | null>(env["ACU_AGENT_KEY"], user.agentKey, null);
  const agentKey =
    rawKey === null
      ? null
      : requireHex(rawKey.trim(), keySource(env), HEX_KEY, "a 0x-prefixed 32-byte private key");

  const rawRegistry = resolve<string | null>(env["ACU_REGISTRY"], user.registry, null);
  const registry =
    rawRegistry === null
      ? null
      : requireHex(rawRegistry.trim(), "ACU_REGISTRY", HEX_ADDRESS, "a 0x-prefixed 20-byte address");

  const network = env["ACU_PAYMENT_NETWORK"] ?? "eip155:84532";
  if (!network.includes(":")) {
    throw new Error(`ACU_PAYMENT_NETWORK must be a CAIP-2 id like eip155:84532, got ${network}`);
  }

  const rawPayTo = env["ACU_ALLOWED_PAYTO"];
  const allowedPayTo =
    rawPayTo === undefined || rawPayTo.trim() === ""
      ? // Nobody configured a payee allowlist, so the auditors we already know
        // about are the only addresses this agent may ever pay.
        directory.agents.filter((a) => a.role === "auditor").map((a) => a.signer)
      : rawPayTo
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .map((s) => requireHex(s, "ACU_ALLOWED_PAYTO", HEX_ADDRESS, "a comma-separated list of addresses"));

  return {
    agentKey,
    agentId: resolve(env["ACU_AGENT_ID"], user.agentId, "1"),
    auditorUrl: resolve(env["ACU_AUDITOR_URL"], user.auditorUrl, "http://localhost:4021/audit"),
    auditorAgentId: resolve(env["ACU_AUDITOR_AGENT_ID"], null, "2"),
    directory,
    registry,
    rpcUrl: resolve(env["ACU_RPC_URL"], null, OG_TESTNET_RPC),
    indexerUrl: resolve(env["ACU_INDEXER_URL"], null, OG_TESTNET_INDEXER),
    network: network as `${string}:${string}`,
    // Next to the config that names the key it protects, and ACU_HOME-aware, so
    // a test never spends against the developer's real ledger.
    ledgerPath: resolve(env["ACU_LEDGER_PATH"], user.ledgerPath, `${configDir(env)}/budget-ledger.json`),
    allowedPayTo,
    publish: (env["ACU_PUBLISH"] ?? "true") !== "false",
    webUrl: resolve(env["ACU_WEB_URL"], user.webUrl, DEFAULT_WEB_URL),
    usdc: resolve(env["ACU_USDC"], null, BASE_SEPOLIA_USDC),
    faucetUrl: resolve(env["ACU_FAUCET_URL"], null, CIRCLE_FAUCET),
    paymentRpcUrl: resolve(env["ACU_PAYMENT_RPC_URL"], null, BASE_SEPOLIA_RPC),
    directoryUrl,
  };
}

/** Named so a malformed key blames the place it actually came from. */
const keySource = (env: NodeJS.ProcessEnv): string =>
  env["ACU_AGENT_KEY"] !== undefined && env["ACU_AGENT_KEY"].trim() !== ""
    ? "ACU_AGENT_KEY"
    : "agentKey in ~/.acu/config.json";
