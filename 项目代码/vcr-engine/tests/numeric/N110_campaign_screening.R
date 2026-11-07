# N110 — the screening precision a design-search campaign uses, held to references outside the engine (plan T10, A18, A19).
#
# A campaign screens candidates with a small, predeclared number of replicates and checks finalists at the method's floor on streams
# no screening run used. The engine's part is the versioned precision block `scenario.evaluation`: with `screeningReplicates` the run
# takes exactly that many replicates (below the floor, never in place of a final run) and labels every measure screening precision;
# without it the run is a final one. Either way it reports a draw signature and the per-replicate rejections, which is what lets the
# control plane pair two runs only when they really drew the same numbers.
#
# References, none of them the engine's own code: the exact power of the one-sided two-sample t-test (`stats::power.t.test`, strict),
# the exact Clopper-Pearson bounds of the observed rejection count (`stats::qbeta`), and the rejection count the bitset holds against
# the measure it came from. Every case is a continuous endpoint analysed by the t-test, so the whole file runs in seconds.

.n110_scenario <- function(effect = 0.5, n = 64L, evaluation = NULL) {
  sc <- list(design = list(kind = "two_arm_fixed", nTreat = as.integer(n), nControl = as.integer(n)), endpoint = list(type = "continuous"),
             truth = list(effect = effect, sd = 1), analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power", "type_one_error"))
  if (!is.null(evaluation)) sc$evaluation <- evaluation
  sc
}
.n110_run <- function(sc, seed = 110L, cores = 1L, id = "job_n110") vcr_test_run(vcr_test_job("design.simulate", sc, seed = seed, cores = cores, job_id = id))
.n110_rate <- function(r) Filter(function(m) m$name %in% c("power", "type_one_error"), r$measures)[[1]]
.n110_bits <- function(hex) {
  bytes <- strtoi(substring(hex, seq(1L, nchar(hex), 2L), seq(2L, nchar(hex), 2L)), 16L)
  as.integer(unlist(lapply(bytes, function(b) bitwAnd(b, 2L^(0:7)) > 0L)))
}

vcr_case("N110a", c("AC-28", "AC-04"), function() {
  screen <- .n110_run(.n110_scenario(evaluation = list(version = 1L, screeningReplicates = 600L)))
  final <- .n110_run(.n110_scenario(evaluation = list(version = 1L)))
  dose <- vcr_test_run(vcr_test_job("design.dose", list(design = list(kind = "boin", targetToxicity = 0.3, cohortSize = 3L, maxPatients = 30L),
    truth = list(toxicity = c(0.05, 0.1, 0.2, 0.3, 0.45, 0.6)), evaluation = list(version = 1L, screeningReplicates = 700L)), seed = 3L, job_id = "job_n110_dose"))
  below <- vcr_validate_job(vcr_test_job("design.simulate", .n110_scenario(evaluation = list(version = 1L, screeningReplicates = 150L))))
  at_floor <- vcr_validate_job(vcr_test_job("design.simulate", .n110_scenario(evaluation = list(version = 1L, screeningReplicates = 5000L))))
  older <- vcr_validate_job(vcr_test_job("design.simulate", .n110_scenario(evaluation = list(version = 1L, screeningReplicates = 600L)), extra = list(methodVersion = "1.4.0")))
  labels <- function(r) unique(vapply(r$measures, function(m) m$precision %||% "none", character(1)))
  codes <- function(issues) vapply(issues, function(i) paste0(i$code, "@", i$field), character(1))
  ok <- identical(screen$replicates, 600L) && identical(screen$diagnostics$evaluation$purpose, "screening") &&
    identical(screen$diagnostics$evaluation$floor, 5000L) && identical(labels(screen), "screening") &&
    identical(final$replicates, 5000L) && identical(final$diagnostics$evaluation$purpose, "final") && identical(labels(final), "none") &&
    identical(dose$replicates, 700L) && identical(labels(dose), "screening") && identical(dose$diagnostics$evaluation$floor, 10000L) &&
    "scenario_value_invalid@scenario.evaluation.screeningReplicates" %in% codes(below) &&
    "scenario_value_invalid@scenario.evaluation.screeningReplicates" %in% codes(at_floor) &&
    "method_version_mismatch@methodVersion" %in% codes(older)
  list(pass = ok, detail = sprintf("screening ran %d replicates against a floor of %d, every measure labelled %s; the final run ran %d, labels %s; a dose screen ran %d of 10000 trials; 150 and 5000 refused (%s / %s); an older label refused (%s)",
    screen$replicates, screen$diagnostics$evaluation$floor, paste(labels(screen), collapse = ","), final$replicates, paste(labels(final), collapse = ","),
    dose$replicates, paste(codes(below), collapse = ","), paste(codes(at_floor), collapse = ","), paste(codes(older), collapse = ",")))
})

vcr_case("N110b", c("AC-28", "AC-29"), function() {
  sc <- .n110_scenario(evaluation = list(version = 1L, screeningReplicates = 1000L))
  screen <- .n110_run(sc)
  final <- .n110_run(.n110_scenario(evaluation = list(version = 1L)))
  exact <- stats::power.t.test(n = 64, delta = 0.5, sd = 1, sig.level = 0.025, type = "two.sample", alternative = "one.sided", strict = TRUE)$power
  p_s <- .n110_rate(screen); p_f <- .n110_rate(final)
  # a screening number is a rough one with its own error, and a different receipt from the final number of the same design
  within <- function(m) abs(m$value - exact) <= 3 * m$mcse
  distinct <- !identical(screen$scenarioHash, final$scenarioHash) && !identical(screen$manifest$outputHash, final$manifest$outputHash)
  list(pass = within(p_s) && within(p_f) && p_s$mcse > 2 * p_f$mcse && distinct,
       detail = sprintf("exact t-test power %.4f; screening %.4f +- %.4f (1000 replicates), final %.4f +- %.4f (5000); scenario hashes %s / %s, output hashes differ: %s",
                        exact, p_s$value, p_s$mcse, p_f$value, p_f$mcse, substr(screen$scenarioHash, 1, 10), substr(final$scenarioHash, 1, 10), distinct))
})

vcr_case("N110c", c("AC-28", "AC-31"), function() {
  ev <- list(version = 1L, screeningReplicates = 800L)
  a <- .n110_run(.n110_scenario(effect = 0.45, evaluation = ev))
  b <- .n110_run(.n110_scenario(effect = 0.55, evaluation = ev))        # the same patients' draws under another effect
  c_ <- .n110_run(.n110_scenario(effect = 0.45, n = 70L, evaluation = ev))   # the same seed, more patients: every later draw shifts
  ra <- .n110_bits(a$diagnostics$evaluation$rejects)[seq_len(800)]
  rb <- .n110_bits(b$diagnostics$evaluation$rejects)[seq_len(800)]
  pa <- .n110_rate(a); pb <- .n110_rate(b)
  counts_agree <- sum(ra) == round(pa$value * 800) && sum(rb) == round(pb$value * 800)
  d <- rb - ra
  paired <- stats::sd(d) / sqrt(800)
  unpaired <- sqrt(pa$mcse^2 + pb$mcse^2)
  same <- identical(a$diagnostics$evaluation$drawSignature, b$diagnostics$evaluation$drawSignature)
  shifted <- !identical(a$diagnostics$evaluation$drawSignature, c_$diagnostics$evaluation$drawSignature)
  list(pass = counts_agree && same && shifted && paired < 0.8 * unpaired,
       detail = sprintf("effects 0.45 and 0.55 on one seed: draw signatures equal (%s), the bitsets hold %d and %d rejections (the measures say %.4f and %.4f of 800); the paired error of the difference %.4f against %.4f unpaired; 70 per arm on the same seed draws differently (signature differs: %s)",
                        same, sum(ra), sum(rb), pa$value, pb$value, paired, unpaired, shifted))
})

vcr_case("N110d", c("AC-28"), function() {
  # a design whose type I error is the nominal alpha cannot be shown by a finite simulation to be at or below it
  r <- .n110_run(.n110_scenario(effect = 0, evaluation = list(version = 1L)), seed = 2026L)
  m <- .n110_rate(r)
  n <- r$replicates; k <- round(m$value * n)
  upper <- stats::qbeta(0.975, k + 1, n - k); lower <- if (k > 0) stats::qbeta(0.025, k, n - k + 1) else 0
  list(pass = identical(m$name, "type_one_error") && n == 20000L && abs(k / n - m$value) < 1e-12 && upper > 0.025 && lower < 0.025,
       detail = sprintf("null t-test, %d replicates at the null floor: %d rejections (%.5f); one-sided 97.5%% Clopper-Pearson bounds %.5f and %.5f straddle alpha 0.025, so compliance is inconclusive",
                        n, k, m$value, lower, upper))
})

vcr_case("N110e", c("AC-31"), function() {
  sc <- .n110_scenario(evaluation = list(version = 1L, screeningReplicates = 900L))
  one <- .n110_run(sc, cores = 1L); two <- .n110_run(sc, cores = 2L)
  fin1 <- .n110_run(.n110_scenario(evaluation = list(version = 1L)), cores = 1L); fin2 <- .n110_run(.n110_scenario(evaluation = list(version = 1L)), cores = 2L)
  same <- identical(one$manifest$outputHash, two$manifest$outputHash) && identical(one$diagnostics$evaluation, two$diagnostics$evaluation) &&
    identical(fin1$manifest$outputHash, fin2$manifest$outputHash) && identical(fin1$diagnostics$evaluation, fin2$diagnostics$evaluation)
  list(pass = same, detail = sprintf("screening and final runs on 1 and 2 cores: output hashes %s / %s and %s / %s, evaluation records identical: %s",
    substr(one$manifest$outputHash, 1, 10), substr(two$manifest$outputHash, 1, 10), substr(fin1$manifest$outputHash, 1, 10), substr(fin2$manifest$outputHash, 1, 10), same))
})
