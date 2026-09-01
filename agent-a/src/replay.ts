import { readFileSync } from "node:fs";
import { z } from "zod";
import { SealB, type AuditRequestPayload } from "@acu/seal";

/**
 * A recorded run, for use when the venue wifi dies.
 *
 * What is replayed is only what crossed a network: the RPC read of the token,
 * Agent B's HTTP response, and the settlement/listing transaction hashes.
 *
 * What is NOT replayed is every check the project is actually claiming. Agent A
 * re-verifies the recorded seal B for real — signature, agent id, subject,
 * request, expiry, attestation — and signs a fresh seal A over it. So scenes ⑤
 * and ⑥, which are refused at Agent A and never reach a chain, are exactly as
 * real offline as online. Only the chain outcome in scenes ①–④ is quoted from
 * the recording, and it is labelled as such.
 */
export const ReplayFixture = z.object({
  recordedAt: z.string(),
  label: z.string(),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** Reproduces the request hash, so seal B's `request` binding still checks out. */
  request: z.object({
    token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    artifact: z.string(),
    requestedAt: z.number().int(),
    nonce: z.string(),
  }),
  quote: z.object({
    amountAtomic: z.string(),
    payTo: z.string(),
    humanPrice: z.string(),
  }),
  audit: z.object({
    action: z.string(),
    maxLtvBps: z.number(),
    findings: z.array(z.string()),
    reasoning: z.string(),
    costNeuron: z.string().nullable(),
  }),
  /** Parsed loosely: a tampered fixture must reach the real verifier to be rejected. */
  sealB: z.unknown(),
  settlementTx: z.string().nullable(),
  /** What the registry did when this was recorded live. Null if it never got there. */
  listing: z
    .object({
      txHash: z.string(),
      outcome: z.string(),
      ltvBps: z.number(),
    })
    .nullable(),
});
export type ReplayFixture = z.infer<typeof ReplayFixture>;

export function loadFixture(path: string): ReplayFixture {
  return ReplayFixture.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function fixtureRequest(f: ReplayFixture): AuditRequestPayload {
  return {
    token: f.request.token.toLowerCase() as `0x${string}`,
    artifact: f.request.artifact,
    requestedAt: f.request.requestedAt,
    nonce: f.request.nonce,
  };
}

/** Present only so the recorder can typecheck what it wrote. */
export const RecordedSealB = SealB;
