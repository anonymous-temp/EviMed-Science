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

#' The three paths the design page shows side by side.
vcr_procova_paths <- function(delta, sd = 1, alpha = 0.025, power = 0.9,
                              rho_prognostic, rho_ordinary = 0,
                              lambda = 1, gamma = 1, allocation = 0.5) {
  base <- vcr_n_means(delta, sd, alpha, power, allocation)
  ord <- vcr_procova_ratio(rho_ordinary, lambda = 1, gamma = 1, sigma0 = sd, allocation = allocation)
  pro <- vcr_procova_ratio(rho_prognostic, lambda = lambda, gamma = gamma, sigma0 = sd, allocation = allocation)
  mk <- function(name, ratio) list(
    path = name, varianceRatio = ratio,
    total = base$total * ratio, treat = base$treat * ratio, control = base$control * ratio
  )
  list(
    unadjusted = mk("unadjusted", 1),
    ordinaryCovariates = mk("ordinary_covariates", ord$varianceRatio),
    prognosticScore = mk("prognostic_score", pro$varianceRatio),
    undiscountedPrognosticScore = mk("prognostic_score_undiscounted",
      vcr_procova_ratio(rho_prognostic, 1, 1, sd, allocation = allocation)$varianceRatio),
    lambda = lambda, gamma = gamma
  )
}

#' rho sensitivity curve: the page's default view (EMA SAWP advice).
vcr_procova_sensitivity <- function(delta, sd = 1, alpha = 0.025, power = 0.9,
                                    rho_grid = seq(0, 0.9, by = 0.05),
                                    lambda = 1, gamma = 1, allocation = 0.5) {
  base <- vcr_n_means(delta, sd, alpha, power, allocation)$total
  data.frame(
    rho = rho_grid,
    varianceRatio = vapply(rho_grid, function(r)
      vcr_procova_ratio(r, lambda, gamma, sd, allocation = allocation)$varianceRatio, numeric(1)),
    totalSampleSize = vapply(rho_grid, function(r)
      base * vcr_procova_ratio(r, lambda, gamma, sd, allocation = allocation)$varianceRatio, numeric(1))
  )
}
