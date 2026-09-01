import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";
import type { OgNetwork } from "@acu/og";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in environment`);
  return v;
}

export interface AgentBConfig {
  port: number;
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

export function loadConfig(): AgentBConfig {
  const sealAccount = privateKeyToAccount(required("AGENT_B_PRIVATE_KEY") as `0x${string}`);
  const mainnet = process.env["OG_NETWORK"] === "mainnet";

  return {
    port: Number(process.env["AGENT_B_PORT"] ?? 4021),
    payToAddress: (process.env["AGENT_B_PAYTO"] ?? sealAccount.address).toLowerCase() as `0x${string}`,
    priceUsd: process.env["AGENT_B_PRICE"] ?? "$0.01",
    // CAIP-2. Base Sepolia, confirmed as chainId 84532.
    network: (process.env["PAYMENT_NETWORK"] ?? "eip155:84532") as `${string}:${string}`,
    // Env-driven so the facilitator can be swapped in one line on site (spec §7.2).
    facilitatorUrl: process.env["FACILITATOR_URL"] ?? "https://x402.org/facilitator",
    sealAccount,
    agentId: process.env["AGENT_B_ID"] ?? "2",
    sealTtlSeconds: Number(process.env["SEAL_TTL_SECONDS"] ?? 86_400),
    og: {
      network: mainnet ? "mainnet" : "testnet",
      apiKey: required(mainnet ? "MAINNET_API_KEY" : "TESTNET_API_KEY"),
      model: process.env["OG_MODEL"],
      skipAttestation: process.env["AGENT_B_SKIP_ATTESTATION"] === "1",
    },
  };
}
