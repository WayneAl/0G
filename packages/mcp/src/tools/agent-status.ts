import { privateKeyToAccount } from "viem/accounts";
import { ASSUMED_PRICE, agentStatus, usdcToAtomic, type AgentStatus } from "@0x402/underwriter";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { textResult, type Refusal } from "./shared.js";

/**
 * "Can this agent do the job right now, and if not, what next?"
 *
 * A renderer, nothing more: the answer is `agentStatus()` from
 * `@0x402/underwriter`, which is the same call behind `acu status`. Two
 * implementations would drift, and the moment they drift the same machine gives
 * an agent and its owner two different next steps.
 *
 * Never `isError`: "you have no key yet" is the most ordinary state a first-run
 * user can be in, and it is an answer, not a fault.
 */
export function registerAgentStatus(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "agent_status",
    {
      description:
        "Report whether this agent can underwrite right now: key, USDC balance on the payment chain, whether the auditor is answering, what the budget has left, and the single next step to take. Call this first, and whenever a paid tool refuses.",
      inputSchema: {},
    },
    async () => textResult(await statusOf(config)),
  );
}

/** The one call, with this server's configuration poured into it. */
export function statusOf(config: McpConfig): Promise<AgentStatus> {
  return agentStatus({
    agentId: config.agentId,
    // Derived here and never carried: a status payload is safe to print.
    address: config.agentKey === null ? null : privateKeyToAccount(config.agentKey).address,
    auditor: { url: config.auditorUrl, agentId: config.auditorAgentId },
    ledgerPath: config.ledgerPath,
    directoryUrl: config.directoryUrl,
    usdc: config.usdc,
    paymentRpcUrl: config.paymentRpcUrl,
    faucetUrl: config.faucetUrl,
  });
}

/**
 * The check a paid tool runs before it tries to pay: is there actually money?
 *
 * An x402 authorization is signed locally and fails at the facilitator, so
 * without this the newcomer's first paid call dies somewhere in a settlement
 * error instead of saying "go to the faucet". The amount compared against is the
 * auditor's own advertised price — the quote itself is decided inside
 * `hireAndVerify`, past the point this layer can interpose, and no honest B
 * quotes below its card.
 *
 * A payment RPC that will not answer is its own refusal, never a "proceed
 * anyway": a balance nobody could read is not a balance.
 */
export async function fundingRefusal(config: McpConfig, status: AgentStatus): Promise<Refusal | null> {
  // Nothing to spend and nothing to spend it with: the dry-run path pays for
  // nothing, and its own note already says what to do about that.
  if (config.agentKey === null) return null;

  if (status.usdc.error !== null) {
    return { ok: false, stage: "hire", code: "USDC_RPC_UNREACHABLE", detail: status.usdc.error };
  }
  // An auditor that is not answering is the run's own refusal to name, with the
  // endpoint in it; money is not the problem yet.
  if (!status.auditor.online || status.usdc.balance === null) return null;

  const need = usdcToAtomic(status.auditor.price ?? ASSUMED_PRICE);
  if (usdcToAtomic(status.usdc.balance) >= need) return null;
  return { ok: false, stage: "hire", code: "INSUFFICIENT_USDC", detail: status.nextStep };
}
