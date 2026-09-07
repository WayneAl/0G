# Three surfaces (service · MCP · web) — design

## Goal / non-goals
Ship the underwriter as three shells over one core: an HTTP service (Agent A, paid over x402),
an MCP server for agent frameworks, and a static website (verify + lookup + docs). Agent B stays
what it is, hosted separately. Non-goals: real Agentic-ID registry, 0G Storage, browser wallet
payments, remote MCP transport — each sits behind an interface named below.

## Principles that decide who calls whom
1. **Verification never crosses the network.** Web and MCP run `@acu/seal` locally. `POST /verify`
   exists for non-JS callers and is labelled "you are asking A whether A is honest".
2. **Keys and money live only in the service.** Web and MCP hold no agent key. The MCP `underwrite`
   tool pays A over x402 with the *user's* burner key: the MCP user is Agent C, A's customer.
3. **You pay for a seal, not for a yes.** `/underwrite` settles (2xx) when seal A is issued, ALLOW
   or DENY. A refused hop (B invalid, budget, B down) is 502: no seal, no charge, same rule B uses.
4. **The service is the only writer of the seal store.** Web/MCP read by hash and cross-check
   `sealDigest(seal)` against the registry's on-chain `sealHash`. The registry stores hashes only.
5. **One directory.** `GET /agents` is the agentId → signer table for A and its known Bs.
   `HttpAgentIdResolver` implements the existing `AgentIdResolver`; ERC-7857 replaces it later.

## Data structures
- `UnderwriteRequest { token, ltvBps, source?, settle }` — what C asks A.
- `UnderwriteResult` — `{ ok:true, sealA, sealHash, hire:{price,payTo,settlementTx}, listing? }`
  or `{ ok:false, stage, code, detail }`; `code` is the existing CLI fail code set. Plus `steps[]`.
- `SealStore { put(sealA): hash; get(hash); byToken(token) }` — JSON file v1; 0G Storage later.
- `AgentDirectory { agents: { agentId, signer, role, endpoint?, price? }[] }` — served at `/agents`.

## Interfaces
- `agent-a/src/underwrite.ts` — `underwrite(req, deps): Promise<UnderwriteResult>`; deps =
  `{ account, budget, resolver, endpoint, network, registry, rpcUrl, onStep }`. No console, no
  `process.exit`. `index.ts` becomes a printer over it; `--offline`/`--seal-file` stay CLI-only.
- `agent-a/src/server.ts` — Express, same shape as agent-b: `GET /agents`, `GET /listings/:token`,
  `GET /seals/:hash`, `POST /verify` (free); `POST /underwrite` behind `@x402/express`, price
  `AGENT_A_PRICE` ≥ B's. Daily Router quota counter → 503 + Retry-After before quoting.
- `packages/mcp` — stdio, `@modelcontextprotocol/sdk`. Tools: `verify_seal` (local), `describe_agents`,
  `get_listing`, `get_seal`, `underwrite` (x402 via `@x402/fetch`; without `ACU_PAYER_KEY` it stops at
  the quote). Config: `ACU_API_URL`, `ACU_PAYER_KEY?`. Verifies the returned seal A locally too.
- `web/` — Vite, vanilla TS, multi-page: `/` verify (paste, or token lookup → store → local verify
  + hash cross-check via public RPC), `/docs` (API, MCP install), `/pitch` copied through. Bundles
  `@acu/seal`; the hand-written canonicalizer in `verifier/index.html` is deleted.

## Invariants & failure modes
- Seal A returned by `/underwrite` re-verifies with `verifySealA` on the client side (MCP asserts it).
- `sealDigest(store.get(h)) == h` for every stored seal; `GET /seals/:h` 404s otherwise.
- Budget gate still runs before any A→B signature; ledger path unchanged. C's payment to A settles
  only on 2xx, so an A-side failure after paying B is A's loss, never C's — by design.
- Unknown agentId anywhere → `AGENT_ID_NOT_LIVE`, never a silent pass.

## Verification
Live: one `POST /underwrite` on hosted A → hosted B → seal A → listing tx; the same token then
resolves on the website with all checks green and the on-chain hash matching; `underwrite` run
from Claude Code via the MCP. Tests: `underwrite()` maps every refusal to its code; server against a
fake B (502 on refusal, 2xx on DENY); MCP tools against a fake API; store hash invariant.

## Open decisions
A. `/underwrite` payment: (a) x402, C pays A, A pays B **[rec]**; (b) free, A absorbs B's fee.
B. Seal store: (a) JSON file, interface kept **[rec]**; (b) 0G Storage now.
C. MCP transport: (a) stdio only **[rec]**; (b) also Streamable HTTP at `/mcp` (free tools only).
D. Publish: (a) `@acu/seal` + `@acu/mcp` to npm at the end, surfaced first **[rec]**; (b) no npm.
E. Web: (a) Vite multi-page, verifier moved in **[rec]**; (b) keep single-file HTML + prebuilt bundle.
F. Hosting: (a) Fly.io, two apps (A, B), web on Vercel **[rec]**; (b) Railway.
