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
# - **The engine reads exactly the files the job names, under the data root.**
#   `inputs[].location` is a path relative to `VCR_ENGINE_DATA_ROOT`, its
#   sha256 is verified over the bytes that are then parsed, and nothing walks a
#   directory (inputs.R). A snapshot whose bytes changed after a tool wrote them
#   is a `failed` result with a named reason, not a quietly different number
#   (plan 8.1, AC-26).
# - **Nothing in a scenario is code.** Rules are data (rules.R); a scenario
#   carrying an `expression` field anywhere is refused before any handler runs,
#   and an error message that would have repeated file content is replaced by a
#   fixed code (`vcr_abort`).
# - **`failed` never carries numbers that pretend to be an estimate.** A handler
#   that cannot produce an estimate returns issues; `measures` stays empty. (A
#   spent CPU budget is the one exception and says so: the measures are those of
#   the replicates that finished.) Writing a 0 would pass every schema and be a
#   lie, which is why `validateEngineResult` refuses a non-finite measure value
#   rather than accepting a placeholder.
# - **The result is protocol-shaped whatever happens.** `vcr_run_job` never
#   raises: a malformed scenario, a handler error and a result the validator
#   dislikes all come back as a `failed` result with a code, because a job with
#   no `result.json` is indistinguishable from a crashed container.
# - **The manifest is what makes the result repeatable**, so it records the
#   things that actually change an answer: engine version, R version, the
#   package lock's hash, the RNG kind, the seed, the core count (which must
#   *not* change the answer, and is recorded so that claim is checkable), the
#   scenario hash and the output hash. The output hash covers the numbers that
#   matter (`vcr_output_hash`, protocol.R); the HTTP service signs it.
# - **Parquet comes in through one 20-line Python bridge.** R's `arrow` is not
#   in the pinned library and pulling it in for one file format would be a
#   large dependency for a small job; `pyarrow` is already present for the
#   data plane. The bridge is the only place Python touches a data path and it
#   converts, it never computes.
# ---------------------------------------------------------------------------

VCR_ENGINE_SOURCE_FILES <- c(
  "protocol", "rules", "inputs", "rng", "simulators", "population", "quality", "weighting", "rmst",
  "reconstruct", "maic", "evidence_pool", "map_prior", "design_analytic",
  "design_simulate", "assurance", "procova", "accrual", "summaries", "comparison", "weighted_cox", "maic_tte", "aipw"
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
  "comparator.weighted_cox" = vcr_job_weighted_cox,
  "comparator.maic_time_to_event" = vcr_job_maic_tte,
  "comparator.aipw" = vcr_job_aipw,
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

#' The package lock's identity: the sha256 of its *contents* (R version and the
#' sorted package list), not of its bytes. A lock that carried a machine path or
#' was re-indented would otherwise change the hash of every result without
#' changing a single number.
vcr_package_lock_hash <- function() {
  p <- vcr_package_lock_path()
  if (!file.exists(p)) return("")
  lock <- tryCatch(jsonlite::fromJSON(p, simplifyVector = FALSE), error = function(e) NULL)
  if (is.null(lock)) return("")
  pk <- lapply(lock$packages %||% list(), function(x) list(package = x$package, version = x$version))
  pk <- pk[order(vapply(pk, function(x) as.character(x$package), character(1)), method = "radix")]
  vcr_sha256(vcr_canonical_json(list(rVersion = lock$rVersion, packages = pk)))
}

vcr_engine_health <- function() {
  d <- vcr_domain()
  issues <- vcr_engine_self_check()
  list(ok = length(issues) == 0L,
       engineVersion = vcr_engine_version(),
       rVersion = paste("R", getRversion()),
       protocolVersion = d$protocolVersion,
       methods = names(vcr_engine_handlers()),
       packageLockHash = vcr_package_lock_hash(),
       rngKind = VCR_RNG_KIND,
       maxReplicates = vcr_max_replicates(),
       issues = issues)
}

# --- the run ---------------------------------------------------------------

#' The value source a measure carries when its handler did not name one. Each
#' handler names the source of the numbers it can tell apart (a count of rows
#' is `observed`, a weighted estimate is `calculated`); this is the floor.
vcr_default_measure_source <- function(method) {
  switch(as.character(method),
    "population.scenario" = , "population.literature" = , "population.synthpop" = , "population.quality" = ,
    "patients.continuous" = , "patients.binary" = , "patients.time_to_event" = , "design.simulate" = , "design.grid" = "synthetic",
    "evidence.pool" = , "comparator.map_prior" = "aggregate",
    "evidence.reconstruct_km" = "reconstructed",
    "calculated")
}

.vcr_zero_hash <- function() strrep("0", 64)

#' The issue codes this engine raises beyond the protocol's own (the domain's
#' `VCR_PROTOCOL_ISSUE_CODES`): closed vocabulary, one entry per code a handler,
#' the data reader or the run wrapper can put in a result's `issues`. The control
#' plane registers every one of them; `tests/numeric/E10_robustness.R` walks the
#' sources and fails when a literal code is in neither list, because a code that
#' is misspelt here is a refusal nobody has a message for.
VCR_ENGINE_OWN_ISSUE_CODES <- c(
  "constraint_unsatisfiable", "cpu_budget_exhausted", "grid_cell_failed", "handler_error",
  "input_format_unsupported", "input_hash_mismatch", "input_parse_failed", "input_source_not_reconstructed", "input_too_large",
  "job_invalid", "mechanistic_engine_unknown", "mechanistic_field_missing", "missing_covariate",
  "model_card_field_missing", "model_risk_unknown", "performance_measure_unsupported", "replicates_all_failed",
  "twin_label_inconsistent", "uncertainty_and_variability_conflated")

#' A column named by one string, or a named refusal (a number, an empty array
#' or an object in its place used to reach `subj[[...]]` and end as an R error).
.vcr_column_name <- function(x, default, field) {
  v <- if (is.null(x)) default else x
  if (!(is.character(v) && length(v) == 1L && !is.na(v) && nzchar(v))) {
    vcr_abort("scenario_value_invalid", field, "A column is named by one string.")
  }
  v
}

#' A protocol-shaped `failed` result built from nothing but the job's own
#' identifiers. Used when the normal path itself could not run.
vcr_minimal_failed <- function(job, hash, started, code, detail) {
  safe <- function(x) if (is.character(x) && length(x) == 1L && !is.na(x)) x else NULL
  j <- if (is.list(job)) job else list()
  list(jobId = safe(j$jobId), protocolVersion = 1L, status = "failed",
       method = safe(j$method), methodVersion = safe(j$methodVersion), scenarioHash = hash, seed = j$seed,
       replicates = NULL, notEstimableRule = NULL, counts = vcr_counts(), measures = list(),
       diagnostics = list(issues = list(vcr_issue(code, "job", detail))), tables = list(),
       manifest = list(engineVersion = vcr_engine_version(), rVersion = paste("R", getRversion()),
                       packageLockHash = tryCatch(vcr_package_lock_hash(), error = function(e) ""),
                       startedAt = started,
                       finishedAt = format(as.POSIXct(Sys.time(), tz = "UTC"), "%Y-%m-%dT%H:%M:%OS3Z"),
                       cpuSeconds = 0, rngKind = VCR_RNG_KIND, cores = 1L, platform = R.version$platform,
                       inputHashes = list()))
}

#' Run a job end to end and return a protocol-valid result. Never raises.
vcr_run_job <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  started <- format(as.POSIXct(Sys.time(), tz = "UTC"), "%Y-%m-%dT%H:%M:%OS3Z")
  cpu0 <- vcr_cpu_seconds()
  hash <- tryCatch(vcr_scenario_hash(if (is.list(job)) job$scenario else NULL), error = function(e) .vcr_zero_hash())
  vcr_ctx_begin(cancel_file, if (is.list(job)) vcr_scalar(job$cpuSecondsLimit, Inf) else Inf)
  on.exit(vcr_ctx_end(), add = TRUE)

  finish <- function(status, measures = list(), counts = NULL, diagnostics = list(),
                     tables = list(), rule = NULL, issues = list(), conclusion = NULL) {
    cpu <- vcr_cpu_seconds() - cpu0
    method_ok <- is.character(job$method) && length(job$method) == 1L && !is.na(job$method)
    default_src <- vcr_default_measure_source(if (method_ok) job$method else "")
    measures <- lapply(measures, function(m) { if (is.null(m$source)) m$source <- default_src; m })
    # A run that stopped before it finished (a spent CPU budget, a cancel) and
    # still holds measures from the batches that did finish says `limited`: it is
    # the one word that lets the control plane keep those measures as a partial
    # result and refuse the measures of any other failure (contract 3.4).
    con <- if (identical(status, "succeeded")) (conclusion %||% "estimable")
           else if (identical(status, "not_estimable")) "not_estimable"
           else if (status %in% c("failed", "canceled") && length(measures)) "limited" else NULL
    result <- list(
      jobId = job$jobId, protocolVersion = 1L, status = status,
      method = job$method,
      methodVersion = job$methodVersion %||% (if (method_ok) vcr_domain()$methods[[job$method]]$version),
      scenarioHash = hash, seed = job$seed,
      # The *actual* replicate count, which is the requested one raised to
      # whatever the precision floor demanded (AC-28). Echoing the job's own
      # number here would make a result that ran 5,000 replicates claim 3,000,
      # and the MCSE on its measures would contradict it.
      replicates = {
        rc <- diagnostics$replicatesCompleted
        # a run stopped before its first batch completed none, and says so by
        # naming no count rather than by echoing the requested one
        if (is.null(rc)) job$replicates else if (rc >= 1) rc else NULL
      },
      conclusion = con,
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
        # what the job named, as far as it named it: a malformed `inputs` field is
        # refused by name above and must not stop the refusal from being written
        inputHashes = if (is.list(job$inputs)) lapply(Filter(is.list, job$inputs), function(i) list(id = i$id, kind = i$kind, hash = i$hash)) else list()
      )
    )
    if (exists("vcr_output_hash", mode = "function")) result$manifest$outputHash <- vcr_output_hash(result)
    result
  }

  body <- function() {
    if (!is.list(job) || (length(job) && is.null(names(job)))) {
      return(vcr_minimal_failed(job, hash, started, "job_not_object", "A job is a JSON object."))
    }
    # A rule is data. An `expression` field anywhere in the scenario is refused
    # by its own code before any handler (or the schema check) can read it.
    bad_paths <- vcr_scenario_expression_paths(job$scenario)
    if (length(bad_paths)) {
      return(finish("failed", issues = lapply(utils::head(bad_paths, 5L), function(p)
        vcr_issue("rule_expression_forbidden", p, "A rule is data, never code: an `expression` field is refused."))))
    }
    issues <- tryCatch(vcr_validate_job(job),
                       error = function(e) list(vcr_issue("job_invalid", "job", "The job could not be validated as a protocol job.")))
    if (length(issues)) return(finish("failed", issues = issues))
    reps <- vcr_scalar(job$replicates, NULL)
    if (!is.null(reps) && reps > vcr_max_replicates()) {
      return(finish("failed", issues = list(vcr_issue("replicates_invalid", "replicates",
        sprintf("This engine runs at most %d replicates per job.", as.integer(vcr_max_replicates()))))))
    }
    self <- vcr_engine_self_check()
    if (length(self)) return(finish("failed", issues = self))

    handler <- vcr_engine_handlers()[[job$method]]
    if (is.null(handler)) return(finish("failed", issues = list(vcr_issue(
      "method_not_implemented", "method", sprintf("no handler for %s", job$method)))))

    out <- tryCatch(
      handler(job, output_dir = output_dir, cancel_file = cancel_file, progress = progress),
      vcr_refusal = function(e) list(status = "failed", issues = list(e$issue)),
      error = function(e) {
        msg <- if (nzchar(Sys.getenv("VCR_ENGINE_DEBUG", ""))) conditionMessage(e) else substr(conditionMessage(e), 1, 300)
        list(status = "failed", issues = list(vcr_issue("handler_error", "method", msg)))
      })
    if (!is.list(out)) out <- list(status = "failed", issues = list(vcr_issue("handler_error", "method", "The handler returned no result.")))

    result <- finish(out$status %||% "succeeded", out$measures %||% list(), out$counts,
                     out$diagnostics %||% list(), out$tables %||% list(),
                     out$notEstimableRule, out$issues %||% list(), out$conclusion)
    problems <- c(vcr_validate_result(result), vcr_validate_counts(result$counts))
    if (length(problems)) {
      keys <- vapply(problems, function(p) paste(p$code, p$field), character(1))
      problems <- problems[!duplicated(keys)]
      # A result this build cannot validate is a failure of this build, and
      # saying so here is cheaper than a 422 from the control plane.
      result$status <- "failed"
      result$conclusion <- NULL
      result$measures <- list()
      result$diagnostics$resultValidationIssues <- problems
      if (exists("vcr_output_hash", mode = "function")) result$manifest$outputHash <- vcr_output_hash(result)
    }
    result
  }

  tryCatch(body(), error = function(e) {
    msg <- if (nzchar(Sys.getenv("VCR_ENGINE_DEBUG", ""))) conditionMessage(e) else "The engine could not build a protocol result for this job."
    vcr_minimal_failed(job, hash, started, "handler_error", msg)
  })
}

#' Write a table and return its manifest row. `location` is the file name
#' inside the job's output directory, not an absolute path: the result travels
#' to places that must not learn where the engine keeps its files.
vcr_write_table <- function(df, name, output_dir) {
  if (is.null(output_dir)) return(NULL)
  dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)
  file <- paste0(name, ".csv")
  path <- file.path(output_dir, file)
  utils::write.csv(df, path, row.names = FALSE, na = "")
  list(name = name, location = file, sha256 = vcr_file_sha256(path), rows = nrow(df))
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# ---------------------------------------------------------------------------
# Handlers. One per method id; each returns
#   list(status, measures, counts, diagnostics, tables, notEstimableRule, issues, conclusion)
# and never a number it could not compute.
# ---------------------------------------------------------------------------

.vcr_tables_of <- function(x) Filter(Negate(is.null), x)

#' The one table a handler works on: the subject table when the job carries the
#' analysis tables, otherwise the first raw file. Refuses a job with none.
.vcr_main_table <- function(tabs) {
  df <- tabs$subject %||% (if (length(tabs$files)) tabs$files[[1]] else NULL)
  if (is.null(df)) vcr_abort("input_shape_invalid", "inputs", "This method reads a patient-level table and the job names none.")
  df
}

.vcr_source_label <- function(df, default = "calculated", columns = NULL) {
  # the table's label, or the weakest source among the columns a method used
  s <- if (is.null(columns)) vcr_table_source(df) else vcr_used_source(df, columns)
  if (is.na(s)) default else s
}

# --- profile.snapshot --------------------------------------------------------

#' Cells of a categorical column with the small-cell rule applied (contract 4;
#' build ruling 9.1): a cell below `min_cell` (and 0) is never shown alone. The
#' small cells are absorbed into one bucket, together with the next-smallest
#' cells until the bucket holds at least `min_cell` people and at least two
#' cells, so that no single hidden cell can be recovered by subtracting the
#' shown ones from a total. If no such bucket exists the column's cells are
#' withheld. Nothing about a merged cell is kept but that it was merged: no
#' count, no complement, no name (a pseudonymous id is a level too).
vcr_suppress_cells <- function(tab, min_cell) {
  tab <- tab[tab > 0]
  if (!length(tab)) return(list(cells = list(), withheld = NULL))
  if (length(tab) > 50L) return(list(cells = NULL, withheld = "high_cardinality"))
  shown <- function(idx) lapply(idx, function(i) list(level = names(tab)[i], n = as.numeric(tab[[i]])))
  small <- tab < min_cell
  if (!any(small)) return(list(cells = shown(order(-tab, names(tab))), withheld = NULL))
  ord <- order(tab, names(tab))
  csum <- cumsum(tab[ord])
  take <- sum(small)
  while (take < length(ord) && (csum[take] < min_cell || take < 2L)) take <- take + 1L
  if (csum[take] < min_cell || take < 2L) return(list(cells = NULL, withheld = "small_cells"))
  bucket <- ord[seq_len(take)]
  keep <- setdiff(seq_along(tab), bucket)
  cells <- c(shown(keep[order(-tab[keep], names(tab)[keep])]),
             list(list(level = "(other)", n = as.numeric(csum[take]), merged = take)))
  list(cells = cells, withheld = NULL)
}

vcr_profile_table <- function(df, min_cell) {
  rows <- nrow(df)
  cols <- lapply(names(df), function(v) {
    x <- df[[v]]
    nmiss <- sum(is.na(x)); nonmiss <- rows - nmiss
    suppressed <- character(0)
    # A count of people in [1, min_cell - 1] is not shown, and neither is its
    # complement: with `rows` published, a hidden count of non-missing values
    # is the same disclosure as a hidden count of missing ones.
    miss_hidden <- (nmiss >= 1L && nmiss < min_cell) || (nonmiss >= 1L && nonmiss < min_cell)
    if (miss_hidden) suppressed <- c(suppressed, "missing")
    base <- list(column = v, missing = if (miss_hidden) NULL else nmiss,
                 missingRate = if (miss_hidden) NULL else nmiss / max(rows, 1L),
                 distinct = length(unique(stats::na.omit(x))))
    if (is.numeric(x) && base$distinct > min_cell) {
      xs <- stats::na.omit(x)
      q <- stats::quantile(xs, c(0.05, 0.25, 0.5, 0.75, 0.95), na.rm = TRUE, names = FALSE)
      out <- c(base, list(kind = "numeric", mean = mean(xs), sd = stats::sd(xs),
                          p25 = q[2], median = q[3], p75 = q[4]))
      # The tails are near-individual values in a small table.
      if (length(xs) >= 20L * min_cell) { out$p05 <- q[1]; out$p95 <- q[5] } else suppressed <- c(suppressed, "p05", "p95")
    } else {
      tab <- table(as.character(x))
      sc <- vcr_suppress_cells(tab, min_cell)
      out <- c(base, list(kind = "categorical", cells = sc$cells))
      if (!is.null(sc$withheld)) out$withheld <- sc$withheld
    }
    if (length(suppressed)) out$suppressed <- as.list(suppressed)
    out
  })
  list(rows = rows, columns = cols)
}

vcr_job_profile_snapshot <- function(job, output_dir = NULL, ...) {
  tabs <- vcr_job_tables(job)
  all <- .vcr_tables_of(c(list(tabs$subject, tabs$event, tabs$long), tabs$files))
  if (!length(all)) vcr_abort("input_shape_invalid", "inputs", "A profile job names at least one table.")
  min_cell <- vcr_domain()$limits$minCellSize
  profiles <- lapply(all, function(df) c(list(input = attr(df, "vcrInputId"), shape = attr(df, "vcrShape") %||% NA_character_,
                                              valueSource = .vcr_source_label(df, "unlabelled")),
                                         vcr_profile_table(df, min_cell)))
  miss <- do.call(rbind, lapply(seq_along(all), function(i) {
    df <- all[[i]]
    r <- vapply(df, function(x) { n <- sum(is.na(x)); if ((n >= 1L && n < min_cell) || (nrow(df) - n >= 1L && nrow(df) - n < min_cell)) NA_real_ else n / max(nrow(df), 1L) }, numeric(1))
    data.frame(table = attr(df, "vcrInputId"), column = names(df), missingRate = as.numeric(r), stringsAsFactors = FALSE)
  }))
  first <- all[[1]]
  used <- vcr_used_sources(list(list(df = first, columns = names(first))))   # a profile reads every column
  src <- if (is.na(used$source)) "calculated" else used$source
  measures <- list(vcr_measure("columns", ncol(first), source = "calculated"))
  if (nrow(first) >= min_cell) measures <- c(list(vcr_measure("rows", nrow(first), source = src)), measures)
  list(status = "succeeded", measures = measures,
       counts = vcr_table_counts(first),
       diagnostics = list(tables = profiles, columns = profiles[[1]]$columns, minimumCellSize = min_cell,
                          valueSourcesUsed = vcr_value_sources_used(used),
                          rowsSuppressed = nrow(first) < min_cell,
                          qualityCategories = vcr_domain()$qualityCategories),
       tables = .vcr_tables_of(list(vcr_write_table(miss, "snapshot-missingness", output_dir))))
}

# --- cohort.build ------------------------------------------------------------

#' Apply named rules to a table in order, three-valued. Returns the steps, the
#' membership, and the independent (order-free) impact of each rule.
vcr_apply_cohort_rules <- function(df, rules) {
  n <- nrow(df)
  treat <- vapply(rules, function(r) as.character(r$unknownAs %||% "exclude"), character(1))
  if (any(!(treat %in% c("exclude", "include")))) vcr_abort("scenario_value_invalid", "scenario.rules", "unknownAs is 'exclude' or 'include'.")
  V <- lapply(rules, function(r) vcr_eval_row_rule(r$rule, df))
  alive <- rep(TRUE, n)
  steps <- list()
  for (i in seq_along(rules)) {
    v <- V[[i]]
    keep <- alive & !is.na(v) & v
    drop <- alive & !is.na(v) & !v
    unknown <- alive & is.na(v)
    steps[[i]] <- list(rule = rules[[i]]$name, kept = sum(keep), excluded = sum(drop),
                       indeterminate = sum(unknown), indeterminateTreatment = treat[i])
    alive <- if (identical(treat[i], "include")) (keep | unknown) else keep
  }
  passes_others <- function(i) {
    ok <- rep(TRUE, n)
    for (j in seq_along(rules)) if (j != i) ok <- ok & (if (treat[j] == "include") (is.na(V[[j]]) | V[[j]]) else (!is.na(V[[j]]) & V[[j]]))
    ok
  }
  impact <- lapply(seq_along(rules), function(i) list(
    rule = rules[[i]]$name,
    failsAlone = sum(!is.na(V[[i]]) & !V[[i]]),
    indeterminateAlone = sum(is.na(V[[i]])),
    excludedOnlyByThisRule = sum(!is.na(V[[i]]) & !V[[i]] & passes_others(i))))
  strict <- Reduce(`&`, lapply(V, function(v) !is.na(v) & v))
  lenient <- Reduce(`&`, lapply(V, function(v) is.na(v) | v))
  list(steps = steps, alive = alive, impact = impact, strict = strict, lenient = lenient)
}

.vcr_date_or_number <- function(x) {
  if (is.numeric(x)) return(x)
  d <- suppressWarnings(as.Date(as.character(x)))
  if (all(is.na(d) == is.na(x))) d else as.character(x)
}

.vcr_rules_hash <- function(items) {
  vcr_sha256(vcr_canonical_json(lapply(items, function(r) list(name = r$name, rule = r$rule, unknownAs = r$unknownAs %||% "exclude"))))
}

vcr_job_build_cohort <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  df <- .vcr_main_table(vcr_job_tables(job))
  items <- sc$rules
  if (is.null(items) || !length(items)) {
    vcr_abort("scenario_field_missing", "scenario.rules", "A cohort has at least one named rule; an empty list would keep everyone.")
  }
  cons <- vcr_named_rules(items, names(df), "scenario.rules")
  if (length(cons$issues)) vcr_abort_issue(cons$issues[[1]])
  res <- vcr_apply_cohort_rules(df, items)
  # time zero and exit: the two other parts of the three-part cohort model
  time_col <- function(spec, field) {
    if (is.null(spec)) return(NULL)
    col <- as.character(spec$column %||% "")
    if (!(col %in% names(df))) vcr_abort("scenario_value_invalid", field, "The named column is not in the table.")
    col
  }
  tz <- time_col(sc$timeZero, "scenario.timeZero"); ex <- time_col(sc$exit, "scenario.exit")
  id_col <- as.character(sc$idColumn %||% "USUBJID")
  members <- data.frame(id = if (id_col %in% names(df)) df[[id_col]] else seq_len(nrow(df)), stringsAsFactors = FALSE)
  names(members) <- if (id_col %in% names(df)) id_col else "row"
  index <- if (!is.null(tz)) .vcr_date_or_number(df[[tz]]) else NULL
  exitv <- if (!is.null(ex)) .vcr_date_or_number(df[[ex]]) else NULL
  if (!is.null(index)) members$index <- as.character(index)
  if (!is.null(exitv)) members$exit <- as.character(exitv)
  members <- members[res$alive, , drop = FALSE]
  before <- if (!is.null(index) && !is.null(exitv) && identical(class(index), class(exitv))) sum(res$alive & !is.na(index) & !is.na(exitv) & exitv < index) else NULL
  wf <- do.call(rbind, lapply(res$steps, as.data.frame, stringsAsFactors = FALSE))
  # the cohort is decided by the columns its rules, time zero and exit read: its size is
  # as direct as the least direct of those, not of every column in the table
  used <- vcr_used_sources(list(list(df = df, columns = c(unlist(lapply(items, function(r) vcr_rule_columns(r$rule))), tz, ex))))
  src <- if (is.na(used$source)) "calculated" else used$source
  size <- sum(res$alive)
  list(status = "succeeded",
       measures = list(vcr_measure("cohort_size", size, source = src),
                       vcr_measure("cohort_size_strict", sum(res$strict), source = src),
                       vcr_measure("cohort_size_lenient", sum(res$lenient), source = src)),
       counts = if (vcr_table_source(df) %in% unlist(vcr_domain()$realPatientSources)) vcr_counts(realPatients = size) else vcr_table_counts(df),
       diagnostics = list(waterfall = res$steps, startingRows = nrow(df), criterionImpact = res$impact,
                          cohortRulesHash = .vcr_rules_hash(items),
                          valueSourcesUsed = vcr_value_sources_used(used),
                          timeZero = if (!is.null(tz)) list(column = tz, missing = sum(res$alive & is.na(df[[tz]]))) else NULL,
                          exit = if (!is.null(ex)) list(column = ex, missing = sum(res$alive & is.na(df[[ex]])), beforeIndex = before) else NULL,
                          membership = "kept_after_all_rules; indeterminate follows each rule's unknownAs"),
       tables = .vcr_tables_of(list(vcr_write_table(wf, "cohort-waterfall", output_dir),
                                    vcr_write_table(members, "cohort-members", output_dir))))
}

#' Cohort rules carried into a downstream job: the same named rules, applied to
#' the subject table before anything is estimated. Returns the filtered table
#' and a record of what was applied (the rules' hash equals the one
#' `cohort.build` reported for the same rules).
vcr_apply_downstream_cohort <- function(df, items) {
  if (is.null(items) || !length(items)) return(list(data = df, info = NULL, keep = rep(TRUE, nrow(df))))
  cons <- vcr_named_rules(items, names(df), "scenario.cohortRules")
  if (length(cons$issues)) vcr_abort_issue(cons$issues[[1]])
  res <- vcr_apply_cohort_rules(df, items)
  list(data = df[res$alive, , drop = FALSE], keep = res$alive,
       info = list(rulesHash = .vcr_rules_hash(items), startingRows = nrow(df), keptRows = sum(res$alive), waterfall = res$steps))
}

# --- populations -------------------------------------------------------------

.vcr_max_records <- function() .vcr_env_num("VCR_ENGINE_MAX_RECORDS", 2e6)

vcr_job_generate_population <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  n <- as.integer(vcr_scalar(sc$n, 1000L)); K <- as.integer(vcr_scalar(sc$parameterDraws, 1L))
  if (n < 1L || K < 1L || as.numeric(n) * K > .vcr_max_records()) {
    vcr_abort("scenario_value_invalid", "scenario.n", "The population size (times the parameter draws) is a positive number this engine can hold.")
  }
  set.seed(job$seed, kind = VCR_RNG_KIND)
  pop <- vcr_population_scenario(sc$population, n, K, seed = job$seed)
  viol <- sum(pop$constraintViolations$violations)
  spread <- if (!is.null(pop$parameterTable) && nrow(pop$parameterTable)) {
    stats::aggregate(value ~ variable + parameter, pop$parameterTable, stats::sd)
  } else NULL
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", pop$n, source = "synthetic"),
                       vcr_measure("constraint_violations", viol, source = "synthetic")),
       counts = pop$counts,
       diagnostics = list(kind = pop$kind, parameterDraws = pop$parameterDraws,
                          parameterSpread = spread,
                          copulaRepaired = pop$copulaRepaired,
                          constraintViolations = pop$constraintViolations,
                          constraintEnforcement = pop$constraintEnforcement,
                          missingReasons = pop$missingReasons,
                          valueSource = pop$valueSource, modelTier = pop$modelTier),
       tables = .vcr_tables_of(list(vcr_write_table(pop$data, "population", output_dir),
                                    if (!is.null(pop$parameterTable)) vcr_write_table(pop$parameterTable, "population-parameters", output_dir))))
}

vcr_job_population_literature <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  n <- as.integer(vcr_scalar(sc$n, 1000L)); K <- as.integer(vcr_scalar(sc$parameterDraws, 1L))
  if (n < 1L || K < 1L || as.numeric(n) * K > .vcr_max_records()) {
    vcr_abort("scenario_value_invalid", "scenario.n", "The population size (times the parameter draws) is a positive number this engine can hold.")
  }
  set.seed(job$seed, kind = VCR_RNG_KIND)
  pop <- vcr_population_literature(sc$baselineTable, n, sc$correlation,
                                   as.character(sc$correlationSource %||% "assumed"), K, seed = job$seed)
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", pop$n, source = "synthetic")),
       counts = pop$counts,
       diagnostics = list(kind = pop$kind, applicability = pop$applicability,
                          correlationSource = pop$correlationSource, modelTier = pop$modelTier,
                          valueSource = "synthetic", columnSources = as.list(pop$columnSources),
                          correlationSensitivity = pop$correlationSensitivity,
                          constraintEnforcement = pop$constraintEnforcement),
       tables = .vcr_tables_of(list(vcr_write_table(pop$data, "population", output_dir))))
}

.vcr_analyses_from_scenario <- function(items) {
  if (is.null(items) || !length(items)) return(list())
  out <- lapply(items, vcr_analysis_from_spec)
  names(out) <- vapply(seq_along(items), function(i) as.character(items[[i]]$name %||% sprintf("analysis_%d", i)), character(1))
  out
}

#' The result of a job stopped by a cancel request or by the CPU budget: nothing
#' is invented for the part that did not run, and the reason is named.
.vcr_interrupted_result <- function(reason, detail) {
  if (identical(reason, "canceled")) return(list(status = "canceled", measures = list(), counts = vcr_counts(), diagnostics = list(interrupted = detail)))
  list(status = "failed", measures = list(), counts = vcr_counts(),
       issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", sprintf("The CPU budget ran out: %s.", detail))))
}

vcr_job_synthesize_population <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  df <- .vcr_main_table(vcr_job_tables(job))
  vcr_require_individual(df, "Empirical synthesis", method = "population.synthpop")
  used_train <- vcr_used_sources(list(list(df = df, columns = names(df))), "observed")   # synthesis reads every column
  m <- vcr_scalar(sc$m, 5L)
  if (!(m >= 5 && m == round(m) && m <= 50)) {
    vcr_abort("scenario_value_invalid", "scenario.m", "Inference on synthetic data needs at least 5 copies (and at most 50).")
  }
  share <- vcr_scalar(sc$holdoutShare, 0.2)
  if (!(share >= 0 && share < 1)) vcr_abort("scenario_value_invalid", "scenario.holdoutShare", "The holdout share is in [0, 1).")
  set.seed(job$seed, kind = VCR_RNG_KIND)
  idx <- sample.int(nrow(df))
  n_hold <- floor(nrow(df) * share)
  if (nrow(df) - n_hold < 2L) vcr_abort("scenario_value_invalid", "scenario.holdoutShare", "The training table would have fewer than two records.")
  # `idx[-seq_len(0)]` is `idx[-integer(0)]`, which is EMPTY: a holdout share
  # of zero used to hand synthpop an empty training table (CE-31).
  holdout <- if (n_hold > 0L) df[idx[seq_len(n_hold)], , drop = FALSE] else NULL
  train <- if (n_hold > 0L) df[idx[-seq_len(n_hold)], , drop = FALSE] else df
  syn <- vcr_population_synthpop(train, m = as.integer(m), seed = job$seed)
  if (!is.null(syn$interrupted)) return(.vcr_interrupted_result(syn$interrupted, sprintf("%d of %d synthetic copies were made", length(syn$data), as.integer(m))))
  copies <- do.call(rbind, lapply(seq_along(syn$data), function(k) cbind(copy = k, syn$data[[k]])))
  analyses <- .vcr_analyses_from_scenario(sc$analyses)
  report <- vcr_quality_report(train, syn$data[[1]], holdout,
                               constraints = sc$constraints, analyses = analyses,
                               criteria = sc$criteria,
                               generator = list(family = "synthpop_cart", m = syn$m,
                                                smoothing = syn$smoothing, seed = job$seed),
                               tstr_outcome = sc$tstrOutcome)
  by_copy <- do.call(rbind, lapply(seq_along(syn$data), function(k) {
    uni <- vcr_fidelity_univariate(train, syn$data[[k]])
    pr <- tryCatch(vcr_utility_propensity(train, syn$data[[k]]), error = function(e) list(sPMSE = NA_real_, propensityAuc = NA_real_))
    data.frame(copy = k, worstKsD = suppressWarnings(max(uni$value[uni$statistic == "ks_d"], -Inf)),
               worstTvd = suppressWarnings(max(uni$value[uni$statistic == "tvd"], -Inf)),
               sPMSE = pr$sPMSE, propensityAuc = pr$propensityAuc)
  }))
  worst <- which.max(ifelse(is.finite(by_copy$sPMSE), by_copy$sPMSE, -Inf))
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", syn$generatedRecords, source = "synthetic"),
                       vcr_measure("training_observations", syn$trainingObservations, source = used_train$source %||% "observed"),
                       vcr_measure("synthetic_copies", syn$m, source = "synthetic")),
       counts = vcr_counts(realPatients = 0, generatedRecords = syn$generatedRecords),
       diagnostics = list(quality = report, qualityByCopy = by_copy, worstCopy = if (length(worst)) worst else NA_integer_,
                          lowSampleWarning = syn$lowSampleWarning,
                          inferenceLabel = syn$inferenceLabel, holdoutRows = if (is.null(holdout)) 0L else nrow(holdout),
                          rareLevelsMerged = syn$rareLevelsMerged, rareLevelFloor = syn$rareLevelFloor,
                          valueSource = "synthetic",
                          allowedUses = vcr_domain()$syntheticUses),
       tables = .vcr_tables_of(list(vcr_write_table(copies, "synthetic-population", output_dir))))
}

vcr_job_population_quality <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  read <- function(id_key, required = TRUE) {
    id <- sc[[id_key]]
    if (is.null(id)) { if (required) vcr_abort("scenario_field_missing", paste0("scenario.", id_key), "The scenario names the input this role reads."); return(NULL) }
    input <- vcr_input_by_id(job, as.character(id))
    if (is.null(input)) vcr_abort("input_shape_invalid", paste0("scenario.", id_key), "The scenario names an input the job does not carry.")
    vcr_read_table_input(input)
  }
  train <- read("trainingInputId"); synth <- read("syntheticInputId"); holdout <- read("holdoutInputId", FALSE)
  analyses <- .vcr_analyses_from_scenario(sc$analyses)
  report <- vcr_quality_report(train, synth, holdout, constraints = sc$constraints, analyses = analyses,
                               criteria = sc$criteria, generator = sc$generator %||% list(), tstr_outcome = sc$tstrOutcome)
  finite <- function(x) is.numeric(x) && length(x) == 1L && is.finite(x)
  measures <- list()
  if (finite(report$fidelity$global$sPMSE)) measures <- c(measures, list(vcr_measure("s_pmse", report$fidelity$global$sPMSE, source = "synthetic")))
  if (finite(report$fidelity$global$propensityAuc)) measures <- c(measures, list(vcr_measure("propensity_auc", report$fidelity$global$propensityAuc, source = "synthetic")))
  list(status = "succeeded", measures = measures,
       counts = vcr_counts(realPatients = 0, generatedRecords = nrow(synth)),
       diagnostics = list(quality = report),
       tables = .vcr_tables_of(list(
         vcr_write_table(report$fidelity$univariate, "fidelity-univariate", output_dir),
         vcr_write_table(report$fidelity$pairwise, "fidelity-pairwise", output_dir))))
}

# --- virtual patients ----------------------------------------------------------

#' Virtual patients: draw from the reference simulator the endpoint names, for
#' a two-arm design given by its arm sizes, or for the members of a stored
#' population (a table input): each member gets an arm by a fixed uniform,
#' baseline covariates enter the outcome through `truth.covariateEffects`
#' (centred at the population mean, so the stated control level is the average
#' member's), and
#' every patient carries a stable id and the labels of what produced it.
vcr_job_generate_patients <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  endpoint <- as.character(sc$endpoint$type %||% "")
  expected <- switch(job$method, patients.continuous = "continuous", patients.binary = "binary", patients.time_to_event = "time_to_event")
  if (!identical(endpoint, expected)) {
    vcr_abort("endpoint_not_supported", "scenario.endpoint.type", sprintf("%s generates %s patients.", job$method, expected))
  }
  tr <- sc$truth
  n1 <- vcr_scalar(sc$design$nTreat, NULL); n0 <- vcr_scalar(sc$design$nControl, NULL)
  tabs <- vcr_job_tables(job)
  pop <- if (length(tabs$files)) tabs$files[[1]] else tabs$subject
  z <- NULL; lp <- NULL
  set.seed(job$seed, kind = VCR_RNG_KIND)
  if (!is.null(pop)) {
    n <- nrow(pop)
    if (is.null(n1) || is.null(n0) || n1 + n0 != n) vcr_abort("scenario_value_invalid", "scenario.design", "For a stored population the arm sizes add up to the number of members.")
    z <- as.integer(rank(runif(n), ties.method = "first") <= n1)
    eff <- tr$covariateEffects
    if (!is.null(eff) && length(eff)) {
      cols <- names(eff)
      if (!all(cols %in% names(pop))) vcr_abort("scenario_value_invalid", "scenario.truth.covariateEffects", "A covariate effect names a column of the population.")
      B <- vapply(eff, function(b) vcr_scalar(b, NA_real_), numeric(1))
      if (anyNA(B)) vcr_abort("scenario_value_invalid", "scenario.truth.covariateEffects", "A covariate effect is a number.")
      Xp <- as.matrix(pop[, cols, drop = FALSE])
      if (!is.numeric(Xp) || anyNA(Xp)) vcr_abort("missing_covariate", "scenario.truth.covariateEffects", "A covariate with an effect is numeric and complete in the population.")
      # Centred at the population mean: the control median, rate or mean the
      # scenario states is the average member's, and the covariates spread the
      # population around it (uncentred, a lactate dehydrogenase of 220 with a
      # log-hazard of 0.001 per unit silently moved the stated median by 25%).
      lp <- as.vector(sweep(Xp, 2L, colMeans(Xp), "-") %*% B)
    }
  } else {
    if (is.null(n1)) vcr_abort("scenario_field_missing", "scenario.design.nTreat", "A virtual-patient scenario states its arm sizes.")
    n0 <- n0 %||% 0
  }
  d <- if (identical(endpoint, "continuous")) {
    effect <- .vcr_need(tr$effect, "scenario.truth.effect", "A continuous scenario states the treatment effect (0 for the null).")
    vcr_sim_continuous(n1, n0, effect, vcr_scalar(tr$sd, 1), vcr_scalar(tr$baselineCorrelation, 0), z = z, lp = lp)
  } else if (identical(endpoint, "binary")) {
    vcr_sim_binary(n1, n0, vcr_scalar(tr$controlRate, NULL), p_treat = vcr_scalar(tr$treatmentRate, NULL),
                   risk_difference = vcr_scalar(tr$riskDifference, NULL), odds_ratio = vcr_scalar(tr$oddsRatio, NULL),
                   covariate_logit = vcr_scalar(tr$covariateLogit, 0), z = z, lp = lp)
  } else {
    hr <- .vcr_need(tr$hazardRatio, "scenario.truth.hazardRatio", "A time-to-event scenario states the hazard ratio (1 for the null).")
    acc <- sc$accrual %||% list(kind = "uniform", duration = 0)
    vcr_sim_tte(n1, n0, vcr_control_distribution(tr), hr, acc, vcr_scalar(acc$followup, Inf),
                vcr_scalar(acc$dropoutAnnual, 0), max_followup = vcr_scalar(acc$maxFollowup, Inf), z = z, lp = lp)
  }
  ids <- vapply(seq_len(nrow(d)), function(i) substr(vcr_sha256(paste(job$seed, job$jobId %||% "", i, sep = ":")), 1L, 12L), character(1))
  out <- data.frame(patientId = paste0("vp_", ids), stringsAsFactors = FALSE)
  if (!is.null(pop)) out <- cbind(out, pop)
  out <- cbind(out, d)
  out$source <- "synthetic"
  out$modelTier <- "scenario"
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", nrow(d), source = "synthetic")),
       counts = vcr_counts(realPatients = 0, generatedRecords = nrow(d),
                           events = if ("status" %in% names(d)) sum(d$status) else NULL),
       diagnostics = c(list(endpoint = endpoint, valueSource = "synthetic", modelTier = "scenario",
                          mode = if (is.null(pop)) "scenario" else "population",
                          note = "Scenario simulation from stated parameters; no baseline-conditioned or digital-twin claim is made."),
                       # what the patients page draws: the arms' survival curves and their summary numbers,
                       # and how the headline moves if each stated parameter is off by a fifth
                       vcr_patient_summary(d, endpoint),
                       list(sensitivity = tryCatch(vcr_patient_sensitivity(endpoint, tr), error = function(e) NULL))),
       tables = .vcr_tables_of(list(vcr_write_table(out, "virtual-patients", output_dir))))
}

# --- evidence ----------------------------------------------------------------

#' Pool published studies into one assumption card (plan 6.2 step 4).
#'
#' The input is `studies: [{ studyId, estimate, se }]` on the analysis scale;
#' the engine never transforms a natural-scale value. Hidden knowledge about the
#' shape of the *result*: when k < 3 there is no Higgins-Thompson-Spiegelhalter
#' prediction interval at all, so the `prediction_interval` measure is *absent*,
#' not filled in with the confidence interval. A simulation seeded from a
#' confidence interval understates the spread of a future trial by
#' sqrt(1 + var/tau^2), and it does so invisibly.
vcr_job_pool_evidence <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  s <- sc$studies
  if (!is.list(s) || !length(s)) vcr_abort("scenario_field_missing", "scenario.studies", "Pooling needs at least one study.")
  yi <- vapply(s, function(x) vcr_scalar(x$estimate, NA_real_), numeric(1))
  se <- vapply(s, function(x) vcr_scalar(x$se, NA_real_), numeric(1))
  if (anyNA(yi) || anyNA(se) || any(se <= 0)) {
    bad <- which(is.na(yi) | is.na(se) | se <= 0)[1]
    vcr_abort("scenario_value_invalid", sprintf("scenario.studies[%d]", bad - 1L), "Every study gives a finite estimate and a positive standard error on the analysis scale.")
  }
  method <- as.character(sc$method %||% "random_effects_dl")
  if (!(method %in% vcr_domain()$poolingMethods)) vcr_abort("scenario_value_invalid", "scenario.method", "Unknown pooling method.")
  level <- vcr_scalar(sc$level, 0.95)
  if (!(level > 0 && level < 1)) vcr_abort("scenario_value_invalid", "scenario.level", "The confidence level is between 0 and 1.")
  scale <- as.character(sc$scale %||% "identity")
  if (!(scale %in% c("identity", "log", "logit"))) vcr_abort("scenario_value_invalid", "scenario.scale", "The analysis scale is identity, log or logit.")
  pool <- vcr_pool(yi, se^2, method, level)
  family <- switch(scale, logit = "beta", log = "lognormal", "normal")
  dist <- vcr_pool_to_distribution(pool, family)
  has_pi <- is.finite(pool$predictionInterval[1]) && is.finite(pool$predictionInterval[2])
  measures <- list(
    vcr_measure("pooled_estimate", pool$estimate, unit = scale, source = "aggregate",
                interval = vcr_interval("confidence", pool$interval[1], pool$interval[2], pool$level)))
  if (has_pi) {
    measures <- c(measures, list(vcr_measure(
      "prediction_interval", pool$estimate, unit = scale, source = "aggregate",
      interval = vcr_interval("prediction", pool$predictionInterval[1], pool$predictionInterval[2], pool$level))))
  }
  measures <- c(measures, list(
    vcr_measure("i_squared", pool$i2, source = "aggregate"),
    vcr_measure("tau_squared", pool$tau2, unit = scale, source = "aggregate"),
    vcr_measure("tau", pool$tau, unit = scale, source = "aggregate"),
    vcr_measure("k", pool$k, source = "aggregate")))
  list(status = "succeeded", measures = measures,
       counts = vcr_counts(realPatients = NULL, generatedRecords = 0),
       diagnostics = list(
         scale = scale, poolingMethod = method, poolingMethodApplied = pool$method,
         k = pool$k, i2 = pool$i2, tau2 = pool$tau2,
         predictionDf = pool$predictionDf,
         predictionIntervalAvailable = has_pi,
         predictionIntervalReason = if (has_pi) NULL
           else "a Higgins-Thompson-Spiegelhalter prediction interval needs at least three studies (t on k - 2 df)",
         heterogeneity = list(Q = pool$Q, df = pool$df, pQ = pool$pQ, h2 = pool$h2),
         distribution = dist, weights = pool$weights))
}

.VCR_CURVE_PROVENANCE <- c("digitizer", "human_click")

#' One reconstruction arm from a scenario fragment: the digitized curve as rows
#' `{ time, surv }` and the risk table as rows `{ time, atRisk }`.
.vcr_reconstruct_arm <- function(a, field) {
  curve <- vcr_rows_df(a$curve); risk <- vcr_rows_df(a$riskTable)
  if (!all(c("time", "surv") %in% names(curve)) || nrow(curve) < 3L) {
    vcr_abort("scenario_field_missing", paste0(field, ".curve"), "Reconstruction needs the digitized curve as rows of time and surv.")
  }
  if (!all(c("time", "atRisk") %in% names(risk)) || nrow(risk) < 1L) {
    vcr_abort("scenario_field_missing", paste0(field, ".riskTable"), "Reconstruction needs the published numbers at risk; without them censoring is not identified and no reconstruction is run.")
  }
  ct <- as.numeric(curve$time); cs <- as.numeric(curve$surv); rt <- as.numeric(risk$time); rn <- as.numeric(risk$atRisk)
  if (anyNA(c(ct, cs, rt, rn))) vcr_abort("scenario_value_invalid", field, "The curve and the risk table are numeric.")
  te <- vcr_scalar(a$totalEvents, NA_real_)
  recon <- vcr_guyot(ct, cs, rt, rn, total_events = te)
  list(recon = recon, riskTime = rt, atRisk = rn, totalEvents = te, reportedMedian = vcr_scalar(a$reportedMedian, NA_real_),
       name = as.character(a$name %||% ""))
}

#' Curve coordinates must come from a digitizer or a person clicking, and the
#' scenario names the tool: a curve "read" off a picture by a language model is
#' 0.087 RMSE against 0.014 for a digitizer (attachment C1), and a bare list of
#' numbers cannot say which it is (EB-6).
.vcr_check_provenance <- function(p) {
  if (!is.list(p) || !(as.character(p$kind %||% "") %in% .VCR_CURVE_PROVENANCE) || !nzchar(as.character(p$tool %||% ""))) {
    vcr_abort("scenario_value_invalid", "scenario.provenance", "Curve coordinates come from a digitizer or a human click, and the scenario names the tool.")
  }
  invisible(TRUE)
}

vcr_job_reconstruct_km <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  .vcr_check_provenance(sc$provenance)
  # The scenario's own curve and risk table are the (control) arm; a second arm
  # is the `treatmentArm`, and only two arms can check a reported hazard ratio.
  arms <- list(list(name = "control", curve = sc$curve, riskTable = sc$riskTable, totalEvents = sc$totalEvents, reportedMedian = sc$reportedMedian))
  if (!is.null(sc$treatmentArm)) arms[[2]] <- c(list(name = "treatment"), sc$treatmentArm)
  hr_reported <- vcr_scalar(sc$reportedLogHazardRatio, NA_real_)
  if (!is.na(hr_reported) && length(arms) < 2L) {
    vcr_abort("scenario_value_invalid", "scenario.reportedLogHazardRatio", "A reported hazard ratio is checked against two reconstructed arms; one arm cannot check it.")
  }
  rec <- lapply(seq_along(arms), function(i) .vcr_reconstruct_arm(arms[[i]], if (i == 1L) "scenario" else "scenario.treatmentArm"))
  # The tolerances are the domain's (plan 5.3); a scenario cannot loosen them.
  tol <- list(atRiskAbsolute = 2, atRiskRelative = 0.05, events = 0.05, median = 0.05, logHazardRatio = 0.05)
  dom <- vcr_limit("tolerance", NULL)
  if (is.list(dom)) tol <- utils::modifyList(tol, dom)
  ipd_all <- do.call(rbind, lapply(seq_along(rec), function(i) cbind(rec[[i]]$recon$ipd, arm = i - 1L)))
  log_hr <- if (length(rec) == 2L) vcr_cox_loghr(ipd_all$time, ipd_all$status, ipd_all$arm) else NA_real_
  qc <- lapply(seq_along(rec), function(i) {
    r <- rec[[i]]
    vcr_reconstruction_qc(r$recon, r$riskTime, r$atRisk, total_events_reported = r$totalEvents,
                          median_reported = r$reportedMedian,
                          log_hr_reported = if (i == 2L) hr_reported else NA_real_,
                          log_hr_recon = if (i == 2L) log_hr else NA_real_, tolerance = tol)
  })
  n_pseudo <- nrow(ipd_all)
  pass <- all(vapply(qc, function(q) isTRUE(q$pass), logical(1)))
  if (!pass) {
    return(list(status = "not_estimable", notEstimableRule = "reconstruction_failed_qc",
                measures = list(),
                counts = vcr_counts(realPatients = 0, reconstructedPseudoPatients = n_pseudo),
                diagnostics = list(qualityControl = if (length(qc) == 1L) qc[[1]] else qc, tolerances = tol)))
  }
  measures <- list(); events_total <- 0
  for (i in seq_along(rec)) {
    ipd <- rec[[i]]$recon$ipd
    km <- vcr_km(ipd$time, ipd$status)
    med <- vcr_km_median(km)
    suffix <- if (length(rec) > 1L) paste0("_", rec[[i]]$name) else ""
    # A median that is not reached is a property of the curve, not a failure:
    # the measure is absent and the diagnostics say so.
    if (is.finite(med)) measures <- c(measures, list(vcr_measure(paste0("median_survival", suffix), med, source = "reconstructed")))
    measures <- c(measures, list(vcr_measure(paste0("events", suffix), sum(ipd$status), source = "reconstructed")))
    events_total <- events_total + sum(ipd$status)
  }
  if (is.finite(log_hr)) measures <- c(measures, list(vcr_measure("log_hazard_ratio", log_hr, source = "reconstructed")))
  not_reached <- vapply(rec, function(r) !is.finite(vcr_km_median(vcr_km(r$recon$ipd$time, r$recon$ipd$status))), logical(1))
  curves <- list()
  for (i in seq_along(rec)) {
    r <- rec[[i]]
    nm <- if (length(rec) > 1L) c("对照组", "试验组")[i] else "对照组"
    original <- vcr_rows_df(arms[[i]]$curve)
    ot <- as.numeric(original$time); os <- as.numeric(original$surv)
    curves[[length(curves) + 1L]] <- vcr_series(paste0("published_", i), paste0(nm, "（原文曲线，数字化）"), ot, os, "extracted", dashed = TRUE,
                                                 at_risk = list(x = r$riskTime, n = r$atRisk))
    curves[[length(curves) + 1L]] <- vcr_km_series(r$recon$ipd$time, r$recon$ipd$status, NULL, paste0("reconstructed_", i),
                                                    paste0(nm, "（重建的伪个体）"), "reconstructed", ours = i == 2L)
  }
  list(status = "succeeded", measures = measures,
       counts = vcr_counts(realPatients = 0, events = events_total, reconstructedPseudoPatients = n_pseudo),
       diagnostics = list(curves = curves, qualityControl = if (length(qc) == 1L) qc[[1]] else qc, tolerances = tol, valueSource = "reconstructed",
                          provenance = sc$provenance,
                          medianNotReached = as.list(not_reached),
                          logHazardRatioReconstructed = if (is.finite(log_hr)) log_hr else NULL,
                          note = "Reconstructed pseudo-individuals are never counted as observed patients (AC-27)."),
       tables = .vcr_tables_of(list(vcr_write_table(ipd_all, "reconstructed-ipd", output_dir))))
}

# --- the weighted comparators ----------------------------------------------------

#' The tables and columns a job's outcome is read from, for the value source a
#' result states: a time-to-event outcome is the event table's `AVAL` and `CNSR`
#' (or the `time` and `status` of the engine's own long form in the subject
#' table), any other outcome is the one column the scenario names.
.vcr_outcome_parts <- function(sc, tabs, subj, endpoint) {
  if (identical(endpoint, "time_to_event")) {
    if (!is.null(tabs$event)) return(list(list(df = tabs$event, columns = c("AVAL", "CNSR"))))
    return(list(list(df = subj, columns = c("time", "status"))))
  }
  list(list(df = subj, columns = .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn")))
}

#' The outcome the weighting jobs analyse, joined to the subject table. A
#' time-to-event outcome is read from the event table (`AVAL` time, `CNSR` = 1
#' when censored, so `status = 1 - CNSR`); other endpoints read `outcomeColumn`
#' of the subject table.
vcr_outcome_frame <- function(sc, tabs, subj, endpoint) {
  if (identical(endpoint, "time_to_event")) {
    if (is.null(tabs$event)) {
      # The engine's own long form: a table another job wrote (a reconstruction's
      # pseudo-patients, a virtual-patient set) carries `time` and `status`
      # (1 = event) beside the arm, and is read as it is. Any other table has to
      # bring the event table.
      if (all(c("time", "status") %in% names(subj))) {
        tm <- suppressWarnings(as.numeric(subj$time)); st <- suppressWarnings(as.integer(subj$status))
        if (anyNA(tm) || anyNA(st) || !all(st %in% c(0L, 1L))) {
          vcr_abort("input_shape_invalid", "inputs", "`time` is a number and `status` is 1 for an event and 0 for a censored person, complete.")
        }
        return(list(time = tm, status = st))
      }
      vcr_abort("input_shape_invalid", "inputs", "A time-to-event analysis reads the event table (AVAL, CNSR); the job names none.")
    }
    ev <- vcr_event_frame(tabs$event, if (is.null(sc$parameterCode)) NULL else as.character(sc$parameterCode))
    if (!("USUBJID" %in% names(subj))) vcr_abort("input_shape_invalid", "inputs", "The subject table needs USUBJID to be joined to the event table.")
    m <- match(subj$USUBJID, ev$USUBJID)
    if (anyNA(m)) vcr_abort("input_shape_invalid", "inputs", "Every person in the subject table has a row in the event table.")
    return(list(time = ev$time[m], status = ev$status[m]))
  }
  oc <- .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn")
  if (!(oc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome column is not in the table.")
  list(y = suppressWarnings(as.numeric(subj[[oc]])))
}

.vcr_target_trial_limits <- function(sc) {
  items <- sc$targetTrial
  if (is.null(items) || !is.list(items)) return(character(0))
  bad <- vapply(items, function(it) is.list(it) && identical(as.character(it$emulation %||% ""), "cannot"), logical(1))
  vapply(items[bad], function(it) as.character(it$item %||% it$name %||% "item"), character(1))
}

#' The external-control weighting job: balance, diagnostics, an effect for the
#' scenario's endpoint and a whole-pipeline bootstrap. Refuses with a named rule
#' rather than reporting a number it cannot stand behind (AC-07).
#'
#' Hidden knowledge about the *endpoint*: this job used to be endpoint-blind and
#' computed the weighted mean of `outcomeColumn` whatever the endpoint was, so
#' a time-to-event external control returned the weighted mean of censored
#' follow-up times as "the effect", concluded estimable (EB-2). It now
#' dispatches: a continuous outcome gets the weighted mean difference, a binary
#' one the risk difference (with the risk ratio and odds ratio as secondaries),
#' a time-to-event one the weighted Kaplan-Meier RMST(tau) difference with the
#' survival difference at tau beside it. Every estimate sits inside the
#' bootstrap closure, so the weights are re-estimated in every resample.
vcr_job_weight_comparator <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  tabs <- vcr_job_tables(job)
  subj <- .vcr_main_table(tabs)
  vcr_require_individual(subj, "An external-control weighting", method = job$method)
  method <- if (identical(job$method, "comparator.propensity_weight")) "propensity" else "entropy_balance"
  estimand <- as.character(sc$estimand %||% vcr_domain()$defaultEstimand)
  if (!(estimand %in% vcr_domain()$estimands)) vcr_abort("scenario_value_invalid", "scenario.estimand", "The estimand is ATT, ATE or ATO.")
  if (identical(method, "entropy_balance") && !identical(estimand, "ATT")) {
    vcr_abort("scenario_value_invalid", "scenario.estimand", "Entropy balancing here reweights the controls to the treated group: it estimates the ATT and nothing else.")
  }
  cohort <- vcr_apply_downstream_cohort(subj, sc$cohortRules)
  keep <- cohort$keep
  subj <- cohort$data
  covs <- vcr_chr(sc$covariates)
  if (!length(covs)) vcr_abort("scenario_field_missing", "scenario.covariates", "A weighting names its covariates.")
  tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
  if (!all(c(covs, tc) %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.covariates", "The covariates and the treatment column are in the table.")
  treat_raw <- subj[[tc]]
  if (anyNA(treat_raw) || !all(treat_raw %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 for the trial arm and 0 for the external control, complete.")
  treat <- as.integer(treat_raw)
  X <- as.matrix(subj[, covs, drop = FALSE])
  if (!is.numeric(X)) vcr_abort("input_shape_invalid", "scenario.covariates", "Covariates are numeric (code categories as indicators).")
  miss <- which(colSums(is.na(X)) > 0L)
  if (length(miss)) vcr_abort("missing_covariate", "scenario.covariates", sprintf("Covariate '%s' has missing values; weights are not estimated on incomplete rows.", covs[miss[1]]))
  if (sum(treat == 1L) < 2L || sum(treat == 0L) < 2L) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "Both groups need at least two people.")

  endpoint <- as.character(sc$endpoint$type %||% (if (!is.null(sc$tau) || !is.null(tabs$event)) "time_to_event" else "continuous"))
  outcome <- vcr_outcome_frame(sc, tabs, subj, endpoint)
  if (!is.null(outcome$y)) {
    if (anyNA(outcome$y)) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome has missing values.")
    if (identical(endpoint, "binary") && !all(outcome$y %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "A binary outcome is 0/1.")
  }
  # the data this estimate rests on: the covariates, the arm and the outcome, not every column of the table
  used <- vcr_used_sources(c(list(list(df = subj, columns = c(covs, tc))), .vcr_outcome_parts(sc, tabs, subj, endpoint)))
  est_src <- vcr_estimate_source(used$source)
  data_src <- if (is.na(used$source)) "observed" else used$source
  tau <- vcr_scalar(sc$tau, NULL)
  if (identical(endpoint, "time_to_event")) {
    if (is.null(tau)) vcr_abort("scenario_field_missing", "scenario.tau", "A time-to-event comparison states the RMST horizon tau.")
    if (anyNA(outcome$time) || anyNA(outcome$status)) vcr_abort("input_shape_invalid", "inputs", "Time and status are complete.")
    rule <- vcr_tau_rule(outcome$time, outcome$status, treat, tau)
    if (!is.null(rule)) {
      return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(),
                  counts = vcr_counts(realPatients = nrow(subj), events = sum(outcome$status)),
                  diagnostics = c(rule, list(cohort = cohort$info, valueSourcesUsed = vcr_value_sources_used(used)))))
    }
  }

  fit_weights <- function(Xb, tb) {
    if (identical(method, "entropy_balance")) vcr_att_entropy_weights(Xb, tb, vcr_scalar(sc$moments, 1L))
    else list(allWeights = vcr_propensity_weights(Xb, tb, estimand)$weights)
  }
  fit <- if (identical(method, "entropy_balance")) fit_weights(X, treat)
         else { p <- vcr_propensity_weights(X, treat, estimand); list(allWeights = p$weights, converged = TRUE, propensity = p$propensity, rule = NULL) }
  if (is.null(fit$allWeights)) {
    return(list(status = "not_estimable", notEstimableRule = fit$rule %||% "entropy_balance_infeasible",
                measures = list(),
                counts = vcr_counts(realPatients = nrow(subj)),
                diagnostics = list(detail = fit$detail, method = method, cohort = cohort$info)))
  }
  w <- fit$allWeights
  balance <- vcr_balance_table(X, treat, w, estimand)
  ps <- vcr_propensity_weights(X, treat, "ATT")$propensity
  support <- vcr_common_support(ps, treat)
  ess <- vcr_ess(w[treat == 0L])
  # Every threshold that decides "not estimable" is the domain's: a scenario is
  # written by the run and may not loosen (or set) them (EB-5).
  rule <- vcr_not_estimable_weighting(balance = balance, ess = ess, support = support,
                                      ebal = if (identical(method, "entropy_balance")) fit else NULL)
  limits_used <- list(essFloor = vcr_limit("essFloor", 10), supportCeiling = vcr_limit("supportCeiling", 0.1),
                      smdFloor = vcr_limit("smdFloor", 0.1), bootstrapMin = vcr_limit("bootstrapMin", 2000))
  wdiag <- vcr_weight_diagnostics(w, treat)
  if (!is.null(rule)) {
    return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(),
                counts = vcr_counts(realPatients = nrow(subj), effectiveSampleSize = ess,
                                    events = if (identical(endpoint, "time_to_event")) sum(outcome$status) else NULL),
                diagnostics = list(detail = rule$detail, balance = balance, support = support, weights = wdiag,
                                   thresholds = limits_used, cohort = cohort$info)))
  }

  # one function of (weights, rows) -> the primary estimate followed by its secondaries
  est_of <- function(wv, idx) {
    tb <- treat[idx]; wb <- wv
    if (identical(endpoint, "time_to_event")) {
      tm <- outcome$time[idx]; st <- outcome$status[idx]
      r1 <- vcr_rmst(tm[tb == 1L], st[tb == 1L], tau, wb[tb == 1L], variance = FALSE)
      r0 <- vcr_rmst(tm[tb == 0L], st[tb == 0L], tau, wb[tb == 0L], variance = FALSE)
      s1 <- vcr_km_at(r1$km, tau); s0 <- vcr_km_at(r0$km, tau)
      return(c(r1$rmst - r0$rmst, r1$rmst, r0$rmst, s1 - s0))
    }
    yb <- outcome$y[idx]
    m1 <- stats::weighted.mean(yb[tb == 1L], wb[tb == 1L]); m0 <- stats::weighted.mean(yb[tb == 0L], wb[tb == 0L])
    if (identical(endpoint, "binary")) {
      lr <- if (m1 > 0 && m0 > 0) log(m1 / m0) else NA_real_
      lo <- if (m1 > 0 && m1 < 1 && m0 > 0 && m0 < 1) stats::qlogis(m1) - stats::qlogis(m0) else NA_real_
      return(c(m1 - m0, lr, lo))
    }
    m1 - m0
  }
  all_idx <- seq_len(nrow(subj))
  est <- est_of(w, all_idx)
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(nrow(subj), function(idx) {
    f <- fit_weights(X[idx, , drop = FALSE], treat[idx])
    if (is.null(f$allWeights)) return(rep(NA_real_, length(est)))
    est_of(f$allWeights, idx)
  }, replicates = B, seed = job$seed, strata = treat, cores = vcr_cores(job$cores))
  if (identical(boot$interrupted, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = nrow(subj)),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    return(list(status = "failed", measures = list(), counts = vcr_counts(realPatients = nrow(subj)),
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap; no interval is reported.")),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  ci <- function(j, transform = identity) {
    iv <- boot$intervals[j, ]
    if (anyNA(iv)) NULL else vcr_interval("confidence", transform(iv[1]), transform(iv[2]))
  }
  unit <- as.character(sc$timeUnit %||% "months")
  measures <- if (identical(endpoint, "time_to_event")) list(
    vcr_measure("rmst_difference", est[1], unit = unit, interval = ci(1), source = est_src),
    vcr_measure("rmst_treatment", est[2], unit = unit, interval = ci(2), source = est_src),
    vcr_measure("rmst_control", est[3], unit = unit, interval = ci(3), source = est_src),
    vcr_measure("survival_difference_at_tau", est[4], interval = ci(4), source = est_src))
  else if (identical(endpoint, "binary")) c(list(vcr_measure("weighted_difference", est[1], interval = ci(1), source = est_src)),
    if (is.finite(est[2])) list(vcr_measure("weighted_risk_ratio", exp(est[2]), interval = ci(2, exp), source = est_src)),
    if (is.finite(est[3])) list(vcr_measure("weighted_odds_ratio", exp(est[3]), interval = ci(3, exp), source = est_src)))
  else list(vcr_measure("weighted_difference", est[1], interval = ci(1), source = est_src))
  measures <- c(measures, list(
    vcr_measure("effective_sample_size", ess, source = est_src),
    vcr_measure("worst_standardized_difference", max(abs(balance$smdAdjusted)), source = est_src)))
  # weight truncation as a sensitivity analysis only (plan 5.3)
  cap <- stats::quantile(w[treat == 0L], 0.99, names = FALSE)
  wt <- w; wt[treat == 0L] <- pmin(wt[treat == 0L], cap)
  if (identical(estimand, "ATT")) wt[treat == 0L] <- wt[treat == 0L] * sum(treat == 1L) / sum(wt[treat == 0L])
  trunc_est <- tryCatch(est_of(wt, all_idx)[1], error = function(e) NA_real_)
  tt_limits <- .vcr_target_trial_limits(sc)
  changed <- !identical(estimand, "ATT")
  limited <- boot$failureShare > 0.01 || changed || length(tt_limits) > 0L
  list(status = "succeeded", measures = measures,
       conclusion = if (limited) "limited" else "estimable",
       counts = vcr_counts(realPatients = nrow(subj), effectiveSampleSize = ess,
                           events = if (identical(endpoint, "time_to_event")) sum(outcome$status) else NULL),
       diagnostics = list(method = method, estimand = estimand, endpoint = endpoint,
                          tau = if (identical(endpoint, "time_to_event")) tau else NULL,
                          curves = if (identical(endpoint, "time_to_event"))
                            vcr_arm_curves(outcome$time, outcome$status, treat, weights = w, source = data_src, tau = tau)
                          else NULL,
                          valueSourcesUsed = vcr_value_sources_used(used),
                          estimandChanged = changed,
                          balance = balance, support = support, weights = wdiag,
                          thresholds = limits_used,
                          bootstrapReplicates = boot$replicates, bootstrapFailureShare = boot$failureShare,
                          sensitivity = list(truncatedWeights = list(quantile = 0.99, primaryEstimate = trunc_est)),
                          limitedBy = as.list(c(if (boot$failureShare > 0.01) "bootstrap_failure_share",
                                                if (changed) "estimand_changed_from_att",
                                                if (length(tt_limits)) "target_trial_item_cannot_be_emulated")),
                          targetTrialCannot = as.list(tt_limits), cohort = cohort$info,
                          comparabilityDimensions = vcr_domain()$comparabilityDimensions),
       tables = .vcr_tables_of(list(
         vcr_write_table(balance, "balance", output_dir),
         vcr_write_table(data.frame(row = which(keep), arm = treat, weight = w), "weights", output_dir))))
}

vcr_job_rmst <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  if (!is.null(sc$weightColumn)) {
    vcr_abort("scenario_value_invalid", "scenario.weightColumn",
              "A weighted RMST is estimated by the weighting job, whose interval re-estimates the weights in every resample; this job compares unweighted arms.")
  }
  tabs <- vcr_job_tables(job)
  subj <- .vcr_main_table(tabs)
  vcr_require_individual(subj, "An RMST comparison", method = "comparator.rmst")
  cohort <- vcr_apply_downstream_cohort(subj, sc$cohortRules)
  subj <- cohort$data
  tau <- vcr_scalar(sc$tau, NULL)
  if (is.null(tau) || !(tau > 0)) vcr_abort("scenario_field_missing", "scenario.tau", "An RMST comparison states its horizon tau.")
  tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
  if (!(tc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is not in the table.")
  arm <- subj[[tc]]
  if (anyNA(arm) || !all(arm %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 or 0, complete.")
  arm <- as.integer(arm)
  o <- vcr_outcome_frame(sc, tabs, subj, "time_to_event")
  if (anyNA(o$time) || anyNA(o$status)) vcr_abort("input_shape_invalid", "inputs", "Time and status are complete.")
  # The counts follow the input's value source: a real person's row is a real
  # patient, a reconstructed pseudo-patient is counted apart and never as one
  # (contract 3.2, AC-27).
  counts <- vcr_table_counts(subj, events = sum(o$status))
  counts$events <- sum(o$status)
  used <- vcr_used_sources(c(list(list(df = subj, columns = tc)), .vcr_outcome_parts(sc, tabs, subj, "time_to_event")))
  est_src <- vcr_estimate_source(used$source)
  rule <- vcr_tau_rule(o$time, o$status, arm, tau)
  if (!is.null(rule)) {
    return(list(status = "not_estimable", notEstimableRule = rule$rule, measures = list(),
                counts = counts,
                diagnostics = c(rule, list(valueSourcesUsed = vcr_value_sources_used(used)))))
  }
  r <- vcr_rmst_difference(o$time, o$status, arm, tau)
  unit <- as.character(sc$timeUnit %||% "months")
  list(status = "succeeded",
       measures = list(
         vcr_measure("rmst_difference", r$estimate, unit = unit, source = est_src,
                     interval = vcr_interval("confidence", r$interval[1], r$interval[2])),
         vcr_measure("rmst_treatment", r$arm1, source = est_src), vcr_measure("rmst_control", r$arm0, source = est_src),
         vcr_measure("survival_difference_at_tau", as.numeric(r$survivalAtTau[1] - r$survivalAtTau[2]), source = est_src)),
       counts = counts,
       diagnostics = list(tau = tau, survivalAtTau = r$survivalAtTau, weighted = FALSE, cohort = cohort$info,
                          valueSourcesUsed = vcr_value_sources_used(used),
                          curves = vcr_arm_curves(o$time, o$status, arm, weights = NULL, source = if (is.na(used$source)) "observed" else used$source, tau = tau),
                          intervalBasis = "Greenwood-type variance of the unweighted Kaplan-Meier areas"))
}

#' The MAIC outcome column: named, present and numeric, or refused by name.
.vcr_maic_outcome <- function(subj, sc) {
  oc <- .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn")
  if (!(oc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome column is not in the table.")
  y <- suppressWarnings(as.numeric(subj[[oc]]))
  if (anyNA(y)) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome is a number, complete.")
  y
}

vcr_job_maic <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  if (identical(as.character(sc$endpoint$type %||% ""), "time_to_event")) {
    vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "This MAIC compares continuous and binary outcomes; a time-to-event MAIC is the method comparator.maic_time_to_event.")
  }
  subj <- .vcr_main_table(vcr_job_tables(job))
  vcr_require_individual(subj, "A MAIC", method = "comparator.maic")
  covs <- vcr_chr(sc$covariates)
  if (!all(covs %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.covariates", "The covariates are columns of the table.")
  X <- as.matrix(subj[, covs, drop = FALSE])
  miss <- which(colSums(is.na(X)) > 0L)
  if (length(miss)) vcr_abort("missing_covariate", "scenario.covariates", sprintf("Covariate '%s' has missing values.", covs[miss[1]]))
  targets <- vapply(sc$targets, function(v) vcr_scalar(v, NA_real_), numeric(1))
  if (anyNA(targets) || !all(covs %in% names(targets))) vcr_abort("scenario_value_invalid", "scenario.targets", "Every covariate has a numeric aggregate target.")
  link <- as.character(sc$link %||% "identity")
  boot <- list(replicates = vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL)), seed = job$seed, cores = vcr_cores(job$cores))
  # the data this estimate rests on: the matched covariates, the outcome and, anchored, the arm
  used <- vcr_used_sources(list(list(df = subj, columns = c(covs, .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn"),
    if (isTRUE(as.logical(sc$anchored))) .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")))))
  est_src <- vcr_estimate_source(used$source)
  res <- if (isTRUE(as.logical(sc$anchored))) {
    tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
    if (!(tc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is not in the table.")
    arm <- subj[[tc]]
    if (anyNA(arm) || !all(arm %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 or 0, complete.")
    y <- .vcr_maic_outcome(subj, sc)
    vcr_maic_anchored(data.frame(arm = as.integer(arm), y = y), X, targets, vcr_scalar(sc$aggregateEstimate), vcr_scalar(sc$aggregateSe), link, bootstrap = boot)
  } else {
    vcr_maic_unanchored(.vcr_maic_outcome(subj, sc), X, targets,
                        vcr_scalar(sc$aggregateOutcome), vcr_scalar(sc$aggregateSe), link, bootstrap = boot)
  }
  if (is.null(res$estimate)) {
    return(list(status = "not_estimable", notEstimableRule = res$rule %||% "entropy_balance_infeasible",
                measures = list(), counts = vcr_counts(realPatients = nrow(subj)),
                diagnostics = list(detail = res$detail, valueSourcesUsed = vcr_value_sources_used(used))))
  }
  list(status = "succeeded",
       conclusion = if (identical(res$conclusionCeiling, "limited")) "limited" else "estimable",
       measures = list(
         vcr_measure("indirect_estimate", res$estimate, source = est_src,
                     interval = vcr_interval("confidence", res$interval[1], res$interval[2])),
         vcr_measure("effective_sample_size", res$effectiveSampleSize, source = est_src)),
       counts = vcr_counts(realPatients = nrow(subj), effectiveSampleSize = res$effectiveSampleSize),
       diagnostics = list(anchored = res$anchored, targetPopulation = res$targetPopulation,
                          valueSourcesUsed = vcr_value_sources_used(used),
                          conclusionCeiling = res$conclusionCeiling %||% NULL,
                          varianceBasis = res$varianceBasis, se = res$se,
                          bootstrapReplicates = if (!is.null(res$bootstrap)) res$bootstrap$replicates else NULL,
                          bootstrapFailureShare = if (!is.null(res$bootstrap)) res$bootstrap$failureShare else NULL,
                          unadjustedEffectModifiers = sc$unadjustedEffectModifiers %||% list()))
}

# --- E-value -------------------------------------------------------------------

#' The E-value of a risk ratio on the "away from the null" side (VanderWeele &
#' Ding 2017): RR + sqrt(RR (RR - 1)) for RR >= 1, on the inverse for RR < 1.
.vcr_evalue_rr <- function(rr) { r <- if (rr < 1) 1 / rr else rr; r + sqrt(r * (r - 1)) }

#' Approximate risk ratio from the reported effect and its scale. An odds ratio
#' is close to a risk ratio only for a rare outcome (otherwise sqrt(OR)); a
#' hazard ratio likewise (otherwise (1 - 0.5^sqrt(HR)) / (1 - 0.5^sqrt(1/HR))).
.vcr_rr_from_scale <- function(x, scale, rare) {
  switch(scale,
    risk_ratio = x,
    odds_ratio = if (rare) x else sqrt(x),
    hazard_ratio = if (rare) x else (1 - 0.5^sqrt(x)) / (1 - 0.5^sqrt(1 / x)))
}

vcr_job_evalue <- function(job, ...) {
  sc <- job$scenario
  scale <- as.character(sc$scale %||% "risk_ratio")
  if (!(scale %in% c("risk_ratio", "odds_ratio", "hazard_ratio"))) vcr_abort("scenario_value_invalid", "scenario.scale", "The scale is risk_ratio, odds_ratio or hazard_ratio.")
  rare <- isTRUE(as.logical(sc$rare))
  rr <- vcr_scalar(sc$riskRatio, NULL)
  if (is.null(rr) || !(rr > 0)) vcr_abort("scenario_value_invalid", "scenario.riskRatio", "The effect is a positive ratio.")
  cl <- vcr_scalar(sc$confidenceLimit, NULL)
  if (!is.null(cl) && !(cl > 0)) vcr_abort("scenario_value_invalid", "scenario.confidenceLimit", "The confidence limit is a positive ratio.")
  # the limit that matters is the one nearer the null, so it lies on the null
  # side of the estimate (or on the null itself)
  if (!is.null(cl) && ((rr > 1 && cl > rr) || (rr < 1 && cl < rr))) {
    vcr_abort("scenario_value_invalid", "scenario.confidenceLimit", "The limit given is on the far side of the estimate; the E-value uses the limit closer to the null.")
  }
  rr_app <- .vcr_rr_from_scale(rr, scale, rare)
  point <- .vcr_evalue_rr(rr_app)
  bound <- if (!is.null(cl)) {
    if ((rr > 1 && cl <= 1) || (rr < 1 && cl >= 1)) 1 else .vcr_evalue_rr(.vcr_rr_from_scale(cl, scale, rare))
  } else NULL
  measures <- list(vcr_measure("e_value", point, source = "calculated"))
  if (!is.null(bound)) measures[[2]] <- vcr_measure("e_value_confidence_limit", bound, source = "calculated")
  list(status = "succeeded", measures = measures, counts = vcr_counts(),
       diagnostics = list(scale = scale, rare = rare, approximateRiskRatio = rr_app,
                          note = "An E-value is what an unmeasured confounder would have to be, not evidence that none exists."))
}

# --- MAP prior ------------------------------------------------------------------

vcr_job_map_prior <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  hist <- sc$historical
  if (is.null(hist)) vcr_abort("scenario_field_missing", "scenario.historical", "A MAP prior needs the historical control arms.")
  if (!is.null(hist$events)) {
    e <- vcr_num(hist$events); n <- vcr_num(hist$n)
    if (length(e) != length(n) || anyNA(c(e, n)) || any(e < 0) || any(e > n)) vcr_abort("scenario_value_invalid", "scenario.historical", "Events and sample sizes are paired, with events between 0 and n.")
    y <- stats::qlogis((e + 0.5) / (n + 1)); se <- sqrt(1 / (e + 0.5) + 1 / (n - e + 0.5))
    unit_var <- vcr_logit_unit_variance(sum(e) / sum(n))
  } else {
    y <- vcr_num(hist$estimate); se <- vcr_num(hist$se)
    if (length(y) != length(se) || anyNA(c(y, se)) || any(se <= 0)) vcr_abort("scenario_value_invalid", "scenario.historical", "Estimates and standard errors are paired, with positive standard errors.")
    unit_var <- vcr_scalar(sc$unitVariance, NULL)
    if (is.null(unit_var) || !(unit_var > 0)) {
      vcr_abort("scenario_field_missing", "scenario.unitVariance", "On the estimate/se path one subject's variance on the analysis scale (unitVariance) is required; the prior effective sample size is meaningless without it.")
    }
  }
  if (length(y) < 2L) vcr_abort("scenario_value_invalid", "scenario.historical", "A MAP prior needs at least two historical studies.")
  comps <- vcr_scalar(sc$components, 2L)
  if (!(comps %in% c(1, 2))) vcr_abort("scenario_value_invalid", "scenario.components", "The MAP is approximated by one or two normal components.")
  tau_prior <- sc$tauPrior %||% list(kind = "half_normal", scale = 0.5)
  tau_prior <- list(kind = as.character(tau_prior$kind %||% "half_normal"), scale = vcr_scalar(tau_prior$scale, 0.5))
  w_r <- vcr_scalar(sc$robustWeight, 0.2)
  if (!(w_r >= 0 && w_r <= 1)) vcr_abort("scenario_value_invalid", "scenario.robustWeight", "The robust weight is between 0 and 1.")
  map <- vcr_map_prior(y, se, tau_prior)
  mix <- vcr_map_normal_mixture(map, as.integer(comps))
  robust <- vcr_robustify(mix, w_r, unit_information_sd = sqrt(unit_var))
  ess_map <- vcr_prior_ess(mix, unit_var); ess_rob <- vcr_prior_ess(robust, unit_var)
  elir_map <- vcr_prior_ess_elir(mix, unit_var); elir_rob <- vcr_prior_ess_elir(robust, unit_var)
  ceiling_ <- vcr_ess_ceiling(map$tauPosteriorMedian, unit_var)
  bound <- vcr_limit("conflictBound", 0.01)
  cur <- sc$current
  conflict <- NULL
  if (!is.null(cur)) {
    cy <- vcr_scalar(cur$estimate, NA_real_); cse <- vcr_scalar(cur$se, NA_real_)
    if (is.na(cy) || is.na(cse) || !(cse > 0)) vcr_abort("scenario_value_invalid", "scenario.current", "The current control result is an estimate and a positive standard error.")
    # Conflict is judged against the MAP itself: the robust prior carries a
    # vague component that swallows almost any current result, so a conflict
    # tested against it can never fire (CE-13). The robust figure is reported
    # beside it.
    conflict <- list(mapOnly = vcr_map_conflict(mix, cy, cse, bound), robust = vcr_map_conflict(robust, cy, cse, bound))
  }
  oc <- NULL
  spec <- sc$operatingCharacteristics
  if (!is.null(spec)) {
    reps <- as.integer(job$replicates %||% 5000L)
    oc <- vcr_hybrid_operating_characteristics(
      mix, unit_var, vcr_scalar(spec$nControl), vcr_scalar(spec$nTreatment), vcr_num(spec$drifts), vcr_scalar(spec$effect, 0),
      robust_weights = { rw <- vcr_num(spec$robustWeights); if (length(rw)) rw else c(0.2, 0.5) },
      alpha = vcr_scalar(spec$alpha, 0.025), replicates = reps, seed = job$seed, cores = vcr_cores(job$cores),
      vague_sd = sqrt(unit_var))
  }
  if (!is.null(conflict) && !is.null(conflict$mapOnly$rule)) {
    return(list(status = "not_estimable", notEstimableRule = conflict$mapOnly$rule, measures = list(),
                counts = vcr_counts(priorEffectiveSampleSize = ess_rob),
                diagnostics = list(conflict = conflict, tau = map$tauPosteriorMedian, thresholds = list(conflictBound = bound))))
  }
  list(status = "succeeded",
       measures = list(
         vcr_measure("map_mean", map$mean, source = "aggregate"),
         vcr_measure("map_sd", map$sd, source = "aggregate"),
         vcr_measure("prior_effective_sample_size_moment", ess_rob, source = "aggregate"),
         vcr_measure("prior_effective_sample_size_elir", elir_rob, source = "aggregate"),
         vcr_measure("map_effective_sample_size_moment", ess_map, source = "aggregate"),
         vcr_measure("map_effective_sample_size_elir", elir_map, source = "aggregate"),
         vcr_measure("prior_effective_sample_size_ceiling", ceiling_, source = "aggregate"),
         vcr_measure("tau_posterior_median", map$tauPosteriorMedian, source = "aggregate")),
       counts = vcr_counts(priorEffectiveSampleSize = ess_rob),
       diagnostics = list(mixture = mix, robustMixture = robust, robustWeight = w_r,
                          essMapMoment = ess_map, essMapElir = elir_map, conflict = conflict, k = map$k,
                          thresholds = list(conflictBound = bound),
                          note = "Under strict type-I control, borrowing does not buy power (Kopp-Schneider 2020)."),
       tables = .vcr_tables_of(list(if (!is.null(oc)) vcr_write_table(oc, "operating-characteristics", output_dir))))
}

# --- design ---------------------------------------------------------------------

.VCR_ANALYTIC_DESIGNS <- c("two_arm_fixed", "group_sequential", "simon_two_stage", "single_arm")

vcr_job_design_analytic <- function(job, ...) {
  sc <- job$scenario
  d <- sc$design; e <- as.character(sc$endpoint$type %||% "")
  kind <- as.character(d$kind %||% "two_arm_fixed")
  if (!(kind %in% .VCR_ANALYTIC_DESIGNS)) vcr_abort("design_not_supported", "scenario.design.kind", sprintf("'%s' has no analytic calculation in this build.", kind))
  if (identical(kind, "simon_two_stage") && !identical(e, "binary")) {
    vcr_abort("design_not_supported", "scenario.endpoint.type", "Simon's two-stage design is a binary-endpoint design.")
  }
  if (identical(kind, "group_sequential") && !identical(e, "time_to_event")) {
    vcr_abort("design_not_supported", "scenario.endpoint.type", "The group-sequential calculation here is for a time-to-event endpoint.")
  }
  alpha <- vcr_scalar(sc$analysis$alpha, 0.025); power <- vcr_scalar(sc$analysis$power, 0.9)
  sided <- vcr_check_sided(sc$analysis$sided)
  alloc <- vcr_scalar(d$allocation, 0.5)
  tr <- sc$truth
  if(identical(kind,"single_arm")) {
    if(!identical(e,"binary"))vcr_abort("design_not_supported","scenario.endpoint.type","Exact single-arm analysis requires a binary endpoint.")
    ex<-vcr_exact_binomial(vcr_scalar(d$n),vcr_scalar(tr$nullRate),vcr_scalar(tr$responseRate),alpha,sc$analysis$alternative)
    return(list(status="succeeded",counts=vcr_counts(realPatients=0),measures=list(
      vcr_measure("type_one_error",ex$typeOneError,source="calculated"),vcr_measure("power",ex$power,source="calculated"),
      vcr_measure("sample_size",ex$n,source="calculated")),diagnostics=list(exactBinomial=ex)))
  }
  measures <- list(); diag <- list()
  add <- function(name, value, ...) measures[[length(measures) + 1L]] <<- vcr_measure(name, value, source = "calculated", ...)
  gs <- NULL; inflation <- 1
  if (identical(kind, "group_sequential")) {
    gs <- vcr_group_sequential(vcr_num(d$informationRates), alpha / sided, as.character(d$spending %||% "obrien_fleming"))
    for (k in seq_along(gs$criticalValues)) {
      add(sprintf("boundary_%d", k), gs$criticalValues[k])
      add(sprintf("cumulative_alpha_%d", k), gs$cumulativeAlphaSpent[k])
    }
    inflation <- vcr_gs_inflation(gs, power)
    diag$inflationFactor <- inflation
    diag$informationRates <- gs$informationRates
    diag$spending <- gs$spending
    fixed <- stats::qnorm(1 - alpha / sided) + stats::qnorm(power)
    h1 <- vcr_group_sequential_power(gs, sqrt(inflation) * fixed)
    h0 <- vcr_group_sequential_power(gs, 0)
    diag$expectedInformationFraction <- list(h0 = h0$expectedInformationFraction, h1 = h1$expectedInformationFraction)
  }
  if (identical(e, "time_to_event")) {
    hr <- .vcr_need(tr$hazardRatio, "scenario.truth.hazardRatio", "A time-to-event design states the hazard ratio.")
    ev <- vcr_events_schoenfeld(hr, alpha, power, alloc, sided)
    add("required_events", ceiling(ev)); add("required_events_exact", ev)
    if (!is.null(gs)) {
      add("max_events", ceiling(ev * inflation))
      add("expected_events_h0", ev * inflation * diag$expectedInformationFraction$h0)
      add("expected_events_h1", ev * inflation * diag$expectedInformationFraction$h1)
    }
    if (!is.null(sc$accrual)) {
      dist <- vcr_control_distribution(tr)
      lam <- if (identical(dist$kind %||% "exponential", "exponential")) dist$rate else log(2) / vcr_dist_median(dist)
      eta <- vcr_dropout_hazard(vcr_scalar(sc$accrual$dropoutAnnual, 0))
      A <- vcr_scalar(sc$accrual$duration, 0); Fu <- vcr_scalar(sc$accrual$followup, NA_real_)
      if (is.na(Fu)) vcr_abort("scenario_field_missing", "scenario.accrual.followup", "The required-patients calculation needs the follow-up after accrual.")
      p0 <- vcr_event_probability(lam, A, Fu, eta)
      p1 <- vcr_event_probability(lam * hr, A, Fu, eta)
      # Lachin-Foulkes: the expected event probability of a randomized subject
      # averages the two arms' probabilities, weighted by allocation; the first
      # version used the control arm's alone and so overstated the events per
      # patient and understated N (CE-10).
      p_ev <- (1 - alloc) * p0 + alloc * p1
      add("event_probability", p_ev); add("event_probability_control", p0); add("event_probability_treatment", p1)
      add("required_patients", ceiling(ev / p_ev))
      if (!is.null(gs)) add("max_patients", ceiling(ev * inflation / p_ev))
    }
  } else if (identical(e, "continuous")) {
    eff <- .vcr_need(tr$effect, "scenario.truth.effect", "A continuous design states the effect to detect.")
    n <- vcr_n_means(eff, vcr_scalar(tr$sd, 1), alpha, power, alloc, sided)
    add("required_total", ceiling(n$total)); add("required_per_arm", ceiling(n$total * alloc))
  } else if (identical(e, "binary") && identical(kind, "two_arm_fixed")) {
    p0 <- vcr_scalar(tr$controlRate, NULL)
    p1 <- vcr_binary_treatment_rate(p0, vcr_scalar(tr$treatmentRate, NULL), vcr_scalar(tr$riskDifference, NULL), vcr_scalar(tr$oddsRatio, NULL))
    n <- vcr_n_proportions(p0, p1, alpha, power, alloc, sided)
    add("required_total", ceiling(n$total)); add("required_control", ceiling(n$control))
  }
  if (identical(kind, "simon_two_stage")) {
    p_null <- .vcr_need(tr$nullRate, "scenario.truth.nullRate", "Simon's design states the null response rate."); p_alt <- .vcr_need(tr$alternativeRate, "scenario.truth.alternativeRate", "Simon's design states the alternative response rate.")
    s <- vcr_simon_two_stage(p_null, p_alt, alpha = alpha, beta = 1 - power, n_max = as.integer(vcr_scalar(d$maxN, 100L)))
    diag$simon <- s
    if (!is.null(s$optimal)) {
      add("simon_optimal_n", s$optimal$n); add("simon_optimal_n1", s$optimal$n1)
      add("simon_optimal_r1", s$optimal$r1); add("simon_optimal_r", s$optimal$r)
      add("simon_optimal_expected_n", s$optimal$EN0)
    }
    if (!is.null(s$minimax)) {
      add("simon_minimax_n", s$minimax$n); add("simon_minimax_n1", s$minimax$n1)
      add("simon_minimax_r1", s$minimax$r1); add("simon_minimax_r", s$minimax$r)
    }
  }
  # what the trial page draws: the power of this design over the true effect, and how
  # the required size moves if the stated effect is off by a fifth
  if (identical(kind, "two_arm_fixed")) {
    n_total <- if (identical(e, "time_to_event")) NULL else if (identical(e, "continuous")) ceiling(vcr_n_means(
      vcr_scalar(tr$effect, NA_real_), vcr_scalar(tr$sd, 1), alpha, power, alloc, sided)$total) else {
      p0 <- vcr_scalar(tr$controlRate, NULL)
      p1 <- vcr_binary_treatment_rate(p0, vcr_scalar(tr$treatmentRate, NULL), vcr_scalar(tr$riskDifference, NULL), vcr_scalar(tr$oddsRatio, NULL))
      ceiling(vcr_n_proportions(p0, p1, alpha, power, alloc, sided)$total)
    }
    diag$powerCurve <- tryCatch({
      sc2 <- sc
      if (!is.null(n_total)) sc2$design <- list(kind = kind, nTreat = ceiling(n_total * alloc), nControl = ceiling(n_total * (1 - alloc)))
      else if (!is.null(sc$accrual)) {
        m_req <- Filter(function(m) identical(m$name, "required_patients"), measures)
        if (length(m_req)) sc2$design <- list(kind = kind, nTreat = ceiling(m_req[[1]]$value * alloc), nControl = ceiling(m_req[[1]]$value * (1 - alloc)))
      }
      if (is.null(sc2$design$nTreat)) NULL else vcr_power_curve_summary(sc2, alpha, sided)
    }, error = function(err) NULL)
    diag$sensitivity <- tryCatch(vcr_analytic_sensitivity(e, tr, alpha, power, alloc, sided, measures), error = function(err) NULL)
  }
  list(status = "succeeded", measures = measures, counts = vcr_counts(), diagnostics = diag)
}

#' Required size at the stated effect and at 80% and 120% of it, one parameter at a time.
vcr_analytic_sensitivity <- function(e, tr, alpha, power, alloc, sided, measures) {
  wiggle <- c(0.8, 1.2)
  base_of <- function(name) { m <- Filter(function(x) identical(x$name, name), measures); if (length(m)) m[[1]]$value else NA_real_ }
  if (identical(e, "time_to_event")) {
    hr <- vcr_scalar(tr$hazardRatio, NULL); if (is.null(hr)) return(NULL)
    ev <- vapply(wiggle, function(k) vcr_events_schoenfeld(exp(k * log(hr)), alpha, power, alloc, sided), numeric(1))
    return(list(measure = "所需事件数", base = list(value = base_of("required_events")),
                rows = list(list(label = "效应（log 风险比）", range = sprintf("HR %.3g–%.3g", exp(0.8 * log(hr)), exp(1.2 * log(hr))),
                                 low = ceiling(min(ev)), high = ceiling(max(ev))))))
  }
  if (identical(e, "continuous")) {
    eff <- vcr_scalar(tr$effect, NULL); if (is.null(eff)) return(NULL)
    n <- vapply(wiggle, function(k) vcr_n_means(eff * k, vcr_scalar(tr$sd, 1), alpha, power, alloc, sided)$total, numeric(1))
    sdv <- vapply(wiggle, function(k) vcr_n_means(eff, vcr_scalar(tr$sd, 1) * k, alpha, power, alloc, sided)$total, numeric(1))
    return(list(measure = "所需总样本量", base = list(value = base_of("required_total")),
                rows = list(list(label = "效应", range = sprintf("%.3g–%.3g", eff * 0.8, eff * 1.2), low = ceiling(min(n)), high = ceiling(max(n))),
                            list(label = "标准差", range = sprintf("%.3g–%.3g", vcr_scalar(tr$sd, 1) * 0.8, vcr_scalar(tr$sd, 1) * 1.2), low = ceiling(min(sdv)), high = ceiling(max(sdv))))))
  }
  p0 <- vcr_scalar(tr$controlRate, NULL)
  p1 <- vcr_binary_treatment_rate(p0, vcr_scalar(tr$treatmentRate, NULL), vcr_scalar(tr$riskDifference, NULL), vcr_scalar(tr$oddsRatio, NULL))
  clip <- function(p) pmin(pmax(p, 0.001), 0.999)
  n <- vapply(wiggle, function(k) vcr_n_proportions(p0, clip(p0 + k * (p1 - p0)), alpha, power, alloc, sided)$total, numeric(1))
  list(measure = "所需总样本量", base = list(value = base_of("required_total")),
       rows = list(list(label = "两组事件率之差", range = sprintf("%.3g–%.3g", 0.8 * (p1 - p0), 1.2 * (p1 - p0)), low = ceiling(min(n)), high = ceiling(max(n)))))
}

vcr_job_design_simulate <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  cp <- if (is.null(output_dir)) NULL else file.path(output_dir, "checkpoint.rds")
  if (!is.null(output_dir)) dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)
  sc <- job$scenario
  res <- vcr_run_simulation(sc, job$seed, job$replicates, vcr_cores(job$cores),
                            checkpoint = cp, cancel_file = cancel_file,
                            batch_size = vcr_scalar(job$batchSize, 500L), progress = progress,
                            cpu_seconds_limit = vcr_scalar(job$cpuSecondsLimit, Inf))
  check <- tryCatch(vcr_analytic_check(sc, res$measures), error = function(e) NULL)
  tables <- if (!is.null(output_dir) && !is.null(res$values) && nrow(res$values)) {
    .vcr_tables_of(list(vcr_write_table(as.data.frame(res$values), "replicates", output_dir)))
  } else list()
  # A finished run's checkpoint is dead weight: it holds a copy of every
  # replicate and the directory is what gets shipped.
  if (!is.null(cp) && file.exists(cp) && identical(res$status, "succeeded")) unlink(cp)
  n_per <- vcr_scalar(sc$design$nTreat, 0) + vcr_scalar(sc$design$nControl, vcr_scalar(sc$design$nTreat, 0))
  generated<-if(!is.null(res$values) && "generatedRecords" %in% colnames(res$values))sum(res$values[,"generatedRecords"],na.rm=TRUE) else res$diagnostics$replicatesCompleted*n_per
  # the analytic power curve at this size with the simulated point on it: analytic first, the simulation as the check
  simulated <- Filter(function(m) identical(m$name, "power"), res$measures)
  curve <- tryCatch(vcr_power_curve_summary(sc, vcr_scalar(sc$analysis$alpha, 0.025), vcr_check_sided(sc$analysis$sided),
                                            if (length(simulated)) list(value = simulated[[1]]$value, mcse = simulated[[1]]$mcse %||% NA_real_) else NULL),
                    error = function(e) NULL)
  list(status = res$status, measures = res$measures, issues = res$issues,
       notEstimableRule = res$notEstimableRule,
       conclusion = res$diagnostics$conclusion,
       counts = vcr_counts(realPatients = 0, generatedRecords = generated),
       diagnostics = c(res$diagnostics, list(analyticCheck = check, powerCurve = curve)),
       tables = tables)
}

vcr_job_design_grid <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  sc <- job$scenario
  designs <- sc$designs; truths <- sc$truths
  if (!is.list(designs) || !length(designs) || !is.list(truths) || !length(truths)) {
    vcr_abort("scenario_field_missing", "scenario.designs", "A grid lists its designs and its truth scenarios.")
  }
  cells <- vcr_design_grid(sc, designs, truths, job$seed, job$replicates,
                           vcr_cores(job$cores), cancel_file,
                           checkpoint_dir = output_dir, progress = progress,
                           batch_size = vcr_scalar(job$batchSize, 500L),
                           cpu_seconds_limit = vcr_scalar(job$cpuSecondsLimit, Inf))
  long <- do.call(rbind, lapply(cells, function(c_) {
    if (!length(c_$measures)) {
      return(data.frame(designIndex = c_$designIndex, truthIndex = c_$truthIndex, parameters = c_$parameters,
                        measure = NA_character_, value = NA_real_, mcse = NA_real_, simulated = NA, status = c_$status,
                        stringsAsFactors = FALSE))
    }
    do.call(rbind, lapply(c_$measures, function(m) data.frame(
      designIndex = c_$designIndex, truthIndex = c_$truthIndex, parameters = c_$parameters,
      measure = m$name, value = m$value, mcse = m$mcse %||% NA_real_, simulated = isTRUE(m$simulated),
      status = c_$status, stringsAsFactors = FALSE)))
  }))
  statuses <- vapply(cells, function(c_) c_$status, character(1))
  status <- if (any(statuses == "canceled")) "canceled"
            else if (all(statuses == "failed")) "failed"
            else "succeeded"
  done <- sum(vapply(cells, function(c_) as.numeric(c_$diagnostics$replicatesCompleted %||% 0), numeric(1)))
  issues <- list()
  if (any(statuses == "failed")) issues <- list(vcr_issue("grid_cell_failed", "scenario",
    sprintf("%d of %d cells did not complete; the table names each cell's status.", sum(statuses == "failed"), length(statuses))))
  if (any(vapply(cells, function(c_) isTRUE(c_$diagnostics$overCpuBudget), logical(1)))) {
    issues <- c(issues, list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit",
      "The CPU budget ran out during the grid; the cells that finished are reported and the rest were not run.")))
  }
  list(status = status,
       measures = list(vcr_measure("cells", length(cells), source = "calculated")),
       counts = vcr_counts(),
       issues = issues,
       diagnostics = list(replicatesCompleted = done,
                          # the cells with their numbers: the page draws the heat grid from these (the full table stays a CSV)
                          cells = lapply(cells, function(c_) list(designIndex = c_$designIndex, truthIndex = c_$truthIndex, seed = c_$seed,
                                                                  scenarioHash = c_$scenarioHash, status = c_$status,
                                                                  refusal = if (!is.null(c_$refusal)) c_$refusal$code else NULL,
                                                                  measures = lapply(c_$measures, function(m) list(name = m$name, value = m$value, mcse = m$mcse))))),
       tables = .vcr_tables_of(list(vcr_write_table(long, "operating-characteristics", output_dir))))
}

vcr_job_assurance <- function(job, ...) {
  sc <- job$scenario
  prior <- sc$designPrior
  if (!is.list(prior)) vcr_abort("scenario_field_missing", "scenario.designPrior", "Assurance needs the design prior.")
  basis <- as.character(prior$basis %||% "prediction")
  if (identical(basis, "confidence") && !isTRUE(as.logical(prior$basisOverride))) {
    vcr_abort("scenario_value_invalid", "scenario.designPrior.basis",
              "A design prior built from a confidence interval understates the spread of a new trial; use the prediction distribution, or set basisOverride to say this is deliberate.")
  }
  e <- as.character(sc$endpoint$type %||% "")
  alpha <- vcr_scalar(sc$analysis$alpha, 0.025); sided <- vcr_check_sided(sc$analysis$sided)
  kind <- as.character(prior$kind %||% "normal")
  pmean <- vcr_scalar(prior$mean, NULL); psd <- vcr_scalar(prior$sd, NULL)
  if (is.null(pmean) || is.null(psd) || !(psd > 0)) vcr_abort("scenario_value_invalid", "scenario.designPrior", "A design prior has a mean and a positive sd.")
  n1 <- vcr_scalar(sc$design$nTreat, NULL); n0 <- vcr_scalar(sc$design$nControl, n1)
  # A lognormal prior on a hazard ratio is a normal prior on log(HR) with the
  # same two numbers, so for a time-to-event endpoint the two kinds agree; on
  # the other endpoints the effect is not a ratio and only `normal` applies.
  if (identical(kind, "lognormal") && !identical(e, "time_to_event")) {
    vcr_abort("scenario_value_invalid", "scenario.designPrior.kind", "A lognormal design prior is for a hazard ratio; this endpoint's effect is a difference (normal).")
  }
  out <- if (identical(e, "time_to_event")) {
    vcr_assurance_loghr(pmean, psd, vcr_scalar(sc$design$events, NULL), alpha, vcr_scalar(sc$design$allocation, 0.5), sided)
  } else if (identical(e, "binary")) {
    p0 <- vcr_scalar(sc$truth$controlRate, NULL)
    if (is.null(p0)) vcr_abort("scenario_field_missing", "scenario.truth.controlRate", "A binary assurance states the control rate.")
    vcr_assurance_binary(p0, list(kind = "normal", mean = pmean, sd = psd), n1, n0, alpha, sided)
  } else {
    vcr_assurance_means(pmean, psd, vcr_scalar(sc$truth$sd, 1), n1, n0, alpha, sided)
  }
  list(status = "succeeded",
       measures = list(vcr_measure("assurance", out$assurance, source = "calculated"),
                       vcr_measure("power_at_prior_mean", out$power, source = "calculated")),
       counts = vcr_counts(),
       diagnostics = list(designPrior = prior, priorBasis = basis, priorKind = kind,
                          priorMassOutsideUnitInterval = out$priorMassOutsideUnitInterval,
                          note = "Assurance integrates power over the design prior; it is not a trial-success prediction score."))
}

vcr_job_procova <- function(job, ...) {
  sc <- job$scenario
  ep <- sc$endpoint$type
  if (!is.null(ep) && !identical(as.character(ep), "continuous")) {
    vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "The PROCOVA sample-size formula is for a continuous endpoint; a binary or time-to-event endpoint needs simulation and is labelled exploratory.")
  }
  eff <- .vcr_need(sc$truth$effect, "scenario.truth.effect", "A PROCOVA calculation states the effect to detect.")
  rho <- .vcr_need(sc$prognostic$rho, "scenario.prognostic.rho", "A PROCOVA calculation states the (out-of-sample) correlation rho.")
  sd <- vcr_scalar(sc$truth$sd, 1); alpha <- vcr_scalar(sc$analysis$alpha, 0.025); power <- vcr_scalar(sc$analysis$power, 0.9)
  sided <- vcr_check_sided(sc$analysis$sided)
  lambda <- vcr_scalar(sc$prognostic$lambda, 1); gamma <- vcr_scalar(sc$prognostic$gamma, 1)
  alloc <- vcr_scalar(sc$design$allocation, 0.5)
  paths <- vcr_procova_paths(eff, sd, alpha, power, rho, vcr_scalar(sc$prognostic$rhoOrdinary, 0), lambda, gamma, alloc, sided)
  sens <- vcr_procova_sensitivity(eff, sd, alpha, power, lambda = lambda, gamma = gamma, allocation = alloc, sided = sided)
  list(status = "succeeded",
       measures = list(
         vcr_measure("variance_ratio", paths$prognosticScore$varianceRatio, source = "calculated"),
         vcr_measure("required_total_unadjusted", ceiling(paths$unadjusted$total), source = "calculated"),
         vcr_measure("required_total_prognostic", ceiling(paths$prognosticScore$total), source = "calculated"),
         vcr_measure("required_total_prognostic_undiscounted", ceiling(paths$undiscountedPrognosticScore$total), source = "calculated")),
       counts = vcr_counts(),
       diagnostics = list(paths = paths, sensitivity = sens,
                          note = "The platform ships no prognostic model; rho must be measured out of sample."))
}

# --- accrual --------------------------------------------------------------------

vcr_job_accrual <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  sites <- sc$sites
  if (!is.list(sites) || !length(sites)) vcr_abort("scenario_field_missing", "scenario.sites", "An accrual forecast lists its sites, each with its rate posterior.")
  alpha <- vapply(sites, function(s) vcr_scalar(s$alpha, NA_real_), numeric(1))
  beta <- vapply(sites, function(s) vcr_scalar(s$beta, NA_real_), numeric(1))
  start <- vapply(sites, function(s) vcr_scalar(s$startTime, 0), numeric(1))
  enrolled <- vapply(sites, function(s) vcr_scalar(s$enrolled, 0), numeric(1))
  if (anyNA(alpha) || anyNA(beta) || any(alpha <= 0) || any(beta <= 0)) vcr_abort("scenario_value_invalid", "scenario.sites", "Every site has a positive rate posterior (alpha, beta).")
  if (any(enrolled < 0)) vcr_abort("scenario_value_invalid", "scenario.sites", "Enrolled counts are not negative.")
  target <- vcr_scalar(sc$target, NULL)
  if (is.null(target) || !(target >= 1) || target != round(target)) vcr_abort("scenario_value_invalid", "scenario.target", "The target is a positive whole number of patients.")
  remaining <- max(0, target - sum(enrolled))
  sf <- sc$screenFailure
  screen <- if (is.null(sf)) NULL else list(alpha = vcr_scalar(sf$alpha, NA_real_), beta = vcr_scalar(sf$beta, NA_real_))
  if (!is.null(screen) && (anyNA(unlist(screen)) || any(unlist(screen) <= 0))) vcr_abort("scenario_value_invalid", "scenario.screenFailure", "The screen-failure prior is a Beta(alpha, beta) with positive parameters.")
  # a site that is already open contributes from now on; the process is
  # memoryless, so a negative start time is a zero
  model <- vcr_accrual_model(length(sites), alpha, beta, pmax(start, 0), screen)
  ev_target <- vcr_scalar(sc$eventTarget, NULL); ev_h <- vcr_scalar(sc$eventHazard, NULL)
  if (!is.null(ev_target)) {
    if (is.null(ev_h) || !(ev_h > 0)) vcr_abort("scenario_field_missing", "scenario.eventHazard", "A target event count needs the per-patient event hazard (per month).")
    if (!(ev_target >= 1 && ev_target <= target)) vcr_abort("scenario_value_invalid", "scenario.eventTarget", "The event target is between 1 and the enrolment target.")
  }
  reps <- as.integer(job$replicates %||% 20000L)
  by <- vcr_num(sc$byTimes)
  simultaneous <- length(unique(model$startTimes)) == 1L && length(unique(model$beta)) == 1L
  closed <- simultaneous && is.null(screen) && is.null(ev_target) && remaining > 0
  probs <- c(0.05, 0.1, 0.2, 0.5, 0.8, 0.9, 0.95)
  if (remaining == 0) {
    return(list(status = "succeeded",
                measures = list(vcr_measure("last_patient_in_months", 0, source = "calculated",
                                            note = "The enrolment target is already met.")),
                counts = vcr_counts(), diagnostics = list(remaining = 0, quantiles = as.list(stats::setNames(rep(0, length(probs)), paste0("p", probs * 100))))))
  }
  measures <- list(); tables <- list(); diag <- list()
  if (closed) {
    grid <- if (length(by)) by else seq_len(min(120L, max(1L, ceiling(vcr_accrual_closed_form(model, remaining, probs = 0.95)$quantiles[[1]]))))
    cf <- vcr_accrual_closed_form(model, remaining, probs = probs, by_times = grid)
    q <- cf$quantiles
    measures[[1]] <- vcr_measure("last_patient_in_months", q[["p50"]], source = "calculated",
      interval = vcr_interval("prediction", q[["p10"]], q[["p90"]], 0.8))
    tables[[1]] <- vcr_write_table(data.frame(month = grid, probability = as.numeric(cf$probabilityBy), mcse = NA_real_), "probability_by_month", output_dir)
    diag <- list(quantiles = as.list(q), mean = cf$mean, closedForm = TRUE, remaining = remaining,
                 meanNote = if (is.na(cf$mean)) "The mean completion time is undefined when the total rate shape N*alpha is 1 or less; the quantiles are unaffected." else NULL)
  } else {
    sim <- vcr_accrual_simulate(model, remaining, reps, job$seed, vcr_cores(job$cores), probs = probs, by_times = NULL,
                                randomized_target = !is.null(screen), event_target = ev_target, event_hazard = ev_h)
    if (!is.null(sim$interrupted)) {
      return(list(status = if (identical(sim$interrupted, "canceled")) "canceled" else "failed",
                  measures = list(), counts = vcr_counts(),
                  issues = if (identical(sim$interrupted, "cpu_budget")) list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the forecast finished.")) else list(),
                  diagnostics = list(replicatesCompleted = sim$replicates)))
    }
    t_end <- sim$samples[is.finite(sim$samples)]
    if (length(t_end) < 20L) vcr_abort("scenario_value_invalid", "scenario.sites", "Under these rates the enrolment target is almost never reached; no forecast is reported.")
    q <- stats::quantile(t_end, probs, names = FALSE, type = 7); names(q) <- paste0("p", probs * 100)
    measures[[1]] <- vcr_measure("last_patient_in_months", q[["p50"]], simulated = TRUE, mcse = vcr_quantile_mcse(t_end, 0.5),
      interval = vcr_interval("prediction", q[["p10"]], q[["p90"]], 0.8), source = "calculated")
    grid <- if (length(by)) by else seq_len(min(120L, max(1L, ceiling(q[["p95"]]))))
    pby <- vapply(grid, function(m) mean(t_end <= m), numeric(1))
    tables[[1]] <- vcr_write_table(data.frame(month = grid, probability = pby, mcse = sqrt(pby * (1 - pby) / length(t_end))), "probability_by_month", output_dir)
    diag <- list(quantiles = as.list(q), mean = mean(t_end), meanMcse = stats::sd(t_end) / sqrt(length(t_end)), closedForm = FALSE,
                 remaining = remaining, replicatesCompleted = sim$replicates, unreachableShare = sim$unreachableShare)
    if (!is.null(ev_target)) {
      ev <- sim$eventSamples[is.finite(sim$eventSamples)]
      qe <- stats::quantile(ev, probs, names = FALSE, type = 7); names(qe) <- paste0("p", probs * 100)
      measures[[2]] <- vcr_measure("target_events_months", qe[["p50"]], simulated = TRUE, mcse = vcr_quantile_mcse(ev, 0.5),
        interval = vcr_interval("prediction", qe[["p10"]], qe[["p90"]], 0.8), source = "calculated")
      diag$eventQuantiles <- as.list(qe)
    }
  }
  list(status = "succeeded", measures = measures, counts = vcr_counts(),
       diagnostics = c(diag, list(model = list(nSites = model$nSites, meanRatePerSite = model$meanRatePerSite),
                                  unavailable = list(screenFailureRate = is.null(screen)))),
       tables = .vcr_tables_of(tables))
}

# --- matching --------------------------------------------------------------------

#' Kleene three-valued eligibility, with `not_applicable` kept apart from
#' `unknown` (plan 7.1). Deterministic: the language model's job ended when it
#' produced the structured criteria and the located evidence.
#'
#' Hidden knowledge: a criterion that does not apply to this patient means the
#' opposite for the two kinds. An inclusion that cannot apply cannot exclude
#' (it is satisfied); an *exclusion* that cannot apply is not triggered (it is
#' not satisfied). The first version set every not-applicable criterion to
#' "satisfied", so the pregnancy exclusion of a man read as "this exclusion
#' holds" and made him ineligible (CE-18).
vcr_job_match_criteria <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  criteria <- sc$criteria
  if (!is.list(criteria) || !length(criteria)) vcr_abort("scenario_field_missing", "scenario.criteria", "Matching needs the structured criteria.")
  states_ok <- c(vcr_domain()$criterionStates, "pending_recheck")
  get <- function(c_, key, default) as.character(c_[[key]] %||% default)
  states <- vapply(criteria, function(c_) get(c_, "state", "unknown"), character(1))
  kinds <- vapply(criteria, function(c_) get(c_, "kind", "inclusion"), character(1))
  bad_state <- which(!(states %in% states_ok))
  if (length(bad_state)) vcr_abort("scenario_value_invalid", sprintf("scenario.criteria[%d].state", bad_state[1] - 1L), "A criterion state is satisfied, not_satisfied, unknown or pending_recheck.")
  bad_kind <- which(!(kinds %in% c("inclusion", "exclusion")))
  if (length(bad_kind)) vcr_abort("scenario_value_invalid", sprintf("scenario.criteria[%d].kind", bad_kind[1] - 1L), "A criterion is an inclusion or an exclusion.")
  applicable <- vapply(criteria, function(c_) !isTRUE(as.logical(c_$notApplicable)), logical(1))
  eff <- states
  eff[!applicable & kinds == "inclusion"] <- "satisfied"       # cannot apply, so cannot exclude
  eff[!applicable & kinds == "exclusion"] <- "not_satisfied"   # cannot apply, so is not triggered
  inc <- eff[kinds == "inclusion"]
  exc <- eff[kinds == "exclusion"]
  # Inclusion: all must hold. Exclusion: none may hold. `unknown` on either
  # side blocks a positive verdict but is not a negative one.
  summary <- if (any(inc == "not_satisfied") || any(exc == "satisfied")) "ineligible"
             else if (any(inc == "unknown") || any(exc == "unknown")) "insufficient_evidence"
             else if (any(eff == "pending_recheck")) "pending"
             else "eligible"
  tbl <- data.frame(criterion = vapply(criteria, function(c_) get(c_, "id", ""), character(1)),
                    kind = kinds, type = vapply(criteria, function(c_) get(c_, "type", "other"), character(1)),
                    state = states, notApplicable = !applicable, effectiveState = eff, stringsAsFactors = FALSE)
  list(status = "succeeded",
       measures = list(
         vcr_measure("criteria_total", length(criteria), source = "calculated"),
         vcr_measure("criteria_unknown", sum(states == "unknown"), source = "calculated"),
         vcr_measure("criteria_not_satisfied", sum(states == "not_satisfied"), source = "calculated")),
       counts = vcr_counts(realPatients = 1),
       diagnostics = list(eligibility = summary, criteria = tbl,
                          logic = "kleene_three_valued"),
       tables = .vcr_tables_of(list(vcr_write_table(tbl, "criteria", output_dir))))
}
