# N24 - N25 — the engine's data-plane discipline: what it will open, what it
# says about what it opened, and how it counts small cells and cohorts.

.n24_refusal <- function(input) {
  tryCatch({ vcr_read_table_input(input); "read" }, vcr_refusal = function(e) e$issue$code)
}

vcr_case("N24a", c("AC-26", "AC-04"), function() {
  # The reader opens one kind of path: a location relative to the data root, under
  # a sha256, read once and parsed from those same bytes. Each way around that is
  # refused by a fixed code (called directly, so the job validator does not
  # pre-empt the engine's own guard): an absolute path, `..`, a symbolic link at
  # any level (inside the root or out of it), a directory, a location without a
  # hash, a wrong hash, a format it does not read, a file larger than the cap and
  # a table that does not parse. The one good case proves the harness would say
  # "read" if it read.
  root <- vcr_test_data_root()
  df <- data.frame(USUBJID = sprintf("S%02d", 1:20), age = 41:60, stringsAsFactors = FALSE)
  good <- vcr_test_input(df, "snp_n24a:subject", "subject")
  outside <- tempfile("outside-"); dir.create(outside)
  writeLines(c("USUBJID,age", "OTHER-TENANT,99"), file.path(outside, "other.csv"))
  dir.create(file.path(root, "links"), showWarnings = FALSE)
  file.symlink(file.path(outside, "other.csv"), file.path(root, "links", "file-link.csv"))
  file.symlink(outside, file.path(root, "links", "dir-link"))
  file.symlink(file.path(root, good$location), file.path(root, "links", "inner-link.csv"))
  bytes <- readBin(file.path(outside, "other.csv"), "raw", 1000)
  h_out <- digest::digest(bytes, algo = "sha256", serialize = FALSE)
  with_loc <- function(loc, hash = good$hash) utils::modifyList(good, list(location = loc, hash = hash))
  no_hash <- good; no_hash$hash <- NULL
  xlsx <- file.path(root, "snapshots", "snp_test", "n24a.xlsx"); writeBin(as.raw(1:20), xlsx)
  bad_json <- file.path(root, "snapshots", "snp_test", "n24a-bad.json"); writeLines("SECRET-TOKEN-xyz [not json", bad_json)
  bin_csv <- file.path(root, "snapshots", "snp_test", "n24a-binary.csv"); writeBin(as.raw(c(0x41, 0x00, 0x42, 0x0a, 0x01)), bin_csv)
  rel <- function(p) sub(paste0("^", root, "/"), "", p)
  got <- list(
    good = .n24_refusal(good),
    absolute = .n24_refusal(with_loc(file.path(root, good$location))),
    dotdot = .n24_refusal(with_loc("snapshots/../snapshots/snp_test/x.csv")),
    dotdot_out = .n24_refusal(with_loc("../etc/passwd")),
    file_symlink_out = .n24_refusal(with_loc("links/file-link.csv", h_out)),
    dir_symlink_out = .n24_refusal(with_loc("links/dir-link/other.csv", h_out)),
    file_symlink_in = .n24_refusal(with_loc("links/inner-link.csv")),
    directory = .n24_refusal(with_loc("snapshots")),
    missing = .n24_refusal(with_loc("snapshots/snp_test/none.csv")),
    no_hash = .n24_refusal(no_hash),
    wrong_hash = .n24_refusal(with_loc(good$location, strrep("a", 64))),
    format = .n24_refusal(with_loc(rel(xlsx), vcr_file_sha256(xlsx))),
    parse = .n24_refusal(with_loc(rel(bad_json), vcr_file_sha256(bad_json))),
    binary = .n24_refusal(with_loc(rel(bin_csv), vcr_file_sha256(bin_csv))))
  Sys.setenv(VCR_ENGINE_MAX_INPUT_BYTES = "20"); got$too_large <- .n24_refusal(good); Sys.unsetenv("VCR_ENGINE_MAX_INPUT_BYTES")
  saved <- Sys.getenv("VCR_ENGINE_DATA_ROOT"); Sys.setenv(VCR_ENGINE_DATA_ROOT = ""); got$no_root <- .n24_refusal(good); Sys.setenv(VCR_ENGINE_DATA_ROOT = saved)
  # no refusal message repeats what was in the file
  msg <- tryCatch(vcr_read_table_input(with_loc(rel(bad_json), vcr_file_sha256(bad_json))), vcr_refusal = function(e) e$issue$detail)
  want <- c(good = "read", absolute = "input_location_invalid", dotdot = "input_location_invalid", dotdot_out = "input_location_invalid",
            file_symlink_out = "input_location_invalid", dir_symlink_out = "input_location_invalid", file_symlink_in = "input_location_invalid",
            directory = "input_location_invalid", missing = "input_location_invalid", no_hash = "input_hash_missing", wrong_hash = "input_hash_mismatch",
            format = "input_format_unsupported", parse = "input_parse_failed", binary = "input_parse_failed", too_large = "input_too_large", no_root = "input_location_invalid")
  same <- vapply(names(want), function(k) identical(got[[k]], want[[k]]), logical(1))
  ok <- all(same) && !grepl("SECRET-TOKEN", msg, fixed = TRUE)
  unlink(c(file.path(root, "links"), outside), recursive = TRUE)
  list(pass = ok,
       detail = sprintf("%s; refusal message for a malformed file repeats none of it: %s",
                        paste(sprintf("%s=%s", names(want), unlist(got[names(want)])), collapse = " "), !grepl("SECRET-TOKEN", msg, fixed = TRUE)))
})

vcr_case("N24b", c("AC-26", "AC-08"), function() {
  # The same discipline through a job: a symbolic link planted inside the data
  # root that points at another tenant's file is refused, and nothing of that
  # file (or of a file that does not parse) reaches the result.
  root <- vcr_test_data_root()
  outside <- tempfile("tenant-"); dir.create(outside)
  writeLines(c("USUBJID,age,arm", "OTHER-TENANT-77,50,1", "OTHER-TENANT-78,51,0"), file.path(outside, "other.csv"))
  hash <- vcr_file_sha256(file.path(outside, "other.csv"))
  dir.create(file.path(root, "links"), showWarnings = FALSE)
  file.symlink(file.path(outside, "other.csv"), file.path(root, "links", "n24b.csv"))
  input <- list(id = "snp_n24b:subject", kind = "analysis_table", shape = vcr_test_shape("subject"), location = "links/n24b.csv", hash = hash, valueSource = "observed")
  r <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(input), job_id = "job_n24b"))
  bad_json <- file.path(root, "snapshots", "snp_test", "n24b-bad.json"); dir.create(dirname(bad_json), recursive = TRUE, showWarnings = FALSE)
  writeLines("SECRET-TOKEN-qrs not a table", bad_json)
  in_bad <- list(id = "snp_n24b:1", kind = "snapshot_file", location = "snapshots/snp_test/n24b-bad.json", hash = vcr_file_sha256(bad_json), valueSource = "observed")
  r2 <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(in_bad), job_id = "job_n24b_2"))
  json <- as.character(jsonlite::toJSON(list(r, r2), auto_unbox = TRUE, null = "null"))
  ok <- identical(r$status, "failed") && "input_location_invalid" %in% vcr_test_issue_codes(r) && identical(r2$status, "failed") &&
    "input_parse_failed" %in% vcr_test_issue_codes(r2) && !grepl("OTHER-TENANT", json, fixed = TRUE) && !grepl("SECRET-TOKEN", json, fixed = TRUE) &&
    length(r$measures) == 0L && length(r2$measures) == 0L
  unlink(c(file.path(root, "links"), outside), recursive = TRUE)
  list(pass = ok,
       detail = sprintf("a planted symlink to another tenant's file -> %s (%s); a file that does not parse -> %s; content of either file in any result: %s",
                        r$status, paste(vcr_test_issue_codes(r), collapse = ","), paste(vcr_test_issue_codes(r2), collapse = ","),
                        grepl("OTHER-TENANT|SECRET-TOKEN", json)))
})

vcr_case("N24c", c("AC-26", "AC-12"), function() {
  # The three analysis-table shapes, read by their ADaM names. An event table
  # with two parameters (OS and PFS) must be told which one (`parameterCode`); it
  # is refused without, and with it each parameter's RMST equals survRM2's on
  # that parameter's own rows. A table that lacks the shape's required columns,
  # and a person in the subject table with no event row, are refused by name.
  suppressMessages(library(survRM2))
  set.seed(2424L, kind = VCR_RNG_KIND)
  n <- 300L
  d <- vcr_sim_tte(150L, 150L, vcr_dist_exponential_from_median(10), 0.7, list(kind = "uniform", duration = 10), 20)
  pfs <- pmin(d$time, stats::rexp(n, 1 / 9)); pfs_status <- as.integer(pfs == d$time & d$status == 1L)
  subj <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), arm = d$arm)
  ev <- rbind(data.frame(USUBJID = subj$USUBJID, PARAMCD = "OS", AVAL = d$time, CNSR = 1L - d$status),
              data.frame(USUBJID = subj$USUBJID, PARAMCD = "PFS", AVAL = pfs, CNSR = 1L - pfs_status))
  in_s <- vcr_test_input(subj, "snp_n24c:subject", "subject"); in_e <- vcr_test_input(ev, "snp_n24c:event", "event")
  run <- function(sc, inputs) vcr_test_run(vcr_test_job("comparator.rmst", sc, inputs, job_id = "job_n24c"))
  base <- list(tau = 12, treatmentColumn = "arm")
  none <- run(base, list(in_s, in_e))
  os <- run(c(base, list(parameterCode = "OS")), list(in_s, in_e)); pf <- run(c(base, list(parameterCode = "PFS")), list(in_s, in_e))
  ref <- function(time, status) survRM2::rmst2(time, status, d$arm, tau = 12)$unadjusted.result[1, "Est."]
  ok_os <- abs(vcr_measure_value(os, "rmst_difference") - ref(d$time, d$status)) < 1e-9
  ok_pf <- abs(vcr_measure_value(pf, "rmst_difference") - ref(pfs, pfs_status)) < 1e-9
  no_cnsr <- vcr_test_input(ev[, c("USUBJID", "PARAMCD", "AVAL")], "snp_n24c:nocnsr", "event")
  short <- vcr_test_input(ev[ev$PARAMCD == "OS" & seq_len(nrow(ev)) > 5, ], "snp_n24c:short", "event")
  r_no <- run(c(base, list(parameterCode = "OS")), list(in_s, no_cnsr)); r_short <- run(c(base, list(parameterCode = "OS")), list(in_s, short))
  bad_cnsr <- ev; bad_cnsr$CNSR[1] <- 2L
  r_cnsr <- run(c(base, list(parameterCode = "OS")), list(in_s, vcr_test_input(bad_cnsr, "snp_n24c:badcnsr", "event")))
  ok <- identical(none$status, "failed") && "input_shape_invalid" %in% vcr_test_issue_codes(none) && ok_os && ok_pf &&
    abs(vcr_measure_value(os, "rmst_difference") - vcr_measure_value(pf, "rmst_difference")) > 1e-3 &&
    identical(r_no$status, "failed") && "input_shape_invalid" %in% vcr_test_issue_codes(r_no) &&
    identical(r_short$status, "failed") && identical(r_cnsr$status, "failed")
  list(pass = ok,
       detail = sprintf("two parameters, none named -> %s; OS RMST difference %.6f vs survRM2 (ok %s), PFS %.6f (ok %s); no CNSR column -> %s; a person with no event row -> %s; CNSR = 2 -> %s",
                        paste(vcr_test_issue_codes(none), collapse = ","), vcr_measure_value(os, "rmst_difference"), ok_os, vcr_measure_value(pf, "rmst_difference"), ok_pf,
                        paste(vcr_test_issue_codes(r_no), collapse = ","), paste(vcr_test_issue_codes(r_short), collapse = ","), paste(vcr_test_issue_codes(r_cnsr), collapse = ",")))
})

vcr_case("N25a", c("AC-26", "AC-09"), function() {
  # Small cells in `profile.snapshot`. The rule (integration contract 4; build
  # ruling 9.1): a cell below 10 (and 0) is never shown alone; small cells are
  # absorbed, with the next-smallest, into one bucket of at least 10 people and
  # at least two cells, so no hidden cell can be got by subtracting the shown
  # ones from a total; if no such bucket exists the column's cells are withheld;
  # a count of people below 10 is not shown, and neither is its complement. The
  # first version printed `suppressedCount` (the hidden cell EXACTLY), the exact
  # missing count and the 5th/95th percentiles of a 20-row column.
  set.seed(2525L, kind = VCR_RNG_KIND)
  n <- 100L
  df <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)),
                   site = c(rep("A", 60), rep("B", 37), rep("C", 3)),
                   hiv = c(rep("neg", 98), rep("pos", 2)),
                   grade = c(rep("g1", 45), rep("g2", 30), rep("g3", 22), rep("g4", 3)),
                   ldh = c(stats::rnorm(96, 200, 30), rep(NA, 4)),
                   age = stats::rnorm(n, 60, 9), stringsAsFactors = FALSE)
  in_s <- vcr_test_input(df, "snp_n25a:subject", "subject")
  r <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(in_s), job_id = "job_n25a"))
  col <- function(nm) Filter(function(c_) identical(c_$column, nm), r$diagnostics$columns)[[1]]
  cells <- function(nm) vapply(col(nm)$cells, function(x) sprintf("%s=%g", x$level, x$n), character(1))
  json <- as.character(jsonlite::toJSON(r$diagnostics, auto_unbox = TRUE, null = "null", digits = NA))
  site <- col("site"); hiv <- col("hiv"); grade <- col("grade"); ldh <- col("ldh"); age <- col("age")
  # unit level: the absorbing rule on its own
  u <- function(counts) vcr_suppress_cells(table(rep(names(counts), counts)), 10)
  u_ok <- length(u(c(a = 60, b = 37, c = 3))$cells) == 2L && identical(u(c(a = 3, b = 4))$withheld, "small_cells") &&
    identical(u(c(a = 1))$withheld, "small_cells") && is.null(u(c(a = 30, b = 20))$withheld) && length(u(c(a = 30, b = 20))$cells) == 2L &&
    identical(u(setNames(rep(1, 60), sprintf("id%02d", 1:60)))$withheld, "high_cardinality")
  ok <- identical(r$status, "succeeded") &&
    # the single hidden cell C = 3 is absorbed with B: A shown, (other) = 40 over 2 cells, no 3 and no 37 anywhere
    setequal(cells("site"), c("A=60", "(other)=40")) && site$cells[[2]]$merged == 2L &&
    # 98/2: no bucket can meet the rule except both together
    identical(cells("hiv"), "(other)=100") &&
    # g1 45, g2 30, g3 22 shown; g4 (3) absorbed with g3 -> g1, g2, (other)=25
    setequal(cells("grade"), c("g1=45", "g2=30", "(other)=25")) &&
    is.null(ldh$missing) && is.null(ldh$missingRate) && "missing" %in% unlist(ldh$suppressed) && !("p05" %in% names(ldh)) && !("p95" %in% names(age)) &&
    !grepl("suppressedCount", json, fixed = TRUE) && !grepl("suppressedLevels", json, fixed = TRUE) &&
    !grepl('"n":3[,}]', json) && !grepl('"n":37[,}]', json) && !grepl('"n":2[,}]', json) && !grepl('"n":4[,}]', json) &&
    identical(vcr_measure_value(r, "rows"), 100) && r$counts$realPatients == 100 && u_ok
  # a 400-row column publishes its tails; a 6-row table publishes no row count
  big <- data.frame(USUBJID = sprintf("B%03d", 1:400), v = stats::rnorm(400), stringsAsFactors = FALSE)
  rb <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(vcr_test_input(big, "snp_n25a:big", "subject")), job_id = "job_n25a_b"))
  tiny <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(vcr_test_input(big[1:6, ], "snp_n25a:tiny", "subject")), job_id = "job_n25a_t"))
  vb <- Filter(function(c_) identical(c_$column, "v"), rb$diagnostics$columns)[[1]]
  ok2 <- !is.null(vb$p05) && !is.null(vb$p95) && is.null(vcr_get_measure(tiny, "rows")) && isTRUE(tiny$diagnostics$rowsSuppressed)
  list(pass = ok && ok2,
       detail = sprintf("site (A 60, B 37, C 3) -> %s; hiv (98/2) -> %s; grade (45/30/22/3) -> %s; a missing count of 4 is not shown (suppressed: %s) and neither is a 5th/95th percentile of 96 values; no suppressedCount in the result; 400 rows publish p05/p95: %s; a 6-row table publishes no row count: %s; absorbing rule unit checks: %s",
                        paste(cells("site"), collapse = "/"), paste(cells("hiv"), collapse = "/"), paste(cells("grade"), collapse = "/"),
                        paste(unlist(ldh$suppressed), collapse = ","), !is.null(vb$p05), is.null(vcr_get_measure(tiny, "rows")), u_ok))
})

vcr_case("N25b", c("AC-02", "AC-09", "AC-26"), function() {
  # The real cohort. (1) The waterfall equals an independent count, in order, with
  # "cannot tell" kept apart from "excluded" and each rule's `unknownAs` honoured;
  # (2) the impact of each rule alone (how many people it excludes by itself and
  # how many only it excludes) answers "which criterion costs the most people";
  # (3) time zero and exit are recorded and the member list is written with the
  # index and exit dates of the members; (4) an empty rule list is refused (it
  # would keep everyone and call it a cohort); (5) the SAME rules carried into a
  # downstream job change its estimate -- before, the rules filtered a
  # waterfall and nothing else -- and the downstream job reports the rules' hash,
  # equal to the cohort's.
  set.seed(2626L, kind = VCR_RNG_KIND)
  n <- 400L
  df <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), arm = rep(0:1, each = n / 2), age = stats::rnorm(n, 62, 10),
                   ecog = sample(c(0, 1, 2, NA), n, TRUE, c(0.4, 0.3, 0.2, 0.1)), rfstdt = as.character(as.Date("2020-01-01") + sample(0:200, n, TRUE)),
                   eosdt = NA_character_, stringsAsFactors = FALSE)
  df$eosdt <- as.character(as.Date(df$rfstdt) + sample(30:400, n, TRUE))
  df$age[sample(n, 15)] <- NA
  df$y <- 1 + 0.03 * df$age + 0.5 * df$arm + stats::rnorm(n)
  in_s <- vcr_test_input(df, "snp_n25b:subject", "subject")
  cmp <- function(col, cmp, v) list(op = "compare", column = col, comparator = cmp, value = v)
  rules <- list(list(name = "adult", rule = cmp("age", "gte", 50), unknownAs = "exclude"),
                list(name = "fit", rule = cmp("ecog", "lte", 1), unknownAs = "include"))
  dir <- tempfile("n25b"); dir.create(dir)
  r <- vcr_test_run(vcr_test_job("cohort.build", list(rules = rules, timeZero = list(column = "rfstdt"), exit = list(column = "eosdt")), list(in_s), job_id = "job_n25b"), output_dir = dir)
  # independent count
  a <- !is.na(df$age) & df$age >= 50                      # unknown age excluded at the first step
  a_unknown <- is.na(df$age)
  f_keep <- a & !is.na(df$ecog) & df$ecog <= 1; f_unknown <- a & is.na(df$ecog)
  alive <- f_keep | f_unknown                              # unknown ecog is included
  s1 <- r$diagnostics$waterfall[[1]]; s2 <- r$diagnostics$waterfall[[2]]
  ok_wf <- s1$kept == sum(a) && s1$excluded == sum(!a & !a_unknown) && s1$indeterminate == sum(a_unknown) &&
    s2$kept == sum(f_keep) && s2$indeterminate == sum(f_unknown) && vcr_measure_value(r, "cohort_size") == sum(alive)
  ok_sizes <- vcr_measure_value(r, "cohort_size_strict") == sum(!is.na(df$age) & df$age >= 50 & !is.na(df$ecog) & df$ecog <= 1) &&
    vcr_measure_value(r, "cohort_size_lenient") == sum((is.na(df$age) | df$age >= 50) & (is.na(df$ecog) | df$ecog <= 1))
  imp <- r$diagnostics$criterionImpact
  ok_imp <- imp[[1]]$failsAlone == sum(!is.na(df$age) & df$age < 50) && imp[[2]]$failsAlone == sum(!is.na(df$ecog) & df$ecog > 1) &&
    imp[[1]]$indeterminateAlone == sum(is.na(df$age)) &&
    imp[[1]]$excludedOnlyByThisRule == sum(!is.na(df$age) & df$age < 50 & (is.na(df$ecog) | df$ecog <= 1))
  mem <- vcr_test_table(r, "cohort-members", dir)
  ok_mem <- nrow(mem) == sum(alive) && all(c("USUBJID", "index", "exit") %in% names(mem)) && identical(sort(mem$USUBJID), sort(df$USUBJID[alive])) &&
    all(as.Date(mem$exit) > as.Date(mem$index)) && identical(r$diagnostics$timeZero$column, "rfstdt") && r$counts$realPatients == sum(alive)
  empty <- vcr_test_run(vcr_test_job("cohort.build", list(rules = list()), list(in_s), job_id = "job_n25b_e"))
  # downstream: the same rules change the comparator's number, and their hash is the cohort's
  sc <- list(covariates = list("age"), outcomeColumn = "y", treatmentColumn = "arm", endpoint = list(type = "continuous"))
  df2 <- df[!is.na(df$age), ]; in_c <- vcr_test_input(df2[, c("USUBJID", "arm", "age", "ecog", "y")], "snp_n25b:complete", "subject")
  all_ <- vcr_test_run(vcr_test_job("comparator.propensity_weight", sc, list(in_c), seed = 2L, job_id = "job_n25b_a"))
  cut <- vcr_test_run(vcr_test_job("comparator.propensity_weight", c(sc, list(cohortRules = list(list(name = "adult", rule = cmp("age", "gte", 62))))), list(in_c), seed = 2L, job_id = "job_n25b_c"))
  ok_down <- identical(all_$status, "succeeded") && identical(cut$status, "succeeded") &&
    cut$diagnostics$cohort$keptRows == sum(df2$age >= 62) && cut$counts$realPatients == sum(df2$age >= 62) && all_$counts$realPatients == nrow(df2) &&
    abs(vcr_measure_value(all_, "weighted_difference") - vcr_measure_value(cut, "weighted_difference")) > 1e-4
  same_hash <- {
    one <- vcr_test_run(vcr_test_job("cohort.build", list(rules = list(list(name = "adult", rule = cmp("age", "gte", 62)))), list(in_c), job_id = "job_n25b_h"))
    identical(one$diagnostics$cohortRulesHash, cut$diagnostics$cohort$rulesHash) && nzchar(one$diagnostics$cohortRulesHash)
  }
  ok <- ok_wf && ok_sizes && ok_imp && ok_mem && identical(empty$status, "failed") && ok_down && same_hash
  unlink(dir, recursive = TRUE)
  list(pass = ok,
       detail = sprintf("waterfall kept/excluded/indeterminate %d/%d/%d then %d/-/%d equals the independent count (cohort %d; strict %d, lenient %d); impact of 'adult' alone %d, only by it %d; member list %d rows with index and exit dates; empty rule list -> %s; downstream rules kept %d of %d and moved the estimate %.4f -> %.4f; rules hash equal to the cohort's: %s",
                        s1$kept, s1$excluded, s1$indeterminate, s2$kept, s2$indeterminate, vcr_measure_value(r, "cohort_size"),
                        vcr_measure_value(r, "cohort_size_strict"), vcr_measure_value(r, "cohort_size_lenient"),
                        imp[[1]]$failsAlone, imp[[1]]$excludedOnlyByThisRule, nrow(mem), paste(vcr_test_issue_codes(empty), collapse = ","),
                        cut$diagnostics$cohort$keptRows, nrow(df2), vcr_measure_value(all_, "weighted_difference"), vcr_measure_value(cut, "weighted_difference"), same_hash))
})

vcr_case("N24d", c("AC-26"), function() {
  # Parquet goes through the Python bridge on a private copy of the bytes that
  # were hashed. A Parquet file and the same table as CSV give the same profile
  # (columns, rows, numeric summaries); a file whose bytes are not Parquet at all
  # but whose hash matches is refused `input_parse_failed`, and no parser text or
  # file content appears in the result.
  py <- Sys.getenv("VCR_PYTHON", "python3")
  probe <- suppressWarnings(system2(py, c("-c", shQuote("import pyarrow.parquet")), stdout = TRUE, stderr = TRUE))
  if (!is.null(attr(probe, "status"))) {
    said <- utils::tail(probe[nzchar(probe)], 2)
    return(list(pass = FALSE, detail = sprintf("pyarrow is not importable by VCR_PYTHON (%s -> %s, status %s): the Parquet path cannot be exercised here%s",
      py, if (nzchar(Sys.which(py))) Sys.which(py) else "not on PATH", attr(probe, "status"),
      if (length(said)) paste0(": ", paste(substr(said, 1, 200), collapse = " | ")) else "")))
  }
  set.seed(24L, kind = VCR_RNG_KIND)
  df <- data.frame(USUBJID = sprintf("S%03d", 1:80), age = round(stats::rnorm(80, 60, 9), 3), sex = rep(c("F", "M"), 40), stringsAsFactors = FALSE)
  csv_in <- vcr_test_input(df, "snp_n24d:subject", "subject")
  root <- vcr_test_data_root()
  csv_path <- file.path(root, csv_in$location)
  pq_rel <- sub("\\.csv$", ".parquet", csv_in$location); pq_path <- file.path(root, pq_rel)
  script <- sprintf("import pyarrow.csv as c, pyarrow.parquet as p; p.write_table(c.read_csv(%s), %s)", shQuote(csv_path, "sh"), shQuote(pq_path, "sh"))
  status <- system2(py, c("-c", shQuote(script)), stdout = FALSE, stderr = FALSE)
  pq_in <- csv_in; pq_in$id <- "snp_n24d_pq:subject"; pq_in$location <- pq_rel; pq_in$hash <- vcr_file_sha256(pq_path)
  prof <- function(inp) vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(inp), job_id = "job_n24d"))
  a <- prof(csv_in); b <- prof(pq_in)
  cols <- function(r) vapply(r$diagnostics$columns, function(x) paste(x$name, x$type %||% ""), character(1))
  same <- identical(a$status, "succeeded") && identical(b$status, "succeeded") && identical(cols(a), cols(b)) && length(cols(b)) == 3L &&
    identical(a$counts$realPatients, b$counts$realPatients) && b$counts$realPatients == 80
  # bytes that are not Parquet, under a matching hash
  junk_rel <- file.path("snapshots", "snp_test", "n24d-junk.parquet")
  writeLines("SECRET-PARQUET-CONTENT this is not a parquet file", file.path(root, junk_rel))
  junk_in <- csv_in; junk_in$id <- "snp_n24d_junk:subject"; junk_in$location <- junk_rel; junk_in$hash <- vcr_file_sha256(file.path(root, junk_rel))
  j <- prof(junk_in)
  json <- as.character(jsonlite::toJSON(j, auto_unbox = TRUE, null = "null"))
  ok_junk <- identical(j$status, "failed") && "input_parse_failed" %in% vcr_test_issue_codes(j) && !grepl("SECRET-PARQUET-CONTENT", json, fixed = TRUE) && !grepl("ArrowInvalid|Traceback", json)
  list(pass = status == 0L && same && ok_junk,
       detail = sprintf("the same 80-row table as CSV and as Parquet: both profile (%s), 3 columns each, %d real patients; a non-Parquet file under a matching hash -> %s, no file content in the result: %s",
                        paste(c(a$status, b$status), collapse = "/"), b$counts$realPatients %||% NA_integer_, paste(vcr_test_issue_codes(j), collapse = ","), !grepl("SECRET-PARQUET-CONTENT", json, fixed = TRUE)))
})
