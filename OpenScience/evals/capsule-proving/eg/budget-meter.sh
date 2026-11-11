#!/usr/bin/env bash
set -euo pipefail
exec 8>/srv/evimed/pp/locks/eg-budget-meter.lock
flock -n 8 || exit 75
export PATH="/srv/evimed/pp/node24/bin:$PATH"
set -a
. /srv/evimed/pp/env/memory.env
set +a
cd /srv/evimed/wt/run/OpenScience
exec node evals/capsule-proving/eg/budget-meter.mjs
