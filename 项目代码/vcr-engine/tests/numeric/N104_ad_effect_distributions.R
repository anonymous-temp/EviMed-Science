# N104 — an effect stated as a distribution, drawn once per simulated trial, in the beta_logit family of patients.progression 1.2.0 (plan R25, 2026-11-09)
#
# The result of such a run is an assurance (the probability of a significant benefit averaged over what the effect might be), and it is held to what is
# outside the method: the fixed-effect power of the same test, an independent quadrature of the assurance integral over that very power, the
# distribution functions and moments of the families written with base R, and the model's own range.
#
#   a  a degenerate distribution reproduces the fixed-effect power, the Monte Carlo error and the simulated difference exactly at one seed, whether it is
#      the fixed family or a normal with an SD no draw can feel (the effect is drawn on a stream of its own)
#   b  a normal prior matches an independent Monte Carlo of the assurance integral (Gauss-Hermite quadrature of the fixed-effect power over the same
#      prior, each node simulated on its own) within the combined Monte Carlo error
#   c  a prior that reaches beyond what the model can represent: the share of its mass inside, the share of draws redrawn and the mean of what was
#      used are the truncated normal's closed forms, and a prior with no mass inside is refused
#   d  every family draws what it says: the mean of the used disease-modifying shares and symptomatic effects against the family's own mean
#   e  the result names the source and the tier of the distribution, and says what an assurance is (and is not)
#   f  what is refused by name: no source, an unknown tier, a missing parameter, an effect that is both a number and a distribution

.n104_P <- function(v, basis = "assumed") list(value = v, basis = basis)
.n104_dist <- function(family, parameters, tier = "A", source = list(kind = "literature", citation = "case reference")) list(distribution = list(family = family, parameters = parameters, source = source, tier = tier))
.n104_sc <- function(pts = NULL, dm = NULL, n = 40L, visits = c(0, 13, 26, 52), uncertainty = "typical_study") {
  tr <- list()
  if (!is.null(pts)) tr$symptomatic <- list(pointsAt = pts, atWeek = 26, referenceAdas = 25, et50Weeks = .n104_P(8))
  if (!is.null(dm)) tr$diseaseModifying <- list(fraction = dm)
  list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), timeUnit = "weeks", visits = visits,
       model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = uncertainty), treatment = tr)
}
.n104_run <- function(sc, seed, replicates = NULL, cores = 1L) vcr_test_run(vcr_test_job("patients.progression", sc, seed = seed, replicates = replicates, cores = cores))
.n104_first <- function(r) r$measures[[1]]
.n104_issue <- function(r) { i <- c(r$issues %||% list(), r$diagnostics$issues %||% list()); if (length(i)) sprintf("%s@%s", i[[1]]$code, i[[1]]$field) else NA_character_ }
.n104_diff <- function(r) Filter(function(m) identical(m$name, "simulated_difference"), r$measures)[[1]]

vcr_case("N104a", c("AC-04", "AC-28"), function() {
  fixed <- .n104_run(.n104_sc(.n104_P(-2.5)), 10401L, 1500L)
  as_fixed <- .n104_run(.n104_sc(.n104_dist("fixed", list(value = -2.5))), 10401L, 1500L)
  tiny <- .n104_run(.n104_sc(.n104_dist("normal", list(mean = -2.5, sd = 1e-300))), 10401L, 1500L)
  # the same for the disease-modifying share
  f_dm <- .n104_run(.n104_sc(dm = .n104_P(0.3)), 10402L, 1500L)
  d_dm <- .n104_run(.n104_sc(dm = .n104_dist("normal", list(mean = 0.3, sd = 1e-300))), 10402L, 1500L)
  same <- function(a, b, name) identical(.n104_first(a)$value, .n104_first(b)$value) && identical(.n104_first(a)$mcse, .n104_first(b)$mcse) &&
    identical(.n104_diff(a)$value, .n104_diff(b)$value) && identical(.n104_first(b)$name, name)
  ok <- same(fixed, as_fixed, "power") && same(fixed, tiny, "assurance") && same(f_dm, d_dm, "assurance") &&
    identical(.n104_first(fixed)$name, "power") && identical(.n104_first(tiny)$name, "assurance")
  list(pass = ok, detail = sprintf("40 per arm, 2.5 points at week 26, 1,500 trials, one seed: the fixed-effect power %.6f (MCSE %.6f, difference %.6f); a `fixed` distribution gives it to the bit (named power), a normal with SD 1e-300 gives %.6f (named assurance), a normal with SD 1e-300 for the 30%% disease-modifying share gives the fixed run's %.6f",
                                   .n104_first(fixed)$value, .n104_first(fixed)$mcse, .n104_diff(fixed)$value, .n104_first(tiny)$value, .n104_first(f_dm)$value))
})

vcr_case("N104b", c("AC-04", "AC-28"), function() {
  mu <- -2; sdv <- 1.5
  # the independent computation: Gauss-Hermite quadrature of the power at a fixed effect over the same normal prior, each node a run of its own (2,000 trials)
  gh <- .vcr_gauss_hermite(9)
  nodes <- mu + sqrt(2) * sdv * gh$nodes; w <- gh$weights / sqrt(pi)
  runs <- lapply(seq_along(nodes), function(k) .n104_run(.n104_sc(.n104_P(nodes[k])), 10410L + k, 2000L, cores = 2L))
  pw <- vapply(runs, function(r) .n104_first(r)$value, numeric(1)); se <- vapply(runs, function(r) .n104_first(r)$mcse, numeric(1))
  quad <- sum(w * pw); quad_se <- sqrt(sum(w^2 * se^2))
  a <- .n104_run(.n104_sc(.n104_dist("normal", list(mean = mu, sd = sdv))), 10420L, 5000L, cores = 2L)
  m <- .n104_first(a)
  tol <- 4 * sqrt(m$mcse^2 + quad_se^2)
  # the assurance of a spread prior is not the power at its mean, and the prior's own draws are what it says
  at_mean <- .n104_first(.n104_run(.n104_sc(.n104_P(mu)), 10421L, 5000L))$value
  rep <- a$diagnostics$progression$effectDistributions[[1]]
  moments_ok <- abs(rep$drawMean - mu) <= 4 * sdv / sqrt(rep$draws) && abs(rep$drawSd - sdv) <= 4 * sdv / sqrt(2 * rep$draws)
  list(pass = identical(m$name, "assurance") && abs(m$value - quad) <= tol && moments_ok && rep$draws == 5000L,
       detail = sprintf("effect ~ Normal(%g, %g) points at week 26, 40 per arm: assurance %.4f (MCSE %.4f) against the 9-node quadrature of nine fixed-effect powers %.4f (error %.4f), tolerance %.4f; the power at the prior's mean alone is %.4f; the %d draws had mean %.3f and SD %.3f",
                        mu, sdv, m$value, m$mcse, quad, quad_se, tol, at_mean, rep$draws, rep$drawMean, rep$drawSd))
})

vcr_case("N104c", c("AC-04", "AC-27", "AC-28"), function() {
  # Normal(-2, 30) points for a reference score of 25: the model represents a change from -25 to 45 (the score stays inside 0 to 70)
  mu <- -2; s <- 30; lo <- -25; hi <- 45
  mass <- stats::pnorm((hi - mu) / s) - stats::pnorm((lo - mu) / s)
  a <- (lo - mu) / s; b <- (hi - mu) / s
  tmean <- mu + s * (stats::dnorm(a) - stats::dnorm(b)) / mass
  tsd <- s * sqrt(1 + (a * stats::dnorm(a) - b * stats::dnorm(b)) / mass - ((stats::dnorm(a) - stats::dnorm(b)) / mass)^2)
  r <- .n104_run(.n104_sc(.n104_dist("normal", list(mean = mu, sd = s))), 10430L, 6000L)
  rep <- r$diagnostics$progression$effectDistributions[[1]]
  # redrawn share: tries are geometric with success probability `mass`, so 1 - trials / tries estimates 1 - mass; its error from the delta method
  trials <- rep$draws; share_se <- mass * sqrt((1 - mass) / trials)
  ok <- identical(r$status, "succeeded") && abs(rep$priorMassRepresentable - mass) < 1e-9 && abs(rep$redrawnShare - (1 - mass)) <= 4 * share_se &&
    abs(rep$drawMean - tmean) <= 4 * tsd / sqrt(trials) && abs(rep$drawSd - tsd) <= 4 * tsd / sqrt(2 * trials) &&
    any(grepl("redrawn", unlist(r$diagnostics$progression$limits), fixed = TRUE))
  none <- .n104_issue(.n104_run(.n104_sc(.n104_dist("normal", list(mean = 500, sd = 1))), 10431L, 100L))
  none_dm <- .n104_issue(.n104_run(.n104_sc(dm = .n104_dist("normal", list(mean = 3, sd = 0.2))), 10432L, 100L))
  list(pass = ok && identical(none, "scenario_value_invalid@scenario.treatment.symptomatic.pointsAt.distribution") && identical(none_dm, "scenario_value_invalid@scenario.treatment.diseaseModifying.fraction.distribution"),
       detail = sprintf("Normal(-2, 30) points, representable from -25 to 45: mass inside %.5f (closed form %.5f), %.4f of the draws redrawn (1 - mass = %.4f), the used draws have mean %.3f (truncated normal %.3f) and SD %.3f (%.3f); a prior with no mass inside is refused (%s, %s)",
                        rep$priorMassRepresentable, mass, rep$redrawnShare, 1 - mass, rep$drawMean, tmean, rep$drawSd, tsd, none, none_dm))
})

vcr_case("N104d", c("AC-04", "AC-28"), function() {
  pick <- function(sc, seed, key) { r <- .n104_run(sc, seed, 3000L); list(r = r, rep = Filter(function(x) identical(x$key, key), r$diagnostics$progression$effectDistributions)[[1]]) }
  families <- list(
    list("beta", list(shape1 = 3, shape2 = 9), 3 / 12, sqrt(3 * 9 / (12^2 * 13))),
    list("uniform", list(min = 0.1, max = 0.5), 0.3, 0.4 / sqrt(12)),
    list("truncated_normal", list(mean = 0.3, sd = 0.2, lower = 0.1, upper = 0.5), NA, NA),
    list("lognormal", list(meanlog = log(0.2), sdlog = 0.3), exp(log(0.2) + 0.3^2 / 2), sqrt((exp(0.09) - 1) * exp(2 * log(0.2) + 0.09))),
    list("empirical_draws", list(values = c(0.1, 0.2, 0.2, 0.4, 0.5)), 0.28, sqrt(mean((c(0.1, 0.2, 0.2, 0.4, 0.5) - 0.28)^2))))
  rows <- character(0); ok <- TRUE
  for (f in families) {
    out <- pick(.n104_sc(dm = .n104_dist(f[[1]], f[[2]])), 10440L, "treatment.diseaseModifying.fraction")
    rep <- out$rep
    want <- if (identical(f[[1]], "truncated_normal")) {
      p <- f[[2]]; a <- (p$lower - p$mean) / p$sd; b <- (p$upper - p$mean) / p$sd; z <- stats::pnorm(b) - stats::pnorm(a)
      c(p$mean + p$sd * (stats::dnorm(a) - stats::dnorm(b)) / z, p$sd * sqrt(1 + (a * stats::dnorm(a) - b * stats::dnorm(b)) / z - ((stats::dnorm(a) - stats::dnorm(b)) / z)^2))
    } else c(f[[3]], f[[4]])
    this <- identical(out$r$status, "succeeded") && abs(rep$drawMean - want[1]) <= 4 * want[2] / sqrt(rep$draws) && abs(rep$drawSd - want[2]) <= 4 * want[2] / sqrt(2 * rep$draws) && identical(rep$family, f[[1]])
    ok <- ok && this
    rows <- c(rows, sprintf("%s mean %.4f (%.4f) SD %.4f (%.4f)", f[[1]], rep$drawMean, want[1], rep$drawSd, want[2]))
  }
  list(pass = ok, detail = paste0("disease-modifying share drawn once per trial over 5,000 trials, used values against each family's closed-form mean and SD (4 standard errors): ", paste(rows, collapse = "; ")))
})

vcr_case("N104e", c("AC-04", "AC-31"), function() {
  src <- list(kind = "model_result", objectRef = "res_chain_case@3", note = "a mechanism chain's draws")
  r <- .n104_run(.n104_sc(dm = .n104_dist("beta", list(shape1 = 2, shape2 = 8), tier = "B", source = src)), 10450L, 500L)
  rep <- r$diagnostics$progression$effectDistributions[[1]]
  given <- Filter(function(g) identical(g$key, "treatment.diseaseModifying.fraction"), r$diagnostics$progression$given)[[1]]
  limits <- unlist(r$diagnostics$progression$limits)
  ok <- identical(rep$tier, "B") && identical(rep$source$kind, "model_result") && identical(rep$source$objectRef, "res_chain_case@3") && identical(given$distribution$tier, "B") &&
    any(grepl("null or an irrelevant effect included", limits, fixed = TRUE)) && any(grepl("More simulated trials shrink only the Monte Carlo error", limits, fixed = TRUE)) &&
    identical(.n104_first(r)$name, "assurance") && identical(r$diagnostics$progression$isNull, FALSE) && length(r$diagnostics$progression$effectDistributions) == 1L
  list(pass = ok, detail = sprintf("a Beta(2, 8) disease-modifying share from a mechanism chain (tier %s, source %s %s): the result is an %s, carries the tier and the source in `given` and in the effect report, and says that it counts every significant benefit including a null or irrelevant effect and that more trials shrink only the Monte Carlo error",
                                   rep$tier, rep$source$kind, rep$source$objectRef, .n104_first(r)$name))
})

vcr_case("N104f", c("AC-04", "AC-27"), function() {
  nosrc <- .n104_dist("normal", list(mean = -2, sd = 1)); nosrc$distribution$source <- NULL
  notier <- .n104_dist("normal", list(mean = -2, sd = 1), tier = "Z")
  nopar <- .n104_dist("normal", list(mean = -2))
  both <- c(.n104_P(-2), .n104_dist("normal", list(mean = -2, sd = 1)))
  nocite <- .n104_dist("normal", list(mean = -2, sd = 1), source = list(kind = "stated"))
  zero_sd <- .n104_dist("normal", list(mean = -2, sd = 0))
  cases <- list(no_source = nosrc, no_tier = notier, no_sd = nopar, number_and_distribution = both, nothing_named = nocite, zero_sd = zero_sd)
  got <- vapply(cases, function(x) .n104_issue(.n104_run(.n104_sc(x), 10460L, 100L)), character(1))
  # a distribution needs the 1.2.0 release: a job labelled 1.1.0 is refused as a whole
  old <- .n104_issue(vcr_test_run(vcr_test_job("patients.progression", .n104_sc(.n104_dist("normal", list(mean = -2, sd = 1))), seed = 1L, replicates = 100L, extra = list(methodVersion = "1.1.0"))))
  ok <- all(!is.na(got)) && identical(old, "method_version_mismatch@methodVersion") && all(grepl("^(scenario_field_missing|scenario_value_invalid|scenario_field_unknown|scenario_value_conflict|scenario_choice_invalid)@", got))
  list(pass = ok, detail = sprintf("refused before anything runs: %s; labelled 1.1.0: %s", paste(sprintf("%s -> %s", names(got), got), collapse = "; "), old))
})
