# N79 — comparator.target_trial, a sequence of emulated trials (algorithm round C3, 2026-11-03).
#
# References that are not the method's own code: `TrialEmulation` 0.0.5 on its own `trial_example` (503 people, 48,400 person-periods): the expanded
# person-trial-periods row for row (counts of rows and events), the intention-to-treat and per-protocol outcome-model coefficients, the stabilised
# weights of the treatment received (their summary and the fit of each of the four models they come from), and the standardised cumulative incidence
# under each arm (`predict`). `TrialEmulation` is a cross-check in CI only: no file under R/ calls it. The data are TrialEmulation's own table pivoted
# to the data plane's longitudinal shape (one row per person, period and parameter), which is how a person-period file reaches the engine.

.n79_long <- function(te, covn) do.call(rbind, lapply(c("treatment", "outcome", "eligible", covn), function(p) data.frame(USUBJID = te$id, PARAMCD = p, AVAL = te[[p]], ADT = te$period)))
.n79_covn <- c("catvarA", "catvarB", "catvarC", "nvarA", "nvarB", "nvarC")

vcr_case("N79a", c("AC-08", "AC-30"), function() {
  # The window keeps the expansion small: trials start in periods 280-330 and follow 15 periods (TrialEmulation: first_period, last_period, last_followup).
  suppressMessages(library(TrialEmulation))
  data("trial_example", package = "TrialEmulation")
  te <- trial_example; covn <- .n79_covn
  first <- 280L; last <- 330L; L <- 15L; H <- 8L
  sc <- list(covariates = as.list(covn), strategy = list(kind = "sequential", estimand = "both"), horizon = H, firstPeriod = first, lastPeriod = last, followUpLimit = L)
  fr <- .vcr_tt_frame(list(long = .n79_long(te, covn)), sc)
  tr <- .vcr_tt_trials(fr, first, last, L)
  om <- list(followupDegree = 2L, trialPeriodDegree = 2L, armByFollowup = FALSE)
  ex <- .vcr_tt_expand(fr, tr, om)
  tmin <- min(fr$period[tr$rows]); X <- .vcr_tt_design(ex, fr, tr, om, tmin)
  dir <- tempfile("n79a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  outcome_cov <- ~ catvarA + catvarB + catvarC + nvarA + nvarB + nvarC
  itt <- TrialEmulation::initiators(te, estimand_type = "ITT", outcome_cov = outcome_cov, first_period = first, last_period = last, last_followup = L - 1L, data_dir = dir, quiet = TRUE)
  pp <- suppressWarnings(TrialEmulation::initiators(te, estimand_type = "PP", outcome_cov = outcome_cov, switch_n_cov = ~ nvarB + nvarC, switch_d_cov = outcome_cov,
                                                    first_period = first, last_period = last, last_followup = L - 1L, data_dir = dir, quiet = TRUE))
  rows_ok <- ex$n == nrow(itt$model$data) && sum(ex$in_pp) == nrow(pp$model$data) && sum(ex$y == 1) == sum(itt$model$data$outcome, na.rm = TRUE)
  fit_itt <- .vcr_tt_fit(X, ex$y, rep(1, ex$n)); b_itt <- setNames(fit_itt$beta, colnames(X))
  te_names <- c(assigned_treatment = "assigned_treatment", followup_time1 = "followup_time", followup_time2 = "I(followup_time^2)", catvarA = "catvarA", catvarB = "catvarB",
                catvarC = "catvarC", nvarA = "nvarA", nvarB = "nvarB", nvarC = "nvarC")
  gap_itt <- max(abs(b_itt[names(te_names)] - coef(itt$model)[te_names]))
  # per protocol: the weights models, the weights and the outcome model
  logw <- .vcr_tt_switch_logw(fr, c("nvarB", "nvarC"), covn, rep(1, length(fr$pid)), tr$needed)
  clog <- stats::ave(logw, fr$pid, FUN = cumsum)
  keep <- which(ex$in_pp)
  w <- exp(clog[ex$row_j[keep]] - clog[tr$rows[ex$trial[keep]]])
  fit_pp <- .vcr_tt_fit(X[keep, , drop = FALSE], ex$y[keep], w); b_pp <- setNames(fit_pp$beta, colnames(X))
  gap_pp <- max(abs(b_pp[names(te_names)] - coef(pp$model)[te_names]))
  w_gap <- max(abs(c(mean(w) - mean(pp$model$data$w), range(w) - range(pp$model$data$w))))
  # the standardised cumulative incidence under each arm
  ref <- which(ex$k == 0L)
  risks <- function(model, beta) {
    nd <- model$model$data[model$model$data$followup_time == 0, ]
    pr <- predict(model, newdata = nd, predict_times = 0:(H - 1L), type = "cum_inc", conf_int = FALSE)
    mine <- .vcr_tt_standardise(beta, ex$trial[ref], fr, tr, om, tmin, H, rep(1, length(ref)))
    max(abs(c(mine[, "treated"] - pr$assigned_treatment_1$cum_inc, mine[, "control"] - pr$assigned_treatment_0$cum_inc)))
  }
  gap_risk <- c(itt = risks(itt, b_itt), pp = risks(pp, b_pp))
  list(pass = rows_ok && gap_itt < 1e-6 && gap_pp < 1e-6 && w_gap < 1e-6 && all(gap_risk < 1e-8),
       detail = sprintf("trial_example, trials from period %d to %d, %d follow-up periods: %s expanded rows (TrialEmulation %s, per protocol %s of %s) and %d events the same; outcome-model coefficients intention to treat %.1e and per protocol %.1e from glm's; stabilised weights mean %.6f (%.6f), range %.4f-%.4f; the standardised risk at %d periods %.1e (intention to treat) and %.1e (per protocol) from predict()",
                        first, last, L, format(ex$n, big.mark = ","), format(nrow(itt$model$data), big.mark = ","), format(sum(ex$in_pp), big.mark = ","), format(nrow(pp$model$data), big.mark = ","),
                        sum(ex$y == 1), gap_itt, gap_pp, mean(w), mean(pp$model$data$w), min(w), max(w), H, gap_risk[["itt"]], gap_risk[["pp"]]))
})

#' A small person-period table in which treatment switches on and off (so that the per-protocol follow-up is censored and weighted), the covariate x raises
#' both the chance of treatment and the hazard of the event, treatment lowers the hazard, and a person is eligible in the first three periods.
.n79_switching <- function(n = 90L, periods = 8L, seed = 20261109L, effect = -0.8, treat_all = TRUE) {
  set.seed(seed, kind = VCR_RNG_KIND)
  rows <- lapply(seq_len(n), function(i) {
    x <- stats::rnorm(1L); a <- as.integer(stats::runif(1L) < stats::plogis(-0.3 + 0.8 * x)); out <- list()
    for (u in 0:(periods - 1L)) {
      if (u > 0L) a <- if (a == 1L) as.integer(stats::runif(1L) > 0.12) else as.integer(stats::runif(1L) < stats::plogis(-1.8 + 0.6 * x))
      if (!treat_all) a <- 0L
      ev <- as.integer(stats::runif(1L) < stats::plogis(-2.7 + 0.7 * x + effect * a))
      out[[length(out) + 1L]] <- data.frame(id = sprintf("Q%03d", i), period = u, treatment = a, outcome = ev, eligible = as.integer(u < 3L), x = x, z = stats::rnorm(1L))
      if (ev == 1L) break
    }
    do.call(rbind, out)
  })
  w <- do.call(rbind, rows)
  do.call(rbind, lapply(c("treatment", "outcome", "eligible", "x", "z"), function(p) data.frame(USUBJID = w$id, PARAMCD = p, AVAL = w[[p]], ADT = w$period)))
}

vcr_case("N79b", c("AC-08", "AC-30"), function() {
  # The job on a small person-period file through the engine's intake (the data plane's longitudinal shape: USUBJID, PARAMCD, AVAL, ADT as the period): the
  # estimands are named, the risk difference is the difference of the two arms' risks at the horizon, the point estimates are the ones the pieces above give,
  # the curves and the table are there, one and two cores give one hash, a design the memory cannot hold is refused by name, and a horizon beyond follow-up,
  # a table without a treatment arm and an unknown parameter are results of their own.
  long <- .n79_switching(90L, 8L)
  sc <- list(covariates = list("x", "z"), strategy = list(kind = "sequential", estimand = "both", weights = list(numerator = list("x"))), horizon = 6L, timeUnit = "months")
  mk <- function(sc_, cores = 1L, tab = long, id = "n79b") vcr_test_job("comparator.target_trial", sc_, list(vcr_test_input(tab, paste0("snp_", id, ":longitudinal"), "long")), seed = 9L, job_id = paste0("job_", id), cores = cores)
  dir <- tempfile("n79b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- vcr_test_run(mk(sc), output_dir = dir)
  r2 <- vcr_test_run(mk(sc, 2L))
  same <- identical(vcr_test_run(mk(sc))$manifest$outputHash, r2$manifest$outputHash)
  tt <- r$diagnostics$targetTrial
  v <- function(name) vcr_measure_value(r, name)
  hand <- local({
    fr <- .vcr_tt_frame(list(long = long), sc); tr <- .vcr_tt_trials(fr)
    om <- list(followupDegree = 2L, trialPeriodDegree = 2L, armByFollowup = FALSE)
    ex <- .vcr_tt_expand(fr, tr, om); X <- .vcr_tt_design(ex, fr, tr, om, min(fr$period[tr$rows]))
    .vcr_tt_run_sequential(fr, tr, ex, X, "x", c("x", "z"), om, min(fr$period[tr$rows]), 6L, c("itt", "pp"), rep(1, max(fr$pid)))
  })
  est_ok <- abs(v("risk_difference_itt") - (hand$risks$itt[6, "treated"] - hand$risks$itt[6, "control"])) < 1e-12 &&
    abs(v("risk_difference_pp") - (hand$risks$pp[6, "treated"] - hand$risks$pp[6, "control"])) < 1e-12 &&
    abs(v("risk_difference_pp") - (v("risk_treated_pp") - v("risk_control_pp"))) < 1e-12
  said <- identical(tt$strategy, "sequential") && identical(tt$horizon, 6L) && length(tt$estimands) == 2L && identical(vapply(tt$estimands, function(e) e$label, ""), c("intention_to_treat", "per_protocol")) &&
    identical(tt$periodUnit, "months") && length(r$diagnostics$curves) == 4L && file.exists(file.path(dir, "risk-by-period.csv")) && !is.null(tt$weights$summary) && !is.null(tt$coefficients)
  iv <- vcr_get_measure(r, "risk_difference_pp")$interval
  ci_ok <- is.list(iv) && iv$low < v("risk_difference_pp") && iv$high > v("risk_difference_pp")
  ok_run <- identical(r$status, "succeeded") && r$replicates >= 200L
  Sys.setenv(VCR_ENGINE_MAX_PERSON_PERIODS = "500"); on.exit(Sys.unsetenv("VCR_ENGINE_MAX_PERSON_PERIODS"), add = TRUE)
  refused <- vcr_test_run(mk(sc)); Sys.unsetenv("VCR_ENGINE_MAX_PERSON_PERIODS")
  cap_ok <- identical(refused$status, "failed") && "too_many_person_periods" %in% vcr_test_issue_codes(refused) && length(refused$measures) == 0L
  far <- vcr_test_run(mk(utils::modifyList(sc, list(horizon = 12L))))
  far_ok <- identical(far$status, "not_estimable") && identical(far$notEstimableRule, "horizon_beyond_followup")
  none_ok <- identical(vcr_test_run(mk(sc, tab = .n79_switching(90L, 8L, treat_all = FALSE), id = "n79b0"))$notEstimableRule, "arm_without_person_trials")
  gone <- vcr_test_run(mk(utils::modifyList(sc, list(parameters = list(treatment = "no_such_parameter")))))
  gone_ok <- identical(gone$status, "failed") && "input_shape_invalid" %in% vcr_test_issue_codes(gone)
  list(pass = ok_run && est_ok && said && ci_ok && same && cap_ok && far_ok && none_ok && gone_ok,
       detail = sprintf("90 people through the longitudinal shape: %s with %d bootstrap draws; intention-to-treat risk difference %.4f and per-protocol %.4f at 6 periods = the pieces by hand to 1e-12, per-protocol interval %.4f to %.4f; both estimands named, unit months, 4 curves, the weights summary and the risk table written: %s; one and two cores one hash: %s; a cap of 500 rows refuses by name: %s; a horizon of 12 periods against 8 followed: %s; nobody treated: %s; an unknown parameter: %s",
                        r$status, r$replicates %||% 0L, v("risk_difference_itt"), v("risk_difference_pp"), iv$low, iv$high, said, same, cap_ok, far_ok, none_ok, gone_ok))
})

vcr_case("N79c", c("AC-07", "AC-30"), function() {
  # The budget. A run that is stopped part-way keeps the resamples that finished once there are 200 of them (limited, bootstrap_stopped_early, with the number);
  # one stopped before that fails with the point estimates kept and no interval; the outcome-model options (a linear follow-up with the arm by follow-up
  # interaction, no trial-period term) run too.
  long <- .n79_switching(60L, 8L, seed = 20261110L)
  sc <- list(covariates = list("x", "z"), strategy = list(kind = "sequential", estimand = "both"), horizon = 6L)
  # one core: a batch finishes on every core before the budget is read, so on four cores the first read already holds 200 resamples and the case read another branch (CI, 2026-11-04).
  mk <- function(sc_, limit = 600) { j <- vcr_test_job("comparator.target_trial", sc_, list(vcr_test_input(long, "snp_n79c:longitudinal", "long")), seed = 5L, job_id = "job_n79c"); j$cpuSecondsLimit <- limit; j$cores <- 1L; j }
  full <- vcr_test_run(mk(sc))
  part <- vcr_test_run(mk(sc, max(0.5, 0.45 * full$manifest$cpuSeconds / 0.9)))
  stopped_ok <- identical(part$status, "succeeded") && identical(part$conclusion, "limited") && "bootstrap_stopped_early" %in% vcr_chr(part$diagnostics$limitedBy) &&
    part$replicates >= 200L && part$replicates < 2000L && !is.null(vcr_get_measure(part, "risk_difference_pp")$interval)
  # five per cent of the whole run: the point estimates are done and the first 200 resamples are not, on a fast machine or a slow one (0.02 s ended before the handler began on a CI runner)
  none <- vcr_test_run(mk(sc, 0.05 * full$manifest$cpuSeconds / 0.9))
  none_ok <- identical(none$status, "failed") && "cpu_budget_exhausted" %in% vcr_test_issue_codes(none) && !is.null(vcr_get_measure(none, "risk_difference_itt")) &&
    is.null(vcr_get_measure(none, "risk_difference_itt")$interval)
  opts <- vcr_test_run(mk(utils::modifyList(sc, list(outcomeModel = list(followupDegree = 1L, trialPeriodDegree = 0L, armByFollowup = TRUE), strategy = list(kind = "sequential", estimand = "itt")))))
  opts_ok <- identical(opts$status, "succeeded") && any(vapply(opts$diagnostics$targetTrial$coefficients[[1]]$terms, function(t) identical(t$term, "assigned_treatment:followup_time"), logical(1)))
  list(pass = identical(full$status, "succeeded") && stopped_ok && none_ok && opts_ok,
       detail = sprintf("the whole run takes %.0f CPU seconds; a budget of 45%% of it keeps %d of 2000 resamples (limited, bootstrap_stopped_early): %s; a budget of 5%% of it fails with the point estimates and no interval: %s; the arm by follow-up interaction runs: %s",
                        full$manifest$cpuSeconds, part$replicates %||% 0L, stopped_ok, none_ok, opts_ok))
})

#' People whose arm is fixed at period 0 (the only period they are eligible in): treated people stay treated for `stay` periods and stop (`stay` NULL:
#' for good), hazards of the event per period `h0` untreated and `h1` treated, followed to `periods`. `events` overrides the draw: the number of events
#' among the treated and the untreated (placed at the earliest periods; the first number is the untreated, the second the treated), for the tables in which an arm has none.
.n79_fixed_arm <- function(n = 600L, periods = 12L, stay = NULL, h0 = 0.10, h1 = 0.05, seed = 20261114L, events = NULL) {
  set.seed(seed, kind = VCR_RNG_KIND)
  a0 <- rep(0:1, length.out = n); E <- rep(Inf, n)
  if (is.null(events)) {
    for (u in 0:(periods - 1L)) {
      on <- a0 == 1L & (is.null(stay) | u < (stay %||% Inf))
      E[is.infinite(E) & stats::runif(n) < ifelse(on, h1, h0)] <- u
    }
  } else {
    for (arm in 0:1) { ix <- which(a0 == arm); k <- events[[arm + 1L]]; if (k > 0L) E[ix[seq_len(k)]] <- seq_len(k) %% periods }
  }
  last <- pmin(E, periods - 1L)
  who <- rep(seq_len(n), last + 1L); u <- sequence(last + 1L) - 1L
  id <- sprintf("F%04d", who)
  treat <- ifelse(a0[who] == 1L & (is.null(stay) | u < (stay %||% Inf)), 1L, 0L)
  tab <- function(p, v) data.frame(USUBJID = id, PARAMCD = p, AVAL = v, ADT = u)
  rbind(tab("treatment", treat), tab("outcome", as.integer(u == E[who])), tab("eligible", as.integer(u == 0L)))
}

vcr_case("N79d", c("AC-08", "AC-11", "AC-30"), function() {
  # Review stats2 findings 5 and 4. (5) The horizon was checked against intention-to-treat follow-up only, so a per-protocol risk was read at a period no
  # treated person had been on protocol: with the treated arm stopping at period 3 and a horizon of 10 the engine answered a per-protocol risk difference of
  # -.25 'estimable' (truth -.19) from the outcome model's polynomial. Now the estimand the follow-up cannot carry is left out and named, the other is kept,
  # and a request for that estimand alone is not estimable by name; at a horizon the protocol does cover the numbers are the closed forms. (4) An arm with
  # no event at all has no risk the data measure: the result says so, draws no interval of that risk, of the difference or of the ratio, and gives the
  # exact upper limit of 0 events among the people of the arm (a model fitted to such an arm returned a risk of .0001 with an interval of 9e-5 to 1.1e-4).
  long <- .n79_fixed_arm(600L, 12L, stay = 3L)
  mk <- function(tab, sc, id) vcr_test_job("comparator.target_trial", sc, list(vcr_test_input(tab, paste0("snp_", id, ":longitudinal"), "long")), seed = 12L, job_id = paste0("job_", id))
  base <- list(strategy = list(kind = "sequential", estimand = "both"), horizon = 10L)
  r <- vcr_test_run(mk(long, base, "n79d1"))
  kept <- !is.null(vcr_get_measure(r, "risk_difference_itt")) && is.null(vcr_get_measure(r, "risk_difference_pp")) && identical(r$conclusion, "limited") &&
    "per_protocol_beyond_protocol_follow_up" %in% vcr_chr(r$diagnostics$limitedBy) && identical(r$diagnostics$targetTrial$droppedEstimands[[1]]$estimand, "pp") &&
    identical(r$diagnostics$targetTrial$droppedEstimands[[1]]$arm, "treated") && r$diagnostics$targetTrial$droppedEstimands[[1]]$longestOnProtocol == 3L
  alone <- vcr_test_run(mk(long, utils::modifyList(base, list(strategy = list(kind = "sequential", estimand = "per_protocol"))), "n79d2"))
  alone_ok <- identical(alone$status, "not_estimable") && identical(alone$notEstimableRule, "horizon_beyond_followup")
  inside <- vcr_test_run(mk(long, utils::modifyList(base, list(horizon = 3L)), "n79d3"))
  pp <- c(treated = vcr_measure_value(inside, "risk_treated_pp"), control = vcr_measure_value(inside, "risk_control_pp")); truth <- c(treated = 1 - 0.95^3, control = 1 - 0.90^3)
  inside_ok <- is.null(inside$diagnostics$targetTrial$droppedEstimands) && abs(pp[["treated"]] - truth[["treated"]]) < 0.04 && abs(pp[["control"]] - truth[["control"]]) < 0.04 && identical(inside$conclusion, "estimable")
  # (4)
  sc4 <- list(strategy = list(kind = "sequential", estimand = "itt"), horizon = 8L)
  a_tab <- .n79_fixed_arm(400L, 8L, events = c(200L, 0L)); b_tab <- .n79_fixed_arm(400L, 8L, events = c(2L, 0L))
  a <- vcr_test_run(mk(a_tab, sc4, "n79d4")); b <- vcr_test_run(mk(b_tab, sc4, "n79d5"))
  bare <- function(x) identical(x$conclusion, "limited") && "arm_without_events" %in% vcr_chr(x$diagnostics$limitedBy) &&
    is.null(vcr_get_measure(x, "risk_difference_itt")$interval) && is.null(vcr_get_measure(x, "risk_treated_itt")$interval) && !is.null(vcr_get_measure(x, "risk_control_itt")$interval) &&
    identical(unlist(x$diagnostics$targetTrial$armsWithoutEvents[[1]]$arms), "treated")
  up <- a$diagnostics$targetTrial$armsWithoutEvents[[1]]$upperLimits$treated
  up_ok <- abs(up$risk - (1 - 0.025^(1 / 200))) < 1e-12 && up$n == 200
  list(pass = kept && alone_ok && inside_ok && bare(a) && bare(b) && up_ok,
       detail = sprintf("600 people, the treated stop after 3 periods, horizon 10, both estimands: intention to treat kept (%.4f), per protocol left out and named (%s), per protocol alone not estimable (%s); at a horizon of 3 the per-protocol risks are %.4f and %.4f (closed forms %.4f and %.4f); 400 people, none of the 200 treated has an event: limited, no interval of the treated risk, of the difference or of the ratio (%s), the upper limit of 0 of 200 is %.5f (exact: %.5f); the same with 2 events in all, both untreated: %s",
                        vcr_measure_value(r, "risk_difference_itt"), kept, alone_ok, pp[["treated"]], pp[["control"]], truth[["treated"]], truth[["control"]], bare(a), up$risk, 1 - 0.025^(1 / 200), bare(b)))
})
