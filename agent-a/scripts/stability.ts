/**
 * Spec §5.3 / Phase 2 acceptance: run each demo token N times and keep the full
 * output, because a pass rate hides the thing worth knowing — whether the
 * reasoning was sound or the verdict was a coin flip that landed right.
 *
 *   pnpm --filter @acu/agent-a stability            # 10 runs per token, testnet
 *   pnpm --filter @acu/agent-a stability -- --n 3 --mainnet
 *
 * Calls the inference layer directly. The payment path is exercised by
 * demo/run.sh; what is under test here is the model's consistency on the exact
 * artifact Agent A would send.
 */
import { config as loadEnv } from "dotenv";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { RouterClient, type OgNetwork, type InferenceResult } from "@acu/og";
import { fetchTokenArtifact, makeOgClient, renderArtifact } from "@acu/underwriter";

loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const N = Number(flag("n") ?? 10);
const mainnet = argv.includes("--mainnet");
const network: OgNetwork = mainnet ? "mainnet" : "testnet";
const apiKey = process.env[mainnet ? "MAINNET_API_KEY" : "TESTNET_API_KEY"];
if (!apiKey) throw new Error(`missing ${mainnet ? "MAINNET" : "TESTNET"}_API_KEY`);

/** Testnet allows 10 requests/minute; leave headroom. */
const PACE_MS = Number(flag("pace") ?? (mainnet ? 1_000 : 7_000));

const TOKENS = [
  { name: "CleanUSD", env: "CLEAN_USD", source: "CleanUSD.sol", expect: "ALLOW" },
  { name: "TrapUSD", env: "TRAP_USD", source: "TrapUSD.sol", expect: "DENY" },
  { name: "InjectionUSD", env: "INJECTION_USD", source: "InjectionUSD.sol", expect: "DENY" },
] as const;

interface Run {
  token: string;
  i: number;
  ok: boolean;
  action?: string;
  maxLtvBps?: number;
  findings?: string[];
  reasoning?: string;
  teeVerified?: boolean;
  chatId?: string | null;
  costNeuron?: string | null;
  rawText?: string;
  error?: string;
  ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = new RouterClient({ apiKey, network });
const chain = makeOgClient();
const srcDir = new URL("../../contracts/src/mocks/", import.meta.url).pathname;

console.log(`stability: ${N} runs x ${TOKENS.length} tokens on ${network} (${client.model})`);
console.log(`pacing ${PACE_MS}ms between calls\n`);

const runs: Run[] = [];

for (const t of TOKENS) {
  const address = process.env[t.env];
  if (!address) throw new Error(`missing ${t.env} in .env`);
  const source = readFileSync(`${srcDir}${t.source}`, "utf8");
  const artifact = renderArtifact(
    await fetchTokenArtifact(chain, address.toLowerCase() as `0x${string}`, source),
  );

  process.stdout.write(`${t.name.padEnd(13)} `);
  for (let i = 1; i <= N; i++) {
    const started = Date.now();
    try {
      const r: InferenceResult = await client.audit({
        token: address.toLowerCase() as `0x${string}`,
        artifact,
      });
      runs.push({
        token: t.name,
        i,
        ok: true,
        action: r.output.action,
        maxLtvBps: r.output.maxLtvBps,
        findings: r.output.findings,
        reasoning: r.output.reasoning,
        teeVerified: r.attestation?.teeVerified ?? false,
        chatId: r.attestation?.chatId ?? null,
        costNeuron: r.costNeuron,
        rawText: r.rawText,
        ms: Date.now() - started,
      });
      process.stdout.write(r.output.action === t.expect ? "." : "X");
    } catch (err) {
      runs.push({
        token: t.name,
        i,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
      process.stdout.write("!");
    }
    if (i < N) await sleep(PACE_MS);
  }
  process.stdout.write("\n");
  await sleep(PACE_MS);
}

// --- summary ---------------------------------------------------------------
console.log("\n" + "=".repeat(70));
for (const t of TOKENS) {
  const mine = runs.filter((r) => r.token === t.name);
  const good = mine.filter((r) => r.ok && r.action === t.expect);
  const ltvs = [...new Set(mine.filter((r) => r.ok).map((r) => r.maxLtvBps))].sort((a, b) => (a ?? 0) - (b ?? 0));
  const attested = mine.filter((r) => r.teeVerified).length;
  const findingSets = [...new Set(mine.filter((r) => r.ok).map((r) => JSON.stringify(r.findings)))];
  console.log(`${t.name.padEnd(13)} expect ${t.expect.padEnd(5)} ${good.length}/${mine.length} agreed`);
  console.log(`              maxLtvBps seen: ${ltvs.join(", ")}`);
  console.log(`              tee_verified:   ${attested}/${mine.length}`);
  console.log(`              distinct finding sets: ${findingSets.length}`);
  for (const f of findingSets) console.log(`                ${f}`);
  const bad = mine.filter((r) => !r.ok || r.action !== t.expect);
  for (const b of bad) console.log(`              !! run ${b.i}: ${b.error ?? `${b.action}/${b.maxLtvBps}`}`);
}
console.log("=".repeat(70));

const outDir = new URL("../../demo/fixtures/stability/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const jsonPath = `${outDir}${network}-${stamp}.json`;
writeFileSync(jsonPath, JSON.stringify({ network, model: client.model, n: N, runs }, null, 2));

// A markdown transcript, because the acceptance criterion is reading the
// outputs, not reading a pass rate.
const md: string[] = [
  `# Stability run — ${network} / ${client.model}`,
  ``,
  `${new Date().toISOString()} · ${N} runs per token`,
  ``,
];
for (const t of TOKENS) {
  md.push(`## ${t.name} (expect ${t.expect})`, ``);
  for (const r of runs.filter((x) => x.token === t.name)) {
    if (!r.ok) {
      md.push(`### run ${r.i} — ERROR`, "```", r.error ?? "", "```", ``);
      continue;
    }
    const agree = r.action === t.expect ? "" : "  **<-- disagrees**";
    md.push(
      `### run ${r.i} — ${r.action} / ${r.maxLtvBps} bps${agree}`,
      `findings: \`${JSON.stringify(r.findings)}\``,
      `tee_verified: ${r.teeVerified} · chatId: \`${r.chatId}\` · ${r.ms}ms · cost ${r.costNeuron} neuron`,
      ``,
      `> ${r.reasoning}`,
      ``,
    );
  }
}
const mdPath = `${outDir}${network}-${stamp}.md`;
writeFileSync(mdPath, md.join("\n"));

console.log(`\nfull outputs:  ${mdPath}`);
console.log(`raw records:   ${jsonPath}`);
