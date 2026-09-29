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
  # Coverage at 2,000 replicates -> MCSE 0.0049, band [0.935, 0.965].
  sc <- list(design = list(kind = "two_arm_fixed", nTreat = 150, nControl = 150),
             endpoint = list(type = "continuous"), truth = list(effect = 0.3, sd = 1),
             analysis = list(method = "ttest", alpha = 0.025, sided = 1),
             performance = c("bias", "coverage"))
  r <- vcr_run_simulation(sc, seed = 90210L, replicates = 2000L, cores = VCR_TEST_CORES)
  cov <- Filter(function(m) m$name == "coverage", r$measures)[[1]]
  bias <- Filter(function(m) m$name == "bias", r$measures)[[1]]
  ok <- cov$value >= 0.935 && cov$value <= 0.965 && abs(bias$value) <= 3 * bias$mcse
  list(pass = ok, detail = sprintf("coverage %.4f (+-%.4f, band 0.935-0.965); bias %.5f = %.2f MCSE",
                                   cov$value, cov$mcse, bias$value, abs(bias$value) / bias$mcse))
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
