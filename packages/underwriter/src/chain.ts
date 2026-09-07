import {
  createPublicClient,
  http,
  keccak256,
  toHex,
  toFunctionSelector,
  type PublicClient,
} from "viem";

/** 0G testnet. chainId verified live as 16602 (0x40da). */
export const OG_TESTNET = {
  id: 16602,
  name: "0G Testnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: { default: { http: ["https://evmrpc-testnet.0g.ai"] } },
} as const;

const ERC20_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * Selectors worth flagging in runtime bytecode.
 *
 * This is a cheap, deterministic pre-filter, not the audit. It catches the
 * presence of a lever; only the model judges what having that lever means. A
 * token can be dangerous with none of these and harmless with several.
 */
const WATCHED_SIGNATURES = [
  "setBlacklist(address,bool)",
  "blacklist(address)",
  "upgradeTo(address)",
  "upgradeToAndCall(address,bytes)",
  "pause()",
  "unpause()",
  "mint(address,uint256)",
  "burnFrom(address,uint256)",
  "setTransferFeeBps(uint256)",
  "setFee(uint256)",
  "transferOwnership(address)",
] as const;

export interface TokenArtifact {
  address: `0x${string}`;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  owner: string | null;
  bytecodeSize: number;
  bytecodeHash: `0x${string}`;
  presentSelectors: string[];
  /** Local source, when we have it. Never fetched from an untrusted explorer. */
  source: string | null;
  sourceHash: `0x${string}`;
  top10HolderPct: number | null;
  liquidityDepthUsd: string;
}

export function makeOgClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl ?? OG_TESTNET.rpcUrls.default.http[0]),
  }) as PublicClient;
}

async function tryRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    // Absent methods are information, not errors: a token with no owner() is a
    // token nobody can steer.
    return null;
  }
}

/**
 * Gathers what the free 0G RPC can tell us about a candidate token.
 *
 * Deliberately not a paid data purchase (spec §11): extra hops that do not issue
 * seals add nothing to "every hop needs a proof".
 */
export async function fetchTokenArtifact(
  client: PublicClient,
  token: `0x${string}`,
  source: string | null = null,
): Promise<TokenArtifact> {
  const bytecode = (await client.getCode({ address: token })) ?? "0x";
  if (bytecode === "0x" || bytecode.length <= 2) {
    throw new Error(`NO_CODE_AT_ADDRESS: ${token} has no contract bytecode on 0G testnet`);
  }

  const [name, symbol, decimals, totalSupply, owner] = await Promise.all([
    tryRead(() => client.readContract({ address: token, abi: ERC20_ABI, functionName: "name" })),
    tryRead(() => client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" })),
    tryRead(() => client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" })),
    tryRead(() => client.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" })),
    tryRead(() => client.readContract({ address: token, abi: ERC20_ABI, functionName: "owner" })),
  ]);

  const presentSelectors = WATCHED_SIGNATURES.filter((sig) =>
    bytecode.toLowerCase().includes(toFunctionSelector(`function ${sig}`).slice(2).toLowerCase()),
  );

  return {
    address: token,
    name: name ?? null,
    symbol: symbol ?? null,
    decimals: decimals ?? null,
    totalSupply: totalSupply?.toString() ?? null,
    owner: owner ?? null,
    bytecodeSize: (bytecode.length - 2) / 2,
    bytecodeHash: keccak256(bytecode),
    presentSelectors: [...presentSelectors],
    source,
    sourceHash: source ? keccak256(toHex(source)) : keccak256(bytecode),
    // No indexer on this testnet; left null rather than invented. See README.
    top10HolderPct: null,
    liquidityDepthUsd: "0",
  };
}

/**
 * Renders the artifact as the text the model will see.
 *
 * Every field here is attacker-controlled or attacker-influenced — `name` and
 * `symbol` most obviously. The renderer must never interpret them; it only
 * labels and concatenates. Fencing happens in packages/og/src/prompt.ts.
 */
export function renderArtifact(a: TokenArtifact): string {
  const lines = [
    `address: ${a.address}`,
    `name: ${JSON.stringify(a.name)}`,
    `symbol: ${JSON.stringify(a.symbol)}`,
    `decimals: ${a.decimals ?? "(no decimals() method)"}`,
    `totalSupply: ${a.totalSupply ?? "(no totalSupply() method)"}`,
    `owner: ${a.owner ?? "(no owner() method -- ownership may be renounced or absent)"}`,
    `runtimeBytecodeSize: ${a.bytecodeSize} bytes`,
    `runtimeBytecodeHash: ${a.bytecodeHash}`,
    `selectorsPresentInBytecode: ${a.presentSelectors.length ? a.presentSelectors.join(", ") : "(none of the watched set)"}`,
  ];
  if (a.source) lines.push("", "source:", a.source);
  return lines.join("\n");
}
