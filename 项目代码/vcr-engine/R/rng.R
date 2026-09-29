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

#' How many cores to actually use. Honours the job's own ceiling and the
#' container's; 1 is always legal and must give the same numbers.
vcr_cores <- function(requested = NULL) {
  env <- suppressWarnings(as.integer(Sys.getenv("VCR_ENGINE_CORES", "")))
  n <- if (!is.null(requested) && is.finite(requested)) as.integer(requested)
       else if (!is.na(env) && env >= 1L) env
       else 1L
  max(1L, min(n, parallel::detectCores(logical = FALSE) %||% 1L))
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
