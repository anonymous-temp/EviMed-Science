# N210 -- forecast.individualize: a batch of people's own histories turned into one forecast per person (plan R32 compute path, wave 5)
#
# `R/individualize.R` holds the statistics and is held by N130 (nlme, a grid, known-truth coverage). This case holds what the JOB adds to it: that a
# table of projected events becomes exactly the forecasts the statistics give, one person at a time, that the intervals are right on people drawn from
# the model, and that the cases the job must refuse or leave out are refused or left out by name.
#
#   a  the linear mixed model through a job equals vcr_lmm_fit + vcr_lmm_individualize called by hand on the same rows (1e-9), and the predictive
#      mean equals the BLUP-based prediction of nlme::lme at the same covariance (the oracle of N130b, never called from R/)
#   b  known truth through the job: 1,500 people drawn from a mixed model, history before the origin, the held-out values at two horizons; the 50, 80
#      and 95 per cent intervals cover within a family-wise bound (six comparisons, one per level and horizon: 2.64 MCSE is Bonferroni at 5 per cent)
#      and the individualized point forecast beats the population line on absolute error
#   c  the Alzheimer family through a job equals vcr_beta_logit_individual_predict on the same stream (1e-12), the first observed score being week 0,
#      and a known-truth check: 500 simulated people, the 50 and 90 per cent intervals of the score 26 weeks after the last cover (two comparisons, 2.24 MCSE is Bonferroni at 5 per cent; N130e holds the same posterior on 4,000 people)
#   d  what is left out, with its reason, and the rest kept: a person with no value of their own, a person with no covariates, a score outside 0-70;
#      a table with a row after the origin and a table of two people are refused by name
#   e  the same table and seed give the same table (beta_logit: the draws are fixed by the sorted subject order); the table has one row per
#      person and horizon with the columns the control plane reads

.n210_people <- function(n, seed, years = c(-1, -0.75, -0.5, -0.25, 0), future = c(90, 180) / 365.25, code = "cd4", sd1 = 40, sigma = 20) {
  set.seed(seed, kind = VCR_RNG_KIND)
  b0 <- stats::rnorm(n, 0, 60); b1 <- stats::rnorm(n, 0, sd1)
  at <- c(years, future)
  y <- outer(seq_len(n), at, function(i, t) 420 + 30 * t + b0[i] + b1[i] * t) + matrix(stats::rnorm(n * length(at), 0, sigma), n)
  ids <- sprintf("P%05d", seq_len(n))
  hist <- data.frame(subject = rep(ids, each = length(years)), code = code, value = as.vector(t(y[, seq_along(years)])), day = rep(round(years * 365.25), n), stringsAsFactors = FALSE)
  list(hist = hist, truth = y[, length(years) + seq_along(future)], ids = ids, years = years, future = future)
}

.n210_run <- function(hist, scenario, id, seed = 1L, dir = tempfile("n210")) {
  inp <- vcr_test_input(hist, id)
  scenario$inputId <- id
  job <- vcr_test_job("forecast.individualize", scenario, list(inp), seed = seed)
  list(result = vcr_test_run(job, output_dir = dir), dir = dir)
}
.n210_scenario <- function(family = "linear_mixed", horizons = c(90, 180), extra = list(), code = "cd4", unit = "cells/uL")
  c(list(family = family, inputId = "x", endpoint = list(type = "continuous", code = code, unit = unit), horizonsDays = horizons), extra)
.n210_rows <- function(run) vcr_test_table(run$result, "person-forecasts", run$dir)

vcr_case("N210a", c("AC-04"), function() {
  d <- .n210_people(150L, 21001L)
  sc <- .n210_scenario()
  run <- .n210_run(d$hist, sc, "snp_n210a:1")
  # the hand call reads the very file the job read: a CSV carries 15 digits and a REML optimum is flat to about 1e-5 in a prediction, so two copies of a
  # table that differ in the sixteenth digit are not one input
  d$hist <- utils::read.csv(file.path(vcr_test_data_root(), "snapshots", "snp_test", "snp_n210a_1.csv"), stringsAsFactors = FALSE)
  if (!identical(run$result$status, "succeeded")) return(list(pass = FALSE, detail = paste("status", run$result$status)))
  tbl <- .n210_rows(run)
  t <- d$hist$day / 365.25
  fit <- vcr_lmm_fit(d$hist$value, cbind(`(Intercept)` = 1, time = t), t, d$hist$subject)
  gap <- 0
  for (s in d$ids[1:40]) {
    h <- d$hist[d$hist$subject == s, ]; th <- h$day / 365.25
    p <- vcr_lmm_individualize(fit, cbind(1, c(90, 180) / 365.25), c(90, 180) / 365.25, cbind(1, th), th, h$value)
    r <- tbl[tbl$subject == s, ]; r <- r[order(r$horizonDays), ]
    gap <- max(gap, abs(r$point - p$mean), abs(r$sd - p$sd), abs(r$q05 - (p$mean - 1.6448536269514722 * p$sd)))
  }
  # the same fixed effects and covariances, predicted from the BLUPs of nlme::lme
  long <- data.frame(id = d$hist$subject, t = t, y = d$hist$value)
  m <- nlme::lme(y ~ t, random = ~ t | id, data = long, method = "REML")
  re <- nlme::ranef(m); G <- nlme::getVarCov(m)
  f2 <- fit; f2$beta <- nlme::fixef(m); f2$vcov <- stats::vcov(m); f2$sigma <- m$sigma
  f2$theta <- c(log(sqrt(G[1, 1])), log(sqrt(G[2, 2])), atanh(G[1, 2] / sqrt(G[1, 1] * G[2, 2])), log(m$sigma))
  ngap <- 0
  for (s in d$ids[1:40]) {
    h <- d$hist[d$hist$subject == s, ]; th <- h$day / 365.25
    p <- vcr_lmm_individualize(f2, cbind(1, 0.25), 0.25, cbind(1, th), th, h$value)
    ref <- sum(c(1, 0.25) * nlme::fixef(m)) + sum(c(1, 0.25) * as.numeric(re[s, ]))
    ngap <- max(ngap, abs(p$mean - ref))
  }
  list(pass = gap < 1e-9 && ngap < 1e-3 && all(tbl$status == "ok") && nrow(tbl) == 300L,
       detail = sprintf("150 people, 3 + 4 visits each: the job's point, SD and 5%% quantile equal the hand call of vcr_lmm_fit and vcr_lmm_individualize (max gap %.1e, tolerance 1e-9); at nlme::lme's own covariance the predictive mean equals the BLUP prediction (max gap %.1e, tolerance 1e-3, the covariance is nlme's REML optimum to its own convergence); %d rows = 150 people x 2 horizons", gap, ngap, nrow(tbl)))
})

# coverage of the 50, 80 and 95 per cent central intervals of the held-out values at both horizons: the deviations in Monte Carlo SE
.n210_coverage <- function(d, id) {
  sc <- .n210_scenario()
  run <- .n210_run(d$hist, sc, id)
  tbl <- .n210_rows(run); tbl <- tbl[order(tbl$subject, tbl$horizonDays), ]
  out <- list(); pts <- list()
  for (j in 1:2) {
    r <- tbl[tbl$horizonDays == c(90, 180)[j], ]; r <- r[match(d$ids, r$subject), ]; y <- d$truth[, j]
    pts[[j]] <- r$point
    # the 50 per cent interval is the table's 25 and 75 quantiles; the 80 and 95 per cent ones come from the point and the SD of the Gaussian predictive
    for (lv in c(50, 80, 95)) {
      nominal <- lv / 100
      cover <- if (lv == 50) mean(y >= r$q25 & y <= r$q75) else mean(abs(y - r$point) <= stats::qnorm(0.5 + nominal / 2) * r$sd)
      mcse <- sqrt(nominal * (1 - nominal) / length(y))
      out[[length(out) + 1L]] <- data.frame(horizon = c(90, 180)[j], level = lv, coverage = cover, dev = (cover - nominal) / mcse)
    }
  }
  list(rows = do.call(rbind, out), points = pts, run = run)
}

vcr_case("N210b", c("AC-04", "AC-28"), function() {
  d <- .n210_people(1500L, 21002L)
  good <- .n210_coverage(d, "snp_n210b:1")
  # beside it, for information: a design that cannot identify the slope variance (four visits over half a year, slope SD 25 against a per-person slope error of 67)
  weak <- .n210_coverage(.n210_people(1500L, 21022L, years = c(-0.5, -0.35, -0.2, 0), sd1 = 25, sigma = 25), "snp_n210b:2")
  say <- function(x) paste(sprintf("h%d %d%%: %.3f (%+.2f)", x$rows$horizon, x$rows$level, x$rows$coverage, x$rows$dev), collapse = ", ")
  t <- d$hist$day / 365.25; fit <- vcr_lmm_fit(d$hist$value, cbind(`(Intercept)` = 1, time = t), t, d$hist$subject)
  pop <- fit$beta[[1]] + fit$beta[[2]] * 180 / 365.25
  e_ind <- mean(abs(d$truth[, 2] - good$points[[2]])); e_pop <- mean(abs(d$truth[, 2] - pop))
  worst <- max(abs(good$rows$dev))
  list(pass = worst < 2.64 && e_ind < e_pop,
       detail = sprintf("1,500 people drawn from the mixed model (5 visits over the year before the origin, slope SD 40, residual SD 20), held-out values at 90 and 180 days: coverage (deviation in MCSE) %s; largest %.2f MCSE against 2.64 (six comparisons are read at once, one per level and horizon, so the bound is Bonferroni at 5 per cent, not one 3-MCSE limit each); mean absolute error at 180 days %.1f individualized against %.1f population line. For information, a design that cannot identify the slope variance (4 visits over half a year, slope SD 25, residual SD 25) reads %s: the fitted covariance is treated as known, which the method states, and its intervals fall short when it is poorly estimated", say(good), worst, e_ind, e_pop, say(weak)))
})

.n210_ad_people <- function(n, seed, t_obs = c(0, 12, 24), t_next = 26 + 24, par = NULL) {
  par <- vcr_beta_logit_par(vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0")$medians)
  study <- vcr_beta_logit_typical_study(par)
  set.seed(seed, kind = VCR_RNG_KIND)
  ids <- sprintf("A%04d", seq_len(n))
  rows <- list(); truth <- numeric(n)
  for (i in seq_len(n)) {
    mmse <- sample(16:26, 1L); age <- round(stats::runif(1L, 62, 88)); apoe <- sample(0:2, 1L, prob = c(.4, .4, .2)); female <- stats::rbinom(1L, 1L, 0.55)
    m_eta <- study$muEta + par$lambdaEta * (mmse - par$reference$bmmse)
    m_alpha <- study$muAlpha + par$lambdaMmse * (mmse - par$reference$bmmse) + par$lambdaAge * (age - par$reference$age) + par$lambdaApoe[apoe + 1L] + par$lambdaFemale * female
    eta <- stats::rnorm(1L, m_eta, study$sdEta); alpha <- stats::rnorm(1L, m_alpha, study$sdAlpha)
    tt <- c(t_obs, t_next)
    theta <- stats::plogis(eta + alpha * tt + vcr_beta_logit_placebo(par, tt))
    sc <- vapply(seq_along(tt), function(j) vcr_beta_logit_scores(theta[j], study$tau), numeric(1))
    rows[[i]] <- data.frame(subject = ids[i], code = c(rep("adas_cog_11", length(t_obs)), "mmse", "age", "apoe4", "female"),
                            value = c(sc[seq_along(t_obs)], mmse, age, apoe, female), day = c(round(7 * t_obs) - 7 * max(t_obs), rep(-7 * max(t_obs), 4L)), stringsAsFactors = FALSE)
    truth[i] <- sc[length(tt)]
  }
  list(hist = do.call(rbind, rows), truth = truth, ids = ids, par = par, study = study)
}

vcr_case("N210c", c("AC-04", "AC-28"), function() {
  d <- .n210_ad_people(500L, 21003L)
  sc <- .n210_scenario("beta_logit", horizons = 7 * 26, extra = list(draws = 400L), code = "adas_cog_11", unit = "points"); sc$inputId <- "snp_n210c:1"
  run <- .n210_run(d$hist, sc, "snp_n210c:1", seed = 7L)
  if (!identical(run$result$status, "succeeded")) return(list(pass = FALSE, detail = paste("status", run$result$status)))
  tbl <- .n210_rows(run); tbl <- tbl[match(d$ids, tbl$subject), ]
  d$hist <- utils::read.csv(file.path(vcr_test_data_root(), "snapshots", "snp_test", "snp_n210c_1.csv"), stringsAsFactors = FALSE)   # the file the job read (15 digits)
  # the same draws by hand: person k takes the k-th substream of the job's seed, the first observed score is week 0
  bank <- vcr_stream_bank(7L); streams <- bank$take(length(d$ids))
  gap <- 0
  for (k in c(1L, 17L, 250L, 500L)) {
    h <- d$hist[d$hist$subject == d$ids[k], ]; o <- h[h$code == "adas_cog_11", ]; v <- function(n) h$value[h$code == n]
    cov <- list(mmse = v("mmse"), age = v("age"), apoe = v("apoe4"), female = v("female"))
    day0 <- min(o$day); t_obs <- (o$day - day0) / 7
    p <- vcr_with_stream(streams[[k]], function(.) vcr_beta_logit_individual_predict(d$par, d$study, cov, t_obs, o$value, (7 * 26 - day0) / 7, 400L), k)
    dd <- p[, 1]
    gap <- max(gap, abs(tbl$point[k] - mean(dd)), abs(tbl$sd[k] - stats::sd(dd)), abs(tbl$q95[k] - stats::quantile(dd, 0.95, names = FALSE, type = 7)))
  }
  detail <- character(0); worst <- 0
  for (lv in list(c(50, "q25", "q75"), c(90, "q05", "q95"))) {
    nominal <- as.numeric(lv[1]) / 100; cover <- mean(d$truth >= tbl[[lv[2]]] & d$truth <= tbl[[lv[3]]]); mcse <- sqrt(nominal * (1 - nominal) / length(d$truth))
    worst <- max(worst, abs(cover - nominal) / mcse); detail <- c(detail, sprintf("%s%%: %.3f (dev %.2f MCSE)", lv[1], cover, abs(cover - nominal) / mcse))
  }
  list(pass = gap < 1e-12 && worst < 2.24 && all(tbl$status == "ok"),
       detail = sprintf("500 people drawn from the Alzheimer model, three scores at weeks 0, 12 and 24 and the score 26 weeks after the last: the job equals vcr_beta_logit_individual_predict on the job's own substreams (max gap %.1e, tolerance 1e-12); coverage %s, largest deviation %.2f MCSE against 2.24 (two comparisons: the 50 and 90 per cent levels at the one horizon, the study's medians as the truth's parameters)", gap, paste(detail, collapse = ", "), worst))
})

vcr_case("N210d", c("AC-04"), function() {
  d <- .n210_people(40L, 21004L)
  hist <- d$hist
  # a person with nothing of their own (only another code), a person whose only value is of another code is left out with the reason
  extra <- data.frame(subject = c("Q00001", "Q00002"), code = c("weight", "cd4"), value = c(70, 450), day = c(0, 0), stringsAsFactors = FALSE)
  sc <- .n210_scenario(); sc$inputId <- "snp_n210d:1"
  run <- .n210_run(rbind(hist, extra[1, ]), sc, "snp_n210d:1")
  tbl <- .n210_rows(run)
  left_out <- tbl[tbl$subject == "Q00001", ]
  a <- nrow(left_out) == 2L && all(left_out$status == "no_own_history") && all(is.na(left_out$point)) && sum(tbl$status == "ok") == 80L
  # a person with one value of their own is forecast
  one <- .n210_run(rbind(hist, extra[2, ]), sc, "snp_n210d:2")
  one_tbl <- .n210_rows(one); b <- all(one_tbl$status[one_tbl$subject == "Q00002"] == "ok")
  # the Alzheimer family: a person without a covariate, and a score outside 0-70
  ad <- .n210_ad_people(12L, 21005L)
  ah <- ad$hist
  ah <- ah[!(ah$subject == ad$ids[1] & ah$code == "apoe4"), ]
  ah$value[ah$subject == ad$ids[2] & ah$code == "adas_cog_11"][1] <- 80
  sa <- .n210_scenario("beta_logit", horizons = 182, extra = list(draws = 100L), code = "adas_cog_11", unit = "points"); sa$inputId <- "snp_n210d:3"
  at <- .n210_rows(.n210_run(ah, sa, "snp_n210d:3"))
  c1 <- at$status[at$subject == ad$ids[1]] == "covariates_missing" && at$status[at$subject == ad$ids[2]] == "score_out_of_range" && sum(at$status == "ok") == 10L
  # refusals by name
  late <- rbind(hist, data.frame(subject = "P00001", code = "cd4", value = 400, day = 30, stringsAsFactors = FALSE))
  r1 <- .n210_run(late, sc, "snp_n210d:4")$result
  few <- .n210_run(hist[hist$subject %in% d$ids[1:2], ], sc, "snp_n210d:5")$result
  codes <- function(r) paste(vcr_test_issue_codes(r), collapse = ",")
  c2 <- identical(r1$status, "failed") && grepl("input_shape_invalid", codes(r1)) && identical(few$status, "failed") && grepl("input_shape_invalid", codes(few))
  list(pass = a && b && c1 && c2,
       detail = sprintf("a person with only another code is left out with 'no_own_history' for both horizons and every other person is kept (%s); a person with one value of their own is forecast (%s); in the Alzheimer family a missing ApoE4 is 'covariates_missing' and a score of 80 is 'score_out_of_range', ten others kept (%s); a row after the origin (%s) and a table of two people (%s) are refused as input_shape_invalid", a, b, c1, codes(r1), codes(few)))
})

vcr_case("N210e", c("AC-04", "AC-31"), function() {
  d <- .n210_ad_people(30L, 21006L)
  sc <- .n210_scenario("beta_logit", horizons = c(91, 182), extra = list(draws = 200L), code = "adas_cog_11", unit = "points"); sc$inputId <- "snp_n210e:1"
  one <- .n210_run(d$hist, sc, "snp_n210e:1", seed = 11L); two <- .n210_run(d$hist, sc, "snp_n210e:1", seed = 11L)
  other <- .n210_run(d$hist, sc, "snp_n210e:1", seed = 12L)
  a <- .n210_rows(one); b <- .n210_rows(two); o <- .n210_rows(other)
  same <- identical(vcr_file_sha256(file.path(one$dir, "person-forecasts.csv")), vcr_file_sha256(file.path(two$dir, "person-forecasts.csv")))
  shape <- identical(names(a), c("subject", "horizonDays", "status", "point", "sd", "q05", "q25", "q50", "q75", "q95", "nHistory", "flag")) && nrow(a) == 60L && !anyDuplicated(a[c("subject", "horizonDays")])
  list(pass = same && shape && !isTRUE(all.equal(a$point, o$point)) && identical(one$result$counts$generatedRecords, NULL) && one$result$diagnostics$individualize$peopleInTable == 30L,
       detail = sprintf("the same table and seed give a byte-identical person-forecasts table (%s), another seed gives other draws; the table has one row per person and horizon with the columns the control plane reads (%s), 30 people x 2 horizons = %d rows", same, shape, nrow(a)))
})
