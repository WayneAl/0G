# @acu/underwriter

The Agent A side, as a library: hire an auditor over x402, verify what it signed, and
sign your own seal around it.

```bash
npm i @acu/underwriter
```

```ts
import { underwrite } from "@acu/underwriter";

const result = await underwrite(
  { token, ltvBps: 7000, source: null, settle: true, publish: true },
  {
    account,                            // your key. Nothing else can sign.
    agentId: "1",
    auditor: { url, agentId: "2" },
    resolver,                           // AgentIdResolver: the directory
    budget,                             // gate, before any signature
    network: "eip155:84532",
    dryRun: false,
    registry,
    rpcUrl,
    onStep: (e) => console.log(e.stage, e.message),
  },
);

// ok:  { ok: true,  kind: "sealed", sealA, sealHash, hire, storage, listing, skipped }
// no:  { ok: false, stage, code, detail, sealA? }
```

Every stage is a named refusal rather than an exception, so a dead auditor is told
apart from a dead RPC by reading the result. `dryRun: true` — the default path when
there is no key — stops at the quote and spends nothing.

## Two rules worth knowing

**Nothing is signed before the seal B is verified.** Agent A runs all eight checks
itself; "nobody is watching" is the case this is built for.

**A refusal after the seal exists still hands it back.** Once the auditor is paid the
seal is what the money bought, so a settlement that fails afterwards returns `sealA`
and `sealHash` on the refusal instead of dropping them. Preconditions that cost
nothing to check — a missing registry, say — are checked before anything is spent.

Also exported: `makeBudgetGate` (per-session and per-hour caps with an on-disk
ledger, plus a payee allowlist), `agentStatus` / `usdcBalance` / `fundingHint`, and
`listWithSeal` / `mapListError` for the registry hop.

---

[Repository](https://github.com/WayneAl/0G) · [Site](https://wayneal.github.io/0G) · MIT
