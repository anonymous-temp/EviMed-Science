# N43 / N44 — a design is sized for an effect, and the type I error of a design is a simulation's measure.
#
# Live acceptance (2026-10-04): three `design.analytic` jobs asked of a scenario with no effect (hazard ratio 1,
# equal binary rates) failed with no reason anywhere. The closed-form sizes divide by the effect, the required
# size is infinite, and the only thing the result said was a non-finite measure by index. N43 walks every
# design x endpoint the method supports with a null effect: each either computes a finite number or refuses by name
# (`design_effect_null` on the field the scenario states its effect in, or the protocol's own
# `scenario_value_invalid`), and none leaves the result validator to find an infinity. N44 shows the answer the
# refusal points to: `design.simulate` on the same null scenarios reports a type I error near alpha.

.n43_scenario <- function(design, endpoint, truth, analysis = list(alpha = 0.025, power = 0.9, sided = 1), extra = list()) {
  c(list(design = design, endpoint = list(type = endpoint), truth = truth, analysis = analysis), extra)
}
.n43_accrual <- list(duration = 24, followup = 12)

# The null scenarios, one per way a scenario states "no effect". `field` is where the refusal must point.
.n43_null_cases <- function() list(
  incident_tte = list(design = "two_arm_fixed", endpoint = "time_to_event", field = "scenario.truth.hazardRatio",
    scenario = .n43_scenario(list(kind = "two_arm_fixed", allocation = 0.5), "time_to_event", list(hazardRatio = 1, controlMedian = 6),
                             list(alpha = 0.05, power = 0.8, sided = 2), list(accrual = .n43_accrual))),
  incident_binary = list(design = "two_arm_fixed", endpoint = "binary", field = "scenario.truth.treatmentRate",
    scenario = .n43_scenario(list(kind = "two_arm_fixed"), "binary", list(controlRate = 0.3, treatmentRate = 0.3), list(alpha = 0.025, sided = 1))),
  group_sequential = list(design = "group_sequential", endpoint = "time_to_event", field = "scenario.truth.hazardRatio",
    scenario = .n43_scenario(list(kind = "group_sequential", informationRates = c(0.5, 1)), "time_to_event", list(hazardRatio = 1, controlMedian = 12),
                             extra = list(accrual = .n43_accrual))),
  continuous = list(design = "two_arm_fixed", endpoint = "continuous", field = "scenario.truth.effect",
    scenario = .n43_scenario(list(kind = "two_arm_fixed"), "continuous", list(effect = 0, sd = 1))),
  binary_risk_difference = list(design = "two_arm_fixed", endpoint = "binary", field = "scenario.truth.riskDifference",
    scenario = .n43_scenario(list(kind = "two_arm_fixed"), "binary", list(controlRate = 0.3, riskDifference = 0))),
  binary_odds_ratio = list(design = "two_arm_fixed", endpoint = "binary", field = "scenario.truth.oddsRatio",
    scenario = .n43_scenario(list(kind = "two_arm_fixed"), "binary", list(controlRate = 0.3, oddsRatio = 1)))
)

# The same designs with a small real effect: these compute, and every measure is a finite number.
.n43_near_null <- function() list(
  tte = .n43_scenario(list(kind = "two_arm_fixed"), "time_to_event", list(hazardRatio = 0.99, controlMedian = 12), extra = list(accrual = .n43_accrual)),
  group_sequential = .n43_scenario(list(kind = "group_sequential", informationRates = c(0.5, 1)), "time_to_event", list(hazardRatio = 0.99, controlMedian = 12), extra = list(accrual = .n43_accrual)),
  continuous = .n43_scenario(list(kind = "two_arm_fixed"), "continuous", list(effect = 0.01, sd = 1)),
  binary = .n43_scenario(list(kind = "two_arm_fixed"), "binary", list(controlRate = 0.3, treatmentRate = 0.301)))

vcr_case("N43", c("AC-10", "AC-29"), function() {
  nulls <- .n43_null_cases()
  runs <- lapply(nulls, function(case) vcr_test_run(vcr_test_job("design.analytic", case$scenario, job_id = "job_n43")))
  issues_of <- function(r) r$diagnostics$issues %||% list()
  refused <- vapply(names(nulls), function(nm) {
    r <- runs[[nm]]; iss <- issues_of(r)
    identical(r$status, "failed") && length(iss) == 1L && identical(iss[[1]]$code, "design_effect_null") &&
      identical(iss[[1]]$field, nulls[[nm]]$field) && grepl("design.simulate", iss[[1]]$detail, fixed = TRUE) &&
      is.null(r$diagnostics$resultValidationIssues) && !length(r$measures)
  }, logical(1))

  # near-null controls: a small effect is not refused and carries finite numbers only
  near <- lapply(.n43_near_null(), function(sc) vcr_test_run(vcr_test_job("design.analytic", sc, job_id = "job_n43_near")))
  finite_all <- function(r) length(r$measures) > 0L && all(vapply(r$measures, function(m) is.numeric(m$value) && is.finite(m$value), logical(1)))
  near_ok <- vapply(near, function(r) identical(r$status, "succeeded") && finite_all(r), logical(1))

  # single-arm exact: it is given its size and enumerates the binomial, so a null response rate has an answer
  single <- vcr_test_run(vcr_test_job("design.analytic", .n43_scenario(list(kind = "single_arm", n = 40), "binary",
    list(nullRate = 0.2, responseRate = 0.2), list(alpha = 0.05, method = "exact_binomial", alternative = "greater", sided = 1)), job_id = "job_n43_single"))
  t1 <- vcr_measure_value(single, "type_one_error"); pw <- vcr_measure_value(single, "power")
  single_ok <- identical(single$status, "succeeded") && is.finite(t1) && t1 <= 0.05 + 1e-12 && isTRUE(all.equal(t1, pw))

  # Simon: equal null and alternative rates are refused by the protocol on the alternative rate; a search that finds no
  # design within maxN is refused on maxN, never returned as an empty success
  simon_eq <- vcr_test_run(vcr_test_job("design.analytic", .n43_scenario(list(kind = "simon_two_stage", maxN = 20), "binary",
    list(nullRate = 0.2, alternativeRate = 0.2), list(alpha = 0.05, power = 0.8)), job_id = "job_n43_simon_eq"))
  simon_none <- vcr_test_run(vcr_test_job("design.analytic", .n43_scenario(list(kind = "simon_two_stage", maxN = 12), "binary",
    list(nullRate = 0.1, alternativeRate = 0.12), list(alpha = 0.05, power = 0.95)), job_id = "job_n43_simon_none"))
  simon_ok <- identical(simon_eq$status, "failed") && identical(simon_eq$diagnostics$issues[[1]]$field, "scenario.truth.alternativeRate") &&
    identical(simon_none$status, "failed") && identical(simon_none$diagnostics$issues[[1]]$code, "scenario_value_invalid") &&
    identical(simon_none$diagnostics$issues[[1]]$field, "scenario.design.maxN")

  # the walk walked: every design x endpoint the method supports is among the null cases or the explained exceptions
  support <- vcr_domain()$designSupport[["design.analytic"]]
  supported <- sort(unlist(lapply(names(support), function(k) paste(k, unlist(support[[k]])))))
  covered <- sort(unique(c(vapply(nulls, function(case) paste(case$design, case$endpoint), character(1)),
                           "single_arm binary", "simon_two_stage binary")))
  walked <- identical(supported, covered)

  list(pass = all(refused) && all(near_ok) && single_ok && simon_ok && walked && length(nulls) >= 6L,
       detail = sprintf("%d null scenarios, each refused as design_effect_null on its own field with the type I error pointed at design.simulate and no measure: %s; near-null controls (HR 0.99, effect 0.01, 0.301 against 0.3) compute finite numbers: %s; exact single-arm at the null rate computes type I error %.4f equal to its power: %s; Simon equal rates refused on the alternative rate and a search with no design within maxN refused on maxN: %s; every one of the %d supported design-endpoint pairs is covered: %s",
                        length(nulls), paste(ifelse(refused, "yes", "NO"), collapse = "/"), paste(ifelse(near_ok, "yes", "NO"), collapse = "/"),
                        t1, single_ok, simon_ok, length(supported), walked))
})

vcr_case("N44", c("AC-10", "AC-28", "AC-29"), function() {
  # The type I error of a design is measured on the null scenario by simulation. The replicate floor of a null scenario
  # is 20,000, so the designs are small; the band is four Monte-Carlo errors plus 0.003 for the asymptotic tests.
  base <- list(
    incident_tte = list(alpha = 0.05, scenario = .n43_scenario(list(kind = "two_arm_fixed", nTreat = 80, nControl = 80), "time_to_event",
      list(hazardRatio = 1, controlMedian = 6), list(method = "logrank", alpha = 0.05, sided = 2),
      list(accrual = list(kind = "uniform", duration = 24, followup = 12), performance = c("type_one_error")))),
    incident_binary = list(alpha = 0.025, scenario = .n43_scenario(list(kind = "two_arm_fixed", nTreat = 300, nControl = 300), "binary",
      list(controlRate = 0.3, treatmentRate = 0.3), list(method = "risk_difference", alpha = 0.025, sided = 1), list(performance = c("type_one_error")))),
    continuous = list(alpha = 0.025, scenario = .n43_scenario(list(kind = "two_arm_fixed", nTreat = 60, nControl = 60), "continuous",
      list(effect = 0, sd = 1), list(method = "ttest", alpha = 0.025, sided = 1), list(performance = c("type_one_error")))))
  out <- lapply(names(base), function(nm) {
    r <- vcr_test_run(vcr_test_job("design.simulate", base[[nm]]$scenario, seed = 4343L, replicates = 20000L, cores = VCR_TEST_CORES, job_id = "job_n44"))
    m <- Filter(function(x) identical(x$name, "type_one_error"), r$measures)
    list(name = nm, status = r$status, alpha = base[[nm]]$alpha, value = if (length(m)) m[[1]]$value else NA_real_, mcse = if (length(m)) m[[1]]$mcse else NA_real_)
  })
  within <- vapply(out, function(o) identical(o$status, "succeeded") && is.finite(o$value) && abs(o$value - o$alpha) <= 4 * o$mcse + 0.003, logical(1))
  list(pass = all(within) && length(out) == 3L,
       detail = paste(vapply(out, function(o) sprintf("%s type I error %.4f (+-%.4f) at alpha %.3f", o$name, o$value, o$mcse, o$alpha), character(1)), collapse = "; "))
})
