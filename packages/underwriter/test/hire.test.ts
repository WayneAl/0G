import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { AuditRequestPayload } from "@0x402/seal";
import { makeBudgetGate } from "../src/budget.js";
import { getQuote, hireAuditor, type HireOptions } from "../src/hire.js";

/**
 * The ledger's whole job is to survive the ways a paid call goes wrong, so these
 * drive `hireAuditor` against a fetch that answers 402 once and then dies —
 * which is what a reset connection, a DNS failure and a timeout all look like
 * from here.
 */
const ENDPOINT = "http://localhost:4021/audit";
const PAYTO = "0x1111111111111111111111111111111111111111" as const;
const PRICE_ATOMIC = 10_000n;

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

const request: AuditRequestPayload = {
  token: "0xDB08Ce217Ce842b06baf76a0Bbb2C10f47fF9eB8",
  artifact: "contract CleanUSD {}",
  requestedAt: 1_788_000_000,
  nonce: "abc",
};

const CHALLENGE = encodePaymentRequiredHeader({
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: PRICE_ATOMIC.toString(),
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: PAYTO,
      resource: ENDPOINT,
      description: "audit",
      mimeType: "application/json",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
  error: null,
} as never);

/** 402 with a real challenge on the first call; whatever `then` says after that. */
function fetchThat(then: () => Promise<Response>): typeof fetch {
  let calls = 0;
  return (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": CHALLENGE } });
    }
    return then();
  }) as unknown as typeof fetch;
}

let dir: string;
let realFetch: typeof fetch;
const options = (over: Partial<HireOptions> = {}): HireOptions => ({
  endpoint: ENDPOINT,
  account,
  network: "eip155:84532",
  budget: makeBudgetGate([PAYTO], join(dir, "ledger.json")),
  dryRun: false,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acu-hire-"));
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("getQuote", () => {
  it("reads the price and payee out of the 402 without paying anything", async () => {
    globalThis.fetch = fetchThat(async () => new Response(null, { status: 500 }));

    const quote = await getQuote(options(), request);

    expect(quote.amountAtomic).toBe(PRICE_ATOMIC);
    expect(quote.payTo).toBe(PAYTO.toLowerCase());
    expect(quote.humanPrice).toBe("0.010000 USDC");
  });

  it("names an endpoint that answers something other than 402", async () => {
    globalThis.fetch = (async () => new Response("hello", { status: 200 })) as unknown as typeof fetch;

    await expect(getQuote(options(), request)).rejects.toThrow(/NO_PAYMENT_CHALLENGE/);
  });
});

describe("hireAuditor", () => {
  it("records the spend even when the paid request never comes back", async () => {
    // The authorization is signed and handed over inside the paid call, so a
    // call that throws may still have settled. Recording only on the way out
    // would let a retry loop against a flaky auditor re-authorize forever
    // without ever approaching the per-hour cap.
    globalThis.fetch = fetchThat(async () => {
      throw new Error("socket hang up");
    });
    const opts = options();

    await expect(hireAuditor(opts, request)).rejects.toThrow();

    expect(opts.budget.spentLastHourAtomic()).toBe(PRICE_ATOMIC);
  });

  it("records the spend when the auditor answers the paid request with an error", async () => {
    globalThis.fetch = fetchThat(async () => new Response("boom", { status: 500 }));
    const opts = options();

    await expect(hireAuditor(opts, request)).rejects.toThrow();

    expect(opts.budget.spentLastHourAtomic()).toBe(PRICE_ATOMIC);
  });

  it("records nothing for a dry run, which stops at the quote", async () => {
    globalThis.fetch = fetchThat(async () => {
      throw new Error("a dry run must never reach this");
    });
    const opts = options({ dryRun: true });

    const result = await hireAuditor(opts, request);

    expect(result).toMatchObject({ dryRun: true });
    expect(opts.budget.spentLastHourAtomic()).toBe(0n);
  });

  it("refuses a payee the allowlist does not name, before anything is recorded", async () => {
    globalThis.fetch = fetchThat(async () => {
      throw new Error("nothing may be paid to an address we did not allow");
    });
    const opts = options({
      budget: makeBudgetGate(["0x2222222222222222222222222222222222222222"], join(dir, "ledger.json")),
    });

    await expect(hireAuditor(opts, request)).rejects.toThrow(/PAYEE_NOT_ALLOWED/);

    expect(opts.budget.spentLastHourAtomic()).toBe(0n);
  });
});
