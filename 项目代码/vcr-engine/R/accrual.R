# ---------------------------------------------------------------------------
# accrual.R — Poisson-gamma recruitment forecasting (Anisimov & Fedorov 2007;
# plan 7.2).
#
# Hidden knowledge:
#
# - **The closed form exists and is worth having.** With N sites all open from
#   time zero and per-site rates lambda_i ~ Gamma(shape = alpha, rate = beta),
#   the time to the n-th enrolment is beta * BetaPrime(n, N*alpha), i.e.
#   T_n = beta * (n / (N*alpha)) * F(2n, 2*N*alpha). Quantiles therefore come
#   out of `qf` rather than out of a simulation, which matters because the
#   page wants "probability of finishing before date D" to be stable between
#   page loads.
# - **Staggered site opening has no closed form** and is simulated. The
#   simulation is seeded from the job like everything else, and the closed
#   form is used as its check when all sites happen to open together (this is
#   the pair the numeric case exercises).
# - **`gamma`'s scale/rate confusion is the standard bug here.** We store
#   `beta` as the *rate* (mean per-site rate = alpha / beta), because that is
#   Anisimov & Fedorov's own parameterization and the one in which the
#   parameterization in which the Bayesian update is
#   update is `Gamma(alpha + k, rate = beta + tau)` -- one line, and hard to
#   get wrong. Storing beta as a scale instead inverts both the closed form
#   and the update, and the symptom is a forecast off by a factor of beta^2,
#   which looks like a modelling disagreement rather than a units bug.
# - **A registry cannot supply this prior.** ClinicalTrials.gov has no
#   site-level enrolment and no site activation dates, so "enrolment / (sites
#   x duration)" is biased low: sites open in waves and the enrolment period
#   is shorter than the start-to-completion span. The prior it yields is weak
#   by construction and the module says so rather than pretending otherwise
#   (plan 6.2: an unavailable quantity shows as unavailable, never as 0).
# - **Screen failure dilutes, it does not delay.** Randomizations are a
#   Binomial thinning of screenings, so the *screening* process is the
#   Poisson-gamma one and the randomization target is reached later by the
#   factor 1/(1 - p_sf). Modelling it the other way round understates the
#   variance, because it drops the Beta uncertainty on p_sf.
# ---------------------------------------------------------------------------

#' Poisson-gamma accrual model.
#'
#' @param n_sites number of sites.
#' @param alpha,beta Gamma shape and *rate* of the per-site enrolment rate
#'   (mean rate per site per time unit = alpha / beta).
#' @param start_times site activation times; NULL means all at zero.
vcr_accrual_model <- function(n_sites, alpha, beta, start_times = NULL,
                              screen_failure = NULL) {
  # alpha and beta are scalars (one prior for every site) or one value per site
  # (per-site posteriors); either way there is one pair per site.
  n_sites <- as.integer(n_sites)
  alpha <- rep_len(as.numeric(alpha), n_sites); beta <- rep_len(as.numeric(beta), n_sites)
  st <- if (is.null(start_times)) rep(0, n_sites) else as.numeric(start_times)
  if (length(st) != n_sites) {
    vcr_abort("scenario_value_invalid", "scenario.sites", "Every site has exactly one start time.")
  }
  list(nSites = n_sites, alpha = alpha, beta = beta, startTimes = st,
       meanRatePerSite = mean(alpha / beta), screenFailure = screen_failure)
}

#' Closed-form distribution of the time to the n-th enrolment when every site
#' opens at time zero. Returns quantiles and the probability of finishing by
#' each requested date.
vcr_accrual_closed_form <- function(model, target, probs = c(0.05, 0.25, 0.5, 0.75, 0.95),
                                    by_times = NULL) {
  if (any(model$startTimes != model$startTimes[1])) {
    stop("vcr_accrual_closed_form: sites do not open together; use vcr_accrual_simulate")
  }
  if (length(unique(model$beta)) != 1L) {
    stop("vcr_accrual_closed_form: sites have different rate priors; use vcr_accrual_simulate")
  }
  beta <- model$beta[1]
  shape2 <- sum(model$alpha)
  # Conditional on the total rate Lambda ~ Gamma(N*alpha, rate = beta), the
  # time to the n-th arrival is Gamma(n, rate = Lambda); the ratio of two
  # independent gammas is a beta-prime, so T_n = beta * BetaPrime(n, N*alpha)
  # and BetaPrime(a, b) = (a/b) * F(2a, 2b).
  q <- beta * (target / shape2) * stats::qf(probs, 2 * target, 2 * shape2)
  offset <- model$startTimes[1]
  out <- list(
    quantiles = stats::setNames(offset + q, paste0("p", probs * 100)),
    # E[BetaPrime(n, m)] = n / (m - 1) exists only for m > 1. With N*alpha <= 1
    # the mean is infinite; the closed-form expression would have returned a
    # negative number (CE-14). The quantiles are still perfectly good.
    mean = if (shape2 > 1) offset + beta * target / (shape2 - 1) else NA_real_,
    target = target
  )
  if (!is.null(by_times)) {
    out$probabilityBy <- vapply(by_times, function(tt) {
      x <- (tt - offset) / beta
      if (x <= 0) return(0)
      stats::pf(x * shape2 / target, 2 * target, 2 * shape2)
    }, numeric(1))
    names(out$probabilityBy) <- as.character(by_times)
  }
  out
}

#' Distribution-free standard error of a sample quantile: half the spread of
#' the order statistics one binomial standard deviation either side of the
#' target rank (Maritz-Jarrett in spirit). A simulated quantile without it is a
#' number without an error bar, which the contract does not allow (AC-28).
vcr_quantile_mcse <- function(x, p) {
  x <- sort(x[is.finite(x)]); n <- length(x)
  if (n < 20L) return(NA_real_)
  half <- sqrt(n * p * (1 - p))
  lo <- max(1L, floor(n * p - half)); hi <- min(n, ceiling(n * p + half))
  (x[hi] - x[lo]) / 2
}

#' Simulate accrual with staggered site activation and (optionally) screen
#' failure. Each replicate draws site rates, then inter-arrival times. With
#' `event_target` and `event_hazard`, each enrolled patient also draws an event
#' time (`enrolment + Exp(hazard)`) and the replicate also reports when the
#' `event_target`-th event happens.
vcr_accrual_simulate <- function(model, target, replicates = 20000L, seed = 1L,
                                 cores = 1L, probs = c(0.05, 0.25, 0.5, 0.75, 0.95),
                                 by_times = NULL, randomized_target = FALSE,
                                 event_target = NULL, event_hazard = NULL, batch_size = 500L) {
  bank <- vcr_stream_bank(seed)
  sf <- model$screenFailure
  events <- !is.null(event_target)
  t_end <- numeric(0); t_ev <- numeric(0)
  done <- 0L; interrupted <- NULL
  while (done < replicates) {
    reason <- vcr_interrupt()
    if (!is.null(reason)) { interrupted <- reason; break }
    take <- min(batch_size, replicates - done)
    streams <- bank$take(take)
    out <- vcr_map_streams(streams, function(i) {
      rates <- stats::rgamma(model$nSites, shape = model$alpha, rate = model$beta)
      p_sf <- if (is.null(sf)) 0 else stats::rbeta(1, sf$alpha, sf$beta)
      r <- .vcr_accrual_time(rates, model$startTimes, target, p_sf, randomized_target, return_times = events)
      if (!events) return(c(lpi = r, ev = NA_real_))
      if (!is.finite(r$lpi)) return(c(lpi = Inf, ev = Inf))
      et <- r$times + stats::rexp(length(r$times), event_hazard)
      c(lpi = r$lpi, ev = sort(et)[event_target])
    }, cores = cores, indices = done + seq_len(take))
    m <- do.call(rbind, lapply(out, function(o) o))
    t_end <- c(t_end, m[, "lpi"]); t_ev <- c(t_ev, m[, "ev"])
    done <- done + take
  }
  ok <- is.finite(t_end)
  res <- list(
    quantiles = stats::quantile(t_end[ok], probs, names = TRUE, type = 7),
    mean = mean(t_end[ok]),
    mcseMean = stats::sd(t_end[ok]) / sqrt(sum(ok)),
    replicates = done, target = target, interrupted = interrupted,
    unreachableShare = 1 - mean(ok)
  )
  if (!is.null(by_times)) {
    res$probabilityBy <- vapply(by_times, function(tt) mean(t_end[ok] <= tt), numeric(1))
    res$probabilityByMcse <- vapply(res$probabilityBy, function(p)
      sqrt(p * (1 - p) / sum(ok)), numeric(1))
    names(res$probabilityBy) <- as.character(by_times)
  }
  res$samples <- t_end
  if (events) res$eventSamples <- t_ev
  res
}

#' Time until `target` enrolments given fixed site rates and start times.
#' Walks forward in "events", which is exact for a superposition of Poisson
#' processes with piecewise-constant total rate. `return_times` also returns
#' every enrolment time (the event-target forecast needs them).
.vcr_accrual_time <- function(rates, start_times, target, p_sf = 0, randomized_target = FALSE,
                              return_times = FALSE) {
  ord <- order(start_times)
  st <- start_times[ord]; rt <- rates[ord]
  n <- 0L; t_now <- st[1]; k <- 1L
  active_rate <- 0
  enrolled <- 0L
  times <- if (return_times) numeric(target) else NULL
  while (enrolled < target) {
    while (k <= length(st) && st[k] <= t_now + 1e-12) { active_rate <- active_rate + rt[k]; k <- k + 1L }
    if (active_rate <= 0) {
      if (k > length(st)) return(if (return_times) list(lpi = Inf, times = times) else Inf)
      t_now <- st[k]; next
    }
    wait <- stats::rexp(1, active_rate)
    t_next_site <- if (k <= length(st)) st[k] else Inf
    if (t_now + wait > t_next_site) { t_now <- t_next_site; next }
    t_now <- t_now + wait
    n <- n + 1L
    # Screening events thin into randomizations.
    got <- if (randomized_target && p_sf > 0) stats::rbinom(1L, 1L, 1 - p_sf) else 1L
    if (got == 1L) {
      enrolled <- enrolled + 1L
      if (return_times) times[enrolled] <- t_now
    }
  }
  if (return_times) list(lpi = t_now, times = times) else t_now
}

#' Bayesian online update: lambda_i | k_i, tau_i ~ Gamma(alpha + k_i,
#' rate = beta + tau_i), where tau_i is how long the site has been open. Returns a per-site posterior and the
#' pooled prior refreshed for sites that have not opened yet.
vcr_accrual_update <- function(model, enrolled, open_time) {
  n <- length(enrolled)
  if (length(open_time) != n) stop("vcr_accrual_update: enrolled and open_time must match")
  shape <- model$alpha + enrolled
  rate <- model$beta + open_time
  list(shape = shape, rate = rate,
       posteriorMeanRate = shape / rate,
       priorMeanRate = model$alpha / model$beta,
       sites = n)
}

#' Forecast from an updated model: simulate the remaining enrolments using the
#' per-site posteriors for open sites and the prior for the rest.
vcr_accrual_forecast <- function(model, update, remaining, as_of = 0,
                                 replicates = 20000L, seed = 1L, cores = 1L,
                                 probs = c(0.05, 0.2, 0.5, 0.8, 0.95), by_times = NULL) {
  bank <- vcr_stream_bank(seed)
  streams <- bank$take(replicates)
  future_starts <- pmax(model$startTimes - as_of, 0)
  out <- vcr_map_streams(streams, function(i) {
    rates <- stats::rgamma(length(update$shape), shape = update$shape, rate = update$rate)
    .vcr_accrual_time(rates, future_starts, remaining, 0, FALSE)
  }, cores = cores)
  t_end <- as_of + vapply(out, function(x) x, numeric(1))
  res <- list(quantiles = stats::quantile(t_end, probs, names = TRUE, type = 7),
              mean = mean(t_end), mcseMean = stats::sd(t_end) / sqrt(replicates),
              replicates = replicates, asOf = as_of, remaining = remaining)
  if (!is.null(by_times)) {
    res$probabilityBy <- vapply(by_times, function(tt) mean(t_end <= tt), numeric(1))
    res$probabilityByMcse <- vapply(res$probabilityBy, function(p) sqrt(p * (1 - p) / replicates), numeric(1))
    names(res$probabilityBy) <- as.character(by_times)
  }
  res$samples <- t_end
  res
}

#' Moment-estimate a weak Poisson-gamma prior from precedent trials.
#' Returns the estimate *and* the reasons it is weak, because the page has to
#' show them (plan 6.2: registries cannot supply site-level rates).
vcr_accrual_prior_from_precedents <- function(enrolment, sites, months) {
  rate <- enrolment / (sites * months)
  m <- mean(rate); v <- stats::var(rate)
  if (!is.finite(v) || v <= 0) v <- m^2
  # Moment estimates for Gamma(shape = alpha, rate = beta): mean = alpha/beta,
  # variance = alpha/beta^2.
  beta <- m / v
  alpha <- m * beta
  list(alpha = alpha, beta = beta, meanRatePerSite = m, varianceRatePerSite = v,
       k = length(rate),
       caveats = c(
         "site_activation_dates_unavailable",
         "site_level_enrolment_unavailable",
         "enrolment_period_shorter_than_start_to_completion"),
       strength = "weak")
}

#' Back-test a forecast against what actually happened: the share of realized
#' completion times inside each nominal prediction interval (AC-37).
vcr_accrual_backtest <- function(forecasts, actual_times, level = 0.8) {
  lo <- vapply(forecasts, function(f) as.numeric(stats::quantile(f$samples, (1 - level) / 2, names = FALSE)), numeric(1))
  hi <- vapply(forecasts, function(f) as.numeric(stats::quantile(f$samples, 1 - (1 - level) / 2, names = FALSE)), numeric(1))
  inside <- actual_times >= lo & actual_times <= hi
  n <- length(inside)
  list(level = level, coverage = mean(inside), n = n,
       mcse = sqrt(mean(inside) * (1 - mean(inside)) / n),
       below = mean(actual_times < lo), above = mean(actual_times > hi),
       intervals = data.frame(low = lo, high = hi, actual = actual_times, inside = inside))
}

`%||%` <- function(a, b) if (is.null(a)) b else a
