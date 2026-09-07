import { createPublicClient, http, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { DEFAULT_LIMITS, atomicToUsdc, makeBudgetGate, usdcToAtomic } from "./budget.js";

/**
 * "Can this agent actually do the job right now, and if not, what is the one
 * thing to do next?" — asked once, answered the same way for every shell.
 *
 * `acu status` prints this and the MCP's `agent_status` returns it as JSON. One
 * implementation because two would drift, and the moment they drift a newcomer
 * gets two different next steps from the same machine.
 *
 * Nothing here ever sees a private key: `address` comes in already derived, so a
 * status payload can be printed, logged or pasted into an issue safely.
 */

/** Base Sepolia USDC — the asset x402 settles in for the reference pair. */
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const CIRCLE_FAUCET = "https://faucet.circle.com" as const;
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org" as const;
/** CleanUSD on 0G testnet: the token the "Ready" line tells you to try. */
export const DEMO_TOKEN = "0xDB08Ce217Ce842b06baf76a0Bbb2C10f47fF9eB8" as const;
/** What the reference auditor charges, used when its card does not say. */
export const ASSUMED_PRICE = "$0.01" as const;

const BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface UsdcReadOptions {
  usdc?: `0x${string}`;
  rpcUrl?: string;
  /** Injected in tests; the default is a real client against `rpcUrl`. */
  client?: PublicClient;
}

/**
 * `balanceOf(payer)` on the payment chain.
 *
 * Throws on a transport failure instead of returning `0n`. A zero that means "I
 * could not ask" is the worst possible answer here: it sends someone to the
 * faucet for money they already have, and it hides the broken RPC that will
 * break the payment two steps later.
 */
export async function usdcBalance(opts: UsdcReadOptions, payer: `0x${string}`): Promise<bigint> {
  const client =
    opts.client ??
    (createPublicClient({ chain: baseSepolia, transport: http(opts.rpcUrl ?? BASE_SEPOLIA_RPC) }) as PublicClient);
  try {
    return (await client.readContract({
      address: opts.usdc ?? BASE_SEPOLIA_USDC,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [payer],
    })) as bigint;
  } catch (err) {
    throw new Error(
      `USDC_RPC_UNREACHABLE: could not read USDC balance for ${payer} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The literal instruction for an agent that has a key but nothing to pay with. */
export function fundingHint(
  payer: `0x${string}`,
  needAtomic: bigint,
  haveAtomic: bigint,
  faucetUrl: string = CIRCLE_FAUCET,
): string {
  return (
    `Fund ${payer} with Base Sepolia USDC at ${faucetUrl} ` +
    `(choose Base Sepolia, paste the address). ` +
    `Need ${atomicToUsdc(needAtomic)}, have ${atomicToUsdc(haveAtomic)}.`
  );
}

export interface AgentStatus {
  agentId: string;
  address: `0x${string}` | null;
  hasKey: boolean;
  usdc: { balance: string | null; faucetUrl: string; error: string | null };
  budget: { remainingSession: string; remainingHour: string; ledgerPath: string };
  auditor: { url: string; agentId: string; online: boolean; price: string | null; card: unknown | null };
  directoryUrl: string | null;
  nextStep: string;
}

export interface AgentStatusDeps {
  agentId: string;
  /** The agent's address, or null when no key is configured. Never the key. */
  address: `0x${string}` | null;
  auditor: { url: string; agentId: string };
  ledgerPath: string;
  directoryUrl?: string | null;
  usdc?: `0x${string}`;
  paymentRpcUrl?: string;
  faucetUrl?: string;
  // Seams, so a status can be asked for without opening a socket.
  usdcClient?: PublicClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The four states, in the order they are asked about.
 *
 * The order is the point: no key beats an offline auditor beats an empty
 * wallet. Telling someone to visit a faucet when they have not got an address
 * yet, or to fund a wallet for an auditor that is not answering, is how a funnel
 * loses people.
 */
export async function agentStatus(deps: AgentStatusDeps): Promise<AgentStatus> {
  const faucetUrl = deps.faucetUrl ?? CIRCLE_FAUCET;
  const card = await auditorCard(deps);

  let balance: bigint | null = null;
  let usdcError: string | null = null;
  if (deps.address !== null) {
    try {
      balance = await usdcBalance(
        {
          ...(deps.usdc === undefined ? {} : { usdc: deps.usdc }),
          ...(deps.paymentRpcUrl === undefined ? {} : { rpcUrl: deps.paymentRpcUrl }),
          ...(deps.usdcClient === undefined ? {} : { client: deps.usdcClient }),
        },
        deps.address,
      );
    } catch (err) {
      // Surfaced, never swallowed: the caller shows this line next to the balance.
      usdcError = err instanceof Error ? err.message : String(err);
    }
  }

  const price = typeof card?.["price"] === "string" ? (card["price"] as string) : null;
  const needAtomic = usdcToAtomic(price ?? ASSUMED_PRICE);

  return {
    agentId: deps.agentId,
    address: deps.address,
    hasKey: deps.address !== null,
    usdc: { balance: balance === null ? null : atomicToUsdc(balance), faucetUrl, error: usdcError },
    budget: budgetLeft(deps.ledgerPath, deps.now?.()),
    auditor: {
      url: deps.auditor.url,
      agentId: deps.auditor.agentId,
      online: card !== null,
      price,
      card,
    },
    directoryUrl: deps.directoryUrl ?? null,
    nextStep:
      deps.address === null
        ? "Run: npx @acu/cli init"
        : card === null
          ? "Reference auditor is offline — try again later, or point at another one with ACU_AUDITOR_URL"
          : balance !== null && balance < needAtomic
            ? fundingHint(deps.address, needAtomic, balance, faucetUrl)
            : `Ready: acu underwrite ${DEMO_TOKEN}`,
  };
}

/**
 * `GET /agent` on the auditor's origin — the free card that says who you would
 * be hiring. Any failure means "offline"; it is never an exception, because
 * "the other agent is not up" is the most ordinary answer this can have.
 */
async function auditorCard(deps: AgentStatusDeps): Promise<Record<string, unknown> | null> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(new URL("/agent", deps.auditor.url));
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    // Deliberate: an unreachable auditor is reported through `online: false` and
    // the next step above, both of which say so out loud.
    return null;
  }
}

/**
 * What the budget gate would still allow. The gate is built fresh, exactly as
 * every tool call and every CLI run builds it, so this reports the same session
 * allowance those will actually get.
 */
function budgetLeft(
  ledgerPath: string,
  now?: number,
): { remainingSession: string; remainingHour: string; ledgerPath: string } {
  const gate = makeBudgetGate([], ledgerPath);
  const spentHour = now === undefined ? gate.spentLastHourAtomic() : gate.spentLastHourAtomic(now);
  const perHour = usdcToAtomic(DEFAULT_LIMITS.perHour);
  return {
    remainingSession: atomicToUsdc(usdcToAtomic(DEFAULT_LIMITS.perSession)),
    remainingHour: atomicToUsdc(spentHour > perHour ? 0n : perHour - spentHour),
    ledgerPath,
  };
}
