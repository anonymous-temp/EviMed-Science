# ---------------------------------------------------------------------------
# robustness.R — what the three robustness methods add to the shared harness
# (2026-10-04): their valid handler jobs, which E05 runs as they are and E10 breaks
# one field at a time. Kept in a file of its own, sourced by tests/run_all.R right
# after harness.R, so the streams that add engine methods at the same time do not
# edit one list.
# ---------------------------------------------------------------------------

#' Run `code` with a fixed RNG seed and leave the caller's random state as it was.
.vcr_with_seed <- function(seed, code) {
  had <- exists(".Random.seed", envir = .GlobalEnv)
  old <- if (had) get(".Random.seed", envir = .GlobalEnv) else NULL
  on.exit(if (had) assign(".Random.seed", old, envir = .GlobalEnv) else if (exists(".Random.seed", envir = .GlobalEnv)) rm(".Random.seed", envir = .GlobalEnv))
  set.seed(seed, kind = VCR_RNG_KIND)
  force(code)
}

#' One valid job for each robustness method, as `list(method, scenario, inputs,
#' replicates)` -- the shape `vcr_test_handler_jobs()` returns.
vcr_test_robustness_handler_jobs <- function() {
  .vcr_with_seed(41L, {
    n <- 90L
    d <- data.frame(USUBJID = sprintf("R%03d", seq_len(n)), arm = rep(0:1, times = c(60L, 30L)), x1 = stats::rnorm(n), x2 = stats::rbinom(n, 1L, 0.5), stringsAsFactors = FALSE)
    d$x1[d$arm == 1L] <- d$x1[d$arm == 1L] + 0.3
    d$fracture <- stats::rbinom(n, 1L, 0.25); d$cataract <- stats::rbinom(n, 1L, 0.3); d$death <- stats::rbinom(n, 1L, 0.2)
    in_nc <- vcr_test_input(d, "snp_e05r:subject", "subject")
    list(
      list("comparator.negative_control", list(
        controls = list(list(name = "fracture", estimate = 0.12, se = 0.2), list(name = "cataract", estimate = -0.05, se = 0.15),
                        list(name = "otitis", estimate = 0.31, se = 0.25)),
        primary = list(name = "death", estimate = -0.4, se = 0.1)), NULL),
      # the controls analysed in the engine, with the primary's adjustment
      list("comparator.negative_control", list(
        covariates = list("x1", "x2"), treatmentColumn = "arm",
        controls = list(list(name = "fracture", column = "fracture"), list(name = "cataract", column = "cataract")),
        primary = list(name = "death", column = "death")), list(in_nc))
    )
  })
}
