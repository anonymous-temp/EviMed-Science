# N28 — literature populations, virtual patients and common random numbers.

vcr_case("N28a", c("AC-11", "AC-20"), function() {
  # A published baseline table as a job. The first version padded the table with
  # NA `min`/`max` columns and failed on the first row (`missing value where
  # TRUE/FALSE needed`): any Table 1 without bounds crashed, and no case ever
  # called the method (EA-5). Here a mean/SD row with no bounds, a bounded row
  # (truncated moments), a binary proportion, a categorical proportions row with
  # labels and a lognormal row all generate, with every moment recovered from
  # 20,000 draws within 4 Monte-Carlo errors; the population is labelled a
  # literature population with the source of every column, and an assumed
  # correlation comes with its sensitivity.
  n <- 20000L
  tbl <- list(list(variable = "age", mean = 61, sd = 9),
              list(variable = "sbp", mean = 138, sd = 15, min = 100),
              list(variable = "male", proportion = 0.6),
              list(variable = "ecog", proportions = list(0.5, 0.3, 0.2), levels = list("0", "1", "2")),
              list(variable = "alt", mean = 40, sd = 20, distribution = "lognormal"))
  cor <- list(list(1, 0.3, 0, 0, 0), list(0.3, 1, 0, 0, 0), list(0, 0, 1, 0, 0), list(0, 0, 0, 1, 0), list(0, 0, 0, 0, 1))
  dir <- tempfile("n28a"); dir.create(dir)
  r <- vcr_test_run(vcr_test_job("population.literature", list(baselineTable = tbl, n = n, correlation = cor, correlationSource = "assumed"), seed = 2828L, job_id = "job_n28a"), output_dir = dir)
  d <- vcr_test_table(r, "population", dir)
  lo <- (100 - 138) / 15; sbp_mean <- 138 + 15 * stats::dnorm(lo) / (1 - stats::pnorm(lo))
  ecog <- table(d$ecog) / n
  z <- c(age = (mean(d$age) - 61) / (stats::sd(d$age) / sqrt(n)),
         age_sd = (stats::sd(d$age) - 9) / (stats::sd(d$age) / sqrt(2 * (n - 1))),
         sbp = (mean(d$sbp) - sbp_mean) / (stats::sd(d$sbp) / sqrt(n)),
         male = (mean(d$male) - 0.6) / sqrt(0.6 * 0.4 / n),
         ecog0 = (ecog[["0"]] - 0.5) / sqrt(0.25 / n), ecog2 = (ecog[["2"]] - 0.2) / sqrt(0.16 / n),
         alt = (mean(d$alt) - 40) / (stats::sd(d$alt) / sqrt(n)), alt_sd = (stats::sd(d$alt) - 20) / (stats::sd(d$alt) / sqrt(2 * (n - 1))))
  sens <- r$diagnostics$correlationSensitivity
  ok <- identical(r$status, "succeeded") && all(abs(z) <= 4) && min(d$sbp) >= 100 && identical(sort(unique(d$ecog)), c(0L, 1L, 2L)) || identical(sort(unique(as.character(d$ecog))), c("0", "1", "2"))
  ok <- ok && identical(r$status, "succeeded") && all(abs(z) <= 4) && min(d$sbp) >= 100 &&
    identical(r$diagnostics$kind, "literature") && identical(r$diagnostics$applicability, "source_trial_population") && identical(r$diagnostics$valueSource, "synthetic") &&
    identical(r$diagnostics$columnSources$age, "aggregate") && identical(r$diagnostics$columnSources[["(correlation)"]], "assumed") &&
    length(sens) == 2L && sens[[1]]$maxSpearmanShift > 0.1 && r$counts$realPatients == 0 && r$counts$generatedRecords == n
  list(pass = ok,
       detail = sprintf("%d draws from a table with no bounds on two rows: worst moment %.2f MCSE (%s); sbp lower bound %.1f respected; assumed correlation 0.3 -> sensitivity: %s shifts the Spearman correlation by %.2f; kind %s, column sources age=%s, correlation=%s",
                        n, max(abs(z)), names(z)[which.max(abs(z))], min(d$sbp),
                        paste(vapply(sens, function(s) s$alternative, character(1)), collapse = "/"), sens[[1]]$maxSpearmanShift,
                        r$diagnostics$kind, r$diagnostics$columnSources$age, r$diagnostics$columnSources[["(correlation)"]]))
})

vcr_case("N28b", c("AC-31", "AC-11"), function() {
  # Common random numbers across scenarios (plan 5.2: "the same virtual patient
  # under two scenarios"). Each generator draws its uniforms in a fixed order
  # whatever the scenario says, so changing a parameter changes those subjects'
  # outcomes and nobody else's: (1) binary, control rate 0.45 -> 0.55: everyone
  # who was a case stays a case (monotone), and exactly the 10% of subjects whose
  # uniform lies between the two rates change (the first version's coupling
  # flipped 45% of subjects in the OPPOSITE direction, because `rbinom` maps the
  # uniform through min(p, 1 - p)); (2) continuous: the outcomes differ by
  # exactly delta x arm; (3) time-to-event: switching dropout on changes nobody's
  # entry time and nobody's event time, only the observed time of those who drop
  # out first; changing the hazard ratio leaves every control subject bit-for-bit
  # unchanged (the first version drew a dropout exponential only when dropout > 0,
  # which reshuffled every entry time).
  n <- 40000L
  set.seed(31L, kind = VCR_RNG_KIND); b1 <- vcr_sim_binary(n / 2, n / 2, 0.45, p_treat = 0.45)
  set.seed(31L, kind = VCR_RNG_KIND); b2 <- vcr_sim_binary(n / 2, n / 2, 0.55, p_treat = 0.55)
  flip_up <- sum(b2$y > b1$y); flip_down <- sum(b2$y < b1$y)
  set.seed(32L, kind = VCR_RNG_KIND); c1 <- vcr_sim_continuous(n / 2, n / 2, 0.0, 1, 0.3)
  set.seed(32L, kind = VCR_RNG_KIND); c2 <- vcr_sim_continuous(n / 2, n / 2, 0.7, 1, 0.3)
  dist <- vcr_dist_exponential_from_median(12)
  acc <- list(kind = "uniform", duration = 12)
  set.seed(33L, kind = VCR_RNG_KIND); t0 <- vcr_sim_tte(500L, 500L, dist, 0.7, acc, 18, 0)
  set.seed(33L, kind = VCR_RNG_KIND); t1 <- vcr_sim_tte(500L, 500L, dist, 0.7, acc, 18, 0.15)
  set.seed(33L, kind = VCR_RNG_KIND); t2 <- vcr_sim_tte(500L, 500L, dist, 0.5, acc, 18, 0)
  drop_only <- t1$time < t0$time - 1e-12
  # entry is independent of arm (CE-1): the first version gave the treated arm the
  # earliest entry times, hence the longest follow-up and 3-4 points too much power
  set.seed(34L, kind = VCR_RNG_KIND); big <- vcr_sim_tte(5000L, 5000L, dist, 0.7, acc, 18, 0)
  ent1 <- big$entry[big$arm == 1L]; ent0 <- big$entry[big$arm == 0L]
  z_entry <- (mean(ent1) - mean(ent0)) / sqrt(stats::var(ent1) / length(ent1) + stats::var(ent0) / length(ent0))
  ks_entry <- suppressWarnings(stats::ks.test(ent1, ent0)$p.value)
  ok_entry <- abs(z_entry) < 3.5 && ks_entry > 0.001
  ok_bin <- flip_down == 0L && abs(flip_up / n - 0.10) < 3 * sqrt(0.10 * 0.90 / n)
  ok_con <- max(abs((c2$y - c1$y) - 0.7 * c1$arm)) < 1e-12 && identical(c1$x, c2$x)
  ok_tte <- identical(t0$entry, t1$entry) && all(t1$time <= t0$time + 1e-12) && all(t1$status <= t0$status) && any(drop_only) &&
    all(t1$status[!drop_only] == t0$status[!drop_only]) &&
    identical(t0$entry, t2$entry) && identical(t0[t0$arm == 0L, ], t2[t2$arm == 0L, ])
  list(pass = ok_bin && ok_con && ok_tte && ok_entry,
       detail = sprintf("binary rate 0.45 -> 0.55: %d subjects flip up (%.4f of %d, expected 0.10), %d flip down; continuous: outcomes differ by exactly delta x arm; time to event: dropout on changes no entry time, %d of %d subjects observed earlier, control arm bit-for-bit identical across hazard ratios 0.7 and 0.5: %s; entry time by arm (5,000 each): mean %.3f vs %.3f months (z %.2f, KS p %.3f)",
                        flip_up, flip_up / n, n, flip_down, sum(drop_only), nrow(t0), identical(t0[t0$arm == 0L, ], t2[t2$arm == 0L, ]),
                        mean(ent1), mean(ent0), z_entry, ks_entry))
})

vcr_case("N28c", c("AC-11", "AC-09", "AC-02"), function() {
  # Virtual patients through the jobs, for a stored population: each member gets
  # an arm by a fixed uniform, baseline covariates enter the outcome through
  # `truth.covariateEffects`, and the effect the scenario states is the effect the
  # patients have. Recovered by regression on the OUTPUT table: continuous (effect
  # 0.5, covariate 0.8), binary (an odds ratio and, separately, a risk difference
  # -- both used to be silently ignored, the treatment rate equalling the
  # control rate) and time to event (hazard ratio 0.6, covariate log-hazard 0.5).
  # A scenario that states no effect is refused, not read as "no effect" (a typo
  # in a field name used to turn a power analysis into a null one). Patients have
  # stable unique ids and carry their labels; nothing is counted as real.
  suppressMessages(library(survival))
  set.seed(2929L, kind = VCR_RNG_KIND)
  n <- 6000L
  pop <- data.frame(x = stats::rnorm(n))
  in_pop <- vcr_test_input(pop, "pop_n28c@1", source = "synthetic", kind = "population")
  dir <- tempfile("n28c"); dir.create(dir)
  run <- function(method, sc, tag) vcr_test_run(vcr_test_job(method, sc, list(in_pop), seed = 2929L, job_id = paste0("job_n28c_", tag)), output_dir = dir)
  design <- list(nTreat = n / 2, nControl = n / 2)
  rc <- run("patients.continuous", list(design = design, endpoint = list(type = "continuous"), truth = list(effect = 0.5, sd = 1, covariateEffects = list(x = 0.8))), "c")
  dc <- vcr_test_table(rc, "virtual-patients", dir); fc <- summary(stats::lm(y ~ arm + x, dc))$coefficients
  rb <- run("patients.binary", list(design = design, endpoint = list(type = "binary"), truth = list(controlRate = 0.3, oddsRatio = 2)), "b")
  db <- vcr_test_table(rb, "virtual-patients", dir)
  rd <- run("patients.binary", list(design = design, endpoint = list(type = "binary"), truth = list(controlRate = 0.3, riskDifference = 0.15)), "d")
  dd <- vcr_test_table(rd, "virtual-patients", dir)
  rt <- run("patients.time_to_event", list(design = design, endpoint = list(type = "time_to_event"), truth = list(controlMedian = 10, hazardRatio = 0.6, covariateEffects = list(x = 0.5)),
                                           accrual = list(kind = "uniform", duration = 12, followup = 24)), "t")
  dt <- vcr_test_table(rt, "virtual-patients", dir); cx <- summary(survival::coxph(survival::Surv(time, status) ~ arm + x, dt))$coefficients
  none <- vcr_test_run(vcr_test_job("patients.binary", list(design = list(nTreat = 50, nControl = 50), endpoint = list(type = "binary"), truth = list(controlRate = 0.3)), job_id = "job_n28c_n"))
  p_or <- 2 * 0.3 / 0.7 / (1 + 2 * 0.3 / 0.7)
  z <- c(arm = (fc["arm", 1] - 0.5) / fc["arm", 2], x = (fc["x", 1] - 0.8) / fc["x", 2],
         or = (mean(db$y[db$arm == 1]) - p_or) / sqrt(p_or * (1 - p_or) / (n / 2)), rd = (mean(dd$y[dd$arm == 1]) - 0.45) / sqrt(0.45 * 0.55 / (n / 2)),
         hr = (cx["arm", 1] - log(0.6)) / cx["arm", 3], beta = (cx["x", 1] - 0.5) / cx["x", 3])
  ids <- dc$patientId
  ok <- all(vapply(list(rc, rb, rd, rt), function(r) identical(r$status, "succeeded"), logical(1))) && all(abs(z) <= 4) &&
    !anyDuplicated(ids) && all(grepl("^vp_[0-9a-f]{12}$", ids)) && all(dc$source == "synthetic") && all(dc$modelTier == "scenario") &&
    rc$counts$realPatients == 0 && rc$counts$generatedRecords == n && rt$counts$events == sum(dt$status) &&
    identical(none$status, "failed") && "scenario_field_missing" %in% vcr_test_issue_codes(none) &&
    is.null(rc$diagnostics$twinLabel)
  out <- list(pass = ok,
       detail = sprintf("stored population of %d: continuous effect %.3f (want 0.5) and covariate %.3f (want 0.8); odds ratio 2 -> treated rate %.4f (want %.4f); risk difference 0.15 -> %.4f (want 0.45); hazard ratio %.3f (want 0.6) and covariate log-hazard %.3f (want 0.5); worst %.2f SE; ids unique and stable; no twin label claimed; a binary scenario with no effect -> %s",
                        n, fc["arm", 1], fc["x", 1], mean(db$y[db$arm == 1]), p_or, mean(dd$y[dd$arm == 1]), exp(cx["arm", 1]), cx["x", 1], max(abs(z)),
                        paste(vcr_test_issue_codes(none), collapse = ",")))
  unlink(dir, recursive = TRUE)
  out
})
