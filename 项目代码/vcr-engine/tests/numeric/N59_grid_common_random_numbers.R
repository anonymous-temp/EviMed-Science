# N59 — common random numbers across the truth scenarios of a design grid (remediation plan D5, 2026-11-01).
#
# From design.grid 1.3.0 the truth scenarios of one design share the design's random stream where the generator makes that an honest
# pairing (a two-arm design: every subject takes a fixed number of uniforms whatever the truth says, so replicate r is the same patients
# under every truth), and a design is never paired with another (its size shifts every later draw). A single-arm design draws counts
# whose draw count and mapping change with the rate, so its cells keep a seed of their own. A grid recorded at 1.2.0 replays with the old
# per-cell seeds, bit for bit (N06d).
#
# What is measured, since the literature's figure (a 74-94 percent cut in the variance of a comparison, Murphy et al.) is only a figure
# for other models: the variance, over independent job seeds, of the DIFFERENCE between the estimated powers of two neighbouring
# truths, with and without the shared stream, on this engine's own generators. The label "no common random numbers between cells" is
# written only for a grid in which no design's truths were paired.

.n59_grid <- function(endpoint, seed, version, reps, truths, designs = list(list(nTreat = 60, nControl = 60)), extra = list()) {
  base <- if (identical(endpoint, "continuous")) {
    list(design = list(kind = "two_arm_fixed", nTreat = 60, nControl = 60), endpoint = list(type = "continuous"), truth = list(effect = 0.5, sd = 1),
         analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power"))
  } else {
    list(design = list(kind = "two_arm_fixed", nTreat = 100, nControl = 100), endpoint = list(type = "time_to_event"), truth = list(hazardRatio = 0.7, controlMedian = 12),
         accrual = list(kind = "uniform", duration = 12, followup = 12), analysis = list(method = "logrank", alpha = 0.025, sided = 1), performance = list("power"))
  }
  vcr_test_run(vcr_test_job("design.grid", utils::modifyList(c(base, list(designs = designs, truths = truths)), extra), seed = seed, replicates = reps,
                            job_id = sprintf("job_n59_%s_%d_%s", endpoint, seed, gsub("\\.", "", version)), extra = list(methodVersion = version)))
}

.n59_power <- function(r, truth_index) {
  c_ <- Filter(function(x) x$truthIndex == truth_index && x$designIndex == 1L, r$diagnostics$cells)[[1]]
  Filter(function(m) identical(m$name, "power"), c_$measures)[[1]]$value
}

vcr_case("N59a", c("AC-28", "AC-30"), function() {
  seeds <- 101L + 37L * (0:15)
  one <- function(version) {
    d <- vapply(seeds, function(sd) {
      r <- .n59_grid("continuous", sd, version, 200L, list(list(effect = 0.50), list(effect = 0.55)))
      .n59_power(r, 2L) - .n59_power(r, 1L)
    }, numeric(1))
    c(var = stats::var(d), mean = mean(d))
  }
  crn <- one("1.3.0"); ind <- one("1.2.0")
  ratio <- crn[["var"]] / ind[["var"]]
  # the truth of the difference (the same under both) is positive and small; the paired grid does not move it
  list(pass = ratio < 0.5 && abs(crn[["mean"]] - ind[["mean"]]) < 0.02,
       detail = sprintf("continuous endpoint, effects 0.50 and 0.55, 60/60, 200 replicates, 16 independent job seeds: variance of the power difference %.3e with the shared stream against %.3e with independent seeds (%.1f percent of it, a %.0f percent cut); mean difference %.4f against %.4f",
                        crn[["var"]], ind[["var"]], 100 * ratio, 100 * (1 - ratio), crn[["mean"]], ind[["mean"]]))
})

vcr_case("N59b", c("AC-28", "AC-30"), function() {
  seeds <- 5L + 211L * (0:9)
  one <- function(version) {
    d <- vapply(seeds, function(sd) {
      r <- .n59_grid("time_to_event", sd, version, 100L, list(list(hazardRatio = 0.70), list(hazardRatio = 0.76)))
      .n59_power(r, 2L) - .n59_power(r, 1L)
    }, numeric(1))
    c(var = stats::var(d), mean = mean(d))
  }
  crn <- one("1.3.0"); ind <- one("1.2.0")
  ratio <- crn[["var"]] / ind[["var"]]
  list(pass = ratio < 0.8,
       detail = sprintf("time-to-event endpoint (log-rank), hazard ratios 0.70 and 0.76, 100/100, 100 replicates, 10 independent job seeds: variance of the power difference %.3e with the shared stream against %.3e with independent seeds (%.1f percent of it)",
                        crn[["var"]], ind[["var"]], 100 * ratio))
})

vcr_case("N59c", c("AC-04", "AC-28"), function() {
  # Which cells share a stream, and what the result says about it. Two designs x three truths: the truths of a design share its seed, the
  # designs do not; replicate counts may differ between truths (a null case has a larger floor) and the shared prefix is the same patients.
  tr <- list(list(effect = 0), list(effect = 0.4), list(effect = 0.6))
  r <- .n59_grid("continuous", 31L, "1.3.0", 400L, tr, designs = list(list(nTreat = 40, nControl = 40), list(nTreat = 80, nControl = 80)))
  cells <- r$diagnostics$cells
  seeds <- vapply(cells, function(c_) as.numeric(c_$seed), numeric(1)); by_design <- split(seeds, vapply(cells, function(c_) c_$designIndex, numeric(1)))
  want <- function(di) as.numeric((31 + di * 7919) %% 2147483647)
  shared <- all(by_design[["1"]] == want(1)) && all(by_design[["2"]] == want(2)) && want(1) != want(2)
  flagged <- all(vapply(cells, function(c_) isTRUE(c_$pairedStream), logical(1)))
  policy <- r$diagnostics$seedPolicy
  said <- grepl("common_random_numbers_between_the_truth_scenarios_of_a_design", policy, fixed = TRUE) && !grepl("no_common_random_numbers_between_cells", policy, fixed = TRUE)
  # a cell is still one immutable run: it equals the design.simulate job at its own (shared) seed, bit for bit
  sim <- vcr_test_run(vcr_test_job("design.simulate", list(design = list(kind = "two_arm_fixed", nTreat = 80, nControl = 80), endpoint = list(type = "continuous"),
    truth = list(effect = 0.4, sd = 1), analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power")), seed = want(2), replicates = 400L, job_id = "job_n59c_sim"))
  cell <- Filter(function(c_) c_$designIndex == 2L && c_$truthIndex == 2L, cells)[[1]]
  same <- identical(cell$measures[[1]]$value, Filter(function(m) identical(m$name, "power"), sim$measures)[[1]]$value)
  # single-arm designs are not paired, a single truth has nothing to pair, and the sentence then says so
  simon <- list(design = list(kind = "simon_two_stage", n1 = 10, n = 29, r1 = 1, r = 5), endpoint = list(type = "binary"),
                analysis = list(method = "simon_boundary", alpha = 0.05, sided = 1), performance = list("power"), truth = list(nullRate = 0.1, alternativeRate = 0.3, responseRate = 0.3))
  gs <- vcr_test_run(vcr_test_job("design.grid", c(simon, list(designs = list(list(kind = "simon_two_stage")), truths = list(list(responseRate = 0.3), list(responseRate = 0.1)))),
                                  seed = 9L, replicates = 300L, job_id = "job_n59c_simon", extra = list(methodVersion = "1.3.0")))
  unpaired <- identical(gs$status, "succeeded") && !any(vapply(gs$diagnostics$cells, function(c_) isTRUE(c_$pairedStream), logical(1))) &&
    grepl("no_common_random_numbers_between_cells", gs$diagnostics$seedPolicy, fixed = TRUE) && length(unique(vapply(gs$diagnostics$cells, function(c_) as.numeric(c_$seed), numeric(1)))) == 2L
  one_truth <- .n59_grid("continuous", 31L, "1.3.0", 200L, list(list(effect = 0.4)))
  alone <- grepl("no_common_random_numbers_between_cells", one_truth$diagnostics$seedPolicy, fixed = TRUE) && !isTRUE(one_truth$diagnostics$cells[[1]]$pairedStream)
  # replay at 1.2.0 says what it always said, and carries no new key
  old <- .n59_grid("continuous", 31L, "1.2.0", 200L, tr[1:2])
  old_ok <- identical(old$diagnostics$seedPolicy, "independent_cell_seeds; independent_L_Ecuyer_replicate_streams_within_cell; no_common_random_numbers_between_cells") &&
    all(vapply(old$diagnostics$cells, function(c_) is.null(c_$pairedStream), logical(1)))
  list(pass = shared && flagged && said && same && unpaired && alone && old_ok && length(vcr_validate_result(r)) == 0L,
       detail = sprintf("2 designs x 3 truths: seeds per design %s (the truths share their design's, the designs differ) %s, every cell flagged paired %s, policy \"%s\", a cell equals the design.simulate job at its seed %s; Simon cells unpaired and the old words kept %s; a single truth has nothing to pair %s; a grid replayed at 1.2.0 keeps the old policy and no new key %s",
                        paste(vapply(by_design, function(x) as.character(unique(x)), character(1)), collapse = " / "), shared, flagged, policy, same, unpaired, alone, old_ok))
})
