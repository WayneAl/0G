import { createWalletClient, http, createPublicClient, type Account, type Hex } from "viem";
import { buildStubProof, sealDigest, type SealA } from "@acu/seal";
import { OG_TESTNET } from "./chain.js";
import type { UnderwriteFailure } from "./underwrite.js";

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
    name: "verifier",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
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
  // Custom errors must be in the ABI or viem hands back a bare selector, and the
  // demo's whole point is that the contract says *why* it refused.
  { type: "error", name: "SEAL_SUBJECT_MISMATCH", inputs: [] },
  { type: "error", name: "AUDIT_FAILED", inputs: [] },
  { type: "error", name: "LTV_EXCEEDS_ATTESTED", inputs: [] },
  { type: "error", name: "SEAL_EXPIRED", inputs: [] },
  { type: "error", name: "ZERO_ADDRESS", inputs: [] },
  { type: "error", name: "NO_SEAL", inputs: [] },
  { type: "error", name: "BAD_SIGNATURE", inputs: [] },
] as const;

const VERIFIER_ABI = [
  { name: "signer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export interface SettleOptions {
  registry: `0x${string}`;
  account: Account;
  rpcUrl?: string;
  // Seams. The defaults are the real functions below; a caller overrides them to
  // test what happens around the transaction without sending one.
  sendListing?: typeof sendListing;
  waitForReceipt?: typeof waitForReceipt;
  readListing?: typeof readListing;
}

export interface SettleResult {
  txHash: Hex;
  listed: { active: boolean; ltvBps: number; sealHash: Hex; expiresAt: bigint };
}

const chain = {
  ...OG_TESTNET,
  rpcUrls: { default: { http: [...OG_TESTNET.rpcUrls.default.http] } },
} as const;

/** One transport for every read and write here, retrying a flaky testnet RPC. */
const rpc = (rpcUrl?: string) => http(rpcUrl ?? OG_TESTNET.rpcUrls.default.http[0], { retryCount: 5 });

/** Waits for the listing transaction to be mined. See `listWithSeal` on why a throw here is not a verdict. */
export async function waitForReceipt(txHash: Hex, rpcUrl?: string): Promise<void> {
  const pub = createPublicClient({ chain, transport: rpc(rpcUrl) });
  await pub.waitForTransactionReceipt({ hash: txHash, timeout: 180_000, pollingInterval: 1_000 });
}

/** Builds the proof and sends `list`. The only part of settlement that writes. */
export async function sendListing(
  seal: SealA,
  token: `0x${string}`,
  ltvBps: number,
  opts: SettleOptions,
): Promise<Hex> {
  const transport = rpc(opts.rpcUrl);
  const wallet = createWalletClient({ account: opts.account, chain, transport });
  const pub = createPublicClient({ chain, transport });

  const proof = await buildStubProof(seal, opts.account);

  // Simulate first so a revert surfaces as its custom error rather than a
  // failed transaction the demo has to explain.
  const { request } = await pub.simulateContract({
    address: opts.registry,
    abi: REGISTRY_ABI,
    functionName: "list",
    args: [token, ltvBps, proof],
    account: opts.account,
  });

  return wallet.writeContract(request);
}

/**
 * Presents seal A to the registry.
 *
 * Failures here are the point of the demo, not an accident: the contract reverts
 * with a named reason (SEAL_SUBJECT_MISMATCH, AUDIT_FAILED, LTV_EXCEEDS_ATTESTED,
 * SEAL_EXPIRED, NO_SEAL), and the caller surfaces it verbatim.
 */
export async function listWithSeal(
  seal: SealA,
  /**
   * The token being listed. Passed separately from the seal on purpose: the
   * contract takes them as two independent arguments, and the entire point of
   * subject binding is that they are allowed to disagree. Deriving this from
   * `seal.subject` would quietly make a replay impossible to demonstrate — and
   * impossible to detect.
   */
  token: `0x${string}`,
  ltvBps: number,
  opts: SettleOptions,
): Promise<SettleResult> {
  const txHash = await (opts.sendListing ?? sendListing)(seal, token, ltvBps, opts);

  const wait = opts.waitForReceipt ?? waitForReceipt;
  const read = opts.readListing ?? readListing;
  const listingOpts = {
    registry: opts.registry,
    ...(opts.rpcUrl === undefined ? {} : { rpcUrl: opts.rpcUrl }),
  };

  try {
    await wait(txHash, opts.rpcUrl);
  } catch (err) {
    // This RPC loses receipts for transactions it has already mined, and a
    // listing that landed must never be reported as one that failed. Chain state
    // is the truth: if the registry now holds this exact seal, we are done.
    const listed = await read(token, listingOpts);
    if (listed.active && listed.sealHash.toLowerCase() === sealDigest(seal).toLowerCase()) {
      return { txHash, listed };
    }
    throw err;
  }

  return { txHash, listed: await read(token, listingOpts) };
}

/**
 * The custom errors this ABI declares, as they arrive inside viem's message.
 * Named here, beside the ABI they come from, so every caller reports the same
 * refusal for the same revert.
 */
const REVERT_NAMES = /(SEAL_SUBJECT_MISMATCH|AUDIT_FAILED|LTV_EXCEEDS_ATTESTED|SEAL_EXPIRED|NO_SEAL|BAD_SIGNATURE)/;

/**
 * What the registry actually refused, from whatever viem threw.
 *
 * A named revert is the contract saying why, and is surfaced verbatim; anything
 * else is LIST_FAILED with the raw message, truncated — a failure we cannot name
 * must still be readable.
 */
export function mapListError(message: string): { code: UnderwriteFailure; detail: string } {
  const named = message.match(REVERT_NAMES)?.[1];
  return named
    ? { code: named as UnderwriteFailure, detail: "reverted by CollateralRegistry" }
    : { code: "LIST_FAILED", detail: message.slice(0, 300) };
}

/**
 * The one signer StubVerifier accepts: registry.verifier() → verifier.signer().
 *
 * Asked *before* listing, because a seal signed by anyone else is refused on
 * chain with BAD_SIGNATURE after the gas is spent. Reading it costs nothing and
 * turns a revert into a refusal the agent can explain.
 */
export async function readTrustedSigner(registry: `0x${string}`, rpcUrl?: string): Promise<`0x${string}`> {
  const pub = createPublicClient({ chain, transport: http(rpcUrl ?? OG_TESTNET.rpcUrls.default.http[0]) });
  const verifier = await pub.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "verifier",
  });
  return pub.readContract({ address: verifier, abi: VERIFIER_ABI, functionName: "signer" });
}

/** Read-only check, used by the demo script to prove a listing landed. */
export async function readListing(token: `0x${string}`, opts: Omit<SettleOptions, "account">) {
  // Retries here too: this read is what decides whether a listing landed.
  const pub = createPublicClient({ chain, transport: rpc(opts.rpcUrl) });
  const [active, ltvBps, sealHash, expiresAt] = await pub.readContract({
    address: opts.registry,
    abi: REGISTRY_ABI,
    functionName: "listings",
    args: [token],
  });
  return { active, ltvBps, sealHash, expiresAt };
}
