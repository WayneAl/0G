import { describe, expect, it } from "vitest";
import { auditorStatus } from "../src/status.js";

/**
 * The reference auditor runs on somebody's laptop. Offline is its ordinary
 * state, so it must be a pill on the page and never an exception — every
 * failure mode collapses to `online: false`.
 */
const CARD = {
  agentId: "2",
  service: "code-audit",
  sealSigner: "0xC1Dba83fd85838542b09ec44e6372485f6EE2D9E",
  price: "$0.01",
  network: "eip155:84532",
  model: "qwen2.5-omni",
  trustMode: "verified",
};

describe("auditorStatus", () => {
  it("reads the card from /agent on the origin", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(CARD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const status = await auditorStatus("https://tunnel.example/audit", fetchImpl);

    expect(seen).toEqual(["https://tunnel.example/agent"]);
    expect(status.online).toBe(true);
    expect(status.price).toBe("$0.01");
    expect(status.card).toEqual(CARD);
  });

  it("is offline when the fetch rejects", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    expect(await auditorStatus("http://localhost:4021", fetchImpl)).toEqual({
      online: false,
      card: null,
      price: null,
    });
  });

  it("is offline on a non-2xx answer", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;

    expect(await auditorStatus("http://localhost:4021", fetchImpl)).toEqual({
      online: false,
      card: null,
      price: null,
    });
  });

  it("is online with no price when the card omits one", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ agentId: "2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const status = await auditorStatus("http://localhost:4021", fetchImpl);
    expect(status.online).toBe(true);
    expect(status.price).toBeNull();
  });
});
