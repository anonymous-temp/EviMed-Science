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

#' Approximate a MAP predictive by a normal mixture of at most two components.
#'
#' With `components = 1` the MAP is one normal matched on its mean and variance.
#' With two, the quadrature mixture over tau is *split at the posterior median
#' of tau*, and each half is collapsed to one normal matched on that half's own
#' mean and variance: the narrow component is the low-heterogeneity regime and
#' the wide one the rest. (An earlier docstring promised a match on the first
#' four moments; nothing does that.) A single normal understates the tail that
#' carries the conflict behaviour, and more than two components is not
#' identifiable from the handful of historical studies a real project has, so
#' `components` is 1 or 2 and anything else is refused by the caller.
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

#' Expected local-information-ratio ESS of a normal mixture prior on the
#' analysis scale (Neuenschwander et al. 2020; RBesT `ess(method = "elir")`).
#'
#' Hidden knowledge: for a mixture the local prior information is
#' -d^2/dtheta^2 log p(theta) = E_w[1/s_k^2] - Var_w[(theta - m_k)/s_k^2],
#' with w the component weights *at theta*. The ELIR is its average under the
#' prior, in units of one subject's information (`unit_variance`). It is
#' reported next to the moment ESS and never instead of it: for the same prior
#' the two can differ by a factor of ten (68 vs 96 on RBesT's own example), and
#' a bare "prior ESS" would not say which one it is.
vcr_prior_ess_elir <- function(mixture, unit_variance = 1, nodes = 20001L) {
  w <- mixture$weight / sum(mixture$weight); m <- mixture$mean; s <- mixture$sd
  lo <- min(m - 10 * s); hi <- max(m + 10 * s)
  x <- seq(lo, hi, length.out = nodes)
  h <- x[2] - x[1]
  lw <- vapply(seq_along(w), function(k) log(w[k]) + stats::dnorm(x, m[k], s[k], log = TRUE), numeric(nodes))
  lmix <- apply(lw, 1, function(r) { mx <- max(r); mx + log(sum(exp(r - mx))) })
  post <- exp(lw - lmix)                                   # w_k(theta), nodes x K
  g <- vapply(seq_along(w), function(k) -(x - m[k]) / s[k]^2, numeric(nodes))
  mean_g <- rowSums(post * g)
  var_g <- rowSums(post * g^2) - mean_g^2
  info <- rowSums(post * rep(1 / s^2, each = nodes)) - var_g
  dens <- exp(lmix)
  simpson <- .vcr_simpson_weights(nodes) * h
  unit_variance * sum(simpson * dens * info)
}

#' Posterior mean and variance of a normal-mixture prior after a vector of
#' normal observations with a common standard error (vectorised over `y`).
.vcr_mixture_posterior_moments <- function(prior, y, se) {
  K <- nrow(prior); v <- se^2; n <- length(y)
  pv <- 1 / (1 / prior$sd^2 + 1 / v)
  pm <- vapply(seq_len(K), function(k) pv[k] * (prior$mean[k] / prior$sd[k]^2 + y / v), numeric(n))
  lw <- vapply(seq_len(K), function(k) log(prior$weight[k]) + stats::dnorm(y, prior$mean[k], sqrt(prior$sd[k]^2 + v), log = TRUE), numeric(n))
  if (n == 1L) { pm <- matrix(pm, nrow = 1L); lw <- matrix(lw, nrow = 1L) }
  lw <- lw - apply(lw, 1, max)
  w <- exp(lw); w <- w / rowSums(w)
  mu <- rowSums(w * pm)
  list(mean = mu, variance = rowSums(w * (matrix(pv, n, K, byrow = TRUE) + pm^2)) - mu^2)
}

#' Operating characteristics of a borrowing design over a grid of control-rate
#' drift (plan 5.3 hybrid control: "在真实对照率偏离历史的一组情景上仿真 I 类错误和功效").
#'
#' The decision is the posterior-probability rule of a hybrid design: the
#' control-arm parameter has the (robust) MAP prior updated by the observed
#' control estimate, the treatment arm is flat, and the treatment is declared
#' better when P(theta_t - theta_c > 0 | data) > 1 - alpha. Everything is on the
#' analysis scale with normal sampling (`unit_variance` / n per arm), the same
#' scale the MAP lives on, so a binary endpoint runs on the logit and a
#' "drift" is a shift of the true control logit away from the historical mean.
#' One replicate stream per replicate makes the grid common-random-numbers, and
#' every cell carries its Monte-Carlo standard error.
vcr_hybrid_operating_characteristics <- function(map_mixture, unit_variance, n_control, n_treatment,
                                                 drifts, effect, robust_weights = c(0.2, 0.5),
                                                 alpha = 0.025, replicates = 5000L, seed = 1L,
                                                 cores = 1L, vague_sd = NULL) {
  base_mean <- sum(map_mixture$weight * map_mixture$mean)
  sd_c <- sqrt(unit_variance / n_control); sd_t <- sqrt(unit_variance / n_treatment)
  crit <- stats::qnorm(1 - alpha)
  priors <- c(list(none = NULL), stats::setNames(lapply(robust_weights, function(w)
    vcr_robustify(map_mixture, w, unit_information_sd = vague_sd %||% sqrt(unit_variance))),
    paste0("robust_", robust_weights)))
  bank <- vcr_stream_bank(seed)
  streams <- bank$take(replicates)
  # standard normal draws per replicate: the same draws serve every drift and
  # every prior, which is what makes the cells comparable
  z <- vcr_map_streams(streams, function(i) stats::rnorm(4L), cores = cores)
  Z <- do.call(rbind, z)
  rows <- list()
  for (d in drifts) for (eff in c(0, effect)) {
    theta_c <- base_mean + d; theta_t <- theta_c + eff
    yc <- theta_c + sd_c * Z[, 1]; yt <- theta_t + sd_t * Z[, 2]
    for (nm in names(priors)) {
      pr <- priors[[nm]]
      if (is.null(pr)) {
        mu_c <- yc; v_c <- rep(sd_c^2, length(yc))            # no borrowing: the control arm's own data
      } else {
        pm <- .vcr_mixture_posterior_moments(pr, yc, sd_c)
        mu_c <- pm$mean; v_c <- pm$variance
      }
      zstat <- (yt - mu_c) / sqrt(sd_t^2 + v_c)
      rej <- as.numeric(zstat > crit)
      p_hat <- mean(rej)
      rows[[length(rows) + 1L]] <- data.frame(
        drift = d, prior = nm, scenario = if (eff == 0) "null" else "alternative",
        rejection = p_hat, mcse = sqrt(p_hat * (1 - p_hat) / length(rej)), replicates = length(rej),
        stringsAsFactors = FALSE)
    }
  }
  do.call(rbind, rows)
}

`%||%` <- function(a, b) if (is.null(a)) b else a
