import type { Express } from "express";
import { z } from "zod";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { AuditRequestPayload } from "@acu/seal";
import type { AuditorConfig } from "./config.js";
import { makeAuditor } from "./audit.js";
import { issueSealB } from "./seal.js";

export interface MountedAuditor {
  /** The inference model the route will actually bill for. */
  model: string;
  /** The object `GET /agent` serves: who a caller would be hiring, before paying. */
  agentCard: () => Record<string, unknown>;
}

/** What Agent A must send. Anything else is rejected before a cent is spent. */
const AuditBody = z.object({
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  artifact: z.string().min(1).max(200_000),
  requestedAt: z.number().int().positive(),
  nonce: z.string().min(1).max(128),
});

/**
 * Mounts `GET /agent` (free) and `POST /audit` (x402-paid) on `app`.
 *
 * Body parsing belongs to the host app, not to this package: mount
 * `app.use(express.json({ limit: "1mb" }))` yourself before calling this. If a
 * request arrives with no parsed body, `POST /audit` answers 400 `BAD_REQUEST`
 * rather than pretending the body was empty.
 */
export function sealedAuditRoute(app: Express, config: AuditorConfig): MountedAuditor {
  const auditor = makeAuditor(config);

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

  const agentCard = (): Record<string, unknown> => ({
    agentId: config.agentId,
    service: "code-audit",
    sealSigner: config.sealAccount.address,
    payTo: config.payToAddress,
    price: config.priceUsd,
    network: config.network,
    model: auditor.model,
    ogNetwork: config.og.network,
    trustMode: "verified",
    skipsAttestation: config.og.skipAttestation,
  });

  /** Unprotected: lets a caller see who they would be hiring before paying. */
  app.get("/agent", (_req, res) => {
    res.json(agentCard());
  });

  app.post("/audit", async (req, res) => {
    // The host app owns body parsing. Say so out loud instead of parsing `undefined`.
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
      res.status(400).json({
        error: "BAD_REQUEST",
        detail: "body must be a JSON object (does the host app mount express.json()?)",
      });
      return;
    }

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
      console.error("[auditor] audit failed:", detail);
      // The payment settles on a 2xx; failing loudly here is what keeps Agent A
      // from paying for a seal that was never issued.
      res.status(502).json({ error: "AUDIT_FAILED", detail });
    }
  });

  return { model: auditor.model, agentCard };
}
