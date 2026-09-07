# Three surfaces (SDK · MCP · web) — design

## Goal / non-goals
We host nothing that holds a key. Agent A is the customer's own agent; Agent B is any x402 service
that adopts our seal. What we ship is the layer between them: the seal, the SDK on both sides, an
MCP so any agent framework becomes an Agent A, and a static website (verifier, docs, directory).
`agent-a/` and `agent-b/` stay as the reference pair and the demo runner; neither is deployed.
Non-goals: real Agentic-ID registry (ERC-7857), a general-purpose seal beyond the collateral audit
shape, remote MCP transport, browser wallet payments — each behind an interface named below.

## Principles that decide who calls whom
1. **Verification never crosses the network.** MCP and web run `@acu/seal` locally.
2. **Keys stay with their owners.** A's key is in A's process (MCP or CLI); B's key is in B's
   process (its own server, built on `@acu/auditor`). Money flows A → B, one hop, x402.
3. **A plain x402 service is not a B.** Scene ⑦ stands: no seal, no embed. Becoming a B means
   mounting `@acu/auditor`, which is why the provider SDK is a first-class surface.
4. **The directory is a published file, behind the existing interface.** `directory.json` on the
   website maps agentId → signer for known agents; `HttpAgentIdResolver implements AgentIdResolver`.
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
  `get_listing`. Config: `ACU_AGENT_KEY` (without it, paid tools stop at the quote), `ACU_AGENT_ID`,
  `ACU_AUDITOR_URL`, `ACU_DIRECTORY_URL`, `ACU_REGISTRY`, `ACU_LEDGER_PATH`.
- `web/` — Vite, vanilla TS, multi-page, static: `/` verify (paste seal; optional token field reads
  the on-chain listing and cross-checks the hash), `/docs` (be an A: MCP + library; be a B: auditor
  SDK), `/pitch` copied through, `/directory.json`. Bundles `@acu/seal`; the hand-written
  canonicalizer in `verifier/index.html` is deleted.

## Invariants & failure modes
- Budget gate runs before any x402 signature; the ledger path belongs to the customer.
- `underwrite` refuses to compose seal A on any `SealVerificationError`; codes unchanged.
- Seal A from a signer the on-chain verifier does not trust returns `ok:true, listing:null` with
  `stage:"settle"` named as skipped; it never reaches `list()` to die as `BAD_SIGNATURE` blind.
- `@acu/auditor` never reads `process.env`; the example does. A misconfigured B fails at construction.

## Verification
Live: a fresh Claude Code session with only the MCP config and a burner key runs `underwrite`
CleanUSD against a locally started reference B → seal A returned, seal B inside carries
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

## Open decisions (resolved above, kept for the record)
B. Seal bodies: (a) none hosted; the website takes the seal from the user and cross-checks the chain
   **[rec]**; (b) `underwrite` publishes seal A to 0G Storage and the website fetches it by hash.
D. npm: the three packages plus `@acu/seal` and `@acu/og` are the distribution now that nothing is
   hosted. Publish at the end, surfaced first. (a) `@acu` scope **[rec, free today]**; (b) another name.
E. Web: (a) Vite multi-page, verifier moved in **[rec]**; (b) keep single-file HTML + prebuilt bundle.
F. Static hosting: (a) GitHub Pages from this repo **[rec]**; (b) Vercel.
G. Listing for other people's A: (a) keep `StubVerifier`; only the reference A lists on the demo
   registry, docs and MCP say so **[rec v1]**; (b) `DirectoryVerifier` + self-registration + redeploy.
