# ---------------------------------------------------------------------------
# patients_progression_intercurrent.R — intercurrent events and estimators aligned to the estimand, for the beta_logit family of `patients.progression`
# (plan R26, 2026-11-09): treatment discontinuation with an arm-dependent hazard, off-treatment follow-up, study withdrawal, death; completers and
# ANCOVA kept, an MMRM (unstructured, visit x arm and visit x baseline) and reference-based conditional-mean imputation; and the true value of each
# estimand computed from the data-generating process, so a result reports bias, coverage and power against the estimand it claims.
#
# Hidden knowledge:
#
# - **Nothing here runs unless the scenario asks.** A scenario with no `intercurrent` block and an analysis of `change` or `ancova` takes the
#   family's own trial (`.vcr_bl_trial`) to the bit; this file is the trial for everything else (`.vcr_bl_trial_ice`). It draws the people with the
#   family's own `.vcr_bl_people` (the same stream, so the same people), then its own draws in a fixed order: discontinuation, retrieval, death, the
#   scores at every visit.
# - **The off-treatment path needs no new biology.** A person who stops at week d takes the drug's terms of the family with the dose ending at d: the
#   symptomatic effect fades with the stated half-life from d, the disease-modifying share (a fraction of that person's own slope times the time
#   on drug) is held. A discontinuation before the dose begins is a person who never took it.
# - **The two estimands whose truth is computed.** *Treatment policy*: everyone is followed to the analysis visit whatever happened, nobody withdraws,
#   and a discontinuation changes only the drug's path. *Hypothetical*: nobody discontinues (the drug runs to its end). Both are the mean over the
#   people of the typical study at the posterior medians of the exact expected score (the beta mean, 70 (theta + g) / (1 + 2 g), a closed form,
#   no residual noise) treated less control, the same person in both arms; the number is a Monte Carlo over people with its own stream and its own
#   MCSE. A death is scored as the worst value, 70, from the day it happens (a composite), in every truth and every analysis.
# - **What an estimator uses.** `analysis.data` is `all_observed` (every value that exists, including those collected after a discontinuation: the
#   treatment-policy data) or `on_treatment` (values after the person stopped are discarded: the hypothetical data). MMRM is the unstructured model
#   change ~ visit + visit:arm + visit:baseline fitted by maximum likelihood; with monotone missing data the likelihood factors into one
#   regression per visit on the earlier visits and the answer is closed (the fast path, deterministic, used inside the simulation); non-monotone
#   data go through `nlme::gls` (REML). The two are the same estimator (ML against ML on the same data to 1e-4 in the numeric cases; REML differs
#   from ML by degrees of freedom only). Conditional-mean imputation (Wolbers et al. 2022) fits that model on the pre-event data, replaces what
#   is missing by its conditional mean under the strategy's mean (jump to reference: the person's own arm up to the last visit on treatment and the
#   reference's after; copy reference: the reference's throughout) and analyses the completed change at the analysis visit by ANCOVA. The standard
#   error is a delete-a-group jackknife of the whole procedure (a variance that is right for a reference-based estimand; the model-based one is
#   information-anchored, not a frequentist SE), `jackknifeGroups` groups, t with G - 1 degrees of freedom.
# - **Which estimand an estimator answers is not code's guess in the engine.** The result carries the truth of both strategies and the estimator's
#   bias and 95% interval coverage against each; whether the analysis answers what the research question asked is the domain's table
#   (`vcrEstimandAlignment`), and the numbers here are what that table is held to.
# - **A tipping-point delta is a number added to what is imputed for the treated arm** (`analysis.delta`, points, positive worse) and, in the
#   data-generating model, `intercurrent.offTreatment.reboundLogit` (a shift on the logit scale added to a treated person's latent value from the
#   day they stop). `vcr_cmi_tipping` finds the delta at which a result stops being significant.
# - **Stated limits.** One death hazard for both arms; intermittent missing visits are not generated (only the MMRM's `gls` path reads them);
#   discontinuation depends on the latent slope only through a person-level standardized deviation; the truth is for the typical study, so a
#   run that draws a new study per trial is compared with it up to the logistic curvature.
# ---------------------------------------------------------------------------

.VCR_ICE_KINDS <- c("mmrm", "cmi_jump_to_reference", "cmi_copy_reference")
.VCR_ICE_TRUTH_PEOPLE <- 20000L

# --- reading the scenario ----------------------------------------------------------------------------------------------------------------

#' The `intercurrent` block as the engine's numbers (NULL when absent).
.vcr_ice_read <- function(ic, horizon) {
  if (is.null(ic)) return(NULL)
  bad <- function(field, detail) vcr_abort("scenario_value_invalid", paste0("scenario.intercurrent.", field), detail)
  share <- function(x, field, strict = TRUE) {
    v <- .vcr_bl_value(x)
    if (length(v) != 1L || !is.finite(v) || v < 0 || (strict && v >= 1)) bad(field, "A share is a proportion from 0 up to, not including, 1.")
    v
  }
  out <- list(discontinuation = NULL, withdrawal = list(treatedHazardRatio = 1, progressionLogHazardPerSd = 0), death = NULL, offTreatment = list(reboundLogit = 0))
  d <- ic[["discontinuation"]]
  if (!is.null(d)) {
    sc <- share(d[["shareControl"]], "discontinuation.shareControl"); st <- share(d[["shareTreated"]], "discontinuation.shareTreated")
    gam <- if (is.null(d[["progressionLogHazardPerSd"]])) 0 else .vcr_bl_value(d[["progressionLogHazardPerSd"]])
    if (length(gam) != 1L || !is.finite(gam)) bad("discontinuation.progressionLogHazardPerSd", "The change in the log hazard of stopping per SD of the person's own slope is a number.")
    ret <- share(d[["retrievedShare"]], "discontinuation.retrievedShare", strict = FALSE)
    if (ret > 1) bad("discontinuation.retrievedShare", "The share of people who stop the drug and stay in the study is a proportion from 0 to 1.")
    out$discontinuation <- list(rate = c(control = -log1p(-sc) / horizon, treated = -log1p(-st) / horizon), shares = c(control = sc, treated = st), gamma = gam, retrieved = ret)
  }
  w <- ic[["withdrawal"]]
  if (!is.null(w)) {
    hr <- if (is.null(w[["treatedHazardRatio"]])) 1 else .vcr_bl_value(w[["treatedHazardRatio"]])
    if (length(hr) != 1L || !is.finite(hr) || !(hr > 0)) bad("withdrawal.treatedHazardRatio", "The hazard ratio of leaving the study, treated against control, is positive.")
    gw <- if (is.null(w[["progressionLogHazardPerSd"]])) 0 else .vcr_bl_value(w[["progressionLogHazardPerSd"]])
    if (length(gw) != 1L || !is.finite(gw)) bad("withdrawal.progressionLogHazardPerSd", "The change in the log hazard of leaving per SD of the person's own slope is a number.")
    out$withdrawal <- list(treatedHazardRatio = hr, progressionLogHazardPerSd = gw)
  }
  dt <- ic[["death"]]
  if (!is.null(dt)) { s <- share(dt[["share"]], "death.share"); out$death <- list(rate = -log1p(-s) / horizon, share = s) }
  ot <- ic[["offTreatment"]]
  if (!is.null(ot) && !is.null(ot[["reboundLogit"]])) {
    rb <- .vcr_bl_value(ot[["reboundLogit"]])
    if (length(rb) != 1L || !is.finite(rb)) bad("offTreatment.reboundLogit", "The shift on the logit scale after stopping is a number.")
    out$offTreatment$reboundLogit <- rb
  }
  out
}

#' The analysis as the engine reads it: the estimator, the data it uses, the CMI delta and the jackknife groups.
.vcr_ice_analysis <- function(an) {
  kind <- as.character(an[["kind"]] %||% "change")
  data <- as.character(an[["data"]] %||% "all_observed")
  if (!(data %in% c("all_observed", "on_treatment"))) vcr_abort("scenario_value_invalid", "scenario.analysis.data", "The analysis uses all_observed values or on_treatment values.")
  delta <- if (is.null(an[["delta"]])) 0 else .vcr_bl_value(an[["delta"]])
  if (length(delta) != 1L || !is.finite(delta)) vcr_abort("scenario_value_invalid", "scenario.analysis.delta", "The delta added to what is imputed for the treated arm is a number of points.")
  groups <- as.integer(vcr_scalar(an[["jackknifeGroups"]], 10L))
  if (!is.finite(groups) || groups < 5L || groups > 100L) vcr_abort("scenario_value_invalid", "scenario.analysis.jackknifeGroups", "The jackknife has between 5 and 100 groups.")
  list(kind = kind, data = data, delta = delta, groups = groups)
}

# --- the drug of one person ------------------------------------------------------------------------------------------------------------------

#' The drug's two terms (`vcr_beta_logit_drug`) at the times `t` for people whose dose ends at `end` (a vector): matrices, one row per person.
.vcr_ice_drug <- function(tr, t, end) {
  begin <- tr[["begin"]]; n <- length(end); k <- length(t)
  span <- pmax(end - begin, 0)
  on <- pmin(pmax(outer(rep(1, n), t) - begin, 0), matrix(span, n, k))
  sx <- matrix(0, n, k)
  if (!is.null(tr[["emax"]]) && tr[["emax"]] != 0) {
    sx <- tr[["emax"]] * on / (tr[["et50"]] + on)
    after <- outer(rep(1, n), t) > matrix(end, n, k)
    if (any(after)) {
      hl <- tr[["halfLife"]]
      fade <- tr[["emax"]] * span / (tr[["et50"]] + span)
      faded <- matrix(fade, n, k) * exp(-log(2) * (outer(rep(1, n), t) - matrix(end, n, k)) / hl)
      sx[after] <- faded[after]
    }
  }
  list(symptomatic = sx, onDrug = on)
}

#' The latent value on the logit scale of every person at every time in `visits` (a matrix n x k), the treated people taking the drug until `end`
#' (their own stop time, at most the dose's end) and the treated person's rebound after stopping.
.vcr_ice_latent <- function(par, q, treated, tr, visits, end, rebound = 0, placebo = TRUE) {
  k <- length(visits); n <- length(q$eta)
  pbo <- if (isTRUE(placebo)) vcr_beta_logit_placebo(par, visits) else numeric(k)
  dr <- .vcr_ice_drug(tr, visits, end)
  drug <- dr$symptomatic - (tr[["fraction"]] %||% 0) * q$meanSlope * dr$onDrug
  after <- outer(rep(1, n), visits) > matrix(end, n, k)
  base <- matrix(q$eta, n, k) + outer(q$alpha, visits) + matrix(pbo, n, k, byrow = TRUE)
  base + matrix(treated, n, k) * (drug + rebound * (after & is.finite(matrix(end, n, k)) & matrix(end, n, k) < tr[["end"]]))
}

# --- the trial ---------------------------------------------------------------------------------------------------------------------------

#' Per person: when they stop the drug, whether they stay in the study after it, when they leave and when they die. Draw order: U (stop), U
#' (retrieved), U (death). `z` is the person's standardized deviation from the covariate-adjusted mean slope.
.vcr_ice_events <- function(ice, par, pp, treated, tr_end, n) {
  z <- (pp$alpha - pp$meanSlope) / pp$study[["sdAlpha"]]
  stop_t <- rep(Inf, n); retrieved <- rep(TRUE, n)
  d <- ice$discontinuation
  u_stop <- stats::runif(n); u_ret <- stats::runif(n)
  if (!is.null(d)) {
    rate <- ifelse(treated == 1, d$rate[["treated"]], d$rate[["control"]]) * exp(d$gamma * z - d$gamma^2 / 2)
    stop_t <- ifelse(rate > 0, -log(u_stop) / rate, Inf)
    retrieved <- u_ret < d$retrieved
  }
  u_death <- stats::runif(n)
  death_t <- if (is.null(ice$death)) rep(Inf, n) else -log(u_death) / ice$death$rate
  w <- ice$withdrawal
  leaves <- pp$leaves
  mult <- exp(log(w$treatedHazardRatio) * treated + w$progressionLogHazardPerSd * z)
  leaves <- leaves * mult^(-1 / par[["weibullShape"]])
  list(stop = stop_t, retrievedAfterStop = retrieved, leaves = leaves, death = death_t, z = z)
}

#' One simulated trial of the intercurrent-event path.
.vcr_bl_trial_ice <- function(set, p, pp, eff) {
  ice <- p$ice; an <- p$ia
  n <- length(pp$y0); visits <- p$visits; k <- length(visits)
  par <- if (pp$row > 0L) vcr_beta_logit_par(set$draws[pp$row, ], p$population) else p$par
  tr <- p$treatment
  treated <- pp$treated
  q <- list(eta = pp$eta, alpha = pp$alpha, meanSlope = pp$meanSlope)
  ev <- .vcr_ice_events(ice, par, pp, treated, tr$end, n)
  end <- ifelse(treated == 1, pmin(tr$end, ev$stop), tr$end)
  lat <- .vcr_ice_latent(par, q, treated, tr, visits, end, ice$offTreatment$reboundLogit, p$placebo)
  th <- stats::plogis(lat)
  tau <- pp$study[["tau"]]
  g <- .VCR_BETA_LOGIT_GUARD
  y <- matrix(0, n, k)
  y[, 1L] <- pp$y0
  for (j in 2:k) {
    x <- stats::rgamma(n, (th[, j] + g) * tau); yy <- stats::rgamma(n, (1 - th[, j] + g) * tau)
    s <- x + yy; v <- x / s; v[!(s > 0)] <- th[!(s > 0), j]
    y[, j] <- 70 * v
  }
  vis <- matrix(visits, n, k, byrow = TRUE)
  dead <- vis >= matrix(ev$death, n, k)
  y[dead] <- 70
  # observed: still in the study at the visit (the non-retrieved leave the day they stop)
  exit <- pmin(ev$leaves, ifelse(ev$retrievedAfterStop, Inf, ev$stop))
  if (identical(p$dropout, "none")) exit <- ifelse(ev$retrievedAfterStop, Inf, ev$stop)
  stay <- vis < matrix(exit, n, k)
  stay[, 1L] <- TRUE
  on_t <- vis < matrix(ev$stop, n, k)
  use <- if (identical(an$data, "on_treatment")) stay & on_t else stay
  use[, 1L] <- TRUE
  observed <- c(colSums(stay[treated == 0, , drop = FALSE]), colSums(stay[treated == 1, , drop = FALSE]))
  at <- p$at
  fit <- .vcr_ice_estimate(an, y, use, on_t, treated, at)
  est <- fit$estimate; se <- fit$se; df <- fit$df
  ok <- is.finite(est) && is.finite(se) && se > 0 && is.finite(df) && df > 0
  t_stat <- if (ok) est / se else NA_real_
  reject <- if (!ok) 0 else {
    crit <- stats::qt(1 - p$alpha / 2, df)
    as.numeric(if (p$is_null) abs(t_stat) > crit else -t_stat > crit)
  }
  half <- if (ok) stats::qt(0.975, df) * se else NA_real_
  cover <- function(truth) if (ok) as.numeric(est - half <= truth && truth <= est + half) else NA_real_
  share_stop <- c(mean(ev$stop[treated == 0] <= max(visits)), mean(ev$stop[treated == 1] <= max(visits)))
  c(reject = reject, estimate = est, analysed = as.numeric(ok), row = pp$row, observed,
    if (!is.null(eff)) stats::setNames(eff, c("pts", "frac", "triesPts", "triesFrac")),
    se = se, coverTP = cover(p$truth$treatment_policy$value), coverHyp = cover(p$truth$hypothetical$value),
    stopControl = share_stop[1], stopTreated = share_stop[2],
    withdrewControl = mean(exit[treated == 0] <= max(visits)), withdrewTreated = mean(exit[treated == 1] <= max(visits)),
    diedControl = mean(ev$death[treated == 0] <= max(visits)), diedTreated = mean(ev$death[treated == 1] <= max(visits)))
}

# --- the handler's side ----------------------------------------------------------------------------------------------------------------------

#' Adds to the family's scenario reading what this file runs: the events, the analysis and the true value of both estimands. Refuses what it cannot
#' run (a table of people, a distributed effect: there is no single truth to compare with) and a stop that needs a fade-out time nobody gave.
.vcr_ice_prepare <- function(p, sc, an, kind, last_visit, distributed, record, seed) {
  bad <- function(field, detail) vcr_abort("scenario_value_invalid", field, detail)
  if (!is.null(record)) bad("scenario.people", "A run on a people table has no intercurrent events or MMRM analysis in this version: state the population instead.")
  if (distributed) bad("scenario.treatment", "An effect stated as a distribution has no single true value to compare an estimator with; state the effect as a number to run intercurrent events.")
  ice <- .vcr_ice_read(sc[["intercurrent"]] %||% list(), last_visit)
  tr <- p$treatment
  if (!is.null(ice$discontinuation) && isTRUE(abs(tr$emax %||% 0) > 0) && !(length(tr$halfLife) == 1L && tr$halfLife > 0)) {
    vcr_abort("scenario_field_missing", "scenario.treatment.symptomatic.washoutHalfLifeWeeks", "A person who stops the drug keeps a fading symptomatic effect: how fast it fades (its half-life in weeks) is needed.")
  }
  an2 <- an; if (is.null(an2[["data"]])) an2[["data"]] <- if (kind %in% c("cmi_jump_to_reference", "cmi_copy_reference")) "on_treatment" else "all_observed"
  p$ice <- ice; p$ia <- .vcr_ice_analysis(an2)
  p$claimed <- if (is.null(sc[["estimand"]][["strategy"]])) NULL else as.character(sc[["estimand"]][["strategy"]])
  p$truth <- vcr_ice_truth(p, (seed + 7919L) %% 2147483647L)
  p
}

#' The truth, bias and coverage of the strategy the scenario claims, as measures (nothing when it claims none).
.vcr_ice_claimed_measures <- function(rep) {
  if (is.null(rep$claimed)) return(NULL)
  row <- Filter(function(r) identical(r$strategy, rep$claimed), rep$estimands)
  if (!length(row)) return(NULL)
  Filter(Negate(is.null), list(row[[1L]]$truth, row[[1L]]$bias, row[[1L]]$coverage))
}

.vcr_ice_limits <- function(p) {
  c("The curves and the expected differences are the typical study without the stated intercurrent events; the simulated trials and the estimand table carry them.",
    "The true value of each estimand is computed from the data-generating process at the typical study; a trial drawn from a new study per run differs from it by the logistic curvature.",
    if (!is.null(p$ice$death)) "A death is scored as the worst value, 70, from the day it happens, in every truth and every analysis: a composite, not a choice of this run.",
    "An estimator estimates one estimand: treatment-policy data answer the treatment-policy truth, on-treatment data and an MMRM answer the hypothetical one, and a reference-based imputation answers neither exactly; the bias against each is in the result.")
}

#' The stated numbers of the intercurrent block as `given` rows (each with its basis).
.vcr_ice_given <- function(sc, an) {
  ic <- sc[["intercurrent"]]; out <- list()
  add <- function(key, x) if (!is.null(x) && !is.null(x[["value"]])) out[[length(out) + 1L]] <<- list(key = key, value = vcr_num(x[["value"]]), basis = as.character(x[["basis"]]), citation = x[["citation"]])
  for (k in c("shareControl", "shareTreated", "progressionLogHazardPerSd", "retrievedShare")) add(paste0("intercurrent.discontinuation.", k), ic[["discontinuation"]][[k]])
  for (k in c("treatedHazardRatio", "progressionLogHazardPerSd")) add(paste0("intercurrent.withdrawal.", k), ic[["withdrawal"]][[k]])
  add("intercurrent.death.share", ic[["death"]][["share"]]); add("intercurrent.offTreatment.reboundLogit", ic[["offTreatment"]][["reboundLogit"]])
  add("analysis.delta", an[["delta"]])
  out
}

.vcr_ice_assumed <- function(p, sc, an) {
  out <- list()
  if (is.null(an[["data"]])) out[[1L]] <- list(key = "analysis.data", value = p$ia$data, basis = if (identical(p$ia$data, "on_treatment")) "default: a reference-based imputation reads the values collected while on treatment" else "default: every value that exists is used, whatever the person was taking")
  if (p$ia$kind %in% c("cmi_jump_to_reference", "cmi_copy_reference") && is.null(an[["jackknifeGroups"]])) out[[length(out) + 1L]] <- list(key = "analysis.jackknifeGroups", value = p$ia$groups, basis = "default: a delete-a-group jackknife of 10 groups gives the standard error")
  out
}

# --- the estimators ------------------------------------------------------------------------------------------------------------------------

#' The estimate of the treated-less-control difference in the mean change at visit `at` (and its standard error and degrees of freedom) by the
#' analysis `an`. `y` is the n x k score matrix, `use` the values the analysis may use, `on_t` whether the person was on treatment at each visit.
.vcr_ice_estimate <- function(an, y, use, on_t, treated, at) {
  chg <- (y - y[, 1L])[, 2:at, drop = FALSE]
  mask <- use[, 2:at, drop = FALSE]
  base <- y[, 1L]
  kind <- an$kind
  none <- list(estimate = NA_real_, se = NA_real_, df = NA_real_)
  if (kind %in% c("change", "ancova")) {
    obs <- mask[, ncol(mask)]
    ch <- chg[obs, ncol(chg)]; arm <- treated[obs]; b <- base[obs]
    if (sum(arm == 1) < 2L || sum(arm == 0) < 2L) return(none)
    if (identical(kind, "ancova")) {
      X <- cbind(1, arm, b); f <- stats::lm.fit(X, ch); df <- length(ch) - 3L
      se <- sqrt(sum(f$residuals^2) / df * chol2inv(qr.R(f$qr))[2L, 2L])
      return(list(estimate = unname(f$coefficients[2L]), se = se, df = df))
    }
    w <- .vcr_welch(ch[arm == 1], ch[arm == 0])
    return(list(estimate = mean(ch[arm == 1]) - mean(ch[arm == 0]), se = abs(mean(ch[arm == 1]) - mean(ch[arm == 0])) / abs(w$t), df = w$df))
  }
  if (identical(kind, "mmrm")) {
    f <- vcr_mmrm_fit(chg, mask, treated, base, method = "auto")
    if (is.null(f)) return(none)
    return(list(estimate = f$effect[ncol(chg)], se = f$se[ncol(chg)], df = f$df))
  }
  ref <- if (identical(kind, "cmi_copy_reference")) "copy" else "jump"
  # the last visit on treatment (0: never took a visit on treatment), a person who never stopped has the last visit
  ice_visit <- vapply(seq_len(nrow(chg)), function(i) sum(on_t[i, 2:at]), numeric(1))
  stopped <- ice_visit < ncol(chg)
  vcr_cmi_jackknife(chg, mask, treated, base, ice_visit = ifelse(stopped, ice_visit, Inf), reference = ref, delta = an$delta, groups = an$groups)
}

# --- MMRM -----------------------------------------------------------------------------------------------------------------------------------

#' The unstructured MMRM  change ~ 0 + visit + visit:arm + visit:baseline  fitted by maximum likelihood for `chg` (n x J, post-baseline change),
#' `mask` (TRUE where the value may be used), `arm` (0/1) and `base`. `method` is "factored" (exact ML for monotone missing data, closed form),
#' "gls" (`nlme::gls`, REML, for any pattern) or "auto" (factored when the data are monotone, else gls). Returns, per visit, the arm effect and its
#' standard error, plus the coefficients (J x 3: intercept, arm, baseline), the covariance matrix of the visits, the path taken and the degrees of
#' freedom of the last visit (the residual degrees of freedom of its conditional regression), or NULL when the data cannot be fitted.
vcr_mmrm_fit <- function(chg, mask, arm, base, method = c("auto", "factored", "gls")) {
  method <- match.arg(method)
  J <- ncol(chg)
  # a person's pattern: the number of visits observed when they are the first ones (prefix), -1 when a value is missing before a later one
  nobs <- rowSums(mask)
  prefix <- if (J > 1L) rowSums(mask[, -1L, drop = FALSE] > mask[, -J, drop = FALSE]) == 0L else rep(TRUE, nrow(mask))
  m <- ifelse(prefix, as.integer(nobs), -1L)
  monotone <- !any(m < 0L)
  path <- if (identical(method, "gls") || (identical(method, "auto") && !monotone)) "gls" else "factored"
  if (identical(path, "factored") && !monotone) vcr_abort("scenario_value_invalid", "scenario.analysis.kind", "The factored MMRM fit needs monotone missing data; use the gls path.")
  if (identical(path, "gls")) .vcr_mmrm_gls(chg, mask, arm, base) else .vcr_mmrm_factored(chg, m, arm, base)
}

.vcr_mmrm_factored <- function(chg, m, arm, base) {
  J <- ncol(chg); X <- cbind(1, arm, base)
  b <- matrix(0, J, 3L); Gam <- matrix(0, J, J); s2 <- numeric(J); n_j <- integer(J); dfJ <- NA_real_
  for (j in seq_len(J)) {
    idx <- which(m >= j)
    n_j[j] <- length(idx)
    if (length(idx) < 3L + j - 1L + 2L) return(NULL)
    Z <- if (j > 1L) cbind(X[idx, , drop = FALSE], chg[idx, seq_len(j - 1L), drop = FALSE]) else X[idx, , drop = FALSE]
    f <- stats::lm.fit(Z, chg[idx, j])
    if (anyNA(f$coefficients)) return(NULL)
    a <- f$coefficients[1:3]; gm <- if (j > 1L) f$coefficients[4:(3L + j - 1L)] else numeric(0)
    b[j, ] <- a + if (j > 1L) as.vector(crossprod(gm, b[seq_len(j - 1L), , drop = FALSE])) else 0
    if (j > 1L) Gam[j, seq_len(j - 1L)] <- gm
    s2[j] <- sum(f$residuals^2) / length(idx)
    if (j == J) dfJ <- length(idx) - ncol(Z)
  }
  A <- solve(diag(J) - Gam); Sigma <- A %*% diag(s2, J) %*% t(A)
  Sigma <- (Sigma + t(Sigma)) / 2
  # the information of the visit-specific coefficients (3 per visit) with the covariance fixed at its estimate
  info <- matrix(0, 3L * J, 3L * J)
  for (mm in sort(unique(m[m >= 1L]))) {
    W <- solve(Sigma[seq_len(mm), seq_len(mm), drop = FALSE]); Sx <- crossprod(X[m == mm, , drop = FALSE])
    for (j in seq_len(mm)) for (l in seq_len(mm)) { r <- (3L * (j - 1L) + 1L):(3L * j); cc <- (3L * (l - 1L) + 1L):(3L * l); info[r, cc] <- info[r, cc] + W[j, l] * Sx }
  }
  cov <- tryCatch(solve(info), error = function(e) NULL)
  if (is.null(cov)) return(NULL)
  eff <- b[, 2L]; se <- sqrt(vapply(seq_len(J), function(j) cov[3L * (j - 1L) + 2L, 3L * (j - 1L) + 2L], numeric(1)))
  list(effect = eff, se = se, coef = b, sigma = Sigma, path = "factored", df = dfJ, n = n_j, covariance = cov)
}

.vcr_mmrm_gls <- function(chg, mask, arm, base) {
  J <- ncol(chg); n <- nrow(chg)
  d <- data.frame(id = rep(seq_len(n), times = J), vi = rep(seq_len(J), each = n), chg = as.vector(chg), arm = rep(arm, J), base = rep(base, J), use = as.vector(mask))
  d <- d[d$use, , drop = FALSE]
  d$visit <- factor(d$vi, levels = seq_len(J))
  d <- d[order(d$id, d$vi), , drop = FALSE]
  fit <- tryCatch(suppressWarnings(nlme::gls(chg ~ 0 + visit + visit:arm + visit:base, data = d, correlation = nlme::corSymm(form = ~ vi | id),
                                             weights = nlme::varIdent(form = ~ 1 | visit), method = "REML", na.action = stats::na.omit,
                                             control = nlme::glsControl(maxIter = 200L, msMaxIter = 200L, tolerance = 1e-8))), error = function(e) NULL)
  if (is.null(fit)) return(NULL)
  co <- stats::coef(fit); V <- stats::vcov(fit)
  nm <- paste0("visit", seq_len(J), ":arm")
  if (!all(nm %in% names(co))) return(NULL)
  list(effect = unname(co[nm]), se = sqrt(diag(V)[nm]), coef = NULL, sigma = NULL, path = "gls", df = sum(d$vi == J) - 3L - (J - 1L), n = as.integer(table(d$vi)), covariance = V)
}

# --- conditional-mean imputation ------------------------------------------------------------------------------------------------------------

#' The completed change matrix: what is observed, and for the rest the conditional mean given the person's observed values under the mean the
#' strategy gives them. `coef` is the J x 3 coefficient matrix of the MMRM (intercept, arm, baseline), `sigma` its covariance of the visits,
#' `ice_visit` the last visit on treatment of a person who stopped (Inf: never stopped), `reference` "jump" (own arm up to that visit, the
#' reference's after) or "copy" (the reference's throughout, for a treated person who stopped). Only treated people have a reference to jump to.
vcr_cmi_impute <- function(chg, mask, arm, base, ice_visit, coef, sigma, reference = c("jump", "copy"), delta = 0) {
  reference <- match.arg(reference)
  n <- nrow(chg); J <- ncol(chg)
  out <- chg
  need <- which(rowSums(mask) < J)
  if (!length(need)) return(out)
  # people who share the arm, the last visit on treatment and the pattern of observed values share one conditional-mean map
  key <- paste(arm[need], pmin(ice_visit[need], J), as.vector(mask[need, , drop = FALSE] %*% 2^(seq_len(J) - 1L)))
  for (grp in split(need, key)) {
    a <- arm[grp[1L]]; r <- mask[grp[1L], ]; o <- which(r); mi <- which(!r)
    b <- base[grp]
    ref <- outer(b, coef[, 3L]) + matrix(coef[, 1L], length(grp), J, byrow = TRUE)
    own <- ref + a * matrix(coef[, 2L], length(grp), J, byrow = TRUE)
    mu <- own
    l <- ice_visit[grp[1L]]
    if (a == 1 && is.finite(l)) {
      if (identical(reference, "copy")) mu <- ref else if (l < J) mu[, (l + 1L):J] <- ref[, (l + 1L):J, drop = FALSE]
    }
    add <- if (length(o)) (chg[grp, o, drop = FALSE] - mu[, o, drop = FALSE]) %*% t(sigma[mi, o, drop = FALSE] %*% solve(sigma[o, o, drop = FALSE])) else 0
    out[grp, mi] <- mu[, mi, drop = FALSE] + add + if (a == 1) delta else 0
  }
  out
}

#' The CMI point estimate: fit the MMRM to the usable values, impute, and analyse the completed change at the last visit by ANCOVA (arm and baseline).
.vcr_cmi_point <- function(chg, mask, arm, base, ice_visit, reference, delta) {
  f <- vcr_mmrm_fit(chg, mask, arm, base, method = "auto")
  if (is.null(f) || is.null(f$sigma)) return(NA_real_)
  done <- vcr_cmi_impute(chg, mask, arm, base, ice_visit, f$coef, f$sigma, reference, delta)
  y <- done[, ncol(done)]
  if (sum(arm == 1) < 2L || sum(arm == 0) < 2L) return(NA_real_)
  unname(stats::lm.fit(cbind(1, arm, base), y)$coefficients[2L])
}

#' The CMI estimate and its delete-a-group jackknife standard error: `groups` groups assigned in turn within each arm, the whole procedure
#' (model fit, imputation, analysis) repeated without each group, `se^2 = (G - 1) / G sum (theta_(-g) - mean theta_(-.))^2`, t with G - 1 df.
vcr_cmi_jackknife <- function(chg, mask, arm, base, ice_visit, reference = "jump", delta = 0, groups = 10L) {
  none <- list(estimate = NA_real_, se = NA_real_, df = NA_real_)
  theta <- .vcr_cmi_point(chg, mask, arm, base, ice_visit, reference, delta)
  if (!is.finite(theta)) return(none)
  g <- integer(length(arm)); for (a in 0:1) { ix <- which(arm == a); g[ix] <- rep_len(seq_len(groups), length(ix)) }
  th <- vapply(seq_len(groups), function(k) { keep <- g != k; .vcr_cmi_point(chg[keep, , drop = FALSE], mask[keep, , drop = FALSE], arm[keep], base[keep], ice_visit[keep], reference, delta) }, numeric(1))
  if (any(!is.finite(th))) return(none)
  list(estimate = theta, se = sqrt((groups - 1) / groups * sum((th - mean(th))^2)), df = groups - 1)
}

#' The delta (points added to what is imputed for the treated arm) at which the CMI result stops being significant at `alpha` (two-sided, in the direction it had at delta 0): found by
#' bisection on the jackknife t statistic over [0, `upper`]; NA when it is not significant at delta 0, and Inf when it is still significant at `upper`.
vcr_cmi_tipping <- function(chg, mask, arm, base, ice_visit, reference = "jump", alpha = 0.05, groups = 10L, upper = 20, tol = 1e-3) {
  dir <- NULL
  # significant in the direction the result had at delta 0 (a delta large enough to flip the sign is no longer the result being tested)
  sig <- function(d) { r <- vcr_cmi_jackknife(chg, mask, arm, base, ice_visit, reference, d, groups); if (is.null(dir)) dir <<- sign(r$estimate); is.finite(r$se) && dir * r$estimate / r$se > stats::qt(1 - alpha / 2, r$df) }
  if (!sig(0)) return(NA_real_)
  if (sig(upper)) return(Inf)
  lo <- 0; hi <- upper
  while (hi - lo > tol) { mid <- (lo + hi) / 2; if (sig(mid)) lo <- mid else hi <- mid }
  (lo + hi) / 2
}

# --- the true value of each estimand ---------------------------------------------------------------------------------------------------------

#' The true treated-less-control difference in mean change at the analysis visit under the two estimands, computed from the data-generating
#' process at the typical study (the posterior medians): the mean over `n_people` people of the exact expected score of each person with the drug and
#' without it (the beta mean, no residual noise), the person's stop time drawn from the treated hazard for the treatment-policy truth and never for
#' the hypothetical one. A death scores 70. The stream is its own (`seed`), so the number never moves with the trial count or the cores.
vcr_ice_truth <- function(p, seed, n_people = .VCR_ICE_TRUTH_PEOPLE) {
  old <- if (exists(".Random.seed", envir = globalenv(), inherits = FALSE)) get(".Random.seed", envir = globalenv()) else NULL
  on.exit(if (!is.null(old)) assign(".Random.seed", old, envir = globalenv()), add = TRUE)
  set.seed(seed)
  par <- p$par; study <- vcr_beta_logit_typical_study(par); ice <- p$ice
  q <- .vcr_bl_draw_people(par, study, n_people)
  visits <- p$visits[seq_len(p$at)]; at <- length(visits); tr <- p$treatment
  z <- (q$alpha - q$meanSlope) / study[["sdAlpha"]]
  u <- stats::runif(n_people); ud <- stats::runif(n_people)
  d <- ice$discontinuation
  rate <- if (is.null(d)) rep(0, n_people) else d$rate[["treated"]] * exp(d$gamma * z - d$gamma^2 / 2)
  stop_t <- ifelse(rate > 0, -log(u) / rate, Inf)
  death_t <- if (is.null(ice$death)) rep(Inf, n_people) else -log(ud) / ice$death$rate
  g <- .VCR_BETA_LOGIT_GUARD
  mean_score <- function(treated, end, rebound) {
    lat <- .vcr_ice_latent(par, q, rep(treated, n_people), tr, visits, end, rebound, p$placebo)
    m <- 70 * (stats::plogis(lat) + g) / (1 + 2 * g)
    dead <- matrix(visits, n_people, at, byrow = TRUE) >= matrix(death_t, n_people, at)
    m[dead] <- 70
    m
  }
  ctrl <- mean_score(0, rep(tr$end, n_people), 0)
  one <- function(end, rebound) { m <- mean_score(1, end, rebound); (m[, at] - m[, 1L]) - (ctrl[, at] - ctrl[, 1L]) }
  tp <- one(pmin(tr$end, stop_t), ice$offTreatment$reboundLogit)
  hy <- one(rep(tr$end, n_people), 0)
  mk <- function(x) list(value = mean(x), mcse = stats::sd(x) / sqrt(length(x)))
  list(treatment_policy = mk(tp), hypothetical = mk(hy), people = n_people)
}

# --- the result ------------------------------------------------------------------------------------------------------------------------------

#' The intercurrent-event part of the result: the configuration as run, the realized shares, and the estimand table (truth, estimator bias, coverage).
.vcr_ice_report <- function(p, v, unit) {
  done <- nrow(v); est <- v[, "estimate"]; ok <- v[, "analysed"] == 1
  meas <- function(name, x, ...) vcr_measure(name, mean(x), simulated = TRUE, mcse = stats::sd(x) / sqrt(length(x)), source = "synthetic", ...)
  share <- function(col) if (done > 1L) meas("realized_share", v[, col]) else NULL
  rows <- lapply(c("treatment_policy", "hypothetical"), function(s) {
    tr <- p$truth[[s]]; col <- if (identical(s, "treatment_policy")) "coverTP" else "coverHyp"
    cv <- v[ok, col]; e <- est[ok]
    list(strategy = s,
         truth = vcr_measure("estimand_truth", tr$value, simulated = TRUE, mcse = tr$mcse, source = "synthetic", unit = unit,
                             note = "treated less control, mean change from baseline at the analysis visit, from the data-generating process at the typical study"),
         bias = if (length(e) > 1L) vcr_measure("estimator_bias", mean(e) - tr$value, simulated = TRUE, mcse = sqrt(stats::var(e) / length(e) + tr$mcse^2), source = "synthetic", unit = unit) else NULL,
         coverage = if (length(cv) > 1L) vcr_measure("ci_coverage", mean(cv), simulated = TRUE, mcse = vcr_mcse_proportion(mean(cv), length(cv)), source = "synthetic") else NULL)
  })
  list(estimator = p$ia$kind, data = p$ia$data, delta = p$ia$delta, estimands = rows, claimed = p$claimed,
       realized = list(stoppedControl = share("stopControl"), stoppedTreated = share("stopTreated"), leftControl = share("withdrewControl"), leftTreated = share("withdrewTreated"),
                       diedControl = share("diedControl"), diedTreated = share("diedTreated")),
       truthPeople = p$truth$people, estimateSd = if (sum(ok) > 1L) stats::sd(est[ok]) else NA_real_, meanSe = if (any(ok)) mean(v[ok, "se"]) else NA_real_,
       configuration = list(discontinuation = if (is.null(p$ice$discontinuation)) NULL else list(shareControl = p$ice$discontinuation$shares[["control"]], shareTreated = p$ice$discontinuation$shares[["treated"]],
                                                                                              progressionLogHazardPerSd = p$ice$discontinuation$gamma, retrievedShare = p$ice$discontinuation$retrieved),
                            withdrawal = p$ice$withdrawal, death = if (is.null(p$ice$death)) NULL else list(share = p$ice$death$share), offTreatment = p$ice$offTreatment))
}
