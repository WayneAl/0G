import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";
import { JsonRpcProvider, Wallet } from "ethers";
import { canonicalize, sealDigest, type SealA } from "@acu/seal";
import type { PublishReceipt, SealPublisher } from "@acu/underwriter";

/**
 * Putting a seal body where anyone can fetch it, forever, without asking us.
 *
 * This is the only file in the repo that imports `ethers` or the 0G Storage
 * SDK: it needs a key and a Node runtime, and `locate.ts`/`fetch.ts` — which
 * the browser bundles — must stay free of both. Reading a seal back never
 * touches this module.
 *
 * The tag is the whole trick. `indexer.upload(..., { tags: sealDigest(seal) })`
 * makes the `Flow.Submit` log carry the seal's own hash, so the chain becomes
 * the index and `locateSeal` needs no server to answer "where is seal X".
 */

export interface PublishOptions {
  privateKey: `0x${string}`;
  rpcUrl: string;
  indexerUrl: string;
}

export const OG_TESTNET_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";
export const OG_TESTNET_RPC = "https://evmrpc-testnet.0g.ai";

/**
 * Uploads `canonicalize(seal)` as UTF-8, tagged with `sealDigest(seal)`.
 *
 * The bytes are the canonical encoding — the same bytes the signature covers —
 * so a reader who fetches them can re-derive the hash and the signer without
 * trusting the storage layer at all.
 */
export async function publishSeal(seal: SealA, opts: PublishOptions): Promise<PublishReceipt> {
  const sealHash = sealDigest(seal);
  const bytes = new TextEncoder().encode(canonicalize(seal));
  const file = new MemData(bytes);
  const indexer = new Indexer(opts.indexerUrl);
  const signer = new Wallet(opts.privateKey, new JsonRpcProvider(opts.rpcUrl));

  const [res, err] = await indexer.upload(file, opts.rpcUrl, signer, { tags: sealHash });
  if (err !== null) {
    throw new Error(`OG_STORAGE_UPLOAD_FAILED: ${err.message}`);
  }
  // The SDK also has a fragmented multi-tx shape. A seal is one small file; if
  // it ever came back split, the receipt would name a root nobody can resolve.
  if (!("txHash" in res)) {
    throw new Error(
      `OG_STORAGE_UNEXPECTED_RESULT: upload returned a fragmented result (${res.txSeqs.length} transactions) for a ${bytes.length}-byte seal`,
    );
  }

  return {
    root: res.rootHash as `0x${string}`,
    txHash: res.txHash as `0x${string}`,
    txSeq: res.txSeq,
    sealHash,
    indexerUrl: opts.indexerUrl,
    bytes: bytes.length,
  };
}

/** The `SealPublisher` seam `underwrite()` expects, backed by 0G Storage. */
export function ogStoragePublisher(opts: PublishOptions): SealPublisher {
  return { publish: (seal: SealA) => publishSeal(seal, opts) };
}
