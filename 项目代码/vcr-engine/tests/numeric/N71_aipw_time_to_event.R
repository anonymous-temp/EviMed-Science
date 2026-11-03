# N71 — comparator.aipw 1.3.0: a time-to-event outcome (algorithm round C8, 2026-11-03).
#
# References that are not the method's own code: the Kaplan-Meier restricted mean of each arm from `survRM2::rmst2` (the mean of an arm's
# pseudo-observations is exactly that number); the exact leave-one-out jackknife pseudo-observations, which the influence-function ones
# approximate to O(1/n); the augmented estimator written out again from its formula on `stats::glm` fits; and a simulation whose
# true ATT restricted mean is integrated exactly (Gauss-Hermite) rather than simulated, with four specifications of the two working
# models (both right, either wrong, both wrong), which is what "doubly robust" means, on a mixture of exponentials whose conditional
# restricted mean is linear in the covariates so that "the outcome model is right" can be true.

.n71_censored <- function(n = 300L, rate = 0.1) {
  t0 <- stats::rexp(n, rate); c0 <- stats::runif(n, 2, 30)
  list(time = round(pmin(t0, c0), 2), status = as.integer(t0 <= c0))
}

vcr_case("N71a", c("AC-08", "AC-30"), function() {
  # The pseudo-observations. Their mean is the Kaplan-Meier value exactly (rmst2 for the restricted mean, survfit for the survival), and each
  # person's value differs from the exact leave-one-out jackknife by O(1/n): at n = 300 and n = 1200 the largest difference is a small and
  # shrinking share of their spread.
  suppressMessages(library(survRM2))
  set.seed(20261103L, kind = VCR_RNG_KIND)
  tau <- 12
  rows <- lapply(c(300L, 1200L), function(n) {
    s <- .n71_censored(n)
    out <- lapply(c("rmst", "survival"), function(summ) {
      p <- vcr_km_pseudo(s$time, s$status, tau, summ)
      est <- function(tm, st) if (summ == "rmst") vcr_rmst(tm, st, tau, NULL, variance = FALSE)$rmst else vcr_km_at(vcr_km(tm, st), tau)
      full <- est(s$time, s$status)
      jk <- vapply(seq_len(n), function(i) n * full - (n - 1) * est(s$time[-i], s$status[-i]), numeric(1))
      list(summary = summ, n = n, mean_gap = abs(mean(p$pseudo) - p$estimate), gap = max(abs(p$pseudo - jk)) / stats::sd(jk), estimate = p$estimate, est_check = full)
    })
    list(out = out, s = s)
  })
  # rmst2 needs two arms: the same 300 people as one arm of a pair, the other arm a copy shifted so it is a different sample
  s1 <- rows[[1]]$s
  r2 <- survRM2::rmst2(c(s1$time, s1$time + 1), c(s1$status, s1$status), rep(0:1, each = 300L), tau = tau)
  sf <- survival::survfit(survival::Surv(time, status) ~ 1, data = data.frame(time = s1$time, status = s1$status))
  s_tau <- summary(sf, times = tau)$surv
  rmst_ref <- r2$RMST.arm0$rmst[["Est."]]; mine_rmst <- rows[[1]]$out[[1]]$estimate; mine_surv <- rows[[1]]$out[[2]]$estimate
  gaps <- unlist(lapply(rows, function(r) lapply(r$out, function(o) o$gap)))
  g300 <- c(rows[[1]]$out[[1]]$gap, rows[[1]]$out[[2]]$gap); g1200 <- c(rows[[2]]$out[[1]]$gap, rows[[2]]$out[[2]]$gap)
  means <- unlist(lapply(rows, function(r) lapply(r$out, function(o) o$mean_gap)))
  ok <- all(means < 1e-10) && abs(mine_rmst - rmst_ref) < 1e-9 && abs(mine_surv - s_tau) < 1e-12 &&
    max(g300) < 0.06 && max(g1200) < 0.03 && all(g1200 < g300)
  list(pass = ok,
       detail = sprintf("mean of the pseudo-observations = the Kaplan-Meier value (largest gap %.1e); restricted mean %.8f vs survRM2 %.8f, survival at %g %.10f vs survfit %.10f; largest difference from the exact jackknife in SDs: n = 300 %.4f (rmst) / %.4f (survival), n = 1200 %.4f / %.4f",
                        max(means), mine_rmst, rmst_ref, tau, mine_surv, s_tau, g300[1], g300[2], g1200[1], g1200[2]))
})

.n71_job <- function(d, ev, id, scenario = list(), seed = 3L, replicates = 400L, cores = 1L) {
  sc <- utils::modifyList(list(covariates = list("x1", "x2"), treatmentColumn = "arm", endpoint = list(type = "time_to_event"), tau = 5, timeUnit = "months", summary = "rmst"), scenario)
  vcr_test_job("comparator.aipw", sc, list(vcr_test_input(d[, c("USUBJID", "arm", "x1", "x2")], paste0("snp_", id, ":subject"), "subject"),
                                            vcr_test_input(ev, paste0("snp_", id, ":events"), "event")),
               seed = seed, job_id = paste0("job_", id), replicates = replicates, cores = cores)
}

# the data of the simulation below: a mixture of a fast and a slow exponential whose weight is linear in the covariates
.n71_p <- function(x1, x2) 0.5 + 0.06 * x1 + 0.05 * x2
.n71_gen <- function(n = 1000L, a = -1.2, b1 = 1, b2 = 1, tau_max = 12, effect = 0.6) {
  x1 <- stats::rnorm(n); x2 <- stats::rnorm(n); arm <- stats::rbinom(n, 1L, stats::plogis(a + b1 * x1 + b2 * x2))
  p <- .n71_p(x1, x2) * ifelse(arm == 1L, effect, 1)
  fast <- stats::rbinom(n, 1L, p); tt <- stats::rexp(n, ifelse(fast == 1L, 0.5, 0.1)); cc <- stats::runif(n, 3, tau_max)
  data.frame(USUBJID = sprintf("S%05d", seq_len(n)), arm = arm, x1 = x1, x2 = x2, time = pmin(tt, cc), status = as.integer(tt <= cc))
}

vcr_case("N71b", c("AC-08", "AC-30"), function() {
  # The job against references. The trial arm's mean is its Kaplan-Meier restricted mean (rmst2); the augmented estimate is the formula
  # written out again on glm fits and the job's pseudo-observations; with a covariate that carries no information the adjusted difference is
  # the unadjusted rmst2 difference to within a fraction of its standard error; the survival summary reads the survival difference at tau;
  # a horizon beyond follow-up is a not-estimable result with its rule; a 1.2.0 job with a time-to-event outcome is refused.
  suppressMessages(library(survRM2))
  set.seed(20261108L, kind = VCR_RNG_KIND)
  d <- .n71_gen(1000L)
  ev <- data.frame(USUBJID = d$USUBJID, PARAMCD = "OS", AVAL = d$time, CNSR = 1L - d$status)
  dir <- tempfile("n71b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- vcr_test_run(.n71_job(d, ev, "n71b"), output_dir = dir)
  v <- function(res, name) vcr_measure_value(res, name)
  tau <- 5
  rm <- survRM2::rmst2(d$time, d$status, d$arm, tau = tau)
  # by hand: pseudo-observations from the job's own function (the kernel under test), everything after them from glm
  y <- numeric(nrow(d)); for (a in 0:1) y[d$arm == a] <- vcr_km_pseudo(d$time[d$arm == a], d$status[d$arm == a], tau, "rmst")$pseudo
  e <- as.vector(stats::fitted(stats::glm(arm ~ x1 + x2, data = d, family = stats::binomial())))
  om <- stats::glm(y ~ x1 + x2, data = cbind(d, y = y)[d$arm == 0L, ], family = stats::gaussian()); m0 <- stats::predict(om, d)
  t1 <- d$arm == 1L; w <- e / (1 - e); mu0 <- (sum(m0[t1]) + sum((w * (y - m0))[!t1])) / sum(t1); hand <- mean(y[t1]) - mu0
  # an uninformative covariate: no adjustment to make
  dn <- d; dn$x1 <- stats::rnorm(nrow(d)); dn$x2 <- stats::rnorm(nrow(d))
  rn <- vcr_test_run(.n71_job(dn, ev, "n71bn", replicates = 400L))
  rm_n <- survRM2::rmst2(dn$time, dn$status, dn$arm, tau = tau)
  se_n <- (vcr_get_measure(rn, "aipw_difference")$interval$high - vcr_get_measure(rn, "aipw_difference")$interval$low) / (2 * 1.96)
  # the survival summary
  rs <- vcr_test_run(.n71_job(d, ev, "n71bs", scenario = list(summary = "survival")))
  sf <- survival::survfit(survival::Surv(time, status) ~ arm, data = d); s1 <- summary(sf[2], times = tau)$surv
  # a horizon past the follow-up of an arm
  rb <- vcr_test_run(.n71_job(d, ev, "n71bb", scenario = list(tau = 500)))
  old <- .n71_job(d, ev, "n71bo"); old$methodVersion <- "1.2.0"
  ro <- vcr_test_run(old)
  ok <- identical(r$status, "succeeded") && identical(rs$status, "succeeded") &&
    abs(v(r, "outcome_mean_treated") - rm$RMST.arm1$rmst[["Est."]]) < 1e-9 &&
    abs(v(r, "aipw_difference") - hand) < 1e-10 && abs(v(rs, "outcome_mean_treated") - s1) < 1e-12 &&
    !is.null(vcr_get_measure(r, "aipw_difference")$interval) && identical(vcr_get_measure(r, "aipw_difference")$unit, "months") && is.null(vcr_get_measure(rs, "aipw_difference")$unit) &&
    abs(v(rn, "aipw_difference") - rm_n$unadjusted.result[1, "Est."]) < 0.6 * se_n &&
    identical(rb$status, "not_estimable") && identical(rb$notEstimableRule, "tau_beyond_followup") &&
    !identical(ro$status, "succeeded") && is.null(vcr_get_measure(r, "aipw_risk_ratio")) &&
    identical(r$diagnostics$timeToEvent$censoring, "independent of the covariates within an arm") &&
    length(vcr_validate_result(r)) == 0L && length(vcr_validate_result(rs)) == 0L
  list(pass = ok,
       detail = sprintf("trial arm restricted mean %.8f vs rmst2 %.8f; adjusted difference %.10f vs by hand %.10f; survival at 5 in the trial arm %.10f vs survfit %.10f; uninformative covariates: adjusted %.4f vs rmst2 unadjusted %.4f (se %.4f); tau 500: %s / %s; a 1.2.0 label: %s",
                        v(r, "outcome_mean_treated"), rm$RMST.arm1$rmst[["Est."]], v(r, "aipw_difference"), hand, v(rs, "outcome_mean_treated"), s1,
                        v(rn, "aipw_difference"), rm_n$unadjusted.result[1, "Est."], se_n, rb$status, rb$notEstimableRule %||% "-", paste(vcr_test_issue_codes(ro), collapse = ",")))
})

vcr_case("N71c", c("AC-08", "AC-11", "AC-30"), function() {
  # Double robustness against a truth integrated exactly. The same simulated trials are analysed under four specifications of the two
  # working models: either wrong leaves the estimate unbiased (to 3.5 Monte-Carlo errors), both wrong does not. The outcome model is
  # right when it has both covariates (the conditional restricted mean is linear in them) and wrong with one; the score model likewise.
  set.seed(20261109L, kind = VCR_RNG_KIND)
  tau <- 5; rf <- 0.5; rs <- 0.1; a <- -1.2; b1 <- 1; b2 <- 1
  Rm <- function(p) p * (1 - exp(-rf * tau)) / rf + (1 - p) * (1 - exp(-rs * tau)) / rs
  gh <- .vcr_gauss_hermite(40); nodes <- sqrt(2) * gh$nodes; wts <- gh$weights / sqrt(pi)
  g <- expand.grid(i = 1:40, j = 1:40); x1 <- nodes[g$i]; x2 <- nodes[g$j]; w <- wts[g$i] * wts[g$j]
  pt <- stats::plogis(a + b1 * x1 + b2 * x2)
  truth <- sum(w * pt * (Rm(0.6 * .n71_p(x1, x2)) - Rm(.n71_p(x1, x2)))) / sum(w * pt)
  one <- function(d, ps_cov, out_cov) vcr_aipw_tte_att(d$time, d$status, d$arm, as.matrix(d[, ps_cov, drop = FALSE]), as.matrix(d[, out_cov, drop = FALSE]), tau, "rmst", with_if = FALSE)$tau
  R <- 300L
  res <- replicate(R, { d <- .n71_gen(1000L); c(rr = one(d, c("x1", "x2"), c("x1", "x2")), rw = one(d, c("x1", "x2"), "x1"), wr = one(d, "x1", c("x1", "x2")), ww = one(d, "x1", "x1")) })
  bias <- rowMeans(res) - truth; mcse <- apply(res, 1, stats::sd) / sqrt(R)
  z <- bias / mcse
  ok <- all(abs(z[c("rr", "rw", "wr")]) < 3.5) && abs(z[["ww"]]) > 5 && abs(bias[["ww"]]) > 0.04
  list(pass = ok,
       detail = sprintf("true restricted-mean ATT %.5f; bias (Monte-Carlo error, in errors) both right %.4f (%.4f, %.1f), outcome wrong %.4f (%.4f, %.1f), score wrong %.4f (%.4f, %.1f), both wrong %.4f (%.4f, %.1f); %d trials of 1000",
                        truth, bias[["rr"]], mcse[["rr"]], z[["rr"]], bias[["rw"]], mcse[["rw"]], z[["rw"]], bias[["wr"]], mcse[["wr"]], z[["wr"]], bias[["ww"]], mcse[["ww"]], z[["ww"]], R))
})
