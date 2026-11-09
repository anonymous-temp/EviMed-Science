# ---------------------------------------------------------------------------
# patients_progression_people.R — one executable set of patients for the beta_logit family of `patients.progression` 1.2.0 (plan R23, 2026-11-09):
# the virtual patient record drawn once ("instantiate"), the population input a run reads, and the two modes that answer different questions.
#
# Hidden knowledge:
#
# - **The record is people, not a description of people.** `instantiate` draws one study and then, for every person, the baseline covariates and
#   the two individual parameters of the model (the intercept eta and the slope alpha, with the person's covariate-adjusted study-mean slope that
#   the disease-modifying term multiplies), and writes them as one table (`progression-people`) with the study's residual precision and dropout
#   effect and the SHA-256 of the parameter file it was made for. The control plane files it in the data plane with its hash; every later run
#   reads that table, so the same people stand in every arm of a comparison by construction, not by seed discipline.
# - **Two modes, kept apart.** `resampled_trials`: each simulated trial draws its n people from the record (without replacement while the record is
#   large enough, with replacement beyond it), randomizes them, and analyses as every other trial of this method: power or assurance with its
#   Monte Carlo error. `paired_counterfactual`: every person of the record under every arm, the same individual effects, the same dropout time and
#   the same uniform draws for the residuals (an inverse-distribution coupling through the gamma quantile function), so a person's two scores differ
#   by what the arms differ in; the result is the distribution of the contrast across these people, labelled model-implied: the model's reading of
#   what would have happened to them, never an observed individual treatment effect.
# - **A population table fixes the study.** The study-level draws (mean intercept, mean slope, the three precisions, the dropout effect) are the
#   record's, made once; a run on it varies the residuals, the dropout times, the sample and the effect only. Run `instantiate` again with another
#   seed to see the study-to-study variation.
# - **What is outside the fitted ranges is said, never refused.** A baseline MMSE outside the 16 to 26 the trials entered with is counted and
#   named in the result as an extrapolation. A covariate that cannot describe a person (an MMSE outside 0 to 30, a genotype other than 0, 1, 2,
#   an age outside 0 to 130) is refused with its row count, because no number can honestly be computed for such a person.
# - **A synthetic table only.** The record is written under the data plane's derived tree, which the engine's user can read; a table of real
#   people's covariates is never turned into one, and the run refuses an input that is not synthetic.
# ---------------------------------------------------------------------------

.VCR_BL_PEOPLE_MODES <- c("paired_counterfactual", "resampled_trials")
.VCR_BL_PEOPLE_COLUMNS <- c("USUBJID", "MMSE", "AGE", "APOE4", "FEMALE", "ETA", "ALPHA", "MEANSLOPE", "TAU", "OMEGA", "PARAMSET_SHA256")
#' The baseline MMSE the fitted trials entered with (the parameter set's own entry range).
.VCR_BL_FITTED_MMSE <- c(16, 26)

# --- reading a record ----------------------------------------------------------------------------------------------------------------------

#' The record a job names (`scenario.people.inputId`) as vectors, checked. Refused, with the row count, when a person cannot be described.
.vcr_bl_read_record <- function(job, input_id, set) {
  input <- vcr_input_by_id(job, input_id)
  field <- "scenario.people.inputId"
  if (is.null(input) || is.null(input[["location"]])) vcr_abort("input_shape_invalid", field, "The people table the scenario names is not among the job's inputs.")
  df <- vcr_read_table_input(input)
  if (!identical(attr(df, "vcrSource"), "synthetic")) {
    vcr_abort("input_shape_invalid", field, "The people table of a simulation is a synthetic table made by this method; a table of real people's rows is not used as one.")
  }
  need <- setdiff(.VCR_BL_PEOPLE_COLUMNS, "USUBJID")
  if (!all(c("USUBJID", need) %in% names(df))) vcr_abort("input_shape_invalid", field, sprintf("The people table has the columns %s.", paste(.VCR_BL_PEOPLE_COLUMNS, collapse = ", ")))
  num <- function(k) { v <- suppressWarnings(as.numeric(df[[k]])); if (anyNA(v) || !all(is.finite(v))) vcr_abort("input_shape_invalid", field, sprintf("Column %s holds a number for every person.", k)); v }
  one <- function(k) { u <- unique(df[[k]]); if (length(u) != 1L) vcr_abort("input_shape_invalid", field, sprintf("Column %s is one value for the whole table (the study it was made in).", k)); u }
  rec <- list(n = nrow(df), mmse = num("MMSE"), age = num("AGE"), apoe = as.integer(num("APOE4")), female = num("FEMALE"), eta = num("ETA"), alpha = num("ALPHA"),
              meanSlope = num("MEANSLOPE"), tau = as.numeric(one("TAU")), omega = as.numeric(one("OMEGA")), paramsetSha = as.character(one("PARAMSET_SHA256")))
  if (rec$n < 2L) vcr_abort("input_shape_invalid", field, "A people table holds at least two people.")
  count_bad <- function(bad, k, detail) if (any(bad)) vcr_abort("input_shape_invalid", field, sprintf("%d of %d people %s (column %s).", sum(bad), rec$n, detail, k))
  count_bad(rec$mmse < 0 | rec$mmse > 30, "MMSE", "have a baseline MMSE outside 0 to 30")
  count_bad(rec$age < 0 | rec$age > 130, "AGE", "have an age outside 0 to 130 years")
  count_bad(!(rec$apoe %in% 0:2), "APOE4", "have an ApoE4 allele count other than 0, 1 or 2")
  count_bad(!(rec$female %in% c(0, 1)), "FEMALE", "have a sex other than 0 or 1")
  if (!(rec$tau > 0)) vcr_abort("input_shape_invalid", field, "The residual precision TAU is positive.")
  rec$outsideMmse <- sum(rec$mmse < .VCR_BL_FITTED_MMSE[1] | rec$mmse > .VCR_BL_FITTED_MMSE[2])
  rec$madeForCurrentModel <- identical(rec$paramsetSha, set$fileSha256)
  rec$inputId <- input_id
  rec$tableSha256 <- as.character(input[["hash"]])
  rec
}

#' The people of a trial drawn from the record. The draw: n people without replacement while the record holds that many, with replacement beyond; then
#' the Weibull dropout times (the study's own dropout effect), then the scores. Arms are the first n0 and the last n1 of an exchangeable draw.
.vcr_bl_record_people <- function(set, p) {
  rec <- p$record; n <- p$n0 + p$n1
  idx <- if (n <= rec$n) sample.int(rec$n, n) else sample.int(rec$n, n, replace = TRUE)
  q <- list(mmse = rec$mmse[idx], apoe = rec$apoe[idx], age = rec$age[idx], female = rec$female[idx], eta = rec$eta[idx], alpha = rec$alpha[idx], meanSlope = rec$meanSlope[idx])
  study <- list(tau = rec$tau, omega = rec$omega)
  hazard <- .vcr_bl_hazard(p$par, q$age, q$mmse, rec$omega)
  leaves <- stats::rweibull(n, p$par[["weibullShape"]], hazard^(-1 / p$par[["weibullShape"]]))
  .vcr_bl_score_people(p, p$par, study, q, leaves, 0L)
}

# --- instantiate -----------------------------------------------------------------------------------------------------------------------------

#' The covariate columns of a generated population table, by the names the scenario maps them to (any not named are drawn from the model).
.vcr_bl_given_covariates <- function(job, spec) {
  if (is.null(spec)) return(list())
  input <- vcr_input_by_id(job, spec$inputId)
  field <- "scenario.instantiate.covariates.inputId"
  if (is.null(input) || is.null(input[["location"]])) vcr_abort("input_shape_invalid", field, "The population table the scenario names is not among the job's inputs.")
  df <- vcr_read_table_input(input)
  if (!identical(attr(df, "vcrSource"), "synthetic")) {
    vcr_abort("input_shape_invalid", field, "Patients are instantiated from a generated population only: a table of real people's rows is never turned into virtual patients.")
  }
  out <- list()
  for (k in c("mmse", "age", "apoe4", "female")) {
    col <- spec$columns[[k]]
    if (is.null(col)) next
    if (!(col %in% names(df))) vcr_abort("input_shape_invalid", sprintf("scenario.instantiate.covariates.columns.%s", k), sprintf("The population table has no column %s.", col))
    v <- suppressWarnings(as.numeric(df[[col]]))
    if (anyNA(v) || !all(is.finite(v))) vcr_abort("input_shape_invalid", sprintf("scenario.instantiate.covariates.columns.%s", k), sprintf("Column %s holds a number for every person.", col))
    out[[if (identical(k, "apoe4")) "apoe" else k]] <- if (identical(k, "apoe4")) as.integer(v) else v
  }
  out$n <- nrow(df)
  out$sourceSha256 <- as.character(input[["hash"]])
  out
}

#' The instantiate step of `patients.progression` 1.2.0: one study, n people, one table.
vcr_beta_logit_instantiate <- function(job, set, output_dir = NULL) {
  sc <- job[["scenario"]]; inst <- sc[["instantiate"]]
  population <- .vcr_bl_population(sc[["population"]])
  uncertainty <- as.character(sc[["model"]][["uncertainty"]] %||% "new_study")
  if (!(uncertainty %in% c("new_study", "typical_study"))) {
    vcr_abort("scenario_value_invalid", "scenario.model.uncertainty", "A record of people is one study's: it is made as a new study or the typical study. Make another record with another seed to see parameter uncertainty.")
  }
  cov_spec <- inst[["covariates"]]
  given <- .vcr_bl_given_covariates(job, if (is.null(cov_spec)) NULL else list(inputId = as.character(cov_spec[["inputId"]]), columns = cov_spec[["columns"]]))
  n <- as.integer(vcr_scalar(inst[["n"]], given$n %||% NA_integer_))
  if (is.na(n) || n < 2L || as.numeric(n) > .vcr_max_records()) vcr_abort("scenario_value_invalid", "scenario.instantiate.n", "The record holds at least two people and no more than this engine can hold.")
  if (!is.null(given$n) && !identical(as.integer(given$n), n)) vcr_abort("scenario_value_invalid", "scenario.instantiate.n", "A record made from a population table has that table's people: leave n out or make it the table's row count.")
  par <- vcr_beta_logit_par(set$medians, population)
  set.seed(as.integer(as.numeric(vcr_scalar(job[["seed"]], 1)) %% 2147483647), kind = VCR_RNG_KIND)
  study <- if (identical(uncertainty, "typical_study")) vcr_beta_logit_typical_study(par) else vcr_beta_logit_new_study(par)
  q <- .vcr_bl_draw_people(par, study, n, given[intersect(names(given), c("mmse", "apoe", "age", "female"))])
  df <- data.frame(USUBJID = sprintf("VP%06d", seq_len(n)), MMSE = q$mmse, AGE = q$age, APOE4 = q$apoe, FEMALE = q$female, ETA = q$eta, ALPHA = q$alpha, MEANSLOPE = q$meanSlope,
                   TAU = study[["tau"]], OMEGA = study[["omega"]], PARAMSET_SHA256 = set$fileSha256, stringsAsFactors = FALSE)
  outside <- sum(q$mmse < .VCR_BL_FITTED_MMSE[1] | q$mmse > .VCR_BL_FITTED_MMSE[2])
  unit <- as.character(set$endpoint[["unit"]])
  base <- stats::plogis(q$eta)
  measures <- list(vcr_measure("generated_records", n, source = "synthetic"),
                   vcr_measure("baseline_mean_score", mean(70 * (base + .VCR_BETA_LOGIT_GUARD) / (1 + 2 * .VCR_BETA_LOGIT_GUARD)), source = "calculated", unit = unit,
                               note = "the expected baseline score of these people, from their intercepts"))
  src <- set$source
  list(status = "succeeded", measures = measures, issues = list(), counts = vcr_counts(generatedRecords = n), conclusion = "limited",
       diagnostics = list(valueSource = "synthetic", progression = list(
         family = "beta_logit", instantiate = TRUE, people = n, uncertainty = uncertainty,
         parameterSet = list(id = set$id, version = set$version, artifact = src[["artifact"]], fileSha256 = set$fileSha256, draws = nrow(set$draws), publication = src[["publication"]]),
         study = list(tau = study[["tau"]], omega = study[["omega"]], muEta = study[["muEta"]], muAlpha = study[["muAlpha"]]),
         covariatesFrom = if (is.null(given$sourceSha256)) "model" else "population_table",
         covariatesGiven = intersect(names(given), c("mmse", "apoe", "age", "female")),
         outsideFittedMmse = outside, fittedMmse = .VCR_BL_FITTED_MMSE,
         limits = c("The record is virtual people drawn from a published model's population level; it is not any real person and it carries no individual prediction.",
                    "The individual intercept and slope are draws from the model's between-person distributions, fixed once here and read by every later run.",
                    if (outside > 0L) sprintf("%d of %d people have a baseline MMSE outside %d to %d, the entry range of the trials the model was fitted on: their results are an extrapolation.", outside, n, .VCR_BL_FITTED_MMSE[1], .VCR_BL_FITTED_MMSE[2])))),
       tables = .vcr_tables_of(list(vcr_write_table(df, "progression-people", output_dir, roundtrip_numeric = TRUE))))
}

# --- the paired mode ----------------------------------------------------------------------------------------------------------------------------

#' Scores 70 x Beta((theta + g) tau, (1 - theta + g) tau) from the uniforms (`ua`, `ub`) through the gamma quantile function: the same uniforms under
#' another theta give the coupled score of the same person. Its marginal is the ratio of two gammas of `vcr_beta_logit_scores`.
.vcr_bl_coupled_scores <- function(theta, tau, ua, ub) {
  g <- .VCR_BETA_LOGIT_GUARD
  x <- stats::qgamma(ua, (theta + g) * tau); y <- stats::qgamma(ub, (1 - theta + g) * tau)
  s <- x + y
  out <- x / s
  out[!(s > 0)] <- theta[!(s > 0)]
  70 * out
}

#' One replicate of the paired mode: every person under both arms. `p$coupling` is `common` (the same residual uniforms, the product) or
#' `independent` (a fresh set for the treated arm: the unpaired reference the cases compare it with). The rows are the statistics of the contrast
#' (treated less control) among the people still observed at the analysis visit: of the scored contrast, then of the expected (latent) one.
.vcr_bl_paired_trial <- function(set, p) {
  eff <- if (is.null(p$effects)) NULL else .vcr_bl_trial_effects(p$effects)
  if (!is.null(eff)) p$treatment <- .vcr_bl_treatment_at(p, eff)
  rec <- p$record; n <- rec$n; par <- p$par; g <- .VCR_BETA_LOGIT_GUARD
  hazard <- .vcr_bl_hazard(par, rec$age, rec$mmse, rec$omega)
  leaves <- stats::rweibull(n, par[["weibullShape"]], hazard^(-1 / par[["weibullShape"]]))
  ta <- p$visits[p$at]
  drug <- vcr_beta_logit_drug(p$treatment, ta)
  pbo <- if (isTRUE(p$placebo)) vcr_beta_logit_placebo(par, ta) else 0
  x_c <- rec$eta + rec$alpha * ta + pbo
  x_t <- x_c + drug$symptomatic - drug$fraction * rec$meanSlope * drug$onDrug
  th_c <- stats::plogis(x_c); th_t <- stats::plogis(x_t)
  ua <- stats::runif(n); ub <- stats::runif(n)
  y_c <- .vcr_bl_coupled_scores(th_c, rec$tau, ua, ub)
  y_t <- if (identical(p$coupling, "independent")) .vcr_bl_coupled_scores(th_t, rec$tau, stats::runif(n), stats::runif(n)) else .vcr_bl_coupled_scores(th_t, rec$tau, ua, ub)
  keep <- if (identical(p$dropout, "none")) rep(TRUE, n) else leaves > ta
  scored <- (y_t - y_c)[keep]
  latent <- (70 * (th_t - th_c) / (1 + 2 * g))[keep]
  stat <- function(x) if (length(x) >= 2L) c(mean(x), stats::sd(x), stats::quantile(x, c(0.1, 0.5, 0.9), names = FALSE, type = 7), mean(x < 0)) else rep(NA_real_, 6L)
  out <- c(observed = mean(keep), stat(scored), stat(latent), if (!is.null(eff)) eff[1:2])
  stats::setNames(out, c("observed", paste0("scored_", c("mean", "sd", "q10", "q50", "q90", "improved")), paste0("latent_", c("mean", "sd", "q10", "q50", "q90", "improved")),
                         if (!is.null(eff)) c("pts", "frac")))
}

.vcr_bl_paired_run <- function(set, p, want, seed, cores, cancel_file = NULL, batch = 25L, progress = NULL) {
  bank <- vcr_stream_bank(seed)
  done <- 0L; parts <- list(); stopped <- NULL
  while (done < want) {
    if (!is.null(cancel_file) && file.exists(cancel_file)) { stopped <- "canceled"; break }
    reason <- vcr_interrupt()
    if (!is.null(reason)) { stopped <- reason; break }
    take <- as.integer(min(batch, want - done))
    out <- vcr_map_streams(bank$take(take), function(i) .vcr_bl_paired_trial(set, p), cores = cores, indices = done + seq_len(take))
    parts[[length(parts) + 1L]] <- do.call(rbind, out)
    done <- done + take
    if (!is.null(progress)) progress(done, want)
  }
  list(values = if (length(parts)) do.call(rbind, parts) else NULL, done = done, stopped = stopped)
}

#' The calculated curves of the people in a record, one arm at a time: the expected score of each person is the beta's mean at their latent value,
#' so the mean over the record, its SD across people and residual, the share still observed and the change among them are sums over the record.
.vcr_bl_record_curves <- function(set, p, drug) {
  rec <- p$record; par <- p$par; times <- p$visits; g <- .VCR_BETA_LOGIT_GUARD
  hazard <- .vcr_bl_hazard(par, rec$age, rec$mmse, rec$omega)
  th0 <- stats::plogis(rec$eta); s0 <- vcr_beta_logit_score_moments(th0, rec$tau)
  arm <- function(treated) {
    rows <- lapply(seq_along(times), function(j) {
      t <- times[j]
      pbo <- if (isTRUE(p$placebo)) vcr_beta_logit_placebo(par, t) else 0
      x <- rec$eta + rec$alpha * t + pbo + if (treated) drug$symptomatic[j] - drug$fraction * rec$meanSlope * drug$onDrug[j] else 0
      st <- vcr_beta_logit_score_moments(stats::plogis(x), rec$tau)
      stay <- if (identical(p$dropout, "none")) rep(1, rec$n) else exp(-hazard * t^par[["weibullShape"]])
      d <- st$mean - s0$mean
      c(mean = mean(st$mean), sd = sqrt(max(0, mean(st$var + st$mean^2) - mean(st$mean)^2)),
        change = if (t == 0) 0 else mean(d), changeSd = if (t == 0) 0 else sqrt(max(0, mean(d^2 + st$var + s0$var) - mean(d)^2)),
        observed = mean(stay), observedChange = if (t == 0) 0 else sum(stay * d) / sum(stay))
    })
    m <- do.call(rbind, rows)
    list(times = times, mean = m[, "mean"], sd = m[, "sd"], change = m[, "change"], changeSd = m[, "changeSd"], observed = m[, "observed"], observedChange = m[, "observedChange"])
  }
  list(control = arm(FALSE), treated = arm(TRUE))
}

# --- what a run on a record says about it ---------------------------------------------------------------------------------------------------

#' The record a run read, for the result: where it came from, the study it was made in, and the people outside the fitted range.
.vcr_bl_record_report <- function(rec, mode, p) {
  list(mode = mode, inputId = rec$inputId, tableSha256 = rec$tableSha256, people = rec$n, madeForParameterSetSha256 = rec$paramsetSha, madeForCurrentModel = rec$madeForCurrentModel,
       outsideFittedMmse = rec$outsideMmse, fittedMmse = .VCR_BL_FITTED_MMSE, study = list(tau = rec$tau, omega = rec$omega),
       sampling = if (identical(mode, "resampled_trials")) (if (p$n0 + p$n1 <= rec$n) "without_replacement" else "with_replacement") else "everyone")
}

.vcr_bl_record_limits <- function(rec, p) {
  c(list("The people are a record made once from the model's population level, not real persons; the study they were made in (its mean intercept and slope, precisions and dropout effect) is fixed, so the result does not include study-to-study variation."),
    if (!isTRUE(rec$madeForCurrentModel)) list("The record was made for an earlier parameter file than this engine's: its people are still run, but their individual parameters belong to that model."),
    if (rec$outsideMmse > 0L) list(sprintf("%d of %d people have a baseline MMSE outside %d to %d, the entry range of the trials the model was fitted on: their results are an extrapolation.", rec$outsideMmse, rec$n, .VCR_BL_FITTED_MMSE[1], .VCR_BL_FITTED_MMSE[2])),
    if (identical(p$mode, "resampled_trials") && p$n0 + p$n1 > rec$n) list(sprintf("Each simulated trial needs %d people and the record holds %d, so people are drawn with replacement: the same person can appear more than once in a trial.", p$n0 + p$n1, rec$n)))
}

# --- the paired result ----------------------------------------------------------------------------------------------------------------------------

.vcr_bl_paired_result <- function(job, sc, set, p, curves, ctl, trt, want, seed, cores, cancel_file, progress, time_unit, at_time, kind, alpha) {
  rec <- p$record; unit <- as.character(set$endpoint[["unit"]])
  run <- .vcr_bl_paired_run(set, p, want, seed, cores, cancel_file, progress = progress)
  v <- run$values
  if ((is.null(v) || !nrow(v)) && identical(run$stopped, "canceled")) return(.vcr_interrupted_result("canceled", "no replicate was run"))
  if (is.null(v) || !nrow(v)) vcr_abort("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the first batch of replicates; there is no result.")
  done <- nrow(v)
  sim <- function(name, col, note, u = unit) {
    x <- v[, col]; x <- x[is.finite(x)]
    vcr_measure(name, mean(x), simulated = TRUE, mcse = if (length(x) > 1L) stats::sd(x) / sqrt(length(x)) else 0, source = "synthetic", unit = u, note = note)
  }
  scored <- "among the people still observed at the analysis visit, the treated score less the same person's control score under the same residual draws"
  latent <- "the model's expected treated score less the same person's expected control score (no residual), among the people still observed"
  measures <- list(
    sim("paired_mean_contrast", "scored_mean", paste("the mean over replicates of the mean contrast", scored)),
    sim("paired_latent_mean_contrast", "latent_mean", paste("the mean over replicates of the mean of", latent)),
    sim("paired_latent_sd", "latent_sd", paste("the mean over replicates of the SD across people of", latent)),
    sim("paired_latent_q10", "latent_q10", paste("the 10th percentile across people of", latent)), sim("paired_latent_q50", "latent_q50", paste("the median across people of", latent)),
    sim("paired_latent_q90", "latent_q90", paste("the 90th percentile across people of", latent)),
    sim("paired_share_improved", "latent_improved", "the share of the people whose expected score is lower (better) under treatment", u = NULL),
    sim("paired_observed_share", "observed", "the share of the people still observed at the analysis visit", u = NULL))
  issues <- list(); stopped <- run$stopped
  if (identical(stopped, "cpu_budget")) issues <- list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before every replicate ran; the numbers use the replicates that finished."))
  status <- if (identical(stopped, "canceled")) "canceled" else if (identical(stopped, "cpu_budget")) "failed" else "succeeded"
  reports <- if (!is.null(p$effects)) Filter(Negate(is.null), list(
    .vcr_bl_effect_report("treatment.symptomatic.pointsAt", p$effects$pointsAt, if ("pts" %in% colnames(v)) v[, "pts"] else numeric(0), rep(1, done)),
    .vcr_bl_effect_report("treatment.diseaseModifying.fraction", p$effects$fraction, if ("frac" %in% colnames(v)) v[, "frac"] else numeric(0), rep(1, done)))) else list()
  src <- set$source
  limits <- Filter(Negate(is.null), as.list(c(
    list("Model-implied, not observed: the contrast is the model's reading of what would have happened to each of these virtual people under the other arm. An individual treatment effect cannot be observed in any trial, and nothing here is one.",
         "Population level: the people are a record made from a published model's population level, not real persons, and no number is a prediction for a patient.",
         "The drug effect is the researcher's stated hypothesis, converted into the model's terms; it is not a prediction for any compound.",
         "Every person has the same individual effects, dropout time and residual draws in both arms, so the arms differ only by the drug; more replicates shrink only the Monte Carlo error of these numbers."),
    .vcr_bl_record_limits(rec, p),
    if (max(p$visits) > .VCR_BETA_LOGIT_DATA_WEEKS) list(sprintf("The last visit is week %s, beyond the two years the model's data support: that part is an extrapolation.", format(max(p$visits)))))))
  list(status = status, measures = measures, issues = issues, counts = vcr_counts(generatedRecords = done * rec$n), conclusion = "limited",
       diagnostics = list(replicatesCompleted = done, progression = list(
         family = "beta_logit", curves = curves, calculatedFor = "people_of_record", isNull = p$is_null, trials = done, trialsRequested = want, outcomeUnit = unit,
         endpoint = list(name = set$endpoint[["name"]], min = set$endpoint[["min"]], max = set$endpoint[["max"]]),
         parameterSet = list(id = set$id, version = set$version, artifact = src[["artifact"]], url = src[["url"]], archiveSha1 = src[["archiveSha1"]],
                             archiveSha256 = src[["archiveSha256"]], sourceSha256 = src[["sourceSha256"]], fileSha256 = set$fileSha256, draws = nrow(set$draws), publication = src[["publication"]]),
         uncertainty = "fixed_study", placebo = p$placebo, dropoutModel = p$dropout, analysis = list(kind = kind, visit = at_time, alpha = alpha, firstVisit = p$visits[1L]),
         treatment = list(symptomaticLogitEmax = p$treatment$emax %||% 0, et50Weeks = p$treatment$et50, washoutHalfLifeWeeks = p$treatment$halfLife,
                          diseaseModifyingFraction = p$treatment$fraction, doseBegin = p$treatment$begin, doseEnd = p$treatment$end),
         people = .vcr_bl_record_report(rec, "paired_counterfactual", p), effectDistributions = reports, modelImplied = TRUE,
         extrapolation = list(dataWeeks = .VCR_BETA_LOGIT_DATA_WEEKS, lastVisit = max(p$visits), beyond = max(p$visits) > .VCR_BETA_LOGIT_DATA_WEEKS),
         populationLevel = TRUE, limits = limits)))
}
