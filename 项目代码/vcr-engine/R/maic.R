# ---------------------------------------------------------------------------
# maic.R — matching-adjusted indirect comparison and simulated treatment
# comparison (plan 5.3 "literature control"; NICE DSU TSD 18).
#
# Hidden knowledge:
#
# - **MAIC is entropy balancing wearing a different name.** Signorovitch's
#   method-of-moments weights solve exactly the dual this engine already
#   solves in `weighting.R` (Josey et al. 2021 prove the equivalence), so
#   there is one kernel and one convergence story, not two. What differs is
#   only where the target moments come from: the treated arm's own rows, or a
#   published baseline table.
# - **The estimand moves, and the label must move with it.** A MAIC estimates
#   the effect in the *aggregate-data trial's* population, not in the
#   sponsor's. Two sponsors can MAIC each other's summaries and reach opposite
#   conclusions, both correctly. The result therefore carries
#   `targetPopulation = "aggregate_data_trial"` and an unanchored comparison
#   is capped at `limited` no matter how clean the balance looks.
# - **ESS is mandatory output, not a diagnostic.** TSD 18 asks for it, and it
#   is the one number that shows a "successful" match that has thrown away
#   90% of the information. It is reported in `counts.effectiveSampleSize`
#   next to the real patient count, never instead of it (AC-08).
# - **Unadjusted effect modifiers are listed by name.** A MAIC can only adjust
#   what the published baseline table reports; everything the analyst declared
#   as a modifier but could not match is returned in
#   `unadjustedEffectModifiers`, because "we adjusted for what we had" is not
#   a finding a reader can act on and a list of names is.
# ---------------------------------------------------------------------------

#' Method-of-moments MAIC weights for the IPD rows.
#'
#' @param X IPD covariate matrix (rows = individuals).
#' @param targets named vector of aggregate-data means for the same columns.
#'   Second moments are supplied by the caller as extra columns (e.g. `age^2`
#'   against the published SD), which is how TSD 18 matches variances.
vcr_maic_weights <- function(X, targets, tol = 1e-12, maxit = 200L) {
  X <- as.matrix(X)
  if (is.null(colnames(X))) colnames(X) <- paste0("V", seq_len(ncol(X)))
  targets <- targets[colnames(X)]
  if (anyNA(targets)) stop("vcr_maic_weights: every IPD column needs an aggregate target")
  fit <- vcr_entropy_balance(X, as.numeric(targets), tol = tol, maxit = maxit)
  if (is.null(fit$weights)) return(fit)
  # Report weights on the "mean 1" scale so a weight reads as "this person
  # counts as k people", which is what the ESS is computed from anyway.
  w <- fit$weights * nrow(X)
  list(weights = w, lambda = fit$lambda, converged = fit$converged,
       iterations = fit$iterations, discrepancy = fit$discrepancy,
       rule = fit$rule, detail = fit$detail,
       effectiveSampleSize = vcr_ess(w),
       weightRatio = if (length(unique(round(w, 12))) <= 8) sort(unique(round(w, 12))) else NULL,
       achievedMeans = as.vector(crossprod(X, w / sum(w))),
       targets = as.numeric(targets))
}

#' Bootstrap the IPD part of a MAIC estimate with the weights re-estimated in
#' every resample, and add the aggregate trial's own error on top. The
#' fixed-weight sandwich variance treats the weights as known, which they are
#' not (they were fitted to the same rows): on a 200-patient unanchored
#' comparison whose true SD is 0.078 it reports 0.19 -- the weights make the
#' weighted x-mean exactly the target, which removes most of the outcome's
#' variation, and a formula that does not know that cannot be right in either
#' direction (EB-21).
.vcr_maic_bootstrap <- function(estimate_fn, n, strata, bootstrap, agd_se) {
  b <- vcr_bootstrap_pipeline(n, estimate_fn, replicates = bootstrap$replicates, seed = bootstrap$seed,
                              strata = strata, cores = bootstrap$cores %||% 1L)
  se <- sqrt(b$se^2 + agd_se^2)
  list(se = se, bootstrap = b)
}

#' Anchored MAIC: both trials share a common comparator C.
#'
#' `ipd` has columns `arm` (1 = active in the IPD trial, 0 = common
#' comparator) and `y`; `agd` gives the aggregate trial's own contrast
#' (`estimate`, `se`) of its active arm against the same comparator.
#' The indirect estimate is (IPD contrast, reweighted) minus (AgD contrast).
#' With `bootstrap = list(replicates, seed, cores)` the interval comes from the
#' whole-pipeline bootstrap; without it the (fixed-weight) sandwich is used and
#' the result is marked as such.
vcr_maic_anchored <- function(ipd, X, targets, agd_estimate, agd_se,
                              link = c("identity", "log", "logit"), tol = 1e-12, bootstrap = NULL) {
  link <- match.arg(link)
  w <- vcr_maic_weights(X, targets, tol = tol)
  if (is.null(w$weights)) return(c(w, list(estimate = NULL)))
  contrast <- vcr_weighted_contrast(ipd$y, ipd$arm, w$weights, link)
  est <- contrast$estimate - agd_estimate
  se <- sqrt(contrast$se^2 + agd_se^2)
  boot <- NULL
  if (!is.null(bootstrap)) {
    fn <- function(idx) {
      wb <- vcr_maic_weights(X[idx, , drop = FALSE], targets, tol = tol)
      if (is.null(wb$weights)) return(NA_real_)
      vcr_weighted_contrast(ipd$y[idx], ipd$arm[idx], wb$weights, link)$estimate
    }
    r <- .vcr_maic_bootstrap(fn, nrow(X), ipd$arm, bootstrap, agd_se)
    se <- r$se; boot <- r$bootstrap
  }
  list(estimate = est, se = se, link = link,
       ipdContrast = contrast, agdContrast = list(estimate = agd_estimate, se = agd_se),
       effectiveSampleSize = w$effectiveSampleSize, weights = w$weights,
       anchored = TRUE, targetPopulation = "aggregate_data_trial",
       varianceBasis = if (is.null(boot)) "fixed_weight_sandwich" else "bootstrap_weights_reestimated",
       bootstrap = boot,
       interval = c(est - qnorm(0.975) * se, est + qnorm(0.975) * se))
}

#' Unanchored MAIC: no common comparator, so every prognostic factor *and*
#' every effect modifier must be matched. Always capped at `limited`.
vcr_maic_unanchored <- function(ipd_y, X, targets, agd_outcome, agd_se,
                                link = c("identity", "log", "logit"), tol = 1e-12, bootstrap = NULL) {
  link <- match.arg(link)
  w <- vcr_maic_weights(X, targets, tol = tol)
  if (is.null(w$weights)) return(c(w, list(estimate = NULL)))
  mu <- stats::weighted.mean(ipd_y, w$weights)
  ww <- w$weights / sum(w$weights)
  var_mu <- sum(ww^2 * (ipd_y - mu)^2) * length(ipd_y) / max(length(ipd_y) - 1, 1)
  g <- switch(link, identity = function(p) p, log = log, logit = stats::qlogis)
  gp <- switch(link, identity = function(p) 1, log = function(p) 1 / p,
               logit = function(p) 1 / (p * (1 - p)))
  est <- g(mu) - agd_outcome
  se <- sqrt(var_mu * gp(mu)^2 + agd_se^2)
  boot <- NULL
  if (!is.null(bootstrap)) {
    fn <- function(idx) {
      wb <- vcr_maic_weights(X[idx, , drop = FALSE], targets, tol = tol)
      if (is.null(wb$weights)) return(NA_real_)
      g(stats::weighted.mean(ipd_y[idx], wb$weights))
    }
    r <- .vcr_maic_bootstrap(fn, nrow(X), NULL, bootstrap, agd_se)
    se <- r$se; boot <- r$bootstrap
  }
  list(estimate = est, se = se, link = link,
       effectiveSampleSize = w$effectiveSampleSize, weights = w$weights,
       anchored = FALSE, targetPopulation = "aggregate_data_trial",
       conclusionCeiling = "limited",
       varianceBasis = if (is.null(boot)) "fixed_weight_sandwich" else "bootstrap_weights_reestimated",
       bootstrap = boot,
       interval = c(est - qnorm(0.975) * se, est + qnorm(0.975) * se))
}

#' Weighted contrast between two arms of the IPD trial, on the requested link.
vcr_weighted_contrast <- function(y, arm, w, link = "identity") {
  i1 <- arm == 1L; i0 <- arm == 0L
  m1 <- stats::weighted.mean(y[i1], w[i1]); m0 <- stats::weighted.mean(y[i0], w[i0])
  v <- function(idx) {
    ww <- w[idx] / sum(w[idx])
    mu <- sum(ww * y[idx])
    sum(ww^2 * (y[idx] - mu)^2)
  }
  if (identical(link, "identity")) {
    return(list(estimate = m1 - m0, se = sqrt(v(i1) + v(i0)), arm1 = m1, arm0 = m0))
  }
  if (identical(link, "log")) {
    return(list(estimate = log(m1) - log(m0),
                se = sqrt(v(i1) / m1^2 + v(i0) / m0^2), arm1 = m1, arm0 = m0))
  }
  if (identical(link, "logit")) {
    return(list(estimate = stats::qlogis(m1) - stats::qlogis(m0),
                se = sqrt(v(i1) / (m1 * (1 - m1))^2 + v(i0) / (m0 * (1 - m0))^2),
                arm1 = m1, arm0 = m0))
  }
  stop("vcr_weighted_contrast: unknown link ", link)
}

#' Simulated treatment comparison: regress the IPD outcome on arm and on
#' covariates *centred at the aggregate-data means*, so the arm coefficient is
#' the conditional effect in a patient with the AgD trial's average profile.
#'
#' Hidden knowledge: on a non-collapsible link (log, logit, Cox) this
#' conditional effect is not the marginal effect MAIC estimates, and the two
#' are not interchangeable. The result says which it is, so a downstream
#' comparison cannot quietly mix them (Remiro-Azocar 2021 is the reference for
#' preferring parametric G-computation instead; that is the follow-on).
vcr_stc <- function(y, arm, X, targets, family = stats::gaussian()) {
  X <- as.matrix(X)
  Xc <- sweep(X, 2, targets[colnames(X)], "-")
  df <- as.data.frame(Xc)
  df$..y.. <- y; df$..arm.. <- arm
  form <- vcr_model_formula("..y..", colnames(Xc), fixed = "..arm..")
  fit <- suppressWarnings(stats::glm(form, data = df, family = family))
  co <- summary(fit)$coefficients
  list(estimate = co["..arm..", "Estimate"], se = co["..arm..", "Std. Error"],
       effectScale = if (identical(family$link, "identity")) "marginal_and_conditional" else "conditional",
       collapsible = identical(family$link, "identity"), model = fit,
       targetPopulation = "aggregate_data_trial")
}

`%||%` <- function(a, b) if (is.null(a)) b else a
