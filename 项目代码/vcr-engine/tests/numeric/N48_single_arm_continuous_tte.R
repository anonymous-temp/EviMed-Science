# N48 — a single-arm trial of a mean and of a survival time against a fixed benchmark
# (design.simulate / design.grid, design.kind single_arm, endpoint continuous or time_to_event; 2026-10-07).
#
# References that are not the engine's own code: for a mean, `stats::power.t.test(type = "one.sample")` (the exact
# non-central t) and a normal closed form written here for the z test; for a survival time, the one-sample log-rank
# statistic worked by hand on a crafted data set (E from closed-form cumulative hazards), an independent plain-R
# simulation of the same trial, and the first-order normal approximation of the score. Type I error is the null
# scenario's rejection rate, held to the nominal level within its Monte-Carlo error.

.n48_run <- function(sc, seed, replicates = NULL, tag = "a", cores = VCR_TEST_CORES) {
  vcr_test_run(vcr_test_job("design.simulate", sc, seed = seed, replicates = replicates, cores = cores, job_id = paste0("job_n48", tag)))
}
.n48_mean <- function(effect = 5, sd = 12, n = 40, method = "one_sample_t", alternative = "greater", sided = 1, alpha = 0.025, known_sd = NULL, benchmark = 50) {
  list(design = list(kind = "single_arm", n = n), endpoint = list(type = "continuous"), truth = list(benchmark = benchmark, effect = effect, sd = sd),
       analysis = c(list(method = method, alternative = alternative, sided = sided, alpha = alpha), if (!is.null(known_sd)) list(sd = known_sd)),
       performance = list("power", "bias", "coverage"))
}
.n48_surv <- function(hr = 0.65, n = 60, median = 12, alternative = "less", sided = 1, alpha = 0.025, duration = 12, followup = 12, dropout = 0.05, distribution = NULL) {
  list(design = list(kind = "single_arm", n = n), endpoint = list(type = "time_to_event"),
       truth = c(list(hazardRatio = hr), if (is.null(distribution)) list(controlMedian = median) else list(controlDistribution = distribution)),
       accrual = list(kind = "uniform", duration = duration, followup = followup, dropoutAnnual = dropout),
       analysis = list(method = "one_sample_logrank", alternative = alternative, sided = sided, alpha = alpha), performance = list("power", "bias", "coverage"))
}

vcr_case("N48a", c("AC-10", "AC-11", "AC-28", "AC-29"), function() {
  # A mean against a benchmark: the simulated power is the exact one's, in every arrangement. One-sided greater and less (a mirror
  # image: the same power for the opposite sign of the effect), two-sided, the z test with the SD told right and told wrong. The null
  # scenario's rejection rate is alpha exactly (the t test is exact for normal data), the effect has no bias and the interval covers.
  rows <- list(
    list(tag = "t greater", sc = .n48_mean(), ref = stats::power.t.test(n = 40, delta = 5, sd = 12, sig.level = 0.025, type = "one.sample", alternative = "one.sided")$power),
    list(tag = "t less", sc = .n48_mean(effect = -5, alternative = "less"), ref = stats::power.t.test(n = 40, delta = 5, sd = 12, sig.level = 0.025, type = "one.sample", alternative = "one.sided")$power),
    list(tag = "t two-sided", sc = .n48_mean(alternative = "two.sided", sided = 2, alpha = 0.05), ref = stats::power.t.test(n = 40, delta = 5, sd = 12, sig.level = 0.05, type = "one.sample", alternative = "two.sided")$power),
    list(tag = "z known sd 12", sc = .n48_mean(method = "one_sample_z", known_sd = 12), ref = stats::pnorm(5 * sqrt(40) / 12 - stats::qnorm(0.975))),
    # told 9 when it is 12: the statistic is over-dispersed by 12/9, so the rejection probability is Phi((delta sqrt(n)/9 - z) * 9/12)
    list(tag = "z told sd 9", sc = .n48_mean(method = "one_sample_z", known_sd = 9), ref = stats::pnorm((5 * sqrt(40) / 9 - stats::qnorm(0.975)) * 9 / 12)),
    list(tag = "t null", sc = .n48_mean(effect = 0, n = 25), ref = 0.025),
    list(tag = "z null told 9", sc = .n48_mean(effect = 0, n = 25, method = "one_sample_z", known_sd = 9), ref = 2 * 0 + stats::pnorm(-stats::qnorm(0.975) * 9 / 12))
  )
  out <- lapply(seq_along(rows), function(i) {
    r <- .n48_run(rows[[i]]$sc, 4800L + i, 40000L, paste0("a", i))
    name <- if (rows[[i]]$sc$truth$effect == 0) "type_one_error" else "power"
    m <- vcr_get_measure(r, name); b <- vcr_get_measure(r, "bias"); cv <- vcr_get_measure(r, "coverage")
    sided <- rows[[i]]$sc$analysis$sided
    cover_ref <- 1 - rows[[i]]$sc$analysis$alpha * 2 / sided
    list(tag = rows[[i]]$tag, ok = identical(r$status, "succeeded") && !is.null(m) && isTRUE(m$simulated) && abs(m$value - rows[[i]]$ref) <= 3 * m$mcse && abs(b$value) <= 3 * b$mcse &&
           r$counts$realPatients == 0 && r$counts$generatedRecords == 40000L * rows[[i]]$sc$design$n &&
           (identical(rows[[i]]$tag, "z told sd 9") || identical(rows[[i]]$tag, "z null told 9") || abs(cv$value - cover_ref) <= 3 * cv$mcse + 1e-9) &&
           isTRUE(r$diagnostics$analyticCheck$withinThreeMcse),
         text = sprintf("%s %.4f vs %.4f (+-%.4f)", rows[[i]]$tag, m$value, rows[[i]]$ref, m$mcse))
  })
  list(pass = all(vapply(out, function(o) o$ok, logical(1))),
       detail = paste0("40,000 replicates each, simulated against the independent exact value within three Monte-Carlo errors: ", paste(vapply(out, function(o) o$text, character(1)), collapse = "; "),
                       "; no bias in the effect, coverage at the stated level for the t analyses, the result's own analytic check agrees, no real patients"))
})

vcr_case("N48b", c("AC-09", "AC-29", "AC-30"), function() {
  # The one-sample log-rank statistic, worked by hand. Ten patients against an exponential benchmark (E = sum of lambda t), a Weibull
  # benchmark (E = sum of (t / scale)^shape) and a piecewise-exponential one (the cumulative hazard integrated by hand): the statistic
  # (E - O) / sqrt(E), the effect log(O / E), its Poisson standard error and the decision for each alternative, to rounding.
  time <- c(2.1, 3.4, 5.0, 6.7, 8.8, 10.2, 12.0, 12.0, 4.4, 9.1); status <- c(1, 1, 0, 1, 0, 1, 0, 0, 1, 1)
  O <- sum(status)
  hand <- list(
    exponential = list(dist = list(kind = "exponential", rate = 0.08), E = sum(0.08 * time)),
    weibull = list(dist = list(kind = "weibull", shape = 1.4, scale = 15), E = sum((time / 15)^1.4)),
    piecewise = list(dist = list(kind = "piecewise", breaks = c(4, 9), rates = c(0.05, 0.1, 0.03)),
                     E = sum(vapply(time, function(t) 0.05 * min(t, 4) + 0.1 * max(0, min(t, 9) - 4) + 0.03 * max(0, t - 9), numeric(1)))))
  worst <- 0; dec_ok <- TRUE
  for (h in hand) {
    z <- (h$E - O) / sqrt(h$E)
    for (alt in c("less", "greater", "two.sided")) {
      r <- vcr_analyse_one_sample_logrank(time, status, h$dist, 0.025, if (alt == "two.sided") 2 else 1, alt)
      p <- switch(alt, less = stats::pnorm(z, lower.tail = FALSE), greater = stats::pnorm(z), two.sided = 2 * stats::pnorm(-abs(z)))
      want_rej <- switch(alt, less = z > stats::qnorm(0.975), greater = z < -stats::qnorm(0.975), abs(z) > stats::qnorm(0.9875))
      crit <- stats::qnorm(1 - 0.025 / (if (alt == "two.sided") 2 else 1))
      worst <- max(worst, abs(r[["statistic"]] - z), abs(r[["estimate"]] - log(O / h$E)), abs(r[["se"]] - 1 / sqrt(O)), abs(r[["p"]] - p), abs(r[["ci_low"]] - (log(O / h$E) - crit / sqrt(O))),
                   abs(r[["events"]] - O), abs(r[["expectedEvents"]] - h$E))
      dec_ok <- dec_ok && identical(as.logical(r[["reject"]]), want_rej)
    }
  }
  none <- vcr_analyse_one_sample_logrank(c(50, 60, 70), c(0, 0, 0), hand$exponential$dist, 0.025, 1, "less")   # E = 14.4 and nothing happened
  ok <- worst < 1e-12 && dec_ok && is.na(none[["estimate"]]) && none[["reject"]] == 1
  list(pass = ok,
       detail = sprintf("10 patients, 6 events, against exponential / Weibull / piecewise benchmarks: expected events %.4f / %.4f / %.4f computed by hand; the statistic, the log O/E effect, its standard error, the p-value, the interval and the decision for three alternatives agree to %.1e; a sample with no event has no effect estimate and still rejects (%s)",
                        hand$exponential$E, hand$weibull$E, hand$piecewise$E, worst, none[["reject"]] == 1))
})

vcr_case("N48c", c("AC-10", "AC-29", "AC-28"), function() {
  # The whole time-to-event chain against an independent simulation written in plain R (exponential events, uniform entry, administrative
  # censoring at the end of follow-up, exponential dropout, the one-sample log-rank statistic with E from the closed form): hazard ratio
  # 0.5, 0.65 and 0.8 and the null, n = 60 and 100, a Weibull benchmark. The engine's power is held to the independent simulation within
  # three combined Monte-Carlo errors, and the analytic first-order approximation it reports within the tolerance it documents; the largest
  # gap measured is kept here beside that tolerance. The null is conservative for a few expected events and approaches alpha as they grow.
  indep <- function(n, hr, med, A, Fu, drop, reps, seed, shape = NULL, scale = NULL) {
    .vcr_with_seed(seed, {
      lam0 <- log(2) / med; eta <- if (drop > 0) -log(1 - drop) / 12 else 0
      hits <- vapply(seq_len(reps), function(i) {
        e <- stats::runif(n, 0, A); cens <- A + Fu - e
        Tt <- if (is.null(shape)) stats::rexp(n, lam0 * hr) else scale * (stats::rexp(n) / hr)^(1 / shape)
        D <- if (eta > 0) stats::rexp(n, eta) else rep(Inf, n)
        obs <- pmin(Tt, D, cens); d <- as.numeric(Tt <= pmin(D, cens))
        Ecum <- if (is.null(shape)) sum(lam0 * obs) else sum((obs / scale)^shape)
        (Ecum - sum(d)) / sqrt(Ecum) > stats::qnorm(0.975)
      }, logical(1))
      c(p = mean(hits), se = sqrt(mean(hits) * (1 - mean(hits)) / reps))
    })
  }
  cases <- list(
    list(tag = "HR .5 n60", sc = .n48_surv(hr = 0.5), args = list(60, 0.5, 12, 12, 12, 0.05)),
    list(tag = "HR .65 n60", sc = .n48_surv(hr = 0.65), args = list(60, 0.65, 12, 12, 12, 0.05)),
    list(tag = "HR .8 n100", sc = .n48_surv(hr = 0.8, n = 100), args = list(100, 0.8, 12, 12, 12, 0.05)),
    list(tag = "null n60", sc = .n48_surv(hr = 1), args = list(60, 1, 12, 12, 12, 0.05)),
    list(tag = "Weibull HR .6 n80", sc = .n48_surv(hr = 0.6, n = 80, distribution = list(kind = "weibull", shape = 1.5, scale = 18)), args = list(80, 0.6, NA, 12, 12, 0.05, shape = 1.5, scale = 18)))
  gaps <- numeric(0); texts <- character(0); ok <- TRUE
  for (i in seq_along(cases)) {
    cs <- cases[[i]]
    r <- .n48_run(cs$sc, 4810L + i, 30000L, paste0("c", i))
    name <- if (identical(cs$sc$truth$hazardRatio, 1)) "type_one_error" else "power"
    m <- vcr_get_measure(r, name)
    ref <- do.call(indep, c(cs$args, list(reps = 30000L, seed = 4820L + i)))
    ac <- r$diagnostics$analyticCheck
    z <- (m$value - ref[["p"]]) / sqrt(m$mcse^2 + ref[["se"]]^2)
    if (!is.null(ac$value) && is.finite(ac$value)) gaps <- c(gaps, abs(ac$value - m$value))
    ok <- ok && identical(r$status, "succeeded") && abs(z) <= 3.5 && (is.null(ac) || isTRUE(ac$withinTolerance) || is.null(ac$value))
    texts <- c(texts, sprintf("%s %.4f vs independent %.4f (z %.2f)%s", cs$tag, m$value, ref[["p"]], z, if (!is.null(ac$value)) sprintf(", analytic %.4f", ac$value) else ", no closed form"))
  }
  # the null approaches alpha as the benchmark predicts more events
  big <- .n48_run(.n48_surv(hr = 1, n = 400, median = 6, duration = 6, followup = 18), 4830L, 20000L, "c9")
  small <- .n48_run(.n48_surv(hr = 1, n = 40), 4831L, 20000L, "c10")
  t_big <- vcr_measure_value(big, "type_one_error"); t_small <- vcr_measure_value(small, "type_one_error")
  mc_big <- vcr_get_measure(big, "type_one_error")$mcse
  ok <- ok && abs(t_big - 0.025) <= 3 * mc_big + 0.004 && abs(t_big - 0.025) < abs(t_small - 0.025) && max(gaps) < VCR_ONE_SAMPLE_LOGRANK_APPROXIMATION_BIAS
  list(pass = ok,
       detail = sprintf("%s; type I error %.4f with about %.0f expected events and %.4f with about %.0f (nominal 0.025); the approximation's largest gap to the simulation %.4f against its documented %.3f",
                        paste(texts, collapse = "; "), t_small, mean(vcr_get_measure(small, "expected_events")$value), t_big, vcr_get_measure(big, "expected_events")$value, max(gaps), VCR_ONE_SAMPLE_LOGRANK_APPROXIMATION_BIAS))
})

vcr_case("N48d", c("AC-04", "AC-31", "AC-38"), function() {
  # The designs are reproducible and resumable like the binary single-arm ones. One core and eight give the same replicate matrix, a canceled run
  # resumes from its checkpoint to the same bytes, and a grid cell equals the single job at the cell's own seed (a grid over the sample size and the
  # effect, continuous and time to event).
  for_each <- list(continuous = .n48_mean(), time_to_event = .n48_surv())
  rows <- lapply(names(for_each), function(nm) {
    sc <- for_each[[nm]]
    one <- vcr_run_simulation(sc, 4840L, 1500L, cores = 1L); eight <- vcr_run_simulation(sc, 4840L, 1500L, cores = 8L)
    dir <- tempfile("n48d"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
    cp <- file.path(dir, "checkpoint.rds"); cancel <- file.path(dir, "cancel")
    partial <- vcr_run_simulation(sc, 4840L, 1500L, cores = 1L, checkpoint = cp, cancel_file = cancel, progress = function(done, total) if (done >= 500) file.create(cancel))
    unlink(cancel); resumed <- vcr_run_simulation(sc, 4840L, 1500L, cores = 8L, checkpoint = cp)
    list(ok = identical(one$values, eight$values) && identical(one$values, resumed$values) && identical(partial$status, "canceled") && partial$diagnostics$replicatesCompleted >= 500L,
         text = sprintf("%s %d rows, 1/8/resume identical, canceled run kept %d", nm, nrow(one$values), partial$diagnostics$replicatesCompleted))
  })
  grid_sc <- .n48_mean(n = 30); grid_sc$designs <- list(list(n = 30), list(n = 60)); grid_sc$truths <- list(list(effect = 0), list(effect = 5)); grid_sc$performance <- list("power")
  dir <- tempfile("n48dg"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  g <- vcr_test_run(vcr_test_job("design.grid", grid_sc, seed = 4841L, replicates = 800L, cores = VCR_TEST_CORES, job_id = "job_n48d"), output_dir = dir)
  iso <- .n48_mean(n = 60, effect = 5); iso$performance <- list("power")
  seed <- as.integer((4841 + 4 * 7919) %% 2147483647)
  one <- vcr_test_run(vcr_test_job("design.simulate", iso, seed = seed, replicates = 800L, cores = VCR_TEST_CORES, job_id = "job_n48d"))
  cell <- g$diagnostics$cells[[4]]$measures[[1]]
  grid_ok <- identical(g$status, "succeeded") && length(g$diagnostics$cells) == 4L && identical(cell$value, vcr_measure_value(one, "power"))
  list(pass = all(vapply(rows, function(r) r$ok, logical(1))) && grid_ok,
       detail = sprintf("%s; a 2 x 2 grid over n and the effect: cell four power %.4f equals the isolated job at its seed %.4f", paste(vapply(rows, function(r) r$text, character(1)), collapse = "; "), cell$value, vcr_measure_value(one, "power")))
})

vcr_case("N48e", c("AC-04", "AC-30", "AC-26"), function() {
  # Refused for what it is, and versioned. The key allow-list is the domain's on both sides: a z analysis without the SD it takes as known, a binary analysis
  # on a mean, a baseline correlation on a trial with no baseline, binary rates on a continuous trial, a missing effect, both survival benchmarks at once, a
  # sidedness that disagrees with the alternative, and the designs that stay binary (external control, Simon) on a mean. A job labelled with the version
  # before single-arm means and survival times existed is refused for them, while the binary single-arm job at that version stays valid (replays).
  d <- vcr_domain()
  refuse <- function(sc, what) {
    r <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = 1L, replicates = 200L, job_id = "job_n48e"))
    list(what = what, codes = vcr_test_issue_codes(r), fields = vapply(r$diagnostics$issues %||% list(), function(i) paste0(i$code, "@", i$field), character(1)), failed = identical(r$status, "failed"))
  }
  z_no_sd <- .n48_mean(method = "one_sample_z")
  wrong <- .n48_mean(); wrong$analysis$method <- "exact_binomial"
  bin_on_mean <- .n48_mean(); bin_on_mean$endpoint$type <- "binary"
  corr <- .n48_mean(); corr$truth$baselineCorrelation <- 0.3
  rates <- .n48_mean(); rates$truth$responseRate <- 0.4
  no_effect <- .n48_mean(); no_effect$truth$effect <- NULL
  both <- .n48_surv(); both$truth$controlDistribution <- list(kind = "exponential", rate = 0.05)
  sided <- .n48_mean(alternative = "two.sided", sided = 1)
  ext <- list(design = list(kind = "single_arm_external", n = 40), endpoint = list(type = "continuous"), truth = list(effect = 1), analysis = list(method = "stratified_risk_difference", estimand = "ATT"))
  simon <- list(design = list(kind = "simon_two_stage", n1 = 10, n = 29, r1 = 1, r = 5), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12), analysis = list(method = "simon_boundary"))
  one_patient <- .n48_mean(n = 1)
  got <- list(refuse(z_no_sd, "z without sd"), refuse(wrong, "binary analysis on a mean"), refuse(bin_on_mean, "t on a binary endpoint"), refuse(corr, "baseline correlation"),
              refuse(rates, "response rate on a mean"), refuse(no_effect, "no effect"), refuse(both, "two benchmarks"), refuse(sided, "sided vs alternative"),
              refuse(ext, "external control on a mean"), refuse(simon, "Simon on survival"), refuse(one_patient, "one patient"))
  all_failed <- all(vapply(got, function(g) g$failed, logical(1)))
  has <- function(i, key) any(grepl(key, got[[i]]$fields, fixed = TRUE)) || any(grepl(key, got[[i]]$codes, fixed = TRUE))
  named <- has(1, "scenario_field_missing@scenario.analysis.sd") && has(2, "scenario_value_invalid@scenario.analysis.method") && has(4, "scenario_field_unknown@scenario.truth.baselineCorrelation") &&
    has(5, "scenario_field_unknown@scenario.truth.responseRate") && has(6, "scenario_field_missing@scenario.truth.effect") && has(8, "scenario_value_invalid@scenario.analysis.sided") &&
    has(9, "design_not_supported") && has(10, "design_not_supported") && has(11, "scenario_value_invalid")
  version <- function(sc, v) { j <- vcr_test_job("design.simulate", sc, seed = 1L, replicates = 200L, job_id = "job_n48e"); j$methodVersion <- v; as.character(.n00_issue_keys(vcr_validate_job(vcr_test_json(j)))) }
  binary_sc <- list(design = list(kind = "single_arm", n = 30), endpoint = list(type = "binary"), truth = list(nullRate = 0.2, responseRate = 0.4), analysis = list(method = "exact_binomial", alternative = "greater", sided = 1, alpha = 0.05))
  v_ok <- !length(version(binary_sc, "1.1.0")) && !length(version(.n48_mean(), "1.2.0")) && "method_version_mismatch@methodVersion" %in% version(.n48_mean(), "1.1.0") &&
    "method_version_mismatch@methodVersion" %in% version(.n48_surv(), "1.1.0") && !length(version(list(design = list(kind = "two_arm_fixed", nTreat = 50, nControl = 50), endpoint = list(type = "continuous"), truth = list(effect = 0.4, sd = 1),
      analysis = list(method = "ttest")), "1.0.0"))
  list(pass = all_failed && named && v_ok && identical(d$methods[["design.simulate"]]$version, "1.2.0") && identical(d$methods[["design.grid"]]$version, "1.2.0"),
       detail = sprintf("%d of 11 malformed single-arm scenarios refused by name (%s); version %s: a continuous or survival job labelled 1.1.0 is refused, the binary single-arm job at 1.1.0 and a two-arm job at 1.0.0 stay valid",
                        sum(vapply(got, function(g) g$failed, logical(1))), paste(vapply(got, function(g) paste0(g$what, ": ", paste(unique(g$codes), collapse = "+")), character(1)), collapse = "; "), d$methods[["design.simulate"]]$version))
})
