# N58 — a hazard ratio that changes over time and the MaxCombo analysis, in the simulation only (remediation plan D1, 2026-11-01).
#
# `truth.treatmentHazardRatios = { breaks, ratios }` makes the treated arm's hazard `ratios[j]` times the control's on the j-th interval
# (a delayed effect is ratios [1, 0.6], a crossing of the survival curves [1.4, 0.6]); `analysis.method = "maxcombo"` is the most
# favourable of the four Fleming-Harrington weighted log-rank statistics G(0,0), G(0,1), G(1,0), G(1,1) under the maximum of their joint
# normal null distribution. Neither is a default, and the analytic design refuses both by name.
#
# What the cases are held against, and what they are not: `simtrial` and `gsDesign2` are not in the locked library (and a package is not
# added to the lock for a case), so the references are independent of this code instead: (a) the treated arm's survival function written
# out in closed form for the exponential, Weibull and piecewise control laws, against a sample of 4e5; (b) the four statistics rewritten
# from the definition on `survival::survfit`'s Kaplan-Meier estimate and risk tables, and, for rho 0 and 1 with gamma 0, against
# `survival::survdiff`'s own chi-square; (c) the type I error of the whole path (statistics, correlation, `mvtnorm`) in a simulation
# with its Monte-Carlo error, and the log-rank special case, in which MaxCombo with one combination IS the log-rank. A comparison with
# `coin`'s Fleming-Harrington test was tried and left out: coin weights by S(t) and takes a permutation variance, so it differs from the
# definition in the second digit for gamma > 0 (the usual S(t-) of Harrington and Fleming is what is implemented here).

.n58_two_arm <- function(n = 150, nph = NULL, hr = 1, analysis = "logrank", median = 12, kind = "two_arm_fixed", extra = list()) {
  truth <- list(controlMedian = median)
  if (is.null(nph)) truth$hazardRatio <- hr else truth$treatmentHazardRatios <- nph
  utils::modifyList(list(design = list(kind = kind, nTreat = n, nControl = n), endpoint = list(type = "time_to_event"), truth = truth,
         accrual = list(kind = "uniform", duration = 12, followup = 18), analysis = list(method = analysis, alpha = 0.025, sided = 1)), extra)
}

# --- (a) the generator against the closed-form survival function --------------------------------------------------------------------

vcr_case("N58a", c("AC-30", "AC-29"), function() {
  set.seed(20261101L, kind = VCR_RNG_KIND)
  N <- 400000L
  # no censoring: every time is an event time. SE of an empirical survival proportion is sqrt(S (1 - S) / n).
  worst <- 0; rows <- list()
  check <- function(label, dist, nph, S1) {
    set.seed(11L, kind = VCR_RNG_KIND)
    spec <- .vcr_nph_spec(nph, dist)
    d <- vcr_sim_tte(N, N, dist, spec, accrual = list(kind = "uniform", duration = 0), followup = Inf)
    ts <- c(1, 3, 6, 9, 15, 30)
    got <- vapply(ts, function(t) mean(d$time[d$arm == 1L] > t), numeric(1))
    want <- vapply(ts, S1, numeric(1))
    z <- abs(got - want) / sqrt(want * (1 - want) / N)
    ctl <- vapply(ts, function(t) mean(d$time[d$arm == 0L] > t), numeric(1))
    ctl_want <- exp(-vcr_cumhaz(ts, dist))
    zc <- abs(ctl - ctl_want) / sqrt(ctl_want * (1 - ctl_want) / N)
    worst <<- max(worst, z, zc)
    rows[[length(rows) + 1L]] <<- sprintf("%s: max |z| treated %.2f, control %.2f", label, max(z), max(zc))
  }
  lam <- 0.08
  exp_d <- list(kind = "exponential", rate = lam)
  check("exponential, delayed effect [1, 0.5] after 6", exp_d, list(breaks = list(6), ratios = list(1, 0.5)),
        function(t) exp(-lam * (min(t, 6) + 0.5 * max(t - 6, 0))))
  check("exponential, crossing [1.5, 0.5, 1] at 4 and 12", exp_d, list(breaks = list(4, 12), ratios = list(1.5, 0.5, 1)),
        function(t) exp(-lam * (1.5 * min(t, 4) + 0.5 * max(min(t, 12) - 4, 0) + max(t - 12, 0))))
  wb <- list(kind = "weibull", shape = 1.6, scale = 14)
  H0 <- function(t) (t / 14)^1.6
  check("weibull control, delayed [1, 0.6] after 8", wb, list(breaks = list(8), ratios = list(1, 0.6)),
        function(t) exp(-(H0(min(t, 8)) + 0.6 * (H0(max(t, 8)) - H0(8)))))
  pw <- list(kind = "piecewise", breaks = list(5, 15), rates = list(0.05, 0.12, 0.03))
  Hp <- function(t) 0.05 * min(t, 5) + 0.12 * max(min(t, 15) - 5, 0) + 0.03 * max(t - 15, 0)
  check("piecewise control, [0.7, 1.3] after 10", pw, list(breaks = list(10), ratios = list(0.7, 1.3)),
        function(t) exp(-(0.7 * Hp(min(t, 10)) + 1.3 * (Hp(max(t, 10)) - Hp(10)))))
  # one uniform per subject through any ratios: a ratio that never changes is the proportional-hazards draw, to rounding
  set.seed(5L, kind = VCR_RNG_KIND); a <- vcr_sim_tte(300, 300, exp_d, 0.6, list(kind = "uniform", duration = 12), 18)
  set.seed(5L, kind = VCR_RNG_KIND); b <- vcr_sim_tte(300, 300, exp_d, .vcr_nph_spec(list(breaks = list(5), ratios = list(0.6, 0.6)), exp_d), list(kind = "uniform", duration = 12), 18)
  same <- isTRUE(all.equal(a$time, b$time, tolerance = 1e-12)) && identical(a$status, b$status) && identical(a$arm, b$arm)
  # and the forward map is the inverse of the inverse
  spec <- .vcr_nph_spec(list(breaks = list(6, 12), ratios = list(1.5, 0.5, 1)), exp_d)
  x <- c(0.01, 0.3, 0.5, 0.9, 2, 5); back <- max(abs(.vcr_nph_forward(.vcr_nph_inverse(x, spec), spec) - x))
  list(pass = worst < 4.5 && same && back < 1e-12,
       detail = sprintf("%s (z against the closed-form survival function over 6 times, 4e5 per arm; worst %.2f); ratios [0.6, 0.6] draw the proportional-hazards times (all.equal 1e-12: %s); G(G^-1(y)) = y to %.1e",
                        paste(unlist(rows), collapse = "; "), worst, same, back))
})

# --- (b) the four statistics against their definition -----------------------------------------------------------------------------

vcr_case("N58b", c("AC-30"), function() {
  suppressMessages(library(survival))
  set.seed(8L, kind = VCR_RNG_KIND)
  n <- 240L
  arm <- rep(0:1, each = n / 2L)
  t0 <- stats::rexp(n, 0.08 * ifelse(arm == 1L, 0.7, 1)); cen <- stats::runif(n, 4, 40)
  d <- data.frame(arm = arm, time = pmin(t0, cen), status = as.integer(t0 <= cen))
  fh <- vcr_fh_statistics(d$time, d$status, d$arm)
  # the definition, on survfit's own Kaplan-Meier estimate and risk tables
  km <- survfit(Surv(time, status) ~ 1, data = d)
  by <- summary(survfit(Surv(time, status) ~ arm, data = d), censored = FALSE)
  ts <- sort(unique(d$time[d$status == 1L]))
  pooled <- summary(km, times = ts, extend = TRUE)
  s_minus <- c(1, pooled$surv[-length(ts)])                       # S(t-): the estimate just before each event time
  nrisk <- vapply(ts, function(t) sum(d$time >= t), numeric(1))
  nrisk1 <- vapply(ts, function(t) sum(d$time >= t & d$arm == 1L), numeric(1))
  dd <- vapply(ts, function(t) sum(d$time == t & d$status == 1L), numeric(1))
  dd1 <- vapply(ts, function(t) sum(d$time == t & d$status == 1L & d$arm == 1L), numeric(1))
  v <- dd * (nrisk1 / nrisk) * (1 - nrisk1 / nrisk) * (nrisk - dd) / pmax(nrisk - 1, 1)
  zref <- vapply(VCR_FLEMING_HARRINGTON, function(g) {
    w <- s_minus^g[1] * (1 - s_minus)^g[2]
    sum(w * (dd1 - dd * nrisk1 / nrisk)) / sqrt(sum(w^2 * v))
  }, numeric(1))
  # the risk set of survfit agrees with the one counted by hand
  risk_ok <- all(by$n.risk[by$strata == "arm=1"][seq_len(3)] == nrisk1[match(by$time[by$strata == "arm=1"][seq_len(3)], ts)])
  # survdiff's chi-square for rho = 0 and rho = 1 (gamma = 0) is the square of the first and third statistics
  sd0 <- survdiff(Surv(time, status) ~ arm, data = d, rho = 0)$chisq; sd1 <- survdiff(Surv(time, status) ~ arm, data = d, rho = 1)$chisq
  # the correlation of the statistics, rebuilt from the same weights
  w4 <- vapply(VCR_FLEMING_HARRINGTON, function(g) s_minus^g[1] * (1 - s_minus)^g[2], numeric(length(ts)))
  cov_ref <- crossprod(w4 * sqrt(v)); corr_ref <- cov_ref / outer(sqrt(diag(cov_ref)), sqrt(diag(cov_ref)))
  ok <- length(fh$z) == 4L && max(abs(fh$z - zref)) < 1e-10 && max(abs(fh$corr - corr_ref)) < 1e-10 &&
    abs(fh$z[1]^2 - sd0) < 1e-9 * max(1, sd0) && abs(fh$z[3]^2 - sd1) < 1e-9 * max(1, sd1) && risk_ok
  # the log-rank special case: the first statistic IS vcr_analyse_logrank's, and so is its sign (negative is protective)
  lr <- vcr_analyse_logrank(d, 0.025, 1)
  ok <- ok && abs(fh$z[1] - as.numeric(lr["statistic"])) < 1e-10 && fh$z[1] < 0
  # the correlation matrix is singular by construction (the (0,0) weight is the sum of the (1,0) and (0,1) weights, so U00 = U10 + U01)
  singular <- min(eigen(fh$corr, symmetric = TRUE, only.values = TRUE)$values) < 1e-12
  # the maximum's own null distribution: the p-value at several points against a Monte-Carlo of the same joint normal, to its error
  set.seed(77L, kind = VCR_RNG_KIND)
  draws <- mvtnorm::rmvnorm(1500000L, sigma = fh$corr); lowest <- apply(draws, 1, min); widest <- apply(abs(draws), 1, max)
  seed_before <- .Random.seed
  one <- vapply(c(-1.0, -1.8, -2.4), function(z) vcr_maxcombo_p(z, fh$corr, 1), numeric(1))
  two <- vapply(c(1.2, 2.0, 2.6), function(z) vcr_maxcombo_p(z, fh$corr, 2), numeric(1))
  untouched <- identical(seed_before, .Random.seed) && identical(one, vapply(c(-1.0, -1.8, -2.4), function(z) vcr_maxcombo_p(z, fh$corr, 1), numeric(1)))
  mc_one <- vapply(c(-1.0, -1.8, -2.4), function(z) mean(lowest <= z), numeric(1)); mc_two <- vapply(c(1.2, 2.0, 2.6), function(z) mean(widest >= z), numeric(1))
  tol <- function(p) 4 * sqrt(p * (1 - p) / 1500000L) + 2e-5
  agree <- all(abs(one - mc_one) < tol(mc_one)) && all(abs(two - mc_two) < tol(mc_two))
  # and the test on this data: between the log-rank's own p and the Bonferroni bound, with the statistic the most favourable of the four
  mc <- vcr_analyse_maxcombo(d, 0.025, 1)
  between <- as.numeric(mc["p"]) >= pnorm(min(fh$z)) * 0.999 && as.numeric(mc["p"]) <= min(1, 4 * pnorm(min(fh$z))) * 1.001
  ok <- ok && singular && agree && untouched && as.numeric(mc["statistic"]) == min(fh$z) && between
  list(pass = ok, detail = sprintf("Z (0,0) %.5f (survdiff chi-square %.5f = Z^2 %.5f), (0,1) %.5f, (1,0) %.5f (survdiff rho 1 %.5f = Z^2 %.5f), (1,1) %.5f; max |Z - definition| %.1e, max |corr - definition| %.1e; the 4x4 correlation is singular (%s); p of the maximum at -1.0/-1.8/-2.4: %s vs Monte-Carlo %s (2-sided at 1.2/2.0/2.6: %s vs %s); the caller's random state untouched and the p-value reproducible (%s); maxcombo p %.5f lies between the log-rank's %.5f and the Bonferroni bound",
                                   fh$z[1], sd0, fh$z[1]^2, fh$z[2], fh$z[3], sd1, fh$z[3]^2, fh$z[4], max(abs(fh$z - zref)), max(abs(fh$corr - corr_ref)), singular,
                                   paste(sprintf("%.4f", one), collapse = "/"), paste(sprintf("%.4f", mc_one), collapse = "/"), paste(sprintf("%.4f", two), collapse = "/"), paste(sprintf("%.4f", mc_two), collapse = "/"),
                                   untouched, as.numeric(mc["p"]), pnorm(min(fh$z))))
})

# --- (c) the whole path: type I error, power under a delayed effect, and what is refused ---------------------------------------------

vcr_case("N58c", c("AC-28", "AC-29", "AC-30"), function() {
  # Null calibration: one-sided alpha 0.025, 2000 replicates, MaxCombo on proportional hazards of 1. The type I error is held to its own
  # Monte-Carlo error, which is the check on the statistics, their correlation and the p-value together.
  null <- vcr_test_run(vcr_test_job("design.simulate", .n58_two_arm(150, hr = 1, analysis = "maxcombo"), seed = 4242L, replicates = 2000L, cores = VCR_TEST_CORES, job_id = "job_n58c_null"))
  t1 <- vcr_get_measure(null, "type_one_error")
  # The same data analysed by the log-rank and by MaxCombo under a delayed effect (the same seed draws the same patients): MaxCombo
  # reads the late separation, and neither has a bias or a coverage to report, since there is no single true hazard ratio.
  nph <- list(breaks = list(6), ratios = list(1, 0.55))
  mc <- vcr_test_run(vcr_test_job("design.simulate", .n58_two_arm(150, nph = nph, analysis = "maxcombo"), seed = 99L, replicates = 1200L, cores = VCR_TEST_CORES, job_id = "job_n58c_mc"))
  lr <- vcr_test_run(vcr_test_job("design.simulate", .n58_two_arm(150, nph = nph, analysis = "logrank"), seed = 99L, replicates = 1200L, cores = VCR_TEST_CORES, job_id = "job_n58c_lr"))
  pm <- vcr_get_measure(mc, "power"); pl <- vcr_get_measure(lr, "power")
  names_mc <- vapply(mc$measures, function(m) m$name, character(1))
  # the delayed-effect truth is a non-null case with a power; all-ones ratios are the null case with a type I error
  ones <- vcr_test_run(vcr_test_job("design.simulate", .n58_two_arm(150, nph = list(breaks = list(6), ratios = list(1, 1)), analysis = "logrank"), seed = 5L, replicates = 300L, job_id = "job_n58c_ones"))
  rm <- vcr_test_run(vcr_test_job("design.simulate", .n58_two_arm(150, nph = nph, analysis = "rmst", extra = list()), seed = 3L, replicates = 400L, job_id = "job_n58c_rmst_missing_tau"))
  rmst <- vcr_test_run(vcr_test_job("design.simulate", utils::modifyList(.n58_two_arm(150, nph = nph, analysis = "rmst"), list(analysis = list(method = "rmst", tau = 24, alpha = 0.025, sided = 1))), seed = 3L, replicates = 300L, job_id = "job_n58c_rmst"))
  est <- rmst$diagnostics$estimand
  ok <- identical(null$status, "succeeded") && abs(t1$value - 0.025) <= 3 * t1$mcse && is.finite(t1$mcse) &&
    identical(mc$status, "succeeded") && pm$value > pl$value + 0.02 && !any(c("bias", "mse", "coverage") %in% names_mc) &&
    is.null(vcr_get_measure(mc, "type_one_error")) && any(vapply(mc$diagnostics$performanceNotComputed %||% list(), function(i) identical(i$code, "performance_measure_unsupported"), logical(1))) &&
    is.finite(mc$diagnostics$estimand %||% NA_real_) == FALSE && is.null(mc$diagnostics$analyticCheck) &&
    !is.null(vcr_get_measure(ones, "type_one_error")) && is.null(vcr_get_measure(ones, "power")) &&
    identical(rm$status, "failed") &&
    identical(rmst$status, "succeeded") && !is.null(vcr_get_measure(rmst, "bias")) && is.finite(est) && length(vcr_validate_result(mc)) == 0L
  # the RMST truth under the delay, integrated from the two survival curves, against the closed form of the exponential case
  lam <- log(2) / 12; b <- 6; r <- 0.55; tau <- 24
  closed <- (1 - exp(-lam * b)) / lam + exp(-lam * b) * (1 - exp(-r * lam * (tau - b))) / (r * lam) - (1 - exp(-lam * tau)) / lam
  ok <- ok && abs(est - closed) < 1e-7
  list(pass = ok, detail = sprintf("MaxCombo null type I error %.4f (+-%.4f, alpha 0.025); delayed effect [1, 0.55] after 6 months, same patients: MaxCombo power %.3f (+-%.3f) vs log-rank %.3f (+-%.3f); no bias/mse/coverage and no analytic check without a single true hazard ratio; all-ones ratios are the null case; RMST(24) truth %.6f vs closed form %.6f; RMST without tau: %s",
                                   t1$value, t1$mcse, pm$value, pm$mcse, pl$value, pl$mcse, est, closed, rm$status))
})

vcr_case("N58d", c("AC-04", "AC-13"), function() {
  # What is refused and by what name, in both validators (the domain's and this engine's), and the replay rule: a job recorded at 1.2.0
  # that asks for what 1.3.0 added is not a 1.2.0 job; one that asks for nothing new replays unchanged.
  nph <- list(breaks = list(6), ratios = list(1, 0.6))
  analytic <- vcr_test_job("design.analytic", list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"),
    truth = list(hazardRatio = 0.7, controlMedian = 12, treatmentHazardRatios = nph), accrual = list(duration = 12, followup = 18),
    analysis = list(alpha = 0.025, power = 0.9, sided = 1)), job_id = "job_n58d_a")
  gs_mc <- vcr_test_job("design.simulate", .n58_two_arm(150, hr = 0.7, analysis = "maxcombo", kind = "group_sequential",
    extra = list(design = list(kind = "group_sequential", nTreat = 150, nControl = 150, informationRates = list(0.5, 1)))), job_id = "job_n58d_gs")
  both_sc <- .n58_two_arm(150, nph = nph); both_sc$truth$hazardRatio <- 0.7
  both <- vcr_test_job("design.simulate", both_sc, job_id = "job_n58d_both")
  none_sc <- .n58_two_arm(150, nph = nph); none_sc$truth <- list(controlMedian = 12)
  none <- vcr_test_job("design.simulate", none_sc, job_id = "job_n58d_none")
  short <- vcr_test_job("design.simulate", .n58_two_arm(150, nph = list(breaks = list(6), ratios = list(1))), job_id = "job_n58d_short")
  old_nph <- vcr_test_job("design.simulate", .n58_two_arm(150, nph = nph), job_id = "job_n58d_old", extra = list(methodVersion = "1.2.0"))
  old_mc <- vcr_test_job("design.simulate", .n58_two_arm(150, hr = 0.7, analysis = "maxcombo"), job_id = "job_n58d_oldmc", extra = list(methodVersion = "1.2.0"))
  old_ph <- vcr_test_job("design.simulate", .n58_two_arm(150, hr = 0.7), job_id = "job_n58d_oldph", extra = list(methodVersion = "1.2.0"))
  grid_old <- vcr_test_job("design.grid", c(.n58_two_arm(150, hr = 1), list(designs = list(list(nTreat = 100)), truths = list(list(treatmentHazardRatios = nph)))),
                           job_id = "job_n58d_gridold", extra = list(methodVersion = "1.2.0"))
  grid_ok <- vcr_test_job("design.grid", c(.n58_two_arm(150, hr = 1), list(designs = list(list(nTreat = 100)), truths = list(list(treatmentHazardRatios = nph), list(hazardRatio = 0.7)))),
                          job_id = "job_n58d_grid")
  issues <- function(job) vcr_validate_job(vcr_test_json(job))
  codes <- function(job) vapply(issues(job), function(i) paste0(i$code, "@", i$field), character(1))
  has <- function(job, code) code %in% codes(job)
  ok <- has(analytic, "scenario_value_invalid@scenario.truth.treatmentHazardRatios") &&
    !any(grepl("^scenario_field_unknown@scenario.truth.treatmentHazardRatios", codes(analytic))) &&
    has(gs_mc, "scenario_value_invalid@scenario.analysis.method") &&
    has(both, "scenario_value_invalid@scenario.truth.treatmentHazardRatios") && has(none, "scenario_field_missing@scenario.truth.hazardRatio") &&
    has(short, "scenario_value_invalid@scenario.truth.treatmentHazardRatios.ratios") &&
    has(old_nph, "method_version_mismatch@methodVersion") && has(old_mc, "method_version_mismatch@methodVersion") && !length(issues(old_ph)) &&
    has(grid_old, "method_version_mismatch@methodVersion") && !length(issues(grid_ok))
  # a refused analysis is a failed job with the same name, not a number
  run <- vcr_test_run(gs_mc)
  ok <- ok && identical(run$status, "failed")
  list(pass = ok, detail = sprintf("analytic + NPH -> %s; group-sequential MaxCombo -> %s; both laws / neither / one ratio too few refused; 1.2.0 + NPH/MaxCombo/grid NPH -> method_version_mismatch, 1.2.0 + proportional hazards valid; a grid cell that states its own hazard law replaces the base's",
                                   paste(grep("treatmentHazardRatios", codes(analytic), value = TRUE), collapse = ","), paste(grep("analysis.method", codes(gs_mc), value = TRUE), collapse = ",")))
})
