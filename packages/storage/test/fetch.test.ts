import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize, sealDigest } from "@0x402/seal";
import { fetchSealBytes, resolveSeal, SealNotFoundError } from "../src/fetch.js";
import type { LocateOptions, SubmitLog } from "../src/locate.js";

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/** A real seal A, signed by the reference agent — the same one the verifier ships. */
const exampleSealA = JSON.parse(repoFile("web/public/examples/example-sealA.json")) as Record<string, unknown>;
/** A real seal too, just not the one anybody asked for. */
const otherSeal = (JSON.parse(repoFile("web/public/examples/examples.json")) as Record<string, unknown>)[
  "tampered"
] as Record<string, unknown>;

const SPIKE_ROOT = "0xec5a33d2e244bba38ff92353534f39333b7c70302bafe1e64d7a1a2a8cd8a42f" as const;
const SPIKE_TX = "0xa1ac7763ab26db8a98f98e4bfa67a5189bee6c2c2397575b22244f91bb741b75" as const;
const SPIKE_SENDER = "0x6ddF162A95123AaD1355E5D2FB66C2B1015Adc41" as const;
const INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";

function serving(body: string, status = 200): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (async (input: unknown) => {
      urls.push(String(input));
      return new Response(body, { status });
    }) as typeof fetch,
  };
}

/** A Flow.Submit that tags `sealHash` and resolves to the spike root. */
function locating(sealHash: `0x${string}`): NonNullable<LocateOptions["getLogs"]> {
  const log: SubmitLog = {
    blockNumber: 53526025n,
    transactionHash: SPIKE_TX,
    args: {
      submissionIndex: 149629n,
      submission: { tags: sealHash, nodes: [{ root: SPIKE_ROOT, height: 0n }] },
    },
  };
  return async () => [log];
}

function options(sealHash: `0x${string}`, body: string, status = 200) {
  const served = serving(body, status);
  return {
    served,
    opts: {
      rpcUrl: "http://rpc.invalid",
      sender: SPIKE_SENDER,
      indexerUrl: INDEXER,
      chunkBlocks: 1000n,
      maxChunks: 2,
      latestBlock: async () => 53526210n,
      getLogs: locating(sealHash),
      fetch: served.fetch,
    },
  };
}

describe("fetchSealBytes", () => {
  it("asks the indexer gateway for the root and hands back the bytes", async () => {
    const served = serving("the seal body");
    const bytes = await fetchSealBytes(SPIKE_ROOT, { indexerUrl: INDEXER, fetch: served.fetch });

    expect(new TextDecoder().decode(bytes)).toBe("the seal body");
    expect(served.urls).toEqual([`${INDEXER}/file?root=${SPIKE_ROOT}`]);
  });

  it("surfaces the gateway's status code rather than an empty body", async () => {
    const served = serving("upstream is down", 503);
    await expect(
      fetchSealBytes(SPIKE_ROOT, { indexerUrl: INDEXER, fetch: served.fetch }),
    ).rejects.toThrow(/^OG_GATEWAY_503/);
  });
});

describe("resolveSeal", () => {
  it("returns the seal the hash names, and where it was found", async () => {
    const sealHash = sealDigest(exampleSealA);
    const { opts } = options(sealHash, canonicalize(exampleSealA));

    const { seal, located } = await resolveSeal(sealHash, opts);

    expect(seal).toEqual(exampleSealA);
    expect(located).toEqual({
      root: SPIKE_ROOT,
      txHash: SPIKE_TX,
      txSeq: 149629,
      blockNumber: 53526025n,
    });
  });

  it("refuses a body that is some other seal", async () => {
    const sealHash = sealDigest(exampleSealA);
    const { opts } = options(sealHash, canonicalize(otherSeal));

    await expect(resolveSeal(sealHash, opts)).rejects.toMatchObject({
      name: "SealNotFoundError",
      reason: "DIGEST_MISMATCH",
    });
  });

  it("refuses the gateway's 200-with-an-error-body for an unknown root", async () => {
    // The gateway answers 200 and a JSON error for a root it does not have. It
    // parses; it is simply not the seal, and the digest is what says so.
    const sealHash = sealDigest(exampleSealA);
    const { opts } = options(sealHash, '{"code":101,"message":"file not found"}');

    const err = await resolveSeal(sealHash, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SealNotFoundError);
    expect((err as SealNotFoundError).reason).toBe("DIGEST_MISMATCH");
  });

  it("refuses a body that is not JSON at all", async () => {
    const sealHash = sealDigest(exampleSealA);
    const { opts } = options(sealHash, "<html>502 Bad Gateway</html>");

    const err = await resolveSeal(sealHash, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SealNotFoundError);
    expect((err as SealNotFoundError).reason).toBe("BAD_JSON");
  });

  it("says NO_SUBMISSION when the chain never saw this seal", async () => {
    const sealHash = sealDigest(exampleSealA);
    const { opts } = options(sealHash, canonicalize(exampleSealA));

    const err = await resolveSeal(sealHash, { ...opts, getLogs: async () => [] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SealNotFoundError);
    expect((err as SealNotFoundError).reason).toBe("NO_SUBMISSION");
  });
});
