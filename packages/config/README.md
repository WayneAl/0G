# @0x402/config

`~/.acu/config.json` — the one place a key and its settings are read from, for every
shell.

```bash
npm i @0x402/config
```

```ts
import { readUserConfig, writeUserConfig, configPath, resolve } from "@0x402/config";

const user = readUserConfig();
const auditorUrl = resolve(process.env.ACU_AUDITOR_URL, user.auditorUrl, DEFAULT);
```

**Precedence is env > file > built-in default**, everywhere, through `resolve`. An
operator can always override the file for one process without editing it, and an empty
environment variable counts as unset rather than as an empty string.

This is what makes `claude mcp add acu -- npx -y @0x402/mcp` need no environment
variables: [`@0x402/cli`](https://www.npmjs.com/package/@0x402/cli)'s `init` writes the key,
and the MCP server reads the same file. MCP configuration is fixed at install time, so
a key that arrived later used to mean removing and re-adding the server.

## Two properties it holds on to

**The file holds a private key**, so it is written `0600` inside a `0700` directory,
and written atomically via tmp + rename — a half-written config would be a lost key.
Writes *merge*, so one command adding an auditor URL cannot erase another's key, and
fields this version has never heard of are carried through untouched.

**Absence is not a failure; corruption is.** No file means "you have not run `init`
yet" and every field comes back null. A file that exists and will not parse throws,
because reading a damaged config as "no key" would send someone to generate a second
key over the top of a funded one.

Depends on node builtins and nothing else, so importing it can never drag a parser or
a network client into a shell that only wanted to know its key.

---

[Repository](https://github.com/WayneAl/0G) · [Site](https://wayneal.github.io/0G) · MIT
