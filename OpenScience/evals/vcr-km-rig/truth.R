#!/usr/bin/env Rscript
# truth.R -- the known-truth trials of the Kaplan-Meier rig.
#
# Usage: truth.R <out.json>
#
# Five simulated trials, each of three arms, drawn with the ENGINE's own generator (`vcr_sim_tte`) and summarised with the engine's
# own Kaplan-Meier and Cox code. What a figure shows is the SAMPLE curve, so the sample's curve, median, event count, numbers at
# risk and Cox log hazard ratio are the truth the digitizer and the reconstruction are held to; the population values (the
# distribution's median and the hazard ratio the generator was given) are recorded beside them, so a reader can tell sampling
# noise from reconstruction error.
local({ lib <- Sys.getenv("VCR_R_LIBS", ""); if (nzchar(lib)) .libPaths(c(lib, .libPaths())) })
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1L) stop("usage: truth.R <out.json>")
root <- Sys.getenv("VCR_ENGINE_ROOT")
source(file.path(root, "R", "engine.R"))
vcr_engine_load(root)

trials <- list(
  list(id = "T1", label = "exponential, 300 per arm, well separated",
       dist = vcr_dist_exponential_from_median(12), n = 300L, hr = c(1, 0.65, 0.8),
       accrual = list(kind = "uniform", duration = 12), followup = 24, dropout = 0, tick = 6, seed = 1701L),
  list(id = "T2", label = "Weibull, 180 per arm, longer tail",
       dist = list(kind = "weibull", shape = 1.4, scale = 14), n = 180L, hr = c(1, 0.7, 0.9),
       accrual = list(kind = "uniform", duration = 18), followup = 30, dropout = 0, tick = 12, seed = 1702L),
  list(id = "T3", label = "exponential, 120 per arm, curves close together, 10% a year lost",
       dist = vcr_dist_exponential_from_median(18), n = 120L, hr = c(1, 0.85, 0.7),
       accrual = list(kind = "uniform", duration = 6), followup = 30, dropout = 0.10, tick = 6, seed = 1703L),
  list(id = "T4", label = "exponential, 60 per arm, few large steps",
       dist = vcr_dist_exponential_from_median(9), n = 60L, hr = c(1, 0.55, 0.8),
       accrual = list(kind = "uniform", duration = 6), followup = 18, dropout = 0, tick = 3, seed = 1704L),
  list(id = "T5", label = "Weibull with falling hazard, 600 per arm, many small steps",
       dist = list(kind = "weibull", shape = 0.8, scale = 20), n = 600L, hr = c(1, 0.75, 0.6),
       accrual = list(kind = "uniform", duration = 24), followup = 36, dropout = 0, tick = 12, seed = 1705L)
)

out <- lapply(trials, function(tr) {
  set.seed(tr$seed, kind = VCR_RNG_KIND)
  arms <- lapply(seq_along(tr$hr), function(i) {
    d <- vcr_sim_tte(if (i == 1L) 0L else tr$n, if (i == 1L) tr$n else 0L, tr$dist, tr$hr[i], tr$accrual, tr$followup, dropout_annual = tr$dropout)
    d[, c("time", "status")]
  })
  tmax_data <- max(vapply(arms, function(d) max(d$time), numeric(1)))
  tmax <- ceiling(tmax_data / tr$tick) * tr$tick
  ticks <- seq(0, tmax, by = tr$tick)
  # the risk table a paper prints: every tick the smallest arm still has patients at (the last may be nearly empty)
  risk_times <- ticks[vapply(ticks, function(t) min(vapply(arms, function(d) sum(d$time >= t), numeric(1))) >= 5, logical(1))]
  arm_out <- lapply(seq_along(arms), function(i) {
    d <- arms[[i]]; km <- vcr_km(d$time, d$status)
    list(name = c("control", "treatment A", "treatment B")[i], n = nrow(d), time = d$time, status = d$status,
         km = list(time = km$time, surv = km$surv, atRisk = km$atRisk, events = km$events),
         median = if (is.finite(vcr_km_median(km))) vcr_km_median(km) else NULL, events = sum(d$status), lastTime = max(d$time),
         atRisk = vapply(risk_times, function(t) sum(d$time >= t), numeric(1)),
         popMedian = vcr_inverse_cumhaz(log(2) / tr$hr[i], tr$dist))
  })
  lhr <- lapply(2:3, function(i) {
    both <- rbind(cbind(arms[[1]], arm = 0L), cbind(arms[[i]], arm = 1L))
    list(sample = vcr_cox_loghr(both$time, both$status, both$arm), population = log(tr$hr[i]))
  })
  list(id = tr$id, label = tr$label, n = tr$n, tmax = tmax, tick = tr$tick, unit = "months", riskTimes = risk_times, arms = arm_out,
       logHR = lhr, hrGiven = tr$hr, seed = tr$seed)
})
writeLines(jsonlite::toJSON(out, auto_unbox = TRUE, digits = NA, null = "null"), args[1])
cat("wrote", length(out), "trials\n")
