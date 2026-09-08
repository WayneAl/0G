import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { DEFAULT_REGISTRY } from "@0x402/config";
import { auditorTrust, resolveCliConfig, DEFAULT_AUDITOR_URL } from "../src/commands/underwrite.js";
import { REFERENCE_DIRECTORY } from "../src/commands/verify.js";

const home = (): NodeJS.ProcessEnv => ({ ACU_HOME: mkdtempSync(join(tmpdir(), "acu-cli-")) });

const capture = (env: NodeJS.ProcessEnv): { io: { out: (l: string) => void; env: NodeJS.ProcessEnv }; text: () => string } => {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), env }, text: () => lines.join("\n") };
};

const repoFile = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

/**
 * The seals the site ships, read from the same files it serves.
 *
 * `web/public/examples/` is where they live now that the single-file verifier is
 * gone; a missing one says so rather than failing later as a JSON parse error.
 */
const fixture = (name: string): string => {
  const path = repoFile(`web/public/examples/${name}`);
  if (!existsSync(path)) throw new Error(`example seal ${name} is not in web/public/examples/`);
  return path;
};

const SEAL_A = fixture("example-sealA.json");
const EXAMPLES = JSON.parse(readFileSync(fixture("examples.json"), "utf8")) as Record<string, unknown>;

describe("routing", () => {
  it("prints the five commands when asked for nothing", async () => {
    const { io, text } = capture(home());
    expect(await main([], io)).toBe(0);
    for (const c of ["init", "status", "quote", "underwrite", "verify"]) expect(text()).toContain(c);
  });

  it("prints the same help for --help", async () => {
    const { io, text } = capture(home());
    expect(await main(["--help"], io)).toBe(0);
    expect(text()).toContain("usage: acu <command>");
  });

  it("exits 2 on a command it does not have, and says which one", async () => {
    const { io, text } = capture(home());
    expect(await main(["nope"], io)).toBe(2);
    expect(text()).toContain("unknown command: nope");
    expect(text()).toContain("usage: acu <command>");
  });

  it("exits 2 when quote is given no token", async () => {
    const { io, text } = capture(home());
    expect(await main(["quote"], io)).toBe(2);
    expect(text()).toContain("usage: acu quote");
  });
});

describe("acu verify — local, no network", () => {
  it("accepts the real seal A that ships with the verifier", async () => {
    const { io, text } = capture(home());
    expect(await main(["verify", SEAL_A], io), text()).toBe(0);
    expect(text()).toContain("✓ VALID");
    expect(text()).toContain("Embedded seal B");
  });

  it("rejects the seal B whose verdict was rewritten in flight", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "acu-seal-")), "tampered.json");
    writeFileSync(path, JSON.stringify(EXAMPLES["tampered"]));

    const { io, text } = capture(home());
    expect(await main(["verify", path], io)).toBe(1);
    expect(text()).toContain("SIGNER_MISMATCH");
    // The rows before the failure were really run; the ones after were not.
    expect(text()).toContain("✓ Shape");
    expect(text()).toContain("not reached");
  });

  it("names the unattested seal B for what it is", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "acu-seal-")), "noattest.json");
    writeFileSync(path, JSON.stringify(EXAMPLES["noattest"]));

    const { io, text } = capture(home());
    expect(await main(["verify", path], io)).toBe(1);
    expect(text()).toContain("ATTESTATION_MISSING");
  });

  it("refuses a file that is not a seal without crashing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "acu-seal-")), "junk.json");
    writeFileSync(path, "{ not json");
    const { io, text } = capture(home());
    expect(await main(["verify", path], io)).toBe(1);
    expect(text()).toContain("✗ UNREADABLE");
  });

  it("exits 2 with a usage line when given no file", async () => {
    const { io, text } = capture(home());
    expect(await main(["verify"], io)).toBe(2);
    expect(text()).toContain("usage: acu verify");
  });
});

describe("config resolution — env > file > default", () => {
  it("falls back to the built-in default with no env and no file", () => {
    const config = resolveCliConfig(home());
    expect(config.agentKey).toBeNull();
    expect(config.auditorUrl).toBe(DEFAULT_AUDITOR_URL);
    expect(config.agentId).toBe("1");
  });

  it("reads the file the CLI wrote when the environment says nothing", async () => {
    const env = home();
    await main(["init"], capture(env).io);
    expect(resolveCliConfig(env).agentKey).not.toBeNull();
  });

  it("lets the environment win over the file", async () => {
    const env = home();
    await main(["init"], capture(env).io);
    const override = `0x${"22".repeat(32)}`;
    expect(resolveCliConfig({ ...env, ACU_AGENT_KEY: override }).agentKey).toBe(override);
  });

  it("still honours the reference pair's AGENT_* names, one rung below ACU_*", () => {
    const env = home();
    expect(resolveCliConfig({ ...env, AGENT_B_URL: "http://localhost:4022/audit" }).auditorUrl).toBe(
      "http://localhost:4022/audit",
    );
    expect(
      resolveCliConfig({ ...env, AGENT_B_URL: "http://a/audit", ACU_AUDITOR_URL: "http://b/audit" }).auditorUrl,
    ).toBe("http://b/audit");
  });

  it("puts the budget ledger next to the config, not in the package", () => {
    const env = home();
    expect(resolveCliConfig(env).ledgerPath).toBe(join(env["ACU_HOME"] as string, "budget-ledger.json"));
  });

  /**
   * The install line promises no environment variables. Without a built-in
   * registry, every settle refused before it had done anything — and told the
   * reader to pass a flag the MCP does not have.
   */
  it("knows the deployed registry without being told", () => {
    expect(resolveCliConfig(home()).registry).toBe(DEFAULT_REGISTRY);
  });

  it("lets an operator point at their own registry, from either name", () => {
    const mine = "0x00000000000000000000000000000000000000ff";
    expect(resolveCliConfig({ ...home(), ACU_REGISTRY: mine }).registry).toBe(mine);
    expect(resolveCliConfig({ ...home(), REGISTRY_ADDRESS: mine }).registry).toBe(mine);
  });
});

describe("who agent B is", () => {
  const SIGNER = "0xC1Dba83fd85838542b09ec44e6372485f6EE2D9E";

  it("takes a named signer without touching a directory at all", async () => {
    const { resolver, allowedPayTo } = await auditorTrust(
      resolveCliConfig({ ...home(), ACU_AUDITOR_SIGNER: SIGNER }),
    );
    expect(await resolver.resolve("2")).toBe(SIGNER);
    expect(allowedPayTo).toEqual([SIGNER]);
  });

  it("reads an inline directory, and pays only the auditors in it", async () => {
    const directory = JSON.stringify({
      agents: [{ agentId: "2", signer: SIGNER, role: "auditor" }],
    });
    const { resolver, allowedPayTo } = await auditorTrust(
      resolveCliConfig({ ...home(), ACU_DIRECTORY_JSON: directory }),
    );
    expect(await resolver.resolve("2")).toBe(SIGNER.toLowerCase());
    expect(allowedPayTo).toEqual([SIGNER.toLowerCase()]);
  });

  /**
   * An auditor may settle to a wallet that is not the key it seals with —
   * `AuditorConfig` says so and its agent card publishes both. An allowlist
   * built from `signer` alone refused to pay such an agent before the quote,
   * and the only way out was to set ACU_ALLOWED_PAYTO by hand.
   */
  it("allows the payee a directory names, not the seal signer that names it", async () => {
    const payTo = "0x00000000000000000000000000000000000000aa";
    const directory = JSON.stringify({
      agents: [{ agentId: "2", signer: SIGNER, role: "auditor", payTo }],
    });
    const { resolver, allowedPayTo } = await auditorTrust(
      resolveCliConfig({ ...home(), ACU_DIRECTORY_JSON: directory }),
    );

    // The seal is still checked against the signer; only the money moved.
    expect(await resolver.resolve("2")).toBe(SIGNER.toLowerCase());
    expect(allowedPayTo).toEqual([payTo]);
  });

  /**
   * The funnel's first promise is "works with no key and no environment", and a
   * first run has neither — nor, before the site is published, a directory it
   * can fetch. So an unreachable directory falls back to the reference pair
   * rather than ending the run.
   */
  it("falls back to the reference pair when the directory cannot be fetched", async () => {
    // Port 1 is not a port anything listens on: reachably absent, no socket
    // leaves the machine.
    const env = { ...home(), ACU_DIRECTORY_URL: "http://127.0.0.1:1/directory.json" };

    const notes: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]): void => void notes.push(args.join(" "));
    let trusted: Awaited<ReturnType<typeof auditorTrust>>;
    try {
      trusted = await auditorTrust(resolveCliConfig(env));
    } finally {
      console.error = realError;
    }

    for (const agent of REFERENCE_DIRECTORY.agents) {
      expect(await trusted.resolver.resolve(agent.agentId)).toBe(agent.signer.toLowerCase());
    }
    // Still an allowlist, and still only the auditors in the directory it used.
    expect(trusted.allowedPayTo).toEqual(
      REFERENCE_DIRECTORY.agents.filter((a) => a.role === "auditor").map((a) => a.signer.toLowerCase()),
    );
    // A fallback that happens silently is a default, and this is not one: a
    // configured directory that cannot be read is worth saying out loud.
    expect(notes.join("\n")).toContain("http://127.0.0.1:1/directory.json");
    expect(notes.join("\n")).toContain("ACU_AUDITOR_SIGNER");
  });

  /**
   * The fallback covers a directory that cannot be *reached*. A directory that
   * was supplied and is not a directory is a different thing — the operator
   * said something specific and got it wrong, and guessing past that would pay
   * an auditor they never named.
   */
  it("still refuses, with three named fixes, when the directory supplied is not one", async () => {
    const env = { ...home(), ACU_DIRECTORY_JSON: JSON.stringify({ agents: [{ nope: true }] }) };
    await expect(auditorTrust(resolveCliConfig(env))).rejects.toThrow();

    const { io, text } = capture(env);
    expect(await main(["quote", "0xdb08ce217ce842b06baf76a0bbb2c10f47ff9eb8"], io)).toBe(1);
    expect(text()).toContain("✗ NO_DIRECTORY");
  });
});

/**
 * `acu quote` is the first command in the funnel, run by someone who has
 * configured nothing. Both of the things that can be down have to name
 * themselves — and name the *right* one: `underwrite()` reads the token off the
 * 0G RPC at step (2), before the auditor is contacted at all, so labelling every
 * throw AUDITOR_UNREACHABLE sends people to debug an agent that is running.
 */
describe("acu quote — which end of the wire is down", () => {
  const SIGNER = "0xC1Dba83fd85838542b09ec44e6372485f6EE2D9E";
  const DEAD = "http://127.0.0.1:1";
  const TOKEN = "0xdb08ce217ce842b06baf76a0bbb2c10f47ff9eb8";

  // A named signer, so nothing here needs a directory it cannot fetch.
  const configured = (over: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...home(),
    ACU_AUDITOR_SIGNER: SIGNER,
    ...over,
  });

  it("names the 0G RPC when the token read is what failed", async () => {
    const env = configured({ ACU_RPC_URL: `${DEAD}/rpc` });
    const { io, text } = capture(env);

    expect(await main(["quote", TOKEN], io)).toBe(1);
    expect(text()).toContain("✗ RPC_UNREACHABLE");
    expect(text()).toContain(`${DEAD}/rpc`);
    expect(text()).not.toContain("AUDITOR_UNREACHABLE");
  });

  // The other half — an RPC that answers and an auditor that does not — needs a
  // live 0G read to get that far, so it is covered over the wire by the MCP
  // suite's "turns an auditor that never answers into a refusal at the quote
  // stage" rather than faked here.
});
