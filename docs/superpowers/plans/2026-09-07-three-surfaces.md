# Three surfaces (SDK · MCP · web) — implementation plan

**Goal:** Turn the reference pair in `agent-a/` and `agent-b/` into three shells over one core — an SDK on both sides, an MCP server that makes any agent framework an Agent A, and a static website — with seal bodies published to 0G Storage, hosting nothing that holds a key that touches real money. The plan's acceptance is an **onboarding funnel** (spec § Onboarding): a clean machine, only the README, a green seal within five minutes, against the reference B running on Wayne's machine behind a tunnel.

**Architecture:** `@acu/seal` stays the core. `@acu/underwriter` (A side) and `@acu/auditor` (B side) are extracted from the two reference agents, which become thin examples over them. `@acu/storage` publishes seal A to 0G Storage (Node) and locates/fetches it by `sealHash` (isomorphic). `@acu/mcp` wraps the underwriter over stdio with the customer's key. `web/` is a Vite static site that verifies locally, looks up listings on chain, and pulls seal bodies from the indexer gateway.

**Spec:** `docs/superpowers/specs/2026-09-07-three-surfaces-design.md` — executors read both.

**Stack:** Node 22+, pnpm 10.33.2 workspace, TypeScript 5.7 (`tsconfig.base.json`: strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `moduleResolution: bundler`), vitest 3, viem 2, zod 3.25.76 (lockfile), express 4, `@x402/*` 2.24 (v2 only), `@0gfoundation/0g-storage-ts-sdk` 1.2.12 + `ethers` 6.13.1 (peer), `@modelcontextprotocol/sdk` 1.30.0, Vite 8, Foundry for `contracts/` (untouched by this plan).

## Global constraints

- **Nothing in this plan deploys to a server.** `agent-a/`, `agent-b/` remain local examples; the reference B is served from Wayne's machine through a cloudflared quick tunnel (Task 8), never from a host. The only side effects that leave the machine are testnet transactions from the reference A (0G testnet gas, Base Sepolia USDC) and the tunnel itself, and those are run by the orchestrator, never by an implementer.
- **Onboarding is the acceptance.** Every user-facing surface (MCP, web, README) must work with **no key and no env** up to the quote, and must name the literal next step when it stops. Refusals a newcomer will hit (`INSUFFICIENT_USDC`, `AUDITOR_UNREACHABLE`, no key) carry the fix in `detail`, not just the code.
- **Held by the orchestrator (checkpoints):** any `--live` run, any 0G Storage upload, `npm publish`, enabling GitHub Pages / merging to `main`, running `demo/run.sh` in any mode (it reads `.env`). Implementers never read `.env` and never need it.
- **x402 v2 only** (`@x402/express`, `@x402/fetch`, `@x402/evm`, `@x402/core`). `x402-express` / `x402-fetch` are the deprecated v1 line — never import them.
- **0G Storage SDK:** `@0gfoundation/0g-storage-ts-sdk@1.2.12` only. `@0glabs/0g-ts-sdk` reverts on `Flow.submit` on Galileo — never import it. `ethers` is confined to `packages/storage/src/publish.ts`; nothing else in the repo imports `ethers`.
- **MCP SDK:** `registerTool(name, { description, inputSchema }, handler)` from `@modelcontextprotocol/sdk/server/mcp.js`. The `.tool(...)` overloads are deprecated — never use them.
- **Verification never crosses the network.** No package may ask an HTTP endpoint whether a seal is valid; `verifySealA` / `verifySealB` from `@acu/seal` run locally everywhere.
- **Fail loud.** Every refusal surfaces the existing code (`SealFailure`, `HireError.code`, `BudgetDenial`, registry custom-error names). No `catch {}` that turns a failure into a default, except the two places the current code already documents (settlement-tx header parse in `hire.ts`; absent ERC-20 methods in `chain.ts`).
- **Output contract of the reference CLI is frozen.** `demo/run.sh` asserts on the last line matching `^(✓ [A-Z_]+|✗ [A-Z_]+|○ DRY RUN)` and prints lines matching `^\[[0-9R]\] `. Keep the `✓ EXECUTED  ltv=…bps  tx=…`, `✗ CODE` + indented detail, and `○ DRY RUN — …` lines byte-compatible.
- **Expand → migrate → contract.** Moves are done as: create the new module, point the old import at it, delete the old file — each task's tree compiles and `pnpm -r test` is green at every commit.
- **Smallest diff.** Moved files keep their content; only import paths change unless the task says otherwise. No renames of existing exports. No "while I'm here" cleanup.
- **Packages are consumed as TypeScript source** (`main: ./src/index.ts`, `exports` to `./src/*.ts`), as `@acu/seal` and `@acu/og` already are. Building for npm is Task 7 and does not change how the workspace resolves.
- **Tests:** logic → red first, watch it fail for the right reason, then green. Fixtures come from real recorded data: `demo/fixtures/replay/*.json`, `verifier/example-sealA.json`, `verifier/examples.json`, and the 0G Storage spike values recorded in the spec (root `0xec5a33d2…8a42f`, tx `0xa1ac7763…41b75`, txSeq 149629, sender `0x6ddF162A95123AaD1355E5D2FB66C2B1015Adc41`, tags `0x6ee707d5afe6112338a134b991a0d75d6a604fd7307ca6d087becf7ade535871`, nodes `[{root 0x8ec11cf2f3a80c3418e17f0d656c05454aa5579b37a96ee0ac9092c32c44e8d2, height 2}, {root 0xd359d9c6c46604a6530523bdf309d557ca7fb4602a3a94bd19df7884af478601, height 1}, {root 0x344e131d8a53e14582031c3ee0decf0712d26031b69a6eb605fc86009704d266, height 0}]`). Unit tests never open a socket; anything that does is a verification command run by the orchestrator.
- **Commit format:** `<type>: <what>` where type ∈ feat, refactor, test, docs, chore. One logical unit per commit.

## File map

```
packages/underwriter/                 NEW  @acu/underwriter — the A-side SDK
  package.json · tsconfig.json
  src/index.ts                        re-exports
  src/hire.ts                         MOVED from agent-a/src/hire.ts (unchanged)
  src/budget.ts                       MOVED from agent-a/src/budget.ts (unchanged)
  src/chain.ts                        MOVED from agent-a/src/chain.ts (unchanged)
  src/settle.ts                       MOVED from agent-a/src/settle.ts + readTrustedSigner()
  src/underwrite.ts                   NEW  readToken · hireAndVerify · composeSealA · underwrite
  src/publisher.ts                    NEW  SealPublisher interface + PublishReceipt type
  test/budget.test.ts                 MOVED from agent-a/test/budget.test.ts
  test/underwrite.test.ts             NEW  refusal → code map, skip rules
agent-a/src/index.ts                  REWRITTEN as a printer over @acu/underwriter (flags unchanged, +--publish)
agent-a/src/replay.ts                 stays (CLI-only)
agent-a/scripts/{record,stability}.ts import paths only
packages/storage/                     NEW  @acu/storage
  src/index.ts                        re-exports locate + fetch (no ethers, no 0G SDK)
  src/publish.ts                      NEW  publishSeal() — Node only; ethers + 0G SDK live here and only here
  src/locate.ts                       NEW  rootFromNodes · locateSeal (viem getLogs, backwards 5M-block chunks)
  src/fetch.ts                        NEW  fetchSealBytes · resolveSeal (indexer gateway + sealDigest check)
  test/locate.test.ts                 NEW  rootFromNodes against the spike nodes; chunk walk against a fake getLogs
  test/fetch.test.ts                  NEW  digest mismatch → SEAL_NOT_FOUND, with an injected fetch
packages/auditor/                     NEW  @acu/auditor — the B-side SDK
  src/index.ts · src/config.ts (AuditorConfig type) · src/audit.ts (MOVED) · src/seal.ts (MOVED) · src/route.ts (NEW sealedAuditRoute)
  test/seal.test.ts                   MOVED from agent-b/test/seal.test.ts
agent-b/src/config.ts                 loadConfig() from env → AuditorConfig & { port }
agent-b/src/server.ts                 express() + sealedAuditRoute + listen banner
packages/seal/src/resolver.ts         NEW  HttpAgentIdResolver, Directory schema (isomorphic fetch)
packages/mcp/                         NEW  @acu/mcp
  package.json (bin: acu-mcp) · tsconfig.json
  src/config.ts · src/server.ts (createServer) · src/tools/*.ts (incl. agent-status) · src/usdc.ts (balance pre-check) · src/index.ts (stdio bin)
  test/tools.test.ts                  NEW  spawns the server over stdio with the SDK client
web/                                  NEW  @acu/web — Vite multi-page static site
  package.json · vite.config.ts · tsconfig.json
  index.html (landing: hero + feed + verifier) · docs/index.html · src/{verify,lookup,feed,status,render,share,style}.ts|css · public/directory.json · public/examples/*.json
  scripts/copy-pitch.mjs              copies ../pitch/index.html → public/pitch/index.html before build
verifier/                             DELETED (moved into web/; the hand-written canonicalizer goes away)
demo/serve-b.sh                       NEW  reference B from .env + cloudflared quick tunnel → writes web/public/directory.json (orchestrator-run)
demo/set-directory-endpoint.mjs       NEW  rewrites the auditor endpoint in directory.json (used by serve-b.sh)
packages/auditor/src/route.ts         + CORS on GET /agent (the site's online pill reads it cross-origin)
.github/workflows/pages.yml           NEW  build web/ and deploy to GitHub Pages on push to main
README.md · README.zh-TW.md           layout + install sections updated
.gitignore                            + .claude/worktrees/ .claude/sdd/ web/dist/ web/public/pitch/
```

---

### Task 1: `@acu/underwriter` — extract the A side, `underwrite()` as a library, CLI becomes a printer

**Files:** Create `packages/underwriter/{package.json,tsconfig.json}`, `packages/underwriter/src/{index,underwrite,publisher}.ts` · Move `agent-a/src/{hire,budget,chain,settle}.ts` → `packages/underwriter/src/` · Move `agent-a/test/budget.test.ts` → `packages/underwriter/test/budget.test.ts` · Modify `packages/underwriter/src/settle.ts` (add `readTrustedSigner`), `agent-a/src/index.ts` (rewrite), `agent-a/scripts/record.ts:19-22`, `agent-a/scripts/stability.ts:16`, `agent-a/package.json` (deps) · Test `packages/underwriter/test/underwrite.test.ts`

**Interfaces:**
- Consumes (unchanged, from `@acu/seal`): `verifySealB(input, ctx)`, `signSealA(unsigned, account)`, `auditRequestHash(payload)`, `sealDigest(seal)`, `StaticAgentIdResolver`, `SealVerificationError { failure }`, types `SealA`, `SealB`, `Unsigned<T>`, `AuditRequestPayload`, `AgentIdResolver`.
- Consumes (moved as-is): `hireAuditor(opts, request)`, `getQuote`, `HireError { code }`, `HireResult`, `Quote`, `HireOptions`; `BudgetGate`, `makeBudgetGate`, `BudgetExceededError { denial }`, `atomicToUsdc`, `usdcToAtomic`; `fetchTokenArtifact(client, token, source)`, `makeOgClient(rpcUrl?)`, `renderArtifact(a)`, `OG_TESTNET`, `TokenArtifact`; `listWithSeal(seal, token, ltvBps, opts)`, `readListing(token, opts)`.
- Produces (`packages/underwriter/src/publisher.ts`):
  ```ts
  export interface PublishReceipt {
    root: `0x${string}`; txHash: `0x${string}`; txSeq: number;
    sealHash: `0x${string}`; indexerUrl: string; bytes: number;
  }
  export interface SealPublisher { publish(seal: SealA): Promise<PublishReceipt>; }
  ```
- Produces (`packages/underwriter/src/settle.ts`, appended):
  ```ts
  /** The one signer StubVerifier accepts: registry.verifier() → verifier.signer(). */
  export async function readTrustedSigner(registry: `0x${string}`, rpcUrl?: string): Promise<`0x${string}`>;
  ```
  ABI additions: `{ name: "verifier", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }` on the registry and `{ name: "signer", … outputs: [{ type: "address" }] }` on the verifier.
- Produces (`packages/underwriter/src/underwrite.ts`):
  ```ts
  export type Stage = "read" | "quote" | "hire" | "verify" | "compose" | "publish" | "settle";
  export interface StepEvent { stage: Stage; message: string; }
  export type UnderwriteFailure =
    | "NO_CODE_AT_ADDRESS" | "BUDGET_REFUSED"
    | "NO_PAYMENT_CHALLENGE" | "NO_PAYMENT_REQUIRED_HEADER" | "NO_ACCEPTABLE_SCHEME" | "AUDIT_REQUEST_FAILED"
    | "DELEGATE_SEAL_INVALID" | "NO_REGISTRY"
    | "SEAL_SUBJECT_MISMATCH" | "AUDIT_FAILED" | "LTV_EXCEEDS_ATTESTED" | "SEAL_EXPIRED" | "NO_SEAL" | "BAD_SIGNATURE" | "LIST_FAILED";

  export interface UnderwriteRequest {
    token: `0x${string}`; ltvBps: number; source: string | null;
    settle: boolean; publish: boolean;
  }
  export interface UnderwriteDeps {
    account: PrivateKeyAccount;              // Agent A's key
    agentId: string;                         // Agent A's Agentic ID
    auditor: { url: string; agentId: string };
    resolver: AgentIdResolver;               // must resolve auditor.agentId
    budget: BudgetGate;
    network: `${string}:${string}`;
    dryRun: boolean;
    registry: `0x${string}` | null;
    rpcUrl?: string;
    publisher?: SealPublisher | null;
    onStep?: (e: StepEvent) => void;
    now?: () => number;                      // unix seconds; default Date.now()/1000
    // seams — defaults are the real functions from this package
    fetchArtifact?: typeof fetchTokenArtifact;
    hire?: typeof hireAuditor;
    list?: typeof listWithSeal;
    trustedSigner?: typeof readTrustedSigner;
  }
  export interface HireSummary {
    priceAtomic: string; humanPrice: string; payTo: `0x${string}`; settlementTx: `0x${string}` | null;
  }
  export type UnderwriteResult =
    | { ok: true; kind: "dry-run"; quote: { humanPrice: string; payTo: `0x${string}`; amountAtomic: string }; budget: string }
    | { ok: true; kind: "sealed"; sealA: SealA; sealHash: `0x${string}`; sealB: SealB; hire: HireSummary;
        storage: PublishReceipt | null; listing: { txHash: `0x${string}`; ltvBps: number } | null;
        skipped: { settle?: string; publish?: string } }
    | { ok: false; stage: Stage; code: UnderwriteFailure; detail: string };

  /** Step (2): RPC read, rendered artifact + ownAnalysis. Throws Error("NO_CODE_AT_ADDRESS: …") like fetchTokenArtifact. */
  export async function readToken(token: `0x${string}`, source: string | null, deps: Pick<UnderwriteDeps, "rpcUrl" | "fetchArtifact">):
    Promise<{ request: AuditRequestPayload; ownAnalysis: SealA["ownAnalysis"] }>;

  /** Steps (3)–(5): quote → budget gate → pay → verify seal B. Never composes. */
  export async function hireAndVerify(request: AuditRequestPayload, deps: UnderwriteDeps):
    Promise<
      | { ok: true; kind: "dry-run"; quote: Quote; budget: string }
      | { ok: true; kind: "hired"; sealB: SealB; hire: HireSummary }
      | { ok: false; stage: "quote" | "hire" | "verify"; code: UnderwriteFailure; detail: string }>;

  /** Step (6): seal A around a verified seal B. Pure except for the signature. */
  export async function composeSealA(args: {
    request: AuditRequestPayload; sealB: SealB; hire: HireSummary; ownAnalysis: SealA["ownAnalysis"];
    ltvBps: number; agentId: string; auditorAgentId: string; network: `${string}:${string}`; account: PrivateKeyAccount;
  }): Promise<SealA>;

  /** Steps (2)–(7). Never throws for a refusal; throws only on programmer error. */
  export async function underwrite(req: UnderwriteRequest, deps: UnderwriteDeps): Promise<UnderwriteResult>;
  ```
  Semantics to preserve from today's `agent-a/src/index.ts`:
  - `hireAndVerify`: `BudgetExceededError` → `{ ok:false, stage:"quote", code:"BUDGET_REFUSED", detail: \`${err.denial} — nothing was signed. ${budget.summary()}\` }`; `HireError` → `{ stage: "quote"|"hire", code: err.code, detail: err.message }` (stage `quote` for the three quote codes, `hire` for `AUDIT_REQUEST_FAILED`); `hired.sealB === null` → `{ stage:"verify", code:"DELEGATE_SEAL_INVALID", detail:"NO_SEAL — the service kept the fee and signed nothing. Nothing to verify, nothing to embed, nothing reaches the chain." }`; `SealVerificationError` → `{ stage:"verify", code:"DELEGATE_SEAL_INVALID", detail: \`${err.failure} — refusing to compose seal A. Nothing was submitted on chain.\` }`. `verifySealB` ctx: `expectedSubject: request.token`, `expectedRequest: auditRequestHash(request)`, `resolver: deps.resolver`, `now: deps.now()`.
  - `composeSealA`: exactly the object built today (version 1, type "underwriting", delegations[0] = `{ agentId: auditorAgentId, service: "code-audit", priceAtomic, network, settlementTx, seal: sealB, sealVerified: true }`, verdict `{ action: sealB.verdict.action, maxLtvBps: Math.min(sealB.verdict.maxLtvBps, ltvBps > 0 ? sealB.verdict.maxLtvBps : 0), expiresAt: sealB.expiresAt }`).
  - `underwrite` after compose: `sealHash = sealDigest(sealA)`. **Publish** (if `req.publish && deps.publisher`): `await publisher.publish(sealA)`; on throw → `storage: null`, `skipped.publish = \`PUBLISH_FAILED: ${message}\``, emit a `publish` step with that text, continue. **Settle** (if `req.settle`): `registry === null` → `{ ok:false, stage:"settle", code:"NO_REGISTRY", detail:"pass --registry <address> or set REGISTRY_ADDRESS" }`; else `trusted = await trustedSigner(registry, rpcUrl)`; if `!isAddressEqual(trusted, account.address)` → `listing: null`, `skipped.settle = \`UNTRUSTED_SIGNER: registry verifier trusts ${trusted}, this agent signs as ${account.address}\`` (never call `list`); else `list(...)` → `listing`, and on throw map the message with the existing regex `/(SEAL_SUBJECT_MISMATCH|AUDIT_FAILED|LTV_EXCEEDS_ATTESTED|SEAL_EXPIRED|NO_SEAL|BAD_SIGNATURE)/` to `{ ok:false, stage:"settle", code, detail:"reverted by CollateralRegistry" }`, else `code:"LIST_FAILED", detail: msg.slice(0,300)`.
  - `readToken` throwing `NO_CODE_AT_ADDRESS` → `underwrite` returns `{ ok:false, stage:"read", code:"NO_CODE_AT_ADDRESS", detail }`.
  - `onStep` messages mirror today's `step(n, msg)` texts (same wording, stage instead of number).

**Steps:**
- [ ] 1. Create `packages/underwriter/package.json` (name `@acu/underwriter`, `"main": "./src/index.ts"`, `"exports": { ".": "./src/index.ts" }`, scripts `test`/`typecheck` as in `packages/seal/package.json`, deps `@acu/seal workspace:*`, `@x402/core`, `@x402/evm`, `@x402/fetch` `^2.24.0`, `viem ^2.23.2`; devDeps `vitest`, `tsx`) and `tsconfig.json` copied from `packages/seal/tsconfig.json`. `git mv` the four `agent-a/src/*.ts` modules and `agent-a/test/budget.test.ts`; fix the test's relative import. Add `src/publisher.ts` and `src/index.ts` (`export * from` each module). Run `pnpm install` → verify: `pnpm --filter @acu/underwriter typecheck && pnpm --filter @acu/underwriter test` → 15 budget tests pass.
- [ ] 2. Append `readTrustedSigner` to `settle.ts` (ABI + two `readContract` calls). Verify: typecheck passes.
- [ ] 3. RED: write `test/underwrite.test.ts` using `demo/fixtures/replay/clean.json` (real seal B; signer = recover it with `recoverSealSigner` in the test and feed a `StaticAgentIdResolver({ "2": signer })`) and a throwaway A key (`privateKeyToAccount("0x…01")`). Inject `fetchArtifact` returning a fixed artifact, `hire` returning canned `HireResult`s, `list`/`trustedSigner` stubs, `now: () => fixture.request.requestedAt`. Cases, one behavior each:
  - `hireAndVerify` dry run → `kind:"dry-run"` with the quote, budget untouched.
  - hire returns `sealB: null` → `DELEGATE_SEAL_INVALID` with detail starting `NO_SEAL`.
  - hire returns the tampered seal from `clean-tampered.json` → `DELEGATE_SEAL_INVALID` with detail starting `SIGNER_MISMATCH`.
  - `clean-noattest.json` seal → detail starting `ATTESTATION_MISSING`.
  - `hire` throws `HireError("NO_PAYMENT_CHALLENGE", …)` → `stage:"quote"`, that code.
  - budget gate refuses (allowlist without the payee) → `BUDGET_REFUSED`, and the injected `hire` was never called past the quote (assert via a flag).
  - happy path, `settle:false, publish:false` → `kind:"sealed"`, `sealA.delegations[0].seal` deep-equals fixture seal B, `sealHash === sealDigest(sealA)`, `verifySealA(sealA, { expectedSubject, resolver: {1: A, 2: B}, now })` passes.
  - `settle:true`, `trustedSigner` returns another address → `listing: null`, `skipped.settle` starts `UNTRUSTED_SIGNER`, `list` never called.
  - `settle:true`, trusted, `list` throws `Error("… LTV_EXCEEDS_ATTESTED …")` → `ok:false, stage:"settle", code:"LTV_EXCEEDS_ATTESTED"`.
  - `publish:true` with a publisher that throws → `storage: null`, `skipped.publish` starts `PUBLISH_FAILED`, result still `ok:true`.
  - `publish:true` with a publisher returning a receipt → `storage` equals it, and `storage.sealHash === sealHash`.
  Run `pnpm --filter @acu/underwriter test` → expect FAIL: `underwrite.ts` does not exist.
- [ ] 4. GREEN: implement `src/underwrite.ts` per the interface. Run the focused test, then `pnpm -r test` → all green (30 + 14 + 15 + 7 + new).
- [ ] 5. Rewrite `agent-a/src/index.ts`: same `parseArgs` (+ `--publish` boolean flag), build `UnderwriteDeps` from env exactly as today (`AGENT_A_PRIVATE_KEY`, `AGENT_A_ID`, `AGENT_B_ID`, `AGENT_B_SEAL_SIGNER`, `AGENT_B_PAYTO`, `PAYMENT_NETWORK`, ledger at `../../.budget-ledger.json`), `publisher: null` for now (Task 2 wires it), `onStep` prints `[n] msg` with `read→2, quote→3, hire→3/4, verify→5, compose→6, publish→S, settle→7` (hire result line "agent B returned …" is `[4]`). Map `UnderwriteResult` to the frozen output: dry-run → the two `[3]` lines + `\n○ DRY RUN — stopped before signing. Re-run with --live to pay and continue.`; `ok:false` → `\n✗ ${code}\n  ${detail}` + `process.exit(1)`; sealed + listing → `\n✓ EXECUTED  ltv=${ltvBps}bps  tx=${txHash}`; sealed + `skipped.settle` → print `[7] skipped: ${reason}` then the seal JSON and `\n○ --no-settle: seal A printed, nothing submitted on chain.` is for `!settle` only — for the untrusted-signer skip print `\n○ NOT LISTED — ${reason}` (new line; documents G(a)); `--emit-seal` writes `sealA`. Keep `--seal-file` (uses `listWithSeal` directly, as today) and `--offline` (`runOffline` unchanged except imports) in the CLI. Update `agent-a/scripts/record.ts` and `stability.ts` imports to `@acu/underwriter`; `agent-a/package.json` deps: add `@acu/underwriter workspace:*`, keep the rest. `underwrite`'s dry-run result maps `Quote` to `{ humanPrice, payTo, amountAtomic: quote.amountAtomic.toString() }`. Verify: `pnpm -r typecheck` clean; `pnpm --filter @acu/agent-a start` (no args) prints the usage line and exits 2; `pnpm --filter @acu/agent-a start -- 0x0000000000000000000000000000000000000001 --no-settle` (one free RPC read, no key needed until after the read — so set `AGENT_A_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001 AGENT_B_SEAL_SIGNER=0x0000000000000000000000000000000000000001` inline) prints `✗ NO_CODE_AT_ADDRESS` and exits 1.
- [ ] 6. Commit: `refactor: extract @acu/underwriter from agent-a; underwrite() as a library, CLI as a printer`.

**Wayne-workflow rules for this task:** Expand → migrate → contract — every commit compiles and `pnpm -r test` is green. Smallest diff: moved files keep their content; only import paths change. Fail-loud: every refusal keeps its existing code string. Fixtures come from real recorded data (`demo/fixtures/replay/*.json`), never hand-written seals. Do not read `.env`, do not run `demo/run.sh`, do not pass `--live` anywhere; the orchestrator runs the live sample.

---

### Task 2: `@acu/storage` — publish seal A to 0G Storage, locate and fetch it by `sealHash`

**Files:** Create `packages/storage/{package.json,tsconfig.json}`, `packages/storage/src/{index,publish,locate,fetch}.ts` · Test `packages/storage/test/{locate,fetch}.test.ts` · Modify `agent-a/src/index.ts` (wire the publisher when `--publish`), `agent-a/package.json`

**Interfaces:**
- Consumes: `canonicalize`, `sealDigest`, `SealA` from `@acu/seal`; `SealPublisher`, `PublishReceipt` from `@acu/underwriter`; `Indexer`, `MemData` from `@0gfoundation/0g-storage-ts-sdk`; `ethers` (`JsonRpcProvider`, `Wallet`).
- Produces (`src/publish.ts`, Node only, the **only** file importing `ethers` or the 0G SDK):
  ```ts
  export interface PublishOptions { privateKey: `0x${string}`; rpcUrl: string; indexerUrl: string; }
  export const OG_TESTNET_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";
  export const OG_TESTNET_RPC = "https://evmrpc-testnet.0g.ai";
  /** Uploads canonicalize(seal) as UTF-8 with tags = sealDigest(seal). */
  export async function publishSeal(seal: SealA, opts: PublishOptions): Promise<PublishReceipt>;
  export function ogStoragePublisher(opts: PublishOptions): SealPublisher;
  ```
  Implementation: `bytes = new TextEncoder().encode(canonicalize(seal))`; `file = new MemData(bytes)`; `indexer.upload(file, opts.rpcUrl, new Wallet(privateKey, new JsonRpcProvider(rpcUrl)), { tags: sealDigest(seal) })` → `[res, err]`; `err !== null` → throw `Error(\`OG_STORAGE_UPLOAD_FAILED: ${err.message}\`)`; `res` may be the single or the multi shape — accept only the single (`"txHash" in res`), otherwise throw `OG_STORAGE_UNEXPECTED_RESULT`. Receipt `{ root: res.rootHash, txHash: res.txHash, txSeq: res.txSeq, sealHash, indexerUrl, bytes: bytes.length }`.
- Produces (`src/locate.ts`, isomorphic, viem only):
  ```ts
  export const OG_FLOW_TESTNET = "0x22E03a6A89B950F1c82ec5e74F8eCa321a105296" as const;
  export const SUBMIT_EVENT = { type: "event", name: "Submit", inputs: [
    { name: "sender", type: "address", indexed: true }, { name: "identity", type: "bytes32", indexed: true },
    { name: "submissionIndex", type: "uint256" }, { name: "startPos", type: "uint256" }, { name: "length", type: "uint256" },
    { name: "submission", type: "tuple", components: [
      { name: "length", type: "uint256" }, { name: "tags", type: "bytes" },
      { name: "nodes", type: "tuple[]", components: [{ name: "root", type: "bytes32" }, { name: "height", type: "uint256" }] } ] } ] } as const;
  /** Fold right-to-left: root = nodes[last].root; for i = last-1 … 0: root = keccak256(concat(nodes[i].root, root)). Verified against txSeq 149629. */
  export function rootFromNodes(nodes: readonly { root: `0x${string}`; height: bigint | number }[]): `0x${string}`;
  export interface LocateOptions {
    rpcUrl: string; sender: `0x${string}`; flowAddress?: `0x${string}`;
    chunkBlocks?: bigint;      // default 5_000_000n
    maxChunks?: number;        // default 12 (≈ 60M blocks, the whole chain today)
    getLogs?: (args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }) => Promise<SubmitLog[]>;  // seam; default viem publicClient.getLogs with { event: SUBMIT_EVENT, args: { sender } }
    latestBlock?: () => Promise<bigint>;                                                                          // seam
  }
  export interface SubmitLog { blockNumber: bigint; transactionHash: `0x${string}`; args: { submissionIndex: bigint; submission: { tags: `0x${string}`; nodes: readonly { root: `0x${string}`; height: bigint }[] } } }
  export interface Located { root: `0x${string}`; txHash: `0x${string}`; txSeq: number; blockNumber: bigint; }
  /** Scans backwards from latest in chunkBlocks windows; returns the newest Submit whose tags equal sealHash, or null after maxChunks. */
  export async function locateSeal(sealHash: `0x${string}`, opts: LocateOptions): Promise<Located | null>;
  ```
- Produces (`src/fetch.ts`, isomorphic):
  ```ts
  export interface FetchOptions { indexerUrl: string; fetch?: typeof fetch; }
  export async function fetchSealBytes(root: `0x${string}`, opts: FetchOptions): Promise<Uint8Array>;   // GET {indexerUrl}/file?root={root}; non-2xx → Error("OG_GATEWAY_" + status)
  export class SealNotFoundError extends Error { constructor(readonly reason: "NO_SUBMISSION" | "BAD_JSON" | "DIGEST_MISMATCH", detail?: string) }
  /** locate → fetch → JSON.parse → sealDigest(parsed) === sealHash, else SealNotFoundError. Returns the parsed seal (unverified) and where it came from. */
  export async function resolveSeal(sealHash: `0x${string}`, opts: LocateOptions & FetchOptions): Promise<{ seal: unknown; located: Located }>;
  ```
  Note: the gateway answers 200 with a JSON error body for unknown roots — that is why the digest check, not the status, is the truth.
- `src/index.ts` exports locate + fetch only. `package.json` `exports`: `".": "./src/index.ts"`, `"./publish": "./src/publish.ts"`, `"./locate": "./src/locate.ts"`, `"./fetch": "./src/fetch.ts"`.

**Steps:**
- [ ] 1. Package skeleton (deps: `@acu/seal`, `@acu/underwriter` `workspace:*`, `viem ^2.23.2`, `@0gfoundation/0g-storage-ts-sdk 1.2.12`, `ethers 6.13.1`; devDeps `vitest`). `pnpm install`. Verify: `pnpm --filter @acu/storage typecheck` on empty `src/index.ts`.
- [ ] 2. RED `test/locate.test.ts`: (a) `rootFromNodes(spikeNodes) === "0xec5a33d2e244bba38ff92353534f39333b7c70302bafe1e64d7a1a2a8cd8a42f"`; (b) `rootFromNodes` of a single node returns that node's root; (c) `locateSeal` with an injected `getLogs` that records the `[fromBlock, toBlock]` windows and returns the spike log only for the window containing block 53526025, `latestBlock: () => 53526210n`, `chunkBlocks: 1000n`, `maxChunks: 3` → returns `{ root: 0xec5a…, txSeq: 149629, blockNumber: 53526025n }` and the recorded windows are contiguous, descending, non-overlapping; (d) `maxChunks` exhausted with no match → `null`; (e) two matching logs in one window → the one with the higher blockNumber wins. Run → FAIL (module missing).
- [ ] 3. GREEN `src/locate.ts`. Focused test green.
- [ ] 4. RED `test/fetch.test.ts` with an injected `fetch`: (a) `fetchSealBytes` returns the body bytes on 200; (b) 503 → `Error` message starts `OG_GATEWAY_503`; (c) `resolveSeal` where the located file's bytes are `canonicalize(exampleSealA)` (read from `verifier/example-sealA.json`) and `sealHash = sealDigest(exampleSealA)` → returns a seal deep-equal to the example; (d) bytes of a *different* seal → `SealNotFoundError("DIGEST_MISMATCH")`; (e) `{"code":…}` gateway error body → `SealNotFoundError("DIGEST_MISMATCH")` (it parses, it just is not the seal); (f) `locateSeal` → null → `SealNotFoundError("NO_SUBMISSION")`. Run → FAIL.
- [ ] 5. GREEN `src/fetch.ts`. `pnpm --filter @acu/storage test` green.
- [ ] 6. `src/publish.ts` per the interface (glue over the SDK; no unit test — the orchestrator's live sample is the check). Typecheck must pass with `ethers` types.
- [ ] 7. Wire the CLI: in `agent-a/src/index.ts`, when `args.publish` build `publisher: ogStoragePublisher({ privateKey: AGENT_A_PRIVATE_KEY, rpcUrl: process.env.OG_RPC_URL ?? OG_TESTNET_RPC, indexerUrl: process.env.OG_INDEXER_URL ?? OG_TESTNET_INDEXER })` (import from `@acu/storage/publish`), else `null`. Print the receipt as `[S] published to 0G Storage · root ${root} · tx ${txHash}` via the `publish` stage. Add `@acu/storage workspace:*` to `agent-a/package.json`. Verify: `pnpm -r typecheck && pnpm -r test`.
- [ ] 8. Commit: `feat: @acu/storage — seal bodies on 0G Storage, located by sealHash via Flow.Submit tags`.

**Wayne-workflow rules for this task:** `ethers` and the 0G SDK are confined to `publish.ts`; `locate.ts`/`fetch.ts` must import only `viem`, `@acu/seal`, and the platform `fetch`, because the browser bundle imports them. Fixtures are the real spike values, not invented ones. Never call the network from a test; the orchestrator runs the golden sample. Fail loud: unknown root is a `DIGEST_MISMATCH`, never a silently returned error object.

---

### Task 3: `@acu/auditor` — extract the B side; `sealedAuditRoute()`; agent-b becomes the example

**Files:** Create `packages/auditor/{package.json,tsconfig.json}`, `packages/auditor/src/{index,config,route}.ts` · Move `agent-b/src/audit.ts`, `agent-b/src/seal.ts` → `packages/auditor/src/` · Move `agent-b/test/seal.test.ts` → `packages/auditor/test/seal.test.ts` · Modify `agent-b/src/config.ts`, `agent-b/src/server.ts`, `agent-b/package.json`

**Interfaces:**
- Consumes: `RouterClient`, `InferenceResult`, `OgNetwork` from `@acu/og`; `signSealB`, `auditRequestHash`, `AuditRequestPayload` from `@acu/seal`; `paymentMiddleware`, `x402ResourceServer` from `@x402/express`; `HTTPFacilitatorClient` from `@x402/core/server`; `ExactEvmScheme` from `@x402/evm/exact/server`.
- Produces (`src/config.ts`): `export interface AuditorConfig` = today's `AgentBConfig` **minus** `port` (fields: `payToAddress, priceUsd, network, facilitatorUrl, sealAccount, agentId, sealTtlSeconds, og: { network, apiKey, model, skipAttestation }`). No `process.env` anywhere in the package.
- Produces (`src/route.ts`):
  ```ts
  export interface MountedAuditor { model: string; agentCard: () => Record<string, unknown>; }
  /** Mounts GET /agent (free) and POST /audit (x402) on `app`. Body schema, 400/502 rules and the agent card are today's server.ts verbatim. */
  export function sealedAuditRoute(app: import("express").Express, config: AuditorConfig): MountedAuditor;
  ```
  `agentCard()` returns the object today's `GET /agent` sends. `app.use(express.json({ limit: "1mb" }))` stays in the example, not the package (the host app owns body parsing) — document that in the route's doc comment and check `req.body` is an object, else 400 `BAD_REQUEST`.
- `agent-b/src/config.ts`: `loadConfig(): AuditorConfig & { port: number }` (same env names as today). `agent-b/src/server.ts`: `loadEnv`, `express()`, `json`, `const mounted = sealedAuditRoute(app, config)`, `listen` with the same banner (use `mounted.model`).

**Steps:**
- [ ] 1. Package skeleton (deps `@acu/og`, `@acu/seal` `workspace:*`, `@x402/core|evm|express ^2.24.0`, `express ^4.21.2`, `viem`, `zod`; devDeps `@types/express`, `vitest`). `git mv` the two modules and the test; fix imports (`./config.js` type import now points at the package's `AuditorConfig`). Verify: `pnpm --filter @acu/auditor typecheck && pnpm --filter @acu/auditor test` → 7 tests.
- [ ] 2. Write `src/route.ts` by moving the middleware + handlers out of `agent-b/src/server.ts`. Rewrite `agent-b/src/{config,server}.ts` as above; `agent-b/package.json` deps → `@acu/auditor workspace:*`, `express`, `dotenv`, `@types/express`. Verify: `pnpm -r typecheck && pnpm -r test`.
- [ ] 3. Verification command (no keys needed for the free route): `AGENT_B_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001 TESTNET_API_KEY=sk-test AGENT_B_PORT=4999 pnpm --filter @acu/agent-b start & sleep 4; curl -s localhost:4999/agent | head -c 300; curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:4999/audit -H 'Content-Type: application/json' -d '{}'; kill %1` → expect a JSON card with `"service":"code-audit"` and `402` (the payment challenge precedes body validation, exactly as today). Note the observed output in the report.
- [ ] 4. Commit: `refactor: extract @acu/auditor; sealedAuditRoute() turns any express app into a seal-issuing B`.

**Wayne-workflow rules for this task:** Smallest diff — moved files keep their content. Keep the 502-on-failure rule and its comment (payment settles on 2xx). Never `x402-express`. No `process.env` inside `packages/auditor`. Do not read `.env`.

---

### Task 4: `@acu/mcp` — the Agent A toolkit over stdio, plus `HttpAgentIdResolver`

**Files:** Create `packages/seal/src/resolver.ts` (+ export from `packages/seal/src/index.ts`), `packages/mcp/{package.json,tsconfig.json}`, `packages/mcp/src/{config,server,index}.ts`, `packages/mcp/src/tools/{describe-auditor,quote-audit,hire-audit,verify-seal,underwrite,get-listing}.ts` · Test `packages/seal/test/resolver.test.ts`, `packages/mcp/test/tools.test.ts`

**Interfaces:**
- Produces (`packages/seal/src/resolver.ts`):
  ```ts
  export const DirectoryEntry = z.object({ agentId: z.string().min(1), signer: Address, role: z.enum(["auditor", "underwriter"]), endpoint: z.string().url().optional(), price: z.string().optional() });
  export const Directory = z.object({ agents: z.array(DirectoryEntry) });
  export type Directory = z.infer<typeof Directory>;
  /** Fetches a Directory once (lazily) and resolves agentId → signer from it. Unknown id → null. */
  export class HttpAgentIdResolver implements AgentIdResolver { constructor(url: string, fetchImpl?: typeof fetch); resolve(agentId: string): Promise<`0x${string}` | null>; directory(): Promise<Directory>; }
  export function resolverFromDirectory(d: Directory): StaticAgentIdResolver;
  ```
- Consumes: everything from Task 1 (`underwrite`, `hireAndVerify`, `readToken`, `makeBudgetGate`, `readListing`, `readTrustedSigner`, `OG_TESTNET`), Task 2 (`ogStoragePublisher`, `resolveSeal`, `OG_TESTNET_INDEXER`, `OG_TESTNET_RPC`), `@acu/seal` (`verifySealA`, `verifySealB`, `recoverSealSigner`, `sealDigest`, `SealA`, `SealB`, `SealVerificationError`).
- Produces (`src/config.ts`):
  ```ts
  export interface McpConfig {
    agentKey: `0x${string}` | null;   // ACU_AGENT_KEY — absent → every paid tool stops at the quote
    agentId: string;                  // ACU_AGENT_ID, default "1"
    auditorUrl: string;               // ACU_AUDITOR_URL override; default = the directory's first role:"auditor" entry's `endpoint`
    auditorAgentId: string;           // ACU_AUDITOR_AGENT_ID override; default = that same entry's `agentId`
    directory: Directory;             // from ACU_DIRECTORY_JSON (inline) or fetched from ACU_DIRECTORY_URL at startup; ACU_DIRECTORY_URL defaults to `${ACU_WEB_URL ?? "https://wayneal.github.io/0G"}/directory.json` so zero env works
    webUrl: string;                   // ACU_WEB_URL, default "https://wayneal.github.io/0G"
    usdc: `0x${string}`;              // ACU_USDC, default Base Sepolia USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e
    faucetUrl: string;                // ACU_FAUCET_URL, default "https://faucet.circle.com"
    paymentRpcUrl: string;            // ACU_PAYMENT_RPC_URL, default "https://sepolia.base.org"
    registry: `0x${string}` | null;   // ACU_REGISTRY
    rpcUrl: string;                   // ACU_RPC_URL, default OG_TESTNET_RPC
    indexerUrl: string;               // ACU_INDEXER_URL, default OG_TESTNET_INDEXER
    network: `${string}:${string}`;   // ACU_PAYMENT_NETWORK, default "eip155:84532"
    ledgerPath: string;               // ACU_LEDGER_PATH, default `${os.homedir()}/.acu/budget-ledger.json`
    allowedPayTo: `0x${string}`[];    // ACU_ALLOWED_PAYTO (comma list); default: the directory's auditor signers
    publish: boolean;                 // ACU_PUBLISH, default "true"
  }
  export function loadConfig(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<McpConfig>;  // throws Error("DIRECTORY_UNREACHABLE: <url> — <cause>; set ACU_DIRECTORY_URL or ACU_DIRECTORY_JSON") when the default site fetch fails; throws Error("DIRECTORY_HAS_NO_AUDITOR") when no auditor entry has an endpoint and ACU_AUDITOR_URL is unset
  ```
- Produces (`src/usdc.ts`):
  ```ts
  /** balanceOf(payer) on the USDC contract over paymentRpcUrl. Throws Error("USDC_RPC_UNREACHABLE: …") on transport failure. */
  export async function usdcBalance(cfg: Pick<McpConfig, "usdc" | "paymentRpcUrl">, payer: `0x${string}`, client?: PublicClient): Promise<bigint>;
  /** The onboarding text: "Fund <payer> with Base Sepolia USDC at <faucetUrl> (select Base Sepolia, paste the address). Need <price>, have <balance>." */
  export function fundingHint(cfg: McpConfig, payer: `0x${string}`, needAtomic: bigint, haveAtomic: bigint): string;
  ```
  `hire_audit` and `underwrite`, when `agentKey !== null` and not dry-run, call `usdcBalance` **after the quote and before the budget gate**; `balance < quote.amountAtomic` → `{ ok:false, stage:"hire", code:"INSUFFICIENT_USDC", detail: fundingHint(...) }`. `USDC_RPC_UNREACHABLE` is surfaced as its own refusal, never swallowed into a "proceed anyway".
- Produces (`src/server.ts`): `export function createServer(config: McpConfig): McpServer` registering exactly these tools (names are the contract):
  | tool | inputSchema (zod raw shape) | behavior |
  |---|---|---|
  | `describe_auditor` | `{ url: z.string().url().optional() }` | GET `new URL("/agent", url ?? config.auditorUrl)`; returns the card JSON; non-2xx → `isError: true` with `AUDITOR_UNREACHABLE: <status>` |
  | `quote_audit` | `{ token: Address, source: z.string().optional() }` | `readToken` → `hireAndVerify` with `dryRun: true` → `{ quote, budget }` |
  | `hire_audit` | `{ token, source?, ltvBps: z.number().int().min(0).max(10000).default(7000) }` | `hireAndVerify` with `dryRun: config.agentKey === null` → `{ kind, sealB, hire }` or the refusal `{ ok:false, stage, code, detail }` |
  | `verify_seal` | `{ seal: z.union([z.string(), z.record(z.unknown())]), expectedSubject: Address.optional() }` | parse string as JSON; `type === "audit"` → `verifySealB(seal, { expectedSubject: expectedSubject ?? seal.subject, expectedRequest: seal.request, resolver, now })`; `type === "underwriting"` → `verifySealA`; returns `{ valid: true, type, signer, subject, verdict, expiresAt, attestation?: {...} }` or `{ valid: false, failure, detail }` (never `isError` — an invalid seal is a result, not a tool failure). Note in the text: when `expectedSubject` is omitted, subject/request bindings are checked for self-consistency only. |
  | `underwrite` | `{ token, ltvBps (default 7000), source?, settle: z.boolean().default(true), publish: z.boolean().default(config.publish) }` | full `underwrite()` with `dryRun: config.agentKey === null`; returns the `UnderwriteResult` verbatim plus, when sealed, `shareUrl` (see below) |
  | `agent_status` | `{}` | The onboarding tool. Returns `{ agentId, address: payer\|null, hasKey, usdc: { balance: string\|null, faucetUrl }, budget: { remainingSession, remainingHour, ledgerPath }, auditor: { url, agentId, online: boolean, card\|null, price\|null }, directoryUrl, nextStep: string }`. `nextStep` is exactly one of: `"Add a key: openssl rand -hex 32, then re-add the MCP with -e ACU_AGENT_KEY=0x<hex>"` (no key); `"Fund <address> at <faucetUrl> (Base Sepolia USDC); you need at least <price>"` (key, balance below the auditor's price or unknown price → below $0.01); `"Reference auditor is offline — try again later or set ACU_AUDITOR_URL"` (auditor unreachable, checked before the balance); `"Ready: call underwrite with a token address, e.g. CleanUSD 0xDB08Ce217Ce842b06baf76a0Bbb2C10f47fF9eB8"`. Never `isError`. |
  | `get_listing` | `{ token: Address }` | `readListing` → if `!active` or `sealHash` zero → `{ listed: false, ... }`; else `trusted = readTrustedSigner(registry)`; `resolveSeal(sealHash, { sender: trusted, rpcUrl, indexerUrl })` → verify with `verifySealA` (resolver from directory) → `{ listed: true, listing, seal, root, txHash, valid, failure? }`; a `SealNotFoundError` → `{ listed: true, listing, seal: null, reason }` |
  Every handler returns `{ content: [{ type: "text", text: JSON.stringify(result, bigintReplacer, 2) }] }` where `bigintReplacer` renders bigint as string. Paid tools with `agentKey === null` add `"note": "no ACU_AGENT_KEY — stopped at the quote. Next: openssl rand -hex 32, then re-add the MCP with -e ACU_AGENT_KEY=0x<hex> and call agent_status."`. `shareUrl` = `${ACU_WEB_URL ?? "https://wayneal.github.io/0G"}/#seal=${base64url(JSON.stringify(sealA))}` (Task 5's page reads that fragment).
  Deps for `underwrite`: `account = privateKeyToAccount(agentKey)` (or a fixed throwaway key when null — dry-run never signs), `resolver = resolverFromDirectory(config.directory)`, `budget = makeBudgetGate(config.allowedPayTo, config.ledgerPath)`, `publisher = config.agentKey && publish ? ogStoragePublisher({ privateKey: agentKey, rpcUrl, indexerUrl }) : null`.
- Produces (`src/index.ts`): `loadConfig(process.env)` → `createServer` → `StdioServerTransport` → `server.connect(transport)`. All logging to `stderr` (stdout is the protocol channel). Because the workspace consumes TypeScript source, the bin is `bin/acu-mcp.mjs`:
  ```js
  #!/usr/bin/env node
  import { register } from "node:module";
  register("tsx/esm", import.meta.url);
  await import("../src/index.ts");
  ```
  with `"bin": { "acu-mcp": "./bin/acu-mcp.mjs" }` and `tsx` as a runtime dependency. Task 7 points the bin at a built `dist/index.js` for npm.

**Steps:**
- [ ] 1. RED `packages/seal/test/resolver.test.ts`: `HttpAgentIdResolver` with an injected fetch returning `{ agents: [{ agentId: "2", signer: "0xAbC…", role: "auditor" }] }` resolves `"2"` to the lowercased signer, `"9"` to null, and fetches exactly once across two calls; malformed body → throws with the zod issue. Run → FAIL. GREEN: implement `resolver.ts`, export from `index.ts`. `pnpm --filter @acu/seal test` green (30 + new).
- [ ] 2. MCP package skeleton (deps: `@modelcontextprotocol/sdk ^1.30.0`, `zod ^3.25.0`, `@acu/seal|underwriter|storage workspace:*`, `viem`, `tsx`; devDeps `vitest`, `@types/node`). `pnpm install`. Verify typecheck on empty server.
- [ ] 3. RED `packages/mcp/test/tools.test.ts` (real behavior over the real protocol, no mocks): start the server with `StdioClientTransport({ command: "node", args: ["bin/acu-mcp.mjs"], env: { ...process.env, ACU_DIRECTORY_JSON: JSON.stringify(dir), ACU_AUDITOR_URL: "http://127.0.0.1:1/audit" } })` where `dir` maps `"1"` and `"2"` to the signers recovered from `verifier/example-sealA.json` (recover with `recoverSealSigner` in the test). Cases: (a) `listTools()` returns exactly the seven names; (b) `verify_seal` with the example seal A → `valid: true, type: "underwriting"`; (c) `verify_seal` with `examples.json`'s `tampered` seal B → `valid: false, failure: "SIGNER_MISMATCH"`; (d) `verify_seal` with `noattest` → `failure: "ATTESTATION_MISSING"`; (e) `describe_auditor` against the unreachable URL → `isError: true` and text containing `AUDITOR_UNREACHABLE`; (f) `quote_audit` for the CleanUSD address without `ACU_AGENT_KEY` against the unreachable auditor → the tool returns a refusal whose text contains `"stage":"quote"` (the fetch to port 1 rejects before any 402, so `getQuote` throws; the handler must convert that throw into `{ ok:false, stage:"quote", code:"AUDITOR_UNREACHABLE", detail }` rather than crash the server — add `AUDITOR_UNREACHABLE` to the codes the MCP layer can emit). Note: (f) makes one real RPC read of CleanUSD's bytecode on 0G testnet; if the RPC is down the test reports that in its message rather than failing silently. (g) `agent_status` with no key → `hasKey: false`, `nextStep` starts with `"Add a key"`; with `ACU_AGENT_KEY` set to a throwaway key and the unreachable auditor → `auditor.online: false`, `nextStep` starts with `"Reference auditor is offline"`; (h) `loadConfig` with `ACU_DIRECTORY_JSON` naming one auditor with `endpoint` and no `ACU_AUDITOR_URL` → `auditorUrl` and `auditorAgentId` come from the directory; with no auditor endpoint and no override → throws `DIRECTORY_HAS_NO_AUDITOR`; (i) `usdcBalance` with an injected client returning `0n` and `fundingHint` → text contains the payer address, the faucet URL and "Base Sepolia" (unit test, no socket). Set vitest `testTimeout: 30_000` for this file. Run → FAIL.
- [ ] 4. GREEN: `config.ts`, `usdc.ts`, `tools/*.ts` (incl. `agent-status.ts`), `server.ts`, `index.ts`, `bin/acu-mcp.mjs`. `pnpm --filter @acu/mcp test` green; `pnpm -r test` green.
- [ ] 5. Verification command: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' | ACU_DIRECTORY_JSON='{"agents":[]}' node packages/mcp/bin/acu-mcp.mjs | head -c 400` → a JSON-RPC result with `serverInfo.name === "acu"`.
- [ ] 6. Commit: `feat: @acu/mcp — seven tools that make any agent an Agent A; directory-driven defaults; USDC pre-check; HttpAgentIdResolver`.

**Wayne-workflow rules for this task:** Verification never crosses the network — `verify_seal` is `@acu/seal` in-process. Keys stay with their owners: the MCP signs with `ACU_AGENT_KEY` and nothing else; never read `.env`. Onboarding is the acceptance: zero env must reach the quote (directory default), and every stop names the next step in `detail` / `nextStep` — a newcomer reads the tool output, not our docs. Never the deprecated `.tool()` overloads. stdout is the protocol: no `console.log` anywhere in `packages/mcp/src`. Tests assert real behavior over the real stdio transport.

---

### Task 5: `web/` — Vite static site, landing-first: install line, live feed, verify, look up, docs, pitch, directory

**Files:** Create `web/{package.json,tsconfig.json,vite.config.ts,index.html}`, `web/docs/index.html`, `web/src/{verify,lookup,feed,status,render,share,main,docs}.ts`, `web/src/style.css`, `web/public/directory.json`, `web/public/examples/{example-sealA,examples}.json` (moved from `verifier/`), `web/scripts/copy-pitch.mjs` · Delete `verifier/` · Modify `.gitignore` (+ `web/dist/`, `web/public/pitch/`), `pnpm-workspace.yaml` (+ `"web"`)

**Interfaces:**
- Consumes: `verifySealA`, `verifySealB`, `recoverSealSigner`, `sealDigest`, `HttpAgentIdResolver`, `SealA`, `SealB`, `SealVerificationError` from `@acu/seal`; `resolveSeal`, `SealNotFoundError`, `OG_FLOW_TESTNET` from `@acu/storage` (root export — no `publish`); viem `createPublicClient`, `http`, `readContract`.
- Produces (`web/src/verify.ts`):
  ```ts
  export interface CheckRow { name: string; ok: boolean; detail: string; }
  export interface SealReport { kind: "audit" | "underwriting"; valid: boolean; failure: string | null; signer: `0x${string}` | null; checks: CheckRow[]; children: SealReport[]; attestation: SealB["inference"]["teeAttestation"] | null; sealHash: `0x${string}`; }
  /** Runs verifySealB/verifySealA, then re-derives per-check rows for display: schema, agent id live, signature recovers, subject, request (B only), expiry, attestation present, trust tier (B only). Rows after the failing one are marked skipped (ok=false, detail "not reached"). */
  export async function reportSeal(input: unknown, opts: { resolver: AgentIdResolver; now: number; expectedSubject?: `0x${string}` }): Promise<SealReport>;
  ```
  The eight row names and their order are the README's table: `SCHEMA`, `AGENT_ID_LIVE`, `SIGNATURE`, `SUBJECT`, `REQUEST`, `EXPIRY`, `ATTESTATION`, `TRUST_TIER`.
- Produces (`web/src/lookup.ts`):
  ```ts
  export interface LookupResult { listing: { active: boolean; ltvBps: number; sealHash: `0x${string}`; expiresAt: bigint } | null; trustedSigner: `0x${string}` | null; located: Located | null; seal: unknown | null; error: string | null; }
  export async function lookupToken(token: `0x${string}`, cfg: { rpcUrl: string; registry: `0x${string}`; indexerUrl: string }): Promise<LookupResult>;
  ```
  Reads `listings(token)`, then `verifier()` → `signer()`, then `resolveSeal(sealHash, { rpcUrl, sender: trustedSigner, indexerUrl })`; the caller then runs `reportSeal` and shows `sealDigest(seal) === listing.sealHash` as its own green row `ON_CHAIN_HASH`. `web/` must **not** import `@acu/underwriter` (it would pull the x402 packages into the bundle): declare the three view ABIs (`listings`, `verifier`, `signer`) locally in `lookup.ts`, copied from `packages/underwriter/src/settle.ts`.
- Produces (`web/src/feed.ts`):
  ```ts
  export interface FeedEntry { token: `0x${string}`; ltvBps: number; sealHash: `0x${string}`; blockNumber: bigint; txHash: `0x${string}`; }
  /** `Listed(address indexed token, uint16 ltvBps, bytes32 sealHash)` logs from the registry, newest first, walking backwards from `latest` in 5M-block chunks (same walker shape as @acu/storage locate) until `limit` entries or `fromBlock` is reached. Only the newest entry per token is kept (a relist replaces). */
  export async function listRecentListings(cfg: { rpcUrl: string; registry: `0x${string}`; fromBlock: bigint }, limit: number, client?: PublicClient): Promise<FeedEntry[]>;
  ```
  The page renders each entry as a card immediately (token, LTV, block, chainscan link) and then, lazily and in order, resolves the seal from 0G Storage (`resolveSeal` with `sender = trustedSigner`) and runs `reportSeal`, upgrading the card to green/red with the verdict, `maxLtvBps`, the auditor's model and `teeVerified`. Cards whose seal cannot be located show "body not on 0G Storage" — a state, not an error. `fromBlock` = the registry's deploy block, a constant in `config.ts` the implementer reads from `chainscan-galileo.0g.ai` for `0xC1AAfd71480Ebc92C7F9fcC4d24272bd7B46a65E` and records in the report.
- Produces (`web/src/status.ts`): `auditorStatus(endpoint: string, fetchImpl?: typeof fetch): Promise<{ online: boolean; card: unknown | null; price: string | null }>` — GET `new URL("/agent", endpoint)` with a 4 s `AbortSignal.timeout`; any failure → `online: false`. Requires CORS on `/agent` (Task 8 adds it to `sealedAuditRoute`); until then the pill reads offline and says so in its title.
- Produces (`web/src/share.ts`): `encodeShare(seal): string` / `decodeShare(fragment): unknown | null` for `#seal=<base64url JSON>`; the page verifies a shared seal on load.
- Config constants in `web/src/config.ts`: `REGISTRY = "0xC1AAfd71480Ebc92C7F9fcC4d24272bd7B46a65E"`, `RPC = "https://evmrpc-testnet.0g.ai"`, `INDEXER = "https://indexer-storage-testnet-turbo.0g.ai"`, `DIRECTORY_URL = import.meta.env.BASE_URL + "directory.json"`.
- `public/directory.json`: `{ "agents": [ { "agentId": "1", "signer": "<AGENT_A_ADDRESS from the deployed StubVerifier>", "role": "underwriter" }, { "agentId": "2", "signer": "<recover from verifier/example-sealA.json delegations[0].seal>", "role": "auditor", "endpoint": "http://localhost:4021", "price": "$0.01" } ] }` — `endpoint` is the **origin** (no path); the MCP appends `/audit` and `/agent`; Task 8's script rewrites it to the tunnel origin. The implementer derives both addresses with a one-off `tsx` snippet using `recoverSealSigner` on the example seal (A from the outer seal, B from the inner) and records the snippet output in the report — no guessing.
- Pages: `index.html` — **landing-first**, in this order: (0) hero: one sentence ("Your agent hires an auditor. Every hop is signed."), the install line `claude mcp add acu -- npx -y @acu/mcp` in a `<code>` block with a copy button, a second line "then say: underwrite 0xDB08…9eB8", and the online/offline pill from `status.ts` fed by `directory.json`'s auditor endpoint (title text says "reference auditor runs on the author's machine; offline means try later"); (1) **feed**: "Seals on chain" — `listRecentListings(…, 20)` cards as above, empty state "Nobody has underwritten yet. Be first." with the install line again; (2) verifier — three inputs stacked: paste a seal or pick one of the three built-in examples (rail as today), token address → `lookupToken`, shared link auto-loads. Result: verdict banner, seal card(s) walking down into embedded seal B, attestation block, `ON_CHAIN_HASH` row when a lookup was used, "open on storagescan" link (`https://storagescan-galileo.0g.ai/`… link to the tx on `https://chainscan-galileo.0g.ai/tx/${txHash}`). Keep the existing palette and typography from `verifier/index.html` (move its `<style>` into `src/style.css` unchanged). `docs/index.html` — opens with **"Try it in 60 seconds"**: the five funnel steps from the spec as a numbered list (install with no env → say underwrite → read `agent_status` → `openssl rand -hex 32` and re-add with `-e ACU_AGENT_KEY` → faucet → underwrite again → open the `shareUrl`), each with its exact command. Then two columns "Be an Agent A" (MCP install block: `claude mcp add acu -e ACU_AGENT_KEY=0x… -- npx -y @acu/mcp` — the directory default covers the rest, `ACU_AUDITOR_URL`/`ACU_DIRECTORY_URL` listed as overrides, the seven tools, the library snippet `underwrite(req, deps)`) and "Be an Agent B" (`sealedAuditRoute(app, config)` snippet, what the seal carries, the 502 rule); a third section "Verify anywhere" (`verifySealA` snippet, the eight checks). Plain static HTML, same stylesheet.
- `vite.config.ts`: `base: process.env.BASE_PATH ?? "/"`, `build.rollupOptions.input: { main: "index.html", docs: "docs/index.html" }`. `scripts/copy-pitch.mjs` copies `../pitch/index.html` to `public/pitch/index.html` (gitignored); `"prebuild"` and `"predev"` run it.

**Steps:**
- [ ] 1. Skeleton: `web/package.json` (name `@acu/web`, `private`, scripts `dev`, `build`, `preview`, `typecheck`, `prebuild`/`predev` → `node scripts/copy-pitch.mjs`; deps `@acu/seal`, `@acu/storage` `workspace:*`, `viem`; devDeps `vite ^8`, `typescript`), `tsconfig.json` (extends base, `lib: ["ES2023","DOM"]`, `types: ["vite/client"]`), add `"web"` to `pnpm-workspace.yaml`, `.gitignore` lines. `git mv verifier/example-sealA.json verifier/examples.json web/public/examples/`. `pnpm install`. Verify: `pnpm --filter @acu/web build` on a placeholder `index.html` succeeds.
- [ ] 2. RED `web/test/feed.test.ts`: `listRecentListings` against an injected client whose `getLogs` records the requested ranges and returns two `Listed` logs for the same token in different blocks → one entry, the newer; ranges never exceed 5,000,000 blocks and stop at `fromBlock`. `status.test.ts`: injected fetch that rejects → `online: false`; resolves with the card → `online: true, price` from the card. RED `web/test/verify.test.ts` (vitest, node env): `reportSeal(exampleSealA)` → `valid: true`, 8 rows for the inner seal, `children.length === 1`; tampered → `valid: false, failure: "SIGNER_MISMATCH"`, rows `SCHEMA`, `AGENT_ID_LIVE` ok, `SIGNATURE` not ok, later rows "not reached"; `noattest` → failure `ATTESTATION_MISSING`. `share.test.ts`: round trip; `decodeShare("#seal=!!!")` → null. Run → FAIL. GREEN.
- [ ] 3. `lookup.ts` (glue; verification is the orchestrator's live check), `render.ts` + `main.ts` porting the DOM code from `verifier/index.html` lines 311–620 onto `SealReport` (delete the hand-written `canonicalize`/`sealDigest`/`recover`; `ethers` UMD script tag goes away — viem is bundled). `docs/index.html`. `directory.json` with the derived addresses.
- [ ] 4. Delete `verifier/`. Grep the repo for `verifier/` and fix references in `README.md`, `README.zh-TW.md` (paths only — Task 6 rewrites the sections), `pitch/index.html` (if any). Verify: `grep -rn "verifier/" --include=*.md --include=*.html --include=*.ts . | grep -v node_modules` → no hits except `docs/superpowers/`.
- [ ] 5. Verification commands: `pnpm --filter @acu/web build` → `dist/index.html`, `dist/docs/index.html`, `dist/pitch/index.html`, `dist/directory.json`, `dist/examples/*.json` exist; `BASE_PATH=/0G/ pnpm --filter @acu/web build && grep -c '/0G/assets' web/dist/index.html` ≥ 1; `pnpm -r typecheck && pnpm -r test` green. Report the `dist/` size.
- [ ] 6. Commit: `feat: web — landing-first Vite site: install line, live seal feed, local verification, lookup via 0G Storage, docs, pitch`.

**Wayne-workflow rules for this task:** Verification never crosses the network: the page verifies with the bundled `@acu/seal`, it never asks a server whether a seal is valid; the only network reads are chain state, the indexer gateway, and `directory.json`. `@acu/storage` must be imported from its root or `./locate` / `./fetch` — never `./publish` (it would drag `ethers` and the 0G SDK into the bundle; Vite must not even resolve them). Keep the existing palette; the verifier section is a port, the hero and feed are new but use the same tokens. Fixtures are the real example seals. The feed verifies every seal locally before it colours a card — a listing is not a verdict.

---

### Task 6: GitHub Pages workflow, READMEs, memory of what moved

**Files:** Create `.github/workflows/pages.yml` · Modify `README.md`, `README.zh-TW.md`, `NOTES.md` (append §G: the 0G Storage spike, from the spec's Decisions block), `.env.example` (+ `OG_INDEXER_URL`, `OG_RPC_URL` comments)

**Interfaces:** none produced. Consumes the package names and tool names above verbatim.

**Steps:**
- [ ] 1. `pages.yml`: on `push` to `main` and `workflow_dispatch`; `permissions: pages: write, id-token: write, contents: read`; job `build` on `ubuntu-latest`: `pnpm/action-setup@v4` (version from `packageManager`), `actions/setup-node@v4` (node 22, cache pnpm), `pnpm install --frozen-lockfile`, `BASE_PATH=/0G/ pnpm --filter @acu/web build`, `actions/upload-pages-artifact@v3` with `path: web/dist`; job `deploy` with `environment: github-pages`, `actions/deploy-pages@v4`. Verify: `npx --yes action-validator .github/workflows/pages.yml` if available, else `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/pages.yml'))"`.
- [ ] 2. `README.md`: update "Repository layout" (add `packages/underwriter`, `packages/auditor`, `packages/storage`, `packages/mcp`, `web/`; remove `verifier/`), add a section **"Try it in 60 seconds"** right after the intro (the five funnel steps with exact commands; the clone-path variant `claude mcp add acu -- node <repo>/packages/mcp/bin/acu-mcp.mjs` in a one-line note until publish), then a section **"Use it"** before "Run it" with three sub-sections: *Your agent as an Agent A* (the `claude mcp add` block from Task 5's docs page, the seven tools in one table, and a five-line `underwrite()` snippet), *Your x402 service as an Agent B* (`sealedAuditRoute` snippet, prefaced with "once there are As — the reference auditor is the only B today"), *Verify anywhere* (site URL `https://wayneal.github.io/0G/`, `verifySealA` snippet). Update "Verify a seal yourself" to point at the site and the `#seal=` share link. Add "Seal bodies live on 0G Storage" paragraph: what is published, how a reader finds it (Flow `Submit` tags → indexer gateway), the spike tx as the example. Mirror every change in `README.zh-TW.md` in the same register as the existing Chinese (spoken, not translated). Also a paragraph *The reference auditor runs on the author's machine* (why: keys stay with owners, nothing deployed; how: `demo/serve-b.sh`; what you see when it is off: the site pill and `AUDITOR_UNREACHABLE`). Verify: both READMEs mention each of the five package names and the seven tool names (`grep -c`), and "Try it in 60 seconds" appears before "Run it".
- [ ] 3. `NOTES.md` §G and `.env.example`. Commit: `docs: three surfaces — use-it section, pages workflow, NOTES §G`.

**Wayne-workflow rules for this task:** Docs state what is verified, at the evidence level it was verified (the spike tx is "verified end-to-end"; the site URL is "will be, once Pages is enabled" until the orchestrator confirms). The workflow file is written but Pages is **not** enabled and nothing is deployed by this task — that is the orchestrator's checkpoint. Do not touch `.env`.

---

### Task 7: npm publish preparation (build to `dist/`, `files`, `exports`) — publish itself is held

**Files:** Modify `packages/{seal,og,underwriter,storage,auditor,mcp}/package.json`, add `packages/*/tsconfig.build.json`, `packages/mcp/bin/acu-mcp.mjs` (switch to `dist/`), root `package.json` (`build` script already runs `pnpm -r build`)

**Interfaces:** none new. Each package gains `"build": "tsc -p tsconfig.build.json"` emitting ESM + `.d.ts` to `dist/`, `"files": ["dist", "README.md"]`, `"publishConfig": { "access": "public" }`, and `exports` that map to `dist/*.js` **under a `publishConfig.exports`** override so the workspace keeps resolving `src/*.ts` (pnpm applies `publishConfig` at pack time). `private: true` removed from the six publishable packages; `agent-a`, `agent-b`, `demo`, `web` stay private. `@acu/mcp` bin → `dist/index.js` with the shebang preserved.

**Steps:**
- [ ] 1. Add `tsconfig.build.json` per package (`extends` the package tsconfig, `noEmit: false`, `outDir: dist`, `rootDir: src`, `include: ["src"]`). Verify: `pnpm -r build` succeeds and `node -e "import('./packages/seal/dist/index.js').then(m=>console.log(Object.keys(m).length))"` prints a positive count.
- [ ] 2. `mkdir -p .claude/sdd/pack && pnpm -r --filter './packages/*' exec pnpm pack --pack-destination "$PWD/.claude/sdd/pack"` (gitignored) → six tarballs; `tar tzf` one and confirm `dist/index.js`, `dist/index.d.ts`, `package.json` present and no `src/`. Report the tarball sizes.
- [ ] 3. Commit: `chore: build + publishConfig for the six publishable packages (publish held)`.

**Wayne-workflow rules for this task:** `npm publish` is a checkpoint held by the orchestrator — never run it. Do not change how the workspace resolves packages (source-first stays).

---

### Task 8: Onboarding — the reference B from Wayne's machine behind a tunnel; CORS on `/agent`; the five-minute acceptance

**Files:** Create `demo/serve-b.sh`, `demo/set-directory-endpoint.mjs` · Modify `packages/auditor/src/route.ts` (CORS on `GET /agent`), `packages/auditor/test/route.test.ts` (or the existing route test) · Modify `web/public/directory.json` (endpoint rewritten by the script; committed value is whatever tunnel was last live, or `http://localhost:4021`)

**Interfaces:**
- `sealedAuditRoute` sets `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Methods: GET` on `GET /agent` **only**. `POST /audit` is untouched — the x402 handshake is server-to-server and the browser never calls it.
- `demo/set-directory-endpoint.mjs <origin>`: reads `web/public/directory.json`, sets `endpoint` on every `role: "auditor"` entry to `<origin>` (validated with `new URL`), writes it back with 2-space indent and a trailing newline, prints the diff of the one field. Exit 1 on an invalid URL or no auditor entry.
- `demo/serve-b.sh` (orchestrator-run; reads `.env`): requires `cloudflared` on PATH (prints `brew install cloudflared` and exits 1 otherwise); starts the reference B (`pnpm --filter @acu/agent-b start`) on `:4021`; runs `cloudflared tunnel --url http://localhost:4021`, parses the `https://*.trycloudflare.com` origin from its stderr, calls `set-directory-endpoint.mjs` with it, prints the origin and `GET <origin>/agent` once as a liveness proof, then waits on both children; `trap` on exit kills both and **restores** `directory.json` to `http://localhost:4021` so the committed file never points at a dead tunnel. Flag `--keep` skips the restore for the demo-day commit.

**Steps:**
- [ ] 1. RED: route test — `GET /agent` response has `access-control-allow-origin: *`; `POST /audit` response does not. Run → FAIL. GREEN in `route.ts`. `pnpm --filter @acu/auditor test` green.
- [ ] 2. `set-directory-endpoint.mjs` + `serve-b.sh`. Verification command (implementer, no `.env`): `node demo/set-directory-endpoint.mjs https://example.trycloudflare.com && grep -c example.trycloudflare.com web/public/directory.json && node demo/set-directory-endpoint.mjs http://localhost:4021 && git diff --quiet web/public/directory.json && echo restored`; `node demo/set-directory-endpoint.mjs not-a-url; echo "exit $?"` → `exit 1`. `bash -n demo/serve-b.sh`.
- [ ] 3. Commit: `feat: onboarding — reference B through a cloudflared tunnel, CORS on /agent, directory endpoint script`.
- [ ] 4. **Orchestrator acceptance (held, reads `.env`, moves testnet funds):** `./demo/serve-b.sh` → origin printed and `/agent` answers; on a clean shell with **no repo env** and a fresh burner key: `claude mcp add acu -e ACU_AGENT_KEY=0x… -e ACU_DIRECTORY_JSON="$(cat web/public/directory.json)" -- node $PWD/packages/mcp/bin/acu-mcp.mjs` (the `ACU_DIRECTORY_URL` default only works once Pages is live; `ACU_DIRECTORY_JSON` stands in), then in a fresh Claude Code session: `agent_status` → "Fund …" → faucet → `agent_status` → "Ready" → `underwrite` CleanUSD → seal A, `shareUrl` opens green, the feed shows the listing (reference A only lists; a non-reference key gets `listing: null, skipped.settle` — assert that too with a second burner). Record wall-clock from `claude mcp add` to the green page; target ≤ 5 min. Commit `directory.json` with the live tunnel only for the demo (`--keep`), and note in the README that the URL rotates.

**Wayne-workflow rules for this task:** Implementers never run `serve-b.sh`, never read `.env`, never open a tunnel. The tunnel and every funded call are the orchestrator's checkpoint. CORS is added to exactly one route; do not add a `cors` dependency for one header. `directory.json` must never be committed pointing at a tunnel that is not currently up unless the commit message says which demo it is for.
