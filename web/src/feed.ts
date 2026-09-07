import { createPublicClient, http, type PublicClient } from "viem";

/**
 * What has actually been underwritten, read straight off the chain.
 *
 * A listing is not a verdict — this module only says "somebody listed this
 * token with this seal hash". The page then fetches each seal body from 0G
 * Storage and runs `@0x402/seal` on it locally before it colours a card. Nothing
 * here decides whether a seal is good.
 */
export const LISTED_EVENT = {
  type: "event",
  name: "Listed",
  inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "ltvBps", type: "uint16", indexed: false },
    { name: "sealHash", type: "bytes32", indexed: false },
  ],
} as const;

/** The RPC rejects a full-range `eth_getLogs`; 5M blocks is what it will answer. */
export const FEED_CHUNK_BLOCKS = 5_000_000n;

export interface FeedEntry {
  token: `0x${string}`;
  ltvBps: number;
  sealHash: `0x${string}`;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface FeedConfig {
  rpcUrl: string;
  registry: `0x${string}`;
  /** The registry's deploy block. Below it there is nothing to find. */
  fromBlock: bigint;
}

/**
 * The newest `limit` listings, newest first, one per token.
 *
 * Walks backwards from `latest` in `FEED_CHUNK_BLOCKS` windows — the same shape
 * as `locateSeal` in `@0x402/storage`, and for the same reason — and stops when it
 * has `limit` tokens or reaches `fromBlock`. A relist replaces rather than
 * repeats: the newest `Listed` for a token is the state of that token, and the
 * older one is history the registry itself no longer answers with.
 */
export async function listRecentListings(
  cfg: FeedConfig,
  limit: number,
  client?: PublicClient,
): Promise<FeedEntry[]> {
  const pub = client ?? (createPublicClient({ transport: http(cfg.rpcUrl) }) as PublicClient);
  const newest = new Map<string, FeedEntry>();

  let toBlock = await pub.getBlockNumber();
  while (toBlock >= cfg.fromBlock && newest.size < limit) {
    const span = toBlock - FEED_CHUNK_BLOCKS + 1n;
    const fromBlock = span > cfg.fromBlock ? span : cfg.fromBlock;

    const logs = await pub.getLogs({
      address: cfg.registry,
      event: LISTED_EVENT,
      fromBlock,
      toBlock,
      strict: true,
    });

    for (const log of logs) {
      // A pending log has no block to order by; it is not listed yet.
      if (log.blockNumber === null || log.transactionHash === null) continue;
      const key = log.args.token.toLowerCase();
      const seen = newest.get(key);
      if (seen !== undefined && seen.blockNumber >= log.blockNumber) continue;
      newest.set(key, {
        token: log.args.token,
        ltvBps: Number(log.args.ltvBps),
        sealHash: log.args.sealHash,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      });
    }

    if (fromBlock === cfg.fromBlock) break;
    toBlock = fromBlock - 1n;
  }

  return [...newest.values()]
    .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1))
    .slice(0, limit);
}
