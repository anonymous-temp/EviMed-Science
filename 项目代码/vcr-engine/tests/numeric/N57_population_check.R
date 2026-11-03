# N57 — population.check: a generated population held against a SECOND baseline table (remediation plan D2, 2026-11-01).
#
# The generated side is the profile a population job wrote (mean, SD and levels per variable), copied in by the control plane. The
# case takes it from a real literature-population job, so the shape is the one production sends, and writes every number of the
# comparison again in base R: the standardized difference of a continuous variable (against the reference's own SD), of a binary one
# (the pooled binary SD), the total variation distance of a categorical one, the standard error when the reference gives its size, and
# what was not compared. Nothing in the result is a verdict: a row is `close` at or under the domain's floor and `apart` above it.

.n57_generated <- function(profile) {
  lapply(profile, function(p) {
    row <- list(variable = p$variable, kind = p$kind, n = p$n - (p$missing %||% 0L))
    if (!is.null(p$label)) row$label <- p$label
    if (identical(p$kind, "continuous")) { row$mean <- p$mean; row$sd <- p$sd }
    else row$levels <- lapply(p$levels, function(cell) list(level = as.character(cell$level), p = cell$p))
    row
  })
}

.n57_population <- function(id = "n57") {
  base <- vcr_test_job("population.literature", list(
    baselineTable = list(list(variable = "age", mean = 62, sd = 9), list(variable = "male", proportion = 0.55),
                         list(variable = "ecog", proportions = list(0.4, 0.5, 0.1), levels = list("0", "1", "2")),
                         list(variable = "bmi", mean = 27, sd = 4)),
    n = 4000L), seed = 20261101L, job_id = paste0("job_", id, "_pop"))
  r <- vcr_test_run(base)
  stopifnot(identical(r$status, "succeeded"))
  r$diagnostics$profile
}

.n57_job <- function(reference, generated, id, extra = list()) {
  vcr_test_job("population.check", c(list(baselineTable = reference, generated = generated), extra), seed = 1L, job_id = paste0("job_", id))
}

vcr_case("N57a", c("AC-08"), function() {
  profile <- .n57_population()
  gen <- .n57_generated(profile)
  at <- function(v) gen[[which(vapply(gen, function(g) identical(g$variable, v), logical(1)))]]
  g_age <- at("age"); g_male <- at("male"); g_ecog <- at("ecog")
  lv <- function(g) stats::setNames(vapply(g$levels, function(c) c$p, numeric(1)), vapply(g$levels, function(c) c$level, character(1)))
  # a second table that agrees on some variables and not on others: age near, male apart, ecog apart in its middle level
  ref <- list(list(variable = "age", mean = 61.5, sd = 10), list(variable = "male", proportion = 0.40),
              list(variable = "ecog", proportions = list(0.30, 0.55, 0.15), levels = list("0", "1", "2")),
              list(variable = "stage", proportion = 0.2))
  r <- vcr_test_run(.n57_job(ref, gen, "n57a", list(referenceN = 400L)))
  row <- function(v) r$diagnostics$rows[[which(vapply(r$diagnostics$rows, function(x) identical(x$variable, v), logical(1)))]]
  # by hand
  smd_age <- (g_age$mean - 61.5) / 10
  se_age <- sqrt(10^2 / 400 + g_age$sd^2 / g_age$n)
  pg <- lv(g_male)[["1"]]; pooled <- sqrt((pg * (1 - pg) + 0.4 * 0.6) / 2); smd_male <- (pg - 0.4) / pooled
  p_ecog <- lv(g_ecog)[c("0", "1", "2")]; tv <- 0.5 * sum(abs(p_ecog - c(0.30, 0.55, 0.15)))
  ok <- identical(r$status, "succeeded") && identical(r$conclusion, "estimable") &&
    abs(row("age")$standardizedDifference - smd_age) < 1e-12 && identical(row("age")$state, if (abs(smd_age) <= 0.1) "close" else "apart") &&
    abs(row("age")$difference - (g_age$mean - 61.5)) < 1e-12 && abs(row("age")$sdRatio - g_age$sd / 10) < 1e-12 &&
    abs(row("age")$standardError - se_age) < 1e-12 &&
    abs(row("male")$standardizedDifference - smd_male) < 1e-12 && identical(row("male")$state, "apart") &&
    abs(row("ecog")$totalVariation - tv) < 1e-12 && identical(row("ecog")$state, "apart") && length(row("ecog")$levels) == 3L &&
    identical(row("stage")$state, "not_comparable") && identical(row("stage")$reason, "not_in_population") &&
    identical(r$diagnostics$coverage$compared, 3L) &&
    identical(unlist(r$diagnostics$coverage$referenceOnly), "stage") && identical(unlist(r$diagnostics$coverage$generatedOnly), "bmi") &&
    identical(unlist(r$diagnostics$coverage$notCompared), c("joint_distribution", "distribution_shape")) &&
    vcr_measure_value(r, "variables_compared") == 3 && vcr_measure_value(r, "variables_apart") == 2 &&
    abs(vcr_measure_value(r, "worst_difference") - max(abs(smd_age), abs(smd_male), tv)) < 1e-12 &&
    length(vcr_validate_result(r)) == 0L
  # the generated numbers are the population's own to within what the 4-significant-digit profile keeps: age 62, SD 9
  near <- abs(g_age$mean - 62) < 0.5 && abs(g_age$sd - 9) < 0.3 && abs(pg - 0.55) < 0.03
  list(pass = ok && near, detail = sprintf("age SMD %.5f (hand %.5f), SE %.5f; male SMD %.4f (%s); ecog TV %.4f; stage not in the population; compared 3, apart 2, not compared: joint structure and shape",
                                           row("age")$standardizedDifference, smd_age, row("age")$standardError, row("male")$standardizedDifference, row("male")$state, row("ecog")$totalVariation))
})

vcr_case("N57b", c("AC-08"), function() {
  # no sample size from the reference: no standard error is invented; a table that matches the population is close on every row
  profile <- .n57_population("n57b")
  gen <- .n57_generated(profile)
  same <- list(list(variable = "age", mean = 62, sd = 9), list(variable = "male", proportion = 0.55),
               list(variable = "ecog", proportions = list(0.4, 0.5, 0.1), levels = list("0", "1", "2")))
  r <- vcr_test_run(.n57_job(same, gen, "n57b"))
  rows <- r$diagnostics$rows
  none_se <- all(vapply(rows, function(x) is.null(x$standardError) && is.null(x$withinTwoStandardErrors), logical(1)))
  ok <- identical(r$status, "succeeded") && all(vapply(rows, function(x) identical(x$state, "close"), logical(1))) && none_se &&
    vcr_measure_value(r, "variables_apart") == 0 && is.null(r$diagnostics$referenceN) &&
    length(r$diagnostics$coverage$generatedOnly) == 1L && length(vcr_validate_result(r)) == 0L
  # a categorical reference without level names is read by position; a binary variable against a continuous generated one is not comparable
  by_position <- vcr_test_run(.n57_job(list(list(variable = "ecog", proportions = list(0.4, 0.5, 0.1))), gen, "n57b2"))
  mismatch <- vcr_test_run(.n57_job(list(list(variable = "age", proportion = 0.5), list(variable = "male", proportion = 0.55)), gen, "n57b3"))
  age_row <- mismatch$diagnostics$rows[[1]]
  ok <- ok && identical(by_position$diagnostics$rows[[1]]$state, "close") && identical(age_row$state, "not_comparable") && identical(age_row$reason, "kind_differs") &&
    identical(age_row$generatedKind, "continuous") && identical(mismatch$diagnostics$coverage$compared, 1L)
  list(pass = ok, detail = sprintf("a table equal to the population: %d rows close, no standard error without a reference size; levels by position agree; a binary reference row against a continuous variable: %s (%s)",
                                   length(rows), age_row$state, age_row$reason))
})

vcr_case("N57c", c("AC-08"), function() {
  # a job that can compare nothing says why instead of returning an empty comparison; a missing profile and a repeated variable are refused by name
  gen <- .n57_generated(.n57_population("n57c"))
  none <- vcr_test_run(.n57_job(list(list(variable = "stage", proportion = 0.2)), gen, "n57c1"))
  no_gen <- vcr_test_run(vcr_test_job("population.check", list(baselineTable = list(list(variable = "age", mean = 60, sd = 9))), seed = 1L, job_id = "job_n57c2"))
  dup <- vcr_test_run(.n57_job(list(list(variable = "age", mean = 60, sd = 9), list(variable = "age", mean = 61, sd = 9)), gen, "n57c3"))
  codes <- function(x) vcr_test_issue_codes(x)
  ok <- identical(none$status, "failed") && "scenario_value_invalid" %in% codes(none) &&
    identical(no_gen$status, "failed") && any(c("scenario_field_missing", "scenario_value_invalid") %in% codes(no_gen)) &&
    identical(dup$status, "failed") && "scenario_value_invalid" %in% codes(dup)
  list(pass = ok, detail = sprintf("nothing comparable: %s (%s); no generated profile: %s (%s); a repeated variable: %s (%s)",
                                   none$status, paste(codes(none), collapse = ","), no_gen$status, paste(codes(no_gen), collapse = ","), dup$status, paste(codes(dup), collapse = ",")))
})
