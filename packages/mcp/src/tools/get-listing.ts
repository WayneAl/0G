import {
  Address,
  SealVerificationError,
  resolverFromDirectory,
  verifySealA,
} from "@acu/seal";
import { readListing, readTrustedSigner } from "@acu/underwriter";
import { SealNotFoundError, resolveSeal } from "@acu/storage";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { detailOf, textResult } from "./shared.js";

const ZERO_HASH = `0x${"0".repeat(64)}`;

/**
 * The round trip that makes the claim testable: chain → storage → verifier.
 *
 * The registry stores a hash, not a body. `resolveSeal` walks the `Flow.Submit`
 * tags to find the bytes, proves they hash to the value the chain recorded, and
 * only then is the seal verified — locally, here. Nothing in the path is asked
 * to vouch for anything; each step either matches or it does not.
 */
export function registerGetListing(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "get_listing",
    {
      description:
        "Look up a token's listing on the CollateralRegistry, fetch the seal body its sealHash points at from 0G Storage, and verify that seal locally. Answers what the chain says, what the seal says, and whether the two agree.",
      inputSchema: {
        token: Address.describe("ERC-20 contract address on 0G testnet."),
      },
    },
    async ({ token }) => {
      if (config.registry === null) {
        return textResult(
          { ok: false, code: "NO_REGISTRY", detail: "set ACU_REGISTRY to the CollateralRegistry address" },
          true,
        );
      }
      const registry = config.registry;

      const raw = await readListing(token, { registry, rpcUrl: config.rpcUrl });
      const listing = {
        active: raw.active,
        ltvBps: raw.ltvBps,
        sealHash: raw.sealHash,
        expiresAt: raw.expiresAt,
      };
      if (!raw.active || raw.sealHash.toLowerCase() === ZERO_HASH) {
        return textResult({ listed: false, token, listing });
      }

      // The registry's verifier accepts exactly one signer, and that signer is
      // also the only uploader whose submissions count as this seal's body.
      const trusted = await readTrustedSigner(registry, config.rpcUrl);

      let seal: unknown;
      let located: { root: `0x${string}`; txHash: `0x${string}`; txSeq: number };
      try {
        const found = await resolveSeal(raw.sealHash, {
          sender: trusted,
          rpcUrl: config.rpcUrl,
          indexerUrl: config.indexerUrl,
        });
        seal = found.seal;
        located = found.located;
      } catch (err) {
        if (err instanceof SealNotFoundError) {
          // The listing is real; the body is not reachable. Two different facts,
          // reported as two different fields.
          return textResult({ listed: true, token, listing, seal: null, reason: err.message });
        }
        throw err;
      }

      const base = {
        listed: true,
        token,
        listing,
        seal,
        root: located.root,
        txHash: located.txHash,
        txSeq: located.txSeq,
      };
      try {
        await verifySealA(seal, {
          expectedSubject: token,
          resolver: resolverFromDirectory(config.directory),
          now: Math.floor(Date.now() / 1000),
        });
        return textResult({ ...base, valid: true });
      } catch (err) {
        if (err instanceof SealVerificationError) {
          return textResult({ ...base, valid: false, failure: err.failure, detail: err.message });
        }
        return textResult({ ...base, valid: false, failure: "SCHEMA_INVALID", detail: detailOf(err) });
      }
    },
  );
}
