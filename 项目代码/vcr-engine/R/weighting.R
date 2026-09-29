# ---------------------------------------------------------------------------
# weighting.R — the one weighting kernel all three endpoint families share
# (plan 5.3; attachment C1 conclusion 3).
#
# Hidden knowledge:
#
# - **Entropy balancing is solved in its dual, by Newton, to machine
#   precision.** The primal is a constrained maximum-entropy problem in n
#   unknowns; the dual is unconstrained in as many unknowns as there are
#   balance constraints (usually < 20), convex, and has an analytic Hessian
#   equal to the weighted covariance of the constraint functions. WeightIt
#   2.0.0 reaches the same optimum but stops on `optim`'s relative-objective
#   tolerance (default `reltol = 1e-10`), which leaves standardized
#   differences around 3e-6 — fine for practice, too loose to cross-check
#   against at 1e-8, so `tests/numeric/N07` passes `reltol = 1e-16` when it
#   calls WeightIt. That is a fact about the reference, not about us.
# - **Infeasibility is a deterministic verdict, not a failed optimizer.** If a
#   target mean falls outside [min, max] of that column among the controls, no
#   convex combination can reach it — that is a proof, available before any
#   iteration, and it is what fires `entropy_balance_infeasible` (AC-07, N09).
#   Only when the cheap proof is silent do we fall back on "Newton did not
#   converge", which is evidence and not proof.
# - **The ATT scaling is `sum(w_control) = n_treated`, treated weights 1.**
#   This is WeightIt's convention and the one the Kish ESS is read against.
#   Any other scaling changes ESS by a constant factor and makes the number on
#   the page incomparable with the published ones.
# - **cobalt reports binary covariates as raw differences in proportions**, not
#   standardized. Standardizing them is defensible and would still disagree
#   with every number a statistician has ever seen out of `bal.tab`, so we
#   follow cobalt.
# - **The bootstrap re-estimates the weights inside every resample.** Treating
#   the weights as fixed is the single most common way to publish an interval
#   that is too narrow; attachment C1 lists it as a failure mode, and the
#   engine makes it structurally impossible by only exposing the whole
#   pipeline as the resampled unit.
# ---------------------------------------------------------------------------

#' Solve entropy balancing for the control group.
#'
#' @param C matrix of constraint functions evaluated on the control units
#'   (n_control x m); moments are supplied already expanded (e.g. squares).
#' @param targets length-m vector of target moments (means in the treated).
#' @param base_weights optional prior weights q_i (sampling weights).
#' @return list(weights, lambda, converged, iterations, discrepancy, rule)
vcr_entropy_balance <- function(C, targets, base_weights = NULL,
                                tol = 1e-12, maxit = 200L) {
  C <- as.matrix(C)
  n <- nrow(C); m <- ncol(C)
  if (length(targets) != m) stop("vcr_entropy_balance: targets must match the constraint columns")
  q <- if (is.null(base_weights)) rep(1 / n, n) else base_weights / sum(base_weights)

  # Deterministic infeasibility: a target outside the column range of the
  # controls is outside their convex hull, so no weighting can reach it.
  lo <- apply(C, 2, min); hi <- apply(C, 2, max)
  outside <- which(targets < lo - 1e-12 | targets > hi + 1e-12)
  if (length(outside)) {
    return(list(weights = NULL, lambda = NULL, converged = FALSE, iterations = 0L,
                discrepancy = Inf, rule = "entropy_balance_infeasible",
                infeasibleColumns = outside,
                detail = sprintf("target moment %s outside the control range [%s, %s]",
                                 paste(signif(targets[outside], 6), collapse = ", "),
                                 paste(signif(lo[outside], 6), collapse = ", "),
                                 paste(signif(hi[outside], 6), collapse = ", "))))
  }

  # Centre the constraints on the targets: the dual is then solved at the
  # point where the weighted mean of the centred constraints is zero, which
  # keeps the Hessian well scaled whatever units the covariates are in.
  Z <- sweep(C, 2, targets, "-")
  scale <- apply(abs(Z), 2, max)
  scale[scale <= 0] <- 1
  Zs <- sweep(Z, 2, scale, "/")

  lambda <- rep(0, m)
  converged <- FALSE
  it <- 0L
  w <- q
  for (it in seq_len(maxit)) {
    eta <- as.vector(Zs %*% lambda)
    eta <- eta - max(eta)            # log-sum-exp guard; shifts cancel below
    ew <- q * exp(eta)
    s <- sum(ew)
    if (!is.finite(s) || s <= 0) break
    w <- ew / s
    grad <- as.vector(crossprod(Zs, w))          # weighted mean of centred constraints
    if (max(abs(grad)) < tol) { converged <- TRUE; break }
    Zc <- sweep(Zs, 2, grad, "-")
    H <- crossprod(Zc, Zc * w)
    step <- tryCatch(solve(H, grad), error = function(e) NULL)
    if (is.null(step)) {
      step <- tryCatch(qr.solve(H + diag(1e-10, m), grad), error = function(e) NULL)
      if (is.null(step)) break
    }
    # Backtracking on the dual objective keeps Newton from overshooting when
    # the target sits near the boundary of the hull, which is exactly where a
    # real "barely feasible" comparison lives.
    obj <- function(l) { e <- as.vector(Zs %*% l); log(sum(q * exp(e - max(e)))) + max(e) }
    f0 <- obj(lambda)
    t_step <- 1
    repeat {
      cand <- lambda - t_step * step
      f1 <- obj(cand)
      if (is.finite(f1) && f1 <= f0 + 1e-14 * abs(f0)) break
      t_step <- t_step / 2
      if (t_step < 1e-12) break
    }
    lambda <- lambda - t_step * step
  }
  eta <- as.vector(Zs %*% lambda); eta <- eta - max(eta)
  w <- q * exp(eta); w <- w / sum(w)
  discrepancy <- max(abs(as.vector(crossprod(Z, w))) / pmax(abs(targets), 1))
  list(weights = w, lambda = lambda / scale, converged = converged, iterations = it,
       discrepancy = discrepancy,
       rule = if (converged) NULL else "entropy_balance_infeasible",
       detail = if (converged) NULL else sprintf("Newton did not reach the moment targets in %d iterations (worst relative discrepancy %.3g)", maxit, discrepancy))
}

#' ATT weights for an external control: treated units weight 1, controls
#' entropy-balanced to the treated means and rescaled to sum to n_treated.
vcr_att_entropy_weights <- function(X, treat, moments = 1L, tol = 1e-12, maxit = 200L) {
  X <- as.matrix(X)
  is_t <- treat == 1L
  C <- vcr_expand_moments(X[!is_t, , drop = FALSE], moments)
  T_ <- vcr_expand_moments(X[is_t, , drop = FALSE], moments)
  targets <- colMeans(T_)
  fit <- vcr_entropy_balance(C, targets, tol = tol, maxit = maxit)
  if (is.null(fit$weights)) return(c(fit, list(allWeights = NULL)))
  n_t <- sum(is_t)
  w <- numeric(length(treat))
  w[is_t] <- 1
  w[!is_t] <- fit$weights * n_t
  fit$allWeights <- w
  fit
}

#' Expand a covariate matrix to the requested moments. `moments = 2` adds
#' squares of the non-binary columns only: the square of a 0/1 column is the
#' column itself and would make the constraint matrix rank-deficient.
vcr_expand_moments <- function(X, moments = 1L) {
  X <- as.matrix(X)
  if (moments <= 1L) return(X)
  bin <- apply(X, 2, function(v) all(v %in% c(0, 1)))
  out <- X
  for (p in 2:moments) {
    add <- X[, !bin, drop = FALSE]^p
    if (ncol(add)) {
      colnames(add) <- paste0(colnames(X)[!bin], "^", p)
      out <- cbind(out, add)
    }
  }
  out
}

#' Logistic propensity score and the ATT weights derived from it. Kept for the
#' overlap diagnostic and as the parallel implementation the plan asks for; it
#' is never presented as a second estimator to choose between (plan 5.3).
vcr_propensity_weights <- function(X, treat, estimand = "ATT") {
  df <- as.data.frame(X)
  df$..treat.. <- as.integer(treat)
  fit <- suppressWarnings(stats::glm(..treat.. ~ ., data = df, family = stats::binomial()))
  ps <- as.vector(stats::fitted(fit))
  w <- switch(estimand,
    ATT = ifelse(treat == 1L, 1, ps / (1 - ps)),
    ATE = ifelse(treat == 1L, 1 / ps, 1 / (1 - ps)),
    ATO = ifelse(treat == 1L, 1 - ps, ps),
    stop("vcr_propensity_weights: unknown estimand ", estimand))
  if (identical(estimand, "ATT")) {
    n_t <- sum(treat == 1L)
    w[treat == 0L] <- w[treat == 0L] * n_t / sum(w[treat == 0L])
  }
  list(weights = w, propensity = ps, model = fit, estimand = estimand)
}

#' Kish effective sample size. Reported beside, never instead of, the real
#' patient count (plan 3.5).
vcr_ess <- function(w) {
  w <- w[is.finite(w) & w > 0]
  if (!length(w)) return(0)
  sum(w)^2 / sum(w^2)
}

#' Standardized mean difference, cobalt's conventions: the denominator is the
#' unweighted SD in the focal (treated) group for ATT, and binary covariates
#' are reported as raw proportion differences.
vcr_smd <- function(x, treat, weights = NULL, estimand = "ATT") {
  w <- if (is.null(weights)) rep(1, length(x)) else weights
  t1 <- treat == 1L; t0 <- treat == 0L
  m1 <- stats::weighted.mean(x[t1], w[t1]); m0 <- stats::weighted.mean(x[t0], w[t0])
  binary <- all(x %in% c(0, 1))
  if (binary) return(m1 - m0)
  denom <- switch(estimand,
    ATT = stats::sd(x[t1]),
    ATE = sqrt((stats::var(x[t1]) + stats::var(x[t0])) / 2),
    ATO = sqrt((stats::var(x[t1]) + stats::var(x[t0])) / 2),
    stats::sd(x[t1]))
  if (!is.finite(denom) || denom == 0) return(0)
  (m1 - m0) / denom
}

vcr_balance_table <- function(X, treat, weights = NULL, estimand = "ATT") {
  X <- as.matrix(X)
  nms <- colnames(X) %||% paste0("V", seq_len(ncol(X)))
  unadj <- vapply(seq_len(ncol(X)), function(j) vcr_smd(X[, j], treat, NULL, estimand), numeric(1))
  adj <- vapply(seq_len(ncol(X)), function(j) vcr_smd(X[, j], treat, weights, estimand), numeric(1))
  vr <- vapply(seq_len(ncol(X)), function(j) vcr_variance_ratio(X[, j], treat, weights), numeric(1))
  ks <- vapply(seq_len(ncol(X)), function(j) vcr_weighted_ks(X[, j], treat, weights), numeric(1))
  data.frame(covariate = nms, smdUnadjusted = unadj, smdAdjusted = adj,
             varianceRatio = vr, ksStatistic = ks, stringsAsFactors = FALSE)
}

vcr_variance_ratio <- function(x, treat, weights = NULL) {
  if (all(x %in% c(0, 1))) return(NA_real_)
  w <- if (is.null(weights)) rep(1, length(x)) else weights
  v <- function(idx) {
    ww <- w[idx] / sum(w[idx])
    mu <- sum(ww * x[idx])
    sum(ww * (x[idx] - mu)^2) / (1 - sum(ww^2))
  }
  v(treat == 1L) / v(treat == 0L)
}

#' Weighted two-sample Kolmogorov-Smirnov statistic on the pooled support.
vcr_weighted_ks <- function(x, treat, weights = NULL) {
  w <- if (is.null(weights)) rep(1, length(x)) else weights
  grid <- sort(unique(x))
  cdf <- function(idx) {
    ww <- w[idx] / sum(w[idx])
    vapply(grid, function(g) sum(ww[x[idx] <= g]), numeric(1))
  }
  max(abs(cdf(treat == 1L) - cdf(treat == 0L)))
}

#' Common-support diagnostics on the propensity scale. `outside` is the share
#' of treated units whose score falls outside the control score range — the
#' quantity `outside_common_support` is judged on (plan 5.3).
vcr_common_support <- function(propensity, treat, trim = 0) {
  ps_t <- propensity[treat == 1L]; ps_c <- propensity[treat == 0L]
  lo <- stats::quantile(ps_c, trim, names = FALSE)
  hi <- stats::quantile(ps_c, 1 - trim, names = FALSE)
  outside <- mean(ps_t < lo | ps_t > hi)
  list(treatedRange = range(ps_t), controlRange = range(ps_c),
       outsideShare = outside,
       overlapCoefficient = vcr_overlap_coefficient(ps_t, ps_c))
}

#' Overlap coefficient of two densities, estimated on a shared grid. Reported
#' as a picture-free number so the page can order comparisons by it.
vcr_overlap_coefficient <- function(a, b, n = 512L) {
  rng <- range(c(a, b))
  if (diff(rng) <= 0) return(1)
  da <- stats::density(a, from = rng[1], to = rng[2], n = n)
  db <- stats::density(b, from = rng[1], to = rng[2], n = n)
  h <- da$x[2] - da$x[1]
  sum(pmin(da$y, db$y)) * h
}

#' Weight-distribution diagnostics: the page shows these instead of a picture
#' of the weights, and truncation only ever appears as a sensitivity analysis.
vcr_weight_diagnostics <- function(w, treat) {
  wc <- w[treat == 0L]
  wc <- wc[is.finite(wc) & wc > 0]
  top1 <- if (length(wc) >= 100) sum(sort(wc, decreasing = TRUE)[seq_len(ceiling(length(wc) / 100))]) / sum(wc) else NA_real_
  list(n = length(wc), sum = sum(wc), max = max(wc), mean = mean(wc),
       coefficientOfVariation = stats::sd(wc) / mean(wc),
       topOnePercentShare = top1,
       effectiveSampleSize = vcr_ess(wc))
}

#' Whole-pipeline non-parametric bootstrap: `estimate_fn(data_index)` must
#' re-estimate the weights from the resampled rows. Returns the percentile
#' interval and the share of resamples where the weighting had no solution,
#' which downgrades the conclusion to `limited` above 1% (plan 5.3).
vcr_bootstrap_pipeline <- function(n_rows, estimate_fn, replicates = 2000L,
                                   seed = 1L, strata = NULL, cores = 1L,
                                   level = 0.95) {
  bank <- vcr_stream_bank(seed)
  streams <- bank$take(replicates)
  out <- vcr_map_streams(streams, function(i) {
    idx <- if (is.null(strata)) sample.int(n_rows, n_rows, replace = TRUE)
           else unlist(lapply(split(seq_len(n_rows), strata), function(g) sample(g, length(g), replace = TRUE)), use.names = FALSE)
    tryCatch(estimate_fn(idx), error = function(e) NA_real_)
  }, cores = cores)
  est <- vapply(out, function(x) as.numeric(x)[1], numeric(1))
  ok <- is.finite(est)
  a <- (1 - level) / 2
  list(
    estimates = est,
    failureShare = 1 - mean(ok),
    se = stats::sd(est[ok]),
    interval = as.numeric(stats::quantile(est[ok], c(a, 1 - a), names = FALSE, type = 7)),
    replicates = replicates
  )
}

#' The deterministic not-estimable rules that live on this side (plan 5.3).
#' Returns the first rule that fires, or NULL. Order matters: the reason a
#' reader is given should be the earliest thing that went wrong, not the last
#' check that happened to run.
vcr_not_estimable_weighting <- function(balance = NULL, ess = NULL, ess_floor = NULL,
                                        support = NULL, support_ceiling = 0.1,
                                        smd_floor = NULL, ebal = NULL) {
  if (!is.null(ebal) && !is.null(ebal$rule)) return(list(rule = ebal$rule, detail = ebal$detail))
  if (!is.null(support) && !is.null(support$outsideShare) && support$outsideShare > support_ceiling) {
    return(list(rule = "outside_common_support",
                detail = sprintf("%.1f%% of the trial population falls outside the control score range (ceiling %.1f%%)",
                                 100 * support$outsideShare, 100 * support_ceiling)))
  }
  if (!is.null(ess) && !is.null(ess_floor) && ess < ess_floor) {
    return(list(rule = "effective_sample_size_below_floor",
                detail = sprintf("weighted effective sample size %.1f is below the floor %.1f", ess, ess_floor)))
  }
  floor_ <- smd_floor %||% vcr_domain()$limits$smdFloor
  if (!is.null(balance)) {
    worst <- max(abs(balance$smdAdjusted))
    if (is.finite(worst) && worst >= floor_) {
      j <- which.max(abs(balance$smdAdjusted))
      return(list(rule = "standardized_difference_above_floor",
                  detail = sprintf("%s still differs by %.3f after weighting (floor %.2f)",
                                   balance$covariate[j], balance$smdAdjusted[j], floor_)))
    }
  }
  NULL
}

`%||%` <- function(a, b) if (is.null(a)) b else a
