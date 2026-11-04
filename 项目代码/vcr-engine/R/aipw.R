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
# - **A time-to-event outcome enters as pseudo-observations, not as a new estimator** (1.3.0, algorithm round C8). The estimand is
#   the restricted mean survival time up to tau or the survival probability at tau; each person gets the Kaplan-Meier value of
#   his own arm plus his influence on it (Andersen & Perme 2010: theta_i = theta + IF_i, which is the infinitesimal jackknife), the
#   pseudo-observations are a continuous outcome with no censoring left in it, and the augmented estimator above runs on them
#   unchanged. The alternative, an augmented IPCW estimator (Bai, Tsiatis & O'Brien 2013), needs a censoring model and a second set of
#   nuisance parameters; the pseudo-observation route needs only that censoring does not depend on the covariates within an arm (the
#   result says so as a premise). The leave-one-out jackknife is O(n^2) per bootstrap resample - minutes for one interval - while the
#   influence function is O(n log n) and differs from it by O(1/n) (case N71a holds both). The mean of an arm's pseudo-observations
#   is exactly its Kaplan-Meier value, so the trial arm's mean here is the trial's RMST or survival and nothing estimated.
# - **Trimming is by the propensity score, redone in every resample** (1.3.0, C14): the score is fitted on everybody, the people
#   outside the bounds are removed, and both models are fitted on who is left. The result restates who was removed
#   (`diagnostics.trim`, `vcr_trim_restatement`).
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

#' Kaplan-Meier pseudo-observations of one arm: `estimate + IF_i`, the infinitesimal jackknife of the Kaplan-Meier restricted mean
#' survival time up to `tau` (`summary = "rmst"`) or survival probability at `tau` (`"survival"`). Their mean is the Kaplan-Meier
#' value exactly. With `h(u) = n / Y(u)` (the inverse at-risk fraction) and `C(s)` the sum of `h d / Y` over the event times up to s,
#'   IF_i(t) = -S(t) [ delta_i 1(T_i <= t) h(T_i) - C(min(T_i, t)) ],
#' and the restricted mean's influence is its integral over [0, tau], done in closed form on the event-time grid.
#' @return list(pseudo, estimate)
vcr_km_pseudo <- function(time, status, tau, summary = c("rmst", "survival")) {
  summary <- match.arg(summary)
  n <- length(time)
  ut <- sort(unique(time[status == 1L & time <= tau]))
  K <- length(ut)
  if (K == 0L) return(list(pseudo = rep(if (identical(summary, "rmst")) tau else 1, n), estimate = if (identical(summary, "rmst")) tau else 1))
  Y <- vapply(ut, function(t) sum(time >= t), numeric(1))
  d <- vapply(ut, function(t) sum(time == t & status == 1L), numeric(1))
  S <- cumprod(1 - d / Y)                         # S at u_k, right after the jump
  h <- n / Y
  Cs <- cumsum(h * d / Y)                         # C at u_k
  # a right-continuous step function's value at s: index 0 is the value before the first event time
  Sat <- function(s) c(1, S)[findInterval(s, ut) + 1L]
  Cat <- function(s) c(0, Cs)[findInterval(s, ut) + 1L]
  ti <- pmin(time, tau)
  event_i <- status == 1L & time <= tau
  hi <- h[match(time, ut)]                         # h at the person's own event time (NA for a censored person)
  if (identical(summary, "survival")) {
    s_tau <- Sat(tau)
    IF <- -s_tau * (ifelse(event_i, hi, 0) - Cat(ti))
    return(list(pseudo = s_tau + IF, estimate = s_tau))
  }
  # the restricted mean: S and S C are step functions on the grid, integrated exactly
  edges <- c(0, ut); S_after <- c(1, S); SC_after <- c(0, S * Cs)
  seg <- diff(c(edges, tau)); seg[seg < 0] <- 0
  # the grid ends at the last event time <= tau; the last segment runs to tau
  G1_nodes <- c(0, cumsum(S_after * seg))
  G2_nodes <- c(0, cumsum(SC_after * seg))
  G <- function(nodes, after, s) { k <- findInterval(s, ut); nodes[k + 1L] + after[k + 1L] * (s - edges[k + 1L]) }
  G1_tau <- G(G1_nodes, S_after, tau)
  G1_i <- G(G1_nodes, S_after, ti); G2_i <- G(G2_nodes, SC_after, ti)
  IF <- -(ifelse(event_i, hi * (G1_tau - G(G1_nodes, S_after, time)), 0) - G2_i - Cat(ti) * (G1_tau - G1_i))
  list(pseudo = G1_tau + IF, estimate = G1_tau)
}

#' The ATT-AIPW estimate of a time-to-event outcome: pseudo-observations per arm, then the continuous-outcome estimator on them.
vcr_aipw_tte_att <- function(time, status, treat, Xps, Xout, tau, summary, with_if = TRUE, cap = NULL) {
  y <- numeric(length(time))
  for (a in 0:1) y[treat == a] <- vcr_km_pseudo(time[treat == a], status[treat == a], tau, summary)$pseudo
  out <- vcr_aipw_att(y, treat, Xps, Xout, FALSE, with_if = with_if, cap = cap)
  out$pseudo <- y
  out
}

#' The propensity score of the trial against the external source, on its covariates (a logistic model, main effects), or NULL when the
#' model has collinear covariates.
vcr_aipw_score <- function(Xps, treat) {
  d <- as.data.frame(Xps); d$..t.. <- treat
  fit <- suppressWarnings(stats::glm(..t.. ~ ., data = d, family = stats::binomial()))
  if (anyNA(stats::coef(fit))) NULL else as.vector(stats::fitted(fit))
}

vcr_job_aipw <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  tabs <- vcr_job_tables(job)
  endpoint <- as.character(sc$endpoint$type %||% "")
  if (!(endpoint %in% c("continuous", "binary", "time_to_event"))) vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "A doubly robust comparison is for a continuous, a binary or a time-to-event outcome.")
  binary <- identical(endpoint, "binary"); tte <- identical(endpoint, "time_to_event")
  covs <- vcr_chr(sc$covariates)
  ps_covs <- if (!is.null(sc$propensityCovariates)) vcr_chr(sc$propensityCovariates) else covs
  out_covs <- if (!is.null(sc$outcomeCovariates)) vcr_chr(sc$outcomeCovariates) else covs
  if (!length(ps_covs)) vcr_abort("scenario_field_missing", "scenario.propensityCovariates", "The propensity model names its covariates.")
  if (!length(out_covs)) vcr_abort("scenario_field_missing", "scenario.outcomeCovariates", "The outcome model names its covariates.")
  all_covs <- unique(c(ps_covs, out_covs))
  fr <- vcr_comparison_frame(job, sc, tabs, "A doubly robust comparison", all_covs)
  subj <- fr$subj; treat <- fr$treat; cohort <- fr$cohort; keep <- fr$keep
  y <- NULL; time <- NULL; status <- NULL; tau <- NULL; summary <- "rmst"; time_unit <- NULL; oc <- NULL
  if (tte) {
    tau <- vcr_scalar(sc$tau, NULL)
    if (is.null(tau) || !(tau > 0)) vcr_abort("scenario_field_missing", "scenario.tau", "A time-to-event doubly robust comparison states the horizon tau (the restricted-mean horizon, or the time the survival is read at).")
    summary <- as.character(sc$summary %||% "rmst")
    if (!(summary %in% c("rmst", "survival"))) vcr_abort("scenario_value_invalid", "scenario.summary", "The summary is rmst (the restricted mean survival time up to tau) or survival (the survival probability at tau).")
    time_unit <- .vcr_observed_time_unit(job, tabs, subj)
    outcome <- vcr_outcome_frame(sc, tabs, subj, "time_to_event")
    time <- outcome$time; status <- outcome$status
    if (anyNA(time) || anyNA(status)) vcr_abort("input_shape_invalid", "inputs", "Time and status are complete.")
    if (any(time < 0)) vcr_abort("input_shape_invalid", "inputs", "Follow-up times are not negative.")
  } else {
    oc <- .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn")
    if (!(oc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome column is not in the table.")
    y <- suppressWarnings(as.numeric(subj[[oc]]))
    if (anyNA(y)) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome is a number, complete.")
    if (binary && !all(y %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "A binary outcome is 0/1.")
  }
  Xall <- fr$X
  Xps <- Xall[, ps_covs, drop = FALSE]; Xout <- Xall[, out_covs, drop = FALSE]
  used <- vcr_used_sources(c(list(list(df = subj, columns = c(all_covs, fr$tc, oc))), if (tte) .vcr_outcome_parts(sc, tabs, subj, "time_to_event")))
  est_src <- vcr_estimate_source(used$source)
  sources_used <- vcr_value_sources_used(used)
  n <- nrow(subj)
  if (tte) {
    tau_rule <- vcr_tau_rule(time, status, treat, tau)
    if (!is.null(tau_rule)) {
      return(list(status = "not_estimable", notEstimableRule = tau_rule$rule, measures = list(), counts = vcr_counts(realPatients = n, events = sum(status)),
                  diagnostics = c(tau_rule, list(cohort = cohort$info, valueSourcesUsed = sources_used))))
    }
  }

  # One analysis of the rows `idx` of the whole table: the trimming (when asked for) from a score fitted on those rows, then the two
  # models and the estimator on who is left. The point estimate and every bootstrap resample go through here, so the interval carries
  # the uncertainty of who is trimmed.
  trim <- sc$trim
  analyse <- function(idx, with_if = TRUE, cap = NULL) {
    tb <- treat[idx]; kept <- rep(TRUE, length(idx)); cut <- NULL
    if (!is.null(trim)) {
      e <- vcr_aipw_score(Xps[idx, , drop = FALSE], tb)
      if (is.null(e)) return(list(ok = FALSE, reason = "the propensity model has collinear covariates"))
      cut <- vcr_ps_trim(e, tb, trim); kept <- cut$keep
      if (sum(tb[kept] == 1L) < 2L || sum(tb[kept] == 0L) < 2L) return(list(ok = FALSE, reason = "trimmed_population_too_small", trim = cut, kept = kept))
    }
    j <- idx[kept]
    core <- if (tte) vcr_aipw_tte_att(time[j], status[j], treat[j], Xps[j, , drop = FALSE], Xout[j, , drop = FALSE], tau, summary, with_if, cap)
            else vcr_aipw_att(y[j], treat[j], Xps[j, , drop = FALSE], Xout[j, , drop = FALSE], binary, with_if, cap)
    core$kept <- kept; core$trim <- cut
    core
  }
  all_idx <- seq_len(n)
  core <- analyse(all_idx, TRUE)
  trim_info <- NULL
  if (!is.null(trim) && !is.null(core$trim)) trim_info <- vcr_trim_restatement(Xall, treat, core$kept, core$trim)
  if (!isTRUE(core$ok)) {
    too_small <- identical(core$reason, "trimmed_population_too_small")
    return(list(status = "not_estimable", notEstimableRule = if (too_small) "trimmed_population_too_small" else "nuisance_model_not_estimable", measures = list(), counts = vcr_counts(realPatients = n),
                diagnostics = c(list(detail = if (too_small) "after the trimming fewer than two trial or two control people remain" else core$reason,
                                     propensityCovariates = as.list(ps_covs), outcomeCovariates = as.list(out_covs),
                                     cohort = cohort$info, valueSourcesUsed = sources_used),
                                if (!is.null(trim_info)) list(trim = trim_info))))
  }
  # From here on the analysis sample is the kept people: balance, overlap, the weights table and the curves are theirs.
  kp <- core$kept
  rows_kept <- which(kp)
  treat_k <- treat[kp]; Xall_k <- Xall[kp, , drop = FALSE]; subj_k <- subj[kp, , drop = FALSE]
  n_k <- sum(kp)
  w_ctl <- core$w[treat_k == 0L]
  w_scaled <- core$w; w_scaled[treat_k == 1L] <- 1; w_scaled[treat_k == 0L] <- w_scaled[treat_k == 0L] * sum(treat_k == 1L) / sum(w_scaled[treat_k == 0L])
  # What a release added runs only for the jobs labelled with it (replay): 1.1.0 reads the weighted balance as a verdict beside the
  # estimate and adds the E-value; 1.2.0 adds the enrolment-year row. The doubly robust job never refused on the balance.
  reads_balance <- vcr_job_at_least(job, "1.1.0"); with_year <- vcr_job_at_least(job, "1.2.0")
  balance <- vcr_balance_table(Xall_k, treat_k, w_scaled, "ATT")
  enrolment <- if (with_year) vcr_enrolment_year(subj_k, tabs, sc, treat_k, w_scaled, "ATT") else NULL
  support <- vcr_common_support(core$e, treat_k)
  ess <- vcr_ess(w_ctl)
  rule <- vcr_not_estimable_weighting(ess = ess, support = support)
  limits_used <- c(list(essFloor = vcr_limit("essFloor", 10), supportCeiling = vcr_limit("supportCeiling", 0.1), smdFloor = vcr_limit("smdFloor", 0.1)),
                   if (reads_balance) list(smdSevere = vcr_limit("smdSevere", 0.25)), list(bootstrapMin = vcr_limit("bootstrapMin", 2000)))
  wdiag <- vcr_weight_diagnostics(w_scaled, treat_k)
  counts <- vcr_counts(realPatients = n, effectiveSampleSize = ess, events = if (tte) sum(status) else NULL)
  if (!is.null(rule)) {
    return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(), counts = counts,
                diagnostics = c(list(detail = rule$detail, balance = balance), if (with_year) list(enrolmentYear = enrolment),
                                list(support = support, weights = wdiag, thresholds = limits_used, cohort = cohort$info, valueSourcesUsed = sources_used),
                                if (!is.null(trim_info)) list(trim = trim_info))))
  }

  # An arm with no event up to tau has constant Kaplan-Meier pseudo-observations: the arm's estimate is a number (1, or tau), but its
  # influence function is identically zero, so the standard error and the interval of the difference come from the OTHER arm alone and are
  # an artefact, not knowledge (all censored: a difference of 0 with a standard error of 3e-16; one arm with no events: an interval as narrow
  # as one arm's). The estimate is kept and said to be limited; the standard errors and intervals are withheld.
  no_event_arm <- if (tte) vapply(0:1, function(a) { i <- rows_kept[treat_k == a]; !any(status[i] == 1L & time[i] <= tau) }, logical(1)) else c(FALSE, FALSE)
  degenerate <- any(no_event_arm)

  # the whole pipeline in every resample: the trimming, both models refitted, the estimate recomputed
  k <- length(core$estimates)
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(n, function(idx) {
    r <- analyse(idx, with_if = FALSE)
    if (!isTRUE(r$ok)) return(rep(NA_real_, k))
    r$estimates
  }, replicates = B, seed = job$seed, strata = treat, cores = vcr_cores(job$cores),
  components = c("aipw_difference", "aipw_risk_ratio", "aipw_odds_ratio")[seq_len(k)])
  if (identical(boot$interrupted, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = n),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  z <- stats::qnorm(0.975)
  tau_hat <- core$tau; se_if <- core$influence$se
  unit <- if (tte && identical(summary, "rmst")) time_unit$unit else NULL
  wald <- function(b, se, transform = identity) vcr_interval("confidence", transform(b - z * se), transform(b + z * se))
  base_measures <- c(
    list(vcr_measure("aipw_difference_influence", tau_hat, unit = unit, interval = wald(tau_hat, se_if), source = est_src),
         vcr_measure("aipw_difference_se_influence", se_if, unit = unit, source = est_src),
         vcr_measure("outcome_mean_treated", core$mu1, unit = unit, source = est_src),
         vcr_measure("outcome_mean_control_adjusted", core$mu0, unit = unit, source = est_src)),
    list(vcr_measure("effective_sample_size", ess, source = est_src),
         vcr_measure("worst_standardized_difference", max(abs(balance$smdAdjusted)), source = est_src)))
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    return(list(status = "failed", measures = c(list(vcr_measure("aipw_difference", tau_hat, unit = unit, source = est_src)), base_measures), counts = counts,
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
    list(vcr_measure("aipw_difference", tau_hat, unit = unit, interval = bint(bs), source = est_src)),
    base_measures[1:2],
    Filter(Negate(is.null), list(vcr_boot_se_measure("aipw_difference_se_bootstrap", bs, est_src))),
    base_measures[3:4],
    if (binary) Filter(Negate(is.null), list(ratio_measure("aipw_risk_ratio", 2L, core$estimates[["logRiskRatio"]]),
                                              ratio_measure("aipw_odds_ratio", 3L, core$estimates[["logOddsRatio"]]))),
    base_measures[5:6])

  # weight truncation as a sensitivity analysis only, as in the weighting jobs (plan 5.3); on the kept people
  cap <- stats::quantile(w_ctl, 0.99, names = FALSE)
  trunc <- {
    j <- rows_kept
    if (tte) vcr_aipw_tte_att(time[j], status[j], treat[j], Xps[j, , drop = FALSE], Xout[j, , drop = FALSE], tau, summary, FALSE, cap)
    else vcr_aipw_att(y[j], treat[j], Xps[j, , drop = FALSE], Xout[j, , drop = FALSE], binary, with_if = FALSE, cap = cap)
  }
  # the E-value of the risk ratio of a binary outcome, after the estimate and beside it (A5); a continuous or a time-to-event outcome has no ratio
  rr_measure <- Filter(function(m) identical(m$name, "aipw_risk_ratio"), measures)
  evalue <- if (reads_balance && binary && length(rr_measure)) {
    m <- rr_measure[[1]]
    vcr_evalue_after(m$value, m$interval$low, m$interval$high, "risk_ratio", FALSE, est_src)
  } else NULL
  if (!is.null(evalue)) measures <- c(measures, evalue$measures)
  trimmed_someone <- !is.null(trim_info) && trim_info$removedTotal > 0L
  if (!is.null(trim_info)) measures <- c(measures, list(
    vcr_measure("trimmed_treated", trim_info$arms[[1]]$removed, unit = "例", source = "calculated"),
    vcr_measure("trimmed_control", trim_info$arms[[2]]$removed, unit = "例", source = "calculated")))
  tt_limits <- .vcr_target_trial_limits(sc)
  verdict <- if (reads_balance) vcr_balance_verdict(balance) else NULL
  # before the verdict, a weighted covariate still apart by the floor was said by this one code and nothing else
  smd_notice <- !reads_balance && is.finite(max(abs(balance$smdAdjusted))) && max(abs(balance$smdAdjusted)) >= limits_used$smdFloor
  limited_by <- c(if (degenerate) "arm_without_events_before_tau",
                  if (bs$failureShare > 0.01) "bootstrap_failure_share",
                  if (trimmed_someone) "target_population_trimmed",
                  if (length(tt_limits)) "target_trial_item_cannot_be_emulated",
                  if (smd_notice) "standardized_difference_above_floor",
                  vcr_balance_limit(verdict),
                  if (isTRUE(core$separation)) "outcome_model_separation",
                  if (binary && (core$mu0 < 0 || core$mu0 > 1)) "adjusted_control_mean_outside_unit_interval",
                  if (!core$psConverged || !core$outConverged) "nuisance_model_not_converged")
  scale_word <- if (tte) (if (identical(summary, "rmst")) "restricted mean survival time difference" else "survival difference") else if (binary) "risk difference" else "mean difference"
  influence_block <- list(se = se_if, interval = c(tau_hat - z * se_if, tau_hat + z * se_if),
                          riskRatio = if (binary && is.finite(core$influence$seLogRiskRatio)) list(se = core$influence$seLogRiskRatio, scale = "log risk ratio") else NULL,
                          oddsRatio = if (binary && is.finite(core$influence$seLogOddsRatio)) list(se = core$influence$seLogOddsRatio, scale = "log odds ratio") else NULL,
                          basis = "efficient influence function of the ATT with the nuisance estimates plugged in; it ignores the estimation of the two models")
  res <- list(status = "succeeded", measures = measures, conclusion = if (length(limited_by)) "limited" else "estimable", counts = counts,
       diagnostics = c(list(
         method = "aipw", estimand = "ATT", endpoint = endpoint, scale = scale_word,
         nuisance = list(propensity = list(covariates = as.list(ps_covs), family = "binomial", converged = core$psConverged),
                         outcome = list(covariates = as.list(out_covs), family = if (binary) "binomial" else "gaussian", fittedOn = "external controls only",
                                        controlsUsed = sum(treat_k == 0L), converged = core$outConverged, separation = isTRUE(core$separation))),
         components = list(outcomeRegression = core$regression, weighting = core$weighting, aipw = tau_hat,
                           note = "the plug-in of the outcome model and the odds-weighted control mean beside the augmented estimate; their agreement is what double robustness looks like when both models are right"),
         influence = influence_block,
         bootstrap = vcr_boot_diagnostics(bs, B, if (is.null(trim)) "rows resampled within arm; the propensity and the outcome model are both refitted in every resample"
                                                 else "rows resampled within arm; the trimming, the propensity model and the outcome model are all redone in every resample",
                                          se_scale = scale_word, interval_scale = scale_word),
         varianceComparison = list(influenceSe = se_if, bootstrapSe = bs$se, ratioInfluenceToBootstrap = se_if / bs$se,
                                   note = "a metric, never a gate: the influence-function standard error ignores the estimation of the two models")),
         if (tte) list(timeToEvent = list(summary = summary, tau = tau, timeUnit = time_unit,
                                          outcome = "Kaplan-Meier pseudo-observations of each arm (the influence function of the estimate), then the continuous-outcome estimator",
                                          censoring = "independent of the covariates within an arm",
                                          eventsByArm = list(control = sum(status[treat == 0L]), treated = sum(status[treat == 1L])),
                                          treatedArmEstimate = core$mu1)),
         if (reads_balance) list(eValue = if (!is.null(evalue)) evalue$diagnostics else .vcr_evalue_absent(if (tte) "time_to_event_difference_has_no_ratio" else if (binary) "no_risk_ratio" else "continuous_outcome")),
         if (!is.null(trim_info)) list(trim = trim_info),
         list(balance = balance),
         if (with_year) list(enrolmentYear = enrolment),
         if (reads_balance) list(balanceVerdict = verdict),
         list(support = support, weights = wdiag, thresholds = limits_used,
         sensitivity = list(truncatedWeights = list(quantile = 0.99, primaryEstimate = if (isTRUE(trunc$ok)) trunc$tau else NULL)),
         limitedBy = as.list(limited_by), targetTrialCannot = as.list(tt_limits), cohort = cohort$info,
         valueSourcesUsed = sources_used, comparabilityDimensions = vcr_domain()$comparabilityDimensions)),
       tables = .vcr_tables_of(list(
         vcr_write_table(balance, "balance", output_dir),
         vcr_write_table(data.frame(row = which(keep)[rows_kept], arm = treat_k, propensity = core$e, oddsWeight = core$w, outcomePrediction = core$m0), "weights", output_dir))))
  if (degenerate) {
    withheld <- c("aipw_difference_influence", "aipw_difference_se_influence", "aipw_difference_se_bootstrap")
    res$measures <- lapply(Filter(function(m) !(m$name %in% withheld), res$measures), function(m) { if (identical(m$name, "aipw_difference")) m$interval <- NULL; m })
    res$diagnostics$influence <- list(withheld = TRUE, basis = "the Kaplan-Meier influence function of an arm with no event up to tau is zero, so a standard error from it describes the other arm only")
    res$diagnostics$bootstrap <- NULL; res$diagnostics$varianceComparison <- NULL
    res$diagnostics$timeToEvent$noEventArm <- list(
      arms = as.list(c("control", "treated")[no_event_arm]),
      reason = "an arm has no event up to tau: its estimate is the Kaplan-Meier value of an arm that never failed, and no standard error or interval is reported for the difference")
  }
  res
}
