# ---------------------------------------------------------------------------
# evidence_pool.R — turning several published studies into one assumption card
# (plan 6.2 step 4).
#
# Hidden knowledge:
#
# - **Three pooling methods, chosen by the analyst, never by the engine.**
#   DerSimonian-Laird is the one every reviewer recognizes, REML is the one
#   with the better small-sample properties, and Hartung-Knapp-Sidik-Jonkman
#   is the one whose interval does not collapse when k is small and tau-hat
#   lands on zero. Picking whichever gives the narrowest interval is exactly
#   the questionable practice attachment C1 cites; the method is part of the
#   frozen scenario and is hashed with it.
# - **The prediction interval, not the confidence interval, is what a
#   simulation should sample from.** The confidence interval is about the mean
#   of the study effects; a new trial is a draw from the distribution of study
#   effects. Feeding a CI into a design prior understates the spread by
#   sqrt(1 + var(mu)/tau^2) and is the most common way an assurance number
#   comes out too optimistic.
# - **k - 2 degrees of freedom, and it is allowed to be undefined.** The
#   Higgins-Thompson-Spiegelhalter prediction interval uses t with k - 2 df,
#   so with two studies there is no prediction interval at all. We return NA
#   rather than silently falling back to the normal, because "two studies"
#   deserves to be visible on the page.
# - metafor is the cross-check (N-series), not the implementation: the pooled
#   value has to be derivable here so that a scenario hash means something.
# ---------------------------------------------------------------------------

#' Random-effects (or fixed-effect) pooling with a prediction interval.
#'
#' @param yi effect estimates on the analysis scale (log RR, log HR, mean ...).
#' @param vi their sampling variances.
#' @param method one of `VCR_POOLING_METHODS`.
vcr_pool <- function(yi, vi, method = "random_effects_dl", level = 0.95,
                     hksj_truncate = FALSE) {
  k <- length(yi)
  if (k != length(vi)) stop("vcr_pool: yi and vi must have the same length")
  if (k < 1L) stop("vcr_pool: nothing to pool")
  wf <- 1 / vi
  theta_fe <- sum(wf * yi) / sum(wf)
  Q <- sum(wf * (yi - theta_fe)^2)
  df <- k - 1L
  C <- sum(wf) - sum(wf^2) / sum(wf)

  tau2 <- switch(method,
    fixed_effect = 0,
    single_study = 0,
    random_effects_dl = max(0, (Q - df) / C),
    random_effects_hksj = max(0, (Q - df) / C),
    random_effects_reml = .vcr_tau2_reml(yi, vi),
    stop("vcr_pool: unknown pooling method ", method))

  w <- 1 / (vi + tau2)
  theta <- sum(w * yi) / sum(w)
  var_theta <- 1 / sum(w)
  if (identical(method, "random_effects_hksj")) {
    # Hartung-Knapp: replace the variance by the weighted residual variance and
    # switch to t(k - 1).
    #
    # Hidden knowledge: the `max(q, 1)` truncation ("modified HK") is a real
    # variant in the literature, but metafor's `test = "knha"` does *not*
    # apply it -- q below 1 gives an interval narrower than DL's, which is
    # what it did on the homogeneous cross-check data. Truncating by default
    # would have made the engine disagree with metafor on exactly the data
    # where a reviewer is most likely to re-run it by hand, so truncation is
    # opt-in and named.
    q <- sum(w * (yi - theta)^2) / df
    var_theta <- (if (isTRUE(hksj_truncate)) max(q, 1) else q) * var_theta
    crit <- stats::qt(1 - (1 - level) / 2, df)
  } else {
    crit <- stats::qnorm(1 - (1 - level) / 2)
  }
  se <- sqrt(var_theta)
  ci <- c(theta - crit * se, theta + crit * se)

  # The prediction interval is Higgins-Thompson-Spiegelhalter's: t with k - 2
  # degrees of freedom around the pooled estimate, spread sqrt(tau^2 + var).
  #
  # Hidden knowledge: metafor's `predict()` uses the *normal* critical value
  # for a `test = "z"` fit, so its default prediction interval is narrower
  # than this one by qt(0.975, k-2)/qnorm(0.975) -- with k = 7 that is 13%.
  # Neither is wrong; they are different intervals with the same name. We take
  # the t version because the platform's existing meta engine already reports
  # it and two EviMed products must not print different prediction intervals
  # for the same studies.
  pi <- c(NA_real_, NA_real_)
  pise <- sqrt(tau2 + var_theta)
  if (k >= 3L) {
    tcrit <- stats::qt(1 - (1 - level) / 2, k - 2L)
    pi <- c(theta - tcrit * pise, theta + tcrit * pise)
  }
  i2 <- if (Q > df && Q > 0) max(0, (Q - df) / Q) else 0
  h2 <- if (df > 0) max(1, Q / df) else 1

  list(estimate = theta, se = se, interval = ci, predictionInterval = pi,
       tau2 = tau2, tau = sqrt(tau2), Q = Q, df = df,
       pQ = if (df > 0) stats::pchisq(Q, df, lower.tail = FALSE) else NA_real_,
       i2 = i2, h2 = h2, k = k, method = method, level = level,
       predictionSd = pise, predictionDf = if (k >= 3L) k - 2L else NA_integer_,
       weights = w / sum(w))
}

#' REML estimate of tau^2 by Fisher scoring.
#'
#' Hidden knowledge: this is metafor's own iteration, but run to 1e-14 rather
#' than metafor's default `control = list(tol = 1e-5)` -- which is a tolerance
#' on tau^2 itself, so on a scale where tau^2 is 0.07 it stops about seven
#' significant digits in. The cross-check therefore tightens metafor's control
#' rather than loosening ours; a pooled value that moves in the seventh digit
#' between reruns would make a scenario hash meaningless.
.vcr_tau2_reml <- function(yi, vi, maxit = 500L, tol = 1e-14) {
  tau2 <- max(0, stats::var(yi) - mean(vi))
  for (it in seq_len(maxit)) {
    w <- 1 / (vi + tau2)
    sw <- sum(w)
    mu <- sum(w * yi) / sw
    adj <- (sum(w^2 * (yi - mu)^2) - sum(w) + sum(w^2) / sw) /
           (sum(w^2) - 2 * sum(w^3) / sw + sum(w^2)^2 / sw^2)
    if (!is.finite(adj)) break
    step <- adj
    # Damp so a single Fisher step cannot jump past zero into a region where
    # the weights are negative; halving is enough because the objective is
    # concave in tau^2 near the optimum.
    guard <- 0L
    while (tau2 + step < 0 && guard < 60L) { step <- step / 2; guard <- guard + 1L }
    new <- max(0, tau2 + step)
    done <- abs(new - tau2) < tol
    tau2 <- new
    if (done) break
  }
  tau2
}

#' Binomial arms to a pooled proportion on the logit scale, with the
#' continuity correction stated rather than applied silently.
vcr_pool_proportions <- function(events, n, method = "random_effects_dl",
                                 correction = 0.5, level = 0.95) {
  e <- as.numeric(events); nn <- as.numeric(n)
  needs <- e == 0 | e == nn
  e2 <- ifelse(needs, e + correction, e)
  n2 <- ifelse(needs, nn + 2 * correction, nn)
  p <- e2 / n2
  yi <- stats::qlogis(p)
  vi <- 1 / e2 + 1 / (n2 - e2)
  out <- vcr_pool(yi, vi, method, level)
  out$scale <- "logit"
  out$proportion <- stats::plogis(out$estimate)
  out$proportionInterval <- stats::plogis(out$interval)
  out$proportionPredictionInterval <- stats::plogis(out$predictionInterval)
  out$continuityCorrectionApplied <- which(needs)
  out
}

#' Turn a pooled result into the distribution a simulation samples from
#' (plan 6.2 step 4: "straight into a distribution the simulation can use").
#' The design prior is the *prediction* distribution when one exists.
vcr_pool_to_distribution <- function(pool, family = c("normal", "lognormal", "beta")) {
  family <- match.arg(family)
  sd_pred <- sqrt(pool$tau2 + pool$se^2)
  if (identical(family, "normal") || identical(family, "lognormal")) {
    return(list(kind = if (family == "normal") "normal" else "lognormal",
                mean = pool$estimate, sd = sd_pred,
                confidenceSd = pool$se, tau = pool$tau,
                basis = if (pool$tau2 > 0 && pool$k >= 3L) "prediction" else "confidence"))
  }
  # Beta by moment matching on the natural scale.
  m <- stats::plogis(pool$estimate)
  g <- m * (1 - m)
  v <- (g^2) * sd_pred^2
  if (v <= 0 || v >= g) return(list(kind = "beta", alpha = NA_real_, beta = NA_real_, basis = "degenerate"))
  common <- g / v - 1
  list(kind = "beta", alpha = m * common, beta = (1 - m) * common,
       mean = m, sd = sqrt(v), basis = if (pool$tau2 > 0 && pool$k >= 3L) "prediction" else "confidence")
}
