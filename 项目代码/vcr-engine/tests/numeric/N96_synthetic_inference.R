# N96 — inference on synthetic data (algorithm round P1, 2026-11-03): population.synthpop / population.quality 1.1.0
#
#   a  the combining rules against synthpop's own summary of a fit to five copies, for simple and for proper synthesis
#   b  the false-positive rate of an uncorrected analysis, in closed form, against the engine's permuted-arm calibration on a generator whose
#      copies have a known law (simple synthesis): naive 2 (1 - pnorm(1.96 / sqrt 2)) = 0.166, combined 0.05
#   c  the same for a generator that redraws its parameters for every copy (proper synthesis) and five copies: the rule that matches the
#      generator holds the level, the other one does not
#   d  Cox, log-rank and restricted-mean analyses against survival and survRM2: the one-step identity of the log-rank test, the score test,
#      survRM2's estimate, error and p-value
#   e  the whole job: the declared analyses combined over the copies it wrote (the numbers recomputed from the saved table), the permuted-arm
#      calibration as simulated measures with their errors, a second run with the same hash, the 1.0.0 label refusing what is new
#   f  a CPU budget or a cancel keeps the replicates that finished; a table that is not a synthpop release cannot be calibrated and says so
#   g  a 1.0.0-labelled job replays byte for byte what the previous release answered
#
# The generator of b and c is a linear model fitted to the (permuted) table and sampled from, which is the case Raab, Nowok & Dibben's rule is
# exact for; the engine's own synthpop CART generator is measured, not asserted, in e.

.n96_table <- function(n, seed) {
  set.seed(seed, kind = VCR_RNG_KIND)
  x1 <- stats::rnorm(n, 60, 10); x2 <- stats::rbinom(n, 1L, 0.5)
  data.frame(x1 = x1, x2 = x2, y = 0.05 * x1 + 0.5 * x2 + stats::rnorm(n))
}

# fit y ~ x on a table, sample m copies of the same size; `proper` redraws (beta, sigma) from their posterior for every copy
.n96_linear_generator <- function(m, proper = FALSE) function(tbl, seed) {
  n <- nrow(tbl)
  fit <- stats::lm(y ~ x, data = tbl); b <- stats::coef(fit); V <- stats::vcov(fit); s2 <- sum(stats::resid(fit)^2) / fit$df.residual
  lapply(seq_len(m), function(k) {
    s2k <- if (proper) fit$df.residual * s2 / stats::rchisq(1L, fit$df.residual) else s2
    bk <- if (proper) as.numeric(b + t(chol(V * s2k / s2)) %*% stats::rnorm(2L)) else as.numeric(b)
    x <- stats::rnorm(n, mean(tbl$x), stats::sd(tbl$x))
    data.frame(x = x, y = bk[1] + bk[2] * x + stats::rnorm(n, 0, sqrt(s2k)))
  })
}

vcr_case("N96a", c("AC-04"), function() {
  # synthpop's own summary of a fit to m copies (population.inference = TRUE) is the reference. The same five copies go to both: the engine's
  # analysis is run on each, the estimates and variances are combined by vcr_combine_synthetic.
  d <- .n96_table(300L, 9601L)
  f <- vcr_analysis_from_spec(list(kind = "glm", outcome = "y", predictors = list("x1", "x2"), target = "x2", family = "gaussian"))
  worst <- numeric(0); lines <- character(0)
  for (proper in c(FALSE, TRUE)) {
    sds <- suppressMessages(synthpop::syn(d, m = 5, seed = 9602L + proper, proper = proper, print.flag = FALSE))
    ref <- summary(synthpop::lm.synds(y ~ x1 + x2, data = sds), population.inference = TRUE)$coefficients["x2", ]
    mine <- vcr_synthetic_inference(f, f(d), sds$syn, nrow(d), proper)
    worst <- c(worst, abs(mine$estimate - ref[["Beta.syn"]]), abs(mine$se - ref[["se.Beta.syn"]]), abs(mine$pValue - ref[["Pr(>|z.syn|)"]]))
    lines <- c(lines, sprintf("%s synthesis: estimate %.6f / %.6f, standard error %.6f / %.6f, p %.6f / %.6f", if (proper) "proper" else "simple",
                              mine$estimate, ref[["Beta.syn"]], mine$se, ref[["se.Beta.syn"]], mine$pValue, ref[["Pr(>|z.syn|)"]]))
  }
  # the rule written out: (k/n) ubar (1 + n/(k m)); with k = n it is ubar (1 + 1/m)
  est <- c(1.0, 1.2, 0.8, 1.1, 0.9); u <- c(0.04, 0.05, 0.03, 0.06, 0.02)
  hand <- vcr_combine_synthetic(est, u, 200L, 200L, FALSE)
  hand_k <- vcr_combine_synthetic(est, u, 200L, 400L, TRUE)
  list(pass = max(worst) < 1e-9 && abs(hand$variance - mean(u) * (1 + 1 / 5)) < 1e-15 && abs(hand$estimate - 1) < 1e-15 &&
         abs(hand_k$variance - (400 / 200) * mean(u) * (1 + (200 / 400 + 1) / 5)) < 1e-15,
       detail = sprintf("five copies of a 300-row table, the coefficient of x2: %s; largest difference %.1e; the rule by hand for n = 200, k = 200 gives ubar (1 + 1/m) = %.5f, and for k = 400 under proper synthesis %.5f",
                        paste(lines, collapse = "; "), max(worst), hand$variance, hand_k$variance))
})

vcr_case("N96b", c("AC-04", "AC-30"), function() {
  # an analysis run on a synthetic copy as if it were the data: the copy's estimate has the generator's sampling error on top of its own, so the
  # variance is twice what the analysis reports (k = n, one copy), and a test at 5% rejects 2 (1 - pnorm(1.96 / sqrt 2)) = 16.6% of the time. The
  # combining rule puts the variance back and the level is 5%. n = 200, 3,000 permuted tables; the engine's own loop and its own errors.
  n <- 200L; R <- 3000L
  d <- data.frame(x = stats::rnorm(n), y = stats::rnorm(n))
  f <- vcr_analysis_from_spec(list(kind = "glm", outcome = "y", predictors = list("x"), target = "x", family = "gaussian"))
  nc <- vcr_null_calibration(d, f, "x", .n96_linear_generator(1L), R, 9611L)
  closed <- 2 * (1 - stats::pnorm(stats::qnorm(0.975) / sqrt(2)))
  within <- function(r, want, extra) abs(r$value - want) <= 3.5 * r$mcse + extra
  list(pass = isTRUE(nc$available) && nc$replicates == R && within(nc$realPermuted, 0.05, 0.006) && within(nc$syntheticNaive, closed, 0.006) &&
         within(nc$syntheticCombined, 0.05, 0.006) && abs(nc$standardErrorRatio - sqrt(2)) < 0.03 &&
         abs(nc$realPermuted$mcse - sqrt(nc$realPermuted$value * (1 - nc$realPermuted$value) / R)) < 1e-15,
       detail = sprintf("%d permuted tables of 200, one copy each from a fitted linear model: false positives on the permuted real table %.4f (MCSE %.4f, nominal 0.05), on the copy read as data %.4f (MCSE %.4f, closed form 2 (1 - pnorm(1.96 / sqrt 2)) = %.4f), on the copy with the combining rule %.4f (MCSE %.4f); the combined error is %.3f times the naive one (sqrt 2 = 1.414)",
                        nc$replicates, nc$realPermuted$value, nc$realPermuted$mcse, nc$syntheticNaive$value, nc$syntheticNaive$mcse, closed,
                        nc$syntheticCombined$value, nc$syntheticCombined$mcse, nc$standardErrorRatio))
})

vcr_case("N96c", c("AC-04", "AC-30"), function() {
  # a generator that redraws its parameters for every copy needs the proper rule: with five copies the variance is ubar (1 + 2/5) and not
  # ubar (1 + 1/5), so the simple rule rejects P(|Z| > 1.96 / sqrt(1.4 / 1.2)) = 7.0% of true nulls and the proper rule 5%.
  n <- 200L; R <- 2000L
  d <- data.frame(x = stats::rnorm(n), y = stats::rnorm(n))
  f <- vcr_analysis_from_spec(list(kind = "glm", outcome = "y", predictors = list("x"), target = "x", family = "gaussian"))
  gen <- .n96_linear_generator(5L, proper = TRUE)
  ok_proper <- vcr_null_calibration(d, f, "x", gen, R, 9621L, proper = TRUE)
  ok_simple <- vcr_null_calibration(d, f, "x", gen, R, 9621L, proper = FALSE)
  closed_simple <- 2 * (1 - stats::pnorm(stats::qnorm(0.975) / sqrt(1.4 / 1.2)))
  list(pass = abs(ok_proper$syntheticCombined$value - 0.05) <= 3.5 * ok_proper$syntheticCombined$mcse + 0.006 &&
         abs(ok_simple$syntheticCombined$value - closed_simple) <= 3.5 * ok_simple$syntheticCombined$mcse + 0.006 &&
         ok_simple$syntheticCombined$value > ok_proper$syntheticCombined$value + 0.01,
       detail = sprintf("five copies per table, parameters redrawn for every copy, %d permuted tables of 200: the proper rule rejects %.4f (MCSE %.4f; nominal 0.05), the simple rule %.4f (MCSE %.4f; closed form %.4f)",
                        R, ok_proper$syntheticCombined$value, ok_proper$syntheticCombined$mcse, ok_simple$syntheticCombined$value, ok_simple$syntheticCombined$mcse, closed_simple))
})

vcr_case("N96d", c("AC-04"), function() {
  # the three survival analyses against references that share no code with them
  set.seed(9631L, kind = VCR_RNG_KIND)
  n <- 240L
  d <- data.frame(arm = rep(c("a", "b"), each = n / 2), age = stats::rnorm(n, 60, 10))
  d$time <- stats::rexp(n, 0.08 * exp(0.015 * (d$age - 60) + 0.3 * (d$arm == "b"))); d$cens <- stats::rexp(n, 0.04)
  d$status <- as.numeric(d$time <= d$cens); d$time <- pmin(d$time, d$cens)
  lr <- vcr_analysis_from_spec(list(kind = "logrank", time = "time", status = "status", group = "arm"))(d)
  # the log-rank test is the score test of a Cox model without ties, and its Peto estimate (O - E) / V is the first Newton step from 0
  one <- survival::coxph(survival::Surv(time, status) ~ I(arm == "b"), data = d, init = 0, control = survival::coxph.control(iter.max = 1))
  full <- survival::coxph(survival::Surv(time, status) ~ I(arm == "b"), data = d)
  score_p <- stats::pchisq(summary(full)$sctest[["test"]], 1, lower.tail = FALSE)
  cx <- vcr_analysis_from_spec(list(kind = "cox", time = "time", status = "status", predictors = list("arm", "age"), target = "arm"))(d)
  cx_ref <- summary(survival::coxph(survival::Surv(time, status) ~ arm + age, data = d))$coefficients["armb", ]
  rm <- vcr_analysis_from_spec(list(kind = "rmst", time = "time", status = "status", group = "arm", tau = 15))(d)
  rm_ref <- survRM2::rmst2(d$time, d$status, as.numeric(d$arm == "b"), tau = 15)$unadjusted.result[1, ]
  late <- vcr_analysis_from_spec(list(kind = "rmst", time = "time", status = "status", group = "arm", tau = 1e6))(d)
  one_arm <- vcr_analysis_from_spec(list(kind = "logrank", time = "time", status = "status", group = "arm"))(d[d$arm == "a", ])
  list(pass = abs(lr$estimate - unname(stats::coef(one))) < 1e-8 && abs(lr$pValue - score_p) < 1e-9 && abs((lr$estimate / lr$se)^2 - summary(full)$sctest[["test"]]) < 1e-8 &&
         abs(lr$estimate - unname(stats::coef(full))) < 0.05 &&
         abs(cx$estimate - cx_ref[["coef"]]) < 1e-12 && abs(cx$se - cx_ref[["se(coef)"]]) < 1e-12 &&
         abs(rm$estimate - rm_ref[["Est."]]) < 1e-9 && abs(rm$pValue - rm_ref[["p"]]) < 1e-9 && abs(rm$interval[1] - rm_ref[["lower .95"]]) < 1e-3 &&
         identical(late$reason, "tau_beyond_followup") && is.na(late$estimate) && identical(one_arm$reason, "group_not_two_levels"),
       detail = sprintf("240 people, two arms: log-rank Peto estimate %.6f against the first Newton step of coxph from 0 (%.6f) and the full Cox estimate %.4f; p %.6f against the Cox score test %.6f; Cox log hazard ratio %.6f against survival %.6f (standard error %.6f / %.6f); restricted mean difference to 15: %.6f against survRM2 %.6f (p %.6f / %.6f); a horizon past the follow-up -> %s; one arm -> %s",
                        lr$estimate, unname(stats::coef(one)), unname(stats::coef(full)), lr$pValue, score_p, cx$estimate, cx_ref[["coef"]], cx$se, cx_ref[["se(coef)"]],
                        rm$estimate, rm_ref[["Est."]], rm$pValue, rm_ref[["p"]], late$reason, one_arm$reason))
})

# a survival table with an arm whose effect is null, for the job-level cases
.n96_survival_file <- function(n, seed, effect = 0) {
  set.seed(seed, kind = VCR_RNG_KIND)
  age <- round(stats::rnorm(n, 60, 10)); arm <- stats::rbinom(n, 1L, 0.5); sex <- sample(c("f", "m"), n, TRUE)
  t0 <- stats::rexp(n, 0.06 * exp(0.02 * (age - 60) + effect * arm)); cens <- stats::runif(n, 5, 30)
  data.frame(USUBJID = sprintf("S%04d", seq_len(n)), arm = arm, age = age, sex = sex, os = round(pmin(t0, cens), 3), death = as.numeric(t0 <= cens))
}

vcr_case("N96e", c("AC-04", "AC-30", "AC-31"), function() {
  tbl <- .n96_survival_file(260L, 9641L)
  in_file <- vcr_test_input(tbl, "snp_n96e:subject", shape = "subject", source = "observed")
  an <- list(list(name = "hr", kind = "cox", time = "os", status = "death", predictors = list("arm", "age"), target = "arm"),
             list(name = "logrank", kind = "logrank", time = "os", status = "death", group = "arm"),
             list(name = "rmst", kind = "rmst", time = "os", status = "death", group = "arm", tau = 12),
             list(name = "mean age", kind = "mean", column = "age"))
  sc <- list(holdoutShare = 0.25, m = 5L, analyses = an,
             inference = list(nullCalibration = list(analysis = "hr", replicates = 40L, copies = 1L)),
             privacy = list(membershipRiskBound = 0.75, secrets = list("sex"), attacks = 100L))
  dir1 <- tempfile("n96e"); dir.create(dir1)
  t0 <- Sys.time(); r1 <- vcr_test_run(vcr_test_job("population.synthpop", sc, list(in_file), seed = 96L), output_dir = dir1); secs <- as.numeric(difftime(Sys.time(), t0, units = "secs"))
  dir2 <- tempfile("n96e2"); dir.create(dir2)
  r2 <- vcr_test_run(vcr_test_job("population.synthpop", sc, list(in_file), seed = 96L), output_dir = dir2)
  q <- r1$diagnostics$quality; sp <- q$utility$specific
  # the copies the job wrote, read back from its own table; the training rows are the ones it did not hold out, found by the copies' size
  syn <- vcr_test_table(r1, "synthetic-population", dir1)
  copies <- split(syn[setdiff(names(syn), "copy")], syn$copy)
  n_train <- nrow(copies[[1L]])
  by_hand <- function(est, se) { m <- length(est); k <- n_train; n <- n_train; list(estimate = mean(est), se = sqrt(mean(se^2) * (k / n) * (1 + n / (k * m)))) }
  fits <- lapply(copies, function(cp) summary(survival::coxph(survival::Surv(os, death) ~ arm + age, data = cp))$coefficients["arm", ])
  h <- by_hand(vapply(fits, function(x) x[["coef"]], numeric(1)), vapply(fits, function(x) x[["se(coef)"]], numeric(1)))
  nm <- vapply(r1$measures, function(m) m$name, character(1))
  want <- c("false_positive_rate_real_permuted", "false_positive_rate_synthetic_naive", "false_positive_rate_synthetic_combined")
  rates <- Filter(function(m) m$name %in% want, r1$measures)
  mean_row <- sp[["mean age"]]$combined
  old <- vcr_test_run(vcr_test_job("population.synthpop", list(holdoutShare = 0.25, m = 5L), list(in_file), seed = 96L, extra = list(methodVersion = "1.0.0")))
  with_new_under_old <- vcr_test_run(vcr_test_job("population.synthpop", list(holdoutShare = 0.25, m = 5L, privacy = list(attacks = 100L)), list(in_file), seed = 96L, extra = list(methodVersion = "1.0.0")))
  unlink(c(dir1, dir2), recursive = TRUE)
  list(pass = identical(r1$status, "succeeded") && identical(vcr_output_hash(r1), vcr_output_hash(r2)) &&
         abs(sp$hr$combined$estimate - h$estimate) < 1e-9 && abs(sp$hr$combined$se - h$se) < 1e-9 && sp$hr$combined$copies == 5L &&
         all(want %in% nm) && length(rates) == 3L && all(vapply(rates, function(m) isTRUE(m$simulated) && is.finite(m$mcse) && m$value >= 0 && m$value <= 1, logical(1))) &&
         q$inference$nullCalibration$replicates == 40L && q$inference$rule == "simple_synthesis" && is.finite(sp$logrank$combined$pValue) && is.finite(sp$rmst$combined$estimate) &&
         abs(mean_row$estimate - mean(vapply(copies, function(cp) mean(cp$age), numeric(1)))) < 1e-9 &&
         identical(old$status, "succeeded") && is.null(old$diagnostics$quality$inference) && is.null(old$diagnostics$quality$disclosure$perRecord) &&
         identical(with_new_under_old$status, "failed") && "method_version_mismatch" %in% vcr_test_issue_codes(with_new_under_old),
       detail = sprintf("a 260-person survival table, five copies, a Cox hazard ratio, a log-rank test, a restricted mean and a mean: the combined Cox estimate %.6f and standard error %.6f against the five copies' own coxph fits combined by hand (%.6f, %.6f); the permuted-arm calibration over 40 tables: real %.3f (MCSE %.3f), naive %.3f (%.3f), combined %.3f (%.3f), the combined error %.2f times the naive one; the same job twice has the same output hash; a 1.0.0 label answers without the new blocks and refuses a new key; %.0f s",
                        sp$hr$combined$estimate, sp$hr$combined$se, h$estimate, h$se,
                        q$inference$nullCalibration$realPermuted$value, q$inference$nullCalibration$realPermuted$mcse, q$inference$nullCalibration$syntheticNaive$value, q$inference$nullCalibration$syntheticNaive$mcse,
                        q$inference$nullCalibration$syntheticCombined$value, q$inference$nullCalibration$syntheticCombined$mcse, q$inference$nullCalibration$standardErrorRatio, secs))
})

vcr_case("N96f", c("AC-04", "AC-30"), function() {
  # a cancel after the fifth permuted table keeps the five that finished (the rates are theirs); a generator the engine cannot re-run is named
  tbl <- .n96_survival_file(120L, 9651L)
  f <- vcr_analysis_from_spec(list(kind = "logrank", time = "os", status = "death", group = "arm"))
  cf <- tempfile("cancel"); calls <- 0L
  regen <- function(t, s) { calls <<- calls + 1L; out <- vcr_population_synthpop(t, m = 1L, seed = s)$data; if (calls >= 5L) file.create(cf); out }
  old_ctx <- .vcr_ctx$cancel_file; .vcr_ctx$cancel_file <- cf
  nc <- tryCatch(vcr_null_calibration(tbl[setdiff(names(tbl), "USUBJID")], f, "arm", regen, 30L, 9652L), finally = { .vcr_ctx$cancel_file <- old_ctx; unlink(cf) })
  # through population.quality: a table from some other tool is not a synthpop release
  in_tr <- vcr_test_input(tbl, "tr_n96f@1", source = "observed"); in_sy <- vcr_test_input(.n96_survival_file(120L, 9653L), "sy_n96f@1", source = "synthetic", kind = "snapshot_file")
  sc <- list(trainingInputId = "tr_n96f@1", syntheticInputId = "sy_n96f@1", analyses = list(list(name = "lr", kind = "logrank", time = "os", status = "death", group = "arm")),
             inference = list(nullCalibration = list(analysis = "lr", replicates = 20L)), generator = list(family = "other_tool"))
  r <- vcr_test_run(vcr_test_job("population.quality", sc, list(in_tr, in_sy), seed = 9654L))
  mean_only <- vcr_test_run(vcr_test_job("population.synthpop", list(holdoutShare = 0.2, m = 5L, analyses = list(list(name = "m", kind = "mean", column = "age")),
    inference = list(nullCalibration = list(analysis = "m"))), list(vcr_test_input(tbl, "snp_n96f:subject", shape = "subject", source = "observed")), seed = 9655L))
  bad_name <- vcr_test_run(vcr_test_job("population.synthpop", list(holdoutShare = 0.2, m = 5L, analyses = list(list(name = "m", kind = "mean", column = "age")),
    inference = list(nullCalibration = list(analysis = "nope"))), list(vcr_test_input(tbl, "snp_n96f:subject", shape = "subject", source = "observed")), seed = 9655L))
  list(pass = isTRUE(nc$available) && nc$replicates == 5L && identical(nc$stopped, "canceled") && nc$replicatesPlanned == 30L &&
         identical(r$status, "succeeded") && identical(r$diagnostics$quality$inference$nullCalibration$reason, "generator_not_rerunnable") &&
         identical(mean_only$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(mean_only) &&
         identical(bad_name$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(bad_name),
       detail = sprintf("a cancel written during the fifth of 30 permuted tables: %d finished and kept, stopped by '%s', the rates are theirs (real %.2f, naive %.2f, combined %.2f); a quality job whose generator is another tool's returns its report with the calibration named '%s'; a calibration on a mean (no arm) and on a name that is not declared are refused by name",
                        nc$replicates, nc$stopped, nc$realPermuted$value, nc$syntheticNaive$value, nc$syntheticCombined$value, r$diagnostics$quality$inference$nullCalibration$reason))
})

vcr_case("N96g", c("AC-04", "AC-31"), function() {
  # replay: a job labelled 1.0.0 answers bit for bit what the previous release answered. The two hashes were recorded from the release before
  # this one (population.synthpop and population.quality, the output hash over the numbers and the tables written), run on the same inputs.
  mk <- function(n) { set.seed(n, kind = VCR_RNG_KIND); x1 <- stats::rnorm(n, 60, 10); x2 <- stats::rbinom(n, 1L, 0.5); g <- sample(c("a", "b", "c"), n, TRUE, c(0.5, 0.3, 0.2))
    data.frame(x1 = x1, x2 = x2, g = g, y = stats::rbinom(n, 1, stats::plogis(-3 + 0.05 * x1 + 1.2 * x2))) }
  tbl <- mk(180L); tbl <- cbind(USUBJID = sprintf("S%04d", seq_len(nrow(tbl))), tbl)
  in_file <- vcr_test_input(tbl, "snp_n96g:subject", shape = "subject", source = "observed")
  an <- list(list(name = "mean x1", kind = "mean", column = "x1"), list(name = "glm", kind = "glm", outcome = "y", predictors = list("x1", "x2"), target = "x2", family = "binomial"))
  run <- function(m, sc, inputs, seed) { d <- tempfile("n96g"); dir.create(d); on.exit(unlink(d, recursive = TRUE))
    vcr_output_hash(vcr_test_run(vcr_test_job(m, sc, inputs, seed = seed, extra = list(methodVersion = "1.0.0")), output_dir = d)) }
  h_syn <- run("population.synthpop", list(holdoutShare = 0.2, m = 5L, analyses = an), list(in_file), 961L)
  in_tr <- vcr_test_input(mk(200L), "tr_n96g@1", source = "observed"); in_ho <- vcr_test_input(mk(120L), "ho_n96g@1", source = "observed")
  in_sy <- vcr_test_input(mk(201L), "sy_n96g@1", source = "synthetic", kind = "snapshot_file")
  h_q <- run("population.quality", list(trainingInputId = "tr_n96g@1", syntheticInputId = "sy_n96g@1", holdoutInputId = "ho_n96g@1", analyses = an), list(in_tr, in_ho, in_sy), 962L)
  want_syn <- "5ba6c6cefec2d3d215748c4922dba1d9f1e0f87268b866acff927382577a4ef2"; want_q <- "633f446380c1afd3a1b98f6e929f3914eb7d8637b2519ec268d75c64afe95e93"
  list(pass = identical(h_syn, want_syn) && identical(h_q, want_q),
       detail = sprintf("1.0.0-labelled jobs on a 180-row table (synthesis, five copies, a mean and a glm analysis) and on a 200 / 201 / 120-row quality report: output hashes %s and %s, the ones the previous release recorded",
                        substr(h_syn, 1, 12), substr(h_q, 1, 12)))
})

vcr_case("N96h", c("AC-04", "AC-30", "AC-31"), function() {
  # Review stats2 findings 8, 9, 12 and 22: a table with a missing cell, an analysis with no answer on a permuted table, a cancel during the calibration, and a
  # smoother that cannot choose a bandwidth.
  # (8) Gower's rule for a missing value, against a hand computation: the distance of two records is the mean over the columns both have. A synthesis with a holdout
  #     and 5% of ages missing, and a quality report whose synthetic, training and holdout tables each have a missing cell, used to fail with 'missing values and
  #     NaN's not allowed if na.rm is FALSE'.
  a <- data.frame(p = c(1, 2, NA), q = c("u", "v", "u"), r = c(0.5, NA, 0.1), stringsAsFactors = FALSE)
  ref <- data.frame(p = c(1, 4), q = c("u", "u"), r = c(0.9, 0.1), stringsAsFactors = FALSE)
  g <- vcr_gower_nearest(a, ref, ranges = list(p = 4, r = 1), k = 2L)
  hand <- rbind(c((0 + 0 + 0.4) / 3, (3 / 4 + 0 + 0.4) / 3), c((1 / 4 + 1 + 0) / 2, (2 / 4 + 1 + 0) / 2), c((0 + 0.8 / 1) / 2, (0 + 0) / 2))
  hand_nearest <- apply(hand, 1L, min)
  gower_ok <- max(abs(g$dcr - hand_nearest)) < 1e-12
  tbl <- .n96_survival_file(200L, 9661L); tbl$age[c(3, 17, 40, 61, 88, 120, 150, 171, 188, 199)] <- NA
  in_file <- vcr_test_input(tbl, "snp_n96h:subject", shape = "subject", source = "observed")
  miss <- vcr_test_run(vcr_test_job("population.synthpop", list(holdoutShare = 0.25, m = 5L), list(in_file), seed = 96L))
  tr <- .n96_survival_file(150L, 9662L); ho <- .n96_survival_file(60L, 9663L); sy <- .n96_survival_file(150L, 9664L)
  sy$age[c(2, 9)] <- NA; tr$age[c(5, 6, 30)] <- NA; ho$sex[4] <- NA; ho$age[10] <- NA
  q_ok <- identical(vcr_test_run(vcr_test_job("population.quality", list(trainingInputId = "tr@1", syntheticInputId = "sy@1", holdoutInputId = "ho@1"),
    list(vcr_test_input(tr, "tr@1", source = "observed"), vcr_test_input(sy, "sy@1", source = "synthetic", kind = "snapshot_file"), vcr_test_input(ho, "ho@1", source = "observed")), seed = 9665L))$status, "succeeded")
  # (9) rmst with a tau a permuted arm's follow-up may not reach
  set.seed(9666L, kind = VCR_RNG_KIND)
  n <- 300L; arm <- stats::rbinom(n, 1L, 0.5); t0 <- stats::rexp(n, 0.05); cens <- stats::runif(n, 5, 20)
  d <- data.frame(arm = arm, os = pmin(t0, cens), death = as.numeric(t0 <= cens)); d$os[1:3] <- c(29.7, 29.1, 28.6); d$death[1:3] <- 0
  f_base <- vcr_analysis_from_spec(list(kind = "logrank", time = "os", status = "death", group = "arm"))
  # the analysis answers `none` (an NA estimate) on a table whose first three arms are all 1 (one in eight): a permuted real table that has no answer
  # where its copies do, which is what a restricted mean's tau beyond one arm's follow-up produces (the job below runs that one itself)
  f <- function(t) if (sum(t$arm[1:3]) == 3L) list(estimate = NA_real_, se = NA_real_, interval = c(NA_real_, NA_real_), pValue = NA_real_) else f_base(t)
  regen <- function(t, s) vcr_population_synthpop(t, m = 1L, seed = s)$data
  nc <- vcr_null_calibration(d, f, "arm", regen, 40L, 9667L)
  rates_ok <- isTRUE(nc$available) && nc$failedReplicates > 0L && nc$replicates + nc$failedReplicates == 40L && all(is.finite(c(nc$realPermuted$value, nc$syntheticNaive$value, nc$syntheticCombined$value)))
  job_nc <- vcr_test_run(vcr_test_job("population.synthpop", list(holdoutShare = 0, m = 5L, analyses = list(list(name = "r", kind = "rmst", time = "os", status = "death", group = "arm", tau = 28)),
    inference = list(nullCalibration = list(analysis = "r", replicates = 20L))), list(vcr_test_input(cbind(USUBJID = sprintf("S%04d", seq_len(n)), d), "snp_n96h2:subject", shape = "subject", source = "observed")), seed = 9668L))
  job_ok <- identical(job_nc$status, "succeeded") && !is.null(vcr_get_measure(job_nc, "false_positive_rate_real_permuted"))
  # (12) a cancel written during the calibration is a cancel, not a success
  cf <- tempfile("cancel"); calls <- 0L; orig <- vcr_population_synthpop
  vcr_population_synthpop <<- function(...) { calls <<- calls + 1L; out <- orig(...); if (calls >= 7L) file.create(cf); out }
  on.exit({ vcr_population_synthpop <<- orig; unlink(cf) }, add = TRUE)
  cj <- vcr_test_job("population.synthpop", list(holdoutShare = 0, m = 5L, analyses = list(list(name = "r", kind = "logrank", time = "os", status = "death", group = "arm")),
    inference = list(nullCalibration = list(analysis = "r", replicates = 40L))), list(vcr_test_input(cbind(USUBJID = sprintf("S%04d", seq_len(n)), d), "snp_n96h3:subject", shape = "subject", source = "observed")), seed = 9669L)
  canceled <- vcr_run_job(vcr_test_json(cj), cancel_file = cf)
  vcr_population_synthpop <<- orig
  cancel_ok <- identical(canceled$status, "canceled") && !identical(canceled$conclusion, "estimable")
  # (22) a smoother with fewer than two points: the copy is made without smoothing and named
  stand_in <- function(data, ...) { a <- list(...); if (!is.null(a$smoothing)) stop("need at least 2 points to select a bandwidth automatically"); synthpop::syn(data = data, ...) }
  ns <- asNamespace("synthpop"); unlockBinding("syn", ns); real_syn <- synthpop::syn
  on.exit({ assign("syn", real_syn, envir = ns); lockBinding("syn", ns) }, add = TRUE)
  assign("syn", function(data, ...) { a <- list(...); if (!is.null(a$smoothing) && length(a$smoothing)) stop("need at least 2 points to select a bandwidth automatically"); real_syn(data = data, ...) }, envir = ns)
  smooth <- vcr_test_run(vcr_test_job("population.synthpop", list(holdoutShare = 0, m = 5L), list(vcr_test_input(.n96_survival_file(120L, 9670L), "snp_n96h4:subject", shape = "subject", source = "observed")), seed = 9670L))
  assign("syn", real_syn, envir = ns)
  smooth_ok <- identical(smooth$status, "succeeded") && identical(unlist(smooth$diagnostics$smoothingNotApplied), 1:5)
  list(pass = gower_ok && identical(miss$status, "succeeded") && q_ok && rates_ok && job_ok && cancel_ok && smooth_ok,
       detail = sprintf("Gower's distance with a missing cell equals the hand computation over the columns both records have (%s); a synthesis with a holdout and 10 of 200 ages missing: %s; a quality report with missing cells in the synthetic, training and holdout tables: %s; an analysis with no answer on some permuted tables: %d of 40 replicates dropped and counted, the rates are %.3f, %.3f, %.3f, and the restricted-mean job with tau 28 %s; a cancel during the calibration is status '%s'; a smoother that fails: the five copies are made unsmoothed and named (%s)",
                        gower_ok, miss$status, q_ok, nc$failedReplicates, nc$realPermuted$value, nc$syntheticNaive$value, nc$syntheticCombined$value, job_nc$status, canceled$status, smooth_ok))
})
