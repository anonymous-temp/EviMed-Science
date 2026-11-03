# ---------------------------------------------------------------------------
# quality_inference.R — what a synthetic population can and cannot be trusted for
# (algorithm round P1, P2; extends quality.R).
#
# Hidden knowledge:
#
# - **A synthetic table is not a sample of the people; it is a sample of a model of them.** Fitting a regression to it as if it were the
#   data reports a standard error that leaves out the sampling error of the model the table was made from. The combining rules of Raab,
#   Nowok & Dibben (2016) put it back, and they are the ones `synthpop` implements (`summary.fit.synds(population.inference = TRUE)`):
#   with the generator fitted to n people and each of the m copies holding k rows, the combined variance of an estimate is
#       T = (k/n) * ubar * (1 + n / (k m))            when the parameters were NOT redrawn for each copy (synthpop's default, `proper = FALSE`)
#       T = (k/n) * ubar * (1 + (n/k + 1) / m)        when they were (`proper = TRUE`)
#   with ubar the mean of the m within-copy variances and the estimate the mean of the m estimates. Both are what synthpop prints, byte
#   for byte (N96a); the engine's own generator never redraws the parameters, so the first is the rule of every synthesis it makes. A
#   table the engine did not make is read with the same rule and the premise says so.
# - **The type I error of an analysis run on synthetic data is measured, not argued.** Permute the arm labels of the REAL table (the
#   null is true by construction), make the synthetic copies from the permuted table the way the job made them, run the person's own
#   analysis on the copies, and count how often the interval excludes no effect. Done R times, this is a simulated proportion with its
#   Monte Carlo error, and it is reported three ways: the analysis on the permuted real table (the nominal rate), the first synthetic
#   copy read as if it were real data (the naive rate: what people do), and the copies combined by the rule above. The naive rate is
#   what Decruyenaere et al. (2024) and Chassat et al. (2025) found inflated, and the gap between the first and the third is the
#   reason the rule exists.
# - **Per-record privacy is the tail, not the mean.** An average distance to the closest record hides the few records a generator copied
#   (Yao et al. 2025: the mean distance and the attack's AUC were uncorrelated across 99 settings). Each real record's distance to the
#   closest synthetic record is turned into the posterior probability that the record was in the training table when the attacker
#   knows only that distance and the holdout's distances are what a non-member looks like: with F_train and F_hold the shares of the
#   training and the holdout records at least as close, the record's risk is F_train / (F_train + F_hold) (each with one added to numerator
#   and denominator, so a tail with no holdout record in it is not a certainty). 0.5 is a coin; the same number is computed for the
#   holdout records, which are known to be non-members, and that share is what chance alone gives.
# - **A leak is the excess over a control, never the rate itself.** An attribute that the other columns predict well is predicted well for
#   a stranger too; the attack reads a real person's other columns, finds the closest synthetic record and takes its value of the secret
#   column. Its success on training records is held against its success on holdout records, who are not in the data
#   (anonymeter's inference evaluation: risk = (main - control) / (1 - control)).
# - **People are never shown.** The at-risk group is described by the share of each level of each column in it, and a count of 1 to
#   (minCellSize - 1) people is not shown (`vcr_suppress_cells`, the rule every other patient-level result keeps).
# ---------------------------------------------------------------------------

#' The combined estimate and variance of m synthetic copies (Raab, Nowok & Dibben 2016, as synthpop::summary.fit.synds).
#'
#' @param estimates,variances one estimate and its within-copy variance per copy (NA copies are dropped and counted)
#' @param n_observed rows of the table the generator was fitted to
#' @param n_synthetic rows of one copy
#' @param proper TRUE when the generator redrew its parameters for every copy
vcr_combine_synthetic <- function(estimates, variances, n_observed, n_synthetic, proper = FALSE, level = 0.95) {
  ok <- is.finite(estimates) & is.finite(variances) & variances >= 0
  m <- sum(ok)
  if (m < 1L) return(list(available = FALSE, reason = "analysis_not_estimable", copies = length(estimates), failedCopies = length(estimates)))
  qbar <- mean(estimates[ok]); ubar <- mean(variances[ok])
  n <- n_observed; k <- n_synthetic
  vars <- ubar * k / n
  total <- if (isTRUE(proper)) vars * (1 + (n / k + 1) / m) else vars * (1 + n / k / m)
  z <- stats::qnorm(1 - (1 - level) / 2)
  se <- sqrt(total)
  list(available = TRUE, estimate = qbar, variance = total, se = se, interval = qbar + c(-1, 1) * z * se, level = level,
       copies = m, failedCopies = length(estimates) - m, withinVariance = ubar, naiveSe = sqrt(ubar),
       zStatistic = qbar / se, pValue = 2 * stats::pnorm(-abs(qbar / se)),
       rule = if (isTRUE(proper)) "proper_synthesis" else "simple_synthesis", observedRows = n, syntheticRows = k)
}

#' A declared analysis's own column of arms, when it has one: the column whose labels a permutation breaks.
vcr_analysis_arm_column <- function(spec) {
  kind <- as.character(spec$kind %||% "")
  col <- switch(kind, glm = spec$target, cox = spec$target, logrank = spec$group, rmst = spec$group, NULL)
  if (is.null(col)) NULL else as.character(col)
}

#' The per-copy results of one declared analysis on every copy, combined; `real` is the same analysis on the real table.
vcr_synthetic_inference <- function(f, real, copies, n_observed, proper = FALSE) {
  one <- lapply(copies, function(d) tryCatch(f(d), error = function(e) list(estimate = NA_real_, interval = c(NA_real_, NA_real_), se = NA_real_)))
  se_of <- function(a) {
    s <- a$se %||% NA_real_
    if (!is.finite(s) && length(a$interval) == 2L && all(is.finite(a$interval))) s <- diff(a$interval) / (2 * stats::qnorm(0.975))
    s
  }
  est <- vapply(one, function(a) as.numeric(a$estimate %||% NA_real_), numeric(1))
  v <- vapply(one, function(a) se_of(a)^2, numeric(1))
  comb <- vcr_combine_synthetic(est, v, n_observed, nrow(copies[[1L]]), proper)
  if (isTRUE(comb$available)) {
    comb$perCopy <- data.frame(copy = seq_along(copies), estimate = est, standardError = sqrt(v))
    ra <- real$interval
    comb$confidenceIntervalOverlap <- if (length(ra) == 2L && all(is.finite(ra))) vcr_ci_overlap(ra, comb$interval) else NA_real_
  }
  comb
}

# --- the permuted-arm type I error ------------------------------------------------------------

#' How often an analysis run on synthetic data finds an effect that is not there.
#'
#' @param train the real table the generator is fitted to
#' @param f the declared analysis, `function(table) -> list(estimate, se, interval)`
#' @param arm the column whose labels are permuted
#' @param regenerate `function(table, seed) -> list of data.frames`: the job's own generator, run on a permuted table
#' @param replicates how many permuted tables
#' @param seed the job's seed (each replicate takes its own L'Ecuyer substream)
#' @param alpha two-sided level of the test the interval implies
#' @param proper TRUE when the generator redraws its parameters for each copy (the rule of Raab et al. then adds their variance)
vcr_null_calibration <- function(train, f, arm, regenerate, replicates, seed, alpha = 0.05, proper = FALSE) {
  z <- stats::qnorm(1 - alpha / 2)
  streams <- vcr_stream_bank(seed)$take(replicates)
  rows <- vector("list", replicates); done <- 0L; interrupted <- NULL
  for (r in seq_len(replicates)) {
    interrupted <- vcr_interrupt()
    if (!is.null(interrupted)) break
    rows[[r]] <- vcr_with_stream(streams[[r]], function(i) {
      perm <- train
      perm[[arm]] <- perm[[arm]][sample.int(nrow(perm))]
      s <- sample.int(.Machine$integer.max - 1L, 1L)
      real <- tryCatch(f(perm), error = function(e) NULL)
      copies <- tryCatch(regenerate(perm, s), error = function(e) NULL)
      if (is.null(real) || is.null(copies) || !is.null(copies$interrupted)) return(NULL)
      comb <- vcr_synthetic_inference(f, real, copies, nrow(perm), proper)
      first <- tryCatch(f(copies[[1L]]), error = function(e) NULL)
      if (is.null(first) || !isTRUE(comb$available)) return(NULL)
      se_real <- real$se %||% (diff(real$interval) / (2 * 1.96)); se_first <- first$se %||% (diff(first$interval) / (2 * 1.96))
      c(real = as.numeric(abs(real$estimate / se_real) > z), naive = as.numeric(abs(first$estimate / se_first) > z),
        combined = as.numeric(abs(comb$estimate / comb$se) > z),
        seRatio = comb$se / se_first)
    }, r)
    done <- r
  }
  ok <- Filter(Negate(is.null), rows[seq_len(done)])
  n_ok <- length(ok)
  rate <- function(name) {
    p <- mean(vapply(ok, function(x) x[[name]], numeric(1)))
    list(value = p, mcse = sqrt(p * (1 - p) / n_ok))
  }
  if (!n_ok) return(list(available = FALSE, reason = if (is.null(interrupted)) "no_replicate_finished" else interrupted, replicatesPlanned = replicates))
  list(available = TRUE, replicates = n_ok, replicatesPlanned = replicates, failedReplicates = done - n_ok, stopped = interrupted,
       alpha = alpha, nominal = alpha,
       realPermuted = rate("real"), syntheticNaive = rate("naive"), syntheticCombined = rate("combined"),
       standardErrorRatio = mean(vapply(ok, function(x) x[["seRatio"]], numeric(1))),
       note = "Arm labels of the real table are permuted, the synthetic copies are made from the permuted table the way the job made them, and the analysis is run on them: how often its interval excludes no effect when there is none.")
}

# --- per-record privacy -------------------------------------------------------------------------

#' The posterior probability that a record was in the training table, from its distance to the closest synthetic record alone and the two
#' reference distributions (see the header). Vectorised over the distances of `x`.
.vcr_record_risk <- function(x, d_train, d_hold) {
  f_train <- (findInterval(x, sort(d_train)) + 1) / (length(d_train) + 1)
  f_hold <- (findInterval(x, sort(d_hold)) + 1) / (length(d_hold) + 1)
  f_train / (f_train + f_hold)
}

.vcr_count_cell <- function(count, min_cell) if (count >= 1L && count < min_cell) list(count = NULL, suppressed = TRUE) else list(count = as.integer(count), suppressed = FALSE)

#' Who is easiest to recognise: the per-record distance to the closest synthetic record, the share of records whose membership risk is
#' above stated bounds (and the same for the holdout, which chance alone gives), and the kind of person the at-risk group is.
#' Counts are suppressed by the platform's small-cell rule and no row is returned.
vcr_record_privacy <- function(train, holdout, m_train, m_hold, bound = 0.75, min_cell = vcr_limit("minCellSize", 10)) {
  d_tr <- m_train$dcr; d_ho <- m_hold$dcr
  r_tr <- .vcr_record_risk(d_tr, d_tr, d_ho); r_ho <- .vcr_record_risk(d_ho, d_tr, d_ho)
  bounds <- sort(unique(c(0.6, 0.75, 0.9, bound)))
  shares <- lapply(bounds, function(b) {
    n_tr <- sum(r_tr > b); n_ho <- sum(r_ho > b)
    c(list(bound = b, stated = isTRUE(all.equal(b, bound)), trainingShare = if (n_tr >= 1L && n_tr < min_cell) NULL else n_tr / length(r_tr),
           holdoutShare = if (n_ho >= 1L && n_ho < min_cell) NULL else n_ho / length(r_ho)),
      list(trainingRecords = .vcr_count_cell(n_tr, min_cell)))
  })
  q <- function(x) stats::setNames(as.list(stats::quantile(x, c(0.01, 0.05, 0.25, 0.5), names = FALSE)), c("p01", "p05", "p25", "p50"))
  n_exact <- sum(d_tr == 0)
  at_risk <- r_tr > bound
  group <- NULL
  if (sum(at_risk) >= min_cell) {
    vars <- names(train)[seq_len(min(ncol(train), 12L))]
    rows <- list()
    for (v in vars) {
      x <- train[[v]]
      lab <- if (.vcr_is_categorical(x)) as.character(x) else {
        cuts <- unique(stats::quantile(x, c(0, 1 / 3, 2 / 3, 1), na.rm = TRUE, names = FALSE))
        if (length(cuts) < 3L) next
        c("low third", "middle third", "high third")[cut(x, cuts, labels = FALSE, include.lowest = TRUE)]
      }
      lab[is.na(lab)] <- "(missing)"
      all_tab <- table(lab); risk_tab <- table(factor(lab[at_risk], levels = names(all_tab)))
      shown <- vcr_suppress_cells(risk_tab[risk_tab > 0], min_cell)
      if (is.null(shown$cells) || !length(shown$cells)) next
      for (cell in shown$cells) {
        if (!is.null(cell$merged)) next
        rows[[length(rows) + 1L]] <- list(variable = v, level = cell$level, atRisk = cell$n, all = as.numeric(all_tab[[cell$level]]),
                                          atRiskShare = cell$n / sum(at_risk), allShare = as.numeric(all_tab[[cell$level]]) / length(at_risk))
      }
    }
    group <- list(bound = bound, size = sum(at_risk), rows = rows)
  }
  list(available = TRUE, bound = bound, nTraining = length(d_tr), nHoldout = length(d_ho),
       distanceToClosest = list(training = q(d_tr), holdout = q(d_ho), exactCopies = .vcr_count_cell(n_exact, min_cell)),
       riskShares = shares, atRiskGroup = group,
       riskMean = list(training = mean(r_tr), holdout = mean(r_ho)),
       note = "Each record's risk is the probability, from its distance to the closest synthetic record alone, that it was in the training table; the holdout is what a non-member looks like. No record is shown.")
}

# --- attribute inference ------------------------------------------------------------------------

.vcr_wilson <- function(x, n, level = 0.95) {
  if (n < 1L) return(c(NA_real_, NA_real_))
  z <- stats::qnorm(1 - (1 - level) / 2); p <- x / n
  centre <- (p + z^2 / (2 * n)) / (1 + z^2 / n); half <- z * sqrt(p * (1 - p) / n + z^2 / (4 * n^2)) / (1 + z^2 / n)
  c(centre - half, centre + half)
}

#' The columns an attribute-inference attack tries to recover when none is named: up to five categorical or binary columns, else up to
#' three numeric ones (read in quartiles).
.vcr_default_secrets <- function(train, vars) {
  cat <- vars[vapply(vars, function(v) .vcr_is_categorical(train[[v]]), logical(1))]
  if (length(cat)) head(cat, 5L) else head(vars, 3L)
}

#' Attribute inference (anonymeter's inference evaluation, written here): an attacker who knows every column but one of a real person
#' finds the closest synthetic record on those columns and takes its value of the remaining one. The success on training records is held
#' against the success on holdout records, who are not in the data; the risk is (main - control) / (1 - control).
#' @return one row per secret column, with Wilson intervals on both rates
vcr_attribute_inference <- function(train, holdout, synth, vars, ranges, secrets = NULL, attacks = 500L) {
  secrets <- intersect(as.character(secrets %||% .vcr_default_secrets(train, vars)), vars)
  if (!length(secrets) || length(vars) < 2L) return(list(available = FALSE, reason = "no_secret_column"))
  pick <- function(d) if (nrow(d) > attacks) d[sample.int(nrow(d), attacks), , drop = FALSE] else d
  tg_main <- pick(train[vars]); tg_ctrl <- pick(holdout[vars])
  rows <- lapply(secrets, function(s) {
    numeric_secret <- !.vcr_is_categorical(train[[s]])
    bins <- if (numeric_secret) unique(stats::quantile(train[[s]], c(0, 0.25, 0.5, 0.75, 1), na.rm = TRUE, names = FALSE)) else NULL
    lab <- function(x) if (numeric_secret) as.character(cut(x, bins, labels = FALSE, include.lowest = TRUE)) else as.character(x)
    aux <- setdiff(vars, s)
    guess <- function(targets) {
      nn <- vcr_gower_nearest(targets[aux], synth[aux], ranges[intersect(names(ranges), aux)])
      lab(synth[[s]][nn$nearestIndex])
    }
    hit <- function(targets) { g <- guess(targets); t <- lab(targets[[s]]); ok <- !is.na(t); c(sum(ok & g == t, na.rm = TRUE), sum(ok)) }
    a <- hit(tg_main); b <- hit(tg_ctrl)
    pm <- a[1] / a[2]; pc <- b[1] / b[2]
    wm <- .vcr_wilson(a[1], a[2]); wc <- .vcr_wilson(b[1], b[2])
    risk <- if (pc < 1) (pm - pc) / (1 - pc) else 0
    lo <- if (wc[2] < 1) (wm[1] - wc[2]) / (1 - wc[2]) else 0
    hi <- if (wc[1] < 1) (wm[2] - wc[1]) / (1 - wc[1]) else 0
    # the most a stranger could guess without any data: always the most common value of the training table
    base <- max(table(lab(train[[s]]))) / sum(!is.na(lab(train[[s]])))
    list(column = s, kind = if (numeric_secret) "numeric (quartiles)" else "categorical", attacksMain = a[2], attacksControl = b[2],
         successMain = pm, successControl = pc, successByMostCommon = base, risk = risk, riskLow = lo, riskHigh = hi)
  })
  worst <- max(vapply(rows, function(r) max(0, r$riskLow), numeric(1)))
  list(available = TRUE, secrets = rows, worstRiskLowerLimit = worst, attacks = attacks,
       note = "Success of finding a real person's value of one column from the closest synthetic record on their other columns, against the same attack on people who were never in the data.")
}
