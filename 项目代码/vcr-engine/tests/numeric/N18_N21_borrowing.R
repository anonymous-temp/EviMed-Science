# N18-N21 — Bayesian borrowing: conjugate closed forms, the heterogeneity
# ceiling, fully vague borrowing, and the RBesT version lock.

vcr_case("N18", c("AC-30"), function() {
  suppressMessages(library(RBesT))
  # (a) Beta(a, b) moment ESS is a + b, exactly.
  beta_cases <- list(c(2, 8), c(10, 30), c(19, 133), c(3.5, 12.25))
  d_beta <- max(vapply(beta_cases, function(ab) {
    abs(vcr_prior_ess(list(alpha = ab[1], beta = ab[2])) -
          RBesT::ess(RBesT::mixbeta(c(1, ab[1], ab[2])), method = "moment"))
  }, numeric(1)))
  # (b) A normal prior's ESS is sigma^2 / s^2.
  d_norm <- abs(vcr_prior_ess(data.frame(weight = 1, mean = 0.2, sd = 0.15), unit_variance = 1) -
                  RBesT::ess(RBesT::mixnorm(c(1, 0.2, 0.15), sigma = 1), method = "moment"))
  # (c) A conjugate mixture's posterior weights are closed form.
  prior <- data.frame(weight = c(0.56, 0.24, 0.20), alpha = c(19, 8, 1), beta = c(133, 40, 1))
  ours <- vcr_beta_mixture_posterior(prior, r = 14, n = 100)
  ref <- RBesT::postmix(RBesT::mixbeta(c(0.56, 19, 133), c(0.24, 8, 40), c(0.20, 1, 1)), r = 14, n = 100)
  d_post <- max(abs(ours$weight - as.numeric(ref[1, ])),
                abs(ours$alpha - as.numeric(ref[2, ])), abs(ours$beta - as.numeric(ref[3, ])))
  # (d) A Beta mixture's moment ESS.
  d_mix <- abs(vcr_beta_mixture_moment_ess(data.frame(weight = c(0.7, 0.3), alpha = c(19, 8), beta = c(133, 40))) -
                 RBesT::ess(RBesT::mixbeta(c(0.7, 19, 133), c(0.3, 8, 40)), method = "moment"))
  ok <- max(d_beta, d_norm, d_post, d_mix) < 1e-10
  list(pass = ok,
       detail = sprintf("Beta a+b |d|=%.2e; normal sigma^2/s^2 %.6f |d|=%.2e; mixture posterior weights %.9f/%.9f/%.9f |d|=%.2e; mixture moment ESS |d|=%.2e (tol 1e-10)",
                        d_beta, vcr_prior_ess(data.frame(weight = 1, mean = 0.2, sd = 0.15)), d_norm,
                        ours$weight[1], ours$weight[2], ours$weight[3], d_post, d_mix))
})

vcr_case("N19", c("AC-30"), function() {
  # Heterogeneity caps borrowing: ESS <= sigma^2 / tau^2 with sigma^2 one
  # subject's information on the logit scale, 1 / (p (1 - p)).
  #
  # Hidden knowledge about the *form* of this case: the literal reading of
  # C1's line -- "with 200 simulated historical studies the ESS does not
  # exceed 52.9" -- is not a property that can hold. The bound is a function of
  # the *true* tau, the MAP only ever sees tau-hat, and at k = 200 tau-hat has
  # a standard error of about 0.02 on a tau of 0.3, so a draw with
  # tau-hat = 0.26 legitimately produces an ESS of 69. What is actually true,
  # and is what the bound is for, is tested here in three parts: the ceiling
  # formula is exact, the ESS never exceeds the ceiling at the MAP's own
  # tau-hat, and the ESS *saturates* -- a hundredfold increase in k does not
  # increase it. See the report.
  p <- 0.3
  unit <- vcr_logit_unit_variance(p)
  c03 <- vcr_ess_ceiling(0.3, unit)
  c05 <- vcr_ess_ceiling(0.5, unit)
  ok_ceiling <- abs(c03 - 52.910052910053) < 1e-9 && abs(c05 - 19.047619047619) < 1e-9
  set.seed(19L, kind = VCR_RNG_KIND)
  n_h <- 150L
  ks <- c(20L, 200L, 2000L, 20000L)
  rows <- lapply(ks, function(k) {
    theta <- stats::rnorm(k, stats::qlogis(p), 0.3)
    r_h <- stats::rbinom(k, n_h, stats::plogis(theta))
    y <- stats::qlogis((r_h + 0.5) / (n_h + 1)); se <- sqrt(1 / (r_h + 0.5) + 1 / (n_h - r_h + 0.5))
    map <- vcr_map_prior(y, se, list(kind = "half_normal", scale = 0.5))
    mix <- vcr_map_normal_mixture(map, 2L)
    ess <- vcr_prior_ess(mix, unit)
    list(k = k, tau = map$tauPosteriorMedian, ess = ess,
         ceilingAtTauHat = vcr_ess_ceiling(map$tauPosteriorMedian, unit))
  })
  under_own <- all(vapply(rows, function(r) r$ess <= r$ceilingAtTauHat + 1e-9, logical(1)))
  # Saturation: k from 200 to 20,000 is a hundredfold, ESS must not follow.
  e200 <- rows[[2]]$ess; e20000 <- rows[[4]]$ess
  saturated <- e20000 / e200 < 2 && max(vapply(rows, function(r) r$ess, numeric(1))) < 2 * c03
  ok <- ok_ceiling && under_own && saturated
  list(pass = ok,
       detail = sprintf("ceiling p=0.3: tau=0.3 -> %.6f (C1: <=52.9), tau=0.5 -> %.6f (C1: <=19.0); ESS by k %s (tau-hat %s), each <= its own ceiling %s; k x100 changes ESS by x%.2f",
                        c03, c05,
                        paste(sprintf("%d:%.2f", ks, vapply(rows, function(r) r$ess, numeric(1))), collapse = " "),
                        paste(sprintf("%.4f", vapply(rows, function(r) r$tau, numeric(1))), collapse = "/"),
                        under_own, e20000 / e200))
})

vcr_case("N19b", c("AC-07", "AC-30"), function() {
  # Assurance through the job (the handler had no case that called it), for the
  # three endpoint families, against numerical integration written here and, for
  # the binary endpoint, against a Monte-Carlo run of the actual z-test. The
  # binary case pins a defect: the two-proportion power was computed on the
  # ABSOLUTE risk difference in a one-sided test, so a design prior reaching
  # negative differences (the treatment worse) scored those draws as if the
  # treatment were as much better -- assurance 0.12 too high for a prior N(0.05,
  # 0.1^2). And the prior's basis is honoured: a confidence-interval basis is
  # refused unless overridden, a lognormal prior is for a hazard ratio only.
  run <- function(sc, tag = "a") vcr_test_run(vcr_test_job("design.assurance", sc, job_id = paste0("job_n19b_", tag)))
  # continuous: N(0.3, 0.15^2) on the effect, z-test, 200 per arm
  se <- sqrt(2 / 200); z1 <- stats::qnorm(0.975); z2 <- stats::qnorm(0.975)
  cont <- run(list(design = list(nTreat = 200, nControl = 200), endpoint = list(type = "continuous"), truth = list(sd = 1), designPrior = list(kind = "normal", mean = 0.3, sd = 0.15), analysis = list(alpha = 0.025, sided = 1)))
  int1 <- stats::integrate(function(d) stats::pnorm(d / se - z1) * stats::dnorm(d, 0.3, 0.15), -Inf, Inf, rel.tol = 1e-10)$value
  cont2 <- run(list(design = list(nTreat = 200, nControl = 200), endpoint = list(type = "continuous"), truth = list(sd = 1), designPrior = list(kind = "normal", mean = 0.3, sd = 0.15), analysis = list(alpha = 0.05, sided = 2)), "b")
  int2 <- stats::integrate(function(d) (stats::pnorm(d / se - z2) + stats::pnorm(-d / se - z2)) * stats::dnorm(d, 0.3, 0.15), -Inf, Inf, rel.tol = 1e-10)$value
  ok_cont <- abs(vcr_measure_value(cont, "assurance") - int1) < 1e-8 && abs(vcr_measure_value(cont2, "assurance") - int2) < 1e-8 &&
    abs(vcr_measure_value(cont, "power_at_prior_mean") - stats::pnorm(0.3 / se - z1)) < 1e-12 && int1 < stats::pnorm(0.3 / se - z1)
  # time to event: normal prior on log(HR), Schoenfeld power at 250 events (allocation .5); lognormal is the same prior
  tte_sc <- function(kind) list(design = list(events = 250, allocation = 0.5), endpoint = list(type = "time_to_event"), designPrior = list(kind = kind, mean = log(0.7), sd = 0.2), analysis = list(alpha = 0.025, sided = 1))
  tte <- run(tte_sc("normal"), "c"); tte_ln <- run(tte_sc("lognormal"), "d")
  int3 <- stats::integrate(function(l) stats::pnorm(-l * sqrt(250 * 0.25) - z1) * stats::dnorm(l, log(0.7), 0.2), -Inf, Inf, rel.tol = 1e-10)$value
  ok_tte <- abs(vcr_measure_value(tte, "assurance") - int3) < 1e-8 && identical(vcr_measure_value(tte, "assurance"), vcr_measure_value(tte_ln, "assurance"))
  no_events <- run(list(design = list(allocation = 0.5), endpoint = list(type = "time_to_event"), designPrior = list(mean = log(0.7), sd = 0.2), analysis = list(alpha = 0.025)), "e")
  ok_events <- identical(no_events$status, "failed") && !("handler_error" %in% vcr_test_issue_codes(no_events))
  # binary: control rate 0.3, prior on the risk difference N(0.05, 0.1^2), 200 per arm, one-sided 0.025
  bin_sc <- list(design = list(nTreat = 200, nControl = 200), endpoint = list(type = "binary"), truth = list(controlRate = 0.3), designPrior = list(kind = "normal", mean = 0.05, sd = 0.1), analysis = list(alpha = 0.025, sided = 1))
  bin <- run(bin_sc, "f")
  set.seed(19L, kind = VCR_RNG_KIND); N <- 400000L
  rd <- stats::rnorm(N, 0.05, 0.1); p1 <- pmin(pmax(0.3 + rd, 1e-9), 1 - 1e-9)
  x1 <- stats::rbinom(N, 200L, p1) / 200; x0 <- stats::rbinom(N, 200L, 0.3) / 200; pb <- (x1 + x0) / 2
  zt <- (x1 - x0) / sqrt(pb * (1 - pb) * (2 / 200)); zt[!is.finite(zt)] <- 0
  mc <- mean(zt > stats::qnorm(0.975)); mc_se <- sqrt(mc * (1 - mc) / N)
  a_bin <- vcr_measure_value(bin, "assurance")
  worse <- vcr_power_proportions(0.3, 0.2, 200, 200, 0.025, 1)
  ok_bin <- abs(a_bin - mc) < 3 * mc_se + 0.01 && worse < 0.001 && vcr_power_proportions(0.3, 0.4, 200, 200, 0.025, 1) > 0.5 &&
    isTRUE(all.equal(vcr_power_proportions(0.3, 0.4, 200, 200, 0.05, 2), stats::power.prop.test(n = 200, p1 = 0.3, p2 = 0.4, sig.level = 0.05, strict = TRUE)$power, tolerance = 1e-9))
  # basis rules
  conf <- run(utils::modifyList(bin_sc, list(designPrior = list(basis = "confidence"))), "g")
  conf_ok <- run(utils::modifyList(bin_sc, list(designPrior = list(basis = "confidence", basisOverride = TRUE))), "h")
  ln_bad <- run(utils::modifyList(bin_sc, list(designPrior = list(kind = "lognormal"))), "i")
  ok_rules <- identical(conf$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(conf) && identical(conf_ok$status, "succeeded") &&
    identical(ln_bad$status, "failed")
  list(pass = ok_cont && ok_tte && ok_events && ok_bin && ok_rules,
       detail = sprintf("continuous assurance %.6f (integral %.6f), two-sided %.6f (%.6f), power at the prior mean %.4f; time to event %.6f (%.6f, lognormal identical: %s), missing events -> %s; binary N(0.05, 0.1^2) on the risk difference: %.4f vs the z-test's Monte-Carlo %.4f (+-%.4f); one-sided power of a WORSE treatment (0.2 vs 0.3) %.5f; confidence-basis prior refused %s, allowed with override %s, lognormal on a binary endpoint refused %s",
                        vcr_measure_value(cont, "assurance"), int1, vcr_measure_value(cont2, "assurance"), int2, vcr_measure_value(cont, "power_at_prior_mean"),
                        vcr_measure_value(tte, "assurance"), int3, identical(vcr_measure_value(tte, "assurance"), vcr_measure_value(tte_ln, "assurance")),
                        paste(vcr_test_issue_codes(no_events), collapse = ","), a_bin, mc, mc_se, worse,
                        identical(conf$status, "failed"), identical(conf_ok$status, "succeeded"), identical(ln_bad$status, "failed")))
})

vcr_case("N20", c("AC-10", "AC-28"), function() {
  # The operating characteristics of a borrowing design over a grid of
  # control-rate drift (plan 5.3: type-I error and power in scenarios where the
  # true control rate departs from history), through the engine's own function
  # `vcr_hybrid_operating_characteristics` -- the decision rule used to live
  # inside this case, so the engine had none (EB-7).
  #
  # Three things are checked, each of which fails if the borrowing code is wrong:
  #  (a) with NO borrowing the design is the plain z test: type-I error is alpha
  #      exactly at every drift (a closed form, and the plumbing check);
  #  (b) with a single-normal MAP prior and no vague component, the rejection
  #      probability has a CLOSED FORM (the posterior mean is linear in the
  #      control estimate, so the decision statistic is normal), and the
  #      simulation at each drift must agree within 3 MCSE, for the null and the
  #      alternative;
  #  (c) the trade-off the plan asks the page to show: type-I inflation grows with
  #      the drift, and a heavier vague component (w_R 0.5 vs 0.2 vs 0) inflates
  #      less. Fully vague borrowing (w_R = 1, flat vague component) is the no-borrowing design.
  alpha <- 0.025
  nC <- 15L; nT <- 60L                        # a hybrid design: few concurrent controls, the rest borrowed
  set.seed(20L, kind = VCR_RNG_KIND)
  hist_y <- stats::rnorm(8L, 2.0, 0.3); hist_se <- rep(0.25, 8L)
  map1 <- vcr_map_normal_mixture(vcr_map_prior(hist_y, hist_se, list(kind = "half_normal", scale = 0.5)), 1L)
  unit_var <- 0.5^2                           # one subject's variance on the analysis scale
  drifts <- c(0, 0.15, 0.3)
  effect <- 0.35
  reps <- 20000L
  oc <- vcr_hybrid_operating_characteristics(map1, unit_var, nC, nT, drifts, effect, robust_weights = c(0, 0.2, 0.5),
                                             alpha = alpha, replicates = reps, seed = 2020L, cores = VCR_TEST_CORES)
  # fully vague borrowing: the MAP has weight zero and the vague component is flat
  oc_flat <- vcr_hybrid_operating_characteristics(map1, unit_var, nC, nT, drifts, effect, robust_weights = 1, vague_sd = 1000,
                                                  alpha = alpha, replicates = reps, seed = 2020L, cores = VCR_TEST_CORES)
  m0 <- map1$mean; s0 <- map1$sd
  sc <- sqrt(unit_var / nC); st <- sqrt(unit_var / nT)
  a <- (1 / sc^2) / (1 / s0^2 + 1 / sc^2); v <- 1 / (1 / s0^2 + 1 / sc^2)
  crit <- stats::qnorm(1 - alpha)
  closed <- function(d, eff) {
    theta_c <- m0 + d; theta_t <- theta_c + eff
    mean_num <- theta_t - a * theta_c - (1 - a) * m0
    1 - stats::pnorm((crit * sqrt(st^2 + v) - mean_num) / sqrt(st^2 + a^2 * sc^2))
  }
  cell <- function(d, prior, scenario) oc[oc$drift == d & oc$prior == prior & oc$scenario == scenario, ]
  dev <- function(d, prior, scenario, want) { r <- cell(d, prior, scenario); abs(r$rejection - want) / r$mcse }
  # (a) no borrowing
  z_none <- max(vapply(drifts, function(d) dev(d, "none", "null", alpha), numeric(1)))
  # (b) pure MAP (w_R = 0): closed form
  z_map <- max(vapply(drifts, function(d) max(dev(d, "robust_0", "null", closed(d, 0)), dev(d, "robust_0", "alternative", closed(d, effect))), numeric(1)))
  # (c) trade-off
  t1 <- function(prior, d) cell(d, prior, "null")$rejection
  inflates <- t1("robust_0", 0.3) > 2 * alpha && t1("robust_0", 0.3) > t1("robust_0", 0.15) && t1("robust_0", 0.15) > t1("robust_0", 0)
  ordered <- t1("robust_0.5", 0.3) < t1("robust_0.2", 0.3) && t1("robust_0.2", 0.3) < t1("robust_0", 0.3)
  vague <- max(vapply(drifts, function(d) { r <- oc_flat[oc_flat$drift == d & oc_flat$prior == "robust_1" & oc_flat$scenario == "null", ]; abs(r$rejection - alpha) / r$mcse }, numeric(1)))
  gain <- cell(0, "robust_0", "alternative")$rejection > cell(0, "none", "alternative")$rejection + 0.02
  ok <- z_none <= 3 && z_map <= 3 && inflates && ordered && vague <= 3 && gain
  list(pass = ok,
       detail = sprintf("no borrowing: type-I = alpha at every drift (worst %.2f MCSE); pure MAP prior vs its closed form over drift %s, null and alternative: worst %.2f MCSE (%d replicates each, MCSE %.4f); type-I by drift %.4f/%.4f/%.4f (alpha %.3f) and at drift 0.3 by w_R 0/0.2/0.5: %.4f/%.4f/%.4f; w_R = 1 with a flat vague component is the plain design (worst %.2f MCSE); power gain at zero drift %+.3f",
                        z_none, paste(drifts, collapse = "/"), z_map, reps, cell(0, "none", "null")$mcse,
                        t1("robust_0", 0), t1("robust_0", 0.15), t1("robust_0", 0.3), alpha,
                        t1("robust_0", 0.3), t1("robust_0.2", 0.3), t1("robust_0.5", 0.3), vague,
                        cell(0, "robust_0", "alternative")$rejection - cell(0, "none", "alternative")$rejection))
})

vcr_case("N21", c("AC-04", "AC-30"), function() {
  # A version lock on RBesT's own deterministic example. `gMAP` is *not* in
  # this case: it runs Stan, and an MCMC fit is not bit-reproducible across
  # builds -- which is exactly why this engine derives its MAP by quadrature
  # and keeps RBesT for the closed-form pieces.
  suppressMessages(library(RBesT))
  map <- RBesT::mixbeta(c(0.7, 19, 133), c(0.3, 8, 40))
  rob <- RBesT::robustify(map, weight = 0.2, mean = 0.5)
  post <- RBesT::postmix(rob, r = 14, n = 100)
  d <- RBesT::decision2S(0.95, 0, lower.tail = FALSE)
  oc <- RBesT::oc2S(rob, RBesT::mixbeta(c(1, 1, 1)), 100, 100, d)
  # Baselines recorded from RBesT 1.12.0 on 2026-09-28.
  baseline <- list(essMapMoment = 68.1374919505, essMapElir = 96.1576603806,
                   essRobMoment = 3.2468842866, essRobElir = 68.8739470353,
                   postWeights = c(0.731343880852, 0.237059330743, 0.031596788405),
                   postMean = 0.135656358187,
                   ocNull = 0.0148055069, ocAlt = 0.0000054907)
  got <- list(essMapMoment = RBesT::ess(map, method = "moment"), essMapElir = RBesT::ess(map, method = "elir"),
              essRobMoment = RBesT::ess(rob, method = "moment"), essRobElir = RBesT::ess(rob, method = "elir"),
              postWeights = as.numeric(post[1, ]), postMean = as.numeric(summary(post)["mean"]),
              ocNull = oc(0.20, 0.20), ocAlt = oc(0.20, 0.35))
  drift <- max(vapply(names(baseline), function(k)
    max(abs(got[[k]] - baseline[[k]])), numeric(1)))
  # And our own closed forms must reproduce the two RBesT pieces we duplicate.
  ours_post <- vcr_beta_mixture_posterior(
    data.frame(weight = as.numeric(rob[1, ]), alpha = as.numeric(rob[2, ]), beta = as.numeric(rob[3, ])),
    r = 14, n = 100)
  d_ours <- max(abs(ours_post$weight - baseline$postWeights))
  ours_ess <- vcr_beta_mixture_moment_ess(data.frame(weight = as.numeric(rob[1, ]), alpha = as.numeric(rob[2, ]), beta = as.numeric(rob[3, ])))
  d_ess <- abs(ours_ess - baseline$essRobMoment)
  ok <- drift < 1e-6 && d_ours < 1e-10 && d_ess < 1e-8
  list(pass = ok,
       detail = sprintf("RBesT %s reproduces its pinned baseline (max drift %.2e): moment ESS %.6f/%.6f, ELIR %.6f/%.6f, oc2S null %.7f; our closed forms match to %.2e (weights) and %.2e (ESS)",
                        as.character(utils::packageVersion("RBesT")), drift,
                        got$essMapMoment, got$essRobMoment, got$essMapElir, got$essRobElir,
                        got$ocNull, d_ours, d_ess))
})

vcr_case("N21b", c("AC-30", "AC-07"), function() {
  # The MAP job, against independent references. (1) The MAP's mean and sd against
  # a joint grid over (mu, tau) written for this case (no quadrature in tau, no
  # flat-prior shortcut); (2) both effective sample sizes reported under their own
  # names: the moment ESS and the ELIR, the latter against RBesT's own ELIR of
  # the same normal mixture; (3) conflict judged against the MAP itself: a
  # current control rate far from history makes the job not_estimable with the
  # MAP-only tail probability under the bound, while the robust prior's tail
  # probability (diluted by its vague component) would NOT have fired -- so the
  # old "test against the robust prior" could never trigger; (4) the operating
  # characteristics table when asked; (5) refusals by name: k = 1, three
  # components, and the estimate/se path without a unit variance.
  suppressMessages(library(RBesT))
  y <- c(-1.85, -1.62, -1.95, -1.71, -1.5); se <- c(0.15, 0.18, 0.22, 0.12, 0.2)
  run <- function(sc, reps = NULL, dir = NULL) vcr_test_run(vcr_test_job("comparator.map_prior", sc, seed = 21L, replicates = reps, job_id = "job_n21b"), output_dir = dir)
  base <- list(historical = list(estimate = as.list(y), se = as.list(se)), unitVariance = 4, tauPrior = list(kind = "half_normal", scale = 0.5))
  r <- run(base)
  mu <- seq(-4, 1, length.out = 1201); tau <- seq(1e-4, 3, length.out = 1500)
  lp <- outer(mu, tau, Vectorize(function(m, t) sum(stats::dnorm(y, m, sqrt(se^2 + t^2), log = TRUE)) + stats::dnorm(m, 0, 100, log = TRUE) + stats::dnorm(t, 0, 0.5, log = TRUE)))
  w <- exp(lp - max(lp)); w <- w / sum(w)
  pm <- sum(w * outer(mu, tau, function(m, t) m)); pv <- sum(w * outer(mu, tau, function(m, t) m^2 + t^2)) - pm^2
  ok_map <- abs(vcr_measure_value(r, "map_mean") - pm) < 1e-4 && abs(vcr_measure_value(r, "map_sd") - sqrt(pv)) / sqrt(pv) < 0.01
  mix <- as.data.frame(r$diagnostics$mixture)
  rb_elir <- RBesT::ess(RBesT::mixnorm(c(mix$weight[1], mix$mean[1], mix$sd[1]), c(mix$weight[2], mix$mean[2], mix$sd[2]), sigma = 2), method = "elir", sigma = 2)
  ok_ess <- abs(vcr_measure_value(r, "map_effective_sample_size_elir") - rb_elir) < 1e-3 &&
    !is.na(vcr_measure_value(r, "map_effective_sample_size_moment")) && !is.na(vcr_measure_value(r, "prior_effective_sample_size_elir")) &&
    vcr_measure_value(r, "map_effective_sample_size_moment") != vcr_measure_value(r, "map_effective_sample_size_elir")
  hist <- list(events = list(140, 180, 90, 220, 110), n = list(1000, 1200, 800, 1500, 900))
  far <- run(list(historical = hist, robustWeight = 0.2, current = list(estimate = stats::qlogis(0.25), se = 0.05)))
  near <- run(list(historical = hist, robustWeight = 0.2, current = list(estimate = stats::qlogis(0.14), se = 0.05)))
  bound <- vcr_domain()$limits$conflictBound
  ok_conflict <- identical(far$status, "not_estimable") && identical(far$notEstimableRule, "map_prior_conflict") && length(far$measures) == 0L &&
    far$diagnostics$conflict$mapOnly$predictiveTailProbability < bound && far$diagnostics$conflict$robust$predictiveTailProbability > bound &&
    identical(near$status, "succeeded")
  dir <- tempfile("n21b"); dir.create(dir)
  oc <- run(list(historical = hist, robustWeight = 0.2, operatingCharacteristics = list(nControl = 100, nTreatment = 100, drifts = list(0, 0.5), effect = 0.8)), reps = 400L, dir = dir)
  tb <- vcr_test_table(oc, "operating-characteristics", dir)
  ok_oc <- identical(oc$status, "succeeded") && !is.null(tb) && all(c("drift", "prior", "scenario", "rejection", "mcse") %in% names(tb)) && all(tb$mcse > 0) && nrow(tb) == 12L
  refused <- list(run(list(historical = list(estimate = list(-1.8), se = list(0.2)), unitVariance = 4)),
                  run(utils::modifyList(base, list(components = 3L))), run(list(historical = list(estimate = as.list(y), se = as.list(se)))))
  ok_ref <- all(vapply(refused, function(x) identical(x$status, "failed") && length(x$measures) == 0L, logical(1)))
  ok <- ok_map && ok_ess && ok_conflict && ok_oc && ok_ref
  list(pass = ok,
       detail = sprintf("MAP mean %.6f vs joint grid %.6f, sd %.4f vs %.4f; ELIR ESS of the MAP %.4f vs RBesT %.4f, moment ESS %.2f (two named measures); control 25%% vs history 14%%: %s/%s, MAP-only tail %.2e vs robust tail %.3f (bound %g); OC table %d rows with MCSE; k=1, 3 components and no unit variance refused: %d/3",
                        vcr_measure_value(r, "map_mean"), pm, vcr_measure_value(r, "map_sd"), sqrt(pv),
                        vcr_measure_value(r, "map_effective_sample_size_elir"), rb_elir, vcr_measure_value(r, "map_effective_sample_size_moment"),
                        far$status, far$notEstimableRule %||% "NULL", far$diagnostics$conflict$mapOnly$predictiveTailProbability,
                        far$diagnostics$conflict$robust$predictiveTailProbability, bound, nrow(tb %||% data.frame()),
                        sum(vapply(refused, function(x) identical(x$status, "failed"), logical(1)))))
})
