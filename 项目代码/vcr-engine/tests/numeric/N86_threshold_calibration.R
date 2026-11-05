# N86 — the calibration of a posterior-probability success threshold (algorithm round T10, 2026-11-03): design.bayesian, design.kind
# threshold_calibration.
#
# The success rule is "Pr(effect > margin | data) > c" under a conjugate prior. The job gives the type I error and power of a threshold the
# person states, the conventional 1 - alpha, and the threshold that makes the type I error the level asked for. Held to:
#
#   a  RBesT::oc2S (two beta-binomial arms, exact enumeration): the type I error and power of a stated threshold, for flat and informative
#      priors, a zero margin and a non-inferiority margin, equal to 1e-8
#   b  the posterior probability Pr(pT - pC > margin | xT, xC) against QUADPACK at 1e-12 (to 1e-9) and RBesT::pmixdiff, for random pairs of
#      counts and the pairs that make a posterior singular, margin 0 and -0.1, priors that are integer and not; the Gauss-Legendre nodes
#      integrate polynomials exactly
#   c  the calibrated threshold of the binary case: its type I error (by RBesT::oc2S) is at or below alpha, and the next lower distinct
#      posterior probability, used as the threshold, would exceed alpha: it is the smallest threshold that keeps the level
#   d  the normal case against a simulation of the estimate in plain R (2,000,000 draws): type I error and power at the stated, the
#      conventional and the calibrated threshold, with a flat and an informative prior, a difference of means and a hazard ratio from events;
#      the flat prior with the margin at the null calibrates to exactly 1 - alpha, and an optimistic prior to more

.n86_job <- function(design, endpoint, truth, alpha = 0.025) {
  vcr_test_run(vcr_test_job("design.bayesian", list(design = design, endpoint = list(type = endpoint), truth = truth, analysis = list(alpha = alpha)), seed = 8601L))
}
.n86_b <- function(r) r$diagnostics$bayesianDesign
.n86_row <- function(r, label) Filter(function(x) identical(x$label, label), .n86_b(r)$rows)[[1]]$cells

vcr_case("N86a", c("AC-30"), function() {
  if (!requireNamespace("RBesT", quietly = TRUE)) stop("N86 requires the locked RBesT library")
  worst <- 0; text <- character()
  for (setup in list(list(n = c(40, 40), margin = 0, pt = c(1, 1), pc = c(1, 1), c0 = 0.975, truth = c(0.3, 0.55)),
                     list(n = c(60, 45), margin = 0, pt = c(2, 3), pc = c(1, 1), c0 = 0.9, truth = c(0.25, 0.5)),
                     list(n = c(50, 50), margin = -0.1, pt = c(1, 1), pc = c(2, 3), c0 = 0.95, truth = c(0.4, 0.4)),
                     list(n = c(30, 70), margin = 0, pt = c(0.5, 0.5), pc = c(0.5, 0.5), c0 = 0.975, truth = c(0.2, 0.5)),
                     list(n = c(36, 30), margin = -0.1, pt = c(0.5, 0.5), pc = c(0.7, 1.4), c0 = 0.9, truth = c(0.3, 0.3)))) {
    # truth is (control rate, treatment rate)
    r <- .n86_job(list(kind = "threshold_calibration", nTreat = setup$n[1], nControl = setup$n[2], margin = setup$margin, threshold = setup$c0,
                       priorTreatment = list(a = setup$pt[1], b = setup$pt[2]), priorControl = list(a = setup$pc[1], b = setup$pc[2])),
                  "binary", list(controlRate = setup$truth[1], treatmentRate = setup$truth[2]))
    oc <- RBesT::oc2S(RBesT::mixbeta(c(1, setup$pt[1], setup$pt[2])), RBesT::mixbeta(c(1, setup$pc[1], setup$pc[2])), setup$n[1], setup$n[2],
                      RBesT::decision2S(setup$c0, setup$margin, lower.tail = FALSE))
    ref_t1 <- oc(setup$truth[1] + setup$margin, setup$truth[1]); ref_pw <- oc(setup$truth[2], setup$truth[1])
    got <- .n86_row(r, "stated")
    worst <- max(worst, abs(got$type_one_error$value - ref_t1), abs(got$power$value - ref_pw))
    text <- c(text, sprintf("n %d/%d margin %.1f threshold %.3f: type I %.6f vs %.6f, power %.6f vs %.6f", setup$n[1], setup$n[2], setup$margin, setup$c0, got$type_one_error$value, ref_t1, got$power$value, ref_pw))
  }
  list(pass = worst < 1e-8, detail = sprintf("%d settings, max|d| %.1e from RBesT::oc2S (its own integration is good to about 1e-9) in type I error and power; %s", length(text), worst, paste(text[1:2], collapse = "; ")))
})

vcr_case("N86b", c("AC-30"), function() {
  if (!requireNamespace("RBesT", quietly = TRUE)) stop("N86 requires the locked RBesT library")
  set.seed(8602); worst_pkg <- 0; worst_int <- 0; checked <- 0L
  exact <- function(xt, xc, nT, nC, pt, pc, margin) {
    f <- function(u) stats::dbeta(u, pt[1L] + xt, pt[2L] + nT - xt) * stats::pbeta(u - margin, pc[1L] + xc, pc[2L] + nC - xc)
    stats::integrate(f, max(0, margin), min(1, 1 + margin), rel.tol = 1e-12, subdivisions = 2000L)$value + (if (1 + margin < 1) 1 - stats::pbeta(1 + margin, pt[1L] + xt, pt[2L] + nT - xt) else 0)
  }
  for (margin in c(0, -0.1)) for (priors in list(list(c(1, 1), c(1, 1)), list(c(2, 3), c(1, 1)), list(c(0.5, 0.5), c(0.7, 1.4)))) {
    nT <- 35L; nC <- 28L
    post <- vcr_bd_binary_posterior(nT, nC, priors[[1]], priors[[2]], margin)
    # the counts that make a posterior singular (no response, all responses) are always among the pairs
    pairs <- rbind(cbind(sample(0:nT, 6, replace = TRUE), sample(0:nC, 6, replace = TRUE)), c(0L, 11L), c(nT, 12L), c(0L, nC), c(nT, 0L))
    for (i in seq_len(nrow(pairs))) {
      xt <- pairs[i, 1]; xc <- pairs[i, 2]
      ref <- RBesT::pmixdiff(RBesT::mixbeta(c(1, priors[[1]][1] + xt, priors[[1]][2] + nT - xt)), RBesT::mixbeta(c(1, priors[[2]][1] + xc, priors[[2]][2] + nC - xc)), margin, lower.tail = FALSE)
      worst_pkg <- max(worst_pkg, abs(post[xt + 1L, xc + 1L] - ref))
      worst_int <- max(worst_int, abs(post[xt + 1L, xc + 1L] - exact(xt, xc, nT, nC, priors[[1]], priors[[2]], margin)))
      checked <- checked + 1L
    }
  }
  gl <- vcr_gauss_legendre(12L); poly <- sum(gl$weights * gl$nodes^20) - 2 / 21
  list(pass = worst_pkg < 1e-5 && worst_int < 1e-9 && abs(poly) < 1e-13,
       detail = sprintf("%d pairs of counts (random ones and the ones that make a posterior singular), margins 0 and -0.1, three prior pairs (integer and not): max|d| %.1e from QUADPACK at 1e-12 and %.1e from RBesT::pmixdiff (which is itself good to about 5e-6 where a shape is below 1); 12 Gauss-Legendre nodes integrate x^20 over [-1, 1] to %.1e",
                        checked, worst_int, worst_pkg, abs(poly)))
})

vcr_case("N86c", c("AC-30"), function() {
  if (!requireNamespace("RBesT", quietly = TRUE)) stop("N86 requires the locked RBesT library")
  alpha <- 0.025; nT <- 45L; nC <- 45L
  r <- .n86_job(list(kind = "threshold_calibration", nTreat = nT, nControl = nC), "binary", list(controlRate = 0.3, treatmentRate = 0.55))
  cal <- .n86_row(r, "calibrated"); c_star <- cal$threshold$value
  oc <- function(c) RBesT::oc2S(RBesT::mixbeta(c(1, 1, 1)), RBesT::mixbeta(c(1, 1, 1)), nT, nC, RBesT::decision2S(c, 0, lower.tail = FALSE))(0.3, 0.3)
  post <- vcr_bd_binary_posterior(nT, nC, c(1, 1), c(1, 1), 0)
  values <- sort(unique(as.vector(post)), decreasing = TRUE)
  below <- max(values[values < c_star])
  list(pass = oc(c_star) <= alpha + 1e-12 && oc(below) > alpha && abs(oc(c_star) - cal$type_one_error$value) < 1e-10 && cal$type_one_error$value < alpha,
       detail = sprintf("45 against 45 patients, flat priors, alpha 0.025: calibrated threshold %.5f, type I error %.5f (RBesT %.5f), power %.4f; the next lower distinct posterior probability %.5f as the threshold gives %.5f > alpha: nothing smaller keeps the level (the conventional 0.975 gives %.5f)",
                        c_star, cal$type_one_error$value, oc(c_star), cal$power$value, below, oc(below), .n86_row(r, "conventional")$type_one_error$value))
})

vcr_case("N86d", c("AC-29", "AC-30"), function() {
  draws <- 2000000L; alpha <- 0.025; worst <- 0; text <- character()
  # a difference of means with known sd: sd 1, 100 per arm; and a hazard ratio from 200 events, 1:1 (the log hazard ratio has variance 4 / events)
  setups <- list(
    list(endpoint = "continuous", design = list(nTreat = 100, nControl = 100, threshold = 0.975), truth = list(sd = 1, effect = 0.4), se = sqrt(2 / 100), null = 0, alt = 0.4, margin = 0, m0 = 0, s0 = Inf),
    list(endpoint = "continuous", design = list(nTreat = 100, nControl = 100, threshold = 0.975, priorEffect = list(mean = 0.2, sd = 0.3)), truth = list(sd = 1, effect = 0.4), se = sqrt(2 / 100), null = 0, alt = 0.4, margin = 0, m0 = 0.2, s0 = 0.3),
    list(endpoint = "continuous", design = list(nTreat = 80, nControl = 120, margin = 0.1, threshold = 0.95, priorEffect = list(mean = -0.1, sd = 0.5)), truth = list(sd = 1.5, effect = 0.5), se = 1.5 * sqrt(1 / 80 + 1 / 120), null = 0.1, alt = 0.5, margin = 0.1, m0 = -0.1, s0 = 0.5),
    list(endpoint = "time_to_event", design = list(events = 200, margin = 1, threshold = 0.975, priorEffect = list(mean = log(0.85), sd = 0.25)), truth = list(hazardRatio = 0.7), se = sqrt(4 / 200), null = 0, alt = -log(0.7), margin = 0, m0 = -log(0.85), s0 = 0.25))
  for (i in seq_along(setups)) {
    s <- setups[[i]]
    r <- .n86_job(c(list(kind = "threshold_calibration"), s$design), s$endpoint, s$truth, alpha = alpha)
    prec_prior <- if (is.finite(s$s0)) 1 / s$s0^2 else 0; tau <- prec_prior + 1 / s$se^2
    rule <- function(est) { mu <- (s$m0 * prec_prior + est / s$se^2) / tau; stats::pnorm((mu - s$margin) * sqrt(tau)) }
    set.seed(8604 + i)
    z <- stats::rnorm(draws)
    p_null <- rule(s$null + s$se * z); p_alt <- rule(s$alt + s$se * z)
    for (label in c("stated", "conventional", "calibrated")) {
      if (!label %in% vapply(.n86_b(r)$rows, function(x) x$label, character(1))) next      # the stated threshold may be the conventional one
      cells <- .n86_row(r, label); c_ <- cells$threshold$value
      sim_t1 <- mean(p_null > c_); sim_pw <- mean(p_alt > c_)
      zt <- abs(sim_t1 - cells$type_one_error$value) / sqrt(max(sim_t1 * (1 - sim_t1), 1e-8) / draws); zp <- abs(sim_pw - cells$power$value) / sqrt(max(sim_pw * (1 - sim_pw), 1e-8) / draws)
      worst <- max(worst, zt, zp)
      if (identical(label, "calibrated")) text <- c(text, sprintf("%s %d: calibrated %.4f (type I %.4f, power %.3f; simulated %.4f)", if (identical(s$endpoint, "continuous")) "difference" else "hazard ratio", i, c_, cells$type_one_error$value, cells$power$value, sim_t1))
    }
  }
  flat <- .n86_row(.n86_job(list(kind = "threshold_calibration", nTreat = 100, nControl = 100), "continuous", list(sd = 1, effect = 0.4), alpha = alpha), "calibrated")$threshold$value
  optimistic <- .n86_row(.n86_job(list(kind = "threshold_calibration", nTreat = 100, nControl = 100, priorEffect = list(mean = 0.2, sd = 0.3)), "continuous", list(sd = 1, effect = 0.4), alpha = alpha), "calibrated")$threshold$value
  list(pass = worst < 4 && abs(flat - (1 - alpha)) < 1e-12 && optimistic > flat,
       detail = sprintf("%s; worst %.2f errors over %d simulated estimates; flat prior and the margin at the null calibrate to %.6f = 1 - alpha, an optimistic prior (mean 0.2, sd 0.3) to %.4f", paste(text, collapse = "; "), worst, draws, flat, optimistic))
})
