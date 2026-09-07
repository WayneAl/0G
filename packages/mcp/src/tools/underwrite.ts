import { z } from "zod";
import { Address, type SealA } from "@acu/seal";
import { underwrite, type Stage, type UnderwriteResult } from "@acu/underwriter";
import { ogStoragePublisher } from "@acu/storage/publish";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { NO_KEY_NOTE, detailOf, isDryRun, makeDeps, textResult } from "./shared.js";

/**
 * The whole A side in one call: read, hire, verify, compose, publish, list.
 *
 * Nearly every refusal is already a value coming out of `underwrite()`, so this
 * handler adds three things: the dry-run note when there is no key, a link
 * anyone can open to re-check the seal for themselves, and a name for the one
 * failure the library throws rather than returns.
 */
export function registerUnderwrite(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "underwrite",
    {
      description:
        "Run the full underwriting: read the token, pay and verify an auditor's seal B, compose and sign seal A around it, publish the body to 0G Storage, and list it on the CollateralRegistry. Refuses with a named code at whichever step fails. Without ACU_AGENT_KEY this stops at the quote.",
      inputSchema: {
        token: Address.describe("ERC-20 contract address on 0G testnet."),
        ltvBps: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .default(7000)
          .describe("Loan-to-value to list at, in basis points. The auditor's cap always wins."),
        source: z.string().optional().describe("Local Solidity source for the token, if you have it. Never fetched."),
        settle: z.boolean().default(true).describe("Submit the listing transaction. False stops after the seal."),
        publish: z
          .boolean()
          .default(config.publish)
          .describe("Upload the seal body to 0G Storage so anyone can fetch it by its hash."),
      },
    },
    async ({ token, ltvBps, source, settle, publish }) => {
      const publisher =
        config.agentKey !== null && publish
          ? ogStoragePublisher({
              privateKey: config.agentKey,
              rpcUrl: config.rpcUrl,
              indexerUrl: config.indexerUrl,
            })
          : null;

      const deps = makeDeps(config, { publisher });
      // `underwrite()` names every step as it takes it, which is the only way to
      // tell an auditor that will not answer from an RPC that will not answer
      // once the throw has escaped.
      let stage: Stage = "read";
      deps.onStep = (e) => {
        stage = e.stage;
      };

      let result: UnderwriteResult;
      try {
        result = await underwrite({ token, ltvBps, source: source ?? null, settle, publish }, deps);
      } catch (err) {
        // A dead RPC stays an exception — that is a broken environment, and
        // `underwrite()` is right to say so. A dead auditor is an ordinary
        // Tuesday, and gets a code the caller can act on.
        if (stage === "read") throw err;
        return textResult({ ok: false, stage, code: "AUDITOR_UNREACHABLE", detail: detailOf(err) }, true);
      }

      const note = isDryRun(config) ? { note: NO_KEY_NOTE } : {};
      if (result.ok && result.kind === "sealed") {
        return textResult({ ...result, shareUrl: shareUrl(config, result.sealA), ...note });
      }
      return textResult({ ...result, ...note });
    },
  );
}

/**
 * A URL that carries the seal itself, not a pointer to one.
 *
 * The verifier page checks the fragment locally, so a link opened by someone who
 * has never heard of us still proves the same thing. Fragments are never sent to
 * the server, which is the point: sharing a seal must not require trusting a host.
 */
export function shareUrl(config: McpConfig, seal: SealA): string {
  const encoded = Buffer.from(JSON.stringify(seal), "utf8").toString("base64url");
  return `${config.webUrl}/#seal=${encoded}`;
}
