import type { Account } from "viem";
import { sealDigest } from "./canonical.js";
import { SealA, SealB } from "./schema.js";

/** A seal before its own signature exists. */
export type Unsigned<T> = Omit<T, "signature">;

async function sign<T extends Record<string, unknown>>(
  unsigned: T,
  account: Account,
): Promise<T & { signature: `0x${string}` }> {
  if (!account.signMessage) throw new Error("account cannot sign messages");
  const digest = sealDigest(unsigned);
  // EIP-191 over the raw 32-byte digest — same preimage the Solidity verifier
  // reconstructs with MessageHashUtils.toEthSignedMessageHash.
  const signature = await account.signMessage({ message: { raw: digest } });
  return { ...unsigned, signature };
}

export async function signSealB(unsigned: Unsigned<SealB>, account: Account): Promise<SealB> {
  return SealB.parse(await sign(unsigned as unknown as Record<string, unknown>, account));
}

export async function signSealA(unsigned: Unsigned<SealA>, account: Account): Promise<SealA> {
  return SealA.parse(await sign(unsigned as unknown as Record<string, unknown>, account));
}
