#!/usr/bin/env bash
# Run every numeric acceptance case. One line per case, `PASSED x/y` last.
#
#   tests/run_all.sh              # all cases
#   VCR_TEST_ONLY=N0 tests/run_all.sh   # only cases whose id matches the regex
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export VCR_ENGINE_ROOT="$ROOT"
export VCR_R_LIBS="${VCR_R_LIBS:-/home/coder/R/vcr-4.3}"
export VCR_TEST_CORES="${VCR_TEST_CORES:-4}"
exec Rscript "$ROOT/tests/run_all.R" "$@"
