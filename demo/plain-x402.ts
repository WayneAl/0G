/**
 * An ordinary x402 service. Not an agent.
 *
 * It takes the same $0.01 over the same protocol through the same facilitator
 * and answers the same question — and each of those "same"s is the point of
 * demo scene ⑦. What it does not do: hold an Agentic ID, run on attested
 * compute, or sign anything. Its answer is a JSON body, and a JSON body is a
 * claim, not evidence. Agent A pays, receives an ALLOW, and refuses to act on
 * it, because there is nothing to verify and nothing to embed.
 *
 * Whether a model runs behind this endpoint is beside the point — nothing it
 * returned could be checked either way — so none does.
 *
 *   pnpm --filter @acu/demo plain           # listens on 4023
 */
import { config as loadEnv } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

loadEnv({ path: new URL("../.env", import.meta.url).pathname });

const PORT = Number(process.env["PLAIN_PORT"] ?? 4023);
const NETWORK = (process.env["PAYMENT_NETWORK"] ?? "eip155:84532") as `${string}:${string}`;
const FACILITATOR = process.env["FACILITATOR_URL"] ?? "https://x402.org/facilitator";
const PRICE = process.env["AGENT_B_PRICE"] ?? "$0.01";
// Same payee as Agent B, so the story is "the same vendor's cheaper tier" and it
// is the missing seal that stops Agent A — not its payee allowlist, which would
// otherwise refuse at the budget gate before a cent moved.
const PAY_TO = process.env["AGENT_B_PAYTO"] ?? process.env["AGENT_B_SEAL_SIGNER"];
if (!PAY_TO) throw new Error("missing AGENT_B_PAYTO (or AGENT_B_SEAL_SIGNER) in environment");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  paymentMiddleware(
    {
      "POST /audit": {
        accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO }],
        description: "Smart contract audit — plain API, answer is not signed",
      },
    },
    new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(
      NETWORK,
      new ExactEvmScheme(),
    ),
  ),
);

/** Unprotected, like Agent B's: what a caller sees before paying. Note what is null. */
app.get("/agent", (_req, res) => {
  res.json({
    service: "code-audit",
    payTo: PAY_TO,
    price: PRICE,
    network: NETWORK,
    agentId: null,
    sealSigner: null,
    trustMode: null,
    note: "plain x402 service — answers are not signed and carry no attestation",
  });
});

app.post("/audit", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "?";
  console.log(`[plain] paid audit for ${token} -> ALLOW / 7500, unsigned`);
  // The body Agent A would have listed on, in the world before seals.
  res.json({ verdict: "ALLOW", maxLtvBps: 7500, findings: [], model: "unspecified" });
});

app.listen(PORT, () => {
  console.log(`[plain] listening on :${PORT} — an x402 service that is not an agent`);
  console.log(`  payTo   ${PAY_TO}  (${PRICE}, ${NETWORK})`);
  console.log(`  signs   nothing · attestation none · Agentic ID none`);
});
