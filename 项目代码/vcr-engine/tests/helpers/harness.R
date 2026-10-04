# ---------------------------------------------------------------------------
# harness.R — a one-line-per-case runner.
#
# Hidden knowledge: the output format is a contract with the release process,
# not a convenience. Every line is
#
#     <ID> PASS|FAIL <AC tags> | <the actual numbers>
#
# and the last line is `PASSED x/y`, because the acceptance table is built by
# grepping these lines. A case that prints "ok" without its numbers cannot be
# put in front of a reviewer and is therefore treated as a failure of the
# case, not of the code: `vcr_case()` requires a `detail` string.
#
# Cases are deliberately not testthat: the engine's container has no testthat,
# and a numeric acceptance case whose failure message is "expect_equal(...)
# is not TRUE" is worth less than one whose failure message is the two
# numbers and the tolerance.
# ---------------------------------------------------------------------------

.vcr_test_env <- new.env(parent = emptyenv())
.vcr_test_env$results <- list()
.vcr_test_env$only <- Sys.getenv("VCR_TEST_ONLY", "")
.vcr_test_env$methods_run <- character(0)
.vcr_test_env$methods_by_case <- list()
.vcr_test_env$current <- ""
.vcr_test_env$root <- NULL

#' Register and run one case.
#'
#' @param id `N01`, `C2-03`, `E02` ... printed first so the line is greppable.
#' @param ac character vector of acceptance-scenario ids this case covers.
#' @param fn a function returning list(pass = <logical>, detail = "<numbers>").
vcr_case <- function(id, ac, fn) {
  if (nzchar(.vcr_test_env$only) && !grepl(.vcr_test_env$only, id)) return(invisible(NULL))
  started <- Sys.time()
  .vcr_test_env$current <- id
  out <- tryCatch(fn(), error = function(e) list(pass = FALSE, detail = paste("error:", conditionMessage(e))))
  secs <- as.numeric(difftime(Sys.time(), started, units = "secs"))
  pass <- isTRUE(out$pass)
  detail <- out$detail
  # A detail built from a missing value is `character(0)`, which printed nothing
  # at all — a failing case must always say something.
  if (!length(detail) || !nzchar(detail[[1]])) detail <- "(no detail: the case produced none — a value it reports is missing)"
  detail <- detail[[1]]
  line <- sprintf("%-6s %s %s | %s  [%.1fs]", id, if (pass) "PASS" else "FAIL",
                  paste(ac, collapse = ","), detail, secs)
  cat(line, "\n", sep = "")
  utils::flush.console()
  .vcr_test_env$results[[length(.vcr_test_env$results) + 1L]] <-
    list(id = id, ac = ac, pass = pass, detail = detail, seconds = secs)
  invisible(pass)
}

vcr_case_summary <- function() {
  r <- .vcr_test_env$results
  n <- length(r)
  k <- sum(vapply(r, function(x) isTRUE(x$pass), logical(1)))
  failed <- Filter(function(x) !isTRUE(x$pass), r)
  # A filter that matches nothing is not a green run: `PASSED 0/0` used to exit 0.
  if (n == 0L) {
    cat("\nNO CASE MATCHED", if (nzchar(.vcr_test_env$only)) sprintf(" the filter '%s'", .vcr_test_env$only), "\n", sep = "")
    cat("\nPASSED 0/0\n")
    return(invisible(FALSE))
  }
  if (length(failed)) {
    cat("\nFAILED CASES\n")
    for (f in failed) cat(sprintf("  %s (%s): %s\n", f$id, paste(f$ac, collapse = ","), f$detail))
  }
  cat(sprintf("\nPASSED %d/%d\n", k, n))
  invisible(k == n)
}

#' Numeric comparison helpers that always report the numbers they compared.
vcr_near <- function(got, want, tol, scale = c("absolute", "relative")) {
  scale <- match.arg(scale)
  d <- abs(got - want)
  if (identical(scale, "relative")) d <- d / pmax(abs(want), .Machine$double.eps)
  list(pass = all(is.finite(d)) && max(d) <= tol, diff = max(d), tol = tol, scale = scale)
}

vcr_within_mcse <- function(got, want, mcse, multiple = 3) {
  d <- abs(got - want)
  list(pass = all(is.finite(d)) && all(d <= multiple * mcse), diff = max(d),
       mcse = mcse, multiple = multiple, ratio = max(d / mcse))
}

# --- fixtures the cases share ------------------------------------------------

#' The data root every case reads its inputs from. The engine opens a file only
#' under `VCR_ENGINE_DATA_ROOT`; a case that wants the engine to read a table
#' therefore writes it here, exactly as the control plane does, and names it by
#' a relative location and a sha256.
vcr_test_data_root <- function() {
  if (is.null(.vcr_test_env$root) || !dir.exists(.vcr_test_env$root)) {
    root <- tempfile("vcr-data-root-")
    dir.create(root, recursive = TRUE)
    .vcr_test_env$root <- normalizePath(root, winslash = "/")
  }
  Sys.setenv(VCR_ENGINE_DATA_ROOT = .vcr_test_env$root)
  .vcr_test_env$root
}

#' Write a table into the data root and return the engine input that names it.
#' `shape` (subject | long | event) makes it an `analysis_table`; without one it
#' is a `snapshot_file`. `source` is the value source the control plane would
#' have set.
vcr_test_input <- function(df, id, shape = NULL, source = "observed", kind = NULL, ext = "csv") {
  root <- vcr_test_data_root()
  rel <- file.path("snapshots", "snp_test", sprintf("%s.%s", gsub("[^A-Za-z0-9_.-]", "_", id), ext))
  dir.create(file.path(root, dirname(rel)), recursive = TRUE, showWarnings = FALSE)
  path <- file.path(root, rel)
  if (ext == "csv") utils::write.csv(df, path, row.names = FALSE, na = "")
  else if (ext == "json") writeLines(jsonlite::toJSON(df, dataframe = "rows", na = "null"), path)
  input <- list(id = id, kind = kind %||% (if (is.null(shape)) "snapshot_file" else "analysis_table"),
                location = rel, hash = vcr_file_sha256(path), valueSource = source)
  # The domain spells the shapes `subject`, `longitudinal`, `events`; the engine
  # reads either spelling, and a case says `subject` / `long` / `event`.
  if (!is.null(shape)) input$shape <- vcr_test_shape(shape)
  input
}

#' The domain's spelling of an analysis-table shape (`long` -> `longitudinal`).
vcr_test_shape <- function(short) {
  v <- vcr_domain()$analysisTables
  hit <- v[startsWith(v, short)]
  if (length(hit)) hit[1] else short
}

#' The job kind that runs a method (the domain's own pairing).
vcr_test_kind <- function(method) {
  jm <- vcr_domain()$jobMethods
  names(jm)[vapply(jm, function(m) identical(m, method), logical(1))][1]
}

#' A protocol job for `method`. Inputs default to one assumption (a job that
#' reads no patient rows still lists what it froze).
vcr_test_job <- function(method, scenario, inputs = NULL, seed = 1L, replicates = NULL, cores = 1L,
                         job_id = "job_case", extra = list()) {
  d <- vcr_domain()
  job <- list(jobId = job_id, studyId = "std_case", kind = vcr_test_kind(method), method = method,
              methodVersion = d$methods[[method]]$version, protocolVersion = 1L, scenario = scenario,
              inputs = inputs %||% list(list(kind = "assumption", id = "asm_case@1")),
              seed = as.integer(seed), cpuSecondsLimit = 600, cores = as.integer(cores))
  if (!is.null(replicates)) job$replicates <- as.integer(replicates)
  utils::modifyList(job, extra, keep.null = FALSE)
}

#' A job as the service reads it: written to JSON and parsed back with
#' `simplifyVector = FALSE`, so a case exercises the same shapes the handlers
#' see in production (arrays are lists, integers are integers, `{}` is not `[]`).
vcr_test_json <- function(job) {
  jsonlite::fromJSON(jsonlite::toJSON(job, auto_unbox = TRUE, digits = NA, null = "null", na = "null"),
                     simplifyVector = FALSE)
}

#' Run a job the way the service does: through JSON, into `vcr_run_job`.
vcr_test_run <- function(job, output_dir = NULL, ...) {
  vcr_run_job(vcr_test_json(job), output_dir = output_dir, ...)
}

#' The codes of every issue a result carries.
vcr_test_issue_codes <- function(result) {
  vapply(c(result$diagnostics$issues %||% list(), result$diagnostics$resultValidationIssues %||% list()),
         function(i) as.character(i$code), character(1))
}

vcr_measure_value <- function(result, name) {
  m <- Filter(function(x) identical(x$name, name), result$measures)
  if (!length(m)) NA_real_ else m[[1]]$value
}

vcr_get_measure <- function(result, name) {
  m <- Filter(function(x) identical(x$name, name), result$measures)
  if (!length(m)) NULL else m[[1]]
}

#' Read a table a job wrote (its `location` is a file name inside `dir`).
vcr_test_table <- function(result, name, dir) {
  t <- Filter(function(x) identical(x$name, name), result$tables)
  if (!length(t)) return(NULL)
  utils::read.csv(file.path(dir, t[[1]]$location), check.names = FALSE, stringsAsFactors = FALSE)
}

#' Bring a job's output table back into the data root as the input of the next
#' job, the way the control plane hands one step's output to the next.
vcr_test_chain_input <- function(result, name, dir, id, shape = NULL, source = "synthetic") {
  df <- vcr_test_table(result, name, dir)
  # A table one job hands the next is a derived `snapshot_file`, as the control
  # plane files it — never a lineage input carrying a location.
  vcr_test_input(df, id, shape = shape, source = source, kind = if (is.null(shape)) "snapshot_file" else NULL)
}

#' Which methods went through `vcr_run_job` in this process: the coverage case
#' at the end of the suite asserts all of them did (a walk must prove it walked).
vcr_test_record_method <- function(method) {
  m <- if (is.character(method) && length(method) == 1L) method else return(invisible(NULL))
  .vcr_test_env$methods_run <- union(.vcr_test_env$methods_run, m)
  cur <- .vcr_test_env$current
  .vcr_test_env$methods_by_case[[cur]] <- union(.vcr_test_env$methods_by_case[[cur]], m)
  invisible(NULL)
}
vcr_test_methods_run <- function() .vcr_test_env$methods_run
#' The methods a case ran, for every case that ran one.
vcr_test_methods_by_case <- function() .vcr_test_env$methods_by_case

# --- the scenario keys the handlers read ---------------------------------------

#' `scenario-schema-additions.json` lists every scenario key a handler reads that
#' the domain's scenario schemas did not list when the engine was repaired. The
#' domain has since adopted all of them, and this checks it stays so: each entry
#' is looked up in the in-memory copy of the domain's schemas (`found`), and one
#' that is not there is overlaid so the rest of the suite still runs against the
#' intended contract and recorded as a gap, which case N26 fails on, naming it.
#' `.vcr_test_env$schema_checked` counts the entries looked up (N26 asserts that
#' it walked them all).
vcr_test_apply_schema_additions <- function(root) {
  adds <- jsonlite::fromJSON(file.path(root, "tests", "helpers", "scenario-schema-additions.json"), simplifyVector = FALSE)$additions
  raw <- vcr_domain_raw()
  # returns the node (possibly with the key added), whether the key was already
  # there, and whether the path to it exists at all
  add_at <- function(node, segs, key, newnode) {
    if (length(segs) == 0L) {
      if (identical(node$t, "variant")) {
        have <- vapply(node$variants, function(v) !is.null(v[[key]]), logical(1))
        for (v in names(node$variants)) if (is.null(node$variants[[v]][[key]])) node$variants[[v]][[key]] <- newnode
        return(list(node = node, found = any(have), reachable = TRUE))
      }
      if (!is.null(node$fields[[key]])) return(list(node = node, found = TRUE, reachable = TRUE))
      node$fields[[key]] <- newnode
      return(list(node = node, found = FALSE, reachable = TRUE))
    }
    seg <- segs[1]; star <- grepl("\\[\\*\\]$", seg); name <- sub("\\[\\*\\]$", "", seg)
    child <- node$fields[[name]]
    if (is.null(child)) return(list(node = node, found = FALSE, reachable = FALSE))
    if (star) { r <- add_at(child$items, segs[-1], key, newnode); child$items <- r$node }
    else { r <- add_at(child, segs[-1], key, newnode); child <- r$node }
    node$fields[[name]] <- child
    list(node = node, found = r$found, reachable = r$reachable)
  }
  gaps <- list(); found <- 0L
  for (a in adds) {
    schema <- raw$scenarioSchemas[[a$method]]
    if (is.null(schema)) { gaps[[length(gaps) + 1L]] <- a; next }
    segs <- if (nzchar(a$path)) strsplit(a$path, ".", fixed = TRUE)[[1]] else character(0)
    r <- add_at(schema, segs, a$key, a$node)
    if (isTRUE(r$found)) { found <- found + 1L; next }
    if (isTRUE(r$reachable)) raw$scenarioSchemas[[a$method]] <- r$node
    gaps[[length(gaps) + 1L]] <- a
  }
  .vcr_domain_env$raw <- raw
  .vcr_test_env$schema_gaps <- gaps
  .vcr_test_env$schema_checked <- length(adds)
  .vcr_test_env$schema_found <- found
  invisible(length(gaps))
}

`%||%` <- function(a, b) if (is.null(a)) b else a

#' One valid job for each of the engine's methods (the 24 handlers), as
#' `list(method, scenario, inputs, replicates)`. E05 runs them as they are; E10
#' breaks them one field at a time.
vcr_test_handler_jobs <- function() {
  set.seed(5L, kind = VCR_RNG_KIND)
  n <- 120L
  subj <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), arm = rep(0:1, each = n / 2), age = stats::rnorm(n, 60, 8),
                     male = stats::rbinom(n, 1L, 0.5), site = sample(c("A", "B", "C"), n, TRUE), stringsAsFactors = FALSE)
  subj$y <- 1 + 0.03 * subj$age + 0.5 * subj$arm + stats::rnorm(n)
  ev <- data.frame(USUBJID = subj$USUBJID, PARAMCD = "OS", AVAL = stats::rexp(n, 0.05) + 1, CNSR = stats::rbinom(n, 1L, 0.3), stringsAsFactors = FALSE)
  in_subj <- vcr_test_input(subj, "snp_e05:subject", "subject")
  in_event <- vcr_test_input(ev, "snp_e05:event", "event")
  in_file <- vcr_test_input(subj, "snp_e05:1")
  in_syn <- vcr_test_input(subj[, c("age", "male", "y")], "pop_e05@1", source = "synthetic", kind = "snapshot_file")
  sites <- lapply(1:8, function(i) list(id = sprintf("s%d", i), alpha = 2, beta = 2.5, startTime = 0))
  curve_arm <- function(med) {
    t <- seq(0, 24, by = 0.5); tr <- c(0, 6, 12, 18, 24)
    list(curve = lapply(seq_along(t), function(i) list(time = t[i], surv = exp(-log(2) / med * t[i]))),
         riskTable = lapply(seq_along(tr), function(i) list(time = tr[i], atRisk = round(200 * exp(-log(2) / med * tr[i])))))
  }
  cases <- list(
    list("profile.snapshot", vcr_empty_object(), list(in_subj)),
    list("cohort.build", list(rules = list(list(name = "adult", rule = list(op = "compare", column = "age", comparator = "gte", value = 40)))), list(in_subj)),
    list("population.scenario", list(n = 200L, population = list(variables = list(list(name = "age", family = "normal", mean = 60, sd = 9)))), NULL),
    list("population.literature", list(n = 100L, baselineTable = list(list(variable = "age", mean = 61, sd = 9))), NULL),
    list("population.synthpop", list(m = 5L, holdoutShare = 0.2), list(in_file)),
    list("population.quality", list(trainingInputId = "snp_e05:1", syntheticInputId = "pop_e05@1"), list(in_file, in_syn)),
    list("patients.continuous", list(design = list(nTreat = 40, nControl = 40), endpoint = list(type = "continuous"), truth = list(effect = 0.4, sd = 1)), NULL),
    list("patients.binary", list(design = list(nTreat = 40, nControl = 40), endpoint = list(type = "binary"), truth = list(controlRate = 0.3, treatmentRate = 0.45)), NULL),
    list("patients.time_to_event", list(design = list(nTreat = 40, nControl = 40), endpoint = list(type = "time_to_event"), truth = list(controlMedian = 12, hazardRatio = 0.7), accrual = list(kind = "uniform", duration = 6, followup = 12)), NULL),
    list("evidence.pool", list(studies = list(list(studyId = "a", estimate = -0.4, se = 0.2), list(studyId = "b", estimate = -0.6, se = 0.15), list(studyId = "c", estimate = -0.3, se = 0.25)), method = "random_effects_dl", scale = "log"), NULL),
    list("evidence.reconstruct_km", list(curve = curve_arm(12)$curve, riskTable = curve_arm(12)$riskTable, provenance = list(kind = "digitizer", tool = "e05-digitizer")), list(list(kind = "evidence", id = "ev_e05@1"))),
    list("comparator.entropy_balance", list(covariates = list("age", "male"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "continuous")), list(in_subj)),
    list("comparator.propensity_weight", list(covariates = list("age", "male"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "continuous")), list(in_subj)),
    list("comparator.rmst", list(tau = 5, treatmentColumn = "arm"), list(in_subj, in_event)),
    list("comparator.maic", list(covariates = list("age"), targets = list(age = 58), outcomeColumn = "y", aggregateOutcome = 1.2, aggregateSe = 0.1), list(in_subj)),
    list("comparator.evalue", list(riskRatio = 3.9, confidenceLimit = 1.8), NULL),
    list("comparator.map_prior", list(historical = list(events = list(14, 18, 9, 22, 11), n = list(100, 120, 80, 150, 90)), robustWeight = 0.2), NULL),
    list("design.analytic", list(design = list(kind = "two_arm_fixed"), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12), accrual = list(duration = 12, followup = 24), analysis = list(alpha = 0.025, power = 0.9)), NULL),
    list("design.simulate", list(design = list(kind = "two_arm_fixed", nTreat = 50, nControl = 50), endpoint = list(type = "continuous"), truth = list(effect = 0.4, sd = 1), analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power")), NULL, 400L),
    list("design.grid", list(design = list(kind = "two_arm_fixed", nTreat = 30, nControl = 30), endpoint = list(type = "continuous"), analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power"), truth = list(effect = 0.4, sd = 1),
                             designs = list(list(nTreat = 30, nControl = 30), list(nTreat = 60, nControl = 60)), truths = list(list(effect = 0.4))), NULL, 300L),
    list("design.assurance", list(design = list(nTreat = 200, nControl = 200), endpoint = list(type = "continuous"), truth = list(sd = 1), designPrior = list(mean = 0.3, sd = 0.15), analysis = list(alpha = 0.025)), NULL),
    list("design.procova", list(design = list(allocation = 0.5), truth = list(effect = 0.3, sd = 1), analysis = list(alpha = 0.025, power = 0.9), prognostic = list(rho = 0.6, lambda = 0.9)), NULL),
    list("accrual.poisson_gamma", list(sites = sites, target = 60L), NULL, 500L),
    list("matching.evaluate", list(criteria = list(
      list(id = "inc1", kind = "inclusion", type = "diagnosis", state = "satisfied"),
      list(id = "inc2", kind = "inclusion", type = "lab", state = "unknown"),
      list(id = "exc1", kind = "exclusion", type = "pregnancy", state = "not_satisfied", notApplicable = TRUE))), list(in_file))
  )
  # --- robustness methods (2026-10-04): their jobs are in tests/helpers/robustness.R ---
  cases <- c(cases, vcr_test_robustness_handler_jobs())
  # --- end robustness methods ---
  cases
}
