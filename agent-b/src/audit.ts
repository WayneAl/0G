import { RouterClient, type InferenceResult } from "@acu/og";
import type { AuditRequestPayload } from "@acu/seal";
import type { AgentBConfig } from "./config.js";

/**
 * Runs the paid work: one attested inference over the token artifact.
 *
 * The artifact is attacker-authored and is passed straight through to the prompt
 * builder, which fences it. Nothing here parses it, branches on it, or lets it
 * pick a model — see spec §6.1 and packages/og/src/prompt.ts.
 */
export function makeAuditor(config: AgentBConfig) {
  const client = new RouterClient({
    apiKey: config.og.apiKey,
    network: config.og.network,
    ...(config.og.model ? { model: config.og.model } : {}),
  });

  return {
    model: client.model,
    async run(request: AuditRequestPayload): Promise<InferenceResult> {
      const result = await client.audit({ token: request.token, artifact: request.artifact });
      if (config.og.skipAttestation) {
        // Scene ⑤: the seal still claims `verified`, but carries no evidence.
        // Agent A must refuse it, and the payment is already spent either way.
        return { ...result, attestation: null };
      }
      return result;
    },
  };
}
