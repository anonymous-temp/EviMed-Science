# ---------------------------------------------------------------------------
# procova.R — prognostic covariate adjustment as a sample-size calculator plus
# a pre-specified ANCOVA (plan 5.3 "prognostic adjustment").
#
# Hidden knowledge:
#
# - **This is a sample-size formula, not a comparator.** PROCOVA does not
#   create a control arm; it makes a randomized trial more efficient. The page
#   shows three paths side by side (unadjusted, ordinary-covariate ANCOVA,
#   prognostic-score ANCOVA) precisely so that nobody reads the third as "we
#   replaced the control group".
# - **rho must come from outside, and then be discounted.** The EMA
#   qualification opinion carries two separate conservatism parameters: lambda
#   multiplies the correlation, gamma inflates the control arm's SD. They are
#   not interchangeable -- lambda acts inside the square, gamma outside.
#   Defaults: lambda near 1 with strong external validation, 0.9 in the EMA's
#   Alzheimer worked example, and about 0.5 when the model was developed and
#   validated on the same data.
# - **The variance ratio is 1 - rho^2 only when the two arms share sigma and
#   rho.** The general 1:1 form is 1 - (sigma0*rho0 + sigma1*rho1)^2 /
#   (2(sigma0^2 + sigma1^2)); the familiar version is its special case, and
#   the general one is what gets used when the sponsor believes the score
#   behaves differently under treatment -- which the EMA's SAWP explicitly
#   warns it may.
# - **The sensitivity curve is the deliverable, not the point estimate.** A
#   single rho produces a single number that is wrong; a curve over rho makes
#   the reader supply their own prior, which is the EMA's own advice.
# ---------------------------------------------------------------------------

#' Sample-size ratio from prognostic covariate adjustment.
#'
#' @param rho correlation between the prognostic score and the outcome,
#'   measured out of sample.
#' @param lambda EMA correlation discount (multiplies rho).
#' @param gamma EMA SD inflation for the control arm (multiplies sigma0).
#' @param rho1,sigma1 arm-specific values; default to the common ones.
vcr_procova_ratio <- function(rho, lambda = 1, gamma = 1,
                              sigma0 = 1, sigma1 = NULL, rho1 = NULL,
                              allocation = 0.5) {
  r0 <- lambda * rho
  r1 <- lambda * (rho1 %||% rho)
  s0 <- gamma * sigma0
  s1 <- sigma1 %||% sigma0
  if (abs(allocation - 0.5) < 1e-12) {
    ratio <- 1 - (s0 * r0 + s1 * r1)^2 / (2 * (s0^2 + s1^2))
  } else {
    # General allocation: the residual variance of each arm is scaled by
    # (1 - rho^2) and the score's between-arm imbalance contributes nothing
    # under randomization, so the ratio is the allocation-weighted mixture.
    p <- allocation
    num <- (s1^2 * (1 - r1^2)) / p + (s0^2 * (1 - r0^2)) / (1 - p)
    den <- s1^2 / p + s0^2 / (1 - p)
    ratio <- num / den
  }
  list(varianceRatio = ratio, sampleSizeRatio = ratio,
       rhoApplied = c(treatment = r1, control = r0),
       sdApplied = c(treatment = s1, control = s0),
       lambda = lambda, gamma = gamma)
}

#' Total sample size for a two-arm mean comparison when the two arms have
#' their own residual SDs (after covariate adjustment) and the allocation is
#' `allocation` to treatment:
#'   N = (z_a + z_b)^2 (s1^2 / p + s0^2 / (1 - p)) / delta^2.
#' With s1 = s0 and p = 1/2 this is `vcr_n_means`.
vcr_n_means_hetero <- function(delta, sd1, sd0, alpha = 0.025, power = 0.9, allocation = 0.5, sided = 1) {
  za <- qnorm(1 - if (sided == 1) alpha else alpha / 2)
  zb <- qnorm(power)
  (za + zb)^2 * (sd1^2 / allocation + sd0^2 / (1 - allocation)) / delta^2
}

#' The three paths the design page shows side by side.
#'
#' Hidden knowledge: the EMA's `gamma` inflates the *control arm's* SD in the
#' sample-size calculation, so it belongs in the base variance, not only in a
#' ratio. The first version multiplied a base size computed with the plain SD
#' by a ratio in which gamma cancelled at rho = 0 (a score with no correlation
#' asked for exactly the unadjusted size whatever gamma said), which is the
#' opposite of what a conservatism parameter is for (CE-19). Each path is now
#' sized directly from the residual SDs it implies:
#'   unadjusted         (sd, sd)
#'   ordinary           (sd sqrt(1 - rho_ord^2), same)
#'   prognostic         (sd sqrt(1 - (lambda rho)^2), gamma sd sqrt(1 - (lambda rho)^2))
#'   undiscounted       (sd sqrt(1 - rho^2), same)
vcr_procova_paths <- function(delta, sd = 1, alpha = 0.025, power = 0.9,
                              rho_prognostic, rho_ordinary = 0,
                              lambda = 1, gamma = 1, allocation = 0.5, sided = 1) {
  n_of <- function(rho1, rho0, g = 1) {
    vcr_n_means_hetero(delta, sd * sqrt(1 - rho1^2), g * sd * sqrt(1 - rho0^2), alpha, power, allocation, sided)
  }
  base <- n_of(0, 0)
  mk <- function(name, total) list(
    path = name, varianceRatio = total / base,
    total = total, treat = total * allocation, control = total * (1 - allocation)
  )
  list(
    unadjusted = mk("unadjusted", base),
    ordinaryCovariates = mk("ordinary_covariates", n_of(rho_ordinary, rho_ordinary)),
    prognosticScore = mk("prognostic_score", n_of(lambda * rho_prognostic, lambda * rho_prognostic, gamma)),
    undiscountedPrognosticScore = mk("prognostic_score_undiscounted", n_of(rho_prognostic, rho_prognostic)),
    lambda = lambda, gamma = gamma
  )
}

#' rho sensitivity curve: the page's default view (EMA SAWP advice).
vcr_procova_sensitivity <- function(delta, sd = 1, alpha = 0.025, power = 0.9,
                                    rho_grid = seq(0, 0.9, by = 0.05),
                                    lambda = 1, gamma = 1, allocation = 0.5, sided = 1) {
  total <- vapply(rho_grid, function(r) {
    vcr_n_means_hetero(delta, sd * sqrt(1 - (lambda * r)^2), gamma * sd * sqrt(1 - (lambda * r)^2),
                       alpha, power, allocation, sided)
  }, numeric(1))
  base <- vcr_n_means_hetero(delta, sd, sd, alpha, power, allocation, sided)
  data.frame(rho = rho_grid, varianceRatio = total / base, totalSampleSize = total)
}
