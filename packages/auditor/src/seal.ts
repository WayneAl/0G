import type { Account } from "viem";
import { signSealB, type AuditRequestPayload, type SealB, type Unsigned } from "@0x402/seal";
import { auditRequestHash } from "@0x402/seal";
import type { InferenceResult } from "@0x402/og";

export interface SealBConfig {
  /** Agent B's ERC-7857 tokenId. */
  agentId: string;
  /** The wallet that signs seals. Must be distinct from Agent A's (spec §6.5). */
  account: Account;
  /** How long the audit stays good for. Seals expire so upgradeable tokens get re-reviewed. */
  ttlSeconds: number;
}

/**
 * Turns one inference run into a signed seal B.
 *
 * The verdict is copied from the model, never softened: if the model says DENY,
 * the seal says DENY. Agent B has a financial incentive to be agreeable — it was
 * paid — which is exactly why the seal is signed and Agent A checks it.
 */
export async function issueSealB(
  request: AuditRequestPayload,
  inference: InferenceResult,
  config: SealBConfig,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SealB> {
  const unsigned: Unsigned<SealB> = {
    version: 1,
    type: "audit",
    agentId: config.agentId,
    subject: request.token.toLowerCase() as `0x${string}`,
    request: auditRequestHash(request),
    inference: {
      model: inference.model,
      trustMode: inference.trustMode,
      providerAddress: inference.providerAddress,
      promptHash: inference.promptHash,
      responseHash: inference.responseHash,
      teeAttestation: inference.attestation,
    },
    findings: inference.output.findings,
    verdict: {
      action: inference.output.action,
      maxLtvBps: inference.output.maxLtvBps,
    },
    issuedAt: now,
    expiresAt: now + config.ttlSeconds,
  };

  return signSealB(unsigned, config.account);
}
