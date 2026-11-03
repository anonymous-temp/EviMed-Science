# N60 — local calibration of an applied published model (remediation plan D3, 2026-11-01).
#
# model.prognostic_apply 1.1.0: when the scenario names the outcome the table itself holds, the applied equation is held against what
# happened and the result reports the calibration intercept (the shift of the linear predictor with its slope held at 1) and slope
# (the coefficient of the linear predictor), each with a Wald interval, beside the observed and the predicted risk and their difference
# (calibrationInLarge, the name the forecast evaluation uses). With too few events or non-events the intercept stands alone and the
# result says what the slope needed; with none of one kind there is no intercept either. A synthetic outcome calibrates nothing and is refused.
#
# References that are not this method's own code: the logistic intercept and slope are maximised again from the log-likelihood with
# `stats::optim` (BFGS) and their standard errors read from its numerical Hessian, not from `glm`; the linear ones are the textbook
# formulas (mean residual, and the least-squares slope by cov/var); the time-to-event observed risk is the Kaplan-Meier estimate of
# `survival::survfit` and its slope `survival::coxph` on the score.

.n60_data <- function(n = 2000L, seed = 20261101L, shift = 0.4, slope = 0.8, truth_slope = 1) {
  set.seed(seed, kind = VCR_RNG_KIND)
  age <- stats::rnorm(n, 62, 10)
  # the truth: logit p = -1 + 0.04 (age - 60); the published equation is miscalibrated by `shift` and its slope scaled by `slope`
  truth <- -1 + truth_slope * 0.04 * (age - 60)
  y <- stats::rbinom(n, 1L, stats::plogis(truth))
  data.frame(USUBJID = sprintf("P%05d", seq_len(n)), age = age, y = y, stringsAsFactors = FALSE)
}

.n60_job <- function(d, id, family = "logistic", intercept = -1 + 0.4, coefficient = 0.04 * 0.8, calibration = list(outcomeColumn = "y"), source = "observed", extra = list()) {
  input <- vcr_test_input(d, paste0("snp_", id, ":subject"), "subject", source = source)
  term <- list(column = "age", coefficient = coefficient, transform = "identity", unit = "years", center = 60, scale = 1)
  model <- list(family = family, terms = list(term))
  if (family != "cox") model$intercept <- intercept
  if (family == "linear") model$residualSd <- 2
  if (family == "cox") model$baseline <- list(reference = "centered", survival = 0.8, horizon = 12, timeUnit = "months")
  sc <- list(inputId = input$id, idColumn = "USUBJID", sourceCondition = "control",
             endpoint = list(type = switch(family, linear = "continuous", logistic = "binary", cox = "time_to_event"), horizon = 12, timeUnit = "months"),
             inputUnits = list(age = "years"), model = model)
  if (!is.null(calibration)) sc$calibration <- calibration
  vcr_test_job("model.prognostic_apply", utils::modifyList(sc, extra), list(input), job_id = paste0("job_", id))
}

vcr_case("N60a", c("AC-08", "AC-30"), function() {
  d <- .n60_data()
  r <- vcr_test_run(.n60_job(d, "n60a"))
  cal <- r$diagnostics$localCalibration
  lp <- -1 + 0.4 + 0.04 * 0.8 * (d$age - 60); p <- stats::plogis(lp)
  # the log-likelihood of a + b * lp maximised by hand; the Hessian is numerical
  nll <- function(th) -sum(d$y * (th[1] + th[2] * lp) - log1p(exp(th[1] + th[2] * lp)))
  full <- stats::optim(c(0, 1), nll, method = "BFGS", hessian = TRUE, control = list(reltol = 1e-14, maxit = 1000))
  se_full <- sqrt(diag(solve(full$hessian)))
  nll0 <- function(a) -sum(d$y * (a + lp) - log1p(exp(a + lp)))
  off <- stats::optim(0, nll0, method = "BFGS", hessian = TRUE, control = list(reltol = 1e-14, maxit = 1000))
  se_off <- sqrt(1 / off$hessian[1, 1])
  ok <- identical(r$status, "succeeded") && identical(r$conclusion, "limited") && cal$n == 2000L && cal$events == sum(d$y) && cal$nonEvents == sum(1 - d$y) &&
    abs(cal[["intercept"]]$value - off$par) < 2e-5 && abs(cal[["intercept"]]$se - se_off) < 2e-4 &&
    abs(cal[["slope"]]$value - full$par[2]) < 2e-4 && abs(cal[["slope"]]$se - se_full[2]) < 5e-4 &&
    abs(cal[["intercept"]]$low - (cal[["intercept"]]$value - stats::qnorm(0.975) * cal[["intercept"]]$se)) < 1e-12 &&
    abs(cal[["observedRisk"]] - mean(d$y)) < 1e-12 && abs(cal$predictedRisk - mean(p)) < 1e-12 && abs(cal[["calibrationInLarge"]] - (mean(p) - mean(d$y))) < 1e-12 &&
    abs(vcr_measure_value(r, "calibration_intercept") - cal[["intercept"]]$value) < 1e-12 && abs(vcr_measure_value(r, "calibration_slope") - cal[["slope"]]$value) < 1e-12 &&
    is.null(cal[["slopeUnavailable"]]) && length(vcr_validate_result(r)) == 0L &&
    grepl("Calibration was measured on the observed outcomes of this table", r$diagnostics$limits[[1]], fixed = TRUE)
  # the equation is miscalibrated by construction (an intercept 0.4 too high, so the calibration intercept is negative, and a slope of 0.8 against the truth's 1, so the calibration slope is above 1): the result sees both
  sees <- cal[["intercept"]]$value < -0.1 && cal[["intercept"]]$value > -0.6 && cal[["slope"]]$value > 1.05 && cal[["slope"]]$value < 1.45 && cal[["intercept"]]$high < 0
  # and an equation that IS the truth is calibrated within its own intervals
  d2 <- .n60_data(truth_slope = 1)
  right <- vcr_test_run(.n60_job(d2, "n60a2", intercept = -1, coefficient = 0.04))
  cr <- right$diagnostics$localCalibration
  calibrated <- cr[["intercept"]]$low < 0 && cr[["intercept"]]$high > 0 && cr[["slope"]]$low < 1 && cr[["slope"]]$high > 1
  list(pass = ok && sees && calibrated,
       detail = sprintf("intercept %.5f (optim %.5f, se %.5f vs %.5f), slope %.5f (optim %.5f, se %.5f vs %.5f), observed %.4f against predicted %.4f; the truth itself: intercept %.3f [%.3f, %.3f], slope %.3f [%.3f, %.3f]",
                        cal[["intercept"]]$value, off$par, cal[["intercept"]]$se, se_off, cal[["slope"]]$value, full$par[2], cal[["slope"]]$se, se_full[2], cal[["observedRisk"]], cal$predictedRisk,
                        cr[["intercept"]]$value, cr[["intercept"]]$low, cr[["intercept"]]$high, cr[["slope"]]$value, cr[["slope"]]$low, cr[["slope"]]$high))
})

vcr_case("N60b", c("AC-08", "AC-30"), function() {
  # too few events or non-events: the intercept alone and what the slope needed; none of one kind: no intercept (it is infinite) and the reason
  d <- .n60_data(n = 600L)
  few <- d; few$y <- 0L; few$y[order(few$age, decreasing = TRUE)[1:6]] <- 1L          # six events
  r6 <- vcr_test_run(.n60_job(few, "n60b6")); c6 <- r6$diagnostics$localCalibration
  none <- d; none$y <- 0L
  r0 <- vcr_test_run(.n60_job(none, "n60b0")); c0 <- r0$diagnostics$localCalibration
  all1 <- d; all1$y <- 1L
  r1 <- vcr_test_run(.n60_job(all1, "n60b1")); c1 <- r1$diagnostics$localCalibration
  nine <- d; nine$y <- 0L; nine$y[1:9] <- 1L
  r9 <- vcr_test_run(.n60_job(nine, "n60b9")); c9 <- r9$diagnostics$localCalibration
  ten <- d; ten$y <- 0L; ten$y[1:10] <- 1L
  r10 <- vcr_test_run(.n60_job(ten, "n60b10")); c10 <- r10$diagnostics$localCalibration
  floors <- vcr_domain()$limits$localCalibration
  ok <- is.finite(c6[["intercept"]]$value) && is.null(c6[["slope"]]) && identical(c6[["slopeUnavailable"]], "too_few_events") && c6$slopeNeeds$events == 10L && c6$events == 6L &&
    is.null(vcr_get_measure(r6, "calibration_slope")) && !is.null(vcr_get_measure(r6, "calibration_intercept")) &&
    is.null(c0[["intercept"]]) && identical(c0[["interceptUnavailable"]], "no_events") && is.finite(c0[["observedRisk"]]) && c0[["observedRisk"]] == 0 && is.null(vcr_get_measure(r0, "calibration_intercept")) &&
    is.null(c1[["intercept"]]) && identical(c1[["interceptUnavailable"]], "no_non_events") && identical(c1[["slopeUnavailable"]], "no_non_events") &&
    is.null(c9[["slope"]]) && identical(c9[["slopeUnavailable"]], "too_few_events") && !is.null(c9[["intercept"]]) &&
    !is.null(c10[["slope"]]) && is.null(c10[["slopeUnavailable"]]) &&
    floors$slopeEvents == 10L && floors$slopeNonEvents == 10L && identical(r0$status, "succeeded") && identical(r0$conclusion, "limited") &&
    all(vapply(list(r6, r0, r1, r9, r10), function(r) length(vcr_validate_result(r)) == 0L, logical(1)))
  list(pass = ok, detail = sprintf("6 events: intercept %.3f and no slope (%s, needs %d events); no event: no intercept (%s), observed risk %.0f; no non-event: %s; 9 events: no slope; 10 events: slope %.3f; floors %d events / %d non-events",
                                   c6[["intercept"]]$value, c6[["slopeUnavailable"]], c6$slopeNeeds$events, c0[["interceptUnavailable"]], c0[["observedRisk"]], c1[["interceptUnavailable"]], c10[["slope"]]$value, floors$slopeEvents, floors$slopeNonEvents))
})

vcr_case("N60c", c("AC-08", "AC-30"), function() {
  # a continuous outcome: the intercept is the mean residual and the slope the least-squares coefficient, by their textbook formulas
  set.seed(60L, kind = VCR_RNG_KIND)
  n <- 400L; age <- stats::rnorm(n, 62, 10)
  y <- 3 + 0.05 * (age - 60) * 1.4 + stats::rnorm(n, 0, 2)
  d <- data.frame(USUBJID = sprintf("L%04d", seq_len(n)), age = age, y = y)
  r <- vcr_test_run(.n60_job(d, "n60c", family = "linear", intercept = 2.5, coefficient = 0.05, calibration = list(outcomeColumn = "y")))
  cal <- r$diagnostics$localCalibration
  pred <- 2.5 + 0.05 * (age - 60)
  res <- y - pred; se0 <- stats::sd(res) / sqrt(n)
  b <- stats::cov(pred, y) / stats::var(pred); a <- mean(y) - b * mean(pred)
  resid <- y - (a + b * pred); se_b <- sqrt(sum(resid^2) / (n - 2) / sum((pred - mean(pred))^2))
  tq <- stats::qt(0.975, n - 1L); tq2 <- stats::qt(0.975, n - 2L)
  ok <- identical(r$status, "succeeded") && abs(cal[["intercept"]]$value - mean(res)) < 1e-12 && abs(cal[["intercept"]]$se - se0) < 1e-12 &&
    abs(cal[["intercept"]]$low - (mean(res) - tq * se0)) < 1e-12 && abs(cal[["slope"]]$value - b) < 1e-10 && abs(cal[["slope"]]$se - se_b) < 1e-10 &&
    abs(cal[["slope"]]$high - (b + tq2 * se_b)) < 1e-10 && abs(cal[["calibrationInLarge"]] - (mean(pred) - mean(y))) < 1e-12 &&
    cal[["slope"]]$value > 1.1 && length(vcr_validate_result(r)) == 0L
  # too few pairs: the intercept alone
  r5 <- vcr_test_run(.n60_job(d[1:6, ], "n60c6", family = "linear", intercept = 2.5, coefficient = 0.05, calibration = list(outcomeColumn = "y")))
  c5 <- r5$diagnostics$localCalibration
  ok <- ok && !is.null(c5[["intercept"]]) && is.null(c5[["slope"]]) && identical(c5[["slopeUnavailable"]], "too_few_pairs") && c5$slopeNeeds$pairs == 10L
  list(pass = ok, detail = sprintf("n %d: intercept %.5f (mean residual %.5f), slope %.5f (cov/var %.5f, se %.5f); 6 pairs: intercept only (%s)",
                                   n, cal[["intercept"]]$value, mean(res), cal[["slope"]]$value, b, cal[["slope"]]$se, c5[["slopeUnavailable"]]))
})

vcr_case("N60d", c("AC-08", "AC-30"), function() {
  suppressMessages(library(survival))
  # a time-to-event outcome: the Kaplan-Meier risk at the horizon against the mean predicted risk, and the Cox coefficient of the score
  set.seed(61L, kind = VCR_RNG_KIND)
  n <- 600L; age <- stats::rnorm(n, 62, 10)
  # the centered Cox equation S(12 | x) = 0.8 ^ exp(0.04 * 0.8 * (age - 60)); the truth has twice the 12-month baseline hazard and a steeper slope
  true_h <- -log(0.8) * 2 * exp(0.04 * 1.2 * (age - 60)) / 12
  t_ev <- stats::rexp(n, true_h); cens <- stats::runif(n, 6, 30)
  d <- data.frame(USUBJID = sprintf("C%04d", seq_len(n)), age = age, time = pmin(t_ev, cens), status = as.integer(t_ev <= cens))
  r <- vcr_test_run(.n60_job(d, "n60d", family = "cox", calibration = list(timeColumn = "time", statusColumn = "status")))
  cal <- r$diagnostics$localCalibration
  score <- 0.04 * 0.8 * (age - 60)
  km <- survfit(Surv(d$time, d$status) ~ 1); s12 <- summary(km, times = 12, extend = TRUE)$surv
  cx <- coxph(Surv(time, status) ~ score, data = cbind(d, score = score))
  pred <- 1 - 0.8^exp(score)
  ok <- identical(r$status, "succeeded") && abs(cal[["observedRisk"]] - (1 - s12)) < 1e-10 && abs(cal$predictedRisk - mean(pred)) < 1e-12 &&
    abs(cal[["calibrationInLarge"]] - (mean(pred) - (1 - s12))) < 1e-10 && abs(cal[["slope"]]$value - unname(coef(cx))) < 1e-5 && abs(cal[["slope"]]$se - sqrt(vcov(cx)[1, 1])) < 1e-5 &&
    identical(cal[["interceptUnavailable"]], "not_defined_for_time_to_event") && cal$events == sum(d$status) && cal[["slope"]]$value > 1.2 &&
    cal[["calibrationInLarge"]] < -0.05 && length(vcr_validate_result(r)) == 0L
  # few events: the in-the-large alone; a score with no baseline: the slope only
  few <- d; few$status <- 0L; few$status[order(few$time)[1:4]] <- 1L
  rf <- vcr_test_run(.n60_job(few, "n60df", family = "cox", calibration = list(timeColumn = "time", statusColumn = "status")))
  cf <- rf$diagnostics$localCalibration
  nb <- .n60_job(d, "n60dn", family = "cox", calibration = list(timeColumn = "time", statusColumn = "status")); nb$scenario$model$baseline <- NULL
  rn <- vcr_test_run(nb); cn <- rn$diagnostics$localCalibration
  ok <- ok && is.null(cf[["slope"]]) && identical(cf[["slopeUnavailable"]], "too_few_events") && cf$events == 4L && !is.null(cf[["calibrationInLarge"]]) &&
    identical(cn$observedRiskUnavailable, "no_baseline_risk") && is.null(cn[["calibrationInLarge"]]) && !is.null(cn[["slope"]]) && abs(cn[["slope"]]$value - cal[["slope"]]$value) < 1e-9
  list(pass = ok, detail = sprintf("observed 12-month risk %.5f (survfit %.5f) against predicted %.5f: in the large %.4f; slope %.5f (coxph %.5f); 4 events: in-the-large only; no baseline: slope %.4f and no absolute risk (%s)",
                                   cal[["observedRisk"]], 1 - s12, cal$predictedRisk, cal[["calibrationInLarge"]], cal[["slope"]]$value, unname(coef(cx)), cn[["slope"]]$value, cn$observedRiskUnavailable))
})

vcr_case("N60e", c("AC-04", "AC-27"), function() {
  # a synthetic outcome calibrates nothing, a wrong outcome column is named, a version that did not have calibration cannot be asked for it,
  # and a job without the block is exactly what it was
  d <- .n60_data(n = 300L)
  syn <- vcr_test_run(.n60_job(d, "n60e1", source = "synthetic"))
  missing_col <- vcr_test_run(.n60_job(d, "n60e2", calibration = list(outcomeColumn = "nope")))
  not01 <- d; not01$y <- not01$y * 2L
  bad01 <- vcr_test_run(.n60_job(not01, "n60e3"))
  old <- .n60_job(d, "n60e4"); old$methodVersion <- "1.0.0"
  old_issues <- vapply(vcr_validate_job(vcr_test_json(old)), function(i) paste0(i$code, "@", i$field), character(1))
  plain <- .n60_job(d, "n60e5", calibration = NULL); plain$methodVersion <- "1.0.0"
  plain_run <- vcr_test_run(plain)
  none <- vcr_test_run(.n60_job(d, "n60e6", calibration = NULL))
  ok <- identical(syn$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(syn) &&
    identical(missing_col$status, "failed") && identical(bad01$status, "failed") &&
    "method_version_mismatch@methodVersion" %in% old_issues &&
    identical(plain_run$status, "succeeded") && is.null(plain_run$diagnostics$localCalibration) && is.null(vcr_get_measure(plain_run, "calibration_intercept")) &&
    grepl("Transportability and calibration in this target population have not been established.", plain_run$diagnostics$limits[[1]], fixed = TRUE) &&
    identical(none$status, "succeeded") && is.null(none$diagnostics$localCalibration)
  list(pass = ok, detail = sprintf("synthetic outcome %s, missing column %s, outcome of 0/2 %s; a 1.0.0 job asking for calibration -> %s; a 1.0.0 job without it replays with its old limit sentence", syn$status, missing_col$status, bad01$status,
                                   paste(old_issues, collapse = ",")))
})
