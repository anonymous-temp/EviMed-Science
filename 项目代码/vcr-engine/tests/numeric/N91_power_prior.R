# N91 — the power prior (algorithm round C10, 2026-11-03): comparator.borrowing, prior.kind power.
#
# "外部每人只算 0.3 人时结论如何": the historical likelihood raised to a fixed discount a0 and multiplied by the current control likelihood. Held to:
#
#   a  the posterior of the control rate, its 95% interval and Pr(the treatment arm is better) against the DEFINITION, integrated numerically
#      (the unnormalised density L(theta | historical)^a0 x prior x L(theta | current), normalised by QUADPACK), for a0 = 0, 0.3, 0.7 and 1
#   b  a0 = 1 is the pooled analysis and a0 = 0 is no borrowing, to the last bit; RBesT::pmixdiff and RBesT::ess for the probability and the
#      prior effective sample size (a0 times the historical patients above the vague prior's own)
#   c  a mean with a known standard deviation: the same against the definition by integration, and the effective sample size a0 n
#   d  the operating characteristics of a rate, exact: every pair of counts, the decision made by RBesT::pmixdiff on each, against the
#      closed form's enumeration, and a simulation of 200,000 trials within three Monte-Carlo errors
#   e  the operating characteristics of a mean against their closed form (the posterior mean is linear in the observed mean, so the type I error
#      and the power are normal probabilities)

.n91_spec <- function(a0, va = 1, vb = 1) list(kind = "power", a0 = a0, va = va, vb = vb)
.n91_hist <- list(x = 90, n = 300)
.n91_cur <- list(x = 40, n = 150)
.n91_trt <- list(x = 100, n = 300)

#' The posterior of a rate from the definition: density proportional to L_h^a0 x Beta(va, vb) x L_c, normalised by integration.
.n91_definition <- function(a0, va = 1, vb = 1) {
  dens <- function(t) exp(a0 * (.n91_hist$x * log(t) + (.n91_hist$n - .n91_hist$x) * log1p(-t)) + (va - 1) * log(t) + (vb - 1) * log1p(-t) +
                           .n91_cur$x * log(t) + (.n91_cur$n - .n91_cur$x) * log1p(-t) + 300)
  cdf <- function(q) stats::integrate(dens, 0, q, rel.tol = 1e-13, subdivisions = 500L)$value / z
  z <- stats::integrate(dens, 0, 1, rel.tol = 1e-13, subdivisions = 500L)$value
  mean_ <- stats::integrate(function(t) t * dens(t), 0, 1, rel.tol = 1e-13, subdivisions = 500L)$value / z
  q <- function(p) stats::uniroot(function(t) cdf(t) - p, c(1e-6, 1 - 1e-6), tol = 1e-13)$root
  better <- stats::integrate(function(t) dens(t) / z * (1 - stats::pbeta(t, 1 + .n91_trt$x, 1 + .n91_trt$n - .n91_trt$x)), 0, 1, rel.tol = 1e-13, subdivisions = 500L)$value
  list(mean = mean_, lower = q(0.025), upper = q(0.975), better = better)
}

#' The engine's rows for a power prior on the rate (none, chosen, full).
.n91_rows <- function(a0) .vcr_bw_posterior_rows("binary", .n91_spec(a0), .n91_hist, .n91_cur, .n91_trt, NULL)$rows

vcr_case("N91a", c("AC-30"), function() {
  worst <- 0; txt <- character()
  for (a0 in c(0, 0.3, 0.7, 1)) {
    ref <- .n91_definition(a0); r <- .n91_rows(a0)[[2L]]
    d <- c(abs(r$mean$value - ref$mean), abs(r$lower$value - ref$lower), abs(r$upper$value - ref$upper), abs(r$probabilityBetter$value - ref$better))
    worst <- max(worst, d)
    txt <- c(txt, sprintf("a0 %.1f mean %.6f 95%% [%.5f, %.5f] Pr(better) %.6f", a0, r$mean$value, r$lower$value, r$upper$value, r$probabilityBetter$value))
  }
  list(pass = worst < 1e-8, detail = sprintf("posterior mean, 95%% interval and Pr(treatment better) of 90/300 historical, 40/150 current, 100/300 treated, against the definition integrated numerically: worst difference %.2e (%s)", worst, paste(txt, collapse = "; ")))
})

vcr_case("N91b", c("AC-30"), function() {
  suppressMessages(library(RBesT))
  rows1 <- .n91_rows(1); rows0 <- .n91_rows(0)
  pooled <- list(mean = (1 + 90 + 40) / (2 + 300 + 150))
  same1 <- max(abs(unlist(rows1[[2L]][c("mean", "lower", "upper")] |> lapply(function(m) m$value)) - unlist(rows1[[3L]][c("mean", "lower", "upper")] |> lapply(function(m) m$value))),
               abs(rows1[[2L]]$probabilityBetter$value - rows1[[3L]]$probabilityBetter$value))
  same0 <- max(abs(unlist(rows0[[2L]][c("mean", "lower", "upper")] |> lapply(function(m) m$value)) - unlist(rows0[[1L]][c("mean", "lower", "upper")] |> lapply(function(m) m$value))),
               abs(rows0[[2L]]$probabilityBetter$value - rows0[[1L]]$probabilityBetter$value))
  pool_err <- abs(rows1[[2L]]$mean$value - pooled$mean)
  # RBesT: Pr(theta_T > theta_C) = 1 - P(theta_T - theta_C <= 0), and the prior effective sample size above the vague prior
  worst_p <- 0; worst_ess <- 0
  for (a0 in c(0.3, 0.7)) {
    spec <- .n91_spec(a0); pr <- vcr_bw_prior("binary", spec, .n91_hist, .n91_cur$x, .n91_cur$n)
    post <- vcr_bw_post_binary(pr$mix, .n91_cur$x, .n91_cur$n)
    ref <- 1 - RBesT::pmixdiff(mixbeta(c(1, 1 + .n91_trt$x, 1 + .n91_trt$n - .n91_trt$x)), mixbeta(c(1, post$alpha, post$beta)), 0)
    worst_p <- max(worst_p, abs(ref - .n91_rows(a0)[[2L]]$probabilityBetter$value))
    ess_ref <- RBesT::ess(mixbeta(c(1, pr$mix$alpha, pr$mix$beta)), method = "moment") - 2
    worst_ess <- max(worst_ess, abs(ess_ref - vcr_bw_prior_ess("binary", c(pr, kind = "power"), .n91_hist)), abs(a0 * .n91_hist$n - vcr_bw_prior_ess("binary", c(pr, kind = "power"), .n91_hist)))
  }
  list(pass = same1 < 1e-12 && same0 < 1e-12 && pool_err < 1e-12 && worst_p < 1e-6 && worst_ess < 1e-9,
       detail = sprintf("a0 = 1 is the full-borrowing row and the pooled Beta posterior (mean %.6f, difference %.1e), a0 = 0 is the no-borrowing row (difference %.1e); Pr(better) against RBesT::pmixdiff for a0 = 0.3 and 0.7: %.2e; the prior effective sample size is RBesT::ess(moment) - 2 and equals a0 times 300 (difference %.1e)",
                        pooled$mean, same1, same0, worst_p, worst_ess))
})

vcr_case("N91c", c("AC-30"), function() {
  hist <- list(mean = 10, sd = 4, n = 120); cur <- list(mean = 11, n = 60); trt <- list(mean = 12, n = 120)
  worst <- 0
  for (a0 in c(0, 0.3, 1)) {
    spec <- list(kind = "power", a0 = a0)
    rows <- .vcr_bw_posterior_rows("continuous", spec, hist, cur, trt, NULL)$rows[[2L]]
    dens <- function(t) exp(-a0 * hist$n * (t - hist$mean)^2 / (2 * hist$sd^2) - cur$n * (t - cur$mean)^2 / (2 * hist$sd^2))
    z <- stats::integrate(dens, 5, 15, rel.tol = 1e-13)$value
    mean_ <- stats::integrate(function(t) t * dens(t), 5, 15, rel.tol = 1e-13)$value / z
    cdf <- function(q) stats::integrate(dens, 5, q, rel.tol = 1e-13)$value / z
    lower <- stats::uniroot(function(q) cdf(q) - 0.025, c(5, 15), tol = 1e-13)$root; upper <- stats::uniroot(function(q) cdf(q) - 0.975, c(5, 15), tol = 1e-13)$root
    better <- stats::integrate(function(t) dens(t) / z * stats::pnorm((trt$mean - t) / (hist$sd / sqrt(trt$n))), 5, 15, rel.tol = 1e-13)$value
    worst <- max(worst, abs(rows$mean$value - mean_), abs(rows$lower$value - lower), abs(rows$upper$value - upper), abs(rows$probabilityBetter$value - better))
  }
  ess <- vcr_bw_prior_ess("continuous", list(mix = vcr_bw_prior("continuous", list(kind = "power", a0 = 0.3), hist, 11, 60)$mix, kind = "power", vague = NA_real_), hist)
  list(pass = worst < 1e-8 && abs(ess - 0.3 * 120) < 1e-9,
       detail = sprintf("a mean (10, sd 4, 120 historical; 11 of 60 now; 12 of 120 treated) for a0 = 0, 0.3 and 1: posterior mean, interval and Pr(better) against the definition integrated numerically, worst difference %.2e; the prior effective sample size at a0 = 0.3 is %.6f (= 0.3 x 120)", worst, ess))
})

vcr_case("N91d", c("AC-30"), function() {
  suppressMessages(library(RBesT))
  hist <- list(x = 30, n = 100); n_c <- 30L; n_t <- 40L; alpha <- 0.025; spec <- .n91_spec(0.3)
  priors <- list(none = function(x) vcr_bw_prior_none("binary", spec, hist), chosen = function(x) vcr_bw_prior("binary", spec, hist, x, n_c))
  oc <- vcr_bw_oc_binary(priors, hist, n_c, n_t, c(-0.1, 0, 0.1), 0.15, alpha)
  # the decision of every pair of counts by RBesT, one pmixdiff per pair (slow, so a small trial), then the enumeration
  decide <- function(prior_of) {
    D <- matrix(0, n_t + 1L, n_c + 1L)
    for (xc in 0:n_c) { post <- vcr_bw_post_binary(prior_of(xc)$mix, xc, n_c)
      for (xt in 0:n_t) D[xt + 1L, xc + 1L] <- as.numeric(1 - RBesT::pmixdiff(mixbeta(c(1, 1 + xt, 1 + n_t - xt)), mixbeta(c(1, post$alpha, post$beta)), 0) > 1 - alpha) }
    D
  }
  Dn <- decide(priors$none); Dc <- decide(priors$chosen)
  worst <- 0
  for (r in oc) {
    tc <- r$controlValue
    for (which in c("none", "chosen")) {
      D <- if (which == "none") Dn else Dc
      ref_null <- sum(outer(stats::dbinom(0:n_t, n_t, tc), stats::dbinom(0:n_c, n_c, tc)) * D)
      ref_alt <- sum(outer(stats::dbinom(0:n_t, n_t, tc + 0.15), stats::dbinom(0:n_c, n_c, tc)) * D)
      worst <- max(worst, abs(ref_null - r$perPrior[[which]]$typeOneError), abs(ref_alt - r$perPrior[[which]]$power))
    }
  }
  # a simulation of the chosen rule at the largest drift, using the engine's decision matrix: 200,000 trials
  set.seed(9101L, kind = VCR_RNG_KIND)
  K <- 200000L; tc <- oc[[3L]]$controlValue
  xc <- stats::rbinom(K, n_c, tc); xt_null <- stats::rbinom(K, n_t, tc); xt_alt <- stats::rbinom(K, n_t, tc + 0.15)
  sim_null <- mean(Dc[cbind(xt_null + 1L, xc + 1L)]); sim_alt <- mean(Dc[cbind(xt_alt + 1L, xc + 1L)])
  e_null <- oc[[3L]]$perPrior$chosen$typeOneError; e_alt <- oc[[3L]]$perPrior$chosen$power
  z_null <- (sim_null - e_null) / sqrt(e_null * (1 - e_null) / K); z_alt <- (sim_alt - e_alt) / sqrt(e_alt * (1 - e_alt) / K)
  list(pass = worst < 1e-9 && abs(z_null) < 3 && abs(z_alt) < 3,
       detail = sprintf("30 and 40 patients, historical 30/100, a0 = 0.3, drifts -0.1, 0 and 0.1: type I error and power of the rule with and without borrowing against an enumeration whose every decision is RBesT::pmixdiff, worst difference %.2e (type I error at drift 0.1: %.5f with borrowing, %.5f without); 200,000 simulated trials at drift 0.1: %.5f against %.5f (%.2f errors) and power %.5f against %.5f (%.2f errors)",
                        worst, e_null, oc[[3L]]$perPrior$none$typeOneError, sim_null, e_null, z_null, sim_alt, e_alt, z_alt))
})

vcr_case("N91e", c("AC-30"), function() {
  hist <- list(mean = 10, sd = 4, n = 120); n_c <- 60; n_t <- 90; a0 <- 0.4; alpha <- 0.025; effect <- 1.5; s <- hist$sd
  spec <- list(kind = "power", a0 = a0)
  oc <- vcr_bw_oc_normal(list(none = "none", chosen = "power"), spec, hist, NULL, n_c, n_t, c(-2, -0.5, 0, 1, 2), effect, alpha)
  A <- a0 * hist$n; v_post <- s^2 / (A + n_c); sd0 <- sqrt(s^2 / n_t + v_post)
  closed <- function(tc, eff) {
    mu_mean <- (A * hist$mean + n_c * tc) / (A + n_c)                    # the expectation of the posterior mean
    sd_d <- sqrt(s^2 / n_t + n_c * s^2 / (A + n_c)^2)                    # the sd of (observed treatment mean - posterior mean)
    1 - stats::pnorm((stats::qnorm(1 - alpha) * sd0 - (tc + eff - mu_mean)) / sd_d)
  }
  worst <- max(vapply(oc, function(r) max(abs(r$perPrior$chosen$typeOneError - closed(r$controlValue, 0)), abs(r$perPrior$chosen$power - closed(r$controlValue, effect))), numeric(1)))
  none_err <- max(vapply(oc, function(r) abs(r$perPrior$none$typeOneError - alpha), numeric(1)))
  bias_err <- max(vapply(oc, function(r) abs(r$perPrior$chosen$bias - (A * (hist$mean - r$controlValue) / (A + n_c))), numeric(1)))
  list(pass = worst < 1e-7 && none_err < 1e-7 && bias_err < 1e-9,
       detail = sprintf("a mean, a0 = 0.4, 60 and 90 patients, drifts -2 to 2: type I error and power against their closed form (posterior mean linear in the observed mean): worst difference %.2e (type I error at drift 2: %.5f); with no borrowing the type I error is alpha (worst difference %.1e); the bias is A (historical - true) / (A + n) (difference %.1e)",
                        worst, oc[[5L]]$perPrior$chosen$typeOneError, none_err, bias_err))
})
