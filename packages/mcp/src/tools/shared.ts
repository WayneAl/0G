import { privateKeyToAccount } from "viem/accounts";
import { resolverFromDirectory } from "@acu/seal";
import {
  hireAndVerify,
  makeBudgetGate,
  readToken,
  type HireAndVerifyResult,
  type SealPublisher,
  type Stage,
  type UnderwriteDeps,
  type UnderwriteFailure,
} from "@acu/underwriter";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DRY_RUN_KEY, type McpConfig } from "../config.js";

/**
 * The pieces every tool file needs and none of them owns.
 *
 * `server.ts` imports the tools, so the tools cannot import `server.ts` back for
 * these; they live here instead of in a cycle.
 */

/** `JSON.stringify` cannot render a bigint, and a quote is priced in one. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Every tool answers with one text block holding pretty JSON.
 *
 * stdout belongs to the JSON-RPC framing, so this is the *only* way anything in
 * this package says something. `isError` is reserved for "the tool could not
 * run": a seal that fails verification is a successful answer with bad news in
 * it, not a tool failure.
 */
export function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, bigintReplacer, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * What a paid tool adds when there is no key to pay with.
 *
 * It names the CLI, not this server: MCP configuration is fixed at install time,
 * so "add a key" used to mean removing and re-adding the server. It does not any
 * more — both shells read `~/.acu/config.json`.
 */
export const NO_KEY_NOTE =
  "no key — stopped at the quote. Next: run `npx @acu/cli init`, fund the address it prints, then call this tool again (the MCP reads ~/.acu/config.json; no re-install).";

/** True when this process holds no key, and so may never sign anything. */
export const isDryRun = (config: McpConfig): boolean => config.agentKey === null;

export const detailOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `UnderwriteFailure`, plus the one refusal only this layer can produce.
 *
 * Inside `underwrite()` an auditor that will not answer the phone is a broken
 * environment and throws. Over MCP it is the most ordinary thing that can happen
 * — the auditor is not running — and it has to come back as a named refusal
 * instead of taking down a server the client is still talking to.
 */
export type McpFailure =
  | UnderwriteFailure
  | "AUDITOR_UNREACHABLE"
  // Both come from the pre-payment funding check, which `underwrite()` does not
  // do: it is handed an account and assumes the caller checked it can pay.
  | "INSUFFICIENT_USDC"
  | "USDC_RPC_UNREACHABLE";

export interface Refusal {
  ok: false;
  stage: Stage;
  code: McpFailure;
  detail: string;
}

/**
 * The `UnderwriteDeps` the three paid tools share.
 *
 * `dryRun` is derived, never asked for: without `ACU_AGENT_KEY` there is nothing
 * to sign with, so the throwaway account below is built and then never reached.
 */
export function makeDeps(
  config: McpConfig,
  opts: { dryRun?: boolean; publisher?: SealPublisher | null } = {},
): UnderwriteDeps {
  const deps: UnderwriteDeps = {
    account: privateKeyToAccount(config.agentKey ?? DRY_RUN_KEY),
    agentId: config.agentId,
    auditor: { url: config.auditorUrl, agentId: config.auditorAgentId },
    resolver: resolverFromDirectory(config.directory),
    budget: makeBudgetGate(config.allowedPayTo, config.ledgerPath),
    network: config.network,
    dryRun: opts.dryRun ?? isDryRun(config),
    registry: config.registry,
    rpcUrl: config.rpcUrl,
  };
  if (opts.publisher !== undefined) deps.publisher = opts.publisher;
  return deps;
}

/**
 * Steps (2)–(5) as `quote_audit` and `hire_audit` need them: read the token,
 * then quote/pay/verify — with every failure turned into a value.
 *
 * A dead RPC still throws: that is a broken environment, and the same judgement
 * `underwrite()` already makes. A dead auditor does not.
 */
export async function readAndHire(
  config: McpConfig,
  args: { token: `0x${string}`; source?: string | undefined },
  opts: { dryRun?: boolean } = {},
): Promise<HireAndVerifyResult | Refusal> {
  const deps = makeDeps(config, opts);

  let read: Awaited<ReturnType<typeof readToken>>;
  try {
    read = await readToken(args.token, args.source ?? null, deps);
  } catch (err) {
    const detail = detailOf(err);
    if (detail.startsWith("NO_CODE_AT_ADDRESS")) {
      return { ok: false, stage: "read", code: "NO_CODE_AT_ADDRESS", detail };
    }
    throw err;
  }

  try {
    return await hireAndVerify(read.request, deps);
  } catch (err) {
    return { ok: false, stage: "quote", code: "AUDITOR_UNREACHABLE", detail: detailOf(err) };
  }
}
