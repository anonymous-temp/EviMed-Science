# N55 — what a design's sample size rests on (design.analytic 1.3.0; remediation plan C5, C6).
#
# C5: a group-sequential or Simon design also carries the fixed-sample design at the same assumptions, as a marked baseline,
#     computed in the analytic stage (no simulation).
# C6: the required size at one input changed at a time, sorted by how far it moves, and the power the design keeps when its
#     effect is reduced by the published gap between a planned and a measured effect (HR 0.66 planned, 0.72 measured; an
#     event-time endpoint only) — held against rpact and gsDesign.

.n55_tte <- function(design = list(kind = "two_arm_fixed"), truth = list(hazardRatio = 0.66, controlMedian = 12), alpha = 0.025, power = 0.9,
                     accrual = list(duration = 18, followup = 12, dropoutAnnual = 0.1), sided = 1) {
  sc <- list(design = design, endpoint = list(type = "time_to_event"), truth = truth,
             analysis = list(alpha = alpha, power = power, sided = sided))
  if (!is.null(accrual)) sc$accrual <- accrual
  sc
}
.n55_run <- function(sc, version = NULL) {
  job <- vcr_test_job("design.analytic", sc, job_id = "job_n55")
  if (!is.null(version)) job$methodVersion <- version
  vcr_test_run(job)
}
.n55_row <- function(result, parameter) {
  rows <- result$diagnostics$sensitivity$rows
  hit <- Filter(function(row) identical(row$parameter, parameter), rows)
  if (length(hit)) hit[[1]] else NULL
}

vcr_case("N55a", c("AC-29", "AC-30"), function() {
  suppressMessages(library(gsDesign))
  gs <- .n55_run(.n55_tte(design = list(kind = "group_sequential", informationRates = list(0.5, 1), spending = "obrien_fleming")))
  fixed <- .n55_run(.n55_tte())
  base <- gs$diagnostics$baselineDesign
  # Schoenfeld's events from an independent implementation (gsDesign::nEvents), and the fixed design's own numbers unchanged.
  independent <- gsDesign::nEvents(hr = 0.66, alpha = 0.025, beta = 0.1, ratio = 1, sided = 1)
  ok <- identical(gs$status, "succeeded") && identical(base$kind, "fixed_sample") && identical(base$of, "group_sequential") &&
    abs(vcr_measure_value(gs, "required_events_exact") - independent) < 1e-6 &&
    base$fixed$events == vcr_measure_value(fixed, "required_events") && base$fixed$patients == vcr_measure_value(fixed, "required_patients") &&
    base$design$maxEvents == vcr_measure_value(gs, "max_events") && base$design$maxPatients == vcr_measure_value(gs, "max_patients") &&
    base$design$maxEvents >= base$fixed$events && base$design$expectedEventsH1 < base$fixed$events &&
    is.null(fixed$diagnostics$baselineDesign)
  list(pass = ok, detail = sprintf("fixed %g events / %g patients (gsDesign::nEvents %.4f, ours %.4f); sequential max %g / %g, expected under H1 %.1f",
    base$fixed$events, base$fixed$patients, independent, vcr_measure_value(gs, "required_events_exact"), base$design$maxEvents, base$design$maxPatients, base$design$expectedEventsH1))
})

vcr_case("N55b", c("AC-29", "AC-30"), function() {
  # Simon's two-stage design held against the smallest single-stage exact design, found here by brute force.
  sc <- list(design = list(kind = "simon_two_stage", maxN = 60), endpoint = list(type = "binary"), truth = list(nullRate = 0.1, alternativeRate = 0.3),
             analysis = list(alpha = 0.05, power = 0.8, sided = 1))
  r <- .n55_run(sc)
  want <- NULL
  for (n in 1:200) {
    for (cut in 0:n) {
      if (stats::pbinom(cut, n, 0.1, lower.tail = FALSE) <= 0.05 + 1e-12 && stats::pbinom(cut, n, 0.3, lower.tail = FALSE) >= 0.8 - 1e-12) { want <- c(n, cut); break }
    }
    if (!is.null(want)) break
  }
  got <- r$diagnostics$baselineDesign$fixed
  simon <- r$diagnostics$baselineDesign$design
  ok <- identical(r$status, "succeeded") && !is.null(got) && got$n == want[1] && got$r == want[2] && got$typeOneError <= 0.05 && got$power >= 0.8 &&
    identical(r$diagnostics$baselineDesign$of, "simon_two_stage") && simon$optimal$n >= got$n && simon$optimal$EN0 < got$n
  list(pass = ok, detail = sprintf("single-stage n %g, reject above %g (brute force %g/%g), type I %.4f, power %.4f; Simon optimal n %g, expected under the null %.1f",
    got$n, got$r, want[1], want[2], got$typeOneError, got$power, simon$optimal$n, simon$optimal$EN0))
})

vcr_case("N55c", c("AC-29", "AC-30"), function() {
  # Every row is the engine's own sizing at the changed input and nothing else: re-run the job with that input changed and read
  # required_patients. The rows are sorted by how far they move the size.
  base_sc <- .n55_tte()
  r <- .n55_run(base_sc)
  size <- function(sc) vcr_measure_value(.n55_run(sc), "required_patients")
  hr_low <- exp(0.8 * log(0.66)); hr_high <- exp(1.2 * log(0.66))
  changed <- list(
    effect = c(size(.n55_tte(truth = list(hazardRatio = hr_low, controlMedian = 12))), size(.n55_tte(truth = list(hazardRatio = hr_high, controlMedian = 12)))),
    control = c(size(.n55_tte(truth = list(hazardRatio = 0.66, controlMedian = 9.6))), size(.n55_tte(truth = list(hazardRatio = 0.66, controlMedian = 14.4)))),
    dropout = c(size(.n55_tte(accrual = list(duration = 18, followup = 12, dropoutAnnual = 0.05))), size(.n55_tte(accrual = list(duration = 18, followup = 12, dropoutAnnual = 0.15)))),
    accrual = c(size(.n55_tte(accrual = list(duration = 14.4, followup = 12, dropoutAnnual = 0.1))), size(.n55_tte(accrual = list(duration = 21.6, followup = 12, dropoutAnnual = 0.1)))))
  s <- r$diagnostics$sensitivity
  same <- vapply(names(changed), function(parameter) {
    row <- .n55_row(r, parameter)
    !is.null(row) && row$low == min(changed[[parameter]]) && row$high == max(changed[[parameter]])
  }, logical(1))
  moved <- vapply(s$rows, function(row) row$high - row$low, numeric(1))
  ok <- all(same) && !is.unsorted(rev(moved)) && s$base$value == vcr_measure_value(r, "required_patients") && length(s$rows) == 4L &&
    identical(s$rows[[1]]$parameter, "effect")
  list(pass = ok, detail = sprintf("base %g; rows %s; each row equals a full re-run at the changed input: %s",
    s$base$value, paste(vapply(s$rows, function(row) sprintf("%s %g-%g", row$parameter, row$low, row$high), character(1)), collapse = ", "), paste(same, collapse = "/")))
})

vcr_case("N55d", c("AC-29", "AC-30"), function() {
  # Binary and continuous: the control level (or the spread) and the effect, sorted; no discount and no row for it.
  bin_sc <- function(control, treatment) list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "binary"),
    truth = list(controlRate = control, treatmentRate = treatment), analysis = list(alpha = 0.025, power = 0.9, sided = 1))
  con_sc <- function(effect, sd) list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "continuous"),
    truth = list(effect = effect, sd = sd), analysis = list(alpha = 0.05, power = 0.8, sided = 2))
  n_of <- function(sc) vcr_measure_value(.n55_run(sc), "required_total")
  bin <- .n55_run(bin_sc(0.3, 0.45)); con <- .n55_run(con_sc(5, 12))
  # the control level moves and the difference the treatment makes keeps the size it was stated at
  control <- c(n_of(bin_sc(0.24, 0.39)), n_of(bin_sc(0.36, 0.51)))
  spread <- c(n_of(con_sc(5, 9.6)), n_of(con_sc(5, 14.4)))
  b <- bin$diagnostics$sensitivity; k <- con$diagnostics$sensitivity
  ok <- is.null(b$discount) && is.null(k$discount) &&
    setequal(vapply(b$rows, function(row) row$parameter, character(1)), c("effect", "control")) &&
    setequal(vapply(k$rows, function(row) row$parameter, character(1)), c("effect", "sd")) &&
    b$base$value == n_of(bin_sc(0.3, 0.45)) && k$base$value == n_of(con_sc(5, 12)) &&
    .n55_row(bin, "control")$low == min(control) && .n55_row(bin, "control")$high == max(control) &&
    .n55_row(con, "sd")$low == min(spread) && .n55_row(con, "sd")$high == max(spread) &&
    !is.unsorted(rev(vapply(b$rows, function(row) row$high - row$low, numeric(1)))) && !is.unsorted(rev(vapply(k$rows, function(row) row$high - row$low, numeric(1))))
  list(pass = ok, detail = sprintf("binary base %g, control row %g-%g (full re-runs %g/%g); continuous base %g, sd row %g-%g (re-runs %g/%g); neither has a discount row",
    b$base$value, .n55_row(bin, "control")$low, .n55_row(bin, "control")$high, control[1], control[2], k$base$value, .n55_row(con, "sd")$low, .n55_row(con, "sd")$high, spread[1], spread[2]))
})

vcr_case("N55e", c("AC-29", "AC-30"), function() {
  # The effect reduced by the published gap, and the power the design keeps at it: HR 0.66 planned -> 0.72 measured, so a design sized
  # for HR 0.66 at 90% is held at HR 0.72 with the events it was sized to. rpact computes the same Schoenfeld power.
  suppressMessages(library(rpact))
  r <- .n55_run(.n55_tte())
  d <- r$diagnostics$sensitivity$discount
  events <- vcr_measure_value(r, "required_events")
  des <- rpact::getDesignGroupSequential(kMax = 1, alpha = 0.025, sided = 1)
  rp <- rpact::getPowerSurvival(design = des, hazardRatio = 0.72, maxNumberOfEvents = events, maxNumberOfSubjects = 2000, directionUpper = FALSE,
                                allocationRatioPlanned = 1, typeOfComputation = "Schoenfeld", lambda2 = log(2) / 12)$overallReject
  # a design sized for another HR keeps the same share of its log hazard ratio
  other <- .n55_run(.n55_tte(truth = list(hazardRatio = 0.5, controlMedian = 12)))$diagnostics$sensitivity$discount
  ok <- !is.null(d) && abs(d$hazardRatio - 0.72) < 1e-12 && abs(d$power - rp) < 1e-9 && d$events == events && d$targetPower == 0.9 && d$power < 0.9 &&
    abs(other$retained - log(0.72) / log(0.66)) < 1e-12 && abs(other$hazardRatio - exp(other$retained * log(0.5))) < 1e-12
  list(pass = ok, detail = sprintf("HR 0.66 -> %.4f at %g events: power %.9f (rpact %.9f, |d| %.1e); HR 0.5 -> %.4f", d$hazardRatio, events, d$power, rp, abs(d$power - rp), other$hazardRatio))
})

vcr_case("N55f", c("AC-29", "AC-30"), function() {
  # A group-sequential design takes the reduced effect through its own boundaries: held against rpact and gsDesign.
  suppressMessages(library(rpact)); suppressMessages(library(gsDesign))
  r <- .n55_run(.n55_tte(design = list(kind = "group_sequential", informationRates = list(0.5, 1), spending = "obrien_fleming")))
  d <- r$diagnostics$sensitivity$discount
  events <- vcr_measure_value(r, "max_events")
  des <- rpact::getDesignGroupSequential(kMax = 2, alpha = 0.025, sided = 1, typeOfDesign = "asOF", informationRates = c(0.5, 1))
  rp <- rpact::getPowerSurvival(design = des, hazardRatio = d$hazardRatio, maxNumberOfEvents = events, maxNumberOfSubjects = 2000, directionUpper = FALSE,
                                allocationRatioPlanned = 1, typeOfComputation = "Schoenfeld", lambda2 = log(2) / 12)$overallReject
  gsd <- gsDesign::gsDesign(k = 2, test.type = 1, alpha = 0.025, sfu = gsDesign::sfLDOF, timing = c(0.5, 1))
  # Z at the final look has mean drift * sqrt(information): with the information scaled to 1 the drift is theta itself.
  drift <- sqrt(events * 0.25) * abs(log(d$hazardRatio))
  gp <- sum(gsDesign::gsProbability(k = 2, theta = drift, n.I = c(0.5, 1), a = rep(-20, 2), b = gsd$upper$bound)$upper$prob)
  ok <- !is.null(d) && abs(d$power - rp) < 1e-5 && abs(d$power - gp) < 1e-5 && d$events == events && d$power < 0.9
  list(pass = ok, detail = sprintf("group-sequential, %g maximum events, HR %.4f: power %.7f (rpact %.7f, gsDesign %.7f)", events, d$hazardRatio, d$power, rp, gp))
})

vcr_case("N55g", c("AC-29", "AC-30"), function() {
  # No row where there is no figure: a design that is not for benefit (HR 1 or more) and a job labelled 1.2.0 (which replays as it ran).
  harm <- .n55_run(.n55_tte(truth = list(hazardRatio = 1.4, controlMedian = 12)))
  old <- .n55_run(.n55_tte(design = list(kind = "group_sequential", informationRates = list(0.5, 1), spending = "obrien_fleming")), version = "1.2.0")
  plain <- .n55_run(.n55_tte(), version = "1.2.0")
  ok <- is.null(harm$diagnostics$sensitivity$discount) && is.null(old$diagnostics$baselineDesign) && is.null(old$diagnostics$sensitivity) &&
    identical(plain$status, "succeeded") && is.null(plain$diagnostics$sensitivity$discount) && is.null(.n55_row(plain, "effect")) &&
    vcr_measure_value(plain, "required_patients") == vcr_measure_value(.n55_run(.n55_tte()), "required_patients")
  list(pass = ok, detail = "HR 1.4: no discount; a 1.2.0 job has no baseline, no sweep and the same sizes")
})
