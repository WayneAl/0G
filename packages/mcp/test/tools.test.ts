import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { recoverSealSigner } from "@acu/seal";

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
 * The example seals expired on 2026-09-02 — they were recorded with a 24-hour
 * life, as real seals are. Every "this seal is good" assertion therefore has to
 * say *when* it is asking, which is what `now` is for; one case below asks
 * without it and gets SEAL_EXPIRED, which is the honest answer today.
 */
const BEFORE_EXPIRY = SEAL_A["verdict"].expiresAt - 1;

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

  it("reports the same seal as expired when asked about now", async () => {
    const res = await client.callTool({ name: "verify_seal", arguments: { seal: SEAL_A } });
    const body = JSON.parse(textOf(res));
    expect(body).toMatchObject({ valid: false, failure: "SEAL_EXPIRED" });
    // An invalid seal is an answer, not a tool failure.
    expect(res.isError).toBeFalsy();
  });

  it("catches the tampered seal B as SIGNER_MISMATCH", async () => {
    const res = await client.callTool({
      name: "verify_seal",
      arguments: { seal: EXAMPLES["tampered"], now: BEFORE_EXPIRY },
    });
    expect(JSON.parse(textOf(res))).toMatchObject({ valid: false, failure: "SIGNER_MISMATCH" });
  });

  it("catches the unattested seal B as ATTESTATION_MISSING", async () => {
    const res = await client.callTool({
      name: "verify_seal",
      arguments: { seal: EXAMPLES["noattest"], now: BEFORE_EXPIRY },
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
  });
});
