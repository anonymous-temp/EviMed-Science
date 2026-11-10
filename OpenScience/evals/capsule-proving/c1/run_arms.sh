#!/bin/bash
# C1 arms queue on the lab host, in order of information value, ready items first, resumable item by item (run_c1.py skips finished episodes, the evolving
# library skips taught waves). Copied to /srv/evimed/runs/c1-arms-1/run.sh and started with `setsid nohup ./run.sh`.
# Workers: 4 when the one-minute load is under 16, else 2 (checked before each fold). Progress lines go to /srv/evimed/runs/c1-STATUS
# and the combined summary is refreshed after each fold.
set -u
WT=${C1_WT:-/srv/evimed/wt/p11/OpenScience}
C1=$WT/evals/capsule-proving/c1
POOL=$WT/evals/capsule-proving/pools/c-samples-20261110.json
TRAINPOOL=$WT/evals/capsule-proving/pools/c1-train-20261110.json
ROOT=/srv/evimed/runs
# A round of arms is a library directory, a queue directory, an output prefix and an order (F3's camp round: C1_LIB=$ROOT/c1-lib-2
# C1_QUEUE=$ROOT/c1-arms-2 C1_OUT=c1-arm2 C1_ORDER=arm-major C1_SUMMARY=$ROOT/c1-summary-2.json).
LIB=${C1_LIB:-$ROOT/c1-lib-1}
QUEUE=${C1_QUEUE:-$ROOT/c1-arms-1}
OUTP=${C1_OUT:-c1-arm}
ORDER=${C1_ORDER:-env-interleaved}
SUMMARY=${C1_SUMMARY:-$ROOT/c1-summary.json}
SUMMARY_DIRS=${C1_SUMMARY_DIRS:-}
PY=/srv/evimed/c1/venv/bin/python
EMB=/srv/evimed/secrets/dashscope.api-key
KEY=/srv/evimed/secrets/deepseek.api-key

status() { echo "$(date -u +%FT%TZ) $*" >> $ROOT/c1-STATUS; }
# C1_MAX_WORKERS caps the workers (the commander's budget order of 2026-11-10: 3); C1_ARMS limits the queue to the arms it names.
MAX_WORKERS=${C1_MAX_WORKERS:-4}
ARMS=${C1_ARMS:-}
workers() { local load w; load=$(cut -d' ' -f1 /proc/loadavg); if awk "BEGIN{exit !($load < 16)}"; then w=4; else w=2; fi; [ "$w" -gt "$MAX_WORKERS" ] && w=$MAX_WORKERS; echo "$w"; }
refresh() { python3 $C1/summarize.py --runs $ROOT --out "$SUMMARY" ${SUMMARY_DIRS:+--dirs "$SUMMARY_DIRS"} > /dev/null 2>&1; }

# run_arm <arm> <env> <fold> <library variant> <mode> [removed roles]
run_arm() {
  local arm=$1 env=$2 fold=$3 variant=$4 mode=$5 roles=${6:-} out extra=() count W rc
  out=$ROOT/$OUTP-$arm-1
  mkdir -p "$out"
  if [ -n "$roles" ]; then
    # An arm that removes a role the library does not hold would be the pyramid arm again: recorded and skipped.
    count=$(python3 -c "import json; d=json.load(open('$LIB/$env-$variant.json')); print(sum(1 for m in d['methods'] if m['payload'].get('status')=='approved' and m['payload']['frontmatter'].get('metadata',{}).get('role') in '$roles'.split(',')))")
    if [ "$count" = "0" ]; then
      if ! grep -qx "SKIP $arm $env $fold" "$out/SKIPPED" 2>/dev/null; then
        echo "SKIP $arm $env $fold" >> "$out/SKIPPED"
        status "c1 arm $arm $env $fold skipped: the $env $variant library holds no approved $roles method, so this arm equals pyramid"
      fi
      LAST_RC=0
      return
    fi
    extra=(--remove-roles "$roles")
  fi
  W=$(workers)
  (cd "$C1" && $PY run_c1.py --env "$env" --fold "$fold" --samples "$POOL" --arm "$arm" --library "$LIB/$env-$variant.json" --mode "$mode" \
    --selector product "${extra[@]}" --embed-key-file "$EMB" --out "$out" --workers "$W" --key-file "$KEY" >> "$out/run.log" 2>&1)
  rc=$?
  LAST_RC=$rc
  status "c1 arm $arm $env $fold finished (exit $rc, $W workers): $(tail -1 "$out/summaries.jsonl" 2>/dev/null | cut -c1-260)"
  refresh
}

# run_evolving <env> <fold>: the pyramid library copied once, seeded with the training successes, then taught each finished wave of 8.
run_evolving() {
  local env=$1 fold=$2 out=$ROOT/$OUTP-evolving-1 dir W rc
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
  LAST_RC=$rc
  status "c1 arm evolving $env $fold finished (exit $rc, $W workers): $(tail -1 "$out/summaries.jsonl" 2>/dev/null | cut -c1-260)"
  refresh
}

# The queue in order of information value. Each pass runs the first item that is not done and whose library exists, so an item whose
# library is still being built does not hold up the ones behind it. An item is done when run_c1 exits 0 (or it was skipped); one that
# fails three times is recorded as failed and left.
ITEMS=(
  "pyramid alfworld seen pyramid pyramid" "pyramid alfworld unseen pyramid pyramid"
  "flat alfworld seen pyramid flat" "flat alfworld unseen pyramid flat"
  "pyramid scienceworld seen pyramid pyramid" "pyramid scienceworld unseen pyramid pyramid"
  "flat scienceworld seen pyramid flat" "flat scienceworld unseen pyramid flat"
  "from-scratch alfworld seen from-scratch pyramid" "from-scratch alfworld unseen from-scratch pyramid"
  "from-scratch scienceworld seen from-scratch pyramid" "from-scratch scienceworld unseen from-scratch pyramid"
  "add-only alfworld seen add-only pyramid" "add-only alfworld unseen add-only pyramid"
  "add-only scienceworld seen add-only pyramid" "add-only scienceworld unseen add-only pyramid"
  "no-abstract alfworld seen pyramid pyramid abstract" "no-abstract alfworld unseen pyramid pyramid abstract"
  "no-abstract scienceworld seen pyramid pyramid abstract" "no-abstract scienceworld unseen pyramid pyramid abstract"
  "no-atomic alfworld seen pyramid pyramid atomic" "no-atomic alfworld unseen pyramid pyramid atomic"
  "no-atomic scienceworld seen pyramid pyramid atomic" "no-atomic scienceworld unseen pyramid pyramid atomic"
  "evolving alfworld seen pyramid pyramid" "evolving alfworld unseen pyramid pyramid"
  "evolving scienceworld seen pyramid pyramid" "evolving scienceworld unseen pyramid pyramid"
)
if [ "$ORDER" = arm-major ]; then
  # One arm after another, every fold of it, in the order of the brief: pyramid, flat, from-scratch, no-abstract, no-atomic, add-only, evolving.
  ITEMS=()
  for spec in "pyramid pyramid pyramid" "flat pyramid flat" "from-scratch from-scratch pyramid" "no-abstract pyramid pyramid abstract" \
              "no-atomic pyramid pyramid atomic" "add-only add-only pyramid" "evolving pyramid pyramid"; do
    read -r arm variant mode roles <<< "$spec"
    for ef in "alfworld seen" "alfworld unseen" "scienceworld seen" "scienceworld unseen"; do
      ITEMS+=("$arm $ef $variant $mode${roles:+ $roles}")
    done
  done
fi
Q=$QUEUE
touch "$Q/DONE" "$Q/FAILS"
status "c1 arms queue started (pid $$)"
while true; do
  remaining=0 ran=0
  for item in "${ITEMS[@]}"; do
    read -r arm env fold variant mode roles <<< "$item"
    if [ -n "$ARMS" ] && [[ " $ARMS " != *" $arm "* ]]; then continue; fi
    grep -qx "$arm $env $fold" "$Q/DONE" && continue
    grep -qx "FAILED $arm $env $fold" "$Q/FAILS" && continue
    remaining=1
    [ -f "$LIB/$env-$variant.json" ] || continue
    if [ "$arm" = evolving ]; then run_evolving "$env" "$fold"; else run_arm "$arm" "$env" "$fold" "$variant" "$mode" "${roles:-}"; fi
    if [ "$LAST_RC" = 0 ]; then
      echo "$arm $env $fold" >> "$Q/DONE"
    else
      echo "$arm $env $fold" >> "$Q/FAILS"
      [ "$(grep -cx "$arm $env $fold" "$Q/FAILS")" -ge 3 ] && echo "FAILED $arm $env $fold" >> "$Q/FAILS" && status "c1 arm $arm $env $fold failed three times; left"
    fi
    ran=1
    break
  done
  [ "$remaining" = 0 ] && break
  [ "$ran" = 0 ] && sleep 120
done
status "c1 arms queue finished"
