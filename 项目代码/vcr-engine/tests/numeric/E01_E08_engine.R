# E01-E08 — cases this engine adds beyond C1's table: accrual, cancellation
# and budget, count separation, input discipline, and the analytic/simulated
# agreement across all three endpoint families.

vcr_case("E01", c("AC-30", "AC-28"), function() {
  # Poisson-gamma accrual: the closed form (beta-prime / F) and the simulation
  # are two independent implementations and must agree inside Monte-Carlo error.
  model <- vcr_accrual_model(n_sites = 20L, alpha = 2, beta = 2.5)
  by <- c(10, 12, 15)
  cf <- vcr_accrual_closed_form(model, target = 200L, by_times = by)
  sim <- vcr_accrual_simulate(model, target = 200L, replicates = 20000L, seed = 11L,
                              cores = VCR_TEST_CORES, by_times = by)
  d_mean <- abs(cf$mean - sim$mean) / sim$mcseMean
  d_prob <- abs(cf$probabilityBy - sim$probabilityBy) / sim$probabilityByMcse
  ok <- d_mean <= 3 && all(d_prob <= 3)
  list(pass = ok,
       detail = sprintf("mean completion closed form %.5f vs simulated %.5f (+-%.5f) = %.2f MCSE; P(by 10/12/15) %.5f/%.5f/%.5f vs %.5f/%.5f/%.5f = %.2f/%.2f/%.2f MCSE",
                        cf$mean, sim$mean, sim$mcseMean, d_mean,
                        cf$probabilityBy[1], cf$probabilityBy[2], cf$probabilityBy[3],
                        sim$probabilityBy[1], sim$probabilityBy[2], sim$probabilityBy[3],
                        d_prob[1], d_prob[2], d_prob[3]))
})

vcr_case("E02", c("AC-37"), function() {
  # Back-test: 300 historical trials drawn from a known Poisson-gamma, each
  # forecast from its own first 30% of enrolment. The realized completion time
  # must fall inside the 80% prediction interval about 80% of the time.
  set.seed(37L, kind = VCR_RNG_KIND)
  n_trials <- 300L
  target <- 120L
  model <- vcr_accrual_model(n_sites = 12L, alpha = 2, beta = 2.5)
  actual <- numeric(n_trials); lo <- numeric(n_trials); hi <- numeric(n_trials)
  for (i in seq_len(n_trials)) {
    rates <- stats::rgamma(model$nSites, shape = model$alpha, rate = model$beta)
    gaps <- stats::rexp(target, sum(rates))
    times <- cumsum(gaps)
    seen <- floor(target * 0.3)
    as_of <- times[seen]
    enrolled_by_site <- as.vector(stats::rmultinom(1L, seen, rates / sum(rates)))
    upd <- vcr_accrual_update(model, enrolled_by_site, rep(as_of, model$nSites))
    fc <- vcr_accrual_forecast(model, upd, remaining = target - seen, as_of = as_of,
                               replicates = 600L, seed = 1000L + i, cores = 1L)
    actual[i] <- times[target]
    lo[i] <- stats::quantile(fc$samples, 0.1, names = FALSE)
    hi[i] <- stats::quantile(fc$samples, 0.9, names = FALSE)
  }
  inside <- actual >= lo & actual <= hi
  coverage <- mean(inside)
  mcse <- sqrt(coverage * (1 - coverage) / n_trials)
  ok <- abs(coverage - 0.8) <= 3 * mcse
  list(pass = ok,
       detail = sprintf("80%% prediction interval covers %.4f of %d back-tested trials (+-%.4f, %.2f MCSE from 0.80); %.3f below, %.3f above",
                        coverage, n_trials, mcse, abs(coverage - 0.8) / mcse,
                        mean(actual < lo), mean(actual > hi)))
})

vcr_case("E03", c("AC-19", "AC-38"), function() {
  # Cancel keeps completed batches; a spent CPU budget stops without losing
  # them; the checkpoint resumes into exactly the same numbers.
  sc <- list(design = list(kind = "two_arm_fixed", nTreat = 100, nControl = 100),
             endpoint = list(type = "continuous"), truth = list(effect = 0.3, sd = 1),
             analysis = list(method = "ttest", alpha = 0.025, sided = 1),
             performance = c("power", "bias"))
  dir <- tempfile("e03"); dir.create(dir)
  cp <- file.path(dir, "checkpoint.rds"); cancel <- file.path(dir, "CANCEL")
  part <- vcr_run_simulation(sc, seed = 303L, replicates = 4000L, cores = 1L, checkpoint = cp,
                             batch_size = 250L, cancel_file = cancel,
                             progress = function(done, total) if (done >= 750L) file.create(cancel))
  kept <- part$diagnostics$replicatesCompleted
  cp_exists <- file.exists(cp)
  file.remove(cancel)
  resumed <- vcr_run_simulation(sc, seed = 303L, replicates = 4000L, cores = VCR_TEST_CORES,
                                checkpoint = cp, batch_size = 250L)
  full <- vcr_run_simulation(sc, seed = 303L, replicates = 4000L, cores = 1L, batch_size = 250L)
  ser <- function(r) paste(vapply(r$measures, function(m) vcr_num_to_json(m$value), character(1)), collapse = ";")
  # A CPU budget of zero stops on the first check and keeps nothing, but says so.
  budget <- vcr_run_simulation(sc, seed = 303L, replicates = 4000L, cores = 1L,
                               batch_size = 250L, cpu_seconds_limit = 1e-9)
  unlink(dir, recursive = TRUE)
  ok <- identical(part$status, "canceled") && kept == 750L && cp_exists &&
    length(part$measures) > 0L && identical(ser(resumed), ser(full)) &&
    identical(budget$status, "failed") && isTRUE(budget$diagnostics$overCpuBudget)
  list(pass = ok,
       detail = sprintf("cancel at 750/4000: status %s, %d replicates kept with measures (%d reported), checkpoint on disk %s; resumed result bit-identical to uninterrupted: %s; spent budget -> status %s, overCpuBudget %s",
                        part$status, kept, length(part$measures), cp_exists,
                        identical(ser(resumed), ser(full)), budget$status,
                        budget$diagnostics$overCpuBudget))
})

vcr_case("E04", c("AC-08", "AC-09"), function() {
  # The four counts are separate, `NULL` is the only stand-in for unknown, and
  # an effective sample size never exceeds the real patients it weights.
  ok_counts <- length(vcr_validate_counts(vcr_counts(realPatients = 400, events = 138,
                                                     effectiveSampleSize = 98.4, generatedRecords = 0))) == 0L
  ess_too_big <- vcr_validate_counts(list(realPatients = 50, effectiveSampleSize = 90, generatedRecords = 10))
  # ...whether or not any record was generated (the guard used to need one).
  ess_no_generated <- vcr_validate_counts(list(realPatients = 50, effectiveSampleSize = 90, generatedRecords = 0))
  negative <- vcr_validate_counts(list(realPatients = -1))
  unknown_ok <- length(vcr_validate_counts(vcr_counts(realPatients = NULL))) == 0L
  # And the keys are exactly the domain's.
  d <- vcr_domain()
  keys <- names(vcr_counts(priorEffectiveSampleSize = 1, reconstructedPseudoPatients = 2))
  keys_ok <- identical(keys, c(d$countKeys, d$optionalCountKeys))
  ok <- ok_counts && length(ess_too_big) == 1L &&
    identical(ess_too_big[[1]]$code, "ess_above_real") &&
    length(ess_no_generated) == 1L && identical(ess_no_generated[[1]]$code, "ess_above_real") &&
    length(negative) == 1L && unknown_ok && keys_ok
  list(pass = ok,
       detail = sprintf("valid counts accepted; ESS 90 on 50 real patients -> %s (also with 0 generated records: %s); realPatients -1 -> %s; NULL accepted as 'not knowable'; keys %s match the domain",
                        ess_too_big[[1]]$code, if (length(ess_no_generated)) ess_no_generated[[1]]$code else "MISSED",
                        negative[[1]]$code, paste(keys, collapse = "/")))
})

vcr_case("E05", c("AC-04", "AC-28"), function() {
  # Health, and: every one of the handlers answers a real job through
  # `vcr_run_job` with a protocol-valid result -- the echo of what was asked, a
  # named conclusion, a value source on every measure, an output hash the
  # control plane can recompute and no absolute path in a table row.
  h <- vcr_engine_health()
  cases <- vcr_test_handler_jobs()
  d <- vcr_domain()
  out <- lapply(seq_along(cases), function(i) {
    cs <- cases[[i]]
    job <- vcr_test_job(cs[[1]], cs[[2]], cs[[3]], seed = 5L, replicates = if (length(cs) >= 4L) cs[[4]] else NULL, job_id = sprintf("job_e05_%02d", i))
    dir <- tempfile("e05"); dir.create(dir)
    r <- vcr_test_run(job, output_dir = dir)
    want_hash <- vcr_scenario_hash(vcr_test_json(job)$scenario)
    echo_ok <- identical(r$jobId, job$jobId) && identical(r$method, job$method) && identical(r$methodVersion, d$methods[[job$method]]$version) &&
      identical(r$scenarioHash, want_hash) && identical(as.integer(r$seed), job$seed)
    sources_ok <- all(vapply(r$measures, function(m) isTRUE(m$source %in% d$valueSources), logical(1)))
    hash_ok <- is.character(r$manifest$outputHash) && identical(r$manifest$outputHash, vcr_output_hash(r))
    paths_ok <- all(vapply(r$tables, function(t) !grepl("^/", t$location) && !grepl("\\.\\.", t$location), logical(1)))
    conclusion_ok <- isTRUE(r$conclusion %in% c("estimable", "limited"))
    unlink(dir, recursive = TRUE)
    list(method = job$method, status = r$status, issues = length(vcr_validate_result(r)), measures = length(r$measures),
         ok = identical(r$status, "succeeded") && length(vcr_validate_result(r)) == 0L && length(r$measures) > 0L &&
           echo_ok && sources_ok && hash_ok && paths_ok && conclusion_ok,
         why = paste(c(if (!echo_ok) "echo", if (!sources_ok) "source", if (!hash_ok) "outputHash", if (!paths_ok) "path", if (!conclusion_ok) "conclusion",
                       vcr_test_issue_codes(r)), collapse = "+"))
  })
  bad <- Filter(function(o) !o$ok, out)
  ok <- isTRUE(h$ok) && length(bad) == 0L && length(out) == length(d$methods)
  list(pass = ok,
       detail = sprintf("health ok=%s, %d methods, lock %s; %d/%d handler results succeed, validate, echo the job, carry a source on every measure and a recomputable output hash%s",
                        h$ok, length(h$methods), substr(h$packageLockHash, 1, 12), length(out) - length(bad), length(out),
                        if (length(bad)) paste0("; failing: ", paste(vapply(bad, function(b) sprintf("%s(%s)", b$method, b$why), character(1)), collapse = ", ")) else ""))
})

vcr_case("E06", c("AC-26", "AC-04"), function() {
  # The engine reads only what the job names, under the data root, and refuses
  # a table whose bytes changed after the job was frozen.
  set.seed(6L, kind = VCR_RNG_KIND)
  df <- data.frame(USUBJID = sprintf("S%03d", 1:120), arm = rep(0:1, each = 60), x1 = stats::rnorm(120), y = stats::rnorm(120))
  input <- vcr_test_input(df, "snp_e06:subject", "subject")
  mk <- function(inp) vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x1"), outcomeColumn = "y", treatmentColumn = "arm", endpoint = list(type = "continuous")),
    list(inp), seed = 6L, job_id = "job_e06")
  good <- vcr_test_run(mk(input))
  path <- file.path(vcr_test_data_root(), input$location)
  df$y[1] <- df$y[1] + 1                       # somebody rewrote the file after the job was frozen
  utils::write.csv(df, path, row.names = FALSE)
  tampered <- vcr_test_run(mk(input))
  # A patient-level job that names no table at all is refused before it runs.
  bare <- mk(input); bare$inputs <- list(list(kind = "assumption", id = "asm_x@1"))
  no_table <- vcr_test_run(bare)
  # A synthetic table is not an external control.
  syn_input <- vcr_test_input(df, "snp_e06:syn", "subject", source = "synthetic")
  synthetic <- vcr_test_run(mk(syn_input))
  codes <- list(tampered = vcr_test_issue_codes(tampered), bare = vcr_test_issue_codes(no_table), syn = vcr_test_issue_codes(synthetic))
  ok <- identical(good$status, "succeeded") && identical(tampered$status, "failed") && "input_hash_mismatch" %in% codes$tampered &&
    identical(no_table$status, "failed") && "patient_input_required" %in% codes$bare &&
    identical(synthetic$status, "failed") && "input_source_not_individual" %in% codes$syn &&
    length(tampered$measures) == 0L
  list(pass = ok,
       detail = sprintf("frozen hash accepted (status %s); one byte changed -> status %s (%s); patient-level job with no table -> %s; synthetic table as external control -> %s",
                        good$status, tampered$status, paste(codes$tampered, collapse = ","), paste(codes$bare, collapse = ","), paste(codes$syn, collapse = ",")))
})

vcr_case("E07", c("AC-29"), function() {
  # Analytic first, simulation as the check, on all three endpoint families at
  # once: every difference must be inside 3 Monte-Carlo standard errors. The
  # time-to-event row used to be excused (0.015 absolute, and "within a factor
  # of three of rpact's own gap"): that excuse was covering a real defect, the
  # treated arm entering the trial first, which handed it the longest follow-up
  # and made the simulated power 3-4 points high (CE-1). With entry times drawn
  # independently of arm, and the analytic reference using the variance of the
  # score under the alternative, the strict rule holds.
  scenarios <- list(
    continuous = list(design = list(kind = "two_arm_fixed", nTreat = 180, nControl = 180),
                      endpoint = list(type = "continuous"), truth = list(effect = 0.3, sd = 1),
                      analysis = list(method = "ttest", alpha = 0.025, sided = 1),
                      performance = list("power")),
    binary = list(design = list(kind = "two_arm_fixed", nTreat = 300, nControl = 300),
                  endpoint = list(type = "binary"), truth = list(controlRate = 0.30, treatmentRate = 0.42),
                  analysis = list(method = "risk_difference", alpha = 0.025, sided = 1),
                  performance = list("power")),
    time_to_event = list(design = list(kind = "two_arm_fixed", nTreat = 300, nControl = 300),
                         endpoint = list(type = "time_to_event"),
                         truth = list(controlMedian = 12, hazardRatio = 0.7),
                         analysis = list(method = "logrank", alpha = 0.025, sided = 1),
                         accrual = list(kind = "uniform", duration = 12, followup = 18),
                         performance = list("power")))
  # The plan's own floor for an alternative scenario (5,000 replicates) is what
  # AC-29 is written against; the jobs run through the JSON path the service uses.
  rows <- lapply(names(scenarios), function(nm) {
    r <- vcr_test_run(vcr_test_job("design.simulate", scenarios[[nm]], seed = 707L, cores = VCR_TEST_CORES))
    check <- r$diagnostics$analyticCheck
    list(name = nm, analytic = check$value, simulated = check$simulated,
         ratio = check$differenceInMcse, absolute = abs(check$difference),
         replicates = r$diagnostics$replicatesCompleted,
         ok = identical(r$status, "succeeded") && isTRUE(check$withinThreeMcse))
  })
  names(rows) <- names(scenarios)
  ok <- all(vapply(rows, function(r) r$ok, logical(1)))
  list(pass = ok,
       detail = paste(vapply(rows, function(r)
         sprintf("%s analytic %.4f vs simulated %.4f (|d| %.4f = %.2f MCSE, %d reps)",
                 r$name, r$analytic, r$simulated, r$absolute, r$ratio, r$replicates),
         character(1)), collapse = "; "))
})

vcr_case("E07b", c("AC-29", "AC-10"), function() {
  # A null scenario that arrives through JSON has effect 0L and hazardRatio 1L
  # (integers), and `identical(0L, 0)` is FALSE: the analytic cross-check used to
  # vanish for every null scenario the service ran (EB-18). Each family, through
  # the JSON path, must carry an analytic check whose value is the nominal alpha
  # and whose difference from the simulated type-I error is inside 3 MCSE.
  scenarios <- list(
    continuous = list(design = list(kind = "two_arm_fixed", nTreat = 100, nControl = 100), endpoint = list(type = "continuous"),
                      truth = list(effect = 0L, sd = 1), analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("type_one_error")),
    time_to_event = list(design = list(kind = "two_arm_fixed", nTreat = 100, nControl = 100), endpoint = list(type = "time_to_event"),
                         truth = list(controlMedian = 12, hazardRatio = 1L), analysis = list(method = "logrank", alpha = 0.025, sided = 1),
                         accrual = list(kind = "uniform", duration = 6, followup = 12), performance = list("type_one_error")))
  rows <- lapply(names(scenarios), function(nm) {
    r <- vcr_test_run(vcr_test_job("design.simulate", scenarios[[nm]], seed = 717L, replicates = 20000L, cores = VCR_TEST_CORES))
    chk <- r$diagnostics$analyticCheck
    list(name = nm, class = class(vcr_test_json(vcr_test_job("design.simulate", scenarios[[nm]]))$scenario$truth[[if (nm == "continuous") "effect" else "hazardRatio"]]),
         has = !is.null(chk), name_ok = identical(chk$name, "type_one_error"), value = chk$value, ratio = chk$differenceInMcse,
         ok = !is.null(chk) && identical(chk$name, "type_one_error") && isTRUE(chk$withinThreeMcse) && abs(chk$value - 0.025) < 1e-12)
  })
  list(pass = all(vapply(rows, function(r) r$ok, logical(1))),
       detail = paste(vapply(rows, function(r) sprintf("%s (JSON class %s): analytic check present %s, nominal %.4f, %.2f MCSE from the simulation",
                                                       r$name, r$class, r$has, r$value %||% NA_real_, r$ratio %||% NA_real_), character(1)), collapse = "; "))
})

vcr_case("E08", c("AC-10", "AC-29", "AC-30"), function() {
  # A group-sequential design, in calendar time, three ways:
  #  (a) under the null its simulated type-I error equals the alpha the design
  #      spends, and its expected number of analyses equals the exit
  #      probabilities the spending function implies (analytic, exact);
  #  (b) under an alternative the trial stops early on average, and the events
  #      and the sample size REPORTED are those at the stopping look, with
  #      their Monte-Carlo errors (they used to be the full trial's, for every
  #      replicate, so a design that stops early looked as expensive as one
  #      that never does, CE-9);
  #  (c) a two-sided design also rejects on the harmful side (it used to test
  #      one tail whatever `sided` said).
  rates <- c(1, 2, 3) / 3
  design <- vcr_group_sequential(rates, alpha = 0.025, spending = "obrien_fleming")
  base <- list(design = list(kind = "group_sequential", nTreat = 250, nControl = 250, informationRates = as.list(rates), spending = "obrien_fleming"),
               endpoint = list(type = "time_to_event"), truth = list(controlMedian = 12, hazardRatio = 1),
               analysis = list(method = "logrank", alpha = 0.025, sided = 1),
               accrual = list(kind = "uniform", duration = 12, followup = 18), performance = list("type_one_error", "expected_sample_size"))
  null <- vcr_test_run(vcr_test_job("design.simulate", base, seed = 808L, replicates = 20000L, cores = VCR_TEST_CORES))
  t1e <- vcr_get_measure(null, "type_one_error")
  spent <- design$cumulativeAlphaSpent[3]
  looks <- vcr_get_measure(null, "expected_analyses")
  exit0 <- design$alphaSpent                                     # P(stop at k) under H0
  want_looks <- sum(seq_along(exit0) * exit0) + 3 * (1 - sum(exit0))
  ok_null <- identical(null$status, "succeeded") && abs(t1e$value - spent) <= 3 * t1e$mcse &&
    abs(looks$value - want_looks) <= 3 * looks$mcse + 1e-3

  alt <- utils::modifyList(base, list(truth = list(hazardRatio = 0.55), performance = list("power", "expected_sample_size")))
  fixed <- alt; fixed$design <- list(kind = "two_arm_fixed", nTreat = 250, nControl = 250)
  r_alt <- vcr_test_run(vcr_test_job("design.simulate", alt, seed = 809L, replicates = 4000L, cores = VCR_TEST_CORES))
  r_fix <- vcr_test_run(vcr_test_job("design.simulate", fixed, seed = 809L, replicates = 4000L, cores = VCR_TEST_CORES))
  ev_alt <- vcr_get_measure(r_alt, "expected_events"); ev_fix <- vcr_get_measure(r_fix, "expected_events")
  n_alt <- vcr_get_measure(r_alt, "expected_sample_size")
  early <- vcr_get_measure(r_alt, "expected_analyses")
  reduced <- ev_alt$value < ev_fix$value - 5 * sqrt(ev_alt$mcse^2 + ev_fix$mcse^2) && n_alt$value < 500 - 5 * n_alt$mcse &&
    early$value < 3 - 5 * early$mcse && is.finite(ev_alt$mcse) && is.finite(n_alt$mcse) && n_alt$mcse > 0

  two <- utils::modifyList(base, list(truth = list(hazardRatio = 1.5), analysis = list(method = "logrank", alpha = 0.05, sided = 2), performance = list("power")))
  r_two <- vcr_test_run(vcr_test_job("design.simulate", two, seed = 810L, replicates = 2000L, cores = VCR_TEST_CORES))
  harm <- vcr_get_measure(r_two, "power")
  ok_two <- !is.null(harm) && harm$value > 0.5

  list(pass = ok_null && reduced && ok_two,
       detail = sprintf("H0: boundaries %.4f/%.4f/%.4f, simulated type-I %.5f (+-%.5f) = %.2f MCSE from spent %.4f, expected analyses %.4f vs %.4f from the exit probabilities; H1 (HR .55): events at stop %.1f vs %.1f in the fixed design, sample size at stop %.1f of 500 (+-%.2f), analyses %.3f of 3; two-sided vs harm (HR 1.5): power %.3f",
                        design$criticalValues[1], design$criticalValues[2], design$criticalValues[3],
                        t1e$value, t1e$mcse, abs(t1e$value - spent) / t1e$mcse, spent, looks$value, want_looks,
                        ev_alt$value, ev_fix$value, n_alt$value, n_alt$mcse, early$value, harm$value %||% NA_real_))
})
