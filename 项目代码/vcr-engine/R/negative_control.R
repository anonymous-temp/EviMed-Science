# ---------------------------------------------------------------------------
# negative_control.R — negative-control outcomes for an external-control
# comparison (Lipsitch, Tchetgen Tchetgen & Cohen 2010; empirical null after
# Schuemie et al. 2014).
#
# Hidden knowledge:
#
# - **A negative control is an outcome the treatment cannot plausibly affect.**
#   It is analysed with exactly the adjustment the primary outcome got (the same
#   weights, estimated once from the covariates and re-estimated in every
#   bootstrap resample), so whatever it shows is what the adjustment left
#   behind: residual confounding, or a difference in how the two sources
#   ascertain events. It cannot tell those two apart, and it cannot tell either
#   from a control that was not null after all; the verdict says what the
#   interval does, never what caused it.
# - **The screen is always reported; the calibration only when the set is big
#   enough.** An empirical null N(mu, tau^2 + se_i^2) is a two-parameter model
#   fitted to the controls' own estimates by maximum likelihood (base-R
#   `optim`). Its spread is estimated from the controls, so a handful of them
#   cannot give one: below `negativeControlCalibrationMin` (a domain preset, 30)
#   the result lists each control with its verdict and says the set is too small
#   to calibrate. It never reports a calibrated interval: that needs positive
#   controls (an injected true effect), which a single comparison does not have.
# - **A control that is not estimable is listed, not dropped.** An arm with no
#   event has no risk ratio; the control is named with the reason, left out of
#   the screen counts and of the null, and the conclusion says it was.
# - **The controls define the null, so they are not calibrated against it.**
#   A calibrated p-value is for the effect of interest (`primary`).
# - **Two ways in, one analysis.** A control is either a column of the subject
#   table (a 0/1 event indicator, analysed here) or an estimate and standard
#   error on the log scale that was analysed elsewhere (a hazard ratio of
#   another parameter, a risk ratio from another source). The second is how the
#   published reference example is reproduced; it is also how a time-to-event
#   control enters, because only a binary indicator is analysed in the engine.
# - **Deletable when** a vetted open implementation of empirical calibration
#   joins the locked library; until then this is ~40 lines of `optim`.
# ---------------------------------------------------------------------------

#' The empirical null of a set of negative-control estimates: the maximum-
#' likelihood fit of theta_i ~ N(mu, v + se_i^2) (v = tau^2), each control's own
#' standard error kept as it is, by `stats::optim` (L-BFGS-B, analytic gradient)
#' over (mu, v) with v bounded below by 0. The bound is the point: when the
#' controls carry one common bias the likelihood is maximal AT v = 0, where a
#' fit over log tau runs off to minus infinity and never "converges"; here that
#' is an ordinary converged boundary solution and the result says
#' `sdAtBoundary`. Two starts guard against a flat likelihood.
vcr_empirical_null <- function(estimate, se) {
  ok <- is.finite(estimate) & is.finite(se) & se > 0
  th <- estimate[ok]; s2 <- se[ok]^2
  k <- length(th)
  if (k < 2L) return(list(fitted = FALSE, reason = "fewer_than_two_controls", k = k))
  nll <- function(p) { v <- s2 + p[2]; 0.5 * sum(log(v) + (th - p[1])^2 / v) }
  grad <- function(p) {
    v <- s2 + p[2]; r <- th - p[1]
    c(-sum(r / v), 0.5 * sum(1 / v - r^2 / v^2))
  }
  v0 <- max(stats::var(th) - mean(s2), 1e-4)
  starts <- list(c(stats::median(th), v0), c(mean(th), 0.01))
  fits <- lapply(starts, function(p0) tryCatch(
    stats::optim(p0, nll, grad, method = "L-BFGS-B", lower = c(-Inf, 0), upper = c(Inf, Inf),
                 control = list(factr = 1e2, pgtol = 0, maxit = 2000L)), error = function(e) NULL))
  fits <- Filter(function(f) !is.null(f) && is.finite(f$value), fits)
  if (!length(fits)) return(list(fitted = FALSE, reason = "optimizer_failed", k = k))
  best <- fits[[which.min(vapply(fits, function(f) f$value, numeric(1)))]]
  v <- best$par[2]
  boundary <- v < 1e-10
  # converged means the optimality conditions hold, not that the optimizer said so: a zero
  # gradient in mu and, for v, a zero gradient inside or a gradient that pushes outward at 0
  g <- grad(best$par)
  kkt <- abs(g[1]) < 1e-6 && (if (boundary) g[2] > -1e-8 else abs(g[2]) < 1e-6)
  list(fitted = TRUE, k = k, mean = best$par[1], sd = if (boundary) 0 else sqrt(v), sdAtBoundary = boundary,
       logLikelihood = -best$value - 0.5 * k * log(2 * pi), converged = isTRUE(kkt))
}

#' Calibrated two-sided p-value of an effect (estimate, se) against an empirical
#' null: the effect is compared with N(mu, tau^2 + se^2), the spread the null
#' says a null effect of that precision has.
vcr_calibrated_p <- function(null, estimate, se) {
  z <- (estimate - null$mean) / sqrt(null$sd^2 + se^2)
  2 * stats::pnorm(-abs(z))
}

#' What the bias screen says of one control, from its interval alone.
#' `signals_bias`: the interval excludes 0. `uninformative`: it contains 0 and
#' also the effect of interest, so a bias as large as that effect is compatible
#' with the control (a control that cannot exclude the primary result's size
#' cannot reassure about it). `consistent_with_null`: the rest.
vcr_nc_verdict <- function(low, high, primary_estimate = NULL) {
  if (low > 0 || high < 0) return("signals_bias")
  if (!is.null(primary_estimate) && is.finite(primary_estimate) && low <= primary_estimate && primary_estimate <= high) return("uninformative")
  "consistent_with_null"
}

.vcr_nc_z <- stats::qnorm(0.975)

#' One scenario list item as a plain list: name, column or estimate and se.
.vcr_nc_item <- function(x, field, default_name) {
  col <- x[["column"]]; est <- x[["estimate"]]; se <- x[["se"]]
  has_col <- !is.null(col); has_est <- !is.null(est)
  if (has_col == has_est) vcr_abort("scenario_value_invalid", field, "Give either a column of the subject table or an estimate with its standard error, not both and not neither.")
  if (has_est) {
    e <- vcr_scalar(est, NA_real_); s <- vcr_scalar(se, NA_real_)
    if (is.na(e) || is.na(s) || !(s > 0)) vcr_abort("scenario_value_invalid", field, "An estimate is a finite number on the log scale and its standard error is positive.")
  }
  list(name = as.character(x[["name"]] %||% default_name), column = if (has_col) as.character(col) else NULL,
       estimate = if (has_est) e else NA_real_, se = if (has_est) s else NA_real_)
}

#' The weights of the comparison, exactly as the weighting comparators build
#' them (the same kernel, the same refusals), and the rows they were built on.
.vcr_nc_weights <- function(sc, subj, covs, tc) {
  method <- as.character(sc$weighting %||% "entropy_balance")
  estimand <- as.character(sc$estimand %||% vcr_domain()$defaultEstimand)
  if (identical(method, "entropy_balance") && !identical(estimand, "ATT")) {
    vcr_abort("scenario_value_invalid", "scenario.estimand", "Entropy balancing here reweights the controls to the treated group: it estimates the ATT and nothing else.")
  }
  if (!all(c(covs, tc) %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.covariates", "The covariates and the treatment column are in the table.")
  treat_raw <- subj[[tc]]
  if (anyNA(treat_raw) || !all(treat_raw %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 for the trial arm and 0 for the external control, complete.")
  treat <- as.integer(treat_raw)
  X <- as.matrix(subj[, covs, drop = FALSE])
  if (!is.numeric(X)) vcr_abort("input_shape_invalid", "scenario.covariates", "Covariates are numeric (code categories as indicators).")
  miss <- which(colSums(is.na(X)) > 0L)
  if (length(miss)) vcr_abort("missing_covariate", "scenario.covariates", sprintf("Covariate '%s' has missing values; weights are not estimated on incomplete rows.", covs[miss[1]]))
  if (sum(treat == 1L) < 2L || sum(treat == 0L) < 2L) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "Both groups need at least two people.")
  fit_weights <- function(Xb, tb) {
    if (identical(method, "entropy_balance")) vcr_att_entropy_weights(Xb, tb, vcr_scalar(sc$moments, 1L))
    else list(allWeights = vcr_propensity_weights(Xb, tb, estimand)$weights)
  }
  fit <- fit_weights(X, treat)
  list(method = method, estimand = estimand, X = X, treat = treat, fit = fit, fit_weights = fit_weights)
}

#' The patient-level half of the job: the weighted effect of every named column
#' (log risk ratio or log odds ratio of the 0/1 indicator), with a bootstrap in
#' which the weights are re-estimated in every resample. Returns the estimates
#' (`est`, `se`, `low`, `high`, `failureShare` per column) or a refusal result.
.vcr_nc_analyse_columns <- function(job, sc, columns, scale) {
  tabs <- vcr_job_tables(job)
  subj <- .vcr_main_table(tabs)
  vcr_require_individual(subj, "A negative-control analysis", method = "comparator.negative_control")
  cohort <- vcr_apply_downstream_cohort(subj, sc$cohortRules)
  subj <- cohort$data
  covs <- vcr_chr(sc$covariates)
  if (!length(covs)) vcr_abort("scenario_field_missing", "scenario.covariates", "A negative control analysed in the engine is adjusted like the primary outcome: name the covariates.")
  tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
  w <- .vcr_nc_weights(sc, subj, covs, tc)
  Y <- matrix(NA_real_, nrow(subj), length(columns), dimnames = list(NULL, columns))
  for (j in seq_along(columns)) {
    cn <- columns[j]
    if (!(cn %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.controls", sprintf("The outcome column '%s' is not in the table.", cn))
    y <- suppressWarnings(as.numeric(subj[[cn]]))
    if (anyNA(y)) vcr_abort("input_shape_invalid", "scenario.controls", sprintf("The outcome column '%s' has missing values.", cn))
    if (!all(y %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.controls", sprintf("The outcome column '%s' is a 0/1 event indicator.", cn))
    Y[, j] <- y
  }
  base <- list(n = nrow(subj), cohort = cohort$info, weighting = w$method, estimand = w$estimand, covariates = covs)
  if (is.null(w$fit$allWeights)) {
    return(c(base, list(refusal = list(rule = w$fit$rule %||% "entropy_balance_infeasible", detail = w$fit$detail))))
  }
  wt <- w$fit$allWeights
  balance <- vcr_balance_table(w$X, w$treat, wt, w$estimand)
  ps <- vcr_propensity_weights(w$X, w$treat, "ATT")$propensity
  support <- vcr_common_support(ps, w$treat)
  ess <- vcr_ess(wt[w$treat == 0L])
  rule <- vcr_not_estimable_weighting(balance = balance, ess = ess, support = support,
                                      ebal = if (identical(w$method, "entropy_balance")) w$fit else NULL)
  if (!is.null(rule)) return(c(base, list(refusal = rule, ess = ess)))
  effect <- function(wv, idx) {
    tb <- w$treat[idx]; Yb <- Y[idx, , drop = FALSE]
    i1 <- tb == 1L; i0 <- tb == 0L
    m1 <- colSums(Yb[i1, , drop = FALSE] * wv[i1]) / sum(wv[i1])
    m0 <- colSums(Yb[i0, , drop = FALSE] * wv[i0]) / sum(wv[i0])
    out <- if (identical(scale, "log_odds_ratio")) {
      ok <- m1 > 0 & m1 < 1 & m0 > 0 & m0 < 1
      ifelse(ok, stats::qlogis(pmin(pmax(m1, 1e-300), 1 - 1e-16)) - stats::qlogis(pmin(pmax(m0, 1e-300), 1 - 1e-16)), NA_real_)
    } else ifelse(m1 > 0 & m0 > 0, log(m1) - log(m0), NA_real_)
    as.numeric(out)
  }
  all_idx <- seq_len(nrow(subj))
  point <- effect(wt, all_idx)
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(nrow(subj), function(idx) {
    f <- w$fit_weights(w$X[idx, , drop = FALSE], w$treat[idx])
    if (is.null(f$allWeights)) return(rep(NA_real_, length(point)))
    effect(f$allWeights, idx)
  }, replicates = B, seed = job$seed, strata = w$treat, cores = vcr_cores(job$cores))
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    return(c(base, list(interrupted = boot$interrupted %||% "cpu_budget", bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  m <- boot$estimatesMatrix
  se <- vapply(seq_along(point), function(j) { d <- m[is.finite(m[, j]), j]; if (length(d) >= 2L) stats::sd(d) else NA_real_ }, numeric(1))
  c(base, list(columns = columns, est = point, se = se, low = boot$intervals[, 1], high = boot$intervals[, 2],
               failureShare = boot$componentFailureShare, ess = ess, bootstrapReplicates = boot$replicates,
               balance = balance, support = support, weights = vcr_weight_diagnostics(wt, w$treat)))
}

vcr_job_negative_control <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  scale <- as.character(sc$effectScale %||% "log_risk_ratio")
  raw <- sc$controls
  if (!is.list(raw) || !length(raw)) vcr_abort("scenario_field_missing", "scenario.controls", "A negative-control job lists the outcomes the treatment cannot affect.")
  items <- lapply(seq_along(raw), function(i) .vcr_nc_item(raw[[i]], sprintf("scenario.controls[%d]", i - 1L), sprintf("control_%d", i)))
  prim <- if (is.null(sc$primary)) NULL else .vcr_nc_item(sc$primary, "scenario.primary", "primary")
  nms <- vapply(items, function(i) i$name, character(1))
  if (anyDuplicated(nms)) vcr_abort("scenario_value_invalid", "scenario.controls", "Negative-control names are distinct.")
  columns <- unique(c(unlist(lapply(items, function(i) i$column)), prim$column))
  if (length(columns) && (identical(as.character(sc$endpoint$type %||% ""), "time_to_event") || identical(scale, "log_hazard_ratio"))) {
    vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "A control analysed in the engine is a 0/1 event indicator (a risk ratio or an odds ratio); a hazard ratio is supplied as an estimate with its standard error.")
  }
  an <- if (length(columns)) .vcr_nc_analyse_columns(job, sc, columns, scale) else NULL
  if (!is.null(an$refusal)) {
    return(list(status = "not_estimable", notEstimableRule = an$refusal$rule, measures = list(),
                counts = vcr_counts(realPatients = an$n),
                diagnostics = list(detail = an$refusal$detail, weighting = an$weighting, cohort = an$cohort)))
  }
  if (!is.null(an$interrupted)) {
    if (identical(an$interrupted, "canceled")) {
      return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = an$n),
                  diagnostics = list(bootstrapCompleted = an$bootstrapCompleted, bootstrapRequested = an$bootstrapRequested)))
    }
    return(list(status = "failed", measures = list(), counts = vcr_counts(realPatients = an$n),
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap; no interval is reported.")),
                diagnostics = list(bootstrapCompleted = an$bootstrapCompleted, bootstrapRequested = an$bootstrapRequested)))
  }
  # one estimate, standard error and interval per control, whichever way it came
  analyse <- function(item) {
    if (!is.null(item$column)) {
      j <- match(item$column, an$columns)
      est <- an$est[j]; se <- an$se[j]; lo <- an$low[j]; hi <- an$high[j]; fs <- an$failureShare[j]
      basis <- "bootstrap_weights_reestimated"
      reason <- if (!is.finite(est)) "no_event_in_an_arm" else if (!is.finite(se) || !is.finite(lo) || !is.finite(hi)) "bootstrap_failed" else NA_character_
    } else {
      est <- item$estimate; se <- item$se; lo <- est - .vcr_nc_z * se; hi <- est + .vcr_nc_z * se; fs <- 0
      basis <- "supplied_wald"; reason <- NA_character_
    }
    list(name = item$name, source = if (!is.null(item$column)) "column" else "supplied", column = item$column,
         estimate = est, se = se, low = lo, high = hi, failureShare = fs, intervalBasis = basis,
         estimable = is.na(reason), reason = reason)
  }
  rows <- lapply(items, analyse)
  primary <- if (is.null(prim)) NULL else analyse(prim)
  prim_est <- if (!is.null(primary) && primary$estimable) primary$estimate else NULL
  for (i in seq_along(rows)) {
    rows[[i]]$verdict <- if (rows[[i]]$estimable) vcr_nc_verdict(rows[[i]]$low, rows[[i]]$high, prim_est) else NA_character_
  }
  usable <- Filter(function(r) r$estimable, rows)
  if (!length(usable)) {
    return(list(status = "not_estimable", notEstimableRule = "negative_controls_not_estimable", measures = list(),
                counts = vcr_counts(realPatients = if (is.null(an)) NULL else an$n),
                diagnostics = list(controls = lapply(rows, function(r) r[c("name", "source", "reason")]),
                                   weighting = an$weighting, cohort = an$cohort)))
  }
  k <- length(usable)
  flagged <- sum(vapply(usable, function(r) identical(r$verdict, "signals_bias"), logical(1)))
  min_k <- as.integer(vcr_limit("negativeControlCalibrationMin", 30L))
  null <- NULL; calibration <- list(status = "set_too_small", minimum = min_k, controlsUsed = k,
    reason = sprintf("%d estimable negative control(s); an empirical null is fitted from at least %d. The controls are reported with their screen and nothing is calibrated.", k, min_k))
  if (k >= min_k) {
    null <- vcr_empirical_null(vapply(usable, function(r) r$estimate, numeric(1)), vapply(usable, function(r) r$se, numeric(1)))
    calibration <- if (isTRUE(null$fitted) && isTRUE(null$converged)) {
      list(status = "fitted", minimum = min_k, controlsUsed = k, mean = null$mean, sd = null$sd, sdAtBoundary = null$sdAtBoundary,
           logLikelihood = null$logLikelihood, model = "theta_i ~ N(mu, tau^2 + se_i^2), maximum likelihood (stats::optim, L-BFGS-B, tau^2 >= 0)")
    } else {
      null <- NULL
      list(status = "not_converged", minimum = min_k, controlsUsed = k, reason = "The empirical null did not converge; the screen stands and nothing is calibrated.")
    }
  }
  calibration$intervalCalibration <- "not offered: calibrating an interval needs positive controls with a known true effect, which a single comparison does not have"
  p_primary <- NULL
  if (!is.null(primary) && primary$estimable) {
    p_primary <- list(uncalibrated = 2 * stats::pnorm(-abs(primary$estimate / primary$se)),
                      calibrated = if (!is.null(null)) vcr_calibrated_p(null, primary$estimate, primary$se) else NULL)
  }
  limited <- k < min_k || length(usable) < length(rows) || any(vapply(usable, function(r) r$failureShare > 0.01, logical(1)))
  measures <- list(
    vcr_measure("negative_controls_analysed", k, source = "calculated"),
    vcr_measure("negative_controls_signalling_bias", flagged, source = "calculated"))
  if (!is.null(null)) {
    measures <- c(measures, list(vcr_measure("empirical_null_mean", null$mean, source = "calculated"),
                                 vcr_measure("empirical_null_sd", null$sd, source = "calculated")))
  }
  if (!is.null(primary) && primary$estimable) {
    measures <- c(measures, list(vcr_measure("primary_log_effect", primary$estimate, source = "calculated",
                                             interval = vcr_interval("confidence", primary$low, primary$high)),
                                 vcr_measure("uncalibrated_p_value", p_primary$uncalibrated, source = "calculated")))
    if (!is.null(p_primary$calibrated)) measures <- c(measures, list(vcr_measure("calibrated_p_value", p_primary$calibrated, source = "calculated")))
  }
  tab <- do.call(rbind, lapply(rows, function(r) data.frame(
    name = r$name, source = r$source, estimate = r$estimate, se = r$se, low = r$low, high = r$high,
    verdict = r$verdict, status = if (r$estimable) "estimable" else "excluded", reason = r$reason,
    bootstrapFailureShare = r$failureShare, stringsAsFactors = FALSE)))
  list(status = "succeeded", conclusion = if (limited) "limited" else "estimable", measures = measures,
       counts = if (is.null(an)) vcr_counts() else vcr_counts(realPatients = an$n, effectiveSampleSize = an$ess),
       diagnostics = list(
         effectScale = scale, intervalLevel = 0.95, controls = lapply(rows, function(r) r[c("name", "source", "estimate", "se", "low", "high", "verdict", "estimable", "reason", "failureShare", "intervalBasis")]),
         primary = if (is.null(primary)) NULL else c(primary[c("name", "estimate", "se", "low", "high", "estimable", "reason")], list(pValue = p_primary)),
         screen = list(analysed = k, excluded = length(rows) - k, signallingBias = flagged,
                       expectedFalseFlags = 0.05 * k,
                       reading = "Each control is expected to be null. A flag is a signal of residual bias or of different ascertainment in the two sources; with 95% intervals about one control in twenty is flagged by chance."),
         calibration = calibration,
         weighting = if (is.null(an)) NULL else an$weighting, estimand = if (is.null(an)) NULL else an$estimand,
         balance = if (is.null(an)) NULL else an$balance, support = if (is.null(an)) NULL else an$support,
         bootstrapReplicates = if (is.null(an)) NULL else an$bootstrapReplicates, cohort = if (is.null(an)) NULL else an$cohort,
         limitedBy = as.list(c(if (k < min_k) "too_few_controls_to_calibrate", if (length(usable) < length(rows)) "control_not_estimable",
                               if (any(vapply(usable, function(r) r$failureShare > 0.01, logical(1)))) "bootstrap_failure_share"))),
       tables = .vcr_tables_of(list(vcr_write_table(tab, "negative-controls", output_dir))))
}
