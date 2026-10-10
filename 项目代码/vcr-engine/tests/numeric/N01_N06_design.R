# N01-N06 — design calculations, Monte-Carlo precision and reproducibility.

vcr_case("N01", c("AC-30", "AC-04"), function() {
  d <- vcr_group_sequential(c(1, 2, 3) / 3, alpha = 0.025, spending = "obrien_fleming")
  want <- c(3.7103, 2.5114, 1.9930)
  suppressMessages(library(rpact)); suppressMessages(library(gsDesign))
  rp <- rpact::getDesignGroupSequential(kMax = 3, alpha = 0.025, sided = 1,
                                        typeOfDesign = "asOF", informationRates = c(1, 2, 3) / 3)$criticalValues
  gd <- gsDesign::gsDesign(k = 3, test.type = 1, alpha = 0.025,
                           sfu = gsDesign::sfLDOF, timing = c(1, 2, 3) / 3)$upper$bound
  dz <- max(abs(d$criticalValues - rp), abs(d$criticalValues - gd))
  ok <- dz < 1e-4 && max(abs(round(d$criticalValues, 4) - want)) < 1e-9
  list(pass = ok, detail = sprintf("%.4f/%.4f/%.4f (ours %.7f/%.7f/%.7f); max|dz| vs rpact+gsDesign %.2e (tol 1e-4)",
                                   d$criticalValues[1], d$criticalValues[2], d$criticalValues[3],
                                   d$criticalValues[1], d$criticalValues[2], d$criticalValues[3], dz))
})

vcr_case("N01b", c("AC-30", "AC-10"), function() {
  # The group-sequential calculation through the job, and `sided` honoured: a
  # two-sided 0.05 design spends 0.025 per tail, so its boundaries are the
  # one-sided 0.025 boundaries; one-sided 0.05 is a different (lower) set. The
  # first version ignored `sided` here and everywhere else. Pocock with four
  # looks is checked against rpact and gsDesign as well.
  suppressMessages(library(rpact)); suppressMessages(library(gsDesign))
  mk <- function(alpha, sided, rates = c(0.5, 1), spending = "obrien_fleming") vcr_test_job("design.analytic",
    list(design = list(kind = "group_sequential", informationRates = as.list(rates), spending = spending),
         endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12),
         analysis = list(alpha = alpha, sided = sided, power = 0.9)))
  bounds <- function(r) vapply(seq_len(6), function(k) vcr_measure_value(r, sprintf("boundary_%d", k)), numeric(1))
  two <- vcr_test_run(mk(0.05, 2)); one025 <- vcr_test_run(mk(0.025, 1)); one05 <- vcr_test_run(mk(0.05, 1))
  b2 <- bounds(two)[1:2]; b1 <- bounds(one025)[1:2]; b05 <- bounds(one05)[1:2]
  ref <- vcr_group_sequential(c(0.5, 1), 0.025, "obrien_fleming")$criticalValues
  # inflation and expected information against rpact's own numbers
  rp <- rpact::getDesignGroupSequential(kMax = 2, alpha = 0.025, sided = 1, typeOfDesign = "asOF", informationRates = c(0.5, 1))
  p4 <- vcr_test_run(mk(0.025, 1, c(0.25, 0.5, 0.75, 1), "pocock"))
  b4 <- vapply(1:4, function(k) vcr_measure_value(p4, sprintf("boundary_%d", k)), numeric(1))
  g4 <- gsDesign::gsDesign(k = 4, test.type = 1, alpha = 0.025, sfu = gsDesign::sfLDPocock, timing = c(0.25, 0.5, 0.75, 1))$upper$bound
  d_rp <- max(abs(b1 - rp$criticalValues)); d_g4 <- max(abs(b4 - g4))
  infl_rp <- rpact::getDesignCharacteristics(rp)$inflationFactor
  events_gs <- vcr_measure_value(one025, "max_events"); events_fixed <- vcr_measure_value(one025, "required_events")
  ok <- max(abs(b2 - ref)) < 1e-9 && max(abs(b1 - ref)) < 1e-9 && max(abs(b05 - ref)) > 0.05 &&
    d_rp < 1e-4 && d_g4 < 1e-4 && abs(events_gs / events_fixed - infl_rp) < 0.002
  list(pass = ok,
       detail = sprintf("two-sided 0.05 boundaries %.5f/%.5f = one-sided 0.025 (%.5f/%.5f); one-sided 0.05 differs by %.3f; vs rpact |d| %.1e; 4-look Pocock vs gsDesign |d| %.1e; max events / fixed events %.4f vs rpact inflation factor %.4f",
                        b2[1], b2[2], b1[1], b1[2], max(abs(b05 - ref)), d_rp, d_g4, events_gs / events_fixed, infl_rp))
})


vcr_case("N02", c("AC-11", "AC-29", "AC-30"), function() {
  ev <- vcr_events_schoenfeld(0.7, alpha = 0.025, power = 0.9, allocation = 0.5, sided = 1)
  events_ok <- ceiling(ev) == 331L && abs(ev - 330.4) < 0.5
  # Simulated power at exactly that many events, 5,000 replicates -> MCSE 0.0042.
  sc <- list(design = list(kind = "two_arm_fixed", nTreat = 400, nControl = 400),
             endpoint = list(type = "time_to_event"),
             truth = list(controlMedian = 12, hazardRatio = 0.7),
             analysis = list(method = "logrank", alpha = 0.025, sided = 1),
             accrual = list(kind = "uniform", duration = 0, followup = Inf, maxFollowup = 10.97),
             performance = c("power"))
  r <- vcr_run_simulation(sc, seed = 331331, replicates = 5000L, cores = VCR_TEST_CORES)
  pw <- Filter(function(m) m$name == "power", r$measures)[[1]]
  evm <- Filter(function(m) m$name == "expected_events", r$measures)[[1]]
  # Analytic power at the events actually observed, then compare within 3 MCSE.
  z <- -log(0.7) * sqrt(evm$value * 0.25) - qnorm(0.975)
  analytic <- pnorm(z)
  w <- vcr_within_mcse(pw$value, analytic, pw$mcse, 3)
  list(pass = events_ok && w$pass,
       detail = sprintf("Schoenfeld %.4f -> %d events (want 331); simulated power %.4f vs analytic %.4f at %.1f events, %.2f MCSE (mcse %.4f)",
                        ev, ceiling(ev), pw$value, analytic, evm$value, w$ratio, pw$mcse))
})

vcr_case("N03", c("AC-10", "AC-28", "AC-29"), function() {
  # Type-I error at the null for all three endpoint families, 20,000
  # replicates each -> MCSE 0.0011, acceptance band [0.0217, 0.0283].
  scenarios <- list(
    continuous = list(design = list(kind = "two_arm_fixed", nTreat = 150, nControl = 150),
                      endpoint = list(type = "continuous"), truth = list(effect = 0, sd = 1),
                      analysis = list(method = "ttest", alpha = 0.025, sided = 1),
                      performance = c("type_one_error")),
    binary = list(design = list(kind = "two_arm_fixed", nTreat = 400, nControl = 400),
                  endpoint = list(type = "binary"), truth = list(controlRate = 0.3, treatmentRate = 0.3),
                  analysis = list(method = "risk_difference", alpha = 0.025, sided = 1),
                  performance = c("type_one_error")),
    time_to_event = list(design = list(kind = "two_arm_fixed", nTreat = 200, nControl = 200),
                         endpoint = list(type = "time_to_event"),
                         truth = list(controlMedian = 12, hazardRatio = 1),
                         analysis = list(method = "logrank", alpha = 0.025, sided = 1),
                         accrual = list(kind = "uniform", duration = 12, followup = 24),
                         performance = c("type_one_error"))
  )
  out <- lapply(names(scenarios), function(nm) {
    r <- vcr_run_simulation(scenarios[[nm]], seed = 424242L, replicates = 20000L, cores = VCR_TEST_CORES)
    m <- Filter(function(x) x$name == "type_one_error", r$measures)[[1]]
    list(name = nm, value = m$value, mcse = m$mcse)
  })
  band <- c(0.0217, 0.0283)
  ok <- all(vapply(out, function(o) o$value >= band[1] && o$value <= band[2], logical(1)))
  list(pass = ok,
       detail = paste(vapply(out, function(o) sprintf("%s %.4f(+-%.4f)", o$name, o$value, o$mcse), character(1)),
                      collapse = " "))
})

vcr_case("N04", c("AC-11", "AC-28"), function() {
  # Coverage at 2,000 replicates -> MCSE 0.0049, band [0.935, 0.965]; one-sided
  # (alpha 0.025 per tail) and two-sided (alpha 0.05 total, 0.025 per tail): both
  # must report a 95% interval. The two-sided analysis used `alpha` per tail in
  # its interval, i.e. a 90% interval that called itself nominal, and the
  # one-sided-only case could not see it (CE-8).
  run <- function(sided, alpha, seed) {
    sc <- list(design = list(kind = "two_arm_fixed", nTreat = 150, nControl = 150),
               endpoint = list(type = "continuous"), truth = list(effect = 0.3, sd = 1),
               analysis = list(method = "ttest", alpha = alpha, sided = sided),
               performance = list("bias", "coverage"))
    r <- vcr_run_simulation(sc, seed = seed, replicates = 2000L, cores = VCR_TEST_CORES)
    list(cov = Filter(function(m) m$name == "coverage", r$measures)[[1]], bias = Filter(function(m) m$name == "bias", r$measures)[[1]])
  }
  one <- run(1, 0.025, 90210L); two <- run(2, 0.05, 90211L)
  band <- function(x) x$cov$value >= 0.935 && x$cov$value <= 0.965
  ok <- band(one) && band(two) && abs(one$bias$value) <= 3 * one$bias$mcse && abs(two$bias$value) <= 3 * two$bias$mcse
  list(pass = ok, detail = sprintf("one-sided alpha .025: coverage %.4f (+-%.4f, band 0.935-0.965), bias %.5f = %.2f MCSE; two-sided alpha .05: coverage %.4f (+-%.4f), bias %.5f = %.2f MCSE",
                                   one$cov$value, one$cov$mcse, one$bias$value, abs(one$bias$value) / one$bias$mcse,
                                   two$cov$value, two$cov$mcse, two$bias$value, abs(two$bias$value) / two$bias$mcse))
})

vcr_case("N04b", c("AC-29", "AC-30"), function() {
  # Sidedness in the analytic reference too: a two-sided analysis' simulated
  # power equals the analytic two-sided power inside 3 MCSE for all three
  # families (the reference used to be one-sided whatever `sided` said).
  scenarios <- list(
    continuous = list(design = list(kind = "two_arm_fixed", nTreat = 120, nControl = 120), endpoint = list(type = "continuous"),
                      truth = list(effect = 0.3, sd = 1), analysis = list(method = "ttest", alpha = 0.05, sided = 2), performance = list("power")),
    binary = list(design = list(kind = "two_arm_fixed", nTreat = 200, nControl = 200), endpoint = list(type = "binary"),
                  truth = list(controlRate = 0.3, treatmentRate = 0.42), analysis = list(method = "risk_difference", alpha = 0.05, sided = 2), performance = list("power")),
    time_to_event = list(design = list(kind = "two_arm_fixed", nTreat = 250, nControl = 250), endpoint = list(type = "time_to_event"),
                         truth = list(controlMedian = 12, hazardRatio = 0.7), analysis = list(method = "logrank", alpha = 0.05, sided = 2),
                         accrual = list(kind = "uniform", duration = 12, followup = 18), performance = list("power")))
  rows <- lapply(names(scenarios), function(nm) {
    r <- vcr_run_simulation(scenarios[[nm]], seed = 4004L, replicates = 5000L, cores = VCR_TEST_CORES)
    chk <- vcr_analytic_check(scenarios[[nm]], r$measures)
    one_sided <- { s1 <- scenarios[[nm]]; s1$analysis$sided <- 1; s1$analysis$alpha <- 0.025; vcr_analytic_check(s1, r$measures)$value }
    list(name = nm, analytic = chk$value, sim = chk$simulated, ratio = chk$differenceInMcse, ok = isTRUE(chk$withinThreeMcse), one = one_sided)
  })
  list(pass = all(vapply(rows, function(r) r$ok, logical(1))),
       detail = paste(vapply(rows, function(r) sprintf("%s two-sided analytic %.4f vs simulated %.4f (%.2f MCSE)", r$name, r$analytic, r$sim, r$ratio), character(1)), collapse = "; "))
})

vcr_case("N04c", c("AC-29", "AC-30"), function() {
  # The log-rank analytic reference at STRONG effects and unequal allocation, where
  # a reference that is only right for local alternatives shows. The second version
  # of it used the martingale variance of the score under the alternative and read
  # 0.937 for a 2:1 trial at hazard ratio 0.534 whose true power is 0.963 (10 MCSE
  # low -- the virtual-patients chain in E09 tripped over it), 0.893 at HR 0.5 (true
  # 0.903) and 0.910 at HR 0.4 (true 0.930). Three designs, each checked twice: the
  # engine's simulator against an INDEPENDENT one written here (`survival::survdiff`,
  # its own random draws and its own censoring), and the reference against the
  # engine's simulator inside 3 MCSE.
  suppressMessages(library(survival))
  designs <- list(list(hr = 0.534, med = 2.86, n1 = 120, n0 = 60, dur = 16.4, fu = 6),
                  list(hr = 0.5, med = 6, n1 = 60, n0 = 60, dur = 12, fu = 12),
                  list(hr = 0.4, med = 6, n1 = 40, n0 = 40, dur = 12, fu = 12))
  indep <- function(d, reps, seed) {
    set.seed(seed); lam0 <- log(2) / d$med; lam1 <- lam0 * d$hr; arm <- c(rep(1L, d$n1), rep(0L, d$n0))
    z <- replicate(reps, {
      a <- stats::runif(length(arm), 0, d$dur); t <- stats::rexp(length(arm), ifelse(arm == 1L, lam1, lam0)); cal <- d$dur + d$fu
      st <- as.integer(t <= cal - a); sd <- survival::survdiff(survival::Surv(pmin(t, cal - a), st) ~ arm)
      sign(sd$exp[2] - sd$obs[2]) * sqrt(sd$chisq)
    })
    p <- mean(z > stats::qnorm(0.975)); c(p = p, se = sqrt(p * (1 - p) / reps))
  }
  rows <- lapply(seq_along(designs), function(i) {
    d <- designs[[i]]
    sc <- list(design = list(kind = "two_arm_fixed", nTreat = d$n1, nControl = d$n0), endpoint = list(type = "time_to_event"),
               truth = list(controlMedian = d$med, hazardRatio = d$hr), analysis = list(method = "logrank", alpha = 0.025, sided = 1),
               accrual = list(kind = "uniform", duration = d$dur, followup = d$fu), performance = list("power"))
    r <- vcr_run_simulation(sc, seed = 4400L + i, replicates = 5000L, cores = VCR_TEST_CORES)
    chk <- vcr_analytic_check(sc, r$measures); ind <- indep(d, 5000L, 4500L + i)
    pw <- Filter(function(m) m$name == "power", r$measures)[[1]]
    list(hr = d$hr, alloc = sprintf("%d/%d", d$n1, d$n0), analytic = chk$value, engine = pw$value, mcse = pw$mcse, ratio = chk$differenceInMcse,
         indep = ind[["p"]], z_engines = (pw$value - ind[["p"]]) / sqrt(pw$mcse^2 + ind[["se"]]^2), ok = isTRUE(chk$withinThreeMcse))
  })
  ok <- all(vapply(rows, function(r) r$ok && abs(r$z_engines) <= 3, logical(1)))
  list(pass = ok,
       detail = paste(vapply(rows, function(r) sprintf("HR %.3f %s: analytic %.4f, engine sim %.4f (%.2f MCSE), independent sim %.4f (engines differ by %.2f SE)",
                                                        r$hr, r$alloc, r$analytic, r$engine, r$ratio, r$indep, r$z_engines), character(1)), collapse = "; "))
})

vcr_case("N05", c("AC-28"), function() {
  a <- vcr_replicates_for_mcse("proportion", 0.001, p = 0.025)
  b <- vcr_replicates_for_mcse("proportion", 0.005, p = 0.95)
  c_ <- vcr_replicates_for_mcse("mean", 0.005, sd = 0.2)
  # The floors ride on top: a null scenario never goes below 20,000.
  floor_null <- vcr_replicate_floor(TRUE, 0.001, 0.025)
  ok <- a == 24375L && b == 1900L && c_ == 1600L && floor_null == 24375L
  list(pass = ok, detail = sprintf("alpha0.025@0.001 -> %d (want 24375); coverage0.95@0.005 -> %d (want 1900); sd0.2@0.005 -> %d (want 1600); null floor -> %d",
                                   a, b, c_, floor_null))
})

vcr_case("N06", c("AC-04", "AC-31"), function() {
  # Same seed, three core counts, and a resumed run: bit-identical summaries.
  sc <- list(design = list(kind = "two_arm_fixed", nTreat = 120, nControl = 120),
             endpoint = list(type = "continuous"), truth = list(effect = 0.25, sd = 1),
             analysis = list(method = "ttest", alpha = 0.025, sided = 1),
             performance = c("power", "bias", "coverage"))
  serialize <- function(r) paste(vapply(r$measures, function(m)
    sprintf("%s=%s|%s", m$name, vcr_num_to_json(m$value), vcr_num_to_json(m$mcse %||% 0)), character(1)), collapse = ";")
  one <- vcr_run_simulation(sc, seed = 7L, replicates = 2000L, cores = 1L, batch_size = 500L)
  four <- vcr_run_simulation(sc, seed = 7L, replicates = 2000L, cores = 4L, batch_size = 500L)
  eight <- vcr_run_simulation(sc, seed = 7L, replicates = 2000L, cores = 8L, batch_size = 500L)
  # Interrupted run: stop after two batches by CPU budget, then resume.
  dir <- tempfile("vcrcp"); dir.create(dir)
  cp <- file.path(dir, "checkpoint.rds")
  cancel <- file.path(dir, "CANCEL")
  partial <- vcr_run_simulation(sc, seed = 7L, replicates = 2000L, cores = 1L,
                                checkpoint = cp, batch_size = 500L,
                                progress = function(done, total) if (done >= 1000L) file.create(cancel),
                                cancel_file = cancel)
  file.remove(cancel)
  resumed <- vcr_run_simulation(sc, seed = 7L, replicates = 2000L, cores = 4L,
                                checkpoint = cp, batch_size = 500L)
  unlink(dir, recursive = TRUE)
  s1 <- serialize(one); s4 <- serialize(four); s8 <- serialize(eight); sr <- serialize(resumed)
  ok <- identical(s1, s4) && identical(s1, s8) && identical(s1, sr) &&
    partial$diagnostics$replicatesCompleted == 1000L && partial$status == "canceled"
  list(pass = ok,
       detail = sprintf("1core==4core %s, ==8core %s, ==resumed %s (partial kept %d/2000, status %s); power %s",
                        identical(s1, s4), identical(s1, s8), identical(s1, sr),
                        partial$diagnostics$replicatesCompleted, partial$status,
                        vcr_num_to_json(Filter(function(m) m$name == "power", one$measures)[[1]]$value)))
})

vcr_case("N06b", c("AC-30", "AC-29"), function() {
  # Required patients (Lachin-Foulkes) against rpact, with and without dropout,
  # and one dropout parameter in both paths. The event probability of a
  # randomized subject averages the two arms; the control arm's alone (the first
  # version) understates N by about 6%. `accrual.dropoutAnnual` is the one
  # dropout key: the analytic path read `dropoutRate` (a hazard!) while the
  # simulation read `dropoutAnnual` (a proportion), so a scenario sent to both
  # got two different trials (CE-10).
  suppressMessages(library(rpact))
  rows <- lapply(c(0, 0.10), function(drop) {
    sc <- list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"),
               truth = list(hazardRatio = 0.7, controlMedian = 12),
               accrual = list(duration = 24, followup = 12, dropoutAnnual = drop), analysis = list(alpha = 0.025, power = 0.9))
    r <- vcr_test_run(vcr_test_job("design.analytic", sc))
    ev <- vcr_measure_value(r, "required_events_exact"); pev <- vcr_measure_value(r, "event_probability")
    x <- rpact::getSampleSizeSurvival(alpha = 0.025, beta = 0.1, sided = 1, lambda2 = log(2) / 12, hazardRatio = 0.7,
           accrualTime = c(0, 24), followUpTime = 12, allocationRatioPlanned = 1, dropoutRate1 = drop, dropoutRate2 = drop, dropoutTime = 12)
    p0 <- vcr_measure_value(r, "event_probability_control")
    list(drop = drop, events = ev, want_events = x$maxNumberOfEvents, n = ev / pev, want_n = x$maxNumberOfSubjects,
         control_only = ev / p0, req = vcr_measure_value(r, "required_patients"))
  })
  ok <- all(vapply(rows, function(r) abs(r$events - r$want_events) < 1e-3 && abs(r$n - r$want_n) < 1e-3 && r$req == ceiling(r$want_n), logical(1))) &&
    rows[[2]]$n > rows[[1]]$n && rows[[2]]$control_only < rows[[2]]$n - 20
  # the same dropout key reaches the simulator: a scenario with 30% annual dropout
  # loses events, in the same proportion the analytic event probability predicts
  sc <- list(design = list(kind = "two_arm_fixed", nTreat = 300, nControl = 300), endpoint = list(type = "time_to_event"),
             truth = list(controlMedian = 12, hazardRatio = 0.7), analysis = list(method = "logrank", alpha = 0.025, sided = 1),
             accrual = list(kind = "uniform", duration = 12, followup = 12, dropoutAnnual = 0.3), performance = list("power"))
  r <- vcr_run_simulation(sc, seed = 6060L, replicates = 3000L, cores = VCR_TEST_CORES)
  ev_sim <- Filter(function(m) m$name == "expected_events", r$measures)[[1]]
  lam <- log(2) / 12; eta <- vcr_dropout_hazard(0.3)
  ev_an <- 300 * vcr_event_probability(lam, 12, 12, eta) + 300 * vcr_event_probability(lam * 0.7, 12, 12, eta)
  ok_sim <- abs(ev_sim$value - ev_an) <= 3 * ev_sim$mcse
  list(pass = ok && ok_sim,
       detail = sprintf("no dropout: events %.4f (rpact %.4f), N %.4f (rpact %.4f); 10%%/yr: N %.4f (rpact %.4f; control-arm-only would give %.1f); simulated events with 30%%/yr dropout %.2f (+-%.2f) vs analytic %.2f",
                        rows[[1]]$events, rows[[1]]$want_events, rows[[1]]$n, rows[[1]]$want_n,
                        rows[[2]]$n, rows[[2]]$want_n, rows[[2]]$control_only, ev_sim$value, ev_sim$mcse, ev_an))
})

vcr_case("N06c", c("AC-30"), function() {
  # Simon's two-stage designs. "Optimal" was searched only among designs of
  # minimax size, so it came out equal to the minimax design; the search now
  # runs the whole grid (n = 2 .. n_max), and Simon (1989)'s published designs
  # are the reference: p0 = 0.10, p1 = 0.30, alpha 0.05, beta 0.20 gives optimal
  # r1/n1 = 1/10, r/n = 5/29, EN0 = 15.0; p0 = 0.20, p1 = 0.40 gives 3/13,
  # 12/43, EN0 = 20.6 (minimax 4/18, 10/33). An independent brute-force
  # enumeration of the same grid is the second reference.
  run <- function(p0, p1) {
    r <- vcr_test_run(vcr_test_job("design.analytic",
      list(design = list(kind = "simon_two_stage", maxN = 60L), endpoint = list(type = "binary"),
           truth = list(nullRate = p0, alternativeRate = p1), analysis = list(alpha = 0.05, power = 0.8))))
    g <- function(n) vcr_measure_value(r, n)
    list(status = r$status, opt = c(g("simon_optimal_r1"), g("simon_optimal_n1"), g("simon_optimal_r"), g("simon_optimal_n")), en0 = g("simon_optimal_expected_n"),
         mm = c(g("simon_minimax_r1"), g("simon_minimax_n1"), g("simon_minimax_r"), g("simon_minimax_n")))
  }
  a <- run(0.10, 0.30); b <- run(0.20, 0.40)
  brute <- function(p0, p1, nmax = 45) {
    best <- NULL; bmin <- NULL
    for (n in 2:nmax) for (n1 in 1:(n - 1)) for (r1 in 0:(n1 - 1)) {
      pet0 <- pbinom(r1, n1, p0)
      for (r in r1:(n - 1)) {
        pw <- .vcr_simon_prob(p1, n1, n, r1, r); ty <- .vcr_simon_prob(p0, n1, n, r1, r)
        if (ty <= 0.05 && pw >= 0.8) {
          en0 <- n1 + (1 - pet0) * (n - n1)
          if (is.null(best) || en0 < best$en0 - 1e-12) best <- list(v = c(r1, n1, r, n), en0 = en0)
          if (is.null(bmin) || n < bmin$v[4] || (n == bmin$v[4] && en0 < bmin$en0 - 1e-12)) bmin <- list(v = c(r1, n1, r, n), en0 = en0)
        }
      }
    }
    list(opt = best, mm = bmin)
  }
  ref <- brute(0.10, 0.30)
  ok <- identical(a$status, "succeeded") && all(a$opt == c(1, 10, 5, 29)) && abs(a$en0 - 15.0) < 0.05 &&
    all(b$opt == c(3, 13, 12, 43)) && abs(b$en0 - 20.6) < 0.05 && all(b$mm == c(4, 18, 10, 33)) &&
    all(a$opt == ref$opt$v) && all(a$mm == ref$mm$v) && !all(a$opt == a$mm)
  list(pass = ok,
       detail = sprintf("p0 .10 / p1 .30: optimal %s (EN0 %.2f) minimax %s -- Simon: 1/10, 5/29, EN0 15.0; brute force optimal %s minimax %s; p0 .20 / p1 .40: optimal %s (EN0 %.2f) minimax %s -- Simon: 3/13, 12/43, 20.6 and 4/18, 10/33",
                        paste(a$opt, collapse = "/"), a$en0, paste(a$mm, collapse = "/"), paste(ref$opt$v, collapse = "/"), paste(ref$mm$v, collapse = "/"),
                        paste(b$opt, collapse = "/"), b$en0, paste(b$mm, collapse = "/")))
})

vcr_case("N06d", c("AC-28", "AC-31", "AC-04"), function() {
  # The design grid as a job: a long table (designIndex, truthIndex, parameters,
  # measure, value, mcse, simulated, status) that carries the names and the
  # Monte-Carlo errors (it used to be one wide row of unnamed numbers), cell
  # seeds that do not overflow at the top of the seed range (integer arithmetic
  # gave NA and every cell failed), a checkpoint that is deleted on success, and
  # cells that are immutable runs: cell k equals the design.simulate job with
  # that cell's own seed, bit for bit.
  base <- list(design = list(kind = "two_arm_fixed", nTreat = 40, nControl = 40), endpoint = list(type = "continuous"),
               analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power", "bias", "coverage"),
               truth = list(effect = 0, sd = 1))
  sc <- c(base, list(designs = list(list(nTreat = 40, nControl = 40), list(nTreat = 80, nControl = 80)),
                     truths = list(list(effect = 0), list(effect = 0.5))))
  seed <- 2147483647L
  dir <- tempfile("grid"); dir.create(dir)
  r <- vcr_test_run(vcr_test_job("design.grid", sc, seed = seed, replicates = 5000L, cores = VCR_TEST_CORES, job_id = "job_n06d"), output_dir = dir)
  tb <- vcr_test_table(r, "operating-characteristics", dir)
  cols <- c("designIndex", "truthIndex", "parameters", "measure", "value", "mcse", "simulated", "status")
  no_rds <- !any(grepl("^cell-.*\\.rds$", list.files(dir)))
  # cell (2, 2): design 2, truth 2 -> k = 4
  cell_seed <- as.integer((as.numeric(seed) + 4 * 7919) %% 2147483647)
  sim_sc <- utils::modifyList(base, list(design = list(nTreat = 80, nControl = 80), truth = list(effect = 0.5)))
  sim <- vcr_test_run(vcr_test_job("design.simulate", sim_sc, seed = cell_seed, replicates = 5000L, cores = 1L, job_id = "job_n06d_sim"))
  cell4 <- tb[tb$designIndex == 2 & tb$truthIndex == 2, ]
  same <- all(vapply(sim$measures, function(m) { row <- cell4[cell4$measure == m$name, ]; nrow(row) == 1L && abs(row$value - m$value) <= 1e-12 * max(1, abs(m$value)) && abs(row$mcse - m$mcse) <= 1e-12 }, logical(1)))
  null_row <- tb[tb$designIndex == 1 & tb$truthIndex == 1 & tb$measure == "type_one_error", ]
  ok <- identical(r$status, "succeeded") && identical(names(tb), cols) && nrow(tb) > 0 && all(tb$status == "succeeded") &&
    all(tb$simulated) && all(is.finite(tb$mcse)) && length(unique(tb$parameters)) == 4L && no_rds && same && nrow(null_row) == 1L &&
    abs(null_row$value - 0.025) <= 3 * null_row$mcse
  # a tiny CPU budget stops the grid with what finished and says so
  tight <- vcr_test_run(vcr_test_job("design.grid", sc, seed = 1L, replicates = 20000L, cores = 1L, job_id = "job_n06d_cpu", extra = list(cpuSecondsLimit = 1)))
  ok_cpu <- identical(tight$status, "failed") && "cpu_budget_exhausted" %in% c(vcr_test_issue_codes(tight),
              unlist(lapply(tight$diagnostics$cells, function(c_) c_$refusal)))
  list(pass = ok && ok_cpu,
       detail = sprintf("long table %s, %d rows, statuses %s, every measure simulated with a finite MCSE, %d distinct parameter sets, checkpoint files left: %s; cell (2,2) equals the design.simulate job at seed %d bit for bit: %s; null cell type-I %.4f (+-%.4f); CPU limit 1 s -> status %s",
                        paste(names(tb) == cols, collapse = ""), nrow(tb), paste(unique(tb$status), collapse = "/"), length(unique(tb$parameters)),
                        !no_rds, cell_seed, same, null_row$value, null_row$mcse, tight$status))
})

vcr_case("N06e", c("AC-04", "AC-28", "AC-31"), function() {
  # An ARRAY in a cell's override reaches the cell. `vcr_design_grid` used to lay a cell's design and
  # truth over the base with utils::modifyList, which keeps the base when both sides are unnamed lists
  # (JSON arrays): informationRates, controlRates / treatmentRates and a piecewise controlDistribution's
  # breaks / rates were dropped while the cell record kept the override, so the label said one design and
  # the numbers were another's. N06d overrides scalars only. Three families, each run as a grid job and
  # held two ways: the scenario hash a cell reports equals the hash of the scenario written out by hand
  # with that cell's arrays (so the cell simulated exactly that scenario), and a number only that array
  # can produce -- the looks of a group-sequential cell, the null label an array pair decides, the
  # events a piecewise hazard makes.
  hash_of <- function(sc) vcr_scenario_hash(vcr_test_json(sc))
  cell_of <- function(r, d, t) Filter(function(c_) c_$designIndex == d && c_$truthIndex == t, r$diagnostics$cells)[[1]]
  value <- function(cell, name) { m <- Filter(function(x) identical(x$name, name), cell$measures); if (length(m)) m[[1]]$value else NA_real_ }
  mcse <- function(cell, name) { m <- Filter(function(x) identical(x$name, name), cell$measures); if (length(m)) m[[1]]$mcse else NA_real_ }
  grid <- function(sc, designs, truths, seed, id) vcr_test_run(vcr_test_job("design.grid", c(sc, list(designs = designs, truths = truths)),
    seed = seed, replicates = 5000L, cores = VCR_TEST_CORES, job_id = id))

  # (a) group-sequential: informationRates is an array of the DESIGN. Two looks in the base and the first cell, three in the second.
  gs <- list(design = list(kind = "group_sequential", nTreat = 40, nControl = 40, informationRates = list(0.5, 1), spending = "obrien_fleming"),
             endpoint = list(type = "time_to_event"), truth = list(controlMedian = 12, hazardRatio = 0.6),
             analysis = list(method = "logrank", alpha = 0.025, sided = 1), accrual = list(kind = "uniform", duration = 6, followup = 6),
             performance = list("power"))
  three <- list(0.3333, 0.6667, 1)
  r_gs <- grid(gs, list(list(informationRates = list(0.5, 1)), list(informationRates = three)), list(list(hazardRatio = 0.6)), 6061L, "job_n06e_gs")
  gs_two <- gs; gs_two$design$informationRates <- list(0.5, 1)
  gs_three <- gs; gs_three$design$informationRates <- three
  c1 <- cell_of(r_gs, 1, 1); c2 <- cell_of(r_gs, 2, 1)
  looks1 <- value(c1, "expected_analyses"); looks2 <- value(c2, "expected_analyses")
  ok_gs <- identical(c1$scenarioHash, hash_of(gs_two)) && identical(c2$scenarioHash, hash_of(gs_three)) &&
    is.finite(looks1) && looks1 <= 2 && is.finite(looks2) && looks2 > 2.5

  # (b) external control: the two stratum rates of each arm are arrays of the TRUTH, and they decide whether the cell is a null one.
  ext <- list(design = list(kind = "single_arm_external", n = 100), endpoint = list(type = "binary"),
              truth = list(controlRates = list(0.2, 0.4), treatmentRates = list(0.2, 0.4)),
              external = list(kind = "stratified_beta_binomial", n = 200, targetPrevalence = 0.5, sourcePrevalence = 0.3, parameterInformation = 100,
                              logOddsDrift = 0, sensitivityDrifts = list(-0.3, 0, 0.3)),
              analysis = list(method = "stratified_risk_difference", estimand = "ATT", alpha = 0.025, sided = 1), performance = list("power"))
  null_truth <- list(controlRates = list(0.2, 0.4), treatmentRates = list(0.2, 0.4))
  alt_truth <- list(controlRates = list(0.2, 0.4), treatmentRates = list(0.5, 0.7))
  r_ex <- grid(ext, list(list(n = 100)), list(null_truth, alt_truth), 6062L, "job_n06e_ext")
  ext_alt <- ext; ext_alt$truth <- alt_truth
  e1 <- cell_of(r_ex, 1, 1); e2 <- cell_of(r_ex, 1, 2)
  ok_ext <- identical(e1$scenarioHash, hash_of(ext)) && identical(e2$scenarioHash, hash_of(ext_alt)) &&
    is.finite(value(e1, "type_one_error")) && is.na(value(e1, "power")) && is.finite(value(e2, "power")) && is.na(value(e2, "type_one_error")) && value(e2, "power") > 0.5

  # (c) a piecewise control distribution: breaks and rates are arrays inside an object of the TRUTH. The second cell's control hazard is
  # high early and low late (a cumulative hazard of 0.93 by month 18 against the first cell's 1.5), so it has fewer events.
  slow <- list(kind = "piecewise", breaks = list(6), rates = list(0.05, 0.1))
  fast <- list(kind = "piecewise", breaks = list(3, 9), rates = list(0.2, 0.04, 0.01))
  pw <- list(design = list(kind = "two_arm_fixed", nTreat = 60, nControl = 60), endpoint = list(type = "time_to_event"),
             truth = list(hazardRatio = 0.6, controlDistribution = slow), analysis = list(method = "logrank", alpha = 0.025, sided = 1),
             accrual = list(kind = "uniform", duration = 6, followup = 12), performance = list("power"))
  r_pw <- grid(pw, list(list(nTreat = 60)), list(list(controlDistribution = slow), list(controlDistribution = fast)), 6063L, "job_n06e_pw")
  pw_fast <- pw; pw_fast$truth$controlDistribution <- fast
  p1 <- cell_of(r_pw, 1, 1); p2 <- cell_of(r_pw, 1, 2)
  ev1 <- value(p1, "expected_events"); ev2 <- value(p2, "expected_events")
  ok_pw <- identical(p1$scenarioHash, hash_of(pw)) && identical(p2$scenarioHash, hash_of(pw_fast)) &&
    is.finite(ev1) && is.finite(ev2) && ev1 - ev2 > 10 * sqrt(mcse(p1, "expected_events")^2 + mcse(p2, "expected_events")^2)

  list(pass = all(vapply(list(r_gs, r_ex, r_pw), function(r) identical(r$status, "succeeded"), logical(1))) && ok_gs && ok_ext && ok_pw,
       detail = sprintf("group-sequential: cell 1 hash is the 2-look scenario %s, cell 2 the 3-look scenario %s, expected analyses %.3f (<= 2) and %.3f (> 2.5); external control: null cell hash %s with type-I %.4f, alternative cell hash %s with power %.4f (no type-I error); piecewise: hashes %s / %s, expected events %.2f and %.2f",
                        identical(c1$scenarioHash, hash_of(gs_two)), identical(c2$scenarioHash, hash_of(gs_three)), looks1, looks2,
                        identical(e1$scenarioHash, hash_of(ext)), value(e1, "type_one_error"), identical(e2$scenarioHash, hash_of(ext_alt)), value(e2, "power"),
                        identical(p1$scenarioHash, hash_of(pw)), identical(p2$scenarioHash, hash_of(pw_fast)), ev1, ev2))
})

vcr_case("N06f", c("AC-30", "AC-29"), function() {
  # Required patients for the control distribution the scenario DECLARES. `design.analytic` took the
  # event probability from an exponential matched on the control's median whatever the distribution was,
  # so a Weibull or a piecewise control got another trial's number (shape 2, median 12, HR 0.7, 12 months of
  # accrual and 12 of follow-up: 0.5758 against 0.7072, 22.8% too many patients) and the result did not
  # say it had approximated. Now an exponential control keeps the Lachin-Foulkes closed form (N06b holds
  # it to rpact) and a Weibull or piecewise one is integrated, and the result names the route.
  # References that share no code with the engine: (1) the density f(t) G(t) integrated in the case by
  # stats::integrate, where G is the share of a randomized subject still under observation at t;
  # (2) a plain-R simulation of the whole trial -- entry, event, dropout, administrative censoring -- of
  # 2 million subjects per arm (each share within 4.5 binomial standard errors); (3) the shape-1 Weibull
  # and the constant-rate piecewise control equal the exponential closed form.
  weibull_inv <- function(shape, scale) function(H) scale * H^(1 / shape)
  pw_breaks <- c(6, 18); pw_rates <- c(0.05, 0.02, 0.04)
  pw_cum <- c(0, cumsum(pw_rates[-3] * diff(c(0, pw_breaks))))
  piecewise_inv <- function(H) { k <- findInterval(H, pw_cum); c(0, pw_breaks)[k] + (H - pw_cum[k]) / pw_rates[k] }
  surv_w <- function(shape, scale) function(t, hr) exp(-hr * (t / scale)^shape)
  dens_w <- function(shape, scale) function(t, hr) hr * (shape / scale) * (t / scale)^(shape - 1) * exp(-hr * (t / scale)^shape)
  surv_p <- function(t, hr) exp(-hr * (pw_cum[findInterval(t, c(0, pw_breaks))] + pw_rates[findInterval(t, c(0, pw_breaks))] * (t - c(0, pw_breaks)[findInterval(t, c(0, pw_breaks))])))
  dens_p <- function(t, hr) hr * pw_rates[findInterval(t, c(0, pw_breaks))] * surv_p(t, hr)
  # (1) the density integral: G is 1 up to the follow-up F, falls linearly to 0 at A + F, and thins by the dropout
  integral_of <- function(dens, hr, A, Fu, eta) {
    G <- function(t) ifelse(t <= Fu, 1, (A + Fu - t) / A) * exp(-eta * t)
    stats::integrate(function(t) dens(t, hr) * G(t), 0, Fu, rel.tol = 1e-11, subdivisions = 2000L)$value +
      stats::integrate(function(t) dens(t, hr) * G(t), Fu, A + Fu, rel.tol = 1e-11, subdivisions = 2000L)$value
  }
  # (2) the simulated trial
  sim_share <- function(inv_cumhaz, hr, A, Fu, eta, n, seed) {
    set.seed(seed)
    entry <- stats::runif(n, 0, A); t_event <- inv_cumhaz(-log(stats::runif(n)) / hr)
    t_drop <- if (eta > 0) stats::rexp(n, eta) else Inf
    mean(t_event <= pmin(t_drop, A + Fu - entry))
  }
  scenarios <- list(
    list(id = "weibull2", dist = list(kind = "weibull", shape = 2, scale = 12 / log(2)^(1 / 2)), dens = dens_w(2, 12 / log(2)^(1 / 2)), inv = weibull_inv(2, 12 / log(2)^(1 / 2)), drop = 0),
    list(id = "weibull0.7+dropout", dist = list(kind = "weibull", shape = 0.7, scale = 20), dens = dens_w(0.7, 20), inv = weibull_inv(0.7, 20), drop = 0.15),
    list(id = "piecewise+dropout", dist = list(kind = "piecewise", breaks = as.list(pw_breaks), rates = as.list(pw_rates)), dens = dens_p, inv = piecewise_inv, drop = 0.10))
  hr <- 0.7; A <- 12; Fu <- 12
  rows <- lapply(seq_along(scenarios), function(i) {
    s <- scenarios[[i]]
    sc <- list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = hr, controlDistribution = s$dist),
               accrual = list(duration = A, followup = Fu, dropoutAnnual = s$drop), analysis = list(alpha = 0.025, power = 0.9))
    r <- vcr_test_run(vcr_test_job("design.analytic", sc))
    eta <- vcr_dropout_hazard(s$drop)
    ref0 <- integral_of(s$dens, 1, A, Fu, eta); ref1 <- integral_of(s$dens, hr, A, Fu, eta)
    n_mc <- 2e6
    mc0 <- sim_share(s$inv, 1, A, Fu, eta, n_mc, 1100L + i); mc1 <- sim_share(s$inv, hr, A, Fu, eta, n_mc, 2200L + i)
    se <- function(p) sqrt(p * (1 - p) / n_mc)
    p0 <- vcr_measure_value(r, "event_probability_control"); p1 <- vcr_measure_value(r, "event_probability_treatment")
    ev <- vcr_measure_value(r, "required_events_exact")
    list(id = s$id, status = r$status, route = r$diagnostics$eventProbability$route %||% "none", p0 = p0, p1 = p1, ref0 = ref0, ref1 = ref1,
         d_ref = max(abs(p0 - ref0), abs(p1 - ref1)), z_mc = max(abs(p0 - mc0) / se(p0), abs(p1 - mc1) / se(p1)),
         pev = vcr_measure_value(r, "event_probability"), req = vcr_measure_value(r, "required_patients"), want_req = ceiling(ev / ((ref0 + ref1) / 2)))
  })
  ok_rows <- all(vapply(rows, function(x) identical(x$status, "succeeded") && identical(x$route, "numerical_integration") &&
    x$d_ref < 1e-8 && x$z_mc < 4.5 && x$req == x$want_req && abs(x$pev - (x$ref0 + x$ref1) / 2) < 1e-8, logical(1)))
  # the figure the median-matched exponential gave for the first scenario, which must no longer be the answer
  old_pev <- {
    lam <- log(2) / 12; eta0 <- 0
    ((1 - 0.5) * vcr_event_probability(lam, A, Fu, eta0) + 0.5 * vcr_event_probability(lam * hr, A, Fu, eta0))
  }
  ok_moved <- abs(rows[[1]]$pev - old_pev) > 0.1
  # (3) special cases: the exponential, a shape-1 Weibull and a constant-rate piecewise control are one trial
  base <- list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"),
               accrual = list(duration = A, followup = Fu, dropoutAnnual = 0.1), analysis = list(alpha = 0.025, power = 0.9))
  run_with <- function(dist) vcr_test_run(vcr_test_job("design.analytic", c(base, list(truth = list(hazardRatio = hr, controlDistribution = dist)))))
  lam <- 0.04
  expo <- run_with(list(kind = "exponential", rate = lam)); weib1 <- run_with(list(kind = "weibull", shape = 1, scale = 1 / lam))
  pw_const <- run_with(list(kind = "piecewise", breaks = list(5, 15), rates = list(lam, lam, lam)))
  d_special <- max(abs(vcr_measure_value(weib1, "event_probability") - vcr_measure_value(expo, "event_probability")),
                   abs(vcr_measure_value(pw_const, "event_probability") - vcr_measure_value(expo, "event_probability")))
  route_of <- function(r) r$diagnostics$eventProbability$route %||% "none"
  ok_special <- identical(route_of(expo), "closed_form") && identical(route_of(weib1), "numerical_integration") &&
    d_special < 1e-10 && vcr_measure_value(weib1, "required_patients") == vcr_measure_value(expo, "required_patients") &&
    vcr_measure_value(pw_const, "required_patients") == vcr_measure_value(expo, "required_patients")
  list(pass = ok_rows && ok_moved && ok_special,
       detail = sprintf("%s; the median-matched exponential's %.4f for the first scenario is no longer the answer (%.4f); exponential vs shape-1 Weibull vs constant-rate piecewise: max |d| = %.1e, route %s / %s",
                        paste(vapply(rows, function(x) sprintf("%s: control %.6f/%.6f treatment %.6f/%.6f (engine/integral), |d| = %.1e, %.2f binomial SE from the simulated trial, required %d (route %s)",
                                      x$id, x$p0, x$ref0, x$p1, x$ref1, x$d_ref, x$z_mc, as.integer(x$req), x$route), character(1)), collapse = "; "),
                        old_pev, rows[[1]]$pev, d_special, route_of(expo), route_of(weib1)))
})

vcr_case("N06g", c("AC-04", "AC-28"), function() {
  # The cost of a design needs a duration only for the part of it that is per month. A continuous or binary two-arm design has no
  # accrual (the schema refuses one there), so its duration is unknown, and `cost` was withheld even when the costs stated were per patient
  # and per site and the total is known exactly: the result said only that cost "needs ... an accrual duration; it was not computed".
  # Now the per-patient and per-site parts are computed (cost is deterministic given the sizes, so the Monte-Carlo error is 0), and a
  # cost per month on a design with no duration is still declined, with that reason. A time-to-event design with accrual keeps all three.
  run <- function(sc, tag) vcr_test_run(vcr_test_job("design.simulate", sc, seed = 606L, replicates = 400L, job_id = paste0("job_n06g_", tag)))
  cont <- function(costs) list(design = list(kind = "two_arm_fixed", nTreat = 40, nControl = 30), endpoint = list(type = "continuous"), truth = list(effect = 0.5, sd = 1),
                               analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power", "cost"), costs = costs)
  notes_of <- function(r) vapply(r$diagnostics$performanceNotComputed %||% list(), function(i) as.character(i$detail), character(1))
  # per patient and per site: 1000 x 70 + 5000 x 4 = 90000, exactly
  fixed <- run(cont(list(perPatient = 1000, perSite = 5000, sites = 4)), "fixed")
  cost <- vcr_get_measure(fixed, "cost")
  # a cost per month on a design with no accrual: declined, with the reason
  monthly <- run(cont(list(perPatient = 1000, perMonth = 200)), "monthly")
  # a time-to-event design with accrual: all three parts, the duration being accrual + follow-up
  tte <- function(costs) list(design = list(kind = "two_arm_fixed", nTreat = 60, nControl = 60), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12),
                              analysis = list(method = "logrank", alpha = 0.025, sided = 1), accrual = list(kind = "uniform", duration = 12, followup = 12),
                              performance = list("power", "cost"), costs = costs)
  full <- run(tte(list(perPatient = 1000, perSite = 5000, sites = 4, perMonth = 200)), "full")
  no_month <- run(tte(list(perPatient = 1000, perSite = 5000, sites = 4)), "nomonth")
  none <- run(cont(list(sites = 3)), "none")
  ok <- identical(fixed$status, "succeeded") && !is.null(cost) && cost$value == 90000 && identical(cost$mcse, 0) && !grepl("perMonth", cost$note, fixed = TRUE) &&
    identical(monthly$status, "succeeded") && is.null(vcr_get_measure(monthly, "cost")) && any(grepl("per month", notes_of(monthly), fixed = TRUE)) &&
    abs(vcr_measure_value(full, "cost") - (1000 * 120 + 5000 * 4 + 200 * 24)) < 1e-6 && abs(vcr_measure_value(no_month, "cost") - (1000 * 120 + 5000 * 4)) < 1e-6 &&
    is.finite(vcr_measure_value(none, "cost")) && vcr_measure_value(none, "cost") == 0
  list(pass = ok,
       detail = sprintf("continuous 40 + 30 patients at 1000 each and 4 sites at 5000: cost %s (want 90000, MCSE %s); with a cost per month and no accrual: %s (%s); time to event, 120 patients, accrual 12 + follow-up 12: all three parts %s (want %d), without a monthly part %s (want %d)",
                        format(cost$value %||% NA_real_), format(cost$mcse %||% NA_real_), if (is.null(vcr_get_measure(monthly, "cost"))) "not computed" else "computed", paste(notes_of(monthly), collapse = " | "),
                        format(vcr_measure_value(full, "cost")), 1000L * 120L + 5000L * 4L + 200L * 24L, format(vcr_measure_value(no_month, "cost")), 1000L * 120L + 5000L * 4L))
})

vcr_case("N06h", c("AC-04", "AC-28"), function() {
  # A grid stopped by its CPU budget before its last cell said `succeeded` with nothing but an issue entry for a trace: the later cells
  # simply did not exist, and the cells that did run dropped their own conclusion (limited, capped) on the way into diagnostics.cells.
  # Now the grid is `limited` when it did not run every cell it planned, or any cell ended failed, capped or limited; the result counts
  # the cells planned against the cells run, and each cell carries its conclusion. The cells that finished are still the deliverable.
  # Three designs on a continuous endpoint: a small one, one so large that its replicates alone outlast the budget (600,000 patients a
  # replicate), and a small one that never gets its turn. The budget is 10 CPU seconds (the engine stops at 0.9 of it), the heavy cell
  # needs minutes whatever the machine, and the small ones need a second or two.
  mk <- function(designs) list(design = list(kind = "two_arm_fixed", nTreat = 20, nControl = 20), endpoint = list(type = "continuous"), truth = list(effect = 0.5, sd = 1),
                               analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power"),
                               designs = designs, truths = list(list(effect = 0.5)))
  stopped <- vcr_test_run(vcr_test_job("design.grid", mk(list(list(nTreat = 20, nControl = 20), list(nTreat = 300000, nControl = 300000), list(nTreat = 25, nControl = 25))),
                                       seed = 7L, replicates = 5000L, cores = 1L, job_id = "job_n06h_stop", extra = list(cpuSecondsLimit = 10, batchSize = 25L)))
  whole <- vcr_test_run(vcr_test_job("design.grid", mk(list(list(nTreat = 20, nControl = 20), list(nTreat = 25, nControl = 25))), seed = 7L, replicates = 5000L, cores = 1L, job_id = "job_n06h_whole"))
  d <- stopped$diagnostics
  codes <- vcr_test_issue_codes(stopped)
  ok <- identical(stopped$status, "succeeded") && identical(stopped$conclusion, "limited") && d$cellsPlanned == 3L && d$cellsRun == 2L && length(d$cells) == 2L &&
    "cpu_budget_exhausted" %in% codes && identical(d$cells[[1]]$status, "succeeded") && identical(d$cells[[1]]$conclusion, "estimable") && identical(d$cells[[2]]$status, "failed") &&
    identical(d$cells[[2]]$conclusion, "limited") &&
    identical(whole$status, "succeeded") && identical(whole$conclusion, "estimable") && whole$diagnostics$cellsPlanned == 2L && whole$diagnostics$cellsRun == 2L &&
    identical(whole$diagnostics$cells[[1]]$conclusion, "estimable") && isFALSE(whole$diagnostics$cells[[1]]$replicatesCapped)
  list(pass = ok,
       detail = sprintf("three designs, the second too large for a 10-second budget: status %s, conclusion %s, %s of %s cells run (cell statuses %s, conclusions %s), issues %s; a grid that runs every cell: conclusion %s, %s of %s cells",
                        stopped$status, stopped$conclusion %||% "NULL", d$cellsRun %||% "NULL", d$cellsPlanned %||% "NULL",
                        paste(vapply(d$cells, function(c_) c_$status, character(1)), collapse = "/"), paste(vapply(d$cells, function(c_) c_$conclusion %||% "NULL", character(1)), collapse = "/"),
                        paste(codes, collapse = ","), whole$conclusion %||% "NULL", whole$diagnostics$cellsRun %||% "NULL", whole$diagnostics$cellsPlanned %||% "NULL"))
})

vcr_case("N04d", c("AC-29", "AC-30"), function() {
  # The analytic cross-check at a high replicate count. The log-rank power is a
  # first-order approximation, documented to sit within about a percentage point
  # of a simulation (largest measured gap 1.3 points); at 100,000 replicates the
  # simulation's own error is 0.0004, and holding the approximation to three of
  # those read 「不一致」 for a difference the approximation itself explains.
  # The check now says the tolerance it used and why, keeps the literal three-MCSE
  # flag beside it, and holds an EXACT closed form (means, proportions) to the
  # simulation's error alone -- a real disagreement of three points is still one.
  lr <- list(design = list(kind = "two_arm_fixed", nTreat = 140, nControl = 70), endpoint = list(type = "time_to_event"),
             truth = list(hazardRatio = 0.6, controlMedian = 6), analysis = list(method = "logrank", alpha = 0.025, sided = 1),
             accrual = list(kind = "uniform", duration = 12, followup = 12), performance = list("power"))
  ref <- vcr_analytic_check(lr, list(vcr_measure("power", 0.5, simulated = TRUE, mcse = 0.001)))
  sim <- function(gap, mcse) list(vcr_measure("power", ref$value + gap, simulated = TRUE, mcse = mcse))
  near <- vcr_analytic_check(lr, sim(-0.011, 0.0004))
  far <- vcr_analytic_check(lr, sim(-0.03, 0.0004))
  low_n <- vcr_analytic_check(lr, sim(-0.002, 0.01))
  ok_lr <- identical(near$basis, "asymptotic_logrank_score") && !isTRUE(near$withinThreeMcse) && isTRUE(near$withinTolerance) &&
    abs(near$tolerance - (3 * 0.0004 + VCR_LOGRANK_APPROXIMATION_BIAS)) < 1e-12 && near$approximationBias == VCR_LOGRANK_APPROXIMATION_BIAS &&
    grepl("documented bias", near$toleranceBasis) && abs(near$mcse - 0.0004) < 1e-12 &&
    !isTRUE(far$withinTolerance) && isTRUE(low_n$withinThreeMcse) && isTRUE(low_n$withinTolerance)
  mean_sc <- list(design = list(kind = "two_arm_fixed", nTreat = 120, nControl = 120), endpoint = list(type = "continuous"),
                  truth = list(effect = 0.3, sd = 1), analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power"))
  mref <- vcr_analytic_check(mean_sc, list(vcr_measure("power", 0.5, simulated = TRUE, mcse = 0.001)))
  exact <- vcr_analytic_check(mean_sc, list(vcr_measure("power", mref$value - 0.011, simulated = TRUE, mcse = 0.0004)))
  ok_exact <- exact$approximationBias == 0 && !isTRUE(exact$withinTolerance) && !isTRUE(exact$withinThreeMcse) &&
    abs(exact$tolerance - 3 * 0.0004) < 1e-12
  list(pass = ok_lr && ok_exact,
       detail = sprintf("log-rank, simulation 1.1 points below the reference at MCSE 0.0004: within 3 MCSE %s, within tolerance %s (tolerance %.4f, bias %.3f: %s); 3.0 points below: within tolerance %s; means, same gap: bias %.0f, within tolerance %s",
                        near$withinThreeMcse, near$withinTolerance, near$tolerance, near$approximationBias, near$toleranceBasis, far$withinTolerance, exact$approximationBias, exact$withinTolerance))
})
