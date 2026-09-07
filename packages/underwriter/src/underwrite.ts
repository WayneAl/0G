import { randomBytes } from "node:crypto";
import { isAddressEqual, type PrivateKeyAccount } from "viem";
import {
  auditRequestHash,
  sealDigest,
  signSealA,
  verifySealB,
  SealVerificationError,
  type AgentIdResolver,
  type AuditRequestPayload,
  type SealA,
  type SealB,
  type Unsigned,
} from "@acu/seal";
import { BudgetExceededError, type BudgetGate } from "./budget.js";
import { fetchTokenArtifact, makeOgClient, renderArtifact } from "./chain.js";
import { hireAuditor, HireError, type Quote } from "./hire.js";
import { listWithSeal, readTrustedSigner } from "./settle.js";
import type { PublishReceipt, SealPublisher } from "./publisher.js";

/**
 * The A side of the protocol as a library: read the token, hire an auditor, hold
 * its seal to the six checks, and only then sign and present anything.
 *
 * Every refusal comes back as a value carrying the code that caused it, because
 * the whole claim of this project is that Agent A can say *why* it stopped.
 * Exceptions are reserved for programmer error and for infrastructure that is
 * simply not there (an RPC that will not answer).
 */

export type Stage = "read" | "quote" | "hire" | "verify" | "compose" | "publish" | "settle";

export interface StepEvent {
  stage: Stage;
  message: string;
}

export type UnderwriteFailure =
  | "NO_CODE_AT_ADDRESS"
  | "BUDGET_REFUSED"
  | "NO_PAYMENT_CHALLENGE"
  | "NO_PAYMENT_REQUIRED_HEADER"
  | "NO_ACCEPTABLE_SCHEME"
  | "AUDIT_REQUEST_FAILED"
  | "DELEGATE_SEAL_INVALID"
  | "NO_REGISTRY"
  | "SEAL_SUBJECT_MISMATCH"
  | "AUDIT_FAILED"
  | "LTV_EXCEEDS_ATTESTED"
  | "SEAL_EXPIRED"
  | "NO_SEAL"
  | "BAD_SIGNATURE"
  | "LIST_FAILED";

export interface UnderwriteRequest {
  token: `0x${string}`;
  ltvBps: number;
  /** Local source for the token, when the caller has it. Never fetched. */
  source: string | null;
  settle: boolean;
  publish: boolean;
}

export interface UnderwriteDeps {
  /** Agent A's key. Nothing else in here can sign. */
  account: PrivateKeyAccount;
  /** Agent A's Agentic ID. */
  agentId: string;
  auditor: { url: string; agentId: string };
  /** Must resolve `auditor.agentId`, or every seal B is AGENT_ID_NOT_LIVE. */
  resolver: AgentIdResolver;
  budget: BudgetGate;
  network: `${string}:${string}`;
  /** True stops before any signature. Real money needs an explicit false. */
  dryRun: boolean;
  registry: `0x${string}` | null;
  rpcUrl?: string;
  publisher?: SealPublisher | null;
  onStep?: (e: StepEvent) => void;
  /** Unix seconds; injected so tests are not clock-dependent. */
  now?: () => number;
  // Seams. The defaults are the real functions from this package; a caller
  // overrides them to test the decisions without opening a socket.
  fetchArtifact?: typeof fetchTokenArtifact;
  hire?: typeof hireAuditor;
  list?: typeof listWithSeal;
  trustedSigner?: typeof readTrustedSigner;
}

export interface HireSummary {
  priceAtomic: string;
  humanPrice: string;
  payTo: `0x${string}`;
  settlementTx: `0x${string}` | null;
}

export type UnderwriteResult =
  | {
      ok: true;
      kind: "dry-run";
      quote: { humanPrice: string; payTo: `0x${string}`; amountAtomic: string };
      budget: string;
    }
  | {
      ok: true;
      kind: "sealed";
      sealA: SealA;
      sealHash: `0x${string}`;
      sealB: SealB;
      hire: HireSummary;
      storage: PublishReceipt | null;
      listing: { txHash: `0x${string}`; ltvBps: number } | null;
      /** Steps that were deliberately not taken, and why. */
      skipped: { settle?: string; publish?: string };
    }
  | { ok: false; stage: Stage; code: UnderwriteFailure; detail: string };

export type HireAndVerifyResult =
  | { ok: true; kind: "dry-run"; quote: Quote; budget: string }
  | { ok: true; kind: "hired"; sealB: SealB; hire: HireSummary }
  | { ok: false; stage: "quote" | "hire" | "verify"; code: UnderwriteFailure; detail: string };

/** The HireError codes that happen before anything is signed. */
const QUOTE_CODES: readonly string[] = [
  "NO_PAYMENT_CHALLENGE",
  "NO_PAYMENT_REQUIRED_HEADER",
  "NO_ACCEPTABLE_SCHEME",
];

const emit = (deps: Pick<UnderwriteDeps, "onStep">, stage: Stage, message: string): void =>
  deps.onStep?.({ stage, message });

const nowOf = (deps: Pick<UnderwriteDeps, "now">): number =>
  deps.now ? deps.now() : Math.floor(Date.now() / 1000);

/**
 * Step (2): the free RPC read, rendered as the text the auditor will see.
 *
 * Throws `Error("NO_CODE_AT_ADDRESS: …")` exactly as `fetchTokenArtifact` does;
 * `underwrite` turns that one into a refusal.
 */
export async function readToken(
  token: `0x${string}`,
  source: string | null,
  deps: Pick<UnderwriteDeps, "rpcUrl" | "fetchArtifact" | "onStep">,
): Promise<{ request: AuditRequestPayload; ownAnalysis: SealA["ownAnalysis"] }> {
  const fetchArtifact = deps.fetchArtifact ?? fetchTokenArtifact;
  emit(deps, "read", "reading token from 0G testnet RPC");
  const artifact = await fetchArtifact(makeOgClient(deps.rpcUrl), token, source);
  emit(
    deps,
    "read",
    `${artifact.symbol ?? "?"} · ${artifact.bytecodeSize}B code · owner ${artifact.owner ?? "none"} · flagged selectors: ${artifact.presentSelectors.join(", ") || "none"}`,
  );

  return {
    request: {
      token,
      artifact: renderArtifact(artifact),
      requestedAt: Math.floor(Date.now() / 1000),
      // Makes two identical requests distinguishable, so a seal cannot be replayed.
      nonce: randomBytes(16).toString("hex"),
    },
    ownAnalysis: {
      liquidityDepthUsd: artifact.liquidityDepthUsd,
      top10HolderPct: artifact.top10HolderPct ?? 0,
      sourceHash: artifact.sourceHash,
    },
  };
}

/**
 * Steps (3)–(5): quote, budget gate, payment, and the six checks on seal B.
 *
 * Never composes. The trust boundary is here, not in the contract: "nobody is
 * watching" means Agent A must be able to reject Agent B on its own.
 */
export async function hireAndVerify(
  request: AuditRequestPayload,
  deps: UnderwriteDeps,
): Promise<HireAndVerifyResult> {
  const hire = deps.hire ?? hireAuditor;

  emit(deps, "quote", `hiring agent B at ${deps.auditor.url}`);
  let hired: Awaited<ReturnType<typeof hireAuditor>>;
  try {
    hired = await hire(
      {
        endpoint: deps.auditor.url,
        account: deps.account,
        network: deps.network,
        budget: deps.budget,
        dryRun: deps.dryRun,
      },
      request,
    );
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return {
        ok: false,
        stage: "quote",
        code: "BUDGET_REFUSED",
        detail: `${err.denial} — nothing was signed. ${deps.budget.summary()}`,
      };
    }
    if (err instanceof HireError) {
      return {
        ok: false,
        stage: QUOTE_CODES.includes(err.code) ? "quote" : "hire",
        code: err.code as UnderwriteFailure,
        detail: err.message,
      };
    }
    throw err;
  }

  if ("dryRun" in hired) {
    return { ok: true, kind: "dry-run", quote: hired.quote, budget: deps.budget.summary() };
  }

  emit(deps, "hire", `paid ${hired.quote.humanPrice} · settlement ${hired.settlementTx ?? "(not reported)"}`);
  if (hired.audit) {
    emit(deps, "hire", `agent B returned ${hired.audit.action} maxLtvBps=${hired.audit.maxLtvBps}`);
  } else {
    emit(deps, "hire", "endpoint answered in its own shape — no audit object, no seal");
  }

  emit(deps, "verify", "verifying seal B");
  if (hired.sealB === null) {
    // An ordinary x402 API: the fee cleared, an ALLOW came back, and none of it
    // is evidence. Refuse before the verifier even gets a look.
    return {
      ok: false,
      stage: "verify",
      code: "DELEGATE_SEAL_INVALID",
      detail:
        "NO_SEAL — the service kept the fee and signed nothing. Nothing to verify, nothing to embed, nothing reaches the chain.",
    };
  }

  let sealB: SealB;
  try {
    sealB = await verifySealB(hired.sealB, {
      expectedSubject: request.token,
      expectedRequest: auditRequestHash(request),
      resolver: deps.resolver,
      now: nowOf(deps),
    });
  } catch (err) {
    if (err instanceof SealVerificationError) {
      return {
        ok: false,
        stage: "verify",
        code: "DELEGATE_SEAL_INVALID",
        detail: `${err.failure} — refusing to compose seal A. Nothing was submitted on chain.`,
      };
    }
    throw err;
  }

  const signer = await deps.resolver.resolve(deps.auditor.agentId);
  emit(
    deps,
    "verify",
    `seal B valid · signer ${signer} · attestation ${sealB.inference.teeAttestation ? "present" : "ABSENT"}`,
  );

  return {
    ok: true,
    kind: "hired",
    sealB,
    hire: {
      priceAtomic: hired.quote.amountAtomic.toString(),
      humanPrice: hired.quote.humanPrice,
      payTo: hired.quote.payTo,
      settlementTx: hired.settlementTx,
    },
  };
}

/** Step (6): seal A around a verified seal B. Pure except for the signature. */
export async function composeSealA(args: {
  request: AuditRequestPayload;
  sealB: SealB;
  hire: HireSummary;
  ownAnalysis: SealA["ownAnalysis"];
  ltvBps: number;
  agentId: string;
  auditorAgentId: string;
  network: `${string}:${string}`;
  account: PrivateKeyAccount;
}): Promise<SealA> {
  const unsigned: Unsigned<SealA> = {
    version: 1,
    type: "underwriting",
    agentId: args.agentId,
    subject: args.request.token,
    delegations: [
      {
        agentId: args.auditorAgentId,
        service: "code-audit",
        priceAtomic: args.hire.priceAtomic,
        network: args.network,
        settlementTx: args.hire.settlementTx,
        seal: args.sealB,
        sealVerified: true,
      },
    ],
    ownAnalysis: args.ownAnalysis,
    verdict: {
      // Agent A relays the auditor's verdict rather than softening it, and can
      // only ever tighten the cap, never raise it.
      action: args.sealB.verdict.action,
      maxLtvBps: Math.min(args.sealB.verdict.maxLtvBps, args.ltvBps > 0 ? args.sealB.verdict.maxLtvBps : 0),
      expiresAt: args.sealB.expiresAt,
    },
  };
  return signSealA(unsigned, args.account);
}

/** Steps (2)–(7). Never throws for a refusal; throws only on programmer error. */
export async function underwrite(req: UnderwriteRequest, deps: UnderwriteDeps): Promise<UnderwriteResult> {
  let read: Awaited<ReturnType<typeof readToken>>;
  try {
    read = await readToken(req.token, req.source, deps);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.startsWith("NO_CODE_AT_ADDRESS")) {
      return { ok: false, stage: "read", code: "NO_CODE_AT_ADDRESS", detail };
    }
    // An RPC that will not answer is not a refusal; it is a broken environment.
    throw err;
  }

  const hired = await hireAndVerify(read.request, deps);
  if (!hired.ok) return hired;
  if (hired.kind === "dry-run") {
    return {
      ok: true,
      kind: "dry-run",
      quote: {
        humanPrice: hired.quote.humanPrice,
        payTo: hired.quote.payTo,
        amountAtomic: hired.quote.amountAtomic.toString(),
      },
      budget: hired.budget,
    };
  }

  emit(deps, "compose", "composing seal A");
  const sealA = await composeSealA({
    request: read.request,
    sealB: hired.sealB,
    hire: hired.hire,
    ownAnalysis: read.ownAnalysis,
    ltvBps: req.ltvBps,
    agentId: deps.agentId,
    auditorAgentId: deps.auditor.agentId,
    network: deps.network,
    account: deps.account,
  });
  emit(deps, "compose", `seal A signed · embeds seal B · maxLtvBps ${sealA.verdict.maxLtvBps}`);
  const sealHash = sealDigest(sealA);

  const skipped: { settle?: string; publish?: string } = {};
  let storage: PublishReceipt | null = null;
  if (req.publish && deps.publisher) {
    try {
      storage = await deps.publisher.publish(sealA);
      emit(deps, "publish", `published to 0G Storage · root ${storage.root} · tx ${storage.txHash}`);
    } catch (err) {
      // A seal nobody can fetch is still a valid seal; the caller holds it. Say
      // so and carry on rather than losing a run to the storage layer.
      skipped.publish = `PUBLISH_FAILED: ${err instanceof Error ? err.message : String(err)}`;
      emit(deps, "publish", skipped.publish);
    }
  }

  const sealedResult = (listing: { txHash: `0x${string}`; ltvBps: number } | null): UnderwriteResult => ({
    ok: true,
    kind: "sealed",
    sealA,
    sealHash,
    sealB: hired.sealB,
    hire: hired.hire,
    storage,
    listing,
    skipped,
  });

  if (!req.settle) return sealedResult(null);
  if (deps.registry === null) {
    return {
      ok: false,
      stage: "settle",
      code: "NO_REGISTRY",
      detail: "pass --registry <address> or set REGISTRY_ADDRESS",
    };
  }

  // The registry's verifier accepts exactly one signer. Asking first turns a
  // wasted revert into a refusal that names both addresses.
  const trustedSigner = deps.trustedSigner ?? readTrustedSigner;
  const trusted = await trustedSigner(deps.registry, deps.rpcUrl);
  if (!isAddressEqual(trusted, deps.account.address)) {
    skipped.settle = `UNTRUSTED_SIGNER: registry verifier trusts ${trusted}, this agent signs as ${deps.account.address}`;
    return sealedResult(null);
  }

  // (7) Present it to the contract.
  emit(deps, "settle", `listing on CollateralRegistry ${deps.registry}`);
  const list = deps.list ?? listWithSeal;
  try {
    const result = await list(sealA, req.token, req.ltvBps, {
      registry: deps.registry,
      account: deps.account,
      ...(deps.rpcUrl === undefined ? {} : { rpcUrl: deps.rpcUrl }),
    });
    return sealedResult({ txHash: result.txHash, ltvBps: result.listed.ltvBps });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const named = msg.match(/(SEAL_SUBJECT_MISMATCH|AUDIT_FAILED|LTV_EXCEEDS_ATTESTED|SEAL_EXPIRED|NO_SEAL|BAD_SIGNATURE)/);
    return {
      ok: false,
      stage: "settle",
      code: (named?.[1] ?? "LIST_FAILED") as UnderwriteFailure,
      detail: named ? "reverted by CollateralRegistry" : msg.slice(0, 300),
    };
  }
}
