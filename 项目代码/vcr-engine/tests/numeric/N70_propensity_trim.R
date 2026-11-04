# N70 — propensity trimming of the weighting comparators (algorithm round C14, 2026-11-03).
#
# References that are not the trimming's own code: the estimate recomputed by hand from `stats::glm` on the people who are kept
# (the score on everybody, the bounds, the score again on who is left, the odds weights, the weighted means); Crump's rule against the
# integral equation it solves for a uniform score, a root found with `uniroot` and not with the rule; the rule's own defining
# inequality on the scores a job fitted (the kept set is the largest one whose biggest 1 / (e (1 - e)) is at most twice the set's mean);
# and a known-truth simulation in which the effect depends on a covariate that also drives who is treated, so that the people
# trimmed are the ones with the most different effect and the estimate must be the effect among the people who were kept.

# The trial against an external control with a strong, one-covariate selection into the trial (poor overlap in the tails), a binary
# covariate, and an effect that grows with x1: tau(x) = 0.5 + 0.6 x1. Continuous outcome.
.n70_gen <- function(n = 1200L, strength = 1.4) {
  x1 <- stats::rnorm(n); x2 <- stats::rbinom(n, 1L, 0.5)
  arm <- stats::rbinom(n, 1L, stats::plogis(-0.4 + strength * x1 + 0.3 * x2))
  y <- 1 + 0.8 * x1 + 0.5 * x2 + arm * (0.5 + 0.6 * x1) + stats::rnorm(n)
  data.frame(USUBJID = sprintf("S%05d", seq_len(n)), arm = arm, x1 = x1, x2 = x2, y = y)
}

.n70_job <- function(d, id, method = "comparator.propensity_weight", scenario = list(), seed = 5L, cores = 1L, replicates = 2000L) {
  sc <- utils::modifyList(list(covariates = list("x1", "x2"), treatmentColumn = "arm", outcomeColumn = "y", endpoint = list(type = "continuous")), scenario)
  vcr_test_job(method, sc, list(vcr_test_input(d, paste0("snp_", id, ":subject"), "subject")), seed = seed, job_id = paste0("job_", id), cores = cores, replicates = replicates)
}

# the estimate by hand: score on everybody, trim, score again on who is left, ATT odds weights scaled to the trial size, weighted means
.n70_by_hand <- function(d, lower, upper = 1 - lower, estimand = "ATT") {
  ps <- as.vector(stats::fitted(suppressWarnings(stats::glm(arm ~ x1 + x2, data = d, family = stats::binomial()))))
  keep <- ps >= lower & ps <= upper
  k <- d[keep, ]
  e <- as.vector(stats::fitted(suppressWarnings(stats::glm(arm ~ x1 + x2, data = k, family = stats::binomial()))))
  w <- ifelse(k$arm == 1L, 1, e / (1 - e)); w[k$arm == 0L] <- w[k$arm == 0L] * sum(k$arm == 1L) / sum(w[k$arm == 0L])
  list(keep = keep, est = stats::weighted.mean(k$y[k$arm == 1L], w[k$arm == 1L]) - stats::weighted.mean(k$y[k$arm == 0L], w[k$arm == 0L]),
       w = w, kept = k, ps = ps)
}

vcr_case("N70a", c("AC-08", "AC-30"), function() {
  # A fixed bound, against the estimate recomputed by hand on the people who are kept; the removed and kept people per arm, and their
  # baseline, against the same people counted by hand; the removed people carry weight 0 in the weights table; the result says it
  # is about the trimmed population.
  set.seed(20261103L, kind = VCR_RNG_KIND)
  d <- .n70_gen()
  hb <- .n70_by_hand(d, 0.1)
  dir <- tempfile("n70a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- vcr_test_run(.n70_job(d, "n70a", scenario = list(trim = list(rule = "fixed", lower = 0.1))), output_dir = dir)
  v <- function(name) vcr_measure_value(r, name)
  tb <- r$diagnostics$trim
  rem1 <- sum(!hb$keep & d$arm == 1L); rem0 <- sum(!hb$keep & d$arm == 0L)
  base1 <- tb$baseline[tb$baseline$covariate == "x1" & tb$baseline$arm == "treated", ]
  base0 <- tb$baseline[tb$baseline$covariate == "x2" & tb$baseline$arm == "control", ]
  tab <- vcr_test_table(r, "weights", dir)
  zero_rows <- which(tab$weight == 0)
  ok <- identical(r$status, "succeeded") && identical(r$conclusion, "limited") &&
    abs(v("weighted_difference") - hb$est) < 1e-10 &&
    identical(as.integer(v("trimmed_treated")), as.integer(rem1)) && identical(as.integer(v("trimmed_control")), as.integer(rem0)) &&
    rem1 > 0 && rem0 > 0 &&
    identical(tb$arms[[1]]$removed, rem1) && identical(tb$arms[[2]]$removed, rem0) &&
    abs(base1$removedMean - mean(d$x1[!hb$keep & d$arm == 1L])) < 1e-12 && abs(base1$keptMean - mean(d$x1[hb$keep & d$arm == 1L])) < 1e-12 &&
    abs(base0$removedMean - mean(d$x2[!hb$keep & d$arm == 0L])) < 1e-12 &&
    identical(tb$targetPopulation, "trimmed_population") && "target_population_trimmed" %in% unlist(r$diagnostics$limitedBy) &&
    identical(sort(zero_rows), sort(which(!hb$keep))) && max(abs(tab$weight[hb$keep] - hb$w)) < 1e-10 &&
    abs(tb$lower - 0.1) < 1e-15 && abs(tb$upper - 0.9) < 1e-15 &&
    length(vcr_validate_result(r)) == 0L && identical(r$counts$realPatients, 1200L)
  list(pass = ok,
       detail = sprintf("effect among the kept %.10f vs by hand %.10f; removed %d trial / %d control people (by hand %d / %d); mean x1 of the removed trial people %.4f vs by hand %.4f, of the kept %.4f; zero-weight rows %d = removed %d; effective sample size %.1f",
                        v("weighted_difference"), hb$est, tb$arms[[1]]$removed, tb$arms[[2]]$removed, rem1, rem0, base1$removedMean, mean(d$x1[!hb$keep & d$arm == 1L]), base1$keptMean,
                        length(zero_rows), sum(!hb$keep), r$counts$effectiveSampleSize))
})

vcr_case("N70b", c("AC-08", "AC-30"), function() {
  # Crump's rule. (1) The rule against the integral equation it solves for a score uniform on (0, 1): 1 / (a (1 - a)) = 2 E[g | a <= e <= 1 - a]
  # has the root a = 0.10181 (the rule of thumb 0.1), found here with uniroot and compared to the rule's answer on a fine grid of scores. (2) On the
  # scores a job fitted, the kept set is the largest whose biggest g is at most twice its mean, and the next person breaks that.
  n <- 100000L; ps <- (seq_len(n) - 0.5) / n
  root <- stats::uniroot(function(a) 1 / (a * (1 - a)) - 4 * log((1 - a) / a) / (1 - 2 * a), c(1e-4, 0.3), tol = 1e-13)$root
  alpha <- vcr_crump_alpha(ps)
  set.seed(20261104L, kind = VCR_RNG_KIND)
  d <- .n70_gen()
  r <- vcr_test_run(.n70_job(d, "n70b", scenario = list(trim = list(rule = "crump")), replicates = 200L))
  hb <- .n70_by_hand(d, r$diagnostics$trim$lower, r$diagnostics$trim$upper)
  # the kept set is {g <= lambda}, lambda = 1 / (alpha (1 - alpha)): compared on g, as the rule does, so the person exactly on the bound is in it
  g <- 1 / (hb$ps * (1 - hb$ps))
  lambda <- 1 / (r$diagnostics$trim$lower * (1 - r$diagnostics$trim$lower))
  hb <- .n70_by_hand(d, 0, 1)
  hb$keep <- g <= lambda * (1 + 1e-12)
  k <- d[hb$keep, ]
  e <- as.vector(stats::fitted(suppressWarnings(stats::glm(arm ~ x1 + x2, data = k, family = stats::binomial()))))
  w <- ifelse(k$arm == 1L, 1, e / (1 - e)); w[k$arm == 0L] <- w[k$arm == 0L] * sum(k$arm == 1L) / sum(w[k$arm == 0L])
  hb$est <- stats::weighted.mean(k$y[k$arm == 1L], w[k$arm == 1L]) - stats::weighted.mean(k$y[k$arm == 0L], w[k$arm == 0L])
  kept_g <- g[hb$keep]; out_g <- g[!hb$keep]
  # the set satisfies the defining inequality, and the next person (the smallest g outside) would break it
  property <- max(kept_g) <= 2 * mean(kept_g) * (1 + 1e-12) &&
    (!length(out_g) || min(out_g) > 2 * mean(c(kept_g, min(out_g))) * (1 - 1e-12))
  ok <- identical(r$status, "succeeded") && abs(alpha - root) < 2e-5 && property &&
    abs(vcr_measure_value(r, "weighted_difference") - hb$est) < 1e-10 && identical(r$diagnostics$trim$rule, "crump") &&
    r$diagnostics$trim$removedTotal == sum(!hb$keep) && length(vcr_validate_result(r)) == 0L
  list(pass = ok,
       detail = sprintf("uniform score: the rule gives alpha %.6f, the integral equation's root is %.6f; on fitted scores alpha %.4f keeps %d of %d (largest g kept %.2f <= 2 x mean %.2f; the next person's set has mean %.2f < half of its largest g %.2f); effect %.8f vs by hand %.8f",
                        alpha, root, r$diagnostics$trim$lower, sum(hb$keep), nrow(d), max(kept_g), 2 * mean(kept_g),
                        if (length(out_g)) mean(c(kept_g, min(out_g))) else NA_real_, if (length(out_g)) min(out_g) else NA_real_,
                        vcr_measure_value(r, "weighted_difference"), hb$est))
})

vcr_case("N70c", c("AC-08", "AC-11", "AC-30"), function() {
  # Known truth. The effect is 0.5 + 0.6 x1 and the trial selects on x1, so the treated people with the highest scores (the high x1) are the
  # ones trimmed. Without trimming the estimate is the ATT of everybody treated; with it, the average of the true effect over the treated people who are
  # kept - the sample average of 0.5 + 0.6 x1 over them - within the sampling error of the estimate, and different from the untrimmed ATT.
  set.seed(20261105L, kind = VCR_RNG_KIND)
  d <- .n70_gen(n = 3000L, strength = 1.8)
  r0 <- vcr_test_run(.n70_job(d, "n70c0", replicates = 400L))
  r1 <- vcr_test_run(.n70_job(d, "n70c1", scenario = list(trim = list(rule = "fixed", lower = 0.1)), replicates = 400L))
  hb <- .n70_by_hand(d, 0.1)
  tr_kept <- d$arm == 1L & hb$keep
  truth_kept <- mean(0.5 + 0.6 * d$x1[tr_kept]); truth_all <- mean(0.5 + 0.6 * d$x1[d$arm == 1L])
  e1 <- vcr_measure_value(r1, "weighted_difference"); e0 <- vcr_measure_value(r0, "weighted_difference")
  se1 <- (vcr_get_measure(r1, "weighted_difference")$interval$high - vcr_get_measure(r1, "weighted_difference")$interval$low) / (2 * 1.96)
  ok <- identical(r0$status, "succeeded") && identical(r1$status, "succeeded") && abs(e1 - truth_kept) < 3 * se1 &&
    is.null(r0$diagnostics$trim) && !("target_population_trimmed" %in% unlist(r0$diagnostics$limitedBy)) &&
    abs(truth_kept - truth_all) > 0.03 && r1$diagnostics$trim$removedTotal > 100L
  list(pass = ok,
       detail = sprintf("true effect among the kept treated %.4f (all treated %.4f); trimmed estimate %.4f (se %.4f, %.2f se off); untrimmed estimate %.4f; %d people removed (%d treated)",
                        truth_kept, truth_all, e1, se1, abs(e1 - truth_kept) / se1, e0, r1$diagnostics$trim$removedTotal, r1$diagnostics$trim$arms[[1]]$removed))
})

vcr_case("N70d", c("AC-08", "AC-30"), function() {
  # The two other comparators that share the kernel. The weighted Cox hazard ratio on the people who are kept equals coxph on the by-hand ATT
  # weights; the doubly robust estimate on the kept people equals the estimator recomputed from glm fits on them; both name who was removed.
  set.seed(20261106L, kind = VCR_RNG_KIND)
  n <- 1500L
  d <- .n70_gen(n = n, strength = 1.5)
  rate <- exp(-2.2 + 0.4 * d$x1 + 0.3 * d$x2 - 0.5 * d$arm); tt <- stats::rexp(n, rate); cc <- stats::runif(n, 1, 6)
  d$time <- pmin(tt, cc); d$status <- as.integer(tt <= cc)
  ev <- data.frame(USUBJID = d$USUBJID, PARAMCD = "OS", AVAL = d$time, CNSR = 1L - d$status)
  # weighted Cox
  jc <- vcr_test_job("comparator.weighted_cox", list(covariates = list("x1", "x2"), treatmentColumn = "arm", weighting = "propensity", tau = 4, timeUnit = "months",
                                                     endpoint = list(type = "time_to_event"), trim = list(rule = "fixed", lower = 0.1)),
                     list(vcr_test_input(d[, c("USUBJID", "arm", "x1", "x2")], "snp_n70d_c:subject", "subject"), vcr_test_input(ev, "snp_n70d_c:events", "event")),
                     seed = 3L, job_id = "job_n70d_c", replicates = 200L)
  rc <- vcr_test_run(jc)
  hb <- .n70_by_hand(d, 0.1)
  k <- hb$kept; k$w <- hb$w
  fit <- survival::coxph(survival::Surv(time, status) ~ arm, data = k, weights = w, ties = "efron")
  # AIPW on the continuous outcome
  ra <- vcr_test_run(.n70_job(d, "n70d_a", method = "comparator.aipw", scenario = list(covariates = list("x1", "x2"), trim = list(rule = "fixed", lower = 0.1)), replicates = 200L))
  dk <- d[hb$keep, ]
  ps_k <- as.vector(stats::fitted(suppressWarnings(stats::glm(arm ~ x1 + x2, data = dk, family = stats::binomial()))))
  om <- stats::glm(y ~ x1 + x2, data = dk[dk$arm == 0L, ], family = stats::gaussian()); m0 <- stats::predict(om, dk)
  t1 <- dk$arm == 1L; w0 <- ps_k / (1 - ps_k)
  mu0 <- (sum(m0[t1]) + sum((w0 * (dk$y - m0))[!t1])) / sum(t1); aipw_hand <- mean(dk$y[t1]) - mu0
  ok <- identical(rc$status, "succeeded") && identical(ra$status, "succeeded") &&
    abs(vcr_measure_value(rc, "hazard_ratio") - exp(unname(stats::coef(fit)))) < 1e-8 &&
    abs(vcr_measure_value(ra, "aipw_difference") - aipw_hand) < 1e-10 &&
    rc$diagnostics$trim$removedTotal == sum(!hb$keep) && ra$diagnostics$trim$removedTotal == sum(!hb$keep) &&
    "target_population_trimmed" %in% unlist(ra$diagnostics$limitedBy) && "target_population_trimmed" %in% unlist(rc$diagnostics$limitedBy) &&
    length(vcr_validate_result(rc)) == 0L && length(vcr_validate_result(ra)) == 0L
  list(pass = ok,
       detail = sprintf("weighted Cox among the kept: hazard ratio %.8f vs coxph on hand weights %.8f; doubly robust effect among the kept %.10f vs by hand %.10f; %d people removed by both, as by hand (%d)",
                        vcr_measure_value(rc, "hazard_ratio"), exp(unname(stats::coef(fit))), vcr_measure_value(ra, "aipw_difference"), aipw_hand,
                        rc$diagnostics$trim$removedTotal, sum(!hb$keep)))
})

vcr_case("N70e", c("AC-08", "AC-30"), function() {
  # Bounds that remove nobody say so and leave the result as the untrimmed job's; bounds that leave a group with fewer than two people are a
  # not-estimable result with a reason of their own; a 1.3.0 job that names a trimming is refused (the key is 1.4.0's).
  set.seed(20261107L, kind = VCR_RNG_KIND)
  d <- .n70_gen(n = 600L, strength = 0.6)
  r_none <- vcr_test_run(.n70_job(d, "n70e0", replicates = 200L))
  r_wide <- vcr_test_run(.n70_job(d, "n70e1", scenario = list(trim = list(rule = "fixed", lower = 1e-6)), replicates = 200L))
  r_tight <- vcr_test_run(.n70_job(d, "n70e2", scenario = list(trim = list(rule = "fixed", lower = 0.499)), replicates = 200L))
  old <- .n70_job(d, "n70e3", scenario = list(trim = list(rule = "fixed", lower = 0.1)), replicates = 200L)
  old$methodVersion <- "1.3.0"
  r_old <- vcr_test_run(old)
  ok <- identical(r_wide$status, "succeeded") && r_wide$diagnostics$trim$removedTotal == 0L && identical(r_wide$diagnostics$trim$targetPopulation, "full_population") &&
    !("target_population_trimmed" %in% unlist(r_wide$diagnostics$limitedBy)) &&
    abs(vcr_measure_value(r_wide, "weighted_difference") - vcr_measure_value(r_none, "weighted_difference")) < 1e-10 &&
    identical(r_tight$status, "not_estimable") && identical(r_tight$notEstimableRule, "trimmed_population_too_small") && length(r_tight$measures) == 0L &&
    !identical(r_old$status, "succeeded")
  list(pass = ok,
       detail = sprintf("bounds that remove nobody: %d removed, effect %.10f = untrimmed %.10f, conclusion %s; bounds [0.499, 0.501]: %s / %s; a 1.3.0 job with a trimming: %s (%s)",
                        r_wide$diagnostics$trim$removedTotal, vcr_measure_value(r_wide, "weighted_difference"), vcr_measure_value(r_none, "weighted_difference"), r_wide$conclusion,
                        r_tight$status, r_tight$notEstimableRule %||% "-", r_old$status, paste(vcr_test_issue_codes(r_old), collapse = ",")))
})

vcr_case("N70f", c("AC-08", "AC-30"), function() {
  # The small-cell rule is the engine's own on this restatement (review P0-1): a trimming that removes three treated people and many
  # control people states neither the treated arm's cells nor the totals (n = kept + removed would give the three back), no baseline of the
  # three, no measure for them; the control arm, whose removed group is large, is stated in full, and the estimate is the same one.
  set.seed(20261103L, kind = VCR_RNG_KIND)
  d <- .n70_gen()
  ps <- .n70_by_hand(d, 0.1)$ps
  dist <- pmin(ps, 1 - ps)
  t_dist <- sort(dist[d$arm == 1L]); lower <- (t_dist[3] + t_dist[4]) / 2
  hb <- .n70_by_hand(d, lower)
  rem1 <- sum(!hb$keep & d$arm == 1L); rem0 <- sum(!hb$keep & d$arm == 0L)
  r <- vcr_test_run(.n70_job(d, "n70f", scenario = list(trim = list(rule = "fixed", lower = lower)), replicates = 200L))
  tb <- r$diagnostics$trim
  base_t <- tb$baseline[tb$baseline$arm == "treated", ]; base_c <- tb$baseline[tb$baseline$arm == "control", ]
  names_ <- vapply(r$measures, function(m) m$name, character(1))
  ok <- identical(r$status, "succeeded") && rem1 == 3L && rem0 >= 10L &&
    abs(vcr_measure_value(r, "weighted_difference") - hb$est) < 1e-10 &&
    is.null(tb$arms[[1]]$removed) && is.null(tb$arms[[1]]$kept) && is.null(tb$arms[[1]]$removedShare) &&
    setequal(tb$arms[[1]]$suppressed, c("kept", "removed", "removedShare")) && identical(tb$arms[[1]]$n, sum(d$arm == 1L)) &&
    identical(tb$arms[[2]]$removed, rem0) && identical(tb$arms[[2]]$kept, sum(hb$keep & d$arm == 0L)) &&
    is.null(tb$removedTotal) && is.null(tb$keptTotal) && isTRUE(tb$trimmedAnyone) && identical(tb$targetPopulation, "trimmed_population") &&
    all(is.na(base_t$removedMean)) && all(is.finite(base_t$keptMean)) && all(is.finite(base_c$removedMean)) &&
    !("trimmed_treated" %in% names_) && identical(as.integer(vcr_measure_value(r, "trimmed_control")), rem0) &&
    "target_population_trimmed" %in% unlist(r$diagnostics$limitedBy) && length(vcr_validate_result(r)) == 0L
  list(pass = ok,
       detail = sprintf("trimming that removes %d treated people (rule: under 10 is not stated) and %d control people: treated cells kept/removed/share %s/%s/%s, totals %s/%s, treated removed-baseline NA %s, control stated %s; measures %s; effect %.10f vs by hand %.10f",
                        rem1, rem0, deparse(tb$arms[[1]]$kept), deparse(tb$arms[[1]]$removed), deparse(tb$arms[[1]]$removedShare), deparse(tb$removedTotal), deparse(tb$keptTotal),
                        all(is.na(base_t$removedMean)), tb$arms[[2]]$removed, paste(names_[grepl("trimmed", names_)], collapse = ","), vcr_measure_value(r, "weighted_difference"), hb$est))
})
