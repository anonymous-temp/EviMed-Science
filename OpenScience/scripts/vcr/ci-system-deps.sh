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
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
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
