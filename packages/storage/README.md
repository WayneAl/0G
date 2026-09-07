# @0x402/storage

Put a seal on the 0G Storage log layer, and find it again by its own hash.

```bash
npm i @0x402/storage
```

## Find one (browser-safe)

```ts
import { resolveSeal } from "@0x402/storage";

const located = await resolveSeal(sealHash, { rpcUrl, sender, indexerUrl });
located.seal; // the body, re-derivable to exactly that hash
```

The root export — and the `./locate` and `./fetch` subpaths — import nothing from
`node:` and bring in neither `ethers` nor the 0G SDK, so a page can do this lookup in
the visitor's browser. That is how a registry entry becomes a readable seal with no
server in between.

## Publish one (Node)

```ts
import { publishSeal } from "@0x402/storage/publish";

const receipt = await publishSeal(seal, { privateKey, rpcUrl, indexerUrl });
// { root, txHash, txSeq, sealHash, bytes }
```

`./publish` is the only subpath that pulls in `ethers` and the 0G SDK. Import it from
a bundle and you will ship both.

## How the lookup works

The upload is tagged with `sealDigest(seal)`, so the chain's own `Flow.Submit` log is
the index: given a hash, scan for the submission carrying that tag from that sender,
fold the node roots into the file root, and fetch it from the indexer gateway. No
key-value service, no server of ours, nothing to keep running. The bytes are the
canonical encoding the signature covers, so a reader re-derives the hash and the
signer without trusting the storage layer at all.

---

[Repository](https://github.com/WayneAl/0G) · [Site](https://wayneal.github.io/0G) · MIT
