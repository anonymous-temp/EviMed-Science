# N87 — hierarchical composite endpoints compared by win ratio (algorithm round T9, 2026-11-03): design.win_ratio.
#
# "死亡、住院次数、KCCQ 三层比较，要多少人，平局占多少": people are compared pair by pair on death, then on the number of events, then on a
# score; the result is the win ratio, the win difference, the win odds, the share of ties and the power of the Finkelstein-Schoenfeld test.
# The engine writes its own simulation (winratiosim takes 0.4 s a trial) and is held to things that are not its code:
#
#   a  a pair-by-pair loop in plain R, written apart from the engine, on people who drop out (all three levels, thresholds, to the last pair and to
#      the test statistic)
#   b  hce::calcWO on the same uncensored people, put on the single scale of ranks hce takes: the same wins, losses, ties and win odds
#   c  exact win, loss and tie probabilities of independent levels (exponential deaths, negative-binomial counts, a normal score with a threshold)
#   d  the type I error of the permutation test, and the permutation variance of the statistic from relabelling the arms
#   e  the job: one and two cores give the same bits, a spent CPU budget keeps the batches that ran, the size that reaches a power wanted is
#      checked by running at it, a null scenario cannot be sized
#   f  hce::sizeWR, a published formula, against the simulated power at the size it gives (reported with its gap; the formula is held to a
#      loose band, the engine to its own error)
#   g  the sign of the shared factor at a correlation above 0 (a sicker person dies earlier, has more events and a lower score): closed forms
#      for the survivors' mean score and mean event count, and the power and win difference of a generator written apart from the engine's
#      (every other case here is at correlation 0, or at the null, where the sign cannot move a number)
#   h  a share of ties is never below 0 (sums of shares left -1e-16 in a third of the trials of a design with no possible tie)

.n87_scenario <- function(n = 60, dropout = 0.1, followup = 12, events = TRUE, score = TRUE, rho = 0.3, hr = 0.7, rr = 0.8, shift = 0.4, thr = 0.1,
                          risk = 0.3, theta = 1, rate = 0.08, sd = 1) {
  truth <- list(death = list(controlRisk = risk, hazardRatio = hr), correlation = rho)
  if (events) truth$events <- list(controlRate = rate, rateRatio = rr, overdispersion = theta)
  if (score) truth$score <- list(shift = shift, sd = sd, threshold = thr)
  list(design = list(nTreat = n, nControl = n, followup = followup, dropoutAnnual = dropout), truth = truth, analysis = list(alpha = 0.025, sided = 1))
}

# the reference: every pair compared by a loop that reads the rules, level by level
.n87_loop_pairs <- function(p, d) {
  N <- length(d$x); res <- matrix(0L, N, N)
  for (i in seq_len(N)) for (j in seq_len(N)) if (i != j) {
    r <- 0L
    if (d$died[j] && d$dx[j] <= d$x[i]) r <- r + 1L
    if (d$died[i] && d$dx[i] <= d$x[j]) r <- r - 1L
    if (r == 0L && p$has_events) {
      w <- min(d$x[i], d$x[j]); ci <- sum(d$events[i, ] <= w); cj <- sum(d$events[j, ] <= w)
      if (ci != cj) r <- if (ci < cj) 1L else -1L
    }
    if (r == 0L && p$has_score && !is.na(d$score[i]) && !is.na(d$score[j])) {
      df <- d$score[i] - d$score[j]
      if (df > p$thr) r <- 1L else if (df < -p$thr) r <- -1L
    }
    res[i, j] <- r
  }
  res
}

vcr_case("N87a", c("AC-29", "AC-30"), function() {
  worst_z <- 0; same <- TRUE; cells <- 0L
  for (cfg in list(list(seed = 8701L, ev = TRUE, sc = TRUE, thr = 0.1), list(seed = 8702L, ev = TRUE, sc = FALSE, thr = 0), list(seed = 8703L, ev = FALSE, sc = TRUE, thr = 0.3),
                   list(seed = 8704L, ev = TRUE, sc = TRUE, thr = 0))) {
    sc <- .n87_scenario(n = 45, dropout = 0.35, followup = 12, events = cfg$ev, score = cfg$sc, thr = cfg$thr, risk = 0.4, rate = 0.15)
    p <- .vcr_wr_read(sc)
    set.seed(cfg$seed, kind = VCR_RNG_KIND); d <- .vcr_wr_draw(p, 45L, 45L)
    ref <- .n87_loop_pairs(p, d)
    lv <- .vcr_wr_levels(p, d); L <- length(lv); code <- 0L
    for (k in seq_len(L)) code <- code + as.integer(3^(L - k)) * lv[[k]]
    mine <- (code > 0L) - (code < 0L)
    same <- same && identical(unname(mine), unname(ref)) && all(mine == -t(mine))
    cells <- cells + length(ref)
    # the trial's statistic from the same stream
    set.seed(cfg$seed, kind = VCR_RNG_KIND); tr <- .vcr_wr_trial(p, 45L, 45L)
    tc <- 46:90; cc <- 1:45
    u <- rowSums(ref); N <- 90L
    z_ref <- sum(u[cc]) / sqrt(45 * 45 / (N * (N - 1)) * sum(u^2))
    b <- ref[cc, tc]
    worst_z <- max(worst_z, abs(tr[["z"]] - z_ref), abs(tr[["win"]] - mean(b == 1L)), abs(tr[["loss"]] - mean(b == -1L)), abs(tr[["tie"]] - mean(b == 0L)))
  }
  # (the loop's first 45 are the treated people: arm 1 comes first in a trial)
  list(pass = same && worst_z < 1e-12,
       detail = sprintf("4 configurations (death with %s, dropout 35%%, thresholds 0 to 0.3), %d ordered pairs: the matrix of every pair equals the plain-R loop (%s) and is antisymmetric; the trial's statistic, wins, losses and ties equal the loop's to %.1e",
                        "events and/or a score", cells, same, worst_z))
})

vcr_case("N87b", c("AC-29"), function() {
  if (!requireNamespace("hce", quietly = TRUE)) return(list(pass = FALSE, detail = "hce (the cross-check package) is not installed"))
  worst <- 0; ties_seen <- 0
  for (seed in c(8711L, 8712L, 8713L)) {
    sc <- .n87_scenario(n = 120, dropout = 0, followup = 12, thr = 0, risk = 0.25, rate = 0.1, sd = 2.5)
    p <- .vcr_wr_read(sc)
    set.seed(seed, kind = VCR_RNG_KIND); d <- .vcr_wr_draw(p, 120L, 120L)
    d$score <- round(d$score)                                   # whole-number scores tie, so the tie share is not zero
    lv <- .vcr_wr_levels(p, d); code <- 9L * lv$death + 3L * lv$events + lv$score; res <- (code > 0L) - (code < 0L)
    tr <- 1:120; co <- 121:240
    nw <- sum(res[tr, co] == 1L); nl <- sum(res[tr, co] == -1L); nt <- 120 * 120 - nw - nl
    # hce takes one scale of ranks and no censoring: deaths first by time, then survivors by fewer events and a higher score
    ne <- rowSums(is.finite(d$events))
    key <- ifelse(d$died, 0, 1)
    ord <- order(key, ifelse(d$died, d$dx, 0), -ne, d$score)
    # equal (events, score) among survivors tie; deaths never tie (continuous times)
    grp <- paste(key, ifelse(d$died, d$dx, 0), -ne, d$score)[ord]
    aval <- numeric(length(ord)); aval[ord] <- cumsum(c(TRUE, grp[-1L] != grp[-length(grp)]))
    df <- data.frame(AVAL = aval, TRTP = ifelse(d$arm == 1L, "A", "P"))
    ref <- hce::calcWO(df, AVAL = "AVAL", TRTP = "TRTP", ref = "P")
    wp <- (nw + nt / 2) / (120 * 120); wo <- (nw + nt / 2) / (nl + nt / 2)
    worst <- max(worst, abs(ref$WP - wp), abs(ref$WO - wo))
    ties_seen <- ties_seen + nt
  }
  list(pass = worst < 1e-12 && ties_seen > 0,
       detail = sprintf("3 uncensored samples of 120 + 120 people (death, events, whole-number scores; %d tied pairs in all): hce::calcWO on the single scale of ranks gives the win probability and the win odds of the engine's pair counts to %.1e", ties_seen, worst))
})

# the exact pair probabilities of three independent levels, no dropout
.n87_exact <- function(risk, hr, followup, rate, rr, theta, shift, sd, thr) {
  h0 <- -log1p(-risk) / followup; hT <- h0 * hr; s <- h0 + hT
  w1 <- h0 / s * (1 - exp(-s * followup)); l1 <- hT / s * (1 - exp(-s * followup)); t1 <- exp(-s * followup)
  k <- 0:400
  pmf <- function(mu) if (theta > 0) stats::dnbinom(k, size = 1 / theta, mu = mu) else stats::dpois(k, mu)
  pT <- pmf(rate * rr * followup); pC <- pmf(rate * followup)
  cumC <- cumsum(pC)
  pt_less <- sum(pT * (1 - cumC)); pt_more <- sum(pC * (1 - cumsum(pT)))
  t2 <- 1 - pt_less - pt_more
  dif_sd <- sd * sqrt(2)
  w3 <- 1 - stats::pnorm((thr - shift) / dif_sd); l3 <- stats::pnorm((-thr - shift) / dif_sd); t3 <- 1 - w3 - l3
  c(win = w1 + t1 * (pt_less + t2 * w3), loss = l1 + t1 * (pt_more + t2 * l3), tie = t1 * t2 * t3,
    w1 = w1, l1 = l1, w2 = t1 * pt_less, l2 = t1 * pt_more, w3 = t1 * t2 * w3, l3 = t1 * t2 * l3)
}

vcr_case("N87c", c("AC-29"), function() {
  worst <- 0; rows <- character(0)
  for (cfg in list(list(hr = 0.7, rr = 0.8, theta = 1, shift = 0.3, thr = 0.8, risk = 0.3, seed = 8721L), list(hr = 1, rr = 0.6, theta = 0.5, shift = 0, thr = 0.25, risk = 0.2, seed = 8722L),
                   list(hr = 0.5, rr = 1, theta = 0, shift = 0.6, thr = 0, risk = 0.4, seed = 8723L))) {
    sc <- .n87_scenario(n = 80, dropout = 0, followup = 12, rho = 0, hr = cfg$hr, rr = cfg$rr, shift = cfg$shift, thr = cfg$thr, risk = cfg$risk, theta = cfg$theta, rate = 0.1)
    job <- list(scenario = sc, seed = cfg$seed, replicates = 1500L, cores = vcr_cores(NULL), cpuSecondsLimit = 600)
    r <- vcr_job_design_win_ratio(job)
    ex <- .n87_exact(cfg$risk, cfg$hr, 12, 0.1, cfg$rr, cfg$theta, cfg$shift, 1, cfg$thr)
    cells <- r$diagnostics$winRatio$cells
    lv <- r$diagnostics$winRatio$byLevel
    got <- c(win = cells$win_proportion$value, loss = cells$loss_proportion$value, tie = cells$tie_proportion$value,
             w1 = lv[[1]]$cells$win_proportion$value, l1 = lv[[1]]$cells$loss_proportion$value, w2 = lv[[2]]$cells$win_proportion$value, l2 = lv[[2]]$cells$loss_proportion$value,
             w3 = lv[[3]]$cells$win_proportion$value, l3 = lv[[3]]$cells$loss_proportion$value)
    se <- c(cells$win_proportion$mcse, cells$loss_proportion$mcse, cells$tie_proportion$mcse, lv[[1]]$cells$win_proportion$mcse, lv[[1]]$cells$loss_proportion$mcse,
            lv[[2]]$cells$win_proportion$mcse, lv[[2]]$cells$loss_proportion$mcse, lv[[3]]$cells$win_proportion$mcse, lv[[3]]$cells$loss_proportion$mcse)
    z <- abs(got - ex[names(got)]) / pmax(se, 1e-12)
    worst <- max(worst, z)
    rows <- c(rows, sprintf("HR %.1f/rate ratio %.1f/shift %.1f: win %.4f (%.4f) loss %.4f (%.4f) tie %.4f (%.4f)", cfg$hr, cfg$rr, cfg$shift, got[["win"]], ex[["win"]], got[["loss"]], ex[["loss"]], got[["tie"]], ex[["tie"]]))
  }
  list(pass = worst < 4.5, detail = sprintf("independent levels (correlation 0, no dropout), 1,500 trials of 80 + 80 each: simulated (exact) %s; the nine proportions of each (overall and by level) are within %.2f of their Monte-Carlo errors", paste(rows, collapse = "; "), worst))
})

vcr_case("N87d", c("AC-28", "AC-29"), function() {
  # (1) the type I error of the test, with dropout and correlation, through the job; (2) the permutation variance
  sc <- .n87_scenario(n = 120, dropout = 0.1, followup = 12, hr = 1, rr = 1, shift = 0, thr = 0.1, rho = 0.4)
  r <- vcr_test_run(vcr_test_job("design.win_ratio", sc, seed = 8731L, replicates = 6000L, cores = vcr_cores(NULL)))
  m <- Filter(function(x) identical(x$name, "type_one_error"), r$measures)
  alpha_hat <- if (length(m)) m[[1]]$value else NA_real_
  se <- if (length(m)) m[[1]]$mcse else NA_real_
  # the variance: fixed people, many relabellings
  p <- .vcr_wr_read(.n87_scenario(n = 70, dropout = 0.2, followup = 12, hr = 1, rr = 1, shift = 0, thr = 0.1, risk = 0.3))
  set.seed(8732L, kind = VCR_RNG_KIND); d <- .vcr_wr_draw(p, 70L, 70L)
  lv <- .vcr_wr_levels(p, d); code <- 9L * lv$death + 3L * lv$events + lv$score; res <- (code > 0L) - (code < 0L)
  u <- rowSums(res); N <- 140L
  set.seed(8733L)
  perm <- vapply(seq_len(40000L), function(i) sum(u[sample.int(N, 70L)]), numeric(1))
  v_formula <- 70 * 70 / (N * (N - 1)) * sum(u^2)
  rel <- abs(stats::var(perm) / v_formula - 1); rel_se <- sqrt(2 / (length(perm) - 1))
  list(pass = identical(r$status, "succeeded") && length(m) == 1L && abs(alpha_hat - 0.025) < 4 * se + 0.004 && rel < 4 * rel_se && abs(mean(perm)) < 4 * sqrt(v_formula / length(perm)),
       detail = sprintf("type I error with 10%% dropout and correlation 0.4, 120 + 120 people, 6,000 trials: %.4f (error %.4f) against 0.025; 40,000 relabellings of the arms of 70 + 70 people: variance %.1f, the formula n1 n0 sum(U^2) / (N (N - 1)) gives %.1f (%.2f%% apart, error %.2f%%), mean %.2f",
                        alpha_hat, se, stats::var(perm), v_formula, 100 * rel, 100 * rel_se, mean(perm)))
})

vcr_case("N87e", c("AC-31", "AC-28"), function() {
  sc <- .n87_scenario(n = 70, dropout = 0.1)
  sc_hash <- function(cores) {
    r <- vcr_test_run(vcr_test_job("design.win_ratio", sc, seed = 8741L, replicates = 200L, cores = cores))
    vcr_sha256(vcr_canonical_json(r$measures))
  }
  same_cores <- identical(sc_hash(1L), sc_hash(2L))
  full <- vcr_test_run(vcr_test_job("design.win_ratio", sc, seed = 8741L, replicates = 200L, cores = 1L))
  # the CPU budget ends the run between batches and keeps the ones that finished
  cut <- vcr_test_run(vcr_test_job("design.win_ratio", .n87_scenario(n = 400, dropout = 0.1), seed = 8742L, replicates = 100000L, cores = 1L, extra = list(cpuSecondsLimit = 3)))
  kept <- cut$diagnostics$replicatesCompleted
  # the size searched for a power wanted, then run at that size with other random numbers
  ss <- .n87_scenario(n = 100, dropout = 0.05, events = FALSE, shift = 0.6, hr = 0.8, thr = 0.1); ss$design$nTreat <- NULL; ss$design$nControl <- NULL; ss$analysis$power <- 0.8
  sr <- vcr_test_run(vcr_test_job("design.win_ratio", ss, seed = 8743L, replicates = 1500L, cores = vcr_cores(NULL)))
  need <- Filter(function(x) identical(x$name, "required_per_arm"), sr$measures)[[1]]$value
  at <- .n87_scenario(n = need, dropout = 0.05, events = FALSE, shift = 0.6, hr = 0.8, thr = 0.1)
  chk <- vcr_test_run(vcr_test_job("design.win_ratio", at, seed = 8744L, replicates = 2000L, cores = vcr_cores(NULL)))
  pw <- Filter(function(x) identical(x$name, "power"), chk$measures)[[1]]
  # a scenario with no effect at any level cannot be sized
  nul <- .n87_scenario(n = 100, hr = 1, rr = 1, shift = 0); nul$design$nTreat <- NULL; nul$design$nControl <- NULL; nul$analysis$power <- 0.9
  nr <- vcr_test_run(vcr_test_job("design.win_ratio", nul, seed = 8745L, replicates = 500L, cores = 1L))
  # a size above the cap is refused by name, from the pilot, without running a trial of that size
  tiny <- .n87_scenario(n = 100, events = FALSE, hr = 0.99, shift = 0.01); tiny$design$nTreat <- NULL; tiny$design$nControl <- NULL; tiny$analysis$power <- 0.9; tiny$design$maxPerArm <- 100
  tr_ <- vcr_test_run(vcr_test_job("design.win_ratio", tiny, seed = 8747L, replicates = 500L, cores = 1L))
  bare <- .n87_scenario(n = 40); bare$truth$correlation <- NULL; bare$truth$events$overdispersion <- NULL; bare$truth$score$sd <- NULL; bare$truth$score$threshold <- NULL
  bare_run <- vcr_test_run(vcr_test_job("design.win_ratio", bare, seed = 8746L, replicates = 100L, cores = 1L))
  assumed <- vapply(bare_run$diagnostics$winRatio$assumed, function(a) a$key, character(1))
  list(pass = same_cores && identical(full$status, "succeeded") && identical(cut$conclusion, "limited") && "cpu_budget_exhausted" %in% vcr_test_issue_codes(cut) && kept >= 20L && kept < 100000L &&
         identical(sr$status, "succeeded") && abs(pw$value - 0.8) < 4 * pw$mcse + 0.03 && identical(nr$status, "failed") && "design_effect_null" %in% vcr_test_issue_codes(nr) && identical(tr_$status, "failed") && "design_not_computable" %in% vcr_test_issue_codes(tr_) &&
         all(c("truth.events.overdispersion", "truth.correlation", "truth.score.sd", "truth.score.threshold", "method.test") %in% assumed),
       detail = sprintf("1 and 2 cores give the same measures (%s); a 3 s CPU budget on a 400 + 400 trial kept %d trials and is limited (cpu_budget_exhausted); the size for 80%% power is %d per arm and a run at it gives %.3f (error %.3f); a null scenario cannot be sized (design_effect_null) and a size above the cap is refused from the pilot (design_not_computable); defaults listed: %s",
                        same_cores, kept, as.integer(need), pw$value, pw$mcse, paste(assumed, collapse = ", ")))
})

vcr_case("N87f", c("AC-29"), function() {
  # the published formula (hce::sizeWR, the k-based coefficient of Yu and Ganju) against the simulated power at the size it gives
  if (!requireNamespace("hce", quietly = TRUE)) return(list(pass = FALSE, detail = "hce (the cross-check package) is not installed"))
  want_wr <- 1.5; want_ties <- 0.3
  f <- hce::sizeWR(WR = want_wr, power = 0.8, Pties = want_ties, alpha = 0.05)
  w <- (1 - want_ties) * want_wr / (1 + want_wr); l <- (1 - want_ties) / (1 + want_wr)
  # one normal score with a threshold gives any pair of win and loss probabilities: solve for the shift and the threshold
  g <- function(par) { s <- par[1]; th <- par[2]; c(1 - stats::pnorm((th - s) / sqrt(2)) - w, stats::pnorm((-th - s) / sqrt(2)) - l) }
  best <- stats::optim(c(0.3, 0.3), function(par) sum(g(par)^2), method = "Nelder-Mead", control = list(reltol = 1e-14, abstol = 1e-16, maxit = 2000))
  shift <- best$par[1]; thr <- abs(best$par[2])
  n_each <- ceiling(f$SampleSize / 2)
  sc <- list(design = list(nTreat = n_each, nControl = n_each, followup = 12), truth = list(death = list(controlRisk = 0.001, hazardRatio = 1), score = list(shift = shift, sd = 1, threshold = thr), correlation = 0),
             analysis = list(alpha = 0.025, sided = 2))
  sc$analysis$alpha <- 0.05
  r <- vcr_job_design_win_ratio(list(scenario = sc, seed = 8761L, replicates = 700L, cores = vcr_cores(NULL), cpuSecondsLimit = 600))
  pw <- Filter(function(x) identical(x$name, "power"), r$measures)[[1]]
  cells <- r$diagnostics$winRatio$cells
  list(pass = abs(cells$win_ratio$value - want_wr) < 0.06 && abs(cells$tie_proportion$value - want_ties) < 0.02 && abs(pw$value - 0.8) < 4 * pw$mcse + 0.1,
       detail = sprintf("a win ratio of %.2f with %.0f%% ties (one score with a threshold: shift %.3f, threshold %.3f, simulated ratio %.3f, ties %.3f): hce::sizeWR gives %d people for 80%% power at two-sided 0.05; the simulation at that size gives %.3f (error %.3f), a gap of %+.3f from the formula's 0.80",
                        want_wr, 100 * want_ties, shift, thr, cells$win_ratio$value, cells$tie_proportion$value, as.integer(f$SampleSize), pw$value, pw$mcse, pw$value - 0.8))
})


# a generator written apart from the engine's: one standard-normal "sickness" per person, one latent normal per level that reads it with the
# loading sqrt(rho), and the levels built from their definitions (a survival probability, a Poisson count with uniform times, a normal score)
.n87g_people <- function(p, n1, n0) {
  N <- n1 + n0; z <- c(rep(1L, n1), rep(0L, n0)); sick <- stats::rnorm(N)
  lat <- function() sqrt(p$rho) * sick + sqrt(1 - p$rho) * stats::rnorm(N)
  td <- -log(stats::pnorm(lat())) / (p$h0 * ifelse(z == 1L, p$hr, 1))   # a high latent value is a survival probability near 1: an early death
  tc <- if (p$drop > 0) stats::rexp(N, p$drop) else rep(Inf, N)
  x <- pmin(td, tc, p$tau); died <- td <= pmin(tc, p$tau)
  d <- list(arm = z, x = x, died = died, dx = ifelse(died, td, Inf), events = NULL, score = NULL)
  if (p$has_events) {
    frailty <- stats::qgamma(stats::pnorm(lat()), shape = 1 / p$theta, scale = p$theta)
    count <- stats::rpois(N, p$rate0 * ifelse(z == 1L, p$rr, 1) * frailty * x)
    E <- matrix(Inf, N, VCR_WR_EVENT_SLOTS)
    for (i in which(count > 0L)) { k <- min(count[i], VCR_WR_EVENT_SLOTS); E[i, seq_len(k)] <- sort(stats::runif(k, 0, x[i])) }
    d$events <- E
  }
  if (p$has_score) {
    s <- -p$sd * lat() + p$shift * z
    s[!((td > p$tau) & (tc > p$tau))] <- NA_real_
    d$score <- s
  }
  d
}

vcr_case("N87g", c("AC-29", "AC-28"), function() {
  rho <- 0.6; risk <- 0.25; rate <- 0.05; fu <- 24
  sc <- list(design = list(nTreat = 150, nControl = 150, followup = fu), truth = list(death = list(controlRisk = risk, hazardRatio = 1),
             events = list(controlRate = rate, rateRatio = 1, overdispersion = 1), score = list(shift = 0), correlation = rho), analysis = list(alpha = 0.025, sided = 1))
  p <- .vcr_wr_read(sc)
  # (1) closed forms for the people who survive. Death time, events and score read the factor through latent normals X_d, X_e, X_s with
  # corr(X_d, X_s) = rho and corr(X_d, X_e) = -rho (a later death goes with a higher score and with fewer events). A survivor has X_d > c with
  # c = qnorm(risk), so E[score | survivor] = rho * phi(c) / (1 - Phi(c)) and E[events | survivor] = rate * followup * E[frailty | X_d > c].
  set.seed(8771L, kind = VCR_RNG_KIND); d <- .vcr_wr_draw(p, 8000L, 8000L)
  ne <- rowSums(is.finite(d$events)); surv <- !d$died
  cut <- stats::qnorm(risk)
  score_ref <- rho * stats::dnorm(cut) / (1 - stats::pnorm(cut))
  inner <- function(x) vapply(x, function(xx) stats::integrate(function(y) stats::qgamma(pmin(stats::pnorm(y), 1 - 1e-15), shape = 1, scale = 1) * stats::dnorm(y, -rho * xx, sqrt(1 - rho^2)), -9, 7, rel.tol = 1e-9)$value, numeric(1))
  frailty_ref <- stats::integrate(function(x) stats::dnorm(x) * inner(x), cut, 8, rel.tol = 1e-8)$value / (1 - stats::pnorm(cut))
  events_ref <- rate * fu * frailty_ref
  z_score <- (mean(d$score[surv]) - score_ref) / (stats::sd(d$score[surv]) / sqrt(sum(surv)))
  z_events <- (mean(ne[surv]) - events_ref) / (stats::sd(ne[surv]) / sqrt(sum(surv)))
  # the people who died had more events per unit of follow-up than the survivors
  rate_of <- function(i) { r <- sum(ne[i]) / sum(d$x[i]); c(r, sqrt(sum((ne[i] - r * d$x[i])^2)) / sum(d$x[i])) }
  rd <- rate_of(d$died); ra <- rate_of(surv)
  z_rate <- (rd[1] - ra[1]) / sqrt(rd[2]^2 + ra[2]^2)
  # (2) power and win difference at HR 0.8, rate ratio 0.8, shift 0.2, correlation 0.6: the engine's job against 1,000 trials of the apart generator
  sc$truth$death$hazardRatio <- 0.8; sc$truth$events$rateRatio <- 0.8; sc$truth$score$shift <- 0.2
  p2 <- .vcr_wr_read(sc)
  set.seed(8772L)
  m <- t(vapply(seq_len(1000L), function(i) {
    dd <- .n87g_people(p2, 150L, 150L); lv <- .vcr_wr_levels(p2, dd); L <- length(lv); code <- 0L
    for (k in seq_len(L)) code <- code + as.integer(3^(L - k)) * lv[[k]]
    res <- (code > 0L) - (code < 0L); u <- rowSums(res); N <- 300L
    b <- res[1:150, 151:300]
    c(z = sum(u[1:150]) / sqrt(150 * 150 / (N * (N - 1)) * sum(u^2)), diff = mean(b == 1L) - mean(b == -1L))
  }, numeric(2)))
  pw_ref <- mean(m[, "z"] > stats::qnorm(0.975)); pw_se <- sqrt(pw_ref * (1 - pw_ref) / nrow(m))
  df_ref <- mean(m[, "diff"]); df_se <- stats::sd(m[, "diff"]) / sqrt(nrow(m))
  r <- vcr_test_run(vcr_test_job("design.win_ratio", sc, seed = 8773L, replicates = 2000L, cores = vcr_cores(NULL)))
  pw <- Filter(function(x) identical(x$name, "power"), r$measures)[[1]]
  wd <- Filter(function(x) identical(x$name, "win_difference"), r$measures)[[1]]
  z_pw <- (pw$value - pw_ref) / sqrt(pw$mcse^2 + pw_se^2)
  z_wd <- (wd$value - df_ref) / sqrt(wd$mcse^2 + df_se^2)
  list(pass = abs(z_score) < 4 && abs(z_events) < 4 && z_rate > 4 && abs(z_pw) < 4 && abs(z_wd) < 4,
       detail = sprintf("correlation 0.6, 25%% control risk, 8,000 + 8,000 people: the survivors' mean score is %.3f against the closed form rho phi(c) / (1 - Phi(c)) = %.3f (z %.1f; the factor read the other way round gives %.3f) and their mean event count %.3f against %.3f from the frailty integral (z %.1f); the dead had %.3f events per unit of follow-up against %.3f for the survivors (z %.1f); HR 0.8, rate ratio 0.8, shift 0.2, 150 + 150 people: power %.3f (error %.3f) against %.3f (error %.3f) from 1,000 trials of a generator written apart from the engine's (z %.1f), win difference %.4f against %.4f (z %.1f); the factor read the wrong way round gave power 0.459 here",
                        mean(d$score[surv]), score_ref, z_score, -score_ref, mean(ne[surv]), events_ref, z_events, rd[1], ra[1], z_rate, pw$value, pw$mcse, pw_ref, pw_se, z_pw, wd$value, df_ref, z_wd))
})

vcr_case("N87h", c("AC-29"), function() {
  # a continuous score with no threshold and no events level cannot tie, so every share of ties is a rounding residue of 1 - wins - losses
  sc <- list(design = list(nTreat = 70, nControl = 70, followup = 12, dropoutAnnual = 0), truth = list(death = list(controlRisk = 0.3, hazardRatio = 0.8),
             score = list(shift = 0.4, sd = 1, threshold = 0), correlation = 0.3), analysis = list(alpha = 0.025, sided = 1))
  p <- .vcr_wr_read(sc)
  set.seed(8781L, kind = VCR_RNG_KIND)
  v <- do.call(rbind, lapply(seq_len(600L), function(i) .vcr_wr_trial(p, 70L, 70L)))
  rows <- .vcr_wr_level_rows(v, c("death", "score"))
  level_min <- min(vapply(rows, function(r) min(r$cells$tie_proportion$value), numeric(1)))
  r <- vcr_test_run(vcr_test_job("design.win_ratio", sc, seed = 8782L, replicates = 300L, cores = 1L))
  tie <- Filter(function(x) identical(x$name, "tie_proportion"), r$measures)[[1]]$value
  list(pass = min(v[, "tie"]) >= 0 && level_min >= 0 && tie >= 0,
       detail = sprintf("600 trials of 70 + 70 people with a continuous score and no threshold: the smallest share of ties in a trial is %.1e (it was -1.1e-16 in 105 of the 600 before the clamp), the smallest mean share by level %.1e, the job's reported share %.1e", min(v[, "tie"]), level_min, tie))
})

vcr_case("N87i", c("AC-28", "AC-31"), function() {
  # Review stats2 finding 11: a CPU budget that ended the run AFTER the size search had finished threw the size away ('before the first batch of trials; there
  # is no result', 5,000 trials 'requested'), so budgets of 6 to 10 s gave less than budgets of 1 to 5 s. The run after the search is stopped here by a stand-in that
  # finds no time (the budgets the review saw depend on the machine); the search ran for real. The size it found is kept, limited, not verified, with no count
  # of trials, and a job that is stopped before ANY trial runs names no count of replicates (it used to echo the 5,000 and the 200,000 it was asked for).
  ss <- .n87_scenario(n = 100, dropout = 0.05, events = FALSE, shift = 0.6, hr = 0.8, thr = 0.1); ss$design$nTreat <- NULL; ss$design$nControl <- NULL; ss$analysis$power <- 0.8
  want <- 1500L; orig <- .vcr_wr_run
  .vcr_wr_run <<- function(p, n1, n0, trials, ...) if (identical(as.integer(trials), want)) list(values = NULL, stopped = "cpu_budget") else orig(p, n1, n0, trials, ...)
  on.exit(.vcr_wr_run <<- orig, add = TRUE)
  kept <- vcr_test_run(vcr_test_job("design.win_ratio", ss, seed = 8743L, replicates = want, cores = 1L))
  .vcr_wr_run <<- orig
  size <- Filter(function(x) identical(x$name, "required_per_arm"), kept$measures)
  free <- vcr_test_run(vcr_test_job("design.win_ratio", ss, seed = 8743L, replicates = want, cores = 1L))
  free_size <- Filter(function(x) identical(x$name, "required_per_arm"), free$measures)[[1]]$value
  # no search, no time: nothing to keep, and no count claimed
  none <- vcr_test_run(vcr_test_job("design.win_ratio", .n87_scenario(n = 400, dropout = 0.1), seed = 8742L, replicates = 50000L, cores = 1L, extra = list(cpuSecondsLimit = 0.001)))
  dose <- vcr_test_run(vcr_test_job("design.dose", list(design = list(kind = "crm", compare = list("boin"), maxPatients = 30), truth = list(toxicity = list(0.05, 0.1, 0.2, 0.3, 0.45, 0.6))), seed = 8201L, replicates = 200000L, cores = 1L, extra = list(cpuSecondsLimit = 0.001)))
  list(pass = length(size) == 1L && identical(kept$status, "failed") && identical(kept$conclusion, "limited") && "cpu_budget_exhausted" %in% vcr_test_issue_codes(kept) && is.null(kept$replicates) &&
         size[[1]]$value == free_size && identical(kept$diagnostics$winRatio$search$verified, FALSE) &&
         identical(none$status, "failed") && length(none$measures) == 0L && is.null(none$replicates) && identical(dose$status, "failed") && length(dose$measures) == 0L && is.null(dose$replicates),
       detail = sprintf("the size search found %s per arm and the run after it found no time: the size is kept (%s, limited, not verified, %s trials counted) and equals the size of the unstopped job (%s); a win-ratio job and a dose-finding job stopped before any trial name no count of replicates (%s and %s; they used to echo 50,000 and 200,000)",
                        if (length(size)) size[[1]]$value else "none", kept$status, kept$replicates %||% "no", free_size, none$replicates %||% "none", dose$replicates %||% "none"))
})
