# N47 — the assurance of a group-sequential design (design.assurance, design.kind group_sequential; 2026-10-07).
#
# The power of a sequential procedure at an effect is the probability of crossing a boundary at ANY look; its
# assurance is that power averaged over the design prior. References that are not the engine's own code: rpact's
# group-sequential power (`getPowerSurvival`) per effect, integrated against the prior here; and an independent simulation
# of the sequential trial. The engine's one-pass exit probabilities are held to rpact per stage, and to the
# recursion `design.analytic` already uses.

# the boundaries as an assurance job computes them (a coarser search grid than design.analytic's: see VCR_ASSURANCE_BOUNDARY_NODES)
.n47_design <- function(rates = c(0.4, 0.7, 1), spending = "obrien_fleming", alpha = 0.025) vcr_group_sequential(rates, alpha, spending, nodes = VCR_ASSURANCE_BOUNDARY_NODES)
.n47_scenario <- function(rates = list(0.4, 0.7, 1), spending = "obrien_fleming", events = 300, mean = -0.3, sd = 0.15, alpha = 0.025, sided = 1) {
  list(design = list(kind = "group_sequential", allocation = 0.5, events = events, informationRates = rates, spending = spending),
       endpoint = list(type = "time_to_event"), designPrior = list(mean = mean, sd = sd), analysis = list(alpha = alpha, sided = sided))
}

vcr_case("N47a", c("AC-29", "AC-30"), function() {
  # The one-pass exit probabilities against rpact, stage by stage: a three-look O'Brien-Fleming design and a four-look
  # Pocock design, at four effects each (a strong, a moderate and a weak benefit, and a harm). Against the recursion
  # `design.analytic` uses (`vcr_group_sequential_power`) at the fine grid, and the grid the assurance uses against the fine one.
  suppressMessages(library(rpact))
  worst_rp <- 0; worst_fine <- 0; worst_coarse <- 0
  for (spec in list(list(rates = c(0.4, 0.7, 1), type = "asOF", sp = "obrien_fleming"), list(rates = c(0.25, 0.5, 0.75, 1), type = "asP", sp = "pocock"))) {
    des <- rpact::getDesignGroupSequential(kMax = length(spec$rates), alpha = 0.025, sided = 1, typeOfDesign = spec$type, informationRates = spec$rates)
    gs <- .n47_design(spec$rates, spec$sp)
    for (hr in c(0.55, 0.7, 0.9, 1.15)) {
      pw <- rpact::getPowerSurvival(design = des, typeOfComputation = "Schoenfeld", maxNumberOfEvents = 280, maxNumberOfSubjects = 1000, allocationRatioPlanned = 1,
                                    hazardRatio = hr, lambda2 = 0.06, directionUpper = FALSE)
      drift <- -log(hr) * sqrt(280 * 0.25)
      mine <- vcr_gs_exits(gs, drift, 801L)
      worst_rp <- max(worst_rp, abs(as.numeric(pw$rejectPerStage) - mine))
      if (hr %in% c(0.7, 1.15)) {   # the fine grid costs a second or two a call
        fine <- vcr_group_sequential_power(gs, drift, 4001L)$exitProbabilities
        worst_fine <- max(worst_fine, abs(vcr_gs_exits(gs, drift, 4001L) - fine))
        worst_coarse <- max(worst_coarse, abs(mine - fine))
      }
    }
  }
  list(pass = worst_rp < 1e-6 && worst_fine < 1e-10 && worst_coarse < 1e-6,
       detail = sprintf("3-look O'Brien-Fleming and 4-look Pocock at hazard ratios 0.55/0.7/0.9/1.15: every stage's rejection probability agrees with rpact::getPowerSurvival to %.1e, the one-pass recursion equals vcr_group_sequential_power on the 4001-node grid to %.1e, and the 801-node grid the assurance uses to %.1e", worst_rp, worst_fine, worst_coarse))
})

vcr_case("N47b", c("AC-29", "AC-30", "AC-10"), function() {
  # The assurance through the job, against rpact's power integrated over the prior with a quadrature written here (not the
  # engine's): N(-0.3, 0.15^2) on the log hazard ratio, 300 maximum events, three looks. The headline equals the integral; the share of
  # it that is an early stop at each look sums to the whole; the power at the prior mean equals rpact's; the simulated check (an effect
  # drawn from the prior, then the sequential trial) agrees within three Monte-Carlo errors and carries its error.
  suppressMessages(library(rpact))
  rates <- c(0.4, 0.7, 1)
  des <- rpact::getDesignGroupSequential(kMax = 3, alpha = 0.025, sided = 1, typeOfDesign = "asOF", informationRates = rates)
  power_rp <- function(loghr) vapply(loghr, function(l) {
    rpact::getPowerSurvival(design = des, typeOfComputation = "Schoenfeld", maxNumberOfEvents = 300, maxNumberOfSubjects = 1000, allocationRatioPlanned = 1,
                            hazardRatio = exp(l), lambda2 = 0.06, directionUpper = FALSE)$overallReject
  }, numeric(1))
  ref <- stats::integrate(function(l) power_rp(l) * stats::dnorm(l, -0.3, 0.15), -0.3 - 8 * 0.15, -0.3 + 8 * 0.15, rel.tol = 1e-9, subdivisions = 200L)$value
  ref_mean <- power_rp(-0.3)
  r <- vcr_test_run(vcr_test_job("design.assurance", .n47_scenario(), seed = 4701L, replicates = 100000L, job_id = "job_n47b"))
  a <- vcr_measure_value(r, "assurance"); s <- vcr_get_measure(r, "assurance_simulated"); looks <- r$diagnostics$groupSequential$looks
  by_look <- vapply(looks, function(l) l$assuranceAtLook, numeric(1))
  cc <- r$diagnostics$crossCheck
  gs <- .n47_design(rates)
  ok <- identical(r$status, "succeeded") && abs(a - ref) < 1e-6 && abs(vcr_measure_value(r, "power_at_prior_mean") - ref_mean) < 1e-6 &&
    abs(sum(by_look) - a) < 1e-12 && all(by_look > 0) && !is.null(s) && isTRUE(s$simulated) && is.finite(s$mcse) && s$mcse > 0 && abs(s$value - a) <= 3 * s$mcse &&
    isTRUE(cc$withinThreeMcse) && identical(r$replicates, 100000L) &&
    max(abs(unlist(r$diagnostics$groupSequential$criticalValues) - gs$criticalValues)) < 1e-12 && length(looks) == 3L && identical(looks[[1]]$informationFraction, 0.4) &&
    max(abs(vcr_group_sequential(c(0.5, 1), 0.025, "obrien_fleming", nodes = VCR_ASSURANCE_BOUNDARY_NODES)$criticalValues - vcr_group_sequential(c(0.5, 1), 0.025, "obrien_fleming")$criticalValues)) < 1e-8
  list(pass = ok,
       detail = sprintf("assurance %.6f (rpact integrated over the prior %.6f); power at the prior mean %.6f (rpact %.6f); by look %s (sum %.6f); simulated %.4f +-%.4f over 100,000 draws from the prior, %.2f errors from the quadrature; the boundaries are design.analytic's to 1e-8 (%s)",
                        a, ref, vcr_measure_value(r, "power_at_prior_mean"), ref_mean, paste(sprintf("%.4f", by_look), collapse = "/"), sum(by_look),
                        s$value, s$mcse, cc$differenceInMcse, paste(sprintf("%.3f", gs$criticalValues), collapse = "/")))
})

vcr_case("N47c", c("AC-29", "AC-31"), function() {
  # Properties the number must have. (1) A sequential design given the same maximum events has a lower assurance than the
  # fixed design (it spends alpha early and needs more events for the same power). (2) A stronger prior puts more of its assurance
  # at the first look. (3) Pocock spends more at the first look than O'Brien-Fleming does. (4) A two-sided design counts both tails: on a prior
  # that reaches harm it gains the harm tail, and stays below 1. (5) A prior with no spread is the power at its mean. (6) The job gives the same
  # bytes on every run (the simulated check is one stream), and a design that spells out its kind as two_arm_fixed is the fixed design.
  # The numbers come from the engine's own functions on a boundary set computed once per spending function (a boundary takes seconds).
  obf <- .n47_design(); poc <- .n47_design(spending = "pocock")
  at <- function(gs, mean, sd, sided = 1, events = 300) vcr_assurance_group_sequential(.n47_design(spending = gs$spending, alpha = 0.025 / sided), mean, sd, events, 0.5, sided)
  a_obf <- vcr_assurance_group_sequential(obf, -0.3, 0.15, 300); a_poc <- vcr_assurance_group_sequential(poc, -0.3, 0.15, 300)
  a_strong <- vcr_assurance_group_sequential(obf, -0.6, 0.15, 300)
  two <- at(obf, -0.1, 0.3, sided = 2); one <- vcr_assurance_group_sequential(obf, -0.1, 0.3, 300, 0.5, 1)
  point <- vcr_assurance_group_sequential(obf, -0.3, 1e-6, 300)
  fixed_sc <- list(design = list(allocation = 0.5, events = 300), endpoint = list(type = "time_to_event"), designPrior = list(mean = -0.3, sd = 0.15), analysis = list(alpha = 0.025, sided = 1))
  fixed <- vcr_test_run(vcr_test_job("design.assurance", fixed_sc, seed = 4702L, job_id = "job_n47c0"))
  spelt_sc <- fixed_sc; spelt_sc$design$kind <- "two_arm_fixed"
  spelt <- vcr_test_run(vcr_test_job("design.assurance", spelt_sc, seed = 4702L, job_id = "job_n47c0"))
  run1 <- vcr_test_run(vcr_test_job("design.assurance", .n47_scenario(), seed = 4702L, job_id = "job_n47c1"))
  run2 <- vcr_test_run(vcr_test_job("design.assurance", .n47_scenario(), seed = 4702L, job_id = "job_n47c1"))
  a <- function(r) vcr_measure_value(r, "assurance")
  ok <- a(fixed) > a_obf$assurance && a_strong$assurance > a_obf$assurance && a_strong$byLook[1] / a_strong$assurance > a_obf$byLook[1] / a_obf$assurance &&
    a_poc$byLook[1] > a_obf$byLook[1] && two$assurance < 1 && two$assurance > one$assurance && abs(point$assurance - point$power) < 1e-6 &&
    identical(vcr_result_json(run1$measures), vcr_result_json(run2$measures)) && identical(vcr_result_json(run1$diagnostics), vcr_result_json(run2$diagnostics)) &&
    identical(a(spelt), a(fixed)) && abs(a(run1) - a_obf$assurance) < 1e-12
  list(pass = ok,
       detail = sprintf("fixed %.4f > group-sequential %.4f at the same 300 events; a stronger prior (-0.6) %.4f with %.3f of it at the first look against %.3f; Pocock puts %.3f of the assurance at look 1 against O'Brien-Fleming's %.3f; two-sided alpha 0.05 on a prior reaching harm %.4f against one-sided 0.025 %.4f; a point prior gives the power at its mean (%.6f vs %.6f); two runs are the same bytes; kind spelt two_arm_fixed = the fixed design (%s); the job equals the function (%s)",
                        a(fixed), a_obf$assurance, a_strong$assurance, a_strong$byLook[1], a_obf$byLook[1], a_poc$byLook[1], a_obf$byLook[1], two$assurance, one$assurance, point$assurance, point$power, identical(a(spelt), a(fixed)), abs(a(run1) - a_obf$assurance) < 1e-12))
})

vcr_case("N47d", c("AC-04", "AC-30"), function() {
  # Refused for what it is, and versioned. A group-sequential assurance for a non-survival endpoint is not supported and is not run as a
  # fixed design; the looks are required; a job labelled with the version before this design existed is refused by the protocol while a
  # fixed-design job at that version stays valid (replays of earlier results). The method's version moved to 1.1.0.
  d <- vcr_domain()
  bad_endpoint <- vcr_test_run(vcr_test_job("design.assurance", list(design = list(kind = "group_sequential", nTreat = 100, nControl = 100, informationRates = list(0.5, 1)),
    endpoint = list(type = "continuous"), truth = list(sd = 1), designPrior = list(mean = 0.3, sd = 0.1), analysis = list(alpha = 0.025)), job_id = "job_n47d1"))
  no_rates <- .n47_scenario(); no_rates$design$informationRates <- NULL
  r_rates <- vcr_test_run(vcr_test_job("design.assurance", no_rates, job_id = "job_n47d2"))
  bad_rates <- .n47_scenario(rates = list(0.5, 0.4, 1))
  r_bad <- vcr_test_run(vcr_test_job("design.assurance", bad_rates, job_id = "job_n47d3"))
  old_gs <- vcr_test_job("design.assurance", .n47_scenario(), job_id = "job_n47d4"); old_gs$methodVersion <- "1.0.0"
  old_fixed <- vcr_test_job("design.assurance", list(design = list(allocation = 0.5, events = 300), endpoint = list(type = "time_to_event"), designPrior = list(mean = -0.3, sd = 0.15), analysis = list(alpha = 0.025)),
                            job_id = "job_n47d5"); old_fixed$methodVersion <- "1.0.0"
  codes <- function(j) as.character(.n00_issue_keys(vcr_validate_job(vcr_test_json(j))))
  list(pass = identical(d$methods[["design.assurance"]]$version, "1.1.0") && identical(bad_endpoint$status, "failed") && "design_not_supported" %in% vcr_test_issue_codes(bad_endpoint) &&
         identical(r_rates$status, "failed") && "scenario_field_missing" %in% vcr_test_issue_codes(r_rates) && identical(r_bad$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(r_bad) &&
         "method_version_mismatch@methodVersion" %in% codes(old_gs) && !length(codes(old_fixed)),
       detail = sprintf("version %s; a group-sequential assurance for a continuous endpoint -> %s; no looks -> %s; looks out of order -> %s; a group-sequential job labelled 1.0.0 -> %s; a fixed-design job labelled 1.0.0 -> %s",
                        d$methods[["design.assurance"]]$version, paste(vcr_test_issue_codes(bad_endpoint), collapse = ","), paste(vcr_test_issue_codes(r_rates), collapse = ","), paste(vcr_test_issue_codes(r_bad), collapse = ","),
                        paste(codes(old_gs), collapse = " "), if (length(codes(old_fixed))) paste(codes(old_fixed), collapse = " ") else "valid"))
})
