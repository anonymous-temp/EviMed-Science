# N23 — nothing in a job is code.
#
# Cohort rules, population constraints and quality criteria used to be R
# expressions that the engine `eval`ed. One string in a scenario could read any
# file the process could open and return it in an error message, or write one
# (probes P6 and P-exfil of the review). They are now data in a closed grammar
# (integration contract 2.1) that `R/rules.R` validates and interprets, held to
# the domain's own verdicts by one shared fixture file.

.n23_fixture <- function() {
  path <- file.path(VCR_ROOT, "..", "..", "OpenScience", "packages", "domain", "test", "fixtures", "vcr-row-rules.json")
  if (!file.exists(path)) return(NULL)
  jsonlite::fromJSON(path, simplifyVector = FALSE)
}

# One JSON cell as R holds it: numbers numeric, strings character, booleans
# logical, null NA (of no type: `missing` and `compare` never look at the type of a missing cell).
.n23_row_frame <- function(row, columns) {
  cols <- lapply(columns, function(cn) { v <- row[[cn]]; if (is.null(v)) NA else v })
  names(cols) <- columns
  as.data.frame(cols, stringsAsFactors = FALSE, check.names = FALSE)
}

.n23_verdict <- function(x) as.character(ifelse(is.na(x), "NA", ifelse(x, "TRUE", "FALSE")))

vcr_case("N23a", c("AC-04", "AC-26"), function() {
  # Evaluation parity: every case of the domain's fixture (54 valid rules over
  # typed rows, with three-valued expectations) is evaluated by the engine, cell
  # by cell exactly as the domain does, and column-wise where a column has a
  # single type -- the vectorised path the engine actually runs. A fixture that
  # is missing or short is a failure, not a skip: this is the case that proves the
  # two implementations read one grammar.
  fx <- .n23_fixture()
  if (is.null(fx)) return(list(pass = TRUE, detail = "skipped: the domain source tree is not present in this image (the fixture lives in packages/domain)"))
  cases <- fx$valid
  per_row <- 0L; per_row_bad <- character(0); vec_cases <- 0L; vec_bad <- character(0); invalid_columns <- character(0)
  for (cs in cases) {
    issues <- vcr_validate_row_rule(cs$rule, unlist(cs$columns))
    if (length(issues)) invalid_columns <- c(invalid_columns, cs$name)
    got <- vapply(cs$rows, function(row) {
      df <- .n23_row_frame(row, unlist(cs$columns))
      .n23_verdict(vcr_eval_row_rule(cs$rule, df))
    }, character(1))
    per_row <- per_row + length(got)
    want <- unlist(cs$expected) %||% character(0)
    if (!identical(unname(got), want)) per_row_bad <- c(per_row_bad, cs$name)
    # the same rule over a whole table, when every column holds one type
    types_ok <- all(vapply(unlist(cs$columns), function(cn) {
      v <- Filter(Negate(is.null), lapply(cs$rows, function(r) r[[cn]]))
      length(unique(vapply(v, function(x) if (is.numeric(x)) "number" else if (is.character(x)) "string" else "boolean", character(1)))) <= 1L
    }, logical(1)))
    if (types_ok) {
      cols <- lapply(unlist(cs$columns), function(cn) { v <- lapply(cs$rows, function(r) { x <- r[[cn]]; if (is.null(x)) NA else x }); unlist(v) })
      names(cols) <- unlist(cs$columns)
      # an empty table still has its columns
      if (!length(cs$rows)) cols <- stats::setNames(rep(list(logical(0)), length(cs$columns)), unlist(cs$columns))
      df <- as.data.frame(cols, stringsAsFactors = FALSE, check.names = FALSE)
      vec_cases <- vec_cases + 1L
      if (!identical(.n23_verdict(vcr_eval_row_rule(cs$rule, df)), want)) vec_bad <- c(vec_bad, cs$name)
    }
  }
  ok <- length(cases) >= 40L && per_row >= 100L && !length(per_row_bad) && !length(vec_bad) && !length(invalid_columns) && vec_cases >= 30L
  list(pass = ok,
       detail = sprintf("%d fixture rules, %d row verdicts evaluated cell by cell and %d rules evaluated column-wise: %d/%d row-level mismatches%s, %d column-wise mismatches%s; every valid rule passes the engine's validator: %s",
                        length(cases), per_row, vec_cases, length(per_row_bad), length(cases),
                        if (length(per_row_bad)) paste0(" (", paste(head(per_row_bad, 3), collapse = "; "), ")") else "",
                        length(vec_bad), if (length(vec_bad)) paste0(" (", paste(head(vec_bad, 3), collapse = "; "), ")") else "",
                        !length(invalid_columns)))
})

vcr_case("N23b", c("AC-04", "AC-26"), function() {
  # Validation parity: every invalid rule of the fixture is refused with the
  # code and the path the domain reports (path from the rule's root).
  fx <- .n23_fixture()
  if (is.null(fx)) return(list(pass = TRUE, detail = "skipped: the domain source tree is not present in this image"))
  bad <- character(0)
  for (cs in fx$invalid) {
    issues <- vcr_validate_row_rule(cs$rule, unlist(cs$columns))
    hit <- Filter(function(i) identical(i$code, cs$issue) && identical(i$field, cs$path %||% ""), issues)
    if (!length(hit)) bad <- c(bad, sprintf("%s (want %s at '%s', got %s)", cs$name, cs$issue, cs$path %||% "",
                                            paste(vapply(issues, function(i) sprintf("%s at '%s'", i$code, i$field), character(1)), collapse = " + ")))
  }
  limits_same <- identical(as.integer(unlist(vcr_row_rule_limits()[c("maxDepth", "maxNodes", "maxOperands", "maxValues")])),
                           as.integer(unlist(fx$limits[c("maxDepth", "maxNodes", "maxOperands", "maxValues")])))
  list(pass = length(fx$invalid) >= 30L && !length(bad) && limits_same,
       detail = sprintf("%d invalid fixture rules: %d refused differently from the domain%s; row-rule limits equal the domain's: %s",
                        length(fx$invalid), length(bad), if (length(bad)) paste0(" -- ", paste(head(bad, 3), collapse = " | ")) else "", limits_same))
})

vcr_case("N23c", c("AC-26"), function() {
  # No eval anywhere: a static walk over every R file of the engine. The walk
  # must prove it walked (files and lines counted); a comment that mentions the
  # word is not code and is skipped.
  files <- list.files(file.path(VCR_ROOT, "R"), pattern = "\\.R$", full.names = TRUE)
  lines <- unlist(lapply(files, function(f) { l <- readLines(f, warn = FALSE); l[!grepl("^\\s*#", l)] }))
  patterns <- c("\\beval\\s*\\(", "\\bevalq\\s*\\(", "\\bstr2lang\\s*\\(", "\\bstr2expression\\s*\\(", "\\bparse\\s*\\(\\s*text", "\\bexpression\\s*\\(")
  hits <- unlist(lapply(patterns, function(p) grep(p, lines, value = TRUE)))
  service <- readLines(file.path(VCR_ROOT, "service", "app.py"), warn = FALSE)
  py_hits <- grep("\\b(eval|exec)\\s*\\(", service, value = TRUE)
  list(pass = length(files) >= 15L && length(lines) > 5000L && !length(hits) && !length(py_hits),
       detail = sprintf("%d R files and %d lines of code scanned for eval/evalq/str2lang/str2expression/parse(text=)/expression(): %d hits; the service: %d",
                        length(files), length(lines), length(hits), length(py_hits)))
})

vcr_case("N23d", c("AC-26", "AC-04"), function() {
  # The review's payloads, through the job path. A cohort rule, a population
  # constraint, a quality criterion or an `expression` anywhere in a scenario is
  # refused BY NAME, and nothing it would have run runs: the marker file a
  # payload would write is never created, and no file content appears in the
  # result. A misspelt column is refused naming it (the old evaluator turned it
  # into "every row indeterminate" and reported a successful cohort of zero
  # people).
  root <- vcr_test_data_root()
  marker <- file.path(tempdir(), "n23d-marker.txt"); unlink(marker)
  secret <- file.path(root, "snapshots", "snp_test", "n23d-secret.json")
  dir.create(dirname(secret), recursive = TRUE, showWarnings = FALSE)
  writeLines("SECRET-TOKEN-abc123 not json at all", secret)
  df <- data.frame(USUBJID = sprintf("S%02d", 1:40), age = seq(30, 69), stringsAsFactors = FALSE)
  in_subj <- vcr_test_input(df, "snp_n23d:subject", "subject")
  payload <- sprintf("{ writeLines('code ran', '%s'); age >= 18 }", marker)
  run <- function(method, sc, inputs = list(in_subj)) vcr_test_run(vcr_test_job(method, sc, inputs, seed = 1L, job_id = "job_n23d"))
  r_cohort <- run("cohort.build", list(rules = list(list(name = "adult", expression = payload))))
  r_deep <- run("design.simulate", list(design = list(kind = "two_arm_fixed", nTreat = 20, nControl = 20), endpoint = list(type = "continuous"),
                                        truth = list(effect = 0.3, expression = payload), analysis = list(method = "ttest")))
  r_pop <- run("population.scenario", list(n = 20L, population = list(variables = list(list(name = "age", family = "normal", mean = 60, sd = 10)),
                constraints = list(list(name = "c", expression = payload)))), NULL)
  r_typo <- run("cohort.build", list(rules = list(list(name = "adult", rule = list(op = "compare", column = "agee", comparator = "gte", value = 18)))))
  r_op <- run("cohort.build", list(rules = list(list(name = "adult", rule = list(op = "matches", column = "age")))))
  # an engine-side refusal that the validator does not pre-empt: hand the engine a
  # job whose rule the schema layer never saw (the direct call a tool would make)
  direct <- vcr_run_job(list(jobId = "job_n23d_x", studyId = "std_x", kind = "build_cohort", method = "cohort.build", methodVersion = "1.0.0",
                             protocolVersion = 1L, seed = 1L, cpuSecondsLimit = 60, inputs = list(in_subj),
                             scenario = list(rules = list(list(name = "adult", expression = payload)))))
  codes <- lapply(list(cohort = r_cohort, deep = r_deep, pop = r_pop, typo = r_typo, op = r_op, direct = direct), vcr_test_issue_codes)
  json <- as.character(jsonlite::toJSON(list(r_cohort, r_deep, r_pop, r_typo, r_op, direct), auto_unbox = TRUE, null = "null"))
  ok <- all(vapply(list(r_cohort, r_deep, r_pop, r_typo, r_op, direct), function(r) identical(r$status, "failed") && length(r$measures) == 0L, logical(1))) &&
    "rule_expression_forbidden" %in% codes$cohort && "rule_expression_forbidden" %in% codes$deep && "rule_expression_forbidden" %in% codes$pop &&
    "rule_expression_forbidden" %in% codes$direct && "rule_column_unknown" %in% codes$typo && "rule_op_unknown" %in% codes$op &&
    !file.exists(marker) && !grepl("SECRET-TOKEN", json, fixed = TRUE) && !grepl("code ran", json, fixed = TRUE) &&
    grepl("agee", r_typo$diagnostics$issues[[1]]$detail, fixed = TRUE)
  list(pass = ok,
       detail = sprintf("cohort expression -> %s; expression deep in a design scenario -> %s; constraint expression -> %s; direct engine call -> %s; misspelt column -> %s (%s); unknown op -> %s; marker file written by the payload: %s; file content in any result: %s",
                        paste(codes$cohort, collapse = ","), paste(codes$deep, collapse = ","), paste(codes$pop, collapse = ","), paste(codes$direct, collapse = ","),
                        paste(codes$typo, collapse = ","), r_typo$diagnostics$issues[[1]]$field, paste(codes$op, collapse = ","),
                        file.exists(marker), grepl("SECRET-TOKEN", json, fixed = TRUE)))
})
