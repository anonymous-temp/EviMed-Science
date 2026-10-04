# ---------------------------------------------------------------------------
# weighted_cox.R — a weighted Cox hazard ratio with a robust variance and a
# bootstrap, the proportional-hazards test, and the RMST difference beside it
# (comparator.weighted_cox).
#
# Hidden knowledge:
#
# - **The weights are estimated inside the job.** A hazard ratio from weights
#   somebody else estimated has an interval that treats them as known, which is
#   the single most common way to publish an interval that is too narrow
#   (weighting.R). The robust (Lin-Wei) variance of `coxph(weights =, robust =
#   TRUE)` is conditional on the weights; the bootstrap here resamples the rows
#   and re-estimates the weights, then refits the Cox model, in every resample.
#   Both are reported, and the ratio of the two standard errors is a number a
#   reviewer can read (it is a metric, never a gate).
# - **The proportional-hazards test is a diagnostic, and its rule is declared
#   before the data is read.** The scenario states the level (`phAlpha`) and the
#   time transform (`phTransform`); the estimator is NOT switched by the result
#   (a data-dependent switch between a hazard ratio and a difference in
#   restricted mean survival time is its own source of bias: Stensrud & Hernan,
#   JAMA 2020). When the test rejects, the hazard ratio is still reported, the
#   result says so (`proportionalHazards.rejected`, and its conclusion is
#   `limited`), and the RMST difference at the declared `tau` is reported beside
#   it. `survival::cox.zph` is a weighted score test with the weights treated as
#   fixed (Grambsch & Therneau 1994); nothing validates it for estimated
#   weights, so its p-value is descriptive.
# - **A hazard ratio is not collapsible.** The weighted marginal hazard ratio is
#   the pseudo-population's, it averages the hazard ratio over time in a way
#   that depends on the follow-up of both arms under non-proportional hazards,
#   and it does not equal the conditional ratio a covariate-adjusted model
#   reports. The model here is `Surv(time, status) ~ arm`, weighted: the weights
#   do the adjustment.
# - **Ties are the scenario's.** Efron is `survival`'s default and what
#   maicplus uses; Breslow is what the engine's own reconstruction check uses.
#   With continuous event times the two agree to every printed digit.
# ---------------------------------------------------------------------------

#' The Cox coefficient of the arm indicator under case weights, or NA when it
#' does not exist: an arm without an event, a fit that did not converge or that
#' warned of an infinite coefficient. The fast path (`coxph.fit`, no formula) for
#' the bootstrap loop; the primary fit is `vcr_cox_primary`.
vcr_cox_beta <- function(time, status, arm, weights = NULL, ties = "efron") {
  if (sum(status[arm == 1L]) == 0 || sum(status[arm == 0L]) == 0) return(NA_real_)
  w <- if (is.null(weights)) rep(1, length(time)) else weights
  warned <- FALSE
  fit <- tryCatch(withCallingHandlers(
    survival::coxph.fit(x = matrix(as.numeric(arm), ncol = 1L), y = survival::Surv(time, status), strata = NULL, offset = NULL,
                        init = NULL, control = survival::coxph.control(), weights = w, method = ties, rownames = NULL, resid = FALSE),
    warning = function(cnd) { warned <<- TRUE; invokeRestart("muffleWarning") }),
    error = function(e) NULL)
  if (is.null(fit) || warned) return(NA_real_)
  b <- unname(fit$coefficients[[1L]])
  if (is.finite(b)) b else NA_real_
}

#' The primary weighted Cox fit with the robust variance and the
#' proportional-hazards test. Returns `ok = FALSE` when the model does not exist.
vcr_cox_primary <- function(time, status, arm, weights, ties = "efron", transform = "km", with_ph = TRUE) {
  d <- data.frame(time = time, status = status, arm = as.numeric(arm), w = weights)
  warned <- FALSE
  fit <- tryCatch(withCallingHandlers(
    survival::coxph(survival::Surv(time, status) ~ arm, data = d, weights = w, robust = TRUE, ties = ties, x = TRUE, y = TRUE),
    warning = function(cnd) { warned <<- TRUE; invokeRestart("muffleWarning") }),
    error = function(e) NULL)
  if (is.null(fit) || warned) return(list(ok = FALSE, reason = "fit_failed"))
  beta <- unname(stats::coef(fit)[[1L]])
  se_robust <- sqrt(unname(fit$var[1L, 1L]))
  se_model <- sqrt(unname(fit$naive.var[1L, 1L]))
  if (!all(is.finite(c(beta, se_robust, se_model)))) return(list(ok = FALSE, reason = "fit_failed"))
  zph <- if (with_ph) tryCatch(survival::cox.zph(fit, transform = transform), error = function(e) NULL) else NULL
  ph <- NULL
  if (!is.null(zph)) {
    tab <- zph$table
    row <- function(name) { r <- tab[name, ]; list(chisq = unname(r[["chisq"]]), df = unname(r[["df"]]), p = unname(r[["p"]])) }
    ph <- list(perTerm = list(c(list(term = "arm"), row("arm"))), global = row("GLOBAL"),
               schoenfeld = data.frame(time = as.numeric(zph$time), transformedTime = as.numeric(zph$x),
                                       scaledResidual = as.numeric(zph$y[, "arm"])))
  }
  list(ok = TRUE, beta = beta, seRobust = se_robust, seModel = se_model, ph = ph)
}

vcr_job_weighted_cox <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  tabs <- vcr_job_tables(job)
  weighting <- as.character(sc$weighting %||% "entropy_balance")
  if (!(weighting %in% c("entropy_balance", "propensity"))) vcr_abort("scenario_value_invalid", "scenario.weighting", "The weights are entropy balancing or the propensity score.")
  estimand <- as.character(sc$estimand %||% vcr_domain()$defaultEstimand)
  if (!(estimand %in% vcr_domain()$estimands)) vcr_abort("scenario_value_invalid", "scenario.estimand", "The estimand is ATT, ATE or ATO.")
  if (identical(weighting, "entropy_balance") && !identical(estimand, "ATT")) {
    vcr_abort("scenario_value_invalid", "scenario.estimand", "Entropy balancing here reweights the controls to the treated group: it estimates the ATT and nothing else.")
  }
  covs <- vcr_chr(sc$covariates)
  fr <- vcr_comparison_frame(job, sc, tabs, "A weighted Cox comparison", covs)
  subj <- fr$subj; treat <- fr$treat; X <- fr$X; cohort <- fr$cohort; keep <- fr$keep
  ties <- as.character(sc$ties %||% "efron")
  if (!(ties %in% c("efron", "breslow"))) vcr_abort("scenario_value_invalid", "scenario.ties", "Ties are handled by Efron's or Breslow's approximation.")
  ph_alpha <- vcr_scalar(sc$phAlpha, 0.05)
  if (!(ph_alpha > 0 && ph_alpha < 1)) vcr_abort("scenario_value_invalid", "scenario.phAlpha", "The proportional-hazards level is between 0 and 1.")
  ph_transform <- as.character(sc$phTransform %||% "km")
  if (!(ph_transform %in% c("km", "rank", "identity"))) vcr_abort("scenario_value_invalid", "scenario.phTransform", "The time transform is km, rank or identity.")
  tau <- vcr_scalar(sc$tau, NULL)
  if (is.null(tau) || !(tau > 0)) vcr_abort("scenario_field_missing", "scenario.tau", "A weighted Cox comparison states the RMST horizon tau, which its companion difference is read at.")

  outcome <- vcr_outcome_frame(sc, tabs, subj, "time_to_event")
  time <- outcome$time; status <- outcome$status
  if (anyNA(time) || anyNA(status)) vcr_abort("input_shape_invalid", "inputs", "Time and status are complete.")
  if (any(time < 0)) vcr_abort("input_shape_invalid", "inputs", "Follow-up times are not negative.")
  used <- vcr_used_sources(c(list(list(df = subj, columns = c(covs, fr$tc))), .vcr_outcome_parts(sc, tabs, subj, "time_to_event")))
  est_src <- vcr_estimate_source(used$source)
  data_src <- if (is.na(used$source)) "observed" else used$source
  sources_used <- vcr_value_sources_used(used)
  events_by_arm <- c(control = sum(status[treat == 0L]), treated = sum(status[treat == 1L]))
  counts0 <- vcr_counts(realPatients = nrow(subj), events = sum(status))
  if (any(events_by_arm == 0)) {
    return(list(status = "not_estimable", notEstimableRule = "too_few_events", measures = list(), counts = counts0,
                diagnostics = list(detail = sprintf("%s has no event, so a hazard ratio does not exist", if (events_by_arm[["control"]] == 0) "the control arm" else "the trial arm"),
                                   eventsByArm = as.list(events_by_arm), cohort = cohort$info, valueSourcesUsed = sources_used)))
  }

  fit_weights <- function(Xb, tb) {
    if (identical(weighting, "entropy_balance")) vcr_att_entropy_weights(Xb, tb, vcr_scalar(sc$moments, 1L))
    else list(allWeights = vcr_propensity_weights(Xb, tb, estimand)$weights)
  }
  fit <- if (identical(weighting, "entropy_balance")) fit_weights(X, treat)
         else { p <- vcr_propensity_weights(X, treat, estimand); list(allWeights = p$weights, converged = TRUE, propensity = p$propensity, rule = NULL) }
  if (is.null(fit$allWeights)) {
    return(list(status = "not_estimable", notEstimableRule = fit$rule %||% "entropy_balance_infeasible", measures = list(),
                counts = vcr_counts(realPatients = nrow(subj), events = sum(status)),
                diagnostics = list(detail = fit$detail, method = weighting, cohort = cohort$info, valueSourcesUsed = sources_used)))
  }
  w <- fit$allWeights
  balance <- vcr_balance_table(X, treat, w, estimand)
  ps <- vcr_propensity_weights(X, treat, "ATT")$propensity
  support <- vcr_common_support(ps, treat)
  ess <- vcr_ess(w[treat == 0L])
  rule <- vcr_not_estimable_weighting(balance = balance, ess = ess, support = support,
                                      ebal = if (identical(weighting, "entropy_balance")) fit else NULL)
  limits_used <- list(essFloor = vcr_limit("essFloor", 10), supportCeiling = vcr_limit("supportCeiling", 0.1),
                      smdFloor = vcr_limit("smdFloor", 0.1), bootstrapMin = vcr_limit("bootstrapMin", 2000),
                      coxFewEvents = vcr_limit("coxFewEvents", 10))
  wdiag <- vcr_weight_diagnostics(w, treat)
  if (!is.null(rule)) {
    return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(),
                counts = vcr_counts(realPatients = nrow(subj), effectiveSampleSize = ess, events = sum(status)),
                diagnostics = list(detail = rule$detail, balance = balance, support = support, weights = wdiag,
                                   thresholds = limits_used, cohort = cohort$info, valueSourcesUsed = sources_used)))
  }

  primary <- vcr_cox_primary(time, status, treat, w, ties, ph_transform)
  if (!isTRUE(primary$ok)) {
    return(list(status = "not_estimable", notEstimableRule = "too_few_events", measures = list(),
                counts = vcr_counts(realPatients = nrow(subj), effectiveSampleSize = ess, events = sum(status)),
                diagnostics = list(detail = "the weighted Cox fit did not converge or has an infinite coefficient: the events are too few or too one-sided",
                                   eventsByArm = as.list(events_by_arm), balance = balance, support = support, weights = wdiag, thresholds = limits_used,
                                   cohort = cohort$info, valueSourcesUsed = sources_used)))
  }
  beta <- primary$beta
  tau_rule <- vcr_tau_rule(time, status, treat, tau)
  with_rmst <- is.null(tau_rule)

  # the log hazard ratio first, then (when tau is usable) the RMST battery the weighting job reports; every
  # component shares the resamples, and every resample re-estimates the weights
  est_of <- function(wv, idx) {
    tb <- treat[idx]; tm <- time[idx]; st <- status[idx]
    b <- vcr_cox_beta(tm, st, tb, wv, ties)
    if (!with_rmst) return(b)
    r1 <- vcr_rmst(tm[tb == 1L], st[tb == 1L], tau, wv[tb == 1L], variance = FALSE)
    r0 <- vcr_rmst(tm[tb == 0L], st[tb == 0L], tau, wv[tb == 0L], variance = FALSE)
    c(b, r1$rmst - r0$rmst, r1$rmst, r0$rmst, vcr_km_at(r1$km, tau) - vcr_km_at(r0$km, tau))
  }
  all_idx <- seq_len(nrow(subj))
  est <- est_of(w, all_idx)
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(nrow(subj), function(idx) {
    f <- fit_weights(X[idx, , drop = FALSE], treat[idx])
    if (is.null(f$allWeights)) return(rep(NA_real_, length(est)))
    est_of(f$allWeights, idx)
  }, replicates = B, seed = job$seed, strata = treat, cores = vcr_cores(job$cores))
  if (identical(boot$interrupted, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = nrow(subj)),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  z <- stats::qnorm(0.975)
  unit <- as.character(sc$timeUnit %||% "months")
  hr_robust <- vcr_interval("confidence", exp(beta - z * primary$seRobust), exp(beta + z * primary$seRobust))
  base_measures <- list(
    vcr_measure("hazard_ratio_robust", exp(beta), interval = hr_robust, source = est_src),
    vcr_measure("log_hazard_ratio_se_robust", primary$seRobust, source = est_src))
  gph <- if (is.null(primary$ph)) NULL else primary$ph$global
  ph_measures <- if (is.null(gph) || !all(is.finite(c(gph$chisq, gph$p)))) list() else list(
    vcr_measure("ph_test_chisq", gph$chisq, source = est_src), vcr_measure("ph_test_p", gph$p, source = est_src))
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    # the budget ran out inside the bootstrap: what was computed is kept (the point estimate, the robust variance, the
    # proportional-hazards test), the bootstrap interval is not invented, and the result says it stopped
    return(list(status = "failed", measures = c(base_measures, ph_measures),
                counts = vcr_counts(realPatients = nrow(subj), effectiveSampleSize = ess, events = sum(status)),
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap; the robust estimate is kept and no bootstrap interval is reported.")),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B, valueSourcesUsed = sources_used)))
  }
  bs <- vcr_boot_summary(boot, 1L, exp)
  ci <- function(j) { iv <- boot$intervals[j, ]; if (anyNA(iv)) NULL else vcr_interval("confidence", iv[1], iv[2]) }
  measures <- c(
    list(vcr_measure("hazard_ratio", exp(beta), interval = if (is.null(bs$interval)) NULL else vcr_interval("confidence", bs$interval[1], bs$interval[2]), source = est_src)),
    base_measures,
    Filter(Negate(is.null), list(vcr_boot_se_measure("log_hazard_ratio_se_bootstrap", bs, est_src))),
    ph_measures,
    if (with_rmst) list(
      vcr_measure("rmst_difference", est[2], unit = unit, interval = ci(2), source = est_src),
      vcr_measure("rmst_treatment", est[3], unit = unit, interval = ci(3), source = est_src),
      vcr_measure("rmst_control", est[4], unit = unit, interval = ci(4), source = est_src),
      vcr_measure("survival_difference_at_tau", est[5], interval = ci(5), source = est_src)),
    list(vcr_measure("effective_sample_size", ess, source = est_src),
         vcr_measure("worst_standardized_difference", max(abs(balance$smdAdjusted)), source = est_src)))

  # weight truncation as a sensitivity analysis only, as in the weighting job (plan 5.3)
  cap <- stats::quantile(w[treat == 0L], 0.99, names = FALSE)
  wt <- w; wt[treat == 0L] <- pmin(wt[treat == 0L], cap)
  if (identical(estimand, "ATT")) wt[treat == 0L] <- wt[treat == 0L] * sum(treat == 1L) / sum(wt[treat == 0L])
  trunc_beta <- vcr_cox_beta(time, status, treat, wt, ties)

  tt_limits <- .vcr_target_trial_limits(sc)
  changed <- !identical(estimand, "ATT")
  ph_rejected <- !is.null(gph) && isTRUE(gph$p < ph_alpha)
  few <- unname(events_by_arm[events_by_arm < vcr_limit("coxFewEvents", 10)])
  limited_by <- c(if (bs$failureShare > 0.01) "bootstrap_failure_share",
                  if (changed) "estimand_changed_from_att",
                  if (length(tt_limits)) "target_trial_item_cannot_be_emulated",
                  if (ph_rejected) "proportional_hazards_rejected",
                  if (!with_rmst) "rmst_companion_unavailable",
                  if (length(few)) "few_events")
  ph_block <- if (is.null(primary$ph)) list(available = FALSE) else list(
    available = TRUE, test = "cox.zph", transform = ph_transform, alpha = ph_alpha, rejected = ph_rejected,
    global = primary$ph$global, perTerm = primary$ph$perTerm,
    basis = "weighted score test of the Grambsch-Therneau residuals, the weights treated as fixed: descriptive when the weights were estimated",
    rule = "declared before the data was read; the estimator is not switched by this result: the hazard ratio stays reported and the RMST difference stands beside it")
  schoenfeld <- if (is.null(primary$ph)) NULL else cbind(primary$ph$schoenfeld, beta = beta)
  list(status = "succeeded", measures = measures,
       conclusion = if (length(limited_by)) "limited" else "estimable",
       counts = vcr_counts(realPatients = nrow(subj), effectiveSampleSize = ess, events = sum(status)),
       diagnostics = list(
         method = weighting, estimand = estimand, endpoint = "time_to_event", tau = tau, timeUnit = unit,
         model = list(formula = "Surv(time, status) ~ arm", ties = ties, weights = "case weights, estimated inside the job",
                      coding = "arm 1 (the trial) against arm 0 (the control); the hazard ratio is the trial's"),
         eventsByArm = as.list(events_by_arm),
         robust = list(se = primary$seRobust, seModel = primary$seModel, interval = c(exp(beta - z * primary$seRobust), exp(beta + z * primary$seRobust)),
                       basis = "Lin-Wei sandwich on the weighted partial likelihood; the weights are treated as known"),
         bootstrap = vcr_boot_diagnostics(bs, B, "rows resampled within arm; the weights are re-estimated and the Cox model refitted in every resample",
                                          se_scale = "log hazard ratio", interval_scale = "hazard ratio"),
         varianceComparison = list(robustSe = primary$seRobust, bootstrapSe = bs$se, ratioRobustToBootstrap = primary$seRobust / bs$se,
                                   note = "a metric, never a gate: the robust variance is biased low when the effective sample size is small (Chandler & Proskorovsky 2024)"),
         proportionalHazards = ph_block,
         rmstCompanion = if (with_rmst) list(available = TRUE, tau = tau, source = "calculated")
                         else c(list(available = FALSE), tau_rule),
         curves = vcr_arm_curves(time, status, treat, weights = w, source = data_src, tau = if (with_rmst) tau else NULL),
         estimandChanged = changed, balance = balance, support = support, weights = wdiag, thresholds = limits_used,
         sensitivity = list(truncatedWeights = list(quantile = 0.99, hazardRatio = if (is.finite(trunc_beta)) exp(trunc_beta) else NULL)),
         limitedBy = as.list(limited_by), targetTrialCannot = as.list(tt_limits), cohort = cohort$info,
         valueSourcesUsed = sources_used, comparabilityDimensions = vcr_domain()$comparabilityDimensions),
       tables = .vcr_tables_of(list(
         vcr_write_table(balance, "balance", output_dir),
         vcr_write_table(data.frame(row = which(keep), arm = treat, weight = w), "weights", output_dir),
         if (!is.null(schoenfeld)) vcr_write_table(schoenfeld, "ph-schoenfeld", output_dir))))
}
