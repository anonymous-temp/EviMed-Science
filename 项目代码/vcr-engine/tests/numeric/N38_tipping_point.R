# N38 — tipping-point analysis for missing outcomes.
#
# References that are not this method's own code: the exact fractions of a table
# small enough to count by hand; stats::fisher.test, stats::prop.test and
# stats::binom.test cell by cell over whole grids; survival::coxph with Breslow ties
# (the engine's own Cox kernel is held to it) and, for the worst case, coxph on the
# data a person would have if the censored had failed; and a replication over seeds
# that says whether the reported Monte-Carlo error is the real one.

.n38_job <- function(sc, inputs = NULL, replicates = NULL, seed = 1L, id = "job_n38", ...) {
  vcr_test_run(vcr_test_job("comparator.tipping_point", sc, inputs, seed = seed, replicates = replicates, job_id = id), ...)
}
.n38_binary <- function(trt, ctl = NULL, method = "fisher_exact", alpha = 0.05, sided = 1L, handling = "non_responders", extra = list()) {
  sc <- list(endpoint = list(type = "binary"), design = list(kind = if (is.null(ctl)) "single_arm" else "two_arm"),
             counts = list(treatment = list(n = trt[1], responders = trt[2], missing = trt[3])),
             analysis = list(method = method, alpha = alpha, sided = sided), missingHandling = handling)
  if (!is.null(ctl)) sc$counts$control <- list(n = ctl[1], responders = ctl[2], missing = ctl[3])
  utils::modifyList(sc, extra)
}

vcr_case("N38a", c("AC-07", "AC-30"), function() {
  # (1) A table small enough to count by hand. Treatment: 6 people, 5 responders, 1 missing; control: 6, 1, 1.
  # Fisher's one-sided exact p at the four ways the two missing could have gone are hypergeometric tails with
  # margins N = 12, n1 = 6:   (k1,k0) = (0,0): R = 6, P(X >= 5) = (6*6 + 1)/924 = 37/924;   (1,0): R = 7,
  # P(X >= 6) = 7/924;   (0,1): R = 7, P(X >= 5) = (21*5 + 7)/924 = 112/924;   (1,1): R = 8, P(X >= 6) = 28/924.
  # At alpha 0.05 only (0,1) is not significant: the primary (every missing outcome a failure, the corner (0,0)) is
  # significant, the tipping point is one patient away (control missing responded), the share changing is 1/4.
  dir <- tempfile("n38a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- .n38_job(.n38_binary(c(6, 5, 1), c(6, 1, 1)), output_dir = dir)
  g <- vcr_test_table(r, "tipping-grid", dir)
  p_of <- function(a, b) g$p[g$k1 == a & g$k0 == b]
  want <- c(`0,0` = 37, `1,0` = 7, `0,1` = 112, `1,1` = 28) / 924
  got <- c(`0,0` = p_of(0, 0), `1,0` = p_of(1, 0), `0,1` = p_of(0, 1), `1,1` = p_of(1, 1))
  hand_ok <- max(abs(got - want)) < 1e-12 && isTRUE(r$diagnostics$primary$significant) &&
    identical(as.integer(vcr_measure_value(r, "tipping_distance")), 1L) && vcr_measure_value(r, "tipping_treatment_responders") == 0 &&
    vcr_measure_value(r, "tipping_control_responders") == 1 && abs(vcr_measure_value(r, "share_changing_conclusion") - 0.25) < 1e-12 &&
    vcr_measure_value(r, "grid_cells") == 4 && abs(vcr_measure_value(r, "primary_p_value") - 37 / 924) < 1e-12 &&
    abs(vcr_measure_value(r, "worst_case_p_value") - 112 / 924) < 1e-12 && isTRUE(r$diagnostics$worstCase$changesConclusion)
  # complete cases on the same counts: 5 of 5 against 1 of 5, p = 6/252, and the reference cell is where the missing respond at
  # their own arm's observed rate, rounded: (1, 0)
  rc <- .n38_job(.n38_binary(c(6, 5, 1), c(6, 1, 1), handling = "complete_cases"))
  cc_ok <- abs(vcr_measure_value(rc, "primary_p_value") - 6 / 252) < 1e-12 && identical(as.integer(rc$diagnostics$reference$k1), 1L) &&
    identical(as.integer(rc$diagnostics$reference$k0), 0L) && isTRUE(rc$diagnostics$reference$matchesPrimary)

  # (2) a whole grid against R's own tests, cell by cell: Fisher one- and two-sided, the pooled risk-difference test against
  # prop.test (the same statistic), the exact binomial one- and two-sided against binom.test
  trt <- c(48, 29, 7); ctl <- c(52, 21, 9)
  maxdiff <- list()
  for (cfg in list(list("fisher_exact", 1L), list("fisher_exact", 2L), list("risk_difference", 1L), list("risk_difference", 2L))) {
    rr <- .n38_job(.n38_binary(trt, ctl, method = cfg[[1]], alpha = 0.025, sided = cfg[[2]]), output_dir = dir)
    gg <- vcr_test_table(rr, "tipping-grid", dir)
    ref <- vapply(seq_len(nrow(gg)), function(i) {
      r1 <- trt[2] + gg$k1[i]; r0 <- ctl[2] + gg$k0[i]
      if (identical(cfg[[1]], "fisher_exact")) stats::fisher.test(matrix(c(r1, r0, trt[1] - r1, ctl[1] - r0), 2), alternative = if (cfg[[2]] == 1L) "greater" else "two.sided")$p.value
      else suppressWarnings(stats::prop.test(c(r1, r0), c(trt[1], ctl[1]), alternative = if (cfg[[2]] == 1L) "greater" else "two.sided", correct = FALSE)$p.value)
    }, numeric(1))
    maxdiff[[paste(cfg[[1]], cfg[[2]])]] <- max(abs(gg$p - ref))
  }
  rs <- .n38_job(.n38_binary(c(40, 17, 6), NULL, method = "exact_binomial", alpha = 0.05, sided = 1L, extra = list(analysis = list(method = "exact_binomial", alpha = 0.05, sided = 1L, nullRate = 0.3))), output_dir = dir)
  gs <- vcr_test_table(rs, "tipping-grid", dir)
  ref_s <- vapply(gs$k1, function(k) stats::binom.test(17 + k, 40, 0.3, alternative = "greater")$p.value, numeric(1))
  rs2 <- .n38_job(.n38_binary(c(40, 17, 6), NULL, method = "exact_binomial", alpha = 0.05, sided = 2L, extra = list(analysis = list(method = "exact_binomial", alpha = 0.05, sided = 2L, nullRate = 0.3))), output_dir = dir)
  gs2 <- vcr_test_table(rs2, "tipping-grid", dir)
  ref_s2 <- vapply(gs2$k1, function(k) stats::binom.test(17 + k, 40, 0.3, alternative = "two.sided")$p.value, numeric(1))
  maxdiff[["binom 1"]] <- max(abs(gs$p - ref_s)); maxdiff[["binom 2"]] <- max(abs(gs2$p - ref_s2))
  grid_ok <- all(unlist(maxdiff) < 1e-12)

  # (3) the nearest tipping point, found again by brute force from the exact grid: the primary is "significant" or not, the
  # threatening quadrant is searched by L1 distance from the reference cell, ties to the fewest treatment-arm changes
  trt <- c(48, 31, 7); ctl <- c(52, 19, 9)                    # NRI p = 0.0045: significant at 0.025
  rr <- .n38_job(.n38_binary(trt, ctl, alpha = 0.025), output_dir = dir)
  gg <- vcr_test_table(rr, "tipping-grid", dir)
  prim_sig <- stats::fisher.test(matrix(c(trt[2], ctl[2], trt[1] - trt[2], ctl[1] - ctl[2]), 2), alternative = "greater")$p.value <= 0.025
  gg$sig <- gg$p <= 0.025
  against <- gg[gg$sig != prim_sig & gg$k1 <= 0 & gg$k0 >= 0, ]
  against$d <- against$k1 + against$k0
  best <- against[order(against$d, against$k1, against$k0), ][1, ]
  brute_ok <- if (nrow(against)) identical(as.integer(vcr_measure_value(rr, "tipping_distance")), as.integer(best$d)) &&
    vcr_measure_value(rr, "tipping_control_responders") == best$k0 else is.null(vcr_get_measure(rr, "tipping_distance"))
  # in the other direction: a primary that is not significant, searched in favour of the treatment
  rn <- .n38_job(.n38_binary(c(48, 29, 7), c(52, 21, 9), alpha = 0.025), output_dir = dir)   # NRI p = 0.0356: not significant at 0.025
  gn <- vcr_test_table(rn, "tipping-grid", dir); gn$sig <- gn$p <= 0.025
  favour <- gn[gn$sig & gn$k1 >= 0 & gn$k0 <= 0, ]; favour$d <- favour$k1 + favour$k0
  bestf <- favour[order(favour$d, favour$k1, favour$k0), ][1, ]
  dir_ok <- identical(rn$diagnostics$direction, "in_favour") && !isTRUE(rn$diagnostics$primary$significant) &&
    identical(as.integer(vcr_measure_value(rn, "tipping_distance")), as.integer(bestf$d)) && vcr_measure_value(rn, "tipping_treatment_responders") == bestf$k1

  # (4) the same counts from a table (0/1 with an empty cell for a missing outcome) give the same result
  set.seed(38L, kind = VCR_RNG_KIND)
  y <- c(rep(1L, 29), rep(0L, 12), rep(NA, 7), rep(1L, 21), rep(0L, 22), rep(NA, 9))
  d <- data.frame(USUBJID = sprintf("B%03d", seq_along(y)), arm = rep(1:0, times = c(48, 52)), y = y)
  inp <- vcr_test_input(d, "snp_n38a:subject", "subject")
  rt <- .n38_job(list(endpoint = list(type = "binary"), design = list(kind = "two_arm"), outcomeColumn = "y", treatmentColumn = "arm",
                      analysis = list(method = "fisher_exact", alpha = 0.025, sided = 1L)), list(inp))
  tab_ok <- identical(rt$status, "succeeded") && identical(rt$counts$realPatients, 100L) &&
    abs(vcr_measure_value(rt, "primary_p_value") - vcr_measure_value(rn, "primary_p_value")) < 1e-15 &&
    vcr_measure_value(rt, "cells_changing_conclusion") == vcr_measure_value(rn, "cells_changing_conclusion")
  list(pass = hand_ok && cc_ok && grid_ok && brute_ok && dir_ok && tab_ok,
       detail = sprintf("hand table p = 37/924, 7/924, 112/924, 28/924 (max |d| %.1e), tipping distance %g at (%g, %g), share %.2f; complete cases p %.5f = 6/252; grids vs fisher.test / prop.test / binom.test max |d| %.1e; brute-force nearest tipping point agrees (against: %s, in favour: %s); table input = counts input %s",
                        max(abs(got - want)), vcr_measure_value(r, "tipping_distance"), vcr_measure_value(r, "tipping_treatment_responders"), vcr_measure_value(r, "tipping_control_responders"),
                        vcr_measure_value(r, "share_changing_conclusion"), vcr_measure_value(rc, "primary_p_value"), max(unlist(maxdiff)), brute_ok, dir_ok, tab_ok))
})

vcr_case("N38b", c("AC-07", "AC-30"), function() {
  # The engine's Cox kernel (one binary covariate, Breslow ties, vectorised over risk-set counts) against survival::coxph with
  # ties = "breslow": the coefficient and its variance to 1e-8, on data with heavy ties (times rounded) and on data without.
  suppressMessages(library(survival))
  worst <- c(beta = 0, variance = 0)
  for (seed in 1:5) {
    set.seed(380L + seed, kind = VCR_RNG_KIND)
    n <- 150L + 40L * seed
    arm <- stats::rbinom(n, 1L, 0.5)
    t <- stats::rexp(n, 0.1 * exp(-0.5 * arm)); cens <- stats::runif(n, 0, 25)
    time <- pmin(t, cens); status <- as.integer(t <= cens)
    if (seed %% 2L == 0L) time <- round(time, 1)
    f <- coxph(Surv(time, status) ~ arm, ties = "breslow")
    k <- vcr_cox_binary(time, status, arm)
    worst <- pmax(worst, c(abs(k$beta - unname(coef(f))), abs(k$variance - unname(vcov(f)))))
  }
  # an arm with no event has no hazard ratio, and the kernel says so instead of returning a number
  none <- is.null(vcr_cox_binary(c(1, 2, 3, 4), c(1L, 1L, 0L, 0L), c(0L, 0L, 1L, 1L)))
  # the baseline an imputation draws from: piecewise-linear, continuous, and its inverse is the inverse
  set.seed(381L, kind = VCR_RNG_KIND)
  tt <- stats::rexp(300, 0.1); ss <- stats::rbinom(300, 1L, 0.8); aa <- stats::rbinom(300, 1L, 0.5)
  bl <- .vcr_baseline(tt, ss, aa, vcr_cox_binary(tt, ss, aa)$beta)
  x <- stats::runif(200, 0, bl$H_last * 1.5)
  roundtrip <- max(abs(.vcr_baseline_H(bl, .vcr_baseline_inverse(bl, x)) - x))
  # ... and it is Breslow's estimate at the event times
  f <- coxph(Surv(tt, ss) ~ aa, ties = "breslow"); bh <- survival::basehaz(f, centered = FALSE)
  ev_t <- sort(unique(tt[ss == 1L]))       # basehaz is a step function over every time; the knots are the event times
  at_events <- max(abs(.vcr_baseline_H(bl, ev_t) - bh$hazard[match(ev_t, bh$time)]))
  list(pass = worst[["beta"]] < 1e-8 && worst[["variance"]] < 1e-8 && none && roundtrip < 1e-9 && at_events < 1e-8,
       detail = sprintf("Cox kernel vs coxph(breslow) on 5 data sets (3 untied, 2 tied): max |d beta| %.1e, max |d variance| %.1e; an arm without events -> NULL %s; baseline H(H^-1(x)) round trip %.1e, equals basehaz at the event times to %.1e",
                        worst[["beta"]], worst[["variance"]], none, roundtrip, at_events))
})

# the time-to-event data the next cases share: exponential, a hazard ratio of 0.7, dropout, administrative censoring at 24
.n38_tte <- function(seed, n, hr = 0.7, drop = 0.03, early_in = c(0L, 1L)) {
  set.seed(seed, kind = VCR_RNG_KIND)
  arm <- rep(0:1, each = n / 2)
  t_event <- stats::rexp(n, 0.06 * ifelse(arm == 1, hr, 1)); t_drop <- stats::rexp(n, drop)
  t_drop[!(arm %in% early_in)] <- Inf                               # an arm with no dropout has no early censoring
  time <- pmin(t_event, t_drop, 24); status <- as.integer(t_event <= pmin(t_drop, 24))
  data.frame(USUBJID = sprintf("T%05d", seq_len(n)), arm = arm, time = time, status = status)
}
.n38_inputs <- function(d, tag) list(vcr_test_input(d[, c("USUBJID", "arm")], paste0("snp_n38_", tag, ":subject"), "subject"),
                                     vcr_test_input(data.frame(USUBJID = d$USUBJID, PARAMCD = "OS", AVAL = d$time, CNSR = 1L - d$status), paste0("snp_n38_", tag, ":event"), "event"))
.n38_tte_sc <- function(...) utils::modifyList(list(endpoint = list(type = "time_to_event"), horizon = 24, treatmentColumn = "arm"), list(...))

vcr_case("N38c", c("AC-07", "AC-28", "AC-30"), function() {
  # The two reference checks the method has (no published numeric time-to-event case exists):
  # (1) delta -> 1 reproduces the primary. With nobody to impute (the arm the delta applies to has no early censoring) every
  # delta gives the primary exactly; with people to impute, delta = 1 matches the primary within the imputations' Monte-Carlo
  # error plus the finite-sample difference between imputing and not (measured up to 7% of the primary's standard error over 20
  # data sets, 10% allowed).
  suppressMessages(library(survival))
  d0 <- .n38_tte(381L, 600L, early_in = 0L)               # only the control arm has dropout; the delta applies to the treatment arm
  r0 <- .n38_job(.n38_tte_sc(deltas = list(1, 2, 8), direction = "against_treatment"), .n38_inputs(d0, "c0"), replicates = 60L)
  tab0 <- do.call(rbind, lapply(r0$diagnostics$deltaTable, as.data.frame))
  prim0 <- r0$diagnostics$primary
  f0 <- coxph(Surv(time, status) ~ arm, data = d0, ties = "breslow")
  nothing_ok <- identical(r0$diagnostics$earlyCensored$treatment, 0L) && max(abs(tab0$logHazardRatio - prim0$logHazardRatio)) < 1e-12 &&
    abs(prim0$logHazardRatio - unname(coef(f0))) < 1e-8 && is.null(r0$diagnostics$tippingDelta) && identical(r0$conclusion, "limited") &&
    is.null(vcr_get_measure(r0, "tipping_delta"))
  d1 <- .n38_tte(382L, 2000L)
  r1 <- .n38_job(.n38_tte_sc(deltas = list(1, 2), direction = "against_treatment"), .n38_inputs(d1, "c1"), replicates = 400L, seed = 5L)
  p1 <- r1$diagnostics$primary; m1 <- vcr_get_measure(r1, "delta_one_log_hazard_ratio")
  f1 <- coxph(Surv(time, status) ~ arm, data = d1, ties = "breslow")
  one_ok <- abs(p1$logHazardRatio - unname(coef(f1))) < 1e-8 && abs(p1$se - sqrt(vcov(f1)[1, 1])) < 1e-8 &&
    abs(m1$value - p1$logHazardRatio) <= 3 * m1$mcse + 0.10 * p1$se && m1$mcse > 0 && m1$simulated
  # (2) a large delta reaches the worst-case limit: the analysis in which everyone censored early in the arm whose hazard goes to
  # infinity fails at the time of censoring (and, applied in opposite directions, the other arm's never fail), computed here by
  # coxph on the data changed that way. Treatment only, in favour (treatment's early-censored never fail), and opposite directions.
  early <- d1$status == 0 & d1$time < 24
  lim <- function(fail_arm = NULL, stay_arm = NULL) {
    x <- d1
    if (!is.null(fail_arm)) x$status[early & x$arm == fail_arm] <- 1L
    if (!is.null(stay_arm)) x$time[early & x$arm == stay_arm] <- 24
    unname(coef(coxph(Surv(time, status) ~ arm, data = x, ties = "breslow")))
  }
  run_lim <- function(direction, applies) {
    rr <- .n38_job(.n38_tte_sc(deltas = list(1, 1e9), direction = direction, deltaApplies = applies), .n38_inputs(d1, "c1"), replicates = 60L, seed = 6L)
    tb <- do.call(rbind, lapply(rr$diagnostics$deltaTable, as.data.frame))
    c(mi = tb$logHazardRatio[2], worst = rr$diagnostics$worstCase$beta, mcse = tb$mcse[2])
  }
  a <- run_lim("against_treatment", "treatment"); b <- run_lim("in_favour", "treatment"); c <- run_lim("against_treatment", "both_opposite")
  limit_ok <- abs(a[["mi"]] - lim(fail_arm = 1L)) < 1e-6 && abs(a[["worst"]] - lim(fail_arm = 1L)) < 1e-8 &&
    abs(b[["mi"]] - lim(stay_arm = 1L)) < 1e-6 && abs(b[["worst"]] - lim(stay_arm = 1L)) < 1e-8 &&
    abs(c[["mi"]] - lim(fail_arm = 1L, stay_arm = 0L)) < 1e-6 && abs(c[["worst"]] - lim(fail_arm = 1L, stay_arm = 0L)) < 1e-8 &&
    max(a[["mcse"]], b[["mcse"]], c[["mcse"]]) < 1e-6
  list(pass = nothing_ok && one_ok && limit_ok,
       detail = sprintf("nobody to impute: every delta = primary (max |d| %.1e), coxph %.6f vs %.6f, no tipping delta, limited; delta = 1 with %d imputed: %.5f vs primary %.5f (mcse %.5f, %.2f mcse, %.1f%% of se); delta -> infinity vs coxph on the changed data: treatment only %.6f/%.6f, in favour %.6f/%.6f, opposite directions %.6f/%.6f",
                        max(abs(tab0$logHazardRatio - prim0$logHazardRatio)), prim0$logHazardRatio, unname(coef(f0)), r1$diagnostics$earlyCensored$treatment,
                        m1$value, p1$logHazardRatio, m1$mcse, abs(m1$value - p1$logHazardRatio) / m1$mcse, 100 * abs(m1$value - p1$logHazardRatio) / p1$se,
                        a[["mi"]], lim(fail_arm = 1L), b[["mi"]], lim(stay_arm = 1L), c[["mi"]], lim(fail_arm = 1L, stay_arm = 0L)))
})

vcr_case("N38d", c("AC-07", "AC-28", "AC-30"), function() {
  # The tipping delta and its Monte-Carlo error. (1) The reported tipping delta is where the table says: between the last grid delta
  # that keeps the conclusion and the first that changes it, and equal to the log-linear interpolation of the table's z to the
  # critical value (recomputed here). (2) The estimate rises with delta (the delta is adverse for the treatment) and the worst case is
  # past the whole grid's last value. (3) The reported Monte-Carlo standard error is the real one: the same data set analysed with 8
  # different seeds gives tipping deltas whose standard deviation is the reported error (to a factor of 2: eight runs estimate a
  # standard deviation to about 25%). (4) The same seed gives the same result, another seed another set of imputations.
  d <- .n38_tte(383L, 400L, hr = 0.55, drop = 0.05)
  inp <- .n38_inputs(d, "d")
  sc <- .n38_tte_sc(direction = "against_treatment")
  runs <- lapply(1:8, function(s) .n38_job(sc, inp, replicates = 200L, seed = 20L + s))
  tips <- vapply(runs, function(r) vcr_measure_value(r, "tipping_delta"), numeric(1))
  mcses <- vapply(runs, function(r) vcr_get_measure(r, "tipping_delta")$mcse, numeric(1))
  r <- runs[[1]]
  tb <- do.call(rbind, lapply(r$diagnostics$deltaTable, as.data.frame))
  prim_class <- "favours_treatment"
  first <- which(tb$conclusion != prim_class)[1]
  bracket_ok <- identical(r$diagnostics$primary$conclusion, prim_class) && is.finite(first) && first > 1 && tips[1] > tb$delta[first - 1] && tips[1] <= tb$delta[first]
  # recompute the interpolation from the table: z crosses -critical, the t quantile at Rubin's degrees of freedom (both in the table)
  expect_crit <- stats::qt(0.975, tb$df)
  za <- tb$z[first - 1] + tb$critical[first - 1]; zb <- tb$z[first] + tb$critical[first]
  interp <- exp(log(tb$delta[first - 1]) + (za / (za - zb)) * (log(tb$delta[first]) - log(tb$delta[first - 1])))
  interp_ok <- abs(interp / tips[1] - 1) < 1e-9 && max(abs(expect_crit - tb$critical), na.rm = TRUE) < 1e-9
  mono_ok <- all(diff(tb$logHazardRatio) > 0) && r$diagnostics$worstCase$beta > tb$logHazardRatio[nrow(tb)] && isTRUE(r$diagnostics$worstCase$changesConclusion)
  mcse_ok <- all(is.finite(tips)) && all(mcses > 0) && stats::sd(tips) / mean(mcses) > 0.5 && stats::sd(tips) / mean(mcses) < 2
  again <- .n38_job(sc, inp, replicates = 200L, seed = 21L)
  repro_ok <- identical(again$diagnostics$deltaTable, r$diagnostics$deltaTable) && identical(again$manifest$outputHash, r$manifest$outputHash) &&
    !identical(runs[[2]]$diagnostics$deltaTable, r$diagnostics$deltaTable)
  list(pass = bracket_ok && interp_ok && mono_ok && mcse_ok && repro_ok,
       detail = sprintf("tipping delta %.3f (mcse %.3f) between grid %.3g and %.3g, interpolation recomputed %.3f; log HR rises %.4f -> %.4f over the grid, worst case %.4f; over 8 seeds the tipping delta is %.3f with sd %.3f against reported mcse %.3f (ratio %.2f); same seed same table %s",
                        tips[1], mcses[1], tb$delta[first - 1], tb$delta[first], interp, tb$logHazardRatio[1], tb$logHazardRatio[nrow(tb)], r$diagnostics$worstCase$beta,
                        mean(tips), stats::sd(tips), mean(mcses), stats::sd(tips) / mean(mcses), repro_ok))
})

vcr_case("N38e", c("AC-07", "AC-09", "AC-28"), function() {
  # Named refusals, named not-estimable rules and a cancel, for both endpoints.
  d <- .n38_tte(384L, 300L, hr = 0.6, drop = 0.05)
  inp <- .n38_inputs(d, "e")
  sc <- .n38_tte_sc()
  codes <- function(r) vcr_test_issue_codes(r)
  # (1) too few imputations: a refusal that names `replicates`
  few <- .n38_job(sc, inp, replicates = 39L)
  ok_few <- identical(few$status, "failed") && "replicates_invalid" %in% codes(few) && length(few$measures) == 0L
  # (2) an arm with no event inside the horizon: no primary hazard ratio to relax
  d2 <- d; d2$status[d2$arm == 1L] <- 0L
  none <- .n38_job(sc, .n38_inputs(d2, "e2"), replicates = 40L)
  ok_none <- identical(none$status, "not_estimable") && identical(none$notEstimableRule, "primary_analysis_not_estimable") && length(none$measures) == 0L
  # (3) a missing table and a bad treatment column
  ok_in <- {
    r1 <- .n38_job(sc, NULL, replicates = 40L)
    bad <- d; bad$arm[1] <- 2L
    r2 <- .n38_job(sc, .n38_inputs(bad, "e3"), replicates = 40L)
    identical(r1$status, "failed") && "input_shape_invalid" %in% codes(r1) && identical(r2$status, "failed") && "input_shape_invalid" %in% codes(r2)
  }
  # (4) binary: more observed responders than observed people, more missing than people, and a grid beyond the engine's work limit
  b1 <- .n38_job(.n38_binary(c(10, 9, 3), c(10, 2, 1)))
  b2 <- .n38_job(.n38_binary(c(10, 2, 11), c(10, 2, 1)))
  b3 <- .n38_job(.n38_binary(c(900, 400, 300), c(900, 300, 300)))
  ok_bin <- all(vapply(list(b1, b2, b3), function(r) identical(r$status, "failed") && "scenario_value_invalid" %in% codes(r) && length(r$measures) == 0L, logical(1)))
  # (5) a cancel keeps nothing it did not finish and says canceled; cores do not change the numbers
  cf <- tempfile("cancel"); file.create(cf); on.exit(unlink(cf), add = TRUE)
  canceled <- .n38_job(sc, inp, replicates = 100L, cancel_file = cf)
  ok_cancel <- identical(canceled$status, "canceled") && length(canceled$measures) == 0L && !length(codes(canceled))
  one <- .n38_job(sc, inp, replicates = 60L, seed = 4L)
  two <- vcr_test_run(vcr_test_job("comparator.tipping_point", sc, inp, seed = 4L, replicates = 60L, cores = 2L, job_id = "job_n38"))
  ok_cores <- identical(one$diagnostics$deltaTable, two$diagnostics$deltaTable)
  list(pass = ok_few && ok_none && ok_in && ok_bin && ok_cancel && ok_cores,
       detail = sprintf("39 imputations -> %s/%s; an arm without events -> %s/%s with %d measures; no table / bad arm refused by name %s; binary: impossible counts and a grid over %d cells refused by name %s; cancel -> %s with %d measures; 1 and 2 cores give the same table %s",
                        few$status, paste(codes(few), collapse = ","), none$status, none$notEstimableRule %||% "NULL", length(none$measures), ok_in, VCR_TIPPING_MAX_CELLS, ok_bin,
                        canceled$status, length(canceled$measures), ok_cores))
})
