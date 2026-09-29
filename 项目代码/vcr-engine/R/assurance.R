# ---------------------------------------------------------------------------
# assurance.R — probability of success averaged over the evidence (O'Hagan
# 2005; plan 5.4).
#
# Hidden knowledge:
#
# - **Assurance is power integrated against a design prior, and the design
#   prior is not the analysis prior.** The design prior says what we believe
#   the effect is; the analysis prior (if any) says what the final analysis
#   will assume. Using one for both is the standard way to produce a number
#   that is neither a frequentist power nor a Bayesian posterior probability.
#   This module only ever takes a design prior and only ever integrates a
#   frequentist power function.
# - **EviMed's design prior comes from its own meta-analysis.** That is the
#   difference from nQuery or East, where the user types a number: here the
#   prior is the *prediction* distribution out of `evidence_pool.R`, so the
#   assurance inherits the heterogeneity of the literature instead of ignoring
#   it. It is also why the answer is usually well below the quoted power.
# - **Gauss-Hermite, not Monte Carlo, for a normal design prior.** 64 nodes
#   integrate a smooth power function to ~1e-12, are deterministic, and cost
#   nothing; Monte Carlo here would add a second source of error on top of the
#   one the simulation already has, with no upside.
# - Assurance is not a "trial success prediction score". Vendors sell those
#   with an accuracy figure and no formula; this one is a stated integral over
#   a stated prior and both are in the manifest.
# ---------------------------------------------------------------------------

#' Assurance for an arbitrary power function under a normal design prior.
#'
#' @param power_fn function(effect) -> power in [0, 1]; vectorized or not.
#' @param prior list(kind = "normal", mean =, sd =) or
#'   list(kind = "discrete", values =, weights =).
vcr_assurance <- function(power_fn, prior, nodes = 64L) {
  if (identical(prior$kind, "discrete")) {
    w <- prior$weights / sum(prior$weights)
    p <- vapply(prior$values, function(v) as.numeric(power_fn(v)), numeric(1))
    return(list(assurance = sum(w * p), nodes = length(w),
                grid = data.frame(effect = prior$values, weight = w, power = p)))
  }
  if (!identical(prior$kind, "normal")) stop("vcr_assurance: prior must be normal or discrete")
  gh <- .vcr_gauss_hermite(nodes)
  x <- prior$mean + sqrt(2) * prior$sd * gh$nodes
  w <- gh$weights / sqrt(pi)
  p <- vapply(x, function(v) as.numeric(power_fn(v)), numeric(1))
  list(assurance = sum(w * p), nodes = nodes,
       grid = data.frame(effect = x, weight = w, power = p),
       prior = prior)
}

#' Assurance for a two-sample mean comparison, the closed-form case.
#'
#' With effect ~ N(m, s^2) and a z-test, assurance has a closed form:
#' P(Z > z_alpha) with Z ~ N(m/se, 1 + s^2/se^2), so
#' assurance = Phi((m/se - z_alpha) / sqrt(1 + s^2/se^2)).
vcr_assurance_means <- function(prior_mean, prior_sd, sd, n_treat, n_control,
                                alpha = 0.025) {
  se <- sd * sqrt(1 / n_treat + 1 / n_control)
  za <- stats::qnorm(1 - alpha)
  closed <- stats::pnorm((prior_mean / se - za) / sqrt(1 + (prior_sd / se)^2))
  numeric_ <- vcr_assurance(function(d) stats::pnorm(d / se - za),
                            list(kind = "normal", mean = prior_mean, sd = prior_sd))
  list(assurance = closed, assuranceQuadrature = numeric_$assurance,
       power = stats::pnorm(prior_mean / se - za), se = se)
}

#' Assurance for a time-to-event design, integrating Schoenfeld power over a
#' normal prior on log(HR).
vcr_assurance_loghr <- function(prior_mean_loghr, prior_sd, events,
                                alpha = 0.025, allocation = 0.5) {
  za <- stats::qnorm(1 - alpha)
  sinfo <- sqrt(events * allocation * (1 - allocation))
  power_fn <- function(loghr) stats::pnorm(-loghr * sinfo - za)
  out <- vcr_assurance(power_fn, list(kind = "normal", mean = prior_mean_loghr, sd = prior_sd))
  out$power <- power_fn(prior_mean_loghr)
  out$events <- events
  out
}
