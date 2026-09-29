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
#   means S(12 months) = 0.9, i.e. hazard = -log(0.9)/12 per month, not
#   0.1/12. Getting this wrong inflates events by a few percent, which is
#   invisible in a single run and shows up as a persistent disagreement with
#   the analytic event count.
# ---------------------------------------------------------------------------

# --- continuous ------------------------------------------------------------

#' Y = b0 + b1 * X + delta * Z + e. `rho` is the target correlation between
#' the baseline covariate X and Y under the control arm, which fixes b1 given
#' the residual sd: b1 = rho * sd_y / sd_x with sd_y^2 = b1^2 sd_x^2 + sigma^2.
#' Solving gives b1 = rho * sigma / (sd_x * sqrt(1 - rho^2)).
vcr_sim_continuous <- function(n_treat, n_control, delta, sd = 1, rho = 0,
                               baseline_sd = 1, baseline_mean = 0, b0 = 0) {
  n <- n_treat + n_control
  z <- c(rep(1L, n_treat), rep(0L, n_control))
  x <- rnorm(n, baseline_mean, baseline_sd)
  b1 <- if (abs(rho) < .Machine$double.eps) 0 else rho * sd / (baseline_sd * sqrt(1 - rho^2))
  y <- b0 + b1 * (x - baseline_mean) + delta * z + rnorm(n, 0, sd)
  data.frame(arm = z, x = x, y = y)
}

#' Two-sample t test on the mean difference (Welch off by design: the
#' reference DGM is homoscedastic and the analytic power formula this is
#' checked against is the pooled one).
vcr_analyse_ttest <- function(data, alpha = 0.025, sided = 1) {
  y1 <- data$y[data$arm == 1L]; y0 <- data$y[data$arm == 0L]
  n1 <- length(y1); n0 <- length(y0)
  est <- mean(y1) - mean(y0)
  sp2 <- ((n1 - 1) * var(y1) + (n0 - 1) * var(y0)) / (n1 + n0 - 2)
  se <- sqrt(sp2 * (1 / n1 + 1 / n0))
  tstat <- est / se
  df <- n1 + n0 - 2
  p <- if (sided == 1) pt(tstat, df, lower.tail = FALSE) else 2 * pt(-abs(tstat), df)
  crit <- qt(1 - alpha, df)
  c(estimate = est, se = se, statistic = tstat, p = p,
    reject = as.numeric(if (sided == 1) tstat > crit else abs(tstat) > qt(1 - alpha / 2, df)),
    ci_low = est - qt(1 - alpha, df) * se, ci_high = est + qt(1 - alpha, df) * se)
}

#' ANCOVA adjusting for the baseline covariate. This is the estimator PROCOVA
#' uses, with the prognostic score in place of `x`.
vcr_analyse_ancova <- function(data, alpha = 0.025, sided = 1, covariates = "x") {
  form <- as.formula(paste("y ~ arm +", paste(covariates, collapse = " + ")))
  fit <- stats::lm(form, data = data)
  co <- summary(fit)$coefficients
  est <- co["arm", "Estimate"]; se <- co["arm", "Std. Error"]
  df <- fit$df.residual
  tstat <- est / se
  p <- if (sided == 1) pt(tstat, df, lower.tail = FALSE) else 2 * pt(-abs(tstat), df)
  c(estimate = est, se = se, statistic = tstat, p = p,
    reject = as.numeric(if (sided == 1) tstat > qt(1 - alpha, df) else abs(tstat) > qt(1 - alpha / 2, df)),
    ci_low = est - qt(1 - alpha, df) * se, ci_high = est + qt(1 - alpha, df) * se)
}

# --- binary ----------------------------------------------------------------

#' Control rate p0; the treatment rate is either given directly, or derived
#' from a risk difference or an odds ratio. A logit covariate effect is
#' available so the DGM can be made non-collapsible on purpose.
vcr_sim_binary <- function(n_treat, n_control, p_control, p_treat = NULL,
                           risk_difference = NULL, odds_ratio = NULL,
                           covariate_logit = 0) {
  p1 <- if (!is.null(p_treat)) p_treat
        else if (!is.null(risk_difference)) p_control + risk_difference
        else if (!is.null(odds_ratio)) {
          o <- odds_ratio * p_control / (1 - p_control); o / (1 + o)
        } else p_control
  if (p1 < 0 || p1 > 1) stop("vcr_sim_binary: implied treatment rate outside [0, 1]")
  n <- n_treat + n_control
  z <- c(rep(1L, n_treat), rep(0L, n_control))
  x <- rnorm(n)
  lp <- stats::qlogis(ifelse(z == 1L, p1, p_control)) + covariate_logit * x
  y <- rbinom(n, 1L, stats::plogis(lp))
  data.frame(arm = z, x = x, y = y)
}

#' Risk difference with a Wald interval on the unpooled variance, and the
#' pooled-variance score test for the hypothesis (the test the two-proportion
#' sample-size formula is derived from).
vcr_analyse_risk_difference <- function(data, alpha = 0.025, sided = 1) {
  y1 <- data$y[data$arm == 1L]; y0 <- data$y[data$arm == 0L]
  n1 <- length(y1); n0 <- length(y0)
  p1 <- mean(y1); p0 <- mean(y0)
  est <- p1 - p0
  se <- sqrt(p1 * (1 - p1) / n1 + p0 * (1 - p0) / n0)
  pbar <- (sum(y1) + sum(y0)) / (n1 + n0)
  se0 <- sqrt(pbar * (1 - pbar) * (1 / n1 + 1 / n0))
  z <- if (se0 > 0) est / se0 else 0
  p <- if (sided == 1) pnorm(z, lower.tail = FALSE) else 2 * pnorm(-abs(z))
  crit <- if (sided == 1) qnorm(1 - alpha) else qnorm(1 - alpha / 2)
  c(estimate = est, se = se, statistic = z, p = p,
    reject = as.numeric(if (sided == 1) z > crit else abs(z) > crit),
    ci_low = est - qnorm(1 - alpha) * se, ci_high = est + qnorm(1 - alpha) * se)
}

vcr_analyse_logistic <- function(data, alpha = 0.025, sided = 1, covariates = character()) {
  form <- as.formula(paste("y ~ arm", if (length(covariates)) paste("+", paste(covariates, collapse = " + ")) else ""))
  fit <- suppressWarnings(stats::glm(form, data = data, family = stats::binomial()))
  co <- summary(fit)$coefficients
  est <- co["arm", "Estimate"]; se <- co["arm", "Std. Error"]
  z <- est / se
  p <- if (sided == 1) pnorm(z, lower.tail = FALSE) else 2 * pnorm(-abs(z))
  crit <- if (sided == 1) qnorm(1 - alpha) else qnorm(1 - alpha / 2)
  c(estimate = est, se = se, statistic = z, p = p,
    reject = as.numeric(if (sided == 1) z > crit else abs(z) > crit),
    ci_low = est - qnorm(1 - alpha) * se, ci_high = est + qnorm(1 - alpha) * se)
}

# --- time to event ---------------------------------------------------------

#' Inverse cumulative hazard for the supported control distributions, scaled
#' by a proportional-hazards multiplier.
#'
#' `dist`: "exponential" (rate), "weibull" (shape, scale), "piecewise"
#' (breaks, rates — rates[i] applies on [breaks[i-1], breaks[i]), the last rate
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
    breaks <- c(0, dist$breaks, Inf)
    rates <- dist$rates
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

#' One two-arm time-to-event trial.
#'
#' `accrual`: list(kind = "uniform", duration = A) or
#'            list(kind = "piecewise", breaks = , rates = ) — rates are
#'            subjects per time unit, and the number accrued is fixed at n so
#'            the piecewise rates only shape the entry times.
#' `followup`: minimum follow-up F after the last entry; administrative
#'             censoring is at calendar time A + F.
#' `dropoutAnnual`: proportion still in follow-up lost per `dropoutPeriod`
#'             (default 12 time units): hazard = -log(1 - p) / period.
vcr_sim_tte <- function(n_treat, n_control, control_dist, hazard_ratio,
                        accrual = list(kind = "uniform", duration = 0),
                        followup = Inf, dropout_annual = 0, dropout_period = 12,
                        max_followup = Inf) {
  n <- n_treat + n_control
  z <- c(rep(1L, n_treat), rep(0L, n_control))
  u <- runif(n)
  hr <- ifelse(z == 1L, hazard_ratio, 1)
  # inversion: S(t) = exp(-hr * H0(t)) = u  =>  H0(t) = -log(u) / hr
  t_event <- vcr_inverse_cumhaz(-log(u) / hr, control_dist)
  drop_h <- if (dropout_annual > 0) -log(1 - dropout_annual) / dropout_period else 0
  t_drop <- if (drop_h > 0) rexp(n, drop_h) else rep(Inf, n)
  entry <- vcr_accrual_times(n, accrual)
  admin_end <- if (is.finite(followup)) max(entry) + followup else Inf
  t_admin <- pmin(admin_end - entry, max_followup)
  obs <- pmin(t_event, t_drop, t_admin)
  data.frame(arm = z, time = obs, status = as.integer(t_event <= pmin(t_drop, t_admin)), entry = entry)
}

#' Entry times for `n` subjects. Uniform accrual is the reference; piecewise
#' accrual draws from the rate profile, normalized to admit exactly n.
vcr_accrual_times <- function(n, accrual) {
  kind <- accrual$kind %||% "uniform"
  if (identical(kind, "uniform")) {
    dur <- accrual$duration %||% 0
    if (dur <= 0) return(rep(0, n))
    return(sort(runif(n, 0, dur)))
  }
  if (identical(kind, "piecewise")) {
    breaks <- c(0, accrual$breaks)
    rates <- accrual$rates
    widths <- diff(c(breaks, breaks[length(breaks)] + (accrual$tail %||% 1e6)))
    mass <- rates * widths
    p <- mass / sum(mass)
    bin <- sample.int(length(p), n, replace = TRUE, prob = p)
    return(sort(breaks[bin] + runif(n) * widths[bin]))
  }
  stop("vcr_accrual_times: unknown accrual kind ", kind)
}

#' Log-rank test and the Cox score-based hazard ratio. Implemented directly so
#' the engine does not depend on `survival`'s tie handling changing under it;
#' `tests/numeric/N02` cross-checks the operating characteristics against the
#' analytic Schoenfeld number.
vcr_analyse_logrank <- function(data, alpha = 0.025, sided = 1) {
  ord <- order(data$time, -data$status)
  time <- data$time[ord]; status <- data$status[ord]; arm <- data$arm[ord]
  n <- length(time)
  at_risk1 <- sum(arm == 1L); at_risk <- n
  O1 <- 0; E1 <- 0; V <- 0
  i <- 1L
  while (i <= n) {
    j <- i
    while (j < n && time[j + 1L] == time[i]) j <- j + 1L
    d <- sum(status[i:j]); d1 <- sum(status[i:j] & arm[i:j] == 1L)
    if (d > 0 && at_risk > 1 && at_risk1 > 0 && at_risk1 < at_risk) {
      e <- d * at_risk1 / at_risk
      v <- d * (at_risk1 / at_risk) * (1 - at_risk1 / at_risk) * (at_risk - d) / (at_risk - 1)
      O1 <- O1 + d1; E1 <- E1 + e; V <- V + v
    } else if (d > 0) {
      O1 <- O1 + d1; E1 <- E1 + d * at_risk1 / max(at_risk, 1)
    }
    removed <- j - i + 1L
    at_risk1 <- at_risk1 - sum(arm[i:j] == 1L)
    at_risk <- at_risk - removed
    i <- j + 1L
  }
  z <- if (V > 0) (O1 - E1) / sqrt(V) else 0
  # log HR by the one-step (Peto) estimate; the sign convention is treatment
  # relative to control, so a protective effect is negative.
  loghr <- if (V > 0) (O1 - E1) / V else 0
  se <- if (V > 0) 1 / sqrt(V) else Inf
  p <- if (sided == 1) pnorm(z, lower.tail = TRUE) else 2 * pnorm(-abs(z))
  crit <- if (sided == 1) qnorm(alpha) else qnorm(alpha / 2)
  c(estimate = loghr, se = se, statistic = z, p = p,
    reject = as.numeric(if (sided == 1) z < crit else abs(z) > abs(crit)),
    events = O1 + (sum(status) - O1), events_treat = O1,
    ci_low = loghr - qnorm(1 - alpha) * se, ci_high = loghr + qnorm(1 - alpha) * se)
}

`%||%` <- function(a, b) if (is.null(a)) b else a
