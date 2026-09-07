import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { recoverSealSigner } from "@acu/seal";
import { refusalForThrow } from "../src/tools/underwrite.js";
import { bigintReplacer } from "../src/tools/shared.js";

// One real child process, one real RPC read. Both are slow on a cold cache.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BIN = fileURLToPath(new URL("../bin/acu-mcp.mjs", import.meta.url));
const read = (rel: string): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

/** Real recorded seals — the same bytes the browser verifier ships. */
const SEAL_A = read("../../../verifier/example-sealA.json");
const EXAMPLES = read("../../../verifier/examples.json");

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
  delete env["ACU_AGENT_KEY"];

  client = new Client({ name: "acu-mcp-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [BIN], env }));
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe("the acu MCP server, over a real stdio transport", () => {
  it("exposes exactly the six tools that are the contract", async () => {
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

describe("bigintReplacer", () => {
  it("renders a bigint as a string, because JSON.stringify cannot", () => {
    expect(JSON.stringify({ amountAtomic: 10000n, price: "$0.01" }, bigintReplacer)).toBe(
      '{"amountAtomic":"10000","price":"$0.01"}',
    );
  });
});
