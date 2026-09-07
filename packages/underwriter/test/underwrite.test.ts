import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  auditRequestHash,
  recoverSealSigner,
  sealDigest,
  signSealB,
  StaticAgentIdResolver,
  verifySealA,
  type AuditRequestPayload,
  type SealB,
  type Unsigned,
} from "@acu/seal";
import { makeBudgetGate } from "../src/budget.js";
import type { TokenArtifact } from "../src/chain.js";
import { HireError, type HireOptions, type HireResult, type Quote } from "../src/hire.js";
import type { PublishReceipt } from "../src/publisher.js";
import { mapListError, type SettleResult } from "../src/settle.js";
import {
  composeSealA,
  hireAndVerify,
  underwrite,
  type UnderwriteDeps,
  type UnderwriteRequest,
  type UnderwriteResult,
} from "../src/underwrite.js";

/**
 * Everything signed here comes out of a recorded live run
 * (demo/fixtures/replay/*.json). The three refusals are the three recordings:
 * a real seal, a real seal with its verdict rewritten in flight, and a real seal
 * from an agent B that skipped the attestation. Nothing is hand-written.
 */
interface Fixture {
  request: { token: string; artifact: string; requestedAt: number; nonce: string };
  quote: { amountAtomic: string; payTo: string; humanPrice: string };
  audit: { action: string; maxLtvBps: number; findings: string[]; reasoning: string; costNeuron: string | null };
  sealB: Record<string, unknown>;
  settlementTx: string | null;
}

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`../../../demo/fixtures/replay/${name}`, import.meta.url), "utf8")) as Fixture;

const clean = load("clean.json");
const tampered = load("clean-tampered.json");
const noattest = load("clean-noattest.json");

const requestOf = (f: Fixture): AuditRequestPayload => ({
  token: f.request.token.toLowerCase() as `0x${string}`,
  artifact: f.request.artifact,
  requestedAt: f.request.requestedAt,
  nonce: f.request.nonce,
});

const TOKEN = clean.request.token.toLowerCase() as `0x${string}`;
const PAYTO = clean.quote.payTo.toLowerCase() as `0x${string}`;
/** The recording's own clock: these seals expired days ago in real time. */
const NOW = clean.request.requestedAt;

/** Agent B's live signer, recovered from the recording rather than assumed. */
const RECORDED_SIGNER = await recoverSealSigner(clean.sealB);

const agentA = privateKeyToAccount(`0x${"00".repeat(31)}01`);
const agentB = privateKeyToAccount(`0x${"00".repeat(31)}02`);

const quote: Quote = {
  requirements: {} as Quote["requirements"],
  amountAtomic: BigInt(clean.quote.amountAtomic),
  payTo: PAYTO,
  humanPrice: clean.quote.humanPrice,
};
const audit = clean.audit;

const ARTIFACT: TokenArtifact = {
  address: TOKEN,
  name: "CleanUSD",
  symbol: "CUSD",
  decimals: 18,
  totalSupply: "1000000000000000000000000",
  owner: null,
  bytecodeSize: 2718,
  bytecodeHash: keccak256(toHex("runtime")),
  presentSelectors: [],
  source: null,
  sourceHash: keccak256(toHex("source")),
  top10HolderPct: null,
  liquidityDepthUsd: "0",
};

/**
 * `underwrite()` mints a fresh request (new nonce, new timestamp), so a recorded
 * seal B cannot bind to it. For the orchestration cases the recorded seal's body
 * is re-signed over the live request by a throwaway B key — real recorded
 * content, real signing code, a binding that is actually checkable.
 */
async function resealOverRequest(
  body: Record<string, unknown>,
  request: AuditRequestPayload,
): Promise<SealB> {
  const { signature: _signature, ...rest } = body;
  return signSealB(
    { ...rest, subject: request.token, request: auditRequestHash(request) } as unknown as Unsigned<SealB>,
    agentB,
  );
}

let ledgerDir: string;
let ledger: string;
beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), "underwriter-"));
  ledger = join(ledgerDir, "ledger.json");
});
afterEach(() => rmSync(ledgerDir, { recursive: true, force: true }));

/** Mimics hireAuditor's ordering: quote, then the gate, then anything signed. */
function fakeHire(sealB: unknown, flags: { paid?: boolean } = {}) {
  return async (opts: HireOptions, _request: AuditRequestPayload): Promise<HireResult | { quote: Quote; dryRun: true }> => {
    opts.budget.assertWithinBudget(quote.amountAtomic, quote.payTo);
    if (opts.dryRun) return { quote, dryRun: true };
    flags.paid = true;
    return { quote, audit, sealB, settlementTx: clean.settlementTx as `0x${string}` | null };
  };
}

function deps(over: Partial<UnderwriteDeps> = {}): UnderwriteDeps {
  return {
    account: agentA,
    agentId: "1",
    auditor: { url: "http://localhost:4021/audit", agentId: "2" },
    resolver: new StaticAgentIdResolver({ "2": RECORDED_SIGNER }),
    budget: makeBudgetGate([PAYTO], ledger),
    network: "eip155:84532",
    dryRun: false,
    registry: null,
    now: () => NOW,
    fetchArtifact: async () => ARTIFACT,
    ...over,
  } as UnderwriteDeps;
}

const request: UnderwriteRequest = {
  token: TOKEN,
  ltvBps: 7000,
  source: null,
  settle: false,
  publish: false,
};

function refused<T extends { ok: boolean }>(r: T): Extract<T, { ok: false }> {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`);
  return r as Extract<T, { ok: false }>;
}

function sealed(r: UnderwriteResult): Extract<UnderwriteResult, { kind: "sealed" }> {
  if (!r.ok || r.kind !== "sealed") throw new Error(`expected a sealed result, got ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}

describe("hireAndVerify", () => {
  it("stops at the quote in a dry run, having signed and spent nothing", async () => {
    const result = await hireAndVerify(
      requestOf(clean),
      deps({ dryRun: true, hire: fakeHire(clean.sealB) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "dry-run") throw new Error("expected a dry run");
    expect(result.quote.humanPrice).toBe(clean.quote.humanPrice);
    expect(result.quote.payTo).toBe(PAYTO);
    expect(result.budget).toContain("session 0.000000");
  });

  it("verifies the recorded seal B and reports what it paid", async () => {
    const result = await hireAndVerify(requestOf(clean), deps({ hire: fakeHire(clean.sealB) }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "hired") throw new Error("expected a hire");
    expect(result.sealB).toEqual(clean.sealB);
    expect(result.hire).toEqual({
      priceAtomic: clean.quote.amountAtomic,
      humanPrice: clean.quote.humanPrice,
      payTo: PAYTO,
      settlementTx: clean.settlementTx,
    });
  });

  it("refuses a paid endpoint that signed nothing", async () => {
    const r = refused(await hireAndVerify(requestOf(clean), deps({ hire: fakeHire(null) })));
    expect(r.stage).toBe("verify");
    expect(r.code).toBe("DELEGATE_SEAL_INVALID");
    expect(r.detail.startsWith("NO_SEAL")).toBe(true);
  });

  it("refuses a seal whose verdict was rewritten in flight", async () => {
    const r = refused(await hireAndVerify(requestOf(tampered), deps({ hire: fakeHire(tampered.sealB) })));
    expect(r.code).toBe("DELEGATE_SEAL_INVALID");
    expect(r.detail.startsWith("SIGNER_MISMATCH")).toBe(true);
  });

  it("refuses a seal that claims an attested tier without the attestation", async () => {
    const r = refused(await hireAndVerify(requestOf(noattest), deps({ hire: fakeHire(noattest.sealB) })));
    expect(r.code).toBe("DELEGATE_SEAL_INVALID");
    expect(r.detail.startsWith("ATTESTATION_MISSING")).toBe(true);
  });

  it("surfaces a HireError code at the stage it happened", async () => {
    const r = refused(
      await hireAndVerify(
        requestOf(clean),
        deps({
          hire: async () => {
            throw new HireError("NO_PAYMENT_CHALLENGE", "expected 402, got 200");
          },
        }),
      ),
    );
    expect(r.stage).toBe("quote");
    expect(r.code).toBe("NO_PAYMENT_CHALLENGE");
    expect(r.detail).toContain("expected 402");
  });

  it("blames the hire stage when the paid request itself failed", async () => {
    const r = refused(
      await hireAndVerify(
        requestOf(clean),
        deps({
          hire: async () => {
            throw new HireError("AUDIT_REQUEST_FAILED", "502 upstream model unavailable");
          },
        }),
      ),
    );
    expect(r.stage).toBe("hire");
    expect(r.code).toBe("AUDIT_REQUEST_FAILED");
  });

  it("refuses an unlisted payee before anything is signed", async () => {
    const flags: { paid?: boolean } = {};
    const stranger = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
    const r = refused(
      await hireAndVerify(
        requestOf(clean),
        deps({ budget: makeBudgetGate([stranger], ledger), hire: fakeHire(clean.sealB, flags) }),
      ),
    );
    expect(r.stage).toBe("quote");
    expect(r.code).toBe("BUDGET_REFUSED");
    expect(r.detail.startsWith("PAYEE_NOT_ALLOWED")).toBe(true);
    expect(r.detail).toContain("nothing was signed");
    expect(flags.paid).toBeUndefined();
  });
});

describe("composeSealA", () => {
  const req = requestOf(clean);
  const sealBody = clean.sealB as unknown as SealB;
  const compose = (ltvBps: number) =>
    composeSealA({
      request: req,
      sealB: sealBody,
      hire: {
        priceAtomic: clean.quote.amountAtomic,
        humanPrice: clean.quote.humanPrice,
        payTo: PAYTO,
        settlementTx: clean.settlementTx as `0x${string}` | null,
      },
      ownAnalysis: { liquidityDepthUsd: "0", top10HolderPct: 0, sourceHash: keccak256(toHex(req.artifact)) },
      ltvBps,
      agentId: "1",
      auditorAgentId: "2",
      network: "eip155:84532",
      account: agentA,
    });

  it("caps at nothing when nothing was asked for", async () => {
    const sealA = await compose(0);
    expect(sealA.verdict.maxLtvBps).toBe(0);
  });

  it("wraps the recorded seal B verbatim, and the pair verifies as a chain", async () => {
    const sealA = await compose(7000);

    expect(sealA.delegations[0]!.seal).toEqual(clean.sealB);
    expect(sealA.delegations[0]!.sealVerified).toBe(true);
    expect(sealA.verdict.maxLtvBps).toBe(sealBody.verdict.maxLtvBps);
    await expect(
      verifySealA(sealA, {
        expectedSubject: TOKEN,
        resolver: new StaticAgentIdResolver({ "1": agentA.address, "2": RECORDED_SIGNER }),
        now: NOW,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("underwrite", () => {
  /** deps whose injected B re-signs the recorded body over the live request. */
  function liveDeps(over: Partial<UnderwriteDeps> = {}, flags: { paid?: boolean } = {}): UnderwriteDeps {
    return deps({
      resolver: new StaticAgentIdResolver({ "1": agentA.address, "2": agentB.address }),
      hire: async (opts, req) => fakeHire(await resealOverRequest(clean.sealB, req), flags)(opts, req),
      ...over,
    });
  }

  it("returns the read refusal when the address holds no code", async () => {
    const r = refused(
      await underwrite(
        request,
        liveDeps({
          fetchArtifact: async () => {
            throw new Error(`NO_CODE_AT_ADDRESS: ${TOKEN} has no contract bytecode on 0G testnet`);
          },
        }),
      ),
    );
    expect(r.stage).toBe("read");
    expect(r.code).toBe("NO_CODE_AT_ADDRESS");
    expect(r.detail).toContain("no contract bytecode");
  });

  it("seals without touching the chain when settle and publish are off", async () => {
    const result = await underwrite(request, liveDeps());
    const s = sealed(result);
    expect(s.listing).toBeNull();
    expect(s.storage).toBeNull();
    expect(s.skipped).toEqual({});
    expect(s.sealHash).toBe(sealDigest(s.sealA));
    expect(s.sealA.delegations[0]!.seal).toEqual(s.sealB);
    expect(s.sealA.delegations[0]!.seal.inference).toEqual(clean.sealB["inference"]);
    await expect(
      verifySealA(s.sealA, {
        expectedSubject: TOKEN,
        resolver: new StaticAgentIdResolver({ "1": agentA.address, "2": agentB.address }),
        now: NOW,
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses to settle without a registry", async () => {
    const r = refused(await underwrite({ ...request, settle: true }, liveDeps()));
    expect(r.stage).toBe("settle");
    expect(r.code).toBe("NO_REGISTRY");
    expect(r.detail).toContain("--registry");
  });

  it("does not list when the registry's verifier trusts a different signer", async () => {
    let listed = false;
    const s = sealed(
      await underwrite(
        { ...request, settle: true },
        liveDeps({
          registry: "0x1111111111111111111111111111111111111111",
          trustedSigner: async () => "0x2222222222222222222222222222222222222222",
          list: async () => {
            listed = true;
            throw new Error("list must not be called");
          },
        }),
      ),
    );
    expect(s.listing).toBeNull();
    expect(s.skipped.settle?.startsWith("UNTRUSTED_SIGNER")).toBe(true);
    expect(s.skipped.settle).toContain(agentA.address);
    expect(listed).toBe(false);
  });

  it("refuses rather than throws when the registry cannot say who it trusts", async () => {
    const r = refused(
      await underwrite(
        { ...request, settle: true },
        liveDeps({
          registry: "0x1111111111111111111111111111111111111111",
          trustedSigner: async () => {
            throw new Error("HTTP request failed: 0G RPC 503");
          },
        }),
      ),
    );
    expect(r.stage).toBe("settle");
    expect(r.code).toBe("LIST_FAILED");
    expect(r.detail).toContain("503");
  });

  it("lists when the registry trusts this agent", async () => {
    const settleResult: SettleResult = {
      txHash: `0x${"ab".repeat(32)}`,
      listed: { active: true, ltvBps: 7000, sealHash: `0x${"cd".repeat(32)}`, expiresAt: 0n },
    };
    const s = sealed(
      await underwrite(
        { ...request, settle: true },
        liveDeps({
          registry: "0x1111111111111111111111111111111111111111",
          trustedSigner: async () => agentA.address,
          list: async () => settleResult,
        }),
      ),
    );
    expect(s.listing).toEqual({ txHash: settleResult.txHash, ltvBps: 7000 });
    expect(s.skipped).toEqual({});
  });

  it("surfaces the registry's own revert reason", async () => {
    const r = refused(
      await underwrite(
        { ...request, settle: true, ltvBps: 8000 },
        liveDeps({
          registry: "0x1111111111111111111111111111111111111111",
          trustedSigner: async () => agentA.address,
          list: async () => {
            throw new Error('The contract function "list" reverted with LTV_EXCEEDS_ATTESTED()');
          },
        }),
      ),
    );
    expect(r.stage).toBe("settle");
    expect(r.code).toBe("LTV_EXCEEDS_ATTESTED");
    expect(r.detail).toBe("reverted by CollateralRegistry");
  });

  it("keeps the seal when publishing fails", async () => {
    const s = sealed(
      await underwrite(
        { ...request, publish: true },
        liveDeps({
          publisher: {
            publish: async () => {
              throw new Error("OG_STORAGE_UPLOAD_FAILED: indexer unreachable");
            },
          },
        }),
      ),
    );
    expect(s.storage).toBeNull();
    expect(s.skipped.publish?.startsWith("PUBLISH_FAILED")).toBe(true);
    expect(s.skipped.publish).toContain("indexer unreachable");
  });

  it("says so when publishing was asked for with no publisher", async () => {
    const s = sealed(await underwrite({ ...request, publish: true }, liveDeps()));
    expect(s.storage).toBeNull();
    expect(s.skipped.publish).toBe("NO_PUBLISHER");
  });

  it("reports where the seal body was published", async () => {
    const receipts: PublishReceipt[] = [];
    const s = sealed(
      await underwrite(
        { ...request, publish: true },
        liveDeps({
          publisher: {
            publish: async (seal) => {
              const receipt: PublishReceipt = {
                root: `0x${"ec".repeat(32)}`,
                txHash: `0x${"a1".repeat(32)}`,
                txSeq: 149629,
                sealHash: sealDigest(seal),
                indexerUrl: "https://indexer-storage-testnet-turbo.0g.ai",
                bytes: 4096,
              };
              receipts.push(receipt);
              return receipt;
            },
          },
        }),
      ),
    );
    expect(s.storage).toEqual(receipts[0]);
    expect(s.storage!.sealHash).toBe(s.sealHash);
    expect(s.skipped).toEqual({});
  });
});

describe("mapListError", () => {
  const NAMED = [
    "SEAL_SUBJECT_MISMATCH",
    "AUDIT_FAILED",
    "LTV_EXCEEDS_ATTESTED",
    "SEAL_EXPIRED",
    "NO_SEAL",
    "BAD_SIGNATURE",
  ] as const;

  for (const name of NAMED) {
    it(`reports ${name} as the registry's own refusal`, () => {
      expect(mapListError(`The contract function "list" reverted with ${name}()`)).toEqual({
        code: name,
        detail: "reverted by CollateralRegistry",
      });
    });
  }

  it("keeps an unnamed failure readable instead of guessing at it", () => {
    const noisy = `connection refused ${"x".repeat(400)}`;
    const mapped = mapListError(noisy);
    expect(mapped.code).toBe("LIST_FAILED");
    expect(mapped.detail).toBe(noisy.slice(0, 300));
    expect(mapped.detail).toHaveLength(300);
  });
});
