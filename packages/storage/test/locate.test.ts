import { describe, expect, it } from "vitest";
import { locateSeal, rootFromNodes, type LocateOptions, type SubmitLog } from "../src/locate.js";

/**
 * Every value here was recorded from the live 0G Galileo spike — upload tx
 * 0xa1ac7763…41b75, txSeq 149629 — not invented. If `rootFromNodes` stops
 * reproducing this root, the fold is wrong, not the fixture.
 */
const SPIKE_NODES: readonly { root: `0x${string}`; height: bigint }[] = [
  { root: "0x8ec11cf2f3a80c3418e17f0d656c05454aa5579b37a96ee0ac9092c32c44e8d2", height: 2n },
  { root: "0xd359d9c6c46604a6530523bdf309d557ca7fb4602a3a94bd19df7884af478601", height: 1n },
  { root: "0x344e131d8a53e14582031c3ee0decf0712d26031b69a6eb605fc86009704d266", height: 0n },
];
const SPIKE_ROOT = "0xec5a33d2e244bba38ff92353534f39333b7c70302bafe1e64d7a1a2a8cd8a42f" as const;
const SPIKE_TAGS = "0x6ee707d5afe6112338a134b991a0d75d6a604fd7307ca6d087becf7ade535871" as const;
const SPIKE_TX = "0xa1ac7763ab26db8a98f98e4bfa67a5189bee6c2c2397575b22244f91bb741b75" as const;
const SPIKE_SENDER = "0x6ddF162A95123AaD1355E5D2FB66C2B1015Adc41" as const;
const SPIKE_BLOCK = 53526025n;
const SPIKE_TXSEQ = 149629;
const LATEST = 53526210n;

const spikeLog: SubmitLog = {
  blockNumber: SPIKE_BLOCK,
  transactionHash: SPIKE_TX,
  args: {
    submissionIndex: BigInt(SPIKE_TXSEQ),
    submission: { tags: SPIKE_TAGS, nodes: SPIKE_NODES },
  },
};

/** Windows must tile the chain backwards: each one ends where the next begins. */
function expectDescendingTiling(windows: readonly (readonly [bigint, bigint])[]): void {
  for (const [from, to] of windows) expect(from <= to).toBe(true);
  for (let i = 1; i < windows.length; i++) {
    const prev = windows[i - 1]!;
    const here = windows[i]!;
    expect(here[1]).toBe(prev[0] - 1n); // contiguous, descending, non-overlapping
  }
}

function recordingLogs(logsFor: (from: bigint, to: bigint) => SubmitLog[]): {
  getLogs: NonNullable<LocateOptions["getLogs"]>;
  windows: (readonly [bigint, bigint])[];
} {
  const windows: (readonly [bigint, bigint])[] = [];
  return {
    windows,
    getLogs: async ({ fromBlock, toBlock }) => {
      windows.push([fromBlock, toBlock] as const);
      return logsFor(fromBlock, toBlock);
    },
  };
}

describe("rootFromNodes", () => {
  it("folds the spike's three submission nodes into the root the chain reported", () => {
    expect(rootFromNodes(SPIKE_NODES)).toBe(SPIKE_ROOT);
  });

  it("returns the node's own root when the submission is a single node", () => {
    expect(rootFromNodes([{ root: SPIKE_ROOT, height: 0n }])).toBe(SPIKE_ROOT);
  });
});

describe("locateSeal", () => {
  it("finds the spike submission and reports its root, tx and seq", async () => {
    const { getLogs, windows } = recordingLogs((from, to) =>
      from <= SPIKE_BLOCK && SPIKE_BLOCK <= to ? [spikeLog] : [],
    );

    const located = await locateSeal(SPIKE_TAGS, {
      rpcUrl: "http://rpc.invalid",
      sender: SPIKE_SENDER,
      chunkBlocks: 1000n,
      maxChunks: 3,
      latestBlock: async () => LATEST,
      getLogs,
    });

    expect(located).toEqual({
      root: SPIKE_ROOT,
      txHash: SPIKE_TX,
      txSeq: SPIKE_TXSEQ,
      blockNumber: SPIKE_BLOCK,
    });
    expect(windows).toHaveLength(1); // stops at the first window that matches
    expect(windows[0]).toEqual([LATEST - 1000n + 1n, LATEST]);
    expectDescendingTiling(windows);
  });

  it("gives up after maxChunks windows and says so with null", async () => {
    const { getLogs, windows } = recordingLogs(() => []);

    const located = await locateSeal(SPIKE_TAGS, {
      rpcUrl: "http://rpc.invalid",
      sender: SPIKE_SENDER,
      chunkBlocks: 1000n,
      maxChunks: 3,
      latestBlock: async () => LATEST,
      getLogs,
    });

    expect(located).toBeNull();
    expect(windows).toHaveLength(3);
    expectDescendingTiling(windows);
  });

  it("ignores submissions whose tags are some other seal", async () => {
    const otherSeal: SubmitLog = {
      ...spikeLog,
      args: {
        submissionIndex: 1n,
        submission: {
          tags: "0x1111111111111111111111111111111111111111111111111111111111111111",
          nodes: SPIKE_NODES,
        },
      },
    };
    const { getLogs } = recordingLogs(() => [otherSeal]);

    const located = await locateSeal(SPIKE_TAGS, {
      rpcUrl: "http://rpc.invalid",
      sender: SPIKE_SENDER,
      chunkBlocks: 1000n,
      maxChunks: 2,
      latestBlock: async () => LATEST,
      getLogs,
    });

    expect(located).toBeNull();
  });

  it("prefers the newest submission when one window holds two of them", async () => {
    const republished: SubmitLog = {
      blockNumber: SPIKE_BLOCK + 5n,
      transactionHash: "0xbbbb7763ab26db8a98f98e4bfa67a5189bee6c2c2397575b22244f91bb741b75",
      args: {
        submissionIndex: BigInt(SPIKE_TXSEQ + 1),
        submission: {
          tags: SPIKE_TAGS,
          nodes: [{ root: "0x344e131d8a53e14582031c3ee0decf0712d26031b69a6eb605fc86009704d266", height: 0n }],
        },
      },
    };
    const { getLogs } = recordingLogs(() => [spikeLog, republished]);

    const located = await locateSeal(SPIKE_TAGS, {
      rpcUrl: "http://rpc.invalid",
      sender: SPIKE_SENDER,
      chunkBlocks: 1000n,
      maxChunks: 3,
      latestBlock: async () => LATEST,
      getLogs,
    });

    expect(located?.blockNumber).toBe(SPIKE_BLOCK + 5n);
    expect(located?.txSeq).toBe(SPIKE_TXSEQ + 1);
    expect(located?.root).toBe("0x344e131d8a53e14582031c3ee0decf0712d26031b69a6eb605fc86009704d266");
  });
});
