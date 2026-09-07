import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { quote } from "./commands/quote.js";
import { verify } from "./commands/verify.js";
import { main as underwriteCommand } from "./commands/underwrite.js";

/**
 * `acu` — the headline shell.
 *
 * The reference Agent A was always a printer over `@acu/underwriter`; what kept
 * it in the repo was `private: true` and a hard-coded `.env`. This is the same
 * printer with the key it reads moved into `~/.acu/config.json`, so one `acu
 * init` serves the CLI, the MCP and anything else that grows later.
 *
 * `main` returns the exit code rather than calling `process.exit`, so the bin,
 * the `agent-a` example and the tests all drive the same function; and it writes
 * through an injected `out`, so a test can read what a user would see without
 * reaching for the global console.
 */
export interface Io {
  out: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

const defaultIo = (): Io => ({ out: (line: string) => console.log(line), env: process.env });

const HELP = `acu — your agent hires an auditor, verifies the seal, and signs its own.

usage: acu <command> [options]

  init                    generate a burner key into ~/.acu/config.json
  status [--json]         key, USDC balance, auditor, budget, and the one next step
  quote <token>           what an audit of this token would cost — no key needed
  underwrite <token>      hire, verify, seal, publish and list (add --live to pay)
  verify <file|->         check a seal A or B locally; exit 0 valid, 1 invalid

  acu underwrite flags: --ltv 7000 --live --no-settle --publish --endpoint <url>
                        --registry <address> --source <path> --emit-seal <path>
                        --seal-file <path> --offline <fixture>

Config resolves env > ~/.acu/config.json > default. Overrides: ACU_AGENT_KEY,
ACU_AUDITOR_URL, ACU_DIRECTORY_URL, ACU_REGISTRY, ACU_LEDGER_PATH, ACU_HOME.`;

export async function main(argv: string[], overrides: Partial<Io> = {}): Promise<number> {
  const io: Io = { ...defaultIo(), ...overrides };
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(HELP);
    return 0;
  }

  switch (command) {
    case "init":
      return init(rest, io);
    case "status":
      return status(rest, io);
    case "quote":
      return quote(rest, io);
    case "verify":
      return verify(rest, io);
    case "underwrite":
      // The moved printer owns its own output contract, byte for byte: the
      // `[N] ` step lines and the single verdict line `demo/run.sh` asserts on.
      return underwriteCommand(rest, io.env);
    default:
      io.out(`unknown command: ${command}\n`);
      io.out(HELP);
      return 2;
  }
}
