import { describe, it, expect } from "vitest";
import { Directory, HttpAgentIdResolver, resolverFromDirectory } from "../src/index.js";

/**
 * The signer Agent B actually used for `verifier/examples.json`, checksummed as
 * viem recovers it. Checksum casing is the point of the lowercasing assertions:
 * every other consumer compares addresses against seal fields that were
 * canonicalized to lowercase.
 */
const B_SIGNER = "0xC1Dba83fd85838542b09ec44e6372485f6EE2D9E";
const A_SIGNER = "0x6ddF162A95123AaD1355E5D2FB66C2B1015Adc41";

const DIRECTORY_BODY = {
  agents: [
    { agentId: "2", signer: B_SIGNER, role: "auditor", endpoint: "http://localhost:4021/audit", price: "0.01" },
    { agentId: "1", signer: A_SIGNER, role: "underwriter" },
  ],
};

function countingFetch(body: unknown, status = 200): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

describe("HttpAgentIdResolver", () => {
  it("resolves a known agentId to its lowercased signer", async () => {
    const { impl } = countingFetch(DIRECTORY_BODY);
    const resolver = new HttpAgentIdResolver("https://directory.example/agents.json", impl);
    expect(await resolver.resolve("2")).toBe(B_SIGNER.toLowerCase());
  });

  it("resolves an unknown agentId to null rather than guessing", async () => {
    const { impl } = countingFetch(DIRECTORY_BODY);
    const resolver = new HttpAgentIdResolver("https://directory.example/agents.json", impl);
    expect(await resolver.resolve("9")).toBeNull();
  });

  it("fetches the directory exactly once across two resolves", async () => {
    const { impl, calls } = countingFetch(DIRECTORY_BODY);
    const resolver = new HttpAgentIdResolver("https://directory.example/agents.json", impl);
    await resolver.resolve("1");
    await resolver.resolve("2");
    expect(calls()).toBe(1);
  });

  it("hands back the parsed directory", async () => {
    const { impl } = countingFetch(DIRECTORY_BODY);
    const resolver = new HttpAgentIdResolver("https://directory.example/agents.json", impl);
    const dir = await resolver.directory();
    expect(dir.agents.map((a) => a.agentId)).toEqual(["2", "1"]);
    expect(dir.agents[0]?.endpoint).toBe("http://localhost:4021/audit");
  });

  it("throws the zod issue on a malformed directory instead of resolving nothing", async () => {
    const { impl } = countingFetch({ agents: [{ agentId: "2", signer: "not-an-address", role: "auditor" }] });
    const resolver = new HttpAgentIdResolver("https://directory.example/agents.json", impl);
    await expect(resolver.resolve("2")).rejects.toThrow(/expected 0x-prefixed 20-byte hex/);
  });

  it("throws on a non-2xx directory instead of treating it as empty", async () => {
    const { impl } = countingFetch("not found", 404);
    const resolver = new HttpAgentIdResolver("https://directory.example/agents.json", impl);
    await expect(resolver.resolve("2")).rejects.toThrow(/DIRECTORY_UNREACHABLE: 404/);
  });
});

describe("resolverFromDirectory", () => {
  it("resolves every listed agent and nothing else", async () => {
    const resolver = resolverFromDirectory(Directory.parse(DIRECTORY_BODY));
    expect(await resolver.resolve("1")).toBe(A_SIGNER.toLowerCase());
    expect(await resolver.resolve("2")).toBe(B_SIGNER.toLowerCase());
    expect(await resolver.resolve("3")).toBeNull();
  });
});
