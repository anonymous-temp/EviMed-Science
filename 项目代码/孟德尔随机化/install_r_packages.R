#!/usr/bin/env Rscript
# Install every R package the MR analysis needs, and verify each one loads.
#
# This is the single list. The production image runs this same script, because
# keeping a second list in the Dockerfile is what let the two drift: the image
# installed three GitHub packages while the analysis templates called seven, so
# multivariable MR and the sample-overlap correction failed at R execution time
# in production while working in development.
#
# Every GitHub package is pinned to a revision. An unpinned install silently
# changes the analysis engine between builds, and MRlap's Remotes field will
# happily replace the pinned TwoSampleMR with HEAD if it is allowed to resolve.
#
# Run:  Rscript install_r_packages.R
# It is idempotent — anything that already loads is left alone.
#
# Environment:
#   R_LIB_TARGET            where to install (default: .r-lib beside this script)
#   CRAN_MIRROR             CRAN repository       (default: cloud.r-project.org)
#   GITHUB_DOWNLOAD_PREFIX  prefix for GitHub tarball URLs, for networks that
#                           cannot reach github.com directly

script_dir <- normalizePath(dirname(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[1])))
lib <- Sys.getenv("R_LIB_TARGET", unset = file.path(script_dir, ".r-lib"))
cran <- Sys.getenv("CRAN_MIRROR", unset = "https://cloud.r-project.org")
gh_prefix <- Sys.getenv("GITHUB_DOWNLOAD_PREFIX", unset = "")

dir.create(lib, showWarnings = FALSE, recursive = TRUE)
.libPaths(c(lib, .libPaths()))
# download.file defaults to a 60-second timeout, which is not enough for MRlap:
# it ships its LDSC reference data, so the tarball is over 120 MB and the
# download aborted at exactly 60s every time.
options(
  repos = c(CRAN = cran),
  Ncpus = max(1L, parallel::detectCores() - 1L),
  timeout = max(3600, getOption("timeout"))
)

# The two-sample analysis cannot run without these.
cran_required <- c(
  "data.table", "jsonlite", "ggplot2", "dplyr", "glmnet", "psych",
  "GPArotation", "mnormt",
  # Supplies mr_conmix, the contamination-mixture estimator the MOE and local
  # templates call. There is no package named MRConMix anywhere; the templates
  # used to guard on that name, so the analysis never ran in any environment.
  "MendelianRandomization"
)

# repository and revision for each; none of these is on CRAN.
#
# Order matters. TwoSampleMR declares `Remotes: ... MRPRESSO=rondolab/MR-PRESSO`,
# so installing it first makes remotes fetch MRPRESSO from GitHub HEAD, and the
# same happens to RadialMR. Installing the leaves first means the pinned copy is
# already there and nothing resolves a Remote.
github_required <- list(
  MRPRESSO    = c("rondolab/MR-PRESSO", "3e3c92d7eda6dce0d1d66077373ec0f7ff4f7e87"),
  RadialMR    = c("WSpiller/RadialMR", "ac6093932abcd607d8bb0cd4c097447b2155fc9f"),
  ieugwasr    = c("MRCIEU/ieugwasr", "cc35329751ebb3d69226d3a6a238dd0cb7709a25"),
  # Multivariable MR and the sample-overlap correction are separate analysis
  # templates; without these two those modes fail at R execution time.
  MVMR        = c("WSpiller/MVMR", "bceaa38088d093a5d30c713afb016e7fbc7ed2be"),
  TwoSampleMR = c("MRCIEU/TwoSampleMR", "3d119f20d6fc164b0c7f710f5590fee9580f2c7b"),
  # MRlap's LDSC step calls GenomicSEM, so it is a hard dependency, not optional.
  GenomicSEM  = c("GenomicSEM/GenomicSEM", "0a63ac0ea01b61d28bd17e4a204e0fa561ce5040"),
  MRlap       = c("n-mounier/MRlap", "660f026864f8bfbbad5a8206bdff7d58f5d5d05b")
)

# Which revision each GitHub package was actually installed from. remotes records
# RemoteType "url" and no RemoteSha for install_url, so the revision cannot be
# read back off the package; without this record, a copy pulled from GitHub HEAD
# as somebody else's transitive dependency is indistinguishable from the pin.
pins_file <- file.path(lib, ".evimed-r-pins")
read_pins <- function() {
  if (!file.exists(pins_file)) return(character(0))
  rows <- utils::read.table(pins_file, header = FALSE, stringsAsFactors = FALSE,
                            col.names = c("package", "revision"))
  stats::setNames(rows$revision, rows$package)
}
write_pin <- function(name, revision) {
  pins <- read_pins()
  pins[[name]] <- revision
  utils::write.table(data.frame(names(pins), unname(pins)), pins_file,
                     row.names = FALSE, col.names = FALSE, quote = FALSE)
}

# MRlap must not resolve its own Remotes: doing so reaches api.github.com, which
# some networks block, and pulls TwoSampleMR@HEAD over the pinned revision.
# Everything it imports is installed before it, so it needs nothing resolved.
github_dependencies <- list(MRlap = FALSE)

loads <- function(pkg) isTRUE(tryCatch({ loadNamespace(pkg); TRUE }, error = function(e) FALSE))

install_missing <- function(name, installer) {
  if (loads(name)) {
    cat(sprintf("  %-24s already usable\n", name))
    return(invisible(NULL))
  }
  # A copy that is present but will not load has to go before the replacement
  # arrives: the vendored library was built against a newer R, and installing
  # over it leaves the unreadable lazy-load database in place, so the package
  # still fails afterwards and the installer still reports success.
  stale <- file.path(lib, name)
  if (dir.exists(stale)) {
    cat(sprintf("  %-24s removing unusable copy\n", name))
    unlink(stale, recursive = TRUE, force = TRUE)
  }
  cat(sprintf("  %-24s installing...\n", name))
  try(installer(), silent = FALSE)
}

cat("Installing into", lib, "\nCRAN:", cran, "\n")
if (nzchar(gh_prefix)) cat("GitHub prefix:", gh_prefix, "\n")

cat("\nCRAN packages:\n")
for (pkg in cran_required) {
  local({
    p <- pkg
    install_missing(p, function() install.packages(p, lib = lib))
  })
}

cat("\nGitHub packages:\n")
if (!loads("remotes")) install.packages("remotes", lib = lib)
for (name in names(github_required)) {
  local({
    n <- name
    spec <- github_required[[n]]
    deps <- if (is.null(github_dependencies[[n]])) NA else github_dependencies[[n]]
    url <- paste0(gh_prefix, "https://github.com/", spec[1], "/archive/", spec[2], ".tar.gz")
    # "already usable" is not enough here: a copy another package dragged in from
    # HEAD loads perfectly well and is the wrong revision. Only a recorded pin
    # matching this revision means the installed copy is the one asked for.
    if (loads(n) && identical(unname(read_pins()[n]), spec[2])) {
      cat(sprintf("  %-24s already at %s\n", n, substr(spec[2], 1, 8)))
      return(invisible(NULL))
    }
    stale <- file.path(lib, n)
    if (dir.exists(stale)) {
      cat(sprintf("  %-24s replacing unpinned copy\n", n))
      unlink(stale, recursive = TRUE, force = TRUE)
    }
    cat(sprintf("  %-24s installing %s...\n", n, substr(spec[2], 1, 8)))
    ok <- tryCatch({
      remotes::install_url(url, lib = lib, upgrade = "never", dependencies = deps)
      TRUE
    }, error = function(e) {
      cat(sprintf("  %-24s install failed: %s\n", n, conditionMessage(e)))
      FALSE
    })
    if (ok && loads(n)) write_pin(n, spec[2])
  })
}

# Verify rather than trust the installer's exit status: a package can install
# and still not load, which is the failure this script exists to prevent.
cat("\nVerifying:\n")
wanted <- c(cran_required, names(github_required))
broken <- character(0)
for (pkg in wanted) {
  err <- tryCatch({ loadNamespace(pkg); NULL }, error = function(e) conditionMessage(e))
  if (is.null(err)) {
    cat(sprintf("  %-24s OK\n", pkg))
  } else {
    broken <- c(broken, sprintf("%s: %s", pkg, gsub("[\r\n]+", " ", err)))
    cat(sprintf("  %-24s FAILED\n", pkg))
  }
}

# A pin that did not survive is worse than a missing package: every name still
# reports as usable while the analysis engine quietly changed version.
#
# Every GitHub package must carry the revision it was asked for. Without this,
# TwoSampleMR's Remotes field quietly supplied MRPRESSO and RadialMR from HEAD
# and both still reported as usable.
pins <- read_pins()
for (pkg in names(github_required)) {
  wanted <- github_required[[pkg]][2]
  actual <- unname(pins[pkg])
  if (identical(actual, wanted)) {
    cat(sprintf("  %-24s pinned at %s\n", pkg, substr(wanted, 1, 8)))
  } else {
    broken <- c(broken, sprintf("%s is at %s, not the pinned %s",
                                pkg, if (is.na(actual)) "an unrecorded revision" else actual, wanted))
    cat(sprintf("  %-24s PIN LOST\n", pkg))
  }
}

if (length(broken) > 0) {
  cat("\n", length(broken), " problem(s):\n", sep = "")
  for (line in broken) cat("  - ", line, "\n", sep = "")
  quit(status = 1)
}
cat("\nAll ", length(wanted), " R packages load, TwoSampleMR pin intact.\n", sep = "")
