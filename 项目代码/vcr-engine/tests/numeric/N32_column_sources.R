# N32 — a result is labelled with the weakest source of the columns its method
# USED, not of the whole table.
#
# The control plane puts one `valueSource` on a table and puts the weakest of the
# table's columns', so one imputed baseline column used to mark every number
# computed from the table as imputed, including the ones that never read it.
# `columnSources` (the control plane's, per column) lets a method say which
# columns it read. The order of the four sources is the domain's (most direct
# first: observed, extracted, calculated, imputed); the reference values below
# are that order applied by hand to what each method reads, not numbers the
# engine computed.

.n32_table <- function(n = 120L, seed = 32L) {
  set.seed(seed, kind = VCR_RNG_KIND)
  df <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), arm = rep(0:1, each = n / 2),
                   age = stats::rnorm(n, 60, 8), male = stats::rbinom(n, 1L, 0.5), site = sample(c("A", "B", "C"), n, TRUE),
                   stringsAsFactors = FALSE)
  df$y <- 1 + 0.03 * df$age + 0.5 * df$arm + stats::rnorm(n)
  df
}

# the table the control plane would hand over: `age` was imputed, the rest was recorded
.n32_input <- function(df, id, label = "imputed", sources = list(age = "imputed", male = "observed", y = "observed", arm = "observed")) {
  inp <- vcr_test_input(df, id, "subject", source = label)
  if (!is.null(sources)) inp$columnSources <- sources
  inp
}

.n32_used <- function(r) r$diagnostics$valueSourcesUsed

vcr_case("N32a", c("AC-04", "AC-08"), function() {
  # The weakest-source rule itself, against the domain's order, by hand: the
  # order is observed < extracted < calculated < imputed (weakest last), a source
  # outside the four is returned as it is, and a column the job does not name has
  # the table's source.
  w <- vcr_weakest_source
  rule_ok <- identical(w(c("observed", "observed")), "observed") && identical(w(c("observed", "extracted")), "extracted") &&
    identical(w(c("calculated", "observed", "extracted")), "calculated") && identical(w(c("imputed", "observed", "calculated")), "imputed") &&
    identical(w(character(0), "x"), "x") && identical(w(c(NA, "observed")), "observed")
  launder_ok <- identical(w(c("observed", "synthetic")), "synthetic") && identical(w(c("imputed", "reconstructed")), "reconstructed")
  df <- .n32_table(); attr(df, "vcrSource") <- "imputed"; attr(df, "vcrColumnSources") <- c(age = "imputed", male = "observed"); attr(df, "vcrInputId") <- "t"
  own <- c(age = vcr_column_source(df, "age"), male = vcr_column_source(df, "male"), site = vcr_column_source(df, "site"))   # site names nothing: the table's
  used_male <- vcr_used_sources(list(list(df = df, columns = c("male", "site"))))
  used_age <- vcr_used_sources(list(list(df = df, columns = c("age", "male"))))
  est_ok <- identical(vcr_estimate_source("imputed"), "imputed") && identical(vcr_estimate_source("extracted"), "calculated") &&
    identical(vcr_estimate_source("observed"), "calculated") && identical(vcr_estimate_source(NA_character_), "calculated")
  list(pass = rule_ok && launder_ok && identical(unname(own), c("imputed", "observed", "imputed")) &&
         # `site` has no source of its own, so it is the table's (imputed): reading it is reading an imputed table's column
         identical(used_male$source, "imputed") && identical(used_male$basis, "columns") &&
         identical(used_age$source, "imputed") && est_ok,
       detail = sprintf("weakest of observed+extracted = %s, of calculated+observed+extracted = %s, of imputed+observed+calculated = %s, an empty set = the fallback; a synthetic source beside observed stays %s; age/male/site -> %s/%s/%s (an unnamed column has its table's source); an estimate on imputed columns says %s, on any other %s",
                        w(c("observed", "extracted")), w(c("calculated", "observed", "extracted")), w(c("imputed", "observed", "calculated")),
                        w(c("observed", "synthetic")), own[["age"]], own[["male"]], own[["site"]], vcr_estimate_source("imputed"), vcr_estimate_source("extracted")))
})

vcr_case("N32b", c("AC-04", "AC-08", "AC-27"), function() {
  # A cohort, a profile and a weighting on a table whose label is `imputed` because
  # `age` is. What each method says is the weakest source of the columns IT read:
  # a cohort on `male` alone is observed; a cohort on `age` is imputed; a profile
  # reads every column; a weighting on `male` is not an imputed estimate, one on
  # `age` and `male` is.
  df <- .n32_table()
  inp <- .n32_input(df, "snp_n32b:subject")
  cohort <- function(col, op = "compare", value = 0) vcr_test_run(vcr_test_job("cohort.build",
    list(rules = list(list(name = "r", rule = list(op = "compare", column = col, comparator = "gte", value = value)))), list(inp), job_id = paste0("job_n32b_", col)))
  c_male <- cohort("male"); c_age <- cohort("age", value = 40)
  profile <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(inp), job_id = "job_n32b_profile"))
  src <- function(r, name) vcr_get_measure(r, name)$source
  weigh <- function(covs, id) vcr_test_run(vcr_test_job("comparator.entropy_balance",
    list(covariates = as.list(covs), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "continuous")), list(inp), seed = 5L, job_id = id))
  w_male <- weigh("male", "job_n32b_wm"); w_both <- weigh(c("age", "male"), "job_n32b_wb")
  cols_of <- function(r) vapply(.n32_used(r)$columns, function(x) x$column, character(1))
  # the same weighting on a table that names no per-column source: the table's label, as before
  legacy <- vcr_test_run(vcr_test_job("comparator.entropy_balance",
    list(covariates = list("male"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "continuous")),
    list(.n32_input(df, "snp_n32b_legacy:subject", sources = NULL)), seed = 5L, job_id = "job_n32b_legacy"))
  ok <- identical(src(c_male, "cohort_size"), "observed") && identical(src(c_age, "cohort_size"), "imputed") &&
    identical(.n32_used(c_male)$weakest, "observed") && identical(.n32_used(c_age)$weakest, "imputed") &&
    identical(src(profile, "rows"), "imputed") && identical(.n32_used(profile)$weakest, "imputed") &&
    identical(w_male$status, "succeeded") && identical(w_both$status, "succeeded") &&
    identical(src(w_male, "weighted_difference"), "calculated") && identical(.n32_used(w_male)$weakest, "observed") &&
    identical(sort(cols_of(w_male)), c("arm", "male", "y")) &&
    identical(src(w_both, "weighted_difference"), "imputed") && identical(src(w_both, "effective_sample_size"), "imputed") &&
    identical(.n32_used(w_both)$weakest, "imputed") && identical(.n32_used(w_both)$basis, "columns") &&
    identical(sort(cols_of(w_both)), c("age", "arm", "male", "y")) &&
    identical(src(legacy, "weighted_difference"), "imputed") && identical(.n32_used(legacy)$basis, "table") &&
    all(vapply(list(c_male, c_age, profile, w_male, w_both, legacy), function(r) length(vcr_validate_result(r)) == 0L, logical(1)))
  # the estimate itself does not move with the label
  same_num <- identical(vcr_measure_value(w_male, "weighted_difference"), vcr_measure_value(legacy, "weighted_difference"))
  list(pass = ok && same_num,
       detail = sprintf("table labelled imputed (age imputed, the rest observed): cohort on male -> %s, on age -> %s; profile rows -> %s; weighting on male -> estimate %s, used %s (%s); on age+male -> estimate %s, ESS %s; the same weighting with no per-column sources -> %s (basis %s); the estimate is unchanged by the label: %s",
                        src(c_male, "cohort_size"), src(c_age, "cohort_size"), src(profile, "rows"), src(w_male, "weighted_difference"),
                        .n32_used(w_male)$weakest, paste(sort(cols_of(w_male)), collapse = "+"), src(w_both, "weighted_difference"), src(w_both, "effective_sample_size"),
                        src(legacy, "weighted_difference"), .n32_used(legacy)$basis, same_num))
})

vcr_case("N32c", c("AC-04", "AC-27"), function() {
  # A time-to-event weighting reads the event table's AVAL and CNSR, so the
  # sources of those two columns count and the subject table's others do not;
  # a reconstructed table has no per-column sources and stays what it is.
  set.seed(33L, kind = VCR_RNG_KIND)
  n <- 160L
  subj <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), arm = rep(0:1, each = n / 2), x = stats::rnorm(n), stringsAsFactors = FALSE)
  ev <- data.frame(USUBJID = subj$USUBJID, PARAMCD = "OS", AVAL = stats::rexp(n, 0.08) + 1, CNSR = stats::rbinom(n, 1L, 0.25), stringsAsFactors = FALSE)
  in_subj <- vcr_test_input(subj, "snp_n32c:subject", "subject", source = "observed")
  in_ev <- vcr_test_input(ev, "snp_n32c:events", "event", source = "extracted")   # the times were read from text
  in_ev$columnSources <- list(AVAL = "extracted", CNSR = "observed")
  job <- vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x"), treatmentColumn = "arm", endpoint = list(type = "time_to_event"), tau = 4, parameterCode = "OS"),
    list(in_subj, in_ev), seed = 9L, job_id = "job_n32c")
  r <- vcr_test_run(job)
  # a reconstructed pseudo-patient table read by the unweighted RMST job
  rec <- data.frame(time = ev$AVAL, status = 1L - ev$CNSR, arm = subj$arm)
  in_rec <- vcr_test_input(rec, "rec_n32c:1", source = "reconstructed")
  r_rec <- vcr_test_run(vcr_test_job("comparator.rmst", list(tau = 4, treatmentColumn = "arm"), list(in_rec), job_id = "job_n32c_rec"))
  curve_src <- vapply(r$diagnostics$curves, function(cv) as.character(cv$source), character(1))
  rec_curve_src <- vapply(r_rec$diagnostics$curves, function(cv) as.character(cv$source), character(1))
  ok <- identical(r$status, "succeeded") && identical(.n32_used(r)$weakest, "extracted") &&
    identical(sort(vapply(.n32_used(r)$columns, function(x) paste(x$table, x$column, sep = "/"), character(1))),
              sort(c("snp_n32c:subject/x", "snp_n32c:subject/arm", "snp_n32c:events/AVAL", "snp_n32c:events/CNSR"))) &&
    identical(vcr_get_measure(r, "rmst_difference")$source, "calculated") && all(curve_src[1:2] == "extracted") &&
    identical(r_rec$status, "succeeded") && identical(.n32_used(r_rec)$weakest, "reconstructed") && all(rec_curve_src[1:2] == "reconstructed") &&
    identical(vcr_get_measure(r_rec, "rmst_difference")$source, "calculated") && length(vcr_validate_result(r)) == 0L && length(vcr_validate_result(r_rec)) == 0L
  list(pass = ok,
       detail = sprintf("time-to-event weighting: subject table observed, event table extracted (AVAL extracted, CNSR observed) -> weakest used %s from %d columns, estimate %s, the curves are drawn as %s; RMST on a reconstructed table -> %s, curves %s, estimate %s (unchanged)",
                        .n32_used(r)$weakest, length(.n32_used(r)$columns), vcr_get_measure(r, "rmst_difference")$source, curve_src[1],
                        .n32_used(r_rec)$weakest, rec_curve_src[1], vcr_get_measure(r_rec, "rmst_difference")$source))
})

vcr_case("N32d", c("AC-04"), function() {
  # The engine refuses what the domain refuses, by the same code and field, and
  # does so before it reads a byte: a word that is not a source, a map that is not
  # an object, an empty name, sources on a table that is not real people's rows.
  df <- .n32_table()
  mk <- function(inp) vcr_test_job("profile.snapshot", vcr_empty_object(), list(inp), job_id = "job_n32d")
  base <- vcr_test_input(df, "snp_n32d:1", source = "observed", kind = "snapshot_file")
  # `columnSources` is set AFTER the job went through JSON: an object with an empty
  # key cannot be written by `toJSON`, and the point is what the validator reads
  codes <- function(sources, label = "observed") {
    inp <- base; inp$valueSource <- label
    job <- vcr_test_json(mk(inp)); job$inputs[[1]]$columnSources <- sources
    keys <- vapply(vcr_validate_job(job), function(i) paste0(i$code, "@", i$field), character(1))
    paste(sort(keys), collapse = " | ")
  }
  got <- c(good = codes(list(age = "imputed")), empty = codes(vcr_empty_object()), bad_word = codes(list(age = "guessed")),
           aggregate = codes(list(age = "aggregate")), as_list = codes(list("age")), as_string = codes("observed"),
           empty_name = codes(vcr_parse_json('{"": "observed"}')), synthetic = codes(list(age = "observed"), "synthetic"))
  want <- c(good = "", empty = "", bad_word = "input_column_source_invalid@inputs[0].columnSources.age",
            aggregate = "input_column_source_invalid@inputs[0].columnSources.age",
            as_list = "input_column_sources_invalid@inputs[0].columnSources", as_string = "input_column_sources_invalid@inputs[0].columnSources",
            empty_name = "input_column_sources_invalid@inputs[0].columnSources",
            synthetic = "input_column_source_not_individual@inputs[0].columnSources")
  # and through the whole run: a refused job is a named refusal, never a partial read
  bad <- base; bad$columnSources <- list(age = "guessed")
  r <- vcr_test_run(mk(bad))
  list(pass = identical(got, want) && identical(r$status, "failed") && identical(vcr_test_issue_codes(r), "input_column_source_invalid") && length(r$measures) == 0L,
       detail = sprintf("%d/%d refusals as the domain words them (%s); a bad source word through a whole run -> status %s, code %s, %d measures",
                        sum(got == want), length(want), paste(names(want)[got != want], collapse = ","), r$status, paste(vcr_test_issue_codes(r), collapse = ","), length(r$measures)))
})

vcr_case("N32e", c("AC-04", "AC-08"), function() {
  # The three robustness comparators read the sources of the columns they used. Their measures hard-coded `calculated` (the
  # tipping-point count of people took the whole table's label), so an estimate resting on an imputed column read `calculated` while the
  # weighting jobs, AIPW, the weighted Cox model and the MAIC all said `imputed` (N32b), and none of the three listed which columns it read.
  # Each job runs twice on the same data, a table labelled `imputed` whose per-column sources say which column is: the column the method
  # USES (variant A) and a column it never reads (variant B). By the domain's order (observed < extracted < calculated < imputed) the
  # estimates of A are `imputed` and those of B `calculated` with the weakest used column `observed`; the numbers do not move with the label.
  set.seed(3232L, kind = VCR_RNG_KIND)
  n <- 120L; arm <- rep(0:1, each = n / 2L)
  x1 <- stats::rnorm(n) + 0.15 * arm; x2 <- stats::rbinom(n, 1L, 0.5); x3 <- stats::rnorm(n); score <- stats::rnorm(n)
  base <- data.frame(USUBJID = sprintf("R%03d", seq_len(n)), arm = arm, x1 = x1, x2 = x2, x3 = x3,
                     fracture = stats::rbinom(n, 1L, 0.25), cataract = stats::rbinom(n, 1L, 0.3), death = stats::rbinom(n, 1L, 0.2), score = score)
  base$y <- stats::rbinom(n, 1L, stats::plogis(-0.6 + 0.8 * arm + 1.2 * score))
  base$y01 <- ifelse(stats::runif(n) < 0.1, NA, stats::rbinom(n, 1L, 0.3 + 0.2 * arm))
  all_observed <- as.list(stats::setNames(rep("observed", ncol(base) - 1L), setdiff(names(base), "USUBJID")))
  with_sources <- function(df, id, shape, imputed) {
    inp <- vcr_test_input(df, id, shape, source = "imputed")
    src <- all_observed[intersect(names(all_observed), names(df))]
    for (cn in imputed) src[[cn]] <- "imputed"
    inp$columnSources <- src
    inp
  }
  weakest <- function(r) r$diagnostics$valueSourcesUsed$weakest
  srcs <- function(r) unique(vapply(r$measures, function(m) as.character(m$source), character(1)))
  # --- the negative controls analysed in the engine, adjusted by x1 and x2
  nc <- function(imputed, id) vcr_test_run(vcr_test_job("comparator.negative_control",
    list(covariates = list("x1", "x2"), treatmentColumn = "arm", controls = list(list(name = "fracture", column = "fracture"), list(name = "cataract", column = "cataract")),
         primary = list(name = "death", column = "death")), list(with_sources(base, paste0("snp_", id, ":subject"), "subject", imputed)), seed = 5L, replicates = 200L, job_id = paste0("job_", id)))
  nc_a <- nc("x1", "n32e_nca"); nc_b <- nc("x3", "n32e_ncb")
  # --- the binary tipping point, from the table: the outcome (with missing values) and the arm
  tp <- function(imputed, id) vcr_test_run(vcr_test_job("comparator.tipping_point",
    list(endpoint = list(type = "binary"), design = list(kind = "two_arm"), outcomeColumn = "y01", treatmentColumn = "arm", analysis = list(method = "fisher_exact", alpha = 0.025, sided = 1)),
    list(with_sources(base, paste0("snp_", id, ":subject"), "subject", imputed)), seed = 5L, job_id = paste0("job_", id)))
  tp_a <- tp("y01", "n32e_tpa"); tp_b <- tp("x3", "n32e_tpb")
  # --- the time-to-event tipping point: the arm from the subject table, time and status from the event table
  tt_t <- stats::rexp(n, 0.08 * ifelse(arm == 1L, 0.6, 1)); tt_d <- stats::rexp(n, 0.05); tm <- pmin(tt_t, tt_d, 24); st <- as.integer(tt_t <= pmin(tt_d, 24))
  subj_tt <- data.frame(USUBJID = base$USUBJID, arm = arm, x3 = x3)
  ev_tt <- data.frame(USUBJID = base$USUBJID, PARAMCD = "OS", AVAL = tm, CNSR = 1L - st)
  tte <- function(imputed_event, imputed_subject, id) {
    in_e <- vcr_test_input(ev_tt, paste0("snp_", id, ":events"), "event", source = "imputed")
    in_e$columnSources <- list(AVAL = if (imputed_event) "imputed" else "observed", CNSR = "observed")
    in_s <- vcr_test_input(subj_tt, paste0("snp_", id, ":subject"), "subject", source = "imputed")
    in_s$columnSources <- list(arm = "observed", x3 = if (imputed_subject) "imputed" else "observed")
    vcr_test_run(vcr_test_job("comparator.tipping_point", list(endpoint = list(type = "time_to_event"), horizon = 24, treatmentColumn = "arm", deltas = list(1, 1.5, 2, 4)),
                              list(in_s, in_e), seed = 5L, replicates = 40L, job_id = paste0("job_", id)))
  }
  tte_a <- tte(TRUE, FALSE, "n32e_tta"); tte_b <- tte(FALSE, TRUE, "n32e_ttb")
  # --- prognostic adjustment, binary: the arm, the score and the outcome
  pa <- function(imputed, id) vcr_test_run(vcr_test_job("comparator.prognostic_adjustment",
    list(endpoint = list(type = "binary"), prognosticScoreColumn = "score", treatmentColumn = "arm", outcomeColumn = "y"),
    list(with_sources(base, paste0("snp_", id, ":subject"), "subject", imputed)), seed = 5L, replicates = 200L, job_id = paste0("job_", id)))
  pa_a <- pa("score", "n32e_paa"); pa_b <- pa("x3", "n32e_pab")
  # the counts a caller typed are still a summary, and say so
  agg <- vcr_test_run(vcr_test_job("comparator.tipping_point", list(endpoint = list(type = "binary"), design = list(kind = "two_arm"),
    counts = list(treatment = list(n = 60, responders = 36, missing = 6), control = list(n = 60, responders = 22, missing = 8)),
    analysis = list(method = "fisher_exact", alpha = 0.025, sided = 1)), job_id = "job_n32e_agg"))
  runs <- list(nc_a, nc_b, tp_a, tp_b, tte_a, tte_b, pa_a, pa_b)
  cols_of <- function(r) sort(vapply(r$diagnostics$valueSourcesUsed$columns, function(x) x$column, character(1)))
  checks <- c(
    runs_valid = all(vapply(runs, function(r) identical(r$status, "succeeded") && length(vcr_validate_result(r)) == 0L, logical(1))),
    nc_imputed = identical(srcs(nc_a), "imputed") && identical(weakest(nc_a), "imputed"),
    nc_unread = identical(srcs(nc_b), "calculated") && identical(weakest(nc_b), "observed"),
    nc_columns = identical(cols_of(nc_b), sort(c("x1", "x2", "arm", "fracture", "cataract", "death"))),
    tp_imputed = identical(srcs(tp_a), "imputed") && identical(weakest(tp_a), "imputed"),
    tp_unread = identical(srcs(tp_b), "calculated") && identical(weakest(tp_b), "observed"),
    tp_columns = identical(cols_of(tp_b), sort(c("arm", "y01"))),
    tte_imputed = identical(vcr_get_measure(tte_a, "primary_hazard_ratio")$source, "imputed") && identical(vcr_get_measure(tte_a, "imputed_early_censored_people")$source, "imputed") && identical(weakest(tte_a), "imputed"),
    tte_unread = identical(vcr_get_measure(tte_b, "primary_hazard_ratio")$source, "calculated") && identical(vcr_get_measure(tte_b, "imputed_early_censored_people")$source, "observed") && identical(weakest(tte_b), "observed"),
    tte_columns = identical(cols_of(tte_b), sort(c("AVAL", "CNSR", "arm"))),
    pa_imputed = identical(srcs(pa_a), "imputed") && identical(weakest(pa_a), "imputed"),
    pa_unread = identical(srcs(pa_b), "calculated") && identical(weakest(pa_b), "observed"),
    pa_columns = identical(cols_of(pa_b), sort(c("arm", "score", "y"))),
    typed_counts = identical(srcs(agg), "aggregate") && is.null(agg$diagnostics$valueSourcesUsed),
    # the label is a label: the same job with another column marked imputed gives the same numbers
    same_numbers = identical(vcr_measure_value(nc_a, "primary_log_effect"), vcr_measure_value(nc_b, "primary_log_effect")) &&
      identical(vcr_measure_value(tp_a, "primary_p_value"), vcr_measure_value(tp_b, "primary_p_value")) &&
      identical(vcr_measure_value(pa_a, "marginal_risk_difference"), vcr_measure_value(pa_b, "marginal_risk_difference")))
  ok <- all(checks); same <- checks[["same_numbers"]]
  list(pass = ok,
       detail = sprintf("imputed column used -> imputed, an imputed column never read -> calculated (weakest used observed): negative controls %s / %s, binary tipping point %s / %s, time-to-event tipping point %s / %s (people count %s / %s), prognostic adjustment %s / %s; typed counts stay %s; the numbers are the same: %s%s",
                        paste(srcs(nc_a), collapse = "+"), paste(srcs(nc_b), collapse = "+"), paste(srcs(tp_a), collapse = "+"), paste(srcs(tp_b), collapse = "+"),
                        vcr_get_measure(tte_a, "primary_hazard_ratio")$source, vcr_get_measure(tte_b, "primary_hazard_ratio")$source,
                        vcr_get_measure(tte_a, "imputed_early_censored_people")$source, vcr_get_measure(tte_b, "imputed_early_censored_people")$source,
                        paste(srcs(pa_a), collapse = "+"), paste(srcs(pa_b), collapse = "+"), paste(srcs(agg), collapse = "+"), same,
                        if (ok) "" else paste0("; FAILED CHECKS: ", paste(names(checks)[!checks], collapse = ", "))))
})
