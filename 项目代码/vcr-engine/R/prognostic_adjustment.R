# ---------------------------------------------------------------------------
# prognostic_adjustment.R — prognostic covariate adjustment of a binary or a
# time-to-event endpoint, reported as a MARGINAL effect.
#
# Hidden knowledge:
#
# - **Nobody has qualified this beyond continuous outcomes, and every result
#   says so.** The EMA's qualification opinion on PROCOVA (CHMP, adopted 15
#   September 2022) is for continuous outcomes in randomized phase 2/3 trials;
#   binary and time-to-event outcomes are named there as future work. FDA's 2023
#   guidance on covariate adjustment calls adjustment by logistic or
#   proportional-hazards regression "a potentially acceptable method" and asks
#   the sponsor to discuss a nonlinear primary analysis with the review division.
#   So `diagnostics.regulatoryStatus` is on EVERY result, refusals included, and
#   the adjustment is described as what it is: a pre-specified covariate in a
#   regression, standardised to a marginal effect, not an EMA-qualified method.
# - **The score is a pre-specified covariate, nothing else.** The platform ships
#   no prognostic model: the score is a column that was fixed before the outcome
#   was seen (the engine cannot check that and says it takes it on trust). In a
#   randomized trial it buys precision, never a different answer; in a
#   non-randomized comparison it is one more covariate and fixes no confounding,
#   which is why this method does not build a control arm.
# - **Marginal, because the conditional odds ratio and hazard ratio are not the
#   effect the trial estimates.** Adding a prognostic covariate to a logistic or a
#   Cox model changes what the arm coefficient means (non-collapsibility: FDA
#   2023, Table 1, a conditional odds ratio of 8.0 in each biomarker subgroup and
#   a marginal one of 4.8 in the population; N39 reproduces that table). The
#   headline is the standardised (g-computation) contrast: every participant is
#   predicted under each arm and the predictions averaged. The conditional ratio
#   is reported beside it and named conditional.
# - **Binary: sandwich and bootstrap.** The standard error is the influence-
#   function (M-estimation) one, which carries the model's estimation error AND
#   the averaging over the covariate distribution; a stratified bootstrap
#   (refitting every time) is the check on it and is reported next to it. The
#   unadjusted contrast and the ratio of the two variances show what the score
#   bought. N39 holds the standard error to an M-estimation sandwich built from
#   numerical Jacobians, and to its bootstrap.
# - **Time to event: Cox with the score and a standardised RMST difference.**
#   `survival::coxph` (Breslow ties, robust Lin-Wei variance) gives the
#   conditional hazard ratio; the marginal summary is the restricted mean
#   survival time difference up to tau from the model's survival curves averaged
#   over everyone, with a stratified bootstrap interval. RMST needs no
#   proportional hazards for its definition, and the model-based version is held
#   to `survfit(newdata)` averaged by hand in N39.
# - **Missing is refused, not dropped.** A row with a missing score, covariate or
#   outcome would silently change who the effect is for.
# ---------------------------------------------------------------------------

VCR_PROGNOSTIC_QUALIFICATION <- "none_beyond_continuous"

#' The field every result of this method carries.
vcr_prognostic_regulatory_status <- function() {
  list(
    qualification = VCR_PROGNOSTIC_QUALIFICATION,
    qualifiedEndpoints = list("continuous"),
    notQualifiedEndpoints = list("binary", "time_to_event"),
    statement = paste("No regulator has qualified prognostic covariate adjustment for a binary or a time-to-event endpoint.",
                      "The EMA qualification opinion on PROCOVA (CHMP, adopted 15 September 2022) covers continuous outcomes in randomized phase 2/3 trials and leaves binary and time-to-event outcomes as future work.",
                      "FDA's 2023 guidance on covariate adjustment calls adjustment with logistic or proportional-hazards regression a potentially acceptable method and asks sponsors to discuss a nonlinear primary analysis with the review division."),
    basis = list(list(agency = "EMA", document = "Qualification opinion for prognostic covariate adjustment (PROCOVA), CHMP 2022-09-15", scope = "continuous outcomes, randomized phase 2/3"),
                 list(agency = "FDA", document = "Adjusting for Covariates in Randomized Clinical Trials for Drugs and Biological Products, May 2023", scope = "nonlinear models potentially acceptable; discuss with the review division")),
    reading = "The score is a pre-specified covariate. In a randomized trial the adjustment buys precision, not a different answer; in a non-randomized comparison it is one more covariate and corrects no confounding.")
}

.vcr_pa_z <- stats::qnorm(0.975)

#' The tables and columns of the job, refused by name when they cannot be used.
.vcr_pa_data <- function(job, sc, endpoint) {
  tabs <- vcr_job_tables(job)
  subj <- .vcr_main_table(tabs)
  vcr_require_individual(subj, "A prognostic-adjustment analysis", method = "comparator.prognostic_adjustment")
  cohort <- vcr_apply_downstream_cohort(subj, sc$cohortRules)
  subj <- cohort$data
  tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
  sc_col <- .vcr_column_name(sc$prognosticScoreColumn, NULL, "scenario.prognosticScoreColumn")
  covs <- vcr_chr(sc$covariates)
  if (!all(c(tc, sc_col, covs) %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.prognosticScoreColumn", "The treatment column, the prognostic score and the covariates are columns of the table.")
  arm_raw <- subj[[tc]]
  if (anyNA(arm_raw) || !all(arm_raw %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 for the treated arm and 0 for the control, complete.")
  arm <- as.integer(arm_raw)
  if (sum(arm == 1L) < 2L || sum(arm == 0L) < 2L) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "Both arms need at least two people.")
  Z <- as.matrix(subj[, c(sc_col, covs), drop = FALSE]); suppressWarnings(storage.mode(Z) <- "double")
  if (!is.numeric(Z) || any(!is.finite(Z))) {
    bad <- which(colSums(!is.finite(Z)) > 0L)
    vcr_abort("missing_covariate", "scenario.prognosticScoreColumn", sprintf("'%s' has missing or non-numeric values; the analysis does not drop rows (it would change who the effect is for).", colnames(Z)[bad[1]]))
  }
  colnames(Z) <- paste0("z", seq_len(ncol(Z)))
  out <- list(subj = subj, arm = arm, Z = Z, score = Z[, 1], cohort = cohort$info, columns = c(sc_col, covs), tc = tc)
  if (identical(endpoint, "binary")) {
    oc <- .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn")
    if (!(oc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome column is not in the table.")
    y <- suppressWarnings(as.numeric(subj[[oc]]))
    if (anyNA(y)) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome has missing values.")
    if (!all(y %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "A binary outcome is 0/1.")
    out$y <- y
  } else {
    o <- vcr_outcome_frame(sc, tabs, subj, "time_to_event")
    if (anyNA(o$time) || anyNA(o$status)) vcr_abort("input_shape_invalid", "inputs", "Time and status are complete.")
    out$time <- o$time; out$status <- o$status
  }
  out
}

.vcr_pa_not_estimable <- function(detail, counts) {
  list(status = "not_estimable", notEstimableRule = "primary_analysis_not_estimable", measures = list(), counts = counts,
       diagnostics = list(detail = detail, regulatoryStatus = vcr_prognostic_regulatory_status()))
}

#' Measures from (name, value, interval, unit) rows, leaving out any whose value
#' is not a finite number: a quantity that does not exist in this data (a risk
#' ratio with a zero risk) is absent, never a placeholder.
.vcr_pa_measures <- function(rows) {
  out <- lapply(rows, function(r) {
    if (!is.finite(r[[2]])) return(NULL)
    vcr_measure(r[[1]], r[[2]], source = "calculated", interval = r[[3]], unit = if (length(r) >= 4L) r[[4]] else NULL)
  })
  Filter(Negate(is.null), out)
}

# --- binary ----------------------------------------------------------------------

#' The logistic model with the arm, the score and the covariates, and its
#' standardised (g-computation) risks. `NULL` when the model has no maximum.
.vcr_pa_binary_fit <- function(y, arm, Z) {
  X <- cbind(`(Intercept)` = 1, arm = arm, Z)
  fit <- tryCatch(suppressWarnings(stats::glm.fit(X, y, family = stats::binomial(), control = list(epsilon = 1e-10, maxit = 100L))), error = function(e) NULL)
  if (is.null(fit) || !isTRUE(fit$converged) || any(!is.finite(fit$coefficients)) || max(abs(fit$coefficients)) > 25) return(NULL)
  b <- fit$coefficients
  X1 <- X; X1[, "arm"] <- 1; X0 <- X; X0[, "arm"] <- 0
  p1 <- stats::plogis(as.vector(X1 %*% b)); p0 <- stats::plogis(as.vector(X0 %*% b))
  list(X = X, X1 = X1, X0 = X0, beta = b, p = fit$fitted.values, p1 = p1, p0 = p0, m1 = mean(p1), m0 = mean(p0))
}

#' The marginal effects of a fit and their influence functions: the contribution
#' of each observation to the estimate (so that the variance is the sum of their
#' squares). Written out for a logistic model; the engine's tests hold it to an
#' M-estimation sandwich from numerical Jacobians.
.vcr_pa_binary_if <- function(f, y) {
  n <- length(y)
  w <- f$p * (1 - f$p)
  A <- crossprod(f$X, f$X * w)
  Ainv <- tryCatch(solve(A), error = function(e) NULL)
  if (is.null(Ainv)) return(NULL)
  U <- f$X * (y - f$p)                       # score contributions
  IFb <- U %*% Ainv                          # each observation's contribution to beta-hat
  D1 <- colMeans(f$X1 * (f$p1 * (1 - f$p1))); D0 <- colMeans(f$X0 * (f$p0 * (1 - f$p0)))
  c1 <- (f$p1 - f$m1) / n + as.vector(IFb %*% D1)
  c0 <- (f$p0 - f$m0) / n + as.vector(IFb %*% D0)
  list(c1 = c1, c0 = c0, IFb = IFb, Vbeta = crossprod(IFb))
}

.vcr_pa_binary_effects <- function(f) {
  m1 <- f$m1; m0 <- f$m0
  c(rd = m1 - m0, log_rr = if (m1 > 0 && m0 > 0) log(m1 / m0) else NA_real_,
    log_or = if (m1 > 0 && m1 < 1 && m0 > 0 && m0 < 1) stats::qlogis(m1) - stats::qlogis(m0) else NA_real_, cond_log_or = unname(f$beta["arm"]))
}

.vcr_pa_binary <- function(job, sc) {
  dat <- .vcr_pa_data(job, sc, "binary")
  y <- dat$y; arm <- dat$arm; n <- length(y)
  counts <- vcr_table_counts(dat$subj, events = sum(y))
  counts$events <- sum(y)
  reg <- vcr_prognostic_regulatory_status()
  if (sum(y == 1) == 0 || sum(y == 0) == 0) return(.vcr_pa_not_estimable("The outcome has only one value; there is nothing to model.", counts))
  if (stats::sd(dat$score) == 0) return(.vcr_pa_not_estimable("The prognostic score is constant; it adjusts for nothing.", counts))
  f <- .vcr_pa_binary_fit(y, arm, dat$Z)
  if (is.null(f)) return(.vcr_pa_not_estimable("The logistic model has no maximum (perfect separation or collinear covariates).", counts))
  inf <- .vcr_pa_binary_if(f, y)
  if (is.null(inf)) return(.vcr_pa_not_estimable("The model's information matrix is singular.", counts))
  m1 <- f$m1; m0 <- f$m0
  se_rd <- sqrt(sum((inf$c1 - inf$c0)^2))
  se_lrr <- sqrt(sum((inf$c1 / m1 - inf$c0 / m0)^2))
  se_lor <- sqrt(sum((inf$c1 / (m1 * (1 - m1)) - inf$c0 / (m0 * (1 - m0)))^2))
  se_cond <- sqrt(inf$Vbeta["arm", "arm"])
  est <- .vcr_pa_binary_effects(f)
  # the unadjusted contrast, on the same footing (unpooled Wald, as the engine's own analyses)
  p1u <- mean(y[arm == 1L]); p0u <- mean(y[arm == 0L])
  se_unadj <- sqrt(p1u * (1 - p1u) / sum(arm == 1L) + p0u * (1 - p0u) / sum(arm == 0L))
  # the stratified bootstrap refits the model in every resample
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(n, function(idx) {
    fb <- .vcr_pa_binary_fit(y[idx], arm[idx], dat$Z[idx, , drop = FALSE])
    if (is.null(fb)) return(rep(NA_real_, 5L))
    c(.vcr_pa_binary_effects(fb), unadj = mean(y[idx][arm[idx] == 1L]) - mean(y[idx][arm[idx] == 0L]))
  }, replicates = B, seed = job$seed, strata = arm, cores = vcr_cores(job$cores))
  if (identical(boot$interrupted, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = counts, diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B, regulatoryStatus = reg)))
  }
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    return(list(status = "failed", measures = list(), counts = counts,
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap; no result is reported.")),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B, regulatoryStatus = reg)))
  }
  bm <- boot$estimatesMatrix
  bse <- vapply(seq_len(ncol(bm)), function(j) { d <- bm[is.finite(bm[, j]), j]; if (length(d) >= 2L) stats::sd(d) else NA_real_ }, numeric(1))
  wald <- function(x, se, transform = identity) {
    lo <- transform(x - .vcr_pa_z * se); hi <- transform(x + .vcr_pa_z * se)
    if (all(is.finite(c(lo, hi)))) vcr_interval("confidence", lo, hi) else NULL
  }
  # how strongly the score separates the outcome in the control arm: the rank (Mann-Whitney) area under the curve
  ctl <- arm == 0L
  auc <- if (sum(y[ctl] == 1) > 0 && sum(y[ctl] == 0) > 0) {
    r <- rank(dat$score[ctl]); n1 <- sum(y[ctl] == 1); n0 <- sum(y[ctl] == 0)
    (sum(r[y[ctl] == 1]) - n1 * (n1 + 1) / 2) / (n1 * n0)
  } else NA_real_
  measures <- .vcr_pa_measures(list(
    list("marginal_risk_difference", est[["rd"]], wald(est[["rd"]], se_rd)),
    list("marginal_risk_ratio", exp(est[["log_rr"]]), wald(est[["log_rr"]], se_lrr, exp)),
    list("marginal_odds_ratio", exp(est[["log_or"]]), wald(est[["log_or"]], se_lor, exp)),
    list("conditional_odds_ratio", exp(est[["cond_log_or"]]), wald(est[["cond_log_or"]], se_cond, exp)),
    list("risk_treatment_standardised", m1, NULL),
    list("risk_control_standardised", m0, NULL),
    list("unadjusted_risk_difference", p1u - p0u, wald(p1u - p0u, se_unadj)),
    list("empirical_variance_ratio", (se_rd / se_unadj)^2, NULL)))
  list(status = "succeeded", conclusion = if (boot$failureShare > 0.01) "limited" else "estimable", measures = measures, counts = counts,
       diagnostics = list(
         endpoint = "binary", estimand = "marginal: each participant predicted under both arms, the predictions averaged (g-computation)",
         regulatoryStatus = reg,
         model = list(family = "binomial", terms = c("intercept", "arm", dat$columns), scoreColumn = dat$columns[1],
                      coefficients = as.list(stats::setNames(as.numeric(f$beta), c("intercept", "arm", dat$columns)))),
         standardErrors = list(basis = "influence function (M-estimation sandwich) for the model and the averaging",
                               riskDifference = se_rd, logRiskRatio = se_lrr, logOddsRatio = se_lor, conditionalLogOddsRatio = se_cond, unadjustedRiskDifference = se_unadj),
         bootstrap = list(replicates = boot$replicates, failureShare = boot$failureShare, stratifiedBy = "arm",
                          standardErrors = list(riskDifference = bse[1], logRiskRatio = bse[2], logOddsRatio = bse[3], conditionalLogOddsRatio = bse[4], unadjustedRiskDifference = bse[5]),
                          riskDifferenceInterval = as.list(boot$intervals[1, ]),
                          sandwichOverBootstrap = list(riskDifference = se_rd / bse[1], logOddsRatio = se_lor / bse[3])),
         scoreStrength = list(controlArmAuc = auc),
         nonCollapsibility = if (is.finite(est[["log_or"]])) list(marginalOddsRatio = exp(est[["log_or"]]), conditionalOddsRatio = exp(est[["cond_log_or"]]),
           note = "The odds ratio does not collapse: the conditional ratio is not the marginal one even in a randomized trial. The risk difference and the risk ratio are the marginal contrasts to read.") else NULL,
         cohort = dat$cohort))
}

# --- time to event -------------------------------------------------------------------

#' The Cox partial-likelihood maximum for any number of covariates (Breslow
#' ties), by Newton with step halving, vectorised over the risk-set sums (reverse
#' cumulative sums of exp(x beta), of x exp(x beta) and of x x' exp(x beta) at
#' each event time). The bootstrap refits the model two thousand times, and
#' `survival::coxph` costs about five times as much; N39 holds the two to 1e-8.
#' Returns the coefficients and the model-based variance, or `NULL` when the
#' likelihood has no maximum (a coefficient beyond 30 in absolute value).
vcr_cox_multi <- function(time, status, X, maxit = 50L, tol = 1e-10) {
  X <- as.matrix(X); n <- length(time); p <- ncol(X)
  o <- order(time); t <- time[o]; s <- status[o]; Xo <- X[o, , drop = FALSE]
  first <- c(TRUE, t[-1L] != t[-n]); g <- cumsum(first); ng <- g[n]
  d <- tabulate(g[s == 1L], ng); keep <- d > 0
  if (!any(keep) || p < 1L) return(NULL)
  xe <- colSums(Xo[s == 1L, , drop = FALSE])                  # the sum of x over all events
  dk <- d[keep]
  revcs <- function(v) rev(cumsum(rev(v)))[first][keep]
  pairs <- which(upper.tri(diag(p), diag = TRUE), arr.ind = TRUE)
  pieces <- function(beta) {
    w <- exp(as.vector(Xo %*% beta))
    if (any(!is.finite(w))) return(NULL)
    S0 <- revcs(w)
    S1 <- vapply(seq_len(p), function(j) revcs(w * Xo[, j]), numeric(length(dk)))
    S1 <- matrix(S1, ncol = p)
    list(w = w, S0 = S0, S1 = S1, loglik = sum(Xo[s == 1L, , drop = FALSE] %*% beta) - sum(dk * log(S0)))
  }
  beta <- rep(0, p)
  cur <- pieces(beta)
  I <- NULL
  for (it in seq_len(maxit)) {
    S0 <- cur$S0; S1 <- cur$S1
    U <- xe - colSums(dk * S1 / S0)
    S2 <- matrix(0, p, p)
    for (r in seq_len(nrow(pairs))) {
      j <- pairs[r, 1]; k <- pairs[r, 2]
      v <- sum(dk * revcs(cur$w * Xo[, j] * Xo[, k]) / S0)
      S2[j, k] <- v; S2[k, j] <- v
    }
    A <- S1 / S0 * sqrt(dk)
    I <- S2 - crossprod(A)
    step <- tryCatch(solve(I, U), error = function(e) NULL)
    if (is.null(step) || any(!is.finite(step))) return(NULL)
    # step halving on the partial log likelihood
    h <- 1; nxt <- NULL
    repeat {
      cand <- beta + h * step
      nxt <- pieces(cand)
      if (!is.null(nxt) && is.finite(nxt$loglik) && nxt$loglik >= cur$loglik - 1e-12) break
      h <- h / 2
      if (h < 1e-8) return(NULL)
    }
    beta <- cand; cur <- nxt
    if (max(abs(beta)) > 30) return(NULL)
    if (max(abs(h * step)) < tol) break
  }
  Vm <- tryCatch(solve(I), error = function(e) NULL)
  list(beta = beta, variance = Vm, converged = max(abs(h * step)) < tol)
}

#' The Cox model with the arm, the score and the covariates (Breslow ties): the
#' coefficients and, when asked, the robust (Lin-Wei) variance from
#' `survival::coxph` (fitted once, on the data as given). The coefficients come from
#' `vcr_cox_multi`. `NULL` when it does not converge.
.vcr_pa_cox <- function(time, status, arm, Z, robust = FALSE) {
  if (!robust) {
    fit <- tryCatch(vcr_cox_multi(time, status, cbind(arm = arm, Z)), error = function(e) NULL)
    if (is.null(fit) || !isTRUE(fit$converged)) return(NULL)
    b <- fit$beta; names(b) <- c("arm", colnames(Z))
    return(list(beta = b, var = fit$variance, naiveVar = fit$variance))
  }
  df <- data.frame(time = time, status = status, arm = arm, Z)
  rhs <- paste(c("arm", colnames(Z)), collapse = " + ")
  warned <- FALSE
  fit <- tryCatch(withCallingHandlers(
    survival::coxph(stats::as.formula(paste("survival::Surv(time, status) ~", rhs)), data = df, ties = "breslow", robust = robust, x = FALSE),
    warning = function(w) { if (grepl("infinite|converge", conditionMessage(w))) warned <<- TRUE; invokeRestart("muffleWarning") }),
    error = function(e) NULL)
  if (is.null(fit) || warned || any(!is.finite(fit$coefficients))) return(NULL)
  b <- fit$coefficients
  names(b) <- c("arm", colnames(Z))
  list(fit = fit, beta = b, var = fit$var, naiveVar = if (robust) fit$naive.var else fit$var)
}

#' Breslow's cumulative baseline hazard for a given linear predictor (no centring).
.vcr_pa_breslow <- function(time, status, lp) {
  n <- length(time)
  o <- order(time); t <- time[o]; s <- status[o]; w <- exp(lp[o])
  first <- c(TRUE, t[-1L] != t[-n])
  g <- cumsum(first)
  risk <- rev(cumsum(rev(w)))[first]
  d <- tabulate(g[s == 1L], g[n])
  keep <- d > 0
  list(time = t[first][keep], H0 = cumsum(d[keep] / risk[keep]))
}

#' The standardised survival curve of a fit under arm `a`: at each event time the
#' average over everyone of exp(-H0(t) exp(lp)), `lp` the linear predictor with the
#' arm set to `a`. Returns the restricted mean to `tau` (exact: the curve is a step
#' function) and the survival at `tau`.
.vcr_pa_standardised <- function(bh, lp, tau) {
  tk <- bh$time[bh$time < tau]; Hk <- bh$H0[bh$time < tau]
  elp <- exp(lp)
  S <- if (length(tk)) vapply(Hk, function(h) mean(exp(-h * elp)), numeric(1)) else numeric(0)
  rmst <- sum(diff(c(0, tk, tau)) * c(1, S))
  upto <- bh$time <= tau
  s_tau <- if (any(upto)) mean(exp(-bh$H0[max(which(upto))] * elp)) else 1
  list(rmst = rmst, survival = s_tau)
}

.vcr_pa_tte_effects <- function(time, status, arm, Z, tau) {
  cx <- .vcr_pa_cox(time, status, arm, Z)
  if (is.null(cx)) return(NULL)
  Zb <- Z %*% cx$beta[colnames(Z)]
  bh <- .vcr_pa_breslow(time, status, as.vector(cx$beta["arm"] * arm + Zb))
  s1 <- .vcr_pa_standardised(bh, as.vector(cx$beta["arm"] + Zb), tau)
  s0 <- .vcr_pa_standardised(bh, as.vector(Zb), tau)
  list(cox = cx, rmst1 = s1$rmst, rmst0 = s0$rmst, rmst_diff = s1$rmst - s0$rmst, surv_diff = s1$survival - s0$survival, bh = bh)
}

.vcr_pa_tte <- function(job, sc) {
  dat <- .vcr_pa_data(job, sc, "time_to_event")
  time <- dat$time; status <- dat$status; arm <- dat$arm; Z <- dat$Z; n <- length(time)
  tau <- vcr_scalar(sc$tau, NULL)
  counts <- vcr_table_counts(dat$subj, events = sum(status))
  counts$events <- sum(status)
  reg <- vcr_prognostic_regulatory_status()
  rule <- vcr_tau_rule(time, status, arm, tau)
  if (!is.null(rule)) {
    return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(), counts = counts,
                diagnostics = c(rule, list(regulatoryStatus = reg))))
  }
  if (sum(status[arm == 1L]) == 0L || sum(status[arm == 0L]) == 0L) return(.vcr_pa_not_estimable("An arm has no event: there is no hazard ratio to estimate.", counts))
  if (stats::sd(dat$score) == 0) return(.vcr_pa_not_estimable("The prognostic score is constant; it adjusts for nothing.", counts))
  e <- .vcr_pa_tte_effects(time, status, arm, Z, tau)
  if (is.null(e)) return(.vcr_pa_not_estimable("The Cox model does not converge (monotone likelihood or collinear covariates).", counts))
  rob <- .vcr_pa_cox(time, status, arm, Z, robust = TRUE)
  # the arm is the first coefficient (the variance matrix carries no names)
  se_cond <- sqrt(rob$var[1L, 1L]); se_naive <- sqrt(rob$naiveVar[1L, 1L])
  un <- vcr_rmst_difference(time, status, arm, tau)
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(n, function(idx) {
    eb <- .vcr_pa_tte_effects(time[idx], status[idx], arm[idx], Z[idx, , drop = FALSE], tau)
    if (is.null(eb)) return(rep(NA_real_, 5L))
    r1 <- vcr_rmst(time[idx][arm[idx] == 1L], status[idx][arm[idx] == 1L], tau, variance = FALSE)$rmst
    r0 <- vcr_rmst(time[idx][arm[idx] == 0L], status[idx][arm[idx] == 0L], tau, variance = FALSE)$rmst
    c(eb$rmst_diff, eb$rmst1, eb$rmst0, eb$surv_diff, r1 - r0)
  }, replicates = B, seed = job$seed, strata = arm, cores = vcr_cores(job$cores))
  if (identical(boot$interrupted, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = counts, diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B, regulatoryStatus = reg)))
  }
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    return(list(status = "failed", measures = list(), counts = counts,
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap; no result is reported.")),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B, regulatoryStatus = reg)))
  }
  bm <- boot$estimatesMatrix
  bse <- vapply(seq_len(ncol(bm)), function(j) { d <- bm[is.finite(bm[, j]), j]; if (length(d) >= 2L) stats::sd(d) else NA_real_ }, numeric(1))
  ci <- function(j) { iv <- boot$intervals[j, ]; if (anyNA(iv)) NULL else vcr_interval("confidence", iv[1], iv[2]) }
  unit <- as.character(sc$timeUnit %||% "months")
  b_arm <- unname(e$cox$beta["arm"])
  measures <- .vcr_pa_measures(list(
    list("conditional_hazard_ratio", exp(b_arm), vcr_interval("confidence", exp(b_arm - .vcr_pa_z * se_cond), exp(b_arm + .vcr_pa_z * se_cond))),
    list("marginal_rmst_difference", e$rmst_diff, ci(1), unit),
    list("rmst_treatment_standardised", e$rmst1, ci(2), unit),
    list("rmst_control_standardised", e$rmst0, ci(3), unit),
    list("survival_difference_at_tau", e$surv_diff, ci(4)),
    list("unadjusted_rmst_difference", un$estimate, vcr_interval("confidence", un$interval[1], un$interval[2]), unit),
    list("empirical_variance_ratio", (bse[1] / bse[5])^2, NULL)))
  list(status = "succeeded", conclusion = if (boot$failureShare > 0.01) "limited" else "estimable", measures = measures, counts = counts,
       diagnostics = list(
         endpoint = "time_to_event", tau = tau, timeUnit = unit,
         estimand = "marginal: the model's survival curves under each arm averaged over everyone, restricted mean survival time to tau",
         regulatoryStatus = reg,
         model = list(family = "Cox, Breslow ties", terms = c("arm", dat$columns), scoreColumn = dat$columns[1],
                      coefficients = as.list(stats::setNames(as.numeric(e$cox$beta), c("arm", dat$columns)))),
         standardErrors = list(basis = "Lin-Wei robust variance for the conditional log hazard ratio; stratified bootstrap for the marginal quantities",
                               conditionalLogHazardRatio = se_cond, conditionalLogHazardRatioModelBased = se_naive, unadjustedRmstDifference = un$se),
         bootstrap = list(replicates = boot$replicates, failureShare = boot$failureShare, stratifiedBy = "arm",
                          standardErrors = list(rmstDifference = bse[1], survivalDifference = bse[4], unadjustedRmstDifference = bse[5])),
         nonCollapsibility = list(note = "The hazard ratio does not collapse: the conditional hazard ratio of a model with the score is not the marginal one. The restricted mean survival time difference is the marginal contrast to read."),
         cohort = dat$cohort))
}

vcr_job_prognostic_adjustment <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  type <- as.character(sc$endpoint$type %||% "")
  # a refusal is a result of this method too: it names its issue and still says what the adjustment is
  tryCatch({
    if (identical(type, "binary")) return(.vcr_pa_binary(job, sc))
    if (identical(type, "time_to_event")) return(.vcr_pa_tte(job, sc))
    vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "Prognostic covariate adjustment of a binary or a time-to-event endpoint; a continuous endpoint is the EMA-qualified PROCOVA, sized by design.procova.")
  }, vcr_refusal = function(e) list(status = "failed", issues = list(e$issue), diagnostics = list(regulatoryStatus = vcr_prognostic_regulatory_status())))
}
