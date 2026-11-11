#!/usr/bin/env bash
# One slot, serial arms. Run through setsid nohup; all data and pending state are durable.
set -euo pipefail
[[ "${L3B_CAPACITY_RESERVED:-}" == 1 ]] || { echo "Launch queue.py to reserve shared capacity first"; exit 75; }
plan=${1:-A,B,C,D}
PP=/srv/evimed/pp
TREE=${TREE:-/srv/evimed/wt/l3b/OpenScience}
PORT=${PORT:-48853}; PG_PORT=${PG_PORT:-55683}; BRIDGE_PORT=${BRIDGE_PORT:-19373}
mkdir -p "$PP/locks" /srv/evimed/runs
exec 8>"$PP/locks/port-$PORT.lock"
flock -n 8 || exit 75
if ss -ltn "sport = :$PORT" | grep -q LISTEN; then echo 'Harness port occupied'; exit 75; fi
free -g
uptime
export PATH="$PP/node24/bin:$PP/runtime-venv/bin:$PP/judge-bin:$PATH"
export EVAL_SECRETS_DIR=/srv/evimed/secrets EVAL_DEEPSEEK_KEY_FILE=/srv/evimed/secrets/deepseek.api-key
export EVAL_LIVE_DIR="$PP/live/p$PORT-l3b" DSH_BIN="$PP/dsh/node_modules/.bin/dsh"
export EVAL_HOST_TOOL_BIN="$PP/runtime/tool-bin" EVAL_PG_BIN="$PP/pgbin"
export TMPDIR="$PP/tmp/l3b-$PORT"; mkdir -p "$TMPDIR"
export EVAL_TREE_COMMIT; EVAL_TREE_COMMIT=$(cat "$PP/l3b-source.commit")
set -a
. "$PP/env/memory.env"
set +a
export EVAL_KERNEL_ENV="{\"EVIMED_MEMORY_BRIDGE_PORT\":\"$BRIDGE_PORT\"}"
export OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED=true
# A shared conservative balance envelope includes concurrent lanes. No balance query prints a key.
python3 - <<'PY'
import json,time
from pathlib import Path
p=Path('/srv/evimed/runs/l3b-budget.json')
if not p.exists():
 balance=float(Path('/srv/evimed/runs/BUDGET-LAST').read_text().split()[2])
 if balance<400:raise SystemExit('Do not start a batch below CNY 400')
 with p.open('x') as f:json.dump(dict(balanceBefore=balance,startedAt=time.time(),deadlineMs=(time.time()+12*3600)*1000,capCny=400),f)
PY
cd "$TREE"
IFS=',' read -ra arms <<< "$plan"
for arm in "${arms[@]}"; do
  exec 9>"/srv/evimed/runs/l3b-$arm-1.lock"
  flock -n 9 || { echo "Arm $arm is already running"; exit 75; }
  nice -n 5 node evals/capsule-proving/l3b/run_l3b.mjs --tree "$TREE" --arm "$arm" --port "$PORT" --pg-port "$PG_PORT"
  python3 evals/capsule-proving/l3b/score.py --run "/srv/evimed/runs/l3b-$arm-1"
  python3 evals/capsule-proving/l3b/score.py --run "/srv/evimed/runs/l3b-$arm-1" --mode memory
  python3 evals/capsule-proving/l3b/report.py
  flock -u 9
  printf '%s L3B %s complete\n' "$(date -u +%FT%TZ)" "$arm"
done
