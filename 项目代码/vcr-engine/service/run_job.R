#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# run_job.R — run one job in its own process.
#
# Hidden knowledge: the HTTP service does not run R in-process. A job gets its
# own process so that (a) a CPU rlimit can be applied to it and nothing else,
# (b) a cancel is a signal to a pid rather than a cooperative flag the R code
# might be too busy to read, and (c) a segfault in a numerical library kills
# the job and not the queue. The price is a ~0.4 s interpreter start per job,
# which is noise next to any real simulation.
#
# Usage: run_job.R <job.json> <output-dir>
# Writes: <output-dir>/result.json, progress.json, and any result tables.
# Reads:  <output-dir>/CANCEL as the cancellation signal.
# ---------------------------------------------------------------------------

local({
  lib <- Sys.getenv("VCR_R_LIBS", "")
  if (nzchar(lib)) .libPaths(c(lib, .libPaths()))
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2L) { cat("usage: run_job.R <job.json> <output-dir>\n"); quit(status = 2L) }
job_path <- args[1]; out_dir <- args[2]
root <- Sys.getenv("VCR_ENGINE_ROOT", unset = dirname(dirname(normalizePath(job_path, mustWork = FALSE))))
if (!file.exists(file.path(root, "R", "engine.R"))) {
  root <- normalizePath(file.path(dirname(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[1])), ".."), mustWork = FALSE)
}
source(file.path(root, "R", "engine.R"))
vcr_engine_load(root)

dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
job <- jsonlite::fromJSON(job_path, simplifyVector = TRUE, simplifyDataFrame = FALSE)
cancel_file <- file.path(out_dir, "CANCEL")
progress_path <- file.path(out_dir, "progress.json")

write_progress <- function(done, total) {
  tmp <- paste0(progress_path, ".tmp")
  writeLines(jsonlite::toJSON(list(done = done, total = total,
                                   cpuSeconds = round(sum(proc.time()[c("user.self", "sys.self", "user.child", "sys.child")], na.rm = TRUE), 3)),
                              auto_unbox = TRUE), tmp)
  invisible(file.rename(tmp, progress_path))
}
write_progress(0, job$replicates %||% 1)

result <- vcr_run_job(job, output_dir = out_dir, cancel_file = cancel_file, progress = write_progress)

tmp <- file.path(out_dir, "result.json.tmp")
# `digits = NA` asks jsonlite for full round-trip precision. Without it every
# number in the result is silently rounded to four significant digits, which
# is invisible in a page and fatal in a cross-software comparison.
writeLines(jsonlite::toJSON(result, auto_unbox = TRUE, digits = NA, null = "null", na = "null"), tmp)
invisible(file.rename(tmp, file.path(out_dir, "result.json")))
quit(status = if (identical(result$status, "failed")) 1L else 0L)
