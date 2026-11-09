# N83 — the selection among randomised doses (algorithm round T15, 2026-11-03): design.dose, design.kind randomized_selection.
#
# "两个剂量各多少人，才有 90% 概率选到更低且不差的剂量": n patients in each of two or three doses; the lowest dose is the candidate and a higher
# dose replaces it when its response count is at least `ceiling(margin * n)` above the candidate's. The probability of each choice is exact
# (a dynamic programme over the candidate's response count). Held to:
#
#   a  a brute-force enumeration of every outcome (x1, x2, x3) of 3 to 9 patients per dose, with the rule written as a loop, on 2 and 3 doses
#   b  the closed form for two doses: P(choose the higher) = P(X_H - X_L >= cut), the sum of the product of two binomial distributions
#   c  a simulation of the trial in plain R (2,000,000 draws) at 40 patients per dose on three doses
#   d  the size searched by the job: the first size at which every scenario reaches the probability, and the first from which every larger
#      size up to the cap does, found by scanning the sizes independently; the saw-tooth is why both are reported
#   e  the right dose: the lowest dose strictly within the margin of the best, and the table the job returns for a stated size

.n83_loop_select <- function(x, cut) { cand <- 1L; for (j in seq_along(x)[-1L]) if (x[j] - x[cand] >= cut) cand <- j; cand }
.n83_brute <- function(n, rates, cut) {
  k <- length(rates); out <- numeric(k)
  grid <- do.call(expand.grid, rep(list(0:n), k))
  w <- Reduce(`*`, lapply(seq_len(k), function(j) stats::dbinom(grid[[j]], n, rates[j])))
  pick <- apply(as.matrix(grid), 1L, .n83_loop_select, cut = cut)
  for (j in seq_len(k)) out[j] <- sum(w[pick == j])
  out
}

vcr_case("N83a", c("AC-30"), function() {
  worst <- 0; checked <- 0L
  for (n in c(3L, 5L, 8L)) for (rates in list(c(0.3, 0.3), c(0.2, 0.5), c(0.3, 0.4, 0.5), c(0.1, 0.1, 0.6))) for (margin in c(0.1, 0.25, 0.5)) {
    cut <- as.integer(ceiling(margin * n - 1e-9))
    mine <- vcr_dose_selection_probabilities(n, rates, cut)
    ref <- .n83_brute(n, rates, cut)
    worst <- max(worst, abs(mine - ref)); checked <- checked + 1L
    stopifnot(abs(sum(mine) - 1) < 1e-12)
  }
  list(pass = worst < 1e-12, detail = sprintf("%d (patients, rates, margin) combinations on 2 and 3 doses: max|d| %.1e from the enumeration of every outcome; probabilities sum to 1", checked, worst))
})

vcr_case("N83b", c("AC-30"), function() {
  worst <- 0
  for (n in c(10L, 25L, 60L)) for (rates in list(c(0.3, 0.3), c(0.3, 0.5), c(0.15, 0.4))) for (margin in c(0.1, 0.2)) {
    cut <- as.integer(ceiling(margin * n - 1e-9))
    pl <- stats::dbinom(0:n, n, rates[1]); ph <- stats::dbinom(0:n, n, rates[2])
    higher <- sum(outer(ph, pl)[outer(0:n, 0:n, function(h, l) h - l >= cut)])
    mine <- vcr_dose_selection_probabilities(n, rates, cut)
    worst <- max(worst, abs(mine[2] - higher), abs(mine[1] - (1 - higher)))
  }
  list(pass = worst < 1e-12, detail = sprintf("two doses at 10, 25 and 60 patients, three rate pairs, two margins: max|d| %.1e from sum P(X_H = h) P(X_L = l) over h - l >= ceiling(margin n)", worst))
})

vcr_case("N83c", c("AC-29"), function() {
  rates <- c(0.3, 0.4, 0.5); n <- 40L; cut <- as.integer(ceiling(0.1 * n - 1e-9)); draws <- 2000000L
  set.seed(8303)
  x1 <- stats::rbinom(draws, n, rates[1]); x2 <- stats::rbinom(draws, n, rates[2]); x3 <- stats::rbinom(draws, n, rates[3])
  cand <- ifelse(x2 - x1 >= cut, 2L, 1L)
  xc <- ifelse(cand == 2L, x2, x1)
  pick <- ifelse(x3 - xc >= cut, 3L, cand)
  sim <- tabulate(pick, 3L) / draws
  mine <- vcr_dose_selection_probabilities(n, rates, cut)
  z <- max(abs(sim - mine) / sqrt(mine * (1 - mine) / draws))
  list(pass = z < 4, detail = sprintf("3 doses at 40 patients, margin 0.1 (cut %d responses): exact %s, simulated %s (%d draws; worst %.2f errors)", cut, paste(sprintf("%.4f", mine), collapse = "/"), paste(sprintf("%.4f", sim), collapse = "/"), draws, z))
})

vcr_case("N83d", c("AC-30", "AC-31"), function() {
  scenarios <- list(c(0.3, 0.3), c(0.3, 0.45)); margin <- 0.1; target <- 0.9; cap <- 400L
  right <- vapply(scenarios, vcr_dose_right_dose, numeric(1), margin = margin)
  correct <- function(n) {
    cut <- as.integer(ceiling(margin * n - 1e-9))
    vapply(seq_along(scenarios), function(i) vcr_dose_selection_probabilities(n, scenarios[[i]], cut)[right[i]], numeric(1))
  }
  ok <- vapply(seq_len(cap), function(n) all(correct(n) >= target - 1e-12), logical(1))
  first <- which(ok)[1L]; stable <- max(which(!ok)) + 1L
  r <- vcr_test_run(vcr_test_job("design.dose", list(design = list(kind = "randomized_selection", margin = margin, targetProbability = target, maxPerArm = cap),
                                                   truth = list(responseScenarios = scenarios)), seed = 8304L))
  d <- r$diagnostics$doseSelection
  list(pass = identical(r$status, "succeeded") && identical(as.integer(d$requiredFirst), as.integer(first)) && identical(as.integer(d$requiredStable), as.integer(stable)) && first <= stable &&
         all(ok[stable:cap]) && any(!ok[first:stable]) && identical(as.integer(d$perArm), as.integer(first)) && identical(as.integer(vcr_measure_value(r, "required_per_arm")), as.integer(first)),
       detail = sprintf("margin 0.1, rates 0.30/0.30 and 0.30/0.45, probability 0.90 in both: first size %d per dose (job %d), and every size from %d on (job %d) up to %d; between them the probability falls back below 0.90 at some sizes (the saw-tooth of a count cut-off)",
                        first, as.integer(d$requiredFirst), stable, as.integer(d$requiredStable), cap))
})

vcr_case("N83e", c("AC-29"), function() {
  right <- c(vcr_dose_right_dose(c(0.3, 0.38), 0.1), vcr_dose_right_dose(c(0.3, 0.4), 0.1), vcr_dose_right_dose(c(0.3, 0.45, 0.45), 0.1), vcr_dose_right_dose(c(0.5, 0.2, 0.55), 0.1))
  r <- vcr_test_run(vcr_test_job("design.dose", list(design = list(kind = "randomized_selection", margin = 0.1, perArm = 30), truth = list(responseScenarios = list(c(0.3, 0.3, 0.3), c(0.3, 0.45, 0.6)))), seed = 8305L))
  rows <- r$diagnostics$doseSelection$scenarios
  mine <- vcr_dose_selection_probabilities(30L, c(0.3, 0.45, 0.6), 3L)
  list(pass = identical(as.integer(right), c(1L, 2L, 2L, 1L)) && identical(as.integer(r$diagnostics$doseSelection$perArm), 30L) && identical(as.integer(rows[[2]]$rightDose), 3L) &&
         abs(rows[[2]]$cells$select_dose_3$value - mine[3]) < 1e-12 && abs(vcr_measure_value(r, "total_patients") - 90) < 1e-12,
       detail = sprintf("the right dose is the lowest strictly within the margin of the best: %s (for 0.30/0.38, 0.30/0.40, 0.30/0.45/0.45, 0.50/0.20/0.55 at margin 0.1); a stated size of 30 per dose is a table, 90 patients in all, P(choose dose 3) %.4f", paste(right, collapse = "/"), mine[3]))
})
