import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Spec §6.3.
 *
 * An EIP-3009 authorization is signed locally, costs no gas, and leaves no trace
 * on chain until someone redeems it. There is no confirmation prompt and no
 * balance alert; a loop with a bug drains the wallet quietly. So the gate runs
 * *before* the signature, and the ledger is written to disk — restarting the
 * process must not hand the caller a fresh hourly allowance.
 */

export interface BudgetLimits {
  /** Atomic units of the payment asset (USDC has 6 decimals). */
  perCallAtomic: bigint;
  perSessionAtomic: bigint;
  perHourAtomic: bigint;
  /** Only these addresses may ever be paid. */
  allowedPayTo: readonly `0x${string}`[];
}

export interface SpendRecord {
  at: number;
  amountAtomic: string;
  payTo: string;
}

export type BudgetDenial =
  | "PAYEE_NOT_ALLOWED"
  | "EXCEEDS_PER_CALL"
  | "EXCEEDS_PER_SESSION"
  | "EXCEEDS_PER_HOUR";

export class BudgetExceededError extends Error {
  constructor(
    readonly denial: BudgetDenial,
    detail: string,
  ) {
    super(`BUDGET_REFUSED: ${denial} (${detail})`);
    this.name = "BudgetExceededError";
  }
}

/** USDC-style decimal string ("0.05") to atomic units. */
export function usdcToAtomic(amount: string): bigint {
  const cleaned = amount.trim().replace(/^\$/, "").replace(/\s*USDC$/i, "");
  const [whole = "0", frac = ""] = cleaned.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error(`bad amount: ${amount}`);
  if (frac.length > 6) throw new Error(`more precision than USDC has: ${amount}`);
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
}

export function atomicToUsdc(atomic: bigint): string {
  const s = atomic.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

export const DEFAULT_LIMITS = {
  perCall: "0.05",
  perSession: "0.20",
  perHour: "2.00",
} as const;

export class BudgetGate {
  private sessionSpentAtomic = 0n;
  private history: SpendRecord[];

  constructor(
    private readonly limits: BudgetLimits,
    private readonly ledgerPath: string,
  ) {
    this.history = this.load();
  }

  private load(): SpendRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.ledgerPath, "utf8"));
      return Array.isArray(parsed) ? (parsed as SpendRecord[]) : [];
    } catch {
      // A corrupt ledger must not read as "nothing spent yet".
      throw new Error(`budget ledger at ${this.ledgerPath} is unreadable; refusing to spend`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    writeFileSync(this.ledgerPath, JSON.stringify(this.history, null, 2));
  }

  spentLastHourAtomic(now: number = Math.floor(Date.now() / 1000)): bigint {
    return this.history
      .filter((r) => now - r.at < 3600)
      .reduce((sum, r) => sum + BigInt(r.amountAtomic), 0n);
  }

  /**
   * Throws unless this payment is allowed. Call before signing, never after.
   */
  assertWithinBudget(
    amountAtomic: bigint,
    payTo: `0x${string}`,
    now: number = Math.floor(Date.now() / 1000),
  ): void {
    const allowed = this.limits.allowedPayTo.some((a) => a.toLowerCase() === payTo.toLowerCase());
    if (!allowed) {
      throw new BudgetExceededError("PAYEE_NOT_ALLOWED", `${payTo} is not on the allowlist`);
    }
    if (amountAtomic > this.limits.perCallAtomic) {
      throw new BudgetExceededError(
        "EXCEEDS_PER_CALL",
        `${atomicToUsdc(amountAtomic)} > ${atomicToUsdc(this.limits.perCallAtomic)}`,
      );
    }
    if (this.sessionSpentAtomic + amountAtomic > this.limits.perSessionAtomic) {
      throw new BudgetExceededError(
        "EXCEEDS_PER_SESSION",
        `${atomicToUsdc(this.sessionSpentAtomic + amountAtomic)} > ${atomicToUsdc(this.limits.perSessionAtomic)}`,
      );
    }
    const hour = this.spentLastHourAtomic(now);
    if (hour + amountAtomic > this.limits.perHourAtomic) {
      throw new BudgetExceededError(
        "EXCEEDS_PER_HOUR",
        `${atomicToUsdc(hour + amountAtomic)} > ${atomicToUsdc(this.limits.perHourAtomic)}`,
      );
    }
  }

  /** Record a payment that was actually signed. */
  record(amountAtomic: bigint, payTo: `0x${string}`, now: number = Math.floor(Date.now() / 1000)): void {
    this.sessionSpentAtomic += amountAtomic;
    this.history.push({ at: now, amountAtomic: amountAtomic.toString(), payTo });
    // Keep the file bounded; anything older than an hour no longer constrains.
    this.history = this.history.filter((r) => now - r.at < 3600);
    this.save();
  }

  summary(now: number = Math.floor(Date.now() / 1000)): string {
    return `session ${atomicToUsdc(this.sessionSpentAtomic)} / ${atomicToUsdc(this.limits.perSessionAtomic)}, hour ${atomicToUsdc(this.spentLastHourAtomic(now))} / ${atomicToUsdc(this.limits.perHourAtomic)} USDC`;
  }
}

export function makeBudgetGate(
  allowedPayTo: readonly `0x${string}`[],
  ledgerPath: string,
  overrides: Partial<Record<"perCall" | "perSession" | "perHour", string>> = {},
): BudgetGate {
  return new BudgetGate(
    {
      perCallAtomic: usdcToAtomic(overrides.perCall ?? DEFAULT_LIMITS.perCall),
      perSessionAtomic: usdcToAtomic(overrides.perSession ?? DEFAULT_LIMITS.perSession),
      perHourAtomic: usdcToAtomic(overrides.perHour ?? DEFAULT_LIMITS.perHour),
      allowedPayTo,
    },
    ledgerPath,
  );
}
