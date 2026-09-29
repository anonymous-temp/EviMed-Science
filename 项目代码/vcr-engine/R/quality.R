# ---------------------------------------------------------------------------
# quality.R — the fixed report suite for a synthetic population (plan 5.1;
# attachment C2 section 2.2).
#
# Hidden knowledge:
#
# - **This is a report, not a gate.** Every band here is a colour on a page
#   and a notice in the result; none of it withholds a delivery (platform
#   principle 4). The one exception is not a band at all: declared hard
#   constraints must be violated zero times, and that is an invariant.
# - **Only S_pMSE's bands come from the literature** (synthpop's authors:
#   below 10 acceptable, below 3 better). Every other threshold in
#   `vcr_quality_bands()` is this product's default colouring, to be revisited
#   once about twenty real datasets have gone through. Saying so in the code
#   is the difference between a convention and a fabricated citation.
# - **Distance and membership metrics are meaningless without a holdout.**
#   A DCR of 0.03 is neither good nor bad; what matters is whether it differs
#   from the DCR of records that were never in training. So the suite refuses
#   to compute the disclosure axis at all when no holdout was reserved, rather
#   than reporting an absolute number that reads like a verdict.
# - **"Synthetic" is never printed next to "anonymous".** The disclosure axis
#   reports what was measured and what it came out at; it never concludes
#   safety. Stadler et al. 2022 and Ganev & De Cristofaro 2025 are the reason:
#   similarity checks are passable by attacks that still reconstruct training
#   rows.
# - **Gower distances are standardized on the *training* range**, and the same
#   ranges are used for the holdout baseline. Standardizing each set on its own
#   range is the quiet way to make the baseline incomparable.
# - **The baseline must be the same size as what it is compared with.** "Is the
#   synthetic record closer to a training record than to a holdout record?" has
#   the answer "yes, more often" for a generator that memorized nothing at all,
#   as soon as the training set is larger than the holdout: a bigger reference
#   set is simply nearer. With a perfect generator, 400 training and 100 holdout
#   records gave a nearest-neighbour share of 0.63, red on the product's own
#   band (CE-30). The distance-to-record metrics therefore compare equal-sized
#   reference sets (the larger one subsampled), and the full-size figures are
#   reported beside them.
# - **Criteria, constraints and declared analyses are data, never code**
#   (rules.R). A criterion is `{ name, rule }`; an analysis is `{ name, kind,
#   ... }` naming columns; neither is parsed as an expression.
# ---------------------------------------------------------------------------

#' The product's default report bands. Only S_pMSE's come from the literature.
vcr_quality_bands <- function() list(
  ksD = list(green = 0.05, yellow = 0.10, source = "product_default"),
  tvd = list(green = 0.05, yellow = 0.10, source = "product_default"),
  missingRateDifference = list(green = 0.02, yellow = 0.05, source = "product_default"),
  pairwiseDifference = list(green = 0.05, yellow = 0.10, source = "product_default"),
  sPmse = list(green = 3, yellow = 10, source = "synthpop_authors"),
  propensityAuc = list(green = 0.60, yellow = 0.70, source = "product_default"),
  confidenceIntervalOverlap = list(green = 0.8, yellow = 0.5, higherIsBetter = TRUE, source = "product_default"),
  tstrRatio = list(green = 0.95, yellow = 0.90, higherIsBetter = TRUE, source = "product_default"),
  jointPassRateRelativeDifference = list(green = 0.10, yellow = 0.20, source = "product_default"),
  replicationRate = list(green = 1.0, yellow = 2.0, relativeToHoldout = TRUE, source = "product_default"),
  nearestNeighbourInTrainShare = list(green = 0.55, yellow = 0.60, source = "product_default"),
  membershipAuc = list(green = 0.55, yellow = 0.60, source = "product_default"),
  inferenceRisk = list(green = 0.05, yellow = 0.10, source = "product_default")
)

vcr_band <- function(value, band) {
  if (!is.finite(value)) return("unknown")
  if (isTRUE(band$higherIsBetter)) {
    if (value >= band$green) return("green")
    if (value >= band$yellow) return("yellow")
    return("red")
  }
  if (value <= band$green) return("green")
  if (value <= band$yellow) return("yellow")
  "red"
}

.vcr_is_categorical <- function(x, max_levels = 10L) {
  is.factor(x) || is.character(x) || is.logical(x) ||
    (is.numeric(x) && length(unique(stats::na.omit(x))) <= max_levels)
}

#' Per-variable fidelity: KS D for continuous, total variation distance for
#' categorical, and the absolute difference in missingness rate.
vcr_fidelity_univariate <- function(real, synth) {
  vars <- intersect(names(real), names(synth))
  do.call(rbind, lapply(vars, function(v) {
    a <- real[[v]]; b <- synth[[v]]
    miss <- abs(mean(is.na(a)) - mean(is.na(b)))
    a2 <- a[!is.na(a)]; b2 <- b[!is.na(b)]
    if (.vcr_is_categorical(a)) {
      lv <- union(unique(as.character(a2)), unique(as.character(b2)))
      pa <- table(factor(as.character(a2), lv)) / max(length(a2), 1)
      pb <- table(factor(as.character(b2), lv)) / max(length(b2), 1)
      data.frame(variable = v, kind = "categorical", statistic = "tvd",
                 value = as.numeric(0.5 * sum(abs(pa - pb))),
                 missingRateDifference = miss, stringsAsFactors = FALSE)
    } else {
      d <- if (length(a2) && length(b2)) suppressWarnings(stats::ks.test(a2, b2)$statistic) else NA_real_
      data.frame(variable = v, kind = "continuous", statistic = "ks_d",
                 value = as.numeric(d), missingRateDifference = miss, stringsAsFactors = FALSE)
    }
  }))
}

#' Pairwise fidelity: |delta Spearman| for continuous pairs, |delta Cramer's V|
#' when either side of the pair is categorical.
vcr_fidelity_pairwise <- function(real, synth) {
  vars <- intersect(names(real), names(synth))
  out <- list()
  for (i in seq_along(vars)) for (j in seq_len(i - 1L)) {
    a <- vars[i]; b <- vars[j]
    ca <- .vcr_is_categorical(real[[a]]); cb <- .vcr_is_categorical(real[[b]])
    if (!ca && !cb) {
      ra <- suppressWarnings(stats::cor(real[[a]], real[[b]], method = "spearman", use = "complete.obs"))
      rb <- suppressWarnings(stats::cor(synth[[a]], synth[[b]], method = "spearman", use = "complete.obs"))
      out[[length(out) + 1L]] <- data.frame(a = a, b = b, statistic = "spearman",
                                            value = abs(ra - rb), stringsAsFactors = FALSE)
    } else {
      va <- .vcr_cramers_v(real[[a]], real[[b]]); vb <- .vcr_cramers_v(synth[[a]], synth[[b]])
      out[[length(out) + 1L]] <- data.frame(a = a, b = b, statistic = "cramers_v",
                                            value = abs(va - vb), stringsAsFactors = FALSE)
    }
  }
  if (!length(out)) return(data.frame(a = character(0), b = character(0), statistic = character(0), value = numeric(0)))
  do.call(rbind, out)
}

.vcr_cramers_v <- function(x, y) {
  tab <- table(as.character(x), as.character(y))
  if (any(dim(tab) < 2)) return(0)
  chi <- suppressWarnings(stats::chisq.test(tab, correct = FALSE)$statistic)
  n <- sum(tab)
  sqrt(as.numeric(chi) / (n * (min(dim(tab)) - 1)))
}

#' Global distinguishability by the propensity method (Woo et al.; Snoke et
#' al. for the standardization).
#'
#' pMSE = mean((p_hat - c)^2) with c the synthetic share. Under the null the
#' logistic model's expected pMSE is (k - 1)(1 - c)^2 c / N with k the number
#' of fitted parameters, so S_pMSE = pMSE / E[pMSE] is comparable across
#' datasets. `synthpop::utility.gen` computes the same quantity and is the
#' cross-check.
vcr_utility_propensity <- function(real, synth, formula = NULL, folds = 5L) {
  vars <- intersect(names(real), names(synth))
  combined <- rbind(
    cbind(real[, vars, drop = FALSE], ..syn.. = 0L),
    cbind(synth[, vars, drop = FALSE], ..syn.. = 1L)
  )
  combined <- combined[stats::complete.cases(combined), , drop = FALSE]
  N <- nrow(combined)
  cshare <- mean(combined$..syn..)
  form <- formula %||% vcr_model_formula("..syn..", vars, pairwise = TRUE)
  fit <- suppressWarnings(stats::glm(form, data = combined, family = stats::binomial()))
  p <- as.vector(stats::fitted(fit))
  pmse <- mean((p - cshare)^2)
  k <- length(stats::coef(fit)[!is.na(stats::coef(fit))])
  expected <- (k - 1) * (1 - cshare)^2 * cshare / N
  # Cross-validated AUC: an in-sample AUC on a saturated model is optimistic
  # by construction, so the reported AUC is always out of fold.
  auc <- .vcr_cv_auc(form, combined, folds)
  list(pMSE = pmse, expectedPMSE = expected, sPMSE = pmse / expected,
       propensityAuc = auc, parameters = k, n = N, syntheticShare = cshare)
}

.vcr_cv_auc <- function(form, data, folds) {
  n <- nrow(data)
  fold <- rep(seq_len(folds), length.out = n)
  # Deterministic assignment: the caller controls randomness through the job
  # seed, and a quality report that moves between reruns is not a report.
  fold <- fold[order(seq_len(n))]
  pred <- numeric(n)
  for (f in seq_len(folds)) {
    tr <- fold != f; te <- !tr
    fit <- suppressWarnings(stats::glm(form, data = data[tr, , drop = FALSE], family = stats::binomial()))
    pred[te] <- suppressWarnings(as.vector(stats::predict(fit, newdata = data[te, , drop = FALSE], type = "response")))
  }
  .vcr_auc(pred, data$..syn..)
}

#' AUC by the Mann-Whitney identity, ties counted as half.
.vcr_auc <- function(score, label) {
  pos <- score[label == 1L]; neg <- score[label == 0L]
  if (!length(pos) || !length(neg)) return(NA_real_)
  r <- rank(c(pos, neg))
  (sum(r[seq_along(pos)]) - length(pos) * (length(pos) + 1) / 2) / (length(pos) * length(neg))
}

#' Confidence-interval overlap (Karr et al.): the share of each interval
#' covered by the other, averaged. 1 means identical, 0 means disjoint.
vcr_ci_overlap <- function(ci_real, ci_synth) {
  lo <- max(ci_real[1], ci_synth[1]); hi <- min(ci_real[2], ci_synth[2])
  if (hi <= lo) return(0)
  0.5 * ((hi - lo) / (ci_real[2] - ci_real[1]) + (hi - lo) / (ci_synth[2] - ci_synth[1]))
}

#' Gower distance from every row of `x` to the nearest row of `reference`,
#' standardized on `ranges` (always the training set's ranges).
vcr_gower_nearest <- function(x, reference, ranges = NULL, k = 2L) {
  vars <- intersect(names(x), names(reference))
  num <- vapply(reference[vars], is.numeric, logical(1))
  rngs <- ranges %||% lapply(reference[vars][num], function(v) diff(range(v, na.rm = TRUE)))
  nx <- nrow(x); nr <- nrow(reference)
  d1 <- numeric(nx); d2 <- numeric(nx); idx <- integer(nx)
  for (i in seq_len(nx)) {
    acc <- numeric(nr)
    for (v in vars) {
      a <- x[[v]][i]; b <- reference[[v]]
      if (is.numeric(b)) {
        r <- rngs[[v]]; r <- if (is.null(r) || !is.finite(r) || r == 0) 1 else r
        acc <- acc + abs(a - b) / r
      } else {
        acc <- acc + as.numeric(as.character(a) != as.character(b))
      }
    }
    acc <- acc / length(vars)
    o <- order(acc)
    d1[i] <- acc[o[1]]; d2[i] <- if (nr >= k) acc[o[k]] else NA_real_
    idx[i] <- o[1]
  }
  list(dcr = d1, secondDistance = d2, nndr = ifelse(d2 > 0, d1 / d2, 0), nearestIndex = idx,
       ranges = rngs)
}

#' The disclosure axis. Requires a holdout; without one it returns the reason
#' rather than a number (attachment C2: no baseline, no meaning).
#'
#' Reference sets are size-matched (see the header note): the larger of the
#' training and holdout sets is subsampled to the size of the smaller for the
#' replication, distance and nearest-neighbour comparisons. The subsample is
#' drawn from the caller's RNG stream, so a seeded job repeats it.
vcr_disclosure_report <- function(train, synth, holdout = NULL, subsamples = 3L) {
  if (is.null(holdout) || !nrow(holdout)) {
    return(list(available = FALSE,
                reason = "no_holdout_reserved",
                detail = "Replication, distance and membership metrics need records that were never used to fit the generator."))
  }
  vars <- Reduce(intersect, list(names(train), names(synth), names(holdout)))
  key <- function(df) do.call(paste, c(lapply(df[vars], as.character), sep = "\u001f"))
  m <- min(nrow(train), nrow(holdout))
  ksyn <- key(synth)
  ranges <- lapply(train[vars][vapply(train[vars], is.numeric, logical(1))],
                   function(v) diff(range(v, na.rm = TRUE)))
  # The size-matched comparison, averaged over a few independent subsamples of
  # the larger set (one subsample is noisy; three are enough to steady it).
  one <- function() {
    tr_ref <- if (nrow(train) > m) train[sample.int(nrow(train), m), , drop = FALSE] else train
    ho_ref <- if (nrow(holdout) > m) holdout[sample.int(nrow(holdout), m), , drop = FALSE] else holdout
    to_train <- vcr_gower_nearest(synth[vars], tr_ref[vars], ranges)
    to_hold <- vcr_gower_nearest(synth[vars], ho_ref[vars], ranges)
    c(replTrain = mean(ksyn %in% key(tr_ref)), replHold = mean(ksyn %in% key(ho_ref)),
      nn = mean(to_train$dcr < to_hold$dcr) + 0.5 * mean(to_train$dcr == to_hold$dcr),
      dcrTrain = as.numeric(stats::quantile(to_train$dcr, 0.05, names = FALSE)),
      dcrHold = as.numeric(stats::quantile(to_hold$dcr, 0.05, names = FALSE)),
      nndrTrain = as.numeric(stats::quantile(to_train$nndr, 0.05, names = FALSE)),
      nndrHold = as.numeric(stats::quantile(to_hold$nndr, 0.05, names = FALSE)))
  }
  k <- if (nrow(train) == nrow(holdout)) 1L else as.integer(subsamples)
  agg <- colMeans(do.call(rbind, lapply(seq_len(k), function(i) one())))
  repl_train <- agg[["replTrain"]]; repl_hold <- agg[["replHold"]]
  repl_train_full <- mean(ksyn %in% key(train))

  # Distance-based membership inference: a training record should sit closer
  # to the synthetic data than a holdout record does, if the generator
  # memorized. Score = -DCR, so higher means "more likely a member". AUC does
  # not depend on the two sets' sizes, so the full sets are used.
  m_train <- vcr_gower_nearest(train[vars], synth[vars], ranges)
  m_hold <- vcr_gower_nearest(holdout[vars], synth[vars], ranges)
  score <- c(-m_train$dcr, -m_hold$dcr)
  label <- c(rep(1L, nrow(train)), rep(0L, nrow(holdout)))
  auc <- .vcr_auc(score, label)
  thresh <- stats::quantile(score[label == 0L], 0.99, names = FALSE)
  tpr_at_1 <- mean(score[label == 1L] > thresh)

  list(available = TRUE,
       sizeCorrected = nrow(train) != nrow(holdout), referenceSize = m, referenceSubsamples = k,
       exactReplicationRate = repl_train,
       exactReplicationRateHoldout = repl_hold,
       exactReplicationRateFullTraining = repl_train_full,
       replicationRatio = if (repl_hold > 0) repl_train / repl_hold else if (repl_train > 0) Inf else 1,
       dcrPercentile5 = agg[["dcrTrain"]],
       dcrPercentile5Holdout = agg[["dcrHold"]],
       nndrPercentile5 = agg[["nndrTrain"]],
       nndrPercentile5Holdout = agg[["nndrHold"]],
       nearestNeighbourInTrainShare = agg[["nn"]],
       membershipAuc = auc, membershipTprAtFpr1 = tpr_at_1,
       note = "Measured attacks and their values. This is not a statement that the data are anonymous.")
}

#' Rare combinations: of the two-way category combinations a real table has at
#' least `min_count` times, how many the synthetic table never produces, and
#' how many combinations the synthetic table produces that the real one never
#' has (plan 5.1 fidelity: rare combinations).
vcr_rare_combinations <- function(real, synth, min_count = 5L, max_levels = 10L, max_pairs = 20L) {
  vars <- intersect(names(real), names(synth))
  cats <- vars[vapply(vars, function(v) .vcr_is_categorical(real[[v]], max_levels), logical(1))]
  if (length(cats) < 2L) return(list(available = FALSE, reason = "fewer_than_two_categorical_columns"))
  pairs <- utils::combn(cats, 2L, simplify = FALSE)
  pairs <- pairs[seq_len(min(length(pairs), max_pairs))]
  rows <- lapply(pairs, function(pr) {
    kr <- paste(as.character(real[[pr[1]]]), as.character(real[[pr[2]]]), sep = "\u001f")
    ks <- paste(as.character(synth[[pr[1]]]), as.character(synth[[pr[2]]]), sep = "\u001f")
    tr <- table(kr); common <- names(tr)[tr >= min_count]
    data.frame(pair = paste(pr, collapse = " x "),
               realCombinations = length(common),
               missingInSynthetic = if (length(common)) mean(!(common %in% ks)) else NA_real_,
               syntheticCombinations = length(unique(ks)),
               absentFromReal = mean(!(unique(ks) %in% names(tr))),
               stringsAsFactors = FALSE)
  })
  tab <- do.call(rbind, rows)
  list(available = TRUE, minCount = min_count, pairs = tab,
       worstMissingInSynthetic = suppressWarnings(max(tab$missingInSynthetic, na.rm = TRUE)),
       worstAbsentFromReal = suppressWarnings(max(tab$absentFromReal, na.rm = TRUE)))
}

#' Train-on-synthetic, test-on-real (and the train-on-real baseline): a
#' generalised linear model of `outcome` on every other column is fitted on the
#' synthetic table and scored on the holdout, next to the same model fitted on
#' the training table. `ratio` is TSTR / TRTR for AUC (binary outcome) or
#' TRTR / TSTR for the RMSE (continuous), so 1 means the synthetic table taught
#' the model as much as the real one did.
vcr_tstr <- function(train, synth, holdout, outcome) {
  if (!(outcome %in% names(train) && outcome %in% names(synth) && outcome %in% names(holdout))) {
    return(list(available = FALSE, reason = "outcome_not_in_all_tables"))
  }
  binary <- all(stats::na.omit(train[[outcome]]) %in% c(0, 1))
  vars <- setdiff(Reduce(intersect, list(names(train), names(synth), names(holdout))), outcome)
  if (!length(vars)) return(list(available = FALSE, reason = "no_predictors"))
  f <- vcr_model_formula(outcome, vars)
  fam <- if (binary) stats::binomial() else stats::gaussian()
  score <- function(dat) {
    fit <- tryCatch(suppressWarnings(stats::glm(f, data = dat, family = fam)), error = function(e) NULL)
    if (is.null(fit)) return(NA_real_)
    pred <- tryCatch(suppressWarnings(as.numeric(stats::predict(fit, newdata = holdout, type = "response"))), error = function(e) rep(NA_real_, nrow(holdout)))
    ok <- is.finite(pred) & !is.na(holdout[[outcome]])
    if (!any(ok)) return(NA_real_)
    if (binary) .vcr_auc(pred[ok], holdout[[outcome]][ok]) else sqrt(mean((pred[ok] - holdout[[outcome]][ok])^2))
  }
  s <- score(synth); r <- score(train)
  list(available = TRUE, outcome = outcome, metric = if (binary) "auc" else "rmse",
       trainOnSynthetic = s, trainOnReal = r,
       ratio = if (is.finite(s) && is.finite(r) && r > 0 && s > 0) (if (binary) s / r else r / s) else NA_real_)
}

#' A declared analysis (JSON), as a function of a table. `kind = "mean"` names
#' a `column`; `kind = "glm"` names an `outcome`, the `predictors`, a `target`
#' predictor whose coefficient is reported, and a `family` (gaussian or
#' binomial). Column names must be plain identifiers; the formula is built from
#' them with `vcr_model_formula` (symbols, never parsed text).
vcr_analysis_from_spec <- function(spec) {
  ident <- function(x) is.character(x) && length(x) >= 1L && all(grepl(.VCR_ROW_COL_RE, x))
  kind <- as.character(spec$kind %||% "")
  if (identical(kind, "mean")) {
    col <- as.character(spec$column %||% "")
    if (!ident(col)) vcr_abort("scenario_value_invalid", "scenario.analyses", "A mean analysis names one column.")
    return(function(d) {
      x <- stats::na.omit(as.numeric(d[[col]])); se <- stats::sd(x) / sqrt(length(x))
      list(estimate = mean(x), interval = mean(x) + c(-1, 1) * 1.96 * se)
    })
  }
  if (identical(kind, "glm")) {
    outcome <- as.character(spec$outcome %||% ""); preds <- vcr_chr(spec$predictors)
    target <- as.character(spec$target %||% preds[1]); fam <- as.character(spec$family %||% "gaussian")
    if (!ident(outcome) || !ident(preds) || !(target %in% preds) || !(fam %in% c("gaussian", "binomial"))) {
      vcr_abort("scenario_value_invalid", "scenario.analyses", "A glm analysis names an outcome, its predictors, a target predictor and a family (gaussian or binomial).")
    }
    return(function(d) {
      fit <- suppressWarnings(stats::glm(vcr_model_formula(outcome, preds), data = d,
                                         family = if (fam == "binomial") stats::binomial() else stats::gaussian()))
      co <- summary(fit)$coefficients
      nm <- if (target %in% rownames(co)) target else rownames(co)[grep(paste0("^", target), rownames(co))[1]]
      est <- co[nm, "Estimate"]; se <- co[nm, "Std. Error"]
      list(estimate = est, interval = est + c(-1, 1) * 1.96 * se)
    })
  }
  vcr_abort("scenario_value_invalid", "scenario.analyses", "An analysis is kind 'mean' or 'glm'.")
}

#' The whole suite. `analyses` is a list of declared estimands, each a
#' function(data) -> list(estimate, interval), for the specific-utility axis
#' (see `vcr_analysis_from_spec` for the JSON form the jobs use).
vcr_quality_report <- function(train, synth, holdout = NULL, constraints = NULL,
                               analyses = list(), criteria = NULL,
                               generator = list(), tstr_outcome = NULL) {
  bands <- vcr_quality_bands()
  uni <- vcr_fidelity_univariate(train, synth)
  pair <- vcr_fidelity_pairwise(train, synth)
  prop <- tryCatch(vcr_utility_propensity(train, synth), error = function(e) list(sPMSE = NA_real_, propensityAuc = NA_real_, error = "propensity model could not be fitted"))
  viol <- vcr_constraint_violations(synth, constraints)
  rare <- vcr_rare_combinations(train, synth)

  specific <- lapply(names(analyses), function(nm) {
    f <- analyses[[nm]]
    a <- f(train); b <- f(synth)
    list(analysis = nm, realEstimate = a$estimate, syntheticEstimate = b$estimate,
         confidenceIntervalOverlap = vcr_ci_overlap(a$interval, b$interval))
  })
  names(specific) <- names(analyses)

  feasibility <- NULL
  if (!is.null(criteria) && length(criteria)) {
    crit <- vcr_named_rules(criteria, intersect(names(train), names(synth)), "criteria")
    if (length(crit$issues)) vcr_abort_issue(crit$issues[[1]])
    ev <- function(d) lapply(crit$rules, function(c_) vcr_eval_row_rule(c_$rule, d))
    er <- ev(train); es <- ev(synth)
    pr <- vapply(er, function(v) mean(v, na.rm = TRUE), numeric(1))
    ps <- vapply(es, function(v) mean(v, na.rm = TRUE), numeric(1))
    joint_r <- mean(Reduce(`&`, er), na.rm = TRUE)
    joint_s <- mean(Reduce(`&`, es), na.rm = TRUE)
    feasibility <- list(perCriterion = data.frame(criterion = vapply(crit$rules, function(c_) c_$name, character(1)),
                                                  realPassRate = pr, syntheticPassRate = ps),
                        jointPassRateReal = joint_r, jointPassRateSynthetic = joint_s,
                        jointPassRateRelativeDifference = if (is.finite(joint_r) && joint_r > 0) abs(joint_s - joint_r) / joint_r else NA_real_)
  }

  disclosure <- vcr_disclosure_report(train, synth, holdout)
  tstr <- if (!is.null(tstr_outcome) && !is.null(holdout) && nrow(holdout)) vcr_tstr(train, synth, holdout, tstr_outcome) else NULL

  bandsOut <- list(
    worstKsD = vcr_band(max(uni$value[uni$statistic == "ks_d"], -Inf), bands$ksD),
    worstTvd = vcr_band(max(uni$value[uni$statistic == "tvd"], -Inf), bands$tvd),
    worstMissingRateDifference = vcr_band(max(uni$missingRateDifference, -Inf), bands$missingRateDifference),
    worstPairwise = vcr_band(if (nrow(pair)) max(pair$value) else 0, bands$pairwiseDifference),
    sPMSE = vcr_band(prop$sPMSE, bands$sPmse),
    propensityAuc = vcr_band(prop$propensityAuc, bands$propensityAuc)
  )
  if (isTRUE(disclosure$available)) {
    bandsOut$replication <- vcr_band(disclosure$replicationRatio, bands$replicationRate)
    bandsOut$nearestNeighbourInTrainShare <- vcr_band(disclosure$nearestNeighbourInTrainShare, bands$nearestNeighbourInTrainShare)
    bandsOut$membershipAuc <- vcr_band(disclosure$membershipAuc, bands$membershipAuc)
  }
  if (!is.null(tstr) && isTRUE(tstr$available)) bandsOut$tstrRatio <- vcr_band(tstr$ratio, bands$tstrRatio)
  if (!is.null(feasibility)) {
    bandsOut$jointPassRate <- vcr_band(feasibility$jointPassRateRelativeDifference, bands$jointPassRateRelativeDifference)
  }

  list(
    fidelity = list(univariate = uni, pairwise = pair, global = prop, rareCombinations = rare),
    constraints = viol,
    constraintsPass = all(viol$violations == 0),
    utility = list(specific = specific, feasibility = feasibility, tstr = tstr),
    disclosure = disclosure,
    bands = bandsOut,
    bandSources = lapply(bands, function(b) b$source),
    generator = generator,
    advisory = TRUE,
    note = "Every band is a notice. Only the declared hard constraints are an invariant."
  )
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# ---------------------------------------------------------------------------
# Model cards, applicability, calibration and leakage (plan 5.2, 8.2).
#
# Hidden knowledge:
#
# - **The digital-twin label is derived, never granted.** NASEM 2023 asks for
#   four things at once; three of four is a baseline-conditioned prediction,
#   and there is no field anyone can set to make it say otherwise. This
#   mirrors `twinLabel` in `@evimed/domain`'s `vcrVocabulary.mjs`; the two are
#   compared in the C2-09 case.
# - **Applicability is checked before prediction, and a failure produces no
#   prediction at all.** Not a wide interval, not a NA row with a warning --
#   nothing. A model asked about a patient outside its declared input range is
#   being asked a question it has no evidence about, and an extrapolation with
#   an honest-looking interval is worse than a refusal.
# - **Calibration is three numbers, not one.** Calibration-in-the-large moves
#   under a systematic shift; the slope moves under a spread error; ICI catches
#   the shape errors neither of the first two see. A "well calibrated" claim on
#   one of the three is how a +10% biased model passes review (case C2-12).
# - **Temporal validation leaks through `visible_at`, not `occurred_at`.** A
#   laboratory value that *happened* before the cut-off but was only
#   *recorded* after it was not available to anyone making a decision at the
#   cut-off. This is the whole reason the platform carries three clocks.
# ---------------------------------------------------------------------------

VCR_TWIN_EVIDENCE <- c("individual_conditioned", "updates_with_new_data",
                       "calibrated_uncertainty", "validation_record")

#' `digital_twin` only with all four; otherwise `baseline_conditioned_prediction`.
vcr_twin_label <- function(evidence) {
  if (all(VCR_TWIN_EVIDENCE %in% (evidence %||% character()))) "digital_twin"
  else "baseline_conditioned_prediction"
}

#' Required model-card fields (plan 8.2). Missing items are named, not counted.
VCR_MODEL_CARD_REQUIRED <- c(
  "id", "provider", "version", "modelKind", "contextOfUse", "population",
  "treatment", "endpoint", "timeHorizon", "inputRanges", "requiredFields",
  "trainingDataHash", "validationDataHash", "validationTable",
  "uncertaintyMethod", "outOfDistributionBehaviour", "modelRisk", "modelTier")

vcr_model_card_issues <- function(card) {
  issues <- list()
  for (field in VCR_MODEL_CARD_REQUIRED) {
    v <- card[[field]]
    # `nzchar()` is vectorized: a length-2 field like `requiredFields` makes a
    # bare `!nzchar(v)` a length-2 condition, which R 4.2+ turns into an error
    # rather than a silent first-element test. Reduce first, then decide.
    if (is.null(v) || length(v) == 0L || (is.character(v) && !any(nzchar(v)))) {
      issues[[length(issues) + 1L]] <- vcr_issue("model_card_field_missing", field,
        sprintf("a model card states %s (plan 8.2)", field))
    }
  }
  if (!is.null(card$modelRisk) && !(card$modelRisk %in% c("none", "low", "medium", "high"))) {
    issues[[length(issues) + 1L]] <- vcr_issue("model_risk_unknown", "modelRisk",
      "model risk is none, low, medium or high (ICH M15 / ASME V&V 40)")
  }
  if (identical(vcr_twin_label(card$twinEvidence), "digital_twin") &&
      !identical(card$label %||% "digital_twin", "digital_twin")) {
    issues[[length(issues) + 1L]] <- vcr_issue("twin_label_inconsistent", "label",
      "the declared label disagrees with the evidence the card carries")
  }
  issues
}

#' Can this model answer about these inputs? Returns issues; a non-empty list
#' means no prediction is produced.
vcr_applicability_issues <- function(card, inputs) {
  issues <- list()
  for (field in card$requiredFields %||% character()) {
    if (is.null(inputs[[field]]) || all(is.na(inputs[[field]]))) {
      issues[[length(issues) + 1L]] <- vcr_issue("required_field_missing", field,
        sprintf("%s is required by %s and was not supplied", field, card$id %||% "this model"))
    }
  }
  for (field in names(card$inputRanges %||% list())) {
    rng <- card$inputRanges[[field]]
    v <- inputs[[field]]
    if (is.null(v)) next
    out <- v < rng[[1]] | v > rng[[2]]
    if (any(out, na.rm = TRUE)) {
      issues[[length(issues) + 1L]] <- vcr_issue("input_out_of_range", field,
        sprintf("%d of %d values fall outside the declared range [%s, %s]",
                sum(out, na.rm = TRUE), length(v), format(rng[[1]]), format(rng[[2]])))
    }
  }
  issues
}

#' Predict only when applicable. Returns either a prediction or the issues.
vcr_model_predict <- function(card, inputs, predictor) {
  issues <- vcr_applicability_issues(card, inputs)
  if (length(issues)) return(list(applicable = FALSE, issues = issues, prediction = NULL))
  list(applicable = TRUE, issues = list(), prediction = predictor(inputs),
       label = vcr_twin_label(card$twinEvidence))
}

#' Calibration of a continuous prediction: in-the-large, slope, and the
#' integrated calibration index (a LOESS-free version using binned means, so
#' the number does not depend on a smoother's bandwidth default).
vcr_calibration <- function(observed, predicted, bins = 10L) {
  fit <- stats::lm(observed ~ predicted)
  co <- stats::coef(fit)
  cut <- stats::quantile(predicted, seq(0, 1, length.out = bins + 1L), names = FALSE)
  cut[1] <- -Inf; cut[length(cut)] <- Inf
  grp <- cut(predicted, cut, labels = FALSE)
  ici <- mean(abs(tapply(observed, grp, mean)[as.character(grp)] - predicted), na.rm = TRUE)
  list(inTheLarge = mean(observed) - mean(predicted),
       intercept = unname(co[1]), slope = unname(co[2]),
       integratedCalibrationIndex = ici, n = length(observed))
}

#' Coverage of prediction intervals, with the binomial interval a correctly
#' calibrated model should sit inside.
vcr_interval_coverage <- function(observed, low, high, nominal = 0.95, level = 0.99) {
  inside <- observed >= low & observed <= high
  n <- length(inside); p <- mean(inside)
  ci <- stats::binom.test(sum(inside), n, nominal, conf.level = level)$conf.int
  list(coverage = p, n = n, nominal = nominal,
       binomialInterval = as.numeric(ci),
       withinBinomialInterval = nominal >= ci[1] && nominal <= ci[2],
       meanWidth = mean(high - low))
}

#' Continuous ranked probability score for a normal predictive distribution.
vcr_crps_normal <- function(observed, mean, sd) {
  z <- (observed - mean) / sd
  mean(sd * (z * (2 * stats::pnorm(z) - 1) + 2 * stats::dnorm(z) - 1 / sqrt(pi)))
}

#' Temporal-validation leakage: any fact whose `visible_at` is after the
#' cut-off may not have been used. Returns the offending rows, by name.
vcr_temporal_leakage <- function(facts, cutoff, used) {
  leaked <- facts[facts$visible_at > cutoff & facts$feature %in% used, , drop = FALSE]
  list(leaked = leaked, count = nrow(leaked),
       clean = nrow(leaked) == 0L,
       note = "A value that occurred before the cut-off but became visible after it was not available at the cut-off.")
}
