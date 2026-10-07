# N49 — the 2026-10-07 extensions agree with the domain, and survive being broken.
#
# N49a is N00f for the extensions' own parity file (`fixtures/vcr-engine-jobs-extensions.json`): the same jobs through the
# domain's `validateEngineJob` and the engine's `vcr_validate_job`, the whole verdict compared, then the fixture held to its own
# account. N49b runs E10a's breaking battery over the extensions' handler jobs only, so a defect in one of them is named by a
# case of its own and not found in a 20-minute walk. N49c holds the scenario help the platform hands a model to what the engine
# runs: every example the domain publishes for the new methods and designs is a scenario the engine accepts and runs.

vcr_case("N49a", c("AC-04", "AC-30"), function() {
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  name <- "vcr-engine-jobs-extensions.json"
  fx <- .n00_fixture(name)
  js <- .n00_node("emit-job-verdicts.mjs", file.path(.n00_domain_dir(), "test", "fixtures", name))
  items <- c(fx$valid, fx$invalid)
  drift <- character(0)
  for (i in seq_along(items)) {
    got <- as.character(.n00_issue_keys(vcr_validate_job(items[[i]]$job)))
    want <- as.character(sort(unlist(js$jobs[[i]]$issues)))
    if (!identical(got, want)) drift <- c(drift, sprintf("%s: R [%s] vs JS [%s]", items[[i]]$name, paste(got, collapse = " "), paste(want, collapse = " ")))
  }
  unclean <- Filter(function(item) length(vcr_validate_job(item$job)) > 0L, fx$valid)
  missed <- 0L
  for (item in fx$invalid) missed <- missed + sum(!(unlist(item$expected) %in% .n00_issue_keys(vcr_validate_job(item$job))))
  methods <- unique(vapply(fx$valid, function(item) item$job$method, character(1)))
  want_methods <- c("patients.longitudinal", "design.assurance", "design.simulate", "design.grid")
  ok <- !length(drift) && !length(unclean) && missed == 0L && all(want_methods %in% methods) && length(fx$invalid) >= 20L
  list(pass = ok,
       detail = sprintf("%d extension jobs (%d valid, %d invalid, methods %s): %d verdicts differ from the domain's, %d valid jobs refused, %d expected issues missing%s",
                        length(items), length(fx$valid), length(fx$invalid), paste(methods, collapse = "+"), length(drift), length(unclean), missed,
                        if (length(drift)) paste0("; first: ", drift[1]) else ""))
})

vcr_case("N49b", c("AC-04", "AC-26"), function() {
  # E10a's battery on the extensions: every leaf of the valid scenario broken in turn (a string, a negative number, an empty array, an
  # object) and every key dropped. Whatever happens the job returns a protocol-valid result: no uncaught error, no `handler_error`
  # (an R error nobody anticipated), and a refusal names a field and a code. A battery that refused nothing would prove nothing, so most
  # breakages must be refused.
  mine <- vcr_test_extension_handler_jobs()
  junk <- list("junk", -1, list(), list(x = 1))
  dir <- tempfile("n49b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  runs <- 0L; refused <- 0L; bad <- character(0)
  one <- function(label, job) {
    r <- tryCatch(vcr_test_run(job, output_dir = dir), error = function(e) e)
    runs <<- runs + 1L
    if (inherits(r, "error")) { bad <<- c(bad, sprintf("%s raised: %s", label, substr(conditionMessage(r), 1, 80))); return(invisible()) }
    codes <- vcr_test_issue_codes(r)
    if ("handler_error" %in% codes) bad <<- c(bad, paste(label, "handler_error"))
    if (length(vcr_validate_result(r))) bad <<- c(bad, paste(label, "invalid result"))
    if (identical(r$status, "failed")) {
      refused <<- refused + 1L
      iss <- r$diagnostics$issues %||% list()
      if (!length(iss) || !all(vapply(iss, function(i) is.character(i$code) && nzchar(i$code) && is.character(i$field) && nzchar(i$field), logical(1)))) bad <<- c(bad, paste(label, "unnamed refusal"))
    }
    invisible()
  }
  for (cs in mine) {
    base <- vcr_test_job(cs[[1]], cs[[2]], cs[[3]], seed = 5L, replicates = if (length(cs) >= 4L) min(cs[[4]], 60L) else NULL)
    for (path in .e10_paths(cs[[2]])) {
      if (!length(path)) next
      lab <- sprintf("%s:%s", cs[[1]], paste(path, collapse = "."))
      for (j in seq_along(junk)) { job <- base; job$scenario <- .e10_set(job$scenario, path, junk[[j]]); one(sprintf("%s=%d", lab, j), job) }
      if (is.character(path[[length(path)]])) { job <- base; job$scenario <- .e10_drop(job$scenario, path); one(paste0(lab, "=drop"), job) }
    }
  }
  list(pass = !length(bad) && runs >= 100L && refused > runs / 2,
       detail = sprintf("%d broken extension jobs: %d refused by name, %d came back succeeded, %d defects%s", runs, refused, runs - refused, length(bad),
                        if (length(bad)) paste0(" (first: ", bad[1], ")") else ""))
})

vcr_case("N49c", c("AC-04", "AC-30"), function() {
  # The help a model writes a scenario from is generated from the domain's schemas, and its examples are checked by the domain's validator. Here
  # the engine runs them: the example of every method this release added or extended is given to the engine as a job, validates against the
  # engine's own validator and runs to a result (the replicate counts are held down: the example is a shape, not a study).
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  help <- jsonlite::parse_json(paste(readLines(file.path(.n00_domain_dir(), "..", "..", "runtime", "mcp", "evimed-research", "vcr_scenario_help.json"), warn = FALSE, encoding = "UTF-8"), collapse = "\n"), simplifyVector = FALSE)
  methods <- c("patients.longitudinal", "design.assurance", "design.simulate", "population.scenario", "population.literature")
  rows <- list()
  for (m in methods) for (ex in help$methods[[m]]$examples) {
    sc <- ex$scenario
    job <- vcr_test_job(m, sc, NULL, seed = 7L, replicates = if (m %in% c("design.simulate")) 200L else NULL)
    issues <- vcr_validate_job(vcr_test_json(job))
    r <- if (length(issues)) NULL else vcr_test_run(job)
    rows[[length(rows) + 1L]] <- list(m = m, label = ex$label, valid = !length(issues), ran = !is.null(r) && identical(r$status, "succeeded"))
  }
  ok <- length(rows) >= 9L && all(vapply(rows, function(x) x$valid && x$ran, logical(1)))
  list(pass = ok,
       detail = sprintf("%d domain examples across %d methods, every one a valid job that the engine runs to a result: %s", length(rows), length(methods),
                        paste(vapply(rows, function(x) sprintf("%s (%s)", x$m, if (x$valid && x$ran) "ok" else "FAILED"), character(1)), collapse = ", ")))
})

vcr_case("N49d", c("AC-26", "AC-30"), function() {
  # A caller's key is read exactly. R's `$` on a list matches a key by its prefix (`input$location` returned `locationX`; case N30 and the
  # 2026-09-29 review), and the per-kind key lists keep that unexploitable only where the lists are right; the code that reads a caller's
  # scenario in this release does not rely on them: every new reader takes its keys with `[["key"]]`. The scan reads the source of the new
  # files and of the new functions in the shared ones and fails on a `$` applied to a variable that holds something a caller wrote.
  root <- VCR_ROOT
  read_src <- function(f) readLines(file.path(root, "R", f), warn = FALSE, encoding = "UTF-8")
  function_lines <- function(lines, name) {
    start <- which(startsWith(lines, paste0(name, " <- function")))
    if (!length(start)) return(NULL)
    nxt <- which(grepl("^[.A-Za-z_][.A-Za-z0-9_]* <- function", lines) & seq_along(lines) > start[1])
    lines[start[1]:((if (length(nxt)) nxt[1] else length(lines) + 1L) - 1L)]
  }
  # the names this release gives to what a caller wrote (the scenario and the objects inside it); internal lists have other names
  holders <- c("sc", "tr", "an", "acc", "re", "d", "job", "scenario", "truth", "analysis", "spec", "row", "v", "declared")
  pattern <- sprintf("(^|[^A-Za-z0-9_.\"'])(%s)\\$[A-Za-z_]", paste(holders, collapse = "|"))
  targets <- list(
    list("longitudinal.R", NULL),
    list("single_arm.R", NULL),
    list("population.R", c(".vcr_declared_scenario", ".vcr_declared_literature", ".vcr_rule_columns", ".vcr_profile_kind", ".vcr_profile_variable", "vcr_population_profile")),
    list("assurance.R", c("vcr_gs_exits", "vcr_assurance_group_sequential", "vcr_assurance_group_sequential_simulated")),
    list("engine.R", c(".vcr_job_assurance_group_sequential")))
  hits <- character(0); scanned <- 0L; functions <- 0L
  for (tg in targets) {
    lines <- read_src(tg[[1]])
    bodies <- if (is.null(tg[[2]])) list(lines) else lapply(tg[[2]], function(nm) { b <- function_lines(lines, nm); if (is.null(b)) hits <<- c(hits, paste(tg[[1]], nm, "not found")); b })
    for (b in bodies) {
      if (is.null(b)) next
      functions <- functions + 1L; scanned <- scanned + length(b)
      code <- b[!grepl("^\\s*#", b)]
      code <- sub("#.*$", "", code)    # a trailing comment may talk about `x$y`
      bad <- grep(pattern, code, perl = TRUE, value = TRUE)
      if (length(bad)) hits <- c(hits, paste0(tg[[1]], ": ", trimws(substr(bad[1], 1, 90))))
    }
  }
  list(pass = !length(hits) && functions >= 12L && scanned > 500L,
       detail = sprintf("%d new files / functions, %d lines scanned: %s", functions, scanned,
                        if (length(hits)) paste0("a caller's key read with $: ", paste(hits, collapse = "; ")) else "every caller key is read with [[ ]]"))
})
