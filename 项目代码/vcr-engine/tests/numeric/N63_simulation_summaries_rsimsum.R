# N63 — the Monte-Carlo summaries of a simulation against rsimsum (algorithm round G4, 2026-11-03).
#
# Every simulated number the engine reports carries a Monte-Carlo standard error, and those formulas are the engine's own
# (`vcr_summarize_replicates` in R/design_simulate.R): sqrt(p (1 - p) / n) for a proportion (power, type I error, coverage),
# sd / sqrt(n) for the bias, sd / sqrt(2 (n - 1)) for the empirical standard error and sd((estimate - truth)^2) / sqrt(n) for the mean
# squared error. `rsimsum::simsum` (Gasparini 2018) is an independent implementation of the same ADEMP summaries, so it is the check:
# the case runs a real `design.simulate` job, takes from the engine the very replicate table the job summarised (a wrapper around
# `vcr_summarize_replicates`, put back afterwards), gives rsimsum that table with the true value, and compares each measure and its
# Monte-Carlo error with the job's own.
#
# Hidden knowledge: the comparison is like for like only when every replicate produced an estimate. The engine counts a failed
# replicate as "did not reject / did not cover" over all replicates (CE-27) and rsimsum drops a missing estimate, so the case requires
# a complete table and says how many replicates it was.

.n63_summaries <- function(tag, sc, seed, replicates, truth, names_, df = NULL) {
  captured <- NULL
  inner <- get("vcr_summarize_replicates", envir = globalenv())
  assign("vcr_summarize_replicates", function(values, estimand, scenario, done) {
    captured <<- values
    inner(values, estimand, scenario, done)
  }, envir = globalenv())
  on.exit(assign("vcr_summarize_replicates", inner, envir = globalenv()), add = TRUE)
  job <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = seed, replicates = replicates, cores = VCR_TEST_CORES, job_id = paste0("job_n63_", tag)))
  values <- as.data.frame(captured)
  # rsimsum builds the interval and the test from the estimate, its standard error and, for a t distribution, the degrees of freedom
  # (normal when it is given none: the interval takes them from a column `df`, the power from `control$power_df`, and it takes either
  # these or the interval limits, not both): the pooled t-test hands them over, the log-rank's z needs none. Coverage and power then
  # agree with the engine's only if the engine's intervals and test are the same ones, which is what the comparison asks.
  if (!is.null(df)) values$dof <- df
  sim <- rsimsum::simsum(data = values, estvarname = "estimate", se = "se", true = truth, df = if (is.null(df)) NULL else "dof",
                         control = if (is.null(df)) list() else list(power_df = df))
  pkg <- as.data.frame(sim$summ)
  get_pkg <- function(stat) pkg[pkg$stat == stat, c("est", "mcse")]
  # the engine's measure name and rsimsum's statistic
  pairs <- c(power = "power", type_one_error = "power", bias = "bias", empirical_se = "empse", mse = "mse", coverage = "cover")
  rows <- lapply(intersect(names_, names(pairs)), function(name) {
    m <- vcr_get_measure(job, name); ref <- get_pkg(pairs[[name]])
    list(name = name, value = m$value, mcse = m$mcse, ref = ref$est, ref_mcse = ref$mcse,
         dv = abs(m$value - ref$est), dm = abs(m$mcse - ref$mcse))
  })
  list(status = job$status, n = nrow(values), complete = all(is.finite(values$estimate)) && all(is.finite(values$ci_low)) && all(is.finite(values$ci_high)),
       rows = rows, worst = max(vapply(rows, function(r) max(r$dv, r$dm), numeric(1))),
       text = paste(vapply(rows, function(r) sprintf("%s %.5f (mcse %.5f) vs %.5f (%.5f)", r$name, r$value, r$mcse, r$ref, r$ref_mcse), character(1)), collapse = "; "))
}

vcr_case("N63", c("AC-28", "AC-30"), function() {
  if (!requireNamespace("rsimsum", quietly = TRUE)) stop("N63 requires the locked rsimsum library")
  # (1) a continuous endpoint with a known effect of 0.4, two-sided t-test at 0.05: power, bias, empirical SE, mean squared error and
  # coverage; (2) the same design under the null (effect 0), where the measure is the type I error and rsimsum calls it power at the
  # true value 0; (3) a time-to-event endpoint with a hazard ratio of 0.7 and the log-rank test, whose estimand is the log hazard ratio.
  # A two-sided test rejects exactly when its interval excludes 0, which is how rsimsum defines power from interval limits.
  base <- list(design = list(kind = "two_arm_fixed", nTreat = 40, nControl = 40), endpoint = list(type = "continuous"),
               analysis = list(method = "ttest", alpha = 0.05, sided = 2), performance = list("power", "type_one_error", "bias", "coverage"),
               truth = list(effect = 0.4, sd = 1))
  alt <- .n63_summaries("alt", base, 6363L, 5000L, 0.4, c("power", "bias", "empirical_se", "mse", "coverage"), df = 78)
  null <- .n63_summaries("null", utils::modifyList(base, list(truth = list(effect = 0, sd = 1))), 6364L, 20000L, 0, c("type_one_error", "bias", "coverage"), df = 78)
  tte_sc <- list(design = list(kind = "two_arm_fixed", nTreat = 150, nControl = 150), endpoint = list(type = "time_to_event"),
                 analysis = list(method = "logrank", alpha = 0.05, sided = 2), performance = list("power", "bias", "coverage"),
                 truth = list(hazardRatio = 0.7, controlMedian = 12), accrual = list(kind = "uniform", duration = 12, followup = 18))
  tte <- .n63_summaries("tte", tte_sc, 6365L, 5000L, log(0.7), c("power", "bias", "empirical_se", "mse", "coverage"))
  runs <- list(continuous = alt, null = null, `time to event` = tte)
  ok <- all(vapply(runs, function(r) identical(r$status, "succeeded") && r$complete && length(r$rows) >= 3L && r$worst < 1e-9, logical(1)))
  list(pass = ok,
       detail = sprintf("engine measure and its Monte-Carlo error vs rsimsum::simsum on the replicate table the job summarised (complete tables, differences <= 1e-9: worst %.1e): continuous effect 0.4, %d replicates: %s; null, %d replicates: %s; time to event HR 0.7 (log hazard ratio), %d replicates: %s",
                        max(vapply(runs, function(r) r$worst, numeric(1))), alt$n, alt$text, null$n, null$text, tte$n, tte$text))
})
