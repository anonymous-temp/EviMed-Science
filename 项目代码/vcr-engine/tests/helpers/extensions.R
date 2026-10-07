# ---------------------------------------------------------------------------
# extensions.R — what the 2026-10-07 engine extensions add to the shared harness:
# their valid handler jobs, which E05 runs as they are and E10 breaks one field at
# a time (longitudinal virtual patients, assurance of a group-sequential design,
# single-arm simulation of continuous and time-to-event endpoints). Kept in a file
# of its own, sourced by tests/run_all.R right after robustness.R, so the streams
# that add engine methods do not edit one list.
# ---------------------------------------------------------------------------

#' One valid job for each way in to an extension, as `list(method, scenario,
#' inputs, replicates)` -- the shape `vcr_test_handler_jobs()` returns.
vcr_test_extension_handler_jobs <- function() {
  list(
    list("patients.longitudinal", list(
      design = list(nTreat = 40, nControl = 40), endpoint = list(type = "continuous"), visits = list(0, 2, 4, 6),
      truth = list(intercept = 10, slope = -0.3, effect = -0.2, sd = 1.2, randomEffects = list(sdIntercept = 2, sdSlope = 0.2, correlation = -0.2)),
      dropoutPerVisit = 0.1), NULL),
    # the assurance of a group-sequential design: 300 maximum events, three looks, a normal prior on the log hazard ratio
    list("design.assurance", list(
      design = list(kind = "group_sequential", allocation = 0.5, events = 300, informationRates = list(0.4, 0.7, 1), spending = "obrien_fleming"),
      endpoint = list(type = "time_to_event"), designPrior = list(mean = -0.3, sd = 0.15), analysis = list(alpha = 0.025, sided = 1)), NULL, 2000L),
    # single-arm trials against a benchmark: a mean (t and z analyses) and a survival time (one-sample log-rank)
    list("design.simulate", list(
      design = list(kind = "single_arm", n = 30), endpoint = list(type = "continuous"), truth = list(benchmark = 50, effect = 6, sd = 10),
      analysis = list(method = "one_sample_t", alternative = "greater", sided = 1, alpha = 0.025), performance = list("power", "bias")), NULL, 300L),
    list("design.simulate", list(
      design = list(kind = "single_arm", n = 30), endpoint = list(type = "continuous"), truth = list(effect = 0, sd = 10),
      analysis = list(method = "one_sample_z", sd = 9, alternative = "two.sided", sided = 2, alpha = 0.05)), NULL, 300L),
    list("design.simulate", list(
      design = list(kind = "single_arm", n = 40), endpoint = list(type = "time_to_event"), truth = list(controlMedian = 12, hazardRatio = 0.6),
      accrual = list(kind = "uniform", duration = 6, followup = 12, dropoutAnnual = 0.05),
      analysis = list(method = "one_sample_logrank", alternative = "less", sided = 1, alpha = 0.025), performance = list("power", "bias")), NULL, 300L),
    list("design.grid", list(
      design = list(kind = "single_arm", n = 30), endpoint = list(type = "continuous"), truth = list(effect = 0, sd = 10),
      analysis = list(method = "one_sample_t", alternative = "greater", sided = 1, alpha = 0.025), performance = list("power"),
      designs = list(list(n = 20), list(n = 40)), truths = list(list(effect = 0), list(effect = 5))), NULL, 200L)
  )
}
