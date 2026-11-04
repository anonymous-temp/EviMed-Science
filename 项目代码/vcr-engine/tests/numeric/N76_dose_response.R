# N76 — evidence.dose_response: dose-response meta-analysis of grouped data (algorithm round C6, 2026-11-03).
#
# References that are not the method's own code: (1) the package's own article (Crippa & Orsini 2016, Journal of Statistical Software 72(1), section 4): the
# colorectal-cancer data it ships with (`alcohol_crc`, eight cohorts, 48 levels, incidence rates), fitted there as a log-linear random-effects model (a
# coefficient of 0.0064, standard error 0.0014, Cochran Q 4.7797 on 7 degrees of freedom, and a ratio of 1.080313 with limits 1.0465 and 1.115218 for 12
# grams a day) and as a restricted cubic spline with four knots at the 5th, 35th, 65th and 95th percentiles of the dose (coefficients -0.0097, 0.1274,
# -0.2144 with standard errors 0.0082, 0.0808, 0.1488, a chi-squared of 28.3632 on 3 degrees of freedom, a test of non-linearity of 5.1 on 2 with
# p = 0.078, and the table of ratios at 0 to 60 grams a day); the engine's spline basis is written here (the article uses `rms::rcs`), so matching the
# article's coefficients is what proves it is the same basis; (2) a Greenland-Longnecker generalized-least-squares slope written out by hand, on counts whose
# variances are exact (variances computed from the counts, so the reconstruction of the covariance has nothing to approximate).

.n76_job <- function(sc, id) vcr_test_job("evidence.dose_response", sc, NULL, job_id = paste0("job_", id))

.n76_studies <- function(d) unname(lapply(split(d, d$id), function(x) list(studyId = as.character(x$id[1]), type = as.character(x$type[1]),
  rows = lapply(seq_len(nrow(x)), function(i) c(list(dose = x$dose[i], effect = x$logrr[i], cases = x$cases[i], n = x$peryears[i]), if (!is.na(x$se[i])) list(se = x$se[i]))))))

vcr_case("N76a", c("AC-08", "AC-30"), function() {
  if (!requireNamespace("dosresmeta", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the dosresmeta package is not installed (the run must not skip silently)"))
  d <- get(utils::data("alcohol_crc", package = "dosresmeta", envir = environment())[1], envir = environment())
  r <- vcr_test_run(.n76_job(list(studies = .n76_studies(d), model = list(kind = "linear"), perDose = 12), "n76a"))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  dr <- r$diagnostics$doseResponse
  b <- dr$coefficients[[1]]; rp <- vcr_get_measure(r, "ratio_per_dose_step")
  want <- c(coef = 0.0064, se = 0.0014, Q = 4.7797, ratio = 1.080313, lo = 1.0465, hi = 1.115218)
  got <- c(coef = b$estimate, se = b$se, Q = dr$heterogeneity$Q, ratio = rp$value, lo = rp$interval$low, hi = rp$interval$high)
  tol <- c(coef = 5e-5, se = 5e-5, Q = 5e-5, ratio = 5e-7, lo = 5e-5, hi = 5e-7)
  ok <- all(abs(got - want) <= tol) && as.integer(dr$heterogeneity$df) == 7L && abs(dr$heterogeneity$p - 0.6868) < 5e-5 && length(vcr_validate_result(r)) == 0L
  list(pass = ok,
       detail = sprintf("alcohol_crc, log-linear, two-stage REML: coefficient %.4f (%.4f), Q %.4f on %d, p %.4f, ratio per 12 g/day %.6f (%.4f, %.6f) -- the article prints 0.0064 (0.0014), 4.7797 on 7, 0.6868, 1.080313 (1.0465, 1.115218)",
                        got["coef"], got["se"], got["Q"], as.integer(dr$heterogeneity$df), dr$heterogeneity$p, got["ratio"], got["lo"], got["hi"]))
})

vcr_case("N76b", c("AC-08", "AC-30"), function() {
  if (!requireNamespace("dosresmeta", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the dosresmeta package is not installed (the run must not skip silently)"))
  d <- get(utils::data("alcohol_crc", package = "dosresmeta", envir = environment())[1], envir = environment())
  knots <- as.numeric(stats::quantile(d$dose, c(0.05, 0.35, 0.65, 0.95)))
  r <- vcr_test_run(.n76_job(list(studies = .n76_studies(d), model = list(kind = "spline", knotPercentiles = list(0.05, 0.35, 0.65, 0.95)), predictAt = list(0, 12, 24, 36, 48, 60), referenceDose = 0), "n76b"))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  dr <- r$diagnostics$doseResponse
  est <- vapply(dr$coefficients, function(x) x$estimate, numeric(1)); se <- vapply(dr$coefficients, function(x) x$se, numeric(1))
  tab <- do.call(rbind, lapply(dr$predictions, function(x) c(x$ratio, x$lower, x$upper)))
  want_tab <- rbind(c(1.00, 1.00, 1.00), c(0.95, 0.84, 1.07), c(1.07, 0.94, 1.21), c(1.22, 1.07, 1.39), c(1.37, 1.20, 1.56), c(1.53, 1.25, 1.88))
  d_est <- max(abs(est - c(-0.0097, 0.1274, -0.2144))); d_se <- max(abs(se - c(0.0082, 0.0808, 0.1488))); d_tab <- max(abs(round(tab, 2) - want_tab))
  ov <- dr$tests$overall; nl <- dr$tests$nonlinearity
  knots_ok <- max(abs(unlist(dr$given$model$knots) - knots)) < 1e-9
  list(pass = d_est < 5.1e-5 && d_se < 5.1e-5 && abs(ov$chi2 - 28.3632) < 6e-5 && as.integer(ov$df) == 3L && abs(nl$chi2 - 5.1) < 0.051 && as.integer(nl$df) == 2L && abs(nl$p - 0.078) < 5e-4 && d_tab < 0.0051 && knots_ok &&
        length(vcr_validate_result(r)) == 0L,
       detail = sprintf("alcohol_crc, four-knot restricted cubic spline: coefficients %s (se %s), overall chi-squared %.4f on %d, non-linearity %.2f on %d (p %.3f), ratios at 0..60 step 12 rounded as printed differ from the article's table by at most %.2f -- the article prints -0.0097 0.1274 -0.2144 (0.0082 0.0808 0.1488), 28.3632 on 3, 5.1 on 2 (p = 0.078)",
                        paste(sprintf("%.4f", est), collapse = " "), paste(sprintf("%.4f", se), collapse = " "), ov$chi2, as.integer(ov$df), nl$chi2, as.integer(nl$df), nl$p, d_tab))
})

vcr_case("N76c", c("AC-08", "AC-30"), function() {
  # A Greenland-Longnecker slope by hand. Three case-control studies with counts; the log odds ratios and their variances are computed FROM the counts
  # (var_l = 1/a_l + 1/b_l + 1/a_0 + 1/b_0, covariance of two levels 1/a_0 + 1/b_0), so the covariance the method reconstructs is the exact one. Each study's
  # slope is (x' S^-1 x)^-1 x' S^-1 y with x the dose against the reference; the studies are pooled by inverse variance (fixed effect).
  if (!requireNamespace("dosresmeta", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the dosresmeta package is not installed (the run must not skip silently)"))
  set.seed(76L)
  mkstudy <- function(id, doses, a, b) {
    k <- length(doses); lor <- log((a * b[1]) / (b * a[1]))[-1]
    S <- matrix(1 / a[1] + 1 / b[1], k - 1L, k - 1L) + diag(1 / a[-1] + 1 / b[-1], k - 1L)
    x <- doses[-1] - doses[1]
    v <- 1 / as.numeric(t(x) %*% solve(S) %*% x); beta <- v * as.numeric(t(x) %*% solve(S) %*% lor)
    list(id = id, beta = beta, v = v, doses = doses, a = a, b = b, lor = lor, se = sqrt(diag(S)))
  }
  sts <- list(mkstudy("c1", c(0, 5, 15, 30), c(120, 80, 70, 40), c(300, 190, 150, 70)),
              mkstudy("c2", c(0, 10, 20), c(90, 85, 60), c(210, 190, 110)),
              mkstudy("c3", c(0, 4, 12, 24, 40), c(200, 150, 140, 90, 50), c(520, 340, 300, 160, 75)))
  w <- vapply(sts, function(s) 1 / s$v, numeric(1)); beta <- sum(w * vapply(sts, function(s) s$beta, numeric(1))) / sum(w); se <- 1 / sqrt(sum(w))
  studies <- lapply(sts, function(s) list(studyId = s$id, type = "cc", rows = c(list(list(dose = s$doses[1], effect = 0, cases = s$a[1], n = s$a[1] + s$b[1])),
    lapply(2:length(s$doses), function(i) list(dose = s$doses[i], effect = s$lor[i - 1L], se = s$se[i - 1L], cases = s$a[i], n = s$a[i] + s$b[i])))))
  r <- vcr_test_run(.n76_job(list(studies = studies, model = list(kind = "linear"), method = "fixed"), "n76c"))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  b <- r$diagnostics$doseResponse$coefficients[[1]]
  # the same studies, rows in another order and the reference row last, give the same numbers
  shuffled <- lapply(studies, function(s) { s$rows <- rev(s$rows); s })
  r2 <- vcr_test_run(.n76_job(list(studies = rev(shuffled), model = list(kind = "linear"), method = "fixed"), "n76c"))
  b2 <- r2$diagnostics$doseResponse$coefficients[[1]]
  d <- c(abs(b$estimate - beta), abs(b$se - se)); d2 <- c(abs(b2$estimate - b$estimate), abs(b2$se - b$se))
  list(pass = max(d) < 5e-7 && max(d2) < 1e-12,
       detail = sprintf("three case-control studies with exact variances: pooled log-linear slope %.8f (se %.8f) vs the hand Greenland-Longnecker generalized-least-squares slope %.8f (se %.8f), difference %.1e; rows and studies in another order and the reference row last: %.1e",
                        b$estimate, b$se, beta, se, max(d), max(d2)))
})

vcr_case("N76d", c("AC-08", "AC-25"), function() {
  # What the engine does when a study cannot carry the model, and the rest of the surface: a spline leaves out a study with too few levels and says which;
  # a model no study can carry is refused by name; the one-stage fit agrees with the two-stage one on a linear model to the digits the article prints;
  # a level without counts turns the covariance independent and says so; two reference rows are refused by their path; the same hash on 1 and 2 cores.
  if (!requireNamespace("dosresmeta", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the dosresmeta package is not installed (the run must not skip silently)"))
  d <- get(utils::data("alcohol_crc", package = "dosresmeta", envir = environment())[1], envir = environment())
  st <- .n76_studies(d)
  small <- list(studyId = "tiny", type = "ir", rows = list(list(dose = 0, effect = 0, cases = 10, n = 1000), list(dose = 20, effect = 0.2, se = 0.3, cases = 14, n = 900)))
  rs <- vcr_test_run(.n76_job(list(studies = c(st, list(small)), model = list(kind = "spline", knotPercentiles = list(0.1, 0.5, 0.9))), "n76d1"))
  ex <- rs$diagnostics$doseResponse$excluded
  nothing <- vcr_test_run(.n76_job(list(studies = list(small), model = list(kind = "spline", knots = list(0, 10, 20))), "n76d2"))
  one <- vcr_test_run(.n76_job(list(studies = st, model = list(kind = "linear"), stage = "one"), "n76d3"))
  two <- vcr_test_run(.n76_job(list(studies = st, model = list(kind = "linear")), "n76d3"))
  nocount <- st; nocount[[1]]$rows[[2]]$cases <- NULL
  rn <- vcr_test_run(.n76_job(list(studies = nocount, model = list(kind = "linear")), "n76d4"))
  tworef <- st; tworef[[2]]$rows[[3]]$se <- NULL
  rt <- vcr_test_run(.n76_job(list(studies = tworef, model = list(kind = "linear")), "n76d5"))
  rr <- vcr_test_run(vcr_test_job("evidence.dose_response", list(studies = st, model = list(kind = "linear")), NULL, job_id = "job_n76d3", cores = 2L))
  has <- function(r, code) code %in% vcr_test_issue_codes(r)
  # one study without counts is independent and the others keep the Greenland-Longnecker covariance, said in a note that names the study (review stats2 finding 3;
  # N76f holds the pooled numbers): this expectation used to be 'indep' for every study, which is what the item changes
  cov_note <- any(vapply(rn$diagnostics$doseResponse$assumed, function(a) identical(a$key, "covariance") && identical(a$value, "mixed") && grepl(nocount[[1]]$studyId, a$basis, fixed = TRUE), logical(1))) &&
    identical(rn$diagnostics$doseResponse$given$covariance, "mixed")
  b1 <- one$diagnostics$doseResponse$coefficients[[1]]$estimate; b2 <- two$diagnostics$doseResponse$coefficients[[1]]$estimate
  list(pass = identical(rs$status, "succeeded") && length(ex) == 1L && identical(ex[[1]]$studyId, "tiny") && identical(nothing$status, "failed") && has(nothing, "scenario_value_invalid") &&
        identical(one$status, "succeeded") && abs(b1 - b2) < 5e-6 && cov_note && has(rt, "scenario_value_invalid") && identical(two$manifest$outputHash, rr$manifest$outputHash),
       detail = sprintf("spline with a two-level study: left out and named (%s, %d levels, needs %d); a model no study can carry: refused (%s); one-stage slope %.6f vs two-stage %.6f; a level without counts: that study alone is independent, the others keep their counts, and it is said (%s); two reference rows: refused (%s); same hash on 1 and 2 cores: %s",
                        ex[[1]]$studyId, as.integer(ex[[1]]$levels), as.integer(ex[[1]]$needed), has(nothing, "scenario_value_invalid"), b1, b2, cov_note, has(rt, "scenario_value_invalid"), identical(two$manifest$outputHash, rr$manifest$outputHash)))
})

vcr_case("N76e", c("AC-08", "AC-30"), function() {
  # A package that cannot be loaded is the engine's fault and is said so (review RF2 P2-12): the fit stands in for the failure the package raises when a
  # library it needs is missing, and the answer must not tell the person that the studies have too few levels. A fit that fails for the studies' own
  # reasons (one level, collinear levels) still says so.
  if (!requireNamespace("dosresmeta", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the dosresmeta package is not installed (the run must not skip silently)"))
  d <- get(utils::data("alcohol_crc", package = "dosresmeta", envir = environment())[1], envir = environment())
  sc <- list(studies = .n76_studies(d), model = list(kind = "linear"), perDose = 12)
  original <- dosresmeta::dosresmeta
  ns <- asNamespace("dosresmeta")
  unlockBinding("dosresmeta", ns)
  on.exit({ assign("dosresmeta", original, envir = ns); lockBinding("dosresmeta", ns) }, add = TRUE)
  assign("dosresmeta", function(...) stop("there is no package called 'mixmeta'"), envir = ns)
  broken <- vcr_test_run(.n76_job(sc, "n76e1"))
  assign("dosresmeta", function(...) stop("the covariance matrix is singular"), envir = ns)
  singular <- vcr_test_run(.n76_job(sc, "n76e2"))
  assign("dosresmeta", original, envir = ns)
  issue <- function(r) { f <- (r$diagnostics$issues %||% list())[[1]]; list(code = f$code, field = f$field, detail = f$detail %||% "") }
  a <- issue(broken); b <- issue(singular)
  ok <- identical(broken$status, "failed") && identical(a$code, "dose_response_method_unavailable") && identical(a$field, "engine") && !grepl("too few", a$detail) &&
    identical(singular$status, "failed") && identical(b$field, "scenario") && grepl("too few", b$detail)
  list(pass = ok, detail = sprintf("a package that cannot load: %s at %s (%s); a fit that fails on the studies: %s at %s (%s)", a$code, a$field, a$detail, b$code, b$field, b$detail))
})

#' Harrell's restricted cubic spline (the dose and k - 2 terms) written again from the formula, for the cases that must not use the engine's own.
.n76_rcs <- function(x, t) {
  k <- length(t); pos <- function(u) pmax(u, 0)^3
  do.call(cbind, c(list(x), lapply(seq_len(k - 2L), function(j) (pos(x - t[j]) - pos(x - t[k - 1L]) * (t[k] - t[j]) / (t[k] - t[k - 1L]) + pos(x - t[k]) * (t[k - 1L] - t[j]) / (t[k] - t[k - 1L])) / (t[k] - t[1L])^2)))
}

vcr_case("N76f", c("AC-08", "AC-30"), function() {
  # Review stats2 findings 3, 20, 21 and 6.
  # (3) One study without counts took the Greenland-Longnecker covariance away from all six (pooled slope -.008194 against the right -.004865). The right
  #     answer is written outside the engine: each study fitted by the package on its own (Greenland-Longnecker for five, independent for the one) and the
  #     slopes pooled by REML in metafor, a different package and a different route to the pool.
  # (21) A study with no counts on the REFERENCE row, or with zero cases on a level, was refused as 'the levels may be too few'; it runs as independent.
  # (20) A study left out of a spline must not place a knot: the knots are the type-7 percentiles of the doses of the studies that stay, and the fit equals
  #      the fit without that study.
  # (6) 'The first dose at which the interval leaves 1' was the first grid point whenever the slope was significant. Now: the dose is named when the
  #     interval starts including 1 and leaves it later (alcohol_crc, spline: between 24 and 36, and the first dose above the reference on the engine's
  #     grid where the interval leaves 1 by a closed-form pointwise interval written here), and not named, with the reason, when it has left at once.
  if (!requireNamespace("dosresmeta", quietly = TRUE) || !requireNamespace("metafor", quietly = TRUE)) return(list(pass = FALSE, detail = "error: dosresmeta or metafor is not installed (the run must not skip silently)"))
  cvd <- get(utils::data("alcohol_cvd", package = "dosresmeta", envir = environment())[1], envir = environment()); cvd$peryears <- cvd$n
  st <- .n76_studies(cvd)
  first <- st; for (j in seq_along(first[[1]]$rows)) { first[[1]]$rows[[j]]$cases <- NULL; first[[1]]$rows[[j]]$n <- NULL }
  r3 <- vcr_test_run(.n76_job(list(studies = first, model = list(kind = "linear")), "n76f1"))
  fits <- lapply(split(cvd, cvd$id), function(x) {
    f <- suppressWarnings(dosresmeta::dosresmeta(logrr ~ dose, id = id, type = type, se = se, cases = cases, n = n, data = x, covariance = if (x$id[1] == cvd$id[1]) "indep" else "gl", method = "fixed"))
    c(as.numeric(stats::coef(f)), as.numeric(stats::vcov(f)))
  })
  m <- metafor::rma(vapply(fits, `[`, numeric(1), 1L), vapply(fits, `[`, numeric(1), 2L), method = "REML")
  cf <- r3$diagnostics$doseResponse$coefficients[[1]]
  all6 <- vcr_test_run(.n76_job(list(studies = st, model = list(kind = "linear")), "n76f0"))$diagnostics$doseResponse$coefficients[[1]]$estimate
  mixed <- identical(r3$diagnostics$doseResponse$given$covariance, "mixed") && identical(unlist(r3$diagnostics$doseResponse$given$independentStudies), "1") &&
    abs(cf$estimate - stats::coef(m)[[1]]) < 2e-5 && abs(cf$se - m$se) < 2e-4 && abs(cf$estimate - all6) > 3e-4
  # (21)
  one <- st[1]; no_ref <- one; no_ref[[1]]$rows[[1]]$cases <- NULL
  zero <- one; zero[[1]]$rows[[2]]$cases <- 0
  indep <- vcr_test_run(.n76_job(list(studies = one, model = list(kind = "linear"), covariance = "indep"), "n76f2"))
  run21 <- lapply(list(no_ref, zero), function(s) vcr_test_run(.n76_job(list(studies = s, model = list(kind = "linear")), "n76f3")))
  ok21 <- all(vapply(run21, function(x) identical(x$status, "succeeded") && identical(x$diagnostics$doseResponse$given$covariance, "indep") &&
                       abs(x$diagnostics$doseResponse$coefficients[[1]]$estimate - indep$diagnostics$doseResponse$coefficients[[1]]$estimate) < 1e-12, logical(1)))
  # (20)
  crc <- get(utils::data("alcohol_crc", package = "dosresmeta", envir = environment())[1], envir = environment())
  tiny <- list(studyId = "tiny", type = "ir", rows = list(list(dose = 0, effect = 0, cases = 10, n = 1000), list(dose = 500, effect = 0.2, se = 0.3, cases = 14, n = 900)))
  sc20 <- list(model = list(kind = "spline", knotPercentiles = list(0.1, 0.5, 0.9)), referenceDose = 0)
  with_tiny <- vcr_test_run(.n76_job(c(list(studies = c(.n76_studies(crc), list(tiny))), sc20), "n76f4"))
  without <- vcr_test_run(.n76_job(c(list(studies = .n76_studies(crc)), sc20), "n76f5"))
  kn <- as.numeric(unlist(with_tiny$diagnostics$doseResponse$given$model$knots))
  ok20 <- identical(with_tiny$status, "succeeded") && max(abs(kn - as.numeric(stats::quantile(crc$dose, c(0.1, 0.5, 0.9), type = 7)))) < 1e-9 &&
    max(abs(vapply(with_tiny$diagnostics$doseResponse$coefficients, function(x) x$estimate, numeric(1)) - vapply(without$diagnostics$doseResponse$coefficients, function(x) x$estimate, numeric(1)))) < 1e-12
  # (6)
  coffee <- get(utils::data("coffee_mort", package = "dosresmeta", envir = environment())[1], envir = environment()); coffee$peryears <- coffee$n; coffee$se[coffee$se == 0] <- NA
  lin <- vcr_test_run(.n76_job(list(studies = .n76_studies(coffee), model = list(kind = "linear")), "n76f6"))$diagnostics$doseResponse
  sp <- vcr_test_run(.n76_job(list(studies = .n76_studies(crc), model = list(kind = "spline", knotPercentiles = list(0.05, 0.35, 0.65, 0.95)), referenceDose = 0), "n76f7"))$diagnostics$doseResponse
  b <- vapply(sp$coefficients, function(x) x$estimate, numeric(1)); V <- as.matrix(sp$covarianceOfCoefficients); knots <- as.numeric(unlist(sp$given$model$knots))
  grid <- seq(0, max(crc$dose), length.out = 200L)[-1L]; X <- .n76_rcs(grid, knots) - matrix(.n76_rcs(0, knots), length(grid), length(b), byrow = TRUE)
  est <- as.vector(X %*% b); se <- sqrt(rowSums((X %*% V) * X)); out <- which(est - stats::qnorm(0.975) * se > 0 | est + stats::qnorm(0.975) * se < 0)
  ok6 <- identical(lin$firstDoseKind, "at_once") && !is.finite(as.numeric(lin$firstDoseAwayFromReference %||% NA_real_)) && identical(sp$firstDoseKind, "threshold") &&
    abs(sp$firstDoseAwayFromReference - grid[min(out)]) < 1e-9 && sp$firstDoseAwayFromReference > 24 && sp$firstDoseAwayFromReference < 36 && min(out) > 1L
  list(pass = mixed && ok21 && ok20 && ok6,
       detail = sprintf("alcohol_cvd with the first study's counts removed: pooled slope %.6f (se %.6f) against the package-by-study fits pooled by metafor %.6f (%.6f) and %.6f with all six on their counts; a study with no counts on its reference row or zero cases on a level runs as independent (the slope of the independent fit, %.6f); a two-level study at dose 500 sets no knot (%s); first dose: coffee_mort linear, significant slope, none named (at once: %s); alcohol_crc spline: %.2f, the closed-form pointwise search gives %.2f [checks: mixed %s, independent %s, knots %s, first dose %s]",
                        cf$estimate, cf$se, stats::coef(m)[[1]], m$se, all6, indep$diagnostics$doseResponse$coefficients[[1]]$estimate, paste(round(kn, 3), collapse = ", "), identical(lin$firstDoseKind, "at_once"),
                        sp$firstDoseAwayFromReference, grid[min(out)], mixed, ok21, ok20, ok6))
})
