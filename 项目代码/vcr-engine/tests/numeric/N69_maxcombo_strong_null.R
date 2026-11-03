# N69 — MaxCombo beside the log-rank test, and its strong null (algorithm round T13, 2026-11-03): design.simulate 1.4.0.
#
# A MaxCombo analysis also reports the log-rank test on the same replicates (`power_logrank`), and a second simulation of a world in which
# the treatment is never better than the control and is worse early on (`type_one_error_strong_null` and `..._logrank`). Information,
# never a refusal.
#
#   a  the log-rank power reported beside MaxCombo is the power of a log-rank job on the same data: the replicates of a seed are the same
#      trials whatever the analysis (the analysis draws no numbers), so the two are equal to the bit
#   b  the strong null is derived from the design, never typed: a delayed effect (1, 0.6) is mirrored as an early harm (1 / 0.6), a
#      crossing (1.4, 0.6) keeps its own harm, a proportional-hazards design (0.7) is mirrored from half the control median, and the
#      ratio after the break is 1
#   c  the log-rank rejection probability in that world against a simulation in plain R (piecewise exponential times, uniform entry,
#      administrative censoring) tested with survival::survdiff, within three combined Monte-Carlo errors
#   d  a job at 1.3.0 reports none of it (a replay), and a scenario with another analysis reports none

.n69_scenario <- function(truth, n = 30L, method = "maxcombo") list(design = list(kind = "two_arm_fixed", nTreat = n, nControl = n),
  endpoint = list(type = "time_to_event"), truth = truth, accrual = list(kind = "uniform", duration = 12, followup = 18),
  analysis = list(method = method, alpha = 0.025, sided = 1))

vcr_case("N69a", c("AC-28", "AC-31"), function() {
  sc <- .n69_scenario(list(hazardRatio = 0.9, controlMedian = 12))
  # the CPU budget of the MaxCombo job is held to a minute so that the second simulation (the strong null, N69c) is not what this case waits for
  max_job <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = 6901L, replicates = 5000L, cores = VCR_TEST_CORES, job_id = "job_n69a", extra = list(cpuSecondsLimit = 60L)))
  lr_job <- vcr_test_run(vcr_test_job("design.simulate", .n69_scenario(list(hazardRatio = 0.9, controlMedian = 12), method = "logrank"), seed = 6901L, replicates = 5000L, cores = VCR_TEST_CORES, job_id = "job_n69a2"))
  old <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = 6901L, replicates = 5000L, job_id = "job_n69a3", extra = list(methodVersion = "1.3.0")))
  same <- identical(vcr_measure_value(max_job, "power_logrank"), vcr_measure_value(lr_job, "power"))
  ok <- c(same = same, mcse = isTRUE(vcr_get_measure(max_job, "power_logrank")$simulated) && is.finite(vcr_get_measure(max_job, "power_logrank")$mcse),
          replay = is.na(vcr_measure_value(old, "power_logrank")) && is.null(old$diagnostics$strongNull),
          logrank_job = is.na(vcr_measure_value(lr_job, "power_logrank")) && is.null(lr_job$diagnostics$strongNull))
  list(pass = all(ok), detail = sprintf("MaxCombo power %.4f; log-rank power beside it %.4f (+-%.4f) = the power of a log-rank job at the same seed %.4f; 1.3.0 replay reports no log-rank column, a log-rank analysis none%s",
                                        vcr_measure_value(max_job, "power"), vcr_measure_value(max_job, "power_logrank"), vcr_get_measure(max_job, "power_logrank")$mcse, vcr_measure_value(lr_job, "power"),
                                        if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

vcr_case("N69b", c("AC-10"), function() {
  law <- function(truth) vcr_maxcombo_strong_law(.n69_scenario(truth))
  delayed <- law(list(treatmentHazardRatios = list(breaks = list(6), ratios = list(1, 0.6)), controlMedian = 12))
  crossing <- law(list(treatmentHazardRatios = list(breaks = list(6), ratios = list(1.4, 0.6)), controlMedian = 12))
  ph <- law(list(hazardRatio = 0.7, controlMedian = 12))
  ok <- c(delayed = isTRUE(all.equal(delayed$ratios, c(1 / 0.6, 1))) && delayed$breaks == 6, crossing = isTRUE(all.equal(crossing$ratios, c(1.4, 1))) && crossing$breaks == 6,
          ph = isTRUE(all.equal(ph$ratios, c(1 / 0.7, 1))) && abs(ph$breaks - 6) < 1e-8, never_better = all(vapply(list(delayed, crossing, ph), function(l) l$ratios[1] >= 1 && l$ratios[2] == 1, logical(1))))
  list(pass = all(ok), detail = sprintf("strong null from the design: delayed (1, 0.6) -> early %.3f from month %g; crossing (1.4, 0.6) -> early %.3f; proportional 0.7 -> early %.3f from month %g (half the control median)%s",
                                        delayed$ratios[1], delayed$breaks, crossing$ratios[1], ph$ratios[1], ph$breaks, if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

# The strong null runs 20,000 replicates (the null floor) after the 5,000 of the design itself, each of them four weighted log-rank statistics:
# thirty patients an arm keep this case near two minutes at two cores, which is what a MaxCombo job with its strong null costs.
vcr_case("N69c", c("AC-28", "AC-29"), function() {
  sc <- .n69_scenario(list(hazardRatio = 0.9, controlMedian = 12))
  r <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = 6902L, replicates = 5000L, cores = VCR_TEST_CORES, job_id = "job_n69c"))
  strong <- r$diagnostics$strongNull
  lr <- vcr_get_measure(r, "type_one_error_strong_null_logrank"); mx <- vcr_get_measure(r, "type_one_error_strong_null")
  # plain R: control hazard log(2) / 12; the treatment's is 1 / 0.9 times it until month 6, then equal; entry uniform over 12 months, followed 18 months after it ends
  reps <- 10000L; n <- 30L
  set.seed(6903, kind = "L'Ecuyer-CMRG")
  lambda <- log(2) / 12; harm <- strong$ratios[1]; cut <- strong$breaks
  event_time <- function(m, ratio) {                    # piecewise exponential by inversion: hazard lambda * ratio up to `cut`, lambda after
    u <- stats::runif(m); e <- -log(u)
    h1 <- lambda * ratio; t1 <- e / h1
    ifelse(t1 <= cut, t1, cut + (e - h1 * cut) / lambda)
  }
  rejected <- logical(reps)
  for (i in seq_len(reps)) {
    entry <- stats::runif(2 * n, 0, 12); arm <- rep(0:1, each = n)
    t <- c(stats::rexp(n, lambda), event_time(n, harm)); end <- 30 - entry
    status <- as.integer(t <= end); time <- pmin(t, end)
    fit <- survival::survdiff(survival::Surv(time, status) ~ arm)
    z <- sign(fit$obs[2] - fit$exp[2]) * sqrt(fit$chisq)       # negative when the treated arm has fewer events than expected
    rejected[i] <- is.finite(z) && z < -stats::qnorm(0.975)
  }
  p <- mean(rejected); se <- sqrt(p * (1 - p) / reps)
  z <- abs(lr$value - p) / sqrt(lr$mcse^2 + se^2)
  ok <- c(compare = z < 3.5, derived = isTRUE(all.equal(strong$ratios, c(1 / 0.9, 1))) && abs(strong$breaks - 6) < 1e-8, computed = isTRUE(strong$computed) && strong$replicates == 20000L,
          mcse = isTRUE(mx$simulated) && is.finite(mx$mcse) && mx$mcse > 0 || mx$value == 0)
  list(pass = all(ok), detail = sprintf("strong null (early hazard ratio %.3f to month %g, then 1): log-rank rejects %.4f (+-%.4f) in the job, %.4f (+-%.4f) in plain R with survival::survdiff, %.2f combined errors; MaxCombo %.4f (+-%.4f); nominal %.3f%s",
                                        harm, cut, lr$value, lr$mcse, p, se, z, mx$value, mx$mcse, 0.025, if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})
