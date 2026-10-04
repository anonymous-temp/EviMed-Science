#!/usr/bin/env bash
# Read the log of a full `tests/run_all.sh` run and say whether it is a green
# run or only looks like one.
#
#   scripts/vcr/check-numeric-log.sh <log>
#
# Hidden knowledge: `run_all.sh` exits 0 for a run in which every case that
# ran passed, and a case that could not do its job is allowed to say so and
# pass — `skipped: node or the domain source is not here` is a PASS line. On
# the machine the cases were written on that is a courtesy; in CI it is how a
# missing Node turns the protocol-agreement cases (N00, N23, N26), the ones that
# make every other number meaningful, into green lines that checked nothing.
# So a full run is refused when
#
#   - the last line is not `PASSED k/k` (a cut-short run, a filtered run, a
#     failing case), or
#   - fewer cases ran than the suite declares (each `vcr_case(` at the start of
#     a line in tests/numeric/*.R runs once; a case that never reported was
#     filtered out or never sourced), or
#   - any case reported `| skipped:`.
#
# Environment: VCR_ENGINE_ROOT (default: 项目代码/vcr-engine beside OpenScience).
set -euo pipefail

log="${1:?usage: check-numeric-log.sh <log>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="${VCR_ENGINE_ROOT:-$here/../../../项目代码/vcr-engine}"
[ -f "$log" ] || { echo "check-numeric-log: no log at $log" >&2; exit 1; }
[ -d "$engine/tests/numeric" ] || { echo "check-numeric-log: no numeric cases under $engine" >&2; exit 1; }

# Cases the suite declares. The walk has to have walked: zero would make the
# floor below vacuous.
declared=0
for file in "$engine"/tests/numeric/*.R; do
  count="$(grep -c '^vcr_case(' "$file" || true)"
  declared=$((declared + count))
done
if [ "$declared" -eq 0 ]; then
  echo "check-numeric-log: no vcr_case( found under $engine/tests/numeric — the scan read nothing" >&2
  exit 1
fi

summary="$(grep -E '^PASSED [0-9]+/[0-9]+$' "$log" | tail -n 1 || true)"
if [ -z "$summary" ]; then
  echo "check-numeric-log: the log has no 'PASSED k/n' line — the run did not finish" >&2
  exit 1
fi
passed="${summary#PASSED }"; passed="${passed%%/*}"
ran="${summary##*/}"
if [ "$passed" -ne "$ran" ]; then
  echo "check-numeric-log: $summary — $((ran - passed)) case(s) failed" >&2
  exit 1
fi
if [ "$ran" -lt "$declared" ]; then
  echo "check-numeric-log: $ran case(s) ran and the suite declares $declared — some never reported" >&2
  exit 1
fi
skipped="$(grep -E '^[^ ]+ +PASS .*\| skipped:' "$log" || true)"
if [ -n "$skipped" ]; then
  echo "check-numeric-log: cases that skipped themselves and passed, which proves nothing:" >&2
  echo "$skipped" | cut -c1-200 >&2
  exit 1
fi
# The method-evidence importer (`scripts/ops/import-vcr-method-validation.mjs`) refuses a report in which any
# case's detail says skip, skipped or skipping, whatever the word was about: N42 said a text column was
# "skipped" and the whole release's evidence could not be imported (2026-10-04). Refused here, where the
# case's author sees it, with the same pattern.
worded="$(grep -E '^[^ ]+ +PASS ' "$log" | grep -iwE 'skip|skipped|skipping' || true)"
if [ -n "$worded" ]; then
  echo "check-numeric-log: a passing case's detail uses the word the evidence importer reads as a skipped case; say it another way:" >&2
  echo "$worded" | cut -c1-200 >&2
  exit 1
fi
echo "check-numeric-log: $summary, $declared declared, none skipped"
