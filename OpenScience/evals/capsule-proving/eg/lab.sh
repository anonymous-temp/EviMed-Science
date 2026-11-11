#!/usr/bin/env bash
# Run with setsid nohup; each output directory has STATUS and a restartable driver.
set -euo pipefail
suite=${1:?g1|g10|g3}; shift
run_out=""; previous_arg=""
for value in "$@"; do
  if [[ "$previous_arg" == --out ]]; then run_out=$value; break; fi
  previous_arg=$value
done
[[ -n "$run_out" ]] || { echo "--out required"; exit 2; }
PP=/srv/evimed/pp
TREE=${TREE:-/srv/evimed/wt/run/OpenScience}
PORT=${PORT:-48854}; PG_PORT=${PG_PORT:-55684}; BRIDGE_PORT=${BRIDGE_PORT:-19374}
exec 8> "$PP/locks/port-$PORT.lock"
flock -n 8 || { echo "slot $PORT occupied"; exit 75; }
if ss -ltn "sport = :$PORT" | grep -q LISTEN; then echo "port $PORT occupied"; exit 75; fi
balance=$(awk '{print int($3)}' /srv/evimed/runs/BUDGET-LAST)
((balance >= 400)) || { echo "balance below 400; batch refused"; exit 3; }
bash "$PP/bin/infra.sh" up "$PG_PORT" >/dev/null
export PATH="$PP/node24/bin:$PP/runtime-venv/bin:$PP/judge-bin:$PATH"
export EVAL_SECRETS_DIR=/srv/evimed/secrets EVAL_DEEPSEEK_KEY_FILE=/srv/evimed/secrets/deepseek.api-key
export EVAL_LIVE_DIR="$PP/live/p$PORT" DSH_BIN="$PP/dsh/node_modules/.bin/dsh"
export EVAL_HOST_TOOL_BIN="$PP/runtime/tool-bin" EVAL_PG_BIN="$PP/pgbin"
export TMPDIR="$PP/tmp/eg-$PORT"; mkdir -p "$TMPDIR"
set -a
. "$PP/env/memory.env"
. "$TREE/evals/capsule-proving/eg/candidate.env"
set +a
export EVAL_KERNEL_ENV="{\"EVIMED_MEMORY_BRIDGE_PORT\":\"$BRIDGE_PORT\"}"
cd "$TREE"
# Retry budget counts consecutive failures without new accepted work, not all failures since startup.
progress_count() {
  python3 - "$suite" "$run_out" <<'PY'
import json,sys
from pathlib import Path
suite,out=sys.argv[1],Path(sys.argv[2])
if suite=='g1':
    p=out/'provenance.json'
    d=json.loads(p.read_text()) if p.exists() else {}
    data=Path(d.get('args',{}).get('dataDir') or f'/srv/evimed/pp/data/{out.name}')
    ids=set()
    for file in data.glob('users/*/projects/*/.openscience/runs.jsonl'):
        for line in file.read_text().splitlines():
            try:r=json.loads(line)
            except ValueError:continue
            if isinstance(r.get('id'),str):ids.add(r['id'])
    print(len(ids))
else:
    print(len(list((out/('records' if suite=='g10' else 'results')).glob('*.json'))))
PY
}
best_progress=$(progress_count)
failures=0
while true; do
  set +e
  nice -n 5 node "evals/capsule-proving/eg/$suite.mjs" --tree "$TREE" --port "$PORT" --pg-port "$PG_PORT" "$@"
  rc=$?
  set -e
  [[ "$rc" == 0 || "$rc" == 3 ]] && exit "$rc"
  progress_now=$(progress_count)
  if ((progress_now > best_progress)); then failures=0; best_progress=$progress_now; fi
  failures=$((failures + 1))
  if ((failures >= 3)); then exit "$rc"; fi
  echo "$(date -u +%FT%TZ) EG retry noProgressFailures=$failures rc=$rc progress=$best_progress in 30s (stable dispatch ids and progress files)"
  sleep 30
done
