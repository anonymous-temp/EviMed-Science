#!/bin/bash
# C1 round 2 (F3): the arms on the camp libraries (c1-lib-2), arm-major, from the frozen code copy, then the ledger rows of every complete cell.
# Copied to /srv/evimed/runs/c1-arms-2/start.sh and started with
#   cd /srv/evimed/runs/c1-arms-2 && setsid nohup ./start.sh </dev/null >> queue.log 2>&1 &
# Resumable: run it again to continue (finished episodes and folds are skipped; ledger rows already appended are skipped by their id).
set -u
ROOT=/srv/evimed/runs
export C1_WT=$ROOT/c1-lib-2/code/OpenScience C1_LIB=$ROOT/c1-lib-2 C1_QUEUE=$ROOT/c1-arms-2 C1_OUT=c1-arm2
export C1_LEARN_THINKING=disabled C1_ORDER=arm-major C1_SUMMARY=$ROOT/c1-summary-2.json C1_SUMMARY_DIRS="c1-noskill-1,c1-arm2-*"
C1=$C1_WT/evals/capsule-proving/c1
cd $ROOT/c1-arms-2 && ./run.sh
python3 $C1/summarize.py --runs $ROOT --dirs "$C1_SUMMARY_DIRS" --out $C1_SUMMARY > /dev/null
python3 $C1/ledger_rows.py --summary $C1_SUMMARY --commit "$(cat $ROOT/c1-lib-2/code/COMMIT)" --out $ROOT/c1-ledger-2.json
python3 - "$ROOT/c1-ledger-2.json" <<'EOF'
import json, sys
rows = [row for row in json.load(open(sys.argv[1])) if row["arm"] != "no-skill"]  # the no-skill rows are in the ledger already
json.dump(rows, open(sys.argv[1], "w"), indent=1)
EOF
(cd /srv/evimed/repo/OpenScience && node evals/capsule-proving/run/ledger.mjs add --json $ROOT/c1-ledger-2.json --ledger /srv/evimed/results/ledger.jsonl) \
  && echo "$(date -u +%FT%TZ) c1 round 2: ledger rows of the complete cells added from $ROOT/c1-ledger-2.json; summary $C1_SUMMARY" >> $ROOT/c1-STATUS
