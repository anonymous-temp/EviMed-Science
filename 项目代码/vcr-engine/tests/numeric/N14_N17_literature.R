# N14-N17 — the literature-control route: MAIC, TSD 18, KM reconstruction and
# the provenance rule that keeps reconstructed rows out of the patient count.

vcr_case("N14", c("AC-08", "AC-30"), function() {
  # One binary covariate at 0.4 in the IPD, 0.6 in the aggregate trial, n=300.
  # The weight on x=1 relative to x=0 is exp(alpha); balancing 120 ones and
  # 180 zeros onto 0.6 gives exp(alpha) = 2.25 and a Kish ESS of 257.142857.
  X <- matrix(c(rep(1, 120), rep(0, 180)), ncol = 1, dimnames = list(NULL, "x"))
  w <- vcr_maic_weights(X, c(x = 0.6))
  uw <- sort(unique(round(w$weights, 10)))
  ratio <- uw[2] / uw[1]
  ess <- w$effectiveSampleSize
  want_ess <- 450^2 / 787.5
  ok <- abs(ratio - 2.25) < 1e-8 && abs(ess - want_ess) < 1e-8 &&
    abs(ess - 257.142857142857) < 1e-8 && abs(w$achievedMeans - 0.6) < 1e-12
  list(pass = ok,
       detail = sprintf("weight ratio %.12f (want 2.25, d %.2e); ESS %.9f (want 257.142857143, d %.2e); achieved mean %.15f",
                        ratio, abs(ratio - 2.25), ess, abs(ess - want_ess), w$achievedMeans))
})

vcr_case("N15", c("AC-30"), function() {
  # NICE DSU TSD 18's method-of-moments MAIC, checked against an independent
  # implementation: a direct BFGS minimization of TSD 18's own objective
  # Q(a) = sum(exp(a' x_centred)), which is a different algorithm (quasi-Newton
  # on the primal-centred form) from this engine's Newton-on-the-dual.
  #
  # The literal appendix listing is not reachable offline, so the fixed
  # baseline is the pair of independent implementations agreeing, which is
  # what "two implementations cross-check" means in plan 12.4.
  set.seed(18L, kind = VCR_RNG_KIND)
  n <- 500L
  age <- stats::rnorm(n, 62, 9)
  male <- stats::rbinom(n, 1L, 0.55)
  ecog <- stats::rbinom(n, 1L, 0.30)
  X <- cbind(age = age, `age^2` = age^2, male = male, ecog = ecog)
  targets <- c(age = 58, `age^2` = 58^2 + 11^2, male = 0.62, ecog = 0.45)
  ours <- vcr_maic_weights(X, targets)
  Xc <- sweep(X, 2, targets, "-")
  obj <- function(a) sum(exp(as.vector(Xc %*% a)))
  gr <- function(a) as.vector(crossprod(Xc, exp(as.vector(Xc %*% a))))
  fit <- stats::optim(rep(0, ncol(Xc)), obj, gr, method = "BFGS",
                      control = list(reltol = 1e-15, maxit = 5000))
  w_ref <- exp(as.vector(Xc %*% fit$par))
  w_ref <- w_ref / mean(w_ref)
  w_ours <- ours$weights / mean(ours$weights)
  rel <- max(abs(w_ours - w_ref) / w_ref)
  ess_ours <- vcr_ess(w_ours); ess_ref <- vcr_ess(w_ref)
  moments <- max(abs(ours$achievedMeans - targets) / pmax(abs(targets), 1))
  ok <- rel < 1e-6 && abs(ess_ours - ess_ref) / ess_ref < 1e-6 && moments < 1e-10
  list(pass = ok,
       detail = sprintf("4 moments matched to %.2e; weights vs independent BFGS rel %.2e (tol 1e-6); ESS %.4f vs %.4f (n=%d, %.1f%% retained)",
                        moments, rel, ess_ours, ess_ref, n, 100 * ess_ours / n))
})

vcr_case("N16", c("AC-03", "AC-27", "AC-30"), function() {
  # Round trip: known individual data -> Kaplan-Meier -> digitized with pixel
  # noise -> Guyot -> compare. Tolerances from the plan: median within 5%,
  # |d log HR| <= 0.05, numbers at risk within max(2, 5%).
  suppressMessages(library(survival))
  set.seed(20260928L, kind = VCR_RNG_KIND)
  arms <- list(
    control = vcr_sim_tte(0L, 300L, vcr_dist_exponential_from_median(12), 1,
                          list(kind = "uniform", duration = 12), 24),
    treatment = vcr_sim_tte(300L, 0L, vcr_dist_exponential_from_median(12), 0.65,
                            list(kind = "uniform", duration = 12), 24))
  t_risk <- seq(0, 30, by = 6)
  rec <- list(); qc <- list(); med <- list()
  for (nm in names(arms)) {
    d <- arms[[nm]]
    km <- vcr_km(d$time, d$status)
    n_risk <- vapply(t_risk, function(tt) sum(d$time >= tt), numeric(1))
    clicks <- seq(0, min(36, max(d$time)), by = 0.25)
    dig <- vcr_digitize_km(km, clicks, noise = 0.004)     # ~0.4 percentage-point pixel error
    r <- vcr_guyot(dig$time, dig$surv, t_risk, n_risk, total_events = sum(d$status))
    q <- vcr_reconstruction_qc(r, t_risk, n_risk, total_events_reported = sum(d$status),
                               median_reported = vcr_km_median(km))
    rec[[nm]] <- r; qc[[nm]] <- q
    med[[nm]] <- c(original = vcr_km_median(km), reconstructed = vcr_km_median(vcr_km(r$ipd$time, r$ipd$status)))
  }
  orig <- rbind(cbind(arms$treatment[, c("time", "status")], arm = 1L),
                cbind(arms$control[, c("time", "status")], arm = 0L))
  recon <- rbind(cbind(rec$treatment$ipd, arm = 1L), cbind(rec$control$ipd, arm = 0L))
  lhr_o <- unname(stats::coef(survival::coxph(survival::Surv(time, status) ~ arm, orig)))
  lhr_r <- unname(stats::coef(survival::coxph(survival::Surv(time, status) ~ arm, recon)))
  med_rel <- max(vapply(med, function(m) abs(m[2] - m[1]) / m[1], numeric(1)))
  ok <- all(vapply(qc, function(q) isTRUE(q$pass), logical(1))) &&
    abs(lhr_r - lhr_o) <= 0.05 && med_rel <= 0.05 &&
    nrow(rec$control$ipd) == 300L && nrow(rec$treatment$ipd) == 300L
  list(pass = ok,
       detail = sprintf("QC pass both arms; median %.2f->%.2f and %.2f->%.2f (worst rel %.3f, tol 0.05); logHR %.4f->%.4f (|d| %.4f, tol 0.05); pseudo-patients %d+%d",
                        med$control[1], med$control[2], med$treatment[1], med$treatment[2],
                        med_rel, lhr_o, lhr_r, abs(lhr_r - lhr_o),
                        nrow(rec$control$ipd), nrow(rec$treatment$ipd)))
})

# A digitized curve as the scenario carries it: rows of { time, surv } and of
# { time, atRisk }, and the tool that produced the coordinates.
.n17_arm <- function(d, t_risk, clicks_to, noise = 0, name = NULL, with_median = TRUE) {
  km <- vcr_km(d$time, d$status)
  n_risk <- vapply(t_risk, function(tt) sum(d$time >= tt), numeric(1))
  dig <- vcr_digitize_km(km, seq(0, min(clicks_to, max(d$time)), by = 0.25), noise = noise)
  out <- list(curve = lapply(seq_len(nrow(dig)), function(i) list(time = dig$time[i], surv = dig$surv[i])),
              riskTable = lapply(seq_along(t_risk), function(i) list(time = t_risk[i], atRisk = n_risk[i])),
              totalEvents = sum(d$status))
  if (with_median && is.finite(vcr_km_median(km))) out$reportedMedian <- vcr_km_median(km)
  out
}
.n17_prov <- list(kind = "digitizer", tool = "case-digitizer", toolVersion = "1")

vcr_case("N17", c("AC-03", "AC-09", "AC-27"), function() {
  # Reconstructed rows are `reconstructed`, counted in
  # `reconstructedPseudoPatients`, and never in `realPatients`. A
  # reconstruction that fails QC is `not_estimable` and emits no numbers.
  set.seed(17L, kind = VCR_RNG_KIND)
  d <- vcr_sim_tte(0L, 250L, vcr_dist_exponential_from_median(10), 1,
                   list(kind = "uniform", duration = 6), 24)
  t_risk <- seq(0, 24, by = 6)
  base <- .n17_arm(d, t_risk, 30)
  mk_job <- function(median_reported) vcr_test_job("evidence.reconstruct_km",
    c(base[c("curve", "riskTable", "totalEvents")], list(reportedMedian = median_reported, provenance = .n17_prov)),
    list(list(kind = "evidence", id = "ev_km@1")), seed = 1L, job_id = "job_n17")
  good <- vcr_test_run(mk_job(vcr_km_median(vcr_km(d$time, d$status))))
  # A reported median 40% away from the curve cannot be reconciled: QC fails.
  bad <- vcr_test_run(mk_job(vcr_km_median(vcr_km(d$time, d$status)) * 1.4))
  ok <- identical(good$status, "succeeded") &&
    identical(good$counts$realPatients, 0) &&
    good$counts$reconstructedPseudoPatients == 250 &&
    identical(good$diagnostics$valueSource, "reconstructed") &&
    all(vapply(good$measures, function(m) identical(m$source, "reconstructed"), logical(1))) &&
    identical(bad$status, "not_estimable") &&
    identical(bad$notEstimableRule, "reconstruction_failed_qc") &&
    length(bad$measures) == 0L
  list(pass = ok,
       detail = sprintf("passing QC: realPatients=%s reconstructedPseudoPatients=%s source=%s; failing QC: status=%s rule=%s measures=%d",
                        good$counts$realPatients, good$counts$reconstructedPseudoPatients,
                        good$diagnostics$valueSource, bad$status,
                        bad$notEstimableRule %||% "NULL", length(bad$measures)))
})

vcr_case("N17b", c("AC-03", "AC-27"), function() {
  # The reconstruction's other checks, each by name. (1) Two arms and a reported
  # hazard ratio: the log hazard ratio of the reconstructed rows is checked
  # against it (|d| <= 0.05). The check used to be dead code (log_hr_recon was
  # NA), so a reported HR of 5 passed. (2) One arm plus a reported HR cannot be
  # checked and is refused, not passed. (3) A curve that never reaches 0.5 has no
  # median: the measure is ABSENT and the diagnostics say so (it used to write
  # Inf, fail result validation and turn a good reconstruction into a failed
  # job). (4) No risk table: refused by name. (5) Coordinates without a named
  # digitizer / human-click provenance: refused.
  set.seed(1717L, kind = VCR_RNG_KIND)
  dist <- vcr_dist_exponential_from_median(12)
  dc <- vcr_sim_tte(0L, 300L, dist, 1, list(kind = "uniform", duration = 12), 24)
  dt <- vcr_sim_tte(300L, 0L, dist, 0.65, list(kind = "uniform", duration = 12), 24)
  t_risk <- seq(0, 30, by = 6)
  ac <- .n17_arm(dc, t_risk, 36, noise = 0.004); at <- .n17_arm(dt, t_risk, 36, noise = 0.004)
  lhr_true <- vcr_cox_loghr(c(dc$time, dt$time), c(dc$status, dt$status), c(rep(0L, nrow(dc)), rep(1L, nrow(dt))))
  job <- function(sc) vcr_test_run(vcr_test_job("evidence.reconstruct_km", sc, list(list(kind = "evidence", id = "ev_km@1")), seed = 1L, job_id = "job_n17b"))
  two <- function(hr) c(ac, list(treatmentArm = at, provenance = .n17_prov), if (!is.null(hr)) list(reportedLogHazardRatio = hr))
  r_ok <- job(two(lhr_true)); r_bad <- job(two(lhr_true + 0.5)); r_one <- job(c(ac, list(provenance = .n17_prov, reportedLogHazardRatio = -0.4)))
  lhr_rec <- vcr_measure_value(r_ok, "log_hazard_ratio")
  dn <- vcr_sim_tte(0L, 250L, vcr_dist_exponential_from_median(40), 1, list(kind = "uniform", duration = 6), 24)
  r_nm <- job(c(.n17_arm(dn, seq(0, 24, by = 6), 30, with_median = FALSE), list(provenance = .n17_prov)))
  no_risk <- job(c(ac[c("curve", "totalEvents")], list(provenance = .n17_prov)))
  no_prov <- job(ac)
  ok <- identical(r_ok$status, "succeeded") && abs(lhr_rec - lhr_true) <= 0.05 &&
    identical(r_bad$status, "not_estimable") && identical(r_bad$notEstimableRule, "reconstruction_failed_qc") &&
    identical(r_one$status, "failed") &&
    identical(r_nm$status, "succeeded") && is.null(vcr_get_measure(r_nm, "median_survival")) && isTRUE(r_nm$diagnostics$medianNotReached[[1]]) &&
    identical(no_risk$status, "failed") && identical(no_prov$status, "failed") &&
    r_ok$counts$reconstructedPseudoPatients == 600 && identical(r_ok$counts$realPatients, 0)
  list(pass = ok,
       detail = sprintf("two arms: reconstructed log HR %.4f vs Cox on the original rows %.4f (|d| %.4f, tol 0.05) passes; a reported log HR 0.5 off -> %s/%s; one arm + reported HR -> %s (%s); median not reached -> status %s, median measure absent %s; no risk table -> %s (%s); no provenance -> %s (%s)",
                        lhr_rec, lhr_true, abs(lhr_rec - lhr_true), r_bad$status, r_bad$notEstimableRule %||% "NULL",
                        r_one$status, paste(vcr_test_issue_codes(r_one), collapse = ","),
                        r_nm$status, is.null(vcr_get_measure(r_nm, "median_survival")),
                        no_risk$status, paste(vcr_test_issue_codes(no_risk), collapse = ","),
                        no_prov$status, paste(vcr_test_issue_codes(no_prov), collapse = ",")))
})

vcr_case("N17c", c("AC-30"), function() {
  # The engine's own Cox log hazard ratio (used by the reconstruction's HR
  # check, so `survival` is not needed at run time) equals coxph with Breslow
  # ties.
  suppressMessages(library(survival))
  set.seed(1718L, kind = VCR_RNG_KIND)
  d <- rbind(cbind(vcr_sim_tte(0L, 150L, vcr_dist_exponential_from_median(10), 1, list(kind = "uniform", duration = 8), 20)[, c("time", "status")], arm = 0L),
             cbind(vcr_sim_tte(150L, 0L, vcr_dist_exponential_from_median(10), 0.7, list(kind = "uniform", duration = 8), 20)[, c("time", "status")], arm = 1L))
  ours <- vcr_cox_loghr(d$time, d$status, d$arm)
  ref <- unname(stats::coef(survival::coxph(survival::Surv(time, status) ~ arm, d, ties = "breslow")))
  list(pass = abs(ours - ref) < 1e-8, detail = sprintf("log HR %.10f vs coxph(breslow) %.10f (|d| %.1e)", ours, ref, abs(ours - ref)))
})

vcr_case("N14b", c("AC-08", "AC-30"), function() {
  # MAIC through the job, on the closed-form case of N14: one binary covariate at
  # 0.4 in the IPD and 0.6 in the aggregate trial, n = 300 -> weight ratio 2.25
  # and a Kish ESS of 257.142857. The job must report that ESS to 1e-6, count
  # the 300 rows as real patients (observed source) and NOT count the ESS as
  # more than that; an unanchored comparison is `limited`; a time-to-event
  # MAIC (which the engine does not implement) is refused by name.
  x <- c(rep(1, 120), rep(0, 180))
  set.seed(14L, kind = VCR_RNG_KIND)
  df <- data.frame(USUBJID = sprintf("S%03d", 1:300), arm = rep(c(1L, 0L), 150), x = x, y = 1 + 0.5 * x + stats::rnorm(300))
  inp <- vcr_test_input(df, "snp_n14b:subject", "subject")
  # The domain's scenario schema keeps the two routes apart: an unanchored job
  # states the aggregate OUTCOME and reads `outcomeColumn`, an anchored one the
  # aggregate ESTIMATE and reads the arm column; a key of the other route is
  # refused by path, not ignored.
  base <- list(covariates = list("x"), targets = list(x = 0.6), outcomeColumn = "y", aggregateOutcome = 1.2, aggregateSe = 0.1)
  anch_base <- list(covariates = list("x"), targets = list(x = 0.6), aggregateEstimate = 0.1, aggregateSe = 0.1, anchored = TRUE, treatmentColumn = "arm")
  r <- vcr_test_run(vcr_test_job("comparator.maic", base, list(inp), seed = 3L, replicates = 300L, job_id = "job_n14b"))
  ess <- vcr_measure_value(r, "effective_sample_size")
  anch <- vcr_test_run(vcr_test_job("comparator.maic", anch_base, list(inp), seed = 3L, replicates = 300L, job_id = "job_n14b_a"))
  tte <- vcr_test_run(vcr_test_job("comparator.maic", c(base, list(endpoint = list(type = "time_to_event"))), list(inp), seed = 3L, job_id = "job_n14b_t"))
  mixed <- vcr_test_run(vcr_test_job("comparator.maic", c(base, list(aggregateEstimate = 0.1)), list(inp), seed = 3L, replicates = 300L, job_id = "job_n14b_m"))
  ok <- identical(r$status, "succeeded") && abs(ess - 450^2 / 787.5) < 1e-6 && r$counts$realPatients == 300 &&
    r$counts$effectiveSampleSize <= r$counts$realPatients && identical(r$conclusion, "limited") &&
    identical(r$diagnostics$anchored, FALSE) &&
    identical(anch$status, "succeeded") && identical(anch$conclusion, "estimable") && identical(anch$diagnostics$anchored, TRUE) &&
    identical(tte$status, "failed") && "endpoint_not_supported" %in% vcr_test_issue_codes(tte) &&
    identical(mixed$status, "failed") && "scenario_field_unknown" %in% vcr_test_issue_codes(mixed)
  list(pass = ok,
       detail = sprintf("ESS %.9f (closed form 257.142857143); realPatients %s; unanchored conclusion %s; anchored conclusion %s; time-to-event MAIC -> %s; an unanchored job that also states the anchored key -> %s",
                        ess %||% NA_real_, r$counts$realPatients %||% NA, r$conclusion %||% NA, anch$conclusion %||% NA, paste(vcr_test_issue_codes(tte), collapse = ","),
                        paste(vcr_test_issue_codes(mixed), collapse = ",")))
})

vcr_case("N15b", c("AC-08", "AC-11"), function() {
  # The MAIC standard error accounts for the weights having been estimated. With
  # the aggregate trial's own error set to zero, the reported SE of an unanchored
  # estimate must equal the empirical SD of that estimate over repeated IPD
  # samples. The first version's fixed-weight variance ignores that the weights
  # were fitted to the same rows and is off by a factor of 2.5 (0.19 for a true
  # 0.078) here.
  set.seed(1515L, kind = VCR_RNG_KIND)
  n <- 200L; reps <- 120L
  one <- function(i) {
    x <- stats::rnorm(n); y <- 1 + 2 * x + stats::rnorm(n)
    X <- matrix(x, ncol = 1, dimnames = list(NULL, "x"))
    r <- vcr_maic_unanchored(y, X, c(x = 0.5), agd_outcome = 0, agd_se = 0, bootstrap = list(replicates = 150L, seed = 5000L + i, cores = 1L))
    r0 <- vcr_maic_unanchored(y, X, c(x = 0.5), agd_outcome = 0, agd_se = 0)
    c(est = r$estimate, se_boot = r$se, se_fixed = r0$se)
  }
  res <- do.call(rbind, vcr_map_streams(vcr_stream_bank(1515L)$take(reps), one, cores = VCR_TEST_CORES))
  emp <- stats::sd(res[, "est"])
  ratio_boot <- mean(res[, "se_boot"]) / emp; ratio_fixed <- mean(res[, "se_fixed"]) / emp
  cover <- mean(abs(res[, "est"] - 2) <= stats::qnorm(0.975) * res[, "se_boot"])
  # the empirical SD from 120 replicates carries about 6.5% error; 15% is the band
  list(pass = abs(ratio_boot - 1) < 0.15 && abs(ratio_fixed - 1) > 0.5 && cover > 0.88,
       detail = sprintf("empirical SD of the estimate %.4f; bootstrap SE %.4f (ratio %.3f, band 0.85-1.15); fixed-weight SE %.4f (ratio %.3f, would fail); 95%% interval coverage with the bootstrap SE %.3f (%d replicates)",
                        emp, mean(res[, "se_boot"]), ratio_boot, mean(res[, "se_fixed"]), ratio_fixed, cover, reps))
})
