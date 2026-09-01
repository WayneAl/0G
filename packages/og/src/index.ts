export * from "./types.js";
export * from "./prompt.js";
export * from "./router.js";
export * from "./direct.js";

import { DirectClient } from "./direct.js";
import { RouterClient, type RouterClientOptions } from "./router.js";
import type { InferenceClient } from "./types.js";

export type InferenceClientConfig =
  | ({ kind: "router" } & RouterClientOptions)
  | { kind: "direct"; model: string };

/** The one switch spec §7.1 asks for: flip `kind` and nothing else moves. */
export function createInferenceClient(config: InferenceClientConfig): InferenceClient {
  return config.kind === "direct" ? new DirectClient(config.model) : new RouterClient(config);
}
