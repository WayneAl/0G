import { config as loadEnv } from "dotenv";
import express from "express";
import { sealedAuditRoute } from "@0x402/auditor";
import { loadConfig } from "./config.js";

loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

const config = loadConfig();

const app = express();
app.use(express.json({ limit: "1mb" }));

const mounted = sealedAuditRoute(app, config);

app.listen(config.port, () => {
  console.log(`[agent-b] listening on :${config.port}`);
  console.log(`  agentId      ${config.agentId}`);
  console.log(`  seal signer  ${config.sealAccount.address}`);
  console.log(`  payTo        ${config.payToAddress}  (${config.priceUsd}, ${config.network})`);
  console.log(`  facilitator  ${config.facilitatorUrl}`);
  console.log(`  inference    ${mounted.model} on 0G ${config.og.network}`);
  if (config.og.skipAttestation) {
    console.log(`  !! AGENT_B_SKIP_ATTESTATION=1 -- seals will claim verified and carry no evidence`);
  }
});
