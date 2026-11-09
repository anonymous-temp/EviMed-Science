# N88 — the modestly weighted log-rank test (algorithm round T12, 2026-11-03): design.simulate and design.grid, analysis.method "modestly_weighted".
#
# "既怕延迟效应又怕假阳性，有没有折中": the weight 1 / max(S(t-), s*) of the pooled survival curve counts a late event up to 1 / s* times an early one
# (Magirr and Burman 2019), so the test keeps most of the power of a late-weighted test when the effect starts late and does not reject as often
# when the treatment is worse early and equal later. Held to simtrial, the package that implements it (never called from R/):
#
#   a  the standardized statistic of the same patients equals simtrial::wlr(weight = mb(delay = Inf, w_max = 1 / s*)) (sign aside), at four values of s*
#   b  the power of a delayed effect and the rejection probability on crossing curves (the treatment worse for 3 months, then better) against simtrial's own
#      generator and test: within combined Monte-Carlo errors; and the middle road the test is for: on the crossing curves a Fleming-Harrington (0,1) weight
#      calls the late benefit a win several times as often as the modestly weighted test, which does so more often than the log-rank test
#   c  the job: the log-rank power on the same replicates and the strong null beside the test, the weight cap kept out of a log-rank job, and the
#      versions: a job recorded at 1.4.0 replays to the same bits at 1.5.0 when it asks for nothing the new release added

.n88_scenario <- function(n = 150, method = "modestly_weighted", s_star = NULL, ratios = c(1, 0.6), at = 6) {
  an <- list(method = method, alpha = 0.025, sided = 1)
  if (!is.null(s_star)) an$sStar <- s_star
  list(design = list(kind = "two_arm_fixed", nTreat = n, nControl = n), endpoint = list(type = "time_to_event"),
       truth = list(treatmentHazardRatios = list(breaks = list(at), ratios = as.list(ratios)), controlMedian = 12),
       accrual = list(kind = "uniform", duration = 12, followup = 18, dropoutAnnual = 0.1), analysis = an)
}

# simtrial's own generator for the same world: piecewise exponential in the time since entry, uniform entry, a 10% annual dropout
.n88_simtrial_world <- function(n, ratios, at = 6) {
  fr <- data.frame(stratum = "All", period = rep(1:2, 2), treatment = c(rep("control", 2), rep("experimental", 2)), duration = rep(c(at, 100), 2),
                   rate = log(2) / 12 * c(1, 1, ratios[1], ratios[2]))
  dr <- data.frame(stratum = "All", period = 1, treatment = c("control", "experimental"), duration = 100, rate = -log(0.9) / 12)
  function() simtrial::sim_pw_surv(n = 2 * n, stratum = data.frame(stratum = "All", p = 1), block = rep(c("experimental", "control"), 2),
                                   enroll_rate = data.frame(rate = 2 * n / 12, duration = 12), fail_rate = fr, dropout_rate = dr)
}

vcr_case("N88a", c("AC-29"), function() {
  if (!requireNamespace("simtrial", quietly = TRUE)) return(list(pass = FALSE, detail = "simtrial (the cross-check package) is not installed"))
  set.seed(8801L, kind = VCR_RNG_KIND)
  dist <- list(kind = "exponential", rate = log(2) / 12)
  worst <- 0; checked <- 0L
  for (ratios in list(c(1, 0.6), c(1.5, 1), c(0.8, 0.8))) {
    nph <- .vcr_nph_spec(list(breaks = 6, ratios = ratios), dist)
    for (rep in 1:3) {
      d <- vcr_sim_tte(120, 120, dist, nph, list(kind = "uniform", duration = 12), followup = 18, dropout_annual = 0.1)
      for (s in c(0.25, 0.5, 0.8, 1)) {
        mine <- vcr_mw_statistic(d$time, d$status, d$arm, s)
        ref <- simtrial::wlr(data.frame(tte = d$time, event = d$status, treatment = ifelse(d$arm == 1L, "experimental", "control")), weight = simtrial::mb(delay = Inf, w_max = 1 / s))
        worst <- max(worst, abs(mine + ref$z)); checked <- checked + 1L
      }
    }
  }
  # s* = 1 is the log-rank weight (1 / max(S, 1) = 1): the statistic equals the log-rank test's own
  d <- vcr_sim_tte(120, 120, dist, 1, list(kind = "uniform", duration = 12), followup = 18)
  lr <- vcr_analyse_logrank(d, 0.025, 1)[["statistic"]]
  list(pass = worst < 1e-9 && abs(vcr_mw_statistic(d$time, d$status, d$arm, 1) - lr) < 1e-9,
       detail = sprintf("%d statistics (three hazard laws, four weight caps s* = 0.25 to 1, 120 + 120 patients with dropout): the engine's modestly weighted z equals -simtrial::wlr(mb(delay = Inf, w_max = 1 / s*))$z to %.1e; with s* = 1 it is the log-rank statistic", checked, worst))
})

vcr_case("N88b", c("AC-28", "AC-29"), function() {
  if (!requireNamespace("simtrial", quietly = TRUE)) return(list(pass = FALSE, detail = "simtrial (the cross-check package) is not installed"))
  n <- 150L; reps <- 2000L; sim_reps <- 1500L
  crit <- stats::qnorm(1 - 0.025)
  rows <- character(0); ok <- TRUE; strong <- list()
  for (world in list(list(name = "delayed benefit (HR 1 then 0.6)", ratios = c(1, 0.6), at = 6, seed = 8811L), list(name = "crossing curves (HR 3 for 3 months, then 0.5)", ratios = c(3, 0.5), at = 3, seed = 8812L))) {
    sc <- .n88_scenario(n, ratios = world$ratios, at = world$at)
    res <- vcr_run_simulation(sc, world$seed, reps, cores = vcr_cores(NULL), extras = list(logrank = TRUE))
    m <- Filter(function(x) x$name %in% c("power", "type_one_error"), res$measures)[[1]]
    lr <- Filter(function(x) x$name %in% c("power_logrank", "type_one_error_logrank"), res$measures)[[1]]
    set.seed(world$seed + 1L, kind = VCR_RNG_KIND)
    gen <- .n88_simtrial_world(n, world$ratios, world$at)
    z <- numeric(sim_reps); zlr <- numeric(sim_reps)
    for (i in seq_len(sim_reps)) {
      cut <- simtrial::cut_data_by_date(gen(), 30)
      z[i] <- simtrial::wlr(cut, weight = simtrial::mb(delay = Inf, w_max = 2))$z
      zlr[i] <- simtrial::wlr(cut, weight = simtrial::fh(rho = 0, gamma = 0))$z
    }
    p_ref <- mean(z > crit); se_ref <- sqrt(p_ref * (1 - p_ref) / sim_reps)
    q_ref <- mean(zlr > crit); sq_ref <- sqrt(q_ref * (1 - q_ref) / sim_reps)
    gap <- abs(m$value - p_ref) / sqrt(m$mcse^2 + se_ref^2); gap_lr <- abs(lr$value - q_ref) / sqrt(lr$mcse^2 + sq_ref^2)
    ok <- ok && gap < 3.5 && gap_lr < 3.5
    rows <- c(rows, sprintf("%s: modestly weighted %.4f (engine, %d trials) against %.4f (simtrial, %d), log-rank %.4f against %.4f", world$name, m$value, reps, p_ref, sim_reps, lr$value, q_ref))
    if (grepl("crossing", world$name)) strong <- list(mw = m, lr = lr)
  }
  # the contrast on the crossing curves: a Fleming-Harrington (0,1) weight calls the late benefit a win far more often than the modestly weighted test, and
  # the log-rank test, which counts the early harm as much as the late benefit, hardly ever does
  set.seed(8813L, kind = VCR_RNG_KIND)
  dist <- list(kind = "exponential", rate = log(2) / 12); nph <- .vcr_nph_spec(list(breaks = 3, ratios = c(3, 0.5)), dist)
  rej <- 0L; fh_reps <- 1500L
  for (i in seq_len(fh_reps)) {
    d <- vcr_sim_tte(n, n, dist, nph, list(kind = "uniform", duration = 12), followup = 18, dropout_annual = 0.1)
    rej <- rej + as.integer(vcr_fh_statistics(d$time, d$status, d$arm, list(c(0, 1)))$z < -crit)
  }
  fh <- rej / fh_reps; fh_se <- sqrt(fh * (1 - fh) / fh_reps)
  list(pass = ok && fh > 2 * strong$mw$value && strong$mw$value > strong$lr$value,
       detail = sprintf("%s; on the crossing curves a Fleming-Harrington (0,1) weight rejects %.4f (error %.4f), the modestly weighted test %.4f and the log-rank test %.4f: the middle road between them", paste(rows, collapse = "; "), fh, fh_se, strong$mw$value, strong$lr$value))
})

vcr_case("N88c", c("AC-04", "AC-31"), function() {
  sc <- .n88_scenario(60L)
  job <- vcr_test_job("design.simulate", sc, seed = 8821L, replicates = 800L, cores = vcr_cores(NULL))
  r <- vcr_test_run(job)
  names_ <- vapply(r$measures, function(m) m$name, character(1))
  sn <- Filter(function(m) identical(m$name, "type_one_error_strong_null"), r$measures)
  snl <- Filter(function(m) identical(m$name, "type_one_error_strong_null_logrank"), r$measures)
  # the weight cap belongs to the modestly weighted test only; a log-rank job that states it is refused by name
  stray <- sc; stray$analysis <- list(method = "logrank", sStar = 0.5)
  refused <- vcr_test_run(vcr_test_job("design.simulate", stray, seed = 1L, replicates = 100L))
  # a log-rank job recorded at 1.4.0 replays to the same bits at 1.5.0: bumping the release changed nothing it already did
  lr <- list(design = list(kind = "two_arm_fixed", nTreat = 80, nControl = 80), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12),
             accrual = list(kind = "uniform", duration = 12, followup = 12, dropoutAnnual = 0.05), analysis = list(method = "logrank", alpha = 0.025, sided = 1))
  hash <- function(version) { j <- vcr_test_job("design.simulate", lr, seed = 8822L, replicates = 300L, cores = 1L); j$methodVersion <- version; vcr_sha256(vcr_canonical_json(vcr_test_run(j)$measures)) }
  # a modestly weighted job under the older label is refused (the key the new release reads), and with the current label it runs
  old <- vcr_test_job("design.simulate", sc, seed = 8821L, replicates = 100L); old$methodVersion <- "1.4.0"
  old_run <- vcr_test_run(old)
  same_bits <- identical(hash("1.4.0"), hash("1.5.0"))
  # the analytic design refuses to size it by a formula
  an <- vcr_test_run(vcr_test_job("design.analytic", list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12),
    accrual = list(duration = 12, followup = 18), analysis = list(method = "modestly_weighted")), seed = 1L))
  pw <- vcr_measure_value(r, "power")
  list(pass = identical(r$status, "succeeded") && all(c("power", "power_logrank", "type_one_error_strong_null", "type_one_error_strong_null_logrank") %in% names_) && length(sn) == 1L && length(snl) == 1L &&
         sn[[1]]$value <= 0.025 + 3 * sn[[1]]$mcse && identical(refused$status, "failed") && "scenario_field_unknown" %in% vcr_test_issue_codes(refused) && same_bits &&
         identical(old_run$status, "failed") && "method_version_mismatch" %in% vcr_test_issue_codes(old_run) && identical(an$status, "failed"),
       detail = sprintf("a modestly weighted job (delayed effect, 60 + 60, 800 trials): power %.3f beside the log-rank power %.3f on the same trials; the strong-null rejection %.4f (error %.4f) with the log-rank test's %.4f beside it; a log-rank job that states the weight cap is refused (scenario_field_unknown); the same modestly weighted job under a 1.4.0 label is refused (method_version_mismatch); a log-rank job recorded at 1.4.0 replays to the same bits at 1.5.0 (%s); the analytic design does not size it",
                        pw, vcr_measure_value(r, "power_logrank"), sn[[1]]$value, sn[[1]]$mcse, snl[[1]]$value, same_bits))
})
