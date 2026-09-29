# C2-15 - C2-18 — the quality report as a job, and the defects the review found
# in it: a baseline that favours the larger set, an interval rule that narrows as
# records are generated, criteria and analyses that were code, and the utility
# metrics the plan lists that nothing computed.

vcr_case("C2-15", c("AC-04", "AC-20"), function() {
  # `population.quality` through the job: training, synthetic and holdout tables
  # are inputs named by the scenario; criteria and constraints are rules (data);
  # the report is advisory (it never fails a job) and can go red. The identity
  # generator is caught by exact replication and by membership inference; an
  # ideal generator is not.
  set.seed(1515L, kind = VCR_RNG_KIND)
  mk <- function(n) { x1 <- stats::rnorm(n, 60, 10); x2 <- stats::rbinom(n, 1L, 0.5); data.frame(x1 = x1, x2 = x2, y = 0.5 * x1 + 3 * x2 + stats::rnorm(n)) }
  train <- mk(300L); holdout <- mk(300L); ideal <- mk(300L)
  in_tr <- vcr_test_input(train, "train_c215@1", source = "observed")
  in_ho <- vcr_test_input(holdout, "hold_c215@1", source = "observed")
  in_id <- vcr_test_input(ideal, "ideal_c215@1", source = "synthetic", kind = "population")
  in_cp <- vcr_test_input(train, "copy_c215@1", source = "synthetic", kind = "population")
  run <- function(syn, dir) vcr_test_run(vcr_test_job("population.quality",
    list(trainingInputId = "train_c215@1", syntheticInputId = syn, holdoutInputId = "hold_c215@1",
         criteria = list(list(name = "older", rule = list(op = "compare", column = "x1", comparator = "gte", value = 60)),
                         list(name = "female", rule = list(op = "compare", column = "x2", comparator = "eq", value = 0))),
         constraints = list(list(name = "positive_age", rule = list(op = "compare", column = "x1", comparator = "gt", value = 0)))),
    list(in_tr, in_ho, if (identical(syn, "copy_c215@1")) in_cp else in_id), seed = 15L, job_id = "job_c215"), output_dir = dir)
  d1 <- tempfile("c215a"); dir.create(d1); d2 <- tempfile("c215b"); dir.create(d2)
  r_copy <- run("copy_c215@1", d1); r_ideal <- run("ideal_c215@1", d2)
  rc <- r_copy$diagnostics$quality$disclosure; ri <- r_ideal$diagnostics$quality$disclosure
  feas <- r_ideal$diagnostics$quality$utility$feasibility
  ok <- identical(r_copy$status, "succeeded") && identical(r_ideal$status, "succeeded") &&
    rc$exactReplicationRate == 1 && rc$membershipAuc > 0.6 && ri$exactReplicationRate == 0 && abs(ri$membershipAuc - 0.5) < 0.06 &&
    isTRUE(r_ideal$diagnostics$quality$advisory) && isTRUE(r_ideal$diagnostics$quality$constraintsPass) &&
    !is.null(feas$perCriterion) && nrow(feas$perCriterion) == 2L && is.finite(feas$jointPassRateRelativeDifference) &&
    r_ideal$counts$realPatients == 0 && r_ideal$counts$generatedRecords == 300 &&
    !is.null(vcr_test_table(r_ideal, "fidelity-univariate", d2))
  out <- list(pass = ok,
       detail = sprintf("identity generator: exact replication %.3f, membership AUC %.3f; ideal generator: replication %.3f, AUC %.3f; two criteria as rules: joint pass rate real %.3f vs synthetic %.3f (relative difference %.3f); realPatients %s, generated %s",
                        rc$exactReplicationRate, rc$membershipAuc, ri$exactReplicationRate, ri$membershipAuc,
                        feas$jointPassRateReal, feas$jointPassRateSynthetic, feas$jointPassRateRelativeDifference,
                        r_ideal$counts$realPatients, r_ideal$counts$generatedRecords))
  unlink(c(d1, d2), recursive = TRUE)
  out
})

vcr_case("C2-16", c("AC-04"), function() {
  # A baseline must be the same size as what it is compared with. "Is the
  # synthetic record nearer to a training record than to a holdout record?" has
  # the answer "yes, more often" for a generator that memorised NOTHING as soon
  # as the training set is larger than the holdout: a bigger reference set is
  # simply nearer. With a perfect generator (fresh draws from the true
  # mechanism), 400 training and 100 holdout records give a nearest-neighbour
  # share of about 0.63, red on the product's own band (CE-30). The report now
  # compares equal-sized reference sets: the share sits at 0.5 and the
  # uncorrected figure, computed here independently, is shown to be biased.
  set.seed(1616L, kind = VCR_RNG_KIND)
  mk <- function(n) { x1 <- stats::rnorm(n, 60, 10); x2 <- stats::rbinom(n, 1L, 0.5); data.frame(x1 = x1, x2 = x2, y = 0.5 * x1 + 3 * x2 + stats::rnorm(n)) }
  reps <- lapply(1:16, function(i) {
    tr <- mk(400L); ho <- mk(100L); syn <- mk(400L)
    d <- vcr_disclosure_report(tr, syn, ho)
    ranges <- lapply(tr, function(v) diff(range(v)))
    full <- vcr_gower_nearest(syn, tr, ranges)$dcr; hold <- vcr_gower_nearest(syn, ho, ranges)$dcr
    c(corrected = d$nearestNeighbourInTrainShare, full = mean(full < hold) + 0.5 * mean(full == hold),
      replicationRatio = d$replicationRatio, corrected_flag = as.numeric(isTRUE(d$sizeCorrected)))
  })
  m <- colMeans(do.call(rbind, reps))
  # a memorising generator is still caught after the correction
  tr <- mk(400L); ho <- mk(100L)
  mem <- vcr_disclosure_report(tr, tr, ho)
  # Matching sizes by subsampling the training set also thins out what a
  # memorising generator memorised (a quarter of its copied rows survive a 100 of
  # 400 subsample), so the share falls from ~1 to ~0.6: still over the red line;
  # the full-size exact-replication rate and the membership AUC, which need no
  # subsample, say 1.0 and well above chance.
  bands <- vcr_quality_bands()
  ok <- abs(m[["corrected"]] - 0.5) < 0.04 && m[["full"]] > 0.58 && m[["corrected_flag"]] == 1 &&
    vcr_band(mem$nearestNeighbourInTrainShare, bands$nearestNeighbourInTrainShare) == "red" &&
    mem$exactReplicationRateFullTraining == 1 && mem$exactReplicationRate > 0 && mem$exactReplicationRateHoldout == 0 &&
    is.infinite(mem$replicationRatio) && mem$membershipAuc > 0.7
  list(pass = ok,
       detail = sprintf("ideal generator, 400 train / 100 holdout, 16 datasets: nearest-neighbour share %.3f corrected (band: green <= .55) vs %.3f uncorrected (red); a memorising generator: share %.3f (red), full-size exact replication %.3f, membership AUC %.3f",
                        m[["corrected"]], m[["full"]], mem$nearestNeighbourInTrainShare, mem$exactReplicationRateFullTraining, mem$membershipAuc))
})

vcr_case("C2-17", c("AC-09", "AC-11"), function() {
  # Generating more records must never narrow an interval below what the real
  # records carry (plan 3.5, 14). For fully synthetic data drawn from a model
  # fitted to n_obs real records, n_syn records per copy, the variance of the
  # combined estimate is ubar * (k + 1/m) with k = n_syn / n_obs; the first
  # version used ubar * (1 + k/m), which at n_syn = 10 n_obs reported SE 0.039
  # for an estimate whose sampling SD is 0.071 -- and a "95%" interval that
  # covered 71% of the time (EA-17). Checked at k = 1 and k = 10 by simulation.
  run <- function(n_obs, n_syn, m, reps, seed) {
    one <- function(i) {
      x <- stats::rnorm(n_obs, 0, 1)
      mu <- mean(x); sg <- stats::sd(x)
      est <- numeric(m); var <- numeric(m)
      for (k in seq_len(m)) { xs <- stats::rnorm(n_syn, mu, sg); est[k] <- mean(xs); var[k] <- stats::var(xs) / n_syn }
      cm <- vcr_synthetic_combine(est, var, m = m, n_syn = n_syn, n_obs = n_obs)
      old_se <- sqrt(mean(var) * (1 + (n_syn / n_obs) / m))          # the first version's rule
      c(est = cm$estimate, se = cm$se, cover = as.numeric(abs(cm$estimate - 0) <= stats::qnorm(0.975) * cm$se),
        old_se = old_se, old_cover = as.numeric(abs(cm$estimate - 0) <= stats::qnorm(0.975) * old_se))
    }
    res <- do.call(rbind, vcr_map_streams(vcr_stream_bank(seed)$take(reps), one, cores = VCR_TEST_CORES))
    list(emp_sd = stats::sd(res[, "est"]), se = mean(res[, "se"]), cover = mean(res[, "cover"]),
         real_se = 1 / sqrt(n_obs), old_se = mean(res[, "old_se"]), old_cover = mean(res[, "old_cover"]))
  }
  a <- run(200L, 2000L, 5L, 4000L, 1717L); b <- run(200L, 200L, 5L, 4000L, 1718L)
  mcse <- sqrt(0.95 * 0.05 / 4000L)
  ok <- abs(a$cover - 0.95) <= 3 * mcse + 0.005 && abs(b$cover - 0.95) <= 3 * mcse + 0.005 &&
    abs(a$se / a$emp_sd - 1) < 0.05 && abs(b$se / b$emp_sd - 1) < 0.05 && a$se >= 0.95 * a$real_se &&
    a$old_cover < 0.85
  list(pass = ok,
       detail = sprintf("n_obs 200, n_syn 2000 (k=10), m 5: engine SE %.4f, empirical SD %.4f, real-data SE %.4f, coverage %.4f (the old rule: SE %.4f, coverage %.3f); n_syn = n_obs (k=1): SE %.4f vs empirical %.4f, coverage %.4f",
                        a$se, a$emp_sd, a$real_se, a$cover, a$old_se, a$old_cover, b$se, b$emp_sd, b$cover))
})

vcr_case("C2-18", c("AC-04"), function() {
  # The utility and fidelity metrics the plan lists, each of which can go red:
  # declared analyses as data (a mean; a glm coefficient) with the
  # confidence-interval overlap, train-on-synthetic / test-on-real, and rare
  # combinations. A generator that keeps the marginals and destroys the
  # associations (a column shuffle) must lose on TSTR and on the declared glm
  # analysis; an ideal one must not.
  set.seed(1818L, kind = VCR_RNG_KIND)
  mk <- function(n) { x1 <- stats::rnorm(n, 60, 10); x2 <- stats::rbinom(n, 1L, 0.5)
    data.frame(x1 = x1, x2 = x2, grp = sample(c("a", "b", "c"), n, TRUE, c(0.5, 0.3, 0.2)), y = stats::rbinom(n, 1L, stats::plogis(-3 + 0.05 * x1 + 1.2 * x2))) }
  train <- mk(600L); holdout <- mk(600L); ideal <- mk(600L)
  shuffled <- ideal; shuffled$y <- sample(shuffled$y)
  an <- list(mean_x1 = vcr_analysis_from_spec(list(kind = "mean", column = "x1")),
             y_glm = vcr_analysis_from_spec(list(kind = "glm", outcome = "y", predictors = list("x1", "x2"), target = "x2", family = "binomial")))
  rep_ideal <- vcr_quality_report(train, ideal, holdout, analyses = an, tstr_outcome = "y")
  rep_shuf <- vcr_quality_report(train, shuffled, holdout, analyses = an, tstr_outcome = "y")
  t_i <- rep_ideal$utility$tstr; t_s <- rep_shuf$utility$tstr
  ov_i <- rep_ideal$utility$specific$y_glm$confidenceIntervalOverlap; ov_s <- rep_shuf$utility$specific$y_glm$confidenceIntervalOverlap
  # the overlap of the two intervals, recomputed by hand
  fit <- function(d) { f <- suppressWarnings(stats::glm(y ~ x1 + x2, data = d, family = stats::binomial())); co <- summary(f)$coefficients["x2", ]; co[["Estimate"]] + c(-1, 1) * 1.96 * co[["Std. Error"]] }
  a <- fit(train); b <- fit(ideal); lo <- max(a[1], b[1]); hi <- min(a[2], b[2])
  ov_hand <- if (hi <= lo) 0 else 0.5 * ((hi - lo) / diff(a) + (hi - lo) / diff(b))
  # rare combinations: a level pair present >= 5 times in the real table that the synthetic table never makes
  synth_missing <- ideal[!(ideal$grp == "c" & ideal$x2 == 1), ]
  rc_full <- vcr_rare_combinations(train, ideal); rc_gap <- vcr_rare_combinations(train, synth_missing)
  # a data-defined analysis with a non-identifier column is refused, never evaluated
  bad <- tryCatch(vcr_analysis_from_spec(list(kind = "mean", column = "x1; system('id')")), vcr_refusal = function(e) e$issue$code)
  ok <- isTRUE(t_i$available) && t_i$ratio > 0.9 && t_s$ratio < 0.75 && ov_i > ov_s + 0.2 &&
    abs(ov_i - ov_hand) < 1e-9 && rc_gap$worstMissingInSynthetic > 0.05 && rc_full$worstMissingInSynthetic < rc_gap$worstMissingInSynthetic &&
    identical(bad, "scenario_value_invalid") && rep_shuf$bands$tstrRatio %in% c("yellow", "red")
  list(pass = ok,
       detail = sprintf("TSTR ratio (AUC on the holdout, synthetic-trained / real-trained): ideal %.3f, shuffled outcome %.3f (band %s); declared glm coefficient CI overlap ideal %.3f (by hand %.3f) vs shuffled %.3f; rare combinations missing from synthetic: %.3f for the ideal, %.3f when a real cell is removed; an analysis column that is not an identifier -> %s",
                        t_i$ratio, t_s$ratio, rep_shuf$bands$tstrRatio, ov_i, ov_hand, ov_s,
                        rc_full$worstMissingInSynthetic, rc_gap$worstMissingInSynthetic, bad))
})
