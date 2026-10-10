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

vcr_case("N27e", c("AC-04", "AC-26", "AC-30"), function() {
  # A target number of events is counted among EVERY patient: the ones still to enrol and the ones the sites already enrolled (N27f
  # holds the numbers). So the event target is legal up to the number of patients -- the enrolment target, or the patients already
  # enrolled if there are more -- and a larger one is never reached: the run found no finite event time and ended as a handler error
  # ("vcr_measure stopped on the NA MCSE") after all its replicates. That is refused up front, by name, before any replicate runs, in
  # the validator and in the handler. The first version of this rule counted only the patients still to enrol and refused every target
  # above them, which was the missing half of the model (the enrolled patients' events were neither observed nor simulated).
  reps <- 2000L; h <- 0.08
  sites <- function(enrolled = NULL) .n27_sites(c(3, 3), c(4, 4), c(0, 0), enrolled = enrolled)
  run <- function(target, kev, enrolled = NULL, tag) vcr_test_run(vcr_test_job("accrual.poisson_gamma",
    list(sites = sites(enrolled), target = target, eventTarget = kev, eventHazard = h), seed = 7L, replicates = reps, job_id = paste0("job_n27e_", tag)))
  codes <- function(r) paste(vapply(c(r$diagnostics$issues %||% list()), function(i) paste0(i$code, "@", i$field), character(1)), collapse = "+")
  refused <- function(r) identical(r$status, "failed") && identical(codes(r), "scenario_value_invalid@scenario.eventTarget") && is.null(r$diagnostics$replicatesCompleted)
  # the validator on its own, which is what the job runs first
  verdict <- function(target, kev, enrolled) vapply(vcr_validate_scenario("accrual.poisson_gamma", vcr_test_json(list(sites = sites(enrolled), target = target, eventTarget = kev, eventHazard = h))),
                                                     function(i) paste0(i$code, "@", i$field), character(1))
  # 2 sites x 20 enrolled = 40 of 80: 40 patients are still to enrol, 80 patients in all
  beyond <- run(80L, 81L, 20L, "beyond"); inside <- run(80L, 60L, 20L, "inside"); all_pat <- run(80L, 80L, 20L, "all")
  # nothing enrolled: 41 events among 40 patients
  none_beyond <- run(40L, 41L, NULL, "none"); none_ok <- run(40L, 40L, NULL, "none_ok")
  # more enrolled than the target (2 x 50 against 80): 100 patients, nobody left to enrol
  over_beyond <- run(80L, 101L, 50L, "over_beyond"); over_ok <- run(80L, 100L, 50L, "over_ok")
  v_beyond <- verdict(80L, 81L, 20L); v_inside <- verdict(80L, 60L, 20L); v_over <- verdict(80L, 101L, 50L); v_over_ok <- verdict(80L, 100L, 50L)
  fine <- function(r) identical(r$status, "succeeded") && is.finite(vcr_measure_value(r, "target_events_months")) && is.finite(vcr_get_measure(r, "target_events_months")$mcse)
  ok <- refused(beyond) && refused(none_beyond) && refused(over_beyond) &&
    identical(v_beyond, "scenario_value_invalid@scenario.eventTarget") && identical(v_over, "scenario_value_invalid@scenario.eventTarget") &&
    length(v_inside) == 0L && length(v_over_ok) == 0L && fine(inside) && fine(all_pat) && fine(none_ok) && fine(over_ok) &&
    vcr_measure_value(inside, "target_events_months") > vcr_measure_value(inside, "last_patient_in_months") - 40
  list(pass = ok,
       detail = sprintf("40 of 80 enrolled: 81 events -> %s (%s), validator %s; 60 events (more than the 40 still to enrol) -> %s, median %.3f, validator clean: %s; 80 events -> %s; nothing enrolled, 40 patients: 41 events -> %s, 40 events -> %s; 100 enrolled of a target of 80: 101 events -> %s, validator %s, 100 events -> %s (last patient in %.3f)",
                        beyond$status, codes(beyond), paste(v_beyond, collapse = "+"), inside$status, vcr_measure_value(inside, "target_events_months") %||% NA_real_,
                        length(v_inside) == 0L, all_pat$status, codes(none_beyond), none_ok$status, codes(over_beyond), paste(v_over, collapse = "+"), over_ok$status,
                        vcr_measure_value(over_ok, "last_patient_in_months") %||% NA_real_))
})

vcr_case("N27f", c("AC-30", "AC-28", "AC-04"), function() {
  # The events of the patients already enrolled. A forecast of the time to a target number of events counted only the patients it
  # was still to enrol: the enrolled ones were neither observed nor simulated, so the time came out late, and with nothing left to
  # enrol the early "target met" answer dropped the event target without a word. The sites give `enrolled` and `exposureTime`, the
  # time they have been open, so each enrolled patient has been followed for U(0, exposureTime) (k arrivals of a constant-rate
  # Poisson process over [0, exposure] are k uniform draws) and has an event time of Exp(hazard) from enrolment; an event already
  # behind us counts at time 0.
  # (a) NOBODY left to enrol: the number of events by time t is a sum of independent binomials -- an enrolled patient of a site open for
  # tau has had an event by now + t with probability 1 - exp(-h t) (1 - exp(-h tau)) / (h tau) -- so the distribution of the time of the
  # E-th event is exact, by convolving the sites' binomials; no simulation stands behind the reference. (b) Patients still to enrol:
  # the time to the E-th event among both groups against a plain-R simulation written here (gamma rates, exponential arrivals,
  # uniform follow-up of the enrolled), within the two Monte-Carlo errors; the first version's median is later by a clear margin.
  h <- 0.1
  site <- function(id, n, tau, alpha = 3, beta = 4) list(id = id, alpha = alpha, beta = beta, startTime = 0, enrolled = n, exposureTime = tau)
  p_by <- function(t, tau) 1 - exp(-h * t) * (1 - exp(-h * tau)) / (h * tau)
  conv <- function(a, b) { out <- numeric(length(a) + length(b) - 1L); for (i in seq_along(a)) { j <- i:(i + length(b) - 1L); out[j] <- out[j] + a[i] * b }; out }
  at_least <- function(t, n, tau, kev) { pmf <- Reduce(conv, lapply(seq_along(n), function(i) stats::dbinom(0:n[i], n[i], p_by(t, tau[i])))); sum(pmf[(kev + 1L):length(pmf)]) }
  ref_q <- function(q, n, tau, kev) if (at_least(0, n, tau, kev) >= q) 0 else stats::uniroot(function(t) at_least(t, n, tau, kev) - q, c(0, 1e4), tol = 1e-12)$root
  reps <- 20000L
  # (a) 30 patients from a site open 12 months and 10 from a site open 6: 40 of 40 enrolled
  n <- c(30L, 10L); tau <- c(12, 6)
  rows <- lapply(c(30L, 22L, 8L), function(kev) {
    sc <- list(sites = list(site("a", n[1], tau[1]), site("b", n[2], tau[2])), target = 40L, eventTarget = kev, eventHazard = h)
    r <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", sc, seed = 2710L + kev, replicates = reps, job_id = paste0("job_n27f_", kev)))
    m <- vcr_get_measure(r, "target_events_months"); ml <- vcr_get_measure(r, "last_patient_in_months")
    q <- c(ref_q(0.1, n, tau, kev), ref_q(0.5, n, tau, kev), ref_q(0.9, n, tau, kev))
    reached <- at_least(0, n, tau, kev)
    past_ref <- sum(n * vapply(tau, function(t) p_by(0, t), numeric(1)))
    list(kev = kev, status = r$status, present = !is.null(m), last = ml$value %||% NA_real_, med = m$value %||% NA_real_, lo = m$interval$low %||% NA_real_, hi = m$interval$high %||% NA_real_,
         z_med = (m$value - q[2]) / max(m$mcse, 1e-9), q = q, mcse = m$mcse %||% NA_real_,
         reached = r$diagnostics$eventForecast$alreadyReachedShare %||% NA_real_, reached_ref = reached,
         past = r$diagnostics$eventForecast$eventsAlreadyHappenedMean %||% NA_real_, past_ref = past_ref)
  })
  ok_a <- all(vapply(rows, function(x) x$status == "succeeded" && x$present && identical(x$last, 0) &&
    abs(x$lo - x$q[1]) < 0.15 && abs(x$hi - x$q[3]) < 0.15 &&
    (if (x$mcse > 0) abs(x$z_med) <= 3.5 else abs(x$med - x$q[2]) < 1e-9) &&
    abs(x$reached - x$reached_ref) <= 4 * sqrt(x$reached_ref * (1 - x$reached_ref) / reps + 1e-12) + 1e-9 && abs(x$past - x$past_ref) < 0.15, logical(1)))
  # (b) 2 sites open now, 20 enrolled each over 12 months, 40 patients still to enrol, 36 events among the 80: independent simulation
  kev <- 36L; reps_b <- 20000L
  sc_b <- list(sites = list(site("a", 20L, 12), site("b", 20L, 12)), target = 80L, eventTarget = kev, eventHazard = h)
  r_b <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", sc_b, seed = 2799L, replicates = reps_b, job_id = "job_n27f_b"))
  m_b <- vcr_get_measure(r_b, "target_events_months")
  set.seed(2801L, kind = VCR_RNG_KIND)
  t_ev <- vapply(seq_len(6000L), function(i) {
    lam <- sum(stats::rgamma(2, 3, 4)); arrive <- cumsum(stats::rexp(40L, lam))
    enrolled_ev <- pmax(stats::rexp(40L, h) - stats::runif(40L) * 12, 0)
    sort(c(arrive + stats::rexp(40L, h), enrolled_ev))[kev]
  }, numeric(1))
  z_b <- (m_b$value - stats::median(t_ev)) / sqrt(m_b$mcse^2 + vcr_quantile_mcse(t_ev, 0.5)^2)
  # what the first version computed: the same event time over the 40 patients still to enrol alone
  t_old <- vapply(seq_len(6000L), function(i) { lam <- sum(stats::rgamma(2, 3, 4)); sort(cumsum(stats::rexp(40L, lam)) + stats::rexp(40L, h))[kev] }, numeric(1))
  ok_b <- identical(r_b$status, "succeeded") && abs(z_b) <= 3.5 && stats::median(t_old) - m_b$value > 10 * sqrt(m_b$mcse^2 + vcr_quantile_mcse(t_old, 0.5)^2)
  list(pass = ok_a && ok_b,
       detail = sprintf("nobody left to enrol (30+10 enrolled, open 12 and 6 months, hazard 0.1): %s; 40 still to enrol, 36 events among 80: median %.3f +- %.3f vs %.3f independently (%.2f MCSE), the median over the 40 still to enrol alone would be %.3f",
                        paste(vapply(rows, function(x) sprintf("%d events: median %.3f vs exact %.3f (p10 %.3f / %.3f, p90 %.3f / %.3f), already reached %.4f / %.4f, events already happened %.2f / %.2f, last patient in %.1f",
                                     x$kev, x$med, x$q[2], x$lo, x$q[1], x$hi, x$q[3], x$reached, x$reached_ref, x$past, x$past_ref, x$last), character(1)), collapse = "; "),
                        m_b$value, m_b$mcse, stats::median(t_ev), z_b, stats::median(t_old)))
})

vcr_case("N27g", c("AC-30", "AC-04"), function() {
  # A site's `id` is its name in the scenario; the result now carries it back with what the site brought to the forecast (the posterior
  # mean rate alpha / beta, when it opens, how many it enrolled and over how long), in the order the scenario listed them. The id
  # was required and never read, so a result could not be attributed to a site. A forecast that needs no simulation (the target
  # already met) and one that does carry the same rows.
  mk <- function(id, alpha, beta, start, n = NULL, tau = NULL) { s <- list(id = id, alpha = alpha, beta = beta, startTime = start); if (!is.null(n)) { s$enrolled <- n; s$exposureTime <- tau }; s }
  sites <- list(mk("site_b", 3, 5, 3, 4L, 5), mk("site_a", 2, 4, 0), mk("site_c", 6, 8, 1.5))
  want <- list(list(id = "site_b", meanRate = 3 / 5, startTime = 3, enrolled = 4, exposureTime = 5),
               list(id = "site_a", meanRate = 2 / 4, startTime = 0, enrolled = 0, exposureTime = 0),
               list(id = "site_c", meanRate = 6 / 8, startTime = 1.5, enrolled = 0, exposureTime = 0))
  same <- function(got) length(got) == 3L && all(vapply(seq_along(want), function(i) {
    g <- got[[i]]; w <- want[[i]]
    identical(g$id, w$id) && all(vapply(c("meanRate", "startTime", "enrolled", "exposureTime"), function(k) abs(g[[k]] - w[[k]]) < 1e-12, logical(1)))
  }, logical(1)))
  closed <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = sites[c(2, 3)], target = 60L), job_id = "job_n27g_closed"))
  simulated <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = sites, target = 60L), seed = 11L, replicates = 400L, job_id = "job_n27g_sim"))
  met <- vcr_test_run(vcr_test_job("accrual.poisson_gamma", list(sites = sites, target = 4L), job_id = "job_n27g_met"))
  ok <- identical(simulated$status, "succeeded") && same(simulated$diagnostics$sites) && identical(met$status, "succeeded") && same(met$diagnostics$sites) &&
    identical(closed$status, "succeeded") && length(closed$diagnostics$sites) == 2L && identical(closed$diagnostics$sites[[1]]$id, "site_a") && identical(closed$diagnostics$sites[[2]]$id, "site_c")
  list(pass = ok,
       detail = sprintf("three sites named %s come back in the result in that order with their mean rates (%s), start times, enrolled counts and exposures; the same for a forecast with the target already met and for a closed-form one (%d rows)",
                        paste(vapply(simulated$diagnostics$sites %||% list(), function(x) x$id, character(1)), collapse = "/"),
                        paste(vapply(simulated$diagnostics$sites %||% list(), function(x) format(x$meanRate, digits = 4), character(1)), collapse = "/"), length(closed$diagnostics$sites)))
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
