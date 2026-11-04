# ---------------------------------------------------------------------------
# patients_progression.R — a population-level disease-progression simulator from a published model family
# (algorithm round P4, 2026-11-03; `patients.progression`).
#
# Hidden knowledge:
#
# - **No disease is in this file and no number is built in.** The run states a model family (linear, exponential, logistic, Emax), every
#   parameter of it, the between-person spread of the progression parameter, the baseline, the residual SD and the treatment's slowing, and each
#   of them says where it came from (`literature` with the citation, `assumed`, `data`). Those sources reach the page as premises; the engine
#   only refuses a value that has none. The engine neither knows nor checks that a published model fits the condition the study is about.
# - **The shape is one unit of progression, and a person's amplitude scales it.** A person's change at time t is `amplitude_i * u(t)` with
#   u linear (`t`), exponential (`(exp(k t) - 1) / k`, initial slope 1, k the acceleration), logistic (`S(k (t - t50)) - S(-k t50)`, S the logistic function, k the steepness, zero at 0)
#   or Emax (`t / (T50 + t)`), and the amplitude (the slope, or the plateau) is the parameter that varies between people: `N(mean, sd)`,
#   correlated with the person's baseline by `rho`. Because the change is LINEAR in the amplitude, the mean curve is the shape at the mean
#   amplitude and the variance at a visit is closed-form for every family: `w0^2 + u^2 wa^2 + 2 rho w0 wa u + s^2` (N99a holds the simulator to it).
# - **The treatment slows the clock.** A treated person follows the same curve with time scaled by `1 - slowing`: the progression rate at every
#   state is `1 - slowing` times the untreated one. For a linear family that is the slope reduced by that share; for the others it is the
#   same statement made for the whole curve, which is what "slows progression" means in the ODE form every such model comes from.
# - **Population level only.** Jamalian et al. (2023) found that a model of this kind predicted a person's change from baseline with R squared
#   0.16, and that its prediction interval missed an external placebo arm; the curve is what a group does on average and how widely people
#   scatter around it, never a prediction for a person. The result says so, and `limits` repeats it.
# - **Power is simulated with its error.** The analysis is a Welch t-test of the change from baseline to a stated visit, or of per-person least
#   squares slopes over all the visits; the share of simulated trials that reject in the direction of benefit (or, with no slowing, that reject at
#   all: the type I error) is a Monte Carlo proportion with its MCSE. The floors are the domain's (20,000 under the null, 5,000 under an
#   alternative). Beside it the result gives the closed-form power of the same test (noncentral t with Welch's degrees of freedom), which
#   the simulation has to agree with to within its error.
# - **The first visit is time zero.** It is the baseline. A schedule that starts anywhere else is refused by name, since the curve is
#   defined as change from there.
# ---------------------------------------------------------------------------

.VCR_PROGRESSION_FAMILIES <- c("linear", "exponential", "logistic", "emax")

#' The unit shape of progression at time `t` (zero at 0), for the family's shape parameters `m` (each a plain number).
vcr_progression_shape <- function(family, t, m) {
  switch(family,
    linear = t,
    exponential = if (abs(m[["rate"]]) < 1e-9) t else (exp(m[["rate"]] * t) - 1) / m[["rate"]],
    logistic = stats::plogis(m[["rate"]] * (t - m[["midpoint"]])) - stats::plogis(-m[["rate"]] * m[["midpoint"]]),
    emax = t / (m[["halfTime"]] + t),
    vcr_abort("scenario_value_invalid", "scenario.model.family", "The progression model is linear, exponential, logistic or emax."))
}

#' The family's parameters read from the scenario: the amplitude (its mean and between-person SD) and the shape numbers, each as a bare number.
.vcr_progression_params <- function(model) {
  fam <- as.character(model[["family"]])
  v <- function(key) { x <- model[[key]]; if (is.null(x)) NULL else as.numeric(x[["value"]]) }
  list(family = fam,
       amplitude = if (fam %in% c("linear", "exponential")) v("slope") else v("amplitude"),
       amplitudeSd = v("betweenPersonSd"),
       amplitudeKey = if (fam %in% c("linear", "exponential")) "slope" else "amplitude",
       shape = c(rate = if (identical(fam, "exponential")) v("acceleration") else v("steepness"), midpoint = v("midpoint"), halfTime = v("halfTime")))
}

#' The exact mean and standard deviation of the outcome at every visit for one arm, and the covariance between visits.
vcr_progression_moments <- function(par, baseline_mean, baseline_sd, residual_sd, rho, visits, scale = 1) {
  u <- vcr_progression_shape(par$family, scale * visits, par$shape)
  mu <- baseline_mean + par$amplitude * u
  cov <- baseline_sd^2 + rho * baseline_sd * par$amplitudeSd * outer(u, u, "+") + par$amplitudeSd^2 * outer(u, u) + diag(residual_sd^2, length(u))
  list(visits = visits, shapeValue = u, mean = mu, sd = sqrt(diag(cov)), covariance = cov)
}

#' One arm of `n` simulated people over the visits: the outcome matrix (people x visits). Draws from the stream in use.
vcr_progression_simulate <- function(par, baseline_mean, baseline_sd, residual_sd, rho, visits, n, scale = 1) {
  z1 <- stats::rnorm(n); z2 <- stats::rnorm(n)
  y0 <- baseline_mean + baseline_sd * z1
  amp <- par$amplitude + par$amplitudeSd * (rho * z1 + sqrt(max(0, 1 - rho^2)) * z2)
  u <- vcr_progression_shape(par$family, scale * visits, par$shape)
  y <- outer(amp, u) + y0
  y + matrix(stats::rnorm(n * length(visits), 0, residual_sd), n, length(visits))
}

# --- the two analyses ---------------------------------------------------------------------------------------------

#' The linear weights of a person's analysis statistic over the visits: the change from the first visit to visit `j`, or the least-squares slope.
.vcr_progression_weights <- function(kind, visits, at) {
  k <- length(visits)
  if (identical(kind, "slope")) { tc <- visits - mean(visits); return(tc / sum(tc^2)) }
  w <- numeric(k); w[at] <- 1; w[1L] <- w[1L] - 1; w
}

#' Welch's t statistic and degrees of freedom of two samples' means.
.vcr_welch <- function(a, b) {
  va <- stats::var(a) / length(a); vb <- stats::var(b) / length(b); se2 <- va + vb
  list(t = (mean(a) - mean(b)) / sqrt(se2), df = se2^2 / (va^2 / (length(a) - 1) + vb^2 / (length(b) - 1)))
}

#' The closed-form power of the analysis: the exact mean and variance of the person-level statistic in each arm, Welch's test as a noncentral t.
.vcr_progression_power_form <- function(par, p, scale_treat) {
  w <- .vcr_progression_weights(p$analysis$kind, p$visits, p$at)
  stat <- function(scale) {
    u <- vcr_progression_shape(par$family, scale * p$visits, par$shape)
    m <- par$amplitude * sum(w * u)
    v <- par$amplitudeSd^2 * sum(w * u)^2 + p$residual_sd^2 * sum(w^2)
    list(mean = m, var = v)
  }
  ctl <- stat(1); trt <- stat(scale_treat)
  d <- trt$mean - ctl$mean
  se2 <- ctl$var / p$n0 + trt$var / p$n1
  df <- se2^2 / ((ctl$var / p$n0)^2 / (p$n0 - 1) + (trt$var / p$n1)^2 / (p$n1 - 1))
  ncp <- d / sqrt(se2); crit <- stats::qt(1 - p$alpha / 2, df)
  # benefit is the treated mean on the side of less progression: opposite to the sign of the amplitude
  benefit_ncp <- -sign(par$amplitude) * ncp
  power <- if (p$is_null) stats::pt(crit, df, ncp = ncp, lower.tail = FALSE) + stats::pt(-crit, df, ncp = ncp) else stats::pt(crit, df, ncp = benefit_ncp, lower.tail = FALSE)
  list(power = power, control = ctl, treated = trt, difference = d, standardError = sqrt(se2), df = df, ncp = ncp)
}

#' One simulated trial: whether the analysis rejects (in the direction of benefit unless the treatment does nothing).
.vcr_progression_trial <- function(par, p, scale_treat) {
  yc <- vcr_progression_simulate(par, p$baseline_mean, p$baseline_sd, p$residual_sd, p$rho, p$visits, p$n0, 1)
  yt <- vcr_progression_simulate(par, p$baseline_mean, p$baseline_sd, p$residual_sd, p$rho, p$visits, p$n1, scale_treat)
  w <- .vcr_progression_weights(p$analysis$kind, p$visits, p$at)
  tw <- .vcr_welch(as.numeric(yt %*% w), as.numeric(yc %*% w))
  crit <- stats::qt(1 - p$alpha / 2, tw$df)
  reject <- if (p$is_null) abs(tw$t) > crit else (-sign(par$amplitude) * tw$t) > crit
  c(reject = as.numeric(reject), t = tw$t)
}

.vcr_progression_run <- function(par, p, scale_treat, want, seed, cores, cancel_file = NULL, batch = 500L, progress = NULL) {
  bank <- vcr_stream_bank(seed)
  done <- 0L; parts <- list(); stopped <- NULL
  while (done < want) {
    if (!is.null(cancel_file) && file.exists(cancel_file)) { stopped <- "canceled"; break }
    reason <- vcr_interrupt()
    if (!is.null(reason)) { stopped <- reason; break }
    take <- as.integer(min(batch, want - done))
    out <- vcr_map_streams(bank$take(take), function(i) .vcr_progression_trial(par, p, scale_treat), cores = cores, indices = done + seq_len(take))
    parts[[length(parts) + 1L]] <- do.call(rbind, out)
    done <- done + take
    if (!is.null(progress)) progress(done, want)
  }
  list(values = if (length(parts)) do.call(rbind, parts) else NULL, done = done, stopped = stopped)
}

# --- the handler --------------------------------------------------------------------------------------------------

vcr_job_patients_progression <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  sc <- job[["scenario"]]
  model <- sc[["model"]]; par <- .vcr_progression_params(model)
  val <- function(x, default = NULL) if (is.null(x)) default else as.numeric(x[["value"]])
  visits <- vcr_num(sc[["visits"]])
  if (!identical(as.numeric(visits[1L]), 0)) vcr_abort("scenario_value_invalid", "scenario.visits", "The first visit is time zero, the baseline the change is counted from.")
  slowing <- val(sc[["treatment"]][["slowing"]])
  rho_given <- !is.null(sc[["correlation"]]); rho <- val(sc[["correlation"]], 0)
  an <- sc[["analysis"]] %||% list(); kind <- as.character(an[["kind"]] %||% "change"); alpha <- vcr_scalar(an[["alpha"]], 0.05)
  at_time <- vcr_scalar(an[["visit"]], max(visits))
  at <- match(TRUE, abs(visits - at_time) < 1e-9)
  if (is.na(at) || at < 2L) vcr_abort("scenario_value_invalid", "scenario.analysis.visit", "The analysis visit is one of the scheduled visits after the first.")
  if (identical(kind, "slope") && length(visits) < 3L) vcr_abort("scenario_value_invalid", "scenario.visits", "A slope needs at least three visits.")
  p <- list(baseline_mean = val(sc[["baseline"]][["mean"]]), baseline_sd = val(sc[["baseline"]][["sd"]]), residual_sd = val(sc[["residualSd"]]), rho = rho, visits = visits,
            n1 = as.integer(sc[["design"]][["nTreat"]]), n0 = as.integer(sc[["design"]][["nControl"]]), alpha = alpha, at = at, is_null = !(slowing > 0),
            analysis = list(kind = kind))
  if (!(par$amplitudeSd >= 0) || !(p$baseline_sd >= 0) || !(p$residual_sd >= 0)) vcr_abort("scenario_value_invalid", "scenario.model", "A spread is not negative.")
  if (p$residual_sd == 0 && p$baseline_sd == 0 && par$amplitudeSd == 0) vcr_abort("scenario_value_invalid", "scenario.model", "At least one source of spread is positive: with none, every person is the same and the test has no variance.")
  scale_treat <- 1 - slowing
  floor_ <- as.integer(vcr_replicate_floor(p$is_null))
  want <- as.integer(min(max(floor_, vcr_scalar(job[["replicates"]], 0L)), vcr_max_replicates()))
  cores <- vcr_cores(job[["cores"]]); seed <- vcr_scalar(job[["seed"]], 1)

  # exact curves
  ctl <- vcr_progression_moments(par, p$baseline_mean, p$baseline_sd, p$residual_sd, rho, visits, 1)
  trt <- vcr_progression_moments(par, p$baseline_mean, p$baseline_sd, p$residual_sd, rho, visits, scale_treat)
  curves <- lapply(seq_along(visits), function(j) list(
    visit = visits[j], timeUnit = as.character(sc[["timeUnit"]]),
    control = list(mean = vcr_measure("curve_mean", ctl$mean[j], source = "calculated"), sd = vcr_measure("curve_sd", ctl$sd[j], source = "calculated")),
    treated = list(mean = vcr_measure("curve_mean", trt$mean[j], source = "calculated"), sd = vcr_measure("curve_sd", trt$sd[j], source = "calculated")),
    change = list(control = vcr_measure("curve_change", ctl$mean[j] - ctl$mean[1L], source = "calculated"), treated = vcr_measure("curve_change", trt$mean[j] - trt$mean[1L], source = "calculated"))))
  form <- .vcr_progression_power_form(par, p, scale_treat)

  run <- .vcr_progression_run(par, p, scale_treat, want, as.integer(as.numeric(seed) %% 2147483647), cores, cancel_file, progress = progress)
  v <- run$values
  if ((is.null(v) || !nrow(v)) && identical(run$stopped, "canceled")) return(.vcr_interrupted_result("canceled", "no trial was run"))
  if (is.null(v) || !nrow(v)) vcr_abort("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the first batch of trials; there is no result.")
  done <- nrow(v); q <- mean(v[, "reject"]); s <- vcr_mcse_proportion(q, done)
  power <- vcr_measure(if (p$is_null) "type_one_error" else "power", q, simulated = TRUE, mcse = s, source = "synthetic",
                       interval = vcr_interval("monte_carlo", max(0, q - 1.96 * s), min(1, q + 1.96 * s)))
  estimand_unit <- if (identical(kind, "slope")) "outcome units per time unit" else "outcome units"
  measures <- list(power,
                   vcr_measure("expected_difference", form$difference, source = "calculated", unit = estimand_unit, note = "treated less control, in the analysis's own estimand"),
                   vcr_measure("expected_control_change", ctl$mean[at] - ctl$mean[1L], source = "calculated", unit = as.character(sc[["endpoint"]][["unit"]] %||% "outcome units")),
                   vcr_measure("expected_treated_change", trt$mean[at] - trt$mean[1L], source = "calculated", unit = as.character(sc[["endpoint"]][["unit"]] %||% "outcome units")))
  issues <- list(); stopped <- run$stopped
  if (identical(stopped, "cpu_budget")) issues <- list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before every trial ran; the power uses the trials that finished."))
  status <- if (identical(stopped, "canceled")) "canceled" else if (identical(stopped, "cpu_budget")) "failed" else "succeeded"
  given <- list()
  add <- function(key, x) if (!is.null(x)) given[[length(given) + 1L]] <<- list(key = key, value = as.numeric(x[["value"]]), basis = as.character(x[["basis"]]), citation = x[["citation"]])
  add("model.amplitude", model[[par$amplitudeKey]]); add("model.betweenPersonSd", model[["betweenPersonSd"]])
  for (k in c("acceleration", "steepness", "midpoint", "halfTime")) add(paste0("model.", k), model[[k]])
  add("baseline.mean", sc[["baseline"]][["mean"]]); add("baseline.sd", sc[["baseline"]][["sd"]]); add("residualSd", sc[["residualSd"]]); add("treatment.slowing", sc[["treatment"]][["slowing"]])
  if (rho_given) add("correlation", sc[["correlation"]])
  assumed <- list()
  if (!rho_given) assumed[[length(assumed) + 1L]] <- list(key = "correlation", value = 0, basis = "default: no correlation between a person's baseline and progression parameter")
  if (is.null(an[["alpha"]])) assumed[[length(assumed) + 1L]] <- list(key = "analysis.alpha", value = 0.05, basis = "default: two-sided 5%")
  if (is.null(an[["visit"]]) && identical(kind, "change")) assumed[[length(assumed) + 1L]] <- list(key = "analysis.visit", value = at_time, basis = "default: the last scheduled visit")
  if (is.null(an[["kind"]])) assumed[[length(assumed) + 1L]] <- list(key = "analysis.kind", value = kind, basis = "default: the change from baseline")
  if (is.null(job[["replicates"]])) assumed[[length(assumed) + 1L]] <- list(key = "trials", value = want, basis = if (p$is_null) "default: the null-scenario floor of simulated trials" else "default: the floor of simulated trials under an alternative")
  list(status = status, measures = measures, issues = issues, counts = vcr_counts(generatedRecords = done * (p$n1 + p$n0)),
       conclusion = "limited",
       diagnostics = list(replicatesCompleted = done, progression = list(
         family = par$family, curves = curves, isNull = p$is_null, trials = done, trialsRequested = want,
         analysis = list(kind = kind, visit = at_time, alpha = alpha, firstVisit = visits[1L]),
         approximation = list(power = form$power, standardError = form$standardError, degreesOfFreedom = form$df, noncentrality = form$ncp,
                              controlStatistic = list(mean = form$control$mean, sd = sqrt(form$control$var)), treatedStatistic = list(mean = form$treated$mean, sd = sqrt(form$treated$var)),
                              method = "Welch's test as a noncentral t on the exact mean and variance of the person-level statistic in each arm"),
         treatment = list(slowing = slowing, scale = scale_treat),
         given = given, assumed = assumed, populationLevel = TRUE,
         limits = list("Population level: the curve is what a group does on average and how widely people scatter around it, not a prediction for a person (Jamalian et al. 2023: baseline predicted a person's change with R squared 0.16).",
                       "A model published for one condition says nothing here about another, and none of its parameters is checked against the condition the study is about; each stated value carries the source it was given."))))
}
