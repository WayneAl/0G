# Three surfaces (CLI · MCP · web) — design

## Goal / non-goals
We host nothing that holds a key that touches real money. Agent A is the customer's own agent; Agent B is any x402 service
that adopts our seal. The first user is an Agent A with **zero prerequisites**: someone with only Claude Code reaches a
green seal without cloning the repo (see *Onboarding* below). What we ship is the layer between them: the seal and the
SDK on both sides as the **core**, and three **shells** over it — a CLI that anyone with node can run, an MCP so any
agent framework becomes an Agent A, and a static website (landing, verifier, docs, directory).
`agent-a/` and `agent-b/` stay as the reference pair and the demo runner; neither is deployed.
Nobody onboards through an SDK. You run a command, watch it work, and reach for the SDK when you integrate —
so the CLI is the headline and the SDK is what it is built on (Decision I).
Non-goals: real Agentic-ID registry (ERC-7857), a general-purpose seal beyond the collateral audit
shape, remote MCP transport, browser wallet payments — each behind an interface named below.

## Principles that decide who calls whom
1. **Verification never crosses the network.** MCP and web run `@acu/seal` locally.
2. **Keys stay with their owners.** A's key is in A's process (MCP or CLI); B's key is in B's
   process (its own server, built on `@acu/auditor`). Money flows A → B, one hop, x402.
   The one exception is ours: the **reference B runs on Wayne's machine** on testnet (burner key, capped 0G
   balance, price a fraction of a cent) and is exposed through a tunnel when the outside world needs it.
   It is never deployed to a server. Without a live B, an A has nobody to hire and the MCP is a demo of a 402.
3. **A plain x402 service is not a B.** Scene ⑦ stands: no seal, no embed. Becoming a B means
   mounting `@acu/auditor`, which is why the provider SDK is a first-class surface.
4. **The directory is a published file, behind the existing interface, and it is the only config an A needs.**
   `directory.json` on the website maps agentId → signer for known agents and carries the reference B's
   `endpoint` (the tunnel URL); the MCP defaults `ACU_DIRECTORY_URL` to the site, so `claude mcp add acu -- npx -y
   @acu/mcp` with no env reaches the quote. It `HttpAgentIdResolver implements AgentIdResolver`.
   ERC-7857 replaces the file without touching callers. `StaticAgentIdResolver` stays for `.env`.
5. **The registry stores hashes.** Anyone who has seal A can prove it is the listed one:
   `sealDigest(sealA) == listings[token].sealHash`. Where seal bodies live is decision B.

## Data structures
- `UnderwriteRequest { token, ltvBps, source?, settle }` — what the customer asks their A to do.
- `UnderwriteResult` — `{ ok:true, sealA, sealHash, hire:{price,payTo,settlementTx}, listing|null }`
  or `{ ok:false, stage, code, detail }`; `code` = existing CLI fail codes. Plus `steps[]`.
- `AuditorConfig` — what `@acu/auditor` needs from a B operator: `sealAccount, agentId, price,
  payTo, network, facilitatorUrl, og:{network, apiKey, model?}, ttlSeconds`. Same fields as today's
  `agent-b/src/config.ts`, no longer read from env inside the package.
- `Directory { agents: { agentId, signer, role:"auditor"|"underwriter", endpoint?, price? }[] }`.

## Interfaces
- `packages/auditor` (`@acu/auditor`) — from `agent-b/src`: `makeAuditor`, `issueSealB`, and
  `sealedAuditRoute(app, config)` mounting `GET /agent` + x402-gated `POST /audit`. `agent-b/` becomes
  `loadConfig` from env + one call. Keeps the 502-on-failure rule (no seal, no charge).
- `packages/underwriter` (`@acu/underwriter`) — from `agent-a/src`: `hire`, `budget`, `chain`,
  `settle`, plus `underwrite(req, deps): Promise<UnderwriteResult>`; deps = `{ account, budget,
  resolver, auditorUrl, network, registry?, rpcUrl, onStep }`. No console, no `process.exit`.
  `agent-a/src/index.ts` becomes a printer over it; `--offline` / `--seal-file` stay CLI-only.
- `packages/config` (`@acu/config`) — the user-level config file both shells share: `~/.acu/config.json`
  (`ACU_HOME` overrides the directory), holding `agentKey`, `agentId`, `directoryUrl`, `auditorUrl`,
  `registry`, `ledgerPath`, `webUrl`. `readUserConfig` never throws on a missing file (all nulls);
  `writeUserConfig` merges and writes `0600` in a `0700` directory, because the file holds a private key.
  **Precedence, everywhere: environment variable > config file > built-in default.** This is what lets
  `acu init` and the MCP share one key: the CLI writes the file, the MCP reads it, and neither needs env.
- `packages/cli` (`@acu/cli`, bin `acu`) — the headline shell, a printer over `@acu/underwriter`. Commands:
  `init` (generate or `--key`-import a burner key, write the config, print the address and the faucet URL),
  `status` (the same payload as the MCP's `agent_status`), `quote <token>`, `underwrite <token>`,
  `verify <file|->` (local, exit 1 on an invalid seal). `agent-a/src/index.ts` becomes a shim: load the repo
  `.env`, delegate to the CLI's underwrite command. The repo `.env` is read only there — never inside
  `@acu/cli`, which is installed by strangers. `demo/run.sh`'s frozen output contract becomes the CLI's.
- `packages/mcp` (`@acu/mcp`) — stdio, `@modelcontextprotocol/sdk`, wraps `@acu/underwriter`.
  Tools: `describe_auditor(url)`, `quote_audit`, `hire_audit` (pay B, return *verified* seal B),
  `verify_seal` (local, A or B), `underwrite` (hire → verify → sign seal A → optional list),
  `get_listing`, and `agent_status` — the onboarding tool: who am I, do I have a key, USDC balance, budget left,
  is the auditor online, and the literal **next step** (create a burner key / fund at the faucet / run `underwrite`).
  Config through `@acu/config`, so the install line carries **no environment variables at all**:
  `ACU_AGENT_KEY` > `~/.acu/config.json` > absent (paid tools stop at the quote and say to run `acu init`);
  likewise `ACU_AGENT_ID`, `ACU_DIRECTORY_URL` (default: the site; auditor URL and agentId come from it),
  `ACU_AUDITOR_URL`, `ACU_REGISTRY`, `ACU_LEDGER_PATH`. `agent_status` and `usdcBalance` live in
  `@acu/underwriter` so the CLI and the MCP give the same answer. Before paying, both shells read the payer's
  USDC balance on Base Sepolia and refuse with `INSUFFICIENT_USDC` + the Circle faucet URL + the payer address,
  instead of letting the facilitator reject an authorization.
- `web/` — Vite, vanilla TS, multi-page, static, **landing-first**: `/` = hero with two copyable lines,
  `npx @acu/cli init` then `npx @acu/cli underwrite 0xDB08…9eB8` under "see it work", and the MCP install
  under "now let your own agent do it", plus a live "reference auditor online/offline" pill (GET `/agent` on the directory endpoint),
  then a **feed** of every seal anyone has produced (`Listed` events from the registry → seal bodies from 0G
  Storage → verified locally), then the verifier (paste seal; optional token field reads the on-chain listing
  and cross-checks the hash). `/docs` (be an A: MCP + library; be a B: auditor SDK), `/pitch` copied through,
  `/directory.json`. The feed is the directory's social proof: it is empty until somebody underwrites. Bundles `@acu/seal`; the hand-written
  canonicalizer in `verifier/index.html` is deleted.

## Invariants & failure modes
- Budget gate runs before any x402 signature; the ledger path belongs to the customer.
- `underwrite` refuses to compose seal A on any `SealVerificationError`; codes unchanged.
- Seal A from a signer the on-chain verifier does not trust returns `ok:true, listing:null` with
  `stage:"settle"` named as skipped; it never reaches `list()` to die as `BAD_SIGNATURE` blind.
- `@acu/auditor` never reads `process.env`; the example does. A misconfigured B fails at construction.

## Verification
Live, in funnel order: a clean shell runs `acu init` then `acu underwrite` CleanUSD against the reference B on
Wayne's machine (through the tunnel URL in `directory.json`), then a fresh Claude Code session with the MCP
added and **no environment variables** repeats it in natural language off the same config file → seal A returned, seal B inside carries
`teeVerified`, pasted into the website every check is green and the hash matches the listing.
`demo/run.sh` still passes all seven scenes against the refactored pair. Tests: `underwrite()` maps
each refusal to its code; MCP tools against a fake B; auditor route against a fake facilitator.

## Decisions (2026-09-07, Wayne)
B=(b) seal bodies on 0G Storage; D=(a) @acu scope; E=(a) Vite; F=(a) GitHub Pages; G=(a) StubVerifier
stays, only the reference A lists in v1.

**B, refined by the spike (same day, live on Galileo):** 0G-KV is out — the only documented public KV
node (`3.101.147.150:6789`) times out and no HTTPS one exists. The log layer works end to end:
- Write (Node): `@0gfoundation/0g-storage-ts-sdk` 1.2.12 `indexer.upload(new MemData(bytes), rpc, signer,
  { tags: sealHash })` on `https://indexer-storage-testnet-turbo.0g.ai`. Proof: tx
  `0xa1ac7763ab26db8a98f98e4bfa67a5189bee6c2c2397575b22244f91bb741b75`, root
  `0xec5a33d2e244bba38ff92353534f39333b7c70302bafe1e64d7a1a2a8cd8a42f`, txSeq 149629, 11 s, storage fee
  215135514734 wei. The older `@0glabs/0g-ts-sdk` 0.3.3 reverts on `Flow.submit` — do not use it.
- Read (browser and Node): the indexer exposes an HTTPS gateway with `access-control-allow-origin: *`:
  `GET /file?root=<root>` returns the bytes, `GET /file/info/<root>` the tx. This is what
  storagescan-galileo.0g.ai itself uses. `downloadToBlob` also round-trips byte-identical.
- sealHash → root: the upload's `Flow.Submit(sender indexed, …, submission{tags})` carries
  `tags == sealHash`. `eth_getLogs` on `evmrpc-testnet.0g.ai` (CORS `*`) filtered by `sender` works over
  a 5,000,000-block span and rejects the full range; readers scan backwards in 5M-block chunks from
  `latest` and stop at the first `tags` match. The seal bytes are the canonical encoding, so
  `sealDigest(fetched) == sealHash` is the integrity check, not the root.
- Publish is a stage of `underwrite` that cannot refuse the seal: failure → `steps[]` warning + `storage: null`.

## Onboarding (2026-09-07, Wayne): the first user is an Agent A, and the funnel is the product
The three surfaces alone are two-sided infrastructure with no first-run experience: an A has nobody to hire
(empty directory), and a B needs a **funded** 0G Compute API key before it can issue anything. Decision:
serve the A side first, because MCP is a zero-friction channel and the audience (judges, agent developers)
already has an agent. The B side (`@acu/auditor`) ships but is documented as "once there are As".

The funnel, each step measurable and each a plan acceptance. It is **CLI-first** (Decision I) because a
terminal command needs no editor, no restart and no MCP config, and because the key it writes is the same key
the MCP later reads:
1. **Land** — site hero: `npx @acu/cli underwrite 0xDB08…9eB8`. No install, no key, no env; it reaches the
   reference B and prints the 402 quote, the budget line, and the next command.
2. **Key** — `npx @acu/cli init` generates a burner key into `~/.acu/config.json` (`0600`) and prints the
   address, the Circle Base Sepolia USDC faucet URL, and the command to run next. No re-installing anything.
3. **Faucet** — fund that address; `acu status` flips from "Fund …" to "Ready"; `INSUFFICIENT_USDC` repeats
   the address and the URL if they jump the gun.
4. **First paid seal** — `acu underwrite` pays, verifies seal B, signs seal A, publishes to 0G Storage, lists
   (reference A only, decision G). The last line is the `shareUrl`.
5. **Seen** — the seal shows up in the site's feed and verifies green when opened; that is the social proof
   the next visitor lands on.
6. **Make it your agent's** — `claude mcp add acu -- npx -y @acu/mcp`, zero environment variables, because the
   MCP reads the config the CLI already wrote. Now "underwrite 0x…" in natural language does the same thing.
   This step is the thesis (an agent hires an agent); steps 1–5 are what make anyone reach it.

What this changes: the CLI becomes a published package rather than a repo-only script; the reference B is **up whenever Wayne's machine is** (`demo/serve-b.sh`: start B from
`.env`, open a cloudflared quick tunnel, write the URL into `web/public/directory.json`); `web/` becomes
landing-first with a feed; the MCP gains `agent_status`, directory-driven defaults, file-backed config and the USDC pre-check;
the READMEs open with "Try it in 60 seconds". Acceptance: a clean machine, only the README, a green seal
within five minutes. Until the packages are published (Task 7, held), the acceptance runs the clone path
(`node packages/cli/bin/acu.mjs`, `node packages/mcp/bin/acu-mcp.mjs`); the `npx` lines are the target, and
publish is what unlocks them.

Decision H: reference B hosting = **local + tunnel**, not a server. (a) deploy to Fly/Railway was offered
and declined: no maintenance surface, no always-on cost, and "host nothing" stays true for anything that
outlives Wayne's laptop session. Cost: the funnel is only live while the tunnel is up; the site's pill says so.

Decision I (2026-09-07, Wayne — "會不會用成 CLI 更好"): **the CLI is the headline shell, the MCP is the second
step, the SDK is the core neither replaces.** Three things decided it:
- It is nearly free. After Task 1, `agent-a/src/index.ts` is already a ~309-line printer over `underwrite()`;
  what stops it shipping is `private: true` and a hard-coded `loadEnv("../../.env")` that a published CLI
  must not have.
- It removes the worst step of the MCP-first funnel. MCP configuration is environment variables fixed at
  install time, so "now you have a key" forced a remove-and-re-add. A CLI that owns `~/.acu/config.json`
  fixes it for **both** shells and shortens the MCP install line to zero env.
- It reaches people who do not use Claude Code, and it is demoable as a terminal recording.
Accepted cost: a human typing a command dilutes "agents hiring agents". Answered by keeping the CLI as the
reference Agent A (it hires, verifies, signs and lists autonomously; the human only starts it) and by making
the MCP step 6 of the funnel, so the thesis is where the visitor ends up rather than where they must begin.

## Open decisions (resolved above, kept for the record)
B. Seal bodies: (a) none hosted; the website takes the seal from the user and cross-checks the chain
   **[rec]**; (b) `underwrite` publishes seal A to 0G Storage and the website fetches it by hash.
D. npm: the three packages plus `@acu/seal` and `@acu/og` are the distribution now that nothing is
   hosted. Publish at the end, surfaced first. (a) `@acu` scope **[rec, free today]**; (b) another name.
E. Web: (a) Vite multi-page, verifier moved in **[rec]**; (b) keep single-file HTML + prebuilt bundle.
F. Static hosting: (a) GitHub Pages from this repo **[rec]**; (b) Vercel.
G. Listing for other people's A: (a) keep `StubVerifier`; only the reference A lists on the demo
   registry, docs and MCP say so **[rec v1]**; (b) `DirectoryVerifier` + self-registration + redeploy.
