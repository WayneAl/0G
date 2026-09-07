import { z } from "zod";
import { Address } from "@acu/seal";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { readAndHire, textResult } from "./shared.js";

/**
 * What the audit would cost, and whether the budget would allow it — without
 * signing anything, ever.
 *
 * Always a dry run, whatever key this process holds. An x402 client that pays
 * transparently on the first 402 would have signed before anyone got to say no;
 * the unpaid probe exists so the budget gate can answer first.
 */
export function registerQuoteAudit(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "quote_audit",
    {
      description:
        "Price a code audit for an ERC-20 on 0G testnet: reads the token's bytecode over RPC (free), asks the auditor for a 402 quote, and runs it past the budget gate. Never pays and never signs — use hire_audit or underwrite to act on the quote.",
      inputSchema: {
        token: Address.describe("ERC-20 contract address on 0G testnet."),
        source: z.string().optional().describe("Local Solidity source for the token, if you have it. Never fetched."),
      },
    },
    async ({ token, source }) => {
      const result = await readAndHire(config, { token, source }, { dryRun: true });
      if (!result.ok) return textResult(result);
      if (result.kind !== "dry-run") return textResult(result);
      return textResult({ ok: true, quote: result.quote, budget: result.budget });
    },
  );
}
