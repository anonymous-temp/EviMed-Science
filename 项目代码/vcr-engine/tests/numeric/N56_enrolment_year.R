# N56 — the enrolment-year row of a comparison (remediation plan D6, 2026-11-01).
#
# When the field map named a time-zero date (the event table's STARTDT), the weighting, weighted Cox and AIPW jobs report the calendar
# year each person entered, per arm, and the standardized difference of it before and after the weights. The year is not a covariate:
# it sits beside the balance table and is not in the balance verdict. A data set with no date column has no row and no error; a date
# column nobody can read a year from is said as such and the estimate still stands.
#
# References that are not this method's own code: the means, the standardized differences (the ATT's: the trial arm's standard
# deviation) and the share of controls outside the trial's years, written again in base R from the same dates.
#
# Helpers: `.n33_data` and `.n33_job` (N33), `.n35_gen` and `.n35_job` (N35); files are sourced in name order.

# the same people with a time-zero date each: the trial enrolled in 2019-2021, the external control mostly earlier
.n56_dates <- function(subj, seed = 5L, trial = c(2019L, 2021L), control = c(2010L, 2021L), shape = "iso") {
  set.seed(seed, kind = VCR_RNG_KIND)
  # sample(2020L) is 1:2020, not the year 2020: a single year is repeated, never sampled
  draw <- function(range) { pool <- range[1]:range[2]; if (length(pool) == 1L) rep(pool, nrow(subj)) else sample(pool, nrow(subj), replace = TRUE) }
  year <- ifelse(subj$arm == 1L, draw(trial), draw(control))
  month <- sample(1:12, nrow(subj), replace = TRUE)
  list(year = year, text = switch(shape, iso = sprintf("%04d-%02d-15", year, month), us = sprintf("%02d/15/%04d", month, year), year = as.character(year)))
}

vcr_case("N56a", c("AC-08", "AC-30"), function() {
  # the weighted Cox job and the weighting job on the same dated data: every number of the row against base R
  d <- .n33_data()
  dt <- .n56_dates(d$subj)
  d$ev$STARTDT <- dt$text
  r <- vcr_test_run(.n33_job(d, "n56a", list(weighting = "entropy_balance")))
  row <- r$diagnostics$enrolmentYear
  treat <- d$subj$arm; y <- dt$year
  X <- as.matrix(d$subj[, c("x1", "x2")])
  w <- vcr_att_entropy_weights(X, treat, 1L)$allWeights
  s1 <- stats::sd(y[treat == 1L])
  smd0 <- (mean(y[treat == 1L]) - mean(y[treat == 0L])) / s1
  smd1 <- (stats::weighted.mean(y[treat == 1L], w[treat == 1L]) - stats::weighted.mean(y[treat == 0L], w[treat == 0L])) / s1
  out <- y[treat == 0L] < min(y[treat == 1L]) | y[treat == 0L] > max(y[treat == 1L])
  want_out <- mean(out); want_wout <- sum(w[treat == 0L][out]) / sum(w[treat == 0L])
  by <- row$byYear[[which(vapply(row$byYear, function(x) x$year == 2012, logical(1)))]]
  ok <- identical(r$status, "succeeded") && identical(row$status, "computed") && identical(row$column, "STARTDT") &&
    row$readable$treated == sum(treat == 1L) && row$readable$control == sum(treat == 0L) &&
    abs(row$treated$mean - mean(y[treat == 1L])) < 1e-12 && abs(row$control$mean - mean(y[treat == 0L])) < 1e-12 &&
    row$treated$min == min(y[treat == 1L]) && row$control$max == max(y[treat == 0L]) &&
    abs(row$smdUnadjusted - smd0) < 1e-9 && abs(row$smdAdjusted - smd1) < 1e-9 &&
    abs(row$controlOutsideTrialYears$share - want_out) < 1e-12 && abs(row$controlOutsideTrialYears$weightedShare - want_wout) < 1e-9 &&
    by$control == sum(y == 2012 & treat == 0L) && by$treated == 0L &&
    # the year is beside the balance table and not in it, and the verdict is the covariates'
    !("enrolment_year" %in% r$diagnostics$balance$covariate) && nrow(r$diagnostics$balance) == 2L &&
    length(vcr_validate_result(r)) == 0L
  # the weighting job reports the same row on the same data
  rw <- vcr_test_run(vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x1", "x2"), treatmentColumn = "arm", tau = 8, timeUnit = "months", endpoint = list(type = "time_to_event")),
    list(vcr_test_input(d$subj, "snp_n56a_w:subject", "subject"), vcr_test_input(d$ev, "snp_n56a_w:events", "event")), seed = 7L, replicates = 20L, job_id = "job_n56a_w"))
  ok <- ok && identical(rw$status, "succeeded") && identical(rw$diagnostics$enrolmentYear$status, "computed") &&
    abs(rw$diagnostics$enrolmentYear$smdAdjusted - smd1) < 1e-9
  list(pass = ok, detail = sprintf("trial mean year %.3f vs control %.3f; SMD %.4f -> %.4f (base R %.4f -> %.4f); %.1f%% of the controls (%.1f%% of their weight) enrolled outside the trial's years",
                                   row$treated$mean, row$control$mean, row$smdUnadjusted, row$smdAdjusted, smd0, smd1, 100 * want_out, 100 * want_wout))
})

vcr_case("N56b", c("AC-08", "AC-30"), function() {
  # no date column: no row and no error, in all three jobs; the numbers of the estimate are what they were without the step
  d <- .n33_data()
  r <- vcr_test_run(.n33_job(d, "n56b", list(weighting = "entropy_balance")))
  set.seed(20261101L, kind = VCR_RNG_KIND)
  a <- .n35_gen()
  ra <- vcr_test_run(.n35_job(a, "n56b_a"))
  rw <- vcr_test_run(vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x1", "x2"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "binary")),
    list(vcr_test_input(a, "snp_n56b_w:subject", "subject")), seed = 11L, replicates = 20L, job_id = "job_n56b_w"))
  ok <- identical(r$status, "succeeded") && is.null(r$diagnostics$enrolmentYear) &&
    identical(ra$status, "succeeded") && is.null(ra$diagnostics$enrolmentYear) &&
    identical(rw$status, "succeeded") && is.null(rw$diagnostics$enrolmentYear) &&
    length(vcr_validate_result(r)) == 0L && length(vcr_validate_result(ra)) == 0L && length(vcr_validate_result(rw)) == 0L
  list(pass = ok, detail = sprintf("weighted Cox, AIPW and weighting without STARTDT: statuses %s/%s/%s, no enrolmentYear key", r$status, ra$status, rw$status))
})

vcr_case("N56c", c("AC-08"), function() {
  # the spellings read are closed; a date is never guessed. A trial arm that entered in one year does not read as a difference of 0.
  yr <- .vcr_year_of(c("2015", "2015-03-02", "2015/3/2 10:00", "2015-03", "2015.03.02T08:30", "03/02/2015", "2/3/2015", "15-03-02", "March 2015", "1850", "2101", "", NA, "abc"))
  want <- c(2015L, 2015L, 2015L, 2015L, 2015L, 2015L, 2015L, NA, NA, NA, NA, NA, NA, NA)
  fmt_ok <- identical(yr, want)
  # a US-spelled column gives the same years as an ISO one
  d <- .n33_data(); dt <- .n56_dates(d$subj, shape = "us"); d$ev$STARTDT <- dt$text
  r <- vcr_test_run(.n33_job(d, "n56c", list(weighting = "entropy_balance")))
  us_ok <- identical(r$diagnostics$enrolmentYear$status, "computed") && abs(r$diagnostics$enrolmentYear$treated$mean - mean(dt$year[d$subj$arm == 1L])) < 1e-12
  # one trial year: the pooled standard deviation stands in (the ATT's own would be 0 and read as no difference)
  d1 <- .n33_data(); dt1 <- .n56_dates(d1$subj, trial = c(2020L, 2020L), control = c(2008L, 2014L), shape = "year"); d1$ev$STARTDT <- dt1$text
  r1 <- vcr_test_run(.n33_job(d1, "n56c1", list(weighting = "entropy_balance")))
  y <- dt1$year; t <- d1$subj$arm
  want_smd <- (mean(y[t == 1L]) - mean(y[t == 0L])) / stats::sd(y)
  one_ok <- identical(r1$diagnostics$enrolmentYear$status, "computed") && abs(r1$diagnostics$enrolmentYear$smdUnadjusted - want_smd) < 1e-9 && r1$diagnostics$enrolmentYear$smdUnadjusted > 1 &&
    abs(r1$diagnostics$enrolmentYear$controlOutsideTrialYears$share - 1) < 1e-12
  # a column of words: said as unreadable, and the estimate stands
  d2 <- .n33_data(); d2$ev$STARTDT <- "unknown"
  r2 <- vcr_test_run(.n33_job(d2, "n56c2", list(weighting = "entropy_balance")))
  bad_ok <- identical(r2$status, "succeeded") && identical(r2$diagnostics$enrolmentYear$status, "unreadable") && r2$diagnostics$enrolmentYear$readable$treated == 0L &&
    is.null(r2$diagnostics$enrolmentYear$smdAdjusted) && !is.null(vcr_get_measure(r2, "hazard_ratio") %||% vcr_get_measure(r2, "rmst_difference"))
  list(pass = fmt_ok && us_ok && one_ok && bad_ok,
       detail = sprintf("spellings %s; US spelling %s; one trial year SMD %.3f against base R %.3f; a column of words: %s", fmt_ok, us_ok,
                        r1$diagnostics$enrolmentYear$smdUnadjusted, want_smd, r2$diagnostics$enrolmentYear$status))
})
