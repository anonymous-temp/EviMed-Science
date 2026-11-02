# N62 — a job labelled with an older compatible method version returns what that version returned (review P1-7, 2026-11-02).
#
# The remediation of 2026-11-01 added behaviour to methods that older labels may still ask for (`compatibleVersions`): the weighted
# balance read and never refused on, the E-value, the enrolment-year row, a reconstruction from a curve with no risk table, the borrowing
# table in the result, the population jobs' statement about the correlation, the local calibration. What a release added runs only for
# the jobs labelled with it or a later one (`vcr_job_at_least`); an older label gets the old rule and the old keys, so that its output
# hash is the one it had.
#
# Each case runs a job at the older label and reads what that release did: the refusal on a weighted covariate still apart by the floor
# (for the weighting jobs before 1.2.0, the doubly robust job and the negative-control analysis before 1.1.0), and the absence of every
# key and measure a later release added. The same jobs were also run through the engine as it was before the remediation (git
# d60de9567) and the canonical JSON of the two results compared: identical in 37 of 37 replays (the maintainer's differential, not a case).
# A current-label run of each is beside, so a case cannot pass by the feature being absent everywhere.
#
# Helpers: `.n33_data`/`.n33_job` (N33), `.n35_gen`/`.n35_job` (N35), `.n36_data`/`.n36_job`/`.n36_sets` (N36), `.n37_dgp` (N37),
# `.n17_arm`/`.n17_prov` (N14-N17), `.n52_equation_job` (N52), `.n56_dates` (N56); files are sourced in name order.

# the same job under another label of its method
.n62_at <- function(job, version) { job$methodVersion <- version; job }
.n62_has <- function(result, key) key %in% names(result$diagnostics)
.n62_measure <- function(result, name) !is.null(vcr_get_measure(result, name))

vcr_case("N62a", c("AC-08", "AC-30"), function() {
  # the weighting jobs before 1.2.0 refuse a weighted covariate still apart by the floor; 1.2.0 reads it (a verdict, the E-value, `limited`);
  # the enrolment-year row is 1.3.0's. The propensity weights of this data leave x1 apart: the old rule fires, the new one reads it.
  d <- .n33_data()
  cox <- function(version) vcr_test_run(.n62_at(.n33_job(d, paste0("n62a_cox", version), list(weighting = "propensity")), version))
  old <- cox("1.1.0"); mid <- cox("1.2.0"); cur <- cox("1.3.0")
  weight <- function(version, method = "comparator.propensity_weight") {
    inputs <- list(vcr_test_input(d$subj, paste0("snp_n62a_w", version, ":subject"), "subject"), vcr_test_input(d$ev, paste0("snp_n62a_w", version, ":events"), "event"))
    vcr_test_run(.n62_at(vcr_test_job(method, list(covariates = list("x1", "x2"), treatmentColumn = "arm", tau = 8, timeUnit = "months", endpoint = list(type = "time_to_event")),
                                      inputs, seed = 7L, replicates = 40L, job_id = paste0("job_n62a_w", version)), version))
  }
  w_old <- weight("1.1.0"); w_cur <- weight("1.3.0")
  refused <- function(r) identical(r$status, "not_estimable") && identical(r$notEstimableRule, "standardized_difference_above_floor")
  ok <- refused(old) && refused(w_old) &&
    identical(mid$status, "succeeded") && identical(cur$status, "succeeded") && identical(cur$conclusion, "limited") && identical(w_cur$status, "succeeded") &&
    # the old label has none of the keys a later release added; 1.2.0 has the verdict and the E-value and not the year; 1.3.0 is the current
    !.n62_has(old, "balanceVerdict") && !.n62_has(old, "eValue") && !.n62_has(old, "enrolmentYear") && is.null(old$diagnostics$thresholds$smdSevere) &&
    !.n62_has(w_old, "balanceVerdict") && !.n62_has(w_old, "enrolmentYear") && is.null(w_old$diagnostics$thresholds$smdSevere) &&
    .n62_has(mid, "balanceVerdict") && .n62_has(mid, "eValue") && !.n62_has(mid, "enrolmentYear") && !is.null(mid$diagnostics$thresholds$smdSevere) &&
    .n62_has(cur, "balanceVerdict") && .n62_has(cur, "eValue") && .n62_has(cur, "enrolmentYear")
  # dates in the event table: 1.2.0 still has no year row, 1.3.0 has it
  dd <- .n33_data(); dt <- .n56_dates(dd$subj); dd$ev$STARTDT <- dt$text
  dated <- function(version) vcr_test_run(.n62_at(.n33_job(dd, paste0("n62a_d", version), list(weighting = "entropy_balance")), version))
  d12 <- dated("1.2.0"); d13 <- dated("1.3.0"); d11 <- dated("1.1.0")
  ok <- ok && identical(d12$status, "succeeded") && !.n62_has(d12, "enrolmentYear") && identical(d13$diagnostics$enrolmentYear$status, "computed") &&
    identical(d11$status, "succeeded") && !.n62_has(d11, "enrolmentYear") && !.n62_measure(d11, "e_value") && !.n62_has(d11, "balanceVerdict")
  # the E-value of the risk ratio follows the estimate from 1.2.0 only
  set.seed(20261101L, kind = VCR_RNG_KIND)
  a <- .n35_gen()
  binary <- function(version) vcr_test_run(.n62_at(vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x1", "x2"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "binary")),
    list(vcr_test_input(a, paste0("snp_n62a_b", version, ":subject"), "subject")), seed = 11L, replicates = 20L, job_id = paste0("job_n62a_b", version)), version))
  b11 <- binary("1.1.0"); b12 <- binary("1.2.0"); b13 <- binary("1.3.0")
  ok <- ok && identical(b11$status, "succeeded") && !.n62_measure(b11, "e_value") && !.n62_has(b11, "eValue") && !.n62_has(b11, "balanceVerdict") &&
    .n62_measure(b12, "e_value") && .n62_has(b12, "eValue") && .n62_measure(b13, "e_value")
  list(pass = ok, detail = sprintf("weighted Cox and the weighting job at 1.1.0: %s/%s (%s), no verdict, E-value or year; 1.2.0: %s with verdict and E-value and no year; 1.3.0: %s/%s with the year; the risk-ratio E-value is 1.2.0's",
                                   old$status, w_old$status, old$notEstimableRule %||% "-", mid$status, cur$status, cur$conclusion))
})

vcr_case("N62b", c("AC-08", "AC-30"), function() {
  # the doubly robust job never refused on the balance: before 1.1.0 a covariate still apart said so in `limitedBy` and nothing else; 1.1.0 reads the
  # balance as a verdict, adds the E-value and the threshold; the year row is 1.2.0's
  d <- .n36_data(sel = 1, n = 1500L)
  job <- function(version) vcr_test_run(.n62_at(.n36_job(d, paste0("n62b", version), list(covariates = list("x1", "x2")), method = "comparator.aipw"), version))
  old <- job("1.0.0"); mid <- job("1.1.0"); cur <- job("1.2.0")
  ok <- identical(old$status, "succeeded") && identical(old$conclusion, "limited") && "standardized_difference_above_floor" %in% unlist(old$diagnostics$limitedBy) &&
    !.n62_has(old, "balanceVerdict") && !.n62_has(old, "eValue") && !.n62_has(old, "enrolmentYear") && is.null(old$diagnostics$thresholds$smdSevere) &&
    .n62_has(mid, "balanceVerdict") && .n62_has(mid, "eValue") && !.n62_has(mid, "enrolmentYear") && !is.null(mid$diagnostics$thresholds$smdSevere) &&
    .n62_has(cur, "enrolmentYear") && .n62_has(cur, "balanceVerdict")
  # a binary outcome: the E-value of the risk ratio is 1.1.0's
  set.seed(20261101L, kind = VCR_RNG_KIND)
  a <- .n35_gen()
  bin <- function(version) vcr_test_run(.n62_at(.n35_job(a, paste0("n62b_b", version)), version))
  b10 <- bin("1.0.0"); b11 <- bin("1.1.0")
  ok <- ok && !.n62_measure(b10, "e_value") && .n62_measure(b11, "e_value")
  list(pass = ok, detail = sprintf("AIPW at 1.0.0: %s/%s, limitedBy %s, no verdict/E-value/year; 1.1.0 adds the verdict and E-value; 1.2.0 the year",
                                   old$status, old$conclusion, paste(unlist(old$diagnostics$limitedBy), collapse = ",")))
})

vcr_case("N62c", c("AC-08", "AC-30"), function() {
  # a covariate-set comparison runs the base analysis at the release its own label stands for: at 1.1.0 the propensity weights that leave a
  # covariate apart are refused by the old rule (the set is not estimable), at 1.2.0 the set is read and `limited` by the verdict
  d <- .n36_data(sel = 1.8, n = 800L)
  sets <- .n36_sets(`both` = c("x1", "x2"), `x1 only` = "x1")
  job <- function(version, analysis) vcr_test_run(.n62_at(.n36_job(d, paste0("n62c", analysis, version), list(covariateSets = sets), analysis = analysis), version))
  p11 <- job("1.1.0", "propensity"); p12 <- job("1.2.0", "propensity")
  a11 <- job("1.1.0", "aipw"); a12 <- job("1.2.0", "aipw")
  codes <- function(r) unlist(lapply(r$diagnostics$sets, function(s) unlist(s$limitedBy)))
  ok <- identical(p11$status, "not_estimable") && identical(p11$diagnostics$sets[[2]]$status, "not_estimable") &&
    identical(p12$status, "succeeded") && identical(p12$diagnostics$sets[[2]]$status, "succeeded") && "standardized_difference_above_floor" %in% unlist(p12$diagnostics$sets[[2]]$limitedBy) &&
    # the doubly robust base never refused on the balance: its old notice is the same code as the verdict's at this size of imbalance
    identical(a11$status, "succeeded") && identical(a12$status, "succeeded") && "standardized_difference_above_floor" %in% codes(a11) && "standardized_difference_above_floor" %in% codes(a12)
  list(pass = ok, detail = sprintf("covariate sets, propensity weights, at 1.1.0: %s (set 2: %s); at 1.2.0: %s (set 2: %s, %s); doubly robust: %s/%s",
                                   p11$status, p11$diagnostics$sets[[2]]$status, p12$status, p12$diagnostics$sets[[2]]$status, paste(unlist(p12$diagnostics$sets[[2]]$limitedBy), collapse = ","), a11$status, a12$status))
})

vcr_case("N62d", c("AC-07", "AC-30"), function() {
  # the negative-control analysis before 1.1.0 refuses on the weighted balance and has no verdict; from 1.1.0 it reads it
  d <- .n37_dgp(1200L, 6L, 20261004L)
  sc <- list(covariates = list("x1", "x2"), treatmentColumn = "arm", weighting = "propensity",
             controls = lapply(sprintf("nc%02d", 1:6), function(cn) list(name = cn, column = cn)), primary = list(name = "primary", column = "primary"))
  job <- function(version) vcr_test_run(.n62_at(vcr_test_job("comparator.negative_control", sc, list(vcr_test_input(d, paste0("snp_n62d", version, ":subject"), "subject")),
                                                            seed = 11L, replicates = 40L, job_id = paste0("job_n62d", version)), version))
  old <- job("1.0.0"); cur <- job("1.1.0")
  ok <- !.n62_has(old, "balanceVerdict") && .n62_has(cur, "balanceVerdict") && is.null(old$diagnostics$balanceVerdict) &&
    identical(old$status, "succeeded") && identical(cur$status, "succeeded")
  list(pass = ok, detail = sprintf("negative controls at 1.0.0 carry no balance verdict (%s); at 1.1.0 they do (%s)", old$status, cur$status))
})

vcr_case("N62e", c("AC-03", "AC-27"), function() {
  # a reconstruction at 1.0.0 needs the risk table, lists the at-risk check always, and says nothing of information levels or a hazard-ratio status
  set.seed(17L, kind = VCR_RNG_KIND)
  d <- vcr_sim_tte(0L, 250L, vcr_dist_exponential_from_median(10), 1, list(kind = "uniform", duration = 6), 24)
  base <- .n17_arm(d, seq(0, 24, by = 6), 30)
  job <- function(version, scenario, id) vcr_test_run(.n62_at(vcr_test_job("evidence.reconstruct_km", c(scenario, list(provenance = .n17_prov)),
                                                                       list(list(kind = "evidence", id = "ev_km@1")), seed = 1L, job_id = id), version))
  full <- base[c("curve", "riskTable", "totalEvents", "reportedMedian")]
  old <- job("1.0.0", full, "job_n62e1"); cur <- job("1.1.0", full, "job_n62e2")
  no_table <- c(base[c("curve", "reportedMedian")], list(initialAtRisk = 250))
  old_none <- job("1.0.0", no_table, "job_n62e3"); cur_none <- job("1.1.0", no_table, "job_n62e4")
  ok <- identical(old$status, "succeeded") && !.n62_has(old, "informationLevel") && !.n62_has(old, "hazardRatio") &&
    identical(cur$status, "succeeded") && .n62_has(cur, "informationLevel") && identical(cur$conclusion, "estimable") &&
    # the 1.0.0 label does not read a paper without a risk table; 1.1.0 does, and says it is limited
    !identical(old_none$status, "succeeded") && identical(cur_none$status, "succeeded") && identical(cur_none$conclusion, "limited") &&
    all(c("atRisk") %in% names(old$diagnostics$qualityControl$checks))
  list(pass = ok, detail = sprintf("reconstruction at 1.0.0: %s, no level/hazard status; without a risk table: %s at 1.0.0, %s/%s at 1.1.0",
                                   old$status, old_none$status, cur_none$status, cur_none$conclusion))
})

vcr_case("N62f", c("AC-30", "AC-07"), function() {
  # the MAP prior at 1.0.0 states no borrowing table in its result; 1.1.0 does (and says `limited` when the engine's ceiling held the table below the request)
  hist <- list(events = list(140, 180, 90, 220, 110), n = list(1000, 1200, 800, 1500, 900))
  sc <- list(historical = hist, robustWeight = 0.2, operatingCharacteristics = list(nControl = 100, nTreatment = 100, drifts = list(0, 0.5), effect = 0.8))
  job <- function(version) vcr_test_run(.n62_at(vcr_test_job("comparator.map_prior", sc, seed = 21L, replicates = 1000L, job_id = paste0("job_n62f", version)), version))
  old <- job("1.0.0"); cur <- job("1.1.0")
  ok <- identical(old$status, "succeeded") && !.n62_has(old, "operatingCharacteristics") &&
    identical(cur$status, "succeeded") && identical(cur$conclusion, "estimable") && length(cur$diagnostics$operatingCharacteristics$rows) > 0L
  list(pass = ok, detail = sprintf("MAP prior at 1.0.0: %s, no operatingCharacteristics key; at 1.1.0: %s with %d rows", old$status, cur$conclusion %||% "-",
                                   length(cur$diagnostics$operatingCharacteristics$rows)))
})

vcr_case("N62g", c("AC-11", "AC-20"), function() {
  # the population jobs at 1.0.0: no statement about independence, no parameter-draw count on the literature job, the correlation among the
  # column sources only when a matrix was given
  tbl <- list(list(variable = "age", mean = 61, sd = 9), list(variable = "sbp", mean = 138, sd = 15, min = 100), list(variable = "male", proportion = 0.6))
  cor <- list(list(1, 0.3, 0), list(0.3, 1, 0), list(0, 0, 1))
  lit <- function(version, scenario, id) vcr_test_run(.n62_at(vcr_test_job("population.literature", c(list(baselineTable = tbl, n = 400L), scenario), seed = 2828L, job_id = id), version))
  l10 <- lit("1.0.0", list(), "job_n62g1"); l11 <- lit("1.1.0", list(), "job_n62g2"); c10 <- lit("1.0.0", list(correlation = cor, correlationSource = "assumed"), "job_n62g3")
  spec <- list(variables = list(list(name = "age", family = "normal", mean = 60, sd = 10, paramSd = list(mean = 2)), list(name = "sex", family = "bernoulli", prob = 0.5)))
  scn <- function(version) vcr_test_run(.n62_at(vcr_test_job("population.scenario", list(population = spec, n = 300L, parameterDraws = 3L), seed = 1010L, job_id = paste0("job_n62g_s", version)), version))
  s10 <- scn("1.0.0"); s11 <- scn("1.1.0")
  ok <- !.n62_has(l10, "parameterDraws") && identical(l10$diagnostics$correlationVerification, "assumed") && !("(correlation)" %in% names(l10$diagnostics$columnSources)) &&
    .n62_has(l11, "parameterDraws") && identical(l11$diagnostics$correlationVerification, "independence_assumed") && identical(l11$diagnostics$columnSources[["(correlation)"]], "assumed") &&
    "(correlation)" %in% names(c10$diagnostics$columnSources) &&
    !.n62_has(s10, "correlationVerification") && identical(s11$diagnostics$correlationVerification, "independence_assumed")
  list(pass = ok, detail = sprintf("literature population at 1.0.0: verification %s, no draws key, no correlation source without a matrix; at 1.1.0: %s; scenario population: %s at 1.1.0, none at 1.0.0",
                                   l10$diagnostics$correlationVerification, l11$diagnostics$correlationVerification, s11$diagnostics$correlationVerification))
})

vcr_case("N62h", c("AC-04", "AC-27"), function() {
  # the applied equation at 1.0.0 has no `localCalibration` key (it could not ask for one); 1.1.0 has the key, empty when nothing was asked
  run <- function(version, family) vcr_run_job(vcr_test_json(.n62_at(.n52_equation_job(family), version)))
  ok <- TRUE
  for (family in c("linear", "logistic", "cox")) {
    old <- run("1.0.0", family); cur <- run("1.1.0", family)
    ok <- ok && identical(old$status, "succeeded") && !.n62_has(old, "localCalibration") && identical(cur$status, "succeeded") && .n62_has(cur, "localCalibration") && is.null(cur$diagnostics$localCalibration)
  }
  list(pass = ok, detail = "the linear, logistic and Cox equations at 1.0.0 carry no localCalibration key; at 1.1.0 the key is there and empty when no outcome was named")
})

vcr_case("N62i", c("AC-04", "AC-27"), function() {
  # nothing of this remediation reaches a label that is not compatible: the table the control plane reads stays what it says
  d <- vcr_domain()$methods
  compat <- function(m) as.character(unlist(d[[m]]$compatibleVersions))
  ok <- identical(compat("comparator.entropy_balance"), c("1.0.0", "1.1.0", "1.2.0")) && identical(compat("comparator.propensity_weight"), c("1.0.0", "1.1.0", "1.2.0")) &&
    identical(compat("comparator.weighted_cox"), c("1.0.0", "1.1.0", "1.2.0")) && identical(compat("comparator.aipw"), c("1.0.0", "1.1.0")) &&
    identical(compat("comparator.covariate_sets"), c("1.0.0", "1.1.0")) && identical(compat("comparator.negative_control"), "1.0.0") &&
    identical(compat("evidence.reconstruct_km"), "1.0.0") && identical(compat("comparator.map_prior"), "1.0.0") &&
    identical(compat("population.scenario"), "1.0.0") && identical(compat("population.literature"), "1.0.0") && identical(compat("model.prognostic_apply"), "1.0.0") &&
    identical(compat("design.analytic"), "1.2.0") && identical(compat("design.simulate"), "1.2.0") && identical(compat("design.grid"), "1.2.0") &&
    identical(vcr_job_at_least(list(methodVersion = "1.1.0"), "1.2.0"), FALSE) && identical(vcr_job_at_least(list(methodVersion = "1.2.0"), "1.2.0"), TRUE) &&
    identical(vcr_job_at_least(list(methodVersion = "1.10.0"), "1.9.0"), TRUE) && identical(vcr_job_at_least(list(), "9.9.9"), TRUE)
  list(pass = ok, detail = "the compatible labels are the ones this case gates on; the comparison of labels is by version, not by text")
})
