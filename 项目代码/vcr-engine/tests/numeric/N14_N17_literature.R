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

vcr_case("N17", c("AC-03", "AC-09", "AC-27"), function() {
  # Reconstructed rows are `reconstructed`, counted in
  # `reconstructedPseudoPatients`, and never in `realPatients`. A
  # reconstruction that fails QC is `not_estimable` and emits no numbers.
  set.seed(17L, kind = VCR_RNG_KIND)
  d <- vcr_sim_tte(0L, 250L, vcr_dist_exponential_from_median(10), 1,
                   list(kind = "uniform", duration = 6), 24)
  km <- vcr_km(d$time, d$status)
  t_risk <- seq(0, 24, by = 6)
  n_risk <- vapply(t_risk, function(tt) sum(d$time >= tt), numeric(1))
  clicks <- seq(0, min(30, max(d$time)), by = 0.25)
  dig <- vcr_digitize_km(km, clicks, noise = 0)
  mk_job <- function(risk_numbers, median_reported) list(
    jobId = "job_n17", studyId = "std_n17", kind = "reconstruct_km",
    method = "evidence.reconstruct_km", methodVersion = "1.0.0", protocolVersion = 1L,
    seed = 1L, cpuSecondsLimit = 120,
    inputs = list(list(kind = "evidence", id = "ev_km@1")),
    scenario = list(curve = list(time = dig$time, surv = dig$surv),
                    riskTable = list(time = t_risk, atRisk = risk_numbers),
                    totalEvents = sum(d$status), reportedMedian = median_reported))
  good <- vcr_run_job(mk_job(n_risk, vcr_km_median(km)))
  # A reported median 40% away from the curve cannot be reconciled: QC fails.
  bad <- vcr_run_job(mk_job(n_risk, vcr_km_median(km) * 1.4))
  ok <- identical(good$status, "succeeded") &&
    identical(good$counts$realPatients, 0) &&
    good$counts$reconstructedPseudoPatients == 250 &&
    identical(good$diagnostics$valueSource, "reconstructed") &&
    identical(bad$status, "not_estimable") &&
    identical(bad$notEstimableRule, "reconstruction_failed_qc") &&
    length(bad$measures) == 0L
  list(pass = ok,
       detail = sprintf("passing QC: realPatients=%s reconstructedPseudoPatients=%s source=%s; failing QC: status=%s rule=%s measures=%d",
                        good$counts$realPatients, good$counts$reconstructedPseudoPatients,
                        good$diagnostics$valueSource, bad$status,
                        bad$notEstimableRule %||% "NULL", length(bad$measures)))
})
