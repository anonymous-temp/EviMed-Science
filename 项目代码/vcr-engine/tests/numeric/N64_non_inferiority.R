# N64 — non-inferiority designs (algorithm round T1, 2026-11-03): design.analytic and design.simulate 1.4.0 with
# `hypothesis: { kind: "non_inferiority", margin }`.
#
# The margin moves the null every sizing formula and every test is measured from: minus the margin for a mean or a risk difference,
# the margin itself for a hazard ratio. The closed forms are hand-written (R/design_analytic.R); `rpact::getSampleSize*(thetaH0 = ...)`
# is the independent reference, and a simulation of the test itself is the check of the power and, at the margin, of the size.
#
#   a  sample size against rpact: means (normal approximation), two proportions (Farrington & Manning, equal and 2:1), events of a
#      hazard ratio against a margin of 1.3
#   b  the restricted maximum-likelihood rates of the score test against a numerical maximisation of the likelihood, boundary counts included
#   c  the simulation: power at the designed size equals the closed form within three Monte-Carlo errors, and on the margin the
#      rejection probability is alpha (continuous, binary; e: time to event and a group-sequential event-time design)
#   d  what is refused and what is replayed: a margin on a single-arm design, a margin of the wrong scale, an effect that sits on the
#      margin, a job labelled with the release before the hypothesis; a superiority job is the same at 1.3.0 and 1.4.0

.n64_ni <- function(margin) list(kind = "non_inferiority", margin = margin)
.n64_value <- function(r, name) vcr_measure_value(r, name)

vcr_case("N64a", c("AC-10", "AC-29"), function() {
  suppressMessages(library(rpact))
  ours_means <- vcr_n_means(0, 1, 0.025, 0.9, 0.5, 1, -0.3)$total
  rp_means <- rpact::getSampleSizeMeans(alpha = 0.025, beta = 0.1, sided = 1, alternative = 0, stDev = 1, thetaH0 = -0.3, normalApproximation = TRUE)$numberOfSubjects
  ours_rates <- vcr_n_proportions(0.8, 0.8, 0.025, 0.9, 0.5, 1, -0.1)$total
  rp_rates <- rpact::getSampleSizeRates(alpha = 0.025, beta = 0.1, sided = 1, pi1 = 0.8, pi2 = 0.8, thetaH0 = -0.1)$numberOfSubjects
  ours_2to1 <- vcr_n_proportions(0.7, 0.75, 0.025, 0.9, 2 / 3, 1, -0.08)$total
  rp_2to1 <- rpact::getSampleSizeRates(alpha = 0.025, beta = 0.1, sided = 1, pi1 = 0.75, pi2 = 0.7, thetaH0 = -0.08, allocationRatioPlanned = 2)$numberOfSubjects
  ours_ev <- vcr_events_schoenfeld(0.9, 0.025, 0.9, 0.5, 1, 1.3)
  rp_ev <- suppressWarnings(rpact::getSampleSizeSurvival(alpha = 0.025, beta = 0.1, sided = 1, hazardRatio = 0.9, thetaH0 = 1.3, lambda2 = log(2) / 12,
                                                         accrualTime = c(0, 12), maxNumberOfSubjects = 1000)$maxNumberOfEvents)
  # the job end to end: the integer arms of a continuous design equal the unrounded requirement rounded up arm by arm
  job <- vcr_test_run(vcr_test_job("design.analytic", list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "continuous"),
    truth = list(effect = 0, sd = 1), hypothesis = .n64_ni(0.3), analysis = list(alpha = 0.025, power = 0.9)), job_id = "job_n64a"))
  d <- c(means = abs(ours_means - rp_means), rates = abs(ours_rates - rp_rates), rates_2to1 = abs(ours_2to1 - rp_2to1), events = abs(ours_ev - rp_ev))
  list(pass = identical(job$status, "succeeded") && all(d < 1e-6) && identical(.n64_value(job, "required_total"), 2 * ceiling(ours_means / 2)),
       detail = sprintf("total N vs rpact thetaH0: means %.4f/%.4f, rates %.4f/%.4f, rates 2:1 %.4f/%.4f; events at HR 0.9 against margin 1.3 %.4f/%.4f; max|d| %.1e; job %s N %s",
                        ours_means, rp_means, ours_rates, rp_rates, ours_2to1, rp_2to1, ours_ev, rp_ev, max(d), job$status, format(.n64_value(job, "required_total"))))
})

vcr_case("N64b", c("AC-10"), function() {
  cfg <- rbind(c(40, 50, 45, 50, -0.1), c(0, 50, 3, 50, -0.1), c(50, 50, 40, 50, -0.05), c(2, 30, 9, 40, -0.2), c(30, 30, 30, 30, -0.1), c(7, 20, 14, 60, -0.3))
  worst <- 0
  for (i in seq_len(nrow(cfg))) {
    x1 <- cfg[i, 1]; n1 <- cfg[i, 2]; x2 <- cfg[i, 3]; n2 <- cfg[i, 4]; delta <- cfg[i, 5]
    ours <- vcr_fm_restricted(x1 / n1, x2 / n2, n1, n2, delta)
    ll <- function(q) stats::dbinom(x1, n1, q + delta, log = TRUE) + stats::dbinom(x2, n2, q, log = TRUE)
    q <- stats::optimize(ll, c(max(0, -delta) + 1e-12, min(1, 1 - delta) - 1e-12), maximum = TRUE, tol = 1e-13)$maximum
    worst <- max(worst, abs(ours[["control"]] - q), abs(ours[["treat"]] - (q + delta)))
  }
  list(pass = worst < 1e-6, detail = sprintf("restricted rates (Miettinen-Nurminen cubic) vs numerical maximum of the likelihood on %d count tables incl. zero counts: max|d| %.1e (tol 1e-6)", nrow(cfg), worst))
})

vcr_case("N64c", c("AC-28", "AC-29"), function() {
  alpha <- 0.025
  within <- function(sim, ref, extra = 0) abs(sim$value - ref) <= 3 * sim$mcse + extra
  run <- function(tag, sc, reps, seed) vcr_test_run(vcr_test_job("design.simulate", sc, seed = seed, replicates = reps, cores = VCR_TEST_CORES, job_id = paste0("job_n64c_", tag)))
  # continuous: 234 per arm is the closed-form size for a true difference of 0 against a margin of 0.3
  cont <- list(design = list(kind = "two_arm_fixed", nTreat = 234, nControl = 234), endpoint = list(type = "continuous"), hypothesis = .n64_ni(0.3), analysis = list(alpha = alpha))
  c_pow <- run("c_pow", c(cont, list(truth = list(effect = 0, sd = 1))), 6000L, 6401L)
  c_t1 <- run("c_t1", c(cont, list(truth = list(effect = -0.3, sd = 1))), 20000L, 6402L)
  c_ref <- vcr_power_means(0, 1, 234, 234, alpha, 1, -0.3)
  # binary: 340 per arm, equal true rates of 0.8, margin 0.1 (the Farrington-Manning score test)
  bin <- list(design = list(kind = "two_arm_fixed", nTreat = 340, nControl = 340), endpoint = list(type = "binary"), hypothesis = .n64_ni(0.1), analysis = list(alpha = alpha))
  b_pow <- run("b_pow", c(bin, list(truth = list(controlRate = 0.8, treatmentRate = 0.8))), 6000L, 6403L)
  b_t1 <- run("b_t1", c(bin, list(truth = list(controlRate = 0.8, riskDifference = -0.1))), 20000L, 6404L)
  b_ref <- vcr_power_proportions(0.8, 0.8, 340, 340, alpha, 1, -0.1)
  pw <- function(r) vcr_get_measure(r, "power"); t1 <- function(r) vcr_get_measure(r, "type_one_error")
  ok <- c(c_pow = within(pw(c_pow), c_ref), b_pow = within(pw(b_pow), b_ref), c_t1 = within(t1(c_t1), alpha), b_t1 = within(t1(b_t1), alpha))
  list(pass = all(ok), detail = sprintf("power vs closed form: continuous %.4f/%.4f, binary %.4f/%.4f; rejection on the margin (alpha %.3f): continuous %.4f+-%.4f, binary %.4f+-%.4f%s",
                       pw(c_pow)$value, c_ref, pw(b_pow)$value, b_ref, alpha, t1(c_t1)$value, t1(c_t1)$mcse, t1(b_t1)$value, t1(b_t1)$mcse,
                       if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

# The event-time simulations are the slow ones (780 patients, a log-rank score at every event time of every replicate): a minute and a half at two cores.
vcr_case("N64e", c("AC-28", "AC-29"), function() {
  alpha <- 0.025
  within <- function(sim, ref, extra = 0) abs(sim$value - ref) <= 3 * sim$mcse + extra
  run <- function(tag, sc, reps, seed) vcr_test_run(vcr_test_job("design.simulate", sc, seed = seed, replicates = reps, cores = VCR_TEST_CORES, job_id = paste0("job_n64e_", tag)))
  # time to event: hazard ratio 1 against a margin of 1.3, 780 patients, 12 months of accrual and 24 of follow-up
  tte <- list(design = list(kind = "two_arm_fixed", nTreat = 390, nControl = 390), endpoint = list(type = "time_to_event"), hypothesis = .n64_ni(1.3),
              accrual = list(kind = "uniform", duration = 12, followup = 24, dropoutAnnual = 0.05), analysis = list(alpha = alpha))
  t_pow <- run("t_pow", c(tte, list(truth = list(hazardRatio = 1, controlMedian = 12))), 3000L, 6405L)
  t_t1 <- run("t_t1", c(tte, list(truth = list(hazardRatio = 1.3, controlMedian = 12))), 8000L, 6406L)
  # a group-sequential event-time design: two looks, O'Brien-Fleming; the type I error on the margin is alpha, the power is the closed form's
  gsd <- list(design = list(kind = "group_sequential", nTreat = 390, nControl = 390, informationRates = c(0.5, 1), spending = "obrien_fleming"),
              endpoint = list(type = "time_to_event"), hypothesis = .n64_ni(1.3),
              accrual = list(kind = "uniform", duration = 12, followup = 24, dropoutAnnual = 0.05), analysis = list(alpha = alpha))
  g_pow <- run("g_pow", c(gsd, list(truth = list(hazardRatio = 1, controlMedian = 12))), 2000L, 6407L)
  g_t1 <- run("g_t1", c(gsd, list(truth = list(hazardRatio = 1.3, controlMedian = 12))), 6000L, 6408L)
  gs <- vcr_group_sequential(c(0.5, 1), alpha, "obrien_fleming")
  # the last look uses all the data, so the events the closed form takes are those the fixed design collects by its end
  full_events <- vcr_get_measure(t_pow, "expected_events")$value
  g_ref <- vcr_group_sequential_power(gs, sqrt(full_events * 0.25) * (log(1.3) - log(1)))$power
  pw <- function(r) vcr_get_measure(r, "power"); t1 <- function(r) vcr_get_measure(r, "type_one_error")
  # the log-rank closed form is a first-order approximation (VCR_LOGRANK_APPROXIMATION_BIAS is its documented gap)
  ok <- c(t_pow = isTRUE(t_pow$diagnostics$analyticCheck$withinTolerance), g_pow = abs(pw(g_pow)$value - g_ref) <= 3 * pw(g_pow)$mcse + VCR_LOGRANK_APPROXIMATION_BIAS,
          t_t1 = within(t1(t_t1), alpha), g_t1 = within(t1(g_t1), alpha))
  list(pass = all(ok), detail = sprintf("power vs closed form: event time %.4f/%.4f (tol %.4f), group sequential %.4f/%.4f; rejection on the margin (alpha %.3f): event time %.4f+-%.4f, group sequential %.4f+-%.4f%s",
                       pw(t_pow)$value, t_pow$diagnostics$analyticCheck$value, t_pow$diagnostics$analyticCheck$tolerance, pw(g_pow)$value, g_ref,
                       alpha, t1(t_t1)$value, t1(t_t1)$mcse, t1(g_t1)$value, t1(g_t1)$mcse, if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

vcr_case("N64d", c("AC-10", "AC-26"), function() {
  fails <- function(r, code, field = NULL) identical(r$status, "failed") && code %in% vcr_test_issue_codes(r) && (is.null(field) || any(vapply(r$diagnostics$issues, function(i) identical(i$field, field), logical(1))))
  base <- list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "continuous"), truth = list(effect = 0, sd = 1), analysis = list(alpha = 0.025, power = 0.9))
  on_margin <- vcr_test_run(vcr_test_job("design.analytic", c(base[names(base) != "truth"], list(truth = list(effect = -0.3, sd = 1), hypothesis = .n64_ni(0.3))), job_id = "job_n64d1"))
  single <- vcr_test_run(vcr_test_job("design.simulate", list(design = list(kind = "single_arm", n = 40), endpoint = list(type = "binary"), truth = list(nullRate = 0.2, responseRate = 0.3),
    analysis = list(method = "exact_binomial", alternative = "greater", alpha = 0.05), hypothesis = .n64_ni(0.1)), job_id = "job_n64d2", replicates = 500L))
  hr_below_one <- vcr_test_run(vcr_test_job("design.analytic", list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.9, controlMedian = 12),
    accrual = list(duration = 12, followup = 24), hypothesis = .n64_ni(0.8), analysis = list(alpha = 0.025, power = 0.9)), job_id = "job_n64d3"))
  rd_margin <- vcr_test_run(vcr_test_job("design.analytic", list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "binary"), truth = list(controlRate = 0.5, treatmentRate = 0.5),
    hypothesis = .n64_ni(1.2), analysis = list(alpha = 0.025, power = 0.9)), job_id = "job_n64d4"))
  wrong_test <- vcr_test_run(vcr_test_job("design.simulate", list(design = list(kind = "two_arm_fixed", nTreat = 100, nControl = 100), endpoint = list(type = "continuous"), truth = list(effect = 0, sd = 1),
    analysis = list(method = "ancova", alpha = 0.025), hypothesis = .n64_ni(0.3)), job_id = "job_n64d5", replicates = 500L))
  # a job labelled with the release before the hypothesis cannot carry one
  old <- vcr_test_job("design.analytic", c(base[names(base) != "truth"], list(truth = list(effect = 0, sd = 1), hypothesis = .n64_ni(0.3))), job_id = "job_n64d6", extra = list(methodVersion = "1.3.0"))
  old_run <- vcr_test_run(old)
  # and a superiority job is the same at 1.3.0 and at 1.4.0
  sup <- function(v) vcr_test_run(vcr_test_job("design.analytic", base, job_id = "job_n64d7", extra = list(methodVersion = v)))
  same <- identical(lapply(sup("1.3.0")$measures, function(m) m$value), lapply(sup("1.4.0")$measures, function(m) m$value))
  ok <- c(on_margin = fails(on_margin, "design_effect_null", "scenario.hypothesis.margin"), single = fails(single, "scenario_value_invalid", "scenario.hypothesis.kind"),
          hr_margin = fails(hr_below_one, "scenario_value_invalid", "scenario.hypothesis.margin"), rd_margin = fails(rd_margin, "scenario_value_invalid", "scenario.hypothesis.margin"),
          wrong_test = fails(wrong_test, "scenario_value_invalid", "scenario.analysis.method"), old_label = identical(old_run$status, "failed"), replay = same)
  list(pass = all(ok), detail = sprintf("refused by name: effect on the margin, margin on a single-arm design, hazard-ratio margin below 1, risk-difference margin above 1, ANCOVA with a margin, hypothesis under a 1.3.0 label; superiority replay 1.3.0 = 1.4.0: %s%s",
                                        same, if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})
