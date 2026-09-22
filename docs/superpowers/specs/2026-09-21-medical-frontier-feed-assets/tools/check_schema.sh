#!/usr/bin/env bash
# Applies frontier-schema.sql twice (idempotence) to a scratch database on a local PostgreSQL 16 with pgvector and
# pg_trgm, runs a few representative queries with EXPLAIN, then drops the database.
# Usage: PGBIN=<dir with psql> PGPORT=55433 PGHOST=127.0.0.1 ./check_schema.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; bin="${PGBIN:-$(cat "$HOME/.cache/evimed-pg/BIN")}"
export PGOPTIONS="-c client_min_messages=warning" PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-55433}" PGUSER="${PGUSER:-postgres}"
db="frontier_schema_check_$$"
"$bin/psql" -qAt -d postgres -c "CREATE DATABASE $db"
trap '"$bin/psql" -qAt -d postgres -c "DROP DATABASE IF EXISTS $db"' EXIT
p() { "$bin/psql" -v ON_ERROR_STOP=1 -qAt -d "$db" "$@"; }
p -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE SCHEMA evimed_control; CREATE TABLE evimed_control.users (id text PRIMARY KEY);"
schema="$here/frontier-schema.sql"
if [ "$(p -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_trgm'")" = "1" ]; then p -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
else  # what the migration does where the extension is missing: skip the trigram index, keep everything else
  echo "pg_trgm not available here: trigram index skipped"; schema="$(mktemp)"
  python3 - "$here/frontier-schema.sql" > "$schema" <<'PY'
import re, sys
print(re.sub(r"CREATE INDEX IF NOT EXISTS frontier_items_title_trgm_idx.*?gin_trgm_ops\);", "", open(sys.argv[1]).read(), flags=re.S))
PY
fi
if [ "$(p -c "SELECT (string_to_array(default_version, '.'))[2]::int >= 7 OR (string_to_array(default_version, '.'))[1]::int > 0 FROM pg_available_extensions WHERE name = 'vector'")" != "t" ]; then
  # pgvector < 0.7 has no halfvec: the migration falls back to vector(1024), exactly as this does
  echo "pgvector < 0.7 here: halfvec replaced by vector"; alt="$(mktemp)"; sed -e 's/halfvec_cosine_ops/vector_cosine_ops/' -e 's/halfvec(1024)/vector(1024)/' "$schema" > "$alt"; schema="$alt"
  smoke="$(mktemp)"; sed -e 's/halfvec(1024)/vector(1024)/' "$here/frontier-schema-smoke.sql" > "$smoke"
fi
p -f "$schema"; p -f "$schema"   # second run must be a no-op
p -c "SELECT 'tables: ' || count(*) FROM information_schema.tables WHERE table_schema = 'evimed_frontier';
      SELECT 'indexes: ' || count(*) FROM pg_indexes WHERE schemaname = 'evimed_frontier';"
p -f "${smoke:-$here/frontier-schema-smoke.sql}"
echo "schema ok"
