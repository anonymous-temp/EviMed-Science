# ---------------------------------------------------------------------------
# design_bayesian.R — Bayesian designs without MCMC (algorithm round T8, T10, 2026-11-03): `design.bayesian`.
#
# One method, three `design.kind`s, every number exact (conjugate beta-binomial and normal; no simulation, so no Monte-Carlo error):
#
#   bop2                    "单臂每 10 人看一次，何时停，比 Simon 少多少人"  Bayesian optimal phase II (Zhou, Lee & Yuan 2017): stop at a look when
#                           Pr(p > p0 | data) < lambda (n / N)^gamma, succeed at the end when Pr(p > p0 | data) >= lambda; (lambda, gamma) are
#                           found by a grid search, or stated
#   predictive_monitoring   Lee & Liu 2008: stop at a look when the predictive probability that the final analysis would succeed is
#                           below a futility threshold (or above an efficacy one); the final analysis succeeds when Pr(p > p0 | data) >= theta
#   threshold_calibration   "用这个先验和阈值，I 类错误多少，校到 0.025 阈值是多少"  the success rule Pr(effect > margin | data) > c under a stated
#                           conjugate prior: its type I error and power, and the c that makes the type I error the stated level
#
# Hidden knowledge:
#
# - **Exact means enumerated.** A phase II look is a count of responses; between looks the count grows by a binomial. The operating
#   characteristics of a boundary rule are a dynamic programme over (look, responses) -- the same kind of sum as Simon's, and as cheap.
#   Nothing here draws a random number. The cases check it against a simulation written separately, against BOP2FE's boundaries, against
#   Simon's published design and against a brute-force enumeration of every path of a small trial.
# - **A boundary rule is a vector of integers.** Pr(p > p0 | x, n) rises with x, so "stop when it is below C" is "stop when x <= r(n)" and
#   "succeed when it is at least lambda" is "succeed when x >= s". The search over (lambda, gamma) therefore needs the operating
#   characteristics only once per DISTINCT vector, and with a few looks there are a few hundred of them.
# - **The thresholds of a predictive design are intervals.** Whatever final threshold theta lies in (Pr(s - 1), Pr(s)], where Pr(k) is
#   the posterior probability after k responses of N, gives the same rule "succeed at s responses or more"; the search is over s and the
#   result reports the interval, not one grid value.
# - **The objective is stated, not hidden.** The published BOP2 picks the (lambda, gamma) with the largest power among those that keep the
#   type I error at or below alpha; the question "how many fewer patients than Simon" is the other objective, the fewest expected patients
#   under the null among those that keep alpha AND reach the power asked for. `design.objective` is either; the result says which.
# - **Simon is the baseline** whenever a phase II design is asked about: the optimal two-stage design at the same alpha and power, with its
#   expected size under the alternative too, so the saving is a difference of two exact numbers.
# - **The prior of a phase II design is Beta(p0, 1 - p0)** (prior mean at the null rate, one patient's worth of information) unless stated;
#   it is a premise of the result.
# - **Conjugate threshold calibration.** A normal endpoint with a known standard deviation (a difference of means; a log hazard ratio with
#   information = events x allocation x (1 - allocation)) under a normal prior gives a success region that is a half line of the estimate, so
#   the type I error, the power and the calibrated threshold are closed forms. A binary two-arm endpoint under independent beta priors needs
#   Pr(pT - pC > margin | xT, xC) for every pair of counts: a one-dimensional integral, done with Gauss-Legendre nodes, exact for integer prior
#   parameters when there are enough nodes (the integrand is a polynomial), and the discrete type I error is a step function of the
#   threshold, so the calibrated threshold is the smallest that keeps it at or below alpha, with the achieved level stated.
# ---------------------------------------------------------------------------

VCR_BD_LAMBDA_GRID <- seq(0.02, 0.99, by = 0.005)
VCR_BD_GAMMA_GRID <- seq(0.05, 2, by = 0.05)
#' The largest total size Simon's design is searched up to (the engine's own default for a Simon design): the search costs about 4 s at 100 and grows with the fourth power.
VCR_BD_SIMON_MAX <- 100L

.vcr_bd_assume <- function(p, key, value, basis = "default") {
  p$assumed[[length(p$assumed) + 1L]] <- list(key = key, value = value, basis = basis)
  p
}

# --- phase II: the trial as a vector of integers ----------------------------------------------------------------

#' The cumulative sizes at which the trial is looked at: every `look_every` patients and at the end.
.vcr_bd_looks <- function(max_n, look_every) {
  looks <- seq(look_every, max_n, by = look_every)
  if (!length(looks) || looks[length(looks)] != max_n) looks <- c(looks, max_n)
  as.integer(looks)
}

#' Pr(p > p0 | x responses of n) for x = 0..n under a Beta(a, b) prior.
.vcr_bd_pp <- function(p0, a, b, n) 1 - stats::pbeta(p0, a + 0:n, b + n - 0:n)

#' The transition matrices of the count of responses between looks, for a response rate: from (previous look, x) to (look, x').
.vcr_bd_transitions <- function(p, looks) {
  prev <- 0L
  lapply(looks, function(n) {
    m <- n - prev
    M <- outer(0:prev, 0:n, function(a, b) stats::dbinom(b - a, m, p))
    prev <<- n
    M
  })
}

#' The operating characteristics of a boundary rule, exactly: stop at look i (< the last) when x <= fut[i] (futility) or x >= eff[i]
#' (efficacy), succeed at the last look when x >= succ. Returns the probability of success, of stopping for futility and for efficacy
#' (total and by look), and the expected number of patients.
.vcr_bd_oc <- function(trans, looks, fut, eff, succ) {
  L <- length(looks)
  mass <- 1
  stop_f <- stop_e <- numeric(L)
  success_last <- 0
  for (i in seq_len(L)) {
    mass <- as.vector(mass %*% trans[[i]])
    x <- 0:looks[i]
    if (i < L) {
      f <- x <= fut[i]; e <- x >= eff[i] & !f
      stop_f[i] <- sum(mass[f]); stop_e[i] <- sum(mass[e])
      mass[f | e] <- 0
    } else success_last <- sum(mass[x >= succ])
  }
  reach <- sum(mass)
  list(success = sum(stop_e) + success_last, stopFutility = sum(stop_f), stopEfficacy = sum(stop_e), reachFinal = reach,
       byLook = list(futility = stop_f[-L], efficacy = stop_e[-L]),
       expectedN = sum(looks[-L] * (stop_f[-L] + stop_e[-L])) + looks[L] * reach)
}

#' BOP2's boundaries for one (lambda, gamma): futility when x <= fut[i], success at the end when x >= succ, and (when `eta` is given) efficacy
#' when x >= eff[i] with the cut-off 1 - (1 - lambda)(n / N)^eta.
vcr_bop2_boundaries <- function(pp, looks, lambda, gamma, eta = NULL) {
  L <- length(looks); N <- looks[L]
  fut <- vapply(seq_len(L - 1L), function(i) sum(pp[[i]] < lambda * (looks[i] / N)^gamma) - 1L, numeric(1))
  eff <- if (is.null(eta)) rep(Inf, L - 1L) else vapply(seq_len(L - 1L), function(i) sum(pp[[i]] < 1 - (1 - lambda) * (looks[i] / N)^eta), numeric(1))
  list(fut = fut, eff = eff, succ = sum(pp[[L]] < lambda))
}

#' Pick the design a search ends with among evaluated candidates (each: null and alternative operating characteristics): those that keep
#' the type I error at or below alpha (and, for `min_expected_n`, reach the power asked for); among them the largest power, or the fewest
#' expected patients under the null. NULL when nothing keeps alpha. Ties: the larger power, then the fewer expected patients.
.vcr_bd_choose <- function(cands, alpha, power, objective) {
  if (!length(cands)) return(NULL)
  t1 <- vapply(cands, function(c) c$h0$success, numeric(1)); pw <- vapply(cands, function(c) c$h1$success, numeric(1))
  en0 <- vapply(cands, function(c) c$h0$expectedN, numeric(1))
  ok <- which(t1 <= alpha + 1e-12)
  if (!length(ok)) return(NULL)
  if (identical(objective, "min_expected_n")) {
    reach <- ok[pw[ok] >= power - 1e-12]
    if (length(reach)) { best <- reach[order(en0[reach], -pw[reach])[1L]]; return(list(index = best, reachedPower = TRUE)) }
  }
  best <- ok[order(-round(pw[ok], 12), en0[ok])[1L]]
  list(index = best, reachedPower = pw[best] >= power - 1e-12)
}

.vcr_bd_cell <- function(name, value) vcr_measure(name, value, source = "calculated")

#' What the operating characteristics of one design say, as cells.
.vcr_bd_oc_cells <- function(oc, null) {
  cells <- list(.vcr_bd_cell(if (null) "type_one_error" else "power", oc$success), .vcr_bd_cell("expected_sample_size", oc$expectedN),
                .vcr_bd_cell("futility_stop_probability", oc$stopFutility))
  if (oc$stopEfficacy > 0) cells[[length(cells) + 1L]] <- .vcr_bd_cell("early_stop_efficacy_probability", oc$stopEfficacy)
  names(cells) <- vapply(cells, function(m) m$name, character(1))
  cells
}

.vcr_bd_oc_row <- function(oc, null, rate, looks) {
  L <- length(looks)
  list(role = if (null) "null" else "alternative", rate = rate, cells = .vcr_bd_oc_cells(oc, null),
       byLook = lapply(seq_len(L - 1L), function(i) list(look = i, size = looks[i],
         futility = .vcr_bd_cell("stop_futility_probability", oc$byLook$futility[i]), efficacy = .vcr_bd_cell("stop_efficacy_probability", oc$byLook$efficacy[i]))))
}

#' Simon's optimal and minimax designs at the same alpha and power, with their expected sizes under both rates; NULL when none exists up to `n_max`
#' (the baseline is then left out of the result, not replaced by a search that would take minutes).
.vcr_bd_simon <- function(p0, p1, alpha, power, n_max) {
  s <- tryCatch(vcr_simon_two_stage(p0, p1, alpha = alpha, beta = 1 - power, n_max = n_max), error = function(e) NULL)
  if (is.null(s) || (is.null(s$optimal) && is.null(s$minimax))) return(NULL)
  describe <- function(x) if (is.null(x)) NULL else {
    pet1 <- stats::pbinom(x$r1, x$n1, p1)
    list(n1 = x$n1, r1 = x$r1, n = x$n, r = x$r, typeOneError = x$alpha, power = x$power, expectedN0 = x$EN0, expectedN1 = x$n1 + (1 - pet1) * (x$n - x$n1),
         earlyStop0 = x$PET0, earlyStop1 = pet1)
  }
  list(optimal = describe(s$optimal), minimax = describe(s$minimax))
}

.vcr_bd_read_phase2 <- function(sc) {
  d <- sc[["design"]]; tr <- sc[["truth"]]; an <- sc[["analysis"]]
  p <- list(kind = as.character(d[["kind"]]), assumed = list())
  p$p0 <- vcr_scalar(tr[["nullRate"]]); p$p1 <- vcr_scalar(tr[["alternativeRate"]])
  p$max_n <- as.integer(vcr_scalar(d[["maxN"]]))
  p$look_every <- as.integer(vcr_scalar(d[["lookEvery"]], 10L))
  if (is.null(d[["lookEvery"]])) p <- .vcr_bd_assume(p, "design.lookEvery", p$look_every, basis = "default: patients between looks")
  p$looks <- .vcr_bd_looks(p$max_n, p$look_every)
  p$alpha <- vcr_scalar(an[["alpha"]], 0.05); p$power <- vcr_scalar(an[["power"]], 0.8)
  if (is.null(an[["alpha"]])) p <- .vcr_bd_assume(p, "analysis.alpha", p$alpha, basis = "default: one-sided type I error")
  if (is.null(an[["power"]])) p <- .vcr_bd_assume(p, "analysis.power", p$power)
  pr <- d[["prior"]]
  p$a <- vcr_scalar(pr[["a"]], p$p0); p$b <- vcr_scalar(pr[["b"]], 1 - p$p0)
  if (is.null(pr)) p <- .vcr_bd_assume(p, "design.prior", sprintf("Beta(%.3g, %.3g)", p$a, p$b), basis = "default: prior mean at the null rate, one patient's worth of information")
  p$objective <- as.character(d[["objective"]] %||% "max_power")
  if (is.null(d[["objective"]])) p <- .vcr_bd_assume(p, "design.objective", p$objective, basis = "default: the largest power among the designs that keep the type I error")
  if (!(p$p0 < p$p1)) vcr_abort("scenario_value_invalid", "scenario.truth.alternativeRate", "The alternative response rate is above the null rate.")
  p
}

.vcr_bd_given2 <- function(sc, p, extra = list()) {
  d <- sc[["design"]]; tr <- sc[["truth"]]
  c(Filter(Negate(is.null), list(nullRate = p$p0, alternativeRate = p$p1, maxN = p$max_n, lookEvery = vcr_scalar(d[["lookEvery"]], NULL), objective = d[["objective"]])), extra)
}

# --- BOP2 ---------------------------------------------------------------------------------------------------------------

.vcr_bd_bop2 <- function(job) {
  sc <- job$scenario; p <- .vcr_bd_read_phase2(sc)
  b <- sc$design[["bop2"]]
  eta <- vcr_scalar(b[["efficacyEta"]], NULL)
  looks <- p$looks; L <- length(looks)
  pp <- lapply(looks, function(n) .vcr_bd_pp(p$p0, p$a, p$b, n))
  tr0 <- .vcr_bd_transitions(p$p0, looks); tr1 <- .vcr_bd_transitions(p$p1, looks)
  evaluate <- function(lambda, gamma) {
    bd <- vcr_bop2_boundaries(pp, looks, lambda, gamma, eta)
    list(lambda = lambda, gamma = gamma, bounds = bd, h0 = .vcr_bd_oc(tr0, looks, bd$fut, bd$eff, bd$succ), h1 = .vcr_bd_oc(tr1, looks, bd$fut, bd$eff, bd$succ))
  }
  stated <- !is.null(b[["lambda"]]) && !is.null(b[["gamma"]])
  picked <- NULL; searched <- 0L; distinct <- 0L
  if (stated) {
    chosen <- evaluate(vcr_scalar(b[["lambda"]]), vcr_scalar(b[["gamma"]]))
    reached <- chosen$h1$success >= p$power - 1e-12
  } else {
    seen <- new.env(parent = emptyenv()); cands <- list()
    for (lambda in VCR_BD_LAMBDA_GRID) for (gamma in VCR_BD_GAMMA_GRID) {
      searched <- searched + 1L
      bd <- vcr_bop2_boundaries(pp, looks, lambda, gamma, eta)
      key <- paste(c(bd$fut, bd$eff, bd$succ), collapse = ",")
      if (!is.null(seen[[key]])) next
      seen[[key]] <- TRUE
      cands[[length(cands) + 1L]] <- list(lambda = lambda, gamma = gamma, bounds = bd, h0 = .vcr_bd_oc(tr0, looks, bd$fut, bd$eff, bd$succ), h1 = .vcr_bd_oc(tr1, looks, bd$fut, bd$eff, bd$succ))
    }
    distinct <- length(cands)
    pick <- .vcr_bd_choose(cands, p$alpha, p$power, p$objective)
    if (is.null(pick)) vcr_abort("design_not_computable", "scenario.analysis.alpha", sprintf("No BOP2 design with these looks keeps the type I error at or below %s; allow a larger level or more patients.", format(p$alpha)))
    chosen <- cands[[pick$index]]; reached <- pick$reachedPower
    # the smallest lambda that gives the chosen rule is reported; a larger one in the same interval would give the same boundaries
  }
  bd <- chosen$bounds
  simon <- .vcr_bd_simon(p$p0, p$p1, p$alpha, p$power, min(p$max_n, VCR_BD_SIMON_MAX))
  looks_out <- lapply(seq_len(L), function(i) list(look = i, size = looks[i],
    futilityAtOrBelow = if (i < L && bd$fut[i] >= 0) bd$fut[i] else NULL,
    efficacyAtOrAbove = if (i < L && is.finite(bd$eff[i]) && bd$eff[i] <= looks[i]) bd$eff[i] else NULL,
    successAtOrAbove = if (i == L) bd$succ else NULL))
  measures <- list(.vcr_bd_cell("type_one_error", chosen$h0$success), .vcr_bd_cell("power", chosen$h1$success),
                   .vcr_bd_cell("expected_sample_size_null", chosen$h0$expectedN), .vcr_bd_cell("expected_sample_size", chosen$h1$expectedN),
                   .vcr_bd_cell("max_patients", p$max_n))
  if (!is.null(simon$optimal)) measures <- c(measures, list(.vcr_bd_cell("simon_expected_sample_size_null", simon$optimal$expectedN0),
    .vcr_bd_cell("expected_sample_size_saving_null", simon$optimal$expectedN0 - chosen$h0$expectedN)))
  list(status = "succeeded", measures = measures, counts = vcr_counts(), conclusion = "estimable",
       diagnostics = list(bayesianDesign = list(kind = "bop2", endpoint = "binary", looks = looks_out,
         parameters = list(lambda = chosen$lambda, gamma = chosen$gamma, efficacyEta = eta, searched = stated == FALSE, grid = if (stated) NULL else list(candidates = searched, distinctRules = distinct)),
         objective = p$objective, reachedPower = reached,
         prior = list(a = p$a, b = p$b),
         operating = list(.vcr_bd_oc_row(chosen$h0, TRUE, p$p0, looks), .vcr_bd_oc_row(chosen$h1, FALSE, p$p1, looks)),
         baselines = list(simon = simon), assumed = c(p$assumed, if (!stated) list(list(key = "design.bop2", value = sprintf("lambda %.3f and gamma %.2f found by a grid search", chosen$lambda, chosen$gamma), basis = "search"))),
         given = .vcr_bd_given2(sc, p))))
}

# --- predictive monitoring ----------------------------------------------------------------------------------------------

#' P(Y >= k) for k = 0..m + 1 and x = 0..n, with Y beta-binomial(m, a + x, b + n - x) (the predictive distribution of the responses still to
#' come after x of n): a matrix with one row per x and one column per k.
.vcr_bd_predictive_tail <- function(a, b, n, m) {
  x <- 0:n; y <- 0:m
  pmf <- t(vapply(x, function(xx) exp(lchoose(m, y) + lbeta(y + a + xx, m - y + b + n - xx) - lbeta(a + xx, b + n - xx)), numeric(m + 1L)))
  if (m == 0L) pmf <- matrix(1, n + 1L, 1L)
  tail_ <- t(apply(pmf, 1L, function(r) rev(cumsum(rev(r)))))
  if (m == 0L) tail_ <- matrix(1, n + 1L, 1L)
  cbind(tail_, 0)
}

.vcr_bd_predictive <- function(job) {
  sc <- job$scenario; p <- .vcr_bd_read_phase2(sc)
  pm <- sc$design[["predictive"]]
  futility <- vcr_scalar(pm[["futility"]], 0.05); efficacy <- vcr_scalar(pm[["efficacy"]], NULL)
  if (is.null(pm[["futility"]])) p <- .vcr_bd_assume(p, "design.predictive.futility", futility, basis = "default: stop when the predictive probability of success is below this")
  looks <- p$looks; L <- length(looks); N <- looks[L]
  pp_final <- .vcr_bd_pp(p$p0, p$a, p$b, N)
  tails <- lapply(seq_len(L - 1L), function(i) .vcr_bd_predictive_tail(p$a, p$b, looks[i], N - looks[i]))
  tr0 <- .vcr_bd_transitions(p$p0, looks); tr1 <- .vcr_bd_transitions(p$p1, looks)
  rule <- function(s) {
    pred <- lapply(seq_len(L - 1L), function(i) {
      x <- 0:looks[i]; need <- pmin(pmax(s - x, 0L), N - looks[i] + 1L)
      tails[[i]][cbind(seq_along(x), need + 1L)]
    })
    fut <- vapply(pred, function(q) sum(q < futility) - 1L, numeric(1))
    eff <- if (is.null(efficacy)) rep(Inf, L - 1L) else vapply(pred, function(q) sum(q <= efficacy), numeric(1))
    list(fut = fut, eff = eff, succ = s)
  }
  evaluate <- function(s) {
    bd <- rule(s)
    list(s = s, bounds = bd, h0 = .vcr_bd_oc(tr0, looks, bd$fut, bd$eff, s), h1 = .vcr_bd_oc(tr1, looks, bd$fut, bd$eff, s))
  }
  threshold <- vcr_scalar(pm[["final"]], NULL)
  if (!is.null(threshold)) {
    chosen <- evaluate(sum(pp_final < threshold))
    reached <- chosen$h1$success >= p$power - 1e-12
  } else {
    cands <- lapply(0:(N + 1L), evaluate)
    pick <- .vcr_bd_choose(cands, p$alpha, p$power, p$objective)
    if (is.null(pick)) vcr_abort("design_not_computable", "scenario.analysis.alpha", sprintf("No predictive-probability design with these looks keeps the type I error at or below %s; allow a larger level or more patients.", format(p$alpha)))
    chosen <- cands[[pick$index]]; reached <- pick$reachedPower
  }
  s <- chosen$s
  # the interval of final thresholds that gives this rule: (Pr after s - 1 responses, Pr after s responses]
  lowest <- if (s >= 1L && s <= N + 1L) pp_final[s] else NULL
  highest <- if (s <= N) pp_final[s + 1L] else NULL
  bd <- chosen$bounds
  simon <- .vcr_bd_simon(p$p0, p$p1, p$alpha, p$power, min(p$max_n, VCR_BD_SIMON_MAX))
  looks_out <- lapply(seq_len(L), function(i) list(look = i, size = looks[i],
    futilityAtOrBelow = if (i < L && bd$fut[i] >= 0) bd$fut[i] else NULL,
    efficacyAtOrAbove = if (i < L && is.finite(bd$eff[i]) && bd$eff[i] <= looks[i]) bd$eff[i] else NULL,
    successAtOrAbove = if (i == L) s else NULL))
  measures <- list(.vcr_bd_cell("type_one_error", chosen$h0$success), .vcr_bd_cell("power", chosen$h1$success),
                   .vcr_bd_cell("expected_sample_size_null", chosen$h0$expectedN), .vcr_bd_cell("expected_sample_size", chosen$h1$expectedN),
                   .vcr_bd_cell("max_patients", p$max_n))
  if (!is.null(simon$optimal)) measures <- c(measures, list(.vcr_bd_cell("simon_expected_sample_size_null", simon$optimal$expectedN0),
    .vcr_bd_cell("expected_sample_size_saving_null", simon$optimal$expectedN0 - chosen$h0$expectedN)))
  list(status = "succeeded", measures = measures, counts = vcr_counts(), conclusion = "estimable",
       diagnostics = list(bayesianDesign = list(kind = "predictive_monitoring", endpoint = "binary", looks = looks_out,
         parameters = list(futility = futility, efficacy = efficacy, finalThreshold = threshold, finalThresholdAbove = lowest, finalThresholdAtMost = highest,
                           successResponses = s, searched = is.null(threshold)),
         objective = p$objective, reachedPower = reached, prior = list(a = p$a, b = p$b),
         operating = list(.vcr_bd_oc_row(chosen$h0, TRUE, p$p0, looks), .vcr_bd_oc_row(chosen$h1, FALSE, p$p1, looks)),
         baselines = list(simon = simon), assumed = p$assumed,
         given = .vcr_bd_given2(sc, p, Filter(Negate(is.null), list(futilityThreshold = vcr_scalar(pm[["futility"]], NULL), efficacyThreshold = efficacy, finalThreshold = threshold))))))
}

# --- threshold calibration (T10) ----------------------------------------------------------------------------------------------

#' Gauss-Legendre nodes and weights on [-1, 1] by Newton's method on the Legendre recurrence.
vcr_gauss_legendre <- function(n) {
  i <- seq_len(n)
  x <- cos(pi * (i - 0.25) / (n + 0.5))
  for (it in 1:100) {
    p1 <- rep(1, n); p2 <- rep(0, n)
    for (j in seq_len(n)) { p3 <- p2; p2 <- p1; p1 <- ((2 * j - 1) * x * p2 - (j - 1) * p3) / j }
    pp <- n * (x * p1 - p2) / (x^2 - 1)
    dx <- p1 / pp
    x <- x - dx
    if (max(abs(dx)) < 1e-15) break
  }
  p1 <- rep(1, n); p2 <- rep(0, n)
  for (j in seq_len(n)) { p3 <- p2; p2 <- p1; p1 <- ((2 * j - 1) * x * p2 - (j - 1) * p3) / j }
  pp <- n * (x * p1 - p2) / (x^2 - 1)
  list(nodes = rev(x), weights = rev(2 / ((1 - x^2) * pp^2)))
}

#' Pr(pT - pC > margin | xT, xC) for every pair of counts (rows xT = 0..nT, columns xC = 0..nC) under independent beta priors: the integral
#' over the treatment rate u of its posterior density times the control posterior's distribution function at u - margin, on the stretch
#' where that function is neither 0 nor 1, plus the mass above it. The integrand is a polynomial for integer prior parameters, so the
#' nodes (about half the total number of patients) make it exact; a non-integer prior is smooth and the same count is generous.
vcr_bd_binary_posterior <- function(n_treat, n_control, prior_treat, prior_control, margin) {
  lo <- max(0, margin); hi <- min(1, 1 + margin)
  q <- min(1500L, max(48L, as.integer(ceiling((n_treat + n_control) / 2)) + 24L))
  gl <- vcr_gauss_legendre(q)
  u <- (hi - lo) / 2 * gl$nodes + (hi + lo) / 2; w <- (hi - lo) / 2 * gl$weights
  xt <- 0:n_treat; xc <- 0:n_control
  at <- function(v) vapply(xc, function(x) stats::pbeta(v - margin, prior_control[1L] + x, prior_control[2L] + n_control - x), numeric(length(v)))
  D <- t(vapply(xt, function(x) stats::dbeta(u, prior_treat[1L] + x, prior_treat[2L] + n_treat - x) * w, numeric(q)))
  P <- D %*% at(u)
  # A treatment posterior with a shape below 1 has an unbounded density at that end of the range, which nodes do not resolve. Where the
  # range reaches the end, the integral is redone after the substitution that removes the singularity (u = t^(1/a), or 1 - u = (1 - t)^(1/b)):
  # the density times the Jacobian is then the smooth factor alone.
  for (x in xt) {
    a <- prior_treat[1L] + x; b <- prior_treat[2L] + n_treat - x
    if (a < 1 && lo == 0) {
      t_hi <- hi^a; t <- t_hi / 2 * (gl$nodes + 1); wt <- t_hi / 2 * gl$weights; uu <- t^(1 / a)
      P[x + 1L, ] <- as.vector((wt * exp((b - 1) * log1p(-uu) - lbeta(a, b)) / a) %*% at(uu))
    } else if (b < 1 && hi == 1) {
      t_lo <- 1 - (1 - lo)^b; t <- (1 - t_lo) / 2 * (gl$nodes + 1) + t_lo; wt <- (1 - t_lo) / 2 * gl$weights; uu <- 1 - (1 - t)^(1 / b)
      P[x + 1L, ] <- as.vector((wt * exp((a - 1) * log(uu) - lbeta(a, b)) / b) %*% at(uu))
    }
  }
  tail_ <- if (hi < 1) 1 - stats::pbeta(hi, prior_treat[1L] + xt, prior_treat[2L] + n_treat - xt) else rep(0, length(xt))
  P[] <- pmin(1, pmax(0, P + tail_))
  P
}

#' The type I error, power and calibrated threshold of the rule "Pr(effect > margin | data) > c" for a normal estimate of the effect (positive
#' is better) with standard error `se`, a normal prior (`m0`, `s0`; `s0` infinite for a flat prior), a type I error measured at the effect
#' `null_effect` and a power at `alt_effect`. Closed forms: the posterior mean is linear in the estimate, so the rule is a threshold on it.
vcr_bd_normal_rule <- function(se, m0, s0, margin, null_effect, alt_effect, alpha, thresholds) {
  prec_prior <- if (is.finite(s0)) 1 / s0^2 else 0
  tau <- prec_prior + 1 / se^2
  # the estimate above which the posterior probability exceeds c
  cut <- function(c) {
    mu <- margin + stats::qnorm(c) / sqrt(tau)
    se^2 * (tau * mu - (if (prec_prior > 0) m0 * prec_prior else 0))
  }
  reject <- function(t, effect) 1 - stats::pnorm((t - effect) / se)
  # the threshold whose cut is the estimate that holds the type I error at alpha
  t_star <- null_effect + se * stats::qnorm(1 - alpha)
  mu_star <- (t_star / se^2 + (if (prec_prior > 0) m0 * prec_prior else 0)) / tau
  c_star <- stats::pnorm((mu_star - margin) * sqrt(tau))
  list(calibrated = list(threshold = c_star, typeOneError = alpha, power = reject(t_star, alt_effect)),
       rows = lapply(thresholds, function(c) list(threshold = c, typeOneError = reject(cut(c), null_effect), power = reject(cut(c), alt_effect))))
}

.vcr_bd_calibration <- function(job) {
  sc <- job$scenario; d <- sc$design; tr <- sc$truth; an <- sc[["analysis"]]
  type <- as.character(sc$endpoint$type)
  p <- list(assumed = list())
  alpha <- vcr_scalar(an[["alpha"]], 0.025)
  if (is.null(an[["alpha"]])) p <- .vcr_bd_assume(p, "analysis.alpha", alpha, basis = "default: one-sided type I error")
  stated <- vcr_scalar(d[["threshold"]], NULL)
  conventional <- 1 - alpha
  thresholds <- unique(c(stated, conventional))
  pr <- d[["priorEffect"]]
  if (type %in% c("continuous", "time_to_event")) {
    if (identical(type, "continuous")) {
      n1 <- vcr_scalar(d[["nTreat"]]); n2 <- vcr_scalar(d[["nControl"]])
      sd <- vcr_scalar(tr[["sd"]], 1)
      if (is.null(tr[["sd"]])) p <- .vcr_bd_assume(p, "truth.sd", sd, basis = "default: the standard deviation taken as known")
      se <- sd * sqrt(1 / n1 + 1 / n2)
      margin <- vcr_scalar(d[["margin"]], 0)
      m0 <- vcr_scalar(pr[["mean"]], 0); s0 <- vcr_scalar(pr[["sd"]], Inf)
      alt <- vcr_scalar(tr[["effect"]])
      null_effect <- margin
      scale <- "difference"
    } else {
      events <- vcr_scalar(d[["events"]]); alloc <- vcr_scalar(d[["allocation"]], 0.5)
      if (is.null(d[["allocation"]])) p <- .vcr_bd_assume(p, "design.allocation", alloc)
      se <- 1 / sqrt(events * alloc * (1 - alloc))
      # the benefit is a negative log hazard ratio: work with its negative, so that above the margin is better
      hr_margin <- vcr_scalar(d[["margin"]], 1)
      margin <- -log(hr_margin)
      m0 <- -vcr_scalar(pr[["mean"]], 0); s0 <- vcr_scalar(pr[["sd"]], Inf)
      alt <- -log(vcr_scalar(tr[["hazardRatio"]]))
      null_effect <- margin
      scale <- "log_hazard_ratio"
    }
    if (is.null(pr)) p <- .vcr_bd_assume(p, "design.prior", "flat (no prior information)", basis = "default")
    r <- vcr_bd_normal_rule(se, m0, s0, margin, null_effect, alt, alpha, thresholds)
    rows <- c(list(c(list(label = "calibrated"), r$calibrated)),
              lapply(r$rows, function(x) c(list(label = if (!is.null(stated) && abs(x$threshold - stated) < 1e-12) "stated" else "conventional"), x)))
    exact_note <- "closed form"
    details <- list(standardError = se, priorMean = if (identical(type, "continuous")) m0 else -m0, priorSd = if (is.finite(s0)) s0 else NULL, margin = vcr_scalar(d[["margin"]], if (identical(type, "continuous")) 0 else 1))
  } else {
    n1 <- as.integer(vcr_scalar(d[["nTreat"]])); n2 <- as.integer(vcr_scalar(d[["nControl"]]))
    margin <- vcr_scalar(d[["margin"]], 0)
    pt <- d[["priorTreatment"]]; pc <- d[["priorControl"]]
    prior_t <- c(vcr_scalar(pt[["a"]], 1), vcr_scalar(pt[["b"]], 1)); prior_c <- c(vcr_scalar(pc[["a"]], 1), vcr_scalar(pc[["b"]], 1))
    if (is.null(pt)) p <- .vcr_bd_assume(p, "design.priorTreatment", "Beta(1, 1)", basis = "default")
    if (is.null(pc)) p <- .vcr_bd_assume(p, "design.priorControl", "Beta(1, 1)", basis = "default")
    control <- vcr_scalar(tr[["controlRate"]]); treat_alt <- vcr_scalar(tr[["treatmentRate"]])
    treat_null <- control + margin
    if (!(treat_null > 0 && treat_null < 1)) vcr_abort("scenario_value_invalid", "scenario.design.margin", "The control rate plus the margin is a rate strictly between 0 and 1.")
    post <- vcr_bd_binary_posterior(n1, n2, prior_t, prior_c, margin)
    pmf <- function(pt_, pc_) outer(stats::dbinom(0:n1, n1, pt_), stats::dbinom(0:n2, n2, pc_))
    w0 <- pmf(treat_null, control); w1 <- pmf(treat_alt, control)
    at <- function(c) { win <- post > c; list(typeOneError = sum(w0[win]), power = sum(w1[win])) }
    # the discrete type I error is a step function of the threshold: the smallest threshold that keeps it at or below alpha
    # (the pairs in order of their posterior probability, the null probability of the pairs that share a value added up: the type I error of
    # "greater than the k-th value" is the total of the groups before it)
    ord <- order(as.vector(post), decreasing = TRUE)
    ps <- as.vector(post)[ord]; ms <- as.vector(w0)[ord]
    first <- c(TRUE, ps[-1L] != ps[-length(ps)])
    values <- ps[first]
    region_error <- c(0, cumsum(as.vector(rowsum(ms, cumsum(first)))))[seq_along(values)]
    ok <- which(region_error <= alpha + 1e-12)
    c_star <- if (length(ok)) values[max(ok)] else max(values)
    r_star <- at(c_star)
    rows <- c(list(c(list(label = "calibrated", threshold = c_star), r_star)),
              lapply(thresholds, function(c) c(list(label = if (!is.null(stated) && abs(c - stated) < 1e-12) "stated" else "conventional", threshold = c), at(c))))
    details <- list(margin = margin, nTreat = n1, nControl = n2, priorTreatment = prior_t, priorControl = prior_c, nodes = min(1500L, max(48L, as.integer(ceiling((n1 + n2) / 2)) + 24L)))
    scale <- "risk_difference"
  }
  cell_rows <- lapply(rows, function(r) list(label = r$label, cells = list(threshold = .vcr_bd_cell("success_threshold", r$threshold),
    type_one_error = .vcr_bd_cell("type_one_error", r$typeOneError), power = .vcr_bd_cell("power", r$power))))
  cal <- rows[[1L]]
  measures <- list(.vcr_bd_cell("calibrated_threshold", cal$threshold), .vcr_bd_cell("type_one_error", cal$typeOneError), .vcr_bd_cell("power", cal$power))
  ref <- Filter(function(r) !identical(r$label, "calibrated"), rows)
  if (length(ref)) { first <- ref[[1L]]; measures <- c(measures, list(.vcr_bd_cell("type_one_error_stated", first$typeOneError), .vcr_bd_cell("power_stated", first$power))) }
  list(status = "succeeded", measures = measures, counts = vcr_counts(), conclusion = "estimable",
       diagnostics = list(bayesianDesign = list(kind = "threshold_calibration", endpoint = type, scale = scale, alpha = alpha, rows = cell_rows, details = details,
         discrete = !identical(scale, "difference") && !identical(scale, "log_hazard_ratio"), assumed = p$assumed,
         given = Filter(Negate(is.null), list(threshold = stated, margin = vcr_scalar(d[["margin"]], NULL), alpha = vcr_scalar(an[["alpha"]], NULL))))))
}

# --- the dispatcher -------------------------------------------------------------------------------------------------------------------------

vcr_job_design_bayesian <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  kind <- as.character(job$scenario$design$kind %||% "")
  switch(kind,
    bop2 = .vcr_bd_bop2(job),
    predictive_monitoring = .vcr_bd_predictive(job),
    threshold_calibration = .vcr_bd_calibration(job),
    vcr_abort("design_not_supported", "scenario.design.kind", sprintf("'%s' is not a Bayesian design this build computes.", kind)))
}
