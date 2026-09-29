# ---------------------------------------------------------------------------
# summaries.R — the small summaries a page draws its charts from.
#
# Hidden knowledge:
#
# - **The page draws only what the result carries.** The control plane's presenter
#   reads a chart from `diagnostics.{curves, trajectories, powerCurve, sensitivity,
#   panels, balance, weights, support}` and from nowhere else: it never opens a
#   result table, because a table can be a whole population and the browser is the
#   wrong place to summarise one. So the handlers that a page charts write a small
#   summary of their own output here, and the full table stays a CSV.
# - **Bounded, always.** A series is at most `VCR_SUMMARY_MAX_POINTS` points
#   (200): a Kaplan-Meier curve of 40,000 patients has as many steps as events,
#   and a summary that grows with the data is a second copy of it. Thinning keeps
#   the first and the last point and spaces the rest evenly, so a curve keeps its
#   shape and its end.
# - **A series says where its numbers came from** (the nine value sources). A
#   curve rebuilt from a published figure is `reconstructed`, a weighted one is
#   `calculated`, one drawn from the rows of an observed table carries the
#   table's own source — the page styles by it, and a reconstructed curve is
#   never drawn as an observed one (plan §3.5).
# - **Nothing here is a number the result did not compute.** Every value in a
#   summary is a function of the handler's own arrays; a summary cannot add a
#   measure, and `outputHash` does not cover it (it is presentation, like a
#   plot).
# ---------------------------------------------------------------------------

VCR_SUMMARY_MAX_POINTS <- 200L

#' Indices that thin `n` points to at most `max`, keeping the first and the last.
.vcr_thin_index <- function(n, max = VCR_SUMMARY_MAX_POINTS) {
  if (n <= max) return(seq_len(n))
  unique(round(seq(1, n, length.out = max)))
}

#' A list of `{ x, y[, low, high] }` points from parallel vectors: non-finite x
#' or y dropped, thinned to the bound.
vcr_points <- function(x, y, low = NULL, high = NULL, max = VCR_SUMMARY_MAX_POINTS) {
  keep <- which(is.finite(x) & is.finite(y))
  keep <- keep[.vcr_thin_index(length(keep), max)]
  lapply(keep, function(i) {
    p <- list(x = unname(x[i]), y = unname(y[i]))
    if (!is.null(low) && is.finite(low[i])) p$low <- unname(low[i])
    if (!is.null(high) && is.finite(high[i])) p$high <- unname(high[i])
    p
  })
}

#' One chart series in the shape the presenter reads (`seriesView`).
vcr_series <- function(key, label, x, y, source, ours = FALSE, low = NULL, high = NULL, at_risk = NULL,
                       dashed = FALSE, pooled = FALSE, band_kind = NULL, band_level = NULL) {
  s <- list(key = key, label = label, source = source, ours = ours, pooled = pooled, dashed = dashed,
            points = vcr_points(x, y, low, high))
  if (!is.null(band_kind)) s$bandKind <- band_kind
  if (!is.null(band_level)) s$bandLevel <- band_level
  if (!is.null(at_risk) && length(at_risk$x)) {
    s$atRisk <- lapply(seq_along(at_risk$x), function(i) list(x = at_risk$x[i], n = at_risk$n[i]))
  }
  s
}

#' A Kaplan-Meier series (optionally weighted, optionally cut at `tau`), with
#' the numbers at risk at up to six evenly spaced times.
vcr_km_series <- function(time, status, weights = NULL, key, label, source, ours = FALSE, tau = NULL, dashed = FALSE) {
  ok <- is.finite(time) & !is.na(status)
  time <- time[ok]; status <- status[ok]; w <- if (is.null(weights)) NULL else weights[ok]
  if (!length(time)) return(NULL)
  km <- vcr_km(time, status, w)
  x <- c(0, km$time); y <- c(1, km$surv)
  horizon <- if (is.null(tau)) max(time) else tau
  if (!is.null(tau)) {
    keep <- x <= tau
    x <- c(x[keep], tau); y <- c(y[keep], vcr_km_at(km, tau))
  }
  ww <- if (is.null(w)) rep(1, length(time)) else w
  grid <- unique(round(seq(0, horizon, length.out = 6), 6))
  at_risk <- list(x = grid, n = vapply(grid, function(t) round(sum(ww[time >= t]), 1), numeric(1)))
  vcr_series(key, label, x, y, source, ours = ours, at_risk = at_risk, dashed = dashed)
}

#' Curves for a comparison of two arms: the treated arm, the control arm as
#' collected and, when weights are given, the control arm as weighted.
vcr_arm_curves <- function(time, status, arm, weights = NULL, source, tau = NULL, labels = c(treated = "试验组", control = "对照组")) {
  out <- list()
  add <- function(s) if (!is.null(s)) out[[length(out) + 1L]] <<- s
  add(vcr_km_series(time[arm == 1L], status[arm == 1L], NULL, "treated", labels[["treated"]], source, ours = TRUE, tau = tau))
  add(vcr_km_series(time[arm == 0L], status[arm == 0L], NULL, "control", labels[["control"]], source, tau = tau, dashed = !is.null(weights)))
  if (!is.null(weights)) {
    add(vcr_km_series(time[arm == 0L], status[arm == 0L], weights[arm == 0L], "control_weighted", paste0(labels[["control"]], "（加权）"),
                      "calculated", tau = tau))
  }
  out
}

#' Generated patients by arm: the survival curves of a time-to-event set, and a
#' panel of the two arms' summary numbers for any endpoint. Every number is
#' computed from the generated table, and labelled synthetic.
vcr_patient_summary <- function(d, endpoint) {
  arms <- list(list(key = "treated", label = "试验组", z = 1L), list(key = "control", label = "对照组", z = 0L))
  rows <- list(); series <- list()
  for (a in arms) {
    sub <- d[d$arm == a$z, , drop = FALSE]
    if (!nrow(sub)) next
    if (identical(endpoint, "time_to_event")) {
      km <- vcr_km(sub$time, sub$status)
      med <- vcr_km_median(km)
      s <- vcr_km_series(sub$time, sub$status, NULL, a$key, a$label, "synthetic", ours = a$z == 1L)
      if (!is.null(s)) series[[length(series) + 1L]] <- s
      rows[[length(rows) + 1L]] <- list(label = paste0(a$label, "事件数"), value = list(value = sum(sub$status), unit = "例"))
      if (is.finite(med)) rows[[length(rows) + 1L]] <- list(label = paste0(a$label, "中位生存"), value = list(value = med, unit = "月"))
    } else if (identical(endpoint, "binary")) {
      rows[[length(rows) + 1L]] <- list(label = paste0(a$label, "事件率"), value = list(value = round(100 * mean(sub$y), 2), unit = "%"))
    } else {
      rows[[length(rows) + 1L]] <- list(label = paste0(a$label, "均值"), value = list(value = mean(sub$y)))
      rows[[length(rows) + 1L]] <- list(label = paste0(a$label, "标准差"), value = list(value = stats::sd(sub$y)))
    }
  }
  list(
    trajectories = if (length(series)) list(xLabel = "时间（月）", yLabel = "无事件生存概率", series = series) else NULL,
    panels = list(list(key = "arms", title = "两组的生成结果", kind = if (identical(endpoint, "time_to_event")) "time_to_event" else "binary",
                       note = "情景仿真生成，非观察", rows = rows, series = list()))
  )
}

#' What the two stated parameters that drive a generated set do to its
#' headline number if each is 20% off: a one-at-a-time table, closed form under
#' the exponential reference. Empty when the endpoint or the distribution has no
#' closed form to vary.
vcr_patient_sensitivity <- function(endpoint, truth) {
  wiggle <- c(0.8, 1.2)
  if (identical(endpoint, "time_to_event") && is.null(truth$controlDistribution)) {
    med <- vcr_scalar(truth$controlMedian, NULL); hr <- vcr_scalar(truth$hazardRatio, NULL)
    if (is.null(med) || is.null(hr) || !(med > 0) || !(hr > 0)) return(NULL)
    gap <- function(m, h) m / h - m
    base <- gap(med, hr)
    lo_hi <- function(f) { v <- f(wiggle); c(min(v), max(v)) }
    r1 <- lo_hi(function(k) gap(med * k, hr)); r2 <- lo_hi(function(k) gap(med, hr * k))
    return(list(measure = "试验组比对照组多出的中位生存（月）", base = list(value = base),
                rows = list(list(label = "对照组中位生存", range = sprintf("%.3g–%.3g 月", med * 0.8, med * 1.2), low = r1[1], high = r1[2]),
                            list(label = "风险比", range = sprintf("%.3g–%.3g", hr * 0.8, hr * 1.2), low = r2[1], high = r2[2]))))
  }
  if (identical(endpoint, "binary")) {
    p0 <- vcr_scalar(truth$controlRate, NULL)
    p1 <- tryCatch(vcr_binary_treatment_rate(p0, vcr_scalar(truth$treatmentRate, NULL), vcr_scalar(truth$riskDifference, NULL),
                                              vcr_scalar(truth$oddsRatio, NULL)), error = function(e) NULL)
    if (is.null(p0) || is.null(p1)) return(NULL)
    clip <- function(p) pmin(pmax(p, 0), 1)
    rd <- function(a, b) clip(b) - clip(a)
    r1 <- range(rd(p0 * wiggle, p1)); r2 <- range(rd(p0, p1 * wiggle))
    return(list(measure = "两组事件率之差", base = list(value = p1 - p0),
                rows = list(list(label = "对照组事件率", range = sprintf("%.3g–%.3g", p0 * 0.8, p0 * 1.2), low = r1[1], high = r1[2]),
                            list(label = "试验组事件率", range = sprintf("%.3g–%.3g", p1 * 0.8, p1 * 1.2), low = r2[1], high = r2[2]))))
  }
  NULL
}

#' The analytic power of a fixed two-arm design over a grid of true effects,
#' at the stated sample size, as one chart series (`calculated`). The grid is
#' multiples of the stated effect on the scale the design states it (log hazard
#' ratio, difference, treatment rate), from no effect to 1.6 times the stated
#' one, so the curve passes through the stated design and through the null.
#' `NULL` for a design with no closed form here.
vcr_power_curve <- function(scenario, alpha, sided) {
  d <- scenario$design; tr <- scenario$truth; e <- as.character(scenario$endpoint$type %||% "")
  if (!identical(as.character(d$kind %||% "two_arm_fixed"), "two_arm_fixed")) return(NULL)
  n1 <- vcr_scalar(d$nTreat, NULL); n0 <- vcr_scalar(d$nControl, n1)
  if (is.null(n1) || is.null(n0)) return(NULL)
  m <- seq(0, 1.6, by = 0.1)
  if (identical(e, "continuous")) {
    eff <- vcr_scalar(tr$effect, NULL); if (is.null(eff) || eff == 0) return(NULL)
    x <- m * eff
    y <- vapply(x, function(v) vcr_power_means(v, vcr_scalar(tr$sd, 1), n1, n0, alpha, sided), numeric(1))
    return(list(xLabel = "真实效应（均值差）", x = x, y = y))
  }
  if (identical(e, "binary")) {
    p0 <- vcr_scalar(tr$controlRate, NULL)
    p1 <- tryCatch(vcr_binary_treatment_rate(p0, vcr_scalar(tr$treatmentRate, NULL), vcr_scalar(tr$riskDifference, NULL), vcr_scalar(tr$oddsRatio, NULL)),
                   error = function(e) NULL)
    if (is.null(p0) || is.null(p1) || p1 == p0) return(NULL)
    x <- pmin(pmax(p0 + m * (p1 - p0), 1e-6), 1 - 1e-6)
    y <- vapply(x, function(v) vcr_power_proportions(p0, v, n1, n0, alpha, sided), numeric(1))
    return(list(xLabel = "真实效应（试验组事件率）", x = x, y = y))
  }
  if (identical(e, "time_to_event")) {
    hr <- vcr_scalar(tr$hazardRatio, NULL); if (is.null(hr) || !(hr > 0) || hr == 1) return(NULL)
    dist <- tryCatch(vcr_control_distribution(tr), error = function(e) NULL); if (is.null(dist)) return(NULL)
    acc <- scenario$accrual %||% list()
    x <- exp(m * log(hr))
    y <- vapply(x, function(h) tryCatch(vcr_logrank_power(h, dist, n1, n0, vcr_scalar(acc$duration, 0), vcr_scalar(acc$followup, Inf),
                                                         vcr_dropout_hazard(vcr_scalar(acc$dropoutAnnual, 0)), alpha, vcr_scalar(acc$maxFollowup, Inf),
                                                         sided = sided)$power, error = function(e) NA_real_), numeric(1))
    return(list(xLabel = "真实效应（风险比）", x = x, y = y))
  }
  NULL
}

#' The power curve of a scenario as the presenter reads it, with the simulated
#' point beside it when there is one: analytic first, the simulation as the check.
vcr_power_curve_summary <- function(scenario, alpha, sided, simulated = NULL) {
  pc <- vcr_power_curve(scenario, alpha, sided)
  if (is.null(pc)) return(NULL)
  series <- list(vcr_series("analytic", "解析功效", pc$x, pc$y, "calculated"))
  if (!is.null(simulated) && is.finite(simulated$value)) {
    tr <- scenario$truth; e <- as.character(scenario$endpoint$type %||% "")
    at <- if (identical(e, "time_to_event")) vcr_scalar(tr$hazardRatio, NA_real_)
          else if (identical(e, "continuous")) vcr_scalar(tr$effect, NA_real_)
          else tryCatch(vcr_binary_treatment_rate(vcr_scalar(tr$controlRate, NULL), vcr_scalar(tr$treatmentRate, NULL),
                                                   vcr_scalar(tr$riskDifference, NULL), vcr_scalar(tr$oddsRatio, NULL)), error = function(e) NA_real_)
    if (is.finite(at)) {
      hw <- if (is.finite(simulated$mcse)) 1.96 * simulated$mcse else NULL
      series[[length(series) + 1L]] <- vcr_series("simulated", "仿真功效", at, simulated$value, "synthetic", ours = TRUE,
                                                  low = if (is.null(hw)) NULL else simulated$value - hw, high = if (is.null(hw)) NULL else simulated$value + hw,
                                                  band_kind = if (is.null(hw)) NULL else "monte_carlo", band_level = if (is.null(hw)) NULL else 0.95)
    }
  }
  list(xLabel = pc$xLabel, yLabel = "功效", series = series)
}
