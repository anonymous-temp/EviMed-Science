# ---------------------------------------------------------------------------
# patients_progression_effects.R — an effect distribution for the beta_logit family of `patients.progression` 1.2.0 (plan R25, 2026-11-09): the
# symptomatic effect `pointsAt` or the disease-modifying `fraction` stated as a distribution drawn once per simulated trial, so the result is the
# probability of a significant result averaged over what the effect might be (an assurance in O'Hagan, Stevens & Campbell's sense), not the
# power at one assumed value.
#
# Hidden knowledge:
#
# - **The effect is drawn on a stream of its own.** A trial's effect comes from `nextRNGSubStream` of the trial's stream and the trial's own stream
#   is restored afterwards, so stating a distribution never moves a person's covariates, random effects, dropout or residuals: a degenerate one (a
#   `fixed` family, or a normal with SD 1e-300) gives the fixed-effect run's numbers to the last bit, and two distributions of the same seed differ
#   only in the effect they drew.
# - **A draw outside what the model can represent is redrawn, and the result says how much was.** A symptomatic effect must leave the reference
#   score strictly inside 0 to 70 (adsim's logit scale) and a disease-modifying share lies in [0, 1): a normal prior can reach beyond either. The
#   draw is repeated (truncating the prior to the valid range, the only change that keeps every other draw as stated), the share of the prior's mass
#   that lies inside is calculated from its distribution function, and the share of draws that were redrawn is counted; a prior with under 1% of its
#   mass inside is refused.
# - **What the number is.** It counts every significant benefit, whatever the true effect was in that trial, including a null or an irrelevant
#   one; it is not the chance that the drug works, and it is not a programme's chance of success. The hypothesis is the researcher's, with its
#   tier (A: from a published fit of the compound's class, B: from a mechanism chain, C: from a literature estimate with no model, stated: the
#   person's own) and its source named on the result.
# ---------------------------------------------------------------------------

.VCR_BL_EFFECT_FAMILIES <- c("fixed", "normal", "truncated_normal", "lognormal", "beta", "uniform", "empirical_draws")
.VCR_BL_EFFECT_MIN_MASS <- 0.01
.VCR_BL_EFFECT_MAX_TRIES <- 10000L

#' An effect statement as the engine reads it: `{value, basis}` (a number the researcher states) or `{distribution}`. A number is the `fixed` family.
#' `lo` and `hi` are the open ends of what the model can represent (`closed_lo` says whether `lo` itself is allowed).
.vcr_bl_effect_spec <- function(x, field, lo, hi, closed_lo = FALSE) {
  if (is.null(x)) return(NULL)
  d <- x[["distribution"]]
  refuse_field <- function(f, detail) vcr_abort("scenario_value_invalid", paste0(field, ".distribution.", f), detail)
  if (is.null(d)) return(list(family = "fixed", parameters = list(value = vcr_scalar(x[["value"]])), source = NULL, tier = NULL, distributed = FALSE, lo = lo, hi = hi, closed_lo = closed_lo))
  family <- as.character(d[["family"]] %||% "")
  if (!(family %in% .VCR_BL_EFFECT_FAMILIES)) refuse_field("family", "The effect distribution is fixed, normal, truncated_normal, lognormal, beta, uniform or empirical_draws.")
  pr <- d[["parameters"]] %||% list()
  num <- function(k) { v <- vcr_scalar(pr[[k]]); if (is.null(v) || !is.finite(v)) refuse_field(paste0("parameters.", k), sprintf("The %s family needs a number `%s`.", family, k)); v }
  parameters <- switch(family,
    fixed = list(value = num("value")),
    normal = { p <- list(mean = num("mean"), sd = num("sd")); if (!(p$sd > 0)) refuse_field("parameters.sd", "The SD is positive."); p },
    truncated_normal = { p <- list(mean = num("mean"), sd = num("sd"), lower = num("lower"), upper = num("upper"))
      if (!(p$sd > 0) || !(p$upper > p$lower)) refuse_field("parameters", "The SD is positive and the upper bound is above the lower."); p },
    lognormal = { p <- list(meanlog = num("meanlog"), sdlog = num("sdlog")); if (!(p$sdlog > 0)) refuse_field("parameters.sdlog", "The SD of the log is positive."); p },
    beta = { p <- list(shape1 = num("shape1"), shape2 = num("shape2")); if (!(p$shape1 > 0) || !(p$shape2 > 0)) refuse_field("parameters", "Both beta shapes are positive."); p },
    uniform = { p <- list(min = num("min"), max = num("max")); if (!(p$max > p$min)) refuse_field("parameters.max", "The upper end is above the lower."); p },
    empirical_draws = { v <- vcr_num(pr[["values"]]); if (length(v) < 2L || length(v) > 10000L || anyNA(v) || !all(is.finite(v))) refuse_field("parameters.values", "Between 2 and 10000 finite numbers."); list(values = v) })
  src <- d[["source"]] %||% list()
  tier <- as.character(d[["tier"]] %||% "")
  spec <- list(family = family, parameters = parameters, source = list(kind = as.character(src[["kind"]] %||% ""), citation = src[["citation"]], objectRef = src[["objectRef"]], note = src[["note"]]),
               tier = tier, distributed = !identical(family, "fixed"), lo = lo, hi = hi, closed_lo = closed_lo)
  mass <- .vcr_bl_effect_mass(spec)
  if (!(mass >= .VCR_BL_EFFECT_MIN_MASS)) {
    vcr_abort("scenario_value_invalid", paste0(field, ".distribution"), sprintf("Only %.2g of this distribution lies where the model can represent the effect (%s); state one that mostly does.", mass,
      if (identical(field, "scenario.treatment.diseaseModifying.fraction")) "a share from 0 up to, not including, 1" else "a change that keeps the reference score between 0 and 70"))
  }
  spec
}

#' Whether `x` is where the model can represent the effect.
.vcr_bl_effect_valid <- function(spec, x) {
  inside <- x < spec$hi & (if (isTRUE(spec$closed_lo)) x >= spec$lo else x > spec$lo)
  inside & is.finite(x)
}

#' The distribution function of the stated family.
.vcr_bl_effect_cdf <- function(spec, x) {
  p <- spec$parameters
  switch(spec$family,
    fixed = as.numeric(x >= p$value),
    normal = stats::pnorm(x, p$mean, p$sd),
    truncated_normal = { a <- stats::pnorm(p$lower, p$mean, p$sd); b <- stats::pnorm(p$upper, p$mean, p$sd)
      pmin(1, pmax(0, (stats::pnorm(pmin(pmax(x, p$lower), p$upper), p$mean, p$sd) - a) / (b - a))) },
    lognormal = stats::plnorm(x, p$meanlog, p$sdlog),
    beta = stats::pbeta(x, p$shape1, p$shape2),
    uniform = stats::punif(x, p$min, p$max),
    empirical_draws = vapply(x, function(v) mean(p$values <= v), numeric(1)))
}

#' The probability, under the stated distribution, of an effect the model can represent.
.vcr_bl_effect_mass <- function(spec) {
  if (identical(spec$family, "empirical_draws")) return(mean(.vcr_bl_effect_valid(spec, spec$parameters$values)))
  if (identical(spec$family, "fixed")) return(as.numeric(.vcr_bl_effect_valid(spec, spec$parameters$value)))
  hi <- .vcr_bl_effect_cdf(spec, spec$hi); lo <- .vcr_bl_effect_cdf(spec, spec$lo)
  max(0, hi - lo)
}

#' One draw from the stated family (from the stream in use). `fixed` draws nothing.
.vcr_bl_effect_draw_raw <- function(spec) {
  p <- spec$parameters
  switch(spec$family,
    fixed = p$value,
    normal = stats::rnorm(1L, p$mean, p$sd),
    truncated_normal = { a <- stats::pnorm(p$lower, p$mean, p$sd); b <- stats::pnorm(p$upper, p$mean, p$sd); stats::qnorm(a + stats::runif(1L) * (b - a), p$mean, p$sd) },
    lognormal = stats::rlnorm(1L, p$meanlog, p$sdlog),
    beta = { x <- stats::rgamma(1L, p$shape1); y <- stats::rgamma(1L, p$shape2); if (x + y > 0) x / (x + y) else 0.5 },
    uniform = stats::runif(1L, p$min, p$max),
    empirical_draws = p$values[sample.int(length(p$values), 1L)])
}

#' One draw the model can represent, and how many tries it took. A `fixed` value that the model cannot represent is refused where it is read.
.vcr_bl_effect_draw <- function(spec) {
  if (identical(spec$family, "fixed")) return(c(spec$parameters$value, 1))
  for (k in seq_len(.VCR_BL_EFFECT_MAX_TRIES)) {
    x <- .vcr_bl_effect_draw_raw(spec)
    if (.vcr_bl_effect_valid(spec, x)) return(c(x, k))
  }
  vcr_abort("scenario_value_invalid", "scenario.treatment", "No draw of the stated effect distribution fell where the model can represent the effect.")
}

#' The distribution's median over what the model can represent: the effect the calculated curves are drawn at. Truncation to the valid range is
#' applied to the quantile (the same truncation the draws use).
.vcr_bl_effect_median <- function(spec) {
  if (!isTRUE(spec$distributed)) return(spec$parameters$value)
  p <- spec$parameters
  if (identical(spec$family, "empirical_draws")) return(stats::median(p$values[.vcr_bl_effect_valid(spec, p$values)]))
  qf <- function(u) switch(spec$family,
    normal = stats::qnorm(u, p$mean, p$sd), truncated_normal = { a <- stats::pnorm(p$lower, p$mean, p$sd); b <- stats::pnorm(p$upper, p$mean, p$sd); stats::qnorm(a + u * (b - a), p$mean, p$sd) },
    lognormal = stats::qlnorm(u, p$meanlog, p$sdlog), beta = stats::qbeta(u, p$shape1, p$shape2), uniform = stats::qunif(u, p$min, p$max))
  lo <- .vcr_bl_effect_cdf(spec, spec$lo); hi <- .vcr_bl_effect_cdf(spec, spec$hi)
  qf(lo + 0.5 * (hi - lo))
}

#' Run `fn` on the substream after the stream in use, and leave the stream in use exactly where it was.
.vcr_bl_apart <- function(fn) {
  seed0 <- get(".Random.seed", envir = .GlobalEnv)
  assign(".Random.seed", parallel::nextRNGSubStream(seed0), envir = .GlobalEnv)
  on.exit(assign(".Random.seed", seed0, envir = .GlobalEnv), add = TRUE)
  fn()
}

#' The effects of one simulated trial: `pts` and `frac` as numbers (NULL for a term stated as a number, which the base treatment holds), and the
#' tries each took, in a vector `c(pts, frac, triesPts, triesFrac)` (NA where nothing was drawn).
.vcr_bl_trial_effects <- function(effects) {
  one <- function(spec) if (is.null(spec) || !isTRUE(spec$distributed)) c(NA_real_, NA_real_) else .vcr_bl_effect_draw(spec)
  .vcr_bl_apart(function() { a <- one(effects$pointsAt); b <- one(effects$fraction); c(a[1], b[1], a[2], b[2]) })
}

#' What a distribution says about itself, for the result: the family, its parameters, the source and tier the researcher named, the share of its
#' mass the model can represent, the share of draws that were redrawn and the mean and SD of what was used.
.vcr_bl_effect_report <- function(key, spec, used, tries) {
  if (is.null(spec) || !isTRUE(spec$distributed)) return(NULL)
  src <- spec$source
  # the draws of an `empirical_draws` family are the researcher's (or a chain's) and as many as 10,000: the result carries their count and summary, never the values
  parameters <- if (identical(spec$family, "empirical_draws")) { v <- spec$parameters$values; list(draws = length(v), min = min(v), p05 = stats::quantile(v, 0.05, names = FALSE), median = stats::median(v), p95 = stats::quantile(v, 0.95, names = FALSE), max = max(v)) } else spec$parameters
  list(key = key, family = spec$family, parameters = parameters, source = list(kind = src$kind, citation = src$citation, objectRef = src$objectRef, note = src$note), tier = spec$tier,
       priorMassRepresentable = .vcr_bl_effect_mass(spec), redrawnShare = if (length(tries)) 1 - length(tries) / sum(tries) else NA_real_,
       drawMean = if (length(used)) mean(used) else NA_real_, drawSd = if (length(used) > 1L) stats::sd(used) else NA_real_, draws = length(used))
}
