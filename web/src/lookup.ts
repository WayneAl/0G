import { createPublicClient, http } from "viem";
import { resolveSeal, SealNotFoundError, type Located } from "@0x402/storage";

/**
 * Token address in, seal body out — with nothing taken on trust in between.
 *
 * The chain says which hash is listed and which signer its verifier accepts.
 * 0G Storage hands back bytes for that hash, and `resolveSeal` refuses them
 * unless `sealDigest(body) === sealHash`. The caller then runs the real
 * verification locally. No step here can make a seal look valid.
 *
 * The ABIs are declared in this file rather than imported from
 * `@0x402/underwriter`, which would drag the x402 packages into a browser bundle
 * for three view functions. They are copied from
 * `packages/underwriter/src/settle.ts`.
 */
const REGISTRY_ABI = [
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
  {
    name: "verifier",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const VERIFIER_ABI = [
  { name: "signer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export interface Listing {
  active: boolean;
  ltvBps: number;
  sealHash: `0x${string}`;
  expiresAt: bigint;
}

export interface LookupResult {
  listing: Listing | null;
  trustedSigner: `0x${string}` | null;
  located: Located | null;
  seal: unknown | null;
  /** A code, never a bare sentence: the page shows it, and it names the step that refused. */
  error: string | null;
}

export interface LookupConfig {
  rpcUrl: string;
  registry: `0x${string}`;
  indexerUrl: string;
}

/**
 * The one signer the registry's verifier will accept — and therefore the only
 * `sender` whose 0G Storage uploads are worth scanning for.
 *
 * Split out because the feed needs it once for twenty cards, while a single
 * lookup needs it once for one.
 */
export async function trustedSignerOf(cfg: {
  rpcUrl: string;
  registry: `0x${string}`;
}): Promise<`0x${string}`> {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
  const verifier = await pub.readContract({
    address: cfg.registry,
    abi: REGISTRY_ABI,
    functionName: "verifier",
  });
  return pub.readContract({ address: verifier, abi: VERIFIER_ABI, functionName: "signer" });
}

export async function lookupToken(token: `0x${string}`, cfg: LookupConfig): Promise<LookupResult> {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
  const empty: LookupResult = { listing: null, trustedSigner: null, located: null, seal: null, error: null };

  let listing: Listing;
  try {
    const [active, ltvBps, sealHash, expiresAt] = await pub.readContract({
      address: cfg.registry,
      abi: REGISTRY_ABI,
      functionName: "listings",
      args: [token],
    });
    listing = { active, ltvBps, sealHash, expiresAt };
  } catch (err) {
    return { ...empty, error: `RPC_UNREACHABLE: ${detailOf(err)}` };
  }

  if (!listing.active) {
    return { ...empty, listing, error: `NOT_LISTED: the registry holds no active listing for ${token}` };
  }

  let trustedSigner: `0x${string}`;
  try {
    trustedSigner = await trustedSignerOf(cfg);
  } catch (err) {
    return { ...empty, listing, error: `RPC_UNREACHABLE: ${detailOf(err)}` };
  }

  try {
    const { seal, located } = await resolveSeal(listing.sealHash, {
      rpcUrl: cfg.rpcUrl,
      sender: trustedSigner,
      indexerUrl: cfg.indexerUrl,
    });
    return { listing, trustedSigner, located, seal, error: null };
  } catch (err) {
    // `SealNotFoundError.message` already opens with its reason code
    // (NO_SUBMISSION / BAD_JSON / DIGEST_MISMATCH), which is the step that refused.
    const error = err instanceof SealNotFoundError ? err.message : `OG_STORAGE_UNREACHABLE: ${detailOf(err)}`;
    return { listing, trustedSigner, located: null, seal: null, error };
  }
}

const detailOf = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0] ?? text;
};
