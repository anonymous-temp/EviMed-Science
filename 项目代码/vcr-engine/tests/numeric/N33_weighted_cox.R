# N33 — comparator.weighted_cox: a weighted hazard ratio with a robust variance
# and a bootstrap, the proportional-hazards test, and the RMST difference beside
# it.
#
# References that are not this method's own code: `survival::coxph` on weights
# another package estimated (WeightIt), an independent score test for a
# time-varying coefficient (`coxph` with a `tt()` term, and a hand-written
# Breslow score test in base R), and a simulation with a known hazard ratio.

# A confounded two-source time-to-event table: arm 1 is the trial, arm 0 the
# external control, `x1` and `x2` drive the arm and (unless `beta` is zero) the
# hazard. A covariate that drives the hazard makes the MARGINAL hazards
# non-proportional even when the conditional ones are (the arm that lives longer
# depletes its susceptibles more slowly), which the weighted analysis rightly sees.
.n33_data <- function(n = 400L, seed = 11L, hr = 0.55, shape = c(1, 1), cens = c(3, 30), sel = 0.8, beta = c(0.5, 0.3)) {
  set.seed(seed, kind = VCR_RNG_KIND)
  x1 <- stats::rnorm(n); x2 <- stats::rbinom(n, 1L, 0.5)
  z <- stats::rbinom(n, 1L, stats::plogis(-0.3 + sel * x1 - 0.5 * sel * x2))
  # a Weibull hazard per arm (shape 1 is exponential); the covariates act on the hazard
  lp <- beta[1] * x1 + beta[2] * x2
  t <- ifelse(z == 1L,
              (-log(stats::runif(n)) / (0.08 * hr * exp(lp)))^(1 / shape[2]),
              (-log(stats::runif(n)) / (0.08 * exp(lp)))^(1 / shape[1]))
  cn <- stats::runif(n, cens[1], cens[2])
  subj <- data.frame(USUBJID = sprintf("S%04d", seq_len(n)), arm = z, x1 = x1, x2 = x2, stringsAsFactors = FALSE)
  ev <- data.frame(USUBJID = subj$USUBJID, PARAMCD = "OS", AVAL = pmin(t, cn), CNSR = as.integer(t > cn), stringsAsFactors = FALSE)
  list(subj = subj, ev = ev)
}

.n33_job <- function(d, id, scenario = list(), method = "comparator.weighted_cox", seed = 7L, cores = 1L) {
  inputs <- list(vcr_test_input(d$subj, paste0("snp_", id, ":subject"), "subject"), vcr_test_input(d$ev, paste0("snp_", id, ":events"), "event"))
  sc <- utils::modifyList(list(covariates = list("x1", "x2"), treatmentColumn = "arm", tau = 8), scenario)
  vcr_test_job(method, sc, inputs, seed = seed, job_id = paste0("job_", id), cores = cores)
}

# the Breslow score statistic for a time-varying coefficient g(t) * arm, at the
# fitted log hazard ratio and zero: base R, no survival code
.n33_breslow_score <- function(time, status, x, w, beta, g) {
  U <- c(0, 0); I <- matrix(0, 2, 2)
  for (i in which(status == 1L)) {
    r <- time >= time[i]
    e <- w[r] * exp(beta * x[r]); s0 <- sum(e)
    gt <- g(time[i]); z1 <- x[r]; z2 <- gt * x[r]
    m1 <- sum(e * z1) / s0; m2 <- sum(e * z2) / s0
    U <- U + w[i] * c(x[i] - m1, gt * x[i] - m2)
    I <- I + w[i] * matrix(c(sum(e * z1^2) / s0 - m1^2, sum(e * z1 * z2) / s0 - m1 * m2, sum(e * z1 * z2) / s0 - m1 * m2, sum(e * z2^2) / s0 - m2^2), 2, 2)
  }
  drop(t(U) %*% solve(I) %*% U)
}

vcr_case("N33a", c("AC-08", "AC-12", "AC-30"), function() {
  # Cross-software: the weights are WeightIt's (entropy balancing and the logistic
  # propensity score, ATT), the model is survival::coxph(weights =, robust = TRUE).
  # The job must reproduce its hazard ratio and its robust standard error, and the
  # weighting job's own numbers for everything it shares (the weights, the effective
  # sample size, the RMST difference and its bootstrap interval, resample for resample).
  suppressMessages({library(WeightIt); library(survival)})
  d <- .n33_data()
  dm <- .n33_data(n = 600L, seed = 12L, sel = 0.3)
  ref <- function(method) {
    dat <- if (identical(method, "glm")) dm else d
    wi <- WeightIt::weightit(arm ~ x1 + x2, data = dat$subj, method = method, estimand = "ATT", reltol = 1e-16, maxit = 200000L)
    # The engine's documented ATT scale is sum(control weights) = n_treated (weighting.R). WeightIt's logistic ATT weights
    # are the raw odds, whose control sum is only close to n_treated; a weighted Cox model puts both arms in one risk set,
    # so the scale moves the hazard ratio in the fifth digit. The reference is put on the engine's scale explicitly.
    ww <- wi$weights; ctl <- dat$subj$arm == 0L; ww[ctl] <- ww[ctl] * sum(dat$subj$arm == 1L) / sum(ww[ctl])
    dd <- data.frame(time = dat$ev$AVAL, status = 1L - dat$ev$CNSR, arm = dat$subj$arm, w = ww)
    f <- survival::coxph(survival::Surv(time, status) ~ arm, data = dd, weights = w, robust = TRUE)
    list(hr = exp(unname(stats::coef(f))), se = sqrt(unname(f$var)), model_se = sqrt(unname(f$naive.var)))
  }
  r_ebal <- ref("ebal"); r_glm <- ref("glm")
  dir <- tempfile("n33a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  j_ebal <- vcr_test_run(.n33_job(d, "n33a_e"), output_dir = dir)
  # the logistic route is judged on a milder selection: with the strong one the propensity weights leave x1 at a
  # standardized difference of 0.15 and the engine refuses (standardized_difference_above_floor), exactly as the weighting job does
  j_ps <- vcr_test_run(.n33_job(dm, "n33a_p", list(weighting = "propensity")))
  m <- function(r, name) vcr_measure_value(r, name)
  rel <- function(a, b) abs(a - b) / abs(b)
  # the weighting job on the same table: same seed, so the same resamples
  wj <- vcr_test_run(vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x1", "x2"), treatmentColumn = "arm", endpoint = list(type = "time_to_event"), tau = 8),
    list(vcr_test_input(d$subj, "snp_n33a_w:subject", "subject"), vcr_test_input(d$ev, "snp_n33a_w:events", "event")), seed = 7L, job_id = "job_n33a_w"))
  shared <- c("rmst_difference", "rmst_treatment", "rmst_control", "survival_difference_at_tau", "effective_sample_size", "worst_standardized_difference")
  same <- vapply(shared, function(nm) {
    a <- vcr_get_measure(j_ebal, nm); b <- vcr_get_measure(wj, nm)
    isTRUE(all.equal(a$value, b$value, tolerance = 0)) && isTRUE(all.equal(unlist(a$interval[c("low", "high")]), unlist(b$interval[c("low", "high")]), tolerance = 0))
  }, logical(1))
  w_job <- vcr_test_table(j_ebal, "weights", dir)
  ok <- identical(j_ebal$status, "succeeded") && identical(j_ps$status, "succeeded") &&
    rel(m(j_ebal, "hazard_ratio"), r_ebal$hr) < 1e-6 && rel(m(j_ebal, "log_hazard_ratio_se_robust"), r_ebal$se) < 1e-6 &&
    rel(m(j_ps, "hazard_ratio"), r_glm$hr) < 1e-6 && rel(m(j_ps, "log_hazard_ratio_se_robust"), r_glm$se) < 1e-6 &&
    all(same) && nrow(w_job) == nrow(d$subj) &&
    length(vcr_validate_result(j_ebal)) == 0L && length(vcr_validate_result(j_ps)) == 0L
  list(pass = ok,
       detail = sprintf("entropy-balance ATT: HR %.8f vs coxph on WeightIt weights %.8f (rel %.1e), robust se %.8f vs %.8f; logistic ATT weights: HR %.8f vs %.8f, robust se %.8f vs %.8f; the weighting job's RMST difference, both arm RMSTs, survival difference, ESS and balance are identical in %d/%d (value and bootstrap interval)",
                        m(j_ebal, "hazard_ratio"), r_ebal$hr, rel(m(j_ebal, "hazard_ratio"), r_ebal$hr), m(j_ebal, "log_hazard_ratio_se_robust"), r_ebal$se,
                        m(j_ps, "hazard_ratio"), r_glm$hr, m(j_ps, "log_hazard_ratio_se_robust"), r_glm$se, sum(same), length(same)))
})

vcr_case("N33b", c("AC-12", "AC-30"), function() {
  # The proportional-hazards test against two independent score tests, on the very
  # weights the job used (read back from its `weights` table): (1) survival's own
  # machinery for a time-varying coefficient, `coxph` with a `tt()` term at the fitted
  # log hazard ratio and zero, with the default time transform (1 - KM(t-), written
  # out here); (2) a Breslow score test in base R. Efron and Breslow ties are both
  # exercised, and the data has ties.
  suppressMessages(library(survival))
  d <- .n33_data(n = 500L, shape = c(2, 0.7))
  d$ev$AVAL <- round(d$ev$AVAL, 1); d$ev$AVAL[d$ev$AVAL == 0] <- 0.1   # ties
  dir <- tempfile("n33b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  check <- function(ties, transform, id) {
    r <- vcr_test_run(.n33_job(d, id, list(ties = ties, phTransform = transform)), output_dir = dir)
    w <- vcr_test_table(r, "weights", dir)$weight
    status <- 1L - d$ev$CNSR; time <- d$ev$AVAL; arm <- d$subj$arm
    beta <- log(vcr_measure_value(r, "hazard_ratio"))
    sf <- survival::survfit(survival::Surv(time, status) ~ 1)
    g <- switch(transform, identity = function(t) t, rank = NULL,
                km = function(t) 1 - c(1, sf$surv)[findInterval(t, sf$time, left.open = TRUE) + 1L])
    ref_tt <- if (is.null(g)) NA_real_ else {
      dd <- data.frame(time = time, status = status, arm = arm, w = w)
      survival::coxph(survival::Surv(time, status) ~ arm + tt(arm), data = dd, weights = w, tt = function(x, t, ...) x * g(t),
                      init = c(beta, 0), iter.max = 0, ties = ties)$score
    }
    ref_hand <- if (identical(ties, "breslow") && !is.null(g)) .n33_breslow_score(time, status, arm, w, beta, g) else NA_real_
    list(chisq = vcr_measure_value(r, "ph_test_chisq"), p = vcr_measure_value(r, "ph_test_p"), tt = ref_tt, hand = ref_hand, result = r)
  }
  runs <- list(efron_km = check("efron", "km", "n33b_ek"), efron_id = check("efron", "identity", "n33b_ei"),
               breslow_km = check("breslow", "km", "n33b_bk"), breslow_id = check("breslow", "identity", "n33b_bi"))
  rel <- function(a, b) abs(a - b) / abs(b)
  tt_ok <- vapply(runs, function(x) rel(x$chisq, x$tt) < 1e-6, logical(1))
  hand_ok <- vapply(runs[c("breslow_km", "breslow_id")], function(x) rel(x$chisq, x$hand) < 1e-6, logical(1))
  pv <- vapply(runs, function(x) x$p, numeric(1))
  # the data really is non-proportional (shapes 1.6 and 0.9): the test rejects, the result says so,
  # the hazard ratio is still there and so is the RMST difference beside it
  r <- runs$efron_km$result
  said <- isTRUE(r$diagnostics$proportionalHazards$rejected) && identical(r$conclusion, "limited") &&
    "proportional_hazards_rejected" %in% unlist(r$diagnostics$limitedBy) &&
    !is.null(vcr_get_measure(r, "hazard_ratio")) && !is.null(vcr_get_measure(r, "rmst_difference")) &&
    identical(r$diagnostics$proportionalHazards$transform, "km") && !is.null(vcr_test_table(r, "ph-schoenfeld", dir))
  # proportional hazards: the same design with equal shapes, and covariates that drive only who is in the trial, is not rejected
  dp <- .n33_data(shape = c(1, 1), seed = 27L, beta = c(0, 0))   # one fixed draw (the test rejects a true null in 5% of draws)
  rp <- vcr_test_run(.n33_job(dp, "n33b_ph"))
  kept <- !isTRUE(rp$diagnostics$proportionalHazards$rejected) && identical(rp$conclusion, "estimable") && vcr_measure_value(rp, "ph_test_p") > 0.05
  list(pass = all(tt_ok) && all(hand_ok) && said && kept && pv[["efron_km"]] < 0.05,
       detail = sprintf("cox.zph chi-square vs the tt() score test: efron/km %.5f vs %.5f, efron/identity %.5f vs %.5f, breslow/km %.5f vs %.5f, breslow/identity %.5f vs %.5f; vs the hand-written Breslow score test %.5f/%.5f (relative differences all below 1e-6); crossing hazards: p = %.2g, rejected -> conclusion %s with the RMST difference beside the hazard ratio; proportional hazards: p = %.3f, not rejected, conclusion %s",
                        runs$efron_km$chisq, runs$efron_km$tt, runs$efron_id$chisq, runs$efron_id$tt, runs$breslow_km$chisq, runs$breslow_km$tt, runs$breslow_id$chisq, runs$breslow_id$tt,
                        runs$breslow_km$hand, runs$breslow_id$hand, runs$efron_km$p, r$conclusion, vcr_measure_value(rp, "ph_test_p"), rp$conclusion))
})

vcr_case("N33c", c("AC-07", "AC-08", "AC-12"), function() {
  # What the job refuses or qualifies, each by its own name: an arm with no event
  # (too_few_events, no number), a target outside the control range (the weighting
  # job's rule), a tau beyond follow-up (the hazard ratio is kept and the missing
  # RMST companion is said), a handful of events (a notice), and the same malformed
  # tables the weighting job refuses.
  d <- .n33_data(n = 150L)
  none <- d; none$ev$CNSR[none$subj$arm == 1L] <- 1L                       # the trial arm: every one censored
  r_none <- vcr_test_run(.n33_job(none, "n33c_none"))
  far <- d; far$subj$x1[far$subj$arm == 1L] <- far$subj$x1[far$subj$arm == 1L] + 10   # trial mean far outside the controls
  r_far <- vcr_test_run(.n33_job(far, "n33c_far"))
  r_tau <- vcr_test_run(.n33_job(d, "n33c_tau", list(tau = 500)))
  few <- d; few$ev$CNSR[few$subj$arm == 1L] <- 1L; idx <- which(few$subj$arm == 1L)[1:6]; few$ev$CNSR[idx] <- 0L   # six events in the trial arm
  r_few <- vcr_test_run(.n33_job(few, "n33c_few"))
  na <- d; na$subj$x2[3] <- NA
  r_na <- vcr_test_run(.n33_job(na, "n33c_na"))
  r_ate <- vcr_test_run(.n33_job(d, "n33c_ate", list(estimand = "ATE")))               # entropy balancing is the ATT only
  r_ate_ps <- vcr_test_run(.n33_job(d, "n33c_atep", list(weighting = "propensity", estimand = "ATE")))
  syn <- vcr_test_run(vcr_test_job("comparator.weighted_cox", list(covariates = list("x1"), treatmentColumn = "arm", tau = 8),
    list(vcr_test_input(d$subj, "snp_n33c_s:subject", "subject", source = "synthetic"), vcr_test_input(d$ev, "snp_n33c_s:events", "event")), job_id = "job_n33c_syn"))
  codes <- function(r) paste(vcr_test_issue_codes(r), collapse = ",")
  ok <- identical(r_none$status, "not_estimable") && identical(r_none$notEstimableRule, "too_few_events") && length(r_none$measures) == 0L &&
    identical(r_far$status, "not_estimable") && identical(r_far$notEstimableRule, "entropy_balance_infeasible") && length(r_far$measures) == 0L &&
    identical(r_tau$status, "succeeded") && identical(r_tau$conclusion, "limited") && "rmst_companion_unavailable" %in% unlist(r_tau$diagnostics$limitedBy) &&
    is.null(vcr_get_measure(r_tau, "rmst_difference")) && !is.null(vcr_get_measure(r_tau, "hazard_ratio")) && identical(r_tau$diagnostics$rmstCompanion$rule, "tau_beyond_followup") &&
    identical(r_few$status, "succeeded") && "few_events" %in% unlist(r_few$diagnostics$limitedBy) && identical(r_few$conclusion, "limited") &&
    identical(r_na$status, "failed") && "missing_covariate" %in% vcr_test_issue_codes(r_na) &&
    identical(r_ate$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(r_ate) &&
    identical(r_ate_ps$status, "succeeded") && identical(r_ate_ps$conclusion, "limited") && "estimand_changed_from_att" %in% unlist(r_ate_ps$diagnostics$limitedBy) &&
    identical(syn$status, "failed") && "input_source_not_individual" %in% vcr_test_issue_codes(syn) &&
    all(vapply(list(r_none, r_far, r_tau, r_few, r_na, r_ate, r_ate_ps, syn), function(r) length(vcr_validate_result(r)) == 0L, logical(1)))
  list(pass = ok,
       detail = sprintf("no event in the trial arm -> %s/%s, 0 measures; trial mean 10 SD outside the controls -> %s; tau 500 beyond follow-up -> HR %.3f kept, conclusion %s, companion %s; 6 trial events -> conclusion %s (%s); NA covariate -> %s; entropy balancing with ATE -> %s; propensity ATE -> %s/%s; synthetic table -> %s",
                        r_none$status, r_none$notEstimableRule, r_far$notEstimableRule, vcr_measure_value(r_tau, "hazard_ratio"), r_tau$conclusion, r_tau$diagnostics$rmstCompanion$rule,
                        r_few$conclusion, paste(unlist(r_few$diagnostics$limitedBy), collapse = "+"), codes(r_na), codes(r_ate), r_ate_ps$status, r_ate_ps$conclusion, codes(syn)))
})

vcr_case("N33d", c("AC-08", "AC-11", "AC-28", "AC-31"), function() {
  # The weighted hazard ratio recovers a known one, the robust interval covers it
  # at the nominal rate over replications, the bootstrap agrees with the robust
  # standard error where the weights are benign, every bootstrapped number carries
  # its Monte-Carlo error, and the answer does not depend on the core count. The
  # truth is exact: exponential survival, a constant hazard ratio, and a covariate
  # that drives only who is in the trial (a hazard ratio is not collapsible, so a
  # covariate that also drives the hazard would move the marginal ratio).
  truth <- 0.6
  one <- function(i) {
    n <- 500L
    x <- stats::rnorm(n); z <- stats::rbinom(n, 1L, stats::plogis(0.8 * x))
    t <- stats::rexp(n, 0.1 * ifelse(z == 1L, truth, 1)); cn <- stats::runif(n, 4, 25)
    st <- as.integer(t <= cn); tm <- pmin(t, cn)
    w <- vcr_att_entropy_weights(cbind(x = x), z)$allWeights
    p <- vcr_cox_primary(tm, st, z, w, with_ph = FALSE)
    c(beta = p$beta, se = p$seRobust)
  }
  K <- 400L
  est <- do.call(rbind, vcr_map_streams(vcr_stream_bank(33L)$take(K), one, cores = VCR_TEST_CORES))
  bias <- mean(est[, "beta"]) - log(truth); mcse_bias <- stats::sd(est[, "beta"]) / sqrt(K)
  cover <- mean(abs(est[, "beta"] - log(truth)) < stats::qnorm(0.975) * est[, "se"])
  mcse_cov <- sqrt(cover * (1 - cover) / K)
  ratio_se <- mean(est[, "se"]) / stats::sd(est[, "beta"])
  d <- .n33_data(n = 300L, seed = 77L)
  r1 <- vcr_test_run(.n33_job(d, "n33d_c1", cores = 1L)); r2 <- vcr_test_run(.n33_job(d, "n33d_c2", cores = 2L))
  b <- r1$diagnostics$bootstrap
  se_m <- vcr_get_measure(r1, "log_hazard_ratio_se_bootstrap")
  same_cores <- identical(vcr_measure_value(r1, "hazard_ratio"), vcr_measure_value(r2, "hazard_ratio")) &&
    identical(vcr_get_measure(r1, "hazard_ratio")$interval, vcr_get_measure(r2, "hazard_ratio")$interval) &&
    identical(se_m$value, vcr_get_measure(r2, "log_hazard_ratio_se_bootstrap")$value)
  mcse_ok <- isTRUE(se_m$simulated) && is.finite(se_m$mcse) && se_m$mcse > 0 && se_m$mcse < 0.05 * se_m$value && b$replicates == 2000L &&
    is.finite(b$intervalMcse$low) && is.finite(b$intervalMcse$high) && length(vcr_validate_result(r1)) == 0L
  rob_boot <- r1$diagnostics$varianceComparison$ratioRobustToBootstrap
  ok <- abs(bias) <= 3 * mcse_bias && abs(cover - 0.95) <= 3 * mcse_cov + 0.01 && abs(ratio_se - 1) < 0.1 &&
    mcse_ok && same_cores && rob_boot > 0.8 && rob_boot < 1.25
  list(pass = ok,
       detail = sprintf("true HR %.2f over %d datasets of 500: mean log HR %+.4f off (%.2f MCSE, mcse %.4f); the robust 95%% interval covers the truth in %.3f (+-%.3f); mean robust SE / empirical SD %.3f; bootstrap SE %.4f has MCSE %.4f (%.1f%% of it) from %d draws, interval MCSE %.4f/%.4f; robust/bootstrap SE %.3f; one core and two give the same numbers: %s",
                        truth, K, bias, abs(bias) / mcse_bias, mcse_bias, cover, mcse_cov, ratio_se, se_m$value, se_m$mcse, 100 * se_m$mcse / se_m$value, b$replicates,
                        b$intervalMcse$low, b$intervalMcse$high, rob_boot, same_cores))
})
