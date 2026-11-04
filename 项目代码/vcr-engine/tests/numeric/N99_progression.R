# N99 — a population-level disease-progression simulator (algorithm round P4, 2026-11-03): patients.progression
#
#   a  the unit shapes against their own derivatives integrated numerically, and the moments of simulated people (200,000 of them) against the closed form
#      for every family: mean, SD, the correlation between baseline and the last visit, in the control and in the slowed arm
#   b  power: the simulation against the closed form of the same Welch test (noncentral t) for the change and for the slope, against stats::power.t.test
#      when the two arms have the same variance, and the type I error against its nominal level
#   c  the treatment slows the clock: the treated curve at t is the control curve at (1 - slowing) t, a linear slope is cut by that share
#   d  the job: bit-identical on 1 and 2 cores, the domain's replicate floors whatever is asked, a cancel keeps nothing half-made, the sources travel
#   e  what is refused, by name, and a value with no source
#
# Jamalian et al. (2023)'s published numbers are NOT matched here: their model is a logit-domain progression with a random onset time and
# log-normal individual rates, none of which is one of these four families, and the notes carry no parameter table of theirs that was read and checked.
# Their one number this simulator uses is a label: baseline predicted an individual's change with R squared 0.16, which is why the result says "population level".

.n99_model <- function(family, ...) {
  p <- function(v, basis = "literature") list(value = v, basis = basis, citation = "case")
  switch(family,
    linear = list(family = "linear", slope = p(0.12), betweenPersonSd = p(0.08)),
    exponential = list(family = "exponential", slope = p(0.10), betweenPersonSd = p(0.05), acceleration = p(0.04)),
    logistic = list(family = "logistic", amplitude = p(6), betweenPersonSd = p(1.5), midpoint = p(14), steepness = p(0.2)),
    emax = list(family = "emax", amplitude = p(5), betweenPersonSd = p(1.2), halfTime = p(12)))
}
.n99_sc <- function(family = "linear", slowing = 0.25, n = 150L, visits = c(0, 6, 12, 18), analysis = list(kind = "change", visit = 18), residual = 0.7, model = NULL) {
  p <- function(v, basis = "assumed") list(value = v, basis = basis)
  list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), timeUnit = "months", visits = visits,
       model = model %||% .n99_model(family), baseline = list(mean = p(3, "data"), sd = p(1.2, "data")), residualSd = p(residual, "literature"),
       correlation = p(0.3), treatment = list(slowing = p(slowing)), analysis = analysis)
}
.n99_run <- function(sc, seed = 9901L, cores = 1L, replicates = NULL, dir = NULL)
  vcr_test_run(vcr_test_job("patients.progression", sc, seed = seed, cores = cores, replicates = replicates), output_dir = dir)

vcr_case("N99a", c("AC-04"), function() {
  # the unit shape is the integral of its own rate: linear 1, exponential exp(k t), logistic A k S (1 - S) (per unit amplitude), Emax T50 / (T50 + t)^2
  t_grid <- c(3, 9, 20)
  shape_err <- 0
  m <- c(rate = 0.04, midpoint = 14, halfTime = 12)
  for (fam in c("linear", "exponential", "logistic", "emax")) {
    mm <- if (fam == "logistic") c(rate = 0.2, midpoint = 14) else m
    rate_of <- switch(fam, linear = function(t) rep(1, length(t)), exponential = function(t) exp(mm[["rate"]] * t),
                      logistic = function(t) mm[["rate"]] * stats::plogis(mm[["rate"]] * (t - mm[["midpoint"]])) * (1 - stats::plogis(mm[["rate"]] * (t - mm[["midpoint"]]))),
                      emax = function(t) mm[["halfTime"]] / (mm[["halfTime"]] + t)^2)
    for (t in t_grid) shape_err <- max(shape_err, abs(vcr_progression_shape(fam, t, mm) - stats::integrate(rate_of, 0, t, rel.tol = 1e-12)$value))
  }
  # the moments of 200,000 simulated people of each arm against the closed form
  worst <- 0; lines <- character(0)
  visits <- c(0, 6, 12, 24); n <- 200000L
  for (fam in c("linear", "exponential", "logistic", "emax")) for (scale in c(1, 0.7)) {
    set.seed(9911L + nchar(fam) + 10L * scale, kind = VCR_RNG_KIND)
    sc <- .n99_sc(fam); par <- .vcr_progression_params(sc$model)
    y <- vcr_progression_simulate(par, 3, 1.2, 0.7, 0.3, visits, n, scale)
    mo <- vcr_progression_moments(par, 3, 1.2, 0.7, 0.3, visits, scale)
    z_mean <- abs(colMeans(y) - mo$mean) / (mo$sd / sqrt(n)); z_sd <- abs(apply(y, 2, stats::sd) - mo$sd) / (mo$sd / sqrt(2 * n))
    cor_hand <- mo$covariance[1, 4] / (mo$sd[1] * mo$sd[4]); z_cor <- abs(stats::cor(y[, 1], y[, 4]) - cor_hand) / ((1 - cor_hand^2) / sqrt(n))
    worst <- max(worst, z_mean, z_sd, z_cor)
    lines <- c(lines, sprintf("%s x%.1f: z %.1f", fam, scale, max(z_mean, z_sd, z_cor)))
  }
  list(pass = shape_err < 1e-9 && worst < 4.5,
       detail = sprintf("the four unit shapes equal the integral of their own rate (largest gap %.1e); 200,000 simulated people per family and arm (scale 1 and 0.7), means, SDs at four visits and the baseline-to-last-visit correlation against the closed form: the largest of the distances in standard errors is %.2f (%s)",
                        shape_err, worst, paste(lines, collapse = "; ")))
})

vcr_case("N99b", c("AC-04", "AC-30"), function() {
  # (1) the change and the slope analyses of the linear and the Emax families: the simulated power against the closed form of the same test, and
  # the type I error against its level; (2) with no between-person spread the arms have the same variance and stats::power.t.test is the reference
  within <- function(m, want, extra = 0.012) abs(m$value - want) <= 3.5 * m$mcse + extra
  rows <- list(); ok <- TRUE
  for (spec in list(list("linear", list(kind = "change", visit = 18)), list("emax", list(kind = "slope")), list("exponential", list(kind = "change", visit = 12)))) {
    r <- .n99_run(.n99_sc(spec[[1]], 0.3, n = 120L, analysis = spec[[2]]), seed = 9921L)
    m <- Filter(function(x) x$name == "power", r$measures)[[1]]; want <- r$diagnostics$progression$approximation$power
    ok <- ok && within(m, want); rows[[length(rows) + 1L]] <- sprintf("%s/%s: simulated %.4f (MCSE %.4f), closed form %.4f", spec[[1]], spec[[2]]$kind, m$value, m$mcse, want)
  }
  r0 <- .n99_run(.n99_sc("linear", 0, n = 120L), seed = 9922L); t1 <- Filter(function(x) x$name == "type_one_error", r0$measures)[[1]]
  # equal variances: no spread of the slope, the change is a difference of two residuals in both arms
  no_spread <- .n99_sc("linear", 0.4, n = 60L, model = list(family = "linear", slope = list(value = 0.2, basis = "assumed"), betweenPersonSd = list(value = 0, basis = "assumed")), residual = 1.5)
  r_eq <- .n99_run(no_spread, seed = 9923L); m_eq <- Filter(function(x) x$name == "power", r_eq$measures)[[1]]
  delta <- 0.2 * 18 * 0.4; sd_change <- sqrt(2) * 1.5
  pt <- stats::power.t.test(n = 60, delta = delta, sd = sd_change, sig.level = 0.05, type = "two.sample", strict = TRUE)$power
  list(pass = ok && within(t1, 0.05, 0) && within(m_eq, pt) && r0$diagnostics$progression$trials >= 20000L && r_eq$diagnostics$progression$trials >= 5000L,
       detail = sprintf("120 per arm, 30%% slowing: %s; type I error with no slowing %.4f (MCSE %.4f, level 0.05, %d trials); equal variances (60 per arm, no slope spread, residual SD 1.5, a 0.2 x 18 x 0.4 difference): simulated power %.4f (MCSE %.4f) against stats::power.t.test %.4f",
                        paste(unlist(rows), collapse = "; "), t1$value, t1$mcse, r0$diagnostics$progression$trials, m_eq$value, m_eq$mcse, pt))
})

vcr_case("N99c", c("AC-04"), function() {
  # the treatment slows the clock: the treated mean at t is the control mean at (1 - slowing) t; for a linear family the slope is cut by that share
  sc <- .n99_sc("emax", 0.4); r <- .n99_run(sc, seed = 9931L)
  cv <- r$diagnostics$progression$curves
  ctl_at <- function(t) 3 + 5 * t / (12 + t)
  gaps <- vapply(cv, function(x) abs(x$treated$mean$value - ctl_at(0.6 * x$visit)), numeric(1))
  lin <- .n99_run(.n99_sc("linear", 0.25), seed = 9932L)$diagnostics$progression$curves
  slope_ctl <- (lin[[4]]$control$mean$value - lin[[1]]$control$mean$value) / 18; slope_trt <- (lin[[4]]$treated$mean$value - lin[[1]]$treated$mean$value) / 18
  u18 <- 18 / (12 + 18)   # the emax unit shape at the last visit
  sd18 <- sqrt(1.2^2 + 1.2^2 * u18^2 + 2 * 0.3 * 1.2 * 1.2 * u18 + 0.7^2)
  list(pass = max(gaps) < 1e-12 && abs(slope_ctl - 0.12) < 1e-12 && abs(slope_trt - 0.12 * 0.75) < 1e-12 &&
         abs(cv[[1]]$control$sd$value - sqrt(1.2^2 + 0.7^2)) < 1e-12 && abs(cv[[4]]$control$sd$value - sd18) < 1e-12 &&
         identical(cv[[4]]$control$mean$source, "calculated") && !isTRUE(cv[[4]]$control$mean$simulated),
       detail = sprintf("emax progression slowed by 40%%: the treated mean equals the control curve at 0.6 t at all four visits (largest gap %.1e); a linear slope of 0.12 a month under a 25%% slowing is %.4f in the treated arm (0.09 expected); every curve value is a calculated number, not a simulated one",
                        max(gaps), slope_trt))
})

vcr_case("N99d", c("AC-04", "AC-31", "AC-28"), function() {
  sc <- .n99_sc("linear", 0.25, n = 100L)
  r1 <- .n99_run(sc, cores = 1L); r2 <- .n99_run(sc, cores = 2L); r3 <- .n99_run(sc, cores = 1L)
  few <- .n99_run(sc, replicates = 100L)
  cf <- tempfile("cancel"); file.create(cf)
  canceled <- vcr_run_job(vcr_test_json(vcr_test_job("patients.progression", sc, seed = 9901L)), cancel_file = cf); unlink(cf)
  g <- r1$diagnostics$progression$given; keys <- vapply(g, function(x) x$key, character(1))
  as_ <- vapply(r1$diagnostics$progression$assumed, function(x) x$key, character(1))
  list(pass = identical(vcr_output_hash(r1), vcr_output_hash(r2)) && identical(vcr_output_hash(r1), vcr_output_hash(r3)) && r1$diagnostics$progression$trials == 5000L &&
         few$diagnostics$progression$trials == 5000L && identical(canceled$status, "canceled") && length(canceled$measures) == 0L &&
         all(c("model.amplitude", "model.betweenPersonSd", "baseline.mean", "baseline.sd", "residualSd", "treatment.slowing", "correlation") %in% keys) &&
         all(vapply(g, function(x) x$basis %in% c("literature", "assumed", "data"), logical(1))) && "analysis.alpha" %in% as_ && isTRUE(r1$diagnostics$progression$populationLevel) &&
         length(r1$diagnostics$progression$limits) == 2L && !is.null(r1$diagnostics$progression$curves[[1]]$control$mean$source),
       detail = sprintf("the same job on 1 core, on 2 cores and again on 1 has one output hash (%s); asked for 100 trials it runs the domain's floor of %d; a cancel written before the start gives '%s' with no measure; the %d stated values carry their basis and the defaults taken (%s) are listed as assumptions; the result states that it is population level",
                        substr(vcr_output_hash(r1), 1, 12), few$diagnostics$progression$trials, canceled$status, length(g), paste(as_, collapse = ", ")))
})

vcr_case("N99e", c("AC-04", "AC-27"), function() {
  code <- function(r) { cs <- vcr_test_issue_codes(r); if (length(cs)) cs[1] else NA_character_ }
  late <- .n99_run(.n99_sc("linear", visits = c(1, 6, 12)))
  two <- .n99_run(.n99_sc("linear", visits = c(0, 12), analysis = list(kind = "slope")))
  off <- .n99_run(.n99_sc("linear", analysis = list(kind = "change", visit = 7)))
  flat <- .n99_sc("linear", model = list(family = "linear", slope = list(value = 0.1, basis = "assumed"), betweenPersonSd = list(value = 0, basis = "assumed")), residual = 0)
  flat$baseline$sd$value <- 0
  zero <- .n99_run(flat)
  nobasis <- .n99_sc("linear"); nobasis$model$slope$basis <- NULL
  unsourced <- .n99_run(nobasis)
  neg <- .n99_sc("linear"); neg$model$betweenPersonSd$value <- -1
  negative <- .n99_run(neg)
  full <- .n99_sc("linear", slowing = 1)
  whole <- .n99_run(full)
  list(pass = identical(code(late), "scenario_value_invalid") && identical(code(two), "scenario_value_invalid") && identical(code(off), "scenario_value_invalid") && identical(code(zero), "scenario_value_invalid") &&
         identical(code(unsourced), "scenario_field_missing") && identical(code(negative), "scenario_value_invalid") && identical(code(whole), "scenario_value_invalid"),
       detail = sprintf("refused by name: a schedule that does not start at 0 (%s), a slope from two visits (%s), an analysis visit that is not scheduled (%s), a population with no spread at all (%s), a value with no basis (%s), a negative spread (%s), a slowing of 100%% (%s)",
                        code(late), code(two), code(off), code(zero), code(unsourced), code(negative), code(whole)))
})
