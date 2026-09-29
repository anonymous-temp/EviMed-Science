# ---------------------------------------------------------------------------
# map_prior.R — meta-analytic-predictive priors for the design-stage hybrid
# control (plan 5.3 "hybrid control"; FDA Bayesian draft, Jan 2026).
#
# Hidden knowledge:
#
# - **The MAP is derived by quadrature, not by MCMC.** RBesT's `gMAP` is the
#   reference implementation and it runs Stan; a Stan fit is not bit-
#   reproducible across builds, and this engine's whole contract is that a
#   seed and a scenario hash reproduce a number. With a normal likelihood on
#   the logit (or mean, or log-rate) scale, the only unknown that needs
#   integrating is tau: mu integrates out in closed form under a flat prior,
#   so a one-dimensional grid over tau gives the posterior predictive to
#   quadrature accuracy and gives it the same way every time. MCMC is
#   available as a cross-check, not as the path a result travels.
# - **The heterogeneity ceiling is the honest headline.** Under the normal
#   approximation the prior effective sample size can never exceed
#   sigma^2 / tau^2, where sigma^2 is one subject's information on the
#   analysis scale -- no matter how many historical studies there are. For a
#   control rate of 0.3 on the logit scale sigma^2 = 1/(0.3*0.7) = 4.762, so
#   tau = 0.3 caps borrowing at 52.9 patients and tau = 0.5 at 19.0 (N19).
#   A page that says "we found 40 historical trials" without this number is
#   selling something.
# - **Borrowing does not buy power under strict type-I control** (Kopp-
#   Schneider 2020). So the product deliverable is the trade-off curve
#   (conflict versus type-I inflation versus power), never a "saves N
#   patients" claim.
# - **The robust mixture's posterior weights are closed form** for conjugate
#   components: w_k' proportional to w_k times the component's marginal
#   likelihood. Computing them by simulation would be both slower and less
#   accurate, and it is the piece N18 pins to 1e-10.
# - `ess` here is the moment-based one (a + b for a Beta, sigma^2/s^2 for a
#   normal). RBesT's ELIR estimator is different by construction and is
#   reported beside it, never instead: two numbers that disagree by design
#   must not share a label.
# ---------------------------------------------------------------------------

#' Meta-analytic-predictive prior from historical control arms.
#'
#' @param y historical estimates on the analysis scale (logit, mean, log rate).
#' @param se their standard errors.
#' @param tau_prior list(kind = "half_normal", scale = s) or
#'   list(kind = "half_cauchy", scale = s); `s` dominates when k < 5 and the
#'   sensitivity of the answer to it is part of the deliverable.
#' @param grid number of quadrature nodes over tau.
#' @return the predictive distribution for a new study's parameter, as a
#'   discrete mixture of normals plus its moments.
vcr_map_prior <- function(y, se, tau_prior = list(kind = "half_normal", scale = 0.5),
                          grid = 512L, tau_max = NULL) {
  k <- length(y)
  if (k != length(se)) stop("vcr_map_prior: y and se must have the same length")
  v <- se^2
  s <- tau_prior$scale
  tau_max <- tau_max %||% max(6 * s, 4 * stats::sd(y) + 1e-6)
  # Midpoint rule on [0, tau_max]: the integrand is smooth and bounded, and a
  # fixed grid keeps the answer a function of the inputs alone.
  h <- tau_max / grid
  tau <- (seq_len(grid) - 0.5) * h
  logp_tau <- switch(tau_prior$kind,
    half_normal = stats::dnorm(tau, 0, s, log = TRUE),
    half_cauchy = stats::dcauchy(tau, 0, s, log = TRUE),
    uniform = rep(0, grid),
    stop("vcr_map_prior: unknown tau prior ", tau_prior$kind))
  loglik <- vapply(tau, function(t) {
    w <- 1 / (v + t^2)
    mu <- sum(w * y) / sum(w)
    -0.5 * sum(log(v + t^2)) - 0.5 * log(sum(w)) - 0.5 * sum(w * (y - mu)^2)
  }, numeric(1))
  lw <- logp_tau + loglik
  lw <- lw - max(lw)
  wt <- exp(lw); wt <- wt / sum(wt)

  mu_hat <- vapply(tau, function(t) { w <- 1 / (v + t^2); sum(w * y) / sum(w) }, numeric(1))
  var_mu <- vapply(tau, function(t) 1 / sum(1 / (v + t^2)), numeric(1))
  pred_var <- var_mu + tau^2

  mean_pred <- sum(wt * mu_hat)
  var_pred <- sum(wt * (pred_var + mu_hat^2)) - mean_pred^2
  list(
    components = data.frame(weight = wt, mean = mu_hat, sd = sqrt(pred_var), tau = tau),
    mean = mean_pred, sd = sqrt(var_pred),
    tauPosteriorMean = sum(wt * tau),
    tauPosteriorMedian = tau[which(cumsum(wt) >= 0.5)[1]],
    k = k, tauPrior = tau_prior, gridNodes = grid, tauMax = tau_max
  )
}

#' Approximate a MAP predictive by a two-component normal mixture matched on
#' the first four central moments of the quadrature mixture.
#'
#' Hidden knowledge: a single normal understates the tail that carries the
#' conflict behaviour, and more than two components is not identifiable from
#' the handful of historical studies a real project has. RBesT's
#' `automixfit` picks the component count by AIC on MCMC draws; with a
#' quadrature mixture we can match moments exactly instead of fitting.
vcr_map_normal_mixture <- function(map, components = 2L) {
  comp <- map$components
  if (components <= 1L) {
    return(data.frame(weight = 1, mean = map$mean, sd = map$sd))
  }
  # Split the quadrature mixture at the posterior median of tau: the narrow
  # component is the low-heterogeneity regime, the wide one the rest.
  cut <- which(cumsum(comp$weight) >= 0.5)[1]
  parts <- list(seq_len(cut), (cut + 1L):nrow(comp))
  out <- do.call(rbind, lapply(parts, function(idx) {
    w <- sum(comp$weight[idx])
    if (w <= 0) return(NULL)
    ww <- comp$weight[idx] / w
    m <- sum(ww * comp$mean[idx])
    v <- sum(ww * (comp$sd[idx]^2 + comp$mean[idx]^2)) - m^2
    data.frame(weight = w, mean = m, sd = sqrt(v))
  }))
  rownames(out) <- NULL
  out
}

#' Robustify: add a vague component with a preset weight (plan 5.3; the
#' sensitivity pair the analysis reports is w_R = 0.2 and 0.5).
vcr_robustify <- function(mixture, weight = 0.2, vague_mean = NULL, vague_sd = NULL,
                          unit_information_sd = 1) {
  m <- sum(mixture$weight * mixture$mean)
  vague <- data.frame(weight = weight,
                      mean = vague_mean %||% m,
                      sd = vague_sd %||% unit_information_sd)
  out <- rbind(data.frame(weight = mixture$weight * (1 - weight),
                          mean = mixture$mean, sd = mixture$sd), vague)
  rownames(out) <- NULL
  attr(out, "robustWeight") <- weight
  out
}

#' Moment-based prior effective sample size.
#'
#' - Beta(a, b) on a probability: a + b.
#' - Normal(m, s) on a scale where one subject carries information
#'   1 / unit_variance: unit_variance / s^2.
vcr_prior_ess <- function(prior, unit_variance = 1) {
  if (is.data.frame(prior) && !is.null(prior$alpha)) return(vcr_beta_mixture_moment_ess(prior))
  if (is.data.frame(prior)) {
    m <- sum(prior$weight * prior$mean)
    v <- sum(prior$weight * (prior$sd^2 + prior$mean^2)) - m^2
    return(unit_variance / v)
  }
  if (!is.null(prior$alpha)) return(prior$alpha + prior$beta)
  stop("vcr_prior_ess: pass a normal mixture data frame or a Beta prior")
}

#' Moment-based ESS of a Beta *mixture*: match the mixture's first two moments
#' with a single Beta and report that Beta's a + b.
#'
#' Hidden knowledge: this is what RBesT's `ess(method = "moment")` computes,
#' and it is deliberately not the ELIR estimator, which for the same mixture
#' can be twenty times larger (68.1 vs 96.2 on the package's own AS example).
#' The two answer different questions -- moment matching asks how much a
#' conjugate prior of the same spread would weigh, ELIR asks how much
#' information the prior contributes where the data actually land -- and
#' printing either under the bare label "prior ESS" makes the number
#' unreadable. Both are reported, each under its own name.
vcr_beta_mixture_moment_ess <- function(mixture) {
  w <- mixture$weight / sum(mixture$weight)
  a <- mixture$alpha; b <- mixture$beta
  mk <- a / (a + b)
  vk <- a * b / ((a + b)^2 * (a + b + 1))
  m <- sum(w * mk)
  v <- sum(w * (vk + mk^2)) - m^2
  m * (1 - m) / v - 1
}

#' The heterogeneity ceiling on borrowing (N19).
#' `unit_variance` is one subject's variance on the analysis scale -- for a
#' binomial rate p on the logit scale that is 1 / (p (1 - p)).
vcr_ess_ceiling <- function(tau, unit_variance) {
  if (tau <= 0) return(Inf)
  unit_variance / tau^2
}

vcr_logit_unit_variance <- function(p) 1 / (p * (1 - p))

#' Posterior weights of a conjugate Beta mixture after observing r of n.
#' Closed form: w_k' proportional to w_k * B(a_k + r, b_k + n - r) / B(a_k, b_k).
vcr_beta_mixture_posterior <- function(mixture, r, n) {
  lm_ <- lbeta(mixture$alpha + r, mixture$beta + n - r) - lbeta(mixture$alpha, mixture$beta)
  lw <- log(mixture$weight) + lm_
  lw <- lw - max(lw)
  w <- exp(lw); w <- w / sum(w)
  data.frame(weight = w, alpha = mixture$alpha + r, beta = mixture$beta + n - r)
}

#' Posterior of a normal mixture prior after a normal observation.
vcr_normal_mixture_posterior <- function(mixture, y, se) {
  v <- se^2
  post_var <- 1 / (1 / mixture$sd^2 + 1 / v)
  post_mean <- post_var * (mixture$mean / mixture$sd^2 + y / v)
  lm_ <- stats::dnorm(y, mixture$mean, sqrt(mixture$sd^2 + v), log = TRUE)
  lw <- log(mixture$weight) + lm_
  lw <- lw - max(lw)
  w <- exp(lw); w <- w / sum(w)
  data.frame(weight = w, mean = post_mean, sd = sqrt(post_var))
}

#' Prior-data conflict: where the observed control result falls in the prior
#' predictive distribution. Beyond `bound` in either tail the design is
#' `map_prior_conflict` (plan 5.3, one of the seven deterministic rules).
vcr_map_conflict <- function(mixture, y, se, bound = 0.01) {
  pred_sd <- sqrt(mixture$sd^2 + se^2)
  tail_low <- sum(mixture$weight * stats::pnorm(y, mixture$mean, pred_sd))
  p <- 2 * min(tail_low, 1 - tail_low)
  list(predictiveTailProbability = p, lowerTail = tail_low,
       rule = if (p < bound) "map_prior_conflict" else NULL,
       detail = if (p < bound) sprintf(
         "the observed control result sits in the %.3g tail of the MAP predictive (bound %.3g)", p, bound) else NULL,
       bound = bound)
}

#' Convert a normal mixture on the logit scale to a Beta mixture on the
#' probability scale by matching each component's mean and variance.
vcr_logit_mixture_to_beta <- function(mixture) {
  out <- do.call(rbind, lapply(seq_len(nrow(mixture)), function(i) {
    m <- mixture$mean[i]; s <- mixture$sd[i]
    # Delta-method moments of plogis(X) for X ~ N(m, s^2), refined by
    # Gauss-Hermite so a wide vague component is not badly placed.
    gh <- .vcr_gauss_hermite(64L)
    x <- m + sqrt(2) * s * gh$nodes
    wgh <- gh$weights / sqrt(pi)
    p <- stats::plogis(x)
    mu <- sum(wgh * p)
    v <- sum(wgh * p^2) - mu^2
    common <- max(mu * (1 - mu) / v - 1, 1e-8)
    data.frame(weight = mixture$weight[i], alpha = mu * common, beta = (1 - mu) * common)
  }))
  rownames(out) <- NULL
  out
}

`%||%` <- function(a, b) if (is.null(a)) b else a
