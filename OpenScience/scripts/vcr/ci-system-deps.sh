#!/usr/bin/env bash
# The operating-system side of the vcr engine's CI jobs: R 4.3.3 and the
# libraries the locked R packages link against. Ubuntu 24.04 is the image
# because its own archive ships exactly the R the package locks name
# (`rVersion` in R/package-lock.json) — the development box is the same
# release — so nothing here chooses a version; it only checks the one it got.
#
# Hidden knowledge:
#
# - **The library list is Posit Package Manager's answer for the 158 locked
#   packages on Ubuntu 24.04** (its `sysreqs` API, asked once for the union of
#   both locks): libcurl and libssl for curl, libicu for stringi, libxml2 for
#   xml2, libnode for V8 (RBesT's chain), libuv and cmake for fs and
#   RcppParallel, make and pandoc for the Stan packages. Binary packages need
#   the runtime side of these and a source build needs the headers; the -dev
#   packages bring both. A package that still cannot load is named by
#   `r-library.sh verify`, which loads every one of them.
# - **`r-base-dev` is here for the packages the snapshot has no binary for.** A
#   binary is the normal case and compiling is the fallback; the fallback needs
#   a compiler and the R headers.
# - **The archive can hang, and a hung fetch has no end of its own.** On
#   2026-10-07 this step sat on one runner for 55 minutes and on another for
#   over 35 while the same step beside it took a minute; the job only ended at
#   its 90-minute limit, holding the whole run with it. Each fetch therefore
#   gives up after 30 seconds and is retried, and each apt command is given ten
#   minutes and three attempts, so a bad mirror costs minutes and says so.
set -euo pipefail

apt_fetch=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
attempt() {
  local try
  for try in 1 2 3; do
    if sudo timeout --signal=TERM --kill-after=30 600 "$@"; then return 0; fi
    echo "ci-system-deps: attempt $try of 3 did not finish: $*" >&2
    sleep $((try * 10))
  done
  return 1
}

attempt apt-get "${apt_fetch[@]}" update
attempt apt-get "${apt_fetch[@]}" install -y --no-install-recommends \
  r-base r-base-dev r-recommended \
  libcurl4-openssl-dev libssl-dev libicu-dev libxml2-dev libnode-dev libuv1-dev \
  cmake make pandoc

# The locks are for one R. An image that ships another is a different build of
# every number the numeric cases check, so it stops here, by name.
locked="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["rVersion"])' \
  "$(dirname "${BASH_SOURCE[0]}")/../../../项目代码/vcr-engine/R/package-lock.json")"
installed="$(Rscript -e 'cat(paste0(R.version$major, ".", R.version$minor))')"
if [ "$installed" != "$locked" ]; then
  echo "ci-system-deps: this image has R $installed and the engine's locks say R $locked" >&2
  exit 1
fi
echo "R $installed, as locked"
