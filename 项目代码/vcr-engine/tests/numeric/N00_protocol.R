# N00 — the engine's protocol mirror agrees with @evimed/domain.
#
# This is the case that makes every other case meaningful: the numbers below
# are only the right numbers if the engine is answering the job the control
# plane thinks it queued. `R/protocol.R` is a second implementation of what
# `packages/domain/src/vcrEngineJob.mjs` and `vcrRules.mjs` decide, written in
# another language because the container has no Node; a second implementation
# is true only while a test says so, and these are the tests. Each asks the
# domain (through `tests/helpers/*.mjs`) and the engine the same question about
# the same files and compares the whole answer.

.n00_domain_dir <- function() file.path(VCR_ROOT, "..", "..", "OpenScience", "packages", "domain")
.n00_have_domain <- function() nzchar(Sys.which("node")) && dir.exists(file.path(.n00_domain_dir(), "src"))
.n00_skip <- function(what) list(pass = TRUE, detail = sprintf("skipped: %s (the container has no Node and no domain source by design)", what))
.n00_helper <- function(name) shQuote(file.path(VCR_ROOT, "tests", "helpers", name))
.n00_node <- function(script, args = character(0)) {
  out <- suppressWarnings(system2("node", c(.n00_helper(script), vapply(args, shQuote, character(1))), stdout = TRUE, stderr = FALSE))
  jsonlite::parse_json(paste(out, collapse = "\n"), simplifyVector = FALSE)
}
.n00_fixture <- function(name) {
  jsonlite::parse_json(paste(readLines(file.path(.n00_domain_dir(), "test", "fixtures", name), warn = FALSE, encoding = "UTF-8"), collapse = "\n"),
                       simplifyVector = FALSE)
}
.n00_issue_keys <- function(issues) sort(vapply(issues, function(x) paste0(x$code, "@", x$field), character(1)))

vcr_case("N00a", c("AC-04"), function() {
  # The generated snapshot must still equal what the live domain exports.
  gen <- file.path(VCR_ROOT, "tests", "helpers", "emit-domain-snapshot.mjs")
  if (!nzchar(Sys.which("node"))) return(.n00_skip("node not on PATH"))
  tmp <- tempfile(fileext = ".json")
  system2("node", c(shQuote(gen), shQuote(tmp)), stdout = NULL, stderr = NULL)
  same <- identical(readLines(tmp, warn = FALSE), readLines(file.path(VCR_ROOT, "R", "domain-snapshot.json"), warn = FALSE))
  unlink(tmp)
  list(pass = same, detail = sprintf("R/domain-snapshot.json %s the live @evimed/domain exports",
                                     if (same) "equals" else "DIFFERS FROM"))
})

vcr_case("N00b", c("AC-04", "AC-30"), function() {
  # Every declared method has a handler and no handler is undeclared.
  issues <- vcr_engine_self_check()
  d <- vcr_domain()
  list(pass = length(issues) == 0L,
       detail = sprintf("%d/%d domain methods implemented, %d issues",
                        length(intersect(names(vcr_engine_handlers()), names(d$methods))),
                        length(d$methods), length(issues)))
})

vcr_case("N00c", c("AC-04"), function() {
  # Canonical JSON: R must produce the bytes JavaScript's canonicalScenarioJson
  # does, or the scenario hash means two different things on the two sides. The
  # corpus is the shapes that broke the first R writer: one-element arrays,
  # empty objects and arrays, null, integer-like keys (which V8 orders before
  # every other key), escapes, astral characters (two UTF-16 units, so they sort
  # before U+FF61), and numbers at every switch of ECMAScript's formatting.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  file <- file.path(VCR_ROOT, "tests", "helpers", "canonical-cases.json")
  cases <- jsonlite::fromJSON(file, simplifyVector = TRUE)
  js <- .n00_node("emit-protocol-probes.mjs", c("canonical", file))
  got <- vapply(cases, function(text) vcr_canonical_json(vcr_parse_json(text)), character(1), USE.NAMES = FALSE)
  want <- vapply(js, function(x) x$canonical, character(1))
  same <- identical(got, want)
  hashes <- identical(vapply(got, vcr_sha256, character(1), USE.NAMES = FALSE), vapply(js, function(x) x$sha256, character(1)))
  # R values built in R (not parsed) must hash like their JSON twins.
  native <- list(
    list(list(b = 2, a = 1), '{"a":1,"b":2}'),
    list(list(a = 0.1, b = 1e-7, c = 1e21), '{"a":0.1,"b":1e-7,"c":1e+21}'),
    list(list(x = list(2, 1), y = "中"), '{"x":[2,1],"y":"中"}'),
    list(list(k = NULL, j = TRUE), '{"j":true,"k":null}'),
    list(list(n = 0.30000000000000004), '{"n":0.30000000000000004}'),
    list(list(n = 0.3-0.1), '{"n":0.19999999999999998}'),
    list(list(n = 1.8568 + .Machine$double.eps), '{"n":1.8568000000000002}'),
    list(list(m = matrix(c(1, 0.2, 0.2, 1), 2)), '{"m":[[1,0.2],[0.2,1]]}'),
    list(list(e = vcr_empty_object(), a = list()), '{"a":[],"e":{}}'))
  nat <- vapply(native, function(p_) vcr_canonical_json(p_[[1]]), character(1))
  nat_ok <- identical(nat, vapply(native, function(p_) p_[[2]], character(1)))
  list(pass = same && hashes && nat_ok,
       detail = sprintf("%d/%d parsed documents canonicalize and hash like JS; %d/%d native R values as JSON.stringify writes them",
                        sum(got == want), length(cases), sum(nat == vapply(native, function(p_) p_[[2]], character(1))), length(native)))
})

vcr_case("N00d", c("AC-04"), function() {
  # The id, hash and location patterns are read from the snapshot, but R matches
  # them with PCRE and JavaScript with its own engine, so the two are probed on
  # the edges the patterns were written to have: the length limits, `@version`
  # (and `@0`, and a leading zero), a trailing newline (where PCRE's `$` and
  # JavaScript's part company), non-ASCII, and a location's `..` and hidden and
  # empty segments.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  js <- .n00_node("emit-protocol-probes.mjs", "patterns")
  probes <- vapply(js$probes, identity, character(1))
  raw <- vcr_domain_raw()
  bad <- character(0)
  for (name in names(raw$patterns)) {
    r <- vapply(probes, function(x) vcr_pattern_match(raw$patterns[[name]], x), logical(1), USE.NAMES = FALSE)
    j <- vapply(js$verdicts[[name]], identity, logical(1))
    if (!identical(r, j)) bad <- c(bad, sprintf("%s(%s)", name, paste(shQuote(probes[r != j]), collapse = ",")))
  }
  loc_probes <- c(probes, "a/b", "a//b", "a/b/", "/a", "a/../b", "a/./b", "std_1/snp_1/x.csv")
  r <- vapply(loc_probes, .vcrp_location_valid, logical(1), USE.NAMES = FALSE)
  j <- vapply(js$verdicts$location, identity, logical(1))
  if (!identical(r, j)) bad <- c(bad, sprintf("location(%s)", paste(shQuote(loc_probes[r != j]), collapse = ",")))
  list(pass = !length(bad),
       detail = sprintf("%d patterns + location over %d probe strings: %s", length(raw$patterns), length(loc_probes),
                        if (!length(bad)) "identical verdicts" else paste("DRIFT", paste(bad, collapse = "; "))))
})

vcr_case("N00e", c("AC-28", "AC-04"), function() {
  # The two sides of the protocol must plan the same number of replicates.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  probes <- list(list("proportion", 0.001, 0.025, 1), list("proportion", 0.005, 0.95, 1),
                 list("mean", 0.005, 0.5, 0.2), list("proportion", 0.0007, 0.31, 1),
                 list("mean", 0.001, 0.5, 1), list("proportion", 0.01, 0.5, 1),
                 list("mean", 0.002, 0.5, 2))
  args <- paste(vapply(probes, function(p_) sprintf(
    "m.replicatesForMcse({measure:'%s',target:%s,p:%s,sd:%s})", p_[[1]], format(p_[[2]], scientific = FALSE),
    format(p_[[3]], scientific = FALSE), format(p_[[4]], scientific = FALSE)), character(1)), collapse = ",")
  script <- sprintf("import('%s').then(m=>{console.log([%s].join(','))})",
                    normalizePath(file.path(.n00_domain_dir(), "src", "vcrEngineJob.mjs")), args)
  out <- suppressWarnings(system2("node", c("--input-type=module", "-e", shQuote(script)), stdout = TRUE, stderr = FALSE))
  js <- as.numeric(strsplit(paste(out, collapse = ""), ",")[[1]])
  r <- vapply(probes, function(p_) vcr_replicates_for_mcse(p_[[1]], p_[[2]], p = p_[[3]], sd = p_[[4]]), numeric(1))
  # And the floor, which under the null asks its precision of alpha, not of 0.5
  # (20,000 replicates is what alpha = 0.025 needs for a standard error of 0.0011).
  fl <- .n00_node("emit-protocol-probes.mjs", "replicates")
  floors <- vapply(fl$rows, function(row) {
    target <- if (is.null(row[[2]])) NULL else row[[2]]
    as.numeric(vcr_replicate_floor(row[[1]], target, alpha = row[[3]]))
  }, numeric(1))
  jsf <- vapply(fl$floors, identity, numeric(1))
  same <- length(js) == length(r) && all(js == r) && identical(floors, jsf)
  list(pass = same,
       detail = if (same) sprintf("domain and engine agree on %d targets (%s) and %d floors (%s)", length(r),
                                  paste(r[1:3], collapse = "/"), length(floors), paste(floors[1:4], collapse = "/"))
                else sprintf("DRIFT: targets domain %s vs engine %s; floors domain %s vs engine %s",
                             paste(js, collapse = "/"), paste(r, collapse = "/"), paste(jsf, collapse = "/"), paste(floors, collapse = "/")))
})

vcr_case("N00f", c("AC-04", "AC-13"), function() {
  # Job validation parity: every job of the domain's fixture, valid and invalid,
  # through `validateEngineJob` (JS) and `vcr_validate_job` (R). The whole
  # verdict, sorted, must be equal -- the scenario schemas, the design table, the
  # kind/method pairing, the input rules, the row rules inside a scenario. Then
  # the fixture is held to its own account: valid jobs are clean, and every issue
  # an invalid job names is in the verdict.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  fx <- .n00_fixture("vcr-engine-jobs.json")
  js <- .n00_node("emit-job-verdicts.mjs")
  items <- c(fx$valid, fx$invalid)
  drift <- character(0)
  for (i in seq_along(items)) {
    got <- as.character(.n00_issue_keys(vcr_validate_job(items[[i]]$job)))
    want <- as.character(sort(unlist(js$jobs[[i]]$issues)))
    if (!identical(got, want)) drift <- c(drift, sprintf("%s: R [%s] vs JS [%s]", items[[i]]$name, paste(got, collapse = " "), paste(want, collapse = " ")))
  }
  unclean <- Filter(function(item) length(vcr_validate_job(item$job)) > 0L, fx$valid)
  missed <- 0L
  for (item in fx$invalid) {
    got <- .n00_issue_keys(vcr_validate_job(item$job))
    missed <- missed + sum(!(unlist(item$expected) %in% got))
  }
  ok <- !length(drift) && !length(unclean) && missed == 0L && length(items) >= 150L
  list(pass = ok,
       detail = sprintf("%d jobs (%d valid, %d invalid): %d verdicts differ from the domain's, %d valid jobs refused, %d expected issues missing%s",
                        length(items), length(fx$valid), length(fx$invalid), length(drift), length(unclean), missed,
                        if (length(drift)) paste0("; first: ", drift[1]) else ""))
})

vcr_case("N00g", c("AC-04", "AC-28"), function() {
  # Result validation parity, on the same terms: the engine runs
  # `vcr_validate_result` on its own output before it answers.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  fx <- .n00_fixture("vcr-engine-jobs.json")
  js <- .n00_node("emit-job-verdicts.mjs")
  items <- c(fx$validResults, fx$invalidResults)
  drift <- character(0)
  for (i in seq_along(items)) {
    got <- as.character(.n00_issue_keys(vcr_validate_result(items[[i]]$result)))
    want <- as.character(sort(unlist(js$results[[i]]$issues)))
    if (!identical(got, want)) drift <- c(drift, sprintf("%s: R [%s] vs JS [%s]", items[[i]]$name, paste(got, collapse = " "), paste(want, collapse = " ")))
  }
  unclean <- Filter(function(item) length(vcr_validate_result(item$result)) > 0L, fx$validResults)
  missed <- 0L
  for (item in fx$invalidResults) missed <- missed + sum(!(unlist(item$expected) %in% .n00_issue_keys(vcr_validate_result(item$result))))
  list(pass = !length(drift) && !length(unclean) && missed == 0L && length(items) >= 40L,
       detail = sprintf("%d results: %d verdicts differ from the domain's, %d valid results refused, %d expected issues missing%s",
                        length(items), length(drift), length(unclean), missed, if (length(drift)) paste0("; first: ", drift[1]) else ""))
})

vcr_case("N00h", c("AC-04"), function() {
  # The scenario hash through the actual file path: a job written to disk, read by
  # `vcr_read_job` (which is what `run_job.R` calls), hashed here, and hashed by the
  # domain from the same bytes. The scenario is the awkward kind -- a one-element
  # array, `{}`, `null`, integer-like keys, escapes, a very small and a very large
  # number -- because a hash that only agrees on tidy input is not an identity.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  path <- tempfile(fileext = ".json")
  on.exit(unlink(path), add = TRUE)
  writeLines(paste0('{"jobId":"job_1","scenario":{"byTimes":[10],"cov":["age"],"a":{},"b":[],"c":null,"9":1,"10":2,"s":"q\\" \\\\ \\n \\u0001 \\u4e2d \\ud83d\\ude00",',
                    '"n":[1e-7,1e21,0.30000000000000004,123456789012345680000,-0,5e-324],"nested":{"x":[[1],[],{}]},"followup":1e999}}'),
             path, useBytes = TRUE)
  js <- .n00_node("emit-protocol-probes.mjs", c("scenario-hash", path))
  job <- vcr_read_job(path)
  got <- vcr_scenario_hash(job[["scenario"]])
  list(pass = identical(got, js$sha256),
       detail = sprintf("scenario hash %s read from a file (R %s, domain %s)", if (identical(got, js$sha256)) "agrees" else "DIFFERS",
                        substr(got, 1, 12), substr(js$sha256, 1, 12)))
})

vcr_case("N00i", c("AC-04"), function() {
  # The output hash: `manifest.outputHash` is the sha256 of the canonical JSON of
  # `{ measures, counts, conclusion, notEstimableRule, tables: [{ name, sha256 }] }`.
  # R computes it from a result it holds in memory; the control plane recomputes
  # it from `result.json`. They agree only if the file carries the doubles the run
  # held -- which is why the file is written with seventeen digits -- so this case
  # builds a result out of awkward doubles, writes it the way `run_job.R` does,
  # and has the domain hash the file.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  h <- strrep("b", 64)
  result <- list(
    jobId = "job_1", status = "succeeded", conclusion = "limited", notEstimableRule = NULL,
    counts = vcr_counts(realPatients = 120, events = NULL, effectiveSampleSize = 96.5, generatedRecords = 0),
    measures = list(
      vcr_measure("power", 0.1 + 0.2, simulated = TRUE, mcse = 1 / 3, source = "calculated",
                  interval = vcr_interval("monte_carlo", 1e-7, 1e21)),
      vcr_measure("rate", 2 / 3, source = "calculated", unit = "per month"),
      vcr_measure("big", 123456789.123456789, source = "observed")),
    tables = list(list(name = "replicates", location = "replicates.csv", sha256 = h, rows = 5000L)),
    manifest = list(outputHash = "x"))
  path <- tempfile(fileext = ".json")
  on.exit(unlink(path), add = TRUE)
  writeLines(vcr_result_json(result), path)
  js <- .n00_node("emit-protocol-probes.mjs", c("output-hash", path))
  got <- vcr_output_hash(result)
  # A parsed fixture result must hash the same as the JS twin, too.
  fx <- .n00_fixture("vcr-engine-jobs.json")
  more <- 0L; agree <- 0L
  for (item in fx$validResults) {
    p2 <- tempfile(fileext = ".json"); writeLines(vcr_result_json(item$result), p2)
    j2 <- .n00_node("emit-protocol-probes.mjs", c("output-hash", p2))
    unlink(p2)
    more <- more + 1L
    if (identical(vcr_output_hash(item$result), j2$sha256)) agree <- agree + 1L
  }
  list(pass = identical(got, js$sha256) && agree == more,
       detail = sprintf("output hash of an in-memory result agrees with the domain's from its file (%s vs %s); %d/%d fixture results agree",
                        substr(got, 1, 12), substr(js$sha256, 1, 12), agree, more))
})

vcr_case("N00j", c("AC-04", "AC-13"), function() {
  # Row-rule VALIDATION parity on the domain's fixture: `vcr_validate_row_rule`
  # must refuse every invalid rule with exactly the one issue the fixture names
  # (code and path, the path relative to the rule's root), and accept every valid
  # one against its table. Evaluation parity is N23's; this is the grammar's
  # validation, which is what stands between a scenario and code execution.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  fx <- .n00_fixture("vcr-row-rules.json")
  wrong <- character(0)
  for (item in fx$valid) {
    got <- vcr_validate_row_rule(item$rule, columns = unlist(item$columns))
    if (length(got)) wrong <- c(wrong, sprintf("valid '%s' refused: %s@%s", item$name, got[[1]]$code, got[[1]]$field))
  }
  for (item in fx$invalid) {
    got <- vcr_validate_row_rule(item$rule, columns = unlist(item$columns))
    key <- if (length(got) == 1L) paste0(got[[1]]$code, "@", got[[1]]$field) else sprintf("%d issues", length(got))
    if (!identical(key, paste0(item$issue, "@", item$path))) wrong <- c(wrong, sprintf("invalid '%s': got %s, want %s@%s", item$name, key, item$issue, item$path))
  }
  list(pass = !length(wrong) && length(fx$valid) >= 40L && length(fx$invalid) >= 15L,
       detail = sprintf("%d valid and %d invalid rules: %d disagree with the fixture%s", length(fx$valid), length(fx$invalid), length(wrong),
                        if (length(wrong)) paste0("; first: ", wrong[1]) else ""))
})

vcr_case("N00k", c("AC-28"), function() {
  # The null predicate is one predicate: the replicate floor, the measure's name
  # and the report all read it, so R and JavaScript must draw the line in the
  # same place, including the tolerance (1e-13 is null, 1e-9 is not) and an
  # explicit `truth.null`. Two R functions answer to it: `.vcrp_is_null_scenario`
  # (protocol.R's own mirror, which the validator's replicate floor uses) and
  # `vcr_is_null_scenario` (the name the handlers call, which a handler file may
  # redefine). The first is held to the domain on every probe; the second on the
  # standard probes, with any disagreement on the edge probes named.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  scenarios <- .n00_node("emit-protocol-probes.mjs", "null-scenarios")
  js <- vapply(.n00_node("emit-protocol-probes.mjs", "null"), identity, logical(1))
  mine <- vapply(scenarios, .vcrp_is_null_scenario, logical(1))
  public <- vapply(scenarios, vcr_is_null_scenario, logical(1))
  standard <- seq_len(23L)
  edge_differs <- which(public != js & !(seq_along(js) %in% standard))
  # And the presets the engine reads instead of scenario keys.
  lim <- vcr_domain()$limits
  presets <- all(c("essFloor", "supportCeiling", "conflictBound", "tolerance", "bootstrapMin", "smdFloor") %in% names(lim)) &&
    is.numeric(lim$essFloor) && lim$supportCeiling > 0 && lim$conflictBound > 0 && lim$bootstrapMin >= 2000
  list(pass = identical(mine, js) && identical(public[standard], js[standard]) && presets,
       detail = sprintf("%d/%d scenarios classified as the domain does (%d/%d by the handlers' name%s); thresholds (essFloor %s, supportCeiling %s, conflictBound %s) come from the snapshot",
                        sum(mine == js), length(js), sum(public == js), length(js),
                        if (length(edge_differs)) sprintf(", DIFFERING on edge probes %s -- delete the second definition of vcr_is_null_scenario", paste(edge_differs, collapse = ",")) else "",
                        format(lim$essFloor), format(lim$supportCeiling), format(lim$conflictBound)))
})

vcr_case("N00l", c("AC-04", "AC-31"), function() {
  # One job through the real entry point, `service/run_job.R`, as the service runs
  # it: a file in, a `result.json` out. The domain then holds the file to its own
  # account -- it validates under `validateEngineResult`, the scenario hash the
  # engine wrote is the hash of the canonical scenario the domain computes from
  # the job file, and `manifest.outputHash` is what the domain recomputes from the
  # file. Every earlier case checks one function against its twin; this is the
  # only one that checks the seam the control plane actually reads.
  if (!.n00_have_domain()) return(.n00_skip("node or the domain source is not here"))
  dir <- tempfile("n00l"); dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  job_path <- file.path(dir, "job.json")
  writeLines(paste0('{"jobId":"job_n00l","studyId":"std_1","kind":"design_analytic","method":"design.analytic","methodVersion":"1.0.0",',
                    '"protocolVersion":1,"seed":1,"cpuSecondsLimit":60,"inputs":[],"scenario":{"design":{"kind":"two_arm_fixed"},',
                    '"endpoint":{"type":"time_to_event"},"truth":{"hazardRatio":0.7,"controlMedian":12},"analysis":{"alpha":0.025,"power":0.9}}}'),
             job_path)
  out_dir <- file.path(dir, "out")
  rscript <- file.path(R.home("bin"), "Rscript")
  # `run_job.R` puts VCR_R_LIBS (one directory) in front of the library path; the
  # harness has already put the engine's library first.
  env <- c(paste0("VCR_ENGINE_ROOT=", VCR_ROOT), paste0("VCR_R_LIBS=", .libPaths()[1]))
  status <- suppressWarnings(system2(rscript, c(shQuote(file.path(VCR_ROOT, "service", "run_job.R")), shQuote(job_path), shQuote(out_dir)),
                                     stdout = FALSE, stderr = FALSE, env = env))
  result_path <- file.path(out_dir, "result.json")
  if (!file.exists(result_path)) return(list(pass = FALSE, detail = sprintf("run_job.R wrote no result.json (exit %s)", format(status))))
  js <- .n00_node("emit-protocol-probes.mjs", c("result", result_path))
  scenario_js <- .n00_node("emit-protocol-probes.mjs", c("scenario-hash", job_path))
  result <- vcr_parse_json(paste(readLines(result_path, warn = FALSE, encoding = "UTF-8"), collapse = "\n"))
  clean <- length(js$issues) == 0L
  hash_ok <- identical(result$scenarioHash, scenario_js$sha256)
  out_ok <- identical(result$manifest$outputHash, js$outputHash)
  list(pass = clean && hash_ok && out_ok && identical(result$status, "succeeded"),
       detail = sprintf("status %s; domain verdict %s; scenario hash %s; output hash %s",
                        result$status, if (clean) "clean" else paste(unlist(js$issues), collapse = " "),
                        if (hash_ok) "agrees" else "DIFFERS", if (out_ok) "agrees" else "DIFFERS"))
})
