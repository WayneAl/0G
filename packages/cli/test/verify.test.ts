import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { signSealA, signSealB, type SealA, type SealB, type Unsigned } from "@0x402/seal";
import { main } from "../src/index.js";

/**
 * `acu verify` re-derives a row report from the one answer `@0x402/seal` gives
 * it, so what these hold it to is the report: which row it reddens, and which
 * rows it is entitled to call "not reached".
 *
 * The directory is passed inline, so nothing here touches the network or the
 * developer's own `~/.acu`.
 */
const agentA = privateKeyToAccount(`0x${"33".repeat(32)}`);
const agentB = privateKeyToAccount(`0x${"44".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"55".repeat(32)}`);

const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const REQUEST = keccak256(toHex("audit-request"));
// Fixed, so nothing here depends on the wall clock. Every seal below outlives it
// by a day, and `acu verify` reads the real clock — hence the far future.
const EXPIRES = 4_000_000_000;

const DIRECTORY = JSON.stringify({
  agents: [
    { agentId: "1", signer: agentA.address, role: "underwriter" },
    { agentId: "2", signer: agentB.address, role: "auditor" },
  ],
});

const env = (): NodeJS.ProcessEnv => ({
  ACU_HOME: mkdtempSync(join(tmpdir(), "acu-verify-")),
  ACU_DIRECTORY_JSON: DIRECTORY,
});

const capture = (
  e: NodeJS.ProcessEnv,
): { io: { out: (l: string) => void; env: NodeJS.ProcessEnv }; lines: string[] } => {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), env: e }, lines };
};

/** The row report as `{ label: mark }`, which is the whole thing under test. */
const marks = (lines: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = /^ {2}([✓✗·]) (.+?) {2,}(.*)$/.exec(line);
    if (m) out[m[2]!.trim()] = m[1]!;
  }
  return out;
};

const sealBOver = async (over: Partial<Unsigned<SealB>> = {}, signer = agentB): Promise<SealB> =>
  signSealB(
    {
      version: 1,
      type: "audit",
      agentId: "2",
      subject: TOKEN,
      request: REQUEST,
      inference: {
        model: "0gm-1.0-35b-a3b",
        trustMode: "verified",
        providerAddress: "0xd9966e13a6026fcca4b13e7ff95c94de268c471c",
        promptHash: keccak256(toHex("prompt")),
        responseHash: keccak256(toHex("response")),
        teeAttestation: {
          chatId: "chat-abc",
          teeVerified: true,
          teeSignerAddress: "0x3333333333333333333333333333333333333333",
          signature: "0xdeadbeef",
          signedTextHash: keccak256(toHex("response")),
          signatureEndpoint: "https://provider.example/v1/proxy/signature/chat-abc",
        },
      },
      findings: [],
      verdict: { action: "ALLOW", maxLtvBps: 7500 },
      issuedAt: 1_756_000_000,
      expiresAt: EXPIRES,
      ...over,
    },
    signer,
  );

const sealAOver = async (sealB: SealB): Promise<SealA> =>
  signSealA(
    {
      version: 1,
      type: "underwriting",
      agentId: "1",
      subject: TOKEN,
      delegations: [
        {
          agentId: "2",
          service: "code-audit",
          priceAtomic: "10000",
          network: "eip155:84532",
          settlementTx: keccak256(toHex("tx")),
          seal: sealB,
          sealVerified: true,
        },
      ],
      ownAnalysis: { liquidityDepthUsd: "0", top10HolderPct: 0, sourceHash: keccak256(toHex("source")) },
      verdict: { action: "ALLOW", maxLtvBps: 7500, expiresAt: EXPIRES },
    },
    agentA,
  );

const run = async (seal: object): Promise<{ code: number; lines: string[] }> => {
  const e = env();
  const path = join(e["ACU_HOME"]!, "seal.json");
  writeFileSync(path, JSON.stringify(seal));
  const { io, lines } = capture(e);
  return { code: await main(["verify", path], io), lines };
};

describe("acu verify", () => {
  it("passes every row of a good seal A and walks into its delegation", async () => {
    const { code, lines } = await run(await sealAOver(await sealBOver()));

    expect(code).toBe(0);
    expect(marks(lines)).toEqual({
      Shape: "✓",
      "Issuer is known": "✓",
      Signature: "✓",
      Subject: "✓",
      "Not expired": "✓",
      "Embedded seal B": "✓",
    });
    expect(lines.join("\n")).toContain("✓ VALID");
  });

  it("reds seal A's own signature row when seal A is the thing that is wrong", async () => {
    const sealA = await sealAOver(await sealBOver());
    const { code, lines } = await run({ ...sealA, agentId: "2" });

    expect(code).toBe(1);
    expect(marks(lines)).toMatchObject({ "Issuer is known": "✓", Signature: "✗", Subject: "·" });
  });

  /**
   * Seal A and seal B share their failure codes. Matching a code against seal
   * A's own rows put a delegate's SIGNER_MISMATCH on seal A's "Signature" row —
   * saying a signature that verified did not — and then called every row below
   * it "not reached" when all of them had been checked and passed.
   */
  it("puts a delegate's failure on the delegation row, not on seal A's own", async () => {
    const forgedB = await sealBOver({}, stranger);
    const { code, lines } = await run(await sealAOver(forgedB));

    expect(code).toBe(1);
    expect(marks(lines)).toEqual({
      Shape: "✓",
      "Issuer is known": "✓",
      Signature: "✓",
      Subject: "✓",
      "Not expired": "✓",
      "Embedded seal B": "✗",
    });
    expect(lines.join("\n")).toContain("✗ SIGNER_MISMATCH");
    expect(lines.join("\n")).not.toContain("not reached");
  });

  it("does the same for a delegate whose issuer is in no directory", async () => {
    const strangerB = await sealBOver({ agentId: "9" }, stranger);
    const { lines } = await run(await sealAOver(strangerB));

    expect(marks(lines)).toMatchObject({ "Issuer is known": "✓", "Embedded seal B": "✗" });
    expect(lines.join("\n")).toContain("✗ AGENT_ID_NOT_LIVE");
  });

  it("reads a bare seal B on its own terms", async () => {
    const { code, lines } = await run(await sealBOver());

    expect(code).toBe(0);
    expect(marks(lines)).toMatchObject({ "Request binding": "✓", "Attested inference": "✓" });
  });

  it("refuses something that is not a seal at all", async () => {
    const { code, lines } = await run({ hello: "world" });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("✗ SCHEMA_INVALID");
  });
});
