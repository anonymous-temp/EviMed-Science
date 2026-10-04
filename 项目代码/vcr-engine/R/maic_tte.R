# ---------------------------------------------------------------------------
# maic_tte.R — matching-adjusted indirect comparison for a time-to-event
# outcome, unanchored and anchored (comparator.maic_time_to_event; NICE DSU TSD
# 18, Signorovitch 2012). The weights are `vcr_maic_weights` (maic.R): MAIC is
# entropy balancing, one kernel and one convergence story.
#
# Hidden knowledge:
#
# - **The weight scale is part of the answer.** Unanchored, the study's weighted
#   patients and the comparator's reconstructed patients (weight 1) sit in ONE Cox
#   model, so the study arm's weight relative to the comparator's moves the risk
#   sets and, a little, the hazard ratio. The scale TSD 18 and maicplus use is
#   w = exp(X' lambda) with X centred at the aggregate means -- the weights
#   themselves, not weights rescaled to the sample size. Rescaled to n the same
#   data gives 0.2806 where maicplus gives 0.283478 (measured). `vcr_maic_weights`
#   returns the mean-one rescaling for the ESS; this file recovers the TSD scale
#   from its `lambda`.
# - **Two variances, both reported, and neither is the truth.** The Lin-Wei
#   sandwich of `coxph(weights =, robust = TRUE)` treats the weights as known and
#   is biased low when the effective sample size is small; the bootstrap
#   re-estimates the weights in every resample and is unstable when overlap is poor
#   and n small (Chandler & Proskorovsky, Res Synth Methods 2024; maicplus' own
#   vignette advises against the bootstrap unanchored). The headline interval is
#   the bootstrap, as in every other weighted method of this engine; the robust one
#   is a measure of its own, and the ratio of the standard errors is a metric.
# - **The bootstrap resamples both sets of patients.** Unanchored, the comparator's
#   reconstructed rows are a sample too (their uncertainty comes from the published
#   numbers at risk), so they are resampled within the comparator and the study's
#   patients within the study, with the weights re-estimated on the resampled study
#   patients every time. The aggregate-data trial's baseline means (`targets`) are
#   treated as fixed, which is stated in the result: that, and nothing else about
#   the aggregate trial's own sampling variability, is left out.
# - **Reconstructed patients are never real patients.** The comparator's rows must
#   be labelled `reconstructed` (a Guyot reconstruction's output), the study's must
#   be real people's rows, and `counts` keeps `realPatients` and
#   `reconstructedPseudoPatients` apart; the effective sample size is the study
#   weights' alone and never exceeds the real patients.
# - **Unanchored is always `limited`.** Every prognostic factor and every effect
#   modifier would have to be matched; the result says so whatever the balance.
# ---------------------------------------------------------------------------

#' The comparator's pseudo-individual table: `time` and `status` (what a
#' reconstruction writes), and for an anchored comparison the arm column (1 = the
#' aggregate trial's active arm, 0 = the common comparator).
.vcr_pseudo_ipd <- function(job, sc, with_arm) {
  pin <- vcr_input_by_id(job, as.character(sc$pseudoIpdInputId))
  if (is.null(pin) || !identical(pin[["kind"]], "snapshot_file")) {
    vcr_abort("scenario_value_invalid", "scenario.pseudoIpdInputId", "The pseudo-individual rows are a snapshot_file input of the job.")
  }
  ps <- vcr_read_table_input(pin)
  if (!identical(vcr_table_source(ps), "reconstructed")) {
    vcr_abort("input_source_not_reconstructed", "scenario.pseudoIpdInputId", "The comparator's pseudo-individual rows come from a reconstruction and are labelled reconstructed.")
  }
  if (!all(c("time", "status") %in% names(ps))) {
    vcr_abort("input_shape_invalid", "scenario.pseudoIpdInputId", "The pseudo-individual table has the columns time and status, as a reconstruction writes them.")
  }
  tm <- suppressWarnings(as.numeric(ps$time)); st <- suppressWarnings(as.integer(ps$status))
  if (anyNA(tm) || anyNA(st) || any(tm < 0) || !all(st %in% c(0L, 1L))) {
    vcr_abort("input_shape_invalid", "scenario.pseudoIpdInputId", "`time` is a number from zero and `status` is 1 for an event and 0 for a censored person, complete.")
  }
  arm <- NULL
  if (with_arm) {
    pc <- .vcr_column_name(sc$pseudoTreatmentColumn, "arm", "scenario.pseudoTreatmentColumn")
    if (!(pc %in% names(ps))) vcr_abort("input_shape_invalid", "scenario.pseudoTreatmentColumn", "The pseudo-individual table has the arm column.")
    if (anyNA(ps[[pc]]) || !all(ps[[pc]] %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.pseudoTreatmentColumn", "The arm column is 1 for the aggregate trial's active arm and 0 for the common comparator, complete.")
    arm <- as.integer(ps[[pc]])
  }
  list(df = ps, time = tm, status = st, arm = arm, column = if (with_arm) pc else NULL)
}

vcr_job_maic_tte <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  tabs <- vcr_job_tables(job)
  if (is.null(tabs$subject)) vcr_abort("input_shape_invalid", "inputs", "The study's own patients are a subject table, with an events table for the outcome.")
  subj <- tabs$subject
  vcr_require_individual(subj, "A time-to-event MAIC reads the study's own patients (real people's rows)")
  if (!is.null(tabs$event)) vcr_require_individual(tabs$event, "A time-to-event MAIC reads the study's own patients (real people's rows)")
  anchored <- isTRUE(as.logical(sc$anchored))
  covs <- vcr_chr(sc$covariates)
  if (!length(covs) || !all(covs %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.covariates", "The covariates are columns of the study's table.")
  X <- as.matrix(subj[, covs, drop = FALSE])
  if (!is.numeric(X)) vcr_abort("input_shape_invalid", "scenario.covariates", "Covariates are numeric (code categories as indicators).")
  miss <- which(colSums(is.na(X)) > 0L)
  if (length(miss)) vcr_abort("missing_covariate", "scenario.covariates", sprintf("Covariate '%s' has missing values.", covs[miss[1]]))
  targets <- vapply(sc$targets, function(v) vcr_scalar(v, NA_real_), numeric(1))
  if (anyNA(targets) || !all(covs %in% names(targets))) vcr_abort("scenario_value_invalid", "scenario.targets", "Every covariate has a numeric aggregate target.")
  ties <- as.character(sc$ties %||% "efron")
  if (!(ties %in% c("efron", "breslow"))) vcr_abort("scenario_value_invalid", "scenario.ties", "Ties are handled by Efron's or Breslow's approximation.")

  outcome <- vcr_outcome_frame(sc, tabs, subj, "time_to_event")
  t_ipd <- outcome$time; s_ipd <- outcome$status
  if (anyNA(t_ipd) || anyNA(s_ipd)) vcr_abort("input_shape_invalid", "inputs", "Time and status are complete.")
  if (any(t_ipd < 0)) vcr_abort("input_shape_invalid", "inputs", "Follow-up times are not negative.")
  tc <- NULL; a_ipd <- NULL
  if (anchored) {
    tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
    if (!(tc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is not in the table.")
    if (anyNA(subj[[tc]]) || !all(subj[[tc]] %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 for the study's active arm and 0 for the common comparator, complete.")
    a_ipd <- as.integer(subj[[tc]])
  }
  route <- if (!anchored) "unanchored" else if (!is.null(sc$pseudoIpdInputId)) "anchored_pseudo" else "anchored_published"
  ps <- if (!is.null(sc$pseudoIpdInputId)) .vcr_pseudo_ipd(job, sc, with_arm = anchored) else NULL
  n_ipd <- nrow(subj); n_ps <- if (is.null(ps)) 0L else nrow(ps$df)
  if (!is.null(ps) && n_ps < 2L) vcr_abort("input_shape_invalid", "scenario.pseudoIpdInputId", "The pseudo-individual table has at least two rows.")
  est_bc_pub <- vcr_scalar(sc$aggregateEstimate, NULL); se_bc_pub <- vcr_scalar(sc$aggregateSe, NULL)
  if (identical(route, "anchored_published") && (is.null(est_bc_pub) || is.null(se_bc_pub))) {
    vcr_abort("scenario_field_missing", "scenario.aggregateEstimate", "An anchored comparison states the comparator trial's contrast as pseudo-individual rows or as a published log hazard ratio and its standard error.")
  }

  used <- vcr_used_sources(c(list(list(df = subj, columns = c(covs, tc))), .vcr_outcome_parts(sc, tabs, subj, "time_to_event"),
                             if (!is.null(ps)) list(list(df = ps$df, columns = c("time", "status", ps$column)))))
  est_src <- vcr_estimate_source(used$source)
  sources_used <- vcr_value_sources_used(used)
  cohort_counts <- vcr_counts(realPatients = n_ipd, events = sum(s_ipd), reconstructedPseudoPatients = if (n_ps > 0L) n_ps else NULL)

  # events by arm, before any weight is fitted: a hazard ratio needs an event on each side of every contrast
  events <- if (!anchored) list(study = sum(s_ipd), comparator = sum(ps$status))
            else c(list(studyActive = sum(s_ipd[a_ipd == 1L]), studyCommon = sum(s_ipd[a_ipd == 0L])),
                   if (!is.null(ps)) list(comparatorActive = sum(ps$status[ps$arm == 1L]), comparatorCommon = sum(ps$status[ps$arm == 0L])))
  none <- names(events)[vapply(events, function(e) e == 0, logical(1))]
  sizes_ok <- if (anchored) all(c(sum(a_ipd == 1L), sum(a_ipd == 0L)) >= 1L) && (is.null(ps) || all(c(sum(ps$arm == 1L), sum(ps$arm == 0L)) >= 1L)) else TRUE
  if (!sizes_ok) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "Each arm of an anchored comparison has at least one person.")
  if (length(none)) {
    return(list(status = "not_estimable", notEstimableRule = "too_few_events", measures = list(), counts = cohort_counts,
                diagnostics = list(detail = sprintf("%s has no event, so a hazard ratio does not exist", gsub("([A-Z])", " \\L\\1", none[[1]], perl = TRUE)),
                                   eventsByArm = events, valueSourcesUsed = sources_used)))
  }

  # the weights: exp(X' lambda), X centred at the aggregate targets (the TSD 18 / maicplus scale), never rescaled to n
  fit_w <- function(i_ipd) {
    Xi <- X[i_ipd, , drop = FALSE]
    f <- vcr_maic_weights(Xi, targets)
    if (is.null(f$weights)) return(list(failed = f))
    list(wu = exp(drop(sweep(Xi, 2, targets[colnames(Xi)], "-") %*% f$lambda)), ess = f$effectiveSampleSize, fit = f)
  }
  full <- fit_w(seq_len(n_ipd))
  if (!is.null(full$failed)) {
    return(list(status = "not_estimable", notEstimableRule = full$failed$rule %||% "entropy_balance_infeasible", measures = list(),
                counts = cohort_counts, diagnostics = list(detail = full$failed$detail, valueSourcesUsed = sources_used)))
  }
  wu <- full$wu; ess <- full$ess
  ess_floor <- vcr_limit("essFloor", 10)
  if (ess < ess_floor) {
    return(list(status = "not_estimable", notEstimableRule = "effective_sample_size_below_floor", measures = list(),
                counts = vcr_counts(realPatients = n_ipd, events = sum(s_ipd), effectiveSampleSize = ess, reconstructedPseudoPatients = if (n_ps > 0L) n_ps else NULL),
                diagnostics = list(detail = sprintf("weighted effective sample size %.1f is below the floor %.1f", ess, ess_floor), valueSourcesUsed = sources_used)))
  }
  counts <- vcr_counts(realPatients = n_ipd, events = sum(s_ipd), effectiveSampleSize = ess, reconstructedPseudoPatients = if (n_ps > 0L) n_ps else NULL)

  # --- the point estimates ------------------------------------------------------------------------------
  ones <- function(n) rep(1, n)
  fail <- function(detail) list(status = "not_estimable", notEstimableRule = "too_few_events", measures = list(), counts = counts,
                                diagnostics = list(detail = detail, eventsByArm = events, valueSourcesUsed = sources_used))
  if (!anchored) {
    arm_all <- c(rep(1L, n_ipd), rep(0L, n_ps)); t_all <- c(t_ipd, ps$time); s_all <- c(s_ipd, ps$status)
    adj <- vcr_cox_primary(t_all, s_all, arm_all, c(wu, ones(n_ps)), ties, with_ph = FALSE)
    una <- vcr_cox_primary(t_all, s_all, arm_all, ones(n_ipd + n_ps), ties, with_ph = FALSE)
    if (!isTRUE(adj$ok) || !isTRUE(una$ok)) return(fail("the Cox fit did not converge or has an infinite coefficient: the events are too few or too one-sided"))
    est <- adj$beta; se_rob <- adj$seRobust; est_u <- una$beta; se_u <- una$seModel
    parts <- NULL
  } else {
    ac_adj <- vcr_cox_primary(t_ipd, s_ipd, a_ipd, wu, ties, with_ph = FALSE)
    ac_un <- vcr_cox_primary(t_ipd, s_ipd, a_ipd, ones(n_ipd), ties, with_ph = FALSE)
    bc <- if (identical(route, "anchored_pseudo")) vcr_cox_primary(ps$time, ps$status, ps$arm, ones(n_ps), ties, with_ph = FALSE)
          else list(ok = TRUE, beta = est_bc_pub, seModel = se_bc_pub)
    if (!isTRUE(ac_adj$ok) || !isTRUE(ac_un$ok) || !isTRUE(bc$ok)) return(fail("a Cox fit did not converge or has an infinite coefficient: the events are too few or too one-sided"))
    est <- ac_adj$beta - bc$beta; se_rob <- sqrt(ac_adj$seRobust^2 + bc$seModel^2)
    est_u <- ac_un$beta - bc$beta; se_u <- sqrt(ac_un$seModel^2 + bc$seModel^2)
    parts <- list(acAdjusted = c(beta = ac_adj$beta, se = ac_adj$seRobust), acUnadjusted = c(beta = ac_un$beta, se = ac_un$seModel), bc = c(beta = bc$beta, se = bc$seModel))
  }

  # --- the bootstrap: both sets of patients resampled, the weights re-estimated every time -----------------------
  split_idx <- function(idx) list(ipd = idx[idx <= n_ipd], ps = idx[idx > n_ipd] - n_ipd)
  if (identical(route, "unanchored")) {
    n_rows <- n_ipd + n_ps; strata <- c(rep(1L, n_ipd), rep(2L, n_ps))
    est_fn <- function(idx) {
      s <- split_idx(idx); fw <- fit_w(s$ipd); if (!is.null(fw$failed)) return(rep(NA_real_, 1L))
      vcr_cox_beta(c(t_ipd[s$ipd], ps$time[s$ps]), c(s_ipd[s$ipd], ps$status[s$ps]), c(rep(1L, length(s$ipd)), rep(0L, length(s$ps))), c(fw$wu, ones(length(s$ps))), ties)
    }
  } else if (identical(route, "anchored_pseudo")) {
    n_rows <- n_ipd + n_ps; strata <- c(1L + a_ipd, 3L + ps$arm)
    est_fn <- function(idx) {
      s <- split_idx(idx); fw <- fit_w(s$ipd); if (!is.null(fw$failed)) return(c(NA_real_, NA_real_))
      ac <- vcr_cox_beta(t_ipd[s$ipd], s_ipd[s$ipd], a_ipd[s$ipd], fw$wu, ties)
      bcb <- vcr_cox_beta(ps$time[s$ps], ps$status[s$ps], ps$arm[s$ps], NULL, ties)
      c(ac - bcb, ac)
    }
  } else {
    n_rows <- n_ipd; strata <- 1L + a_ipd
    est_fn <- function(idx) {
      fw <- fit_w(idx); if (!is.null(fw$failed)) return(c(NA_real_, NA_real_))
      ac <- vcr_cox_beta(t_ipd[idx], s_ipd[idx], a_ipd[idx], fw$wu, ties)
      # the published contrast's own error enters as a draw from its normal distribution, as maicplus does
      c(ac - (est_bc_pub + se_bc_pub * stats::rnorm(1L)), ac)
    }
  }
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(n_rows, est_fn, replicates = B, seed = job$seed, strata = strata, cores = vcr_cores(job$cores))
  if (identical(boot$interrupted, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = n_ipd),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  z <- stats::qnorm(0.975)
  wald <- function(b, se) vcr_interval("confidence", exp(b - z * se), exp(b + z * se))
  base_measures <- c(
    list(vcr_measure("hazard_ratio_robust", exp(est), interval = wald(est, se_rob), source = est_src),
         vcr_measure("log_hazard_ratio_se_robust", se_rob, source = est_src),
         vcr_measure("hazard_ratio_unadjusted", exp(est_u), interval = wald(est_u, se_u), source = est_src)),
    if (!is.null(parts)) list(
      vcr_measure("hazard_ratio_ac_adjusted", exp(parts$acAdjusted[["beta"]]), interval = wald(parts$acAdjusted[["beta"]], parts$acAdjusted[["se"]]), source = est_src),
      vcr_measure("hazard_ratio_ac_unadjusted", exp(parts$acUnadjusted[["beta"]]), interval = wald(parts$acUnadjusted[["beta"]], parts$acUnadjusted[["se"]]), source = est_src),
      vcr_measure("hazard_ratio_bc", exp(parts$bc[["beta"]]), interval = wald(parts$bc[["beta"]], parts$bc[["se"]]), source = est_src)),
    list(vcr_measure("effective_sample_size", ess, source = est_src)))
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    # the budget ran out inside the bootstrap: the point estimates and the robust variance are kept, no bootstrap interval is invented
    return(list(status = "failed", measures = base_measures, counts = counts,
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap; the robust estimate is kept and no bootstrap interval is reported.")),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B, valueSourcesUsed = sources_used)))
  }
  bs <- vcr_boot_summary(boot, 1L, exp)
  measures <- c(
    list(vcr_measure("hazard_ratio", exp(est), interval = if (is.null(bs$interval)) NULL else vcr_interval("confidence", bs$interval[1], bs$interval[2]), source = est_src)),
    base_measures[seq_len(2L)],
    Filter(Negate(is.null), list(vcr_boot_se_measure("log_hazard_ratio_se_bootstrap", bs, est_src))),
    base_measures[-seq_len(2L)])

  few <- vcr_limit("coxFewEvents", 10)
  limited_by <- c(if (!anchored) "unanchored_comparison", if (bs$failureShare > 0.01) "bootstrap_failure_share",
                  if (any(vapply(events, function(e) e < few, logical(1)))) "few_events")
  balance <- data.frame(covariate = covs, target = as.numeric(targets[covs]), studyMean = as.numeric(colMeans(X)),
                        weightedMean = as.numeric(crossprod(X, wu / sum(wu))), stringsAsFactors = FALSE)
  balance$differenceAfter <- balance$weightedMean - balance$target
  wdiag <- list(scale = "exp(X' lambda) with X centred at the aggregate targets (TSD 18, maicplus normalize_weights = FALSE); never rescaled to n",
                n = n_ipd, sum = sum(wu), min = min(wu), max = max(wu), mean = mean(wu), coefficientOfVariation = stats::sd(wu) / mean(wu),
                effectiveSampleSize = ess, essShare = ess / n_ipd, converged = full$fit$converged)
  list(status = "succeeded", measures = measures, conclusion = if (length(limited_by)) "limited" else "estimable", counts = counts,
       diagnostics = list(
         anchored = anchored, route = route, targetPopulation = "aggregate_data_trial", endpoint = "time_to_event", timeUnit = as.character(sc$timeUnit %||% "months"),
         model = list(formula = "Surv(time, status) ~ arm", ties = ties,
                      coding = if (!anchored) "the study's weighted patients (1) against the comparator's reconstructed patients (0, weight 1)"
                               else "contrasts of the active arm (1) with the common comparator (0): A against C in the study, B against C in the comparator trial; indirect A against B is Bucher's difference of the two log hazard ratios"),
         eventsByArm = events,
         pseudoIpd = if (is.null(ps)) NULL else list(rows = n_ps, events = sum(ps$status), source = "reconstructed",
                                                     note = "pseudo-individual rows from the comparator's published curve; counted apart from real patients"),
         weights = wdiag, balance = balance,
         robust = list(se = se_rob, interval = c(exp(est - z * se_rob), exp(est + z * se_rob)),
                       basis = if (!anchored) "Lin-Wei sandwich on the weighted partial likelihood, the weights treated as known"
                               else "Bucher: the weighted study contrast's robust variance plus the comparator contrast's model variance"),
         bootstrap = vcr_boot_diagnostics(bs, B, if (identical(route, "anchored_published")) "study rows resampled within arm, the weights re-estimated in every resample; the published contrast enters as a normal draw"
                                                 else "study rows and the comparator's reconstructed rows resampled within arm, the weights re-estimated on the resampled study rows every time",
                                          se_scale = "log hazard ratio", interval_scale = "hazard ratio"),
         varianceComparison = list(robustSe = se_rob, bootstrapSe = bs$se, ratioRobustToBootstrap = se_rob / bs$se,
                                   note = "a metric, never a gate: the robust variance is biased low when the effective sample size is small, the bootstrap is unstable when overlap is poor and n small (Chandler & Proskorovsky 2024)"),
         targetsTreatedAsFixed = TRUE,
         limitedBy = as.list(limited_by), conclusionCeiling = if (!anchored) "limited" else NULL,
         unadjustedEffectModifiers = sc$unadjustedEffectModifiers %||% list(), valueSourcesUsed = sources_used),
       tables = .vcr_tables_of(list(
         vcr_write_table(balance, "balance", output_dir),
         vcr_write_table(data.frame(row = seq_len(n_ipd), arm = if (anchored) a_ipd else 1L, weight = wu, weightMeanOne = wu / mean(wu)), "weights", output_dir))))
}
