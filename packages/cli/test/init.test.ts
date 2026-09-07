import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { configPath } from "@acu/config";
import { main } from "../src/index.js";

/**
 * A hermetic ACU_HOME per case, and an environment built from nothing: these
 * tests must never read the developer's real `~/.acu`, which holds a funded key.
 */
const home = (): NodeJS.ProcessEnv => ({ ACU_HOME: mkdtempSync(join(tmpdir(), "acu-cli-")) });

const capture = (env: NodeJS.ProcessEnv): { io: { out: (l: string) => void; env: NodeJS.ProcessEnv }; text: () => string } => {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), env }, text: () => lines.join("\n") };
};

const keyOnDisk = (env: NodeJS.ProcessEnv): string =>
  (JSON.parse(readFileSync(configPath(env), "utf8")) as { agentKey: string }).agentKey;

const KEY = `0x${"11".repeat(32)}`;

describe("acu init", () => {
  it("writes a key and tells you the address, the faucet and what to do next", async () => {
    const env = home();
    const { io, text } = capture(env);

    expect(await main(["init"], io)).toBe(0);

    const address = privateKeyToAccount(keyOnDisk(env) as `0x${string}`).address;
    expect(text()).toContain(address);
    expect(text()).toContain("https://faucet.circle.com");
    expect(text()).toContain("this is a burner key for testnet — never fund it with real money");
    expect(text()).toContain("Next: acu status");
    // Never the key itself, in any command.
    expect(text()).not.toContain(keyOnDisk(env));
  });

  it("writes the file 0600", async () => {
    const env = home();
    await main(["init"], capture(env).io);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing key, and leaves it exactly as it was", async () => {
    const env = home();
    await main(["init"], capture(env).io);
    const before = keyOnDisk(env);

    const second = capture(env);
    expect(await main(["init"], second.io)).toBe(1);
    expect(keyOnDisk(env)).toBe(before);
    expect(second.text()).toContain(privateKeyToAccount(before as `0x${string}`).address);
    expect(second.text()).toContain("--force");
  });

  it("replaces the key when --force says so", async () => {
    const env = home();
    await main(["init"], capture(env).io);
    const before = keyOnDisk(env);

    const forced = capture(env);
    expect(await main(["init", "--force"], forced.io)).toBe(0);
    expect(keyOnDisk(env)).not.toBe(before);
    expect(forced.text()).toContain(privateKeyToAccount(keyOnDisk(env) as `0x${string}`).address);
  });

  it("takes a key you already have", async () => {
    const env = home();
    const { io, text } = capture(env);
    expect(await main(["init", "--key", KEY], io)).toBe(0);
    expect(keyOnDisk(env)).toBe(KEY);
    expect(text()).toContain(privateKeyToAccount(KEY as `0x${string}`).address);
  });

  it("refuses something that is not a key rather than writing it", async () => {
    const env = home();
    const { io, text } = capture(env);
    expect(await main(["init", "--key", "hunter2"], io)).toBe(1);
    expect(text()).toContain("BAD_KEY");
    expect(() => keyOnDisk(env)).toThrow();
  });
});

/**
 * A config file that will not parse, or a key that is not a key, is the state
 * this package exists to protect. None of it may reach a user as a stack trace,
 * and `--force` — the documented way out — has to work on the broken file.
 */
describe("a config that is broken", () => {
  const broken = (): NodeJS.ProcessEnv => {
    const env = home();
    writeFileSync(configPath(env), '{"agentKey": "0x1111');
    return env;
  };

  it("refuses with CONFIG_MALFORMED from every command, never a stack trace", async () => {
    // A seal-shaped file, so `verify` reaches the config read rather than
    // stopping earlier on the seal itself.
    const seal = join(mkdtempSync(join(tmpdir(), "acu-seal-")), "seal.json");
    writeFileSync(seal, JSON.stringify({ type: "underwriting", subject: `0x${"ab".repeat(20)}` }));

    for (const argv of [["status"], ["init"], ["quote", "0xdb08ce217ce842b06baf76a0bbb2c10f47ff9eb8"], ["verify", seal]]) {
      const env = broken();
      const { io, text } = capture(env);
      expect(await main(argv, io), `${argv[0]} answered: ${text()}`).toBe(1);
      expect(text(), `${argv[0]}`).toContain("✗ CONFIG_MALFORMED");
      expect(text()).toContain(configPath(env));
      expect(text()).toContain("fix it or delete it, then run acu init");
    }
  });

  it("lets --force overwrite the file it cannot read", async () => {
    const env = broken();
    const { io, text } = capture(env);
    expect(await main(["init", "--force"], io), text()).toBe(0);
    expect(privateKeyToAccount(keyOnDisk(env) as `0x${string}`).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(text()).toContain("this is a burner key for testnet");
  });

  it("names the environment when the key in it is not a key", async () => {
    const { io, text } = capture({ ...home(), ACU_AGENT_KEY: "0xnotakey" });
    expect(await main(["status"], io)).toBe(1);
    expect(text()).toContain("✗ BAD_KEY");
    expect(text()).toContain("ACU_AGENT_KEY");
    // Never the key material itself, however wrong it is.
    expect(text()).not.toContain("0xnotakey");
  });

  it("names the file when the key in it is not a key", async () => {
    const env = home();
    writeFileSync(configPath(env), JSON.stringify({ agentKey: "0xnotakey" }));
    const { io, text } = capture(env);
    expect(await main(["status"], io)).toBe(1);
    expect(text()).toContain("✗ BAD_KEY");
    expect(text()).toContain(configPath(env));
    expect(text()).not.toContain("0xnotakey");
  });
});
