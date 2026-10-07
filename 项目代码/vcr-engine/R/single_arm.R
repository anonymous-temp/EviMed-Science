# ---------------------------------------------------------------------------
# single_arm.R — a single-arm trial against a fixed historical benchmark, for a
# continuous and a time-to-event endpoint (2026-10-07; the binary designs are in
# design_simulate.R).
#
# Hidden knowledge:
#
# - **The benchmark is a fixed number, not a second arm.** A single-arm trial
#   compares its patients with what history says, and history is not sampled in
#   the simulation: the benchmark mean (continuous) or the benchmark survival
#   distribution (time to event) is a constant of the scenario, and only the
#   trial's own n patients are random. That is what makes the type-I error a
#   property of the test and the benchmark and not of a control group's luck, and
#   it is why "the effect" is stated against the benchmark (`truth.effect`, the
#   true mean minus the benchmark; `truth.hazardRatio`, the true hazard over the
#   benchmark's), and zero (or one) is the null.
# - **`alternative` describes the parameter, whatever the endpoint.** For a mean
#   it is the mean against the benchmark. For a time-to-event endpoint the
#   parameter is the hazard ratio against the benchmark, so `less` is a benefit
#   (a hazard below the benchmark's: fewer events than the benchmark predicts) and
#   `greater` is harm. A two-sided analysis spends alpha / 2 per tail everywhere,
#   as in the two-arm designs.
# - **A mean is tested with t when the SD is estimated and with z when it is
#   known.** `one_sample_t` uses the sample SD and n - 1 degrees of freedom;
#   `one_sample_z` takes the standard deviation the analysis was told
#   (`analysis.sd`), which need not be the generator's: the case where they
#   differ is a misspecification study, and the simulation says what it costs.
# - **The time-to-event test is the one-sample log-rank test** (Breslow 1975):
#   O events observed against E = the sum over patients of the benchmark's
#   cumulative hazard at their observed time, and (E - O) / sqrt(E) is the
#   statistic (positive when there are fewer events than the benchmark
#   predicts). The effect is log(O / E), with the Poisson standard error
#   1 / sqrt(O); a replicate with no event has no finite effect and is a failed
#   replicate for bias and coverage (it still counts as a rejection if the test
#   rejects: failures count against the design, never out of it).
# - **The generator is the two-arm trial's** (`vcr_sim_tte` with no control
#   patients), so entry, dropout and administrative censoring follow the same rules
#   and the same fixed draw order per patient: switching dropout on or changing the
#   hazard ratio moves the patients it should and nobody else.
# - Every key is read with `[["key"]]`.
# ---------------------------------------------------------------------------

#' The analyses a single-arm design may run, by design and endpoint: the table the
#' domain publishes as `VCR_SINGLE_ARM_ANALYSIS_METHODS`.
VCR_SINGLE_ARM_METHODS <- list(
  single_arm = list(binary = "exact_binomial", continuous = c("one_sample_t", "one_sample_z"), time_to_event = "one_sample_logrank"),
  single_arm_external = list(binary = "stratified_risk_difference"),
  simon_two_stage = list(binary = "simon_boundary"))

#' One-sample test of a mean against a benchmark. `known_sd` makes it a z test.
#' `alpha` is the total: a two-sided analysis spends alpha / 2 per tail, in the
#' decision and in the interval.
vcr_analyse_one_sample_mean <- function(y, benchmark, alpha = 0.025, sided = 1, alternative = "greater", known_sd = NULL) {
  sided <- vcr_check_sided(sided)
  n <- length(y)
  est <- mean(y) - benchmark
  sdv <- if (is.null(known_sd)) stats::sd(y) else known_sd
  se <- sdv / sqrt(n)
  stat <- est / se
  df <- if (is.null(known_sd)) n - 1 else Inf
  crit <- if (is.null(known_sd)) stats::qt(1 - alpha / sided, df) else stats::qnorm(1 - alpha / sided)
  tail <- function(q, lower) if (is.null(known_sd)) stats::pt(q, df, lower.tail = lower) else stats::pnorm(q, lower.tail = lower)
  p <- switch(alternative, greater = tail(stat, FALSE), less = tail(stat, TRUE), two.sided = 2 * tail(-abs(stat), TRUE),
              vcr_abort("scenario_value_invalid", "scenario.analysis.alternative", "The alternative is greater, less or two.sided."))
  rej <- switch(alternative, greater = stat > crit, less = stat < -crit, abs(stat) > crit)
  c(estimate = est, se = se, statistic = stat, p = p, reject = as.numeric(rej), ci_low = est - crit * se, ci_high = est + crit * se)
}

#' The one-sample log-rank test of a trial's patients against a benchmark
#' survival distribution. Returns the effect as a log hazard ratio against the
#' benchmark, O / E, and the decision.
vcr_analyse_one_sample_logrank <- function(time, status, benchmark, alpha = 0.025, sided = 1, alternative = "less") {
  sided <- vcr_check_sided(sided)
  O <- sum(status)
  E <- sum(-log(vcr_dist_survival(benchmark, time)))
  stat <- if (E > 0) (E - O) / sqrt(E) else 0     # positive: fewer events than the benchmark predicts
  crit <- stats::qnorm(1 - alpha / sided)
  p <- switch(alternative, less = stats::pnorm(stat, lower.tail = FALSE), greater = stats::pnorm(stat, lower.tail = TRUE), two.sided = 2 * stats::pnorm(-abs(stat)),
              vcr_abort("scenario_value_invalid", "scenario.analysis.alternative", "The alternative is greater, less or two.sided."))
  rej <- switch(alternative, less = stat > crit, greater = stat < -crit, abs(stat) > crit)
  est <- if (O > 0 && E > 0) log(O / E) else NA_real_
  se <- if (O > 0) 1 / sqrt(O) else NA_real_
  c(estimate = est, se = se, statistic = stat, p = p, reject = as.numeric(rej), ci_low = est - crit * se, ci_high = est + crit * se,
    events = O, expectedEvents = E)
}

#' The generate/analyse pair of a single-arm scenario with a continuous or a
#' time-to-event endpoint.
.vcr_single_arm_runner <- function(sc, alpha, sided) {
  d <- sc[["design"]]; tr <- sc[["truth"]]; an <- sc[["analysis"]]
  endpoint <- as.character(sc[["endpoint"]][["type"]])
  n <- as.integer(.vcr_need(d[["n"]], "scenario.design.n", "A single-arm design states its size."))
  alternative <- as.character(an[["alternative"]])
  method <- as.character(an[["method"]])
  if (identical(endpoint, "continuous")) {
    if (n < 2L) vcr_abort("scenario_value_invalid", "scenario.design.n", "A one-sample test of a mean needs at least two patients.")
    effect <- .vcr_need(tr[["effect"]], "scenario.truth.effect", "A continuous single-arm scenario states the effect over the benchmark (0 for the null).")
    sd <- vcr_scalar(tr[["sd"]], 1); benchmark <- vcr_scalar(tr[["benchmark"]], 0)
    known <- if (identical(method, "one_sample_z")) .vcr_need(an[["sd"]], "scenario.analysis.sd", "A z analysis states the standard deviation it takes as known.") else NULL
    return(list(estimand = effect, run = function(i) {
      y <- benchmark + effect + sd * stats::rnorm(n)
      c(vcr_analyse_one_sample_mean(y, benchmark, alpha, sided, alternative, known), sampleSize = n, generatedRecords = n)
    }))
  }
  # time to event: the benchmark is the control distribution of the scenario, the trial's hazard is the hazard ratio times it
  hr <- .vcr_need(tr[["hazardRatio"]], "scenario.truth.hazardRatio", "A time-to-event single-arm scenario states the hazard ratio over the benchmark (1 for the null).")
  dist <- vcr_control_distribution(tr)
  acc <- sc[["accrual"]]
  accrual <- acc %||% list(kind = "uniform", duration = 0)
  followup <- vcr_scalar(acc[["followup"]], Inf); dropout <- vcr_scalar(acc[["dropoutAnnual"]], 0); max_fu <- vcr_scalar(acc[["maxFollowup"]], Inf)
  list(estimand = log(hr), run = function(i) {
    x <- vcr_sim_tte(n, 0L, dist, hr, accrual, followup, dropout, max_followup = max_fu)
    dur <- if (is.finite(followup)) .vcr_accrual_end(x$entry, accrual) + followup else max(x$entry + x$time)
    c(vcr_analyse_one_sample_logrank(x$time, x$status, dist, alpha, sided, alternative), sampleSize = n, duration = dur, generatedRecords = n)
  })
}

#' The analytic counterpart of a single-arm continuous or time-to-event simulation:
#' the exact power of the one-sample t (non-central t) or z test, and for a
#' time-to-event endpoint the first-order normal approximation of the one-sample
#' log-rank test from the moments of its score. `NULL` when there is none.
vcr_single_arm_analytic <- function(scenario) {
  d <- scenario[["design"]]; tr <- scenario[["truth"]]; an <- scenario[["analysis"]]
  endpoint <- as.character(scenario[["endpoint"]][["type"]])
  alpha <- vcr_scalar(an[["alpha"]], 0.025); sided <- vcr_check_sided(an[["sided"]]); alternative <- as.character(an[["alternative"]])
  n <- vcr_scalar(d[["n"]], NA_real_)
  is_null <- vcr_is_null_scenario(scenario)
  name <- if (is_null) "type_one_error" else "power"
  if (identical(endpoint, "continuous")) {
    effect <- vcr_scalar(tr[["effect"]], NA_real_); sd <- vcr_scalar(tr[["sd"]], 1)
    sign_ <- if (identical(alternative, "less")) -1 else 1
    if (identical(as.character(an[["method"]]), "one_sample_z")) {
      known <- vcr_scalar(an[["sd"]], NA_real_); crit <- stats::qnorm(1 - alpha / sided)
      shift <- effect * sqrt(n) / known; scale <- sd / known
      one <- function(s) stats::pnorm((s * shift - crit) / scale)
      value <- if (identical(alternative, "two.sided")) one(1) + one(-1) else one(sign_)
      return(list(name = name, value = value, basis = "normal_one_sample_z"))
    }
    crit <- stats::qt(1 - alpha / sided, n - 1); ncp <- effect * sqrt(n) / sd
    value <- if (identical(alternative, "two.sided")) stats::pt(crit, n - 1, ncp = ncp, lower.tail = FALSE) + stats::pt(-crit, n - 1, ncp = ncp)
             else stats::pt(crit, n - 1, ncp = sign_ * ncp, lower.tail = FALSE)
    return(list(name = name, value = value, basis = "noncentral_t_one_sample"))
  }
  if (identical(endpoint, "time_to_event")) {
    # the asymptotic level: the test is conservative when the benchmark predicts few events (the count is discrete, and its lower tail is lighter than a normal's)
    if (is_null) return(list(name = "type_one_error", value = alpha, basis = "asymptotic_one_sample_logrank"))
    hr <- vcr_scalar(tr[["hazardRatio"]], NA_real_); dist <- vcr_control_distribution(tr)
    acc <- scenario[["accrual"]] %||% list()
    A <- vcr_scalar(acc[["duration"]], 0); Fu <- vcr_scalar(acc[["followup"]], NA_real_); eta <- vcr_dropout_hazard(vcr_scalar(acc[["dropoutAnnual"]], 0))
    if (!is.finite(Fu) || is.finite(vcr_scalar(acc[["maxFollowup"]], Inf)) || !identical(as.character(acc[["kind"]] %||% "uniform"), "uniform")) return(NULL)
    horizon <- A + Fu
    # moments of one patient's score contribution X = (cumulative benchmark hazard at the observed time) - (event indicator)
    t <- seq(0, horizon, length.out = 4001L)
    w <- .vcr_simpson_weights(length(t)) * (t[2] - t[1])
    h0 <- vcr_dist_hazard(dist, t); H0 <- -log(vcr_dist_survival(dist, t)); S1 <- vcr_dist_survival(dist, t)^hr
    Sc <- vcr_at_risk_fraction(t, A, Fu, eta)          # P(not yet censored at t)
    f1 <- hr * h0 * S1
    EH <- sum(w * h0 * S1 * Sc)                        # E[H0(T*)]
    Ed <- sum(w * f1 * Sc)                             # E[event]
    EdH <- sum(w * H0 * f1 * Sc)                       # E[event * H0(T)]
    EH2 <- sum(w * 2 * H0 * h0 * S1 * Sc)              # E[H0(T*)^2]
    mu <- EH - Ed; v <- Ed - 2 * EdH + EH2 - mu^2
    crit <- stats::qnorm(1 - alpha / sided)
    shift <- sqrt(n) * mu / sqrt(EH); scale <- sqrt(v / EH)
    one <- function(s) stats::pnorm((s * shift - crit) / scale)
    value <- switch(alternative, less = one(1), greater = one(-1), one(1) + one(-1))
    return(list(name = name, value = value, basis = "first_order_one_sample_logrank"))
  }
  NULL
}

#' The documented bias of the first-order normal approximation of the one-sample
#' log-rank power: it treats the denominator E as fixed at its mean, so it is good to
#' about a percentage point at the effect sizes a trial is designed for. Measured in
#' case N48c against an independent simulation: 0.4 to 1.3 points (hazard ratios 0.5 to
#' 0.8, exponential and Weibull benchmarks, 60 to 100 patients), the analytic value a
#' little below the simulated one at high power and a little above it at low power; the
#' case keeps the largest gap it measured beside this constant, which has room above it.
VCR_ONE_SAMPLE_LOGRANK_APPROXIMATION_BIAS <- 0.02

`%||%` <- function(a, b) if (is.null(a)) b else a
