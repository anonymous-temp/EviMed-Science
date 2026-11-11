#!/usr/bin/env bash
# Two reference slots after product practice exits; one sequential stream per benchmark.
set -euo pipefail
ROOT=${SB_ROOT:-/srv/evimed/sb}
TREE=${SB_PRODUCT_TREE:-/srv/evimed/wt/sb/OpenScience}
CODE="$ROOT/code"
PY="$ROOT/venv/bin/python"
export PATH="/srv/evimed/pp/node24/bin:$PATH" PI_TELEMETRY=0
exec 9> "$ROOT/reference.lock"
flock -n 9 || { echo 'Reference slot already running'; exit 75; }
note() { echo "$(date -u +%FT%TZ) SB $*" | tee -a /srv/evimed/runs/sb-STATUS; }
report() { flock "$ROOT/report.lock" node "$TREE/evals/capsule-proving/sb/report.mjs" "$ROOT" /srv/evimed/runs /srv/evimed/results/ledger.jsonl > "$ROOT/report.log"; }
trap 'note "campaign exit code=$?"' EXIT

if [[ "${1:-campaign}" == arm ]]; then
  "$PY" "$CODE/run.py" --bench "$2" --arm "$3" "${@:4}"
  report
  exit
fi

if [[ -n "${SB_SMOKE_DIR:-}" ]]; then
  note 'waiting for reference smoke verifier'
  # The process is detached; this loop never blocks the interactive agent's tool calls.
  until find "$SB_SMOKE_DIR" -mindepth 3 -maxdepth 3 -name result.json -print -quit | grep -q .; do sleep 15; done
  "$PY" - "$SB_SMOKE_DIR" <<'PY'
import json,pathlib,sys
file=sorted(pathlib.Path(sys.argv[1]).glob('*/*/result.json'))[-1]
j=json.loads(file.read_text())
if j.get('verifier_error') or j.get('rewards') is None:
    raise SystemExit('Smoke verifier unavailable; campaign not started')
print('Reference smoke has an official verifier result')
PY
fi

note 'waiting for product practice to release its slot and freeze the learned library'
until [[ -f "$ROOT/practice/complete.json" ]]; do
  "$PY" - "$ROOT/batch.json" <<'PY'
import json,sys,time
if time.time()>json.load(open(sys.argv[1]))['deadline']:raise SystemExit('Lane wall time allocation reached')
PY
  sleep 20
done
stream() {
  local bench="$1"
  local retry=()
  if [[ "${SB_RETRY_INFRA:-0}" == 1 ]]; then retry=(--retry-infra); fi
  # Prioritize the methods comparison if shared lab capacity prevents the final arm.
  # Order fixed before learned/flat scores. Trial URLs own attribution across both slots.
  for arm in none learned flat; do
    note "start $bench-$arm-1"
    "$PY" "$CODE/run.py" --bench "$bench" --arm "$arm" "${retry[@]}" || return $?
    report
  done
}
code=0
if [[ "${SB_REFERENCE_SLOTS:-1}" == 1 ]]; then
  stream sb || code=$?
  stream slb || code=$?
else
  stream sb & sb_pid=$!
  stream slb & slb_pid=$!
  wait "$sb_pid" || code=$?
  wait "$slb_pid" || code=$?
fi
report
[[ "$code" == 0 ]] || exit "$code"
note 'six arms finished'
