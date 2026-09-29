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

vcr_case("N20", c("AC-10", "AC-28"), function() {
  # Fully vague borrowing (w_R = 1): the MAP component carries weight zero, so
  # the design must behave exactly like the no-borrowing design and hit the
  # nominal type-I error. Continuous endpoint with known sigma, so the
  # posterior-probability rule *is* the one-sided z test and the nominal value
  # is exactly alpha -- on a binary endpoint the discreteness of the binomial
  # would make "exactly nominal" untestable.
  alpha <- 0.025
  n <- 100L; sigma <- 1
  y_hist <- stats::qlogis(0.3)  # only to give the MAP something to be derived from
  set.seed(20L, kind = VCR_RNG_KIND)
  hist_y <- stats::rnorm(8L, 2.0, 0.3); hist_se <- rep(0.25, 8L)
  map <- vcr_map_normal_mixture(vcr_map_prior(hist_y, hist_se, list(kind = "half_normal", scale = 0.5)), 2L)
  vague <- vcr_robustify(map, weight = 1, vague_sd = 1000)
  none <- data.frame(weight = 1, mean = mean(hist_y), sd = 1000)
  decide <- function(prior, yc, yt) {
    post_c <- vcr_normal_mixture_posterior(prior, yc, sigma / sqrt(n))
    mu_c <- sum(post_c$weight * post_c$mean)
    v_c <- sum(post_c$weight * (post_c$sd^2 + post_c$mean^2)) - mu_c^2
    z <- (yt - mu_c) / sqrt(sigma^2 / n + v_c)
    as.numeric(z > stats::qnorm(1 - alpha))
  }
  reps <- 20000L
  bank <- vcr_stream_bank(2020L)
  out <- vcr_map_streams(bank$take(reps), function(i) {
    yc <- stats::rnorm(1, 2.0, sigma / sqrt(n)); yt <- stats::rnorm(1, 2.0, sigma / sqrt(n))
    c(borrow = decide(vague, yc, yt), plain = decide(none, yc, yt))
  }, cores = VCR_TEST_CORES)
  borrow <- mean(vapply(out, function(o) o[["borrow"]], numeric(1)))
  plain <- mean(vapply(out, function(o) o[["plain"]], numeric(1)))
  mcse <- vcr_mcse_proportion(borrow, reps)
  ok <- identical(borrow, plain) && abs(borrow - alpha) <= 3 * mcse
  list(pass = ok,
       detail = sprintf("w_R=1 type-I %.5f, no-borrowing %.5f (identical %s); nominal %.4f, |d| = %.2f MCSE (mcse %.5f, %d replicates)",
                        borrow, plain, identical(borrow, plain), alpha, abs(borrow - alpha) / mcse, mcse, reps))
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
