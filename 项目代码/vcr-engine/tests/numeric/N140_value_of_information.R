# N140 — decision.value_of_information: EVPI, EVPPI by GAM regression, EVSI by regression and the thresholds of inputs with no distribution
# (in-silico round 2, R35, 2026-11-09).
#
# References that are not the method's own code: (1) closed forms of a normal-normal two-decision problem (the expected value of a normal truncated
# at the decision boundary), for the EVPI, the EVPPI of each input and of the pair; (2) Strong, Oakley & Brennan (2014), case study 1: the decision tree
# with 19 correlated inputs, whose overall EVPI and three partial EVPIs the paper prints from a gold-standard run (an analytic inner expectation and 10^7
# outer draws), held to the paper's own GAM error; (3) `voi` 1.0.3 as an oracle, on the same utility matrix with the same regression formula
# (evppi, and evsi with the data the engine simulated), and `voi::evpi`; (4) the closed form of the expected power under a normal design prior
# (the assurance integral) and of the effect at which a net benefit crosses zero. Cases run 2-12 s at 2 cores; none depends on machine speed.

.n140_two_arm <- function(extra = list(), ...) {
  base <- list(label = "n140", source = "two_arm_continuous", utility = "net_benefit", successValue = 400, costPerPatient = 0.2, unit = "m",
               options = list(list(label = "no_trial", nPerArm = 0), list(label = "n150", nPerArm = 150), list(label = "n300", nPerArm = 300), list(label = "n450", nPerArm = 450)),
               inputs = list(effect = list(family = "normal", mean = 1.2, sd = 0.8), sd = list(family = "lognormal", meanlog = 1.95, sdlog = 0.12),
                             dropoutShare = list(family = "beta", alpha = 4, beta = 16)))
  # a stated key replaces the base's whole value (a merge would leave the base's distribution parameters in a fixed input); NULL removes a key
  for (k in names(extra)) base[[k]] <- extra[[k]]
  base
}

# E[max(theta, 0)] - max(E[theta], 0) for theta ~ N(m, s^2): the value of learning a normal net benefit against doing nothing
.n140_nn <- function(m, s) s * stats::dnorm(m / s) + m * stats::pnorm(m / s) - max(m, 0)

vcr_case("N140a", c("AC-08", "AC-28"), function() {
  # U = (0, theta1 + theta2 + theta3 with theta_i ~ N(mu_i, s_i^2)): every EVPPI is the normal formula at the standard deviation of what the input
  # alone moves, the group is the sum of its members' variances, the three together are the EVPI, and an input that does not enter the utility is worth 0.
  set.seed(140L, kind = VCR_RNG_KIND); S <- 40000L
  mu <- c(0.4, -0.1, 0.2); sg <- c(1.0, 0.6, 0.3)
  Phi <- cbind(a = stats::rnorm(S, mu[1], sg[1]), b = stats::rnorm(S, mu[2], sg[2]), c = stats::rnorm(S, mu[3], sg[3]), z = stats::rnorm(S))
  U <- cbind(0, Phi[, "a"] + Phi[, "b"] + Phi[, "c"])
  base <- vcr_voi_evpi(U)
  m <- sum(mu); s_all <- sqrt(sum(sg^2))
  want <- c(evpi = .n140_nn(m, s_all), a = .n140_nn(m, sg[1]), b = .n140_nn(m, sg[2]), c = .n140_nn(m, sg[3]), ab = .n140_nn(m, sqrt(sum(sg[1:2]^2))))
  got <- list(a = vcr_voi_evppi(U, Phi, "a", base), b = vcr_voi_evppi(U, Phi, "b", base), c = vcr_voi_evppi(U, Phi, "c", base),
              ab = vcr_voi_evppi(U, Phi, c("a", "b"), base), z = vcr_voi_evppi(U, Phi, "z", base))
  diffs <- c(evpi = base$evpi - want[["evpi"]], vapply(c("a", "b", "c", "ab"), function(k) got[[k]]$evppi - want[[k]], numeric(1)))
  ses <- c(base$mcse, vapply(c("a", "b", "c", "ab"), function(k) got[[k]]$mcse, numeric(1)))
  # the pair is closer to the EVPI than either alone and the three-way sum is the EVPI itself
  all3 <- vcr_voi_evppi(U, Phi, c("a", "b", "c"), base)
  list(pass = all(abs(diffs) < 5 * ses + 1e-3) && abs(got$z$evppi) < 0.01 * want[["evpi"]] && got$ab$evppi > got$a$evppi && abs(all3$evppi - base$evpi) < 4 * base$mcse + 0.01 * base$evpi,
       detail = sprintf("EVPI %.4f (closed form %.4f, mcse %.4f); EVPPI a %.4f (%.4f), b %.4f (%.4f), c %.4f (%.4f), a+b %.4f (%.4f); an input outside the utility %.5f; the three together %.4f; largest miss %.2f mcse over %d draws",
                        base$evpi, want[["evpi"]], base$mcse, got$a$evppi, want[["a"]], got$b$evppi, want[["b"]], got$c$evppi, want[["c"]], got$ab$evppi, want[["ab"]], got$z$evppi, all3$evppi,
                        max(abs(diffs) / ses), S))
})

vcr_case("N140b", c("AC-08", "AC-28"), function() {
  # Strong, Oakley & Brennan (2014) case study 1: net benefits NB(1, x) = lambda (x5 x6 x7 + x8 x9 x10) - (x1 + x2 x3 x4) and the same for treatment 2 on
  # x11-x19 (x4, the cost per day, is shared); multivariate normal inputs read from the paper's Table 1 (percentages as proportions), pairwise correlation 0.6
  # among x5, x7, x14, x16 and between x6 and x15. The paper prints, from a gold-standard run (an analytic inner expectation, 10^7 outer draws), the partial
  # EVPI of three parameter sets and the standard errors of its own GAM at 10^4 runs (16.2, 10.5, 15.5). Two of the sets, {x5, x14} and {x7, x16}, are
  # reproduced from the table as read here and are held to three of those errors at 2 x 10^4 runs. The other two printed numbers are NOT reproduced and
  # are not asserted: the overall EVPI (1047) and the partial EVPI of {x5, x6, x14, x15} (840.84) are above what the table as transcribed gives (an exact
  # EVPI of about 840 on 2 x 10^5 draws, which is also what the paper prints for the four-input set); a reading of the table's x6 and x15 columns (their
  # spreads or their correlation) differs from the paper's, and the paper's own model code was not available to settle it. The case says so in its detail.
  mean_ <- c(1000, .10, 5.2, 400, .7, .3, 3, .25, -.1, .5, 1500, .08, 6.1, .8, .3, 3, .2, -.1, .5)
  sd_ <- c(1, .02, 1, 200, .1, .1, .5, .1, .02, .2, 1, .02, 1, .1, .05, 1, .05, .02, .2)
  R <- diag(19L); for (p in list(c(5, 7), c(5, 14), c(5, 16), c(7, 14), c(7, 16), c(14, 16), c(6, 15))) R[p[1], p[2]] <- R[p[2], p[1]] <- 0.6
  sim <- function(S, seed) {
    set.seed(seed, kind = VCR_RNG_KIND)
    X <- mvtnorm::rmvnorm(S, mean_, diag(sd_) %*% R %*% diag(sd_))
    colnames(X) <- paste0("x", 1:19)
    lambda <- 1e4
    nb1 <- lambda * (X[, 5] * X[, 6] * X[, 7] + X[, 8] * X[, 9] * X[, 10]) - (X[, 1] + X[, 2] * X[, 3] * X[, 4])
    nb2 <- lambda * (X[, 14] * X[, 15] * X[, 16] + X[, 17] * X[, 18] * X[, 19]) - (X[, 11] + X[, 12] * X[, 13] * X[, 4])
    list(U = cbind(nb1, nb2), X = X)
  }
  e <- vcr_voi_evpi(sim(200000L, 20140L)$U)
  small <- sim(20000L, 20141L)
  base <- vcr_voi_evpi(small$U)
  sets <- list(list(c("x5", "x14"), 247.95, 16.24), list(c("x7", "x16"), 536.28, 15.49), list(c("x5", "x6", "x14", "x15"), 840.84, 10.48))
  got <- vapply(sets, function(s) vcr_voi_evppi(small$U, small$X, s[[1]], base)$evppi, numeric(1))
  miss <- got - vapply(sets, function(s) s[[2]], numeric(1))
  tol <- 3 * vapply(sets, function(s) s[[3]], numeric(1))
  list(pass = all(abs(miss[1:2]) < tol[1:2]) && got[3] <= e$evpi + 4 * e$mcse + 30,
       detail = sprintf("partial EVPI {x5,x14} %.1f (gold 247.95), {x7,x16} %.1f (gold 536.28), misses %.1f / %.1f against three of the paper's GAM errors %.0f / %.0f (2e4 draws, te cubic regression basis); not asserted: overall EVPI %.1f (paper 1047, mcse %.1f, 2e5 draws) and {x5,x6,x14,x15} %.1f (paper 840.84), which cannot exceed the overall EVPI",
                        got[1], got[2], miss[1], miss[2], tol[1], tol[2], e$evpi, e$mcse, got[3]))
})

vcr_case("N140c", c("AC-08", "AC-25"), function() {
  # `voi` as the oracle, on the utility matrix the engine itself builds for the two-arm model: EVPI, the EVPPI of each input and of a pair with the
  # same regression formula, and the EVSI of a phase 2 on the effect with the data the engine simulated. The package's own default basis (te, k = 5) is
  # reported beside, not asserted: it is a different smoother.
  if (!requireNamespace("voi", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the cross-check package voi is not installed (the run must not skip silently)"))
  set.seed(1400L, kind = VCR_RNG_KIND); S <- 6000L
  eff <- stats::qnorm(stats::runif(S), 1.2, 0.8); sdv <- stats::qlnorm(stats::runif(S), 1.95, 0.12); dr <- stats::qbeta(stats::runif(S), 4, 16)
  U <- vcr_voi_two_arm_utilities(c(0, 150, 300, 450), eff, sdv, dr, 0.025, "net_benefit", 400, 0.2)
  inputs <- data.frame(effect = eff, sd = sdv, dropout = dr)
  base <- vcr_voi_evpi(U)
  one <- vapply(c("effect", "sd", "dropout"), function(p) c(vcr_voi_evppi(U, as.matrix(inputs), p, base)$evppi,
                voi::evppi(U, inputs, pars = p, method = "gam", gam_formula = sprintf("s(%s, bs = 'cr', k = 10)", p))$evppi), numeric(2))
  pair <- c(vcr_voi_evppi(U, as.matrix(inputs), c("effect", "sd"), base)$evppi,
            voi::evppi(U, inputs, pars = c("effect", "sd"), method = "gam", gam_formula = "te(effect, sd, bs = 'cr', k = 5)")$evppi)
  noise <- stats::rnorm(S); Tt <- eff + noise * sdv * sqrt(2 / 80)
  ours <- vcr_voi_evppi(U, matrix(Tt, ncol = 1L, dimnames = list(NULL, "T")), "T", base)$evppi
  theirs <- voi::evsi(U, inputs, datagen_fn = function(inputs, n = 1) data.frame(T = Tt), pars = "effect", n = 1, method = "gam", gam_formula = "s(T, bs = 'cr', k = 10)")$evsi
  default_basis <- voi::evppi(U, inputs, pars = "effect", method = "gam")$evppi
  list(pass = abs(base$evpi - voi::evpi(U)) < 1e-9 && all(abs(one[1, ] - one[2, ]) < 1e-8) && abs(pair[1] - pair[2]) < 1e-8 && abs(ours - theirs) < 1e-8,
       detail = sprintf("EVPI %.4f = voi::evpi; EVPPI effect %.4f / sd %.4f / dropout %.4f against voi %.4f / %.4f / %.4f; pair (effect, sd) %.4f against %.4f; EVSI of a phase 2 of 80 per arm %.4f against voi::evsi %.4f (largest difference %.1e); voi's default basis gives %.4f for the effect",
                        base$evpi, one[1, 1], one[1, 2], one[1, 3], one[2, 1], one[2, 2], one[2, 3], pair[1], pair[2], ours, theirs,
                        max(abs(one[1, ] - one[2, ]), abs(pair[1] - pair[2]), abs(ours - theirs)), default_basis))
})

vcr_case("N140d", c("AC-08", "AC-28"), function() {
  # The job against closed forms. (1) The expected utility of an option is the expected power: for a normal effect and a fixed sd and dropout it is
  # Phi((a mu - z) / sqrt(1 + a^2 tau^2)), a = sqrt(n (1 - dropout) / 2) / sd (the assurance integral). (2) The EVPPI table puts the input that moves the
  # decision first and an input the utility does not read last, and the three agree with the engine's own function on the same draws.
  sc <- .n140_two_arm(list(utility = "success_probability", successValue = NULL, costPerPatient = NULL, unit = NULL,
                           options = list(list(label = "n100", nPerArm = 100), list(label = "n300", nPerArm = 300)),
                           inputs = list(effect = list(family = "normal", mean = 1.0, sd = 0.7), sd = list(family = "fixed", value = 6), dropoutShare = list(family = "uniform", min = 0.0999, max = 0.1001))))
  r <- vcr_test_run(vcr_test_job("decision.value_of_information", sc, replicates = 60000L, seed = 140L))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "), paste(vapply(r$issues %||% list(), function(i) i$detail, ""), collapse = " "))))
  v <- r$diagnostics$voi
  z <- stats::qnorm(1 - 0.025)
  want <- vapply(c(100, 300), function(n) { a <- sqrt(n * 0.9 / 2) / 6; stats::pnorm((a * 1.0 - z) / sqrt(1 + a^2 * 0.7^2)) }, numeric(1))
  got <- vapply(v$options, function(o) o$expectedUtility$value, numeric(1)); ses <- vapply(v$options, function(o) o$expectedUtility$mcse, numeric(1))
  by_name <- stats::setNames(vapply(v$inputs, function(x) x$evppi$value, numeric(1)), vapply(v$inputs, function(x) x$input, ""))
  top <- v$inputs[[1L]]$input
  list(pass = all(abs(got - want) < 4 * ses) && identical(top, "effect") && by_name[["dropoutShare"]] < 0.1 * by_name[["effect"]] && identical(v$chosen, "n300") && identical(v$`next`$input, "effect"),
       detail = sprintf("expected power %.4f / %.4f against the assurance integral %.4f / %.4f (mcse %.4f); EVPPI effect %.4f, sd (fixed, none), dropout %.5f; chosen %s; the next step is the %s; EVPI %.4f",
                        got[1], got[2], want[1], want[2], max(ses), by_name[["effect"]], by_name[["dropoutShare"]], v$chosen, v$`next`$input, vcr_measure_value(r, "voi_evpi")))
})

vcr_case("N140e", c("AC-08", "AC-28"), function() {
  # The threshold of an input with no distribution. A net benefit V Phi(a delta - z) - 2 c n against no trial crosses zero where
  # delta* = (z + qnorm(2 c n / V)) / a, with a = sqrt(n (1 - dropout) / 2) / sd; the dropout is a uniform of width 0.0002 around 0.1 (the engine needs one
  # input with a distribution), so a closed form applies to within that width. The range input gets no EVPPI row and no probability, only the value, the
  # decisions at the three stated values and a standard error; the optimistic value takes the trial and the pessimistic one does not.
  sc <- .n140_two_arm(list(options = list(list(label = "no_trial", nPerArm = 0), list(label = "n300", nPerArm = 300)),
                           inputs = list(effect = list(family = "range", optimistic = 2.0, base = 1.2, pessimistic = 0.2), sd = list(family = "fixed", value = 7),
                                         dropoutShare = list(family = "uniform", min = 0.0999, max = 0.1001))))
  r <- vcr_test_run(vcr_test_job("decision.value_of_information", sc, replicates = 4000L, seed = 141L))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  v <- r$diagnostics$voi
  th <- v$thresholds[[1L]]
  a <- sqrt(300 * 0.9 / 2) / 7
  want <- (stats::qnorm(0.975) + stats::qnorm(2 * 0.2 * 300 / 400)) / a
  f <- th$flips[[1L]]
  rows <- vapply(v$inputs, function(x) x$input, "")
  list(pass = length(th$flips) == 1L && abs(f$value - want) < 2e-3 && f$mcse > 0 && identical(th$decisionAt$optimistic, "n300") && identical(th$decisionAt$pessimistic, "no_trial") &&
         !("effect" %in% rows) && identical(f$from, "no_trial") && identical(f$to, "n300") && f$reproduced >= 10L,
       detail = sprintf("the effect at which the trial pays: %.5f (closed form %.5f, bootstrap se %.4f, %d of %d resamples found it); decisions at the optimistic / base / pessimistic values: %s / %s / %s; the EVPPI rows are %s (none for the range)",
                        f$value, want, f$mcse, f$reproduced, f$resamples, th$decisionAt$optimistic, th$decisionAt$base, th$decisionAt$pessimistic, paste(rows, collapse = ", ")))
})

vcr_case("N140f", c("AC-08", "AC-28"), function() {
  # EVSI: a larger study is worth more, none is worth more than learning the input it observes (the EVPPI ceiling), an enormous one is worth that ceiling,
  # and a study of the control arm is worth nothing when the effect does not read the control arm. The same noise path is used at every size (one seed).
  mk <- function(m, kind = "phase2_effect") list(label = paste0(kind, m), kind = kind, size = m)
  sc <- .n140_two_arm(list(studies = list(mk(10), mk(40), mk(160), mk(1e7)), inputs = list(effect = list(family = "normal", mean = 1.0, sd = 0.9), sd = list(family = "fixed", value = 7), dropoutShare = list(family = "uniform", min = 0.0999, max = 0.1001))))
  r <- vcr_test_run(vcr_test_job("decision.value_of_information", sc, replicates = 20000L, seed = 142L))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  v <- r$diagnostics$voi
  ev <- vapply(v$studies, function(s) s$evsi$value, numeric(1)); se <- vapply(v$studies, function(s) s$evsi$mcse, numeric(1))
  ceil <- v$studies[[1L]]$ceiling
  # a natural-history study when the effect is absolute: the control worsening is not an input of the decision
  sc2 <- .n140_two_arm(list(studies = list(mk(200, "natural_history_control")), inputs = list(effect = list(family = "normal", mean = 1.0, sd = 0.9), sd = list(family = "fixed", value = 7),
                                                             controlProgression = list(family = "lognormal", meanlog = 0.9, sdlog = 0.3), dropoutShare = list(family = "uniform", min = 0.0999, max = 0.1001))))
  r2 <- vcr_test_run(vcr_test_job("decision.value_of_information", sc2, replicates = 20000L, seed = 142L))
  e2 <- r2$diagnostics$voi$studies[[1L]]$evsi
  list(pass = all(diff(ev) > 0) && all(ev <= ceil + 4 * se) && abs(ev[4L] - ceil) < 4 * (se[4L] + v$inputs[[1L]]$evppi$mcse) + 1e-9 && abs(e2$value) < 4 * e2$mcse + 0.002 * vcr_measure_value(r2, "voi_evpi") &&
         identical(r2$diagnostics$voi$notApplied[[1L]]$key, "inputs.controlProgression"),
       detail = sprintf("EVSI of a phase 2 of 10 / 40 / 160 / 10 million per arm %.3f / %.3f / %.3f / %.3f against the EVPPI of the effect %.3f (mcse %.3f); a natural-history cohort when the effect is absolute %.4f (mcse %.4f), the unused input named in notApplied",
                        ev[1], ev[2], ev[3], ev[4], ceil, max(se), e2$value, e2$mcse))
})

vcr_case("N140g", c("AC-08", "AC-25", "AC-31"), function() {
  # The table form and the refusals. A table made from the engine's own draws gives the engine's own EVPPI table through the job (the `voi` interface:
  # the engine does not know where the numbers came from); an input the utilities never read is worth about nothing and ranks last; same seed on 1 and 2 cores
  # is one hash; the refusals name their reason and say nothing else (a negative sd draw, no uncertain input, a proportional effect with no control worsening, fewer draws than a regression has parameters).
  set.seed(1401L, kind = VCR_RNG_KIND); S <- 3000L
  th <- stats::rnorm(S, 0.5, 1); w <- stats::rnorm(S, 0, 1); junk <- stats::rnorm(S)
  U <- cbind(a = 0, b = th + 0.5 * w)
  tb <- list(source = "table", unit = "u", utilities = list(a = U[, 1], b = U[, 2]), draws = list(theta = th, w = w, junk = junk), groups = list(list("theta", "w")),
             studies = list(list(label = "trial", kind = "normal_known", input = "theta", sd = 1, size = 25)))
  j <- vcr_test_job("decision.value_of_information", tb, replicates = S)
  r <- vcr_test_run(j); r2 <- vcr_test_run(utils::modifyList(j, list(cores = 2L)))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the table job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  rows <- r$diagnostics$voi$inputs
  direct <- vcr_voi_evppi(U, cbind(theta = th, w = w, junk = junk), "theta")$evppi
  by <- stats::setNames(vapply(rows, function(x) x$evppi$value, numeric(1)), vapply(rows, function(x) x$input, ""))
  refuse <- function(sc, ...) { x <- vcr_test_run(vcr_test_job("decision.value_of_information", sc, ...)); c(x$status, vcr_test_issue_codes(x)) }
  neg <- refuse(.n140_two_arm(list(inputs = list(effect = list(family = "normal", mean = 1, sd = 0.5), sd = list(family = "normal", mean = 1, sd = 3)))), seed = 3L)
  none <- refuse(.n140_two_arm(list(inputs = list(effect = list(family = "fixed", value = 1), sd = list(family = "fixed", value = 7)))), seed = 3L)
  slow <- refuse(.n140_two_arm(list(effectScale = "proportional_slowing")), seed = 3L)
  tiny <- refuse(.n140_two_arm(), seed = 3L, replicates = 10L)
  # few draws is a precision, not an execution problem: it runs and the premises say how little it had
  few <- vcr_test_run(vcr_test_job("decision.value_of_information", .n140_two_arm(), seed = 3L, replicates = 200L))
  few_noted <- identical(few$status, "succeeded") && any(vapply(few$diagnostics$voi$assumed, function(a) identical(a$key, "draws.few"), logical(1)))
  ok_codes <- c("scenario_value_invalid", "scenario_value_invalid", "scenario_field_missing", "replicates_invalid")
  got_codes <- c(neg[2], none[2], slow[2], tiny[2])
  list(pass = abs(by[["theta"]] - direct) < 1e-9 && by[["junk"]] < 0.02 * by[["theta"]] && identical(rows[[length(rows)]]$input, "junk") && identical(r$manifest$outputHash, r2$manifest$outputHash) &&
         all(c(neg[1], none[1], slow[1], tiny[1]) == "failed") && identical(got_codes, ok_codes) && few_noted && length(vcr_validate_result(r)) == 0L,
       detail = sprintf("table EVPPI theta %.5f = the function's %.5f, theta+w %.5f, junk %.5f (ranked last); 1 and 2 cores one hash; refusals %s; 200 draws run and say so: %s",
                        by[["theta"]], direct, by[["theta + w"]], by[["junk"]], paste(got_codes, collapse = "/"), few_noted))
})

vcr_case("N140h", c("AC-08", "AC-28"), function() {
  # review S18. (1) The threshold bootstrap runs only when a range input flips the decision and used to reseed the global stream, so the EVSI noise drawn after it
  # depended on whether it ran. Two problems with the SAME draws (the range input is held at its base in every draw) that differ only in whether the range's
  # optimistic and pessimistic values flip the decision must give the same EVSI to the bit. (2) The interval of an EVPPI leaves out the regression's upward bias:
  # the result states it and measures it on a shuffled input (an input that tells nothing: its true EVPPI is zero).
  mk <- function(lo, hi) .n140_two_arm(list(options = list(list(label = "no_trial", nPerArm = 0), list(label = "n300", nPerArm = 300)),
                                            studies = list(list(label = "phase2", kind = "phase2_effect", size = 40)),
                                            inputs = list(effect = list(family = "normal", mean = 1.0, sd = 0.9), sd = list(family = "range", optimistic = lo, base = 7, pessimistic = hi),
                                                          dropoutShare = list(family = "uniform", min = 0.0999, max = 0.1001))))
  run <- function(sc) vcr_test_run(vcr_test_job("decision.value_of_information", sc, replicates = 8000L, seed = 143L))
  flip <- run(mk(2, 40)); calm <- run(mk(6.9, 7.1))
  nf <- flip$diagnostics$voi$thresholds[[1L]]$flips; nc <- calm$diagnostics$voi$thresholds[[1L]]$flips
  same <- identical(flip$diagnostics$voi$studies[[1L]]$evsi$value, calm$diagnostics$voi$studies[[1L]]$evsi$value) &&
    identical(flip$diagnostics$voi$inputs[[1L]]$evppi$value, calm$diagnostics$voi$inputs[[1L]]$evppi$value)
  reg <- flip$diagnostics$voi$regression
  evpi <- vcr_measure_value(flip, "voi_evpi")
  list(pass = length(nf) >= 1L && length(nc) == 0L && same && !is.null(reg$noiseFloor) && reg$noiseFloor$evppi < 0.05 * evpi && grepl("upward bias", reg$intervalOmits, fixed = TRUE),
       detail = sprintf("a problem whose range input flips the decision (%d flip) and one whose range does not (%d flips), same draws: the EVSI of the 40-per-arm phase 2 is %s to the bit (%.6f and %.6f); the shuffled-input noise floor of the EVPPI is %.5f (%.2f%% of the EVPI %.4f)",
                        length(nf), length(nc), if (same) "identical" else "DIFFERENT", flip$diagnostics$voi$studies[[1L]]$evsi$value, calm$diagnostics$voi$studies[[1L]]$evsi$value, reg$noiseFloor$evppi, 100 * reg$noiseFloor$shareOfEvpi, evpi))
})
