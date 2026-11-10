# ---------------------------------------------------------------------------
# evidence_tau_prior.R — an informative prior for the between-study heterogeneity of a pooling (evidence.pool, `tauPrior`;
# algorithm round E7, 2026-11-03).
#
# The person's question is "I have two studies; how wide should the design prior be?". The Higgins-Thompson-Spiegelhalter prediction
# interval needs three, and with two the heterogeneity cannot be estimated from the data at all: a Bayesian pooling with an external
# prior for tau answers it, and an empirical prior (Turner et al. 2015; Bartos et al. 2023) is the honest external evidence for it.
#
# Hidden knowledge:
#
# - **The pooled effect has a flat prior and is integrated out in closed form; only tau needs a grid.** Given tau the pooled effect is
#   normal (the generalized-least-squares mean, variance 1 / sum of the weights), and the marginal likelihood of tau is the REML one
#   (`vcr_map_prior` uses the same expression), so one dimension of quadrature gives the posterior of the pooled effect, of a new study's
#   effect and of tau itself, to quadrature accuracy and to the last bit on every run. The grid is equally spaced in log(tau), where the
#   integrand is smooth and falls away at both ends, so the trapezoid rule converges geometrically; bayesmeta (which integrates with
#   its own adaptive scheme) is the independent check in the numeric case.
# - **Four families, each in its own parametrization, never converted.** A half-normal on tau (scale), a log-normal on tau-squared (mean and
#   sd of log tau-squared; Turner), an inverse-gamma on tau (shape and scale; Bartos) and a log-t on tau-squared (location, scale, degrees of
#   freedom, the scale being the scale of the t distribution). The densities are written on tau and carry the Jacobian of the change of
#   variable: a log-normal prior on tau-squared is NOT a log-normal prior on tau with the same numbers.
# - **The tables are in the domain, the engine reads a copy.** Turner's 80 settings and Bartos's four general priors are in
#   `vcrEvidencePriors.mjs` (with the place in the paper each was read at); this file looks a setting up by its ids and refuses an id
#   that is not there. The prior's own median and its 95% range for tau go into the result, so a reader can see how informative it was
#   next to what the data did to it.
# - **With one study the data say nothing about tau**, so the posterior of tau is the prior and the prediction interval is the prior's
#   statement alone: it is computed, and the result says the pooling rested on one study.
# - **The frequentist pooling is kept beside the Bayesian one** (`diagnostics.frequentist`), and the Bayesian numbers are what the measures
#   say when a prior was stated. A prior changes the pooled value and its interval a little and the spread of a new study a lot; the two are
#   different statements, and the page shows both.
# ---------------------------------------------------------------------------

VCR_TAU_PRIOR_GRID <- 2001L

#' The prior as a density on tau (log scale, up to a constant), a quantile function for tau, and the words that name it.
vcr_tau_prior_resolve <- function(prior) {
  kind <- as.character(prior$kind %||% "")
  d <- if (kind %in% c("turner_2015", "turner_2015_generic", "bartos_2023")) vcr_domain()$heterogeneityPriors else NULL
  num <- function(key) {
    v <- vcr_scalar(prior[[key]], NULL)
    if (is.null(v) || !is.finite(v)) vcr_abort("scenario_field_missing", paste0("scenario.tauPrior.", key), "The prior states this number.")
    v
  }
  if (kind %in% c("turner_2015", "turner_2015_generic")) {
    if (identical(kind, "turner_2015")) {
      cell <- d$turner2015$priors[[as.character(prior$outcome %||% "")]][[as.character(prior$comparison %||% "")]]
      if (is.null(cell)) vcr_abort("scenario_value_invalid", "scenario.tauPrior", "No such outcome and comparison type in the table of Turner et al. (2015).")
      mu <- as.numeric(cell[[1]]); s <- as.numeric(cell[[2]])
    } else {
      mu <- as.numeric(d$turner2015$generic[[1]]); s <- as.numeric(d$turner2015$generic[[2]])
    }
    return(.vcr_tau_prior_lognormal(mu, s, source = kind))
  }
  if (identical(kind, "bartos_2023")) {
    cell <- d$bartos2023$priors[[as.character(prior$effectScale %||% "")]]
    if (is.null(cell)) vcr_abort("scenario_value_invalid", "scenario.tauPrior.effectScale", "No such effect scale in the table of Bartos et al. (2023).")
    out <- if (identical(cell$kind, "half_normal")) .vcr_tau_prior_halfnormal(as.numeric(cell$scale)) else .vcr_tau_prior_invgamma(as.numeric(cell$shape), as.numeric(cell$scale))
    out$source <- "bartos_2023"
    return(out)
  }
  switch(kind,
    half_normal = .vcr_tau_prior_halfnormal(num("scale")),
    log_normal = .vcr_tau_prior_lognormal(num("meanLog"), num("sdLog"), source = "stated"),
    inverse_gamma = .vcr_tau_prior_invgamma(num("shape"), num("scale")),
    log_t = .vcr_tau_prior_logt(num("location"), num("scale"), num("df")),
    vcr_abort("scenario_value_invalid", "scenario.tauPrior.kind", "Unknown heterogeneity prior."))
}

.vcr_tau_prior_halfnormal <- function(s) {
  list(kind = "half_normal", source = "stated", params = list(scale = s),
       logdens = function(tau) stats::dnorm(tau, 0, s, log = TRUE),
       quantile = function(p) s * stats::qnorm((1 + p) / 2),
       medianTau = s * stats::qnorm(0.75))
}

#' log(tau^2) ~ Normal(m, s^2). Density of tau = density of u = tau^2 times 2 tau.
.vcr_tau_prior_lognormal <- function(m, s, source = "stated") {
  list(kind = "log_normal", source = source, params = list(meanLog = m, sdLog = s),
       logdens = function(tau) stats::dlnorm(tau^2, m, s, log = TRUE) + log(2 * tau),
       quantile = function(p) sqrt(exp(m + s * stats::qnorm(p))),
       medianTau = sqrt(exp(m)))
}

#' tau ~ Inverse-Gamma(shape a, scale b): 1 / tau ~ Gamma(a, rate b).
.vcr_tau_prior_invgamma <- function(a, b) {
  list(kind = "inverse_gamma", source = "stated", params = list(shape = a, scale = b),
       logdens = function(tau) a * log(b) - lgamma(a) - (a + 1) * log(tau) - b / tau,
       quantile = function(p) 1 / stats::qgamma(1 - p, shape = a, rate = b),
       medianTau = 1 / stats::qgamma(0.5, shape = a, rate = b))
}

#' log(tau^2) ~ location + scale * t(df).
.vcr_tau_prior_logt <- function(loc, scale, df) {
  list(kind = "log_t", source = "stated", params = list(location = loc, scale = scale, df = df),
       logdens = function(tau) { z <- (log(tau^2) - loc) / scale; stats::dt(z, df, log = TRUE) - log(scale) - log(tau^2) + log(2 * tau) },
       quantile = function(p) sqrt(exp(loc + scale * stats::qt(p, df))),
       medianTau = sqrt(exp(loc)))
}

#' Quantile of a mixture of normals by bisection on its distribution function.
.vcr_normal_mixture_quantile <- function(p, w, m, s) {
  cdf <- function(q) sum(w * stats::pnorm(q, m, s))
  lo <- min(m - 12 * s); hi <- max(m + 12 * s)
  vapply(p, function(pp) stats::uniroot(function(q) cdf(q) - pp, c(lo, hi), tol = 1e-12, maxiter = 500L)$root, numeric(1))
}

#' The Bayesian pooling: flat prior on the pooled effect, an informative prior on tau, integrated on a grid in log(tau).
#'
#' @param prior a resolved prior (`vcr_tau_prior_resolve`).
#' @return the posterior of the pooled effect, of a new study's effect and of tau.
vcr_pool_bayes <- function(yi, vi, prior, level = 0.95, nodes = VCR_TAU_PRIOR_GRID) {
  k <- length(yi)
  if (k < 1L || k != length(vi)) stop("vcr_pool_bayes: yi and vi must have the same positive length")
  scale_d <- max(sqrt(mean(vi)), if (k > 1L) stats::sd(yi) else 0, 1e-3)
  lo <- max(prior$quantile(1e-9), 1e-6 * scale_d); hi <- min(prior$quantile(1 - 1e-9), 1e6 * scale_d)
  if (!is.finite(lo) || !is.finite(hi) || !(hi > lo)) { lo <- 1e-6 * scale_d; hi <- 1e3 * scale_d }
  x <- seq(log(lo), log(hi), length.out = nodes)
  dx <- x[2] - x[1]
  tau <- exp(x)
  # per node: weights, the generalized-least-squares mean and its variance, and the marginal likelihood of tau
  W <- 1 / (matrix(vi, k, nodes) + matrix(tau^2, k, nodes, byrow = TRUE))
  S <- colSums(W)
  mu <- colSums(W * yi) / S
  Vmu <- 1 / S
  resid <- colSums(W * (yi - rep(mu, each = k))^2)
  loglik <- -0.5 * colSums(log(1 / W)) - 0.5 * log(S) - 0.5 * resid
  lf <- prior$logdens(tau) + x + loglik
  f <- exp(lf - max(lf))                                  # density in x, up to a constant
  tw <- rep(dx, nodes); tw[c(1L, nodes)] <- dx / 2        # trapezoid weights
  wt <- f * tw; wt <- wt / sum(wt)
  a <- (1 - level) / 2
  m_post <- sum(wt * mu)
  s_theta <- sqrt(Vmu)
  v_post <- sum(wt * (Vmu + mu^2)) - m_post^2
  ci <- .vcr_normal_mixture_quantile(c(a, 1 - a), wt, mu, s_theta)
  pred_sd <- sqrt(Vmu + tau^2)
  v_pred <- sum(wt * (Vmu + tau^2 + mu^2)) - m_post^2
  pi <- .vcr_normal_mixture_quantile(c(a, 1 - a), wt, mu, pred_sd)
  # tau: the distribution function by the cumulative trapezoid, read by linear interpolation in x
  cum <- c(0, cumsum((f[-nodes] + f[-1L]) / 2 * dx)); cum <- cum / cum[nodes]
  qtau <- function(p) exp(stats::approx(cum, x, xout = p, ties = "ordered", rule = 2)$y)
  tau_q <- qtau(c(a, 0.5, 1 - a))
  # the prior's own statement about tau, for comparison
  prior_q <- prior$quantile(c(a, 0.5, 1 - a))
  list(estimate = m_post, sd = sqrt(v_post), interval = ci, predictionInterval = pi, predictionSd = sqrt(v_pred),
       tau = tau_q[2], tau2 = tau_q[2]^2, tauInterval = tau_q[c(1, 3)], tau2Interval = tau_q[c(1, 3)]^2,
       tau2Mean = sum(wt * tau^2),
       priorMedianTau = prior_q[2], priorTauInterval = prior_q[c(1, 3)],
       k = k, level = level, nodes = nodes, tauRange = c(lo, hi))
}
