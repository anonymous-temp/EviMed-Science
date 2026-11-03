# N90 — group-sequential MaxCombo and modestly weighted designs (algorithm round T14, 2026-11-03): design.simulate and design.grid 1.5.0.
#
# "延迟效应下不能中途看数据": until 1.4.0 a group-sequential design looked with the log-rank statistic only. Now a design with looks may analyse by MaxCombo
# or the modestly weighted test, with boundaries found by simulating the design under no effect and spending the planned alpha look by look. Held to:
#
#   a  the boundary machinery against a closed form: with the weight cap at 1 the modestly weighted statistic IS the log-rank statistic, whose group-sequential
#      boundaries the engine also computes analytically (Lan-DeMets, checked against gsDesign and rpact); the simulated boundaries equal them within the
#      sampling error of a quantile, the realized spend equals the planned spend look by look, and a look whose planned spend is below one trial cannot stop
#   b  the type I error of MaxCombo at three looks, run apart from the boundary run with another seed, is the level within the combined error; one and
#      two cores give the same bits; a spent budget leaves fewer null trials and says limited; no budget for 2,000 null trials is a named refusal
#   c  gsDesign2::gs_power_combo: the cumulative probability of having stopped at each look of a delayed-effect design (its calendar looks put on the
#      engine's event fractions), against the simulation with boundaries found under the null
#
# (the boundary run is the cost: 20,000 trials of the design at the job's defaults; the cases use fewer and say so)

.n90_scenario <- function(n = 60, method = "modestly_weighted", rates = c(0.5, 1), ratios = c(1, 1), at = 4, s_star = NULL, alpha = 0.025, sided = 1, followup = 24) {
  an <- list(method = method, alpha = alpha, sided = sided)
  if (!is.null(s_star)) an$sStar <- s_star
  list(design = list(kind = "group_sequential", nTreat = n, nControl = n, informationRates = as.list(rates), spending = "obrien_fleming"), endpoint = list(type = "time_to_event"),
       truth = list(treatmentHazardRatios = list(breaks = list(at), ratios = as.list(ratios)), controlMedian = 12),
       accrual = list(kind = "uniform", duration = 12, followup = followup, dropoutAnnual = 0.05), analysis = an)
}
.n90_null <- function(sc) { sc$truth <- list(hazardRatio = 1, controlMedian = 12); sc }
# R trials of a scenario, one stream each, as the engine runs them but with the count asked for (a job's null floor is 20,000 trials)
.n90_trials <- function(sc, seed, R, extras = list()) {
  runner <- vcr_scenario_runner(sc, extras)
  out <- vcr_map_streams(vcr_stream_bank(seed)$take(R), function(i) runner$run(i), cores = vcr_cores(NULL), indices = seq_len(R))
  do.call(rbind, out)
}

vcr_case("N90a", c("AC-28", "AC-29"), function() {
  rates <- c(0.4, 0.7, 1); R <- 12000L
  sc <- .n90_null(.n90_scenario(80, "modestly_weighted", rates, s_star = 1))
  stats_m <- .n90_trials(sc, 9001L, R)[, paste0("stat", 1:3), drop = FALSE]
  gs <- vcr_group_sequential(rates, 0.025, "obrien_fleming")
  b <- vcr_gs_simulated_bounds(stats_m, gs$alphaSpent)
  # the sampling error of a quantile with probability p: sqrt(p (1 - p) / R) / density at the boundary
  se <- sqrt(gs$alphaSpent * (1 - gs$alphaSpent) / R) / stats::dnorm(gs$criticalValues)
  z <- (b$bounds - gs$criticalValues) / se
  # a design whose first look spends less than one null trial cannot stop there
  tiny <- vcr_gs_simulated_bounds(stats_m[1:500, , drop = FALSE], gs$alphaSpent)
  list(pass = all(abs(z[2:3]) < 4) && abs(z[1]) < 5 && all(abs(b$crossed - round(gs$alphaSpent * R)) <= 1) && abs(sum(b$spendRealized) - 0.025) < 1 / R * 3 && is.infinite(tiny$bounds[1]) && tiny$unresolved[1] && !tiny$unresolved[3],
       detail = sprintf("%d null trials of 80 + 80 people, looks at 40%%, 70%% and 100%% of the events, O'Brien-Fleming spending: the boundaries found by simulation %s against the analytic Lan-DeMets %s (%s sampling errors apart); the realized spend %s equals the planned %s to the trial; with 500 trials the first look, planned %.5f, cannot stop (%s)",
                        R, paste(sprintf("%.3f", b$bounds), collapse = " / "), paste(sprintf("%.3f", gs$criticalValues), collapse = " / "), paste(sprintf("%.2f", z), collapse = " / "),
                        paste(b$crossed, collapse = "/"), paste(round(gs$alphaSpent * R), collapse = "/"), gs$alphaSpent[1], tiny$unresolved[1]))
})

vcr_case("N90b", c("AC-28", "AC-31", "AC-38"), function() {
  # (1) MaxCombo at three looks: boundaries from one run, the type I error from another with its own seed
  rates <- c(0.5, 0.8, 1)
  sc <- .n90_null(.n90_scenario(40, "maxcombo", rates))
  gs <- vcr_group_sequential(rates, 0.025, "obrien_fleming")
  b <- vcr_gs_simulated_bounds(.n90_trials(sc, 9002L, 6000L)[, paste0("stat", 1:3), drop = FALSE], gs$alphaSpent)
  v <- .n90_trials(sc, 9003L, 6000L, list(bounds = b$bounds, logrank = TRUE))
  rate <- function(x) { p <- mean(x); c(value = p, mcse = sqrt(p * (1 - p) / length(x))) }
  m <- rate(v[, "reject"]); lr <- rate(v[, "logrankReject"])
  boundary_se <- sqrt(0.025 * 0.975 / 6000)
  # (2) the boundary run of a job: one and two cores give the same bits; a smaller budget leaves fewer null trials; none at all is a named refusal
  small <- .n90_scenario(25, "modestly_weighted", c(0.6, 1), ratios = c(1, 0.6))
  edges <- function(cores, limit = 600, sc = small) { j <- vcr_test_job("design.simulate", sc, seed = 9004L, replicates = 300L, cores = cores); j$cpuSecondsLimit <- limit; vcr_gs_boundaries_job(j, sc) }
  one <- edges(1L); two <- edges(2L)
  same <- identical(one$bounds, two$bounds) && identical(vcr_canonical_json(one$info), vcr_canonical_json(two$info))
  tight <- edges(1L, 12, .n90_scenario(100, "modestly_weighted", c(0.6, 1), ratios = c(1, 0.6)))
  refused <- tryCatch({ edges(1L, 0.2); "no refusal" }, vcr_refusal = function(e) e$issue$code)
  list(pass = abs(m[["value"]] - 0.025) < 3.5 * sqrt(m[["mcse"]]^2 + boundary_se^2) && abs(lr[["value"]] - 0.025) < 3.5 * sqrt(lr[["mcse"]]^2 + boundary_se^2) && same &&
         one$trials == one$planned && length(one$bounds) == 2L && all(is.finite(one$bounds)) && tight$trials < tight$planned && tight$trials >= 2000L && identical(refused, "cpu_budget_exhausted"),
       detail = sprintf("MaxCombo at three looks, 40 + 40 people, no effect: boundaries %s from 6,000 null trials, the type I error of a separate run of 6,000 is %.4f (error %.4f) beside the log-rank test's %.4f; the boundary run of a modestly weighted job at two looks: 1 and 2 cores give the same boundaries and record (%s), %d null trials; a 12 s budget on 100 + 100 people leaves %d null trials; a budget of 0.2 s is refused (%s)",
                        paste(sprintf("%.3f", b$bounds), collapse = " / "), m[["value"]], m[["mcse"]], lr[["value"]], same, as.integer(one$trials), as.integer(tight$trials), refused))
})

vcr_case("N90d", c("AC-04", "AC-28"), function() {
  # a whole job, slow because the boundary run and the strong null each run a null floor of 20,000 trials (25 + 25 people, two looks, the modestly weighted test)
  small <- .n90_scenario(25, "modestly_weighted", c(0.6, 1), ratios = c(1, 0.6))
  r <- vcr_test_run(vcr_test_job("design.simulate", small, seed = 9007L, replicates = 300L, cores = vcr_cores(NULL)))
  names_ <- vapply(r$measures, function(x) x$name, character(1))
  info <- r$diagnostics$groupSequentialBoundaries
  old <- vcr_test_job("design.simulate", small, seed = 9007L, replicates = 300L); old$methodVersion <- "1.4.0"
  old_run <- vcr_test_run(old)
  list(pass = identical(r$status, "succeeded") && all(c("power", "power_logrank", "expected_events", "expected_analyses", "type_one_error_strong_null", "type_one_error_strong_null_logrank") %in% names_) &&
         isTRUE(r$diagnostics$strongNull$computed) && info$nullTrials >= 20000L && length(info$criticalValues) == 2L && identical(old_run$status, "failed") && "method_version_mismatch" %in% vcr_test_issue_codes(old_run),
       detail = sprintf("a whole job: power %.3f beside the log-rank power %.3f on the same trials, the expected number of analyses %.2f, the strong null %.4f against the log-rank test's %.4f; the boundaries (%s) rest on %d null trials of the design; the same job under a 1.4.0 label is refused (method_version_mismatch)",
                        vcr_measure_value(r, "power"), vcr_measure_value(r, "power_logrank"), vcr_measure_value(r, "expected_analyses"), vcr_measure_value(r, "type_one_error_strong_null"), vcr_measure_value(r, "type_one_error_strong_null_logrank"),
                        paste(sprintf("%.3f", unlist(info$criticalValues)), collapse = " / "), as.integer(info$nullTrials)))
})

vcr_case("N90c", c("AC-29"), function() {
  if (!requireNamespace("gsDesign2", quietly = TRUE)) return(list(pass = FALSE, detail = "gsDesign2 (the cross-check package) is not installed"))
  suppressMessages(requireNamespace("gsDesign", quietly = TRUE))
  n_total <- 300L
  enroll <- gsDesign2::define_enroll_rate(duration = 12, rate = n_total / 12)
  fail <- gsDesign2::define_fail_rate(duration = c(4, 100), fail_rate = log(2) / 12, hr = c(1, 0.6), dropout_rate = -log(0.95) / 12)
  times <- c(18, 30, 42)
  fh <- do.call(rbind, lapply(seq_len(4), function(k) data.frame(rho = c(0, 0, 1, 1)[k], gamma = c(0, 1, 0, 1)[k], tau = -1, test = k, analysis = 1:3, analysis_time = times)))
  ref <- suppressMessages(gsDesign2::gs_power_combo(enroll_rate = enroll, fail_rate = fail, fh_test = fh, ratio = 1, binding = FALSE,
    upper = gsDesign2::gs_spending_combo, upar = list(sf = gsDesign::sfLDOF, total_spend = 0.025, param = NULL), lower = gsDesign2::gs_b, lpar = rep(-Inf, 3)))
  ups <- ref$bound[ref$bound$bound == "upper", ]
  frac <- ref$analysis$event_frac
  # the engine's design: the same patients, the looks at the same event fractions
  sc <- .n90_scenario(n_total / 2, "maxcombo", frac, ratios = c(1, 0.6), at = 4, followup = 30)
  # gsDesign2 spends the alpha by the information of the combination test at each look, which is not the fraction of events the engine spends by (the first look
  # gets 2.5e-7 where the events would give 0.0003): so that the two are compared on the distribution of the statistic across looks and not on the
  # spending convention, the engine is given gsDesign2's own null spend at each look
  spend <- diff(c(0, ups$probability0))
  b <- vcr_gs_simulated_bounds(.n90_trials(.n90_null(sc), 9005L, 8000L)[, paste0("stat", 1:3), drop = FALSE], spend)
  v <- .n90_trials(sc, 9006L, 4000L, list(bounds = b$bounds))
  mine <- vapply(1:3, function(k) mean(v[, "reject"] == 1 & v[, "look"] <= k), numeric(1))
  se <- sqrt(mine * (1 - mine) / nrow(v))
  gap <- abs(mine - ups$probability)
  list(pass = all(gap < 3 * se + 0.03),
       detail = sprintf("MaxCombo (the four Fleming-Harrington weights) at 3 looks on a delayed effect (HR 1 for 4 months, then 0.6; 150 + 150 people; looks at the event fractions %s that gsDesign2 gives its calendar looks 18, 30 and 42 months), the null spend of each look as gsDesign2 has it (%s): the probability of having stopped by each look is %s in the simulation (boundaries from 8,000 null trials, 4,000 trials) against %s from gsDesign2::gs_power_combo (largest gap %.3f, allowed 3 errors + 0.03 for its asymptotic information)",
                        paste(sprintf("%.3f", frac), collapse = "/"), paste(sprintf("%.2g", spend), collapse = "/"), paste(sprintf("%.4f", mine), collapse = "/"), paste(sprintf("%.4f", ups$probability), collapse = "/"), max(gap)))
})
