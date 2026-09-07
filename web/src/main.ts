import "./style.css";
import { HttpAgentIdResolver } from "@0x402/seal";
import { SealNotFoundError, resolveSeal } from "@0x402/storage";
import {
  CLEAN_USD,
  DIRECTORY_URL,
  EXAMPLES_URL,
  INDEXER,
  INSTALL_UNDERWRITE,
  REGISTRY,
  REGISTRY_DEPLOY_BLOCK,
  RPC,
} from "./config.js";
import { listRecentListings, type FeedEntry } from "./feed.js";
import { lookupToken, trustedSignerOf } from "./lookup.js";
import {
  el,
  renderFeedCard,
  renderOnChainBlock,
  renderSealCard,
  setFeedVerdict,
  setVerdict,
  verdictFor,
  wireCopyButtons,
} from "./render.js";
import { decodeShare, encodeShare } from "./share.js";
import { auditorStatus } from "./status.js";
import { reportSeal, type SealReport } from "./verify.js";

/**
 * The page, wired.
 *
 * Every decision this file makes is a display decision. Whether a seal is good
 * is decided by `@0x402/seal`, in this browser, over the seal's own bytes; whether
 * a token is listed is decided by a contract; whether a body is the one its hash
 * names is decided by `resolveSeal`. Nothing here can make any of the three say
 * yes, which is why the page can afford to fetch a seal from a stranger.
 *
 * The three network reads it does make are the three the design allows: 0G
 * testnet chain state, the 0G Storage indexer gateway, and this site's own
 * `directory.json`. There is no API of ours to ask.
 */

const must = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id} — index.html and main.ts disagree`);
  return node as T;
};

const samplesEl = must("samples");
const inputEl = must<HTMLTextAreaElement>("input");
const tokenEl = must<HTMLInputElement>("token");
const verdictEl = must("verdict");
const onchainEl = must("onchain");
const outEl = must("out");
const noteEl = must("note");
const shareEl = must("share");
const shareOutEl = must("share-out");
const cardsEl = must("cards");
const pillEl = must("pill");

/** The directory this site publishes; the same file the CLI and the MCP read. */
const resolver = new HttpAgentIdResolver(DIRECTORY_URL);

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const detailOf = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0] ?? text;
};

const isAddress = (v: string): v is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(v);

// --- the report ------------------------------------------------------------

/**
 * The standing caveat, ported from the single-file verifier and corrected in one
 * place: the agent id is now resolved against a published directory rather than
 * a table hard-coded into the page, so only the request binding is still out of
 * reach here.
 */
function noteNodes(): Node[] {
  const b = (text: string): HTMLElement => el("b", null, text);
  return [
    b("What this page proves, and what it does not."),
    document.createTextNode(
      " It recomputes each seal's digest from its own bytes and recovers the signer, so any" +
        " alteration after signing shows up here, and it resolves each agent id against the" +
        " directory this site publishes. It does not prove the judgement was correct — a" +
        " perfectly signed wrong answer still verifies. One check needs data a seal does not" +
        " carry: the request binding can only be recomputed by whoever still has the original" +
        " request payload, so here it is checked for self-consistency.",
    ),
  ];
}

let lastSeal: unknown = null;

interface ShowOptions {
  expectedSubject?: `0x${string}`;
  /** Built after the report exists, because it compares against `report.sealHash`. */
  onChain?: (report: SealReport) => HTMLElement;
}

async function show(seal: unknown, opts: ShowOptions = {}): Promise<SealReport> {
  const report = await reportSeal(seal, {
    resolver,
    now: nowSeconds(),
    ...(opts.expectedSubject === undefined ? {} : { expectedSubject: opts.expectedSubject }),
  });

  setVerdict(verdictEl, verdictFor(report));
  onchainEl.replaceChildren(...(opts.onChain === undefined ? [] : [opts.onChain(report)]));
  outEl.replaceChildren(renderSealCard(report, seal));
  noteEl.replaceChildren(...noteNodes());
  noteEl.hidden = false;

  lastSeal = seal;
  shareEl.hidden = false;
  shareOutEl.textContent = "";
  return report;
}

/** Every path into the report goes through here, so a failure is never a blank page. */
function showFailure(heading: string, line: string): void {
  setVerdict(verdictEl, { cls: "bad", heading, line });
  onchainEl.replaceChildren();
  outEl.replaceChildren(el("p", "empty", "No report — nothing was verified."));
  noteEl.hidden = true;
  shareEl.hidden = true;
}

async function runText(text: string): Promise<void> {
  let seal: unknown;
  try {
    seal = JSON.parse(text);
  } catch (err) {
    showFailure("Not valid JSON", detailOf(err));
    return;
  }
  await show(seal);
}

// --- the samples rail ------------------------------------------------------

const SAMPLES = [
  {
    key: "sealA",
    t: "Seal A — CleanUSD",
    d: "A full chain: underwriting seal wrapping the audit seal it paid for.",
  },
  {
    key: "noattest",
    t: "Seal B — auditor skipped the proof",
    d: "Claims an attested tier, carries no attestation.",
  },
  {
    key: "tampered",
    t: "Seal B — verdict rewritten in flight",
    d: "A proxy raised the cap to 9000 and left the signature alone.",
  },
] as const;

async function wireSamples(): Promise<() => void> {
  const res = await fetch(EXAMPLES_URL);
  if (!res.ok) throw new Error(`EXAMPLES_${res.status}: ${EXAMPLES_URL}`);
  const examples = (await res.json()) as Record<string, unknown>;

  const buttons: HTMLButtonElement[] = [];
  for (const sample of SAMPLES) {
    const seal = examples[sample.key];
    if (seal === undefined) continue;

    const button = el("button", "sample");
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.appendChild(el("span", "t", sample.t));
    button.appendChild(el("span", "d", sample.d));
    button.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      inputEl.value = JSON.stringify(seal, null, 2);
      void show(seal);
    });
    buttons.push(button);
    samplesEl.appendChild(button);
  }

  return () => buttons[0]?.click();
}

// --- token lookup ----------------------------------------------------------

async function runLookup(raw: string): Promise<void> {
  const token = raw.trim();
  if (!isAddress(token)) {
    showFailure("Not a token address", `"${token}" is not a 0x-prefixed 20-byte address.`);
    return;
  }

  setVerdict(verdictEl, {
    cls: "idle",
    heading: "Reading the chain…",
    line: `listings(${token}) on the registry, then the seal body from 0G Storage.`,
  });
  onchainEl.replaceChildren();
  outEl.replaceChildren(el("p", "empty", "One contract read, one log scan, one gateway fetch."));
  // The previous seal's share button must not sit there offering to copy a link
  // to something the reader has already been told is being replaced.
  shareEl.hidden = true;
  noteEl.hidden = true;

  const result = await lookupToken(token, { rpcUrl: RPC, registry: REGISTRY, indexerUrl: INDEXER });
  if (result.seal === null || result.listing === null) {
    // The code is the answer: NOT_LISTED, NO_SUBMISSION and DIGEST_MISMATCH are
    // three different facts about this token, and only one of them is a fault.
    showFailure(
      result.error?.split(":")[0] ?? "Nothing found",
      result.error ?? `the registry holds no active listing for ${token}`,
    );
    return;
  }

  const { listing, trustedSigner, located } = result;
  inputEl.value = JSON.stringify(result.seal, null, 2);
  await show(result.seal, {
    expectedSubject: token,
    onChain: (report) =>
      renderOnChainBlock({
        token,
        ltvBps: listing.ltvBps,
        listedHash: listing.sealHash,
        sealHash: report.sealHash,
        expiresAt: listing.expiresAt,
        trustedSigner,
        root: located?.root ?? null,
        txHash: located?.txHash ?? null,
      }),
  });
}

// --- the feed --------------------------------------------------------------

/** The install line again, for the state where there is nothing to show yet. */
function emptyFeed(): void {
  const box = el("div");
  box.appendChild(el("p", "empty", "Nobody has underwritten yet. Be first."));

  const cmd = el("div", "cmd");
  cmd.appendChild(el("code", null, INSTALL_UNDERWRITE));
  const copy = el("button", "copy", "Copy");
  copy.type = "button";
  cmd.appendChild(copy);
  box.appendChild(cmd);

  cardsEl.replaceChildren(box);
  wireCopyButtons(box);
}

async function loadFeed(): Promise<void> {
  let entries: FeedEntry[];
  try {
    entries = await listRecentListings(
      { rpcUrl: RPC, registry: REGISTRY, fromBlock: REGISTRY_DEPLOY_BLOCK },
      20,
    );
  } catch (err) {
    cardsEl.replaceChildren(
      el("p", "empty", `The 0G testnet RPC did not answer — ${detailOf(err)}`),
    );
    return;
  }

  if (entries.length === 0) {
    emptyFeed();
    return;
  }

  const cards = entries.map((entry) => {
    const card = renderFeedCard(entry);
    return { entry, card };
  });
  cardsEl.replaceChildren(...cards.map((c) => c.card));

  // One read for the whole feed: the registry's verifier names the only signer
  // whose uploads are worth scanning 0G Storage for.
  let sender: `0x${string}`;
  try {
    sender = await trustedSignerOf({ rpcUrl: RPC, registry: REGISTRY });
  } catch (err) {
    for (const { card } of cards) {
      setFeedVerdict(card, { kind: "missing", detail: `the registry's verifier was unreadable — ${detailOf(err)}` });
    }
    return;
  }

  // In order and one at a time: each card is a log scan plus a gateway fetch,
  // and twenty of those at once is a burst the public RPC answers with 429s.
  for (const { entry, card } of cards) {
    try {
      const { seal } = await resolveSeal(entry.sealHash, {
        rpcUrl: RPC,
        sender,
        indexerUrl: INDEXER,
      });
      const report = await reportSeal(seal, {
        resolver,
        now: nowSeconds(),
        expectedSubject: entry.token,
      });
      setFeedVerdict(card, { kind: "report", report, raw: seal });
    } catch (err) {
      setFeedVerdict(card, {
        kind: "missing",
        detail: err instanceof SealNotFoundError ? err.message : detailOf(err),
      });
    }
  }
}

// --- the auditor pill ------------------------------------------------------

async function loadPill(): Promise<void> {
  const OFFLINE_TITLE =
    "The reference auditor runs on the author's machine; offline means try later, or run your own.";

  let endpoint: string | undefined;
  try {
    const directory = await resolver.directory();
    endpoint = directory.agents.find((a) => a.role === "auditor" && a.endpoint !== undefined)?.endpoint;
  } catch (err) {
    pillEl.textContent = "directory unreadable";
    pillEl.title = `${DIRECTORY_URL} — ${detailOf(err)}`;
    return;
  }

  if (endpoint === undefined) {
    pillEl.textContent = "no auditor listed";
    pillEl.title = `${DIRECTORY_URL} names no auditor with an endpoint.`;
    return;
  }

  const status = await auditorStatus(endpoint);
  pillEl.classList.toggle("online", status.online);
  pillEl.textContent = status.online
    ? `reference auditor online${status.price === null ? "" : ` — ${status.price} a seal`}`
    : "reference auditor offline";
  pillEl.title = status.online ? `${endpoint} answered GET /agent.` : `${endpoint} — ${OFFLINE_TITLE}`;
}

// --- boot ------------------------------------------------------------------

function wireShare(): void {
  must("share-btn").addEventListener("click", () => {
    if (lastSeal === null) return;
    // The seal travels in the fragment, which browsers never send to a server —
    // so handing someone this link does not hand it to us.
    const url = `${location.origin}${location.pathname}${encodeShare(lastSeal)}`;
    history.replaceState(null, "", url);
    void navigator.clipboard.writeText(url).then(
      () => (shareOutEl.textContent = "Copied — the seal rides in the link's fragment, so it never reaches a server."),
      () => (shareOutEl.textContent = "Clipboard refused; the link is in the address bar."),
    );
  });
}

function boot(): void {
  wireCopyButtons(document);
  wireShare();

  must("run").addEventListener("click", () => {
    if (inputEl.value.trim() !== "") void runText(inputEl.value);
  });
  must("lookup").addEventListener("click", () => void runLookup(tokenEl.value));
  tokenEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runLookup(tokenEl.value);
  });
  tokenEl.placeholder = CLEAN_USD;

  // A shared seal wins over the default sample: somebody sent this link *about*
  // that seal, and showing them a different one would be answering another
  // question. The fragment is read once, at load, and never watched.
  const shared = decodeShare(location.hash);

  void wireSamples().then(
    (selectFirst) => {
      if (shared === null) selectFirst();
    },
    (err: unknown) => {
      samplesEl.appendChild(el("p", "hint", `The bundled examples did not load — ${detailOf(err)}`));
    },
  );

  if (shared !== null) {
    inputEl.value = JSON.stringify(shared, null, 2);
    void show(shared);
  }

  void loadFeed();
  void loadPill();
}

boot();
