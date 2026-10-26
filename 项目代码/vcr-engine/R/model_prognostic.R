# Published equations are typed data. They are never parsed or evaluated as code.
# A prediction under a stated condition is a prognostic benchmark, not an identified treatment effect.
vcr_apply_prognostic_equation <- function(data, model, input_units) {
  family <- as.character(model[["family"]])
  if (!(family %in% c("linear", "logistic", "cox"))) vcr_abort("scenario_value_invalid", "scenario.model.family", "Unsupported prognostic family.")
  n <- nrow(data); score <- rep(as.numeric(model[["intercept"]] %||% 0), n)
  reasons <- rep("", n)
  mark <- function(mask, reason) { reasons[mask & !nzchar(reasons)] <<- reason }
  for (term in model[["terms"]]) {
    if (is.null(term[["center"]]) || is.null(term[["scale"]]) || !is.finite(term[["center"]]) || !is.finite(term[["scale"]]) || term[["scale"]] <= 0)
      vcr_abort("scenario_value_invalid", "scenario.model.terms", "Every predictor explicitly declares its centering and scaling.")
    column <- as.character(term[["column"]])
    if (!(column %in% names(data))) { mark(rep(TRUE, n), paste0("missing_column:", column)); next }
    if (is.null(input_units[[column]]) || !identical(as.character(input_units[[column]]), as.character(term[["unit"]]))) {
      mark(rep(TRUE, n), paste0("unit_unknown_or_mismatch:", column)); next
    }
    raw <- data[[column]]
    if (identical(term[["transform"]], "indicator")) {
      levels <- as.character(unlist(term[["levels"]], use.names = FALSE))
      if (!length(levels) || is.null(term[["category"]]) || !(term[["category"]] %in% levels)) vcr_abort("scenario_value_invalid", "scenario.model.terms", "An indicator names a category in its declared levels.")
      mark(is.na(raw) | !(as.character(raw) %in% levels), paste0("unknown_category:", column))
      value <- as.numeric(as.character(raw) == as.character(term[["category"]]))
    } else {
      if (!is.numeric(raw)) { mark(rep(TRUE, n), paste0("non_numeric:", column)); next }
      mark(is.na(raw) | !is.finite(raw), paste0("missing_value:", column))
      value <- raw
      transform <- term[["transform"]] %||% "identity"
      if (transform == "log") { mark(!is.na(raw) & raw <= 0, paste0("transform_domain:", column)); value <- suppressWarnings(log(raw)) }
      else if (transform == "log1p") { mark(!is.na(raw) & raw <= -1, paste0("transform_domain:", column)); value <- suppressWarnings(log1p(raw)) }
      else if (transform == "square") value <- raw^2
      else if (transform != "identity") vcr_abort("scenario_value_invalid", "scenario.model.terms", "Unsupported transform.")
    }
    score <- score + as.numeric(term[["coefficient"]]) * (value - as.numeric(term[["center"]] %||% 0)) / as.numeric(term[["scale"]] %||% 1)
  }
  mark(!is.finite(score), "non_finite_score")
  score[nzchar(reasons)] <- NA_real_
  baseline <- model[["baseline"]]
  reference_known <- !is.null(baseline) && !is.null(baseline[["reference"]]) && baseline[["reference"]] %in% c("zero", "centered")
  if (reference_known && baseline[["reference"]] == "zero" && any(vapply(model[["terms"]], function(term) term[["center"]] != 0, logical(1))))
    vcr_abort("scenario_value_invalid", "scenario.model.baseline.reference", "A zero reference cannot use nonzero covariate centers.")
  absolute <- family != "cox" || reference_known
  prediction <- if (family == "linear") score else if (family == "logistic") stats::plogis(score) else rep(NA_real_, n)
  if (family == "cox" && absolute) {
    baseline <- as.numeric(model[["baseline"]][["survival"]])
    # The published reference is encoded by each term's center. Missing reference centering must not be assumed by extraction.
    prediction <- if (baseline == 0) rep(1, n) else if (baseline == 1) rep(0, n) else -expm1(log(baseline) * exp(score))
  }
  prediction[nzchar(reasons)] <- NA_real_
  valid <- !nzchar(reasons)
  mean_prediction <- if (absolute && any(valid)) mean(prediction[valid]) else NULL
  outcome_sd <- if (family == "linear" && !is.null(model[["residualSd"]]) && any(valid))
    sqrt(mean((prediction[valid] - mean_prediction)^2) + as.numeric(model[["residualSd"]])^2) else NULL
  list(score = score, prediction = prediction, reasons = reasons, absoluteRiskAvailable = absolute,
    valid = sum(valid), invalid = sum(!valid), meanPrediction = mean_prediction, outcomeSd = outcome_sd,
    causalEffectIdentified = FALSE, coefficientUncertainty = "fixed_coefficients_not_estimated")
}

vcr_job_apply_prognostic_model <- function(job, output_dir = NULL, ...) {
  sc <- job[["scenario"]]
  input <- vcr_input_by_id(job, as.character(sc[["inputId"]]))
  if (is.null(input)) vcr_abort("scenario_value_invalid", "scenario.inputId", "Select one frozen baseline table.")
  expected_endpoint <- switch(as.character(sc[["model"]][["family"]]), linear = "continuous", logistic = "binary", cox = "time_to_event")
  if (!identical(sc[["endpoint"]][["type"]], expected_endpoint)) vcr_abort("scenario_value_invalid", "scenario.endpoint", "The endpoint must agree with the equation family.")
  if (!is.null(sc[["model"]][["baseline"]]) && (!identical(sc[["model"]][["baseline"]][["timeUnit"]], sc[["endpoint"]][["timeUnit"]]) || sc[["model"]][["baseline"]][["horizon"]] != sc[["endpoint"]][["horizon"]])) vcr_abort("scenario_value_invalid", "scenario.model.baseline", "The baseline horizon and unit must agree with the requested endpoint.")
  data <- vcr_read_table_input(input)
  source <- vcr_table_source(data)
  cohort <- vcr_apply_downstream_cohort(data, sc[["cohortRules"]])
  data <- cohort[["data"]]; attr(data, "vcrSource") <- source
  vcr_require_individual(data, "Published prognostic equation", "model.prognostic_apply")
  id_col <- as.character(sc[["idColumn"]])
  if (identical(id_col, "__generated_patient_id") && identical(source, "synthetic")) {
    ids <- vcr_patient_ids(job, data, nrow(data))
  } else {
    if (!(id_col %in% names(data))) vcr_abort("scenario_value_invalid", "scenario.idColumn", "The baseline identifier column is absent.")
    ids <- as.character(data[[id_col]])
  }
  if (anyNA(ids) || any(!nzchar(ids)) || anyDuplicated(ids)) vcr_abort("scenario_value_invalid", "scenario.idColumn", "Exactly one baseline row per patient is required.")
  used <- vcr_used_sources(list(list(df = data, columns = unique(c(vapply(sc[["model"]][["terms"]], function(term) as.character(term[["column"]]), character(1)))))))
  applied <- vcr_apply_prognostic_equation(data, sc[["model"]], sc[["inputUnits"]])
  output <- data.frame(patientId = ids, score = applied[["score"]], prediction = applied[["prediction"]],
    reason = applied[["reasons"]], source = "predicted", modelTier = "literature", stringsAsFactors = FALSE)
  measures <- list()
  if (!is.null(applied[["meanPrediction"]])) measures <- c(measures, list(vcr_measure("predicted_population_mean", applied[["meanPrediction"]], source = "predicted")))
  if (!is.null(applied[["outcomeSd"]])) measures <- c(measures, list(vcr_measure("predicted_outcome_sd", applied[["outcomeSd"]], source = "predicted")))
  if (applied[["valid"]] > 0 && !applied[["absoluteRiskAvailable"]]) measures <- c(measures, list(vcr_measure("mean_relative_score", mean(applied[["score"]], na.rm = TRUE), source = "predicted")))
  counts <- vcr_table_counts(data)
  list(status = "succeeded", conclusion = if (applied[["valid"]] > 0) "limited" else "not_estimable",
    notEstimableRule = if (applied[["valid"]] > 0) NULL else "nuisance_model_not_estimable", counts = counts, measures = measures,
    diagnostics = list(modelScope = "published_prognostic_equation", valueSourcesUsed = vcr_value_sources_used(used), cohort = cohort[["info"]], sourceCondition = sc[["sourceCondition"]],
      family = sc[["model"]][["family"]], endpoint = sc[["endpoint"]], validPredictions = applied[["valid"]], invalidPredictions = applied[["invalid"]],
      absoluteRiskAvailable = applied[["absoluteRiskAvailable"]], causalEffectIdentified = FALSE,
      coefficientUncertainty = applied[["coefficientUncertainty"]], clinicallyValidated = FALSE,
      populationVarianceIncludesResidual = !is.null(applied[["outcomeSd"]]),
      limits = list("Transportability and calibration in this target population have not been established.",
        "Predictions are not observed control outcomes or an independent increase in sample size.")),
    tables = .vcr_tables_of(list(vcr_write_table(output, "prognostic-predictions", output_dir))))
}
