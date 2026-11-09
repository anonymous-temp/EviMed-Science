# N130 -- individualization: a person's own history turned into a forecast for that person (plan R32, 2026-11-09)
#
# The mixed model is held to `nlme::lme` (an oracle of R's own recommended library, never called from R/), the Gaussian posterior to the BLUPs
# nlme computes for the same covariance and to a brute-force grid for the Alzheimer model, and the intervals to the only thing that settles an
# interval: known truth. The people are drawn from the model itself, so the nominal level is the right answer and the case measures the
# approximation, not the model.
#
#   a  the REML fit against nlme::lme (fixed effects, the two SDs, their correlation, the residual SD) on balanced and on unbalanced visit times
#   b  the exact posterior of a person's random effects and the predictive mean against nlme's own BLUPs at the same covariance
#   c  the linear mixed model on held-out visits of fresh people: coverage of the 50/80/95% intervals within three Monte Carlo SE of nominal,
#      for the individualized and for the population forecast, and individualization beats the population forecast on error
#   d  the beta_logit Laplace posterior of the intercept and slope against a two-dimensional grid integration of the same posterior
#   e  the beta_logit predictive intervals on held-out visits of 4,000 simulated people: coverage within three Monte Carlo SE of nominal
#   f  no history is the population forecast to the bit; more history narrows the posterior; the same seed gives the same draws

.n130_sim <- function(n, seed, times = 0:4, drop = 0) {
  set.seed(seed)
  id <- rep(seq_len(n), each = length(times)); t <- rep(times, n)
  b0 <- stats::rnorm(n, 0, 1.0); b1 <- stats::rnorm(n, 0, 0.3)
  x <- stats::rnorm(n)
  y <- 2 + 0.5 * t + 0.8 * x[id] + b0[id] + b1[id] * t + stats::rnorm(length(t), 0, 0.5)
  d <- data.frame(id = id, t = t, x = x[id], y = y)
  if (drop > 0) d <- d[stats::runif(nrow(d)) > drop | d$t == 0, ]
  d
}
.n130_X <- function(d) cbind("(Intercept)" = 1, t = d$t, x = d$x)

vcr_case("N130a", c("AC-04"), function() {
  bal <- .n130_sim(300L, 13001L); unb <- .n130_sim(300L, 13002L, times = c(0, 0.5, 1.5, 3, 4), drop = 0.3)
  worst <- 0
  detail <- character(0)
  for (nm in c("balanced", "unbalanced")) {
    d <- if (nm == "balanced") bal else unb
    f <- vcr_lmm_fit(d$y, .n130_X(d), d$t, d$id)
    m <- nlme::lme(y ~ t + x, random = ~ t | id, data = d, method = "REML")
    Gm <- nlme::getVarCov(m); sds <- sqrt(diag(Gm)); rho <- Gm[1, 2] / prod(sds); sg <- m$sigma
    gap <- max(abs(f$beta - nlme::fixef(m)) / pmax(abs(nlme::fixef(m)), 1), abs(f$sd0 - sds[1]) / sds[1], abs(f$sd1 - sds[2]) / sds[2], abs(f$rho - rho), abs(f$sigma - sg) / sg,
               abs(sqrt(diag(f$vcov)) - sqrt(diag(stats::vcov(m)))) / sqrt(diag(stats::vcov(m))))
    worst <- max(worst, gap)
    detail <- c(detail, sprintf("%s: max relative gap to nlme %.2e (sd0 %.4f/%.4f, sd1 %.4f/%.4f, rho %.4f/%.4f, sigma %.4f/%.4f)", nm, gap, f$sd0, sds[1], f$sd1, sds[2], f$rho, rho, f$sigma, sg))
  }
  list(pass = worst < 1e-4, detail = paste(c(detail, "tolerance 1e-4"), collapse = "; "))
})

vcr_case("N130b", c("AC-04"), function() {
  d <- .n130_sim(200L, 13003L, drop = 0.2)
  f <- vcr_lmm_fit(d$y, .n130_X(d), d$t, d$id)
  m <- nlme::lme(y ~ t + x, random = ~ t | id, data = d, method = "REML")
  re <- nlme::ranef(m)
  # the same covariance for both: nlme's BLUP is the posterior mean at ITS covariance, so predict with its parameters
  Gm <- nlme::getVarCov(m)
  f2 <- f; f2$beta <- nlme::fixef(m); f2$vcov <- stats::vcov(m); f2$sigma <- m$sigma
  s0 <- sqrt(Gm[1, 1]); s1 <- sqrt(Gm[2, 2]); r <- Gm[1, 2] / (s0 * s1)
  f2$theta <- c(log(s0), log(s1), atanh(r), log(f2$sigma))
  gap <- 0; ygap <- 0
  for (i in 1:60) {
    h <- d[d$id == i, ]
    p <- vcr_lmm_individualize(f2, X_new = cbind(1, 6, h$x[1]), t_new = 6, X_hist = .n130_X(h), t_hist = h$t, y_hist = h$y)
    gap <- max(gap, abs(p$randomEffects - as.numeric(re[as.character(i), ])))
    ref <- sum(c(1, 6, h$x[1]) * nlme::fixef(m)) + sum(c(1, 6) * as.numeric(re[as.character(i), ]))
    ygap <- max(ygap, abs(p$mean - ref))
  }
  # the posterior covariance against the brute-force one: (Z'Z / sigma^2 + G^-1)^-1
  h <- d[d$id == 5, ]; Z <- cbind(1, h$t); G <- .vcr_lmm_G(f2$theta)
  brute <- solve(crossprod(Z) / f2$sigma^2 + solve(G))
  p5 <- vcr_lmm_individualize(f2, cbind(1, 6, h$x[1]), 6, .n130_X(h), h$t, h$y)
  cgap <- max(abs(p5$randomEffectsCov - brute))
  list(pass = gap < 1e-6 && ygap < 1e-6 && cgap < 1e-10,
       detail = sprintf("60 people: BLUP gap to nlme::ranef %.2e, predictive mean gap %.2e; posterior covariance gap to (Z'Z/s2+G^-1)^-1 %.2e; tolerances 1e-6, 1e-6, 1e-10", gap, ygap, cgap))
})

vcr_case("N130c", c("AC-04", "AC-28"), function() {
  train <- .n130_sim(800L, 13004L)
  f <- vcr_lmm_fit(train$y, .n130_X(train), train$t, train$id)
  test <- .n130_sim(3000L, 13005L); ids <- unique(test$id)
  hist_t <- 0:2; new_t <- 3:4
  ind <- pop <- vector("list", length(ids)); truth <- matrix(NA_real_, length(ids), 2L); err_i <- err_p <- numeric(0)
  for (k in seq_along(ids)) {
    h <- test[test$id == ids[k] & test$t %in% hist_t, ]; nw <- test[test$id == ids[k] & test$t %in% new_t, ]
    Xn <- cbind(1, nw$t, nw$x)
    a <- vcr_lmm_individualize(f, Xn, nw$t, .n130_X(h), h$t, h$y); b <- vcr_lmm_population_predict(f, Xn, nw$t)
    ind[[k]] <- a; pop[[k]] <- b; truth[k, ] <- nw$y
  }
  cover <- function(lst) sapply(c(0.5, 0.8, 0.95), function(l) {
    z <- stats::qnorm(1 - (1 - l) / 2)
    hit <- unlist(lapply(seq_along(lst), function(k) abs(truth[k, ] - lst[[k]]$mean) <= z * lst[[k]]$sd))
    c(p = mean(hit), se = sqrt(mean(hit) * (1 - mean(hit)) / length(hit)))
  })
  ci <- cover(ind); cp <- cover(pop)
  # the two columns of one person are correlated, so the effective sample is between n and 2n: use n people for the SE
  z <- function(cv) max(abs(cv["p", ] - c(0.5, 0.8, 0.95)) / (cv["se", ] * sqrt(2)))
  mae_i <- mean(abs(truth - t(sapply(ind, function(a) a$mean)))); mae_p <- mean(abs(truth - t(sapply(pop, function(a) a$mean))))
  list(pass = z(ci) <= 3 && z(cp) <= 3 && mae_i < mae_p,
       detail = sprintf("individualized coverage %s, population %s (nominal .50/.80/.95, %d people x 2 held-out visits, SE inflated by sqrt 2 for within-person correlation, largest deviation %.2f / %.2f SE; limit 3); MAE %.3f individualized vs %.3f population",
                        paste(sprintf("%.3f", ci["p", ]), collapse = "/"), paste(sprintf("%.3f", cp["p", ]), collapse = "/"), length(ids), z(ci), z(cp), mae_i, mae_p))
})

.n130_bl <- function() {
  set <- vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0")
  par <- vcr_beta_logit_par(set$medians)
  list(par = par, study = vcr_beta_logit_typical_study(par))
}

vcr_case("N130d", c("AC-04"), function() {
  m <- .n130_bl(); par <- m$par; study <- m$study
  set.seed(13006L)
  q <- .vcr_bl_draw_people(par, study, 6L)
  worst_mean <- 0; worst_sd <- 0
  for (i in 1:6) {
    th <- function(t) stats::plogis(q$eta[i] + q$alpha[i] * t + vcr_beta_logit_placebo(par, t))
    t_obs <- c(0, 13, 26); sc <- vcr_beta_logit_scores(th(t_obs), study$tau)
    cv <- list(mmse = q$mmse[i], age = q$age[i], apoe = q$apoe[i], female = q$female[i])
    post <- vcr_beta_logit_individual_posterior(par, study, cv, t_obs, sc)
    # the independent computation: the posterior on a fine grid of (intercept, slope), normalised by summation
    sd_e <- study$sdEta; sd_a <- study$sdAlpha; mu <- post$prior$mean
    ge <- seq(mu[1] - 5 * sd_e, mu[1] + 5 * sd_e, length.out = 400); ga <- seq(mu[2] - 5 * sd_a, mu[2] + 5 * sd_a, length.out = 400)
    u <- pmin(pmax(sc / 70, 1e-6), 1 - 1e-6); pbo <- vcr_beta_logit_placebo(par, t_obs); g <- .VCR_BETA_LOGIT_GUARD
    lp <- outer(ge, ga, Vectorize(function(e, a) {
      thx <- stats::plogis(e + a * t_obs + pbo)
      sum(stats::dbeta(u, (thx + g) * study$tau, (1 - thx + g) * study$tau, log = TRUE)) + stats::dnorm(e, mu[1], sd_e, log = TRUE) + stats::dnorm(a, mu[2], sd_a, log = TRUE)
    }))
    w <- exp(lp - max(lp)); w <- w / sum(w)
    me <- sum(w * ge); ma <- sum(w * rep(ga, each = length(ge)))
    se <- sqrt(sum(w * (ge - me)^2)); sa <- sqrt(sum(w * (rep(ga, each = length(ge)) - ma)^2))
    # the grid's posterior sd is what the Laplace sd approximates; the mode and the mean differ by the skew, so the mean is held to a fraction of that sd
    worst_mean <- max(worst_mean, abs(post$mode[1] - me) / se, abs(post$mode[2] - ma) / sa)
    worst_sd <- max(worst_sd, abs(sqrt(post$cov[1, 1]) / se - 1), abs(sqrt(post$cov[2, 2]) / sa - 1))
  }
  list(pass = worst_mean <= 0.35 && worst_sd <= 0.2,
       detail = sprintf("6 simulated people, 3 visits: the MAP is within %.2f posterior SD of the grid posterior mean (limit 0.35) and the Laplace SD within %.1f%% of the grid SD (limit 20%%)", worst_mean, 100 * worst_sd))
})

vcr_case("N130e", c("AC-04", "AC-28"), function() {
  m <- .n130_bl(); par <- m$par; study <- m$study
  set.seed(13007L); n <- 4000L
  q <- .vcr_bl_draw_people(par, study, n)
  th <- function(t) stats::plogis(q$eta + q$alpha * t + vcr_beta_logit_placebo(par, t))
  hist_t <- c(0, 13, 26); new_t <- c(52, 78)
  sc <- vapply(c(hist_t, new_t), function(t) vcr_beta_logit_scores(th(t), study$tau), numeric(n))
  ind <- lapply(seq_len(n), function(i)
    vcr_beta_logit_individual_predict(par, study, list(mmse = q$mmse[i], age = q$age[i], apoe = q$apoe[i], female = q$female[i]), hist_t, sc[i, 1:3], new_t, 500L))
  cov_j <- lapply(1:2, function(j) vcr_interval_coverage(lapply(ind, function(d) d[, j]), sc[, 3 + j]))
  dev <- unlist(lapply(cov_j, function(cv) abs(cv$coverage - cv$level) / cv$mcse))
  ok_laplace <- mean(vapply(ind, function(d) isTRUE(attr(d, "laplaceOk")), logical(1)))
  list(pass = max(dev) <= 3 && ok_laplace > 0.99,
       detail = sprintf("held-out week 52: %s; week 78: %s (nominal .50/.80/.95, n = %d, MCSE %.4f-%.4f); largest deviation %.2f MCSE (limit 3); Laplace curvature positive definite for %.1f%% of people",
                        paste(sprintf("%.3f", cov_j[[1]]$coverage), collapse = "/"), paste(sprintf("%.3f", cov_j[[2]]$coverage), collapse = "/"), n,
                        min(cov_j[[1]]$mcse, cov_j[[2]]$mcse), max(cov_j[[1]]$mcse, cov_j[[2]]$mcse), max(dev), 100 * ok_laplace))
})

vcr_case("N130f", c("AC-04"), function() {
  m <- .n130_bl(); par <- m$par; study <- m$study
  cv <- list(mmse = 22, age = 74, apoe = 1L, female = 0)
  set.seed(13008L); a <- vcr_beta_logit_individual_predict(par, study, cv, numeric(0), numeric(0), c(26, 52), 200L)
  set.seed(13008L); b <- vcr_beta_logit_individual_predict(par, study, cv, numeric(0), numeric(0), c(26, 52), 200L)
  prior_sd <- vcr_beta_logit_individual_posterior(par, study, cv, 0, 35)$prior$sd
  # a person observed once, then three times, then seven: the posterior SD of the slope falls
  th <- function(t) stats::plogis(-0.6 + 0.01 * t + vcr_beta_logit_placebo(par, t))
  set.seed(13009L)
  sds <- vapply(list(0, c(0, 13, 26), c(0, 13, 26, 39, 52, 65, 78)), function(t) {
    sqrt(vcr_beta_logit_individual_posterior(par, study, cv, t, vcr_beta_logit_scores(th(t), study$tau))$cov[2, 2]) }, numeric(1))
  d <- .n130_sim(100L, 13010L); fit <- vcr_lmm_fit(d$y, .n130_X(d), d$t, d$id)
  p0 <- vcr_lmm_individualize(fit, cbind(1, 5, 0), 5, NULL, NULL, numeric(0)); p1 <- vcr_lmm_population_predict(fit, cbind(1, 5, 0), 5)
  list(pass = identical(a, b) && all(diff(sds) < 0) && sds[1] <= prior_sd[2] * 1.0001 && identical(p0$mean, p1$mean) && identical(p0$sd, p1$sd),
       detail = sprintf("same seed gives identical draws; posterior SD of the slope %.5f / %.5f / %.5f for 1, 3, 7 visits (prior %.5f); an empty history is the population forecast, mean %.4f SD %.4f",
                        sds[1], sds[2], sds[3], prior_sd[2], p0$mean, p0$sd))
})
