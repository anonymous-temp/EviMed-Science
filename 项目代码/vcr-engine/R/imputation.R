# ---------------------------------------------------------------------------
# imputation.R — multiple imputation of missing covariates for the weighting
# comparators (algorithm round C7, 2026-11-03).
#
# Hidden knowledge:
#
# - **What a missing covariate did before.** The four comparators that share the
#   weighting kernel (entropy balancing, propensity weighting, the weighted Cox
#   model, the doubly robust estimator) refused a table with a missing covariate
#   by name (`missing_covariate`: weighting.R's job at engine.R, and
#   `vcr_comparison_frame` in comparison.R for the other two), because weights
#   "are not estimated on incomplete rows". They never dropped the rows, so a
#   person with 20% missing had no result at all. A scenario that states
#   `imputation: { m }` now runs the same analysis on `m` completed tables and
#   reads the answer by Rubin's rules, with the complete-case answer beside it.
#   A scenario without the key keeps the refusal.
# - **Imputation first, then the bootstrap inside each completed table, then
#   Rubin.** The weights are re-estimated in every resample (the bootstrap's
#   whole point), so a completed table is analysed by the unchanged handler:
#   its point estimate is the estimate, its bootstrap standard deviation is the
#   within-imputation variance. Rubin's total variance is
#   `Ubar + (1 + 1/m) B` and the interval is `estimate +- t_df sqrt(T)` with the
#   Barnard-Rubin degrees of freedom (a complete-data df of rows minus the
#   covariates and one). Ratios are pooled on the log scale. This is the
#   "MI then bootstrap, pooled by Rubin" order of Schomaker & Heumann (2018): a
#   percentile interval pooled over every draw of every imputation would
#   understate the imputation variance, and a bootstrap that imputes inside each
#   resample multiplies the cost of one resample by the imputation.
# - **The CPU is shared, not multiplied.** A standard error needs far fewer
#   draws than a percentile interval, so the bootstrap's floor (the domain's
#   2,000 draws, or the job's `replicates` when larger) is divided over the `m`
#   imputations and the complete-case run, never fewer than 100 draws a run. The
#   result says how many each run had (`bootstrap.perRun`) and that the interval
#   is Rubin's, not a percentile interval. The budget is checked between the
#   runs and inside each bootstrap: a run that is stopped is discarded, the
#   imputations that finished are pooled (two are the least Rubin's rules can
#   read), and the result says `imputations_stopped_early` with the number that
#   finished. Fewer than two finished: `failed`, with the complete-case answer
#   kept in the diagnostics.
# - **The imputation model is the analysis model's relatives.** Each incomplete
#   covariate is imputed from every other covariate, the arm and the outcome
#   (White & Royston 2009: a time-to-event outcome enters as the event
#   indicator and the Nelson-Aalen estimate of the cumulative hazard at the
#   person's own time), by chained equations: predictive mean matching for a
#   numeric covariate (five donors, the draw of the regression's parameters
#   included), a logistic draw for a 0/1 covariate, a multinomial draw from
#   `nnet` for a covariate the scenario declares categorical. Nothing else, and
#   no interaction: a covariate coded as a set of indicators is imputed
#   indicator by indicator, which can give a person two categories at once, so a
#   categorical covariate is stated as one coded column. Missing at random given
#   those variables is the assumption, and the result says so.
# - **The rows are the cohort's.** The downstream cohort rules are applied
#   before anything is imputed and the inner analysis sees exactly those rows
#   (so an excluded person never takes part in an imputation model, and a rule
#   that read an imputed covariate cannot change who is analysed).
# - **Same seed, any core count.** Imputation `i` draws from its own L'Ecuyer
#   stream and runs in the parent process; the bootstrap inside a completed
#   table is the pipeline's, which is already independent of the core count.
# - `mice` and `TrialEmulation` are cross-checks in CI (N78) and are never called
#   from here: every method of this file is written out.
# ---------------------------------------------------------------------------

# --- the pieces of one chained-equations run ------------------------------------------

#' The method that imputes a column: `logreg` for a 0/1 column, `polyreg` for a column the scenario declares categorical, `pmm`
#' for any other number. A column with one observed value is that value (`constant`).
.vcr_impute_kind <- function(x, categorical = FALSE) {
  u <- sort(unique(x[!is.na(x)]))
  if (length(u) <= 1L) return("constant")
  if (isTRUE(categorical)) return(if (length(u) == 2L) "logreg" else "polyreg")
  if (length(u) == 2L && all(u %in% c(0, 1))) "logreg" else "pmm"
}

#' Standardise the columns of a predictor matrix (constant columns are dropped) so that the fits below are well conditioned whatever
#' units a covariate is in. Returns the matrix with an intercept column.
.vcr_impute_design <- function(X) {
  X <- as.matrix(X)
  if (!ncol(X)) return(matrix(1, nrow(X), 1L))
  mu <- colMeans(X); sdv <- apply(X, 2, stats::sd)
  keep <- is.finite(sdv) & sdv > 1e-12
  if (!any(keep)) return(matrix(1, nrow(X), 1L))
  cbind(1, sweep(sweep(X[, keep, drop = FALSE], 2, mu[keep], "-"), 2, sdv[keep], "/"))
}

#' Predictive mean matching of a numeric column (Little 1988; Rubin's type 1 matching): the regression of the column on the
#' predictors is fitted on the people who have it, its parameters are DRAWN from their posterior for the people who lack it (so the
#' imputation carries the model's uncertainty), and each missing value is replaced by the observed value of one of the `donors` people
#' whose prediction (at the fitted parameters) is nearest the missing person's prediction (at the drawn ones).
.vcr_impute_pmm <- function(y, ry, X, donors = 5L) {
  Z <- .vcr_impute_design(X)
  zo <- Z[ry, , drop = FALSE]; zm <- Z[!ry, , drop = FALSE]; yo <- y[ry]
  fit <- stats::lm.fit(zo, yo)
  p <- fit$rank; piv <- fit$qr$pivot[seq_len(p)]
  beta <- fit$coefficients[piv]
  df <- length(yo) - p
  beta_star <- beta
  if (df >= 1L) {
    rss <- sum(fit$residuals^2)
    sig <- sqrt(rss / stats::rchisq(1, df))
    R <- qr.R(fit$qr)[seq_len(p), seq_len(p), drop = FALSE]
    beta_star <- beta + sig * backsolve(R, stats::rnorm(p))
  }
  yhat_o <- as.vector(zo[, piv, drop = FALSE] %*% beta)
  yhat_m <- as.vector(zm[, piv, drop = FALSE] %*% beta_star)
  ord <- order(yhat_o); ys <- yhat_o[ord]; vals <- yo[ord]
  n <- length(ys); d <- min(as.integer(donors), n)
  pos <- findInterval(yhat_m, ys)
  start <- pmin(pmax(pos - d + 1L, 1L), n - min(n, 2L * d) + 1L)
  width <- min(n, 2L * d)
  idx <- outer(start, seq_len(width) - 1L, "+")
  dist <- abs(matrix(ys[idx], nrow = length(yhat_m)) - yhat_m)
  pick <- vapply(seq_along(yhat_m), function(i) idx[i, order(dist[i, ])[seq_len(d)][sample.int(d, 1L)]], integer(1))
  vals[pick]
}

#' Logistic regression by iteratively reweighted least squares with a ridge on every coefficient but the intercept. `ridge` is the
#' fixed penalty; the covariance of the coefficients is that of the penalised fit. Returns `beta`, `cov` and whether it separated.
.vcr_logit_fit <- function(Z, y, ridge = 1e-6, maxit = 40L) {
  p <- ncol(Z); beta <- rep(0, p); pen <- diag(c(0, rep(ridge, p - 1L)), p)
  A <- NULL
  for (it in seq_len(maxit)) {
    eta <- as.vector(Z %*% beta); mu <- stats::plogis(eta)
    w <- pmax(mu * (1 - mu), 1e-10)
    A <- crossprod(Z, Z * w) + pen
    step <- tryCatch(solve(A, crossprod(Z, y - mu) - pen %*% beta), error = function(e) NULL)
    if (is.null(step)) break
    beta <- beta + as.vector(step)
    if (max(abs(step)) < 1e-9) break
  }
  list(beta = beta, cov = tryCatch(solve(A), error = function(e) NULL), separated = max(abs(beta)) > 12)
}

#' A logistic draw for a 0/1 column: the coefficients are drawn from their asymptotic normal posterior, the probability follows from
#' the draw, and the value is a Bernoulli draw. When the fit separates (a predictor that perfectly predicts the column) it is refitted
#' with a stronger ridge, so a draw is never an infinite coefficient.
.vcr_impute_logreg <- function(y, ry, X) {
  Z <- .vcr_impute_design(X)
  zo <- Z[ry, , drop = FALSE]; yo <- y[ry]
  fit <- .vcr_logit_fit(zo, yo)
  if (isTRUE(fit$separated) || is.null(fit$cov)) fit <- .vcr_logit_fit(zo, yo, ridge = 1)
  beta <- fit$beta
  if (!is.null(fit$cov)) {
    L <- tryCatch(chol(fit$cov), error = function(e) NULL)
    if (!is.null(L)) beta <- beta + as.vector(crossprod(L, stats::rnorm(length(beta))))
  }
  p <- stats::plogis(as.vector(Z[!ry, , drop = FALSE] %*% beta))
  as.numeric(stats::runif(length(p)) < p)
}

#' A multinomial draw for a categorical column through `nnet::multinom`: the coefficients are drawn from the normal approximation
#' that the fit's own Hessian gives (the draw is skipped when that covariance is not usable, and the imputation is then not proper:
#' the result's note says it), the class probabilities follow, and the value is a categorical draw. A small `decay` keeps a perfectly
#' predicted class from an infinite coefficient.
.vcr_impute_polyreg <- function(y, ry, X) {
  Z <- .vcr_impute_design(X)[, -1L, drop = FALSE]
  lv <- sort(unique(y[ry]))
  d <- data.frame(.y = factor(y[ry], levels = lv), Z[ry, , drop = FALSE])
  fit <- suppressWarnings(nnet::multinom(.y ~ ., data = d, trace = FALSE, maxit = 300L, decay = 1e-4, Hess = TRUE, MaxNWts = 10000L))
  cf <- stats::coef(fit)                                  # (levels - 1) x (1 + predictors)
  b <- as.vector(t(cf))
  V <- tryCatch(stats::vcov(fit), error = function(e) NULL)
  if (!is.null(V) && nrow(V) == length(b)) {
    L <- tryCatch(chol(V), error = function(e) NULL)
    if (!is.null(L)) b <- b + as.vector(crossprod(L, stats::rnorm(length(b))))
  }
  B <- matrix(b, nrow = nrow(cf), byrow = TRUE)
  eta <- cbind(1, Z[!ry, , drop = FALSE]) %*% t(B)       # people x (levels - 1), against the first level
  e <- cbind(0, eta); e <- e - apply(e, 1L, max)
  pr <- exp(e); pr <- pr / rowSums(pr)
  u <- stats::runif(nrow(pr))
  lv[pmin(ncol(pr), 1L + rowSums(u > t(apply(pr, 1L, cumsum))))]
}

#' The Nelson-Aalen estimate of the cumulative hazard at each person's own time (White & Royston 2009 put it in the imputation model
#' of a covariate when the outcome is a time to event, with the event indicator).
.vcr_nelson_aalen <- function(time, status) {
  ev <- sort(unique(time[status == 1L]))
  if (!length(ev)) return(rep(0, length(time)))
  d <- vapply(ev, function(t) sum(time == t & status == 1L), numeric(1))
  r <- vapply(ev, function(t) sum(time >= t), numeric(1))
  H <- cumsum(d / r)
  i <- findInterval(time, ev)
  ifelse(i > 0L, H[pmax(i, 1L)], 0)
}

#' One imputation by chained equations. `D` is the numeric table of the covariates (NA where missing), `extras` a complete numeric
#' matrix of the other predictors (the arm and the outcome terms), `kinds` the method of each incomplete column. The missing values
#' are first filled with draws from the observed ones, then each incomplete column in turn is re-imputed from all the others for
#' `maxit` cycles. The random draws come from the stream installed by the caller.
vcr_chained_impute <- function(D, extras, kinds, maxit = 10L, donors = 5L) {
  M <- is.na(D)
  cols <- names(kinds)
  for (j in cols) {
    obs <- D[[j]][!M[, j]]
    D[[j]][M[, j]] <- obs[sample.int(length(obs), sum(M[, j]), replace = TRUE)]
  }
  for (it in seq_len(maxit)) {
    for (j in cols) {
      ry <- !M[, j]
      kind <- kinds[[j]]
      if (identical(kind, "constant")) { D[[j]][!ry] <- D[[j]][ry][1L]; next }
      X <- cbind(as.matrix(D[, setdiff(names(D), j), drop = FALSE]), extras)
      D[[j]][!ry] <- switch(kind,
        pmm = .vcr_impute_pmm(D[[j]], ry, X, donors),
        logreg = .vcr_impute_logreg(D[[j]], ry, X),
        polyreg = .vcr_impute_polyreg(D[[j]], ry, X))
    }
  }
  D
}

# --- Rubin's rules ------------------------------------------------------------------------

#' Rubin's rules for one quantity over the imputations that produced an estimate and its within-imputation variance: the pooled
#' estimate, the total variance `Ubar + (1 + 1/m) B`, the relative increase in variance, the fraction of missing information and the
#' Barnard-Rubin (1999) degrees of freedom for a complete-data df of `dfcom` (`Inf` gives Rubin's original). NULL for fewer than two
#' finite estimates.
vcr_rubin_pool <- function(est, within, dfcom = Inf) {
  ok <- is.finite(est) & is.finite(within)
  q <- est[ok]; u <- within[ok]; m <- length(q)
  if (m < 2L) return(NULL)
  qbar <- mean(q); ubar <- mean(u); b <- stats::var(q)
  total <- ubar + (1 + 1 / m) * b
  r <- (1 + 1 / m) * b / ubar
  lambda <- (1 + 1 / m) * b / total
  df_old <- if (lambda > 0) (m - 1) / lambda^2 else Inf
  df <- if (!is.finite(df_old)) Inf else if (is.finite(dfcom)) {
    df_obs <- (dfcom + 1) / (dfcom + 3) * dfcom * (1 - lambda)
    df_old * df_obs / (df_old + df_obs)
  } else df_old
  fmi <- if (is.finite(df)) (r + 2 / (df + 3)) / (r + 1) else lambda
  list(estimate = qbar, within = ubar, between = b, total = total, se = sqrt(total), df = df, m = m,
       relativeIncrease = r, fractionMissingInformation = fmi, mcse = sqrt(b / m))
}

# --- the wrapper -----------------------------------------------------------------------------

#' Components of the estimate vector, by measure, that are ratios pooled on the log scale (the bootstrap draws of these are already
#' on the log scale: the weighting job keeps `log(risk ratio)`, the Cox job the coefficient, the doubly robust job the log ratios).
.VCR_POOLED_LOG_SCALE <- c("weighted_risk_ratio", "weighted_odds_ratio", "hazard_ratio", "aipw_risk_ratio", "aipw_odds_ratio")

#' The seed of a part of an imputed run, from the job's seed and a tag (the same construction as the pairing of generated patients).
.vcr_imputation_seed <- function(seed, tag) strtoi(substr(vcr_sha256(paste("imputation-v1", seed, tag, sep = ":")), 1L, 7L), base = 16L)

#' The covariate columns a comparator's analysis reads.
.vcr_imputation_covariates <- function(job) {
  sc <- job[["scenario"]]
  covs <- vcr_chr(sc[["covariates"]])
  if (identical(job[["method"]], "comparator.aipw")) {
    ps <- if (!is.null(sc[["propensityCovariates"]])) vcr_chr(sc[["propensityCovariates"]]) else covs
    oc <- if (!is.null(sc[["outcomeCovariates"]])) vcr_chr(sc[["outcomeCovariates"]]) else covs
    return(unique(c(ps, oc)))
  }
  covs
}

#' The endpoint a comparator's job analyses (the same rule each handler applies).
.vcr_imputation_endpoint <- function(job, tabs) {
  sc <- job[["scenario"]]
  if (identical(job[["method"]], "comparator.weighted_cox")) return("time_to_event")
  as.character(sc[["endpoint"]][["type"]] %||% (if (!is.null(sc[["tau"]]) || !is.null(tabs$event)) "time_to_event" else "continuous"))
}

#' Run `handler` on a copy of the job whose subject table is `subject` (the table the hook hands it), with `B` bootstrap draws and the
#' bootstrap's own seed, and return the result with the standard deviations of the bootstrap components it kept.
.vcr_inner_run <- function(handler, job, subject, B, seed, output_dir, cancel_file, ...) {
  inner <- job
  inner[["scenario"]][["imputation"]] <- NULL
  inner[["scenario"]][["cohortRules"]] <- NULL
  inner[["replicates"]] <- as.integer(B)
  inner[["seed"]] <- as.integer(seed)
  sink <- NULL
  .vcr_ctx$tables_hook <- function(tabs) { tabs$subject <- subject; tabs }
  .vcr_ctx$bootstrap_floor <- as.integer(B)
  .vcr_ctx$boot_sink <- function(x) sink <<- x
  on.exit({ .vcr_ctx$tables_hook <- NULL; .vcr_ctx$bootstrap_floor <- NULL; .vcr_ctx$boot_sink <- NULL }, add = TRUE)
  res <- handler(inner, output_dir = output_dir, cancel_file = cancel_file, ...)
  list(result = res, sink = sink)
}

#' The estimates of an inner run that the pooling reads: for every bootstrap component the point estimate (the value of the measure
#' of that name, on the log scale for a ratio), the bootstrap variance, and the scale.
.vcr_pool_inputs <- function(run) {
  res <- run$result; sink <- run$sink
  if (is.null(sink) || is.null(sink$components)) return(list())
  out <- list()
  for (k in seq_along(sink$components)) {
    nm <- sink$components[[k]]
    mm <- Filter(function(m) identical(m$name, nm), res$measures)
    if (!length(mm) || !is.finite(mm[[1]]$value) || !is.finite(sink$sd[[k]])) next
    log_scale <- nm %in% .VCR_POOLED_LOG_SCALE
    v <- mm[[1]]$value
    if (log_scale && !(v > 0)) next
    out[[nm]] <- list(estimate = if (log_scale) log(v) else v, variance = sink$sd[[k]]^2, scale = if (log_scale) "log" else "identity",
                      unit = mm[[1]]$unit)
  }
  out
}

#' A pooled estimate on the reporting scale with its interval.
.vcr_pooled_row <- function(pool, scale, level = 0.95) {
  crit <- if (is.finite(pool$df)) stats::qt(1 - (1 - level) / 2, pool$df) else stats::qnorm(1 - (1 - level) / 2)
  lo <- pool$estimate - crit * pool$se; hi <- pool$estimate + crit * pool$se
  back <- if (identical(scale, "log")) exp else identity
  list(estimate = back(pool$estimate), lower = back(lo), upper = back(hi), se = pool$se, scale = scale)
}

#' Wrap a comparator handler so that a scenario that states `imputation` runs it on completed tables.
vcr_with_imputation <- function(handler) {
  force(handler)
  function(job, output_dir = NULL, cancel_file = NULL, ...) {
    imp <- job[["scenario"]][["imputation"]]
    if (is.null(imp)) return(handler(job, output_dir = output_dir, cancel_file = cancel_file, ...))
    .vcr_imputed_run(handler, job, imp, output_dir, cancel_file, ...)
  }
}

.vcr_imputed_run <- function(handler, job, imp, output_dir, cancel_file, ...) {
  sc <- job[["scenario"]]
  plain <- function() { j <- job; j[["scenario"]][["imputation"]] <- NULL; handler(j, output_dir = output_dir, cancel_file = cancel_file, ...) }
  tabs <- vcr_job_tables(job)
  subj <- .vcr_main_table(tabs)
  # the checks that come before the covariates in every handler: a table that fails one is refused by the handler, with its own words
  prepared <- tryCatch({
    vcr_require_individual(subj, "An imputed comparison", method = job[["method"]])
    covs <- .vcr_imputation_covariates(job)
    tc <- .vcr_column_name(sc[["treatmentColumn"]], "arm", "scenario.treatmentColumn")
    cohort <- vcr_apply_downstream_cohort(subj, sc[["cohortRules"]])
    d <- cohort$data
    if (!length(covs) || !all(c(covs, tc) %in% names(d))) stop("columns")
    tr <- d[[tc]]
    if (anyNA(tr) || !all(tr %in% c(0, 1))) stop("arm")
    X <- as.matrix(d[, covs, drop = FALSE])
    if (!is.numeric(X)) stop("numeric")
    endpoint <- .vcr_imputation_endpoint(job, tabs)
    outcome <- vcr_outcome_frame(sc, tabs, subj, endpoint)
    list(covs = covs, tc = tc, cohort = cohort, d = d, treat = as.integer(tr), endpoint = endpoint, outcome = outcome)
  }, error = function(e) NULL)
  if (is.null(prepared)) return(plain())
  covs <- prepared$covs; d <- prepared$d; treat <- prepared$treat; cohort <- prepared$cohort; keep <- cohort$keep
  outcome <- prepared$outcome
  if (!is.null(outcome$y)) outcome$y <- outcome$y[keep]
  if (!is.null(outcome$time)) { outcome$time <- outcome$time[keep]; outcome$status <- outcome$status[keep] }
  if (anyNA(outcome$y) || anyNA(outcome$time) || anyNA(outcome$status)) return(plain())
  m <- as.integer(vcr_scalar(imp[["m"]], 20L)); maxit <- as.integer(vcr_scalar(imp[["maxIterations"]], 10L))
  categorical <- vcr_chr(imp[["categorical"]])
  Xd <- d[, covs, drop = FALSE]
  incomplete <- names(which(colSums(is.na(Xd)) > 0L))
  n <- nrow(d)
  if (!length(incomplete)) {
    res <- plain()
    res$diagnostics$imputation <- list(performed = FALSE, requested = m, reason = "no_missing_covariate",
                                       note = "No covariate has a missing value in the rows analysed, so the analysis ran as it stands.")
    return(res)
  }
  bad_cat <- setdiff(categorical, covs)
  if (length(bad_cat)) vcr_abort("scenario_value_invalid", "scenario.imputation.categorical", "A categorical covariate is one of the covariates.")
  kinds <- setNames(lapply(incomplete, function(j) .vcr_impute_kind(Xd[[j]], j %in% categorical)), incomplete)
  extras_names <- "arm"
  extras <- cbind(arm = treat)
  if (!is.null(outcome$y)) { extras <- cbind(extras, outcome = outcome$y); extras_names <- c(extras_names, "outcome") }
  else { extras <- cbind(extras, event = outcome$status, cumulative_hazard = .vcr_nelson_aalen(outcome$time, outcome$status)); extras_names <- c(extras_names, "event", "cumulative_hazard") }
  for (j in incomplete) {
    n_obs <- sum(!is.na(Xd[[j]])); k <- length(covs) - 1L + ncol(extras)
    if (n_obs < max(10L, k + 2L)) vcr_abort("imputation_not_possible", "scenario.imputation",
      sprintf("Covariate '%s' has %d observed values, too few to impute it from %d other variables.", j, n_obs, k))
    if (identical(kinds[[j]], "polyreg") && length(unique(Xd[[j]][!is.na(Xd[[j]])])) > 8L)
      vcr_abort("imputation_not_possible", "scenario.imputation.categorical", sprintf("Covariate '%s' has more than eight categories.", j))
  }

  # --- the budget: the bootstrap's floor is shared by the imputations and the complete-case run
  B_total <- vcr_bootstrap_replicates(vcr_scalar(job[["replicates"]], NULL))
  runs <- m + 1L
  B_run <- as.integer(max(100L, ceiling(B_total / runs)))
  dfcom <- max(1, n - length(covs) - 1)

  incomplete_rows <- rowSums(is.na(Xd)) > 0L
  base_out <- NULL
  # --- complete cases
  cc_rows <- !incomplete_rows
  cc_run <- NULL
  cc_note <- list(available = FALSE, rows = sum(cc_rows), droppedRows = sum(incomplete_rows))
  if (sum(cc_rows) >= 4L) {
    cc_run <- tryCatch(.vcr_inner_run(handler, job, d[cc_rows, , drop = FALSE], B_run, .vcr_imputation_seed(job[["seed"]], "complete-cases"), NULL, cancel_file, ...),
                       vcr_refusal = function(e) list(result = list(status = "failed", issues = list(e$issue)), sink = NULL))
  }
  if (!is.null(cc_run) && identical(cc_run$result$status, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = n), diagnostics = list(imputationsCompleted = 0L, imputationsRequested = m)))
  }
  cc_inputs <- if (!is.null(cc_run) && identical(cc_run$result$status, "succeeded")) .vcr_pool_inputs(cc_run) else list()
  if (!is.null(cc_run)) {
    cc_note$status <- cc_run$result$status
    cc_note$rule <- cc_run$result$notEstimableRule
    cc_note$available <- length(cc_inputs) > 0L
  }

  # --- the imputations
  bank <- vcr_stream_bank(.vcr_imputation_seed(job[["seed"]], "imputation-streams"))
  streams <- bank$take(m)
  runs_done <- list(); dropped <- list(); stopped <- NULL
  for (i in seq_len(m)) {
    reason <- vcr_interrupt()
    if (!is.null(reason)) { stopped <- reason; break }
    done <- vcr_with_stream(streams[[i]], function(.) vcr_chained_impute(Xd, extras, kinds, maxit), i)
    completed <- d
    completed[, covs] <- done[, covs, drop = FALSE]
    run <- .vcr_inner_run(handler, job, completed, B_run, .vcr_imputation_seed(job[["seed"]], paste0("bootstrap-", i)),
                          if (length(runs_done) == 0L) output_dir else NULL, cancel_file, ...)
    st <- run$result$status
    if (identical(st, "canceled")) return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = n),
                                              diagnostics = list(imputationsCompleted = length(runs_done), imputationsRequested = m)))
    if (identical(st, "failed") && any(vapply(run$result$issues %||% list(), function(x) identical(x$code, "cpu_budget_exhausted"), logical(1)))) { stopped <- "cpu_budget"; break }
    if (identical(st, "failed")) return(run$result)
    if (identical(st, "not_estimable")) { dropped[[length(dropped) + 1L]] <- list(imputation = i, rule = run$result$notEstimableRule); next }
    runs_done[[length(runs_done) + 1L]] <- run
  }
  done_n <- length(runs_done)
  cc_diag <- c(cc_note, list(estimates = lapply(names(cc_inputs), function(nm) {
    r <- cc_inputs[[nm]]
    row <- .vcr_pooled_row(list(estimate = r$estimate, se = sqrt(r$variance), df = Inf), r$scale)
    c(list(name = nm), row)
  })))
  imp_diag <- list(performed = TRUE, requested = m, completed = done_n, maxIterations = maxit, assumption = "missing_at_random_given_the_variables_below",
                   rowsAnalysed = n, rowsIncomplete = sum(incomplete_rows), shareIncomplete = mean(incomplete_rows),
                   covariates = lapply(incomplete, function(j) list(name = j, missing = sum(is.na(Xd[[j]])), share = mean(is.na(Xd[[j]])), method = kinds[[j]])),
                   predictors = as.list(c(setdiff(covs, character(0)), extras_names)),
                   bootstrap = list(perRun = B_run, runs = runs, drawsInTotal = runs * B_run, floor = B_total,
                                    basis = "the bootstrap floor is shared by the imputations and the complete-case run, never fewer than 100 draws a run; each run gives the standard error of its estimate and the interval is Rubin's"),
                   droppedImputations = dropped, stoppedBy = stopped, completeCase = cc_diag,
                   diagnosticsFrom = "first_completed_data_set", intervalBasis = "Rubin's rules on the bootstrap standard errors, Barnard-Rubin degrees of freedom")
  if (done_n < 2L) {
    if (!is.null(stopped) || length(dropped)) {
      return(list(status = if (!is.null(stopped)) "failed" else "not_estimable",
                  notEstimableRule = if (is.null(stopped) && length(dropped)) dropped[[1]]$rule else NULL,
                  measures = list(), counts = vcr_counts(realPatients = n),
                  issues = if (!is.null(stopped)) list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit",
                           sprintf("The CPU budget ran out after %d of %d imputations; at least two are needed to pool them. The complete-case answer is kept.", done_n, m))) else NULL,
                  diagnostics = list(imputation = imp_diag, cohort = cohort$info)))
    }
  }
  first <- runs_done[[1]]$result
  inputs <- lapply(runs_done, .vcr_pool_inputs)
  names_all <- Reduce(intersect, lapply(inputs, names))
  pooled <- list(); pooled_rows <- list()
  for (nm in names_all) {
    q <- vapply(inputs, function(x) x[[nm]]$estimate, numeric(1)); u <- vapply(inputs, function(x) x[[nm]]$variance, numeric(1))
    pool <- vcr_rubin_pool(q, u, dfcom)
    if (is.null(pool)) next
    scale <- inputs[[1]][[nm]]$scale
    row <- .vcr_pooled_row(pool, scale)
    pooled[[nm]] <- c(row, list(unit = inputs[[1]][[nm]]$unit))
    cc <- cc_inputs[[nm]]
    cc_row <- if (is.null(cc)) NULL else .vcr_pooled_row(list(estimate = cc$estimate, se = sqrt(cc$variance), df = Inf), cc$scale)
    pooled_rows[[length(pooled_rows) + 1L]] <- list(name = nm, scale = scale, imputed = row, completeCase = cc_row,
                                                      within = pool$within, between = pool$between, total = pool$total, df = if (is.finite(pool$df)) pool$df else NULL,
                                                      relativeIncrease = pool$relativeIncrease, fractionMissingInformation = pool$fractionMissingInformation,
                                                      imputations = pool$m)
  }
  imp_diag$pooled <- pooled_rows
  src <- "imputed"
  measures <- list(); pooled_names <- character(0)
  for (mm in first$measures) {
    nm <- mm$name
    if (!is.null(pooled[[nm]])) {
      p <- pooled[[nm]]
      measures[[length(measures) + 1L]] <- vcr_measure(nm, p$estimate, interval = vcr_interval("confidence", p$lower, p$upper), unit = p$unit, source = src)
      pooled_names <- c(pooled_names, nm)
    } else if (nm %in% c("effective_sample_size", "worst_standardized_difference", "trimmed_treated", "trimmed_control")) {
      measures[[length(measures) + 1L]] <- mm
    }
  }
  imp_diag$notPooled <- as.list(setdiff(vapply(first$measures, function(x) x$name, character(1)), c(pooled_names, "effective_sample_size", "worst_standardized_difference", "trimmed_treated", "trimmed_control", "e_value", "e_value_confidence_limit")))
  # the E-value is a function of the estimate and its limit nearer the null, so it is computed again from the pooled ones
  ev_name <- intersect(c("weighted_risk_ratio", "aipw_risk_ratio", "hazard_ratio"), pooled_names)
  ev_diag <- NULL
  if (length(ev_name) && !is.null(first$diagnostics$eValue)) {
    p <- pooled[[ev_name[1]]]
    rare <- identical(ev_name[1], "hazard_ratio") && mean(outcome$status) < 0.15   # the Cox job's own rule: a hazard ratio stands for a risk ratio only when the outcome is rare
    ev <- vcr_evalue_after(p$estimate, p$lower, p$upper, if (identical(ev_name[1], "hazard_ratio")) "hazard_ratio" else "risk_ratio", rare, src)
    if (!is.null(ev)) { measures <- c(measures, ev$measures); ev_diag <- ev$diagnostics }
  }
  limited_by <- unique(c(unlist(lapply(runs_done, function(x) vcr_chr(x$result$diagnostics$limitedBy))),
                         if (!is.null(stopped)) "imputations_stopped_early",
                         if (length(dropped)) "imputations_not_estimable",
                         if (m < ceiling(100 * mean(incomplete_rows))) "few_imputations"))
  drop_keys <- c("bootstrap", "bootstrapReplicates", "bootstrapFailureShare", "varianceComparison", "robust", "influence")
  diag <- first$diagnostics[setdiff(names(first$diagnostics), drop_keys)]
  if (!is.null(ev_diag)) diag$eValue <- ev_diag
  diag$cohort <- cohort$info
  diag$limitedBy <- as.list(limited_by)
  diag$imputation <- imp_diag
  tables <- first$tables
  if (!is.null(tables) && length(tables)) tables <- .vcr_remap_weight_rows(tables, output_dir, which(keep))
  list(status = "succeeded", measures = measures, conclusion = if (length(limited_by)) "limited" else "estimable",
       counts = first$counts, diagnostics = diag, tables = tables)
}

#' The `weights` table an inner run wrote numbers its rows within the analysed rows; the table a person reads numbers them in the table
#' they gave. Rewritten in place, with its digest and row count.
.vcr_remap_weight_rows <- function(tables, output_dir, rows) {
  if (is.null(output_dir)) return(tables)
  lapply(tables, function(t) {
    if (!identical(t$name, "weights")) return(t)
    path <- file.path(output_dir, t$location)
    df <- utils::read.csv(path, check.names = FALSE, stringsAsFactors = FALSE)
    if (!("row" %in% names(df))) return(t)
    df$row <- rows[df$row]
    vcr_write_table(df, "weights", output_dir)
  })
}
