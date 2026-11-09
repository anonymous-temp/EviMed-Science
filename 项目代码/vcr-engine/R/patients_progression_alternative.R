# ---------------------------------------------------------------------------
# patients_progression_alternative.R — a second, structurally different published ADAS-cog model, held beside the family's own (plan R28, 2026-11-09):
# Conrado, Denney, Chen and Ito, "An updated Alzheimer's disease progression model: incorporating non-linearity, beta regression, and a third-level
# random effect in NONMEM", J Pharmacokinet Pharmacodyn 2014;41:581-598 (DOI 10.1007/s10928-014-9375-z, PMID 25168488), the Coalition Against Major
# Diseases (CAMD) control arms (placebo and stable background medication) of 15 trials, 4,494 people, mild-to-moderate Alzheimer disease.
#
# Hidden knowledge:
#
# - **Where the numbers come from, and what was not read.** The paper itself is not open: its tables were not read. Every value below is a final estimate of
#   the authors' own NONMEM listing (`Output_real_CPathAD.lst`, DDMoRe model repository entry DDMODEL00000290), as transcribed with its control stream in
#   the open nlmixr2lib model library (`Conrado_2014_alzheimer`); that library says it did not cross-check them against the paper's tables either. The
#   model's own words (abstract) agree with the signs used here: faster progression with younger age and more APOE e4 alleles, faster on stable background
#   medication than off it. The study-level (third level) random effects are in the listing and are NOT used here: where they enter (which parameters, on
#   which scale) was not verifiable from what was read, so the spread this file gives between simulated trials is the people's and the residual's only, and
#   is narrower than the paper's. The study-1131 scalers are dropped for the same reason.
# - **Structurally different from the family's model**: a Richards growth of the mean score toward the bound of 70 with the person's own baseline and one
#   slope (no separate placebo response and no logit-linear drift), a beta residual of fixed precision, and covariates that scale the slope (age, APOE e4
#   count, background medication) and the baseline (sex, APOE e4). The family's model (Rogers et al. 2012, adsim 3.0) is fitted to CAMD and literature data;
#   this one is fitted to the CAMD control arms: the structure is independent, the data are not (both rest on the CAMD database).
# - **The baseline is the trial's own.** The paper's typical baseline (22.2) and its covariate scaling are replaced, for a trial, by the trial's published
#   mean baseline score (the table the validation is frozen on) with the paper's between-person variance of the log baseline (0.156, CV about 40 percent,
#   which agrees with the SD of 8 to 10 points the trials publish at a mean of 22 to 26): the covariates of the baseline (sex, APOE e4) are then already in
#   the trial's mean. The baseline and the later score are both observed with the beta residual, so a person's change carries two residuals.
# - **No dropout, no placebo response, no drug**: the model describes the course of a control arm that stays in; it has no input for an effect. A mean over
#   the people who stay is the mean over everyone: nobody leaves here. That is a stated difference from a trial that reports an MMRM least-squares mean.
# - **Background medication enters as a flag**: 1 (on) is the paper's reference, the slope multiplier 1 + (1 - flag) * (-0.302) applies to people off it.
# - **Build to delete**: when the paper's tables or the study-level terms are available, this file takes them; nothing else reads its constants.
# ---------------------------------------------------------------------------

.VCR_CONRADO <- list(
  source = "Conrado DJ, Denney WS, Chen S, Ito K. J Pharmacokinet Pharmacodyn 2014;41:581-598 (DOI 10.1007/s10928-014-9375-z), final estimates of the authors' NONMEM listing, DDMoRe DDMODEL00000290, as transcribed in nlmixr2lib",
  typicalBaseline = 22.2, slope = 0.153, shape = 6.91, tau = 87.5,
  slopeAge = -0.024, slopeApoe4 = 0.195, slopeOffMedication = -0.302, ageCentre = 75, apoe4Centre = 0.72,
  omega = matrix(c(0.156, 0.0224, 0.0224, 0.0413), 2L), omegaOrder = c("logBaseline", "slope"), bound = 70)

#' The mean score (0-70) at `t` years of a person whose baseline is `bl` and whose slope is `sl`: the Richards growth toward the bound.
vcr_conrado_mean <- function(bl, sl, t_years, shape = .VCR_CONRADO$shape, bound = .VCR_CONRADO$bound) {
  bound * (bl / bound) / ((bl / bound)^shape + (1 - (bl / bound)^shape) * exp(-shape * sl * t_years))^(1 / shape)
}

#' The mean change of a control arm at `weeks` for `n` people, drawn `trials` times: each trial draws its people (age, APOE e4 alleles, the baseline and slope
#' effects, the baseline and later beta observations) and returns the arm's mean change. `baseline` is the trial's mean baseline score, `age` its mean and SD,
#' `apoe` the genotype shares (0, 1, 2 alleles), `onMedication` the flag of the paper's reference. Returns the per-trial means and the typical-value change.
#' `baselineKind` says what `baseline` is: the model's own typical value (the median of its log-normal baseline) or the arm's MEAN baseline, which is what a trial
#' publishes (review S13: a published mean taken as the median gave an arm baseline about 8% too high, 25.8 for 23.9, and 0.2 points more change at 78 weeks).
#' For a mean the median is mean x exp(-omega_baseline / 2). The result carries the mean baseline score the simulated people really had (`baselineMean`).
vcr_conrado_trials <- function(n, weeks, baseline, ageMean, ageSd, apoe, onMedication = TRUE, trials = 2000L, seed = 1L, omega = .VCR_CONRADO$omega, baselineKind = c("typical", "mean")) {
  baselineKind <- match.arg(baselineKind)
  P <- .VCR_CONRADO
  if (!(n >= 1L) || !(weeks > 0) || !(baseline > 0 && baseline < P$bound)) stop("n, weeks and baseline must be positive, the baseline below 70", call. = FALSE)
  if (length(apoe) != 3L || abs(sum(apoe) - 1) > 1e-9) stop("apoe is three shares that add up to 1", call. = FALSE)
  old <- if (exists(".Random.seed", envir = .GlobalEnv)) get(".Random.seed", envir = .GlobalEnv) else NULL
  on.exit(if (is.null(old)) rm(".Random.seed", envir = .GlobalEnv) else assign(".Random.seed", old, envir = .GlobalEnv), add = TRUE)
  set.seed(seed)
  L <- t(chol(omega + diag(1e-300, 2L))); t_years <- weeks / 52.1775
  if (identical(baselineKind, "mean")) baseline <- baseline * exp(-omega[1L, 1L] / 2)
  one <- function() {
    eta <- L %*% matrix(stats::rnorm(2L * n), 2L)
    bl <- baseline * exp(eta[1L, ])
    bl <- pmin(bl, P$bound - 1e-6)
    apoe_n <- sample.int(3L, n, replace = TRUE, prob = apoe) - 1L
    age <- stats::rnorm(n, ageMean, ageSd)
    sl <- (P$slope + eta[2L, ]) * (1 + P$slopeAge * (age - P$ageCentre)) * (1 + P$slopeApoe4 * (apoe_n - P$apoe4Centre)) * (1 + (1 - as.numeric(onMedication)) * P$slopeOffMedication)
    m0 <- bl / P$bound; mt <- vcr_conrado_mean(bl, sl, t_years) / P$bound
    y0 <- stats::rbeta(n, m0 * P$tau, (1 - m0) * P$tau); yt <- stats::rbeta(n, mt * P$tau, (1 - mt) * P$tau)
    c(P$bound * mean(yt - y0), P$bound * mean(y0))
  }
  typical <- vcr_conrado_mean(baseline, P$slope * (1 + P$slopeOffMedication * (1 - as.numeric(onMedication))), t_years) - baseline
  draws <- vapply(seq_len(trials), function(i) one(), numeric(2L))
  list(change = draws[1L, ], baselineMean = mean(draws[2L, ]), baselineMeanMcse = stats::sd(draws[2L, ]) / sqrt(trials), typicalChange = typical, weeks = weeks, source = P$source)
}
