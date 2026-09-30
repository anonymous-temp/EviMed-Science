#!/usr/bin/env bash
# Run every numeric acceptance case. One line per case, `PASSED x/y` last.
#
#   tests/run_all.sh              # all cases
#   VCR_TEST_ONLY=N0 tests/run_all.sh   # only cases whose id matches the regex
#   VCR_R_LIBS=/path/to/library tests/run_all.sh   # when the library is not R's own
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export VCR_ENGINE_ROOT="$ROOT"
# VCR_R_LIBS names the R library when it is not R's own; there is no default path.
if [ -n "${VCR_R_LIBS:-}" ]; then export VCR_R_LIBS; fi
export VCR_TEST_CORES="${VCR_TEST_CORES:-4}"
exec Rscript "$ROOT/tests/run_all.R" "$@"
