# Three surfaces (SDK · MCP · web) — design

## Goal / non-goals
We host nothing that holds a key that touches real money. Agent A is the customer's own agent; Agent B is any x402 service
that adopts our seal. The first user is an Agent A with **zero prerequisites**: someone with only Claude Code reaches a
green seal without cloning the repo (see *Onboarding* below). What we ship is the layer between them: the seal, the SDK on both sides, an
MCP so any agent framework becomes an Agent A, and a static website (verifier, docs, directory).
`agent-a/` and `agent-b/` stay as the reference pair and the demo runner; neither is deployed.
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
- `packages/mcp` (`@acu/mcp`) — stdio, `@modelcontextprotocol/sdk`, wraps `@acu/underwriter`.
  Tools: `describe_auditor(url)`, `quote_audit`, `hire_audit` (pay B, return *verified* seal B),
  `verify_seal` (local, A or B), `underwrite` (hire → verify → sign seal A → optional list),
  `get_listing`, and `agent_status` — the onboarding tool: who am I, do I have a key, USDC balance, budget left,
  is the auditor online, and the literal **next step** (create a burner key / fund at the faucet / run `underwrite`).
  Config: `ACU_AGENT_KEY` (without it, paid tools stop at the quote and say how to add one), `ACU_AGENT_ID`,
  `ACU_DIRECTORY_URL` (default: the site; auditor URL and agentId come from it), `ACU_AUDITOR_URL` (override),
  `ACU_REGISTRY`, `ACU_LEDGER_PATH`. Before paying, the MCP reads the payer's USDC balance on Base Sepolia and
  refuses with `INSUFFICIENT_USDC` + the Circle faucet URL + the payer address, instead of letting the
  facilitator reject an authorization.
- `web/` — Vite, vanilla TS, multi-page, static, **landing-first**: `/` = hero with the one-line MCP install
  (copy button) and a live "reference auditor online/offline" pill (GET `/agent` on the directory endpoint),
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
Live: a fresh Claude Code session with only the MCP config and a burner key runs `underwrite`
CleanUSD against the reference B on Wayne's machine (through the tunnel URL in `directory.json`) → seal A returned, seal B inside carries
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

The funnel, each step measurable and each a plan acceptance:
1. **Land** — site hero: one copyable line, `claude mcp add acu -- npx -y @acu/mcp`. No key, no env.
2. **First quote (free preview)** — "underwrite 0x…" in Claude Code → the MCP reaches the reference B,
   returns the 402 quote and the budget line, and `agent_status` tells the user the next step.
3. **Key + faucet** — `openssl rand -hex 32` → re-add with `-e ACU_AGENT_KEY=0x…`; `agent_status` prints the
   address and the Circle Base Sepolia USDC faucet link; `INSUFFICIENT_USDC` repeats it.
4. **First paid seal** — `underwrite` pays, verifies seal B, signs seal A, publishes to 0G Storage, lists
   (reference A only, decision G). Result carries a `shareUrl`.
5. **Seen** — the seal shows up in the site's feed and verifies green when opened; that is the social proof
   the next visitor lands on.

What this changes: the reference B is **up whenever Wayne's machine is** (`demo/serve-b.sh`: start B from
`.env`, open a cloudflared quick tunnel, write the URL into `web/public/directory.json`); `web/` becomes
landing-first with a feed; the MCP gains `agent_status`, directory-driven defaults and the USDC pre-check;
the READMEs open with "Try it in 60 seconds". Acceptance: a clean machine, only the README, a green seal
within five minutes. Until `@acu/mcp` is published (Task 7, held), the acceptance runs the clone path
(`node packages/mcp/bin/acu-mcp.mjs`); the `npx` line is the target, and publish is what unlocks it.

Decision H: reference B hosting = **local + tunnel**, not a server. (a) deploy to Fly/Railway was offered
and declined: no maintenance surface, no always-on cost, and "host nothing" stays true for anything that
outlives Wayne's laptop session. Cost: the funnel is only live while the tunnel is up; the site's pill says so.

## Open decisions (resolved above, kept for the record)
B. Seal bodies: (a) none hosted; the website takes the seal from the user and cross-checks the chain
   **[rec]**; (b) `underwrite` publishes seal A to 0G Storage and the website fetches it by hash.
D. npm: the three packages plus `@acu/seal` and `@acu/og` are the distribution now that nothing is
   hosted. Publish at the end, surfaced first. (a) `@acu` scope **[rec, free today]**; (b) another name.
E. Web: (a) Vite multi-page, verifier moved in **[rec]**; (b) keep single-file HTML + prebuilt bundle.
F. Static hosting: (a) GitHub Pages from this repo **[rec]**; (b) Vercel.
G. Listing for other people's A: (a) keep `StubVerifier`; only the reference A lists on the demo
   registry, docs and MCP say so **[rec v1]**; (b) `DirectoryVerifier` + self-registration + redeploy.
