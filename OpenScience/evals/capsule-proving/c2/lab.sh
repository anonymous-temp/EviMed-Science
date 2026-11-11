#!/usr/bin/env bash
# C2 on evimed-lab: the EvoDS data-analysis benchmarks through the product path, resumable, at most two slots of our own.
#
#   lab.sh smoke                 6 DABench questions on one slot          -> /srv/evimed/runs/c2-dabench-smoke-1
#   lab.sh full                  DABench whole (257) -> DA-Code (100) -> DABench reuse arm; each bench summarised and its
#                                ledger row added when its pass is complete
#   lab.sh bench <bench> <arm>   one bench/arm pass (dabench|da-code, baseline|reuse)
#   lab.sh summarize <bench> <arm>
# Slot 1: PORT 48846, bridge 19366; slot 2: PORT 48847, bridge 19367 (the reserved ranges in USAGE.txt); one PostgreSQL
# (pgpp-55686) with a database per bench/arm/slot. Slot 2 takes no new task while the 1-minute load average is above 16.
# Re-run the same command to resume: records are kept, a dead worker's claims are taken over. Progress: /srv/evimed/runs/c2-STATUS.
set -euo pipefail
mode=${1:?usage: lab.sh smoke|full|bench <bench> <arm>|summarize <bench> <arm>}
PP=/srv/evimed/pp
TREE=${TREE:-/srv/evimed/wt/p10/OpenScience}
PG_PORT=${PG_PORT:-55686}
GATE_LOAD=${GATE_LOAD:-16}
STATUS_FILE=/srv/evimed/runs/c2-STATUS
LEDGER=${LEDGER:-/srv/evimed/results/ledger.jsonl}
C2="$TREE/evals/capsule-proving/c2"
stamp() { date -u +%FT%TZ; }
note() { echo "$(stamp) C2 $*" | tee -a "$STATUS_FILE"; }

export PATH="$PP/node24/bin:$PP/runtime-venv-c2/bin:$PP/judge-bin:$PATH"
export EVAL_SECRETS_DIR=/srv/evimed/secrets EVAL_DEEPSEEK_KEY_FILE=/srv/evimed/secrets/deepseek.api-key
export DSH_BIN="$PP/dsh/node_modules/.bin/dsh" EVAL_HOST_TOOL_BIN="$PP/runtime/tool-bin" EVAL_PG_BIN="$PP/pgbin"
export C2_STATUS_FILE="$STATUS_FILE" C2_SCORE_PYTHON="$PP/c2-score-venv/bin/python"
[[ -f "$PP/p10-c2-source.commit" ]] && export EVAL_TREE_COMMIT="${EVAL_TREE_COMMIT:-$(cat "$PP/p10-c2-source.commit")}"
set -a
# shellcheck disable=SC1091
. "$PP/env/memory.env"
set +a

# One slot: its own port lock, live dir, data dir, temp dir and memory-bridge port; three start-up attempts.
slot() {
  local n=$1 bench=$2 arm=$3 out=$4; shift 4
  local port=$((48845 + n)) bridge=$((19365 + n))
  (
    exec 8> "$PP/locks/port-$port.lock"
    flock -n 8 || { note "slot $n (port $port) is busy; not started"; exit 75; }
    if ss -ltn "sport = :$port" | grep -q LISTEN; then note "port $port already listening; slot $n not started"; exit 75; fi
    export EVAL_LIVE_DIR="$PP/live/p$port" TMPDIR="$PP/tmp/c2-$port"
    export EVAL_KERNEL_ENV="{\"EVIMED_MEMORY_BRIDGE_PORT\":\"$bridge\"}"
    mkdir -p "$TMPDIR"
    local gate=()
    [[ "$n" == 2 ]] && gate=(--gate-load "$GATE_LOAD")
    cd "$TREE"
    for attempt in 1 2 3; do
      if nice -n 5 node "$C2/run_c2.mjs" worker --bench "$bench" --arm "$arm" --out "$out" --slot "$n" --port "$port" --pg-port "$PG_PORT" \
        --tree "$TREE" "${gate[@]}" "$@"; then exit 0; fi
      note "$bench $arm slot $n attempt $attempt failed; resuming in 30 s"
      sleep 30
    done
    exit 1
  )
}

finish() {
  local bench=$1 arm=$2 out=$3
  (cd "$TREE" && node "$C2/run_c2.mjs" ledger --bench "$bench" --arm "$arm" --out "$out" --json "$out/ledger-row.json") | tee -a "$STATUS_FILE"
  if node -e 'const s=require(process.argv[1]); process.exit(s.complete ? 0 : 1)' "$out/c2-summary.json"; then
    (cd /srv/evimed/repo/OpenScience && node evals/capsule-proving/run/ledger.mjs add --json "$out/ledger-row.json" --ledger "$LEDGER") | tee -a "$STATUS_FILE"
  else
    note "$bench $arm incomplete: summary written, no ledger row (resume: bash $C2/lab.sh bench $bench $arm)"
  fi
}

pass() {
  local bench=$1 arm=$2 out="/srv/evimed/runs/c2-$1-$2-1"
  mkdir -p "$out"
  note "$bench $arm start load=$(cut -d' ' -f1 /proc/loadavg) resume: TREE=$TREE bash $C2/lab.sh bench $bench $arm"
  if [[ "$arm" == reuse ]]; then
    slot 1 "$bench" "$arm" "$out" || true
  else
    slot 1 "$bench" "$arm" "$out" & local p1=$!
    sleep 90  # let slot 1's harness take its ports first
    slot 2 "$bench" "$arm" "$out" & local p2=$!
    wait "$p1" || true; wait "$p2" || true
  fi
  finish "$bench" "$arm" "$out"
}

bash "$PP/bin/infra.sh" up "$PG_PORT" >/dev/null
case "$mode" in
  smoke)
    bench=${2:-dabench}
    out=/srv/evimed/runs/c2-$bench-smoke-1
    mkdir -p "$out"
    note "$bench smoke start load=$(cut -d' ' -f1 /proc/loadavg)"
    # DABench: two easy, two medium, two hard questions on six different tables (the first two of each level, in file order, on a
    # new table). DA-Code: a table answer, a text answer, a plot (official plot post-processing) and a task with a file above the
    # upload ceiling.
    if [[ "$bench" == dabench ]]; then tasks=${SMOKE_TASKS:-0,9,27,34,23,70}; else tasks=${SMOKE_TASKS:-dm-csv-021,di-text-015,plot-scatter-014,di-csv-012}; fi
    slot 1 "$bench" baseline "$out" --tasks "$tasks" || true
    (cd "$TREE" && node "$C2/run_c2.mjs" summarize --bench "$bench" --arm baseline --out "$out") | tee -a "$STATUS_FILE"
    ;;
  full)
    pass dabench baseline
    pass da-code baseline
    pass dabench reuse
    note "full sequence finished"
    ;;
  bench) pass "${2:?bench}" "${3:?arm}" ;;
  summarize) out="/srv/evimed/runs/c2-$2-$3-1"; (cd "$TREE" && node "$C2/run_c2.mjs" summarize --bench "$2" --arm "$3" --out "$out") ;;
  *) echo "unknown mode $mode" >&2; exit 64 ;;
esac
