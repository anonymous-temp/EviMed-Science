# N39 — prognostic covariate adjustment of a binary and a time-to-event endpoint.
#
# References that are not this method's own code: the published numbers of FDA's
# 2023 covariate-adjustment guidance, Table 1 (marginal odds ratio 4.8 against a
# conditional one of 8.0); an M-estimation sandwich built from numerical Jacobians
# (numDeriv) and `sandwich::sandwich` on the glm; survival::coxph and
# survival::survfit(newdata) averaged by hand for the Cox model and the
# standardised restricted mean; and simulations whose true marginal effects are
# integrals computed here (integrate), so unbiasedness and the standard errors are
# measured against the truth and not against the method.

.n39_job <- function(sc, inputs, replicates = NULL, seed = 1L, id = "job_n39", ...) {
  vcr_test_run(vcr_test_job("comparator.prognostic_adjustment", sc, inputs, seed = seed, replicates = replicates, job_id = id), ...)
}
.n39_reg_ok <- function(r) identical(r$diagnostics$regulatoryStatus$qualification, vcr_domain()$prognosticQualification) &&
  identical(r$diagnostics$regulatoryStatus$qualification, "none_beyond_continuous") &&
  all(c("binary", "time_to_event") %in% unlist(r$diagnostics$regulatoryStatus$notQualifiedEndpoints)) &&
  identical(unlist(r$diagnostics$regulatoryStatus$qualifiedEndpoints), "continuous") && nzchar(r$diagnostics$regulatoryStatus$statement)

vcr_case("N39a", c("AC-11", "AC-29", "AC-30"), function() {
  # FDA 2023 covariate-adjustment guidance, Table 1: a hypothetical trial with a biomarker in half the population. Success
  # rates: biomarker-positive 80.0% on the new drug against 33.3% on placebo, biomarker-negative 25.0% against 4.0%; the
  # conditional odds ratio is 8.0 in each subgroup and the unconditional one, over the combined population (52.5% against
  # 18.7%), is 4.8. The table is reproduced exactly with 300 people per cell (240/300, 100/300, 75/300, 12/300) and the
  # biomarker as the prognostic score: the conditional odds ratio the model gives is 8.0, the standardised (marginal) one is
  # 4.8, the marginal risks are the table's combined rates, and the risk difference and ratio (collapsible) are the
  # hand-computed 0.525 - 0.18667 = 0.33833 and 0.525 / 0.18667 = 2.8125.
  cell <- function(bio, arm, n, resp) data.frame(bio = bio, arm = arm, y = rep(c(1L, 0L), c(resp, n - resp)))
  d <- rbind(cell(1, 1, 300, 240), cell(1, 0, 300, 100), cell(0, 1, 300, 75), cell(0, 0, 300, 12))
  d$USUBJID <- sprintf("F%04d", seq_len(nrow(d)))
  inp <- vcr_test_input(d, "snp_n39a:subject", "subject")
  sc <- list(endpoint = list(type = "binary"), prognosticScoreColumn = "bio", treatmentColumn = "arm", outcomeColumn = "y")
  r <- .n39_job(sc, list(inp), seed = 3L, replicates = 20L)
  g <- function(name) vcr_measure_value(r, name)
  or_table <- (0.525 / 0.475) / (0.187 / 0.813)                 # the published rounded rates: 4.80
  ok <- identical(r$status, "succeeded") && abs(g("conditional_odds_ratio") - 8) < 1e-6 &&
    abs(g("marginal_odds_ratio") - 4.8) < 0.02 && abs(g("marginal_odds_ratio") - or_table) < 0.02 &&
    abs(g("risk_treatment_standardised") - 0.525) < 1e-9 && abs(g("risk_control_standardised") - 0.187) < 5e-4 &&
    abs(g("marginal_risk_difference") - (0.525 - 56 / 300)) < 1e-9 && abs(g("marginal_risk_ratio") - 0.525 / (56 / 300)) < 1e-9 &&
    g("marginal_odds_ratio") < g("conditional_odds_ratio") &&
    # the score is balanced across arms, so the standardised effect equals the unadjusted one
    abs(g("marginal_odds_ratio") - (0.525 / 0.475) / ((56 / 300) / (244 / 300))) < 1e-9 && abs(g("marginal_risk_difference") - g("unadjusted_risk_difference")) < 1e-9 &&
    r$diagnostics$bootstrap$replicates >= 2000L && isTRUE(r$diagnostics$nonCollapsibility$conditionalOddsRatio > r$diagnostics$nonCollapsibility$marginalOddsRatio) &&
    .n39_reg_ok(r) && g("empirical_variance_ratio") < 1
  list(pass = ok,
       detail = sprintf("FDA Table 1: conditional OR %.6f (8.0), marginal OR %.4f (4.8; from the rounded rates %.3f), standardised risks %.5f / %.5f (52.5%% / 18.7%%), RD %.5f (0.33833), RR %.4f (2.8125); the score buys a variance ratio of %.3f; regulatory field '%s'",
                        g("conditional_odds_ratio"), g("marginal_odds_ratio"), or_table, g("risk_treatment_standardised"), g("risk_control_standardised"),
                        g("marginal_risk_difference"), g("marginal_risk_ratio"), g("empirical_variance_ratio"), r$diagnostics$regulatoryStatus$qualification))
})

# a randomized binary trial with a continuous prognostic score: logit P(Y) = a0 + g arm + d x, x ~ N(0, 1); the truth is an integral
.n39_binary_dgp <- function(n, seed, a0 = -1, g = 0.9, d = 1.4) {
  set.seed(seed, kind = VCR_RNG_KIND)
  x <- stats::rnorm(n); arm <- as.integer(rank(stats::runif(n), ties.method = "first") <= n / 2)
  data.frame(arm = arm, x = x, y = stats::rbinom(n, 1L, stats::plogis(a0 + g * arm + d * x)))
}
.n39_binary_truth <- function(a0 = -1, g = 0.9, d = 1.4) {
  m <- function(a) stats::integrate(function(x) stats::plogis(a0 + g * a + d * x) * stats::dnorm(x), -Inf, Inf, rel.tol = 1e-12)$value
  m1 <- m(1); m0 <- m(0)
  c(rd = m1 - m0, log_rr = log(m1 / m0), log_or = stats::qlogis(m1) - stats::qlogis(m0))
}

vcr_case("N39b", c("AC-11", "AC-29", "AC-30"), function() {
  # The marginal binary estimate and its standard errors, against things that are not this code.
  # (1) The influence-function standard errors equal an M-estimation sandwich built from numerical Jacobians (numDeriv) on
  # the stacked equations (the logistic score and the two standardised risks), delta-method for the risk difference, log risk
  # ratio and log odds ratio, to 1e-6 relative; the conditional log odds ratio's standard error equals sandwich::sandwich on the glm.
  # (2) The sandwich standard errors are within 5% of the stratified bootstrap's (2,000 refits).
  suppressMessages({library(numDeriv); library(sandwich)})
  d <- .n39_binary_dgp(800L, 390L)
  d$USUBJID <- sprintf("B%04d", seq_len(nrow(d)))
  r <- .n39_job(list(endpoint = list(type = "binary"), prognosticScoreColumn = "x", treatmentColumn = "arm", outcomeColumn = "y"),
                list(vcr_test_input(d, "snp_n39b:subject", "subject")), seed = 4L)
  n <- nrow(d); X <- cbind(1, d$arm, d$x); X1 <- X; X1[, 2] <- 1; X0 <- X; X0[, 2] <- 0
  # (glm is run to a tighter tolerance than its default 1e-8 so that the two fits are the same fit)
  fit <- stats::glm(y ~ arm + x, family = stats::binomial(), data = d, control = stats::glm.control(epsilon = 1e-12, maxit = 100L)); b <- unname(stats::coef(fit))
  m1 <- mean(stats::plogis(X1 %*% b)); m0 <- mean(stats::plogis(X0 %*% b)); theta <- c(b, m1, m0)
  psi <- function(th) { bb <- th[1:3]; p <- as.vector(stats::plogis(X %*% bb)); cbind(X * (d$y - p), as.vector(stats::plogis(X1 %*% bb)) - th[4], as.vector(stats::plogis(X0 %*% bb)) - th[5]) }
  A <- -numDeriv::jacobian(function(th) colMeans(psi(th)), theta)
  Ainv <- solve(A); V <- Ainv %*% (crossprod(psi(theta)) / n) %*% t(Ainv) / n
  se <- function(grad) sqrt(as.numeric(t(grad) %*% V %*% grad))
  hand <- c(rd = se(c(0, 0, 0, 1, -1)), lrr = se(c(0, 0, 0, 1 / m1, -1 / m0)), lor = se(c(0, 0, 0, 1 / (m1 * (1 - m1)), -1 / (m0 * (1 - m0)))))
  got <- c(rd = r$diagnostics$standardErrors$riskDifference, lrr = r$diagnostics$standardErrors$logRiskRatio, lor = r$diagnostics$standardErrors$logOddsRatio)
  cond_hand <- sqrt(sandwich::sandwich(fit)["arm", "arm"])
  rel <- max(abs(got / hand - 1)); rel_cond <- abs(r$diagnostics$standardErrors$conditionalLogOddsRatio / cond_hand - 1)
  boot <- c(rd = r$diagnostics$bootstrap$standardErrors$riskDifference, lor = r$diagnostics$bootstrap$standardErrors$logOddsRatio)
  boot_ratio <- c(got[["rd"]] / boot[["rd"]], got[["lor"]] / boot[["lor"]])
  est_ok <- abs(vcr_measure_value(r, "marginal_risk_difference") - (m1 - m0)) < 1e-9 && abs(vcr_measure_value(r, "conditional_odds_ratio") - exp(b[2])) < 1e-9
  ok <- identical(r$status, "succeeded") && rel < 1e-6 && rel_cond < 1e-6 && all(abs(boot_ratio - 1) < 0.05) && est_ok && .n39_reg_ok(r)
  list(pass = ok,
       detail = sprintf("influence-function SE vs M-estimation (numerical Jacobians): RD %.5f/%.5f, log RR %.5f/%.5f, log OR %.5f/%.5f (max rel %.1e); conditional log OR %.5f vs sandwich::sandwich %.5f; sandwich/bootstrap SE ratio %.3f (RD) %.3f (log OR) over %d refits",
                        got[["rd"]], hand[["rd"]], got[["lrr"]], hand[["lrr"]], got[["lor"]], hand[["lor"]], rel, r$diagnostics$standardErrors$conditionalLogOddsRatio, cond_hand,
                        boot_ratio[1], boot_ratio[2], r$diagnostics$bootstrap$replicates))
})

vcr_case("N39c", c("AC-11", "AC-29", "AC-31"), function() {
  # Against the truth. 300 randomized trials (n = 300, logit P(Y) = -1 + 0.9 arm + 1.4 x, x ~ N(0, 1)) whose true marginal
  # contrasts are integrals over x computed with `integrate`. The standardised estimates are unbiased (the mean over trials is
  # within three Monte-Carlo errors of the truth), the reported standard errors are the sampling standard deviation (ratio within
  # 8%) and the 95% intervals cover at the nominal rate (92-98%); and the variance ratio the job reports for one trial is the
  # one the simulation shows: the adjusted estimator against the unadjusted difference of proportions, within 25%.
  truth <- .n39_binary_truth()
  R <- 300L
  sims <- lapply(seq_len(R), function(i) {
    d <- .n39_binary_dgp(300L, 3900L + i)
    f <- .vcr_pa_binary_fit(d$y, d$arm, cbind(z1 = d$x)); inf <- .vcr_pa_binary_if(f, d$y)
    e <- .vcr_pa_binary_effects(f)
    se <- c(rd = sqrt(sum((inf$c1 - inf$c0)^2)), lrr = sqrt(sum((inf$c1 / f$m1 - inf$c0 / f$m0)^2)),
            lor = sqrt(sum((inf$c1 / (f$m1 * (1 - f$m1)) - inf$c0 / (f$m0 * (1 - f$m0)))^2)))
    p1 <- mean(d$y[d$arm == 1L]); p0 <- mean(d$y[d$arm == 0L])
    c(rd = e[["rd"]], lrr = e[["log_rr"]], lor = e[["log_or"]], se_rd = se[["rd"]], se_lrr = se[["lrr"]], se_lor = se[["lor"]], unadj = p1 - p0)
  })
  m <- do.call(rbind, sims)
  want <- c(rd = truth[["rd"]], lrr = truth[["log_rr"]], lor = truth[["log_or"]])
  bias_z <- vapply(c("rd", "lrr", "lor"), function(k) (mean(m[, k]) - want[[k]]) / (stats::sd(m[, k]) / sqrt(R)), numeric(1))
  se_ratio <- vapply(c("rd", "lrr", "lor"), function(k) mean(m[, paste0("se_", k)]) / stats::sd(m[, k]), numeric(1))
  cover <- vapply(c("rd", "lrr", "lor"), function(k) mean(abs(m[, k] - want[[k]]) < stats::qnorm(0.975) * m[, paste0("se_", k)]), numeric(1))
  var_ratio_sim <- (stats::sd(m[, "rd"]) / stats::sd(m[, "unadj"]))^2
  # one trial through the job: its reported variance ratio is the simulation's, within 25%
  d1 <- .n39_binary_dgp(300L, 3900L + 1L); d1$USUBJID <- sprintf("C%04d", seq_len(nrow(d1)))
  r <- .n39_job(list(endpoint = list(type = "binary"), prognosticScoreColumn = "x", treatmentColumn = "arm", outcomeColumn = "y"),
                list(vcr_test_input(d1, "snp_n39c:subject", "subject")), seed = 6L)
  vr_job <- vcr_measure_value(r, "empirical_variance_ratio")
  ok <- all(abs(bias_z) < 3) && all(abs(se_ratio - 1) < 0.08) && all(cover > 0.92 & cover < 0.98) && abs(vr_job / var_ratio_sim - 1) < 0.25 && var_ratio_sim < 1
  list(pass = ok,
       detail = sprintf("truth RD %.4f / log RR %.4f / log OR %.4f; bias in Monte-Carlo errors %.2f / %.2f / %.2f; mean SE over sampling SD %.3f / %.3f / %.3f; coverage %.3f / %.3f / %.3f; variance ratio adjusted/unadjusted: simulation %.3f, one job %.3f",
                        want[["rd"]], want[["lrr"]], want[["lor"]], bias_z[1], bias_z[2], bias_z[3], se_ratio[1], se_ratio[2], se_ratio[3], cover[1], cover[2], cover[3], var_ratio_sim, vr_job))
})

.n39_tte <- function(n, seed, hr = 0.65, gamma = 0.8, lam = 0.08, followup = 24) {
  set.seed(seed, kind = VCR_RNG_KIND)
  x <- stats::rnorm(n); arm <- as.integer(rank(stats::runif(n), ties.method = "first") <= n / 2)
  t_event <- stats::rexp(n, lam * exp(gamma * x) * ifelse(arm == 1L, hr, 1))
  cens <- stats::runif(n, followup / 2, followup * 1.25)
  cens <- pmin(cens, followup)
  d <- data.frame(USUBJID = sprintf("T%05d", seq_len(n)), arm = arm, score = x, time = pmin(t_event, cens), status = as.integer(t_event <= cens))
  d
}
.n39_tte_inputs <- function(d, tag) list(vcr_test_input(d[, c("USUBJID", "arm", "score")], paste0("snp_n39_", tag, ":subject"), "subject"),
  vcr_test_input(data.frame(USUBJID = d$USUBJID, PARAMCD = "OS", AVAL = d$time, CNSR = 1L - d$status), paste0("snp_n39_", tag, ":event"), "event"))
.n39_tte_sc <- function(tau = 18) list(endpoint = list(type = "time_to_event"), prognosticScoreColumn = "score", treatmentColumn = "arm", tau = tau)

vcr_case("N39d", c("AC-11", "AC-29", "AC-12"), function() {
  # The time-to-event half against survival. (1) The engine's multi-covariate Cox maximum equals survival::coxph (Breslow ties) to
  # 1e-8, with ties and without, one to three covariates. (2) On a trial of 150, the job's standardised restricted mean survival
  # time of each arm and the survival at tau equal the average of survival::survfit(coxph, newdata) over everyone, integrated
  # exactly, to 1e-8; the conditional hazard ratio and its robust interval are coxph's.
  suppressMessages(library(survival))
  worst <- 0
  for (seed in 1:4) {
    set.seed(3900L + seed, kind = VCR_RNG_KIND)
    n <- 120L + 30L * seed
    X <- cbind(arm = stats::rbinom(n, 1L, 0.5), a = stats::rnorm(n), b = stats::rbinom(n, 1L, 0.4))[, seq_len(1L + min(seed, 2L)), drop = FALSE]
    t <- stats::rexp(n, 0.1 * exp(X %*% c(-0.4, 0.5, 0.3)[seq_len(ncol(X))])); cens <- stats::runif(n, 0, 25)
    time <- pmin(t, cens); status <- as.integer(t <= cens); if (seed %% 2L == 0L) time <- round(time, 1)
    df <- data.frame(time = time, status = status, X)
    f <- coxph(stats::as.formula(paste("Surv(time, status) ~", paste(colnames(X), collapse = " + "))), data = df, ties = "breslow")
    k <- vcr_cox_multi(time, status, X)
    worst <- max(worst, abs(k$beta - unname(coef(f))), abs(k$variance - unname(vcov(f))))
  }
  d <- .n39_tte(150L, 3910L)
  r <- .n39_job(.n39_tte_sc(18), .n39_tte_inputs(d, "d"), seed = 5L)
  f <- coxph(Surv(time, status) ~ arm + score, data = d, ties = "breslow", robust = TRUE)
  s1 <- survfit(f, newdata = data.frame(arm = 1, score = d$score)); s0 <- survfit(f, newdata = data.frame(arm = 0, score = d$score))
  rmst_of <- function(sf) { S <- rowMeans(sf$surv); k <- sf$time < 18; list(rmst = sum(diff(c(0, sf$time[k], 18)) * c(1, S[k])), at_tau = S[max(which(sf$time <= 18))]) }
  a1 <- rmst_of(s1); a0 <- rmst_of(s0)
  g <- function(name) vcr_measure_value(r, name)
  hr <- vcr_get_measure(r, "conditional_hazard_ratio")
  rob <- summary(f)$coefficients["arm", "robust se"]
  ok <- worst < 1e-8 && identical(r$status, "succeeded") && abs(g("rmst_treatment_standardised") - a1$rmst) < 1e-8 && abs(g("rmst_control_standardised") - a0$rmst) < 1e-8 &&
    abs(g("marginal_rmst_difference") - (a1$rmst - a0$rmst)) < 1e-8 && abs(g("survival_difference_at_tau") - (a1$at_tau - a0$at_tau)) < 1e-8 &&
    abs(hr$value - exp(coef(f)[["arm"]])) < 1e-8 && abs(hr$interval$low - exp(coef(f)[["arm"]] - stats::qnorm(0.975) * rob)) < 1e-8 &&
    r$diagnostics$bootstrap$replicates >= 2000L && .n39_reg_ok(r)
  list(pass = ok,
       detail = sprintf("Cox kernel vs coxph over 4 data sets (1-3 covariates, 2 tied): max |d| %.1e; standardised RMST %.6f / %.6f vs survfit(newdata) averaged %.6f / %.6f, difference %.6f; survival difference at tau %.6f vs %.6f; conditional HR %.5f, robust interval from coxph",
                        worst, g("rmst_treatment_standardised"), g("rmst_control_standardised"), a1$rmst, a0$rmst, g("marginal_rmst_difference"),
                        g("survival_difference_at_tau"), a1$at_tau - a0$at_tau, hr$value))
})

vcr_case("N39e", c("AC-11", "AC-29", "AC-31"), function() {
  # Against the truth, time to event. Exponential survival with a log-hazard of 0.8 per unit of the score and a hazard ratio of
  # 0.65; the true marginal RMST of an arm up to tau = 18 is E_x[(1 - exp(-lambda_a e^(0.8 x) tau)) / (lambda_a e^(0.8 x))], an integral over
  # x computed with `integrate`. 200 randomized trials of 300: the standardised RMST difference is unbiased (within three
  # Monte-Carlo errors) and a job's bootstrap standard error, averaged over three trials, is the sampling standard deviation to 20%;
  # the unadjusted RMST difference is also unbiased and the adjusted one is the more precise (the variance ratio is below 1).
  truth <- function(hr) {
    arm <- function(h) stats::integrate(function(x) { l <- 0.08 * h * exp(0.8 * x); -expm1(-l * 18) / l * stats::dnorm(x) }, -10, 10, rel.tol = 1e-12)$value
    arm(hr) - arm(1)
  }
  tr <- truth(0.65)
  R <- 200L
  sims <- vapply(seq_len(R), function(i) {
    d <- .n39_tte(300L, 3920L + i)
    e <- .vcr_pa_tte_effects(d$time, d$status, d$arm, cbind(z1 = d$score), 18)
    u <- vcr_rmst_difference(d$time, d$status, d$arm, 18)
    c(adj = e$rmst_diff, unadj = u$estimate)
  }, numeric(2))
  bias_z <- vapply(c("adj", "unadj"), function(k) (mean(sims[k, ]) - tr) / (stats::sd(sims[k, ]) / sqrt(R)), numeric(1))
  sd_adj <- stats::sd(sims["adj", ]); var_ratio_sim <- (sd_adj / stats::sd(sims["unadj", ]))^2
  jobs <- lapply(1:3, function(i) { d <- .n39_tte(300L, 3920L + i); .n39_job(.n39_tte_sc(18), .n39_tte_inputs(d, paste0("e", i)), seed = 10L + i) })
  se_job <- mean(vapply(jobs, function(r) r$diagnostics$bootstrap$standardErrors$rmstDifference, numeric(1)))
  vr_job <- mean(vapply(jobs, function(r) vcr_measure_value(r, "empirical_variance_ratio"), numeric(1)))
  ok <- all(abs(bias_z) < 3) && abs(se_job / sd_adj - 1) < 0.20 && var_ratio_sim < 1 && abs(vr_job / var_ratio_sim - 1) < 0.30 &&
    all(vapply(jobs, function(r) identical(r$status, "succeeded") && .n39_reg_ok(r), logical(1)))
  list(pass = ok,
       detail = sprintf("true marginal RMST difference %.4f; mean of %d trials: adjusted %.4f (%.2f Monte-Carlo errors), unadjusted %.4f (%.2f); sampling SD of the adjusted estimate %.4f vs the jobs' bootstrap SE %.4f (ratio %.3f); variance ratio simulation %.3f, jobs %.3f",
                        tr, R, mean(sims["adj", ]), bias_z[1], mean(sims["unadj", ]), bias_z[2], sd_adj, se_job, se_job / sd_adj, var_ratio_sim, vr_job))
})

vcr_case("N39f", c("AC-07", "AC-09", "AC-28"), function() {
  # Named refusals and named not-estimable rules, and the field about regulators on every one of them.
  d <- .n39_binary_dgp(200L, 3930L); d$USUBJID <- sprintf("R%04d", seq_len(nrow(d)))
  bsc <- list(endpoint = list(type = "binary"), prognosticScoreColumn = "x", treatmentColumn = "arm", outcomeColumn = "y")
  codes <- function(r) vcr_test_issue_codes(r)
  run <- function(sc, data, tag, seed = 1L) .n39_job(sc, list(vcr_test_input(data, paste0("snp_n39f_", tag, ":subject"), "subject")), seed = seed)
  # not estimable: a constant score, an outcome with one value
  const <- d; const$x <- 1
  r1 <- run(bsc, const, "a"); one <- d; one$y <- 0L; r2 <- run(bsc, one, "b")
  ok_ne <- identical(r1$status, "not_estimable") && identical(r1$notEstimableRule, "primary_analysis_not_estimable") && length(r1$measures) == 0L &&
    identical(r2$status, "not_estimable") && identical(r2$notEstimableRule, "primary_analysis_not_estimable") && .n39_reg_ok(r1) && .n39_reg_ok(r2)
  # perfect separation: the score decides the outcome
  sep <- d; sep$y <- as.integer(sep$x > 0); r3 <- run(bsc, sep, "c")
  ok_sep <- identical(r3$status, "not_estimable") && identical(r3$notEstimableRule, "primary_analysis_not_estimable") && .n39_reg_ok(r3)
  # refusals by name: a missing score value, a non-0/1 outcome, a column that is not there, a bad arm
  miss <- d; miss$x[3] <- NA; r4 <- run(bsc, miss, "d")
  cont <- d; cont$y <- stats::rnorm(nrow(d)); r5 <- run(bsc, cont, "e")
  r6 <- run(utils::modifyList(bsc, list(prognosticScoreColumn = "nope")), d, "f")
  bad_arm <- d; bad_arm$arm[1] <- 2L; r7 <- run(bsc, bad_arm, "g")
  refused <- function(r, code) identical(r$status, "failed") && code %in% codes(r) && length(r$measures) == 0L && .n39_reg_ok(r)
  ok_ref <- refused(r4, "missing_covariate") && refused(r5, "input_shape_invalid") && refused(r6, "input_shape_invalid") && refused(r7, "input_shape_invalid")
  # time to event: tau beyond follow-up, an arm without events
  td <- .n39_tte(200L, 3931L)
  r8 <- .n39_job(.n39_tte_sc(1000), .n39_tte_inputs(td, "h"))
  noev <- td; noev$status[noev$arm == 1L] <- 0L; r9 <- .n39_job(.n39_tte_sc(18), .n39_tte_inputs(noev, "i"))
  ok_tte <- identical(r8$status, "not_estimable") && identical(r8$notEstimableRule, "tau_beyond_followup") && .n39_reg_ok(r8) &&
    identical(r9$status, "not_estimable") && identical(r9$notEstimableRule, "primary_analysis_not_estimable") && .n39_reg_ok(r9)
  # a continuous endpoint is the EMA-qualified PROCOVA, sized by design.procova: refused by the protocol, by name
  r10 <- vcr_test_run(vcr_test_job("comparator.prognostic_adjustment", list(endpoint = list(type = "continuous"), prognosticScoreColumn = "x"),
                                   list(vcr_test_input(d, "snp_n39f_j:subject", "subject")), job_id = "job_n39f"))
  ok_cont <- identical(r10$status, "failed") && "endpoint_not_supported" %in% codes(r10)
  # a cancel keeps nothing it did not finish and still says what the adjustment is; the same seed gives the same result
  cf <- tempfile("cancel"); file.create(cf); on.exit(unlink(cf), add = TRUE)
  rc <- .n39_job(bsc, list(vcr_test_input(d, "snp_n39f_k:subject", "subject")), cancel_file = cf)
  ok_cancel <- identical(rc$status, "canceled") && length(rc$measures) == 0L && .n39_reg_ok(rc)
  ra <- run(bsc, d, "l", seed = 9L); rb <- run(bsc, d, "l", seed = 9L)
  ok_repro <- identical(ra$manifest$outputHash, rb$manifest$outputHash) && identical(ra$diagnostics$bootstrap, rb$diagnostics$bootstrap)
  list(pass = ok_ne && ok_sep && ok_ref && ok_tte && ok_cont && ok_cancel && ok_repro,
       detail = sprintf("constant score / one-valued outcome / separation -> %s/%s/%s; refusals by name: missing score %s, continuous outcome %s, absent column %s, bad arm %s; tau beyond follow-up -> %s, an arm without events -> %s; continuous endpoint refused %s; cancel -> %s; same seed same result %s; the regulatory field on all of them %s",
                        r1$notEstimableRule %||% "NULL", r2$notEstimableRule %||% "NULL", r3$notEstimableRule %||% "NULL", ok_ref, "ok", "ok", "ok",
                        r8$notEstimableRule %||% "NULL", r9$notEstimableRule %||% "NULL", ok_cont, rc$status, ok_repro, all(vapply(list(r1, r2, r3, r4, r5, r6, r7, r8, r9, rc), .n39_reg_ok, logical(1)))))
})
