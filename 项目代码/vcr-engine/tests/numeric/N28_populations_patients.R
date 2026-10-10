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
  in_pop <- vcr_test_input(pop, "pop_n28c@1", source = "synthetic", kind = "snapshot_file")
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

vcr_case("N28d", c("AC-11", "AC-30"), function() {
  # Piecewise accrual, against its closed form. Patients enter at the rate of the interval they are in: rates 2, 4 and 6 per
  # time unit on [0, 3), [3, 6) and [6, 6 + tail) with tail 6 put 6, 12 and 36 of the 54 expected patients in the three
  # intervals, so the entry time is a mixture of three uniforms: mean 7.1667 and the variance written below. The last
  # interval is open in the profile ("rate 6 from month 6 on"), so its length, `tail`, is what the stated enrolment period
  # means; it used to default to 1,000,000 time units, and a profile without one had a mean entry of 499,858 (administrative
  # censoring is measured from the entry, so follow-up was effectively complete and power overstated). Through the job:
  # the output table's `entry` column, 20,000 patients, held to the mean and to each interval's share, and the arms' entry
  # times equal (they once were not, CE-1).
  accrual <- list(kind = "piecewise", breaks = list(3, 6), rates = list(2, 4, 6), tail = 6, followup = 12)
  n <- 20000L
  dir <- tempfile("n28d"); dir.create(dir)
  r <- vcr_test_run(vcr_test_job("patients.time_to_event", list(design = list(nTreat = n / 2, nControl = n / 2), endpoint = list(type = "time_to_event"),
                                                               truth = list(controlMedian = 12, hazardRatio = 0.7), accrual = accrual), seed = 2828L, job_id = "job_n28d"), output_dir = dir)
  d <- vcr_test_table(r, "virtual-patients", dir)
  lo <- c(0, 3, 6); hi <- c(3, 6, 12); p <- c(2, 4, 6) * (hi - lo); p <- p / sum(p)
  want_mean <- sum(p * (lo + hi) / 2)
  want_var <- sum(p * ((hi - lo)^2 / 12 + ((lo + hi) / 2)^2)) - want_mean^2
  z_mean <- (mean(d$entry) - want_mean) / sqrt(want_var / n)
  share <- vapply(seq_along(p), function(k) mean(d$entry >= lo[k] & d$entry < hi[k]), numeric(1))
  z_share <- (share - p) / sqrt(p * (1 - p) / n)
  z_arm <- (mean(d$entry[d$arm == 1]) - mean(d$entry[d$arm == 0])) / sqrt(2 * want_var / (n / 2))
  unlink(dir, recursive = TRUE)
  list(pass = identical(r$status, "succeeded") && nrow(d) == n && abs(z_mean) <= 4 && all(abs(z_share) <= 4) && abs(z_arm) <= 4 && min(d$entry) >= 0 && max(d$entry) <= 12,
       detail = sprintf("%s: mean entry %.4f against %.4f (%.2f SE), shares of the three intervals %s against %s (worst %.2f SE), arms differ by %.2f SE, entries in [%.3f, %.3f]",
                        r$status, mean(d$entry), want_mean, z_mean, paste(sprintf("%.4f", share), collapse = "/"), paste(sprintf("%.4f", p), collapse = "/"), max(abs(z_share)), z_arm,
                        if (nrow(d)) min(d$entry) else NA_real_, if (nrow(d)) max(d$entry) else NA_real_))
})

vcr_case("N28e", c("AC-04", "AC-26"), function() {
  # A piecewise profile states every number it runs on: `tail` (the length of the open last interval) is required, there is
  # one rate per interval -- as many as the breaks plus one -- for an accrual profile and for a piecewise control
  # distribution, and anything else is refused by name before a patient is drawn. A mismatch used to recycle the shorter list with
  # a warning (accrual) or give every patient an NA event time (distribution). The validator is the first line, the
  # simulators the second: the profile functions called directly refuse too.
  base <- function(accrual = NULL, truth = list(controlMedian = 12, hazardRatio = 0.7)) {
    sc <- list(design = list(nTreat = 40, nControl = 40), endpoint = list(type = "time_to_event"), truth = truth)
    if (!is.null(accrual)) sc$accrual <- accrual
    sc
  }
  issues <- function(method, sc) {
    if (method == "design.simulate") sc$design$kind <- "two_arm_fixed"
    vapply(vcr_validate_scenario(method, vcr_test_json(sc)), function(i) paste0(i$code, "@", i$field), character(1))
  }
  # (not utils::modifyList: it keeps the base's list when both sides are JSON arrays, which is what N06e is about)
  pw <- function(rates = list(2, 4, 6)) list(kind = "piecewise", breaks = list(3, 6), rates = rates, tail = 6, followup = 12)
  no_tail <- pw(); no_tail$tail <- NULL
  want_tail <- "scenario_field_missing@scenario.accrual.tail"
  want_rates <- "scenario_value_invalid@scenario.accrual.rates"
  found <- list(
    tail_generator = issues("patients.time_to_event", base(no_tail)), tail_simulate = issues("design.simulate", base(no_tail)),
    short_generator = issues("patients.time_to_event", base(pw(rates = list(2, 4)))), long_simulate = issues("design.simulate", base(pw(rates = list(2, 4, 6, 8)))),
    distribution = issues("patients.time_to_event", base(truth = list(hazardRatio = 0.7, controlDistribution = list(kind = "piecewise", breaks = list(6, 12), rates = list(0.1, 0.05))))),
    distribution_simulate = issues("design.simulate", base(truth = list(hazardRatio = 0.7, controlDistribution = list(kind = "piecewise", breaks = list(6), rates = list(0.1, 0.05, 0.02))))),
    fine = issues("patients.time_to_event", base(pw(), truth = list(hazardRatio = 0.7, controlDistribution = list(kind = "piecewise", breaks = list(6), rates = list(0.1, 0.05))))))
  # the job, end to end: refused by the validator, nothing drawn
  job <- vcr_test_run(vcr_test_job("patients.time_to_event", base(no_tail), seed = 1L, job_id = "job_n28e"))
  # the simulators called directly (the second line): a profile without a tail, with a rate too many, and a distribution with a rate too few
  refusal <- function(expr) tryCatch({ force(expr); "ran" }, vcr_refusal = function(e) paste0(e$issue$code, "@", e$issue$field))
  direct <- c(refusal(vcr_accrual_times(5L, list(kind = "piecewise", breaks = list(3, 6), rates = list(2, 4, 6)))),
              refusal(vcr_accrual_times(5L, list(kind = "piecewise", breaks = list(3, 6), rates = list(2, 4, 6, 8), tail = 6))),
              refusal(vcr_control_distribution(list(controlDistribution = list(kind = "piecewise", breaks = list(6, 12), rates = list(0.1, 0.05))))))
  ok <- identical(found$tail_generator, want_tail) && identical(found$tail_simulate, want_tail) && identical(found$short_generator, want_rates) &&
    identical(found$long_simulate, want_rates) && identical(found$distribution, "scenario_value_invalid@scenario.truth.controlDistribution.rates") &&
    identical(found$distribution_simulate, "scenario_value_invalid@scenario.truth.controlDistribution.rates") && length(found$fine) == 0L &&
    identical(job$status, "failed") && identical(vcr_test_issue_codes(job), "scenario_field_missing") &&
    identical(direct, c(want_tail, want_rates, "scenario_value_invalid@scenario.truth.controlDistribution.rates"))
  list(pass = ok,
       detail = sprintf("no tail -> %s / %s; two rates for two breaks -> %s; four rates -> %s; a piecewise distribution with two breaks and two rates -> %s, with one break and three rates -> %s; a complete profile and distribution -> %d issues; the job -> %s (%s); direct calls -> %s",
                        paste(found$tail_generator, collapse = "+"), paste(found$tail_simulate, collapse = "+"), paste(found$short_generator, collapse = "+"), paste(found$long_simulate, collapse = "+"),
                        paste(found$distribution, collapse = "+"), paste(found$distribution_simulate, collapse = "+"), length(found$fine), job$status, paste(vcr_test_issue_codes(job), collapse = ","),
                        paste(direct, collapse = " / ")))
})

vcr_case("N28f", c("AC-04", "AC-11"), function() {
  # R's `$` matches a name by its prefix when the name is absent and exactly one name begins with it, so `sc$correlation` was
  # `sc$correlationSource` for a literature population that states a source and no matrix, and `spec$correlation` was
  # `spec$correlationScale` for a scenario population that states a scale and no matrix: the string "assumed" or "spearman" went to
  # the matrix reader, which refused a natural scenario for the wrong reason ("the correlation is a p x p matrix"). Neither
  # scenario states a correlation, so the variables are independent and the job runs. (The cited route, with a matrix, is N28a.)
  n <- 4000L
  d1 <- tempfile("n28fa"); d2 <- tempfile("n28fb")
  lit <- vcr_test_run(vcr_test_job("population.literature", list(baselineTable = list(list(variable = "age", mean = 61, sd = 9), list(variable = "sbp", mean = 138, sd = 15)),
                                                                  n = n, correlationSource = "assumed"), seed = 2830L, job_id = "job_n28f_l"), output_dir = d1)
  scn <- vcr_test_run(vcr_test_job("population.scenario", list(n = n, population = list(correlationScale = "spearman", variables = list(
    list(name = "age", family = "normal", mean = 60, sd = 9), list(name = "bmi", family = "normal", mean = 27, sd = 4)))), seed = 2831L, job_id = "job_n28f_s"), output_dir = d2)
  dl <- vcr_test_table(lit, "population", d1); ds <- vcr_test_table(scn, "population", d2)
  r_l <- if (is.null(dl)) NA_real_ else stats::cor(dl$age, dl$sbp); r_s <- if (is.null(ds)) NA_real_ else stats::cor(ds$age, ds$bmi); band <- 4 / sqrt(n)
  unlink(c(d1, d2), recursive = TRUE)
  list(pass = identical(lit$status, "succeeded") && identical(scn$status, "succeeded") && isTRUE(abs(r_l) < band) && isTRUE(abs(r_s) < band) &&
         identical(lit$diagnostics$correlationSource, "assumed"),
       detail = sprintf("literature population with correlationSource 'assumed' and no matrix -> %s (%s), cor(age, sbp) %.3f; scenario population with correlationScale 'spearman' and no matrix -> %s (%s), cor(age, bmi) %.3f; independence band +-%.3f",
                        lit$status, paste(vcr_test_issue_codes(lit), collapse = ","), r_l, scn$status, paste(vcr_test_issue_codes(scn), collapse = ","), r_s, band))
})
