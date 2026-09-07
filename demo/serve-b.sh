#!/usr/bin/env bash
#
# Put the reference agent B on the public internet from this laptop, so a
# stranger's Claude Code can hire it with nothing but the directory the website
# ships.
#
#   ./demo/serve-b.sh          serve until Ctrl-C, then restore directory.json
#   ./demo/serve-b.sh --keep   leave the tunnel origin in directory.json (demo day)
#
# Nothing is deployed: cloudflared runs a quick tunnel that terminates at
# localhost:4021 here. Its subdomain rotates on every launch, which is why the
# origin is parsed out of cloudflared's banner and written into
# web/public/directory.json each run rather than committed. On exit the endpoint
# goes back to http://localhost:4021 so the committed file never points at a
# tunnel that is down; --keep skips that for the one commit a demo needs.
#
# The reference B needs AGENT_B_PRIVATE_KEY and TESTNET_API_KEY. It loads the
# repo's .env itself (agent-b/src/server.ts); this script never reads or prints
# anything from it.
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

cleanup() {
  [ -n "$T_PID" ] && kill "$T_PID" 2>/dev/null
  [ -n "$B_PID" ] && kill "$B_PID" 2>/dev/null
  # Killing the pnpm wrapper leaves the tsx child holding the port; take the port.
  lsof -ti:$PORT 2>/dev/null | xargs kill -9 2>/dev/null
  echo
  if [ -n "$KEEP" ]; then
    echo "  --keep: directory.json still names the tunnel, which is now down."
    echo "          commit it only for a demo, and put it back with:"
    echo "          node demo/set-directory-endpoint.mjs http://localhost:$PORT"
  else
    node "$ROOT/demo/set-directory-endpoint.mjs" "http://localhost:$PORT" >/dev/null
    echo "  directory.json restored to http://localhost:$PORT"
  fi
  echo "  logs: $LOGS"
}
trap cleanup EXIT
# Exit on the signal so the EXIT trap runs exactly once.
trap 'exit 130' INT TERM

echo "── reference agent B ──"
pnpm --silent --filter @acu/agent-b start >"$B_LOG" 2>&1 &
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

# The edge takes a moment to route a fresh quick tunnel; try for 20 s, then print
# the response once. Headers included: the website's pill lives or dies on
# access-control-allow-origin surviving the hop.
CARD=""
CARD_OK=""
for _ in $(seq 1 20); do
  if CARD="$(curl -sS -i -m 10 --fail "$ORIGIN/agent" 2>&1)"; then CARD_OK=1; break; fi
  sleep 1
done
[ -n "$CARD_OK" ] || {
  echo "serve-b.sh: $ORIGIN/agent did not answer 200 within 20s" >&2
  echo "$CARD" >&2
  tail -20 "$T_LOG" >&2
  exit 1
}
echo "$CARD" | sed 's/^/  /'

echo
echo "  web/public/directory.json now points at the tunnel."
echo "  Ctrl-C to stop; the endpoint goes back to http://localhost:$PORT on the way out."

wait "$B_PID" "$T_PID"
