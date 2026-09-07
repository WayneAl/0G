import { privateKeyToAccount } from "viem/accounts";
import { agentStatus, type AgentStatus } from "@acu/underwriter";
import { configPath } from "@acu/config";
import type { Io } from "../index.js";
import { resolveCliConfig } from "./underwrite.js";

/**
 * `acu status` — "can this agent do the job right now, and if not, what next?"
 *
 * The answer comes from `agentStatus()` in `@acu/underwriter`, which is the same
 * call behind the MCP's `agent_status`. This file only decides how it looks.
 */
export async function status(argv: string[], io: Io): Promise<number> {
  const config = resolveCliConfig(io.env);
  const address = config.agentKey === null ? null : privateKeyToAccount(config.agentKey).address;

  const report = await agentStatus({
    agentId: config.agentId,
    address,
    auditor: { url: config.auditorUrl, agentId: config.auditorAgentId },
    ledgerPath: config.ledgerPath,
    directoryUrl: config.directoryUrl,
    usdc: config.usdc,
    paymentRpcUrl: config.paymentRpcUrl,
    faucetUrl: config.faucetUrl,
  });

  if (argv.includes("--json")) {
    io.out(JSON.stringify(report, null, 2));
    return 0;
  }

  for (const [label, value] of rows(report, io)) io.out(`${label.padEnd(15)}${value}`);
  io.out("");
  // The whole point of the command. Last, and on its own.
  io.out(`→ ${report.nextStep}`);
  return 0;
}

function rows(report: AgentStatus, io: Io): [string, string][] {
  const usdc =
    report.usdc.error !== null
      ? report.usdc.error
      : report.usdc.balance === null
        ? "— (no key yet)"
        : `${report.usdc.balance} USDC on Base Sepolia`;

  return [
    ["agent", report.hasKey ? `${report.address}  (id ${report.agentId})` : "no key yet"],
    ["config", configPath(io.env)],
    ["usdc", usdc],
    ["faucet", report.usdc.faucetUrl],
    [
      "auditor",
      `${report.auditor.url}  ${
        report.auditor.online
          ? `online${report.auditor.price === null ? "" : ` · ${report.auditor.price}`}`
          : // "OFFLINE" on its own is unactionable; the probe's reason says whether
            // the host refused, timed out, or answered with something that is not a card.
            `OFFLINE${report.auditor.error === null ? "" : ` · ${report.auditor.error}`}`
      }`,
    ],
    ["directory", report.directoryUrl ?? "—"],
    [
      "budget",
      `${report.budget.remainingSession} left this session, ${report.budget.remainingHour} this hour`,
    ],
    ["ledger", report.budget.ledgerPath],
  ];
}
