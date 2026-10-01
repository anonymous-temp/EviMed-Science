# ---------------------------------------------------------------------------
# inputs.R — what a job may read, how it reads it, and the small helpers that
# make handlers indifferent to how the job JSON was parsed.
#
# Hidden knowledge:
#
# - **The engine opens exactly one kind of path: a location relative to
#   `VCR_ENGINE_DATA_ROOT`, under a sha256 the control plane froze.** The
#   previous reader opened whatever `inputs[].location` said, hashed it only
#   when a hash happened to be present, and echoed parser messages into the
#   result — so a job could read any file the container could open and get its
#   bytes back inside an error. Now: absolute paths, `..`, symlinks (at any
#   level below the root), anything that resolves outside the root and any
#   location without a hash are refused by a fixed code; the bytes are read
#   once, hashed in memory, and parsed from that same memory, so the file that
#   was hashed is the file that was parsed. Refusals never repeat file content
#   or the parser's own message.
# - **Provenance rides on the input, not on the caller.** `valueSource` is set
#   by the control plane from the snapshot or population row the file came
#   from. The weighting, propensity and RMST routes refuse any patient-level
#   input that is not `observed` (a synthetic or aggregate table weighted as if
#   it were people is the error the four-counts rule exists to prevent), and
#   `realPatients` is counted only from observed rows.
# - **The three analysis-table shapes are read by their ADaM names.** `subject`
#   (ADSL-like: one row per person), `long` (BDS-like: person x parameter x
#   visit) and `event` (ADTTE-like: `AVAL` time, `CNSR` = 1 when censored). The
#   engine's own time/status convention is `status = 1 - CNSR`; forgetting the
#   polarity swap turns every censored person into an event.
# - **Handlers do not care how the job was parsed.** The service parses job
#   JSON with `simplifyVector = FALSE` (so `{}` stays distinct from `[]` and a
#   one-element array stays an array, which the scenario hash needs); tests
#   build jobs from R vectors. `vcr_num()` / `vcr_chr()` / `vcr_rows_df()` accept
#   both.
# - **A spent budget and a cancel are checked between batches, not signalled
#   into a fork.** `vcr_interrupt()` is the one function every long loop asks.
# ---------------------------------------------------------------------------

# --- refusals ----------------------------------------------------------------

#' Stop with a named refusal. `vcr_run_job` turns it into a `failed` result
#' carrying exactly this issue; nothing else about the condition is exposed.
vcr_abort <- function(code, field, detail) {
  stop(structure(class = c("vcr_refusal", "error", "condition"),
                 list(message = detail, call = NULL, issue = vcr_issue(code, field, detail))))
}

#' The same, for an issue that was already built (a validator's verdict).
vcr_abort_issue <- function(issue) {
  stop(structure(class = c("vcr_refusal", "error", "condition"),
                 list(message = issue$detail, call = NULL, issue = issue)))
}

# --- shape helpers -------------------------------------------------------------

vcr_num <- function(x) if (is.null(x)) numeric(0) else suppressWarnings(as.numeric(unlist(x, use.names = FALSE)))
vcr_chr <- function(x) if (is.null(x)) character(0) else as.character(unlist(x, use.names = FALSE))

#' A number from a scalar-ish field, or `default` when absent or null.
vcr_scalar <- function(x, default = NULL) {
  if (is.null(x)) return(default)
  v <- vcr_num(x)
  if (length(v) != 1L || is.na(v)) return(default)
  v
}

vcr_flag <- function(x, default = FALSE) {
  if (is.null(x)) return(default)
  isTRUE(as.logical(unlist(x)[1]))
}

#' A list of row objects (as `simplifyVector = FALSE` parses an array of
#' objects, or as R code writes one) -> data frame. Absent and null cells are
#' NA. Also accepts a data frame and a column-oriented object.
vcr_rows_df <- function(x) {
  if (is.data.frame(x)) return(x)
  if (!is.list(x) || !length(x)) return(data.frame())
  if (!is.null(names(x))) {
    ok <- all(vapply(x, function(v) is.atomic(v) || is.list(v), logical(1)))
    lens <- vapply(x, function(v) length(unlist(v)), integer(1))
    if (ok && length(unique(lens)) == 1L) {
      cols <- lapply(x, function(v) unlist(v, use.names = FALSE))
      return(as.data.frame(cols, stringsAsFactors = FALSE, check.names = FALSE))
    }
    return(data.frame())
  }
  rows <- Filter(is.list, x)
  cols <- unique(unlist(lapply(rows, names)))
  out <- lapply(cols, function(cn) {
    vals <- lapply(rows, function(r) { v <- r[[cn]]; if (is.null(v) || (length(v) == 1L && is.na(v))) NA else v })
    if (all(vapply(vals, function(v) length(v) == 1L && !is.list(v), logical(1)))) unlist(vals, use.names = FALSE) else I(vals)
  })
  names(out) <- cols
  as.data.frame(out, stringsAsFactors = FALSE, check.names = FALSE)
}

# --- limits and the job context ------------------------------------------------

#' A numeric limit from the domain snapshot, with the engine's own default when
#' the domain does not (yet) carry it. Thresholds that decide "not estimable"
#' come from here and never from a scenario (EB-5).
vcr_limit <- function(name, default) {
  v <- tryCatch(vcr_domain()$limits[[name]], error = function(e) NULL)
  if (is.null(v)) default else v
}

.vcr_env_num <- function(name, default) {
  v <- suppressWarnings(as.numeric(Sys.getenv(name, "")))
  if (is.na(v)) default else v
}

vcr_max_replicates <- function() .vcr_env_num("VCR_ENGINE_MAX_REPLICATES", 200000)

.vcr_ctx <- new.env(parent = emptyenv())
.vcr_ctx$cancel_file <- NULL
.vcr_ctx$budget <- Inf
.vcr_ctx$cpu_base <- 0

vcr_cpu_seconds <- function() sum(proc.time()[c("user.self", "sys.self", "user.child", "sys.child")], na.rm = TRUE)

#' Install the cancel file and CPU budget of the job now running. The budget is
#' 0.9 of the kernel limit (`min(job limit, VCR_ENGINE_CPU_LIMIT)`), so a job
#' returns what it has instead of being killed by SIGXCPU. Inside the service
#' the kernel counts from process start, so the base is 0 there; in-process
#' (tests, tools) it counts from now.
vcr_ctx_begin <- function(cancel_file = NULL, cpu_seconds_limit = Inf) {
  env_limit <- .vcr_env_num("VCR_ENGINE_CPU_LIMIT", Inf)
  limit <- min(if (is.finite(cpu_seconds_limit)) cpu_seconds_limit else Inf, env_limit)
  .vcr_ctx$cancel_file <- cancel_file
  .vcr_ctx$budget <- if (is.finite(limit)) 0.9 * limit else Inf
  .vcr_ctx$cpu_base <- if (is.finite(env_limit)) 0 else vcr_cpu_seconds()
  invisible(TRUE)
}

vcr_ctx_end <- function() {
  .vcr_ctx$cancel_file <- NULL; .vcr_ctx$budget <- Inf; .vcr_ctx$cpu_base <- 0
  invisible(TRUE)
}

#' NULL while the job may continue; "canceled" or "cpu_budget" when it must stop.
vcr_interrupt <- function() {
  cf <- .vcr_ctx$cancel_file
  if (!is.null(cf) && file.exists(cf)) return("canceled")
  if (is.finite(.vcr_ctx$budget) && vcr_cpu_seconds() - .vcr_ctx$cpu_base > .vcr_ctx$budget) return("cpu_budget")
  NULL
}

# --- reading an input ---------------------------------------------------------

VCR_TABLE_INPUT_KINDS <- c("analysis_table", "snapshot_file")
.VCR_SHAPE_ALIASES <- c(subject = "subject", long = "long", longitudinal = "long", event = "event", events = "event")

vcr_data_root <- function() {
  root <- Sys.getenv("VCR_ENGINE_DATA_ROOT", "")
  if (!nzchar(root)) vcr_abort("input_location_invalid", "inputs", "This engine has no data root configured, so it can read no patient-level file.")
  real <- tryCatch(normalizePath(root, winslash = "/", mustWork = TRUE), error = function(e) "")
  if (!nzchar(real) || !isTRUE(file.info(real)$isdir)) {
    vcr_abort("input_location_invalid", "inputs", "The data root is not a readable directory.")
  }
  real
}

#' Resolve `location` under the data root or refuse it by a fixed code.
vcr_resolve_location <- function(location, field = "inputs") {
  root <- vcr_data_root()
  bad <- function(detail = "An input location is a relative path inside the data root.") {
    vcr_abort("input_location_invalid", field, detail)
  }
  if (!(is.character(location) && length(location) == 1L && !is.na(location) && nzchar(location))) bad()
  if (grepl("[[:cntrl:]\\\\]", location) || grepl("..", location, fixed = TRUE)) bad()
  if (startsWith(location, "/") || startsWith(location, "~") || grepl("^[A-Za-z]:", location)) bad()
  parts <- strsplit(location, "/", fixed = TRUE)[[1]]
  if (!length(parts) || any(!nzchar(parts)) || any(parts == ".")) bad()
  cur <- root
  for (p in parts) {
    cur <- file.path(cur, p)
    link <- Sys.readlink(cur)
    if (!is.na(link) && nzchar(link)) bad("An input location may not pass through a symbolic link.")
  }
  real <- tryCatch(normalizePath(cur, winslash = "/", mustWork = TRUE), error = function(e) "")
  if (!nzchar(real)) bad("No file exists at the location the job named.")
  if (!startsWith(real, paste0(root, "/"))) bad()
  info <- file.info(real)
  if (is.na(info$isdir) || isTRUE(info$isdir)) bad("The location does not name a regular file.")
  list(path = real, size = as.numeric(info$size))
}

#' Read one location-bearing input as a table. Returns a data frame carrying
#' `vcrSource` (the input's value source), `vcrShape` and `vcrInputId`.
vcr_read_table_input <- function(input) {
  if (!is.list(input)) vcr_abort("input_location_invalid", "inputs", "An input is an object.")
  field <- sprintf("inputs[%s]", .vcr_json_string(as.character(input[["id"]] %||% "")))
  res <- vcr_resolve_location(input[["location"]], field)
  hash <- input[["hash"]]
  if (!(is.character(hash) && length(hash) == 1L && grepl("^[a-f0-9]{64}$", hash))) {
    vcr_abort("input_hash_missing", field, "A patient-level input carries the sha256 the control plane froze.")
  }
  cap <- .vcr_env_num("VCR_ENGINE_MAX_INPUT_BYTES", 512 * 1024^2)
  if (res$size > cap) vcr_abort("input_too_large", field, "The input file is larger than this engine reads.")
  bytes <- readBin(res$path, what = "raw", n = res$size)
  got <- digest::digest(bytes, algo = "sha256", serialize = FALSE)
  if (!identical(got, hash)) {
    vcr_abort("input_hash_mismatch", field, "The file's bytes are not the ones the job froze (its sha256 differs).")
  }
  ext <- tolower(tools::file_ext(res$path))
  df <- tryCatch({
    if (ext %in% c("csv", "tsv")) {
      utils::read.csv(text = rawToChar(bytes), sep = if (ext == "tsv") "\t" else ",", stringsAsFactors = FALSE,
                      na.strings = c("", "NA"), check.names = FALSE, comment.char = "", quote = "\"")
    } else if (ext == "json") {
      x <- jsonlite::fromJSON(rawToChar(bytes), simplifyVector = TRUE, simplifyDataFrame = TRUE)
      if (!is.data.frame(x)) stop("not a table")
      x
    } else if (ext %in% c("parquet", "pq")) {
      # The bytes were hashed above; the bridge gets a private copy of exactly
      # those bytes, never the path the job named.
      tmp <- tempfile(fileext = ".parquet")
      file.create(tmp); Sys.chmod(tmp, "0600")
      writeBin(bytes, tmp)
      out <- tryCatch(vcr_read_parquet(tmp), finally = unlink(tmp))
      out
    } else {
      NULL
    }
  }, error = function(e) "failed")
  if (is.null(df)) vcr_abort("input_format_unsupported", field, "An input is a csv, tsv, json or parquet table.")
  if (!is.data.frame(df)) vcr_abort("input_parse_failed", field, "The file could not be read as a table.")
  shape <- .VCR_SHAPE_ALIASES[as.character(input[["shape"]] %||% "")]
  attr(df, "vcrSource") <- as.character(input[["valueSource"]] %||% "")
  attr(df, "vcrShape") <- if (length(shape) && !is.na(shape)) unname(shape) else NA_character_
  attr(df, "vcrInputId") <- as.character(input[["id"]] %||% "")
  attr(df, "vcrKind") <- as.character(input[["kind"]] %||% "")
  df
}

#' Parquet via the Python bridge, on bytes that were already hashed. The bridge
#' converts; it never computes and never sees a path the caller chose.
vcr_read_parquet <- function(path) {
  bridge <- file.path(vcr_engine_root(), "service", "parquet_bridge.py")
  tmp <- tempfile(fileext = ".csv")
  on.exit(unlink(tmp), add = TRUE)
  suppressWarnings(system2(Sys.getenv("VCR_PYTHON", "python3"), c(shQuote(bridge), shQuote(path), shQuote(tmp)),
                           stdout = FALSE, stderr = FALSE))
  if (!file.exists(tmp)) stop("parquet bridge failed")
  utils::read.csv(tmp, stringsAsFactors = FALSE, na.strings = c("", "NA"), check.names = FALSE)
}

#' Every input of a job that names a file, by kind.
vcr_table_inputs <- function(job) {
  # A table is an input of a table kind, by exact key — never "anything with a
  # location-ish key": R's `$` would have matched `locationX` as `location`.
  Filter(function(i) is.list(i) && is.character(i[["kind"]]) && length(i[["kind"]]) == 1L &&
           i[["kind"]] %in% c("analysis_table", "snapshot_file") && !is.null(i[["location"]]), job[["inputs"]] %||% list())
}

vcr_input_by_kind <- function(job, kind) {
  for (input in job[["inputs"]]) if (identical(input[["kind"]], kind)) return(input)
  NULL
}

vcr_input_by_id <- function(job, id) {
  for (input in job[["inputs"]]) if (identical(input[["id"]], id)) return(input)
  NULL
}

#' The source label of a table read by `vcr_read_table_input`.
vcr_table_source <- function(df) {
  s <- attr(df, "vcrSource")
  if (is.null(s) || !nzchar(s)) NA_character_ else s
}

#' Refuse a table that is not a record of real people. The accepted sources
#' are the domain's, per method (`individualInputSources`): an observed,
#' extracted, calculated or imputed row is still a real person's row; RMST also
#' reads reconstructed pseudo-patients for the literature-control route
#' (contract 3.2, amended after wave A).
vcr_require_individual <- function(df, what = "This method", method = NULL) {
  src <- vcr_table_source(df)
  accepted <- if (!is.null(method)) unlist(vcr_domain()$individualInputSources[[method]]) else NULL
  if (is.null(accepted)) accepted <- unlist(vcr_domain()$realPatientSources %||% c("observed", "extracted", "calculated", "imputed"))
  if (is.na(src) || !(src %in% accepted)) {
    vcr_abort("input_source_not_individual", sprintf("inputs[%s]", .vcr_json_string(attr(df, "vcrInputId") %||% "")),
              sprintf("%s reads real patient-level rows (%s); this input is %s.", what, paste(accepted, collapse = ", "),
                      if (is.na(src)) "not labelled with a value source" else sprintf("'%s'", src)))
  }
  invisible(df)
}

#' How many real patients a table is, by source. Real-patient sources count as
#' real patients; reconstructed rows are pseudo-patients, counted apart;
#' generated rows are counted as generated; anything else is unknown (NULL).
vcr_table_counts <- function(df, events = NULL) {
  src <- vcr_table_source(df)
  n <- nrow(df)
  real <- unlist(vcr_domain()$realPatientSources %||% c("observed", "extracted", "calculated", "imputed"))
  if (!is.na(src) && src %in% real) return(vcr_counts(realPatients = n, events = events))
  if (identical(src, "reconstructed")) return(vcr_counts(realPatients = 0, reconstructedPseudoPatients = n))
  if (identical(src, "synthetic")) return(vcr_counts(realPatients = 0, generatedRecords = n))
  vcr_counts(realPatients = NULL, events = NULL)
}

# --- the three analysis tables -------------------------------------------------

VCR_SHAPE_REQUIRED <- list(
  subject = "USUBJID", long = c("USUBJID", "PARAMCD", "AVAL"), event = c("USUBJID", "AVAL", "CNSR"))

#' The tables a job carries, by shape. A `snapshot_file` is a raw table of no
#' declared shape; it is returned under `file`.
vcr_job_tables <- function(job) {
  out <- list(subject = NULL, long = NULL, event = NULL, files = list())
  for (input in vcr_table_inputs(job)) {
    df <- vcr_read_table_input(input)
    shape <- attr(df, "vcrShape")
    if (identical(attr(df, "vcrKind"), "analysis_table")) {
      if (is.na(shape)) vcr_abort("input_shape_invalid", "inputs", "An analysis table names its shape: subject, long or event.")
      need <- VCR_SHAPE_REQUIRED[[shape]]
      if (!all(need %in% names(df))) {
        vcr_abort("input_shape_invalid", sprintf("inputs[%s]", .vcr_json_string(attr(df, "vcrInputId"))),
                  sprintf("A %s table has the columns %s.", shape, paste(need, collapse = ", ")))
      }
      out[[shape]] <- df
    } else {
      out$files[[length(out$files) + 1L]] <- df
    }
  }
  out
}

#' Time and status from an ADTTE-like event table: `AVAL` is the time and
#' `CNSR` is 1 when the person is *censored*, so the engine's status is
#' `1 - CNSR`. `parameter` picks one `PARAMCD` when the table holds several.
vcr_event_frame <- function(event, parameter = NULL) {
  if ("PARAMCD" %in% names(event)) {
    codes <- unique(stats::na.omit(as.character(event$PARAMCD)))
    if (!is.null(parameter)) {
      event <- event[!is.na(event$PARAMCD) & as.character(event$PARAMCD) == parameter, , drop = FALSE]
      if (!nrow(event)) vcr_abort("input_shape_invalid", "scenario.parameterCode", "The event table has no rows for the parameter code the scenario names.")
    } else if (length(codes) > 1L) {
      vcr_abort("input_shape_invalid", "scenario.parameterCode", "The event table holds several parameters; the scenario names one with parameterCode.")
    }
  }
  if (anyDuplicated(event$USUBJID)) vcr_abort("input_shape_invalid", "inputs", "An event table has one row per person and parameter.")
  cn <- suppressWarnings(as.numeric(event$CNSR))
  if (anyNA(cn) || !all(cn %in% c(0, 1))) vcr_abort("input_shape_invalid", "inputs", "CNSR is 1 for a censored person and 0 for an event.")
  data.frame(USUBJID = event$USUBJID, time = suppressWarnings(as.numeric(event$AVAL)), status = as.integer(1L - cn),
             stringsAsFactors = FALSE)
}

`%||%` <- function(a, b) if (is.null(a)) b else a
