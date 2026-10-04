# N36 — comparator.covariate_sets: the comparator analysis re-run under
# alternative pre-declared covariate sets, each estimate and the range reported,
# a set that breaks a rule reported as that and never dropped.
#
# References that are not this method's own code: WeightIt's entropy-balancing
# weights for each set (the cross-software reference N07 uses), a design whose
# confounders are known (omitting one of them must move the estimate the right way,
# omitting noise must not), and the analyses' own jobs run alone on the same table
# and seed (the per-set numbers must be theirs, bit for bit).

# a confounded continuous outcome: x1 and x2 drive both the arm and the outcome, x3 is noise, x4 is a covariate whose
# trial mean lies far outside the controls' range (no weighting can reach it); the true effect is 0.5
.n36_data <- function(n = 600L, seed = 36L, sel = 0.7) {
  set.seed(seed, kind = VCR_RNG_KIND)
  x1 <- stats::rnorm(n); x2 <- stats::rnorm(n); x3 <- stats::rnorm(n)
  z <- stats::rbinom(n, 1L, stats::plogis(-0.4 + sel * x1 + sel * x2))
  y <- 1 + 0.8 * x1 + 0.8 * x2 + 0.5 * z + stats::rnorm(n)
  data.frame(USUBJID = sprintf("S%04d", seq_len(n)), arm = z, x1 = x1, x2 = x2, x3 = x3, x4 = stats::rnorm(n) + 8 * z, y = y, stringsAsFactors = FALSE)
}

.n36_sets <- function(...) { s <- list(...); unname(lapply(names(s), function(nm) list(name = nm, covariates = as.list(s[[nm]])))) }

.n36_job <- function(d, id, scenario = list(), analysis = "entropy_balance", endpoint = "continuous", seed = 7L, extra_inputs = NULL, method = "comparator.covariate_sets") {
  sc <- utils::modifyList(list(analysis = analysis, treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = endpoint)), scenario)
  if (identical(method, "comparator.covariate_sets") && is.null(sc$covariateSets)) sc$covariateSets <- .n36_sets(primary = c("x1", "x2"), `without x2` = "x1")
  if (!identical(method, "comparator.covariate_sets")) { sc$analysis <- NULL; sc$covariateSets <- NULL }
  vcr_test_job(method, sc, c(list(vcr_test_input(d, paste0("snp_", id, ":subject"), "subject")), extra_inputs), seed = seed, job_id = paste0("job_", id))
}

vcr_case("N36a", c("AC-07", "AC-08", "AC-11", "AC-30"), function() {
  # Four sets of a confounded design with a true effect of 0.5: {x1, x2} (the primary: both confounders), {x1} (one
  # confounder omitted: the estimate is biased up), {x1, x2, x3} (noise added: it does not move) and {x1, x4} (a covariate
  # no weighting can reach: not estimable). Each estimable set's number is WeightIt's entropy-balance weighted mean
  # difference; the range is over those; the set that cannot be estimated is in the result with its rule.
  suppressMessages(library(WeightIt))
  d <- .n36_data()
  sets <- .n36_sets(`both confounders` = c("x1", "x2"), `x2 omitted` = "x1", `plus noise` = c("x1", "x2", "x3"), `unreachable covariate` = c("x1", "x4"))
  dir <- tempfile("n36a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- vcr_test_run(.n36_job(d, "n36a", list(covariateSets = sets)), output_dir = dir)
  ref <- function(covs) {
    wi <- WeightIt::weightit(stats::reformulate(covs, "arm"), data = d, method = "ebal", estimand = "ATT", reltol = 1e-16, maxit = 200000L)
    t1 <- d$arm == 1L
    stats::weighted.mean(d$y[t1], wi$weights[t1]) - stats::weighted.mean(d$y[!t1], wi$weights[!t1])
  }
  refs <- c(ref(c("x1", "x2")), ref("x1"), ref(c("x1", "x2", "x3")))
  est <- vapply(1:3, function(k) vcr_measure_value(r, sprintf("covariate_set_estimate_%d", k)), numeric(1))
  # the analysis alone on the same table and seed: the per-set numbers are its, bit for bit
  alone <- vcr_test_run(.n36_job(d, "n36a_p", list(covariates = list("x1", "x2")), method = "comparator.entropy_balance"))
  alone2 <- vcr_test_run(.n36_job(d, "n36a_q", list(covariates = list("x1")), method = "comparator.entropy_balance"))
  same <- function(k, a) { m <- vcr_get_measure(r, sprintf("covariate_set_estimate_%d", k)); b <- vcr_get_measure(a, "weighted_difference")
    identical(m$value, b$value) && identical(unlist(m$interval[c("low", "high")]), unlist(b$interval[c("low", "high")])) }
  tbl <- vcr_test_table(r, "covariate-sets", dir)
  s4 <- r$diagnostics$sets[[4]]; lb <- unlist(r$diagnostics$limitedBy)
  rng <- r$diagnostics$range
  ok <- identical(r$status, "succeeded") && identical(r$conclusion, "limited") && all(abs(est - refs) < 1e-7) &&
    abs(vcr_measure_value(r, "covariate_set_range_low") - min(refs)) < 1e-7 && abs(vcr_measure_value(r, "covariate_set_range_high") - max(refs)) < 1e-7 &&
    abs(vcr_measure_value(r, "covariate_set_range_width") - (max(refs) - min(refs))) < 1e-7 &&
    vcr_measure_value(r, "covariate_sets_total") == 4 && vcr_measure_value(r, "covariate_sets_estimable") == 3 &&
    is.null(vcr_get_measure(r, "covariate_set_estimate_4")) && identical(s4$status, "not_estimable") && identical(s4$notEstimableRule, "entropy_balance_infeasible") && is.null(s4$estimate) &&
    "covariate_set_without_estimate" %in% lb && !("primary_set_without_estimate" %in% lb) && nrow(tbl) == 4L && identical(tbl$rule[4], "entropy_balance_infeasible") && is.na(tbl$estimate[4]) &&
    same(1L, alone) && same(2L, alone2) &&
    # the design behaves as designed: both confounders recovers 0.5, omitting one biases it up, noise changes nothing
    vcr_get_measure(r, "covariate_set_estimate_1")$interval$low < 0.5 && 0.5 < vcr_get_measure(r, "covariate_set_estimate_1")$interval$high && est[2] > est[1] + 0.2 && abs(est[3] - est[1]) < 0.05 &&
    identical(vcr_get_measure(r, "covariate_set_estimate_2")$note, "x2 omitted") && isTRUE(r$diagnostics$agreement$allIntervalsExcludeNull) && isTRUE(r$diagnostics$agreement$sameSign) &&
    length(vcr_validate_result(r)) == 0L && identical(r$counts$realPatients, 600L)
  list(pass = ok,
       detail = sprintf("true effect 0.5; per-set estimate / WeightIt ebal reference: both confounders %.7f / %.7f, x2 omitted %.7f / %.7f, plus noise %.7f / %.7f; range [%.4f, %.4f] over 3 of 4 sets; the unreachable covariate set -> %s, in the table (4 rows) and not dropped; sets 1 and 2 are the entropy-balance job's own numbers and intervals bit for bit: %s/%s; conclusion %s, limited by %s",
                        est[1], refs[1], est[2], refs[2], est[3], refs[3], rng$low, rng$high, s4$notEstimableRule, same(1L, alone), same(2L, alone2), r$conclusion, paste(lb, collapse = "+")))
})

vcr_case("N36b", c("AC-08", "AC-30"), function() {
  # The other analyses, each set the analysis' own run: logistic propensity weights (a milder design, so the
  # balance rule is met), the doubly robust estimate for a binary outcome, and entropy balancing for a time-to-event
  # endpoint (RMST difference at tau). One set of each is compared with the analysis run alone on the same table and seed.
  d <- .n36_data(n = 500L, seed = 37L, sel = 0.25)
  p_sets <- .n36_sets(`x1 and x2` = c("x1", "x2"), `x1` = "x1")
  rp <- vcr_test_run(.n36_job(d, "n36b_p", list(covariateSets = p_sets), analysis = "propensity"))
  ap <- vcr_test_run(.n36_job(d, "n36b_pa", list(covariates = list("x1", "x2")), method = "comparator.propensity_weight"))
  db <- d; db$yb <- as.integer(d$y > stats::median(d$y))
  a_sets <- .n36_sets(`x1 and x2` = c("x1", "x2"), `x1` = "x1")
  ra <- vcr_test_run(.n36_job(db, "n36b_a", list(covariateSets = a_sets, outcomeColumn = "yb"), analysis = "aipw", endpoint = "binary"))
  aa <- vcr_test_run(.n36_job(db, "n36b_aa", list(covariates = list("x1", "x2"), outcomeColumn = "yb"), method = "comparator.aipw", endpoint = "binary"))
  set.seed(38L, kind = VCR_RNG_KIND)
  n <- 300L; x1 <- stats::rnorm(n); x2 <- stats::rnorm(n); z <- stats::rbinom(n, 1L, stats::plogis(0.6 * x1 + 0.3 * x2))
  tt <- stats::rexp(n, 0.08 * exp(0.4 * x1 + 0.2 * x2) * ifelse(z == 1L, 0.6, 1)); cn <- stats::runif(n, 3, 30)
  subj <- data.frame(USUBJID = sprintf("T%04d", seq_len(n)), arm = z, x1 = x1, x2 = x2)
  ev <- data.frame(USUBJID = subj$USUBJID, PARAMCD = "OS", AVAL = pmin(tt, cn), CNSR = as.integer(tt > cn))
  ev_in <- vcr_test_input(ev, "snp_n36b_t:events", "event")
  rt <- vcr_test_run(.n36_job(subj, "n36b_t", list(covariateSets = .n36_sets(`x1 and x2` = c("x1", "x2"), `x1` = "x1"), tau = 8), endpoint = "time_to_event", extra_inputs = list(ev_in)))
  ev_in2 <- vcr_test_input(ev, "snp_n36b_ta:events", "event")
  at <- vcr_test_run(.n36_job(subj, "n36b_ta", list(covariates = list("x1", "x2"), tau = 8), endpoint = "time_to_event", extra_inputs = list(ev_in2), method = "comparator.entropy_balance"))
  same <- function(r, a, name_a) { m <- vcr_get_measure(r, "covariate_set_estimate_1"); b <- vcr_get_measure(a, name_a)
    identical(m$value, b$value) && identical(unlist(m$interval[c("low", "high")]), unlist(b$interval[c("low", "high")])) }
  rec <- function(r) vapply(r$diagnostics$sets, function(s) s$status, character(1))
  ok <- identical(rp$status, "succeeded") && identical(ra$status, "succeeded") && identical(rt$status, "succeeded") &&
    same(rp, ap, "weighted_difference") && same(ra, aa, "aipw_difference") && same(rt, at, "rmst_difference") &&
    all(rec(rp) == "succeeded") && all(rec(ra) == "succeeded") && all(rec(rt) == "succeeded") &&
    identical(rp$diagnostics$primaryMeasure, "weighted_difference") && identical(ra$diagnostics$primaryMeasure, "aipw_difference") && identical(rt$diagnostics$primaryMeasure, "rmst_difference") &&
    identical(vcr_get_measure(rt, "covariate_set_estimate_1")$unit, "months") &&
    all(vapply(list(rp, ra, rt), function(r) length(vcr_validate_result(r)) == 0L, logical(1)))
  list(pass = ok,
       detail = sprintf("propensity weights: set 1 %.6f, the analysis alone %.6f (identical: %s); doubly robust: %.6f vs %.6f (%s); time-to-event RMST difference: %.6f vs %.6f (%s, unit %s); ranges %.4f / %.4f / %.4f wide",
                        vcr_measure_value(rp, "covariate_set_estimate_1"), vcr_measure_value(ap, "weighted_difference"), same(rp, ap, "weighted_difference"),
                        vcr_measure_value(ra, "covariate_set_estimate_1"), vcr_measure_value(aa, "aipw_difference"), same(ra, aa, "aipw_difference"),
                        vcr_measure_value(rt, "covariate_set_estimate_1"), vcr_measure_value(at, "rmst_difference"), same(rt, at, "rmst_difference"), vcr_get_measure(rt, "covariate_set_estimate_1")$unit,
                        vcr_measure_value(rp, "covariate_set_range_width"), vcr_measure_value(ra, "covariate_set_range_width"), vcr_measure_value(rt, "covariate_set_range_width")))
})

vcr_case("N36c", c("AC-07", "AC-08", "AC-09"), function() {
  # What happens when the sets themselves are the trouble: the primary set not estimable (the others are still
  # reported, and the result says the primary was not), every set not estimable (one verdict, no number), a set that names a
  # column the table does not have (that set is refused by its code, said in place, and the rest go on; when no set has an
  # estimate and the primary was refused the whole job is refused by that code), names that repeat, an analysis the endpoint
  # does not suit, and a cancel.
  d <- .n36_data(n = 300L, seed = 39L)
  codes <- function(r) paste(vcr_test_issue_codes(r), collapse = ",")
  prim_bad <- vcr_test_run(.n36_job(d, "n36c_a", list(covariateSets = .n36_sets(`unreachable` = c("x1", "x4"), `both` = c("x1", "x2"), `x1` = "x1"))))
  all_bad <- vcr_test_run(.n36_job(d, "n36c_b", list(covariateSets = .n36_sets(`one` = c("x1", "x4"), `two` = c("x2", "x4")))))
  second_missing <- vcr_test_run(.n36_job(d, "n36c_c", list(covariateSets = .n36_sets(`both` = c("x1", "x2"), `ghost` = c("x1", "nope")))))
  first_missing <- vcr_test_run(.n36_job(d, "n36c_d", list(covariateSets = .n36_sets(`ghost` = c("x1", "nope"), `both` = c("x1", "x2")))))
  all_missing <- vcr_test_run(.n36_job(d, "n36c_d2", list(covariateSets = .n36_sets(`ghost` = c("x1", "nope"), `phantom` = c("nada", "x2")))))
  dup_job <- .n36_job(d, "n36c_e2", list(covariateSets = list(list(name = "same", covariates = list("x1")), list(name = "same", covariates = list("x2")))))
  r_dup <- vcr_test_run(dup_job)
  aipw_tte <- vcr_test_run(.n36_job(d, "n36c_f", list(tau = 4), analysis = "aipw", endpoint = "time_to_event"))
  aipw_ate <- vcr_test_run(.n36_job(d, "n36c_g", list(estimand = "ATE"), analysis = "aipw"))
  cf <- tempfile("cancel"); file.create(cf); on.exit(unlink(cf), add = TRUE)
  canceled <- vcr_run_job(vcr_test_json(.n36_job(d, "n36c_h")), cancel_file = cf)
  sets_of <- function(r) vapply(r$diagnostics$sets, function(s) s$status, character(1))
  ok <- identical(prim_bad$status, "succeeded") && identical(prim_bad$conclusion, "limited") && "primary_set_without_estimate" %in% unlist(prim_bad$diagnostics$limitedBy) &&
    identical(sets_of(prim_bad), c("not_estimable", "succeeded", "succeeded")) && is.null(vcr_get_measure(prim_bad, "covariate_set_estimate_1")) && !is.null(vcr_get_measure(prim_bad, "covariate_set_estimate_2")) &&
    identical(prim_bad$diagnostics$primarySet, "unreachable") &&
    identical(all_bad$status, "not_estimable") && identical(all_bad$notEstimableRule, "entropy_balance_infeasible") && length(all_bad$measures) == 0L && length(all_bad$diagnostics$sets) == 2L &&
    identical(second_missing$status, "succeeded") && identical(sets_of(second_missing), c("succeeded", "failed")) && identical(second_missing$diagnostics$sets[[2]]$refusal$code, "input_shape_invalid") &&
    "covariate_set_without_estimate" %in% unlist(second_missing$diagnostics$limitedBy) && identical(second_missing$conclusion, "limited") &&
    identical(first_missing$status, "succeeded") && identical(sets_of(first_missing), c("failed", "succeeded")) && "primary_set_without_estimate" %in% unlist(first_missing$diagnostics$limitedBy) &&
    identical(first_missing$diagnostics$sets[[1]]$refusal$code, "input_shape_invalid") && is.null(vcr_get_measure(first_missing, "covariate_set_estimate_1")) &&
    identical(all_missing$status, "failed") && "input_shape_invalid" %in% vcr_test_issue_codes(all_missing) && length(all_missing$measures) == 0L &&
    identical(r_dup$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(r_dup) &&
    identical(aipw_tte$status, "failed") && "endpoint_not_supported" %in% vcr_test_issue_codes(aipw_tte) &&
    identical(aipw_ate$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(aipw_ate) &&
    identical(canceled$status, "canceled") && length(canceled$measures) == 0L && length(vcr_test_issue_codes(canceled)) == 0L &&
    all(vapply(list(prim_bad, all_bad, second_missing, first_missing, all_missing, r_dup, aipw_tte, aipw_ate, canceled), function(r) length(vcr_validate_result(r)) == 0L, logical(1)))
  list(pass = ok,
       detail = sprintf("primary set unreachable -> succeeded/%s, sets %s, the primary said not estimable; every set unreachable -> %s/%s with no number; a set naming a missing column second -> succeeded, that set %s (%s); first -> %s with the primary said refused (%s); every set naming one -> %s (%s); repeated set names -> %s; doubly robust for time-to-event -> %s; doubly robust for the ATE -> %s; cancel -> %s with no measures",
                        prim_bad$conclusion, paste(sets_of(prim_bad), collapse = "/"), all_bad$status, all_bad$notEstimableRule, sets_of(second_missing)[2], second_missing$diagnostics$sets[[2]]$refusal$code,
                        first_missing$status, first_missing$diagnostics$sets[[1]]$refusal$code, all_missing$status, codes(all_missing), codes(r_dup), codes(aipw_tte), codes(aipw_ate), canceled$status))
})
