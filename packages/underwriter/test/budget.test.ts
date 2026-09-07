import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeBudgetGate,
  usdcToAtomic,
  atomicToUsdc,
  BudgetExceededError,
  BudgetGate,
} from "../src/budget.js";

const AGENT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const STRANGER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const NOW = 1_756_000_000;

let dir: string;
let ledger: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budget-"));
  ledger = join(dir, "ledger.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const gate = (over?: Parameters<typeof makeBudgetGate>[2]) => makeBudgetGate([AGENT_B], ledger, over);

describe("amount parsing", () => {
  it("converts USDC decimals to atomic units", () => {
    expect(usdcToAtomic("0.01")).toBe(10_000n);
    expect(usdcToAtomic("$0.05")).toBe(50_000n);
    expect(usdcToAtomic("2.00")).toBe(2_000_000n);
    expect(usdcToAtomic("1")).toBe(1_000_000n);
  });

  it("round-trips", () => {
    expect(atomicToUsdc(usdcToAtomic("0.20"))).toBe("0.200000");
  });

  it("refuses precision USDC cannot represent, rather than truncating it", () => {
    expect(() => usdcToAtomic("0.0000001")).toThrow(/precision/);
  });

  it("refuses garbage", () => {
    expect(() => usdcToAtomic("abc")).toThrow();
  });
});

describe("payee allowlist", () => {
  it("refuses an address that is not Agent B", () => {
    const err = (() => {
      try {
        gate().assertWithinBudget(10_000n, STRANGER, NOW);
      } catch (e) {
        return e as BudgetExceededError;
      }
    })();
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err!.denial).toBe("PAYEE_NOT_ALLOWED");
  });

  it("is case-insensitive about the allowed address", () => {
    expect(() =>
      gate().assertWithinBudget(10_000n, AGENT_B.toUpperCase().replace("0X", "0x") as `0x${string}`, NOW),
    ).not.toThrow();
  });
});

describe("caps", () => {
  it("allows a normal 0.01 call", () => {
    expect(() => gate().assertWithinBudget(usdcToAtomic("0.01"), AGENT_B, NOW)).not.toThrow();
  });

  it("refuses a single call above the per-call cap", () => {
    try {
      gate().assertWithinBudget(usdcToAtomic("0.06"), AGENT_B, NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as BudgetExceededError).denial).toBe("EXCEEDS_PER_CALL");
    }
  });

  it("refuses once the session total would be exceeded", () => {
    const g = gate();
    for (let i = 0; i < 4; i++) {
      g.assertWithinBudget(usdcToAtomic("0.05"), AGENT_B, NOW);
      g.record(usdcToAtomic("0.05"), AGENT_B, NOW);
    }
    // 0.20 spent, session cap is 0.20.
    try {
      g.assertWithinBudget(usdcToAtomic("0.01"), AGENT_B, NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as BudgetExceededError).denial).toBe("EXCEEDS_PER_SESSION");
    }
  });

  it("stops a runaway loop instead of draining the wallet", () => {
    const g = gate();
    let signed = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        g.assertWithinBudget(usdcToAtomic("0.01"), AGENT_B, NOW);
      } catch {
        break;
      }
      g.record(usdcToAtomic("0.01"), AGENT_B, NOW);
      signed++;
    }
    expect(signed).toBe(20); // 0.20 session cap / 0.01
  });
});

describe("hourly cap survives process restart", () => {
  it("does not hand a fresh allowance to a new gate instance", () => {
    const first = gate({ perCall: "0.10", perSession: "10.00" });
    for (let i = 0; i < 20; i++) {
      first.assertWithinBudget(usdcToAtomic("0.10"), AGENT_B, NOW);
      first.record(usdcToAtomic("0.10"), AGENT_B, NOW);
    }
    expect(first.spentLastHourAtomic(NOW)).toBe(usdcToAtomic("2.00"));

    // A crash-and-restart must not reset the hour.
    const restarted = gate({ perCall: "0.10", perSession: "10.00" });
    expect(restarted.spentLastHourAtomic(NOW)).toBe(usdcToAtomic("2.00"));
    try {
      restarted.assertWithinBudget(usdcToAtomic("0.01"), AGENT_B, NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as BudgetExceededError).denial).toBe("EXCEEDS_PER_HOUR");
    }
  });

  it("lets the hourly window roll forward", () => {
    const g = gate({ perCall: "0.10", perSession: "10.00" });
    g.record(usdcToAtomic("2.00"), AGENT_B, NOW);
    const later = gate({ perCall: "0.10", perSession: "10.00" });
    expect(() => later.assertWithinBudget(usdcToAtomic("0.01"), AGENT_B, NOW + 3601)).not.toThrow();
  });

  it("refuses to spend on a corrupt ledger rather than reading it as zero", () => {
    writeFileSync(ledger, "{ this is not json");
    expect(() => gate()).toThrow(/unreadable; refusing to spend/);
  });
});

describe("gate ordering", () => {
  it("checks the payee before the amount, so a bad payee is never merely 'too expensive'", () => {
    try {
      gate().assertWithinBudget(usdcToAtomic("99.00"), STRANGER, NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as BudgetExceededError).denial).toBe("PAYEE_NOT_ALLOWED");
    }
  });

  it("reports what it refused", () => {
    const g = new BudgetGate(
      {
        perCallAtomic: usdcToAtomic("0.05"),
        perSessionAtomic: usdcToAtomic("0.20"),
        perHourAtomic: usdcToAtomic("2.00"),
        allowedPayTo: [AGENT_B],
      },
      ledger,
    );
    expect(g.summary(NOW)).toContain("0.200000");
  });
});
