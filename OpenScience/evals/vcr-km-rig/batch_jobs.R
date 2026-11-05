#!/usr/bin/env Rscript
# batch_jobs.R -- run many job files through the engine's own job runner in ONE R process.
#
# Usage: batch_jobs.R <list.txt>   (one job.json path per line; the result goes beside it in <job>.out/)
#
# `service/run_job.R` starts an interpreter and loads the engine for every job (about 1.5 s of which the job is a few hundredths).
# This does exactly what it does for each job -- `vcr_read_job`, `vcr_run_job`, `vcr_result_json` -- and loads the engine once.
# `rig.py` checks on a sample that the two write the same result (the run's clock aside), so the shortcut is held to the real entry.
local({ lib <- Sys.getenv("VCR_R_LIBS", ""); if (nzchar(lib)) .libPaths(c(lib, .libPaths())) })
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1L) stop("usage: batch_jobs.R <list.txt>")
root <- Sys.getenv("VCR_ENGINE_ROOT")
source(file.path(root, "R", "engine.R"))
vcr_engine_load(root)
for (path in readLines(args[1])) {
  if (!nzchar(path)) next
  out_dir <- paste0(sub("\\.json$", "", path), ".out")
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  job <- vcr_read_job(path)
  result <- vcr_run_job(job, output_dir = out_dir)
  writeLines(vcr_result_json(result), file.path(out_dir, "result.json"))
}
cat("ran", length(readLines(args[1])), "jobs\n")
