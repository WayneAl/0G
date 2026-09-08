#!/usr/bin/env node
// The *workspace* bin. The repo consumes every @0x402 package as TypeScript
// source, so this registers tsx and then hands straight over to `src/bin.ts` —
// the same module the published `dist/bin.js` is compiled from, so the README's
// `node packages/cli/bin/acu.mjs` and `npx @0x402/cli` cannot drift apart.
//
// This file is not published: `files` ships `dist` only, and `publishConfig.bin`
// points `acu` at `./dist/bin.js`, so an installed @0x402/cli never needs tsx.
//
// `tsx/esm/api` rather than `node:module`'s register("tsx/esm"): tsx 4.23
// refuses the latter outright — it is the deprecated --loader path.
import { register } from "tsx/esm/api";
register();
await import("../src/bin.ts");
