# @acu/og

0G Compute clients for TEE-attested inference, behind one interface.

```bash
npm i @acu/og
```

```ts
import { createInferenceClient } from "@acu/og";

const client = createInferenceClient({ kind: "router", apiKey, network: "testnet" });

const result = await client.audit({ token, artifact });

result.output;       // { action, maxLtvBps, findings, reasoning }
result.trustMode;    // "verified" when the provider ran it in a TEE
result.attestation;  // chatId, teeVerified, the signed response hash — or null
result.promptHash;   // what a seal commits to, so the claim is checkable later
```

Two backends behind one `InferenceClient`: the **Router** (`kind: "router"`), which asks
for attested execution and carries the attestation back, and a **direct** provider
client (`kind: "direct"`).

## Why the attestation is the point

An inference result nobody can vouch for is a sentence. One that comes back with
`teeVerified` and a signed response hash is something an underwriter can be made to
answer for — which is why [`@acu/seal`](https://www.npmjs.com/package/@acu/seal)
refuses a seal that claims an attested tier and carries no attestation, and why
`promptHash` and `responseHash` are bound into the seal rather than left as prose.

## The artifact is untrusted

`artifact` is attacker-authored material about a token — name, symbol, source,
comments. It is never interpolated as instructions; see `prompt.ts`. Nothing
downstream branches on `output.reasoning` either: it is model-authored text derived
from that same untrusted input, and it exists to be read by a human, not acted on.

---

[Repository](https://github.com/WayneAl/0G) · [Site](https://wayneal.github.io/0G) · MIT
