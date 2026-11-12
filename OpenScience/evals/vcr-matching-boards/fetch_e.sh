#!/usr/bin/env bash
# Board E: fetch the official TREC Clinical Trials snapshot zips one at a time, ingest each into the sealed index, delete the zip.
#
#   fetch_e.sh 2021 <data dir>     the 2021-04-27 snapshot (TREC CT 2021 and 2022), five zips
#   fetch_e.sh 2023 <data dir>     the 2023-05-08 snapshot (TREC CT 2023), six zips
#
# Idempotent: a zip already ingested is skipped (ingest_e.py answers from the database), a partial download resumes. A zip is
# checked against the size the server states before it is read, and every member's CRC is checked as it is read. The zip is
# deleted right after its transaction commits; free space on the data disk is checked before each fetch and stops the run
# below the floor (default 2.5 GB, MIN_FREE_GB). Nothing leaves the data directory.
set -euo pipefail
year="${1:?year 2021 or 2023}"; data="${2:?data dir}"
floor="${MIN_FREE_GB:-2.5}"
here="$(cd "$(dirname "$0")" && pwd)"
base="https://www.trec-cds.org/${year}_data"
case "$year" in
  2021) id=trec-ct-2021; snapshot=2021-04-27; names=(); for n in 1 2 3 4 5; do names+=("ClinicalTrials.2021-04-27.part$n.zip"); done; expect=375580 ;;
  2023) id=trec-ct-2023; snapshot=2023-05-08; names=(); for n in 0 1 2 3 4 5; do names+=("ClinicalTrials.2023-05-08.trials$n.zip"); done; expect=451538 ;;
  *) echo "year is 2021 or 2023" >&2; exit 2 ;;
esac
index="$data/index$year"; zips="$data/zips"; mkdir -p "$index" "$zips" "$data/tmp"
export TMPDIR="$data/tmp"
free_gb() { df -BM --output=avail "$data" | tail -1 | tr -dc 0-9 | awk '{printf "%.2f", $1/1024}'; }
for name in "${names[@]}"; do
  if [ "$(python3 -I -B - "$index/$id.sqlite" "$name" <<'PY'
import sqlite3, sys, os
path, name = sys.argv[1:]
print(0 if not os.path.exists(path) else sqlite3.connect(path).execute("SELECT count(*) FROM documents WHERE archive=?", (name,)).fetchone()[0])
PY
)" != "0" ]; then echo "$(date -u +%FT%TZ) $name already in the index"; continue; fi
  have="$(free_gb)"
  awk -v h="$have" -v f="$floor" 'BEGIN{exit !(h < f + 0.6)}' && { echo "stop: ${have} GB free, under floor ${floor} GB plus one zip" >&2; exit 3; }
  want="$(curl -sSIL --fail "$base/$name" | awk 'tolower($1)=="content-length:"{gsub("\r","",$2); n=$2} END{print n}')"
  [ -n "$want" ] || { echo "no content-length for $name" >&2; exit 4; }
  curl -sS -L -C - --fail --retry 5 --retry-delay 10 -o "$zips/$name" "$base/$name"
  got="$(stat -c %s "$zips/$name")"
  [ "$got" = "$want" ] || { echo "size mismatch for $name: $got of $want" >&2; exit 5; }
  python3 -I -B "$here/ingest_e.py" add --zip "$zips/$name" --index "$index" --id "$id" --min-free-gb "$floor"
  rm -f "$zips/$name"
  echo "$(date -u +%FT%TZ) $name ingested, zip deleted, ${have} GB free before it"
done
python3 -I -B "$here/ingest_e.py" seal --index "$index" --id "$id" --snapshot "$snapshot" --expect-docs "$expect" ${SEAL_FLAGS:-}
