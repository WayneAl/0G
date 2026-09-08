import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { makeBudgetGate, underwrite, type Stage, type UnderwriteDeps } from "@0x402/underwriter";
import type { Io } from "../index.js";
import { DRY_RUN_KEY, NEXT_STEP_INIT, auditorTrust, resolveCliConfig, withoutCode } from "./underwrite.js";

/**
 * `acu quote <token>` — step 1 of the funnel, and the only command that is
 * useful before you have anything at all.
 *
 * No key, no environment, no money: it reads the token, asks the auditor what
 * the job costs, runs the budget gate, and stops. `underwrite --live` is the
 * same path with a signature at the end.
 */
export async function quote(argv: string[], io: Io): Promise<number> {
  const token = argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  if (token === undefined) {
    io.out("usage: acu quote <token> [--source <path>]");
    return 2;
  }
  const sourceIndex = argv.indexOf("--source");
  const sourcePath = sourceIndex === -1 ? undefined : argv[sourceIndex + 1];

  const config = resolveCliConfig(io.env);

  let trusted: Awaited<ReturnType<typeof auditorTrust>>;
  try {
    trusted = await auditorTrust(config);
  } catch (err) {
    // Three named fixes, none of them a stack trace.
    io.out("✗ NO_DIRECTORY");
    io.out(`  ${withoutCode(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
  const { resolver, allowedPayTo } = trusted;

  const deps: UnderwriteDeps = {
    account: privateKeyToAccount(config.agentKey ?? DRY_RUN_KEY),
    agentId: config.agentId,
    auditor: { url: config.auditorUrl, agentId: config.auditorAgentId },
    resolver,
    budget: makeBudgetGate(allowedPayTo, config.ledgerPath),
    network: config.network,
    // A quote never signs, whatever key happens to be configured.
    dryRun: true,
    registry: null,
    rpcUrl: config.rpcUrl,
  };

  // Which step was in flight when something threw. `underwrite()` returns its
  // refusals and throws only for a broken environment, so this is the only way to
  // tell an auditor that will not answer from a 0G RPC that will not answer once
  // the throw has escaped — and step (2) reads the token before the auditor is
  // ever contacted. Naming the auditor for a dead RPC sends someone to debug an
  // agent that is running perfectly well.
  let stage: Stage = "read";
  deps.onStep = (e) => {
    stage = e.stage;
  };

  let result: Awaited<ReturnType<typeof underwrite>>;
  try {
    result = await underwrite(
      {
        token: token.toLowerCase() as `0x${string}`,
        ltvBps: 7000,
        source: sourcePath === undefined ? null : readFileSync(sourcePath, "utf8"),
        settle: false,
        publish: false,
      },
      deps,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // The auditor not being up is the most ordinary thing that can happen here,
    // and it has to name itself rather than escaping as a bare fetch error. So
    // does the RPC — this is the first command in the funnel, run by someone with
    // nothing configured, and a stack trace is not an answer from either of them.
    // Step (2) is the only one the auditor has no part in; a quote never reaches
    // compose or settle, so everything past the read is agent B's end of the wire.
    if (stage === "read") {
      io.out("✗ RPC_UNREACHABLE");
      io.out(`  ${config.rpcUrl} — ${detail}`);
      return 1;
    }
    io.out("✗ AUDITOR_UNREACHABLE");
    io.out(`  ${config.auditorUrl} — ${detail}`);
    return 1;
  }

  if (!result.ok) {
    io.out(`✗ ${result.code}`);
    io.out(`  ${result.detail}`);
    return 1;
  }
  if (result.kind !== "dry-run") {
    io.out("✗ UNEXPECTED");
    io.out("  a quote signed something; refusing to report it as a quote");
    return 1;
  }

  io.out(`quote      ${result.quote.humanPrice} to ${result.quote.payTo} on ${config.network}`);
  io.out(`budget     ${result.budget}`);
  io.out("");
  io.out(
    `→ ${config.agentKey === null ? NEXT_STEP_INIT : `Ready: acu underwrite ${token.toLowerCase()} --live`}`,
  );
  return 0;
}
