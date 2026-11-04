# ---------------------------------------------------------------------------
# design_win_ratio.R — hierarchical composite endpoints (algorithm round T9, 2026-11-03): `design.win_ratio`.
#
# "死亡、住院次数、KCCQ 三层比较，要多少人，平局占多少": a trial whose primary comparison is the win ratio of a hierarchy -- death first,
# then the number of hospitalisations, then a score -- is sized by simulation, because the published formulas disagree with it (an
# IPHAK-like case: 0.764 by the Yu-Ganju formula, 0.872 by simulation, Kronthaler 2025) and the packages that simulate are slow (winratiosim
# about 0.4 s a trial, hce about 6 ms with a single ordinal scale and no censoring). The engine writes its own and the packages are the checks.
#
# The result is the win ratio, the win difference (net benefit), the win odds and the share of ties, with the level at which each pair was
# decided, the power of the Finkelstein-Schoenfeld test and the size that reaches a wanted power.
#
# Hidden knowledge:
#
# - **The hierarchy is fixed: death, then events, then score.** `truth.death` is required; `truth.events` (recurrent events, fewer is better)
#   and `truth.score` (one number at the end of follow-up, higher is better, with an optional threshold below which two people tie) are
#   the levels that follow when they are stated. A pair is decided at the first level that separates it; a pair no level separates is a tie.
# - **Death is compared only while the other person is still observed.** i beats j at the first level when j died at a time up to the end of
#   i's own observation; a pair in which the earlier death is not followed by a still-observed partner (a dropout before it) is not decided
#   there and goes down the hierarchy (Finkelstein and Schoenfeld 1999; Pocock et al. 2012). Events are compared inside the window both
#   people were observed (the smaller of the two observation times); a score is compared only when both people reached the end of follow-up.
# - **One shared factor links the levels.** Each person has a latent "sicker or healthier" factor; each level reads it with the same weight,
#   so how well a person does on any two levels (a later death, fewer events, a higher score) has correlation `rho` (a Gaussian copula with
#   equal loadings: a matrix the model writes is routinely not positive definite, a single correlation always is). A sicker person dies
#   earlier, has more events (through the frailty of their event process) and a lower score. The first version of the death level read the
#   factor with the wrong sign (a sicker person died LATER, so the power at a correlation above 0 was overstated: 0.46 against 0.29 at
#   correlation 0.6): N87g holds the sign to a closed form. Without overdispersion the event process has no frailty and the factor cannot reach it: the events level then
#   carries no correlation with the others, and the result says so in its assumptions.
# - **The same seed means the same people.** A person is one row of uniforms drawn by row (the factor, one residual per level, the
#   dropout draw, 30 inter-event gaps), whatever the scenario says: moving the hazard ratio moves the treated people's death times and nobody
#   else's, adding people at the end changes nobody before them, a level that is not in the scenario still consumes its draws. Every
#   replicate has its own L'Ecuyer substream, so one and two cores give the same bits.
# - **The test is the Finkelstein-Schoenfeld permutation test.** The comparison of a pair does not read the arm, so under the null the arm
#   labels are exchangeable and the statistic W = wins - losses has variance n1 n0 / (N (N - 1)) times the sum of squares of each person's
#   (wins - losses) against everybody. That variance is the whole test; there is no asymptotic formula to fall out of date.
# - **Numbers reported are means of the trials, and ratios are ratios of means.** The expected win and loss proportions are the means of the
#   pair proportions over the trials; the win ratio is their ratio, with the delta-method error from the paired trial values (a mean of
#   per-trial ratios would be undefined whenever one trial has no losses). The interval beside it is what ONE trial of this size would show.
# - **At most 30 events are tracked per person.** A design whose mean count would pass 8 is refused by the schema; with a large frailty a
#   person can still reach the cap and is then counted as having 30.
# - **A run that is stopped keeps what it has.** Trials run in batches; the cancel file and the CPU budget are asked between batches; a
#   stopped run reports the trials that finished and says it is limited, with the reason.
# ---------------------------------------------------------------------------

VCR_WR_EVENT_SLOTS <- 30L
VCR_WR_PILOT_PER_ARM <- 150L
VCR_WR_PILOT_TRIALS <- 400L
VCR_WR_STEP_TRIALS <- 1000L

.vcr_wr_assume <- function(p, key, value, basis = "default") {
  p$assumed[[length(p$assumed) + 1L]] <- list(key = key, value = value, basis = basis)
  p
}

# --- reading the scenario ----------------------------------------------------------------------------------

.vcr_wr_read <- function(sc) {
  d <- sc[["design"]]; tr <- sc[["truth"]]; an <- sc[["analysis"]] %||% list()
  p <- list(assumed = list())
  p$tau <- vcr_scalar(d[["followup"]], NULL)
  if (is.null(p$tau) || !(p$tau > 0)) vcr_abort("scenario_field_missing", "scenario.design.followup", "A win-ratio design states how long each person is followed.")
  tu <- vcr_time_unit(sc)
  p$drop <- vcr_dropout_hazard(vcr_scalar(d[["dropoutAnnual"]], 0), tu$perYear)
  p$drop_annual <- vcr_scalar(d[["dropoutAnnual"]], 0)
  p$alpha <- vcr_scalar(an[["alpha"]], 0.025); p$sided <- vcr_check_sided(an[["sided"]])
  p$power <- vcr_scalar(an[["power"]], NULL)
  p$n1 <- as.integer(vcr_scalar(d[["nTreat"]], NA_integer_)); p$n0 <- as.integer(vcr_scalar(d[["nControl"]], p$n1))
  p$search <- is.na(p$n1)
  if (p$search) {
    if (is.null(p$power)) vcr_abort("scenario_field_missing", "scenario.analysis.power", "State the size of each arm, or the power wanted so that the size is found.")
    p$max_per_arm <- as.integer(vcr_scalar(d[["maxPerArm"]], 1000L))
    if (is.null(d[["maxPerArm"]])) p <- .vcr_wr_assume(p, "design.maxPerArm", p$max_per_arm, basis = "default: the search for the size stops here")
  }
  # death
  de <- tr[["death"]]
  p$hr <- vcr_scalar(de[["hazardRatio"]], NULL)
  if (is.null(p$hr) || !(p$hr > 0)) vcr_abort("scenario_field_missing", "scenario.truth.death.hazardRatio", "The death level states the hazard ratio (1 for no effect).")
  med <- vcr_scalar(de[["controlMedian"]], NULL); risk <- vcr_scalar(de[["controlRisk"]], NULL)
  p$med <- med; p$risk <- risk; p$unit <- tu$unit
  p$h0 <- if (!is.null(med)) log(2) / med else if (!is.null(risk)) -log1p(-risk) / p$tau else
    vcr_abort("scenario_field_missing", "scenario.truth.death", "The death level states the control median or the control risk of dying within the follow-up.")
  # events
  ev <- tr[["events"]]; p$has_events <- !is.null(ev)
  if (p$has_events) {
    p$rate0 <- vcr_scalar(ev[["controlRate"]], NULL); p$rr <- vcr_scalar(ev[["rateRatio"]], NULL)
    if (is.null(p$rate0) || is.null(p$rr)) vcr_abort("scenario_field_missing", "scenario.truth.events", "The events level states the control rate and the rate ratio.")
    p$theta <- vcr_scalar(ev[["overdispersion"]], 1)
    if (is.null(ev[["overdispersion"]])) p <- .vcr_wr_assume(p, "truth.events.overdispersion", p$theta, basis = "default: variance of the event rate between people, relative to its square (0 is a plain Poisson process)")
    if (p$rate0 * p$tau * max(1, p$rr) > 8) vcr_abort("scenario_value_invalid", "scenario.truth.events.controlRate", "More than 8 events per person on average are not tracked by this method.")
  }
  # score
  sco <- tr[["score"]]; p$has_score <- !is.null(sco)
  if (p$has_score) {
    p$shift <- vcr_scalar(sco[["shift"]], NULL)
    if (is.null(p$shift)) vcr_abort("scenario_field_missing", "scenario.truth.score.shift", "The score level states the difference in the mean score at the end of follow-up (treatment minus control, higher is better).")
    p$sd <- vcr_scalar(sco[["sd"]], 1); p$thr <- vcr_scalar(sco[["threshold"]], 0)
    if (is.null(sco[["sd"]])) p <- .vcr_wr_assume(p, "truth.score.sd", p$sd, basis = "default: the score is measured in standard deviations")
    if (is.null(sco[["threshold"]])) p <- .vcr_wr_assume(p, "truth.score.threshold", p$thr, basis = "default: any difference in the score decides a pair")
  }
  if (!p$has_events && !p$has_score) vcr_abort("scenario_field_missing", "scenario.truth", "A win-ratio design has a level after death: events, a score, or both.")
  p$rho <- vcr_scalar(tr[["correlation"]], 0.3)
  if (is.null(tr[["correlation"]])) p <- .vcr_wr_assume(p, "truth.correlation", p$rho, basis = "default: a sicker person is worse on every level, with this correlation between any two levels")
  if (p$has_events && p$theta == 0 && p$rho > 0) p <- .vcr_wr_assume(p, "truth.events.correlation", 0, basis = "method: with no overdispersion the event process has no frailty, so the events level is not linked to the other levels")
  p <- .vcr_wr_assume(p, "method.test", "Finkelstein-Schoenfeld permutation test on wins minus losses", basis = "method")
  p <- .vcr_wr_assume(p, "method.censoring", "a pair is decided on death only while both people are observed; events are compared in the window both were observed; a score only when both reached the end of follow-up", basis = "method")
  p$is_null <- abs(log(p$hr)) < 1e-12 && (!p$has_events || abs(log(p$rr)) < 1e-12) && (!p$has_score || abs(p$shift) < 1e-12)
  p
}

# --- one trial ---------------------------------------------------------------------------------------------

#' The people of one trial: arm, observed time, whether death was observed, the event times (Inf past the observation), the score.
.vcr_wr_draw <- function(p, n1, n0) {
  N <- n1 + n0; K <- VCR_WR_EVENT_SLOTS
  z <- c(rep(1L, n1), rep(0L, n0))
  U <- matrix(stats::runif(N * (5L + K)), nrow = N, byrow = TRUE)
  w <- stats::qnorm(U[, 1L])
  mix <- function(e) sqrt(p$rho) * w + sqrt(1 - p$rho) * e
  # a high factor is a sicker person: more events and a lower score below, and an EARLIER death here, so death reads the factor with the
  # opposite loading (at correlation 0 the residual alone is read and the draws are what they always were)
  u_d <- stats::pnorm(-sqrt(p$rho) * w + sqrt(1 - p$rho) * stats::qnorm(U[, 2L]))
  td <- -log1p(-u_d) / (p$h0 * ifelse(z == 1L, p$hr, 1))
  tc <- if (p$drop > 0) -log1p(-U[, 5L]) / p$drop else rep(Inf, N)
  x <- pmin(td, tc, p$tau)
  died <- td <= pmin(tc, p$tau)
  out <- list(arm = z, x = x, died = died, dx = ifelse(died, td, Inf), events = NULL, score = NULL)
  if (p$has_events) {
    zf <- if (p$theta > 0) stats::qgamma(pmin(stats::pnorm(mix(stats::qnorm(U[, 3L]))), 1 - 1e-15), shape = 1 / p$theta, scale = p$theta) else rep(1, N)
    rate <- p$rate0 * ifelse(z == 1L, p$rr, 1) * zf
    E <- -log1p(-U[, 5L + seq_len(K), drop = FALSE]) / rate
    for (k in 2:K) E[, k] <- E[, k - 1L] + E[, k]
    E[E > x] <- Inf
    out$events <- E
  }
  if (p$has_score) {
    s <- -p$sd * mix(stats::qnorm(U[, 4L])) + p$shift * z
    s[!((td > p$tau) & (tc > p$tau))] <- NA_real_
    out$score <- s
  }
  out
}

#' The result of every pair at every level, one matrix per level: +1 when the row person wins, -1 when the column person wins, 0 when the
#' level does not separate them. A matrix is the level on its own; which level decides a pair is the first that is not 0 (`.vcr_wr_trial`).
#'
#' Hidden knowledge: the pair matrices are N x N and a trial of 600 people makes dozens of them, so the cost of a trial is the number of
#' passes over 360,000 cells (13 ms at 600 people, against 40 ms for the first version). Level 1 touches only the columns of people whose
#' death was observed (a minority). Events: the count of person i in the window of person j is i's total less the events of i after the end
#' of j's observation, and that correction exists only for people with events and for columns of people who did not reach the end of
#' follow-up; every other pair compares totals. The levels are combined arithmetically: with entries in {-1, 0, 1}, the sign of
#' 9 l1 + 3 l2 + l3 is the first non-zero entry.
.vcr_wr_levels <- function(p, d) {
  N <- length(d$x)
  dead <- which(d$died)
  l1 <- matrix(0L, N, N)
  if (length(dead)) {
    a <- matrix(d$x, N, length(dead)) >= matrix(d$dx[dead], N, length(dead), byrow = TRUE)   # a[i, j]: the j-th dead person died inside i's observation
    l1[, dead] <- a
    l1[dead, ] <- l1[dead, , drop = FALSE] - t(a)
  }
  levels <- list(death = l1)
  if (p$has_events) {
    E <- d$events; fin <- is.finite(E); ne <- rowSums(fin)
    m <- matrix(ne, N, N, byrow = TRUE) - ne                                 # events of j less events of i
    rows <- which(ne > 0L); cols <- which(d$x < p$tau)
    if (length(rows) && length(cols)) {
      at <- which(fin, arr.ind = TRUE)                                      # every tracked event: its person (row) and its time
      after <- matrix(E[fin], nrow(at), length(cols)) > matrix(d$x[cols], nrow(at), length(cols), byrow = TRUE)
      corr <- rowsum(after * 1, at[, 1L], reorder = TRUE)                    # events of i after the end of j's observation
      storage.mode(corr) <- "integer"
      m[rows, cols] <- m[rows, cols, drop = FALSE] + corr
      m[cols, rows] <- m[cols, rows, drop = FALSE] - t(corr)
    }
    levels$events <- (m > 0L) - (m < 0L)                                     # fewer events wins
  }
  if (p$has_score) {
    s <- d$score; seen <- !is.na(s); s[!seen] <- 0
    diff_ <- matrix(s, N, N, byrow = TRUE) - s                               # score of j less score of i
    l3 <- (diff_ < -p$thr) - (diff_ > p$thr)                                 # i wins when its score is higher by more than the threshold
    if (!all(seen)) { l3[!seen, ] <- 0L; l3[, !seen] <- 0L }
    levels$score <- l3
  }
  levels
}

#' One trial: the pair proportions overall and by level, the test statistic and the decision.
.vcr_wr_trial <- function(p, n1, n0) {
  d <- .vcr_wr_draw(p, n1, n0)
  lv <- .vcr_wr_levels(p, d)
  L <- length(lv)
  code <- 0L
  for (k in seq_len(L)) code <- code + as.integer(3^(L - k)) * lv[[k]]
  res <- (code > 0L) - (code < 0L)
  N <- n1 + n0; tr <- seq_len(n1); co <- n1 + seq_len(n0)
  pairs <- n1 * n0
  u <- rowSums(res)
  w_stat <- sum(u[tr])
  v <- n1 * n0 / (N * (N - 1)) * sum(u^2)
  z <- if (v > 0) w_stat / sqrt(v) else 0
  crit <- stats::qnorm(1 - p$alpha / p$sided)
  reject <- if (p$sided == 1) z > crit else abs(z) > crit
  open <- NULL
  per <- numeric(0)
  for (k in names(lv)) {
    b <- lv[[k]][tr, co, drop = FALSE]
    if (!is.null(open)) b <- b * open
    open <- if (is.null(open)) b == 0L else open & b == 0L
    tab <- tabulate(as.vector(b) + 2L, 3L) / pairs                           # losses, no decision, wins
    per <- c(per, stats::setNames(c(tab[3L], tab[1L]), paste0(c("win_", "loss_"), k)))
  }
  wins <- sum(per[grepl("^win_", names(per))]); losses <- sum(per[grepl("^loss_", names(per))])
  c(z = z, reject = as.numeric(reject), win = wins, loss = losses, tie = max(0, 1 - wins - losses), per)   # a share left over by sums of shares can be -1e-16
}

# --- the runner -----------------------------------------------------------------------------------------------

.vcr_wr_batch_size <- function(n1, n0) as.integer(max(20L, min(500L, round(2 / (6e-8 * (n1 + n0)^2)))))   # about two seconds a batch

#' Run `want` trials of `p` at the given sizes; the batches that finish are kept. Returns the matrix of per-trial values and why it stopped.
.vcr_wr_run <- function(p, n1, n0, want, seed, cores, cancel_file = NULL, batch = NULL, progress = NULL) {
  bank <- vcr_stream_bank(seed)
  batch <- batch %||% .vcr_wr_batch_size(n1, n0)
  done <- 0L; parts <- list(); stopped <- NULL
  while (done < want) {
    if (!is.null(cancel_file) && file.exists(cancel_file)) { stopped <- "canceled"; break }
    reason <- vcr_interrupt()
    if (!is.null(reason)) { stopped <- reason; break }
    take <- as.integer(min(batch, want - done))
    streams <- bank$take(take)
    out <- vcr_map_streams(streams, function(i) .vcr_wr_trial(p, n1, n0), cores = cores, indices = done + seq_len(take))
    parts[[length(parts) + 1L]] <- do.call(rbind, out)
    done <- done + take
    if (!is.null(progress)) progress(done, want)
  }
  list(values = if (length(parts)) do.call(rbind, parts) else NULL, done = done, stopped = stopped)
}

# --- reading the trials -------------------------------------------------------------------------------------------

.vcr_wr_prop <- function(name, x) {
  n <- length(x); q <- mean(x)
  vcr_measure(name, q, simulated = TRUE, mcse = vcr_mcse_proportion(q, n), source = "synthetic",
              interval = vcr_interval("monte_carlo", max(0, q - 1.96 * vcr_mcse_proportion(q, n)), min(1, q + 1.96 * vcr_mcse_proportion(q, n))))
}
.vcr_wr_mean <- function(name, x) {
  s <- if (length(x) > 1L && stats::sd(x) > 0) vcr_mcse_mean(x) else 0
  vcr_measure(name, mean(x), simulated = TRUE, mcse = s, source = "synthetic")
}

#' A ratio of two means over the trials, with the delta-method error from the paired trial values.
.vcr_wr_ratio <- function(name, num, den, interval = NULL, note = NULL) {
  n <- length(num); a <- mean(num); b <- mean(den)
  r <- a / b
  se <- if (n > 1L && is.finite(r)) sqrt(max(0, (stats::var(num) + r^2 * stats::var(den) - 2 * r * stats::cov(num, den)) / n)) / b else 0
  vcr_measure(name, r, simulated = TRUE, mcse = if (is.finite(se)) se else 0, source = "synthetic", interval = interval, note = note)
}

.vcr_wr_cells <- function(v) {
  w <- v[, "win"]; l <- v[, "loss"]; t <- v[, "tie"]
  per <- v[, "win"] - v[, "loss"]
  wr <- w / l
  finite <- is.finite(wr)
  interval <- if (sum(finite) > 20L) vcr_interval("prediction", stats::quantile(wr[finite], 0.025, names = FALSE), stats::quantile(wr[finite], 0.975, names = FALSE)) else NULL
  cells <- list(
    .vcr_wr_ratio("win_ratio", w, l, interval = interval, note = "wins over losses, as the means of the trials; the interval is the range one trial of this size shows"),
    .vcr_wr_mean("win_difference", per),
    .vcr_wr_ratio("win_odds", w + t / 2, l + t / 2),
    .vcr_wr_mean("win_proportion", w), .vcr_wr_mean("loss_proportion", l), .vcr_wr_mean("tie_proportion", t))
  names(cells) <- vapply(cells, function(m) m$name, character(1))
  cells
}

.vcr_wr_level_rows <- function(v, keys) {
  rest <- 1
  rows <- list()
  for (k in keys) {
    w <- v[, paste0("win_", k)]; l <- v[, paste0("loss_", k)]
    rest <- pmax(0, rest - w - l)
    rows[[length(rows) + 1L]] <- list(level = k, cells = list(
      win_proportion = .vcr_wr_mean("win_proportion", w), loss_proportion = .vcr_wr_mean("loss_proportion", l),
      tie_proportion = .vcr_wr_mean("tie_proportion", rest)))
  }
  rows
}

# --- the size that reaches a wanted power -----------------------------------------------------------------------

#' The z statistic grows with the square root of the size, so a pilot at a small size projects the size, one run near it corrects the
#' projection, and the last run at the size found is the one reported: its power, with its error, is what the result says.
.vcr_wr_search <- function(p, seed, cores, cancel_file, want) {
  za <- stats::qnorm(1 - p$alpha / p$sided); zb <- stats::qnorm(p$power)
  project <- function(n, v) {
    mu <- mean(v[, "z"]); s <- max(0.5, stats::sd(v[, "z"]))
    if (!is.finite(mu) || mu <= 1e-3) return(NA_real_)
    n * ((za + s * zb) / mu)^2
  }
  log <- list()
  pilot <- .vcr_wr_run(p, VCR_WR_PILOT_PER_ARM, VCR_WR_PILOT_PER_ARM, VCR_WR_PILOT_TRIALS, seed, cores, cancel_file)
  if (is.null(pilot$values) || nrow(pilot$values) < 50L) return(list(stopped = pilot$stopped %||% "cpu_budget", n = NA_integer_, steps = log))
  n <- project(VCR_WR_PILOT_PER_ARM, pilot$values)
  log[[1L]] <- list(perArm = VCR_WR_PILOT_PER_ARM, trials = nrow(pilot$values), meanZ = mean(pilot$values[, "z"]), projected = n)
  if (!is.finite(n)) return(list(stopped = NULL, n = NA_integer_, steps = log, reason = "no_effect"))
  for (step in 1:2) {
    if (n > p$max_per_arm * 1.05) return(list(stopped = NULL, n = NA_integer_, steps = log, reason = "above_cap", projected = n))
    n_try <- as.integer(min(p$max_per_arm, max(10, ceiling(n))))
    run <- .vcr_wr_run(p, n_try, n_try, VCR_WR_STEP_TRIALS, as.integer((as.numeric(seed) + 7919 * step) %% 2147483647), cores, cancel_file)
    if (is.null(run$values) || nrow(run$values) < 200L) return(list(stopped = run$stopped %||% "cpu_budget", n = n_try, steps = log, projected = TRUE))
    n2 <- project(n_try, run$values)
    log[[length(log) + 1L]] <- list(perArm = n_try, trials = nrow(run$values), meanZ = mean(run$values[, "z"]), projected = n2, power = mean(run$values[, "reject"]))
    if (!is.finite(n2)) break
    close_enough <- abs(n2 - n_try) / n_try < 0.04
    n <- n2
    if (close_enough) break
  }
  if (n > p$max_per_arm * 1.05) return(list(stopped = NULL, n = NA_integer_, steps = log, reason = "above_cap", projected = n))
  list(stopped = NULL, n = as.integer(min(p$max_per_arm, max(10, ceiling(n)))), steps = log)
}

#' What the trials were run on, stated or taken as a default (the assumptions say which), for the page to word.
.vcr_wr_model <- function(p) Filter(Negate(is.null), list(
  nTreat = if (is.na(p$n1)) NULL else p$n1, nControl = if (is.na(p$n0)) NULL else p$n0, followup = p$tau, timeUnit = p$unit, dropoutAnnual = p$drop_annual,
  correlation = p$rho, alpha = p$alpha, sided = p$sided, powerWanted = p$power,
  death = Filter(Negate(is.null), list(hazardRatio = p$hr, controlRisk = p$risk, controlMedian = p$med)),
  events = if (p$has_events) list(controlRate = p$rate0, rateRatio = p$rr, overdispersion = p$theta) else NULL,
  score = if (p$has_score) list(shift = p$shift, sd = p$sd, threshold = p$thr) else NULL))

# --- the handler --------------------------------------------------------------------------------------------------

vcr_job_design_win_ratio <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  sc <- job$scenario
  p <- .vcr_wr_read(sc)
  cores <- vcr_cores(job$cores)
  seed <- vcr_scalar(job$seed, 1)
  floor_ <- as.integer(vcr_replicate_floor(p$is_null))
  want <- as.integer(min(vcr_scalar(job$replicates, floor_), vcr_max_replicates()))
  if (is.null(job$replicates)) p <- .vcr_wr_assume(p, "trials", want, basis = if (p$is_null) "default: the null-scenario floor of simulated trials" else "default: the floor of simulated trials under an alternative")
  searched <- NULL; issues <- list()
  if (p$search) {
    if (p$is_null) vcr_abort("design_effect_null", "scenario.truth", "The scenario has no effect at any level, so no size reaches the power wanted.")
    searched <- .vcr_wr_search(p, seed, cores, cancel_file, want)
    if (is.null(searched$stopped) && identical(searched$reason, "no_effect")) vcr_abort("design_effect_null", "scenario.truth", "The pilot trials show no effect in the direction of benefit, so no size reaches the power wanted.")
    if (is.null(searched$stopped) && identical(searched$reason, "above_cap")) vcr_abort("design_not_computable", "scenario.design.maxPerArm",
      sprintf("No size up to %d patients per arm reaches the power wanted (the pilot trials project about %s per arm).", p$max_per_arm, format(signif(searched$projected, 2), big.mark = ",", scientific = FALSE)))
    if (!is.null(searched$stopped) && !is.finite(searched$n)) vcr_abort("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the pilot trials finished; there is no result.")
    if (!is.null(searched$stopped)) {
      # the budget ended the search: what the trials so far project is the answer, said to be a projection and not a verified power
      return(list(status = if (identical(searched$stopped, "canceled")) "canceled" else "failed", conclusion = "limited", counts = vcr_counts(),
        measures = list(vcr_measure("required_per_arm", searched$n, source = "synthetic", note = "projected from the pilot trials; the power at this size was not simulated")),
        issues = if (identical(searched$stopped, "cpu_budget")) list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit",
          "The CPU budget ran out before the size could be checked by a full run; the size is projected from the trials that finished.")) else list(),
        diagnostics = list(replicatesCompleted = 0L, winRatio = list(levels = c("death", if (p$has_events) "events", if (p$has_score) "score"), trials = 0L, trialsRequested = want, isNull = p$is_null,
          search = list(powerWanted = p$power, perArm = searched$n, steps = searched$steps, maxPerArm = p$max_per_arm, verified = FALSE), assumed = p$assumed,
          model = .vcr_wr_model(p)))))
    }
    p$n1 <- searched$n; p$n0 <- searched$n
    p <- .vcr_wr_assume(p, "design.size", p$n1, basis = "found by a search over simulated trials at the power wanted; one arm each")
  }
  run <- .vcr_wr_run(p, p$n1, p$n0, want, as.integer((as.numeric(seed) + 104729 * p$search) %% 2147483647), cores, cancel_file, batch = vcr_scalar(job$batchSize, NULL), progress = progress)
  v <- run$values
  if (is.null(v) || !nrow(v)) vcr_abort("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the first batch of trials; there is no result.")
  done <- nrow(v)
  rejects <- v[, "reject"]
  power <- .vcr_wr_prop(if (p$is_null) "type_one_error" else "power", rejects)
  cells <- .vcr_wr_cells(v)
  keys <- c("death", if (p$has_events) "events", if (p$has_score) "score")
  measures <- c(list(power), unname(cells[c("win_ratio", "win_difference", "tie_proportion")]))
  if (p$search) measures <- c(list(vcr_measure("required_per_arm", p$n1, source = "synthetic", note = "found by a search over simulated trials; the power at this size is the next number, with its error")), measures)
  stopped <- run$stopped
  if (identical(stopped, "cpu_budget")) issues <- c(issues, list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit",
    "The CPU budget ran out before every trial ran; the numbers use the trials that finished.")))
  status <- if (identical(stopped, "canceled")) "canceled" else if (identical(stopped, "cpu_budget")) "failed" else "succeeded"
  list(status = status, measures = measures, issues = issues, counts = vcr_counts(generatedRecords = done * (p$n1 + p$n0)),
       conclusion = if (is.null(stopped) && !length(issues)) "estimable" else "limited",
       diagnostics = list(replicatesCompleted = done, winRatio = list(
         levels = keys, trials = done, trialsRequested = want, isNull = p$is_null, pairs = p$n1 * p$n0,
         cells = cells, byLevel = .vcr_wr_level_rows(v, keys),
         search = if (is.null(searched)) NULL else list(powerWanted = p$power, perArm = p$n1, steps = searched$steps, maxPerArm = p$max_per_arm),
         assumed = p$assumed, model = .vcr_wr_model(p))))
}

`%||%` <- function(a, b) if (is.null(a)) b else a
