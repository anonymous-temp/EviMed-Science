#!/usr/bin/env bash
set -euo pipefail
PP=/srv/evimed/pp
exec 8> "$PP/locks/port-48855.lock"
flock -n 8 || exit 75
if ss -ltn 'sport = :48855' | grep -q LISTEN; then exit 75; fi
if ss -ltn 'sport = :19365' | grep -q LISTEN; then exit 75; fi
export PATH="$PP/node24/bin:$PP/runtime-venv/bin:$PP/judge-bin:$PATH"
export EVAL_SECRETS_DIR=/srv/evimed/secrets EVAL_PG_BIN=$PP/pgbin EVAL_LIVE_DIR=$PP/live/p48855
export DSH_BIN=$PP/dsh/node_modules/.bin/dsh TMPDIR=/tmp/eval-t
set -a
. "$PP/env/memory.env"
set +a
export OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED=true
export EVAL_KERNEL_ENV='{"EVIMED_MEMORY_BRIDGE_PORT":"19365"}'
bash "$PP/bin/infra.sh" up 55685
cd /srv/evimed/wt/p10/OpenScience
exec node evals/capsule-proving/p32/product.mjs
