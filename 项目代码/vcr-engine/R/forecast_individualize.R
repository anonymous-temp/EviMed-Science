# ---------------------------------------------------------------------------
# forecast_individualize.R -- forecast.individualize 1.0.0: a batch of people's own histories turned into one forecast per person
# (plan R32, compute path, in-silico round 2 wave 5).
#
# `individualize.R` holds the statistics (the mixed model, the MAP and Laplace posterior, the beta_logit individual posterior) and is
# pinned by the R33 protocol; this file only reads a table of events, calls it per person and writes the forecasts as a kept table.
#
# Hidden knowledge:
#
# - **The input is one long table of what the control plane projected, not a snapshot.** Columns `subject`, `code`, `value`, `day`: the
#   control plane already cut every person's history at the forecast origin (nothing after it is ever in the table), converted every value
#   to the endpoint's unit and replaced the person's identifier by the study pseudonym; `day` is the number of days from the origin, zero
#   or negative. The engine re-checks the one thing it can (`day <= 0`) and refuses a table with a later row rather than forecast from it.
# - **The population model is fitted on the batch itself.** A linear mixed model needs several people's curves to know how people
#   differ; here those are the people being forecast, each through their own rows before the origin only. This is the empirical-Bayes
#   reading the R33 evaluation scored (fitted on the training people, applied to others): nothing about a person's future is ever read,
#   but a batch of fewer than three people with observations cannot be fitted and the job says so by name.
# - **A person without an own observation is not forecast** (`no_own_history`): the claim of this method is that the person's own history
#   updated the forecast, and a population line handed out under it would carry the wrong sentence. The row exists, with its status.
# - **Time scales differ by family and are stated.** The mixed model runs in years since the origin (the random intercept is the person's
#   value AT the origin); the Alzheimer model runs in weeks since the person's FIRST observed score, which is taken as study week 0
#   because that is what its placebo curve and its parameters are anchored to. Scores are on the instrument's own 0-70 scale throughout. The covariates it needs (baseline MMSE, age, ApoE4 allele
#   count, female) are read from the codes `mmse`, `age`, `apoe4`, `female` (the latest value of each); a person without all four is
#   `covariates_missing`, never given a typical value.
# - **Draws are per person and fixed by the sorted subject order.** One L'Ecuyer substream per person from the job's seed: the same table
#   and seed give identical numbers on any core count (the loop is sequential on purpose; a person's fit costs milliseconds). Closed-form
#   linear mixed model rows draw nothing.
# - **The Laplace approximation is flagged, not hidden.** A person whose curvature was not positive definite keeps the forecast (the repaired
#   covariance is what the draws used) and is counted in `diagnostics.individualize.laplaceNotTrusted`.
# ---------------------------------------------------------------------------

.VCR_INDIVIDUALIZE_QUANTILES <- c(0.05, 0.25, 0.5, 0.75, 0.95)
.VCR_INDIVIDUALIZE_COVARIATES <- c("mmse", "age", "apoe4", "female")
.VCR_INDIVIDUALIZE_LIMITS_AD <- c(
  "The Alzheimer model's individual posterior was checked against a known truth by simulation only; no real-data comparison with a simpler forecast has been made.",
  "The first observed score of each person is taken as their study week 0; the model's placebo course is anchored there."
)

#' The table's columns, checked; a table that is not the projected events is refused by name and never echoed.
.vcr_individualize_events <- function(data) {
  need <- c("subject", "code", "value", "day")
  if (!all(need %in% names(data))) vcr_abort("input_shape_invalid", "inputs", sprintf("The events table has the columns %s.", paste(need, collapse = ", ")))
  out <- data.frame(subject = as.character(data[["subject"]]), code = as.character(data[["code"]]),
                    value = suppressWarnings(as.numeric(data[["value"]])), day = suppressWarnings(as.numeric(data[["day"]])), stringsAsFactors = FALSE)
  if (anyNA(out$subject) || any(!nzchar(out$subject)) || anyNA(out$code) || any(!is.finite(out$day))) {
    vcr_abort("input_shape_invalid", "inputs", "Every event names a subject, a code and a day.")
  }
  if (any(out$day > 0)) vcr_abort("input_shape_invalid", "inputs", "The events table holds nothing after the forecast origin (day <= 0).")
  out
}

#' One row per person and horizon: `status` "ok" with the forecast, or the reason there is none. Quantiles are the central ones of the
#' predictive distribution of an OBSERVED value.
.vcr_individualize_row <- function(subject, horizon, status, point = NA_real_, sd = NA_real_, q = rep(NA_real_, length(.VCR_INDIVIDUALIZE_QUANTILES)),
                                   n_history = 0L, flag = 0L) {
  row <- data.frame(subject = subject, horizonDays = horizon, status = status, point = point, sd = sd, stringsAsFactors = FALSE)
  for (i in seq_along(.VCR_INDIVIDUALIZE_QUANTILES)) row[[sprintf("q%02d", round(100 * .VCR_INDIVIDUALIZE_QUANTILES[i]))]] <- q[i]
  row$nHistory <- as.integer(n_history); row$flag <- as.integer(flag)
  row
}

#' The linear mixed model, a person at a time. `t` is in years from the origin.
.vcr_individualize_lmm <- function(ev, code, horizons) {
  obs <- ev[ev$code == code & is.finite(ev$value), , drop = FALSE]
  subjects <- sort(unique(ev$subject))
  if (!nrow(obs)) vcr_abort("input_shape_invalid", "inputs", "The table holds no observation of the endpoint.")
  t_obs <- obs$day / 365.25
  fit <- vcr_lmm_fit(obs$value, cbind(`(Intercept)` = 1, time = t_obs), t_obs, obs$subject)
  t_new <- horizons / 365.25
  X_new <- cbind(1, t_new)
  rows <- list(); stopped <- NULL
  for (k in seq_along(subjects)) {
    if (k %% 100L == 1L) { stopped <- vcr_interrupt(); if (!is.null(stopped)) break }
    s <- subjects[k]; own <- obs[obs$subject == s, , drop = FALSE]
    if (!nrow(own)) {
      rows[[k]] <- do.call(rbind, lapply(horizons, function(h) .vcr_individualize_row(s, h, "no_own_history")))
      next
    }
    th <- own$day / 365.25
    p <- vcr_lmm_individualize(fit, X_new, t_new, cbind(1, th), th, own$value)
    rows[[k]] <- do.call(rbind, lapply(seq_along(horizons), function(j)
      .vcr_individualize_row(s, horizons[j], "ok", p$mean[j], p$sd[j], p$mean[j] + stats::qnorm(.VCR_INDIVIDUALIZE_QUANTILES) * p$sd[j], nrow(own))))
  }
  list(table = do.call(rbind, rows), stopped = stopped, planned = length(subjects), done = length(rows),
       fit = list(fixedEffects = as.list(fit$beta), sdIntercept = fit$sd0, sdSlope = fit$sd1, correlation = fit$rho, sdResidual = fit$sigma,
                  converged = isTRUE(fit$converged), timeScale = "years from the forecast origin"),
       limits = as.list(fit$limits), laplaceNotTrusted = 0L)
}

#' The Alzheimer model's individual posterior, a person at a time. `t` is in weeks from the person's first observed score.
.vcr_individualize_beta_logit <- function(ev, code, horizons, sc, seed) {
  set <- vcr_beta_logit_parameter_set(as.character(sc[["parameterSet"]][["id"]] %||% "camd-adas-cog-11"), as.character(sc[["parameterSet"]][["version"]] %||% "adsim-3.0"))
  par <- vcr_beta_logit_par(set$medians)
  study <- vcr_beta_logit_typical_study(par)
  draws <- as.integer(sc[["draws"]] %||% 400L)
  subjects <- sort(unique(ev$subject))
  bank <- vcr_stream_bank(seed)
  streams <- bank$take(length(subjects))
  latest <- function(own, name) { r <- own[own$code == name & is.finite(own$value), , drop = FALSE]; if (!nrow(r)) NA_real_ else r$value[which.max(r$day)] }
  rows <- list(); stopped <- NULL; untrusted <- 0L
  for (k in seq_along(subjects)) {
    if (k %% 25L == 1L) { stopped <- vcr_interrupt(); if (!is.null(stopped)) break }
    s <- subjects[k]; own <- ev[ev$subject == s, , drop = FALSE]
    sc_obs <- own[own$code == code & is.finite(own$value), , drop = FALSE]
    refuse <- function(status) do.call(rbind, lapply(horizons, function(h) .vcr_individualize_row(s, h, status, n_history = nrow(sc_obs))))
    if (!nrow(sc_obs)) { rows[[k]] <- refuse("no_own_history"); next }
    cov <- list(mmse = latest(own, "mmse"), age = latest(own, "age"), apoe = latest(own, "apoe4"), female = latest(own, "female"))
    if (any(!is.finite(unlist(cov))) || !(cov$apoe %in% 0:2) || !(cov$female %in% 0:1)) { rows[[k]] <- refuse("covariates_missing"); next }
    if (any(sc_obs$value < 0 | sc_obs$value > 70)) { rows[[k]] <- refuse("score_out_of_range"); next }
    day0 <- min(sc_obs$day)
    t_obs <- (sc_obs$day - day0) / 7
    t_new <- (horizons - day0) / 7
    pred <- vcr_with_stream(streams[[k]], function(.) vcr_beta_logit_individual_predict(par, study, cov, t_obs, sc_obs$value, t_new, draws), k)
    ok <- isTRUE(attr(pred, "laplaceOk"))
    if (!ok) untrusted <- untrusted + 1L
    rows[[k]] <- do.call(rbind, lapply(seq_along(horizons), function(j) {
      d <- pred[, j]
      .vcr_individualize_row(s, horizons[j], "ok", mean(d), stats::sd(d), as.numeric(stats::quantile(d, .VCR_INDIVIDUALIZE_QUANTILES, names = FALSE, type = 7)),
                             nrow(sc_obs), flag = if (ok) 0L else 1L)
    }))
  }
  list(table = do.call(rbind, rows), stopped = stopped, planned = length(subjects), done = length(rows),
       fit = list(parameterSet = list(id = set$id, version = set$version), draws = draws, timeScale = "weeks from the first observed score"),
       limits = as.list(.VCR_INDIVIDUALIZE_LIMITS_AD), laplaceNotTrusted = untrusted)
}

vcr_job_forecast_individualize <- function(job, output_dir = NULL, ...) {
  sc <- job[["scenario"]]
  input <- vcr_input_by_id(job, as.character(sc[["inputId"]]))
  if (is.null(input)) vcr_abort("scenario_value_invalid", "scenario.inputId", "Name the frozen events table.")
  data <- vcr_read_table_input(input)
  source <- vcr_table_source(data)
  ev <- .vcr_individualize_events(data)
  code <- as.character(sc[["endpoint"]][["code"]])
  horizons <- vcr_num(sc[["horizonsDays"]])
  family <- as.character(sc[["family"]])
  out <- if (identical(family, "beta_logit")) .vcr_individualize_beta_logit(ev, code, horizons, sc, as.integer(job[["seed"]] %||% 1L))
         else .vcr_individualize_lmm(ev, code, horizons)
  if (identical(out$stopped, "canceled")) return(.vcr_interrupted_result("canceled", sprintf("%d of %d people were forecast", out$done, out$planned)))
  tbl <- out$table
  people <- length(unique(ev$subject))
  forecast_people <- length(unique(tbl$subject[tbl$status == "ok"]))
  persons <- data.frame(subject = unique(ev$subject))
  attr(persons, "vcrSource") <- source
  counts <- vcr_table_counts(persons)
  measures <- list(vcr_measure("people_forecast", forecast_people, source = "calculated", unit = "people"),
                   vcr_measure("people_without_forecast", length(unique(tbl$subject)) - forecast_people, source = "calculated", unit = "people"))
  # a spent CPU budget keeps the people already forecast and says how far it got (`interrupted`); nothing is invented for the rest
  list(status = "succeeded", conclusion = if (forecast_people > 0) "limited" else "not_estimable",
       notEstimableRule = if (forecast_people > 0) NULL else "nuisance_model_not_estimable", counts = counts, measures = measures,
       diagnostics = list(individualize = list(family = family, endpoint = sc[["endpoint"]], horizonsDays = horizons, peopleInTable = people,
                                               forecastPeople = forecast_people, laplaceNotTrusted = out$laplaceNotTrusted,
                                               fit = out$fit, interrupted = out$stopped, peoplePlanned = out$planned, peopleDone = out$done),
                          claim = "individualized_forecast", clinicallyValidated = FALSE, limits = out$limits),
       tables = .vcr_tables_of(list(vcr_write_table(tbl, "person-forecasts", output_dir, roundtrip_numeric = TRUE))))
}
