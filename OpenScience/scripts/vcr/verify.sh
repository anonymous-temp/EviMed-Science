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
# The engine section needs R with the module's library
# (`/home/coder/R/vcr-4.3` on the dev box, `R_LIBS_USER` anywhere else); when R
# is absent it says so and is counted as skipped, never as passed.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"
section="${1:-all}"
pass=0
fail=0
skip=0

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ran() { if [ "$1" -eq 0 ]; then pass=$((pass + 1)); printf '   \033[32mok\033[0m   %s\n' "$2"; else fail=$((fail + 1)); printf '   \033[31mFAIL\033[0m %s\n' "$2"; fi; }
skipped() { skip=$((skip + 1)); printf '   \033[33mskip\033[0m %s — %s\n' "$1" "$2"; }

# --- the domain contract ----------------------------------------------------
if [ "$section" = all ] || [ "$section" = domain ]; then
  say "domain — vocabulary, engine protocol, lineage, contracts"
  node --test packages/domain/test/vcrDomain.test.mjs >/tmp/vcr-verify-domain.log 2>&1
  ran $? "packages/domain/test/vcrDomain.test.mjs  ($(grep -c '^✔' /tmp/vcr-verify-domain.log || true) assertions)"
  # The module's words reach the platform's own registers, so the whole domain
  # suite runs too: a contract kind or tool name registered here and nowhere
  # else is the drift this suite was written to catch.
  (cd packages/domain && npm test --silent) >/tmp/vcr-verify-domain-all.log 2>&1
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
      node --test "$file" >/tmp/vcr-verify-server.log 2>&1
      ran $? "$file"
    done
  fi
  mapfile -t integration < <(ls apps/server/test/vcr*.integration.test.mjs 2>/dev/null || true)
  if [ -z "${OPEN_SCIENCE_TEST_POSTGRES_URL:-}" ]; then
    skipped "apps/server/test/vcr*.integration.test.mjs" "OPEN_SCIENCE_TEST_POSTGRES_URL is not set"
  else
    for file in "${integration[@]}"; do
      node --test "$file" >/tmp/vcr-verify-server-int.log 2>&1
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
  pnpm --filter @ai4s/web exec vitest run "${webtests[@]/#apps\/web\//}" >/tmp/vcr-verify-web.log 2>&1
  ran $? "vitest: ${#webtests[@]} files"
fi

# --- the engine -------------------------------------------------------------
if [ "$section" = all ] || [ "$section" = engine ]; then
  say "engine — N01…N22 and the C2 cases"
  runner="../项目代码/vcr-engine/tests/run_all.sh"
  if ! command -v Rscript >/dev/null 2>&1; then
    skipped "vcr-engine numeric cases" "Rscript is not on PATH"
  elif [ ! -x "$runner" ] && [ ! -f "$runner" ]; then
    ran 1 "$runner is missing — the engine's own suite did not ship"
  else
    bash "$runner" >/tmp/vcr-verify-engine.log 2>&1
    ran $? "$runner  ($(tail -1 /tmp/vcr-verify-engine.log 2>/dev/null || echo 'no summary line'))"
  fi
fi

# --- the acceptance matrix --------------------------------------------------
if [ "$section" = all ] || [ "$section" = acceptance ]; then
  say "acceptance — which of the 38 scenarios a test names"
  covered=$(grep -rho "AC-[0-9]\{2\}" apps/server/test/vcr*.test.mjs apps/web/src 2>/dev/null \
    | sort -u | tr '\n' ' ')
  engine_covered=$(grep -rho "AC-[0-9]\{2\}" ../项目代码/vcr-engine 2>/dev/null | sort -u | tr '\n' ' ')
  all_covered=$(printf '%s %s' "$covered" "$engine_covered" | tr ' ' '\n' | sort -u | grep -c "AC-" || true)
  printf '   named by a test: %s of 38\n   %s\n' "$all_covered" "$(printf '%s %s' "$covered" "$engine_covered" | tr ' ' '\n' | sort -u | tr '\n' ' ')"
  missing=""
  for n in $(seq -w 1 38); do
    printf '%s %s' "$covered" "$engine_covered" | grep -q "AC-$n" || missing="$missing AC-$n"
  done
  [ -z "$missing" ] && ran 0 "every scenario is named by a test" || printf '   \033[33mnot named:\033[0m%s\n' "$missing"
fi

printf '\n\033[1m%s passed, %s failed, %s skipped\033[0m\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
