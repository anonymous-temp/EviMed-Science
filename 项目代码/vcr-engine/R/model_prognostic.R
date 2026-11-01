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

# --- local calibration of an applied published model (remediation plan D3, 2026-11-01) ------------------------------------------------
#
# Hidden knowledge:
#
# - **A published equation is applied, not fitted, so the question about it is calibration in THIS table.** Given the outcome the table
#   itself holds, the result reports what STRATOS (Van Calster et al. 2019) asks for: the calibration intercept (the shift of the
#   linear predictor with its slope held at 1: a logistic model's offset fit, a linear model's mean residual) and the calibration slope
#   (the coefficient of the linear predictor, 1 when the spread of the predictions is right), each with a Wald interval, and
#   beside them the observed and the predicted risk and their difference, the names the forecast evaluation uses.
# - **The slope is the less stable of the two and is reported only when the data can carry it.** With fewer than the domain's floor of
#   events or non-events (`VCR_LOCAL_CALIBRATION_MIN`), or too few pairs for a continuous outcome, the intercept stands alone and the
#   result says what the slope needed. With no event, or no non-event, there is no intercept either (it is infinite) and the observed
#   and predicted risks are all there is. Nothing here changes the conclusion: the result stays `limited`, and what calibration cannot say
#   (any other population) is still said.
# - **Only observed outcomes calibrate.** A synthetic or predicted outcome column is refused by name: calibrating an equation against
#   data generated from its own assumptions measures nothing.
# - **A time-to-event outcome has no intercept of this kind.** Its calibration in the large is the predicted risk at the horizon less the
#   Kaplan-Meier risk observed by the horizon, and its slope is the coefficient of the score in a Cox model; both need absolute
#   predictions (a published baseline), and the slope needs the floor's events.

.vcr_wald <- function(est, se, level = 0.95) {
  z <- stats::qnorm(1 - (1 - level) / 2)
  if (!is.finite(est) || !is.finite(se)) return(NULL)
  list(value = est, se = se, low = est - z * se, high = est + z * se, level = level)
}

vcr_local_calibration <- function(data, applied, cal, model, endpoint) {
  floors <- vcr_domain()$limits$localCalibration
  family <- as.character(model[["family"]])
  valid <- is.finite(applied[["prediction"]]) | (family == "cox" & is.finite(applied[["score"]]))
  need <- function(column) {
    column <- as.character(column)
    if (!(column %in% names(data))) vcr_abort("scenario_value_invalid", "scenario.calibration", sprintf("The outcome column '%s' is not in the table.", column))
    column
  }
  src <- function(columns) {
    used <- vcr_used_source(data, columns)
    if (!is.na(used) && !(used %in% unlist(vcr_domain()$realPatientSources)))
      vcr_abort("scenario_value_invalid", "scenario.calibration", "A local calibration needs outcomes that were observed: a synthetic, predicted or assumed outcome calibrates nothing.")
    used
  }
  out <- list(family = family)
  if (family %in% c("linear", "logistic")) {
    col <- need(cal[["outcomeColumn"]]); out$source <- src(col); out$outcomeColumn <- col
    y <- suppressWarnings(as.numeric(data[[col]]))
    ok <- valid & is.finite(y)
    if (identical(family, "logistic") && !all(y[ok] %in% c(0, 1))) vcr_abort("scenario_value_invalid", "scenario.calibration.outcomeColumn", "A binary outcome is 0 or 1.")
    pred <- applied[["prediction"]][ok]; lp <- applied[["score"]][ok]; yy <- y[ok]
    out$n <- length(yy); out$excluded <- sum(!ok)
    if (identical(family, "logistic")) {
      ev <- sum(yy == 1); nev <- sum(yy == 0)
      out$events <- ev; out$nonEvents <- nev
      out$observedRisk <- if (length(yy)) mean(yy) else NULL; out$predictedRisk <- if (length(yy)) mean(pred) else NULL
      if (length(yy)) out$calibrationInLarge <- mean(pred) - mean(yy)
      if (ev < 1L || nev < 1L) {
        out$interceptUnavailable <- if (ev < 1L) "no_events" else "no_non_events"
        out$slopeUnavailable <- out$interceptUnavailable
        return(out)
      }
      fit0 <- tryCatch(suppressWarnings(stats::glm(yy ~ 1, offset = lp, family = stats::binomial())), error = function(e) NULL)
      if (!is.null(fit0) && isTRUE(fit0$converged)) {
        co <- summary(fit0)$coefficients; out$intercept <- .vcr_wald(co[1, "Estimate"], co[1, "Std. Error"])
      } else out$interceptUnavailable <- "model_did_not_converge"
      if (ev < floors$slopeEvents || nev < floors$slopeNonEvents) {
        out$slopeUnavailable <- "too_few_events"
        out$slopeNeeds <- list(events = floors$slopeEvents, nonEvents = floors$slopeNonEvents)
      } else if (stats::sd(lp) <= 0) {
        out$slopeUnavailable <- "predictions_do_not_vary"
      } else {
        fit1 <- tryCatch(suppressWarnings(stats::glm(yy ~ lp, family = stats::binomial())), error = function(e) NULL)
        if (!is.null(fit1) && isTRUE(fit1$converged)) { co <- summary(fit1)$coefficients; out$slope <- .vcr_wald(co["lp", "Estimate"], co["lp", "Std. Error"]) }
        else out$slopeUnavailable <- "model_did_not_converge"
      }
      return(out)
    }
    # a linear model: the mean residual is the intercept at slope 1, and the slope is the least-squares coefficient of the prediction
    out$observedMean <- if (length(yy)) mean(yy) else NULL; out$predictedMean <- if (length(yy)) mean(pred) else NULL
    if (length(yy)) out$calibrationInLarge <- mean(pred) - mean(yy)
    if (length(yy) < 2L) { out$interceptUnavailable <- "too_few_pairs"; out$slopeUnavailable <- "too_few_pairs"; return(out) }
    r <- yy - pred
    tq <- stats::qt(0.975, length(yy) - 1L)
    se0 <- stats::sd(r) / sqrt(length(yy))
    out$intercept <- list(value = mean(r), se = se0, low = mean(r) - tq * se0, high = mean(r) + tq * se0, level = 0.95)
    if (length(yy) < floors$slopePairs) { out$slopeUnavailable <- "too_few_pairs"; out$slopeNeeds <- list(pairs = floors$slopePairs) }
    else if (stats::sd(pred) <= 0) out$slopeUnavailable <- "predictions_do_not_vary"
    else {
      fit1 <- stats::lm(yy ~ pred); co <- summary(fit1)$coefficients; tq1 <- stats::qt(0.975, fit1$df.residual)
      out$slope <- list(value = co["pred", "Estimate"], se = co["pred", "Std. Error"], low = co["pred", "Estimate"] - tq1 * co["pred", "Std. Error"],
                        high = co["pred", "Estimate"] + tq1 * co["pred", "Std. Error"], level = 0.95)
    }
    return(out)
  }
  # a time-to-event outcome
  tcol <- need(cal[["timeColumn"]]); scol <- need(cal[["statusColumn"]]); out$source <- src(c(tcol, scol)); out$timeColumn <- tcol; out$statusColumn <- scol
  tm <- suppressWarnings(as.numeric(data[[tcol]])); st <- suppressWarnings(as.numeric(data[[scol]]))
  ok <- is.finite(applied[["score"]]) & is.finite(tm) & is.finite(st) & tm >= 0
  if (!all(st[ok] %in% c(0, 1))) vcr_abort("scenario_value_invalid", "scenario.calibration.statusColumn", "The status is 1 for an event and 0 for a censored person.")
  tm <- tm[ok]; st <- st[ok]; score <- applied[["score"]][ok]; pred <- applied[["prediction"]][ok]
  out$n <- length(tm); out$excluded <- sum(!ok); out$events <- sum(st == 1); out$horizon <- endpoint[["horizon"]]
  h <- as.numeric(endpoint[["horizon"]])
  if (length(tm) >= 2L && out$events >= 1L && isTRUE(applied[["absoluteRiskAvailable"]]) && all(is.finite(pred))) {
    km <- vcr_km(tm, st); s_h <- vcr_km_at(km, h)
    if (is.finite(s_h) && h <= max(tm)) {
      out$observedRisk <- 1 - s_h; out$predictedRisk <- mean(pred); out$calibrationInLarge <- mean(pred) - (1 - s_h)
    } else out$observedRiskUnavailable <- "horizon_beyond_follow_up"
  } else out$observedRiskUnavailable <- if (!isTRUE(applied[["absoluteRiskAvailable"]])) "no_baseline_risk" else "too_few_events"
  out$interceptUnavailable <- "not_defined_for_time_to_event"
  if (out$events < floors$slopeEvents) { out$slopeUnavailable <- "too_few_events"; out$slopeNeeds <- list(events = floors$slopeEvents) }
  else if (stats::sd(score) <= 0) out$slopeUnavailable <- "predictions_do_not_vary"
  else {
    fit <- tryCatch(suppressWarnings(survival::coxph(survival::Surv(tm, st) ~ score)), error = function(e) NULL)
    if (!is.null(fit) && is.finite(stats::coef(fit)[[1]])) out$slope <- .vcr_wald(unname(stats::coef(fit)[[1]]), sqrt(unname(stats::vcov(fit)[1, 1])))
    else out$slopeUnavailable <- "model_did_not_converge"
  }
  out
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
  # held against the outcome the table has, when the scenario names one; the conclusion is what it was
  calibration <- if (!is.null(sc[["calibration"]]) && applied[["valid"]] > 0) vcr_local_calibration(data, applied, sc[["calibration"]], sc[["model"]], sc[["endpoint"]]) else NULL
  if (!is.null(calibration)) {
    add <- function(name, x) if (!is.null(x)) measures <<- c(measures, list(vcr_measure(name, x$value, source = "calculated",
                                                                                      interval = vcr_interval("confidence", x$low, x$high))))
    add("calibration_intercept", calibration[["intercept"]]); add("calibration_slope", calibration[["slope"]])
    if (!is.null(calibration[["calibrationInLarge"]])) measures <- c(measures, list(vcr_measure("calibration_in_the_large", calibration[["calibrationInLarge"]], source = "calculated")))
    if (!is.null(calibration[["observedRisk"]])) measures <- c(measures, list(vcr_measure("observed_risk", calibration[["observedRisk"]], source = "observed")))
  }
  counts <- vcr_table_counts(data)
  list(status = "succeeded", conclusion = if (applied[["valid"]] > 0) "limited" else "not_estimable",
    notEstimableRule = if (applied[["valid"]] > 0) NULL else "nuisance_model_not_estimable", counts = counts, measures = measures,
    diagnostics = list(modelScope = "published_prognostic_equation", valueSourcesUsed = vcr_value_sources_used(used), cohort = cohort[["info"]], sourceCondition = sc[["sourceCondition"]],
      family = sc[["model"]][["family"]], endpoint = sc[["endpoint"]], validPredictions = applied[["valid"]], invalidPredictions = applied[["invalid"]],
      absoluteRiskAvailable = applied[["absoluteRiskAvailable"]], causalEffectIdentified = FALSE,
      coefficientUncertainty = applied[["coefficientUncertainty"]], clinicallyValidated = FALSE,
      populationVarianceIncludesResidual = !is.null(applied[["outcomeSd"]]),
      localCalibration = calibration,
      limits = list(if (is.null(calibration)) "Transportability and calibration in this target population have not been established."
                    else "Calibration was measured on the observed outcomes of this table; transportability to any other population has not been established.",
        "Predictions are not observed control outcomes or an independent increase in sample size.")),
    tables = .vcr_tables_of(list(vcr_write_table(output, "prognostic-predictions", output_dir))))
}
