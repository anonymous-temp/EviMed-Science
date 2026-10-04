# ---------------------------------------------------------------------------
# comparison.R — what the comparator-effect methods share: the frame of a
# weighted comparison, and what a bootstrap says about its own Monte-Carlo error.
#
# Hidden knowledge:
#
# - **The frame is the weighting job's own prefix, kept in step by a case.**
#   `vcr_job_weight_comparator` (engine.R) reads the table, applies the cohort
#   rules, checks the covariates and the arm, and only then weighs. The methods
#   that follow it (weighted Cox, doubly robust, the covariate sets) must refuse
#   the same malformed table by the same name, so they run the same checks in the
#   same order; case N33 holds the two to one verdict on the same bad tables. It
#   is a copy rather than a refactor of the weighting job because that handler is
#   release-critical and this stream adds methods, it does not move old ones.
# - **A bootstrapped number carries its Monte-Carlo error.** The percentile
#   interval of a resample distribution is itself an estimate: its endpoints are
#   quantiles of B draws and its standard error is a standard deviation of B
#   draws, and the protocol's rule is that no simulated number goes without that
#   error (AC-28). `vcr_boot_summary` reports both, from the draws the bootstrap
#   kept, so a reader can see that B = 2000 is enough or is not.
# ---------------------------------------------------------------------------

#' The table, the arm and the covariates a weighted comparison starts from, or a
#' named refusal. `covs` is every covariate column the method reads (a method with
#' two nuisance models passes the union). The checks and their order are the
#' weighting job's: individual rows, the cohort rules, the covariate and arm
#' columns, a complete 0/1 arm, numeric complete covariates, two people a group.
vcr_comparison_frame <- function(job, sc, tabs, what, covs) {
  subj <- .vcr_main_table(tabs)
  vcr_require_individual(subj, what, method = job$method)
  cohort <- vcr_apply_downstream_cohort(subj, sc$cohortRules)
  subj <- cohort$data
  if (!length(covs)) vcr_abort("scenario_field_missing", "scenario.covariates", "A weighting names its covariates.")
  tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
  if (!all(c(covs, tc) %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.covariates", "The covariates and the treatment column are in the table.")
  treat_raw <- subj[[tc]]
  if (anyNA(treat_raw) || !all(treat_raw %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 for the trial arm and 0 for the external control, complete.")
  treat <- as.integer(treat_raw)
  X <- as.matrix(subj[, covs, drop = FALSE])
  if (!is.numeric(X)) vcr_abort("input_shape_invalid", "scenario.covariates", "Covariates are numeric (code categories as indicators).")
  miss <- which(colSums(is.na(X)) > 0L)
  if (length(miss)) vcr_abort("missing_covariate", "scenario.covariates", sprintf("Covariate '%s' has missing values; weights are not estimated on incomplete rows.", covs[miss[1]]))
  if (sum(treat == 1L) < 2L || sum(treat == 0L) < 2L) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "Both groups need at least two people.")
  list(subj = subj, cohort = cohort, keep = cohort$keep, tc = tc, treat = treat, X = X)
}

#' The standard error of a standard deviation computed from `x` draws: the
#' Monte-Carlo error of a bootstrap standard error. Uses the draws' own kurtosis
#' (`sd * sqrt((kurtosis - 1) / (4 B))`, which is `sd / sqrt(2 B)` for a normal
#' sample), so a heavy-tailed resample distribution is not given a normal one's
#' precision.
vcr_sd_mcse <- function(x) {
  x <- x[is.finite(x)]
  n <- length(x)
  if (n < 20L) return(NA_real_)
  m <- mean(x); v <- mean((x - m)^2)
  if (!(v > 0)) return(0)
  stats::sd(x) * sqrt(max(mean((x - m)^4) / v^2 - 1, 0) / (4 * n))
}

#' What component `j` of a `vcr_bootstrap_pipeline` result says: its standard
#' error with that error's Monte-Carlo standard error, its percentile interval
#' with the Monte-Carlo standard error of each endpoint (a distribution-free
#' order-statistic half-width, `vcr_quantile_mcse`), the draws it rests on and
#' the share of resamples in which it had no value. `transform` maps the
#' resample scale to the reporting scale (exp for a log ratio); it is monotone,
#' so the interval is the transform of the interval.
vcr_boot_summary <- function(boot, j = 1L, transform = identity, level = 0.95) {
  draws <- boot$estimatesMatrix[, j]
  ok <- draws[is.finite(draws)]
  a <- (1 - level) / 2
  iv <- boot$intervals[j, ]
  list(draws = length(ok), failureShare = boot$componentFailureShare[[j]],
       se = if (length(ok) >= 2L) stats::sd(ok) else NA_real_, seMcse = vcr_sd_mcse(ok),
       interval = if (anyNA(iv)) NULL else transform(iv),
       intervalMcse = if (anyNA(iv)) NULL else list(low = vcr_quantile_mcse(transform(ok), a), high = vcr_quantile_mcse(transform(ok), 1 - a)),
       level = level)
}

#' A measure from a summary of a bootstrap: its standard error as a simulated
#' number with its own Monte-Carlo standard error, or NULL when the resamples left
#' no standard error to report.
vcr_boot_se_measure <- function(name, summary, source, unit = NULL) {
  if (!is.finite(summary$se) || !is.finite(summary$seMcse)) return(NULL)
  vcr_measure(name, summary$se, simulated = TRUE, mcse = summary$seMcse, unit = unit, source = source)
}

#' The part of a bootstrap summary a result's diagnostics carries (the interval and
#' the errors on it, the draws, the failure share, and what was resampled).
vcr_boot_diagnostics <- function(summary, requested, resampling, se_scale, interval_scale = se_scale) {
  list(replicates = summary$draws, requested = requested, failureShare = summary$failureShare,
       se = summary$se, seMcse = summary$seMcse, seScale = se_scale, level = summary$level,
       interval = summary$interval, intervalMcse = summary$intervalMcse, intervalScale = interval_scale, resampling = resampling)
}

`%||%` <- function(a, b) if (is.null(a)) b else a
