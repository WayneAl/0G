import { z } from "zod";

const Hex = (bytes?: number) =>
  z.string().regex(
    bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]*$/,
    bytes ? `expected 0x-prefixed ${bytes}-byte hex` : "expected 0x-prefixed hex",
  );

/** Lowercased so canonicalization is checksum-independent. */
export const Address = Hex(20).transform((s) => s.toLowerCase() as `0x${string}`);
export const Bytes32 = Hex(32).transform((s) => s.toLowerCase() as `0x${string}`);
export const Signature = Hex(65).transform((s) => s.toLowerCase() as `0x${string}`);

export const TrustMode = z.enum(["standard", "verified", "private"]);
export const Action = z.enum(["ALLOW", "DENY"]);

/**
 * Evidence that the inference ran inside a TEE, in a form a third party can
 * re-check without trusting us or the Router.
 *
 * Deviates from spec §4.1, which typed this as `<chatId / signature / null>`.
 * The Router exposes a full verification loop (`ZG-Res-Key` -> chatId ->
 * `GET {provider}/v1/proxy/signature/{chatId}` -> EIP-191 against the on-chain
 * teeSignerAddress), so the seal carries every field a verifier needs to walk it.
 * A bare chatId would make the seal a claim; this makes it checkable. See NOTES.md §A2.
 */
export const TeeAttestation = z.object({
  chatId: z.string().min(1),
  teeVerified: z.boolean(),
  teeSignerAddress: Address.nullable(),
  signature: Hex().nullable(),
  signedTextHash: Bytes32.nullable(),
  signatureEndpoint: z.string().url().nullable(),
});
export type TeeAttestation = z.infer<typeof TeeAttestation>;

export const Inference = z.object({
  model: z.string().min(1),
  trustMode: TrustMode,
  providerAddress: Address,
  promptHash: Bytes32,
  responseHash: Bytes32,
  teeAttestation: TeeAttestation.nullable(),
});

/** Seal B — issued by Agent B (Code Auditor). Spec §4.1. */
export const SealB = z.object({
  version: z.literal(1),
  type: z.literal("audit"),
  agentId: z.string().min(1),
  subject: Address,
  request: Bytes32,
  inference: Inference,
  findings: z.array(z.string()),
  verdict: z.object({
    action: Action,
    maxLtvBps: z.number().int().min(0).max(10000),
  }),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  signature: Signature,
});
export type SealB = z.infer<typeof SealB>;

export const Delegation = z.object({
  agentId: z.string().min(1),
  service: z.string().min(1),
  priceAtomic: z.string().regex(/^[0-9]+$/),
  network: z.string().min(1),
  settlementTx: Hex(32).nullable(),
  seal: SealB,
  sealVerified: z.literal(true),
});

/** Seal A — issued by Agent A (Underwriter), embedding seal B. Spec §4.2. */
export const SealA = z.object({
  version: z.literal(1),
  type: z.literal("underwriting"),
  agentId: z.string().min(1),
  subject: Address,
  delegations: z.array(Delegation).min(1),
  ownAnalysis: z.object({
    liquidityDepthUsd: z.string(),
    top10HolderPct: z.number(),
    sourceHash: Bytes32,
  }),
  verdict: z.object({
    action: Action,
    maxLtvBps: z.number().int().min(0).max(10000),
    expiresAt: z.number().int().positive(),
  }),
  signature: Signature,
});
export type SealA = z.infer<typeof SealA>;

/**
 * Spec §4.3 — the only shape the model is allowed to produce.
 * `.strict()` is load-bearing: an injected token that coaxes extra keys out of the
 * model fails parsing outright rather than smuggling a field into our logic.
 */
export const InferenceOutput = z
  .object({
    action: Action,
    maxLtvBps: z.number().int().min(0).max(10000),
    findings: z.array(z.string()),
    reasoning: z.string(),
  })
  .strict();
export type InferenceOutput = z.infer<typeof InferenceOutput>;
