#!/usr/bin/env node
// The *workspace* bin. The repo consumes every @acu package as TypeScript
// source, so this registers tsx and then hands straight over to `src/bin.ts` —
// the same module the published `dist/bin.js` is compiled from, so the README's
// `node <repo>/packages/mcp/bin/acu-mcp.mjs` and `npx -y @acu/mcp` cannot drift
// apart.
//
// This file is not published: `files` ships `dist` only, and `publishConfig.bin`
// points `acu-mcp` at `./dist/bin.js`, so an installed @acu/mcp never needs tsx.
//
// `tsx/esm/api` rather than `node:module`'s register("tsx/esm"): tsx 4.23 refuses
// the latter outright — it is the deprecated --loader path — and the process
// dies before the server ever reads stdin.
import { register } from "tsx/esm/api";
register();
await import("../src/bin.ts");
