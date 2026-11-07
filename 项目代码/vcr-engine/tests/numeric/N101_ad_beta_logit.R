# N101 — the Alzheimer ADAS-cog drug-disease-trial model as the beta_logit family of patients.progression 1.1.0 (plan T06, 2026-11-07)
#
# The sources and the computations behind every published number used here are in the source audit (stream S3a, AD-SOURCE.md §2.11, §5):
# S2 = EMA/CHMP/SAWP/567188/2013, the EMA qualification opinion 2013 (its tables are images, read at 200-220 dpi); S11 = the adsim 3.0 training manual
# (Polhamus & Rogers, 2013); S5 = Romero et al. 2015, Table 1. Tolerances are the published rounding plus the published table's own Monte Carlo error
# (1,600 draws) plus ours, at about three SD. No figure reading is used: EMA Figure 15 does not agree with this posterior, Table 10's intervals are not
# reproduced, and neither is a case here. The EMA, PAGE 2012 and Romero powers come from MMRM analyses that disagree with each other and are not cases.
#
#   a  the parameter file is adsim 3.0's posterior (hashes, 1,600 x 41, medians), and three numbers the training manual prints (S11 Listings 2.6, 2.8, 4.6)
#      plus the donepezil ET50 of Romero et al. 2015 come out of it exactly
#   b  the covariate model against EMA Table 7 ("Predicted": ApoE4 0/1/2, male, mean age by genotype, SD of age) and the generator's moments of 400,000 people
#   c  the intercept by baseline MMSE in a new study against EMA Table 9 (median and 90% bounds over the posterior)
#   d  the one-year change by MMSE, sex and ApoE4 in a new study against EMA Table 11 (six of its eighteen rows)
#   e  dropout against EMA Table 8's medians, under a stated covariate reading (MMSE uniform 16-26, age from the genotype model, no study effect)
#   f  the SD of the change from baseline at weeks 26, 52, 78 against the EMA text ("approximately 6, 8, and 10.5")
#   g  the observation model: scores stay on the 0-70 scale even ten years out at MMSE 0 and 30, and touch an end only where the latent mean is there;
#      the beta's mean and variance for fixed theta and tau against 1e5 draws
#   h  the placebo, symptomatic and disease-modifying terms against their own closed forms; zero effects make identical arms; a symptomatic offset
#      is flat over time where a disease-modifying effect grows with it
#   i  the null at the domain's floor (change and covariance analyses), the simulated against the calculated difference, 1 and 2 cores, a cancel
#   j  the three uncertainty modes do what they say
#   k  what is refused, by name
#   l  the four other families give the 1.0.0 release's output hashes, under both labels

.n101_set <- function() vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0")
.n101_P <- function(v, basis = "assumed") list(value = v, basis = basis)
.n101_sc <- function(..., n = 100L, visits = c(0, 13, 26, 52, 78), uncertainty = NULL) {
  model <- list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"))
  if (!is.null(uncertainty)) model$uncertainty <- uncertainty
  c(list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), timeUnit = "weeks", visits = visits, model = model), list(...))
}
.n101_run <- function(sc, seed, cores = 1L, replicates = NULL, label = NULL)
  vcr_test_run(vcr_test_job("patients.progression", sc, seed = seed, cores = cores, replicates = replicates,
                            extra = if (is.null(label)) list() else list(methodVersion = label)))
.n101_issue <- function(r) { i <- c(r$diagnostics$issues %||% list(), r$diagnostics$resultValidationIssues %||% list()); if (length(i)) sprintf("%s@%s", i[[1]]$code, i[[1]]$field) else NA_character_ }
.n101_measure <- function(r, name) Filter(function(m) identical(m$name, name), r$measures)[[1]]
#' Median and 5% / 95% quantiles of one number computed per posterior draw for `reps` new studies drawn from it (AD-SOURCE §5).
.n101_new_study_quantiles <- function(population, fn, reps, seed) {
  set <- .n101_set(); D <- set$draws
  set.seed(seed, kind = VCR_RNG_KIND)
  vals <- numeric(nrow(D) * reps); k <- 0L
  for (d in seq_len(nrow(D))) {
    par <- vcr_beta_logit_par(D[d, ], population)
    for (r in seq_len(reps)) { k <- k + 1L; vals[k] <- fn(par, vcr_beta_logit_new_study(par)) }
  }
  stats::quantile(vals, c(0.5, 0.05, 0.95), names = FALSE)
}
.n101_close <- function(got, want, tol) all(abs(got - want) <= tol)

vcr_case("N101a", c("AC-04"), function() {
  set <- .n101_set()
  file_ok <- identical(set$fileSha256, "a8889ac7c1aa4bf15f62347ee8675c5a691cfe92b8ffd9c6fb0de7510f1f51c8") &&
    identical(set$source$sourceSha256, "f41cfd47ed3a94633169afb1246377a236697279425e4b4bf2c844069bf678be") &&
    identical(set$source$archiveSha1, "bf03894a7b86eec4113bd457d5fcf6386b14a65c") && identical(dim(set$draws), c(1600L, 41L))
  medians_gap <- max(abs(set$medians - set$storedMedians[names(set$medians)]) / abs(set$medians))
  par <- vcr_beta_logit_par(set$medians)
  # adsim 3.0 training manual (S11): Listing 2.6 phiEta * 70 / 4 = 7.2415; Listing 2.8 the residual SD at an ADAS-cog of 25 = 3.509151 (the manual's
  # closed form, without the simulation guard); Listing 4.6 gLogitDelta(-1.4, 12, 22.5, et50 = 1) = -0.1010641
  l26 <- par$phiEta * 70 / 4
  l28 <- sqrt(vcr_beta_logit_score_moments(25 / 70, 1 / par$phiEpsilon^2, guard = 0)$var)
  l46 <- vcr_beta_logit_emax_from_points(-1.4, 12, 22.5, 1)
  # Romero et al. 2015 Table 1: the donepezil ET50 is 1.62 weeks
  et50 <- set$medians[["et50[1]"]]
  ok <- file_ok && medians_gap < 1e-12 && abs(l26 - 7.2415) <= 5e-5 && abs(l28 - 3.509151) <= 5e-7 && abs(l46 - (-0.1010641)) <= 5e-8 && abs(et50 - 1.62) <= 0.005
  list(pass = ok, detail = sprintf("parameter file SHA-256 %s (adsim 3.0 posterior.rda %s, archive SHA-1 %s), %d draws x %d columns, the stored medians equal the draws' to %.1e; training manual Listing 2.6 phiEta x 70/4 = %.5f (printed 7.2415), Listing 2.8 residual SD at 25 = %.7f (printed 3.509151), Listing 4.6 gLogitDelta(-1.4, 12, 22.5, 1) = %.8f (printed -0.1010641); donepezil ET50 %.4f weeks (Romero 2015: 1.62)",
                                   substr(set$fileSha256, 1, 12), substr(set$source$sourceSha256, 1, 12), substr(set$source$archiveSha1, 1, 12), nrow(set$draws), ncol(set$draws), medians_gap, l26, l28, l46, et50))
})

vcr_case("N101b", c("AC-04"), function() {
  # EMA qualification opinion 2013 Table 7 "Predicted" (S2 p.24): ApoE4 alleles 0/1/2 0.42/0.44/0.14, male 0.45, mean age 75.3/75.6/66.5, SD of age 9.3
  # "Predicted" is the posterior's own prediction: the means of the draws, held to the table's rounding (a bound included); the generator runs on the
  # medians and its moments are held to the table within the rounding, 0.001 and four Monte Carlo SE
  set <- .n101_set(); par <- vcr_beta_logit_par(set$medians); D <- set$draws
  table7 <- list(apoe = c(0.42, 0.44, 0.14), male = 0.45, age = c(75.3, 75.6, 66.5), sd = 9.3)
  predicted <- list(apoe = colMeans(D[, c("pApo[1]", "pApo[2]", "pApo[3]")]), male = 1 - mean(D[, "pGen"]), age = colMeans(D[, c("Eage[1]", "Eage[2]", "Eage[3]")]), sd = sqrt(mean(D[, "Vage"])))
  params_ok <- .n101_close(predicted$apoe, table7$apoe, 0.005 + 1e-12) && .n101_close(predicted$male, table7$male, 0.005 + 1e-12) &&
    .n101_close(predicted$age, table7$age, 0.05 + 1e-12) && .n101_close(predicted$sd, table7$sd, 0.05 + 1e-12)
  # the generator: 400,000 people of a typical study at the medians
  n <- 200000L
  p <- list(par = par, population = list(), uncertainty = "typical_study", visits = c(0, 52), at = 2L, n0 = n, n1 = n,
            treatment = list(begin = 0, end = 52, fraction = 0), placebo = TRUE)
  set.seed(10102L, kind = VCR_RNG_KIND)
  pp <- .vcr_bl_people(set, p); N <- 2 * n
  share <- tabulate(pp$apoe + 1L, 3L) / N; male <- 1 - mean(pp$female)
  means <- vapply(0:2, function(g) mean(pp$age[pp$apoe == g]), numeric(1))
  within_sd <- sqrt(sum(vapply(0:2, function(g) sum((pp$age[pp$apoe == g] - means[g + 1L])^2), numeric(1))) / (N - 3))
  se_p <- sqrt(table7$apoe * (1 - table7$apoe) / N); se_m <- par$ageSd / sqrt(share * N)
  sim_ok <- all(abs(share - table7$apoe) <= 0.005 + 0.001 + 4 * se_p) && abs(male - table7$male) <= 0.006 + 4 * sqrt(0.25 / N) &&
    all(abs(means - table7$age) <= 0.06 + 4 * se_m) && abs(within_sd - table7$sd) <= 0.06 + 4 * par$ageSd / sqrt(2 * N)
  list(pass = params_ok && sim_ok,
       detail = sprintf("EMA qualification opinion 2013 Table 7 \"Predicted\": the parameter set's posterior means ApoE4 %.4f/%.4f/%.4f (table 0.42/0.44/0.14), male %.4f (0.45), mean age %.2f/%.2f/%.2f (75.3/75.6/66.5), SD %.3f (9.3); the generator's 400,000 people at the medians: ApoE4 %.4f/%.4f/%.4f, male %.4f, mean age %.2f/%.2f/%.2f, within-genotype SD %.3f",
                        predicted$apoe[1], predicted$apoe[2], predicted$apoe[3], predicted$male, predicted$age[1], predicted$age[2], predicted$age[3], predicted$sd,
                        share[1], share[2], share[3], male, means[1], means[2], means[3], within_sd))
})

vcr_case("N101c", c("AC-04"), function() {
  # EMA qualification opinion 2013 Table 9 (S2 p.28): the expected ADAS-cog 11 at baseline of a new study, median [5%, 95%] over the posterior, at a
  # baseline MMSE of 16, 21 and 26: 32.2 [29.6, 34.9]; 22.3 [20.0, 24.8]; 14.2 [12.4, 16.1]. Four new studies per posterior draw.
  table9 <- list(`16` = c(32.2, 29.6, 34.9), `21` = c(22.3, 20.0, 24.8), `26` = c(14.2, 12.4, 16.1))
  got <- lapply(c(16, 21, 26), function(b) .n101_new_study_quantiles(list(mmseRange = c(b, b), apoe4 = c(1, 0, 0), femaleShare = 0),
    function(par, study) vcr_beta_logit_moments(par, study, 0, NULL, FALSE, FALSE, n_age = 1L)$mean, 4L, 10103L + b))
  ok <- all(mapply(function(g, w) abs(g[1] - w[1]) <= 0.15 && all(abs(g[2:3] - w[2:3]) <= 0.35), got, table9))
  list(pass = ok, detail = paste0("EMA qualification opinion 2013 Table 9, intercept of a new study (tolerance 0.15 for a median, 0.35 for a bound): ",
       paste(mapply(function(b, g, w) sprintf("MMSE %s %.2f [%.2f, %.2f] (table %.1f [%.1f, %.1f])", b, g[1], g[2], g[3], w[1], w[2], w[3]), names(table9), got, table9), collapse = "; ")))
})

vcr_case("N101d", c("AC-04"), function() {
  # EMA qualification opinion 2013 Table 11 (S2 p.28 = the ASCPT 2012 poster's Table 1): the one-year change, no placebo term, of a new study, median
  # [5%, 95%] over the posterior, by baseline MMSE / sex / ApoE4 alleles; age from its genotype's distribution. Four new studies per posterior draw.
  rows <- list(list(16, 0, 0, c(7.14, 4.48, 9.54)), list(21, 0, 0, c(4.48, 1.99, 7.09)), list(21, 1, 0, c(3.97, 1.42, 6.57)),
               list(21, 0, 2, c(5.43, 2.82, 8.06)), list(26, 0, 0, c(1.69, -0.28, 4.12)), list(26, 1, 2, c(2.01, 0.02, 4.53)))
  got <- lapply(seq_along(rows), function(i) {
    rw <- rows[[i]]; one <- c(0, 0, 0); one[rw[[3]] + 1L] <- 1
    .n101_new_study_quantiles(list(mmseRange = c(rw[[1]], rw[[1]]), apoe4 = one, femaleShare = rw[[2]]),
      function(par, study) vcr_beta_logit_moments(par, study, c(0, 52), NULL, FALSE, FALSE)$change[2], 4L, 10110L + i)
  })
  ok <- all(mapply(function(g, rw) abs(g[1] - rw[[4]][1]) <= 0.15 && all(abs(g[2:3] - rw[[4]][2:3]) <= 0.35), got, rows))
  list(pass = ok, detail = paste0("EMA qualification opinion 2013 Table 11, one-year change of a new study (tolerance 0.15 for a median, 0.35 for a bound): ",
       paste(mapply(function(rw, g) sprintf("%d/%s/%d %.2f [%.2f, %.2f] (table %.2f [%.2f, %.2f])", rw[[1]], if (rw[[2]] == 1) "F" else "M", rw[[3]], g[1], g[2], g[3], rw[[4]][1], rw[[4]][2], rw[[4]][3]), rows, got), collapse = "; ")))
})

vcr_case("N101e", c("AC-04"), function() {
  # EMA qualification opinion 2013 Table 8 (S2 p.25), the medians of the share dropped out by weeks 26 / 52 / 78: age <= 75 .133/.239/.329, > 75
  # .165/.293/.398, MMSE <= 21 .179/.315/.426, > 21 .119/.216/.298. The table does not say which covariates it integrated over, so this READS it as:
  # MMSE uniform on 16-26, age from the genotype model, no study effect (omega 0); tolerance 0.025, a reading and not a reproduction.
  set <- .n101_set(); D <- set$draws; weeks <- c(26, 52, 78)
  table8 <- list(young = c(.133, .239, .329), old = c(.165, .293, .398), low = c(.179, .315, .426), high = c(.119, .216, .298))
  by_age <- function(par, bounds) {
    w <- vapply(0:2, function(g) par$apoe[g + 1L] * (stats::pnorm(bounds[2], par$ageMean[g + 1L], par$ageSd) - stats::pnorm(bounds[1], par$ageMean[g + 1L], par$ageSd)), numeric(1))
    obs <- vapply(0:2, function(g) { one <- c(0, 0, 0); one[g + 1L] <- 1; q <- par; q$apoe <- one; q$ageBounds <- bounds; vcr_beta_logit_observed(q, weeks) }, numeric(length(weeks)))
    1 - as.vector(obs %*% w) / sum(w)
  }
  per_draw <- lapply(seq_len(nrow(D)), function(d) {
    par <- vcr_beta_logit_par(D[d, ])
    low <- par; low$mmse <- c(16, 21); high <- par; high$mmse <- c(21, 26)
    rbind(young = by_age(par, c(0, 75)), old = by_age(par, c(75, 130)), low = 1 - vcr_beta_logit_observed(low, weeks), high = 1 - vcr_beta_logit_observed(high, weeks))
  })
  med <- apply(simplify2array(per_draw), c(1, 2), stats::median)
  ok <- all(abs(med - do.call(rbind, table8)) <= 0.025)
  typical <- 1 - vcr_beta_logit_observed(vcr_beta_logit_par(set$medians), 78)
  list(pass = ok, detail = sprintf("EMA qualification opinion 2013 Table 8 medians, read with MMSE U(16,26), age from the genotype model, omega 0 (tolerance 0.025): age <= 75 %s (table .133/.239/.329); > 75 %s (.165/.293/.398); MMSE <= 21 %s (.179/.315/.426); > 21 %s (.119/.216/.298); largest gap %.3f. Informational: a typical study at the medians loses %.3f by week 78 (EMA text: approximately 33%%)",
                                   paste(sprintf("%.3f", med["young", ]), collapse = "/"), paste(sprintf("%.3f", med["old", ]), collapse = "/"), paste(sprintf("%.3f", med["low", ]), collapse = "/"),
                                   paste(sprintf("%.3f", med["high", ]), collapse = "/"), max(abs(med - do.call(rbind, table8))), typical))
})

vcr_case("N101f", c("AC-04"), function() {
  # EMA qualification opinion 2013 text (S2 p.32): the SD of the change from baseline is "approximately 6, 8, and 10.5 points" at weeks 26, 52, 78.
  # Calculated here for the placebo arm of a typical study at the medians, MMSE uniform 16-26 (the population is the stated reading); tolerance 0.6.
  set <- .n101_set(); par <- vcr_beta_logit_par(set$medians)
  m <- vcr_beta_logit_moments(par, vcr_beta_logit_typical_study(par), c(0, 26, 52, 78))
  sds <- m$changeSd[2:4]
  list(pass = all(abs(sds - c(6, 8, 10.5)) <= 0.6),
       detail = sprintf("the calculated SD of the change from baseline at weeks 26/52/78 is %.2f/%.2f/%.2f (EMA text: approximately 6/8/10.5; tolerance 0.6, population read as MMSE U(16,26))", sds[1], sds[2], sds[3]))
})

vcr_case("N101g", c("AC-04"), function() {
  set <- .n101_set(); worst_z <- 0; edge <- character(0); outside <- 0L; wrong_edge <- 0L
  set.seed(10107L, kind = VCR_RNG_KIND)
  for (mm in c(0, 30)) for (mode in c("typical_study", "new_study")) {
    p <- list(par = vcr_beta_logit_par(set$medians, list(mmseRange = c(mm, mm))), population = list(mmseRange = c(mm, mm)), uncertainty = mode,
              visits = c(0, 520), at = 2L, n0 = 20000L, n1 = 0L, treatment = list(begin = 0, end = 520, fraction = 0), placebo = TRUE)
    pp <- .vcr_bl_people(set, p); y <- c(pp$y0, pp$ya); th <- stats::plogis(c(pp$eta, pp$latent))
    outside <- outside + sum(!(y >= 0 & y <= 70))
    # a score at an end of the scale belongs to a person whose latent mean is within 0.3% of that end
    wrong_edge <- wrong_edge + sum(y == 70 & th < 0.997) + sum(y == 0 & th > 0.003)
    edge <- c(edge, sprintf("MMSE %d %s: %d at 0, %d at 70", mm, mode, sum(y == 0), sum(y == 70)))
  }
  # the observation model's closed form for fixed theta and tau against 1e5 draws of the engine's own generator
  for (theta in c(0.05, 0.3, 0.9)) for (tau in c(20, 90)) {
    y <- vcr_beta_logit_scores(rep(theta, 1e5), tau); cf <- vcr_beta_logit_score_moments(theta, tau)
    z_m <- abs(mean(y) - cf$mean) / sqrt(cf$var / 1e5)
    z_v <- abs(stats::var(y) - cf$var) / sqrt((mean((y - mean(y))^4) - stats::var(y)^2) / 1e5)
    worst_z <- max(worst_z, z_m, z_v)
  }
  list(pass = outside == 0L && wrong_edge == 0L && worst_z < 4,
       detail = sprintf("80,000 scores at MMSE 0 and 30, at baseline and after 520 weeks, typical and new studies: %d outside 0-70, %d at an end of the scale away from the latent mean (%s); the score's mean and variance for theta 0.05/0.3/0.9 and tau 20/90 against 1e5 draws: largest distance %.2f standard errors",
                        outside, wrong_edge, paste(edge, collapse = "; "), worst_z))
})

vcr_case("N101h", c("AC-04"), function() {
  set <- .n101_set(); par <- vcr_beta_logit_par(set$medians)
  # placebo (Bateman form): its integral over all time is minus aucPlacebo, its trough is at log(keq / kel) / (keq - kel) (20.2 weeks at the medians)
  integral <- stats::integrate(function(t) vcr_beta_logit_placebo(par, t), 0, Inf, rel.tol = 1e-12)$value
  trough <- stats::optimize(function(t) vcr_beta_logit_placebo(par, t), c(0, 200), tol = 1e-10)
  t_star <- log(par$keq / par$kel) / (par$keq - par$kel)
  placebo_ok <- abs(integral + set$medians[["aucPlacebo"]]) < 1e-8 && abs(trough$minimum - t_star) < 1e-4 && abs(t_star - 20.2) < 0.05
  # symptomatic: Emax on the time on drug, halved per washout half-life after the dose ends
  tr <- list(begin = 4, end = 24, fraction = 0, emax = -0.2, et50 = 1.5, halfLife = 3)
  d <- vcr_beta_logit_drug(tr, c(2, 10, 24, 27, 30))
  at_end <- -0.2 * 20 / 21.5
  sym_ok <- d$symptomatic[1] == 0 && abs(d$symptomatic[2] - (-0.2 * 6 / 7.5)) < 1e-15 && abs(d$symptomatic[3] - at_end) < 1e-15 &&
    abs(d$symptomatic[4] - at_end / 2) < 1e-15 && abs(d$symptomatic[5] - at_end / 4) < 1e-15
  # disease-modifying: the same people with and without the effect differ by fraction x mean slope x time on drug, held after the dose ends
  p <- list(par = par, population = list(), uncertainty = "new_study", visits = c(0, 52), at = 2L, n0 = 300L, n1 = 300L, placebo = TRUE)
  set.seed(10108L, kind = VCR_RNG_KIND); s0 <- get(".Random.seed", envir = .GlobalEnv)
  with_dm <- .vcr_bl_people(set, c(p, list(treatment = list(begin = 0, end = 26, fraction = 0.4))))
  assign(".Random.seed", s0, envir = .GlobalEnv)
  without <- .vcr_bl_people(set, c(p, list(treatment = list(begin = 0, end = 26, fraction = 0))))
  gap <- with_dm$latent - without$latent
  dm_ok <- identical(with_dm$y0, without$y0) && all(gap[with_dm$treated == 0] == 0) && max(abs(gap[with_dm$treated == 1] - (-0.4 * with_dm$meanSlope[with_dm$treated == 1] * 26))) < 1e-12
  # zero effects give identical arms; the symptomatic gap is flat over time where the disease-modifying one grows with it
  st <- vcr_beta_logit_typical_study(par); vis <- c(0, 13, 26, 52, 78)
  c0 <- vcr_beta_logit_moments(par, st, vis)
  zero <- vcr_beta_logit_moments(par, st, vis, vcr_beta_logit_drug(list(begin = 0, end = 78, fraction = 0), vis))
  sym <- vcr_beta_logit_moments(par, st, vis, vcr_beta_logit_drug(list(begin = 0, end = 78, fraction = 0, emax = vcr_beta_logit_emax_from_points(-2.5, 24, 25, 1), et50 = 1), vis))
  dmc <- vcr_beta_logit_moments(par, st, vis, vcr_beta_logit_drug(list(begin = 0, end = 78, fraction = 0.3), vis))
  ratio_sym <- (sym$mean[5] - c0$mean[5]) / (sym$mean[3] - c0$mean[3]); ratio_dm <- (dmc$mean[5] - c0$mean[5]) / (dmc$mean[3] - c0$mean[3])
  shape_ok <- identical(zero, c0) && ratio_sym > 0.9 && ratio_sym < 1.15 && ratio_dm > 2.6 && ratio_dm < 3.2
  list(pass = placebo_ok && sym_ok && dm_ok && shape_ok,
       detail = sprintf("placebo: integral %.12f against -aucPlacebo %.4f, trough at %.4f weeks (closed form %.4f; 20.2 at the medians) of %.4f logit; symptomatic Emax on time on drug, nothing before the dose, halved at each %g-week half-life after it (exact); disease-modifying: 600 people drawn twice from one stream differ only in the treated arm, by 0.4 x their mean slope x 26 weeks held to week 52 (largest gap %.1e); zero effects give a treated curve identical to the control's; the treated-less-control gap at week 78 is %.2f times that at 26 for a symptomatic effect (an offset) and %.2f times for a 30%% disease-modifying one (grows with time)",
                        integral, set$medians[["aucPlacebo"]], trough$minimum, t_star, trough$objective, tr$halfLife,
                        max(abs(gap[with_dm$treated == 1] - (-0.4 * with_dm$meanSlope[with_dm$treated == 1] * 26))), ratio_sym, ratio_dm))
})

vcr_case("N101i", c("AC-04", "AC-28", "AC-31"), function() {
  # the null at the domain's floor: a Welch test of the change in a new study per trial, and an analysis of covariance in a typical study
  r_change <- .n101_run(.n101_sc(), 10109L, cores = 2L)
  r_ancova <- .n101_run(.n101_sc(analysis = list(kind = "ancova"), uncertainty = "typical_study"), 10110L, cores = 2L)
  t1 <- .n101_measure(r_change, "type_one_error"); t2 <- .n101_measure(r_ancova, "type_one_error")
  null_ok <- abs(t1$value - 0.05) <= 3.5 * t1$mcse && abs(t2$value - 0.05) <= 3.5 * t2$mcse && r_change$diagnostics$progression$trials == 20000L && r_ancova$diagnostics$progression$trials == 20000L
  # an alternative in a typical study: the simulated mean difference against the calculated one, on 1 and 2 cores
  alt <- .n101_sc(treatment = list(diseaseModifying = list(fraction = .n101_P(0.4))), uncertainty = "typical_study")
  a1 <- .n101_run(alt, 10111L, cores = 1L); a2 <- .n101_run(alt, 10111L, cores = 2L)
  sim <- .n101_measure(a1, "simulated_difference"); calc <- .n101_measure(a1, "expected_difference")
  same <- identical(vcr_output_hash(a1), vcr_output_hash(a2))
  # the curves of the result are the engine's quadrature itself
  set <- .n101_set(); par <- vcr_beta_logit_par(set$medians)
  ctl <- vcr_beta_logit_moments(par, vcr_beta_logit_typical_study(par), c(0, 13, 26, 52, 78))
  curve_ok <- identical(vapply(a1$diagnostics$progression$curves, function(cv) cv$control$mean$value, numeric(1)), unname(ctl$mean)) &&
    identical(a1$diagnostics$progression$curves[[5]]$control$mean$source, "calculated")
  # a cancel after the first batch keeps that batch
  cf <- tempfile("n101cancel"); on.exit(unlink(cf), add = TRUE)
  job <- vcr_test_json(vcr_test_job("patients.progression", alt, seed = 10111L))
  canceled <- vcr_job_patients_progression(job, cancel_file = cf, progress = function(done, want) if (done >= 500L) file.create(cf))
  kept <- canceled$diagnostics$progression$trials
  cancel_ok <- identical(canceled$status, "canceled") && kept == 500L && length(Filter(function(m) identical(m$name, "power") && is.finite(m$mcse), canceled$measures)) == 1L
  list(pass = null_ok && abs(sim$value - calc$value) <= 4 * sim$mcse && same && curve_ok && cancel_ok,
       detail = sprintf("no effect, 100 per arm, 20,000 trials: type I error %.4f (MCSE %.4f) by the change in a new study per trial, %.4f (MCSE %.4f) by covariance in a typical study (level 0.05); a 40%% disease-modifying effect in a typical study: simulated mean difference %.3f (MCSE %.3f) against the calculated %.3f among those still observed; one output hash on 1 and 2 cores (%s: %s); the result's curves are the quadrature to the bit; a cancel after the first batch returns '%s' with its %d trials and their power",
                        t1$value, t1$mcse, t2$value, t2$mcse, sim$value, sim$mcse, calc$value, if (same) "same" else "DIFFERENT", substr(vcr_output_hash(a1), 1, 12), canceled$status, kept))
})

vcr_case("N101j", c("AC-04", "AC-30"), function() {
  sc <- function(mode) .n101_sc(treatment = list(diseaseModifying = list(fraction = .n101_P(0.4))), uncertainty = mode)
  runs <- lapply(c(typical_study = "typical_study", new_study = "new_study", posterior_draws = "posterior_draws"), function(m) .n101_run(sc(m), 10112L, cores = 2L))
  spread <- vapply(runs, function(r) { m <- .n101_measure(r, "simulated_difference"); m$mcse * sqrt(r$diagnostics$progression$trialsAnalysed) }, numeric(1))
  rows <- vapply(runs, function(r) r$diagnostics$progression$posteriorRowsUsed, numeric(1))
  trials <- runs$posterior_draws$diagnostics$progression$trials
  expected_rows <- 1600 * (1 - (1 - 1 / 1600)^trials)
  # a study drawn per trial adds the between-study spread of the mean slope and of the precisions to the spread of the estimate; the SE of an SD
  # from 5,000 trials is about 1%, so 10% more is far outside chance
  ok <- spread[["new_study"]] > 1.1 * spread[["typical_study"]] && rows[["typical_study"]] == 0 && rows[["new_study"]] == 0 &&
    abs(rows[["posterior_draws"]] - expected_rows) < 40 && spread[["posterior_draws"]] > 0.95 * spread[["new_study"]]
  list(pass = ok, detail = sprintf("a 40%% disease-modifying effect, 100 per arm, 5,000 trials each: the SD of the estimate across trials is %.3f in a typical study, %.3f with a new study per trial, %.3f with a posterior draw and a study per trial; posterior rows used %d / %d / %d (expected %.0f of 1,600 for the last)",
                                   spread[["typical_study"]], spread[["new_study"]], spread[["posterior_draws"]], rows[["typical_study"]], rows[["new_study"]], rows[["posterior_draws"]], expected_rows))
})

vcr_case("N101k", c("AC-04", "AC-27"), function() {
  sym <- function(...) list(symptomatic = c(list(pointsAt = .n101_P(-2.5), atWeek = 24, referenceAdas = 25, et50Weeks = .n101_P(1)), list(...)))
  linear <- list(endpoint = list(type = "continuous"), design = list(nTreat = 50L, nControl = 50L), timeUnit = "months", visits = c(0, 6, 12),
                 model = list(family = "linear", slope = .n101_P(0.1), betweenPersonSd = .n101_P(0.05)), baseline = list(mean = .n101_P(3), sd = .n101_P(1)),
                 residualSd = .n101_P(0.5), treatment = list(slowing = .n101_P(0.3)), analysis = list(kind = "ancova"))
  cases <- list(
    months = list(utils::modifyList(.n101_sc(), list(timeUnit = "months")), "scenario_value_invalid@scenario.timeUnit"),
    slope = list(.n101_sc(analysis = list(kind = "slope")), "scenario_value_invalid@scenario.analysis.kind"),
    ancova_linear = list(linear, "scenario_value_invalid@scenario.analysis.kind"),
    residual = list(.n101_sc(residualSd = .n101_P(0.7)), "scenario_field_unknown@scenario.residualSd"),
    unknown_set = list(utils::modifyList(.n101_sc(), list(model = list(parameterSet = list(id = "ito-2010")))), "scenario_value_invalid@scenario.model.parameterSet.id"),
    no_washout = list(.n101_sc(treatment = c(sym(), list(doseEnd = 52))), "scenario_field_missing@scenario.treatment.symptomatic.washoutHalfLifeWeeks"),
    beyond_scale = list(.n101_sc(treatment = list(symptomatic = list(pointsAt = .n101_P(50), atWeek = 24, referenceAdas = 25, et50Weeks = .n101_P(1)))), "scenario_value_invalid@scenario.treatment.symptomatic.referenceAdas"),
    apoe = list(.n101_sc(population = list(apoe4 = .n101_P(c(0.5, 0.4, 0.2)))), "scenario_value_invalid@scenario.population.apoe4"),
    late_start = list(.n101_sc(visits = c(4, 13, 26)), "scenario_value_invalid@scenario.visits"),
    dose_order = list(.n101_sc(treatment = c(sym(washoutHalfLifeWeeks = .n101_P(1)), list(doseBegin = 30, doseEnd = 26))), "scenario_value_invalid@scenario.treatment.doseEnd"))
  got <- vapply(cases, function(x) .n101_issue(.n101_run(x[[1]], 10113L)), character(1))
  want <- vapply(cases, function(x) x[[2]], character(1))
  old_label <- .n101_issue(.n101_run(.n101_sc(), 10113L, label = "1.0.0"))
  # a parameter file that is not the pinned one is refused before anything runs
  root <- tempfile("n101root"); dir.create(file.path(root, "R", "models"), recursive = TRUE); on.exit(unlink(root, recursive = TRUE), add = TRUE)
  file.copy(file.path(vcr_engine_root(), "R", "domain-snapshot.json"), file.path(root, "R", "domain-snapshot.json"))
  bytes <- readLines(file.path(vcr_engine_root(), "R", "models", "ad_adascog11_camd_adsim3.json"), warn = FALSE)
  writeLines(sub("posterior released with adsim 3.0", "posterior released with adsim 3.1", bytes, fixed = TRUE), file.path(root, "R", "models", "ad_adascog11_camd_adsim3.json"))
  old_env <- Sys.getenv("VCR_ENGINE_ROOT"); cached <- .vcr_bl_cache[["camd-adas-cog-11@adsim-3.0"]]
  Sys.setenv(VCR_ENGINE_ROOT = root); rm(list = "camd-adas-cog-11@adsim-3.0", envir = .vcr_bl_cache)
  tampered <- tryCatch({ vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0"); NA_character_ }, vcr_refusal = function(e) sprintf("%s@%s", e$issue$code, e$issue$field))
  Sys.setenv(VCR_ENGINE_ROOT = old_env); assign("camd-adas-cog-11@adsim-3.0", cached, envir = .vcr_bl_cache)
  ok <- identical(unname(got), unname(want)) && identical(old_label, "method_version_mismatch@methodVersion") && identical(tampered, "input_hash_mismatch@scenario.model.parameterSet")
  list(pass = ok, detail = sprintf("refused by name: %s; a beta_logit job labelled 1.0.0: %s; a parameter file one character off the pinned one: %s",
                                   paste(sprintf("%s -> %s", names(got), got), collapse = ", "), old_label, tampered))
})

vcr_case("N101l", c("AC-31", "AC-04"), function() {
  # recorded with the code of the release before this one (patients.progression 1.0.0), seed 10101, the scenarios of N99's `.n99_sc` written out
  p <- function(v, basis = "literature") list(value = v, basis = basis, citation = "case")
  models <- list(linear = list(family = "linear", slope = p(0.12), betweenPersonSd = p(0.08)), exponential = list(family = "exponential", slope = p(0.10), betweenPersonSd = p(0.05), acceleration = p(0.04)),
                 logistic = list(family = "logistic", amplitude = p(6), betweenPersonSd = p(1.5), midpoint = p(14), steepness = p(0.2)), emax = list(family = "emax", amplitude = p(5), betweenPersonSd = p(1.2), halfTime = p(12)))
  sc <- function(family, slowing, n, analysis = list(kind = "change", visit = 18)) {
    a <- function(v, basis = "assumed") list(value = v, basis = basis)
    list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), timeUnit = "months", visits = c(0, 6, 12, 18),
         model = models[[family]], baseline = list(mean = a(3, "data"), sd = a(1.2, "data")), residualSd = a(0.7, "literature"),
         correlation = a(0.3), treatment = list(slowing = a(slowing)), analysis = analysis)
  }
  recorded <- list(
    linear = list(sc("linear", 0.25, 60L), "aa19d54aae7038ba4ca8b61e9c9083e364a3f563cd12c3ceedf9fc411f75cc8b"),
    emax_slope = list(sc("emax", 0.3, 60L, list(kind = "slope")), "063353b8c18e782ab62157bc7d927d1f4dcd189f17336e70c4233ef8d29a5662"),
    exponential = list(sc("exponential", 0.2, 60L, list(kind = "change", visit = 12)), "0d178ed58135347ca582a42165ac5980219a98a9a65702459b558fe825035cb4"),
    logistic = list(sc("logistic", 0, 40L), "64030f5ad2e35d32b3221bf391d6b725455d413b9cdec4d476fcfcf7c09d7496"))
  got <- character(0)
  for (key in names(recorded)) for (label in c("1.0.0", "1.1.0")) got[paste(key, label)] <- vcr_output_hash(.n101_run(recorded[[key]][[1]], 10101L, label = label))
  want <- unlist(lapply(recorded, function(x) rep(x[[2]], 2L)), use.names = FALSE)
  list(pass = identical(unname(got), want),
       detail = sprintf("the linear, Emax (slope), exponential and logistic (no slowing) scenarios under the 1.0.0 and the 1.1.0 labels: %d of 8 output hashes equal the 1.0.0 release's (%s)",
                        sum(unname(got) == want), paste(sprintf("%s %s", names(got), substr(got, 1, 8)), collapse = ", ")))
})
