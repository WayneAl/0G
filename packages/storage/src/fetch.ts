import { sealDigest } from "@acu/seal";
import { locateSeal, type Located, type LocateOptions } from "./locate.js";

/**
 * Getting a seal body back, and proving it is the one that was asked for.
 *
 * The indexer's HTTPS gateway is a convenience, not an authority: it answers
 * 200 with a JSON error body for a root it has never heard of, and nothing
 * stops it answering with someone else's bytes. So the status code decides
 * nothing here. The bytes are the canonical encoding of the seal, so
 * `sealDigest(parsed) === sealHash` is the whole integrity check — it holds
 * even if the gateway, the indexer and the RPC are all lying at once.
 *
 * Isomorphic: `viem`, `@acu/seal` and the platform `fetch`. The browser
 * verifier imports this file directly.
 */

export interface FetchOptions {
  indexerUrl: string;
  /** Seam. Defaults to the platform `fetch`. */
  fetch?: typeof fetch;
}

/** Raw bytes for a file root, straight from the indexer gateway. */
export async function fetchSealBytes(
  root: `0x${string}`,
  opts: FetchOptions,
): Promise<Uint8Array> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = `${opts.indexerUrl}/file?root=${root}`;
  const res = await doFetch(url);
  if (!res.ok) {
    throw new Error(`OG_GATEWAY_${res.status}: ${url} answered ${res.statusText || res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Why a seal could not be produced for a hash. Each reason names the step that
 * refused, so a caller can tell "nobody published it" from "somebody published
 * something else".
 */
export class SealNotFoundError extends Error {
  override readonly name = "SealNotFoundError";

  constructor(
    readonly reason: "NO_SUBMISSION" | "BAD_JSON" | "DIGEST_MISMATCH",
    detail?: string,
  ) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

/**
 * hash → chain → gateway → the seal, or a refusal that says which step failed.
 *
 * The seal comes back *unverified*: this function proves the body is the one
 * the hash names, not that its signatures are good. `verifySealA` does that,
 * locally, and it is deliberately not called here — storage must never be able
 * to make something look valid.
 */
export async function resolveSeal(
  sealHash: `0x${string}`,
  opts: LocateOptions & FetchOptions,
): Promise<{ seal: unknown; located: Located }> {
  const located = await locateSeal(sealHash, opts);
  if (located === null) {
    throw new SealNotFoundError(
      "NO_SUBMISSION",
      `no Flow.Submit from ${opts.sender} tagged ${sealHash} in the scanned range`,
    );
  }

  const bytes = await fetchSealBytes(located.root, opts);
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SealNotFoundError(
      "BAD_JSON",
      `${located.root} is not JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SealNotFoundError("DIGEST_MISMATCH", `${located.root} is not a seal object`);
  }

  const digest = sealDigest(parsed as Record<string, unknown>);
  if (digest.toLowerCase() !== sealHash.toLowerCase()) {
    throw new SealNotFoundError(
      "DIGEST_MISMATCH",
      `${located.root} hashes to ${digest}, not ${sealHash}`,
    );
  }

  return { seal: parsed, located };
}
