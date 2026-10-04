# ---------------------------------------------------------------------------
# aipw.R — an augmented inverse-probability-weighted (doubly robust) estimator of
# the effect in the trial's own population (the ATT) for a single-arm study
# against an external control (comparator.aipw; Bang & Robins 2005, Hahn 1998).
#
# Hidden knowledge:
#
# - **The estimator is consistent when EITHER working model is right, and that is
#   the whole reason to use it.** The propensity model says who is in the trial
#   rather than the external source (logistic); the outcome model is fitted on the
#   EXTERNAL CONTROLS ONLY (what the trial's patients would have had on the
#   control) and predicted for everyone. The counterfactual control mean of the
#   trial's patients is
#       mu0 = [ sum_{trial} m0(X) + sum_{control} e/(1-e) * (Y - m0(X)) ] / n_trial
#   (the plug-in of the outcome model plus the odds-weighted residuals of the
#   controls), and the effect is mean_{trial}(Y) - mu0. A good outcome model leaves
#   residuals that average to zero whatever the weights; good weights make the
#   residual term cancel the outcome model's bias. Case N35 shows it by simulation
#   against a known truth: one model wrong leaves no bias, both wrong does.
# - **Two standard errors, both reported.** The influence-function one uses the
#   efficient influence function of the ATT with the nuisance estimates plugged
#   in; it is the textbook interval when both models are right and is what a
#   reader recomputes by hand. It ignores the estimation of the two models, so it
#   is not the headline: the whole-pipeline bootstrap (rows resampled within arm,
#   BOTH models refitted in every resample) is, as Campbell & Remiro-Azocar (2025)
#   recommend for externally controlled single-arm trials. Their ratio is a metric.
# - **The weights are not rescaled.** The augmentation term needs the odds
#   e/(1-e) themselves; the engine's other propensity route rescales the control
#   weights to sum to the trial size (a normalised, Hajek-type weighting), which
#   is a different estimator. The balance table and the effective sample size are
#   read on the rescaled weights, as everywhere else, because the scale does not
#   change either.
# - **Balance is a notice here, not a refusal.** The outcome model is what carries
#   the residual imbalance, so the standardized-difference rule that stops a
#   weighting-only comparison does not stop this one; overlap (the common-support
#   rule) and the effective sample size still do, because no model rescues a trial
#   patient with no comparable control.
# - **Truncation is a sensitivity analysis only**, as in the weighting jobs: the
#   odds weights capped at the 99th percentile of the controls', re-estimated.
# ---------------------------------------------------------------------------

#' The ATT-AIPW estimate from the two nuisance models. `Xps` and `Xout` are the
#' covariate matrices of the propensity and the outcome model (they may differ).
#' Returns `ok = FALSE` and a reason when a model cannot be fitted: collinear
#' covariates, fewer controls than the outcome model has coefficients, or a
#' control whose propensity score is exactly 1. With `with_if` the efficient
#' influence function's standard errors come with it. `cap`, when given, truncates
#' the control odds weights there (the sensitivity analysis).
vcr_aipw_att <- function(y, treat, Xps, Xout, binary, with_if = TRUE, cap = NULL) {
  ctl <- treat == 0L; t1 <- !ctl
  n1 <- sum(t1); N <- length(y)
  if (n1 < 1L || sum(ctl) < 1L) return(list(ok = FALSE, reason = "a group is empty"))
  dps <- as.data.frame(Xps); dps$..t.. <- treat
  ps_fit <- suppressWarnings(stats::glm(..t.. ~ ., data = dps, family = stats::binomial()))
  if (anyNA(stats::coef(ps_fit))) return(list(ok = FALSE, reason = "the propensity model has collinear covariates"))
  if (sum(ctl) < ncol(Xout) + 2L) return(list(ok = FALSE, reason = "the external controls are fewer than the outcome model's coefficients"))
  dout <- as.data.frame(Xout); dout$..y.. <- y
  out_fit <- suppressWarnings(stats::glm(..y.. ~ ., data = dout[ctl, , drop = FALSE], family = if (binary) stats::binomial() else stats::gaussian()))
  if (anyNA(stats::coef(out_fit))) return(list(ok = FALSE, reason = "the outcome model has collinear covariates among the external controls"))
  e <- as.vector(stats::fitted(ps_fit))
  m0 <- as.vector(stats::predict(out_fit, newdata = dout, type = "response"))
  w <- e / (1 - e)
  if (!all(is.finite(w[ctl])) || !all(is.finite(m0))) return(list(ok = FALSE, reason = "the propensity model separates the two sources (a control with a score of 1)"))
  if (!is.null(cap)) w <- pmin(w, cap)
  res <- y - m0
  mu1 <- mean(y[t1])
  mu0 <- (sum(m0[t1]) + sum(w[ctl] * res[ctl])) / n1
  tau <- mu1 - mu0
  est <- c(tau = tau)
  if (binary) {
    est <- c(est, logRiskRatio = if (mu1 > 0 && mu0 > 0) log(mu1 / mu0) else NA_real_,
             logOddsRatio = if (mu1 > 0 && mu1 < 1 && mu0 > 0 && mu0 < 1) stats::qlogis(mu1) - stats::qlogis(mu0) else NA_real_)
  }
  out <- list(ok = TRUE, estimates = est, tau = tau, mu1 = mu1, mu0 = mu0, e = e, w = w, m0 = m0,
              regression = mu1 - mean(m0[t1]), weighting = mu1 - sum(w[ctl] * y[ctl]) / sum(w[ctl]),
              psConverged = isTRUE(ps_fit$converged), outConverged = isTRUE(out_fit$converged),
              separation = binary && (any(m0[ctl] < 1e-8) || any(m0[ctl] > 1 - 1e-8)))
  if (with_if) {
    p <- n1 / N
    psi1 <- t1 * (y - mu1) / p
    psi0 <- (t1 * (m0 - mu0) + ctl * w * res) / p
    se <- function(psi) sqrt(stats::var(psi) / N)
    out$influence <- list(se = se(psi1 - psi0),
                          seLogRiskRatio = if (binary && is.finite(est[["logRiskRatio"]])) se(psi1 / mu1 - psi0 / mu0) else NA_real_,
                          seLogOddsRatio = if (binary && is.finite(est[["logOddsRatio"]])) se(psi1 / (mu1 * (1 - mu1)) - psi0 / (mu0 * (1 - mu0))) else NA_real_)
  }
  out
}

vcr_job_aipw <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  tabs <- vcr_job_tables(job)
  endpoint <- as.character(sc$endpoint$type %||% "")
  if (!(endpoint %in% c("continuous", "binary"))) vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "A doubly robust comparison is for a continuous or a binary outcome.")
  binary <- identical(endpoint, "binary")
  covs <- vcr_chr(sc$covariates)
  ps_covs <- if (!is.null(sc$propensityCovariates)) vcr_chr(sc$propensityCovariates) else covs
  out_covs <- if (!is.null(sc$outcomeCovariates)) vcr_chr(sc$outcomeCovariates) else covs
  if (!length(ps_covs)) vcr_abort("scenario_field_missing", "scenario.propensityCovariates", "The propensity model names its covariates.")
  if (!length(out_covs)) vcr_abort("scenario_field_missing", "scenario.outcomeCovariates", "The outcome model names its covariates.")
  all_covs <- unique(c(ps_covs, out_covs))
  fr <- vcr_comparison_frame(job, sc, tabs, "A doubly robust comparison", all_covs)
  subj <- fr$subj; treat <- fr$treat; cohort <- fr$cohort; keep <- fr$keep
  oc <- .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn")
  if (!(oc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome column is not in the table.")
  y <- suppressWarnings(as.numeric(subj[[oc]]))
  if (anyNA(y)) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome is a number, complete.")
  if (binary && !all(y %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "A binary outcome is 0/1.")
  Xall <- fr$X
  Xps <- Xall[, ps_covs, drop = FALSE]; Xout <- Xall[, out_covs, drop = FALSE]
  used <- vcr_used_sources(list(list(df = subj, columns = c(all_covs, fr$tc, oc))))
  est_src <- vcr_estimate_source(used$source)
  sources_used <- vcr_value_sources_used(used)
  n <- nrow(subj)

  core <- vcr_aipw_att(y, treat, Xps, Xout, binary)
  if (!isTRUE(core$ok)) {
    return(list(status = "not_estimable", notEstimableRule = "nuisance_model_not_estimable", measures = list(), counts = vcr_counts(realPatients = n),
                diagnostics = list(detail = core$reason, propensityCovariates = as.list(ps_covs), outcomeCovariates = as.list(out_covs),
                                   cohort = cohort$info, valueSourcesUsed = sources_used)))
  }
  w_ctl <- core$w[treat == 0L]
  w_scaled <- core$w; w_scaled[treat == 1L] <- 1; w_scaled[treat == 0L] <- w_scaled[treat == 0L] * sum(treat == 1L) / sum(w_scaled[treat == 0L])
  balance <- vcr_balance_table(Xall, treat, w_scaled, "ATT")
  support <- vcr_common_support(core$e, treat)
  ess <- vcr_ess(w_ctl)
  rule <- vcr_not_estimable_weighting(balance = NULL, ess = ess, support = support)
  limits_used <- list(essFloor = vcr_limit("essFloor", 10), supportCeiling = vcr_limit("supportCeiling", 0.1),
                      smdFloor = vcr_limit("smdFloor", 0.1), bootstrapMin = vcr_limit("bootstrapMin", 2000))
  wdiag <- vcr_weight_diagnostics(w_scaled, treat)
  counts <- vcr_counts(realPatients = n, effectiveSampleSize = ess)
  if (!is.null(rule)) {
    return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(), counts = counts,
                diagnostics = list(detail = rule$detail, balance = balance, support = support, weights = wdiag, thresholds = limits_used,
                                   cohort = cohort$info, valueSourcesUsed = sources_used)))
  }

  # the whole pipeline in every resample: both models refitted, the estimate recomputed
  k <- length(core$estimates)
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(n, function(idx) {
    r <- vcr_aipw_att(y[idx], treat[idx], Xps[idx, , drop = FALSE], Xout[idx, , drop = FALSE], binary, with_if = FALSE)
    if (!isTRUE(r$ok)) return(rep(NA_real_, k))
    r$estimates
  }, replicates = B, seed = job$seed, strata = treat, cores = vcr_cores(job$cores))
  if (identical(boot$interrupted, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = n),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  z <- stats::qnorm(0.975)
  tau <- core$tau; se_if <- core$influence$se
  wald <- function(b, se, transform = identity) vcr_interval("confidence", transform(b - z * se), transform(b + z * se))
  base_measures <- c(
    list(vcr_measure("aipw_difference_influence", tau, interval = wald(tau, se_if), source = est_src),
         vcr_measure("aipw_difference_se_influence", se_if, source = est_src),
         vcr_measure("outcome_mean_treated", core$mu1, source = est_src),
         vcr_measure("outcome_mean_control_adjusted", core$mu0, source = est_src)),
    list(vcr_measure("effective_sample_size", ess, source = est_src),
         vcr_measure("worst_standardized_difference", max(abs(balance$smdAdjusted)), source = est_src)))
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    return(list(status = "failed", measures = c(list(vcr_measure("aipw_difference", tau, source = est_src)), base_measures), counts = counts,
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap; the estimate and its influence-function standard error are kept and no bootstrap interval is reported.")),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B, valueSourcesUsed = sources_used)))
  }
  bs <- vcr_boot_summary(boot, 1L)
  bint <- function(s) if (is.null(s$interval)) NULL else vcr_interval("confidence", s$interval[1], s$interval[2])
  ratio_measure <- function(name, j, log_value) {
    if (!is.finite(log_value)) return(NULL)
    s <- vcr_boot_summary(boot, j, exp)
    vcr_measure(name, exp(log_value), interval = bint(s), source = est_src)
  }
  measures <- c(
    list(vcr_measure("aipw_difference", tau, interval = bint(bs), source = est_src)),
    base_measures[1:2],
    Filter(Negate(is.null), list(vcr_boot_se_measure("aipw_difference_se_bootstrap", bs, est_src))),
    base_measures[3:4],
    if (binary) Filter(Negate(is.null), list(ratio_measure("aipw_risk_ratio", 2L, core$estimates[["logRiskRatio"]]),
                                              ratio_measure("aipw_odds_ratio", 3L, core$estimates[["logOddsRatio"]]))),
    base_measures[5:6])

  # weight truncation as a sensitivity analysis only, as in the weighting jobs (plan 5.3)
  cap <- stats::quantile(w_ctl, 0.99, names = FALSE)
  trunc <- vcr_aipw_att(y, treat, Xps, Xout, binary, with_if = FALSE, cap = cap)
  tt_limits <- .vcr_target_trial_limits(sc)
  smd_notice <- is.finite(max(abs(balance$smdAdjusted))) && max(abs(balance$smdAdjusted)) >= limits_used$smdFloor
  limited_by <- c(if (bs$failureShare > 0.01) "bootstrap_failure_share",
                  if (length(tt_limits)) "target_trial_item_cannot_be_emulated",
                  if (smd_notice) "standardized_difference_above_floor",
                  if (isTRUE(core$separation)) "outcome_model_separation",
                  if (!core$psConverged || !core$outConverged) "nuisance_model_not_converged")
  influence_block <- list(se = se_if, interval = c(tau - z * se_if, tau + z * se_if),
                          riskRatio = if (binary && is.finite(core$influence$seLogRiskRatio)) list(se = core$influence$seLogRiskRatio, scale = "log risk ratio") else NULL,
                          oddsRatio = if (binary && is.finite(core$influence$seLogOddsRatio)) list(se = core$influence$seLogOddsRatio, scale = "log odds ratio") else NULL,
                          basis = "efficient influence function of the ATT with the nuisance estimates plugged in; it ignores the estimation of the two models")
  list(status = "succeeded", measures = measures, conclusion = if (length(limited_by)) "limited" else "estimable", counts = counts,
       diagnostics = list(
         method = "aipw", estimand = "ATT", endpoint = endpoint, scale = if (binary) "risk difference" else "mean difference",
         nuisance = list(propensity = list(covariates = as.list(ps_covs), family = "binomial", converged = core$psConverged),
                         outcome = list(covariates = as.list(out_covs), family = if (binary) "binomial" else "gaussian", fittedOn = "external controls only",
                                        controlsUsed = sum(treat == 0L), converged = core$outConverged, separation = isTRUE(core$separation))),
         components = list(outcomeRegression = core$regression, weighting = core$weighting, aipw = tau,
                           note = "the plug-in of the outcome model and the odds-weighted control mean beside the augmented estimate; their agreement is what double robustness looks like when both models are right"),
         influence = influence_block,
         bootstrap = vcr_boot_diagnostics(bs, B, "rows resampled within arm; the propensity and the outcome model are both refitted in every resample",
                                          se_scale = if (binary) "risk difference" else "mean difference", interval_scale = if (binary) "risk difference" else "mean difference"),
         varianceComparison = list(influenceSe = se_if, bootstrapSe = bs$se, ratioInfluenceToBootstrap = se_if / bs$se,
                                   note = "a metric, never a gate: the influence-function standard error ignores the estimation of the two models"),
         balance = balance, support = support, weights = wdiag, thresholds = limits_used,
         sensitivity = list(truncatedWeights = list(quantile = 0.99, primaryEstimate = if (isTRUE(trunc$ok)) trunc$tau else NULL)),
         limitedBy = as.list(limited_by), targetTrialCannot = as.list(tt_limits), cohort = cohort$info,
         valueSourcesUsed = sources_used, comparabilityDimensions = vcr_domain()$comparabilityDimensions),
       tables = .vcr_tables_of(list(
         vcr_write_table(balance, "balance", output_dir),
         vcr_write_table(data.frame(row = which(keep), arm = treat, propensity = core$e, oddsWeight = core$w, outcomePrediction = core$m0), "weights", output_dir))))
}
