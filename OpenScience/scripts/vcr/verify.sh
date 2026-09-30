#!/usr/bin/env bash
# Everything 「虚拟临研」 can be checked by, in one command.
#
# Hidden knowledge: this script discovers its own work rather than listing it.
# Seven work packages wrote these tests in parallel, and a hand-kept list would
# have been wrong the day after the build — the failure mode a walk assertion
# exists to prevent (`walk-assertions-must-prove-they-walked`). So it globs,
# and it fails when a glob finds nothing, because an empty suite that reports
# success is worse than a red one.
#
#   scripts/vcr/verify.sh            # everything
#   scripts/vcr/verify.sh domain     # one section: domain | server | web | engine | acceptance
#
# The engine section needs R with the engine's library (`VCR_R_LIBS`; there is no
# default path — see `scripts/vcr/r-library.sh`). The server section's
# integration tests need `OPEN_SCIENCE_TEST_POSTGRES_URL`. Without them a
# section says so and is counted as skipped, never as passed; with
# `VCR_ENGINE_TESTS=required` (what CI sets) a section that would skip fails
# instead, because a green run that skipped is a green run that proved nothing.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"
section="${1:-all}"
pass=0
fail=0
skip=0
logs="$(mktemp -d)"
trap 'rm -rf "$logs"' EXIT

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ran() { if [ "$1" -eq 0 ]; then pass=$((pass + 1)); printf '   \033[32mok\033[0m   %s\n' "$2"; else fail=$((fail + 1)); printf '   \033[31mFAIL\033[0m %s\n' "$2"; fi; }
skipped() {
  if [ "${VCR_ENGINE_TESTS:-}" = required ]; then
    ran 1 "$1 — $2 (VCR_ENGINE_TESTS=required: this is a failure, not a skip)"
  else
    skip=$((skip + 1)); printf '   \033[33mskip\033[0m %s — %s\n' "$1" "$2"
  fi
}

# --- the domain contract ----------------------------------------------------
if [ "$section" = all ] || [ "$section" = domain ]; then
  say "domain — vocabulary, engine protocol, lineage, contracts"
  node --test packages/domain/test/vcrDomain.test.mjs >"$logs/domain.log" 2>&1
  ran $? "packages/domain/test/vcrDomain.test.mjs  ($(grep -c '^✔' "$logs/domain.log" || true) assertions)"
  # The module's words reach the platform's own registers, so the whole domain
  # suite runs too: a contract kind or tool name registered here and nowhere
  # else is the drift this suite was written to catch.
  (cd packages/domain && npm test --silent) >"$logs/domain-all.log" 2>&1
  ran $? "packages/domain (whole suite)"
fi

# --- the control plane ------------------------------------------------------
if [ "$section" = all ] || [ "$section" = server ]; then
  say "control plane — data plane, access, evidence, orchestration, matching"
  mapfile -t unit < <(ls apps/server/test/vcr*.test.mjs 2>/dev/null | grep -v integration || true)
  if [ "${#unit[@]}" -eq 0 ]; then
    ran 1 "no apps/server/test/vcr*.test.mjs found — the glob walked an empty tree"
  else
    for file in "${unit[@]}"; do
      node --test "$file" >"$logs/server.log" 2>&1
      ran $? "$file"
    done
  fi
  mapfile -t integration < <(ls apps/server/test/vcr*.integration.test.mjs 2>/dev/null || true)
  if [ "${#integration[@]}" -eq 0 ]; then
    ran 1 "no apps/server/test/vcr*.integration.test.mjs found — the glob walked an empty tree"
  elif [ -z "${OPEN_SCIENCE_TEST_POSTGRES_URL:-}" ]; then
    skipped "apps/server/test/vcr*.integration.test.mjs" "OPEN_SCIENCE_TEST_POSTGRES_URL is not set"
  else
    for file in "${integration[@]}"; do
      # One at a time: the shared test database deadlocks under parallel files.
      node --test --test-concurrency=1 "$file" >"$logs/server-int.log" 2>&1
      ran $? "$file"
    done
  fi
fi

# --- the browser ------------------------------------------------------------
if [ "$section" = all ] || [ "$section" = web ]; then
  say "browser — sidebar, routes, home, study page"
  mapfile -t webtests < <(find apps/web/src -name "*.test.tsx" \( -path "*vcr*" -o -path "*virtual-research*" \) 2>/dev/null || true)
  webtests+=("apps/web/src/components/sidebar/Sidebar.test.tsx" "apps/web/src/app/router.test.tsx")
  if [ "${#webtests[@]}" -eq 2 ]; then
    printf '   \033[33mnote\033[0m only the two shared suites were found under apps/web/src\n'
  fi
  pnpm --filter @ai4s/web exec vitest run "${webtests[@]/#apps\/web\//}" >"$logs/web.log" 2>&1
  ran $? "vitest: ${#webtests[@]} files"
fi

# --- the engine -------------------------------------------------------------
if [ "$section" = all ] || [ "$section" = engine ]; then
  say "engine — the R library, then N01…N30, E01…E10, C2 and S01"
  runner="../项目代码/vcr-engine/tests/run_all.sh"
  if ! command -v Rscript >/dev/null 2>&1; then
    skipped "vcr-engine numeric cases" "Rscript is not on PATH"
  elif [ -z "${VCR_R_LIBS:-}" ]; then
    skipped "vcr-engine numeric cases" "VCR_R_LIBS is not set (there is no default library path)"
  elif [ ! -f "$runner" ]; then
    ran 1 "$runner is missing — the engine's own suite did not ship"
  else
    bash scripts/vcr/r-library.sh verify >"$logs/library.log" 2>&1
    ran $? "the R library is exactly the engine's locks  ($(tail -1 "$logs/library.log" 2>/dev/null))"
    bash "$runner" >"$logs/engine.log" 2>&1
    ran $? "$runner  ($(tail -1 "$logs/engine.log" 2>/dev/null || echo 'no summary line'))"
    bash scripts/vcr/check-numeric-log.sh "$logs/engine.log" >"$logs/engine-check.log" 2>&1
    ran $? "the run was whole  ($(tail -1 "$logs/engine-check.log" 2>/dev/null))"
  fi
fi

# --- the acceptance matrix --------------------------------------------------
if [ "$section" = all ] || [ "$section" = acceptance ]; then
  say "acceptance — which of the 38 scenarios a test title names"
  # One rule, in one place: the test reads titles, not comments, and is the
  # matrix's own gate. This section used to grep for "AC-nn" anywhere, which
  # counted a comment as coverage.
  node --test apps/server/test/vcrAcceptance.test.mjs >"$logs/acceptance.log" 2>&1
  ran $? "apps/server/test/vcrAcceptance.test.mjs  ($(grep -c '^✔' "$logs/acceptance.log" || true) checks)"
  grep -E '^\s+\+\s+.AC-[0-9]{2}.' "$logs/acceptance.log" | sed -E 's/^\s+\+\s+/   not named: /' || true
fi

printf '\n\033[1m%s passed, %s failed, %s skipped\033[0m\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
