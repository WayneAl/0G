#!/usr/bin/env node
// The workspace consumes every @acu package as TypeScript source, so the bin
// registers tsx before importing the entry point. Task 7 points this at a built
// dist/index.js for npm; nothing else about the CLI changes.
//
// `tsx/esm/api` rather than `node:module`'s register("tsx/esm"): tsx 4.23
// refuses the latter outright — it is the deprecated --loader path.
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/index.ts");
process.exit(await main(process.argv.slice(2)));
