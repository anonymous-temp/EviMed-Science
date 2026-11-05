# N92 — the self-adapting mixture (SAM) prior (algorithm round C11, 2026-11-03): comparator.borrowing, prior.kind sam.
#
# "借用多少由数据决定时结果如何": Yang et al. 2023. The informative prior is mixed with a vague one at w = R / (1 + R), R the likelihood of the
# current control data at the historical value over its largest value at the historical value +- delta. Held to SAMprior and RBesT, which are
# the CI-only checks (never called from R/*.R):
#
#   a  the weight, binary (126 combinations of historical and current counts and delta) and normal, against SAMprior::SAM_weight. They agree to
#      1e-12 wherever both sides of the alternative exist; where theta_h - delta or theta_h + delta is not a rate the package clamps it to
#      [0.01, 0.99] and the engine drops that side (the header of borrowing.R says why), so those combinations are counted apart
#   b  the prior and the posterior of a rate, component by component (weights, shapes), against SAMprior::SAM_prior and RBesT::postmix; the
#      probability that the treatment is better against RBesT::pmixdiff; the normal posterior against RBesT::postmix
#   c  the operating characteristics of a rate (type I error, power, bias, the mean weight) over drifts against SAMprior::eval_oc_bin_2arm, which
#      enumerates every pair of counts and integrates each posterior probability: the same quantities, an independent computation
#   d  the same for a mean against SAMprior::eval_oc_cont_2arm (its treatment prior made flat, as the engine's is)
#   e  the large-sample limits of Theorem 1: the weight goes to 1 when the current data are as the history says and to 0 when they sit a delta away

vcr_case("N92a", c("AC-30"), function() {
  suppressMessages({ library(SAMprior); library(RBesT) })
  n_in <- 0L; worst <- 0; clamped <- 0L; clamped_apart <- 0L
  for (xh in c(30, 90, 12)) for (nh in c(100, 300)) for (x in c(5, 20, 45, 80)) for (n in c(60, 150)) for (dl in c(0.05, 0.1, 0.2)) {
    if (xh > nh || x > n) next
    th <- (1 + xh) / (2 + nh)
    mine <- vcr_bw_sam_weight_binary(th, dl, x, n)
    ref <- suppressMessages(SAM_weight(if.prior = mixbeta(inf = c(1, 1 + xh, 1 + nh - xh)), theta.h = th, method.w = "LRT", n = n, r = x, delta = dl))
    if (th + dl <= 0.99 && th - dl >= 0.01) { n_in <- n_in + 1L; worst <- max(worst, abs(mine - ref)) }
    else { clamped <- clamped + 1L; if (abs(mine - ref) > 1e-12) clamped_apart <- clamped_apart + 1L }
  }
  worst_n <- 0
  for (m in c(-0.3, 0, 0.05, 0.4)) for (dl in c(0.1, 0.3)) for (n in c(10, 50, 400)) {
    ref <- suppressMessages(SAM_weight(if.prior = mixnorm(inf = c(1, 0, 1 / sqrt(100)), sigma = 1), theta.h = 0, method.w = "LRT", delta = dl, m = m, n = n, sigma = 1))
    worst_n <- max(worst_n, abs(ref - vcr_bw_sam_weight_normal(0, dl, m, n, 1)))
  }
  list(pass = worst < 1e-12 && worst_n < 1e-12 && n_in >= 60L,
       detail = sprintf("%d binary combinations with both sides of the alternative inside [0.01, 0.99]: the weight equals SAMprior::SAM_weight (worst difference %.1e); %d combinations where a side is not a rate (the package clamps it, the engine drops it): %d of them differ, as the header says; 24 normal combinations (summary form, sigma known): worst difference %.1e",
                        n_in, worst, clamped, clamped_apart, worst_n))
})

vcr_case("N92b", c("AC-30"), function() {
  suppressMessages({ library(SAMprior); library(RBesT) })
  hist <- list(x = 90, n = 300); cur <- list(x = 40, n = 150); trt <- list(x = 100, n = 300)
  spec <- list(kind = "sam", delta = 0.1, va = 1, vb = 1)
  worst <- 0
  for (x in c(12, 40, 55, 70)) {
    pr <- vcr_bw_prior("binary", spec, hist, x, cur$n)
    ref_prior <- SAM_prior(if.prior = mixbeta(inf = c(1, 91, 211)), nf.prior = mixbeta(nf = c(1, 1, 1)), weight = pr$weight)
    ref_post <- postmix(ref_prior, r = x, n = cur$n)
    mine <- vcr_bw_post_binary(pr$mix, x, cur$n)
    rp <- ref_post[]
    worst <- max(worst, abs(unlist(ref_prior[1, ]) - pr$mix$weight), abs(sort(rp[1, ]) - sort(mine$weight)), abs(rp[2, order(-rp[1, ])] - mine$alpha[order(-mine$weight)]), abs(rp[3, order(-rp[1, ])] - mine$beta[order(-mine$weight)]))
  }
  pr <- vcr_bw_prior("binary", spec, hist, cur$x, cur$n); post <- vcr_bw_post_binary(pr$mix, cur$x, cur$n)
  ref_post <- postmix(SAM_prior(if.prior = mixbeta(inf = c(1, 91, 211)), nf.prior = mixbeta(nf = c(1, 1, 1)), weight = pr$weight), r = cur$x, n = cur$n)
  p_ref <- 1 - pmixdiff(mixbeta(c(1, 1 + trt$x, 1 + trt$n - trt$x)), ref_post, 0)
  p_mine <- vcr_bw_better_binary(trt$x, trt$n, post)
  # a mean: the posterior mixture against RBesT::postmix on the normal mixture
  h <- list(mean = 10, sd = 4, n = 120); sp <- list(kind = "sam", delta = 2)
  worst_n <- 0
  for (y in c(9, 10, 10.7, 12.5)) {
    prn <- vcr_bw_prior("continuous", sp, h, y, 60); postn <- vcr_bw_post_normal(prn$mix, y, 60, h$sd)
    ref <- postmix(mixnorm(inf = c(prn$weight, 10, 4 / sqrt(120)), nf = c(1 - prn$weight, 10, 4), sigma = 4), m = y, se = 4 / sqrt(60))
    rp <- ref[]
    worst_n <- max(worst_n, abs(sort(rp[1, ]) - sort(postn$weight)), abs(sort(rp[2, ]) - sort(postn$mean)), abs(sort(rp[3, ]) - sort(postn$sd)))
    pv <- .vcr_bw_post_vec("sam", sp, h, NULL, y, 60)                      # the vectorised posterior the quadrature uses is the same posterior
    worst_n <- max(worst_n, abs(sort(pv$w[1, ]) - sort(postn$weight)), abs(sort(pv$m[1, ]) - sort(postn$mean)), abs(sort(pv$s[1, ]) - sort(postn$sd)))
  }
  list(pass = worst < 1e-10 && abs(p_ref - p_mine) < 1e-9 && worst_n < 1e-10,
       detail = sprintf("a rate (90/300 historical, delta 0.1) at four current counts: the SAM prior's weights and the posterior's weights and shapes equal SAMprior::SAM_prior and RBesT::postmix (worst difference %.1e); Pr(treatment better) %.8f against RBesT::pmixdiff %.8f; a mean (10, sd 4, 120; delta 2) at four current means: the posterior mixture equals RBesT::postmix and the vectorised posterior of the quadrature equals the scalar one (worst difference %.1e)",
                        worst, p_mine, p_ref, worst_n))
})

vcr_case("N92c", c("AC-30"), function() {
  suppressMessages({ library(SAMprior); library(RBesT) })
  hist <- list(x = 90, n = 300); n_c <- 150L; n_t <- 300L; dl <- 0.1; alpha <- 0.025
  spec <- list(kind = "sam", delta = dl, va = 1, vb = 1)
  priors <- list(none = function(x) vcr_bw_prior_none("binary", spec, hist), chosen = function(x) vcr_bw_prior("binary", spec, hist, x, n_c))
  oc <- vcr_bw_oc_binary(priors, hist, n_c, n_t, c(-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15), 0.1, alpha)
  ifp <- mixbeta(inf = c(1, 91, 211)); nfp <- mixbeta(nf = c(1, 1, 1))
  worst <- 0; rows <- character()
  for (r in oc) {
    tc <- r$controlValue
    null <- eval_oc_bin_2arm(ifp, nfp, nfp, theta = tc, theta.t = tc, n.t = n_t, n = n_c, delta = dl, method = c("SAM", "NP"), cutoff = 1 - alpha)
    alt <- eval_oc_bin_2arm(ifp, nfp, nfp, theta = tc, theta.t = tc + 0.1, n.t = n_t, n = n_c, delta = dl, method = c("SAM", "NP"), cutoff = 1 - alpha)
    d <- c(abs(r$perPrior$chosen$typeOneError - null$reject_prob[1]), abs(r$perPrior$chosen$power - alt$reject_prob[1]), abs(r$perPrior$chosen$bias - null$bias[1]),
           abs(r$perPrior$chosen$weight - null$mean_weight[1]), abs(r$perPrior$none$typeOneError - null$reject_prob[2]), abs(r$perPrior$none$power - alt$reject_prob[2]))
    worst <- max(worst, d)
    rows <- c(rows, sprintf("%+.2f: %.4f/%.4f", r$drift, r$perPrior$chosen$typeOneError, r$perPrior$chosen$weight))
  }
  list(pass = worst < 1e-8,
       detail = sprintf("a rate, 150 control and 300 treated, historical 90/300, delta 0.1, seven drifts: type I error, power, bias and mean weight of the SAM rule and the no-borrowing rule equal SAMprior::eval_oc_bin_2arm (worst difference %.1e); type I error / mean weight by drift: %s",
                        worst, paste(rows, collapse = "  ")))
})

vcr_case("N92d", c("AC-30"), function() {
  suppressMessages({ library(SAMprior); library(RBesT) })
  hist <- list(mean = 10, sd = 4, n = 120); n_c <- 60; n_t <- 120; alpha <- 0.025; effect <- 1.5; spec <- list(kind = "sam", delta = 2)
  oc <- vcr_bw_oc_normal(list(none = "none", chosen = "sam"), spec, hist, NULL, n_c, n_t, c(-2, -1, 0, 1, 2), effect, alpha)
  ifp <- mixnorm(inf = c(1, 10, 4 / sqrt(120)), sigma = 4); nfp <- mixnorm(nf = c(1, 10, 4), sigma = 4)
  flat <- mixnorm(nf = c(1, 10, 4 / sqrt(1e-9)), sigma = 4)               # the treatment arm's prior, flat as the engine's
  worst <- 0
  for (r in oc) {
    tc <- r$controlValue
    null <- eval_oc_cont_2arm(ifp, nfp, flat, theta = tc, theta.t = tc, n.t = n_t, n = n_c, delta = 2, method = "SAM", cutoff = 1 - alpha, sigma = 4, sigma.t = 4)
    alt <- eval_oc_cont_2arm(ifp, nfp, flat, theta = tc, theta.t = tc + effect, n.t = n_t, n = n_c, delta = 2, method = "SAM", cutoff = 1 - alpha, sigma = 4, sigma.t = 4)
    worst <- max(worst, abs(r$perPrior$chosen$typeOneError - null$reject_prob), abs(r$perPrior$chosen$power - alt$reject_prob),
                 abs(r$perPrior$chosen$bias - null$bias), abs(r$perPrior$chosen$weight - null$mean_weight))
  }
  list(pass = worst < 1e-6,
       detail = sprintf("a mean (10, sd 4, 120 historical; 60 and 120 now; delta 2; effect 1.5), five drifts: type I error, power, bias and mean weight of the SAM rule equal SAMprior::eval_oc_cont_2arm (worst difference %.1e; the engine integrates on 4,001 nodes, the package by QUADPACK); at drift 1 the type I error is %.4f against %.4f with no borrowing",
                        worst, oc[[4L]]$perPrior$chosen$typeOneError, oc[[4L]]$perPrior$none$typeOneError))
})

vcr_case("N92e", c("AC-30"), function() {
  th <- (1 + 900) / (2 + 3000)                                          # a large history: 900 of 3000
  w <- function(x, n, dl = 0.1) vcr_bw_sam_weight_binary(th, dl, x, n)
  n <- 4000
  agree <- w(round(n * th), n); apart_up <- w(round(n * (th + 0.1)), n); apart_down <- w(round(n * (th - 0.1)), n)
  w1 <- function(n) vcr_bw_sam_weight_normal(0, 0.3, 0, n, 1); w2 <- function(n) vcr_bw_sam_weight_normal(0, 0.3, 0.3, n, 1)
  # the mixture is the engine's robustify of the informative component, at the weight 1 - w
  pr <- vcr_bw_prior("continuous", list(kind = "sam", delta = 0.3), list(mean = 0, sd = 1, n = 100), 0.1, 50)
  rob <- vcr_robustify(data.frame(weight = 1, mean = 0, sd = 1 / sqrt(100)), 1 - pr$weight, vague_mean = 0, vague_sd = 1)
  list(pass = agree > 0.999999 && apart_up < 1e-6 && apart_down < 1e-6 && w1(5000) > 0.999999 && w2(5000) < 1e-6 && w1(20) < w1(5000) && isTRUE(all.equal(pr$mix, rob)),
       detail = sprintf("Theorem 1: with 4,000 current patients the weight is %.8f when their rate is the history's, %.2e a delta above it and %.2e a delta below it; for a mean with 5,000 patients %.8f at the historical value and %.2e a delta away (it needs patients to be sure: 20 patients %.4f); the prior mixture is exactly the engine's robustify of the informative component at 1 - w",
                        agree, apart_up, apart_down, w1(5000), w2(5000), w1(20)))
})
