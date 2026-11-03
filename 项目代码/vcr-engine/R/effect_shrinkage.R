# ---------------------------------------------------------------------------
# effect_shrinkage.R — what a published effect would be worth if it were read against the trials of the Cochrane Database
# (evidence.shrinkage; algorithm round E8, 2026-11-03).
#
# The person's question is "this phase II trial gave a hazard ratio of 0.66, z = 2.2: how much of it should I expect to be left in the
# phase III, and how likely is a trial of the same precision to confirm it?". The answer is empirical Bayes in the form of van Zwet
# et al. (NEJM Evidence 2023): across 23,551 randomized trials the signal-to-noise ratio (true effect over standard error) has a
# distribution that a mixture of four zero-mean normals describes, so an observed z statistic can be read against it.
#
# Hidden knowledge:
#
# - **A comparison line, never a replacement.** The result is shown beside the value the person stated; nothing in the engine or on the
#   page uses the shrunken value as the assumption. The reference population is every kind of intervention and every trial size in the
#   database, so it can shrink a confirmatory trial of a drug with a strong mechanism more than that trial deserves; the result names the
#   population, and the page words it as "the typical trial of the database", not as this drug.
# - **The model is on the z statistic of the primary efficacy outcome, so it needs the estimate and its standard error on a scale where
#   the null is 0** (a difference, or the log of a ratio). A proportion on the logit scale has no null at 0 and is refused by the schema.
# - **Everything is closed form.** The z statistic is the signal-to-noise ratio plus a standard normal, so given z each component of the mixture
#   has a normal posterior for the ratio (mean z B_k, variance B_k, B_k = tau_k^2 / (1 + tau_k^2)) and a weight proportional to its prior
#   weight times the density of z under N(0, 1 + tau_k^2). The shrunken estimate is the posterior mean, the exaggeration is |z / SNR| (its quartiles
#   are found by solving the mixture's distribution function, not by simulation), the probability of the right sign is P(SNR has the sign of z)
#   and the probability of an exact replication is P(z2 beyond the critical value in the direction of z) with z2 = SNR + a new standard normal.
#   Nothing in this file is simulated, so there is no Monte-Carlo error to report; the paper's own tables (Monte Carlo, 10^6 draws) are the
#   check, by integrating this file's per-z functions over the strata of the P value (the numeric case).
# - **The printed standard deviations of the signal-to-noise ratio are used as printed** (0.61, 1.42, 2.16, 5.64), and the standard deviation
#   of z follows from them (z = SNR + N(0, 1)). The paper's own z row (1.17, 1.74, 2.38, 5.73) agrees to its rounding. The paper does not
#   print more digits, so this is the finest the published parameters allow and the case's tolerance says so.
# - **A trial of another precision** (`futureSe`): the true effect is held, the standard error changes, so the signal-to-noise ratio of the
#   new trial is the old one times se / futureSe, and its z statistic is that plus a standard normal. The probability that it is beyond the
#   critical value in the original direction is the answer to "how likely is my phase III to confirm this". With futureSe = se it is the
#   exact-replication probability the paper tabulates.
# - **z = 0 has no direction.** The shrunken estimate is 0, the sign is a coin, and the exaggeration and the replication are not defined;
#   the row says so instead of printing a number.
# ---------------------------------------------------------------------------

#' The mixture of the signal-to-noise ratio (van Zwet et al. 2023, Table 1), from the domain's table.
vcr_shrink_mixture <- function() {
  m <- vcr_domain()$vanZwet2023$mixture
  list(pi = as.numeric(unlist(m[["proportion"]])), tau = as.numeric(unlist(m$sdSnr)))
}

#' The posterior of the signal-to-noise ratio given a z statistic: component weights, means and variances.
vcr_shrink_posterior <- function(z, mix = vcr_shrink_mixture()) {
  t2 <- mix$tau^2
  B <- t2 / (1 + t2)
  lw <- log(mix$pi) + stats::dnorm(z, 0, sqrt(1 + t2), log = TRUE)
  w <- exp(lw - max(lw)); w <- w / sum(w)
  list(w = w, m = B * z, v = B, B = B)
}

#' P(|SNR| < c) given the posterior: the mass between -c and c.
.vcr_shrink_abs_cdf <- function(post, c) sum(post$w * (stats::pnorm((c - post$m) / sqrt(post$v)) - stats::pnorm((-c - post$m) / sqrt(post$v))))

#' The quantiles of the exaggeration |z / SNR| given z. F(e) = P(|SNR| >= |z| / e).
vcr_shrink_exaggeration_quantiles <- function(z, post, p = c(0.25, 0.5, 0.75)) {
  az <- abs(z)
  F <- function(e) 1 - .vcr_shrink_abs_cdf(post, az / e)
  vapply(p, function(pp) {
    f <- function(le) F(exp(le)) - pp
    exp(stats::uniroot(f, c(-30, 30), tol = 1e-12, maxiter = 500L)$root)
  }, numeric(1))
}

#' Everything the engine says about one observed effect and its standard error.
#'
#' @param estimate,se on the analysis scale (a difference, or the log of a ratio); null at 0.
#' @param future_se the standard error of a later trial of the same true effect, or NULL.
#' @param alpha the two-sided level whose critical value a replication must pass.
vcr_shrink_one <- function(estimate, se, level = 0.95, alpha = 0.05, future_se = NULL, mix = vcr_shrink_mixture()) {
  z <- estimate / se
  crit <- stats::qnorm(1 - alpha / 2)
  out <- list(estimate = estimate, se = se, z = z, p = 2 * stats::pnorm(-abs(z)), critical = crit)
  if (abs(z) < 1e-9) {
    out$degenerate <- TRUE
    out$shrunken <- 0; out$factor <- NA_real_
    out$interval <- NULL
    out$correctSign <- 0.5
    return(out)
  }
  post <- vcr_shrink_posterior(z, mix)
  a <- (1 - level) / 2
  out$degenerate <- FALSE
  out$components <- post
  out$factor <- sum(post$w * post$B)
  out$shrunken <- estimate * out$factor
  q <- .vcr_normal_mixture_quantile(c(a, 1 - a), post$w, post$m, sqrt(post$v))
  out$interval <- se * q
  sgn <- sign(z)
  out$correctSign <- sum(post$w * stats::pnorm(sgn * post$m / sqrt(post$v)))
  out$exaggeration <- vcr_shrink_exaggeration_quantiles(z, post)
  out$overestimated <- .vcr_shrink_abs_cdf(post, abs(z))              # P(|SNR| < |z|): the estimate is larger than the truth
  # a replication of the same precision, in the direction of z
  rep_p <- function(scale) {
    mm <- sgn * post$m * scale; ss <- sqrt(post$v * scale^2 + 1)
    sum(post$w * (1 - stats::pnorm((crit - mm) / ss)))
  }
  out$replication <- rep_p(1)
  if (!is.null(future_se)) out$futureSuccess <- rep_p(se / future_se)
  out
}

vcr_job_effect_shrinkage <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  assumed <- list()
  note <- function(key, value, basis) assumed[[length(assumed) + 1L]] <<- list(key = key, value = value, basis = basis)
  scale <- as.character(sc$scale)
  level <- vcr_scalar(sc$level, 0.95)
  if (is.null(sc$level)) note("level", 0.95, "the usual level of an interval")
  alpha <- vcr_scalar(sc$alpha, 0.05)
  if (is.null(sc$alpha)) note("alpha", 0.05, "the two-sided level of the test a replication has to pass")
  mix <- vcr_shrink_mixture()
  rows <- list()
  for (i in seq_along(sc$values)) {
    v <- sc$values[[i]]
    est <- vcr_scalar(v$estimate, NA_real_); se <- vcr_scalar(v$se, NA_real_)
    if (!is.finite(est) || !is.finite(se) || se <= 0) vcr_abort("scenario_value_invalid", sprintf("scenario.values[%d]", i - 1L), "A value states an estimate and a positive standard error.")
    fut <- vcr_scalar(v$futureSe, NULL)
    r <- vcr_shrink_one(est, se, level = level, alpha = alpha, future_se = fut, mix = mix)
    back <- if (identical(scale, "log")) exp else identity
    rows[[i]] <- c(list(id = as.character(v$id %||% paste0("value", i)), estimate = est, se = se, z = r$z, p = r$p, degenerate = r$degenerate,
                        natural = back(est), shrunken = r$shrunken, shrunkenNatural = back(r$shrunken),
                        correctSign = r$correctSign, futureSe = fut),
                   if (!r$degenerate) list(shrinkageFactor = r$factor, interval = r$interval, naturalInterval = back(r$interval),
                                           exaggerationQuartiles = r$exaggeration, exaggerationMedian = r$exaggeration[2], estimateLargerThanTruth = r$overestimated,
                                           replication = r$replication, futureSuccess = r$futureSuccess)
                   else list(note = "z = 0: the estimate has no direction to be exaggerated in, so only the sign (a coin) is defined"))
  }
  first <- rows[[1L]]
  measures <- list(vcr_measure("z_statistic", first$z, source = "calculated"),
                   vcr_measure("p_value", first$p, source = "calculated"),
                   vcr_measure("shrunken_estimate", first$shrunken, unit = scale, source = "calculated",
                               interval = if (!first$degenerate) vcr_interval("credible", first$interval[1], first$interval[2], level)),
                   vcr_measure("correct_sign_probability", first$correctSign, source = "calculated"))
  if (!first$degenerate) {
    measures <- c(measures, list(
      vcr_measure("shrinkage_factor", first$shrinkageFactor, source = "calculated"),
      vcr_measure("exaggeration_median", first$exaggerationMedian, source = "calculated"),
      vcr_measure("replication_probability", first$replication, source = "calculated")))
    if (!is.null(first$futureSuccess)) measures <- c(measures, list(vcr_measure("future_trial_success_probability", first$futureSuccess, source = "calculated")))
  }
  list(status = "succeeded", measures = measures, counts = vcr_counts(realPatients = NULL, generatedRecords = 0),
       diagnostics = list(shrinkage = list(
         given = list(label = sc$label, scale = scale, level = level, alpha = alpha, values = length(rows)),
         reference = list(population = "the primary efficacy results of 23,551 randomized trials of the Cochrane Database of Systematic Reviews",
                          mixture = list(proportion = mix$pi, sdSnr = mix$tau), citation = vcr_domain()$vanZwet2023$source$citation),
         rows = rows, assumed = assumed)))
}
