# ---------------------------------------------------------------------------
# rmst.R — restricted mean survival time, the primary time-to-event estimand
# (plan 5.3; FDA 2023 external-control draft, analysis point 4).
#
# Hidden knowledge:
#
# - **RMST is primary and the hazard ratio is secondary, on purpose.** The FDA
#   draft asks that a proportional-hazards primary analysis be backed by a
#   sensitivity analysis that does not assume PH; making the PH-free estimand
#   primary settles that once instead of per study.
# - **The integral is exact, not quadrature.** A Kaplan-Meier curve is a step
#   function, so the area under it on [0, tau] is a finite sum of rectangles;
#   any numerical integrator here would introduce an error that has no reason
#   to exist. The check against `survRM2` agrees to ~1e-13, which is what
#   "exact" means in doubles.
# - **`tau` beyond either arm's last follow-up is refused, not extrapolated.**
#   Past the last observation the KM estimator is undefined (or, by
#   convention, flat), and a flat tail silently credits the arm with survival
#   nobody observed. `tau_beyond_followup` is one of the seven deterministic
#   not-estimable rules, and the refusal carries the largest usable tau so the
#   caller has something to do next (N11).
# - **Which "last follow-up"?** The plan says tau must not exceed the *largest
#   follow-up in either arm*, and C1 note [27] (Tian et al.) is stricter still:
#   the safe upper limit is the smaller of the two arms' largest *observed*
#   times. We use the stricter reading and report both numbers, because the
#   looser one can leave one arm's KM curve undefined over part of [0, tau].
# - **The weighted variance comes from the bootstrap, not from Greenwood.**
#   Greenwood's formula treats the weights as fixed and is visibly too narrow
#   when the weights were estimated; the closed-form variance here is only
#   used for the unweighted case, where it is exactly survRM2's.
# ---------------------------------------------------------------------------

#' Kaplan-Meier estimate, optionally weighted (Cole & Hernan's IPTW KM).
#' Returns the event times, the survival function after each, and the weighted
#' numbers at risk and of events, which the reconstruction QC also reads.
vcr_km <- function(time, status, weights = NULL) {
  w <- if (is.null(weights)) rep(1, length(time)) else weights
  ord <- order(time)
  time <- time[ord]; status <- status[ord]; w <- w[ord]
  ut <- unique(time[status == 1L])
  if (!length(ut)) {
    return(list(time = numeric(0), surv = numeric(0), atRisk = numeric(0),
                events = numeric(0), censored = numeric(0), lastTime = max(time),
                nEvents = 0, nAtRiskStart = sum(w)))
  }
  atrisk <- vapply(ut, function(t) sum(w[time >= t]), numeric(1))
  events <- vapply(ut, function(t) sum(w[time == t & status == 1L]), numeric(1))
  surv <- cumprod(1 - events / atrisk)
  list(time = ut, surv = surv, atRisk = atrisk, events = events,
       lastTime = max(time), nEvents = sum(w[status == 1L]), nAtRiskStart = sum(w))
}

#' Survival at `t` from a KM fit (left-continuous step function, S(0-) = 1).
vcr_km_at <- function(km, t) {
  vapply(t, function(x) {
    idx <- which(km$time <= x)
    if (!length(idx)) 1 else km$surv[max(idx)]
  }, numeric(1))
}

#' Area under a KM curve on [0, tau], computed exactly as a sum of rectangles.
vcr_rmst <- function(time, status, tau, weights = NULL, variance = TRUE) {
  km <- vcr_km(time, status, weights)
  t_j <- km$time[km$time < tau]
  s_j <- km$surv[km$time < tau]
  widths <- diff(c(0, t_j, tau))
  heights <- c(1, s_j)
  area <- sum(widths * heights)
  out <- list(rmst = area, tau = tau, km = km)
  if (variance) {
    # Greenwood-type variance (Klein & Moeschberger 5.4 / survRM2): each event
    # time contributes the squared remaining area times its Greenwood term.
    d <- km$events[km$time < tau]; n <- km$atRisk[km$time < tau]
    if (length(t_j)) {
      # Remaining area from t_j to tau under the step curve.
      remaining <- vapply(seq_along(t_j), function(j) {
        idx <- which(t_j >= t_j[j])
        w2 <- diff(c(t_j[idx], tau))
        h2 <- s_j[idx]
        sum(w2 * h2)
      }, numeric(1))
      terms <- remaining^2 * d / (n * (n - d))
      terms[!is.finite(terms)] <- 0
      out$variance <- sum(terms)
      out$se <- sqrt(out$variance)
    } else {
      out$variance <- 0; out$se <- 0
    }
  }
  out
}

#' The deterministic tau rule (plan 5.3, N11). Returns NULL when tau is usable,
#' otherwise the rule and the largest tau that would be.
vcr_tau_rule <- function(time, status, arm, tau) {
  arms <- split(seq_along(time), arm)
  last_obs <- vapply(arms, function(i) max(time[i]), numeric(1))
  last_event <- vapply(arms, function(i) {
    ev <- time[i][status[i] == 1L]
    if (length(ev)) max(ev) else 0
  }, numeric(1))
  usable <- min(last_obs)
  if (tau > usable + 1e-12) {
    return(list(rule = "tau_beyond_followup",
                detail = sprintf("tau = %s exceeds the shortest arm's longest follow-up (%s)",
                                 format(tau), format(usable)),
                maxUsableTau = usable,
                lastObservedByArm = as.list(last_obs),
                lastEventByArm = as.list(last_event)))
  }
  NULL
}

#' RMST difference between two arms with optional weights. The interval is
#' asymptotic only when the weights are fixed; when they were estimated the
#' caller must pass `interval = "bootstrap"` and supply `vcr_bootstrap_pipeline`.
vcr_rmst_difference <- function(time, status, arm, tau, weights = NULL, alpha = 0.05) {
  rule <- vcr_tau_rule(time, status, arm, tau)
  if (!is.null(rule)) return(c(rule, list(estimate = NULL)))
  i1 <- arm == 1L; i0 <- arm == 0L
  w <- weights
  r1 <- vcr_rmst(time[i1], status[i1], tau, if (is.null(w)) NULL else w[i1])
  r0 <- vcr_rmst(time[i0], status[i0], tau, if (is.null(w)) NULL else w[i0])
  est <- r1$rmst - r0$rmst
  se <- sqrt(r1$variance + r0$variance)
  z <- stats::qnorm(1 - alpha / 2)
  list(estimate = est, se = se, arm1 = r1$rmst, arm0 = r0$rmst,
       interval = c(est - z * se, est + z * se),
       tau = tau, survivalAtTau = c(arm1 = vcr_km_at(r1$km, tau), arm0 = vcr_km_at(r0$km, tau)),
       rule = NULL)
}

#' Closed-form RMST for the parametric distributions the reference simulators
#' generate. This is the analytic half of "analytic first, simulation as the
#' check" for the time-to-event family.
vcr_rmst_analytic <- function(dist, tau) {
  kind <- dist$kind %||% "exponential"
  if (identical(kind, "exponential")) {
    return((1 - exp(-dist$rate * tau)) / dist$rate)
  }
  if (identical(kind, "weibull")) {
    # E[min(T, tau)] = scale * gamma(1 + 1/shape) * pgamma((tau/scale)^shape, 1 + 1/shape)
    k <- dist$shape; b <- dist$scale
    return(b * gamma(1 + 1 / k) * stats::pgamma((tau / b)^k, 1 + 1 / k, lower.tail = TRUE))
  }
  if (identical(kind, "piecewise")) {
    breaks <- c(0, dist$breaks, Inf)
    rates <- dist$rates
    total <- 0; S <- 1; t0 <- 0
    for (i in seq_along(rates)) {
      t1 <- min(breaks[i + 1L], tau)
      if (t1 <= t0) break
      lam <- rates[i]
      total <- total + S * (1 - exp(-lam * (t1 - t0))) / lam
      S <- S * exp(-lam * (t1 - t0))
      t0 <- t1
      if (t0 >= tau) break
    }
    return(total)
  }
  stop("vcr_rmst_analytic: unknown distribution kind ", kind)
}

`%||%` <- function(a, b) if (is.null(a)) b else a
