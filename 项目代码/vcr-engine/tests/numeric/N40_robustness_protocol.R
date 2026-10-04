# N40 — the robustness methods agree with the domain, and survive being broken.
#
# N40a is N00f for the robustness methods' own parity file
# (`fixtures/vcr-engine-jobs-robustness.json`): the same jobs through the domain's
# `validateEngineJob` and the engine's `vcr_validate_job`, the whole verdict
# compared, then the fixture held to its own account. N40b runs E10a's breaking
# battery over the robustness methods' scenarios only, so a defect in one of them
# is named by a case of its own and not found in a 20-minute walk.

vcr_case("N40a", c("AC-04", "AC-30"), function() {
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  name <- "vcr-engine-jobs-robustness.json"
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
  want_methods <- c("comparator.negative_control", "comparator.tipping_point", "comparator.prognostic_adjustment")
  ok <- !length(drift) && !length(unclean) && missed == 0L && all(want_methods %in% methods)
  list(pass = ok,
       detail = sprintf("%d robustness jobs (%d valid, %d invalid, methods %s): %d verdicts differ from the domain's, %d valid jobs refused, %d expected issues missing%s",
                        length(items), length(fx$valid), length(fx$invalid), paste(methods, collapse = "+"), length(drift), length(unclean), missed,
                        if (length(drift)) paste0("; first: ", drift[1]) else ""))
})

vcr_case("N40b", c("AC-04", "AC-26"), function() {
  # E10a's battery on the robustness methods: every leaf of the valid scenario broken in turn (a string, a
  # negative number, an empty array, an object) and every key dropped. Whatever happens the job returns a
  # protocol-valid result: no uncaught error, no `handler_error` (an R error nobody anticipated), and a refusal
  # names a field and a code. A battery that refused nothing would prove nothing, so most breakages must be refused.
  mine <- vcr_test_robustness_handler_jobs()
  junk <- list("junk", -1, list(), list(x = 1))
  dir <- tempfile("n40b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
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
  list(pass = !length(bad) && runs >= 20L && refused > runs / 2,
       detail = sprintf("%d broken robustness jobs: %d refused by name, %d came back succeeded, %d defects%s", runs, refused, runs - refused, length(bad),
                        if (length(bad)) paste0(" (first: ", bad[1], ")") else ""))
})
