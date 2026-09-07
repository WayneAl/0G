import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { auditorTrust, resolveCliConfig, DEFAULT_AUDITOR_URL } from "../src/commands/underwrite.js";

const home = (): NodeJS.ProcessEnv => ({ ACU_HOME: mkdtempSync(join(tmpdir(), "acu-cli-")) });

const capture = (env: NodeJS.ProcessEnv): { io: { out: (l: string) => void; env: NodeJS.ProcessEnv }; text: () => string } => {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), env }, text: () => lines.join("\n") };
};

const repoFile = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

/**
 * The seals the browser verifier ships, read from the same files it reads.
 *
 * They are moving from `verifier/` into `web/public/examples/` as the site is
 * built; look in both rather than pinning a path that is mid-flight, and say so
 * loudly if they are in neither.
 */
const fixture = (name: string): string => {
  for (const rel of [`web/public/examples/${name}`, `verifier/${name}`]) {
    if (existsSync(repoFile(rel))) return repoFile(rel);
  }
  throw new Error(`example seal ${name} is in neither web/public/examples/ nor verifier/`);
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

  it("names three fixes instead of throwing when the directory cannot be fetched", async () => {
    // Port 1 is not a port anything listens on: reachably absent, no socket
    // leaves the machine.
    const env = { ...home(), ACU_DIRECTORY_URL: "http://127.0.0.1:1/directory.json" };
    await expect(auditorTrust(resolveCliConfig(env))).rejects.toThrow(/^NO_DIRECTORY: /);

    const { io, text } = capture(env);
    expect(await main(["quote", "0xdb08ce217ce842b06baf76a0bbb2c10f47ff9eb8"], io)).toBe(1);
    expect(text()).toContain("✗ NO_DIRECTORY");
    expect(text()).toContain("ACU_AUDITOR_SIGNER");
  });
});
