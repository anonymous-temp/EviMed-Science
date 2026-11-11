#!/usr/bin/env bash
# LX on evimed-lab: one product-path slot of its own, experiments in the order L1 (tool chain on), L10 (on), L1/L10 (off), L5, L2.
#   bash lab.sh all | <exp>:<arm>[,<exp>:<arm>...] [extra run_lx args]     resumable; progress in /srv/evimed/runs/lx-STATUS
set -euo pipefail
plan=${1:-all}; shift || true
[[ "$plan" == all ]] && plan='l1:tc-on,l10:tc-on,l1:tc-off,l10:tc-off,l5:base,l2:evolve,l2:frozen,l2:add-only'
PP=/srv/evimed/pp
TREE=${TREE:-/srv/evimed/wt/p13/OpenScience}
PORT=${PORT:-48852}; PG_PORT=${PG_PORT:-55682}; BRIDGE_PORT=${BRIDGE_PORT:-19372}
export LX_STATUS_FILE=/srv/evimed/runs/lx-STATUS
mkdir -p "$PP/locks" /srv/evimed/runs
exec 8> "$PP/locks/port-$PORT.lock"
flock -n 8 || { echo "LX slot $PORT is already occupied"; exit 75; }
if ss -ltn "sport = :$PORT" | grep -q LISTEN; then echo "Port $PORT is already listening"; exit 75; fi
echo $$ > /srv/evimed/runs/lx.pid
bash "$PP/bin/infra.sh" up "$PG_PORT" >/dev/null
export PATH="$PP/node24/bin:$PP/runtime-venv/bin:$PP/judge-bin:$PATH"
export EVAL_SECRETS_DIR=/srv/evimed/secrets EVAL_DEEPSEEK_KEY_FILE=/srv/evimed/secrets/deepseek.api-key
export EVAL_LIVE_DIR="$PP/live/p$PORT" DSH_BIN="$PP/dsh/node_modules/.bin/dsh"
export EVAL_HOST_TOOL_BIN="$PP/runtime/tool-bin" EVAL_PG_BIN="$PP/pgbin"
if [[ -f "$PP/p13-lx-source.commit" ]]; then export EVAL_TREE_COMMIT="${EVAL_TREE_COMMIT:-$(cat "$PP/p13-lx-source.commit")}"; fi
export TMPDIR="$PP/tmp/lx-$PORT"; mkdir -p "$TMPDIR"
set -a; . "$PP/env/memory.env"; set +a
export EVAL_KERNEL_ENV="{\"EVIMED_MEMORY_BRIDGE_PORT\":\"$BRIDGE_PORT\"}"
cd "$TREE"
IFS=',' read -ra steps <<< "$plan"
for s in "${steps[@]}"; do
  exp=${s%%:*}; arm=${s#*:}
  # The budget guard stops everything below CNY 150; do not start a new experiment below 200.
  bal=$(awk '{print int($3)}' /srv/evimed/runs/BUDGET-LAST 2>/dev/null || echo 0)
  if (( bal < 200 )); then printf '%s LX stop: balance %s below 200 before %s\n' "$(date -u +%FT%TZ)" "$bal" "$s" >> "$LX_STATUS_FILE"; exit 3; fi
  printf '%s LX %s %s start load=%s resume: TREE=%s PORT=%s PG_PORT=%s BRIDGE_PORT=%s setsid nohup bash %s/evals/capsule-proving/lx/lab.sh %s\n' \
    "$(date -u +%FT%TZ)" "$exp" "$arm" "$(cut -d' ' -f1 /proc/loadavg)" "$TREE" "$PORT" "$PG_PORT" "$BRIDGE_PORT" "$TREE" "$plan" >> "$LX_STATUS_FILE"
  ok=0
  for attempt in 1 2 3; do
    if nice -n 5 node evals/capsule-proving/lx/run_lx.mjs --tree "$TREE" --exp "$exp" --arm "$arm" --port "$PORT" --pg-port "$PG_PORT" --seed-from "$PP/seed/dsh-seed" "$@"; then ok=1; break; fi
    printf '%s LX %s %s attempt %s failed; resume in 30s\n' "$(date -u +%FT%TZ)" "$exp" "$arm" "$attempt" >> "$LX_STATUS_FILE"
    sleep 30
  done
  [[ "$ok" == 1 ]] || exit 1
  out=/srv/evimed/runs/lx-$exp-$arm-1
  # Respect the same explicit output override as run_lx.mjs.
  previous_arg=''
  for arg in "$@"; do
    [[ "$previous_arg" != --out ]] || out="$arg"
    previous_arg="$arg"
  done
  # One marker per rows file content: a later run over more units (L2 people) adds its own rows.
  if [[ -f "$out/ledger-rows.json" ]]; then
    mark="$out/ledger-added-$(sha1sum "$out/ledger-rows.json" | cut -c1-12)"
    if [[ ! -f "$mark" ]]; then
      (cd /srv/evimed/repo/OpenScience && node evals/capsule-proving/run/ledger.mjs add --json "$out/ledger-rows.json" --ledger /srv/evimed/results/ledger.jsonl) >> "$out/ledger-added.log" 2>&1 && touch "$mark"
    fi
  fi
done
printf '%s LX plan %s complete\n' "$(date -u +%FT%TZ)" "$plan" >> "$LX_STATUS_FILE"
