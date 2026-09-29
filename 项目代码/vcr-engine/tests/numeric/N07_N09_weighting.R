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
  # 0.5 with bias inside 3 MCSE and nominal coverage.
  truth <- 0.5
  n <- 500L
  boot_b <- 200L
  one <- function(i) {
    x1 <- stats::rnorm(n); x2 <- stats::rnorm(n)
    z <- stats::rbinom(n, 1L, stats::plogis(-0.5 + 0.8 * x1 - 0.5 * x2))
    if (sum(z) < 20L || sum(1 - z) < 20L) return(c(est = NA_real_, cover = NA_real_))
    y <- 1 + 0.5 * x1 + 0.3 * x2 + truth * z + stats::rnorm(n)
    X <- cbind(x1 = x1, x2 = x2)
    est_fn <- function(idx) {
      f <- vcr_att_entropy_weights(X[idx, , drop = FALSE], z[idx])
      if (is.null(f$allWeights)) return(NA_real_)
      w <- f$allWeights; zz <- z[idx]; yy <- y[idx]
      stats::weighted.mean(yy[zz == 1L], w[zz == 1L]) - stats::weighted.mean(yy[zz == 0L], w[zz == 0L])
    }
    est <- est_fn(seq_len(n))
    if (!is.finite(est)) return(c(est = NA_real_, cover = NA_real_))
    # Whole-pipeline bootstrap, stratified on arm, weights re-estimated inside.
    bs <- vapply(seq_len(boot_b), function(b) {
      idx <- c(sample(which(z == 1L), sum(z == 1L), replace = TRUE),
               sample(which(z == 0L), sum(z == 0L), replace = TRUE))
      est_fn(idx)
    }, numeric(1))
    se <- stats::sd(bs[is.finite(bs)])
    lo <- est - stats::qnorm(0.975) * se; hi <- est + stats::qnorm(0.975) * se
    c(est = est, cover = as.numeric(lo <= truth && hi >= truth))
  }
  reps <- 2000L
  bank <- vcr_stream_bank(20260928L)
  out <- vcr_map_streams(bank$take(reps), one, cores = VCR_TEST_CORES)
  est <- vapply(out, function(o) o[["est"]], numeric(1))
  cov <- vapply(out, function(o) o[["cover"]], numeric(1))
  ok_est <- is.finite(est)
  bias <- mean(est[ok_est]) - truth
  mcse_bias <- stats::sd(est[ok_est]) / sqrt(sum(ok_est))
  coverage <- mean(cov[is.finite(cov)])
  pass <- abs(bias) <= 3 * mcse_bias && coverage >= 0.935 && coverage <= 0.965
  list(pass = pass,
       detail = sprintf("true ATT %.2f; bias %+.5f = %.2f MCSE (mcse %.5f); coverage %.4f (band 0.935-0.965, B=%d bootstrap, %d replicates, %d unusable)",
                        truth, bias, abs(bias) / mcse_bias, mcse_bias, coverage, boot_b, reps, sum(!ok_est)))
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
  path <- tempfile(fileext = ".csv"); utils::write.csv(df, path, row.names = FALSE)
  job <- list(jobId = "job_n09", studyId = "std_n09", kind = "weight_comparator",
              method = "comparator.entropy_balance", methodVersion = "1.0.0", protocolVersion = 1L,
              seed = 1L, cpuSecondsLimit = 120,
              inputs = list(list(kind = "snapshot", id = "snp_n09", hash = vcr_file_sha256(path), location = path)),
              scenario = list(covariates = c("x1", "x2"), outcomeColumn = "y", treatmentColumn = "arm",
                              bootstrapReplicates = 50L))
  r <- vcr_run_job(job)
  unlink(path)
  numbers <- vapply(r$measures, function(m) m$value, numeric(1))
  ok <- identical(r$status, "not_estimable") &&
    identical(r$notEstimableRule, "entropy_balance_infeasible") &&
    length(r$measures) == 0L && length(vcr_validate_result(r)) == 0L &&
    !any(numbers == 0)
  list(pass = ok,
       detail = sprintf("status=%s rule=%s measures=%d (trial x1 mean %.3f, control x1 range [%.3f, %.3f]); no effect value emitted, no 0 written",
                        r$status, r$notEstimableRule %||% "NULL", length(r$measures),
                        mean(trt$x1), min(ctrl$x1), max(ctrl$x1)))
})
