# ---------------------------------------------------------------------------
# population.R — the four kinds of population (plan 5.1).
#
#   real                 filtered from a snapshot (the data plane's job)
#   scenario             declared marginals + a Gaussian copula
#   literature           a published baseline table, correlations assumed
#   empirical_synthetic  synthpop's sequential CART on authorized rows
#
# Hidden knowledge:
#
# - **Constraints are applied to the quantile function, not by rejection.**
#   "Age >= 18" is imposed by drawing the uniform inside [F(18), 1] and
#   inverting, so one subject consumes exactly one uniform per variable
#   whatever the constraint is. Rejection sampling would make the draw count
#   depend on the constraint, and then adding a constraint would reshuffle
#   every later subject -- common random numbers across scenarios would be
#   gone, and two populations that differ in one bound would be incomparable.
# - **The copula correlation is not the Spearman correlation the paper
#   reports.** For a Gaussian copula, rho_pearson_latent = 2*sin(pi*rho_s/6);
#   feeding a published Spearman straight in as the latent correlation is a
#   small, silent, systematic error. `correlationScale` says which one the
#   caller supplied and the conversion happens here.
# - **Parameter uncertainty and between-subject variation are different
#   things and are sampled at different levels.** The outer loop draws the
#   parameters (this is the "interval of the interval"), the inner loop draws
#   the subjects. Collapsing them produces one distribution that is too wide
#   for a person and too narrow for a parameter, and the QSP literature
#   (attachment C2) lists exactly this as the classic failure.
# - **A literature population's applicability equals its source trial's.**
#   Nothing here can widen it, so the kind is recorded on the population and
#   travels with every number derived from it.
# - **A synthetic population can never enter a real external control.** The
#   route refuses `synthetic` sources outright; this module only labels, and
#   the refusal lives in the comparator route (plan 5.1, 5.3).
# ---------------------------------------------------------------------------

suppressPackageStartupMessages(library(mvtnorm))

#' Inverse CDF for the supported marginal families, with optional truncation.
#'
#' `spec`: list(name, family, ... family parameters ..., min, max).
vcr_marginal_quantile <- function(spec, u) {
  fam <- spec$family
  q <- switch(fam,
    normal = function(p) stats::qnorm(p, spec$mean, spec$sd),
    lognormal = function(p) stats::qlnorm(p, spec$meanlog, spec$sdlog),
    beta = function(p) stats::qbeta(p, spec$alpha, spec$beta),
    gamma = function(p) stats::qgamma(p, spec$shape, rate = spec$rate %||% (spec$shape / spec$mean)),
    bernoulli = function(p) as.numeric(p > 1 - spec$prob),
    categorical = function(p) {
      cuts <- cumsum(spec$probs / sum(spec$probs))
      as.integer(findInterval(p, cuts, rightmost.closed = TRUE, left.open = FALSE)) + 1L
    },
    uniform = function(p) stats::qunif(p, spec$min %||% 0, spec$max %||% 1),
    exponential = function(p) stats::qexp(p, spec$rate),
    stop("vcr_marginal_quantile: unknown family ", fam))
  p_fun <- switch(fam,
    normal = function(x) stats::pnorm(x, spec$mean, spec$sd),
    lognormal = function(x) stats::plnorm(x, spec$meanlog, spec$sdlog),
    beta = function(x) stats::pbeta(x, spec$alpha, spec$beta),
    gamma = function(x) stats::pgamma(x, spec$shape, rate = spec$rate %||% (spec$shape / spec$mean)),
    uniform = function(x) stats::punif(x, spec$min %||% 0, spec$max %||% 1),
    exponential = function(x) stats::pexp(x, spec$rate),
    NULL)
  lo <- 0; hi <- 1
  if (!is.null(p_fun)) {
    if (!is.null(spec$min)) lo <- p_fun(spec$min)
    if (!is.null(spec$max)) hi <- p_fun(spec$max)
    if (!(hi > lo)) stop("vcr_marginal_quantile: empty support for ", spec$name)
  }
  q(lo + u * (hi - lo))
}

#' Convert a Spearman correlation matrix to the Gaussian copula's latent
#' Pearson correlation. `2 * sin(pi * rho_s / 6)` is exact for a Gaussian
#' copula; the nearest-PD repair is reported, never applied silently.
vcr_copula_correlation <- function(R, scale = c("latent", "spearman")) {
  scale <- match.arg(scale)
  L <- if (identical(scale, "spearman")) 2 * sin(pi * R / 6) else R
  diag(L) <- 1
  e <- eigen(L, symmetric = TRUE)
  repaired <- FALSE
  if (min(e$values) < 1e-10) {
    e$values[e$values < 1e-10] <- 1e-10
    L <- e$vectors %*% diag(e$values) %*% t(e$vectors)
    d <- sqrt(diag(L)); L <- L / outer(d, d)
    repaired <- TRUE
  }
  list(correlation = L, repaired = repaired, minEigenvalue = min(e$values))
}

#' Generate a scenario population.
#'
#' @param spec list(variables = list(<marginal spec>...),
#'   correlation = matrix or NULL, correlationScale = "latent"|"spearman",
#'   constraints = list(list(name, expression)),
#'   missing = list(list(variable, kind = "MCAR"|"MAR", rate, on, beta)))
#' @param n subjects per parameter draw.
#' @param parameter_draws outer draws of parameters (1 = point assumptions).
vcr_population_scenario <- function(spec, n, parameter_draws = 1L) {
  vars <- spec$variables
  p <- length(vars)
  nms <- vapply(vars, function(v) v$name, character(1))
  R <- if (is.null(spec$correlation)) diag(p) else as.matrix(spec$correlation)
  cop <- vcr_copula_correlation(R, spec$correlationScale %||% "latent")

  draw_one <- function(param_index) {
    Z <- mvtnorm::rmvnorm(n, sigma = cop$correlation, method = "chol")
    U <- stats::pnorm(Z)
    out <- as.data.frame(lapply(seq_len(p), function(j) vcr_marginal_quantile(vars[[j]], U[, j])))
    names(out) <- nms
    out$..parameterDraw.. <- param_index
    out
  }
  df <- do.call(rbind, lapply(seq_len(parameter_draws), draw_one))

  violations <- vcr_constraint_violations(df, spec$constraints)
  if (!is.null(spec$missing)) df <- vcr_apply_missingness(df, spec$missing)

  list(data = df, kind = "scenario", n = nrow(df),
       parameterDraws = parameter_draws,
       copulaRepaired = cop$repaired,
       constraintViolations = violations,
       counts = vcr_counts(realPatients = 0, generatedRecords = nrow(df)),
       valueSource = "synthetic", modelTier = "scenario")
}

#' Hard constraints stated as R expressions over the generated columns.
#' A violation count is an invariant, not a statistic: it must be zero
#' (attachment C2, case C2-03).
vcr_constraint_violations <- function(df, constraints) {
  if (is.null(constraints) || !length(constraints)) return(data.frame(rule = character(0), violations = numeric(0)))
  do.call(rbind, lapply(constraints, function(c_) {
    ok <- eval(parse(text = c_$expression), envir = df)
    data.frame(rule = c_$name, violations = sum(!ok, na.rm = TRUE) + sum(is.na(ok)))
  }))
}

#' Apply a declared missingness mechanism. "Unknown treatment is never no
#' treatment": the reason is recorded per variable and travels with the cell.
vcr_apply_missingness <- function(df, missing) {
  for (m in missing) {
    v <- m$variable
    pr <- switch(m$kind %||% "MCAR",
      MCAR = rep(m$rate, nrow(df)),
      MAR = stats::plogis(stats::qlogis(m$rate) + as.vector(as.matrix(df[, m$on, drop = FALSE]) %*% m$beta)),
      stop("vcr_apply_missingness: unknown mechanism ", m$kind))
    hit <- stats::runif(nrow(df)) < pr
    df[[v]][hit] <- NA
    attr(df[[v]], "missingReason") <- m$reason %||% "not_measured"
  }
  df
}

#' Literature population: a published baseline table becomes marginals, and
#' the correlation structure is either cited or assumed and marked as such.
vcr_population_literature <- function(table, n, correlation = NULL,
                                      correlation_source = "assumed",
                                      parameter_draws = 1L) {
  vars <- lapply(seq_len(nrow(table)), function(i) {
    row <- table[i, ]
    if (!is.na(row$proportion)) {
      list(name = row$variable, family = "bernoulli", prob = row$proportion)
    } else if (identical(row$distribution %||% "normal", "lognormal")) {
      s2 <- log(1 + (row$sd / row$mean)^2)
      list(name = row$variable, family = "lognormal",
           meanlog = log(row$mean) - s2 / 2, sdlog = sqrt(s2),
           min = row$min, max = row$max)
    } else {
      list(name = row$variable, family = "normal", mean = row$mean, sd = row$sd,
           min = row$min, max = row$max)
    }
  })
  out <- vcr_population_scenario(list(variables = vars, correlation = correlation),
                                 n, parameter_draws)
  out$kind <- "literature"
  out$modelTier <- "literature"
  out$correlationSource <- correlation_source
  out$applicability <- "source_trial_population"
  out
}

#' Empirical synthesis with synthpop's sequential CART.
#'
#' Hidden knowledge: `smoothing = "density"` on numeric columns is what stops
#' a CART leaf of size one from reproducing a real record verbatim, which is
#' the disclosure path the quality report measures. `m >= 5` is not decoration
#' either: inference on a single synthetic copy has no way to express the
#' synthesis variance, and the combining rules need m.
vcr_population_synthpop <- function(data, m = 5L, seed = 1L, visit_sequence = NULL,
                                    rules = NULL, rvalues = NULL,
                                    min_numlevels = 5L, smoothing = "density") {
  if (!requireNamespace("synthpop", quietly = TRUE)) stop("vcr_population_synthpop: synthpop is not installed")
  # Hidden knowledge: `smoothing` must be a *named list*, and it must name only
  # the columns synthpop will actually treat as numeric. A 0/1 column with
  # fewer than `minnumlevels` distinct values is converted to a factor before
  # synthesis, and naming it here makes `syn()` refuse the whole call with
  # "must be a named list with names of selected variables" -- which reads
  # like a type error and is really a modelling-decision mismatch.
  numeric_cols <- names(data)[vapply(data, function(v)
    is.numeric(v) && length(unique(stats::na.omit(v))) > min_numlevels, logical(1))]
  smooth <- as.list(stats::setNames(rep(smoothing, length(numeric_cols)), numeric_cols))
  args <- list(data = data, method = "cart", m = m, seed = seed,
               minnumlevels = min_numlevels, smoothing = smooth, print.flag = FALSE)
  if (!is.null(visit_sequence)) args$visit.sequence <- visit_sequence
  if (!is.null(rules)) { args$rules <- rules; args$rvalues <- rvalues }
  syn <- do.call(synthpop::syn, args)
  synth <- if (m == 1L) list(syn$syn) else syn$syn
  list(data = synth, kind = "empirical_synthetic", m = m,
       trainingObservations = nrow(data),
       generatedRecords = sum(vapply(synth, nrow, numeric(1))),
       counts = vcr_counts(realPatients = 0, generatedRecords = sum(vapply(synth, nrow, numeric(1)))),
       method = "cart", smoothing = smoothing, seed = seed,
       valueSource = "synthetic", modelTier = "data",
       inferenceLabel = "exploratory",
       variablesPerObservation = ncol(data) / max(nrow(data), 1),
       lowSampleWarning = nrow(data) < 5 * ncol(data))
}

#' Combining rules for inference on m synthetic copies (Raab, Nowok & Dibben).
vcr_synthetic_combine <- function(estimates, variances, m = length(estimates), n_syn = NULL, n_obs = NULL) {
  qbar <- mean(estimates)
  ubar <- mean(variances)
  b <- stats::var(estimates)
  # For fully synthetic data generated from a model fitted to the observed
  # data, the total variance is ubar * (1 + k/m) with k = n_syn/n_obs; with
  # n_syn == n_obs this is the familiar ubar * (1 + 1/m).
  k <- if (is.null(n_syn) || is.null(n_obs)) 1 else n_syn / n_obs
  total <- ubar * (1 + k / m)
  list(estimate = qbar, variance = total, se = sqrt(total),
       betweenVariance = b, withinVariance = ubar, m = m,
       label = "exploratory")
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# ---------------------------------------------------------------------------
# The mechanistic model-package interface (plan 8.2; attachment C2 section 2.3).
# V1 hosts no mechanistic model -- it fixes the shape one must arrive in, so
# that adding PBPK later is a package rather than a second code path.
#
# Hidden knowledge: the single most important line in the schema is that
# parameter uncertainty and between-subject variability are stored apart.
# Folding Omega into the parameter covariance makes every interval too wide in
# the same way for every subject, and folding the covariance into Omega makes
# the population look more heterogeneous than it is. Both errors are invisible
# in a plot and both survive review; the schema makes them impossible to
# express.
# ---------------------------------------------------------------------------

VCR_MECHANISTIC_REQUIRED <- c("modelKind", "engine", "engineVersion", "modelHash",
                              "parameters", "parameterUncertainty", "betweenSubject",
                              "residual", "covariatePopulation", "events", "outputs",
                              "vpopSelection", "validation")

vcr_mechanistic_spec_issues <- function(spec) {
  issues <- list()
  for (field in VCR_MECHANISTIC_REQUIRED) {
    if (is.null(spec[[field]])) {
      issues[[length(issues) + 1L]] <- vcr_issue("mechanistic_field_missing", field,
        sprintf("a mechanistic model package states %s", field))
    }
  }
  if (!is.null(spec$engine) && !(spec$engine %in% c("mrgsolve", "rxode2", "nlmixr2", "ospsuite", "desolve"))) {
    issues[[length(issues) + 1L]] <- vcr_issue("mechanistic_engine_unknown", "engine",
      sprintf("unknown host engine %s", spec$engine))
  }
  if (!is.null(spec$parameterUncertainty) && !is.null(spec$betweenSubject) &&
      identical(spec$parameterUncertainty, spec$betweenSubject)) {
    issues[[length(issues) + 1L]] <- vcr_issue("uncertainty_and_variability_conflated",
      "betweenSubject", "parameter uncertainty and between-subject variability are stored apart")
  }
  issues
}

#' Allen (2016) accept-reject selection of a virtual population.
#'
#' Plausible patients are accepted with probability proportional to
#' target_density(output) / plausible_density(output), so the accepted set
#' matches the observed clinical distribution on the quantities that were
#' selected on -- and only on those. Everything else the model outputs is
#' extrapolation and is labelled `predicted`.
vcr_vpop_select <- function(outputs, target_mean, target_sd, bandwidth = NULL) {
  n <- length(outputs)
  bw <- bandwidth %||% stats::bw.nrd0(outputs)
  plausible <- vapply(outputs, function(x) mean(stats::dnorm(x, outputs, bw)), numeric(1))
  target <- stats::dnorm(outputs, target_mean, target_sd)
  ratio <- target / plausible
  ratio[!is.finite(ratio)] <- 0
  accept_p <- ratio / max(ratio)
  accepted <- stats::runif(n) < accept_p
  list(accepted = accepted, acceptanceRate = mean(accepted),
       selectedOn = c("mean", "sd"), bandwidth = bw,
       effectiveSampleSize = sum(accepted),
       note = "Only the selected-on quantities match the clinical distribution; every other output is extrapolation.")
}

#' Kolmogorov-Smirnov distance between a sample and a normal target.
vcr_ks_to_normal <- function(x, mean, sd) {
  x <- sort(x); n <- length(x)
  f <- stats::pnorm(x, mean, sd)
  max(pmax(abs(f - (seq_len(n) - 1) / n), abs(f - seq_len(n) / n)))
}
