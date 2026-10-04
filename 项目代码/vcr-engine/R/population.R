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
# - **A single-variable bound is applied to the quantile function; a rule that
#   spans variables is enforced by re-drawing the violating subjects.** "Age >=
#   18" is imposed by drawing the uniform inside [F(18), 1] and inverting, so
#   one subject consumes exactly one uniform per variable whatever the bound is.
#   A cross-variable constraint ("no pregnancy in men", "discharge after
#   admission") cannot be inverted, so the population is drawn first and only
#   the rows that break a rule are drawn again -- from the same stream, after
#   every first draw, so the subjects that never violated anything are the same
#   subjects whatever the rule says. The number redrawn is reported, the cap on
#   rounds is reported, and a rule that cannot be satisfied is a failed job
#   (`constraint_unsatisfiable`), not a table with a count of violations in a
#   diagnostic nobody reads (EA-14; the old case C2-03 could not fail).
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
#   (attachment C2) lists exactly this as the classic failure. A variable
#   declares how uncertain each of its parameters is with `paramSd` (a standard
#   deviation on the natural scale for a location, on the log scale for a
#   positive parameter, on the logit scale for a probability); with more than
#   one outer draw and no `paramSd` anywhere the job is refused, because
#   "40 parameter draws" of identical parameters is a claim of uncertainty
#   propagation that never happened (EA-4).
# - **A literature population's applicability equals its source trial's.**
#   Nothing here can widen it, so the kind is recorded on the population and
#   travels with every number derived from it.
# - **A synthetic population can never enter a real external control.** The
#   refusal lives in `vcr_require_individual` (inputs.R): a table whose value
#   source is not `observed` is not read by the weighting, propensity or RMST
#   routes at all (plan 5.1, 5.3).
# ---------------------------------------------------------------------------

suppressPackageStartupMessages(library(mvtnorm))

.VCR_FAMILY_PARAMS <- list(
  normal = c(mean = "real", sd = "positive"), lognormal = c(meanlog = "real", sdlog = "positive"),
  beta = c(alpha = "positive", beta = "positive"), gamma = c(shape = "positive", rate = "positive"),
  bernoulli = c(prob = "probability"), uniform = c(min = "real", max = "real"),
  exponential = c(rate = "positive"), categorical = character(0))

.vcr_bound <- function(x) !is.null(x) && length(x) == 1L && !is.na(x) && is.finite(suppressWarnings(as.numeric(x)))

#' Inverse CDF for the supported marginal families, with optional truncation.
#'
#' `spec`: list(name, family, ... family parameters ..., min, max). A bound
#' that is NA or null is absent.
vcr_marginal_quantile <- function(spec, u) {
  fam <- spec$family
  num <- function(k) vcr_scalar(spec[[k]], NULL)
  q <- switch(fam,
    normal = function(p) stats::qnorm(p, num("mean"), num("sd")),
    lognormal = function(p) stats::qlnorm(p, num("meanlog"), num("sdlog")),
    beta = function(p) stats::qbeta(p, num("alpha"), num("beta")),
    gamma = function(p) stats::qgamma(p, num("shape"), rate = num("rate") %||% (num("shape") / num("mean"))),
    bernoulli = function(p) as.numeric(p > 1 - num("prob")),
    categorical = function(p) {
      pr <- vcr_num(spec$probs)
      cuts <- cumsum(pr / sum(pr))
      as.integer(findInterval(p, cuts, rightmost.closed = TRUE, left.open = FALSE)) + 1L
    },
    uniform = function(p) stats::qunif(p, num("min") %||% 0, num("max") %||% 1),
    exponential = function(p) stats::qexp(p, num("rate")),
    vcr_abort("scenario_value_invalid", "scenario.population.variables", sprintf("Unknown marginal family '%s'.", as.character(fam))))
  p_fun <- switch(fam,
    normal = function(x) stats::pnorm(x, num("mean"), num("sd")),
    lognormal = function(x) stats::plnorm(x, num("meanlog"), num("sdlog")),
    beta = function(x) stats::pbeta(x, num("alpha"), num("beta")),
    gamma = function(x) stats::pgamma(x, num("shape"), rate = num("rate") %||% (num("shape") / num("mean"))),
    uniform = function(x) stats::punif(x, num("min") %||% 0, num("max") %||% 1),
    exponential = function(x) stats::pexp(x, num("rate")),
    NULL)
  lo <- 0; hi <- 1
  if (!is.null(p_fun)) {
    if (.vcr_bound(spec$min)) lo <- p_fun(as.numeric(spec$min))
    if (.vcr_bound(spec$max)) hi <- p_fun(as.numeric(spec$max))
    if (!(hi > lo)) vcr_abort("scenario_value_invalid", "scenario.population.variables",
                              sprintf("The bounds of '%s' leave no support.", as.character(spec$name)))
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

#' A correlation matrix from however the job carried it: a matrix, or a list of
#' rows (`simplifyVector = FALSE` parses [[1,0.1],[0.1,1]] into a list of
#' lists). Shape and symmetry are checked; the copula module repairs
#' definiteness and says so.
vcr_correlation_matrix <- function(x, p) {
  if (is.null(x)) return(diag(p))
  R <- if (is.matrix(x)) x else do.call(rbind, lapply(x, vcr_num))
  if (!(is.matrix(R) && nrow(R) == p && ncol(R) == p && all(is.finite(R)))) {
    vcr_abort("scenario_value_invalid", "scenario.population.correlation", sprintf("The correlation is a %d x %d matrix, one row per variable.", p, p))
  }
  if (max(abs(R - t(R))) > 1e-8 || any(abs(R) > 1 + 1e-12)) {
    vcr_abort("scenario_value_invalid", "scenario.population.correlation", "A correlation matrix is symmetric with entries in [-1, 1].")
  }
  R
}

#' Draw one outer set of parameters for the variables that declare `paramSd`.
#' A standard normal is drawn for *every* parameter of *every* variable (whether
#' or not it has an sd), so the number of uniforms an outer draw consumes does
#' not depend on which parameters are uncertain (common random numbers).
.vcr_draw_parameters <- function(vars) {
  rows <- list()
  out <- lapply(seq_along(vars), function(j) {
    v <- vars[[j]]
    fam_params <- .VCR_FAMILY_PARAMS[[v$family]]
    sds <- v$paramSd %||% list()
    for (nm in names(fam_params)) {
      z <- stats::rnorm(1)
      theta <- vcr_scalar(v[[nm]], NULL)
      if (is.null(theta)) next
      sd <- vcr_scalar(sds[[nm]], 0)
      new <- switch(fam_params[[nm]],
        real = theta + sd * z,
        positive = theta * exp(sd * z),
        probability = stats::plogis(stats::qlogis(theta) + sd * z))
      v[[nm]] <- new
      rows[[length(rows) + 1L]] <<- data.frame(variable = as.character(v$name), parameter = nm, value = new, stringsAsFactors = FALSE)
    }
    v
  })
  list(variables = out, table = if (length(rows)) do.call(rbind, rows) else data.frame())
}

#' Generate a scenario population.
#'
#' @param spec list(variables = list(<marginal spec>...),
#'   correlation = matrix or NULL, correlationScale = "latent"|"spearman",
#'   constraints = list(list(name, rule)),
#'   missing = list(list(variable, kind = "MCAR"|"MAR", rate, on, beta, reason)))
#' @param n subjects per parameter draw.
#' @param parameter_draws outer draws of parameters (1 = point assumptions).
#' @param seed when there is more than one outer draw, each draw runs on its
#'   own substream of this seed.
vcr_population_scenario <- function(spec, n, parameter_draws = 1L, seed = NULL, max_rounds = 200L) {
  vars <- spec$variables
  if (!is.list(vars) || !length(vars)) vcr_abort("scenario_field_missing", "scenario.population.variables", "A population declares at least one variable.")
  p <- length(vars)
  nms <- vapply(vars, function(v) as.character(v$name %||% ""), character(1))
  if (any(!nzchar(nms)) || anyDuplicated(nms)) vcr_abort("scenario_value_invalid", "scenario.population.variables", "Variables have distinct, non-empty names.")
  for (v in vars) {
    if (!(v$family %in% names(.VCR_FAMILY_PARAMS))) {
      vcr_abort("scenario_value_invalid", "scenario.population.variables", sprintf("Unknown marginal family '%s'.", as.character(v$family)))
    }
    bad <- setdiff(names(v$paramSd %||% list()), names(.VCR_FAMILY_PARAMS[[v$family]]))
    if (length(bad)) vcr_abort("scenario_value_invalid", "scenario.population.variables", sprintf("'%s' has no parameter to be uncertain about called %s.", as.character(v$name), bad[1]))
  }
  R <- vcr_correlation_matrix(spec$correlation, p)
  cop <- vcr_copula_correlation(R, spec$correlationScale %||% "latent")
  cons <- vcr_named_rules(spec$constraints, nms, "scenario.population.constraints")
  if (length(cons$issues)) vcr_abort_issue(cons$issues[[1]])
  K <- as.integer(parameter_draws %||% 1L)
  uncertain <- any(vapply(vars, function(v) length(v$paramSd %||% list()) > 0L, logical(1)))
  if (K > 1L && !uncertain) {
    vcr_abort("scenario_value_invalid", "scenario.parameterDraws",
              "More than one parameter draw needs at least one variable with a paramSd; identical draws would only look like uncertainty.")
  }

  gen <- function(m, vars_k) {
    Z <- mvtnorm::rmvnorm(m, sigma = cop$correlation, method = "chol")
    U <- stats::pnorm(matrix(Z, nrow = m))
    out <- as.data.frame(lapply(seq_len(p), function(j) vcr_marginal_quantile(vars_k[[j]], U[, j])))
    names(out) <- nms
    out
  }
  violating <- function(d) {
    if (!length(cons$rules)) return(rep(FALSE, nrow(d)))
    bad <- lapply(cons$rules, function(r) { v <- vcr_eval_row_rule(r$rule, d); !is.na(v) & !v })
    Reduce(`|`, bad)
  }
  one_draw <- function(k, vars_k) {
    df <- gen(n, vars_k)
    initial <- if (length(cons$rules)) vapply(cons$rules, function(r) sum({ v <- vcr_eval_row_rule(r$rule, df); !is.na(v) & !v }), numeric(1)) else numeric(0)
    redrawn <- 0; rounds <- 0L
    repeat {
      bad <- violating(df)
      if (!any(bad) || rounds >= max_rounds) break
      rounds <- rounds + 1L
      redrawn <- redrawn + sum(bad)
      df[bad, ] <- gen(sum(bad), vars_k)
    }
    if (K > 1L) df$parameterDraw <- k
    list(data = df, initial = initial, redrawn = redrawn, rounds = rounds)
  }

  draws <- list(); params <- list()
  if (K > 1L) {
    streams <- vcr_stream_bank(seed %||% sample.int(.Machine$integer.max, 1L))$take(K)
    for (k in seq_len(K)) {
      res <- vcr_with_stream(streams[[k]], function(.) {
        pr <- .vcr_draw_parameters(vars)
        d <- one_draw(k, pr$variables)
        d$parameters <- if (nrow(pr$table)) cbind(parameterDraw = k, pr$table) else pr$table
        d
      }, k)
      draws[[k]] <- res; params[[k]] <- res$parameters
    }
  } else {
    draws[[1]] <- one_draw(1L, vars)
  }
  df <- do.call(rbind, lapply(draws, function(d) d$data))
  rownames(df) <- NULL
  final <- if (length(cons$rules)) vapply(cons$rules, function(r) { v <- vcr_eval_row_rule(r$rule, df); sum(!is.na(v) & !v) }, numeric(1)) else numeric(0)
  indet <- if (length(cons$rules)) vapply(cons$rules, function(r) sum(is.na(vcr_eval_row_rule(r$rule, df))), numeric(1)) else numeric(0)
  initial <- if (length(cons$rules)) Reduce(`+`, lapply(draws, function(d) d$initial)) else numeric(0)
  report <- if (length(cons$rules)) data.frame(
    rule = vapply(cons$rules, function(r) r$name, character(1)), violations = final, initialViolations = initial,
    indeterminate = indet, stringsAsFactors = FALSE) else data.frame(rule = character(0), violations = numeric(0))
  redrawn <- sum(vapply(draws, function(d) d$redrawn, numeric(1)))
  rounds <- max(vapply(draws, function(d) d$rounds, integer(1)))
  if (any(final > 0)) {
    vcr_abort("constraint_unsatisfiable", "scenario.population.constraints",
              sprintf("After %d rounds of re-drawing, %d rows still break the rule '%s'; the constraint may be unsatisfiable under these marginals.",
                      rounds, max(final), report$rule[which.max(final)]))
  }
  miss <- NULL
  if (!is.null(spec$missing)) {
    mm <- vcr_apply_missingness(df, spec$missing)
    df <- mm$data; miss <- mm$reasons
  }
  list(data = df, kind = "scenario", n = nrow(df),
       parameterDraws = K,
       parameterTable = if (K > 1L) do.call(rbind, params) else NULL,
       copulaRepaired = cop$repaired,
       constraintViolations = report,
       constraintEnforcement = list(method = "redraw_violating_rows", maxRounds = max_rounds,
                                    roundsUsed = rounds, rowsRedrawn = redrawn),
       missingReasons = miss,
       counts = vcr_counts(realPatients = 0, generatedRecords = nrow(df)),
       valueSource = "synthetic", modelTier = "scenario")
}

#' Hard constraints as data rules over the generated columns, counted as an
#' invariant: a violation is a row on which the rule is FALSE, and a row the
#' rule cannot judge (NA) is counted apart. The count must be zero (attachment
#' C2, case C2-03).
vcr_constraint_violations <- function(df, constraints) {
  if (is.null(constraints) || !length(constraints)) return(data.frame(rule = character(0), violations = numeric(0), indeterminate = numeric(0)))
  cons <- vcr_named_rules(constraints, names(df), "constraints")
  if (length(cons$issues)) vcr_abort_issue(cons$issues[[1]])
  do.call(rbind, lapply(cons$rules, function(c_) {
    v <- vcr_eval_row_rule(c_$rule, df)
    data.frame(rule = c_$name, violations = sum(!is.na(v) & !v), indeterminate = sum(is.na(v)), stringsAsFactors = FALSE)
  }))
}

#' The reasons a value can be missing. The domain owns the vocabulary; the
#' snapshot carries it when the domain does, and this is the same list for a
#' build whose snapshot predates it.
vcr_missing_reasons <- function() {
  v <- tryCatch(vcr_domain()$missingReasons, error = function(e) NULL)
  if (is.null(v)) c("not_measured", "not_recorded", "not_shared", "restricted_in_trial", "out_of_window", "pending_result", "not_applicable") else v
}

#' Apply a declared missingness mechanism. "Unknown treatment is never no
#' treatment": the reason is checked against the vocabulary and written beside
#' the column (`<column>__missing_reason`) because an attribute does not survive
#' a CSV (EA-20).
vcr_apply_missingness <- function(df, missing) {
  reasons <- list()
  for (m in missing) {
    v <- as.character(m$variable)
    if (!(v %in% names(df))) vcr_abort("scenario_value_invalid", "scenario.population.missing", "A missingness rule names a generated variable.")
    reason <- as.character(m$reason %||% "not_measured")
    if (!(reason %in% vcr_missing_reasons())) vcr_abort("scenario_value_invalid", "scenario.population.missing", "The missing reason is not in the vocabulary.")
    rate <- vcr_scalar(m$rate)
    pr <- switch(as.character(m$kind %||% "MCAR"),
      MCAR = rep(rate, nrow(df)),
      MAR = stats::plogis(stats::qlogis(rate) + as.vector(as.matrix(df[, vcr_chr(m$on), drop = FALSE]) %*% vcr_num(m$beta))),
      vcr_abort("scenario_value_invalid", "scenario.population.missing", "The missingness mechanism is MCAR or MAR."))
    hit <- stats::runif(nrow(df)) < pr
    df[[v]][hit] <- NA
    df[[paste0(v, "__missing_reason")]] <- ifelse(hit, reason, NA_character_)
    reasons[[v]] <- reason
  }
  list(data = df, reasons = reasons)
}

#' A baseline-table row list (or column-oriented table) -> row list. Absent,
#' null and NA cells are absent.
.vcr_baseline_rows <- function(tbl) {
  if (is.data.frame(tbl)) return(lapply(seq_len(nrow(tbl)), function(i) as.list(tbl[i, , drop = FALSE])))
  if (is.list(tbl) && is.null(names(tbl))) return(tbl)
  if (is.list(tbl) && !is.null(names(tbl))) {
    df <- vcr_rows_df(tbl)
    return(lapply(seq_len(nrow(df)), function(i) as.list(df[i, , drop = FALSE])))
  }
  list()
}

#' Literature population: a published baseline table becomes marginals, and
#' the correlation structure is either cited or assumed and marked as such.
#'
#' A row is `{ variable, mean, sd }` (a continuous variable; `distribution` may
#' be "lognormal"), `{ variable, proportion }` (a binary one) or
#' `{ variable, proportions, levels? }` (a categorical one), each with optional
#' `min`/`max`. A published Table 1 rarely gives bounds, so a bound that is
#' missing, null or NA is *absent* -- the first version padded the columns with
#' NA and failed on the first row (`missing value where TRUE/FALSE needed`).
vcr_population_literature <- function(table, n, correlation = NULL,
                                      correlation_source = "assumed",
                                      parameter_draws = 1L, seed = NULL, constraints = NULL) {
  rows <- .vcr_baseline_rows(table)
  if (!length(rows)) vcr_abort("scenario_field_missing", "scenario.baselineTable", "A literature population needs at least one baseline row.")
  labels <- list()
  vars <- lapply(seq_along(rows), function(i) {
    row <- rows[[i]]
    at <- sprintf("scenario.baselineTable[%d]", i - 1L)
    name <- as.character(row$variable %||% "")
    if (!nzchar(name)) vcr_abort("scenario_value_invalid", at, "A baseline row names its variable.")
    mean_ <- vcr_scalar(row$mean, NULL); sd_ <- vcr_scalar(row$sd, NULL); prop <- vcr_scalar(row$proportion, NULL)
    props <- vcr_num(row$proportions)
    lo <- if (.vcr_bound(row$min)) as.numeric(row$min) else NULL
    hi <- if (.vcr_bound(row$max)) as.numeric(row$max) else NULL
    if (length(props)) {
      if (any(props < 0) || abs(sum(props) - 1) > 1e-6) vcr_abort("scenario_value_invalid", at, "The proportions of a categorical row are non-negative and sum to 1.")
      labels[[name]] <<- if (length(row$levels)) vcr_chr(row$levels) else NULL
      return(list(name = name, family = "categorical", probs = props))
    }
    if (!is.null(prop)) {
      if (prop <= 0 || prop >= 1) vcr_abort("scenario_value_invalid", at, "A proportion is strictly between 0 and 1.")
      return(list(name = name, family = "bernoulli", prob = prop))
    }
    if (is.null(mean_) || is.null(sd_) || !(sd_ > 0)) vcr_abort("scenario_value_invalid", at, "A continuous baseline row gives a mean and a positive SD.")
    if (identical(as.character(row$distribution %||% "normal"), "lognormal")) {
      if (!(mean_ > 0)) vcr_abort("scenario_value_invalid", at, "A lognormal baseline row has a positive mean.")
      s2 <- log(1 + (sd_ / mean_)^2)
      out <- list(name = name, family = "lognormal", meanlog = log(mean_) - s2 / 2, sdlog = sqrt(s2))
    } else {
      out <- list(name = name, family = "normal", mean = mean_, sd = sd_)
    }
    if (!is.null(lo)) out$min <- lo
    if (!is.null(hi)) out$max <- hi
    out
  })
  spec <- list(variables = vars, correlation = correlation, constraints = constraints)
  out <- vcr_population_scenario(spec, n, parameter_draws, seed = seed)
  for (nm in names(labels)) if (!is.null(labels[[nm]])) out$data[[nm]] <- labels[[nm]][out$data[[nm]]]
  out$kind <- "literature"
  out$modelTier <- "literature"
  out$correlationSource <- correlation_source
  out$applicability <- "source_trial_population"
  out$columnSources <- stats::setNames(rep("aggregate", length(vars)), vapply(vars, function(v) v$name, character(1)))
  if (!is.null(correlation)) out$columnSources[["(correlation)"]] <- if (identical(correlation_source, "assumed")) "assumed" else "aggregate"
  if (identical(correlation_source, "assumed") && !is.null(correlation) && n >= 20L) {
    out$correlationSensitivity <- .vcr_correlation_sensitivity(spec, out$data, min(n, 2000L), seed)
  }
  out
}

#' How much a literature population moves when its *assumed* correlation is
#' wrong: the same marginals drawn with the correlation removed and with its
#' off-diagonal signs flipped, compared with the declared one. Marginal means
#' should not move (they are the declared marginals); the joint structure
#' should, and the size of that movement is what a reader needs to see.
.vcr_correlation_sensitivity <- function(spec, declared_data, m, seed) {
  p <- length(spec$variables)
  R <- vcr_correlation_matrix(spec$correlation, p)
  alt <- list(independent = diag(p), sign_flipped = { A <- -R; diag(A) <- 1; A })
  nums <- names(declared_data)[vapply(declared_data, is.numeric, logical(1))]
  base_cor <- if (length(nums) > 1L) stats::cor(declared_data[nums], method = "spearman") else NULL
  lapply(names(alt), function(nm) {
    sp <- spec; sp$correlation <- alt[[nm]]; sp$constraints <- NULL
    d <- vcr_with_stream(vcr_stream_bank(seed %||% 1L)$take(1L)[[1]], function(.) vcr_population_scenario(sp, m, 1L)$data, 1L)
    shift <- if (!is.null(base_cor) && all(nums %in% names(d))) max(abs(stats::cor(d[nums], method = "spearman") - base_cor)) else NA_real_
    list(alternative = nm, maxSpearmanShift = shift,
         maxStandardizedMeanShift = max(vapply(nums, function(v) abs(mean(d[[v]]) - mean(declared_data[[v]])) / stats::sd(declared_data[[v]]), numeric(1))))
  })
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
                                    min_numlevels = 5L, smoothing = "density",
                                    rare_floor = NULL) {
  if (!requireNamespace("synthpop", quietly = TRUE)) stop("vcr_population_synthpop: synthpop is not installed")
  # Rare categories are merged before synthesis: a CART leaf holding one person
  # with a one-in-a-hundred level reproduces that person, and the level itself
  # is a small cell the disclosure axis would then flag. The floor is the
  # platform's small-cell size.
  floor_ <- rare_floor %||% vcr_limit("minCellSize", 10)
  merged <- .vcr_merge_rare_levels(data, floor_)
  data <- merged$data
  # Hidden knowledge: `smoothing` must be a *named list*, and it must name only
  # the columns synthpop will actually treat as numeric. A 0/1 column with
  # fewer than `minnumlevels` distinct values is converted to a factor before
  # synthesis, and naming it here makes `syn()` refuse the whole call with
  # "must be a named list with names of selected variables" -- which reads
  # like a type error and is really a modelling-decision mismatch.
  numeric_cols <- names(data)[vapply(data, function(v)
    is.numeric(v) && length(unique(stats::na.omit(v))) > min_numlevels, logical(1))]
  smooth <- as.list(stats::setNames(rep(smoothing, length(numeric_cols)), numeric_cols))
  args <- list(data = data, method = "cart", m = 1L, seed = seed,
               minnumlevels = min_numlevels, smoothing = smooth, print.flag = FALSE)
  if (!is.null(visit_sequence)) args$visit.sequence <- visit_sequence
  if (!is.null(rules)) { args$rules <- rules; args$rvalues <- rvalues }
  # One copy per call, so that a cancel request or the CPU budget is honoured
  # between copies (a single call for all m holds the job for minutes with no
  # way out). Each copy has its own seed, derived from the job's in double
  # arithmetic, so the m copies are independent and the run is reproducible.
  # synthpop announces its own decisions ("turned into factor") on stdout and
  # stderr; the job's result says what matters, and a service log is no place
  # for a package's chatter.
  synth <- list(); interrupted <- NULL
  for (k in seq_len(m)) {
    interrupted <- vcr_interrupt()
    if (!is.null(interrupted)) break
    args$seed <- as.integer((as.numeric(seed) + (k - 1) * 104729) %% 2147483647)
    syn <- NULL
    invisible(utils::capture.output(syn <- suppressMessages(do.call(synthpop::syn, args))))
    synth[[k]] <- syn$syn
  }
  if (!is.null(interrupted)) return(list(interrupted = interrupted, data = synth, m = length(synth)))
  list(data = synth, kind = "empirical_synthetic", m = m,
       trainingObservations = nrow(data),
       generatedRecords = sum(vapply(synth, nrow, numeric(1))),
       counts = vcr_counts(realPatients = 0, generatedRecords = sum(vapply(synth, nrow, numeric(1)))),
       method = "cart", smoothing = smoothing, seed = seed,
       valueSource = "synthetic", modelTier = "data",
       inferenceLabel = "exploratory",
       rareLevelsMerged = merged$report, rareLevelFloor = floor_,
       variablesPerObservation = ncol(data) / max(nrow(data), 1),
       lowSampleWarning = nrow(data) < 5 * ncol(data))
}

#' Merge the levels of every character/factor column that have fewer than
#' `floor` rows into one level called "other". Returns the data and a report of
#' what was merged (level names only, never counts of a merged level).
.vcr_merge_rare_levels <- function(data, floor) {
  report <- list()
  for (v in names(data)) {
    x <- data[[v]]
    if (!(is.character(x) || is.factor(x))) next
    x <- as.character(x)
    tab <- table(x)
    rare <- names(tab)[tab < floor]
    if (!length(rare)) next
    x[x %in% rare] <- "other"
    data[[v]] <- x
    report[[v]] <- list(column = v, mergedLevels = rare)
  }
  list(data = data, report = unname(report))
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

# --- two versions of a population definition on the same table ------------------

# Hidden knowledge:
#
# - **A comparison of two definitions is a comparison of two cohorts of one
#   table.** Version A and version B of a definition are applied to the same
#   registered dataset with the cohort rules' own evaluation
#   (`vcr_apply_cohort_rules`: three-valued, `unknownAs` honoured), so "who is
#   in" means exactly what it means for the cohort job -- there is no second
#   reading of a rule here. Counts are people: how many each version keeps, how
#   many are in both, how many only one version keeps.
# - **The difference of a covariate is `vcr_smd`'s, not a new formula.** The two
#   cohorts are stacked (A is the reference group, B the other) and the
#   weighting methods' own standardized difference is taken with its pooled
#   denominator (`estimand = "ATE"`): a continuous covariate is
#   (mean B - mean A) / sqrt((var A + var B) / 2), a 0/1 covariate a difference
#   of proportions (cobalt's convention, which is what every balance table of
#   this engine reports). The two cohorts overlap -- a version is usually the
#   other with one rule changed -- and each person is counted in each cohort they
#   belong to: this describes the cohorts, it does not test them. Missing values
#   are dropped per covariate and per cohort, and the number dropped is reported:
#   a covariate is never imputed here.
# - **A covariate this method cannot standardize is named, not skipped.** A
#   column that is not numeric or 0/1 (text, a date) comes back with
#   `skipped = "not_numeric"`, a covariate a cohort has fewer than two
#   observations of `skipped = "too_few_observations"`, so the page can say what
#   was not compared.

#' @param df the table both versions are applied to
#' @param rules_a,rules_b named rules as `cohort.build` takes them
#' @param covariates column names to compare the two cohorts on
#' @return the sizes, the overlap, each version's waterfall and one row per covariate
vcr_cohort_comparison <- function(df, rules_a, rules_b, covariates) {
  res_a <- vcr_apply_cohort_rules(df, rules_a)
  res_b <- vcr_apply_cohort_rules(df, rules_b)
  in_a <- res_a$alive; in_b <- res_b$alive
  rows <- lapply(as.character(covariates), function(col) {
    x <- df[[col]]
    if (is.logical(x)) x <- as.numeric(x)
    base <- list(covariate = col)
    if (!is.numeric(x)) return(c(base, list(skipped = "not_numeric")))
    xa <- x[in_a]; xb <- x[in_b]
    missing_a <- sum(is.na(xa)); missing_b <- sum(is.na(xb))
    xa <- xa[!is.na(xa)]; xb <- xb[!is.na(xb)]
    if (length(xa) < 2L || length(xb) < 2L) {
      return(c(base, list(skipped = "too_few_observations", observedA = length(xa), observedB = length(xb), missingA = missing_a, missingB = missing_b)))
    }
    v <- c(xa, xb); grp <- c(rep(0L, length(xa)), rep(1L, length(xb)))
    binary <- all(v %in% c(0, 1))
    c(base, list(kind = if (binary) "binary" else "continuous",
                 meanA = mean(xa), meanB = mean(xb),
                 standardizedDifference = vcr_smd(v, grp, NULL, "ATE"),
                 observedA = length(xa), observedB = length(xb), missingA = missing_a, missingB = missing_b))
  })
  step_rows <- function(res) lapply(res$steps, function(s) list(rule = s$rule, kept = s$kept, excluded = s$excluded, indeterminate = s$indeterminate))
  list(cohortSizeA = sum(in_a), cohortSizeB = sum(in_b),
       overlap = list(both = sum(in_a & in_b), onlyA = sum(in_a & !in_b), onlyB = sum(!in_a & in_b)),
       waterfallA = step_rows(res_a), waterfallB = step_rows(res_b),
       covariates = rows,
       standardizedDifferenceFloor = vcr_limit("smdFloor", 0.1),
       binaryConvention = "difference of proportions")
}
