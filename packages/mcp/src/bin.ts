#!/usr/bin/env node
// The executable. `./index.js` *is* the server — importing it starts one — so
// this file exists for the shebang and nothing else, and it is what
// `publishConfig.bin` points at once compiled to `dist/bin.js`, so a published
// install needs no tsx. In this repo `bin/acu-mcp.mjs` registers tsx and imports
// the same module from source.
import "./index.js";
