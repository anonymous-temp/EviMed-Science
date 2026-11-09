# N85 — predictive-probability monitoring (algorithm round T8, 2026-11-03): design.bayesian, design.kind predictive_monitoring (Lee & Liu 2008).
#
# At a look the predictive probability is the chance that the final analysis would succeed if the trial went on: the sum, over the responses
# still to come, of their beta-binomial probability times "the final posterior probability would reach the threshold". The trial stops for
# futility below one cut-off and, if asked, for efficacy above another; the final analysis succeeds when Pr(p > p0 | data) >= theta. Held to:
#
#   a  the predictive probability of every (look, responses) pair against a numerical integration of the binomial probability of the
#      remaining responses over the posterior of p (no beta-binomial formula in the check)
#   b  a brute-force enumeration of every response sequence of a 12-patient trial, each look judged by the predictive probability computed
#      from first principles: type I error, power, expected size, the stop probabilities
#   c  a simulation of the whole rule in plain R (200,000 trials of 40 patients, a look every 10): type I error, power and expected size
#   d  the final threshold is an interval: any theta in (Pr after s - 1 responses, Pr after s responses] gives the rule "succeed at s or more",
#      and the result states that interval; a threshold just outside it gives the neighbouring rule
#   e  the search keeps alpha and, whatever objective, no neighbouring final rule does better by that objective

.n85_job <- function(design, truth = list(nullRate = 0.1, alternativeRate = 0.3), analysis = list(alpha = 0.05, power = 0.8)) {
  vcr_test_run(vcr_test_job("design.bayesian", list(design = design, truth = truth, analysis = analysis), seed = 8501L))
}
.n85_b <- function(r) r$diagnostics$bayesianDesign
.n85_op <- function(r, role) Filter(function(x) identical(x$role, role), .n85_b(r)$operating)[[1]]

#' The predictive probability by integration: sum over y of  integral dbinom(y, m, p) dbeta(p; a + x, b + n - x) dp  for the y that succeed.
.n85_predictive <- function(x, n, N, a, b, s) {
  m <- N - n
  vapply(max(0, s - x):m, function(y) stats::integrate(function(p) stats::dbinom(y, m, p) * stats::dbeta(p, a + x, b + n - x), 0, 1, rel.tol = 1e-10)$value, numeric(1))
}

vcr_case("N85a", c("AC-30"), function() {
  a <- 0.1; b <- 0.9; N <- 40L; s <- 8L; worst <- 0; checked <- 0L
  for (n in c(10L, 20L, 30L)) {
    tail_ <- .vcr_bd_predictive_tail(a, b, n, N - n)
    for (x in 0:n) {
      need <- min(max(s - x, 0L), N - n + 1L)
      mine <- tail_[x + 1L, need + 1L]
      ref <- if (need > N - n) 0 else sum(.n85_predictive(x, n, N, a, b, s))
      worst <- max(worst, abs(mine - ref)); checked <- checked + 1L
    }
  }
  list(pass = worst < 1e-8, detail = sprintf("%d (look, responses) pairs for 40 patients and 8 responses to succeed, prior Beta(0.1, 0.9): max|d| %.1e from the integral of the binomial over the posterior (the beta-binomial tail the engine uses)", checked, worst))
})

.n85_enumerate <- function(p, looks, a, b, p0, theta, futility, efficacy) {
  N <- looks[length(looks)]; L <- length(looks)
  s <- min(which(1 - stats::pbeta(p0, a + 0:N, b + N - 0:N) >= theta) - 1L, N + 1L)
  succ <- 0; fut <- 0; en <- 0
  for (code in 0:(2^N - 1)) {
    bits <- bitwAnd(bitwShiftR(code, 0:(N - 1)), 1L)
    w <- prod(ifelse(bits == 1L, p, 1 - p))
    outcome <- NULL
    for (i in seq_len(L)) {
      n <- looks[i]; x <- sum(bits[seq_len(n)])
      if (i == L) { outcome <- if (x >= s) "success" else "fail"; break }
      m <- N - n
      pp <- sum(vapply(max(0, s - x):m, function(y) if (y > m) 0 else exp(lchoose(m, y) + lbeta(y + a + x, m - y + b + n - x) - lbeta(a + x, b + n - x)), numeric(1)))
      if (s - x > m) pp <- 0
      if (pp < futility) { outcome <- "futility"; break }
      if (!is.null(efficacy) && pp > efficacy) { outcome <- "efficacy"; break }
    }
    en <- en + w * looks[i]
    if (outcome %in% c("success", "efficacy")) succ <- succ + w else if (outcome == "futility") fut <- fut + w
  }
  list(success = succ, futility = fut, expectedN = en)
}

vcr_case("N85b", c("AC-30"), function() {
  looks <- c(4L, 8L, 12L); worst <- 0; text <- character()
  for (setup in list(list(theta = 0.9, futility = 0.05, efficacy = NULL), list(theta = 0.8, futility = 0.1, efficacy = 0.95), list(theta = 0.95, futility = 0.02, efficacy = 0.99))) {
    design <- list(kind = "predictive_monitoring", maxN = 12, lookEvery = 4, predictive = c(list(final = setup$theta, futility = setup$futility), if (!is.null(setup$efficacy)) list(efficacy = setup$efficacy)))
    r <- .n85_job(design, truth = list(nullRate = 0.2, alternativeRate = 0.5))
    for (role in c("null", "alternative")) {
      p <- if (identical(role, "null")) 0.2 else 0.5
      ref <- .n85_enumerate(p, looks, 0.2, 0.8, 0.2, setup$theta, setup$futility, setup$efficacy)
      op <- .n85_op(r, role)$cells
      got <- c(op[[if (identical(role, "null")) "type_one_error" else "power"]]$value, op$expected_sample_size$value, op$futility_stop_probability$value)
      worst <- max(worst, abs(got - c(ref$success, ref$expectedN, ref$futility)))
    }
    text <- c(text, sprintf("theta %.2f, futility %.2f%s: type I %.4f, power %.4f", setup$theta, setup$futility, if (is.null(setup$efficacy)) "" else sprintf(", efficacy %.2f", setup$efficacy),
                            .n85_op(r, "null")$cells$type_one_error$value, .n85_op(r, "alternative")$cells$power$value))
  }
  list(pass = worst < 1e-10, detail = sprintf("3 designs (with and without an efficacy stop) on all 4096 response sequences of a 12-patient trial, 0.2 against 0.5: max|d| %.1e in type I error, power, expected size and the futility-stop probability (%s)", worst, paste(text, collapse = "; ")))
})

vcr_case("N85c", c("AC-29"), function() {
  p0 <- 0.1; p1 <- 0.3; N <- 40L; looks <- c(10L, 20L, 30L, 40L); a <- p0; b <- 1 - p0; theta <- 0.9; futility <- 0.05; efficacy <- 0.99; trials <- 200000L
  r <- .n85_job(list(kind = "predictive_monitoring", maxN = N, lookEvery = 10, predictive = list(final = theta, futility = futility, efficacy = efficacy)), truth = list(nullRate = p0, alternativeRate = p1))
  s <- min(which(1 - stats::pbeta(p0, a + 0:N, b + N - 0:N) >= theta) - 1L)
  # the rule as a table of decisions by (look, responses), computed here with dbetabinom from the definition
  decision <- lapply(looks[-length(looks)], function(n) vapply(0:n, function(x) {
    m <- N - n; ys <- if (s - x > m) integer(0) else max(0, s - x):m
    pp <- if (!length(ys)) 0 else sum(exp(lchoose(m, ys) + lbeta(ys + a + x, m - ys + b + n - x) - lbeta(a + x, b + n - x)))
    if (pp < futility) -1L else if (pp > efficacy) 1L else 0L
  }, integer(1)))
  one <- function(p) {
    set.seed(8503, kind = "L'Ecuyer-CMRG")
    inc <- matrix(stats::rbinom(trials * 4L, 10L, p), nrow = trials)
    x <- t(apply(inc, 1L, cumsum))
    alive <- rep(TRUE, trials); size <- rep(N, trials); success <- rep(FALSE, trials)
    for (i in 1:3) {
      d <- decision[[i]][x[, i] + 1L]
      hit <- alive & d != 0L
      success[hit & d == 1L] <- TRUE; size[hit] <- looks[i]; alive <- alive & !hit
    }
    success[alive] <- x[alive, 4L] >= s
    c(rate = mean(success), size = mean(size), se_rate = sqrt(mean(success) * (1 - mean(success)) / trials), se_size = stats::sd(size) / sqrt(trials))
  }
  n0 <- one(p0); n1 <- one(p1)
  m0 <- .n85_op(r, "null")$cells; m1 <- .n85_op(r, "alternative")$cells
  z <- c(abs(n0["rate"] - m0$type_one_error$value) / n0["se_rate"], abs(n1["rate"] - m1$power$value) / n1["se_rate"], abs(n0["size"] - m0$expected_sample_size$value) / n0["se_size"], abs(n1["size"] - m1$expected_sample_size$value) / n1["se_size"])
  list(pass = max(z) < 4, detail = sprintf("final theta 0.90 (%d responses of 40), futility 0.05, efficacy 0.99, a look every 10, 0.1 against 0.3: type I %.4f vs simulated %.4f, power %.4f vs %.4f, expected size %.2f/%.2f vs %.2f/%.2f (%d trials; worst %.2f errors)",
                                          s, m0$type_one_error$value, n0["rate"], m1$power$value, n1["rate"], m0$expected_sample_size$value, m1$expected_sample_size$value, n0["size"], n1["size"], trials, max(z)))
})

vcr_case("N85d", c("AC-30"), function() {
  search <- .n85_job(list(kind = "predictive_monitoring", maxN = 40, lookEvery = 10))
  p <- .n85_b(search)$parameters
  s <- p$successResponses; low <- p$finalThresholdAbove; high <- p$finalThresholdAtMost
  at <- function(theta) { r <- .n85_job(list(kind = "predictive_monitoring", maxN = 40, lookEvery = 10, predictive = list(final = theta))); c(.n85_b(r)$parameters$successResponses, .n85_op(r, "null")$cells$type_one_error$value, .n85_op(r, "alternative")$cells$power$value) }
  inside <- list(at(low + 1e-9), at((low + high) / 2), at(high - 1e-9)); outside_low <- at(low - 1e-9); outside_high <- at(high + 1e-9)
  same <- all(vapply(inside, function(x) x[1] == s && abs(x[2] - .n85_op(search, "null")$cells$type_one_error$value) < 1e-12 && abs(x[3] - .n85_op(search, "alternative")$cells$power$value) < 1e-12, logical(1)))
  list(pass = same && outside_low[1] == s - 1 && outside_high[1] == s + 1 && low < high,
       detail = sprintf("the search ends on %d responses of 40; the thresholds in (%.4f, %.4f] give that rule at the three points tested (both ends, to 1e-9, and the middle) (type I %.4f, power %.4f), just below the interval the rule is %d responses, just above it %d", s, low, high,
                        .n85_op(search, "null")$cells$type_one_error$value, .n85_op(search, "alternative")$cells$power$value, as.integer(outside_low[1]), as.integer(outside_high[1])))
})

vcr_case("N85e", c("AC-30"), function() {
  alpha <- 0.05; target <- 0.8
  by_power <- .n85_job(list(kind = "predictive_monitoring", maxN = 40, lookEvery = 10, objective = "max_power"), analysis = list(alpha = alpha, power = target))
  by_size <- .n85_job(list(kind = "predictive_monitoring", maxN = 40, lookEvery = 10, objective = "min_expected_n"), analysis = list(alpha = alpha, power = target))
  s <- .n85_b(by_power)$parameters$successResponses
  around <- lapply(setdiff(s + (-2:2), s), function(k) {
    theta <- stats::pbeta(0.1, 0.1 + max(k, 0), 0.9 + 40 - max(k, 0), lower.tail = FALSE) - 1e-9
    r <- .n85_job(list(kind = "predictive_monitoring", maxN = 40, lookEvery = 10, predictive = list(final = theta)))
    c(k = .n85_b(r)$parameters$successResponses, t1 = .n85_op(r, "null")$cells$type_one_error$value, pw = .n85_op(r, "alternative")$cells$power$value, en0 = .n85_op(r, "null")$cells$expected_sample_size$value)
  })
  mp <- .n85_op(by_power, "alternative")$cells$power$value; mt <- .n85_op(by_power, "null")$cells$type_one_error$value
  no_better_power <- all(vapply(around, function(x) !(x[["t1"]] <= alpha + 1e-12 && x[["pw"]] > mp + 1e-12), logical(1)))
  sp <- .n85_op(by_size, "alternative")$cells$power$value; se0 <- .n85_op(by_size, "null")$cells$expected_sample_size$value
  no_fewer <- all(vapply(around, function(x) !(x[["t1"]] <= alpha + 1e-12 && x[["pw"]] >= target - 1e-12 && x[["en0"]] < se0 - 1e-12), logical(1)))
  list(pass = mt <= alpha + 1e-12 && no_better_power && sp >= target - 1e-12 && no_fewer && !is.null(.n85_b(by_size)$baselines$simon),
       detail = sprintf("max-power search: %d responses, type I %.4f, power %.4f; the four neighbouring final rules do not beat it by power while keeping alpha; fewest-patients search: power %.4f >= %.2f with %.2f expected patients under the null, and no neighbouring rule has fewer at that power", s, mt, mp, sp, target, se0))
})
