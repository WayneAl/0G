import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import {
  signSealA,
  verifySealB,
  StaticAgentIdResolver,
  SealVerificationError,
  auditRequestHash,
  type AuditRequestPayload,
  type SealA,
  type SealB,
  type Unsigned,
} from "@acu/seal";
import { makeBudgetGate, BudgetExceededError } from "./budget.js";
import { fetchTokenArtifact, makeOgClient, renderArtifact } from "./chain.js";
import { hireAuditor, HireError } from "./hire.js";
import { listWithSeal } from "./settle.js";
import { loadFixture, fixtureRequest } from "./replay.js";

loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

interface Args {
  token: `0x${string}`;
  ltvBps: number;
  live: boolean;
  settle: boolean;
  endpoint: string;
  registry: `0x${string}` | null;
  sourcePath: string | null;
  /** Replaces the RPC read with a recorded artifact. Backs --offline (spec §10). */
  artifactFile: string | null;
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
    endpoint: flag("endpoint") ?? process.env["AGENT_B_URL"] ?? "http://localhost:4021/audit",
    registry: registry ? (registry.toLowerCase() as `0x${string}`) : null,
    sourcePath: flag("source") ?? null,
    artifactFile: flag("artifact-file") ?? null,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const agentA = privateKeyToAccount(required("AGENT_A_PRIVATE_KEY") as `0x${string}`);
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

  // (2) Free RPC read. No paid data purchase (spec §11).
  const source = args.sourcePath ? readFileSync(args.sourcePath, "utf8") : null;
  let artifactText: string;
  let ownAnalysis: { liquidityDepthUsd: string; top10HolderPct: number; sourceHash: `0x${string}` };

  if (args.artifactFile) {
    step("2", `reading recorded artifact from ${args.artifactFile}`);
    artifactText = readFileSync(args.artifactFile, "utf8");
    ownAnalysis = {
      liquidityDepthUsd: "0",
      top10HolderPct: 0,
      sourceHash: keccak256(toHex(artifactText)),
    };
  } else {
    step("2", "reading token from 0G testnet RPC");
    const artifact = await fetchTokenArtifact(makeOgClient(), args.token, source);
    step(
      "2",
      `${artifact.symbol ?? "?"} · ${artifact.bytecodeSize}B code · owner ${artifact.owner ?? "none"} · flagged selectors: ${artifact.presentSelectors.join(", ") || "none"}`,
    );
    artifactText = renderArtifact(artifact);
    ownAnalysis = {
      liquidityDepthUsd: artifact.liquidityDepthUsd,
      top10HolderPct: artifact.top10HolderPct ?? 0,
      sourceHash: artifact.sourceHash,
    };
  }

  const request: AuditRequestPayload = {
    token: args.token,
    artifact: artifactText,
    requestedAt: Math.floor(Date.now() / 1000),
    nonce: randomBytes(16).toString("hex"),
  };

  // (3) Hire Agent B over x402.
  step("3", `hiring agent B at ${args.endpoint}`);
  const budget = makeBudgetGate(
    // The allowlist is the real protection. A compromised endpoint that quotes a
    // different payee is refused before anything is signed.
    [(process.env["AGENT_B_PAYTO"] ?? agentBSealSigner).toLowerCase() as `0x${string}`],
    new URL("../../.budget-ledger.json", import.meta.url).pathname,
  );

  let hired;
  try {
    hired = await hireAuditor(
      { endpoint: args.endpoint, account: agentA, network, budget, dryRun: !args.live },
      request,
    );
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return fail("BUDGET_REFUSED", `${err.denial} — nothing was signed. ${budget.summary()}`);
    }
    if (err instanceof HireError) return fail(err.code, err.message);
    throw err;
  }

  if ("dryRun" in hired) {
    step("3", `quote ${hired.quote.humanPrice} to ${hired.quote.payTo} on ${network}`);
    step("3", `budget ok — ${budget.summary()}`);
    console.log("\n○ DRY RUN — stopped before signing. Re-run with --live to pay and continue.");
    return;
  }

  step("3", `paid ${hired.quote.humanPrice} · settlement ${hired.settlementTx ?? "(not reported)"}`);
  if (hired.audit) {
    step("4", `agent B returned ${hired.audit.action} maxLtvBps=${hired.audit.maxLtvBps}`);
  } else {
    step("4", "endpoint answered in its own shape — no audit object, no seal");
  }

  // (5) The trust boundary. Agent A must be able to reject Agent B on its own.
  step("5", "verifying seal B");
  if (hired.sealB === null) {
    // Scene ⑦: an ordinary x402 API. The fee cleared, an ALLOW came back, and
    // none of it is evidence. Refuse before the verifier even gets a look.
    return fail(
      "DELEGATE_SEAL_INVALID",
      "NO_SEAL — the service kept the fee and signed nothing. Nothing to verify, nothing to embed, nothing reaches the chain.",
    );
  }
  let sealB: SealB;
  try {
    sealB = await verifySealB(hired.sealB, {
      expectedSubject: args.token,
      expectedRequest: auditRequestHash(request),
      resolver: new StaticAgentIdResolver({ [agentBId]: agentBSealSigner }),
      now: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    if (err instanceof SealVerificationError) {
      return fail("DELEGATE_SEAL_INVALID", `${err.failure} — refusing to compose seal A. Nothing was submitted on chain.`);
    }
    throw err;
  }
  step("5", `seal B valid · signer ${agentBSealSigner} · attestation ${sealB.inference.teeAttestation ? "present" : "ABSENT"}`);

  // (6) Compose seal A around seal B. This is the chain.
  step("6", "composing seal A");
  const unsignedA: Unsigned<SealA> = {
    version: 1,
    type: "underwriting",
    agentId: agentAId,
    subject: args.token,
    delegations: [
      {
        agentId: agentBId,
        service: "code-audit",
        priceAtomic: hired.quote.amountAtomic.toString(),
        network,
        settlementTx: hired.settlementTx,
        seal: sealB,
        sealVerified: true,
      },
    ],
    ownAnalysis,
    verdict: {
      // Agent A relays the auditor's verdict rather than softening it, and can
      // only ever tighten the cap, never raise it.
      action: sealB.verdict.action,
      maxLtvBps: Math.min(sealB.verdict.maxLtvBps, args.ltvBps > 0 ? sealB.verdict.maxLtvBps : 0),
      expiresAt: sealB.expiresAt,
    },
  };
  const sealA = await signSealA(unsignedA, agentA);
  step("6", `seal A signed · embeds seal B · maxLtvBps ${sealA.verdict.maxLtvBps}`);
  if (args.emitSeal) {
    writeFileSync(args.emitSeal, JSON.stringify(sealA, null, 2));
    step("6", `seal A written to ${args.emitSeal}`);
  }

  if (!args.settle) {
    console.log(`\n${JSON.stringify(sealA, null, 2)}`);
    console.log("\n○ --no-settle: seal A printed, nothing submitted on chain.");
    return;
  }
  if (!args.registry) return fail("NO_REGISTRY", "pass --registry <address> or set REGISTRY_ADDRESS");

  // (7) Present it to the contract.
  step("7", `listing on CollateralRegistry ${args.registry}`);
  await submit(sealA, args.token, args.ltvBps, args.registry, agentA);
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
    const msg = err instanceof Error ? err.message : String(err);
    const named = msg.match(/(SEAL_SUBJECT_MISMATCH|AUDIT_FAILED|LTV_EXCEEDS_ATTESTED|SEAL_EXPIRED|NO_SEAL|BAD_SIGNATURE)/);
    fail(named?.[1] ?? "LIST_FAILED", named ? "reverted by CollateralRegistry" : msg.slice(0, 300));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
