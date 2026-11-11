#!/usr/bin/env bash
set -euo pipefail
PP=/srv/evimed/pp
TREE=${SB_PRODUCT_TREE:-/srv/evimed/wt/sb/OpenScience}
export PATH="$PP/node24/bin:$PP/runtime-venv-c2/bin:$PP/judge-bin:$PATH"
export EVAL_SECRETS_DIR=/srv/evimed/secrets EVAL_DEEPSEEK_KEY_FILE=/srv/evimed/secrets/deepseek.api-key
export DSH_BIN="$PP/dsh/node_modules/.bin/dsh" EVAL_HOST_TOOL_BIN="$PP/runtime/tool-bin" EVAL_PG_BIN="$PP/pgbin"
export SB_PORT=${SB_PORT:-48848} SB_PG_PORT=${SB_PG_PORT:-55686}
export EVAL_LIVE_DIR="$PP/live/p$SB_PORT" TMPDIR="$PP/tmp/sb-$SB_PORT"
export EVAL_KERNEL_ENV="{\"EVIMED_MEMORY_BRIDGE_PORT\":\"19368\"}"
mkdir -p "$TMPDIR" "$PP/locks"
exec 8> "$PP/locks/port-$SB_PORT.lock"
flock -n 8 || exit 75
if ss -ltn "sport = :$SB_PORT" | grep -q LISTEN; then echo 'SB port is already listening'; exit 75; fi
set -a
# shellcheck disable=SC1091
. "$PP/env/memory.env"
set +a
cd "$TREE"
exec node evals/capsule-proving/sb/practice.mjs
