import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import {
  signSealA,
  verifySealB,
  StaticAgentIdResolver,
  SealVerificationError,
  auditRequestHash,
  type SealA,
  type SealB,
} from "@acu/seal";
import {
  listWithSeal,
  makeBudgetGate,
  mapListError,
  underwrite,
  type Stage,
  type StepEvent,
  type UnderwriteDeps,
} from "@acu/underwriter";
import { ogStoragePublisher, OG_TESTNET_INDEXER, OG_TESTNET_RPC } from "@acu/storage/publish";
import { loadFixture, fixtureRequest } from "./replay.js";

loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

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

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const token = positional[0];
  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    console.error("usage: pnpm --filter @acu/agent-a start -- <token> [--ltv 7000] [--live] [--no-settle]");
    process.exit(2);
  }
  const registry = flag("registry") ?? process.env["REGISTRY_ADDRESS"];
  return {
    token: token.toLowerCase() as `0x${string}`,
    ltvBps: Number(flag("ltv") ?? 7000),
    // Dry run is the default. Real money needs --live (spec §6.4).
    live: argv.includes("--live"),
    settle: !argv.includes("--no-settle"),
    publish: argv.includes("--publish"),
    endpoint: flag("endpoint") ?? process.env["AGENT_B_URL"] ?? "http://localhost:4021/audit",
    registry: registry ? (registry.toLowerCase() as `0x${string}`) : null,
    sourcePath: flag("source") ?? null,
    emitSeal: flag("emit-seal") ?? null,
    sealFile: flag("seal-file") ?? null,
    offline: flag("offline") ?? null,
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in environment`);
  return v;
}

const step = (n: string, msg: string) => console.log(`[${n}] ${msg}`);
const fail = (code: string, detail: string): never => {
  console.log(`\n✗ ${code}`);
  console.log(`  ${detail}`);
  process.exit(1);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const agentAKey = required("AGENT_A_PRIVATE_KEY") as `0x${string}`;
  const agentA = privateKeyToAccount(agentAKey);
  const agentAId = process.env["AGENT_A_ID"] ?? "1";
  const agentBId = process.env["AGENT_B_ID"] ?? "2";
  const agentBSealSigner = required("AGENT_B_SEAL_SIGNER") as `0x${string}`;
  const network = (process.env["PAYMENT_NETWORK"] ?? "eip155:84532") as `${string}:${string}`;

  console.log(`underwriting ${args.token}  requested LTV ${args.ltvBps} bps`);
  console.log(`mode: ${args.live ? "LIVE (real payment)" : "DRY RUN (no payment; pass --live to spend)"}\n`);

  // Replay path: present a seal that already exists, against whatever token the
  // caller names. Nothing stops someone doing this, which is exactly why the
  // seal binds its subject and the registry checks it (demo scene ③).
  if (args.sealFile) {
    step("R", `replaying seal from ${args.sealFile}`);
    const replayed = JSON.parse(readFileSync(args.sealFile, "utf8")) as SealA;
    step("R", `seal subject is ${replayed.subject}; listing it against ${args.token}`);
    if (!args.registry) return fail("NO_REGISTRY", "pass --registry <address> or set REGISTRY_ADDRESS");
    await submit(replayed, args.token, args.ltvBps, args.registry, agentA);
    return;
  }

  if (args.offline) return runOffline(args, agentA, agentAId, agentBId, agentBSealSigner, network);

  const deps: UnderwriteDeps = {
    account: agentA,
    agentId: agentAId,
    auditor: { url: args.endpoint, agentId: agentBId },
    resolver: new StaticAgentIdResolver({ [agentBId]: agentBSealSigner }),
    budget: makeBudgetGate(
      // The allowlist is the real protection. A compromised endpoint that quotes a
      // different payee is refused before anything is signed.
      [(process.env["AGENT_B_PAYTO"] ?? agentBSealSigner).toLowerCase() as `0x${string}`],
      new URL("../../.budget-ledger.json", import.meta.url).pathname,
    ),
    network,
    dryRun: !args.live,
    registry: args.registry,
    // Only built when asked for: constructing it is free, but --publish is what
    // says "spend 0G gas to put this body on the log layer".
    publisher: args.publish
      ? ogStoragePublisher({
          privateKey: agentAKey,
          rpcUrl: process.env["OG_RPC_URL"] ?? OG_TESTNET_RPC,
          indexerUrl: process.env["OG_INDEXER_URL"] ?? OG_TESTNET_INDEXER,
        })
      : null,
    onStep: printStep,
  };

  const result = await underwrite(
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

  if (!result.ok) return fail(result.code, result.detail);

  if (result.kind === "dry-run") {
    step("3", `quote ${result.quote.humanPrice} to ${result.quote.payTo} on ${network}`);
    step("3", `budget ok — ${result.budget}`);
    console.log("\n○ DRY RUN — stopped before signing. Re-run with --live to pay and continue.");
    return;
  }

  if (args.emitSeal) {
    writeFileSync(args.emitSeal, JSON.stringify(result.sealA, null, 2));
    step("6", `seal A written to ${args.emitSeal}`);
  }

  if (result.listing) {
    console.log(`\n✓ EXECUTED  ltv=${result.listing.ltvBps}bps  tx=${result.listing.txHash}`);
    return;
  }

  if (result.skipped.settle) {
    // The seal is good; this registry just does not trust this signer. Saying so
    // is the whole difference between "refused" and "not attempted".
    step("7", `skipped: ${result.skipped.settle}`);
    console.log(`\n${JSON.stringify(result.sealA, null, 2)}`);
    console.log(`\n○ NOT LISTED — ${result.skipped.settle}`);
    return;
  }
  console.log(`\n${JSON.stringify(result.sealA, null, 2)}`);
  console.log("\n○ --no-settle: seal A printed, nothing submitted on chain.");
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
): Promise<void> {
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
    return;
  }
  if (!f.listing) return fail("NO_RECORDED_LISTING", "this fixture never reached the registry");

  step("7", `registry outcome replayed from ${f.listing.txHash}`);
  if (f.listing.outcome === "EXECUTED") {
    console.log(`\n✓ EXECUTED  ltv=${f.listing.ltvBps}bps  tx=${f.listing.txHash}  (replayed)`);
  } else {
    console.log(`\n✗ ${f.listing.outcome}`);
    console.log(`  reverted by CollateralRegistry (replayed from ${f.listing.txHash})`);
    process.exit(1);
  }
}

async function submit(
  seal: SealA,
  token: `0x${string}`,
  ltvBps: number,
  registry: `0x${string}`,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<void> {
  try {
    const result = await listWithSeal(seal, token, ltvBps, { registry, account });
    console.log(`\n✓ EXECUTED  ltv=${result.listed.ltvBps}bps  tx=${result.txHash}`);
  } catch (err) {
    const { code, detail } = mapListError(err instanceof Error ? err.message : String(err));
    fail(code, detail);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
