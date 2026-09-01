#!/usr/bin/env bash
#
# The six scenes. Each prints one line of verdict.
#
#   ./demo/run.sh              dry run: the x402 handshake, no money moves
#   ./demo/run.sh --live       real payments on Base Sepolia, real listings on 0G
#   ./demo/run.sh --live 6 5 1 just those scenes, in that order (the stage order)
#
# Every scene asserts the outcome it expects, so a green run means the failures
# failed for the right reason -- not that they merely failed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LIVE=""
SCENES=()
for arg in "$@"; do
  case "$arg" in
    --live) LIVE="--live" ;;
    [1-6]) SCENES+=("$arg") ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ ${#SCENES[@]} -eq 0 ] && SCENES=(1 2 3 4 5 6)

# shellcheck disable=SC1091
set -a; . ./.env; set +a

: "${REGISTRY_ADDRESS:?run contracts/script/Deploy.s.sol first and put the addresses in .env}"
: "${CLEAN_USD:?missing CLEAN_USD in .env}"
: "${TRAP_USD:?missing TRAP_USD in .env}"

SRC="$ROOT/contracts/src/mocks"
WORK="$(mktemp -d)"
SEAL="$WORK/sealA-clean.json"
PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  for port in 4021 4022 4099; do lsof -ti:$port 2>/dev/null | xargs kill -9 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_for() { # port, name
  for _ in $(seq 1 40); do
    curl -sf -m 2 "http://localhost:$1/agent" >/dev/null 2>&1 && return 0
    nc -z localhost "$1" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "  !! $2 did not come up on :$1" >&2; return 1
}

agent_a() { pnpm --silent --filter @acu/agent-a start -- "$@" 2>&1; }

# Asserts the run's final line. $1 = expected marker, rest = the CLI args.
expect() {
  local want="$1"; shift
  local out; out="$(agent_a "$@")"
  local got; got="$(echo "$out" | grep -oE '^[✓✗] [A-Z_]+' | tail -1)"
  echo "$out" | grep -E '^\[[0-9R]\] ' | sed 's/^/     /'
  if [ "$got" = "$want" ]; then
    echo "     => $got  ✅ as expected"
    return 0
  fi
  echo "     => ${got:-<no verdict>}  ❌ expected $want"
  echo "$out" | tail -5 | sed 's/^/     | /'
  return 1
}

echo "════════════════════════════════════════════════════════════════"
echo " Attested Collateral Underwriter — six scenes"
echo " mode: ${LIVE:-dry run (no payment)}"
echo " registry: $REGISTRY_ADDRESS on 0G testnet (16602)"
echo "════════════════════════════════════════════════════════════════"

echo; echo "── starting agents ──"
lsof -ti:4021 2>/dev/null | xargs kill -9 2>/dev/null
lsof -ti:4022 2>/dev/null | xargs kill -9 2>/dev/null
lsof -ti:4099 2>/dev/null | xargs kill -9 2>/dev/null
sleep 1

pnpm --silent --filter @acu/agent-b start >"$WORK/b.log" 2>&1 & PIDS+=($!)
AGENT_B_SKIP_ATTESTATION=1 AGENT_B_PORT=4022 \
  pnpm --silent --filter @acu/agent-b start >"$WORK/b-degraded.log" 2>&1 & PIDS+=($!)
pnpm --silent --filter @acu/demo mitm >"$WORK/mitm.log" 2>&1 & PIDS+=($!)

wait_for 4021 "agent B" || exit 1
wait_for 4022 "agent B (no attestation)" || exit 1
wait_for 4099 "man in the middle" || exit 1
echo "  agent B :4021 · agent B without attestation :4022 · MITM :4099"

FAILED=0
run_scene() {
  local n="$1"
  echo
  case "$n" in
  1)
    echo "① CleanUSD, LTV 7000 — the baseline: A hires B, B seals, A seals, contract lists"
    expect "✓ EXECUTED" "$CLEAN_USD" --ltv 7000 $LIVE --source "$SRC/CleanUSD.sol" --emit-seal "$SEAL" || FAILED=1
    ;;
  2)
    echo "② TrapUSD — the auditor says DENY and agent A relays it unsoftened"
    expect "✗ AUDIT_FAILED" "$TRAP_USD" --ltv 7000 $LIVE --source "$SRC/TrapUSD.sol" || FAILED=1
    ;;
  3)
    echo "③ replay — present CleanUSD's seal to list TrapUSD"
    if [ ! -f "$SEAL" ]; then
      echo "     (needs scene 1's seal; running it first)"
      agent_a "$CLEAN_USD" --ltv 7000 $LIVE --no-settle --source "$SRC/CleanUSD.sol" --emit-seal "$SEAL" >/dev/null
    fi
    if [ -n "$LIVE" ]; then
      expect "✗ SEAL_SUBJECT_MISMATCH" "$TRAP_USD" --ltv 7000 $LIVE --seal-file "$SEAL" || FAILED=1
    else
      echo "     => skipped in dry run (needs a real seal from scene 1)"
    fi
    ;;
  4)
    echo "④ CleanUSD at LTV 8000 — more leverage than the seal attested"
    expect "✗ LTV_EXCEEDS_ATTESTED" "$CLEAN_USD" --ltv 8000 $LIVE --source "$SRC/CleanUSD.sol" || FAILED=1
    ;;
  5)
    echo "⑤ agent B took the money and skipped the verifiable inference"
    expect "✗ DELEGATE_SEAL_INVALID" "$CLEAN_USD" --ltv 7000 $LIVE \
      --endpoint http://localhost:4022/audit --source "$SRC/CleanUSD.sol" || FAILED=1
    echo "     (ATTESTATION_MISSING — refused at the agent, nothing reached the chain)"
    ;;
  6)
    echo "⑥ man in the middle rewrites seal B's verdict, leaving the signature alone"
    expect "✗ DELEGATE_SEAL_INVALID" "$CLEAN_USD" --ltv 9000 $LIVE \
      --endpoint http://localhost:4099/audit --source "$SRC/CleanUSD.sol" || FAILED=1
    grep -h "rewrote" "$WORK/mitm.log" | tail -1 | sed 's/^/     /'
    echo "     (SIGNER_MISMATCH — both agents behaved correctly and the forgery still failed)"
    ;;
  esac
}

for n in "${SCENES[@]}"; do run_scene "$n"; done

echo
echo "════════════════════════════════════════════════════════════════"
if [ "$FAILED" -eq 0 ]; then
  echo " all scenes behaved as expected"
else
  echo " SOME SCENES DID NOT BEHAVE AS EXPECTED — see ❌ above"
fi
echo "════════════════════════════════════════════════════════════════"
exit "$FAILED"
