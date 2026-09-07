import { concat, createPublicClient, http, keccak256 } from "viem";

/**
 * Finding a seal body again, with nothing but its hash.
 *
 * 0G's log layer is the index: every upload emits `Flow.Submit`, and the
 * uploader chose the tags. `@0x402/storage` puts `sealDigest(seal)` there, so the
 * chain itself maps sealHash → file root without a database, a server, or
 * anyone's permission. This module is isomorphic on purpose — the browser
 * verifier imports it, so it may reach for `viem` and nothing heavier.
 */

/** `FixedPriceFlow` on 0G Galileo testnet — the contract every upload submits to. */
export const OG_FLOW_TESTNET = "0x22E03a6A89B950F1c82ec5e74F8eCa321a105296" as const;

export const SUBMIT_EVENT = {
  type: "event",
  name: "Submit",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "identity", type: "bytes32", indexed: true },
    { name: "submissionIndex", type: "uint256" },
    { name: "startPos", type: "uint256" },
    { name: "length", type: "uint256" },
    {
      name: "submission",
      type: "tuple",
      components: [
        { name: "length", type: "uint256" },
        { name: "tags", type: "bytes" },
        {
          name: "nodes",
          type: "tuple[]",
          components: [
            { name: "root", type: "bytes32" },
            { name: "height", type: "uint256" },
          ],
        },
      ],
    },
  ],
} as const;

/**
 * The file root a submission's merkle nodes add up to.
 *
 * A submission is a list of complete subtrees, largest first. The file root is
 * the right-leaning fold over them: start at the last node and hash each earlier
 * node onto the left of the accumulator. Verified against the live spike —
 * txSeq 149629 folds to 0xec5a33d2…8a42f, the root the indexer reports.
 */
export function rootFromNodes(
  nodes: readonly { root: `0x${string}`; height: bigint | number }[],
): `0x${string}` {
  const last = nodes[nodes.length - 1];
  if (last === undefined) {
    throw new Error("OG_SUBMISSION_NO_NODES: a Submit event with no merkle nodes has no file root");
  }
  let root: `0x${string}` = last.root;
  for (let i = nodes.length - 2; i >= 0; i--) {
    root = keccak256(concat([nodes[i]!.root, root]));
  }
  return root;
}

export interface SubmitLog {
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  args: {
    submissionIndex: bigint;
    submission: {
      tags: `0x${string}`;
      nodes: readonly { root: `0x${string}`; height: bigint }[];
    };
  };
}

export interface LocateOptions {
  rpcUrl: string;
  /** Only this uploader's submissions are considered. */
  sender: `0x${string}`;
  flowAddress?: `0x${string}`;
  /** The RPC rejects the full range; 5M blocks is what it will answer. */
  chunkBlocks?: bigint;
  /** 12 × 5M ≈ 60M blocks — the whole chain, today. */
  maxChunks?: number;
  /** Seam. The default is a viem `getLogs` filtered by `SUBMIT_EVENT` and `sender`. */
  getLogs?: (args: {
    address: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<SubmitLog[]>;
  /** Seam. The default is a viem `getBlockNumber`. */
  latestBlock?: () => Promise<bigint>;
}

export interface Located {
  root: `0x${string}`;
  txHash: `0x${string}`;
  txSeq: number;
  blockNumber: bigint;
}

export const DEFAULT_CHUNK_BLOCKS = 5_000_000n;
export const DEFAULT_MAX_CHUNKS = 12;

function makeClient(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl) });
}

function defaultGetLogs(
  rpcUrl: string,
  sender: `0x${string}`,
): NonNullable<LocateOptions["getLogs"]> {
  const client = makeClient(rpcUrl);
  return async ({ address, fromBlock, toBlock }) => {
    const logs = await client.getLogs({
      address,
      event: SUBMIT_EVENT,
      args: { sender },
      fromBlock,
      toBlock,
      strict: true,
    });
    return logs.flatMap((log): SubmitLog[] =>
      // A pending log has no block to order by; it is not located yet.
      log.blockNumber === null || log.transactionHash === null
        ? []
        : [
            {
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              args: {
                submissionIndex: log.args.submissionIndex,
                submission: {
                  tags: log.args.submission.tags,
                  nodes: log.args.submission.nodes,
                },
              },
            },
          ],
    );
  };
}

/**
 * The newest submission this sender tagged with `sealHash`, or null.
 *
 * Scans backwards from `latest` in `chunkBlocks` windows and stops at the first
 * window that holds a match, newest-in-window first — the seal was published
 * once, and if it was published twice the later body is the one to fetch.
 * `null` after `maxChunks` windows is an honest "not found in the range I
 * looked at", never an error swallowed into a default.
 */
export async function locateSeal(
  sealHash: `0x${string}`,
  opts: LocateOptions,
): Promise<Located | null> {
  const address = opts.flowAddress ?? OG_FLOW_TESTNET;
  const chunkBlocks = opts.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS;
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
  const getLogs = opts.getLogs ?? defaultGetLogs(opts.rpcUrl, opts.sender);
  const latestBlock = opts.latestBlock ?? (() => makeClient(opts.rpcUrl).getBlockNumber());
  const wanted = sealHash.toLowerCase();

  let toBlock = await latestBlock();
  for (let chunk = 0; chunk < maxChunks; chunk++) {
    const fromBlock = toBlock - chunkBlocks + 1n > 0n ? toBlock - chunkBlocks + 1n : 0n;
    const logs = await getLogs({ address, fromBlock, toBlock });

    let best: SubmitLog | null = null;
    for (const log of logs) {
      if (log.args.submission.tags.toLowerCase() !== wanted) continue;
      if (best === null || log.blockNumber > best.blockNumber) best = log;
    }
    if (best !== null) {
      return {
        root: rootFromNodes(best.args.submission.nodes),
        txHash: best.transactionHash,
        txSeq: Number(best.args.submissionIndex),
        blockNumber: best.blockNumber,
      };
    }

    if (fromBlock === 0n) break;
    toBlock = fromBlock - 1n;
  }
  return null;
}
