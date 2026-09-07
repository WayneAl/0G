#!/usr/bin/env node
// The executable. `main` returns an exit code rather than calling `process.exit`,
// so this is the one place that turns it into one — the library entry stays
// importable and the tests keep driving `main` directly.
//
// Two paths reach this file and they run the same code: `npx @0x402/cli` runs the
// built `dist/bin.js` (which is what `publishConfig.bin` points at, so a
// published install needs no tsx), and `node packages/cli/bin/acu.mjs` in this
// repo registers tsx and imports this module from source.
import { main } from "./index.js";

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  // Everything a user can act on is already a printed refusal with a code. What
  // reaches here is a broken environment, and the stack is the useful part.
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
}
