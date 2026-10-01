# N07-N09 — the weighting kernel: cross-software, known truth, and refusal.

vcr_case("N07", c("AC-08", "AC-30"), function() {
  suppressMessages({library(WeightIt); library(cobalt); library(MatchIt)})
  data("lalonde", package = "MatchIt")
  X <- stats::model.matrix(~ age + educ + race + married + nodegree + re74 + re75, lalonde)[, -1]
  ours <- vcr_att_entropy_weights(X, lalonde$treat)
  w <- ours$allWeights
  bal <- vcr_balance_table(X, lalonde$treat, w)
  # WeightIt's default `reltol = 1e-10` stops at ~3e-6 standardized difference;
  # at 1e-16 it reaches ~6e-9. Ours solves the constraints to machine
  # precision, so the comparison is made against WeightIt's tightest setting
  # and the residual gap is WeightIt's, not ours (see the report).
  wi <- WeightIt::weightit(treat ~ age + educ + race + married + nodegree + re74 + re75,
                           data = lalonde, method = "ebal", estimand = "ATT",
                           reltol = 1e-16, maxit = 200000L)
  cb <- cobalt::bal.tab(wi, stats = "mean.diffs")$Balance$Diff.Adj
  wc_ours <- w[lalonde$treat == 0]; wc_wi <- wi$weights[lalonde$treat == 0]
  rel_w <- max(abs(wc_ours - wc_wi) / wc_wi)
  d_smd <- max(abs(bal$smdAdjusted - cb[seq_len(nrow(bal))]))
  att_ours <- stats::weighted.mean(lalonde$re78[lalonde$treat == 1], w[lalonde$treat == 1]) -
    stats::weighted.mean(lalonde$re78[lalonde$treat == 0], wc_ours)
  att_wi <- stats::weighted.mean(lalonde$re78[lalonde$treat == 1], wi$weights[lalonde$treat == 1]) -
    stats::weighted.mean(lalonde$re78[lalonde$treat == 0], wc_wi)
  rel_att <- abs(att_ours - att_wi) / abs(att_wi)
  ess <- vcr_ess(wc_ours)
  # Our own feasibility is the exact statement; the cross-software tolerances
  # are the plan's (SMD < 1e-6, ATT < 1e-6 relative).
  ok <- ours$discrepancy < 1e-12 && max(abs(bal$smdAdjusted)) < 1e-10 &&
    d_smd < 1e-6 && rel_att < 1e-6 && abs(sum(wc_ours) - sum(lalonde$treat)) < 1e-9
  list(pass = ok,
       detail = sprintf("ATT %.6f (WeightIt %.6f, rel %.2e); max|SMD| ours %.2e vs cobalt %.2e (d %.2e); ESS %.5f; weights rel-diff %.2e [WeightIt's own residual, see report]",
                        att_ours, att_wi, rel_att, max(abs(bal$smdAdjusted)), max(abs(cb)), d_smd, ess, rel_w))
})

vcr_case("N08", c("AC-08", "AC-11", "AC-29"), function() {
  # Confounded data-generating mechanism with a known ATT of 0.5.
  # Z depends on X, Y depends on X and Z; the weighted difference must recover
  # 0.5 with bias inside 3 MCSE and nominal coverage -- and the interval is the
  # ENGINE's whole-pipeline bootstrap (`vcr_bootstrap_pipeline`, weights
  # re-estimated in every resample, stratified on arm), not a copy of it written
  # into the case: the first version of this case re-implemented the bootstrap
  # inline, so the engine's own could have been wrong without the case knowing.
  # Bias is judged over 3,000 replicates of the point estimate; coverage over 800
  # replicates each with its own B = 200 bootstrap.
  truth <- 0.5
  n <- 500L
  boot_b <- 200L
  draw <- function() {
    x1 <- stats::rnorm(n); x2 <- stats::rnorm(n)
    z <- stats::rbinom(n, 1L, stats::plogis(-0.5 + 0.8 * x1 - 0.5 * x2))
    y <- 1 + 0.5 * x1 + 0.3 * x2 + truth * z + stats::rnorm(n)
    list(X = cbind(x1 = x1, x2 = x2), z = z, y = y)
  }
  est_of <- function(dat, idx) {
    f <- vcr_att_entropy_weights(dat$X[idx, , drop = FALSE], dat$z[idx])
    if (is.null(f$allWeights)) return(NA_real_)
    w <- f$allWeights; zz <- dat$z[idx]; yy <- dat$y[idx]
    stats::weighted.mean(yy[zz == 1L], w[zz == 1L]) - stats::weighted.mean(yy[zz == 0L], w[zz == 0L])
  }
  point <- function(i) { dat <- draw(); if (sum(dat$z) < 20L || sum(1 - dat$z) < 20L) NA_real_ else est_of(dat, seq_len(n)) }
  est <- unlist(vcr_map_streams(vcr_stream_bank(20260928L)$take(3000L), point, cores = VCR_TEST_CORES))
  ok_est <- is.finite(est)
  bias <- mean(est[ok_est]) - truth
  mcse_bias <- stats::sd(est[ok_est]) / sqrt(sum(ok_est))
  covers <- function(i) {
    dat <- draw()
    if (sum(dat$z) < 20L || sum(1 - dat$z) < 20L) return(NA_real_)
    b <- vcr_bootstrap_pipeline(n, function(idx) est_of(dat, idx), replicates = boot_b, seed = 1000L + i, strata = dat$z, cores = 1L)
    as.numeric(b$interval[1] <= truth && b$interval[2] >= truth)
  }
  cov <- unlist(vcr_map_streams(vcr_stream_bank(20260929L)$take(800L), covers, cores = VCR_TEST_CORES))
  coverage <- mean(cov[is.finite(cov)])
  mcse_cov <- sqrt(coverage * (1 - coverage) / sum(is.finite(cov)))
  # the percentile bootstrap at B = 200 is a little liberal: 3 MCSE around 0.95 plus one point
  pass <- abs(bias) <= 3 * mcse_bias && abs(coverage - 0.95) <= 3 * mcse_cov + 0.01
  list(pass = pass,
       detail = sprintf("true ATT %.2f; bias %+.5f = %.2f MCSE (mcse %.5f, %d replicates); coverage of the engine's bootstrap interval %.4f (+-%.4f, nominal 0.95; B=%d, 800 replicates)",
                        truth, bias, abs(bias) / mcse_bias, mcse_bias, sum(ok_est), coverage, mcse_cov, boot_b))
})

vcr_case("N09", c("AC-07", "AC-08"), function() {
  # The trial population's covariate mean lies outside the control convex
  # hull, so no weighting can reach it. The engine must refuse by name and
  # must not emit an effect (and must not emit a 0).
  set.seed(11, kind = VCR_RNG_KIND)
  n_c <- 300L; n_t <- 100L
  ctrl <- data.frame(arm = 0L, x1 = stats::runif(n_c, 0, 1), x2 = stats::rnorm(n_c), y = stats::rnorm(n_c))
  trt <- data.frame(arm = 1L, x1 = stats::runif(n_t, 1.4, 1.6), x2 = stats::rnorm(n_t), y = stats::rnorm(n_t, 1))
  df <- rbind(trt, ctrl)
  df$USUBJID <- sprintf("S%03d", seq_len(nrow(df)))
  inp <- vcr_test_input(df, "snp_n09:subject", "subject")
  job <- vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x1", "x2"), outcomeColumn = "y", treatmentColumn = "arm", endpoint = list(type = "continuous")),
    list(inp), seed = 1L, job_id = "job_n09")
  r <- vcr_test_run(job)
  numbers <- vapply(r$measures, function(m) m$value, numeric(1))
  ok <- identical(r$status, "not_estimable") &&
    identical(r$notEstimableRule, "entropy_balance_infeasible") &&
    identical(r$conclusion, "not_estimable") &&
    length(r$measures) == 0L && length(vcr_validate_result(r)) == 0L &&
    !any(numbers == 0)
  list(pass = ok,
       detail = sprintf("status=%s rule=%s conclusion=%s measures=%d (trial x1 mean %.3f, control x1 range [%.3f, %.3f]); no effect value emitted, no 0 written",
                        r$status, r$notEstimableRule %||% "NULL", r$conclusion %||% "NULL", length(r$measures),
                        mean(trt$x1), min(ctrl$x1), max(ctrl$x1)))
})

vcr_case("N09b", c("AC-07", "AC-08"), function() {
  # What the weighting jobs refuse, each by its own name, and never with an
  # estimate: incomplete covariates (NA rows used to shift the weights one
  # position, so a control was weighted by its neighbour's propensity: CE-28),
  # an estimand that entropy balancing does not estimate (it always reweights
  # to the treated group, so ATE/ATO were mislabelled ATT: EB-14), a synthetic
  # table (AC-08's "aggregate and synthetic rows never enter a weighting"), and
  # the ATO estimand on the propensity route, which is allowed but changes the
  # question and is therefore `limited` and flagged.
  set.seed(9, kind = VCR_RNG_KIND)
  n <- 400L
  x1 <- stats::rnorm(n); x2 <- stats::rnorm(n)
  arm <- stats::rbinom(n, 1L, stats::plogis(0.5 * x1))
  df <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), arm = arm, x1 = x1, x2 = x2, y = 1 + x1 + 0.5 * arm + stats::rnorm(n))
  sc <- list(covariates = list("x1", "x2"), outcomeColumn = "y", treatmentColumn = "arm", endpoint = list(type = "continuous"))
  run <- function(method, scenario, input) vcr_test_run(vcr_test_job(method, scenario, list(input), seed = 9L, job_id = "job_n09b"))
  good_in <- vcr_test_input(df, "snp_n09b:subject", "subject")
  na_df <- df; na_df$x2[c(5, 77, 203)] <- NA
  na_in <- vcr_test_input(na_df, "snp_n09b:na", "subject")
  syn_in <- vcr_test_input(df, "snp_n09b:syn", "subject", source = "synthetic")
  r_na <- run("comparator.propensity_weight", sc, na_in)
  r_ate_e <- run("comparator.entropy_balance", utils::modifyList(sc, list(estimand = "ATE")), good_in)
  r_syn <- run("comparator.entropy_balance", sc, syn_in)
  r_ato <- run("comparator.propensity_weight", utils::modifyList(sc, list(estimand = "ATO")), good_in)
  codes <- list(na = vcr_test_issue_codes(r_na), ate = vcr_test_issue_codes(r_ate_e), syn = vcr_test_issue_codes(r_syn))
  ok <- identical(r_na$status, "failed") && "missing_covariate" %in% codes$na && length(r_na$measures) == 0L &&
    identical(r_ate_e$status, "failed") && "scenario_value_invalid" %in% codes$ate &&
    identical(r_syn$status, "failed") && "input_source_not_individual" %in% codes$syn &&
    identical(r_ato$status, "succeeded") && identical(r_ato$conclusion, "limited") && isTRUE(r_ato$diagnostics$estimandChanged) &&
    "estimand_changed_from_att" %in% unlist(r_ato$diagnostics$limitedBy)
  list(pass = ok,
       detail = sprintf("NA covariate -> %s; entropy balance with ATE -> %s; synthetic table -> %s; propensity ATO -> %s, conclusion %s, limited by %s",
                        paste(codes$na, collapse = ","), paste(codes$ate, collapse = ","), paste(codes$syn, collapse = ","),
                        r_ato$status, r_ato$conclusion, paste(unlist(r_ato$diagnostics$limitedBy), collapse = ",")))
})

vcr_case("N09c", c("AC-08", "AC-30", "AC-07"), function() {
  # The two weighting jobs, end to end through the job path, against WeightIt and
  # cobalt (the references the plan names). (1) Entropy balancing on LaLonde's
  # data: ATT and ESS to 1e-6 of WeightIt's tightest fit, the domain's thresholds
  # echoed, and at least the domain's 2,000 bootstrap draws whatever the job asks
  # (a job that asked for 20 used to get 20: EB-5). (2) The logistic-propensity
  # route on the same data does NOT balance age (weighted SMD 0.119), and the job
  # refuses by rule name with the same standardized difference cobalt reports;
  # (3) on data it can balance, its ATT equals WeightIt's glm ATT to 1e-6.
  suppressMessages({library(WeightIt); library(MatchIt); library(cobalt)})
  data("lalonde", package = "MatchIt")
  d <- lalonde
  d$USUBJID <- sprintf("L%04d", seq_len(nrow(d)))
  d$black <- as.numeric(d$race == "black"); d$hispan <- as.numeric(d$race == "hispan")
  d$arm <- d$treat
  covs <- c("age", "educ", "black", "hispan", "married", "nodegree", "re74", "re75")
  inp <- vcr_test_input(d[, c("USUBJID", "arm", covs, "re78")], "snp_n09c:subject", "subject")
  sc <- list(covariates = as.list(covs), outcomeColumn = "re78", treatmentColumn = "arm", endpoint = list(type = "continuous"))
  fml <- stats::as.formula(paste("treat ~", paste(covs, collapse = " + ")))
  wi <- WeightIt::weightit(fml, data = d, method = "ebal", estimand = "ATT", reltol = 1e-16, maxit = 200000L)
  att_wi <- stats::weighted.mean(d$re78[d$treat == 1], wi$weights[d$treat == 1]) - stats::weighted.mean(d$re78[d$treat == 0], wi$weights[d$treat == 0])
  ess_wi <- vcr_ess(wi$weights[d$treat == 0])
  r_e <- vcr_test_run(vcr_test_job("comparator.entropy_balance", sc, list(inp), seed = 5L, replicates = 20L, job_id = "job_n09c_e"))
  est <- vcr_get_measure(r_e, "weighted_difference"); ess <- vcr_measure_value(r_e, "effective_sample_size")
  ok_e <- identical(r_e$status, "succeeded") && abs(est$value - att_wi) / abs(att_wi) < 1e-6 && abs(ess - ess_wi) / ess_wi < 1e-6 &&
    r_e$diagnostics$bootstrapReplicates >= 2000L && isTRUE(all.equal(as.numeric(r_e$diagnostics$thresholds$essFloor), as.numeric(vcr_domain()$limits$essFloor))) &&
    est$interval$low < est$value && est$value < est$interval$high

  pw <- WeightIt::weightit(fml, data = d, method = "glm", estimand = "ATT")
  cb <- cobalt::bal.tab(pw, stats = "mean.diffs", un = FALSE)$Balance$Diff.Adj
  worst_cb <- max(abs(cb[seq_along(covs)]))
  r_p <- vcr_test_run(vcr_test_job("comparator.propensity_weight", sc, list(inp), seed = 5L, job_id = "job_n09c_p"))
  worst_engine <- max(abs(r_p$diagnostics$balance$smdAdjusted))
  ok_refuse <- identical(r_p$status, "not_estimable") && identical(r_p$notEstimableRule, "standardized_difference_above_floor") &&
    length(r_p$measures) == 0L && abs(worst_engine - worst_cb) < 1e-3

  set.seed(3, kind = VCR_RNG_KIND); n <- 500L
  x1 <- stats::rnorm(n); x2 <- stats::rbinom(n, 1L, 0.5)
  arm <- stats::rbinom(n, 1L, stats::plogis(0.3 * x1))
  sim <- data.frame(USUBJID = sprintf("P%04d", seq_len(n)), arm = arm, x1 = x1, x2 = x2, y = 1 + x1 + 0.5 * arm + stats::rnorm(n))
  in_sim <- vcr_test_input(sim, "snp_n09c:sim", "subject")
  sc2 <- list(covariates = list("x1", "x2"), outcomeColumn = "y", treatmentColumn = "arm", endpoint = list(type = "continuous"))
  pw2 <- WeightIt::weightit(arm ~ x1 + x2, data = sim, method = "glm", estimand = "ATT")
  att_pw <- stats::weighted.mean(sim$y[arm == 1], pw2$weights[arm == 1]) - stats::weighted.mean(sim$y[arm == 0], pw2$weights[arm == 0])
  r_p2 <- vcr_test_run(vcr_test_job("comparator.propensity_weight", sc2, list(in_sim), seed = 5L, job_id = "job_n09c_p2"))
  est_p <- vcr_get_measure(r_p2, "weighted_difference")
  ok_p <- identical(r_p2$status, "succeeded") && abs(est_p$value - att_pw) / abs(att_pw) < 1e-6
  list(pass = ok_e && ok_refuse && ok_p,
       detail = sprintf("entropy balancing ATT %.4f vs WeightIt %.4f (rel %.1e), ESS %.4f vs %.4f, bootstrap draws %d (job asked for 20), interval [%.1f, %.1f], ESS floor %g; propensity on LaLonde: %s/%s, worst weighted SMD %.4f vs cobalt %.4f; propensity ATT on balanced data %.5f vs WeightIt glm %.5f (rel %.1e)",
                        est$value, att_wi, abs(est$value - att_wi) / abs(att_wi), ess, ess_wi, r_e$diagnostics$bootstrapReplicates,
                        est$interval$low, est$interval$high, r_e$diagnostics$thresholds$essFloor,
                        r_p$status, r_p$notEstimableRule %||% "NULL", worst_engine, worst_cb, est_p$value, att_pw, abs(est_p$value - att_pw) / abs(att_pw)))
})
