# E09 — the T0 journey, end to end in the engine (AC-02, AC-09).
#
# The plan's headline claim is that a study with no patient data at all is a
# whole journey and not a demo (3.2): a population declared as parameters, a set
# of virtual patients under a named model, and a simulated trial -- with the four
# counts saying plainly that no real person is in any of it.
#
# The first version of this case ran three unrelated jobs side by side and
# checked that each one succeeded; nothing passed from one to the next, and the
# only numeric assertion was `0 < power < 1`, which no plausible engine fails
# (CE-33). This one is the chain. The population job's OUTPUT TABLE is the
# patients job's input (through the data root, by location and hash, exactly as
# the control plane hands a step's output to the next); the trial is simulated
# under the effect the PATIENTS actually carry, estimated from the patients job's
# output table -- the hazard ratio by a Cox fit, the control median by
# Kaplan-Meier -- not under the numbers the scenario stated; and the trial's
# power is checked against its own analytic reference. `realPatients` is 0 at
# every step while `generatedRecords` is the size of the table each step made.

vcr_case("E09", c("AC-02", "AC-09"), function() {
  suppressMessages(library(survival))
  dir <- tempfile("e09"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  none <- list(list(kind = "assumption", id = "asm_e09@1"))
  n <- 600L

  # 1. A population declared as parameters -- no data, no snapshot input. The rule
  #    is data in the closed grammar, and it binds: about one draw in five falls
  #    under 55 and is redrawn until the table holds n members that satisfy it.
  pop <- vcr_test_run(vcr_test_job("population.scenario", list(
    n = n,
    population = list(
      variables = list(
        list(name = "age", family = "normal", mean = 63, sd = 9),
        list(name = "male", family = "bernoulli", prob = 0.58),
        list(name = "ldh", family = "lognormal", meanlog = 5.4, sdlog = 0.35)),
      constraints = list(list(name = "adult", rule = list(op = "compare", column = "age", comparator = "gte", value = 55))))),
    none, seed = 209L, job_id = "job_e09_pop"), output_dir = dir)
  pop_df <- vcr_test_table(pop, "population", dir)

  # 2. The population becomes the patients' input: same rows, the members of the
  #    trial, a literature survival model (control median 4.1 months, hazard ratio 0.6).
  pop_in <- vcr_test_chain_input(pop, "population", dir, "pop_e09@1", source = "synthetic")
  pat <- vcr_test_run(vcr_test_job("patients.time_to_event", list(
    design = list(nTreat = 400, nControl = 200),
    endpoint = list(type = "time_to_event"),
    truth = list(controlMedian = 4.1, hazardRatio = 0.60, covariateEffects = list(ldh = 0.001)),
    accrual = list(kind = "uniform", duration = 16.4, followup = 6)),
    list(pop_in), seed = 209L, job_id = "job_e09_pat"), output_dir = dir)
  pat_df <- vcr_test_table(pat, "virtual-patients", dir)

  # 3. What the patients carry, read off their output table.
  cx <- summary(survival::coxph(survival::Surv(time, status) ~ arm + I(ldh - mean(ldh)), pat_df))$coefficients
  hr_hat <- exp(cx["arm", 1]); hr_se <- cx["arm", 3]
  km <- survival::survfit(survival::Surv(time, status) ~ 1, pat_df[pat_df$arm == 0L, ])
  med_hat <- unname(summary(km)$table["median"]); med_lo <- unname(summary(km)$table["0.95LCL"]); med_hi <- unname(summary(km)$table["0.95UCL"])

  # 4. The trial the study asks about (2:1, 180 patients), simulated under the
  #    effect estimated from the patients, rounded as an assumption card would be.
  hr_used <- round(hr_hat, 3); med_used <- round(med_hat, 2)
  sim <- vcr_test_run(vcr_test_job("design.simulate", list(
    design = list(kind = "two_arm_fixed", nTreat = 120, nControl = 60),
    endpoint = list(type = "time_to_event"),
    truth = list(controlMedian = med_used, hazardRatio = hr_used),
    analysis = list(method = "logrank", alpha = 0.025, sided = 1),
    accrual = list(kind = "uniform", duration = 16.4, followup = 6),
    performance = list("power")),
    none, seed = 209L, replicates = 3000L, cores = VCR_TEST_CORES, job_id = "job_e09_sim"))
  chk <- sim$diagnostics$analyticCheck
  # what the trial's power would be under the numbers the SCENARIO stated: the
  # estimated effect is what reached the simulator only if the two differ and the
  # simulation follows the estimated one
  stated <- vcr_logrank_power(0.60, vcr_dist_exponential_from_median(4.1), 120, 60, 16.4, 6, 0, 0.025)
  power <- vcr_measure_value(sim, "power"); mcse <- vcr_get_measure(sim, "power")$mcse

  cnt <- function(r, k) as.numeric(r$counts[[k]] %||% 0)
  ok_status <- all(vapply(list(pop, pat, sim), function(r) identical(r$status, "succeeded"), logical(1)))
  redrawn <- pop$diagnostics$constraintEnforcement
  ok_pop <- nrow(pop_df) == n && min(pop_df$age) >= 55 && redrawn$rowsRedrawn > 0.1 * n && redrawn$roundsUsed >= 1 && vcr_measure_value(pop, "constraint_violations") == 0 && abs(mean(pop_df$male) - 0.58) < 4 * sqrt(0.58 * 0.42 / n)
  ok_link <- nrow(pat_df) == n && isTRUE(all.equal(sort(pat_df$ldh), sort(pop_df$ldh), tolerance = 1e-9)) && isTRUE(all.equal(sort(pat_df$age), sort(pop_df$age), tolerance = 1e-9)) &&
    identical(pat$diagnostics$mode, "population") && sum(pat_df$arm) == 400L
  ok_est <- abs(log(hr_hat) - log(0.6)) <= 4 * hr_se && med_used > 0 && 4.1 >= med_lo - 0.5 * (med_hi - med_lo) && 4.1 <= med_hi + 0.5 * (med_hi - med_lo)
  ok_sim <- is.finite(power) && power > 0.3 && power < 1 && isTRUE(chk$withinThreeMcse) && abs(chk$simulated - power) < 1e-12 &&
    abs(chk$value - stated$power) > 0.005
  ok_counts <- cnt(pop, "realPatients") == 0 && cnt(pat, "realPatients") == 0 && cnt(sim, "realPatients") == 0 &&
    cnt(pop, "generatedRecords") == n && cnt(pat, "generatedRecords") == n && cnt(sim, "generatedRecords") > n &&
    cnt(pat, "events") == sum(pat_df$status)
  ok_valid <- length(vcr_validate_result(pop)) == 0L && length(vcr_validate_result(pat)) == 0L && length(vcr_validate_result(sim)) == 0L

  list(pass = ok_status && ok_pop && ok_link && ok_est && ok_sim && ok_counts && ok_valid,
       detail = sprintf("population %d rows, the age rule binding (min age %.1f, %g rows redrawn in %d rounds, none left in violation), male %.3f (want .58); the patients read that table (same rows: %s, 400/200 arms); estimated from their output: hazard ratio %.3f (%.2f SE from the stated 0.60), control median %.2f (95%% CI %.2f-%.2f, stated 4.1); trial simulated under %.3f / %.2f: power %.4f +- %.4f vs analytic %.4f (%.2f MCSE; %.4f under the stated numbers); real patients %g / %g / %g, generated %g / %g / %g",
                        nrow(pop_df), min(pop_df$age), redrawn$rowsRedrawn, redrawn$roundsUsed, mean(pop_df$male), ok_link, hr_hat, abs(log(hr_hat) - log(0.6)) / hr_se, med_hat, med_lo, med_hi,
                        hr_used, med_used, power, mcse, chk$value, chk$differenceInMcse, stated$power,
                        cnt(pop, "realPatients"), cnt(pat, "realPatients"), cnt(sim, "realPatients"),
                        cnt(pop, "generatedRecords"), cnt(pat, "generatedRecords"), cnt(sim, "generatedRecords")))
})
