# N98 — a prognostic model trained on the user's own table, cross-fitted (algorithm round P3, 2026-11-03): model.prognostic_train
#
#   a  Cox: the saved equation against coxph on every row, the pooled out-of-fold C index recomputed by hand on the job's own folds, a known-truth
#      simulation (the correct model: C near the population C, calibration slope near 1), and noise predictors that an in-sample fit would call
#      good (in-sample C 0.8, out of fold 0.5)
#   b  a continuous outcome against its closed form: R squared = b'b / (b'b + sigma^2), rho = sqrt of it, the out-of-fold figures recomputed by hand
#      on the job's folds, the saved equation reproduced by lm
#   c  the savings table is design.procova's formula: a closed form (1 - (lambda rho)^2)(1 + gamma^2) / 2 and a design.procova job on the same numbers
#   d  a binary outcome: DeLong's variance against the double loop over every pair, calibration of the right model, the equation applied
#      by model.prognostic_apply reproduces the saved model's probabilities (the model document is one apply can use)
#   e  what is refused and what is not shown: too few events, a separating model, a level held by four people (not named, its people excluded and
#      counted), a horizon past the data (a score and no baseline)
#   f  the forest is a comparison only, the job is deterministic, the cancel keeps nothing half-built

.n98_cox_data <- function(n, seed, beta = c(0.6, -0.4, 0, 0.3), noise = 0, base = 0.08, cens = 0.03) {
  set.seed(seed, kind = VCR_RNG_KIND)
  p <- length(beta); X <- matrix(stats::rnorm(n * p), n, p); colnames(X) <- paste0("x", seq_len(p))
  if (noise > 0) { Z <- matrix(stats::rnorm(n * noise), n, noise); colnames(Z) <- sprintf("z%02d", seq_len(noise)); X <- cbind(X, Z); beta <- c(beta, rep(0, noise)) }
  lp <- as.numeric(X %*% beta); t0 <- stats::rexp(n, base * exp(lp)); c0 <- stats::rexp(n, cens)
  d <- data.frame(USUBJID = sprintf("S%05d", seq_len(n)), X, os = round(pmin(t0, c0), 4), death = as.numeric(t0 <= c0))
  attr(d, "lp") <- lp; d
}

.n98_scenario <- function(type, id, predictors, extra = list(), horizon = 24) {
  ep <- switch(type, time_to_event = list(type = "time_to_event", timeColumn = "os", statusColumn = "death", horizon = horizon, timeUnit = "months"),
               binary = list(type = "binary", outcomeColumn = "y", horizon = horizon, timeUnit = "months"),
               continuous = list(type = "continuous", outcomeColumn = "y", horizon = horizon, timeUnit = "months"))
  utils::modifyList(list(inputId = id, idColumn = "USUBJID", sourceCondition = "control", endpoint = ep,
                         predictors = lapply(predictors, function(c) list(column = c, unit = "score")), folds = 5L, comparison = list(ranger = FALSE)), extra)
}
.n98_run <- function(sc, df, id, seed = 9801L, dir = NULL) {
  inp <- vcr_test_input(df, id, shape = "subject", source = "observed")
  vcr_test_run(vcr_test_job("model.prognostic_train", sc, list(inp), seed = seed), output_dir = dir)
}
.n98_m <- function(r, name) vcr_measure_value(r, name)
# the job's own folds, rebuilt: the stream of the seed, then the dealing of events and non-events round the folds
.n98_folds <- function(seed, strata, k) { set.seed(seed, kind = VCR_RNG_KIND); .vcr_pt_folds(strata, k) }

vcr_case("N98a", c("AC-04", "AC-30"), function() {
  n <- 900L; d <- .n98_cox_data(n, 9811L); lp_true <- attr(d, "lp")
  preds <- c("x1", "x2", "x3", "x4")
  r <- .n98_run(.n98_scenario("time_to_event", "snp_n98a:subject", preds), d, "snp_n98a:subject")
  eq <- r$diagnostics$model$equation
  full <- survival::coxph(survival::Surv(os, death) ~ x1 + x2 + x3 + x4, data = d, ties = "efron")
  beta_job <- vapply(eq$terms, function(t) t$coefficient, numeric(1))
  h0 <- survival::basehaz(full, centered = TRUE); h24 <- h0$hazard[max(which(h0$time <= 24))]
  # the pooled out-of-fold C index by hand, on the job's folds: each fold predicted by a model that never saw it
  folds <- .n98_folds(9801L, d$death, 5L)
  oof <- numeric(n)
  for (f in 1:5) {
    fit <- survival::coxph(survival::Surv(os, death) ~ x1 + x2 + x3 + x4, data = d[folds != f, ], ties = "efron")
    oof[folds == f] <- as.numeric(as.matrix(d[folds == f, preds]) %*% stats::coef(fit)) - sum(colMeans(d[preds]) * stats::coef(fit))
  }
  c_hand <- unname(survival::concordance(survival::Surv(d$os, d$death) ~ oof, reverse = TRUE)$concordance)
  # the population C of the true score: a large sample from the same law
  big <- .n98_cox_data(60000L, 9812L); c_true <- unname(survival::concordance(survival::Surv(big$os, big$death) ~ attr(big, "lp"), reverse = TRUE)$concordance)
  slope <- Filter(function(m) m$name == "calibration_slope", r$measures)[[1]]
  # the equation applied by the published-equation method gives the absolute risk at 24 months of the full model
  apply_sc <- list(inputId = "snp_n98a:subject", idColumn = "USUBJID", sourceCondition = "control", endpoint = r$diagnostics$model$endpoint,
                   inputUnits = r$diagnostics$model$inputUnits, model = eq)
  dd <- tempfile("n98a"); dir.create(dd)
  ap <- vcr_test_run(vcr_test_job("model.prognostic_apply", apply_sc, list(vcr_test_input(d, "snp_n98a:subject", shape = "subject", source = "observed")), seed = 1L), output_dir = dd)
  pred <- vcr_test_table(ap, "prognostic-predictions", dd); unlink(dd, recursive = TRUE)
  risk_hand <- -expm1(-h24 * exp(as.numeric(as.matrix(d[preds]) %*% stats::coef(full)) - sum(colMeans(d[preds]) * stats::coef(full))))
  # noise: twenty-two predictors with no effect on 300 people, twelve datasets. Fitted and scored on the same rows they look better than chance
  # (an optimism the cross-fitting must remove): the mean out-of-fold C index sits on 0.5 and the in-sample one does not.
  pn <- c("x1", "x2", sprintf("z%02d", 1:20))
  noise <- vapply(1:12, function(i) {
    dn <- .n98_cox_data(300L, 9820L + i, beta = c(0, 0), noise = 20L, base = 0.04, cens = 0.04)
    rn <- .n98_run(.n98_scenario("time_to_event", "snp_n98an:subject", pn), dn, "snp_n98an:subject", seed = 9830L + i)
    fit_in <- survival::coxph(stats::as.formula(paste("survival::Surv(os, death) ~", paste(pn, collapse = "+"))), data = dn)
    c(oof = if (identical(rn$conclusion, "not_estimable")) NA_real_ else .n98_m(rn, "out_of_fold_c_index"), inside = unname(survival::concordance(fit_in)$concordance))
  }, numeric(2))
  list(pass = identical(r$status, "succeeded") && max(abs(beta_job - unname(stats::coef(full)))) < 1e-8 && abs(eq$baseline$survival - exp(-h24)) < 1e-12 && eq$baseline$reference == "centered" &&
         abs(.n98_m(r, "out_of_fold_c_index") - c_hand) < 1e-10 && abs(.n98_m(r, "out_of_fold_c_index") - c_true) < 0.03 &&
         slope$interval$low < 1 && slope$interval$high > 1 && abs(slope$value - 1) < 0.15 &&
         identical(ap$status, "succeeded") && max(abs(pred$prediction - risk_hand)) < 1e-10 && identical(r$diagnostics$model$label, "trained_on_user_data_not_externally_validated") &&
         !anyNA(noise) && abs(mean(noise["oof", ]) - 0.5) < 0.025 && mean(noise["inside", ]) - mean(noise["oof", ]) > 0.05,
       detail = sprintf("900 people, a Weibull-like proportional-hazards truth (0.6, -0.4, 0, 0.3), 5 folds: coefficients against coxph on every row differ by %.1e, baseline survival at 24 months %.8f against exp(-basehaz) %.8f; the out-of-fold C index %.6f equals the hand recomputation on the job's folds (%.6f) and sits %.3f from the population C of the true score (%.3f); calibration slope %.3f (%.3f, %.3f); the saved equation applied by model.prognostic_apply gives the full model's risk to %.1e; twenty-two noise predictors on 300 people, twelve datasets: mean in-sample C %.3f, mean out of fold %.3f",
                        max(abs(beta_job - unname(stats::coef(full)))), eq$baseline$survival, exp(-h24), .n98_m(r, "out_of_fold_c_index"), c_hand, abs(.n98_m(r, "out_of_fold_c_index") - c_true), c_true,
                        slope$value, slope$interval$low, slope$interval$high, max(abs(pred$prediction - risk_hand)), mean(noise["inside", ]), mean(noise["oof", ])))
})

vcr_case("N98b", c("AC-04"), function() {
  set.seed(9821L, kind = VCR_RNG_KIND)
  n <- 700L; b <- c(1.5, -0.8); sigma <- 2
  d <- data.frame(USUBJID = sprintf("S%05d", seq_len(n)), x1 = stats::rnorm(n), x2 = stats::rnorm(n)); d$y <- 2 + b[1] * d$x1 + b[2] * d$x2 + stats::rnorm(n, 0, sigma)
  r <- .n98_run(.n98_scenario("continuous", "snp_n98b:subject", c("x1", "x2")), d, "snp_n98b:subject")
  eq <- r$diagnostics$model$equation
  fit <- stats::lm(y ~ x1 + x2, data = d)
  folds <- .n98_folds(9801L, rep(1L, n), 5L); oof <- numeric(n)
  for (f in 1:5) oof[folds == f] <- stats::predict(stats::lm(y ~ x1 + x2, data = d[folds != f, ]), newdata = d[folds == f, ])
  r2_hand <- 1 - sum((d$y - oof)^2) / sum((d$y - mean(d$y))^2); rmse_hand <- sqrt(mean((d$y - oof)^2)); rho_hand <- stats::cor(oof, d$y)
  r2_pop <- sum(b^2) / (sum(b^2) + sigma^2)
  rho <- Filter(function(m) m$name == "prognostic_correlation", r$measures)[[1]]
  fisher <- tanh(atanh(rho_hand) + c(-1, 1) * stats::qnorm(0.975) / sqrt(n - 3))
  list(pass = identical(r$status, "succeeded") && abs(eq$intercept - unname(stats::coef(fit)[1])) < 1e-10 && max(abs(vapply(eq$terms, function(t) t$coefficient, numeric(1)) - unname(stats::coef(fit)[-1]))) < 1e-10 &&
         abs(.n98_m(r, "out_of_fold_r_squared") - r2_hand) < 1e-10 && abs(eq$residualSd - rmse_hand) < 1e-10 && abs(rho$value - rho_hand) < 1e-10 &&
         abs(rho$interval$low - fisher[1]) < 1e-10 && abs(rho$interval$high - fisher[2]) < 1e-10 &&
         abs(r2_hand - r2_pop) < 0.04 && abs(rho_hand - sqrt(r2_pop)) < 0.04 && abs(eq$residualSd - sigma) / sigma < 0.06,
       detail = sprintf("700 people, y = 2 + 1.5 x1 - 0.8 x2 + N(0, 2^2): the saved intercept and coefficients equal lm on every row (to 1e-10); out-of-fold R squared %.5f equals the hand recomputation on the job's folds (%.5f) and the closed form b'b / (b'b + sigma^2) = %.4f is %.3f away; rho %.5f (closed form sqrt = %.4f) with the Fisher interval (%.4f, %.4f) as computed by hand; the residual SD saved is the out-of-fold root mean square error %.4f (truth %.1f)",
                        .n98_m(r, "out_of_fold_r_squared"), r2_hand, r2_pop, abs(r2_hand - r2_pop), rho$value, sqrt(r2_pop), rho$interval$low, rho$interval$high, eq$residualSd, sigma))
})

vcr_case("N98c", c("AC-04"), function() {
  set.seed(9831L, kind = VCR_RNG_KIND)
  n <- 500L; d <- data.frame(USUBJID = sprintf("S%05d", seq_len(n)), x1 = stats::rnorm(n), x2 = stats::rnorm(n)); d$y <- d$x1 + 0.5 * d$x2 + stats::rnorm(n)
  r <- .n98_run(.n98_scenario("continuous", "snp_n98c:subject", c("x1", "x2"), list(procova = list(lambdas = list(1, 0.9, 0.5), gammas = list(1, 1.25), allocation = 0.5))), d, "snp_n98c:subject")
  rows <- r$diagnostics$procova$rows
  rho_est <- r$diagnostics$correlation$value
  at <- function(l, g, which) Filter(function(x) x$lambda == l && x$gamma == g && x$rhoAt == which, rows)[[1]]
  closed <- function(rho, l, g) (1 - (l * rho)^2) * (1 + g^2) / 2
  # design.procova for one row: the same rho, discount and inflation; the ratio of its two required sizes is the table's ratio
  one <- at(0.9, 1.25, "estimate")
  pj <- vcr_test_run(vcr_test_job("design.procova", list(design = list(allocation = 0.5), truth = list(effect = 0.3, sd = 1), analysis = list(alpha = 0.025, power = 0.9),
                                                         prognostic = list(rho = rho_est, lambda = 0.9, gamma = 1.25)), NULL))
  ratio_job <- vcr_measure_value(pj, "variance_ratio")
  ratio_sizes <- vcr_measure_value(pj, "required_total_prognostic") / vcr_measure_value(pj, "required_total_unadjusted")
  ok_rows <- all(vapply(rows, function(x) abs(x$sampleSizeRatio$value - closed(x$rho, x$lambda, x$gamma)) < 1e-12 && abs(x$saving$value - (1 - x$sampleSizeRatio$value)) < 1e-15, logical(1)))
  low <- at(1, 1, "lower")
  list(pass = identical(r$status, "succeeded") && length(rows) == 3L * 2L * 2L && ok_rows && abs(ratio_job - one$sampleSizeRatio$value) < 1e-12 && abs(ratio_sizes - one$sampleSizeRatio$value) < 5e-3 && low$rho < rho_est &&
         at(0.5, 1, "estimate")$saving$value < at(1, 1, "estimate")$saving$value && at(1, 1.25, "estimate")$saving$value < at(1, 1, "estimate")$saving$value,
       detail = sprintf("12 rows (3 discounts on rho x 2 inflations of the control SD x the estimate and the lower end of its interval) at rho %.4f: every sample-size ratio equals the closed form (1 - (lambda rho)^2)(1 + gamma^2)/2 to 1e-12; lambda 0.9, gamma 1.25 gives %.5f here, %.5f as design.procova's variance ratio and %.5f as the ratio of its required sizes (rounded up to whole people); the saving falls as lambda falls (%.4f at 1, %.4f at 0.5) and as gamma rises (%.4f at 1.25), the lower end of rho %.4f is below its estimate",
                        rho_est, one$sampleSizeRatio$value, ratio_job, ratio_sizes, at(1, 1, "estimate")$saving$value, at(0.5, 1, "estimate")$saving$value, at(1, 1.25, "estimate")$saving$value, low$rho))
})

vcr_case("N98d", c("AC-04"), function() {
  set.seed(9841L, kind = VCR_RNG_KIND)
  n <- 400L; d <- data.frame(USUBJID = sprintf("S%05d", seq_len(n)), x1 = stats::rnorm(n), x2 = stats::rnorm(n), x3 = stats::rnorm(n)); d$y <- stats::rbinom(n, 1L, stats::plogis(-0.5 + 1.0 * d$x1 - 0.7 * d$x2))
  dir <- tempfile("n98d"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- .n98_run(.n98_scenario("binary", "snp_n98d:subject", c("x1", "x2", "x3")), d, "snp_n98d:subject")
  eq <- r$diagnostics$model$equation
  full <- stats::glm(y ~ x1 + x2 + x3, data = d, family = stats::binomial())
  # DeLong against every pair: the variance of the AUC from its structural components computed with a double loop
  s <- stats::runif(80L); yy <- stats::rbinom(80L, 1L, 0.4); s[yy == 1] <- s[yy == 1] + 0.3
  dl <- .vcr_delong(s, yy); pos <- s[yy == 1]; neg <- s[yy == 0]
  psi <- outer(pos, neg, function(a, b) (a > b) + 0.5 * (a == b))
  v10 <- rowMeans(psi); v01 <- colMeans(psi); se_pairs <- sqrt(stats::var(v10) / length(pos) + stats::var(v01) / length(neg))
  # the population AUC of the true probabilities, from a large sample
  big <- 60000L; xb1 <- stats::rnorm(big); xb2 <- stats::rnorm(big); pb <- stats::plogis(-0.5 + xb1 - 0.7 * xb2); yb <- stats::rbinom(big, 1L, pb)
  auc_true <- .vcr_auc(pb, yb)
  auc <- Filter(function(m) m$name == "out_of_fold_auc", r$measures)[[1]]
  slope <- Filter(function(m) m$name == "calibration_slope", r$measures)[[1]]; int <- Filter(function(m) m$name == "calibration_intercept", r$measures)[[1]]
  ap_sc <- list(inputId = "snp_n98d:subject", idColumn = "USUBJID", sourceCondition = "control", endpoint = r$diagnostics$model$endpoint, inputUnits = r$diagnostics$model$inputUnits, model = eq)
  dd <- tempfile("n98dd"); dir.create(dd); on.exit(unlink(dd, recursive = TRUE), add = TRUE)
  ap <- vcr_test_run(vcr_test_job("model.prognostic_apply", ap_sc, list(vcr_test_input(d, "snp_n98d:subject", shape = "subject", source = "observed")), seed = 1L), output_dir = dd)
  pred <- vcr_test_table(ap, "prognostic-predictions", dd)
  list(pass = identical(r$status, "succeeded") && abs(dl$se - se_pairs) < 1e-12 && max(abs(c(eq$intercept, vapply(eq$terms, function(t) t$coefficient, numeric(1))) - unname(stats::coef(full)))) < 1e-8 &&
         abs(auc$value - auc_true) < 0.04 && auc$interval$low < auc$value && auc$interval$high > auc$value &&
         slope$interval$low < 1 && slope$interval$high > 1 && int$interval$low < 0 && int$interval$high > 0 &&
         max(abs(pred$prediction - unname(stats::fitted(full)))) < 1e-8,
       detail = sprintf("400 people, logistic truth: out-of-fold AUC %.4f (%.4f, %.4f) against %.4f for the true probabilities in 60,000 people; calibration slope %.3f (%.3f, %.3f) and intercept %.3f (%.3f, %.3f) of the right model; DeLong's standard error %.8f equals the double loop over all %d pairs (%.8f); the saved equation applied by model.prognostic_apply gives glm's fitted probabilities to %.1e",
                        auc$value, auc$interval$low, auc$interval$high, auc_true, slope$value, slope$interval$low, slope$interval$high, int$value, int$interval$low, int$interval$high,
                        dl$se, length(pos) * length(neg), se_pairs, max(abs(pred$prediction - unname(stats::fitted(full))))))
})

vcr_case("N98e", c("AC-04", "AC-27"), function() {
  # what is refused, and what is never shown
  d <- .n98_cox_data(400L, 9851L)
  # 1. four events in a table of 400: not estimable, by name
  few <- d; few$death <- 0; few$death[1:4] <- 1
  r_few <- .n98_run(.n98_scenario("time_to_event", "snp_n98e1:subject", c("x1", "x2")), few, "snp_n98e1:subject")
  # 2. a predictor that separates the outcome perfectly: the logistic model has no estimate
  set.seed(9852L, kind = VCR_RNG_KIND)
  sep <- data.frame(USUBJID = sprintf("S%05d", 1:200), x1 = stats::rnorm(200)); sep$y <- as.numeric(sep$x1 > 0)
  r_sep <- .n98_run(.n98_scenario("binary", "snp_n98e2:subject", "x1"), sep, "snp_n98e2:subject")
  # 3. a level held by four people: no term, not named, those people excluded and counted
  cat_d <- d; cat_d$site <- sample(c("north", "south", "east"), nrow(cat_d), TRUE); cat_d$site[1:4] <- "St-Rare-Genotype-X"
  sc3 <- .n98_scenario("time_to_event", "snp_n98e3:subject", c("x1")); sc3$predictors[[2]] <- list(column = "site", unit = "category")
  r3 <- .n98_run(sc3, cat_d, "snp_n98e3:subject")
  json3 <- jsonlite::toJSON(r3$diagnostics, auto_unbox = TRUE, digits = NA, null = "null")
  levels3 <- Filter(function(t) !is.null(t$levels), r3$diagnostics$model$equation$terms)[[1]]$levels
  dd <- tempfile("n98e"); dir.create(dd); on.exit(unlink(dd, recursive = TRUE), add = TRUE)
  apply_to <- cat_d[1:6, ]
  ap <- vcr_test_run(vcr_test_job("model.prognostic_apply", list(inputId = "snp_n98e3b:subject", idColumn = "USUBJID", sourceCondition = "control", endpoint = r3$diagnostics$model$endpoint,
                                 inputUnits = r3$diagnostics$model$inputUnits, model = r3$diagnostics$model$equation), list(vcr_test_input(apply_to, "snp_n98e3b:subject", shape = "subject", source = "observed")), seed = 1L), output_dir = dd)
  pred <- vcr_test_table(ap, "prognostic-predictions", dd)
  # 4. a horizon past every follow-up: the score and the relative risk stay, there is no baseline and no absolute risk
  r4 <- .n98_run(.n98_scenario("time_to_event", "snp_n98e4:subject", c("x1", "x2"), horizon = 1e4), d, "snp_n98e4:subject")
  list(pass = identical(r_few$conclusion, "not_estimable") && identical(r_few$notEstimableRule, "too_few_events") && length(r_few$measures) == 0L &&
         identical(r_sep$conclusion, "not_estimable") && identical(r_sep$notEstimableRule, "nuisance_model_not_estimable") &&
         identical(r3$status, "succeeded") && !grepl("St-Rare-Genotype-X", json3, fixed = TRUE) && setequal(unlist(levels3), c("east", "north", "south")) && r3$diagnostics$excludedRows == 4L &&
         all(is.na(pred$prediction[1:4])) && all(grepl("unknown_category", pred$reason[1:4])) && all(is.finite(pred$prediction[5:6])) &&
         identical(r4$status, "succeeded") && is.null(r4$diagnostics$model$equation$baseline) && isFALSE(r4$diagnostics$model$absoluteRiskAvailable) && is.finite(.n98_m(r4, "out_of_fold_c_index")),
       detail = sprintf("4 events in 400 people -> %s (%s); a perfectly separating predictor -> %s; a text predictor with a level held by four people: the levels saved are %s, the name is nowhere in the result, the 4 people are excluded and counted (excludedRows %s), and when the saved equation is applied to them it answers unknown_category for each; a horizon of 10,000 months past the data: C index %.3f and an equation with no baseline",
                        r_few$conclusion, r_few$notEstimableRule, r_sep$notEstimableRule, paste(unlist(levels3), collapse = "/"), r3$diagnostics$excludedRows, .n98_m(r4, "out_of_fold_c_index")))
})

vcr_case("N98f", c("AC-04", "AC-31"), function() {
  # the forest is a comparison, never the model; the job is deterministic; on a linear signal the forest does not beat the regression
  d <- .n98_cox_data(500L, 9861L)
  sc <- .n98_scenario("time_to_event", "snp_n98f:subject", c("x1", "x2", "x3", "x4"), list(comparison = list(ranger = TRUE)))
  t0 <- Sys.time(); r1 <- .n98_run(sc, d, "snp_n98f:subject"); secs <- as.numeric(difftime(Sys.time(), t0, units = "secs"))
  r2 <- .n98_run(sc, d, "snp_n98f:subject")
  rf <- r1$diagnostics$comparison
  none <- .n98_run(utils::modifyList(sc, list(comparison = list(ranger = FALSE))), d, "snp_n98f:subject")
  list(pass = identical(vcr_output_hash(r1), vcr_output_hash(r2)) && identical(rf$model, "random_forest") && rf$metric == "c_index" && rf$difference < 0.03 && is.null(none$diagnostics$comparison) &&
         is.null(r1$diagnostics$model$equation$forest) && identical(r1$diagnostics$model$equation$family, "cox") && secs < 60,
       detail = sprintf("500 people with a linear proportional-hazards truth: the forest on the same folds has an out-of-fold C index %.3f against the regression's %.3f (difference %.3f: the forest does not beat it); the saved model is the Cox equation and carries no forest; the job twice has the same output hash; %.1f s with the forest",
                        rf$value, .n98_m(r1, "out_of_fold_c_index"), rf$difference, secs))
})

vcr_case("N98g", c("AC-04", "AC-26"), function() {
  # a snapshot keeps the event time in its own table (AVAL, CNSR = 1 for a censored person): the job joins it to the subject table by the person and
  # trains the same model as a single table with the time and status in it
  d <- .n98_cox_data(400L, 9871L); preds <- c("x1", "x2", "x3", "x4")
  single <- .n98_run(.n98_scenario("time_to_event", "snp_n98g1:subject", preds), d, "snp_n98g1:subject")
  subj <- d[c("USUBJID", preds)]
  ev <- data.frame(USUBJID = d$USUBJID, PARAMCD = "OS", AVAL = d$os, CNSR = 1 - d$death, stringsAsFactors = FALSE)
  in_subj <- vcr_test_input(subj, "snp_n98g2:subject", shape = "subject", source = "observed"); in_ev <- vcr_test_input(ev, "snp_n98g2:event", shape = "event", source = "observed")
  sc <- .n98_scenario("time_to_event", "snp_n98g2:subject", preds); sc$endpoint$parameterCode <- "OS"
  joined <- vcr_test_run(vcr_test_job("model.prognostic_train", sc, list(in_subj, in_ev), seed = 9801L))
  b1 <- vapply(single$diagnostics$model$equation$terms, function(t) t$coefficient, numeric(1)); b2 <- vapply(joined$diagnostics$model$equation$terms, function(t) t$coefficient, numeric(1))
  # three people with no event record are left out, counted
  in_ev2 <- vcr_test_input(ev[-(1:3), ], "snp_n98g3:event", shape = "event", source = "observed"); in_subj2 <- vcr_test_input(subj, "snp_n98g3:subject", shape = "subject", source = "observed")
  sc3 <- sc; sc3$inputId <- "snp_n98g3:subject"
  part <- vcr_test_run(vcr_test_job("model.prognostic_train", sc3, list(in_subj2, in_ev2), seed = 9801L))
  list(pass = identical(joined$status, "succeeded") && max(abs(b1 - b2)) < 1e-12 && abs(.n98_m(single, "out_of_fold_c_index") - .n98_m(joined, "out_of_fold_c_index")) < 1e-12 &&
         identical(part$status, "succeeded") && part$diagnostics$excludedRows == 3L && part$diagnostics$usedRows == 397L,
       detail = sprintf("400 people, the event time in a second table: the joined job's coefficients equal the single-table job's (largest gap %.1e) and so does its out-of-fold C index (%.6f); with three people missing from the event table the job trains on 397 and counts the 3 it left out",
                        max(abs(b1 - b2)), .n98_m(joined, "out_of_fold_c_index")))
})

vcr_case("N98h", c("AC-04", "AC-27"), function() {
  # Review stats2 findings 10, 18 and 19.
  # (10) A Cox model needs events, not censored people: 3,000 people with no one censored, or fifteen, were 'too few events' (the smaller of events and
  #      censored was counted). They fit.
  # (18) The correlation of a time-to-event score with 'an event by the horizon' left out the people censored before it, so it fell with the censoring
  #      although the score did not change: .51 with complete follow-up read .50, .39 and .23 at three censoring rates. Each person whose status is known is
  #      now weighted by the inverse probability of staying uncensored (Kaplan-Meier of the censoring times) and the weighted correlation is read; the figure
  #      is held to the correlation of the same score with complete follow-up (the same job on the table with the censoring removed).
  # (19) A level of a text predictor is named only if held by the small-cell size among the rows the model is fitted to: a level of 12 people in the table
  #      of whom 9 have no outcome has 3 and gets no term (its 3 people are excluded and counted).
  sc <- function(id, preds = c("x1", "x2", "x3")) .n98_scenario("time_to_event", id, preds)
  # a fixed known score (the true linear predictor, nothing fitted) so that only the estimator of the correlation is in question: the correlation of the
  # score with "an event by 24" in the data with no censoring is the reference; the censored copies of the same people must give it back
  rates <- c(0.01, 0.03, 0.06)
  stats_of <- lapply(rates, function(rate) {
    out <- vapply(c(9881L, 9884L, 9885L), function(sd) {
      d <- .n98_cox_data(3000L, sd, beta = c(0.6, -0.4, 0.3), cens = rate); lp <- attr(d, "lp")
      full <- .n98_cox_data(3000L, sd, beta = c(0.6, -0.4, 0.3), cens = 1e-7)
      ref <- stats::cor(lp, as.numeric(full$os <= 24 & full$death == 1))
      known <- (d$death == 1 & d$os <= 24) | d$os > 24   # the first version: the people censored before the horizon left out
      first <- stats::cor(lp[known], as.numeric(d$os[known] <= 24 & d$death[known] == 1))
      c(gap = abs(.vcr_pt_tte_correlation(lp, d$os, d$death, 24)$rho - ref), left = mean(d$death == 0 & d$os < 24), ref = ref, first = abs(first - ref))
    }, numeric(4))
    c(gap = mean(out["gap", ]), left = mean(out["left", ]), ref = mean(out["ref", ]), first = mean(out["first", ]))
  })
  gap <- vapply(stats_of, function(x) x[["gap"]], numeric(1)); share_censored <- vapply(stats_of, function(x) x[["left"]], numeric(1)); rho_full <- stats_of[[1]][["ref"]]; first_gap <- vapply(stats_of, function(x) x[["first"]], numeric(1))
  # the job: the saved score is fitted, so the figure is not the reference's; it must not fall with the censoring the way it did
  job_rho <- vapply(rates, function(rate) { d <- .n98_cox_data(3000L, 9881L, beta = c(0.6, -0.4, 0.3), cens = rate); id <- sprintf("snp_n98h_%d:subject", round(rate * 100)); .n98_m(.n98_run(sc(id), d, id), "prognostic_correlation") }, numeric(1))
  # (10)
  few_cens <- lapply(c(0L, 15L, 25L), function(k) {
    d <- .n98_cox_data(3000L, 9882L, beta = c(0.6, -0.4, 0.3), cens = 1e-7); d$death <- 1; if (k > 0L) d$death[seq_len(k)] <- 0
    r <- .n98_run(sc(sprintf("snp_n98h_c%d:subject", k)), d, sprintf("snp_n98h_c%d:subject", k)); list(k = k, status = r$conclusion, c = .n98_m(r, "out_of_fold_c_index"))
  })
  ok10 <- all(vapply(few_cens, function(x) !identical(x$status, "not_estimable") && is.finite(x$c), logical(1)))
  # (19)
  d19 <- .n98_cox_data(600L, 9883L, beta = c(0.6, -0.4, 0.3)); d19$site <- sample(c("north", "south", "east"), 600L, TRUE)
  d19$site[1:12] <- "rare-site"; d19$death[1:9] <- NA
  sc19 <- sc("snp_n98h19:subject", c("x1", "x2")); sc19$predictors[[3]] <- list(column = "site", unit = "category")
  r19 <- .n98_run(sc19, d19, "snp_n98h19:subject")
  levels19 <- unlist(Filter(function(t) !is.null(t$levels), r19$diagnostics$model$equation$terms)[[1]]$levels)
  ok19 <- identical(r19$status, "succeeded") && setequal(levels19, c("east", "north", "south")) && r19$diagnostics$excludedRows == 12L &&
    !grepl("rare-site", jsonlite::toJSON(r19$diagnostics, auto_unbox = TRUE, null = "null"), fixed = TRUE)
  list(pass = ok10 && ok19 && all(gap < 0.045) && is.finite(rho_full) && rho_full > 0.3 && min(job_rho) > 0.8 * max(job_rho) && first_gap[3] > 0.06 && first_gap[3] > 2 * gap[3],
       detail = sprintf("3,000 people, the true linear predictor as the score: correlation with an event by 24 in the data with no censoring %.3f; with %s of the people censored before 24 the weighted correlation is off it by %s on average over three tables (the first version's estimator, which left them out, is off by %s); the job's fitted score gives %s at the three rates; no one censored, 15 and 25 censored all fit (C %s); a level held by 12 people in the table and 3 among the rows with an outcome is not named (levels saved: %s; %d rows excluded)",
                        rho_full, paste(sprintf("%.0f%%", 100 * share_censored), collapse = ", "), paste(sprintf("%.3f", gap), collapse = ", "), paste(sprintf("%.3f", first_gap), collapse = ", "), paste(sprintf("%.3f", job_rho), collapse = ", "), paste(sprintf("%.3f", vapply(few_cens, function(x) x$c, numeric(1))), collapse = ", "),
                        paste(levels19, collapse = "/"), r19$diagnostics$excludedRows))
})
