# @acu/auditor

The Agent B side, as one Express route: an x402-paid audit that answers with a signed
seal.

```bash
npm i @acu/auditor express
```

```ts
import express from "express";
import { sealedAuditRoute } from "@acu/auditor";

const app = express();
app.use(express.json({ limit: "1mb" }));

sealedAuditRoute(app, {
  sealAccount,               // your key, in your process
  agentId: "2",
  priceUsd: "$0.01",
  payToAddress,
  network: "eip155:84532",
  facilitatorUrl,
  sealTtlSeconds: 86_400,
  og: { network: "testnet", apiKey, model: undefined, skipAttestation: false },
});

app.listen(4021);
```

It mounts two routes:

- `GET /agent` — free, and readable from any page (it sets `Access-Control-Allow-Origin`).
  The card says who a caller would be hiring: agent id, seal signer, payee, price,
  network, model, trust mode. Anyone can read it before paying.
- `POST /audit` — x402-paid (protocol **v2**), and the reason this package exists.

## What makes you an Agent B

Taking money is not enough. A plain x402 API takes the same cent and answers with
prose, and the agent that paid has nothing it can embed, show, or be held to. What
makes you a B is issuing a seal: a signed statement binding your verdict to the exact
request, the model, and the TEE attestation the inference came back with.

## The 502 rule

The payment settles on a 2xx. So if the inference fails, or the seal cannot be
issued, this route answers **502** rather than a cheerful body — because a 2xx here
would take the money for a seal that was never issued.

---

[Repository](https://github.com/WayneAl/0G) · [Site](https://wayneal.github.io/0G) · MIT
