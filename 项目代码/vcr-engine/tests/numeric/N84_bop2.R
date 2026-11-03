# N84 — the Bayesian optimal phase II design (algorithm round T8, 2026-11-03): design.bayesian, design.kind bop2.
#
# "单臂每 10 人看一次，何时停，比 Simon 少多少人": the design stops at a look when Pr(p > p0 | data) < lambda (n / N)^gamma, succeeds at the end
# when Pr(p > p0 | data) >= lambda (and, with an efficacy stop, stops for success when it reaches 1 - (1 - lambda)(n / N)^eta). Every number is
# exact. Held to:
#
#   a  BOP2FE::get_boundary_binary: the futility, efficacy and final bounds for a grid of (lambda, gamma, eta), equal looks and unequal
#      looks, the default prior and two others. (Where no count qualifies for an efficacy stop BOP2FE puts the bound at n, the engine at
#      n + 1: a stop at "all responses" that the posterior does not justify; those cells are compared on what the posterior says.)
#   b  a brute-force enumeration of every response sequence of a 12-patient trial, each look judged by the posterior probability itself
#      (pbeta), not by the integer bounds: type I error, power, expected size, the probability of each kind of stop
#   c  BOP2FE's own simulation of the same design (50,000 trials): type I error, power, expected size and the stop probabilities, within
#      three Monte-Carlo errors
#   d  Simon's published two-stage design is the baseline (1/10 and 5/29, expected size 15.0 under p0 = 0.1 against p1 = 0.3), and the
#      saving the result states is the difference of two numbers it carries
#   e  the search: the design it returns keeps alpha, no design on a grid it did not search beats its power, and the objective that asks
#      for the fewest expected patients at the power asked for does not give more of them

.n84_job <- function(design, truth = list(nullRate = 0.1, alternativeRate = 0.3), analysis = list(alpha = 0.05, power = 0.8)) {
  vcr_test_run(vcr_test_job("design.bayesian", list(design = design, truth = truth, analysis = analysis), seed = 8401L))
}
.n84_b <- function(r) r$diagnostics$bayesianDesign
.n84_op <- function(r, role) Filter(function(x) identical(x$role, role), .n84_b(r)$operating)[[1]]

vcr_case("N84a", c("AC-30"), function() {
  if (!requireNamespace("BOP2FE", quietly = TRUE)) stop("N84 requires the locked BOP2FE library")
  checked <- 0L; bad <- character(); skipped <- 0L; refused <- 0L
  for (looks in list(c(10L, 20L, 30L, 40L), c(5L, 15L, 25L, 40L), c(8L, 16L, 24L))) {
    sizes <- diff(c(0L, looks)); N <- looks[length(looks)]
    for (prior in list(NULL, c(1, 1), c(0.5, 0.5))) {
      p0 <- 0.15
      a <- if (is.null(prior)) p0 else prior[1]; b <- if (is.null(prior)) 1 - p0 else prior[2]
      pp <- lapply(looks, function(n) .vcr_bd_pp(p0, a, b, n))
      for (lambda in c(0.7, 0.85, 0.95)) for (gamma in c(0.5, 1, 1.5)) for (eta in c(0.5, 1, 2)) {
        mine <- vcr_bop2_boundaries(pp, looks, lambda, gamma, eta)
        ref <- tryCatch(BOP2FE::get_boundary_binary(p0, a, b, sizes, lambda = lambda, gamma = gamma, eta = eta, method = "power"), error = function(e) NULL)
        if (is.null(ref)) { refused <- refused + 1L; next }     # the package fails on some efficacy settings (an index out of range)
        f <- unlist(ref$cnf[1, paste0("f", seq_along(looks))]); s <- unlist(ref$cns[1, paste0("s", seq_along(looks))])
        L <- length(looks)
        # BOP2FE's futility bound is 0 where the engine's is -1 (no count stops): the same unless Pr(p > p0 | 0 of n) is already above the cut-off
        stops_at_zero <- vapply(seq_len(L - 1L), function(i) pp[[i]][1L] >= lambda * (looks[i] / N)^gamma, logical(1))
        if (any(stops_at_zero)) { skipped <- skipped + 1L; next }
        fut_ok <- all(mine$fut == f[seq_len(L - 1L)]) && mine$succ == f[L] + 1
        eff_ok <- all(ifelse(mine$eff <= looks[-L], mine$eff == s[seq_len(L - 1L)], s[seq_len(L - 1L)] == looks[-L])) && mine$succ == s[L]
        checked <- checked + 1L
        if (!(fut_ok && eff_ok)) bad <- c(bad, sprintf("looks %s prior %s lambda %.2f gamma %.1f eta %.1f", paste(looks, collapse = "/"), if (is.null(prior)) "default" else paste(prior, collapse = ","), lambda, gamma, eta))
      }
    }
  }
  list(pass = !length(bad) && checked >= 100L, detail = sprintf("%d (looks, prior, lambda, gamma, eta) combinations: futility bounds, efficacy bounds and the final bound identical to BOP2FE::get_boundary_binary; %d set aside where the cut-off is already under Pr(p > p0 | no response) and %d where the package itself fails%s",
                                                           checked, skipped, refused, if (length(bad)) paste0(" -- differ: ", paste(utils::head(bad, 3), collapse = "; ")) else ""))
})

#' Every response sequence of a trial with looks at `looks`, each look judged by the posterior probability itself.
.n84_enumerate <- function(p, looks, a, b, p0, lambda, gamma, eta = NULL) {
  N <- looks[length(looks)]; L <- length(looks)
  succ <- 0; fut <- 0; eff <- 0; en <- 0; stop_at <- numeric(L)
  for (code in 0:(2^N - 1)) {
    bits <- bitwAnd(bitwShiftR(code, 0:(N - 1)), 1L)
    w <- prod(ifelse(bits == 1L, p, 1 - p))
    outcome <- NULL
    for (i in seq_len(L)) {
      n <- looks[i]; x <- sum(bits[seq_len(n)]); post <- 1 - stats::pbeta(p0, a + x, b + n - x)
      if (i == L) { outcome <- if (post >= lambda) "success" else "fail"; break }
      if (post < lambda * (n / N)^gamma) { outcome <- "futility"; break }
      if (!is.null(eta) && post >= 1 - (1 - lambda) * (n / N)^eta) { outcome <- "efficacy"; break }
    }
    stop_n <- looks[i]
    en <- en + w * stop_n
    if (outcome == "success") succ <- succ + w else if (outcome == "futility") fut <- fut + w else if (outcome == "efficacy") { succ <- succ + w; eff <- eff + w }
    stop_at[i] <- stop_at[i] + w
  }
  list(success = succ, futility = fut, efficacy = eff, expectedN = en, stopAt = stop_at)
}

vcr_case("N84b", c("AC-30"), function() {
  looks <- c(4L, 8L, 12L); worst <- 0; text <- character()
  for (setup in list(list(lambda = 0.9, gamma = 1, eta = NULL, prior = NULL), list(lambda = 0.85, gamma = 0.5, eta = 1, prior = NULL), list(lambda = 0.8, gamma = 2, eta = 0.5, prior = c(1, 1)))) {
    design <- list(kind = "bop2", maxN = 12, lookEvery = 4, bop2 = c(list(lambda = setup$lambda, gamma = setup$gamma), if (!is.null(setup$eta)) list(efficacyEta = setup$eta)))
    if (!is.null(setup$prior)) design$prior <- list(a = setup$prior[1], b = setup$prior[2])
    r <- .n84_job(design, truth = list(nullRate = 0.2, alternativeRate = 0.5))
    a <- if (is.null(setup$prior)) 0.2 else setup$prior[1]; b <- if (is.null(setup$prior)) 0.8 else setup$prior[2]
    for (role in c("null", "alternative")) {
      p <- if (identical(role, "null")) 0.2 else 0.5
      ref <- .n84_enumerate(p, looks, a, b, 0.2, setup$lambda, setup$gamma, setup$eta)
      op <- .n84_op(r, role)$cells
      got <- c(op[[if (identical(role, "null")) "type_one_error" else "power"]]$value, op$expected_sample_size$value, op$futility_stop_probability$value)
      want <- c(ref$success, ref$expectedN, ref$futility)
      worst <- max(worst, abs(got - want))
    }
    text <- c(text, sprintf("lambda %.2f gamma %.1f%s: type I %.4f, power %.4f", setup$lambda, setup$gamma, if (is.null(setup$eta)) "" else sprintf(" eta %.1f", setup$eta),
                            .n84_op(r, "null")$cells$type_one_error$value, .n84_op(r, "alternative")$cells$power$value))
  }
  list(pass = worst < 1e-12, detail = sprintf("3 designs (a prior given or not; an efficacy stop or not) on all 4096 response sequences of a 12-patient trial, 0.2 against 0.5: max|d| %.1e in type I error, power, expected size and the futility-stop probability (%s)", worst, paste(text, collapse = "; ")))
})

vcr_case("N84c", c("AC-29"), function() {
  if (!requireNamespace("BOP2FE", quietly = TRUE)) stop("N84 requires the locked BOP2FE library")
  nsim <- 50000L; p0 <- 0.1; p1 <- 0.3
  r <- .n84_job(list(kind = "bop2", maxN = 40, lookEvery = 10, bop2 = list(lambda = 0.9, gamma = 1, efficacyEta = 1)), truth = list(nullRate = p0, alternativeRate = p1))
  oc <- BOP2FE::get_boundary_oc_binary(p0, p1, c(10, 10, 10, 10), nsim, lambda = 0.9, gamma = 1, eta = 1, method = "power", seed = 8403)
  mine <- list(null = .n84_op(r, "null")$cells, alt = .n84_op(r, "alternative")$cells)
  pairs <- list(
    c(mine$null$type_one_error$value, oc$rejectnull_mean_h0), c(mine$alt$power$value, oc$rejectnull_mean_h1),
    c(mine$null$futility_stop_probability$value, oc$earlystopfuti_mean_h0), c(mine$alt$futility_stop_probability$value, oc$earlystopfuti_mean_h1),
    c(mine$null$early_stop_efficacy_probability$value, oc$earlystopsupe_mean_h0), c(mine$alt$early_stop_efficacy_probability$value, oc$earlystopsupe_mean_h1))
  z <- vapply(pairs, function(x) abs(x[1] - x[2]) / sqrt(max(x[1] * (1 - x[1]), 1e-6) / nsim), numeric(1))
  # the expected size is a mean of 10-to-40 patients with a standard deviation of at most 15: its error is at most 15 / sqrt(nsim)
  en <- c(abs(mine$null$expected_sample_size$value - oc$ss_mean_h0), abs(mine$alt$expected_sample_size$value - oc$ss_mean_h1)) / (15 / sqrt(nsim))
  list(pass = max(z) < 4 && max(en) < 4,
       detail = sprintf("lambda 0.9, gamma 1, eta 1, 40 patients every 10, 0.1 against 0.3: type I %.4f vs BOP2FE %.4f, power %.4f vs %.4f, futility stop %.3f/%.3f vs %.3f/%.3f, efficacy stop %.3f/%.3f vs %.3f/%.3f, expected size %.2f/%.2f vs %.2f/%.2f (%d simulated trials; worst %.2f errors)",
                        pairs[[1]][1], pairs[[1]][2], pairs[[2]][1], pairs[[2]][2], pairs[[3]][1], pairs[[4]][1], pairs[[3]][2], pairs[[4]][2], pairs[[5]][1], pairs[[6]][1], pairs[[5]][2], pairs[[6]][2],
                        mine$null$expected_sample_size$value, mine$alt$expected_sample_size$value, oc$ss_mean_h0, oc$ss_mean_h1, nsim, max(z, en)))
})

vcr_case("N84d", c("AC-30"), function() {
  r <- .n84_job(list(kind = "bop2", maxN = 40, lookEvery = 10), analysis = list(alpha = 0.05, power = 0.8))
  simon <- .n84_b(r)$baselines$simon$optimal
  saving <- vcr_measure_value(r, "expected_sample_size_saving_null"); en0 <- .n84_op(r, "null")$cells$expected_sample_size$value
  published <- simon$n1 == 10 && simon$r1 == 1 && simon$n == 29 && simon$r == 5 && abs(simon$expectedN0 - 15.0) < 0.05
  # expected size under the alternative by the binomial: 10 + (1 - P(X <= 1 of 10)) * 19
  en1 <- 10 + (1 - stats::pbinom(1, 10, 0.3)) * 19
  list(pass = published && abs(saving - (simon$expectedN0 - en0)) < 1e-12 && abs(simon$expectedN1 - en1) < 1e-12 && !is.null(.n84_b(r)$baselines$simon$minimax),
       detail = sprintf("Simon's optimal design at 0.1 against 0.3, alpha 0.05, power 0.8: %d/%d then %d/%d, expected size %.2f under the null (Simon 1989: 1/10, 5/29, 15.0) and %.2f under the alternative; the BOP2 design the max-power search found has expected size %.2f under the null: saving %.2f = the difference of the two",
                        simon$r1, simon$n1, simon$r, simon$n, simon$expectedN0, simon$expectedN1, en0, saving))
})

vcr_case("N84e", c("AC-30", "AC-29"), function() {
  looks <- c(10L, 20L, 30L, 40L); p0 <- 0.1; p1 <- 0.3; alpha <- 0.05; target <- 0.8
  pp <- lapply(looks, function(n) .vcr_bd_pp(p0, p0, 1 - p0, n)); tr0 <- .vcr_bd_transitions(p0, looks); tr1 <- .vcr_bd_transitions(p1, looks)
  oc <- function(l, g) { bd <- vcr_bop2_boundaries(pp, looks, l, g, NULL); list(t1 = .vcr_bd_oc(tr0, looks, bd$fut, bd$eff, bd$succ), pw = .vcr_bd_oc(tr1, looks, bd$fut, bd$eff, bd$succ)) }
  grid <- expand.grid(l = seq(0.5, 0.99, by = 0.01), g = c(0.25, 0.5, 1, 1.5, 2))
  all_oc <- lapply(seq_len(nrow(grid)), function(i) oc(grid$l[i], grid$g[i]))
  t1 <- vapply(all_oc, function(o) o$t1$success, numeric(1)); pw <- vapply(all_oc, function(o) o$pw$success, numeric(1)); en0 <- vapply(all_oc, function(o) o$t1$expectedN, numeric(1))
  by_power <- .n84_job(list(kind = "bop2", maxN = 40, lookEvery = 10, objective = "max_power"), analysis = list(alpha = alpha, power = target))
  by_size <- .n84_job(list(kind = "bop2", maxN = 40, lookEvery = 10, objective = "min_expected_n"), analysis = list(alpha = alpha, power = target))
  best_power <- max(pw[t1 <= alpha + 1e-12]); reach <- t1 <= alpha + 1e-12 & pw >= target - 1e-12
  mp <- .n84_op(by_power, "alternative")$cells$power$value; mt <- .n84_op(by_power, "null")$cells$type_one_error$value
  sp <- .n84_op(by_size, "alternative")$cells$power$value; se0 <- .n84_op(by_size, "null")$cells$expected_sample_size$value
  list(pass = mt <= alpha + 1e-12 && mp >= best_power - 1e-12 && sp >= target - 1e-12 && se0 <= min(en0[reach]) + 1e-12 && se0 <= .n84_op(by_power, "null")$cells$expected_sample_size$value + 1e-12 &&
         identical(.n84_b(by_size)$objective, "min_expected_n"),
       detail = sprintf("%d (lambda, gamma) pairs on a grid the search did not use: none with type I <= %.2f beats the returned power %.4f (best %.4f); the fewest-patients objective returns power %.4f >= %.2f with %.2f expected patients under the null (the best on that grid %.2f; the max-power design has %.2f)",
                        nrow(grid), alpha, mp, best_power, sp, target, se0, min(en0[reach]), .n84_op(by_power, "null")$cells$expected_sample_size$value))
})
