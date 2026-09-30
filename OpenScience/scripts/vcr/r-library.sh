#!/usr/bin/env bash
# The vcr engine's R library, made from its two package locks and proven equal
# to them (integration contract 2026-09-29, wave C; the engine Dockerfile does
# the same for the image).
#
#   VCR_R_LIBS=/path/to/library scripts/vcr/r-library.sh install   # install what is missing, then verify
#   VCR_R_LIBS=/path/to/library scripts/vcr/r-library.sh verify     # read-only: is the library exactly the locks?
#   scripts/vcr/r-library.sh key                                    # the name a cached copy of the library goes by
#
# Hidden knowledge:
#
# - **The locks are the only list.** `R/package-lock.json` (what the engine needs
#   at run time) and `tests/package-lock.crosscheck.json` (what the numeric cases
#   check it against) each name every package at an exact version, the whole
#   dependency closure included. A library passes when every listed package is
#   installed at exactly that version, nothing else is in it, every listed
#   package loads, and every base or recommended package comes from R itself and
#   not from a shadowing copy. A lock nobody checks is a comment.
# - **The versions come from the dated CRAN snapshot the image is built from.**
#   The date is read from the Dockerfile's `ARG CRAN_SNAPSHOT_DATE`, so a CI run
#   can never install from another date than the image. On Ubuntu the snapshot is
#   asked for through Posit Package Manager's binary URL (`__linux__/<codename>`)
#   with the R version in the user agent, which serves the same versions as
#   binaries where it has them and as source where it does not — hours of
#   compiling saved, nothing about the versions changed, and the check below
#   does not care how a package got there.
# - **No default path.** `VCR_R_LIBS` names the library and there is no fallback:
#   a path baked into a script is a machine's, and on a machine that is not that
#   one it silently checks nothing.
# - **A package that installed but does not load is not installed.** A cached
#   library restored onto a runner whose system libraries moved on looks
#   complete and is not; loading every listed package finds it.
# - **The cache key is the inputs, not a date.** `key` hashes the locks, the
#   snapshot date, this script and the system-library script, plus the operating
#   system release: change any of them and the library is rebuilt, change none
#   and it is reused. Reuse is safe because `verify` runs after every restore.
#
# Environment:
#   VCR_R_LIBS         the library directory (required)
#   VCR_R_LOCKS        `both` (default: runtime + cross-check) or `runtime`
#   VCR_ENGINE_ROOT    the engine directory (default: 项目代码/vcr-engine beside OpenScience)
#   VCR_CRAN_REPO      the repository to install from (default: derived, see above)
#   VCR_R_BUILD_NCPUS  parallel installs (default: the CPU count)
set -euo pipefail

command_name="${1:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="${VCR_ENGINE_ROOT:-$here/../../../项目代码/vcr-engine}"

usage() { echo "usage: VCR_R_LIBS=<library> $0 install|verify   or   $0 key" >&2; exit 2; }
[ "$command_name" = install ] || [ "$command_name" = verify ] || [ "$command_name" = key ] || usage
if [ "$command_name" != key ]; then
  : "${VCR_R_LIBS:?VCR_R_LIBS must name the R library directory; there is no default}"
  command -v Rscript >/dev/null 2>&1 || { echo "r-library: Rscript is not on PATH" >&2; exit 1; }
fi
command -v python3 >/dev/null 2>&1 || { echo "r-library: python3 is not on PATH" >&2; exit 1; }
[ -d "$engine/R" ] || { echo "r-library: $engine is not the vcr engine directory" >&2; exit 1; }

locks=("$engine/R/package-lock.json")
case "${VCR_R_LOCKS:-both}" in
  both) locks+=("$engine/tests/package-lock.crosscheck.json") ;;
  runtime) ;;
  *) echo "r-library: VCR_R_LOCKS is both or runtime" >&2; exit 2 ;;
esac

if [ "$command_name" = key ]; then
  system="unknown"
  if [ -r /etc/os-release ]; then system="$(. /etc/os-release && echo "${ID:-unknown}-${VERSION_ID:-0}")"; fi
  hash="$({
    cat "${locks[@]}"
    sed -n 's/^ARG CRAN_SNAPSHOT_DATE=.*/&/p' "$engine/Dockerfile" | head -n 1
    cat "$here/r-library.sh" "$here/ci-system-deps.sh"
  } | sha256sum | cut -c1-40)"
  echo "vcr-rlib-$system-$hash"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
want="$work/want.tsv"

# The locks, checked for shape and flattened: the R version, then one
# "package<TAB>version" line each. Same rules as the Dockerfile's.
python3 - "$want" "${locks[@]}" <<'PY'
import json, sys
out, paths = sys.argv[1], sys.argv[2:]
locks = [json.load(open(path, encoding="utf-8")) for path in paths]
entry_ok = lambda e: isinstance(e, dict) and set(e) == {"package", "version"} and all(isinstance(v, str) and v for v in e.values())
shape_ok = all(isinstance(l, dict) and set(l) == {"rVersion", "packages"} and isinstance(l["packages"], list) and all(map(entry_ok, l["packages"])) for l in locks)
shape_ok or sys.exit("a lock holds exactly rVersion and packages, each entry exactly package and version")
versions = {l["rVersion"] for l in locks}
len(versions) == 1 or sys.exit("the locks name different R versions")
names = [e["package"] for l in locks for e in l["packages"]]
len(names) == len(set(names)) or sys.exit("a package is listed twice across the locks")
with open(out, "w", encoding="utf-8") as handle:
    handle.write(versions.pop() + "\n")
    for l in locks:
        for e in l["packages"]:
            handle.write(e["package"] + "\t" + e["version"] + "\n")
PY
export VCR_LOCK_TSV="$want"

# Read-only: what is wrong with the library, one line each, or nothing.
# `problems()` is shared by verify and by install's decision about what to install.
r_common='
site <- Sys.getenv("VCR_R_LIBS")
lines <- readLines(Sys.getenv("VCR_LOCK_TSV"))
want <- do.call(rbind, strsplit(lines[-1], "\t", fixed = TRUE))
shipped <- rownames(installed.packages(lib.loc = .Library, priority = c("base", "recommended")))
clash <- intersect(want[, 1], shipped)
if (length(clash)) stop("a lock lists packages that ship with R: ", paste(clash, collapse = ", "))
have <- function() {
  if (!dir.exists(site)) return(setNames(character(0), character(0)))
  installed.packages(lib.loc = site)[, "Version"]
}
'

verify() {
  Rscript --no-init-file -e "
$r_common
if (!dir.exists(site)) stop('the library directory does not exist: ', site)
site <- normalizePath(site)
.libPaths(c(site, .libPaths()))
wantR <- lines[1]
gotR <- paste0(R.version\$major, '.', R.version\$minor)
if (!identical(gotR, wantR)) stop('R is ', gotR, ' and the locks say ', wantR)
inst <- have()
got <- unname(inst[want[, 1]])
differs <- !is.na(got) & got != want[, 2]
from <- function(p) normalizePath(dirname(find.package(p)))
astray <- c(Filter(function(p) from(p) != site, want[!is.na(got), 1]),
            Filter(function(p) from(p) != normalizePath(.Library), shipped))
unloadable <- character(0)
for (p in want[!is.na(got) & !differs, 1]) {
  ok <- tryCatch({ suppressPackageStartupMessages(loadNamespace(p)); TRUE }, error = function(e) conditionMessage(e))
  if (!isTRUE(ok)) unloadable <- c(unloadable, sprintf('%s does not load: %s', p, substr(gsub('\\\\s+', ' ', ok), 1, 200)))
}
bad <- c(sprintf('%s missing', want[is.na(got), 1]),
         sprintf('%s is %s, lock says %s', want[differs, 1], got[differs], want[differs, 2]),
         sprintf('%s is installed but no lock lists it', setdiff(names(inst), want[, 1])),
         sprintf('%s would load from %s', astray, vapply(astray, from, '')),
         unloadable)
if (length(bad)) stop('package lock mismatch:\n', paste(bad, collapse = '\n'), call. = FALSE)
cat('package lock verified:', nrow(want), 'packages, R', gotR, 'in', site, '\n')
"
}

install_missing() {
  local repo="${VCR_CRAN_REPO:-}"
  if [ -z "$repo" ]; then
    local date
    date="$(sed -n 's/^ARG CRAN_SNAPSHOT_DATE=//p' "$engine/Dockerfile" | head -n 1)"
    [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "r-library: no CRAN_SNAPSHOT_DATE in $engine/Dockerfile" >&2; exit 1; }
    local id="" codename=""
    if [ -r /etc/os-release ]; then
      id="$(. /etc/os-release && echo "${ID:-}")"
      codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
    fi
    if [ "$id" = ubuntu ] && [ -n "$codename" ]; then
      repo="https://packagemanager.posit.co/cran/__linux__/$codename/$date"
    else
      repo="https://packagemanager.posit.co/cran/$date"
    fi
  fi
  echo "r-library: installing from $repo into $VCR_R_LIBS" >&2
  mkdir -p "$VCR_R_LIBS"
  VCR_CRAN_REPO="$repo" VCR_R_BUILD_NCPUS="${VCR_R_BUILD_NCPUS:-$(nproc 2>/dev/null || echo 2)}" Rscript --no-init-file -e "
$r_common
site <- normalizePath(site)
.libPaths(c(site, .libPaths()))
inst <- have()
got <- unname(inst[want[, 1]])
# What has to be (re)installed: missing, at another version, or installed but
# not loading. A package a lock lists that loads and is at its version is left alone.
todo <- want[is.na(got) | got != want[, 2], 1]
for (p in setdiff(want[!is.na(got) & got == want[, 2], 1], todo)) {
  ok <- tryCatch({ suppressPackageStartupMessages(loadNamespace(p)); TRUE }, error = function(e) FALSE)
  if (!isTRUE(ok)) todo <- c(todo, p)
}
if (!length(todo)) { cat('nothing to install\n'); quit(status = 0) }
cat('installing', length(todo), 'of', nrow(want), 'packages\n')
# The user agent is how the repository knows which R to build binaries for.
options(HTTPUserAgent = sprintf('R/%s R (%s)', getRversion(), paste(getRversion(), R.version[['platform']], R.version[['arch']], R.version[['os']])))
install.packages(todo, lib = site, repos = c(CRAN = Sys.getenv('VCR_CRAN_REPO')), type = 'source',
                 dependencies = NA, Ncpus = as.integer(Sys.getenv('VCR_R_BUILD_NCPUS', '2')))
"
}

if [ "$command_name" = install ]; then
  install_missing
fi
# install.packages only warns about a package that failed: this is the gate.
verify
