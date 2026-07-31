#!/usr/bin/env Rscript
# Install every R package the MR analysis needs into the vendored .r-lib beside
# this agent, which is where mr_executor puts R_LIBS_USER.
#
# .r-lib is not in the repository, so a fresh clone starts with nothing and the
# failure is confusing rather than obvious: a package present but unloadable for
# want of a dependency reports exactly like one that was never installed.
#
# Run:  Rscript install_r_packages.R
# It is idempotent — anything that already loads is left alone.

lib <- file.path(normalizePath(dirname(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[1]))), ".r-lib")
dir.create(lib, showWarnings = FALSE, recursive = TRUE)
.libPaths(c(lib, .libPaths()))
options(repos = c(CRAN = "https://cloud.r-project.org"), Ncpus = max(1L, parallel::detectCores() - 1L))

# The two-sample analysis cannot run without these.
cran_required <- c("data.table", "jsonlite", "ggplot2", "dplyr", "glmnet", "psych", "GPArotation", "mnormt")
# Named after the GitHub repository each lives in; none is on CRAN.
github_required <- c(
  TwoSampleMR = "MRCIEU/TwoSampleMR",
  ieugwasr    = "MRCIEU/ieugwasr",
  MRPRESSO    = "rondolab/MR-PRESSO",
  RadialMR    = "WSpiller/RadialMR",
  MRMix       = "gqi/MRMix",
  # Multivariable MR and the sample-overlap correction are separate analysis
  # templates; without these two those modes fail at R execution time.
  MVMR        = "WSpiller/MVMR",
  MRlap       = "n-mounier/MRlap"
)

loads <- function(pkg) isTRUE(tryCatch({ loadNamespace(pkg); TRUE }, error = function(e) FALSE))

install_missing <- function(name, installer) {
  if (loads(name)) {
    cat(sprintf("  %-14s already usable\n", name))
    return(invisible(NULL))
  }
  # A copy that is present but will not load has to go before the replacement
  # arrives: the vendored library was built against a newer R, and installing
  # over it leaves the unreadable lazy-load database in place, so the package
  # still fails afterwards and the installer still reports success.
  stale <- file.path(lib, name)
  if (dir.exists(stale)) {
    cat(sprintf("  %-14s removing unusable copy\n", name))
    unlink(stale, recursive = TRUE, force = TRUE)
  }
  cat(sprintf("  %-14s installing...\n", name))
  try(installer(), silent = FALSE)
}

cat("Installing into", lib, "\n\nCRAN packages:\n")
for (pkg in cran_required) {
  install_missing(pkg, function() install.packages(pkg, lib = lib))
}

cat("\nGitHub packages:\n")
if (!loads("remotes")) install.packages("remotes", lib = lib)
for (name in names(github_required)) {
  repo <- github_required[[name]]
  install_missing(name, function() remotes::install_github(repo, lib = lib, upgrade = "never", dependencies = TRUE))
}

# Verify rather than trust the installer's exit status: a package can install
# and still not load, which is the failure this script exists to prevent.
cat("\nVerifying:\n")
wanted <- c(cran_required, names(github_required))
broken <- character(0)
for (pkg in wanted) {
  err <- tryCatch({ loadNamespace(pkg); NULL }, error = function(e) conditionMessage(e))
  if (is.null(err)) {
    cat(sprintf("  %-14s OK\n", pkg))
  } else {
    broken <- c(broken, sprintf("%s: %s", pkg, gsub("[\r\n]+", " ", err)))
    cat(sprintf("  %-14s FAILED\n", pkg))
  }
}

if (length(broken) > 0) {
  cat("\n", length(broken), " of ", length(wanted), " packages are still unusable:\n", sep = "")
  for (line in broken) cat("  - ", line, "\n", sep = "")
  quit(status = 1)
}
cat("\nAll ", length(wanted), " R packages load.\n", sep = "")
