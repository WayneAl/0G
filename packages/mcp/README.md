# @0x402/mcp

An MCP server that lets your own agent hire an auditor, verify a seal, and sign its own.

```bash
claude mcp add acu -- npx -y @0x402/mcp
```

**No environment variables.** It reads the same `~/.acu/config.json` that
[`@0x402/cli`](https://www.npmjs.com/package/@0x402/cli)'s `init` wrote, so a key that
arrives after the install just works — no removing and re-adding the server. Running
with no key at all is a supported state: every paid tool stops at the quote and says
what to do next.

## Seven tools

| Tool | What it does |
|---|---|
| `agent_status` | Key, USDC balance, auditor, budget — and the one next step. |
| `describe_auditor` | The free agent card: who you would be hiring, and for how much. |
| `quote_audit` | What an audit of this token would cost. Spends nothing. |
| `hire_audit` | Pay over x402, get seal B back, verify it against all eight checks. |
| `verify_seal` | Check any seal locally. Never touches the network. |
| `underwrite` | Hire → verify → sign seal A → publish → list, refusing with a named code. |
| `get_listing` | What the registry says, what the stored seal says, and whether they agree. |

A refusal is an answer, not a tool error: `quote_audit` against an auditor that is not
running comes back as `AUDITOR_UNREACHABLE` with the stage that failed, so the agent
can act on it instead of retrying blind.

## Guardrails that are on by default

**A budget gate** with per-session and per-hour caps and a payee allowlist, checked
before any signature — an agent that has been talked into something expensive stops at
the ledger.

**Nothing is signed before the seal it wraps is verified.** All eight checks run first,
and a seal that fails one is never composed into anything.

**No key is ever printed.** A malformed key is rejected by how long it was and where it
came from, never by quoting it back.

---

[Repository](https://github.com/WayneAl/0G) · [Site](https://wayneal.github.io/0G) · MIT
