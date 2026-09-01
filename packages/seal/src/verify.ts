import { recoverMessageAddress, isAddressEqual } from "viem";
import { sealDigest } from "./canonical.js";
import { SealA, SealB } from "./schema.js";

/**
 * Why the check failed. Agent A surfaces these verbatim; demo scenes ⑤ and ⑥
 * assert on them.
 */
export type SealFailure =
  | "SCHEMA_INVALID"
  | "SIGNATURE_INVALID"
  | "SIGNER_MISMATCH"
  | "AGENT_ID_NOT_LIVE"
  | "SUBJECT_MISMATCH"
  | "REQUEST_MISMATCH"
  | "SEAL_EXPIRED"
  | "ATTESTATION_MISSING";

export class SealVerificationError extends Error {
  constructor(
    readonly failure: SealFailure,
    detail?: string,
  ) {
    super(detail ? `DELEGATE_SEAL_INVALID: ${failure} (${detail})` : `DELEGATE_SEAL_INVALID: ${failure}`);
    this.name = "SealVerificationError";
  }
}

/**
 * Maps an ERC-7857 tokenId to its live signer. Agentic ID minting is [ONSITE],
 * so the lookup sits behind an interface; `StaticAgentIdResolver` stands in until
 * the real registry address is known.
 */
export interface AgentIdResolver {
  /** Signer address for a live agent, or null if the id is unknown or revoked. */
  resolve(agentId: string): Promise<`0x${string}` | null>;
}

export class StaticAgentIdResolver implements AgentIdResolver {
  constructor(private readonly table: Record<string, `0x${string}`>) {}
  async resolve(agentId: string): Promise<`0x${string}` | null> {
    return this.table[agentId] ?? null;
  }
}

/** Recovers the signer of a seal from its own canonical digest. */
export async function recoverSealSigner(
  seal: Record<string, unknown>,
): Promise<`0x${string}`> {
  const signature = seal["signature"];
  if (typeof signature !== "string") throw new SealVerificationError("SIGNATURE_INVALID", "absent");
  return recoverMessageAddress({
    message: { raw: sealDigest(seal) },
    signature: signature as `0x${string}`,
  });
}

export interface VerifySealBContext {
  /** Token this underwriting run is about. */
  expectedSubject: `0x${string}`;
  /** keccak256 of the canonical audit request Agent A sent. */
  expectedRequest: `0x${string}`;
  resolver: AgentIdResolver;
  /** Unix seconds; injected so tests are not clock-dependent. */
  now: number;
}

/**
 * The six checks of spec §6.2, run by Agent A before it will embed seal B.
 *
 * The trust boundary lives here, not in the contract: "nobody is watching" means
 * Agent A must be able to reject Agent B on its own. Throws on the first failure.
 */
export async function verifySealB(input: unknown, ctx: VerifySealBContext): Promise<SealB> {
  const parsed = SealB.safeParse(input);
  if (!parsed.success) {
    throw new SealVerificationError("SCHEMA_INVALID", parsed.error.issues[0]?.message);
  }
  const seal = parsed.data;

  // 2. agentId maps to a live Agentic ID (resolved first: it yields the key for check 1).
  const registered = await ctx.resolver.resolve(seal.agentId);
  if (registered === null) throw new SealVerificationError("AGENT_ID_NOT_LIVE", seal.agentId);

  // 1. signature is valid for the key that agentId claims.
  let recovered: `0x${string}`;
  try {
    recovered = await recoverSealSigner(seal as unknown as Record<string, unknown>);
  } catch {
    throw new SealVerificationError("SIGNATURE_INVALID");
  }
  if (!isAddressEqual(recovered, registered)) {
    throw new SealVerificationError("SIGNER_MISMATCH", `recovered ${recovered}, expected ${registered}`);
  }

  // 3. subject binding — the seal is about the token we asked about.
  if (!isAddressEqual(seal.subject, ctx.expectedSubject)) {
    throw new SealVerificationError("SUBJECT_MISMATCH", seal.subject);
  }

  // 4. the seal answers the request we actually sent.
  if (seal.request.toLowerCase() !== ctx.expectedRequest.toLowerCase()) {
    throw new SealVerificationError("REQUEST_MISMATCH", seal.request);
  }

  // 5. not expired.
  if (ctx.now >= seal.expiresAt) {
    throw new SealVerificationError("SEAL_EXPIRED", `now=${ctx.now} expiresAt=${seal.expiresAt}`);
  }

  // 6. a seal claiming an attested trust tier must actually carry the attestation.
  // This is demo scene ⑤: skip verifiable inference to save money and the chain
  // stops believing you.
  if (seal.inference.trustMode !== "standard" && seal.inference.teeAttestation === null) {
    throw new SealVerificationError("ATTESTATION_MISSING", `trustMode=${seal.inference.trustMode}`);
  }

  return seal;
}

export interface VerifySealAContext {
  expectedSubject: `0x${string}`;
  resolver: AgentIdResolver;
  now: number;
}

/**
 * Verifies seal A and walks the seal chain down into every embedded seal B.
 * Anyone holding seal A can run this — that is the point of embedding.
 */
export async function verifySealA(input: unknown, ctx: VerifySealAContext): Promise<SealA> {
  const parsed = SealA.safeParse(input);
  if (!parsed.success) {
    throw new SealVerificationError("SCHEMA_INVALID", parsed.error.issues[0]?.message);
  }
  const seal = parsed.data;

  const registered = await ctx.resolver.resolve(seal.agentId);
  if (registered === null) throw new SealVerificationError("AGENT_ID_NOT_LIVE", seal.agentId);

  const recovered = await recoverSealSigner(seal as unknown as Record<string, unknown>);
  if (!isAddressEqual(recovered, registered)) {
    throw new SealVerificationError("SIGNER_MISMATCH", recovered);
  }
  if (!isAddressEqual(seal.subject, ctx.expectedSubject)) {
    throw new SealVerificationError("SUBJECT_MISMATCH", seal.subject);
  }
  if (ctx.now >= seal.verdict.expiresAt) {
    throw new SealVerificationError("SEAL_EXPIRED");
  }

  for (const d of seal.delegations) {
    await verifySealB(d.seal, {
      expectedSubject: seal.subject,
      expectedRequest: d.seal.request,
      resolver: ctx.resolver,
      now: ctx.now,
    });
  }
  return seal;
}
