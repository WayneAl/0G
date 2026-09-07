import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import {
  DEFAULT_WEB_URL,
  DRY_RUN_KEY,
  configDir,
  configPath,
  readUserConfig,
  resolve,
  shareUrl,
  type UserConfig,
} from "@acu/config";
import {
  signSealA,
  verifySealB,
  Directory,
  StaticAgentIdResolver,
  HttpAgentIdResolver,
  resolverFromDirectory,
  SealVerificationError,
  auditRequestHash,
  type AgentIdResolver,
  type SealA,
  type SealB,
} from "@acu/seal";
import {
  BASE_SEPOLIA_RPC,
  BASE_SEPOLIA_USDC,
  CIRCLE_FAUCET,
  listWithSeal,
  makeBudgetGate,
  mapListError,
  underwrite,
  type Stage,
  type StepEvent,
  type UnderwriteDeps,
} from "@acu/underwriter";
import { ogStoragePublisher, OG_TESTNET_INDEXER, OG_TESTNET_RPC } from "@acu/storage/publish";
import { loadFixture, fixtureRequest } from "../replay.js";
import { REFERENCE_DIRECTORY } from "./verify.js";

export { DEFAULT_WEB_URL, DRY_RUN_KEY, shareUrl };

interface Args {
  token: `0x${string}`;
  ltvBps: number;
  live: boolean;
  settle: boolean;
  /** Upload the seal A body to 0G Storage after signing it. */
  publish: boolean;
  endpoint: string;
  registry: `0x${string}` | null;
  sourcePath: string | null;
  /** Write the composed seal A here, so a later run can replay it. */
  emitSeal: string | null;
  /** Skip underwriting and present an already-issued seal A. Demo scene ③. */
  sealFile: string | null;
  /** Replay a recorded run. The venue wifi is going to die (spec §10). */
  offline: string | null;
}

/** Null when the arguments do not name a token; the caller exits 2. */
function parseArgs(argv: string[], config: CliConfig): Args | null {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const token = positional[0];
  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    console.error("usage: acu underwrite <token> [--ltv 7000] [--live] [--no-settle]");
    return null;
  }
  const registry = flag("registry") ?? config.registry;
  return {
    token: token.toLowerCase() as `0x${string}`,
    ltvBps: Number(flag("ltv") ?? 7000),
    // Dry run is the default. Real money needs --live (spec §6.4).
    live: argv.includes("--live"),
    settle: !argv.includes("--no-settle"),
    publish: argv.includes("--publish"),
    endpoint: flag("endpoint") ?? config.auditorUrl,
    registry: registry ? (registry.toLowerCase() as `0x${string}`) : null,
    sourcePath: flag("source") ?? null,
    emitSeal: flag("emit-seal") ?? null,
    sealFile: flag("seal-file") ?? null,
    offline: flag("offline") ?? null,
  };
}

/**
 * Everything the commands need, resolved once: **env > ~/.acu/config.json >
 * built-in default**, and nothing else. No `.env` is read here — that line lives
 * in the `agent-a` example, which is a repo-local script, and not in a package
 * anyone can `npx`.
 *
 * The `ACU_*` names are the published ones. The `AGENT_*` names are what the
 * reference pair's `.env` has always used and are still honoured, one rung
 * below, so the demo runner keeps working unchanged.
 */
export interface CliConfig {
  agentKey: `0x${string}` | null;
  agentId: string;
  auditorAgentId: string;
  auditorUrl: string;
  /** The auditor's seal signer, when an operator names one explicitly. */
  auditorSigner: `0x${string}` | null;
  allowedPayTo: `0x${string}`[] | null;
  directoryUrl: string;
  /** ACU_DIRECTORY_JSON — an inline directory, for a run with no network. */
  directoryJson: string | null;
  registry: `0x${string}` | null;
  network: `${string}:${string}`;
  rpcUrl: string;
  indexerUrl: string;
  ledgerPath: string;
  webUrl: string;
  faucetUrl: string;
  usdc: `0x${string}`;
  paymentRpcUrl: string;
}

export const DEFAULT_AUDITOR_URL = "http://localhost:4021/audit";

/** The first of these variables that is set to something non-empty. */
const envOf = (env: NodeJS.ProcessEnv, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
};

const lower = <T extends string>(value: string): T => value.toLowerCase() as T;

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * A key that is present and malformed is a fault; a key that is absent is not.
 *
 * Checked here rather than left to viem, which answers "invalid private key,
 * expected hex or 32 bytes" from five frames down and cannot say where the bad
 * value came from. Pasting a key into the wrong shell variable is an ordinary
 * mistake, and the fix depends entirely on which of the two places it landed in.
 * The value itself is never echoed — it is a secret even when it is wrong.
 */
function requireKey(value: string, fromEnv: boolean, env: NodeJS.ProcessEnv): `0x${string}` {
  if (HEX_KEY.test(value.trim())) return lower<`0x${string}`>(value.trim());
  const where = fromEnv ? "ACU_AGENT_KEY (or AGENT_A_PRIVATE_KEY)" : `agentKey in ${configPath(env)}`;
  throw new Error(`BAD_KEY: ${where} must be a 0x-prefixed 32-byte private key`);
}

export function resolveCliConfig(env: NodeJS.ProcessEnv = process.env, file?: UserConfig): CliConfig {
  const user = file ?? readUserConfig(env);
  const webUrl = resolve(envOf(env, "ACU_WEB_URL"), user.webUrl, DEFAULT_WEB_URL);
  const key = resolve<string | null>(envOf(env, "ACU_AGENT_KEY", "AGENT_A_PRIVATE_KEY"), user.agentKey, null);
  const registry = resolve<string | null>(
    envOf(env, "ACU_REGISTRY", "REGISTRY_ADDRESS"),
    user.registry,
    null,
  );
  const signer = envOf(env, "ACU_AUDITOR_SIGNER", "AGENT_B_SEAL_SIGNER");
  const payTo = envOf(env, "ACU_ALLOWED_PAYTO", "AGENT_B_PAYTO");

  return {
    agentKey: key === null ? null : requireKey(key, envOf(env, "ACU_AGENT_KEY", "AGENT_A_PRIVATE_KEY") !== undefined, env),
    agentId: resolve(envOf(env, "ACU_AGENT_ID", "AGENT_A_ID"), user.agentId, "1"),
    auditorAgentId: resolve(envOf(env, "ACU_AUDITOR_AGENT_ID", "AGENT_B_ID"), null, "2"),
    auditorUrl: resolve(envOf(env, "ACU_AUDITOR_URL", "AGENT_B_URL"), user.auditorUrl, DEFAULT_AUDITOR_URL),
    // Kept exactly as configured, checksum case and all: it is printed back at
    // step [5], and every comparison it feeds is case-insensitive already.
    auditorSigner: signer === undefined ? null : (signer as `0x${string}`),
    allowedPayTo:
      payTo === undefined
        ? null
        : payTo
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "")
            .map((s) => lower<`0x${string}`>(s)),
    directoryUrl: resolve(envOf(env, "ACU_DIRECTORY_URL"), user.directoryUrl, `${webUrl}/directory.json`),
    directoryJson: envOf(env, "ACU_DIRECTORY_JSON") ?? null,
    registry: registry === null ? null : lower<`0x${string}`>(registry),
    network: resolve(
      envOf(env, "ACU_PAYMENT_NETWORK", "PAYMENT_NETWORK"),
      null,
      "eip155:84532",
    ) as `${string}:${string}`,
    rpcUrl: resolve(envOf(env, "ACU_RPC_URL", "OG_RPC_URL"), null, OG_TESTNET_RPC),
    indexerUrl: resolve(envOf(env, "ACU_INDEXER_URL", "OG_INDEXER_URL"), null, OG_TESTNET_INDEXER),
    // The ledger is the customer's, and a published CLI has no repo to put it
    // in: it goes next to the config that names the key it protects.
    ledgerPath: resolve(envOf(env, "ACU_LEDGER_PATH"), user.ledgerPath, join(configDir(env), "budget-ledger.json")),
    webUrl,
    faucetUrl: resolve(envOf(env, "ACU_FAUCET_URL"), null, CIRCLE_FAUCET),
    usdc: resolve(envOf(env, "ACU_USDC"), null, BASE_SEPOLIA_USDC),
    paymentRpcUrl: resolve(envOf(env, "ACU_PAYMENT_RPC_URL"), null, BASE_SEPOLIA_RPC),
  };
}

/**
 * Who agent B is, and who this agent may pay.
 *
 * An explicitly configured signer wins and costs nothing. Otherwise the
 * published directory answers both questions — which is what makes `npx @acu/cli
 * underwrite <token>` work with no environment at all — and it is only fetched
 * when it is actually needed.
 */
export async function auditorTrust(
  config: CliConfig,
): Promise<{ resolver: AgentIdResolver; allowedPayTo: `0x${string}`[] }> {
  if (config.auditorSigner !== null) {
    return {
      resolver: new StaticAgentIdResolver({ [config.auditorAgentId]: config.auditorSigner }),
      allowedPayTo: config.allowedPayTo ?? [config.auditorSigner],
    };
  }

  if (config.directoryJson !== null) {
    const inline = Directory.parse(JSON.parse(config.directoryJson));
    return { resolver: resolverFromDirectory(inline), allowedPayTo: payToOf(config, inline) };
  }

  const resolver = new HttpAgentIdResolver(config.directoryUrl);
  let directory: Directory;
  try {
    directory = await resolver.directory();
  } catch (err) {
    // A first run has nothing configured and the published directory may not be
    // reachable — it is not up yet, or the machine is offline. Falling back to
    // the reference pair is what makes `acu quote <token>` work with no key and
    // no environment, which is the whole first step of the funnel. It is a
    // fallback and not a default: an unreachable directory is worth saying out
    // loud, on stderr, because a *configured* one failing is a real problem.
    console.error(
      `note: ${config.directoryUrl} could not be read ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `using the built-in reference agents. ` +
        `Set ACU_DIRECTORY_URL, ACU_DIRECTORY_JSON, or ACU_AUDITOR_SIGNER to name your own.`,
    );
    return {
      resolver: resolverFromDirectory(REFERENCE_DIRECTORY),
      allowedPayTo: payToOf(config, REFERENCE_DIRECTORY),
    };
  }
  return {
    resolver,
    allowedPayTo: payToOf(config, directory),
  };
}

/**
 * Nobody named a payee, so the auditors this agent already knows about are the
 * only addresses it may ever pay.
 */
const payToOf = (config: CliConfig, directory: Directory): `0x${string}`[] =>
  config.allowedPayTo ??
  directory.agents.filter((a) => a.role === "auditor").map((a) => lower<`0x${string}`>(a.signer));

/** What every command says when there is no key to sign with. */
export const NEXT_STEP_INIT = "Run: npx @acu/cli init";

const detailOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The code is printed on its own line; carrying it in the detail too is noise. */
export const withoutCode = (message: string): string => message.replace(/^[A-Z_]+: /, "");

const step = (n: string, msg: string) => console.log(`[${n}] ${msg}`);
const fail = (code: string, detail: string): number => {
  console.log(`\n✗ ${code}`);
  console.log(`  ${detail}`);
  return 1;
};

/**
 * The scene numbers the demo narrates. The library reports stages; this file is
 * the only place that knows they are printed as [2]…[7].
 */
const STAGE_STEP: Record<Stage, string> = {
  read: "2",
  quote: "3",
  hire: "4",
  verify: "5",
  compose: "6",
  publish: "S",
  settle: "7",
};

const printStep = (e: StepEvent): void =>
  // Paying is still part of the hire, but it is the last thing [3] says before
  // agent B answers as [4].
  step(e.stage === "hire" && e.message.startsWith("paid ") ? "3" : STAGE_STEP[e.stage], e.message);

/**
 * `acu underwrite <token>` — the reference Agent A, as a command.
 *
 * Returns the exit code instead of taking the process down with it, so the same
 * function serves the `acu` bin, the `agent-a` example, and a test.
 */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = resolveCliConfig(env);
  const args = parseArgs(argv, config);
  if (args === null) return 2;

  // Fetched at most once per run, and only when this run actually needs to know
  // who agent B is: a dry run against a configured signer touches no directory.
  let trustCache: Promise<Awaited<ReturnType<typeof auditorTrust>>> | null = null;
  const trust = (): Promise<Awaited<ReturnType<typeof auditorTrust>>> =>
    (trustCache ??= auditorTrust(config));

  // No key is a supported state: the run stops at the quote and says what to do
  // about it, rather than throwing a missing-variable error at someone who has
  // not been told they need one yet. The throwaway account below is built and
  // never reached, because dryRun is forced true.
  const agentAKey = config.agentKey ?? DRY_RUN_KEY;
  const hasKey = config.agentKey !== null;
  const agentA = privateKeyToAccount(agentAKey);
  const agentAId = config.agentId;
  const agentBId = config.auditorAgentId;
  const network = config.network;
  const live = args.live && hasKey;

  console.log(`underwriting ${args.token}  requested LTV ${args.ltvBps} bps`);
  console.log(`mode: ${live ? "LIVE (real payment)" : "DRY RUN (no payment; pass --live to spend)"}\n`);

  // Replay path: present a seal that already exists, against whatever token the
  // caller names. Nothing stops someone doing this, which is exactly why the
  // seal binds its subject and the registry checks it (demo scene ③).
  if (args.sealFile) {
    if (!hasKey) return fail("NO_KEY", `listing a seal signs a transaction. ${NEXT_STEP_INIT}`);
    step("R", `replaying seal from ${args.sealFile}`);
    const replayed = JSON.parse(readFileSync(args.sealFile, "utf8")) as SealA;
    step("R", `seal subject is ${replayed.subject}; listing it against ${args.token}`);
    if (!args.registry) return fail("NO_REGISTRY", "pass --registry <address> or set REGISTRY_ADDRESS");
    // A seal that was signed while the publisher was unavailable — `skipped.publish`
    // — otherwise has no way back onto the log layer, and a listing whose body
    // nobody can fetch is a hash pointing at nothing. This is the way back.
    if (args.publish) {
      const receipt = await ogStoragePublisher({
        privateKey: agentAKey,
        rpcUrl: config.rpcUrl,
        indexerUrl: config.indexerUrl,
      }).publish(replayed);
      step("S", `seal A on 0G Storage · root ${receipt.root} · txSeq ${receipt.txSeq}`);
    }
    return submit(replayed, args.token, args.ltvBps, args.registry, agentA);
  }

  if (args.offline) {
    if (!hasKey) return fail("NO_KEY", `replaying a run still signs a seal A. ${NEXT_STEP_INIT}`);
    let agentBSealSigner: `0x${string}` | null;
    try {
      agentBSealSigner = config.auditorSigner ?? (await trust().then((t) => t.resolver.resolve(agentBId)));
    } catch (err) {
      return fail("NO_DIRECTORY", withoutCode(detailOf(err)));
    }
    if (agentBSealSigner === null) {
      return fail("NO_AUDITOR_SIGNER", `agent ${agentBId} is not in ${config.directoryUrl}; set ACU_AUDITOR_SIGNER`);
    }
    return runOffline(args, agentA, agentAId, agentBId, agentBSealSigner, network);
  }

  let trusted: Awaited<ReturnType<typeof auditorTrust>>;
  try {
    trusted = await trust();
  } catch (err) {
    return fail("NO_DIRECTORY", withoutCode(detailOf(err)));
  }
  const { resolver, allowedPayTo } = trusted;

  const emitSeal = args.emitSeal;
  const deps: UnderwriteDeps = {
    account: agentA,
    agentId: agentAId,
    auditor: { url: args.endpoint, agentId: agentBId },
    resolver,
    budget: makeBudgetGate(
      // The allowlist is the real protection. A compromised endpoint that quotes a
      // different payee is refused before anything is signed.
      allowedPayTo,
      config.ledgerPath,
    ),
    network,
    dryRun: !live,
    registry: args.registry,
    rpcUrl: config.rpcUrl,
    // Only built when asked for: constructing it is free, but --publish is what
    // says "spend 0G gas to put this body on the log layer".
    publisher:
      args.publish && hasKey
        ? ogStoragePublisher({
            privateKey: agentAKey,
            rpcUrl: config.rpcUrl,
            indexerUrl: config.indexerUrl,
          })
        : null,
    onStep: printStep,
    // Written the moment the seal exists, not after the run survives. The seal is
    // the evidence for a payment that has already happened; a listing that
    // reverts afterwards must not take it with it.
    ...(emitSeal === null
      ? {}
      : {
          onSealA: (seal: SealA): void => {
            writeFileSync(emitSeal, JSON.stringify(seal, null, 2));
            step("6", `seal A written to ${emitSeal}`);
          },
        }),
  };

  // Which step was in flight when something threw. The library returns refusals
  // and throws only for a broken environment, so this is how a dead auditor is
  // told apart from a dead RPC once the throw has escaped.
  let stage: Stage = "read";
  const onStep = deps.onStep;
  deps.onStep = (e) => {
    stage = e.stage;
    onStep?.(e);
  };

  let result: Awaited<ReturnType<typeof underwrite>>;
  try {
    result = await underwrite(
      {
        token: args.token,
        ltvBps: args.ltvBps,
        // (2) Free RPC read. No paid data purchase (spec §11).
        source: args.sourcePath ? readFileSync(args.sourcePath, "utf8") : null,
        settle: args.settle,
        publish: args.publish,
      },
      deps,
    );
  } catch (err) {
    // A dead RPC is a broken environment and stays an exception, which is the
    // judgement `underwrite()` itself makes. A dead auditor is an ordinary
    // Tuesday and gets a code the reader can act on.
    if (stage === "read") throw err;
    if (stage !== "quote" && stage !== "hire") throw err;
    return fail("AUDITOR_UNREACHABLE", `${args.endpoint} — ${detailOf(err)}`);
  }

  if (!result.ok) return fail(result.code, result.detail);

  if (result.kind === "dry-run") {
    step("3", `quote ${result.quote.humanPrice} to ${result.quote.payTo} on ${network}`);
    step("3", `budget ok — ${result.budget}`);
    console.log("\n○ DRY RUN — stopped before signing. Re-run with --live to pay and continue.");
    // The one line that turns a dry run into a next step. It goes after the
    // verdict, so the frozen last-line contract is untouched.
    if (!hasKey) console.log(`\nNext: ${NEXT_STEP_INIT}`);
    return 0;
  }

  if (result.listing) {
    console.log(`\n✓ EXECUTED  ltv=${result.listing.ltvBps}bps  tx=${result.listing.txHash}`);
    console.log(`\nShare it: ${shareUrl(config.webUrl, result.sealA)}`);
    return 0;
  }

  if (result.skipped.settle) {
    // The seal is good; this registry just does not trust this signer. Saying so
    // is the whole difference between "refused" and "not attempted".
    step("7", `skipped: ${result.skipped.settle}`);
    console.log(`\n${JSON.stringify(result.sealA, null, 2)}`);
    console.log(`\n○ NOT LISTED — ${result.skipped.settle}`);
    console.log(`\nShare it: ${shareUrl(config.webUrl, result.sealA)}`);
    return 0;
  }
  console.log(`\n${JSON.stringify(result.sealA, null, 2)}`);
  console.log("\n○ --no-settle: seal A printed, nothing submitted on chain.");
  console.log(`\nShare it: ${shareUrl(config.webUrl, result.sealA)}`);
  return 0;
}

/**
 * Replays a recorded run. Only the network hops are canned; every check Agent A
 * makes is executed for real against the recorded seal — see replay.ts.
 */
async function runOffline(
  args: Args,
  agentA: ReturnType<typeof privateKeyToAccount>,
  agentAId: string,
  agentBId: string,
  agentBSealSigner: `0x${string}`,
  network: `${string}:${string}`,
): Promise<number> {
  const f = loadFixture(args.offline!);
  step("2", `OFFLINE · replaying ${f.label} recorded ${f.recordedAt}`);
  const request = fixtureRequest(f);
  step("3", `quote ${f.quote.humanPrice} to ${f.quote.payTo} (replayed) · settlement ${f.settlementTx ?? "n/a"}`);
  step("4", `agent B returned ${f.audit.action} maxLtvBps=${f.audit.maxLtvBps} (replayed)`);

  // Real verification of the recorded seal. This is the part that must not be faked.
  step("5", "verifying seal B  [live cryptography, not replayed]");
  let sealB: SealB;
  try {
    sealB = await verifySealB(f.sealB, {
      expectedSubject: request.token,
      expectedRequest: auditRequestHash(request),
      resolver: new StaticAgentIdResolver({ [agentBId]: agentBSealSigner }),
      // The recording has a fixed issue time; judge expiry against it, not against
      // whenever the demo happens to run.
      now: request.requestedAt,
    });
  } catch (err) {
    if (err instanceof SealVerificationError) {
      return fail("DELEGATE_SEAL_INVALID", `${err.failure} — refusing to compose seal A. Nothing was submitted on chain.`);
    }
    throw err;
  }
  step("5", `seal B valid · signer ${agentBSealSigner} · attestation ${sealB.inference.teeAttestation ? "present" : "ABSENT"}`);

  step("6", "composing seal A  [signed live]");
  const sealA = await signSealA(
    {
      version: 1,
      type: "underwriting",
      agentId: agentAId,
      subject: request.token,
      delegations: [
        {
          agentId: agentBId,
          service: "code-audit",
          priceAtomic: f.quote.amountAtomic,
          network,
          settlementTx: (f.settlementTx as `0x${string}` | null) ?? null,
          seal: sealB,
          sealVerified: true,
        },
      ],
      ownAnalysis: {
        liquidityDepthUsd: "0",
        top10HolderPct: 0,
        sourceHash: keccak256(toHex(request.artifact)),
      },
      verdict: {
        action: sealB.verdict.action,
        maxLtvBps: sealB.verdict.maxLtvBps,
        expiresAt: sealB.expiresAt,
      },
    },
    agentA,
  );
  step("6", `seal A signed · embeds seal B · maxLtvBps ${sealA.verdict.maxLtvBps}`);
  if (args.emitSeal) writeFileSync(args.emitSeal, JSON.stringify(sealA, null, 2));

  if (!args.settle) {
    console.log("\n○ --no-settle: seal A printed, nothing submitted on chain.");
    return 0;
  }
  if (!f.listing) return fail("NO_RECORDED_LISTING", "this fixture never reached the registry");

  step("7", `registry outcome replayed from ${f.listing.txHash}`);
  if (f.listing.outcome === "EXECUTED") {
    console.log(`\n✓ EXECUTED  ltv=${f.listing.ltvBps}bps  tx=${f.listing.txHash}  (replayed)`);
    return 0;
  }
  console.log(`\n✗ ${f.listing.outcome}`);
  console.log(`  reverted by CollateralRegistry (replayed from ${f.listing.txHash})`);
  return 1;
}

async function submit(
  seal: SealA,
  token: `0x${string}`,
  ltvBps: number,
  registry: `0x${string}`,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<number> {
  try {
    const result = await listWithSeal(seal, token, ltvBps, { registry, account });
    console.log(`\n✓ EXECUTED  ltv=${result.listed.ltvBps}bps  tx=${result.txHash}`);
    return 0;
  } catch (err) {
    const { code, detail } = mapListError(err instanceof Error ? err.message : String(err));
    return fail(code, detail);
  }
}
