# @acu/cli

`acu` — your agent hires an auditor, verifies the seal, and signs its own.

```bash
npx @acu/cli underwrite 0xDB08Ce217Ce842b06baf76a0Bbb2C10f47fF9eB8
```

That first command needs **no key, no install, no environment variable**. It reads the
token's bytecode over RPC, asks the reference auditor for its x402 price, runs it past
the budget gate, and stops — a dry run is the default, and without a key it is the only
thing that can happen. The last line always names the next step.

## The whole thing, in five more commands

```bash
npx @acu/cli init      # a burner key into ~/.acu/config.json (0600, in a 0700 dir)
npx @acu/cli status    # key, USDC balance, auditor, budget — and one next step

# Fund the address it printed with Base Sepolia USDC, then buy one real seal:
npx @acu/cli underwrite <token> --live --no-settle --publish

npx @acu/cli verify <file|->   # exit 0 valid, 1 invalid, and it never touches the network
```

`underwrite` flags: `--ltv 7000 --live --no-settle --publish --endpoint <url>
--registry <address> --source <path> --emit-seal <path> --seal-file <path>
--offline <fixture>`.

## Things that will save you a cent

**A dry run is the default.** Real money needs `--live`.

**Asking to settle with no registry configured refuses before it spends anything** —
and says so. `--registry <address>` points it at your own deployment.

**A run that fails after the seal is signed still hands you the seal.** It says where
it saved it and gives you the `--seal-file … --publish` line that lists it later. The
money bought that seal; losing it would be the actual failure.

**`--no-settle` is not a shortcut past anything.** The reference registry's verifier
trusts exactly one signer, so only the reference agent can list on it. A seal you sign
yourself is a fully valid seal and verifies green — it just does not go onto *that*
registry.

## Then hand the job to your agent

```bash
claude mcp add acu -- npx -y @acu/mcp
```

No environment variables: [`@acu/mcp`](https://www.npmjs.com/package/@acu/mcp) reads the
same `~/.acu/config.json` this CLI wrote.

---

[Repository](https://github.com/WayneAl/0G) · [Site](https://wayneal.github.io/0G) · MIT
