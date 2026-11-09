# ---------------------------------------------------------------------------
# individualize.R -- empirical-Bayes individualization: a person's own history turned into a forecast for that person
# (plan C.3, R32, 2026-11-09).
#
#   population model  ->  MAP of the person's random effects given their history  ->  Laplace posterior  ->  predictive for later visits
#
# Two providers share one idea. `vcr_lmm_*` is a generic linear mixed model for a continuous longitudinal endpoint
# (random intercept and slope, REML), whose posterior for a person is exact and so is its Laplace approximation. `vcr_beta_logit_individualize`
# does the same for the adsim Alzheimer model (random intercept and slope on the logit scale, beta-distributed scores), where the posterior is
# not Gaussian and the Laplace approximation is what is checked (case N130).
#
# Hidden knowledge:
#
# - **Three claims, three different inputs.** A virtual cohort uses no real person. A population forecast uses a real person's BASELINE
#   covariates only (`vcr_lmm_population_predict`: the fixed part, spread from the random effects and the residual). An individualized
#   forecast also uses that person's own observations before the origin (`vcr_lmm_individualize`). The three are not interchangeable
#   evidence and the result of each is labelled with the claim it supports (`claim`).
# - **The hyperparameters are held fixed.** The posterior of a person's random effects is conditional on the fitted covariance and
#   residual; their own estimation error is not propagated (the usual empirical-Bayes approximation, which makes an interval slightly too
#   narrow when the training set is small). The fixed effects' covariance IS added to the predictive variance (the cross term between
#   the fixed effects' error and the person's is not). Both are said in `limits`.
# - **No new statistics for a new dataset.** Nothing in this file looks at a person's FUTURE: `individualize` takes the history rows and
#   the times to predict, and the caller cuts at the origin. A held-out value never reaches a fit through here.
# - **No package outside the lock.** The mixed model is fitted by REML with `stats::optim` over (log sd0, log sd1, atanh rho, log sigma),
#   the fixed effects profiled out by GLS; `nlme::lme` is the oracle of the numeric case, never called here. Persons with the same time
#   pattern share one inverse, so a three-visit trial of two thousand people costs a handful of 3 x 3 inversions per evaluation.
# - **Draws come from the stream in use**, like every generator of the engine; the closed-form parts (the exact Gaussian posterior and its
#   predictive moments) draw nothing.
# ---------------------------------------------------------------------------

.VCR_LMM_LIMITS <- c(
  "The covariance and residual are the fitted values and are treated as known; their estimation error is not in the interval.",
  "The model is linear in time with a random intercept and slope: a curve that bends is forced straight, and the forecast is only as good as that line.",
  "A person's later visits are assumed to follow the same population as the training people (ignorable visit times and dropout)."
)

# --- the linear mixed model ----------------------------------------------------------------------------------------------------------

#' Per-person pieces of a longitudinal table: row index, time and the key of the time pattern (persons with one pattern share V).
.vcr_lmm_groups <- function(id, t) {
  rows <- split(seq_along(id), factor(id, levels = unique(id)))
  list(rows = rows, key = vapply(rows, function(r) paste(format(t[r], digits = 15), collapse = "|"), character(1)))
}

#' Covariance of the random effects from the four unconstrained parameters.
.vcr_lmm_G <- function(theta) {
  s0 <- exp(theta[1L]); s1 <- exp(theta[2L]); rho <- tanh(theta[3L])
  matrix(c(s0^2, rho * s0 * s1, rho * s0 * s1, s1^2), 2L, 2L)
}

#' The REML pieces at `theta`: -2 restricted log-likelihood, the GLS fixed effects and their covariance.
.vcr_lmm_reml <- function(theta, y, X, t, grp) {
  G <- .vcr_lmm_G(theta); sigma2 <- exp(2 * theta[4L])
  p <- ncol(X)
  A <- matrix(0, p, p); b <- numeric(p); yy <- 0; logdet <- 0
  inv <- list()
  for (k in unique(grp$key)) {
    first <- grp$rows[[match(k, grp$key)]]
    Z <- cbind(1, t[first])
    V <- Z %*% G %*% t(Z) + diag(sigma2, length(first))
    ch <- tryCatch(chol(V), error = function(e) NULL)
    if (is.null(ch)) return(list(value = Inf))
    inv[[k]] <- list(Vi = chol2inv(ch), logdet = 2 * sum(log(diag(ch))))
  }
  for (j in seq_along(grp$rows)) {
    r <- grp$rows[[j]]; w <- inv[[grp$key[[j]]]]
    Xr <- X[r, , drop = FALSE]; yr <- y[r]
    ViX <- w$Vi %*% Xr
    A <- A + crossprod(Xr, ViX); b <- b + crossprod(ViX, yr)[, 1L]
    yy <- yy + sum(yr * (w$Vi %*% yr)); logdet <- logdet + w$logdet
  }
  chA <- tryCatch(chol(A), error = function(e) NULL)
  if (is.null(chA)) return(list(value = Inf))
  Ainv <- chol2inv(chA)
  beta <- as.vector(Ainv %*% b)
  value <- logdet + 2 * sum(log(diag(chA))) + yy - sum(b * beta)
  list(value = value, beta = beta, vcov = Ainv)
}

#' Fit y = X beta + b0 + b1 t + e by REML, one person per `id`. `X` is the fixed-effects design (it holds the intercept and the time term
#' the caller wants; the random part always uses 1 and `t`). Returns the fixed effects with their covariance, the two random-effect SDs
#' and their correlation, the residual SD, the restricted log-likelihood and whether the optimizer converged.
vcr_lmm_fit <- function(y, X, t, id) {
  X <- as.matrix(X); id <- as.character(id)
  keep <- is.finite(y) & is.finite(t) & stats::complete.cases(X)
  y <- y[keep]; X <- X[keep, , drop = FALSE]; t <- t[keep]; id <- id[keep]
  if (length(unique(id)) < 3L) vcr_abort("input_shape_invalid", "inputs", "A mixed model needs at least three people with observations.")
  grp <- .vcr_lmm_groups(id, t)
  ols <- stats::lm.fit(X, y); r <- stats::sd(ols$residuals); if (!is.finite(r) || r <= 0) r <- 1
  st <- stats::sd(t); if (!is.finite(st) || st <= 0) st <- 1
  start <- c(log(0.7 * r), log(0.2 * r / st), 0, log(0.5 * r))
  obj <- function(th) { v <- .vcr_lmm_reml(pmax(pmin(th, 12), -12), y, X, t, grp)$value; if (is.finite(v)) v else 1e300 }
  o <- stats::optim(start, obj, method = "BFGS", control = list(maxit = 300L, reltol = 1e-10))
  if (o$convergence != 0L) {
    o2 <- stats::optim(o$par, obj, method = "Nelder-Mead", control = list(maxit = 2000L, reltol = 1e-12))
    if (o2$value < o$value) o <- o2
    o3 <- stats::optim(o$par, obj, method = "BFGS", control = list(maxit = 300L, reltol = 1e-10))
    if (o3$value <= o$value) o <- o3
  }
  th <- pmax(pmin(o$par, 12), -12)
  fit <- .vcr_lmm_reml(th, y, X, t, grp)
  list(beta = stats::setNames(fit$beta, colnames(X)), vcov = fit$vcov, sd0 = exp(th[1L]), sd1 = exp(th[2L]), rho = tanh(th[3L]), sigma = exp(th[4L]),
       logLikReml = -fit$value / 2, converged = o$convergence == 0L, nObs = length(y), nPeople = length(grp$rows), columns = colnames(X),
       theta = th, limits = .VCR_LMM_LIMITS)
}

#' The predictive distribution of one person's observation at new rows, given the fitted model and (optionally) the person's own history.
#' `X_hist`, `t_hist`, `y_hist` are the person's rows before the origin (none for a population forecast); `X_new`, `t_new` the rows to predict.
#' The Gaussian posterior of the random effects is exact here, and so is its Laplace approximation. Returns the mean and SD of an OBSERVED
#' value at each new row (random-effect spread, residual and the fixed effects' own uncertainty), the SD of the latent value (no residual),
#' and the posterior mean and covariance of the random effects.
vcr_lmm_predict_one <- function(fit, X_new, t_new, X_hist = NULL, t_hist = NULL, y_hist = NULL) {
  G <- .vcr_lmm_G(fit$theta); s2 <- fit$sigma^2
  X_new <- as.matrix(X_new); Zn <- cbind(1, t_new)
  b <- c(0, 0); P <- G
  if (length(y_hist)) {
    X_hist <- as.matrix(X_hist); Zh <- cbind(1, t_hist)
    V <- Zh %*% G %*% t(Zh) + diag(s2, length(y_hist))
    Vi <- chol2inv(chol(V))
    K <- G %*% t(Zh) %*% Vi
    b <- as.vector(K %*% (y_hist - X_hist %*% fit$beta))
    P <- G - K %*% Zh %*% G
  }
  mu <- as.vector(X_new %*% fit$beta + Zn %*% b)
  lat_var <- rowSums((Zn %*% P) * Zn) + rowSums((X_new %*% fit$vcov) * X_new)
  list(mean = mu, sd = sqrt(lat_var + s2), latentSd = sqrt(lat_var), randomEffects = b, randomEffectsCov = P)
}

#' A population forecast: baseline covariates only, no history (claim `population_forecast`).
vcr_lmm_population_predict <- function(fit, X_new, t_new) vcr_lmm_predict_one(fit, X_new, t_new)

#' An individualized forecast (claim `individualized_forecast`): the same model, conditioned on the person's own history.
vcr_lmm_individualize <- function(fit, X_new, t_new, X_hist, t_hist, y_hist) vcr_lmm_predict_one(fit, X_new, t_new, X_hist, t_hist, y_hist)

# --- MAP + Laplace, generic ----------------------------------------------------------------------------------------------------------

#' The mode of an unnormalised log posterior and its Laplace (Gaussian) approximation: `logpost(par)` is maximised from `start`, the
#' curvature is the numerical Hessian of its negative at the mode. A curvature that is not positive definite is flagged and its nearest
#' positive-definite repair is used, so a draw is always possible and `laplaceOk` says whether the approximation was trustworthy.
vcr_map_laplace <- function(logpost, start) {
  o <- stats::optim(start, function(p) -logpost(p), method = "BFGS", control = list(maxit = 200L, reltol = 1e-12))
  H <- stats::optimHess(o$par, function(p) -logpost(p))
  H <- (H + t(H)) / 2
  ev <- eigen(H, symmetric = TRUE)
  ok <- all(is.finite(ev$values)) && all(ev$values > 1e-10)
  vals <- if (all(is.finite(ev$values))) pmax(ev$values, 1e-8) else rep(1, length(start))
  cov <- ev$vectors %*% diag(1 / vals, length(vals)) %*% t(ev$vectors)
  list(mode = o$par, cov = cov, laplaceOk = ok, converged = o$convergence == 0L, value = -o$value)
}

#' `n` draws from the Laplace approximation (rows), from the stream in use.
vcr_laplace_draws <- function(fit, n) {
  ch <- chol(fit$cov + diag(1e-12, nrow(fit$cov)))
  z <- matrix(stats::rnorm(n * length(fit$mode)), n)
  sweep(z %*% ch, 2L, fit$mode, "+")
}

# --- the Alzheimer model: MAP + Laplace of the intercept and slope -----------------------------------------------------------------------

#' The individual posterior of one person under the beta_logit family. `par` is `vcr_beta_logit_par(...)`, `study` the study (typical or a
#' drawn one), `covariates` the person's baseline `mmse`, `age`, `apoe` (0 to 2) and `female` (0/1), `t_obs` and `score` their observed
#' ADAS-cog 11 scores (0 to 70) at those weeks, placebo course included as the model has it. Returns the MAP and Laplace posterior of the
#' latent intercept and slope (logit scale).
vcr_beta_logit_individual_posterior <- function(par, study, covariates, t_obs, score) {
  ref <- par[["reference"]]; g <- .VCR_BETA_LOGIT_GUARD; tau <- study[["tau"]]
  m_eta <- study[["muEta"]] + par[["lambdaEta"]] * (covariates$mmse - ref$bmmse)
  m_alpha <- study[["muAlpha"]] + par[["lambdaMmse"]] * (covariates$mmse - ref$bmmse) + par[["lambdaAge"]] * (covariates$age - ref$age) +
    par[["lambdaApoe"]][covariates$apoe + 1L] + par[["lambdaFemale"]] * covariates$female
  u <- pmin(pmax(score / 70, 1e-6), 1 - 1e-6)
  pbo <- vcr_beta_logit_placebo(par, t_obs)
  logpost <- function(p) {
    theta <- stats::plogis(p[1L] + p[2L] * t_obs + pbo)
    ll <- sum(stats::dbeta(u, (theta + g) * tau, (1 - theta + g) * tau, log = TRUE))
    ll + stats::dnorm(p[1L], m_eta, study[["sdEta"]], log = TRUE) + stats::dnorm(p[2L], m_alpha, study[["sdAlpha"]], log = TRUE)
  }
  out <- vcr_map_laplace(logpost, c(m_eta, m_alpha))
  out$prior <- list(mean = c(m_eta, m_alpha), sd = c(study[["sdEta"]], study[["sdAlpha"]]))
  out
}

#' Posterior-predictive scores of one person at `t_new`: `n_draws` draws of the latent intercept and slope from the Laplace posterior, each
#' turned into a score through the model's own beta observation. A person with no observation gets the population draw (the prior), which is
#' what a population forecast is. Returns a matrix, draws in rows and visits in columns.
vcr_beta_logit_individual_predict <- function(par, study, covariates, t_obs, score, t_new, n_draws = 400L) {
  post <- if (length(score)) vcr_beta_logit_individual_posterior(par, study, covariates, t_obs, score) else {
    pri <- vcr_beta_logit_individual_posterior(par, study, covariates, 0, 35)
    list(mode = pri$prior$mean, cov = diag(pri$prior$sd^2, 2L), laplaceOk = TRUE)
  }
  d <- vcr_laplace_draws(post, n_draws)
  pbo <- vcr_beta_logit_placebo(par, t_new)
  out <- vapply(seq_along(t_new), function(j) vcr_beta_logit_scores(stats::plogis(d[, 1L] + d[, 2L] * t_new[j] + pbo[j]), study[["tau"]]), numeric(n_draws))
  if (!is.matrix(out)) out <- matrix(out, nrow = n_draws)
  attr(out, "laplaceOk") <- isTRUE(post$laplaceOk)
  out
}

#' Coverage of the central `levels` intervals of predictive draws against held-out values: one row per level.
vcr_interval_coverage <- function(draws_by_person, truth, levels = c(0.5, 0.8, 0.95)) {
  hit <- vapply(levels, function(l) {
    mapply(function(d, y) { q <- stats::quantile(d, c((1 - l) / 2, 1 - (1 - l) / 2), names = FALSE, type = 7); y >= q[1L] && y <= q[2L] }, draws_by_person, truth)
  }, numeric(length(truth)))
  if (!is.matrix(hit)) hit <- matrix(hit, ncol = length(levels))
  p <- colMeans(hit); n <- nrow(hit)
  data.frame(level = levels, coverage = p, mcse = sqrt(p * (1 - p) / n), n = n)
}
