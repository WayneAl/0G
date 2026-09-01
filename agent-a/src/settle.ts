import { createWalletClient, http, createPublicClient, type Account, type Hex } from "viem";
import { buildStubProof, type SealA } from "@acu/seal";
import { OG_TESTNET } from "./chain.js";

const REGISTRY_ABI = [
  {
    name: "list",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "ltvBps", type: "uint16" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "listings",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "active", type: "bool" },
      { name: "ltvBps", type: "uint16" },
      { name: "sealHash", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
    ],
  },
] as const;

export interface SettleOptions {
  registry: `0x${string}`;
  account: Account;
  rpcUrl?: string;
}

export interface SettleResult {
  txHash: Hex;
  listed: { active: boolean; ltvBps: number; sealHash: Hex; expiresAt: bigint };
}

const chain = {
  ...OG_TESTNET,
  rpcUrls: { default: { http: [...OG_TESTNET.rpcUrls.default.http] } },
} as const;

/**
 * Presents seal A to the registry.
 *
 * Failures here are the point of the demo, not an accident: the contract reverts
 * with a named reason (SEAL_SUBJECT_MISMATCH, AUDIT_FAILED, LTV_EXCEEDS_ATTESTED,
 * SEAL_EXPIRED, NO_SEAL), and the caller surfaces it verbatim.
 */
export async function listWithSeal(
  seal: SealA,
  ltvBps: number,
  opts: SettleOptions,
): Promise<SettleResult> {
  const transport = http(opts.rpcUrl ?? OG_TESTNET.rpcUrls.default.http[0]);
  const wallet = createWalletClient({ account: opts.account, chain, transport });
  const pub = createPublicClient({ chain, transport });

  const proof = await buildStubProof(seal, opts.account);

  // Simulate first so a revert surfaces as its custom error rather than a
  // failed transaction the demo has to explain.
  const { request } = await pub.simulateContract({
    address: opts.registry,
    abi: REGISTRY_ABI,
    functionName: "list",
    args: [seal.subject, ltvBps, proof],
    account: opts.account,
  });

  const txHash = await wallet.writeContract(request);
  await pub.waitForTransactionReceipt({ hash: txHash });

  const [active, listedLtv, sealHash, expiresAt] = await pub.readContract({
    address: opts.registry,
    abi: REGISTRY_ABI,
    functionName: "listings",
    args: [seal.subject],
  });

  return { txHash, listed: { active, ltvBps: listedLtv, sealHash, expiresAt } };
}

/** Read-only check, used by the demo script to prove a listing landed. */
export async function readListing(token: `0x${string}`, opts: Omit<SettleOptions, "account">) {
  const pub = createPublicClient({
    chain,
    transport: http(opts.rpcUrl ?? OG_TESTNET.rpcUrls.default.http[0]),
  });
  const [active, ltvBps, sealHash, expiresAt] = await pub.readContract({
    address: opts.registry,
    abi: REGISTRY_ABI,
    functionName: "listings",
    args: [token],
  });
  return { active, ltvBps, sealHash, expiresAt };
}
