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
#' assurance = Phi((m/se - z_alpha) / sqrt(1 + s^2/se^2)); a two-sided test
#' adds the other tail. `alpha` is the total.
vcr_assurance_means <- function(prior_mean, prior_sd, sd, n_treat, n_control,
                                alpha = 0.025, sided = 1) {
  sided <- vcr_check_sided(sided)
  se <- sd * sqrt(1 / n_treat + 1 / n_control)
  za <- stats::qnorm(1 - alpha / sided)
  tail_up <- function(m, s) stats::pnorm((m / se - za) / sqrt(1 + (s / se)^2))
  closed <- tail_up(prior_mean, prior_sd) + if (sided == 2) tail_up(-prior_mean, prior_sd) else 0
  power_fn <- function(d) stats::pnorm(d / se - za) + if (sided == 2) stats::pnorm(-d / se - za) else 0
  numeric_ <- vcr_assurance(power_fn, list(kind = "normal", mean = prior_mean, sd = prior_sd))
  list(assurance = closed, assuranceQuadrature = numeric_$assurance,
       power = power_fn(prior_mean), se = se)
}

#' Assurance for a time-to-event design, integrating Schoenfeld power over a
#' normal prior on log(HR).
vcr_assurance_loghr <- function(prior_mean_loghr, prior_sd, events,
                                alpha = 0.025, allocation = 0.5, sided = 1) {
  sided <- vcr_check_sided(sided)
  za <- stats::qnorm(1 - alpha / sided)
  sinfo <- sqrt(events * allocation * (1 - allocation))
  power_fn <- function(loghr) stats::pnorm(-loghr * sinfo - za) + if (sided == 2) stats::pnorm(loghr * sinfo - za) else 0
  out <- vcr_assurance(power_fn, list(kind = "normal", mean = prior_mean_loghr, sd = prior_sd))
  out$power <- power_fn(prior_mean_loghr)
  out$events <- events
  out
}

#' Assurance for a binary endpoint: the power of the two-proportion test,
#' averaged over a normal design prior on the risk difference (the treatment
#' rate is `p_control + RD`, clamped to the open unit interval, and the prior
#' mass that falls outside is reported). The first version sent binary
#' endpoints through the continuous z-test with SD 1, so a 200-per-arm trial
#' with a control rate of 0.3 was scored as if a risk difference were measured
#' in standard deviations (CE-17).
#'
#' Integration is by the quantile function on a fine midpoint grid, which needs
#' nothing of the prior but its quantiles and is deterministic.
vcr_assurance_binary <- function(p_control, prior, n_treat, n_control, alpha = 0.025, sided = 1, nodes = 4000L) {
  sided <- vcr_check_sided(sided)
  u <- (seq_len(nodes) - 0.5) / nodes
  eps <- 1e-9
  rd <- stats::qnorm(u, prior$mean, prior$sd)
  p1 <- p_control + rd
  outside <- mean(p1 <= 0 | p1 >= 1)
  p1 <- pmin(pmax(p1, eps), 1 - eps)
  pw <- vapply(p1, function(x) vcr_power_proportions(p_control, x, n_treat, n_control, alpha, sided), numeric(1))
  centre <- min(max(p_control + prior$mean, eps), 1 - eps)
  list(assurance = mean(pw),
       power = vcr_power_proportions(p_control, centre, n_treat, n_control, alpha, sided),
       priorMassOutsideUnitInterval = outside)
}

`%||%` <- function(a, b) if (is.null(a)) b else a
