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

# --- propensity trimming (algorithm round C14, 2026-11-03) ---------------------------------------------------------------------------
#
# Hidden knowledge:
#
# - **Trimming changes who the estimate is about, and the result says so.** The EU HTA guideline (6.2) calls the balanced population that
#   is left "ultimately the target population": a person with no comparable counterpart is not adjusted for, he is removed, and the
#   hazard ratio or difference is the effect among the people who were kept. So the rule returns the people it removed, per arm, and
#   their baseline next to the kept people's (`vcr_trim_restatement`); a result that trimmed nobody says that too.
# - **The score is fitted on everyone, the weights on the people who are left.** Who is trimmed is a function of the score, so the
#   score is fitted on the whole sample; the weights are then refitted on the kept sample, as the trimming literature does
#   (Stuermer 2010; Crump 2009 sect. 5), because a score fitted with the removed people in it is not the score of the population the
#   estimate is about. Inside a bootstrap resample the whole of this is redone, so the interval carries the uncertainty of who is trimmed.
# - **Crump's rule needs no number from the person.** Optimal trimming of Crump, Hotz, Imbens & Mitnik (2009) keeps the people whose
#   score lies in [alpha, 1 - alpha], where 1 / (alpha (1 - alpha)) = 2 E[1 / (e (1 - e)) | alpha <= e <= 1 - alpha]. In a sample: sort
#   g = 1 / (e (1 - e)) from the smallest and keep the largest set whose biggest member is at most twice the set's mean (the set is
#   everyone when the largest g of all already is). The rule of thumb [0.1, 0.9] is its answer for a uniform-ish score. No regulator
#   gives a numeric bound, so a fixed bound is the person's own and is shown as a premise.

#' The score bounds of a trimming rule and who they keep. `trim` is `list(rule = "fixed", lower, upper?)` or `list(rule = "crump")`.
#' @return list(rule, lower, upper, keep) - `keep` is a logical vector over the people
vcr_ps_trim <- function(ps, treat, trim) {
  rule <- as.character(trim$rule %||% "")
  if (identical(rule, "fixed")) {
    lo <- vcr_scalar(trim$lower, NULL)
    if (is.null(lo)) vcr_abort("scenario_field_missing", "scenario.trim.lower", "A fixed trimming rule states the score below which a person is removed.")
    hi <- vcr_scalar(trim$upper, 1 - lo)
    if (!(lo > 0 && lo < 0.5 && hi > 0.5 && hi < 1)) vcr_abort("scenario_value_invalid", "scenario.trim", "The lower bound is between 0 and 0.5 and the upper one between 0.5 and 1.")
  } else if (identical(rule, "crump")) {
    lo <- vcr_crump_alpha(ps); hi <- 1 - lo
    # the set is {g <= lambda}: compared on g, so a person exactly on the bound is not lost to rounding of 1 - alpha
    g <- 1 / (ps * (1 - ps))
    return(list(rule = rule, lower = lo, upper = hi, keep = if (lo > 0) g <= (1 / (lo * (1 - lo))) * (1 + 1e-12) else rep(TRUE, length(ps))))
  } else vcr_abort("scenario_value_invalid", "scenario.trim.rule", "The trimming rule is fixed or crump.")
  list(rule = rule, lower = lo, upper = hi, keep = ps >= lo & ps <= hi)
}

#' Crump's alpha (see the section header): 0 when nobody is trimmed.
vcr_crump_alpha <- function(ps) {
  g <- 1 / (ps * (1 - ps))
  if (!all(is.finite(g))) return(min(ps[is.finite(g)]))
  s <- sort(g)
  ok <- which(s <= 2 * cumsum(s) / seq_along(s))
  lambda <- s[max(ok)]
  if (lambda >= max(s)) return(0)
  # g <= lambda is the same set as alpha <= e <= 1 - alpha, with 1 / (alpha (1 - alpha)) = lambda
  0.5 - sqrt(0.25 - 1 / lambda)
}

#' The weights of a trimmed comparison: the score on everyone, the trimming, the weights refitted on the people who are kept (zero for the
#' others). NULL weights and a rule name when too few people remain in a group to weight at all.
#' @return list(allWeights, keep, propensity (kept people, refitted), trim)
vcr_trimmed_weights <- function(X, treat, estimand, trim) {
  full <- vcr_propensity_weights(X, treat, estimand)
  cut <- vcr_ps_trim(full$propensity, treat, trim)
  keep <- cut$keep
  if (sum(treat[keep] == 1L) < 2L || sum(treat[keep] == 0L) < 2L) {
    return(list(allWeights = NULL, keep = keep, trim = cut, rule = "trimmed_population_too_small",
                detail = sprintf("after the trimming %d trial and %d control people remain; both groups need at least two", sum(treat[keep] == 1L), sum(treat[keep] == 0L))))
  }
  refit <- vcr_propensity_weights(X[keep, , drop = FALSE], treat[keep], estimand)
  w <- numeric(length(treat)); w[keep] <- refit$weights
  list(allWeights = w, keep = keep, propensity = refit$propensity, fullPropensity = full$propensity, trim = cut, rule = NULL)
}

#' Who the trimming removed and who it left, per arm and per covariate: the target population restated. A continuous covariate is
#' reported by its mean and a 0/1 one by its proportion (`binary`); a group with nobody in it has no value.
vcr_trim_restatement <- function(X, treat, keep, cut, covariates = colnames(X)) {
  X <- as.matrix(X)
  arm_row <- function(a, name) {
    n <- sum(treat == a)
    list(arm = name, n = n, kept = sum(keep & treat == a), removed = sum(!keep & treat == a), removedShare = if (n > 0) sum(!keep & treat == a) / n else NA_real_)
  }
  arms <- list(arm_row(1L, "treated"), arm_row(0L, "control"))
  mean_of <- function(v, idx) if (any(idx)) mean(v[idx]) else NA_real_
  rows <- do.call(rbind, lapply(c(1L, 0L), function(a) {
    do.call(rbind, lapply(seq_len(ncol(X)), function(j) {
      v <- X[, j]
      data.frame(covariate = covariates[j], arm = if (a == 1L) "treated" else "control", binary = all(v %in% c(0, 1)),
                 kept = mean_of(v, keep & treat == a), removed = mean_of(v, !keep & treat == a),
                 stringsAsFactors = FALSE)
    }))
  }))
  list(rule = cut$rule, lower = cut$lower, upper = cut$upper, arms = arms, baseline = rows,
       removedTotal = sum(!keep), keptTotal = sum(keep),
       targetPopulation = if (any(!keep)) "trimmed_population" else "full_population",
       note = "the estimate is about the people who were kept: a person with no comparable counterpart is removed, not adjusted for (EU HTA guideline, 6.2)")
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

#' The calendar year in a date cell, or NA. Only closed spellings are read: `YYYY`, `YYYY-MM[-DD]` (with `-`, `/` or `.`, and an
#' optional time after a space or `T`) and `D/M/YYYY` or `M/D/YYYY`, where the four-digit token is the year whatever the order of
#' the other two. Anything else is NA, and so is a year outside 1900-2100; a date is never guessed.
.vcr_year_of <- function(x) {
  s <- trimws(as.character(x))
  year <- rep(NA_integer_, length(s))
  lead <- grepl("^[0-9]{4}([-/.][0-9]{1,2}([-/.][0-9]{1,2})?)?([ T].*)?$", s)
  trail <- grepl("^[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4}$", s)
  year[lead] <- as.integer(substr(s[lead], 1L, 4L))
  year[trail] <- as.integer(substring(s[trail], nchar(s[trail]) - 3L))
  year[!is.na(year) & (year < 1900L | year > 2100L)] <- NA_integer_
  year
}

#' The standardized difference of the calendar year. A trial arm that entered in one year has a standard deviation of 0, which
#' would make the covariate difference 0 whatever the controls' years are; the pooled standard deviation stands in then.
.vcr_year_smd <- function(year, treat, weights, estimand) {
  s1 <- stats::sd(year[treat == 1L])
  if (is.finite(s1) && s1 > 0) return(vcr_smd(year, treat, weights, estimand))
  w <- if (is.null(weights)) rep(1, length(year)) else weights
  pooled <- stats::sd(year)
  if (!is.finite(pooled) || pooled == 0) return(0)
  (stats::weighted.mean(year[treat == 1L], w[treat == 1L]) - stats::weighted.mean(year[treat == 0L], w[treat == 0L])) / pooled
}

#' The enrolment-year row of a comparison (remediation plan D6, 2026-11-01): when the field map named a time-zero date (the event
#' table's `STARTDT`), the calendar year each person entered, per arm, and how far apart the two arms are in it before and after
#' the weights. The year is a check on outcome drift, not a covariate: nothing was weighted on it, so the adjusted difference says
#' whether the weights on the other covariates happened to bring the years together. NULL when the data has no date column; a date
#' column nobody can read a year from is said as such and is not an error. It rides beside the balance table and is not in the
#' balance verdict.
#'
#' @param subj The table the weights were fitted on (after the cohort rules); `USUBJID` links it to the event table.
vcr_enrolment_year <- function(subj, tabs, sc, treat, weights, estimand = "ATT") {
  event <- tabs$event
  if (is.null(event) || !("STARTDT" %in% names(event)) || !("USUBJID" %in% names(event)) || !("USUBJID" %in% names(subj))) return(NULL)
  if (!is.null(sc$parameterCode) && "PARAMCD" %in% names(event)) event <- event[!is.na(event$PARAMCD) & as.character(event$PARAMCD) == as.character(sc$parameterCode), , drop = FALSE]
  at <- match(subj$USUBJID, event$USUBJID)
  year <- .vcr_year_of(ifelse(is.na(at), NA_character_, as.character(event$STARTDT[at])))
  have <- !is.na(year)
  readable <- list(treated = sum(have & treat == 1L), control = sum(have & treat == 0L))
  arms <- list(treated = sum(treat == 1L), control = sum(treat == 0L))
  base <- list(column = "STARTDT", unit = "calendar year", people = arms, readable = readable)
  if (readable$treated < 2L || readable$control < 2L) {
    return(c(base, list(status = if (sum(have) == 0L) "unreadable" else "too_few")))
  }
  y <- as.numeric(year[have]); t <- treat[have]; w <- weights[have]
  one <- function(arm) {
    v <- y[t == arm]
    list(min = min(v), median = stats::median(v), max = max(v), mean = mean(v),
         weightedMean = stats::weighted.mean(v, w[t == arm]))
  }
  tr <- one(1L); co <- one(0L)
  outside <- y[t == 0L] < tr$min | y[t == 0L] > tr$max
  years <- sort(unique(y))
  by_year <- lapply(years, function(yr) list(
    year = yr, treated = sum(y == yr & t == 1L), control = sum(y == yr & t == 0L),
    controlWeightShare = sum(w[y == yr & t == 0L]) / sum(w[t == 0L])))
  c(base, list(
    status = "computed", treated = tr, control = co,
    smdUnadjusted = .vcr_year_smd(y, t, NULL, estimand), smdAdjusted = .vcr_year_smd(y, t, w, estimand),
    controlOutsideTrialYears = list(share = mean(outside), weightedShare = sum(w[t == 0L][outside]) / sum(w[t == 0L])),
    byYear = by_year,
    note = "calendar year of the time-zero date; not part of the weighting and not part of the balance verdict"))
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

#' The bootstrap draws a job actually runs: what the scenario asked for, raised
#' to the domain's floor. The floor is not the scenario's to lower: a job that
#' said 20 draws used to get 20 draws and a 95% interval from twenty points
#' (EB-5). The number used is echoed in the result.
vcr_bootstrap_replicates <- function(requested = NULL) {
  # an imputed comparison (R/imputation.R) shares the floor among its imputations and states the share in its result; nothing else lowers it
  floor_ <- as.integer(.vcr_ctx$bootstrap_floor %||% vcr_limit("bootstrapMin", 2000L))
  as.integer(max(floor_, requested %||% floor_))
}

#' Whole-pipeline non-parametric bootstrap: `estimate_fn(data_index)` must
#' re-estimate the weights from the resampled rows. `estimate_fn` returns one
#' number or a vector of numbers (a primary estimate and its secondaries share
#' the same resamples). Returns the percentile interval(s) and the share of
#' resamples where the weighting had no solution, which downgrades the
#' conclusion to `limited` above 1% (plan 5.3).
#'
#' The draws run in batches so a cancel or a spent CPU budget stops the loop
#' between batches with what has finished (`interrupted` says which).
#'
#' `components` names the entries of the estimate vector (the measure each one is the estimate of). An imputed comparison installs
#' `.vcr_ctx$boot_sink` to read their bootstrap standard deviations (the within-imputation variances of Rubin's rules); a call that
#' names none is read by nobody.
vcr_bootstrap_pipeline <- function(n_rows, estimate_fn, replicates = 2000L,
                                   seed = 1L, strata = NULL, cores = 1L,
                                   level = 0.95, batch_size = 200L, components = NULL) {
  bank <- vcr_stream_bank(seed)
  rows <- list(); done <- 0L; interrupted <- NULL
  while (done < replicates) {
    reason <- vcr_interrupt()
    if (!is.null(reason)) { interrupted <- reason; break }
    take <- min(batch_size, replicates - done)
    streams <- bank$take(take)
    out <- vcr_map_streams(streams, function(i) {
      idx <- if (is.null(strata)) sample.int(n_rows, n_rows, replace = TRUE)
             else unlist(lapply(split(seq_len(n_rows), strata), function(g) g[sample.int(length(g), length(g), replace = TRUE)]), use.names = FALSE)
      tryCatch(as.numeric(estimate_fn(idx)), error = function(e) NA_real_)
    }, cores = cores, indices = done + seq_len(take))
    rows <- c(rows, out)
    done <- done + take
  }
  width <- max(vapply(rows, length, integer(1)), 1L)
  est <- do.call(rbind, lapply(rows, function(r) if (length(r) == width) r else rep(NA_real_, width)))
  if (is.null(est)) est <- matrix(NA_real_, 0L, width)
  a <- (1 - level) / 2
  # Each component has its own finite draws: a secondary ratio that is
  # undefined in a resample (a zero cell) does not discard the primary estimate
  # of that resample. The failure share is the primary's.
  ints <- t(vapply(seq_len(width), function(j) {
    col <- est[is.finite(est[, j]), j]
    if (length(col) < 2L) return(c(NA_real_, NA_real_))
    as.numeric(stats::quantile(col, c(a, 1 - a), names = FALSE, type = 7))
  }, numeric(2)))
  prim <- is.finite(est[, 1])
  if (is.function(.vcr_ctx$boot_sink) && length(components)) {
    k <- min(width, length(components))
    .vcr_ctx$boot_sink(list(components = components[seq_len(k)], replicates = done,
                            sd = vapply(seq_len(k), function(j) { col <- est[is.finite(est[, j]), j]; if (length(col) >= 2L) stats::sd(col) else NA_real_ }, numeric(1))))
  }
  list(
    estimates = est[, 1],
    estimatesMatrix = est,
    failureShare = if (nrow(est)) 1 - mean(prim) else 1,
    se = stats::sd(est[prim, 1]),
    interval = ints[1, ],
    intervals = ints,
    componentFailureShare = if (nrow(est)) 1 - colMeans(is.finite(est)) else rep(1, width),
    replicates = done, requested = replicates, interrupted = interrupted
  )
}

#' The deterministic not-estimable rules that live on this side (plan 5.3).
#' Returns the first rule that fires, or NULL. Order matters: the reason a
#' reader is given should be the earliest thing that went wrong, not the last
#' check that happened to run.
#'
#' Covariate balance is not among them since 2026-11-01 (owner decision, remediation
#' plan section 7 item 2): 0.1 is a convention, not a law, and a comparison that is
#' unbalanced is still an estimate a reader can weigh when the balance is shown
#' beside it. `vcr_balance_verdict` reads it and the job says `limited`. A job labelled
#' with a release from before that (the weighting jobs before 1.2.0, AIPW and the
#' negative-control analysis before 1.1.0) replays what that release did: its caller
#' passes `balance` (and a stricter `smd_floor` if it has one), and the rule below
#' refuses a weighted covariate still apart by the floor. Every other caller passes none.
vcr_not_estimable_weighting <- function(ess = NULL, ess_floor = NULL, support = NULL, support_ceiling = NULL, ebal = NULL,
                                        balance = NULL, smd_floor = NULL) {
  # Every threshold is the domain's; a caller may only pass a *stricter* one.
  ess_floor <- max(ess_floor %||% 0, vcr_limit("essFloor", 10))
  support_ceiling <- min(support_ceiling %||% Inf, vcr_limit("supportCeiling", 0.1))
  if (!is.null(ebal) && !is.null(ebal$rule)) return(list(rule = ebal$rule, detail = ebal$detail))
  if (!is.null(support) && !is.null(support$outsideShare) && support$outsideShare > support_ceiling) {
    return(list(rule = "outside_common_support",
                detail = sprintf("%.1f%% of the trial population falls outside the control score range (ceiling %.1f%%)",
                                 100 * support$outsideShare, 100 * support_ceiling)))
  }
  if (!is.null(ess) && ess < ess_floor) {
    return(list(rule = "effective_sample_size_below_floor",
                detail = sprintf("weighted effective sample size %.1f is below the floor %.1f", ess, ess_floor)))
  }
  floor_ <- min(smd_floor %||% Inf, vcr_limit("smdFloor", 0.1))
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

#' What the weighted balance says about the comparison (owner decision 2026-11-01, remediation plan
#' section 7 item 2). The estimate is delivered in every band and the balance rides beside it:
#'
#'   - `balanced`: the worst weighted standardized difference is at most `smdFloor` (0.10);
#'   - `moderate`: above 0.10 and at most `smdSevere` (0.25) - the estimate is `limited`, and the
#'     value and the worst variable are said;
#'   - `severe`: above 0.25 - `limited` as well, and the reason is a severe imbalance.
#'
#' Both thresholds are the domain's (`vcr_limit`), never a scenario key. Returns NULL for no table.
vcr_balance_verdict <- function(balance) {
  if (is.null(balance) || !nrow(balance)) return(NULL)
  a <- abs(balance$smdAdjusted)
  if (!any(is.finite(a))) return(NULL)
  j <- which.max(replace(a, !is.finite(a), -Inf))
  floor_ <- vcr_limit("smdFloor", 0.1); severe <- vcr_limit("smdSevere", 0.25)
  worst <- a[j]
  list(band = if (worst > severe) "severe" else if (worst > floor_) "moderate" else "balanced",
       worst = worst, variable = balance$covariate[j], smd = balance$smdAdjusted[j], floor = floor_, severeFloor = severe)
}

#' The `limitedBy` code a balance verdict adds, or NULL when the covariates are balanced.
vcr_balance_limit <- function(verdict) {
  if (is.null(verdict)) return(NULL)
  switch(verdict$band, severe = "standardized_difference_severe", moderate = "standardized_difference_above_floor", NULL)
}

`%||%` <- function(a, b) if (is.null(a)) b else a
