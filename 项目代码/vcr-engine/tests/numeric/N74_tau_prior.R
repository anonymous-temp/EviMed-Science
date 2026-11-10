# N74 — evidence.pool 1.1.0: an informative prior for the between-study heterogeneity (algorithm round E7, 2026-11-03).
#
# References that are not the method's own code: `bayesmeta` (a Bayesian random-effects meta-analysis integrating the same posterior with its own
# adaptive scheme, accuracy 1e-5) for the posterior mean, the credible interval, the posterior median of tau, with a log-normal prior on
# tau-squared (Turner's), an inverse-gamma prior on tau (Bartos's) and a half-normal prior on tau; a closed form for the limits (a prior
# that puts all its mass near zero is the fixed-effect pooling, whose estimate and standard error are written out here; one study leaves
# tau at its prior, and the prediction interval is a one-dimensional integral solved with `integrate` and `uniroot`); and the tables of the two papers
# as printed: the medians and the odds-ratio ranges Turner et al. (2015) quote from their Table IV, and the worked settings of their two examples.

.n74_job <- function(studies, prior, id, scale = "identity", method = "random_effects_reml") {
  vcr_test_job("evidence.pool", list(studies = studies, method = method, scale = scale, tauPrior = prior), NULL, job_id = paste0("job_", id))
}
.n74_studies <- function(y, s) lapply(seq_along(y), function(i) list(studyId = paste0("s", i), estimate = y[i], se = s[i]))

vcr_case("N74a", c("AC-08", "AC-30"), function() {
  # bayesmeta, accuracy 1e-5: two studies with Turner's log-normal prior (the ticlopidine setting of their first example), four studies with
  # Bartos's inverse-gamma prior for the log odds ratio, two studies with a half-normal prior
  if (!requireNamespace("bayesmeta", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the cross-check package bayesmeta is not installed (the run must not skip silently)"))
  suppressMessages(library(bayesmeta))
  y <- c(-0.5, -0.1, -0.35, 0.05); s <- c(0.2, 0.25, 0.3, 0.22)
  one <- function(yy, ss, engine_prior, bm_prior, tag) {
    r <- vcr_test_run(.n74_job(.n74_studies(yy, ss), engine_prior, tag))
    pe <- vcr_get_measure(r, "pooled_estimate"); pr <- vcr_get_measure(r, "prediction_interval"); ta <- vcr_get_measure(r, "tau")
    bm <- suppressWarnings(bayesmeta(y = yy, sigma = ss, tau.prior = bm_prior, delta = 1e-5, epsilon = 1e-5))
    mu_ci <- bm$qposterior(mu.p = c(0.025, 0.975)); th_ci <- bm$post.interval(theta.level = 0.95)
    d <- c(mean = abs(pe$value - bm$summary["mean", "mu"]), lo = abs(pe$interval$low - mu_ci[1]), hi = abs(pe$interval$high - mu_ci[2]),
           tau = abs(ta$value - bm$qposterior(tau.p = 0.5)))
    c(ok = identical(r$status, "succeeded") && length(vcr_validate_result(r)) == 0L && identical(pe$interval$kind, "credible") && identical(pr$interval$kind, "prediction") && max(d) < 6e-5,
      d, kind = r$diagnostics$tauPrior$kind)
  }
  ln <- function(t) { v <- dlnorm(t^2, -3.95, 1.79) * 2 * t; v[!is.finite(v)] <- 0; v }
  ig <- function(t) 0.55^1.77 / gamma(1.77) * t^(-1.77 - 1) * exp(-0.55 / t)
  hn <- function(t) dnorm(t, 0, 0.1) * 2
  a <- one(y[1:2], s[1:2], list(kind = "log_normal", meanLog = -3.95, sdLog = 1.79), ln, "n74a1")
  b <- one(y, s, list(kind = "bartos_2023", effectScale = "log_odds_ratio"), ig, "n74a2")
  c3 <- one(y[1:2], s[1:2], list(kind = "half_normal", scale = 0.1), hn, "n74a3")
  list(pass = all(vapply(list(a, b, c3), function(x) isTRUE(as.logical(x[["ok"]])), logical(1))),
       detail = sprintf("largest differences from bayesmeta (mean, 95%% limits, median tau): log-normal k=2 %.1e; inverse-gamma k=4 %.1e; half-normal k=2 %.1e (tolerance 6e-5)",
                        max(as.numeric(a[2:5])), max(as.numeric(b[2:5])), max(as.numeric(c3[2:5]))))
})

vcr_case("N74b", c("AC-08", "AC-30"), function() {
  # Limits in closed form. (1) A prior with all its mass near zero is the fixed-effect pooling: estimate sum(w y)/sum(w), standard error 1/sqrt(sum w),
  # prediction variance se^2 + tau^2 -> se^2. (2) One study: tau stays at its prior, and the prediction interval is the integral over that prior of a
  # normal with variance v + 2 tau^2 (the pooled effect has the study's variance v + tau^2 and a new study adds tau^2).
  y <- c(-0.5, -0.1, -0.35); s <- c(0.2, 0.25, 0.3)
  w <- 1 / s^2; fe <- sum(w * y) / sum(w); se <- 1 / sqrt(sum(w))
  r <- vcr_test_run(.n74_job(.n74_studies(y, s), list(kind = "log_normal", meanLog = -20, sdLog = 0.1), "n74b1"))
  pe <- vcr_get_measure(r, "pooled_estimate"); pr <- vcr_get_measure(r, "prediction_interval")
  z <- stats::qnorm(0.975)
  d1 <- c(abs(pe$value - fe), abs(pe$interval$low - (fe - z * se)), abs(pe$interval$high - (fe + z * se)), abs(pr$interval$low - (fe - z * se)), abs(pr$interval$high - (fe + z * se)))
  # one study, log-normal(-3, 1) prior on tau^2: P(theta_new <= q) = int Phi((q - y) / sqrt(v + 2 tau^2)) f(tau) dtau
  y1 <- -0.4; v1 <- 0.15^2; m <- -3; sg <- 1
  r1 <- vcr_test_run(.n74_job(.n74_studies(y1, sqrt(v1)), list(kind = "log_normal", meanLog = m, sdLog = sg), "n74b2"))
  pr1 <- vcr_get_measure(r1, "prediction_interval")
  cdf <- function(q) stats::integrate(function(u) stats::pnorm((q - y1) / sqrt(v1 + 2 * u)) * stats::dlnorm(u, m, sg), 0, Inf, rel.tol = 1e-10, subdivisions = 2000L)$value
  lo <- stats::uniroot(function(q) cdf(q) - 0.025, c(-5, 5), tol = 1e-10)$root
  hi <- stats::uniroot(function(q) cdf(q) - 0.975, c(-5, 5), tol = 1e-10)$root
  d2 <- c(abs(pr1$interval$low - lo), abs(pr1$interval$high - hi))
  tauq <- vcr_get_measure(r1, "tau")
  want_tau <- sqrt(exp(m))   # the posterior of tau is the prior's: its median
  list(pass = max(d1) < 2e-6 && max(d2) < 2e-5 && abs(tauq$value - want_tau) < 1e-3 && isTRUE(r1$diagnostics$tauPrior$onlyOneStudy),
       detail = sprintf("mass at zero = fixed effect: max difference %.1e (estimate %.6f, se %.6f); one study: prediction limits %.5f, %.5f vs the integral %.5f, %.5f; posterior median tau %.5f vs the prior's %.5f",
                        max(d1), pe$value, se, pr1$interval$low, pr1$interval$high, lo, hi, tauq$value, want_tau))
})

vcr_case("N74c", c("AC-08", "AC-25"), function() {
  # The tables as printed. Turner et al. (2015): the median of tau-squared quoted for three settings (0.019, 0.12, 0.17) and the odds-ratio range they
  # compute from it (0.76-1.31, 0.51-1.97, 0.45-2.24); the prior of their two worked examples, and the generic one. Bartos et al. (2023): the four general
  # priors. Each is read back through the engine's own lookup (the snapshot of the domain), so the table the person's job names is the table checked.
  d <- vcr_domain()$heterogeneityPriors$turner2015
  cell <- function(o, c) as.numeric(unlist(d$priors[[o]][[c]]))
  med <- function(o) exp(cell(o, "pharmacological_vs_placebo")[1])
  want <- list(all_cause_mortality = c(0.019, 0.76, 1.31), surgical_device_success = c(0.12, 0.51, 1.97), biological_markers = c(0.17, 0.45, 2.24))
  rows <- vapply(names(want), function(o) {
    m <- med(o); w <- want[[o]]
    c(abs(round(m, 3) - w[1]) < 0.0006 + (w[1] >= 0.1) * 0.005, abs(round(exp(-1.96 * sqrt(round(m, if (w[1] < 0.1) 3 else 2))), 2) - w[2]) < 0.006, abs(round(exp(1.96 * sqrt(round(m, if (w[1] < 0.1) 3 else 2))), 2) - w[3]) < 0.006)
  }, numeric(3))
  ex <- all(abs(cell("cause_specific_mortality_or_morbidity", "pharmacological_vs_pharmacological") - c(-3.95, 1.79)) < 1e-12,
            abs(cell("withdrawals", "non_pharmacological_vs_placebo") - c(-3.21, 1.91)) < 1e-12, abs(as.numeric(unlist(d$generic)) - c(-2.56, 1.74)) < 1e-12)
  b <- vcr_domain()$heterogeneityPriors$bartos2023$priors
  bart <- b$log_odds_ratio$shape == 1.77 && b$log_odds_ratio$scale == 0.55 && b$log_risk_ratio$shape == 1.51 && b$log_risk_ratio$scale == 0.23 &&
    b$log_hazard_ratio$shape == 2.42 && b$log_hazard_ratio$scale == 0.30 && identical(b$risk_difference$kind, "half_normal") && b$risk_difference$scale == 0.10
  # and the engine resolves a named setting to exactly that prior
  pr <- vcr_tau_prior_resolve(list(kind = "turner_2015", outcome = "withdrawals", comparison = "non_pharmacological_vs_placebo"))
  res <- identical(pr$params$meanLog, -3.21) && identical(pr$params$sdLog, 1.91)
  bad <- inherits(try(vcr_tau_prior_resolve(list(kind = "turner_2015", outcome = "nonsense", comparison = "pain")), silent = TRUE), "try-error")
  list(pass = all(rows == 1) && ex && bart && res && bad,
       detail = sprintf("Turner Table IV medians and odds-ratio ranges (3 settings x 3 numbers) match the paper: %s; the two examples' priors and the generic one: %s; Bartos general priors: %s; lookup by id: %s; an unknown id is refused: %s",
                        all(rows == 1), ex, bart, res, bad))
})

vcr_case("N74d", c("AC-08", "AC-30"), function() {
  # Two studies get a prediction interval (the frequentist route has none), the frequentist pooling is kept beside the Bayesian one, a pooling without a prior is
  # exactly what it was, the grid is converged, and the same seed gives the same bytes on any core count.
  y <- c(-0.5, -0.1); s <- c(0.2, 0.25)
  prior <- list(kind = "turner_2015", outcome = "all_cause_mortality", comparison = "pharmacological_vs_placebo")
  r <- vcr_test_run(.n74_job(.n74_studies(y, s), prior, "n74d1"))
  r0 <- vcr_test_run(vcr_test_job("evidence.pool", list(studies = .n74_studies(y, s), method = "random_effects_reml", scale = "identity"), NULL, job_id = "job_n74d0"))
  has_fr_pi <- !is.null(vcr_get_measure(r0, "prediction_interval"))
  ci <- vcr_get_measure(r, "pooled_estimate")$interval; pi <- vcr_get_measure(r, "prediction_interval")$interval
  direct <- vcr_pool(y, s^2, "random_effects_reml", 0.95)
  same_without <- abs(vcr_measure_value(r0, "pooled_estimate") - direct$estimate) == 0 && abs(vcr_get_measure(r0, "pooled_estimate")$interval$low - direct$interval[1]) == 0
  fr <- r$diagnostics$frequentist
  keeps <- abs(fr$estimate - direct$estimate) == 0 && abs(fr$tau2 - direct$tau2) == 0 && !isTRUE(fr$predictionIntervalAvailable)
  pr <- vcr_tau_prior_resolve(prior)
  g1 <- vcr_pool_bayes(y, s^2, pr, 0.95, nodes = 2001L); g2 <- vcr_pool_bayes(y, s^2, pr, 0.95, nodes = 8001L)
  conv <- max(abs(c(g1$estimate - g2$estimate, g1$interval - g2$interval, g1$predictionInterval - g2$predictionInterval, g1$tau - g2$tau)))
  rr <- vcr_test_run(vcr_test_job("evidence.pool", list(studies = .n74_studies(y, s), method = "random_effects_reml", scale = "identity", tauPrior = prior), NULL, job_id = "job_n74d1", cores = 2L))
  same_bytes <- identical(r$manifest$outputHash, rr$manifest$outputHash)
  dist <- r$diagnostics$distribution
  # a version label that predates the prior refuses it
  old <- vcr_test_job("evidence.pool", list(studies = .n74_studies(y, s), tauPrior = prior), NULL, job_id = "job_n74d9", extra = list(methodVersion = "1.0.0"))
  codes <- vcr_test_issue_codes(vcr_test_run(old))
  list(pass = !has_fr_pi && pi$low < ci$low && pi$high > ci$high && same_without && keeps && conv < 1e-7 && same_bytes && identical(dist$basis, "prediction") && "method_version_mismatch" %in% codes,
       detail = sprintf("k = 2: no frequentist prediction interval (%s), Bayesian prediction interval %.4f to %.4f outside the credible interval %.4f to %.4f; no prior = unchanged to the bit (%s); frequentist kept (%s); grid 2001 vs 8001 nodes differ by %.1e; same hash on 1 and 2 cores (%s); a 1.0.0 label with a prior is refused (%s)",
                        !has_fr_pi, pi$low, pi$high, ci$low, ci$high, same_without, keeps, conv, same_bytes, "method_version_mismatch" %in% codes))
})

vcr_case("N74e", c("AC-08", "AC-30"), function() {
  # I-squared compares Q with its degrees of freedom; one study has none. Q is 0 up to rounding there (1e-31 for an estimate of -0.4 and a standard error of
  # 0.2, exactly 0 for -0.37), and the ratio read 100% for the first and 0% for the second. It is not reported for one study, with or without a prior for tau,
  # and it is reported (and is the usual Higgins-Thompson value) for three.
  one <- function(y, prior = NULL, id) vcr_test_run(vcr_test_job("evidence.pool", c(list(studies = .n74_studies(y, 0.2), method = "random_effects_reml", scale = "identity"), if (!is.null(prior)) list(tauPrior = prior)), NULL, job_id = id))
  has <- function(r) any(vapply(r$measures, function(m) identical(m$name, "i_squared"), logical(1)))
  a <- one(-0.4, id = "job_n74e1"); b <- one(-0.37, id = "job_n74e2"); c1 <- one(-0.4, list(kind = "half_normal", scale = 0.2), "job_n74e3")
  three <- vcr_test_run(vcr_test_job("evidence.pool", list(studies = .n74_studies(c(-0.5, -0.1, -0.3), c(0.1, 0.1, 0.1)), method = "random_effects_reml", scale = "identity"), NULL, job_id = "job_n74e4"))
  q <- (c(-0.5, -0.1, -0.3) - mean(c(-0.5, -0.1, -0.3)))^2 / 0.01; Q <- sum(q); want <- max(0, (Q - 2) / Q)
  ok <- c(one_study = identical(a$status, "succeeded") && !has(a) && !has(b) && !has(c1), valid = length(vcr_validate_result(a)) == 0L && length(vcr_validate_result(c1)) == 0L,
          k = vcr_measure_value(a, "k") == 1, three = has(three) && abs(vcr_measure_value(three, "i_squared") - want) < 1e-9)
  list(pass = all(ok), detail = sprintf("one study (estimate -0.4 and -0.37, standard error 0.2; and with a half-normal prior on tau): no I-squared is reported (it read 1.0 and 0); three studies: %.4f = (Q - df) / Q = %.4f%s",
                                        vcr_measure_value(three, "i_squared"), want, if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})
