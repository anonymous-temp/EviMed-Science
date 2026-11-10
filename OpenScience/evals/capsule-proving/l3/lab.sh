#!/usr/bin/env bash
# One slot, serial arms. This deliberately stays below the two-slot maximum even when load falls below 16.
set -euo pipefail
mode=${1:-full}
[[ "$mode" == full || "$mode" == smoke || "$mode" == probe ]] || { echo 'usage: lab.sh full|smoke|probe'; exit 64; }
PP=/srv/evimed/pp
TREE=${TREE:-/srv/evimed/wt/psmall/OpenScience}
PORT=${PORT:-48854}; PG_PORT=${PG_PORT:-55684}; BRIDGE_PORT=${BRIDGE_PORT:-19364}
mkdir -p "$PP/locks" /srv/evimed/runs
exec 8> "$PP/locks/port-$PORT.lock"
flock -n 8 || { echo "L3 slot $PORT is already occupied"; exit 75; }
if ss -ltn "sport = :$PORT" | grep -q LISTEN; then echo "Port $PORT is already listening"; exit 75; fi
echo $$ > "/srv/evimed/runs/l3-$mode.pid"
uptime
bash "$PP/bin/infra.sh" up "$PG_PORT"
export PATH="$PP/node24/bin:$PP/runtime-venv/bin:$PP/judge-bin:$PATH"
export EVAL_SECRETS_DIR=/srv/evimed/secrets EVAL_DEEPSEEK_KEY_FILE=/srv/evimed/secrets/deepseek.api-key
export EVAL_LIVE_DIR="$PP/live/p$PORT" DSH_BIN="$PP/dsh/node_modules/.bin/dsh"
export EVAL_HOST_TOOL_BIN="$PP/runtime/tool-bin" L3_STATUS_FILE=/srv/evimed/runs/l3-STATUS
# Do not change HOME: give the PG-bin lookup its own explicit harness setting.
export EVAL_PG_BIN="$PP/pgbin"
# rsync preserves source bytes, not the remote checkout HEAD. The launch receipt supplies the source commit.
if [[ -f "$PP/psmall-l3-source.commit" ]]; then export EVAL_TREE_COMMIT="${EVAL_TREE_COMMIT:-$(cat "$PP/psmall-l3-source.commit")}"; fi
export TMPDIR="$PP/tmp/l3-$PORT"
mkdir -p "$TMPDIR"
set -a
. "$PP/env/memory.env"
set +a
export EVAL_KERNEL_ENV="{\"EVIMED_MEMORY_BRIDGE_PORT\":\"$BRIDGE_PORT\"}"
cd "$TREE"
arms='A B E D F'
[[ "$mode" == smoke ]] && arms='A B E'
[[ "$mode" == probe ]] && arms='E'
for arm in $arms; do
  out="/srv/evimed/runs/l3-$arm-1"
  options=()
  if [[ "$mode" == smoke ]]; then out="/srv/evimed/runs/l3-smoke-$arm-1"; options+=(--smoke); fi
  if [[ "$mode" == probe ]]; then out="/srv/evimed/runs/l3-probe-$arm-1"; options+=(--smoke --smoke-learning G23 --smoke-cases M01); fi
  printf '%s L3 %s start %s load=%s resume: TREE=%s PORT=%s PG_PORT=%s BRIDGE_PORT=%s bash %s/evals/capsule-proving/l3/lab.sh %s\n' \
    "$(date -u +%FT%TZ)" "$arm" "$mode" "$(cut -d' ' -f1 /proc/loadavg)" "$TREE" "$PORT" "$PG_PORT" "$BRIDGE_PORT" "$TREE" "$mode" >> "$L3_STATUS_FILE"
  # Three startup/transport retries. Durable account, records and phase markers prevent replaying completed work.
  done_ok=0
  for attempt in 1 2 3; do
    if nice -n 5 node evals/capsule-proving/l3/run_l3.mjs --tree "$TREE" --arm "$arm" --out "$out" \
      --port "$PORT" --pg-port "$PG_PORT" --seed-from "$PP/seed/dsh-seed" "${options[@]}"; then done_ok=1; break; fi
    printf '%s L3 %s attempt %s failed; resume in 15s\n' "$(date -u +%FT%TZ)" "$arm" "$attempt" >> "$L3_STATUS_FILE"
    sleep 15
  done
  [[ "$done_ok" == 1 ]] || exit 1
  if [[ "$mode" == smoke ]]; then
    node --input-type=module - "$out" <<'JS'
import fs from 'node:fs';
const out = process.argv[2];
const result = JSON.parse(fs.readFileSync(`${out}/l3-summary.json`));
// A task failure is evidence, but missing tools or infrastructure invalidate the smoke.
if (result.examRuns !== 2) throw new Error('Smoke did not record two cases');
for (const file of fs.readdirSync(`${out}/records`).filter(f => f.endsWith('.json'))) {
  const r = JSON.parse(fs.readFileSync(`${out}/records/${file}`));
  if (!r.firstRequest.hadMemoryTools || r.turns.some(t => t.error || t.timedOut || !['succeeded','unverified'].includes(t.run?.status)))
    throw new Error(`Smoke infrastructure/readiness failed: ${file}`);
}
console.log(fs.readFileSync(`${out}/l3-summary.txt`, 'utf8'));
JS
  fi
done
printf '%s L3 %s all arms complete\n' "$(date -u +%FT%TZ)" "$mode" >> "$L3_STATUS_FILE"
