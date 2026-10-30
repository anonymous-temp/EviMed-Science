#!/usr/bin/env Rscript
# What `population.synthpop` costs in CPU seconds, by rows, columns and copies, through the engine's own job runner.
#
#   VCR_R_LIBS=/path/to/library Rscript scripts/measure-synthpop-cost.R 4000,20,5 12000,10,5 ...
#
# Each argument is `rows,columns,copies`. It builds a synthetic table of the shape an intensive-care baseline has (continuous,
# count and 0/1 columns, a person key), runs the job the control plane would queue and prints one line per table:
# `n=<rows> cols=<columns> m=<copies> status=<status> cpu=<user+system seconds>`.
#
# This is where the numbers in `OpenScience/packages/domain/src/vcrSynthesisLimits.mjs` (`VCR_SYNTHPOP_COST`) come from. Measured on
# 2026-10-31 on R 4.3.3 with the engine lock (synthpop 1.9-3), one core, CPU seconds as the kernel's RLIMIT_CPU counts them:
#
#   rows   cols  copies    cpu s        rows   cols  copies    cpu s
#    500    10     5         6.9         2000    40     5       244.4
#    500    20     5        15.0         4000    10     5        47.0
#    500    30     5        64.3         4000    20     5       103.3
#    500    40     5       186.7         4000    30     5       271.0
#    500    50     5       404.7         8000    20     5       322.7
#   1000    10     5         9.2        12000    10     5       304.2
#   1000    20     5        21.5         1000    20    10        40.8
#   1000    40     5       406.7         2000    10     5        19.1
#                                       2000    20     5        44.1
#
# A table of 12,000 rows and 40 columns is ~2,400 s by the model; this script is how to check a new host or a new lock.
local({
  lib <- Sys.getenv("VCR_R_LIBS", "")
  if (nzchar(lib) && dir.exists(lib)) .libPaths(c(lib, .libPaths()))
})
VCR_ROOT <- normalizePath(Sys.getenv("VCR_ENGINE_ROOT", unset = getwd()), mustWork = TRUE)
Sys.setenv(VCR_ENGINE_ROOT = VCR_ROOT)
options(warn = 1)
source(file.path(VCR_ROOT, "R", "engine.R"))
vcr_engine_load(VCR_ROOT)
source(file.path(VCR_ROOT, "tests", "helpers", "harness.R"))
invisible(vcr_test_data_root())
invisible(vcr_test_apply_schema_additions(VCR_ROOT))

args <- commandArgs(trailingOnly = TRUE)
if (!length(args)) stop("usage: measure-synthpop-cost.R rows,columns,copies [rows,columns,copies ...]")
cfg <- do.call(rbind, lapply(strsplit(args, ","), function(x) data.frame(n = as.integer(x[1]), p = as.integer(x[2]), m = as.integer(x[3]))))

make_table <- function(n, p, seed = 1L) {
  set.seed(seed)
  df <- data.frame(USUBJID = sprintf("R%06d", seq_len(n)), stringsAsFactors = FALSE)
  df$Age <- pmin(pmax(round(stats::rnorm(n, 65, 15)), 18), 95)
  df$Gender <- stats::rbinom(n, 1L, 0.55)
  df$ICUType <- sample(1:4, n, TRUE)
  df$Died <- stats::rbinom(n, 1L, stats::plogis(-2 + 0.03 * (df$Age - 65)))
  k <- 4L
  while (ncol(df) - 1L < p) {
    k <- k + 1L
    base <- 0.3 * (df$Age - 65) / 15 + stats::rnorm(n)
    kind <- k %% 4L
    df[[sprintf("V%03d", k)]] <- if (kind == 0L) round(exp(1 + 0.4 * base), 2) else if (kind == 1L) stats::rbinom(n, 1L, stats::plogis(base)) else if (kind == 2L) round(60 + 12 * base, 1) else stats::rpois(n, exp(0.5 + 0.3 * base))
  }
  df[, seq_len(p + 1L), drop = FALSE]
}

for (i in seq_len(nrow(cfg))) {
  n <- cfg$n[i]; p <- cfg$p[i]; m <- cfg$m[i]
  inp <- vcr_test_input(make_table(n, p), "snp_cost:subject", shape = "subject", source = "observed")
  job <- vcr_test_job("population.synthpop", list(m = as.integer(m), holdoutShare = 0.2), list(inp), seed = 11L, job_id = "job_cost")
  started <- proc.time()
  out <- tempfile("cost"); dir.create(out)
  r <- tryCatch(vcr_test_run(job, output_dir = out), error = function(e) list(status = paste("error:", conditionMessage(e))))
  spent <- proc.time() - started
  cat(sprintf("n=%d cols=%d m=%d status=%s cpu=%.1fs\n", n, p, m, r$status %||% "?", spent[["user.self"]] + spent[["sys.self"]]))
  flush.console()
}
