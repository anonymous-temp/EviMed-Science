# N73 — comparator.stc: the G-computation form of the simulated treatment comparison (algorithm round C9, 2026-11-03).
#
# References that are not the method's own code: the estimate recomputed by hand (`stats::glm`, predictions averaged over the same covariate
# sample); a known-truth simulation whose marginal effect in the aggregate trial's population is integrated exactly (Gauss-Hermite over the
# continuous covariate, a sum over the binary one), on the logit link where the marginal and the conditional effect are different numbers;
# and the engine's own MAIC (`comparator.maic`, anchored) on a linear outcome, where the two methods estimate the same quantity.

# IPD trial (randomised, A against C): x1 ~ N(0, 1), x2 ~ Bernoulli(0.4); the outcome's linear predictor has an effect modifier, x1.
.n73_gen <- function(n = 600L, binary = TRUE) {
  x1 <- stats::rnorm(n); x2 <- stats::rbinom(n, 1L, 0.4); arm <- rep(0:1, length.out = n)
  lp <- -0.3 + 0.6 * x1 + 0.4 * x2 + arm * (-0.5 + 0.4 * x1)
  y <- if (binary) stats::rbinom(n, 1L, stats::plogis(lp)) else lp + stats::rnorm(n)
  data.frame(USUBJID = sprintf("S%05d", seq_len(n)), arm = arm, x1 = x1, x2 = x2, y = y)
}
# the aggregate trial's published margins: x1 mean 0.8 sd 1.2, x2 proportion 0.6
.n73_agd <- list(list(variable = "x1", mean = 0.8, sd = 1.2), list(variable = "x2", proportion = 0.6))

# the marginal means of A and C in the aggregate trial's population, exactly
.n73_truth <- function(binary = TRUE) {
  gh <- .vcr_gauss_hermite(80); x1 <- 0.8 + 1.2 * sqrt(2) * gh$nodes; w <- gh$weights / sqrt(pi)
  mean_of <- function(a) sum(vapply(0:1, function(x2) (if (x2 == 1L) 0.6 else 0.4) * sum(w * {
    lp <- -0.3 + 0.6 * x1 + 0.4 * x2 + a * (-0.5 + 0.4 * x1); if (binary) stats::plogis(lp) else lp
  }), numeric(1)))
  m1 <- mean_of(1); m0 <- mean_of(0)
  list(m1 = m1, m0 = m0, contrast = if (binary) stats::qlogis(m1) - stats::qlogis(m0) else m1 - m0)
}

.n73_job <- function(d, id, scenario = list(), seed = 9L, replicates = 400L, binary = TRUE) {
  sc <- utils::modifyList(list(covariates = list("x1", "x2"), effectModifiers = list("x1"), aggregateCovariates = .n73_agd, treatmentColumn = "arm", outcomeColumn = "y",
                               endpoint = list(type = if (binary) "binary" else "continuous"), anchored = TRUE, aggregateEstimate = -0.25, aggregateSe = 0.1, size = 20000L), scenario)
  vcr_test_job("comparator.stc", sc, list(vcr_test_input(d, paste0("snp_", id, ":subject"), "subject")), seed = seed, job_id = paste0("job_", id), replicates = replicates)
}

vcr_case("N73a", c("AC-08", "AC-30"), function() {
  # The estimate by hand: the same covariate sample (the engine's literature population from the same table, correlation and seed), the glm fitted on
  # the IPD rows, its predictions averaged under each arm, the contrast on the logit link, the published contrast taken away. Unanchored: only the
  # active arm is modelled and its predicted mean is set against the aggregate arm's outcome on the logit scale, the delta method carrying its error.
  set.seed(20261110L, kind = VCR_RNG_KIND)
  d <- .n73_gen(800L)
  r <- vcr_test_run(.n73_job(d, "n73a"))
  v <- function(res, name) vcr_measure_value(res, name)
  rho <- stats::cor(as.matrix(d[, c("x1", "x2")]), method = "spearman"); latent <- vcr_copula_correlation(rho, "spearman")$correlation
  set.seed(9L, kind = VCR_RNG_KIND)
  pop <- vcr_population_literature(.n73_agd, 20000L, latent, "ipd", 1L, seed = 9L)$data[, c("x1", "x2")]
  fit <- stats::glm(y ~ x1 + x2 + arm + arm:x1, data = d, family = stats::binomial())
  m1 <- mean(stats::predict(fit, cbind(pop, arm = 1), type = "response")); m0 <- mean(stats::predict(fit, cbind(pop, arm = 0), type = "response"))
  hand <- stats::qlogis(m1) - stats::qlogis(m0)
  # unanchored on the active arm
  ru <- vcr_test_run(.n73_job(d, "n73au", scenario = list(anchored = FALSE, aggregateEstimate = NULL, aggregateOutcome = 0.45, aggregateSe = 0.04), replicates = 400L))
  act <- d[d$arm == 1L, ]
  fit_u <- stats::glm(y ~ x1 + x2, data = act, family = stats::binomial())
  m_u <- mean(stats::predict(fit_u, pop, type = "response"))
  rho_u <- stats::cor(as.matrix(act[, c("x1", "x2")]), method = "spearman")
  set.seed(9L, kind = VCR_RNG_KIND)
  pop_u <- vcr_population_literature(.n73_agd, 20000L, vcr_copula_correlation(rho_u, "spearman")$correlation, "ipd", 1L, seed = 9L)$data[, c("x1", "x2")]
  m_u <- mean(stats::predict(fit_u, pop_u, type = "response"))
  hand_u <- stats::qlogis(m_u) - stats::qlogis(0.45)
  est <- vcr_get_measure(r, "indirect_estimate")
  ok <- identical(r$status, "succeeded") && identical(ru$status, "succeeded") &&
    abs(v(r, "marginal_contrast_ipd") - hand) < 1e-9 && abs(est$value - (hand + 0.25)) < 1e-9 && isTRUE(est$simulated) && is.finite(est$mcse) && est$mcse > 0 &&
    abs(v(ru, "marginal_level_ipd") - stats::qlogis(m_u)) < 1e-9 && abs(v(ru, "indirect_estimate") - hand_u) < 1e-9 &&
    identical(r$diagnostics$anchored, TRUE) && identical(ru$diagnostics$anchored, FALSE) && identical(ru$conclusion, "limited") &&
    identical(r$diagnostics$targetPopulation, "aggregate_data_trial") && identical(r$diagnostics$correlation$source, "ipd_spearman") &&
    !is.null(vcr_get_measure(r, "conditional_contrast_ipd")) && is.null(vcr_get_measure(ru, "conditional_contrast_ipd")) &&
    length(vcr_validate_result(r)) == 0L && length(vcr_validate_result(ru)) == 0L &&
    abs((est$interval$high - est$interval$low) / (2 * stats::qnorm(0.975)) - r$diagnostics$se) < 1e-9
  list(pass = ok,
       detail = sprintf("anchored: marginal log odds ratio in the aggregate trial's population %.10f vs by hand %.10f; indirect estimate %.8f = that + 0.25 (standardisation mcse %.5f); unanchored: logit of the active arm's predicted mean %.8f vs by hand %.8f, estimate %.8f vs %.8f; conclusion %s",
                        v(r, "marginal_contrast_ipd"), hand, est$value, est$mcse, v(ru, "marginal_level_ipd"), stats::qlogis(m_u), v(ru, "indirect_estimate"), hand_u, ru$conclusion))
})

vcr_case("N73b", c("AC-08", "AC-11", "AC-30"), function() {
  # Known truth. Over 300 simulated IPD trials the G-computation estimate averages to the marginal log odds ratio in the aggregate trial's population
  # (within 3.5 Monte-Carlo errors); the conventional STC - the arm coefficient with the covariates centred at the aggregate means - is a different number
  # on the logit link, because it is a conditional effect, and it is off from the marginal truth by far more than its own error.
  set.seed(20261111L, kind = VCR_RNG_KIND)
  tr <- .n73_truth(TRUE)
  rho <- diag(2)
  pop <- vcr_population_literature(.n73_agd, 40000L, rho, "assumed", 1L, seed = 3L)$data[, c("x1", "x2")]
  R <- 300L
  res <- t(replicate(R, {
    d <- .n73_gen(600L); X <- as.matrix(d[, c("x1", "x2")])
    g <- vcr_stc_gcomp(d$y, d$arm, X, "x1", pop, stats::binomial(), "logit", TRUE)$estimate
    cv <- vcr_stc(d$y, d$arm, X, c(x1 = 0.8, x2 = 0.6), stats::binomial())$estimate
    c(g = g, cv = cv)
  }))
  bias <- colMeans(res) - tr$contrast; mcse <- apply(res, 2, stats::sd) / sqrt(R)
  ok <- abs(bias[["g"]]) < 3.5 * mcse[["g"]] && abs(bias[["cv"]]) > 8 * mcse[["cv"]] && abs(bias[["cv"]]) > 0.04
  list(pass = ok,
       detail = sprintf("true marginal log odds ratio in the aggregate trial's population %.5f (marginal means %.4f / %.4f); G-computation mean %.5f, bias %.5f (mcse %.5f, %.1f errors); the conventional (conditional) STC mean %.5f, bias %.5f (mcse %.5f, %.1f errors); %d trials of 600",
                        tr$contrast, tr$m1, tr$m0, mean(res[, "g"]), bias[["g"]], mcse[["g"]], bias[["g"]] / mcse[["g"]], mean(res[, "cv"]), bias[["cv"]], mcse[["cv"]], bias[["cv"]] / mcse[["cv"]], R))
})

vcr_case("N73c", c("AC-08", "AC-30"), function() {
  # Against the MAIC on one case. A continuous outcome with a linear predictor and an effect modifier: the conditional and the marginal effect are the same number,
  # and so is the MAIC's weighted contrast when it matches the covariate means. The two jobs run on the same IPD and the same aggregate contrast; their
  # estimates are within their combined error of each other and of the truth.
  set.seed(20261112L, kind = VCR_RNG_KIND)
  d <- .n73_gen(1500L, binary = FALSE)
  tr <- .n73_truth(FALSE)
  stc <- vcr_test_run(.n73_job(d, "n73c_stc", binary = FALSE, scenario = list(aggregateEstimate = 0.3, aggregateSe = 0.1)))
  maic <- vcr_test_run(vcr_test_job("comparator.maic", list(covariates = list("x1", "x2"), targets = list(x1 = 0.8, x2 = 0.6), treatmentColumn = "arm", endpoint = list(type = "continuous"),
                                                              anchored = TRUE, aggregateEstimate = 0.3, aggregateSe = 0.1, outcomeColumn = "y", link = "identity"),
                                    list(vcr_test_input(d, "snp_n73c_maic:subject", "subject")), seed = 9L, job_id = "job_n73c_maic", replicates = 400L))
  dp <- d; dp$y <- 0.2 + 0.6 * d$x1 + 0.4 * d$x2 - 0.5 * d$arm + stats::rnorm(nrow(d))     # no modifier in the data, none in the model
  plain <- vcr_test_run(.n73_job(dp, "n73c_plain", binary = FALSE, scenario = list(effectModifiers = NULL, aggregateEstimate = 0.3, aggregateSe = 0.1)))
  e_s <- vcr_get_measure(stc, "indirect_estimate"); e_m <- vcr_get_measure(maic, "indirect_estimate")
  truth <- tr$contrast - 0.3
  se_s <- stc$diagnostics$se; se_m <- maic$diagnostics$se
  ok <- identical(stc$status, "succeeded") && identical(maic$status, "succeeded") &&
    abs(e_s$value - e_m$value) < sqrt(se_s^2 + se_m^2) && abs(e_s$value - truth) < 3 * se_s && abs(e_m$value - truth) < 3 * se_m &&
    # with an effect modifier the conventional STC (no interaction term) is the effect at the IPD's own mean, and is far from the marginal one; without a modifier
    # in the model and in the data, on the identity link, the conditional and the marginal effect are the same number
    abs(vcr_measure_value(stc, "marginal_contrast_ipd") - vcr_measure_value(stc, "conditional_contrast_ipd")) > 0.2 &&
    abs(vcr_measure_value(plain, "marginal_contrast_ipd") - vcr_measure_value(plain, "conditional_contrast_ipd")) < 1e-9
  list(pass = ok,
       detail = sprintf("continuous outcome, linear predictor with an effect modifier: the aggregate trial's effect %.4f; STC %.4f (se %.4f), MAIC %.4f (se %.4f), their difference %.4f; the truth for A against B is %.4f; the marginal and the conventional (conditional) STC effect %.4f / %.4f with the modifier, %.8f / %.8f without",
                        tr$contrast, e_s$value, se_s, e_m$value, se_m, e_s$value - e_m$value, truth, vcr_measure_value(stc, "marginal_contrast_ipd"), vcr_measure_value(stc, "conditional_contrast_ipd"),
                        vcr_measure_value(plain, "marginal_contrast_ipd"), vcr_measure_value(plain, "conditional_contrast_ipd")))
})

vcr_case("N73d", c("AC-07", "AC-30"), function() {
  # Refusals by name and the fixed weights: a covariate with no aggregate summary, an aggregate outcome off the link's domain, the logit link for a continuous
  # outcome, a synthetic table, and the correlation the person states instead of the IPD's.
  set.seed(20261113L, kind = VCR_RNG_KIND)
  d <- .n73_gen(300L)
  run <- function(sc, id, input = NULL) {
    j <- .n73_job(d, id, scenario = sc, replicates = 200L); if (!is.null(input)) j$inputs <- list(input); vcr_test_run(j)
  }
  jm <- .n73_job(d, "n73d1", replicates = 200L); jm$scenario$aggregateCovariates <- list(.n73_agd[[1]])
  miss <- vcr_test_run(jm)
  off <- run(list(anchored = FALSE, aggregateEstimate = NULL, aggregateOutcome = 1.4, aggregateSe = 0.04), "n73d2")
  lg <- run(list(endpoint = list(type = "continuous"), link = "logit"), "n73d3")
  syn <- run(list(), "n73d4", input = vcr_test_input(d, "snp_n73d4:subject", "subject", source = "synthetic"))
  stated <- run(list(correlation = list(list(1, 0.3), list(0.3, 1))), "n73d5")
  ok <- identical(miss$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(miss) && identical(off$status, "failed") && identical(lg$status, "failed") && identical(syn$status, "failed") &&
    identical(stated$status, "succeeded") && identical(stated$diagnostics$correlation$source, "stated")
  list(pass = ok,
       detail = sprintf("no summary for a covariate: %s; an aggregate outcome of 1.4 on the logit link: %s; the logit link for a continuous outcome: %s; a synthetic table: %s; a stated correlation: %s (source %s)",
                        paste(miss$status, paste(vcr_test_issue_codes(miss), collapse = ",")), paste(off$status, paste(vcr_test_issue_codes(off), collapse = ",")),
                        paste(lg$status, paste(vcr_test_issue_codes(lg), collapse = ",")), paste(syn$status, paste(vcr_test_issue_codes(syn), collapse = ",")), stated$status, stated$diagnostics$correlation$source))
})
