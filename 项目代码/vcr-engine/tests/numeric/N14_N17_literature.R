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

vcr_case("N14c", c("AC-08", "AC-30"), function() {
  # An unanchored MAIC on a LOGIT or LOG link. `aggregateOutcome` and `aggregateSe` are the aggregate trial's outcome and its
  # standard error on the outcome's OWN scale (a proportion, a positive mean or rate): the engine applies the link to the
  # level and the delta method to the standard error, exactly as it does to the IPD mean. The first version subtracted the
  # aggregate outcome untransformed (logit(IPD rate) - 0.42) and added its SE untransformed, so the help example -- a response
  # rate of 0.42 with SE 0.05 on the logit link, IPD rate 0.532 -- came out -0.291 where the logit-scale difference is +0.451,
  # a sign flip, with an aggregate error of 0.05 where the delta method gives 0.205.
  #
  # A reference that needs no weighting code: one binary covariate x, targets 0.6. The weights make the weighted x-mean exactly 0.6,
  # so the weighted outcome mean is 0.6 * (mean in x = 1) + 0.4 * (mean in x = 0) whatever the weights are. Logit: 100 people with
  # x = 1 (62 responders), 150 with x = 0 (60 responders) -> 0.6 * 0.62 + 0.4 * 0.40 = 0.532. Log: strata means 20 and 10 -> 16.
  X <- matrix(c(rep(1, 100), rep(0, 150)), ncol = 1, dimnames = list(NULL, "x"))
  y_bin <- c(rep(c(1, 0), c(62, 38)), rep(c(1, 0), c(60, 90)))
  y_pos <- c(rep(c(18, 22), 50), rep(c(9, 11), 75))
  want_rate <- 0.6 * 0.62 + 0.4 * 0.40; want_mean <- 0.6 * 20 + 0.4 * 10
  # the variance of the weighted mean, from the weights the closed form implies: w(x = 1) / w(x = 0) = (0.6 / 0.4) / (100 / 150)
  weights <- c(rep(2.25, 100), rep(1, 150)); ww <- weights / sum(weights)
  var_of <- function(y) { mu <- sum(ww * y); sum(ww^2 * (y - mu)^2) * length(y) / (length(y) - 1) }
  # logit
  lg <- vcr_maic_unanchored(y_bin, X, c(x = 0.6), agd_outcome = 0.42, agd_se = 0.05, link = "logit")
  want_lg <- stats::qlogis(want_rate) - stats::qlogis(0.42)
  se_lg <- sqrt(var_of(y_bin) / (want_rate * (1 - want_rate))^2 + (0.05 / (0.42 * 0.58))^2)
  # log
  lo <- vcr_maic_unanchored(y_pos, X, c(x = 0.6), agd_outcome = 12, agd_se = 1.5, link = "log")
  want_lo <- log(want_mean) - log(12)
  se_lo <- sqrt(var_of(y_pos) / want_mean^2 + (1.5 / 12)^2)
  # identity: not touched
  id <- vcr_maic_unanchored(y_pos, X, c(x = 0.6), agd_outcome = 12, agd_se = 1.5)
  se_id <- sqrt(var_of(y_pos) + 1.5^2)
  # through the job, which is what the help example describes
  df <- data.frame(USUBJID = sprintf("S%03d", 1:250), x = as.vector(X), response = y_bin)
  inp <- vcr_test_input(df, "snp_n14c:subject", "subject")
  job <- vcr_test_run(vcr_test_job("comparator.maic", list(covariates = list("x"), targets = list(x = 0.6), endpoint = list(type = "binary"),
                                                           aggregateOutcome = 0.42, aggregateSe = 0.05, link = "logit", outcomeColumn = "response"),
                                   list(inp), seed = 3L, replicates = 300L, job_id = "job_n14c"))
  est_job <- vcr_measure_value(job, "indirect_estimate"); se_job <- job$diagnostics$se
  # the old arithmetic, for the size of the error
  old <- stats::qlogis(want_rate) - 0.42
  ok <- abs(lg$estimate - want_lg) < 1e-9 && abs(lg$se - se_lg) < 1e-9 && abs(lo$estimate - want_lo) < 1e-9 && abs(lo$se - se_lo) < 1e-9 &&
    abs(id$estimate - (want_mean - 12)) < 1e-9 && abs(id$se - se_id) < 1e-9 &&
    identical(job$status, "succeeded") && abs(est_job - want_lg) < 1e-9 && se_job > 0.205
  list(pass = ok,
       detail = sprintf("logit, rate 0.532 against 0.42 (SE 0.05): estimate %.6f (want qlogis(0.532) - qlogis(0.42) = %.6f; the untransformed subtraction gave %.3f), SE %.6f (want %.6f; aggregate part %.4f, not 0.05); log, mean 16 against 12 (SE 1.5): %.6f (want %.6f), SE %.6f (want %.6f); identity unchanged: %.6f, SE %.6f; the job: estimate %.6f, SE %.4f",
                        lg$estimate, want_lg, old, lg$se, se_lg, 0.05 / (0.42 * 0.58), lo$estimate, want_lo, lo$se, se_lo, id$estimate, id$se, est_job %||% NA_real_, se_job %||% NA_real_))
})

vcr_case("N14d", c("AC-04", "AC-26"), function() {
  # The aggregate outcome has to be inside the link's domain, because the link is applied to it: a proportion strictly between 0
  # and 1 for the logit link, a positive mean or rate for the log link. Anything else is refused by name -- by the validator
  # (the domain's and the engine's agree, N00f) and, as the second line, by the function that applies the link -- rather than
  # becoming a NaN or an infinite estimate. The identity link takes any number, and an anchored job states a contrast, not a level.
  sc <- function(outcome, link = NULL) {
    out <- list(covariates = list("x"), targets = list(x = 0.6), endpoint = list(type = "binary"), aggregateOutcome = outcome, aggregateSe = 0.05)
    if (!is.null(link)) out$link <- link     # (a NULL element would be written as `null`, which is not a value)
    out
  }
  issues <- function(scenario) vapply(vcr_validate_scenario("comparator.maic", vcr_test_json(scenario)), function(i) paste0(i$code, "@", i$field), character(1))
  want <- "scenario_value_invalid@scenario.aggregateOutcome"
  refused <- list(logit_above = issues(sc(1.2, "logit")), logit_one = issues(sc(1, "logit")), logit_zero = issues(sc(0, "logit")), logit_negative = issues(sc(-0.3, "logit")),
                  log_zero = issues(sc(0, "log")), log_negative = issues(sc(-2, "log")))
  fine <- list(logit = issues(sc(0.42, "logit")), log = issues(sc(12, "log")), identity_negative = issues(sc(-3.5, "identity")), identity_default = issues(sc(0)))
  X <- matrix(c(rep(1, 100), rep(0, 150)), ncol = 1, dimnames = list(NULL, "x"))
  y <- c(rep(c(1, 0), c(62, 38)), rep(c(1, 0), c(60, 90)))
  second <- function(outcome, link) tryCatch({ vcr_maic_unanchored(y, X, c(x = 0.6), outcome, 0.05, link); "ran" }, vcr_refusal = function(e) paste0(e$issue$code, "@", e$issue$field))
  direct <- c(second(1.2, "logit"), second(0, "log"), second(0.42, "logit"))
  # through the job: refused before the handler
  df <- data.frame(USUBJID = sprintf("S%03d", 1:250), x = as.vector(X), response = y)
  inp <- vcr_test_input(df, "snp_n14d:subject", "subject")
  job <- vcr_test_run(vcr_test_job("comparator.maic", c(sc(1.2, "logit"), list(outcomeColumn = "response")), list(inp), seed = 3L, replicates = 300L, job_id = "job_n14d"))
  ok <- all(vapply(refused, function(v) identical(v, want), logical(1))) && all(vapply(fine, length, integer(1)) == 0L) &&
    identical(direct, c(want, want, "ran")) && identical(job$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(job)
  list(pass = ok,
       detail = sprintf("refused as %s: %s; accepted: %s; the function applying the link: %s; the job with a logit-link outcome of 1.2 -> %s (%s)",
                        want, paste(names(refused), collapse = ", "), paste(names(fine), collapse = ", "), paste(direct, collapse = " / "), job$status, paste(vcr_test_issue_codes(job), collapse = ",")))
})

vcr_case("N14e", c("AC-08", "AC-30"), function() {
  # What the MAIC weights are worth is in the result. The handler reported an estimate from any weights it was given and said nothing
  # of their quality: a Kish effective sample size of 3.6 patients (the domain's floor is 10) came back as "estimable", and weights
  # the solver stopped short of (their weighted means are not the targets) came back with no sign of it. It is a notice, not a
  # refusal -- the estimate stands -- so the result carries the effective sample size, the floor, whether the solver converged and
  # how far it was from the targets, and the conclusion is `limited` by a named reason. A target outside the covariates' range (no
  # weights at all) stays not-estimable. The weights are checked against an independent solution of the same moment equation.
  set.seed(1414L, kind = VCR_RNG_KIND)
  n <- 60L
  x <- stats::rnorm(n); y <- 0.5 * x + stats::rnorm(n); arm <- rep(c(1L, 0L), n / 2L)
  # (a) one covariate, a target near the top of the sample: converged, but a handful of patients carry the weight. Reference: solve
  # sum(x e^(l x)) / sum(e^(l x)) = target for l, then ESS = (sum w)^2 / sum w^2 -- no code of the engine.
  tg <- mean(x) + 0.85 * (max(x) - mean(x))
  lambda <- stats::uniroot(function(l) { w <- exp(l * (x - max(x))); sum(w * x) / sum(w) - tg }, c(0, 200), tol = 1e-13)$root
  w_ref <- exp(lambda * (x - max(x)))
  ess_ref <- sum(w_ref)^2 / sum(w_ref^2)
  mean_ref <- stats::weighted.mean(y, w_ref)
  df <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), arm = arm, x = x, y = y)
  inp <- vcr_test_input(df, "snp_n14e:subject", "subject")
  anch_sc <- list(covariates = list("x"), targets = list(x = tg), aggregateEstimate = 0.1, aggregateSe = 0.1, anchored = TRUE, treatmentColumn = "arm")
  una_sc <- list(covariates = list("x"), targets = list(x = tg), outcomeColumn = "y", aggregateOutcome = 0.2, aggregateSe = 0.1)
  a <- vcr_test_run(vcr_test_job("comparator.maic", anch_sc, list(inp), seed = 3L, replicates = 200L, job_id = "job_n14e_a"))
  u <- vcr_test_run(vcr_test_job("comparator.maic", una_sc, list(inp), seed = 3L, replicates = 200L, job_id = "job_n14e_u"))
  ess_job <- vcr_measure_value(a, "effective_sample_size"); wd <- a$diagnostics$weights
  limited_names <- function(r) unlist(r$diagnostics$limitedBy)
  ok_a <- ess_ref < 10 && identical(a$status, "succeeded") && abs(ess_job - ess_ref) / ess_ref < 1e-6 && identical(a$conclusion, "limited") &&
    "effective_sample_size_below_floor" %in% limited_names(a) && !("entropy_balance_not_converged" %in% limited_names(a)) &&
    abs(wd$effectiveSampleSize - ess_ref) / ess_ref < 1e-6 && isTRUE(wd$belowEssFloor) && wd$essFloor == 10 && isTRUE(wd$converged) &&
    abs(wd$essShare - ess_ref / n) < 1e-6 && wd$worstRelativeDiscrepancy < 1e-8 &&
    identical(u$status, "succeeded") && abs(vcr_measure_value(u, "indirect_estimate") - (mean_ref - 0.2)) < 1e-8 &&
    "effective_sample_size_below_floor" %in% limited_names(u)
  # (b) two covariates whose targets are each inside their column's range and jointly outside the rows' convex hull (every row has
  # x1 + x2 <= 1, the target 0.8 + 0.8 does not): no weights can reach it, the solver stops, and the weights it holds are not balanced
  X2 <- data.frame(x1 = c(rep(0, 20), rep(1, 20), rep(0, 20)), x2 = c(rep(0, 20), rep(0, 20), rep(1, 20)))
  df2 <- data.frame(USUBJID = sprintf("T%03d", seq_len(n)), arm = arm, X2, y = y)
  inp2 <- vcr_test_input(df2, "snp_n14e2:subject", "subject")
  b <- vcr_test_run(vcr_test_job("comparator.maic", list(covariates = list("x1", "x2"), targets = list(x1 = 0.8, x2 = 0.8), aggregateEstimate = 0.1, aggregateSe = 0.1,
                                                          anchored = TRUE, treatmentColumn = "arm"), list(inp2), seed = 3L, replicates = 200L, job_id = "job_n14e_b"))
  wb <- b$diagnostics$weights
  ok_b <- identical(b$status, "succeeded") && is.finite(vcr_measure_value(b, "indirect_estimate")) && identical(b$conclusion, "limited") &&
    "entropy_balance_not_converged" %in% limited_names(b) && identical(wb$converged, FALSE) && wb$worstRelativeDiscrepancy > 0.1
  # (c) a target outside a column's range: no weights at all, the one refusal
  far <- vcr_test_run(vcr_test_job("comparator.maic", list(covariates = list("x"), targets = list(x = max(x) + 1), aggregateEstimate = 0.1, aggregateSe = 0.1,
                                                            anchored = TRUE, treatmentColumn = "arm"), list(inp), seed = 3L, replicates = 200L, job_id = "job_n14e_c"))
  ok_c <- identical(far$status, "not_estimable") && identical(far$notEstimableRule, "entropy_balance_infeasible") && length(far$measures) == 0L
  # (d) a target the sample reaches easily: converged, a large effective sample size, nothing limits the anchored conclusion
  fine <- vcr_test_run(vcr_test_job("comparator.maic", c(anch_sc[-2], list(targets = list(x = mean(x) + 0.1))), list(inp), seed = 3L, replicates = 200L, job_id = "job_n14e_d"))
  ok_d <- identical(fine$status, "succeeded") && identical(fine$conclusion, "estimable") && length(fine$diagnostics$limitedBy) == 0L &&
    isTRUE(fine$diagnostics$weights$converged) && !isTRUE(fine$diagnostics$weights$belowEssFloor) && fine$diagnostics$weights$effectiveSampleSize > 40
  list(pass = ok_a && ok_b && ok_c && ok_d,
       detail = sprintf("target %.3f of a sample ranging to %.3f: ESS %.4f (independent solution %.4f), floor 10, converged %s, anchored conclusion %s limited by %s, unanchored estimate %.6f (independent %.6f); a target outside the hull of two covariates: converged %s, worst relative discrepancy %.3f, estimate kept, conclusion %s limited by %s; a target outside the range: %s / %s; an easy target: ESS %.2f, conclusion %s",
                        tg, max(x), ess_job %||% NA_real_, ess_ref, wd$converged %||% NA, a$conclusion %||% NA, paste(limited_names(a), collapse = "+"),
                        vcr_measure_value(u, "indirect_estimate") %||% NA_real_, mean_ref - 0.2,
                        wb$converged %||% NA, wb$worstRelativeDiscrepancy %||% NA_real_, b$conclusion %||% NA, paste(limited_names(b), collapse = "+"),
                        far$status, far$notEstimableRule %||% "", fine$diagnostics$weights$effectiveSampleSize %||% NA_real_, fine$conclusion %||% NA))
})

vcr_case("N14f", c("AC-04", "AC-08", "AC-30"), function() {
  # The two keys of a MAIC that were accepted and not honoured. (1) An ANCHORED job could not name its outcome column: the domain
  # gated `outcomeColumn` to the unanchored route and refused it for an anchored one (scenario_field_unknown), although the anchored
  # contrast is the difference of the arms' weighted means of an outcome, so the anchored MAIC could only ever read a column called
  # `y`. (2) An UNANCHORED job that named `treatmentColumn` had it ignored, so a table holding both arms of the IPD trial was pooled
  # into one "active arm". Now the rows of arm 1 are the active arm; a column the table cannot honour is reported in
  # diagnostics.notApplied with the reason, the job goes on with every row, and nothing is refused.
  set.seed(1415L, kind = VCR_RNG_KIND)
  n1 <- 80L; n0 <- 80L
  x <- c(stats::rnorm(n1, 0.4, 1), stats::rnorm(n0, -0.6, 1)); arm <- c(rep(1L, n1), rep(0L, n0))
  y <- c(1 + 0.8 * x[seq_len(n1)] + stats::rnorm(n1, 0, 0.5), -0.5 + 0.8 * x[n1 + seq_len(n0)] + stats::rnorm(n0, 0, 0.5))
  tg <- 0.1
  # (1) the anchored job names its outcome column; the same data under the default name `y` is the same job
  df_y <- data.frame(USUBJID = sprintf("S%03d", seq_along(x)), arm = arm, x = x, y = y)
  df_r <- data.frame(USUBJID = sprintf("S%03d", seq_along(x)), arm = arm, x = x, response = y)
  anch <- list(covariates = list("x"), targets = list(x = tg), aggregateEstimate = 0.1, aggregateSe = 0.1, anchored = TRUE, treatmentColumn = "arm")
  run <- function(df, sc, tag) vcr_test_run(vcr_test_job("comparator.maic", sc, list(vcr_test_input(df, paste0("snp_n14f_", tag, ":subject"), "subject")), seed = 3L, replicates = 200L, job_id = paste0("job_n14f_", tag)))
  a_y <- run(df_y, anch, "ay"); a_r <- run(df_r, c(anch, list(outcomeColumn = "response")), "ar")
  est_a <- vcr_measure_value(a_r, "indirect_estimate")
  # reference: the arms' means weighted by exp(l x) with l solving the moment equation, and the contrast against the aggregate's
  solve_l <- function(xs, target) stats::uniroot(function(l) { w <- exp(l * (xs - max(xs))); sum(w * xs) / sum(w) - target }, c(-50, 50), tol = 1e-13)$root
  l_all <- solve_l(x, tg); w_all <- exp(l_all * (x - max(x)))
  ref_anch <- stats::weighted.mean(y[arm == 1], w_all[arm == 1]) - stats::weighted.mean(y[arm == 0], w_all[arm == 0]) - 0.1
  ok_1 <- identical(a_y$status, "succeeded") && identical(a_r$status, "succeeded") && identical(est_a, vcr_measure_value(a_y, "indirect_estimate")) && abs(est_a - ref_anch) < 1e-8
  # (2) an unanchored job on the both-arms table, naming the arm column: the active arm only
  una <- list(covariates = list("x"), targets = list(x = tg), outcomeColumn = "y", aggregateOutcome = 0.5, aggregateSe = 0.1)
  sel <- run(df_y, c(una, list(treatmentColumn = "arm")), "sel"); pooled <- run(df_y, una, "pool")
  xs <- x[arm == 1]; l1 <- solve_l(xs, tg); w1 <- exp(l1 * (xs - max(xs)))
  ref_sel <- stats::weighted.mean(y[arm == 1], w1) - 0.5
  ref_pool <- stats::weighted.mean(y, w_all) - 0.5
  ts <- sel$diagnostics$treatmentArm
  ok_2 <- identical(sel$status, "succeeded") && abs(vcr_measure_value(sel, "indirect_estimate") - ref_sel) < 1e-8 && sel$counts$realPatients == n1 &&
    identical(ts$column, "arm") && ts$rowsUsed == n1 && ts$rowsOtherArm == n0 && is.null(sel$diagnostics$notApplied) &&
    abs(vcr_measure_value(pooled, "indirect_estimate") - ref_pool) < 1e-8 && abs(ref_sel - ref_pool) > 0.3 && pooled$counts$realPatients == n1 + n0 && is.null(pooled$diagnostics$treatmentArm)
  # (3) a column the table cannot honour: named in notApplied with the reason, every row used, no refusal
  df_site <- cbind(df_y, site = rep(c("a", "b", "c", "d"), length.out = length(x)))
  bad_site <- run(df_site, c(una, list(treatmentColumn = "site")), "site")
  gone <- run(df_y, c(una, list(treatmentColumn = "no_such_column")), "gone")
  no_active <- run(transform(df_y, arm = 0L), c(una, list(treatmentColumn = "arm")), "noactive")
  na_of <- function(r) { v <- r$diagnostics$notApplied; if (length(v) == 1L) c(v[[1]]$key, v[[1]]$field, v[[1]]$reason) else character(0) }
  ok_3 <- all(vapply(list(bad_site, gone, no_active), function(r) identical(r$status, "succeeded") && abs(vcr_measure_value(r, "indirect_estimate") - ref_pool) < 1e-8 && r$counts$realPatients == n1 + n0, logical(1))) &&
    identical(na_of(bad_site)[1:2], c("treatmentColumn", "scenario.treatmentColumn")) && grepl("1/0", na_of(bad_site)[3], fixed = TRUE) &&
    grepl("not in the table", na_of(gone)[3], fixed = TRUE) && grepl("no row is in arm 1", na_of(no_active)[3], fixed = TRUE)
  list(pass = ok_1 && ok_2 && ok_3,
       detail = sprintf("anchored, outcome column named `response`: estimate %.8f, equal to the default-named job (%s) and to the independent weighted contrast %.8f; unanchored on a table of both arms (%d + %d), treatmentColumn named: estimate %.8f (independent %.8f, active arm only; pooling both arms would give %.8f), realPatients %s; a 4-level column, a missing column, an all-control column: notApplied '%s' / '%s' / '%s', estimate on every row %.8f",
                        est_a, identical(est_a, vcr_measure_value(a_y, "indirect_estimate")), ref_anch, n1, n0, vcr_measure_value(sel, "indirect_estimate"), ref_sel, ref_pool, sel$counts$realPatients,
                        na_of(bad_site)[3], na_of(gone)[3], na_of(no_active)[3], vcr_measure_value(bad_site, "indirect_estimate")))
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
