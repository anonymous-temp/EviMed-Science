# E09 — the T0 journey, end to end in the engine (AC-02).
#
# The plan's headline claim is that a study with no patient data at all is a
# whole journey and not a demo (§3.2): a population declared as parameters, a
# set of virtual patients under a named model, and a simulated trial — with the
# four counts saying plainly that no real person is in any of it.
#
# Each of those three steps has its own case already. What this one asserts is
# the chain: that the output of each step is accepted as the input of the next
# without a snapshot anywhere, and that `realPatients` stays 0 while
# `generatedRecords` grows — which is the arithmetic AC-09 exists for, seen
# from the one direction that could hide it.

vcr_case("E09", c("AC-02", "AC-09"), function() {
  base <- function(id, kind, method, scenario, seed = 209L) {
    list(jobId = id, studyId = "std_e09", kind = kind, method = method, methodVersion = "1.0.0",
         protocolVersion = 1L, seed = seed, cpuSecondsLimit = 300,
         inputs = list(list(kind = "assumption", id = "asm_e09@1")), scenario = scenario)
  }

  # 1. A population declared as parameters — no data, no snapshot input. The
  #    assumption card behind each number is the study's; here it is frozen
  #    into the scenario, which is what every job carries.
  pop_job <- base("job_e09_pop", "generate_population", "population.scenario", list(
    n = 600L,
    population = list(
      variables = list(
        list(name = "age", family = "normal", mean = 63, sd = 9, min = 18, max = 85),
        list(name = "male", family = "bernoulli", prob = 0.58),
        list(name = "ldh", family = "lognormal", meanlog = 5.4, sdlog = 0.35)),
      constraints = list(list(name = "adult", expression = "age >= 18")))
  ))
  pop <- vcr_run_job(pop_job)
  pop_issues <- vcr_validate_result(pop)

  # 2. Virtual patients from a literature-fitted survival model: the tier the
  #    plan calls 文献模型, which is everything a T0 study can have.
  pat_job <- base("job_e09_pat", "generate_patients", "patients.time_to_event", list(
    design = list(nTreat = 400, nControl = 200),
    endpoint = list(type = "time_to_event"),
    # The control arm's distribution is the literature model the evidence step
    # fitted (median 4.1 months); the hazard ratio is the assumption card.
    truth = list(controlMedian = 4.1, hazardRatio = 0.60),
    accrual = list(kind = "uniform", duration = 16.4, followup = 6)
  ))
  pat <- vcr_run_job(pat_job)
  pat_issues <- vcr_validate_result(pat)

  # 3. The trial the study is actually asking about: 2:1, time to event, with
  #    the effect taken from the same evidence-derived assumption.
  sim_job <- utils::modifyList(base("job_e09_sim", "design_simulation", "design.simulate", list(
    design = list(kind = "two_arm_fixed", nTreat = 120, nControl = 60),
    endpoint = list(type = "time_to_event"),
    truth = list(controlMedian = 4.1, hazardRatio = 0.60),
    analysis = list(method = "logrank", alpha = 0.025, sided = 1),
    accrual = list(kind = "uniform", duration = 16.4, followup = 6),
    performance = c("power")
  )), list(replicates = 2000L, cores = VCR_TEST_CORES))
  sim <- vcr_run_job(sim_job)
  sim_issues <- vcr_validate_result(sim)

  counts_of <- function(result) {
    c(real = as.numeric(result$counts$realPatients %||% 0),
      generated = as.numeric(result$counts$generatedRecords %||% 0))
  }
  pop_counts <- counts_of(pop)
  pat_counts <- counts_of(pat)
  sim_counts <- counts_of(sim)
  power <- NA_real_
  mcse <- NA_real_
  for (m in sim$measures) {
    if (identical(m$name, "power")) { power <- m$value; mcse <- m$mcse %||% NA_real_ }
  }

  ok <- identical(pop$status, "succeeded") && identical(pat$status, "succeeded") && identical(sim$status, "succeeded") &&
    length(pop_issues) == 0L && length(pat_issues) == 0L && length(sim_issues) == 0L &&
    pop_counts[["real"]] == 0 && pat_counts[["real"]] == 0 && sim_counts[["real"]] == 0 &&
    pop_counts[["generated"]] > 0 && pat_counts[["generated"]] > 0 &&
    is.finite(power) && power > 0 && power < 1 && is.finite(mcse) && mcse > 0

  list(pass = ok,
       detail = sprintf(
         "population %s (real %g, generated %g); patients %s (real %g, generated %g); trial %s power %.4f +-%.4f (real %g); validator issues %d/%d/%d",
         pop$status, pop_counts[["real"]], pop_counts[["generated"]],
         pat$status, pat_counts[["real"]], pat_counts[["generated"]],
         sim$status, power, mcse, sim_counts[["real"]],
         length(pop_issues), length(pat_issues), length(sim_issues)))
})
