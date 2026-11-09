# ---------------------------------------------------------------------------
# patients_progression_mechanism.R — the tier-B mechanism chain of `patients.progression` 1.2.0 (plan R30, 2026-11-09): an anti-amyloid antibody's dose
# -> serum exposure -> amyloid PET SUVR -> ADAS-cog, each link a published model, ending in a distribution of the disease-modifying share that the
# assurance of R25 averages over.
#
# Hidden knowledge:
#
# - **Every number is Muralidharan et al., CPT Pharmacometrics Syst Pharmacol 2022;11:7-19 (PMC8752104), nothing is ours.** The PK (Table 1) and the
#   PK-SUVR model (Table 2) are in the paper; the covariate equations (power laws about 70.9 kg, age 71, MMSE 26, a ratio for sex and for Asian race,
#   ApoE e4 heterozygous as the reference genotype, an age effect on Emax of 1.94 that Table 2 leaves out and the control stream S2 carries) and the
#   inter-individual covariance matrices are in the two NONMEM control streams of its supplement (Model S1, Model S2, `PSP4-11-7-s001.docx`), which are
#   read here as the source of the forms. Where the supplement's initial estimates differ in the third digit from the tables (V2 6.03 against 6.04, a sex
#   effect on CL 0.133 against 0.134), the tables, the published final estimates, are used.
# - **The PD is an indirect response with a stimulated loss**: dSUVR/dt = Kin - Kout (1 + Emax C / (EC50 + C)) SUVR, Kin = Kout x baseline, C the
#   central concentration; the PK is linear and two-compartment, so the concentration is exact (a sum of the exponentials of each dose's infusion) and only the
#   SUVR is integrated, by fourth-order Runge-Kutta on a grid that has a point at every infusion start and end (the concentration is smooth between
#   them) and a step of at most six hours; base R, no package. The result is held to `deSolve` in the cross-check lock (N121).
# - **The clinical link is Pang et al., Alzheimers Dement 2023;19:1292-1299 (PMID 36043526)**: per 0.1 decrease in SUVR the ADAS-Cog change is reduced by
#   0.33 points (95% CI 0.12 to 0.55), an association across 16 trials and not a causal effect in a person. It is drawn per simulated trial from a normal with that
#   mean and the SD that gives the stated interval (0.55 - 0.12) / (2 x 1.96); the draws are a deterministic grid of the normal's quantiles, so the same
#   scenario gives the same effect distribution on any machine. Ren et al. 2025 (CDR-SB, 1.41 per 1.0 SUVR) is on another scale and no published conversion
#   to ADAS-cog 11 is carried: it is not offered. The ADAS-Cog of that link is a mixture of versions, not the 11-item scale of the model.
# - **From points to the model's terms by inversion at the typical study.** The link gives a difference in points at a week; the model has a share of the mean
#   slope that is taken away. The share that produces that difference among the people still observed, in the typical study at the posterior medians
#   (calculated, not simulated), is found by interpolating that calculated difference over a grid of shares; a draw that needs a share of 1 or more is not
#   representable and is redrawn by the same rule R25 applies to every distribution.
# - **What it says and does not.** "If this chain holds": a result of this method is a statement about what follows from a published exposure-biomarker model
#   and a trial-level link, never that the drug works. The three mismatches are named on the result: the scale (mixed ADAS-Cog versions and CDR-SB in the
#   link, ADAS-cog 11 in the model), the population (early Alzheimer disease, MMSE 20 to 30, against the model's mild-to-moderate 14 to 26) and the link, fitted on
#   trials the chain is also checked against.
# - **Lecanemab has a published PK and no published PD**: its serum model is here (Table 1 of CPT Pharmacometrics Syst Pharmacol 2024;13:2111,
#   PMC11646937) and the chain for it is refused by name, never completed with a guessed parameter.
# - **Build to delete**: a published model of another antibody replaces the aducanumab rows with its own `pd` list; the code reads no drug by name outside
#   `.VCR_MECH_DRUGS`.
# ---------------------------------------------------------------------------

.VCR_MECH_DRUGS <- list(
  aducanumab = list(
    source = "Muralidharan et al., CPT Pharmacometrics Syst Pharmacol 2022;11:7-19 (PMC8752104), Tables 1 and 2 and the control streams of the supplement",
    pk = list(CL = 0.0159, V1 = 3.59, Q = 0.0194, V2 = 6.04, weightRef = 70.9, weightExp = c(CL = 0.561, V1 = 0.506, V2 = 0.320), ageV2 = 0.207, ageRef = 71,
              mmseV2 = 0.182, mmseRef = 26, asian = c(CL = 0.125, V1 = -0.044, V2 = -0.148), male = c(CL = 0.134, V1 = 0.146, V2 = 0.129),
              # variances and covariances of the three log-normal effects on CL, V1, V2 (Model S1, $OMEGA BLOCK(3))
              omega = matrix(c(0.0457, 0.0120, -0.0147, 0.0120, 0.0217, 9.73e-3, -0.0147, 9.73e-3, 0.0285), 3L, 3L, dimnames = list(c("CL", "V1", "V2"), c("CL", "V1", "V2")))),
    pd = list(BL = 1.40, kout = 8.51e-5, emax = 0.702, ec50 = 46.4, ageBL = 0.101, ageRef = 71, apoe = c(none = -0.0404, one = 0, two = 0.00896), mmseBL = -0.186, mmseRef = 26,
              ageEmax = 1.94, weightKout = 0.414, weightRefKout = 72,
              # the effects on Kout, Emax, baseline and EC50 (Model S2, $OMEGA BLOCK(4); fixed zeros kept)
              omega = matrix(c(0.195612, -0.0976648, 0, 0, -0.0976648, 0.0641612, 0.0141831, 0, 0, 0.0141831, 0.0163087, -0.04365, 0, 0, -0.04365, 0.707621), 4L, 4L,
                             dimnames = list(c("kout", "emax", "BL", "ec50"), c("kout", "emax", "BL", "ec50"))))),
  lecanemab = list(
    source = "lecanemab population PK, CPT Pharmacometrics Syst Pharmacol 2024;13:2111 (PMC11646937), Table 1",
    # CL = 0.0154 (BW/72)^0.353 (ALB/43)^-0.374 0.791^female 1.13^ADA, V1 = 3.24 (BW/72)^0.513 0.868^female 0.920^Japanese, V2 = 2.00 0.671^Japanese; the typical
    # patient is male, 72 kg, albumin 43 g/L, ADA negative, not Japanese
    pk = list(CL = 0.0154, V1 = 3.24, Q = 0.00718, V2 = 2.00, weightRef = 72, weightExp = c(CL = 0.353, V1 = 0.513, V2 = 0), albuminRef = 43, albuminExp = -0.374,
              female = c(CL = 0.791, V1 = 0.868, V2 = 1), japanese = c(CL = 1, V1 = 0.920, V2 = 0.671), ada = 1.13),
    pd = NULL))

#' Pang et al. 2023: ADAS-Cog points per 0.1 decrease in SUVR, the estimate and the 95% interval.
.VCR_MECH_LINK_PANG <- list(id = "pang_2023", slope = 0.33, lower = 0.12, upper = 0.55, perSuvr = 0.1, citation = "Pang M et al., Alzheimers Dement 2023;19:1292-1299 (PMID 36043526)")
#' The number of deterministic quantile draws that stand for the link's distribution (the most `empirical_draws` takes).
.VCR_MECH_DRAWS <- 10000L
#' The longest step of the SUVR integration, in hours.
.VCR_MECH_STEP_HOURS <- 6

# --- the PK ---------------------------------------------------------------------------------------------------------------------------------

#' The typical (or one individual's, with log-normal effects `eta` on CL, V1 and V2) PK parameters of `drug` for a person `who`: `weightKg`, `ageYears`, `mmse`,
#' `male`, `asian` (aducanumab); `weightKg`, `albumin`, `male`, `ada`, `japanese` (lecanemab). Anything not stated is the reference patient.
vcr_mechanism_pk <- function(drug, who = list(), eta = c(0, 0, 0)) {
  spec <- .VCR_MECH_DRUGS[[drug]]
  if (is.null(spec)) vcr_abort("scenario_value_invalid", "scenario.treatment.mechanism.drug", "The mechanism chain carries aducanumab and lecanemab.")
  k <- spec$pk; w <- who
  wt <- (w[["weightKg"]] %||% k$weightRef) / k$weightRef
  if (identical(drug, "aducanumab")) {
    male <- w[["male"]] %||% 0; asian <- w[["asian"]] %||% 0
    cl <- k$CL * (1 + k$asian[["CL"]] * asian) * (1 + k$male[["CL"]] * male) * wt^k$weightExp[["CL"]]
    v1 <- k$V1 * (1 + k$asian[["V1"]] * asian) * (1 + k$male[["V1"]] * male) * wt^k$weightExp[["V1"]]
    v2 <- k$V2 * ((w[["ageYears"]] %||% k$ageRef) / k$ageRef)^k$ageV2 * ((w[["mmse"]] %||% k$mmseRef) / k$mmseRef)^k$mmseV2 * (1 + k$asian[["V2"]] * asian) *
      (1 + k$male[["V2"]] * male) * wt^k$weightExp[["V2"]]
  } else {
    female <- 1 - (w[["male"]] %||% 1); japanese <- w[["japanese"]] %||% 0
    cl <- k$CL * wt^k$weightExp[["CL"]] * ((w[["albumin"]] %||% k$albuminRef) / k$albuminRef)^k$albuminExp * k$female[["CL"]]^female * k$ada^(w[["ada"]] %||% 0)
    v1 <- k$V1 * wt^k$weightExp[["V1"]] * k$female[["V1"]]^female * k$japanese[["V1"]]^japanese
    v2 <- k$V2 * k$japanese[["V2"]]^japanese
  }
  c(CL = cl * exp(eta[1]), V1 = v1 * exp(eta[2]), Q = k$Q, V2 = v2 * exp(eta[3]))
}

#' The two-compartment macro-constants of clearances and volumes (vectors allowed): the fast and slow rates and the coefficients of the central
#' concentration after a unit bolus, C(t) = A exp(-alpha t) + B exp(-beta t).
.vcr_mech_disposition <- function(pk) {
  k10 <- pk[["CL"]] / pk[["V1"]]; k12 <- pk[["Q"]] / pk[["V1"]]; k21 <- pk[["Q"]] / pk[["V2"]]
  s <- k10 + k12 + k21; d <- sqrt(s^2 - 4 * k10 * k21)
  al <- (s + d) / 2; be <- (s - d) / 2
  list(alpha = al, beta = be, A = (al - k21) / (pk[["V1"]] * (al - be)), B = (k21 - be) / (pk[["V1"]] * (al - be)), k10 = k10, k12 = k12, k21 = k21)
}

#' The terminal half-life in days of a two-compartment disposition.
vcr_mechanism_terminal_half_life_days <- function(pk) log(2) / .vcr_mech_disposition(pk)$beta / 24

#' The central concentration (mg/L) at hours `t` (a vector) after the infusions that start at `t0` (hours) with `mg` milligrams, each over `hours` hours, for one
#' PK parameter set or, with `pk` a list of vectors (one entry per person), a matrix with a row per person and a column per time: the sum over the doses of
#' the exact response of the linear model to a constant-rate infusion.
vcr_mechanism_concentration <- function(t, t0, mg, hours, pk) {
  d <- .vcr_mech_disposition(pk)
  n <- length(d$alpha)
  out <- matrix(0, n, length(t))
  # the response to a rate R over the time since the start: R (A/alpha (1 - e^-alpha x) + B/beta (1 - e^-beta x)) for x > 0
  step <- function(x) {
    xm <- matrix(pmax(x, 0), n, length(x), byrow = TRUE)
    (d$A / d$alpha) * (1 - exp(-d$alpha * xm)) + (d$B / d$beta) * (1 - exp(-d$beta * xm))
  }
  for (i in seq_along(t0)) out <- out + (mg[i] / hours) * (step(t - t0[i]) - step(t - t0[i] - hours))
  out
}

# --- the PD -----------------------------------------------------------------------------------------------------------------------------------

#' The PD parameters of an individual of aducanumab (vectors over people allowed through `eta`, a matrix with columns Kout, Emax, baseline, EC50).
vcr_mechanism_pd <- function(who = list(), eta = matrix(0, 1L, 4L)) {
  k <- .VCR_MECH_DRUGS$aducanumab$pd
  age <- (who[["ageYears"]] %||% k$ageRef) / k$ageRef
  apoe <- k$apoe[[who[["apoe"]] %||% "one"]]
  list(BL = k$BL * age^k$ageBL * (1 + apoe) * ((who[["mmse"]] %||% k$mmseRef) / k$mmseRef)^k$mmseBL * exp(eta[, 3]),
       kout = k$kout * ((who[["weightKg"]] %||% k$weightRefKout) / k$weightRefKout)^k$weightKout * exp(eta[, 1]),
       emax = k$emax * age^k$ageEmax * exp(eta[, 2]), ec50 = k$ec50 * exp(eta[, 4]))
}

#' The SUVR of each person (rows of the PK and PD parameters) at hours `times`, after the infusions `t0`/`mg`/`hours`: fourth-order Runge-Kutta over the
#' grid of the infusion starts and ends (eight steps inside each infusion), the requested times and steps of at most `hmax` hours, the concentration exact at every node and midpoint.
vcr_mechanism_suvr <- function(times, t0, mg, hours, pk, pd, hmax = .VCR_MECH_STEP_HOURS) {
  tmax <- max(times)
  # the concentration rises fast inside an infusion: eight steps each (a single step across it was off by 4e-6 of the SUVR against lsoda)
  inside <- as.vector(outer(t0, hours * seq_len(8L) / 8, "+"))
  bp <- sort(unique(c(0, times, t0[t0 < tmax], inside[inside < tmax], tmax)))
  grid <- unlist(lapply(seq_len(length(bp) - 1L), function(i) { n <- ceiling((bp[i + 1L] - bp[i]) / hmax); seq(bp[i], bp[i + 1L], length.out = n + 1L)[-(n + 1L)] }))
  grid <- c(grid, tmax); h <- diff(grid)
  cg <- vcr_mechanism_concentration(grid, t0, mg, hours, pk); cm <- vcr_mechanism_concentration(grid[-length(grid)] + h / 2, t0, mg, hours, pk)
  f <- function(y, c) pd$kout * pd$BL - pd$kout * (1 + pd$emax * c / (pd$ec50 + c)) * y
  y <- matrix(0, length(pd$BL), length(grid)); y[, 1L] <- pd$BL
  for (i in seq_along(h)) {
    yi <- y[, i]
    k1 <- f(yi, cg[, i]); k2 <- f(yi + h[i] / 2 * k1, cm[, i]); k3 <- f(yi + h[i] / 2 * k2, cm[, i]); k4 <- f(yi + h[i] * k3, cg[, i + 1L])
    y[, i + 1L] <- yi + h[i] / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
  }
  y[, match(times, grid), drop = FALSE]
}

#' The dosing of a regimen in hours since the first dose: the titration doses first, then the maintenance dose, one every `intervalWeeks`, for every start before
#' `weeks`; `mg` is mg/kg times the reference weight of the PK model (70.9 kg for aducanumab).
.vcr_mech_doses <- function(reg, weeks, weight) {
  every <- vcr_scalar(reg[["intervalWeeks"]], 4)
  n <- max(1L, as.integer(ceiling(weeks / every - 1e-9)))
  tit <- vcr_num(reg[["titrationMgPerKg"]] %||% numeric(0))
  mgkg <- c(tit, rep(vcr_scalar(reg[["maintenanceMgPerKg"]]), max(0L, n - length(tit))))[seq_len(n)]
  list(t0 = (seq_len(n) - 1L) * every * 168, mg = mgkg * weight, hours = vcr_scalar(reg[["infusionHours"]], 1))
}

# --- the chain ----------------------------------------------------------------------------------------------------------------------------------

#' A deterministic stand-in for `n` standard normal draws with a stream of its own: the stream in use is left exactly where it was.
.vcr_mech_with_seed <- function(seed, fn) {
  had <- exists(".Random.seed", envir = .GlobalEnv)
  old <- if (had) get(".Random.seed", envir = .GlobalEnv)
  on.exit(if (had) assign(".Random.seed", old, envir = .GlobalEnv) else if (exists(".Random.seed", envir = .GlobalEnv)) rm(".Random.seed", envir = .GlobalEnv), add = TRUE)
  set.seed(seed, kind = VCR_RNG_KIND)
  fn()
}

#' The chain of a `treatment.mechanism` block for the study of `par` (the posterior medians): the typical person's SUVR course, the people of the published
#' covariance, the clinical link and its inversion into the disease-modifying share. `begin`, `end` are the dosing window in study weeks, `visits` the schedule,
#' `placebo` and `dropout` the study's, which the inversion is calculated under. Returns the effect spec R25 draws from, a report and the sentences of the
#' result's limits.
vcr_mechanism_chain <- function(mech, par, begin, end, visits, placebo, dropout, seed = 1L, individuals = 400L, score_unit = NULL) {
  drug <- as.character(mech[["drug"]] %||% "")
  spec <- .VCR_MECH_DRUGS[[drug]]
  if (is.null(spec)) vcr_abort("scenario_value_invalid", "scenario.treatment.mechanism.drug", "The mechanism chain carries aducanumab and lecanemab.")
  if (is.null(spec$pd)) {
    vcr_abort("scenario_value_invalid", "scenario.treatment.mechanism.drug", sprintf("The chain for %s is not executable: its serum model is published (%s) but no model of its effect on amyloid PET is, and no parameter is guessed.", drug, spec$source))
  }
  link_id <- as.character(mech[["link"]] %||% "pang_2023")
  if (!identical(link_id, .VCR_MECH_LINK_PANG$id)) vcr_abort("scenario_value_invalid", "scenario.treatment.mechanism.link", "The published link carried is Pang et al. 2023 (ADAS-Cog).")
  at <- vcr_scalar(mech[["atWeek"]])
  if (is.null(at) || !(at > begin) || !(at <= max(visits))) vcr_abort("scenario_value_invalid", "scenario.treatment.mechanism.atWeek", "The week the clinical effect is stated at lies after the dose begins and no later than the last visit.")
  reg <- mech[["regimen"]]
  weight <- spec$pk$weightRef
  horizon <- at - begin
  doses <- .vcr_mech_doses(reg, min(end, max(visits)) - begin, weight)
  # the typical person
  pk0 <- as.list(vcr_mechanism_pk(drug)); pd0 <- vcr_mechanism_pd()
  times_h <- sort(unique(c(0, horizon * 168, (visits[visits > begin] - begin) * 168)))
  times_h <- times_h[times_h <= (max(visits) - begin) * 168]
  typical <- as.numeric(vcr_mechanism_suvr(times_h, doses$t0, doses$mg, doses$hours, pk0, pd0))
  d_suvr <- pd0$BL - typical
  delta_at <- d_suvr[match(horizon * 168, times_h)]
  # the people of the published covariance: the spread of what the chain says at that week, and how many reach the 1.10 threshold
  who <- .vcr_mech_with_seed(as.integer(seed) %% 2147483647L, function() {
    z <- matrix(stats::rnorm(individuals * 7L), individuals, 7L)
    cbind(z[, 1:3] %*% chol(spec$pk$omega), z[, 4:7] %*% chol(spec$pd$omega))
  })
  ek <- vapply(seq_len(individuals), function(i) vcr_mechanism_pk(drug, eta = who[i, 1:3]), c(CL = 0, V1 = 0, Q = 0, V2 = 0))
  pk_n <- list(CL = ek["CL", ], V1 = ek["V1", ], Q = ek["Q", ], V2 = ek["V2", ])
  pd_n <- vcr_mechanism_pd(eta = who[, 4:7])
  suvr_n <- vcr_mechanism_suvr(c(0, horizon * 168), doses$t0, doses$mg, doses$hours, pk_n, pd_n)
  delta_n <- suvr_n[, 1L] - suvr_n[, 2L]
  # the link, and the inversion into the model's share
  link <- .VCR_MECH_LINK_PANG
  sd_link <- (link$upper - link$lower) / (2 * 1.96)
  slope <- stats::qnorm((seq_len(.VCR_MECH_DRAWS) - 0.5) / .VCR_MECH_DRAWS, link$slope, sd_link)
  points <- -slope / link$perSuvr * delta_at
  inv <- .vcr_mech_inversion(par, begin, end, visits, at, placebo, dropout, max(abs(points)))
  share <- inv$share(-points)
  centre <- -link$slope / link$perSuvr * delta_at
  tr <- list(family = "empirical_draws", parameters = list(values = share), source = list(kind = "model_result", citation = paste0(spec$source, "; ", link$citation), objectRef = NULL, note = NULL),
             tier = "B", distributed = TRUE, lo = -Inf, hi = 1, closed_lo = FALSE)
  if (!(.vcr_bl_effect_mass(tr) >= .VCR_BL_EFFECT_MIN_MASS)) {
    vcr_abort("scenario_value_invalid", "scenario.treatment.mechanism", "The chain's effect is larger than any disease-modifying share the model can represent (a share of 1 or more): state a smaller dose or an earlier week.")
  }
  m <- function(name, value, unit = NULL) vcr_measure(name, value, source = "calculated", unit = unit)
  s <- function(name, value, se) vcr_measure(name, value, simulated = TRUE, mcse = se, source = "synthetic")
  q <- function(x, p) stats::quantile(x, p, names = FALSE, type = 7)
  reach <- mean(suvr_n[, 2L] <= 1.10)
  report <- list(
    drug = drug, source = spec$source, link = list(id = link$id, slope = link$slope, lower = link$lower, upper = link$upper, perSuvr = link$perSuvr, sd = sd_link, citation = link$citation,
                                                    drawsLow = q(slope, 0.025), drawsHigh = q(slope, 0.975)),
    regimen = list(maintenanceMgPerKg = vcr_scalar(reg[["maintenanceMgPerKg"]]), titrationMgPerKg = vcr_num(reg[["titrationMgPerKg"]] %||% numeric(0)), intervalWeeks = vcr_scalar(reg[["intervalWeeks"]], 4),
                   infusionHours = doses$hours, doses = length(doses$t0), referenceWeightKg = weight),
    atWeek = at, weeksOnDrug = horizon,
    typical = list(baselineSuvr = m("suvr_baseline", pd0$BL), suvrAtWeek = m("suvr_at_week", typical[match(horizon * 168, times_h)]), suvrChange = m("suvr_change", -delta_at),
                   terminalHalfLifeDays = m("half_life_days", vcr_mechanism_terminal_half_life_days(unlist(pk0)))),
    course = lapply(seq_along(times_h), function(i) list(week = begin + times_h[i] / 168, suvr = m("suvr", typical[i]))),
    people = list(n = individuals, suvrChangeMean = s("suvr_change_mean", -mean(delta_n), stats::sd(delta_n) / sqrt(individuals)),
                  suvrChangeP05 = s("suvr_change_p05", q(-delta_n, 0.05), .vcr_mech_quantile_mcse(-delta_n, 0.05)),
                  suvrChangeP95 = s("suvr_change_p95", q(-delta_n, 0.95), .vcr_mech_quantile_mcse(-delta_n, 0.95)), shareBelow110 = s("share_suvr_below_1_10", reach, vcr_mcse_proportion(reach, individuals))),
    clinical = list(pointsAtWeek = m("points_at_week", centre, unit = score_unit), pointsLow = q(points, 0.025), pointsHigh = q(points, 0.975)),
    share = list(median = stats::median(share[share < 1]), p05 = q(share, 0.05), p95 = q(share, 0.95), notRepresentable = mean(share >= 1)))
  limits <- list(
    sprintf("This effect is what follows if the published chain for %s holds (serum model, amyloid PET model, and the trial-level association between amyloid PET and ADAS-Cog). It is never a statement that the drug works.", drug),
    "The link's evidence is on a mixture of ADAS-Cog versions and the CDR-SB, while this model is ADAS-cog 11: the scale does not match.",
    "The link comes from trials mostly in early Alzheimer disease (MMSE 20 to 30); this model describes mild-to-moderate disease (MMSE 14 to 26): the population does not match.",
    "The link was fitted on the same trials the chain is checked against, so agreement with their results is not independent of it.",
    "The link is an association across trials, not the causal effect of lowering amyloid in one person.",
    sprintf("The spread of the effect carried into the assurance is only the confidence interval of that link (95%% %s to %s ADAS-Cog points per 0.1 SUVR): it leaves out how much the link differs between trials and between drugs (a new antibody is a new trial, and one meta-analysis found no association for MMSE), the uncertainty of the serum and PET model parameters and the differences between people. It is a lower bound on the true uncertainty, so the assurance is, if anything, overstated.", format(link$lower), format(link$upper)),
    "The serum and amyloid PET models reproduce the SUVR change the paper prints for its reference patient and the change reported for EMERGE's high dose at week 78 within a few hundredths; the paper's own statement of the time to a SUVR of 1.10 is not reproduced from its published parameters.")
  list(spec = tr, report = report, limits = limits)
}

#' The Monte Carlo error of a sample quantile (Maritz and Jarrett's estimator).
.vcr_mech_quantile_mcse <- function(x, p) {
  n <- length(x); x <- sort(x); a <- (n + 1) * p; b <- (n + 1) * (1 - p)
  w <- stats::pbeta(seq_len(n) / n, a, b) - stats::pbeta((seq_len(n) - 1) / n, a, b)
  sqrt(max(0, sum(w * x^2) - sum(w * x)^2))
}

#' The calculated map from a disease-modifying share to the treated-less-control change among the people still observed at `at`, in the typical study at the
#' posterior medians (the same quantity `expected_difference` reports): returns `share(points)`, the share that gives each requested size of that difference
#' (a positive number: the benefit in points), 1 where the model cannot reach it. A monotone interpolation over a grid of shares.
.vcr_mech_inversion <- function(par, begin, end, visits, at, placebo, dropout, need) {
  times <- sort(unique(c(0, at)))
  study <- vcr_beta_logit_typical_study(par)
  ctl <- vcr_beta_logit_moments(par, study, times, NULL, placebo, !identical(dropout, "none"))
  grid <- c(0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95)
  benefit <- vapply(grid, function(f) {
    drug <- vcr_beta_logit_drug(list(begin = begin, end = end, fraction = f), times)
    trt <- vcr_beta_logit_moments(par, study, times, drug, placebo, !identical(dropout, "none"))
    -(trt$observedChange[length(times)] - ctl$observedChange[length(times)])
  }, numeric(1))
  if (any(diff(benefit) <= 0)) vcr_abort("scenario_value_invalid", "scenario.treatment.mechanism", "The calculated effect of a disease-modifying share is not increasing in the share; the chain cannot be inverted.")
  f <- stats::splinefun(benefit, grid, method = "monoH.FC")
  list(grid = grid, benefit = benefit, share = function(points) { out <- f(pmax(points, 0)); out[points > max(benefit)] <- 1; out[points < 0] <- -1; out })
}
