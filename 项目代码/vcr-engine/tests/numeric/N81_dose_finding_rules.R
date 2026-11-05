# N81 — the dose-finding rules (algorithm round T7, 2026-11-03): design.dose, design.kind three_plus_three, boin, keyboard, crm.
#
# The engine writes these designs itself (the packages are 80 to 100 times slower per trial), so each rule is held to something outside it:
#
#   a  BOIN: the escalate / de-escalate / eliminate tables for 36 patients equal BOIN::get.boundary for five targets (default and stated
#      safe and toxic rates, two elimination cut-offs), and the dose a trial ends on equals BOIN::select.mtd on 400 random trials
#      (tried and untried doses, eliminated doses, ties)
#   b  keyboard: the tables equal Keyboard::get.boundary.kb for four targets and key widths
#   c  CRM: the posterior mean of the parameter equals dfcrm::crm's estimate on 60 random data sets, the recommended dose equals its
#      mtd, and the skeleton from a half-width equals dfcrm::getprior
#   d  3+3: the simulation equals the exact enumeration of the rule (a recursion over the patients treated and the toxicities at each
#      dose) on every selection probability and every mean number of patients, and the probability of escalating from the first dose
#      equals the closed form (1 - p)^3 + 3 p (1 - p)^5
#   e  the operating characteristics (selection percentages, patients per dose, toxicities) of BOIN, the keyboard design and CRM equal
#      BOIN::get.oc, Keyboard::get.oc.kb and dfcrm::crmsim on a six-dose curve, within three combined Monte-Carlo errors
#
# BOIN here is the local design with a non-informative prior; whether the boundaries equal an agency's revised version is not something a
# package can say, and nothing in the result says it.

.n81_curve <- c(0.05, 0.1, 0.2, 0.3, 0.45, 0.6)

vcr_case("N81a", c("AC-30"), function() {
  if (!requireNamespace("BOIN", quietly = TRUE)) stop("N81 requires the locked BOIN library")
  same <- 0L; total <- 0L; worst <- character()
  settings <- list(list(0.2, NULL, NULL, 0.95), list(0.3, NULL, NULL, 0.95), list(0.25, 0.1, 0.4, 0.9), list(0.15, NULL, NULL, 0.95), list(0.4, 0.2, 0.55, 0.95))
  for (s in settings) {
    tg <- s[[1]]; phi1 <- s[[2]] %||% (0.6 * tg); phi2 <- s[[3]] %||% (1.4 * tg); cut <- s[[4]]
    mine <- vcr_boin_tables(tg, phi1, phi2, cut, 36L)
    ref <- BOIN::get.boundary(tg, 12, 3, p.saf = phi1, p.tox = phi2, cutoff.eli = cut)$full_boundary_tab
    ok <- all(mine$esc == ref[2, ]) && all(mine$deesc == ref[3, ]) && all(is.na(mine$elim) == is.na(ref[4, ]) & (is.na(mine$elim) | mine$elim == ref[4, ]))
    total <- total + 1L; same <- same + ok
    if (!ok) worst <- c(worst, sprintf("target %.2f", tg))
  }
  set.seed(8101)
  K <- 6L; T <- 400L
  N <- matrix(0L, T, K); Y <- matrix(0L, T, K)
  for (t in seq_len(T)) for (d in sample.int(K, sample(2:5, 1), replace = TRUE)) { n <- 3L * sample.int(3, 1); N[t, d] <- N[t, d] + n; Y[t, d] <- Y[t, d] + stats::rbinom(1, n, min(0.9, 0.12 * d)) }
  mine <- vcr_dose_select_isotonic(N, Y, 0.3, 0.95)
  ref <- vapply(seq_len(T), function(t) { r <- BOIN::select.mtd(0.3, N[t, ], Y[t, ])$MTD; if (r == 99) 0L else as.integer(r) }, integer(1))
  list(pass = same == total && all(mine == ref),
       detail = sprintf("%d/%d boundary tables identical to BOIN::get.boundary (escalate, de-escalate and eliminate bounds for 1 to 36 patients)%s; the final dose of %d/%d random trials equals BOIN::select.mtd (%d trials ended with no dose)",
                        same, total, if (length(worst)) paste0(" -- differ: ", paste(worst, collapse = ", ")) else "", sum(mine == ref), T, sum(ref == 0L)))
})

vcr_case("N81b", c("AC-30"), function() {
  if (!requireNamespace("Keyboard", quietly = TRUE)) stop("N81 requires the locked Keyboard library")
  same <- 0L; total <- 0L
  for (s in list(c(0.2, 0.05), c(0.3, 0.05), c(0.25, 0.03), c(0.35, 0.08))) {
    mine <- vcr_keyboard_tables(s[1], s[2], 0.95, 36L)
    ref <- Keyboard::get.boundary.kb(s[1], 12, 3, marginL = s[2], marginR = s[2])$full_boundary_tab
    ok <- all(mine$esc == ref[2, ]) && all(is.na(mine$deesc) == is.na(ref[3, ]) & (is.na(mine$deesc) | mine$deesc == ref[3, ])) &&
      all(is.na(mine$elim) == is.na(ref[4, ]) & (is.na(mine$elim) | mine$elim == ref[4, ]))
    total <- total + 1L; same <- same + ok
  }
  list(pass = same == total, detail = sprintf("%d/%d keyboard tables identical to Keyboard::get.boundary.kb (targets 0.20, 0.30, 0.25, 0.35; key half-widths 0.05, 0.05, 0.03, 0.08; 1 to 36 patients)", same, total))
})

vcr_case("N81c", c("AC-30"), function() {
  if (!requireNamespace("dfcrm", quietly = TRUE)) stop("N81 requires the locked dfcrm library")
  set.seed(8103)
  sk <- c(0.05, 0.12, 0.25, 0.4, 0.55)
  worst <- 0; rec_same <- 0L; runs <- 60L
  for (i in seq_len(runs)) {
    n <- sample(3:30, 1); lev <- sample.int(5, n, replace = TRUE); tox <- stats::rbinom(n, 1, pmin(0.9, sk[lev] + 0.1))
    ref <- dfcrm::crm(sk, 0.25, tox, lev, var.est = FALSE)
    N <- matrix(tabulate(lev, 5L), 1L); Y <- matrix(vapply(seq_len(5L), function(j) sum(tox[lev == j]), numeric(1)), 1L)
    a <- .vcr_crm_posterior_mean(N, Y, log(sk), VCR_DOSE_GRID, sqrt(1.34))
    rec <- .vcr_crm_recommend(N, Y, sk, 0.25, VCR_DOSE_GRID, sqrt(1.34))$dose
    worst <- max(worst, abs(a - ref$estimate)); rec_same <- rec_same + (rec == ref$mtd)
  }
  skel <- max(abs(vcr_crm_skeleton(0.05, 0.25, 3L, 5L) - dfcrm::getprior(0.05, 0.25, 3, 5)), abs(vcr_crm_skeleton(0.05, 0.3, 1L, 6L) - dfcrm::getprior(0.05, 0.3, 1, 6)),
             abs(vcr_crm_skeleton(0.08, 0.2, 6L, 6L) - dfcrm::getprior(0.08, 0.2, 6, 6)))
  list(pass = worst < 1e-7 && rec_same == runs && skel < 1e-12,
       detail = sprintf("posterior mean of the parameter on %d random data sets: max|d| %.1e from dfcrm::crm's estimate (tol 1e-7); recommended dose equal in %d/%d; skeleton equals dfcrm::getprior to %.0e", runs, worst, rec_same, runs, skel))
})

#' The exact distribution of a 3+3 trial on a toxicity curve, by recursion over the cohorts (independent of the vectorised simulation).
.n81_exact_three_plus_three <- function(p) {
  K <- length(p); sel <- numeric(K + 1L); pats <- numeric(K)
  walk <- function(d, n, y, down, prob) {
    for (x in 0:3) {
      pr <- prob * stats::dbinom(x, 3, p[d]); if (pr == 0) next
      n2 <- n; y2 <- y; n2[d] <- n2[d] + 3L; y2[d] <- y2[d] + x
      nd <- n2[d]; yd <- y2[d]
      if (nd == 3L && yd == 1L) { walk(d, n2, y2, down, pr); next }
      passed <- (nd == 3L && yd == 0L) || (nd == 6L && yd <= 1L)
      finish <- function(chosen) { sel[chosen + 1L] <<- sel[chosen + 1L] + pr; pats <<- pats + pr * n2 }
      if (passed) { if (down || d == K) finish(d) else walk(d + 1L, n2, y2, FALSE, pr) }
      else if (d == 1L) finish(0L)
      else if (n2[d - 1L] >= 6L) finish(d - 1L)
      else walk(d - 1L, n2, y2, TRUE, pr)
    }
  }
  walk(1L, rep(0L, K), rep(0L, K), FALSE, 1)
  list(select = sel, patients = pats)
}

vcr_case("N81d", c("AC-29", "AC-31"), function() {
  curves <- list(c(0.05, 0.1, 0.2, 0.3, 0.45, 0.6), c(0.3, 0.5, 0.7), c(0.02, 0.04, 0.06, 0.08), c(0.15, 0.25))
  trials <- 40000L
  worst <- 0; text <- character()
  for (i in seq_along(curves)) {
    p <- curves[[i]]; K <- length(p)
    set.seed(8104 + i)
    U <- matrix(stats::runif(trials * (6L * K + 3L)), nrow = trials)
    sim <- .vcr_dose_run_three_plus_three(U, p)
    exact <- .n81_exact_three_plus_three(p)
    for (j in 0:K) {
      q <- mean(sim$sel == j); se <- sqrt(max(exact$select[j + 1L] * (1 - exact$select[j + 1L]), 1e-9) / trials)
      worst <- max(worst, abs(q - exact$select[j + 1L]) / se)
    }
    for (j in seq_len(K)) {
      se <- stats::sd(sim$N[, j]) / sqrt(trials)
      worst <- max(worst, abs(mean(sim$N[, j]) - exact$patients[j]) / se)
    }
    text <- c(text, sprintf("curve %d (%d doses): exact selection %s, simulated %s", i, K, paste(sprintf("%.3f", exact$select), collapse = "/"), paste(sprintf("%.3f", tabulate(sim$sel + 1L, K + 1L) / trials), collapse = "/")))
  }
  # Lin and Shih (2001): the probability of escalating from a dose with true toxicity p is (1 - p)^3 + 3 p (1 - p)^5
  closed <- vapply(c(0.1, 0.25, 0.4), function(q) {
    set.seed(8110); U <- matrix(stats::runif(trials * 15L), nrow = trials)
    sim <- .vcr_dose_run_three_plus_three(U, c(q, 0.99))
    c(sim = mean(sim$N[, 2L] > 0), exact = (1 - q)^3 + 3 * q * (1 - q)^5)
  }, numeric(2))
  closed_z <- max(abs(closed["sim", ] - closed["exact", ]) / sqrt(closed["exact", ] * (1 - closed["exact", ]) / trials))
  list(pass = worst < 4 && closed_z < 4,
       detail = sprintf("%d trials on four curves; worst gap to the exact enumeration %.2f Monte-Carlo errors (every selection probability and every mean number of patients); escalation from dose 1 at p = 0.10/0.25/0.40: simulated %s, closed form %s (worst %.2f errors); %s",
                        trials, worst, paste(sprintf("%.4f", closed["sim", ]), collapse = "/"), paste(sprintf("%.4f", closed["exact", ]), collapse = "/"), closed_z, text[1]))
})

vcr_case("N81e", c("AC-29", "AC-31"), function() {
  for (pkg in c("BOIN", "Keyboard", "dfcrm")) if (!requireNamespace(pkg, quietly = TRUE)) stop("N81 requires the locked ", pkg, " library")
  p <- .n81_curve; target <- 0.3; K <- length(p)
  mine <- function(kind, trials, seed) {
    set.seed(seed); U <- matrix(stats::runif(trials * 30L), nrow = trials)
    switch(kind,
      boin = .vcr_dose_run_table(U, p, vcr_boin_tables(target, 0.18, 0.42, 0.95, 30L), 1L, 3L, 30L, target, 0.95),
      keyboard = .vcr_dose_run_table(U, p, vcr_keyboard_tables(target, 0.05, 0.95, 30L), 1L, 3L, 30L, target, 0.95),
      crm = .vcr_dose_run_crm(U, p, vcr_crm_skeleton(0.05, target, 1L, K), 1L, 3L, 30L, target, sqrt(1.34), TRUE))
  }
  gap <- function(a_sel, a_pat, a_tox, b_sel, b_pat, b_tox, n_a, n_b, sd_pat, sd_tox) {
    z_sel <- abs(a_sel - b_sel) / sqrt(pmax(a_sel * (1 - a_sel), b_sel * (1 - b_sel), 1e-4) * (1 / n_a + 1 / n_b))
    z_pat <- abs(a_pat - b_pat) / (sd_pat * sqrt(1 / n_a + 1 / n_b))
    c(sel = max(z_sel), pat = max(z_pat), tox = abs(a_tox - b_tox) / (sd_tox * sqrt(1 / n_a + 1 / n_b)))
  }
  text <- character(); worst <- 0
  # BOIN
  nb <- 6000L; oc <- BOIN::get.oc(target, p, 10, 3, ntrial = nb, p.saf = 0.18, p.tox = 0.42)
  m <- mine("boin", 20000L, 8121); sel <- tabulate(m$sel, K) / 20000L
  z <- gap(sel, colMeans(m$N), mean(rowSums(m$Y)), oc$selpercent / 100, oc$npatients, oc$totaltox, 20000L, nb, apply(m$N, 2L, stats::sd), stats::sd(rowSums(m$Y)))
  worst <- max(worst, z); text <- c(text, sprintf("BOIN select %s vs get.oc %s (z %.2f/%.2f/%.2f)", paste(sprintf("%.1f", 100 * sel), collapse = "/"), paste(sprintf("%.1f", oc$selpercent), collapse = "/"), z[["sel"]], z[["pat"]], z[["tox"]]))
  # keyboard
  nk <- 2000L; ko <- Keyboard::get.oc.kb(target, p, 10, 3, ntrial = nk)
  m <- mine("keyboard", 20000L, 8122); sel <- tabulate(m$sel, K) / 20000L
  z <- gap(sel, colMeans(m$N), mean(rowSums(m$Y)), ko$selpercent / 100, ko$npatients, ko$totaltox, 20000L, nk, apply(m$N, 2L, stats::sd), stats::sd(rowSums(m$Y)))
  worst <- max(worst, z); text <- c(text, sprintf("keyboard select %s vs get.oc.kb %s (z %.2f/%.2f/%.2f)", paste(sprintf("%.1f", 100 * sel), collapse = "/"), paste(sprintf("%.1f", ko$selpercent), collapse = "/"), z[["sel"]], z[["pat"]], z[["tox"]]))
  # CRM: dfcrm::crmsim with group size 3, restricted escalation, the skeleton from getprior
  nc <- 700L; cs <- dfcrm::crmsim(p, vcr_crm_skeleton(0.05, target, 1L, K), target, 30, 1, nsim = nc, mcohort = 3, restrict = TRUE, count = FALSE)
  m <- mine("crm", 12000L, 8123); sel <- tabulate(m$sel, K) / 12000L
  z <- gap(sel, colMeans(m$N), mean(rowSums(m$Y)), cs$MTD, cs$level, sum(cs$tox), 12000L, nc, apply(m$N, 2L, stats::sd), stats::sd(rowSums(m$Y)))
  worst <- max(worst, z); text <- c(text, sprintf("CRM select %s vs crmsim %s (z %.2f/%.2f/%.2f)", paste(sprintf("%.1f", 100 * sel), collapse = "/"), paste(sprintf("%.1f", 100 * cs$MTD), collapse = "/"), z[["sel"]], z[["pat"]], z[["tox"]]))
  list(pass = worst < 4, detail = sprintf("six doses, target 0.30, 10 cohorts of 3; %s; worst %.2f combined errors (tol 4; the package side ran %d/%d/%d trials)", paste(text, collapse = "; "), worst, nb, nk, nc))
})
