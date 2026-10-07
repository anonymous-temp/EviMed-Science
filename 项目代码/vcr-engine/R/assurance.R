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

# ---------------------------------------------------------------------------
# Assurance of a group-sequential design (2026-10-07)
#
# Hidden knowledge:
#
# - **A group-sequential design succeeds if it crosses a boundary at ANY look**, so
#   its assurance is the power of the whole sequential procedure averaged over the
#   design prior, not the power of the final analysis: stopping early for efficacy
#   is a success, and the design's O'Brien-Fleming or Pocock boundaries (the ones
#   `design.analytic` computes, not a second set) decide at which look. The look at
#   which the success happens is reported too -- the share of the assurance that is
#   an early stop is what a sponsor buys an interim analysis for.
# - **Exit probabilities by one pass over the looks.** `.vcr_exit_prob` re-derives the
#   density of every earlier look for each look it is asked about, which is fine for
#   one power and far too slow for a quadrature of 48 effects x several looks; the
#   pass below carries the sub-density forward once. It is the same recursion on the
#   same B-value scale (Armitage-McPherson-Rowe), and case N47 holds it to
#   `vcr_group_sequential_power` to 1e-9 at the fine grid and to 1e-6 at the grid used here.
# - **Analytic first, simulation as the check.** The headline is the quadrature; the
#   simulated assurance (an effect drawn from the prior, then the sequential trial's
#   B-value path drawn look by look and compared with the boundaries) is its check and
#   it carries its Monte-Carlo standard error, so the agreement is a number on the
#   result (AC-29) and the page can say the two were run.
# - **Two-sided is the one-sided boundary at alpha / 2 on each tail**, as in
#   `design.analytic`; a path that crosses the far boundary first is not removed
#   (negligible for an effect with a direction, and the same simplification the
#   analytic design calculation makes).
# ---------------------------------------------------------------------------

#' The grid of the boundary search an assurance job uses. `vcr_group_sequential`'s own default (4001 nodes) takes seconds per look (the
#' cost grows with the square of the grid and with the square of the looks); 1201 nodes give the same boundaries to about 1e-9 (case N47b holds
#' them to `design.analytic`'s to 1e-8), which is far inside what an assurance, itself a quadrature over a prior, can tell apart.
VCR_ASSURANCE_BOUNDARY_NODES <- 1201L

#' Exit probability at every look of a group-sequential design at one drift
#' (`theta * sqrt(Imax)` on the B scale), by one pass over the looks.
#'
#' @param design the list `vcr_group_sequential` returns
#' @param nodes Simpson nodes of the continuation density (odd)
vcr_gs_exits <- function(design, drift, nodes = 801L, span = 9) {
  t <- design$informationRates; b <- design$boundsB; K <- length(t)
  exits <- numeric(K)
  exits[1] <- stats::pnorm(b[1], drift * t[1], sqrt(t[1]), lower.tail = FALSE)
  if (K == 1L) return(exits)
  grid_at <- function(k) {
    sd_k <- sqrt(t[k]); mu_k <- drift * t[k]
    lo <- mu_k - span * sd_k; hi <- if (k <= length(b)) b[k] else mu_k + span * sd_k
    if (hi <= lo) hi <- lo + 1e-9
    seq(lo, hi, length.out = nodes)
  }
  grid <- grid_at(1L)
  dens <- stats::dnorm(grid, drift * t[1], sqrt(t[1]))
  for (k in 2:K) {
    dt <- t[k] - t[k - 1L]; sd_step <- sqrt(dt); mu_step <- drift * dt
    w <- .vcr_simpson_weights(length(grid)) * (grid[2] - grid[1])
    pw <- dens * w
    exits[k] <- sum(pw * stats::pnorm(b[k] - grid, mu_step, sd_step, lower.tail = FALSE))
    if (k < K) {
      new_grid <- grid_at(k)
      dens <- as.vector(stats::dnorm(outer(new_grid, grid, "-"), mu_step, sd_step) %*% pw)
      grid <- new_grid
    }
  }
  exits
}

#' Assurance of a group-sequential time-to-event design under a normal design
#' prior on the log hazard ratio: the power of the sequential procedure
#' integrated over the prior, by Gauss-Hermite, with the share of it that is an
#' early stop at each look.
#'
#' `events` is the design's maximum number of events (the information at the
#' last look); the effect enters as the drift -theta * sqrt(events * p * (1 - p)).
vcr_assurance_group_sequential <- function(design, prior_mean_loghr, prior_sd, events, allocation = 0.5, sided = 1,
                                           nodes = 48L, quadrature = 801L) {
  sided <- vcr_check_sided(sided)
  sinfo <- sqrt(events * allocation * (1 - allocation))
  exits_at <- function(loghr) {
    e <- vcr_gs_exits(design, -loghr * sinfo, quadrature)
    if (sided == 2) e <- e + vcr_gs_exits(design, loghr * sinfo, quadrature)
    e
  }
  gh <- .vcr_gauss_hermite(nodes)
  x <- prior_mean_loghr + sqrt(2) * prior_sd * gh$nodes
  w <- gh$weights / sqrt(pi)
  by_node <- t(vapply(x, exits_at, numeric(length(design$informationRates))))
  by_look <- colSums(w * by_node)
  at_mean <- exits_at(prior_mean_loghr)
  list(assurance = sum(by_look), byLook = by_look, power = sum(at_mean), powerByLook = at_mean, events = events, nodes = nodes)
}

#' The same assurance by simulation: an effect from the design prior, then the
#' sequential trial's B-value path, look by look, against the boundaries. One
#' stream, drawn in a fixed order, so the number does not depend on the cores.
#' Returns the proportion that crossed a boundary and its Monte-Carlo standard error.
vcr_assurance_group_sequential_simulated <- function(design, prior_mean_loghr, prior_sd, events, allocation = 0.5, sided = 1, replicates = 20000L) {
  sided <- vcr_check_sided(sided)
  sinfo <- sqrt(events * allocation * (1 - allocation))
  t <- design$informationRates; b <- design$boundsB; K <- length(t)
  theta <- stats::rnorm(replicates, prior_mean_loghr, prior_sd)
  dt <- diff(c(0, t))
  incr <- matrix(stats::rnorm(replicates * K), replicates, K)
  # B(t_k) = drift * t_k + W(t_k), with the drift on the benefit scale; the increments are independent normals
  steps <- sweep(incr, 2L, sqrt(dt), "*") + outer(-theta * sinfo, dt)
  path <- steps
  for (k in seq_len(K)[-1L]) path[, k] <- path[, k - 1L] + steps[, k]
  crossed <- if (sided == 2) abs(path) > matrix(b, replicates, K, byrow = TRUE) else path > matrix(b, replicates, K, byrow = TRUE)
  success <- rowSums(crossed) > 0
  p <- mean(success)
  list(assurance = p, mcse = vcr_mcse_proportion(p, replicates), replicates = replicates)
}

`%||%` <- function(a, b) if (is.null(a)) b else a
