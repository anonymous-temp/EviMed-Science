# N30 — a column name is data, never code (merge verification, 2026-09-29).
#
# A header written as R code — `bmi+system('touch <marker>')` — used to be
# executed when the quality report, the synthetic TSTR check, STC or the
# covariate-adjusted analyses spliced column names into a formula string. Every
# such formula is now built from `as.name()` symbols (`vcr_model_formula`), so
# the same header is just an awkward column name. The case runs each of those
# paths on a table whose headers are written as code and asserts the marker
# file is never created, and that the model still fits on the odd name.

vcr_case("N30", c("AC-26", "AC-04"), function() {
  marker <- file.path(tempdir(), sprintf("vcr-n30-%d", Sys.getpid()))
  unlink(marker)
  evil <- sprintf("bmi+system('touch %s')", marker)
  set.seed(30L)
  n <- 200L
  real <- data.frame(a = stats::rnorm(n), b = stats::rnorm(n))
  names(real) <- c(evil, "age")
  synth <- real[sample.int(n), , drop = FALSE]
  holdout <- real[sample.int(n, 50L), , drop = FALSE]
  real$y <- stats::rbinom(n, 1, 0.4); synth$y <- stats::rbinom(n, 1, 0.4); holdout$y <- stats::rbinom(50L, 1, 0.4)

  util <- tryCatch(vcr_utility_propensity(real[, 1:2], synth[, 1:2]), error = function(e) e)
  tstr <- tryCatch(vcr_tstr(real, synth, holdout, "y"), error = function(e) e)
  X <- as.matrix(real[, 1:2]); colnames(X) <- names(real)[1:2]
  targets <- stats::setNames(colMeans(X), colnames(X))
  stc <- tryCatch(vcr_stc(real$y, stats::rbinom(n, 1, 0.5), X, targets), error = function(e) e)
  d <- data.frame(y = stats::rnorm(n), arm = rep(0:1, length.out = n), x = stats::rnorm(n)); names(d)[3] <- evil
  anc <- tryCatch(vcr_analyse_ancova(d, covariates = evil), error = function(e) e)

  executed <- file.exists(marker)
  fitted <- !inherits(util, "error") && is.finite(util$pMSE) && !inherits(anc, "error") && is.finite(anc[["estimate"]]) &&
    !inherits(stc, "error") && is.finite(stc$estimate)
  list(pass = !executed && fitted,
       detail = sprintf("header written as code executed: %s; propensity pMSE %s, TSTR %s, STC %s, ANCOVA %s",
                        executed,
                        if (inherits(util, "error")) conditionMessage(util) else format(util$pMSE, digits = 4),
                        if (inherits(tstr, "error")) conditionMessage(tstr) else "ran",
                        if (inherits(stc, "error")) conditionMessage(stc) else format(stc$estimate, digits = 4),
                        if (inherits(anc, "error")) conditionMessage(anc) else format(anc[["estimate"]], digits = 4)))
})
