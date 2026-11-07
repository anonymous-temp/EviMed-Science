# ---------------------------------------------------------------------------
# target_trial.R — comparator.target_trial: target-trial emulation from a person-period table (algorithm round C3, C4, 2026-11-03).
#
# The question it answers: "in a cohort whose treatment starts at different times, what is the effect of starting against not starting, without
# immortal-time bias?" The answer is a RISK DIFFERENCE at a stated follow-up horizon, and the result says which estimand it is (intention-to-treat or
# per-protocol, at how many periods).
#
# Hidden knowledge:
#
# - **The table is the data plane's longitudinal shape.** One row per person, period and parameter (`USUBJID`, `PARAMCD`, `AVAL`, and `ADT` = the
#   period number, a whole number), which is exactly what a file with one row per person-period and a visit column becomes in the data plane (the
#   `measurement` and `visit_date` roles). The scenario names the parameters that are the treatment, the outcome and the eligibility, and the
#   covariates. This file pivots it to a person-period frame. A person's record ends at the first event (an event is absorbing), at the first period
#   with a missing required value and at the first gap in the periods: the follow-up simply stops there, the counts are in `checks`, and nothing is
#   filled in.
# - **`sequential` is Danaei et al. (2013) / Hernan & Robins (2016): one trial for every period in which a person is eligible.** The arm is the
#   treatment at that period, the follow-up runs from it to the end of the person's record, and a person is in as many trials as they have eligible
#   periods (so the bootstrap resamples PEOPLE, never person-trials). Intention to treat ignores what happens after baseline; per protocol censors a
#   person at the first period their treatment departs from the arm (the period of the departure is not counted, as in TrialEmulation) and weights
#   by the stabilised inverse probability of the treatment actually received, cumulated from the trial's baseline (separate logistic models for who was
#   treated and who was not at the previous period, numerator on the stabilising covariates, denominator on all of them as they stand at the period).
#   The outcome is one pooled logistic model over all person-trial-periods (arm, follow-up time, trial period, baseline covariates; the arm by
#   follow-up interaction on request). The effect is read off the standardised cumulative incidence: the model's risk under each arm for everyone who
#   was eligible at any trial start, averaged, at the horizon.
# - **`clone_censor_weight` is the grace-period strategy ("start within g periods of time zero" against "do not start")**, which a sequence of trials
#   cannot ask. Time zero is the first eligible period. Every person is cloned into both arms and followed from it: the clone of the first arm is
#   censored at the end of the grace period if treatment has not started; the clone of the second is censored when it does. A person who has the
#   event before either happens is in both arms until then, so nobody is made immortal by having to survive to be treated. The artificial censoring
#   is undone by weights from one discrete-time model of starting treatment (baseline covariates and the period since time zero): the second arm's
#   weight at a period is the inverse probability of not having started by then, the first arm's is, after the grace period, the inverse probability
#   of having started within it. Both are stabilised by the same model without covariates. The arms' risks are weighted discrete-time life tables.
#   The model of starting reads the covariates AS THEY STAND IN THE PERIOD AT RISK (a covariate that never changes is its time-zero value), and the
#   second arm's weight after the grace period uses the covariate path to its end, which assumes the treatment does not change the covariates
#   (a covariate the treatment moves is read wrongly: the premises say so). The grace period is the periods 0..g: the last chance to start is the
#   start of period g, and a person who has not started by then has left the second arm before period g's event (the event of a period is the event
#   under that period's treatment), so the arm is "start at the natural time if that is within the window, else at g".
# - **The horizon must lie inside the follow-up of each arm and of each estimand.** An intention-to-treat risk is read where some trial of each arm was
#   followed to the horizon, a per-protocol one where some trial of each arm was on protocol to it; an estimand the follow-up cannot carry is left out and
#   named (`droppedEstimands`, limited) while the other is kept, and when it is the only one asked the job is not estimable by name.
# - **An arm with no event has no risk the data can measure.** A model fitted to it returns a number set by its penalty, and every resample of it gives
#   the same zero, so no interval of its risk, of the difference or of the ratio is drawn from the resamples; the exact upper limit of 0 events among n
#   people is stated instead (`armsWithoutEvents`) and the result is limited.
# - **Every number is the engine's, and the naive estimate is only a diagnostic.** The result carries, beside the estimate, the naive comparison that
#   classifies people by whether they ever started (the immortal-time estimate) so a reader sees how much time was waited for; it is a check, never
#   an estimate. Checks of the input (eligibility already treated, immortal waiting time, records cut short) are diagnostics, never gates.
# - **Memory is 3 GiB, so the size is refused by name.** The expanded table of a sequence of trials is the person-periods times the follow-up they can
#   still contribute (TrialEmulation's own example, 48,400 person-periods, expands to 1.9 million rows and used 1.26 GB; 242,000 failed under 3 GiB).
#   The engine counts the expanded rows from the table before it builds them and refuses a table past the cap with `too_many_person_periods`; the cap
#   is set from a measurement of this implementation under `ulimit -v 3145728` (README), and `VCR_ENGINE_MAX_PERSON_PERIODS` lowers it.
# - **The bootstrap is a cluster bootstrap with case weights.** A resample of people is a count per person; the weight models, the outcome model and
#   the standardisation are refitted with those counts as case weights, which is the resampled data set without building it. A budget that runs out
#   keeps the draws that finished (limited, with the number) once there are 200 of them.
# ---------------------------------------------------------------------------

#' The cap on the rows a target-trial emulation expands to (person-trial-periods, twice the person-periods of a clone-censor-weight design),
#' measured under 3 GiB of address space (see README). `VCR_ENGINE_MAX_PERSON_PERIODS` lowers it, never raises it.
VCR_TARGET_TRIAL_ROW_CAP <- 1000000

.vcr_tt_cap <- function() min(VCR_TARGET_TRIAL_ROW_CAP, .vcr_env_num("VCR_ENGINE_MAX_PERSON_PERIODS", VCR_TARGET_TRIAL_ROW_CAP))

#' Weights models and the outcome model: a weighted logistic regression by iteratively reweighted least squares on standardised columns
#' (an intercept column first), so that raw periods and their squares do not make the normal equations ill-conditioned. A fit that separates is
#' refitted with a ridge. Returns the coefficients on the original columns.
.vcr_tt_logit <- function(X, y, w = NULL, ridge = 0, maxit = 50L) {
  n <- nrow(X); p <- ncol(X)
  if (is.null(w)) w <- rep(1, n)
  keep <- w > 0
  if (!all(keep)) { X <- X[keep, , drop = FALSE]; y <- y[keep]; w <- w[keep] }
  mu_x <- c(0, colSums(X[, -1L, drop = FALSE] * w) / sum(w))
  sd_x <- c(1, sqrt(pmax(colSums((X[, -1L, drop = FALSE]^2) * w) / sum(w) - mu_x[-1L]^2, 0)))
  sd_x[sd_x < 1e-12] <- 1
  Z <- sweep(sweep(X, 2L, mu_x, "-"), 2L, sd_x, "/"); Z[, 1L] <- 1
  pen <- diag(c(0, rep(ridge, p - 1L)), p)
  bz <- rep(0, p); bz[1L] <- stats::qlogis(min(max(sum(w * y) / sum(w), 1e-6), 1 - 1e-6))
  ok <- FALSE
  for (it in seq_len(maxit)) {
    eta <- as.vector(Z %*% bz); mu <- stats::plogis(eta)
    ww <- w * pmax(mu * (1 - mu), 1e-10)
    A <- crossprod(Z, Z * ww) + pen
    step <- tryCatch(solve(A, crossprod(Z, w * (y - mu)) - pen %*% bz), error = function(e) NULL)
    if (is.null(step)) break
    bz <- bz + as.vector(step)
    if (max(abs(step)) < 1e-9) { ok <- TRUE; break }
  }
  beta <- bz / sd_x
  beta[1L] <- bz[1L] - sum(bz[-1L] * mu_x[-1L] / sd_x[-1L])
  list(beta = beta, ok = ok && is.finite(sum(beta)), separated = max(abs(bz)) > 15)
}

#' A fit of `.vcr_tt_logit` that falls back to a ridge when the plain fit separates or fails; NULL when there is nothing to fit.
.vcr_tt_fit <- function(X, y, w) {
  if (nrow(X) < 2L || sum(w > 0) < 2L) return(NULL)
  f <- .vcr_tt_logit(X, y, w)
  if (!isTRUE(f$ok) || isTRUE(f$separated)) f <- .vcr_tt_logit(X, y, w, ridge = 1e-2)
  if (!isTRUE(f$ok)) NULL else f
}

.vcr_tt_name <- function(x, default, field) .vcr_column_name(x, default, field)

#' The person-period frame of a job: the longitudinal table pivoted to one row per person and period, cut where the record cannot be followed, with
#' what was cut counted.
.vcr_tt_frame <- function(tabs, sc) {
  long <- tabs$long
  if (is.null(long)) vcr_abort("input_shape_invalid", "inputs", "A target-trial emulation reads a longitudinal table (one row per person, period and parameter: USUBJID, PARAMCD, AVAL and ADT, the period number); the job names none.")
  if (!("ADT" %in% names(long))) vcr_abort("input_shape_invalid", "inputs", "The longitudinal table needs ADT, the period number of every row (a whole number), to be read as person-periods.")
  par <- sc[["parameters"]]
  p_treat <- .vcr_tt_name(par[["treatment"]], "treatment", "scenario.parameters.treatment")
  p_out <- .vcr_tt_name(par[["outcome"]], "outcome", "scenario.parameters.outcome")
  p_elig <- .vcr_tt_name(par[["eligible"]], "eligible", "scenario.parameters.eligible")
  covs <- vcr_chr(sc[["covariates"]])
  need <- unique(c(p_treat, p_out, p_elig, covs))
  have <- unique(as.character(long$PARAMCD))
  gone <- setdiff(need, have)
  if (length(gone)) vcr_abort("input_shape_invalid", "scenario.parameters", sprintf("The longitudinal table has no parameter '%s'.", gone[1]))
  d <- long[as.character(long$PARAMCD) %in% need, , drop = FALSE]
  period <- suppressWarnings(as.numeric(d$ADT)); aval <- suppressWarnings(as.numeric(d$AVAL))
  if (anyNA(period) || any(period != round(period))) vcr_abort("input_shape_invalid", "inputs", "ADT is the period number: a whole number on every row.")
  ids <- sort(unique(as.character(d$USUBJID))); pid <- match(as.character(d$USUBJID), ids)
  par_idx <- match(as.character(d$PARAMCD), need)
  ord <- order(pid, period); pid <- pid[ord]; period <- period[ord]; par_idx <- par_idx[ord]; aval <- aval[ord]
  newpair <- c(TRUE, pid[-1L] != pid[-length(pid)] | period[-1L] != period[-length(period)])
  row_of <- cumsum(newpair)
  if (anyDuplicated(cbind(row_of, par_idx))) vcr_abort("input_shape_invalid", "inputs", "The longitudinal table has one row per person, period and parameter; some person has two for the same period.")
  n_pp <- max(row_of)
  wide <- matrix(NA_real_, n_pp, length(need), dimnames = list(NULL, need))
  wide[cbind(row_of, par_idx)] <- aval
  pid_pp <- pid[newpair]; per_pp <- period[newpair]
  A <- wide[, p_treat]; Y <- wide[, p_out]; E <- wide[, p_elig]; L <- wide[, covs, drop = FALSE]
  for (nm in c(p_treat, p_out, p_elig)) {
    v <- wide[, nm]
    if (!all(v[!is.na(v)] %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.parameters", sprintf("'%s' is 0 or 1 in every period.", nm))
  }
  # where the record cannot be followed
  first_row <- c(TRUE, pid_pp[-1L] != pid_pp[-n_pp])
  gap <- !first_row & per_pp != c(NA, per_pp[-n_pp]) + 1
  incomplete <- is.na(A) | is.na(Y) | is.na(E) | (if (ncol(L)) rowSums(is.na(L)) > 0L else rep(FALSE, n_pp))
  bad <- gap | incomplete
  dead <- ave(as.numeric(bad), pid_pp, FUN = cumsum) > 0
  ev_before <- ave(as.numeric(Y == 1 & !dead), pid_pp, FUN = cumsum)
  after_event <- (ev_before - as.numeric(Y == 1 & !dead)) > 0
  keep <- !dead & !after_event
  kept_pid <- pid_pp[keep]
  frame <- list(pid = match(kept_pid, unique(kept_pid)), period = per_pp[keep], A = A[keep], Y = Y[keep], E = E[keep], L = L[keep, , drop = FALSE],
                names = list(treatment = p_treat, outcome = p_out, eligible = p_elig, covariates = covs),
                cut = list(rowsDropped = sum(dead), personsCut = length(unique(pid_pp[dead])), rowsAfterEvent = sum(after_event & !dead),
                           personsInTable = length(ids)))
  frame
}

# --- sequential trials -----------------------------------------------------------------------------------------------

#' The sequence of trials of a frame: one per eligible person-period. Returns the row each trial starts at, its arm, the last row of its follow-up
#' (intention to treat) and the last row before the treatment departs from the arm (per protocol), all as row indices of the frame.
.vcr_tt_trials <- function(fr, first_period = NULL, last_period = NULL, follow_limit = NULL) {
  n <- length(fr$pid)
  first <- c(TRUE, fr$pid[-1L] != fr$pid[-n])
  end_row <- ave(seq_len(n), fr$pid, FUN = max)
  run <- cumsum(first | fr$A != c(NA, fr$A[-n]))
  run_end <- ave(seq_len(n), run, FUN = max)
  # the person-periods that lie in some trial's per-protocol follow-up, from its baseline to the period the treatment departs from the arm (that row
  # is the one that tells the model of the weights how often treatment stops or starts), whatever the window the trials are limited to: the models
  # of the weights are fitted on these rows only, as TrialEmulation does
  every <- which(fr$E == 1)
  upto <- pmin(run_end[every] + 1L, end_row[every])
  mark <- numeric(n + 2L); mark <- mark + tabulate(every, n + 2L) - tabulate(upto + 1L, n + 2L)
  needed <- cumsum(mark)[seq_len(n)] > 0
  elig <- which(fr$E == 1 & fr$period >= (first_period %||% -Inf) & fr$period <= (last_period %||% Inf))
  end_itt <- end_row[elig]
  if (!is.null(follow_limit)) end_itt <- pmin(end_itt, elig + follow_limit - 1L)
  list(rows = elig, arm = as.integer(fr$A[elig]), end_itt = end_itt, end_pp = pmin(run_end[elig], end_itt), end_row = end_row, needed = needed)
}

#' Stabilised weights of the treatment actually received at every person-period (TrialEmulation's switch weights): separate logistic models for
#' who was and who was not treated at the previous period, a numerator on the stabilising covariates and a denominator on the full set. Returns the
#' log of each row's weight (0 where it is not defined).
.vcr_tt_switch_logw <- function(fr, num_cols, den_cols, mult, needed) {
  n <- length(fr$pid)
  first <- c(TRUE, fr$pid[-1L] != fr$pid[-n])
  prev <- ifelse(first, 0, c(0, fr$A[-n]))
  seen_elig <- needed
  logw <- numeric(n)
  num <- if (length(num_cols)) cbind(1, fr$L[, num_cols, drop = FALSE]) else matrix(1, n, 1L)
  den <- if (length(den_cols)) cbind(1, fr$L[, den_cols, drop = FALSE]) else matrix(1, n, 1L)
  for (g in 0:1) {
    r <- which(prev == g & seen_elig)
    if (length(r) < 2L) next
    fd <- .vcr_tt_fit(den[r, , drop = FALSE], fr$A[r], mult[r])
    fn <- .vcr_tt_fit(num[r, , drop = FALSE], fr$A[r], mult[r])
    if (is.null(fd) || is.null(fn)) next
    pd <- stats::plogis(as.vector(den[r, , drop = FALSE] %*% fd$beta)); pn <- stats::plogis(as.vector(num[r, , drop = FALSE] %*% fn$beta))
    pd <- pmin(pmax(pd, 1e-9), 1 - 1e-9); pn <- pmin(pmax(pn, 1e-9), 1 - 1e-9)
    logw[r] <- ifelse(fr$A[r] == 1, log(pn) - log(pd), log1p(-pn) - log1p(-pd))
  }
  logw
}

#' The polynomial terms of a follow-up time `k` (degree 1 to 3) as columns, in the raw unit of a period.
.vcr_tt_poly <- function(k, degree) if (degree <= 0L) matrix(0, length(k), 0L) else vapply(seq_len(degree), function(d) k^d, numeric(length(k)))

#' The expanded table of the sequence of trials and what is needed to fit and standardise it.
.vcr_tt_expand <- function(fr, tr, om) {
  len <- tr$end_itt - tr$rows + 1L
  trial <- rep(seq_along(tr$rows), len)
  row_j <- tr$rows[trial] + sequence(len) - 1L
  k <- row_j - tr$rows[trial]
  list(trial = trial, row_j = row_j, k = k, arm = tr$arm[trial], y = fr$Y[row_j], pid = fr$pid[tr$rows[trial]],
       in_pp = row_j <= tr$end_pp[trial], n = length(trial))
}

#' The design matrix of the outcome model for the expanded rows: intercept, arm, [arm by follow-up], follow-up terms, trial-period terms, baseline covariates.
.vcr_tt_design <- function(ex, fr, tr, om, tmin) {
  tstart <- tr$rows[ex$trial]
  fk <- .vcr_tt_poly(ex$k, om$followupDegree)
  gt <- .vcr_tt_poly(fr$period[tstart] - tmin, om$trialPeriodDegree)
  X <- cbind(1, ex$arm, if (om$armByFollowup) ex$arm * fk, fk, gt, fr$L[tstart, , drop = FALSE])
  colnames(X) <- c("(Intercept)", "assigned_treatment", if (om$armByFollowup) paste0("assigned_treatment:followup_time", if (om$followupDegree > 1L) seq_len(om$followupDegree) else ""),
                   paste0("followup_time", if (om$followupDegree > 1L) seq_len(om$followupDegree) else ""),
                   if (om$trialPeriodDegree > 0L) paste0("trial_period", if (om$trialPeriodDegree > 1L) seq_len(om$trialPeriodDegree) else ""),
                   fr$names$covariates)
  X
}

#' The standardised cumulative incidence under each arm: for every person-trial baseline (weighted by `m`), the risk of the event by each follow-up
#' time if the arm were 1 (or 0), averaged.
.vcr_tt_standardise <- function(beta, ref_trial, fr, tr, om, tmin, H, m) {
  tstart <- tr$rows[ref_trial]
  base <- beta[["(Intercept)"]] + (if (om$trialPeriodDegree > 0L) as.vector(.vcr_tt_poly(fr$period[tstart] - tmin, om$trialPeriodDegree) %*% beta[paste0("trial_period", if (om$trialPeriodDegree > 1L) seq_len(om$trialPeriodDegree) else "")]) else 0) +
    (if (length(fr$names$covariates)) as.vector(fr$L[tstart, , drop = FALSE] %*% beta[fr$names$covariates]) else 0)
  k <- 0:(H - 1L)
  fk <- .vcr_tt_poly(k, om$followupDegree)
  tf <- as.vector(fk %*% beta[paste0("followup_time", if (om$followupDegree > 1L) seq_len(om$followupDegree) else "")])
  af <- if (om$armByFollowup) as.vector(fk %*% beta[paste0("assigned_treatment:followup_time", if (om$followupDegree > 1L) seq_len(om$followupDegree) else "")]) else rep(0, H)
  out <- matrix(NA_real_, H, 2L, dimnames = list(NULL, c("control", "treated")))
  for (a in 0:1) {
    cum <- numeric(length(base))
    for (j in seq_len(H)) {
      eta <- base + beta[["assigned_treatment"]] * a + tf[j] + a * af[j]
      cum <- cum + stats::plogis(eta, log.p = TRUE, lower.tail = FALSE)
      out[j, a + 1L] <- 1 - sum(m * exp(cum)) / sum(m)
    }
  }
  out
}

#' One analysis of the sequence of trials for the people counted `cnt` times (1 for the data as it is, a resample's counts in the bootstrap): the
#' weights, the outcome models and the standardised risks. Returns a list with the vector of estimates and the pieces the result reports.
.vcr_tt_run_sequential <- function(fr, tr, ex, X, num_cols, den_cols, om, tmin, H, estimands, cnt, with_detail = FALSE) {
  mult_row <- cnt[fr$pid]
  m_ex <- cnt[ex$pid]
  ref <- which(ex$k == 0L)
  ref_trial <- ex$trial[ref]
  m_ref <- m_ex[ref]
  est <- list(); detail <- list()
  for (e in estimands) {
    if (identical(e, "itt")) {
      keep <- which(m_ex > 0); w <- m_ex[keep]
    } else {
      logw <- .vcr_tt_switch_logw(fr, num_cols, den_cols, mult_row, tr$needed)
      clog <- ave(logw, fr$pid, FUN = cumsum)
      pp <- which(ex$in_pp & m_ex > 0)
      w_all <- exp(clog[ex$row_j[pp]] - clog[tr$rows[ex$trial[pp]]])
      keep <- pp; w <- w_all * m_ex[pp]
      detail$weights <- w_all[ex$k[pp] >= 1L]
    }
    fit <- .vcr_tt_fit(X[keep, , drop = FALSE], ex$y[keep], w)
    if (is.null(fit)) return(NULL)
    beta <- setNames(fit$beta, colnames(X))
    if (anyNA(beta)) return(NULL)
    risks <- .vcr_tt_standardise(beta, ref_trial, fr, tr, om, tmin, H, m_ref)
    detail[[paste0("beta_", e)]] <- beta
    # the events the fit rests on, by arm: a coefficient for an arm with none is the penalty's, not the data's
    detail[[paste0("events_", e)]] <- c(control = sum(ex$y[keep] == 1 & ex$arm[keep] == 0L), treated = sum(ex$y[keep] == 1 & ex$arm[keep] == 1L))
    est[[e]] <- risks
  }
  list(risks = est, detail = detail)
}

# --- clone, censor, weight -----------------------------------------------------------------------------------------------

#' The people of a clone-censor-weight design, one row each, from time zero (the first eligible period) on: when treatment started (`s`, relative
#' to time zero, Inf if never), when the event happened (`e`), the last period followed (`last`), the frame row of time zero (`t0`) and the
#' covariates of every row of the frame (`L`: the covariates of period `u` of person `k` are `L[t0[k] + u, ]`). `treatedBefore` counts the people
#' who were treated in a period before time zero and not at or after it: the design cannot call them never-starters.
.vcr_tt_people <- function(fr) {
  n <- length(fr$pid)
  rows <- which(fr$E == 1)
  first_elig <- rows[!duplicated(fr$pid[rows])]
  end_row <- ave(seq_len(n), fr$pid, FUN = max)
  pid <- fr$pid[first_elig]
  t0r <- first_elig
  last <- end_row[t0r] - t0r
  # the first period at or after time zero with treatment (a treated row counts only from time zero on)
  treated_rows <- which(fr$A == 1)
  s <- rep(Inf, length(pid))
  cand <- treated_rows[fr$pid[treated_rows] %in% pid]
  by_p <- split(cand, fr$pid[cand])
  before <- logical(length(pid))
  for (k in seq_along(pid)) {
    r <- by_p[[as.character(pid[k])]]
    if (!is.null(r)) { before[k] <- any(r < t0r[k]); r <- r[r >= t0r[k]]; if (length(r)) s[k] <- r[1L] - t0r[k] }
  }
  ev_row <- which(fr$Y == 1)
  e <- rep(Inf, length(pid)); ev_by <- split(ev_row, fr$pid[ev_row])
  for (k in seq_along(pid)) { r <- ev_by[[as.character(pid[k])]]; if (!is.null(r) && r[1L] >= t0r[k]) e[k] <- r[1L] - t0r[k] }
  list(pid = pid, t0 = t0r, s = s, e = e, last = last, L = fr$L, n = length(pid), treatedBefore = sum(before & !is.finite(s)))
}

#' The discrete-time hazard of starting treatment by period since time zero, on the covariates AS THEY STAND IN THAT PERIOD, with and without them:
#' the log of one minus the hazard on the grid `0..umax` for every person, for the denominator (covariates) and the numerator (none) of the
#' stabilised weights. A covariate that does not change gives the model of its time-zero value. A person's period beyond the last followed has no
#' row; the last row's covariates stand in there, and those cells are never at risk. Returns matrices people x (umax + 1), or NULL when a model
#' cannot be fitted.
.vcr_tt_start_logsurv <- function(pe, cnt, umax, degree) {
  n <- pe$n
  last_at_risk <- pmin(pe$s, pe$last)
  len <- last_at_risk + 1
  person <- rep(seq_len(n), len); u <- sequence(len) - 1
  y <- as.numeric(u == pe$s[person])
  fu <- .vcr_tt_poly(u, degree)
  Xd <- cbind(1, fu, pe$L[pe$t0[person] + u, , drop = FALSE]); Xn <- cbind(1, fu)
  w <- cnt[person]
  fd <- .vcr_tt_fit(Xd, y, w); fn <- .vcr_tt_fit(Xn, y, w)
  if (is.null(fd) || is.null(fn)) return(NULL)
  grid <- 0:umax
  fg <- cbind(1, .vcr_tt_poly(grid, degree))
  base_n <- as.vector(fg %*% fn$beta); base_d <- as.vector(fg %*% fd$beta[seq_len(1L + degree)])
  b_cov <- fd$beta[-seq_len(1L + degree)]
  eta_d <- matrix(vapply(grid, function(j) base_d[j + 1L] + as.vector(pe$L[pe$t0 + pmin(j, pe$last), , drop = FALSE] %*% b_cov), numeric(n)), n)
  eta_n <- matrix(rep(base_n, each = n), n)
  list(den = stats::plogis(eta_d, log.p = TRUE, lower.tail = FALSE), num = stats::plogis(eta_n, log.p = TRUE, lower.tail = FALSE))
}

#' One clone-censor-weight analysis for the people counted `cnt` times: the weights, the weighted life table of each arm, the risk at each
#' period. Returns a matrix periods x (control, treated) of cumulative incidence, or NULL.
.vcr_tt_run_ccw <- function(pe, g, H, degree, cnt, detail = FALSE) {
  n <- pe$n
  umax <- max(H - 1L, g)
  ls <- .vcr_tt_start_logsurv(pe, cnt, umax, degree)
  if (is.null(ls)) return(NULL)
  U <- 0:(H - 1L)
  # arm 0 ("never start"): at risk while the person has not started and is still followed; a person who starts at period u has left it before u's
  # event, because the event of a period is the event under that period's treatment. Weight = the inverse probability of not having started
  cum_den <- t(apply(ls$den, 1L, cumsum)); cum_num <- t(apply(ls$num, 1L, cumsum))
  idx <- seq_len(H)
  at0 <- outer(pe$last, U, ">=") & outer(pe$s, U, ">")
  w0 <- exp(cum_num[, idx, drop = FALSE] - cum_den[, idx, drop = FALSE])
  # arm 1 ("start within g periods", the periods 0..g): the last chance to start is the start of period g, so a person who has not started by then
  # has left the arm before period g's event; one who started in the window is followed throughout. Before period g nobody has left, and from
  # period g the weight is the inverse probability of having started in the window (the clone that stayed stands for those that left)
  p_den <- 1 - exp(cum_den[, g + 1L]); p_num <- 1 - exp(cum_num[, g + 1L])
  started <- pe$s <= g
  at1 <- outer(pe$last, U, ">=") & (outer(rep(g, n), U, ">") | started)
  w1 <- matrix(1, n, H)
  late <- outer(rep(g, n), U, "<=")
  w1[late] <- (p_num / pmax(p_den, 1e-9))[row(late)[late]]
  ev <- outer(pe$e, U, "==")
  out <- matrix(NA_real_, H, 2L, dimnames = list(NULL, c("control", "treated")))
  for (a in 0:1) {
    at <- if (a == 0L) at0 else at1; w <- if (a == 0L) w0 else w1
    ww <- at * w * cnt
    d <- colSums(ww * ev); r <- colSums(ww)
    hz <- ifelse(r > 0, d / r, NA_real_)
    if (anyNA(hz)) { first <- which(is.na(hz))[1L]; hz[first:H] <- NA_real_ }
    out[, a + 1L] <- 1 - cumprod(1 - hz)
  }
  if (!detail) return(list(risks = out))
  list(risks = out, w0 = w0, w1 = w1, at0 = at0, at1 = at1, started = started, p_den = p_den,
       events = c(control = sum(at0 * ev), treated = sum(at1 * ev)), atRisk = c(control = sum(at0[, 1L]), treated = sum(at1[, 1L])))
}

#' The naive comparison that classifies people by whether they ever started treatment, from time zero: shown beside the estimate so that the waiting
#' time (during which a person who starts treatment cannot have had the event) can be seen; it is a diagnostic and never an estimate.
.vcr_tt_naive <- function(pe, H) {
  U <- 0:(H - 1L)
  risk <- function(sel) {
    at <- outer(pe$last[sel], U, ">="); ev <- outer(pe$e[sel], U, "==")
    n_u <- colSums(at); d_u <- colSums(at * ev)
    if (any(n_u == 0)) return(NA_real_)
    1 - prod(1 - d_u / n_u)
  }
  ever <- is.finite(pe$s)
  c(treated = risk(ever), control = risk(!ever))
}

# --- the job -----------------------------------------------------------------------------------------------------------------

.vcr_tt_summary <- function(x) {
  x <- x[is.finite(x)]
  if (!length(x)) return(NULL)
  q <- stats::quantile(x, c(0.01, 0.99), names = FALSE)
  list(n = length(x), mean = mean(x), sd = if (length(x) > 1L) stats::sd(x) else 0, min = min(x), max = max(x), p01 = q[1L], p99 = q[2L])
}

#' Whether the stabilised weights of one arm of a clone-censor-weight design are carried by a few people: a largest weight above 20 or a mean more than a
#' quarter from 1. Both arms are read (the second arm's weights, 1 over the probability of having started in the grace period, were not).
.vcr_tt_unstable_weights <- function(w) length(w) > 0L && (w$max > 20 || abs(w$mean - 1) > 0.25)

#' The measures of one estimand from its risks at the horizon (the last row) with their bootstrap intervals.
.vcr_tt_measures <- function(tag, risk_t, risk_c, ci, src) {
  rr <- if (is.finite(risk_c) && risk_c > 0) risk_t / risk_c else NA_real_
  c(list(vcr_measure(paste0("risk_difference_", tag), risk_t - risk_c, interval = ci$rd, source = src),
         vcr_measure(paste0("risk_treated_", tag), risk_t, interval = ci$t, source = src),
         vcr_measure(paste0("risk_control_", tag), risk_c, interval = ci$c, source = src)),
    if (is.finite(rr)) list(vcr_measure(paste0("risk_ratio_", tag), rr, interval = ci$rr, source = src)))
}

vcr_job_target_trial <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job[["scenario"]]
  tabs <- vcr_job_tables(job)
  vcr_require_individual(tabs$long, "A target-trial emulation", method = job[["method"]])
  strat <- sc[["strategy"]]; kind <- as.character(strat[["kind"]])
  H <- as.integer(vcr_scalar(sc[["horizon"]], NULL))
  fr <- .vcr_tt_frame(tabs, sc)
  used <- vcr_used_sources(list(list(df = tabs$long, columns = "AVAL")))
  est_src <- vcr_estimate_source(used$source)
  sources_used <- vcr_value_sources_used(used)
  n_p <- max(fr$pid, 0L)
  counts0 <- vcr_counts(realPatients = n_p)
  unit <- as.character(sc[["timeUnit"]] %||% "")
  cap <- .vcr_tt_cap()
  advice <- if (identical(kind, "sequential")) "Limit the follow-up used (followUpLimit), start trials in fewer periods (firstPeriod, lastPeriod), or use fewer people."
            else "Shorten the horizon or use fewer people."
  refuse_size <- function(rows) vcr_abort("too_many_person_periods", "inputs",
    sprintf("This design expands to %s person-periods in follow-up; this engine holds at most %s (the memory of a job is 3 GiB). %s", format(rows, big.mark = ",", scientific = FALSE), format(cap, big.mark = ",", scientific = FALSE), advice))
  not_estimable <- function(rule, detail, extra = list()) list(status = "not_estimable", notEstimableRule = rule, measures = list(), counts = counts0,
    diagnostics = c(list(detail = detail, valueSourcesUsed = sources_used, targetTrial = list(strategy = kind, horizon = H, checks = .vcr_tt_checks(fr))), extra))
  if (n_p < 2L) return(not_estimable("no_eligible_person_trials", "fewer than two people are left in the table after cutting the records at an event, a gap or a missing value"))
  if (!any(fr$E == 1)) return(not_estimable("no_eligible_person_trials", "nobody is eligible in any period"))

  if (identical(kind, "sequential")) .vcr_tt_job_sequential(job, sc, fr, strat, H, cap, refuse_size, not_estimable, est_src, sources_used, unit, output_dir, n_p)
  else .vcr_tt_job_ccw(job, sc, fr, strat, H, cap, refuse_size, not_estimable, est_src, sources_used, unit, output_dir, n_p)
}

#' Checks of the input, as numbers: diagnostics of the table, never a gate.
.vcr_tt_checks <- function(fr) {
  n <- length(fr$pid)
  first <- c(TRUE, fr$pid[-1L] != fr$pid[-n])
  elig <- which(fr$E == 1)
  prev <- ifelse(first, NA, c(NA, fr$A[-n]))
  list(persons = max(fr$pid, 0L), personPeriods = n, personsInTable = fr$cut$personsInTable, recordsCutShort = fr$cut$personsCut, rowsDroppedWhereCut = fr$cut$rowsDropped,
       rowsAfterEventDropped = fr$cut$rowsAfterEvent, eligiblePeriods = length(elig),
       eligibleAlreadyTreated = if (length(elig)) mean(fr$A[elig] == 1) else NA_real_,
       eligibleTreatedAtPreviousPeriod = if (length(elig) && any(!is.na(prev[elig]))) mean(prev[elig] == 1, na.rm = TRUE) else NA_real_,
       events = sum(fr$Y == 1))
}

.vcr_tt_job_sequential <- function(job, sc, fr, strat, H, cap, refuse_size, not_estimable, est_src, sources_used, unit, output_dir, n_p) {
  estimand <- as.character(strat[["estimand"]] %||% "both")
  estimands <- switch(estimand, itt = "itt", per_protocol = "pp", c("itt", "pp"))
  omr <- sc[["outcomeModel"]]
  om <- list(followupDegree = as.integer(vcr_scalar(omr[["followupDegree"]], 2L)), trialPeriodDegree = as.integer(vcr_scalar(omr[["trialPeriodDegree"]], 2L)),
             armByFollowup = isTRUE(omr[["armByFollowup"]]))
  covs <- fr$names$covariates
  wts <- strat[["weights"]]
  num_cols <- vcr_chr(wts[["numerator"]]); den_cols <- if (!is.null(wts[["denominator"]])) vcr_chr(wts[["denominator"]]) else covs
  bad <- setdiff(c(num_cols, den_cols), covs)
  if (length(bad)) vcr_abort("scenario_value_invalid", "scenario.strategy.weights", sprintf("'%s' is not one of the covariates the scenario names.", bad[1]))
  tr <- .vcr_tt_trials(fr, vcr_scalar(sc[["firstPeriod"]], NULL), vcr_scalar(sc[["lastPeriod"]], NULL), if (is.null(sc[["followUpLimit"]])) NULL else as.integer(sc[["followUpLimit"]]))
  if (!length(tr$rows)) return(not_estimable("no_eligible_person_trials", "nobody is eligible in the periods the trials may start in"))
  n_exp <- sum(tr$end_itt - tr$rows + 1)
  if (n_exp > cap) refuse_size(n_exp)
  arm_n <- table(factor(tr$arm, levels = 0:1))
  if (any(arm_n == 0L)) return(not_estimable("arm_without_person_trials", sprintf("no eligible person-trial starts %s", if (arm_n[["0"]] == 0L) "untreated" else "treated")))
  # The horizon must lie inside the follow-up of each arm, and of each estimand: a risk read past the last period anyone of the arm was followed (for
  # per protocol: was on protocol) is the outcome model's polynomial, not data.
  longest <- function(end) vapply(0:1, function(a) max(end[tr$arm == a] - tr$rows[tr$arm == a]) + 1L, numeric(1))
  long_itt <- longest(tr$end_itt); long_pp <- longest(tr$end_pp)
  arm_word <- c("untreated", "treated")
  if (any(long_itt < H)) {
    a <- which(long_itt < H)[1L]
    return(not_estimable("horizon_beyond_followup", sprintf("the horizon is %d periods and the longest follow-up of a trial that starts %s is %d", H, arm_word[a], long_itt[a])))
  }
  dropped <- list()
  if ("pp" %in% estimands && any(long_pp < H)) {
    a <- which(long_pp < H)[1L]
    detail <- sprintf("the horizon is %d periods and the longest follow-up on protocol of a trial that starts %s is %d", H, arm_word[a], long_pp[a])
    if (!"itt" %in% estimands) return(not_estimable("horizon_beyond_followup", detail))
    estimands <- "itt"
    dropped <- list(list(estimand = "pp", rule = "horizon_beyond_followup", arm = c("control", "treated")[a], longestOnProtocol = as.integer(long_pp[a]), horizon = H))
  }
  ex <- .vcr_tt_expand(fr, tr, om)
  tmin <- min(fr$period[tr$rows])
  X <- .vcr_tt_design(ex, fr, tr, om, tmin)
  events_itt <- sum(ex$y == 1)
  if (events_itt < 2L) return(not_estimable("too_few_events", "fewer than two events in the sequence of trials"))
  cnt1 <- rep(1, n_p)
  point <- .vcr_tt_run_sequential(fr, tr, ex, X, num_cols, den_cols, om, tmin, H, estimands, cnt1, with_detail = TRUE)
  if (is.null(point)) return(not_estimable("outcome_model_not_estimable", "the outcome model could not be fitted on the expanded data"))
  B <- vcr_bootstrap_replicates(vcr_scalar(job[["replicates"]], NULL))
  flat <- function(run) unlist(lapply(estimands, function(e) { r <- run$risks[[e]]; c(r[H, "treated"] - r[H, "control"], r[H, "treated"], r[H, "control"], r[H, "treated"] / r[H, "control"], r[, "treated"], r[, "control"]) }), use.names = FALSE)
  width_each <- 4L + 2L * H
  boot <- vcr_bootstrap_pipeline(n_p, function(idx) {
    run <- .vcr_tt_run_sequential(fr, tr, ex, X, num_cols, den_cols, om, tmin, H, estimands, tabulate(idx, n_p))
    if (is.null(run)) return(rep(NA_real_, width_each * length(estimands)))
    flat(run)
  }, replicates = B, seed = job[["seed"]], strata = NULL, cores = vcr_cores(job[["cores"]]), batch_size = 50L)
  .vcr_tt_finish(job, sc, "sequential", estimands, point, boot, B, H, width_each, fr, tr, ex, om, est_src, sources_used, unit, output_dir, n_p,
                 list(numerator = num_cols, denominator = den_cols), list(expanded = n_exp, trials = length(tr$rows), armN = as.list(arm_n), dropped = dropped))
}

.vcr_tt_job_ccw <- function(job, sc, fr, strat, H, cap, refuse_size, not_estimable, est_src, sources_used, unit, output_dir, n_p) {
  g <- as.integer(vcr_scalar(strat[["gracePeriod"]], 0L))
  pe <- .vcr_tt_people(fr)
  if (pe$n < 2L) return(not_estimable("no_eligible_person_trials", "fewer than two people are eligible in any period"))
  rows <- sum(pmin(pe$last, H - 1) + 1) * 2
  if (rows > cap) refuse_size(rows)
  # What is allocated is people x (horizon or grace period) for each weight and at-risk matrix, however short a record is: one long record lets a
  # table of thousands of short ones through the horizon check. The cells are held to ten times the person-period cap (60 million cells measured 3.8 GB).
  cells <- as.numeric(pe$n) * (max(H - 1L, g) + 1)
  if (cells > 10 * cap) vcr_abort("too_many_person_periods", "inputs",
    sprintf("This design holds %s people x %s periods = %s cells of weights in memory; this engine holds at most %s (the memory of a job is 3 GiB). Shorten the horizon or use fewer people.",
            format(pe$n, big.mark = ","), format(max(H - 1L, g) + 1, big.mark = ","), format(cells, big.mark = ",", scientific = FALSE), format(10 * cap, big.mark = ",", scientific = FALSE)))
  if (H - 1L > max(pe$last)) return(not_estimable("horizon_beyond_followup", sprintf("the horizon is %d periods and the longest follow-up is %d", H, max(pe$last) + 1L)))
  if (sum(is.finite(pe$e)) < 2L) return(not_estimable("too_few_events", "fewer than two events after time zero"))
  degree <- 3L
  cnt1 <- rep(1, pe$n)
  point <- .vcr_tt_run_ccw(pe, g, H, degree, cnt1, detail = TRUE)
  if (is.null(point) || anyNA(point$risks)) return(not_estimable("outcome_model_not_estimable", "the model of starting treatment could not be fitted, or an arm has nobody left at risk before the horizon"))
  B <- vcr_bootstrap_replicates(vcr_scalar(job[["replicates"]], NULL))
  flat <- function(r) c(r[H, "treated"] - r[H, "control"], r[H, "treated"], r[H, "control"], r[H, "treated"] / r[H, "control"], r[, "treated"], r[, "control"])
  width_each <- 4L + 2L * H
  boot <- vcr_bootstrap_pipeline(pe$n, function(idx) {
    run <- .vcr_tt_run_ccw(pe, g, H, degree, tabulate(idx, pe$n))
    if (is.null(run) || anyNA(run$risks)) return(rep(NA_real_, width_each))
    flat(run$risks)
  }, replicates = B, seed = job[["seed"]], strata = NULL, cores = vcr_cores(job[["cores"]]), batch_size = 50L)
  naive <- .vcr_tt_naive(pe, H)
  waiting <- pe$s[is.finite(pe$s)]
  extra <- list(gracePeriod = g, people = pe$n, startedWithinGrace = sum(pe$s <= g), startedAfterGrace = sum(is.finite(pe$s) & pe$s > g),
                neverStarted = sum(!is.finite(pe$s)) - pe$treatedBefore, treatedBeforeTimeZero = pe$treatedBefore,
                startedAtTimeZero = sum(pe$s == 0), waitingTime = if (length(waiting)) list(median = stats::median(waiting), max = max(waiting), people = length(waiting)) else NULL,
                horizonInsideGracePeriod = H - 1L < g,
                naive = list(treated = unname(naive["treated"]), control = unname(naive["control"]), difference = unname(naive["treated"] - naive["control"])),
                weights = list(control = .vcr_tt_summary(as.vector(point$w0[point$at0])), treated = .vcr_tt_summary(as.vector(point$w1[point$at1 & col(point$w1) > g]))),
                censored = list(control = mean(is.finite(pe$s) & pe$s < H), treated = mean(!point$started & pe$last >= g)))
  .vcr_tt_finish(job, sc, "clone_censor_weight", "pp", list(risks = list(pp = point$risks), detail = list(weights = extra$weights, events_pp = point$events, atRisk_pp = point$atRisk)), boot, B, H, width_each, fr, NULL, NULL, NULL, est_src, sources_used, unit, output_dir, pe$n,
                 NULL, extra)
}

#' The result of either strategy from the point estimates and the bootstrap.
.vcr_tt_finish <- function(job, sc, kind, estimands, point, boot, B, H, width_each, fr, tr, ex, om, est_src, sources_used, unit, output_dir, n_p, weight_cols, extra) {
  counts <- vcr_counts(realPatients = n_p, events = sum(fr$Y == 1))
  if (identical(boot$interrupted, "canceled")) return(list(status = "canceled", measures = list(), counts = counts, diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  ccw <- identical(kind, "clone_censor_weight")
  # the clone-censor-weight estimand is "start within g periods" against "never start"; it reads the start and nothing after it, so it is not a
  # per-protocol estimand and does not carry that name (its keys end in `_start`)
  tags <- if (ccw) c(pp = "start") else c(itt = "itt", pp = "pp")
  est_of <- function(e) point$risks[[e]]
  stopped <- !is.null(boot$interrupted) || boot$replicates < B
  if (stopped && boot$replicates < 200L) {
    ms <- unlist(lapply(estimands, function(e) { r <- est_of(e); t <- tags[[e]]; list(vcr_measure(paste0("risk_difference_", t), r[H, "treated"] - r[H, "control"], source = est_src),
                                                                                    vcr_measure(paste0("risk_treated_", t), r[H, "treated"], source = est_src), vcr_measure(paste0("risk_control_", t), r[H, "control"], source = est_src)) }), recursive = FALSE)
    return(list(status = "failed", measures = ms, counts = counts,
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap, before 200 resamples; the estimates are kept and no interval is reported.")),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B, valueSourcesUsed = sources_used)))
  }
  measures <- list(); curves <- list(); table_rows <- list(); estimand_rows <- list(); no_events <- list()
  for (ei in seq_along(estimands)) {
    e <- estimands[[ei]]; t <- tags[[e]]; r <- est_of(e); off <- (ei - 1L) * width_each
    # An arm with no event at all has no risk the data can measure: a model fitted to it gives a number set by its penalty, and every resample
    # of it gives the same zero, so no interval of its risk, of the difference or of the ratio is drawn from the resamples. The exact upper limit of
    # a risk of 0 events among n people is said instead.
    ev <- point$detail[[paste0("events_", e)]]
    bare <- if (is.null(ev)) character(0) else names(ev)[ev == 0]
    if (length(bare)) {
      n_at <- if (ccw) point$detail[[paste0("atRisk_", e)]] else tapply(fr$pid[tr$rows], tr$arm, function(p) length(unique(p)))[c("0", "1")]
      no_events[[length(no_events) + 1L]] <- list(estimand = if (ccw) "start" else e, arms = as.list(bare),
        upperLimits = lapply(stats::setNames(bare, bare), function(a) { n <- as.numeric(n_at[[if (ccw) a else c(control = "0", treated = "1")[[a]]]]); list(n = n, risk = 1 - 0.025^(1 / n), level = 0.95) }))
    }
    blank <- function(j) (j == 1L || j == 4L) && length(bare) > 0L || (j == 2L && "treated" %in% bare) || (j == 3L && "control" %in% bare)
    ci <- function(j) { if (blank(j)) return(NULL); iv <- boot$intervals[off + j, ]; if (anyNA(iv)) NULL else vcr_interval("confidence", iv[1], iv[2]) }
    measures <- c(measures, .vcr_tt_measures(t, r[H, "treated"], r[H, "control"], list(rd = ci(1L), t = ci(2L), c = ci(3L), rr = ci(4L)), est_src))
    label_e <- if (ccw) "宽限期内开始" else if (identical(e, "itt")) "意向治疗" else "按方案"
    for (a in c("treated", "control")) {
      col0 <- off + 4L + (if (a == "treated") 0L else H)
      lo <- boot$intervals[col0 + seq_len(H), 1L]; hi <- boot$intervals[col0 + seq_len(H), 2L]
      if (a %in% bare) { lo <- rep(NA_real_, H); hi <- rep(NA_real_, H) }
      curves[[length(curves) + 1L]] <- vcr_series(paste0(a, "_", t), paste0(if (a == "treated") "试验组" else "对照组", "（", if (ccw && a == "control") "始终不开始" else label_e, "）"), 0:(H - 1L), 1 - r[, a],
        "calculated", ours = identical(a, "treated"), low = if (a %in% bare) NULL else 1 - hi, high = if (a %in% bare) NULL else 1 - lo, dashed = identical(e, "pp") && length(estimands) > 1L, band_kind = "confidence", band_level = 0.95)
      table_rows[[length(table_rows) + 1L]] <- data.frame(estimand = if (ccw) "start" else e, arm = a, period = 0:(H - 1L), risk = r[, a], lower = lo, upper = hi)
    }
    estimand_rows[[length(estimand_rows) + 1L]] <- if (ccw) list(kind = "start", contrast = "risk_difference", horizon = H, label = "initiation_within_grace_period")
      else list(kind = e, contrast = "risk_difference", horizon = H, label = if (identical(e, "itt")) "intention_to_treat" else "per_protocol")
  }
  bs <- vcr_boot_summary(boot, 1L)
  limited_by <- c(if (bs$failureShare > 0.01) "bootstrap_failure_share", if (stopped) "bootstrap_stopped_early", if (length(no_events)) "arm_without_events",
                  if (ccw && (.vcr_tt_unstable_weights(extra$weights$control) || .vcr_tt_unstable_weights(extra$weights$treated))) "weights_not_stable",
                  if (ccw && isTRUE(extra$horizonInsideGracePeriod)) "horizon_inside_grace_period",
                  if (ccw && extra$treatedBeforeTimeZero > 0) "treated_before_time_zero",
                  if (length(extra$dropped)) "per_protocol_beyond_protocol_follow_up")
  detail_w <- NULL
  if (identical(kind, "sequential") && "pp" %in% estimands) {
    wsum <- .vcr_tt_summary(point$detail$weights)
    detail_w <- wsum
    if (!is.null(wsum) && (wsum$max > 20 || abs(wsum$mean - 1) > 0.1)) limited_by <- c(limited_by, "weights_not_stable")
  }
  coefs <- NULL
  if (identical(kind, "sequential")) {
    coefs <- lapply(estimands, function(e) { b <- point$detail[[paste0("beta_", e)]]; list(estimand = e, terms = lapply(names(b), function(nm) list(term = nm, estimate = unname(b[[nm]])))) })
  }
  checks <- .vcr_tt_checks(fr)
  design <- if (identical(kind, "sequential")) list(trials = extra$expanded, personTrials = extra$trials, expandedRows = extra$expanded, eligibleStartsByArm = extra$armN,
                                                    followUpModel = list(followupDegree = om$followupDegree, trialPeriodDegree = om$trialPeriodDegree, armByFollowup = om$armByFollowup))
            else extra
  if (identical(kind, "sequential")) design <- list(personTrials = extra$trials, expandedRows = extra$expanded, startsByArm = extra$armN, outcomeModel = om)
  tt <- list(strategy = kind, estimands = estimand_rows, horizon = H, periodUnit = if (nzchar(unit)) unit else NULL, design = design, checks = checks,
             weights = if (identical(kind, "sequential")) list(numerator = as.list(weight_cols$numerator), denominator = as.list(weight_cols$denominator), summary = detail_w) else NULL,
             coefficients = coefs, armsWithoutEvents = if (length(no_events)) no_events else NULL,
             droppedEstimands = if (length(extra$dropped)) extra$dropped else NULL,
             population = if (identical(kind, "sequential")) "everyone eligible at any trial start, each start counted once" else "everyone eligible at time zero",
             bootstrap = vcr_boot_diagnostics(bs, B, "people resampled with their whole record; the weights and the outcome model are refitted in every resample", se_scale = "risk difference", interval_scale = "risk"))
  ok <- list(status = "succeeded", measures = measures, conclusion = if (length(limited_by)) "limited" else "estimable", counts = counts,
             diagnostics = list(targetTrial = tt, curves = curves, valueSourcesUsed = sources_used, bootstrapReplicates = boot$replicates, bootstrapFailureShare = bs$failureShare,
                                replicatesCompleted = boot$replicates,
                                limitedBy = as.list(limited_by)),
             tables = .vcr_tables_of(list(vcr_write_table(do.call(rbind, table_rows), "risk-by-period", output_dir))))
  ok
}
