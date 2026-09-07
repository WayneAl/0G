import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { recoverSealSigner } from "@0x402/seal";
import { refusalForThrow } from "../src/tools/underwrite.js";
import { bigintReplacer } from "../src/tools/shared.js";
import { DEFAULT_WEB_URL, loadConfig } from "../src/config.js";
import { configPath } from "@0x402/config";

// One real child process, one real RPC read. Both are slow on a cold cache.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BIN = fileURLToPath(new URL("../bin/acu-mcp.mjs", import.meta.url));
const read = (rel: string): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

/** Real recorded seals — the same bytes the browser verifier ships. */
const SEAL_A = read("../../../web/public/examples/example-sealA.json");
const EXAMPLES = read("../../../web/public/examples/examples.json");

/** CleanUSD on 0G testnet, from demo/fixtures/replay/clean.json. */
const CLEAN_USD = "0xdb08ce217ce842b06baf76a0bbb2c10f47ff9eb8";

/**
 * Real seals expire, so every assertion about one has to say *when* it is
 * asking — that is what `now` is for. The fixtures were re-recorded live on
 * 2026-09-07 (commit 3d9de60) and are inside their window again, so the expiry
 * case below asks about a moment past `expiresAt` rather than about the clock.
 */
const BEFORE_EXPIRY = SEAL_A["verdict"].expiresAt - 1;
const AFTER_EXPIRY = SEAL_A["verdict"].expiresAt + 1;

/**
 * Each fixture has its own window — `noattest` was recorded seconds after the
 * others — and attestation is checked *after* expiry, so borrowing another
 * seal's bound would silently turn ATTESTATION_MISSING into SEAL_EXPIRED.
 */
const beforeExpiryOf = (seal: Record<string, any>): number =>
  (seal["expiresAt"] ?? seal["verdict"].expiresAt) - 1;

let client: Client;

const TOOL_NAMES = [
  "describe_auditor",
  "quote_audit",
  "hire_audit",
  "verify_seal",
  "underwrite",
  "get_listing",
  "agent_status",
];

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

beforeAll(async () => {
  // The directory is built from the signatures themselves: whoever actually
  // signed these seals is who agent 1 and agent 2 are.
  const directory = {
    agents: [
      { agentId: "1", signer: await recoverSealSigner(SEAL_A), role: "underwriter" },
      { agentId: "2", signer: await recoverSealSigner(SEAL_A["delegations"][0].seal), role: "auditor" },
    ],
  };

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env["ACU_DIRECTORY_JSON"] = JSON.stringify(directory);
  // Port 1 is not a port anything listens on: the auditor is reachably absent.
  env["ACU_AUDITOR_URL"] = "http://127.0.0.1:1/audit";
  env["ACU_LEDGER_PATH"] = join(mkdtempSync(join(tmpdir(), "acu-mcp-")), "budget-ledger.json");
  // The server now reads ~/.acu/config.json, so the suite must be pointed at an
  // empty one: a developer's real key must never reach a test.
  env["ACU_HOME"] = mkdtempSync(join(tmpdir(), "acu-home-"));
  delete env["ACU_AGENT_KEY"];

  client = new Client({ name: "acu-mcp-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [BIN], env }));
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe("the acu MCP server, over a real stdio transport", () => {
  it("exposes exactly the seven tools that are the contract", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("verifies the real seal A as of a time it was still live", async () => {
    const res = await client.callTool({
      name: "verify_seal",
      arguments: { seal: JSON.stringify(SEAL_A), now: BEFORE_EXPIRY },
    });
    const body = JSON.parse(textOf(res));
    expect(body, textOf(res)).toMatchObject({ valid: true, type: "underwriting" });
    expect(res.isError).toBeFalsy();
  });

  it("reports a seal as expired when asked about a time past its expiry", async () => {
    const res = await client.callTool({
      name: "verify_seal",
      arguments: { seal: SEAL_A, now: AFTER_EXPIRY },
    });
    const body = JSON.parse(textOf(res));
    expect(body).toMatchObject({ valid: false, failure: "SEAL_EXPIRED" });
    // An invalid seal is an answer, not a tool failure.
    expect(res.isError).toBeFalsy();
  });

  /**
   * A seal pasted out of another tool arrives with extra keys and checksummed
   * hex. The verifier parses that away before it recovers anything, so a signer
   * recovered from the *input* is a different address than the one that was
   * actually checked — `valid: true` beside a signer who signed nothing.
   */
  it("reports the true signer even when the input carries an extra key", async () => {
    const res = await client.callTool({
      name: "verify_seal",
      arguments: { seal: { ...SEAL_A, note: "pasted from somewhere else" }, now: BEFORE_EXPIRY },
    });
    const body = JSON.parse(textOf(res));
    expect(body, textOf(res)).toMatchObject({ valid: true, type: "underwriting" });
    expect(String(body.signer).toLowerCase()).toBe((await recoverSealSigner(SEAL_A)).toLowerCase());
  });

  it("catches the tampered seal B as SIGNER_MISMATCH", async () => {
    const res = await client.callTool({
      name: "verify_seal",
      arguments: { seal: EXAMPLES["tampered"], now: beforeExpiryOf(EXAMPLES["tampered"]) },
    });
    expect(JSON.parse(textOf(res))).toMatchObject({ valid: false, failure: "SIGNER_MISMATCH" });
  });

  it("catches the unattested seal B as ATTESTATION_MISSING", async () => {
    const res = await client.callTool({
      name: "verify_seal",
      arguments: { seal: EXAMPLES["noattest"], now: beforeExpiryOf(EXAMPLES["noattest"]) },
    });
    expect(JSON.parse(textOf(res))).toMatchObject({ valid: false, failure: "ATTESTATION_MISSING" });
  });

  it("says AUDITOR_UNREACHABLE rather than hanging when nobody is home", async () => {
    const res = await client.callTool({ name: "describe_auditor", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("AUDITOR_UNREACHABLE");
  });

  it("turns an auditor that never answers into a refusal at the quote stage", async () => {
    // Makes one real read of CleanUSD's bytecode on 0G testnet. If the RPC is
    // down the assertion message below carries the reason.
    const res = await client.callTool({ name: "quote_audit", arguments: { token: CLEAN_USD } });
    const text = textOf(res);
    expect(text, `quote_audit answered: ${text}`).toContain('"stage": "quote"');
    expect(text).toContain("AUDITOR_UNREACHABLE");
  });

  it("answers agent_status with no key by naming the CLI, not a re-install", async () => {
    const res = await client.callTool({ name: "agent_status", arguments: {} });
    const body = JSON.parse(textOf(res));
    expect(body, textOf(res)).toMatchObject({ hasKey: false, nextStep: "Run: npx @0x402/cli init" });
    // Having no key yet is a state, not a fault.
    expect(res.isError).toBeFalsy();
    // The auditor on port 1 is not answering, and the payload says so plainly.
    expect(body.auditor.online).toBe(false);
  });

  it("names the auditor instead of leaking a bare fetch error out of underwrite", async () => {
    const res = await client.callTool({
      name: "underwrite",
      arguments: { token: CLEAN_USD, settle: false, publish: false },
    });
    const text = textOf(res);
    expect(text, `underwrite answered: ${text}`).toContain("AUDITOR_UNREACHABLE");
    // A refusal is an answer here exactly as it is in quote_audit and hire_audit.
    expect(res.isError).toBeFalsy();
  });
});

describe("the refusal a throw out of underwrite() becomes", () => {
  it("blames the auditor only for the stages the auditor is on", () => {
    expect(refusalForThrow("quote", new Error("fetch failed"), null)).toMatchObject({
      ok: false,
      stage: "quote",
      code: "AUDITOR_UNREACHABLE",
    });
    expect(refusalForThrow("hire", new Error("fetch failed"), null)).toMatchObject({
      code: "AUDITOR_UNREACHABLE",
    });
  });

  it("names the stage instead when the auditor is not the party that failed", () => {
    const r = refusalForThrow("compose", new Error("boom"), null) as Record<string, unknown>;
    expect(r["stage"]).toBe("compose");
    expect(r["code"]).not.toBe("AUDITOR_UNREACHABLE");
    expect(String(r["detail"])).toContain("boom");
    expect(refusalForThrow("settle", new Error("reverted"), null)).toMatchObject({
      stage: "settle",
      code: "LIST_FAILED",
    });
  });

  it("keeps a seal A that was already signed when a later stage throws", () => {
    const r = refusalForThrow("settle", new Error("reverted"), SEAL_A as never) as Record<string, unknown>;
    expect(r["sealA"]).toBeTruthy();
  });
});

describe("loadConfig — env > ~/.acu/config.json > default", () => {
  /**
   * A directory has to name an auditor for the server to be able to do anything,
   * so every case that is not *about* the directory supplies a usable one.
   */
  const SOME_DIRECTORY = {
    agents: [
      { agentId: "1", signer: `0x${"1a".repeat(20)}`, role: "underwriter" },
      { agentId: "2", signer: `0x${"2b".repeat(20)}`, role: "auditor" },
    ],
  };
  const home = (): NodeJS.ProcessEnv => ({
    ACU_HOME: mkdtempSync(join(tmpdir(), "acu-home-")),
    ACU_DIRECTORY_JSON: JSON.stringify(SOME_DIRECTORY),
  });
  const KEY = `0x${"11".repeat(32)}`;
  const OTHER = `0x${"22".repeat(32)}`;

  const withKeyOnDisk = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    writeFileSync(configPath(env), JSON.stringify({ agentKey: KEY, agentId: "7" }), { mode: 0o600 });
    return env;
  };

  it("takes the key the CLI wrote when the environment says nothing", async () => {
    const config = await loadConfig(withKeyOnDisk(home()));
    expect(config.agentKey).toBe(KEY);
    expect(config.agentId).toBe("7");
  });

  it("lets the environment win over the file", async () => {
    const env = withKeyOnDisk(home());
    const config = await loadConfig({ ...env, ACU_AGENT_KEY: OTHER, ACU_AGENT_ID: "9" });
    expect(config.agentKey).toBe(OTHER);
    expect(config.agentId).toBe("9");
  });

  it("is a supported configuration with neither: paid tools stop at the quote", async () => {
    const config = await loadConfig(home());
    expect(config.agentKey).toBeNull();
    expect(config.agentId).toBe("1");
  });

  it("keeps the budget ledger under ACU_HOME rather than the real ~/.acu", async () => {
    const env = home();
    const config = await loadConfig(env);
    expect(config.ledgerPath).toBe(join(env["ACU_HOME"] as string, "budget-ledger.json"));
  });

  it("throws rather than running with a key that is not a key", async () => {
    const env = home();
    writeFileSync(configPath(env), JSON.stringify({ agentKey: "hunter2" }));
    await expect(loadConfig(env)).rejects.toThrow(/config\.json/);
  });

  /**
   * A key is rejected for being the wrong shape, not for being the wrong value:
   * a mistyped 65-character key is still 64 characters of somebody's real
   * secret. This message travels to stderr, an issue, or an MCP client's
   * transcript, so it may say how long the value was and never what it was.
   */
  it("never quotes the key back when it rejects one", async () => {
    const env = home();
    const nearlyRight = `0x${"ab".repeat(32)}cd`; // one byte too long
    writeFileSync(configPath(env), JSON.stringify({ agentKey: nearlyRight }));
    const err = await loadConfig(env).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, "a 66-byte key must be rejected").not.toBeNull();
    expect(err?.message).not.toContain(nearlyRight.slice(0, 6));
    expect(err?.message).toContain(`${nearlyRight.length} characters`);
    // And it still says which of the two places to go and fix.
    expect(err?.message).toContain("config.json");
  });
});

/**
 * `claude mcp add acu -- npx -y @0x402/mcp` has no `-e` flags, so the server has to
 * find a directory on its own or it cannot start — and MCP configuration is
 * fixed at install time, which makes "add one env var" the worst possible fix.
 */
describe("loadConfig — the directory, with nothing configured", () => {
  const bare = (): NodeJS.ProcessEnv => ({ ACU_HOME: mkdtempSync(join(tmpdir(), "acu-home-")) });

  const jsonResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  it("reads the site's directory.json when no directory is configured", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      asked.push(String(url));
      return jsonResponse({
        agents: [{ agentId: "2", signer: `0x${"2b".repeat(20)}`, role: "auditor" }],
      });
    }) as unknown as typeof fetch;

    const config = await loadConfig(bare(), fetchImpl);
    expect(config.directoryUrl).toBe(`${DEFAULT_WEB_URL}/directory.json`);
    expect(asked).toEqual([`${DEFAULT_WEB_URL}/directory.json`]);
    expect(config.directory.agents).toHaveLength(1);
  });

  it("follows ACU_WEB_URL, so a fork's own site is where its agents come from", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      asked.push(String(url));
      return jsonResponse({
        agents: [{ agentId: "2", signer: `0x${"2b".repeat(20)}`, role: "auditor" }],
      });
    }) as unknown as typeof fetch;

    const config = await loadConfig({ ...bare(), ACU_WEB_URL: "https://example.test/site" }, fetchImpl);
    expect(config.directoryUrl).toBe("https://example.test/site/directory.json");
    expect(asked).toEqual(["https://example.test/site/directory.json"]);
  });

  /**
   * A fallback, not a default: the site may not be up yet, or the machine may be
   * offline, and refusing to start would strand someone who has configured
   * nothing wrong. It says so on stderr, because a *configured* directory
   * failing is a real problem and must not look like a normal boot.
   */
  it("falls back to the reference agents when the directory cannot be read, out loud", async () => {
    const noted: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      noted.push(args.map(String).join(" "));
    });
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND wayneal.github.io");
    }) as unknown as typeof fetch;

    try {
      const config = await loadConfig(bare(), fetchImpl);
      expect(config.directory.agents.map((a) => a.agentId).sort()).toEqual(["1", "2"]);
      expect(config.allowedPayTo).toHaveLength(1);
      expect(noted.join("\n")).toContain(`${DEFAULT_WEB_URL}/directory.json`);
      expect(noted.join("\n")).toContain("ENOTFOUND");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * An empty directory used to be accepted, and then every seal came back
   * `AGENT_ID_NOT_LIVE` — which reads as "these seals are bad" rather than "this
   * server has nobody to hire". It is a configuration fault, so it fails here.
   */
  it("refuses a directory that names no auditor", async () => {
    const env = {
      ...bare(),
      ACU_DIRECTORY_JSON: JSON.stringify({
        agents: [{ agentId: "1", signer: `0x${"1a".repeat(20)}`, role: "underwriter" }],
      }),
    };
    await expect(loadConfig(env)).rejects.toThrow(/DIRECTORY_HAS_NO_AUDITOR/);
  });

  it("refuses an empty directory for the same reason", async () => {
    const env = { ...bare(), ACU_DIRECTORY_JSON: JSON.stringify({ agents: [] }) };
    await expect(loadConfig(env)).rejects.toThrow(/DIRECTORY_HAS_NO_AUDITOR/);
  });
});

describe("bigintReplacer", () => {
  it("renders a bigint as a string, because JSON.stringify cannot", () => {
    expect(JSON.stringify({ amountAtomic: 10000n, price: "$0.01" }, bigintReplacer)).toBe(
      '{"amountAtomic":"10000","price":"$0.01"}',
    );
  });
});
