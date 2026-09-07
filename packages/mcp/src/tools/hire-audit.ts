import { z } from "zod";
import { Address } from "@0x402/seal";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { NO_KEY_NOTE, isDryRun, readAndHire, textResult } from "./shared.js";
import { fundingRefusal, statusOf } from "./agent-status.js";

/**
 * Pay the auditor and hold its seal to the six checks — and stop there.
 *
 * The seal is returned, not embedded: composing seal A is `underwrite`'s job.
 * Splitting them is the point of a toolkit — an agent that only wants a second
 * opinion should not have to sign an underwriting to get one.
 */
export function registerHireAudit(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "hire_audit",
    {
      description:
        "Pay the auditor over x402 and verify the seal B it returns against the six checks (signature, live agentId, subject, request, expiry, attestation). Returns the verified seal, or a refusal naming the check that failed. Without a key this stops at the quote.",
      inputSchema: {
        token: Address.describe("ERC-20 contract address on 0G testnet."),
        source: z.string().optional().describe("Local Solidity source for the token, if you have it. Never fetched."),
        ltvBps: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .default(7000)
          .describe("The LTV you intend to ask for later. Recorded for the caller; the cap is enforced by underwrite."),
      },
    },
    async ({ token, source, ltvBps }) => {
      // Money first: an x402 authorization is signed locally and only fails at
      // the facilitator, so an unfunded agent would otherwise learn about the
      // faucet from a settlement error.
      const unfunded = await fundingRefusal(config, await statusOf(config));
      if (unfunded !== null) return textResult({ ...unfunded, requestedLtvBps: ltvBps });

      const result = await readAndHire(config, { token, source });
      const note = isDryRun(config) ? { note: NO_KEY_NOTE } : {};
      return textResult({ ...result, requestedLtvBps: ltvBps, ...note });
    },
  );
}
