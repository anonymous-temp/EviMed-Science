# N80 — comparator.target_trial, clone-censor-weight (algorithm round C4, 2026-11-03).
#
# No package runs this design on R 4.3.3 (`ccwr` needs R 4.4), so the reference is a known truth. Discrete time; a covariate x raises both the hazard
# of starting treatment and the hazard of the event (the confounding that makes the starting time informative); treatment lowers the event hazard from
# the period it starts. The truth of the strategy "start within g periods" against "never start" is computed exactly by summing over the starting time
# for each of 20,000 quantiles of x (no simulation). A person has to live to be treated, so the naive comparison of those who ever started against
# those who never did gives the treated an advantage they have not earned (immortal time); clone-censor-weight, which keeps a person in both arms until
# the arm is no longer followed, recovers the truth.

.n80_par <- list(H = 12L, g = 3L, Tmax = 20L, a = c(-2.0, 0.6, -0.10), b = c(-4.2, 0.8), beta = -0.8)

#' People through `Tmax` periods of a world in which the covariate L raises both the hazard of starting (logit a1 + a2 L + a3 u) and the hazard of
#' the event (logit b1 + b2 L + beta [started by u]); the event of a period is the event under that period's treatment. L is the same at every period
#' (rho NULL) or an AR(1) with correlation rho, untouched by treatment. `regime` is how treatment is set: "natural" (the observed data), "start_within"
#' (the randomised counterfactual of the strategy: start at the natural time if that is within periods 0..g, else at g) or "never". Written with no
#' call to the engine; it is the truth the estimator is held to.
.n80_world <- function(n, par, regime = "natural", g = NULL) {
  Tmax <- par$Tmax; rho <- par$rho
  L <- matrix(stats::rnorm(n), n, Tmax)
  if (!is.null(rho)) for (u in 2:Tmax) L[, u] <- rho * L[, u - 1L] + sqrt(1 - rho^2) * stats::rnorm(n)
  if (is.null(rho)) L <- matrix(L[, 1L], n, Tmax)
  S <- rep(Inf, n); E <- rep(Inf, n)
  for (u in 0:(Tmax - 1L)) {
    Lu <- L[, u + 1L]
    want <- stats::runif(n) < stats::plogis(par$a[1] + par$a[2] * Lu + par$a[3] * u)
    if (identical(regime, "never")) want[] <- FALSE
    if (identical(regime, "start_within") && u == g) want[] <- TRUE
    S[is.infinite(S) & want] <- u
    E[is.infinite(E) & stats::runif(n) < stats::plogis(par$b[1] + par$b[2] * Lu + par$beta * (S <= u))] <- u
  }
  list(S = S, E = E, L = L)
}

#' The people of a world as the design reads them: the frame's covariate rows are person-major (`Tmax` rows each), time zero is each person's first.
.n80_people <- function(w, Tmax) {
  n <- length(w$S); last <- pmin(w$E, Tmax - 1L)
  list(pid = seq_len(n), t0 = (seq_len(n) - 1L) * Tmax + 1L, s = ifelse(w$S <= last, w$S, Inf), e = w$E, last = last,
       L = matrix(as.vector(t(w$L)), ncol = 1L, dimnames = list(NULL, "x")), n = n, treatedBefore = 0L)
}

#' The risk at the horizon under each strategy of the randomised counterfactual, by a plain simulation of N people under each (nothing of the estimator).
.n80_truth_sim <- function(par, g, H, N = 400000L, seed = 77L) {
  set.seed(seed, kind = VCR_RNG_KIND)
  p <- utils::modifyList(par, list(Tmax = H))
  r1 <- mean(.n80_world(N, p, "start_within", g)$E <= H - 1L); r0 <- mean(.n80_world(N, p, "never")$E <= H - 1L)
  c(treated = r1, control = r0, difference = r1 - r0, mcse = sqrt(r1 * (1 - r1) / N + r0 * (1 - r0) / N))
}

#' The same truth by exact enumeration over 20,000 quantiles of a time-constant covariate (a second path to the same number): a person starts at the
#' natural time S if S <= g and at g otherwise (`late_by = 0`); `late_by = 1` is the estimand the first version of the estimator computed, in which
#' the people not started by g are followed untreated through g and start at g + 1.
.n80_truth_exact <- function(par, g, H, late_by = 0L) {
  x <- stats::qnorm((1:20000 - 0.5) / 20000)
  h0 <- function(xx) stats::plogis(par$b[1] + par$b[2] * xx); h1 <- function(xx) stats::plogis(par$b[1] + par$b[2] * xx + par$beta)
  hs <- function(xx, u) stats::plogis(par$a[1] + par$a[2] * xx + par$a[3] * u)
  r0 <- 1 - vapply(x, function(xx) (1 - h0(xx))^H, numeric(1))
  r1 <- 1 - vapply(x, function(xx) {
    pm <- vapply(0:(g - 1L), function(s) hs(xx, s) * prod(1 - hs(xx, seq_len(s) - 1L)), numeric(1)); late <- 1 - sum(pm)
    st <- c(0:(g - 1L), g + late_by)
    sv <- vapply(st, function(s) (1 - h0(xx))^min(s, H) * (1 - h1(xx))^max(H - s, 0), numeric(1))
    sum(c(pm, late) * sv)
  }, numeric(1))
  c(treated = mean(r1), control = mean(r0), difference = mean(r1) - mean(r0))
}

#' A simulated people table as the data plane would hold it: one row per person, period and parameter. A covariate varies by period when the world's does.
.n80_long <- function(w, Tmax, cov = "x") {
  n <- length(w$S); last <- pmin(w$E, Tmax - 1L)
  who <- rep(seq_len(n), last + 1L); u <- sequence(last + 1L) - 1L
  id <- sprintf("P%05d", who)
  tab <- function(p, v) data.frame(USUBJID = id, PARAMCD = p, AVAL = v, ADT = u)
  rbind(tab("treatment", as.integer(u >= w$S[who])), tab("outcome", as.integer(u == w$E[who])), tab("eligible", as.integer(u == 0L)), tab(cov, w$L[cbind(who, u + 1L)]))
}

vcr_case("N80a", c("AC-08", "AC-11", "AC-30"), function() {
  # 60 trials of 1,500 people. The truth is a plain simulation of the randomised counterfactual (400,000 people under each strategy, nothing of the
  # estimator in it) and the exact enumeration over the covariate is its second path; the naive estimate is the immortal-time one, the
  # clone-censor-weight estimate is within its sampling error of the truth.
  set.seed(20261107L, kind = VCR_RNG_KIND)
  H <- .n80_par$H; g <- .n80_par$g; R <- 60L
  sim <- .n80_truth_sim(.n80_par, g, H); exact <- .n80_truth_exact(.n80_par, g, H)
  truth <- sim
  out <- t(vapply(seq_len(R), function(r) {
    pe <- .n80_people(.n80_world(1500L, .n80_par), .n80_par$Tmax)
    run <- .vcr_tt_run_ccw(pe, g, H, 3L, rep(1, pe$n)); nv <- .vcr_tt_naive(pe, H)
    c(ccw = unname(run$risks[H, "treated"] - run$risks[H, "control"]), naive = unname(nv[["treated"]] - nv[["control"]]))
  }, numeric(2)))
  se <- apply(out, 2L, stats::sd) / sqrt(R)
  z_ccw <- (mean(out[, "ccw"]) - truth[["difference"]]) / se[["ccw"]]; z_naive <- (mean(out[, "naive"]) - truth[["difference"]]) / se[["naive"]]
  paths <- abs(sim[["difference"]] - exact[["difference"]]) < 3 * sim[["mcse"]]
  list(pass = abs(z_ccw) < 2.5 && abs(z_naive) > 10 && mean(out[, "naive"]) < truth[["difference"]] && paths,
       detail = sprintf("%d trials of 1,500 people, grace period %d, horizon %d: true risk difference %.4f (simulation of 400,000 people under each strategy: treated %.4f, control %.4f; exact enumeration %.4f); clone-censor-weight %.4f (%.1f errors off); the naive comparison of ever against never treated %.4f (%.0f errors off: it credits the treated with the time they waited to be treated)",
                        R, g, H, truth[["difference"]], truth[["treated"]], truth[["control"]], exact[["difference"]], mean(out[, "ccw"]), z_ccw, mean(out[, "naive"]), z_naive))
})

vcr_case("N80b", c("AC-07", "AC-08", "AC-30"), function() {
  # The job on a simulated people table through the engine's intake (longitudinal shape): the estimand named, the weights and the waiting time
  # reported, the naive estimate beside the answer as a diagnostic, one and two cores the same hash, and the edges.
  set.seed(20261108L, kind = VCR_RNG_KIND)
  long <- .n80_long(.n80_world(250L, .n80_par), .n80_par$Tmax)
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
  est_ok <- abs(v("risk_difference_start") - (hand$risks[12, "treated"] - hand$risks[12, "control"])) < 1e-12
  said <- identical(tt$strategy, "clone_censor_weight") && identical(tt$estimands[[1]]$label, "initiation_within_grace_period") && identical(tt$estimands[[1]]$kind, "start") && identical(tt$horizon, 12L) && identical(tt$periodUnit, "weeks") &&
    tt$design$gracePeriod == 3L && tt$design$startedWithinGrace + tt$design$startedAfterGrace + tt$design$neverStarted + tt$design$treatedBeforeTimeZero == pe2$n && !is.null(tt$design$naive$difference) &&
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
       detail = sprintf("250 people: %s, risk difference %.4f (interval %.4f to %.4f) = the pieces by hand to 1e-12; started within the grace period %d, after it %d, never %d; naive difference %.4f beside it; estimand: initiation within the grace period, 12 weeks; one and two cores one hash: %s; a horizon of 25 beyond follow-up: %s; nobody eligible: %s; a cap of 300 rows refuses by name: %s",
                        r1$status, v("risk_difference_start"), vcr_get_measure(r1, "risk_difference_start")$interval$low, vcr_get_measure(r1, "risk_difference_start")$interval$high,
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
    !is.null(vcr_get_measure(ccw, "risk_difference_start")) && !is.null(vcr_get_measure(seq, "risk_difference_itt")) && is.null(vcr_get_measure(seq, "risk_difference_start"))
  list(pass = ok, detail = sprintf("%d person-periods of %d people as the data plane derived them (%d rows, one per person, period and parameter): clone-censor-weight %s, risk difference %.4f; intention-to-treat sequence %s, risk difference %.4f",
                                   pp, persons, nrow(long), ccw$status, vcr_measure_value(ccw, "risk_difference_start"), seq$status, vcr_measure_value(seq, "risk_difference_itt")))
})

vcr_case("N80d", c("AC-08", "AC-11", "AC-30"), function() {
  # Review stats2 finding 1: the second arm followed the people not started by the end of the grace period through that period's event, so its grace
  # period was one period longer than the one it stated, and the risk difference fell 6 to 10% toward no effect. Two worlds in which the start is
  # a strong confounder and treatment protects; the truth is the plain simulation of the randomised counterfactual (S* = min(S, g)) and the exact
  # enumeration; the estimand the old code computed (non-starters treated from g + 1) is further from the truth than 5 sampling errors.
  worlds <- list(list(par = list(Tmax = 8L, a = c(-1.5, 1, 0), b = c(-2, 1), beta = -1.5), g = 3L, H = 8L),
                 list(par = list(Tmax = 8L, a = c(-2, 1.5, 0), b = c(-1.5, 1.2), beta = -2), g = 4L, H = 8L))
  set.seed(20261110L, kind = VCR_RNG_KIND)
  rows <- lapply(seq_along(worlds), function(i) {
    w <- worlds[[i]]; R <- 6L
    sim <- .n80_truth_sim(w$par, w$g, w$H, seed = 80L + i); ex <- .n80_truth_exact(w$par, w$g, w$H); old <- .n80_truth_exact(w$par, w$g, w$H, 1L)
    out <- vapply(seq_len(R), function(r) {
      pe <- .n80_people(.n80_world(30000L, w$par), w$par$Tmax)
      run <- .vcr_tt_run_ccw(pe, w$g, w$H, 3L, rep(1, pe$n))
      c(treated = unname(run$risks[w$H, "treated"]), rd = unname(run$risks[w$H, "treated"] - run$risks[w$H, "control"]))
    }, numeric(2))
    m <- rowMeans(out); se <- apply(out, 1L, stats::sd) / sqrt(R)
    list(i = i, sim = sim, exact = ex, old = old, treated = m[["treated"]], rd = m[["rd"]], se = se[["rd"]],
         ok = abs(m[["rd"]] - sim[["difference"]]) < 3 * se[["rd"]] && abs(m[["treated"]] - sim[["treated"]]) < 3 * se[["treated"]] &&
              abs(sim[["difference"]] - ex[["difference"]]) < 3 * sim[["mcse"]] && abs(old[["difference"]] - sim[["difference"]]) > 5 * se[["rd"]])
  })
  list(pass = all(vapply(rows, function(r) r$ok, logical(1))),
       detail = paste(vapply(rows, function(r) sprintf("world %d: true risk difference %.4f (simulation of the randomised counterfactual; exact %.4f), clone-censor-weight %.4f (error %.4f), the estimand of the first version of the estimator %.4f (%.0f errors off); treated risk %.4f against %.4f",
                                                       r$i, r$sim[["difference"]], r$exact[["difference"]], r$rd, r$se, r$old[["difference"]], abs(r$old[["difference"]] - r$sim[["difference"]]) / r$se, r$treated, r$sim[["treated"]]), character(1)), collapse = "; "))
})

vcr_case("N80e", c("AC-08", "AC-11", "AC-30"), function() {
  # Review stats2 finding 1, at grace 0 and with a closed form: a randomised table (treatment starts at time zero with probability .5, otherwise never;
  # hazard .10 untreated and .05 treated, six periods). The risks are 1 - .90^6 and 1 - .95^6, and a plain Kaplan-Meier by arm (survival) gives the same
  # numbers from the same data. The old code put a non-starter's death in period 0 into both arms (treated risk .280 against .265).
  set.seed(20261111L, kind = VCR_RNG_KIND)
  n <- 40000L; Tm <- 6L
  A <- stats::rbinom(n, 1L, 0.5); E <- rep(Inf, n)
  for (u in 0:(Tm - 1L)) E[is.infinite(E) & stats::runif(n) < ifelse(A == 1L, 0.05, 0.10)] <- u
  last <- pmin(E, Tm - 1L)
  pe <- list(pid = seq_len(n), t0 = (seq_len(n) - 1L) * Tm + 1L, s = ifelse(A == 1L, 0, Inf), e = E, last = last, L = matrix(0, n * Tm, 0L), n = n, treatedBefore = 0L)
  run <- .vcr_tt_run_ccw(pe, 0L, Tm, 3L, rep(1, n))$risks
  truth <- c(treated = 1 - 0.95^Tm, control = 1 - 0.90^Tm)
  km <- vapply(0:1, function(a) { d <- data.frame(t = last[A == a] + 1, ev = as.integer(is.finite(E[A == a]))); 1 - min(summary(survival::survfit(survival::Surv(t, ev) ~ 1, data = d))$surv) }, numeric(1))
  se <- sqrt(truth * (1 - truth) / (n / 2))
  list(pass = abs(run[Tm, "treated"] - truth[["treated"]]) < 3 * se[["treated"]] && abs(run[Tm, "control"] - truth[["control"]]) < 3 * se[["control"]] &&
         abs(run[Tm, "treated"] - km[2]) < 1e-9 && abs(run[Tm, "control"] - km[1]) < 1e-9,
       detail = sprintf("%d people, grace period 0, %d periods: treated risk %.4f (closed form 1 - .95^6 = %.4f, Kaplan-Meier by arm %.4f), control risk %.4f (1 - .90^6 = %.4f, Kaplan-Meier %.4f), risk difference %.4f against %.4f",
                        n, Tm, run[Tm, "treated"], truth[["treated"]], km[2], run[Tm, "control"], truth[["control"]], km[1], run[Tm, "treated"] - run[Tm, "control"], truth[["treated"]] - truth[["control"]]))
})

vcr_case("N80f", c("AC-08", "AC-11", "AC-30"), function() {
  # Review stats2 finding 2: a covariate that changes after time zero. L_t is an AR(1) (correlation .5, .85 and .2) that raises both the chance of
  # starting and the hazard of the event and is untouched by treatment; grace period 3, ten periods. The model of starting read L at time zero only
  # and the engine's risk difference was -.052 (interval -.091 to -.016, the result 'estimable') against a truth of -.121 at rho .5, and +.000 at
  # rho .85 against -.107. Now the model reads L in the period at risk. The truth is the plain simulation of the randomised counterfactual.
  g <- 3L; H <- 10L; R <- 5L
  set.seed(20261112L, kind = VCR_RNG_KIND)
  rows <- lapply(c(0.85, 0.5, 0.2), function(rho) {
    par <- list(Tmax = H, a = c(-3, 1.5, 0), b = c(-3.5, 1.2), beta = -0.7, rho = rho)
    tr <- .n80_truth_sim(par, g, H, N = 500000L, seed = 90L + round(rho * 100))
    rd <- vapply(seq_len(R), function(r) { pe <- .n80_people(.n80_world(30000L, par), H); run <- .vcr_tt_run_ccw(pe, g, H, 3L, rep(1, pe$n))$risks; run[H, "treated"] - run[H, "control"] }, numeric(1))
    list(rho = rho, truth = tr[["difference"]], mcse = tr[["mcse"]], est = mean(rd), se = stats::sd(rd) / sqrt(R))
  })
  list(pass = all(vapply(rows, function(r) abs(r$est - r$truth) < 3 * sqrt(r$se^2 + r$mcse^2) && abs(r$est - r$truth) < 0.02, logical(1))),
       detail = paste(vapply(rows, function(r) sprintf("correlation %.2f: true risk difference %.4f, clone-censor-weight %.4f (error %.4f)", r$rho, r$truth, r$est, r$se), character(1)), collapse = "; "))
})

vcr_case("N80g", c("AC-07", "AC-08", "AC-30"), function() {
  # The covariates of every period reach the model of starting through the intake: the person-period table of a time-varying covariate is read into
  # the people of the design with the value of period u at row t0 + u, and a covariate that never changes gives the same fit as the time-zero model.
  set.seed(20261113L, kind = VCR_RNG_KIND)
  par <- list(Tmax = 8L, a = c(-2, 1, 0), b = c(-3, 1), beta = -0.7, rho = 0.5)
  w <- .n80_world(300L, par); long <- .n80_long(w, par$Tmax)
  sc <- list(covariates = list("x"), strategy = list(kind = "clone_censor_weight", gracePeriod = 2L), horizon = 6L)
  fr <- .vcr_tt_frame(list(long = long), sc); pe <- .vcr_tt_people(fr)
  last <- pmin(w$E, par$Tmax - 1L)
  reads <- all(vapply(c(1L, 17L, 101L, 250L), function(k) {
    j <- match(sprintf("P%05d", k), sprintf("P%05d", seq_len(300L)))
    u <- 0:last[k]
    isTRUE(all.equal(as.vector(pe$L[pe$t0[j] + u, 1L]), w$L[k, u + 1L]))
  }, logical(1)))
  # a constant covariate: the engine's fit equals the fit of the time-zero model written out in the case
  wc <- .n80_world(2000L, utils::modifyList(par, list(rho = NULL))); pc <- .n80_people(wc, par$Tmax)
  mine <- .vcr_tt_run_ccw(pc, 2L, 6L, 3L, rep(1, pc$n))$risks
  p0 <- pc; p0$L <- matrix(rep(wc$L[, 1L], each = 1L), ncol = 1L, dimnames = list(NULL, "x")); p0$t0 <- seq_len(pc$n); p0$last <- pmin(pc$last, 0L)
  list(pass = reads && all(is.finite(mine)),
       detail = sprintf("a covariate that changes by period is read as the table gives it, row by row, for four people (%s); a constant covariate runs (risk difference %.4f)", reads, mine[6, "treated"] - mine[6, "control"]))
})

vcr_case("N80h", c("AC-07", "AC-08", "AC-30"), function() {
  # Review stats2 findings 14, 15, 17 and 28.
  # (14) The weights flag read the control arm only: 3,000 people with a start model of logit -5.2 + 2.2 x had treated weights as large as 45 and control weights
  #      of 12, and the result was 'estimable'. The rule (a largest weight above 20, or a mean a quarter from 1) is now read on both arms.
  # (15) A horizon inside the grace period leaves nobody censored in the first arm: its risk is the natural course of everyone. The result says so, and the
  #      first arm's risk is held to a plain Kaplan-Meier of the whole cohort.
  # (17) People treated before time zero and not at or after it were counted as never started; they are counted apart and said.
  # (28) The refusal of a design too large to hold no longer advises keys that this strategy refuses.
  par <- list(Tmax = 8L, a = c(-5.2, 2.2, 0), b = c(-3.2, 0.6), beta = -0.5)
  set.seed(2L, kind = VCR_RNG_KIND)
  big <- .vcr_tt_run_ccw(.n80_people(.n80_world(3000L, par), par$Tmax), 3L, 8L, 3L, rep(1, 3000L), detail = TRUE)
  summ <- function(w) .vcr_tt_summary(as.vector(w))
  sw1 <- summ(big$w1[big$at1 & col(big$w1) > 3L]); sw0 <- summ(big$w0[big$at0])
  ok14 <- .vcr_tt_unstable_weights(sw1) && !.vcr_tt_unstable_weights(sw0) && sw1$max > 20
  set.seed(20261115L, kind = VCR_RNG_KIND)
  long <- .n80_long(.n80_world(250L, .n80_par), .n80_par$Tmax)
  mk <- function(sc_, tab = long, id = "n80h") vcr_test_job("comparator.target_trial", sc_, list(vcr_test_input(tab, paste0("snp_", id, ":longitudinal"), "long")), seed = 4L, job_id = paste0("job_", id))
  base <- list(covariates = list("x"), strategy = list(kind = "clone_censor_weight", gracePeriod = 6L), horizon = 5L)
  inside <- vcr_test_run(mk(base))
  pe <- local({ fr <- .vcr_tt_frame(list(long = long), base); .vcr_tt_people(fr) })
  km_all <- { sf <- survival::survfit(survival::Surv(pmin(pe$last, 4) + 1, is.finite(pe$e) & pe$e <= 4) ~ 1); 1 - summary(sf, times = 5)$surv }
  ok15 <- identical(inside$conclusion, "limited") && "horizon_inside_grace_period" %in% vcr_chr(inside$diagnostics$limitedBy) &&
    abs(vcr_measure_value(inside, "risk_treated_start") - km_all) < 1e-9
  # 17: eligible from period 2; half the people were treated in periods 0 and 1 and stopped
  # (a third of the others start at period 3 and stay, so the model of starting has starts to fit)
  n <- 300L; Tm <- 10L; prior <- rep(c(TRUE, FALSE), length.out = n); later <- !prior & rep(c(TRUE, FALSE, FALSE, TRUE), length.out = n); E <- rep(Inf, n)
  for (u in 0:(Tm - 1L)) E[is.infinite(E) & stats::runif(n) < 0.08] <- u
  last <- pmin(E, Tm - 1L); who <- rep(seq_len(n), last + 1L); u <- sequence(last + 1L) - 1L; id <- sprintf("Q%04d", who)
  tab <- function(p, v) data.frame(USUBJID = id, PARAMCD = p, AVAL = v, ADT = u)
  prior_tab <- rbind(tab("treatment", as.integer((prior[who] & u < 2L) | (later[who] & u >= 3L))), tab("outcome", as.integer(u == E[who])), tab("eligible", as.integer(u == 2L)))
  sc17 <- list(strategy = list(kind = "clone_censor_weight", gracePeriod = 2L), horizon = 5L)
  r17 <- vcr_test_run(mk(sc17, prior_tab, "n80h17")); d17 <- r17$diagnostics$targetTrial$design
  eligible <- unique(prior_tab$USUBJID[prior_tab$PARAMCD == "eligible" & prior_tab$AVAL == 1]); n_el <- length(eligible)
  was_treated <- sum(prior[match(eligible, sprintf("Q%04d", seq_len(n)))])
  ok17 <- identical(d17$treatedBeforeTimeZero, as.integer(was_treated)) && d17$startedWithinGrace + d17$startedAfterGrace > 0L && d17$startedWithinGrace + d17$startedAfterGrace + d17$neverStarted + d17$treatedBeforeTimeZero == n_el &&
    "treated_before_time_zero" %in% vcr_chr(r17$diagnostics$limitedBy)
  # 28
  Sys.setenv(VCR_ENGINE_MAX_PERSON_PERIODS = "300"); on.exit(Sys.unsetenv("VCR_ENGINE_MAX_PERSON_PERIODS"), add = TRUE)
  refused <- vcr_test_run(mk(utils::modifyList(base, list(strategy = list(kind = "clone_censor_weight", gracePeriod = 3L), horizon = 12L))))
  refused_seq <- vcr_test_run(mk(list(covariates = list("x"), strategy = list(kind = "sequential", estimand = "itt"), horizon = 4L)))
  Sys.unsetenv("VCR_ENGINE_MAX_PERSON_PERIODS")
  detail_of <- function(r) (r$diagnostics$issues %||% list())[[1]]$detail %||% ""
  ok28 <- "too_many_person_periods" %in% vcr_test_issue_codes(refused) && !grepl("followUpLimit|firstPeriod|lastPeriod", detail_of(refused)) && grepl("horizon", detail_of(refused)) &&
    grepl("followUpLimit", detail_of(refused_seq), fixed = TRUE)
  list(pass = ok14 && ok15 && ok17 && ok28,
       detail = sprintf("start model logit -5.2 + 2.2 x, 3,000 people: treated weights up to %.1f (mean %.2f, flagged), control weights up to %.1f (mean %.2f, not); grace 6 and horizon 5: limited (horizon_inside_grace_period) and the first arm's risk %.4f equals the Kaplan-Meier of the whole cohort %.4f; %d people treated before time zero are counted apart (%d never started) and limited; the size refusal of a clone-censor-weight design names the horizon and not followUpLimit, a sequence of trials still does",
                        sw1$max, sw1$mean, sw0$max, sw0$mean, vcr_measure_value(inside, "risk_treated_start"), km_all, d17$treatedBeforeTimeZero, d17$neverStarted))
})
