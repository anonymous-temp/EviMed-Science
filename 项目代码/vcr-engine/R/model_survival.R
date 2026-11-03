# Fixed, intercept-only fits. No caller formula or executable expression is accepted.
# A reconstructed cohort remains pseudo-IPD; these are population baselines, not individual twins.
#
# Hidden knowledge (the spline family, algorithm round C13, 2026-11-03):
#
# - **Royston-Parmar is a model of the log cumulative hazard.** log H(t) = s(log t; gamma) with s a natural cubic spline in log time:
#   gamma0 + gamma1 x + sum_j gamma_{j+1} v_j(x), x = log t, the basis v_j(x) = (x - k_j)^3_+ - l_j (x - k_min)^3_+ - (1 - l_j)(x - k_max)^3_+,
#   l_j = (k_max - k_j) / (k_max - k_min). Beyond the boundary knots the cubic terms cancel and s is a straight line in log time, so the tail is
#   a Weibull's: that is what an extrapolation of this model IS, and the result says how far beyond the data a number lies and what the other
#   numbers of knots give there. flexsurv::flexsurvspline is the CI-only check and is never called from here.
# - **The log likelihood is concave in gamma where the hazard is positive.** For an event at t_i with basis B_i and derivative basis B'_i,
#   log f = s_i + log s'_i - log t_i - exp(s_i), and both s and s' are linear in gamma, so the Hessian is minus the sum of B'B'^T / s'^2 over
#   the events and of exp(s) B B^T over everyone. optim (BFGS, analytic gradient) finds the maximum from the Weibull fit and a few Newton steps
#   with the analytic Hessian finish it; the covariance is the inverse of that information, and every derived quantity (the median, the survival
#   at a horizon, the restricted mean) takes its error by the delta method from it.
# - **The hazard must stay positive.** s'(x) <= 0 anywhere means a cumulative hazard that falls: not a survival function. The fit is checked on
#   a fine grid between the boundary knots; a curve that fails it is "not estimable" for that number of knots, not repaired.
# - **Knots are where flexsurv puts them**: the boundary knots at the smallest and largest uncensored log time, the interior ones at the equally
#   spaced (type 7) quantiles of the uncensored log times between them. With no interior knots the model is a Weibull.

#' The Royston-Parmar basis at log times `x` for knots `knots` (boundary knots first and last): columns 1, x, v_1 ... v_k.
vcr_rp_basis <- function(x, knots) {
  kmin <- knots[1L]; kmax <- knots[length(knots)]; inner <- knots[-c(1L, length(knots))]
  cols <- list(rep(1, length(x)), x)
  for (kj in inner) {
    lam <- (kmax - kj) / (kmax - kmin)
    cols[[length(cols) + 1L]] <- pmax(x - kj, 0)^3 - lam * pmax(x - kmin, 0)^3 - (1 - lam) * pmax(x - kmax, 0)^3
  }
  do.call(cbind, cols)
}

#' The derivative of the basis with respect to x.
vcr_rp_dbasis <- function(x, knots) {
  kmin <- knots[1L]; kmax <- knots[length(knots)]; inner <- knots[-c(1L, length(knots))]
  cols <- list(rep(0, length(x)), rep(1, length(x)))
  for (kj in inner) {
    lam <- (kmax - kj) / (kmax - kmin)
    cols[[length(cols) + 1L]] <- 3 * pmax(x - kj, 0)^2 - 3 * lam * pmax(x - kmin, 0)^2 - 3 * (1 - lam) * pmax(x - kmax, 0)^2
  }
  do.call(cbind, cols)
}

vcr_fit_survival_baseline <- function(time, status, distribution, horizons) {
  allowed <- c("exponential", "weibull", "lognormal", "loglogistic")
  if (!(distribution %in% allowed) || !is.numeric(time) || !is.numeric(status) ||
      length(time) != length(status) || anyNA(time) || anyNA(status) ||
      any(!is.finite(time)) || any(time <= 0) || any(!(status %in% c(0, 1)))) {
    vcr_abort("scenario_value_invalid", "scenario", "The fit needs positive times, binary event indicators and a supported distribution.")
  }
  if (!length(time) || sum(status) < if (distribution == "exponential") 1L else 2L) return(list(estimable = FALSE, rule = "too_few_events"))
  warned <- FALSE
  fit <- tryCatch(withCallingHandlers(
    survival::survreg(survival::Surv(time, status) ~ 1, dist = distribution),
    warning = function(w) { warned <<- TRUE; invokeRestart("muffleWarning") }), error = function(e) NULL)
  if (is.null(fit) || warned || any(!is.finite(c(fit[["coefficients"]], fit[["scale"]], fit[["var"]]))) || fit[["scale"]] <= 0) {
    return(list(estimable = FALSE, rule = "nuisance_model_not_estimable"))
  }
  mu <- as.numeric(fit[["coefficients"]][[1L]]); sigma <- as.numeric(fit[["scale"]])
  pars <- switch(distribution,
    exponential = list(kind = distribution, rate = exp(-mu)),
    weibull = list(kind = distribution, shape = 1 / sigma, scale = exp(mu)),
    lognormal = list(kind = distribution, meanlog = mu, sdlog = sigma),
    loglogistic = list(kind = distribution, shape = 1 / sigma, scale = exp(mu)))
  median <- as.numeric(survival::qsurvreg(0.5, mean = mu, scale = sigma, distribution = distribution))
  curve <- 1 - survival::psurvreg(horizons, mean = mu, scale = sigma, distribution = distribution)
  if (any(!is.finite(c(unlist(pars[-1L]), median, curve)))) return(list(estimable = FALSE, rule = "nuisance_model_not_estimable"))
  # survreg reports covariance in location and log(scale). This is uncertainty in the fitted median,
  # not percentiles of patient survival times and not digitization/reconstruction uncertainty.
  gradient <- if (distribution == "weibull") c(1, sigma * log(log(2))) else c(1, rep(0, nrow(fit[["var"]]) - 1L))
  se_log_median <- sqrt(max(0, as.numeric(t(gradient) %*% fit[["var"]] %*% gradient)))
  quantiles <- exp(log(median) + stats::qnorm(c(0.1, 0.5, 0.9)) * se_log_median)
  baseline_scenarios <- lapply(seq_along(quantiles), function(i) {
    distribution_at <- pars
    if (distribution == "exponential") distribution_at$rate <- log(2) / quantiles[i]
    if (distribution == "weibull") distribution_at$scale <- quantiles[i] / log(2)^(1 / pars$shape)
    if (distribution == "lognormal") distribution_at$meanlog <- log(quantiles[i])
    if (distribution == "loglogistic") distribution_at$scale <- quantiles[i]
    list(median = as.numeric(quantiles[i]), controlDistribution = distribution_at,
      shapeUncertaintyIncluded = FALSE, scope = "median_parameter_sensitivity_not_assurance")
  })
  names(baseline_scenarios) <- c("p10", "p50", "p90")
  list(estimable = TRUE, distribution = pars, baselineParameterScenarios = baseline_scenarios, location = mu, aftScale = sigma,
       covariance = unname(fit[["var"]]), logLikelihood = as.numeric(stats::logLik(fit)), aic = as.numeric(stats::AIC(fit)),
       median = median, medianParameterQuantiles = as.list(stats::setNames(quantiles, c("p10", "p50", "p90"))),
       medianParameterQuantileBasis = "delta_method_log_median_asymptotic_normal",
       curve = lapply(seq_along(horizons), function(i) list(time = horizons[i], survival = as.numeric(curve[i]),
         risk = as.numeric(1 - curve[i]), extrapolated = horizons[i] > max(time))), maxObservedTime = max(time))
}

#' The knots: the smallest and largest uncensored log time, and `k` interior ones at the equally spaced type-7 quantiles between them.
.vcr_rp_knots <- function(time, status, k) {
  x <- log(time[status == 1])
  if (k == 0L) return(c(min(x), max(x)))
  as.numeric(stats::quantile(x, seq(0, 1, length.out = k + 2L)))
}

#' One Royston-Parmar fit on the log cumulative hazard: NULL when the data cannot carry it, else the coefficients, their covariance and the
#' maximised log likelihood. `optim` (BFGS, analytic gradient) from the Weibull fit, then Newton steps with the analytic Hessian.
.vcr_rp_fit <- function(time, status, k) {
  x <- log(time); ev <- status == 1
  knots <- .vcr_rp_knots(time, status, k)
  if (!(knots[length(knots)] > knots[1L])) return(NULL)
  B <- vcr_rp_basis(x, knots); D <- vcr_rp_dbasis(x, knots); p <- ncol(B)
  Be <- B[ev, , drop = FALSE]; De <- D[ev, , drop = FALSE]; xe <- sum(x[ev])
  parts <- function(g) { s <- drop(B %*% g); ds <- drop(De %*% g); list(s = s, ds = ds, es = exp(s)) }
  nll <- function(g) { q <- parts(g); if (any(!is.finite(q$es)) || any(q$ds <= 1e-10)) return(1e12); -(sum(q$s[ev]) + sum(log(q$ds)) - xe - sum(q$es)) }
  grd <- function(g) { q <- parts(g); -(colSums(Be) + colSums(De / q$ds) - colSums(q$es * B)) }
  hes <- function(g) { q <- parts(g); crossprod(De / q$ds) + crossprod(B * sqrt(q$es)) }
  weib <- tryCatch(survival::survreg(survival::Surv(time, status) ~ 1, dist = "weibull"), error = function(e) NULL)
  g0 <- numeric(p)
  if (!is.null(weib)) { sh <- 1 / weib$scale; g0[1:2] <- c(-as.numeric(weib$coefficients[[1L]]) * sh, sh) } else g0[1:2] <- c(-log(mean(time)), 1)
  if (!is.finite(nll(g0))) return(NULL)
  g <- tryCatch(stats::optim(g0, nll, grd, method = "BFGS", control = list(maxit = 1000L, reltol = 1e-14))$par, error = function(e) NULL)
  if (is.null(g) || !is.finite(nll(g))) return(NULL)
  for (it in 1:15) {
    gr <- grd(g); if (max(abs(gr)) < 1e-9) break
    step <- tryCatch(solve(hes(g), gr), error = function(e) NULL); if (is.null(step)) break
    # Newton on the gradient: the full step when it shrinks the gradient inside the feasible region, else half of it (near the maximum the
    # likelihood itself changes by less than rounding, so it cannot be the judge)
    t <- 1; norm0 <- max(abs(gr))
    while (t > 1e-6 && !(nll(g - t * step) < 1e11 && max(abs(grd(g - t * step))) < norm0)) t <- t / 2
    if (t <= 1e-6) break
    g <- g - t * step
  }
  if (max(abs(grd(g))) > 1e-5) return(NULL)
  V <- tryCatch(solve(hes(g)), error = function(e) NULL)
  if (is.null(V) || any(!is.finite(V)) || any(diag(V) <= 0)) return(NULL)
  grid <- seq(knots[1L], knots[length(knots)], length.out = 400L)
  if (any(drop(vcr_rp_dbasis(grid, knots) %*% g) <= 0)) return(NULL)
  list(gamma = g, vcov = V, knots = knots, k = k, loglik = -nll(g), p = p)
}

#' log H, S, and their quantities at times `t` for a fit; the delta method error of log H is sqrt(B V B^T).
.vcr_rp_survival <- function(fit, t, level = 0.95) {
  Bt <- vcr_rp_basis(log(t), fit$knots)
  s <- drop(Bt %*% fit$gamma); se <- sqrt(rowSums((Bt %*% fit$vcov) * Bt)); z <- stats::qnorm(1 - (1 - level) / 2)
  list(survival = exp(-exp(s)), lower = exp(-exp(s + z * se)), upper = exp(-exp(s - z * se)), logCumulativeHazard = s, se = se)
}

#' The restricted mean survival time to `tau` and its delta-method error: the integral of S, and of -S H B(log t) for the gradient.
.vcr_rp_rmst <- function(fit, tau, level = 0.95) {
  S <- function(t) exp(-exp(drop(vcr_rp_basis(log(t), fit$knots) %*% fit$gamma)))
  value <- stats::integrate(function(t) S(t), 0, tau, rel.tol = 1e-10, subdivisions = 500L)$value
  grad <- vapply(seq_len(fit$p), function(j) -stats::integrate(function(t) {
    B <- vcr_rp_basis(log(t), fit$knots); s <- drop(B %*% fit$gamma); exp(-exp(s)) * exp(s) * B[, j]
  }, 0, tau, rel.tol = 1e-9, subdivisions = 500L)$value, numeric(1))
  se <- sqrt(max(0, as.numeric(t(grad) %*% fit$vcov %*% grad))); z <- stats::qnorm(1 - (1 - level) / 2)
  list(value = value, se = se, lower = max(0, value - z * se), upper = min(tau, value + z * se))
}

#' The median (the time at which log H = log log 2) and its interval by the delta method on log time.
.vcr_rp_median <- function(fit, level = 0.95) {
  target <- log(log(2)); kmin <- fit$knots[1L]; kmax <- fit$knots[length(fit$knots)]
  s_at <- function(x) drop(vcr_rp_basis(x, fit$knots) %*% fit$gamma); d_at <- function(x) drop(vcr_rp_dbasis(x, fit$knots) %*% fit$gamma)
  hi <- kmax + max(0, (target - s_at(kmax)) / d_at(kmax)) + 1; lo <- kmin - max(0, (s_at(kmin) - target) / d_at(kmin)) - 1
  x <- stats::uniroot(function(u) s_at(u) - target, c(lo, hi), tol = 1e-13)$root
  g <- drop(vcr_rp_basis(x, fit$knots)) / d_at(x)
  se <- sqrt(max(0, as.numeric(t(g) %*% fit$vcov %*% g))); z <- stats::qnorm(1 - (1 - level) / 2)
  list(value = exp(x), lower = exp(x - z * se), upper = exp(x + z * se), logSe = se)
}

#' The Royston-Parmar fit of a population baseline (the `spline` family of `model.survival_fit`): same inputs and refusals as the parametric
#' families, the number of interior knots `k` (0 is a Weibull), the median, the survival at each horizon and the restricted mean to the last
#' horizon, each with its delta-method interval; how far beyond the longest follow-up each horizon lies; and the same quantities for 0 to 3 knots,
#' which is the model-form uncertainty of an extrapolation.
vcr_fit_survival_spline <- function(time, status, k, horizons) {
  if (!is.numeric(time) || !is.numeric(status) || length(time) != length(status) || anyNA(c(time, status)) || any(!is.finite(time)) ||
      any(time <= 0) || any(!(status %in% c(0, 1))) || !(k %in% 0:4)) {
    vcr_abort("scenario_value_invalid", "scenario", "The fit needs positive times, binary event indicators and 0 to 4 interior knots.")
  }
  events <- sum(status)
  if (events < 5L * (k + 2L)) return(list(estimable = FALSE, rule = "too_few_events"))
  fit <- .vcr_rp_fit(time, status, k)
  if (is.null(fit)) return(list(estimable = FALSE, rule = "nuisance_model_not_estimable"))
  tau <- max(horizons); max_obs <- max(time); max_event <- max(time[status == 1])
  med <- tryCatch(.vcr_rp_median(fit), error = function(e) NULL)
  at <- .vcr_rp_survival(fit, horizons)
  if (is.null(med) || any(!is.finite(c(at$survival, med$value)))) return(list(estimable = FALSE, rule = "nuisance_model_not_estimable"))
  rm_last <- .vcr_rp_rmst(fit, tau)
  curve <- lapply(seq_along(horizons), function(i) list(time = horizons[i], survival = as.numeric(at$survival[i]), lower = as.numeric(at$lower[i]), upper = as.numeric(at$upper[i]),
    risk = as.numeric(1 - at$survival[i]), extrapolated = horizons[i] > max_obs, timesLongestFollowUp = horizons[i] / max_obs))
  aic <- -2 * fit$loglik + 2 * fit$p
  specs <- lapply(0:3, function(kk) {
    f <- if (kk == k) fit else if (events >= 5L * (kk + 2L)) .vcr_rp_fit(time, status, kk) else NULL
    if (is.null(f)) return(list(knots = kk, estimable = FALSE, selected = kk == k))
    m <- tryCatch(.vcr_rp_median(f)$value, error = function(e) NA_real_)
    list(knots = kk, estimable = TRUE, selected = kk == k, aic = -2 * f$loglik + 2 * f$p, median = m,
         rmst = .vcr_rp_rmst(f, tau)$value, survival = as.numeric(.vcr_rp_survival(f, tau)$survival))
  })
  list(estimable = TRUE,
       distribution = list(kind = "spline", scale = "hazard", knots = k), spline = list(
         gamma = as.numeric(fit$gamma), knotPositions = as.numeric(fit$knots), knotTimes = exp(as.numeric(fit$knots)), covariance = unname(fit$vcov)),
       logLikelihood = fit$loglik, aic = aic, median = med$value, medianInterval = list(lower = med$lower, upper = med$upper),
       rmst = list(tau = tau, value = rm_last$value, lower = rm_last$lower, upper = rm_last$upper),
       curve = curve, maxObservedTime = max_obs, maxEventTime = max_event, specifications = specs,
       extrapolation = list(lastHorizon = tau, longestFollowUp = max_obs, lastEvent = max_event, beyondData = tau > max_obs, timesLongestFollowUp = tau / max_obs,
         tail = "straight in log time on the log cumulative hazard beyond the last knot (a Weibull tail)"))
}

vcr_job_fit_survival_model <- function(job, output_dir = NULL, ...) {
  sc <- job[["scenario"]]
  input <- vcr_input_by_id(job, as.character(sc[["inputId"]]))
  if (is.null(input)) vcr_abort("scenario_value_invalid", "scenario.inputId", "Select one frozen input table.")
  data <- vcr_read_table_input(input)
  vcr_require_individual(data, "Survival baseline fitting", "model.survival_fit")
  source <- vcr_table_source(data)
  used <- vcr_used_sources(list(list(df = data, columns = unique(c(sc[["timeColumn"]], sc[["statusColumn"]], sc[["armColumn"]], sc[["parameterColumn"]])))))
  estimate_source <- vcr_estimate_source(used[["source"]])
  original_n <- nrow(data)
  require_column <- function(name) {
    if (is.null(name) || !(name %in% names(data))) vcr_abort("scenario_value_invalid", "scenario", "A named model column is absent from the input.")
  }
  for (name in c(sc[["timeColumn"]], sc[["statusColumn"]])) require_column(name)
  if (!is.null(sc[["armColumn"]])) { require_column(sc[["armColumn"]]); data <- data[!is.na(data[[sc[["armColumn"]]]]) & as.character(data[[sc[["armColumn"]]]]) == as.character(sc[["armValue"]]), , drop = FALSE] }
  if (!is.null(sc[["parameterColumn"]])) { require_column(sc[["parameterColumn"]]); data <- data[!is.na(data[[sc[["parameterColumn"]]]]) & as.character(data[[sc[["parameterColumn"]]]]) == as.character(sc[["parameterValue"]]), , drop = FALSE] }
  id_col <- sc[["idColumn"]] %||% "USUBJID"
  if (source != "reconstructed") {
    require_column(id_col)
    ids <- as.character(data[[id_col]])
    if (anyNA(ids) || any(!nzchar(ids)) || anyDuplicated(ids)) vcr_abort("scenario_value_invalid", "scenario.idColumn", "Observed fitting data needs exactly one selected endpoint row per person.")
  }
  times <- data[[sc[["timeColumn"]]]]; status <- data[[sc[["statusColumn"]]]]
  if (!is.numeric(status)) vcr_abort("scenario_value_invalid", "scenario.statusColumn", "Event/censor values must be numeric zero or one.")
  if (identical(sc[["statusEncoding"]], "censor")) status <- 1 - status
  spline <- identical(as.character(sc[["distribution"]]), "spline")
  result <- if (spline) vcr_fit_survival_spline(times, status, as.integer(sc[["knots"]] %||% 2L), vcr_num(sc[["horizons"]]))
            else vcr_fit_survival_baseline(times, status, as.character(sc[["distribution"]]), vcr_num(sc[["horizons"]]))
  attr(data, "vcrSource") <- source
  counts <- vcr_table_counts(data, if (is.numeric(status)) sum(status) else NULL)
  if (!result[["estimable"]]) return(list(status = "succeeded", conclusion = "not_estimable", notEstimableRule = result[["rule"]],
    counts = counts, measures = list(), diagnostics = list(inputRows = original_n, fittedRows = nrow(data), source = source)))
  interval_of <- function(lower, upper) vcr_interval("confidence", lower, upper)
  last_point <- if (spline) result[["curve"]][[length(result[["curve"]])]] else NULL
  list(status = "succeeded", conclusion = "limited", counts = counts,
    measures = c(list(vcr_measure("fitted_median", result[["median"]], source = estimate_source, unit = sc[["timeUnit"]],
                                  interval = if (spline) interval_of(result[["medianInterval"]]$lower, result[["medianInterval"]]$upper) else NULL),
      vcr_measure("aic", result[["aic"]], source = estimate_source)),
      if (spline) list(
        vcr_measure("restricted_mean_survival_time", result[["rmst"]]$value, source = estimate_source, unit = sc[["timeUnit"]], interval = interval_of(result[["rmst"]]$lower, result[["rmst"]]$upper)),
        vcr_measure("survival_at_last_horizon", last_point$survival, source = estimate_source, interval = interval_of(last_point$lower, last_point$upper)))),
    diagnostics = list(model = result, valueSourcesUsed = vcr_value_sources_used(used), inputRows = original_n, fittedRows = nrow(data), source = source,
      sourceCondition = sc[["sourceCondition"]] %||% "unspecified",
      armSelection = if (is.null(sc[["armColumn"]])) NULL else list(column = sc[["armColumn"]], value = sc[["armValue"]]),
      modelScope = "population_baseline", fitted = TRUE, clinicallyValidated = FALSE, causalEffectIdentified = FALSE,
      uncertainty = if (source == "reconstructed") "Conditional on reconstructed pseudo-IPD; digitization and reconstruction uncertainty excluded." else "Asymptotic fit uncertainty; transportability and model-form uncertainty excluded.",
      timeUnit = sc[["timeUnit"]]))
}
