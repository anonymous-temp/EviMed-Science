
vcr_case("N41c", c("AC-02", "AC-26"), function() {
  ids <- sprintf("P%03d", seq_len(78))
  df <- data.frame(USUBJID = rep(ids, length.out = 4407), PARAMCD = "HR", AVAL = 70)
  inp <- vcr_test_input(df, "snp_n41c:long", "long")
  result <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(inp), job_id = "job_n41c"))
  missing <- df; missing$USUBJID[1] <- NA
  inp2 <- vcr_test_input(missing, "snp_n41cm:long", "long")
  result2 <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(inp2), job_id = "job_n41cm"))
  stopifnot(result$counts$realPatients == 78, is.null(result2$counts$realPatients),
            identical(result$diagnostics$patientCountBasis, "distinct_USUBJID"),
            !any(vapply(result$diagnostics$columns, function(x) identical(x$column, "USUBJID"), logical(1))))
  list(pass = TRUE, detail = "4407 observations and 78 distinct patients; incomplete identity is unknown")
})

vcr_case("N41d", c("AC-02", "AC-26"), function() {
  df <- data.frame(USUBJID = sprintf("P%03d", 1:80), age = c(rep(70, 52), rep(30, 28)), marker = c(rep(1, 40), rep(0, 40)))
  rules <- list(list(name = "age", rule = list(op = "compare", column = "age", comparator = "gte", value = 65)),
                list(name = "marker", rule = list(op = "compare", column = "marker", comparator = "eq", value = 1)))
  run <- function(d, shape = "subject", scenario = list(rules = rules), extra = list()) vcr_test_run(vcr_test_job("cohort.build", scenario, list(vcr_test_input(d, paste0("snp_n41d:", shape), shape)), extra = extra))
  r <- run(df); dup <- run(rbind(df, df[1, ])); missing <- df; missing$USUBJID[1] <- NA; m <- run(missing)
  old <- run(rbind(df, df[1, ]), extra = list(methodVersion = "1.0.0"))
  w <- r$diagnostics$waterfall
  ok <- r$status == "succeeded" && r$counts$realPatients == 40 && w[[1]]$denominator == 80 && w[[1]]$remaining == 52 && w[[2]]$denominator == 52 && w[[2]]$excluded == 12 && w[[2]]$remaining == 40 && dup$status == "failed" && m$status == "failed" && old$status == "succeeded"
  list(pass = ok, detail = sprintf("80 -> 52 -> 40, second exclusion %s; duplicate/missing refused, legacy %s", w[[2]]$excluded, old$status))
})

vcr_case("N41e", c("AC-02", "AC-27"), function() {
  subj <- data.frame(USUBJID = sprintf("P%02d", 1:20), arm = rep(0:1, each = 10))
  ev <- data.frame(USUBJID = subj$USUBJID, AVAL = rep(1:10, 2), CNSR = rep(c(0,1), 10))
  a <- vcr_test_input(subj, "snp_n41e:subject", "subject"); e <- vcr_test_input(ev, "snp_n41e:events", "event")
  run <- function(sc, event = e, extra = list()) vcr_test_run(vcr_test_job("comparator.rmst", sc, list(a, event), extra = extra))
  base <- list(tau = 5, treatmentColumn = "arm"); metadata <- e; metadata$timeUnit <- "days"
  missing <- run(base); day <- run(c(base, list(timeUnit = "days"))); mapped <- run(base, metadata)
  conflict <- run(c(base, list(timeUnit = "months")), metadata); old <- run(base, extra = list(methodVersion = "1.0.0"))
  ok <- missing$status == "failed" && day$status == "succeeded" && mapped$status == "succeeded" && conflict$status == "failed" && old$status == "succeeded" && identical(vcr_get_measure(day, "rmst_difference")$unit, "days") && identical(vcr_get_measure(old, "rmst_difference")$unit, "months") && vcr_measure_value(day, "rmst_difference") == vcr_measure_value(mapped, "rmst_difference")
  list(pass = ok, detail = sprintf("missing=%s explicit=%s mapped=%s conflict=%s legacy=%s", missing$status, day$status, mapped$status, conflict$status, old$status))
})

vcr_case("N41f", c("AC-02", "AC-07"), function() {
  subj <- data.frame(USUBJID = sprintf("P%02d", 1:20), arm = rep(0:1, each = 10), age = rep(1:10, 2))
  ev <- data.frame(USUBJID = subj$USUBJID, AVAL = rep(1:10, 2), CNSR = rep(c(0,1), 10))
  a <- vcr_test_input(subj, "snp_n41f:subject", "subject"); e <- vcr_test_input(ev, "snp_n41f:events", "event"); e$timeUnit <- "days"
  scenario <- list(covariates = list("age"), endpoint = list(type = "time_to_event"), tau = 5, timeUnit = "months")
  results <- lapply(c("comparator.entropy_balance", "comparator.propensity_weight"), function(method) vcr_test_run(vcr_test_job(method, scenario, list(a,e))))
  ok <- all(vapply(results, function(r) identical(r$status,"failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(r), logical(1)))
  list(pass = ok, detail = sprintf("conflicting mapped days and scenario months refused by both weighting methods: %s", ok))
})

vcr_case("N41g", c("AC-02", "AC-26"), function() {
  df <- data.frame(USUBJID = sprintf("P%03d",1:52), row_id = 1:52, x = rep(c(1,10,30,50,60,65,71,73,76,80,85,100,120), each = 4))
  run <- function(source, shape = "subject", extra = list()) vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(vcr_test_input(df, paste0("snp_n41g:",source), shape, source = source)), extra = extra))
  real <- run("observed"); synthetic <- run("synthetic"); reconstructed <- run("reconstructed"); raw <- run("observed", NULL); legacy <- run("observed", "subject", list(methodVersion = "1.0.0"))
  x <- Filter(function(c) identical(c$column,"x"), real$diagnostics$columns)[[1]]
  ok <- real$counts$realPatients == 52 && synthetic$counts$realPatients == 0 && synthetic$counts$generatedRecords == 52 && reconstructed$counts$realPatients == 0 && reconstructed$counts$reconstructedPseudoPatients == 52 && is.null(raw$counts$realPatients) && legacy$counts$realPatients == 52 && !any(vapply(real$diagnostics$columns,function(c) c$column %in% c("USUBJID","row_id"),logical(1))) && identical(x$meanMedianDirection,"mean_below_median")
  list(pass = ok, detail = sprintf("real=52 synthetic=52 reconstructed=52 raw identity unknown; mean %.1f median %.1f",x$mean,x$median))
})

vcr_case("N41h", c("AC-02", "AC-12"), function() {
  subj <- data.frame(USUBJID = sprintf("P%02d", 1:20), arm = rep(0:1, each = 10), age = rep(1:10, 2))
  ev <- data.frame(USUBJID = subj$USUBJID, AVAL = rep(1:10, 2), CNSR = 1L)
  a <- vcr_test_input(subj, "snp_n41h:subject", "subject"); e <- vcr_test_input(ev, "snp_n41h:events", "event")
  scenario <- list(tau = 50, covariates = list("age")); sets <- list(tau = 50, endpoint = list(type = "time_to_event"), covariateSets = list(list(name = "one", covariates = list("age")),list(name = "two", covariates = list("age"))))
  run <- function(method, sc, event = e, version = NULL) vcr_test_run(vcr_test_job(method, sc, list(a,event), extra = if (is.null(version)) list() else list(methodVersion = version)))
  mapped <- e; mapped$timeUnit <- "days"
  tests <- lapply(list(list(method = "comparator.weighted_cox", sc = scenario), list(method = "comparator.covariate_sets", sc = sets)), function(x) {
    missing <- run(x$method, x$sc); conflict <- run(x$method, c(x$sc,list(timeUnit = "months")), mapped); legacy <- run(x$method, x$sc, version = "1.0.0"); source <- run(x$method, x$sc, mapped)
    c(missing = identical(missing$status, "failed") && "scenario_field_missing" %in% vcr_test_issue_codes(missing),
      conflict = identical(conflict$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(conflict),
      legacy = identical(legacy$status, "not_estimable"), source = identical(source$status, "not_estimable"))
  })
  list(pass = all(unlist(tests)), detail = sprintf("weighted Cox and covariate-set RMST both refuse missing/conflicting units; mapped and legacy reach event verdict: %s (%s)", all(unlist(tests)), paste(unlist(tests), collapse = ",")))
})

vcr_case("N41i", c("AC-02", "AC-12"), function() {
  subj <- data.frame(USUBJID = sprintf("P%02d", 1:20), age = rep(1:10, 2))
  ev <- data.frame(USUBJID = subj$USUBJID, AVAL = rep(1:10, 2), CNSR = 1L)
  pseudo <- data.frame(time = 1:20, status = rep(0L, 20))
  a <- vcr_test_input(subj, "snp_n41i:subject", "subject"); e <- vcr_test_input(ev, "snp_n41i:events", "event")
  p <- vcr_test_input(pseudo, "rec_n41i:1", source = "reconstructed")
  sc <- list(covariates = list("age"), targets = list(age = 5), pseudoIpdInputId = p$id)
  run <- function(scenario, obs = e, rec = p, version = NULL) vcr_test_run(vcr_test_job("comparator.maic_time_to_event", scenario, list(a, obs, rec), extra = if (is.null(version)) list() else list(methodVersion = version)))
  mapped <- e; mapped$timeUnit <- "days"; pseudo_mapped <- p; pseudo_mapped$timeUnit <- "months"
  missing <- run(sc); pseudo_unknown <- run(sc, mapped); conflict <- run(c(sc,list(timeUnit = "days")), mapped, pseudo_mapped)
  declared <- run(c(sc,list(timeUnit = "days")), mapped); legacy <- run(sc, version = "1.0.0")
  ok <- identical(missing$status,"failed") && "scenario_field_missing" %in% vcr_test_issue_codes(missing) &&
    identical(pseudo_unknown$status,"failed") && "scenario_field_missing" %in% vcr_test_issue_codes(pseudo_unknown) &&
    identical(conflict$status,"failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(conflict) &&
    identical(declared$status,"not_estimable") && identical(legacy$status,"not_estimable")
  list(pass = ok, detail = sprintf("MAIC missing=%s pseudo unknown=%s mixed=%s common declaration=%s legacy=%s", missing$status, pseudo_unknown$status, conflict$status, declared$status, legacy$status))
})
