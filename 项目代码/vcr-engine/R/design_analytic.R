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

# --- the hypothesis a design tests (T1) ------------------------------------

#' The non-inferiority hypothesis of a scenario, or NULL for the superiority test every design had before.
#'
#' Hidden knowledge: a non-inferiority test moves the null, not the sizing formulas: the null difference of a mean or a risk is minus the
#' margin and the null hazard ratio is the margin, and every sample size, power and test in this file takes that value as an argument
#' that defaults to the superiority null, so a scenario that states no hypothesis computes exactly what it computed before. A two-sided
#' `sided` means the confidence interval's level: the test of a margin is one-sided at `alpha / sided`, in the engine's one convention.
#' `null` is on the scale of the difference (mean or risk), `nullHr` on the hazard ratio's; the other is the superiority value.
vcr_hypothesis <- function(sc) {
  h <- sc[["hypothesis"]]
  if (!is.list(h) || !identical(h[["kind"]], "non_inferiority")) return(NULL)
  m <- vcr_scalar(h[["margin"]], NULL)
  if (is.null(m)) vcr_abort("scenario_field_missing", "scenario.hypothesis.margin", "A non-inferiority hypothesis states its margin.")
  e <- as.character(sc$endpoint$type %||% "")
  list(kind = "non_inferiority", margin = m, endpoint = e,
       null = if (e %in% c("continuous", "binary")) -m else 0,
       nullHr = if (identical(e, "time_to_event")) m else 1)
}

#' What the result says of the hypothesis it tested: the margin, the scale it is on and the line of the null (the difference or the hazard
#' ratio the effect is measured against), so a reader sees the question the sample size answers.
vcr_hypothesis_note <- function(h) list(
  kind = h$kind, margin = h$margin,
  scale = switch(h$endpoint, continuous = "mean_difference", binary = "risk_difference", time_to_event = "hazard_ratio", NA_character_),
  nullValue = if (identical(h$endpoint, "time_to_event")) h$nullHr else h[["null"]],
  test = switch(h$endpoint, continuous = "t_test_against_margin", binary = "farrington_manning_score", time_to_event = "logrank_score_at_margin", NA_character_))

# --- a design is sized for an effect ---------------------------------------

#' Refuse a closed-form sample size for a scenario whose effect is exactly null.
#'
#' Hidden knowledge: every fixed-sample formula here divides by the effect
#' (Schoenfeld by log(HR)^2, the means formula by delta^2, the two-proportion
#' formula by (p1 - p0)^2), so at a null effect the required size is infinite:
#' no number of patients gives a trial any power against nothing. The first
#' version let the infinity through to the result validator, which refused the
#' non-finite measure by index and said nothing about the scenario (live
#' acceptance, 2026-10-04: three `design.analytic` jobs failed with no reason a
#' reader could use, all asked of a scenario with no effect). What the asker
#' wants of such a scenario is the type I error of the design, and that is a
#' simulation's measure (`design.simulate` on the same scenario), so the refusal
#' says so instead of leaving the question to be re-asked in other words.
#'
#' The single-arm exact design is not here: it is given its sample size and
#' enumerates the binomial exactly, so at a null response rate it has an answer
#' (the type I error) and computes it.
#'
#' Returns the scenario's treatment-arm rate for a binary two-arm design (so the
#' caller resolves it once), otherwise NULL. Aborts with `design_effect_null`
#' naming the field the scenario states its effect in.
vcr_analytic_effect_guard <- function(kind, endpoint, truth, hypothesis = NULL) {
  tiny <- function(x) is.finite(x) && abs(x) < 1e-12
  if (!is.null(hypothesis)) {
    # the effect that leaves nothing to resolve is the margin itself
    on_margin <- switch(hypothesis$endpoint,
      continuous = { e <- vcr_scalar(truth$effect, NULL); !is.null(e) && tiny(e - hypothesis[["null"]]) },
      time_to_event = { h <- vcr_scalar(truth$hazardRatio, NULL); !is.null(h) && h > 0 && tiny(log(h / hypothesis$nullHr)) },
      binary = { p0 <- vcr_scalar(truth[["controlRate"]], NULL)
        p1 <- vcr_binary_treatment_rate(p0, vcr_scalar(truth[["treatmentRate"]], NULL), vcr_scalar(truth$riskDifference, NULL), vcr_scalar(truth$oddsRatio, NULL))
        tiny(p1 - p0 - hypothesis[["null"]]) },
      FALSE)
    if (on_margin) vcr_abort("design_effect_null", "scenario.hypothesis.margin", paste(
      "The effect the design is meant to show equals the non-inferiority margin, so there is no sample size to compute:",
      "the margin is the largest difference the design is meant to rule out. Give the effect the treatment is expected to have;",
      "the type I error of a non-inferiority design is design.simulate's measure with the effect set at the margin."))
    return(if (identical(hypothesis$endpoint, "binary")) invisible(vcr_binary_treatment_rate(vcr_scalar(truth[["controlRate"]], NULL), vcr_scalar(truth[["treatmentRate"]], NULL), vcr_scalar(truth$riskDifference, NULL), vcr_scalar(truth$oddsRatio, NULL))) else invisible(NULL))
  }
  refuse <- function(field, what) {
    vcr_abort("design_effect_null", field, sprintf(
      "The scenario has no effect (%s), so there is no sample size to compute. The type I error of a design is design.simulate's measure on this same scenario; give design.analytic the effect the design is meant to detect.", what))
  }
  if (identical(kind, "single_arm") || identical(kind, "simon_two_stage")) return(invisible(NULL))
  if (identical(endpoint, "time_to_event")) {
    hr <- vcr_scalar(truth$hazardRatio, NULL)
    if (!is.null(hr) && hr > 0 && tiny(log(hr))) refuse("scenario.truth.hazardRatio", "hazardRatio 1")
  } else if (identical(endpoint, "continuous")) {
    eff <- vcr_scalar(truth$effect, NULL)
    if (!is.null(eff) && tiny(eff)) refuse("scenario.truth.effect", "effect 0")
  } else if (identical(endpoint, "binary")) {
    p0 <- vcr_scalar(truth[["controlRate"]], NULL)
    p1 <- vcr_binary_treatment_rate(p0, vcr_scalar(truth[["treatmentRate"]], NULL), vcr_scalar(truth$riskDifference, NULL), vcr_scalar(truth$oddsRatio, NULL))
    if (tiny(p1 - p0)) {
      field <- if (!is.null(truth[["treatmentRate"]])) "scenario.truth.treatmentRate"
               else if (!is.null(truth$riskDifference)) "scenario.truth.riskDifference" else "scenario.truth.oddsRatio"
      refuse(field, switch(field, scenario.truth.treatmentRate = "treatmentRate equal to controlRate",
                           scenario.truth.riskDifference = "riskDifference 0", "oddsRatio 1"))
    }
    return(invisible(p1))
  }
  invisible(NULL)
}

#' No result of a calculation is a number a reader cannot use. The effect guard
#' names the usual cause; this is the net under it, so that a family added later
#' either computes or refuses by name and never hands the validator an infinity.
vcr_analytic_finite_or_refuse <- function(measures) {
  if (!length(measures)) {
    vcr_abort("scenario_value_invalid", "scenario", "The calculation gave no measure for this scenario; check the design kind and the endpoint.")
  }
  for (m in measures) {
    if (!(is.numeric(m$value) && length(m$value) == 1L && is.finite(m$value))) {
      vcr_abort("scenario_value_invalid", "scenario", sprintf(
        "The calculation of %s did not give a finite number for this scenario; check the stated effect, alpha and power.", as.character(m$name)))
    }
  }
  invisible(measures)
}

# --- fixed designs ---------------------------------------------------------

#' Schoenfeld's required number of events.
#' `allocation` is the proportion allocated to the treatment arm.
#' `null_hr` is the hazard ratio of the null hypothesis: 1 for a superiority test, the margin for a non-inferiority test (T1), where
#' the log-rank score is tested against `log(null_hr)` and the requirement is (z_a + z_b)^2 / (p (1 - p) log(hr / null_hr)^2).
vcr_events_schoenfeld <- function(hazard_ratio, alpha = 0.025, power = 0.9,
                                  allocation = 0.5, sided = 1, null_hr = 1) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  zb <- qnorm(power)
  (za + zb)^2 / (allocation * (1 - allocation) * log(hazard_ratio / null_hr)^2)
}

#' Power of the event-driven log-rank test at a number of events: the same formula as `vcr_events_schoenfeld`, solved for power.
#' A two-sided test spends `alpha / 2` per tail and both tails count.
vcr_power_schoenfeld <- function(events, hazard_ratio, alpha = 0.025, allocation = 0.5, sided = 1, null_hr = 1) {
  # a non-inferiority test is one-sided and signed: the same distance on the wrong side of the margin has a power below alpha
  if (null_hr != 1) {
    ncp <- sqrt(events * allocation * (1 - allocation)) * (log(null_hr) - log(hazard_ratio))
    return(pnorm(ncp - qnorm(1 - if (sided == 1) alpha else alpha / 2)))
  }
  ncp <- sqrt(events * allocation * (1 - allocation)) * abs(log(hazard_ratio))
  z <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  pnorm(ncp - z) + if (sided == 2) pnorm(-ncp - z) else 0
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

#' The same probability for any control distribution the engine simulates
#' (exponential, Weibull, piecewise exponential), by quadrature.
#'
#' The Lachin-Foulkes expression above is the exponential special case. A subject
#' contributes an event if the event comes before the exponential dropout and before
#' the end of that subject's follow-up (uniform entry over [0, A], analysis at
#' A + F), so with S the arm's survival function (the control's raised to the
#' hazard ratio) and G(t) = a(t) exp(-eta t), a(t) = 1 up to F and (A + F - t) / A
#' from F to A + F, the probability is the integral of f(t) G(t) with f = -S'.
#' Integrating by parts (G(0) = 1, G(A + F) = 0) leaves only the survival function,
#'
#'   P = 1 - eta * int_0^F S e^{-eta t} dt
#'         - (1 / A) * int_F^{A+F} S e^{-eta t} (1 + eta (A + F - t)) dt,
#'
#' and, for a single entry time (A = 0), P = 1 - S(F) e^{-eta F} - eta * int_0^F S e^{-eta t} dt.
#' S is bounded, so a Weibull shape below 1, whose density is unbounded at 0, needs
#' no special care. The integrals are adaptive quadrature at a relative tolerance of
#' 1e-12, split where the integrand has a kink (F, A + F and the breaks of a
#' piecewise distribution); there is nothing random in it. `hazard_ratio` 1 is the
#' control arm. An infinite follow-up is the expression's limit.
vcr_event_probability_dist <- function(dist, hazard_ratio, accrual_duration, followup_duration, dropout_rate = 0) {
  A <- accrual_duration; Fu <- followup_duration; eta <- dropout_rate
  S <- function(t) vcr_dist_survival(dist, t)^hazard_ratio
  Tt <- A + Fu
  kinks <- function(lo, hi) {
    breaks <- if (identical(dist$kind, "piecewise")) dist$breaks else numeric()
    sort(unique(c(lo, hi, breaks[breaks > lo & breaks < hi])))
  }
  quad <- function(g, lo, hi) {
    if (!(hi > lo)) return(0)
    pts <- kinks(lo, hi)
    sum(vapply(seq_len(length(pts) - 1L), function(i) {
      if (is.infinite(pts[i + 1L])) stats::integrate(g, pts[i], Inf, rel.tol = 1e-12, subdivisions = 500L)$value
      else stats::integrate(g, pts[i], pts[i + 1L], rel.tol = 1e-12, subdivisions = 500L)$value
    }, numeric(1)))
  }
  during <- if (eta > 0) eta * quad(function(t) S(t) * exp(-eta * t), 0, Fu) else 0
  if (!is.finite(Fu)) return(1 - during)
  if (!(A > 0)) return(1 - S(Fu) * exp(-eta * Fu) - during)
  1 - during - quad(function(t) S(t) * exp(-eta * t) * (1 + eta * (Tt - t)), Fu, Tt) / A
}

#' Sample size for a two-sample comparison of means: pooled variance, normal
#' approximation. The t-test the simulator applies needs a few more subjects
#' (the exact t power at this N is slightly below the target), and that gap is
#' shown by the `analyticCheck` against `vcr_power_means`, not hidden here.
vcr_n_means <- function(delta, sd = 1, alpha = 0.025, power = 0.9,
                        allocation = 0.5, sided = 1, null = 0) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  zb <- qnorm(power)
  # `null` is the difference the null hypothesis states: 0, or minus the margin of a non-inferiority test (T1)
  n_total <- (za + zb)^2 * sd^2 / (allocation * (1 - allocation) * (delta - null)^2)
  list(total = n_total, treat = n_total * allocation, control = n_total * (1 - allocation))
}

#' Allocate the normal-approximation requirement by independently rounding each arm up.
#' The realized fraction can differ from the requested one; no exact block ratio is promised.
vcr_integer_allocation <- function(n) {
  treatment <- ceiling(n$treat); control <- ceiling(n$control)
  list(treatment = treatment, control = control, total = treatment + control)
}

vcr_power_means <- function(delta, sd, n_treat, n_control, alpha = 0.025, sided = 1, null = 0) {
  se <- sd * sqrt(1 / n_treat + 1 / n_control)
  df <- n_treat + n_control - 2
  crit <- qt(1 - if (sided == 1) alpha else alpha / 2, df)
  ncp <- (delta - null) / se
  pt(crit, df, ncp = ncp, lower.tail = FALSE) +
    (if (sided == 2 && null == 0) pt(-crit, df, ncp = ncp) else 0)
}

#' The maximum-likelihood rates of two proportions under the restriction p_treat - p_control = delta (Miettinen & Nurminen 1985, the cubic
#' of Farrington & Manning 1990). The non-inferiority test of a risk difference takes its variance from these rates, not from the observed
#' ones: that is what keeps the test's size at alpha on the margin. At delta = 0 they are the pooled rate. `p_treat` and `p_control` are the
#' observed (or, at design time, the expected) rates and `n_treat`, `n_control` their sizes. A cubic that gives a rate outside the
#' admissible interval (a boundary count) is replaced by the maximum of the likelihood on that interval.
vcr_fm_restricted <- function(p_treat, p_control, n_treat, n_control, delta) {
  lo <- max(0, -delta); hi <- min(1, 1 - delta)
  theta <- n_control / n_treat
  a <- 1 + theta
  b <- -(1 + theta + p_treat + theta * p_control + delta * (theta + 2))
  c <- delta^2 + delta * (2 * p_treat + theta + 1) + p_treat + theta * p_control
  d <- -p_treat * delta * (1 + delta)
  v <- b^3 / (27 * a^3) - b * c / (6 * a^2) + d / (2 * a)
  u <- (if (v > 0) 1 else -1) * sqrt(max(b^2 / (9 * a^2) - c / (3 * a), 0))
  pt_ <- if (u > 0 || u < 0) {
    w <- (pi + acos(max(-1, min(1, v / u^3)))) / 3
    2 * u * cos(w) - b / (3 * a)
  } else NA_real_
  if (!is.finite(pt_) || pt_ < lo - 1e-9 || pt_ > hi + 1e-9 || abs((pt_ - delta) - min(max(pt_ - delta, 0), 1)) > 1e-9) {
    # the likelihood in the control rate q, with the treatment rate q + delta, on the admissible interval
    ll <- function(q) {
      x1 <- n_treat * p_treat; x2 <- n_control * p_control
      term <- function(x, n, p) if (x == 0) n * log1p(-p) else if (x == n) n * log(p) else x * log(p) + (n - x) * log1p(-p)
      term(x1, n_treat, q + delta) + term(x2, n_control, q)
    }
    q <- stats::optimize(ll, c(lo + 1e-12, hi - 1e-12), maximum = TRUE, tol = 1e-13)$maximum
    return(c(treat = q + delta, control = q))
  }
  c(treat = min(max(pt_, 0), 1), control = min(max(pt_ - delta, 0), 1))
}

#' Two-proportion sample size, normal approximation with the pooled variance
#' under the null (the test `vcr_analyse_risk_difference` actually performs).
#' With a non-inferiority `null` (minus the margin, T1) the variance under the null is Farrington & Manning's, from the rates restricted to
#' that difference, and the distance the design has to resolve is `p_treat - p_control - null`.
vcr_n_proportions <- function(p_control, p_treat, alpha = 0.025, power = 0.9,
                              allocation = 0.5, sided = 1, null = 0) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  zb <- qnorm(power)
  r <- allocation / (1 - allocation)
  if (null != 0) {
    tilde <- vcr_fm_restricted(p_treat, p_control, r, 1, null)
    v0 <- tilde[["treat"]] * (1 - tilde[["treat"]]) / r + tilde[["control"]] * (1 - tilde[["control"]])
    v1 <- p_treat * (1 - p_treat) / r + p_control * (1 - p_control)
    n_control <- ((za * sqrt(v0) + zb * sqrt(v1)) / (p_treat - p_control - null))^2
    return(list(control = n_control, treat = n_control * r, total = n_control * (1 + r)))
  }
  pbar <- (r * p_treat + p_control) / (r + 1)
  num <- za * sqrt((1 + 1 / r) * pbar * (1 - pbar)) +
         zb * sqrt(p_treat * (1 - p_treat) / r + p_control * (1 - p_control))
  n_control <- (num / (p_treat - p_control))^2
  list(control = n_control, treat = n_control * r, total = n_control * (1 + r))
}

vcr_power_proportions <- function(p_control, p_treat, n_treat, n_control,
                                  alpha = 0.025, sided = 1, null = 0) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  d <- p_treat - p_control
  se1 <- sqrt(p_treat * (1 - p_treat) / n_treat + p_control * (1 - p_control) / n_control)
  if (null != 0) {
    tilde <- vcr_fm_restricted(p_treat, p_control, n_treat, n_control, null)
    se0 <- sqrt(tilde[["treat"]] * (1 - tilde[["treat"]]) / n_treat + tilde[["control"]] * (1 - tilde[["control"]]) / n_control)
    return(pnorm((d - null - za * se0) / se1))
  }
  pbar <- (n_treat * p_treat + n_control * p_control) / (n_treat + n_control)
  se0 <- sqrt(pbar * (1 - pbar) * (1 / n_treat + 1 / n_control))
  # Signed: a one-sided test rejects only when the treated arm is better, so a
  # treatment that is worse has power near zero, not the power of the same
  # benefit (the absolute value belongs to the two-sided test, whose second
  # tail is added here). An assurance over a design prior that reaches negative
  # risk differences depends on this.
  up <- pnorm((d - za * se0) / se1)
  if (sided == 2) up + pnorm((-d - za * se0) / se1) else up
}

#' Simon's two-stage designs (optimal and minimax), exact binomial.
#'
#' Both are searched over the *same* grid: every total n from 2 to `n_max`,
#' every first-stage size, every stopping value. The first version broke out of
#' the loop at the first n that had any feasible design, so "optimal" was only
#' searched among designs of minimax size and came out equal to the minimax
#' design (CE-11; Simon 1989 gives 1/10, 5/29, EN0 15.0 for p0 = 0.1, p1 = 0.3
#' where the old code returned the minimax design 1/15, 5/25).
#'
#' Hidden knowledge: the double sum P(reject) = sum_{x1 > r1} P(X1 = x1) *
#' P(X2 > r - x1) is evaluated as a suffix sum over x1 for every r at once, so
#' the whole grid to n = 100 costs a few seconds rather than minutes.
vcr_simon_two_stage <- function(p0, p1, alpha = 0.05, beta = 0.2, n_max = 100) {
  best_opt <- NULL; best_min <- NULL
  for (n in 2:n_max) {
    for (n1 in 1:(n - 1)) {
      n2 <- n - n1
      x1 <- 0:n1
      d0 <- dbinom(x1, n1, p0); d1 <- dbinom(x1, n1, p1)
      r_all <- 0:(n - 1)
      # upper-tail P(X2 > k) at k = r - x1, for every (x1, r)
      tail_at <- function(p) {
        k <- outer(x1, r_all, function(a, b) b - a)
        out <- matrix(1, nrow = length(x1), ncol = length(r_all))
        inside <- k >= 0 & k < n2
        out[inside] <- stats::pbinom(k[inside], n2, p, lower.tail = FALSE)
        out[k >= n2] <- 0
        out
      }
      suffix <- function(A) apply(A[nrow(A):1, , drop = FALSE], 2, cumsum)[nrow(A):1, , drop = FALSE]
      S0 <- suffix(d0 * tail_at(p0))            # rows x1 = 0..n1, columns r = 0..n-1
      S1 <- suffix(d1 * tail_at(p1))
      for (r1 in 0:(n1 - 1)) {
        # P(reject) for stopping value r1 is the suffix sum from x1 = r1 + 1
        typ1 <- S0[r1 + 2L, ]; pow <- S1[r1 + 2L, ]
        ok <- which(r_all >= r1 & typ1 <= alpha + 1e-12 & pow >= 1 - beta - 1e-12)
        if (!length(ok)) next
        pet0 <- pbinom(r1, n1, p0)
        en0 <- n1 + (1 - pet0) * (n - n1)
        for (j in ok) {
          cand <- list(n1 = n1, r1 = r1, n = n, r = r_all[j], EN0 = en0, PET0 = pet0,
                       alpha = typ1[j], power = pow[j])
          if (is.null(best_opt) || en0 < best_opt$EN0 - 1e-12) best_opt <- cand
          if (is.null(best_min) || n < best_min$n || (n == best_min$n && en0 < best_min$EN0 - 1e-12)) best_min <- cand
        }
      }
    }
  }
  list(optimal = best_opt, minimax = best_min)
}

#' The fixed-sample design that answers the question Simon's two-stage design answers (C5): the smallest single-stage exact binomial
#' design that rejects when the number of responses exceeds `r`, with a type I error at or below `alpha` at `p0` and a power of at least
#' `1 - beta` at `p1`. For each size the critical value is the smallest one that holds the type I error (the largest rejection region
#' that does), and power is not monotone in the size (the binomial's saw-tooth), so the answer is the first size that reaches it, not
#' a size from which every larger one does. NULL when no size up to `n_max` reaches it.
vcr_single_stage_exact <- function(p0, p1, alpha = 0.05, beta = 0.2, n_max = 500L) {
  for (n in seq_len(n_max)) {
    r <- stats::qbinom(1 - alpha, n, p0)
    typ1 <- stats::pbinom(r, n, p0, lower.tail = FALSE)
    if (typ1 > alpha + 1e-12) next
    pow <- stats::pbinom(r, n, p1, lower.tail = FALSE)
    if (pow >= 1 - beta - 1e-12) return(list(n = n, r = r, typeOneError = typ1, power = pow))
  }
  NULL
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

#' Frozen exact-binomial rule. Two-sided means probability ordering, matching
#' stats::binom.test (not doubling the smaller one-sided tail). Every possible
#' count is computed once; replicates only index the frozen rejection/CI table.
vcr_exact_binomial <- function(n, p0, response_rate, alpha = .025, alternative = "greater") {
  if (length(n)!=1L || !is.finite(n) || n<1 || n!=floor(n) || n>10000 ||
      any(!is.finite(c(p0,response_rate,alpha))) || p0<0 || p0>1 || response_rate<0 || response_rate>1 ||
      alpha<=0 || alpha>=1 || !(alternative %in% c("greater","less","two.sided")) || (alternative!="two.sided" && alpha>=.5)) {
    vcr_abort("scenario_value_invalid", "scenario.design", "Exact binary design requires a finite size/rates/alpha and a declared binomial alternative.")
  }
  x <- 0:n; mass <- stats::dbinom(x,n,p0)
  pvals <- if (alternative=="greater") stats::pbinom(x-1,n,p0,lower.tail=FALSE)
           else if (alternative=="less") stats::pbinom(x,n,p0)
           else {
             # binom.test's probability-ordering tie tolerance is 1+1e-7.
             ordered <- sort(mass); cumulative <- c(0,cumsum(ordered))
             pmin(1,cumulative[findInterval(mass*(1+1e-7),ordered)+1L])
           }
  sided <- if (alternative=="two.sided") 2 else 1
  tail <- alpha/sided
  lower <- rep(0,length(x)); upper <- rep(1,length(x))
  lower[x>0] <- stats::qbeta(tail,x[x>0],n-x[x>0]+1)
  upper[x<n] <- stats::qbeta(1-tail,x[x<n]+1,n-x[x<n])
  reject <- pvals<=alpha
  list(n=n,nullRate=p0,responseRate=response_rate,alternative=alternative,alpha=alpha,
    pValues=pvals,reject=reject,rejectCounts=x[reject],ciLow=lower,ciHigh=upper,
    typeOneError=sum(mass[reject]),power=sum(stats::dbinom(x,n,response_rate)[reject]),
    intervalLevel=1-2*tail,rule="p_value_less_than_or_equal_alpha",
    twoSidedConvention=if(sided==2)"probability_ordered_binomial" else NULL)
}

# --- asymptotic log-rank power (a design's patients, not its events) --------

#' Expected proportion still under observation `t` after entry, for uniform
#' accrual over [0, A] analysed at A + F, with an exponential dropout hazard.
vcr_at_risk_fraction <- function(t, accrual_duration, followup_duration, dropout_rate = 0) {
  A <- accrual_duration; F <- followup_duration; Tt <- A + F
  admin <- ifelse(t <= F, 1, ifelse(t < Tt, (Tt - t) / A, 0))
  if (A <= 0) admin <- as.numeric(t <= F)
  admin * exp(-dropout_rate * t)
}

#' Power of the log-rank test from the mean of its score, integrated over
#' follow-up.
#'
#' The reference the simulation is checked against (AC-29). Schoenfeld's
#' `(z_a + z_b)^2 / (p(1-p) log(HR)^2)` needs a number of EVENTS and assumes the
#' at-risk split stays at the randomization ratio; this integral takes the
#' at-risk process from the design itself (accrual, follow-up, dropout, the two
#' survival curves), so it gives power for a stated number of patients:
#'   pi_k(t) = n_k S_k(t) G(t)          expected at risk in arm k
#'   phi(t)  = pi_1 / (pi_1 + pi_0)
#'   E[U]    = integral phi (1-phi) (pi_0 + pi_1) lambda_0 (theta - 1) dt
#'   V       = integral phi (1-phi) (pi_0 + pi_1) lambda_0 (phi theta + 1 - phi) dt
#' and power = Phi(|E[U]| / sqrt(V) - z_{1-alpha}), which reduces to Schoenfeld's
#' formula as theta -> 1.
#'
#' How accurate it is, measured (independent simulation with `survival::survdiff`,
#' 12,000 replicates, one-sided 0.025; the simulator is written separately from
#' the engine's): HR 0.7 300/300 -> reference 0.9497, simulation 0.9531; HR 0.534
#' 120/60 -> 0.9625 vs 0.9631; HR 0.5 60/60 -> 0.9069 vs 0.9033; HR 0.6 100/100
#' -> 0.7599 vs 0.7588; HR 0.6 140/70 -> 0.7544 vs 0.7412; HR 0.4 40/40 -> 0.9296
#' vs 0.9302. It is a first-order approximation: it treats the score's variance
#' as the null variance V, which is exact only for local alternatives, and it is
#' good to about a percentage point at the effect sizes a trial is designed for.
#' Two alternatives were tried and rejected on the same simulations. Taking the
#' martingale variance of the score under the alternative, Var(U), for the
#' spread of Z (the second version of this function) is biased LOW by one to
#' 2.6 points at strong effects (HR 0.534, 120/60: 0.9370 vs 0.9631), because it
#' leaves out the negative covariance between the score and its own at-risk
#' compensator; and Schoenfeld with the event share of each arm is close but is
#' 0.5 to 0.8 points off in both directions. `schoenfeldPower` keeps the second
#' beside the result, so the size of the approximation is visible rather than
#' argued about.
#'
#' `alpha` is the total: a two-sided test spends `alpha / 2` per tail and both
#' tails count towards power.
vcr_logrank_power <- function(hazard_ratio, control_dist, n_treat, n_control,
                              accrual_duration = 0, followup_duration = Inf,
                              dropout_rate = 0, alpha = 0.025, max_followup = Inf,
                              nodes = 4001L, sided = 1, null_hr = 1) {
  sided <- vcr_check_sided(sided)
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
  if (null_hr != 1) {
    # A non-inferiority test (T1) is the score test of a hazard ratio at the margin: the expected treated share of the events at the
    # margin is phi0 = margin p1 / (margin p1 + p0), the score's mean is what the true ratio leaves over that share, and the variance
    # is taken at the margin's share with the events the true ratio produces (the reduction to the lines above at a margin of 1).
    phi0 <- ifelse(tot > 0, null_hr * p1 / (null_hr * p1 + p0), 0)
    drift <- sum(w * h0 * (p1 * theta - (p1 * theta + p0) * phi0))
    variance <- sum(w * h0 * (p1 * theta + p0) * phi0 * (1 - phi0))
  }
  d1 <- sum(w * p1 * theta * h0)
  d0 <- sum(w * p0 * h0)
  events <- d1 + d0
  crit <- stats::qnorm(1 - alpha / sided)
  # U is negative under benefit (theta < 1): the test rejects on Z < -crit.
  mean_z <- if (variance > 0) drift / sqrt(variance) else 0
  power <- stats::pnorm(-crit - mean_z)
  if (sided == 2 && null_hr == 1) power <- power + stats::pnorm(-crit + mean_z)
  schoenfeld <- if (events > 0 && null_hr != 1) {
    stats::pnorm((log(null_hr) - log(theta)) * sqrt(d1 * d0 / events) - crit)
  } else if (events > 0) {
    ncp <- abs(log(theta)) * sqrt(d1 * d0 / events)
    stats::pnorm(ncp - crit) + if (sided == 2) stats::pnorm(-ncp - crit) else 0
  } else 0
  list(power = power, expectedEvents = events, expectedEventsTreat = d1, expectedEventsControl = d0,
       drift = -mean_z, variance = variance, schoenfeldPower = schoenfeld)
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

# --- what the sample size rests on (C5, C6) --------------------------------

#' The same distribution with its time axis stretched by `k`: its median becomes `k` times as long. A longer control median is a lower
#' hazard everywhere, so the control rate of an event-time endpoint is swept by this and not by a rate that has no meaning for a Weibull
#' or a piecewise distribution.
vcr_scale_dist <- function(dist, k) {
  kind <- dist$kind %||% "exponential"
  if (identical(kind, "exponential")) return(list(kind = "exponential", rate = dist$rate / k))
  if (identical(kind, "weibull")) return(list(kind = "weibull", shape = dist$shape, scale = dist$scale * k))
  if (identical(kind, "piecewise")) return(list(kind = "piecewise", breaks = dist$breaks * k, rates = dist$rates / k))
  stop("vcr_scale_dist: unknown distribution kind ", kind)
}

#' Patients an event-time design needs when the events are fixed by the effect (Schoenfeld) and the patients by how many of them have
#' an event before the analysis: the quantity the analytic stage reports as `required_patients` (and, inflated by the group-sequential
#' factor, `max_patients`), computed in one place so that a sweep of one input at a time moves the same number.
vcr_tte_patients <- function(hr, dist, accrual_duration, followup, dropout_hazard, alpha, power, alloc, sided, inflation = 1, integer_allocation = TRUE, null_hr = 1) {
  ev <- vcr_events_schoenfeld(hr, alpha, power, alloc, sided, null_hr) * inflation
  if (identical(dist$kind %||% "exponential", "exponential")) {
    p0 <- vcr_event_probability(dist$rate, accrual_duration, followup, dropout_hazard)
    p1 <- vcr_event_probability(dist$rate * hr, accrual_duration, followup, dropout_hazard)
  } else {
    p0 <- vcr_event_probability_dist(dist, 1, accrual_duration, followup, dropout_hazard)
    p1 <- vcr_event_probability_dist(dist, hr, accrual_duration, followup, dropout_hazard)
  }
  p_ev <- (1 - alloc) * p0 + alloc * p1
  if (integer_allocation) vcr_integer_allocation(list(treat = ev / p_ev * alloc, control = ev / p_ev * (1 - alloc), total = ev / p_ev))$total
  else ceiling(ev / p_ev)
}

#' One input at a time (C6): how far the required sample size moves when each input the formula reads is off by a fifth (the effect,
#' the control level, the standard deviation) or, for the two inputs that are a rate or a length of time, by what a trial can plausibly
#' miss them by (the annual dropout by five points, the accrual by a fifth). Every row is the closed form at a changed input and
#' nothing else changes; no simulation is run. Rows are sorted by how much the size moves, the largest first.
#'
#' Returns NULL for a design with nothing to sweep. `discount` is the published gap between the effect a trial is planned for and the
#' one it measures (`limits$effectDiscount`, an event-time endpoint only): the power the design still has when its effect is
#' reduced by that gap, from the same formula that sized it. There is no such figure for a binary or a continuous endpoint, and the
#' row is then absent, not zero.
vcr_analytic_sweep <- function(sc, e, alpha, power, alloc, sided, inflation = 1, integer_allocation = TRUE, gs = NULL) {
  tr <- sc$truth
  hyp <- vcr_hypothesis(sc)
  nl <- if (is.null(hyp)) 0 else hyp[["null"]]      # the null difference of a non-inferiority test (T1); 0 for superiority
  nh <- if (is.null(hyp)) 1 else hyp$nullHr    # and its null hazard ratio
  wiggle <- c(0.8, 1.2)
  rows <- list()
  push <- function(parameter, label, range, values) {
    values <- as.numeric(values)
    rows[[length(rows) + 1L]] <<- list(parameter = parameter, label = label, range = range, low = min(values), high = max(values), moved = max(values) - min(values))
  }
  total_of <- function(n) if (integer_allocation) vcr_integer_allocation(n)$total else n$total
  clip <- function(p) pmin(pmax(p, 0.001), 0.999)
  discount <- NULL
  if (identical(e, "time_to_event")) {
    hr <- vcr_scalar(tr$hazardRatio, NULL); if (is.null(hr)) return(NULL)
    dist <- vcr_control_distribution(tr)
    has_accrual <- !is.null(sc$accrual) && !is.na(vcr_scalar(sc$accrual$followup, NA_real_))
    base_events <- ceiling(vcr_events_schoenfeld(hr, alpha, power, alloc, sided, nh) * inflation)
    if (has_accrual) {
      perYear <- vcr_time_unit(sc)$perYear
      annual <- vcr_scalar(sc$accrual$dropoutAnnual, 0)
      A <- vcr_scalar(sc$accrual$duration, 0); Fu <- vcr_scalar(sc$accrual$followup)
      eta <- vcr_dropout_hazard(annual, perYear)
      patients <- function(hr_ = hr, dist_ = dist, A_ = A, eta_ = eta) vcr_tte_patients(hr_, dist_, A_, Fu, eta_, alpha, power, alloc, sided, inflation, integer_allocation, null_hr = nh)
      base <- patients()
      push("effect", "效应（log 风险比）", sprintf("HR %.3g–%.3g", min(exp(log(nh) + c(0.8, 1.2) * (log(hr) - log(nh)))), max(exp(log(nh) + c(0.8, 1.2) * (log(hr) - log(nh))))), vapply(wiggle, function(k) patients(hr_ = exp(log(nh) + k * (log(hr) - log(nh)))), numeric(1)))
      push("control", "对照组中位时间", sprintf("%.3g–%.3g", vcr_dist_median(dist) * 0.8, vcr_dist_median(dist) * 1.2), vapply(wiggle, function(k) patients(dist_ = vcr_scale_dist(dist, k)), numeric(1)))
      low <- max(0, annual - 0.05); high <- min(0.95, annual + 0.05)
      push("dropout", "每年脱落率", sprintf("%.0f%%–%.0f%%", low * 100, high * 100), vapply(c(low, high), function(d) patients(eta_ = vcr_dropout_hazard(d, perYear)), numeric(1)))
      if (A > 0) push("accrual", "入组时长", sprintf("%.3g–%.3g", A * 0.8, A * 1.2), vapply(wiggle, function(k) patients(A_ = A * k), numeric(1)))
      measure <- "所需总样本量"
    } else {
      base <- base_events
      push("effect", "效应（log 风险比）", sprintf("HR %.3g–%.3g", min(exp(log(nh) + c(0.8, 1.2) * (log(hr) - log(nh)))), max(exp(log(nh) + c(0.8, 1.2) * (log(hr) - log(nh))))),
           vapply(wiggle, function(k) ceiling(vcr_events_schoenfeld(exp(log(nh) + k * (log(hr) - log(nh))), alpha, power, alloc, sided, nh) * inflation), numeric(1)))
      measure <- "所需事件数"
    }
    # The published gap, applied to the effect of the design: the retained share of the log hazard ratio is what the trials measured
    # divided by what they planned for. It applies to an effect in favour of the treatment only.
    gap <- vcr_limit("effectDiscount", NULL)
    gap <- if (is.null(gap)) NULL else gap[["time_to_event"]]
    if (!is.null(gap) && hr > 0 && hr < 1 && nh == 1) {
      retained <- log(gap$observed) / log(gap$planned)
      hr_discounted <- exp(retained * log(hr))
      # The events the design was sized to (a group-sequential design: its maximum), and the power they give at the reduced effect by the
      # same formula that sized them; a sequential design takes it through its own boundaries.
      n_events <- base_events
      power_discounted <- if (!is.null(gs)) {
        vcr_group_sequential_power(gs, sqrt(n_events * alloc * (1 - alloc)) * abs(log(hr_discounted)))$power
      } else vcr_power_schoenfeld(n_events, hr_discounted, alpha, alloc, sided)
      discount <- list(planned = gap$planned, observed = gap$observed, retained = retained, hazardRatio = hr_discounted,
                       events = n_events, power = power_discounted, targetPower = power)
    }
  } else if (identical(e, "continuous")) {
    eff <- vcr_scalar(tr$effect, NULL); if (is.null(eff)) return(NULL)
    sd <- vcr_scalar(tr$sd, 1)
    base <- total_of(vcr_n_means(eff, sd, alpha, power, alloc, sided, nl))
    push("effect", "效应", sprintf("%.3g–%.3g", nl + (eff - nl) * 0.8, nl + (eff - nl) * 1.2), vapply(wiggle, function(k) total_of(vcr_n_means(nl + (eff - nl) * k, sd, alpha, power, alloc, sided, nl)), numeric(1)))
    push("sd", "标准差", sprintf("%.3g–%.3g", sd * 0.8, sd * 1.2), vapply(wiggle, function(k) total_of(vcr_n_means(eff, sd * k, alpha, power, alloc, sided, nl)), numeric(1)))
    measure <- "所需总样本量"
  } else {
    p0 <- vcr_scalar(tr[["controlRate"]], NULL)
    p1 <- vcr_binary_treatment_rate(p0, vcr_scalar(tr[["treatmentRate"]], NULL), vcr_scalar(tr$riskDifference, NULL), vcr_scalar(tr$oddsRatio, NULL))
    d <- p1 - p0
    base <- total_of(vcr_n_proportions(p0, p1, alpha, power, alloc, sided, nl))
    push("effect", "两组事件率之差", sprintf("%.3g–%.3g", nl + 0.8 * (d - nl), nl + 1.2 * (d - nl)),
         vapply(wiggle, function(k) total_of(vcr_n_proportions(p0, clip(p0 + nl + k * (d - nl)), alpha, power, alloc, sided, nl)), numeric(1)))
    # The control level moves and the difference the treatment makes stays the size it was stated at.
    push("control", "对照组事件率", sprintf("%.3g–%.3g", 0.8 * p0, 1.2 * p0),
         vapply(wiggle, function(k) { p0k <- clip(p0 * k); total_of(vcr_n_proportions(p0k, clip(p0k + d), alpha, power, alloc, sided, nl)) }, numeric(1)))
    measure <- "所需总样本量"
  }
  ordered <- rows[order(-vapply(rows, function(row) row$moved, numeric(1)))]
  list(measure = measure, base = list(value = base),
       rows = lapply(ordered, function(row) list(parameter = row$parameter, label = row$label, range = row$range, low = ceiling(row$low), high = ceiling(row$high))),
       discount = discount)
}
