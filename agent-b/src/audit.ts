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
    // Only ever downgraded deliberately, to demonstrate what it costs (scene ⑤).
    ...(config.og.degradeToStandard ? { trustMode: "standard" as const } : {}),
  });

  return {
    model: client.model,
    async run(request: AuditRequestPayload): Promise<InferenceResult> {
      return client.audit({ token: request.token, artifact: request.artifact });
    },
  };
}
