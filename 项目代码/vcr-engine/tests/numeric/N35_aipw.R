# N35 — comparator.aipw: a doubly robust estimate of the effect in the trial's own
# population (the ATT) for a single-arm study against an external control.
#
# References that are not this method's own code: the estimator written out again
# in the case from its formula on WeightIt's weights and `stats::glm` fits; a
# simulation whose true ATT is integrated exactly (Gauss-Hermite) rather than
# simulated, with four specifications of the two working models (both right, either
# wrong, both wrong), which is what "doubly robust" means; and a continuous outcome
# whose effect is a known constant.

# trial (arm 1: x1 ~ N(0.5, 1), x2 ~ Bernoulli(0.6)) against an external source
# (arm 0: x1 ~ N(0, 1), x2 ~ Bernoulli(0.4)); the control outcome is logistic in
# x1, x2 and x1^2 and the trial's logit is 0.9 higher. The membership model is
# exactly logistic in (x1, x2); the outcome model needs x1^2.
.n35_gen <- function(n1 = 150L, n0 = 600L) {
  x1 <- c(stats::rnorm(n1, 0.5, 1), stats::rnorm(n0, 0, 1)); x2 <- c(stats::rbinom(n1, 1L, 0.6), stats::rbinom(n0, 1L, 0.4))
  arm <- c(rep(1L, n1), rep(0L, n0))
  lp0 <- -0.5 + 0.8 * x1 + 0.5 * x2 + 0.4 * x1^2
  y <- ifelse(arm == 1L, stats::rbinom(n1 + n0, 1L, stats::plogis(lp0 + 0.9)), stats::rbinom(n1 + n0, 1L, stats::plogis(lp0)))
  data.frame(USUBJID = sprintf("S%04d", seq_len(n1 + n0)), arm = arm, x1 = x1, x2 = x2, x1sq = x1^2, y = y)
}

# the true ATT risk difference of that design, by Gauss-Hermite over x1 and the two values of x2
.n35_truth <- function() {
  gh <- .vcr_gauss_hermite(60L); x1 <- 0.5 + sqrt(2) * gh$nodes; wx <- gh$weights / sqrt(pi)
  sum(vapply(0:1, function(x2) (if (x2 == 1L) 0.6 else 0.4) * sum(wx * (stats::plogis(-0.5 + 0.8 * x1 + 0.5 * x2 + 0.4 * x1^2 + 0.9) - stats::plogis(-0.5 + 0.8 * x1 + 0.5 * x2 + 0.4 * x1^2))), numeric(1)))
}

.n35_job <- function(d, id, scenario = list(), seed = 11L, cores = 1L, endpoint = "binary") {
  sc <- utils::modifyList(list(covariates = list("x1", "x2", "x1sq"), propensityCovariates = list("x1", "x2"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = endpoint)), scenario)
  vcr_test_job("comparator.aipw", sc, list(vcr_test_input(d, paste0("snp_", id, ":subject"), "subject")), seed = seed, job_id = paste0("job_", id), cores = cores)
}

vcr_case("N35a", c("AC-08", "AC-30"), function() {
  # The estimator from its formula, outside the engine: WeightIt's logistic ATT weights (the control odds
  # e / (1 - e)), the outcome model fitted by stats::glm on the external controls alone, the augmented control
  # mean, the effect and the efficient-influence-function standard error. The job must give the same numbers,
  # for a binary and for a continuous outcome, with the two models on different covariates.
  suppressMessages(library(WeightIt))
  set.seed(20261004L, kind = VCR_RNG_KIND)
  d <- .n35_gen()
  by_hand <- function(d, binary, ps_form, out_form) {
    wi <- WeightIt::weightit(ps_form, data = d, method = "glm", estimand = "ATT")
    t1 <- d$arm == 1L; w <- ifelse(t1, 0, wi$weights)          # WeightIt's ATT weight of a control is its odds
    om <- stats::glm(out_form, data = d[!t1, ], family = if (binary) stats::binomial() else stats::gaussian())
    m0 <- stats::predict(om, d, type = "response")
    mu1 <- mean(d$y[t1]); n1 <- sum(t1); N <- nrow(d)
    mu0 <- (sum(m0[t1]) + sum(w[!t1] * (d$y - m0)[!t1])) / n1
    p <- n1 / N
    psi <- t1 * (d$y - mu1) / p - (t1 * (m0 - mu0) + (!t1) * w * (d$y - m0)) / p
    list(tau = mu1 - mu0, mu0 = mu0, mu1 = mu1, se = sqrt(stats::var(psi) / N), w = wi$weights[!t1],
         reg = mu1 - mean(m0[t1]), ipw = mu1 - sum(w[!t1] * d$y[!t1]) / sum(w[!t1]))
  }
  hb <- by_hand(d, TRUE, arm ~ x1 + x2, y ~ x1 + x2 + x1sq)
  dc <- d; dc$y <- 1 + 0.5 * d$x1 + 0.3 * d$x2 + 0.2 * d$x1sq + stats::rnorm(nrow(d)) + 0.7 * d$arm
  hc <- by_hand(dc, FALSE, arm ~ x1 + x2, y ~ x1 + x2 + x1sq)
  dir <- tempfile("n35a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  rb <- vcr_test_run(.n35_job(d, "n35a_b"), output_dir = dir)
  rc <- vcr_test_run(.n35_job(dc, "n35a_c", endpoint = "continuous"))
  v <- function(r, name) vcr_measure_value(r, name)
  tab <- vcr_test_table(rb, "weights", dir)
  w_job <- tab$oddsWeight[tab$arm == 0L]
  ok <- identical(rb$status, "succeeded") && identical(rc$status, "succeeded") &&
    abs(v(rb, "aipw_difference") - hb$tau) < 1e-10 && abs(v(rb, "outcome_mean_control_adjusted") - hb$mu0) < 1e-10 && abs(v(rb, "outcome_mean_treated") - hb$mu1) < 1e-12 &&
    abs(v(rb, "aipw_difference_se_influence") - hb$se) < 1e-10 && max(abs(w_job - hb$w)) < 1e-8 &&
    abs(rb$diagnostics$components$outcomeRegression - hb$reg) < 1e-10 && abs(rb$diagnostics$components$weighting - hb$ipw) < 1e-10 &&
    abs(v(rc, "aipw_difference") - hc$tau) < 1e-10 && abs(v(rc, "aipw_difference_se_influence") - hc$se) < 1e-10 &&
    is.null(vcr_get_measure(rc, "aipw_risk_ratio")) && !is.null(vcr_get_measure(rb, "aipw_risk_ratio")) && !is.null(vcr_get_measure(rb, "aipw_odds_ratio")) &&
    isTRUE(abs(v(rb, "aipw_risk_ratio") - hb$mu1 / hb$mu0) < 1e-10) && length(vcr_validate_result(rb)) == 0L && length(vcr_validate_result(rc)) == 0L &&
    identical(rb$counts$realPatients, 750L) && rb$counts$effectiveSampleSize <= 600
  list(pass = ok,
       detail = sprintf("binary: effect %.10f vs by hand %.10f, adjusted control mean %.10f vs %.10f, influence-function se %.10f vs %.10f, control odds weights vs WeightIt max diff %.1e; continuous: effect %.10f vs %.10f, se %.10f vs %.10f; the outcome-model-only and weighting-only estimates %.6f / %.6f beside the augmented %.6f; risk ratio %.6f = %.6f",
                        v(rb, "aipw_difference"), hb$tau, v(rb, "outcome_mean_control_adjusted"), hb$mu0, v(rb, "aipw_difference_se_influence"), hb$se, max(abs(w_job - hb$w)),
                        v(rc, "aipw_difference"), hc$tau, v(rc, "aipw_difference_se_influence"), hc$se,
                        rb$diagnostics$components$outcomeRegression, rb$diagnostics$components$weighting, v(rb, "aipw_difference"), v(rb, "aipw_risk_ratio"), hb$mu1 / hb$mu0))
})

vcr_case("N35b", c("AC-08", "AC-11", "AC-30"), function() {
  # Double robustness, against a truth integrated exactly. The same simulated data is analysed under four
  # specifications of the two working models: either wrong leaves the estimate unbiased (to a fifth of its
  # standard deviation), both wrong does not (a bias of about two standard deviations: the negative control of the
  # case). With both right the influence-function interval covers at the nominal rate.
  truth <- .n35_truth()
  specs <- list(both_right = list(ps = c("x1", "x2"), out = c("x1", "x2", "x1sq")),
                outcome_wrong = list(ps = c("x1", "x2"), out = "x2"),
                ps_wrong = list(ps = "x2", out = c("x1", "x2", "x1sq")),
                both_wrong = list(ps = "x2", out = "x2"))
  one <- function(i) {
    d <- .n35_gen()
    unlist(lapply(specs, function(sp) { r <- vcr_aipw_att(d$y, d$arm, as.matrix(d[, sp$ps, drop = FALSE]), as.matrix(d[, sp$out, drop = FALSE]), TRUE); c(r$tau, r$influence$se) }))
  }
  K <- 800L
  est <- do.call(rbind, vcr_map_streams(vcr_stream_bank(35L)$take(K), one, cores = VCR_TEST_CORES))
  col <- function(nm, j) est[, 2 * (match(nm, names(specs)) - 1L) + j]
  stats_of <- function(nm) { tau <- col(nm, 1L); se <- col(nm, 2L)
    list(bias = mean(tau) - truth, sd = stats::sd(tau), mcse = stats::sd(tau) / sqrt(K), cover = mean(abs(tau - truth) < stats::qnorm(0.975) * se), se_ratio = mean(se) / stats::sd(tau)) }
  st <- lapply(names(specs), stats_of); names(st) <- names(specs)
  single_ok <- vapply(c("both_right", "outcome_wrong", "ps_wrong"), function(nm) abs(st[[nm]]$bias) <= 0.2 * st[[nm]]$sd, logical(1))
  wrong_ok <- st$both_wrong$bias >= 1.5 * st$both_wrong$sd
  cover_ok <- abs(st$both_right$cover - 0.95) <= 3 * sqrt(0.95 * 0.05 / K) + 0.01 && abs(st$both_right$se_ratio - 1) < 0.08
  list(pass = all(single_ok) && wrong_ok && cover_ok,
       detail = sprintf("true ATT %.5f (Gauss-Hermite); bias / sd over %d datasets of 150 + 600: both right %+.4f / %.4f (%.2f sd), outcome model wrong %+.4f (%.2f sd), propensity model wrong %+.4f (%.2f sd), both wrong %+.4f (%.2f sd, the model-free negative control); influence-function coverage with both right %.3f (se / sd %.3f)",
                        truth, K, st$both_right$bias, st$both_right$sd, st$both_right$bias / st$both_right$sd, st$outcome_wrong$bias, st$outcome_wrong$bias / st$outcome_wrong$sd,
                        st$ps_wrong$bias, st$ps_wrong$bias / st$ps_wrong$sd, st$both_wrong$bias, st$both_wrong$bias / st$both_wrong$sd, st$both_right$cover, st$both_right$se_ratio))
})

vcr_case("N35c", c("AC-08", "AC-11", "AC-28", "AC-31"), function() {
  # The two standard errors agree where they should, every bootstrapped number carries its Monte-Carlo error, the
  # numbers do not depend on the core count, and a continuous outcome with a known constant effect is recovered by
  # either model alone being right.
  set.seed(20261004L, kind = VCR_RNG_KIND)
  d <- .n35_gen()
  r1 <- vcr_test_run(.n35_job(d, "n35c_1", cores = 1L)); r2 <- vcr_test_run(.n35_job(d, "n35c_2", cores = 2L))
  b <- r1$diagnostics$bootstrap; se_b <- vcr_get_measure(r1, "aipw_difference_se_bootstrap"); vc <- r1$diagnostics$varianceComparison
  same <- identical(vcr_get_measure(r1, "aipw_difference")$interval, vcr_get_measure(r2, "aipw_difference")$interval) && identical(se_b$value, vcr_get_measure(r2, "aipw_difference_se_bootstrap")$value)
  ivl <- function(r, name) unlist(vcr_get_measure(r, name)$interval[c("low", "high")])
  inf_ci <- ivl(r1, "aipw_difference_influence"); boot_ci <- ivl(r1, "aipw_difference")
  # continuous, effect 0.7 exactly; either model alone right
  one <- function(i) {
    dd <- .n35_gen(); dd$y <- 1 + 0.5 * dd$x1 + 0.3 * dd$x2 + 0.2 * dd$x1sq + stats::rnorm(nrow(dd)) + 0.7 * dd$arm
    f <- function(ps, out) vcr_aipw_att(dd$y, dd$arm, as.matrix(dd[, ps, drop = FALSE]), as.matrix(dd[, out, drop = FALSE]), FALSE, with_if = FALSE)$tau
    c(f(c("x1", "x2"), c("x1", "x2", "x1sq")), f(c("x1", "x2"), "x2"), f("x2", c("x1", "x2", "x1sq")))
  }
  K <- 300L
  cont <- do.call(rbind, vcr_map_streams(vcr_stream_bank(36L)$take(K), one, cores = VCR_TEST_CORES))
  bias <- colMeans(cont) - 0.7; mcse <- apply(cont, 2, stats::sd) / sqrt(K)
  ok <- identical(r1$status, "succeeded") && b$replicates == 2000L && b$failureShare == 0 && isTRUE(se_b$simulated) && se_b$mcse > 0 && se_b$mcse < 0.05 * se_b$value &&
    is.finite(b$intervalMcse$low) && is.finite(b$intervalMcse$high) && vc$ratioInfluenceToBootstrap > 0.9 && vc$ratioInfluenceToBootstrap < 1.1 && same &&
    inf_ci[1] < boot_ci[1] + 0.03 && inf_ci[2] > boot_ci[2] - 0.03 && all(abs(bias) <= 3 * mcse + 0.005) && length(vcr_validate_result(r1)) == 0L
  list(pass = ok,
       detail = sprintf("influence-function se %.4f vs bootstrap se %.4f (ratio %.3f; bootstrap mcse %.5f = %.1f%% of it, %d draws, interval mcse %.4f/%.4f); influence interval [%.4f, %.4f], bootstrap interval [%.4f, %.4f]; one core and two give the same numbers: %s; continuous, true effect 0.7, bias both right %+.4f, outcome model alone right %+.4f, propensity model alone right %+.4f (mcse %.4f/%.4f/%.4f)",
                        vc$influenceSe, vc$bootstrapSe, vc$ratioInfluenceToBootstrap, se_b$mcse, 100 * se_b$mcse / se_b$value, b$replicates, b$intervalMcse$low, b$intervalMcse$high,
                        inf_ci[1], inf_ci[2], boot_ci[1], boot_ci[2], same, bias[1], bias[2], bias[3], mcse[1], mcse[2], mcse[3]))
})

vcr_case("N35d", c("AC-07", "AC-08", "AC-09"), function() {
  # Refusals and qualifications, each by its own name: a trial with no overlapping controls, two collinear outcome
  # covariates, fewer controls than the outcome model has coefficients, a binary outcome that is not 0/1, an outcome
  # model that separates (the estimate is kept and the result says so), and an adjusted control risk that is not
  # positive (the difference is kept, the ratios are not invented).
  set.seed(20261004L, kind = VCR_RNG_KIND)
  d <- .n35_gen(n1 = 120L, n0 = 300L)
  far <- d; far$x1[far$arm == 1L] <- far$x1[far$arm == 1L] + 6; far$x1sq <- far$x1^2
  r_far <- vcr_test_run(.n35_job(far, "n35d_far"))
  col <- d; col$x1copy <- col$x1
  r_col <- vcr_test_run(.n35_job(col, "n35d_col", list(outcomeCovariates = list("x1", "x1copy", "x2"))))
  few <- d[c(which(d$arm == 1L), which(d$arm == 0L)[1:3]), ]
  r_few <- vcr_test_run(.n35_job(few, "n35d_few", list(outcomeCovariates = list("x1", "x2", "x1sq"))))
  bad_y <- d; bad_y$y[5] <- 2
  r_bad <- vcr_test_run(.n35_job(bad_y, "n35d_bad"))
  na_y <- d; na_y$y[5] <- NA
  r_na <- vcr_test_run(.n35_job(na_y, "n35d_na"))
  sep <- d; sep$y[sep$arm == 0L] <- 0L
  r_sep <- vcr_test_run(.n35_job(sep, "n35d_sep"))
  # a small data set with a rare control outcome (this seed: one the controls hardly have), whose augmented control
  # mean comes out not positive although the overlap is good
  set.seed(232L, kind = VCR_RNG_KIND)
  n1 <- 40L; n0 <- 80L
  x1 <- c(stats::rnorm(n1, 0.5, 1), stats::rnorm(n0, 0, 1)); arm <- c(rep(1L, n1), rep(0L, n0))
  y <- c(stats::rbinom(n1, 1L, 0.5), stats::rbinom(n0, 1L, stats::plogis(-2.5 + 0.9 * x1[(n1 + 1L):(n1 + n0)])))
  neg <- data.frame(USUBJID = sprintf("N%03d", seq_len(n1 + n0)), arm = arm, x1 = x1, y = y)
  r_neg <- vcr_test_run(vcr_test_job("comparator.aipw", list(covariates = list("x1"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "binary")),
                                     list(vcr_test_input(neg, "snp_n35d_neg:subject", "subject")), seed = 2L, job_id = "job_n35d_neg"))
  codes <- function(r) paste(vcr_test_issue_codes(r), collapse = ",")
  ok <- identical(r_far$status, "not_estimable") && r_far$notEstimableRule %in% c("outside_common_support", "effective_sample_size_below_floor") && length(r_far$measures) == 0L &&
    identical(r_col$status, "not_estimable") && identical(r_col$notEstimableRule, "nuisance_model_not_estimable") && length(r_col$measures) == 0L &&
    identical(r_few$status, "not_estimable") && identical(r_few$notEstimableRule, "nuisance_model_not_estimable") &&
    identical(r_bad$status, "failed") && "input_shape_invalid" %in% vcr_test_issue_codes(r_bad) && identical(r_na$status, "failed") && "input_shape_invalid" %in% vcr_test_issue_codes(r_na) &&
    identical(r_sep$status, "succeeded") && identical(r_sep$conclusion, "limited") && "outcome_model_separation" %in% unlist(r_sep$diagnostics$limitedBy) && !is.null(vcr_get_measure(r_sep, "aipw_difference")) &&
    identical(r_neg$status, "succeeded") && vcr_measure_value(r_neg, "outcome_mean_control_adjusted") < 0 && !is.null(vcr_get_measure(r_neg, "aipw_difference")) &&
    identical(r_neg$conclusion, "limited") && "adjusted_control_mean_outside_unit_interval" %in% unlist(r_neg$diagnostics$limitedBy) &&
    is.null(vcr_get_measure(r_neg, "aipw_risk_ratio")) && is.null(vcr_get_measure(r_neg, "aipw_odds_ratio")) &&
    all(vapply(list(r_far, r_col, r_few, r_bad, r_na, r_sep, r_neg), function(r) length(vcr_validate_result(r)) == 0L, logical(1)))
  list(pass = ok,
       detail = sprintf("trial shifted 6 SD off the controls -> %s; a duplicated covariate -> %s; 3 controls for a 4-coefficient outcome model -> %s; outcome 2 -> %s; missing outcome -> %s; all-zero control outcomes -> %s, conclusion %s, flagged %s with the estimate kept; adjusted control risk %.2e (not positive) -> effect %.4f kept, risk and odds ratios not written",
                        r_far$notEstimableRule, r_col$notEstimableRule, r_few$notEstimableRule, codes(r_bad), codes(r_na), r_sep$status, r_sep$conclusion,
                        paste(unlist(r_sep$diagnostics$limitedBy), collapse = "+"), vcr_measure_value(r_neg, "outcome_mean_control_adjusted"), vcr_measure_value(r_neg, "aipw_difference")))
})
