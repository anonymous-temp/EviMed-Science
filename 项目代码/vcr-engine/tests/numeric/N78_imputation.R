# N78 — multiple imputation of missing covariates for the weighting comparators (algorithm round C7, 2026-11-03).
#
# References that are not the method's own code: `mice` 3.19 (Rubin's rules and its degrees of freedom through `pool.scalar`, the Nelson-Aalen
# estimate through `nelsonaalen`, and the imputations themselves: the same incomplete table imputed by `mice` and by the engine, 100 times each, must
# agree on what the completed tables say within the Monte-Carlo error of the two sets), a simulation whose truth is known and whose missingness depends
# on the outcome (so that the complete-case answer is biased and the imputed one is not), and the pooled answer of a job recomputed by hand from the
# completed tables with the plain handler. `mice` is a cross-check in CI only: no file under R/ calls it.

vcr_case("N78a", c("AC-08", "AC-30"), function() {
  # Rubin's rules and the Nelson-Aalen estimate are mice's, to the digit
  suppressMessages(library(mice))
  Q <- c(0.51, 0.62, 0.44, 0.58, 0.49, 0.55, 0.60, 0.47); U <- c(0.011, 0.012, 0.010, 0.013, 0.012, 0.011, 0.012, 0.0125)
  gaps <- vapply(c(Inf, 25, 500), function(n) {
    ref <- mice::pool.scalar(Q, U, n = n, k = 1)
    me <- vcr_rubin_pool(Q, U, if (is.finite(n)) n - 1 else Inf)
    max(abs(c(me$estimate - ref$qbar, me$total - ref$t, me$df - ref$df, me$fractionMissingInformation - ref$fmi, me$relativeIncrease - ref$r)))
  }, numeric(1))
  set.seed(2L, kind = VCR_RNG_KIND)
  tm <- stats::rexp(60, 0.1); st <- stats::rbinom(60, 1, 0.7)
  na_gap <- max(abs(mice::nelsonaalen(data.frame(tm = tm, st = st), tm, st) - .vcr_nelson_aalen(tm, st)))
  one <- is.null(vcr_rubin_pool(1, 0.1))
  list(pass = all(gaps < 1e-10) && na_gap < 1e-12 && one,
       detail = sprintf("pooled estimate, total variance, relative increase, fraction of missing information and Barnard-Rubin df = mice::pool.scalar (largest gap %.1e over three complete-data df); Nelson-Aalen = mice::nelsonaalen (%.1e); one imputation pools to nothing",
                        max(gaps), na_gap))
})

vcr_case("N78b", c("AC-08", "AC-30"), function() {
  # The engine's chained equations against mice's on one incomplete table: a number (predictive mean matching), a 0/1 column (logistic draw) and a
  # three-level categorical column (multinomial draw), each missing at random given the outcome. 100 imputations each; the means, proportions and
  # regression coefficients of the completed tables agree within their Monte-Carlo error (3 combined standard errors), and the total variance of a
  # coefficient is within 20% (the two between-imputation variances are estimated from 100 draws each).
  suppressMessages(library(mice))
  set.seed(20261103L, kind = VCR_RNG_KIND)
  n <- 800L; M <- 100L
  z <- stats::rnorm(n); x1 <- 0.5 * z + stats::rnorm(n); x2 <- stats::rbinom(n, 1L, stats::plogis(0.4 * z)); arm <- stats::rbinom(n, 1L, 0.5)
  lp <- cbind(0, 0.3 * z + 0.3 * x1, -0.2 + 0.5 * z); pr <- exp(lp) / rowSums(exp(lp))
  c3 <- apply(pr, 1L, function(p) sample(0:2, 1L, prob = p))
  y <- 1 + 0.5 * arm + 0.8 * x1 + 0.6 * x2 + 0.3 * z + 0.2 * c3 + stats::rnorm(n)
  D <- data.frame(x1 = ifelse(stats::runif(n) < stats::plogis(-1 + 0.5 * scale(y) + 0.4 * z), NA, x1),
                  x2 = ifelse(stats::runif(n) < stats::plogis(-1.2 + 0.5 * z), NA, x2),
                  c3 = ifelse(stats::runif(n) < stats::plogis(-1.4 + 0.4 * scale(y)), NA, c3), z = z)
  kinds <- list(x1 = .vcr_impute_kind(D$x1), x2 = .vcr_impute_kind(D$x2), c3 = .vcr_impute_kind(D$c3, TRUE))
  summ <- function(d) {
    f <- stats::lm(y ~ arm + x1 + x2 + factor(c3) + z, data = data.frame(d, arm = arm, y = y))
    c(mean_x1 = mean(d$x1), p_x2 = mean(d$x2), p_c3_2 = mean(d$c3 == 2), b_x1 = unname(stats::coef(f)["x1"]), b_x2 = unname(stats::coef(f)["x2"]),
      v_x1 = stats::vcov(f)["x1", "x1"])
  }
  streams <- vcr_stream_bank(99L)$take(M)
  mine <- t(vapply(seq_len(M), function(i) summ(vcr_with_stream(streams[[i]], function(.) vcr_chained_impute(D, cbind(arm = arm, outcome = y), kinds, 10L), i)), numeric(6)))
  dm <- cbind(D, arm = arm, y = y); dm$c3 <- factor(dm$c3); dm$x2 <- factor(dm$x2)
  imp <- mice::mice(dm, m = M, method = c("pmm", "logreg", "polyreg", "", "", ""), maxit = 10, printFlag = FALSE, seed = 5L)
  theirs <- t(vapply(seq_len(M), function(i) {
    d <- mice::complete(imp, i); d$c3 <- as.numeric(as.character(d$c3)); d$x2 <- as.numeric(as.character(d$x2)); summ(d)
  }, numeric(6)))
  z_of <- function(nm) (mean(mine[, nm]) - mean(theirs[, nm])) / sqrt(stats::var(mine[, nm]) / M + stats::var(theirs[, nm]) / M)
  zs <- vapply(c("mean_x1", "p_x2", "p_c3_2", "b_x1", "b_x2"), z_of, numeric(1))
  pm <- vcr_rubin_pool(mine[, "b_x1"], mine[, "v_x1"]); pc <- vcr_rubin_pool(theirs[, "b_x1"], theirs[, "v_x1"])
  ratio <- pm$total / pc$total
  list(pass = all(abs(zs) < 3) && abs(ratio - 1) < 0.2,
       detail = sprintf("100 imputations each, missing %.0f%% / %.0f%% / %.0f%%: engine minus mice in Monte-Carlo standard errors: mean of x1 %.2f, share x2 %.2f, share of c3 = 2 %.2f, coefficient of x1 %.2f (%.4f vs %.4f), of x2 %.2f; total variance of the x1 coefficient engine / mice %.3f",
                        100 * mean(is.na(D$x1)), 100 * mean(is.na(D$x2)), 100 * mean(is.na(D$c3)), zs[1], zs[2], zs[3], zs[4], mean(mine[, "b_x1"]), mean(theirs[, "b_x1"]), zs[5], ratio))
})

vcr_case("N78c", c("AC-08", "AC-30"), function() {
  # A known truth. y = 1 + 0.5 x + 0.4 z + e, x missing with a probability that rises with y (so missing at random given y and z, not completely at
  # random): the complete-case slope of x is biased, the pooled slope of 5 imputations that carry the outcome is not, and its Rubin interval covers
  # the truth about 95% of the time. About a third is missing on purpose: predictive mean matching with five donors is attenuated when two thirds
  # of the extreme values are gone (at 43% missing the slope came out 0.472, and mice's own matching gave 0.471 on the same trials), which is a
  # property of the method that both implementations share, not a defect of this one.
  set.seed(20261104L, kind = VCR_RNG_KIND)
  R <- 150L; n <- 400L; m <- 5L; truth <- 0.5
  one <- function(r) {
    z <- stats::rnorm(n); x <- 0.5 * z + stats::rnorm(n); y <- 1 + truth * x + 0.4 * z + stats::rnorm(n)
    xm <- ifelse(stats::runif(n) < stats::plogis(-1.2 + 1.0 * scale(y)[, 1]), NA, x)
    D <- data.frame(x = xm, z = z)
    cc <- stats::coef(summary(stats::lm(y ~ x + z, data = data.frame(x = xm, z = z, y = y))))["x", 1]
    st <- vcr_stream_bank(1000L + r)$take(m)
    fits <- lapply(seq_len(m), function(i) {
      d <- vcr_with_stream(st[[i]], function(.) vcr_chained_impute(D, cbind(outcome = y), list(x = "pmm"), 5L), i)
      s <- stats::coef(summary(stats::lm(y ~ x + z, data = data.frame(d, y = y))))["x", ]
      c(s[[1]], s[[2]]^2)
    })
    q <- vapply(fits, function(f) f[1], numeric(1)); u <- vapply(fits, function(f) f[2], numeric(1))
    p <- vcr_rubin_pool(q, u, n - 3)
    iv <- .vcr_pooled_row(p, "identity")
    c(cc = cc, mi = p$estimate, hit = as.numeric(iv$lower <= truth && truth <= iv$upper), share = mean(is.na(xm)))
  }
  out <- t(vapply(seq_len(R), one, numeric(4)))
  bias_cc <- mean(out[, "cc"]) - truth; bias_mi <- mean(out[, "mi"]) - truth
  se_cc <- stats::sd(out[, "cc"]) / sqrt(R); se_mi <- stats::sd(out[, "mi"]) / sqrt(R)
  cover <- mean(out[, "hit"])
  list(pass = abs(bias_mi) < 2.5 * se_mi && abs(bias_cc) > 4 * se_cc && abs(bias_cc) > 3 * abs(bias_mi) && cover > 0.88,
       detail = sprintf("%d trials of %d (%.0f%% of x missing, depending on the outcome), truth %.2f: complete-case slope %.4f (bias %+.4f, %.1f errors), 5 imputations %.4f (bias %+.4f, %.1f errors), coverage of the Rubin interval %.3f",
                        R, n, 100 * mean(out[, "share"]), truth, mean(out[, "cc"]), bias_cc, bias_cc / se_cc, mean(out[, "mi"]), bias_mi, bias_mi / se_mi, cover))
})

.n78_data <- function(n = 400L, seed = 20261105L, ev = FALSE) {
  set.seed(seed, kind = VCR_RNG_KIND)
  x1 <- stats::rnorm(n); x2 <- stats::rbinom(n, 1L, 0.4); z <- stats::rnorm(n) + 0.5 * x1
  arm <- stats::rbinom(n, 1L, stats::plogis(0.5 * x1 - 0.4 * x2))
  y <- 1 + 0.5 * arm + 0.8 * x1 + 0.6 * x2 + 0.3 * z + stats::rnorm(n)
  d <- data.frame(USUBJID = sprintf("S%04d", seq_len(n)), arm = arm, age = 60 + 8 * x1,
                  x1 = ifelse(stats::runif(n) < stats::plogis(-1.2 + 0.6 * scale(y)[, 1] + 0.4 * z), NA, x1),
                  x2 = ifelse(stats::runif(n) < stats::plogis(-1.5 + 0.5 * z), NA, x2), z = z, y = y)
  d
}

vcr_case("N78d", c("AC-08", "AC-30"), function() {
  # The job against a hand computation. The pooled difference is the mean of the plain job's point estimate on each completed table (the tables are
  # rebuilt here from the same streams), the between-imputation variance is the variance of those estimates, the within-imputation variance is the
  # bootstrap variance the plain job gives with 2,000 draws (the imputed job uses a share of 2,000: within 15%), the interval is Rubin's, the
  # complete-case answer is the plain job on the complete rows, and 1 and 2 cores give one hash.
  d <- .n78_data(400L)
  m <- 6L; seed <- 5L
  sc <- list(covariates = list("x1", "x2", "z"), treatmentColumn = "arm", outcomeColumn = "y", estimand = "ATE", endpoint = list(type = "continuous"))
  mk <- function(df, id, sc_, cores = 1L, replicates = NULL) vcr_test_job("comparator.propensity_weight", sc_, list(vcr_test_input(df, paste0("snp_", id, ":subject"), "subject")),
                                                                         seed = seed, job_id = paste0("job_", id), cores = cores, replicates = replicates)
  dir <- tempfile("n78d"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- vcr_test_run(mk(d, "n78d", c(sc, list(imputation = list(m = m))), 1L), output_dir = dir)
  r2 <- vcr_test_run(mk(d, "n78d", c(sc, list(imputation = list(m = m))), 2L))
  same <- identical(vcr_test_run(mk(d, "n78d", c(sc, list(imputation = list(m = m))), 1L))$manifest$outputHash, r2$manifest$outputHash)
  imp <- r$diagnostics$imputation
  # the completed tables, from the same streams the job drew from
  covs <- c("x1", "x2", "z")
  extras <- cbind(arm = d$arm, outcome = d$y)
  kinds <- list(x1 = "pmm", x2 = "logreg")
  streams <- vcr_stream_bank(.vcr_imputation_seed(seed, "imputation-streams"))$take(m)
  est <- numeric(m); wsd <- numeric(m)
  for (i in seq_len(m)) {
    done <- vcr_with_stream(streams[[i]], function(.) vcr_chained_impute(d[, covs], extras, kinds, 10L), i)
    comp <- d; comp[, covs] <- done[, covs]
    ri <- vcr_test_run(mk(comp, paste0("n78d", i), sc, 1L, replicates = 2000L))
    est[i] <- vcr_measure_value(ri, "weighted_difference")
    iv <- vcr_get_measure(ri, "weighted_difference")$interval
    wsd[i] <- (iv$high - iv$low) / (2 * stats::qnorm(0.975))
  }
  pooled <- imp$pooled[[1]]
  dfcom <- nrow(d) - 3 - 1
  ref <- vcr_rubin_pool(est, wsd^2, dfcom)
  cc_rows <- stats::complete.cases(d[, covs])
  rcc <- vcr_test_run(mk(d[cc_rows, ], "n78dcc", sc, 1L, replicates = 2000L))
  est_row <- vcr_get_measure(r, "weighted_difference")
  cc_est <- imp$completeCase$estimates[[1]]
  ok <- identical(r$status, "succeeded") && same &&
    abs(pooled$imputed$estimate - mean(est)) < 1e-10 && abs(est_row$value - mean(est)) < 1e-10 && abs(pooled$between - stats::var(est)) < 1e-10 &&
    abs(pooled$within / ref$within - 1) < 0.15 && abs(pooled$total / ref$total - 1) < 0.15 &&
    abs(est_row$interval$low - (pooled$imputed$estimate - stats::qt(0.975, pooled$df) * sqrt(pooled$total))) < 1e-10 &&
    abs(cc_est$estimate - vcr_measure_value(rcc, "weighted_difference")) < 1e-10 && imp$completeCase$rows == sum(cc_rows) && identical(est_row$source, "imputed") &&
    imp$bootstrap$perRun == ceiling(2000 / (m + 1)) && imp$bootstrap$runs == m + 1L && "assumption" %in% names(imp) &&
    file.exists(file.path(dir, "weights.csv")) && max(utils::read.csv(file.path(dir, "weights.csv"))$row) <= nrow(d)
  list(pass = ok,
       detail = sprintf("%d imputations, %.0f%% of rows incomplete, %d complete cases: pooled difference %.5f = mean of the plain job on %d completed tables (%.5f, gap %.1e); between variance %.2e = their variance; within %.2e vs %.2e from 2,000 draws; interval %.3f to %.3f = estimate -+ t(%.1f) sqrt(T); complete-case %.4f = the plain job on the %d complete rows; %d draws a run (2,000 shared by %d runs); 1 and 2 cores one hash",
                        m, 100 * imp$shareIncomplete, sum(cc_rows), pooled$imputed$estimate, m, mean(est), abs(pooled$imputed$estimate - mean(est)), pooled$between, pooled$within, ref$within,
                        est_row$interval$low, est_row$interval$high, pooled$df, cc_est$estimate, sum(cc_rows), imp$bootstrap$perRun, imp$bootstrap$runs))
})

vcr_case("N78e", c("AC-07", "AC-30"), function() {
  # The four comparators run on completed tables and say so; the edges: no `imputation` keeps the refusal (and its words name the key), nothing
  # missing runs the plain analysis, too few observed values is a named refusal, a cohort rule keeps the excluded out of the imputation, an older
  # label is refused the key, a budget that runs out after some imputations pools those (limited, stopped early) and one that runs out before two
  # keeps the complete-case answer in a failed result.
  d <- .n78_data(300L, 20261106L)
  tte_d <- local({ set.seed(7L, kind = VCR_RNG_KIND); tt <- stats::rexp(300L, 0.08 * exp(0.4 * d$arm * -1 + 0.2 * d$z)); cc <- stats::runif(300L, 5, 30)
                   data.frame(USUBJID = d$USUBJID, PARAMCD = "OS", AVAL = pmin(tt, cc), CNSR = as.integer(tt > cc)) })
  base <- list(covariates = list("x1", "x2", "z"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "continuous"))
  run <- function(method, sc, inputs = NULL, ..., m = 3L, version = NULL) {
    job <- vcr_test_job(method, utils::modifyList(sc, list(imputation = list(m = m))), inputs %||% list(vcr_test_input(d, "snp_n78e:subject", "subject")), seed = 4L, job_id = "job_n78e", ...)
    if (!is.null(version)) job$methodVersion <- version
    vcr_test_run(job)
  }
  methods_ok <- vapply(c("comparator.entropy_balance", "comparator.propensity_weight", "comparator.aipw"), function(mt) {
    sc <- if (mt == "comparator.aipw") utils::modifyList(base, list(endpoint = list(type = "continuous"))) else base
    if (mt == "comparator.entropy_balance") sc$estimand <- "ATT"
    r <- run(mt, sc)
    identical(r$status, "succeeded") && !is.null(r$diagnostics$imputation$pooled) && all(vapply(Filter(function(x) x$name %in% c("weighted_difference", "aipw_difference"), r$measures), function(x) identical(x$source, "imputed"), logical(1)))
  }, logical(1))
  tte_inputs <- list(vcr_test_input(d, "snp_n78e:subject", "subject"), vcr_test_input(tte_d, "snp_n78e:events", "event"))
  cox <- run("comparator.weighted_cox", list(covariates = list("x1", "x2", "z"), treatmentColumn = "arm", tau = 15, timeUnit = "months", parameterCode = "OS", endpoint = list(type = "time_to_event"), weighting = "propensity"), tte_inputs, m = 2L)
  cox_ok <- identical(cox$status, "succeeded") && !is.null(vcr_get_measure(cox, "hazard_ratio")) && identical(vcr_get_measure(cox, "hazard_ratio")$source, "imputed") &&
    !is.null(vcr_get_measure(cox, "e_value")) && is.null(vcr_get_measure(cox, "hazard_ratio_robust"))
  # no key: the refusal, and it says which key
  plain <- vcr_test_job("comparator.propensity_weight", base, list(vcr_test_input(d, "snp_n78e:subject", "subject")), seed = 4L, job_id = "job_n78e")
  rp <- vcr_test_run(plain)
  refusal_ok <- identical(rp$status, "failed") && "missing_covariate" %in% vcr_test_issue_codes(rp) && grepl("imputation", rp$diagnostics$issues[[1]]$detail, fixed = TRUE)
  # nothing missing
  full <- d; full$x1[is.na(full$x1)] <- 0; full$x2[is.na(full$x2)] <- 0
  rf <- run("comparator.propensity_weight", base, list(vcr_test_input(full, "snp_n78e_full:subject", "subject")))
  none_ok <- identical(rf$status, "succeeded") && identical(rf$diagnostics$imputation$performed, FALSE) && identical(rf$diagnostics$imputation$reason, "no_missing_covariate")
  # too few observed values
  sparse <- d; sparse$x1[-(1:6)] <- NA
  rs <- run("comparator.propensity_weight", base, list(vcr_test_input(sparse, "snp_n78e_sparse:subject", "subject")))
  sparse_ok <- identical(rs$status, "failed") && "imputation_not_possible" %in% vcr_test_issue_codes(rs)
  # an older label does not read the key
  old <- run("comparator.propensity_weight", base, version = "1.4.0")
  old_ok <- identical(old$status, "failed") && "method_version_mismatch" %in% vcr_test_issue_codes(old)
  # a cohort rule: the people it excludes take no part (their rows are not counted in the rows analysed)
  rules <- list(list(name = "adult", rule = list(op = "compare", column = "age", comparator = "gte", value = 55)))
  rc <- run("comparator.propensity_weight", utils::modifyList(base, list(cohortRules = rules)))
  kept <- sum(d$age >= 55)
  cohort_ok <- identical(rc$status, "succeeded") && rc$diagnostics$imputation$rowsAnalysed == kept && rc$diagnostics$cohort$keptRows == kept
  # the budget: a limit that stops the job part-way pools what finished; one that stops it at once keeps the complete-case answer
  m_big <- 14L
  full_run <- run("comparator.propensity_weight", base, m = m_big)
  cpu_all <- full_run$manifest$cpuSeconds
  part <- run("comparator.propensity_weight", base, m = m_big, extra = list(cpuSecondsLimit = max(0.3, 0.45 * cpu_all / 0.9)))
  ip <- part$diagnostics$imputation
  part_ok <- identical(part$status, "succeeded") && identical(part$conclusion, "limited") && identical(ip$stoppedBy, "cpu_budget") && ip$completed >= 2L && ip$completed < m_big &&
    "imputations_stopped_early" %in% vcr_chr(part$diagnostics$limitedBy) && ip$requested == m_big
  none <- run("comparator.propensity_weight", base, m = m_big, extra = list(cpuSecondsLimit = 0.05))
  none_stop_ok <- identical(none$status, "failed") && "cpu_budget_exhausted" %in% vcr_test_issue_codes(none) && !is.null(none$diagnostics$imputation$completeCase)
  ok <- all(methods_ok) && cox_ok && refusal_ok && none_ok && sparse_ok && old_ok && cohort_ok && part_ok && none_stop_ok
  list(pass = ok,
       detail = sprintf("entropy balancing / propensity / doubly robust pooled and sourced imputed: %s; weighted Cox pooled with its E-value: %s; no key keeps the refusal naming it: %s; nothing missing runs plain and says so: %s; 6 observed values: imputation_not_possible: %s; 1.4.0 label refused the key: %s; cohort rule keeps %d analysed: %s; a budget of %.0f%% of the run pooled %d of %d (limited, stopped early): %s; at once: failed with the complete-case answer: %s",
                        paste(methods_ok, collapse = "/"), cox_ok, refusal_ok, none_ok, sparse_ok, old_ok, kept, cohort_ok, 45, ip$completed %||% NA, m_big, part_ok, none_stop_ok))
})
