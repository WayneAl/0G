import { config as loadEnv } from "dotenv";
import { readFileSync } from "node:fs";
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
  step("4", `agent B returned ${hired.audit.action} maxLtvBps=${hired.audit.maxLtvBps}`);

  // (5) The trust boundary. Agent A must be able to reject Agent B on its own.
  step("5", "verifying seal B");
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

  if (!args.settle) {
    console.log(`\n${JSON.stringify(sealA, null, 2)}`);
    console.log("\n○ --no-settle: seal A printed, nothing submitted on chain.");
    return;
  }
  if (!args.registry) return fail("NO_REGISTRY", "pass --registry <address> or set REGISTRY_ADDRESS");

  // (7) Present it to the contract.
  step("7", `listing on CollateralRegistry ${args.registry}`);
  try {
    const result = await listWithSeal(sealA, args.ltvBps, { registry: args.registry, account: agentA });
    console.log(`\n✓ EXECUTED  ltv=${result.listed.ltvBps}bps  tx=${result.txHash}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const named = msg.match(/(SEAL_SUBJECT_MISMATCH|AUDIT_FAILED|LTV_EXCEEDS_ATTESTED|SEAL_EXPIRED|NO_SEAL|BAD_SIGNATURE)/);
    return fail(named?.[1] ?? "LIST_FAILED", named ? "reverted by CollateralRegistry" : msg.slice(0, 300));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
