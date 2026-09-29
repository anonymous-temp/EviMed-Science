# ---------------------------------------------------------------------------
# engine.R — job dispatch, the manifest, and the startup self-check.
#
# Hidden knowledge:
#
# - **The method registry is checked against the domain at startup, not at
#   review time.** `@evimed/domain`'s `VCR_ENGINE_METHODS` is the authority
#   for which methods exist and at what version; this file holds the handlers.
#   If the two disagree the engine refuses to start, because the alternative
#   is a control plane queueing `comparator.rmst@1.1.0` to a build that
#   silently runs 1.0.0 and stamps the result with whatever version it was
#   asked for.
# - **The engine reads exactly the files the job names.** `inputs[].location`
#   is the only path it will open, its sha256 is verified before the bytes are
#   used, and nothing walks a directory. A snapshot whose bytes changed after
#   a tool wrote them is a `failed` result with a named reason, not a quietly
#   different number (plan 8.1, AC-26).
# - **`failed` never carries numbers.** A handler that cannot produce an
#   estimate returns issues; `measures` stays empty. Writing a 0 would pass
#   every schema and be a lie, which is why `validateEngineResult` refuses a
#   non-finite measure value rather than accepting a placeholder.
# - **The manifest is what makes the result repeatable**, so it records the
#   things that actually change an answer: engine version, R version, the
#   package lock's hash, the RNG kind, the seed, the core count (which must
#   *not* change the answer, and is recorded so that claim is checkable), the
#   scenario hash and the output hash.
# - **Parquet comes in through one 20-line Python bridge.** R's `arrow` is not
#   in the pinned library and pulling it in for one file format would be a
#   large dependency for a small job; `pyarrow` is already present for the
#   data plane. The bridge is the only place Python touches a data path and it
#   converts, it never computes.
# ---------------------------------------------------------------------------

VCR_ENGINE_SOURCE_FILES <- c(
  "protocol", "rng", "simulators", "population", "quality", "weighting", "rmst",
  "reconstruct", "maic", "evidence_pool", "map_prior", "design_analytic",
  "design_simulate", "assurance", "procova", "accrual"
)

#' Source every module in dependency order. Idempotent.
vcr_engine_load <- function(root = NULL) {
  root <- root %||% Sys.getenv("VCR_ENGINE_ROOT", unset = getwd())
  for (f in VCR_ENGINE_SOURCE_FILES) {
    path <- file.path(root, "R", paste0(f, ".R"))
    if (!file.exists(path)) path <- file.path(root, paste0(f, ".R"))
    source(path, local = FALSE)
  }
  vcr_set_engine_root(root)
  invisible(TRUE)
}

#' The handlers this build actually implements, keyed by method id.
vcr_engine_handlers <- function() list(
  "profile.snapshot" = vcr_job_profile_snapshot,
  "cohort.build" = vcr_job_build_cohort,
  "population.scenario" = vcr_job_generate_population,
  "population.literature" = vcr_job_population_literature,
  "population.synthpop" = vcr_job_synthesize_population,
  "population.quality" = vcr_job_population_quality,
  "patients.continuous" = vcr_job_generate_patients,
  "patients.binary" = vcr_job_generate_patients,
  "patients.time_to_event" = vcr_job_generate_patients,
  "evidence.pool" = vcr_job_pool_evidence,
  "evidence.reconstruct_km" = vcr_job_reconstruct_km,
  "comparator.entropy_balance" = vcr_job_weight_comparator,
  "comparator.propensity_weight" = vcr_job_weight_comparator,
  "comparator.rmst" = vcr_job_rmst,
  "comparator.maic" = vcr_job_maic,
  "comparator.evalue" = vcr_job_evalue,
  "comparator.map_prior" = vcr_job_map_prior,
  "design.analytic" = vcr_job_design_analytic,
  "design.simulate" = vcr_job_design_simulate,
  "design.grid" = vcr_job_design_grid,
  "design.assurance" = vcr_job_assurance,
  "design.procova" = vcr_job_procova,
  "accrual.poisson_gamma" = vcr_job_accrual,
  "matching.evaluate" = vcr_job_match_criteria
)

#' Startup self-check: the local registry and the domain must agree, exactly.
vcr_engine_self_check <- function() {
  d <- vcr_domain()
  local <- names(vcr_engine_handlers())
  declared <- names(d$methods)
  missing <- setdiff(declared, local)
  extra <- setdiff(local, declared)
  issues <- list()
  if (length(missing)) issues[[length(issues) + 1L]] <- vcr_issue(
    "method_not_implemented", "methods",
    sprintf("the domain declares %s but this build has no handler", paste(missing, collapse = ", ")))
  if (length(extra)) issues[[length(issues) + 1L]] <- vcr_issue(
    "method_not_declared", "methods",
    sprintf("this build implements %s, which the domain does not declare", paste(extra, collapse = ", ")))
  if (!identical(as.integer(d$protocolVersion), 1L)) issues[[length(issues) + 1L]] <- vcr_issue(
    "protocol_version_mismatch", "protocolVersion",
    sprintf("this build speaks protocol 1, the domain snapshot says %s", d$protocolVersion))
  issues
}

vcr_package_lock_path <- function() file.path(vcr_engine_root(), "R", "package-lock.json")

vcr_package_lock_hash <- function() {
  p <- vcr_package_lock_path()
  if (!file.exists(p)) return("")
  vcr_file_sha256(p)
}

vcr_engine_health <- function() {
  d <- vcr_domain()
  list(ok = length(vcr_engine_self_check()) == 0L,
       engineVersion = vcr_engine_version(),
       rVersion = paste("R", getRversion()),
       protocolVersion = d$protocolVersion,
       methods = names(vcr_engine_handlers()),
       packageLockHash = vcr_package_lock_hash(),
       rngKind = VCR_RNG_KIND,
       issues = vcr_engine_self_check())
}

# --- input handling --------------------------------------------------------

#' Read one named input. Only `inputs[].location` is ever opened, and its
#' hash is verified first.
vcr_read_input <- function(input) {
  if (is.null(input$location)) return(input$value)
  path <- input$location
  if (!file.exists(path)) stop(sprintf("input %s: file not found at the location the job named", input$id))
  if (!is.null(input$hash)) {
    got <- vcr_file_sha256(path)
    if (!identical(got, input$hash)) {
      stop(sprintf("input %s: the snapshot's bytes changed after the job was frozen (expected %s, found %s)",
                   input$id, substr(input$hash, 1, 12), substr(got, 1, 12)))
    }
  }
  ext <- tolower(tools::file_ext(path))
  if (ext %in% c("csv", "tsv")) {
    return(utils::read.csv(path, sep = if (ext == "tsv") "\t" else ",", stringsAsFactors = FALSE))
  }
  if (ext == "json") return(jsonlite::fromJSON(path, simplifyDataFrame = TRUE))
  if (ext %in% c("parquet", "pq")) return(vcr_read_parquet(path))
  stop(sprintf("input %s: unsupported format .%s", input$id, ext))
}

#' Parquet via the Python bridge. The bridge converts; it never computes.
vcr_read_parquet <- function(path) {
  bridge <- file.path(vcr_engine_root(), "service", "parquet_bridge.py")
  tmp <- tempfile(fileext = ".csv")
  on.exit(unlink(tmp), add = TRUE)
  status <- system2(Sys.getenv("VCR_PYTHON", "python3"), c(shQuote(bridge), shQuote(path), shQuote(tmp)),
                    stdout = TRUE, stderr = TRUE)
  if (!file.exists(tmp)) stop("vcr_read_parquet: bridge failed: ", paste(status, collapse = " "))
  utils::read.csv(tmp, stringsAsFactors = FALSE)
}

vcr_input_by_kind <- function(job, kind) {
  for (input in job$inputs) if (identical(input$kind, kind)) return(input)
  NULL
}

vcr_input_by_id <- function(job, id) {
  for (input in job$inputs) if (identical(input$id, id)) return(input)
  NULL
}

# --- the run ---------------------------------------------------------------

#' Run a job end to end and return a protocol-valid result.
vcr_run_job <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  started <- format(as.POSIXct(Sys.time(), tz = "UTC"), "%Y-%m-%dT%H:%M:%OS3Z")
  cpu0 <- sum(proc.time()[c("user.self", "sys.self", "user.child", "sys.child")], na.rm = TRUE)
  hash <- tryCatch(vcr_scenario_hash(job$scenario), error = function(e) strrep("0", 64))

  finish <- function(status, measures = list(), counts = NULL, diagnostics = list(),
                     tables = list(), rule = NULL, issues = list()) {
    cpu <- sum(proc.time()[c("user.self", "sys.self", "user.child", "sys.child")], na.rm = TRUE) - cpu0
    result <- list(
      jobId = job$jobId, protocolVersion = 1L, status = status,
      method = job$method, methodVersion = job$methodVersion %||% vcr_domain()$methods[[job$method]]$version,
      scenarioHash = hash, seed = job$seed,
      # The *actual* replicate count, which is the requested one raised to
      # whatever the precision floor demanded (AC-28). Echoing the job's own
      # number here would make a result that ran 5,000 replicates claim 3,000,
      # and the MCSE on its measures would contradict it.
      replicates = diagnostics$replicatesCompleted %||% job$replicates,
      notEstimableRule = rule,
      counts = counts %||% vcr_counts(),
      measures = measures,
      diagnostics = c(diagnostics, if (length(issues)) list(issues = issues) else NULL),
      tables = tables,
      manifest = list(
        engineVersion = vcr_engine_version(),
        rVersion = paste("R", getRversion()),
        packageLockHash = vcr_package_lock_hash(),
        startedAt = started,
        finishedAt = format(as.POSIXct(Sys.time(), tz = "UTC"), "%Y-%m-%dT%H:%M:%OS3Z"),
        cpuSeconds = round(cpu, 3),
        rngKind = VCR_RNG_KIND,
        cores = vcr_cores(job$cores),
        platform = R.version$platform,
        inputHashes = lapply(job$inputs %||% list(), function(i) list(id = i$id, kind = i$kind, hash = i$hash))
      )
    )
    if (length(tables)) {
      result$manifest$outputHash <- vcr_sha256(paste(vapply(tables, function(t) t$sha256, character(1)), collapse = ""))
    }
    result
  }

  issues <- vcr_validate_job(job)
  if (length(issues)) return(finish("failed", issues = issues))
  self <- vcr_engine_self_check()
  if (length(self)) return(finish("failed", issues = self))

  handler <- vcr_engine_handlers()[[job$method]]
  if (is.null(handler)) return(finish("failed", issues = list(vcr_issue(
    "method_not_implemented", "method", sprintf("no handler for %s", job$method)))))

  out <- tryCatch(
    handler(job, output_dir = output_dir, cancel_file = cancel_file, progress = progress),
    error = function(e) list(status = "failed", issues = list(vcr_issue(
      "handler_error", "method", conditionMessage(e)))))

  result <- finish(out$status %||% "succeeded", out$measures %||% list(), out$counts,
                   out$diagnostics %||% list(), out$tables %||% list(),
                   out$notEstimableRule, out$issues %||% list())
  problems <- vcr_validate_result(result)
  if (length(problems)) {
    # A result this build cannot validate is a failure of this build, and
    # saying so here is cheaper than a 422 from the control plane.
    result$status <- "failed"
    result$measures <- list()
    result$diagnostics$resultValidationIssues <- problems
  }
  result
}

#' Write a table and return its manifest row.
vcr_write_table <- function(df, name, output_dir) {
  if (is.null(output_dir)) return(NULL)
  dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)
  path <- file.path(output_dir, paste0(name, ".csv"))
  utils::write.csv(df, path, row.names = FALSE, na = "")
  list(name = name, location = path, sha256 = vcr_file_sha256(path), rows = nrow(df))
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# ---------------------------------------------------------------------------
# Handlers. One per method id; each returns
#   list(status, measures, counts, diagnostics, tables, notEstimableRule, issues)
# and never a number it could not compute.
# ---------------------------------------------------------------------------

#' Profile a snapshot: column summaries with small cells suppressed, so the
#' answer can be shown to a model without a row ever leaving the data plane
#' (plan 8.1; AC-26).
vcr_job_profile_snapshot <- function(job, output_dir = NULL, ...) {
  input <- vcr_input_by_kind(job, "snapshot")
  df <- vcr_read_input(input)
  min_cell <- vcr_domain()$limits$minCellSize
  cols <- lapply(names(df), function(v) {
    x <- df[[v]]
    base <- list(column = v, missing = sum(is.na(x)), missingRate = mean(is.na(x)),
                 distinct = length(unique(stats::na.omit(x))))
    if (is.numeric(x) && base$distinct > min_cell) {
      q <- stats::quantile(x, c(0.05, 0.25, 0.5, 0.75, 0.95), na.rm = TRUE, names = FALSE)
      c(base, list(kind = "numeric", mean = mean(x, na.rm = TRUE), sd = stats::sd(x, na.rm = TRUE),
                   p05 = q[1], p25 = q[2], median = q[3], p75 = q[4], p95 = q[5]))
    } else {
      tab <- sort(table(as.character(x)), decreasing = TRUE)
      keep <- tab[tab >= min_cell]
      c(base, list(kind = "categorical",
                   levels = as.list(stats::setNames(as.numeric(keep), names(keep))),
                   suppressedLevels = length(tab) - length(keep),
                   suppressedCount = sum(tab) - sum(keep)))
    }
  })
  tables <- Filter(Negate(is.null), list(vcr_write_table(
    data.frame(column = names(df), missingRate = vapply(df, function(x) mean(is.na(x)), numeric(1))),
    "snapshot-missingness", output_dir)))
  list(status = "succeeded",
       measures = list(vcr_measure("rows", nrow(df)), vcr_measure("columns", ncol(df))),
       counts = vcr_counts(realPatients = nrow(df)),
       diagnostics = list(columns = cols, minimumCellSize = min_cell,
                          qualityCategories = vcr_domain()$qualityCategories),
       tables = tables)
}

#' Build a cohort: named inclusion rules evaluated in order, each producing
#' kept / excluded / indeterminate. "Cannot tell" is its own column and is
#' never folded into "excluded" (plan 5.1).
vcr_job_build_cohort <- function(job, output_dir = NULL, ...) {
  df <- vcr_read_input(vcr_input_by_kind(job, "snapshot"))
  rules <- job$scenario$rules %||% list()
  alive <- rep(TRUE, nrow(df))
  steps <- list()
  for (r in rules) {
    v <- tryCatch(eval(parse(text = r$expression), envir = df), error = function(e) rep(NA, nrow(df)))
    keep <- alive & !is.na(v) & v
    drop <- alive & !is.na(v) & !v
    unknown <- alive & is.na(v)
    steps[[length(steps) + 1L]] <- list(rule = r$name, kept = sum(keep), excluded = sum(drop),
                                        indeterminate = sum(unknown),
                                        indeterminateTreatment = r$unknownAs %||% "exclude")
    alive <- if (identical(r$unknownAs %||% "exclude", "include")) (keep | unknown) else keep
  }
  wf <- do.call(rbind, lapply(steps, as.data.frame))
  list(status = "succeeded",
       measures = list(vcr_measure("cohort_size", sum(alive))),
       counts = vcr_counts(realPatients = sum(alive)),
       diagnostics = list(waterfall = steps, startingRows = nrow(df)),
       tables = Filter(Negate(is.null), list(vcr_write_table(wf, "cohort-waterfall", output_dir))))
}

vcr_job_generate_population <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  set.seed(job$seed, kind = VCR_RNG_KIND)
  pop <- vcr_population_scenario(sc$population, sc$n %||% 1000L, sc$parameterDraws %||% 1L)
  viol <- sum(pop$constraintViolations$violations)
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", pop$n),
                       vcr_measure("constraint_violations", viol)),
       counts = pop$counts,
       diagnostics = list(kind = pop$kind, parameterDraws = pop$parameterDraws,
                          copulaRepaired = pop$copulaRepaired,
                          constraintViolations = pop$constraintViolations,
                          valueSource = pop$valueSource, modelTier = pop$modelTier),
       tables = Filter(Negate(is.null), list(vcr_write_table(pop$data, "population", output_dir))))
}

vcr_job_population_literature <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  set.seed(job$seed, kind = VCR_RNG_KIND)
  tbl <- as.data.frame(sc$baselineTable)
  for (col in c("mean", "sd", "proportion", "min", "max")) if (is.null(tbl[[col]])) tbl[[col]] <- NA_real_
  pop <- vcr_population_literature(tbl, sc$n %||% 1000L, sc$correlation,
                                   sc$correlationSource %||% "assumed", sc$parameterDraws %||% 1L)
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", pop$n)),
       counts = pop$counts,
       diagnostics = list(kind = pop$kind, applicability = pop$applicability,
                          correlationSource = pop$correlationSource, modelTier = pop$modelTier),
       tables = Filter(Negate(is.null), list(vcr_write_table(pop$data, "population", output_dir))))
}

vcr_job_synthesize_population <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  df <- vcr_read_input(vcr_input_by_kind(job, "snapshot"))
  holdout_share <- sc$holdoutShare %||% 0.2
  set.seed(job$seed, kind = VCR_RNG_KIND)
  idx <- sample.int(nrow(df))
  n_hold <- floor(nrow(df) * holdout_share)
  holdout <- df[idx[seq_len(n_hold)], , drop = FALSE]
  train <- df[idx[-seq_len(n_hold)], , drop = FALSE]
  syn <- vcr_population_synthpop(train, m = sc$m %||% 5L, seed = job$seed)
  report <- vcr_quality_report(train, syn$data[[1]], holdout,
                               constraints = sc$constraints,
                               criteria = sc$criteria,
                               generator = list(family = "synthpop_cart", m = syn$m,
                                                smoothing = syn$smoothing, seed = job$seed))
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", syn$generatedRecords),
                       vcr_measure("training_observations", syn$trainingObservations),
                       vcr_measure("synthetic_copies", syn$m)),
       counts = vcr_counts(realPatients = 0, generatedRecords = syn$generatedRecords),
       diagnostics = list(quality = report, lowSampleWarning = syn$lowSampleWarning,
                          inferenceLabel = syn$inferenceLabel, holdoutRows = nrow(holdout),
                          valueSource = "synthetic",
                          allowedUses = vcr_domain()$syntheticUses),
       tables = Filter(Negate(is.null), list(vcr_write_table(syn$data[[1]], "synthetic-population", output_dir))))
}

vcr_job_population_quality <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  train <- vcr_read_input(vcr_input_by_id(job, sc$trainingInputId))
  synth <- vcr_read_input(vcr_input_by_id(job, sc$syntheticInputId))
  holdout <- if (!is.null(sc$holdoutInputId)) vcr_read_input(vcr_input_by_id(job, sc$holdoutInputId)) else NULL
  report <- vcr_quality_report(train, synth, holdout, constraints = sc$constraints,
                               criteria = sc$criteria, generator = sc$generator %||% list())
  list(status = "succeeded",
       measures = list(vcr_measure("s_pmse", report$fidelity$global$sPMSE %||% NA_real_),
                       vcr_measure("propensity_auc", report$fidelity$global$propensityAuc %||% NA_real_)),
       counts = vcr_counts(realPatients = 0, generatedRecords = nrow(synth)),
       diagnostics = list(quality = report),
       tables = Filter(Negate(is.null), list(
         vcr_write_table(report$fidelity$univariate, "fidelity-univariate", output_dir),
         vcr_write_table(report$fidelity$pairwise, "fidelity-pairwise", output_dir))))
}

#' Virtual patients: draw from the reference simulator the endpoint names.
vcr_job_generate_patients <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  set.seed(job$seed, kind = VCR_RNG_KIND)
  n1 <- sc$design$nTreat %||% 0; n0 <- sc$design$nControl %||% 0
  endpoint <- sc$endpoint$type
  d <- if (identical(endpoint, "continuous")) {
    vcr_sim_continuous(n1, n0, sc$truth$effect %||% 0, sc$truth$sd %||% 1, sc$truth$baselineCorrelation %||% 0)
  } else if (identical(endpoint, "binary")) {
    vcr_sim_binary(n1, n0, sc$truth$controlRate, p_treat = sc$truth$treatmentRate)
  } else {
    dist <- sc$truth$controlDistribution %||% vcr_dist_exponential_from_median(sc$truth$controlMedian)
    vcr_sim_tte(n1, n0, dist, sc$truth$hazardRatio %||% 1,
                sc$accrual %||% list(kind = "uniform", duration = 0),
                sc$accrual$followup %||% Inf, sc$accrual$dropoutAnnual %||% 0)
  }
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", nrow(d))),
       counts = vcr_counts(realPatients = 0, generatedRecords = nrow(d),
                           events = if ("status" %in% names(d)) sum(d$status) else NULL),
       diagnostics = list(endpoint = endpoint, valueSource = "synthetic", modelTier = "scenario",
                          twinLabel = "baseline_conditioned_prediction"),
       tables = Filter(Negate(is.null), list(vcr_write_table(d, "virtual-patients", output_dir))))
}

#' Pool published studies into one assumption card (plan 6.2 step 4).
#'
#' Hidden knowledge about the *shape* of this result: `vcrEvidence.mjs`'s
#' `readPoolResult` reads five measures by name -- `pooled`, `prediction`,
#' `i_squared`, `tau_squared`, `k` -- and refuses with
#' `prediction_interval_missing` rather than falling back to the confidence
#' interval. That refusal is correct and this handler must not defeat it: when
#' k < 3 there is no Higgins-Thompson-Spiegelhalter prediction interval at all,
#' so the `prediction` measure is *absent*, not filled in with the confidence
#' interval. A simulation seeded from a confidence interval understates the
#' spread of a future trial by sqrt(1 + var/tau^2), and it does so invisibly.
vcr_job_pool_evidence <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  s <- sc$studies
  yi <- vapply(s, function(x) as.numeric(x$estimate), numeric(1))
  vi <- vapply(s, function(x) as.numeric(x$se)^2, numeric(1))
  method <- sc$method %||% "random_effects_dl"
  if (!(method %in% vcr_domain()$poolingMethods)) {
    return(list(status = "failed", issues = list(vcr_issue(
      "pooling_method_unknown", "scenario.method",
      sprintf("unknown pooling method %s", method)))))
  }
  pool <- vcr_pool(yi, vi, method, sc$level %||% 0.95)
  # The analysis scale decides which distribution a simulation can draw from:
  # proportions are pooled on the logit and handed back as a Beta, times and
  # ratios are pooled on the log and handed back as a lognormal.
  scale <- sc$scale %||% "identity"
  family <- switch(scale, logit = "beta", log = "lognormal", "normal")
  dist <- vcr_pool_to_distribution(pool, family)
  measures <- list(
    vcr_measure("pooled", pool$estimate,
                interval = vcr_interval("confidence", pool$interval[1], pool$interval[2], pool$level)),
    vcr_measure("i_squared", pool$i2),
    vcr_measure("tau_squared", pool$tau2),
    vcr_measure("tau", pool$tau),
    vcr_measure("k", pool$k))
  if (is.finite(pool$predictionInterval[1]) && is.finite(pool$predictionInterval[2])) {
    measures <- append(measures, list(vcr_measure(
      "prediction", pool$estimate,
      interval = vcr_interval("prediction", pool$predictionInterval[1], pool$predictionInterval[2], pool$level))),
      after = 1L)
  }
  list(status = "succeeded", measures = measures,
       counts = vcr_counts(realPatients = NULL, generatedRecords = 0),
       diagnostics = list(
         scale = scale, poolingMethod = method,
         k = pool$k, i2 = pool$i2, tau2 = pool$tau2,
         predictionDf = pool$predictionDf,
         predictionIntervalAvailable = is.finite(pool$predictionInterval[1]),
         predictionIntervalReason = if (is.finite(pool$predictionInterval[1])) NULL
           else "a Higgins-Thompson-Spiegelhalter prediction interval needs at least three studies (t on k - 2 df)",
         heterogeneity = list(Q = pool$Q, df = pool$df, pQ = pool$pQ, h2 = pool$h2),
         distribution = dist, weights = pool$weights))
}

vcr_job_reconstruct_km <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  curve <- as.data.frame(sc$curve)
  risk <- as.data.frame(sc$riskTable)
  recon <- vcr_guyot(curve$time, curve$surv, risk$time, risk$atRisk,
                     total_events = sc$totalEvents %||% NA_real_)
  log_hr_recon <- NA_real_
  qc <- vcr_reconstruction_qc(recon, risk$time, risk$atRisk,
                              total_events_reported = sc$totalEvents %||% NA_real_,
                              median_reported = sc$reportedMedian %||% NA_real_,
                              log_hr_reported = sc$reportedLogHazardRatio %||% NA_real_,
                              log_hr_recon = log_hr_recon,
                              tolerance = sc$tolerance %||% list())
  if (!qc$pass) {
    return(list(status = "not_estimable", notEstimableRule = "reconstruction_failed_qc",
                measures = list(),
                counts = vcr_counts(realPatients = 0, reconstructedPseudoPatients = nrow(recon$ipd)),
                diagnostics = list(qualityControl = qc, lowConfidence = is.null(sc$riskTable))))
  }
  km <- vcr_km(recon$ipd$time, recon$ipd$status)
  list(status = "succeeded",
       measures = list(
         vcr_measure("median_survival", vcr_km_median(km)),
         vcr_measure("events", sum(recon$ipd$status))),
       counts = vcr_counts(realPatients = 0, events = sum(recon$ipd$status),
                           reconstructedPseudoPatients = nrow(recon$ipd)),
       diagnostics = list(qualityControl = qc, valueSource = "reconstructed",
                          note = "Reconstructed pseudo-individuals are never counted as observed patients (AC-27)."),
       tables = Filter(Negate(is.null), list(vcr_write_table(recon$ipd, "reconstructed-ipd", output_dir))))
}

#' The external-control weighting job: balance, diagnostics, effect and a
#' whole-pipeline bootstrap. Refuses with a named rule rather than reporting a
#' number it cannot stand behind (AC-07).
vcr_job_weight_comparator <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  df <- vcr_read_input(vcr_input_by_kind(job, "snapshot"))
  covs <- sc$covariates
  treat <- df[[sc$treatmentColumn %||% "arm"]]
  X <- as.matrix(df[, covs, drop = FALSE])
  method <- if (identical(job$method, "comparator.propensity_weight")) "propensity" else "entropy_balance"

  fit <- if (identical(method, "entropy_balance")) {
    vcr_att_entropy_weights(X, treat, moments = sc$moments %||% 1L)
  } else {
    p <- vcr_propensity_weights(X, treat, sc$estimand %||% "ATT")
    list(allWeights = p$weights, converged = TRUE, propensity = p$propensity, rule = NULL)
  }
  if (is.null(fit$allWeights)) {
    return(list(status = "not_estimable", notEstimableRule = fit$rule %||% "entropy_balance_infeasible",
                measures = list(),
                counts = vcr_counts(realPatients = nrow(df)),
                diagnostics = list(detail = fit$detail, method = method)))
  }
  w <- fit$allWeights
  balance <- vcr_balance_table(X, treat, w, sc$estimand %||% "ATT")
  ps <- vcr_propensity_weights(X, treat, "ATT")$propensity
  support <- vcr_common_support(ps, treat)
  ess <- vcr_ess(w[treat == 0L])
  rule <- vcr_not_estimable_weighting(balance = balance, ess = ess, ess_floor = sc$essFloor,
                                      support = support, support_ceiling = sc$supportCeiling %||% 0.1,
                                      ebal = if (identical(method, "entropy_balance")) fit else NULL)
  if (!is.null(rule)) {
    return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(),
                counts = vcr_counts(realPatients = nrow(df),
                                    effectiveSampleSize = ess),
                diagnostics = list(detail = rule$detail, balance = balance, support = support,
                                   weights = vcr_weight_diagnostics(w, treat))))
  }
  y <- df[[sc$outcomeColumn %||% "y"]]
  est <- stats::weighted.mean(y[treat == 1L], w[treat == 1L]) - stats::weighted.mean(y[treat == 0L], w[treat == 0L])
  boot <- vcr_bootstrap_pipeline(nrow(df), function(idx) {
    Xb <- X[idx, , drop = FALSE]; tb <- treat[idx]; yb <- y[idx]
    f <- if (identical(method, "entropy_balance")) vcr_att_entropy_weights(Xb, tb, sc$moments %||% 1L)
         else list(allWeights = vcr_propensity_weights(Xb, tb, sc$estimand %||% "ATT")$weights)
    if (is.null(f$allWeights)) return(NA_real_)
    wb <- f$allWeights
    stats::weighted.mean(yb[tb == 1L], wb[tb == 1L]) - stats::weighted.mean(yb[tb == 0L], wb[tb == 0L])
  }, replicates = sc$bootstrapReplicates %||% vcr_domain()$limits$bootstrapMin,
     seed = job$seed, strata = treat, cores = vcr_cores(job$cores))
  list(status = "succeeded",
       measures = list(
         vcr_measure("weighted_difference", est,
                     interval = vcr_interval("confidence", boot$interval[1], boot$interval[2])),
         vcr_measure("effective_sample_size", ess),
         vcr_measure("worst_standardized_difference", max(abs(balance$smdAdjusted)))),
       counts = vcr_counts(realPatients = nrow(df), effectiveSampleSize = ess),
       diagnostics = list(method = method, estimand = sc$estimand %||% vcr_domain()$defaultEstimand,
                          balance = balance, support = support,
                          weights = vcr_weight_diagnostics(w, treat),
                          bootstrapFailureShare = boot$failureShare,
                          conclusion = if (boot$failureShare > 0.01) "limited" else "estimable",
                          comparabilityDimensions = vcr_domain()$comparabilityDimensions),
       tables = Filter(Negate(is.null), list(vcr_write_table(balance, "balance", output_dir))))
}

vcr_job_rmst <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  df <- vcr_read_input(vcr_input_by_kind(job, "snapshot"))
  tau <- sc$tau
  arm <- df[[sc$treatmentColumn %||% "arm"]]
  w <- if (!is.null(sc$weightColumn)) df[[sc$weightColumn]] else NULL
  rule <- vcr_tau_rule(df$time, df$status, arm, tau)
  if (!is.null(rule)) {
    return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(),
                counts = vcr_counts(realPatients = nrow(df), events = sum(df$status)),
                diagnostics = rule))
  }
  r <- vcr_rmst_difference(df$time, df$status, arm, tau, w)
  list(status = "succeeded",
       measures = list(
         vcr_measure("rmst_difference", r$estimate, unit = sc$timeUnit %||% "months",
                     interval = vcr_interval("confidence", r$interval[1], r$interval[2])),
         vcr_measure("rmst_treatment", r$arm1), vcr_measure("rmst_control", r$arm0),
         vcr_measure("survival_difference_at_tau", as.numeric(r$survivalAtTau[1] - r$survivalAtTau[2]))),
       counts = vcr_counts(realPatients = nrow(df), events = sum(df$status),
                           effectiveSampleSize = if (!is.null(w)) vcr_ess(w[arm == 0L]) else NULL),
       diagnostics = list(tau = tau, survivalAtTau = r$survivalAtTau, weighted = !is.null(w)))
}

vcr_job_maic <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  df <- vcr_read_input(vcr_input_by_kind(job, "snapshot") %||% vcr_input_by_kind(job, "population"))
  X <- as.matrix(df[, sc$covariates, drop = FALSE])
  targets <- unlist(sc$targets)
  res <- if (isTRUE(sc$anchored)) {
    vcr_maic_anchored(df, X, targets, sc$aggregateEstimate, sc$aggregateSe, sc$link %||% "identity")
  } else {
    vcr_maic_unanchored(df[[sc$outcomeColumn %||% "y"]], X, targets,
                        sc$aggregateOutcome, sc$aggregateSe, sc$link %||% "identity")
  }
  if (is.null(res$estimate)) {
    return(list(status = "not_estimable", notEstimableRule = res$rule %||% "entropy_balance_infeasible",
                measures = list(), counts = vcr_counts(realPatients = nrow(df)),
                diagnostics = list(detail = res$detail)))
  }
  list(status = "succeeded",
       measures = list(
         vcr_measure("indirect_estimate", res$estimate,
                     interval = vcr_interval("confidence", res$interval[1], res$interval[2])),
         vcr_measure("effective_sample_size", res$effectiveSampleSize)),
       counts = vcr_counts(realPatients = nrow(df), effectiveSampleSize = res$effectiveSampleSize),
       diagnostics = list(anchored = res$anchored, targetPopulation = res$targetPopulation,
                          conclusionCeiling = res$conclusionCeiling %||% NULL,
                          unadjustedEffectModifiers = sc$unadjustedEffectModifiers %||% list()))
}

vcr_job_evalue <- function(job, ...) {
  sc <- job$scenario
  rr <- sc$riskRatio
  ev <- function(r) { r <- if (r < 1) 1 / r else r; r + sqrt(r * (r - 1)) }
  point <- ev(rr)
  bound <- if (!is.null(sc$confidenceLimit)) {
    cl <- sc$confidenceLimit
    if ((rr > 1 && cl <= 1) || (rr < 1 && cl >= 1)) 1 else ev(cl)
  } else NULL
  measures <- list(vcr_measure("e_value", point))
  if (!is.null(bound)) measures[[2]] <- vcr_measure("e_value_confidence_limit", bound)
  list(status = "succeeded", measures = measures, counts = vcr_counts(),
       diagnostics = list(scale = sc$scale %||% "risk_ratio",
                          note = "An E-value is what an unmeasured confounder would have to be, not evidence that none exists."))
}

vcr_job_map_prior <- function(job, ...) {
  sc <- job$scenario
  hist <- sc$historical
  if (!is.null(hist$events)) {
    e <- as.numeric(hist$events); n <- as.numeric(hist$n)
    y <- stats::qlogis((e + 0.5) / (n + 1)); se <- sqrt(1 / (e + 0.5) + 1 / (n - e + 0.5))
    unit_var <- vcr_logit_unit_variance(sum(e) / sum(n))
  } else {
    y <- as.numeric(hist$estimate); se <- as.numeric(hist$se); unit_var <- sc$unitVariance %||% 1
  }
  map <- vcr_map_prior(y, se, sc$tauPrior %||% list(kind = "half_normal", scale = 0.5))
  mix <- vcr_map_normal_mixture(map, sc$components %||% 2L)
  robust <- vcr_robustify(mix, sc$robustWeight %||% 0.2, unit_information_sd = sqrt(unit_var))
  ess_map <- vcr_prior_ess(mix, unit_var)
  ess_rob <- vcr_prior_ess(robust, unit_var)
  ceiling_ <- vcr_ess_ceiling(map$tauPosteriorMedian, unit_var)
  conflict <- if (!is.null(sc$current)) vcr_map_conflict(robust, sc$current$estimate, sc$current$se,
                                                         sc$conflictBound %||% 0.01) else NULL
  if (!is.null(conflict) && !is.null(conflict$rule)) {
    return(list(status = "not_estimable", notEstimableRule = conflict$rule, measures = list(),
                counts = vcr_counts(priorEffectiveSampleSize = ess_rob),
                diagnostics = list(conflict = conflict, tau = map$tauPosteriorMedian)))
  }
  list(status = "succeeded",
       measures = list(
         vcr_measure("map_mean", map$mean),
         vcr_measure("map_sd", map$sd),
         vcr_measure("prior_effective_sample_size", ess_rob),
         vcr_measure("prior_effective_sample_size_ceiling", ceiling_),
         vcr_measure("tau_posterior_median", map$tauPosteriorMedian)),
       counts = vcr_counts(priorEffectiveSampleSize = ess_rob),
       diagnostics = list(mixture = mix, robustMixture = robust, robustWeight = sc$robustWeight %||% 0.2,
                          essMapOnly = ess_map, conflict = conflict, k = map$k,
                          note = "Under strict type-I control, borrowing does not buy power (Kopp-Schneider 2020)."))
}

vcr_job_design_analytic <- function(job, ...) {
  sc <- job$scenario
  d <- sc$design; e <- sc$endpoint$type
  alpha <- sc$analysis$alpha %||% 0.025; power <- sc$analysis$power %||% 0.9
  sided <- sc$analysis$sided %||% 1
  alloc <- d$allocation %||% 0.5
  measures <- list(); diag <- list()
  if (identical(d$kind, "group_sequential")) {
    gs <- vcr_group_sequential(d$informationRates, alpha, d$spending %||% "obrien_fleming")
    for (k in seq_along(gs$criticalValues)) {
      measures[[length(measures) + 1L]] <- vcr_measure(sprintf("boundary_%d", k), gs$criticalValues[k])
      measures[[length(measures) + 1L]] <- vcr_measure(sprintf("cumulative_alpha_%d", k), gs$cumulativeAlphaSpent[k])
    }
    diag$inflationFactor <- vcr_gs_inflation(gs, power)
    diag$informationRates <- gs$informationRates
    diag$spending <- gs$spending
  }
  if (identical(e, "time_to_event")) {
    ev <- vcr_events_schoenfeld(sc$truth$hazardRatio, alpha, power, alloc, sided)
    measures[[length(measures) + 1L]] <- vcr_measure("required_events", ceiling(ev))
    measures[[length(measures) + 1L]] <- vcr_measure("required_events_exact", ev)
    if (!is.null(sc$accrual)) {
      lam <- (sc$truth$controlDistribution$rate %||% (log(2) / sc$truth$controlMedian))
      p_ev <- vcr_event_probability(lam, sc$accrual$duration, sc$accrual$followup,
                                    sc$accrual$dropoutRate %||% 0)
      measures[[length(measures) + 1L]] <- vcr_measure("event_probability", p_ev)
      measures[[length(measures) + 1L]] <- vcr_measure("required_patients", ceiling(ev / p_ev))
    }
  } else if (identical(e, "continuous")) {
    n <- vcr_n_means(sc$truth$effect, sc$truth$sd %||% 1, alpha, power, alloc, sided)
    measures[[length(measures) + 1L]] <- vcr_measure("required_total", ceiling(n$total))
    measures[[length(measures) + 1L]] <- vcr_measure("required_per_arm", ceiling(n$total * alloc))
  } else if (identical(e, "binary")) {
    p0 <- sc$truth$controlRate; p1 <- sc$truth$treatmentRate %||% (p0 + sc$truth$riskDifference)
    n <- vcr_n_proportions(p0, p1, alpha, power, alloc, sided)
    measures[[length(measures) + 1L]] <- vcr_measure("required_total", ceiling(n$total))
    measures[[length(measures) + 1L]] <- vcr_measure("required_control", ceiling(n$control))
  }
  if (identical(d$kind, "simon_two_stage")) {
    s <- vcr_simon_two_stage(sc$truth$nullRate, sc$truth$alternativeRate,
                             alpha = sc$analysis$alpha %||% 0.05, beta = 1 - power,
                             n_max = d$maxN %||% 100L)
    diag$simon <- s
    if (!is.null(s$optimal)) {
      measures[[length(measures) + 1L]] <- vcr_measure("simon_optimal_n", s$optimal$n)
      measures[[length(measures) + 1L]] <- vcr_measure("simon_optimal_n1", s$optimal$n1)
      measures[[length(measures) + 1L]] <- vcr_measure("simon_optimal_expected_n", s$optimal$EN0)
    }
  }
  list(status = "succeeded", measures = measures, counts = vcr_counts(), diagnostics = diag)
}

vcr_job_design_simulate <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  cp <- if (is.null(output_dir)) NULL else file.path(output_dir, "checkpoint.rds")
  if (!is.null(output_dir)) dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)
  res <- vcr_run_simulation(job$scenario, job$seed, job$replicates, vcr_cores(job$cores),
                            checkpoint = cp, cancel_file = cancel_file,
                            batch_size = job$batchSize %||% 500L, progress = progress,
                            cpu_seconds_limit = job$cpuSecondsLimit %||% Inf)
  check <- vcr_analytic_check(job$scenario, res$measures)
  tables <- if (!is.null(output_dir) && !is.null(res$values)) {
    Filter(Negate(is.null), list(vcr_write_table(as.data.frame(res$values), "replicates", output_dir)))
  } else list()
  # A finished run's checkpoint is dead weight: it holds a copy of every
  # replicate and the directory is what gets shipped.
  if (!is.null(cp) && file.exists(cp) && identical(res$status, "succeeded")) unlink(cp)
  list(status = res$status, measures = res$measures,
       counts = vcr_counts(realPatients = 0,
                           generatedRecords = res$diagnostics$replicatesCompleted *
                             ((job$scenario$design$nTreat %||% 0) + (job$scenario$design$nControl %||% 0))),
       diagnostics = c(res$diagnostics, list(analyticCheck = check)),
       tables = tables)
}

vcr_job_design_grid <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  sc <- job$scenario
  cells <- vcr_design_grid(sc, sc$designs, sc$truths, job$seed, job$replicates,
                           vcr_cores(job$cores), cancel_file,
                           checkpoint_dir = output_dir, progress = progress)
  rows <- do.call(rbind, lapply(cells, function(c_) {
    vals <- stats::setNames(vapply(c_$measures, function(m) m$value, numeric(1)),
                            vapply(c_$measures, function(m) m$name, character(1)))
    data.frame(designIndex = c_$designIndex, truthIndex = c_$truthIndex,
               t(as.data.frame(as.list(vals))), status = c_$status, check.names = FALSE)
  }))
  list(status = if (any(vapply(cells, function(c_) identical(c_$status, "canceled"), logical(1)))) "canceled" else "succeeded",
       measures = list(vcr_measure("cells", length(cells))),
       counts = vcr_counts(),
       diagnostics = list(cells = lapply(cells, function(c_) c_[c("designIndex", "truthIndex", "seed", "scenarioHash", "status")])),
       tables = Filter(Negate(is.null), list(vcr_write_table(rows, "operating-characteristics", output_dir))))
}

vcr_job_assurance <- function(job, ...) {
  sc <- job$scenario
  prior <- sc$designPrior
  out <- if (identical(sc$endpoint$type, "time_to_event")) {
    vcr_assurance_loghr(prior$mean, prior$sd, sc$design$events, sc$analysis$alpha %||% 0.025,
                        sc$design$allocation %||% 0.5)
  } else {
    vcr_assurance_means(prior$mean, prior$sd, sc$truth$sd %||% 1,
                        sc$design$nTreat, sc$design$nControl %||% sc$design$nTreat,
                        sc$analysis$alpha %||% 0.025)
  }
  list(status = "succeeded",
       measures = list(vcr_measure("assurance", out$assurance),
                       vcr_measure("power_at_prior_mean", out$power)),
       counts = vcr_counts(),
       diagnostics = list(designPrior = prior,
                          note = "Assurance integrates power over the design prior; it is not a trial-success prediction score."))
}

vcr_job_procova <- function(job, ...) {
  sc <- job$scenario
  paths <- vcr_procova_paths(sc$truth$effect, sc$truth$sd %||% 1,
                             sc$analysis$alpha %||% 0.025, sc$analysis$power %||% 0.9,
                             sc$prognostic$rho, sc$prognostic$rhoOrdinary %||% 0,
                             sc$prognostic$lambda %||% 1, sc$prognostic$gamma %||% 1,
                             sc$design$allocation %||% 0.5)
  sens <- vcr_procova_sensitivity(sc$truth$effect, sc$truth$sd %||% 1,
                                  sc$analysis$alpha %||% 0.025, sc$analysis$power %||% 0.9,
                                  lambda = sc$prognostic$lambda %||% 1,
                                  gamma = sc$prognostic$gamma %||% 1,
                                  allocation = sc$design$allocation %||% 0.5)
  list(status = "succeeded",
       measures = list(
         vcr_measure("variance_ratio", paths$prognosticScore$varianceRatio),
         vcr_measure("required_total_unadjusted", ceiling(paths$unadjusted$total)),
         vcr_measure("required_total_prognostic", ceiling(paths$prognosticScore$total)),
         vcr_measure("required_total_prognostic_undiscounted", ceiling(paths$undiscountedPrognosticScore$total))),
       counts = vcr_counts(),
       diagnostics = list(paths = paths, sensitivity = sens,
                          note = "The platform ships no prognostic model; rho must be measured out of sample."))
}

vcr_job_accrual <- function(job, ...) {
  sc <- job$scenario
  model <- vcr_accrual_model(sc$sites, sc$alpha, sc$beta, sc$startTimes, sc$screenFailure)
  simultaneous <- is.null(sc$startTimes) || length(unique(sc$startTimes)) == 1L
  out <- if (simultaneous && is.null(sc$screenFailure)) {
    cf <- vcr_accrual_closed_form(model, sc$target, by_times = sc$byTimes)
    list(quantiles = cf$quantiles, mean = cf$mean, probabilityBy = cf$probabilityBy,
         simulated = FALSE, mcse = NULL)
  } else {
    s <- vcr_accrual_simulate(model, sc$target, sc$replicates %||% 20000L, job$seed,
                              vcr_cores(job$cores), by_times = sc$byTimes,
                              randomized_target = !is.null(sc$screenFailure))
    list(quantiles = s$quantiles, mean = s$mean, probabilityBy = s$probabilityBy,
         simulated = TRUE, mcse = s$mcseMean, probabilityByMcse = s$probabilityByMcse)
  }
  measures <- list(vcr_measure("expected_completion_time", out$mean,
                               simulated = out$simulated, mcse = out$mcse))
  for (i in seq_along(out$quantiles)) {
    measures[[length(measures) + 1L]] <- vcr_measure(
      paste0("completion_", names(out$quantiles)[i]), as.numeric(out$quantiles[i]))
  }
  if (!is.null(out$probabilityBy)) for (i in seq_along(out$probabilityBy)) {
    measures[[length(measures) + 1L]] <- vcr_measure(
      paste0("probability_by_", names(out$probabilityBy)[i]), as.numeric(out$probabilityBy[i]),
      simulated = out$simulated, mcse = if (out$simulated) as.numeric(out$probabilityByMcse[i]) else NULL)
  }
  list(status = "succeeded", measures = measures, counts = vcr_counts(),
       diagnostics = list(model = model[c("nSites", "alpha", "beta", "meanRatePerSite")],
                          closedForm = !out$simulated,
                          unavailable = list(siteActivationDates = is.null(sc$startTimes),
                                             screenFailureRate = is.null(sc$screenFailure))))
}

#' Kleene three-valued eligibility, with `not_applicable` kept apart from
#' `unknown` (plan 7.1). Deterministic: the language model's job ended when it
#' produced the structured criteria and the located evidence.
vcr_job_match_criteria <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  criteria <- sc$criteria
  states <- vapply(criteria, function(c_) as.character(c_$state %||% "unknown"), character(1))
  applicable <- vapply(criteria, function(c_) !isTRUE(c_$notApplicable), logical(1))
  kinds <- vapply(criteria, function(c_) as.character(c_$kind %||% "inclusion"), character(1))
  eff <- states
  eff[!applicable] <- "satisfied"     # a criterion that cannot apply cannot exclude
  inc <- eff[kinds == "inclusion"]
  exc <- eff[kinds == "exclusion"]
  # Inclusion: all must hold. Exclusion: none may hold. `unknown` on either
  # side blocks a positive verdict but is not a negative one.
  summary <- if (any(inc == "not_satisfied") || any(exc == "satisfied")) "ineligible"
             else if (any(inc == "unknown") || any(exc == "unknown")) "insufficient_evidence"
             else if (any(eff == "pending_recheck")) "pending"
             else "eligible"
  tbl <- data.frame(criterion = vapply(criteria, function(c_) as.character(c_$id %||% ""), character(1)),
                    kind = kinds, type = vapply(criteria, function(c_) as.character(c_$type %||% "other"), character(1)),
                    state = states, notApplicable = !applicable, stringsAsFactors = FALSE)
  list(status = "succeeded",
       measures = list(
         vcr_measure("criteria_total", length(criteria)),
         vcr_measure("criteria_unknown", sum(states == "unknown")),
         vcr_measure("criteria_not_satisfied", sum(states == "not_satisfied"))),
       counts = vcr_counts(realPatients = 1),
       diagnostics = list(eligibility = summary, criteria = tbl,
                          logic = "kleene_three_valued"),
       tables = Filter(Negate(is.null), list(vcr_write_table(tbl, "criteria", output_dir))))
}
