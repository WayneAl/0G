import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { listRecentListings, type FeedEntry } from "../src/feed.js";

/**
 * The feed walks the same way `@0x402/storage`'s locate does, and for the same
 * reason: the RPC rejects a full-range `eth_getLogs`. What is tested here is the
 * walk (windows, their size, where it stops) and the dedup rule — a relist
 * replaces, it does not appear twice.
 */
const REGISTRY = "0xC1AAfd71480Ebc92C7F9fcC4d24272bd7B46a65E" as const;
const TOKEN = "0xDB08Ce217Ce842b06baf76a0Bbb2C10f47fF9eB8" as const;
const OTHER = "0x00000000000000000000000000000000000000aa" as const;
const HASH_OLD = `0x${"1".repeat(64)}` as const;
const HASH_NEW = `0x${"2".repeat(64)}` as const;
const HASH_OTHER = `0x${"3".repeat(64)}` as const;

interface Log {
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  args: { token: `0x${string}`; ltvBps: number; sealHash: `0x${string}` };
}

const log = (
  blockNumber: bigint,
  token: `0x${string}`,
  ltvBps: number,
  sealHash: `0x${string}`,
): Log => ({
  blockNumber,
  transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`,
  args: { token, ltvBps, sealHash },
});

const fakeClient = (latest: bigint, logs: Log[], ranges: [bigint, bigint][]) =>
  ({
    getBlockNumber: async () => latest,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  }) as unknown as PublicClient;

describe("listRecentListings", () => {
  it("keeps only the newest listing per token and walks in 5M-block windows down to fromBlock", async () => {
    const ranges: [bigint, bigint][] = [];
    const client = fakeClient(
      60_000_000n,
      [
        log(52_600_000n, TOKEN, 7000, HASH_OLD),
        log(52_700_000n, TOKEN, 7500, HASH_NEW),
        log(59_000_000n, OTHER, 6000, HASH_OTHER),
      ],
      ranges,
    );

    const entries = await listRecentListings(
      { rpcUrl: "http://unused.invalid", registry: REGISTRY, fromBlock: 52_557_531n },
      20,
      client,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual<FeedEntry>({
      token: OTHER,
      ltvBps: 6000,
      sealHash: HASH_OTHER,
      blockNumber: 59_000_000n,
      txHash: log(59_000_000n, OTHER, 6000, HASH_OTHER).transactionHash,
    });
    expect(entries[1]!.token).toBe(TOKEN);
    expect(entries[1]!.blockNumber).toBe(52_700_000n);
    expect(entries[1]!.sealHash).toBe(HASH_NEW);

    expect(ranges).toEqual([
      [55_000_001n, 60_000_000n],
      [52_557_531n, 55_000_000n],
    ]);
    for (const [from, to] of ranges) expect(to - from + 1n).toBeLessThanOrEqual(5_000_000n);
    expect(ranges.at(-1)![0]).toBe(52_557_531n);
  });

  it("stops walking as soon as it has `limit` tokens", async () => {
    const ranges: [bigint, bigint][] = [];
    const client = fakeClient(
      60_000_000n,
      [log(59_000_000n, OTHER, 6000, HASH_OTHER), log(52_700_000n, TOKEN, 7500, HASH_NEW)],
      ranges,
    );

    const entries = await listRecentListings(
      { rpcUrl: "http://unused.invalid", registry: REGISTRY, fromBlock: 52_557_531n },
      1,
      client,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]!.token).toBe(OTHER);
    expect(ranges).toHaveLength(1);
  });

  it("returns nothing, not an error, when nobody has listed", async () => {
    const ranges: [bigint, bigint][] = [];
    const client = fakeClient(52_600_000n, [], ranges);

    const entries = await listRecentListings(
      { rpcUrl: "http://unused.invalid", registry: REGISTRY, fromBlock: 52_557_531n },
      20,
      client,
    );

    expect(entries).toEqual([]);
    expect(ranges).toEqual([[52_557_531n, 52_600_000n]]);
  });
});
