# N68 — multi-arm selection, enrichment and counts (algorithm round T4, T5, T6, 2026-11-03): design.confirmatory,
# design.kind multi_arm_selection, enrichment and count_endpoint.
#
# rpact simulates the selection designs and sizes the count endpoint, so the checks are not rpact:
#
#   a  the probability that each arm is the one selected at the interim: the arm with the largest estimate wins, the statistics of the
#      arms are correlated 1/2 through the shared control, and the probability is a multivariate normal rectangle (mvtnorm, the
#      engine's own integration library), against the job's simulated "selected" cell of every arm, within three Monte-Carlo errors and
#      the probability that the trial stopped before the selection
#   b  the familywise type I error under the global null is at most alpha (the multiplicity is the closing of the intersection tests)
#      and no arm's own hypothesis is rejected more often than that
#   c  the biomarker subset is the population kept when its interim estimate exceeds the rest's: Phi((effect_S - effect_R) / sqrt(v_S + v_R)),
#      v_g = 4 sd^2 / (patients of the group at the interim), against the job's "selected subset" cell
#   d  the negative-binomial sample size of a rate ratio against the closed form of Zhu & Lakkis (2014), and a group-sequential count
#      design against gsDesign's inflation over the fixed design
#   e  the event-time multi-arm selection (T4, design.confirmatory 1.1.0): the probability that each arm is the one kept at the interim
#      against the closed form (the log-rank statistics of arms that share a control are correlated through the control's events, Deng et
#      al. 2019; mvtnorm) and against a patient-level simulation in plain R (exponential times, the first d1 events, the Peto log hazard
#      ratio of every arm against the control, the arm with the smallest is kept)
#   f  the event-time familywise error under the global null (all hazard ratios 1) is at most alpha, Simes and Bonferroni, and no arm is
#      rejected more often than that
#   g  the event-time enrichment (T5): the probability that the biomarker subset is the population kept, Phi((log HR_R - log HR_S) /
#      sqrt(4 / d_S + 4 / d_R)) with the events each group contributes at the interim, against a patient-level simulation in plain R
#   h  the event-time enrichment's familywise error under the global null
#
#   i  the share of trials that stop at the first look (`early_stop_probability`), of both selection designs, against rpact's own `earlyStop`
#      of the same simulation call, and against the identity that every trial either stopped at the first look or went on with exactly one
#      arm (population) selected: (selected shares) + (stopped at the first look) = 1. The cell once counted the trials in which ANY
#      hypothesis was rejected at the first look, which are mostly trials that go on (0.77 against 0.0002 with one effective arm of three), and
#      the lower bounds of a, c, e and g subtracted it: the slack grew with the error
#
# MAMS (the multi-arm multi-stage package) is not run here and is not claimed: it computes the operating characteristics of a different
# procedure (stage-wise upper and lower bounds on the largest of the arms' cumulative statistics, no selection of the best arm and no
# closure of Dunnett or Simes tests), so at one design it could agree with these designs only where both equal alpha. The closed forms
# above and the simulation in plain R are what hold the selection designs; N68a/N68e are the quantities that distinguish them.

.n68_run <- function(sc, seed, id) vcr_test_run(vcr_test_job("design.confirmatory", sc, seed = seed, job_id = id))
.n68_row <- function(r, match) {
  for (e in r$diagnostics$confirmatory$effects) if (match(e)) return(e)
  NULL
}

vcr_case("N68a", c("AC-29", "AC-30"), function() {
  if (!requireNamespace("mvtnorm", quietly = TRUE)) stop("N68 requires the locked mvtnorm library")
  arms <- 3L; per_arm <- 80L; n1 <- 40L
  scenarios <- list(c(0.05, 0.1, 0.2), c(0.6, 0.7, 0.8))          # the second stops at the first look in about a quarter of the trials
  r <- .n68_run(list(design = list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = arms, plannedSize = per_arm),
                     endpoint = list(type = "continuous"), truth = list(effectScenarios = lapply(scenarios, as.list), sd = 1)), 6801L, "job_n68a")
  pass <- TRUE; text <- character()
  for (effects in scenarios) {
    row <- .n68_row(r, function(e) identical(e$role, "assumed") && isTRUE(all.equal(unlist(e$effect), effects)))
    mu <- effects * sqrt(n1 / 2)                              # the mean of each arm's statistic against the shared control
    selection <- vapply(seq_len(arms), function(j) {
      others <- setdiff(seq_len(arms), j)
      corr <- matrix(0.5, length(others), length(others)); diag(corr) <- 1
      mvtnorm::pmvnorm(lower = rep(-Inf, length(others)), upper = rep(0, length(others)), mean = mu[others] - mu[j], corr = corr)[1]
    }, numeric(1))
    early <- row$cells$early_stop_probability
    jobs <- vapply(seq_len(arms), function(j) row$cells[[sprintf("selected_arm_%d", j)]]$value, numeric(1))
    mcse <- vapply(seq_len(arms), function(j) row$cells[[sprintf("selected_arm_%d", j)]]$mcse, numeric(1))
    # the job counts an arm as selected only when the trial went on to the second stage: at most the closed-form probability, and short of
    # it by no more than the probability of having stopped at the interim; and every trial either stopped or went on with one arm
    ok <- jobs <= selection + 3 * mcse & jobs >= selection - early$value - 3 * mcse
    pass <- pass && all(ok) && abs(sum(selection) - 1) < 1e-6 && abs(sum(jobs) + early$value - 1) < 1e-9
    text <- c(text, sprintf("effects %s: probability each arm is selected, job %s vs mvtnorm %s (stopped at the interim %.3f, selected + stopped = %.6f)",
                            paste(effects, collapse = "/"), paste(sprintf("%.3f", jobs), collapse = "/"), paste(sprintf("%.3f", selection), collapse = "/"), early$value, sum(jobs) + early$value))
  }
  list(pass = pass, detail = sprintf("%d per arm at the interim: %s; iterations %d", n1, paste(text, collapse = "; "), row$iterations))
})

vcr_case("N68b", c("AC-29"), function() {
  alpha <- 0.025
  out <- character(); ok <- logical()
  for (test in c("simes", "bonferroni")) {
    r <- .n68_run(list(design = list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 60, intersectionTest = test),
                       endpoint = list(type = "continuous"), truth = list(effectScenarios = list(list(0.4, 0.4, 0.4)), sd = 1)), 6802L, "job_n68b")
    null <- .n68_row(r, function(e) identical(e$role, "null"))
    t1 <- null$cells$type_one_error
    arm_max <- max(vapply(1:3, function(j) null$cells[[sprintf("reject_arm_%d", j)]]$value, numeric(1)))
    ok <- c(ok, t1$value <= alpha + 3 * t1$mcse, arm_max <= alpha + 3 * t1$mcse)
    out <- c(out, sprintf("%s: familywise %.4f (+-%.4f), largest single arm %.4f", test, t1$value, t1$mcse, arm_max))
  }
  list(pass = all(ok), detail = sprintf("global null, %s (limit alpha %.3f + 3 errors)", paste(out, collapse = "; "), alpha))
})

vcr_case("N68c", c("AC-29", "AC-30"), function() {
  p <- 0.4; total <- 100L; n1 <- total / 2
  scen <- list(list(subset = 0.6, rest = 0), list(subset = 0.4, rest = 0.4), list(subset = 0.5, rest = 0.2))
  r <- .n68_run(list(design = list(kind = "enrichment", informationRates = c(0.5, 1), subsetPrevalence = p, plannedSize = total),
                     endpoint = list(type = "continuous"), truth = list(subsetEffects = scen, sd = 1)), 6803L, "job_n68c")
  worst <- 0; text <- character()
  for (s in scen) {
    row <- .n68_row(r, function(e) identical(e$role, "assumed") && isTRUE(all.equal(unlist(e$effect), c(subset = s$subset, rest = s$rest))))
    v_s <- 4 / (p * n1); v_r <- 4 / ((1 - p) * n1)
    closed <- stats::pnorm((s$subset - s$rest) / sqrt(v_s + v_r))
    cell <- row$cells$selected_subset; early <- row$cells$early_stop_probability$value
    # a subset that was kept and the trial then went on, so the job's cell is at most the closed form and short of it by the early stops
    z <- max(0, cell$value - closed, closed - early - cell$value) / cell$mcse
    # and every trial either stopped at the first look or went on with exactly one of the two populations
    z <- max(z, 1e9 * abs(cell$value + row$cells$selected_full$value + early - 1))
    worst <- max(worst, z)
    text <- c(text, sprintf("(%.1f, %.1f): subset kept %.3f vs closed form %.3f (stopped early %.3f)", s$subset, s$rest, cell$value, closed, early))
  }
  null <- .n68_row(r, function(e) identical(e$role, "null"))
  fam <- null$cells$type_one_error
  list(pass = worst < 3.5 && fam$value <= 0.025 + 3 * fam$mcse, detail = sprintf("%s; worst %.2f errors outside the closed-form band (tol 3.5); familywise type I error %.4f (+-%.4f)", paste(text, collapse = "; "), worst, fam$value, fam$mcse))
})

vcr_case("N68d", c("AC-29", "AC-30"), function() {
  if (!requireNamespace("gsDesign", quietly = TRUE)) stop("N68 requires the locked gsDesign library")
  za <- stats::qnorm(0.975); zb <- stats::qnorm(0.9)
  closed <- function(lambda1, lambda0, k, t = 1, r = 1) {
    n0 <- (za + zb)^2 * ((1 / (lambda0 * t) + k) + (1 / (lambda1 * t) + k) / r) / log(lambda1 / lambda0)^2
    c(control = ceiling(n0), treatment = ceiling(r * n0))
  }
  worst <- 0; text <- character()
  for (case in list(c(0.4, 0.6, 0.5), c(1.2, 1.8, 0.8), c(0.25, 0.5, 1.5))) {
    lambda1 <- case[1]; lambda0 <- case[2]; k <- case[3]
    r <- .n68_run(list(design = list(kind = "count_endpoint"), truth = list(controlEventRate = lambda0, rateRatio = lambda1 / lambda0, overdispersion = k, exposureTime = 1)), 6804L, "job_n68d")
    got <- c(control = vcr_measure_value(r, "required_control"), treatment = vcr_measure_value(r, "required_treatment"))
    want <- closed(lambda1, lambda0, k)
    worst <- max(worst, abs(got - want))
    text <- c(text, sprintf("rates %.2f vs %.2f, dispersion %.1f: %d per arm (closed form %d)", lambda1, lambda0, k, got[["control"]], want[["control"]]))
  }
  seq_ <- .n68_run(list(design = list(kind = "count_endpoint", informationRates = c(0.5, 1)), truth = list(controlEventRate = 0.6, rateRatio = 0.4 / 0.6, overdispersion = 0.5, exposureTime = 1)), 6805L, "job_n68d2")
  inflation <- vcr_measure_value(seq_, "max_patients") / vcr_measure_value(seq_, "required_total")
  ref <- gsDesign::gsDesign(k = 2, test.type = 1, alpha = 0.025, beta = 0.1, timing = c(0.5, 1), sfu = gsDesign::sfLDOF, n.fix = 1)$n.I[2]
  list(pass = worst <= 1 && abs(inflation - ref) < 0.01,
       detail = sprintf("%s; largest difference %d patient; group sequential size / fixed size %.4f vs gsDesign inflation %.4f", paste(text, collapse = "; "), worst, inflation, ref))
})

# --- the event-time designs (design.confirmatory 1.1.0) --------------------------------------------------------------

# One patient-level interim of an event-time trial in plain R: `hazards` are the hazards of the groups (the control first) with `n` patients
# each, all at risk from time 0; the first `d1` events (in time order) form the interim. Returns the group of each event, in order.
.n68_first_events <- function(hazards, n, d1) {
  t <- unlist(lapply(hazards, function(h) stats::rexp(n, h)))
  group <- rep(seq_along(hazards), each = n)
  group[order(t)[seq_len(d1)]]
}
# The Peto log hazard ratio (O - E) / V of the second group against the first from the events of those two groups in time order (nobody
# is censored before the interim: the at-risk numbers fall by the events only).
.n68_peto <- function(is_treated, n_treated, n_control) {
  nt <- n_treated - c(0, cumsum(is_treated))[seq_along(is_treated)]
  nc <- n_control - c(0, cumsum(1 - is_treated))[seq_along(is_treated)]
  e <- nt / (nt + nc); v <- nt * nc / (nt + nc)^2
  sum(is_treated - e) / sum(v)
}

vcr_case("N68e", c("AC-29", "AC-30"), function() {
  if (!requireNamespace("mvtnorm", quietly = TRUE)) stop("N68 requires the locked mvtnorm library")
  omega <- c(0.95, 0.85, 0.75); arms <- 3L; total <- 240L; d1 <- total / 2
  r <- .n68_run(list(design = list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = arms, plannedSize = total),
                     endpoint = list(type = "time_to_event"), truth = list(effectScenarios = list(as.list(omega)))), 6811L, "job_n68e")
  row <- .n68_row(r, function(e) identical(e$role, "assumed"))
  # closed form: with 1:1 allocation the events of the comparison of arm j are E_j = d1 (1 + w_j) / (1 + sum w) (the arms' events are in
  # proportion to their hazards), its statistic is N(-log(w_j) sqrt(E_j) / 2, 1), two statistics share the control's events (correlation
  # sqrt(w_i w_j / ((1 + w_i)(1 + w_j)))), and the arm with the smallest estimated log hazard ratio, -2 Z_j / sqrt(E_j), is kept
  events <- d1 * (1 + omega) / (1 + sum(omega))
  corr <- outer(seq_len(arms), seq_len(arms), function(i, j) ifelse(i == j, 1, sqrt(omega[i] * omega[j] / ((1 + omega[i]) * (1 + omega[j])))))
  mean_w <- -log(omega) / 2                              # the mean of Z_j / sqrt(E_j)
  cov_w <- corr / outer(sqrt(events), sqrt(events))
  closed <- vapply(seq_len(arms), function(j) {
    contrast <- matrix(0, arms - 1L, arms); contrast[cbind(seq_len(arms - 1L), j)] <- 1; contrast[cbind(seq_len(arms - 1L), setdiff(seq_len(arms), j))] <- -1
    mvtnorm::pmvnorm(lower = rep(0, arms - 1L), upper = rep(Inf, arms - 1L), mean = as.numeric(contrast %*% mean_w), sigma = contrast %*% cov_w %*% t(contrast))[1]
  }, numeric(1))
  # patient level: 2000 patients per group, the hazard of the control is ln2 / 12 (only the ratios matter)
  set.seed(6812, kind = "L'Ecuyer-CMRG")
  reps <- 6000L; n <- 2000L; hazards <- log(2) / 12 * c(1, omega)
  kept <- replicate(reps, {
    group <- .n68_first_events(hazards, n, d1)
    which.min(vapply(seq_len(arms), function(j) { g <- group[group %in% c(1L, j + 1L)]; .n68_peto(as.numeric(g == j + 1L), n, n) }, numeric(1)))
  })
  plain <- tabulate(kept, arms) / reps; plain_se <- sqrt(plain * (1 - plain) / reps)
  early <- row$cells$early_stop_probability
  jobs <- vapply(seq_len(arms), function(j) row$cells[[sprintf("selected_arm_%d", j)]]$value, numeric(1))
  mcse <- vapply(seq_len(arms), function(j) row$cells[[sprintf("selected_arm_%d", j)]]$mcse, numeric(1))
  # the job counts an arm as kept only when the trial went on to the second stage: at most the probability of being selected, and short of it
  # by no more than the probability of having stopped at the interim
  ok <- c(job = all(jobs <= closed + 3 * mcse & jobs >= closed - early$value - 3 * mcse), model = all(abs(plain - closed) <= 4 * plain_se), sums = abs(sum(closed) - 1) < 1e-6,
          stopped = abs(sum(jobs) + early$value - 1) < 1e-9)
  list(pass = all(ok), detail = sprintf("hazard ratios %s, %d events at the interim: probability each arm is kept, job %s vs mvtnorm %s vs patient-level simulation %s (+-%.3f; %d trials), stopped at the interim %.3f; iterations %d%s",
                                        paste(omega, collapse = "/"), d1, paste(sprintf("%.3f", jobs), collapse = "/"), paste(sprintf("%.3f", closed), collapse = "/"),
                                        paste(sprintf("%.3f", plain), collapse = "/"), max(plain_se), reps, early$value, row$iterations,
                                        if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

vcr_case("N68f", c("AC-29"), function() {
  alpha <- 0.025
  out <- character(); ok <- logical()
  for (test in c("simes", "bonferroni")) {
    r <- .n68_run(list(design = list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 120, intersectionTest = test),
                       endpoint = list(type = "time_to_event"), truth = list(effectScenarios = list(list(1, 1, 1)))), 6813L, "job_n68f")
    null <- .n68_row(r, function(e) identical(e$role, "null"))
    t1 <- null$cells$type_one_error
    arm_max <- max(vapply(1:3, function(j) null$cells[[sprintf("reject_arm_%d", j)]]$value, numeric(1)))
    ok <- c(ok, t1$value <= alpha + 3 * t1$mcse, arm_max <= alpha + 3 * t1$mcse, null$cells$expected_events$value > 0)
    out <- c(out, sprintf("%s: familywise %.4f (+-%.4f), largest single arm %.4f", test, t1$value, t1$mcse, arm_max))
  }
  list(pass = all(ok), detail = sprintf("event time, global null (all hazard ratios 1), %s (limit alpha %.3f + 3 errors)", paste(out, collapse = "; "), alpha))
})

vcr_case("N68g", c("AC-29", "AC-30"), function() {
  p <- 0.4; total <- 240L; d1 <- total / 2
  scen <- list(list(subset = 0.8, rest = 0.95), list(subset = 0.9, rest = 0.9), list(subset = 0.75, rest = 0.9))
  r <- .n68_run(list(design = list(kind = "enrichment", informationRates = c(0.5, 1), subsetPrevalence = p, plannedSize = total),
                     endpoint = list(type = "time_to_event"), truth = list(subsetEffects = scen)), 6814L, "job_n68g")
  set.seed(6815, kind = "L'Ecuyer-CMRG")
  reps <- 4000L; n <- 4000L; n_s <- round(p * n); n_r <- n - n_s
  worst <- 0; model <- 0; text <- character()
  for (s in scen) {
    row <- .n68_row(r, function(e) identical(e$role, "assumed") && isTRUE(all.equal(unlist(e$effect), c(subset = s$subset, rest = s$rest))))
    # the events each group contributes at the interim are in proportion to its share of the patients and (1 + hazard ratio): 1:1 allocation
    share <- c(p, 1 - p) * (1 + c(s$subset, s$rest)); events <- d1 * share / sum(share)
    closed <- stats::pnorm((log(s$rest) - log(s$subset)) / sqrt(4 / events[1] + 4 / events[2]))
    # patient level: the subset and the rest each randomized 1:1, the control hazard the same in both
    kept <- replicate(reps, {
      stratum <- c(rep(1L, n_s), rep(2L, n_r)); treated <- c(rep(0:1, length.out = n_s), rep(0:1, length.out = n_r))
      hazard <- log(2) / 12 * ifelse(treated == 1L, ifelse(stratum == 1L, s$subset, s$rest), 1)
      first <- order(stats::rexp(n, hazard))[seq_len(d1)]
      est <- vapply(1:2, function(k) { idx <- first[stratum[first] == k]; .n68_peto(treated[idx], sum(stratum == k & treated == 1L), sum(stratum == k & treated == 0L)) }, numeric(1))
      est[1] < est[2]
    })
    plain <- mean(kept); plain_se <- sqrt(plain * (1 - plain) / reps)
    cell <- row$cells$selected_subset; early <- row$cells$early_stop_probability$value
    # kept and the trial went on: at most the closed form, and short of it by the early stops
    z <- max(0, cell$value - closed, closed - early - cell$value) / cell$mcse
    z <- max(z, 1e9 * abs(cell$value + row$cells$selected_full$value + early - 1))
    worst <- max(worst, z); model <- max(model, abs(plain - closed) / plain_se)
    text <- c(text, sprintf("(%.2f, %.2f): subset kept %.3f vs closed form %.3f vs patient-level %.3f (stopped early %.3f)", s$subset, s$rest, cell$value, closed, plain, early))
  }
  list(pass = worst < 3.5 && model < 4, detail = sprintf("event time, subset 40%%, %d events at the interim: %s; worst %.2f errors outside the closed-form band (tol 3.5), patient-level simulation %.2f errors from the closed form (tol 4)",
                                                       d1, paste(text, collapse = "; "), worst, model))
})

vcr_case("N68h", c("AC-29"), function() {
  alpha <- 0.025
  out <- character(); ok <- logical()
  for (test in c("simes", "bonferroni")) {
    r <- .n68_run(list(design = list(kind = "enrichment", informationRates = c(0.5, 1), subsetPrevalence = 0.4, plannedSize = 120, intersectionTest = test),
                       endpoint = list(type = "time_to_event"), truth = list(subsetEffects = list(list(subset = 1, rest = 1)))), 6816L, "job_n68h")
    null <- .n68_row(r, function(e) identical(e$role, "null"))
    t1 <- null$cells$type_one_error
    pops <- max(null$cells$reject_subset$value, null$cells$reject_full$value)
    ok <- c(ok, t1$value <= alpha + 3 * t1$mcse, pops <= alpha + 3 * t1$mcse)
    out <- c(out, sprintf("%s: familywise %.4f (+-%.4f), largest single population %.4f", test, t1$value, t1$mcse, pops))
  }
  list(pass = all(ok), detail = sprintf("event time, global null (hazard ratio 1 in both groups), %s (limit alpha %.3f + 3 errors)", paste(out, collapse = "; "), alpha))
})

vcr_case("N68i", c("AC-29", "AC-30"), function() {
  # rpact is called here with the job's own arguments and its own counter of trials that ended at a stage is read: `earlyStop`
  alpha <- 0.025; inv <- vcr_rpact_inverse_normal(c(0.5, 1), alpha)$object
  text <- character(); worst <- 0; bound <- TRUE
  scen_arms <- list(c(0, 0, 0.8), c(0.7, 0.7, 0.7))
  r <- .n68_run(list(design = list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 100),
                     endpoint = list(type = "continuous"), truth = list(effectScenarios = lapply(scen_arms, as.list), sd = 1)), 6821L, "job_n68i")
  for (effects in scen_arms) {
    row <- .n68_row(r, function(e) identical(e$role, "assumed") && isTRUE(all.equal(unlist(e$effect), effects)))
    sim <- rpact::getSimulationMultiArmMeans(inv, activeArms = 3L, typeOfShape = "userDefined", effectMatrix = matrix(effects, nrow = 1L), intersectionTest = "Simes",
                                             maxNumberOfIterations = 5000L, seed = 6822L, plannedSubjects = c(50, 100), stDev = 1, typeOfSelection = "best")
    ref <- sim$earlyStop[1L, 1L]; ref_se <- sqrt(max(ref * (1 - ref), 1e-4) / 5000)
    cell <- row$cells$early_stop_probability
    z <- abs(cell$value - ref) / sqrt(max(cell$mcse, 1e-4 / 70)^2 + ref_se^2)
    worst <- max(worst, z)
    # one effective arm and two nulls: the trial goes on until the null arms are rejected too, which has probability at most alpha
    if (identical(effects[1], 0)) bound <- bound && cell$value <= alpha + 3 * max(cell$mcse, sqrt(alpha * (1 - alpha) / 5000))
    text <- c(text, sprintf("3 arms %s: stopped at the first look %.4f (rpact earlyStop %.4f)", paste(effects, collapse = "/"), cell$value, ref))
  }
  scen_sub <- list(list(subset = 0.9, rest = 0), list(subset = 0.9, rest = 0.9))
  r <- .n68_run(list(design = list(kind = "enrichment", informationRates = c(0.5, 1), subsetPrevalence = 0.5, plannedSize = 200),
                     endpoint = list(type = "continuous"), truth = list(subsetEffects = scen_sub, sd = 1)), 6823L, "job_n68i2")
  for (s in scen_sub) {
    row <- .n68_row(r, function(e) identical(e$role, "assumed") && isTRUE(all.equal(unlist(e$effect), c(subset = s$subset, rest = s$rest))))
    effect_list <- list(subGroups = c("S", "R"), prevalences = c(0.5, 0.5), stDevs = 1, effects = matrix(c(s$subset, s$rest), nrow = 1L, dimnames = list(NULL, c("S", "R"))))
    sim <- rpact::getSimulationEnrichmentMeans(inv, effectList = effect_list, intersectionTest = "Simes", maxNumberOfIterations = 5000L, seed = 6824L,
                                               plannedSubjects = c(100, 200), typeOfSelection = "best")
    ref <- sim$earlyStop[1L, 1L]; ref_se <- sqrt(max(ref * (1 - ref), 1e-4) / 5000)
    cell <- row$cells$early_stop_probability
    worst <- max(worst, abs(cell$value - ref) / sqrt(max(cell$mcse, 1e-4 / 70)^2 + ref_se^2))
    text <- c(text, sprintf("enrichment (%.1f, %.1f): stopped at the first look %.4f (rpact earlyStop %.4f)", s$subset, s$rest, cell$value, ref))
  }
  list(pass = worst < 4 && bound, detail = sprintf("%s; largest gap %.2f errors (tol 4); with two null arms the share is at most alpha: %s (the cell counted any rejection at the first look: 0.77, 0.52)", paste(text, collapse = "; "), worst, bound))
})
