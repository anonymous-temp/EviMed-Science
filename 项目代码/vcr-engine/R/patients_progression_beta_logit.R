# ---------------------------------------------------------------------------
# patients_progression_beta_logit.R — the `beta_logit` family of `patients.progression` 1.1.0: the published drug-disease-trial model of mild and
# moderate Alzheimer disease on ADAS-cog 11 (CAMD / C-Path, Rogers et al. 2012), executed with the posterior its authors released in adsim 3.0
# (plan T06, 2026-11-07).
#
# Hidden knowledge:
#
# - **The numbers are data, the equations are code, and neither is ours.** The 1,600 posterior draws are `R/models/ad_adascog11_camd_adsim3.json`,
#   copied bit for bit from adsim 3.0's `data/posterior.rda` by `scripts/build-ad-adascog-parameter-set.R` (the archive's SHA-1, SHA-256 and the
#   file's SHA-256 are in it); the engine refuses to run on a parameter file whose SHA-256 is not the pinned one. The equations are adsim's
#   `acRun` and `dropTime` (training manual Eqs. 2.1-2.12, 3.1-3.3): on the logit scale of ADAS/70, a person's intercept and slope, a Bateman
#   placebo curve from study week 0 in every arm, and the drug's terms; the score is 70 x Beta(theta tau, (1 - theta) tau) with adsim's own guard
#   of 1e-5 on both shapes. What the source audit (`AD-SOURCE.md`) could not recover is not here: no fitted shape xi other than 1, no
#   intercept-slope covariance, no treatment term in the dropout, no dose-response for a new compound.
# - **What it reproduces and what it does not.** With this posterior and these equations the numeric cases (N101) reproduce the EMA 2013
#   qualification opinion's Tables 7, 9 and 11 within the published rounding and Monte Carlo error, Table 8's medians under a stated covariate
#   reading, and three numbers of the authors' training manual exactly. They do not reproduce Table 10's intervals or Figures 15 and 16, whose
#   computation is not published. Neither the FDA letter (2013-06-12) nor the EMA opinion (2013-09-19) is about this code: they concern the
#   original tool in its stated context of use, and nothing of them transfers here. The result says so in `limits`.
# - **The drug is the researcher's hypothesis.** The posterior's own drug parameters are three AChE inhibitors'; a new compound has none. The
#   scenario states a symptomatic effect (an Emax on the logit scale, stated as a difference in points at a week and a reference score, converted
#   by adsim's `gLogitDelta`, or as the logit Emax itself) and/or a disease-modifying share, and the result carries it as the premise it is.
# - **Disease modification is adsim's, not a slowed clock.** E_DM = fraction x mu_alpha,adj x time on drug: the study-level, covariate-adjusted
#   mean slope, never the person's own, held after the dose ends (no rebound). It is a different statement from the four other families'
#   `slowing`, which scales each person's own clock and would stretch the placebo and symptomatic curves too.
# - **Three kinds of uncertainty, kept apart.** `typical_study` uses the posterior medians and the population-level means and precisions (adsim's
#   `sim.interstudy = FALSE`); `new_study` (the default, adsim's) draws one study per simulated trial from the medians' hyperparameters (its mean
#   intercept and slope, the three precisions and the dropout's study effect); `posterior_draws` first draws one of the 1,600 posterior rows per
#   trial and then the study from it, which is what the EMA's 10,000-trial examples did. The calculated curves are always the typical study at the
#   medians, because that is what a deterministic number can be about; the power is the simulation's, in the mode the scenario names.
# - **Dropout depends on age and MMSE, not on arm or outcome** (Weibull with a study frailty, `dropTime`). The dropout times are drawn even when the
#   scenario switches dropout off, so the same seed gives the same people and scores either way. The analysis is among the people still observed
#   at the analysis visit; the calculated difference it is compared with is weighted the same way (each covariate cell by its chance of still being
#   there), so the two agree up to Monte Carlo error. The analysis is a Welch test of the change from baseline or an analysis of covariance
#   (change on arm and baseline), not adsim's MMRM, which would need a package outside the lock.
# - **Quadrature, not sampling, for every calculated number.** Gauss-Legendre over the MMSE range (and over the quantiles of a truncated age),
#   Gauss-Hermite over an untruncated age and over the two random effects, the three genotypes and two sexes summed. Each number is a fixed sum of
#   fixed terms: the same to the last bit on any machine and core count.
# ---------------------------------------------------------------------------

.VCR_BETA_LOGIT_SETS <- list(
  "camd-adas-cog-11" = list(version = "adsim-3.0", file = file.path("models", "ad_adascog11_camd_adsim3.json"),
                            sha256 = "a8889ac7c1aa4bf15f62347ee8675c5a691cfe92b8ffd9c6fb0de7510f1f51c8"))
#' adsim's guard on the two beta shapes (`acRun`: `rbeta(n, (theta + 1e-5) tau, (1 - theta + 1e-5) tau)`).
.VCR_BETA_LOGIT_GUARD <- 1e-5
#' The regulators' context of use: trials of up to two years (EMA opinion p.2); a later visit is computed and stated as an extrapolation.
.VCR_BETA_LOGIT_DATA_WEEKS <- 104
.VCR_BETA_LOGIT_UNCERTAINTY <- c("new_study", "typical_study", "posterior_draws")
.vcr_bl_cache <- new.env(parent = emptyenv())

# --- the parameter set ----------------------------------------------------------------------------------------------------------------

#' The parameter set `id` at `version`: the draws (a matrix, one row per posterior draw, the source's own column names), their medians, the
#' source's identity and the file's own SHA-256. Read once per process; a file whose hash is not the pinned one is refused.
vcr_beta_logit_parameter_set <- function(id, version) {
  spec <- .VCR_BETA_LOGIT_SETS[[id %||% ""]]
  if (is.null(spec) || !identical(spec[["version"]], version)) {
    vcr_abort("scenario_value_invalid", "scenario.model.parameterSet", "The beta_logit family has one parameter set: camd-adas-cog-11 at version adsim-3.0.")
  }
  key <- paste(id, version, sep = "@")
  if (!is.null(.vcr_bl_cache[[key]])) return(.vcr_bl_cache[[key]])
  path <- file.path(vcr_engine_root(), "R", spec[["file"]])
  sha <- if (file.exists(path)) vcr_file_sha256(path) else ""
  if (!identical(sha, spec[["sha256"]])) {
    vcr_abort("input_hash_mismatch", "scenario.model.parameterSet", sprintf("The parameter file of %s is not the one this build was checked with (SHA-256 %s).", key, if (nzchar(sha)) sha else "absent"))
  }
  doc <- jsonlite::fromJSON(path, simplifyVector = TRUE)
  cols <- unlist(doc[["columns"]])
  draws <- do.call(cbind, doc[["values"]][cols])
  colnames(draws) <- cols
  set <- list(id = id, version = version, fileSha256 = sha, source = doc[["source"]], endpoint = doc[["endpoint"]], reference = doc[["reference"]],
              timeUnit = doc[["timeUnit"]], draws = draws, medians = apply(draws, 2L, stats::median), storedMedians = unlist(doc[["medians"]]))
  .vcr_bl_cache[[key]] <- set
  set
}

#' One row of the parameter set (the medians, or a posterior draw) as the model's named parameters, with the population's covariate overrides
#' in place of the set's own covariate model.
vcr_beta_logit_par <- function(row, population = list()) {
  g <- function(k) unname(row[[k]])
  kel <- g("kel"); keq <- kel + g("keqMinusKel")
  ref <- list(bmmse = 21, age = 75)
  list(nuEta = g("nuEta"), nuAlpha = g("nuAlpha"), lambdaEta = g("lambdaEtaBMMSE"), lambdaMmse = g("lambdaAlphaBMMSE"), lambdaAge = g("lambdaAlphaAge"),
       lambdaApoe = c(0, g("lambdaAlphaApo1"), g("lambdaAlphaApo2")), lambdaFemale = g("lambdaAlphaGen"),
       psiEta = g("psiEta"), psiAlpha = g("psiAlpha"), phiEta = g("phiEta"), kappaEta = g("kappaEta"), phiAlpha = g("phiAlpha"), kappaAlpha = g("kappaAlpha"),
       phiEpsilon = g("phiEpsilon"), kappaEpsilon = g("kappaEpsilon"),
       kel = kel, keq = keq, placeboBeta = -g("aucPlacebo") / (1 / kel - 1 / keq),
       apoe = population[["apoe4"]] %||% c(g("pApo[1]"), g("pApo[2]"), g("pApo[3]")),
       ageMean = population[["ageMeanByApoe4"]] %||% c(g("Eage[1]"), g("Eage[2]"), g("Eage[3]")),
       ageSd = population[["ageSd"]] %||% sqrt(g("Vage")), female = population[["femaleShare"]] %||% g("pGen"),
       mmse = population[["mmseRange"]] %||% c(16, 26), ageBounds = population[["ageBounds"]],
       beta0 = g("beta0"), betaAge = g("betaAge"), betaMmse = g("betaBmmse"), weibullShape = g("v"), sdStudy = g("sdStudy"),
       reference = ref)
}

#' A typical study: the population-level means and precisions (adsim's `sim.interstudy = FALSE`), no study effect on dropout.
vcr_beta_logit_typical_study <- function(par) {
  list(muEta = par[["nuEta"]], muAlpha = par[["nuAlpha"]], sdEta = par[["phiEta"]], sdAlpha = par[["phiAlpha"]], tau = 1 / par[["phiEpsilon"]]^2, omega = 0)
}

#' A new study drawn from the hyperparameters, in this order: its mean intercept and slope, the precisions of the intercept, the slope and the
#' residual (Gamma with mean 1 / phi^2), and the dropout's study effect. Draws from the stream in use.
vcr_beta_logit_new_study <- function(par) {
  mu_eta <- stats::rnorm(1L, par[["nuEta"]], par[["psiEta"]])
  mu_alpha <- stats::rnorm(1L, par[["nuAlpha"]], par[["psiAlpha"]])
  tau_eta <- stats::rgamma(1L, par[["kappaEta"]], rate = par[["kappaEta"]] * par[["phiEta"]]^2)
  tau_alpha <- stats::rgamma(1L, par[["kappaAlpha"]], rate = par[["kappaAlpha"]] * par[["phiAlpha"]]^2)
  tau <- stats::rgamma(1L, par[["kappaEpsilon"]], rate = par[["kappaEpsilon"]] * par[["phiEpsilon"]]^2)
  omega <- stats::rnorm(1L, 0, par[["sdStudy"]])
  list(muEta = mu_eta, muAlpha = mu_alpha, sdEta = 1 / sqrt(tau_eta), sdAlpha = 1 / sqrt(tau_alpha), tau = tau, omega = omega)
}

# --- the time course --------------------------------------------------------------------------------------------------------------------

#' The placebo response on the logit scale at study week `t` (Bateman form): beta (exp(-kel t) - exp(-keq t)), its integral over all time minus
#' `aucPlacebo`.
vcr_beta_logit_placebo <- function(par, t) par[["placeboBeta"]] * (exp(-par[["kel"]] * t) - exp(-par[["keq"]] * t))

#' A symptomatic effect stated as `points` (treated less untreated, negative is better) at `at_week` for a person at `reference_adas`, turned into
#' the logit Emax of an Emax curve with `et50` (adsim's `gLogitDelta` with xi = 1).
vcr_beta_logit_emax_from_points <- function(points, at_week, reference_adas, et50) {
  (stats::qlogis((reference_adas + points) / 70) - stats::qlogis(reference_adas / 70)) * (at_week + et50) / at_week
}

#' The drug's two terms at the times `t` for a treatment `tr` (`emax`, `et50`, `halfLife`, `fraction`, `begin`, `end`): the symptomatic one on
#' the logit scale (Emax on the time on drug, decaying with its half-life after the dose ends) and the time on drug the disease-modifying term
#' multiplies (held after the dose ends).
vcr_beta_logit_drug <- function(tr, t) {
  span <- tr[["end"]] - tr[["begin"]]
  on <- pmin(pmax(t - tr[["begin"]], 0), span)
  sx <- numeric(length(t))
  if (!is.null(tr[["emax"]]) && tr[["emax"]] != 0) {
    sx <- tr[["emax"]] * on / (tr[["et50"]] + on)
    after <- t > tr[["end"]]
    if (any(after)) sx[after] <- tr[["emax"]] * span / (tr[["et50"]] + span) * exp(-log(2) * (t[after] - tr[["end"]]) / tr[["halfLife"]])
  }
  list(symptomatic = sx, onDrug = on, fraction = tr[["fraction"]] %||% 0)
}

# --- calculated moments ----------------------------------------------------------------------------------------------------------------

#' The mean and variance of the score 70 x Beta((theta + g) tau, (1 - theta + g) tau) for a latent mean `theta` (any shape) and precision `tau`,
#' g adsim's guard: the closed form of the observation model.
vcr_beta_logit_score_moments <- function(theta, tau) {
  g <- .VCR_BETA_LOGIT_GUARD
  list(mean = 70 * (theta + g) / (1 + 2 * g), var = 70^2 * (theta + g) * (1 - theta + g) / ((1 + 2 * g)^2 * (tau * (1 + 2 * g) + 1)))
}

#' The Weibull rate of leaving for people of these ages and MMSE scores in a study whose dropout effect is `omega`: S(t) = exp(-rate t^v).
.vcr_bl_hazard <- function(par, age, mmse, omega) {
  ref <- par[["reference"]]
  exp(par[["beta0"]] + par[["betaAge"]] * (age - ref$age) + par[["betaMmse"]] * (mmse - ref$bmmse) + omega)
}

#' The share of the population of a parameter row still observed at each of the times `t`, in a study whose dropout effect is `omega` (0: a
#' typical study), by quadrature over the covariates.
vcr_beta_logit_observed <- function(par, t, omega = 0, n_mmse = 12L, n_age = 10L) {
  cells <- .vcr_bl_cells(par, n_mmse, n_age)
  rate <- .vcr_bl_hazard(par, cells$age, cells$mmse, omega)
  vapply(t, function(x) sum(cells$weight * exp(-rate * x^par[["weibullShape"]])), numeric(1))
}

.vcr_bl_nodes <- function(kind, n) {
  key <- paste(kind, n)
  if (is.null(.vcr_bl_cache[[key]])) .vcr_bl_cache[[key]] <- if (identical(kind, "gh")) .vcr_gauss_hermite(n) else vcr_gauss_legendre(n)
  .vcr_bl_cache[[key]]
}

#' The covariate cells of the population a parameter row describes: one row per MMSE node x genotype x sex x age node, with its weight.
.vcr_bl_cells <- function(par, n_mmse = 12L, n_age = 10L) {
  rng <- par[["mmse"]]
  if (rng[2] > rng[1]) { gl <- .vcr_bl_nodes("gl", n_mmse); mmse <- (rng[1] + rng[2]) / 2 + (rng[2] - rng[1]) / 2 * gl$nodes; w_mmse <- gl$weights / 2 } else { mmse <- rng[1]; w_mmse <- 1 }
  apoe <- par[["apoe"]] / sum(par[["apoe"]]); sexes <- c(1 - par[["female"]], par[["female"]])
  rows <- list()
  for (g in 0:2) {
    if (!(apoe[g + 1L] > 0)) next
    m <- par[["ageMean"]][g + 1L]; s <- par[["ageSd"]]; bounds <- par[["ageBounds"]]
    if (is.null(bounds)) {
      gh <- .vcr_bl_nodes("gh", n_age); age <- m + sqrt(2) * s * gh$nodes; w_age <- gh$weights / sqrt(pi)
    } else {
      gl <- .vcr_bl_nodes("gl", n_age); lo <- stats::pnorm(bounds[1], m, s); hi <- stats::pnorm(bounds[2], m, s)
      age <- stats::qnorm(lo + (hi - lo) * (gl$nodes + 1) / 2, m, s); w_age <- gl$weights / 2
    }
    for (f in 0:1) {
      if (!(sexes[f + 1L] > 0)) next
      grid <- expand.grid(i = seq_along(mmse), j = seq_along(age))
      rows[[length(rows) + 1L]] <- data.frame(mmse = mmse[grid$i], apoe = g, female = f, age = age[grid$j],
                                              weight = apoe[g + 1L] * sexes[f + 1L] * w_mmse[grid$i] * w_age[grid$j])
    }
  }
  do.call(rbind, rows)
}

#' The exact moments, over the population of a parameter row, of one arm of `study` at the times `times` (the first is 0): the mean score and its
#' SD, the mean change from baseline and its SD, the share still observed and the mean change among those observed. `drug` is the arm's
#' `vcr_beta_logit_drug` (NULL for a control arm), `placebo` whether the placebo curve applies, `dropout` whether people leave.
vcr_beta_logit_moments <- function(par, study, times, drug = NULL, placebo = TRUE, dropout = TRUE, n_gh = 16L, n_mmse = 12L, n_age = 10L) {
  cells <- .vcr_bl_cells(par, n_mmse, n_age)
  ref <- par[["reference"]]
  gh <- .vcr_bl_nodes("gh", n_gh)
  z <- sqrt(2) * gh$nodes; w2 <- as.vector(outer(gh$weights, gh$weights)) / pi
  z_eta <- rep(z, times = n_gh); z_alpha <- rep(z, each = n_gh)
  mu_eta <- study[["muEta"]] + par[["lambdaEta"]] * (cells$mmse - ref$bmmse)
  mu_alpha <- study[["muAlpha"]] + par[["lambdaMmse"]] * (cells$mmse - ref$bmmse) + par[["lambdaAge"]] * (cells$age - ref$age) +
    par[["lambdaApoe"]][cells$apoe + 1L] + par[["lambdaFemale"]] * cells$female
  hazard <- .vcr_bl_hazard(par, cells$age, cells$mmse, study[["omega"]])
  tau <- study[["tau"]]
  n_c <- nrow(cells); k <- length(w2)
  W <- cells$weight
  theta0 <- stats::plogis(matrix(mu_eta, n_c, k) + matrix(study[["sdEta"]] * z_eta, n_c, k, byrow = TRUE))
  s0 <- vcr_beta_logit_score_moments(theta0, tau); m0 <- s0$mean; v0 <- s0$var
  pbo <- if (isTRUE(placebo)) vcr_beta_logit_placebo(par, times) else numeric(length(times))
  sx <- if (is.null(drug)) numeric(length(times)) else drug[["symptomatic"]]
  on <- if (is.null(drug)) numeric(length(times)) else drug[["onDrug"]]
  fraction <- if (is.null(drug)) 0 else drug[["fraction"]]
  out <- lapply(seq_along(times), function(j) {
    t <- times[j]
    lin <- mu_eta + mu_alpha * (t - fraction * on[j]) + pbo[j] + sx[j]
    theta <- stats::plogis(matrix(lin, n_c, k) + matrix(study[["sdEta"]] * z_eta + study[["sdAlpha"]] * t * z_alpha, n_c, k, byrow = TRUE))
    st <- vcr_beta_logit_score_moments(theta, tau); mt <- st$mean; vt <- st$var
    e_y <- as.vector((mt %*% w2)); e_y2 <- as.vector((vt + mt^2) %*% w2)
    if (t == 0) { e_c <- numeric(n_c); e_c2 <- numeric(n_c) } else { d <- mt - m0; e_c <- as.vector(d %*% w2); e_c2 <- as.vector((d^2 + vt + v0) %*% w2) }
    stay <- if (isTRUE(dropout)) exp(-hazard * t^par[["weibullShape"]]) else rep(1, n_c)
    mean_y <- sum(W * e_y); mean_c <- sum(W * e_c)
    c(mean = mean_y, sd = sqrt(max(0, sum(W * e_y2) - mean_y^2)), change = mean_c, changeSd = sqrt(max(0, sum(W * e_c2) - mean_c^2)),
      observed = sum(W * stay), observedChange = sum(W * stay * e_c) / sum(W * stay))
  })
  m <- do.call(rbind, out)
  list(times = times, mean = m[, "mean"], sd = m[, "sd"], change = m[, "change"], changeSd = m[, "changeSd"], observed = m[, "observed"], observedChange = m[, "observedChange"])
}

# --- one simulated trial ---------------------------------------------------------------------------------------------------------------

#' The people of one simulated trial (control first, then treated) and their scores at baseline and at the analysis visit, with the time each
#' leaves. Draw order, fixed: the posterior row (posterior_draws only), the study (new_study and posterior_draws), then for all N people MMSE,
#' genotype, age, sex, intercept, slope, dropout time, the baseline score and the analysis visit's score.
.vcr_bl_people <- function(set, p) {
  row <- if (identical(p$uncertainty, "posterior_draws")) sample.int(nrow(set$draws), 1L) else 0L
  par <- if (row > 0L) vcr_beta_logit_par(set$draws[row, ], p$population) else p$par
  study <- if (identical(p$uncertainty, "typical_study")) vcr_beta_logit_typical_study(par) else vcr_beta_logit_new_study(par)
  n <- p$n0 + p$n1; ref <- par[["reference"]]
  mmse <- stats::runif(n, par[["mmse"]][1], par[["mmse"]][2])
  apoe <- sample.int(3L, n, replace = TRUE, prob = par[["apoe"]]) - 1L
  m <- par[["ageMean"]][apoe + 1L]; s <- par[["ageSd"]]
  u <- stats::runif(n)
  age <- if (is.null(par[["ageBounds"]])) stats::qnorm(u, m, s) else {
    lo <- stats::pnorm(par[["ageBounds"]][1], m, s); hi <- stats::pnorm(par[["ageBounds"]][2], m, s); stats::qnorm(lo + (hi - lo) * u, m, s)
  }
  female <- as.numeric(stats::runif(n) < par[["female"]])
  mu_alpha <- study[["muAlpha"]] + par[["lambdaMmse"]] * (mmse - ref$bmmse) + par[["lambdaAge"]] * (age - ref$age) + par[["lambdaApoe"]][apoe + 1L] + par[["lambdaFemale"]] * female
  eta <- stats::rnorm(n, study[["muEta"]] + par[["lambdaEta"]] * (mmse - ref$bmmse), study[["sdEta"]])
  alpha <- stats::rnorm(n, mu_alpha, study[["sdAlpha"]])
  hazard <- .vcr_bl_hazard(par, age, mmse, study[["omega"]])
  leaves <- stats::rweibull(n, par[["weibullShape"]], hazard^(-1 / par[["weibullShape"]]))
  treated <- rep(c(0, 1), c(p$n0, p$n1))
  ta <- p$visits[p$at]
  drug <- vcr_beta_logit_drug(p$treatment, ta)
  pbo <- if (isTRUE(p$placebo)) vcr_beta_logit_placebo(par, ta) else 0
  x_a <- eta + alpha * ta + pbo + treated * (drug$symptomatic - drug$fraction * mu_alpha * drug$onDrug)
  g <- .VCR_BETA_LOGIT_GUARD; tau <- study[["tau"]]
  th0 <- stats::plogis(eta); tha <- stats::plogis(x_a)
  y0 <- 70 * stats::rbeta(n, (th0 + g) * tau, (1 - th0 + g) * tau)
  ya <- 70 * stats::rbeta(n, (tha + g) * tau, (1 - tha + g) * tau)
  list(treated = treated, y0 = y0, ya = ya, leaves = leaves, latent = x_a, mmse = mmse, apoe = apoe, age = age, female = female, eta = eta, alpha = alpha,
       meanSlope = mu_alpha, study = study, row = row)
}

#' One simulated trial: whether the analysis rejects, its estimate (treated less control), and the people still observed per arm at each visit.
.vcr_bl_trial <- function(set, p) {
  pp <- .vcr_bl_people(set, p)
  visits <- p$visits; k <- length(visits)
  stay <- if (identical(p$dropout, "none")) matrix(TRUE, length(pp$y0), k) else outer(pp$leaves, visits, ">")
  observed <- c(colSums(stay[pp$treated == 0, , drop = FALSE]), colSums(stay[pp$treated == 1, , drop = FALSE]))
  keep <- stay[, p$at]
  change <- (pp$ya - pp$y0)[keep]; arm <- pp$treated[keep]; base <- pp$y0[keep]
  n_t <- sum(arm == 1); n_c <- sum(arm == 0)
  est <- NA_real_; t_stat <- NA_real_; df <- NA_real_
  if (identical(p$analysis, "ancova")) {
    if (n_t >= 2L && n_c >= 2L) {
      X <- cbind(1, arm, base); fit <- stats::lm.fit(X, change)
      df <- length(change) - 3L
      s2 <- sum(fit$residuals^2) / df
      se <- sqrt(s2 * chol2inv(qr.R(fit$qr))[2L, 2L])
      est <- unname(fit$coefficients[2L]); t_stat <- est / se
    }
  } else if (n_t >= 2L && n_c >= 2L) {
    w <- .vcr_welch(change[arm == 1], change[arm == 0])
    est <- mean(change[arm == 1]) - mean(change[arm == 0]); t_stat <- w$t; df <- w$df
  }
  reject <- if (is.na(t_stat)) 0 else {
    crit <- stats::qt(1 - p$alpha / 2, df)
    # benefit is a treated change below the control's (a higher ADAS-cog is worse); with no effect, either side is an error
    as.numeric(if (p$is_null) abs(t_stat) > crit else -t_stat > crit)
  }
  c(reject = reject, estimate = est, analysed = as.numeric(!is.na(t_stat)), row = pp$row, observed)
}

.vcr_bl_run <- function(set, p, want, seed, cores, cancel_file = NULL, batch = 500L, progress = NULL) {
  bank <- vcr_stream_bank(seed)
  done <- 0L; parts <- list(); stopped <- NULL
  while (done < want) {
    if (!is.null(cancel_file) && file.exists(cancel_file)) { stopped <- "canceled"; break }
    reason <- vcr_interrupt()
    if (!is.null(reason)) { stopped <- reason; break }
    take <- as.integer(min(batch, want - done))
    out <- vcr_map_streams(bank$take(take), function(i) .vcr_bl_trial(set, p), cores = cores, indices = done + seq_len(take))
    parts[[length(parts) + 1L]] <- do.call(rbind, out)
    done <- done + take
    if (!is.null(progress)) progress(done, want)
  }
  list(values = if (length(parts)) do.call(rbind, parts) else NULL, done = done, stopped = stopped)
}

# --- reading the scenario --------------------------------------------------------------------------------------------------------------

.vcr_bl_value <- function(x) if (is.null(x)) NULL else vcr_num(x[["value"]])

#' The population block: each override as a number or numbers, refused when it cannot describe people.
.vcr_bl_population <- function(pop) {
  pop <- pop %||% list()
  out <- list()
  bad <- function(field, detail) vcr_abort("scenario_value_invalid", paste0("scenario.population.", field), detail)
  r <- .vcr_bl_value(pop[["mmseRange"]])
  if (!is.null(r)) { if (length(r) != 2L || r[1] < 0 || r[2] > 30 || r[1] > r[2]) bad("mmseRange", "The MMSE range is two scores from 0 to 30, the lower first."); out$mmseRange <- r }
  b <- .vcr_bl_value(pop[["ageBounds"]])
  if (!is.null(b)) { if (length(b) != 2L || !all(is.finite(b)) || b[1] < 0 || !(b[2] > b[1])) bad("ageBounds", "The age bounds are two ages in years, the lower first and below the upper."); out$ageBounds <- b }
  a <- .vcr_bl_value(pop[["apoe4"]])
  if (!is.null(a)) { if (length(a) != 3L || any(a < 0) || abs(sum(a) - 1) > 1e-9) bad("apoe4", "The ApoE4 shares are three proportions (0, 1 and 2 alleles) that add up to 1."); out$apoe4 <- a }
  f <- .vcr_bl_value(pop[["femaleShare"]])
  if (!is.null(f)) { if (length(f) != 1L || f < 0 || f > 1) bad("femaleShare", "The share of women is a proportion from 0 to 1."); out$femaleShare <- f }
  m <- .vcr_bl_value(pop[["ageMeanByApoe4"]])
  if (!is.null(m)) { if (length(m) != 3L || any(!(m > 0))) bad("ageMeanByApoe4", "The mean ages are three ages in years (0, 1 and 2 ApoE4 alleles)."); out$ageMeanByApoe4 <- m }
  s <- .vcr_bl_value(pop[["ageSd"]])
  if (!is.null(s)) { if (length(s) != 1L || !(s > 0)) bad("ageSd", "The SD of age is a positive number of years."); out$ageSd <- s }
  out
}

#' The treatment block as the drug's numbers (`vcr_beta_logit_drug`'s `tr`), refused when it cannot be computed.
.vcr_bl_treatment <- function(tr, last_visit) {
  tr <- tr %||% list()
  begin <- vcr_scalar(tr[["doseBegin"]], 0); end <- vcr_scalar(tr[["doseEnd"]], last_visit)
  if (!(begin >= 0) || !(end > begin)) vcr_abort("scenario_value_invalid", "scenario.treatment.doseEnd", "The dose ends after it begins, and begins at week 0 or later.")
  out <- list(begin = begin, end = end, fraction = 0, emax = NULL, et50 = NULL, halfLife = NULL)
  sym <- tr[["symptomatic"]]
  if (!is.null(sym)) {
    et50 <- .vcr_bl_value(sym[["et50Weeks"]])
    if (length(et50) != 1L || !(et50 > 0)) vcr_abort("scenario_value_invalid", "scenario.treatment.symptomatic.et50Weeks", "The time to half the symptomatic effect is a positive number of weeks.")
    if (!is.null(sym[["pointsAt"]])) {
      pts <- .vcr_bl_value(sym[["pointsAt"]]); at <- vcr_scalar(sym[["atWeek"]]); ref <- vcr_scalar(sym[["referenceAdas"]])
      if (is.null(at) || !(at > 0)) vcr_abort("scenario_value_invalid", "scenario.treatment.symptomatic.atWeek", "The week the symptomatic effect is stated at is after week 0.")
      if (is.null(ref) || !(ref > 0 && ref < 70) || !(ref + pts > 0 && ref + pts < 70)) {
        vcr_abort("scenario_value_invalid", "scenario.treatment.symptomatic.referenceAdas", "The reference score and the score with the effect added both lie strictly between 0 and 70.")
      }
      out$emax <- vcr_beta_logit_emax_from_points(pts, at, ref, et50)
    } else {
      out$emax <- .vcr_bl_value(sym[["logitEmax"]])
    }
    if (length(out$emax) != 1L || !is.finite(out$emax)) vcr_abort("scenario_field_missing", "scenario.treatment.symptomatic.pointsAt", "A symptomatic effect is stated as pointsAt (with atWeek and referenceAdas) or as logitEmax.")
    out$et50 <- et50
    out$halfLife <- .vcr_bl_value(sym[["washoutHalfLifeWeeks"]])
    if (out$emax != 0 && end < last_visit && (length(out$halfLife) != 1L || !(out$halfLife > 0))) {
      vcr_abort("scenario_field_missing", "scenario.treatment.symptomatic.washoutHalfLifeWeeks", "The dose ends before the last visit: how fast the symptomatic effect fades after it (its half-life in weeks) is needed.")
    }
  }
  dm <- tr[["diseaseModifying"]]
  if (!is.null(dm)) out$fraction <- .vcr_bl_value(dm[["fraction"]]) %||% 0
  if (length(out$fraction) != 1L || !(out$fraction >= 0 && out$fraction < 1)) vcr_abort("scenario_value_invalid", "scenario.treatment.diseaseModifying.fraction", "The disease-modifying share is at least 0 and below 1.")
  out
}

# --- the handler ----------------------------------------------------------------------------------------------------------------------------

vcr_job_patients_progression_beta_logit <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  sc <- job[["scenario"]]; model <- sc[["model"]]
  ps <- model[["parameterSet"]] %||% list()
  set <- vcr_beta_logit_parameter_set(as.character(ps[["id"]] %||% ""), as.character(ps[["version"]] %||% ""))
  time_unit <- as.character(sc[["timeUnit"]] %||% "")
  if (!identical(time_unit, set$timeUnit)) {
    vcr_abort("scenario_value_invalid", "scenario.timeUnit", sprintf("The beta_logit family runs in weeks, the unit its parameters were estimated in; \"%s\" is not converted.", time_unit))
  }
  visits <- vcr_num(sc[["visits"]])
  if (!identical(as.numeric(visits[1L]), 0)) vcr_abort("scenario_value_invalid", "scenario.visits", "The first visit is week 0, the baseline the change is counted from.")
  uncertainty <- as.character(model[["uncertainty"]] %||% "new_study")
  if (!(uncertainty %in% .VCR_BETA_LOGIT_UNCERTAINTY)) vcr_abort("scenario_value_invalid", "scenario.model.uncertainty", "The uncertainty is new_study, typical_study or posterior_draws.")
  an <- sc[["analysis"]] %||% list(); kind <- as.character(an[["kind"]] %||% "change"); alpha <- vcr_scalar(an[["alpha"]], 0.05)
  if (!(kind %in% c("change", "ancova"))) vcr_abort("scenario_value_invalid", "scenario.analysis.kind", "The beta_logit family is analysed by the change from baseline or by an analysis of covariance; a per-person slope is the other families'.")
  at_time <- vcr_scalar(an[["visit"]], max(visits))
  at <- match(TRUE, abs(visits - at_time) < 1e-9)
  if (is.na(at) || at < 2L) vcr_abort("scenario_value_invalid", "scenario.analysis.visit", "The analysis visit is one of the scheduled visits after the first.")
  population <- .vcr_bl_population(sc[["population"]])
  treatment <- .vcr_bl_treatment(sc[["treatment"]], max(visits))
  placebo <- !identical(sc[["placebo"]], FALSE)
  dropout <- as.character(sc[["dropoutModel"]] %||% "parameter_set")
  par <- vcr_beta_logit_par(set$medians, population)
  is_null <- !(isTRUE(abs(treatment$emax %||% 0) > 0) || isTRUE(treatment$fraction > 0))
  p <- list(par = par, population = population, uncertainty = uncertainty, visits = visits, at = at, n1 = as.integer(sc[["design"]][["nTreat"]]),
            n0 = as.integer(sc[["design"]][["nControl"]]), alpha = alpha, is_null = is_null, analysis = kind, treatment = treatment, placebo = placebo, dropout = dropout)
  floor_ <- as.integer(vcr_replicate_floor(is_null))
  want <- as.integer(min(max(floor_, vcr_scalar(job[["replicates"]], 0L)), vcr_max_replicates()))
  cores <- vcr_cores(job[["cores"]]); seed <- vcr_scalar(job[["seed"]], 1)
  unit <- as.character(set$endpoint[["unit"]])

  # the calculated curves: the typical study at the posterior medians
  study <- vcr_beta_logit_typical_study(par)
  drug <- vcr_beta_logit_drug(treatment, visits)
  ctl <- vcr_beta_logit_moments(par, study, visits, NULL, placebo, !identical(dropout, "none"))
  trt <- vcr_beta_logit_moments(par, study, visits, drug, placebo, !identical(dropout, "none"))
  calc <- function(name, value, note = NULL) vcr_measure(name, value, source = "calculated", unit = unit, note = note)
  share <- function(name, value) vcr_measure(name, value, source = "calculated")
  curves <- lapply(seq_along(visits), function(j) list(
    visit = visits[j], timeUnit = time_unit,
    control = list(mean = calc("curve_mean", ctl$mean[j]), sd = calc("curve_sd", ctl$sd[j])),
    treated = list(mean = calc("curve_mean", trt$mean[j]), sd = calc("curve_sd", trt$sd[j])),
    change = list(control = calc("curve_change", ctl$change[j]), treated = calc("curve_change", trt$change[j])),
    changeSd = list(control = calc("curve_change_sd", ctl$changeSd[j]), treated = calc("curve_change_sd", trt$changeSd[j])),
    observedShare = share("curve_observed_share", ctl$observed[j]),
    observedChange = list(control = calc("curve_observed_change", ctl$observedChange[j]), treated = calc("curve_observed_change", trt$observedChange[j]))))

  run <- .vcr_bl_run(set, p, want, as.integer(as.numeric(seed) %% 2147483647), cores, cancel_file, progress = progress)
  v <- run$values
  if ((is.null(v) || !nrow(v)) && identical(run$stopped, "canceled")) return(.vcr_interrupted_result("canceled", "no trial was run"))
  if (is.null(v) || !nrow(v)) vcr_abort("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the first batch of trials; there is no result.")
  done <- nrow(v); q <- mean(v[, "reject"]); s <- vcr_mcse_proportion(q, done)
  power <- vcr_measure(if (is_null) "type_one_error" else "power", q, simulated = TRUE, mcse = s, source = "synthetic",
                       interval = vcr_interval("monte_carlo", max(0, q - 1.96 * s), min(1, q + 1.96 * s)))
  est <- v[v[, "analysed"] == 1, "estimate"]
  sim_diff <- if (length(est) >= 2L) vcr_measure("simulated_difference", mean(est), simulated = TRUE, mcse = stats::sd(est) / sqrt(length(est)), source = "synthetic", unit = unit,
                                               note = "the mean over the simulated trials of the analysis's estimate, treated less control, among the people observed at the analysis visit") else NULL
  k <- length(visits)
  observed <- lapply(seq_len(k), function(j) {
    oc <- v[, 4L + j]; ot <- v[, 4L + k + j]
    list(visit = visits[j], control = vcr_measure("observed_people", mean(oc), simulated = TRUE, mcse = stats::sd(oc) / sqrt(done), source = "synthetic"),
         treated = vcr_measure("observed_people", mean(ot), simulated = TRUE, mcse = stats::sd(ot) / sqrt(done), source = "synthetic"))
  })
  measures <- c(list(power,
                     calc("expected_difference", trt$observedChange[at] - ctl$observedChange[at], note = "treated less control change from baseline at the analysis visit, among the people still observed, in a typical study at the posterior medians"),
                     calc("expected_control_change", ctl$observedChange[at]), calc("expected_treated_change", trt$observedChange[at])),
                if (!is.null(sim_diff)) list(sim_diff))
  issues <- list(); stopped <- run$stopped
  if (identical(stopped, "cpu_budget")) issues <- list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before every trial ran; the power uses the trials that finished."))
  status <- if (identical(stopped, "canceled")) "canceled" else if (identical(stopped, "cpu_budget")) "failed" else "succeeded"

  given <- list()
  add <- function(key, x, extra = list()) if (!is.null(x)) given[[length(given) + 1L]] <<- c(list(key = key, value = vcr_num(x[["value"]]), basis = as.character(x[["basis"]]), citation = x[["citation"]]), extra)
  sym <- sc[["treatment"]][["symptomatic"]]
  if (!is.null(sym)) {
    add("treatment.symptomatic.pointsAt", sym[["pointsAt"]], list(atWeek = vcr_scalar(sym[["atWeek"]]), referenceAdas = vcr_scalar(sym[["referenceAdas"]])))
    add("treatment.symptomatic.logitEmax", sym[["logitEmax"]]); add("treatment.symptomatic.et50Weeks", sym[["et50Weeks"]])
    add("treatment.symptomatic.washoutHalfLifeWeeks", sym[["washoutHalfLifeWeeks"]])
  }
  add("treatment.diseaseModifying.fraction", sc[["treatment"]][["diseaseModifying"]][["fraction"]])
  for (key in c("mmseRange", "ageBounds", "apoe4", "femaleShare", "ageMeanByApoe4", "ageSd")) add(paste0("population.", key), sc[["population"]][[key]])
  assumed <- list()
  assume <- function(key, value, basis) assumed[[length(assumed) + 1L]] <<- list(key = key, value = value, basis = basis)
  if (is.null(population$mmseRange)) assume("population.mmseRange", c(16, 26), "default: baseline MMSE drawn uniformly from 16 to 26, the parameter set's own entry range")
  if (is.null(population$apoe4) || is.null(population$femaleShare) || is.null(population$ageMeanByApoe4) || is.null(population$ageSd)) {
    assume("population.covariates", c(par$apoe, par$female, par$ageMean, par$ageSd), "default: ApoE4 alleles, sex and age by genotype from the parameter set's covariate model at its medians")
  }
  if (is.null(model[["uncertainty"]])) assume("model.uncertainty", uncertainty, "default: one new study drawn per simulated trial")
  if (is.null(sc[["placebo"]])) assume("placebo", TRUE, "default: the placebo response applies to every arm from week 0")
  if (is.null(sc[["dropoutModel"]])) assume("dropoutModel", dropout, "default: the parameter set's dropout model (age and MMSE, not arm or outcome)")
  if (!is_null && is.null(sc[["treatment"]][["doseBegin"]])) assume("treatment.doseBegin", treatment$begin, "default: dosing from week 0")
  if (!is_null && is.null(sc[["treatment"]][["doseEnd"]])) assume("treatment.doseEnd", treatment$end, "default: dosing to the last visit")
  if (is.null(an[["alpha"]])) assume("analysis.alpha", 0.05, "default: two-sided 5%")
  if (is.null(an[["visit"]])) assume("analysis.visit", at_time, "default: the last scheduled visit")
  if (is.null(an[["kind"]])) assume("analysis.kind", kind, "default: the change from baseline")
  if (is.null(job[["replicates"]])) assume("trials", want, if (is_null) "default: the null-scenario floor of simulated trials" else "default: the floor of simulated trials under an alternative")
  beyond <- max(visits) > .VCR_BETA_LOGIT_DATA_WEEKS
  src <- set$source
  limits <- c(list(
    "Population level: the curves are what a group does on average and how widely people scatter around it, not a prediction for a person.",
    "The drug effect is the researcher's stated hypothesis, converted into the model's terms; it is not a prediction for any compound.",
    "The parameters are the 2013 CAMD estimates released with adsim 3.0 (posterior draws, not re-estimated). With them the engine reproduces the EMA qualification opinion 2013 Tables 7, 9 and 11, not Table 10's intervals or Figures 15 and 16.",
    "The FDA letter (2013-06-12) and the EMA qualification opinion (adopted 2013-09-19) concern the original tool in its context of use; no regulatory status transfers to this implementation.",
    "Context of the model: mild and moderate Alzheimer disease, ADAS-cog 11 (0 to 70, higher is worse), trials of up to two years."),
    if (beyond) list(sprintf("The last visit is week %s, beyond the two years the model's data support: that part is an extrapolation.", format(max(visits)))))
  list(status = status, measures = measures, issues = issues, counts = vcr_counts(generatedRecords = done * (p$n1 + p$n0)),
       conclusion = "limited",
       diagnostics = list(replicatesCompleted = done, progression = list(
         family = "beta_logit", curves = curves, calculatedFor = "typical_study", isNull = is_null, trials = done, trialsRequested = want, outcomeUnit = unit,
         endpoint = list(name = set$endpoint[["name"]], min = set$endpoint[["min"]], max = set$endpoint[["max"]]),
         parameterSet = list(id = set$id, version = set$version, artifact = src[["artifact"]], url = src[["url"]], archiveSha1 = src[["archiveSha1"]],
                             archiveSha256 = src[["archiveSha256"]], sourceSha256 = src[["sourceSha256"]], fileSha256 = set$fileSha256, draws = nrow(set$draws),
                             publication = src[["publication"]]),
         uncertainty = uncertainty, placebo = placebo, dropoutModel = dropout,
         analysis = list(kind = kind, visit = at_time, alpha = alpha, firstVisit = visits[1L]),
         treatment = list(symptomaticLogitEmax = treatment$emax %||% 0, et50Weeks = treatment$et50, washoutHalfLifeWeeks = treatment$halfLife,
                          diseaseModifyingFraction = treatment$fraction, doseBegin = treatment$begin, doseEnd = treatment$end),
         population = list(mmseRange = par$mmse, ageBounds = par$ageBounds, apoe4 = par$apoe, femaleShare = par$female, ageMeanByApoe4 = par$ageMean, ageSd = par$ageSd),
         observed = observed, trialsAnalysed = length(est), posteriorRowsUsed = length(unique(v[v[, "row"] > 0, "row"])),
         extrapolation = list(dataWeeks = .VCR_BETA_LOGIT_DATA_WEEKS, lastVisit = max(visits), beyond = beyond),
         reproduction = list(reproduced = c("EMA qualification opinion 2013 Table 7", "EMA qualification opinion 2013 Table 9", "EMA qualification opinion 2013 Table 11"),
                             notReproduced = c("EMA qualification opinion 2013 Table 10 intervals", "EMA qualification opinion 2013 Figures 15 and 16")),
         given = given, assumed = assumed, populationLevel = TRUE, limits = limits)))
}
