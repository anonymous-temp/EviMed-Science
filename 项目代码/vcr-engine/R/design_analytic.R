# ---------------------------------------------------------------------------
# design_analytic.R — closed-form design calculations. Analytic first,
# simulation as the check (plan 5.4, AC-29).
#
# Hidden knowledge:
#
# - **The group-sequential boundaries are computed here, not delegated.** rpact
#   and gsDesign are the cross-checks (N01), not the implementation, for two
#   reasons: the plan's numeric acceptance requires two independent
#   implementations to agree (12.4), and rpact's formal GxP validation package
#   is behind paid support, so a number we cannot derive ourselves is a number
#   we cannot defend. The recursion below is Armitage-McPherson-Rowe on the
#   B-value (score) scale, where the increments are independent normals — on
#   the Z scale they are correlated and the integral does not factor.
# - **Integrate on the B scale with a fixed grid.** A quadrature whose node
#   count depends on the boundary would make the answer depend on the
#   iteration history of the root finder, so the grid is a function of the
#   information fraction alone. 4001 Simpson nodes over +-9 sd reproduces
#   rpact to ~1e-9, far inside the 1e-4 the case asks for; the cost is
#   milliseconds and it buys a number that does not move between runs.
# - **`sfLDOF` at t = 1 spends slightly less than alpha** (2*(1-Phi(z_{a/2}))
#   = alpha exactly only in the two-sided reading). gsDesign and rpact both
#   use the one-sided reading 2 - 2*Phi(Phi^-1(1 - alpha/2)/sqrt(t)), which at
#   t = 1 gives exactly alpha. Using the naive one-sided form
#   1 - Phi(z_a/sqrt(t)) instead moves the first boundary by ~0.2 and is the
#   single easiest way to fail N01.
# - **Schoenfeld counts events, not patients.** 331 events for HR 0.7 at 90%
#   power one-sided 0.025 is the number the plan quotes; the patient count
#   then follows from the event probability, which is where accrual and
#   dropout enter (Lachin-Foulkes).
# ---------------------------------------------------------------------------

# --- spending functions ----------------------------------------------------

#' Lan-DeMets O'Brien-Fleming alpha spending. `t` is the information fraction.
vcr_spend_obrien_fleming <- function(t, alpha) {
  t <- pmin(pmax(t, 0), 1)
  out <- 2 - 2 * pnorm(qnorm(1 - alpha / 2) / sqrt(t))
  out[t <= 0] <- 0
  pmin(out, alpha)
}

#' Lan-DeMets Pocock alpha spending.
vcr_spend_pocock <- function(t, alpha) {
  t <- pmin(pmax(t, 0), 1)
  out <- alpha * log(1 + (exp(1) - 1) * t)
  out[t <= 0] <- 0
  pmin(out, alpha)
}

vcr_spending_function <- function(name) {
  switch(name,
    obrien_fleming = vcr_spend_obrien_fleming,
    pocock = vcr_spend_pocock,
    stop("vcr_spending_function: unknown spending function ", name))
}

# --- the sequential recursion ----------------------------------------------

#' Sub-density of the B-value at analysis k, restricted to having continued.
#'
#' Returns a list(grid, density) on a fixed Simpson grid. `density` integrates
#' to the probability of still being in the trial at analysis k.
.vcr_seq_density <- function(info, bounds_b, k, drift = 0, nodes = 4001L, span = 9) {
  # grid for analysis k covers [-span*sd + mean, upper], upper = continuation bound
  sd_k <- sqrt(info[k])
  mu_k <- drift * info[k]
  upper <- if (k <= length(bounds_b)) bounds_b[k] else mu_k + span * sd_k
  lo <- mu_k - span * sd_k
  if (upper <= lo) upper <- lo + 1e-9
  grid <- seq(lo, upper, length.out = nodes)
  if (k == 1L) {
    dens <- dnorm(grid, mu_k, sd_k)
    return(list(grid = grid, density = dens))
  }
  prev <- .vcr_seq_density(info, bounds_b, k - 1L, drift, nodes, span)
  dt <- info[k] - info[k - 1L]
  sd_step <- sqrt(dt)
  mu_step <- drift * dt
  h <- prev$grid[2] - prev$grid[1]
  w <- .vcr_simpson_weights(length(prev$grid)) * h
  pw <- prev$density * w
  dens <- vapply(grid, function(x) sum(pw * dnorm(x - prev$grid, mu_step, sd_step)), numeric(1))
  list(grid = grid, density = dens)
}

.vcr_simpson_weights <- function(n) {
  if (n %% 2L == 0L) stop("Simpson's rule needs an odd number of nodes")
  w <- rep(2, n); w[seq(2, n - 1, by = 2)] <- 4; w[1] <- 1; w[n] <- 1
  w / 3
}

#' Exit probability at analysis `k` given continuation bounds for 1..k-1.
.vcr_exit_prob <- function(info, bounds_b, k, b_k, drift = 0, nodes = 4001L, span = 9) {
  if (k == 1L) return(pnorm(b_k, drift * info[1], sqrt(info[1]), lower.tail = FALSE))
  prev <- .vcr_seq_density(info, bounds_b, k - 1L, drift, nodes, span)
  dt <- info[k] - info[k - 1L]
  h <- prev$grid[2] - prev$grid[1]
  w <- .vcr_simpson_weights(length(prev$grid)) * h
  sum(prev$density * w * pnorm(b_k - prev$grid, drift * dt, sqrt(dt), lower.tail = FALSE))
}

#' Lan-DeMets group-sequential efficacy boundaries (one-sided, upper).
#'
#' `information_rates` are cumulative information fractions ending at 1.
#' Returns Z-scale critical values, the alpha spent at each look, and the
#' cumulative exit probability under the drift that gives the target power.
vcr_group_sequential <- function(information_rates, alpha = 0.025,
                                 spending = "obrien_fleming", nodes = 4001L) {
  t <- as.numeric(information_rates)
  if (abs(t[length(t)] - 1) > 1e-12) stop("vcr_group_sequential: information rates must end at 1")
  if (any(diff(t) <= 0)) stop("vcr_group_sequential: information rates must increase")
  K <- length(t)
  sf <- vcr_spending_function(spending)
  cum_spend <- sf(t, alpha)
  incr <- diff(c(0, cum_spend))
  # Work on the B scale with information = t (unit total information).
  bounds_b <- numeric(K)
  for (k in seq_len(K)) {
    target <- incr[k]
    f <- function(b) .vcr_exit_prob(t, bounds_b, k, b, drift = 0, nodes = nodes) - target
    # Bracket generously: the OBF first boundary can exceed z = 8 for small t.
    lo <- -1; hi <- 12 * sqrt(t[k])
    bounds_b[k] <- stats::uniroot(f, lower = lo, upper = hi, tol = 1e-12)$root
  }
  z <- bounds_b / sqrt(t)
  list(
    informationRates = t, alpha = alpha, spending = spending,
    criticalValues = z, boundsB = bounds_b,
    cumulativeAlphaSpent = cum_spend, alphaSpent = incr
  )
}

#' Power of a group-sequential design at a given drift on the B scale
#' (drift = theta, so B(t) ~ N(theta * t * Imax, t * Imax) with Imax = 1 after
#' scaling; we pass the standardized drift `theta_sqrt_Imax`).
vcr_group_sequential_power <- function(design, theta_sqrt_imax, nodes = 4001L) {
  t <- design$informationRates
  exits <- numeric(length(t))
  for (k in seq_along(t)) {
    exits[k] <- .vcr_exit_prob(t, design$boundsB, k, design$boundsB[k],
                               drift = theta_sqrt_imax, nodes = nodes)
  }
  list(exitProbabilities = exits, power = sum(exits),
       expectedInformationFraction = sum(exits * t) + (1 - sum(exits)) * 1)
}

#' The inflation factor: how much more information a group-sequential design
#' needs than a fixed design for the same power.
vcr_gs_inflation <- function(design, power = 0.9, nodes = 4001L) {
  fixed <- (qnorm(1 - design$alpha) + qnorm(power))
  f <- function(drift) vcr_group_sequential_power(design, drift, nodes)$power - power
  drift <- stats::uniroot(f, lower = 0.1 * fixed, upper = 3 * fixed, tol = 1e-10)$root
  (drift / fixed)^2
}

# --- fixed designs ---------------------------------------------------------

#' Schoenfeld's required number of events.
#' `allocation` is the proportion allocated to the treatment arm.
vcr_events_schoenfeld <- function(hazard_ratio, alpha = 0.025, power = 0.9,
                                  allocation = 0.5, sided = 1) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  zb <- qnorm(power)
  (za + zb)^2 / (allocation * (1 - allocation) * log(hazard_ratio)^2)
}

#' Probability that a subject contributes an event, under exponential event
#' and dropout hazards, uniform accrual over [0, A] and analysis at A + F
#' (Lachin & Foulkes 1986).
vcr_event_probability <- function(event_rate, accrual_duration, followup_duration,
                                  dropout_rate = 0) {
  lam <- event_rate; eta <- dropout_rate
  A <- accrual_duration; F <- followup_duration
  Tt <- A + F
  s <- lam + eta
  if (A <= 0) return(lam / s * (1 - exp(-s * F)))
  lam / s * (1 - (exp(-s * F) - exp(-s * Tt)) / (s * A))
}

#' Sample size for a two-sample comparison of means (pooled variance, normal
#' approximation, then one Satterthwaite-free t-correction round).
vcr_n_means <- function(delta, sd = 1, alpha = 0.025, power = 0.9,
                        allocation = 0.5, sided = 1) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  zb <- qnorm(power)
  n_total <- (za + zb)^2 * sd^2 / (allocation * (1 - allocation) * delta^2)
  list(total = n_total, treat = n_total * allocation, control = n_total * (1 - allocation))
}

vcr_power_means <- function(delta, sd, n_treat, n_control, alpha = 0.025, sided = 1) {
  se <- sd * sqrt(1 / n_treat + 1 / n_control)
  df <- n_treat + n_control - 2
  crit <- qt(1 - if (sided == 1) alpha else alpha / 2, df)
  ncp <- delta / se
  pt(crit, df, ncp = ncp, lower.tail = FALSE) +
    (if (sided == 2) pt(-crit, df, ncp = ncp) else 0)
}

#' Two-proportion sample size, normal approximation with the pooled variance
#' under the null (the test `vcr_analyse_risk_difference` actually performs).
vcr_n_proportions <- function(p_control, p_treat, alpha = 0.025, power = 0.9,
                              allocation = 0.5, sided = 1) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  zb <- qnorm(power)
  r <- allocation / (1 - allocation)
  pbar <- (r * p_treat + p_control) / (r + 1)
  num <- za * sqrt((1 + 1 / r) * pbar * (1 - pbar)) +
         zb * sqrt(p_treat * (1 - p_treat) / r + p_control * (1 - p_control))
  n_control <- (num / (p_treat - p_control))^2
  list(control = n_control, treat = n_control * r, total = n_control * (1 + r))
}

vcr_power_proportions <- function(p_control, p_treat, n_treat, n_control,
                                  alpha = 0.025, sided = 1) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  pbar <- (n_treat * p_treat + n_control * p_control) / (n_treat + n_control)
  se0 <- sqrt(pbar * (1 - pbar) * (1 / n_treat + 1 / n_control))
  se1 <- sqrt(p_treat * (1 - p_treat) / n_treat + p_control * (1 - p_control) / n_control)
  pnorm((abs(p_treat - p_control) - za * se0) / se1)
}

#' Simon's two-stage designs (optimal and minimax), exact binomial.
vcr_simon_two_stage <- function(p0, p1, alpha = 0.05, beta = 0.2, n_max = 100) {
  best_opt <- NULL; best_min <- NULL
  for (n in 1:n_max) {
    for (n1 in 1:(n - 1)) {
      for (r1 in 0:(n1 - 1)) {
        pet0 <- pbinom(r1, n1, p0)
        # early stop under H1 must not be too likely; enumerate r
        for (r in r1:(n - 1)) {
          # P(reject H0) = P(X1 > r1 and X1 + X2 > r)
          pow <- .vcr_simon_prob(p1, n1, n, r1, r)
          typ1 <- .vcr_simon_prob(p0, n1, n, r1, r)
          if (typ1 <= alpha && pow >= 1 - beta) {
            en0 <- n1 + (1 - pet0) * (n - n1)
            cand <- list(n1 = n1, r1 = r1, n = n, r = r, EN0 = en0, PET0 = pet0,
                         alpha = typ1, power = pow)
            if (is.null(best_opt) || en0 < best_opt$EN0) best_opt <- cand
            if (is.null(best_min) || n < best_min$n || (n == best_min$n && en0 < best_min$EN0)) best_min <- cand
          }
        }
      }
    }
    if (!is.null(best_min) && best_min$n <= n) break
  }
  list(optimal = best_opt, minimax = best_min)
}

.vcr_simon_prob <- function(p, n1, n, r1, r) {
  total <- 0
  for (x1 in (r1 + 1):n1) {
    need <- r - x1
    p2 <- if (need < 0) 1 else pbinom(need, n - n1, p, lower.tail = FALSE)
    total <- total + dbinom(x1, n1, p) * p2
  }
  total
}

# --- exact asymptotic log-rank power ---------------------------------------

#' Expected proportion still under observation `t` after entry, for uniform
#' accrual over [0, A] analysed at A + F, with an exponential dropout hazard.
vcr_at_risk_fraction <- function(t, accrual_duration, followup_duration, dropout_rate = 0) {
  A <- accrual_duration; F <- followup_duration; Tt <- A + F
  admin <- ifelse(t <= F, 1, ifelse(t < Tt, (Tt - t) / A, 0))
  if (A <= 0) admin <- as.numeric(t <= F)
  admin * exp(-dropout_rate * t)
}

#' Power of the log-rank test from its exact asymptotic mean and variance.
#'
#' Hidden knowledge: Schoenfeld's `(z_a + z_b)^2 / (p(1-p) log(HR)^2)` is a
#' *local* approximation -- it assumes the at-risk split stays at the
#' randomization ratio, which stops being true as soon as the hazard ratio is
#' away from 1. On the engine's own reference designs it over-states power by
#' one to four percentage points: at HR 0.7 with 409 events it predicts 0.9503
#' where the simulation gives 0.9394, and the gap is a *systematic* 3 Monte-
#' Carlo standard errors at the plan's own replicate floor. AC-29 is therefore
#' not passable for the time-to-event family with Schoenfeld as the reference,
#' and the fix belongs in the reference, not in the tolerance.
#'
#' The exact version integrates the score's mean and variance over follow-up:
#'   pi_k(t) = n_k S_k(t) G(t)          expected at risk in arm k
#'   phi(t)  = pi_1 / (pi_1 + pi_0)
#'   E[U]    = integral phi (1-phi) (pi_0 + pi_1) lambda_0 (theta - 1) dt
#'   V       = integral phi (1-phi) (pi_0 + pi_1) lambda_0 (phi theta + 1 - phi) dt
#' and power = Phi(E[U]/sqrt(V) - z_alpha). The two reduce to Schoenfeld's
#' formula as theta -> 1, which is the check `tests/numeric/E07` reports.
vcr_logrank_power <- function(hazard_ratio, control_dist, n_treat, n_control,
                              accrual_duration = 0, followup_duration = Inf,
                              dropout_rate = 0, alpha = 0.025, max_followup = Inf,
                              nodes = 4001L) {
  theta <- hazard_ratio
  Tt <- min(if (is.finite(followup_duration)) accrual_duration + followup_duration else Inf, max_followup)
  if (!is.finite(Tt)) Tt <- 60 * vcr_dist_median(control_dist)
  grid <- seq(0, Tt, length.out = nodes)
  h0 <- vcr_dist_hazard(control_dist, grid)
  S0 <- vcr_dist_survival(control_dist, grid)
  S1 <- S0^theta
  G <- vcr_at_risk_fraction(grid, accrual_duration,
                            if (is.finite(followup_duration)) followup_duration else Tt, dropout_rate)
  p1 <- n_treat * S1 * G
  p0 <- n_control * S0 * G
  tot <- p1 + p0
  phi <- ifelse(tot > 0, p1 / tot, 0)
  w <- .vcr_simpson_weights(nodes) * (grid[2] - grid[1])
  common <- phi * (1 - phi) * tot * h0
  drift <- sum(w * common * (theta - 1))
  variance <- sum(w * common * (phi * theta + 1 - phi))
  events <- sum(w * (p1 * theta * h0 + p0 * h0))
  z <- if (variance > 0) drift / sqrt(variance) else 0
  list(power = stats::pnorm(-z - stats::qnorm(1 - alpha)),
       expectedEvents = events, drift = -z, variance = variance,
       schoenfeldPower = {
         alloc <- n_treat / (n_treat + n_control)
         stats::pnorm(-log(theta) * sqrt(events * alloc * (1 - alloc)) - stats::qnorm(1 - alpha))
       })
}

vcr_dist_hazard <- function(dist, t) {
  kind <- dist$kind %||% "exponential"
  if (identical(kind, "exponential")) return(rep(dist$rate, length(t)))
  if (identical(kind, "weibull")) return(dist$shape / dist$scale * (t / dist$scale)^(dist$shape - 1))
  if (identical(kind, "piecewise")) {
    breaks <- c(0, dist$breaks, Inf)
    return(dist$rates[findInterval(t, breaks, rightmost.closed = FALSE)])
  }
  stop("vcr_dist_hazard: unknown distribution kind ", kind)
}

vcr_dist_survival <- function(dist, t) {
  kind <- dist$kind %||% "exponential"
  if (identical(kind, "exponential")) return(exp(-dist$rate * t))
  if (identical(kind, "weibull")) return(exp(-(t / dist$scale)^dist$shape))
  if (identical(kind, "piecewise")) {
    breaks <- c(0, dist$breaks, Inf)
    widths <- diff(breaks); widths[length(widths)] <- Inf
    cum <- c(0, cumsum(dist$rates[-length(dist$rates)] * widths[-length(widths)]))
    idx <- findInterval(t, breaks, rightmost.closed = FALSE)
    return(exp(-(cum[idx] + dist$rates[idx] * (t - breaks[idx]))))
  }
  stop("vcr_dist_survival: unknown distribution kind ", kind)
}

vcr_dist_median <- function(dist) {
  f <- function(t) vcr_dist_survival(dist, t) - 0.5
  stats::uniroot(f, c(1e-9, 1e6), tol = 1e-10)$root
}
