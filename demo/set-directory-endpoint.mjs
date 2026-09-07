#!/usr/bin/env node
// Point the website's directory at wherever the reference agent B is answering
// right now.
//
//   node demo/set-directory-endpoint.mjs https://four-quiet-words.trycloudflare.com
//   node demo/set-directory-endpoint.mjs http://localhost:4021
//
// B is served from a laptop through a cloudflared quick tunnel, and the
// quick-tunnel subdomain rotates on every launch — so the origin can never be
// committed. `demo/serve-b.sh` parses it out of cloudflared's banner, calls this
// script to write it into `web/public/directory.json`, and calls it again on the
// way out to put `http://localhost:4021` back, so the file in git never points at
// a tunnel that is down.
//
// Refusals carry a code and exit 1: BAD_ORIGIN (missing, unparseable, or not
// http(s)), BAD_DIRECTORY (unreadable or not JSON), NO_AUDITOR (nothing in the
// directory to point anywhere).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../web/public/directory.json");

function refuse(code, detail) {
  console.error(`${code}: ${detail}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) refuse("BAD_ORIGIN", "usage: node demo/set-directory-endpoint.mjs <origin>");

let parsed;
try {
  parsed = new URL(arg);
} catch (err) {
  refuse("BAD_ORIGIN", `${arg} is not a URL (${err.message}) — pass a full origin, scheme and all`);
}
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
  refuse("BAD_ORIGIN", `${arg} is not http(s) — agent A fetches <origin>/agent over HTTP`);
}
// Consumers join this with "/agent", so a trailing slash would give them "//agent".
const endpoint = arg.replace(/\/+$/, "");

let directory;
try {
  directory = JSON.parse(readFileSync(DIRECTORY, "utf8"));
} catch (err) {
  refuse("BAD_DIRECTORY", `${DIRECTORY}: ${err.message}`);
}

const auditors = (directory.agents ?? []).filter((agent) => agent.role === "auditor");
if (auditors.length === 0) {
  refuse("NO_AUDITOR", `${DIRECTORY} has no entry with role "auditor"`);
}

for (const auditor of auditors) {
  const before = auditor.endpoint ?? "(none)";
  auditor.endpoint = endpoint;
  console.log(`agent ${auditor.agentId} (auditor) endpoint`);
  if (before === endpoint) {
    console.log(`  = ${endpoint}  (unchanged)`);
  } else {
    console.log(`  - ${before}`);
    console.log(`  + ${endpoint}`);
  }
}

// 2-space indent and a trailing newline: the shape the file is committed in, so
// the restore on the way out leaves `git diff` empty.
writeFileSync(DIRECTORY, `${JSON.stringify(directory, null, 2)}\n`);
