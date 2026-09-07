# Three surfaces (service · MCP · web) — design

## Goal / non-goals
We are the seller side: Agent B (attested auditor) plus the seal infrastructure. Agent A is the
customer's own agent, on their machine, with their key. Ship three shells so any agent can become
an Agent A: an MCP server (the Agent A toolkit), a hosted service (Agent B + a neutral directory /
seal store / listing API), and a static website (verify, lookup, docs). `agent-a/` stays as the
reference Agent A and the demo runner; nothing of it is hosted. Non-goals: real Agentic-ID registry,
0G Storage, browser wallet payments, remote MCP transport — each behind an interface named below.

## Principles that decide who calls whom
1. **Verification never crosses the network.** MCP and web run `@acu/seal` locally. Nothing asks
   B or the directory host whether a seal is valid.
2. **Agent A's key never leaves the customer.** The MCP signs seal A and pays B with the key the
   customer gives it. The hosted service holds only B's key. Money flows A → B, one hop, x402.
3. **The seal store is a cache, not an authority.** `POST /seals` accepts any seal A that passes
   `verifySealA` against the directory; `GET /seals/:hash` 404s unless `sealDigest(seal) == hash`.
   Readers cross-check against the registry's on-chain `sealHash`; the registry stores hashes only.
4. **One directory, behind the existing interface.** `GET /agents` is the agentId → signer table.
   `HttpAgentIdResolver implements AgentIdResolver`; ERC-7857 replaces it without touching callers.
5. **Anyone can hire and verify; listing needs a trusted signer.** See open decision G.

## Data structures
- `UnderwriteRequest { token, ltvBps, source?, settle, publish }` — what the customer asks.
- `UnderwriteResult` — `{ ok:true, sealA, sealHash, hire:{price,payTo,settlementTx}, listing? }`
  or `{ ok:false, stage, code, detail }`; `code` = existing CLI fail codes. Plus `steps[]`.
- `SealStore { put(sealA): hash; get(hash); byToken(token) }` — JSON file v1; 0G Storage later.
- `AgentDirectory { agents: { agentId, signer, role, endpoint?, price? }[] }` — served at `/agents`.

## Interfaces
- `packages/underwriter` (`@acu/underwriter`) — moved out of `agent-a/src`: `hire`, `budget`,
  `chain`, `settle`, plus new `underwrite(req, deps): Promise<UnderwriteResult>`; deps =
  `{ account, budget, resolver, auditorUrl, network, registry?, rpcUrl, store?, onStep }`. No console,
  no `process.exit`. `agent-a/src/index.ts` becomes a printer over it; `--offline`/`--seal-file` stay CLI.
- `agent-b` — unchanged, hosted. Its `/agent` card is what the MCP `describe_auditor` reads.
- `services/api` — Express, no agent keys: `GET /agents`, `GET /listings/:token` (on-chain read +
  stored seal if any), `GET /seals/:hash`, `POST /seals`. Config: directory JSON, RPC, registry.
- `packages/mcp` — stdio, `@modelcontextprotocol/sdk`. Tools: `describe_auditor`, `quote_audit`,
  `hire_audit` (pay B, return verified seal B), `verify_seal` (local, A or B), `underwrite` (hire →
  verify → sign seal A → optional list → optional publish), `get_listing`. Config: `ACU_AGENT_KEY`
  (without it every paid tool stops at the quote), `ACU_AGENT_ID`, `ACU_AUDITOR_URL`, `ACU_API_URL`.
- `web/` — Vite, vanilla TS, multi-page: `/` verify (paste, or token lookup → store → local verify
  + hash cross-check via public RPC), `/docs` (become an Agent A: MCP install, library, B's card),
  `/pitch` copied through. Bundles `@acu/seal`; the hand-written canonicalizer in `verifier/` is deleted.

## Invariants & failure modes
- Budget gate runs before any x402 signature; ledger path is the customer's, configurable.
- `underwrite` refuses to compose seal A on any `SealVerificationError` — codes unchanged.
- A seal A signed by an untrusted signer still returns `ok:true` with `listing: null` and
  `stage:"settle"` skipped and named; it never reaches `list()` to die as `BAD_SIGNATURE` blind.
- Store rejects unverifiable seals with the verifier's failure code, never a bare 400.

## Verification
Live: from a fresh Claude Code session with only the MCP config and a burner key, `underwrite`
CleanUSD against hosted B → seal A returned, seal B inside carries `teeVerified`, the seal appears
on the website by token with all checks green and the on-chain hash matching (reference-A signer
for the listing). Tests: `underwrite()` maps each refusal to its code; store hash + verify invariant;
MCP tools against a fake B and fake API; `services/api` against a fake RPC.

## Open decisions
B. Seal store: (a) JSON file, interface kept **[rec]**; (b) 0G Storage now.
C. MCP transport: (a) stdio only **[rec]**; (b) also Streamable HTTP (free tools only).
D. Publish: (a) `@acu/seal`, `@acu/underwriter`, `@acu/mcp` to npm at the end, surfaced first **[rec]**; (b) no npm.
E. Web: (a) Vite multi-page, verifier moved in **[rec]**; (b) keep single-file HTML + prebuilt bundle.
F. Hosting: (a) Fly.io, two apps (B, api), web on Vercel **[rec]**; (b) Railway.
G. Listing for other people's Agent A: (a) keep `StubVerifier`; only the reference A can list on the
   demo registry, website and MCP say so plainly **[rec for v1]**; (b) new `DirectoryVerifier`
   (owner-managed signer set) + `POST /agents` self-registration + redeploy, so any registered A lists.
