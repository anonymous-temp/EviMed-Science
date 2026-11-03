# N80 — comparator.target_trial, clone-censor-weight (algorithm round C4, 2026-11-03).
#
# No package runs this design on R 4.3.3 (`ccwr` needs R 4.4), so the reference is a known truth. Discrete time; a covariate x raises both the hazard
# of starting treatment and the hazard of the event (the confounding that makes the starting time informative); treatment lowers the event hazard from
# the period it starts. The truth of the strategy "start within g periods" against "never start" is computed exactly by summing over the starting time
# for each of 20,000 quantiles of x (no simulation). A person has to live to be treated, so the naive comparison of those who ever started against
# those who never did gives the treated an advantage they have not earned (immortal time); clone-censor-weight, which keeps a person in both arms until
# the arm is no longer followed, recovers the truth.

.n80_par <- list(H = 12L, g = 3L, Tmax = 20L, a = c(-2.0, 0.6, -0.10), b = c(-4.2, 0.8), beta = -0.8)
.n80_hs <- function(x, u) with(.n80_par, plogis(a[1] + a[2] * x + a[3] * u))
.n80_h0 <- function(x, u) with(.n80_par, plogis(b[1] + b[2] * x + 0 * u))
.n80_h1 <- function(x, u) with(.n80_par, plogis(b[1] + b[2] * x + beta + 0 * u))

#' The risk at the horizon under each arm of the estimand the weights target: the second arm is never treated, the first starts at the natural time
#' within the grace period (a person who has not started by its end is not followed), the events before the grace period ends are everyone's.
.n80_truth <- function() {
  H <- .n80_par$H; g <- .n80_par$g
  x <- stats::qnorm((1:20000 - 0.5) / 20000)
  r0 <- 1 - vapply(x, function(xx) prod(1 - .n80_h0(xx, 0:(H - 1))), numeric(1))
  r1 <- vapply(x, function(xx) {
    ps <- vapply(0:g, function(s) .n80_hs(xx, s) * prod(1 - .n80_hs(xx, seq_len(s) - 1)), numeric(1)); tail_p <- 1 - sum(ps)
    in_window <- sum(ps * vapply(0:g, function(s) prod(1 - .n80_h0(xx, seq_len(s) - 1)) * prod(1 - .n80_h1(xx, s:g)), numeric(1))) + tail_p * prod(1 - .n80_h0(xx, 0:g))
    1 - in_window * prod(1 - .n80_h1(xx, (g + 1L):(H - 1L)))
  }, numeric(1))
  c(treated = mean(r1), control = mean(r0), difference = mean(r1) - mean(r0))
}

.n80_sim <- function(n) {
  with(.n80_par, {
    x <- stats::rnorm(n); S <- rep(Inf, n); E <- rep(Inf, n)
    for (i in seq_len(n)) {
      for (u in 0:(Tmax - 1L)) if (stats::runif(1L) < .n80_hs(x[i], u)) { S[i] <- u; break }
      for (u in 0:(Tmax - 1L)) { hz <- if (u >= S[i]) .n80_h1(x[i], u) else .n80_h0(x[i], u); if (stats::runif(1L) < hz) { E[i] <- u; break } }
    }
    last <- pmin(E, Tmax - 1L)
    list(pid = seq_len(n), t0 = rep(0L, n), s = ifelse(S <= last, S, Inf), e = E, last = last, X = matrix(x, ncol = 1L, dimnames = list(NULL, "x")), n = n, S = S)
  })
}

#' A simulated people table as the data plane would hold it: one row per person, period and parameter.
.n80_long <- function(pe, Tmax) {
  rows <- lapply(seq_len(pe$n), function(i) {
    u <- 0:pe$last[i]
    data.frame(id = rep(sprintf("P%05d", i), length(u)), period = u, treatment = as.integer(u >= pe$S[i]), outcome = as.integer(u == pe$e[i]), eligible = as.integer(u == 0L),
               x = rep(pe$X[i, 1L], length(u)))
  })
  w <- do.call(rbind, rows)
  do.call(rbind, lapply(c("treatment", "outcome", "eligible", "x"), function(p) data.frame(USUBJID = w$id, PARAMCD = p, AVAL = w[[p]], ADT = w$period)))
}

vcr_case("N80a", c("AC-08", "AC-11", "AC-30"), function() {
  # 60 trials of 1,500 people. The naive estimate is the immortal-time one; the clone-censor-weight estimate is within its sampling error of the truth.
  set.seed(20261107L, kind = VCR_RNG_KIND)
  H <- .n80_par$H; g <- .n80_par$g; R <- 60L
  truth <- .n80_truth()
  out <- t(vapply(seq_len(R), function(r) {
    pe <- .n80_sim(1500L)
    run <- .vcr_tt_run_ccw(pe, g, H, 3L, rep(1, pe$n)); nv <- .vcr_tt_naive(pe, H)
    c(ccw = unname(run$risks[H, "treated"] - run$risks[H, "control"]), naive = unname(nv[["treated"]] - nv[["control"]]))
  }, numeric(2)))
  se <- apply(out, 2L, stats::sd) / sqrt(R)
  z_ccw <- (mean(out[, "ccw"]) - truth[["difference"]]) / se[["ccw"]]; z_naive <- (mean(out[, "naive"]) - truth[["difference"]]) / se[["naive"]]
  list(pass = abs(z_ccw) < 2.5 && abs(z_naive) > 10 && mean(out[, "naive"]) < truth[["difference"]],
       detail = sprintf("%d trials of 1,500 people, grace period %d, horizon %d: true risk difference %.4f (treated %.4f, control %.4f); clone-censor-weight %.4f (%.1f errors off); the naive comparison of ever against never treated %.4f (%.0f errors off: it credits the treated with the time they waited to be treated)",
                        R, g, H, truth[["difference"]], truth[["treated"]], truth[["control"]], mean(out[, "ccw"]), z_ccw, mean(out[, "naive"]), z_naive))
})

vcr_case("N80b", c("AC-07", "AC-08", "AC-30"), function() {
  # The job on a simulated people table through the engine's intake (longitudinal shape): the estimand named, the weights and the waiting time
  # reported, the naive estimate beside the answer as a diagnostic, one and two cores the same hash, and the edges.
  set.seed(20261108L, kind = VCR_RNG_KIND)
  pe <- .n80_sim(250L)
  long <- .n80_long(pe, .n80_par$Tmax)
  sc <- list(covariates = list("x"), strategy = list(kind = "clone_censor_weight", gracePeriod = 3L), horizon = 12L, timeUnit = "weeks")
  mk <- function(sc_, cores = 1L, tab = long, id = "n80b") vcr_test_job("comparator.target_trial", sc_, list(vcr_test_input(tab, paste0("snp_", id, ":longitudinal"), "long")), seed = 4L, job_id = paste0("job_", id), cores = cores)
  dir <- tempfile("n80b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r1 <- vcr_test_run(mk(sc), output_dir = dir)
  r2 <- vcr_test_run(mk(sc, 2L))
  same <- identical(vcr_test_run(mk(sc))$manifest$outputHash, r2$manifest$outputHash) && identical(r1$measures, r2$measures)
  tt <- r1$diagnostics$targetTrial
  v <- function(name) vcr_measure_value(r1, name)
  pe2 <- local({ fr <- .vcr_tt_frame(list(long = long), sc); .vcr_tt_people(fr) })
  hand <- .vcr_tt_run_ccw(pe2, 3L, 12L, 3L, rep(1, pe2$n))
  est_ok <- abs(v("risk_difference_pp") - (hand$risks[12, "treated"] - hand$risks[12, "control"])) < 1e-12
  said <- identical(tt$strategy, "clone_censor_weight") && identical(tt$estimands[[1]]$label, "per_protocol") && identical(tt$horizon, 12L) && identical(tt$periodUnit, "weeks") &&
    tt$design$gracePeriod == 3L && tt$design$startedWithinGrace + tt$design$startedAfterGrace + tt$design$neverStarted == pe2$n && !is.null(tt$design$naive$difference) &&
    length(r1$diagnostics$curves) == 2L && file.exists(file.path(dir, "risk-by-period.csv")) && r1$replicates >= 200L
  # a horizon longer than anyone was followed, a grace period that nobody satisfies, nobody eligible
  far <- vcr_test_run(mk(utils::modifyList(sc, list(horizon = 25L))))
  far_ok <- identical(far$status, "not_estimable") && identical(far$notEstimableRule, "horizon_beyond_followup")
  none_elig <- long[long$PARAMCD != "eligible" | long$AVAL == 0, ]
  ne <- vcr_test_run(mk(sc, tab = none_elig, id = "n80b0"))
  ne_ok <- identical(ne$status, "not_estimable") && identical(ne$notEstimableRule, "no_eligible_person_trials")
  Sys.setenv(VCR_ENGINE_MAX_PERSON_PERIODS = "300"); on.exit(Sys.unsetenv("VCR_ENGINE_MAX_PERSON_PERIODS"), add = TRUE)
  refused <- vcr_test_run(mk(sc)); Sys.unsetenv("VCR_ENGINE_MAX_PERSON_PERIODS")
  cap_ok <- identical(refused$status, "failed") && "too_many_person_periods" %in% vcr_test_issue_codes(refused)
  ok <- identical(r1$status, "succeeded") && est_ok && same && said && far_ok && ne_ok && cap_ok
  list(pass = ok,
       detail = sprintf("250 people: %s, risk difference %.4f (interval %.4f to %.4f) = the pieces by hand to 1e-12; started within the grace period %d, after it %d, never %d; naive difference %.4f beside it; estimand per protocol, 12 weeks; one and two cores one hash: %s; a horizon of 25 beyond follow-up: %s; nobody eligible: %s; a cap of 300 rows refuses by name: %s",
                        r1$status, v("risk_difference_pp"), vcr_get_measure(r1, "risk_difference_pp")$interval$low, vcr_get_measure(r1, "risk_difference_pp")$interval$high,
                        tt$design$startedWithinGrace, tt$design$startedAfterGrace, tt$design$neverStarted, tt$design$naive$difference, same, far_ok, ne_ok, cap_ok))
})

vcr_case("N80c", c("AC-07", "AC-30"), function() {
  # The bytes the data plane derives from a person-period file (apps/server/test/vcrPersonPeriodIntake.test.mjs writes and holds this fixture: the field map
  # names the period `visit_date` and the treatment, the outcome, the eligibility and the age `measurement`s) pass the engine's intake and the job's
  # input checks, and a clone-censor-weight job and an intention-to-treat sequence of trials run on them.
  path <- normalizePath(file.path(VCR_ROOT, "..", "..", "OpenScience", "apps", "server", "test", "fixtures", "vcr-person-period", "longitudinal.csv"), mustWork = FALSE)
  if (!file.exists(path)) return(list(pass = FALSE, detail = "the data plane's derived longitudinal fixture is missing"))
  long <- utils::read.csv(path, stringsAsFactors = FALSE)
  inp <- list(vcr_test_input(long, "snp_n80c:longitudinal", "long"))
  base <- list(covariates = list("age"), horizon = 4L)
  ccw <- vcr_test_run(vcr_test_job("comparator.target_trial", c(base, list(strategy = list(kind = "clone_censor_weight", gracePeriod = 2L))), inp, seed = 3L, job_id = "job_n80c1"))
  seq <- vcr_test_run(vcr_test_job("comparator.target_trial", c(base, list(strategy = list(kind = "sequential", estimand = "itt"))), inp, seed = 3L, job_id = "job_n80c2"))
  pp <- length(unique(paste(long$USUBJID, long$ADT)))
  persons <- length(unique(long$USUBJID))
  ok <- identical(ccw$status, "succeeded") && identical(seq$status, "succeeded") && ccw$counts$realPatients == persons && seq$counts$realPatients == persons &&
    !is.null(vcr_get_measure(ccw, "risk_difference_pp")) && !is.null(vcr_get_measure(seq, "risk_difference_itt")) && is.null(vcr_get_measure(seq, "risk_difference_pp"))
  list(pass = ok, detail = sprintf("%d person-periods of %d people as the data plane derived them (%d rows, one per person, period and parameter): clone-censor-weight %s, risk difference %.4f; intention-to-treat sequence %s, risk difference %.4f",
                                   pp, persons, nrow(long), ccw$status, vcr_measure_value(ccw, "risk_difference_pp"), seq$status, vcr_measure_value(seq, "risk_difference_itt")))
})
