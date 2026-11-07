# ---------------------------------------------------------------------------
# design_dose.R — dose-finding designs (algorithm round T7, T15, 2026-11-03): `design.dose`.
#
# One method, five `design.kind`s, answering the questions a person asks before a first-in-human trial:
#
#   three_plus_three      the rule most phase I trials still use, as the baseline every other design is read against
#   boin                  Bayesian optimal interval design, LOCAL boundaries and a non-informative prior only
#   keyboard              keys of a stated width around the target; the key with the most posterior mass decides
#   crm                   continual reassessment, power model, posterior mean by numerical integration
#   randomized_selection  two or three doses randomised in equal numbers: the exact probability of picking the right one
#
# "这条毒性曲线下，3+3 和 BOIN 选对剂量的概率、超量人数差多少": `design.kind` is the design asked about and `design.compare` the others to run on
# the SAME toxicity curve and the SAME random numbers; the result puts them side by side, with the paired difference and its error.
#
# Hidden knowledge:
#
# - **The engine writes these designs itself.** BOIN, Keyboard and dfcrm (the packages the cases check against) are slow in a simulation:
#   dfcrm extrapolates to about 2,000 s at 100,000 trials and Keyboard did not finish 10,000 within 60 s. Here every trial of a batch moves
#   together: one matrix of latent tolerances, a decision table per (patients, toxicities) and a vector update per cohort, so the cost of
#   a trial is a few array operations and the CRM posterior is one matrix product per cohort.
# - **The same seed means the same patients.** A trial's patient j has one latent tolerance U[t, j]; he or she has a toxicity at a dose
#   when U < the dose's true toxicity. Every design reads the same matrix in the same order, so the difference between two designs is
#   a paired difference (its error is the standard error of the per-trial differences, much smaller than the two errors combined).
# - **The decision tables are the designs.** BOIN: escalate when the toxicity rate at the current dose is at or below
#   lambda_e = log((1-phi1)/(1-phi)) / log(phi(1-phi1)/(phi1(1-phi))), de-escalate at or above lambda_d (the same with phi2), phi1 = 0.6 phi
#   and phi2 = 1.4 phi unless stated; a dose (and every higher one) is eliminated when Pr(p > phi | data) > 0.95 under a uniform prior with
#   at least three patients, and the elimination bound caps the de-escalation bound. Keyboard: the decision is read off the posterior of
#   the dose's toxicity rate, Beta(1 + y, 1 + n - y), over keys of width 2 * margin (the target key is [phi - margin, phi + margin]); the two
#   outermost keys are compared per unit of probability width. The final dose of a BOIN or Keyboard trial is the isotonic estimate (weighted
#   pool-adjacent-violators over the tried, non-eliminated doses, estimate (y + 0.05) / (n + 0.1) with weight 1 / its variance) closest to
#   the target. CRM: p_j = skeleton_j ^ exp(a), a ~ N(0, 1.34); the next dose is the one whose p_j at the posterior mean of a is closest to the
#   target; unless stated, it may not climb more than one level and may not climb after a cohort whose toxicity rate reached the target.
# - **What this build does not say.** BOIN here is the local, non-informative design; combinations and late-onset toxicity are not in it.
#   Nothing in a result says that a design is qualified or endorsed by anyone, and the page words only what was computed.
# - **The true MTD is the dose whose true toxicity is closest to the target** (ties: the lower dose). A "correct selection" is the trial
#   picking that dose; "above the MTD" counts patients treated at higher doses. Both are conventions, written into the premises.
# - **3+3 rule, as simulated.** Three patients per cohort. 0/3: escalate (the top dose: stop there). 1/3: three more at the same dose,
#   then 1/6 or fewer escalates and 2/6 or more means the dose exceeds the MTD. 2/3 or more: the dose exceeds the MTD. When a dose exceeds
#   the MTD the next lower dose is the MTD if six patients were already treated there; else three more are treated there and 1/6 or fewer
#   makes it the MTD, 2/6 or more sends the search lower. No MTD is selected when the lowest dose exceeds it. The trial never goes back up.
# - **Selection among randomised doses** (`randomized_selection`) is exact (no simulation): the higher dose is chosen only when its
#   observed response rate exceeds the candidate's by at least the margin, stepping up from the lowest dose. It is a selection rule of the
#   same kind as the randomised dose-optimisation designs in the literature, not a copy of any published decision table.
# - **A run that is stopped keeps what it has.** Trials run in batches of 1,000 with a seed derived from the job seed and the batch; the
#   cancel file and the CPU budget are asked between batches; a stopped run reports the trials that finished.
# ---------------------------------------------------------------------------

VCR_DOSE_BATCH <- 1000L
VCR_DOSE_DEFAULT_TRIALS <- 10000L
VCR_DOSE_GRID <- seq(-10, 10, by = 0.05)

# --- reading the scenario ------------------------------------------------------------------------------

.vcr_dose_assume <- function(p, key, value, basis = "default") {
  p$assumed[[length(p$assumed) + 1L]] <- list(key = key, value = value, basis = basis)
  p
}

.vcr_dose_read <- function(sc) {
  d <- sc[["design"]]; tr <- sc[["truth"]]
  kind <- as.character(d[["kind"]])
  kinds <- unique(c(kind, vcr_chr(d[["compare"]])))
  p <- list(kind = kind, kinds = kinds, assumed = list(), tox = vcr_num(tr[["toxicity"]]))
  p$K <- length(p$tox)
  p$target <- vcr_scalar(d[["targetToxicity"]], 0.3)
  if (is.null(d[["targetToxicity"]])) p <- .vcr_dose_assume(p, "design.targetToxicity", p$target)
  p$cohort <- as.integer(vcr_scalar(d[["cohortSize"]], 3L))
  if (is.null(d[["cohortSize"]]) && !identical(kinds, "three_plus_three")) p <- .vcr_dose_assume(p, "design.cohortSize", p$cohort)
  p$max_n <- as.integer(vcr_scalar(d[["maxPatients"]], 30L))
  if (is.null(d[["maxPatients"]]) && any(kinds != "three_plus_three")) p <- .vcr_dose_assume(p, "design.maxPatients", p$max_n)
  p$start <- as.integer(vcr_scalar(d[["startDose"]], 1L))
  if (is.null(d[["startDose"]])) p <- .vcr_dose_assume(p, "design.startDose", p$start)
  if (p$start > p$K) vcr_abort("scenario_value_invalid", "scenario.design.startDose", "The starting dose is one of the doses on the curve.")
  p$mtd <- which.min(abs(p$tox - p$target))
  p <- .vcr_dose_assume(p, "truth.mtd", p$mtd, basis = "method: the dose whose true toxicity is closest to the target, the lower one on a tie")
  # BOIN
  b <- d[["boin"]]
  p$phi1 <- vcr_scalar(b[["safeRate"]], 0.6 * p$target); p$phi2 <- vcr_scalar(b[["toxicRate"]], 1.4 * p$target)
  p$boin_cut <- vcr_scalar(b[["eliminationCutoff"]], 0.95)
  if ("boin" %in% kinds) {
    if (is.null(b[["safeRate"]])) p <- .vcr_dose_assume(p, "design.boin.safeRate", p$phi1, basis = "default: 0.6 times the target")
    if (is.null(b[["toxicRate"]])) p <- .vcr_dose_assume(p, "design.boin.toxicRate", p$phi2, basis = "default: 1.4 times the target")
    if (is.null(b[["eliminationCutoff"]])) p <- .vcr_dose_assume(p, "design.boin.eliminationCutoff", p$boin_cut)
    if (!(p$phi1 < p$target && p$target < p$phi2)) vcr_abort("scenario_value_invalid", "scenario.design.boin",
      "The toxicity rate deemed safe is below the target and the one deemed too toxic above it.")
    p <- .vcr_dose_assume(p, "method.boin", "local boundaries, uniform prior for the elimination rule, isotonic final selection; no combinations, no late-onset toxicity", basis = "method")
  }
  # Keyboard
  k <- d[["keyboard"]]
  p$margin <- vcr_scalar(k[["margin"]], 0.05); p$key_cut <- vcr_scalar(k[["eliminationCutoff"]], 0.95)
  if ("keyboard" %in% kinds) {
    if (is.null(k[["margin"]])) p <- .vcr_dose_assume(p, "design.keyboard.margin", p$margin, basis = "default: half the width of the target key")
    if (is.null(k[["eliminationCutoff"]])) p <- .vcr_dose_assume(p, "design.keyboard.eliminationCutoff", p$key_cut)
    if (p$target - p$margin <= 0 || p$target + p$margin >= 1) vcr_abort("scenario_value_invalid", "scenario.design.keyboard.margin", "The target key lies inside 0 and 1.")
    p <- .vcr_dose_assume(p, "method.keyboard", "uniform prior, strongest key decides, isotonic final selection", basis = "method")
  }
  # CRM
  cr <- d[["crm"]]
  if ("crm" %in% kinds) {
    skel <- vcr_num(cr[["skeleton"]])
    if (!length(skel)) {
      hw <- vcr_scalar(cr[["halfwidth"]], 0.05)
      skel <- vcr_crm_skeleton(hw, p$target, p$start, p$K)
      p <- .vcr_dose_assume(p, "design.crm.skeleton", signif(skel, 3), basis = sprintf("default: half-width %.2g around the target, the prior guess of the MTD at the starting dose (%d)", hw, p$start))
    }
    if (length(skel) != p$K) vcr_abort("scenario_value_invalid", "scenario.design.crm.skeleton", "The skeleton has one prior toxicity guess per dose on the curve.")
    p$skeleton <- skel
    p$crm_sd <- sqrt(vcr_scalar(cr[["priorVariance"]], 1.34))
    if (is.null(cr[["priorVariance"]])) p <- .vcr_dose_assume(p, "design.crm.priorVariance", 1.34, basis = "default: the conventional prior variance of the model parameter")
    p$restrict <- if (is.null(cr[["restrictEscalation"]])) TRUE else isTRUE(as.logical(cr[["restrictEscalation"]]))
    if (is.null(cr[["restrictEscalation"]])) p <- .vcr_dose_assume(p, "design.crm.restrictEscalation", TRUE, basis = "default: at most one level up, none after a cohort at or above the target")
    p <- .vcr_dose_assume(p, "method.crm", "power model, posterior mean of the parameter by numerical integration, fixed total size, no stopping for toxicity", basis = "method")
  }
  if ("three_plus_three" %in% kinds) p <- .vcr_dose_assume(p, "method.three_plus_three", "three-patient cohorts, six at a dose in doubt, no dose is retried above one that failed; the size is the rule's own", basis = "method")
  p
}

#' The CRM skeleton for an indifference-interval half-width, a target and the level taken as the prior guess of the MTD (the empiric
#' model): the dose at `nu` sits on the target and each neighbour on the edge of the interval the next dose's guess defines.
vcr_crm_skeleton <- function(halfwidth, target, nu, nlevel) {
  s <- rep(NA_real_, nlevel); s[nu] <- target
  if (nu > 1L) for (k in nu:2L) {
    b <- log(log(target + halfwidth) / log(s[k]))
    s[k - 1L] <- exp(log(target - halfwidth) / exp(b))
  }
  if (nu < nlevel) for (k in nu:(nlevel - 1L)) {
    b <- log(log(target - halfwidth) / log(s[k]))
    s[k + 1L] <- exp(log(target + halfwidth) / exp(b))
  }
  s
}

# --- BOIN and Keyboard: boundary tables --------------------------------------------------------------------

#' The smallest number of toxicities out of n with Pr(p > target | y, n) > cutoff under a uniform prior (NA when there is none, and for n < 3).
vcr_dose_elimination_table <- function(target, cutoff, n_max) {
  vapply(seq_len(n_max), function(n) {
    if (n < 3L) return(NA_real_)
    y <- seq_len(n)
    ok <- which(1 - stats::pbeta(target, y + 1, n - y + 1) > cutoff)
    if (length(ok)) y[ok[1L]] else NA_real_
  }, numeric(1))
}

#' BOIN's tables by number of patients at the dose: escalate if the toxicities are <= `esc`, de-escalate if >= `deesc` (the elimination
#' bound caps it), eliminate if >= `elim`. The two cut-off rates are the closed forms of the likelihood-ratio intervals.
vcr_boin_tables <- function(target, phi1, phi2, cutoff, n_max) {
  lambda_e <- log((1 - phi1) / (1 - target)) / log(target * (1 - phi1) / (phi1 * (1 - target)))
  lambda_d <- log((1 - target) / (1 - phi2)) / log(phi2 * (1 - target) / (target * (1 - phi2)))
  n <- seq_len(n_max)
  esc <- floor(lambda_e * n)
  x <- lambda_d * n
  deesc <- ifelse(abs(round(x) - x) < 1e-12, round(x) + 1, ceiling(x))
  elim <- vcr_dose_elimination_table(target, cutoff, n_max)
  capped <- !is.na(elim) & deesc > elim
  deesc[capped] <- elim[capped]
  list(esc = esc, deesc = deesc, elim = elim, lambdaE = lambda_e, lambdaD = lambda_d)
}

#' The keys of the keyboard design: the target key [target - margin, target + margin] and keys of the same width on both sides, the last
#' ones cut at 0 and 1.
vcr_keyboard_keys <- function(target, margin) {
  a1 <- target - margin; a2 <- target + margin; delta <- a2 - a1
  left <- NULL; i <- 0L; cut <- 1
  while (cut > 0) { i <- i + 1L; cut <- a1 - i * delta; left <- c(cut, left) }
  left[left < 0] <- 0
  right <- NULL; i <- 0L; cut <- 0
  while (cut < 1) { i <- i + 1L; cut <- a2 + i * delta; right <- c(right, cut) }
  right[right > 1] <- 1
  c(left, a1, a2, right)
}

#' The keyboard design's tables, one entry per number of patients at the dose: escalate if the toxicities are <= `esc` (-1 when never),
#' de-escalate if >= `deesc`, eliminate if >= `elim`. At each (n, y) the strongest key decides; the outermost keys are compared per unit
#' of probability width, and a tie goes to the highest key.
vcr_keyboard_tables <- function(target, margin, cutoff, n_max) {
  keys <- vcr_keyboard_keys(target, margin)
  nkeys <- length(keys) - 1L
  width <- diff(keys)
  comp <- rep(1, nkeys); comp[c(1L, nkeys)] <- (2 * margin) / width[c(1L, nkeys)]
  target_key <- which(keys == (target - margin))
  esc <- deesc <- elim <- rep(NA_real_, n_max)
  for (n in seq_len(n_max)) {
    y <- 0:n
    code <- character(n + 1L)
    elim_from <- NA_integer_
    for (j in seq_along(y)) {
      if (1 - stats::pbeta(target, y[j] + 1, n - y[j] + 1) > cutoff) { elim_from <- j; break }
      mass <- (stats::pbeta(keys[-1L], y[j] + 1, n - y[j] + 1) - stats::pbeta(keys[-length(keys)], y[j] + 1, n - y[j] + 1)) * comp
      high <- max(which(mass == max(mass)))
      code[j] <- if (high > target_key) "D" else if (high == target_key) "S" else "E"
    }
    if (!is.na(elim_from)) code[elim_from:(n + 1L)] <- "DU"
    esc[n] <- if (any(code == "E")) max(which(code == "E")) - 1 else -1
    deesc[n] <- if (any(code == "D")) min(which(code == "D")) - 1 else if (any(code == "DU")) min(which(code == "DU")) - 1 else NA_real_
    elim[n] <- if (any(code == "DU")) min(which(code == "DU")) - 1 else NA_real_
  }
  list(esc = esc, deesc = deesc, elim = elim, keys = keys)
}

# --- the final dose of a BOIN or Keyboard trial -------------------------------------------------------------------

#' The dose a BOIN or Keyboard trial recommends, for every trial at once. `N` and `Y` are trials x doses. 0 means no dose: the lowest dose
#' was eliminated, or nothing was tried and kept. Weighted isotonic regression of (y + 0.05) / (n + 0.1) over the tried, non-eliminated
#' doses by the min-max formula (max over starts of the min over ends of the weighted mean), then the dose whose estimate, nudged by
#' 1e-10 times its position so that a tie goes the way the usual implementation sends it, is closest to the target.
vcr_dose_select_isotonic <- function(N, Y, target, cutoff) {
  T <- nrow(N); K <- ncol(N)
  flag <- N >= 3L & (1 - stats::pbeta(target, Y + 1, N - Y + 1) > cutoff)
  for (j in seq_len(K)[-1L]) flag[, j] <- flag[, j] | flag[, j - 1L]
  adm <- N > 0L & !flag
  none <- flag[, 1L] | rowSums(adm) == 0L
  x <- (Y + 0.05) / (N + 0.1)
  v <- (Y + 0.05) * (N - Y + 0.05) / ((N + 0.1)^2 * (N + 1.1))
  w <- ifelse(adm, 1 / v, 0)
  A <- B <- matrix(0, T, K + 1L)
  for (j in seq_len(K)) { A[, j + 1L] <- A[, j] + w[, j] * x[, j]; B[, j + 1L] <- B[, j] + w[, j] }
  est <- matrix(NA_real_, T, K)
  for (j in seq_len(K)) {
    best <- rep(-Inf, T)
    for (i in seq_len(j)) {
      lowest <- rep(Inf, T)
      for (k in j:K) lowest <- pmin(lowest, (A[, k + 1L] - A[, i]) / (B[, k + 1L] - B[, i]))
      best <- pmax(best, lowest)
    }
    est[, j] <- best
  }
  pos <- adm; storage.mode(pos) <- "integer"
  for (j in seq_len(K)[-1L]) pos[, j] <- pos[, j - 1L] + pos[, j]
  est <- est + pos * 1e-10
  gap <- abs(est - target); gap[!adm | is.na(gap)] <- Inf
  pick <- max.col(-gap, ties.method = "first")
  pick[none] <- 0L
  as.integer(pick)
}

# --- the trial loops ---------------------------------------------------------------------------------------------

#' A trial design that moves by a table (BOIN, Keyboard). `U` is trials x patients of latent tolerances; returns the patients and the
#' toxicities at each dose, whether the trial stopped early, and the dose recommended.
.vcr_dose_run_table <- function(U, ptrue, tab, start, cohort, max_n, target, cutoff) {
  T <- nrow(U); K <- length(ptrue)
  d <- rep.int(start, T); N <- matrix(0L, T, K); Y <- matrix(0L, T, K)
  elim_from <- rep.int(K + 1L, T); stopped <- rep(FALSE, T)
  used <- 0L
  while (used < max_n) {
    act <- which(!stopped)
    if (!length(act)) break
    s <- min(cohort, max_n - used)
    da <- d[act]
    tox <- as.integer(rowSums(U[act, used + seq_len(s), drop = FALSE] < ptrue[da]))
    idx <- cbind(act, da)
    N[idx] <- N[idx] + s; Y[idx] <- Y[idx] + tox
    used <- used + s
    if (used >= max_n) break
    nd <- N[idx]; yd <- Y[idx]
    e <- tab$elim[nd]
    hit <- nd >= 3L & !is.na(e) & yd >= e
    if (any(hit)) {
      elim_from[act[hit]] <- pmin(elim_from[act[hit]], da[hit])
      stopped[act[hit & da == 1L]] <- TRUE
    }
    esc_ok <- yd <= tab$esc[nd]; esc_ok[is.na(esc_ok)] <- FALSE
    down_ok <- yd >= tab$deesc[nd]; down_ok[is.na(down_ok)] <- FALSE
    up <- esc_ok & da != K
    nxt <- da
    nxt[up & (da + 1L) < elim_from[act]] <- da[up & (da + 1L) < elim_from[act]] + 1L
    dn <- !up & down_ok & da != 1L
    nxt[dn] <- da[dn] - 1L
    d[act] <- ifelse(stopped[act], da, nxt)
  }
  sel <- vcr_dose_select_isotonic(N, Y, target, cutoff)
  sel[stopped] <- 0L
  list(N = N, Y = Y, sel = sel)
}

#' The posterior mean of the CRM parameter for every trial at once: the grid integral of a * likelihood * prior over the likelihood * prior.
#' `logs` is the skeleton's log, `grid` the integration points; the weights are those of the trapezoid rule, which for an integrand this
#' smooth and this small at the ends is accurate to rounding.
.vcr_crm_posterior_mean <- function(N, Y, logs, grid, prior_sd) {
  e <- exp(grid)
  L1 <- outer(logs, e)                    # K x G: log p_j(a)
  L0 <- log(-expm1(L1))                   # log(1 - p_j(a))
  ll <- Y %*% L1 + (N - Y) %*% L0
  ll <- sweep(ll, 2L, -grid^2 / (2 * prior_sd^2), "+")
  ll <- ll - ll[cbind(seq_len(nrow(ll)), max.col(ll, ties.method = "first"))]
  w <- exp(ll)
  as.vector(w %*% grid) / rowSums(w)
}

#' The dose the CRM recommends from the posterior mean of its parameter: the one whose skeleton at that parameter is closest to the target
#' (the lowest on a tie); the top dose when every probability is at or below the target, the lowest when every one is at or above it.
.vcr_crm_recommend <- function(N, Y, skeleton, target, grid, prior_sd) {
  a <- .vcr_crm_posterior_mean(N, Y, log(skeleton), grid, prior_sd)
  ptox <- outer(exp(a), log(skeleton))     # T x K: log of s_j ^ exp(a) is exp(a) * log(s_j)
  p <- exp(ptox)
  gap <- abs(p - target)
  rec <- max.col(-gap, ties.method = "first")
  rec[rowSums(p >= target) == ncol(p)] <- 1L
  rec[rowSums(p <= target) == ncol(p)] <- ncol(p)
  list(dose = as.integer(rec), a = a)
}

.vcr_dose_run_crm <- function(U, ptrue, skeleton, start, cohort, max_n, target, prior_sd, restrict, grid = VCR_DOSE_GRID) {
  T <- nrow(U); K <- length(ptrue)
  d <- rep.int(start, T); N <- matrix(0L, T, K); Y <- matrix(0L, T, K)
  used <- 0L; rows <- seq_len(T)
  repeat {
    s <- min(cohort, max_n - used)
    tox <- as.integer(rowSums(U[, used + seq_len(s), drop = FALSE] < ptrue[d]))
    idx <- cbind(rows, d)
    N[idx] <- N[idx] + s; Y[idx] <- Y[idx] + tox
    used <- used + s
    if (used >= max_n) break
    nxt <- .vcr_crm_recommend(N, Y, skeleton, target, grid, prior_sd)$dose
    if (restrict) nxt <- ifelse(tox / cohort >= target, pmin(nxt, d), pmin(nxt, d + 1L))
    d <- as.integer(nxt)
  }
  list(N = N, Y = Y, sel = .vcr_crm_recommend(N, Y, skeleton, target, grid, prior_sd)$dose)
}

#' 3+3, every trial at once. See the file header for the rule. Cohorts of three; `mode` 0 is escalating, 1 is stepping down after a dose
#' exceeded the MTD. A trial that is done holds the dose it selected (0: none).
.vcr_dose_run_three_plus_three <- function(U, ptrue) {
  T <- nrow(U); K <- length(ptrue)
  d <- rep.int(1L, T); N <- matrix(0L, T, K); Y <- matrix(0L, T, K)
  used <- rep.int(0L, T); down <- rep(FALSE, T); done <- rep(FALSE, T); sel <- rep.int(0L, T)
  repeat {
    act <- which(!done)
    if (!length(act)) break
    da <- d[act]; ua <- used[act]
    tox <- (U[cbind(act, ua + 1L)] < ptrue[da]) + (U[cbind(act, ua + 2L)] < ptrue[da]) + (U[cbind(act, ua + 3L)] < ptrue[da])
    idx <- cbind(act, da)
    N[idx] <- N[idx] + 3L; Y[idx] <- Y[idx] + as.integer(tox)
    used[act] <- ua + 3L
    nd <- N[idx]; yd <- Y[idx]
    expand <- nd == 3L & yd == 1L                      # 1/3: three more at the same dose
    pass <- (nd == 3L & yd == 0L) | (nd == 6L & yd <= 1L)
    fail <- (nd == 3L & yd >= 2L) | (nd == 6L & yd >= 2L)
    # a dose that passed: stepping down, it is the MTD; escalating, go up unless it is the top dose
    at_top <- pass & !down[act] & da == K
    stop_here <- pass & (down[act] | at_top)
    sel[act[stop_here]] <- da[stop_here]; done[act[stop_here]] <- TRUE
    up <- pass & !stop_here
    d[act[up]] <- da[up] + 1L
    # a dose that failed: the lowest dose has no MTD below it; otherwise the next lower dose is the MTD if six were treated there
    none <- fail & da == 1L
    done[act[none]] <- TRUE
    lower <- fail & da > 1L
    if (any(lower)) {
      a2 <- act[lower]; l <- da[lower] - 1L
      six <- N[cbind(a2, l)] >= 6L
      sel[a2[six]] <- l[six]; done[a2[six]] <- TRUE
      d[a2] <- l; down[a2] <- TRUE
    }
    # (the expansion cohort stays at the same dose: nothing changes for `expand`)
    invisible(expand)
  }
  list(N = N, Y = Y, sel = sel)
}

# --- one batch of trials for every design ------------------------------------------------------------------------------

#' Run `fn` with a seed of its own and hand the caller's generator back as it found it.
.vcr_dose_with_seed <- function(seed, fn) {
  had <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  old <- if (had) get(".Random.seed", envir = .GlobalEnv, inherits = FALSE) else NULL
  kind <- RNGkind()
  on.exit({
    RNGkind(kind[1L], kind[2L], kind[3L])
    if (had) assign(".Random.seed", old, envir = .GlobalEnv)
    else if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) rm(".Random.seed", envir = .GlobalEnv)
  }, add = TRUE)
  set.seed(seed, kind = "Mersenne-Twister")
  fn()
}

.vcr_dose_batch_seed <- function(seed, batch) as.integer(1 + ((as.numeric(seed) * 1009 + batch * 7919) %% 2147483646))

#' The number of latent tolerances drawn for a trial: the same whichever designs run, so that adding a comparison never changes the
#' numbers of the design asked about (a trial of 3+3 uses at most six patients at each dose and three more).
.vcr_dose_patients_needed <- function(p) max(6L * p$K + 3L, p$max_n)

.vcr_dose_tables <- function(p) {
  list(boin = if ("boin" %in% p$kinds) vcr_boin_tables(p$target, p$phi1, p$phi2, p$boin_cut, p$max_n),
       keyboard = if ("keyboard" %in% p$kinds) vcr_keyboard_tables(p$target, p$margin, p$key_cut, p$max_n))
}

.vcr_dose_batch <- function(p, tables, take, seed) {
  U <- .vcr_dose_with_seed(seed, function() matrix(stats::runif(take * .vcr_dose_patients_needed(p)), nrow = take))
  out <- list()
  for (kind in p$kinds) {
    out[[kind]] <- switch(kind,
      three_plus_three = .vcr_dose_run_three_plus_three(U, p$tox),
      boin = .vcr_dose_run_table(U, p$tox, tables$boin, p$start, p$cohort, p$max_n, p$target, p$boin_cut),
      keyboard = .vcr_dose_run_table(U, p$tox, tables$keyboard, p$start, p$cohort, p$max_n, p$target, p$key_cut),
      crm = .vcr_dose_run_crm(U, p$tox, p$skeleton, p$start, p$cohort, p$max_n, p$target, p$crm_sd, p$restrict))
  }
  out
}

# --- reading the trials -------------------------------------------------------------------------------------------------

.vcr_dose_prob <- function(name, flag) {
  n <- length(flag); q <- mean(flag)
  vcr_measure(name, q, simulated = TRUE, mcse = vcr_mcse_proportion(q, n), source = "synthetic")
}
.vcr_dose_mean <- function(name, x) {
  s <- if (length(x) > 1L && stats::sd(x) > 0) vcr_mcse_mean(x) else 0
  vcr_measure(name, mean(x), simulated = TRUE, mcse = s, source = "synthetic")
}

#' The numbers of one design: the per-trial vectors, then the measure-shaped cells.
.vcr_dose_vectors <- function(run, mtd) {
  K <- ncol(run$N)
  above <- if (mtd < K) rowSums(run$N[, (mtd + 1L):K, drop = FALSE]) else rep(0, nrow(run$N))
  below <- if (mtd > 1L) rowSums(run$N[, 1L:(mtd - 1L), drop = FALSE]) else rep(0, nrow(run$N))
  list(correct = run$sel == mtd, above_sel = run$sel > mtd, below_sel = run$sel > 0L & run$sel < mtd, none = run$sel == 0L,
       size = rowSums(run$N), dlt = rowSums(run$Y), above = above, at = run$N[, mtd], below = below)
}

.vcr_dose_cells <- function(run, v, K) {
  cells <- list(.vcr_dose_prob("correct_dose_probability", v$correct), .vcr_dose_prob("select_above_mtd_probability", v$above_sel),
                .vcr_dose_prob("select_below_mtd_probability", v$below_sel), .vcr_dose_prob("select_none_probability", v$none),
                .vcr_dose_mean("expected_sample_size", v$size), .vcr_dose_mean("expected_dlt", v$dlt),
                .vcr_dose_mean("patients_above_mtd", v$above), .vcr_dose_mean("patients_at_mtd", v$at), .vcr_dose_mean("patients_below_mtd", v$below))
  for (j in seq_len(K)) cells[[length(cells) + 1L]] <- .vcr_dose_prob(sprintf("select_dose_%d", j), run$sel == j)
  for (j in seq_len(K)) cells[[length(cells) + 1L]] <- .vcr_dose_mean(sprintf("patients_dose_%d", j), run$N[, j])
  names(cells) <- vapply(cells, function(m) m$name, character(1))
  cells
}

#' The difference of two designs on the same trials, with the error of the paired differences.
.vcr_dose_paired <- function(name, a, b) {
  x <- as.numeric(a) - as.numeric(b)
  vcr_measure(name, mean(x), simulated = TRUE, mcse = if (length(x) > 1L && stats::sd(x) > 0) vcr_mcse_mean(x) else 0, source = "synthetic")
}

# --- the handler ---------------------------------------------------------------------------------------------------------

.vcr_dose_finding <- function(job, progress = NULL) {
  sc <- job$scenario
  p <- .vcr_dose_read(sc)
  screening <- vcr_screening_replicates(sc)
  want <- screening %||% as.integer(vcr_scalar(job$replicates, VCR_DOSE_DEFAULT_TRIALS))
  if (is.null(job$replicates) && is.null(screening)) p <- .vcr_dose_assume(p, "trials", want, basis = "default: simulated trials per design")
  tables <- .vcr_dose_tables(p)
  seed <- vcr_scalar(job$seed, 1)
  parts <- list(); done <- 0L; stopped <- NULL; b <- 0L
  while (done < want) {
    reason <- vcr_interrupt()
    if (!is.null(reason)) { stopped <- reason; break }
    b <- b + 1L
    take <- as.integer(min(VCR_DOSE_BATCH, want - done))
    parts[[b]] <- .vcr_dose_batch(p, tables, take, .vcr_dose_batch_seed(seed, b))
    done <- done + take
    if (!is.null(progress)) progress(done, want)
  }
  if (done == 0L) vcr_abort("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the first batch of trials; there is no result.")
  join <- function(kind, field) do.call(rbind, lapply(parts, function(x) x[[kind]][[field]]))
  designs <- list(); vec <- list()
  for (kind in p$kinds) {
    run <- list(N = join(kind, "N"), Y = join(kind, "Y"), sel = unlist(lapply(parts, function(x) x[[kind]]$sel), use.names = FALSE))
    v <- .vcr_dose_vectors(run, p$mtd); vec[[kind]] <- v
    designs[[length(designs) + 1L]] <- list(kind = kind, role = if (identical(kind, p$kind)) "asked" else "compared", trials = done, cells = .vcr_dose_cells(run, v, p$K))
  }
  differences <- list()
  for (kind in setdiff(p$kinds, p$kind)) {
    differences[[length(differences) + 1L]] <- list(kind = kind, against = p$kind, trials = done, cells = list(
      correct_dose_probability = .vcr_dose_paired("correct_dose_probability", vec[[kind]]$correct, vec[[p$kind]]$correct),
      patients_above_mtd = .vcr_dose_paired("patients_above_mtd", vec[[kind]]$above, vec[[p$kind]]$above),
      expected_sample_size = .vcr_dose_paired("expected_sample_size", vec[[kind]]$size, vec[[p$kind]]$size),
      expected_dlt = .vcr_dose_paired("expected_dlt", vec[[kind]]$dlt, vec[[p$kind]]$dlt)))
  }
  head <- designs[[1L]]$cells
  measures <- unname(head[c("correct_dose_probability", "patients_above_mtd", "expected_sample_size", "expected_dlt", "select_none_probability")])
  stop_state <- if (is.null(stopped)) NULL else list(status = if (identical(stopped, "canceled")) "canceled" else "failed",
    issues = if (identical(stopped, "cpu_budget")) list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit",
      "The CPU budget ran out before every trial ran; the numbers use the trials that finished.")) else list())
  list(status = stop_state$status %||% "succeeded", measures = measures, issues = stop_state$issues %||% list(), counts = vcr_counts(generatedRecords = done * length(p$kinds)),
       conclusion = if (is.null(stop_state)) "estimable" else "limited",
       diagnostics = c(list(replicatesCompleted = done, doseFinding = list(kind = p$kind, curve = list(toxicity = p$tox, target = p$target, mtd = p$mtd, doses = p$K),
         designs = designs, differences = differences, trials = done, trialsRequested = want, assumed = p$assumed, given = .vcr_dose_given(sc, p))),
         # a campaign's run says its purpose and how many trials ran against the design's normal number (its pairing is within the job)
         if (is.list(sc[["evaluation"]])) list(evaluation = list(version = 1L, purpose = if (is.null(screening)) "final" else "screening",
           replicates = as.integer(done), floor = VCR_DOSE_DEFAULT_TRIALS))))
}

.vcr_dose_given <- function(sc, p) {
  d <- sc$design
  Filter(Negate(is.null), list(targetToxicity = vcr_scalar(d[["targetToxicity"]], NULL), cohortSize = vcr_scalar(d[["cohortSize"]], NULL),
    maxPatients = vcr_scalar(d[["maxPatients"]], NULL), startDose = vcr_scalar(d[["startDose"]], NULL), doses = p$K,
    compared = if (length(p$kinds) > 1L) setdiff(p$kinds, p$kind)))
}

# --- randomised dose selection (T15), exact ---------------------------------------------------------------------------------------

#' The probability that each dose is selected, exactly: n patients in each of the arms, the lowest dose is the candidate, and each higher dose
#' replaces the candidate when its response count is at least `cut` above the candidate's. The state is the candidate and its count, so a step
#' is a few cumulative sums.
vcr_dose_selection_probabilities <- function(n, rates, cut) {
  k <- length(rates); x <- 0:n
  q <- lapply(rates, function(r) stats::dbinom(x, n, r))
  M <- matrix(0, k, n + 1L); M[1L, ] <- q[[1L]]
  for (j in 2:k) {
    total <- colSums(M)                                    # mass by the candidate's count
    cum <- cumsum(total)
    stays <- stats::pbinom(pmax(-1, x + cut - 1), n, rates[j])
    stays[x + cut - 1 < 0] <- 0
    reach <- ifelse(x - cut >= 0, cum[pmax(1L, x - cut + 1L)], 0)
    M <- M * rep(stays, each = k)
    M[j, ] <- q[[j]] * reach
  }
  rowSums(M)
}

#' The dose that is right for a set of true rates: the lowest dose whose rate is within the margin of the best (strictly).
vcr_dose_right_dose <- function(rates, margin) min(which(rates > max(rates) - margin))

.vcr_dose_randomised <- function(job) {
  sc <- job$scenario; d <- sc$design; tr <- sc$truth
  margin <- vcr_scalar(d[["margin"]], NULL)
  if (is.null(margin)) vcr_abort("scenario_field_missing", "scenario.design.margin", "A selection among randomised doses states the margin: how much better the higher dose must look before it is chosen.")
  scenarios <- lapply(tr[["responseScenarios"]], vcr_num)
  k <- unique(lengths(scenarios))
  if (length(k) != 1L) vcr_abort("scenario_value_invalid", "scenario.truth.responseScenarios", "Every scenario states one response rate per dose, the same doses in each.")
  target <- vcr_scalar(d[["targetProbability"]], 0.9)
  max_per_arm <- as.integer(vcr_scalar(d[["maxPerArm"]], 300L))
  asked <- vcr_scalar(d[["perArm"]], NULL)
  p <- list(assumed = list())
  if (is.null(d[["targetProbability"]])) p <- .vcr_dose_assume(p, "design.targetProbability", target)
  if (is.null(d[["maxPerArm"]]) && is.null(asked)) p <- .vcr_dose_assume(p, "design.maxPerArm", max_per_arm, basis = "default: the search for the size stops here")
  cutoff <- function(n) as.integer(ceiling(margin * n - 1e-9))
  right <- vapply(scenarios, vcr_dose_right_dose, numeric(1), margin = margin)
  at <- function(n) {
    probs <- lapply(scenarios, function(r) vcr_dose_selection_probabilities(n, r, cutoff(n)))
    list(select = probs, correct = vapply(seq_along(probs), function(i) probs[[i]][right[i]], numeric(1)))
  }
  # the size: the first number per arm at which every scenario reaches the probability, and the first from which every larger size up to the cap does
  first <- NA_integer_; stable <- NA_integer_
  if (is.null(asked)) {
    ok <- vapply(seq_len(max_per_arm), function(n) all(at(n)$correct >= target - 1e-12), logical(1))
    if (any(ok)) {
      first <- which(ok)[1L]
      bad <- which(!ok)
      stable <- if (!length(bad)) 1L else if (max(bad) < max_per_arm) max(bad) + 1L else NA_integer_
    }
  }
  n_per_arm <- as.integer(asked %||% (if (is.na(first)) max_per_arm else first))
  res <- at(n_per_arm)
  rows <- lapply(seq_along(scenarios), function(i) list(rates = scenarios[[i]], rightDose = right[i],
    cells = c(list(correct_dose_probability = vcr_measure("correct_dose_probability", res$correct[i], source = "calculated")),
              stats::setNames(lapply(seq_along(res$select[[i]]), function(j) vcr_measure(sprintf("select_dose_%d", j), res$select[[i]][j], source = "calculated")),
                              sprintf("select_dose_%d", seq_along(res$select[[i]]))))))
  measures <- list(vcr_measure("per_arm", n_per_arm, source = "calculated"), vcr_measure("total_patients", n_per_arm * k, source = "calculated"),
                   vcr_measure("worst_correct_dose_probability", min(res$correct), source = "calculated"))
  if (is.null(asked) && !is.na(first)) measures <- c(measures, list(vcr_measure("required_per_arm", first, source = "calculated")))
  if (is.null(asked) && is.na(first)) {
    issues <- list(vcr_issue("design_not_computable", "scenario.design.maxPerArm", sprintf("No size up to %d patients per arm gives every scenario a probability of %.2f; the table is for %d per arm.", max_per_arm, target, n_per_arm)))
  } else issues <- list()
  list(status = "succeeded", measures = measures, issues = issues, counts = vcr_counts(), conclusion = if (length(issues)) "limited" else "estimable",
       diagnostics = list(doseSelection = list(kind = "randomized_selection", doses = k, perArm = n_per_arm, margin = margin, cutoffResponses = cutoff(n_per_arm),
         targetProbability = target, requiredFirst = if (is.na(first)) NULL else first, requiredStable = if (is.na(stable)) NULL else stable, scenarios = rows,
         assumed = p$assumed, given = Filter(Negate(is.null), list(margin = margin, perArm = asked, doses = k)))))
}

# --- the dispatcher -------------------------------------------------------------------------------------------------------------

vcr_job_design_dose <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  kind <- as.character(job$scenario$design$kind %||% "")
  switch(kind,
    randomized_selection = .vcr_dose_randomised(job),
    three_plus_three = , boin = , keyboard = , crm = .vcr_dose_finding(job, progress),
    vcr_abort("design_not_supported", "scenario.design.kind", sprintf("'%s' is not a dose-finding design this build computes.", kind)))
}
