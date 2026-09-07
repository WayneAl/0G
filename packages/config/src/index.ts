import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one place a key and its settings are read from, for every shell.
 *
 * The CLI writes this file; the CLI, the MCP and anything else read it. That is
 * the whole point of Decision I: `acu init` once, and the agent's own MCP server
 * picks the same key up with zero environment variables and no re-install.
 *
 * Two rules hold it together:
 * - **Precedence is env > file > built-in default**, everywhere, via `resolve`.
 *   An operator can always override the file for one process without editing it.
 * - **A published package never reads the repo's `.env`.** This module depends on
 *   node builtins and nothing else, so importing it can never drag `dotenv`, a
 *   parser, or a network client into a shell that only wanted to know its key.
 *
 * The file holds a private key, so it is written `0600` inside a `0700`
 * directory, and it is written atomically: a half-written config would be a lost
 * key, and a lost key that was funded is a lost afternoon.
 */
export interface UserConfig {
  agentKey: `0x${string}` | null;
  agentId: string | null;
  directoryUrl: string | null;
  auditorUrl: string | null;
  registry: `0x${string}` | null;
  ledgerPath: string | null;
  webUrl: string | null;
}

/** Every field this module reads back. Anything else in the file is left alone. */
const FIELDS = [
  "agentKey",
  "agentId",
  "directoryUrl",
  "auditorUrl",
  "registry",
  "ledgerPath",
  "webUrl",
] as const;

const EMPTY: UserConfig = {
  agentKey: null,
  agentId: null,
  directoryUrl: null,
  auditorUrl: null,
  registry: null,
  ledgerPath: null,
  webUrl: null,
};

/**
 * `ACU_HOME`, or `~/.acu`.
 *
 * Read fresh on every call rather than captured at import: a test points
 * `ACU_HOME` at a temp directory, and a module-level constant would have
 * resolved the developer's real home before the test ever ran.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["ACU_HOME"];
  return home !== undefined && home.trim() !== "" ? home : join(homedir(), ".acu");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

/**
 * The config as it is on disk. Absence is not a failure; corruption is.
 *
 * No file, no directory → every field null, because "you have not run `acu init`
 * yet" is the most ordinary state a first-run user can be in. A file that exists
 * but cannot be parsed, or cannot be read at all, throws: reading a damaged
 * config as "no key" would send someone to `init` to generate a second key over
 * the top of a funded one.
 */
export function readUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const path = configPath(env);
  const raw = readRaw(path);
  if (raw === null) return { ...EMPTY };

  const config: UserConfig = { ...EMPTY };
  for (const field of FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new Error(`CONFIG_MALFORMED: ${path} — ${field} must be a string, got ${typeof value}`);
    }
    // The two hex fields are typed tighter than the file can promise; anything
    // that reaches here is a string either way, and the caller validates shape.
    config[field] = value as `0x${string}` & string;
  }
  return config;
}

/**
 * Merges `patch` into the file and writes it back, atomically.
 *
 * Merge, not replace: `acu init` writes a key, a later command writes an auditor
 * URL, and neither may erase the other. Keys this module does not know are
 * carried through untouched, so a newer version of the CLI writing a field an
 * older one has never heard of does not lose it. An explicit `null` in the patch
 * clears a field — that is how you take something back out.
 *
 * `replaceUnreadable` is the escape hatch for a file that will not parse: the
 * merge has nothing to merge with, so it starts from empty and overwrites. Only
 * `acu init --force` passes it, because that is the one command whose whole job
 * is to replace what is there — refusing to write over a truncated file would
 * leave the user with no way back at all.
 */
export function writeUserConfig(
  patch: Partial<UserConfig>,
  env: NodeJS.ProcessEnv = process.env,
  opts: { replaceUnreadable?: boolean } = {},
): UserConfig {
  const dir = configDir(env);
  const path = configPath(env);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask and ignored entirely for a directory
  // that already existed. This is a directory that holds a private key, so say
  // what it must be rather than what the shell's umask left behind.
  chmodSync(dir, 0o700);

  const merged: Record<string, unknown> = { ...(existing(path, opts.replaceUnreadable === true) ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }

  // tmp + rename: a crash mid-write leaves the old config intact rather than a
  // truncated file where a key used to be. The tmp file is born 0600, so the key
  // is never briefly world-readable, and rename carries that mode across.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up: the write is the failure being reported below.
    }
    throw err;
  }

  return readUserConfig(env);
}

/**
 * env > file > default, in that order — the precedence every shell uses.
 *
 * An empty environment variable counts as unset: `ACU_AUDITOR_URL=` in a shell
 * profile or an MCP client's config means "I did not set this", never "use the
 * empty string". The value is trimmed because `KEY=$(cat key.txt)` arrives with
 * a newline on it more often than not.
 */
export function resolve<T>(envValue: string | undefined, fileValue: T | null, fallback: T): T {
  if (envValue !== undefined && envValue.trim() !== "") return envValue.trim() as unknown as T;
  return fileValue ?? fallback;
}

/**
 * What is already on disk, or nothing when it cannot be used as a base.
 *
 * A file that will not parse is still an error to everyone except a caller that
 * has said it means to replace it.
 */
function existing(path: string, replaceUnreadable: boolean): Record<string, unknown> | null {
  try {
    return readRaw(path);
  } catch (err) {
    if (replaceUnreadable && err instanceof Error && err.message.startsWith("CONFIG_MALFORMED:")) return null;
    throw err;
  }
}

/** The file as it literally is, or null when there is none. */
function readRaw(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // EACCES, EISDIR, a dangling symlink: a config that exists and will not
    // open is a fault, and saying "no key" here would hide it.
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`CONFIG_MALFORMED: ${path} — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`CONFIG_MALFORMED: ${path} — expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Where a shared seal is opened. The project's Pages site unless overridden.
 *
 * Here rather than in a shell, because a link minted by `acu underwrite` and one
 * minted by the MCP's `underwrite` tool must open the same verifier. Two
 * constants would drift the day one of them is pointed at a staging build, and
 * the seal that came back from the other shell would land on a 404.
 */
export const DEFAULT_WEB_URL = "https://wayneal.github.io/0G";

/**
 * An account for the dry-run path to hold and never use.
 *
 * `underwrite()` builds its deps before it knows whether it will sign, so it
 * needs *an* account even when there is nothing to sign with. This is private
 * key 1 — the smallest valid secp256k1 scalar, public knowledge, funded nowhere
 * we care about, and unreachable, because `dryRun` is forced true whenever
 * `agentKey` is null.
 */
export const DRY_RUN_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

/**
 * A link that carries the seal itself, not a pointer to one.
 *
 * The verifier page checks the fragment locally, so a link opened by someone who
 * has never heard of us proves the same thing. Fragments are never sent to a
 * server, which is the point: sharing a seal must not require trusting a host.
 *
 * Takes the URL rather than a config object so this module stays free of every
 * package's own config type — and takes the seal as `object`, so `@0x402/config`
 * never has to depend on `@0x402/seal` to render a link.
 */
export function shareUrl(webUrl: string, seal: object): string {
  return `${webUrl}/#seal=${Buffer.from(JSON.stringify(seal), "utf8").toString("base64url")}`;
}
