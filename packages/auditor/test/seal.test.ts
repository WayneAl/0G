import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import {
  verifySealB,
  StaticAgentIdResolver,
  SealVerificationError,
  auditRequestHash,
  type AuditRequestPayload,
} from "@0x402/seal";
import type { InferenceResult } from "@0x402/og";
import { issueSealB } from "../src/seal.js";

const agentB = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const TOKEN = "0x2222222222222222222222222222222222222222" as const;
const NOW = 1_756_000_000;

const request: AuditRequestPayload = {
  token: TOKEN,
  artifact: "name: Trap USD\nselectors: setBlacklist, upgradeTo",
  requestedAt: NOW - 10,
  nonce: "deadbeef",
};

function inference(over: Partial<InferenceResult> = {}): InferenceResult {
  return {
    output: { action: "DENY", maxLtvBps: 0, findings: ["upgradeable_proxy"], reasoning: "unsafe" },
    model: "qwen2.5-omni",
    trustMode: "verified",
    providerAddress: "0xd9966e13a6026fcca4b13e7ff95c94de268c471c",
    promptHash: keccak256(toHex("prompt")),
    responseHash: keccak256(toHex("response")),
    attestation: {
      chatId: "chat-1",
      teeVerified: true,
      teeSignerAddress: null,
      signature: null,
      signedTextHash: keccak256(toHex("response")),
      signatureEndpoint: null,
    },
    rawText: "{}",
    costNeuron: "1234",
    ...over,
  };
}

const config = { agentId: "2", account: agentB, ttlSeconds: 86_400 };
const ctx = {
  expectedSubject: TOKEN,
  expectedRequest: auditRequestHash(request),
  resolver: new StaticAgentIdResolver({ "2": agentB.address }),
  now: NOW,
};

describe("issueSealB", () => {
  it("produces a seal Agent A accepts", async () => {
    const seal = await issueSealB(request, inference(), config, NOW);
    await expect(verifySealB(seal, ctx)).resolves.toBeTruthy();
  });

  it("relays the model's DENY rather than softening it", async () => {
    const seal = await issueSealB(request, inference(), config, NOW);
    expect(seal.verdict).toEqual({ action: "DENY", maxLtvBps: 0 });
    expect(seal.findings).toEqual(["upgradeable_proxy"]);
  });

  it("binds the seal to the exact request Agent A sent", async () => {
    const seal = await issueSealB(request, inference(), config, NOW);
    expect(seal.request).toBe(auditRequestHash(request));

    // A seal for a different nonce must not satisfy this request.
    await expect(
      verifySealB(seal, { ...ctx, expectedRequest: auditRequestHash({ ...request, nonce: "other" }) }),
    ).rejects.toThrow(/REQUEST_MISMATCH/);
  });

  it("records what produced the verdict", async () => {
    const seal = await issueSealB(request, inference(), config, NOW);
    expect(seal.inference.model).toBe("qwen2.5-omni");
    expect(seal.inference.trustMode).toBe("verified");
    expect(seal.inference.teeAttestation?.chatId).toBe("chat-1");
  });

  it("expires, so an upgradeable token gets re-reviewed", async () => {
    const seal = await issueSealB(request, inference(), config, NOW);
    expect(seal.expiresAt).toBe(NOW + 86_400);
    await expect(verifySealB(seal, { ...ctx, now: seal.expiresAt })).rejects.toThrow(/SEAL_EXPIRED/);
  });

  // Demo scene ⑤: cheaper inference with no attestation, and the chain stops believing it.
  it("cannot hide a downgraded inference — the seal comes back unattested and is refused", async () => {
    const seal = await issueSealB(
      request,
      inference({ trustMode: "verified", attestation: null }),
      config,
      NOW,
    );
    const err = await verifySealB(seal, ctx).catch((e: SealVerificationError) => e);
    expect((err as SealVerificationError).failure).toBe("ATTESTATION_MISSING");
  });

  it("an honestly-declared standard tier is a valid seal that Agent A still declines by default (demo scene ⑦)", async () => {
    const seal = await issueSealB(
      request,
      inference({ trustMode: "standard", attestation: null }),
      config,
      NOW,
    );
    // The seal does not lie — and that honesty is exactly what lets the policy
    // refuse it: TRUST_MODE_INSUFFICIENT, not a forgery.
    expect(seal.inference.trustMode).toBe("standard");
    expect(seal.inference.teeAttestation).toBeNull();
    await expect(verifySealB(seal, ctx)).rejects.toThrow(/TRUST_MODE_INSUFFICIENT/);
    await expect(
      verifySealB(seal, { ...ctx, acceptTrustModes: ["standard", "verified"] }),
    ).resolves.toBeTruthy();
  });
});
