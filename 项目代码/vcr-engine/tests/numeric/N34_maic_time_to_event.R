# N34 — comparator.maic_time_to_event: a matching-adjusted indirect comparison of
# hazard ratios, unanchored and anchored.
#
# References that are not this method's own code:
#  - the printed results of the maicplus 0.1.2 vignettes ("MAIC for time-to-event
#    data", unanchored and anchored; Apache-2.0, https://hta-pharma.github.io/maicplus/),
#    computed from the simulated example data vendored under
#    tests/fixtures/maicplus-0.1.2 (see its NOTICE); the vignette tables print seven
#    digits, so the comparisons are made to 1e-6;
#  - a simulation whose target-population hazard ratio is found by an oracle: two
#    arms of a million patients each drawn from the target population itself.

.n34_fixture <- function(name) utils::read.csv(file.path(VCR_ROOT, "tests", "fixtures", "maicplus-0.1.2", name), stringsAsFactors = FALSE)
.n34_cov <- c("AGE_CENTERED", "AGE_SQUARED_CENTERED", "SEX_MALE_CENTERED", "ECOG0_CENTERED", "SMOKE_CENTERED", "N_PR_THER_MEDIAN_CENTERED")

# the study's patients as the engine's subject and events tables; the aggregate trial's
# covariates are already centred in the data, so every target is zero
.n34_job <- function(id, anchored = FALSE, scenario = list(), pseudo_source = "reconstructed", ipd_source = "observed", seed = 3L, cores = 1L, only = NULL) {
  ipd <- .n34_fixture("ipd_two_arm.csv"); ps <- .n34_fixture("pseudo_ipd_two_arm.csv")
  if (!anchored) { ipd <- ipd[ipd$ARM == "A", ]; ps <- ps[ps$ARM == "B", ] }
  subj <- ipd[, c("USUBJID", .n34_cov)]
  if (anchored) subj$arm <- as.integer(ipd$ARM == "A")
  ev <- data.frame(USUBJID = ipd$USUBJID, PARAMCD = "OS", AVAL = ipd$TIME, CNSR = 1L - ipd$EVENT, stringsAsFactors = FALSE)
  pseudo <- data.frame(time = ps$TIME, status = ps$EVENT)
  if (anchored) pseudo$arm <- as.integer(ps$ARM == "B")
  inputs <- list(vcr_test_input(subj, paste0("snp_", id, ":subject"), "subject", source = ipd_source),
                 vcr_test_input(ev, paste0("snp_", id, ":events"), "event", source = ipd_source),
                 vcr_test_input(pseudo, paste0("rec_", id, ":1"), source = pseudo_source))
  sc <- list(covariates = as.list(.n34_cov), targets = stats::setNames(as.list(rep(0, length(.n34_cov))), .n34_cov), timeUnit = "days")
  if (anchored) sc <- c(sc, list(anchored = TRUE, treatmentColumn = "arm"))
  sc <- utils::modifyList(sc, scenario)
  if (is.null(sc$aggregateEstimate)) sc$pseudoIpdInputId <- paste0("rec_", id, ":1") else inputs <- inputs[1:2]
  if (anchored && !is.null(sc$pseudoIpdInputId)) sc$pseudoTreatmentColumn <- "arm"
  vcr_test_job("comparator.maic_time_to_event", sc, inputs, seed = seed, job_id = paste0("job_", id), cores = cores)
}

vcr_case("N34a", c("AC-08", "AC-12", "AC-30"), function() {
  # The unanchored vignette: 500 patients of arm A matched to the aggregate trial's
  # six baseline characteristics and compared with the 300 reconstructed patients of arm B.
  # maicplus prints: adjusted HR 0.2834780 (0.2074664, 0.3873387), robust se(coef) 0.1593,
  # unadjusted HR 0.3748981 (0.3039010, 0.4624815), effective sample size 166.6626 (sum of
  # the weights 199.4265). Weights rescaled to n would give 0.2806 instead: the scale is part of the answer.
  r <- vcr_test_run(.n34_job("n34a"))
  m <- function(name) vcr_get_measure(r, name)
  iv <- function(name) c(m(name)$interval$low, m(name)$interval$high)
  w <- r$diagnostics$weights
  ok <- identical(r$status, "succeeded") && identical(r$conclusion, "limited") && "unanchored_comparison" %in% unlist(r$diagnostics$limitedBy) &&
    abs(m("hazard_ratio_robust")$value - 0.2834780) < 1e-6 && all(abs(iv("hazard_ratio_robust") - c(0.2074664, 0.3873387)) < 1e-6) &&
    abs(m("log_hazard_ratio_se_robust")$value - 0.1593) < 5e-5 &&
    abs(m("hazard_ratio_unadjusted")$value - 0.3748981) < 1e-6 && all(abs(iv("hazard_ratio_unadjusted") - c(0.3039010, 0.4624815)) < 1e-6) &&
    abs(m("effective_sample_size")$value - 166.6626) < 1e-4 && abs(w$sum - 199.4265) < 1e-4 && abs(w$effectiveSampleSize - 166.6626) < 1e-4 &&
    # the headline is the bootstrap, the same hazard ratio with its own interval and its own error
    identical(m("hazard_ratio")$value, m("hazard_ratio_robust")$value) && !identical(iv("hazard_ratio"), iv("hazard_ratio_robust")) &&
    isTRUE(m("log_hazard_ratio_se_bootstrap")$simulated) && is.finite(m("log_hazard_ratio_se_bootstrap")$mcse) &&
    # the four counts stay apart: 500 real patients, 300 reconstructed, an ESS that never exceeds the real ones
    r$counts$realPatients == 500L && r$counts$reconstructedPseudoPatients == 300L && r$counts$effectiveSampleSize <= r$counts$realPatients && r$counts$events == 190L &&
    identical(r$diagnostics$valueSourcesUsed$weakest, "reconstructed") && isTRUE(r$diagnostics$targetsTreatedAsFixed) &&
    length(vcr_validate_result(r)) == 0L && abs(m("hazard_ratio")$value - 0.2806144) > 1e-3
  list(pass = ok,
       detail = sprintf("adjusted HR %.7f (vignette 0.2834780), robust CI [%.7f, %.7f] (0.2074664, 0.3873387), robust se %.4f (0.1593); unadjusted HR %.7f (0.3748981) [%.7f, %.7f] (0.3039010, 0.4624815); ESS %.4f (166.6626), sum of weights %.4f (199.4265); bootstrap HR interval [%.4f, %.4f], bootstrap se %.4f (mcse %.4f); counts real %d / reconstructed %d / ESS %.1f; conclusion %s",
                        m("hazard_ratio_robust")$value, iv("hazard_ratio_robust")[1], iv("hazard_ratio_robust")[2], m("log_hazard_ratio_se_robust")$value,
                        m("hazard_ratio_unadjusted")$value, iv("hazard_ratio_unadjusted")[1], iv("hazard_ratio_unadjusted")[2], m("effective_sample_size")$value, w$sum,
                        iv("hazard_ratio")[1], iv("hazard_ratio")[2], m("log_hazard_ratio_se_bootstrap")$value, m("log_hazard_ratio_se_bootstrap")$mcse,
                        r$counts$realPatients, r$counts$reconstructedPseudoPatients, r$counts$effectiveSampleSize, r$conclusion))
})

vcr_case("N34b", c("AC-08", "AC-12", "AC-30"), function() {
  # The anchored vignette: arms A and C in the study (weights matched on all 1,000), arms B and C
  # in the aggregate trial. maicplus prints AC 0.2216588 (0.1867151, 0.2631423), adjusted AC
  # 0.1527378 (0.1117698, 0.2087222), BC 0.5718004 (0.4811989, 0.6794607), AB 0.3876507
  # (0.3039348, 0.4944253) and adjusted AB 0.2671173 (0.1869658, 0.3816295). The same adjusted AB
  # comes from the published contrast alone (its log hazard ratio and the standard error read
  # off its printed interval) with no reconstructed rows at all.
  r <- vcr_test_run(.n34_job("n34b", anchored = TRUE))
  m <- function(res, name) vcr_get_measure(res, name)
  iv <- function(res, name) c(m(res, name)$interval$low, m(res, name)$interval$high)
  close <- function(got, want, tol = 1e-6) all(abs(got - want) < tol)
  bc_est <- log(0.5718004); bc_se <- (log(0.6794607) - log(0.4811989)) / (2 * stats::qnorm(0.975))
  pub <- vcr_test_run(.n34_job("n34b_pub", anchored = TRUE, scenario = list(aggregateEstimate = bc_est, aggregateSe = bc_se)))
  ok <- identical(r$status, "succeeded") && identical(r$conclusion, "estimable") && identical(r$diagnostics$route, "anchored_pseudo") &&
    close(m(r, "hazard_ratio_ac_unadjusted")$value, 0.2216588) && close(iv(r, "hazard_ratio_ac_unadjusted"), c(0.1867151, 0.2631423)) &&
    close(m(r, "hazard_ratio_ac_adjusted")$value, 0.1527378) && close(iv(r, "hazard_ratio_ac_adjusted"), c(0.1117698, 0.2087222)) &&
    close(m(r, "hazard_ratio_bc")$value, 0.5718004) && close(iv(r, "hazard_ratio_bc"), c(0.4811989, 0.6794607)) &&
    close(m(r, "hazard_ratio_unadjusted")$value, 0.3876507) && close(iv(r, "hazard_ratio_unadjusted"), c(0.3039348, 0.4944253)) &&
    close(m(r, "hazard_ratio_robust")$value, 0.2671173) && close(iv(r, "hazard_ratio_robust"), c(0.1869658, 0.3816295)) &&
    abs(m(r, "effective_sample_size")$value - 333.3253) < 1e-4 && r$counts$realPatients == 1000L && r$counts$reconstructedPseudoPatients == 800L &&
    identical(pub$status, "succeeded") && identical(pub$diagnostics$route, "anchored_published") && is.null(pub$counts$reconstructedPseudoPatients) &&
    close(m(pub, "hazard_ratio_robust")$value, 0.2671173, 1e-5) && close(iv(pub, "hazard_ratio_robust"), c(0.1869658, 0.3816295), 1e-5) &&
    close(m(pub, "hazard_ratio_unadjusted")$value, 0.3876507, 1e-5) && length(vcr_validate_result(r)) == 0L && length(vcr_validate_result(pub)) == 0L &&
    isTRUE(m(r, "log_hazard_ratio_se_bootstrap")$simulated) && isTRUE(m(pub, "log_hazard_ratio_se_bootstrap")$simulated)
  list(pass = ok,
       detail = sprintf("AC %.7f (0.2216588), adjusted AC %.7f [%.7f, %.7f] (0.1527378 [0.1117698, 0.2087222]), BC %.7f (0.5718004), AB %.7f [%.7f, %.7f] (0.3876507 [0.3039348, 0.4944253]), adjusted AB %.7f [%.7f, %.7f] (0.2671173 [0.1869658, 0.3816295]); ESS %.4f (333.3253); from the published BC alone: adjusted AB %.7f [%.7f, %.7f] with %s reconstructed rows; bootstrap se %.4f / %.4f",
                        m(r, "hazard_ratio_ac_unadjusted")$value, m(r, "hazard_ratio_ac_adjusted")$value, iv(r, "hazard_ratio_ac_adjusted")[1], iv(r, "hazard_ratio_ac_adjusted")[2],
                        m(r, "hazard_ratio_bc")$value, m(r, "hazard_ratio_unadjusted")$value, iv(r, "hazard_ratio_unadjusted")[1], iv(r, "hazard_ratio_unadjusted")[2],
                        m(r, "hazard_ratio_robust")$value, iv(r, "hazard_ratio_robust")[1], iv(r, "hazard_ratio_robust")[2], m(r, "effective_sample_size")$value,
                        m(pub, "hazard_ratio_robust")$value, iv(pub, "hazard_ratio_robust")[1], iv(pub, "hazard_ratio_robust")[2], if (is.null(pub$counts$reconstructedPseudoPatients)) "no" else "some",
                        m(r, "log_hazard_ratio_se_bootstrap")$value, m(pub, "log_hazard_ratio_se_bootstrap")$value))
})

vcr_case("N34c", c("AC-08", "AC-11", "AC-30"), function() {
  # A simulation with a known target. The study's patients (arm A, x ~ N(0.7, 1)) are matched on the mean of
  # a prognostic covariate to the comparator trial's population (x ~ N(0, 1)) and compared with that trial's
  # arm B; hazard 0.1 exp(0.5 x) times 0.6 for arm A, exponential, uniform censoring on [2, 24]. The target is the
  # hazard ratio of the comparator population itself, which a hazard ratio's non-collapsibility makes differ
  # from 0.6: an oracle draws a million patients per arm from that population. The adjusted estimate recovers
  # it; the unadjusted one, which compares two different populations, does not.
  theta <- 0.6; lam <- 0.1; bx <- 0.5
  gen <- function(n, mu, hr) { x <- stats::rnorm(n, mu); t <- stats::rexp(n, lam * exp(bx * x) * hr); cn <- stats::runif(n, 2, 24); list(x = x, time = pmin(t, cn), status = as.integer(t <= cn)) }
  set.seed(1L, kind = VCR_RNG_KIND)
  N <- 1e6L; a <- gen(N, 0, theta); b <- gen(N, 0, 1)
  oracle <- vcr_cox_beta(c(a$time, b$time), c(a$status, b$status), c(rep(1L, N), rep(0L, N)), NULL, "efron")
  one <- function(i) {
    n1 <- 400L; n2 <- 400L
    s <- gen(n1, 0.7, theta); p <- gen(n2, 0, 1)
    X <- cbind(x = s$x); tg <- c(x = 0)
    f <- vcr_maic_weights(X, tg); wu <- exp(drop(sweep(X, 2, tg, "-") %*% f$lambda))
    arm <- c(rep(1L, n1), rep(0L, n2)); tm <- c(s$time, p$time); st <- c(s$status, p$status)
    adj <- vcr_cox_primary(tm, st, arm, c(wu, rep(1, n2)), with_ph = FALSE)
    una <- vcr_cox_primary(tm, st, arm, rep(1, n1 + n2), with_ph = FALSE)
    c(beta = adj$beta, se = adj$seRobust, ub = una$beta, use = una$seModel, ess = f$effectiveSampleSize)
  }
  K <- 300L
  est <- do.call(rbind, vcr_map_streams(vcr_stream_bank(34L)$take(K), one, cores = VCR_TEST_CORES))
  bias <- mean(est[, "beta"]) - oracle; mcse <- stats::sd(est[, "beta"]) / sqrt(K)
  cover <- mean(abs(est[, "beta"] - oracle) < stats::qnorm(0.975) * est[, "se"]); mcse_cov <- sqrt(cover * (1 - cover) / K)
  ubias <- mean(est[, "ub"]) - oracle; umcse <- stats::sd(est[, "ub"]) / sqrt(K)
  ucover <- mean(abs(est[, "ub"] - oracle) < stats::qnorm(0.975) * est[, "use"])
  ok <- abs(bias) <= 3 * mcse + 0.01 && cover >= 0.9 && cover <= 0.995 && abs(ubias) > 10 * umcse && ucover < 0.2
  list(pass = ok,
       detail = sprintf("oracle log HR of the comparator population %.4f (HR %.4f; the conditional ratio is 0.6, log %.4f); adjusted: mean log HR %+.4f off (%.2f MCSE, mcse %.4f), the robust 95%% interval covers it in %.3f (+-%.3f; the sandwich ignores the weights' estimation), mean ESS %.0f of 400; unadjusted: %+.4f off (%.0f MCSE), covers in %.3f",
                        oracle, exp(oracle), log(theta), bias, abs(bias) / mcse, mcse, cover, mcse_cov, mean(est[, "ess"]), ubias, abs(ubias) / umcse, ucover))
})

vcr_case("N34d", c("AC-07", "AC-08", "AC-09", "AC-27"), function() {
  # What the job refuses or qualifies, each by its own name: a comparator table that is not a
  # reconstruction, a study table that is, a target outside the study's range, a target the weights can only
  # reach by throwing nearly everyone away, a comparator without an event, and the old MAIC job pointing at
  # this one for a time-to-event endpoint. Nothing is refused by a number that was written and then withheld.
  codes <- function(r) paste(vcr_test_issue_codes(r), collapse = ",")
  not_rec <- vcr_test_run(.n34_job("n34d_a", pseudo_source = "observed"))
  rec_ipd <- vcr_test_run(.n34_job("n34d_b", ipd_source = "reconstructed"))
  far <- vcr_test_run(.n34_job("n34d_c", scenario = list(targets = stats::setNames(as.list(c(100, rep(0, 5))), .n34_cov))))
  # a target at the edge of the study's range is feasible, and the weights keep a handful of people: below the floor
  edge <- vcr_test_run(.n34_job("n34d_d", scenario = list(covariates = list("AGE_CENTERED"), targets = list(AGE_CENTERED = 23.5)), seed = 4L))
  quiet <- .n34_job("n34d_e")
  quiet$inputs[[3]] <- vcr_test_input(data.frame(time = c(1, 2, 3, 4, 5), status = 0L), "rec_n34d_e:1", source = "reconstructed")
  no_event <- vcr_test_run(quiet)
  old <- vcr_test_run(vcr_test_job("comparator.maic", list(covariates = list("x"), targets = list(x = 0), endpoint = list(type = "time_to_event"), aggregateOutcome = 1, aggregateSe = 0.1),
                                   list(vcr_test_input(data.frame(USUBJID = "a", x = 1), "snp_n34d_o:subject", "subject")), job_id = "job_n34d_o"))
  miss <- .n34_job("n34d_f"); miss$inputs[[3]] <- vcr_test_input(data.frame(t = c(1, 2, 3), s = 1L), "rec_n34d_f:1", source = "reconstructed")
  no_cols <- vcr_test_run(miss)
  all_r <- list(not_rec, rec_ipd, far, edge, no_event, old, no_cols)
  ok <- identical(not_rec$status, "failed") && "input_source_not_reconstructed" %in% vcr_test_issue_codes(not_rec) &&
    identical(rec_ipd$status, "failed") && "input_source_not_individual" %in% vcr_test_issue_codes(rec_ipd) &&
    identical(far$status, "not_estimable") && identical(far$notEstimableRule, "entropy_balance_infeasible") && length(far$measures) == 0L &&
    identical(edge$status, "not_estimable") && identical(edge$notEstimableRule, "effective_sample_size_below_floor") && length(edge$measures) == 0L &&
    identical(no_event$status, "not_estimable") && identical(no_event$notEstimableRule, "too_few_events") && length(no_event$measures) == 0L &&
    identical(no_event$counts$reconstructedPseudoPatients, 5L) &&
    identical(old$status, "failed") && "endpoint_not_supported" %in% vcr_test_issue_codes(old) && grepl("comparator.maic_time_to_event", old$diagnostics$issues[[1]]$detail, fixed = TRUE) &&
    identical(no_cols$status, "failed") && "input_shape_invalid" %in% vcr_test_issue_codes(no_cols) &&
    all(vapply(all_r, function(r) length(vcr_validate_result(r)) == 0L, logical(1)))
  list(pass = ok,
       detail = sprintf("comparator rows labelled observed -> %s; study rows labelled reconstructed -> %s; a target of 100 for age -> %s; a target at the edge of the range (ESS %.1f) -> %s; a comparator with no event -> %s with its 5 reconstructed patients counted apart; comparator.maic for a time-to-event endpoint -> %s (names this method); a table without time/status -> %s",
                        codes(not_rec), codes(rec_ipd), far$notEstimableRule, edge$counts$effectiveSampleSize %||% NA_real_, edge$notEstimableRule, no_event$notEstimableRule, codes(old), codes(no_cols)))
})

vcr_case("N34e", c("AC-28", "AC-31"), function() {
  # Both variances reported with the ratio of their standard errors, every bootstrapped number with its own
  # Monte-Carlo error, and the same numbers on one core and two.
  r1 <- vcr_test_run(.n34_job("n34e_1", cores = 1L)); r2 <- vcr_test_run(.n34_job("n34e_2", cores = 2L))
  b <- r1$diagnostics$bootstrap; se <- vcr_get_measure(r1, "log_hazard_ratio_se_bootstrap"); vc <- r1$diagnostics$varianceComparison
  same <- identical(vcr_get_measure(r1, "hazard_ratio")$interval, vcr_get_measure(r2, "hazard_ratio")$interval) &&
    identical(se$value, vcr_get_measure(r2, "log_hazard_ratio_se_bootstrap")$value)
  ok <- identical(r1$status, "succeeded") && b$replicates == 2000L && b$requested == 2000L && b$failureShare == 0 &&
    se$mcse > 0 && se$mcse < 0.05 * se$value && is.finite(b$intervalMcse$low) && is.finite(b$intervalMcse$high) &&
    vc$ratioRobustToBootstrap > 0.5 && vc$ratioRobustToBootstrap < 2 && same
  list(pass = ok,
       detail = sprintf("%d bootstrap draws, failure share %.3f; bootstrap se %.4f (mcse %.4f, %.1f%% of it), interval endpoints' mcse %.4f/%.4f; robust se %.4f, ratio robust/bootstrap %.3f; one core and two give the same interval and standard error: %s",
                        b$replicates, b$failureShare, se$value, se$mcse, 100 * se$mcse / se$value, b$intervalMcse$low, b$intervalMcse$high, vc$robustSe, vc$ratioRobustToBootstrap, same))
})
