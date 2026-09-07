import { z } from "zod";
import { Address, type SealA } from "@0x402/seal";
import { underwrite, type Stage, type UnderwriteResult } from "@0x402/underwriter";
import { ogStoragePublisher } from "@0x402/storage/publish";
import { shareUrl } from "@0x402/config";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { NO_KEY_NOTE, detailOf, isDryRun, makeDeps, textResult } from "./shared.js";
import { fundingRefusal, statusOf } from "./agent-status.js";

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
        "Run the full underwriting: read the token, pay and verify an auditor's seal B, compose and sign seal A around it, publish the body to 0G Storage, and list it on the CollateralRegistry. Refuses with a named code at whichever step fails. Without a key this stops at the quote.",
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
      // Money first, before anything signs: see `fundingRefusal`.
      const unfunded = await fundingRefusal(config, await statusOf(config));
      if (unfunded !== null) return textResult(unfunded);

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
      // The seal is the evidence for a payment that has already happened. If a
      // later stage throws, the caller must still get it.
      let signed: SealA | null = null;
      deps.onSealA = (seal) => {
        signed = seal;
      };

      let result: UnderwriteResult;
      try {
        result = await underwrite({ token, ltvBps, source: source ?? null, settle, publish }, deps);
      } catch (err) {
        // A dead RPC stays an exception — that is a broken environment, and
        // `underwrite()` is right to say so. Anything later is a refusal the
        // caller can act on, and it names the party that actually failed.
        if (stage === "read") throw err;
        return textResult(refusalForThrow(stage, err, signed));
      }

      const note = isDryRun(config) ? { note: NO_KEY_NOTE } : {};
      if (result.ok && result.kind === "sealed") {
        return textResult({ ...result, shareUrl: shareUrl(config.webUrl, result.sealA), ...note });
      }
      return textResult({ ...result, ...note });
    },
  );
}

/**
 * A throw out of `underwrite()`, turned into a refusal that names the right party.
 *
 * Only `quote` and `hire` are stages where the auditor is the one on the other
 * end of the wire; calling a failure at `verify`, `compose` or `settle`
 * `AUDITOR_UNREACHABLE` accuses an agent that answered perfectly well. The
 * settlement stage already has a code for this. Any seal A that was signed
 * before the throw rides along: it is worth keeping even when the run is not.
 */
export function refusalForThrow(stage: Stage, err: unknown, sealA: SealA | null): Record<string, unknown> {
  const code =
    stage === "quote" || stage === "hire"
      ? "AUDITOR_UNREACHABLE"
      : stage === "settle"
        ? "LIST_FAILED"
        : "UNEXPECTED_ERROR";
  return {
    ok: false,
    stage,
    code,
    detail: `${stage} threw: ${detailOf(err)}`,
    ...(sealA === null ? {} : { sealA }),
  };
}
