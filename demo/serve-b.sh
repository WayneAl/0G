#!/usr/bin/env bash
#
# Put the reference agent B on the public internet from this laptop, so a
# stranger's Claude Code can hire it with nothing but the directory the website
# ships.
#
#   ./demo/serve-b.sh          serve until Ctrl-C, then restore directory.json
#   ./demo/serve-b.sh --keep   leave the tunnel origin in directory.json (demo day)
#
# This is for putting *this checkout* in front of a stranger — the deployed
# reference B is on Cloud Run (agent-b/Dockerfile) and directory.json names it. Here
# cloudflared runs a quick tunnel that terminates at localhost:4021, so the code
# being hired is the code in this working tree. The subdomain rotates on every
# launch, which is why the origin is parsed out of cloudflared's banner and
# written into web/public/directory.json each run rather than committed.
#
# On exit the file is restored from git, putting the deployed endpoint back — never
# to a hardcoded localhost, which would take the public auditor offline on the
# next Pages deploy. --keep skips the restore for the one commit a demo needs.
#
# The reference B needs AGENT_B_PRIVATE_KEY and TESTNET_API_KEY. It loads the
# repo's .env itself (agent-b/src/server.ts); this script never reads or prints
# anything from it.
#
# Run it in the foreground and stop it with Ctrl-C. Started in the background
# instead (`./demo/serve-b.sh &`), SIGINT arrives already ignored and POSIX says a
# signal ignored on entry cannot be trapped — so Ctrl-C's trap never runs there.
# `kill <pid>` (SIGTERM) works either way and is what to use on a backgrounded run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=4021
KEEP=""
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v cloudflared >/dev/null 2>&1 || {
  echo "serve-b.sh: cloudflared is not on PATH" >&2
  echo "  brew install cloudflared" >&2
  exit 1
}

[ -f "$ROOT/.env" ] || {
  echo "serve-b.sh: no .env at $ROOT/.env" >&2
  echo "  agent B reads AGENT_B_PRIVATE_KEY and TESTNET_API_KEY from it" >&2
  exit 1
}

if lsof -ti:$PORT >/dev/null 2>&1; then
  echo "serve-b.sh: port $PORT is already in use" >&2
  echo "  kill \$(lsof -ti:$PORT)" >&2
  exit 1
fi

LOGS="$(mktemp -d -t acu-serve-b)"
B_LOG="$LOGS/agent-b.log"
T_LOG="$LOGS/cloudflared.log"
B_PID=""
T_PID=""

# SIGTERM, then wait, then insist. cloudflared answers SIGTERM with a graceful
# shutdown that can outlive this script — and a tunnel still up after "restored"
# is a public endpoint nobody is watching any more.
stop() {
  [ -n "$1" ] || return 0
  kill "$1" 2>/dev/null || return 0
  for _ in $(seq 1 10); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.3
  done
  kill -9 "$1" 2>/dev/null
}

cleanup() {
  stop "$T_PID"
  stop "$B_PID"
  # Killing the pnpm wrapper leaves the tsx child holding the port; take the port.
  lsof -ti:$PORT 2>/dev/null | xargs kill -9 2>/dev/null
  echo
  if [ -n "$KEEP" ]; then
    echo "  --keep: directory.json still names the tunnel, which is now down."
    echo "          commit it only for a demo, and put it back with:"
    echo "          git checkout -- web/public/directory.json"
  elif git -C "$ROOT" checkout -- web/public/directory.json 2>/dev/null; then
    echo "  directory.json restored to the committed endpoint"
  else
    echo "  !! could not restore web/public/directory.json from git." >&2
    echo "     It still names a tunnel that is down — fix it before deploying the site." >&2
  fi
  echo "  logs: $LOGS"
}
trap cleanup EXIT
# Exit on the signal so the EXIT trap runs exactly once.
trap 'exit 130' INT TERM

echo "── reference agent B ──"
pnpm --silent --filter @0x402/agent-b start >"$B_LOG" 2>&1 &
B_PID=$!

B_UP=""
for _ in $(seq 1 60); do
  if curl -sf -m 2 "http://localhost:$PORT/agent" >/dev/null 2>&1; then B_UP=1; break; fi
  sleep 0.5
done
[ -n "$B_UP" ] || {
  echo "serve-b.sh: agent B did not answer on :$PORT within 30s" >&2
  tail -20 "$B_LOG" >&2
  exit 1
}
echo "  up on :$PORT"

echo "── cloudflared quick tunnel ──"
cloudflared tunnel --url "http://localhost:$PORT" >"$T_LOG" 2>&1 &
T_PID=$!

# The public origin lands on stderr in a boxed banner about 4 s in, *before* the
# connectivity-precheck summary — so wait on the URL itself, never on a "healthy"
# line. Bounded: every 0.5 s for at most 60 s.
ORIGIN=""
for _ in $(seq 1 120); do
  ORIGIN="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$T_LOG" 2>/dev/null | head -1)"
  [ -n "$ORIGIN" ] && break
  sleep 0.5
done
[ -n "$ORIGIN" ] || {
  echo "serve-b.sh: cloudflared printed no trycloudflare.com origin within 60s" >&2
  tail -20 "$T_LOG" >&2
  exit 1
}

node "$ROOT/demo/set-directory-endpoint.mjs" "$ORIGIN" || exit 1

echo
echo "  origin  $ORIGIN"
echo "  card    $ORIGIN/agent"
echo

# The edge takes a while to route a fresh quick tunnel — cloudflared's own banner
# says "it may take some time to be reachable". Measured here on a machine whose
# first resolver was timing out: cloudflared logged "Registered tunnel connection"
# 2 m 45 s after launch, and the origin answered only after that. Try for 180 s,
# then print the response once. Headers included: the website's pill lives or dies
# on access-control-allow-origin surviving the hop.
CARD=""
CARD_OK=""
for _ in $(seq 1 180); do
  if CARD="$(curl -sS -i -m 10 --fail "$ORIGIN/agent" 2>&1)"; then CARD_OK=1; break; fi
  sleep 1
done
if [ -n "$CARD_OK" ]; then
  echo "$CARD" | sed 's/^/  /'
else
  # Loud, but not fatal. The probe is a proof, not the job: killing a tunnel that
  # is merely slow to propagate would cost a working demo and a new subdomain.
  echo "  ⚠ $ORIGIN/agent has not answered 200 yet (180s)." >&2
  echo "    Registration can take minutes if DNS is slow; it is still serving." >&2
  echo "    Last attempt said:" >&2
  echo "$CARD" | sed 's/^/      /' >&2
  echo "    Check again with: curl -i $ORIGIN/agent" >&2
fi

echo
echo "  web/public/directory.json now points at the tunnel."
echo "  Ctrl-C to stop; the committed (deployed) endpoint goes back on the way out."

wait "$B_PID" "$T_PID"
