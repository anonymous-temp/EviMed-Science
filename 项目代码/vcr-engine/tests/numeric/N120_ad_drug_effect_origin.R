# N120 — where the drug effect of the Alzheimer family comes from (plan R29 tier A, R30 tier B; patients.progression 1.2.0, 2026-11-09)
#
# Tier A: the treated arm takes a marketed AChE inhibitor whose effect is the posterior's own. Tier B: an antibody's effect comes from the published
# exposure -> amyloid PET -> ADAS-Cog chain (Muralidharan et al. 2022; Pang et al. 2023). Each is held to something outside its own code: the posterior's
# own Emax equation read from the parameter file by hand, the calculated numbers the paper prints, `deSolve` for the ODE, a closed form of the indirect
# response at a constant concentration, and the engine's own fixed-share run for the inversion.
#
#   a  tier A: the logit Emax and ET50 of each drug at a dose are the posterior's equation (the manual's Listings 3.9 to 3.11) computed here from the file,
#      the 12-week effect on the reference dose is exactly -eStar, and the arm's curves and power equal the researcher's own statement of that Emax
#   b  tier A under `posterior_draws`: each trial reads the row it is about to draw, and rows differ
#   c  background therapy: a closed form of the shared response, and an identical pair of arms when no treatment is stated
#   d  the Cochrane consistency check (donepezil 10 mg, 26 weeks): recorded as a check of the implementation, never as validation
#   e  what is refused by name: reference with symptomatic, a washout the posterior does not carry, an unknown drug, a background with the placebo off
#   f  the two-compartment concentration against `deSolve` and the half-life the paper states
#   g  the SUVR integration against `deSolve` on the whole system, and no dose leaving the baseline untouched
#   h  the covariate equations and what the paper prints of them: the weight effect of 3 to 5% per 10%, the SUVR change by age, the high-dose week-78 change
#   i  the clinical link's draws are Pang's interval and the inversion into the model's share reproduces the stated points in an engine run
#   j  the chain's effect feeds the assurance (named, tier B, sourced); lecanemab's PK is Table 1 and its chain is refused by name

.n120_P <- function(v, basis = "assumed") list(value = v, basis = basis)
.n120_sc <- function(tr, n = 200L, visits = c(0, 13, 26, 52), uncertainty = "typical_study", dropout = NULL, placebo = NULL) {
  sc <- list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), timeUnit = "weeks", visits = visits,
             model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = uncertainty), treatment = tr)
  if (!is.null(dropout)) sc$dropoutModel <- dropout
  if (!is.null(placebo)) sc$placebo <- placebo
  sc
}
.n120_run <- function(sc, seed = 12001L, replicates = 300L, cores = 1L) vcr_test_run(vcr_test_job("patients.progression", sc, seed = seed, replicates = replicates, cores = cores))
.n120_issue <- function(r) { i <- c(r$issues %||% list(), r$diagnostics$issues %||% list()); if (length(i)) sprintf("%s@%s", i[[1]]$code, i[[1]]$field) else NA_character_ }
.n120_medians <- function() {
  doc <- jsonlite::fromJSON(file.path(vcr_engine_root(), "R", "models", "ad_adascog11_camd_adsim3.json"), simplifyVector = TRUE)
  vapply(doc$values, stats::median, numeric(1))
}
# the manual's equation, written out of the file with no engine function: effect at the dose on the logit scale (Emax) and ET50
.n120_emax <- function(med, index, dose, ref_dose) {
  e_star <- med[[sprintf("eStar[%d]", index)]]; et50 <- med[[sprintf("et50[%d]", index)]]; gam <- med[[sprintf("gamma[%d]", index)]]
  b <- 12 / et50
  c(emax = (dose / ref_dose)^gam * (-(1 + b) * e_star / b), et50 = et50, eStar = e_star)
}
.n120_curve_diff <- function(r) vapply(r$diagnostics$progression$curves, function(c) c$treated$mean$value - c$control$mean$value, numeric(1))

vcr_case("N120a", c("AC-04", "AC-28"), function() {
  med <- .n120_medians()
  drugs <- list(list("donepezil", 1L, 5, 10), list("galantamine", 2L, 24, 16), list("rivastigmine", 3L, 6, 9))
  worst <- 0; same <- TRUE; at12 <- 0
  for (d in drugs) {
    x <- .n120_emax(med, d[[2]], d[[4]], d[[3]])
    ref <- .n120_run(.n120_sc(list(reference = list(drug = d[[1]], doseMg = d[[4]]))), replicates = 200L)
    hand <- .n120_run(.n120_sc(list(symptomatic = list(logitEmax = .n120_P(unname(x[["emax"]])), et50Weeks = .n120_P(unname(x[["et50"]]))))), replicates = 200L)
    got <- ref$diagnostics$progression$treatment
    worst <- max(worst, abs(got$symptomaticLogitEmax - x[["emax"]]) / abs(x[["emax"]]), abs(got$et50Weeks - x[["et50"]]) / x[["et50"]])
    same <- same && isTRUE(all.equal(.n120_curve_diff(ref), .n120_curve_diff(hand), tolerance = 1e-12)) && identical(ref$measures[[1]]$value, hand$measures[[1]]$value)
    # the 12-week effect on the reference dose is minus eStar, by the equation
    xr <- .n120_emax(med, d[[2]], d[[3]], d[[3]])
    at12 <- max(at12, abs(xr[["emax"]] * 12 / (xr[["et50"]] + 12) + xr[["eStar"]]))
  }
  list(pass = worst < 1e-12 && same && at12 < 1e-12 && identical(ref$diagnostics$progression$treatment$reference$readFrom, "the posterior's medians"),
       detail = sprintf("donepezil 10 mg, galantamine 16 mg, rivastigmine 9 mg read from the parameter file by the manual's Listings 3.9 to 3.11: the engine's logit Emax and ET50 differ by at most %.1e (relative); the arm's curves and power equal the researcher's own statement of that Emax and ET50 (200 trials each); the 12-week effect on each reference dose is -eStar to %.1e", worst, at12))
})

vcr_case("N120b", c("AC-04", "AC-28"), function() {
  set <- vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0")
  p <- list(uncertainty = "posterior_draws", reference = list(drug = "galantamine", doseMg = 24), par = vcr_beta_logit_par(set$medians, list()), population = list(), record = NULL)
  ok <- TRUE; seen <- c()
  for (s in 1:12) {
    set.seed(s, kind = VCR_RNG_KIND)
    par <- .vcr_bl_trial_par(set, p)
    row_drawn <- sample.int(nrow(set$draws), 1L)
    want <- vcr_beta_logit_par(set$draws[row_drawn, ], list())
    ok <- ok && identical(par$drugs, want$drugs)
    seen <- c(seen, par$drugs$eStar[2])
  }
  # and the medians when the study is not drawn from the posterior
  p$uncertainty <- "new_study"
  ok <- ok && identical(.vcr_bl_trial_par(set, p)$drugs, p$par$drugs)
  # a whole run: the reference drug with posterior draws is a power of its own (it moves with the draws), at one seed
  a <- .n120_run(.n120_sc(list(reference = list(drug = "donepezil", doseMg = 10)), uncertainty = "posterior_draws"), replicates = 200L)
  b <- .n120_run(.n120_sc(list(reference = list(drug = "donepezil", doseMg = 10)), uncertainty = "typical_study"), replicates = 200L)
  list(pass = ok && length(unique(seen)) == 12L && identical(a$status, "succeeded") && !identical(a$measures[[1]]$value, b$measures[[1]]$value) && identical(a$diagnostics$progression$treatment$reference$readFrom, "each trial's own posterior draw (the medians are shown)"),
       detail = sprintf("12 trials: the row the trial reads its galantamine parameters from is the row the trial then draws (the first draw of its stream), and the 12 values of eStar differ; with new_study the medians are read; a donepezil 10 mg run under posterior_draws (power %.3f) differs from the typical study's (%.3f)", a$measures[[1]]$value, b$measures[[1]]$value))
})

vcr_case("N120c", c("AC-04", "AC-28"), function() {
  med <- .n120_medians()
  # the shared response with a background donepezil 10 mg started 26 weeks before baseline: the Bateman placebo response plus the closed form
  set <- vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0")
  bg <- list(drug = "donepezil", doseMg = 10, weeksBefore = 26)
  par0 <- vcr_beta_logit_par(set$medians, list()); par1 <- vcr_beta_logit_par(set$medians, list(background = bg))
  x <- .n120_emax(med, 1L, 10, 5); t <- c(0, 13, 26, 52); s <- 26
  want <- x[["emax"]] * ((t + s) / (x[["et50"]] + t + s) - s / (x[["et50"]] + s))
  got <- vcr_beta_logit_placebo(par1, t) - vcr_beta_logit_placebo(par0, t)
  closed <- max(abs(got - want))
  # no treatment stated: the two arms are the same calculated curve, with or without a background
  r0 <- .n120_run(.n120_sc(list(background = bg)), replicates = 200L)
  null_gap <- max(abs(.n120_curve_diff(r0)))
  # a stated symptomatic effect on top of the background keeps the background in both arms: the control arm's mean is the background run's, not the plain one
  r_plain <- .n120_run(.n120_sc(list(symptomatic = list(pointsAt = .n120_P(-2), atWeek = 26, referenceAdas = 25, et50Weeks = .n120_P(8)))), replicates = 200L)
  r_bg <- .n120_run(.n120_sc(list(symptomatic = list(pointsAt = .n120_P(-2), atWeek = 26, referenceAdas = 25, et50Weeks = .n120_P(8)), background = bg)), replicates = 200L)
  ctl <- function(r) vapply(r$diagnostics$progression$curves, function(c) c$control$mean$value, numeric(1))
  control_moved <- max(abs(ctl(r_bg) - ctl(r_plain)))
  list(pass = closed < 1e-14 && null_gap < 1e-14 && control_moved > 1e-4 && identical(r_bg$diagnostics$progression$treatment$background$weeksBefore, 26),
       detail = sprintf("the shared response with a background donepezil 10 mg started 26 weeks before baseline differs from the Bateman placebo by the closed form E(t + s) - E(s) to %.1e; with no treatment stated the arms' calculated curves differ by %.1e; the control arm's mean moves by up to %.4f points when the background is added", closed, null_gap, control_moved))
})

vcr_case("N120d", c("AC-04", "AC-28"), function() {
  med <- .n120_medians()
  x <- .n120_emax(med, 1L, 10, 5)
  e26 <- x[["emax"]] * 26 / (x[["et50"]] + 26)
  pts <- function(a) 70 * (stats::plogis(stats::qlogis(a / 70) + e26) - a / 70)
  by_baseline <- vapply(c(22, 25), pts, numeric(1))
  r <- .n120_run(.n120_sc(list(reference = list(drug = "donepezil", doseMg = 10)), visits = c(0, 13, 26)), replicates = 100L)
  curve26 <- r$diagnostics$progression$curves[[3]]$change
  engine <- curve26$treated$value - curve26$control$value
  limits <- unlist(r$diagnostics$progression$limits)
  says <- any(grepl("not an independent validation", limits, fixed = TRUE)) && any(grepl("-2.67", limits, fixed = TRUE))
  list(pass = by_baseline[2] <= -2.54 && by_baseline[2] >= -2.74 && by_baseline[1] <= -2.5 && by_baseline[1] >= -2.6 && engine > -3.31 && engine < -2.02 && says,
       detail = sprintf("donepezil 10 mg at week 26 on the logit scale of the posterior medians: %.2f points for a baseline of 22 and %.2f for 25 (the plan's -2.54 to -2.73); the engine's calculated treated-less-control change at week 26 in the whole population is %.2f; Cochrane (Birks and Harvey 2018) pools -2.67 (-3.31 to -2.02), which both fall inside; the result's limits say this is a consistency check of the implementation and not an independent validation (the review pools trials of the kind the model was fitted on)", by_baseline[1], by_baseline[2], engine))
})

vcr_case("N120e", c("AC-04", "AC-28"), function() {
  both <- .n120_run(.n120_sc(list(reference = list(drug = "donepezil", doseMg = 10), symptomatic = list(pointsAt = .n120_P(-2), atWeek = 26, referenceAdas = 25, et50Weeks = .n120_P(8)))), replicates = 100L)
  nowash <- .n120_run(.n120_sc(list(reference = list(drug = "donepezil", doseMg = 10), doseEnd = 26)), replicates = 100L)
  badname <- .n120_run(.n120_sc(list(reference = list(drug = "memantine", doseMg = 10))), replicates = 100L)
  noplacebo <- .n120_run(.n120_sc(list(background = list(drug = "donepezil", doseMg = 10, weeksBefore = 26)), placebo = FALSE), replicates = 100L)
  neg <- .n120_run(.n120_sc(list(reference = list(drug = "donepezil", doseMg = -5))), replicates = 100L)
  got <- c(both = .n120_issue(both), nowash = .n120_issue(nowash), badname = .n120_issue(badname), noplacebo = .n120_issue(noplacebo), neg = .n120_issue(neg))
  want <- c(both = "scenario_value_invalid@scenario.treatment.reference", nowash = "scenario_field_missing@scenario.treatment.reference.washoutHalfLifeWeeks",
            badname = NA, noplacebo = "scenario_value_invalid@scenario.treatment.background", neg = NA)
  refused <- function(r) !identical(r$status, "succeeded")
  list(pass = identical(got[c("both", "nowash", "noplacebo")], want[c("both", "nowash", "noplacebo")]) && refused(badname) && refused(neg) && refused(both),
       detail = sprintf("refused by name: both a reference and a symptomatic effect (%s), a dose that ends before the last visit with no washout the posterior does not carry (%s), a background with the placebo response off (%s); an unknown drug and a negative dose are refused by the schema (%s, %s)",
                        got[["both"]], got[["nowash"]], got[["noplacebo"]], badname$status, neg$status))
})

# --- tier B: the chain ---------------------------------------------------------------------------------------------------------------------------

.n120_reg <- function(...) utils::modifyList(list(maintenanceMgPerKg = 10, titrationMgPerKg = c(1, 1, 3, 3, 6, 6), intervalWeeks = 4, infusionHours = 1), list(...))

vcr_case("N120f", c("AC-04", "AC-28"), function() {
  if (!requireNamespace("deSolve", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the cross-check package deSolve is not installed (the run must not skip silently)"))
  doses <- .vcr_mech_doses(.n120_reg(), 78, 70.9)
  pk <- as.list(vcr_mechanism_pk("aducanumab"))
  tt <- c(0, 1, 2, 24, 100, 672, 700, 1344, 2688, 5000, 13104)
  ours <- as.numeric(vcr_mechanism_concentration(tt, doses$t0, doses$mg, doses$hours, pk))
  # the two-compartment model with the infusions as a rate, integrated by lsoda piece by piece between the infusion edges (the rate is discontinuous)
  edges <- sort(unique(c(0, doses$t0, doses$t0 + doses$hours, tt)))
  y <- c(0, 0); got <- numeric(0)
  for (i in seq_len(length(edges) - 1L)) {
    mid <- (edges[i] + edges[i + 1L]) / 2
    r <- sum(ifelse(mid >= doses$t0 & mid < doses$t0 + doses$hours, doses$mg / doses$hours, 0))
    f <- function(t, y, p) { k10 <- pk$CL / pk$V1; k12 <- pk$Q / pk$V1; k21 <- pk$Q / pk$V2; list(c(r - (k10 + k12) * y[1] + k21 * y[2], k12 * y[1] - k21 * y[2])) }
    y <- deSolve::ode(y, c(edges[i], edges[i + 1L]), f, NULL, method = "lsoda", rtol = 1e-12, atol = 1e-14)[2L, 2:3]
    if (edges[i + 1L] %in% tt) got[length(got) + 1L] <- y[1] / pk$V1
  }
  ref <- got
  rel <- max(abs(ours[tt > 0] - ref) / pmax(abs(ref), 1e-9))
  half <- vcr_mechanism_terminal_half_life_days(unlist(pk))
  list(pass = rel < 1e-6 && abs(half - 24.8) / 24.8 < 0.05,
       detail = sprintf("a titrated regimen (1, 1, 3, 3, 6, 6 then 10 mg/kg every 4 weeks, one-hour infusions, 70.9 kg) at eleven times from 1 hour to 78 weeks: the exact concentration of the engine against lsoda (rtol 1e-12) on the two-compartment system, largest relative difference %.1e (tolerance 1e-6); the terminal half-life %.1f days against the 24.8 days (effective) the paper states for its reference patient, within the 5%% a different definition allows", rel, half))
})

vcr_case("N120g", c("AC-04", "AC-28"), function() {
  if (!requireNamespace("deSolve", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the cross-check package deSolve is not installed (the run must not skip silently)"))
  doses <- .vcr_mech_doses(.n120_reg(), 78, 70.9)
  pk <- as.list(vcr_mechanism_pk("aducanumab")); pd <- vcr_mechanism_pd()
  tt <- c(0, 168, 672, 2688, 6720, 13104)
  ours <- as.numeric(vcr_mechanism_suvr(tt, doses$t0, doses$mg, doses$hours, pk, pd))
  # lsoda on the whole PK-PD system, piece by piece between the infusion edges (the model's own differential equations, Equation 1 and 2 of the paper)
  edges <- sort(unique(c(0, doses$t0, doses$t0 + doses$hours, tt)))
  y <- c(0, 0, pd$BL); out <- c(pd$BL)
  for (i in seq_len(length(edges) - 1L)) {
    mid <- (edges[i] + edges[i + 1L]) / 2
    r <- sum(ifelse(mid >= doses$t0 & mid < doses$t0 + doses$hours, doses$mg / doses$hours, 0))
    f <- function(t, y, p) { c1 <- y[1] / pk$V1; k10 <- pk$CL / pk$V1; k12 <- pk$Q / pk$V1; k21 <- pk$Q / pk$V2
      list(c(r - (k10 + k12) * y[1] + k21 * y[2], k12 * y[1] - k21 * y[2], pd$kout * pd$BL - pd$kout * (1 + pd$emax * c1 / (pd$ec50 + c1)) * y[3])) }
    y <- deSolve::ode(y, c(edges[i], edges[i + 1L]), f, NULL, method = "lsoda", rtol = 1e-12, atol = 1e-14)[2L, 2:4]
    if (edges[i + 1L] %in% tt[-1L]) out[length(out) + 1L] <- y[3]
  }
  rel <- max(abs(ours - out) / out)
  # with no dose the concentration is zero, the loss is Kout x SUVR and the SUVR stays at its baseline
  none <- vcr_mechanism_suvr(c(0, 1000, 5000), 0, 0, 1, pk, pd)
  held <- all(abs(none - pd$BL) < 1e-12)
  list(pass = rel < 1e-6 && held,
       detail = sprintf("the SUVR of the typical person under the same titrated regimen at 0, 1, 4, 16, 40 and 78 weeks: the engine's Runge-Kutta against lsoda on the whole system (rtol 1e-12), largest relative difference %.1e (tolerance 1e-6); with no dose the SUVR stays at its baseline to 1e-12", rel))
})

vcr_case("N120h", c("AC-04", "AC-28"), function() {
  k <- .VCR_MECH_DRUGS$aducanumab$pk
  w10 <- c(CL = 1.1^k$weightExp[["CL"]], V1 = 1.1^k$weightExp[["V1"]], V2 = 1.1^k$weightExp[["V2"]]) - 1
  weight_ok <- all(w10 > 0.029 & w10 < 0.056)
  pk_ref <- vcr_mechanism_pk("aducanumab"); pk_w <- vcr_mechanism_pk("aducanumab", list(weightKg = 70.9 * 1.1))
  ratio <- pk_w[c("CL", "V1")] / pk_ref[c("CL", "V1")]
  reg <- .n120_reg(); doses <- .vcr_mech_doses(reg, 130, 70.9)
  change <- function(who) { pk <- as.list(vcr_mechanism_pk("aducanumab", who)); pd <- vcr_mechanism_pd(who)
    y <- vcr_mechanism_suvr(c(0, 130 * 168), doses$t0, doses$mg, doses$hours, pk, pd); y[1] - y[2] }
  ref <- change(list()); young <- change(list(ageYears = 57)); old <- change(list(ageYears = 82))
  doses78 <- .vcr_mech_doses(reg, 78, 70.9)
  y78 <- vcr_mechanism_suvr(c(0, 78 * 168), doses78$t0, doses78$mg, doses78$hours, as.list(vcr_mechanism_pk("aducanumab")), vcr_mechanism_pd())
  d78 <- y78[1] - y78[2]
  list(pass = weight_ok && abs(ratio[["CL"]] - 1.1^0.561) < 1e-12 && abs(ref - 0.335) < 0.02 && abs(young - 0.23) < 0.02 && abs(old - 0.42) < 0.03 && abs(d78 - 0.278) < 0.03,
       detail = sprintf("a 10%% heavier patient has %.1f%%, %.1f%% and %.1f%% more CL, V1, V2 (the paper: 3 to 5%%); the SUVR change at 30 months of the reference patient under 10 mg/kg titrated over 24 weeks is %.3f (the paper's mean 0.335), %.3f at 57 years and %.3f at 82 (the paper's 0.23 and 0.42; the regimen the paper used for these is not stated, so this is a consistency check); at week 78 the same regimen gives %.3f against the %.3f (against placebo) Biogen reports for EMERGE's high dose, a trial whose actual dosing histories varied. The paper's own sentence that 10 mg/kg takes about 2.25 years to reach a SUVR of 1.10 (and 6 mg/kg over 4) is NOT reproduced from its published parameters: they give 1.5 and 2.7 years with no titration (the ordering and the 3 mg/kg never agree)",
                        100 * w10[["CL"]], 100 * w10[["V1"]], 100 * w10[["V2"]], ref, young, old, d78, 0.278))
})

vcr_case("N120i", c("AC-04", "AC-28"), function() {
  tr <- list(mechanism = list(drug = "aducanumab", regimen = .n120_reg(), atWeek = 78))
  sc <- .n120_sc(tr, visits = c(0, 26, 52, 78))
  r <- .n120_run(sc, replicates = 300L)
  m <- r$diagnostics$progression$mechanism
  link <- m$link
  interval_ok <- abs(link$drawsLow - 0.12) < 0.01 && abs(link$drawsHigh - 0.55) < 0.01 && link$slope == 0.33
  # the inversion: the share at the median of the link, run as a fixed disease-modifying share, gives the median points the chain stated
  share <- m$share$median
  fixed <- .n120_run(.n120_sc(list(diseaseModifying = list(fraction = .n120_P(share)), doseBegin = 0), visits = c(0, 26, 52, 78)), replicates = 100L)
  diff <- Filter(function(x) identical(x$name, "expected_difference"), fixed$measures)[[1]]$value
  want <- m$clinical$pointsAtWeek$value
  # points = -(slope / 0.1) x the SUVR change at the week, by hand from the chain's own typical course
  by_hand <- -(0.33 / 0.1) * (m$typical$baselineSuvr$value - m$typical$suvrAtWeek$value)
  list(pass = interval_ok && abs(by_hand - want) < 1e-9 && abs(diff - want) < 0.01,
       detail = sprintf("the link's draws span %.3f to %.3f (Pang 2023: 0.12 to 0.55) around 0.33 per 0.1 SUVR; the typical SUVR change at week 78 is %.3f, so the median clinical difference is %.3f points (by hand %.3f); the share of the mean slope the inversion gives (%.4f), run as a fixed disease-modifying share, gives an expected difference of %.3f points at week 78 (tolerance 0.01)",
                        link$drawsLow, link$drawsHigh, m$typical$suvrChange$value, want, by_hand, share, diff))
})

vcr_case("N120j", c("AC-04", "AC-28"), function() {
  tr <- list(mechanism = list(drug = "aducanumab", regimen = .n120_reg(), atWeek = 78))
  r <- .n120_run(.n120_sc(tr, visits = c(0, 26, 52, 78)), replicates = 300L)
  rep <- r$diagnostics$progression$effectDistributions[[1]]
  limits <- unlist(r$diagnostics$progression$limits)
  boundary <- any(grepl("what follows if the published chain", limits, fixed = TRUE)) && any(grepl("scale does not match", limits, fixed = TRUE)) &&
    any(grepl("population does not match", limits, fixed = TRUE)) && any(grepl("same trials the chain is checked against", limits, fixed = TRUE))
  both <- .n120_run(.n120_sc(list(mechanism = tr$mechanism, diseaseModifying = list(fraction = .n120_P(0.2)))), replicates = 50L)
  lec <- .n120_run(.n120_sc(list(mechanism = list(drug = "lecanemab", regimen = .n120_reg(), atWeek = 78)), visits = c(0, 26, 52, 78)), replicates = 50L)
  # lecanemab's serum model: Table 1 for the typical patient (male, 72 kg, albumin 43 g/L), with the female ratios
  pk <- vcr_mechanism_pk("lecanemab"); pkf <- vcr_mechanism_pk("lecanemab", list(male = 0))
  pk_ok <- all(abs(pk - c(CL = 0.0154, V1 = 3.24, Q = 0.00718, V2 = 2.00)) < 1e-12) && abs(pkf[["CL"]] / pk[["CL"]] - 0.791) < 1e-12 && abs(pkf[["V1"]] / pk[["V1"]] - 0.868) < 1e-12
  heavy <- vcr_mechanism_pk("lecanemab", list(weightKg = 72 * 1.2)); w_ok <- abs(heavy[["CL"]] / pk[["CL"]] - 1.2^0.353) < 1e-12
  list(pass = identical(r$measures[[1]]$name, "assurance") && identical(rep$tier, "B") && identical(rep$source$kind, "model_result") && grepl("PMC8752104", rep$source$citation, fixed = TRUE) && boundary &&
         identical(.n120_issue(both), "scenario_value_invalid@scenario.treatment.mechanism") && !identical(lec$status, "succeeded") && grepl("not executable", lec$diagnostics$issues[[1]]$detail, fixed = TRUE) && pk_ok && w_ok,
       detail = sprintf("the chain's run is named an assurance (%.3f, 300 trials) and its effect distribution carries tier B and the source (the two papers) as R25 reports it; the result's limits say 'what follows if the chain holds' and name the three mismatches; a stated share beside the chain is refused (%s); lecanemab's chain is refused as not executable (%s) while its serum model reproduces Table 1 (CL 0.0154, V1 3.24, Q 0.00718, V2 2.00, the female ratios 0.791 and 0.868, weight exponent 0.353)",
                        r$measures[[1]]$value, .n120_issue(both), lec$status))
})

# --- tier C: an effect prior from pooled studies ----------------------------------------------------------------------------------------------

vcr_case("N120k", c("AC-04", "AC-28"), function() {
  studies <- list(list(studyId = "s1", estimate = -2.9, se = 0.55), list(studyId = "s2", estimate = -2.2, se = 0.45), list(studyId = "s3", estimate = -3.4, se = 0.7),
                  list(studyId = "s4", estimate = -1.8, se = 0.5))
  pool <- vcr_test_run(vcr_test_job("evidence.pool", list(studies = studies, method = "random_effects_dl", scale = "identity")))
  dist <- pool$diagnostics$distribution
  # what the domain's `vcrEffectPriorFromPool` writes from that result: a normal with the pooling's mean and SD, tier C, the result as its source
  prior <- list(distribution = list(family = "normal", parameters = list(mean = dist$mean, sd = dist$sd),
                                    source = list(kind = "model_result", objectRef = "res_pool1", note = "pooled studies; estimand: donepezil, mild to moderate AD, ADAS-cog 11 change"), tier = "C"))
  r <- .n120_run(.n120_sc(list(symptomatic = list(pointsAt = prior, atWeek = 26, referenceAdas = 25, et50Weeks = .n120_P(8))), visits = c(0, 13, 26)), replicates = 600L, cores = 2L)
  rep <- r$diagnostics$progression$effectDistributions[[1]]
  # the pooled value by hand, DerSimonian-Laird
  yi <- vapply(studies, function(x) x$estimate, numeric(1)); vi <- vapply(studies, function(x) x$se^2, numeric(1))
  w <- 1 / vi; mu_fe <- sum(w * yi) / sum(w); q <- sum(w * (yi - mu_fe)^2); tau2 <- max(0, (q - 3) / (sum(w) - sum(w^2) / sum(w)))
  wr <- 1 / (vi + tau2); mu <- sum(wr * yi) / sum(wr); se <- sqrt(1 / sum(wr))
  list(pass = identical(r$measures[[1]]$name, "assurance") && identical(rep$tier, "C") && identical(rep$source$kind, "model_result") && identical(rep$source$objectRef, "res_pool1") &&
         abs(dist$mean - mu) < 1e-9 && dist$sd >= se && abs(rep$drawMean - dist$mean) < 4 * dist$sd / sqrt(rep$draws) && grepl("estimand", rep$source$note, fixed = TRUE),
       detail = sprintf("four studies (-2.9, -2.2, -3.4, -1.8 points) pooled by the engine: mean %.4f (DerSimonian-Laird by hand %.4f), prior SD %.3f (the confidence SD is %.3f); stated as the symptomatic effect with tier C and the pooling as its source, the run is named an assurance (%.3f, 600 trials) and its effect report carries the tier, the source and the estimand note; the draws' mean %.3f is the prior's within the Monte Carlo error",
                        dist$mean, mu, dist$sd, se, r$measures[[1]]$value, rep$drawMean))
})
