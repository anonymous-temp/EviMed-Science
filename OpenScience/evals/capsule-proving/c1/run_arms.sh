#!/bin/bash
# C1 arms queue on the lab host, in order of information value, resumable item by item (run_c1.py skips finished episodes, the evolving
# library skips taught waves). Copied to /srv/evimed/runs/c1-arms-1/run.sh and started with `setsid nohup ./run.sh`.
# Workers: 4 when the one-minute load is under 16, else 2 (checked before each fold). Progress lines go to /srv/evimed/runs/c1-STATUS
# and the combined summary is refreshed after each fold.
set -u
WT=${C1_WT:-/srv/evimed/wt/p11/OpenScience}
C1=$WT/evals/capsule-proving/c1
POOL=$WT/evals/capsule-proving/pools/c-samples-20261110.json
TRAINPOOL=$WT/evals/capsule-proving/pools/c1-train-20261110.json
ROOT=/srv/evimed/runs
LIB=$ROOT/c1-lib-1
PY=/srv/evimed/c1/venv/bin/python
EMB=/srv/evimed/secrets/dashscope.api-key
KEY=/srv/evimed/secrets/deepseek.api-key

status() { echo "$(date -u +%FT%TZ) $*" >> $ROOT/c1-STATUS; }
workers() { local load; load=$(cut -d' ' -f1 /proc/loadavg); if awk "BEGIN{exit !($load < 16)}"; then echo 4; else echo 2; fi; }
wait_for() { until [ -f "$1" ]; do sleep 60; done; }
refresh() { python3 $C1/summarize.py --runs $ROOT --out $ROOT/c1-summary.json > /dev/null 2>&1; }

# run_arm <arm> <env> <fold> <library variant> <mode> [removed roles]
run_arm() {
  local arm=$1 env=$2 fold=$3 variant=$4 mode=$5 roles=${6:-} out extra=() count W rc
  wait_for "$LIB/$env-$variant.json"
  out=$ROOT/c1-arm-$arm-1
  mkdir -p "$out"
  if [ -n "$roles" ]; then
    # An arm that removes a role the library does not hold would be the pyramid arm again: recorded and skipped.
    count=$(python3 -c "import json; d=json.load(open('$LIB/$env-$variant.json')); print(sum(1 for m in d['methods'] if m['payload'].get('status')=='approved' and m['payload']['frontmatter'].get('metadata',{}).get('role') in '$roles'.split(',')))")
    if [ "$count" = "0" ]; then
      if ! grep -qx "SKIP $arm $env $fold" "$out/SKIPPED" 2>/dev/null; then
        echo "SKIP $arm $env $fold" >> "$out/SKIPPED"
        status "c1 arm $arm $env $fold skipped: the $env $variant library holds no approved $roles method, so this arm equals pyramid"
      fi
      return
    fi
    extra=(--remove-roles "$roles")
  fi
  W=$(workers)
  (cd "$C1" && $PY run_c1.py --env "$env" --fold "$fold" --samples "$POOL" --arm "$arm" --library "$LIB/$env-$variant.json" --mode "$mode" \
    --selector product "${extra[@]}" --embed-key-file "$EMB" --out "$out" --workers "$W" --key-file "$KEY" >> "$out/run.log" 2>&1)
  rc=$?
  status "c1 arm $arm $env $fold finished (exit $rc, $W workers): $(tail -1 "$out/summaries.jsonl" 2>/dev/null | cut -c1-260)"
  refresh
}

# run_evolving <env> <fold>: the pyramid library copied once, seeded with the training successes, then taught each finished wave of 8.
run_evolving() {
  local env=$1 fold=$2 out=$ROOT/c1-arm-evolving-1 dir W rc
  wait_for "$LIB/$env-pyramid.json"
  dir=$out/lib-$env
  mkdir -p "$out"
  if [ ! -f "$dir/export.json" ]; then
    rm -rf "$dir" && cp -a "$LIB/$env-pyramid" "$dir" && rm -f "$dir/seen.json"
    (cd "$C1" && node build_library.mjs evolve --env "$env" --dir "$dir" --export "$dir/export.json" --train-dir $ROOT/c1-train-1 --pool "$TRAINPOOL" \
      --embed-key-file "$EMB" --key-file "$KEY" >> "$out/run.log" 2>&1)
  fi
  W=$(workers)
  (cd "$C1" && $PY run_c1.py --env "$env" --fold "$fold" --samples "$POOL" --arm evolving --library "$dir/export.json" --mode pyramid \
    --selector product --evolve "$dir" --wave 8 --embed-key-file "$EMB" --out "$out" --workers "$W" --key-file "$KEY" >> "$out/run.log" 2>&1)
  rc=$?
  status "c1 arm evolving $env $fold finished (exit $rc, $W workers): $(tail -1 "$out/summaries.jsonl" 2>/dev/null | cut -c1-260)"
  refresh
}

status "c1 arms queue started (pid $$)"
for env in alfworld scienceworld; do
  for fold in seen unseen; do run_arm pyramid "$env" "$fold" pyramid pyramid; done
  for fold in seen unseen; do run_arm flat "$env" "$fold" pyramid flat; done
  for fold in seen unseen; do run_arm from-scratch "$env" "$fold" from-scratch pyramid; done
done
for env in alfworld scienceworld; do
  for fold in seen unseen; do
    run_arm no-atomic "$env" "$fold" pyramid pyramid atomic
    run_arm no-abstract "$env" "$fold" pyramid pyramid abstract
    run_arm add-only "$env" "$fold" add-only pyramid
  done
done
for env in alfworld scienceworld; do
  for fold in seen unseen; do run_evolving "$env" "$fold"; done
done
status "c1 arms queue finished"
