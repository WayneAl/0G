import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import {
  canonicalize,
  sealDigest,
  signSealA,
  signSealB,
  verifySealA,
  verifySealB,
  SealVerificationError,
  StaticAgentIdResolver,
  InferenceOutput,
  toVerdict,
  type SealA,
  type SealB,
  type Unsigned,
  type VerifySealAContext,
} from "../src/index.js";

// Test-only keys. Never used on any network.
const agentB = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const agentA = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const impostor = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const OTHER_TOKEN = "0x2222222222222222222222222222222222222222" as const;
const REQUEST = keccak256(toHex("canonical-audit-request"));
const NOW = 1_756_000_100;

const resolver = new StaticAgentIdResolver({ "1": agentA.address, "2": agentB.address });

function unsignedSealB(over: Partial<Unsigned<SealB>> = {}): Unsigned<SealB> {
  return {
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
    findings: ["upgradeable_proxy"],
    verdict: { action: "ALLOW", maxLtvBps: 7500 },
    issuedAt: NOW - 100,
    expiresAt: NOW + 86_400,
    ...over,
  };
}

const ctxB = { expectedSubject: TOKEN, expectedRequest: REQUEST, resolver, now: NOW } as const;

describe("canonicalization", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("sorts nested keys and preserves array order", () => {
    expect(canonicalize({ z: { y: 1, x: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"z":{"x":2,"y":1}}');
  });

  it("treats absent and undefined members identically", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it("excludes the signature from the digest it produces", () => {
    const seal = unsignedSealB();
    expect(sealDigest({ ...seal, signature: "0xaa" })).toBe(sealDigest({ ...seal, signature: "0xbb" }));
  });
});

describe("seal B — round trip", () => {
  it("verifies a well-formed seal", async () => {
    const seal = await signSealB(unsignedSealB(), agentB);
    await expect(verifySealB(seal, ctxB)).resolves.toMatchObject({ verdict: { action: "ALLOW" } });
  });
});

describe("seal B — the six checks of spec §6.2", () => {
  it("1. rejects a signature from a key the agentId does not claim", async () => {
    const seal = await signSealB(unsignedSealB(), impostor);
    await expect(verifySealB(seal, ctxB)).rejects.toThrow(/SIGNER_MISMATCH/);
  });

  it("2. rejects an agentId that is not a live Agentic ID", async () => {
    const seal = await signSealB(unsignedSealB({ agentId: "999" }), agentB);
    await expect(verifySealB(seal, ctxB)).rejects.toThrow(/AGENT_ID_NOT_LIVE/);
  });

  it("3. rejects a seal about a different token", async () => {
    const seal = await signSealB(unsignedSealB({ subject: OTHER_TOKEN }), agentB);
    await expect(verifySealB(seal, ctxB)).rejects.toThrow(/SUBJECT_MISMATCH/);
  });

  it("4. rejects a seal answering a request we did not send", async () => {
    const seal = await signSealB(unsignedSealB({ request: keccak256(toHex("other")) }), agentB);
    await expect(verifySealB(seal, ctxB)).rejects.toThrow(/REQUEST_MISMATCH/);
  });

  it("5. rejects an expired seal", async () => {
    const seal = await signSealB(unsignedSealB({ expiresAt: NOW - 1 }), agentB);
    await expect(verifySealB(seal, ctxB)).rejects.toThrow(/SEAL_EXPIRED/);
  });

  it("6. rejects a seal claiming an attested tier without attestation (demo scene ⑤)", async () => {
    const base = unsignedSealB();
    const seal = await signSealB(
      { ...base, inference: { ...base.inference, teeAttestation: null } },
      agentB,
    );
    const err = await verifySealB(seal, ctxB).catch((e: SealVerificationError) => e);
    expect(err).toBeInstanceOf(SealVerificationError);
    expect((err as SealVerificationError).failure).toBe("ATTESTATION_MISSING");
  });

  it("6b. a standard-tier seal may omit attestation, where standard is accepted at all", async () => {
    const base = unsignedSealB();
    const seal = await signSealB(
      { ...base, inference: { ...base.inference, trustMode: "standard", teeAttestation: null } },
      agentB,
    );
    await expect(
      verifySealB(seal, { ...ctxB, acceptTrustModes: ["standard", "verified"] }),
    ).resolves.toBeTruthy();
  });

  it("7. rejects an honest standard-tier seal by default — attested inference is a rule, not a preference (demo scene ⑦)", async () => {
    const base = unsignedSealB();
    const seal = await signSealB(
      { ...base, inference: { ...base.inference, trustMode: "standard", teeAttestation: null } },
      agentB,
    );
    const err = await verifySealB(seal, ctxB).catch((e: SealVerificationError) => e);
    expect(err).toBeInstanceOf(SealVerificationError);
    expect((err as SealVerificationError).failure).toBe("TRUST_MODE_INSUFFICIENT");
  });
});

describe("seal B — tamper cases (any mutation must break verification)", () => {
  const mutations: Array<[string, (s: SealB) => SealB]> = [
    ["verdict.action DENY -> ALLOW", (s) => ({ ...s, verdict: { ...s.verdict, action: "ALLOW" } })],
    ["verdict.maxLtvBps raised", (s) => ({ ...s, verdict: { ...s.verdict, maxLtvBps: 9900 } })],
    ["findings emptied", (s) => ({ ...s, findings: [] })],
    ["expiresAt extended", (s) => ({ ...s, expiresAt: s.expiresAt + 86_400 })],
    ["issuedAt backdated", (s) => ({ ...s, issuedAt: s.issuedAt - 5_000 })],
    [
      "inference.model swapped to a cheaper one",
      (s) => ({ ...s, inference: { ...s.inference, model: "cheap-model" } }),
    ],
    [
      "inference.responseHash replaced",
      (s) => ({ ...s, inference: { ...s.inference, responseHash: keccak256(toHex("forged")) } }),
    ],
    [
      "teeAttestation.teeVerified flipped to true",
      (s) => ({
        ...s,
        inference: {
          ...s.inference,
          teeAttestation: { ...s.inference.teeAttestation!, teeVerified: true },
        },
      }),
    ],
  ];

  for (const [name, mutate] of mutations) {
    it(`rejects: ${name}`, async () => {
      // teeVerified starts false so the "flipped to true" mutation is a real change:
      // the attack is claiming a TEE verification that never happened.
      const base = unsignedSealB({ verdict: { action: "DENY", maxLtvBps: 0 } });
      const signed = await signSealB(
        {
          ...base,
          inference: {
            ...base.inference,
            teeAttestation: { ...base.inference.teeAttestation!, teeVerified: false },
          },
        },
        agentB,
      );
      await expect(verifySealB(mutate(signed), ctxB)).rejects.toThrow(/SIGNER_MISMATCH/);
    });
  }

  it("rejects a re-signed tampered seal, because the impostor is not agentId 2", async () => {
    const signed = await signSealB(unsignedSealB({ verdict: { action: "DENY", maxLtvBps: 0 } }), agentB);
    const forged = await signSealB(
      { ...signed, verdict: { action: "ALLOW", maxLtvBps: 9000 } } as Unsigned<SealB>,
      impostor,
    );
    await expect(verifySealB(forged, ctxB)).rejects.toThrow(/SIGNER_MISMATCH/);
  });
});

async function makeSealA(sealB: SealB, over: Partial<Unsigned<SealA>> = {}): Promise<SealA> {
  return signSealA(
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
      ownAnalysis: {
        liquidityDepthUsd: "125000",
        top10HolderPct: 62.4,
        sourceHash: keccak256(toHex("source")),
      },
      verdict: { action: "ALLOW", maxLtvBps: 7500, expiresAt: NOW + 86_400 },
      ...over,
    },
    agentA,
  );
}

describe("seal chain — seal A embeds seal B", () => {
  const ctxA = { expectedSubject: TOKEN, resolver, now: NOW } as const;

  it("verifies A and walks down into B", async () => {
    const sealB = await signSealB(unsignedSealB(), agentB);
    await expect(verifySealA(await makeSealA(sealB), ctxA)).resolves.toBeTruthy();
  });

  it("rejects when the embedded seal B was tampered with (demo scene ⑥)", async () => {
    const sealB = await signSealB(unsignedSealB({ verdict: { action: "DENY", maxLtvBps: 0 } }), agentB);
    const sealA = await makeSealA(sealB);
    const tampered = {
      ...sealA,
      delegations: [
        { ...sealA.delegations[0]!, seal: { ...sealB, verdict: { action: "ALLOW" as const, maxLtvBps: 9000 } } },
      ],
    };
    // Seal A's own signature covers the embedded B, so the outer seal breaks first.
    await expect(verifySealA(tampered, ctxA)).rejects.toThrow(/SIGNER_MISMATCH/);
  });

  it("rejects when A is honestly re-signed over a tampered B", async () => {
    const sealB = await signSealB(unsignedSealB({ verdict: { action: "DENY", maxLtvBps: 0 } }), agentB);
    const forgedB = { ...sealB, verdict: { action: "ALLOW" as const, maxLtvBps: 9000 } };
    const sealA = await makeSealA(forgedB);
    await expect(verifySealA(sealA, ctxA)).rejects.toThrow(/SIGNER_MISMATCH/);
  });

  it("rejects a seal A whose subject is not the token being listed", async () => {
    const sealB = await signSealB(unsignedSealB(), agentB);
    const sealA = await makeSealA(sealB);
    await expect(verifySealA(sealA, { ...ctxA, expectedSubject: OTHER_TOKEN })).rejects.toThrow(
      /SUBJECT_MISMATCH/,
    );
  });

  /**
   * Seal A and seal B share their failure codes, so a report that matches on the
   * code alone cannot tell "agent 1 is not live" from "the agent 1 vouched for is
   * not live" — and draws the second as the first, on agent 1's own row.
   */
  describe("a failure one hop down says so", () => {
    const failed = async (
      sealA: SealA,
      ctx: VerifySealAContext = ctxA,
    ): Promise<SealVerificationError> => {
      try {
        await verifySealA(sealA, ctx);
      } catch (err) {
        return err as SealVerificationError;
      }
      throw new Error("expected verifySealA to reject");
    };

    it("marks a delegate's failure as the delegate's, keeping the code and the detail", async () => {
      // Agent 3 is nobody: this seal B is signed by a key the directory has
      // never heard of, and seal A is honestly signed by a live agent 1 over it.
      const strangerB = await signSealB(unsignedSealB({ agentId: "3" }), impostor);
      const err = await failed(await makeSealA(strangerB));

      expect(err.failure).toBe("AGENT_ID_NOT_LIVE");
      expect(err.delegate).toBe(true);
      expect(err.detail).toBe("3");
    });

    it("leaves seal A's own failures unmarked", async () => {
      const sealB = await signSealB(unsignedSealB(), agentB);
      const sealA = await makeSealA(sealB);

      const wrongSubject = await failed(sealA, { ...ctxA, expectedSubject: OTHER_TOKEN });
      expect(wrongSubject.failure).toBe("SUBJECT_MISMATCH");
      expect(wrongSubject.delegate).toBe(false);

      const expired = await failed(sealA, { ...ctxA, now: NOW + 90_000 });
      expect(expired.failure).toBe("SEAL_EXPIRED");
      expect(expired.delegate).toBe(false);
    });

    it("marks an expired delegate even though seal A carries the same code", async () => {
      // Both seals expire at NOW + 86_400 and seal A is checked first, so the
      // delegate has to outlive its parent for this to be reachable at all.
      const shortB = await signSealB(unsignedSealB({ expiresAt: NOW + 10 }), agentB);
      const sealA = await makeSealA(shortB, { verdict: { action: "ALLOW", maxLtvBps: 7500, expiresAt: NOW + 86_400 } });

      const err = await failed(sealA, { ...ctxA, now: NOW + 100 });

      expect(err.failure).toBe("SEAL_EXPIRED");
      expect(err.delegate).toBe(true);
    });
  });
});

describe("inference output contract (spec §4.3)", () => {
  it("accepts the exact schema", () => {
    expect(
      InferenceOutput.parse({ action: "DENY", maxLtvBps: 0, findings: ["x"], reasoning: "y" }).action,
    ).toBe("DENY");
  });

  it("rejects extra fields an injected artifact might coax out of the model", () => {
    expect(() =>
      InferenceOutput.parse({
        action: "ALLOW",
        maxLtvBps: 10000,
        findings: [],
        reasoning: "",
        override: true,
      }),
    ).toThrow();
  });

  it("rejects an out-of-range LTV", () => {
    expect(() =>
      InferenceOutput.parse({ action: "ALLOW", maxLtvBps: 20000, findings: [], reasoning: "" }),
    ).toThrow();
  });
});

describe("on-chain projection", () => {
  it("carries the LTV cap and seal hash into the Verdict", async () => {
    const sealB = await signSealB(unsignedSealB(), agentB);
    const sealA = await makeSealA(sealB);
    const v = toVerdict(sealA);
    expect(v.action).toBe(1);
    expect(v.maxLtvBps).toBe(7500);
    expect(v.delegationDepth).toBe(1);
    expect(v.subject.toLowerCase().endsWith(TOKEN.slice(2))).toBe(true);
    expect(v.sealHash).toBe(sealDigest(sealA as unknown as Record<string, unknown>));
  });
});
