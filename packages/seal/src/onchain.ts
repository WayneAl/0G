import { encodeAbiParameters, parseAbiParameters, keccak256, pad, type Account } from "viem";
import { sealDigest } from "./canonical.js";
import type { SealA } from "./schema.js";

/** Mirrors the Solidity `Verdict` struct in contracts/src/IProofVerifier.sol. */
export interface Verdict {
  subject: `0x${string}`;
  action: number;
  maxLtvBps: number;
  expiresAt: bigint;
  sealHash: `0x${string}`;
  agentId: bigint;
  delegationDepth: number;
}

const VERDICT_ABI = parseAbiParameters(
  "(bytes32 subject, uint8 action, uint16 maxLtvBps, uint64 expiresAt, bytes32 sealHash, uint256 agentId, uint8 delegationDepth)",
);
const PROOF_ABI = parseAbiParameters(
  "(bytes32 subject, uint8 action, uint16 maxLtvBps, uint64 expiresAt, bytes32 sealHash, uint256 agentId, uint8 delegationDepth), bytes signature",
);

/**
 * Projects seal A onto the flat struct the contract can afford to check.
 *
 * `delegationDepth` is the chain depth. Seal A embeds one seal B, so it is 1 here;
 * the chain itself is verified off-chain (see README). Spec §5.1 reserves the field.
 */
export function toVerdict(seal: SealA): Verdict {
  return {
    subject: pad(seal.subject, { size: 32 }),
    action: seal.verdict.action === "ALLOW" ? 1 : 0,
    maxLtvBps: seal.verdict.maxLtvBps,
    expiresAt: BigInt(seal.verdict.expiresAt),
    sealHash: sealDigest(seal as unknown as Record<string, unknown>),
    agentId: BigInt(seal.agentId),
    delegationDepth: seal.delegations.length,
  };
}

export function encodeVerdict(v: Verdict): `0x${string}` {
  return encodeAbiParameters(VERDICT_ABI, [v]);
}

/** The digest StubVerifier reconstructs and recovers against. */
export function verdictDigest(v: Verdict): `0x${string}` {
  return keccak256(encodeVerdict(v));
}

/**
 * Builds the `proof` bytes for `CollateralRegistry.list`.
 *
 * The signature is over the Verdict, not the seal JSON: the contract can only see
 * what it can decode. Seal A stays bound to it through `sealHash`.
 */
export async function buildStubProof(seal: SealA, account: Account): Promise<`0x${string}`> {
  if (!account.signMessage) throw new Error("account cannot sign messages");
  const verdict = toVerdict(seal);
  const signature = await account.signMessage({ message: { raw: verdictDigest(verdict) } });
  return encodeAbiParameters(PROOF_ABI, [verdict, signature]);
}
