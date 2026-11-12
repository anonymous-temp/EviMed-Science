#!/bin/bash
# The integration wrapper, with an isolated checkout, run lock and immutable source receipt.
set -euo pipefail
RUN=$1; SET=$2; SPLIT=$3; ARM=$4; shift 4
exec 9>"/srv/evimed/runs/.p30-$RUN.lock"
flock -x 9
cd /srv/evimed/wt/p13/OpenScience
mkdir -p "/srv/evimed/runs/$RUN"
node evals/capsule-proving/experiments/pasted-tree-receipt.mjs "$RUN"
exec node evals/capsule-proving/run/run.mjs --set "$SET" --split "$SPLIT" --data /srv/evimed/data/memdata-data --out "/srv/evimed/runs/$RUN" \
 --engine-url "${ENGINE_URL:-http://127.0.0.1:19330}" --engine-key-file /srv/evimed/ovlab/root.key --database-url-file /srv/evimed/ovlab/database.url \
 --deepseek-key-file /srv/evimed/secrets/deepseek.api-key --plugin-tgz /srv/evimed/cache/dsh-memory-plugin-0.5.31.tgz --arm "$ARM" "$@"
