# N61 — the example trial of a simulation (remediation plan D7, 2026-11-01).
#
# design.simulate 1.3.0 states, with its operating characteristics, ONE trial of the run: the first replicate, from the run's seed.
# Replicate 1 of a seed is always the same trial, so the example is the same whatever number of replicates the run asked for; it is
# the first row of the per-replicate table the run keeps, and it is what a run of exactly one replicate at that seed computes. A
# result recorded at 1.2.0 has none and keeps the bytes it had.

.n61_scenario <- function(endpoint = "time_to_event") {
  if (identical(endpoint, "time_to_event")) {
    list(design = list(kind = "two_arm_fixed", nTreat = 80, nControl = 80), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12),
         accrual = list(kind = "uniform", duration = 12, followup = 12), analysis = list(method = "logrank", alpha = 0.025, sided = 1), performance = list("power"))
  } else {
    list(design = list(kind = "two_arm_fixed", nTreat = 60, nControl = 60), endpoint = list(type = "continuous"), truth = list(effect = 0.5, sd = 1),
         analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power"))
  }
}

vcr_case("N61a", c("AC-31", "AC-28"), function() {
  ok <- TRUE; why <- character(0)
  for (endpoint in c("time_to_event", "continuous")) {
    dir <- tempfile("n61"); dir.create(dir)
    big <- vcr_test_run(vcr_test_job("design.simulate", .n61_scenario(endpoint), seed = 4321L, replicates = 300L, cores = 1L, job_id = paste0("job_n61_big_", endpoint)), output_dir = dir)
    one <- vcr_test_run(vcr_test_job("design.simulate", .n61_scenario(endpoint), seed = 4321L, replicates = 1L, cores = 1L, job_id = paste0("job_n61_one_", endpoint)))
    other <- vcr_test_run(vcr_test_job("design.simulate", .n61_scenario(endpoint), seed = 4321L, replicates = 50L, cores = 2L, job_id = paste0("job_n61_other_", endpoint)))
    tb <- utils::read.csv(file.path(dir, "replicates.csv"))
    ex <- big$diagnostics$exampleTrial
    same <- function(a, b) identical(names(a$values), names(b$values)) && all(abs(unlist(a$values) - unlist(b$values)) < 1e-12)
    row1 <- unlist(ex$values)
    from_table <- all(abs(row1 - signif(unlist(tb[1, names(row1)]), 6)) < 1e-9)
    this <- identical(ex$replicate, 1L) && identical(ex$seed, 4321L) && same(ex, one$diagnostics$exampleTrial) && same(ex, other$diagnostics$exampleTrial) && from_table &&
      all(c("estimate", "p", "reject", "sampleSize") %in% names(ex$values)) && length(vcr_validate_result(big)) == 0L
    ok <- ok && this
    if (!this) why <- c(why, endpoint)
  }
  # a result recorded at 1.2.0 has none
  old <- vcr_test_run(vcr_test_job("design.simulate", .n61_scenario("continuous"), seed = 4321L, replicates = 100L, job_id = "job_n61_old", extra = list(methodVersion = "1.2.0")))
  ok <- ok && identical(old$status, "succeeded") && is.null(old$diagnostics$exampleTrial) && !("exampleTrial" %in% names(old$diagnostics))
  list(pass = ok, detail = sprintf("the first replicate at seed 4321 is the same trial in a 300-replicate run, a 50-replicate run on two cores and a run asked for one replicate (its floor applies), and equals the first row of the kept table (time-to-event and continuous); a 1.2.0 result has no example trial%s",
                                   if (length(why)) paste0("; failed: ", paste(why, collapse = ", ")) else ""))
})
