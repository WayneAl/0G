/**
 * Records a live run into a replay fixture, so the six scenes survive a dead
 * venue network (spec §10).
 *
 *   pnpm --filter @acu/agent-a record -- --token CLEAN_USD --label CleanUSD --ltv 7000
 *   pnpm --filter @acu/agent-a record -- --token CLEAN_USD --label "CleanUSD (no attestation)" \
 *        --endpoint http://localhost:4022/audit --out clean-noattest.json --expect-refusal
 *   pnpm --filter @acu/agent-a record -- --derive-tampered clean.json --out clean-tampered.json
 *
 * The fixture stores what crossed a network. It never stores a verdict for Agent
 * A's checks — those are re-run for real at replay time (see src/replay.ts).
 */
import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { verifySealB, StaticAgentIdResolver, auditRequestHash, signSealA, type SealB } from "@acu/seal";
import { keccak256, toHex } from "viem";
import {
  fetchTokenArtifact,
  hireAuditor,
  listWithSeal,
  makeBudgetGate,
  makeOgClient,
  renderArtifact,
} from "@acu/underwriter";

loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const OUT_DIR = new URL("../../demo/fixtures/replay/", import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

// --- derive a tampered fixture without spending an API call ------------------
const derive = flag("derive-tampered");
if (derive) {
  const src = JSON.parse(readFileSync(`${OUT_DIR}${derive}`, "utf8")) as {
    label: string;
    sealB: { verdict: { action: string; maxLtvBps: number } };
    audit: { action: string; maxLtvBps: number };
    listing: unknown;
  };
  const before = `${src.sealB.verdict.action}/${src.sealB.verdict.maxLtvBps}`;
  // Exactly what demo/mitm.ts does on the wire: rewrite the verdict, leave the
  // signature alone. The fixture is a genuinely forged seal, and Agent A's real
  // signature check is what rejects it at replay time.
  src.sealB.verdict.action = "ALLOW";
  src.sealB.verdict.maxLtvBps = 9000;
  src.audit.action = "ALLOW";
  src.audit.maxLtvBps = 9000;
  src.label = `${src.label} — verdict rewritten in flight`;
  src.listing = null;
  const out = flag("out") ?? "clean-tampered.json";
  writeFileSync(`${OUT_DIR}${out}`, JSON.stringify(src, null, 2));
  console.log(`derived ${out}: seal B verdict ${before} -> ALLOW/9000, signature untouched`);
  process.exit(0);
}

// --- record a live run -------------------------------------------------------
const tokenEnv = flag("token") ?? "CLEAN_USD";
const address = process.env[tokenEnv];
if (!address) throw new Error(`missing ${tokenEnv} in .env`);
const token = address.toLowerCase() as `0x${string}`;
const label = flag("label") ?? tokenEnv;
const ltvBps = Number(flag("ltv") ?? 7000);
const endpoint = flag("endpoint") ?? process.env["AGENT_B_URL"] ?? "http://localhost:4021/audit";
const sourcePath = flag("source");
const out = flag("out") ?? `${tokenEnv.toLowerCase().replace(/_/g, "")}.json`;
const expectRefusal = argv.includes("--expect-refusal");

const agentA = privateKeyToAccount(process.env["AGENT_A_PRIVATE_KEY"] as `0x${string}`);
const agentBId = process.env["AGENT_B_ID"] ?? "2";
const agentBSealSigner = process.env["AGENT_B_SEAL_SIGNER"] as `0x${string}`;
const network = (process.env["PAYMENT_NETWORK"] ?? "eip155:84532") as `${string}:${string}`;

console.log(`recording ${label} (${token}) via ${endpoint}`);

const source = sourcePath ? readFileSync(sourcePath, "utf8") : null;
const artifact = await fetchTokenArtifact(makeOgClient(), token, source);
const request = {
  token,
  artifact: renderArtifact(artifact),
  requestedAt: Math.floor(Date.now() / 1000),
  nonce: randomBytes(16).toString("hex"),
};

const budget = makeBudgetGate(
  [(process.env["AGENT_B_PAYTO"] ?? agentBSealSigner).toLowerCase() as `0x${string}`],
  new URL("../../.budget-ledger.json", import.meta.url).pathname,
);

const hired = await hireAuditor({ endpoint, account: agentA, network, budget, dryRun: false }, request);
if ("dryRun" in hired) throw new Error("unexpected dry run");
console.log(`  paid ${hired.quote.humanPrice} · agent B said ${hired.audit.action}/${hired.audit.maxLtvBps}`);

let listing: { txHash: string; outcome: string; ltvBps: number } | null = null;

if (expectRefusal) {
  console.log(`  --expect-refusal: not listing; agent A will refuse this seal at replay time`);
} else {
  // Verify for real, then actually list, so the fixture quotes a transaction that
  // genuinely happened rather than one we assumed would.
  const sealB: SealB = await verifySealB(hired.sealB, {
    expectedSubject: token,
    expectedRequest: auditRequestHash(request),
    resolver: new StaticAgentIdResolver({ [agentBId]: agentBSealSigner }),
    now: Math.floor(Date.now() / 1000),
  });
  const sealA = await signSealA(
    {
      version: 1,
      type: "underwriting",
      agentId: process.env["AGENT_A_ID"] ?? "1",
      subject: token,
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
      ownAnalysis: {
        liquidityDepthUsd: "0",
        top10HolderPct: 0,
        sourceHash: keccak256(toHex(request.artifact)),
      },
      verdict: { action: sealB.verdict.action, maxLtvBps: sealB.verdict.maxLtvBps, expiresAt: sealB.expiresAt },
    },
    agentA,
  );
  const registry = process.env["REGISTRY_ADDRESS"] as `0x${string}`;
  try {
    const r = await listWithSeal(sealA, token, ltvBps, { registry, account: agentA });
    listing = { txHash: r.txHash, outcome: "EXECUTED", ltvBps: r.listed.ltvBps };
    console.log(`  listed at ${r.listed.ltvBps}bps · ${r.txHash}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const named = msg.match(/(SEAL_SUBJECT_MISMATCH|AUDIT_FAILED|LTV_EXCEEDS_ATTESTED|SEAL_EXPIRED|NO_SEAL|BAD_SIGNATURE)/);
    // A revert is a legitimate recording — scenes ② ③ ④ are reverts.
    listing = { txHash: "0x" + "0".repeat(64), outcome: named?.[1] ?? "LIST_FAILED", ltvBps };
    console.log(`  reverted: ${listing.outcome}`);
  }
}

const fixture = {
  recordedAt: new Date().toISOString(),
  label,
  token,
  request,
  quote: {
    amountAtomic: hired.quote.amountAtomic.toString(),
    payTo: hired.quote.payTo,
    humanPrice: hired.quote.humanPrice,
  },
  audit: hired.audit,
  sealB: hired.sealB,
  settlementTx: hired.settlementTx,
  listing,
};
writeFileSync(`${OUT_DIR}${out}`, JSON.stringify(fixture, null, 2));
console.log(`  wrote demo/fixtures/replay/${out}`);
