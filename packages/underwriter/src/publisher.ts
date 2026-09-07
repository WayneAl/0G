import type { SealA } from "@0x402/seal";

/**
 * Where a seal A body ended up, and how anyone else can get it back.
 *
 * `sealHash` is the seal's own canonical digest — the same value the registry
 * stores — so a receipt is enough to find the body again without trusting
 * whoever handed you the receipt.
 */
export interface PublishReceipt {
  root: `0x${string}`;
  txHash: `0x${string}`;
  txSeq: number;
  sealHash: `0x${string}`;
  indexerUrl: string;
  bytes: number;
}

/**
 * Publishing is a seam, not a dependency: the underwriter never imports a
 * storage SDK. `@0x402/storage` supplies the 0G implementation; a test supplies a
 * stub; `null` means the seal stays local.
 */
export interface SealPublisher {
  publish(seal: SealA): Promise<PublishReceipt>;
}
