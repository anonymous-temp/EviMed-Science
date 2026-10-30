# ---------------------------------------------------------------------------
# rng.R — reproducible randomness: one independent stream per replicate.
#
# Hidden knowledge:
#
# - **The unit of randomness is the replicate, not the run.** Every replicate
#   gets its own L'Ecuyer-CMRG substream, so replicate 7,431 draws the same
#   numbers whether it ran on core 1 of 1 or core 6 of 8, whether it ran in the
#   first pass or after a resume. That is what makes AC-31 ("same seed, 1 core
#   and 8 cores, bit-identical") a property of the design rather than a thing
#   to hope for. Seeding the worker instead of the replicate — the obvious
#   thing, and what `mclapply(mc.set.seed = TRUE)` does by default — makes the
#   answer a function of the core count.
# - **Summation order is fixed too.** Bit-identical is stronger than
#   statistically identical: `sum(a, b) != sum(b, a)` in floating point. So
#   per-replicate values are stored by index and reduced in index order at the
#   very end, never as running partial sums in completion order. This is also
#   why a resumed run agrees with an uninterrupted one: batch boundaries are a
#   function of the batch size alone.
# - `parallel::nextRNGStream` advances by 2^127 draws, so a replicate would
#   have to consume 1.7e38 numbers before it collided with the next one. No
#   simulation here comes within thirty orders of magnitude of that.
# - We deliberately do *not* call `set.seed()` inside workers with an integer
#   derived from the index (seed + i). Nearby integer seeds are not independent
#   for Mersenne-Twister and the independence guarantee would be folklore
#   rather than a theorem.
# ---------------------------------------------------------------------------

suppressPackageStartupMessages(library(parallel))

VCR_RNG_KIND <- "L'Ecuyer-CMRG"

#' A bank of independent substreams, handed out in order.
#'
#' `state` is the `.Random.seed` vector the next substream will start from, so
#' a checkpoint can store it and a resumed run continues the same sequence.
vcr_stream_bank <- function(seed, state = NULL) {
  if (is.null(state)) {
    old_kind <- RNGkind()
    on.exit(RNGkind(old_kind[1], old_kind[2], old_kind[3]), add = TRUE)
    set.seed(as.integer(seed), kind = VCR_RNG_KIND)
    state <- get(".Random.seed", envir = .GlobalEnv)
  }
  env <- new.env(parent = emptyenv())
  env$state <- state
  list(
    take = function(n) {
      out <- vector("list", n)
      s <- env$state
      for (i in seq_len(n)) {
        out[[i]] <- s
        s <- parallel::nextRNGStream(s)
      }
      env$state <- s
      out
    },
    state = function() env$state
  )
}

#' Run `fn(i)` with replicate `i`'s own substream installed.
vcr_with_stream <- function(stream, fn, i) {
  old_kind <- RNGkind()
  had <- exists(".Random.seed", envir = .GlobalEnv)
  old_seed <- if (had) get(".Random.seed", envir = .GlobalEnv) else NULL
  assign(".Random.seed", stream, envir = .GlobalEnv)
  on.exit({
    if (had) assign(".Random.seed", old_seed, envir = .GlobalEnv)
    else if (exists(".Random.seed", envir = .GlobalEnv)) rm(".Random.seed", envir = .GlobalEnv)
    RNGkind(old_kind[1], old_kind[2], old_kind[3])
  }, add = TRUE)
  fn(i)
}

#' How many cores to actually use. `VCR_ENGINE_CORES` is the ceiling the
#' container was given and a job's own `cores` can only LOWER it (a job that asks
#' for 64 on a 2-core allowance runs on 2); with no request the ceiling is what
#' is used, and with neither one core. The machine's physical cores cap both.
#' 1 is always legal and must give the same numbers.
vcr_cores <- function(requested = NULL) {
  env <- suppressWarnings(as.integer(Sys.getenv("VCR_ENGINE_CORES", "")))
  ceiling_ <- if (!is.na(env) && env >= 1L) env else NA_integer_
  ask <- if (length(requested) == 1L && is.finite(suppressWarnings(as.numeric(requested))) && requested >= 1) as.integer(requested) else NA_integer_
  n <- if (!is.na(ask)) ask else if (!is.na(ceiling_)) ceiling_ else 1L
  if (!is.na(ceiling_)) n <- min(n, ceiling_)
  phys <- suppressWarnings(parallel::detectCores(logical = FALSE))
  if (is.finite(phys) && phys >= 1L) n <- min(n, as.integer(phys))
  max(1L, as.integer(n))
}

#' Map over replicate indices with their streams, in index order.
#'
#' Returns a list the same length as `streams`, element `i` being `fn(i)`.
#' `mclapply` preserves order; when a fork dies its slot holds a `try-error`,
#' and we surface that rather than silently dropping the replicate — ADEMP is
#' explicit that failed replicates are reported, never discarded (Morris 2019).
vcr_map_streams <- function(streams, fn, cores = 1L, indices = NULL) {
  idx <- indices %||% seq_along(streams)
  run_one <- function(k) vcr_with_stream(streams[[k]], function(.) fn(idx[k]), idx[k])
  out <- if (cores <= 1L) {
    lapply(seq_along(streams), run_one)
  } else {
    parallel::mclapply(seq_along(streams), run_one, mc.cores = cores, mc.preschedule = TRUE)
  }
  failed <- vapply(out, function(x) inherits(x, "try-error") || inherits(x, "error"), logical(1))
  if (any(failed)) {
    first <- which(failed)[1]
    stop(sprintf("replicate %d failed: %s", idx[first], conditionMessage(attr(out[[first]], "condition") %||%
      simpleError(as.character(out[[first]])))))
  }
  out
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# Paired scenarios reuse a member's random draws; replicate r takes an independent L'Ecuyer stream.
vcr_patient_randomization <- function(job) {
  seed <- job[["seed"]]
  key <- job[["scenario"]][["pairing"]][["key"]]
  legacy <- identical(job[["methodVersion"]], "1.0.0")
  # A declared correspondence key participates even when the caller supplies a seed.
  # Seven hex digits stay exactly representable as an R integer; no-key/legacy replay is unchanged.
  effective_seed <- if (!legacy && !is.null(key)) strtoi(substr(vcr_sha256(paste("patient-pairing-v1", seed, key, sep = ":")), 1L, 7L), base = 16L) else seed
  set.seed(effective_seed, kind = VCR_RNG_KIND)
  replicate <- as.integer(job[["scenario"]][["pairing"]][["replicate"]] %||% 1L)
  if (replicate > 1L) for (i in seq_len(replicate - 1L)) assign(".Random.seed", parallel::nextRNGStream(get(".Random.seed", envir = .GlobalEnv)), envir = .GlobalEnv)
  list(policy = if (is.null(job[["scenario"]][["pairing"]])) "scenario_seed" else "common_random_numbers_by_member",
    pairingKey = job[["scenario"]][["pairing"]][["key"]], replicate = replicate, seed = seed, effectiveSeed = effective_seed,
    seedDerivation = if (!legacy && !is.null(key)) "sha256(patient-pairing-v1:seed:key)[1:7]" else "declared_seed",
    replicateStreams = "L'Ecuyer-CMRG nextRNGStream", causalIndividualEffectIdentified = FALSE)
}

# An immutable input row, not a job id or outcome parameter, identifies the same synthetic member.
vcr_patient_ids <- function(job, population, n) {
  legacy <- job[["method"]] %in% c("patients.continuous", "patients.binary", "patients.time_to_event", "patients.longitudinal") && identical(job[["methodVersion"]], "1.0.0")
  if (legacy) return(paste0("vp_", vapply(seq_len(n), function(i) substr(vcr_sha256(paste(job[["seed"]], job[["jobId"]] %||% "", i, sep = ":")), 1L, 12L), character(1))))
  tables <- Filter(function(input) !is.null(input[["location"]]), job[["inputs"]])
  matching <- Filter(function(input) identical(input[["id"]], attr(population, "vcrInputId")), tables)
  selected <- if (length(matching)) matching[[1L]] else if (length(tables)) tables[[1L]] else NULL
  basis <- if (!is.null(population) && !is.null(selected)) {
    if (vcr_table_source(population) %in% c("observed", "extracted", "calculated", "imputed")) selected[["id"]] else selected[["hash"]]
  } else job[["scenario"]][["pairing"]][["key"]] %||% paste0("seed:", job[["seed"]])
  rows <- if (is.null(population)) seq_len(n) else rownames(population)
  paste0("vp_", vapply(rows, function(i) substr(vcr_sha256(paste(basis, i, sep = ":")), 1L, 12L), character(1)))
}
