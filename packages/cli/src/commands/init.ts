import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { configPath, readUserConfig, writeUserConfig } from "@0x402/config";
import { CIRCLE_FAUCET } from "@0x402/underwriter";
import type { Io } from "../index.js";

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

/** Printed on every run, successful or not. It is the one thing that must land. */
const BURNER_WARNING = "this is a burner key for testnet — never fund it with real money";

/**
 * `acu init` — step 2 of the funnel, and the reason `@0x402/config` exists.
 *
 * A key generated here is read by every other shell, including the MCP, which is
 * why the MCP install line needs no environment variables at all.
 *
 * It refuses to overwrite an existing key without `--force`. The key it would
 * replace may be funded, and a funded burner key lost to a careless second `acu
 * init` is the failure this whole command is shaped around. The private key is
 * never printed: the address is what a user needs to paste into a faucet.
 */
export function init(argv: string[], io: Io): number {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const force = argv.includes("--force");
  const supplied = flag("key");

  // Read only when the answer can change anything. `--force` exists for the
  // case where the file is unreadable, so it must not begin by reading it.
  const existing = force ? null : readUserConfig(io.env);
  if (existing !== null && existing.agentKey !== null) {
    const address = addressOf(existing.agentKey, io);
    io.out(`A key is already configured: ${address ?? "(unreadable — the file holds something that is not a key)"}`);
    io.out(`  ${configPath(io.env)}`);
    io.out("");
    io.out("Refusing to overwrite it. That key may be funded.");
    io.out("Pass --force if you really mean to replace it.");
    io.out("");
    io.out(BURNER_WARNING);
    return 1;
  }

  let key: `0x${string}`;
  if (supplied === undefined) {
    key = generatePrivateKey();
  } else if (HEX_KEY.test(supplied)) {
    key = supplied.toLowerCase() as `0x${string}`;
  } else {
    io.out("BAD_KEY");
    io.out("  --key takes a 0x-prefixed 32-byte private key");
    io.out("");
    io.out(BURNER_WARNING);
    return 1;
  }

  const account = privateKeyToAccount(key);
  // The address doubles as the agent id: nobody has minted an Agentic ID yet
  // (ERC-7857 is [ONSITE]), and claiming the reference agent's "1" would make
  // this agent's seals read as forgeries of someone else's.
  writeUserConfig({ agentKey: key, agentId: account.address.toLowerCase() }, io.env, {
    replaceUnreadable: force,
  });

  io.out(`agent address  ${account.address}`);
  io.out(`config         ${configPath(io.env)}  (0600)`);
  io.out(`faucet         ${CIRCLE_FAUCET}  (choose Base Sepolia, paste the address)`);
  io.out("");
  io.out(BURNER_WARNING);
  io.out("");
  io.out("Next: acu status");
  return 0;
}

function addressOf(key: string, _io: Io): `0x${string}` | null {
  try {
    return privateKeyToAccount(key as `0x${string}`).address;
  } catch {
    // A file holding something that is not a key still must not be overwritten
    // silently, so this reports rather than throwing the refusal away.
    return null;
  }
}
