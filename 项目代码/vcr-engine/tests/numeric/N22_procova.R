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

vcr_case("N22b", c("AC-11", "AC-10"), function() {
  # The EMA discounts are not interchangeable: lambda multiplies the correlation
  # (inside the square), gamma inflates the CONTROL arm's SD in the sample-size
  # calculation itself. The first version applied gamma inside a variance ratio
  # in which it cancelled at rho = 0, so a prognostic score with no correlation
  # asked for exactly the unadjusted size whatever gamma said -- the opposite of
  # what a conservatism parameter is for (CE-19). Here every path is checked
  # against its closed form, N = (z_a + z_b)^2 (s1^2/p + s0^2/(1-p)) / delta^2
  # with s_k^2 = sigma_k^2 (1 - rho_k^2), through the job.
  delta <- 0.3; sd <- 1; alpha <- 0.025; power <- 0.9; rho <- 0.6; lambda <- 0.9; gamma <- 1.2
  zz <- (stats::qnorm(1 - alpha) + stats::qnorm(power))^2
  n_of <- function(rho1, rho0, g = 1) zz * (sd^2 * (1 - rho1^2) / 0.5 + (g * sd)^2 * (1 - rho0^2) / 0.5) / delta^2
  job <- function(prog, sided = 1L, endpoint = NULL) {
    sc <- list(design = list(allocation = 0.5), truth = list(effect = delta, sd = sd),
               analysis = list(alpha = alpha, power = power, sided = sided), prognostic = prog)
    if (!is.null(endpoint)) sc$endpoint <- list(type = endpoint)
    vcr_test_run(vcr_test_job("design.procova", sc, job_id = "job_n22b"))
  }
  full <- job(list(rho = rho, lambda = lambda, gamma = gamma))
  no_corr <- job(list(rho = 0, lambda = 1, gamma = gamma))
  lam_only <- job(list(rho = rho, lambda = lambda, gamma = 1))
  gam_only <- job(list(rho = rho, lambda = 1, gamma = gamma))
  two <- job(list(rho = rho, lambda = lambda, gamma = gamma), sided = 2L)
  binary <- job(list(rho = rho), endpoint = "binary")
  g <- function(r, m) vcr_measure_value(r, m)
  want_full <- n_of(lambda * rho, lambda * rho, gamma)
  want_unadj <- n_of(0, 0)
  ok_closed <- g(full, "required_total_prognostic") == ceiling(want_full) && g(full, "required_total_unadjusted") == ceiling(want_unadj) &&
    g(full, "required_total_prognostic_undiscounted") == ceiling(n_of(rho, rho)) &&
    abs(g(full, "variance_ratio") - want_full / want_unadj) < 1e-12
  # rho = 0: gamma alone still costs patients (unadjusted size x (1 + gamma^2) / 2)
  ok_zero <- g(no_corr, "required_total_prognostic") == ceiling(want_unadj * (1 + gamma^2) / 2) && g(no_corr, "required_total_prognostic") > g(no_corr, "required_total_unadjusted")
  # not interchangeable: lambda-only and gamma-only give different sizes, both differ from the full one
  ok_distinct <- g(lam_only, "required_total_prognostic") == ceiling(n_of(lambda * rho, lambda * rho)) &&
    g(gam_only, "required_total_prognostic") == ceiling(n_of(rho, rho, gamma)) &&
    length(unique(c(g(lam_only, "required_total_prognostic"), g(gam_only, "required_total_prognostic"), g(full, "required_total_prognostic")))) == 3L
  ok_two <- g(two, "required_total_unadjusted") > g(full, "required_total_unadjusted") &&
    g(two, "required_total_unadjusted") == ceiling((stats::qnorm(1 - alpha / 2) + stats::qnorm(power))^2 * 4 / delta^2)
  ok_binary <- identical(binary$status, "failed") && "endpoint_not_supported" %in% vcr_test_issue_codes(binary)
  list(pass = ok_closed && ok_zero && ok_distinct && ok_two && ok_binary,
       detail = sprintf("rho .6, lambda .9, gamma 1.2: prognostic N %g (closed form %.3f), unadjusted %g (%.3f), undiscounted %g; rho 0 with gamma 1.2 -> %g > unadjusted %g; lambda-only %g, gamma-only %g, both %g (all distinct); two-sided unadjusted %g; binary endpoint refused: %s",
                        g(full, "required_total_prognostic"), want_full, g(full, "required_total_unadjusted"), want_unadj,
                        g(full, "required_total_prognostic_undiscounted"), g(no_corr, "required_total_prognostic"), g(no_corr, "required_total_unadjusted"),
                        g(lam_only, "required_total_prognostic"), g(gam_only, "required_total_prognostic"), g(full, "required_total_prognostic"),
                        g(two, "required_total_unadjusted"), paste(vcr_test_issue_codes(binary), collapse = ",")))
})
