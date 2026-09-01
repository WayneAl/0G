import { config as loadEnv } from "dotenv";
import express from "express";
import { z } from "zod";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { AuditRequestPayload } from "@acu/seal";
import { loadConfig } from "./config.js";
import { makeAuditor } from "./audit.js";
import { issueSealB } from "./seal.js";

loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

const config = loadConfig();
const auditor = makeAuditor(config);

/** What Agent A must send. Anything else is rejected before a cent is spent. */
const AuditBody = z.object({
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  artifact: z.string().min(1).max(200_000),
  requestedAt: z.number().int().positive(),
  nonce: z.string().min(1).max(128),
});

const app = express();
app.use(express.json({ limit: "1mb" }));

// v2 of the protocol: three base64 JSON headers (PAYMENT-REQUIRED /
// PAYMENT-SIGNATURE / PAYMENT-RESPONSE), not the deprecated V1 X-PAYMENT flow.
const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
).register(config.network, new ExactEvmScheme());

app.use(
  paymentMiddleware(
    {
      "POST /audit": {
        accepts: [
          {
            scheme: "exact",
            price: config.priceUsd,
            network: config.network,
            payTo: config.payToAddress,
          },
        ],
        description: "Attested smart contract audit for collateral onboarding",
      },
    },
    resourceServer,
  ),
);

/** Unprotected: lets a caller see who they would be hiring before paying. */
app.get("/agent", (_req, res) => {
  res.json({
    agentId: config.agentId,
    service: "code-audit",
    sealSigner: config.sealAccount.address,
    payTo: config.payToAddress,
    price: config.priceUsd,
    network: config.network,
    model: auditor.model,
    ogNetwork: config.og.network,
    trustMode: config.og.degradeToStandard ? "standard" : "verified",
  });
});

app.post("/audit", async (req, res) => {
  const parsed = AuditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "BAD_REQUEST", detail: parsed.error.issues[0]?.message });
    return;
  }

  const request: AuditRequestPayload = {
    token: parsed.data.token.toLowerCase() as `0x${string}`,
    artifact: parsed.data.artifact,
    requestedAt: parsed.data.requestedAt,
    nonce: parsed.data.nonce,
  };

  try {
    const inference = await auditor.run(request);
    const sealB = await issueSealB(request, inference, {
      agentId: config.agentId,
      account: config.sealAccount,
      ttlSeconds: config.sealTtlSeconds,
    });

    res.json({
      audit: {
        action: inference.output.action,
        maxLtvBps: inference.output.maxLtvBps,
        findings: inference.output.findings,
        // Display only. Agent A must never branch on this string: it is
        // model-authored text derived from an attacker-authored artifact.
        reasoning: inference.output.reasoning,
        costNeuron: inference.costNeuron,
      },
      sealB,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[agent-b] audit failed:", detail);
    // The payment settles on a 2xx; failing loudly here is what keeps Agent A
    // from paying for a seal that was never issued.
    res.status(502).json({ error: "AUDIT_FAILED", detail });
  }
});

app.listen(config.port, () => {
  console.log(`[agent-b] listening on :${config.port}`);
  console.log(`  agentId      ${config.agentId}`);
  console.log(`  seal signer  ${config.sealAccount.address}`);
  console.log(`  payTo        ${config.payToAddress}  (${config.priceUsd}, ${config.network})`);
  console.log(`  facilitator  ${config.facilitatorUrl}`);
  console.log(`  inference    ${auditor.model} on 0G ${config.og.network}`);
  if (config.og.degradeToStandard) {
    console.log(`  !! AGENT_B_DEGRADE=1 -- standard tier, seals will carry no attestation`);
  }
});
