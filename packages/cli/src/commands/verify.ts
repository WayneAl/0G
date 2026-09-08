import { readFileSync } from "node:fs";
import { readUserConfig } from "@0x402/config";
import {
  Directory,
  HttpAgentIdResolver,
  SealVerificationError,
  recoverSealSigner,
  resolverFromDirectory,
  verifySealA,
  verifySealB,
  type AgentIdResolver,
  type SealFailure,
} from "@0x402/seal";
import type { Io } from "../index.js";

/**
 * `acu verify <file|->` — the claim of the whole project, checkable offline.
 *
 * Verification never crosses the network: this is `@0x402/seal` running in this
 * process. The only lookup that can leave the machine is agent id → signer, and
 * only when a directory has been configured; the reference pair below stands in
 * otherwise, exactly as the website's verifier does.
 */
export const REFERENCE_DIRECTORY = Directory.parse({
  agents: [
    { agentId: "1", signer: "0x6ddF162A95123AaD1355E5D2FB66C2B1015Adc41", role: "underwriter" },
    { agentId: "2", signer: "0xC1Dba83fd85838542b09ec44e6372485f6EE2D9E", role: "auditor" },
  ],
});

/**
 * The checks each verifier runs, in the order it runs them.
 *
 * `@0x402/seal` throws on the first failure and names it, so the code that comes
 * back says which row failed and, by position, which rows were reached at all.
 * Nothing here re-implements a check — a second implementation of "is this seal
 * good" is exactly the thing this project must not have.
 */
interface Row {
  label: string;
  codes: SealFailure[];
  detail: (seal: Record<string, any>) => string;
  /**
   * The row a failure one hop down belongs to, whatever its code says. Seal A
   * and seal B share their codes, so a delegate's SIGNER_MISMATCH would
   * otherwise land on seal A's own "Signature" row.
   */
  delegate?: true;
}

const short = (a: unknown): string =>
  typeof a === "string" && a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : String(a);
const when = (ts: unknown): string =>
  typeof ts === "number" ? `${new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16)}Z` : "—";

const ROWS_A: Row[] = [
  { label: "Shape", codes: ["SCHEMA_INVALID"], detail: (s) => `version ${s["version"]}, type ${s["type"]}` },
  { label: "Issuer is known", codes: ["AGENT_ID_NOT_LIVE"], detail: (s) => `agent ${s["agentId"]}` },
  {
    label: "Signature",
    codes: ["SIGNATURE_INVALID", "SIGNER_MISMATCH"],
    detail: (s) => `over the canonical bytes of this seal (${short(s["signature"])})`,
  },
  { label: "Subject", codes: ["SUBJECT_MISMATCH"], detail: (s) => String(s["subject"]) },
  {
    label: "Not expired",
    codes: ["SEAL_EXPIRED"],
    detail: (s) => `valid until ${when((s["verdict"] as Record<string, unknown> | undefined)?.["expiresAt"])}`,
  },
  {
    label: "Embedded seal B",
    codes: ["REQUEST_MISMATCH", "ATTESTATION_MISSING", "TRUST_MODE_INSUFFICIENT"],
    detail: (s) => `${(s["delegations"] as unknown[] | undefined)?.length ?? 0} delegation(s), each held to the same checks`,
    delegate: true,
  },
];

const ROWS_B: Row[] = [
  { label: "Shape", codes: ["SCHEMA_INVALID"], detail: (s) => `version ${s["version"]}, type ${s["type"]}` },
  { label: "Issuer is known", codes: ["AGENT_ID_NOT_LIVE"], detail: (s) => `agent ${s["agentId"]}` },
  {
    label: "Signature",
    codes: ["SIGNATURE_INVALID", "SIGNER_MISMATCH"],
    detail: (s) => `over the canonical bytes of this seal (${short(s["signature"])})`,
  },
  { label: "Subject", codes: ["SUBJECT_MISMATCH"], detail: (s) => String(s["subject"]) },
  { label: "Request binding", codes: ["REQUEST_MISMATCH"], detail: (s) => short(s["request"]) },
  { label: "Not expired", codes: ["SEAL_EXPIRED"], detail: (s) => `valid until ${when(s["expiresAt"])}` },
  {
    label: "Attested inference",
    codes: ["ATTESTATION_MISSING", "TRUST_MODE_INSUFFICIENT"],
    detail: (s) =>
      (s["inference"] as Record<string, unknown> | undefined)?.["teeAttestation"]
        ? "TEE attestation present, trust mode verified"
        : "no attestation carried",
  },
];

export async function verify(argv: string[], io: Io): Promise<number> {
  const source = argv.find((a) => !a.startsWith("--"));
  if (source === undefined) {
    io.out("usage: acu verify <file|->   (- reads the seal from stdin)");
    return 2;
  }

  let candidate: Record<string, any>;
  try {
    const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("a seal is a JSON object");
    }
    candidate = parsed as Record<string, any>;
  } catch (err) {
    io.out("✗ UNREADABLE");
    io.out(`  ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const kind = candidate["type"] === "audit" ? "B" : candidate["type"] === "underwriting" ? "A" : null;
  if (kind === null) {
    io.out("✗ SCHEMA_INVALID");
    io.out(`  type must be "audit" or "underwriting", got ${JSON.stringify(candidate["type"])}`);
    return 1;
  }

  const rows = kind === "A" ? ROWS_A : ROWS_B;
  const resolver = agentIdResolver(io);
  const now = Math.floor(Date.now() / 1000);
  const subject = String(candidate["subject"]).toLowerCase() as `0x${string}`;

  let failure: SealFailure | null = null;
  let delegate = false;
  let detail = "";
  let signer: `0x${string}` | null = null;
  try {
    if (kind === "A") {
      const seal = await verifySealA(candidate, { expectedSubject: subject, resolver, now });
      signer = await recoverSealSigner(seal as unknown as Record<string, unknown>);
    } else {
      const seal = await verifySealB(candidate, {
        expectedSubject: subject,
        expectedRequest: candidate["request"] as `0x${string}`,
        resolver,
        now,
      });
      signer = await recoverSealSigner(seal as unknown as Record<string, unknown>);
    }
  } catch (err) {
    if (!(err instanceof SealVerificationError)) throw err;
    failure = err.failure;
    delegate = err.delegate;
    detail = err.message;
  }

  // Everything before the failing row was checked and passed; everything after
  // it was never reached, and saying "not reached" is not the same as "fine".
  // A failure one hop down is the delegation row's, whatever code it carries:
  // the library says so, because the codes alone cannot tell a seal B that
  // expired from a seal A that did.
  const delegateRow = rows.findIndex((r) => r.delegate === true);
  const failedAt =
    failure === null
      ? -1
      : delegate && delegateRow !== -1
        ? delegateRow
        : Math.max(0, rows.findIndex((r) => r.codes.includes(failure)));
  rows.forEach((row, i) => {
    const mark = failure === null || i < failedAt ? "✓" : i === failedAt ? "✗" : "·";
    const text = failure !== null && i > failedAt ? "not reached" : safely(row.detail, candidate);
    io.out(`  ${mark} ${row.label.padEnd(20)}${text}`);
  });

  io.out("");
  if (failure !== null) {
    io.out(`✗ ${failure}`);
    io.out(`  ${detail}`);
    return 1;
  }

  io.out(`✓ VALID`);
  io.out(`  seal ${kind} · signed by ${signer} · subject ${candidate["subject"]}`);
  io.out("  the subject and request bindings were checked for self-consistency");
  return 0;
}

/**
 * Where "which key does agent 3 sign with?" is answered.
 *
 * A configured directory wins — inline JSON first, then a URL, which is the one
 * thing here that may touch the network. With neither, the reference pair above
 * stands in, so the seals this project ships verify on a machine with no
 * configuration at all.
 */
function agentIdResolver(io: Io): AgentIdResolver {
  const inline = io.env["ACU_DIRECTORY_JSON"];
  if (inline !== undefined && inline.trim() !== "") {
    return resolverFromDirectory(Directory.parse(JSON.parse(inline)));
  }
  const url = io.env["ACU_DIRECTORY_URL"] ?? readUserConfig(io.env).directoryUrl;
  if (url !== undefined && url !== null && url.trim() !== "") return new HttpAgentIdResolver(url);
  return resolverFromDirectory(REFERENCE_DIRECTORY);
}

const safely = (render: (s: Record<string, any>) => string, seal: Record<string, any>): string => {
  try {
    return render(seal);
  } catch {
    // A malformed seal is the case this command exists for; a renderer throwing
    // on one must not turn the report into a crash.
    return "—";
  }
};
