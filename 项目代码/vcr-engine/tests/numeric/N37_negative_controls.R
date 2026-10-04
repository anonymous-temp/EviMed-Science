# N37 — negative-control outcomes: the screen, the empirical null and the calibrated p-value.
#
# References that are not this method's own code: the `sccs` example of
# EmpiricalCalibration 3.1.4 (Apache-2.0, vendored under tests/fixtures with its
# license: 45 negative controls and sertraline) with the numbers that package's
# vignette prints; metafor's maximum-likelihood random-effects fit, which is the
# same likelihood written by someone else; WeightIt's entropy-balancing weights;
# and a simulation whose unmeasured-confounding bias is known in closed form.

.n37_sccs <- function() {
  d <- utils::read.csv(file.path(VCR_ROOT, "tests", "fixtures", "empirical-calibration-3.1.4", "sccs.csv"), stringsAsFactors = FALSE)
  list(neg = d[d$groundTruth == 0, ], pos = d[d$groundTruth == 1, ])
}

.n37_supplied <- function(neg, primary = NULL) {
  sc <- list(controls = lapply(seq_len(nrow(neg)), function(i) list(name = neg$drugName[i], estimate = neg$logRr[i], se = neg$seLogRr[i])))
  if (!is.null(primary)) sc$primary <- list(name = primary$drugName, estimate = primary$logRr, se = primary$seLogRr)
  sc
}

vcr_case("N37a", c("AC-07", "AC-30"), function() {
  # The published reference: EmpiricalCalibration 3.1.4's sccs example (45 negative
  # controls, sertraline as the effect of interest). Its vignette prints a null of
  # mean 0.7922 and SD 0.2834 and a calibrated p of 0.8389; the package stops its
  # optimizer at a looser tolerance than ours, so the three agree to a few 1e-4
  # (measured: 8e-5, 1e-5, 1e-4), not to machine precision. The likelihood itself
  # is held to metafor's maximum-likelihood random-effects fit (same model, other
  # code), to 1e-5.
  suppressMessages(library(metafor))
  s <- .n37_sccs()
  r <- vcr_test_run(vcr_test_job("comparator.negative_control", .n37_supplied(s$neg, s$pos), job_id = "job_n37a"))
  mu <- vcr_measure_value(r, "empirical_null_mean"); tau <- vcr_measure_value(r, "empirical_null_sd")
  p_cal <- vcr_measure_value(r, "calibrated_p_value"); p_raw <- vcr_measure_value(r, "uncalibrated_p_value")
  ml <- metafor::rma(yi = s$neg$logRr, sei = s$neg$seLogRr, method = "ML")
  p_hand <- 2 * stats::pnorm(-abs((s$pos$logRr - mu) / sqrt(tau^2 + s$pos$seLogRr^2)))
  # the screen, counted by hand: a Wald interval that excludes 0
  hand_flags <- sum(abs(s$neg$logRr / s$neg$seLogRr) > stats::qnorm(0.975))
  ok <- identical(r$status, "succeeded") && abs(mu - 0.7922) < 5e-4 && abs(tau - 0.2834) < 5e-4 && abs(p_cal - 0.8389142) < 5e-4 &&
    abs(mu - as.numeric(ml$beta)) < 1e-5 && abs(tau - sqrt(ml$tau2)) < 1e-5 && abs(p_cal - p_hand) < 1e-12 &&
    p_raw < 1e-20 && vcr_measure_value(r, "negative_controls_analysed") == 45 &&
    vcr_measure_value(r, "negative_controls_signalling_bias") == hand_flags &&
    identical(r$diagnostics$calibration$status, "fitted") && identical(r$conclusion, "estimable") &&
    !any(vapply(r$measures, function(m) grepl("calibrated_(interval|ci)", m$name), logical(1)))
  list(pass = ok,
       detail = sprintf("45 negative controls: null mean %.5f (package 0.7922, metafor ML %.5f), SD %.5f (0.2834, %.5f), calibrated p %.6f (0.8389142), uncalibrated p %.1e; %d of 45 flagged (hand count %d); no calibrated interval offered",
                        mu, as.numeric(ml$beta), tau, sqrt(ml$tau2), p_cal, p_raw, vcr_measure_value(r, "negative_controls_signalling_bias"), hand_flags))
})

vcr_case("N37b", c("AC-07", "AC-30"), function() {
  # The threshold is the domain's (30) and it is a floor on ESTIMABLE controls:
  # 29 give the screen and the statement that the set is too small, and no null, no
  # calibrated p-value and no calibrated interval; 30 fit. A scenario cannot move
  # the threshold (it has no key for it).
  s <- .n37_sccs()
  run <- function(k, id) vcr_test_run(vcr_test_job("comparator.negative_control", .n37_supplied(s$neg[seq_len(k), ], s$pos), job_id = id))
  r29 <- run(29L, "job_n37b_29"); r30 <- run(30L, "job_n37b_30")
  floor_ok <- identical(as.integer(vcr_domain()$limits$negativeControlCalibrationMin), 30L)
  names29 <- vapply(r29$measures, function(m) m$name, character(1))
  small_ok <- identical(r29$status, "succeeded") && identical(r29$conclusion, "limited") &&
    identical(r29$diagnostics$calibration$status, "set_too_small") && r29$diagnostics$calibration$controlsUsed == 29L &&
    !any(c("empirical_null_mean", "empirical_null_sd", "calibrated_p_value") %in% names29) &&
    all(c("negative_controls_analysed", "negative_controls_signalling_bias", "primary_log_effect", "uncalibrated_p_value") %in% names29) &&
    "too_few_controls_to_calibrate" %in% unlist(r29$diagnostics$limitedBy) && length(r29$diagnostics$controls) == 29L &&
    all(vapply(r29$diagnostics$controls, function(cn) cn$verdict %in% vcr_domain()$negativeControlVerdicts, logical(1)))
  fit_ok <- identical(r30$diagnostics$calibration$status, "fitted") && is.finite(vcr_measure_value(r30, "calibrated_p_value")) &&
    identical(r30$conclusion, "estimable")
  # an excluded control does not count towards the 30: 30 supplied, 31 - 1 not estimable is not possible with supplied
  # estimates (they always have a standard error), so the exclusion path is N37e's
  list(pass = floor_ok && small_ok && fit_ok,
       detail = sprintf("domain floor %s; 29 controls: %s/%s, calibration '%s', measures %s; 30 controls: calibration '%s', calibrated p %.4f",
                        vcr_domain()$limits$negativeControlCalibrationMin, r29$status, r29$conclusion, r29$diagnostics$calibration$status,
                        paste(names29, collapse = ","), r30$diagnostics$calibration$status, vcr_measure_value(r30, "calibrated_p_value")))
})

vcr_case("N37c", c("AC-08", "AC-30", "AC-07"), function() {
  # A control analysed in the engine gets the primary's adjustment: entropy-balancing ATT weights, the
  # weighted log risk ratio of its 0/1 indicator. On LaLonde's data (the pre-treatment employment
  # indicators are the classic negative controls: the programme cannot have changed 1974-75 earnings) each
  # control's estimate equals the one computed from WeightIt's weights (the tightest fit, as N09c) to 1e-6,
  # the covariate balance and ESS are the weighting job's own, and the bootstrap draws re-estimate the weights
  # (at least the domain's 2,000 whatever the job asks).
  suppressMessages({library(WeightIt); library(MatchIt)})
  data("lalonde", package = "MatchIt")
  d <- lalonde
  d$USUBJID <- sprintf("L%04d", seq_len(nrow(d)))
  d$black <- as.numeric(d$race == "black"); d$hispan <- as.numeric(d$race == "hispan"); d$arm <- d$treat
  d$employed74 <- as.numeric(d$re74 > 0); d$employed75 <- as.numeric(d$re75 > 0); d$earned75 <- as.numeric(d$re75 > 2000)
  covs <- c("age", "educ", "black", "hispan", "married", "nodegree", "re74", "re75")
  cols <- c("employed74", "employed75", "earned75")
  inp <- vcr_test_input(d[, c("USUBJID", "arm", covs, cols)], "snp_n37c:subject", "subject")
  sc <- list(covariates = as.list(covs), treatmentColumn = "arm", controls = lapply(cols, function(cn) list(name = cn, column = cn)))
  r <- vcr_test_run(vcr_test_job("comparator.negative_control", sc, list(inp), seed = 5L, replicates = 20L, job_id = "job_n37c"))
  wi <- WeightIt::weightit(stats::as.formula(paste("treat ~", paste(covs, collapse = " + "))), data = d, method = "ebal", estimand = "ATT", reltol = 1e-16, maxit = 200000L)
  want <- vapply(cols, function(cn) {
    m1 <- stats::weighted.mean(d[[cn]][d$treat == 1], wi$weights[d$treat == 1]); m0 <- stats::weighted.mean(d[[cn]][d$treat == 0], wi$weights[d$treat == 0])
    log(m1 / m0)
  }, numeric(1))
  got <- vapply(r$diagnostics$controls, function(cn) cn$estimate, numeric(1))
  ess_wi <- vcr_ess(wi$weights[d$treat == 0])
  # the interval is the percentile one and brackets the estimate; the verdict is a function of it
  brackets <- all(vapply(r$diagnostics$controls, function(cn) cn$low < cn$estimate && cn$estimate < cn$high, logical(1)))
  verdicts_ok <- all(vapply(r$diagnostics$controls, function(cn) identical(cn$verdict, if (cn$low > 0 || cn$high < 0) "signals_bias" else "consistent_with_null"), logical(1)))
  ok <- identical(r$status, "succeeded") && max(abs(got - want)) < 1e-6 && abs(r$counts$effectiveSampleSize - ess_wi) / ess_wi < 1e-6 &&
    r$diagnostics$bootstrapReplicates >= 2000L && brackets && verdicts_ok && identical(r$counts$realPatients, 614L) &&
    identical(r$diagnostics$calibration$status, "set_too_small") && vcr_measure_value(r, "negative_controls_analysed") == 3
  list(pass = ok,
       detail = sprintf("LaLonde, 3 pre-treatment indicators: log RR %s vs WeightIt %s (max |d| %.1e), ESS %.4f vs %.4f, %d bootstrap draws (job asked for 20), %d of 3 flagged; 3 < 30 controls: %s",
                        paste(sprintf("%.5f", got), collapse = "/"), paste(sprintf("%.5f", want), collapse = "/"), max(abs(got - want)),
                        r$counts$effectiveSampleSize, ess_wi, r$diagnostics$bootstrapReplicates, vcr_measure_value(r, "negative_controls_signalling_bias"),
                        r$diagnostics$calibration$status))
})

# The simulation behind N37d: a trial and an external control that differ in a measured covariate pair
# (x1, x2: balanced by the weights) and in an UNMEASURED binary U that raises every outcome's risk by the
# factor exp(gamma). Each outcome is Bernoulli(base * exp(gamma U + 0.2 x1)): none is affected by the arm.
# After the weights, the arm contrast of any outcome is exactly the contrast of E[exp(gamma U) | arm], so the
# bias on the log risk ratio scale is known without running anything:
#   log( (1 + P1 (e^gamma - 1)) / (1 + P0 (e^gamma - 1)) ),   P_a = P(U = 1 | arm = a).
.n37_dgp <- function(n, n_controls, seed, gamma = 1.0, base = 0.1, with_primary = TRUE) {
  set.seed(seed, kind = VCR_RNG_KIND)
  x1 <- pmax(pmin(stats::rnorm(n), 3), -3); x2 <- stats::rbinom(n, 1L, 0.5)
  arm <- stats::rbinom(n, 1L, stats::plogis(-0.6 + 0.5 * x1 + 0.4 * x2))
  u <- stats::rbinom(n, 1L, stats::plogis(-0.5 + 1.35 * arm))
  p_of <- function(b) pmin(b * exp(gamma * u + 0.2 * x1), 0.95)
  d <- data.frame(USUBJID = sprintf("S%05d", seq_len(n)), arm = arm, x1 = x1, x2 = x2)
  for (j in seq_len(n_controls)) d[[sprintf("nc%02d", j)]] <- stats::rbinom(n, 1L, p_of(base))
  if (with_primary) d$primary <- stats::rbinom(n, 1L, p_of(base))
  attr(d, "bias") <- log((1 + stats::plogis(-0.5 + 1.35) * (exp(gamma) - 1)) / (1 + stats::plogis(-0.5) * (exp(gamma) - 1)))
  d
}

vcr_case("N37d", c("AC-07", "AC-08", "AC-30"), function() {
  # The point of the method, on data whose bias is known. 31 negative controls and an effect of interest
  # that is truly null, all carrying the same unmeasured-confounding bias b (closed form above). (1) The
  # fitted null's mean is b: within three standard errors of the controls' average, and its spread is small
  # (the bias is common, so the controls differ only by their own noise). (2) The effect of interest looks
  # significant before calibration (it carries b) and null after (p well above 0.05): the calibrated p-value
  # does what it is for. (3) The bootstrap standard errors the calibration uses are the estimator's real
  # sampling standard deviation: R = 150 fresh datasets give the SD of the estimate, which the job's
  # bootstrap SE (the mean over the 31 same-law controls) matches to 15%.
  n <- 2500L; k <- 31L
  d <- .n37_dgp(n, k, 20261004L)
  b <- attr(d, "bias")
  covs <- c("x1", "x2")
  inp <- vcr_test_input(d, "snp_n37d:subject", "subject")
  sc <- list(covariates = as.list(covs), treatmentColumn = "arm", moments = 2L,
             controls = lapply(sprintf("nc%02d", seq_len(k)), function(cn) list(name = cn, column = cn)),
             primary = list(name = "primary", column = "primary"))
  r <- vcr_test_run(vcr_test_job("comparator.negative_control", sc, list(inp), seed = 11L, job_id = "job_n37d"))
  est <- vapply(r$diagnostics$controls, function(cn) cn$estimate, numeric(1))
  se <- vapply(r$diagnostics$controls, function(cn) cn$se, numeric(1))
  mu <- vcr_measure_value(r, "empirical_null_mean"); tau <- vcr_measure_value(r, "empirical_null_sd")
  se_mu <- sqrt(1 / sum(1 / (tau^2 + se^2)))
  p_raw <- vcr_measure_value(r, "uncalibrated_p_value"); p_cal <- vcr_measure_value(r, "calibrated_p_value")
  # (3) the sampling SD of the estimator, by simulation: one control's column per dataset
  reps <- 150L
  one <- vapply(seq_len(reps), function(i) {
    s <- .n37_dgp(n, 1L, 7000L + i, with_primary = FALSE)
    X <- as.matrix(s[, covs]); w <- vcr_att_entropy_weights(X, s$arm, 2L)$allWeights
    log(stats::weighted.mean(s$nc01[s$arm == 1L], w[s$arm == 1L]) / stats::weighted.mean(s$nc01[s$arm == 0L], w[s$arm == 0L]))
  }, numeric(1))
  sd_true <- stats::sd(one); se_boot <- mean(se)
  ok <- identical(r$status, "succeeded") && identical(r$diagnostics$calibration$status, "fitted") &&
    abs(mu - b) < 3 * se_mu && tau < 0.12 && p_raw < 0.01 && p_cal > 0.05 &&
    abs(mean(one) - b) < 3 * sd_true / sqrt(reps) + 0.01 && abs(se_boot / sd_true - 1) < 0.15 &&
    abs(vcr_measure_value(r, "primary_log_effect") - b) < 4 * r$diagnostics$primary$se
  list(pass = ok,
       detail = sprintf("known bias b = %.4f (closed form); null mean %.4f (se %.4f, %.1f se off), null SD %.4f; effect of interest %.4f: p %.1e uncalibrated -> %.3f calibrated; bootstrap SE %.4f vs sampling SD %.4f over %d datasets (ratio %.3f); mean of the single-control estimates %.4f",
                        b, mu, se_mu, abs(mu - b) / se_mu, tau, vcr_measure_value(r, "primary_log_effect"), p_raw, p_cal, se_boot, sd_true, reps, se_boot / sd_true, mean(one)))
})

vcr_case("N37e", c("AC-07", "AC-09", "AC-28"), function() {
  # Named inputs and named refusals, and the partial result that survives them.
  # (1) The verdict rule, by hand: an interval that excludes 0 signals bias; one that contains 0 AND the
  # effect of interest is uninformative about it; the rest are consistent with null.
  neg <- data.frame(drugName = c("bias", "wide", "tight"), logRr = c(0.40, 0.10, 0.02), seLogRr = c(0.05, 0.30, 0.05), stringsAsFactors = FALSE)
  r1 <- vcr_test_run(vcr_test_job("comparator.negative_control", .n37_supplied(neg, data.frame(drugName = "x", logRr = 0.5, seLogRr = 0.1)), job_id = "job_n37e1"))
  v1 <- vapply(r1$diagnostics$controls, function(cn) cn$verdict, character(1))
  # without an effect of interest nothing can be "uninformative" about it
  r1b <- vcr_test_run(vcr_test_job("comparator.negative_control", .n37_supplied(neg), job_id = "job_n37e1b"))
  v1b <- vapply(r1b$diagnostics$controls, function(cn) cn$verdict, character(1))
  verdict_ok <- identical(unname(v1), c("signals_bias", "uninformative", "consistent_with_null")) &&
    identical(unname(v1b), c("signals_bias", "consistent_with_null", "consistent_with_null")) &&
    !("uncalibrated_p_value" %in% vapply(r1b$measures, function(m) m$name, character(1)))
  # (2) a control with no event in an arm has no risk ratio: listed with its reason, left out of the
  # screen, and the rest of the controls are reported (the partial result stands)
  set.seed(31L, kind = VCR_RNG_KIND)
  n <- 240L
  d <- data.frame(USUBJID = sprintf("E%03d", seq_len(n)), arm = rep(0:1, each = n / 2), x1 = stats::rnorm(n), x2 = stats::rbinom(n, 1L, 0.5))
  d$ok1 <- stats::rbinom(n, 1L, 0.2); d$ok2 <- stats::rbinom(n, 1L, 0.3)
  d$rare <- as.integer(d$arm == 1L & seq_len(n) %% 40L == 0L)        # events only in the trial arm
  inp <- vcr_test_input(d, "snp_n37e:subject", "subject")
  sc <- list(covariates = list("x1", "x2"), treatmentColumn = "arm",
             controls = list(list(name = "ok1", column = "ok1"), list(name = "rare", column = "rare"), list(name = "ok2", column = "ok2")))
  r2 <- vcr_test_run(vcr_test_job("comparator.negative_control", sc, list(inp), seed = 3L, job_id = "job_n37e2"))
  rare <- Filter(function(cn) identical(cn$name, "rare"), r2$diagnostics$controls)[[1]]
  partial_ok <- identical(r2$status, "succeeded") && identical(r2$conclusion, "limited") && identical(rare$reason, "no_event_in_an_arm") &&
    !isTRUE(rare$estimable) && is.na(rare$verdict) &&
    vcr_measure_value(r2, "negative_controls_analysed") == 2 && "control_not_estimable" %in% unlist(r2$diagnostics$limitedBy) &&
    length(r2$diagnostics$controls) == 3L
  # (3) none estimable: a named not-estimable rule and no numbers
  d$only_rare <- d$rare
  inp3 <- vcr_test_input(d, "snp_n37e3:subject", "subject")
  r3 <- vcr_test_run(vcr_test_job("comparator.negative_control", list(covariates = list("x1", "x2"), treatmentColumn = "arm",
                                  controls = list(list(name = "rare", column = "only_rare"))), list(inp3), seed = 3L, job_id = "job_n37e3"))
  none_ok <- identical(r3$status, "not_estimable") && identical(r3$notEstimableRule, "negative_controls_not_estimable") && length(r3$measures) == 0L
  # (4) refusals by name: a duplicate name, a column that is not 0/1, a missing column, a hazard-ratio control
  # analysed in the engine, a column control with no covariates
  refuse <- function(sc, inputs = list(inp), code) {
    rr <- vcr_test_run(vcr_test_job("comparator.negative_control", sc, inputs, seed = 3L, job_id = "job_n37e4"))
    identical(rr$status, "failed") && code %in% vcr_test_issue_codes(rr) && length(rr$measures) == 0L
  }
  base <- list(covariates = list("x1", "x2"), treatmentColumn = "arm")
  d$cont <- stats::rnorm(n)
  inp4 <- vcr_test_input(d, "snp_n37e4:subject", "subject")
  ref_ok <- refuse(c(base, list(controls = list(list(name = "a", column = "ok1"), list(name = "a", column = "ok2")))), list(inp), "scenario_value_invalid") &&
    refuse(c(base, list(controls = list(list(name = "a", column = "cont")))), list(inp4), "input_shape_invalid") &&
    refuse(c(base, list(controls = list(list(name = "a", column = "nope")))), list(inp), "input_shape_invalid") &&
    refuse(c(base, list(effectScale = "log_hazard_ratio", controls = list(list(name = "a", column = "ok1")))), list(inp), "endpoint_not_supported") &&
    refuse(list(treatmentColumn = "arm", controls = list(list(name = "a", column = "ok1"))), list(inp), "scenario_field_missing") &&
    refuse(c(base, list(controls = list(list(name = "a", column = "ok1")))), list(), "input_shape_invalid")
  # (5) the same seed gives the same result to the byte (the output hash), another seed another bootstrap
  # (the output hash covers measures, counts and tables, not the intervals, so the intervals are compared too)
  r5a <- vcr_test_run(vcr_test_job("comparator.negative_control", sc, list(inp), seed = 3L, job_id = "job_n37e5"))
  r5b <- vcr_test_run(vcr_test_job("comparator.negative_control", sc, list(inp), seed = 4L, job_id = "job_n37e5"))
  repro_ok <- identical(r2$manifest$outputHash, r5a$manifest$outputHash) && identical(r2$diagnostics$controls, r5a$diagnostics$controls) &&
    !identical(r5a$diagnostics$controls, r5b$diagnostics$controls)
  list(pass = verdict_ok && partial_ok && none_ok && ref_ok && repro_ok,
       detail = sprintf("verdicts %s (with an effect of interest) / %s (without); a control with no event in an arm: %s, reported %d of 3, %s; none estimable -> %s/%s with %d measures; 6 refusals by name %s; same seed same result %s, another seed differs %s",
                        paste(v1, collapse = ","), paste(v1b, collapse = ","), rare$reason %||% "NULL", vcr_measure_value(r2, "negative_controls_analysed"), r2$conclusion,
                        r3$status, r3$notEstimableRule %||% "NULL", length(r3$measures), if (ref_ok) "ok" else "FAILED",
                        identical(r2$diagnostics$controls, r5a$diagnostics$controls), !identical(r5a$diagnostics$controls, r5b$diagnostics$controls)))
})
