# N190 — the control arm's reading in the Alzheimer trial model (plan R27, 2026-11-09)
#
# `diagnostics.progression.controlReading`: what the simulated trials say the control arm's mean change at the analysis visit is (its mean over the trials, its
# spread, the 2.5 / 50 / 97.5 percentiles that are the predictive interval of an observed arm mean of the same size), as an MMRM's least-squares mean or the
# observed mean of the people still in. Every number held to something outside the code that makes it.
#
#   a  the percentiles and their Monte Carlo errors on a known distribution: normal draws, the percentile against qnorm, the error against the closed
#      form sqrt(p (1 - p) / n) / dnorm(q)
#   b  the engine's reading with nobody leaving equals the calculated expected control change of the typical study, within its Monte Carlo error
#   c  the least-squares mean of the control arm: the factored fit and the gls fit against the `mmrm` package's coefficients (the visit's intercept plus its baseline
#      coefficient at the mean baseline), and on complete data against an ordinary regression of the last visit
#   d  the same seed gives the same reading on one core and on two, bit for bit
#   e  the reading names its estimator; an analysis other than the MMRM reads the observed mean, and the completers' mean is reported beside the MMRM's

.n190_P <- function(v, basis = "assumed") list(value = v, basis = basis)
.n190_sc <- function(kind = "change", unc = "typical_study", dropout = "none", n = 150L, visits = c(0, 13, 26, 52, 78)) {
  list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), timeUnit = "weeks", visits = visits,
       model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = unc),
       dropoutModel = dropout, analysis = list(kind = kind),
       treatment = list(symptomatic = list(pointsAt = .n190_P(-0.5), atWeek = 26, referenceAdas = 25, et50Weeks = .n190_P(8))))
}
.n190_run <- function(sc, seed, cores = 2L, replicates = 600L) vcr_test_run(vcr_test_job("patients.progression", sc, seed = seed, replicates = replicates, cores = cores))
.n190_m <- function(x) x$value

vcr_case("N190a", c("AC-04"), function() {
  set.seed(190); x <- stats::rnorm(40000L, 7.5, 0.8)
  v <- cbind(ctlMean = x, ctlLs = x)
  r <- .vcr_control_reading(v, "points", 78, "mmrm")
  qs <- c(lower = 0.025, median = 0.5, upper = 0.975)
  err <- vapply(names(qs), function(k) abs(r[[k]]$value - stats::qnorm(qs[[k]], 7.5, 0.8)), numeric(1))
  se_true <- vapply(qs, function(p) sqrt(p * (1 - p) / length(x)) / (stats::dnorm(stats::qnorm(p)) / 0.8), numeric(1))
  se_got <- vapply(names(qs), function(k) r[[k]]$mcse, numeric(1))
  list(pass = all(err < 4 * se_got) && all(abs(se_got / se_true - 1) < 0.15) && identical(r$reading, "mmrm_ls_mean") && abs(r$mean$value - 7.5) < 4 * r$mean$mcse && abs(r$sd$value / 0.8 - 1) < 0.02,
       detail = sprintf("40000 normal draws (7.5, 0.8): the 2.5/50/97.5 percentiles %s against %s; their Monte Carlo errors %s against the closed form %s; mean %.3f and SD %.3f",
                        paste(sprintf("%.3f", vapply(names(qs), function(k) r[[k]]$value, numeric(1))), collapse = "/"), paste(sprintf("%.3f", stats::qnorm(qs, 7.5, 0.8)), collapse = "/"),
                        paste(sprintf("%.4f", se_got), collapse = "/"), paste(sprintf("%.4f", se_true), collapse = "/"), r$mean$value, r$sd$value))
})

vcr_case("N190b", c("AC-04", "AC-31"), function() {
  res <- .n190_run(.n190_sc(), 19001L, replicates = 1500L)
  cr <- res$diagnostics$progression$controlReading
  calc <- vcr_measure_value(res, "expected_control_change")
  z <- (cr$mean$value - calc) / cr$mean$mcse
  list(pass = identical(cr$reading, "observed_mean") && abs(z) < 3.5 && cr$trials == res$diagnostics$progression$trials && cr$lower$value < cr$median$value && cr$median$value < cr$upper$value && isTRUE(cr$mean$simulated),
       detail = sprintf("typical study, nobody leaves, %d trials of 150 per arm: the simulated control change %.4f (Monte Carlo SE %.4f) against the calculated expected control change %.4f (z %.2f); the 95%% interval %.2f to %.2f",
                        cr$trials, cr$mean$value, cr$mean$mcse, calc, z, cr$lower$value, cr$upper$value))
})

vcr_case("N190c", c("AC-04", "AC-28"), function() {
  d <- .n111_data(seed = 190L, n = 120L); J <- d$J; nm <- sprintf("visit%d", J)
  fast <- vcr_mmrm_fit(d$chg, d$mask, d$arm, d$base, "factored"); mm <- .n111_mmrm(d, FALSE); co <- stats::coef(mm)
  ls_fast <- vcr_mmrm_ls_control(fast, d$base); ls_mm <- unname(co[nm] + co[paste0(nm, ":base")] * mean(d$base))
  nd <- .n111_data(seed = 191L, n = 100L, monotone = FALSE)
  gl <- vcr_mmrm_fit(nd$chg, nd$mask, nd$arm, nd$base, "auto"); mm2 <- .n111_mmrm(nd, TRUE); co2 <- stats::coef(mm2)
  ls_gl <- vcr_mmrm_ls_control(gl, nd$base); ls_mm2 <- unname(co2[nm] + co2[paste0(nm, ":base")] * mean(nd$base))
  full <- list(chg = d$chg, mask = matrix(TRUE, d$n, J), arm = d$arm, base = d$base)
  fit_full <- vcr_mmrm_fit(full$chg, full$mask, full$arm, full$base, "factored")
  ols <- stats::lm(y ~ arm + base, data = data.frame(y = d$chg[, J], arm = d$arm, base = d$base))
  ls_ols <- unname(stats::predict(ols, data.frame(arm = 0, base = mean(d$base))))
  ls_full <- vcr_mmrm_ls_control(fit_full, d$base)
  list(pass = identical(fast$path, "factored") && identical(gl$path, "gls") && abs(ls_fast - ls_mm) < 5e-4 && abs(ls_gl - ls_mm2) < 5e-4 && abs(ls_full - ls_ols) < 1e-8,
       detail = sprintf("120 people, monotone missing: the factored fit's control least-squares mean %.5f against mmrm (ML) %.5f; 100 people, values missing between observed ones (gls path): %.5f against mmrm (REML) %.5f; complete data: %.8f against an ordinary regression of the last visit %.8f",
                        ls_fast, ls_mm, ls_gl, ls_mm2, ls_full, ls_ols))
})

vcr_case("N190d", c("AC-04", "AC-31"), function() {
  sc <- .n190_sc(kind = "mmrm", unc = "posterior_draws", dropout = "parameter_set", n = 60L)
  one <- .n190_run(sc, 19004L, cores = 1L, replicates = 400L); two <- .n190_run(sc, 19004L, cores = 2L, replicates = 400L)
  a <- one$diagnostics$progression$controlReading; b <- two$diagnostics$progression$controlReading
  list(pass = identical(a, b) && is.finite(a$mean$value) && identical(a$reading, "mmrm_ls_mean"),
       detail = sprintf("posterior draws, MMRM, 400 trials of 60 per arm, the same seed on one core and on two: readings identical (%s), control least-squares mean %.4f (SE %.4f)", identical(a, b), a$mean$value, a$mean$mcse))
})

vcr_case("N190e", c("AC-04"), function() {
  mm <- .n190_run(.n190_sc(kind = "mmrm", unc = "typical_study", dropout = "parameter_set", n = 120L), 19005L, replicates = 500L)$diagnostics$progression$controlReading
  ch <- .n190_run(.n190_sc(kind = "change", unc = "typical_study", dropout = "parameter_set", n = 120L), 19005L, replicates = 500L)$diagnostics$progression$controlReading
  list(pass = identical(mm$reading, "mmrm_ls_mean") && identical(ch$reading, "observed_mean") && !is.null(mm$completers) && is.finite(mm$completers$value) && !is.null(ch$completers),
       detail = sprintf("with the parameter set's dropout, 500 trials of 120 per arm: an MMRM reads the least-squares mean (%.3f) and reports the completers' observed mean (%.3f) beside it; the change analysis reads the observed mean (%.3f)",
                        mm$mean$value, mm$completers$value, ch$mean$value))
})
