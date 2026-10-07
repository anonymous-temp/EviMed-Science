# ---------------------------------------------------------------------------
# protocol.R — the engine's half of the job/result contract.
#
# Hidden knowledge:
#
# - `packages/domain/src/vcrEngineJob.mjs` is the authority, and it is
#   JavaScript. This file is the R mirror. It does not re-state the
#   vocabularies, the patterns or the per-method scenario schemas: it reads them
#   out of `R/domain-snapshot.json`, which `tests/helpers/emit-domain-snapshot.mjs`
#   generates from the live domain module. Restating them here is what a
#   previous generation of this codebase did twice and paid for twice (see the
#   clinical-evidence gate); a generated snapshot plus a test that regenerates
#   it is the only shape that stays true. What cannot be a table — the walker
#   that reads a schema — is small, and case N00 holds its verdict equal to the
#   domain's on a fixture set of jobs.
# - **A job's scenario is validated key by key.** An unknown key is refused by
#   its path, because an ignored key is a silent parameter change (the first
#   build sent `dropoutRate` where the engine read `dropoutAnnual`, and every
#   simulation ran with no dropout at all). The schema for each method lists what
#   its handler reads; the walker below refuses the rest.
# - **Canonical JSON is hand-written, not `jsonlite::toJSON`.** Both sides hash
#   the same bytes, so R has to reproduce ECMAScript's `JSON.stringify` of the
#   object the domain builds: keys sorted in UTF-16 order with integer-like keys
#   first (that is where V8 puts them), `null` kept, `{}` distinct from `[]`, and
#   ECMAScript's shortest-round-trip number formatting, which is not `%.15g` and
#   not `%.17g`. `vcr_num_to_json()` below implements the Number::toString
#   algorithm. jsonlite writes `1e-7` as `1e-07` and scalars as arrays unless
#   told not to; either difference changes the hash and so changes the identity
#   of a result. **A job is parsed with `simplifyVector = FALSE`** so that a
#   one-element array stays an array, `[]` stays apart from `{}` and `null`
#   stays `null`; anything else hashes to a different scenario.
# - **What is hashed is what is written.** `vcr_output_hash()` serializes the
#   payload the way `result.json` is serialized (`vcr_result_json`, seventeen
#   significant digits so a double survives the file) and hashes the canonical
#   form of what that text parses back to — exactly what the control plane
#   computes from the file.
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

#' The generated snapshot of `@evimed/domain`, loaded once, with arrays of
#' scalars simplified to vectors (`d$jobKinds`, `d$limits$minCellSize`). The
#' trees in it — the scenario schemas — must not be read this way (an array of
#' arrays becomes a matrix): see `vcr_domain_raw()`.
vcr_domain <- function(path = NULL) {
  if (!is.null(.vcr_domain_env$snapshot) && is.null(path)) return(.vcr_domain_env$snapshot)
  if (is.null(path)) path <- file.path(vcr_engine_root(), "R", "domain-snapshot.json")
  snapshot <- jsonlite::fromJSON(path, simplifyVector = TRUE, simplifyDataFrame = FALSE)
  .vcr_domain_env$snapshot <- snapshot
  snapshot
}

#' The same snapshot read as parsed, with nothing simplified: every array is a
#' list, `null` is `NULL`. The scenario schemas, the design table and the rule
#' limits are read from here.
vcr_domain_raw <- function(path = NULL) {
  if (!is.null(.vcr_domain_env$raw) && is.null(path)) return(.vcr_domain_env$raw)
  if (is.null(path)) path <- file.path(vcr_engine_root(), "R", "domain-snapshot.json")
  raw <- jsonlite::fromJSON(path, simplifyVector = FALSE)
  .vcr_domain_env$raw <- raw
  raw
}

#' The per-method scenario schemas of the domain (`VCR_SCENARIO_SCHEMAS`).
vcr_scenario_schemas <- function() vcr_domain_raw()$scenarioSchemas

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
    # R's decimal-to-double parser can double-round a 17-digit scientific
    # string (e.g. 0.3-0.1). The JSON decoder uses correctly rounded strtod,
    # matching the consumer; otherwise a valid result cannot acquire a hash.
    if (identical(jsonlite::fromJSON(s), x)) {
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

#' A JSON string literal, byte for byte what `JSON.stringify` writes: the two
#' quote and backslash escapes, `\b \f \n \r \t`, every other control character
#' below U+0020 as a lowercase `\u00xx`, and everything else -- U+007F, U+2028,
#' non-ASCII, astral characters -- as itself. jsonlite is not used: it escapes a
#' few of the characters ECMAScript leaves alone, and a scenario is model output.
.vcr_json_string <- function(s) {
  s <- enc2utf8(as.character(s))
  if (!grepl("[\"\\\\\\x01-\\x1f]", s, perl = TRUE)) return(paste0("\"", s, "\""))
  cps <- utf8ToInt(s)
  out <- vapply(cps, function(cp) {
    if (cp == 34L) "\\\"" else if (cp == 92L) "\\\\"
    else if (cp == 8L) "\\b" else if (cp == 12L) "\\f" else if (cp == 10L) "\\n"
    else if (cp == 13L) "\\r" else if (cp == 9L) "\\t"
    else if (cp < 32L) sprintf("\\u%04x", cp)
    else intToUtf8(cp)
  }, character(1))
  paste0("\"", paste(out, collapse = ""), "\"")
}

#' UTF-16 code units of a string, as `String.prototype.sort` compares them. A
#' code point above U+FFFF is two units (a surrogate pair), so it sorts before
#' U+E000..U+FFFF -- which is not where its code point would put it.
.vcr_utf16_key <- function(s) {
  cps <- utf8ToInt(enc2utf8(s))
  if (!length(cps)) return("")
  units <- unlist(lapply(cps, function(cp) {
    if (cp >= 65536L) { v <- cp - 65536L; c(55296L + v %/% 1024L, 56320L + v %% 1024L) } else cp
  }))
  paste(sprintf("%04x", units), collapse = "")
}

#' Keys in the order `JSON.stringify` writes the object the domain builds from
#' them: array-index keys ("0", "9", "10") first in numeric order, then the rest
#' in UTF-16 order.
.vcr_js_key_order <- function(keys) {
  if (!length(keys)) return(integer(0))
  is_index <- grepl("^(0|[1-9][0-9]*)$", keys) & suppressWarnings(as.numeric(keys)) < 4294967295
  is_index[is.na(is_index)] <- FALSE
  idx <- which(is_index)
  rest <- which(!is_index)
  c(idx[order(as.numeric(keys[idx]))], rest[order(vapply(keys[rest], .vcr_utf16_key, character(1)), method = "radix")])
}

#' Canonical JSON: keys in JavaScript's order, no whitespace, `null` kept,
#' `{}` (a named list of length 0) apart from `[]` (an unnamed list). Matches
#' `canonicalScenarioJson` in `vcrEngineJob.mjs` byte for byte.
#'
#' A list is an object when it has names and an array when it has none; an
#' atomic vector of length one is a scalar and a longer one an array, which is
#' what `jsonlite::toJSON(auto_unbox = TRUE)` writes and so what a result file
#' holds. A parsed job (`simplifyVector = FALSE`) contains only lists and
#' scalars, so it is unambiguous.
vcr_canonical_json <- function(value) {
  if (is.null(value)) return("null")
  if (inherits(value, "vcr_raw_json")) return(unclass(value))
  if (is.data.frame(value)) stop("vcr_canonical_json: a data frame is not part of a canonical document")
  if (is.list(value)) {
    nms <- names(value)
    if (is.null(nms)) {
      return(paste0("[", paste(vapply(value, vcr_canonical_json, character(1)), collapse = ","), "]"))
    }
    ord <- .vcr_js_key_order(nms)
    parts <- vapply(ord, function(i) paste0(.vcr_json_string(nms[i]), ":", vcr_canonical_json(value[[i]])), character(1))
    return(paste0("{", paste(parts, collapse = ","), "}"))
  }
  dims <- dim(value)
  if (length(dims) == 2L) {
    rows <- lapply(seq_len(dims[1]), function(i) as.vector(value[i, ]))
    return(paste0("[", paste(vapply(rows, function(r) vcr_canonical_json(if (length(r) == 1L) list(r) else r), character(1)), collapse = ","), "]"))
  }
  if (is.factor(value)) value <- as.character(value)
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

#' An empty JSON object (`{}`), which R cannot spell as `list()`: an unnamed
#' empty list is `[]`.
vcr_empty_object <- function() structure(list(), names = character(0))

vcr_sha256 <- function(text) digest::digest(text, algo = "sha256", serialize = FALSE)

vcr_scenario_hash <- function(scenario) vcr_sha256(vcr_canonical_json(scenario))

vcr_file_sha256 <- function(path) digest::digest(file = path, algo = "sha256")

#' Parse a job or result document the one way the protocol reads it. Lists all
#' the way down, `null` kept: what `vcr_canonical_json` and `vcr_validate_job`
#' are defined over. `text` is JSON text, and only ever text: `parse_json`, not
#' `fromJSON`, which reads a string that looks like a path or a URL as one.
vcr_parse_json <- function(text) jsonlite::parse_json(text, simplifyVector = FALSE)

#' Read a job file the way the engine does: the bytes, as UTF-8, parsed by
#' `vcr_parse_json`. This is the path a scenario hash is computed through, so it
#' is the path the parity case (N00) exercises.
vcr_read_job <- function(path) {
  info <- file.info(path)
  if (is.na(info$size)) stop("vcr_read_job: no such file")
  text <- rawToChar(readBin(path, "raw", info$size))
  Encoding(text) <- "UTF-8"
  if (!validUTF8(text)) stop("vcr_read_job: the job is not UTF-8")
  vcr_parse_json(text)
}

#' Serialize a result the way `result.json` is written. `digits = I(17)` is
#' what makes a double survive the file: `digits = NA` is fifteen significant
#' digits and `0.1 + 0.2` would read back as `0.3`, so the hash computed here
#' and the hash computed from the file would be hashes of different numbers.
vcr_result_json <- function(x) {
  as.character(jsonlite::toJSON(x, auto_unbox = TRUE, digits = I(17), null = "null", na = "null"))
}

#' What `manifest.outputHash` is the sha256 of (contract 3.4): the canonical
#' JSON of `{ measures, counts, conclusion, notEstimableRule, tables:
#' [{ name, sha256 }] }`, computed from what the result *reads back as* from its
#' file -- the same document the control plane hashes. `vcrResultOutputPayload`
#' in `vcrEngineJob.mjs` is the twin.
vcr_output_payload <- function(result) {
  tables <- lapply(result[["tables"]] %||% list(), function(t) list(name = t[["name"]], sha256 = t[["sha256"]]))
  payload <- list(measures = result[["measures"]] %||% list(), counts = result[["counts"]],
                  conclusion = result[["conclusion"]], notEstimableRule = result[["notEstimableRule"]],
                  tables = unname(tables))
  # `list(counts = NULL)` keeps the element, which is what makes it `null`.
  names(payload) <- c("measures", "counts", "conclusion", "notEstimableRule", "tables")
  vcr_canonical_json(vcr_parse_json(vcr_result_json(payload)))
}

vcr_output_hash <- function(result) vcr_sha256(vcr_output_payload(result))

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

vcr_replicate_floor <- function(is_null, target_mcse = NULL, p = NULL, alpha = 0.025) {
  limits <- vcr_domain()$limits
  base <- if (isTRUE(is_null)) limits$replicatesNullMin else limits$replicatesAltMin
  if (is.null(target_mcse) || is.na(target_mcse) || target_mcse <= 0) return(as.integer(base))
  # The proportion the precision is asked of is the rejection probability the
  # scenario measures: alpha under the null, the worst case 0.5 otherwise.
  proportion <- p %||% (if (isTRUE(is_null)) alpha else 0.5)
  as.integer(max(base, vcr_replicates_for_mcse("proportion", target_mcse, p = proportion)))
}

# --- the null scenario (mirrors vcrIsNullScenario) -------------------------

#' Is this scenario a null one -- no true effect? One predicate for the
#' replicate floor, the measure's name (`type_one_error` vs `power`) and the
#' report. An explicit `truth$null` wins; otherwise it is derived from the effect
#' the scenario states, and a scenario that states none is not null.
.vcrp_is_null_scenario <- function(scenario) {
  truth <- .vcrp_get(scenario, "truth")
  if (!.vcrp_named(truth)) return(FALSE)
  kind <- .vcrp_get(.vcrp_get(scenario,"design"),"kind") %||% ""
  if(!.vcrp_chr(kind))kind<-""
  # a single-arm trial of a mean or a survival time: its null is its effect over the benchmark (0, or a hazard ratio of 1) whatever a label says;
  # the response-rate comparison is the binary single-arm and Simon designs'
  type0 <- .vcrp_get(.vcrp_get(scenario, "endpoint"), "type")
  if (identical(kind, "single_arm") && .vcrp_chr(type0) && type0 %in% c("continuous", "time_to_event")) {
    if (identical(type0, "continuous")) return(.vcrp_num(truth[["effect"]]) && abs(truth[["effect"]]) < 1e-12)
    hr0 <- truth[["hazardRatio"]]
    return(.vcrp_num(hr0) && hr0 > 0 && abs(log(hr0)) < 1e-12)
  }
  if (kind %in% c("single_arm","simon_two_stage")) {
    return(.vcrp_num(truth$responseRate) && .vcrp_num(truth$nullRate) && abs(truth$responseRate-truth$nullRate)<1e-12)
  }
  if (identical(kind,"single_arm_external")) {
    p0<-unlist(truth$controlRates);p1<-unlist(truth$treatmentRates)
    q<-.vcrp_get(.vcrp_get(scenario,"external"),"targetPrevalence")
    return(length(p0)==2L && length(p1)==2L && is.numeric(p0) && is.numeric(p1) && .vcrp_num(q) && all(is.finite(c(p0,p1))) && abs(sum(c(1-q,q)*(p1-p0)))<1e-12)
  }
  if (.vcrp_lgl(truth[["null"]])) return(truth[["null"]])
  type <- .vcrp_get(.vcrp_get(scenario, "endpoint"), "type")
  if (!.vcrp_chr(type)) return(FALSE)
  tiny <- function(x) abs(x) < 1e-12
  if (type == "continuous") return(.vcrp_num(truth[["effect"]]) && tiny(truth[["effect"]]))
  if (type == "time_to_event") {
    hr <- truth[["hazardRatio"]]
    return(.vcrp_num(hr) && hr > 0 && tiny(log(hr)))
  }
  if (type == "binary") {
    p0 <- truth[["controlRate"]]
    if (!.vcrp_num(p0)) return(FALSE)
    if (.vcrp_num(truth[["treatmentRate"]])) return(tiny(truth[["treatmentRate"]] - p0))
    if (.vcrp_num(truth[["riskDifference"]])) return(tiny(truth[["riskDifference"]]))
    orr <- truth[["oddsRatio"]]
    if (.vcrp_num(orr) && p0 > 0 && p0 < 1) {
      odds <- orr * p0 / (1 - p0)
      return(tiny(odds / (1 + odds) - p0))
    }
  }
  FALSE
}

#' The name the handlers call. It is a thin door onto the private mirror above
#' so that the validator (which computes the replicate floor of a scenario) and
#' N00 hold *this file's* answer to the domain's even if a handler file
#' redefines the public name.
vcr_is_null_scenario <- function(scenario) .vcrp_is_null_scenario(scenario)

#' The replicate floor of a whole scenario, its null predicate and alpha read
#' from the scenario itself (`vcrReplicateFloorFor`).
vcr_replicate_floor_for <- function(scenario) {
  target <- .vcrp_get(scenario, "targetMcse")
  alpha <- .vcrp_get(.vcrp_get(scenario, "analysis"), "alpha")
  vcr_replicate_floor(.vcrp_is_null_scenario(scenario),
                      if (.vcrp_num(target) && target > 0) target else NULL,
                      alpha = if (.vcrp_num(alpha) && alpha > 0 && alpha < 1) alpha else 0.025)
}

# --- issues ----------------------------------------------------------------

vcr_issue <- function(code, field, detail) list(code = code, field = field, detail = detail)

# --- reading a value the way the protocol does -----------------------------
# A parsed job (`simplifyVector = FALSE`) has lists and scalars; a job an R
# caller built has vectors and matrices as well. These helpers answer the same
# questions of both. `[[` is used throughout, never `$`: `$` partial-matches
# names, and `job$rep` finding `replicates` is exactly the bug a validator must
# not have.

.vcrp_named <- function(x) is.list(x) && !is.null(names(x)) && !is.data.frame(x)
.vcrp_has <- function(x, key) .vcrp_named(x) && key %in% names(x)
#' `x[[key]]` when `x` is a named list that has it, else NULL -- never an error
#' on a scalar or a missing name, which is what a validator reads.
.vcrp_get <- function(x, key) if (.vcrp_has(x, key)) x[[key]] else NULL
.vcrp_scalar <- function(x) is.atomic(x) && !is.null(x) && length(x) == 1L && is.null(dim(x))
.vcrp_num <- function(x) .vcrp_scalar(x) && is.numeric(x) && is.finite(x)
.vcrp_chr <- function(x) .vcrp_scalar(x) && is.character(x) && !is.na(x)
.vcrp_lgl <- function(x) .vcrp_scalar(x) && is.logical(x) && !is.na(x)
.vcrp_int <- function(x) .vcrp_num(x) && x == round(x)

#' The items of an array-like value, or NULL when it is not one. An unnamed
#' list is an array; so is an atomic vector of any length (an R caller's array).
.vcrp_items <- function(x) {
  if (is.null(x) || is.data.frame(x) || !is.null(dim(x))) return(NULL)
  if (is.list(x)) return(if (is.null(names(x))) x else NULL)
  if (is.atomic(x)) return(as.list(x))
  NULL
}

.vcrp_at <- function(path, key) if (nzchar(path)) paste0(path, ".", key) else key
.vcrp_at_index <- function(path, i) sprintf("%s[%d]", path, i - 1L)
.vcrp_chars <- function(x) nchar(x, type = "chars")

#' A pattern from the snapshot against one string. The pattern's trailing `$`
#' means "end of string", which PCRE spells `\z` (its `$` also matches before a
#' final newline, and JavaScript's does not).
vcr_pattern_match <- function(pattern, x) {
  .vcrp_chr(x) && grepl(sub("\\$$", "\\\\z", pattern), x, perl = TRUE)
}
.vcrp_pat <- function(name) vcr_domain_raw()$patterns[[name]]

.vcrp_location_valid <- function(location) {
  d <- vcr_domain_raw()
  if (!.vcrp_chr(location) || !nzchar(location) || .vcrp_chars(location) > d$locationLimits$maxLength) return(FALSE)
  segments <- strsplit(location, "/", fixed = TRUE)[[1]]
  if (grepl("/$", location)) segments <- c(segments, "")
  length(segments) <= d$locationLimits$maxSegments && all(vapply(segments, vcr_pattern_match, logical(1), pattern = .vcrp_pat("locationSegment")))
}

# --- row rules inside a scenario ---------------------------------------------
# The grammar itself is in `R/rules.R` (`vcr_validate_row_rule`, held to the
# domain's verdict by the parity fixture); a scenario only says where a rule
# lives, and the issues come back with that place as their path prefix.

.vcrp_rule_issues <- function(rule, columns, path) {
  vcr_validate_row_rule(rule, columns = columns, path = path)
}

.vcrp_named_rules_issues <- function(items, columns, path, allow_empty) {
  limits <- vcr_domain_raw()$rules$rowRule$limits
  arr <- .vcrp_items(items)
  if (is.null(arr) || (!allow_empty && length(arr) < 1L) || length(arr) > limits$maxNamedRules) {
    return(list(vcr_issue("rule_shape_invalid", path, "A list of named rules has a bounded number of items.")))
  }
  issues <- list()
  add <- function(code, field, detail) issues[[length(issues) + 1L]] <<- vcr_issue(code, field, detail)
  for (i in seq_along(arr)) {
    item <- arr[[i]]
    where <- .vcrp_at_index(path, i)
    if (!.vcrp_named(item)) { add("rule_shape_invalid", where, "A named rule is { name, rule }."); next }
    if ("expression" %in% names(item)) {
      add("rule_expression_forbidden", where, "Rules are data in a closed grammar; an expression is never parsed.")
      next
    }
    for (key in names(item)) if (!(key %in% c("name", "rule"))) add("rule_shape_invalid", .vcrp_at(where, key), "A named rule is { name, rule }.")
    nm <- item[["name"]]
    if (!(.vcrp_chr(nm) && .vcrp_chars(nm) >= 1L && .vcrp_chars(nm) <= limits$maxNameLength)) {
      add("rule_shape_invalid", .vcrp_at(where, "name"), "A rule name is a short string.")
    }
    if (!("rule" %in% names(item))) add("rule_shape_invalid", .vcrp_at(where, "rule"), "A named rule carries its rule.")
    else issues <- c(issues, .vcrp_rule_issues(item[["rule"]], columns, .vcrp_at(where, "rule")))
  }
  issues
}

#' The paths of every object that carries a key called `expression`
#' (`findExpressionFields`).
.vcrp_expression_holders <- function(value, path = "", limit = 8L) {
  found <- character(0)
  walk <- function(node, where, depth) {
    if (length(found) >= limit || depth > 64L || !is.list(node)) return(invisible(NULL))
    if (is.null(names(node))) {
      for (i in seq_along(node)) walk(node[[i]], .vcrp_at_index(where, i), depth + 1L)
      return(invisible(NULL))
    }
    if ("expression" %in% names(node)) found <<- c(found, where)
    for (key in names(node)) walk(node[[key]], .vcrp_at(where, key), depth + 1L)
  }
  walk(value, path, 0L)
  found
}

# --- the scenario schema walker (mirrors validateScenario) -------------------

.vcrp_lookup <- function(root, path) {
  node <- root
  for (key in strsplit(path, ".", fixed = TRUE)[[1]]) {
    if (!.vcrp_has(node, key)) return(NULL)
    node <- node[[key]]
  }
  node
}

#' A `when` on the scenario: one condition or a list of them, all must hold.
.vcrp_when_holds <- function(when, root) {
  if (is.null(when)) return(TRUE)
  if (is.null(names(when))) return(all(vapply(when, .vcrp_when_holds, logical(1), root = root)))
  value <- .vcrp_lookup(root, when[["path"]])
  spelled <- if (.vcrp_lgl(value)) (if (value) "true" else "false") else if (.vcrp_chr(value)) value else NA_character_
  if (!is.null(when[["in"]])) return(!is.na(spelled) && spelled %in% unlist(when[["in"]]))
  if (!is.null(when[["notIn"]])) return(is.na(spelled) || !(spelled %in% unlist(when[["notIn"]])))
  if (!is.null(when[["present"]])) return((!is.null(value)) == isTRUE(when[["present"]]))
  TRUE
}

.vcrp_present <- function(value, key) .vcrp_has(value, key) && !is.null(value[[key]])

.vcrp_walk_ctx <- function(root, input_ids) {
  ctx <- new.env(parent = emptyenv())
  ctx$root <- root
  ctx$input_ids <- input_ids
  ctx$issues <- list()
  ctx$raise <- function(code, field, detail) ctx$issues[[length(ctx$issues) + 1L]] <- vcr_issue(code, field, detail)
  ctx
}

.vcrp_names_from <- function(root, spec) {
  arr <- .vcrp_items(.vcrp_lookup(root, spec$path))
  if (is.null(arr)) return(NULL)
  found <- unlist(lapply(arr, function(item) if (.vcrp_has(item, spec$key) && .vcrp_chr(item[[spec$key]])) item[[spec$key]] else NULL))
  if (length(found)) found else NULL
}

.vcrp_check_value <- function(node, value, path, ctx) {
  raise <- ctx$raise
  t <- node$t
  if (t %in% c("number", "integer")) {
    if (!.vcrp_num(value) || (t == "integer" && value != round(value))) {
      raise("scenario_value_invalid", path, if (t == "integer") "An integer is expected." else "A finite number is expected.")
      return(invisible(NULL))
    }
    bounds <- character(0)
    if (!is.null(node$min) && value < node$min) bounds <- c(bounds, "min")
    if (!is.null(node$max) && value > node$max) bounds <- c(bounds, "max")
    if (!is.null(node$gt) && !(value > node$gt)) bounds <- c(bounds, "gt")
    if (!is.null(node$lt) && !(value < node$lt)) bounds <- c(bounds, "lt")
    if (length(bounds)) raise("scenario_value_invalid", path, "The value is outside its allowed range.")
    return(invisible(NULL))
  }
  if (t == "boolean") {
    if (!.vcrp_lgl(value)) raise("scenario_value_invalid", path, "A boolean is expected.")
    return(invisible(NULL))
  }
  if (t == "string") {
    if (!.vcrp_chr(value)) { raise("scenario_value_invalid", path, "A string is expected."); return(invisible(NULL)) }
    n <- .vcrp_chars(value)
    if (!is.null(node$minLength) && n < node$minLength) raise("scenario_value_invalid", path, "The string is too short.")
    else if (!is.null(node$maxLength) && n > node$maxLength) raise("scenario_value_invalid", path, "The string is too long.")
    else if (!is.null(node$pattern) && !vcr_pattern_match(node$pattern, value)) raise("scenario_value_invalid", path, "The value does not match the expected name pattern.")
    else if (!is.null(node$values) && !(value %in% unlist(node$values))) {
      raise(node$badValueCode %||% "scenario_value_invalid", path, "The value is not one of the allowed words.")
    } else if (!is.null(node$valuesBy)) {
      by <- .vcrp_lookup(ctx$root, node$valuesBy$path)
      allowed <- if (.vcrp_chr(by)) node$valuesBy$map[[by]] else NULL
      if (!is.null(allowed) && !(value %in% unlist(allowed))) raise("scenario_value_invalid", path, "The value does not apply to this endpoint.")
      else if (is.null(allowed) && !(value %in% unlist(node$valuesBy$map))) raise("scenario_value_invalid", path, "An analysis method the engine does not have.")
    } else if (identical(node$ref, "input") && !is.null(ctx$input_ids) && !(value %in% ctx$input_ids)) {
      raise("scenario_value_invalid", path, "The job carries no input with this id.")
    }
    return(invisible(NULL))
  }
  if (t == "array") {
    items <- .vcrp_items(value)
    if (is.null(items)) { raise("scenario_value_invalid", path, "A list is expected."); return(invisible(NULL)) }
    if ((!is.null(node$min) && length(items) < node$min) || (!is.null(node$max) && length(items) > node$max)) {
      raise("scenario_value_invalid", path, "The list has the wrong number of items.")
      return(invisible(NULL))
    }
    before <- length(ctx$issues)
    for (i in seq_along(items)) .vcrp_check_value(node$items, items[[i]], .vcrp_at_index(path, i), ctx)
    if (length(ctx$issues) > before) return(invisible(NULL))
    if (isTRUE(node$increasing) && length(items) > 1L) {
      v <- unlist(items)
      if (any(!(v[-1L] > v[-length(v)]))) raise("scenario_value_invalid", path, "The values must strictly increase.")
    }
    if (!is.null(node$last) && length(items) && !identical(as.numeric(items[[length(items)]]), as.numeric(node$last))) {
      raise("scenario_value_invalid", path, "The last value is fixed.")
    }
    if (isTRUE(node$unique) && anyDuplicated(unlist(items)) > 0L) raise("scenario_value_invalid", path, "The values must be distinct.")
    return(invisible(NULL))
  }
  if (t == "object") return(.vcrp_check_object(node, value, path, ctx))
  if (t == "variant") {
    if (!.vcrp_named(value)) { raise("scenario_value_invalid", path, "An object is expected."); return(invisible(NULL)) }
    has_raw <- .vcrp_has(value, node$on)
    chosen <- if (has_raw) value[[node$on]] else node$default
    if (!.vcrp_chr(chosen) || !(chosen %in% names(node$variants))) {
      raise(if (!has_raw) "scenario_field_missing" else "scenario_value_invalid", .vcrp_at(path, node$on), "The kind is not one the schema has.")
      return(invisible(NULL))
    }
    disc <- stats::setNames(list(list(t = "string", values = as.list(names(node$variants)))), node$on)
    variant <- c(list(t = "object", fields = c(disc, node$variants[[chosen]])), node$variantGroups[[chosen]])
    return(.vcrp_check_object(variant, value, path, ctx))
  }
  if (t == "map") {
    if (!.vcrp_named(value)) { raise("scenario_value_invalid", path, "An object is expected."); return(invisible(NULL)) }
    keys <- names(value)
    if ((!is.null(node$min) && length(keys) < node$min) || (!is.null(node$max) && length(keys) > node$max)) {
      raise("scenario_value_invalid", path, "The object has the wrong number of entries.")
      return(invisible(NULL))
    }
    for (key in keys) {
      if (!vcr_pattern_match(vcr_domain_raw()$rules$rowRule$columnPattern, key)) raise("scenario_field_unknown", .vcrp_at(path, key), "A key is a column name.")
      else .vcrp_check_value(node$values, value[[key]], .vcrp_at(path, key), ctx)
    }
    if (!is.null(node$keysFrom)) {
      wanted <- .vcrp_items(.vcrp_lookup(ctx$root, node$keysFrom))
      if (!is.null(wanted) && all(vapply(wanted, .vcrp_chr, logical(1)))) {
        wanted <- unlist(wanted)
        for (name in wanted) if (!(name %in% keys)) raise("scenario_field_missing", .vcrp_at(path, name), "The list of covariates names this key but the object does not.")
        for (key in keys) if (!(key %in% wanted)) raise("scenario_field_unknown", .vcrp_at(path, key), "The list of covariates does not name this key.")
      }
    }
    return(invisible(NULL))
  }
  if (t == "matrix") {
    rows <- NULL
    if (is.matrix(value) && is.numeric(value)) rows <- lapply(seq_len(nrow(value)), function(i) as.list(value[i, ]))
    else {
      arr <- .vcrp_items(value)
      if (!is.null(arr) && length(arr) >= 1L) {
        rows <- lapply(arr, .vcrp_items)
        if (any(vapply(rows, is.null, logical(1)))) rows <- NULL
      }
    }
    if (is.null(rows)) { raise("scenario_value_invalid", path, "A square matrix is expected."); return(invisible(NULL)) }
    size <- length(rows)
    bad <- any(vapply(rows, length, integer(1)) != size)
    for (row in rows) for (cell in row) {
      if (!.vcrp_num(cell) || (!is.null(node$min) && cell < node$min) || (!is.null(node$max) && cell > node$max)) bad <- TRUE
    }
    if (bad) { raise("scenario_value_invalid", path, "A square matrix of numbers within bounds is expected."); return(invisible(NULL)) }
    dimension <- if (!is.null(node$size)) .vcrp_items(.vcrp_lookup(ctx$root, node$size)) else NULL
    if (!is.null(dimension) && length(dimension) != size) raise("scenario_value_invalid", path, "The matrix does not match the list it belongs to.")
    return(invisible(NULL))
  }
  if (t == "rules") {
    columns <- if (!is.null(node$columnsFrom)) .vcrp_names_from(ctx$root, node$columnsFrom) else NULL
    for (issue in .vcrp_named_rules_issues(value, columns, path, isTRUE(node$allowEmpty))) {
      if (!identical(issue$code, "rule_expression_forbidden")) ctx$issues[[length(ctx$issues) + 1L]] <- issue
    }
    return(invisible(NULL))
  }
  if (t == "rule") {
    for (issue in .vcrp_rule_issues(value, NULL, path)) {
      if (!identical(issue$code, "rule_expression_forbidden")) ctx$issues[[length(ctx$issues) + 1L]] <- issue
    }
    return(invisible(NULL))
  }
  stop("vcr scenario schema: unknown node type ", t)
}

.vcrp_check_object <- function(node, value, path, ctx) {
  raise <- ctx$raise
  if (!.vcrp_named(value)) { raise("scenario_value_invalid", path, "An object is expected."); return(invisible(NULL)) }
  fields <- node$fields
  active <- function(field) .vcrp_when_holds(field$when, ctx$root)
  for (key in names(value)) {
    if (identical(key, "expression")) next
    if (!(key %in% names(fields)) || !active(fields[[key]])) {
      raise("scenario_field_unknown", .vcrp_at(path, key), "The engine does not read this key here.")
    }
  }
  for (key in names(fields)) {
    field <- fields[[key]]
    required<-isTRUE(field$req)||(!is.null(field$reqWhen)&&.vcrp_when_holds(field$reqWhen,ctx$root))
    if (!active(field)) next
    if (.vcrp_has(value, key) && is.null(value[[key]])) {
      if (!isTRUE(field$nullable)) raise("scenario_value_invalid", .vcrp_at(path, key), "null is not a value; leave the key out.")
      else if (required) raise("scenario_field_missing", .vcrp_at(path, key), "The key is required.")
      next
    }
    if (!.vcrp_present(value, key)) {
      if (required) raise("scenario_field_missing", .vcrp_at(path, key), "The key is required.")
      next
    }
    .vcrp_check_value(field, value[[key]], .vcrp_at(path, key), ctx)
  }
  for (group in node$exactlyOne %||% list()) {
    is_object <- !is.null(names(group))
    keys <- unlist(if (is_object) group$keys else group)
    if (is_object && !.vcrp_when_holds(group$when, ctx$root)) next
    held <- keys[vapply(keys, function(k) .vcrp_present(value, k), logical(1))]
    if (length(held) == 0L) raise("scenario_field_missing", .vcrp_at(path, keys[1]), "Exactly one of these keys is required.")
    else if (length(held) > 1L) raise("scenario_value_invalid", .vcrp_at(path, held[2]), "Give only one of these keys.")
  }
  for (group in node$atLeastOne %||% list()) {
    keys <- unlist(group)
    if (!any(vapply(keys, function(k) .vcrp_present(value, k), logical(1)))) raise("scenario_field_missing", .vcrp_at(path, keys[1]), "At least one of these keys is required.")
  }
  for (key in names(node$requires %||% list())) {
    if (!.vcrp_present(value, key)) next
    for (need in unlist(node$requires[[key]])) {
      if (!.vcrp_present(value, need)) raise("scenario_field_missing", .vcrp_at(path, need), "This key is required when another is given.")
    }
  }
  invisible(NULL)
}

.vcrp_merge <- function(base, over) {
  out <- if (.vcrp_named(base)) base else list()
  for (key in names(over)) out[[key]] <- over[[key]]
  out
}

.vcrp_check_grid <- function(schema, scenario, ctx) {
  designs <- .vcrp_items(scenario[["designs"]])
  truths <- .vcrp_items(scenario[["truths"]])
  if (is.null(designs) || is.null(truths)) return(invisible(NULL))
  if (length(designs) * length(truths) > schema$gridCells) {
    ctx$raise("scenario_value_invalid", "designs", "A grid has a bounded number of cells.")
    return(invisible(NULL))
  }
  cell_schema <- vcr_scenario_schemas()[["design.simulate"]]
  for (d in seq_along(designs)) for (t in seq_along(truths)) {
    if (!.vcrp_named(designs[[d]]) || !.vcrp_named(truths[[t]])) return(invisible(NULL))
    cell <- scenario
    cell[["designs"]] <- NULL
    cell[["truths"]] <- NULL
    cell[["design"]] <- .vcrp_merge(scenario[["design"]], designs[[d]])
    cell[["truth"]] <- .vcrp_merge(scenario[["truth"]], truths[[t]])
    inner <- .vcrp_walk_ctx(cell, ctx$input_ids)
    .vcrp_check_object(cell_schema, cell, "", inner)
    .vcrp_check_design_semantics(cell,"",inner)
    single<-cell$design$kind %in% c("single_arm","single_arm_external","simon_two_stage")
    hit <- Filter(function(i) single || i$code != "scenario_field_unknown", inner$issues)
    if (length(hit)) {
      ctx$raise("scenario_value_invalid",
                if (startsWith(hit[[1]]$field, "truth")) .vcrp_at_index("truths", t) else .vcrp_at_index("designs", d),
                "A cell of the grid is not a valid scenario.")
      return(invisible(NULL))
    }
  }
  invisible(NULL)
}

# Coupled fields of single-arm rules; mirrors checkDesignSemantics in the domain.
.vcrp_check_design_semantics <- function(sc,path,ctx) {
  d<-.vcrp_get(sc,"design");an<-.vcrp_get(sc,"analysis");tr<-.vcrp_get(sc,"truth")
  if(!.vcrp_named(an))an<-list()
  if(!.vcrp_named(tr))tr<-list()
  kind<-.vcrp_get(d,"kind") %||% "";method<-an$method;endpoint<-.vcrp_get(.vcrp_get(sc,"endpoint"),"type")
  if(!.vcrp_chr(kind))kind<-""
  bad<-function(field,detail)ctx$raise("scenario_value_invalid",.vcrp_at(path,field),detail)
  if (!(kind %in% c("single_arm","single_arm_external","simon_two_stage"))) {
    methods<-list(continuous=c("ttest","ancova"),binary=c("risk_difference","logistic"),time_to_event=c("logrank","rmst"))
    allowed<-if(.vcrp_chr(endpoint))methods[[endpoint]] else character(0)
    if (!is.null(method) && !(method %in% allowed)) bad("analysis.method","The analysis must match the endpoint.")
    return(invisible(NULL))
  }
  # the analyses a single-arm design runs, by endpoint (VCR_SINGLE_ARM_ANALYSIS_METHODS in the domain)
  analyses<-list(single_arm=list(binary="exact_binomial",continuous=c("one_sample_t","one_sample_z"),time_to_event="one_sample_logrank"),
    single_arm_external=list(binary="stratified_risk_difference"),simon_two_stage=list(binary="simon_boundary"))
  allowed<-if(.vcrp_chr(endpoint))analyses[[kind]][[endpoint]] else NULL
  if (is.null(allowed)) bad("endpoint.type",if(identical(kind,"single_arm"))"A single-arm design is simulated for a binary, continuous or time-to-event endpoint." else "This single-arm implementation requires a binary endpoint.")
  else if (!is.null(method) && !(method %in% allowed)) bad("analysis.method","The analysis must match the declared single-arm design.")
  sided<-an$sided %||% 1
  if(!.vcrp_num(sided))sided<-1
  if(sided==1 && .vcrp_num(an$alpha) && an$alpha>=.5)bad("analysis.alpha","A one-sided analysis uses alpha below one half.")
  if (kind=="single_arm" && sided!=if(identical(an$alternative,"two.sided"))2 else 1) bad("analysis.sided","Sidedness must agree with the exact binomial alternative.")
  if (kind=="simon_two_stage") {
    if (.vcrp_num(d$n1) && .vcrp_num(d$n) && d$n1>=d$n) bad("design.n1","Stage one is smaller than the total sample size.")
    if (.vcrp_num(d$r1) && .vcrp_num(d$n1) && d$r1>=d$n1) bad("design.r1","Stage one continues only above r1 < n1.")
    if (.vcrp_num(d$r) && .vcrp_num(d$n) && (d$r>=d$n || (!is.null(d$r1) && d$r<d$r1))) bad("design.r","The final threshold satisfies r1 <= r < n.")
    if (sided!=1) bad("analysis.sided","Simon uses the upper one-sided frozen boundary rule.")
    if (.vcrp_num(tr$alternativeRate) && .vcrp_num(tr$nullRate) && tr$alternativeRate<=tr$nullRate) bad("truth.alternativeRate","The alternative rate exceeds the null rate.")
  }
  if (.vcrp_lgl(tr[["null"]]) && !identical(tr[["null"]],.vcrp_is_null_scenario(sc))) bad("truth.null","The null label must agree with the generating estimand.")
  invisible(NULL)
}

#' Validate one method's scenario against its schema (`validateScenario`).
vcr_validate_scenario <- function(method, scenario, input_ids = NULL, path = "scenario") {
  schema <- vcr_scenario_schemas()[[method]]
  if (is.null(schema)) return(list(vcr_issue("method_unknown", "method", "No schema for this method.")))
  if (!is.null(scenario) && !.vcrp_named(scenario) && !is.null(.vcrp_items(scenario))) {
    return(list(vcr_issue("scenario_value_invalid", path, "A scenario is an object, not a list.")))
  }
  if (!.vcrp_named(scenario)) return(list(vcr_issue("scenario_missing", path, "A job carries its frozen scenario, not a reference to one.")))
  ctx <- .vcrp_walk_ctx(scenario, input_ids)
  for (holder in .vcrp_expression_holders(scenario, path)) {
    ctx$raise("rule_expression_forbidden", holder, "A scenario never carries an expression.")
  }
  .vcrp_check_object(schema, scenario, path, ctx)
  if (method %in% c("design.simulate","design.grid","design.analytic")) .vcrp_check_design_semantics(scenario,path,ctx)
  if (!is.null(schema$gridCells)) .vcrp_check_grid(schema, scenario, ctx)
  seen <- character(0)
  Filter(function(issue) {
    key <- paste0(issue$code, "@", issue$field)
    if (key %in% seen) return(FALSE)
    seen <<- c(seen, key)
    TRUE
  }, ctx$issues)
}

# --- validating a job (mirrors validateEngineJob) ----------------------------

#' Validate a job. Returns a list of issues; `list()` is a valid job. Mirrors
#' `validateEngineJob`, including the issue codes, because the control plane
#' renders them and a code invented here would render as raw text.
vcr_validate_job <- function(job) {
  d <- vcr_domain()
  raw <- vcr_domain_raw()
  issues <- list()
  bad <- function(code, field, detail) issues[[length(issues) + 1L]] <<- vcr_issue(code, field, detail)
  if (!.vcrp_named(job)) return(list(vcr_issue("job_not_object", "", "A job is a JSON object.")))

  for (key in names(job)) if (!(key %in% d$jobFields)) bad("job_field_unknown", key, "A job has no such field.")
  id_ok <- function(v) vcr_pattern_match(.vcrp_pat("id"), v)
  if (!id_ok(job[["jobId"]])) bad("job_id_invalid", "jobId", "A job id is 1-121 characters of [A-Za-z0-9_.:-].")
  if (!id_ok(job[["studyId"]])) bad("study_id_invalid", "studyId", "A study id is 1-121 characters of [A-Za-z0-9_.:-].")
  if (!(.vcrp_num(job[["protocolVersion"]]) && job[["protocolVersion"]] == d$protocolVersion)) {
    bad("protocol_version_mismatch", "protocolVersion", sprintf("This build speaks protocol %d.", d$protocolVersion))
  }
  kind <- job[["kind"]]
  kind_known <- .vcrp_chr(kind) && kind %in% d$jobKinds
  if (!kind_known) bad("kind_unknown", "kind", "Unknown job kind.")
  method <- if (.vcrp_chr(job[["method"]])) job[["method"]] else ""
  method_known <- method %in% names(d$methods)
  if (!method_known) bad("method_unknown", "method", "Unknown method.")
  if (kind_known && method_known && !identical(unname(d$jobMethods[[kind]]), method)) {
    bad("kind_method_mismatch", "method", "This kind runs another method.")
  }
  mv <- job[["methodVersion"]]
  if (is.null(mv) || (.vcrp_chr(mv) && !nzchar(mv))) {
    bad("method_version_missing", "methodVersion", "A job names the method version its numbers are validated at.")
  } else if (method_known && !identical(mv, d$methods[[method]]$version) && !.vcrp_legacy_design_version(job,d$methods[[method]])) {
    bad("method_version_mismatch", "methodVersion", "This build has another version of the method.")
  }
  seed <- job[["seed"]]
  if (!(.vcrp_int(seed) && seed >= 0 && seed <= 2147483647)) {
    bad("seed_invalid", "seed", "A seed is an integer from 0 to 2147483647; it is written into the result so the run can be repeated.")
  }
  reps <- job[["replicates"]]
  if (!is.null(reps)) {
    if (!(.vcrp_int(reps) && reps >= 1 && reps <= d$maxReplicates)) bad("replicates_invalid", "replicates", "Replicates is a bounded positive integer.")
  }
  cpu <- job[["cpuSecondsLimit"]]
  if (!(.vcrp_num(cpu) && cpu > 0)) bad("cpu_limit_invalid", "cpuSecondsLimit", "Every job carries its own CPU-second ceiling (plan 11.4).")
  for (spec in list(list("cores", "cores_invalid", 64), list("batchSize", "batch_size_invalid", 100000))) {
    v <- job[[spec[[1]]]]
    if (!is.null(v) && !(.vcrp_int(v) && v >= 1 && v <= spec[[3]])) bad(spec[[2]], spec[[1]], "Out of range.")
  }

  # --- inputs
  inputs <- .vcrp_items(job[["inputs"]])
  input_ids <- character(0)
  if (is.null(inputs)) bad("inputs_missing", "inputs", "A job lists every frozen input it used.")
  else {
    for (i in seq_along(inputs)) {
      input <- inputs[[i]]
      at <- .vcrp_at_index("inputs", i)
      if (!.vcrp_named(input)) { bad("input_not_object", at, "An input is an object."); next }
      if (.vcrp_chr(input[["id"]])) input_ids <- c(input_ids, input[["id"]])
      ikind <- input[["kind"]]
      if (is.null(ikind) || (.vcrp_chr(ikind) && !nzchar(ikind))) bad("input_kind_missing", .vcrp_at(at, "kind"), "An input names what it is.")
      else if (!(.vcrp_chr(ikind) && ikind %in% d$inputKinds)) bad("input_kind_unknown", .vcrp_at(at, "kind"), "Unknown input kind.")
      else if (identical(ikind, d$callerSnapshotKind)) {
        bad("input_kind_caller_only", .vcrp_at(at, "kind"), "A snapshot is what a caller names; the engine receives a table with a location and a hash.")
      }
      if (!vcr_pattern_match(.vcrp_pat("inputId"), input[["id"]])) bad("input_id_invalid", .vcrp_at(at, "id"), "An input carries the id of the object version it froze.")
      else if (.vcrp_chr(ikind) && ikind %in% d$versionedInputKinds && !vcr_pattern_match(.vcrp_pat("version"), input[["id"]])) {
        bad("input_version_missing", .vcrp_at(at, "id"), "A lineage input names a version.")
      }
      # Only the keys the domain allows, by kind: R's `$` matches by prefix, so an
      # extra `locationX` must never reach a reader as `location`.
      allowed_keys <- if (.vcrp_chr(ikind) && ikind %in% d$engineTableInputKinds) unlist(d$engineTableInputKeys)
                      else unlist(d$engineLineageInputKeys)
      if (identical(ikind, d$callerSnapshotKind)) allowed_keys <- unique(c(allowed_keys, unlist(d$engineTableInputKeys)))
      for (key in names(input)) {
        if (!(key %in% allowed_keys)) bad("input_field_unknown", .vcrp_at(at, key), "This input carries a key it may not.")
      }
      has_hash <- !is.null(input[["hash"]])
      if (has_hash && !vcr_pattern_match(.vcrp_pat("sha256"), input[["hash"]])) bad("input_hash_invalid", .vcrp_at(at, "hash"), "An input hash is a lowercase sha256 hex digest.")
      has_source <- !is.null(input[["valueSource"]])
      if (has_source && !(.vcrp_chr(input[["valueSource"]]) && input[["valueSource"]] %in% d$valueSources)) {
        bad("input_value_source_invalid", .vcrp_at(at, "valueSource"), "Unknown value source.")
      }
      cs <- input[["columnSources"]]
      if (!is.null(cs)) {
        where <- .vcrp_at(at, "columnSources")
        if (!.vcrp_named(cs)) {
          bad("input_column_sources_invalid", where, "columnSources is an object: a column name and its source, for the columns that differ from the table.")
        } else {
          lim <- d$columnSourceLimits
          cols <- names(cs)
          if (length(cols) > lim$maxColumns) {
            bad("input_column_sources_invalid", where, "Too many columns carry a source of their own.")
          } else if (any(!nzchar(cols) | .vcrp_chars(cols) > lim$maxNameLength)) {
            bad("input_column_sources_invalid", where, "A column name is a short non-empty string.")
          } else {
            for (i in seq_along(cols)) {
              v <- cs[[i]]
              if (!(.vcrp_chr(v) && v %in% d$columnSources)) bad("input_column_source_invalid", .vcrp_at(where, cols[i]), "A column's source is one of the real-patient sources.")
            }
          }
          if (has_source && !(.vcrp_chr(input[["valueSource"]]) && input[["valueSource"]] %in% d$columnSources)) {
            bad("input_column_source_not_individual", where, "Only a table of real people's rows has sources per column.")
          }
        }
      }
      has_location <- !is.null(input[["location"]])
      if (has_location && !.vcrp_location_valid(input[["location"]])) bad("input_location_invalid", .vcrp_at(at, "location"), "A location is a path relative to the data plane.")
      is_table <- .vcrp_chr(ikind) && ikind %in% d$engineTableInputKinds
      if (is_table || has_location) {
        if (!has_location) bad("input_location_missing", .vcrp_at(at, "location"), "A table input names where the engine reads it.")
        if (!has_hash) bad("input_hash_missing", .vcrp_at(at, "hash"), "A table input carries the sha256 of the file the engine will read.")
        if (!has_source) bad("input_value_source_missing", .vcrp_at(at, "valueSource"), "A table input says what its values are.")
        else if (method %in% names(d$individualInputSources) &&
                 !(input[["valueSource"]] %in% unlist(d$individualInputSources[[method]]))) {
          bad("input_source_not_individual", .vcrp_at(at, "valueSource"), "This method reads real patients and refuses other rows.")
        }
      }
      if (identical(ikind, "analysis_table")) {
        if (!(.vcrp_chr(input[["shape"]]) && input[["shape"]] %in% d$analysisTables)) bad("input_shape_invalid", .vcrp_at(at, "shape"), "An analysis table has a known shape.")
      } else if (!is.null(input[["shape"]])) bad("input_shape_invalid", .vcrp_at(at, "shape"), "Only an analysis_table has a shape.")
    }
  }
  if (kind_known && kind %in% d$patientLevelJobKinds) {
    has_table <- any(vapply(inputs %||% list(), function(x) .vcrp_named(x) && .vcrp_chr(x[["kind"]]) && x[["kind"]] %in% d$engineTableInputKinds, logical(1)))
    if (!has_table) bad("patient_input_required", "inputs", "A patient-level job carries the table the control plane built from its granted snapshot.")
  }

  # --- scenario
  scenario <- job[["scenario"]]
  if (!is.null(scenario) && !.vcrp_named(scenario) && !is.null(.vcrp_items(scenario))) bad("scenario_value_invalid", "scenario", "A scenario is an object, not a list.")
  else if (!.vcrp_named(scenario)) bad("scenario_missing", "scenario", "A job carries its frozen scenario, not a reference to one.")
  else if (method_known) {
    issues <- c(issues, vcr_validate_scenario(method, scenario, input_ids = input_ids))
    supported <- unlist(d$methods[[method]]$endpoints)
    type <- .vcrp_get(.vcrp_get(scenario, "endpoint"), "type")
    type_known <- .vcrp_chr(type) && type %in% d$endpointTypes
    if (type_known && length(supported) && !(type %in% supported)) {
      bad("endpoint_not_supported", "scenario.endpoint.type", "This method does not handle this endpoint type.")
    }
    support <- raw$designSupport[[method]]
    if (!is.null(support) && type_known) {
      cells <- list(list("scenario.design.kind", .vcrp_get(.vcrp_get(scenario, "design"), "kind")))
      designs <- .vcrp_items(scenario[["designs"]])
      if (!is.null(designs)) for (i in seq_along(designs)) cells[[length(cells) + 1L]] <- list(paste0("scenario.designs[", i - 1L, "].kind"), .vcrp_get(designs[[i]], "kind"))
      for (cell in cells) {
        dk <- cell[[2]]
        if (is.null(dk) || !(.vcrp_chr(dk) && dk %in% d$trialDesigns)) next
        if (!(dk %in% names(support)) || !(type %in% unlist(support[[dk]]))) {
          bad("design_not_supported", cell[[1]], "The engine does not implement this design for this endpoint.")
        }
      }
    }
    if (method %in% c("design.simulate", "design.grid")) {
      target <- scenario[["targetMcse"]]
      if (.vcrp_num(target) && target > 0) {
        truths <- if (method == "design.grid") Filter(.vcrp_named, .vcrp_items(scenario[["truths"]]) %||% list()) else list(list())
        if (!length(truths)) truths <- list(list())
        worst <- max(vapply(truths, function(cell) {
          s <- scenario
          s[["truth"]] <- .vcrp_merge(scenario[["truth"]], cell)
          as.numeric(vcr_replicate_floor_for(s))
        }, numeric(1)))
        if (worst > d$maxReplicates) bad("scenario_value_invalid", "scenario.targetMcse", "The precision asked for needs more replicates than the cap.")
      }
    }
  }
  issues
}

.vcrp_legacy_design_version <- function(job,spec) {
  sc<-.vcrp_get(job,"scenario");base<-.vcrp_get(.vcrp_get(sc,"design"),"kind")
  if(!.vcrp_chr(base))base<-""
  designs<-.vcrp_get(sc,"designs")
  kinds<-if(identical(job$method,"design.grid") && is.list(designs))
    vapply(designs,function(d){k<-.vcrp_get(d,"kind") %||% base;if(.vcrp_chr(k))k else ""},character(1)) else base
  if(!is.null(spec$legacyVersion) && identical(job$methodVersion,spec$legacyVersion)) {
    if(!length(kinds))return(TRUE) # malformed/missing design is refused by its scenario issue
    return(all(!(kinds %in% unlist(vcr_domain()$trialDesigns)) | kinds %in% unlist(spec$legacyDesigns)))
  }
  # a later release is recorded by design and endpoint (`legacyReleases`): a job at that version asks for nothing it did not do
  for(release in spec$legacyReleases) {
    if(!identical(job$methodVersion,release$version))next
    if(!length(kinds))return(TRUE)
    endpoint<-.vcrp_get(.vcrp_get(sc,"endpoint"),"type")
    if(!.vcrp_chr(endpoint))endpoint<-""
    return(all(vapply(kinds,function(k)!(k %in% unlist(vcr_domain()$trialDesigns)) || endpoint %in% unlist(release$support[[k]]),logical(1))))
  }
  FALSE
}

#' Validate a result. Mirrors `validateEngineResult`. The engine runs this on
#' its own output before answering: a result that cannot be validated here
#' would be refused by the control plane anyway, and finding out in-process is
#' the difference between a named issue and a silent 422.
vcr_validate_result <- function(result) {
  d <- vcr_domain()
  issues <- list()
  bad <- function(code, field, detail) issues[[length(issues) + 1L]] <<- vcr_issue(code, field, detail)
  if (!.vcrp_named(result)) return(list(vcr_issue("result_not_object", "", "A result is a JSON object.")))
  zero <- strrep("0", 64)
  sha_ok <- function(v) vcr_pattern_match(.vcrp_pat("sha256"), v) && !identical(v, zero)

  if (!vcr_pattern_match(.vcrp_pat("id"), result[["jobId"]])) bad("job_id_invalid", "jobId", "A result carries the job id it answers.")
  if (!(.vcrp_num(result[["protocolVersion"]]) && result[["protocolVersion"]] == d$protocolVersion)) {
    bad("protocol_version_mismatch", "protocolVersion", sprintf("This build speaks protocol %d.", d$protocolVersion))
  }
  status <- result[["status"]]
  if (!(.vcrp_chr(status) && status %in% c("succeeded", "failed", "canceled", "not_estimable"))) {
    bad("status_unknown", "status", "A result is succeeded, failed, canceled or not_estimable.")
  }
  if (!sha_ok(result[["scenarioHash"]])) bad("scenario_hash_invalid", "scenarioHash", "A result carries the sha256 of the canonical scenario it ran.")

  if (!(.vcrp_chr(result[["method"]]) && result[["method"]] %in% names(d$methods))) bad("method_unknown", "method", "A result echoes the method it ran.")
  if (!(.vcrp_chr(result[["methodVersion"]]) && nzchar(result[["methodVersion"]]))) bad("method_version_missing", "methodVersion", "A result echoes the method version it ran.")
  if (!(.vcrp_int(result[["seed"]]) && result[["seed"]] >= 0 && result[["seed"]] <= 2147483647)) bad("seed_invalid", "seed", "A result echoes the seed it ran with.")
  if (!("replicates" %in% names(result))) bad("replicates_missing", "replicates", "A result states its replicate count, or null when the method has none.")
  else if (!is.null(result[["replicates"]]) && !(.vcrp_int(result[["replicates"]]) && result[["replicates"]] >= 1)) {
    bad("replicates_invalid", "replicates", "Replicates is a positive integer, or null.")
  }

  finished <- .vcrp_chr(status) && status %in% c("succeeded", "not_estimable")
  conclusion <- result[["conclusion"]]
  if (is.null(conclusion)) {
    if (finished) bad("conclusion_missing", "conclusion", "A finished result states its conclusion.")
  } else if (!(.vcrp_chr(conclusion) && conclusion %in% d$conclusions)) {
    bad("conclusion_unknown", "conclusion", "conclusion is one of the three scientific conclusions.")
  }
  not_estimable <- identical(status, "not_estimable") || identical(conclusion, "not_estimable")
  if (not_estimable) {
    rule <- result[["notEstimableRule"]]
    if (is.null(rule) || (.vcrp_chr(rule) && !nzchar(rule))) bad("not_estimable_rule_missing", "notEstimableRule", "A not-estimable result names the deterministic rule that fired (plan 5.3).")
    else if (!(.vcrp_chr(rule) && rule %in% d$notEstimableRules)) bad("not_estimable_rule_unknown", "notEstimableRule", "notEstimableRule is one of the closed rules.")
    if (identical(status, "not_estimable") && !is.null(conclusion) && !identical(conclusion, "not_estimable")) {
      bad("conclusion_status_mismatch", "conclusion", "A not_estimable result concludes not_estimable.")
    }
  }

  measures <- .vcrp_items(result[["measures"]])
  if (is.null(measures)) {
    bad("measures_missing", "measures", "A result lists its measures, even when the list is empty.")
  } else {
    for (i in seq_along(measures)) {
      m <- measures[[i]]
      at <- .vcrp_at_index("measures", i)
      if (!.vcrp_named(m)) { bad("measure_not_object", at, "A measure is an object."); next }
      if (is.null(m[["name"]])) bad("measure_name_missing", .vcrp_at(at, "name"), "A measure is named.")
      if (!.vcrp_num(m[["value"]])) {
        bad("measure_value_invalid", .vcrp_at(at, "value"), "A measure carries a finite number; a failed computation is an issue, never a 0 (plan 9.6).")
      }
      src <- m[["source"]]
      if (is.null(src) || (.vcrp_chr(src) && !nzchar(src))) bad("measure_source_missing", .vcrp_at(at, "source"), "Every measure says where its number came from.")
      else if (!(.vcrp_chr(src) && src %in% d$valueSources)) bad("measure_source_invalid", .vcrp_at(at, "source"), "source is one of the nine value sources.")
      mcse_ok <- .vcrp_num(m[["mcse"]]) && m[["mcse"]] >= 0
      if (isTRUE(m[["simulated"]]) && !mcse_ok) bad("mcse_missing", .vcrp_at(at, "mcse"), "Every simulated measure reports its Monte-Carlo standard error (AC-28).")
      else if (!is.null(m[["mcse"]]) && !mcse_ok) bad("mcse_invalid", .vcrp_at(at, "mcse"), "A standard error is a non-negative number.")
      iv <- m[["interval"]]
      if (!is.null(iv)) {
        if (!(.vcrp_named(iv) && .vcrp_chr(iv[["kind"]]) && iv[["kind"]] %in% d$intervalKinds)) {
          bad("interval_kind_unknown", .vcrp_at(at, "interval.kind"), "An interval names which kind it is (plan 8.3).")
        } else if (!(.vcrp_num(iv[["low"]]) && .vcrp_num(iv[["high"]]) && iv[["low"]] <= iv[["high"]])) {
          bad("interval_invalid", .vcrp_at(at, "interval"), "An interval has finite bounds with low not above high.")
        }
      }
    }
  }

  if (!is.null(result[["counts"]])) {
    for (issue in vcr_validate_counts(result[["counts"]])) {
      bad(issue$code, if (nzchar(issue$field)) paste0("counts.", issue$field) else "counts", issue$detail)
    }
  }
  tables <- .vcrp_items(result[["tables"]])
  if (!is.null(tables)) for (i in seq_along(tables)) {
    t <- tables[[i]]
    if (!(.vcrp_named(t) && !is.null(t[["name"]]) && vcr_pattern_match(.vcrp_pat("sha256"), t[["sha256"]]))) {
      bad("table_invalid", .vcrp_at_index("tables", i), "A table names itself and carries its sha256.")
    }
  }
  models <- .vcrp_items(result[["models"]])
  if (!is.null(models)) for (i in seq_along(models)) {
    m <- models[[i]]
    at <- .vcrp_at_index("models", i)
    if (!(.vcrp_named(m) && .vcrp_chr(m[["tier"]]) && m[["tier"]] %in% d$modelTiers)) bad("model_tier_invalid", .vcrp_at(at, "tier"), "tier is one of the four model tiers.")
    if (.vcrp_named(m) && !is.null(m[["risk"]]) && !(.vcrp_chr(m[["risk"]]) && m[["risk"]] %in% d$modelRisks)) bad("model_risk_invalid", .vcrp_at(at, "risk"), "risk is one of the four model risks.")
  }

  manifest <- result[["manifest"]]
  if (!.vcrp_named(manifest)) {
    bad("manifest_missing", "manifest", "A result carries the manifest that lets it be repeated.")
  } else {
    for (field in c("engineVersion", "rVersion", "packageLockHash", "startedAt", "finishedAt", "cpuSeconds")) {
      v <- manifest[[field]]
      if (is.null(v) || (.vcrp_chr(v) && !nzchar(v))) bad("manifest_field_missing", paste0("manifest.", field), sprintf("The manifest states %s (AC-04).", field))
    }
    cs <- manifest[["cpuSeconds"]]
    if (.vcrp_num(cs) ) { if (cs < 0) bad("cpu_seconds_invalid", "manifest.cpuSeconds", "CPU seconds is a non-negative number.") }
    else if (!is.null(cs) && !(.vcrp_chr(cs) && !nzchar(cs))) bad("cpu_seconds_invalid", "manifest.cpuSeconds", "CPU seconds is a non-negative number.")
    plh <- manifest[["packageLockHash"]]
    if (!is.null(plh) && !(.vcrp_chr(plh) && !nzchar(plh)) && !sha_ok(plh)) bad("package_lock_hash_invalid", "manifest.packageLockHash", "The package lock hash is a lowercase sha256 hex digest.")
    oh <- manifest[["outputHash"]]
    if (is.null(oh)) { if (finished) bad("output_hash_missing", "manifest.outputHash", "A finished result carries the hash of its output.") }
    else if (!sha_ok(oh)) bad("output_hash_invalid", "manifest.outputHash", "An output hash is a lowercase sha256 hex digest.")
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

#' Mirrors `validateCounts`, including the effective-sample-size bound: a
#' weighted effective sample size never exceeds the real patients it weights,
#' whether or not any records were generated.
vcr_validate_counts <- function(counts) {
  issues <- list()
  if (!.vcrp_named(counts)) return(list(vcr_issue("counts_not_object", "", "Counts are an object.")))
  for (key in names(counts)) {
    v <- counts[[key]]
    if (is.null(v)) next
    if (!(.vcrp_num(v) && v >= 0)) {
      issues[[length(issues) + 1L]] <- vcr_issue("count_invalid", key,
        "A count is a non-negative number or null (not knowable), never 0 standing in for unknown.")
    }
  }
  rp <- counts[["realPatients"]]
  ess <- counts[["effectiveSampleSize"]]
  if (.vcrp_num(rp) && .vcrp_num(ess) && ess > rp) {
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
