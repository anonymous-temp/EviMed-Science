# ---------------------------------------------------------------------------
# simulators.R — the three reference simulators (plan 5.4, 8.2).
#
# Hidden knowledge:
#
# - **Three endpoint families, not one per disease.** A disease-specific
#   generator is a model with a model's evidence burden; these three are
#   mathematics, which is why the plan classifies them as model risk `none`
#   and caps anything built only on them at intended use `exploratory`.
# - **Generation is by inversion (Bender 2005), not by rejection.** Inversion
#   consumes exactly one uniform per subject, which is what lets a replicate's
#   draws be a pure function of its substream: a rejection sampler's draw count
#   depends on the parameters, so changing the hazard would silently reshuffle
#   every later subject and two scenarios could no longer share common random
#   numbers. Common random numbers across scenarios is a product requirement
#   (plan 5.2: "the same virtual patient under two scenarios"), so the sampler
#   has to be draw-count-stable.
# - **The DGM and the analysis are deliberately not the same model.** ADEMP's
#   own failure list starts with "DGM and analysis agree, results look too
#   good" — so the time-to-event generator offers Weibull and piecewise hazards
#   that the Cox/log-rank analysis does not assume, and the continuous
#   generator carries a baseline covariate the unadjusted t-test ignores.
# - **`dropoutAnnual` is a rate, not a proportion.** A "10% annual dropout"
#   means S(1 year) = 0.9, i.e. hazard = -log(0.9)/(periods in a year) per time
#   unit -- 12 for a scenario in months, 1 in years -- not 0.1/12. Getting this
#   wrong inflates events by a few percent, which is invisible in a single run
#   and shows up as a persistent disagreement with the analytic event count.
#   The scenario's unit (`timeUnit`) decides what a year is: it used to be 12
#   whatever the scenario's times were in, so a scenario in years lost 0.9%
#   a year and one in weeks 36.7% (E4).
# - **Entry time is independent of arm, and every uniform is always drawn.**
#   The first version sorted the entry times and assigned them in arm order, so
#   the treated arm was enrolled first and had the longest follow-up: hazard
#   ratio 0.7 looked stronger than it was and power came out 3-4 points high
#   (CE-1). Entry, event and dropout each take one uniform per subject in a
#   fixed order whatever the scenario says, so switching dropout on or moving
#   an accrual profile changes those subjects' times and nobody else's
#   (common random numbers, plan 5.2). The binary outcome is a threshold on a
#   uniform for the same reason: `rbinom` maps the uniform through
#   min(p, 1 - p) and a coupling that flips at 0.5 is no coupling.
# - **`alpha` is the total, and a two-sided analysis spends alpha / 2 per
#   tail everywhere**: the decision, the interval and the analytic reference.
#   The first version used `alpha` per tail in the interval, so a two-sided
#   0.05 analysis reported a 90% interval and called its coverage nominal.
# ---------------------------------------------------------------------------

#' The sidedness every path shares. Anything but 1 or 2 is refused by name
#' rather than read as "not 1, so two".
vcr_check_sided <- function(sided) {
  s <- vcr_scalar(sided, 1)
  if (!(s %in% c(1, 2))) vcr_abort("scenario_value_invalid", "scenario.analysis.sided", "The analysis is one-sided (1) or two-sided (2).")
  as.integer(s)
}

# --- continuous ------------------------------------------------------------

#' Y = b0 + b1 * X + delta * Z + e. `rho` is the target correlation between
#' the baseline covariate X and Y under the control arm, which fixes b1 given
#' the residual sd: b1 = rho * sd_y / sd_x with sd_y^2 = b1^2 sd_x^2 + sigma^2.
#' Solving gives b1 = rho * sigma / (sd_x * sqrt(1 - rho^2)).
#'
#' `z` fixes the arm vector (a stored population has its own members), and
#' `lp` is an extra per-subject additive term (covariate effects read from that
#' population); both are optional and change nothing about the draw count.
vcr_sim_continuous <- function(n_treat, n_control, delta, sd = 1, rho = 0,
                               baseline_sd = 1, baseline_mean = 0, b0 = 0,
                               z = NULL, lp = NULL) {
  if (is.null(z)) z <- c(rep(1L, n_treat), rep(0L, n_control))
  n <- length(z)
  x <- rnorm(n, baseline_mean, baseline_sd)
  e <- rnorm(n, 0, 1)
  b1 <- if (abs(rho) < .Machine$double.eps) 0 else rho * sd / (baseline_sd * sqrt(1 - rho^2))
  y <- b0 + b1 * (x - baseline_mean) + delta * z + sd * e + (lp %||% 0)
  data.frame(arm = z, x = x, y = y)
}

#' Two-sample t test on the mean difference (Welch off by design: the
#' reference DGM is homoscedastic and the analytic power formula this is
#' checked against is the pooled one). `alpha` is the total; the interval and
#' the decision spend `alpha / sided` per tail.
#' `null` (T1) is the difference the null hypothesis states: 0, or minus the margin of a non-inferiority test, which rejects on the upper
#' tail only (a margin has no lower tail), or PLUS the margin when a lower value is better, which rejects on the lower tail only. The
#' statistic is oriented either way: positive favours the treatment against the margin.
vcr_analyse_ttest <- function(data, alpha = 0.025, sided = 1, null = 0) {
  sided <- vcr_check_sided(sided)
  y1 <- data$y[data$arm == 1L]; y0 <- data$y[data$arm == 0L]
  n1 <- length(y1); n0 <- length(y0)
  est <- mean(y1) - mean(y0)
  sp2 <- ((n1 - 1) * var(y1) + (n0 - 1) * var(y0)) / (n1 + n0 - 2)
  se <- sqrt(sp2 * (1 / n1 + 1 / n0))
  tstat <- (if (null > 0) null - est else est - null) / se
  df <- n1 + n0 - 2
  p <- if (sided == 1 || null != 0) pt(tstat, df, lower.tail = FALSE) else 2 * pt(-abs(tstat), df)
  crit <- qt(1 - alpha / sided, df)
  c(estimate = est, se = se, statistic = tstat, p = p,
    reject = as.numeric(if (sided == 1 || null != 0) tstat > crit else abs(tstat) > crit),
    ci_low = est - crit * se, ci_high = est + crit * se)
}

#' ANCOVA adjusting for the baseline covariate. This is the estimator PROCOVA
#' uses, with the prognostic score in place of `x`.
vcr_analyse_ancova <- function(data, alpha = 0.025, sided = 1, covariates = "x") {
  sided <- vcr_check_sided(sided)
  form <- vcr_model_formula("y", covariates, fixed = "arm")
  fit <- stats::lm(form, data = data)
  co <- summary(fit)$coefficients
  est <- co["arm", "Estimate"]; se <- co["arm", "Std. Error"]
  df <- fit$df.residual
  tstat <- est / se
  p <- if (sided == 1) pt(tstat, df, lower.tail = FALSE) else 2 * pt(-abs(tstat), df)
  crit <- qt(1 - alpha / sided, df)
  c(estimate = est, se = se, statistic = tstat, p = p,
    reject = as.numeric(if (sided == 1) tstat > crit else abs(tstat) > crit),
    ci_low = est - crit * se, ci_high = est + crit * se)
}

# --- binary ----------------------------------------------------------------

#' Control rate p0; the treatment rate is either given directly, or derived
#' from a risk difference or an odds ratio. A logit covariate effect is
#' available so the DGM can be made non-collapsible on purpose.
#'
#' The outcome is a threshold on one uniform per subject, so a scenario with a
#' different rate flips exactly the subjects whose uniform lies between the two
#' rates and no one else (common random numbers across scenarios).
vcr_sim_binary <- function(n_treat, n_control, p_control, p_treat = NULL,
                           risk_difference = NULL, odds_ratio = NULL,
                           covariate_logit = 0, z = NULL, lp = NULL) {
  p1 <- vcr_binary_treatment_rate(p_control, p_treat, risk_difference, odds_ratio)
  if (is.null(z)) z <- c(rep(1L, n_treat), rep(0L, n_control))
  n <- length(z)
  x <- rnorm(n)
  u <- runif(n)
  eta <- stats::qlogis(ifelse(z == 1L, p1, p_control)) + covariate_logit * x + (lp %||% 0)
  y <- as.integer(u < stats::plogis(eta))
  data.frame(arm = z, x = x, y = y)
}

#' The treatment-arm rate a binary scenario states. Exactly one of a rate, a
#' risk difference or an odds ratio must be present: a scenario that names none
#' is refused rather than read as "no effect", because a typo in the field name
#' would otherwise turn a power calculation into a type-I error calculation
#' without a word (EA-11).
vcr_binary_treatment_rate <- function(p_control, p_treat = NULL, risk_difference = NULL, odds_ratio = NULL) {
  if (is.null(p_control) || !is.finite(p_control) || p_control <= 0 || p_control >= 1) {
    vcr_abort("scenario_value_invalid", "scenario.truth.controlRate", "A binary scenario states a control rate strictly between 0 and 1.")
  }
  given <- c(!is.null(p_treat), !is.null(risk_difference), !is.null(odds_ratio))
  if (sum(given) != 1L) {
    vcr_abort("scenario_field_missing", "scenario.truth",
              "A binary scenario states exactly one of treatmentRate, riskDifference or oddsRatio.")
  }
  p1 <- if (!is.null(p_treat)) p_treat
        else if (!is.null(risk_difference)) p_control + risk_difference
        else { o <- odds_ratio * p_control / (1 - p_control); o / (1 + o) }
  if (!is.finite(p1) || p1 < 0 || p1 > 1) {
    vcr_abort("scenario_value_invalid", "scenario.truth", "The treatment-arm rate this scenario implies is outside [0, 1].")
  }
  p1
}

#' Risk difference with a Wald interval on the unpooled variance, and the
#' pooled-variance score test for the hypothesis (the test the two-proportion
#' sample-size formula is derived from).
#' `null` (T1): minus the margin of a non-inferiority test (plus the margin when a lower rate is better), whose standard error under the null
#' is Farrington & Manning's, from the rates restricted to that difference (`vcr_fm_restricted`); one-sided, as `vcr_analyse_ttest`.
vcr_analyse_risk_difference <- function(data, alpha = 0.025, sided = 1, null = 0) {
  sided <- vcr_check_sided(sided)
  y1 <- data$y[data$arm == 1L]; y0 <- data$y[data$arm == 0L]
  n1 <- length(y1); n0 <- length(y0)
  p1 <- mean(y1); p0 <- mean(y0)
  est <- p1 - p0
  se <- sqrt(p1 * (1 - p1) / n1 + p0 * (1 - p0) / n0)
  if (null != 0) {
    tilde <- vcr_fm_restricted(p1, p0, n1, n0, null)
    se0 <- sqrt(tilde[["treat"]] * (1 - tilde[["treat"]]) / n1 + tilde[["control"]] * (1 - tilde[["control"]]) / n0)
    away <- if (null > 0) null - est else est - null     # a positive null (a lower rate is better) is tested on the lower tail
    z <- if (se0 > 0) away / se0 else if (away > 0) Inf else 0
  } else {
    pbar <- (sum(y1) + sum(y0)) / (n1 + n0)
    se0 <- sqrt(pbar * (1 - pbar) * (1 / n1 + 1 / n0))
    z <- if (se0 > 0) est / se0 else 0
  }
  p <- if (sided == 1 || null != 0) pnorm(z, lower.tail = FALSE) else 2 * pnorm(-abs(z))
  crit <- qnorm(1 - alpha / sided)
  c(estimate = est, se = se, statistic = z, p = p,
    reject = as.numeric(if (sided == 1 || null != 0) z > crit else abs(z) > crit),
    ci_low = est - crit * se, ci_high = est + crit * se)
}

vcr_analyse_logistic <- function(data, alpha = 0.025, sided = 1, covariates = character()) {
  sided <- vcr_check_sided(sided)
  form <- vcr_model_formula("y", covariates, fixed = "arm")
  fit <- suppressWarnings(stats::glm(form, data = data, family = stats::binomial()))
  co <- summary(fit)$coefficients
  est <- co["arm", "Estimate"]; se <- co["arm", "Std. Error"]
  z <- est / se
  p <- if (sided == 1) pnorm(z, lower.tail = FALSE) else 2 * pnorm(-abs(z))
  crit <- qnorm(1 - alpha / sided)
  c(estimate = est, se = se, statistic = z, p = p,
    reject = as.numeric(if (sided == 1) z > crit else abs(z) > crit),
    ci_low = est - crit * se, ci_high = est + crit * se)
}

# --- time to event ---------------------------------------------------------

#' Inverse cumulative hazard for the supported control distributions, scaled
#' by a proportional-hazards multiplier.
#'
#' `dist`: "exponential" (rate), "weibull" (shape, scale), "piecewise"
#' (breaks, rates -- rates[i] applies on [breaks[i-1], breaks[i]), the last rate
#' runs to infinity).
vcr_inverse_cumhaz <- function(H, dist) {
  kind <- dist$kind %||% "exponential"
  if (identical(kind, "exponential")) {
    return(H / dist$rate)
  }
  if (identical(kind, "weibull")) {
    return(dist$scale * (H)^(1 / dist$shape))
  }
  if (identical(kind, "piecewise")) {
    breaks <- c(0, vcr_num(dist$breaks), Inf)
    rates <- vcr_num(dist$rates)
    widths <- diff(breaks)
    widths[length(widths)] <- Inf
    cum <- c(0, cumsum(rates[-length(rates)] * widths[-length(widths)]))
    out <- numeric(length(H))
    for (j in seq_along(H)) {
      k <- max(which(cum <= H[j]))
      out[j] <- breaks[k] + (H[j] - cum[k]) / rates[k]
    }
    return(out)
  }
  stop("vcr_inverse_cumhaz: unknown distribution kind ", kind)
}

vcr_dist_exponential_from_median <- function(median) list(kind = "exponential", rate = log(2) / median)

#' The cumulative hazard of the control distribution: the inverse of `vcr_inverse_cumhaz`.
vcr_cumhaz <- function(t, dist) {
  kind <- dist$kind %||% "exponential"
  if (identical(kind, "exponential")) return(dist$rate * t)
  if (identical(kind, "weibull")) return((t / dist$scale)^dist$shape)
  if (identical(kind, "piecewise")) {
    breaks <- c(0, vcr_num(dist$breaks), Inf)
    rates <- vcr_num(dist$rates)
    widths <- diff(breaks)
    return(vapply(t, function(x) sum(rates * pmax(pmin(x - breaks[-length(breaks)], widths), 0)), numeric(1)))
  }
  stop("vcr_cumhaz: unknown distribution kind ", kind)
}

# --- non-proportional hazards (remediation plan D1, 2026-11-01) ---------------------------------------------------------------------
#
# Hidden knowledge:
#
# - **A treatment-arm hazard ratio that changes over time is a change of slope in the control's own cumulative-hazard scale.** The
#   treated arm's hazard at time t is `ratios[j] * h0(t)` on the j-th interval of `breaks` (the last runs on), so its cumulative hazard
#   is a piecewise-linear function G of the control's, H1(t) = G(H0(t)), with slope `ratios[j]` between the knots K_j = H0(breaks[j]).
#   An event time is still ONE uniform through the inverse of H1, exactly as the proportional case is, so the generator stays
#   draw-count-stable (the same uniforms give the same patients under any ratios) and common random numbers across scenarios stay
#   honest. A delayed effect is `ratios = c(1, 0.6)`, a crossing of survival curves `c(1.4, 0.6)`.
# - **There is no single true hazard ratio.** The log-rank estimate under such a truth is an average that depends on the follow-up and
#   the censoring, so the simulation reports no bias and no coverage for it (the estimand is not defined), and its power is the
#   simulation's alone: there is no closed form to check it against.

#' The knots and slopes of the treated arm's cumulative hazard on the control's scale.
.vcr_nph_spec <- function(spec, dist) {
  breaks <- vcr_num(spec$breaks); ratios <- vcr_num(spec$ratios)
  list(K = vcr_cumhaz(breaks, dist), ratios = ratios, breaks = breaks)
}

#' G: the treated arm's cumulative hazard at a control-scale level `x`.
.vcr_nph_forward <- function(x, nph) {
  K <- c(0, nph$K); r <- nph$ratios
  Gk <- c(0, cumsum(r[seq_along(nph$K)] * diff(K)))
  j <- findInterval(x, K[-1L]) + 1L
  Gk[j] + r[j] * (x - K[j])
}

#' G^-1: the control-scale level at which the treated arm's cumulative hazard is `y`.
.vcr_nph_inverse <- function(y, nph) {
  K <- c(0, nph$K); r <- nph$ratios
  Gk <- c(0, cumsum(r[seq_along(nph$K)] * diff(K)))
  j <- findInterval(y, Gk[-1L]) + 1L
  K[j] + (y - Gk[j]) / r[j]
}


#' The unit a scenario states its times in -- months unless it says another (`timeUnit`) -- and what the engine needs of it.
#' The days each unit stands for are the domain's one table (`timeUnits` in R/domain-snapshot.json), never a number written
#' here. `perYear` is how many of the unit a "per year" proportion is spread over (the dropout), `months` how many months
#' one of the unit is (the `_months` measures and a cost per month are in months), `zh` the unit's word on a page.
#' Nothing else in a scenario reads a time as a unit: a median, a duration, a follow-up and a horizon are in it.
vcr_time_unit <- function(sc) {
  table <- vcr_domain()$timeUnits
  unit <- as.character(sc[["timeUnit"]] %||% table$default)
  days <- table$daysPerUnit
  if (length(unit) != 1L || !(unit %in% names(days))) {
    vcr_abort("scenario_value_invalid", "scenario.timeUnit", paste0("The time unit is one of ", paste(names(days), collapse = ", "), "."))
  }
  list(unit = unit, perYear = 365.25 / days[[unit]], months = days[[unit]] / days[["months"]],
       zh = c(days = "天", weeks = "周", months = "月", years = "年")[[unit]])
}

#' The dropout hazard a scenario's annual proportion means: a "10% annual
#' dropout" is S(1 year) = 0.9, so hazard = -log(0.9) / (periods in a year) per time unit:
#' 12 for a scenario in months (the default), 1 in years, 365.25 / 7 in weeks.
vcr_dropout_hazard <- function(dropout_annual, period = 12) {
  p <- dropout_annual %||% 0
  if (!is.finite(p) || p < 0 || p >= 1) {
    vcr_abort("scenario_value_invalid", "scenario.accrual.dropoutAnnual", "The annual dropout is a proportion in [0, 1).")
  }
  if (p == 0) 0 else -log(1 - p) / period
}

#' One two-arm time-to-event trial.
#'
#' `accrual`: list(kind = "uniform", duration = A) or
#'            list(kind = "piecewise", breaks = , rates = ) -- rates are
#'            subjects per time unit, and the number accrued is fixed at n so
#'            the piecewise rates only shape the entry times.
#' `followup`: minimum follow-up F after the accrual period; administrative
#'             censoring is at calendar time A + F.
#' `dropoutAnnual`: proportion still in follow-up lost per year; `dropout_period` is how
#'             many of the scenario's time unit make a year (12 for months, the default; see
#'             `vcr_time_unit`): hazard = -log(1 - p) / period per time unit.
#' `lp`: an extra per-subject log-hazard-ratio term (covariate effects).
#' `hazard_ratio`: one number (proportional hazards) or an `.vcr_nph_spec` (a ratio that changes over time).
vcr_sim_tte <- function(n_treat, n_control, control_dist, hazard_ratio,
                        accrual = list(kind = "uniform", duration = 0),
                        followup = Inf, dropout_annual = 0, dropout_period = 12,
                        max_followup = Inf, z = NULL, lp = NULL) {
  if (is.null(z)) z <- c(rep(1L, n_treat), rep(0L, n_control))
  n <- length(z)
  # Three uniforms per subject, always, in this order (common random numbers).
  u_event <- runif(n)
  u_drop <- runif(n)
  u_entry <- runif(n)
  if (is.list(hazard_ratio)) {
    # a hazard ratio that changes over time (`.vcr_nph_spec`): the same one uniform per subject, through the treated arm's own inverse
    y <- -log(u_event) / exp(lp %||% 0)
    t_event <- vcr_inverse_cumhaz(ifelse(z == 1L, .vcr_nph_inverse(y, hazard_ratio), y), control_dist)
  } else {
    hr <- ifelse(z == 1L, hazard_ratio, 1) * exp(lp %||% 0)
    # inversion: S(t) = exp(-hr * H0(t)) = u  =>  H0(t) = -log(u) / hr
    t_event <- vcr_inverse_cumhaz(-log(u_event) / hr, control_dist)
  }
  drop_h <- vcr_dropout_hazard(dropout_annual, dropout_period)
  t_drop <- if (drop_h > 0) -log(u_drop) / drop_h else rep(Inf, n)
  entry <- .vcr_accrual_from_u(u_entry, accrual)
  end <- .vcr_accrual_end(entry, accrual)
  admin_end <- if (is.finite(followup)) end + followup else Inf
  t_admin <- pmin(admin_end - entry, max_followup)
  obs <- pmin(t_event, t_drop, t_admin)
  data.frame(arm = z, time = obs, status = as.integer(t_event <= pmin(t_drop, t_admin)), entry = entry)
}

#' Entry times from n uniforms by inversion. Not sorted: sorting and then
#' assigning in arm order is what made the treated arm enter first (CE-1).
.vcr_accrual_from_u <- function(u, accrual) {
  kind <- accrual$kind %||% "uniform"
  n <- length(u)
  if (identical(kind, "uniform")) {
    dur <- vcr_scalar(accrual$duration, 0)
    if (dur <= 0) return(rep(0, n))
    return(u * dur)
  }
  if (identical(kind, "piecewise")) {
    breaks <- c(0, vcr_num(accrual$breaks))
    rates <- vcr_num(accrual$rates)
    # The last interval is open in the profile, so the length of the enrolment period is `tail`, and it is stated: it used
    # to default to 1,000,000 time units, which put every patient far outside any follow-up and made a trial look complete.
    # One rate per interval: a shorter list used to be recycled with a warning. (The validator refuses both first; these
    # are the second line, for the simulators called on their own.)
    tail <- vcr_scalar(accrual[["tail"]], NULL)
    if (is.null(tail) || !is.finite(tail) || !(tail > 0)) {
      vcr_abort("scenario_field_missing", "scenario.accrual.tail", "A piecewise accrual states the length of its last interval (tail): there is no default.")
    }
    if (length(rates) != length(breaks)) {
      vcr_abort("scenario_value_invalid", "scenario.accrual.rates", "A piecewise accrual has one rate per interval: one more than it has breaks.")
    }
    widths <- diff(c(breaks, breaks[length(breaks)] + tail))
    mass <- rates * widths
    p <- mass / sum(mass)
    cum <- c(0, cumsum(p))
    bin <- pmin(findInterval(u, cum, rightmost.closed = TRUE), length(p))
    bin <- pmax(bin, 1L)
    frac <- (u - cum[bin]) / p[bin]
    return(breaks[bin] + frac * widths[bin])
  }
  stop("accrual: unknown accrual kind ", kind)
}

#' The calendar time accrual ends. Uniform accrual over [0, A] ends at A (the
#' analytic reference is written against A + F, not against the random last
#' entry); a piecewise profile ends at its last entry.
.vcr_accrual_end <- function(entry, accrual) {
  kind <- accrual$kind %||% "uniform"
  if (identical(kind, "uniform")) return(max(vcr_scalar(accrual$duration, 0), 0))
  max(entry)
}

#' Entry times for `n` subjects, in arrival order, independent of anything
#' else (uniform accrual is the reference; piecewise draws from the rate
#' profile, normalized to admit exactly n).
vcr_accrual_times <- function(n, accrual) .vcr_accrual_from_u(runif(n), accrual)

#' Log-rank test and the Cox score-based hazard ratio. Implemented directly so
#' the engine does not depend on `survival`'s tie handling changing under it;
#' `tests/numeric/N02` cross-checks the operating characteristics against the
#' analytic Schoenfeld number.
#' `null_hr` (T1): the margin of a non-inferiority test. The statistic is then the score test of that hazard ratio (the observed events of
#' the treated arm against what the margin predicts from the at-risk counts), one-sided like the margin; `estimate` and `se` are the
#' one-step estimate of the log hazard ratio as ever.
vcr_analyse_logrank <- function(data, alpha = 0.025, sided = 1, null_hr = 1) {
  sided <- vcr_check_sided(sided)
  ord <- order(data$time, -data$status)
  time <- data$time[ord]; status <- data$status[ord]; arm <- data$arm[ord]
  n <- length(time)
  at_risk1 <- sum(arm == 1L); at_risk <- n
  O1 <- 0; E1 <- 0; V <- 0; Ep <- 0; Vp <- 0   # Ep, Vp: the expectation and variance at a hazard ratio of 1, for the estimate beside a margin test
  i <- 1L
  while (i <= n) {
    j <- i
    while (j < n && time[j + 1L] == time[i]) j <- j + 1L
    d <- sum(status[i:j]); d1 <- sum(status[i:j] & arm[i:j] == 1L)
    if (d > 0 && at_risk > 1 && at_risk1 > 0 && at_risk1 < at_risk) {
      share <- if (null_hr == 1) at_risk1 / at_risk else null_hr * at_risk1 / (null_hr * at_risk1 + at_risk - at_risk1)
      e <- if (null_hr == 1) d * at_risk1 / at_risk else d * share   # (the superiority arithmetic is kept to the bit)
      v <- d * share * (1 - share) * (at_risk - d) / (at_risk - 1)
      O1 <- O1 + d1; E1 <- E1 + e; V <- V + v
      if (null_hr != 1) { Ep <- Ep + d * at_risk1 / at_risk; Vp <- Vp + d * (at_risk1 / at_risk) * (1 - at_risk1 / at_risk) * (at_risk - d) / (at_risk - 1) }
    } else if (d > 0) {
      O1 <- O1 + d1; E1 <- E1 + d * at_risk1 / max(at_risk, 1)
      if (null_hr != 1) Ep <- Ep + d * at_risk1 / max(at_risk, 1)
    }
    removed <- j - i + 1L
    at_risk1 <- at_risk1 - sum(arm[i:j] == 1L)
    at_risk <- at_risk - removed
    i <- j + 1L
  }
  z <- if (V > 0) (O1 - E1) / sqrt(V) else 0
  # log HR by the one-step (Peto) estimate; the sign convention is treatment
  # relative to control, so a protective effect is negative.
  if (null_hr == 1) { Ep <- E1; Vp <- V }
  loghr <- if (Vp > 0) (O1 - Ep) / Vp else 0
  se <- if (Vp > 0) 1 / sqrt(Vp) else Inf
  p <- if (sided == 1 || null_hr != 1) pnorm(z, lower.tail = TRUE) else 2 * pnorm(-abs(z))
  crit <- qnorm(1 - alpha / sided)
  c(estimate = loghr, se = se, statistic = z, p = p,
    reject = as.numeric(if (sided == 1 || null_hr != 1) z < -crit else abs(z) > crit),
    events = sum(status), events_treat = O1,
    ci_low = loghr - crit * se, ci_high = loghr + crit * se)
}


# --- MaxCombo (remediation plan D1) -------------------------------------------------------------------------------------------------
#
# Hidden knowledge:
#
# - **The four Fleming-Harrington weights G(rho, gamma) of the pooled Kaplan-Meier S(t-): (0,0) the log-rank, (0,1) late differences,
#   (1,0) early differences, (1,1) differences in the middle.** The statistic is the most favourable of the four standardized weighted
#   log-rank statistics; the four are correlated through the same risk sets, so its null distribution is the maximum of a
#   multivariate normal with the weighted-covariance correlation (Karrison 2016; Lin et al. 2020), and its p-value is read from that
#   distribution (`mvtnorm`), not from a Bonferroni bound. It is never a default: an analysis is MaxCombo only when the scenario says
#   so, because the plain log-rank is often as good (Zhao et al. 2024) and the choice of the four weights is made before the data.
# - **Sign as the log-rank's: negative is protective.** `statistic` is the most negative of the four (one-sided) or the largest in
#   absolute value (two-sided); `estimate` is the log-rank's one-step log hazard ratio and is only descriptive.

VCR_FLEMING_HARRINGTON <- list(c(0, 0), c(0, 1), c(1, 0), c(1, 1))

#' The four weighted log-rank statistics and their correlation, from event times and arms.
#' @return list(z = the four standardized statistics, corr = their correlation, keep = which of the four had a positive variance)
vcr_fh_statistics <- function(time, status, arm, combos = VCR_FLEMING_HARRINGTON) {
  ts <- sort(unique(time[status == 1L]))
  if (!length(ts)) return(list(z = numeric(0), corr = matrix(1, 0, 0), keep = logical(length(combos))))
  tm1 <- sort(time[arm == 1L]); tm <- sort(time)
  n <- length(tm) - findInterval(ts, tm, left.open = TRUE)
  n1 <- length(tm1) - findInterval(ts, tm1, left.open = TRUE)
  at <- match(time[status == 1L], ts)
  d <- tabulate(at, length(ts))
  d1 <- tabulate(at[arm[status == 1L] == 1L], length(ts))
  s_minus <- c(1, cumprod(1 - d / n))[seq_along(ts)]
  e1 <- d * n1 / n
  v <- ifelse(n > 1, d * (n1 / n) * (1 - n1 / n) * (n - d) / pmax(n - 1, 1), 0)
  w <- vapply(combos, function(g) s_minus^g[1] * (1 - s_minus)^g[2], numeric(length(ts)))
  w <- matrix(w, nrow = length(ts))
  u <- colSums(w * (d1 - e1))
  sig2 <- colSums(w^2 * v)
  keep <- sig2 > 0
  if (!any(keep)) return(list(z = numeric(0), corr = matrix(1, 0, 0), keep = keep))
  cov_ <- crossprod(w[, keep, drop = FALSE] * sqrt(v), w[, keep, drop = FALSE] * sqrt(v))
  sd_ <- sqrt(diag(cov_))
  list(z = u[keep] / sd_, corr = cov_ / outer(sd_, sd_), keep = keep)
}

#' The null probability that the most favourable of the four statistics is at least as extreme as `stat`.
#'
#' Hidden knowledge: the four correlation matrices are SINGULAR, always: S + (1 - S) = 1 makes the (0,0) weight the sum of the (1,0) and
#' (0,1) weights, so U00 = U10 + U01 and the log-rank statistic is a linear combination of two of the others. `mvtnorm`'s Miwa algorithm
#' refuses a singular problem, so the quasi-Monte-Carlo algorithm of Genz and Bretz (which takes a semi-definite matrix) is used, with its
#' random shifts drawn from a seed derived from the statistic itself and the caller's random state put back afterwards: the p-value is a
#' pure function of the data, whichever replicate, batch or core evaluates it, and a replicate's own stream is not touched. Its absolute
#' error is 1e-6, so a p-value far below alpha is only as exact as that, which is all a decision at alpha needs.
vcr_maxcombo_p <- function(stat, corr, sided = 1) {
  k <- nrow(corr)
  if (k == 1L) return(if (sided == 1) stats::pnorm(stat) else 2 * stats::pnorm(-abs(stat)))
  if (sided == 1) { lower <- rep(stat, k); upper <- rep(Inf, k) } else { lower <- rep(-abs(stat), k); upper <- rep(abs(stat), k) }
  held <- if (exists(".Random.seed", envir = globalenv(), inherits = FALSE)) get(".Random.seed", envir = globalenv()) else NULL
  on.exit(if (!is.null(held)) assign(".Random.seed", held, envir = globalenv()), add = TRUE)
  set.seed(1L + as.integer(round(abs(stat) * 1e5) %% 1000000007))
  inside <- tryCatch(as.numeric(mvtnorm::pmvnorm(lower = lower, upper = upper, corr = corr,
                                                 algorithm = mvtnorm::GenzBretz(abseps = 1e-6, maxpts = 50000))), error = function(e) NA_real_)
  p <- 1 - inside
  # a matrix the algorithm cannot read: the Bonferroni bound, which only errs conservative
  if (!is.finite(p)) p <- min(1, (if (sided == 1) k * stats::pnorm(stat) else 2 * k * stats::pnorm(-abs(stat))))
  min(max(p, 0), 1)
}

#' The MaxCombo test of a two-arm time-to-event trial, in the log-rank's own return shape.
vcr_analyse_maxcombo <- function(data, alpha = 0.025, sided = 1) {
  sided <- vcr_check_sided(sided)
  base <- vcr_analyse_logrank(data, alpha, sided)
  fh <- vcr_fh_statistics(data$time, data$status, data$arm)
  if (!length(fh$z)) { base[c("statistic", "p", "reject")] <- c(0, 1, 0); return(base) }
  stat <- if (sided == 1) min(fh$z) else fh$z[which.max(abs(fh$z))]
  p <- vcr_maxcombo_p(stat, (fh$corr + t(fh$corr)) / 2, sided)
  base[c("statistic", "p", "reject")] <- c(stat, p, as.numeric(p < alpha))
  base
}

# --- the modestly weighted log-rank test (algorithm round T12) ----------------------------------------------------------------------
#
# Hidden knowledge:
#
# - **The weight is 1 / max(S(t-), s*) of the pooled Kaplan-Meier curve S, and s* is the one parameter (Magirr and Burman 2019).** Early
#   differences count as in the log-rank test (weight 1 while S is above s*) and later ones count more, up to 1 / s* times as much: for the
#   default s* = 0.5 the weight at most doubles. That is what it protects against: a test that weights the late follow-up heavily (a
#   Fleming-Harrington (0,1) weight, MaxCombo) gains power when the effect starts late, and rejects too often when the treatment is WORSE early
#   and equal later, because it reads the early harm as a late difference. The cap on the weight is the guard. Where the effect does not start
#   late it loses little against the log-rank test; it is not a replacement for it and is never a default.
# - **The statistic has the log-rank's sign and shape**: negative is protective, `statistic` is the standardized weighted sum of observed
#   minus expected events of the treated arm, `estimate` is the log-rank test's one-step log hazard ratio and is only descriptive.

#' The standardized modestly weighted statistic from event times and arms: one z, negative in favour of the treatment arm.
vcr_mw_statistic <- function(time, status, arm, s_star = 0.5) {
  ts <- sort(unique(time[status == 1L]))
  if (!length(ts)) return(NA_real_)
  tm1 <- sort(time[arm == 1L]); tm <- sort(time)
  n <- length(tm) - findInterval(ts, tm, left.open = TRUE)
  n1 <- length(tm1) - findInterval(ts, tm1, left.open = TRUE)
  at <- match(time[status == 1L], ts)
  d <- tabulate(at, length(ts))
  d1 <- tabulate(at[arm[status == 1L] == 1L], length(ts))
  s_minus <- c(1, cumprod(1 - d / n))[seq_along(ts)]
  e1 <- d * n1 / n
  v <- ifelse(n > 1, d * (n1 / n) * (1 - n1 / n) * (n - d) / pmax(n - 1, 1), 0)
  w <- 1 / pmax(s_minus, s_star)
  sig2 <- sum(w^2 * v)
  if (!(sig2 > 0)) return(NA_real_)
  sum(w * (d1 - e1)) / sqrt(sig2)
}

#' The modestly weighted test of a two-arm time-to-event trial, in the log-rank's own return shape.
vcr_analyse_modestly_weighted <- function(data, alpha = 0.025, sided = 1, s_star = 0.5) {
  sided <- vcr_check_sided(sided)
  base <- vcr_analyse_logrank(data, alpha, sided)
  z <- vcr_mw_statistic(data$time, data$status, data$arm, s_star)
  if (!is.finite(z)) { base[c("statistic", "p", "reject")] <- c(0, 1, 0); return(base) }
  p <- if (sided == 1) stats::pnorm(z) else 2 * stats::pnorm(-abs(z))
  base[c("statistic", "p", "reject")] <- c(z, p, as.numeric(p < alpha))
  base
}

`%||%` <- function(a, b) if (is.null(a)) b else a
