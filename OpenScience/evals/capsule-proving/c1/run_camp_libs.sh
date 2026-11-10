#!/bin/bash
# C1 round 2 (F3): the training camp's libraries on the lab host. One library per call, resumable step by step (build_library.mjs skips
# every lesson and pass already in <dir>/STATUS; model answers are shared through <out>/cache):
#
#   cd /srv/evimed/runs/c1-lib-2 && setsid nohup ./run.sh alfworld pyramid </dev/null >> run-alfworld-pyramid.log 2>&1 &
#
# Every finished training episode of F2's training pass (/srv/evimed/runs/c1-train-1, not re-run) is a camp lesson — success or failure — with
# both lab switches on (OPEN_SCIENCE_LEARNING_CAMP_ENABLED: `campLessonFor`; OPEN_SCIENCE_METHOD_TWO_STAGE_DISTILLATION_ENABLED: a frame, then
# one method per new sub-skill). The code is a frozen copy (./code), so a later sync of the lane's worktree cannot change a running build.
set -u
ROOT=/srv/evimed/runs
OUT=$ROOT/c1-lib-2
CODE=$OUT/code/OpenScience
C1=$CODE/evals/capsule-proving/c1
env=$1 variant=$2
status() { echo "$(date -u +%FT%TZ) $*" >> $ROOT/c1-STATUS; }
if [ -f "$OUT/$env-$variant.json" ]; then echo "already built: $OUT/$env-$variant.json"; exit 0; fi
status "c1 camp library $env-$variant build started (pid $$)"
cd "$C1" && node build_library.mjs build --lessons camp --env "$env" --variant "$variant" --train-dir $ROOT/c1-train-1 \
  --pool "$CODE/evals/capsule-proving/pools/c1-train-20261110.json" --out "$OUT" --sleep-every 10 \
  --embed-key-file /srv/evimed/secrets/dashscope.api-key --key-file /srv/evimed/secrets/deepseek.api-key
rc=$?
[ "$rc" = 0 ] || status "c1 camp library $env-$variant build stopped (exit $rc); resume: cd $OUT && setsid nohup ./run.sh $env $variant </dev/null >> run-$env-$variant.log 2>&1 &"
exit $rc
