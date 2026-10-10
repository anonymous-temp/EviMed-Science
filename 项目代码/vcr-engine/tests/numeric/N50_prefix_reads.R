# N50 — no scenario key is read by prefix.
#
# R's `$` on a list returns the one name that BEGINS with the name asked for when the name asked for is absent: `sc$correlation` is
# `sc$correlationSource` for a literature population that states a source and no matrix, `prior$basis` is `prior$basisOverride`
# (the value `TRUE`) for a design prior that states an override and no basis, `spec$correlation` is `spec$correlationScale`. The
# domain's schemas have such pairs (a key that is a strict prefix of a sibling), and an optional key of such a pair is one the
# caller may leave out while its sibling is there. A read of it with `$` is a read of the sibling. `[[ ]]` matches exactly.
#
# This case derives the pairs from the schemas the engine holds (R/domain-snapshot.json), takes the keys of them that may be absent
# (not required whatever else holds), and fails on any `$name` read of one in R/*.R. A key a schema adds later is covered the day it is
# added. Single-letter keys (`n`, `r`) are left out on purpose: they name a count, and the internal lists of the engine have a
# thousand `$n`; the scenario reads of them are in the single-arm branches where the schema requires them, and protocol.R reads them
# with `[[ ]]`.
#
# The job itself has such a pair (`method` is a strict prefix of `methodVersion` in the domain's job fields): the refusal of a job that
# names no method used to echo its version as its method. Job fields are read off a variable called `job` or `j`, which is how the engine
# names a job, so that is what the second scan looks for (a `$method` on any other list, an analysis or a pooling result, is another key).

.n50_hazards <- function(schemas) {
  found <- character(0)
  consider <- function(fields) {
    nm <- names(fields)
    for (a in nm) for (b in nm) if (a != b && startsWith(b, a) && nchar(a) > 1L) {
      f <- fields[[a]]
      required_always <- isTRUE(f$req) && is.null(f$when)
      if (!required_always) found <<- c(found, a)
    }
  }
  walk <- function(node) {
    if (!is.list(node)) return(invisible(NULL))
    if (identical(node$t, "object") && is.list(node$fields)) { consider(node$fields); for (k in names(node$fields)) walk(node$fields[[k]]) }
    else if (identical(node$t, "variant")) for (vn in names(node$variants)) { consider(node$variants[[vn]]); for (k in names(node$variants[[vn]])) walk(node$variants[[vn]][[k]]) }
    else if (identical(node$t, "array") && !is.null(node$items)) walk(node$items)
    else if (identical(node$t, "map") && !is.null(node$values)) walk(node$values)
  }
  for (m in names(schemas)) walk(schemas[[m]])
  sort(unique(found))
}

#' The reads of `$<name>` in a line of R, outside comments and not assignments. A trailing comment is cut at the first `#` that is not inside a string.
.n50_reads <- function(line, names_) {
  cut <- line; in_s <- NA_character_
  chars <- strsplit(line, "", fixed = TRUE)[[1]]
  for (i in seq_along(chars)) {
    ch <- chars[i]
    if (!is.na(in_s)) { if (ch == in_s && (i == 1L || chars[i - 1L] != "\\")) in_s <- NA_character_ }
    else if (ch %in% c("\"", "'")) in_s <- ch
    else if (ch == "#") { cut <- substr(line, 1L, i - 1L); break }
  }
  hits <- character(0)
  for (nm in names_) {
    m <- gregexpr(sprintf("\\$%s\\b(?!\\s*(<-|=(?!=)))", nm), cut, perl = TRUE)[[1]]
    if (m[1] != -1L) hits <- c(hits, rep(nm, length(m)))
  }
  hits
}

#' The job fields that are a strict prefix of another job field.
.n50_job_hazards <- function(fields) {
  fields <- unlist(fields)
  sort(unique(unlist(lapply(fields, function(a) if (any(startsWith(setdiff(fields, a), a))) a))))
}

#' The reads of `job$<name>` / `j$<name>` in a line of R (comments cut, assignments not reads).
.n50_job_reads <- function(line, names_) {
  cut <- sub("\\s#.*$", "", line)
  hits <- character(0)
  for (nm in names_) {
    m <- gregexpr(sprintf("(?<![A-Za-z0-9_.])(job|j)\\$%s\\b(?!\\s*(<-|=(?!=)))", nm), cut, perl = TRUE)[[1]]
    if (m[1] != -1L) hits <- c(hits, rep(nm, length(m)))
  }
  hits
}

vcr_case("N50", c("AC-04", "AC-30"), function() {
  hazards <- .n50_hazards(vcr_domain_raw()$scenarioSchemas)
  job_hazards <- .n50_job_hazards(vcr_domain()$jobFields)
  # the scanner, on lines whose answer is known
  probe <- c(flag = "x <- sc$correlation", exact = "x <- sc[[\"correlation\"]]", longer = "x <- sc$correlationSource", assign = "sc$correlation <- m",
             assign_eq = "sc$correlation = m", compare = "if (sc$correlation == 1) 2", comment = "x <- 1 # sc$correlation", quoted = "x <- \"#\"; y <- sc$basis")
  got <- vapply(probe, function(l) length(.n50_reads(l, c("correlation", "basis"))), integer(1))
  scanner_ok <- identical(unname(got), c(1L, 0L, 0L, 0L, 0L, 1L, 0L, 1L))
  job_probe <- c(flag = "x <- job$method", flag_j = "x <- j$method", exact = "x <- job[[\"method\"]]", longer = "x <- job$methodVersion", assign = "j$method <- m",
                 other_list = "x <- an$method", other_prefix = "x <- subjob$method", comment = "x <- 1 # job$method")
  job_got <- vapply(job_probe, function(l) length(.n50_job_reads(l, "method")), integer(1))
  job_scanner_ok <- identical(unname(job_got), c(1L, 1L, 0L, 0L, 0L, 0L, 0L, 0L))
  files <- sort(list.files(file.path(VCR_ROOT, "R"), pattern = "\\.R$", full.names = TRUE))
  offenders <- character(0); job_offenders <- character(0); lines_read <- 0L
  for (f in files) {
    ls <- readLines(f, warn = FALSE, encoding = "UTF-8"); lines_read <- lines_read + length(ls)
    for (i in seq_along(ls)) {
      hit <- .n50_reads(ls[i], hazards)
      if (length(hit)) offenders <- c(offenders, sprintf("%s:%d $%s", basename(f), i, paste(unique(hit), collapse = " $")))
      hit <- .n50_job_reads(ls[i], job_hazards)
      if (length(hit)) job_offenders <- c(job_offenders, sprintf("%s:%d job$%s", basename(f), i, paste(unique(hit), collapse = " job$")))
    }
  }
  # behaviour: a job that names a version and no method is refused without naming a method of its own
  nameless <- vcr_run_job(list(jobId = "job_n50", studyId = "std_n50", kind = "evalue_comparator", methodVersion = "1.0.0", protocolVersion = 1L,
                               scenario = list(riskRatio = 2), inputs = list(), seed = 1L, cpuSecondsLimit = 60))
  nameless_ok <- identical(nameless$status, "failed") && is.null(nameless$method) && identical(nameless$methodVersion, "1.0.0") &&
    "method_unknown" %in% vcr_test_issue_codes(nameless)
  expected <- c("basis", "controlRate", "correlation", "null", "proportion", "treatmentRate")
  list(pass = scanner_ok && job_scanner_ok && all(expected %in% hazards) && identical(job_hazards, "method") && length(files) >= 25L && lines_read > 10000L &&
         length(offenders) == 0L && length(job_offenders) == 0L && nameless_ok,
       detail = sprintf("%d keys that are a strict prefix of a sibling and may be absent (%s) and, among the job's own fields, %s; %d R files, %d lines read; the scanners tell a read from a longer name, an assignment, a comment and a quoted '#' (%s); reads by prefix: %d%s; job fields read by prefix: %d%s; a job with a version and no method -> %s, method echoed: %s",
                        length(hazards), paste(hazards, collapse = ", "), paste(job_hazards, collapse = ", "), length(files), lines_read,
                        if (scanner_ok && job_scanner_ok) "yes" else "NO", length(offenders),
                        if (length(offenders)) paste0(" -- ", paste(utils::head(offenders, 8L), collapse = "; ")) else "",
                        length(job_offenders), if (length(job_offenders)) paste0(" -- ", paste(utils::head(job_offenders, 8L), collapse = "; ")) else "",
                        nameless$status, format(nameless$method %||% "(none)")))
})
