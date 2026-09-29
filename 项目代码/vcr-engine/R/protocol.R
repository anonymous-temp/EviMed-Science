# ---------------------------------------------------------------------------
# protocol.R — the engine's half of the job/result contract.
#
# Hidden knowledge:
#
# - `packages/domain/src/vcrEngineJob.mjs` is the authority, and it is
#   JavaScript. This file is the R mirror. It does not re-state the
#   vocabularies: it reads them out of `R/domain-snapshot.json`, which
#   `tests/helpers/emit-domain-snapshot.mjs` generates from the live domain
#   module. Restating them here is what a previous generation of this codebase
#   did twice and paid for twice (see the clinical-evidence gate); a generated
#   snapshot plus a test that regenerates it is the only shape that stays true.
# - **Canonical JSON is hand-written, not `jsonlite::toJSON`.** Both sides hash
#   the same bytes, so R has to reproduce ECMAScript's `JSON.stringify` exactly:
#   sorted keys, dropped NULLs, no whitespace, and — the part that actually
#   bites — ECMAScript's shortest-round-trip number formatting, which is not
#   `%.15g` and not `%.17g`. `vcr_num_to_json()` below implements the
#   Number::toString algorithm. jsonlite writes `1` as `1` but `1e-7` as
#   `1e-07` (two-digit exponent), and writes scalars as arrays unless told not
#   to; either difference changes the hash and so changes the identity of a
#   result.
# - Validation returns issues, it never stops. A job the engine refuses comes
#   back as a named `failed` result with the issue list, because a run that
#   dies with a stack trace is indistinguishable from a crashed container.
# ---------------------------------------------------------------------------

suppressPackageStartupMessages({
  library(jsonlite)
  library(digest)
})

vcr_engine_version <- function() "1.0.0"

.vcr_domain_env <- new.env(parent = emptyenv())

#' The generated snapshot of `@evimed/domain`, loaded once.
vcr_domain <- function(path = NULL) {
  if (!is.null(.vcr_domain_env$snapshot) && is.null(path)) return(.vcr_domain_env$snapshot)
  if (is.null(path)) path <- file.path(vcr_engine_root(), "R", "domain-snapshot.json")
  snapshot <- jsonlite::fromJSON(path, simplifyVector = TRUE, simplifyDataFrame = FALSE)
  .vcr_domain_env$snapshot <- snapshot
  snapshot
}

#' Where this engine is installed.
#'
#' Hidden knowledge: R has no reliable "path of the file being sourced" when
#' the caller used `source()` from another directory, and the service, the
#' tests and an interactive session all enter from different places. So the
#' root is whatever directory above the working directory (or above
#' `VCR_ENGINE_ROOT`) actually contains `R/domain-snapshot.json` -- an
#' existence test, not a guess.
vcr_engine_root <- function() {
  candidates <- c(Sys.getenv("VCR_ENGINE_ROOT", ""), .vcr_domain_env$root %||% "", getwd())
  for (start in candidates) {
    if (!nzchar(start)) next
    dir <- normalizePath(start, mustWork = FALSE)
    for (i in 1:6) {
      if (file.exists(file.path(dir, "R", "domain-snapshot.json"))) return(dir)
      parent <- dirname(dir)
      if (identical(parent, dir)) break
      dir <- parent
    }
  }
  stop("vcr_engine_root: cannot locate R/domain-snapshot.json; set VCR_ENGINE_ROOT")
}

vcr_set_engine_root <- function(root) {
  .vcr_domain_env$root <- normalizePath(root, mustWork = FALSE)
  invisible(.vcr_domain_env$root)
}

# --- canonical JSON --------------------------------------------------------

#' ECMAScript `Number::toString` for finite doubles.
#'
#' Hidden knowledge: the shortest digit string that round-trips is found by
#' trying 1..17 significant digits and stopping at the first that reads back
#' identically — this is what V8 computes with Grisu/Ryu, arrived at the slow
#' way. The placement rules below (integer form up to 1e21, plain decimal down
#' to 1e-6, exponential outside) are ECMA-262 7.1.12.1 steps 5-10 verbatim;
#' `sprintf("%g")` uses different cut-offs and would disagree on e.g. 1e-5.
vcr_num_to_json <- function(x) {
  if (!is.finite(x)) stop("vcr_num_to_json: only finite numbers are JSON numbers")
  if (x == 0) return("0")
  sign <- if (x < 0) "-" else ""
  x <- abs(x)
  digits <- NULL
  exp10 <- NULL
  for (p in 1:17) {
    s <- sprintf(paste0("%.", p - 1L, "e"), x)
    if (identical(as.numeric(s), x)) {
      parts <- strsplit(s, "e", fixed = TRUE)[[1]]
      mant <- gsub(".", "", parts[1], fixed = TRUE)
      # trailing zeros are not part of the shortest representation
      mant <- sub("0+$", "", mant)
      if (!nzchar(mant)) mant <- "0"
      digits <- mant
      exp10 <- as.integer(parts[2]) + 1L  # value = 0.<digits> * 10^exp10
      break
    }
  }
  if (is.null(digits)) stop("vcr_num_to_json: no round-trip representation")
  k <- nchar(digits)
  n <- exp10
  out <- if (k <= n && n <= 21L) {
    paste0(digits, strrep("0", n - k))
  } else if (0L < n && n <= 21L) {
    paste0(substr(digits, 1L, n), ".", substr(digits, n + 1L, k))
  } else if (-6L < n && n <= 0L) {
    paste0("0.", strrep("0", -n), digits)
  } else {
    e <- n - 1L
    esign <- if (e >= 0L) "+" else "-"
    head <- substr(digits, 1L, 1L)
    tail <- if (k > 1L) paste0(".", substr(digits, 2L, k)) else ""
    paste0(head, tail, "e", esign, abs(e))
  }
  paste0(sign, out)
}

.vcr_json_string <- function(s) {
  # jsonlite escapes exactly as JSON.stringify for the characters we can see in
  # a scenario (it escapes control chars as \uXXXX and leaves non-ASCII as UTF-8
  # bytes, which is what JSON.stringify does too).
  as.character(jsonlite::toJSON(s, auto_unbox = TRUE))
}

#' Canonical JSON: sorted keys, dropped NULLs, no whitespace. Matches
#' `canonicalScenarioJson` in `vcrEngineJob.mjs` byte for byte.
vcr_canonical_json <- function(value) {
  if (is.null(value)) return("null")
  if (inherits(value, "vcr_raw_json")) return(unclass(value))
  if (is.list(value)) {
    nms <- names(value)
    if (is.null(nms) || all(!nzchar(nms))) {
      # an unnamed list is an array
      return(paste0("[", paste(vapply(value, vcr_canonical_json, character(1)), collapse = ","), "]"))
    }
    keep <- vapply(value, function(v) !is.null(v), logical(1))
    value <- value[keep]
    nms <- names(value)
    ord <- order(nms, method = "radix")
    value <- value[ord]
    nms <- nms[ord]
    parts <- vapply(seq_along(value), function(i) {
      paste0(.vcr_json_string(nms[i]), ":", vcr_canonical_json(value[[i]]))
    }, character(1))
    return(paste0("{", paste(parts, collapse = ","), "}"))
  }
  if (length(value) == 0L) return("[]")
  if (length(value) > 1L) {
    return(paste0("[", paste(vapply(seq_along(value), function(i) vcr_canonical_json(value[[i]]), character(1)), collapse = ","), "]"))
  }
  if (is.logical(value)) return(if (is.na(value)) "null" else if (value) "true" else "false")
  # ECMAScript's JSON.stringify turns Infinity, -Infinity and NaN into `null`.
  # A scenario legitimately carries `followup: Infinity` ("no administrative
  # censoring"), so refusing it here would make an ordinary scenario unhashable
  # on one side of the protocol and hashable on the other.
  if (is.numeric(value)) return(if (is.na(value) || !is.finite(value)) "null" else vcr_num_to_json(as.numeric(value)))
  if (is.character(value)) return(if (is.na(value)) "null" else .vcr_json_string(value))
  stop("vcr_canonical_json: unsupported type ", class(value)[1])
}

#' Wrap a pre-serialized JSON fragment so `vcr_canonical_json` passes it through.
vcr_raw_json <- function(text) structure(text, class = "vcr_raw_json")

vcr_sha256 <- function(text) digest::digest(text, algo = "sha256", serialize = FALSE)

vcr_scenario_hash <- function(scenario) vcr_sha256(vcr_canonical_json(scenario))

vcr_file_sha256 <- function(path) digest::digest(file = path, algo = "sha256")

# --- replicate arithmetic (mirrors vcrEngineJob.mjs) ------------------------

#' How many replicates a target Monte-Carlo standard error needs.
#'
#' Hidden knowledge: the bare `ceiling(variance / target^2)` is wrong by one on
#' exactly the numbers the plan quotes. 0.025 * 0.975 / 0.001^2 is
#' 24375.000000000004 in IEEE doubles (0.001^2 lands a hair below 1e-6), so the
#' ceiling is 24376 and the plan's 24,375 -- and case N05 -- would fail by one
#' replicate forever. The same happens at 1,900 and 1,600.
#'
#' The de-noising step is *twelve significant digits then ceiling*, and it is
#' twelve rather than "a few ulps" because that is the rule
#' `vcrEngineJob.mjs` uses (`Number(x.toPrecision(12))`). The two sides must
#' plan the same replicate count for a result's `replicates` field to mean the
#' same thing as its job's, and the two rules disagree on inputs like
#' 1000.0000000001 -- so this is a mirror, not an independent choice.
#' `tests/numeric/N00e` probes both implementations on adversarial targets.
vcr_replicates_for_mcse <- function(measure, target, p = 0.5, sd = 1) {
  if (!(target > 0)) stop("vcr_replicates_for_mcse: target must be positive")
  variance <- if (identical(measure, "proportion")) p * (1 - p) else sd * sd
  as.numeric(ceiling(signif(variance / (target * target), 12)))
}

vcr_mcse_of <- function(measure, replicates, p = 0.5, sd = 1) {
  if (!(replicates > 0)) stop("vcr_mcse_of: replicates must be positive")
  variance <- if (identical(measure, "proportion")) p * (1 - p) else sd * sd
  sqrt(variance / replicates)
}

vcr_replicate_floor <- function(is_null, target_mcse = NULL, p = 0.5) {
  limits <- vcr_domain()$limits
  base <- if (isTRUE(is_null)) limits$replicatesNullMin else limits$replicatesAltMin
  if (is.null(target_mcse) || is.na(target_mcse) || target_mcse <= 0) return(as.integer(base))
  as.integer(max(base, vcr_replicates_for_mcse("proportion", target_mcse, p = p)))
}

# --- issues ----------------------------------------------------------------

vcr_issue <- function(code, field, detail) list(code = code, field = field, detail = detail)

# These three mirror the regex literals in `vcrEngineJob.mjs`. They are not
# exported by the domain (a JS RegExp does not survive a JSON snapshot), so
# `tests/numeric/N00_protocol_agreement.R` reads them back out of the .mjs
# source text and fails if the two ever differ. An input id carries an object
# *version* (`asm_1@3`), which is why it admits `@` and job/study ids do not.
.VCR_ID_RE <- "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$"
.VCR_INPUT_ID_RE <- "^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,140}$"
.VCR_SHA_RE <- "^[a-f0-9]{64}$"

#' Validate a job. Returns a list of issues; `list()` is a valid job.
#' Mirrors `validateEngineJob`, including the issue codes, because the control
#' plane renders them and a code invented here would render as raw text.
vcr_validate_job <- function(job) {
  d <- vcr_domain()
  issues <- list()
  bad <- function(code, field, detail) issues[[length(issues) + 1L]] <<- vcr_issue(code, field, detail)
  if (!is.list(job)) return(list(vcr_issue("job_not_object", "", "A job is a JSON object.")))

  id_ok <- function(v) is.character(v) && length(v) == 1L && grepl(.VCR_ID_RE, v)
  if (!id_ok(job$jobId)) bad("job_id_invalid", "jobId", "A job id is 1-121 characters of [A-Za-z0-9_.:-].")
  if (!id_ok(job$studyId)) bad("study_id_invalid", "studyId", "A study id is 1-121 characters of [A-Za-z0-9_.:-].")
  if (!identical(as.integer(job$protocolVersion %||% -1L), as.integer(d$protocolVersion))) {
    bad("protocol_version_mismatch", "protocolVersion", sprintf("This build speaks protocol %d.", d$protocolVersion))
  }
  if (!(is.character(job$kind) && job$kind %in% d$jobKinds)) {
    bad("kind_unknown", "kind", sprintf("Unknown job kind %s.", .vcr_json_string(as.character(job$kind %||% NA))))
  }
  method <- as.character(job$method %||% "")
  if (!(method %in% names(d$methods))) {
    bad("method_unknown", "method", sprintf("Unknown method %s.", .vcr_json_string(method)))
  } else if (!is.null(job$methodVersion) && !identical(as.character(job$methodVersion), d$methods[[method]]$version)) {
    bad("method_version_mismatch", "methodVersion", sprintf("Method %s is %s in this build.", method, d$methods[[method]]$version))
  }
  seed <- job$seed
  if (!(is.numeric(seed) && length(seed) == 1L && !is.na(seed) && seed == round(seed) && seed >= 0 && seed <= 2147483647)) {
    bad("seed_invalid", "seed", "A seed is an integer from 0 to 2147483647; it is written into the result so the run can be repeated.")
  }
  if (!is.null(job$replicates)) {
    r <- job$replicates
    if (!(is.numeric(r) && length(r) == 1L && !is.na(r) && r == round(r) && r >= 1)) {
      bad("replicates_invalid", "replicates", "Replicates is a positive integer.")
    }
  }
  cpu <- job$cpuSecondsLimit
  if (!(is.numeric(cpu) && length(cpu) == 1L && is.finite(cpu) && cpu > 0)) {
    bad("cpu_limit_invalid", "cpuSecondsLimit", "Every job carries its own CPU-second ceiling (plan 11.4).")
  }
  if (!is.list(job$scenario)) bad("scenario_missing", "scenario", "A job carries its frozen scenario, not a reference to one.")

  inputs <- job$inputs
  if (!is.list(inputs)) {
    bad("inputs_missing", "inputs", "A job lists every frozen input it used.")
    inputs <- list()
  } else {
    for (i in seq_along(inputs)) {
      input <- inputs[[i]]
      if (!is.list(input)) { bad("input_not_object", sprintf("inputs[%d]", i - 1L), "An input is an object."); next }
      if (!(is.character(input$id) && length(input$id) == 1L && grepl(.VCR_INPUT_ID_RE, input$id))) {
        bad("input_id_invalid", sprintf("inputs[%d].id", i - 1L),
            "An input carries the id of the object version it froze (`asm_1@3`).")
      }
      if (is.null(input$kind)) bad("input_kind_missing", sprintf("inputs[%d].kind", i - 1L), "An input names what it is (assumption, snapshot, population ...).")
      if (!is.null(input$hash) && !grepl(.VCR_SHA_RE, as.character(input$hash))) {
        bad("input_hash_invalid", sprintf("inputs[%d].hash", i - 1L), "An input hash is a lowercase sha256 hex digest.")
      }
    }
  }

  if (is.character(job$kind) && job$kind %in% d$patientLevelJobKinds) {
    kinds <- vapply(inputs, function(x) as.character(x$kind %||% ""), character(1))
    if (!any(kinds == "snapshot")) {
      bad("snapshot_required", "inputs", sprintf("A %s job reads patient-level rows and must name the snapshot it is granted.", job$kind))
    }
  }

  design <- job$scenario$design
  if (!is.null(design) && !is.null(design$kind) && !(design$kind %in% d$trialDesigns)) {
    bad("design_unknown", "scenario.design.kind", sprintf("Unknown design %s.", .vcr_json_string(as.character(design$kind))))
  }
  endpoint <- job$scenario$endpoint
  if (!is.null(endpoint) && !is.null(endpoint$type) && !(endpoint$type %in% d$endpointTypes)) {
    bad("endpoint_unknown", "scenario.endpoint.type", sprintf("Unknown endpoint type %s.", .vcr_json_string(as.character(endpoint$type))))
  }
  issues
}

#' Validate a result. Mirrors `validateEngineResult`. The engine runs this on
#' its own output before answering: a result that cannot be validated here
#' would be refused by the control plane anyway, and finding out in-process is
#' the difference between a named issue and a silent 422.
vcr_validate_result <- function(result) {
  d <- vcr_domain()
  issues <- list()
  bad <- function(code, field, detail) issues[[length(issues) + 1L]] <<- vcr_issue(code, field, detail)
  if (!is.list(result)) return(list(vcr_issue("result_not_object", "", "A result is a JSON object.")))

  if (!(is.character(result$jobId) && grepl(.VCR_ID_RE, result$jobId))) bad("job_id_invalid", "jobId", "A result carries the job id it answers.")
  if (!identical(as.integer(result$protocolVersion %||% -1L), as.integer(d$protocolVersion))) {
    bad("protocol_version_mismatch", "protocolVersion", sprintf("This build speaks protocol %d.", d$protocolVersion))
  }
  if (!(is.character(result$status) && result$status %in% c("succeeded", "failed", "canceled", "not_estimable"))) {
    bad("status_unknown", "status", "A result is succeeded, failed, canceled or not_estimable.")
  }
  if (!(is.character(result$scenarioHash) && grepl(.VCR_SHA_RE, result$scenarioHash))) {
    bad("scenario_hash_invalid", "scenarioHash", "A result carries the sha256 of the canonical scenario it ran.")
  }
  if (identical(result$status, "not_estimable") && is.null(result$notEstimableRule)) {
    bad("not_estimable_rule_missing", "notEstimableRule", "A not-estimable result names the deterministic rule that fired (plan 5.3).")
  }

  measures <- result$measures
  if (!is.list(measures)) {
    bad("measures_missing", "measures", "A result lists its measures, even when the list is empty.")
  } else {
    for (i in seq_along(measures)) {
      m <- measures[[i]]
      at <- sprintf("measures[%d]", i - 1L)
      if (!is.list(m)) { bad("measure_not_object", at, "A measure is an object."); next }
      if (is.null(m$name)) bad("measure_name_missing", paste0(at, ".name"), "A measure is named.")
      if (!(is.numeric(m$value) && length(m$value) == 1L && is.finite(m$value))) {
        bad("measure_value_invalid", paste0(at, ".value"),
            "A measure carries a finite number; a failed computation is an issue, never a 0 (plan 9.6).")
      }
      if (isTRUE(m$simulated) && !(is.numeric(m$mcse) && length(m$mcse) == 1L && is.finite(m$mcse) && m$mcse >= 0)) {
        bad("mcse_missing", paste0(at, ".mcse"), "Every simulated measure reports its Monte-Carlo standard error (AC-28).")
      }
      if (!is.null(m$interval) && !(as.character(m$interval$kind %||% "") %in% d$intervalKinds)) {
        bad("interval_kind_unknown", paste0(at, ".interval.kind"), "An interval names which kind it is (plan 8.3).")
      }
    }
  }

  manifest <- result$manifest
  if (!is.list(manifest)) {
    bad("manifest_missing", "manifest", "A result carries the manifest that lets it be repeated.")
  } else {
    for (field in c("engineVersion", "rVersion", "packageLockHash", "startedAt", "finishedAt", "cpuSeconds")) {
      v <- manifest[[field]]
      if (is.null(v) || (is.character(v) && !nzchar(v))) {
        bad("manifest_field_missing", paste0("manifest.", field), sprintf("The manifest states %s (AC-04).", field))
      }
    }
    if (!is.null(manifest$outputHash) && !grepl(.VCR_SHA_RE, as.character(manifest$outputHash))) {
      bad("output_hash_invalid", "manifest.outputHash", "An output hash is a lowercase sha256 hex digest.")
    }
  }
  issues
}

#' The four counts, kept apart (plan 3.5). `NULL` means "not knowable", and is
#' the only thing that may stand in for an unknown; 0 may not (AC-08, AC-09).
vcr_counts <- function(realPatients = NULL, events = NULL, effectiveSampleSize = NULL,
                       generatedRecords = NULL, priorEffectiveSampleSize = NULL,
                       reconstructedPseudoPatients = NULL) {
  out <- list(
    realPatients = realPatients, events = events,
    effectiveSampleSize = effectiveSampleSize, generatedRecords = generatedRecords
  )
  if (!is.null(priorEffectiveSampleSize)) out$priorEffectiveSampleSize <- priorEffectiveSampleSize
  if (!is.null(reconstructedPseudoPatients)) out$reconstructedPseudoPatients <- reconstructedPseudoPatients
  out
}

vcr_validate_counts <- function(counts) {
  issues <- list()
  if (!is.list(counts)) return(list(vcr_issue("counts_not_object", "", "Counts are an object.")))
  for (key in names(counts)) {
    v <- counts[[key]]
    if (is.null(v)) next
    if (!(is.numeric(v) && length(v) == 1L && is.finite(v) && v >= 0)) {
      issues[[length(issues) + 1L]] <- vcr_issue("count_invalid", key,
        "A count is a non-negative number or null (not knowable), never 0 standing in for unknown.")
    }
  }
  gr <- counts$generatedRecords %||% 0
  rp <- counts$realPatients %||% 0
  ess <- counts$effectiveSampleSize %||% 0
  if (is.numeric(gr) && is.numeric(rp) && gr > 0 && rp > 0 && rp < ess) {
    issues[[length(issues) + 1L]] <- vcr_issue("ess_above_real", "effectiveSampleSize",
      "A weighted effective sample size never exceeds the real patients it weights (AC-08).")
  }
  issues
}

#' A measure, in the shape `validateEngineResult` expects.
#' `simulated = TRUE` obliges `mcse`; that is enforced, not documented.
vcr_measure <- function(name, value, simulated = FALSE, mcse = NULL, interval = NULL,
                        unit = NULL, source = NULL, note = NULL) {
  if (isTRUE(simulated) && (is.null(mcse) || !is.finite(mcse))) {
    stop(sprintf("vcr_measure('%s'): a simulated measure must carry its Monte-Carlo standard error (AC-28)", name))
  }
  out <- list(name = name, value = as.numeric(value), simulated = isTRUE(simulated))
  if (!is.null(mcse)) out$mcse <- as.numeric(mcse)
  if (!is.null(interval)) out$interval <- interval
  if (!is.null(unit)) out$unit <- unit
  if (!is.null(source)) out$source <- source
  if (!is.null(note)) out$note <- note
  out
}

vcr_interval <- function(kind, low, high, level = 0.95) {
  d <- vcr_domain()
  if (!(kind %in% d$intervalKinds)) stop("vcr_interval: unknown interval kind ", kind)
  list(kind = kind, low = as.numeric(low), high = as.numeric(high), level = as.numeric(level))
}

# --- shared deterministic quadrature ---------------------------------------

#' Gauss-Hermite nodes and weights by Golub-Welsch on the Hermite three-term
#' recurrence.
#'
#' Hidden knowledge: this lives in the protocol module rather than beside its
#' first caller because three unrelated modules need it (MAP priors, assurance,
#' logit-to-beta moment matching) and a second copy is a second answer. It is
#' deterministic to the last bit, which is the whole reason the engine
#' integrates smooth functions this way instead of sampling them.
.vcr_gauss_hermite <- function(n) {
  i <- seq_len(n - 1L)
  J <- matrix(0, n, n)
  J[cbind(i, i + 1L)] <- sqrt(i / 2)
  J[cbind(i + 1L, i)] <- sqrt(i / 2)
  e <- eigen(J, symmetric = TRUE)
  ord <- order(e$values)
  list(nodes = e$values[ord], weights = (e$vectors[1, ord]^2) * sqrt(pi))
}

`%||%` <- function(a, b) if (is.null(a)) b else a
