# ---------------------------------------------------------------------------
# tipping_point.R — tipping-point analysis for missing outcomes.
#
# Hidden knowledge:
#
# - **A tipping point is a place, not a verdict.** The question is "how wrong
#   about the missing outcomes would we have to be before the conclusion
#   changes", and the answer is a region of assumptions plus the nearest point of
#   it, reported with the whole grid beside it. It never becomes pass/fail: the
#   result says where the conclusion changes and leaves how plausible that place
#   is to the reader (and to the clinical reasons the outcomes are missing).
# - **Binary: exact, no simulation.** The number of the missing who responded is
#   an integer in each arm, so every scenario can be enumerated, and at each one
#   the analysis's OWN test is run: Fisher's exact test, the engine's pooled-
#   variance risk-difference test (the one its simulated trials use), or, for a
#   single arm, the exact binomial test of N31. The Fisher and binomial p-values
#   are computed from the hypergeometric and binomial mass functions with R's own
#   definition of a two-sided exact p-value (the sum of the probabilities no
#   larger than the observed one, within 1e-7) and are held to
#   `stats::fisher.test` and `stats::binom.test` cell by cell in N38.
# - **The reference scenario is how the primary analysis treated the missing.**
#   `non_responders` (every missing outcome counted as a failure, the corner
#   (0, 0) of the grid) or `complete_cases` (the missing are left out; the
#   reference cell is the one in which the missing respond at their own arm's
#   observed rate, rounded). The nearest tipping point is searched in the
#   direction that threatens the conclusion: against the treatment when the
#   primary is significant, in its favour when it is not (`direction` can say
#   otherwise), counting the patients whose assumed outcome differs from the
#   reference (an L1 distance); ties go to the cell that changes fewest
#   treatment-arm outcomes. The nearest cell in ANY direction is reported beside
#   it.
# - **Time to event: delta-adjusted hazard after censoring (Jackson et al. 2014).**
#   Someone censored before the horizon is not assumed to carry on as those who
#   stayed (independent censoring): after the censoring the hazard is multiplied
#   by delta (delta = 1 is the primary analysis). The unobserved remainder of
#   each such person is imputed from a Cox model with a (smoothed) Breslow baseline, refitted
#   on a stratified bootstrap of the observed data in every imputation (so the
#   imputation carries the model's own uncertainty), and each completed data set
#   is analysed by the same Cox model; the imputations are combined by Rubin's
#   rules. The uniforms of an imputation are the same at every delta, so the
#   curve of the combined statistic over delta is smooth and its crossing is
#   found by interpolation. The Monte-Carlo error of the tipping delta is a
#   delete-one jackknife over the imputations.
# - **The analysis window is [0, horizon].** Everyone is administratively
#   censored at the horizon (an event after it is a censoring at it), the primary
#   Cox model is fitted on that, and only people censored BEFORE it are imputed.
# - **The arms the delta applies to are imputed, at every delta, delta = 1
#   included; the other arm keeps its censoring as observed.** So delta = 1 is a
#   real check of the imputation (it must reproduce the primary analysis within
#   Monte-Carlo error, N38) and the limit below is exact.
# - **The worst case needs no imputation.** As delta grows without bound every
#   early-censored person of an arm whose hazard goes to infinity has an event at
#   the moment of censoring, and one whose hazard goes to zero (the other arm,
#   when delta is applied in opposite directions) never has one inside the
#   window; that deterministic analysis is reported beside the grid as the limit
#   no delta can pass.
# - **Cox here is the engine's own Newton on a binary covariate** (Breslow ties,
#   vectorised over the risk-set counts), held to `survival::coxph(ties =
#   "breslow")` in N38; `survival` is not used at run time.
# ---------------------------------------------------------------------------

VCR_TIPPING_MAX_CELLS <- 40000L
VCR_TIPPING_MIN_IMPUTATIONS <- 40L
VCR_TIPPING_DEFAULT_DELTAS <- c(1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 30, 50, 100)

# --- the binary analyses ---------------------------------------------------------

#' Fisher's exact p-value of one 2x2 table in R's own definition, for vectors of
#' responders (`r1`, `r0`) in arms of size `n1`, `n0`. `sided = 1` is the test of
#' a higher response rate in arm 1 (`alternative = "greater"`), `sided = 2` the
#' two-sided test.
.vcr_fisher_p <- function(r1, n1, r0, n0, sided = 1L) {
  N <- n1 + n0
  vapply(seq_along(r1), function(i) {
    R <- r1[i] + r0[i]
    if (sided == 1L) return(stats::phyper(r1[i] - 1, R, N - R, n1, lower.tail = FALSE))
    lo <- max(0, n1 - (N - R)); hi <- min(n1, R)
    d <- stats::dhyper(lo:hi, R, N - R, n1)
    sum(d[d <= stats::dhyper(r1[i], R, N - R, n1) * (1 + 1e-7)])
  }, numeric(1))
}

#' The engine's pooled-variance risk-difference test (`vcr_analyse_risk_difference`)
#' as a p-value, vectorised: z = (p1 - p0) / sqrt(pbar (1 - pbar) (1/n1 + 1/n0)).
.vcr_rd_p <- function(r1, n1, r0, n0, sided = 1L) {
  p1 <- r1 / n1; p0 <- r0 / n0; pbar <- (r1 + r0) / (n1 + n0)
  se0 <- sqrt(pbar * (1 - pbar) * (1 / n1 + 1 / n0))
  z <- ifelse(se0 > 0, (p1 - p0) / se0, 0)
  if (sided == 1L) stats::pnorm(z, lower.tail = FALSE) else 2 * stats::pnorm(-abs(z))
}

#' The exact binomial p-value of `r` responders in `n` against `p0`.
.vcr_binom_p <- function(r, n, p0, sided = 1L) {
  if (sided == 1L) return(stats::pbinom(r - 1, n, p0, lower.tail = FALSE))
  vapply(r, function(x) stats::binom.test(x, n, p0, alternative = "two.sided")$p.value, numeric(1))
}

#' The p-value and the conclusion ("the analysis finds in favour of the treatment
#' at alpha") of the scenario(s) given as vectors, for the analysis the scenario names.
.vcr_tp_analyse <- function(design, method, alpha, sided, null_rate, r1, n1, r0 = NULL, n0 = NULL) {
  if (identical(design, "single_arm")) {
    p <- .vcr_binom_p(r1, n1, null_rate, sided)
    return(list(p = p, favourable = r1 / n1 > null_rate, significant = p <= alpha & (sided == 1L | r1 / n1 > null_rate)))
  }
  p <- if (identical(method, "fisher_exact")) .vcr_fisher_p(r1, n1, r0, n0, sided) else .vcr_rd_p(r1, n1, r0, n0, sided)
  fav <- r1 / n1 > r0 / n0
  list(p = p, favourable = fav, significant = p <= alpha & (sided == 1L | fav))
}

#' The arms of a binary tipping job, from counts or from a 0/1 column with NA for a
#' missing outcome. Refuses by name an arm that cannot be: more responders than the
#' observed, more missing than people.
.vcr_tp_arms <- function(job, sc, design) {
  as_arm <- function(a, field) {
    n <- vcr_scalar(a$n, NA_real_); r <- vcr_scalar(a$responders, NA_real_); m <- vcr_scalar(a$missing, NA_real_)
    if (anyNA(c(n, r, m)) || any(c(n, r, m) != round(c(n, r, m))) || n < 1 || r < 0 || m < 0) vcr_abort("scenario_value_invalid", field, "An arm is whole numbers: everyone in it, the observed responders and the missing outcomes.")
    if (m > n || r > n - m) vcr_abort("scenario_value_invalid", field, "The observed responders cannot exceed the people whose outcome was observed (n minus the missing).")
    c(n = n, r = r, m = m)
  }
  if (!is.null(sc$counts)) {
    arms <- list(treatment = as_arm(sc$counts$treatment, "scenario.counts.treatment"))
    if (identical(design, "two_arm")) arms$control <- as_arm(sc$counts$control, "scenario.counts.control")
    return(list(arms = arms, source = "calculated", counts = vcr_counts(), cohort = NULL))
  }
  tabs <- vcr_job_tables(job)
  subj <- .vcr_main_table(tabs)
  vcr_require_individual(subj, "A tipping-point analysis", method = "comparator.tipping_point")
  cohort <- vcr_apply_downstream_cohort(subj, sc$cohortRules)
  subj <- cohort$data
  oc <- .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn")
  if (!(oc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "The outcome column is not in the table.")
  y <- suppressWarnings(as.numeric(subj[[oc]]))
  if (any(!is.na(y) & !(y %in% c(0, 1)))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "A binary outcome is 0/1, and a missing outcome is empty.")
  count <- function(idx) c(n = sum(idx), r = sum(y[idx] == 1, na.rm = TRUE), m = sum(is.na(y[idx])))
  if (identical(design, "single_arm")) {
    arms <- list(treatment = count(rep(TRUE, nrow(subj))))
  } else {
    tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
    if (!(tc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is not in the table.")
    arm <- subj[[tc]]
    if (anyNA(arm) || !all(arm %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 or 0, complete.")
    arms <- list(treatment = count(arm == 1), control = count(arm == 0))
  }
  if (any(vapply(arms, function(a) a[["n"]] < 1, logical(1)))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "Both arms need at least one person.")
  list(arms = arms, source = .vcr_source_label(subj, "observed"), counts = vcr_table_counts(subj), cohort = cohort$info)
}

.vcr_tp_binary <- function(job, sc, output_dir) {
  design <- as.character(sc$design$kind)
  an <- sc$analysis
  method <- as.character(an$method)
  alpha <- vcr_scalar(an$alpha, 0.025); sided <- vcr_check_sided(an$sided)
  null_rate <- vcr_scalar(an$nullRate, NULL)
  handling <- as.character(sc$missingHandling %||% "non_responders")
  inp <- .vcr_tp_arms(job, sc, design)
  A <- inp$arms; trt <- A$treatment; ctl <- A$control
  two <- identical(design, "two_arm")
  m1 <- trt[["m"]]; m0 <- if (two) ctl[["m"]] else 0
  cells <- (m1 + 1) * (m0 + 1)
  if (cells > VCR_TIPPING_MAX_CELLS) {
    vcr_abort("scenario_value_invalid", "scenario.counts", sprintf("Enumerating the missing outcomes would take %s scenarios; this engine enumerates at most %s (a limit on its work, not on the question).",
                                                                 format(cells, big.mark = ","), format(VCR_TIPPING_MAX_CELLS, big.mark = ",")))
  }
  # the primary analysis, as it was done
  obs_n <- function(a) a[["n"]] - a[["m"]]
  prim <- if (identical(handling, "non_responders")) {
    if (two) .vcr_tp_analyse(design, method, alpha, sided, null_rate, trt[["r"]], trt[["n"]], ctl[["r"]], ctl[["n"]])
    else .vcr_tp_analyse(design, method, alpha, sided, null_rate, trt[["r"]], trt[["n"]])
  } else {
    if (obs_n(trt) < 1 || (two && obs_n(ctl) < 1)) vcr_abort("scenario_value_invalid", "scenario.counts", "Complete cases need at least one observed outcome in each arm.")
    if (two) .vcr_tp_analyse(design, method, alpha, sided, null_rate, trt[["r"]], obs_n(trt), ctl[["r"]], obs_n(ctl))
    else .vcr_tp_analyse(design, method, alpha, sided, null_rate, trt[["r"]], obs_n(trt))
  }
  prim_sig <- isTRUE(prim$significant)
  # the reference cell: where the primary analysis put the missing
  rate_of <- function(a) if (obs_n(a) > 0) a[["r"]] / obs_n(a) else 0
  ref1 <- if (identical(handling, "non_responders")) 0 else min(m1, max(0, round(m1 * rate_of(trt))))
  ref0 <- if (!two) 0 else if (identical(handling, "non_responders")) 0 else min(m0, max(0, round(m0 * rate_of(ctl))))
  # the grid: k1 of the treatment arm's missing and k0 of the control arm's missing responded
  k1 <- 0:m1; k0 <- 0:m0
  g <- expand.grid(k1 = k1, k0 = k0, KEEP.OUT.ATTRS = FALSE)
  res <- if (two) .vcr_tp_analyse(design, method, alpha, sided, null_rate, trt[["r"]] + g$k1, trt[["n"]], ctl[["r"]] + g$k0, ctl[["n"]])
         else .vcr_tp_analyse(design, method, alpha, sided, null_rate, trt[["r"]] + g$k1, trt[["n"]])
  g$p <- res$p; g$significant <- res$significant
  g$rateTreatment <- (trt[["r"]] + g$k1) / trt[["n"]]
  g$rateControl <- if (two) (ctl[["r"]] + g$k0) / ctl[["n"]] else NA_real_
  changed <- g$significant != prim_sig
  at_ref <- g$k1 == ref1 & g$k0 == ref0
  ref_sig <- g$significant[at_ref]
  threat <- as.character(sc$direction %||% if (prim_sig) "against_treatment" else "in_favour")
  # the quadrant that threatens the conclusion: against the treatment = fewer responders among the treatment arm's missing
  # and more among the control arm's, in favour = the opposite; the axes of the reference are in it
  in_quadrant <- if (identical(threat, "against_treatment")) g$k1 <= ref1 & g$k0 >= ref0 else g$k1 >= ref1 & g$k0 <= ref0
  dist <- abs(g$k1 - ref1) + abs(g$k0 - ref0)
  nearest <- function(mask) {
    idx <- which(mask & changed)
    if (!length(idx)) return(NULL)
    ord <- idx[order(dist[idx], abs(g$k1[idx] - ref1), g$k1[idx], g$k0[idx])]
    g[ord[1], , drop = FALSE]
  }
  near_dir <- nearest(in_quadrant); near_any <- nearest(rep(TRUE, nrow(g)))
  # the worst case in the threatening direction
  worst <- if (identical(threat, "against_treatment")) list(k1 = 0, k0 = m0) else list(k1 = m1, k0 = 0)
  worst_row <- g[g$k1 == worst$k1 & g$k0 == worst$k0, , drop = FALSE]
  # the boundary: for each treatment-arm count, the smallest control-arm count at which the conclusion differs from the primary's
  boundary <- lapply(k1, function(a) {
    rows <- g$k1 == a & changed
    list(k1 = a, k0 = if (any(rows)) min(g$k0[rows]) else NULL)
  })
  unit_label <- function(row) if (is.null(row)) NULL else list(k1 = row$k1, k0 = row$k0, distance = dist[which(g$k1 == row$k1 & g$k0 == row$k0)],
                                                              rateTreatmentMissing = if (m1 > 0) row$k1 / m1 else NULL,
                                                              rateControlMissing = if (two && m0 > 0) row$k0 / m0 else NULL, p = row$p, significant = row$significant)
  measures <- list(vcr_measure("primary_p_value", prim$p, source = "calculated"),
                   vcr_measure("grid_cells", nrow(g), source = "calculated"),
                   vcr_measure("cells_changing_conclusion", sum(changed), source = "calculated"),
                   vcr_measure("share_changing_conclusion", mean(changed), source = "calculated"),
                   vcr_measure("worst_case_p_value", worst_row$p, source = "calculated"))
  if (!is.null(near_dir)) {
    measures <- c(measures, list(
      vcr_measure("tipping_distance", dist[which(g$k1 == near_dir$k1 & g$k0 == near_dir$k0)], source = "calculated"),
      vcr_measure("tipping_treatment_responders", near_dir$k1, source = "calculated"),
      vcr_measure("tipping_control_responders", near_dir$k0, source = "calculated")))
    if (m1 > 0) measures <- c(measures, list(vcr_measure("tipping_treatment_rate", near_dir$k1 / m1, source = "calculated")))
    if (two && m0 > 0) measures <- c(measures, list(vcr_measure("tipping_control_rate", near_dir$k0 / m0, source = "calculated")))
  }
  tab <- g[, c("k1", "k0", "rateTreatment", "rateControl", "p", "significant")]
  tab$changesConclusion <- changed
  list(status = "succeeded", conclusion = "estimable", measures = measures,
       counts = if (is.null(inp$counts$realPatients)) vcr_counts(realPatients = NULL, events = NULL) else inp$counts,
       diagnostics = list(
         endpoint = "binary", design = design, test = method, alpha = alpha, sided = sided, nullRate = null_rate, missingHandling = handling,
         arms = list(treatment = as.list(trt), control = if (two) as.list(ctl) else NULL),
         primary = list(p = prim$p, significant = prim_sig, favourable = isTRUE(prim$favourable)),
         reference = list(k1 = ref1, k0 = ref0, significant = ref_sig, matchesPrimary = identical(ref_sig, prim_sig)),
         direction = threat, directionWasStated = !is.null(sc$direction),
         nearestTippingPoint = unit_label(near_dir), nearestInAnyDirection = unit_label(near_any),
         worstCase = list(k1 = worst$k1, k0 = worst$k0, p = worst_row$p, significant = worst_row$significant, changesConclusion = worst_row$significant != prim_sig),
         conclusionRobustInDirection = is.null(near_dir),
         boundary = boundary, gridCells = nrow(g),
         enumeration = "exact: every number of responders among the missing in each arm, the analysis's own test at each",
         reading = "The tipping point is where the conclusion changes, not a verdict. Judge it against what is known about why the outcomes are missing, in each arm.",
         cohort = inp$cohort),
       tables = .vcr_tables_of(list(vcr_write_table(tab, "tipping-grid", output_dir))))
}

# --- time to event ----------------------------------------------------------------

#' Cox log hazard ratio of one binary covariate by Newton on the Breslow partial
#' likelihood, vectorised over the risk-set counts. Returns `NULL` when an arm has
#' no event (the hazard ratio is 0 or infinite) or the likelihood does not have a
#' maximum (|beta| beyond 30).
vcr_cox_binary <- function(time, status, arm, maxit = 50L, tol = 1e-10) {
  n <- length(time)
  o <- order(time); t <- time[o]; s <- status[o]; z <- arm[o]
  first <- c(TRUE, t[-1L] != t[-n])
  g <- cumsum(first); ng <- g[n]
  at <- (n:1L)[first]
  at1 <- rev(cumsum(rev(z)))[first]
  d <- tabulate(g[s == 1L], ng); d1 <- tabulate(g[s == 1L & z == 1], ng)
  keep <- d > 0
  d <- d[keep]; d1 <- d1[keep]; a1 <- at1[keep]; a0 <- (at - at1)[keep]
  if (!length(d) || sum(d1) == 0 || sum(d1) == sum(d)) return(NULL)
  beta <- 0
  for (it in seq_len(maxit)) {
    e <- exp(beta)
    p <- a1 * e / (a0 + a1 * e)
    U <- sum(d1 - d * p); I <- sum(d * p * (1 - p))
    if (!is.finite(I) || I <= 0) return(NULL)
    step <- U / I
    beta <- beta + step
    if (!is.finite(beta) || abs(beta) > 30) return(NULL)
    if (abs(step) < tol) break
  }
  e <- exp(beta); p <- a1 * e / (a0 + a1 * e)
  I <- sum(d * p * (1 - p))
  list(beta = beta, variance = 1 / I, events = sum(d), converged = abs(step) < tol)
}

#' The cumulative baseline hazard an imputation draws from: Breslow's step
#' estimate at the event times of a Cox fit on one binary covariate (baseline of
#' arm 0), joined linearly through (0, 0) so the hazard is constant between two
#' event times, and continued after the last event time at the average hazard to
#' date. A step baseline would put every imputed event ON an observed event time
#' (artificial ties) and would let nobody fail after the last one; the
#' piecewise-linear form is continuous, so a delta that grows without bound puts
#' the event just after the censoring, which is what makes the limit exact.
.vcr_baseline <- function(time, status, arm, beta) {
  b <- .vcr_breslow(time, status, arm, beta)
  K <- length(b$time)
  list(time = c(0, b$time), H = c(0, b$H0), K = K, last = b$time[K], H_last = b$H0[K], tail = b$H0[K] / b$time[K])
}

#' H0 at times `t` (piecewise linear, then the tail hazard).
.vcr_baseline_H <- function(bl, t) {
  inside <- t <= bl$last
  out <- numeric(length(t))
  if (any(inside)) out[inside] <- stats::approx(bl$time, bl$H, xout = t[inside], rule = 2)$y
  if (any(!inside)) out[!inside] <- bl$H_last + bl$tail * (t[!inside] - bl$last)
  out
}

#' The time at which H0 reaches `target` (the inverse of the above).
.vcr_baseline_inverse <- function(bl, target) {
  inside <- target <= bl$H_last
  out <- numeric(length(target))
  if (any(inside)) {
    tg <- target[inside]
    j <- pmin(findInterval(tg, bl$H, left.open = TRUE), bl$K)
    j <- pmax(j, 1L)
    slope <- (bl$H[j + 1L] - bl$H[j]) / (bl$time[j + 1L] - bl$time[j])
    out[inside] <- bl$time[j] + (tg - bl$H[j]) / slope
  }
  if (any(!inside)) out[!inside] <- bl$last + (target[!inside] - bl$H_last) / bl$tail
  out
}

#' The Breslow cumulative baseline hazard of a Cox fit on one binary covariate:
#' the event times and H0 at each, with the baseline taken for arm 0.
.vcr_breslow <- function(time, status, arm, beta) {
  o <- order(time); t <- time[o]; s <- status[o]; z <- arm[o]
  n <- length(t)
  first <- c(TRUE, t[-1L] != t[-n])
  g <- cumsum(first); ng <- g[n]
  w <- exp(beta * z)
  risk <- rev(cumsum(rev(w)))[first]
  d <- tabulate(g[s == 1L], ng)
  keep <- d > 0
  list(time = t[first][keep], H0 = cumsum(d[keep] / risk[keep]))
}

#' Rubin's rules for one coefficient over the imputations that produced one: the
#' combined estimate, its total variance, the Monte-Carlo standard error of the
#' estimate (sqrt(B / M)) and the degrees of freedom.
.vcr_rubin <- function(beta, variance) {
  ok <- is.finite(beta) & is.finite(variance)
  b <- beta[ok]; v <- variance[ok]; M <- length(b)
  if (M < 2L) return(NULL)
  qbar <- mean(b); ubar <- mean(v); B <- stats::var(b)
  total <- ubar + (1 + 1 / M) * B
  r <- (1 + 1 / M) * B / ubar
  nu <- if (B > 0) (M - 1) * (1 + 1 / r)^2 else Inf
  list(estimate = qbar, variance = total, between = B, within = ubar, mcse = sqrt(B / M), df = nu, M = M)
}

.vcr_tte_class <- function(z, crit) if (is.finite(z) && z < -crit) "favours_treatment" else "not_favouring_treatment"

.vcr_tp_tte <- function(job, sc, output_dir, cancel_file) {
  tabs <- vcr_job_tables(job)
  subj <- .vcr_main_table(tabs)
  vcr_require_individual(subj, "A tipping-point analysis", method = "comparator.tipping_point")
  cohort <- vcr_apply_downstream_cohort(subj, sc$cohortRules)
  subj <- cohort$data
  tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
  if (!(tc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is not in the table.")
  arm_raw <- subj[[tc]]
  if (anyNA(arm_raw) || !all(arm_raw %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 or 0, complete.")
  arm <- as.integer(arm_raw)
  o <- vcr_outcome_frame(sc, tabs, subj, "time_to_event")
  if (anyNA(o$time) || anyNA(o$status)) vcr_abort("input_shape_invalid", "inputs", "Time and status are complete.")
  horizon <- vcr_scalar(sc$horizon, NULL)
  alpha <- vcr_scalar(sc$analysis$alpha, 0.025); sided <- vcr_check_sided(sc$analysis$sided)
  M <- as.integer(vcr_scalar(job$replicates, 200L))
  if (M < VCR_TIPPING_MIN_IMPUTATIONS) vcr_abort("replicates_invalid", "replicates", sprintf("A time-to-event tipping-point analysis combines imputations by Rubin's rules and needs at least %d of them.", VCR_TIPPING_MIN_IMPUTATIONS))
  deltas <- vcr_num(sc$deltas %||% VCR_TIPPING_DEFAULT_DELTAS)
  deltas <- sort(unique(c(1, deltas)))
  applies <- as.character(sc$deltaApplies %||% "treatment")
  # the analysis window: censored at the horizon
  after <- o$time > horizon
  time <- ifelse(after, horizon, o$time); status <- ifelse(after, 0L, o$status)
  early <- status == 0L & time < horizon
  counts <- vcr_table_counts(subj, events = sum(status))
  counts$events <- sum(status)
  not_est <- function(detail) list(status = "not_estimable", notEstimableRule = "primary_analysis_not_estimable", measures = list(), counts = counts,
                                   diagnostics = list(detail = detail, horizon = horizon, cohort = cohort$info))
  prim <- vcr_cox_binary(time, status, arm)
  if (is.null(prim)) return(not_est("An arm has no event inside the horizon, or the Cox model has no maximum: there is no primary hazard ratio to relax."))
  crit <- stats::qnorm(1 - alpha / sided)
  prim_z <- prim$beta / sqrt(prim$variance)
  prim_class <- .vcr_tte_class(prim_z, crit)
  threat <- as.character(sc$direction %||% if (identical(prim_class, "favours_treatment")) "against_treatment" else "in_favour")
  # the multiplier on each arm's post-censoring hazard at a delta
  mult <- function(d) {
    big <- if (identical(threat, "against_treatment")) d else 1 / d
    c(control = if (identical(applies, "both_opposite")) 1 / big else 1, treatment = big)
  }
  # the arms the delta applies to are imputed; the other arm keeps its censoring as observed
  imputed_arm <- if (identical(applies, "both_opposite")) c(TRUE, TRUE) else c(FALSE, TRUE)   # control, treatment
  idx_e <- which(early & imputed_arm[arm + 1L]); n_e <- length(idx_e)
  G <- length(deltas)
  # --- the deterministic worst case: the delta no grid reaches ---
  worst <- {
    ts <- time; ss <- status
    # where each imputed arm's post-censoring hazard goes: against the treatment, the treatment's to infinity (its early-censored
    # fail at once) and, when applied in opposite directions, the control's to zero (they never fail inside the window); in
    # favour of the treatment the other way round
    to_inf <- if (identical(threat, "against_treatment")) 1L else 0L
    fail <- early & imputed_arm[arm + 1L] & arm == to_inf
    stay <- early & imputed_arm[arm + 1L] & arm != to_inf
    ss[fail] <- 1L
    ts[stay] <- horizon
    fit <- vcr_cox_binary(ts, ss, arm)
    if (is.null(fit)) NULL else list(beta = fit$beta, se = sqrt(fit$variance), z = fit$beta / sqrt(fit$variance), events = fit$events)
  }
  # --- the imputations ---
  bank <- vcr_stream_bank(job$seed)
  one <- function(j) {
    bi <- unlist(lapply(split(seq_along(time), arm), function(g) g[sample.int(length(g), length(g), replace = TRUE)]), use.names = FALSE)
    u <- stats::runif(n_e)
    out <- matrix(NA_real_, G, 2L)
    fit <- tryCatch(vcr_cox_binary(time[bi], status[bi], arm[bi]), error = function(e) NULL)
    if (is.null(fit) || n_e == 0L) {
      if (n_e == 0L) { f0 <- vcr_cox_binary(time, status, arm); if (!is.null(f0)) out[, 1] <- f0$beta; if (!is.null(f0)) out[, 2] <- f0$variance }
      return(as.numeric(out))
    }
    bl <- .vcr_baseline(time[bi], status[bi], arm[bi], fit$beta)
    e <- -log(u)
    H_c <- .vcr_baseline_H(bl, time[idx_e])
    z_e <- arm[idx_e]
    for (gi in seq_len(G)) {
      m <- mult(deltas[gi])
      rate <- exp(fit$beta * z_e) * ifelse(z_e == 1L, m[["treatment"]], m[["control"]])
      tt <- .vcr_baseline_inverse(bl, H_c + e / rate)
      ts <- time; ss <- status
      ev <- tt <= horizon
      ts[idx_e] <- ifelse(ev, tt, horizon); ss[idx_e] <- as.integer(ev)
      cx <- vcr_cox_binary(ts, ss, arm)
      if (!is.null(cx)) { out[gi, 1] <- cx$beta; out[gi, 2] <- cx$variance }
    }
    as.numeric(out)
  }
  done <- 0L; rows <- list(); interrupted <- NULL
  while (done < M) {
    reason <- vcr_interrupt()
    if (!is.null(reason)) { interrupted <- reason; break }
    take <- min(25L, M - done)
    streams <- bank$take(take)
    rows <- c(rows, vcr_map_streams(streams, one, cores = vcr_cores(job$cores), indices = done + seq_len(take)))
    done <- done + take
  }
  if (!is.null(interrupted)) {
    if (identical(interrupted, "canceled")) {
      return(list(status = "canceled", measures = list(), counts = counts, diagnostics = list(imputationsCompleted = done, imputationsRequested = M)))
    }
    return(list(status = "failed", measures = list(), counts = counts,
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the imputations; no tipping point is reported.")),
                diagnostics = list(imputationsCompleted = done, imputationsRequested = M)))
  }
  arr <- array(unlist(rows), dim = c(G, 2L, length(rows)))
  beta <- arr[, 1, , drop = TRUE]; vari <- arr[, 2, , drop = TRUE]
  if (G == 1L) { beta <- matrix(beta, 1L); vari <- matrix(vari, 1L) }
  ok_imp <- colSums(is.finite(beta)) == G
  if (sum(ok_imp) < 20L) return(not_est("The imputation model could not be fitted on enough resamples of the observed data."))
  beta <- beta[, ok_imp, drop = FALSE]; vari <- vari[, ok_imp, drop = FALSE]
  Mok <- ncol(beta)
  combine <- function(cols) {
    lapply(seq_len(G), function(gi) .vcr_rubin(beta[gi, cols], vari[gi, cols]))
  }
  comb <- combine(seq_len(Mok))
  zs <- vapply(comb, function(r) r$estimate / sqrt(r$variance), numeric(1))
  crits <- vapply(comb, function(r) stats::qt(1 - alpha / sided, r$df), numeric(1))
  classes <- vapply(seq_len(G), function(gi) .vcr_tte_class(zs[gi], crits[gi]), character(1))
  # the tipping delta: the first grid delta at which the conclusion differs, and the crossing of its boundary between it and the one before
  crossing <- function(z, crit, cls) {
    flipped <- which(cls != prim_class)
    if (!length(flipped)) return(NA_real_)
    b <- flipped[1]
    if (b == 1L) return(deltas[1])
    za <- z[b - 1L] + crit[b - 1L]; zb <- z[b] + crit[b]    # the margin to the boundary z = -crit, at each end
    t <- if (is.finite(za) && is.finite(zb) && za != zb) za / (za - zb) else 1
    exp(log(deltas[b - 1L]) + min(max(t, 0), 1) * (log(deltas[b]) - log(deltas[b - 1L])))
  }
  tip <- crossing(zs, crits, classes)
  first_grid <- if (any(classes != prim_class)) deltas[which(classes != prim_class)[1]] else NA_real_
  # the jackknife Monte-Carlo standard error of the tipping delta: leave one imputation out
  tip_mcse <- NA_real_; jack_found <- NA_real_
  if (is.finite(tip) && Mok >= 20L) {
    loo <- vapply(seq_len(Mok), function(j) {
      cc <- combine(setdiff(seq_len(Mok), j))
      z <- vapply(cc, function(r) r$estimate / sqrt(r$variance), numeric(1)); cr <- vapply(cc, function(r) stats::qt(1 - alpha / sided, r$df), numeric(1))
      crossing(z, cr, vapply(seq_len(G), function(gi) .vcr_tte_class(z[gi], cr[gi]), character(1)))
    }, numeric(1))
    jack_found <- mean(is.finite(loo))
    if (jack_found >= 0.95) { l <- log(loo[is.finite(loo)]); n_l <- length(l); tip_mcse <- exp(log(tip)) * sqrt((n_l - 1) / n_l * sum((l - mean(l))^2)) }
  }
  at1 <- comb[[1]]
  deltas_tab <- do.call(rbind, lapply(seq_len(G), function(gi) {
    r <- comb[[gi]]; se <- sqrt(r$variance); qc <- crits[gi]
    data.frame(delta = deltas[gi], multiplierTreatment = mult(deltas[gi])[["treatment"]], multiplierControl = mult(deltas[gi])[["control"]],
               logHazardRatio = r$estimate, se = se, hazardRatio = exp(r$estimate), low = exp(r$estimate - qc * se), high = exp(r$estimate + qc * se),
               z = zs[gi], df = if (is.finite(r$df)) r$df else NA_real_, critical = qc, mcse = r$mcse, conclusion = classes[gi],
               changesConclusion = classes[gi] != prim_class, stringsAsFactors = FALSE)
  }))
  unit <- as.character(sc$timeUnit %||% "months")
  sd_ci <- stats::qnorm(0.975)
  measures <- list(
    vcr_measure("primary_log_hazard_ratio", prim$beta, source = "calculated", interval = vcr_interval("confidence", prim$beta - sd_ci * sqrt(prim$variance), prim$beta + sd_ci * sqrt(prim$variance))),
    vcr_measure("primary_hazard_ratio", exp(prim$beta), source = "calculated", interval = vcr_interval("confidence", exp(prim$beta - sd_ci * sqrt(prim$variance)), exp(prim$beta + sd_ci * sqrt(prim$variance)))),
    vcr_measure("delta_one_log_hazard_ratio", at1$estimate, simulated = TRUE, mcse = at1$mcse, source = "calculated"),
    vcr_measure("imputed_early_censored_people", n_e, source = .vcr_source_label(subj, "observed")))
  if (!is.null(worst)) measures <- c(measures, list(vcr_measure("worst_case_log_hazard_ratio", worst$beta, source = "calculated")))
  if (is.finite(tip) && is.finite(tip_mcse)) measures <- c(measures, list(vcr_measure("tipping_delta", tip, simulated = TRUE, mcse = tip_mcse, source = "calculated")))
  failed_share <- 1 - Mok / length(rows)
  limited <- failed_share > 0.2 || (is.finite(tip) && !is.finite(tip_mcse)) || n_e == 0L
  list(status = "succeeded", conclusion = if (limited) "limited" else "estimable", measures = measures,
       counts = counts,
       diagnostics = list(
         endpoint = "time_to_event", horizon = horizon, timeUnit = unit, alpha = alpha, sided = sided, direction = threat, directionWasStated = !is.null(sc$direction),
         deltaApplies = applies, deltas = deltas,
         primary = list(logHazardRatio = prim$beta, se = sqrt(prim$variance), z = prim_z, conclusion = prim_class, events = prim$events),
         earlyCensored = list(people = n_e, treatment = sum(early & arm == 1L), control = sum(early & arm == 0L), share = n_e / length(time)),
         imputations = list(requested = M, used = Mok, failureShare = failed_share,
                            model = "Cox with a piecewise-linear Breslow baseline, refitted on a stratified bootstrap of the observed data in every imputation"),
         tippingDelta = if (is.finite(tip)) list(delta = tip, mcse = tip_mcse, jackknifeShareWithCrossing = jack_found, firstGridDeltaThatChangesTheConclusion = first_grid) else NULL,
         conclusionRobustOverGrid = !is.finite(tip), gridMaximum = max(deltas),
         worstCase = if (is.null(worst)) NULL else c(worst, list(conclusion = .vcr_tte_class(worst$z, crit), changesConclusion = !identical(.vcr_tte_class(worst$z, crit), prim_class))),
         deltaTable = lapply(seq_len(nrow(deltas_tab)), function(i) as.list(deltas_tab[i, ])),
         reading = "Someone censored before the horizon is assumed to carry on at delta times the hazard of those who stayed. delta = 1 is the primary analysis. The tipping delta is where the conclusion changes, not a verdict: judge it against why people left.",
         cohort = cohort$info),
       tables = .vcr_tables_of(list(vcr_write_table(deltas_tab, "tipping-deltas", output_dir))))
}

vcr_job_tipping_point <- function(job, output_dir = NULL, cancel_file = NULL, ...) {
  sc <- job$scenario
  type <- as.character(sc$endpoint$type %||% "")
  if (identical(type, "binary")) return(.vcr_tp_binary(job, sc, output_dir))
  if (identical(type, "time_to_event")) return(.vcr_tp_tte(job, sc, output_dir, cancel_file))
  vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "A tipping-point analysis is for a binary or a time-to-event endpoint.")
}
