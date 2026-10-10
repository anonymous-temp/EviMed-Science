# N51 — a scenario's time unit is stated, from one table, and the engine honours it (E4, OI-1, D1).
#
# The engine read every time of a time-to-event scenario as months. The only place the unit was an arithmetic fact was the dropout:
# `dropoutAnnual` was a proportion "per 12 time units", so a scenario in years lost 0.9% of its patients a year where it said 10%,
# one in weeks 36.7%, and a run that wrote its durations in years got a trial that was not the one it described (the live defect of
# 2026-10-04 was `accrual.months`; the underlying one was that nothing said what a unit was). The scenario now states `timeUnit`
# (days, weeks, months, years; months when it says nothing), the days each stands for are the domain's one table
# (R/domain-snapshot.json `timeUnits`), the dropout is a proportion per year whatever the unit, and the measures named in months
# (`duration_months`, a cost per month) are in months whatever the unit.
#
# The model is scale-free in time, so the same trial stated in months, in years and in weeks is one trial: the same required size,
# and — with the same seed, since every uniform is drawn in the same order — the very same simulated patients, to rounding.

.n51_trial <- function(unit = NULL, scale = 1) {
  sc <- list(design = list(kind = "two_arm_fixed", nTreat = 120, nControl = 120), endpoint = list(type = "time_to_event"),
             truth = list(hazardRatio = 0.7, controlMedian = 12 * scale),
             accrual = list(kind = "uniform", duration = 24 * scale, followup = 12 * scale, dropoutAnnual = 0.15, maxFollowup = 30 * scale),
             analysis = list(method = "logrank", alpha = 0.025, sided = 1),
             costs = list(perPatient = 1000, perMonth = 5000), performance = list("power", "expected_events", "duration_months", "cost"))
  if (!is.null(unit)) sc$timeUnit <- unit
  sc
}
.n51_analytic <- function(unit = NULL, scale = 1) {
  sc <- list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12 * scale),
             accrual = list(duration = 24 * scale, followup = 12 * scale, dropoutAnnual = 0.15), analysis = list(alpha = 0.025, power = 0.9))
  if (!is.null(unit)) sc$timeUnit <- unit
  sc
}

vcr_case("N51", c("AC-04", "AC-29"), function() {
  close <- function(a, b, tol = 1e-9) is.finite(a) && is.finite(b) && abs(a - b) <= tol * max(1, abs(a), abs(b))

  # (a) the unit table: months by default, a year in each unit, and a unit outside the table refused by name
  u <- function(unit) vcr_time_unit(if (is.null(unit)) list() else list(timeUnit = unit))
  table_ok <- identical(u(NULL)$unit, "months") && u(NULL)$perYear == 12 && u(NULL)$months == 1 &&
    u("years")$perYear == 1 && close(u("years")$months, 12) && close(u("weeks")$perYear, 365.25 / 7) && close(u("weeks")$months, 7 / 30.4375) &&
    u("days")$perYear == 365.25 && identical(u("years")$zh, "年") && identical(u("weeks")$zh, "周")
  refused <- tryCatch(vcr_time_unit(list(timeUnit = "fortnights")), error = function(e) e)
  refusal_ok <- inherits(refused, "vcr_refusal") && identical(refused$issue$code, "scenario_value_invalid") && identical(refused$issue$field, "scenario.timeUnit")

  # (b) the annual dropout is a proportion per year in every unit: 10% a year is S(1 year) = 0.9
  hazard_ok <- all(vapply(c("days", "weeks", "months", "years"), function(unit) {
    h <- vcr_dropout_hazard(0.1, u(unit)$perYear)
    close(exp(-h * u(unit)$perYear), 0.9)
  }, logical(1)))

  # (c) the closed-form size is one number in whatever unit the trial is stated: months, years, weeks
  size <- function(unit, scale) {
    r <- vcr_test_run(vcr_test_job("design.analytic", .n51_analytic(unit, scale), job_id = "job_n51"))
    list(status = r$status, n = vcr_measure_value(r, "required_patients"), p = vcr_measure_value(r, "event_probability"), e = vcr_measure_value(r, "required_events_exact"))
  }
  m <- size(NULL, 1); my <- size("years", 1 / 12); mw <- size("weeks", 30.4375 / 7); md <- size("days", 30.4375)
  analytic_ok <- all(vapply(list(m, my, mw, md), function(x) identical(x$status, "succeeded") && is.finite(x$n), logical(1))) &&
    m$n == my$n && m$n == mw$n && m$n == md$n && close(m$p, my$p) && close(m$p, mw$p) && close(m$e, my$e)
  # and the unit matters: the years trial read as months (the old reading) is another trial
  misread <- size(NULL, 1 / 12)
  misread_differs <- !identical(misread$n, m$n)

  # (d) the simulation is the same trial in another unit: the same events, the same length in months, the same cost, to rounding
  sim <- function(unit, scale) {
    r <- vcr_run_simulation(.n51_trial(unit, scale), seed = 5151L, replicates = 200L, cores = 1L)
    get <- function(name) { x <- Filter(function(z) identical(z$name, name), r$measures); if (length(x)) x[[1]]$value else NA_real_ }
    list(events = get("expected_events"), months = get("duration_months"), cost = get("cost"), power = get("power"))
  }
  sm <- sim(NULL, 1); sy <- sim("years", 1 / 12); sw <- sim("weeks", 30.4375 / 7)
  sim_ok <- close(sm$events, sy$events, 1e-7) && close(sm$events, sw$events, 1e-7) && close(sm$months, sy$months, 1e-7) && close(sm$months, sw$months, 1e-7) &&
    close(sm$cost, sy$cost, 1e-7) && close(sm$power, sy$power, 1e-9) && sm$months > 24
  # the old reading of the years scenario (no unit) is a different trial: the dropout is spread over 12 years, and its length is "12 times shorter"
  sim_misread <- sim(NULL, 1 / 12)
  sim_differs <- !close(sm$events, sim_misread$events, 1e-3)

  # (e) a unit reaches the generator too, and the words a page reads
  gen <- function(unit) {
    sc <- list(design = list(nTreat = 30, nControl = 30), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12),
               accrual = list(duration = 6, followup = 12, dropoutAnnual = 0.2))
    if (!is.null(unit)) sc$timeUnit <- unit
    vcr_test_run(vcr_test_job("patients.time_to_event", sc, job_id = "job_n51_gen"))
  }
  g_months <- gen(NULL); g_years <- gen("years")
  words_ok <- identical(g_months$status, "succeeded") && identical(g_years$status, "succeeded")

  ok <- table_ok && refusal_ok && hazard_ok && analytic_ok && misread_differs && sim_ok && sim_differs && words_ok
  list(pass = ok, detail = sprintf("table %s refusal %s annual %s | analytic n months/years/weeks/days %s/%s/%s/%s, misread %s | sim events %.3f/%.3f/%.3f, months %.4f/%.4f/%.4f, cost %.1f/%.1f, misread events %.3f | generator %s/%s",
    table_ok, refusal_ok, hazard_ok, m$n, my$n, mw$n, md$n, misread$n, sm$events, sy$events, sw$events, sm$months, sy$months, sw$months, sm$cost, sy$cost, sim_misread$events,
    g_months$status, g_years$status))
})
