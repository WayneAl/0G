import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_URL,
  DRY_RUN_KEY,
  configDir,
  configPath,
  readUserConfig,
  resolve,
  shareUrl,
  writeUserConfig,
} from "../src/index.js";

/**
 * Every case gets its own ACU_HOME, so nothing here can read or write the real
 * `~/.acu` — which on a developer's machine holds a funded burner key.
 */
const home = (): NodeJS.ProcessEnv => ({ ACU_HOME: mkdtempSync(join(tmpdir(), "acu-config-")) });

/** A key shape, not a key: 32 bytes of 0x11. Nothing has ever been sent to it. */
const KEY = `0x${"11".repeat(32)}` as const;

describe("where the config lives", () => {
  it("is ACU_HOME when set, and ~/.acu otherwise", () => {
    const env = home();
    expect(configDir(env)).toBe(env["ACU_HOME"]);
    expect(configPath(env)).toBe(join(env["ACU_HOME"] as string, "config.json"));
    expect(configDir({})).toBe(join(homedir(), ".acu"));
  });

  it("reads the environment fresh on every call", () => {
    const first = home();
    const second = home();
    expect(configDir(first)).not.toBe(configDir(second));
  });
});

describe("readUserConfig", () => {
  it("answers null for every field when there is no file", () => {
    expect(readUserConfig(home())).toEqual({
      agentKey: null,
      agentId: null,
      directoryUrl: null,
      auditorUrl: null,
      registry: null,
      ledgerPath: null,
      webUrl: null,
    });
  });

  it("answers null for every field when there is no directory either", () => {
    const env = { ACU_HOME: join(mkdtempSync(join(tmpdir(), "acu-config-")), "not", "created") };
    expect(readUserConfig(env).agentKey).toBeNull();
  });

  it("throws CONFIG_MALFORMED, naming the file, rather than reading as empty", () => {
    const env = home();
    writeFileSync(configPath(env), "{ this is not json");
    expect(() => readUserConfig(env)).toThrow(/^CONFIG_MALFORMED: .*config\.json — /);
  });

  it("throws when a known key holds something that is not a string", () => {
    const env = home();
    writeFileSync(configPath(env), JSON.stringify({ agentKey: 42 }));
    expect(() => readUserConfig(env)).toThrow(/CONFIG_MALFORMED/);
  });

  // root can read anything, so the case has nothing to say there.
  it.skipIf(process.getuid?.() === 0)("throws rather than silently ignoring a file it cannot read", () => {
    const env = home();
    writeFileSync(configPath(env), JSON.stringify({ agentId: "1" }), { mode: 0o600 });
    chmodSync(configPath(env), 0o000);
    expect(() => readUserConfig(env)).toThrow();
    chmodSync(configPath(env), 0o600);
  });
});

describe("writeUserConfig", () => {
  it("round-trips what it wrote", () => {
    const env = home();
    const merged = writeUserConfig({ agentKey: KEY, agentId: "7" }, env);
    expect(merged.agentKey).toBe(KEY);
    expect(readUserConfig(env)).toMatchObject({ agentKey: KEY, agentId: "7", registry: null });
  });

  it("writes the file 0600 and the directory 0700 — it holds a private key", () => {
    const env = home();
    writeUserConfig({ agentKey: KEY }, env);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
    expect(statSync(configDir(env)).mode & 0o777).toBe(0o700);
  });

  it("creates the directory when it is not there yet", () => {
    const env = { ACU_HOME: join(mkdtempSync(join(tmpdir(), "acu-config-")), "nested", "acu") };
    writeUserConfig({ agentId: "1" }, env);
    expect(statSync(configDir(env)).mode & 0o777).toBe(0o700);
    expect(readUserConfig(env).agentId).toBe("1");
  });

  it("merges over the file instead of replacing it, and keeps keys it does not know", () => {
    const env = home();
    mkdirSync(configDir(env), { recursive: true });
    writeFileSync(configPath(env), JSON.stringify({ agentKey: KEY, favouriteColour: "blue" }));

    const merged = writeUserConfig({ agentId: "9" }, env);
    expect(merged).toMatchObject({ agentKey: KEY, agentId: "9" });

    const raw = JSON.parse(readFileSync(configPath(env), "utf8")) as Record<string, unknown>;
    expect(raw["favouriteColour"]).toBe("blue");
    expect(raw["agentKey"]).toBe(KEY);
    expect(readUserConfig(env)).toMatchObject({ agentKey: KEY, agentId: "9" });
  });

  it("still refuses to merge into a file it cannot parse", () => {
    const env = home();
    writeFileSync(configPath(env), "{ truncated");
    expect(() => writeUserConfig({ agentId: "1" }, env)).toThrow(/CONFIG_MALFORMED/);
  });

  it("replaces an unparseable file when the caller says that is the point", () => {
    // `acu init --force` on a truncated config: refusing to write would leave
    // the user with no way back at all.
    const env = home();
    writeFileSync(configPath(env), "{ truncated");
    expect(writeUserConfig({ agentKey: KEY }, env, { replaceUnreadable: true }).agentKey).toBe(KEY);
    expect(readUserConfig(env).agentKey).toBe(KEY);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  });

  it("clears a field when the patch says null", () => {
    const env = home();
    writeUserConfig({ auditorUrl: "http://localhost:4021/audit" }, env);
    expect(writeUserConfig({ auditorUrl: null }, env).auditorUrl).toBeNull();
    expect(readUserConfig(env).auditorUrl).toBeNull();
  });
});

describe("resolve — env > file > default", () => {
  it("prefers the environment", () => {
    expect(resolve("env", "file", "dflt")).toBe("env");
  });

  it("falls back to the file when the environment is unset", () => {
    expect(resolve(undefined, "file", "dflt")).toBe("file");
  });

  it("treats an empty environment variable as unset", () => {
    expect(resolve("", "file", "dflt")).toBe("file");
    expect(resolve("   ", "file", "dflt")).toBe("file");
  });

  it("falls back to the default when neither is there", () => {
    expect(resolve(undefined, null, "dflt")).toBe("dflt");
    expect(resolve("", null, "dflt")).toBe("dflt");
  });

  it("trims the environment value, because shells add newlines", () => {
    expect(resolve(" 0xabc\n", null, "dflt")).toBe("0xabc");
  });
});

/**
 * The link is the artefact a user actually hands to someone else, and it is
 * minted by two different shells. These cases pin the one property that makes
 * that safe: whatever opens the link needs nothing but the link.
 */
describe("shareUrl", () => {
  const SEAL = { type: "underwriting", subject: "0xdb08", verdict: { ltvBps: 7000 } };

  it("carries the seal in the fragment, so no server ever sees it", () => {
    const url = shareUrl(DEFAULT_WEB_URL, SEAL);
    const [base, fragment] = url.split("#seal=");
    expect(base).toBe(`${DEFAULT_WEB_URL}/`);
    expect(JSON.parse(Buffer.from(fragment as string, "base64url").toString("utf8"))).toEqual(SEAL);
  });

  it("encodes base64url, because a seal in a query string would not survive one", () => {
    // "+" and "/" from plain base64 both change meaning inside a URL; a seal
    // whose encoding is mangled in transit verifies as tampered on arrival.
    const fragment = shareUrl("https://x", { s: "\u00ff".repeat(8) }).split("#seal=")[1];
    expect(fragment).not.toMatch(/[+/=]/);
  });

  it("follows a webUrl an operator overrode, so a staging build is shareable too", () => {
    expect(shareUrl("http://localhost:5173", SEAL)).toMatch(/^http:\/\/localhost:5173\/#seal=/);
  });
});

describe("DRY_RUN_KEY", () => {
  it("is a well-formed key nobody would ever fund", () => {
    // It has to satisfy viem so the dry-run path can build an account; it must
    // never be mistaken for a real one, which is why it is the public constant 1.
    expect(DRY_RUN_KEY).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(DRY_RUN_KEY)).toBe(1n);
  });
});
