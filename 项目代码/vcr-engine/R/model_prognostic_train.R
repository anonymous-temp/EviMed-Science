# ---------------------------------------------------------------------------
# model_prognostic_train.R — a prognostic model trained on the user's own historical table, cross-fitted
# (algorithm round P3, 2026-11-03; `model.prognostic_train`).
#
# Hidden knowledge:
#
# - **The platform ships no prognostic model; this is how a person brings theirs.** A prognostic score is only as good as the correlation it has
#   with the outcome in people it was NOT fitted to, and the EMA's PROCOVA opinion asks for that number to be measured out of sample and then
#   discounted (`R/procova.R`). So every number here is out of fold: the table is split into K folds, each fold is predicted by a model that
#   never saw it, and discrimination, calibration and the correlation are read from the pooled out-of-fold predictions. The model that is saved
#   is the one fitted to every row, labelled as trained on the person's own data and not externally validated: no out-of-fold figure stands in
#   for another population.
# - **Cox is the model, and a forest is only a comparison.** In 34 public low-dimensional right-censored data sets no method of 19 was
#   significantly better than a Cox model (Burk et al.); linear and logistic regression are the same choice for a continuous and a binary
#   outcome. `ranger` is fitted on the same folds and reported beside the regression; it is never saved and never what `model.prognostic_apply`
#   receives, so the equation stays one a reader can check by hand.
# - **The saved model is exactly the shape `model.prognostic_apply` takes.** Terms (column, coefficient, unit, transform, centre, scale), an
#   intercept for a linear or logistic model, a residual SD for a linear one (the OUT-OF-FOLD root mean square error: the honest spread of a new
#   person, not the optimistic in-sample one), and for Cox the baseline survival at the horizon with the covariates centred at their means. A
#   categorical predictor becomes one indicator term per non-reference level; the reference is the commonest level.
# - **The correlation rho is defined per outcome, and for time-to-event it is an approximation.** PROCOVA's formula is a continuous outcome's.
#   For a binary outcome rho is the Pearson correlation of the out-of-fold probability with the 0/1 outcome (point-biserial). For time to event
#   it is the same correlation with the indicator "event by the horizon", among the people whose status at the horizon is known (an event
#   before it, or followed past it); the people censored before the horizon are left out and counted. It is reported with a Fisher interval and
#   the table of savings is computed from the estimate and from the interval's lower end.
# - **Savings are `design.procova`'s own formula.** The sample-size ratio of the prognostic path to the unadjusted one for a discount lambda on
#   the correlation and gamma on the control arm's SD is `vcr_procova_paths` (`R/procova.R`), so a table here and a `design.procova` job for the
#   same numbers agree to the last digit (N98c). A ratio above one (gamma outweighing lambda * rho) is a cost, shown as a negative saving.
# - **People are never listed.** The result holds aggregates and the equation. A level of a categorical predictor held by fewer than the
#   platform's small-cell size is not given a term and is not named: a person with it gets no prediction from the saved equation
#   (`unknown_category`), which is the honest answer to "this level was never seen enough".
# - **A model that cannot be estimated is not estimated.** Fewer than 10 events (or non-events), or fewer than 5 per fitted parameter, makes the
#   job `not_estimable` with `too_few_events`; a fold whose model does not converge, or whose logistic fit separates, makes it
#   `nuisance_model_not_estimable`. No score is invented.
# ---------------------------------------------------------------------------

.VCR_PROGNOSTIC_TRANSFORMS <- c("identity", "log", "log1p", "square")

.vcr_prognostic_transform <- function(x, transform) {
  switch(transform, identity = x, log = suppressWarnings(log(x)), log1p = suppressWarnings(log1p(x)), square = x^2,
         vcr_abort("scenario_value_invalid", "scenario.predictors", "Unsupported transform."))
}

#' The design matrix of the predictors and what each column of it is. A numeric predictor is one column (transformed), a text or logical one an
#' indicator per level that is not the reference. `complete` marks the rows every predictor can be read for (no missing value, a level seen
#' often enough, a value in the transform's domain).
vcr_prognostic_design <- function(data, predictors, min_cell = vcr_limit("minCellSize", 10)) {
  n <- nrow(data); cols <- list(); terms <- list(); complete <- rep(TRUE, n); dropped <- list()
  for (p in predictors) {
    col <- as.character(p[["column"]]); unit <- as.character(p[["unit"]] %||% "unknown"); tr <- as.character(p[["transform"]] %||% "identity")
    if (!(col %in% names(data))) vcr_abort("scenario_value_invalid", "scenario.predictors", sprintf("The predictor '%s' is not a column of the table.", col))
    x <- data[[col]]
    if (is.numeric(x) || is.integer(x)) {
      if (!(tr %in% .VCR_PROGNOSTIC_TRANSFORMS)) vcr_abort("scenario_value_invalid", "scenario.predictors", "Unsupported transform.")
      v <- .vcr_prognostic_transform(as.numeric(x), tr)
      bad <- is.na(v) | !is.finite(v); complete <- complete & !bad
      cols[[col]] <- v
      terms[[length(terms) + 1L]] <- list(column = col, kind = "numeric", transform = tr, unit = unit, name = col)
    } else {
      ch <- as.character(x)
      tab <- table(ch); keep <- names(tab)[tab >= min_cell]
      if (length(keep) < 2L) vcr_abort("scenario_value_invalid", "scenario.predictors", sprintf("The predictor '%s' has fewer than two levels held by at least %d people.", col, min_cell))
      ref <- keep[order(-as.numeric(tab[keep]), keep)][1L]
      dropped[[col]] <- length(setdiff(names(tab), keep))
      seen <- !is.na(ch) & ch %in% keep; complete <- complete & seen
      for (lv in setdiff(keep, ref)) {
        nm <- paste0(col, "=", lv)
        cols[[nm]] <- as.numeric(ch == lv)
        terms[[length(terms) + 1L]] <- list(column = col, kind = "indicator", transform = "indicator", category = lv, levels = sort(keep), reference = ref, unit = "category", name = nm)
      }
    }
  }
  list(X = do.call(cbind, cols), terms = terms, complete = complete, raredLevelsDropped = dropped)
}

# --- the three model families, one function each: fit on rows, predict the linear predictor ------------------

.vcr_pt_fit_linear <- function(X, y) {
  A <- cbind(1, X); fit <- tryCatch(stats::lm.fit(A, y), error = function(e) NULL)
  if (is.null(fit) || anyNA(fit$coefficients)) return(NULL)
  list(coef = fit$coefficients, family = "linear", df = length(y) - ncol(A), rss = sum(fit$residuals^2))
}
.vcr_pt_fit_logistic <- function(X, y) {
  A <- cbind(1, X); fit <- tryCatch(suppressWarnings(stats::glm.fit(A, y, family = stats::binomial())), error = function(e) NULL)
  if (is.null(fit) || !isTRUE(fit$converged) || anyNA(fit$coefficients) || isTRUE(fit$boundary) || max(abs(fit$coefficients)) > 30) return(NULL)
  list(coef = fit$coefficients, family = "logistic")
}
.vcr_pt_fit_cox <- function(X, time, status, horizon) {
  d <- as.data.frame(X); names(d) <- paste0("V", seq_len(ncol(X))); d$.t <- time; d$.s <- status
  fit <- tryCatch(suppressWarnings(survival::coxph(stats::as.formula(paste("survival::Surv(.t, .s) ~", paste(names(d)[seq_len(ncol(X))], collapse = " + "))), data = d, ties = "efron")), error = function(e) NULL)
  if (is.null(fit) || anyNA(stats::coef(fit)) || max(abs(stats::coef(fit))) > 30) return(NULL)
  bh <- tryCatch(survival::basehaz(fit, centered = TRUE), error = function(e) NULL)
  if (is.null(bh)) return(NULL)
  h0 <- if (is.finite(horizon) && any(bh$time <= horizon)) bh$hazard[max(which(bh$time <= horizon))] else NA_real_
  list(coef = unname(stats::coef(fit)), means = unname(fit$means), family = "cox", cumhaz = h0, horizonInData = is.finite(horizon) && horizon <= max(time))
}

.vcr_pt_linear_predictor <- function(fit, X, centre = NULL) {
  if (identical(fit$family, "cox")) as.numeric(sweep(X, 2L, centre %||% fit$means, "-") %*% fit$coef)
  else as.numeric(cbind(1, X) %*% fit$coef)
}

#' DeLong's variance of an AUC (the structural components, ties as half), with the AUC. O(n log n).
.vcr_delong <- function(score, y) {
  pos <- score[y == 1]; neg <- score[y == 0]; m <- length(pos); n <- length(neg)
  sp <- sort(neg); sn <- sort(pos)
  v10 <- (findInterval(pos, sp, left.open = TRUE) + 0.5 * (findInterval(pos, sp) - findInterval(pos, sp, left.open = TRUE))) / n
  v01 <- 1 - (findInterval(neg, sn, left.open = TRUE) + 0.5 * (findInterval(neg, sn) - findInterval(neg, sn, left.open = TRUE))) / m
  auc <- mean(v10)
  list(auc = auc, se = sqrt(stats::var(v10) / m + stats::var(v01) / n))
}

.vcr_fisher_interval <- function(r, n, level = 0.95) {
  if (!is.finite(r) || n < 4L) return(c(NA_real_, NA_real_))
  z <- atanh(max(min(r, 0.999999), -0.999999)); h <- stats::qnorm(1 - (1 - level) / 2) / sqrt(n - 3)
  tanh(c(z - h, z + h))
}

#' The folds: events and non-events (or the whole table for a continuous outcome) are dealt round the folds in a random order, so each fold has
#' about the same number of each.
.vcr_pt_folds <- function(strata, k) {
  fold <- integer(length(strata))
  for (s in unique(strata)) {
    idx <- which(strata == s); idx <- idx[sample.int(length(idx))]
    fold[idx] <- rep(seq_len(k), length.out = length(idx))
  }
  fold
}

#' The forest, as a comparison. Same folds, one thread, its own seed per fold.
.vcr_pt_ranger <- function(frame, outcome, folds, k, horizon, seed) {
  if (!requireNamespace("ranger", quietly = TRUE)) return(NULL)
  trees <- 300L; pred <- rep(NA_real_, nrow(frame))
  for (f in seq_len(k)) {
    tr <- folds != f; te <- !tr
    mod <- tryCatch({
      if (identical(outcome$type, "time_to_event")) {
        rf <- ranger::ranger(survival::Surv(.t, .s) ~ ., data = frame[tr, , drop = FALSE], num.trees = trees, num.threads = 1L, seed = as.integer((seed + f) %% 2147483647L))
        p <- stats::predict(rf, data = frame[te, , drop = FALSE])
        ti <- p$unique.death.times; j <- if (any(ti <= horizon)) max(which(ti <= horizon)) else 0L
        if (j == 0L) rep(0, sum(te)) else 1 - p$survival[, j]
      } else if (identical(outcome$type, "binary")) {
        rf <- ranger::ranger(.y ~ ., data = transform(frame[tr, , drop = FALSE], .y = factor(.y, levels = c(0, 1))), probability = TRUE, num.trees = trees, num.threads = 1L, seed = as.integer((seed + f) %% 2147483647L))
        stats::predict(rf, data = frame[te, , drop = FALSE])$predictions[, "1"]
      } else {
        rf <- ranger::ranger(.y ~ ., data = frame[tr, , drop = FALSE], num.trees = trees, num.threads = 1L, seed = as.integer((seed + f) %% 2147483647L))
        stats::predict(rf, data = frame[te, , drop = FALSE])$predictions
      }
    }, error = function(e) NULL)
    if (is.null(mod)) return(NULL)
    pred[te] <- mod
  }
  pred
}

#' The sample-size table: for each discount lambda on the correlation and gamma on the control SD, the ratio of the prognostic path's size to the
#' unadjusted one (`vcr_procova_paths`), at the correlation estimated out of fold and at the lower end of its interval.
.vcr_pt_procova_table <- function(rho, rho_low, lambdas, gammas, allocation) {
  rows <- list()
  for (g in gammas) for (l in lambdas) for (which in c("estimate", "lower")) {
    r <- if (identical(which, "estimate")) rho else rho_low
    if (!is.finite(r)) next
    r <- max(0, r)
    ratio <- vcr_procova_paths(delta = 1, sd = 1, alpha = 0.025, power = 0.9, rho_prognostic = r, rho_ordinary = 0, lambda = l, gamma = g, allocation = allocation)$prognosticScore$varianceRatio
    rows[[length(rows) + 1L]] <- list(lambda = l, gamma = g, rhoAt = which, rho = r, rhoApplied = l * r, sampleSizeRatio = vcr_measure("sample_size_ratio", ratio, source = "calculated"),
                                      saving = vcr_measure("sample_size_saving", 1 - ratio, source = "calculated"))
  }
  rows
}

vcr_job_train_prognostic_model <- function(job, output_dir = NULL, ...) {
  sc <- job[["scenario"]]
  set.seed(job[["seed"]], kind = VCR_RNG_KIND)
  input <- vcr_input_by_id(job, as.character(sc[["inputId"]]))
  if (is.null(input)) vcr_abort("scenario_value_invalid", "scenario.inputId", "Select one frozen historical table.")
  data <- vcr_read_table_input(input)
  source <- vcr_table_source(data)
  vcr_require_individual(data, "Training a prognostic model", "model.prognostic_train")
  ep <- sc[["endpoint"]]; type <- as.character(ep[["type"]])
  # a time to event that is not a column of the table is the event table of the snapshot (AVAL, and CNSR = 1 for a censored person), joined by the person
  if (identical(type, "time_to_event") && !(as.character(ep[["timeColumn"]]) %in% names(data))) {
    ev <- vcr_job_tables(job)[["event"]]
    if (!is.null(ev) && as.character(sc[["idColumn"]]) %in% names(data)) {
      evf <- vcr_event_frame(ev, ep[["parameterCode"]])
      at <- match(as.character(data[[sc[["idColumn"]]]]), as.character(evf$USUBJID))
      data[[as.character(ep[["timeColumn"]])]] <- evf$time[at]; data[[as.character(ep[["statusColumn"]])]] <- evf$status[at]
      attr(data, "vcrSource") <- source
    }
  }
  predictors <- sc[["predictors"]]
  cols <- unique(c(vapply(predictors, function(p) as.character(p[["column"]]), character(1)), sc[["idColumn"]], sc[["armColumn"]],
                   if (type == "time_to_event") c(ep[["timeColumn"]], ep[["statusColumn"]]) else ep[["outcomeColumn"]]))
  used <- vcr_used_sources(list(list(df = data, columns = setdiff(cols, NULL))))
  for (cn in setdiff(cols, NULL)) if (!(cn %in% names(data))) vcr_abort("scenario_value_invalid", "scenario", sprintf("The column '%s' is not in the table.", cn))
  id_col <- as.character(sc[["idColumn"]])
  ids <- as.character(data[[id_col]])
  if (anyNA(ids) || any(!nzchar(ids)) || anyDuplicated(ids)) vcr_abort("scenario_value_invalid", "scenario.idColumn", "Exactly one row per person is required.")
  original_n <- nrow(data)
  if (!is.null(sc[["armColumn"]])) data <- data[!is.na(data[[sc[["armColumn"]]]]) & as.character(data[[sc[["armColumn"]]]]) == as.character(sc[["armValue"]]), , drop = FALSE]
  attr(data, "vcrSource") <- source
  estimate_source <- vcr_estimate_source(used[["source"]])

  # the outcome
  horizon <- as.numeric(ep[["horizon"]])
  if (type == "time_to_event") {
    tm <- suppressWarnings(as.numeric(data[[ep[["timeColumn"]]]])); st <- suppressWarnings(as.numeric(data[[ep[["statusColumn"]]]]))
    ok_out <- is.finite(tm) & tm > 0 & st %in% c(0, 1)
  } else {
    y <- suppressWarnings(as.numeric(data[[ep[["outcomeColumn"]]]])); ok_out <- is.finite(y)
    if (type == "binary" && !all(y[ok_out] %in% c(0, 1))) vcr_abort("scenario_value_invalid", "scenario.endpoint.outcomeColumn", "A binary outcome is 0 or 1.")
  }
  des <- vcr_prognostic_design(data, predictors)
  keep <- ok_out & des$complete
  excluded <- sum(!keep)
  data <- data[keep, , drop = FALSE]; X <- des$X[keep, , drop = FALSE]; n <- nrow(X); p <- ncol(X)
  if (type == "time_to_event") { tm <- tm[keep]; st <- st[keep]; events <- sum(st == 1); nonevents <- sum(st == 0) }
  else { y <- y[keep]; events <- if (type == "binary") sum(y == 1) else n; nonevents <- if (type == "binary") sum(y == 0) else n }
  k <- as.integer(sc[["folds"]] %||% 5L)
  counts <- vcr_table_counts(data, if (type == "time_to_event") events else NULL)
  scale_n <- if (type == "continuous") n else min(events, nonevents)
  need <- if (type == "continuous") max(20L, 10L * (p + 1L)) else max(10L, 5L * (p + 1L))
  if (scale_n < need) {
    return(list(status = "succeeded", conclusion = "not_estimable", notEstimableRule = "too_few_events", counts = counts, measures = list(),
                diagnostics = list(inputRows = original_n, usedRows = n, excludedRows = excluded, parameters = p, needed = need, available = scale_n, source = source)))
  }
  if (type == "time_to_event" && !(horizon <= max(tm))) {
    # the horizon beyond the data gives no absolute risk; the relative score and its discrimination are still honest, and the equation carries no baseline
    horizon_in_data <- FALSE
  } else horizon_in_data <- TRUE
  folds <- .vcr_pt_folds(if (type == "continuous") rep(1L, n) else if (type == "time_to_event") st else y, k)

  # --- cross-fitting
  gmean <- colMeans(X)
  oof_lp <- rep(NA_real_, n); oof_pred <- rep(NA_real_, n); failed <- 0L
  for (f in seq_len(k)) {
    interrupted <- vcr_interrupt()
    if (!is.null(interrupted)) vcr_abort("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out during the cross-fitting; there is no model.")
    tr <- folds != f; te <- !tr
    fit <- switch(type, continuous = .vcr_pt_fit_linear(X[tr, , drop = FALSE], y[tr]), binary = .vcr_pt_fit_logistic(X[tr, , drop = FALSE], y[tr]),
                  time_to_event = .vcr_pt_fit_cox(X[tr, , drop = FALSE], tm[tr], st[tr], if (horizon_in_data) horizon else NA_real_))
    if (is.null(fit)) { failed <- failed + 1L; next }
    if (type == "time_to_event") {
      oof_lp[te] <- .vcr_pt_linear_predictor(fit, X[te, , drop = FALSE], gmean)
      oof_pred[te] <- if (is.finite(fit$cumhaz)) -expm1(-fit$cumhaz * exp(.vcr_pt_linear_predictor(fit, X[te, , drop = FALSE]))) else NA_real_
    } else {
      lp <- .vcr_pt_linear_predictor(fit, X[te, , drop = FALSE])
      oof_lp[te] <- lp; oof_pred[te] <- if (type == "binary") stats::plogis(lp) else lp
    }
  }
  if (failed > 0L) {
    return(list(status = "succeeded", conclusion = "not_estimable", notEstimableRule = "nuisance_model_not_estimable", counts = counts, measures = list(),
                diagnostics = list(inputRows = original_n, usedRows = n, failedFolds = failed, folds = k, source = source)))
  }

  # --- discrimination and the correlation, out of fold
  disc <- NULL; rho <- NA_real_; rho_n <- n; excluded_for_rho <- 0L
  if (type == "continuous") {
    sse <- sum((y - oof_pred)^2); sst <- sum((y - mean(y))^2)
    disc <- list(metric = "r_squared", value = 1 - sse / sst, rmse = sqrt(sse / n))
    rho <- suppressWarnings(stats::cor(oof_pred, y))
  } else if (type == "binary") {
    dl <- .vcr_delong(oof_pred, y); z <- stats::qnorm(0.975)
    disc <- list(metric = "auc", value = dl$auc, low = dl$auc - z * dl$se, high = dl$auc + z * dl$se)
    rho <- suppressWarnings(stats::cor(oof_pred, y))
  } else {
    cc <- survival::concordance(survival::Surv(tm, st) ~ oof_lp, reverse = TRUE); z <- stats::qnorm(0.975); se <- sqrt(cc$var)
    disc <- list(metric = "c_index", value = unname(cc$concordance), low = unname(cc$concordance) - z * se, high = unname(cc$concordance) + z * se)
    known <- (st == 1 & tm <= horizon) | tm > horizon
    excluded_for_rho <- sum(!known); rho_n <- sum(known)
    ev <- as.numeric(st == 1 & tm <= horizon)
    rho <- if (rho_n >= 4L && stats::sd(oof_lp[known]) > 0 && stats::sd(ev[known]) > 0) suppressWarnings(stats::cor(oof_lp[known], ev[known])) else NA_real_
  }
  rho_ci <- .vcr_fisher_interval(rho, rho_n)

  # --- calibration: the same definitions as the local calibration of an applied published equation, on the out-of-fold predictions
  cal_data <- if (type == "time_to_event") data.frame(.time = tm, .status = st) else data.frame(.y = y)
  attr(cal_data, "vcrSource") <- source
  fam <- switch(type, continuous = "linear", binary = "logistic", time_to_event = "cox")
  applied <- list(prediction = oof_pred, score = oof_lp, absoluteRiskAvailable = type != "time_to_event" || (horizon_in_data && all(is.finite(oof_pred))))
  cal_spec <- if (type == "time_to_event") list(timeColumn = ".time", statusColumn = ".status") else list(outcomeColumn = ".y")
  calibration <- tryCatch(vcr_local_calibration(cal_data, applied, cal_spec, list(family = fam), list(horizon = horizon)), error = function(e) NULL)

  # --- the model that is saved: every row
  final <- switch(type, continuous = .vcr_pt_fit_linear(X, y), binary = .vcr_pt_fit_logistic(X, y), time_to_event = .vcr_pt_fit_cox(X, tm, st, if (horizon_in_data) horizon else NA_real_))
  if (is.null(final)) {
    return(list(status = "succeeded", conclusion = "not_estimable", notEstimableRule = "nuisance_model_not_estimable", counts = counts, measures = list(),
                diagnostics = list(inputRows = original_n, usedRows = n, stage = "final_fit", source = source)))
  }
  beta <- if (type == "time_to_event") final$coef else final$coef[-1L]
  equation_terms <- lapply(seq_along(des$terms), function(i) {
    t <- des$terms[[i]]
    centre <- if (type == "time_to_event") as.numeric(gmean[i]) else 0
    c(list(column = t$column, coefficient = as.numeric(beta[i]), unit = t$unit, transform = t$transform, center = centre, scale = 1),
      if (identical(t$kind, "indicator")) list(category = t$category, levels = as.list(t$levels)))
  })
  equation <- switch(type,
    continuous = list(family = "linear", intercept = as.numeric(final$coef[1L]), residualSd = max(disc$rmse, .Machine$double.eps), terms = equation_terms),
    binary = list(family = "logistic", intercept = as.numeric(final$coef[1L]), terms = equation_terms),
    time_to_event = c(list(family = "cox", terms = equation_terms),
                      if (horizon_in_data && is.finite(final$cumhaz)) list(baseline = list(reference = "centered", survival = exp(-final$cumhaz), horizon = horizon, timeUnit = as.character(ep[["timeUnit"]])))))
  input_units <- stats::setNames(lapply(des$terms, function(t) t$unit), vapply(des$terms, function(t) t$column, character(1)))
  input_units <- input_units[!duplicated(names(input_units))]
  model <- list(schema = "vcr-prognostic-model/1", label = "trained_on_user_data_not_externally_validated", externallyValidated = FALSE,
                equation = equation, inputUnits = input_units, endpoint = list(type = type, horizon = horizon, timeUnit = as.character(ep[["timeUnit"]])),
                sourceCondition = as.character(sc[["sourceCondition"]]),
                trainedOn = list(rows = n, events = if (type == "time_to_event" || type == "binary") events else NULL, predictors = vapply(predictors, function(p) as.character(p[["column"]]), character(1)),
                                 crossFitted = TRUE, folds = k, outOfFoldResidualSd = if (type == "continuous") disc$rmse else NULL),
                absoluteRiskAvailable = !is.null(equation$baseline) || type != "time_to_event")

  # --- the comparison and the table of savings
  comparison <- NULL
  if (!identical(sc[["comparison"]][["ranger"]], FALSE)) {
    frame <- as.data.frame(lapply(predictors, function(pp) { x <- data[[as.character(pp[["column"]])]]; if (is.numeric(x)) as.numeric(x) else factor(as.character(x)) }), stringsAsFactors = FALSE)
    names(frame) <- vapply(predictors, function(pp) as.character(pp[["column"]]), character(1))
    if (type == "time_to_event") { frame$.t <- tm; frame$.s <- st } else frame$.y <- y
    rp <- .vcr_pt_ranger(frame, list(type = type), folds, k, horizon, as.integer(job[["seed"]]))
    if (!is.null(rp) && all(is.finite(rp))) {
      val <- switch(type, continuous = 1 - sum((y - rp)^2) / sum((y - mean(y))^2), binary = .vcr_auc(rp, y),
                    time_to_event = unname(survival::concordance(survival::Surv(tm, st) ~ rp, reverse = TRUE)$concordance))
      comparison <- list(model = "random_forest", metric = disc$metric, value = val, difference = val - disc$value, trees = 300L,
                         note = "A forest on the same folds, reported beside the regression and never saved: in low-dimensional data no method has been shown to beat a Cox model significantly (Burk et al.).")
    }
  }
  pr <- sc[["procova"]]
  lambdas <- if (length(pr[["lambdas"]])) vcr_num(pr[["lambdas"]]) else c(1, 0.9, 0.75, 0.5)
  gammas <- if (length(pr[["gammas"]])) vcr_num(pr[["gammas"]]) else c(1, 1.1, 1.25)
  allocation <- vcr_scalar(pr[["allocation"]], 0.5)
  table <- .vcr_pt_procova_table(rho, rho_ci[1L], lambdas, gammas, allocation)

  m <- function(name, x, interval = NULL, source_ = "calculated") if (is.finite(x)) list(vcr_measure(name, x, source = source_, interval = interval)) else list()
  disc_name <- switch(disc$metric, r_squared = "out_of_fold_r_squared", auc = "out_of_fold_auc", c_index = "out_of_fold_c_index")
  measures <- c(m(disc_name, disc$value, if (!is.null(disc$low)) vcr_interval("confidence", disc$low, disc$high)),
                if (!is.null(calibration)) c(m("calibration_slope", calibration[["slope"]]$value %||% NA_real_, if (!is.null(calibration[["slope"]])) vcr_interval("confidence", calibration[["slope"]]$low, calibration[["slope"]]$high)),
                                             m("calibration_intercept", calibration[["intercept"]]$value %||% NA_real_, if (!is.null(calibration[["intercept"]])) vcr_interval("confidence", calibration[["intercept"]]$low, calibration[["intercept"]]$high)),
                                             m("calibration_in_the_large", calibration[["calibrationInLarge"]] %||% NA_real_)),
                m("prognostic_correlation", rho, if (all(is.finite(rho_ci))) vcr_interval("confidence", rho_ci[1L], rho_ci[2L])),
                if (!is.null(comparison)) m("comparison_forest_difference", comparison$difference))
  list(status = "succeeded", conclusion = "limited", counts = counts, measures = measures,
       diagnostics = list(model = model, modelScope = "trained_on_user_data", valueSourcesUsed = vcr_value_sources_used(used), source = source,
                          inputRows = original_n, usedRows = n, excludedRows = excluded, parameters = p, folds = k,
                          discrimination = disc, calibration = calibration,
                          correlation = list(value = rho, interval = if (all(is.finite(rho_ci))) list(lower = rho_ci[1L], upper = rho_ci[2L]) else NULL, n = rho_n,
                                             definition = switch(type, continuous = "Pearson correlation of the out-of-fold prediction with the outcome",
                                               binary = "Pearson correlation of the out-of-fold probability with the 0/1 outcome (point-biserial)",
                                               time_to_event = "Pearson correlation of the out-of-fold linear predictor with the indicator of an event by the horizon, among people whose status at the horizon is known; an approximation, since PROCOVA's formula is a continuous outcome's"),
                                             leftOut = excluded_for_rho),
                          comparison = comparison, procova = list(rows = table, lambdas = lambdas, gammas = gammas, allocation = allocation,
                                                                    note = "The sample-size ratio of design.procova's prognostic path to the unadjusted one, from the correlation measured out of fold and from the lower end of its interval."),
                          horizonInData = horizon_in_data, raredLevelsDropped = des$raredLevelsDropped,
                          clinicallyValidated = FALSE, causalEffectIdentified = FALSE,
                          limits = list("Trained and checked on one table of the person's own data: the out-of-fold figures say how the method does on people like these, and nothing about another population.",
                                        "A prognostic score does not identify a treatment effect, replace an observed control or add independent sample size by itself.")))
}
