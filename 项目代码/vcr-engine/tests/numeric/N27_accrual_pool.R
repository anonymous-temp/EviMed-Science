# N27 — accrual forecasts and evidence pooling, through the jobs the control
# plane queues, in the shapes the contract fixes (3.3).

.n27_sites <- function(alpha, beta, start = 0, enrolled = NULL) {
  n <- max(length(alpha), length(beta), length(start))
  alpha <- rep_len(alpha, n); beta <- rep_len(beta, n); start <- rep_len(start, n)
  lapply(seq_len(n), function(i) { s <- list(id = sprintf("s%02d", i), alpha = alpha[i], beta = beta[i], startTime = start[i]); if (!is.null(enrolled)) { s$enrolled <- rep_len(enrolled, n)[i]; s$exposureTime <- 12 }; s })
}

vcr_case("N27a", c("AC-30", "AC-28", "AC-37"), function() {
  # The plan's own numbers (N23): 20 sites, alpha 2, beta 4, 200 patients ->
  # 10/50/90% = 16.20 / 20.13 / 25.30 months. Read the way `vcrRecruit` reads a
  # result: `last_patient_in_months` with a `prediction` interval from p10 to p90
  # (the job used to emit `expected_completion_time` with no interval at all, so
  # the reader dropped every measure and the forecast page had nothing). With
  # N*alpha <= 1 the closed-form mean is infinite and used to come out NEGATIVE:
  # it is now absent, the quantiles kept. And `probability_by_month` is a table.
  dir <- tempfile("n27a"); dir.create(dir)
  r <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(2, 4, 0)[rep(1, 20)], target = 200L, byTimes = list(15, 20, 25)), job_id = "job_n27a"), output_dir = dir)
  m <- vcr_get_measure(r, "last_patient_in_months")
  tb <- vcr_test_table(r, "probability_by_month", dir)
  low <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(0.4, 4, 0)[rep(1, 2)], target = 50L), job_id = "job_n27a_low"), output_dir = dir)
  m_low <- vcr_get_measure(low, "last_patient_in_months")
  ok <- identical(r$status, "succeeded") && abs(m$value - 20.13) < 0.01 && abs(m$interval$low - 16.20) < 0.01 && abs(m$interval$high - 25.30) < 0.01 &&
    identical(m$interval$kind, "prediction") && isFALSE(m$simulated) && identical(m$source, "calculated") &&
    abs(r$diagnostics$mean - 20.51) < 0.01 && !is.null(tb) && identical(names(tb), c("month", "probability", "mcse")) && nrow(tb) == 3L &&
    all(diff(tb$probability) > 0) && abs(tb$probability[2] - stats::pf((20 / 4) * 40 / 200, 400, 80)) < 1e-12 &&
    identical(low$status, "succeeded") && !is.null(m_low) && m_low$value > 0 && is.na(low$diagnostics$mean) && !is.null(low$diagnostics$meanNote) &&
    is.null(vcr_get_measure(low, "expected_completion_time"))
  list(pass = ok,
       detail = sprintf("20 sites x Gamma(2, 4), 200 patients: median %.2f, p10-p90 [%.2f, %.2f] (plan 20.13, [16.20, 25.30]), mean %.2f (plan 20.51), interval kind %s; P(by month 20) %.4f = F(4x40/200; 400, 80); N*alpha = 0.8: mean %s with the note '%s', quantile kept (median %.2f)",
                        m$value, m$interval$low, m$interval$high, r$diagnostics$mean, m$interval$kind, tb$probability[2],
                        if (is.na(low$diagnostics$mean)) "not estimable" else "given", substr(low$diagnostics$meanNote %||% "", 1, 30), m_low$value))
})

vcr_case("N27b", c("AC-30", "AC-28"), function() {
  # Per-site posteriors and staggered activation, simulated by the job (with the
  # job's own replicate count and a Monte-Carlo error on the median), against two
  # INDEPENDENT constructions that use no accrual code: (1) sites with different
  # Gamma posteriors that all open at once: the total rate is the sum, so the
  # n-th arrival is Gamma(n, sum of rates) given the rates -- drawn directly; (2)
  # a second site that opens at month 6: the number of arrivals by month 6 is
  # Poisson, the rest arrive at the combined rate. Screen failure thins the
  # arrivals with a Beta-distributed loss. The medians and the p10/p90 must
  # agree within Monte-Carlo error.
  reps <- 20000L
  z <- function(job_out, samples) {
    m <- vcr_get_measure(job_out, "last_patient_in_months")
    q <- stats::quantile(samples, c(0.1, 0.9), names = FALSE)
    c(median = (m$value - stats::median(samples)) / sqrt(m$mcse^2 + vcr_quantile_mcse(samples, 0.5)^2),
      low = abs(m$interval$low - q[1]), high = abs(m$interval$high - q[2]), mcse = m$mcse, replicates = job_out$replicates)
  }
  set.seed(2727L, kind = VCR_RNG_KIND)
  al <- c(2, 6, 3); be <- c(4, 3, 5); target <- 90L
  # (1) different posteriors, all open at 0
  lam <- sapply(seq_along(al), function(i) stats::rgamma(reps, shape = al[i], rate = be[i]))
  t1 <- stats::rgamma(reps, shape = target, rate = rowSums(lam))
  r1 <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(al, be, 0), target = target), seed = 1L, replicates = reps, job_id = "job_n27b1"))
  # closed form applies only with a common rate prior, so with different betas the job simulates
  z1 <- z(r1, t1)
  # (2) staggered: site 1 at 0, site 2 at 6
  a2 <- c(2, 2); b2 <- c(4, 4); tgt <- 60L
  l1 <- stats::rgamma(reps, 2, 4); l2 <- stats::rgamma(reps, 2, 4)
  n6 <- stats::rpois(reps, l1 * 6)
  t2 <- ifelse(n6 >= tgt, 6 * stats::rbeta(reps, tgt, n6 - tgt + 1), 6 + stats::rgamma(reps, shape = pmax(tgt - n6, 1e-9), rate = l1 + l2))
  r2 <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(a2, b2, c(0, 6)), target = tgt), seed = 2L, replicates = reps, job_id = "job_n27b2"))
  z2 <- z(r2, t2)
  # job replicates are the job's: 777 replicates in, 777 replicates out, and a wider MCSE
  small <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(a2, b2, c(0, 6)), target = tgt), seed = 2L, replicates = 777L, job_id = "job_n27b3"))
  # already-enrolled patients are subtracted: 50 of 60 done leaves 10
  part <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(a2, b2, c(0, 6), enrolled = c(30, 20)), target = tgt), seed = 3L, replicates = 4000L, job_id = "job_n27b4"))
  ok <- all(abs(z1[c("median")]) <= 3) && z1[["low"]] < 0.35 && z1[["high"]] < 0.6 && z1[["replicates"]] == reps &&
    all(abs(z2[c("median")]) <= 3) && z2[["low"]] < 0.35 && z2[["high"]] < 0.6 &&
    small$replicates == 777L && vcr_get_measure(small, "last_patient_in_months")$mcse > 2.5 * z2[["mcse"]] &&
    isTRUE(vcr_get_measure(small, "last_patient_in_months")$simulated) &&
    part$diagnostics$remaining == 10 && vcr_measure_value(part, "last_patient_in_months") < vcr_measure_value(r2, "last_patient_in_months") - 5
  list(pass = ok,
       detail = sprintf("different posteriors, all open at 0: median %.3f +- %.3f is %.2f MCSE from the independent gamma construction (p10/p90 off by %.3f/%.3f); site 2 opening at month 6: median %.3f is %.2f MCSE from the Poisson/gamma construction (p10/p90 off by %.3f/%.3f); the job's own 777 replicates -> result.replicates %s, MCSE %.3f (vs %.3f at 20,000); 50 of 60 already enrolled -> remaining %s, median %.2f",
                        vcr_measure_value(r1, "last_patient_in_months"), z1[["mcse"]], z1[["median"]], z1[["low"]], z1[["high"]],
                        vcr_measure_value(r2, "last_patient_in_months"), z2[["median"]], z2[["low"]], z2[["high"]],
                        small$replicates, vcr_get_measure(small, "last_patient_in_months")$mcse, z2[["mcse"]], part$diagnostics$remaining,
                        vcr_measure_value(part, "last_patient_in_months")))
})

vcr_case("N27c", c("AC-30", "AC-28"), function() {
  # Screen failure and a target number of EVENTS. Screen failure is a Beta-
  # distributed thinning: with a Beta(30, 70) loss the median completion time is
  # about the no-loss median divided by (1 - mean loss), checked against
  # an independent gamma construction; the time to the k-th event of the
  # enrolled patients (each with an exponential event time after enrolment) is
  # later than the last patient in and is reported with its own prediction
  # interval and MCSE.
  reps <- 20000L; target <- 80L; kev <- 72L; h <- 0.08
  al <- c(3, 3); be <- c(4, 4)
  base <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(al, be, c(0, 0)), target = target, screenFailure = list(alpha = 30, beta = 70)),
                                    seed = 5L, replicates = reps, job_id = "job_n27c1"))
  set.seed(2828L, kind = VCR_RNG_KIND)
  lam <- rowSums(cbind(stats::rgamma(reps, 3, 4), stats::rgamma(reps, 3, 4)))
  loss <- stats::rbeta(reps, 30, 70)
  # screenings arrive at rate lam; each randomises with prob 1 - loss: randomisations form a Poisson process of rate lam (1 - loss)
  t_ref <- stats::rgamma(reps, shape = target, rate = lam * (1 - loss))
  m <- vcr_get_measure(base, "last_patient_in_months")
  z_med <- (m$value - stats::median(t_ref)) / sqrt(m$mcse^2 + vcr_quantile_mcse(t_ref, 0.5)^2)
  ev <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(al, be, c(0, 0)), target = target, eventTarget = kev, eventHazard = h),
                                  seed = 6L, replicates = reps, job_id = "job_n27c2"))
  me <- vcr_get_measure(ev, "target_events_months"); ml <- vcr_get_measure(ev, "last_patient_in_months")
  # independent: enrolment times are order statistics of a gamma process given the total rate
  t_ev <- vapply(seq_len(4000L), function(i) { l <- sum(stats::rgamma(2, 3, 4)); arr <- cumsum(stats::rexp(target, l)); sort(arr + stats::rexp(target, h))[kev] }, numeric(1))
  z_ev <- (me$value - stats::median(t_ev)) / sqrt(me$mcse^2 + vcr_quantile_mcse(t_ev, 0.5)^2)
  no_hazard <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = .n27_sites(al, be, c(0, 0)), target = target, eventTarget = kev), job_id = "job_n27c3"))
  ok <- abs(z_med) <= 3 && abs(z_ev) <= 3.5 && me$value > ml$value && me$interval$kind == "prediction" && me$mcse > 0 && isTRUE(me$simulated) &&
    identical(no_hazard$status, "failed") && "scenario_field_missing" %in% vcr_test_issue_codes(no_hazard)
  list(pass = ok,
       detail = sprintf("with a Beta(30,70) screen-failure loss: median last patient in %.3f +- %.3f vs %.3f from the independent construction (%.2f MCSE); target of 72 events: median %.3f [%.2f, %.2f] +- %.3f vs %.3f independently (%.2f MCSE), later than the last patient in (%.3f); an event target without an event hazard -> %s",
                        m$value, m$mcse, stats::median(t_ref), z_med, me$value, me$interval$low, me$interval$high, me$mcse, stats::median(t_ev), z_ev, ml$value,
                        paste(vcr_test_issue_codes(no_hazard), collapse = ",")))
})

vcr_case("N27d", c("AC-30", "AC-04"), function() {
  # Evidence pooling through the job, in the shape the contract fixes: studies are
  # `{ studyId, estimate, se }` on the analysis scale, `method` and `level` are
  # scenario keys, and the result names `pooled_estimate` (a confidence
  # interval) and, for k >= 3, `prediction_interval` (a prediction interval),
  # with the scale named. Against metafor to 1e-8 (REML to 1e-6): DerSimonian-
  # Laird, REML, Hartung-Knapp-Sidik-Jonkman and the fixed effect; the
  # prediction interval is Higgins-Thompson-Spiegelhalter's (t on k - 2).
  # The old handler read a different shape and failed on every job the evidence
  # pipeline sent (EB-1). One study is taken directly (DL and REML divide by a
  # zero heterogeneity denominator there), k = 2 has no prediction interval, and
  # a zero standard error is refused.
  suppressMessages(library(metafor))
  set.seed(8L)
  k <- 7L; vi <- stats::runif(k, 0.02, 0.12); yi <- stats::rnorm(k, -0.4, sqrt(vi + 0.05))
  studies <- lapply(seq_len(k), function(i) list(studyId = sprintf("st%d", i), estimate = yi[i], se = sqrt(vi[i])))
  run <- function(method, st = studies, extra = list()) vcr_test_run(vcr_test_job("evidence.pool", c(list(studies = st, method = method, scale = "log"), extra), job_id = "job_n27d"))
  refs <- list(random_effects_dl = list("DL", "z"), random_effects_reml = list("REML", "z"), random_effects_hksj = list("DL", "knha"), fixed_effect = list("FE", "z"))
  worst <- 0; rows <- list()
  for (m in names(refs)) {
    r <- run(m); fit <- metafor::rma(yi, vi, method = refs[[m]][[1]], test = refs[[m]][[2]], control = list(threshold = 1e-13, maxiter = 5000L))
    est <- vcr_get_measure(r, "pooled_estimate")
    d <- max(abs(est$value - fit$beta[1]), abs(est$interval$low - fit$ci.lb), abs(est$interval$high - fit$ci.ub), abs(vcr_measure_value(r, "tau_squared") - fit$tau2))
    tol <- if (m == "random_effects_reml") 1e-6 else 1e-8
    rows[[m]] <- list(d = d, tol = tol, kind = est$interval$kind, unit = est$unit)
  }
  dl <- run("random_effects_dl"); fit <- metafor::rma(yi, vi, method = "DL")
  pi_want <- fit$beta[1] + c(-1, 1) * stats::qt(0.975, k - 2) * sqrt(fit$tau2 + fit$se^2)
  pim <- vcr_get_measure(dl, "prediction_interval")
  ok_pi <- abs(pim$interval$low - pi_want[1]) < 1e-8 && abs(pim$interval$high - pi_want[2]) < 1e-8 && identical(pim$interval$kind, "prediction") && identical(pim$unit, "log")
  one <- run("random_effects_reml", studies[1]); two <- run("random_effects_dl", studies[1:2]); zero_se <- run("random_effects_dl", c(studies[1:2], list(list(studyId = "z", estimate = -0.4, se = 0))))
  ok <- all(vapply(rows, function(r) r$d < r$tol && identical(r$kind, "confidence") && identical(r$unit, "log"), logical(1))) && ok_pi &&
    identical(one$status, "succeeded") && identical(one$diagnostics$poolingMethodApplied, "single_study") && identical(one$diagnostics$poolingMethod, "random_effects_reml") &&
    abs(vcr_measure_value(one, "pooled_estimate") - yi[1]) < 1e-12 &&
    identical(two$status, "succeeded") && is.null(vcr_get_measure(two, "prediction_interval")) &&
    identical(zero_se$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(zero_se) &&
    all(vapply(dl$measures, function(m_) identical(m_$source, "aggregate"), logical(1)))
  list(pass = ok,
       detail = sprintf("k=7 vs metafor: %s; prediction interval [%.6f, %.6f] vs the HTS formula [%.6f, %.6f]; one study under REML -> applied '%s' (estimate = the study's); two studies -> no prediction interval; se = 0 -> %s",
                        paste(sprintf("%s |d| %.1e", sub("random_effects_", "", names(rows)), vapply(rows, function(r) r$d, numeric(1))), collapse = ", "),
                        pim$interval$low, pim$interval$high, pi_want[1], pi_want[2], one$diagnostics$poolingMethodApplied, paste(vcr_test_issue_codes(zero_se), collapse = ",")))
})
