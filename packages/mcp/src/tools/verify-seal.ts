import { z } from "zod";
import {
  Address,
  SealVerificationError,
  recoverSealSigner,
  resolverFromDirectory,
  verifySealA,
  verifySealB,
  type SealA,
  type SealB,
} from "@acu/seal";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { detailOf, textResult } from "./shared.js";

/**
 * The one tool that answers for itself.
 *
 * Verification never crosses the network: this is `@acu/seal` running in this
 * process against a directory this process already holds. No endpoint is asked
 * whether a seal is good, because an endpoint that can say yes can also be
 * bought.
 */
export function registerVerifySeal(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "verify_seal",
    {
      description:
        "Verify a seal A or seal B locally, in this process — signature, live agentId, subject and request bindings, expiry, and TEE attestation. Never asks a server whether a seal is valid. An invalid seal is a normal answer: { valid: false, failure } naming the check that failed.",
      inputSchema: {
        seal: z
          .union([z.string(), z.record(z.unknown())])
          .describe("The seal, as a JSON string or an object."),
        expectedSubject: Address.optional().describe(
          "The token this seal is supposed to be about. Omit and the subject/request bindings are only checked for self-consistency.",
        ),
        now: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Unix seconds to judge expiry against. Defaults to the current time; set it to audit a seal that has since expired."),
      },
    },
    async ({ seal, expectedSubject, now }) => {
      let parsed: unknown = seal;
      if (typeof seal === "string") {
        try {
          parsed = JSON.parse(seal);
        } catch (err) {
          return textResult({ valid: false, failure: "SCHEMA_INVALID", detail: detailOf(err) });
        }
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return textResult({ valid: false, failure: "SCHEMA_INVALID", detail: "a seal is a JSON object" });
      }

      const candidate = parsed as Record<string, unknown>;
      const resolver = resolverFromDirectory(config.directory);
      const at = now ?? Math.floor(Date.now() / 1000);

      const rawSubject = candidate["subject"];
      if (typeof rawSubject !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(rawSubject)) {
        return textResult({
          valid: false,
          failure: "SCHEMA_INVALID",
          detail: "seal.subject must be a 0x-prefixed 20-byte address",
        });
      }
      const subject = rawSubject.toLowerCase() as `0x${string}`;

      try {
        if (candidate["type"] === "audit") {
          const request = candidate["request"];
          if (typeof request !== "string") {
            return textResult({ valid: false, failure: "SCHEMA_INVALID", detail: "seal B carries no request hash" });
          }
          const verified = await verifySealB(candidate, {
            // With no expected subject or request from the caller, these two
            // checks fold into self-consistency. Say so in the answer rather
            // than letting it read as a binding that was actually checked.
            expectedSubject: expectedSubject ?? subject,
            expectedRequest: request as `0x${string}`,
            resolver,
            now: at,
          });
          return textResult(reportB(verified, await signerOf(verified), expectedSubject !== undefined));
        }

        if (candidate["type"] === "underwriting") {
          const verified = await verifySealA(candidate, {
            expectedSubject: expectedSubject ?? subject,
            resolver,
            now: at,
          });
          return textResult(reportA(verified, await signerOf(verified), expectedSubject !== undefined));
        }

        return textResult({
          valid: false,
          failure: "SCHEMA_INVALID",
          detail: `type must be "audit" or "underwriting", got ${JSON.stringify(candidate["type"])}`,
        });
      } catch (err) {
        if (err instanceof SealVerificationError) {
          return textResult({ valid: false, failure: err.failure, detail: err.message });
        }
        throw err;
      }
    },
  );
}

/**
 * The signer of the seal that was *verified*, never of the bytes that came in.
 *
 * `verifySealA`/`verifySealB` parse before they recover: unknown keys are
 * dropped and hex is lowercased. Recovering from the caller's object would
 * therefore report an address that signed nothing — beside `valid: true` — for
 * any seal pasted out of another tool with an extra field or checksummed hex.
 */
const signerOf = (seal: SealA | SealB): Promise<`0x${string}`> =>
  recoverSealSigner(seal as unknown as Record<string, unknown>);

const boundNote = (bound: boolean): string | undefined =>
  bound ? undefined : "expectedSubject was omitted — subject and request bindings are self-consistent only";

function reportB(seal: SealB, signer: `0x${string}`, bound: boolean): Record<string, unknown> {
  const note = boundNote(bound);
  return {
    valid: true,
    type: seal.type,
    signer,
    subject: seal.subject,
    verdict: seal.verdict,
    expiresAt: seal.expiresAt,
    ...(seal.inference.teeAttestation ? { attestation: seal.inference.teeAttestation } : {}),
    ...(note ? { note } : {}),
  };
}

function reportA(seal: SealA, signer: `0x${string}`, bound: boolean): Record<string, unknown> {
  const note = boundNote(bound);
  // Seal A's own attestation is the one carried by the audit it embeds: A never
  // runs inference itself, it delegates and then vouches for the delegation.
  const attestation = seal.delegations[0]?.seal.inference.teeAttestation ?? null;
  return {
    valid: true,
    type: seal.type,
    signer,
    subject: seal.subject,
    verdict: seal.verdict,
    expiresAt: seal.verdict.expiresAt,
    delegations: seal.delegations.map((d) => ({
      agentId: d.agentId,
      service: d.service,
      settlementTx: d.settlementTx,
      trustMode: d.seal.inference.trustMode,
      maxLtvBps: d.seal.verdict.maxLtvBps,
    })),
    ...(attestation ? { attestation } : {}),
    ...(note ? { note } : {}),
  };
}
