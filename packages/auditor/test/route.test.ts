import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { sealedAuditRoute } from "../src/route.js";

/**
 * The browser is the only reason CORS is here.
 *
 * The site's status pill fetches `GET /agent` from a page served somewhere else
 * entirely — GitHub Pages, or a laptop — to say whether the reference auditor is
 * up. That is a cross-origin read of a card that is already public. `POST /audit`
 * gets nothing: the x402 handshake is server-to-server, a browser never performs
 * it, and an allow-origin header there would only widen what a page can reach.
 */
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const config = {
  payToAddress: account.address,
  priceUsd: "$0.01",
  network: "eip155:84532" as const,
  // Port 1 is not a port anything listens on: nothing in this file leaves the
  // machine, and the paid route fails fast rather than waiting on a facilitator.
  facilitatorUrl: "http://127.0.0.1:1",
  sealAccount: account,
  agentId: "2",
  sealTtlSeconds: 86_400,
  og: { network: "testnet" as const, apiKey: "not-used-here", model: undefined, skipAttestation: false },
};

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  sealedAuditRoute(app, config);
  await new Promise<void>((done) => {
    server = app.listen(0, "127.0.0.1", done);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => void server.close(() => done()));
});

describe("sealedAuditRoute — what a browser may read", () => {
  it("lets any page read the agent card", async () => {
    const res = await fetch(`${origin}/agent`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(await res.json()).toMatchObject({ agentId: "2", sealSigner: account.address });
  });

  it("answers a preflight for the card without inventing one for the paid route", async () => {
    const res = await fetch(`${origin}/agent`, { method: "OPTIONS" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("gives the paid route no cross-origin access at all", async () => {
    // Whatever this answers — 402 from the x402 middleware, or a failure once it
    // cannot reach the facilitator — it must not be readable from a page.
    const res = await fetch(`${origin}/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: `0x${"22".repeat(20)}`, artifact: "x", requestedAt: 1, nonce: "n" }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
