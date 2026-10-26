# Fixed, intercept-only AFT fits. No caller formula or executable expression is accepted.
# A reconstructed cohort remains pseudo-IPD; these are population baselines, not individual twins.
vcr_fit_survival_baseline <- function(time, status, distribution, horizons) {
  allowed <- c("exponential", "weibull", "lognormal", "loglogistic")
  if (!(distribution %in% allowed) || !is.numeric(time) || !is.numeric(status) ||
      length(time) != length(status) || anyNA(time) || anyNA(status) ||
      any(!is.finite(time)) || any(time <= 0) || any(!(status %in% c(0, 1)))) {
    vcr_abort("scenario_value_invalid", "scenario", "The fit needs positive times, binary event indicators and a supported distribution.")
  }
  if (!length(time) || sum(status) == 0) return(list(estimable = FALSE, rule = "too_few_events"))
  warned <- FALSE
  fit <- tryCatch(withCallingHandlers(
    survival::survreg(survival::Surv(time, status) ~ 1, dist = distribution),
    warning = function(w) { warned <<- TRUE; invokeRestart("muffleWarning") }), error = function(e) NULL)
  if (is.null(fit) || warned || any(!is.finite(c(fit[["coefficients"]], fit[["scale"]], fit[["var"]]))) || fit[["scale"]] <= 0) {
    return(list(estimable = FALSE, rule = "nuisance_model_not_estimable"))
  }
  mu <- as.numeric(fit[["coefficients"]][[1L]]); sigma <- as.numeric(fit[["scale"]])
  pars <- switch(distribution,
    exponential = list(kind = distribution, rate = exp(-mu)),
    weibull = list(kind = distribution, shape = 1 / sigma, scale = exp(mu)),
    lognormal = list(kind = distribution, meanlog = mu, sdlog = sigma),
    loglogistic = list(kind = distribution, shape = 1 / sigma, scale = exp(mu)))
  median <- as.numeric(survival::qsurvreg(0.5, mean = mu, scale = sigma, distribution = distribution))
  curve <- 1 - survival::psurvreg(horizons, mean = mu, scale = sigma, distribution = distribution)
  if (any(!is.finite(c(unlist(pars[-1L]), median, curve)))) return(list(estimable = FALSE, rule = "nuisance_model_not_estimable"))
  # survreg reports covariance in location and log(scale). This is uncertainty in the fitted median,
  # not percentiles of patient survival times and not digitization/reconstruction uncertainty.
  gradient <- if (distribution == "weibull") c(1, sigma * log(log(2))) else c(1, rep(0, nrow(fit[["var"]]) - 1L))
  se_log_median <- sqrt(max(0, as.numeric(t(gradient) %*% fit[["var"]] %*% gradient)))
  quantiles <- exp(log(median) + stats::qnorm(c(0.1, 0.5, 0.9)) * se_log_median)
  baseline_scenarios <- lapply(seq_along(quantiles), function(i) {
    distribution_at <- pars
    if (distribution == "exponential") distribution_at$rate <- log(2) / quantiles[i]
    if (distribution == "weibull") distribution_at$scale <- quantiles[i] / log(2)^(1 / pars$shape)
    if (distribution == "lognormal") distribution_at$meanlog <- log(quantiles[i])
    if (distribution == "loglogistic") distribution_at$scale <- quantiles[i]
    list(median = as.numeric(quantiles[i]), controlDistribution = distribution_at,
      shapeUncertaintyIncluded = FALSE, scope = "median_parameter_sensitivity_not_assurance")
  })
  names(baseline_scenarios) <- c("p10", "p50", "p90")
  list(estimable = TRUE, distribution = pars, baselineParameterScenarios = baseline_scenarios, location = mu, aftScale = sigma,
       covariance = unname(fit[["var"]]), logLikelihood = as.numeric(stats::logLik(fit)), aic = as.numeric(stats::AIC(fit)),
       median = median, medianParameterQuantiles = as.list(stats::setNames(quantiles, c("p10", "p50", "p90"))),
       medianParameterQuantileBasis = "delta_method_log_median_asymptotic_normal",
       curve = lapply(seq_along(horizons), function(i) list(time = horizons[i], survival = as.numeric(curve[i]),
         risk = as.numeric(1 - curve[i]), extrapolated = horizons[i] > max(time))), maxObservedTime = max(time))
}

vcr_job_fit_survival_model <- function(job, output_dir = NULL, ...) {
  sc <- job[["scenario"]]
  input <- vcr_input_by_id(job, as.character(sc[["inputId"]]))
  if (is.null(input)) vcr_abort("scenario_value_invalid", "scenario.inputId", "Select one frozen input table.")
  data <- vcr_read_table_input(input)
  vcr_require_individual(data, "Survival baseline fitting", "model.survival_fit")
  source <- vcr_table_source(data)
  used <- vcr_used_sources(list(list(df = data, columns = unique(c(sc[["timeColumn"]], sc[["statusColumn"]], sc[["armColumn"]], sc[["parameterColumn"]])))))
  estimate_source <- vcr_estimate_source(used[["source"]])
  original_n <- nrow(data)
  require_column <- function(name) {
    if (is.null(name) || !(name %in% names(data))) vcr_abort("scenario_value_invalid", "scenario", "A named model column is absent from the input.")
  }
  for (name in c(sc[["timeColumn"]], sc[["statusColumn"]])) require_column(name)
  if (!is.null(sc[["armColumn"]])) { require_column(sc[["armColumn"]]); data <- data[!is.na(data[[sc[["armColumn"]]]]) & as.character(data[[sc[["armColumn"]]]]) == as.character(sc[["armValue"]]), , drop = FALSE] }
  if (!is.null(sc[["parameterColumn"]])) { require_column(sc[["parameterColumn"]]); data <- data[!is.na(data[[sc[["parameterColumn"]]]]) & as.character(data[[sc[["parameterColumn"]]]]) == as.character(sc[["parameterValue"]]), , drop = FALSE] }
  id_col <- sc[["idColumn"]] %||% "USUBJID"
  if (source != "reconstructed") {
    require_column(id_col)
    ids <- as.character(data[[id_col]])
    if (anyNA(ids) || any(!nzchar(ids)) || anyDuplicated(ids)) vcr_abort("scenario_value_invalid", "scenario.idColumn", "Observed fitting data needs exactly one selected endpoint row per person.")
  }
  times <- data[[sc[["timeColumn"]]]]; status <- data[[sc[["statusColumn"]]]]
  if (!is.numeric(status)) vcr_abort("scenario_value_invalid", "scenario.statusColumn", "Event/censor values must be numeric zero or one.")
  if (identical(sc[["statusEncoding"]], "censor")) status <- 1 - status
  result <- vcr_fit_survival_baseline(times, status, as.character(sc[["distribution"]]), vcr_num(sc[["horizons"]]))
  attr(data, "vcrSource") <- source
  counts <- vcr_table_counts(data, if (is.numeric(status)) sum(status) else NULL)
  if (!result[["estimable"]]) return(list(status = "succeeded", conclusion = "not_estimable", notEstimableRule = result[["rule"]],
    counts = counts, measures = list(), diagnostics = list(inputRows = original_n, fittedRows = nrow(data), source = source)))
  list(status = "succeeded", conclusion = "limited", counts = counts,
    measures = list(vcr_measure("fitted_median", result[["median"]], source = estimate_source, unit = sc[["timeUnit"]]),
      vcr_measure("aic", result[["aic"]], source = estimate_source)),
    diagnostics = list(model = result, valueSourcesUsed = vcr_value_sources_used(used), inputRows = original_n, fittedRows = nrow(data), source = source,
      sourceCondition = sc[["sourceCondition"]] %||% "unspecified",
      armSelection = if (is.null(sc[["armColumn"]])) NULL else list(column = sc[["armColumn"]], value = sc[["armValue"]]),
      modelScope = "population_baseline", fitted = TRUE, clinicallyValidated = FALSE, causalEffectIdentified = FALSE,
      uncertainty = if (source == "reconstructed") "Conditional on reconstructed pseudo-IPD; digitization and reconstruction uncertainty excluded." else "Asymptotic fit uncertainty; transportability and model-form uncertainty excluded.",
      timeUnit = sc[["timeUnit"]]))
}
