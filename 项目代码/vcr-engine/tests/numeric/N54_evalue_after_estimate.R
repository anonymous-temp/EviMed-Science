# N54 — the E-value that follows a comparative estimate (remediation plan A5, 2026-11-01).
#
# A hazard ratio of the weighted Cox job, a risk ratio of the weighting job and of the AIPW job (binary outcomes) carry their E-value
# and the E-value of the confidence limit nearer the null, computed after the estimate and beside it. The numbers are the EValue
# package's, on the ratio and the interval the job itself reports, and the job's own estimate is exactly what it was without the
# step: the E-value can only add. A continuous outcome and an RMST difference have no ratio, and the result says so instead of
# inventing one.
#
# Helpers: `.n33_data` and `.n33_job` (N33), `.n35_gen` and `.n35_job` (N35); files are sourced in name order.

vcr_case("N54a", c("AC-12", "AC-30"), function() {
  suppressMessages({library(EValue); library(survival)})
  d <- .n33_data()
  r <- vcr_test_run(.n33_job(d, "n54a", list(weighting = "entropy_balance")))
  hr <- vcr_get_measure(r, "hazard_ratio")
  rare <- mean(1L - d$ev$CNSR) < 0.15
  lo <- hr$interval$low; hi <- hr$interval$high
  pk <- EValue::evalues.HR(hr$value, lo = lo, hi = hi, rare = rare)
  want_p <- unname(pk["E-values", "point"])
  want_l <- unname(pk["E-values", if (hr$value >= 1) "lower" else "upper"])
  got_p <- vcr_measure_value(r, "e_value"); got_l <- vcr_measure_value(r, "e_value_confidence_limit")
  # the same hazard ratio through the standalone job: one implementation, two doors
  alone <- vcr_test_run(vcr_test_job("comparator.evalue",
    list(riskRatio = hr$value, confidenceLimit = if (hr$value >= 1) lo else hi, scale = "hazard_ratio", rare = rare), seed = 1L, job_id = "job_n54a_alone"))
  ev <- r$diagnostics$eValue
  ok <- identical(r$status, "succeeded") && is.finite(got_p) && abs(got_p - want_p) < 1e-6 && abs(got_l - want_l) < 1e-6 &&
    abs(got_p - vcr_measure_value(alone, "e_value")) < 1e-12 && abs(got_l - vcr_measure_value(alone, "e_value_confidence_limit")) < 1e-12 &&
    isTRUE(ev$available) && identical(ev$scale, "hazard_ratio") && identical(isTRUE(ev$rare), rare) &&
    grepl("not evidence that none exists", ev$note, fixed = TRUE) && length(vcr_validate_result(r)) == 0L
  list(pass = ok, detail = sprintf("weighted Cox HR %.4f [%.4f, %.4f] (rare outcome: %s): E-value %.5f vs EValue %.5f, limit %.5f vs %.5f; the standalone job agrees to %.1e",
                                   hr$value, lo, hi, rare, got_p, want_p, got_l, want_l, abs(got_p - vcr_measure_value(alone, "e_value"))))
})

vcr_case("N54b", c("AC-08", "AC-30"), function() {
  suppressMessages(library(EValue))
  # the weighting job's risk ratio and the AIPW job's, on binary outcomes; a continuous outcome and an RMST difference have none
  set.seed(20261101L, kind = VCR_RNG_KIND)
  d <- .n35_gen()
  inp <- vcr_test_input(d, "snp_n54b:subject", "subject")
  w <- vcr_test_run(vcr_test_job("comparator.entropy_balance",
    list(covariates = list("x1", "x2"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "binary")), list(inp), seed = 11L, replicates = 20L, job_id = "job_n54b_w"))
  a <- vcr_test_run(.n35_job(d, "n54b_a"))
  one <- function(r, name) {
    m <- vcr_get_measure(r, name)
    pk <- EValue::evalues.RR(m$value, lo = m$interval$low, hi = m$interval$high)
    c(got = vcr_measure_value(r, "e_value"), want = unname(pk["E-values", "point"]),
      got_l = vcr_measure_value(r, "e_value_confidence_limit"), want_l = unname(pk["E-values", if (m$value >= 1) "lower" else "upper"]))
  }
  ew <- one(w, "weighted_risk_ratio"); ea <- one(a, "aipw_risk_ratio")
  dc <- d; dc$y <- 1 + 0.5 * d$x1 + 0.3 * d$x2 + stats::rnorm(nrow(d)) + 0.7 * d$arm
  cont <- vcr_test_run(.n35_job(dc, "n54b_c", endpoint = "continuous"))
  # the estimate with the step and the E-value alone: a job's own numbers are what they were (the AIPW difference equals the
  # by-hand case of N35a, which does not read the E-value)
  ok <- identical(w$status, "succeeded") && identical(a$status, "succeeded") &&
    abs(ew[["got"]] - ew[["want"]]) < 1e-6 && abs(ew[["got_l"]] - ew[["want_l"]]) < 1e-6 &&
    abs(ea[["got"]] - ea[["want"]]) < 1e-6 && abs(ea[["got_l"]] - ea[["want_l"]]) < 1e-6 &&
    identical(cont$status, "succeeded") && is.null(vcr_get_measure(cont, "e_value")) && isFALSE(cont$diagnostics$eValue$available) &&
    identical(cont$diagnostics$eValue$reason, "continuous_outcome") && length(vcr_validate_result(a)) == 0L && length(vcr_validate_result(w)) == 0L
  list(pass = ok, detail = sprintf("weighting RR: E-value %.5f vs %.5f (limit %.5f vs %.5f); AIPW RR: %.5f vs %.5f (limit %.5f vs %.5f); continuous outcome: no E-value, reason %s",
                                   ew[["got"]], ew[["want"]], ew[["got_l"]], ew[["want_l"]], ea[["got"]], ea[["want"]], ea[["got_l"]], ea[["want_l"]],
                                   cont$diagnostics$eValue$reason %||% "NULL"))
})

vcr_case("N54c", c("AC-30"), function() {
  # The step can only add. A ratio that cannot be used (not positive, not finite) and an interval that is missing return nothing
  # and raise nothing; a limit on the far side of the estimate is dropped and the point E-value stays; a limit that includes the
  # null is an E-value of 1.
  none <- list(vcr_evalue_after(-1), vcr_evalue_after(0), vcr_evalue_after(NA_real_), vcr_evalue_after(Inf), vcr_evalue_after(2, scale = "bogus"))
  far <- vcr_evalue_after(2, low = 3, high = 4, scale = "risk_ratio")
  inc <- vcr_evalue_after(1.4, low = 0.9, high = 2.1, scale = "risk_ratio")
  inv <- vcr_evalue_after(0.5, low = 0.3, high = 0.8, scale = "risk_ratio")
  v <- function(x, name) { m <- Filter(function(z) identical(z$name, name), x$measures); if (length(m)) m[[1]]$value else NA_real_ }
  ok <- all(vapply(none, is.null, logical(1))) &&
    is.finite(v(far, "e_value")) && is.na(v(far, "e_value_confidence_limit")) && is.null(far$diagnostics$confidenceLimit) &&
    abs(v(inc, "e_value_confidence_limit") - 1) < 1e-12 && abs(v(inv, "e_value") - (2 + sqrt(2))) < 1e-12 &&
    abs(v(inv, "e_value_confidence_limit") - (1 / 0.8 + sqrt(1 / 0.8 * (1 / 0.8 - 1)))) < 1e-12
  list(pass = ok, detail = sprintf("unusable ratios return NULL (%d/5); a far-side limit is dropped; an interval that includes the null gives %.1f; RR 0.5 gives %.5f (2 + sqrt 2)",
                                   sum(vapply(none, is.null, logical(1))), v(inc, "e_value_confidence_limit"), v(inv, "e_value")))
})
