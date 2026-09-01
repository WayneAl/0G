import type { AuditRequest, InferenceClient, InferenceResult } from "./types.js";

/**
 * Direct-path client — connect to one provider, hold a per-provider sub-account,
 * sign requests with a wallet, verify via
 * `broker.inference.processResponse(providerAddress, chatID)` from
 * `@0gfoundation/0g-compute-ts-sdk`. (`@0glabs/0g-serving-broker` is deprecated;
 * do not build on it.)
 *
 * Deliberately unimplemented. Spec §7.1 called the Router/Direct split the
 * project's single point of failure, on the belief that the Router had no usable
 * proof surface. It does — verify_tee + ZG-Res-Key + the provider signature
 * endpoint form a complete third-party verification loop (NOTES.md §A2) — so
 * Direct is a backup, not a lifeline. The seam is kept so that swapping in a real
 * implementation is a one-line change at the call site, per spec §7.1.
 */
export class DirectClient implements InferenceClient {
  readonly kind = "direct" as const;
  constructor(readonly model: string) {}

  async audit(_req: AuditRequest): Promise<InferenceResult> {
    throw new Error(
      "DirectClient is not implemented: the Router path carries a verifiable " +
        "attestation loop (NOTES.md §A2), so Direct is held in reserve. " +
        "Implement against @0gfoundation/0g-compute-ts-sdk if the Router path fails on site.",
    );
  }
}
