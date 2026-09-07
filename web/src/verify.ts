import {
  SealVerificationError,
  recoverSealSigner,
  sealDigest,
  verifySealA,
  verifySealB,
  type AgentIdResolver,
  type SealB,
  type SealFailure,
} from "@0x402/seal";

/**
 * The verifier's report, as data.
 *
 * Nothing in this file re-implements a check. `@0x402/seal` decides, throws on the
 * first failure and names it; this shapes that one answer into rows a page can
 * draw. A second implementation of "is this seal good" is exactly the thing this
 * project must not have — the old single-file verifier had one, with its own
 * hand-written canonicalizer, and it is gone.
 *
 * Because the library stops at the first failure, the rows after the failing one
 * were never evaluated. They are marked `not reached` rather than green or red:
 * "we did not look" is not the same claim as "it is fine".
 */
export interface CheckRow {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SealReport {
  kind: "audit" | "underwriting";
  valid: boolean;
  failure: string | null;
  signer: `0x${string}` | null;
  checks: CheckRow[];
  children: SealReport[];
  attestation: SealB["inference"]["teeAttestation"] | null;
  sealHash: `0x${string}`;
}

export interface ReportOptions {
  resolver: AgentIdResolver;
  /** Unix seconds; injected so the report is not clock-dependent in a test. */
  now: number;
  /**
   * The token the caller asked about. Absent, the seal is held to its own
   * subject — a self-consistency check, which is all a pasted seal can offer.
   */
  expectedSubject?: `0x${string}`;
}

/** The eight checks, in the order `@0x402/seal` runs them. Seal A has no request, inference or tier. */
const ROWS_B = ["SCHEMA", "AGENT_ID_LIVE", "SIGNATURE", "SUBJECT", "REQUEST", "EXPIRY", "ATTESTATION", "TRUST_TIER"] as const;
const ROWS_A = ["SCHEMA", "AGENT_ID_LIVE", "SIGNATURE", "SUBJECT", "EXPIRY"] as const;

const FAILS_AT: Record<SealFailure, string> = {
  SCHEMA_INVALID: "SCHEMA",
  AGENT_ID_NOT_LIVE: "AGENT_ID_LIVE",
  SIGNATURE_INVALID: "SIGNATURE",
  SIGNER_MISMATCH: "SIGNATURE",
  SUBJECT_MISMATCH: "SUBJECT",
  REQUEST_MISMATCH: "REQUEST",
  SEAL_EXPIRED: "EXPIRY",
  ATTESTATION_MISSING: "ATTESTATION",
  TRUST_MODE_INSUFFICIENT: "TRUST_TIER",
};

const ZERO_HASH = `0x${"0".repeat(64)}` as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const short = (v: unknown): string =>
  typeof v === "string" && v.length > 20 ? `${v.slice(0, 10)}…${v.slice(-6)}` : String(v);

export const when = (ts: unknown): string =>
  typeof ts === "number" && Number.isFinite(ts)
    ? `${new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16)}Z`
    : "—";

/**
 * Runs the real verification, then re-derives the rows for display.
 *
 * `children` is built from the raw delegations rather than from the parsed seal,
 * so a seal A that fails its own schema still shows what it claims to contain.
 */
export async function reportSeal(input: unknown, opts: ReportOptions): Promise<SealReport> {
  const seal = isRecord(input) ? input : {};
  const kind: "audit" | "underwriting" = seal["type"] === "audit" ? "audit" : "underwriting";
  const subject = typeof seal["subject"] === "string" ? (seal["subject"].toLowerCase() as `0x${string}`) : ZERO_HASH;
  const expectedSubject = opts.expectedSubject?.toLowerCase() ?? subject;

  // The directory lookup and the signature recovery are run here as well as
  // inside the library, because the rows have to say *what* was found even when
  // the library refused — "recovers to 0xabc…, not 0xdef…" is the whole story of
  // a tampered seal, and a bare code does not tell it.
  const registered = await resolveQuietly(opts.resolver, seal["agentId"]);
  const recovered = await recoverQuietly(seal);

  let failure: SealFailure | null = null;
  let detail = "";
  try {
    if (kind === "underwriting") {
      await verifySealA(input, { expectedSubject: expectedSubject as `0x${string}`, resolver: opts.resolver, now: opts.now });
    } else {
      await verifySealB(input, {
        expectedSubject: expectedSubject as `0x${string}`,
        expectedRequest: (typeof seal["request"] === "string" ? seal["request"] : "0x") as `0x${string}`,
        resolver: opts.resolver,
        now: opts.now,
      });
    }
  } catch (err) {
    if (!(err instanceof SealVerificationError)) throw err;
    failure = err.failure;
    detail = err.message.replace(/^DELEGATE_SEAL_INVALID: /, "");
  }

  const names: readonly string[] = kind === "audit" ? ROWS_B : ROWS_A;
  // A seal A can only fail on a row of its own or inside a delegation. When the
  // failing code belongs to seal B, every row here was reached and passed; the
  // broken row is on the child card, where the containment drawing puts it.
  const failedRow = failure === null ? null : FAILS_AT[failure];
  const failedAt = failedRow === null ? -1 : names.indexOf(failedRow);

  const checks: CheckRow[] = names.map((name, i) => {
    if (failedAt === -1 || i < failedAt) return { name, ok: true, detail: describe(name, seal, kind, registered, recovered, expectedSubject) };
    if (i === failedAt) return { name, ok: false, detail };
    return { name, ok: false, detail: "not reached" };
  });

  const children: SealReport[] = [];
  const delegations = seal["delegations"];
  if (Array.isArray(delegations)) {
    for (const d of delegations) {
      if (!isRecord(d) || !isRecord(d["seal"])) continue;
      children.push(
        await reportSeal(d["seal"], {
          resolver: opts.resolver,
          now: opts.now,
          expectedSubject: expectedSubject as `0x${string}`,
        }),
      );
    }
  }

  const inference = seal["inference"];
  const attestation =
    kind === "audit" && isRecord(inference) && isRecord(inference["teeAttestation"])
      ? (inference["teeAttestation"] as SealB["inference"]["teeAttestation"])
      : null;

  return {
    kind,
    valid: failure === null,
    failure,
    signer: recovered,
    checks,
    children,
    attestation,
    sealHash: isRecord(input) ? sealDigest(input) : ZERO_HASH,
  };
}

/** What a row says when it passed. The failing row says what the library said. */
function describe(
  name: string,
  seal: Record<string, unknown>,
  kind: "audit" | "underwriting",
  registered: `0x${string}` | null,
  recovered: `0x${string}` | null,
  expectedSubject: string,
): string {
  const inference = isRecord(seal["inference"]) ? seal["inference"] : {};
  const verdict = isRecord(seal["verdict"]) ? seal["verdict"] : {};

  switch (name) {
    case "SCHEMA":
      return `version ${String(seal["version"])}, type ${String(seal["type"])}`;
    case "AGENT_ID_LIVE":
      return `agent ${String(seal["agentId"])} resolves to ${short(registered)} in the directory`;
    case "SIGNATURE":
      return `recovers to ${short(recovered)} — the key agent ${String(seal["agentId"])} claims`;
    case "SUBJECT":
      return expectedSubject === String(seal["subject"]).toLowerCase()
        ? String(seal["subject"])
        : `${String(seal["subject"])} — checked against ${expectedSubject}`;
    case "REQUEST":
      return `${short(seal["request"])} — the seal answers this request hash`;
    case "EXPIRY":
      return `valid until ${when(kind === "audit" ? seal["expiresAt"] : verdict["expiresAt"])}`;
    case "ATTESTATION": {
      const att = isRecord(inference["teeAttestation"]) ? inference["teeAttestation"] : null;
      return att === null
        ? "no attestation carried"
        : `TEE attestation present · chat ${String(att["chatId"])} · tee_verified ${String(att["teeVerified"])}`;
    }
    case "TRUST_TIER":
      return `trust mode ${String(inference["trustMode"])} — the tier an underwriter will act on`;
    default:
      return "";
  }
}

async function resolveQuietly(resolver: AgentIdResolver, agentId: unknown): Promise<`0x${string}` | null> {
  if (typeof agentId !== "string" || agentId === "") return null;
  try {
    return await resolver.resolve(agentId);
  } catch {
    // A directory that will not load is reported by the row the library fails —
    // AGENT_ID_NOT_LIVE — not swallowed into a green row here.
    return null;
  }
}

async function recoverQuietly(seal: Record<string, unknown>): Promise<`0x${string}` | null> {
  try {
    return await recoverSealSigner(seal);
  } catch {
    // A signature that cannot be recovered from is the SIGNATURE row's failure,
    // and the library states it there. This only decides what the row can name.
    return null;
  }
}
