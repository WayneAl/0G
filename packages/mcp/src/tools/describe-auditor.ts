import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { detailOf, textResult } from "./shared.js";

/**
 * "Who is this agent and what does it charge?" — the free question you ask
 * before the paid one.
 *
 * The card is served at `/agent` on the auditor's origin, so the audit path is
 * dropped rather than appended to. Nothing here is trusted: the card names a
 * price and an agentId, and both are re-checked when a seal comes back.
 */
export function registerDescribeAuditor(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "describe_auditor",
    {
      description:
        "Fetch an auditor's agent card (GET /agent on its origin): who it claims to be, what it charges, and on which network. Free, unauthenticated, and never trusted — the seal it returns later is what gets verified.",
      inputSchema: {
        url: z
          .string()
          .url()
          .optional()
          .describe("Auditor endpoint; the card is read from /agent on its origin. Defaults to ACU_AUDITOR_URL."),
      },
    },
    async ({ url }) => {
      const target = new URL("/agent", url ?? config.auditorUrl).toString();
      let res: Response;
      try {
        res = await fetch(target);
      } catch (err) {
        // A refused connection and a 500 are the same fact to the caller: there
        // is no auditor there. Both surface the same code.
        return textResult({ ok: false, code: "AUDITOR_UNREACHABLE", url: target, detail: detailOf(err) }, true);
      }
      if (!res.ok) {
        return textResult(
          {
            ok: false,
            code: `AUDITOR_UNREACHABLE: ${res.status}`,
            url: target,
            detail: (await res.text()).slice(0, 300),
          },
          true,
        );
      }
      return textResult({ ok: true, url: target, card: await res.json() });
    },
  );
}
