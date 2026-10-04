# ---------------------------------------------------------------------------
# robustness.R — what the three robustness methods add to the shared harness
# (2026-10-04): their valid handler jobs, which E05 runs as they are and E10 breaks
# one field at a time. Kept in a file of its own, sourced by tests/run_all.R right
# after harness.R, so the streams that add engine methods at the same time do not
# edit one list.
# ---------------------------------------------------------------------------

#' Run `code` with a fixed RNG seed and leave the caller's random state as it was.
.vcr_with_seed <- function(seed, code) {
  had <- exists(".Random.seed", envir = .GlobalEnv)
  old <- if (had) get(".Random.seed", envir = .GlobalEnv) else NULL
  on.exit(if (had) assign(".Random.seed", old, envir = .GlobalEnv) else if (exists(".Random.seed", envir = .GlobalEnv)) rm(".Random.seed", envir = .GlobalEnv))
  set.seed(seed, kind = VCR_RNG_KIND)
  force(code)
}

#' One valid job for each robustness method, as `list(method, scenario, inputs,
#' replicates)` -- the shape `vcr_test_handler_jobs()` returns.
vcr_test_robustness_handler_jobs <- function() {
  .vcr_with_seed(41L, {
    n <- 120L
    d <- data.frame(USUBJID = sprintf("R%03d", seq_len(n)), arm = rep(0:1, each = n / 2L), x1 = stats::rnorm(n), x2 = stats::rbinom(n, 1L, 0.5), stringsAsFactors = FALSE)
    d$x1[d$arm == 1L] <- d$x1[d$arm == 1L] + 0.15
    d$fracture <- stats::rbinom(n, 1L, 0.25); d$cataract <- stats::rbinom(n, 1L, 0.3); d$death <- stats::rbinom(n, 1L, 0.2)
    in_nc <- vcr_test_input(d, "snp_e05r:subject", "subject")
    # a small time-to-event trial for the tipping-point analysis: exponential, dropout, administrative censoring at 24
    nt <- 120L; arm <- rep(0:1, each = nt / 2L)
    t_event <- stats::rexp(nt, 0.08 * ifelse(arm == 1L, 0.6, 1)); t_drop <- stats::rexp(nt, 0.05)
    tm <- pmin(t_event, t_drop, 24); st <- as.integer(t_event <= pmin(t_drop, 24))
    tt <- data.frame(USUBJID = sprintf("Q%03d", seq_len(nt)), arm = arm)
    in_tt_s <- vcr_test_input(tt, "snp_e05r:tt_subject", "subject")
    in_tt_e <- vcr_test_input(data.frame(USUBJID = tt$USUBJID, PARAMCD = "OS", AVAL = tm, CNSR = 1L - st), "snp_e05r:tt_event", "event")
    # a randomized trial with a prognostic score, binary and time to event
    xs <- stats::rnorm(nt); pa_y <- stats::rbinom(nt, 1L, stats::plogis(-0.6 + 0.8 * arm + 1.2 * xs))
    pa_t <- stats::rexp(nt, 0.08 * exp(0.7 * xs) * ifelse(arm == 1L, 0.6, 1)); pa_c <- stats::runif(nt, 12, 24)
    pa_tm <- pmin(pa_t, pa_c); pa_st <- as.integer(pa_t <= pa_c)
    in_pa_b <- vcr_test_input(data.frame(USUBJID = tt$USUBJID, arm = arm, score = xs, y = pa_y), "snp_e05r:pa_subject", "subject")
    in_pa_t <- vcr_test_input(data.frame(USUBJID = tt$USUBJID, arm = arm, score = xs), "snp_e05r:pa_tsubject", "subject")
    in_pa_e <- vcr_test_input(data.frame(USUBJID = tt$USUBJID, PARAMCD = "OS", AVAL = pa_tm, CNSR = 1L - pa_st), "snp_e05r:pa_event", "event")
    list(
      list("comparator.negative_control", list(
        controls = list(list(name = "fracture", estimate = 0.12, se = 0.2), list(name = "cataract", estimate = -0.05, se = 0.15),
                        list(name = "otitis", estimate = 0.31, se = 0.25)),
        primary = list(name = "death", estimate = -0.4, se = 0.1)), NULL),
      # the controls analysed in the engine, with the primary's adjustment
      list("comparator.negative_control", list(
        covariates = list("x1", "x2"), treatmentColumn = "arm",
        controls = list(list(name = "fracture", column = "fracture"), list(name = "cataract", column = "cataract")),
        primary = list(name = "death", column = "death")), list(in_nc)),
      list("comparator.tipping_point", list(
        endpoint = list(type = "binary"), design = list(kind = "two_arm"),
        counts = list(treatment = list(n = 60, responders = 36, missing = 6), control = list(n = 60, responders = 22, missing = 8)),
        analysis = list(method = "fisher_exact", alpha = 0.025, sided = 1)), NULL),
      list("comparator.tipping_point", list(
        endpoint = list(type = "time_to_event"), horizon = 24, treatmentColumn = "arm", deltas = list(1, 1.5, 2, 4)),
        list(in_tt_s, in_tt_e), 40L),
      list("comparator.prognostic_adjustment", list(
        endpoint = list(type = "binary"), prognosticScoreColumn = "score", treatmentColumn = "arm", outcomeColumn = "y"), list(in_pa_b)),
      list("comparator.prognostic_adjustment", list(
        endpoint = list(type = "time_to_event"), prognosticScoreColumn = "score", treatmentColumn = "arm", tau = 12, timeUnit = "months"), list(in_pa_t, in_pa_e))
    )
  })
}
