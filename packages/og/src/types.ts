import type { InferenceOutput, TeeAttestation } from "@0x402/seal";

export type TrustMode = "standard" | "verified" | "private";

/** What Agent B asks the inference layer for. */
export interface AuditRequest {
  /** Token under review. Bound into the seal as `subject`. */
  token: `0x${string}`;
  /**
   * Untrusted material about the token: name, symbol, source, comments.
   * Never interpolated as instructions — see prompt.ts.
   */
  artifact: string;
}

/** Everything the seal needs from one inference call. */
export interface InferenceResult {
  output: InferenceOutput;
  model: string;
  trustMode: TrustMode;
  providerAddress: `0x${string}`;
  promptHash: `0x${string}`;
  responseHash: `0x${string}`;
  attestation: TeeAttestation | null;
  /** Raw completion text, kept for the replay fixtures and manual review. */
  rawText: string;
  /** From x_0g_trace.billing, in neuron. Null on paths that do not report it. */
  costNeuron: string | null;
}

/**
 * Router and Direct both satisfy this. Spec §7.1 requires the two to be
 * swappable behind one interface.
 */
export interface InferenceClient {
  readonly kind: "router" | "direct";
  readonly model: string;
  audit(req: AuditRequest): Promise<InferenceResult>;
}
