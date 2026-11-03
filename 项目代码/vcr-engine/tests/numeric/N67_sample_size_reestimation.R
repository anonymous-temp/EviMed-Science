# N67 — sample-size re-estimation (algorithm round T3, 2026-11-03): design.confirmatory, design.kind sample_size_reestimation.
#
# rpact simulates the adaptive trials, so the checks are not rpact:
#
#   a  the non-adaptive limit: a design that may grow by one patient only is a two-look group-sequential design, and its power and
#      expected size are the engine's own recursion (R/design_analytic.R, hand-written, Armitage-McPherson-Rowe on the B scale) at the
#      drift the planned size gives; the type I error is alpha
#   b  the conditional-power rule itself, written out in plain R (the inverse-normal combination of two independent stage statistics,
#      the second stage sized to reach the target conditional power at the interim estimate, within the planned second stage and the
#      cap): power, expected size and the probability of an increase at three effects against the job's own cells
#   c  the baselines beside it are what they say: the fixed design reaches the target power at the planned effect, the group-sequential
#      one too, and the table carries every effect with its iterations (the null is always a row)

.n67_scenario <- function(factor, effects = list(0.3), planned = 0.4, rates = c(0.5, 1), cp = 0.8) list(
  design = list(kind = "sample_size_reestimation", informationRates = rates, conditionalPower = cp, maxSampleSizeFactor = factor),
  endpoint = list(type = "continuous"), truth = list(plannedEffect = planned, effects = effects, sd = 1), analysis = list(alpha = 0.025, power = 0.9))
.n67_run <- function(sc, seed, id) vcr_test_run(vcr_test_job("design.confirmatory", sc, seed = seed, job_id = id))
.n67_row <- function(r, role_or_effect) {
  for (e in r$diagnostics$confirmatory$effects) if (isTRUE(all.equal(e$effect, role_or_effect)) || identical(e$role, role_or_effect)) return(e)
  NULL
}

vcr_case("N67a", c("AC-29", "AC-30"), function() {
  # a cap one patient above the plan (the factor must exceed 1; the engine raises the cap to plan + 1)
  r <- .n67_run(.n67_scenario(1.0001), 6701L, "job_n67a")
  plan <- r$diagnostics$confirmatory$plan
  gs <- vcr_group_sequential(c(0.5, 1), 0.025, "obrien_fleming")
  drift <- 0.4 * sqrt(plan$total / 4)               # the mean of the final statistic: effect / sd * sqrt(N / 4) for two equal arms
  ref <- vcr_group_sequential_power(gs, drift)
  pw <- vcr_get_measure(r, "power"); t1 <- vcr_get_measure(r, "type_one_error"); en <- vcr_get_measure(r, "expected_sample_size")
  ref_n <- plan$total * ref$expectedInformationFraction
  # one patient of room in the second stage moves the numbers by less than a Monte-Carlo error of these runs
  ok <- c(power = abs(pw$value - ref$power) <= 3 * pw$mcse + 0.003, size = abs(en$value - ref_n) <= 3 * en$mcse + 1.5, type1 = t1$value <= 0.025 + 3 * t1$mcse)
  list(pass = all(ok), detail = sprintf("planned size %s: power %.4f (+-%.4f) vs the engine's group-sequential recursion %.4f; expected size %.2f vs %.2f; type I error %.4f (+-%.4f)%s",
                                        plan$total, pw$value, pw$mcse, ref$power, en$value, ref_n, t1$value, t1$mcse, if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

vcr_case("N67b", c("AC-29", "AC-31"), function() {
  r <- .n67_run(.n67_scenario(2, effects = list(0.2, 0.3)), 6702L, "job_n67b")
  plan <- r$diagnostics$confirmatory$plan
  gs <- vcr_group_sequential(c(0.5, 1), 0.025, "obrien_fleming")
  c1 <- gs$criticalValues[1]; c2 <- gs$criticalValues[2]
  w1 <- sqrt(0.5); w2 <- sqrt(0.5)
  n1 <- plan$first; n2_plan <- plan$total - plan$first; cap <- plan$cap
  reference <- function(delta, reps = 300000L, seed = 6703L) {
    set.seed(seed, kind = "L'Ecuyer-CMRG")
    z1 <- stats::rnorm(reps, delta * sqrt(n1) / 2, 1)
    est <- z1 * 2 / sqrt(n1)                                    # the interim estimate of the effect (sd 1, two equal arms)
    stop1 <- z1 >= c1
    need <- ifelse(est > 0, (2 * ((c2 - w1 * z1) / w2 + stats::qnorm(0.8)) / pmax(est, 1e-12))^2, Inf)
    n2 <- pmin(pmax(need, n2_plan), cap - n1)
    z2 <- stats::rnorm(reps, delta * sqrt(n2) / 2, 1)
    reject <- stop1 | (w1 * z1 + w2 * z2 > c2)
    size <- n1 + ifelse(stop1, 0, n2)
    list(power = mean(reject), power_se = sqrt(mean(reject) * (1 - mean(reject)) / reps), size = mean(size), size_se = stats::sd(size) / sqrt(reps),
         increase = mean(!stop1 & n2 > n2_plan + 1e-9), increase_se = sqrt(mean(!stop1 & n2 > n2_plan + 1e-9) * (1 - mean(!stop1 & n2 > n2_plan + 1e-9)) / reps))
  }
  worst <- 0; text <- character()
  for (delta in c(0, 0.2, 0.3, 0.4)) {
    row <- .n67_row(r, delta); ref <- reference(delta)
    cells <- row$cells
    pw <- cells[[if (delta == 0) "type_one_error" else "power"]]; en <- cells$expected_sample_size; inc <- cells$increase_probability
    z <- c(abs(pw$value - ref$power) / sqrt(pw$mcse^2 + ref$power_se^2), abs(en$value - ref$size) / sqrt(en$mcse^2 + ref$size_se^2),
           abs(inc$value - ref$increase) / sqrt(inc$mcse^2 + ref$increase_se^2))
    worst <- max(worst, z)
    text <- c(text, sprintf("effect %.1f: power %.4f/%.4f, expected size %.1f/%.1f, increase %.3f/%.3f", delta, pw$value, ref$power, en$value, ref$size, inc$value, ref$increase))
  }
  list(pass = worst < 4, detail = sprintf("job / plain-R rule: %s; worst %.2f combined standard errors (tol 4)", paste(text, collapse = "; "), worst))
})

vcr_case("N67c", c("AC-10", "AC-29"), function() {
  r <- .n67_run(.n67_scenario(2, effects = list(0.2, 0.3)), 6702L, "job_n67c")
  conf <- r$diagnostics$confirmatory
  roles <- vapply(conf$effects, function(e) e$role, character(1))
  planned <- Filter(function(e) identical(e$role, "planned"), conf$effects)[[1]]
  null <- Filter(function(e) identical(e$role, "null"), conf$effects)[[1]]
  iterations <- vapply(conf$effects, function(e) e$iterations, numeric(1))
  assumed <- vapply(conf$assumed, function(a) a$key, character(1))
  ok <- c(rows = identical(roles, c("null", "assumed", "assumed", "planned")), floors = all(iterations[roles == "null"] >= 20000, iterations[roles != "null"] >= 5000),
          fixed = abs(planned$fixed$power - 0.9) < 1e-3, gs = abs(planned$groupSequential$power - 0.9) < 1e-3,
          null_row = abs(null$fixed$power - 0.025) < 1e-9 && abs(null$groupSequential$power - 0.025) < 1e-4,
          stated = all(c("truth.effects", "design.plannedSize") %in% assumed), baselines = !is.null(conf$baselines$fixed$size) && !is.null(conf$baselines$groupSequential$maxSize))
  list(pass = all(ok), detail = sprintf("rows %s with %s iterations; fixed power at the planned effect %.4f, group sequential %.4f; the null was %s; assumptions listed: %s%s",
                                        paste(roles, collapse = "/"), paste(iterations, collapse = "/"), planned$fixed$power, planned$groupSequential$power, "added and said so", paste(assumed, collapse = ", "),
                                        if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})
