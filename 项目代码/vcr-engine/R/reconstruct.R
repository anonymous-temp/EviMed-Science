# ---------------------------------------------------------------------------
# reconstruct.R — Guyot's algorithm for pseudo-individual data from a
# published Kaplan-Meier curve, with the quality control that decides whether
# the result may be used at all (plan 5.3, 6.2; AC-27, N16, N17).
#
# Hidden knowledge:
#
# - **The algorithm is an iteration, not a formula.** Guyot inverts the KM
#   equations click by click, but the number censored inside an interval is
#   not observable, so it is guessed, spread uniformly, and then corrected
#   until the implied number at risk at the start of the next interval equals
#   the published one. Implementations that skip the correction loop
#   reproduce the curve and get the risk table wrong, which is precisely the
#   thing the QC below checks.
# - **Rounding is load-bearing.** `d[k] <- round(n.hat[k] * (1 - S[k]/KM.hat[last]))`
#   must round, not floor and not truncate: events are integers, and the
#   `last` index must only advance when an event actually occurred, otherwise
#   a run of flat clicks slowly deflates the curve. This is the part of the
#   published appendix that looks like a typo and is not.
# - **No risk table means a low-confidence reconstruction.** With only the
#   curve, censoring is unidentified; Guyot's own validation shows the hazard
#   ratio is only recovered well when at-risk numbers or the total event count
#   are available. We still reconstruct, we label it, and the QC cannot pass
#   the at-risk check it has no numbers for.
# - **The output is `reconstructed`, never `observed`.** The count goes into
#   `reconstructedPseudoPatients`, never into `realPatients`, and nothing
#   downstream may draw it as a measured curve (AC-27, N17). That is enforced
#   by the count keys, not by a convention.
# - **Curve coordinates never come from a language model.** The engine accepts
#   digitized points as data; who produced them is the caller's business and
#   the provenance travels with them, but a "read the chart" path into this
#   function does not exist (attachment C1, conclusion 5: 0.087 RMSE for
#   direct chart reading versus 0.014 for a digitizer).
# ---------------------------------------------------------------------------

#' Reconstruct pseudo-individual data from digitized survival coordinates.
#'
#' @param t digitized times, non-decreasing.
#' @param S digitized survival probabilities at those times, non-increasing.
#' @param t_risk risk-table times (the first must be the curve's start).
#' @param n_risk numbers at risk at those times.
#' @param total_events optional reported total number of events.
#' @return list(ipd = data.frame(time, status), nRisk, converged, ...)
vcr_guyot <- function(t, S, t_risk, n_risk, total_events = NA_real_) {
  stopifnot(length(t) == length(S), length(t_risk) == length(n_risk))
  if (is.unsorted(t)) stop("vcr_guyot: digitized times must be non-decreasing")
  S <- pmin(pmax(S, 0), 1)
  S <- cummin(S)

  n_int <- length(t_risk)
  # lower[i] / upper[i]: the digitized points that belong to risk interval i.
  lower <- integer(n_int); upper <- integer(n_int)
  for (i in seq_len(n_int)) {
    lo <- which(t >= t_risk[i])
    lower[i] <- if (length(lo)) min(lo) else length(t)
  }
  for (i in seq_len(n_int - 1L)) upper[i] <- max(lower[i], lower[i + 1L] - 1L)
  upper[n_int] <- length(t)
  n_t <- upper[n_int]

  n_risk <- as.numeric(n_risk)
  n_risk_start <- n_risk[1]
  n_censor <- numeric(n_int)
  n_hat <- rep(n_risk[1] + 1, n_t + 1L)
  cen <- numeric(n_t); d <- numeric(n_t); km_hat <- rep(1, n_t)
  last_i <- rep(1L, n_int)
  sumdL <- 0

  spread_censor <- function(count, from, to, breaks) {
    # `count` censorings spread evenly on (from, to), binned by the digitized
    # click times exactly as Guyot's `hist(..., breaks = t[...])` does.
    if (count <= 0 || length(breaks) < 2L) return(numeric(max(length(breaks) - 1L, 0L)))
    ct <- from + seq_len(count) * (to - from) / (count + 1)
    bins <- .bincode(ct, breaks, right = TRUE, include.lowest = TRUE)
    tabulate(bins, nbins = length(breaks) - 1L)
  }

  if (n_int > 1L) {
    for (i in seq_len(n_int - 1L)) {
      n_censor[i] <- round(n_risk[i] * S[lower[i + 1L]] / S[lower[i]] - n_risk[i + 1L])
      guard <- 0L
      repeat {
        guard <- guard + 1L
        if (n_censor[i] <= 0) { cen[lower[i]:upper[i]] <- 0; n_censor[i] <- 0 }
        if (n_censor[i] > 0) {
          breaks <- t[lower[i]:lower[i + 1L]]
          counts <- spread_censor(n_censor[i], t[lower[i]], t[lower[i + 1L]], breaks)
          cen[lower[i]:upper[i]] <- counts[seq_len(upper[i] - lower[i] + 1L)]
        }
        n_hat[lower[i]] <- n_risk[i]
        last <- last_i[i]
        for (k in lower[i]:upper[i]) {
          if (i == 1L && k == lower[i]) { d[k] <- 0; km_hat[k] <- 1 }
          else {
            d[k] <- if (km_hat[last] > 0) round(n_hat[k] * (1 - (S[k] / km_hat[last]))) else 0
            km_hat[k] <- if (n_hat[k] > 0) km_hat[last] * (1 - (d[k] / n_hat[k])) else 0
          }
          n_hat[k + 1L] <- n_hat[k] - d[k] - cen[k]
          if (d[k] != 0) last <- k
        }
        gap <- n_hat[lower[i + 1L]] - n_risk[i + 1L]
        n_censor[i] <- n_censor[i] + gap
        done <- !((n_hat[lower[i + 1L]] > n_risk[i + 1L]) ||
                  (n_hat[lower[i + 1L]] < n_risk[i + 1L] && n_censor[i] > 0))
        if (done || guard > 1000L) break
      }
      n_risk[i + 1L] <- n_hat[lower[i + 1L]]
      last_i[i + 1L] <- last
    }
  }

  # The final interval: assume the average censoring rate of the earlier ones.
  if (n_int > 1L) {
    span_last <- t[upper[n_int]] - t[lower[n_int]]
    span_all <- t[upper[n_int - 1L]] - t[lower[1]]
    n_censor[n_int] <- min(round(sum(n_censor[seq_len(n_int - 1L)]) *
                                   (if (span_all > 0) span_last / span_all else 0)), n_risk[n_int])
  } else {
    n_censor[n_int] <- 0
  }
  apply_last <- function() {
    if (n_censor[n_int] <= 0) {
      if (upper[n_int] > lower[n_int]) cen[lower[n_int]:(upper[n_int] - 1L)] <<- 0
      n_censor[n_int] <<- 0
    }
    if (n_censor[n_int] > 0 && upper[n_int] > lower[n_int]) {
      breaks <- t[lower[n_int]:upper[n_int]]
      counts <- spread_censor(n_censor[n_int], t[lower[n_int]], t[upper[n_int]], breaks)
      cen[lower[n_int]:(upper[n_int] - 1L)] <<- counts
    }
    n_hat[lower[n_int]] <<- n_risk[n_int]
    last <- last_i[n_int]
    for (k in lower[n_int]:upper[n_int]) {
      d[k] <<- if (km_hat[last] > 0) round(n_hat[k] * (1 - (S[k] / km_hat[last]))) else 0
      km_hat[k] <<- if (n_hat[k] > 0) km_hat[last] * (1 - (d[k] / n_hat[k])) else 0
      if (k != upper[n_int] || TRUE) {
        n_hat[k + 1L] <<- n_hat[k] - d[k] - cen[k]
        if (n_hat[k + 1L] < 0) { n_hat[k + 1L] <<- 0; cen[k] <<- max(n_hat[k] - d[k], 0) }
      }
      if (d[k] != 0) last <- k
    }
  }
  apply_last()

  if (!is.na(total_events)) {
    if (n_int > 1L) sumdL <- sum(d[seq_len(upper[n_int - 1L])])
    if (n_int > 1L && sumdL >= total_events) {
      d[lower[n_int]:upper[n_int]] <- 0
      if (upper[n_int] > lower[n_int]) cen[lower[n_int]:(upper[n_int] - 1L)] <- 0
      n_hat[(lower[n_int] + 1L):(upper[n_int] + 1L)] <- n_risk[n_int]
    } else {
      guard <- 0L
      repeat {
        guard <- guard + 1L
        sumd <- sum(d[seq_len(upper[n_int])])
        if (!((sumd > total_events) || (sumd < total_events && n_censor[n_int] > 0)) || guard > 1000L) break
        n_censor[n_int] <- n_censor[n_int] + (sumd - total_events)
        apply_last()
      }
    }
  }

  # Assemble the pseudo-IPD. Every subject at risk at time zero gets a row:
  # events at the click time they occurred on, censorings at the midpoint of
  # the click interval they fell in, and whoever is left over is censored at
  # the last digitized time. That last group is easy to forget and is the
  # difference between reproducing the risk table and losing the tail of the
  # cohort -- with the leftovers dropped, the reconstructed numbers at risk
  # are uniformly short and the hazard ratio drifts toward the null.
  n0 <- as.integer(n_risk_start)
  ipd_time <- rep(t[n_t], n0)
  ipd_status <- rep(0L, n0)
  k <- 1L
  for (j in seq_len(n_t)) {
    if (d[j] > 0) {
      idx <- k:(k + d[j] - 1L)
      idx <- idx[idx <= n0]
      if (length(idx)) { ipd_time[idx] <- t[j]; ipd_status[idx] <- 1L }
      k <- k + d[j]
    }
  }
  if (n_t > 1L) for (j in seq_len(n_t - 1L)) {
    if (cen[j] > 0) {
      idx <- k:(k + cen[j] - 1L)
      idx <- idx[idx <= n0]
      if (length(idx)) { ipd_time[idx] <- (t[j] + t[j + 1L]) / 2; ipd_status[idx] <- 0L }
      k <- k + cen[j]
    }
  }
  ipd <- data.frame(time = ipd_time, status = ipd_status)
  ipd <- ipd[order(ipd$time, -ipd$status), , drop = FALSE]
  rownames(ipd) <- NULL
  list(ipd = ipd, events = d, censored = cen, nHat = n_hat,
       kmHat = km_hat, lower = lower, upper = upper,
       reconstructedPseudoPatients = nrow(ipd),
       totalEvents = sum(d[seq_len(n_t)]))
}

#' Quality control for a reconstruction (plan 5.3 tolerances).
#'
#' Tolerances: numbers at risk within max(2, 5%), total events within 5%,
#' median within 5%, |log HR - reported log HR| <= 0.05. A reconstruction that
#' fails is `reconstruction_failed_qc` and may not enter an analysis (AC-27).
vcr_reconstruction_qc <- function(recon, t_risk, n_risk_reported,
                                  total_events_reported = NA_real_,
                                  median_reported = NA_real_,
                                  log_hr_reported = NA_real_, log_hr_recon = NA_real_,
                                  tolerance = list()) {
  tol <- utils::modifyList(list(atRiskAbsolute = 2, atRiskRelative = 0.05,
                                events = 0.05, median = 0.05, logHazardRatio = 0.05), tolerance)
  ipd <- recon$ipd
  at_risk <- vapply(t_risk, function(tt) sum(ipd$time >= tt), numeric(1))
  at_risk_diff <- abs(at_risk - n_risk_reported)
  at_risk_allow <- pmax(tol$atRiskAbsolute, tol$atRiskRelative * n_risk_reported)
  checks <- list()
  checks$atRisk <- list(name = "numbers at risk", reported = as.numeric(n_risk_reported),
                        reconstructed = at_risk, allowed = at_risk_allow,
                        pass = all(at_risk_diff <= at_risk_allow + 1e-9))
  events <- sum(ipd$status)
  if (!is.na(total_events_reported)) {
    checks$events <- list(name = "total events", reported = total_events_reported,
                          reconstructed = events,
                          pass = abs(events - total_events_reported) <=
                            tol$events * max(total_events_reported, 1))
  }
  km <- vcr_km(ipd$time, ipd$status)
  med <- vcr_km_median(km)
  if (!is.na(median_reported)) {
    checks$median <- list(name = "median survival", reported = median_reported,
                          reconstructed = med,
                          pass = is.finite(med) &&
                            abs(med - median_reported) <= tol$median * median_reported)
  }
  if (!is.na(log_hr_reported) && !is.na(log_hr_recon)) {
    checks$logHazardRatio <- list(name = "log hazard ratio", reported = log_hr_reported,
                                  reconstructed = log_hr_recon,
                                  pass = abs(log_hr_recon - log_hr_reported) <= tol$logHazardRatio)
  }
  passed <- all(vapply(checks, function(c) isTRUE(c$pass), logical(1)))
  list(
    pass = passed,
    checks = checks,
    medianReconstructed = med,
    eventsReconstructed = events,
    reconstructedPseudoPatients = nrow(ipd),
    rule = if (passed) NULL else "reconstruction_failed_qc",
    detail = if (passed) NULL else paste(
      vapply(checks[!vapply(checks, function(c) isTRUE(c$pass), logical(1))],
             function(c) c$name, character(1)), collapse = "; ")
  )
}

#' Median from a KM fit; `Inf` when the curve never reaches 0.5.
vcr_km_median <- function(km) {
  idx <- which(km$surv <= 0.5)
  if (!length(idx)) return(Inf)
  km$time[min(idx)]
}

#' Digitize a known survival function into the coordinate list the
#' reconstruction consumes. Used by the round-trip case (N16) to stand in for
#' a real digitizer, including its pixel error.
vcr_digitize_km <- function(km, times, noise = 0) {
  s <- vcr_km_at(km, times)
  if (noise > 0) s <- pmin(pmax(s + stats::rnorm(length(s), 0, noise), 0), 1)
  data.frame(time = times, surv = cummin(s))
}

`%||%` <- function(a, b) if (is.null(a)) b else a
