import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "./config.js";
import { registerDescribeAuditor } from "./tools/describe-auditor.js";
import { registerQuoteAudit } from "./tools/quote-audit.js";
import { registerHireAudit } from "./tools/hire-audit.js";
import { registerVerifySeal } from "./tools/verify-seal.js";
import { registerUnderwrite } from "./tools/underwrite.js";
import { registerGetListing } from "./tools/get-listing.js";

/**
 * Six tools that turn any MCP client into Agent A.
 *
 * The names are the contract — a client that learned `verify_seal` on one build
 * must find it on the next — so they are written out here rather than derived
 * from filenames.
 */
export function createServer(config: McpConfig): McpServer {
  const server = new McpServer({ name: "acu", version: "0.1.0" });

  registerDescribeAuditor(server, config);
  registerQuoteAudit(server, config);
  registerHireAudit(server, config);
  registerVerifySeal(server, config);
  registerUnderwrite(server, config);
  registerGetListing(server, config);

  return server;
}
