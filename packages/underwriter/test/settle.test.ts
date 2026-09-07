import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { sealDigest, type SealA } from "@acu/seal";
import { listWithSeal, type SettleOptions } from "../src/settle.js";

/**
 * The receipt is not the truth; the registry's own state is.
 *
 * The live golden-sample run listed CleanUSD successfully and then reported
 * LIST_FAILED, because this testnet's RPC lost the receipt for a transaction it
 * had already mined. These cases pin the rule that replaced it.
 */
const seal = JSON.parse(
  readFileSync(new URL("../../../web/public/examples/example-sealA.json", import.meta.url), "utf8"),
) as SealA;

const SEAL_HASH = sealDigest(seal);
const TOKEN = seal.subject;
const REGISTRY = "0x1111111111111111111111111111111111111111" as const;
const TX = `0x${"ab".repeat(32)}` as const;
const account = privateKeyToAccount(`0x${"00".repeat(31)}01`);

const LISTED = { active: true, ltvBps: 7000, sealHash: SEAL_HASH, expiresAt: 1788845183n };

const lostReceipt = () =>
  new Error(`Transaction receipt with hash "${TX}" could not be found. The Transaction may not be processed on a block yet.`);

function opts(over: Partial<SettleOptions>): SettleOptions {
  return {
    registry: REGISTRY,
    account,
    sendListing: async () => TX,
    ...over,
  } as SettleOptions;
}

describe("listWithSeal", () => {
  it("returns the listing the chain reports when the receipt arrives", async () => {
    let reads = 0;
    const result = await listWithSeal(
      seal,
      TOKEN,
      7000,
      opts({
        waitForReceipt: async () => undefined,
        readListing: async () => {
          reads++;
          return LISTED;
        },
      }),
    );
    expect(result).toEqual({ txHash: TX, listed: LISTED });
    expect(reads).toBe(1);
  });

  it("trusts chain state when the receipt is lost but the seal is on the registry", async () => {
    const result = await listWithSeal(
      seal,
      TOKEN,
      7000,
      opts({
        waitForReceipt: async () => {
          throw lostReceipt();
        },
        readListing: async () => LISTED,
      }),
    );
    expect(result).toEqual({ txHash: TX, listed: LISTED });
  });

  it("still fails when the receipt is lost and the registry holds some other seal", async () => {
    await expect(
      listWithSeal(
        seal,
        TOKEN,
        7000,
        opts({
          waitForReceipt: async () => {
            throw lostReceipt();
          },
          readListing: async () => ({ ...LISTED, sealHash: `0x${"cd".repeat(32)}` as const }),
        }),
      ),
    ).rejects.toThrow(/could not be found/);
  });

  it("still fails when the receipt is lost and nothing is listed at all", async () => {
    await expect(
      listWithSeal(
        seal,
        TOKEN,
        7000,
        opts({
          waitForReceipt: async () => {
            throw lostReceipt();
          },
          readListing: async () => ({ ...LISTED, active: false }),
        }),
      ),
    ).rejects.toThrow(/could not be found/);
  });
});
