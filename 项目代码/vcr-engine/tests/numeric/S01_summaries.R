# S01 — the summaries a page draws its charts from (R/summaries.R).
#
# The control plane's presenter reads a chart from `diagnostics.{curves,
# trajectories, powerCurve, sensitivity, panels}` and from nowhere else, so a
# handler that a page charts has to write those, small and true. These cases
# hold each summary to the numbers it summarises: a curve to the Kaplan-Meier
# estimate of the rows it came from, a power curve to the closed-form power at its
# own points (the null point to alpha), a thinned series to its bound with its
# first and last point kept, and a reconstructed curve to the label that keeps it
# from being read as an observed one.

.s01_points_ok <- function(series, max = 200L) {
  all(vapply(series, function(s) {
    length(s$points) >= 1L && length(s$points) <= max &&
      all(vapply(s$points, function(p) is.finite(p$x) && is.finite(p$y), logical(1))) &&
      nzchar(s$key) && nzchar(s$label) && s$source %in% vcr_domain()$valueSources
  }, logical(1)))
}

vcr_case("S01a", c("AC-28", "AC-11"), function() {
  # A Kaplan-Meier series is the estimate of its own rows, bounded, with its ends kept.
  set.seed(101L, kind = VCR_RNG_KIND)
  d <- vcr_sim_tte(3000L, 3000L, vcr_dist_exponential_from_median(12), 0.7, list(kind = "uniform", duration = 12), 24)
  s <- vcr_km_series(d$time[d$arm == 0L], d$status[d$arm == 0L], NULL, "control", "对照组", "observed")
  km <- vcr_km(d$time[d$arm == 0L], d$status[d$arm == 0L])
  first <- s$points[[1]]; last <- s$points[[length(s$points)]]
  ys <- vapply(s$points, function(p) p$y, numeric(1)); xs <- vapply(s$points, function(p) p$x, numeric(1))
  cut <- vcr_km_series(d$time[d$arm == 0L], d$status[d$arm == 0L], NULL, "control", "对照组", "observed", tau = 12)
  last_cut <- cut$points[[length(cut$points)]]
  wsum <- vcr_km_series(d$time[d$arm == 0L], d$status[d$arm == 0L], rep(2, sum(d$arm == 0L)), "w", "加权", "calculated")
  ok <- length(km$time) > 200L && length(s$points) <= 200L &&
    first$x == 0 && first$y == 1 && abs(last$x - max(km$time)) < 1e-9 && abs(last$y - tail(km$surv, 1)) < 1e-12 &&
    all(diff(ys) <= 1e-12) && all(diff(xs) > 0) &&
    last_cut$x == 12 && abs(last_cut$y - vcr_km_at(km, 12)) < 1e-12 &&
    length(s$atRisk) == 6L && s$atRisk[[1]]$n == sum(d$arm == 0L) &&
    # doubling every weight changes nothing about the estimate, only the numbers at risk
    abs(tail(wsum$points, 1)[[1]]$y - tail(s$points, 1)[[1]]$y) < 1e-12 && wsum$atRisk[[1]]$n == 2 * sum(d$arm == 0L)
  list(pass = ok, detail = sprintf("%d event times thinned to %d points (first %g/%g, last %.4f/%.4f = the estimate at %.3f); cut at tau=12 ends at S=%.6f (KM %.6f); numbers at risk %g -> %g at time 0; doubled weights leave the curve unchanged",
                                   length(km$time), length(s$points), first$x, first$y, last$x, last$y, max(km$time), last_cut$y, vcr_km_at(km, 12),
                                   s$atRisk[[1]]$n, wsum$atRisk[[1]]$n))
})

vcr_case("S01b", c("AC-09", "AC-11"), function() {
  # Virtual patients: the arms' survival curves, a panel of their numbers, and the
  # closed-form sensitivity — every one of them labelled synthetic.
  r <- vcr_test_run(vcr_test_job("patients.time_to_event", list(
    design = list(nTreat = 400, nControl = 400), endpoint = list(type = "time_to_event"),
    truth = list(controlMedian = 6, hazardRatio = 0.7), accrual = list(kind = "uniform", duration = 12, followup = 12)),
    seed = 5L, job_id = "job_s01b"))
  tj <- r$diagnostics$trajectories; panel <- r$diagnostics$panels[[1]]; sens <- r$diagnostics$sensitivity
  labels <- vapply(panel$rows, function(x) x$label, character(1))
  med_t <- panel$rows[[which(labels == "试验组中位生存")]]$value$value
  med_c <- panel$rows[[which(labels == "对照组中位生存")]]$value$value
  gap <- sens$rows[[1]]
  b <- vcr_test_run(vcr_test_job("patients.binary", list(
    design = list(nTreat = 300, nControl = 300), endpoint = list(type = "binary"), truth = list(controlRate = 0.3, treatmentRate = 0.45)),
    seed = 6L, job_id = "job_s01b_b"))
  bp <- b$diagnostics$panels[[1]]$rows
  ok <- identical(r$status, "succeeded") && length(tj$series) == 2L && .s01_points_ok(tj$series) &&
    all(vapply(tj$series, function(s) identical(s$source, "synthetic"), logical(1))) &&
    med_t > med_c && abs(sens$base$value - (6 / 0.7 - 6)) < 1e-9 &&
    gap$low < sens$base$value && gap$high > sens$base$value &&
    identical(b$status, "succeeded") && abs(bp[[1]]$value$value - 45) < 6 && abs(bp[[2]]$value$value - 30) < 6 && is.null(b$diagnostics$trajectories)
  list(pass = ok, detail = sprintf("time-to-event set: two synthetic curves (%d / %d points), medians %.2f vs %.2f (stated 6 vs 8.57), sensitivity base %.3f = 6/0.7 - 6 with the control median at 80-120%% giving %.2f..%.2f; binary set: %.1f%% vs %.1f%% (stated 45 vs 30), no trajectories",
                                   length(tj$series[[1]]$points), length(tj$series[[2]]$points), med_t, med_c, sens$base$value, gap$low, gap$high, bp[[1]]$value$value, bp[[2]]$value$value))
})

vcr_case("S01c", c("AC-29", "AC-28"), function() {
  # The analytic power curve passes through the null at alpha and through the stated design at its power;
  # the simulated point sits beside it with its Monte-Carlo band.
  an <- vcr_test_run(vcr_test_job("design.analytic", list(
    design = list(kind = "two_arm_fixed"), endpoint = list(type = "binary"), truth = list(controlRate = 0.3, treatmentRate = 0.45),
    analysis = list(alpha = 0.025, power = 0.9, sided = 1)), seed = 7L, job_id = "job_s01c"))
  pc <- an$diagnostics$powerCurve$series[[1]]
  xs <- vapply(pc$points, function(p) p$x, numeric(1)); ys <- vapply(pc$points, function(p) p$y, numeric(1))
  n_total <- vcr_measure_value(an, "required_total")
  at_null <- ys[which.min(abs(xs - 0.3))]; at_design <- ys[which.min(abs(xs - 0.45))]
  want_design <- vcr_power_proportions(0.3, 0.45, ceiling(n_total * 0.5), ceiling(n_total * 0.5), 0.025, 1)
  sens <- an$diagnostics$sensitivity$rows[[1]]
  tte <- vcr_test_run(vcr_test_job("design.analytic", list(
    design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 6),
    analysis = list(alpha = 0.025, power = 0.9, sided = 1), accrual = list(duration = 12, followup = 12)), seed = 7L, job_id = "job_s01c_t"))
  tp <- tte$diagnostics$powerCurve$series[[1]]
  txs <- vapply(tp$points, function(p) p$x, numeric(1)); tys <- vapply(tp$points, function(p) p$y, numeric(1))
  sim <- vcr_test_run(vcr_test_job("design.simulate", list(
    design = list(kind = "two_arm_fixed", nTreat = 150, nControl = 150), endpoint = list(type = "binary"),
    truth = list(controlRate = 0.3, treatmentRate = 0.45), analysis = list(method = "risk_difference", alpha = 0.025, sided = 1),
    performance = list("power")), seed = 8L, replicates = 5000L, cores = VCR_TEST_CORES, job_id = "job_s01c_s"))
  ss <- Filter(function(s) identical(s$key, "simulated"), sim$diagnostics$powerCurve$series)[[1]]
  sp <- ss$points[[1]]; power <- vcr_measure_value(sim, "power"); mcse <- vcr_get_measure(sim, "power")$mcse
  ok <- abs(at_null - 0.025) < 5e-3 && abs(at_design - want_design) < 1e-9 && at_design >= 0.9 - 1e-9 &&
    length(pc$points) == 17L && all(diff(ys) >= -1e-12) &&
    sens$low < n_total && sens$high > n_total &&
    abs(tys[which.min(abs(txs - 1))] - 0.025) < 1e-9 && tys[which.min(abs(txs - 0.7))] >= 0.9 - 0.02 && all(diff(tys) >= -1e-9) &&
    abs(sp$x - 0.45) < 1e-12 && abs(sp$y - power) < 1e-12 && identical(ss$bandKind, "monte_carlo") && abs(sp$high - sp$low - 2 * 1.96 * mcse) < 1e-9
  list(pass = ok, detail = sprintf("binary design n=%g: curve %g at the null (alpha .025), %.4f at the design (closed form %.4f, target .9), sample size %g at the effect off by a fifth either way in [%g, %g]; time-to-event curve %.4f at HR 1 and %.4f at HR 0.7; simulated point %.4f +- %.4f at 0.45, band 95%% Monte-Carlo",
                                   n_total, at_null, at_design, want_design, n_total, sens$low, sens$high,
                                   tys[which.min(abs(txs - 1))], tys[which.min(abs(txs - 0.7))], sp$y, mcse))
})

vcr_case("S01d", c("AC-27", "AC-08", "AC-07"), function() {
  # A comparison on pseudo-patients: the curves say reconstructed, the count says pseudo-patients and never real
  # ones, and a table another job wrote (time and status beside the arm) is read as it is. A weighted comparison
  # draws its control arm twice, as collected and as weighted.
  set.seed(102L, kind = VCR_RNG_KIND)
  dt <- vcr_sim_tte(200L, 0L, vcr_dist_exponential_from_median(12), 0.6, list(kind = "uniform", duration = 12), 30)
  dc <- vcr_sim_tte(0L, 200L, vcr_dist_exponential_from_median(12), 1, list(kind = "uniform", duration = 12), 30)
  pseudo <- rbind(dt[, c("time", "status", "arm")], dc[, c("time", "status", "arm")])
  inp <- vcr_test_input(pseudo, "res_s01d:reconstructed-ipd", source = "reconstructed")
  r <- vcr_test_run(vcr_test_job("comparator.rmst", list(tau = 18), list(inp), seed = 9L, job_id = "job_s01d"))
  cv <- r$diagnostics$curves
  ref <- vcr_rmst_difference(pseudo$time, pseudo$status, pseudo$arm, 18)
  refused <- vcr_test_run(vcr_test_job("comparator.rmst", list(tau = 18), list(vcr_test_input(pseudo, "res_s01d:observed-as-reconstructed", source = "aggregate")),
                                        seed = 9L, job_id = "job_s01d_r"))
  n <- 400L; x <- rnorm(n); arm <- rep(c(1L, 0L), each = n / 2)
  subj <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), arm = arm, x = x)
  ev <- data.frame(USUBJID = subj$USUBJID, PARAMCD = "OS", AVAL = stats::rexp(n, log(2) / 12 * exp(0.1 * x)), CNSR = 0L)
  ev$CNSR <- as.integer(ev$AVAL > 30); ev$AVAL <- pmin(ev$AVAL, 30)
  w <- vcr_test_run(vcr_test_job("comparator.entropy_balance", list(covariates = list("x"), tau = 12, endpoint = list(type = "time_to_event")),
                                 list(vcr_test_input(subj, "snp_s01d:subject", "subject"), vcr_test_input(ev, "snp_s01d:event", "event")),
                                 seed = 9L, replicates = 2000L, job_id = "job_s01d_w"))
  wc <- w$diagnostics$curves
  ok <- identical(r$status, "succeeded") && length(cv) == 2L && .s01_points_ok(cv) &&
    all(vapply(cv, function(s) identical(s$source, "reconstructed"), logical(1))) &&
    abs(vcr_measure_value(r, "rmst_difference") - ref$estimate) < 1e-12 &&
    identical(r$counts$realPatients, 0) && r$counts$reconstructedPseudoPatients == 400 && r$counts$events == sum(pseudo$status) &&
    identical(refused$status, "failed") && "input_source_not_individual" %in% vcr_test_issue_codes(refused) &&
    identical(w$status, "succeeded") && length(wc) == 3L && .s01_points_ok(wc) &&
    identical(vapply(wc, function(s) s$key, character(1)), c("treated", "control", "control_weighted")) &&
    identical(wc[[3]]$source, "calculated") && identical(wc[[1]]$source, "observed") && identical(w$diagnostics$tau, 12)
  list(pass = ok, detail = sprintf("RMST(18) on 400 pseudo-patients %.4f = the direct computation %.4f; curves %s; counts real %s / pseudo-patients %s; the same table labelled aggregate -> %s; weighted comparison draws %s",
                                   vcr_measure_value(r, "rmst_difference"), ref$estimate, paste(vapply(cv, function(s) s$source, character(1)), collapse = "+"),
                                   r$counts$realPatients, r$counts$reconstructedPseudoPatients, paste(vcr_test_issue_codes(refused), collapse = ","),
                                   paste(vapply(wc, function(s) paste0(s$key, "(", s$source, ")"), character(1)), collapse = ", ")))
})

vcr_case("S01e", c("AC-04", "AC-29"), function() {
  # A reconstruction draws the published curve and its rebuilt pseudo-patients side by side, and a grid carries its cells' numbers.
  set.seed(103L, kind = VCR_RNG_KIND)
  d <- vcr_sim_tte(0L, 250L, vcr_dist_exponential_from_median(12), 1, list(kind = "uniform", duration = 6), 24)
  t_risk <- seq(0, 24, by = 6)
  arm <- .n17_arm(d, t_risk, 30, noise = 0.004)
  rec <- vcr_test_run(vcr_test_job("evidence.reconstruct_km", c(arm, list(provenance = .n17_prov)), list(list(kind = "evidence", id = "ev_km@1")),
                                   seed = 1L, job_id = "job_s01e"))
  cv <- rec$diagnostics$curves
  grid <- vcr_test_run(vcr_test_job("design.grid", list(
    design = list(kind = "two_arm_fixed", nTreat = 100, nControl = 100), endpoint = list(type = "binary"),
    truth = list(controlRate = 0.3, treatmentRate = 0.45), analysis = list(method = "risk_difference", alpha = 0.025, sided = 1),
    performance = list("power"),
    designs = list(list(kind = "two_arm_fixed", nTreat = 100, nControl = 100), list(kind = "two_arm_fixed", nTreat = 200, nControl = 200)),
    truths = list(list(controlRate = 0.3, treatmentRate = 0.3), list(controlRate = 0.3, treatmentRate = 0.45))),
    seed = 10L, replicates = 5000L, cores = VCR_TEST_CORES, job_id = "job_s01e_g"))
  cells <- grid$diagnostics$cells
  powers <- vapply(cells, function(c_) { m <- Filter(function(x) x$name %in% c("power", "type_one_error"), c_$measures); m[[1]]$value }, numeric(1))
  ok <- identical(rec$status, "succeeded") && length(cv) == 2L && .s01_points_ok(cv) &&
    identical(cv[[1]]$source, "extracted") && identical(cv[[2]]$source, "reconstructed") && isTRUE(cv[[1]]$dashed) &&
    length(cv[[1]]$atRisk) == length(t_risk) &&
    identical(grid$status, "succeeded") && length(cells) == 4L &&
    all(vapply(cells, function(c_) length(c_$measures) >= 1L && !is.null(c_$measures[[1]]$mcse), logical(1))) &&
    powers[4] > powers[2] && all(abs(powers[c(1, 3)] - 0.025) < 0.01)
  list(pass = ok, detail = sprintf("reconstruction: %s; grid of 4 cells each carrying its measures: type I error %.4f / %.4f under the null, power %.3f with 200 per arm and %.3f with 100 per arm",
                                   paste(vapply(cv, function(s) paste0(s$key, "(", s$source, ", ", length(s$points), " points)"), character(1)), collapse = ", "),
                                   powers[1], powers[3], powers[4], powers[2]))
})
