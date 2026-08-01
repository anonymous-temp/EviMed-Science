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
options(repos = c(CRAN = cran), Ncpus = max(1L, parallel::detectCores() - 1L))

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
github_required <- list(
  ieugwasr    = c("MRCIEU/ieugwasr", "cc35329751ebb3d69226d3a6a238dd0cb7709a25"),
  TwoSampleMR = c("MRCIEU/TwoSampleMR", "3d119f20d6fc164b0c7f710f5590fee9580f2c7b"),
  MRPRESSO    = c("rondolab/MR-PRESSO", "3e3c92d7eda6dce0d1d66077373ec0f7ff4f7e87"),
  RadialMR    = c("WSpiller/RadialMR", "ac6093932abcd607d8bb0cd4c097447b2155fc9f"),
  # Multivariable MR and the sample-overlap correction are separate analysis
  # templates; without these two those modes fail at R execution time.
  MVMR        = c("WSpiller/MVMR", "bceaa38088d093a5d30c713afb016e7fbc7ed2be"),
  # MRlap's LDSC step calls GenomicSEM, so it is a hard dependency, not optional.
  GenomicSEM  = c("GenomicSEM/GenomicSEM", "0a63ac0ea01b61d28bd17e4a204e0fa561ce5040"),
  MRlap       = c("n-mounier/MRlap", "660f026864f8bfbbad5a8206bdff7d58f5d5d05b")
)

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
    install_missing(n, function() {
      remotes::install_url(url, lib = lib, upgrade = "never", dependencies = deps)
    })
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
# install_url records RemoteType "url" and no RemoteSha, so the revision cannot
# be read back. What can be read back is how the package arrived: anything that
# resolved MRlap's `Remotes: MRCIEU/TwoSampleMR` would have installed it from
# GitHub at HEAD, leaving RemoteType "github". That is the failure being guarded.
remote_field <- function(pkg, field) {
  tryCatch({
    description <- read.dcf(system.file("DESCRIPTION", package = pkg))
    if (field %in% colnames(description)) unname(description[1, field]) else NA_character_
  }, error = function(e) NA_character_)
}
for (pkg in names(github_required)) {
  remote_type <- remote_field(pkg, "RemoteType")
  if (identical(remote_type, "url")) {
    cat(sprintf("  %-24s from the pinned tarball\n", pkg))
  } else {
    broken <- c(broken, sprintf(
      "%s was not installed from its pinned tarball (RemoteType=%s); a transitive Remotes entry replaced it",
      pkg, remote_type))
    cat(sprintf("  %-24s PIN LOST (RemoteType=%s)\n", pkg, remote_type))
  }
}

if (length(broken) > 0) {
  cat("\n", length(broken), " problem(s):\n", sep = "")
  for (line in broken) cat("  - ", line, "\n", sep = "")
  quit(status = 1)
}
cat("\nAll ", length(wanted), " R packages load, TwoSampleMR pin intact.\n", sep = "")
