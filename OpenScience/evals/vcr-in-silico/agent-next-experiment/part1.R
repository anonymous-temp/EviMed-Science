#!/usr/bin/env Rscript
# R37c part 1 (no model): does decision.value_of_information rank the planted input first, against an independent oracle.
#   VCR_ENGINE_ROOT=<vcr-engine> VCR_R_LIBS=<lib> Rscript part1.R <scenarios.json> [out.json]
local({ lib <- Sys.getenv("VCR_R_LIBS", ""); if (nzchar(lib) && dir.exists(lib)) .libPaths(c(lib, .libPaths())) })
VCR_ROOT <- normalizePath(Sys.getenv("VCR_ENGINE_ROOT"), mustWork = TRUE); options(warn = 1)
source(file.path(VCR_ROOT, "R", "engine.R")); vcr_engine_load(VCR_ROOT)
source(file.path(VCR_ROOT, "tests", "helpers", "harness.R"))
a <- commandArgs(TRUE); d <- jsonlite::fromJSON(a[1], simplifyVector = FALSE)
draw <- function(s, u) switch(s$family, normal = qnorm(u, s$mean, s$sd), lognormal = qlnorm(u, s$meanlog, s$sdlog), beta = qbeta(u, s$alpha, s$beta),
                              uniform = s$min + u * (s$max - s$min), fixed = rep(s$value, length(u)))
med <- function(s) draw(s, 0.5)
power <- function(n, delta, sd, drop, alpha = 0.025) { m <- n * (1 - drop); pnorm(delta / (sd * sqrt(2 / m)) - qnorm(1 - alpha)) }
oracle_evpi <- function(sc, role, S = 200000L) {
  set.seed(7L); u <- (seq_len(S) - 0.5) / S
  v <- lapply(sc$inputs, med); v[[role]] <- draw(sc$inputs[[role]], u)
  cp <- if (!is.null(v$controlProgression)) v$controlProgression else 1
  delta <- if (identical(sc$effectScale, "proportional_slowing")) v$effect * cp else v$effect
  U <- sapply(sc$options, function(o) if (o$nPerArm == 0) rep(0, S) else sc$successValue * power(o$nPerArm, delta, v$sd, v$dropoutShare) - sc$costPerPatient * 2 * o$nPerArm)
  mean(apply(U, 1, max)) - max(colMeans(U))
}
rows <- list()
for (s in d$scenarios) {
  sc <- s$engineScenario
  orc <- vapply(names(sc$inputs), function(r) oracle_evpi(sc, r), numeric(1))
  job <- vcr_test_job("decision.value_of_information", sc, replicates = 20000L, seed = 37L)
  r <- vcr_test_run(job)
  evppi <- list(); for (w in r$diagnostics$voi$inputs) if (!isTRUE(w$group)) evppi[[w$input]] <- w$evppi$value
  rows[[s$id]] <- list(planted = s$plantedInput, status = r$status, engineEvppi = evppi, engineTop = if (length(evppi)) names(which.max(unlist(evppi))) else NA,
                       oracleEvpiOneInput = as.list(orc), oracleTop = names(which.max(orc)), enginePlantedFirst = length(evppi) > 0 && identical(names(which.max(unlist(evppi))), s$plantedInput),
                       oraclePlantedFirst = identical(names(which.max(orc)), s$plantedInput))
}
out <- list(scenarios = rows, plantedFirstEngine = sum(vapply(rows, function(x) isTRUE(x$enginePlantedFirst), logical(1))), plantedFirstOracle = sum(vapply(rows, function(x) isTRUE(x$oraclePlantedFirst), logical(1))), n = length(rows))
txt <- jsonlite::toJSON(out, auto_unbox = TRUE, pretty = TRUE, digits = 6, null = "null")
if (length(a) > 1) writeLines(txt, a[2]) else cat(txt, "\n")
