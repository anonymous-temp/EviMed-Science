# ---------------------------------------------------------------------------
# covariate_sets.R — the comparator analysis re-run under alternative,
# pre-declared covariate sets (comparator.covariate_sets).
#
# Hidden knowledge:
#
# - **Every set is a full run of the named analysis, by the named analysis's own
#   handler.** The weights, the balance table, the overlap and effective-sample-size
#   rules and the whole-pipeline bootstrap are not re-implemented here: the job
#   calls the handler of `comparator.entropy_balance`, `comparator.propensity_weight`
#   or `comparator.aipw` once per set with the set's covariates, and reads what it
#   returned. Whatever a set would have been told by itself, it is told here, and
#   case N36 holds the two to the same numbers.
# - **A set that breaks a not-estimable rule is reported as that, never dropped.**
#   Dropping the sets that "did not work" would turn a sensitivity analysis into a
#   selection of the sets that agree. Each set carries its own verdict (estimate and
#   interval, a named rule, or a refusal), the range is over the sets that have an
#   estimate, and the result says how many did.
# - **The sets are compared on the same resamples.** Every set runs with the job's
#   seed, so the bootstrap draws the same rows for each set; the difference between
#   two sets' intervals is then the covariate set's, not the resampling's noise.
# - **The first set is the primary analysis.** The sets are declared before the
#   data is read; the range is a description of how far the estimate moves with the
#   adjustment set, never a rule for choosing among them. Whether the conclusion
#   (the interval excludes the null) holds in every set is reported as a fact
#   (`agreement`), not as a gate.
# - **The cost is the number of sets times the bootstrap.** The domain caps a job at
#   eight sets; a spent CPU budget keeps the sets that finished and says which were
#   not run.
# ---------------------------------------------------------------------------

vcr_job_covariate_sets <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  analysis <- as.character(sc$analysis %||% "entropy_balance")
  if (!(analysis %in% c("entropy_balance", "propensity", "aipw"))) vcr_abort("scenario_value_invalid", "scenario.analysis", "The analysis is entropy_balance, propensity or aipw.")
  endpoint <- as.character(sc$endpoint$type %||% "")
  if (!(endpoint %in% c("continuous", "binary", "time_to_event"))) vcr_abort("scenario_field_missing", "scenario.endpoint", "A covariate-set comparison states its endpoint.")
  if (identical(analysis, "aipw") && identical(endpoint, "time_to_event")) vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "The doubly robust analysis is for a continuous or a binary outcome.")
  if (identical(analysis, "aipw") && !identical(as.character(sc$estimand %||% "ATT"), "ATT")) vcr_abort("scenario_value_invalid", "scenario.estimand", "The doubly robust analysis estimates the effect in the trial's population (ATT).")
  sets <- sc$covariateSets
  if (!is.list(sets) || length(sets) < 2L) vcr_abort("scenario_value_invalid", "scenario.covariateSets", "A covariate-set comparison has at least two sets.")
  nm <- vapply(sets, function(s) { v <- s$name; if (is.character(v) && length(v) == 1L && !is.na(v)) v else "" }, character(1))
  if (any(!nzchar(nm)) || anyDuplicated(nm)) vcr_abort("scenario_value_invalid", "scenario.covariateSets", "Each covariate set has a name of its own.")
  set_covs <- lapply(sets, function(s) vcr_chr(s$covariates))
  if (any(vapply(set_covs, length, integer(1)) < 1L)) vcr_abort("scenario_value_invalid", "scenario.covariateSets", "Each covariate set names its covariates.")

  base_method <- switch(analysis, entropy_balance = "comparator.entropy_balance", propensity = "comparator.propensity_weight", aipw = "comparator.aipw")
  handler <- vcr_engine_handlers()[[base_method]]
  base_sc <- if (identical(analysis, "aipw")) sc[intersect(names(sc), c("treatmentColumn", "outcomeColumn", "endpoint", "estimand", "cohortRules", "targetTrial"))]
             else sc[setdiff(names(sc), c("analysis", "covariateSets"))]
  primary_name <- if (identical(analysis, "aipw")) "aipw_difference" else if (identical(endpoint, "time_to_event")) "rmst_difference" else "weighted_difference"

  runs <- vector("list", length(sets)); stopped <- NULL
  for (k in seq_along(sets)) {
    reason <- vcr_interrupt()
    if (identical(reason, "canceled")) {
      return(list(status = "canceled", measures = list(), counts = vcr_counts(), diagnostics = list(setsCompleted = k - 1L, setsRequested = length(sets))))
    }
    if (!is.null(reason)) { stopped <- reason; break }
    j <- job; j$method <- base_method; j$scenario <- c(base_sc, list(covariates = as.list(set_covs[[k]])))
    out <- tryCatch(handler(j, output_dir = NULL, cancel_file = cancel_file),
                    vcr_refusal = function(e) list(status = "failed", issues = list(e$issue), measures = list()))
    if (identical(out$status, "canceled")) {
      return(list(status = "canceled", measures = list(), counts = vcr_counts(), diagnostics = list(setsCompleted = k - 1L, setsRequested = length(sets))))
    }
    runs[[k]] <- out
    if (identical(out$status, "failed") && any(vapply(out$issues %||% list(), function(i) identical(i$code, "cpu_budget_exhausted"), logical(1)))) { stopped <- "cpu_budget"; break }
  }
  run_idx <- which(!vapply(runs, is.null, logical(1)))

  one <- function(k) {
    out <- runs[[k]]
    pick <- function(name) { m <- Filter(function(x) identical(x$name, name), out$measures %||% list()); if (length(m)) m[[1]] else NULL }
    prim <- pick(primary_name); ess <- pick("effective_sample_size"); smd <- pick("worst_standardized_difference")
    issue <- if (identical(out$status, "failed") && length(out$issues)) out$issues[[1]] else NULL
    list(set = k, name = nm[k], covariates = as.list(set_covs[[k]]), status = out$status, conclusion = out$conclusion,
         notEstimableRule = out$notEstimableRule, detail = out$diagnostics$detail,
         refusal = if (is.null(issue)) NULL else list(code = issue$code, field = issue$field),
         estimate = if (is.null(prim)) NULL else prim$value, unit = prim$unit, source = prim$source,
         interval = if (is.null(prim) || is.null(prim$interval)) NULL else list(low = prim$interval$low, high = prim$interval$high),
         effectiveSampleSize = if (is.null(ess)) NULL else ess$value, worstStandardizedDifference = if (is.null(smd)) NULL else smd$value,
         limitedBy = out$diagnostics$limitedBy %||% list(),
         valueSourcesUsed = out$diagnostics$valueSourcesUsed)
  }
  rec <- lapply(run_idx, one)
  not_run <- setdiff(seq_along(sets), run_idx)
  ok <- Filter(function(r) identical(r$status, "succeeded") && !is.null(r$estimate), rec)

  if (!length(ok)) {
    if (!is.null(stopped) && !length(run_idx)) {
      return(list(status = "failed", measures = list(), counts = vcr_counts(),
                  issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the first covariate set finished.")),
                  diagnostics = list(sets = list(), setsRequested = length(sets))))
    }
    first <- runs[[1L]]
    if (identical(first$status, "not_estimable")) {
      return(list(status = "not_estimable", notEstimableRule = first$notEstimableRule, measures = list(), counts = first$counts %||% vcr_counts(),
                  diagnostics = list(detail = first$diagnostics$detail, sets = rec, primarySet = nm[1L], setsRequested = length(sets))))
    }
    # no set has an estimate and the primary was refused or failed: the job is refused by that code, as the analysis alone would have been
    return(list(status = "failed", measures = list(), counts = vcr_counts(), issues = first$issues %||% list(),
                diagnostics = list(sets = rec, primarySet = nm[1L], setsRequested = length(sets))))
  }

  est <- vapply(ok, function(r) r$estimate, numeric(1))
  src <- vcr_weakest_source(vapply(ok, function(r) as.character(r$source %||% NA_character_), character(1)), "calculated")
  unit <- ok[[1L]]$unit
  measures <- c(
    lapply(ok, function(r) vcr_measure(sprintf("covariate_set_estimate_%d", r$set), r$estimate, unit = unit, source = r$source %||% src, note = r$name,
                                        interval = if (is.null(r$interval)) NULL else vcr_interval("confidence", r$interval$low, r$interval$high))),
    list(vcr_measure("covariate_set_range_low", min(est), unit = unit, source = src),
         vcr_measure("covariate_set_range_high", max(est), unit = unit, source = src),
         vcr_measure("covariate_set_range_width", max(est) - min(est), unit = unit, source = src),
         vcr_measure("covariate_sets_total", length(sets), source = "calculated"),
         vcr_measure("covariate_sets_estimable", length(ok), source = "calculated")))

  with_iv <- Filter(function(r) !is.null(r$interval), ok)
  excl <- vapply(with_iv, function(r) r$interval$low > 0 || r$interval$high < 0, logical(1))
  not_ok <- Filter(function(r) !(identical(r$status, "succeeded") && !is.null(r$estimate)), rec)
  primary_ok <- identical(rec[[1L]]$set, 1L) && identical(rec[[1L]]$status, "succeeded") && !is.null(rec[[1L]]$estimate)
  any_limited <- any(vapply(ok, function(r) identical(r$conclusion, "limited"), logical(1)))
  limited_by <- c(if (length(not_ok) || length(not_run)) "covariate_set_without_estimate", if (!primary_ok) "primary_set_without_estimate",
                  if (any_limited) "covariate_set_limited", if (length(not_run)) "covariate_sets_not_run")
  tbl <- do.call(rbind, lapply(rec, function(r) data.frame(
    set = r$set, name = r$name, covariates = paste(unlist(r$covariates), collapse = "+"), status = r$status,
    rule = r$notEstimableRule %||% r$refusal$code %||% "", estimate = r$estimate %||% NA_real_, low = r$interval$low %||% NA_real_, high = r$interval$high %||% NA_real_,
    effectiveSampleSize = r$effectiveSampleSize %||% NA_real_, worstStandardizedDifference = r$worstStandardizedDifference %||% NA_real_, stringsAsFactors = FALSE)))
  first_ok <- runs[[ok[[1L]]$set]]
  result <- list(
    status = if (is.null(stopped)) "succeeded" else "failed", measures = measures,
    conclusion = if (length(limited_by)) "limited" else "estimable",
    counts = first_ok$counts %||% vcr_counts(),
    diagnostics = list(
      analysis = analysis, method = base_method, endpoint = endpoint, primaryMeasure = primary_name, primarySet = nm[1L], setsRequested = length(sets),
      sets = rec,
      range = list(low = min(est), high = max(est), width = max(est) - min(est), estimableSets = length(ok), of = length(sets)),
      agreement = list(null = 0, sameSign = all(est > 0) || all(est < 0), setsWithInterval = length(with_iv),
                       allIntervalsExcludeNull = length(with_iv) > 0L && all(excl), anyIntervalExcludesNull = length(with_iv) > 0L && any(excl),
                       note = "a description of how far the estimate moves with the adjustment set, never a rule for choosing among the sets"),
      resampling = "every set runs with the job's seed, so the bootstrap draws the same rows for each set",
      limitedBy = as.list(limited_by),
      valueSourcesUsed = list(weakest = vcr_weakest_source(vapply(ok, function(r) as.character(r$valueSourcesUsed$weakest %||% NA_character_), character(1)), NULL))),
    tables = .vcr_tables_of(list(vcr_write_table(tbl, "covariate-sets", output_dir))))
  if (!is.null(stopped)) {
    result$issues <- list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit",
                                    sprintf("The CPU budget ran out after %d of %d covariate sets; the sets that finished are reported and the rest were not run.", length(run_idx), length(sets))))
    result$conclusion <- NULL
  }
  result
}
