#!/usr/bin/env Rscript
# One command, one line per case, one summary line. See tests/helpers/harness.R.
local({
  lib <- Sys.getenv("VCR_R_LIBS", "")
  if (nzchar(lib) && dir.exists(lib)) .libPaths(c(lib, .libPaths()))
})
VCR_ROOT <- normalizePath(Sys.getenv("VCR_ENGINE_ROOT", unset = getwd()), mustWork = TRUE)
VCR_TEST_CORES <- as.integer(Sys.getenv("VCR_TEST_CORES", "4"))
options(warn = 1)
source(file.path(VCR_ROOT, "R", "engine.R"))
vcr_engine_load(VCR_ROOT)
source(file.path(VCR_ROOT, "tests", "helpers", "harness.R"))
invisible(vcr_test_data_root())
invisible(vcr_test_apply_schema_additions(VCR_ROOT))
# Every job a case runs goes through this wrapper, so the coverage case can say
# which of the methods were actually exercised.
local({
  inner <- vcr_run_job
  vcr_run_job <<- function(job, ...) { if (is.list(job)) vcr_test_record_method(job$method); inner(job, ...) }
})
cat(sprintf("vcr-engine %s | %s | cores %d | lock %s\n\n",
            vcr_engine_version(), paste("R", getRversion()), VCR_TEST_CORES,
            substr(vcr_package_lock_hash(), 1, 12)))
files <- sort(list.files(file.path(VCR_ROOT, "tests", "numeric"), pattern = "\\.R$", full.names = TRUE))
for (f in files) source(f, local = FALSE)
ok <- vcr_case_summary()
quit(status = if (isTRUE(ok)) 0L else 1L)
