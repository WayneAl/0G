import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASE_SEPOLIA_USDC,
  CIRCLE_FAUCET,
  DEMO_TOKEN,
  agentStatus,
  fundingHint,
  usdcBalance,
  type AgentStatusDeps,
} from "../src/status.js";

const PAYER = "0x6ddF162A95123AaD1355E5D2FB66C2B1015Adc41" as const;
const LEDGER = (): string => join(mkdtempSync(join(tmpdir(), "acu-status-")), "budget-ledger.json");

/** A viem-shaped read seam: only `readContract` is ever reached. */
const clientReturning = (value: bigint): never =>
  ({ readContract: async () => value }) as never;
const clientThrowing = (): never =>
  ({
    readContract: async () => {
      throw new Error("fetch failed");
    },
  }) as never;

const CARD = { agentId: "2", price: "$0.01", sealSigner: PAYER, service: "code-audit" };

const cardServer = (card: unknown = CARD, ok = true): typeof fetch =>
  (async () =>
    ({
      ok,
      status: ok ? 200 : 503,
      json: async () => card,
    })) as unknown as typeof fetch;

const noServer = (): typeof fetch =>
  (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:4021");
  }) as unknown as typeof fetch;

const deps = (over: Partial<AgentStatusDeps> = {}): AgentStatusDeps => ({
  agentId: "1",
  address: PAYER,
  auditor: { url: "http://localhost:4021/audit", agentId: "2" },
  ledgerPath: LEDGER(),
  directoryUrl: null,
  fetchImpl: cardServer(),
  usdcClient: clientReturning(1_000_000n),
  ...over,
});

describe("fundingHint", () => {
  it("names the address, the faucet and the network to pick there", () => {
    const hint = fundingHint(PAYER, 10_000n, 0n);
    expect(hint).toContain(PAYER);
    expect(hint).toContain(CIRCLE_FAUCET);
    expect(hint).toContain("Base Sepolia");
    expect(hint).toContain("0.010000");
  });

  it("takes a different faucet when one is configured", () => {
    expect(fundingHint(PAYER, 10_000n, 0n, "https://example.test/faucet")).toContain(
      "https://example.test/faucet",
    );
  });
});

describe("usdcBalance", () => {
  it("returns what the chain says, zero included", async () => {
    expect(await usdcBalance({ client: clientReturning(0n) }, PAYER)).toBe(0n);
    expect(await usdcBalance({ client: clientReturning(2_500_000n) }, PAYER)).toBe(2_500_000n);
  });

  it("defaults to Base Sepolia USDC", () => {
    expect(BASE_SEPOLIA_USDC).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("raises USDC_RPC_UNREACHABLE rather than reporting an unread balance as zero", async () => {
    // Reporting 0 for a read that never happened sends someone to the faucet
    // for money they already have, and hides a broken RPC.
    await expect(usdcBalance({ client: clientThrowing() }, PAYER)).rejects.toThrow(
      /^USDC_RPC_UNREACHABLE: /,
    );
  });
});

describe("agentStatus — the one next step", () => {
  it("asks for a key first, whatever else is wrong", async () => {
    // No key AND an auditor that is down AND no balance: the key still wins.
    const status = await agentStatus(
      deps({ address: null, fetchImpl: noServer(), usdcClient: clientReturning(0n) }),
    );
    expect(status.hasKey).toBe(false);
    expect(status.nextStep).toBe("Run: npx @0x402/cli init");
    expect(status.usdc.balance).toBeNull();
  });

  it("says the auditor is offline before it talks about money", async () => {
    const status = await agentStatus(deps({ fetchImpl: noServer(), usdcClient: clientReturning(0n) }));
    expect(status.auditor.online).toBe(false);
    expect(status.nextStep).toBe(
      "Reference auditor is offline — try again later, or point at another one with ACU_AUDITOR_URL",
    );
  });

  it("sends an empty wallet to the faucet, naming the address and the amount", async () => {
    const status = await agentStatus(deps({ usdcClient: clientReturning(0n) }));
    expect(status.auditor.online).toBe(true);
    expect(status.auditor.price).toBe("$0.01");
    expect(status.usdc.balance).toBe("0.000000");
    expect(status.nextStep).toBe(fundingHint(PAYER, 10_000n, 0n));
  });

  it("treats an unpriced auditor as costing a cent", async () => {
    const status = await agentStatus(
      deps({ fetchImpl: cardServer({ agentId: "2" }), usdcClient: clientReturning(9_999n) }),
    );
    expect(status.auditor.price).toBeNull();
    expect(status.nextStep).toBe(fundingHint(PAYER, 10_000n, 9_999n));
  });

  it("is ready once the key is there, the auditor answers and the balance covers the price", async () => {
    const status = await agentStatus(deps());
    expect(status.nextStep).toBe(`Ready: acu underwrite ${DEMO_TOKEN}`);
    expect(status.usdc.balance).toBe("1.000000");
    expect(status.usdc.error).toBeNull();
  });

  it("reports what the budget has left, and where the ledger lives", async () => {
    const ledgerPath = LEDGER();
    const status = await agentStatus(deps({ ledgerPath }));
    expect(status.budget).toEqual({
      remainingSession: "0.200000",
      remainingHour: "2.000000",
      ledgerPath,
    });
  });

  it("surfaces a dead payment RPC instead of swallowing it", async () => {
    const status = await agentStatus(deps({ usdcClient: clientThrowing() }));
    expect(status.usdc.balance).toBeNull();
    expect(status.usdc.error).toMatch(/^USDC_RPC_UNREACHABLE: /);
  });

  it("still asks for a key, and still reports the auditor, before it mentions the RPC", async () => {
    const noKey = await agentStatus(deps({ address: null, usdcClient: clientThrowing() }));
    expect(noKey.nextStep).toBe("Run: npx @0x402/cli init");
    const offline = await agentStatus(deps({ fetchImpl: noServer(), usdcClient: clientThrowing() }));
    expect(offline.nextStep).toContain("Reference auditor is offline");
  });

  it("never carries the private key, only the address", async () => {
    const status = await agentStatus(deps());
    // Nothing 32 bytes wide anywhere in the payload: a status is safe to print,
    // log, or paste into an issue.
    expect(JSON.stringify(status)).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(status.address).toBe(PAYER);
  });

  it("gives up on an auditor that will not answer, and says why", async () => {
    // A host that drops packets — a stale tunnel URL, once the reference B has
    // moved — must not hold `acu status` open on the OS connect timeout.
    let signalled: AbortSignal | undefined;
    const hangs = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      signalled = init?.signal;
      return Promise.reject(new Error("The operation was aborted due to timeout"));
    }) as unknown as typeof fetch;

    const status = await agentStatus(deps({ fetchImpl: hangs }));
    expect(signalled, "the probe must carry an abort signal").toBeInstanceOf(AbortSignal);
    expect(status.auditor.online).toBe(false);
    expect(status.auditor.error).toContain("timeout");
  });

  it("leaves auditor.error null when the auditor answered", async () => {
    expect((await agentStatus(deps())).auditor.error).toBeNull();
  });

  it("does not say Ready when the balance could not be read", async () => {
    const status = await agentStatus(deps({ usdcClient: clientThrowing() }));
    expect(status.usdc.error).toMatch(/^USDC_RPC_UNREACHABLE: /);
    expect(status.nextStep).toBe(
      "Check: your payment RPC is not answering — set ACU_PAYMENT_RPC_URL or try again",
    );
  });

  it("counts a non-2xx agent card as offline", async () => {
    const status = await agentStatus(deps({ fetchImpl: cardServer(CARD, false) }));
    expect(status.auditor.online).toBe(false);
    expect(status.auditor.card).toBeNull();
  });
});
