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
     * Demo scene ⑤. Running "standard" buys cheaper inference with no attestation,
     * so the seal comes back without evidence and Agent A refuses it. Off by default;
     * the flag exists to make the failure demonstrable, not convenient.
     */
    degradeToStandard: boolean;
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
      degradeToStandard: process.env["AGENT_B_DEGRADE"] === "1",
    },
  };
}
