# N10-N13 — restricted mean survival time, the tau rule, E-values and time zero.

vcr_case("N10", c("AC-12", "AC-30"), function() {
  # Exponential with median 12, tau = 24: RMST = (1 - exp(-lambda*24))/lambda.
  dist <- vcr_dist_exponential_from_median(12)
  analytic <- vcr_rmst_analytic(dist, 24)
  want <- 12.984
  # Large sample, no censoring: the step-function integral must land on the
  # analytic value within 3 standard errors, and the implementation must agree
  # with survRM2 to machine precision on the same data.
  suppressMessages(library(survRM2))
  set.seed(424242L, kind = VCR_RNG_KIND)
  # Large, uncensored: is the step-function integral the analytic value?
  # (survRM2 is not asked to do this one -- `rmst2` builds an O(n^2) working
  # matrix and a 200,000-row call takes the interpreter out with it.)
  n <- 50000L
  d <- data.frame(time = stats::rexp(n, dist$rate), status = 1L)
  r <- vcr_rmst(d$time, d$status, 24)
  # Small, censored: does the implementation equal survRM2 exactly?
  m <- 2000L
  dc <- vcr_sim_tte(m / 2, m / 2, dist, 0.8, list(kind = "uniform", duration = 12), 24)
  s2 <- survRM2::rmst2(dc$time, dc$status, dc$arm, tau = 18)
  r1 <- vcr_rmst(dc$time[dc$arm == 1L], dc$status[dc$arm == 1L], 18)
  d_pkg <- abs(r1$rmst - s2$RMST.arm1$rmst[1])
  d_se <- abs(r1$se - s2$RMST.arm1$rmst[2])
  ok <- abs(round(analytic, 3) - want) < 1e-9 && abs(r$rmst - analytic) <= 3 * r$se &&
    d_pkg < 1e-9 && d_se < 1e-9
  list(pass = ok,
       detail = sprintf("analytic %.6f (want %.3f); empirical %.6f (+-%.6f, %.2f SE away, n=%d uncensored); vs survRM2 on censored n=%d |d|=%.2e (se |d|=%.2e)",
                        analytic, want, r$rmst, r$se, abs(r$rmst - analytic) / r$se, n, m, d_pkg, d_se))
})

vcr_case("N11", c("AC-12", "AC-07"), function() {
  # tau past the shortest arm's longest follow-up must be refused by name,
  # and the refusal must carry the largest usable tau.
  set.seed(7L, kind = VCR_RNG_KIND)
  d <- rbind(
    data.frame(arm = 1L, time = pmin(stats::rexp(200, 0.05), 30), status = 1L),
    data.frame(arm = 0L, time = pmin(stats::rexp(200, 0.07), 18), status = 1L))
  rule <- vcr_tau_rule(d$time, d$status, d$arm, 24)
  ok_rule <- !is.null(rule) && identical(rule$rule, "tau_beyond_followup") &&
    rule$maxUsableTau <= 18 + 1e-9
  d$USUBJID <- sprintf("S%03d", seq_len(nrow(d)))
  in_subj <- vcr_test_input(d[, c("USUBJID", "arm")], "snp_n11:subject", "subject")
  in_event <- vcr_test_input(data.frame(USUBJID = d$USUBJID, PARAMCD = "OS", AVAL = d$time, CNSR = 1L - d$status), "snp_n11:event", "event")
  run <- function(tau) vcr_test_run(vcr_test_job("comparator.rmst", list(tau = tau, treatmentColumn = "arm"), list(in_subj, in_event), seed = 1L, job_id = "job_n11"))
  r <- run(24)
  usable <- vcr_tau_rule(d$time, d$status, d$arm, rule$maxUsableTau)
  r_ok <- run(floor(rule$maxUsableTau))
  ok <- ok_rule && identical(r$status, "not_estimable") &&
    identical(r$notEstimableRule, "tau_beyond_followup") && length(r$measures) == 0L &&
    is.null(usable) && identical(r_ok$status, "succeeded") &&
    abs(r$diagnostics$maxUsableTau - rule$maxUsableTau) < 1e-9
  list(pass = ok,
       detail = sprintf("tau=24 refused as %s; largest usable tau %.4f (arm follow-ups %.4f / %.4f) and that tau is accepted; measures=%d; tau %g runs",
                        r$notEstimableRule %||% "NULL", rule$maxUsableTau,
                        max(d$time[d$arm == 0L]), max(d$time[d$arm == 1L]), length(r$measures), floor(rule$maxUsableTau)))
})

vcr_case("N11b", c("AC-12", "AC-08", "AC-30"), function() {
  # The RMST job on ADaM tables, against survRM2 (the reference the plan
  # names): time is `AVAL` and CNSR = 1 means CENSORED, so the engine's
  # status is 1 - CNSR. A job that read CNSR as "event" would return a wildly
  # different (and confident) number; agreement with survRM2 to 1e-9 is what
  # proves the polarity. The result also keeps the counts apart: real patients
  # are observed rows only, events are the events, and the job refuses a
  # weight column (weighted RMST belongs to the weighting job, whose interval
  # re-estimates the weights).
  suppressMessages(library(survRM2))
  set.seed(1111L, kind = VCR_RNG_KIND)
  dist <- vcr_dist_exponential_from_median(12)
  dc <- vcr_sim_tte(200L, 200L, dist, 0.75, list(kind = "uniform", duration = 12), 24)
  dc$USUBJID <- sprintf("S%03d", seq_len(nrow(dc)))
  in_subj <- vcr_test_input(dc[, c("USUBJID", "arm")], "snp_n11b:subject", "subject")
  in_event <- vcr_test_input(data.frame(USUBJID = dc$USUBJID, PARAMCD = "OS", AVAL = dc$time, CNSR = 1L - dc$status), "snp_n11b:event", "event")
  tau <- 15
  r <- vcr_test_run(vcr_test_job("comparator.rmst", list(tau = tau, treatmentColumn = "arm"), list(in_subj, in_event), seed = 2L, job_id = "job_n11b"))
  ref <- survRM2::rmst2(dc$time, dc$status, dc$arm, tau = tau)
  est <- vcr_get_measure(r, "rmst_difference")
  ref_est <- ref$unadjusted.result[1, "Est."]; ref_lo <- ref$unadjusted.result[1, "lower .95"]; ref_hi <- ref$unadjusted.result[1, "upper .95"]
  wrong <- { sw <- dc$status; vcr_rmst_difference(dc$time, 1L - sw, dc$arm, tau)$estimate }   # what reading CNSR as status would give
  weighted <- vcr_test_run(vcr_test_job("comparator.rmst", list(tau = tau, treatmentColumn = "arm", weightColumn = "w"), list(in_subj, in_event), seed = 2L, job_id = "job_n11b_w"))
  ok <- identical(r$status, "succeeded") && abs(est$value - ref_est) < 1e-9 &&
    abs(est$interval$low - ref_lo) < 1e-9 && abs(est$interval$high - ref_hi) < 1e-9 &&
    abs(vcr_measure_value(r, "rmst_treatment") - ref$RMST.arm1$rmst[["Est."]]) < 1e-9 &&
    r$counts$realPatients == nrow(dc) && r$counts$events == sum(dc$status) && abs(wrong - est$value) > 0.5 &&
    identical(weighted$status, "failed")
  list(pass = ok,
       detail = sprintf("RMST difference %.9f vs survRM2 %.9f, interval [%.6f, %.6f] vs [%.6f, %.6f]; reading CNSR as the event indicator would give %.3f; realPatients %d, events %d; weightColumn refused: %s",
                        est$value, ref_est, est$interval$low, est$interval$high, ref_lo, ref_hi, wrong, r$counts$realPatients, r$counts$events,
                        paste(vcr_test_issue_codes(weighted), collapse = ",")))
})

vcr_case("N12", c("AC-30"), function() {
  suppressMessages(library(EValue))
  # E-values through the job on all three scales, against the EValue package.
  # The first version honoured no `scale`: an odds ratio or a hazard ratio was
  # run through the risk-ratio formula, which is only right for a rare outcome.
  # Each scale x rare/common x (point, CI limit) is checked, plus an estimate
  # below the null (inverted), a limit that includes the null (E-value 1), and
  # the refusals: a non-positive ratio and a limit on the far side of the estimate.
  job <- function(sc) vcr_test_run(vcr_test_job("comparator.evalue", sc, seed = 1L, job_id = "job_n12"))
  one <- function(est, lo = NULL, hi = NULL, scale = "risk_ratio", rare = NULL) {
    sc <- list(riskRatio = est, scale = scale)
    if (!is.null(rare)) sc$rare <- rare
    lim <- if (est >= 1) lo else hi
    if (!is.null(lim)) sc$confidenceLimit <- lim
    r <- job(sc)
    pk <- switch(scale, risk_ratio = EValue::evalues.RR(est, lo = lo %||% NA, hi = hi %||% NA),
                 odds_ratio = EValue::evalues.OR(est, lo = lo %||% NA, hi = hi %||% NA, rare = isTRUE(rare)),
                 hazard_ratio = EValue::evalues.HR(est, lo = lo %||% NA, hi = hi %||% NA, rare = isTRUE(rare)))
    want_p <- unname(pk["E-values", "point"])
    want_l <- if (is.null(lim)) NA_real_ else unname(pk["E-values", if (est >= 1) "lower" else "upper"])
    got_l <- vcr_measure_value(r, "e_value_confidence_limit")
    d <- max(abs(vcr_measure_value(r, "e_value") - want_p), if (is.null(lim) || is.na(want_l)) 0 else abs(got_l - want_l))
    list(status = r$status, d = d, point = vcr_measure_value(r, "e_value"))
  }
  grid <- list(
    one(3.9, lo = 1.8), one(0.5, lo = 0.3, hi = 0.8), one(1.4, lo = 0.9, hi = 2.1),
    one(2.0, lo = 1.3, hi = 3.1, scale = "odds_ratio", rare = TRUE), one(2.0, lo = 1.3, hi = 3.1, scale = "odds_ratio", rare = FALSE),
    one(0.6, lo = 0.4, hi = 0.9, scale = "odds_ratio", rare = FALSE),
    one(1.8, lo = 1.2, hi = 2.6, scale = "hazard_ratio", rare = TRUE), one(1.8, lo = 1.2, hi = 2.6, scale = "hazard_ratio", rare = FALSE),
    one(0.6, lo = 0.4, hi = 0.9, scale = "hazard_ratio", rare = FALSE))
  ok_grid <- all(vapply(grid, function(g) identical(g$status, "succeeded") && g$d < 1e-6, logical(1)))
  # the book value of the plan's example: RR 3.9 -> 7.26, limit 1.8 -> 3.0
  book <- job(list(riskRatio = 3.9, confidenceLimit = 1.8))
  ok_book <- abs(vcr_measure_value(book, "e_value") - 7.26) < 5e-3 && abs(vcr_measure_value(book, "e_value_confidence_limit") - 3.0) < 1e-6
  refused <- list(job(list(riskRatio = -2)), job(list(riskRatio = 0)), job(list(riskRatio = 2, confidenceLimit = 3)), job(list(riskRatio = 0.5, confidenceLimit = 0.2)))
  ok_refused <- all(vapply(refused, function(r) identical(r$status, "failed") && length(r$measures) == 0L, logical(1)))
  ok <- ok_grid && ok_book && ok_refused
  list(pass = ok,
       detail = sprintf("%d scale/rarity/limit combinations agree with the EValue package (max|d| %.1e); RR 3.9 -> %.4f (book 7.26), limit 1.8 -> %.4f (book 3.0); RR <= 0 and a far-side limit refused (%d/4 failed without a number)",
                        length(grid), max(vapply(grid, function(g) g$d, numeric(1))), vcr_measure_value(book, "e_value"),
                        vcr_measure_value(book, "e_value_confidence_limit"), sum(vapply(refused, function(r) identical(r$status, "failed"), logical(1)))))
})

vcr_case("N13", c("AC-12"), function() {
  # Immortal time: treatment starts after eligibility, and only survivors can
  # start it. True hazard ratio is 1. Classifying by "ever treated" and
  # starting the clock at eligibility must look strongly protective;
  # aligning the clock (counting-process form) must recover 1.
  suppressMessages(library(survival))
  set.seed(20260928L, kind = VCR_RNG_KIND)
  n <- 4000L
  t_event <- stats::rexp(n, 0.05)
  t_start <- stats::rexp(n, 0.04)              # would-be initiation time
  admin <- 40
  obs <- pmin(t_event, admin)
  status <- as.integer(t_event <= admin)
  ever <- as.integer(t_start < obs)            # only survivors can start
  naive <- summary(survival::coxph(survival::Surv(obs, status) ~ ever))$coefficients
  # Correct alignment: split each subject at their initiation time.
  split <- do.call(rbind, lapply(seq_len(n), function(i) {
    if (ever[i] == 1L) {
      rbind(data.frame(start = 0, stop = t_start[i], event = 0L, trt = 0L),
            data.frame(start = t_start[i], stop = obs[i], event = status[i], trt = 1L))
    } else {
      data.frame(start = 0, stop = obs[i], event = status[i], trt = 0L)
    }
  }))
  aligned <- summary(survival::coxph(survival::Surv(start, stop, event) ~ trt, data = split))$coefficients
  biased <- naive[1, "z"] < -3
  recovered <- abs(aligned[1, "coef"]) <= 3 * aligned[1, "se(coef)"]
  list(pass = biased && recovered,
       detail = sprintf("true logHR 0; misaligned logHR %+.4f (z %.2f, %s); aligned logHR %+.4f (se %.4f, %.2f SE from 0)",
                        naive[1, "coef"], naive[1, "z"], if (biased) "biased as expected" else "NOT biased",
                        aligned[1, "coef"], aligned[1, "se(coef)"],
                        abs(aligned[1, "coef"]) / aligned[1, "se(coef)"]))
})

vcr_case("N13b", c("AC-08", "AC-12", "AC-11"), function() {
  # A time-to-event external control through the weighting job. The job used to
  # be endpoint-blind: it returned the weighted mean of the censored follow-up
  # times as "the effect" and called it estimable (EB-2). The truth here is
  # known: a proportional-hazards effect (HR 0.6) with a confounder that raises
  # both the chance of being treated and the hazard; the ATT is the difference in
  # RMST(tau = 20) between the treated and what the *same people* would have had
  # untreated, computed by integrating the exponential survival functions over a
  # 2-million-draw sample of the treated population's confounder. One dataset,
  # 4,000 patients, weights re-estimated in each of 2,000 bootstrap resamples:
  # the estimate must be within 3 bootstrap SEs of the truth, the interval must
  # cover it, the unweighted (confounded) difference must NOT, and the job must
  # report RMST, not a mean of times.
  set.seed(20260929L, kind = VCR_RNG_KIND)
  n <- 4000L; tau <- 20; lam0 <- 0.05; hr <- 0.6; beta <- 0.5; admin <- 30
  x <- stats::rnorm(n)
  arm <- stats::rbinom(n, 1L, stats::plogis(-0.4 + 0.8 * x))
  t_ev <- stats::rexp(n, lam0 * exp(beta * x) * hr^arm)
  cens <- stats::runif(n, 12, admin)
  time <- pmin(t_ev, cens); status <- as.integer(t_ev <= cens)
  # truth: the ATT contrast over the treated population's confounder
  m <- 2e6L; xs <- stats::rnorm(m); keep <- stats::runif(m) < stats::plogis(-0.4 + 0.8 * xs)
  xt <- xs[keep]
  rm_of <- function(rate) mean((1 - exp(-rate * tau)) / rate)
  truth <- rm_of(lam0 * exp(beta * xt) * hr) - rm_of(lam0 * exp(beta * xt))
  df <- data.frame(USUBJID = sprintf("S%04d", seq_len(n)), arm = arm, x = x)
  ev <- data.frame(USUBJID = df$USUBJID, PARAMCD = "OS", AVAL = time, CNSR = 1L - status)
  in_subj <- vcr_test_input(df, "snp_n13b:subject", "subject"); in_event <- vcr_test_input(ev, "snp_n13b:event", "event")
  r <- vcr_test_run(vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x"), treatmentColumn = "arm", endpoint = list(type = "time_to_event"), tau = tau),
    list(in_subj, in_event), seed = 13L, job_id = "job_n13b", cores = VCR_TEST_CORES))
  est <- vcr_get_measure(r, "rmst_difference")
  naive <- vcr_rmst_difference(time, status, arm, tau)
  boot_se <- (est$interval$high - est$interval$low) / (2 * 1.96)
  cover <- est$interval$low <= truth && truth <= est$interval$high
  ok <- identical(r$status, "succeeded") && !is.null(est) && abs(est$value - truth) <= 3 * boot_se && cover &&
    !(naive$interval[1] <= truth && truth <= naive$interval[2]) &&
    !is.null(vcr_get_measure(r, "survival_difference_at_tau")) && r$counts$events == sum(status) &&
    r$diagnostics$bootstrapReplicates >= 2000L && identical(r$diagnostics$endpoint, "time_to_event")
  list(pass = ok,
       detail = sprintf("true ATT RMST difference %.4f; weighted %.4f, bootstrap SE %.4f (%.2f SE away), interval [%.4f, %.4f] covers: %s; the unweighted difference %.4f [%.4f, %.4f] is confounded and misses; survival difference at tau %.4f; %d bootstrap draws; events %d",
                        truth, est$value, boot_se, abs(est$value - truth) / boot_se, est$interval$low, est$interval$high, cover,
                        naive$estimate, naive$interval[1], naive$interval[2], vcr_measure_value(r, "survival_difference_at_tau"),
                        r$diagnostics$bootstrapReplicates, r$counts$events))
})
