# N22 — prognostic covariate adjustment: the variance ratio, empirically.

vcr_case("N22", c("AC-11", "AC-29", "AC-10"), function() {
  # Closed form first: 1 - rho^2 at rho = 0.5 and 0.7.
  r05 <- vcr_procova_ratio(0.5)$varianceRatio
  r07 <- vcr_procova_ratio(0.7)$varianceRatio
  r03 <- vcr_procova_ratio(0.3)$varianceRatio
  exact <- abs(r05 - 0.75) < 1e-12 && abs(r07 - 0.51) < 1e-12 && abs(r03 - 0.91) < 1e-12
  # Then the empirical variance ratio: rho = 0.5, no true effect, 200 per arm,
  # 10,000 replicates. ANCOVA on the prognostic score versus the unadjusted
  # difference, on the same data, so the two estimators are correlated and the
  # delta-method MCSE of the ratio must account for that:
  #   Var(log R) = (2/(m-1)) * 2 * (1 - cor^2)
  rho <- 0.5
  reps <- 10000L
  bank <- vcr_stream_bank(2222L)
  out <- vcr_map_streams(bank$take(reps), function(i) {
    d <- vcr_sim_continuous(200L, 200L, delta = 0, sd = 1, rho = rho)
    c(unadj = unname(vcr_analyse_ttest(d)["estimate"]),
      adj = unname(vcr_analyse_ancova(d)["estimate"]),
      reject = unname(vcr_analyse_ancova(d)["reject"]))
  }, cores = VCR_TEST_CORES)
  unadj <- vapply(out, function(o) o[["unadj"]], numeric(1))
  adj <- vapply(out, function(o) o[["adj"]], numeric(1))
  rej <- vapply(out, function(o) o[["reject"]], numeric(1))
  ratio <- stats::var(adj) / stats::var(unadj)
  r12 <- stats::cor(adj, unadj)
  mcse_log <- sqrt((4 / (reps - 1)) * (1 - r12^2))
  mcse_ratio <- ratio * mcse_log
  within <- abs(ratio - 0.75) <= 3 * mcse_ratio
  t1e <- mean(rej)
  mcse_t1e <- vcr_mcse_proportion(t1e, reps)
  t1e_ok <- abs(t1e - 0.025) <= 3 * mcse_t1e
  list(pass = exact && within && t1e_ok,
       detail = sprintf("closed form rho .3/.5/.7 -> %.4f/%.4f/%.4f (want .91/.75/.51); empirical variance ratio %.5f vs 0.75 = %.2f MCSE (mcse %.5f, cor(adj,unadj) %.4f, %d reps); ANCOVA type-I %.5f vs 0.025 = %.2f MCSE",
                        r03, r05, r07, ratio, abs(ratio - 0.75) / mcse_ratio, mcse_ratio, r12, reps,
                        t1e, abs(t1e - 0.025) / mcse_t1e))
})

vcr_case("N22b", c("AC-11"), function() {
  # The EMA discounts are not interchangeable: lambda multiplies the
  # correlation (inside the square), gamma inflates the control SD (outside).
  # Swapping them silently changes the answer, so both paths are checked.
  base <- vcr_procova_ratio(0.7)$varianceRatio
  disc <- vcr_procova_ratio(0.7, lambda = 0.9)$varianceRatio
  want_disc <- 1 - (0.9 * 0.7)^2
  gamma_only <- vcr_procova_ratio(0.7, gamma = 1.1)$varianceRatio
  paths <- vcr_procova_paths(delta = 0.3, sd = 1, rho_prognostic = 0.7, rho_ordinary = 0.3, lambda = 0.9)
  ordered <- paths$unadjusted$total > paths$ordinaryCovariates$total &&
    paths$ordinaryCovariates$total > paths$prognosticScore$total &&
    paths$prognosticScore$total > paths$undiscountedPrognosticScore$total
  ok <- abs(disc - want_disc) < 1e-12 && abs(base - 0.51) < 1e-12 &&
    abs(gamma_only - disc) > 1e-6 && ordered
  list(pass = ok,
       detail = sprintf("rho .7: undiscounted %.4f, lambda=.9 %.4f (want %.4f), gamma=1.1 %.4f (differs, as it must); three paths n = %.0f > %.0f > %.0f > %.0f",
                        base, disc, want_disc, gamma_only,
                        paths$unadjusted$total, paths$ordinaryCovariates$total,
                        paths$prognosticScore$total, paths$undiscountedPrognosticScore$total))
})
