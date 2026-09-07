import { homedir } from "node:os";
import { Directory, HttpAgentIdResolver } from "@acu/seal";
import { OG_TESTNET_INDEXER, OG_TESTNET_RPC } from "@acu/storage/publish";

/**
 * Everything the toolkit needs, read from the environment exactly once.
 *
 * The whole surface of "who am I and what am I allowed to spend" lives here, so
 * no tool handler ever reaches for `process.env`. A key that is simply absent is
 * a supported configuration — it makes every paid tool stop at the quote — but a
 * key that is present and malformed is a fault, and throws.
 */
export interface McpConfig {
  /** ACU_AGENT_KEY. Absent → every paid tool stops at the quote. */
  agentKey: `0x${string}` | null;
  /** ACU_AGENT_ID, default "1". */
  agentId: string;
  /** ACU_AUDITOR_URL, default "http://localhost:4021/audit". */
  auditorUrl: string;
  /** ACU_AUDITOR_AGENT_ID, default "2". */
  auditorAgentId: string;
  /** ACU_DIRECTORY_JSON (inline) or fetched from ACU_DIRECTORY_URL at startup. */
  directory: Directory;
  /** ACU_REGISTRY. */
  registry: `0x${string}` | null;
  /** ACU_RPC_URL, default OG_TESTNET_RPC. */
  rpcUrl: string;
  /** ACU_INDEXER_URL, default OG_TESTNET_INDEXER. */
  indexerUrl: string;
  /** ACU_PAYMENT_NETWORK, default "eip155:84532". */
  network: `${string}:${string}`;
  /** ACU_LEDGER_PATH, default `${os.homedir()}/.acu/budget-ledger.json`. */
  ledgerPath: string;
  /** ACU_ALLOWED_PAYTO (comma list); default: the directory's auditor signers. */
  allowedPayTo: `0x${string}`[];
  /** ACU_PUBLISH, default "true". */
  publish: boolean;
  /** ACU_WEB_URL — where `shareUrl` points. Default the project's Pages site. */
  webUrl: string;
}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const DEFAULT_WEB_URL = "https://wayneal.github.io/0G";

/**
 * A key the dry-run path can hand to viem without ever using it.
 *
 * `underwrite()` builds its deps before it knows whether it will sign, so it
 * needs *an* account object even when there is nothing to sign with. This is the
 * canonical anvil key 0 — public, funded nowhere we care about, and never
 * reached, because `dryRun` is forced true whenever `agentKey` is null.
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
async function loadDirectory(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Directory> {
  const inline = env["ACU_DIRECTORY_JSON"];
  if (inline !== undefined && inline.trim() !== "") {
    return Directory.parse(JSON.parse(inline));
  }
  const url = env["ACU_DIRECTORY_URL"];
  if (url !== undefined && url.trim() !== "") {
    return new HttpAgentIdResolver(url, fetchImpl ?? globalThis.fetch).directory();
  }
  throw new Error("ACU_DIRECTORY_URL or ACU_DIRECTORY_JSON is required");
}

export async function loadConfig(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<McpConfig> {
  const directory = await loadDirectory(env, fetchImpl);

  const rawKey = env["ACU_AGENT_KEY"];
  const agentKey =
    rawKey === undefined || rawKey.trim() === ""
      ? null
      : requireHex(rawKey.trim(), "ACU_AGENT_KEY", HEX_KEY, "a 0x-prefixed 32-byte private key");

  const rawRegistry = env["ACU_REGISTRY"];
  const registry =
    rawRegistry === undefined || rawRegistry.trim() === ""
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
    agentId: env["ACU_AGENT_ID"] ?? "1",
    auditorUrl: env["ACU_AUDITOR_URL"] ?? "http://localhost:4021/audit",
    auditorAgentId: env["ACU_AUDITOR_AGENT_ID"] ?? "2",
    directory,
    registry,
    rpcUrl: env["ACU_RPC_URL"] ?? OG_TESTNET_RPC,
    indexerUrl: env["ACU_INDEXER_URL"] ?? OG_TESTNET_INDEXER,
    network: network as `${string}:${string}`,
    ledgerPath: env["ACU_LEDGER_PATH"] ?? `${homedir()}/.acu/budget-ledger.json`,
    allowedPayTo,
    publish: (env["ACU_PUBLISH"] ?? "true") !== "false",
    webUrl: env["ACU_WEB_URL"] ?? DEFAULT_WEB_URL,
  };
}
