# N42 — two versions of a population definition on the same table
# (`cohort.build` with `compare`): sizes, overlap and a standardized difference per
# baseline covariate. Every number is recomputed here from the table with base R
# arithmetic, independently of the engine's rule evaluation and of `vcr_smd`.

vcr_case("N42", c("AC-02", "AC-09"), function() {
  set.seed(3737L, kind = VCR_RNG_KIND)
  n <- 600L
  df <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)),
                   age = round(stats::rnorm(n, 61, 11), 1),
                   male = stats::rbinom(n, 1L, 0.55),
                   ecog = sample(c(0, 1, 2, NA), n, TRUE, c(0.35, 0.35, 0.2, 0.1)),
                   egfr = round(stats::rnorm(n, 72, 22), 1),
                   site = sample(c("A", "B", "C"), n, TRUE), stringsAsFactors = FALSE)
  df$age[sample(n, 20)] <- NA
  df$egfr[sample(n, 30)] <- NA
  in_s <- vcr_test_input(df, "snp_n37:subject", "subject")
  cmp <- function(col, cmp, v) list(op = "compare", column = col, comparator = cmp, value = v)
  # version A: adults with a performance status of 0 or 1 (a missing one excludes);
  # version B: A, tightened to age 50 and over, and to an eGFR of at least 45 (a missing one is kept).
  rules_a <- list(list(name = "adult", rule = cmp("age", "gte", 18)), list(name = "fit", rule = cmp("ecog", "lte", 1)))
  rules_b <- list(list(name = "older", rule = cmp("age", "gte", 50)), list(name = "fit", rule = cmp("ecog", "lte", 1)),
                  list(name = "renal", rule = cmp("egfr", "gte", 45), unknownAs = "include"))
  covs <- c("age", "male", "egfr", "site", "ecog")
  dir <- tempfile("n37"); dir.create(dir)
  r <- vcr_test_run(vcr_test_job("cohort.build", list(rules = rules_a, compare = list(rules = rules_b, covariates = as.list(covs))), list(in_s), job_id = "job_n37"), output_dir = dir)
  plain <- vcr_test_run(vcr_test_job("cohort.build", list(rules = rules_a), list(in_s), job_id = "job_n37_plain"))
  swapped <- vcr_test_run(vcr_test_job("cohort.build", list(rules = rules_b, compare = list(rules = rules_a, covariates = as.list(covs))), list(in_s), job_id = "job_n37_swap"))

  # independent membership
  in_a <- !is.na(df$age) & df$age >= 18 & !is.na(df$ecog) & df$ecog <= 1
  in_b <- !is.na(df$age) & df$age >= 50 & !is.na(df$ecog) & df$ecog <= 1 & (is.na(df$egfr) | df$egfr >= 45)
  cc <- r$diagnostics$comparison
  by_name <- function(cmp_) { out <- cmp_$covariates; names(out) <- vapply(out, function(x) x$covariate, character(1)); out }
  rows <- by_name(cc)
  # independent standardized differences: pooled-variance for a continuous covariate,
  # a difference of proportions for a 0/1 one (the engine's balance convention)
  smd_of <- function(x) {
    xa <- x[in_a]; xb <- x[in_b]; xa <- xa[!is.na(xa)]; xb <- xb[!is.na(xb)]
    if (all(c(xa, xb) %in% c(0, 1))) return(mean(xb) - mean(xa))
    (mean(xb) - mean(xa)) / sqrt((stats::var(xa) + stats::var(xb)) / 2)
  }
  want_age <- smd_of(df$age); want_male <- smd_of(df$male); want_egfr <- smd_of(df$egfr)
  ok_sizes <- cc$cohortSizeA == sum(in_a) && cc$cohortSizeB == sum(in_b) &&
    identical(as.integer(unlist(cc$overlap)), c(sum(in_a & in_b), sum(in_a & !in_b), sum(!in_a & in_b))) &&
    identical(names(cc$overlap), c("both", "onlyA", "onlyB")) &&
    vcr_measure_value(r, "cohort_size") == sum(in_a) && r$counts$realPatients == sum(in_a)
  ok_wf <- cc$waterfallA[[1]]$kept == sum(!is.na(df$age) & df$age >= 18) &&
    cc$waterfallB[[3]]$kept + cc$waterfallB[[3]]$indeterminate == sum(in_b) &&
    cc$waterfallB[[3]]$indeterminate == sum(is.na(df$egfr[!is.na(df$age) & df$age >= 50 & !is.na(df$ecog) & df$ecog <= 1]))
  ok_smd <- abs(rows$age$standardizedDifference - want_age) < 1e-12 && abs(rows$male$standardizedDifference - want_male) < 1e-12 &&
    abs(rows$egfr$standardizedDifference - want_egfr) < 1e-12 &&
    identical(rows$age$kind, "continuous") && identical(rows$male$kind, "binary") &&
    rows$age$missingA == sum(is.na(df$age[in_a])) && rows$egfr$missingB == sum(is.na(df$egfr[in_b])) &&
    rows$age$observedB == sum(!is.na(df$age[in_b]))
  # a tightened age bound moves the age distribution a lot and a sex split not at all in expectation
  ok_direction <- want_age > 0.3 && abs(want_male) < 0.1
  ok_skipped <- identical(rows$site$skipped, "not_numeric")
  ok_floor <- identical(cc$standardizedDifferenceFloor, 0.1) && identical(cc$binaryConvention, "difference of proportions")
  ok_hash <- identical(cc$rulesHashA, r$diagnostics$cohortRulesHash) && !identical(cc$rulesHashA, cc$rulesHashB)
  # swapping the two versions flips the sign of every difference and the overlap's two sides
  sw <- by_name(swapped$diagnostics$comparison)
  ok_swap <- abs(sw$age$standardizedDifference + rows$age$standardizedDifference) < 1e-12 &&
    abs(sw$male$standardizedDifference + rows$male$standardizedDifference) < 1e-12 &&
    swapped$diagnostics$comparison$overlap$onlyA == cc$overlap$onlyB && swapped$diagnostics$comparison$overlap$onlyB == cc$overlap$onlyA
  # without `compare` the cohort reports what it always did
  ok_plain <- identical(plain$status, "succeeded") && is.null(plain$diagnostics$comparison) &&
    identical(plain$diagnostics$cohortRulesHash, r$diagnostics$cohortRulesHash)
  # refusals: a covariate column the table lacks, an empty second version
  bad_col <- vcr_test_run(vcr_test_job("cohort.build", list(rules = rules_a, compare = list(rules = rules_b, covariates = list("nope"))), list(in_s), job_id = "job_n37_bad"))
  bad_rules <- vcr_test_run(vcr_test_job("cohort.build", list(rules = rules_a, compare = list(rules = list(list(name = "x", rule = cmp("nope", "gte", 1))), covariates = list("age"))), list(in_s), job_id = "job_n37_bad2"))
  ok_refused <- identical(bad_col$status, "failed") && identical(bad_rules$status, "failed") &&
    "scenario_value_invalid" %in% vcr_test_issue_codes(bad_col) && length(vcr_test_issue_codes(bad_rules)) > 0L
  # a covariate with fewer than two observations in a cohort is named, not compared
  tiny <- data.frame(USUBJID = sprintf("T%02d", 1:6), age = c(30, 40, 50, 60, 70, 80), z = c(1, NA, NA, NA, NA, NA), stringsAsFactors = FALSE)
  in_t <- vcr_test_input(tiny, "snp_n37t:subject", "subject")
  rt <- vcr_test_run(vcr_test_job("cohort.build", list(rules = list(list(name = "all", rule = cmp("age", "gte", 0))),
    compare = list(rules = list(list(name = "old", rule = cmp("age", "gte", 50))), covariates = list("z", "age"))), list(in_t), job_id = "job_n37_tiny"))
  ok_tiny <- identical(by_name(rt$diagnostics$comparison)$z$skipped, "too_few_observations") &&
    abs(by_name(rt$diagnostics$comparison)$age$standardizedDifference - (65 - 55) / sqrt((stats::var(c(30, 40, 50, 60, 70, 80)) + stats::var(c(50, 60, 70, 80))) / 2)) < 1e-12
  unlink(dir, recursive = TRUE)
  list(pass = ok_sizes && ok_wf && ok_smd && ok_direction && ok_skipped && ok_floor && ok_hash && ok_swap && ok_plain && ok_refused && ok_tiny,
       detail = sprintf("A keeps %d, B keeps %d (both %d, only A %d, only B %d) equal to the independent count; SMD age %.4f (independent %.4f), male %.4f (%.4f), eGFR %.4f (%.4f); text column named as not numeric %s; swap flips signs %s; no `compare` -> no comparison %s; bad column / bad rule refused %s; one-observation covariate named %s",
                        cc$cohortSizeA, cc$cohortSizeB, cc$overlap$both, cc$overlap$onlyA, cc$overlap$onlyB,
                        rows$age$standardizedDifference, want_age, rows$male$standardizedDifference, want_male,
                        rows$egfr$standardizedDifference, want_egfr, ok_skipped, ok_swap, ok_plain, ok_refused, ok_tiny))
})
