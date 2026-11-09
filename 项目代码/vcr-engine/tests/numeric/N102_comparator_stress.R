# N102 — known-truth stress tests of a single-arm trial against an external control (in silico plan T13): measured confounding,
# selection into the trial with an effect that depends on who is selected (what does not transport), and an unmeasured confounder.
# No estimator is new: comparator.aipw is the method, held to truths set by the case's own simulation.
#
# One design, in every case: the trial's people have x1 ~ N(0.5, 1) and the external source's x1 ~ N(0, 1); the control outcome is
# 1 + 0.8 x1 + 0.5 x2 + gamma u + noise, and a treated person gains 0.4 + 0.6 x1. So the effect in the trial's own population (the
# ATT) is 0.4 + 0.6 * 0.5 = 0.7 exactly, and the effect in the external source's population would be 0.4 + 0.6 * 0 = 0.4. An unmeasured
# u is shifted by `shift` in the trial, so it is a confounder only when gamma and shift are both nonzero.

.n102_gen <- function(n1, n0, gamma = 0, shift = 0) {
  arm <- c(rep(1L, n1), rep(0L, n0))
  x1 <- c(stats::rnorm(n1, 0.5, 1), stats::rnorm(n0, 0, 1))
  x2 <- c(stats::rbinom(n1, 1L, 0.6), stats::rbinom(n0, 1L, 0.4))
  u <- stats::rnorm(n1 + n0, ifelse(arm == 1L, shift, 0), 1)
  y <- 1 + 0.8 * x1 + 0.5 * x2 + gamma * u + arm * (0.4 + 0.6 * x1) + stats::rnorm(n1 + n0)
  data.frame(USUBJID = sprintf("S%05d", seq_len(n1 + n0)), arm = arm, x1 = x1, x2 = x2, y = y)
}

.n102_run <- function(R, n1, n0, gamma = 0, shift = 0) {
  res <- replicate(R, {
    d <- .n102_gen(n1, n0, gamma, shift)
    fit <- vcr_aipw_att(d$y, d$arm, as.matrix(d[, c("x1", "x2")]), as.matrix(d[, c("x1", "x2")]), FALSE)
    c(est = fit$tau, naive = mean(d$y[d$arm == 1L]) - mean(d$y[d$arm == 0L]))
  })
  list(est = res["est", ], naive = res["naive", ])
}

vcr_case("N102a", c("AC-08", "AC-11", "AC-30"), function() {
  # Measured confounding: the trial's people differ from the external controls in x1 and x2, which also drive the outcome. The
  # unadjusted difference is biased by E[y0 | trial] - E[y0 | control] = 0.8 * 0.5 + 0.5 * 0.2 = 0.5; the doubly robust estimate is
  # unbiased for the ATT 0.7 (to a fifth of its standard deviation over 300 trials), and one job through the engine lands within three of
  # its own standard errors of 0.7 while the naive difference of the same table does not.
  set.seed(20261107L, kind = VCR_RNG_KIND)
  R <- 300L; truth <- 0.7
  r <- .n102_run(R, 150L, 600L)
  sd_est <- stats::sd(r$est); bias <- mean(r$est) - truth; naive_bias <- mean(r$naive) - truth
  d <- .n102_gen(300L, 1200L)
  job <- vcr_test_run(vcr_test_job("comparator.aipw", list(covariates = list("x1", "x2"), propensityCovariates = list("x1", "x2"), treatmentColumn = "arm", outcomeColumn = "y",
    endpoint = list(type = "continuous")), list(vcr_test_input(d, "snp_n102a:subject", "subject")), seed = 11L, job_id = "job_n102a", cores = 1L))
  est <- vcr_measure_value(job, "aipw_difference"); se <- vcr_measure_value(job, "aipw_difference_se_influence")
  naive <- mean(d$y[d$arm == 1L]) - mean(d$y[d$arm == 0L])
  ok <- identical(job$status, "succeeded") && abs(bias) <= 0.2 * sd_est && abs(naive_bias - 0.5) < 0.03 && abs(est - truth) < 3 * se && abs(naive - truth) > 3 * se &&
    length(vcr_validate_result(job)) == 0L
  list(pass = ok,
       detail = sprintf("true ATT %.2f; over %d trials of 150 + 600 the doubly robust bias %+.4f (%.2f sd of %.4f), the unadjusted bias %+.4f against the closed form 0.5; one job of 300 + 1200: estimate %.4f (se %.4f), unadjusted %.4f",
                        truth, R, bias, bias / sd_est, sd_est, naive_bias, est, se, naive))
})

vcr_case("N102b", c("AC-08", "AC-11", "AC-30"), function() {
  # Selection and transport: the effect depends on x1 and the trial selects higher x1, so the estimate is the effect among the trial's
  # people (0.7) and is NOT the effect the external source's own population would have (0.4). Over 300 trials of 300 + 1200 the mean
  # estimate is 0.7 to a fifth of its standard deviation and lies more than three standard deviations above 0.4: the result is about
  # the people who were in the comparison, which is why the page names the independent real external dataset a claim about another
  # population would need.
  set.seed(20261108L, kind = VCR_RNG_KIND)
  R <- 300L
  r <- .n102_run(R, 300L, 1200L)
  sd_est <- stats::sd(r$est); m <- mean(r$est)
  ok <- abs(m - 0.7) <= 0.2 * sd_est && (m - 0.4) > 3 * sd_est
  list(pass = ok,
       detail = sprintf("effect in the trial's population 0.7, in the external source's population 0.4; mean estimate over %d trials of 300 + 1200 %.4f (sd %.4f): %.2f sd from 0.7, %.1f sd above 0.4",
                        R, m, sd_est, (m - 0.7) / sd_est, (m - 0.4) / sd_est))
})

vcr_case("N102c", c("AC-08", "AC-11", "AC-30"), function() {
  # An unmeasured confounder: u lifts the outcome (gamma 1) and is 0.8 higher in the trial, so adjusting for the measured x1 and x2
  # cannot remove it. The estimate is biased by gamma * shift = 0.8 (to a tenth of that) and the bias is more than five standard
  # deviations: no adjustment for what was measured corrects it. What this holds is the estimator's behaviour under the simulation's
  # own confounder; it does not test a premise or an E-value (comparator.aipw writes no E-value for a continuous outcome).
  set.seed(20261109L, kind = VCR_RNG_KIND)
  R <- 300L
  r <- .n102_run(R, 150L, 600L, gamma = 1, shift = 0.8)
  sd_est <- stats::sd(r$est); bias <- mean(r$est) - 0.7
  ok <- abs(bias - 0.8) < 0.08 && bias > 5 * sd_est
  list(pass = ok,
       detail = sprintf("true ATT 0.70; the unmeasured confounder's closed-form bias 0.8; mean estimate over %d trials %.4f: bias %+.4f (%.1f sd of %.4f)", R, mean(r$est), bias, bias / sd_est, sd_est))
})

vcr_case("N102d", c("AC-08", "AC-11", "AC-30"), function() {
  # Double robustness, each half on its own (review stats P2-9): with both working models right, any one of the three estimators is
  # unbiased, so a broken correction term would pass N102a. Here one model is wrong at a time. Leaving x2 out of the outcome model biases
  # the regression estimate by 0.5 * (0.6 - 0.4) = 0.1 (x2 is independent of x1 in each source), and leaving it out of the propensity
  # model biases the weighting estimate by the same 0.1; the doubly robust estimate stays within a fifth of its standard deviation of the
  # ATT 0.7 in both, and its influence-function interval covers 0.7 in at least 90% of 300 trials (nominal 95%, three Monte-Carlo SEs).
  set.seed(20261110L, kind = VCR_RNG_KIND)
  R <- 300L; truth <- 0.7
  both <- c("x1", "x2"); only <- "x1"
  one <- function(ps, out) {
    res <- replicate(R, {
      d <- .n102_gen(150L, 600L)
      fit <- vcr_aipw_att(d$y, d$arm, as.matrix(d[, ps, drop = FALSE]), as.matrix(d[, out, drop = FALSE]), FALSE)
      c(est = fit$tau, regression = fit$regression, weighting = fit$weighting, se = fit$influence$se)
    })
    list(est = res["est", ], regression = res["regression", ], weighting = res["weighting", ],
         covered = mean(abs(res["est", ] - truth) <= stats::qnorm(0.975) * res["se", ]))
  }
  wrong_out <- one(both, only)
  wrong_ps <- one(only, both)
  sd1 <- stats::sd(wrong_out$est); sd2 <- stats::sd(wrong_ps$est)
  b1 <- mean(wrong_out$est) - truth; b2 <- mean(wrong_ps$est) - truth
  br <- mean(wrong_out$regression) - truth; bw <- mean(wrong_ps$weighting) - truth
  ok <- abs(b1) <= 0.2 * sd1 && abs(b2) <= 0.2 * sd2 && abs(br - 0.1) < 0.03 && abs(bw - 0.1) < 0.03 &&
    wrong_out$covered >= 0.9 && wrong_ps$covered >= 0.9
  list(pass = ok,
       detail = sprintf("ATT 0.70; outcome model without x2: regression bias %+.4f (closed form 0.1), doubly robust bias %+.4f (%.2f sd), coverage %.3f; propensity without x2: weighting bias %+.4f (closed form 0.1), doubly robust bias %+.4f (%.2f sd), coverage %.3f",
                        br, b1, b1 / sd1, wrong_out$covered, bw, b2, b2 / sd2, wrong_ps$covered))
})
