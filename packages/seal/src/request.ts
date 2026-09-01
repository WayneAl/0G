import { keccak256, toHex } from "viem";
import { canonicalize } from "./canonical.js";

/**
 * The audit request, as both agents must see it.
 *
 * Agent A hashes this and later checks that seal B's `request` field matches.
 * That check is only meaningful if both sides derive the hash from identical
 * bytes, so the shape and the hashing both live here rather than being written
 * twice.
 */
export interface AuditRequestPayload {
  /** Token under review. */
  token: `0x${string}`;
  /** Untrusted material about the token, gathered by Agent A from chain. */
  artifact: string;
  /** Unix seconds. */
  requestedAt: number;
  /** Makes two identical requests distinguishable, so a seal cannot be replayed. */
  nonce: string;
}

export function auditRequestHash(payload: AuditRequestPayload): `0x${string}` {
  return keccak256(toHex(canonicalize({ ...payload, token: payload.token.toLowerCase() })));
}
