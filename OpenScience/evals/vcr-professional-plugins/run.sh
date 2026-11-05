#!/bin/sh
set -eu
ROOT=$(git rev-parse --show-toplevel)
OUT="${VCR_EVAL_OUTPUT:-$ROOT/.evimed-local/acceptance/vcr-professional-full-20261105/clinical}"
if [ -e "$OUT/full-synth-result.json" ] || [ -e "$OUT/actg-result.json" ] || [ -e "$OUT/hr-model-result.json" ]; then
 printf "%s\n" "Output already contains results; choose a fresh private output directory." >&2; exit 1
fi
LIB="${VCR_EVAL_RLIB:-$ROOT/.evimed-local/acceptance/vcr-professional-full-20261105/rlib}"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
VCR_EVAL_OUTPUT="$OUT"
VCR_EVAL_RAW_DIR="${VCR_EVAL_RAW_DIR:-$ROOT/.evimed-local/acceptance/vcr-benchmark-20261029/numeric/raw}"
VCR_EVAL_ACTG_INPUT="${VCR_EVAL_ACTG_INPUT:-$ROOT/.evimed-local/acceptance/vcr-benchmark-20261029/numeric/input/actg_survival.csv}"
export VCR_EVAL_OUTPUT VCR_EVAL_RAW_DIR
[ -f "$VCR_EVAL_ACTG_INPUT" ] || { printf '%s\n' 'ACTG input is unavailable.' >&2; exit 1; }
cp "$VCR_EVAL_ACTG_INPUT" "$OUT/actg_survival.csv"
[ -d "$LIB/synthpop" ] || { printf "%s\n" "Install and verify the locked runtime library before running." >&2; exit 1; }
docker run --rm --network none -e VCR_R_LIBS=/rlib -e VCR_R_LOCKS=runtime -e VCR_ENGINE_ROOT=/repo/项目代码/vcr-engine -v "$ROOT:/repo:ro" -v "$LIB:/rlib:ro" --entrypoint bash evimed-vcr-native-numeric:20261026 /repo/OpenScience/scripts/vcr/r-library.sh verify
python3 "$ROOT/OpenScience/evals/vcr-professional-plugins/prepare.py"
python3 "$ROOT/OpenScience/evals/vcr-professional-plugins/hr_baseline.py"
# A synthpop call cannot be interrupted by its own between-copy CPU check.
# Bound this task with a private container watchdog, recording sampled CPU.
if docker inspect codex-vcr-synth-full >/dev/null 2>&1; then
 printf '%s\n' 'codex-vcr-synth-full already exists; refuse to alter it.' >&2; exit 1
fi
docker run --rm --name codex-vcr-synth-full --network none --cpus 2 --memory 6g --entrypoint Rscript -e VCR_ENGINE_DATA_ROOT=/clinical -e R_LIBS_USER=/rlib -e VCR_R_LIBS=/rlib -v "$LIB:/rlib:ro" -v "$ROOT:/repo:ro" -v "$OUT:/clinical" evimed-vcr-native-numeric:20261026 /repo/OpenScience/evals/vcr-professional-plugins/run_synth.R >"$OUT/run_synth.R.log" 2>&1 &
synth_pid=$!
trap 'docker stop -t 15 codex-vcr-synth-full >/dev/null 2>&1 || true' INT TERM EXIT
tries=0
while ! docker inspect codex-vcr-synth-full >/dev/null 2>&1; do
 tries=$((tries+1)); [ "$tries" -lt 10 ] || { wait "$synth_pid" || true; exit 1; }; sleep 1
done
python3 "$ROOT/OpenScience/evals/vcr-professional-plugins/watch_limits.py" codex-vcr-synth-full "$OUT/synth-limits.json" 2400 3000 &
watch_pid=$!
wait "$synth_pid" || printf '%s\n' "$?" >"$OUT/run_synth.R.exit"
wait "$watch_pid"
trap - INT TERM EXIT
if [ -f "$OUT/full-synth-result.json" ] && [ -f "$OUT/full-engine-output/synthetic-population.csv" ] &&
 python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get("status")=="succeeded" else 1)' "$OUT/full-synth-result.json"; then
 python3 "$ROOT/OpenScience/evals/vcr-professional-plugins/validate_encodings.py"
 docker run --rm --network none --cpus 2 --memory 6g -e R_LIBS_USER=/rlib -e VCR_R_LIBS=/rlib -e EVAL_PREFIX=full -e EVAL_TRAIN_FILE=engine_train.csv -e EVAL_TEST_PREFIX=analysis_ -e EVAL_OUTPUT=full-score.json --entrypoint timeout -v "$LIB:/rlib:ro" -v "$ROOT:/repo:ro" -v "$OUT:/clinical" evimed-vcr-native-numeric:20261026 --signal=INT --kill-after=15 1200 Rscript /repo/OpenScience/evals/vcr-professional-plugins/score_synthesis.R >"$OUT/full-score.log" 2>&1 || printf '%s\n' "$?" >"$OUT/full-score.exit"
fi
for task in actg.R cohort.R hr_model.R; do
 docker run --rm --network none --cpus 2 --memory 6g --entrypoint Rscript -e VCR_ENGINE_DATA_ROOT=/clinical -e R_LIBS_USER=/rlib -e VCR_R_LIBS=/rlib -v "$LIB:/rlib:ro" -v "$ROOT:/repo:ro" -v "$OUT:/clinical" evimed-vcr-native-numeric:20261026 "/repo/OpenScience/evals/vcr-professional-plugins/$task" >"$OUT/$task.log" 2>&1 || printf '%s\n' "$?" >"$OUT/$task.exit"
done
if [ -f "$OUT/hr-pred-b/prognostic-predictions.csv" ] && [ -f "$OUT/hr-pred-c/prognostic-predictions.csv" ]; then
 python3 "$ROOT/OpenScience/evals/vcr-professional-plugins/hr_uncertainty.py"
fi

docker run --rm --network none --cpus 2 --memory 6g -e VCR_TEST_ONLY="^N73b$" -e VCR_TEST_CORES=2 --entrypoint bash -v "$ROOT/项目代码/vcr-engine:/opt/vcr-engine:ro" evimed-vcr-native-numeric:20261026 /opt/vcr-engine/tests/run_all.sh >"$OUT/known-truth.log" 2>&1
