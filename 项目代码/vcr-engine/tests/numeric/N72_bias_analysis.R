# N72 — comparator.bias_analysis: quantitative bias analysis of an estimate (algorithm round C1, C2, 2026-11-03).
#
# References that are not the method's own code: the closed forms written out in the case (the tipping bias exp(|theta| - 1.96 s), the shifted-null
# z and p from `stats::pnorm`); the `tipr` package's confounder solutions (a binary confounder: `tip_with_binary`; a normal one: `tip_rr`;
# a coefficient: `tip_coef`), which solve the same bias-factor equations by their own code; Cornfield's inequality (1959), the published
# condition that a confounder must be at least as many times more common among the exposed as the observed relative risk when it is a
# great deal stronger than the exposure; and a probabilistic analysis whose distribution is known: a bias that is uniform has quantiles in
# closed form, and its combination with the sampling error is a one-dimensional integral that is solved with `integrate` and `uniroot`,
# not simulated.

.n72_job <- function(scenario, id, seed = 7L, replicates = NULL) {
  vcr_test_job("comparator.bias_analysis", scenario, NULL, seed = seed, job_id = paste0("job_", id), replicates = replicates)
}

vcr_case("N72a", c("AC-08", "AC-30"), function() {
  # The tipping bias and the shifted null against their closed forms, on a protective ratio, a harmful ratio, an interval already holding the
  # null, a standard error in place of an interval, and a difference; the bias moves the estimate toward the null whatever side it is on.
  z <- stats::qnorm(0.975)
  one <- function(scale, est, lo, hi, biases) {
    sc <- list(scale = scale, estimate = est, lower = lo, upper = hi, shiftedNull = list(biases = as.list(biases)))
    r <- vcr_test_run(.n72_job(sc, paste0("n72a_", scale, "_", est)))
    ratio <- scale != "difference"; f <- if (ratio) log else identity; back <- if (ratio) exp else identity
    th <- f(est); se <- (f(hi) - f(lo)) / (2 * z); sig <- if (th < 0) -1 else 1
    lim <- sig * th - z * se
    want_limit <- if (lim > 0) back(lim) else if (ratio) 1 else 0
    rows <- r$diagnostics$biasAnalysis$shiftedNull$rows
    ok_rows <- all(vapply(seq_along(biases), function(i) {
      beta <- f(biases[i]) ; if (!ratio) beta <- biases[i]
      zz <- (abs(th) - beta) / se; adj <- th - sig * beta
      abs(rows[[i]]$z - zz) < 1e-12 && abs(rows[[i]]$p - (1 - stats::pnorm(zz))) < 1e-12 && abs(rows[[i]]$adjustedEstimate - back(adj)) < 1e-12 &&
        abs(rows[[i]]$lower - back(adj - z * se)) < 1e-12 && abs(rows[[i]]$upper - back(adj + z * se)) < 1e-12
    }, logical(1)))
    c(ok = identical(r$status, "succeeded") && abs(vcr_measure_value(r, "bias_tipping_limit") - want_limit) < 1e-12 &&
        abs(vcr_measure_value(r, "bias_tipping_estimate") - back(abs(th))) < 1e-12 && ok_rows && length(vcr_validate_result(r)) == 0L &&
        identical(r$diagnostics$biasAnalysis$tipping$alreadyIncludesNull, !(lim > 0)),
      limit = vcr_measure_value(r, "bias_tipping_limit"), want = want_limit, est = vcr_measure_value(r, "bias_tipping_estimate"))
  }
  rr <- list(one("hazard_ratio", 0.70, 0.50, 0.98, c(1, 1.25, 1.5)), one("risk_ratio", 1.8, 1.2, 2.7, c(1.1, 1.4)),
             one("odds_ratio", 0.85, 0.60, 1.20, c(1.05)), one("difference", -2.4, -3.9, -0.9, c(0.5, 1.5, 3)),
             one("difference", 1.2, 0.2, 2.2, c(0, 1)))
  # a standard error in place of limits: the same estimate, the same numbers
  se <- (log(0.98) - log(0.50)) / (2 * z)
  a <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = 0.7, se = se), "n72a_se"))
  b <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = 0.7, lower = 0.5, upper = 0.98), "n72a_ci"))
  # a 90% interval: the standard error is backed out with the 90% quantile
  c90 <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = 0.7, lower = 0.5, upper = 0.98, confidenceLevel = 0.9), "n72a_90"))
  se90 <- (log(0.98) - log(0.50)) / (2 * stats::qnorm(0.95))
  want90 <- if (abs(log(0.7)) - z * se90 > 0) exp(abs(log(0.7)) - z * se90) else 1   # this interval, read as 90%, holds the null: no bias needed
  ok <- all(vapply(rr, function(x) isTRUE(as.logical(x[["ok"]])), logical(1))) &&
    abs(vcr_measure_value(a, "bias_tipping_limit") - vcr_measure_value(b, "bias_tipping_limit")) < 1e-12 &&
    abs(vcr_measure_value(c90, "bias_tipping_limit") - want90) < 1e-12
  list(pass = ok,
       detail = sprintf("tipping bias to the interval's limit: HR 0.70 (0.50-0.98) %.6f (closed form %.6f), the point estimate %.6f = 1/0.70; RR 1.8 %.4f; OR 0.85 whose interval holds 1: %.1f and flagged; difference -2.4 %.4f (want %.4f); a standard error in place of limits gives %.12f vs %.12f; a 90%% interval %.6f vs %.6f",
                        rr[[1]][["limit"]], rr[[1]][["want"]], rr[[1]][["est"]], rr[[2]][["limit"]], rr[[3]][["limit"]], rr[[4]][["limit"]], rr[[4]][["want"]],
                        vcr_measure_value(a, "bias_tipping_limit"), vcr_measure_value(b, "bias_tipping_limit"), vcr_measure_value(c90, "bias_tipping_limit"), want90))
})

vcr_case("N72b", c("AC-08", "AC-30"), function() {
  # The tipping confounder against tipr. A binary confounder: for a harmful ratio the exposed prevalence that tips it given the unexposed one is
  # tipr's `tip_with_binary`; for a protective ratio the confounder is the more common among the controls, the same equation seen from the
  # other arm. A normal confounder: tipr's `tip_rr`. A coefficient: tipr's `tip_coef`. Also at the interval's nearer limit, where tipr is asked for
  # that number.
  suppressMessages(library(tipr))
  tip_bin <- function(b, g, p_other) tipr::tip_with_binary(b, unexposed_confounder_prev = p_other, confounder_outcome_effect = g, verbose = FALSE)$exposed_confounder_prev
  # harmful: HR 1.6 (1.2 - 2.1); gamma 2 and 3; unexposed prevalence 0.1 and 0.25
  h <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = 1.6, lower = 1.2, upper = 2.1,
                                  confounderTipping = list(associations = list(2, 3), baselinePrevalence = 0.1)), "n72b_h"))
  hrows <- h$diagnostics$biasAnalysis$confounderTipping$rows
  z <- stats::qnorm(0.975); se <- (log(2.1) - log(1.2)) / (2 * z); lim <- exp(log(1.6) - z * se)
  d_h <- c(abs(hrows[[1]]$estimate$carrierPrevalence - tip_bin(1.6, 2, 0.1)), abs(hrows[[2]]$estimate$carrierPrevalence - tip_bin(1.6, 3, 0.1)),
           abs(hrows[[1]]$limit$carrierPrevalence - tip_bin(lim, 2, 0.1)), abs(hrows[[2]]$limit$carrierPrevalence - tip_bin(lim, 3, 0.1)))
  # protective: HR 0.65 (0.50 - 0.85); tipr is given the exposed (treated) prevalence 0.05 and solves for the unexposed one, which is the carrier here
  p <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = 0.65, lower = 0.5, upper = 0.85,
                                  confounderTipping = list(associations = list(2, 4), baselinePrevalence = 0.05)), "n72b_p"))
  prow <- p$diagnostics$biasAnalysis$confounderTipping$rows
  tip_p0 <- function(b, g, p1) tipr::tip_with_binary(b, exposed_confounder_prev = p1, confounder_outcome_effect = g, verbose = FALSE)$unexposed_confounder_prev
  d_p <- c(abs(prow[[1]]$estimate$carrierPrevalence - tip_p0(0.65, 2, 0.05)), abs(prow[[2]]$estimate$carrierPrevalence - tip_p0(0.65, 4, 0.05)))
  # a normal confounder of unit variance: the standardised difference is tipr's exposure-confounder effect (as a magnitude)
  tn <- tipr::tip_rr(1.6, confounder_outcome_effect = 2, verbose = FALSE)$exposure_confounder_effect
  # a coefficient: the difference scale, estimate 0.8 (0.3 - 1.3), association 0.5 per unit
  dd <- vcr_test_run(.n72_job(list(scale = "difference", estimate = 0.8, lower = 0.3, upper = 1.3,
                                   confounderTipping = list(associations = list(0.5, 2), baselinePrevalence = 0)), "n72b_d"))
  drow <- dd$diagnostics$biasAnalysis$confounderTipping$rows
  tc <- tipr::tip_coef(0.8, confounder_outcome_effect = 2, verbose = FALSE)$exposure_confounder_effect
  # infeasible: the estimate is too large for the association (the carrier prevalence would exceed 1): said, not forced
  big <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = 6, lower = 4, upper = 9, confounderTipping = list(associations = list(1.5), baselinePrevalence = 0.2)), "n72b_big"))
  ok <- identical(h$status, "succeeded") && all(d_h < 1e-12) && all(d_p < 1e-12) &&
    abs(hrows[[1]]$estimate$standardizedDifference - tn) < 1e-12 && abs(drow[[2]]$estimate$prevalenceDifference - tc) < 1e-12 &&
    identical(hrows[[1]]$estimate$carrier, "treated") && identical(prow[[1]]$estimate$carrier, "control") &&
    !isTRUE(big$diagnostics$biasAnalysis$confounderTipping$rows[[1]]$estimate$feasible) && is.na(big$diagnostics$biasAnalysis$confounderTipping$rows[[1]]$estimate$carrierPrevalence) &&
    identical(h$diagnostics$biasAnalysis$confounderTipping$rows[[1]]$estimate$feasible, TRUE) &&
    length(vcr_validate_result(h)) == 0L && length(vcr_validate_result(dd)) == 0L
  list(pass = ok,
       detail = sprintf("harmful HR 1.6 (gamma 2, 3; baseline prevalence 0.1): the treated prevalence that tips it %.6f / %.6f vs tipr %.6f / %.6f, at the interval's limit %.6f vs %.6f (largest difference %.1e); protective HR 0.65: the control prevalence %.6f / %.6f vs tipr %.6f / %.6f; normal confounder %.6f vs tip_rr %.6f; difference scale %.6f vs tip_coef %.6f; HR 6 with gamma 1.5 and baseline 0.2 is infeasible",
                        hrows[[1]]$estimate$carrierPrevalence, hrows[[2]]$estimate$carrierPrevalence, tip_bin(1.6, 2, 0.1), tip_bin(1.6, 3, 0.1), hrows[[1]]$limit$carrierPrevalence, tip_bin(lim, 2, 0.1), max(d_h),
                        prow[[1]]$estimate$carrierPrevalence, prow[[2]]$estimate$carrierPrevalence, tip_p0(0.65, 2, 0.05), tip_p0(0.65, 4, 0.05),
                        hrows[[1]]$estimate$standardizedDifference, tn, drow[[2]]$estimate$prevalenceDifference, tc))
})

vcr_case("N72c", c("AC-08", "AC-30"), function() {
  # Cornfield (1959): with a confounder far stronger than the exposure (gamma -> infinity), the prevalence among the exposed that explains an
  # observed relative risk of 9 away is 9 times the prevalence among the unexposed - and with 20% of the unexposed carrying it, no prevalence will do.
  r <- vcr_test_run(.n72_job(list(scale = "risk_ratio", estimate = 9, lower = 7, upper = 11.6, confounderTipping = list(associations = list(1e7), baselinePrevalence = 0.05)), "n72c_a"))
  r2 <- vcr_test_run(.n72_job(list(scale = "risk_ratio", estimate = 9, lower = 7, upper = 11.6, confounderTipping = list(associations = list(1e7), baselinePrevalence = 0.2)), "n72c_b"))
  row1 <- r$diagnostics$biasAnalysis$confounderTipping$rows[[1]]$estimate; row2 <- r2$diagnostics$biasAnalysis$confounderTipping$rows[[1]]$estimate
  ok <- abs(row1$carrierPrevalence / 0.05 - 9) < 1e-4 && !isTRUE(row2$feasible) && is.na(row2$carrierPrevalence)
  list(pass = ok, detail = sprintf("relative risk 9, gamma 1e7, unexposed prevalence 0.05: exposed prevalence %.6f = %.5f times 0.05 (Cornfield: 9); unexposed prevalence 0.2: feasible %s (9 x 0.2 > 1)",
                                   row1$carrierPrevalence, row1$carrierPrevalence / 0.05, row2$feasible))
})

vcr_case("N72d", c("AC-08", "AC-11", "AC-28", "AC-30"), function() {
  # The probabilistic analysis against a distribution that is known. A bias that is uniform on [1.0, 1.4] on an HR of 0.60 with the interval
  # 0.45-0.80: its systematic-only quantiles are closed forms (0.6 x B at B's quantiles); with the sampling error added, the distribution is a mixture
  # whose quantiles are found with integrate and uniroot. Every simulated number is within 3 of its own Monte-Carlo errors of that value.
  est <- 0.6; lo <- 0.45; hi <- 0.8; z <- stats::qnorm(0.975)
  se <- (log(hi) - log(lo)) / (2 * z); th <- log(est)
  b0 <- 1; b1 <- 1.4
  r <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = est, lower = lo, upper = hi,
                                  probabilistic = list(bias = list(family = "uniform", min = b0, max = b1))), "n72d", replicates = 200000L))
  pa <- r$diagnostics$biasAnalysis$probabilistic
  # the true bias is the exaggerating one: the estimate below 1 is taken back toward 1, theta_adj = theta + log B
  sys_q <- function(p) est * (b0 + p * (b1 - b0))                     # exp(theta + log B): the quantile of B is linear in p
  cdf_comb <- function(x) stats::integrate(function(b) stats::pnorm((x - (th + log(b))) / se) / (b1 - b0), b0, b1, rel.tol = 1e-10)$value
  q_comb <- function(p) stats::uniroot(function(x) cdf_comb(x) - p, c(th - 6 * se, th + log(b1) + 6 * se), tol = 1e-12)$root
  want_med <- exp(q_comb(0.5)); want_lo <- exp(q_comb(0.025)); want_hi <- exp(q_comb(0.975))
  want_persist <- cdf_comb(0)   # P(adjusted log ratio < 0): the effect is still protective, persists = mean(sigma * x > 0) with sigma = -1
  m <- vcr_get_measure(r, "bias_adjusted_estimate"); pers <- vcr_get_measure(r, "bias_adjusted_effect_persists")
  ok <- identical(r$status, "succeeded") && isTRUE(m$simulated) && isTRUE(pers$simulated) &&
    abs(pa$systematic$median - sys_q(0.5)) < 3 * pa$systematic$medianMcse && abs(pa$systematic$low - sys_q(0.025)) < 3 * pa$systematic$lowMcse &&
    abs(pa$systematic$high - sys_q(0.975)) < 3 * pa$systematic$highMcse &&
    abs(m$value - want_med) < 3 * m$mcse && abs(m$interval$low - want_lo) < 3 * pa$combined$lowMcse && abs(m$interval$high - want_hi) < 3 * pa$combined$highMcse &&
    abs(pers$value - want_persist) < 3 * pers$mcse && identical(pa$draws, 200000L) && identical(m$interval$kind, "monte_carlo") &&
    length(vcr_validate_result(r)) == 0L
  list(pass = ok,
       detail = sprintf("uniform bias 1.0-1.4 on HR 0.60: systematic median %.5f (closed form %.5f, mcse %.5f), 2.5%% %.5f vs %.5f, 97.5%% %.5f vs %.5f; with the sampling error: median %.5f vs %.5f (mcse %.5f), interval %.5f-%.5f vs %.5f-%.5f; share still protective %.5f vs %.5f (mcse %.5f); %d draws",
                        pa$systematic$median, sys_q(0.5), pa$systematic$medianMcse, pa$systematic$low, sys_q(0.025), pa$systematic$high, sys_q(0.975),
                        m$value, want_med, m$mcse, m$interval$low, m$interval$high, want_lo, want_hi, pers$value, want_persist, pers$mcse, pa$draws))
})

vcr_case("N72e", c("AC-08", "AC-11", "AC-28", "AC-30", "AC-31"), function() {
  # A confounder model with a known truth, run through the whole pipeline: a study of a true HR 1 whose observed HR 0.70 is made by a binary confounder
  # (prevalence 0.15 among the treated, 0.45 among the controls, association 1.8 on the outcome ratio: bias factor 0.82) - the probabilistic analysis
  # that states those parameters (point masses) recovers the truth to the arithmetic, and one that states a range around them brackets it. Same seed, one
  # core and two: bit for bit; the draws follow the replicates asked for; a cancel is a cancel.
  g <- 1.8; p1 <- 0.15; p0 <- 0.45   # the carrier of the protective bias is the control arm
  bf <- (g * p1 + 1 - p1) / (g * p0 + 1 - p0)                  # observed / true, < 1: the confounder makes the treatment look protective
  obs <- 1 * bf
  const <- list(family = "constant")
  spec <- list(confounder = list(exposedPrevalence = c(const, list(value = p1)), unexposedPrevalence = c(const, list(value = p0)), association = c(const, list(value = g))))
  r <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = obs, lower = obs * 0.8, upper = obs * 1.25, probabilistic = spec), "n72e"))
  pa <- r$diagnostics$biasAnalysis$probabilistic
  # with constants every systematic draw is the truth: the interval has no width and the combined one is the sampling error alone
  se <- (log(obs * 1.25) - log(obs * 0.8)) / (2 * stats::qnorm(0.975))
  range_spec <- list(confounder = list(exposedPrevalence = list(family = "uniform", min = 0.1, max = 0.2), unexposedPrevalence = list(family = "uniform", min = 0.4, max = 0.5),
                                       association = list(family = "triangular", min = 1.5, mode = 1.8, max = 2.2)))
  rr <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = obs, lower = obs * 0.8, upper = obs * 1.25, probabilistic = range_spec), "n72e2", replicates = 60000L))
  pr <- rr$diagnostics$biasAnalysis$probabilistic
  a <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = 0.7, lower = 0.5, upper = 0.98, probabilistic = range_spec), "n72e3", seed = 99L, replicates = 40000L))
  j2 <- .n72_job(list(scale = "hazard_ratio", estimate = 0.7, lower = 0.5, upper = 0.98, probabilistic = range_spec), "n72e3", seed = 99L, replicates = 40000L); j2$cores <- 2L
  b <- vcr_test_run(j2)
  # a run cut short by the CPU budget keeps the batches it finished
  inp <- .vcr_bias_input(list(scale = "hazard_ratio", estimate = 0.7, lower = 0.5, upper = 0.98))
  vcr_ctx_begin(NULL, 0.02)
  cut <- tryCatch(vcr_bias_probabilistic(inp, range_spec, 2000000L, 5L, batch = 1000L), finally = vcr_ctx_end())
  ok <- identical(r$status, "succeeded") && abs(pa$systematic$median - 1) < 1e-12 && abs(pa$systematic$low - 1) < 1e-12 && abs(pa$systematic$high - 1) < 1e-12 &&
    abs(pa$combined$low - exp(-1.959964 * se)) < 4 * pa$combined$lowMcse && abs(pa$combined$high - exp(1.959964 * se)) < 4 * pa$combined$highMcse &&
    pr$systematic$low < 1 && pr$systematic$high > 1 && pr$systematic$low > 0.7 &&
    identical(a$manifest$outputHash, b$manifest$outputHash) && identical(pr$draws, 60000L) &&
    identical(cut$interrupted, "cpu_budget") && cut$draws > 0L && cut$draws < 2000000L && cut$draws %% 1000L == 0L &&
    length(vcr_validate_result(r)) == 0L
  list(pass = ok,
       detail = sprintf("a confounder (prevalence %.2f / %.2f, association %.1f) makes a true HR of 1 look like %.4f; stating those parameters exactly removes it: median %.12f, 2.5-97.5%% %.4f-%.4f (the sampling error alone %.4f-%.4f); stating ranges around them: systematic 2.5-97.5%% %.4f-%.4f brackets 1; one core and two give the same output hash: %s; a CPU budget of 0.02 s kept %d of 2000000 draws (%s)",
                        p1, p0, g, obs, pa$systematic$median, pa$combined$low, pa$combined$high, exp(-1.959964 * se), exp(1.959964 * se), pr$systematic$low, pr$systematic$high,
                        identical(a$manifest$outputHash, b$manifest$outputHash), cut$draws, cut$interrupted))
})

vcr_case("N72f", c("AC-07", "AC-30"), function() {
  # Refusals by name, each of its own input and nothing else: a limit beyond the estimate, a ratio at or below 0, a bias below 1 for a ratio, no interval
  # or error, a distribution with its minimum above its maximum, a prevalence outside [0, 1].
  run <- function(sc) vcr_test_run(.n72_job(sc, paste0("n72f_", sample.int(1e6, 1))))
  base <- list(scale = "hazard_ratio", estimate = 0.7, lower = 0.5, upper = 0.98)
  codes <- list(
    est_outside = run(utils::modifyList(base, list(estimate = 1.2))),
    ratio_zero = run(utils::modifyList(base, list(estimate = 0, lower = NULL))),
    bias_below_one = run(utils::modifyList(base, list(shiftedNull = list(biases = list(0.9))))),
    min_above_max = run(utils::modifyList(base, list(probabilistic = list(bias = list(family = "uniform", min = 1.4, max = 1.1))))),
    prevalence = run(utils::modifyList(base, list(probabilistic = list(confounder = list(exposedPrevalence = list(family = "uniform", min = 0.3, max = 1.4),
      unexposedPrevalence = list(family = "constant", value = 0.2), association = list(family = "constant", value = 2)))))),
    gamma_one = run(utils::modifyList(base, list(confounderTipping = list(associations = list(1)))))
  )
  got <- vapply(codes, function(r) paste0(r$status, ":", paste(vcr_test_issue_codes(r), collapse = ",")), character(1))
  none <- run(list(scale = "hazard_ratio", estimate = 0.7))
  ok <- all(vapply(codes, function(r) identical(r$status, "failed") && length(r$measures) == 0L, logical(1))) && !identical(none$status, "succeeded")
  list(pass = ok, detail = paste(c(paste(names(got), got, sep = " -> "), paste0("no interval or error -> ", none$status, ":", paste(vcr_test_issue_codes(none), collapse = ","))), collapse = "; "))
})

vcr_case("N72g", c("AC-08", "AC-30"), function() {
  # A confounder that LOWERS the outcome (an association below 1), against tipr on the ratio scale. N72b held tipr only at associations above
  # 1, and the code answered a protective association of 0.5 with the answer for an association of 2: the same equation seen from the other
  # arm is not the same equation (a protective association of 0.5, no confounder among the controls, tips an estimate of 0.7 at a treated
  # prevalence of 0.6, not 0.4286). Each row is also substituted back into the bias factor, which is what the closed form has to return.
  suppressMessages(library(tipr))
  run <- function(est, lo, hi, g, base, id) {
    r <- vcr_test_run(.n72_job(list(scale = "hazard_ratio", estimate = est, lower = lo, upper = hi, confounderTipping = list(associations = list(g), baselinePrevalence = base)), id))
    r$diagnostics$biasAnalysis$confounderTipping$rows[[1]]
  }
  tip_bin <- function(b, g, base, protective_estimate) {
    if (protective_estimate) tipr::tip_with_binary(b, unexposed_confounder_prev = base, confounder_outcome_effect = g, verbose = FALSE)$exposed_confounder_prev
    else tipr::tip_with_binary(b, exposed_confounder_prev = base, confounder_outcome_effect = g, verbose = FALSE)$unexposed_confounder_prev
  }
  # the bias factor an arm pair gives: the treated arm's risk factor over the control's
  back <- function(row_part, g, base) {
    f <- function(x) 1 + (g - 1) * x
    if (identical(row_part$carrier, "treated")) f(row_part$carrierPrevalence) / f(base) else f(base) / f(row_part$carrierPrevalence)
  }
  cfg <- list(list(est = 0.7, lo = 0.55, hi = 0.89, g = 0.5, base = 0), list(est = 0.7, lo = 0.55, hi = 0.89, g = 0.5, base = 0.2), list(est = 1.4, lo = 1.1, hi = 1.8, g = 0.5, base = 0.2),
              list(est = 1.4, lo = 1.1, hi = 1.8, g = 0.25, base = 0.1), list(est = 0.65, lo = 0.5, hi = 0.85, g = 0.4, base = 0.05))
  worst_tipr <- 0; worst_back <- 0; text <- character()
  z <- stats::qnorm(0.975)
  for (i in seq_along(cfg)) {
    k <- cfg[[i]]
    row <- run(k$est, k$lo, k$hi, k$g, k$base, paste0("n72g_", i))
    ref <- tip_bin(k$est, k$g, k$base, k$est < 1)
    # and at the interval's nearer limit, the number the page also shows
    se <- (log(k$hi) - log(k$lo)) / (2 * z); lim <- if (k$est < 1) exp(log(k$est) + z * se) else exp(log(k$est) - z * se)
    ref_lim <- tip_bin(lim, k$g, k$base, k$est < 1)
    worst_tipr <- max(worst_tipr, abs(row$estimate$carrierPrevalence - ref), if (is.finite(ref_lim)) abs(row$limit$carrierPrevalence - ref_lim) else 0)
    worst_back <- max(worst_back, abs(back(row$estimate, k$g, k$base) - k$est))
    text <- c(text, sprintf("HR %.2f, gamma %.2f, baseline %.2f: %s prevalence %.4f (tipr %.4f; the bias factor it gives %.4f)", k$est, k$g, k$base, row$estimate$carrier, row$estimate$carrierPrevalence, ref, back(row$estimate, k$g, k$base)))
  }
  list(pass = worst_tipr < 1e-9 && worst_back < 1e-9, detail = sprintf("%s; largest difference from tipr %.1e, from the substituted bias factor %.1e", paste(text, collapse = "; "), worst_tipr, worst_back))
})
