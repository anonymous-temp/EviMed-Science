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
#   d  the promising zone (T3, completed in design.confirmatory 1.1.0): the same two-stage rule written in plain R on the statistic with the
#      extra condition "the conditional power of the planned second stage lies between the bounds", at the null and three effects; the type I
#      error at the null equals alpha (the zone looks at the first stage only, so the inverse-normal combination keeps the level); and the
#      share of null trials that are enlarged falls from the plain rule's to the zone's
#   e  the zone function is the plain rule with a condition in front of it: a zone spanning 0 to 1 reproduces rpact's own conditional-power
#      rule row for row (continuous, binary, event time), and a zone that no trial can be in keeps the planned size everywhere
#   f  the zone for a binary and an event-time endpoint, each against the rule written out in plain R on its statistic (the pooled-variance
#      z of two binomials; the log-rank statistic with 1:1 allocation, drift -log(HR) sqrt(d) / 2)

.n67_scenario <- function(factor, effects = list(0.3), planned = 0.4, rates = c(0.5, 1), cp = 0.8, zone = NULL) list(
  design = c(list(kind = "sample_size_reestimation", informationRates = rates, conditionalPower = cp, maxSampleSizeFactor = factor),
             if (!is.null(zone)) list(promisingZone = zone)),
  endpoint = list(type = "continuous"), truth = list(plannedEffect = planned, effects = effects, sd = 1), analysis = list(alpha = 0.025, power = 0.9))
.n67_run <- function(sc, seed, id) vcr_test_run(vcr_test_job("design.confirmatory", vcr_test_conf_scenario(sc), seed = seed, job_id = id))
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

# --- the promising zone ------------------------------------------------------------------------------------

# Rows of a job's table against a reference list(power, power_se, size, size_se, increase, increase_se), as combined standard errors.
.n67_z <- function(row, ref, null_value) {
  cells <- row$cells
  pw <- cells[[if (abs(row$effect - null_value) < 1e-9) "type_one_error" else "power"]]
  en <- cells$expected_sample_size %||% cells$expected_events; inc <- cells$increase_probability
  c(abs(pw$value - ref$power) / sqrt(pw$mcse^2 + ref$power_se^2), abs(en$value - ref$size) / sqrt(en$mcse^2 + ref$size_se^2),
    abs(inc$value - ref$increase) / sqrt(inc$mcse^2 + ref$increase_se^2))
}
.n67_summary <- function(row, ref, null_value) {
  cells <- row$cells
  pw <- cells[[if (abs(row$effect - null_value) < 1e-9) "type_one_error" else "power"]]
  en <- cells$expected_sample_size %||% cells$expected_events; inc <- cells$increase_probability
  sprintf("effect %.2f: power %.4f/%.4f, expected size %.1f/%.1f, enlarged %.3f/%.3f", row$effect, pw$value, ref$power, en$value, ref$size, inc$value, ref$increase)
}
.n67_ref <- function(reject, size, increase) {
  reps <- length(reject)
  list(power = mean(reject), power_se = sqrt(mean(reject) * (1 - mean(reject)) / reps), size = mean(size), size_se = stats::sd(size) / sqrt(reps),
       increase = mean(increase), increase_se = sqrt(mean(increase) * (1 - mean(increase)) / reps))
}

vcr_case("N67d", c("AC-29", "AC-31"), function() {
  zone <- list(lower = 0.36, upper = 0.8)
  r <- .n67_run(.n67_scenario(2, effects = list(0.2, 0.3), zone = zone), 6711L, "job_n67d")
  plan <- r$diagnostics$confirmatory$plan
  gs <- vcr_group_sequential(c(0.5, 1), 0.025, "obrien_fleming")
  c1 <- gs$criticalValues[1]; c2 <- gs$criticalValues[2]; w1 <- sqrt(0.5); w2 <- sqrt(0.5)
  n1 <- plan$first; n2_plan <- plan$total - plan$first; cap <- plan$cap
  reference <- function(delta, reps = 300000L, seed = 6703L) {
    set.seed(seed, kind = "L'Ecuyer-CMRG")
    z1 <- stats::rnorm(reps, delta * sqrt(n1) / 2, 1)
    est <- z1 * 2 / sqrt(n1)                                  # the interim estimate of the effect (sd 1, two equal arms)
    stop1 <- z1 >= c1
    cc <- (c2 - w1 * z1) / w2                                 # the conditional critical value of the second stage
    cp_plan <- stats::pnorm(est / 2 * sqrt(n2_plan) - cc)     # conditional power of the PLANNED second stage at the interim estimate
    need <- ifelse(est > 0, (2 * (cc + stats::qnorm(0.8)) / pmax(est, 1e-12))^2, Inf)
    in_zone <- cp_plan >= zone$lower & cp_plan <= zone$upper
    n2 <- ifelse(in_zone, pmin(pmax(need, n2_plan), cap - n1), n2_plan)
    z2 <- stats::rnorm(reps, delta * sqrt(n2) / 2, 1)
    reject <- stop1 | (w1 * z1 + w2 * z2 > c2)
    .n67_ref(reject, n1 + ifelse(stop1, 0, n2), !stop1 & n2 > n2_plan + 1e-9)
  }
  worst <- 0; text <- character()
  for (delta in c(0, 0.2, 0.3, 0.4)) {
    row <- .n67_row(r, delta); ref <- reference(delta)
    worst <- max(worst, .n67_z(row, ref, 0)); text <- c(text, .n67_summary(row, ref, 0))
  }
  # the level: the zone reads the first stage only, so the combination test keeps alpha exactly
  null <- .n67_row(r, "null"); t1 <- null$cells$type_one_error
  # and the zone enlarges fewer null trials than the plain rule does (the 97% of the rule without it)
  plain <- .n67_run(.n67_scenario(2, effects = list(0.2, 0.3)), 6711L, "job_n67d2")
  plain_inc <- .n67_row(plain, "null")$cells$increase_probability
  zone_inc <- null$cells$increase_probability
  ok <- c(rule = worst < 4, level = abs(t1$value - 0.025) <= 3 * t1$mcse, fewer = zone_inc$value + 3 * zone_inc$mcse < plain_inc$value)
  list(pass = all(ok), detail = sprintf("job / plain-R zone rule [%.2f, %.2f]: %s; worst %.2f combined standard errors (tol 4); type I error %.4f (+-%.4f) against alpha 0.025; null trials enlarged %.3f with the zone against %.3f without%s",
                                        zone$lower, zone$upper, paste(text, collapse = "; "), worst, t1$value, t1$mcse, zone_inc$value, plain_inc$value,
                                        if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

vcr_case("N67e", c("AC-29", "AC-30"), function() {
  inv <- vcr_rpact_inverse_normal(c(0.5, 1), 0.025)
  accrual <- list(duration = 12, dropoutAnnual = 0.05, perYear = 12, maxSubjects = 900L)
  text <- character(); ok <- logical()
  check <- function(endpoint, label, effect, planned, cap, take, ...) {
    run <- function(zone = NULL) vcr_rpact_sim_reestimation(endpoint, inv, effect, planned, cap, 0.8, 0.5, take, 4711L, zone = zone, ...)
    plain <- run(); wide <- run(list(lower = 0, upper = 1)); none <- run(list(lower = 1 - 1e-9, upper = 1))
    # the second stage of a trial is enlarged when it is bigger than planned (events for an event-time endpoint, else the cumulated patients)
    col <- if (endpoint == "time_to_event") "eventsPerStage" else "numberOfCumulatedSubjects"
    grew <- function(d) { s2 <- d[d$stageNumber == 2L, ]; sum(s2[[col]] > if (endpoint == "time_to_event") planned[2L] - planned[1L] + 1e-9 else planned[2L] + 1e-9) }
    ok <<- c(ok, identical(plain, wide), grew(plain) > 0, grew(none) == 0L)
    text <<- c(text, sprintf("%s: zone 0..1 %s the plain rule (%d of %d trials enlarged), a zone no trial can be in leaves %d enlarged", label,
                             if (identical(plain, wide)) "equals" else "DIFFERS FROM", grew(plain), take, grew(none)))
  }
  check("continuous", "continuous", 0.2, c(200, 400), 800, 3000L, sd = 1)
  check("binary", "binary", 0.1, c(200, 400), 800, 3000L, control_rate = 0.35)
  check("time_to_event", "event time", 0.8, c(100, 200), 400, 400L, control_median = 12, accrual = accrual)
  list(pass = all(ok), detail = paste(text, collapse = "; "))
})

vcr_case("N67f", c("AC-29", "AC-31"), function() {
  zone <- list(lower = 0.36, upper = 0.8)
  gs <- vcr_group_sequential(c(0.5, 1), 0.025, "obrien_fleming")
  c1 <- gs$criticalValues[1]; c2 <- gs$criticalValues[2]; w1 <- sqrt(0.5); w2 <- sqrt(0.5)
  worst <- 0; text <- character()
  # binary: the stage statistic is the pooled-variance z of two binomials; the size rule uses the Farrington-Manning variances under the
  # null (the pooled rate for both arms) and at the observed rates, and the conditional power of the planned stage follows from them
  pc <- 0.35
  rb <- .n67_run(list(design = list(kind = "sample_size_reestimation", informationRates = c(0.5, 1), conditionalPower = 0.8, maxSampleSizeFactor = 2, plannedSize = 400, promisingZone = zone),
                      endpoint = list(type = "binary"), truth = list(plannedEffect = 0.15, effects = list(0.1), controlRate = pc), analysis = list(alpha = 0.025, power = 0.9)), 6712L, "job_n67f1")
  plan <- rb$diagnostics$confirmatory$plan
  n1 <- plan$first; n2_plan <- plan$total - plan$first; cap <- plan$cap
  ref_binary <- function(delta, reps = 200000L, seed = 6704L) {
    set.seed(seed, kind = "L'Ecuyer-CMRG")
    m <- n1 / 2
    xt <- stats::rbinom(reps, m, pc + delta); xc <- stats::rbinom(reps, m, pc)
    pt <- xt / m; pcc <- xc / m; pbar <- (xt + xc) / (2 * m)
    z1 <- (pt - pcc) / sqrt(pbar * (1 - pbar) * 2 / m); z1[!is.finite(z1)] <- 0
    stop1 <- z1 >= c1
    cc <- (c2 - w1 * z1) / w2
    eff <- pt - pcc; v0 <- 2 * pbar * (1 - pbar); v1 <- pt * (1 - pt) + pcc * (1 - pcc)
    cp_plan <- stats::pnorm((eff * sqrt(n2_plan / 2) - cc * sqrt(v0)) / sqrt(v1))
    need <- 2 * pmax(0, cc * sqrt(v0) + stats::qnorm(0.8) * sqrt(v1))^2 / pmax(1e-12, eff)^2
    n2 <- ifelse(is.finite(cp_plan) & cp_plan >= zone$lower & cp_plan <= zone$upper, ceiling(pmin(pmax(need, n2_plan), cap - n1)), n2_plan)
    m2 <- round(n2 / 2)
    xt2 <- stats::rbinom(reps, m2, pc + delta); xc2 <- stats::rbinom(reps, m2, pc)
    pb2 <- (xt2 + xc2) / (2 * m2)
    z2 <- (xt2 / m2 - xc2 / m2) / sqrt(pb2 * (1 - pb2) * 2 / m2); z2[!is.finite(z2)] <- 0
    .n67_ref(stop1 | (w1 * z1 + w2 * z2 > c2), n1 + ifelse(stop1, 0, n2), !stop1 & n2 > n2_plan + 1e-9)
  }
  for (delta in c(0, 0.1, 0.15)) {
    row <- .n67_row(rb, delta); ref <- ref_binary(delta)
    worst <- max(worst, .n67_z(row, ref, 0)); text <- c(text, paste("binary", .n67_summary(row, ref, 0)))
  }
  # event time: the log-rank statistic of d events (1:1) is N(-log(HR) sqrt(d) / 2, 1), the interim estimate of the drift is z1 / sqrt(d1),
  # and the second stage is sized from it the way the means rule is
  rt <- .n67_run(list(design = list(kind = "sample_size_reestimation", informationRates = c(0.5, 1), conditionalPower = 0.8, maxSampleSizeFactor = 2, promisingZone = zone),
                      endpoint = list(type = "time_to_event"), truth = list(plannedEffect = 0.7, effects = list(0.8, 0.7), controlMedian = 12), analysis = list(alpha = 0.025, power = 0.9),
                      accrual = list(duration = 12, followup = 12, dropoutAnnual = 0.05)), 6713L, "job_n67f2")
  plan <- rt$diagnostics$confirmatory$plan
  d1 <- plan$first; d2_plan <- plan$total - plan$first; cap <- plan$cap
  ref_events <- function(hr, reps = 300000L, seed = 6705L) {
    set.seed(seed, kind = "L'Ecuyer-CMRG")
    drift <- -log(hr) / 2
    z1 <- stats::rnorm(reps, drift * sqrt(d1), 1)
    stop1 <- z1 >= c1
    cc <- (c2 - w1 * z1) / w2
    theta <- z1 / sqrt(d1)
    cp_plan <- stats::pnorm(theta * sqrt(d2_plan) - cc)
    need <- pmax(0, cc + stats::qnorm(0.8))^2 / pmax(1e-12, theta)^2
    n2 <- ifelse(cp_plan >= zone$lower & cp_plan <= zone$upper, pmin(pmax(need, d2_plan), cap - d1), d2_plan)
    z2 <- stats::rnorm(reps, drift * sqrt(n2), 1)
    .n67_ref(stop1 | (w1 * z1 + w2 * z2 > c2), d1 + ifelse(stop1, 0, n2), !stop1 & n2 > d2_plan + 1e-9)
  }
  for (hr in c(1, 0.8, 0.7)) {
    row <- .n67_row(rt, hr); ref <- ref_events(hr)
    worst <- max(worst, .n67_z(row, ref, 1)); text <- c(text, paste("event time", .n67_summary(row, ref, 1)))
  }
  list(pass = worst < 4, detail = sprintf("job / plain-R rule on the statistic, zone [%.2f, %.2f]: %s; worst %.2f combined standard errors (tol 4; the event-time reference is the normal approximation of the log-rank statistic, rpact simulates patients)",
                                          zone$lower, zone$upper, paste(text, collapse = "; "), worst))
})
