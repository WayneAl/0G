import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { makeBudgetGate, underwrite, type UnderwriteDeps } from "@acu/underwriter";
import type { Io } from "../index.js";
import { DRY_RUN_KEY, NEXT_STEP_INIT, auditorTrust, resolveCliConfig } from "./underwrite.js";

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
  const { resolver, allowedPayTo } = await auditorTrust(config);

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
    // The auditor not being up is the most ordinary thing that can happen here,
    // and it has to name itself rather than escaping as a bare fetch error.
    io.out("✗ AUDITOR_UNREACHABLE");
    io.out(`  ${config.auditorUrl} — ${err instanceof Error ? err.message : String(err)}`);
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
