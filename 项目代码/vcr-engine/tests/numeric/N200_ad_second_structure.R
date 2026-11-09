# N200 — a second, structurally different published ADAS-cog model beside the family's own (plan R28, 2026-11-09)
#
# Conrado et al. 2014 (Richards growth toward the bound of 70, beta residual, covariates on the slope), run as `vcr_conrado_trials`. Held to numbers outside the
# file: the typical-value trajectory the authors' own control stream gives at the reference subject (printed by the open model library that carries that
# stream: ADAS 23.0622, 25.8542, 35.0353 and 47.1252 at 91, 364, 1092 and 1820 days), a known-truth case in which all between-person variation is switched
# off (the expected change of the arm is then the closed form of the mean, since a beta's mean is its parameter), the same seed on any run, and what is refused.
#
#   a  the typical-value trajectory against the authors' control stream's printed values (4 decimals)
#   b  known truth: with no between-person variation, one genotype and one age, the mean of the simulated trials' changes is the closed-form change within
#      three Monte Carlo errors, and the spread of a trial's mean is the beta residual's alone (the closed form of two independent beta variances)
#   c  the same seed gives the same trials, a different seed other ones, and the caller's random stream is left as it was
#   d  what is refused, by name; the slope of a person off background medication is the paper's 0.698 times, and an older person is slower

vcr_case("N200a", c("AC-04"), function() {
  ref <- c("91" = 23.0622, "364" = 25.8542, "1092" = 35.0353, "1820" = 47.1252)
  got <- vapply(as.numeric(names(ref)), function(d) vcr_conrado_mean(22.2, 0.153, d / 365.25), numeric(1))
  err <- max(abs(got - unname(ref)))
  list(pass = err < 6e-4,
       detail = sprintf("the typical subject (baseline 22.2, slope 0.153 per year, shape 6.91) at 91, 364, 1092 and 1820 days: %s against the control stream's printed %s (largest difference %.1e)",
                        paste(sprintf("%.4f", got), collapse = ", "), paste(sprintf("%.4f", ref), collapse = ", "), err))
})

vcr_case("N200b", c("AC-04"), function() {
  tiny <- diag(1e-12, 2L)
  n <- 400L; weeks <- 78
  r <- vcr_conrado_trials(n, weeks, baseline = 23, ageMean = 75, ageSd = 1e-9, apoe = c(1, 0, 0), onMedication = TRUE, trials = 3000L, seed = 20L, omega = tiny)
  slope <- .VCR_CONRADO$slope * (1 + .VCR_CONRADO$slopeApoe4 * (0 - .VCR_CONRADO$apoe4Centre))
  truth <- vcr_conrado_mean(23, slope, weeks / 52.1775) - 23
  m0 <- 23 / 70; mt <- (truth + 23) / 70; tau <- .VCR_CONRADO$tau
  var_beta <- function(m) m * (1 - m) / (tau + 1)
  sd_truth <- 70 * sqrt((var_beta(m0) + var_beta(mt)) / n)
  est <- mean(r$change); se <- stats::sd(r$change) / sqrt(length(r$change))
  list(pass = abs(est - truth) < 3 * se && abs(stats::sd(r$change) / sd_truth - 1) < 0.05,
       detail = sprintf("no between-person variation, 400 people, week 78: the mean change of 3000 simulated trials %.4f (Monte Carlo SE %.4f) against the closed form %.4f; the SD of a trial's mean %.4f against the two beta variances' %.4f",
                        est, se, truth, stats::sd(r$change), sd_truth))
})

vcr_case("N200c", c("AC-04"), function() {
  a <- vcr_conrado_trials(100L, 52, 22, 73, 8, c(.4, .45, .15), trials = 50L, seed = 5L)
  b <- vcr_conrado_trials(100L, 52, 22, 73, 8, c(.4, .45, .15), trials = 50L, seed = 5L)
  d <- vcr_conrado_trials(100L, 52, 22, 73, 8, c(.4, .45, .15), trials = 50L, seed = 6L)
  set.seed(77); s0 <- .Random.seed; invisible(vcr_conrado_trials(100L, 52, 22, 73, 8, c(.4, .45, .15), trials = 5L, seed = 5L)); kept <- identical(s0, .Random.seed)
  list(pass = identical(a$change, b$change) && !identical(a$change, d$change) && kept,
       detail = sprintf("the same seed gives identical trial means (%s), another seed does not, and the caller's stream is %s", identical(a$change, b$change), if (kept) "unchanged" else "disturbed"))
})

vcr_case("N200d", c("AC-04"), function() {
  refuse <- function(expr) tryCatch({ expr; "not refused" }, error = function(e) "refused")
  r1 <- refuse(vcr_conrado_trials(0L, 52, 22, 73, 8, c(.4, .45, .15)))
  r2 <- refuse(vcr_conrado_trials(10L, 52, 72, 73, 8, c(.4, .45, .15)))
  r3 <- refuse(vcr_conrado_trials(10L, 52, 22, 73, 8, c(.5, .6, .15)))
  slow <- vcr_conrado_trials(10L, 52, 22, 73, 8, c(.4, .45, .15), onMedication = FALSE, trials = 5L)$typicalChange
  fast <- vcr_conrado_trials(10L, 52, 22, 73, 8, c(.4, .45, .15), onMedication = TRUE, trials = 5L)$typicalChange
  hand <- vcr_conrado_mean(22, 0.153 * 0.698, 52 / 52.1775) - 22
  list(pass = identical(c(r1, r2, r3), rep("refused", 3L)) && abs(slow - hand) < 1e-12 && slow < fast,
       detail = sprintf("no people, a baseline at the bound and shares that do not add up are refused (%s); off background medication the typical week-52 change is %.4f (hand: %.4f), on it %.4f", paste(c(r1, r2, r3), collapse = "/"), slow, hand, fast))
})
