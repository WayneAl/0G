import type { Account } from "viem";
import type { OgNetwork } from "@0x402/og";

/**
 * Everything a seal-issuing B needs to serve one paid audit route.
 *
 * Deliberately free of `process.env`: the host app decides where these come
 * from (env, a secrets manager, a config file), and the package never guesses.
 * `port` is not here either — the host owns the server, this owns the route.
 */
export interface AuditorConfig {
  /** Where x402 payments land. Distinct wallet from the seal signer is fine; same is simpler. */
  payToAddress: `0x${string}`;
  priceUsd: string;
  /** CAIP-2, e.g. `eip155:84532`. x402 types this as a template literal. */
  network: `${string}:${string}`;
  facilitatorUrl: string;
  sealAccount: Account;
  agentId: string;
  sealTtlSeconds: number;
  og: {
    network: OgNetwork;
    apiKey: string;
    model: string | undefined;
    /**
     * Demo scene ⑤: an agent that took the money and skipped the verifiable part.
     *
     * Ideally this would point at a `standard`-tier provider that returns no
     * attestation. The 0G testnet catalog has no such provider — both models
     * there are TEE-attested (NOTES.md §A3/§B) — so the skip is simulated one
     * layer up: the attestation is dropped from the result while the seal still
     * claims `verified`. That is precisely the lie Agent A's sixth check exists
     * to catch, and it is honest about being a simulation.
     */
    skipAttestation: boolean;
  };
}
