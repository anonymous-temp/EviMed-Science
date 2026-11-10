# N100 — what an adaptive design says about PEOPLE when its answer is in events (live check 2026-11-04, design.confirmatory 1.2.0).
#
# A person asked "on average, how many people?" of a time-to-event re-estimation; the result gave events, and the conversation turned them into
# people by itself (and quoted the simulation's own enrolment, 1,466 on average beside a plan of 830). The engine now answers in people when the
# scenario states the accrual and the control median, and says which keys give them when it does not. The checks are outside the engine's code:
#
#   a  group sequential: the number enrolled at each look against a patient-level simulation in plain R (even entry over the accrual, exponential
#      event times and dropout, the look is the day the k-th event happens), and the expected number is those numbers weighted by the stopping
#      probabilities of the table, the identity written out
#   b  re-estimation: with a cap one event above the plan the trial cannot grow, so the expected number of people is closed form -- the people
#      enrolled by the interim for a trial that stops there, the plan's people for one that goes on -- and the plan's and the cap's people are the
#      events over the Lachin-Foulkes chance of an event written out here; the simulation's own enrolment is not the answer
#   c  selection and enrichment: the chance of an event of one person, written out (Lachin & Foulkes 1986) and checked against a simulation of
#      people, turns the events into people; a scenario that states one of the accrual and the control median without the other is refused by
#      name, and the 1.1.0 label cannot carry the accrual keys
#   d  the previous release: a job labelled 1.1.0, and a selection or an enrichment that states no accrual, return the bytes of 1.1.0's output
#      (the output hashes were recorded from the release before this one, same seeds), and the one that cannot say people says so and which keys give them

.n100_accrual <- list(accrual = list(duration = 18, followup = 12, dropoutAnnual = 0.05))
.n100_median <- 12
.n100_eta <- -log(1 - 0.05) / 12
# the chance that a person with event hazard `lambda` has an event, uniform entry over [0, A], analysed at A + F (Lachin & Foulkes 1986)
.n100_prob <- function(lambda, A = 18, F = 12, eta = .n100_eta) { s <- lambda + eta; lambda / s * (1 - (exp(-s * F) - exp(-s * (A + F))) / (s * A)) }
# people per head of a 1:1 comparison of the control with a group whose hazard ratio against it is `hr`
.n100_per_head <- function(hr) 0.5 * .n100_prob(log(2) / .n100_median) + 0.5 * .n100_prob(hr * log(2) / .n100_median)

#' Patient-level: `n` people (a share `treated` of them at hazard ratio `hr`) enter evenly over [0, 18], event and dropout times are exponential,
#' and the look is the calendar day of the `events`-th event. The mean number entered by that day, with its error.
.n100_enrolled <- function(n, treated, hr, events, sims = 1500L, seed = 100101L) {
  set.seed(seed, kind = "L'Ecuyer-CMRG")
  rate <- log(2) / .n100_median * c(rep(1, n - round(n * treated)), rep(hr, round(n * treated)))
  got <- vapply(seq_len(sims), function(i) {
    entry <- stats::runif(n, 0, 18); t_event <- stats::rexp(n, rate); t_drop <- stats::rexp(n, .n100_eta)
    day <- sort((entry + t_event)[t_event < t_drop])
    sum(entry <= day[round(events)])
  }, numeric(1))
  c(mean = mean(got), se = stats::sd(got) / sqrt(sims))
}

.n100_job <- function(design, truth, extra = .n100_accrual, endpoint = "time_to_event", id = "job_n100", version = NULL, seed = 20261104L) {
  sc <- c(list(design = design, endpoint = list(type = endpoint), truth = truth, analysis = list(alpha = 0.025, power = 0.9)), extra)
  job <- vcr_test_job("design.confirmatory", vcr_test_conf_scenario(sc), job_id = id, seed = seed)
  if (!is.null(version)) job$methodVersion <- version
  job
}

vcr_case("N100a", c("AC-29", "AC-31"), function() {
  r <- vcr_test_run(.n100_job(list(kind = "futility_group_sequential", informationRates = c(0.5, 1)), list(plannedEffect = 0.75, controlMedian = .n100_median), id = "job_n100a"))
  conf <- r$diagnostics$confirmatory; people <- conf$people
  n <- people$maxPatients; max_events <- vcr_measure_value(r, "max_events")
  worst <- 0; text <- character(); identity_ok <- TRUE
  for (role in c("planned", "null")) {
    hr <- if (identical(role, "planned")) 0.75 else 1
    row <- Filter(function(e) identical(e$role, role), conf$effects)[[1]]
    got <- vapply(people$atLooks, function(l) if (identical(role, "planned")) l$enrolledPlanned else l$enrolledNull, numeric(1))
    sim <- lapply(c(0.5, 1), function(rate) .n100_enrolled(n, 0.5, hr, rate * max_events))
    z <- vapply(seq_along(got), function(i) abs(got[i] - sim[[i]][["mean"]]) / max(sim[[i]][["se"]], 0.3), numeric(1))
    worst <- max(worst, z)
    # the expected number is the numbers at the looks weighted by the probability of ending there
    ended <- vapply(1:2, function(i) row$cells[[sprintf("stop_efficacy_%d", i)]]$value + row$cells[[sprintf("stop_futility_%d", i)]]$value, numeric(1))
    expected <- ended[1] * got[1] + (1 - ended[1]) * got[2]
    identity_ok <- identity_ok && abs(expected - row$cells$expected_patients$value) < 1e-6
    text <- c(text, sprintf("%s: enrolled at the looks %s vs simulated %s, expected %.1f (identity %.1f)", role, paste(sprintf("%.1f", got), collapse = "/"),
                            paste(sprintf("%.1f", vapply(sim, function(s) s[["mean"]], numeric(1))), collapse = "/"), row$cells$expected_patients$value, expected))
  }
  # the first look falls before the accrual has ended, so the saving in people is real there and only there; the final look enrols everyone
  last <- people$atLooks[[2]]$enrolledPlanned
  ok <- c(looks = worst < 4, identity = identity_ok, everyone = abs(last - n) < 1e-6, fewer = people$atLooks[[1]]$enrolledPlanned < n,
          measures = !is.na(vcr_measure_value(r, "expected_patients")) && !is.na(vcr_measure_value(r, "expected_patients_h0")) && vcr_measure_value(r, "expected_patients") <= n)
  list(pass = all(ok), detail = sprintf("%s; worst %.2f standard errors (tol 4); max patients %s%s", paste(text, collapse = " | "), worst, n, if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

vcr_case("N100b", c("AC-29", "AC-31"), function() {
  # a cap one event above the plan: the trial cannot grow, whatever the interim says
  plan <- 510L
  r <- vcr_test_run(.n100_job(list(kind = "sample_size_reestimation", informationRates = c(0.5, 1), plannedSize = plan, maxSampleSizeFactor = 1.0001),
                              list(plannedEffect = 0.75, effects = list(0.8), controlMedian = .n100_median), id = "job_n100b"))
  conf <- r$diagnostics$confirmatory; people <- conf$people
  per_head <- .n100_per_head(0.75)
  n0 <- ceiling(plan / per_head); cap <- ceiling(1.0001 * plan)
  row <- Filter(function(e) identical(e$role, "planned"), conf$effects)[[1]]
  p1 <- row$cells$early_stop_probability
  at_interim <- .n100_enrolled(n0, 0.5, 0.75, ceiling(0.5 * plan))
  closed <- p1$value * at_interim[["mean"]] + (1 - p1$value) * n0
  got <- row$cells$expected_patients
  tol <- 3 * (p1$mcse * abs(n0 - at_interim[["mean"]]) + at_interim[["se"]]) + 3 * got$mcse + 3
  # the simulation's own enrolment would have been the cap's people on the cap's schedule: the old number, kept out of the answer
  ok <- c(expected = abs(got$value - closed) <= tol, plan = abs(people$plannedPatients - n0) <= 1, cap = abs(people$maxPatients - ceiling(cap / per_head)) <= 1,
          headline = identical(vcr_measure_value(r, "expected_patients"), got$value) && identical(vcr_measure_value(r, "max_patients"), people$maxPatients),
          below_plan_scale = got$value < 1.1 * n0)
  list(pass = all(ok), detail = sprintf("expected people %.1f (MCSE %.2f) vs closed form %.1f = %.3f x %.1f (enrolled by the interim, simulated) + %.3f x %s (the plan's people), tol %.1f; plan %s vs %s, cap %s vs %s%s",
                                        got$value, got$mcse, closed, p1$value, at_interim[["mean"]], 1 - p1$value, n0, tol, people$plannedPatients, n0, people$maxPatients, ceiling(cap / per_head),
                                        if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

vcr_case("N100c", c("AC-29", "AC-30"), function() {
  # the chance of an event of one person, against people
  set.seed(100301L, kind = "L'Ecuyer-CMRG")
  sim_prob <- function(hr, n = 400000L) {
    entry <- stats::runif(n, 0, 18); t_event <- stats::rexp(n, hr * log(2) / .n100_median); t_drop <- stats::rexp(n, .n100_eta)
    ev <- t_event < t_drop & entry + t_event <= 30
    c(mean = mean(ev), se = sqrt(mean(ev) * (1 - mean(ev)) / n))
  }
  z <- vapply(c(1, 0.6, 0.9), function(hr) { s <- sim_prob(hr); abs(.n100_prob(hr * log(2) / .n100_median) - s[["mean"]]) / s[["se"]] }, numeric(1))
  multi <- vcr_test_run(.n100_job(list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 240),
                                  list(effectScenarios = list(list(0.9, 0.75, 0.6)), controlMedian = .n100_median), id = "job_n100c1"))
  enrich <- vcr_test_run(.n100_job(list(kind = "enrichment", informationRates = c(0.5, 1), subsetPrevalence = 0.4, plannedSize = 240),
                                   list(subsetEffects = list(list(subset = 0.6, rest = 0.9)), controlMedian = .n100_median), id = "job_n100c2"))
  # control and the best arm / control and the population treated, 1:1
  head_multi <- .n100_per_head(0.6)
  head_enrich <- 0.5 * .n100_prob(log(2) / .n100_median) + 0.5 * (0.4 * .n100_prob(0.6 * log(2) / .n100_median) + 0.6 * .n100_prob(0.9 * log(2) / .n100_median))
  row_of <- function(r) Filter(function(e) identical(e$role, "assumed"), r$diagnostics$confirmatory$effects)[[1]]
  e_multi <- row_of(multi)$cells; e_enrich <- row_of(enrich)$cells
  ok <- c(chance = max(z) < 4,
          multi_max = identical(vcr_measure_value(multi, "max_patients_from_events"), ceiling(240 / head_multi - 1e-9)),
          multi_expected = abs(e_multi$expected_patients_from_events$value - e_multi$expected_events$value / head_multi) < 1e-6,
          enrich_max = identical(vcr_measure_value(enrich, "max_patients_from_events"), ceiling(240 / head_enrich - 1e-9)),
          enrich_expected = abs(e_enrich$expected_patients_from_events$value - e_enrich$expected_events$value / head_enrich) < 1e-6,
          says = identical(multi$diagnostics$confirmatory$people$basis, "events_over_event_probability") && isTRUE(multi$diagnostics$confirmatory$people$computed))
  # one of the accrual and the control median alone is not silently ignored, and the 1.1.0 label cannot carry the accrual
  keys <- function(j) as.character(.n00_issue_keys(vcr_validate_job(vcr_test_json(j))))
  only_accrual <- keys(.n100_job(list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 240), list(effectScenarios = list(list(0.9, 0.75, 0.6))), id = "job_n100c3"))
  only_median <- keys(.n100_job(list(kind = "enrichment", informationRates = c(0.5, 1), subsetPrevalence = 0.4, plannedSize = 240), list(subsetEffects = list(list(subset = 0.6, rest = 0.9)), controlMedian = 12), extra = list(), id = "job_n100c4"))
  labelled <- keys(.n100_job(list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 240), list(effectScenarios = list(list(0.9, 0.75, 0.6)), controlMedian = 12), id = "job_n100c5", version = "1.1.0"))
  plain_old <- keys(.n100_job(list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 240), list(effectScenarios = list(list(0.9, 0.75, 0.6))), extra = list(), id = "job_n100c6", version = "1.1.0"))
  refused <- c(accrual_alone = "scenario_field_missing@scenario.truth.controlMedian" %in% only_accrual, median_alone = "scenario_field_missing@scenario.accrual.duration" %in% only_median,
               old_label = "method_version_mismatch@methodVersion" %in% labelled, old_label_plain = !length(plain_old))
  list(pass = all(ok) && all(refused),
       detail = sprintf("chance of an event of one person vs simulation: worst %.2f standard errors (tol 4); selection: max people %s (events 240 over %.4f), expected = expected events / %.4f; enrichment: max people %s (240 over %.4f); the accrual without the median -> %s, the median without the accrual -> %s, the accrual under the 1.1.0 label -> %s, a job with neither at 1.1.0 stays valid%s%s",
                        max(z), vcr_measure_value(multi, "max_patients_from_events"), head_multi, head_multi, vcr_measure_value(enrich, "max_patients_from_events"), head_enrich,
                        paste(only_accrual, collapse = " "), paste(only_median, collapse = " "), paste(labelled, collapse = " "),
                        if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ",")), if (all(refused)) "" else paste0("; REFUSALS WRONG: ", paste(names(refused)[!refused], collapse = ","))))
})

vcr_case("N100d", c("AC-29", "AC-32"), function() {
  # output hashes of the release before this one (design.confirmatory 1.1.0), same seed, recorded by running its engine over these scenarios
  recorded <- c(futility_tte = "f079dc9b9383b2335d62025a8b8b8b0b19fb7cb4a75f722c5f458a786f60c749", ssr_tte = "35053b71d5a287af5a06169b2901b00d4773c994415fb814d1c17020d45ea328",
                multi_tte = "d0d2e727616ed9a5e9f94ed60ddd989faf10bada7d0f1f2209f038e92f508f89", enrich_tte = "f03ec2ed6d86551463851f2a13ccb93a0f358ed2d34e55ea6c909c0d0d4833bb")
  fut <- vcr_test_run(.n100_job(list(kind = "futility_group_sequential", informationRates = c(0.5, 1)), list(plannedEffect = 0.75, controlMedian = 12), id = "job_n100d1", version = "1.1.0"))
  ssr <- vcr_test_run(.n100_job(list(kind = "sample_size_reestimation", informationRates = c(0.5, 1), maxSampleSizeFactor = 1.5), list(plannedEffect = 0.75, effects = list(0.8), controlMedian = 12), id = "job_n100d2", version = "1.1.0"))
  multi <- vcr_test_run(.n100_job(list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 240), list(effectScenarios = list(list(0.9, 0.75, 0.6))), extra = list(), id = "job_n100d3"))
  enrich <- vcr_test_run(.n100_job(list(kind = "enrichment", informationRates = c(0.5, 1), subsetPrevalence = 0.4, plannedSize = 240), list(subsetEffects = list(list(subset = 0.6, rest = 0.9))), extra = list(), id = "job_n100d4"))
  got <- c(futility_tte = fut$manifest$outputHash, ssr_tte = ssr$manifest$outputHash, multi_tte = multi$manifest$outputHash, enrich_tte = enrich$manifest$outputHash)
  people <- function(r) r$diagnostics$confirmatory$people
  says <- c(multi = identical(people(multi)$computed, FALSE) && identical(people(multi)$reason, "accrual_not_stated") && all(c("accrual.duration", "accrual.followup", "truth.controlMedian") %in% unlist(people(multi)$needs)) && grepl("not computed", people(multi)$note),
            enrich = identical(people(enrich)$computed, FALSE),
            labelled_none = is.null(people(fut)) && is.null(people(ssr)))
  list(pass = identical(unname(got), unname(recorded)) && all(says),
       detail = sprintf("output hashes of 1.1.0's release reproduced: %s; a selection or an enrichment with no accrual says people are not computed and names %s%s",
                        paste(sprintf("%s %s", names(got), ifelse(got == recorded, "same", "DIFFERENT")), collapse = ", "), paste(unlist(people(multi)$needs), collapse = ", "),
                        if (all(says)) "" else paste0("; FAILED: ", paste(names(says)[!says], collapse = ","))))
})
