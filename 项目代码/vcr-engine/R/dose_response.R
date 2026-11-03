# ---------------------------------------------------------------------------
# dose_response.R — dose-response meta-analysis of published, grouped data (evidence.dose_response; algorithm round C6, 2026-11-03).
#
# The person's question is "from what dose does it begin to work, and does it level off?". A trial or cohort paper prints the effect of
# a few exposure levels against one reference level; the Greenland-Longnecker method (1992) rebuilds the covariance of those correlated
# contrasts from the counts, fits a dose-response model to each study (the first stage) and pools the coefficients (the second); the
# one-stage form fits all studies at once. `dosresmeta` (Crippa & Orsini 2016) is the implementation, and it is in the runtime library;
# this file prepares its data, names its terms, builds the spline and reads its answer.
#
# Hidden knowledge:
#
# - **The reference row of a study is the row that has no standard error.** A published table prints the reference level as 1.00 with no
#   interval, and dosresmeta wants that row first with a log ratio of 0. The scenario states the effect as 0 and leaves the standard error
#   out for that row; any other row without a standard error, or a study with two, is refused by its path. The rows are put in the order
#   the package needs (the reference first, then by dose) and the order the person typed them in changes nothing.
# - **The restricted cubic spline is written here, not borrowed.** The package that normally supplies it (`rms`) is not in the runtime library.
#   The basis is Harrell's (his `rcspline.eval` with the default normalization): the dose itself and k - 2 terms
#   [(x - t_j)+^3 - (x - t_{k-1})+^3 (t_k - t_j) / (t_k - t_{k-1}) + (x - t_k)+^3 (t_{k-1} - t_j) / (t_k - t_{k-1})] / (t_k - t_1)^2, linear
#   beyond the outer knots. dosresmeta subtracts each study's reference row from every column of the design (`center`), which is how a
#   transformed dose becomes a contrast. The numeric case holds the coefficients to the ones printed in the package's own article (Crippa &
#   Orsini 2016, section 4) for the same data and knots.
# - **Knots come from the pooled exposure distribution** (Orsini et al. 2012: percentiles of every row of every study), at percentiles the
#   scenario states (default 10, 50, 90) or at doses it states. A knot cannot be placed twice; fewer than three distinct doses cannot carry a
#   spline and the model is refused by name, with the linear model as the way on.
# - **A study that cannot carry the model is left out, and the result says which.** The two-stage method fits each study's coefficients by
#   itself, so a study needs at least as many non-reference rows as the model has coefficients; the one-stage method does not. The excluded
#   studies and why are in the result, the pooled numbers are those of the rest, and when none is left the job is refused.
# - **The predictions are the model's, read against a stated reference dose** (default: the smallest dose in the data, 0 for most exposures),
#   with the interval from the pooled coefficients' covariance. The "first dose at which the interval leaves 1" is read off a fine grid of
#   those same predictions and is a pointwise statement, not a threshold the data establish.
# - **A tests of non-linearity is a Wald test on the spline terms** of the pooled coefficients (the package's `waldtest` computes the
#   same quadratic form); the overall test is the same on all coefficients. Both are chi-squared on the pooled covariance.
# - **The package's own text never reaches the person.** An error inside dosresmeta or mixmeta becomes `dose_response_not_computable`; its
#   warnings (one-dimensional Nelder-Mead in the one-stage fit) are dropped, since the engine states the method it ran.
# ---------------------------------------------------------------------------

VCR_DR_TYPES <- c("cc", "ci", "ir")
VCR_DR_FIT_METHODS <- c("reml", "ml", "fixed")
VCR_DR_GRID <- 200L

#' Harrell's restricted cubic spline basis (normalized by (t_k - t_1)^2): the dose and k - 2 spline terms.
vcr_rcs_basis <- function(x, knots) {
  k <- length(knots)
  if (k < 3L) stop("vcr_rcs_basis: a restricted cubic spline needs at least three knots")
  pos <- function(u) pmax(u, 0)^3
  tk <- knots[k]; tk1 <- knots[k - 1L]; t1 <- knots[1L]
  cols <- lapply(seq_len(k - 2L), function(j) {
    (pos(x - knots[j]) - pos(x - tk1) * (tk - knots[j]) / (tk - tk1) + pos(x - tk) * (tk1 - knots[j]) / (tk - tk1)) / (tk - t1)^2
  })
  out <- cbind(dose = x, do.call(cbind, cols))
  colnames(out) <- c("dose", paste0("spline", seq_len(k - 2L)))
  out
}

#' The studies of the scenario as one data frame in the order dosresmeta wants, plus the names of what was left out and why.
.vcr_dr_frame <- function(sc) {
  studies <- sc$studies
  if (!is.list(studies) || !length(studies)) vcr_abort("scenario_field_missing", "scenario.studies", "A dose-response analysis needs studies.")
  frames <- list(); ids <- character(0)
  for (i in seq_along(studies)) {
    st <- studies[[i]]
    rows <- st$rows
    here <- sprintf("scenario.studies[%d]", i - 1L)
    id <- as.character(st$studyId %||% paste0("study", i))
    if (id %in% ids) vcr_abort("scenario_value_invalid", paste0(here, ".studyId"), "A study appears once.")
    ids <- c(ids, id)
    type <- as.character(st$type %||% "")
    if (!(type %in% VCR_DR_TYPES)) vcr_abort("scenario_value_invalid", paste0(here, ".type"), "A study is case-control (cc), cumulative incidence (ci) or incidence rate (ir).")
    n <- length(rows)
    if (n < 2L) vcr_abort("scenario_value_invalid", paste0(here, ".rows"), "A study needs a reference row and at least one other level.")
    df <- data.frame(
      id = rep(id, n), type = rep(type, n),
      dose = vapply(rows, function(r) vcr_scalar(r$dose, NA_real_), numeric(1)),
      logrr = vapply(rows, function(r) vcr_scalar(r$effect, NA_real_), numeric(1)),
      se = vapply(rows, function(r) vcr_scalar(r$se, NA_real_), numeric(1)),
      cases = vapply(rows, function(r) vcr_scalar(r$cases, NA_real_), numeric(1)),
      n = vapply(rows, function(r) vcr_scalar(r$n, NA_real_), numeric(1)),
      stringsAsFactors = FALSE)
    if (anyNA(df$dose) || anyNA(df$logrr)) vcr_abort("scenario_value_invalid", paste0(here, ".rows"), "Every level states its dose and its effect (the reference level states an effect of 0).")
    if (any(!is.na(df$se) & df$se <= 0)) vcr_abort("scenario_value_invalid", paste0(here, ".rows"), "A standard error is above 0.")
    is_ref <- is.na(df$se)
    if (sum(is_ref) != 1L) vcr_abort("scenario_value_invalid", paste0(here, ".rows"), "Exactly one level is the reference: it states an effect of 0 and no standard error.")
    if (abs(df$logrr[is_ref]) > 1e-12) vcr_abort("scenario_value_invalid", paste0(here, ".rows"), "The reference level's effect is 0.")
    if (anyDuplicated(df$dose)) vcr_abort("scenario_value_invalid", paste0(here, ".rows"), "Two levels of one study cannot share a dose.")
    ord <- c(which(is_ref), setdiff(order(df$dose), which(is_ref)))
    frames[[i]] <- df[ord, , drop = FALSE]
  }
  do.call(rbind, frames)
}

#' Pooled-coefficient predictions of the log ratio against a reference dose.
.vcr_dr_predict <- function(basis_fn, beta, V, doses, xref, z) {
  Xd <- basis_fn(doses) - matrix(basis_fn(xref), nrow = length(doses), ncol = length(beta), byrow = TRUE)
  est <- as.vector(Xd %*% beta)
  se <- sqrt(pmax(0, rowSums((Xd %*% V) * Xd)))
  data.frame(dose = doses, logRatio = est, se = se, lower = est - z * se, upper = est + z * se)
}

vcr_job_dose_response <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  if (!requireNamespace("dosresmeta", quietly = TRUE)) vcr_abort("dose_response_not_computable", "engine", "The dose-response method is not available in this engine.")
  assumed <- list()
  note <- function(key, value, basis) assumed[[length(assumed) + 1L]] <<- list(key = key, value = value, basis = basis)
  df <- .vcr_dr_frame(sc)
  level <- vcr_scalar(sc$level, 0.95)
  if (is.null(sc$level)) note("level", 0.95, "the usual level of a published interval")
  z <- stats::qnorm(1 - (1 - level) / 2)
  model <- sc$model %||% list(kind = "linear")
  kind <- as.character(model$kind %||% "linear")
  stage <- as.character(sc$stage %||% "two")
  if (is.null(sc$stage)) note("stage", "two", "the two-stage method of Greenland & Longnecker and Orsini et al., which the package documents first")
  fit_method <- as.character(sc$method %||% "reml")
  if (is.null(sc$method)) note("method", "reml", "restricted maximum likelihood for the between-study variance")

  # the knots, from the pooled exposure distribution
  knots <- NULL
  if (identical(kind, "spline")) {
    if (!is.null(model$knots)) {
      knots <- sort(vcr_num(model$knots))
    } else {
      pct <- if (is.null(model$knotPercentiles)) { note("model.knotPercentiles", list(0.1, 0.5, 0.9), "Orsini et al. (2012): three knots at the 10th, 50th and 90th percentiles of the pooled exposure distribution"); c(0.1, 0.5, 0.9) } else vcr_num(model$knotPercentiles)
      knots <- as.numeric(stats::quantile(df$dose, pct, type = 7, names = FALSE))
    }
    if (length(knots) < 3L || length(knots) > 5L || anyDuplicated(round(knots, 12))) {
      vcr_abort("scenario_value_invalid", "scenario.model", "A spline needs three to five different knots; with fewer distinct doses than that, use the linear model.")
    }
  }
  terms <- if (is.null(knots)) "dose" else c("dose", paste0("spline", seq_len(length(knots) - 2L)))
  p <- length(terms)
  basis_fn <- if (is.null(knots)) function(x) matrix(x, ncol = 1L) else function(x) vcr_rcs_basis(x, knots)

  # a study the model cannot carry (two-stage fits each study by itself)
  excluded <- list()
  if (identical(stage, "two")) {
    nonref <- tapply(seq_len(nrow(df)), df$id, function(ix) length(ix) - 1L)
    small <- names(nonref)[nonref < p]
    if (length(small)) {
      excluded <- lapply(small, function(id) list(studyId = id, reason = "too_few_levels", levels = as.integer(nonref[[id]]), needed = p))
      df <- df[!(df$id %in% small), , drop = FALSE]
    }
  }
  if (!nrow(df)) vcr_abort("scenario_value_invalid", "scenario.studies", "No study has enough levels for the model: use the linear model, or the one-stage method.")
  k <- length(unique(df$id))
  if (k == 1L && identical(stage, "two") && !identical(fit_method, "fixed")) { fit_method <- "fixed"; note("method", "fixed", "a single study has no between-study variance to estimate") }

  # which covariance can be built
  nr <- df[!is.na(df$se), , drop = FALSE]
  has_counts <- !anyNA(nr$cases) && !anyNA(nr$n) && all(nr$cases >= 0) && all(nr$n > 0)
  covariance <- as.character(sc$covariance %||% "gl")
  if (is.null(sc$covariance)) note("covariance", "gl", "Greenland & Longnecker's reconstruction of the covariance of the contrasts of one study from its counts")
  if (!identical(covariance, "indep") && !has_counts) {
    covariance <- "indep"
    note("covariance", "indep", "a level states no counts, so the contrasts of one study are treated as independent: their standard errors are then read as they are printed, and the pooled interval is not the one the counts would give")
  }

  spl <- basis_fn(df$dose)
  colnames(spl) <- terms
  d2 <- cbind(df[c("id", "type", "logrr", "se", "cases", "n")], as.data.frame(spl))
  d2$id <- factor(d2$id, levels = unique(d2$id))
  fml <- stats::as.formula(paste("logrr ~", paste(terms, collapse = " + ")))
  fit <- tryCatch(suppressWarnings(suppressMessages(
    dosresmeta::dosresmeta(formula = fml, id = id, type = type, se = se, cases = cases, n = n, data = d2,
                           covariance = covariance, method = fit_method, proc = if (identical(stage, "one")) "1stage" else "2stage"))),
    error = function(e) NULL)
  if (is.null(fit)) vcr_abort("dose_response_not_computable", "scenario", "The dose-response model could not be fitted to these studies: the levels may be too few or too collinear for it.")
  beta <- as.numeric(stats::coef(fit)); names(beta) <- terms
  V <- as.matrix(stats::vcov(fit)); dimnames(V) <- list(terms, terms)
  if (anyNA(beta) || anyNA(V)) vcr_abort("dose_response_not_computable", "scenario", "The dose-response model could not be fitted to these studies: the levels may be too few or too collinear for it.")
  se_b <- sqrt(diag(V))
  beta <- unname(beta); se_b <- unname(se_b)
  coef_rows <- lapply(seq_len(p), function(i) list(term = terms[i], estimate = beta[i], se = se_b[i], lower = beta[i] - z * se_b[i], upper = beta[i] + z * se_b[i],
                                                   p = 2 * stats::pnorm(-abs(beta[i] / se_b[i]))))

  # heterogeneity and the tests
  Psi <- tryCatch(as.matrix(fit$Psi), error = function(e) NULL)
  tau <- if (!is.null(Psi) && nrow(Psi) == p) sqrt(pmax(0, diag(Psi))) else rep(NA_real_, p)
  qt <- tryCatch(suppressWarnings(mixmeta::qtest(fit)), error = function(e) NULL)
  q_val <- if (!is.null(qt)) as.numeric(qt$Q[1]) else NA_real_
  q_df <- if (!is.null(qt)) as.numeric(qt$df[1]) else NA_real_
  q_p <- if (!is.null(qt)) as.numeric(qt$pvalue[1]) else NA_real_
  i2 <- if (is.finite(q_val) && is.finite(q_df) && q_df > 0 && q_val > 0) max(0, (q_val - q_df) / q_val) else NA_real_
  wald <- function(ix) { b <- beta[ix]; chi <- as.numeric(t(b) %*% solve(V[ix, ix, drop = FALSE]) %*% b); list(chi2 = chi, df = length(ix), p = stats::pchisq(chi, length(ix), lower.tail = FALSE)) }
  overall <- wald(seq_len(p))
  nonlin <- if (p > 1L) wald(2:p) else NULL

  # predictions against a reference dose
  dmin <- min(df$dose); dmax <- max(df$dose)
  xref <- vcr_scalar(sc$referenceDose, dmin)
  if (is.null(sc$referenceDose)) note("referenceDose", dmin, "the smallest dose in the data")
  at <- vcr_num(sc$predictAt)
  if (!length(at)) { at <- signif(seq(dmin, dmax, length.out = 6L), 4L); note("predictAt", as.list(at), "six doses from the smallest to the largest in the data") }
  pred <- .vcr_dr_predict(basis_fn, beta, V, at, xref, z)
  fine <- seq(dmin, dmax, length.out = VCR_DR_GRID)
  fp <- .vcr_dr_predict(basis_fn, beta, V, fine, xref, z)
  away <- which(fp$lower > 0 | fp$upper < 0)
  away <- away[fine[away] != xref]
  first_sig <- if (length(away)) fine[min(away)] else NA_real_

  step <- vcr_scalar(sc$perDose, 1)
  if (is.null(knots) && is.null(sc$perDose)) note("perDose", 1, "one unit of dose")
  measures <- list(vcr_measure("k", length(unique(df$id)), source = "aggregate"),
                   vcr_measure("p_dose_response", overall$p, source = "aggregate"))
  if (is.null(knots)) {
    measures <- c(measures, list(
      vcr_measure("log_ratio_per_dose", beta[1], source = "aggregate", interval = vcr_interval("confidence", beta[1] - z * se_b[1], beta[1] + z * se_b[1], level)),
      vcr_measure("ratio_per_dose_step", exp(beta[1] * step), source = "aggregate", interval = vcr_interval("confidence", exp((beta[1] - z * se_b[1]) * step), exp((beta[1] + z * se_b[1]) * step), level))))
    if (is.finite(tau[1])) measures <- c(measures, list(vcr_measure("tau", tau[1], source = "aggregate")))
  } else {
    measures <- c(measures, list(vcr_measure("p_nonlinearity", nonlin$p, source = "aggregate")))
  }
  if (is.finite(i2)) measures <- c(measures, list(vcr_measure("i_squared", i2, source = "aggregate")))

  list(status = "succeeded", measures = measures, counts = vcr_counts(realPatients = NULL, generatedRecords = 0),
       diagnostics = list(doseResponse = list(
         given = list(label = sc$label, doseUnit = sc$doseUnit, ratioKind = sc$ratioKind, studies = length(unique(df$id)), levels = nrow(df),
                      model = list(kind = kind, knots = knots, knotPercentiles = if (!is.null(knots) && !is.null(model$knotPercentiles)) vcr_num(model$knotPercentiles) else NULL),
                      stage = stage, method = fit_method, covariance = covariance, level = level, referenceDose = xref, doseRange = c(dmin, dmax),
                      perDose = if (is.null(knots)) step else NULL),
         coefficients = coef_rows, covarianceOfCoefficients = unname(V), terms = terms,
         heterogeneity = list(tau = as.list(stats::setNames(tau, terms)), Q = q_val, df = q_df, p = q_p, i2 = i2),
         tests = list(overall = overall, nonlinearity = nonlin),
         predictions = lapply(seq_len(nrow(pred)), function(i) list(dose = pred$dose[i], logRatio = pred$logRatio[i], ratio = exp(pred$logRatio[i]), lower = exp(pred$lower[i]), upper = exp(pred$upper[i]))),
         curve = lapply(unique(round(seq(1, length(fine), length.out = 41L))), function(i) list(dose = fine[i], ratio = exp(fp$logRatio[i]), lower = exp(fp$lower[i]), upper = exp(fp$upper[i]))),
         firstDoseAwayFromReference = first_sig, firstDoseBasis = "pointwise: the first dose on a grid of 200 at which the interval of the ratio no longer contains 1; not a threshold the data establish",
         excluded = excluded, assumed = assumed)))
}
