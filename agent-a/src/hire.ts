import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import type { PrivateKeyAccount } from "viem";
import type { AuditRequestPayload } from "@acu/seal";
import { atomicToUsdc, type BudgetGate } from "./budget.js";

export interface Quote {
  requirements: PaymentRequirements;
  amountAtomic: bigint;
  payTo: `0x${string}`;
  humanPrice: string;
}

export interface HireResult {
  quote: Quote;
  audit: {
    action: string;
    maxLtvBps: number;
    findings: string[];
    reasoning: string;
    costNeuron: string | null;
  };
  sealB: unknown;
  /** Base Sepolia settlement tx, when the facilitator reports one. */
  settlementTx: `0x${string}` | null;
}

export interface HireOptions {
  endpoint: string;
  /** Narrower than viem's Account union: x402's ClientEvmSigner needs the
   *  signing methods present, not merely optional. */
  account: PrivateKeyAccount;
  network: `${string}:${string}`;
  budget: BudgetGate;
  /** Default true. A real payment requires passing false explicitly (spec §6.4). */
  dryRun: boolean;
}

export class HireError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "HireError";
  }
}

/**
 * Asks Agent B what the job costs, without paying.
 *
 * The unpaid probe exists so the budget gate and the dry-run can both act on a
 * real quote. Letting the x402 client transparently pay on the first 402 would
 * mean the signature happens before anything got to say no.
 */
export async function getQuote(opts: HireOptions, request: AuditRequestPayload): Promise<Quote> {
  const res = await fetch(opts.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (res.status !== 402) {
    throw new HireError(
      "NO_PAYMENT_CHALLENGE",
      `expected 402 from ${opts.endpoint}, got ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }

  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new HireError("NO_PAYMENT_REQUIRED_HEADER", "402 carried no PAYMENT-REQUIRED header");

  const required = decodePaymentRequiredHeader(header);
  const match = required.accepts.find((a) => a.network === opts.network);
  if (!match) {
    throw new HireError(
      "NO_ACCEPTABLE_SCHEME",
      `agent B accepts ${required.accepts.map((a) => a.network).join(", ")}, we pay on ${opts.network}`,
    );
  }

  return {
    requirements: match,
    amountAtomic: BigInt(match.amount),
    payTo: match.payTo.toLowerCase() as `0x${string}`,
    humanPrice: `${atomicToUsdc(BigInt(match.amount))} USDC`,
  };
}

/**
 * Pays Agent B and collects seal B.
 *
 * Order matters: quote, then budget gate, then signature. Nothing signs until
 * the gate has passed, because an EIP-3009 authorization is irrevocable the
 * moment it leaves this process.
 */
export async function hireAuditor(
  opts: HireOptions,
  request: AuditRequestPayload,
): Promise<HireResult | { quote: Quote; dryRun: true }> {
  const quote = await getQuote(opts, request);

  // Throws before any key is touched.
  opts.budget.assertWithinBudget(quote.amountAtomic, quote.payTo);

  if (opts.dryRun) return { quote, dryRun: true };

  const client = new x402Client().register(opts.network, new ExactEvmScheme(opts.account));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const res = await fetchWithPay(opts.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  // Recorded even on a non-2xx: the authorization was signed and handed over,
  // so it counts against the budget whether or not we got value for it.
  opts.budget.record(quote.amountAtomic, quote.payTo);

  if (!res.ok) {
    throw new HireError("AUDIT_REQUEST_FAILED", `${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as { audit: HireResult["audit"]; sealB: unknown };

  let settlementTx: `0x${string}` | null = null;
  const paymentResponse = res.headers.get("PAYMENT-RESPONSE");
  if (paymentResponse) {
    try {
      const settle = decodePaymentResponseHeader(paymentResponse);
      const tx = (settle as { transaction?: string }).transaction;
      if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
        settlementTx = tx.toLowerCase() as `0x${string}`;
      }
    } catch {
      // A seal that cannot name its settlement is still a valid seal; the
      // delegation just records null rather than a fabricated hash.
    }
  }

  return { quote, audit: body.audit, sealB: body.sealB, settlementTx };
}
