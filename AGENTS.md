# AGENTS.md

For an AI agent working **in** this repository. Humans want [`README.md`](README.md); an agent
that wants to *use* the service rather than change it wants the last section here.

## What this is

Agent A (underwriter) pays Agent B (code auditor) over **x402** to review an ERC-20. B runs
the inference on the **0G Compute Router** inside a TEE and returns a signed **seal B**. A
verifies that seal against seven checks, then signs **seal A** with seal B embedded whole, and
`CollateralRegistry` on 0G testnet lists the token only against seal A.

The one sentence to keep in your head: **money on Base, proof on 0G, and every hop is
verifiable by a third party who trusts neither agent.**

## Orientation — read in this order

| Order | File | Why |
|---|---|---|
| 1 | [`packages/seal/src/schema.ts`](packages/seal/src/schema.ts) | the two seal shapes. Everything else serves these |
| 2 | [`packages/seal/src/verify.ts`](packages/seal/src/verify.ts) | the seven checks and their refusal codes |
| 3 | [`packages/underwriter/src/underwrite.ts`](packages/underwriter/src/underwrite.ts) | `underwrite()` — the whole A-side flow in one function |
| 4 | [`packages/auditor/src/route.ts`](packages/auditor/src/route.ts) | the whole B side: `GET /agent` free, `POST /audit` x402-gated |
| 5 | [`contracts/src/CollateralRegistry.sol`](contracts/src/CollateralRegistry.sol) | what the chain enforces, which is less than you think |

[`NOTES.md`](NOTES.md) is the evidence log — every claim about an external API in this repo
was checked against a live endpoint and written down there with the date. Read §A before you
"fix" anything that looks wrong about x402 versions or 0G model names; it is probably
deliberate and the reason is recorded.

## Commands

```bash
pnpm install                       # Node 22, pnpm pinned by packageManager
pnpm -r typecheck                  # tsc across the workspace
pnpm -r test                       # 266 vitest tests across nine packages
forge test --root contracts        # 20 Foundry tests

./demo/run.sh --offline            # the seven scenes from recordings, no network, no key
./demo/run.sh                      # dry run: the real x402 handshake, no money moves
./demo/run.sh --live               # real payments, real listings
```

`--offline` is the one to reach for: no key, no funds, no network, and it still re-verifies
the recorded seals for real — only what crossed a wire is replayed. It does need a `.env`
(copy `.env.example` and fill in `REGISTRY_ADDRESS`, `CLEAN_USD` and `TRAP_USD` from the
deployed-addresses table in the README; nothing else is read in this mode). Scenes ②, ③ and ④
have no recording — they print `no recording yet` and that is not a failure. If your change
breaks something, ①, ⑤ or ⑥ is usually where it shows up first.

CI runs `pnpm -r typecheck`, `pnpm -r test` and `forge test` on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Neither half needs a secret; a test
that needs one is a test a stranger cannot reproduce, so do not write one.

## Invariants — do not break these to make something pass

1. **The five core packages never read `process.env`.** `seal`, `og`, `underwriter`,
   `auditor` and `storage` take their configuration as arguments. Only `packages/config`,
   `packages/cli`, `packages/mcp`, `agent-a/` and `agent-b/` resolve environment. A
   misconfigured Agent B must fail at construction, not at its first paying customer.
2. **`underwrite()` has no console and no `process.exit`.** The CLI and the MCP server are
   printers over it. If you need to say something, return it.
3. **No seal, no charge.** If the inference fails, the attestation does not come back, or the
   seal cannot be signed, `POST /audit` answers **502 `AUDIT_FAILED`** and issues nothing.
4. **Never pay for a refusal, and never drop a seal that was paid for.** A refusal after the
   `compose` stage carries `sealA` back in the result — the money is spent and the seal is
   what it bought.
5. **Dry run is the default.** Real money needs `--live`. The budget gate runs *before* the
   x402 signature, because an x402 authorization costs no gas and raises no wallet prompt.
6. **Agent A and Agent B are different keys.** Same key, and the seal chain proves nothing.
   Every key in this repo is a burner; there is no key here worth stealing and there must
   never be one.
7. **The TypeScript and Solidity encoders must agree.** `contracts/test/CrossLanguage.t.sol`
   decodes a fixture that `packages/seal` signed and asserts it field by field. Touch the
   canonical encoding and that test is the one that catches you.
8. **Only `verified`-tier seals get embedded.** An honest `standard` seal is a valid seal; it
   is just not one Agent A will act on. Without that rule "B used 0G" is a preference rather
   than something enforced.
9. **The token's own strings are hostile input.** `name`, `symbol`, comments and source are
   written by whoever deployed the token. Three layers hold that boundary — system prompt,
   a fenced artifact the model is told to distrust, and a strict output schema — and all
   three stay.
10. **Never commit `.env`, `.npmrc`, or a private key.** They are gitignored; keep it that way.

## Conventions

- **Smallest diff that does the job.** No "while I'm here" cleanup, no reformatting a file
  you touched one line of.
- **Commit subjects** are `type: a lowercase phrase that says what changed and why`, in the
  repo's own voice — look at `git log` before writing one. `feat:`, `fix:`, `docs:`,
  `chore:`, `test:`, `refactor:`.
- **`README.md` and `README.zh-TW.md` are one document in two languages.** Change one and you
  change the other, in the same register — the Chinese is spoken, not translated.
- **Comments explain the decision, not the syntax.** The ones in this repo say why something
  is done the awkward way; if you cannot write that sentence, you may not need the comment.
- **Raw `fetch` over the OpenAI SDK, on purpose.** The attestation evidence — `verify_tee` as
  a top-level request field, the chatId in a response header — is exactly what a high-level
  SDK hides.
- **x402 v2 (`@x402/*`), never v1 (`x402-express` / `x402-fetch`).** Most tutorials online are
  the deprecated v1 line. `NOTES.md` §A1.

## Verifying a change

`pnpm -r test && forge test --root contracts && ./demo/run.sh --offline` is the full loop that
needs nothing but a checkout. If you changed the seal schema, encoding or verification, say so
explicitly in your report — it is the one part of this repo where a green test suite can still
mean a broken chain, because the fixtures were generated by the same code you changed.

Do not claim a live behaviour you did not observe. Anything touching the 0G Router, 0G Storage
or a facilitator needs a real run to be asserted, and the results of those runs belong in
`NOTES.md` with the date.

## If you are an agent that wants to *use* this

You do not need this repository. The reference Agent A ships as an MCP server:

```bash
claude mcp add acu -- npx -y @0x402/mcp
```

No `-e` flags and no environment: it reads `~/.acu/config.json`, which `npx @0x402/cli init`
writes. With no key at all it still starts, and every paid tool stops at the quote.

Call **`agent_status` first** — it answers whether you can underwrite right now and what the
single next step is. Then `quote_audit` (free, never signs), `hire_audit` (pays, returns a
*verified* seal B or the check that failed), `underwrite` (the whole flow), `verify_seal`,
`get_listing`, `describe_auditor`.

Every refusal is a named code, not prose: `AUDITOR_UNREACHABLE`, `BUDGET_REFUSED`,
`DELEGATE_SEAL_INVALID`, `SCHEMA_INVALID`, `AGENT_ID_NOT_LIVE`, `SIGNATURE_INVALID`,
`SIGNER_MISMATCH`, `SUBJECT_MISMATCH`, `REQUEST_MISMATCH`, `SEAL_EXPIRED`,
`ATTESTATION_MISSING`, `UNTRUSTED_SIGNER`. Branch on the code; do not parse the message.

Two things worth knowing before you spend anything: the reference auditor is **not hosted**,
so `AUDITOR_UNREACHABLE` is a normal answer and the right response is to try later or run your
own Agent B ([`sealedAuditRoute`](packages/auditor/src/route.ts)). And a seal proves *who
judged what, on which evidence* — it does not prove the judgement was right. A perfectly
signed hallucination is still a hallucination. Read *Known limitations* in the README before
you treat a seal as an audit.
