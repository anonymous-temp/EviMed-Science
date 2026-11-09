#!/usr/bin/env Rscript
# The frozen external validation of the Alzheimer placebo progression (plan R27) and the second structure beside it (plan R28). Everything it may do is in
# PROTOCOL.md; trials.json is the trial table and protocol.json carries its hash and the engine files'. It refuses to run when either differs from what
# was frozen.
#
#   Rscript --vanilla run_external.R --engine <vcr-engine dir> --out <result.json> [--replicates 20000] [--cores 2] [--synthetic]
#
# `--synthetic` runs the same code on one invented trial (not a row of trials.json, no published number) to test the runner before the first real run;
# its output is never a result. Reads only trials.json; writes aggregates only.

args <- commandArgs(trailingOnly = TRUE)
arg <- function(k, default = NULL) { i <- match(paste0("--", k), args); if (is.na(i)) default else args[i + 1L] }
synthetic <- "--synthetic" %in% args
lib <- Sys.getenv("VCR_R_LIBS", ""); if (nzchar(lib)) .libPaths(c(lib, .libPaths()))
engine <- arg("engine"); out_file <- arg("out"); replicates <- as.integer(arg("replicates", "20000")); cores <- as.integer(arg("cores", "2"))
stopifnot(!is.null(engine), !is.null(out_file))
here <- dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[1L])))
protocol <- jsonlite::fromJSON(file.path(here, "protocol.json"), simplifyVector = FALSE)
Sys.setenv(VCR_ENGINE_ROOT = engine, VCR_TEST_CORES = as.character(cores))
sha256_file <- function(p) digest::digest(file = p, algo = "sha256")

# --- the frozen inputs -------------------------------------------------------------------------------------------------------------------
trials_path <- file.path(here, "trials.json")
if (!synthetic) {
  if (!identical(sha256_file(trials_path), protocol$trialsSha256)) stop("trials.json is not the frozen trial table (SHA-256 differs)")
  for (f in names(protocol$engineFiles)) {
    got <- sha256_file(file.path(engine, "R", f))
    if (!identical(got, protocol$engineFiles[[f]])) stop(sprintf("engine file %s is not the frozen one (SHA-256 %s)", f, got))
  }
}
source(file.path(engine, "R", "engine.R")); vcr_engine_load(engine)
source(file.path(engine, "tests", "helpers", "harness.R"))
invisible(vcr_test_data_root()); invisible(vcr_test_apply_schema_additions(engine))

trials <- if (synthetic) { list(list(id = "synthetic", label = "invented trial, not a result", nSimulated = 120L, endpointWeek = 52, visits = list(0, 13, 26, 52),
  age = list(mean = 73, sd = 8), female = 0.55, mmse = list(mean = NULL, sd = NULL, entryRange = list(16, 26)), apoe4 = list(genotypes = list(0.5, 0.35, 0.15)),
  backgroundShare = 1, baselineAdas = list(mean = 23, sd = 9), observed = list(change = 5, se = 0.5, week = 52), analysis = "mmrm")) } else jsonlite::fromJSON(trials_path, simplifyVector = FALSE)$trials

P <- function(v, basis) list(value = v, basis = basis)
num <- function(x) as.numeric(unlist(x))
scenario <- function(t, background) {
  pop <- list(mmseRange = P(num(t$mmse$entryRange), "literature"), ageMeanByApoe4 = P(rep(t$age$mean, 3L), "literature"), ageSd = P(t$age$sd, "literature"), femaleShare = P(t$female, "literature"))
  if (!is.null(t$apoe4$genotypes)) pop$apoe4 <- P(num(t$apoe4$genotypes), "literature")
  sc <- list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = as.integer(t$nSimulated), nControl = as.integer(t$nSimulated)),
             timeUnit = "weeks", visits = num(t$visits), model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = "posterior_draws"),
             population = pop, dropoutModel = "parameter_set", placebo = TRUE, analysis = list(kind = t$analysis, visit = t$endpointWeek))
  if (background) sc$treatment <- list(background = list(drug = "donepezil", doseMg = 10, weeksBefore = 13))
  sc
}
measure_value <- function(m) if (is.null(m)) NA_real_ else m$value
read_reading <- function(res) {
  cr <- res$diagnostics$progression$controlReading
  list(reading = cr$reading, trials = cr$trials, mean = measure_value(cr$mean), meanMcse = cr$mean$mcse, sd = measure_value(cr$sd), lower = measure_value(cr$lower), median = measure_value(cr$median),
       upper = measure_value(cr$upper), completersMean = measure_value(cr$completers))
}
metrics <- function(pred, obs, se) {
  list(predicted = pred$mean, predictedSd = pred$sd, lower = pred$lower, upper = pred$upper, observed = obs, observedSe = se,
       bias = pred$mean - obs, z = (obs - pred$mean) / pred$sd, covered = obs >= pred$lower && obs <= pred$upper)
}

one_variant <- function(t, index, background) {
  seed <- 20261109L + 101L * index
  job <- vcr_test_job("patients.progression", scenario(t, background), seed = seed, replicates = replicates, cores = cores)
  res <- vcr_test_run(job)
  codes <- vcr_test_issue_codes(res)
  pr <- res$diagnostics$progression
  last <- length(pr$observed)
  list(status = res$status, issues = as.list(codes), seed = seed, trials = pr$trials, reading = read_reading(res),
       baselineModelAdas = measure_value(pr$curves[[1L]]$control$mean), baselineModelSd = measure_value(pr$curves[[1L]]$control$sd),
       completionModel = (function() { n <- pr$observed[[last]]$control$value; n0 <- pr$observed[[1L]]$control$value; if (is.finite(n0) && n0 > 0) n / n0 else NA_real_ })(),
       population = pr$population, background = pr$treatment$background)
}

conrado <- function(t, rogers, index) {
  pop <- rogers$population
  r <- vcr_conrado_trials(n = as.integer(t$nSimulated), weeks = t$endpointWeek, baseline = t$baselineAdas$mean, ageMean = pop$ageMeanByApoe4[[1L]], ageSd = pop$ageSd,
                          apoe = num(pop$apoe4), onMedication = TRUE, trials = 4000L, seed = 20261109L + 101L * index)
  x <- r$change
  list(mean = mean(x), sd = stats::sd(x), lower = unname(stats::quantile(x, 0.025)), median = unname(stats::quantile(x, 0.5)), upper = unname(stats::quantile(x, 0.975)),
       typicalChange = r$typicalChange, trials = length(x), meanMcse = stats::sd(x) / sqrt(length(x)), apoe = num(pop$apoe4), ageMean = pop$ageMeanByApoe4[[1L]], ageSd = pop$ageSd)
}

rows <- list()
for (i in seq_along(trials)) {
  t <- trials[[i]]
  message(sprintf("[%s] trial %d/%d %s", format(Sys.time(), "%H:%M:%S"), i, length(trials), t$id))
  prim <- one_variant(t, i, background = TRUE)
  sens <- one_variant(t, i, background = FALSE)
  con <- conrado(t, prim, i)
  obs <- t$observed
  rows[[i]] <- list(id = t$id, label = t$label, endpointWeek = t$endpointWeek, nSimulated = t$nSimulated, analysis = t$analysis,
                    observed = list(change = obs$change, se = obs$se),
                    primary = c(prim, list(metrics = metrics(prim$reading, obs$change, obs$se))),
                    noBackground = c(sens, list(metrics = metrics(sens$reading, obs$change, obs$se))),
                    conradoStructure = c(con, list(metrics = metrics(con, obs$change, obs$se), differenceFromPrimary = con$mean - prim$reading$mean)),
                    baselineReported = t$baselineAdas, completionReported = t$completion)
}

# --- the summary: what the premise on an Alzheimer page is computed from ---------------------------------------------------------------------------
summ <- function(sel, arm) {
  m <- lapply(rows[sel], function(r) r[[arm]]$metrics)
  b <- vapply(m, function(x) x$bias, numeric(1)); z <- vapply(m, function(x) x$z, numeric(1)); cv <- vapply(m, function(x) isTRUE(x$covered), logical(1))
  list(trials = length(b), meanBias = mean(b), meanAbsoluteBias = mean(abs(b)), rmse = sqrt(mean(b^2)), meanZ = mean(z), coverage = sum(cv), ids = vapply(rows[sel], function(r) r$id, character(1)))
}
long <- vapply(rows, function(r) r$endpointWeek >= 76, logical(1)); short <- !long
summary <- list(
  longHorizon = list(weeks = "76 to 78", primary = summ(long, "primary"), noBackground = summ(long, "noBackground"), conradoStructure = summ(long, "conradoStructure")),
  shortHorizon = list(weeks = "24", primary = summ(short, "primary"), noBackground = summ(short, "noBackground"), conradoStructure = summ(short, "conradoStructure")),
  all = list(primary = summ(rep(TRUE, length(rows)), "primary"), noBackground = summ(rep(TRUE, length(rows)), "noBackground"), conradoStructure = summ(rep(TRUE, length(rows)), "conradoStructure")))

head_rev <- tryCatch(system2("git", c("-C", engine, "rev-parse", "HEAD"), stdout = TRUE, stderr = FALSE), error = function(e) NA_character_)
result <- list(schemaVersion = 1L, synthetic = synthetic, ranOn = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"), replicates = replicates, cores = cores, gitHead = head_rev[1L],
               protocolSha256 = if (file.exists(file.path(here, "PROTOCOL.md"))) sha256_file(file.path(here, "PROTOCOL.md")) else NA_character_,
               trialsSha256 = sha256_file(trials_path), engineFiles = vapply(names(protocol$engineFiles), function(f) sha256_file(file.path(engine, "R", f)), character(1)),
               rVersion = as.character(getRversion()), trials = rows, summary = summary)
writeLines(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null", digits = NA, pretty = TRUE, na = "null"), out_file)
message("wrote ", out_file)
