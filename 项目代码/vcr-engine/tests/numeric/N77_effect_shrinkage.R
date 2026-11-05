# N77 — evidence.shrinkage: the empirical shrinkage of a published effect (algorithm round E8, 2026-11-03).
#
# References that are not the method's own code: (1) the paper's own tables. van Zwet et al. (NEJM Evidence 2023;3(1)) print, for the Cochrane reference
# population, the quartiles of the exaggeration, the coverage of the usual 95% interval, the probability of the right sign and the probability of an
# exact replication, by the two-sided P value of the trial (their Tables 2 and 3: 2 coarse and 11 fine strata), computed by Monte Carlo from the mixture of
# their Table 1. Here the same quantities are INTEGRATED over each stratum by quadrature, using the engine's per-z functions and nothing else of the
# engine's, and held to the printed numbers. The paper prints two decimals and its mixture to two decimals as well, so the held tolerance is 0.015 on a
# probability and 2% on a quartile, and the worst difference is reported; (2) a one-component mixture, where every quantity is a closed form
# (the posterior of the ratio is normal; the folded normal's median is found with `uniroot` from the folded normal's own distribution function); (3) a direct
# numerical integral of the mixture posterior for the sign and the replication; (4) a replication of the same precision is `futureSe = se`.

.n77_job <- function(values, id, scale = "log", ...) vcr_test_job("evidence.shrinkage", c(list(scale = scale, values = values), list(...)), NULL, job_id = paste0("job_", id))

.n77_stratum <- function(plo, phi, mix, n = 600L) {
  zhi <- if (plo <= 0) 12 else stats::qnorm(1 - plo / 2); zlo <- stats::qnorm(1 - phi / 2)
  zs <- seq(zlo, zhi, length.out = n + 1L); zm <- (zs[-1L] + zs[-length(zs)]) / 2; dz <- diff(zs)
  f <- vapply(zm, function(x) sum(mix$pi * stats::dnorm(x, 0, sqrt(1 + mix$tau^2))), numeric(1))
  w <- 2 * f * dz; prop <- sum(w); w <- w / prop
  posts <- lapply(zm, vcr_shrink_posterior, mix = mix)
  Fe <- function(e) sum(w * mapply(function(z, p) { c <- z / e; 1 - sum(p$w * (stats::pnorm((c - p$m) / sqrt(p$v)) - stats::pnorm((-c - p$m) / sqrt(p$v)))) }, zm, posts))
  q <- vapply(c(0.25, 0.5, 0.75), function(pp) exp(stats::uniroot(function(le) Fe(exp(le)) - pp, c(-12, 12), tol = 1e-10)$root), numeric(1))
  cover <- sum(w * mapply(function(z, p) sum(p$w * (stats::pnorm((z + 1.96 - p$m) / sqrt(p$v)) - stats::pnorm((z - 1.96 - p$m) / sqrt(p$v)))), zm, posts))
  sign <- sum(w * mapply(function(z, p) sum(p$w * stats::pnorm(p$m / sqrt(p$v))), zm, posts))
  repl <- sum(w * mapply(function(z, p) sum(p$w * (1 - stats::pnorm((1.96 - p$m) / sqrt(p$v + 1)))), zm, posts))
  list(prop = prop, q = q, cover = cover, sign = sign, repl = repl)
}

vcr_case("N77a", c("AC-08", "AC-30"), function() {
  d <- vcr_domain()$vanZwet2023
  mix <- vcr_shrink_mixture()
  rows <- c(d$table2, d$table3)
  worst_p <- 0; worst_q <- 0
  for (row in rows) {
    s <- .n77_stratum(as.numeric(row$p[[1]]), as.numeric(row$p[[2]]), mix)
    want_q <- as.numeric(unlist(row$exaggeration))
    worst_p <- max(worst_p, abs(s$prop - row$proportion), abs(s$cover - row$coverage), abs(s$sign - row$correctSign), abs(s$repl - row$replicate))
    # a quartile is printed to two decimals: half a unit of the last digit and the paper's own Monte-Carlo error come first, 2% after
    worst_q <- max(worst_q, abs(s$q - want_q) / pmax(0.01, 0.02 * want_q))
  }
  list(pass = worst_p <= 0.015 && worst_q <= 1 && length(rows) == 13L,
       detail = sprintf("13 strata of the P value (Tables 2 and 3 of the paper), the share of trials, coverage, probability of the right sign and of replication: worst difference from the printed %.4f (tolerance 0.015); exaggeration quartiles: worst difference as a share of the tolerance (the larger of 0.01 and 2%% of the printed value) %.2f (at most 1)", worst_p, worst_q))
})

vcr_case("N77b", c("AC-08", "AC-30"), function() {
  # One component, closed forms. SNR ~ N(0, t2); z = SNR + N(0, 1); given z the ratio is N(B z, B), B = t2 / (1 + t2).
  t2 <- 4; B <- t2 / (1 + t2); mix <- list(pi = 1, tau = sqrt(t2))
  est <- 0.4; se <- 0.2; z <- est / se
  r <- vcr_shrink_one(est, se, level = 0.95, alpha = 0.05, future_se = 0.1, mix = mix)
  zq <- stats::qnorm(0.975)
  folded_med <- stats::uniroot(function(a) (stats::pnorm((a - B * z) / sqrt(B)) - stats::pnorm((-a - B * z) / sqrt(B))) - 0.5, c(0, 20), tol = 1e-12)$root
  want <- c(shrunken = est * B, lo = se * (B * z - zq * sqrt(B)), hi = se * (B * z + zq * sqrt(B)), sign = stats::pnorm(z * sqrt(B)),
            expo = z / folded_med, repl = 1 - stats::pnorm((zq - B * z) / sqrt(B + 1)), fut = 1 - stats::pnorm((zq - B * z * 2) / sqrt(B * 4 + 1)))
  got <- c(shrunken = r$shrunken, lo = r$interval[1], hi = r$interval[2], sign = r$correctSign, expo = r$exaggeration[2], repl = r$replication, fut = r$futureSuccess)
  # the mixture posterior integrated directly for the sign and the replication, on the four-component paper mixture at z = 2.2
  m4 <- vcr_shrink_mixture(); z4 <- 2.2
  p4 <- vcr_shrink_posterior(z4, m4)
  dens <- function(s) vapply(s, function(x) sum(p4$w * stats::dnorm(x, p4$m, sqrt(p4$v))), numeric(1))
  sign_int <- stats::integrate(dens, 0, Inf, rel.tol = 1e-11)$value
  repl_int <- stats::integrate(function(s) dens(s) * (1 - stats::pnorm(zq - s)), -80, 80, rel.tol = 1e-12, subdivisions = 4000L)$value
  r4 <- vcr_shrink_one(2.2 * 0.2, 0.2, mix = m4)
  d_int <- c(abs(r4$correctSign - sign_int), abs(r4$replication - repl_int))
  # a replication of the same precision is futureSe = se; the posterior weights sum to one
  r5 <- vcr_shrink_one(0.44, 0.2, future_se = 0.2, mix = m4)
  list(pass = max(abs(got - want)) < 1e-9 && max(d_int) < 1e-9 && abs(r5$futureSuccess - r5$replication) < 1e-14 && abs(sum(p4$w) - 1) < 1e-14,
       detail = sprintf("one component (tau^2 = 4): shrunken %.6f (closed form %.6f), interval %.5f to %.5f, sign %.6f, exaggeration median %.6f (folded-normal median by uniroot), replication %.6f, a trial of half the standard error %.6f: largest difference %.1e; four-component mixture at z = 2.2: sign %.6f and replication %.6f against the integral %.6f and %.6f (%.1e); futureSe = se is the replication",
                        got["shrunken"], want["shrunken"], got["lo"], got["hi"], got["sign"], got["expo"], got["repl"], got["fut"], max(abs(got - want)), r4$correctSign, r4$replication, sign_int, repl_int, max(d_int)))
})

vcr_case("N77c", c("AC-08", "AC-25"), function() {
  # Through the job: the numbers are the function's, the natural scale is the exponential, the person's value is carried unchanged beside the shrunken one,
  # a z of 0 has no direction and says so instead of printing a number, a stated level changes only the interval, and the same hash on 1 and 2 cores.
  vals <- list(list(id = "phase2", estimate = log(0.66), se = 0.19, futureSe = 0.12), list(id = "other", estimate = -0.25, se = 0.3))
  r <- vcr_test_run(.n77_job(vals, "n77c1"))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  rows <- r$diagnostics$shrinkage$rows
  direct <- vcr_shrink_one(log(0.66), 0.19, future_se = 0.12)
  a <- c(abs(rows[[1]]$shrunken - direct$shrunken), abs(rows[[1]]$shrunkenNatural - exp(direct$shrunken)), abs(rows[[1]]$natural - 0.66), abs(rows[[1]]$estimate - log(0.66)),
         abs(vcr_measure_value(r, "future_trial_success_probability") - direct$futureSuccess), abs(vcr_measure_value(r, "replication_probability") - direct$replication))
  zero <- vcr_test_run(.n77_job(list(list(id = "null", estimate = 0, se = 0.2)), "n77c2"))
  zr <- zero$diagnostics$shrinkage$rows[[1]]
  wide <- vcr_test_run(.n77_job(vals, "n77c1", level = 0.99))
  rr <- vcr_test_run(vcr_test_job("evidence.shrinkage", list(scale = "log", values = vals), NULL, job_id = "job_n77c1", cores = 2L))
  list(pass = max(a) < 1e-12 && length(vcr_validate_result(r)) == 0L && identical(zero$status, "succeeded") && isTRUE(zr$degenerate) && abs(zr$correctSign - 0.5) < 1e-15 && !is.null(zr$note) &&
        abs(wide$diagnostics$shrinkage$rows[[1]]$shrunken - rows[[1]]$shrunken) == 0 && wide$diagnostics$shrinkage$rows[[1]]$interval[2] > rows[[1]]$interval[2] &&
        identical(r$manifest$outputHash, rr$manifest$outputHash) && length(rows) == 2L,
       detail = sprintf("HR 0.66 (se of its log 0.19, z %.2f): shrunken HR %.3f (factor %.3f), probability of the right sign %.3f, median exaggeration %.2f, replication %.3f, a trial with se 0.12 %.3f; the stated value %.2f is carried unchanged; z = 0: degenerate and noted; level 0.99 widens only the interval; same hash on 1 and 2 cores",
                        rows[[1]]$z, rows[[1]]$shrunkenNatural, rows[[1]]$shrinkageFactor, rows[[1]]$correctSign, rows[[1]]$exaggerationMedian, rows[[1]]$replication, rows[[1]]$futureSuccess, rows[[1]]$natural))
})
