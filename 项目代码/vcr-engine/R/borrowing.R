# ---------------------------------------------------------------------------
# borrowing.R — dynamic borrowing of an external control arm (algorithm round C10, C11, C12, 2026-11-03): `comparator.borrowing`.
#
# One method, three priors for the CONTROL arm (the treatment arm is read with a flat prior), a binary or a continuous endpoint, every number
# exact (conjugate closed forms; the continuous operating characteristics are a one-dimensional quadrature, the binary ones an enumeration of
# every pair of counts). Nothing draws a random number, so no measure carries a Monte-Carlo error.
#
#   power    "外部每人只算 0.3 人时结论如何"   the power prior with a FIXED discount a0: the historical likelihood raised to a0. Conjugate:
#            Beta(vague + a0 x, vague + a0 (n - x)) for a rate, N(mean, sd^2 / (a0 n)) for a mean. The borrowing is a0, whatever the data say.
#   sam      "借用多少由数据决定时结果如何"   Yang et al. 2023: w pi_informative + (1 - w) pi_vague with w = R / (1 + R), R the likelihood
#            of the current control data at the historical value over its largest value at historical +- delta. The mixture is the engine's
#            robustify (the informative component with a vague one added), and the posterior weights are the usual closed forms.
#   elastic  "数据冲突怎样换算成借用程度"   Jiang, Nie & Yuan 2023: the historical posterior with its variance inflated by 1 / g(T), where T
#            measures how far the current control data are from the historical ones and g maps it to a discount in [0, 1].
#
# Hidden knowledge:
#
# - **The treatment arm's Beta(1, 1) prior is what makes the probability exact.** For integer treatment shapes, Pr(theta_T > theta_C) given
#   x_T of n_T is the beta-binomial distribution function of x_T with n_T + 1 trials and the CONTROL posterior's shapes, whatever real
#   numbers those are: Beta(a, b) has Pr(X > c) = Pr(Binomial(a + b - 1, c) <= a - 1), and the expectation over the control posterior of a
#   binomial probability is the beta-binomial pmf. A power prior with a0 = 0.3 has non-integer shapes and a quadrature over them would be
#   approximate; this sum is not. A mixture is the weighted sum.
# - **Drift is on the scale of the rate (or the mean), not of the logit.** `comparator.map_prior` shifts the logit; here the question is
#   "the true control rate is 0.05 higher than the historical one", the same unit as delta, so a drift of delta is exactly the conflict
#   the SAM prior and the elastic function were calibrated to see.
# - **The SAM weight's alternative side must exist.** theta_h +- delta outside (0, 1) is not a rate; the package SAMprior clamps it to
#   [0.01, 0.99], this code drops the side that does not exist (and refuses a historical rate for which neither does). The two agree wherever
#   both sides exist, which is where the cases compare them.
# - **The elastic prior of the paper is Beta(g (a0 + x), g (b0 + n - x)); at g near 0 that is no prior at all** (shapes of 0 make a posterior
#   with no responses improper). The shapes are floored at the vague prior's own, so a discarded history leaves the vague prior (the paper
#   says it "becomes a noninformative prior"). The floor changes g (a0 + x) only when g < a0 / (a0 + x).
# - **The congruence measure T is known-variance for a mean.** The paper simulates the current sample and takes the t statistic with a
#   pooled standard deviation; here the standard deviation is the stated, known one, so T is |z| with an exact folded-normal law and its
#   percentiles are closed forms. For a rate, T is the Pearson chi-square of the 2 x 2 table (as the paper), its law exact by enumeration
#   of the control counts, and a percentile is the smallest value with that much probability at or below it.
# - **The elastic function is a choice, not a finding.** FDA's draft says it may be hard to justify a particular function; the result
#   carries the function's two constants, the percentiles and the constants C1, C2 they were fitted with, and a table that turns each
#   observed conflict into a discount, so the person sees what the choice does. The paper's own search over (q0, q1) by a utility needs
#   the type I error and the power of every pair; it is not run: q0 and q1 are stated (or the defaults below, listed as assumptions).
# - **A prior effective sample size above the vague one.** Every kind reports the moment-matched effective sample size of its prior beyond
#   the vague prior's own, one definition for all three: a0 n for the power prior, about g n for the elastic (the paper's PESS), and for a
#   mixture the moment match, which understates a heavy-tailed mixture by design (the engine's MAP card says the same).
# ---------------------------------------------------------------------------

VCR_BW_DEFAULTS <- list(q0 = 0.5, q1 = 0.5, c1 = 0.99, c2 = 0.01, elasticVague = 0.1, vague = 1)
#' The multiples of delta at which the table of conflict versus borrowing is read, and the grid of the quadrature of a mean.
VCR_BW_CONFLICT_STEPS <- c(-2, -1, -0.5, 0, 0.5, 1, 2)
VCR_BW_NODES <- 4001L

.vcr_bw_assume <- function(p, key, value, basis = "default") {
  p$assumed[[length(p$assumed) + 1L]] <- list(key = key, value = value, basis = basis)
  p
}
.vcr_bw_cell <- function(name, value, ...) vcr_measure(name, value, source = "calculated", ...)

# --- the congruence measure and the elastic function ---------------------------------------------------------------------

#' The elastic function g(T) = 1 / (1 + exp(a + b log T)), or the step 1{T <= t0}. T = 0 is perfect congruence: g = 1.
vcr_bw_elastic_g <- function(fn, t) {
  if (identical(fn$kind, "step")) return(as.numeric(t <= fn$tq0))
  out <- 1 / (1 + exp(fn$a + fn$b * log(t)))
  out[t <= 0] <- 1
  out
}

#' The two constants of the logistic function from the two percentiles: g(tq0) = c1 and g(tq1) = c2 (Jiang et al. 2023, equation 3).
vcr_bw_elastic_constants <- function(tq0, tq1, c1, c2) {
  l <- log((1 - c1) * c2 / ((1 - c2) * c1))
  b <- l / (log(tq0) - log(tq1))
  a <- log((1 - c1) / c1) - b * log(tq0)
  list(a = a, b = b)
}

#' Pearson chi-square of the 2 x 2 table (responders and non-responders in the current and the historical arm), no continuity correction.
vcr_bw_chisq_binary <- function(xc, nc, xh, nh) {
  p <- (xc + xh) / (nc + nh)
  d <- xc / nc - xh / nh
  out <- d^2 / (p * (1 - p) * (1 / nc + 1 / nh))
  out[!is.finite(out) | p <= 0 | p >= 1] <- 0
  out
}

#' The smallest value of a discrete variable with probability at least q at or below it (the type 1 quantile).
.vcr_bw_quantile1 <- function(values, probs, q) {
  o <- order(values); v <- values[o]; cdf <- cumsum(probs[o]) / sum(probs)
  v[which(cdf >= q - 1e-12)[1L]]
}

#' The percentile of |N(m, s^2)|: the smallest t with Pr(|X| <= t) = q.
.vcr_bw_folded_quantile <- function(m, s, q) {
  f <- function(t) stats::pnorm((t - m) / s) - stats::pnorm((-t - m) / s) - q
  stats::uniroot(f, c(0, abs(m) + 10 * s), tol = 1e-13)$root
}

#' Build the elastic function for a current control arm of `nc` patients against a history: the percentiles of T when the current data come
#' from the historical value (q0) and from the value delta away on either side (q1, the smaller of the two), and the function through them.
vcr_bw_elastic_fit <- function(endpoint, hist, nc, delta, q0, q1, c1, c2, kind = "logistic") {
  if (identical(endpoint, "binary")) {
    th <- hist$x / hist$n
    pmf <- function(p) stats::dbinom(0:nc, nc, p)
    tt <- vcr_bw_chisq_binary(0:nc, nc, hist$x, hist$n)
    tq0 <- .vcr_bw_quantile1(tt, pmf(th), q0)
    sides <- c(th + delta, th - delta); sides <- sides[sides > 0 & sides < 1]
    if (!length(sides)) vcr_abort("scenario_value_invalid", "scenario.prior.delta", "The historical rate plus or minus delta must leave a rate strictly between 0 and 1 on at least one side.")
    tq1 <- min(vapply(sides, function(p) .vcr_bw_quantile1(tt, pmf(p), q1), numeric(1)))
  } else {
    k <- sqrt(1 / hist$n + 1 / nc); sd_z <- sqrt(hist$n / (hist$n + nc))
    tq0 <- .vcr_bw_folded_quantile(0, sd_z, q0)
    tq1 <- .vcr_bw_folded_quantile(delta / (hist$sd * k), sd_z, q1)
  }
  if (identical(kind, "step")) return(list(kind = "step", tq0 = tq0, tq1 = tq0, c1 = 1, c2 = 0, q0 = q0, q1 = q0))
  if (!(tq0 > 0)) vcr_abort("scenario_value_invalid", "scenario.prior.q0", "At that percentile the congruent data are exactly as the history says (T = 0), so the logistic function cannot be placed: raise q0.")
  if (!(tq1 > tq0)) vcr_abort("scenario_value_invalid", "scenario.prior.delta", sprintf("A difference of delta cannot be told from no difference with %d current patients (the percentile of T under no difference, %.4g, is not below the one under delta, %.4g): state a larger delta, a larger q1 or fewer q0, or use the step function.", as.integer(nc), tq0, tq1))
  cst <- vcr_bw_elastic_constants(tq0, tq1, c1, c2)
  list(kind = "logistic", a = cst$a, b = cst$b, tq0 = tq0, tq1 = tq1, c1 = c1, c2 = c2, q0 = q0, q1 = q1)
}

# --- the SAM weight ---------------------------------------------------------------------------------------------------

#' w = R / (1 + R), R = L(theta_h) / max(L(theta_h + delta), L(theta_h - delta)) for x responses of n (Yang et al. 2023, equations 3 and 6),
#' on the sides that exist (see the header). The log scale keeps a sure conflict from underflowing.
vcr_bw_sam_weight_binary <- function(theta_h, delta, x, n) {
  ll <- function(th) x * log(th) + (n - x) * log1p(-th)
  sides <- c(theta_h + delta, theta_h - delta); sides <- sides[sides > 0 & sides < 1]
  if (!length(sides)) vcr_abort("scenario_value_invalid", "scenario.prior.delta", "The historical rate plus or minus delta must leave a rate strictly between 0 and 1 on at least one side.")
  stats::plogis(ll(theta_h) - max(vapply(sides, ll, numeric(1))))
}

#' The same for a mean of n patients with a known standard deviation: log R = n delta (delta - 2 |d|) / (2 sigma^2), d = the observed mean - theta_h.
vcr_bw_sam_weight_normal <- function(theta_h, delta, ybar, n, sd) {
  d <- abs(ybar - theta_h)
  stats::plogis(n * delta * (delta - 2 * d) / (2 * sd^2))
}

# --- the prior given the current control data --------------------------------------------------------------------------

#' The control prior a kind gives once the current control data are in (the weight of SAM and the discount of the elastic prior are functions
#' of those data). A Beta mixture for a rate, a normal mixture for a mean; `weight` is the kind's own borrowing parameter, `vague` the share
#' of the prior that is the vague start.
vcr_bw_prior <- function(endpoint, spec, hist, cur_x, cur_n, fit = NULL) {
  if (identical(endpoint, "binary")) {
    va <- spec$va; vb <- spec$vb; xh <- hist$x; nh <- hist$n
    if (identical(spec$kind, "power")) {
      return(list(mix = data.frame(weight = 1, alpha = va + spec$a0 * xh, beta = vb + spec$a0 * (nh - xh)), weight = spec$a0, vague = c(va, vb)))
    }
    if (identical(spec$kind, "sam")) {
      th <- (va + xh) / (va + vb + nh)
      w <- vcr_bw_sam_weight_binary(th, spec$delta, cur_x, cur_n)
      mix <- data.frame(weight = c(w, 1 - w), alpha = c(va + xh, va), beta = c(vb + nh - xh, vb))
      return(list(mix = mix, weight = w, vague = c(va, vb)))
    }
    g <- vcr_bw_elastic_g(fit, vcr_bw_chisq_binary(cur_x, cur_n, xh, nh))
    return(list(mix = data.frame(weight = 1, alpha = pmax(g * (va + xh), va), beta = pmax(g * (vb + nh - xh), vb)), weight = g, vague = c(va, vb)))
  }
  m <- hist$mean; s <- hist$sd; nh <- hist$n
  if (identical(spec$kind, "power")) {
    return(list(mix = data.frame(weight = 1, mean = m, sd = if (spec$a0 > 0) s / sqrt(spec$a0 * nh) else Inf), weight = spec$a0, vague = NA_real_))
  }
  if (identical(spec$kind, "sam")) {
    w <- vcr_bw_sam_weight_normal(m, spec$delta, cur_x, cur_n, s)
    informative <- data.frame(weight = 1, mean = m, sd = s / sqrt(nh))
    # the engine's robustify: the informative component with the unit-information prior added at the weight 1 - w
    mix <- vcr_robustify(informative, 1 - w, vague_mean = m, vague_sd = s)
    return(list(mix = mix, weight = w, vague = 1))
  }
  g <- vcr_bw_elastic_g(fit, abs(cur_x - m) / (s * sqrt(1 / nh + 1 / cur_n)))
  list(mix = data.frame(weight = 1, mean = m, sd = if (g > 0) s / sqrt(g * nh) else Inf), weight = g, vague = NA_real_)
}

#' The prior with no borrowing: the vague start alone (a flat prior for a mean).
vcr_bw_prior_none <- function(endpoint, spec, hist) {
  if (identical(endpoint, "binary")) return(list(mix = data.frame(weight = 1, alpha = spec$va, beta = spec$vb), weight = 0, vague = c(spec$va, spec$vb)))
  list(mix = data.frame(weight = 1, mean = hist$mean, sd = Inf), weight = 0, vague = NA_real_)
}

# --- posteriors of the control arm -----------------------------------------------------------------------------------------

#' The control posterior after x responses of n: a Beta mixture (the engine's closed form for the weights).
vcr_bw_post_binary <- function(mix, x, n) vcr_beta_mixture_posterior(mix, x, n)

#' The control posterior after a mean ybar of n patients (known sd): a normal mixture. A flat component (sd Inf) is a single component.
vcr_bw_post_normal <- function(mix, ybar, n, sd) {
  se <- sd / sqrt(n)
  if (nrow(mix) == 1L) {
    if (is.infinite(mix$sd)) return(data.frame(weight = 1, mean = ybar, sd = se))
    pv <- 1 / (1 / mix$sd^2 + 1 / se^2)
    return(data.frame(weight = 1, mean = pv * (mix$mean / mix$sd^2 + ybar / se^2), sd = sqrt(pv)))
  }
  vcr_normal_mixture_posterior(mix, ybar, se)
}

.vcr_bw_mix_cdf <- function(mix, q) {
  if (!is.null(mix$alpha)) sum(mix$weight * stats::pbeta(q, mix$alpha, mix$beta)) else sum(mix$weight * stats::pnorm(q, mix$mean, mix$sd))
}
.vcr_bw_mix_mean <- function(mix) if (!is.null(mix$alpha)) sum(mix$weight * mix$alpha / (mix$alpha + mix$beta)) else sum(mix$weight * mix$mean)
.vcr_bw_mix_interval <- function(mix, level = 0.95) {
  tail_ <- (1 - level) / 2
  one <- function(p) {
    if (nrow(mix) == 1L) return(if (!is.null(mix$alpha)) stats::qbeta(p, mix$alpha, mix$beta) else stats::qnorm(p, mix$mean, mix$sd))
    if (!is.null(mix$alpha)) return(stats::uniroot(function(q) .vcr_bw_mix_cdf(mix, q) - p, c(0, 1), tol = 1e-13)$root)
    lo <- min(mix$mean - 12 * mix$sd); hi <- max(mix$mean + 12 * mix$sd)
    stats::uniroot(function(q) .vcr_bw_mix_cdf(mix, q) - p, c(lo, hi), tol = 1e-13)$root
  }
  c(one(tail_), one(1 - tail_))
}

# --- Pr(the treatment arm is better) ----------------------------------------------------------------------------------------

#' Pr(theta_T > theta_C | data) for a rate, the treatment arm flat Beta(1, 1): the beta-binomial distribution function of x_T with n_T + 1
#' trials, summed over the control posterior's components (header). One value per x_T in `xt`.
vcr_bw_better_binary <- function(xt, nt, mix) {
  N <- nt + 1L; j <- 0:N
  out <- numeric(length(xt))
  for (k in seq_len(nrow(mix))) {
    a <- mix$alpha[k]; b <- mix$beta[k]
    cdf <- cumsum(exp(lchoose(N, j) + lbeta(a + j, b + N - j) - lbeta(a, b)))
    out <- out + mix$weight[k] * pmin(1, cdf[xt + 1L])
  }
  pmin(1, out)
}

#' The same for a mean: the treatment arm's flat-prior posterior N(ybar_T, sd^2 / n_T) against the control posterior's normal components.
vcr_bw_better_normal <- function(ybar_t, nt, sd, mix) {
  out <- 0
  for (k in seq_len(nrow(mix))) out <- out + mix$weight[k] * stats::pnorm((ybar_t - mix$mean[k]) / sqrt(sd^2 / nt + mix$sd[k]^2))
  out
}

# --- the effective sample size of a prior beyond its vague start ---------------------------------------------------------------

vcr_bw_prior_ess <- function(endpoint, pr, hist) {
  if (identical(endpoint, "binary")) return(max(0, vcr_beta_mixture_moment_ess(pr$mix) - sum(pr$vague)))
  v <- sum(pr$mix$weight * (pr$mix$sd^2 + pr$mix$mean^2)) - sum(pr$mix$weight * pr$mix$mean)^2
  if (!is.finite(v)) return(0)
  max(0, hist$sd^2 / v - if (identical(pr$kind, "sam")) 1 else 0)
}

# --- operating characteristics: a rate ---------------------------------------------------------------------------------------

#' The rejection probabilities of the rule "Pr(theta_T > theta_C | data) > 1 - alpha" over drifts of the true control rate, exact: the posterior
#' probability of every pair of counts, and the binomial probability of every pair. For each prior in `priors` (a list of functions of the
#' current control count returning a `vcr_bw_prior`-shaped list): type I error, power, the expected borrowing and the bias of the posterior mean.
vcr_bw_oc_binary <- function(priors, hist, n_c, n_t, drifts, effect, alpha) {
  xc <- 0:n_c; xt <- 0:n_t; th <- hist$x / hist$n
  per <- lapply(priors, function(prior_of) {
    posts <- lapply(xc, function(x) vcr_bw_post_binary(prior_of(x)$mix, x, n_c))
    P <- vapply(posts, function(m) vcr_bw_better_binary(xt, n_t, m), numeric(length(xt)))
    list(reject = (P > 1 - alpha) * 1, weight = vapply(xc, function(x) prior_of(x)$weight, numeric(1)), mean = vapply(posts, .vcr_bw_mix_mean, numeric(1)))
  })
  rows <- lapply(drifts, function(d) {
    tc <- th + d; tt <- tc + effect
    if (!(tc > 0 && tc < 1 && tt > 0 && tt < 1)) vcr_abort("scenario_value_invalid", "scenario.operatingCharacteristics.drifts", sprintf("A drift of %s puts the control rate (%.3f) or the treatment rate (%.3f) outside (0, 1).", format(d), tc, tt))
    pc <- stats::dbinom(xc, n_c, tc); p_null <- stats::dbinom(xt, n_t, tc); p_alt <- stats::dbinom(xt, n_t, tt)
    list(drift = d, controlValue = tc, perPrior = lapply(per, function(r) list(
      typeOneError = as.numeric(crossprod(p_null, r$reject %*% pc)), power = as.numeric(crossprod(p_alt, r$reject %*% pc)),
      weight = sum(pc * r$weight), bias = sum(pc * r$mean) - tc)))
  })
  rows
}

# --- operating characteristics: a mean ---------------------------------------------------------------------------------------

#' The control posterior of a kind for a whole vector of observed control means at once: one column per component. The scalar
#' `vcr_bw_prior` / `vcr_bw_post_normal` pair is the reference this is held to (N92, N93); this is written for the quadrature below, which
#' evaluates the rule at thousands of observed means. `kind` is "none" for no borrowing.
.vcr_bw_post_vec <- function(kind, spec, hist, fit, ybar, n) {
  se <- hist$sd / sqrt(n); m <- hist$mean; s <- hist$sd; nh <- hist$n
  single <- function(prior_prec, weight) {
    prec <- prior_prec + 1 / se^2
    list(w = matrix(1, length(ybar), 1L), m = matrix((prior_prec * m + ybar / se^2) / prec, ncol = 1L), s = matrix(sqrt(1 / prec), ncol = 1L), weight = weight)
  }
  if (identical(kind, "none")) return(single(rep(0, length(ybar)), rep(0, length(ybar))))
  if (identical(kind, "power")) return(single(rep(spec$a0 * nh / s^2, length(ybar)), rep(spec$a0, length(ybar))))
  if (identical(kind, "elastic")) {
    g <- vcr_bw_elastic_g(fit, abs(ybar - m) / (s * sqrt(1 / nh + 1 / n)))
    return(single(g * nh / s^2, g))
  }
  # SAM: the informative component N(m, s^2 / nh) at the weight w and the unit-information one N(m, s^2) at 1 - w
  w <- vcr_bw_sam_weight_normal(m, spec$delta, ybar, n, s)
  prec <- matrix(c(nh / s^2 + 1 / se^2, 1 / s^2 + 1 / se^2), nrow = length(ybar), ncol = 2L, byrow = TRUE)
  pm <- cbind((nh / s^2 * m + ybar / se^2) / prec[, 1L], (m / s^2 + ybar / se^2) / prec[, 2L])
  lw <- cbind(log(w) + stats::dnorm(ybar, m, sqrt(s^2 / nh + se^2), log = TRUE), log1p(-w) + stats::dnorm(ybar, m, sqrt(s^2 + se^2), log = TRUE))
  lw <- lw - pmax(lw[, 1L], lw[, 2L]); pw <- exp(lw); pw <- pw / rowSums(pw)
  list(w = pw, m = pm, s = sqrt(1 / prec), weight = w)
}

#' The same for a mean with a known standard deviation: for every observed control mean on a fine grid (Simpson's rule over +-8 standard
#' errors) the smallest treatment mean the rule rejects at is found by bisection (the probability is increasing in it), and the rejection
#' probability integrates the normal law of the treatment mean over it. The integrand has kinks (the SAM weight depends on |d|), so the
#' grid is fine rather than clever.
vcr_bw_oc_normal <- function(kinds, spec, hist, fit, n_c, n_t, drifts, effect, alpha, nodes = VCR_BW_NODES) {
  s <- hist$sd; se_c <- s / sqrt(n_c); se_t <- s / sqrt(n_t)
  z <- seq(-8, 8, length.out = nodes); h <- z[2L] - z[1L]
  simpson <- .vcr_simpson_weights(nodes) * h * stats::dnorm(z)
  crit <- 1 - alpha
  lapply(drifts, function(d) {
    tc <- hist$mean + d
    ybar <- tc + se_c * z
    per <- lapply(kinds, function(kind) {
      pv <- .vcr_bw_post_vec(kind, spec, hist, fit, ybar, n_c)
      K <- ncol(pv$w)
      prob <- function(y) { out <- 0; for (k in seq_len(K)) out <- out + pv$w[, k] * stats::pnorm((y - pv$m[, k]) / sqrt(se_t^2 + pv$s[, k]^2)); out }
      lo <- apply(pv$m - 12 * pv$s, 1L, min) - 12 * se_t; hi <- apply(pv$m + 12 * pv$s, 1L, max) + 12 * se_t
      for (it in 1:70) { mid <- (lo + hi) / 2; up <- prob(mid) >= crit; hi[up] <- mid[up]; lo[!up] <- mid[!up] }
      cut <- (lo + hi) / 2
      list(typeOneError = sum(simpson * (1 - stats::pnorm((cut - tc) / se_t))), power = sum(simpson * (1 - stats::pnorm((cut - (tc + effect)) / se_t))),
           weight = sum(simpson * pv$weight), bias = sum(simpson * rowSums(pv$w * pv$m)) - tc)
    })
    list(drift = d, controlValue = tc, perPrior = per)
  })
}

# --- the handler --------------------------------------------------------------------------------------------------------

.vcr_bw_read <- function(sc) {
  type <- as.character(sc$endpoint$type); pr <- sc[["prior"]]; kind <- as.character(pr$kind)
  p <- list(assumed = list())
  h <- sc$historical
  hist <- if (identical(type, "binary")) {
    x <- vcr_scalar(h$responders); n <- vcr_scalar(h$n)
    if (x > n) vcr_abort("scenario_value_invalid", "scenario.historical.responders", "The historical responders cannot exceed the historical patients.")
    list(x = x, n = n)
  } else list(mean = vcr_scalar(h$mean), sd = vcr_scalar(h$sd), n = vcr_scalar(h$n))
  spec <- list(kind = kind)
  if (identical(kind, "power")) spec$a0 <- vcr_scalar(pr$a0)
  if (kind %in% c("sam", "elastic")) spec$delta <- vcr_scalar(pr$delta)
  if (identical(type, "binary")) {
    vg <- pr$vague
    dflt <- if (identical(kind, "elastic")) VCR_BW_DEFAULTS$elasticVague else VCR_BW_DEFAULTS$vague
    spec$va <- vcr_scalar(vg$alpha, dflt); spec$vb <- vcr_scalar(vg$beta, dflt)
    if (is.null(vg)) p <- .vcr_bw_assume(p, "prior.vague", sprintf("Beta(%s, %s)", format(spec$va), format(spec$vb)),
      basis = if (identical(kind, "elastic")) "default: the small values Jiang et al. use for the starting prior" else "default: the uniform prior")
  }
  if (identical(kind, "elastic")) {
    ef <- pr[["function"]]
    spec$fn <- as.character(ef %||% "logistic")
    spec$q0 <- vcr_scalar(pr$q0, VCR_BW_DEFAULTS$q0); spec$q1 <- vcr_scalar(pr$q1, VCR_BW_DEFAULTS$q1)
    spec$c1 <- vcr_scalar(pr$c1, VCR_BW_DEFAULTS$c1); spec$c2 <- vcr_scalar(pr$c2, VCR_BW_DEFAULTS$c2)
    if (is.null(ef)) p <- .vcr_bw_assume(p, "prior.function", "logistic", basis = "default: Jiang et al.'s logistic elastic function")
    if (is.null(pr$q0)) p <- .vcr_bw_assume(p, "prior.q0", spec$q0, basis = "default: not searched; the percentile of the congruence measure that gets full borrowing")
    if (is.null(pr$q1)) p <- .vcr_bw_assume(p, "prior.q1", spec$q1, basis = "default: not searched; the percentile under a difference of delta that gets none")
    if (is.null(pr$c1)) p <- .vcr_bw_assume(p, "prior.c1", spec$c1, basis = "default: the paper's example for \"full\" borrowing")
    if (is.null(pr$c2)) p <- .vcr_bw_assume(p, "prior.c2", spec$c2, basis = "default: the paper's example for \"none\"")
    if (!(spec$c1 > spec$c2)) vcr_abort("scenario_value_invalid", "scenario.prior.c1", "c1 (full borrowing) must be above c2 (none).")
  }
  list(type = type, spec = spec, hist = hist, p = p)
}

.vcr_bw_data <- function(type, node, field) {
  if (is.null(node)) return(NULL)
  if (identical(type, "binary")) {
    x <- vcr_scalar(node$responders); n <- vcr_scalar(node$n)
    if (x > n) vcr_abort("scenario_value_invalid", paste0("scenario.", field, ".responders"), "Responders cannot exceed patients.")
    list(x = x, n = n)
  } else list(mean = vcr_scalar(node$mean), n = vcr_scalar(node$n))
}

#' The rows (none, the chosen prior, the full-borrowing power prior) for the current data, with the credible interval and Pr(better).
.vcr_bw_posterior_rows <- function(type, spec, hist, cur, trt, fit) {
  chosen <- if (identical(type, "binary")) vcr_bw_prior(type, spec, hist, cur$x, cur$n, fit) else vcr_bw_prior(type, spec, hist, cur$mean, cur$n, fit)
  chosen$kind <- spec$kind
  full_spec <- spec; full_spec$kind <- "power"; full_spec$a0 <- 1
  priors <- list(none = vcr_bw_prior_none(type, spec, hist), chosen = chosen,
                 full = if (identical(type, "binary")) vcr_bw_prior(type, full_spec, hist, cur$x, cur$n) else vcr_bw_prior(type, full_spec, hist, cur$mean, cur$n))
  rows <- lapply(names(priors), function(nm) {
    pr <- priors[[nm]]
    post <- if (identical(type, "binary")) vcr_bw_post_binary(pr$mix, cur$x, cur$n) else vcr_bw_post_normal(pr$mix, cur$mean, cur$n, hist$sd)
    iv <- .vcr_bw_mix_interval(post)
    better <- if (is.null(trt)) NULL else if (identical(type, "binary")) vcr_bw_better_binary(trt$x, trt$n, post) else vcr_bw_better_normal(trt$mean, trt$n, hist$sd, post)
    list(label = nm, mean = .vcr_bw_cell("control_posterior_mean", .vcr_bw_mix_mean(post)),
         lower = .vcr_bw_cell("control_posterior_lower", iv[1L]), upper = .vcr_bw_cell("control_posterior_upper", iv[2L]),
         probabilityBetter = if (is.null(better)) NULL else .vcr_bw_cell("probability_treatment_better", better),
         weight = .vcr_bw_cell("borrowing_weight", pr$weight))
  })
  list(rows = rows, chosen = chosen)
}

#' The table of conflict versus borrowing: the discount the kind gives when the current control data sit k deltas from the history.
.vcr_bw_conflict_table <- function(type, spec, hist, n_c, fit) {
  if (identical(spec$kind, "power")) return(NULL)
  delta <- spec$delta
  rows <- lapply(VCR_BW_CONFLICT_STEPS, function(k) {
    if (identical(type, "binary")) {
      th <- hist$x / hist$n; r <- th + k * delta
      if (!(r >= 0 && r <= 1)) return(NULL)
      x <- round(n_c * r)
      list(difference = k * delta, observedValue = x / n_c, weight = .vcr_bw_cell("borrowing_weight", vcr_bw_prior(type, spec, hist, x, n_c, fit)$weight))
    } else {
      y <- hist$mean + k * delta
      list(difference = k * delta, observedValue = y, weight = .vcr_bw_cell("borrowing_weight", vcr_bw_prior(type, spec, hist, y, n_c, fit)$weight))
    }
  })
  Filter(Negate(is.null), rows)
}

vcr_job_comparator_borrowing <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  sc <- job$scenario
  rd <- .vcr_bw_read(sc); type <- rd$type; spec <- rd$spec; hist <- rd$hist; p <- rd$p
  if (!is.null(sc$treatment) && is.null(sc$current)) vcr_abort("scenario_field_missing", "scenario.current", "The treatment arm is compared with the control arm's current data: state them.")
  cur <- .vcr_bw_data(type, sc$current, "current"); trt <- .vcr_bw_data(type, sc$treatment, "treatment")
  oc_spec <- sc$operatingCharacteristics
  alpha <- vcr_scalar(sc$analysis$alpha, 0.025)
  if (is.null(sc$analysis$alpha)) p <- .vcr_bw_assume(p, "analysis.alpha", alpha, basis = "default: one-sided; the treatment is better when Pr(better) exceeds 1 - alpha")
  if (identical(type, "continuous")) p <- .vcr_bw_assume(p, "historical.sd", hist$sd, basis = "given: one patient's standard deviation is taken as known, the same in every group")
  p <- .vcr_bw_assume(p, "treatment.prior", if (identical(type, "binary")) "Beta(1, 1)" else "flat", basis = "default: the treatment arm borrows nothing")
  n_ref <- if (!is.null(cur)) cur$n else vcr_scalar(oc_spec$nControl)
  fit_for <- function(n) if (identical(spec$kind, "elastic")) vcr_bw_elastic_fit(type, hist, n, spec$delta, spec$q0, spec$q1, spec$c1, spec$c2, spec$fn) else NULL
  fit <- fit_for(n_ref)
  diag <- list(kind = spec$kind, endpoint = type, alpha = alpha)
  measures <- list()
  prior_row <- NULL
  if (!is.null(cur)) {
    pr <- .vcr_bw_posterior_rows(type, spec, hist, cur, trt, fit)
    chosen <- pr$chosen; chosen$kind <- spec$kind
    ess <- vcr_bw_prior_ess(type, chosen, hist)
    ch <- pr$rows[[2L]]
    measures <- c(list(.vcr_bw_cell("borrowing_weight", chosen$weight), .vcr_bw_cell("borrowed_sample_size", ess), ch$mean),
                  if (!is.null(ch$probabilityBetter)) list(ch$probabilityBetter, pr$rows[[1L]]$probabilityBetter))
    diag$posterior <- list(rows = pr$rows)
    prior_row <- list(weight = chosen$weight, borrowedSampleSize = ess,
                      mixture = if (nrow(chosen$mix) > 1L || spec$kind == "sam") chosen$mix else NULL)
  }
  if (!is.null(fit)) diag$elastic <- c(fit[setdiff(names(fit), "kind")], list(`function` = fit$kind, patients = n_ref))
  conflict <- .vcr_bw_conflict_table(type, spec, hist, n_ref, fit)
  if (!is.null(conflict)) diag$conflict <- list(patients = n_ref, delta = spec$delta, rows = conflict)
  if (!is.null(oc_spec)) {
    n_c <- as.integer(vcr_scalar(oc_spec$nControl)); n_t <- as.integer(vcr_scalar(oc_spec$nTreatment))
    effect <- vcr_scalar(oc_spec$effect, 0); drifts <- vcr_num(oc_spec$drifts)
    fit_oc <- if (identical(spec$kind, "elastic") && !is.null(fit) && n_c == n_ref) fit else fit_for(n_c)
    if (!is.null(fit_oc) && n_c != n_ref) diag$elasticDesign <- c(fit_oc[setdiff(names(fit_oc), "kind")], list(`function` = fit_oc$kind, patients = n_c))
    oc <- if (identical(type, "binary")) vcr_bw_oc_binary(list(
      none = function(x) vcr_bw_prior_none(type, spec, hist),
      chosen = function(x) vcr_bw_prior(type, spec, hist, x, n_c, fit_oc)), hist, n_c, n_t, drifts, effect, alpha)
      else vcr_bw_oc_normal(list(none = "none", chosen = spec$kind), spec, hist, fit_oc, n_c, n_t, drifts, effect, alpha)
    diag$operatingCharacteristics <- list(nControl = n_c, nTreatment = n_t, effect = effect, alpha = alpha, rows = lapply(oc, function(r) list(
      drift = r$drift, controlValue = r$controlValue,
      none = list(typeOneError = .vcr_bw_cell("type_one_error", r$perPrior$none$typeOneError), power = .vcr_bw_cell("power", r$perPrior$none$power),
                  bias = .vcr_bw_cell("control_bias", r$perPrior$none$bias)),
      chosen = list(typeOneError = .vcr_bw_cell("type_one_error", r$perPrior$chosen$typeOneError), power = .vcr_bw_cell("power", r$perPrior$chosen$power),
                    bias = .vcr_bw_cell("control_bias", r$perPrior$chosen$bias), weight = .vcr_bw_cell("borrowing_weight", r$perPrior$chosen$weight)))))
    at0 <- Filter(function(r) abs(r$drift) < 1e-12, oc)
    if (length(at0)) measures <- c(measures, list(.vcr_bw_cell("type_one_error", at0[[1L]]$perPrior$chosen$typeOneError), .vcr_bw_cell("power", at0[[1L]]$perPrior$chosen$power)))
    worst <- max(vapply(oc, function(r) r$perPrior$chosen$typeOneError, numeric(1)))
    measures <- c(measures, list(.vcr_bw_cell("type_one_error_worst", worst)))
  }
  if (!is.null(prior_row)) diag$prior <- prior_row
  diag$given <- Filter(Negate(is.null), list(kind = spec$kind, a0 = spec$a0, delta = spec$delta, nHistorical = hist$n, nCurrent = if (is.null(cur)) NULL else cur$n,
    nControl = if (is.null(oc_spec)) NULL else vcr_scalar(oc_spec$nControl), nTreatment = if (is.null(oc_spec)) NULL else vcr_scalar(oc_spec$nTreatment)))
  diag$assumed <- p$assumed
  diag$historical <- hist
  list(status = "succeeded", conclusion = "estimable", measures = measures, counts = vcr_counts(realPatients = NULL, priorEffectiveSampleSize = if (is.null(prior_row)) NULL else prior_row$borrowedSampleSize),
       diagnostics = list(borrowing = diag))
}
