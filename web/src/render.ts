import type { CheckRow, SealReport } from "./verify.js";
import { short, when } from "./verify.js";
import type { FeedEntry } from "./feed.js";
import { CHAINSCAN, STORAGESCAN } from "./config.js";

/**
 * The DOM half of the verifier, ported from the single-file page.
 *
 * Two things changed in the port, and both are deliberate. The report is a typed
 * `SealReport` produced by `@acu/seal` rather than a second set of checks
 * written in this file; and every seal-derived string is set with `textContent`,
 * never `innerHTML` — a pasted seal is somebody else's input, and the old page
 * would happily have rendered a `<script>` out of a `findings` entry.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls !== undefined && cls !== null) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function link(href: string, text: string): HTMLAnchorElement {
  const a = el("a", null, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  return a;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Re-exported so a caller that already has the renderer need not know it moved. */
export { wireCopyButtons } from "./copy.js";

// --- the report ------------------------------------------------------------

export function renderChecks(rows: readonly CheckRow[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const c of rows) {
    const skipped = !c.ok && c.detail === "not reached";
    const row = el("div", "check");
    row.appendChild(el("span", `chip ${skipped ? "info" : c.ok ? "pass" : "fail"}`, skipped ? "skip" : c.ok ? "pass" : "fail"));
    row.appendChild(el("span", "name", c.name));
    row.appendChild(el("span", "detail", c.detail));
    frag.appendChild(row);
  }
  return frag;
}

function renderAttestation(inference: Record<string, unknown>): HTMLElement {
  const att = isRecord(inference["teeAttestation"]) ? inference["teeAttestation"] : null;
  const box = el("div", `attest${att === null ? " absent" : ""}`);
  box.appendChild(el("span", "eyebrow", att === null ? "No attestation" : "Attestation"));

  const dl = el("dl", "kv");
  const row = (k: string, v: unknown): void => {
    dl.appendChild(el("dt", null, k));
    dl.appendChild(el("dd", null, v === null || v === undefined ? "—" : String(v)));
  };
  row("Model", inference["model"]);
  row("Trust mode", inference["trustMode"]);
  row("Provider", inference["providerAddress"]);
  if (att === null) {
    row("Evidence", "none — this seal asserts an attested tier it cannot show");
  } else {
    row("Chat id", att["chatId"]);
    row("tee_verified", String(att["teeVerified"]));
    row("Response hash", att["signedTextHash"]);
  }
  row("Prompt hash", inference["promptHash"]);
  box.appendChild(dl);
  return box;
}

/**
 * The chain is drawn as containment, because containment is the claim: seal B
 * lives *inside* seal A, and the page should make that impossible to miss.
 */
export function renderSealCard(report: SealReport, raw: unknown): HTMLElement {
  const seal = isRecord(raw) ? raw : {};
  const card = el("div", "seal");

  const head = el("div", "seal-head");
  head.appendChild(
    el("h3", null, report.kind === "underwriting" ? "Seal A — underwriting" : "Seal B — code audit"),
  );
  const verdict = isRecord(seal["verdict"]) ? seal["verdict"] : {};
  head.appendChild(
    el(
      "span",
      "meta",
      `${String(verdict["action"] ?? "—")} · maxLtvBps ${String(verdict["maxLtvBps"] ?? "—")} · agent ${String(seal["agentId"] ?? "—")}`,
    ),
  );
  card.appendChild(head);

  const body = el("div", "seal-body");
  body.appendChild(renderChecks(report.checks));

  if (report.kind === "audit" && isRecord(seal["inference"])) {
    body.appendChild(renderAttestation(seal["inference"]));
  }

  const delegations = Array.isArray(seal["delegations"]) ? seal["delegations"] : [];
  report.children.forEach((child, i) => {
    const d = delegations[i];
    const meta = isRecord(d) ? d : {};
    const nest = el("div", "nest");
    const settled = typeof meta["settlementTx"] === "string" ? ` · settled ${short(meta["settlementTx"])}` : "";
    nest.appendChild(
      el(
        "span",
        "label",
        `hired agent ${String(meta["agentId"] ?? "?")} for ${String(meta["service"] ?? "?")} · paid ${String(meta["priceAtomic"] ?? "?")} on ${String(meta["network"] ?? "?")}${settled}`,
      ),
    );
    nest.appendChild(renderSealCard(child, isRecord(meta["seal"]) ? meta["seal"] : {}));
    body.appendChild(nest);
  });

  card.appendChild(body);
  return card;
}

export interface VerdictText {
  cls: "ok" | "bad" | "idle";
  heading: string;
  line: string;
}

export function verdictFor(report: SealReport): VerdictText {
  if (report.valid) {
    return {
      cls: "ok",
      heading: "Seal verified",
      line:
        report.children.length > 0
          ? "Every check passed, including the audit seal embedded one level down. The chain holds."
          : "Every check passed against the seal's own bytes.",
    };
  }
  return {
    cls: "bad",
    heading: `Seal rejected — ${report.failure ?? "invalid"}`,
    line: "An underwriter running these same checks would refuse to act on this seal — which is the point: nothing here depends on trusting whoever handed it to you.",
  };
}

export function setVerdict(node: HTMLElement, v: VerdictText): void {
  node.className = `verdict ${v.cls}`;
  node.replaceChildren(el("h2", null, v.heading), el("p", null, v.line));
}

/**
 * The row a pasted seal cannot have: the chain itself naming this hash.
 *
 * It is rendered next to the report rather than inside it because it is a
 * different kind of claim — the eight checks are about the seal's own bytes, and
 * this one is about what a contract stores.
 */
export function renderOnChainBlock(args: {
  token: `0x${string}`;
  ltvBps: number;
  listedHash: `0x${string}`;
  sealHash: `0x${string}`;
  expiresAt: bigint;
  trustedSigner: `0x${string}` | null;
  root: `0x${string}` | null;
  txHash: `0x${string}` | null;
}): HTMLElement {
  const box = el("div", "onchain");
  box.appendChild(el("span", "eyebrow", "On chain"));

  const matches = args.listedHash.toLowerCase() === args.sealHash.toLowerCase();
  const rows: CheckRow[] = [
    {
      name: "ON_CHAIN_HASH",
      ok: matches,
      detail: matches
        ? `sealDigest(seal) equals the hash the registry lists for ${args.token}`
        : `the registry lists ${short(args.listedHash)}, this body hashes to ${short(args.sealHash)}`,
    },
    {
      name: "LISTED_LTV",
      ok: true,
      detail: `${args.ltvBps} bps, until ${when(Number(args.expiresAt))}`,
    },
    {
      name: "TRUSTED_SIGNER",
      ok: args.trustedSigner !== null,
      detail:
        args.trustedSigner === null
          ? "the registry's verifier named no signer"
          : `the registry's verifier accepts ${args.trustedSigner}`,
    },
  ];
  box.appendChild(renderChecks(rows));

  if (args.root !== null || args.txHash !== null) {
    const line = el("p", "line");
    line.style.marginTop = "10px";
    line.appendChild(document.createTextNode("Seal body: "));
    if (args.root !== null) {
      line.appendChild(link(`${STORAGESCAN}/tool/download?root=${args.root}`, "open on storagescan"));
    }
    if (args.txHash !== null) {
      if (args.root !== null) line.appendChild(document.createTextNode(" · "));
      line.appendChild(link(`${CHAINSCAN}/tx/${args.txHash}`, "upload transaction"));
    }
    box.appendChild(line);
  }
  return box;
}

// --- the feed --------------------------------------------------------------

export function renderFeedCard(entry: FeedEntry): HTMLElement {
  const card = el("div", "card");
  card.appendChild(el("span", "chip info", "checking"));
  card.appendChild(el("div", "tok", entry.token));
  card.appendChild(el("div", "headline", `listed at ${entry.ltvBps} bps`));

  const line = el("div", "line");
  line.appendChild(document.createTextNode(`block ${entry.blockNumber.toString()} · `));
  line.appendChild(link(`${CHAINSCAN}/tx/${entry.txHash}`, "chainscan"));
  card.appendChild(line);

  const slot = el("div", "line");
  slot.dataset["slot"] = "verdict";
  slot.textContent = "resolving the seal body from 0G Storage…";
  card.appendChild(slot);
  return card;
}

export type FeedVerdict =
  | { kind: "missing"; detail: string }
  | { kind: "report"; report: SealReport; raw: unknown };

export function setFeedVerdict(card: HTMLElement, v: FeedVerdict): void {
  const chip = card.querySelector<HTMLElement>(".chip");
  const slot = card.querySelector<HTMLElement>('[data-slot="verdict"]');
  if (chip === null || slot === null) return;

  if (v.kind === "missing") {
    // Not an error: a listing whose body was never published is a real, ordinary
    // state of this system, and the card says which one it is.
    chip.className = "chip warn";
    chip.textContent = "no body";
    slot.textContent = `body not on 0G Storage — ${v.detail}`;
    return;
  }

  const { report, raw } = v;
  const seal = isRecord(raw) ? raw : {};
  card.classList.add(report.valid ? "ok" : "bad");
  chip.className = `chip ${report.valid ? "pass" : "fail"}`;
  chip.textContent = report.valid ? "verified" : (report.failure ?? "rejected");

  const verdict = isRecord(seal["verdict"]) ? seal["verdict"] : {};
  const inner = report.children[0];
  const delegations = Array.isArray(seal["delegations"]) ? seal["delegations"] : [];
  const innerSeal = isRecord(delegations[0]) && isRecord((delegations[0] as Record<string, unknown>)["seal"])
    ? ((delegations[0] as Record<string, unknown>)["seal"] as Record<string, unknown>)
    : null;
  const inference = innerSeal !== null && isRecord(innerSeal["inference"]) ? innerSeal["inference"] : null;

  slot.replaceChildren();
  slot.appendChild(
    el(
      "div",
      null,
      `${String(verdict["action"] ?? "—")} · maxLtvBps ${String(verdict["maxLtvBps"] ?? "—")} · signed by ${short(report.signer)}`,
    ),
  );
  if (inference !== null) {
    slot.appendChild(
      el(
        "div",
        null,
        `auditor ran ${String(inference["model"])} · tee_verified ${String(inner?.attestation?.teeVerified ?? false)}`,
      ),
    );
  }
}
