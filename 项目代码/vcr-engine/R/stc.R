# ---------------------------------------------------------------------------
# stc.R — simulated treatment comparison in its parametric G-computation form (comparator.stc; algorithm round C9, 2026-11-03).
#
# One side has the patients (IPD) and the other has a publication (aggregate data, AgD): how would the IPD arm have done in the AgD
# trial's population, and what is the contrast against the AgD arm? The conventional STC regresses the outcome on covariates centred at
# the AgD means and reads the arm coefficient; on a log or logit link that coefficient is the effect in a person with the average
# profile (a conditional effect), while the AgD trial reports the effect in its population (a marginal one) and the two are not the
# same number (EU HTA guideline, 6.1: "leading to bias for both estimands"). The G-computation form fits the same outcome model and then
# averages its predictions over the AgD trial's covariate distribution, so the contrast is marginal in the AgD population (Remiro-Azocar
# et al., Res Synth Methods 2022).
#
# Hidden knowledge:
#
# - **The AgD covariate distribution is simulated, and its correlation is the IPD's unless the person states one.** A publication
#   gives margins (means and SDs, or proportions); the engine's Gaussian copula (`vcr_population_literature`) builds a covariate sample from
#   them with the IPD's Spearman correlation turned into the copula's latent one (`vcr_copula_correlation`), which is what Remiro-Azocar
#   recommends and is said in the result (`correlation.source`). The sample is drawn once per job, and its size is the job's `size`; the
#   standardisation therefore has a Monte-Carlo error of its own, carried by the estimate as a simulated measure.
# - **The bootstrap resamples the IPD and refits the outcome model each time**, standardising over the same covariate sample; the AgD
#   trial's own standard error is added in quadrature (as in the MAIC), so the interval holds the sampling error of both trials and
#   not the uncertainty of the AgD margins, which a publication does not give.
# - **Anchored and unanchored are different claims.** Anchored: the IPD trial has two arms (A against the common comparator C), the AgD
#   trial reports B against C on the link scale; the indirect contrast A against B is the marginal A against C effect in the AgD population
#   minus the AgD trial's, and C cancels. Unanchored: only the IPD active arm is modelled and its predicted outcome in the AgD population
#   is set against the AgD arm's outcome; that assumes every prognostic factor and effect modifier is adjusted for, which nobody can
#   check, so the result is a benchmark (it carries the same premise as the unanchored MAIC) and never more than `limited`.
# - **The conditional (conventional) STC is reported beside the marginal one** so that a reader can see how far they are apart; they
#   are the same number on the identity link with no modifier interaction, and that is the case the case N72 checks the two against each
#   other and against the MAIC.
# - **The outcome model is main effects, plus the effect modifiers the person declared interacting with the arm.** Nothing is selected by
#   the data. A covariate that is not in the model cannot adjust anything, and an effect modifier that is not declared is the commonest
#   way this comparison is wrong; the declared list is echoed, as the MAIC's unadjusted modifiers are.
# ---------------------------------------------------------------------------

#' The design matrix of the outcome model: an intercept, the covariates, and for an anchored comparison the arm and the effect modifiers interacting
#' with it (`arm` is a vector, or a single value for a population given the arm).
.vcr_stc_design <- function(X, arm, modifiers, anchored) {
  cols <- cbind(1, X)
  if (anchored) {
    a <- rep_len(arm, nrow(X))
    cols <- cbind(cols, a, if (length(modifiers)) a * X[, modifiers, drop = FALSE])
  }
  cols
}

#' The G-computation estimate: fit the outcome model on the IPD rows and average its predictions over `pop` (a matrix of the AgD trial's
#' covariates, columns named as `X`) under each arm. Returns the marginal means, the contrast on the link scale, the standardisation's Monte-Carlo
#' error and the coefficients; a `NULL` estimate and a reason when the model cannot be fitted (collinear covariates, a mean outside the link's domain).
vcr_stc_gcomp <- function(y, arm, X, modifiers, pop, family, link, anchored) {
  X <- as.matrix(X); pop <- as.matrix(pop)
  fit <- tryCatch(suppressWarnings(stats::glm.fit(.vcr_stc_design(X, arm, modifiers, anchored), y, family = family)), error = function(e) NULL)
  if (is.null(fit) || anyNA(fit$coefficients) || !isTRUE(fit$converged)) return(list(estimate = NULL, reason = "the outcome model cannot be fitted on these rows"))
  predict_at <- function(a) as.vector(family$linkinv(.vcr_stc_design(pop, a, modifiers, anchored) %*% fit$coefficients))
  mu1 <- predict_at(1); mu0 <- if (anchored) predict_at(0) else NULL
  m1 <- mean(mu1); m0 <- if (anchored) mean(mu0) else NA_real_
  lk <- .vcr_maic_link(link); g <- lk$g; gp <- lk$gp
  ok1 <- .vcr_maic_in_domain(link, m1); ok0 <- !anchored || .vcr_maic_in_domain(link, m0)
  if (!ok1 || !ok0) return(list(estimate = NULL, reason = "a marginal mean is outside the link's domain"))
  est <- if (anchored) g(m1) - g(m0) else g(m1)
  mc <- stats::sd(if (anchored) gp(m1) * (mu1 - m1) - gp(m0) * (mu0 - m0) else gp(m1) * (mu1 - m1)) / sqrt(nrow(pop))
  list(estimate = est, mcActive = m1, mcComparator = m0, mcse = mc, coefficients = fit$coefficients)
}

vcr_job_stc <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  endpoint <- as.character(sc$endpoint$type %||% "")
  if (!(endpoint %in% c("continuous", "binary"))) vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "A simulated treatment comparison compares continuous and binary outcomes.")
  binary <- identical(endpoint, "binary")
  subj <- .vcr_main_table(vcr_job_tables(job))
  vcr_require_individual(subj, "A simulated treatment comparison", method = "comparator.stc")
  anchored <- isTRUE(as.logical(sc$anchored))
  covs <- vcr_chr(sc$covariates)
  mods <- vcr_chr(sc$effectModifiers)
  if (length(setdiff(mods, covs))) vcr_abort("scenario_value_invalid", "scenario.effectModifiers", "An effect modifier is one of the covariates.")
  if (!all(covs %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.covariates", "The covariates are columns of the table.")
  # the unanchored comparison is of the IPD trial's active arm: a table that holds both names its arm column and arm 1 is the active arm
  arm_selection <- NULL
  if (!anchored && !is.null(sc$treatmentColumn)) {
    tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
    a <- if (tc %in% names(subj)) subj[[tc]] else NULL
    if (!is.null(a) && !anyNA(a) && all(a %in% c(0, 1)) && any(a == 1)) {
      arm_selection <- list(column = tc, activeArm = 1L, rowsUsed = sum(a == 1), rowsOtherArm = sum(a == 0))
      subj <- subj[a == 1, , drop = FALSE]
    }
  }
  X <- as.matrix(subj[, covs, drop = FALSE])
  if (!is.numeric(X)) vcr_abort("input_shape_invalid", "scenario.covariates", "Covariates are numeric (code categories as indicators).")
  miss <- which(colSums(is.na(X)) > 0L)
  if (length(miss)) vcr_abort("missing_covariate", "scenario.covariates", sprintf("Covariate '%s' has missing values.", covs[miss[1]]))
  y <- .vcr_maic_outcome(subj, sc)
  if (binary && !all(y %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.outcomeColumn", "A binary outcome is 0/1.")
  arm <- NULL
  if (anchored) {
    tc <- .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn")
    if (!(tc %in% names(subj))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is not in the table.")
    arm <- subj[[tc]]
    if (anyNA(arm) || !all(arm %in% c(0, 1))) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "The treatment column is 1 or 0, complete.")
    arm <- as.integer(arm)
    if (sum(arm == 1L) < 2L || sum(arm == 0L) < 2L) vcr_abort("input_shape_invalid", "scenario.treatmentColumn", "Both arms need at least two people.")
  }
  link <- as.character(sc$link %||% (if (binary) "logit" else "identity"))
  if (!(link %in% c("identity", "log", "logit"))) vcr_abort("scenario_value_invalid", "scenario.link", "The link is identity, log or logit.")
  if (identical(link, "logit") && !binary) vcr_abort("scenario_value_invalid", "scenario.link", "The logit link is for a binary outcome.")
  family <- if (binary) stats::binomial() else stats::gaussian()
  agd_se <- vcr_scalar(sc$aggregateSe, NULL)
  agd_est <- if (anchored) vcr_scalar(sc$aggregateEstimate, NULL) else vcr_scalar(sc$aggregateOutcome, NULL)
  if (is.null(agd_se) || is.null(agd_est)) vcr_abort("scenario_field_missing", if (anchored) "scenario.aggregateEstimate" else "scenario.aggregateOutcome", "State the aggregate trial's result and its standard error.")
  if (!anchored && !.vcr_maic_in_domain(link, agd_est)) {
    vcr_abort("scenario_value_invalid", "scenario.aggregateOutcome",
              if (identical(link, "logit")) "On the logit link the aggregate outcome is a proportion strictly between 0 and 1, on its own scale (not log-odds)."
              else if (identical(link, "log")) "On the log link the aggregate outcome is positive, on its own scale (not its log)." else "The aggregate outcome is a finite number.")
  }

  # the AgD trial's covariate sample: its published margins, the IPD's correlation unless one is stated
  table <- sc$aggregateCovariates
  have <- vapply(table, function(r) as.character(r$variable %||% ""), character(1))
  if (length(setdiff(covs, have))) vcr_abort("scenario_value_invalid", "scenario.aggregateCovariates", sprintf("Every covariate has an aggregate summary; '%s' has none.", setdiff(covs, have)[1]))
  table <- table[match(covs, have)]
  stated_cor <- sc[["correlation"]]
  latent <- if (is.null(stated_cor)) {
    rho <- suppressWarnings(stats::cor(X, method = "spearman"))
    if (anyNA(rho)) rho <- diag(length(covs))   # a constant column has no rank correlation: independence for it
    vcr_copula_correlation(rho, "spearman")$correlation
  } else vcr_correlation_matrix(stated_cor, length(covs))
  size <- as.integer(vcr_scalar(sc$size, 10000L))
  set.seed(job$seed, kind = VCR_RNG_KIND)
  agd <- vcr_population_literature(table, size, latent, if (is.null(stated_cor)) "ipd" else "assumed", 1L, seed = job$seed)
  pop <- as.matrix(agd$data[, covs, drop = FALSE]); storage.mode(pop) <- "double"

  used <- vcr_used_sources(list(list(df = subj, columns = c(covs, .vcr_column_name(sc$outcomeColumn, "y", "scenario.outcomeColumn"),
    if (anchored) .vcr_column_name(sc$treatmentColumn, "arm", "scenario.treatmentColumn") else arm_selection$column))))
  est_src <- vcr_estimate_source(used$source)
  counts <- vcr_counts(realPatients = nrow(subj), generatedRecords = size)

  core <- vcr_stc_gcomp(y, arm, X, mods, pop, family, link, anchored)
  if (is.null(core$estimate)) {
    return(list(status = "not_estimable", notEstimableRule = "nuisance_model_not_estimable", measures = list(), counts = counts,
                diagnostics = list(detail = core$reason, valueSourcesUsed = vcr_value_sources_used(used))))
  }
  B <- vcr_bootstrap_replicates(vcr_scalar(job$replicates, NULL))
  boot <- vcr_bootstrap_pipeline(nrow(subj), function(idx) {
    r <- vcr_stc_gcomp(y[idx], arm[idx], X[idx, , drop = FALSE], mods, pop, family, link, anchored)
    if (is.null(r$estimate)) NA_real_ else r$estimate
  }, replicates = B, seed = job$seed, strata = arm, cores = vcr_cores(job$cores))
  if (identical(boot$interrupted, "canceled")) {
    return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = nrow(subj)), diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  if (!is.null(boot$interrupted) || boot$replicates < B) {
    return(list(status = "failed", measures = list(), counts = counts,
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the bootstrap; no interval is reported.")),
                diagnostics = list(bootstrapCompleted = boot$replicates, bootstrapRequested = B)))
  }
  lk <- .vcr_maic_link(link)
  agd_link <- if (anchored) agd_est else lk$g(agd_est)
  agd_link_se <- if (anchored) agd_se else agd_se * abs(lk$gp(agd_est))
  # the AgD trial's contrast is already on the link scale when anchored; unanchored, the delta method carried its standard error there
  est <- core$estimate - agd_link
  se <- sqrt(boot$se^2 + agd_link_se^2)
  z <- stats::qnorm(0.975)
  interval <- c(est - z * se, est + z * se)

  # the conventional STC beside it: the arm coefficient with the covariates centred at the aggregate means (anchored only: it needs the arm)
  conditional <- NULL
  if (anchored) {
    targets <- vapply(seq_along(covs), function(j) { r <- table[[j]]; vcr_scalar(r$mean %||% r[["proportion"]], NA_real_) }, numeric(1)); names(targets) <- covs
    conditional <- tryCatch(vcr_stc(y, arm, X, targets, family), error = function(e) NULL)
  }
  # how far the AgD sample is from what the IPD covered, per covariate: a prediction outside the observed range is an extrapolation
  rng <- apply(X, 2, range)
  outside <- vapply(seq_along(covs), function(j) mean(pop[, covs[j]] < rng[1, j] | pop[, covs[j]] > rng[2, j]), numeric(1)); names(outside) <- covs
  limited_by <- c(if (boot$failureShare > 0.01) "bootstrap_failure_share")
  measures <- c(
    list(vcr_measure("indirect_estimate", est, simulated = TRUE, mcse = core$mcse, interval = vcr_interval("confidence", interval[1], interval[2]), source = est_src),
         vcr_measure(if (anchored) "marginal_contrast_ipd" else "marginal_level_ipd", core$estimate, simulated = TRUE, mcse = core$mcse, source = est_src)),
    if (!is.null(conditional)) list(vcr_measure("conditional_contrast_ipd", conditional$estimate, source = est_src)))
  list(status = "succeeded",
       conclusion = if (!anchored || length(limited_by)) "limited" else "estimable",
       measures = measures, counts = counts,
       diagnostics = list(
         method = "g_computation", anchored = anchored, targetPopulation = "aggregate_data_trial", link = link, endpoint = endpoint,
         valueSourcesUsed = vcr_value_sources_used(used),
         outcomeModel = list(family = if (binary) "binomial" else "gaussian", covariates = as.list(covs), effectModifiers = as.list(mods),
                             formula = paste("y ~", paste(c(covs, if (anchored) "arm", if (anchored && length(mods)) paste0("arm:", mods)), collapse = " + "))),
         marginal = list(active = core$mcActive, comparator = if (anchored) core$mcComparator else NULL, scale = link,
                         standardisation = list(size = size, mcse = core$mcse)),
         aggregate = list(estimate = agd_est, standardError = agd_se, linkScaleEstimate = agd_link, linkScaleStandardError = agd_link_se,
                          kind = if (anchored) "contrast of the AgD trial's active arm against the common comparator" else "outcome of the AgD trial's arm"),
         correlation = list(source = if (is.null(stated_cor)) "ipd_spearman" else "stated", copulaRepaired = agd$copulaRepaired %||% FALSE),
         conditionalEffect = if (!is.null(conditional)) list(estimate = conditional$estimate, se = conditional$se, scale = conditional$effectScale,
                                                              note = "the arm coefficient with the covariates centred at the aggregate means: conditional, and the same number as the marginal contrast only on the identity link without a modifier") else NULL,
         extrapolation = list(shareOutsideIpdRange = as.list(outside)),
         varianceBasis = "bootstrap_outcome_model_refitted",
         se = se, bootstrapReplicates = boot$replicates, bootstrapFailureShare = boot$failureShare,
         conclusionCeiling = if (!anchored) "limited" else NULL,
         treatmentArm = arm_selection,
         limitedBy = as.list(limited_by),
         unadjustedEffectModifiers = sc$unadjustedEffectModifiers %||% list()))
}
