import { keccak256, toHex } from "viem";

/**
 * Deterministic JSON serialization.
 *
 * Two agents in different processes must derive byte-identical bytes from the same
 * seal, or signature verification becomes a coin flip. Object keys are sorted
 * recursively; arrays keep their order (order is semantic — `findings` and
 * `delegations` are ordered lists). `undefined` members are dropped so that an
 * absent optional and an explicitly-undefined optional hash the same.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}

/**
 * The digest an agent signs. `signature` is excluded — it is the output of this
 * function, not an input to it.
 */
export function sealDigest(seal: Record<string, unknown>): `0x${string}` {
  const { signature: _drop, ...rest } = seal;
  return keccak256(toHex(canonicalize(rest)));
}
