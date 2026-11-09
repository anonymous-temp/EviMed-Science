# N93 — the elastic prior (algorithm round C12, 2026-11-03): comparator.borrowing, prior.kind elastic.
#
# "数据冲突怎样换算成借用程度": Jiang, Nie & Yuan 2023. The historical posterior with its variance inflated by 1 / g(T), T a measure of how far the
# current control data are from the historical ones, g a logistic function through two points that the percentiles q0 and q1 of T place. No
# package implements it, so each piece is held to something that does not share its code:
#
#   a  the congruence measure of a rate is the Pearson chi-square of the 2 x 2 table (stats::chisq.test, no correction); its exact law (the
#      binomial counts of the current arm) against a simulation of 400,000 draws, percentile by percentile, and for a mean the folded normal
#      against 400,000 simulated sample means
#   b  the two constants of the function from the paper's closed form for a and b, written again here, and the two conditions that define
#      them: g(T_q0) = C1 and g(T_q1) = C2; the step function (the limit of a large b)
#   c  the elastic prior is Beta(g (a0 + x), g (b0 + n - x)) (equation 1): it has the historical posterior's mean, its prior effective sample
#      size is g times the historical patients (the paper's PESS) up to the vague prior's own, and a mean's prior is N(mean, sd^2 / (n g))
#   d  the operating characteristics of a rate against an enumeration whose every posterior probability is RBesT::pmixdiff, and of a rate and
#      of a mean against a simulation of the whole procedure (the discount recomputed from each simulated sample), within three Monte-Carlo errors
#   e  the table of conflict against borrowing falls as the conflict grows, and the refusals are by name: a delta the current patients cannot
#      tell from no difference, and a percentile at which T is exactly 0

.n93_hist <- list(x = 90, n = 300)

vcr_case("N93a", c("AC-30"), function() {
  set.seed(9301L, kind = VCR_RNG_KIND)
  worst_t <- 0
  for (tab in list(c(40, 150, 90, 300), c(12, 150, 90, 300), c(60, 150, 90, 300), c(0, 30, 3, 100))) {
    x <- tab[1]; n <- tab[2]; xh <- tab[3]; nh <- tab[4]
    ref <- suppressWarnings(unname(stats::chisq.test(matrix(c(x, n - x, xh, nh - xh), 2), correct = FALSE)$statistic))
    worst_t <- max(worst_t, abs(vcr_bw_chisq_binary(x, n, xh, nh) - ref))
  }
  nc <- 150L; th <- .n93_hist$x / .n93_hist$n
  K <- 400000L
  tt <- vcr_bw_chisq_binary(0:nc, nc, .n93_hist$x, .n93_hist$n)
  worst_q <- 0
  for (p in c(th, th + 0.1, th - 0.1)) {
    sim <- vcr_bw_chisq_binary(stats::rbinom(K, nc, p), nc, .n93_hist$x, .n93_hist$n)
    for (q in c(0.3, 0.5, 0.7, 0.9)) {
      exact <- .vcr_bw_quantile1(tt, stats::dbinom(0:nc, nc, p), q)
      # the exact percentile must be where the simulated distribution function crosses q: just below it falls short, at it reaches it
      lo <- mean(sim < exact - 1e-9); hi <- mean(sim <= exact + 1e-9)
      worst_q <- max(worst_q, max(0, lo - q), max(0, q - hi))
    }
  }
  # the folded normal of a mean: T = |ybar_c - ybar_h| / (sd sqrt(1/nh + 1/nc)), ybar_c ~ N(theta, sd^2 / nc)
  h <- list(mean = 10, sd = 4, n = 120); n <- 60L; k <- sqrt(1 / h$n + 1 / n); worst_n <- 0
  for (shift in c(0, 2)) {
    sim <- abs(stats::rnorm(K, h$mean + shift, h$sd / sqrt(n)) - h$mean) / (h$sd * k)
    for (q in c(0.3, 0.5, 0.9)) {
      exact <- .vcr_bw_folded_quantile(shift / (h$sd * k), sqrt(h$n / (h$n + n)), q)
      worst_n <- max(worst_n, abs(mean(sim <= exact) - q))
    }
  }
  list(pass = worst_t < 1e-10 && worst_q < 3 / sqrt(K) && worst_n < 4 / sqrt(K),
       detail = sprintf("the chi-square of the 2 x 2 table equals stats::chisq.test (worst difference %.1e); 12 percentiles of its exact law (150 current patients, historical 90/300, true rates 0.3 and 0.3 +- 0.1) against 400,000 simulated draws: the simulated distribution function misses by at most %.5f (three standard errors %.5f); the folded normal of a mean (6 percentiles): at most %.5f",
                        worst_t, worst_q, 3 / sqrt(K), worst_n))
})

vcr_case("N93b", c("AC-30"), function() {
  hist <- .n93_hist; worst_c <- 0; worst_paper <- 0; shown <- character(); placed <- 0L; refused <- 0L
  for (nc in c(60L, 150L, 400L)) for (dl in c(0.08, 0.15)) for (q in list(c(0.5, 0.5), c(0.7, 0.3), c(0.9, 0.5))) {
    fit <- tryCatch(vcr_bw_elastic_fit("binary", hist, nc, dl, q[1], q[2], 0.99, 0.01), vcr_refusal = function(e) NULL)
    if (is.null(fit)) { refused <- refused + 1L; next }                  # a delta the current patients cannot tell from none: N93e holds the refusal
    placed <- placed + 1L
    g <- function(t) 1 / (1 + exp(fit$a + fit$b * log(t)))
    worst_c <- max(worst_c, abs(g(fit$tq0) - 0.99), abs(g(fit$tq1) - 0.01))
    # the paper's closed form for a and b (Section 2.1.2), written out again
    C1 <- 0.99; C2 <- 0.01; L <- log(((1 - C1) * C2) / ((1 - C2) * C1)); lq0 <- log(fit$tq0); lq1 <- log(fit$tq1)
    a_paper <- log((1 - C1) / C1) - L * lq0 / (lq0 - lq1); b_paper <- L / (lq0 - lq1)
    worst_paper <- max(worst_paper, abs(fit$a - a_paper), abs(fit$b - b_paper))
    if (nc == 150L && dl == 0.15 && q[1] == 0.5) shown <- sprintf("T_q0 %.4f, T_q1 %.4f, a %.4f, b %.4f", fit$tq0, fit$tq1, fit$a, fit$b)
  }
  st <- vcr_bw_elastic_fit("binary", hist, 150L, 0.1, 0.6, 0.6, 0.99, 0.01, kind = "step")
  g_step <- vcr_bw_elastic_g(st, c(st$tq0 - 1e-6, st$tq0, st$tq0 + 1e-6, 0))
  fit0 <- vcr_bw_elastic_fit("binary", hist, 150L, 0.15, 0.5, 0.5, 0.99, 0.01)
  g_zero <- vcr_bw_elastic_g(fit0, 0)
  list(pass = placed >= 14L && worst_c < 1e-12 && worst_paper < 1e-10 && identical(g_step, c(1, 1, 0, 1)) && g_zero == 1,
       detail = sprintf("%d placements of the function (3 current sizes, delta 0.08 and 0.15, three (q0, q1); %d more are not identified and refused): g(T_q0) = 0.99 and g(T_q1) = 0.01 (worst difference %.1e), and a and b equal the paper's closed form (%.1e); e.g. 150 patients, delta 0.15: %s; the step function is 1 up to T_q0 and 0 above, and T = 0 gives g = 1",
                        placed, refused, worst_c, worst_paper, shown))
})

vcr_case("N93c", c("AC-30"), function() {
  hist <- .n93_hist; spec <- list(kind = "elastic", delta = 0.15, va = 0.1, vb = 0.1)
  fit <- vcr_bw_elastic_fit("binary", hist, 150L, 0.15, 0.5, 0.5, 0.99, 0.01)
  worst <- 0; ess_gap <- 0; mean_gap <- 0
  for (x in c(45, 41, 36, 30, 20)) {
    pr <- vcr_bw_prior("binary", spec, hist, x, 150L, fit)
    g <- 1 / (1 + exp(fit$a + fit$b * log(vcr_bw_chisq_binary(x, 150, hist$x, hist$n))))
    worst <- max(worst, abs(pr$weight - g), abs(pr$mix$alpha - max(g * (0.1 + hist$x), 0.1)), abs(pr$mix$beta - max(g * (0.1 + hist$n - hist$x), 0.1)))
    mean_gap <- max(mean_gap, abs(pr$mix$alpha / (pr$mix$alpha + pr$mix$beta) - (0.1 + hist$x) / (0.2 + hist$n)))
    ess <- vcr_bw_prior_ess("binary", c(pr, kind = "elastic"), hist)
    ess_gap <- max(ess_gap, abs(ess - g * hist$n))
  }
  # the same mean as the history's posterior: where g (a0 + x) is above a0 the floor does not act
  h <- list(mean = 10, sd = 4, n = 120); sp <- list(kind = "elastic", delta = 2)
  fn <- vcr_bw_elastic_fit("continuous", h, 60L, 2, 0.5, 0.5, 0.99, 0.01)
  gn <- numeric(); worst_n <- 0
  for (y in c(10, 10.5, 11, 12, 14)) {
    prn <- vcr_bw_prior("continuous", sp, h, y, 60L, fn)
    g <- 1 / (1 + exp(fn$a + fn$b * log(abs(y - 10) / (4 * sqrt(1 / 120 + 1 / 60))))); if (y == 10) g <- 1
    worst_n <- max(worst_n, abs(prn$weight - g), abs(prn$mix$sd - 4 / sqrt(120 * g)), abs(prn$mix$mean - 10))
    gn <- c(gn, g)
  }
  list(pass = worst < 1e-12 && mean_gap < 1e-12 && ess_gap < 0.2 && worst_n < 1e-12 && all(diff(gn) < 0),
       detail = sprintf("a rate: the prior at five current counts is Beta(g (0.1 + x), g (0.1 + n - x)) with g from the function (difference %.1e), has the mean of the historical posterior (difference %.1e) and a prior effective sample size within %.3f of g x 300 (the paper's PESS; the vague prior's 0.2 patients are the gap); a mean: N(10, 4^2 / (120 g)) at five current means (difference %.1e), g falling from %s",
                        worst, mean_gap, ess_gap, worst_n, paste(sprintf("%.3f", gn), collapse = ", ")))
})

vcr_case("N93d", c("AC-30"), function() {
  suppressMessages(library(RBesT))
  hist <- list(x = 30, n = 100); n_c <- 30L; n_t <- 40L; alpha <- 0.025
  spec <- list(kind = "elastic", delta = 0.15, va = 0.1, vb = 0.1)
  fit <- vcr_bw_elastic_fit("binary", hist, n_c, 0.15, 0.6, 0.4, 0.99, 0.01)
  chosen <- function(x) vcr_bw_prior("binary", spec, hist, x, n_c, fit)
  oc <- vcr_bw_oc_binary(list(none = function(x) vcr_bw_prior_none("binary", spec, hist), chosen = chosen), hist, n_c, n_t, c(-0.15, 0, 0.15), 0.15, alpha)
  D <- matrix(0, n_t + 1L, n_c + 1L)
  for (xc in 0:n_c) { post <- vcr_bw_post_binary(chosen(xc)$mix, xc, n_c)
    for (xt in 0:n_t) D[xt + 1L, xc + 1L] <- as.numeric(1 - RBesT::pmixdiff(mixbeta(c(1, 1 + xt, 1 + n_t - xt)), mixbeta(c(1, post$alpha, post$beta)), 0) > 1 - alpha) }
  worst <- 0
  for (r in oc) { tc <- r$controlValue
    worst <- max(worst, abs(sum(outer(stats::dbinom(0:n_t, n_t, tc), stats::dbinom(0:n_c, n_c, tc)) * D) - r$perPrior$chosen$typeOneError),
                 abs(sum(outer(stats::dbinom(0:n_t, n_t, tc + 0.15), stats::dbinom(0:n_c, n_c, tc)) * D) - r$perPrior$chosen$power)) }
  # a simulation of the whole procedure for a rate (the discount recomputed from each simulated control sample) at the drifts
  set.seed(9304L, kind = VCR_RNG_KIND); K <- 200000L; z_max <- 0
  for (r in oc) { tc <- r$controlValue
    xc <- stats::rbinom(K, n_c, tc); xt <- stats::rbinom(K, n_t, tc)
    e <- r$perPrior$chosen$typeOneError; z_max <- max(z_max, abs((mean(D[cbind(xt + 1L, xc + 1L)]) - e) / sqrt(e * (1 - e) / K))) }
  # and for a mean, 100,000 simulated trials per drift
  h <- list(mean = 10, sd = 4, n = 120); nc2 <- 60L; nt2 <- 90L; sp <- list(kind = "elastic", delta = 2)
  fn <- vcr_bw_elastic_fit("continuous", h, nc2, 2, 0.5, 0.5, 0.99, 0.01)
  ocn <- vcr_bw_oc_normal(list(none = "none", chosen = "elastic"), sp, h, fn, nc2, nt2, c(-2, 0, 1.5), 1.5, alpha)
  K2 <- 100000L; z_n <- 0
  for (r in ocn) { tc <- r$controlValue
    yc <- stats::rnorm(K2, tc, 4 / sqrt(nc2)); yt <- stats::rnorm(K2, tc, 4 / sqrt(nt2))
    g <- vcr_bw_elastic_g(fn, abs(yc - 10) / (4 * sqrt(1 / 120 + 1 / nc2)))
    prec <- g * 120 / 16 + nc2 / 16; mu <- (g * 120 / 16 * 10 + nc2 / 16 * yc) / prec
    rej <- stats::pnorm((yt - mu) / sqrt(16 / nt2 + 1 / prec)) > 1 - alpha
    e <- r$perPrior$chosen$typeOneError; z_n <- max(z_n, abs((mean(rej) - e) / sqrt(e * (1 - e) / K2))) }
  list(pass = worst < 1e-9 && z_max < 3.2 && z_n < 3.2,
       detail = sprintf("a rate (30 and 40 patients, historical 30/100, delta 0.15, q0 0.6, q1 0.4), drifts -0.15, 0 and 0.15: type I error and power equal an enumeration whose every posterior probability is RBesT::pmixdiff (worst difference %.1e); 200,000 simulated trials per drift, the discount recomputed from each: the type I error is within %.2f Monte-Carlo errors; a mean (10, sd 4; 60 and 90; delta 2) at drifts -2, 0 and 1.5: within %.2f errors of 100,000 simulated trials",
                        worst, z_max, z_n))
})

vcr_case("N93e", c("AC-30"), function() {
  hist <- .n93_hist; spec <- list(kind = "elastic", delta = 0.1, va = 0.1, vb = 0.1)
  fit <- vcr_bw_elastic_fit("binary", hist, 150L, 0.1, 0.5, 0.5, 0.99, 0.01)
  tab <- .vcr_bw_conflict_table("binary", spec, hist, 150L, fit)
  w <- vapply(tab, function(r) r$weight$value, numeric(1)); d <- vapply(tab, function(r) r$difference, numeric(1))
  centre <- which(d == 0)
  fall_up <- all(diff(w[centre:length(w)]) <= 1e-12); fall_down <- all(diff(w[centre:1]) <= 1e-12)
  r_small <- tryCatch(vcr_bw_elastic_fit("binary", hist, 20L, 0.02, 0.5, 0.5, 0.99, 0.01), error = function(e) conditionMessage(e))
  code_small <- tryCatch({ vcr_bw_elastic_fit("binary", hist, 20L, 0.02, 0.5, 0.5, 0.99, 0.01); "" }, vcr_refusal = function(e) e$issue$code)
  code_zero <- tryCatch({ vcr_bw_elastic_fit("binary", list(x = 3, n = 100), 100L, 0.1, 0.01, 0.9, 0.99, 0.01); "" }, vcr_refusal = function(e) e$issue$code)
  list(pass = fall_up && fall_down && abs(w[centre] - 1) < 1e-12 && identical(code_small, "scenario_value_invalid") && identical(code_zero, "scenario_value_invalid"),
       detail = sprintf("the discount at observed differences of %s from the historical rate: %s (falling away from 0 on both sides); 20 current patients cannot tell a difference of 0.02 from none: refused as scenario_value_invalid (%s); a percentile q0 = 0.01 at which T is exactly 0 is refused as %s",
                        paste(sprintf("%+.2f", d), collapse = ", "), paste(sprintf("%.3f", w), collapse = ", "), substr(r_small, 1, 60), code_zero))
})
