# @acu/seal

The seal format, and every check that decides whether one is real.

A **seal** is a signed statement an agent makes about work it did. An *audit* seal
(seal B) says what an auditor found; an *underwriting* seal (seal A) says what an
underwriter decided — and carries the audit seal it paid for whole, inside itself.
So one object proves the entire chain, and anyone can check it without asking anybody.

```bash
npm i @acu/seal
```

## Verify

```ts
import { verifySealA, SealVerificationError } from "@acu/seal";

try {
  await verifySealA(seal, { expectedSubject: token, resolver, now });
  // Every check below passed, including on the seal B embedded inside.
} catch (err) {
  if (err instanceof SealVerificationError) console.log(err.failure, err.message);
}
```

`verifySealB` does the same for a bare audit seal. Verification is pure: no network,
except the agent id → signer lookup you supply as `resolver`.

| Check | Refusal | What it means |
|---|---|---|
| `SCHEMA` | `SCHEMA_INVALID` | Not a seal of the shape and version claimed. |
| `AGENT_ID_LIVE` | `AGENT_ID_NOT_LIVE` | The agent id resolves to no signer in the directory. |
| `SIGNATURE` | `SIGNATURE_INVALID` · `SIGNER_MISMATCH` | The digest recomputed from the seal's own bytes recovers to somebody else, or to nobody. |
| `SUBJECT` | `SUBJECT_MISMATCH` | The seal is about a different token than the one asked about. |
| `REQUEST` | `REQUEST_MISMATCH` | Seal B answers a different request than the one made. |
| `EXPIRY` | `SEAL_EXPIRED` | The seal's window has closed. |
| `ATTESTATION` | `ATTESTATION_MISSING` | An attested tier is claimed and no attestation is carried. |
| `TRUST_TIER` | `TRUST_MODE_INSUFFICIENT` | The inference ran below the tier an underwriter will act on. |

Verification stops at the first failure and names it. That is deliberate: "we did not
look" is not the same claim as "it is fine".

## Sign

```ts
import { signSealA, sealDigest, canonicalize } from "@acu/seal";
```

The signature covers `keccak256(canonicalize(seal))` over EIP-191, so the bytes that
are stored are the bytes that were signed and a reader can re-derive both without
trusting the storage layer.

## Resolvers

`agentId → signer` comes from an `AgentIdResolver`: `StaticAgentIdResolver` for a
signer you name, `HttpAgentIdResolver` / `resolverFromDirectory` for a published
`directory.json`. This module has no `node:` imports, so it runs in a browser too —
which is how the project's site verifies a pasted seal with no backend at all.

## What a seal does not prove

Traceability, not correctness. A perfectly signed wrong answer still verifies.

---

[Repository](https://github.com/WayneAl/0G) · [Site](https://wayneal.github.io/0G) · MIT
