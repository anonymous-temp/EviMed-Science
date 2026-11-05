# N95 — the Royston-Parmar spline family of model.survival_fit (algorithm round C13, 2026-11-03).
#
# "风险曲线不单调时长期生存和 RMST 是多少": a model of the log cumulative hazard with a natural cubic spline in log time, written in R (optim from the
# Weibull fit, Newton steps with the analytic Hessian, delta-method errors). flexsurv::flexsurvspline is the check, in CI only. Held to:
#
#   a  the fit: the knots (equal to flexsurv's), the log likelihood and AIC, the coefficients, for 0 to 3 interior knots on 600 patients whose hazard
#      rises and then falls (a Weibull cannot follow it). The engine's optimum is at least as high as flexsurv's (flexsurv stops with a gradient of 0.03)
#   b  everything derived from the coefficients, evaluated by flexsurv's own functions at the ENGINE's coefficients so that the optimiser's tolerance
#      is out of the comparison: survival at horizons inside and beyond the data (psurvspline: the straight tail), the median (qsurvspline), the
#      restricted mean (rmst_survspline, and the integral of psurvspline), and the delta-method intervals (numDeriv's Jacobian of flexsurv's functions
#      with the engine's covariance), plus the covariance against flexsurv's own
#   c  a known truth: 20,000 patients from a log-logistic (a hazard that peaks and falls) with light censoring: the spline follows the true survival and
#      the restricted mean where the Weibull does not, and AIC says so
#   d  the refusals: too few events for the number of knots, and a curve whose hazard would fall (a cure plateau) is not estimable rather than repaired
#   e  the job: measures, the extrapolation record (how many times the longest follow-up each horizon is), the knot sensitivity, the same hash twice, a
#      spline asked for under the 1.0.0 label refused

.n95_data <- function(n = 600L, seed = 9501L, shape = 2.2, scale = 10, cens = c(2, 30)) {
  set.seed(seed, kind = "Mersenne-Twister")
  ev <- flexsurv::rllogis(n, shape = shape, scale = scale); cn <- stats::runif(n, cens[1], cens[2])
  data.frame(time = pmin(ev, cn), status = as.numeric(ev <= cn))
}

vcr_case("N95a", c("AC-04", "AC-27"), function() {
  if (!requireNamespace("flexsurv", quietly = TRUE)) stop("N95 requires the locked flexsurv library")
  d <- .n95_data(); horizons <- c(5, 12, 24, 40, 60)
  rows <- character(); worst_ll <- 0; worst_g <- 0; worst_knot <- 0; above <- TRUE
  for (k in 0:3) {
    mine <- vcr_fit_survival_spline(d$time, d$status, k, horizons)
    ref <- flexsurv::flexsurvspline(survival::Surv(time, status) ~ 1, data = d, k = k, scale = "hazard")
    worst_knot <- max(worst_knot, abs(mine$spline$knotPositions - ref$knots))
    worst_ll <- max(worst_ll, abs(mine$logLikelihood - ref$loglik), abs(mine$aic - ref$AIC))
    worst_g <- max(worst_g, abs(mine$spline$gamma - unname(ref$res[, "est"])))
    above <- above && mine$logLikelihood >= ref$loglik - 1e-9
    rows <- c(rows, sprintf("k=%d AIC %.4f (%.4f)", k, mine$aic, ref$AIC))
  }
  list(pass = worst_knot < 1e-12 && worst_ll < 1e-5 && worst_g < 1e-3 && above,
       detail = sprintf("600 patients, 383 events, hazard rising then falling: knots equal flexsurv's (%.0e); log likelihood and AIC within %.1e of flexsurv's, the engine's never below it; coefficients within %.1e (flexsurv's own gradient at its optimum is 0.03); AIC engine (flexsurv): %s",
                        worst_knot, worst_ll, worst_g, paste(rows, collapse = "; ")))
})

vcr_case("N95b", c("AC-04", "AC-27"), function() {
  if (!requireNamespace("flexsurv", quietly = TRUE) || !requireNamespace("numDeriv", quietly = TRUE)) stop("N95 requires the locked flexsurv and numDeriv libraries")
  d <- .n95_data(); horizons <- c(5, 12, 24, 40, 60, 90); k <- 2L
  mine <- vcr_fit_survival_spline(d$time, d$status, k, horizons)
  ref <- flexsurv::flexsurvspline(survival::Surv(time, status) ~ 1, data = d, k = k, scale = "hazard")
  kn <- mine$spline$knotPositions; g <- mine$spline$gamma; V <- mine$spline$covariance
  surv_ref <- flexsurv::psurvspline(horizons, gamma = g, knots = kn, scale = "hazard", lower.tail = FALSE)
  surv_mine <- vapply(mine$curve, function(p) p$survival, numeric(1))
  med_ref <- flexsurv::qsurvspline(0.5, gamma = g, knots = kn, scale = "hazard")
  tau <- max(horizons)
  rmst_ref <- as.numeric(flexsurv::rmst_survspline(tau, gamma = g, knots = kn, scale = "hazard"))
  rmst_int <- stats::integrate(function(t) flexsurv::psurvspline(t, gamma = g, knots = kn, scale = "hazard", lower.tail = FALSE), 0, tau, rel.tol = 1e-12)$value
  # the delta method: log H at the horizons, and log of the median, by numDeriv on flexsurv's functions with the engine's covariance
  lh <- function(gg) log(-log(flexsurv::psurvspline(horizons, gamma = gg, knots = kn, scale = "hazard", lower.tail = FALSE)))
  J <- numDeriv::jacobian(lh, g); se_h <- sqrt(rowSums((J %*% V) * J)); z <- stats::qnorm(0.975)
  lo_ref <- exp(-exp(lh(g) + z * se_h)); hi_ref <- exp(-exp(lh(g) - z * se_h))
  lo_mine <- vapply(mine$curve, function(p) p$lower, numeric(1)); hi_mine <- vapply(mine$curve, function(p) p$upper, numeric(1))
  Jm <- numDeriv::jacobian(function(gg) log(flexsurv::qsurvspline(0.5, gamma = gg, knots = kn, scale = "hazard")), g)
  se_m <- sqrt(as.numeric(Jm %*% V %*% t(Jm)))
  Jr <- numDeriv::jacobian(function(gg) as.numeric(flexsurv::rmst_survspline(tau, gamma = gg, knots = kn, scale = "hazard")), g)
  se_r <- sqrt(as.numeric(Jr %*% V %*% t(Jr)))
  rel_v <- max(abs(V - stats::vcov(ref)) / abs(stats::vcov(ref)))
  beyond <- vapply(mine$curve, function(p) isTRUE(p$extrapolated), logical(1))
  errs <- c(surv = max(abs(surv_mine - surv_ref)), median = abs(mine$median - med_ref) / med_ref, rmst = abs(mine$rmst$value - rmst_ref), rmst_int = abs(rmst_ref - rmst_int),
            lower = max(abs(lo_mine - lo_ref)), upper = max(abs(hi_mine - hi_ref)), median_lo = abs(mine$medianInterval$lower - exp(log(med_ref) - z * se_m)) / med_ref,
            median_hi = abs(mine$medianInterval$upper - exp(log(med_ref) + z * se_m)) / med_ref, rmst_se = abs((mine$rmst$upper - mine$rmst$lower) / 2 - z * se_r))
  # flexsurv integrates the restricted mean with QUADPACK's default tolerance (about 1e-6 of the value), so the restricted-mean rows are held to 1e-5
  rm_cols <- c("rmst", "rmst_int", "rmst_se")
  list(pass = all(errs[setdiff(names(errs), rm_cols)] < 1e-8) && all(errs[rm_cols] < 1e-5) && rel_v < 2e-2 && sum(beyond) >= 2L,
       detail = sprintf("k = 2, horizons 5 to 90 (%d of 6 beyond the longest follow-up %.1f): survival %.1e, median %.1e (relative), restricted mean to 90 %.1e (and flexsurv's rmst against its own integral %.1e), survival intervals %.1e / %.1e, median interval %.1e / %.1e, restricted-mean half-width %.1e; the covariance within %.1f%% of flexsurv's (its optimum is looser)",
                        sum(beyond), mine$maxObservedTime, errs[["surv"]], errs[["median"]], errs[["rmst"]], errs[["rmst_int"]], errs[["lower"]], errs[["upper"]], errs[["median_lo"]], errs[["median_hi"]], errs[["rmst_se"]], 100 * rel_v))
})

vcr_case("N95c", c("AC-04", "AC-27"), function() {
  if (!requireNamespace("flexsurv", quietly = TRUE)) stop("N95 requires the locked flexsurv library")
  d <- .n95_data(n = 20000L, seed = 9503L, cens = c(25, 60))
  horizons <- c(2, 5, 10, 20, 40)
  truth_s <- function(t) flexsurv::pllogis(t, shape = 2.2, scale = 10, lower.tail = FALSE)
  truth_rmst <- stats::integrate(truth_s, 0, 40)$value
  w <- vcr_fit_survival_spline(d$time, d$status, 0L, horizons); sp <- vcr_fit_survival_spline(d$time, d$status, 3L, horizons)
  err <- function(f) max(abs(vapply(f$curve, function(p) p$survival, numeric(1)) - truth_s(horizons)))
  list(pass = err(sp) < 0.01 && err(w) > 0.03 && abs(sp$rmst$value - truth_rmst) < 0.05 && abs(w$rmst$value - truth_rmst) > 0.2 && sp$aic < w$aic - 500,
       detail = sprintf("20,000 patients from a log-logistic (shape 2.2, scale 10), follow-up 25 to 60: the largest error in survival at 2, 5, 10, 20, 40 is %.4f for the spline with 3 knots and %.4f for the Weibull; the restricted mean to 40 is %.3f against the truth %.3f (Weibull %.3f); AIC %.0f against %.0f",
                        err(sp), err(w), sp$rmst$value, truth_rmst, w$rmst$value, sp$aic, w$aic))
})

vcr_case("N95d", c("AC-04", "AC-27"), function() {
  d <- .n95_data()
  few <- vcr_fit_survival_spline(d$time[1:40], d$status[1:40], 3L, c(5))
  one <- vcr_fit_survival_spline(d$time[1:40], d$status[1:40], 0L, c(5))
  # events in two clusters with nothing in between (3 to 19): a cumulative hazard that is flat there cannot be followed by a curve with interior knots
  set.seed(9504L, kind = "Mersenne-Twister")
  gap <- data.frame(time = c(stats::runif(150, 0.5, 2), stats::runif(150, 20, 22)), status = 1)
  fits <- lapply(0:4, function(k) vcr_fit_survival_spline(gap$time, gap$status, k, c(10)))
  bad_input <- tryCatch({ vcr_fit_survival_spline(c(1, 2, -1), c(1, 0, 1), 1L, 2); "" }, vcr_refusal = function(e) e$issue$code)
  est <- vapply(fits, function(f) isTRUE(f$estimable), logical(1))
  rules <- vapply(fits[!est], function(f) as.character(f$rule), character(1))
  inside <- fits[[2L]]$specifications                                    # the one-knot fit lists the numbers of knots that failed
  failed_listed <- vapply(inside, function(s) !isTRUE(s$estimable), logical(1))
  list(pass = !few$estimable && identical(few$rule, "too_few_events") && isTRUE(one$estimable) && identical(bad_input, "scenario_value_invalid") &&
         identical(unname(est), c(TRUE, TRUE, FALSE, FALSE, FALSE)) && all(rules == "nuisance_model_not_estimable") && identical(unname(failed_listed), c(FALSE, FALSE, TRUE, TRUE)),
       detail = sprintf("40 patients (%d events) cannot carry 3 interior knots (needs 25 events): %s, while a Weibull on them fits; a malformed input is refused as %s; 300 events in two clusters with a gap from 2 to 20: 0 and 1 knots are estimable, 2 to 4 are %s (a hazard that would be zero or fall is refused, never repaired), and the one-knot fit lists the failed numbers of knots in its sensitivity table",
                        sum(d$status[1:40]), few$rule, bad_input, paste(unique(rules), collapse = "/")))
})

vcr_case("N95e", c("AC-04", "AC-27"), function() {
  d <- .n95_data(); ids <- paste0("P", seq_len(nrow(d)))
  input <- vcr_test_input(data.frame(USUBJID = ids, time = d$time, status = d$status), "n95_fit")
  job <- vcr_test_job("model.survival_fit", list(inputId = input$id, idColumn = "USUBJID", timeColumn = "time", statusColumn = "status", statusEncoding = "event",
                                                 distribution = "spline", knots = 2L, timeUnit = "months", horizons = c(12, 24, 60)), list(input))
  r1 <- vcr_test_run(job); r2 <- vcr_test_run(job)
  m <- r1$diagnostics$model; ext <- m$extrapolation
  names_ <- vapply(r1$measures, function(x) x$name, character(1))
  old <- job; old$methodVersion <- "1.0.0"
  r_old <- vcr_test_run(old)
  last <- m$curve[[3L]]
  list(pass = identical(r1$status, "succeeded") && identical(r1$conclusion, "limited") && identical(vcr_output_hash(r1), vcr_output_hash(r2)) &&
         all(c("fitted_median", "aic", "restricted_mean_survival_time", "survival_at_last_horizon") %in% names_) &&
         identical(m$distribution$kind, "spline") && isTRUE(last$extrapolated) && abs(last$timesLongestFollowUp - 60 / m$maxObservedTime) < 1e-12 && isTRUE(ext$beyondData) &&
         length(m$specifications) == 4L && sum(vapply(m$specifications, function(s) isTRUE(s$selected), logical(1))) == 1L &&
         identical(r_old$status, "failed") && "method_version_mismatch" %in% vcr_test_issue_codes(r_old),
       detail = sprintf("a spline job through the protocol: status %s / %s, measures %s; the horizon 60 is %.2f times the longest follow-up (%.1f) and flagged as beyond the data; four specifications (0 to 3 knots), one selected; the same output hash twice; the same scenario under the 1.0.0 label: %s (%s)",
                        r1$status, r1$conclusion, paste(names_, collapse = ", "), last$timesLongestFollowUp, m$maxObservedTime, r_old$status, paste(vcr_test_issue_codes(r_old), collapse = ", ")))
})

vcr_case("N95f", c("AC-04", "AC-27"), function() {
  # Review stats2 findings 7 and 26.
  # (7) A fitted median far past the data carried no mark. Weibull(1.1, 80), censoring uniform from 6 to 24 (43 events of 400, survival .86 at the longest follow-up
  #     of 23.9, true median 57.3; the seed here draws 56 events): the medians of 0 to 3 knots are 100 to 170 in the review's draw and 2.5 to 4.3 times the
#     longest follow-up in this one, and every fit says so; a Weibull family fit
  #     says it too; a median inside the data (Weibull(1.1, 20), follow-up to 60) is not marked.
  # (26) The restricted mean read 0 at a horizon of 1e9 because every node of the quadrature landed where the curve has underflowed. It is now the integral over
  #      pieces equal in log time and is held to the closed form of the Weibull's restricted mean, scale * Gamma(1 + 1/shape) * P(1/shape, (tau/scale)^shape),
  #      at 30, 1e5 and 1e9 (an incomplete gamma function, no quadrature).
  set.seed(9507L, kind = VCR_RNG_KIND)
  n <- 400L; cens <- stats::runif(n, 6, 24)
  t_ev <- stats::rweibull(n, shape = 1.1, scale = 80)
  d <- data.frame(time = pmin(t_ev, cens), status = as.integer(t_ev <= cens))
  longest <- max(d$time)
  fits <- lapply(0:3, function(k) vcr_fit_survival_spline(d$time, d$status, k, c(12, 24)))
  flagged <- vapply(fits, function(f) isTRUE(f$estimable) && isTRUE(f$medianBeyondData) && abs(f$medianTimesLongestFollowUp - f$median / longest) < 1e-12, logical(1))
  meds <- vapply(fits, function(f) f$median, numeric(1))
  weib <- vcr_fit_survival_baseline(d$time, d$status, "weibull", c(12, 24))
  inside <- local({ t2 <- stats::rweibull(n, 1.1, 20); c2 <- stats::runif(n, 20, 60); dd <- data.frame(time = pmin(t2, c2), status = as.integer(t2 <= c2)); f <- vcr_fit_survival_spline(dd$time, dd$status, 1L, c(12, 24)); f })
  ids <- paste0("P", seq_len(n)); input <- vcr_test_input(data.frame(USUBJID = ids, time = d$time, status = d$status), "n95f")
  job <- vcr_test_job("model.survival_fit", list(inputId = input$id, idColumn = "USUBJID", timeColumn = "time", statusColumn = "status", statusEncoding = "event",
                                                 distribution = "spline", knots = 1L, timeUnit = "months", horizons = c(12, 24)), list(input))
  r <- vcr_test_run(job)
  said <- "median_beyond_follow_up" %in% vcr_chr(r$diagnostics$limitedBy) && identical(r$conclusion, "limited") && isTRUE(r$diagnostics$model$medianBeyondData)
  # (26)
  w <- stats::rweibull(300L, 1.2, 15); cn <- stats::runif(300L, 10, 40)
  fit <- .vcr_rp_fit(pmin(w, cn), as.integer(w <= cn), 0L)
  shape <- fit$gamma[2]; scale <- exp(-fit$gamma[1] / shape)
  closed <- function(tau) scale * gamma(1 + 1 / shape) * stats::pgamma((tau / scale)^shape, 1 / shape)
  taus <- c(30, 1e5, 1e9)
  mine <- vapply(taus, function(tau) .vcr_rp_rmst(fit, tau)$value, numeric(1)); want <- vapply(taus, closed, numeric(1))
  rel <- max(abs(mine - want) / want)
  list(pass = all(flagged) && all(meds > longest) && isTRUE(weib$medianBeyondData) && !isTRUE(inside$medianBeyondData) && said && rel < 1e-7,
       detail = sprintf("%d events of %d, longest follow-up %.1f: medians of 0 to 3 knots %s (%s times the longest follow-up), all marked; Weibull family marked: %s; a median inside the data unmarked: %s; the job says median_beyond_follow_up and stays limited: %s; restricted mean at 30, 1e5, 1e9: %s against the incomplete-gamma closed form %s (worst relative error %.1e)",
                        sum(d$status), n, longest, paste(sprintf("%.0f", meds), collapse = ", "), paste(sprintf("%.1f", meds / longest), collapse = ", "), isTRUE(weib$medianBeyondData), !isTRUE(inside$medianBeyondData), said,
                        paste(sprintf("%.4f", mine), collapse = ", "), paste(sprintf("%.4f", want), collapse = ", "), rel))
})
