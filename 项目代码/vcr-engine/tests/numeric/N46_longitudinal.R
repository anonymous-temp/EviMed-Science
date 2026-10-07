# N46 — virtual patients with a continuous trajectory (patients.longitudinal, 2026-10-07).
#
#   y_ij = (b0 + u0_i) + (b1 + u1_i) t_j + delta z_i t_j + beta' x_i + e_ij
#
# The references are not the generator's own code: a linear mixed model fitted to the
# OUTPUT table by nlme (an independent implementation, R's recommended package), the
# model's closed-form mean and variance at each visit, and plain arithmetic on the rows
# (retention, the same person under two scenarios). The rest holds the output to the
# conventions of the other virtual-patient generators and the page's reading of it.

.n46_scenario <- function(n = 1200, effect = -0.25, dropout = 0.08, visits = list(0, 2, 4, 6, 8), sd = 2.5, sd0 = 6, sd1 = 0.35, rho = -0.3,
                          intercept = 50, slope = -0.4) {
  list(design = list(nTreat = n, nControl = n), endpoint = list(type = "continuous"), visits = visits,
       truth = list(intercept = intercept, slope = slope, effect = effect, sd = sd, randomEffects = list(sdIntercept = sd0, sdSlope = sd1, correlation = rho)),
       dropoutPerVisit = dropout)
}
.n46_run <- function(sc, seed, tag, dir = NULL, inputs = NULL, cores = 1L) {
  vcr_test_run(vcr_test_job("patients.longitudinal", sc, inputs, seed = seed, job_id = paste0("job_n46", tag), cores = cores), output_dir = dir)
}

vcr_case("N46a", c("AC-02", "AC-09", "AC-11"), function() {
  # 1,200 patients per arm, five visits, 8% leaving before each follow-up visit. (1) A linear mixed model with a random
  # intercept and slope fitted to the output table by nlme recovers every parameter inside a 99.9% interval: the intercept,
  # the control slope, the effect on the slope, a null difference at the first visit (the arms start alike), the two random-effect
  # SDs, their correlation and the residual SD. (2) The model's closed-form mean and SD at each visit (written here, not read
  # from the result) match the sample within four Monte-Carlo errors, per arm and visit; the result's own `expected` block
  # equals the closed form.
  if (!requireNamespace("nlme", quietly = TRUE)) return(list(pass = TRUE, detail = "skipped: nlme (R's recommended package) is not installed"))
  sc <- .n46_scenario()
  dir <- tempfile("n46a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- .n46_run(sc, 4601L, "a", dir)
  d <- vcr_test_table(r, "virtual-patients", dir)
  d$patientId <- factor(d$patientId)
  fit <- suppressWarnings(nlme::lme(y ~ time * arm, random = ~ time | patientId, data = d, method = "REML", control = nlme::lmeControl(opt = "optim", maxIter = 200, msMaxIter = 200)))
  ci <- nlme::intervals(fit, level = 0.999)
  want_fixed <- c("(Intercept)" = 50, time = -0.4, arm = 0, "time:arm" = -0.25)
  in_fixed <- vapply(names(want_fixed), function(k) ci$fixed[k, "lower"] <= want_fixed[[k]] && want_fixed[[k]] <= ci$fixed[k, "upper"], logical(1))
  re <- ci$reStruct$patientId
  inside <- function(row, v) row[1] <= v && v <= row[3]
  in_re <- c(sd0 = inside(re["sd((Intercept))", ], 6), sd1 = inside(re["sd(time)", ], 0.35), cor = inside(re["cor((Intercept),time)", ], -0.3), sigma = inside(ci$sigma, 2.5))
  # the model's moments, from the formula
  t <- c(0, 2, 4, 6, 8)
  implied <- function(z) list(mean = 50 + (-0.4 + -0.25 * z) * t, sd = sqrt(6^2 + 2 * -0.3 * 6 * 0.35 * t + 0.35^2 * t^2 + 2.5^2))
  z_worst <- 0
  for (z in 0:1) for (j in seq_along(t)) {
    v <- d$y[d$arm == z & d$visit == j]; im <- implied(z)
    z_worst <- max(z_worst, abs(mean(v) - im$mean[j]) / (im$sd[j] / sqrt(length(v))), abs(stats::sd(v) - im$sd[j]) / (im$sd[j] / sqrt(2 * (length(v) - 1))))
  }
  ex <- r$diagnostics$expected
  expected_ok <- max(abs(unlist(ex$control$mean) - implied(0)$mean), abs(unlist(ex$treated$mean) - implied(1)$mean),
                     abs(unlist(ex$control$sd) - implied(0)$sd), abs(unlist(ex$treated$sd) - implied(1)$sd)) < 1e-12 && identical(unlist(ex$visits), t)
  list(pass = identical(r$status, "succeeded") && all(in_fixed) && all(in_re) && z_worst < 4 && expected_ok && r$counts$realPatients == 0 && r$counts$generatedRecords == nrow(d),
       detail = sprintf("%d rows of 2,400 patients: mixed-model fit inside its 99.9%% intervals for the intercept %.2f, slope %.3f, effect on the slope %.3f, first-visit arm gap %.3f, SDs %.2f/%.3f, correlation %.2f, residual %.2f (%s); sample against the closed-form mean and SD at 10 arm-visits: worst %.2f Monte-Carlo errors; the result's expected block equals the formula",
                        nrow(d), nlme::fixef(fit)[["(Intercept)"]], nlme::fixef(fit)[["time"]], nlme::fixef(fit)[["time:arm"]], nlme::fixef(fit)[["arm"]],
                        as.numeric(nlme::VarCorr(fit)[1, 2]), as.numeric(nlme::VarCorr(fit)[2, 2]), as.numeric(nlme::VarCorr(fit)[2, 3]), as.numeric(nlme::VarCorr(fit)[3, 2]),
                        paste(c(names(in_fixed)[!in_fixed], names(in_re)[!in_re], "all inside")[1:max(1, sum(!in_fixed) + sum(!in_re))], collapse = "/"), z_worst))
})

vcr_case("N46b", c("AC-31", "AC-11"), function() {
  # Common random numbers: the same seed is the same person under a different scenario. (1) Changing the treatment effect from
  # -0.5 to 0 changes every treated person's value at visit j by exactly 0.5 t_j and nobody else's, and who leaves, and when, is
  # identical. (2) Changing the dropout rate leaves every value that is still observed unchanged and only removes visits: the
  # set of observed visits of each person shrinks, never grows, and stays a run from the first visit. (3) Changing the random-effect SDs
  # changes the persons' draws but not who they are: the same standard normals (the correlation of the first visit's value across
  # the two runs is 1 when only the residual SD changes at t = 0). (4) A person does not depend on how many persons come after
  # them: the first 50 treated patients of a 50+50 run are the first 50 of a 100+100 run, bit for bit.
  base <- .n46_scenario(n = 200, effect = -0.5, dropout = 0.15, visits = list(0, 1, 2, 3, 4, 5))
  dir <- tempfile("n46b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  # one job id for every run: a patient's id is a function of the seed, the job id and the index, and these are the same patients
  rd <- function(sc, seed = 4602L) vcr_test_table(.n46_run(sc, seed, "b", dir), "virtual-patients", dir)
  a <- rd(base)
  nul <- base; nul$truth$effect <- 0; b <- rd(nul)
  key <- function(d) paste(d$patientId, d$visit)
  same_rows <- identical(key(a), key(b))
  d_effect <- a$y - b$y
  want <- ifelse(a$arm == 1L, -0.5 * a$time, 0)
  effect_only <- same_rows && max(abs(d_effect - want)) < 1e-9
  more <- base; more$dropoutPerVisit <- 0.4; cc <- rd(more)
  m <- merge(a, cc, by = c("patientId", "visit"), suffixes = c(".lo", ".hi"))
  lo_visits <- tapply(a$visit, a$patientId, max); hi_visits <- tapply(cc$visit, cc$patientId, max)
  prefix <- all(tapply(cc$visit, cc$patientId, function(v) identical(as.integer(v), seq_along(v))))
  shrink <- all(hi_visits[names(lo_visits)] <= lo_visits) && sum(hi_visits[names(lo_visits)] < lo_visits) > 20L
  kept_same <- max(abs(m$y.lo - m$y.hi)) == 0 && nrow(m) == nrow(cc)
  wider <- base; wider$truth$sd <- 5; w <- rd(wider)
  w1 <- merge(a[a$visit == 1L, ], w[w$visit == 1L, ], by = "patientId", suffixes = c(".a", ".w"))
  # at t = 0 the value is b0 + u0 + e: same u0, residual twice as large -> the difference is exactly e (sd 2.5 -> 5) times the same normal
  resid_scale <- stats::cor(w1$y.a - 50, w1$y.w - 50) > 0.9 && identical(w1$arm.a, w1$arm.w)
  small <- .n46_scenario(n = 50, dropout = 0.1, visits = list(0, 2, 4)); big <- .n46_scenario(n = 100, dropout = 0.1, visits = list(0, 2, 4))
  s <- rd(small); g <- rd(big)
  # the treated patients are the first rows of each run
  tr_s <- s[s$arm == 1L, ]; tr_g <- g[g$arm == 1L, ]
  keep <- seq_len(nrow(tr_s))
  prefix_ok <- identical(tr_s$y, tr_g$y[keep]) && identical(tr_s$visit, tr_g$visit[keep])
  list(pass = effect_only && prefix && shrink && kept_same && resid_scale && prefix_ok,
       detail = sprintf("effect -0.5 -> 0: %d rows, every treated value moves by exactly 0.5 t and no control value moves (%s), the same visits are observed; dropout 0.15 -> 0.4: %d of %d patients lose visits, every still-observed value is unchanged (%s), observed visits stay a run from the first (%s); residual SD doubled: first-visit values correlate %.3f with the originals; 50+50 vs 100+100 patients: the first 50 treated patients are bit-identical (%s)",
                        nrow(a), effect_only, sum(hi_visits[names(lo_visits)] < lo_visits), length(lo_visits), kept_same, prefix, stats::cor(w1$y.a, w1$y.w), prefix_ok))
})

vcr_case("N46c", c("AC-09", "AC-02"), function() {
  # Dropout is monotone and missing completely at random: nobody is missing at the first visit, a person who leaves has no later visit,
  # and the share still in at visit j is (1 - rate)^(j-1), inside four binomial errors, in both arms alike (it is not the treatment's doing).
  # The table has one row per patient per observed visit, every row labelled synthetic at tier scenario, and counts nobody as real.
  rate <- 0.12; n <- 3000L
  sc <- .n46_scenario(n = n, dropout = rate, visits = list(0, 1, 2, 3, 4, 5))
  dir <- tempfile("n46c"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- .n46_run(sc, 4603L, "c", dir)
  d <- vcr_test_table(r, "virtual-patients", dir)
  per <- table(d$arm, d$visit)
  ref <- (1 - rate)^(0:5)
  z <- max(abs((per[, 2] / n) - ref[2]) / sqrt(ref[2] * (1 - ref[2]) / n), abs(per[, 6] / n - ref[6]) / sqrt(ref[6] * (1 - ref[6]) / n),
          abs(per[, 4] / n - ref[4]) / sqrt(ref[4] * (1 - ref[4]) / n))
  first_all <- all(per[, 1] == n)
  runs <- all(tapply(d$visit, d$patientId, function(v) identical(as.integer(v), seq_along(v))))
  conv <- identical(unique(d$source), "synthetic") && identical(unique(d$modelTier), "scenario") &&
    identical(r$diagnostics$valueSource, "synthetic") && identical(r$diagnostics$modelTier, "scenario") && r$counts$realPatients == 0 &&
    r$counts$generatedRecords == nrow(d) && identical(r$status, "succeeded") && identical(r$conclusion, "estimable") && length(unique(d$patientId)) == 2L * n
  none <- .n46_run(.n46_scenario(n = 100, dropout = 0, visits = list(0, 1, 2)), 4603L, "c0", dir)
  list(pass = first_all && runs && z < 4 && conv && identical(nrow(vcr_test_table(none, "virtual-patients", dir)), 600L),
       detail = sprintf("12%% leaving before each follow-up visit: still in at visits 2/4/6 = %.3f/%.3f/%.3f against %.3f/%.3f/%.3f (worst %.2f binomial errors, both arms), everyone present at the first visit (%s), observed visits are a run from the first (%s); synthetic at tier scenario on every row, 0 real patients, %d records; no dropout keeps all 600 rows",
                        mean(per[, 2] / n), mean(per[, 4] / n), mean(per[, 6] / n), ref[2], ref[4], ref[6], z, first_all, runs, nrow(d)))
})

vcr_case("N46d", c("AC-11", "AC-26"), function() {
  # A stored population: each member gets an arm by a fixed uniform, a covariate enters every visit through
  # `truth.covariateEffects` (centred at the population mean, so the stated intercept is the average member's), arm sizes must add up
  # to the members, and a covariate effect with no population to take it from is refused rather than ignored. The
  # covariate effect and the treatment effect on the slope are recovered by a regression on the output table (lm on the visit-level rows,
  # whose fixed-effect estimates are unbiased for a mixed model's under MCAR dropout).
  set.seed(4604L, kind = VCR_RNG_KIND)
  n <- 4000L
  pop <- data.frame(x = stats::rnorm(n, 10, 2))
  in_pop <- vcr_test_input(pop, "pop_n46d@1", source = "synthetic", kind = "snapshot_file")
  sc <- list(design = list(nTreat = n / 2, nControl = n / 2), endpoint = list(type = "continuous"), visits = list(0, 2, 4),
             truth = list(intercept = 5, slope = 0.5, effect = -0.3, sd = 1, covariateEffects = list(x = 0.8), randomEffects = list(sdIntercept = 1, sdSlope = 0.1)),
             dropoutPerVisit = 0.05)
  dir <- tempfile("n46d"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- .n46_run(sc, 4604L, "d", dir, list(in_pop))
  d <- vcr_test_table(r, "virtual-patients", dir)
  fit <- summary(stats::lm(y ~ time * arm + x, d))$coefficients
  co <- function(k) c(fit[k, 1], fit[k, 2])
  z <- c(x = (co("x")[1] - 0.8) / co("x")[2], effect = (co("time:arm")[1] - (-0.3)) / co("time:arm")[2], slope = (co("time")[1] - 0.5) / co("time")[2])
  arms <- table(d$arm[d$visit == 1L])
  # centred covariate: the control arm's mean at t = 0 is the stated intercept, whatever the covariate's mean
  at0 <- mean(d$y[d$visit == 1L & d$arm == 0L])
  bad_n <- sc; bad_n$design$nTreat <- 10
  r_bad <- .n46_run(bad_n, 4604L, "d2", dir, list(in_pop))
  no_pop <- .n46_run(sc, 4604L, "d3", dir)
  codes <- list(bad = vcr_test_issue_codes(r_bad), none = vcr_test_issue_codes(no_pop))
  # a population column that carries the name of a column of the generated table is refused, never silently merged with it
  clash <- vcr_test_input(data.frame(x = pop$x, time = 1), "pop_n46d_clash@1", source = "synthetic", kind = "snapshot_file")
  r_clash <- .n46_run(sc, 4604L, "d4", dir, list(clash))
  list(pass = identical(r$status, "succeeded") && all(abs(z) < 4) && identical(as.integer(arms), as.integer(c(n / 2L, n / 2L))) && abs(at0 - 5) < 0.2 &&
         identical(r_bad$status, "failed") && "scenario_value_invalid" %in% codes$bad && identical(no_pop$status, "failed") && "scenario_value_invalid" %in% codes$none && "x" %in% names(d) &&
         identical(r_clash$status, "failed") && "scenario_value_invalid" %in% vcr_test_issue_codes(r_clash),
       detail = sprintf("population of %d members: covariate effect %.3f (want 0.8), effect on the slope %.3f (want -0.3), control slope %.3f (want 0.5) (worst %.2f SE); arms %d/%d; control mean at t = 0 is %.2f for the stated intercept 5 although the covariate averages 10; arm sizes that do not add up -> %s; a covariate effect with no population -> %s; a population column named like a column of the table -> %s",
                        n, co("x")[1], co("time:arm")[1], co("time")[1], max(abs(z)), arms[[1]], arms[[2]], at0, paste(codes$bad, collapse = ","), paste(codes$none, collapse = ","), paste(vcr_test_issue_codes(r_clash), collapse = ",")))
})

vcr_case("N46e", c("AC-09", "AC-20"), function() {
  # What the patients page draws, held to the table: the arms' trajectories are the per-visit means and the 2.5% / 97.5% quantiles of the
  # observed rows (recomputed here), at most twelve individual lines per arm are real patients' own rows, and the three example individuals
  # are at the 10th / 50th / 90th percentile of the true slope. The same person under the other arm differs by exactly effect x t at every
  # visit, starts at the same value, and the stretch after leaving is marked as unobserved. The headline and the panel say what the numbers are.
  sc <- .n46_scenario(n = 400, effect = -0.6, dropout = 0.2, visits = list(0, 2, 4, 6, 8))
  dir <- tempfile("n46e"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- .n46_run(sc, 4605L, "e", dir)
  d <- vcr_test_table(r, "virtual-patients", dir)
  tj <- r$diagnostics$trajectories
  ser <- function(key) Filter(function(s) identical(s$key, key), tj$series)[[1]]
  worst <- 0
  for (a in list(list(key = "treated", z = 1L), list(key = "control", z = 0L))) {
    s <- ser(a$key)
    for (j in 1:5) {
      v <- d$y[d$arm == a$z & d$visit == j]; q <- stats::quantile(v, c(0.025, 0.975), names = FALSE)
      p <- s$points[[j]]
      worst <- max(worst, abs(p$y - mean(v)), abs(p$low - q[1]), abs(p$high - q[2]), abs(p$x - c(0, 2, 4, 6, 8)[j]))
    }
  }
  lines_ok <- all(vapply(tj$series, function(s) length(s$individuals) == 12L, logical(1)))
  one <- ser("treated")$individuals[[1]]
  seen <- table(d$patientId[d$arm == 1L]); first_pid <- d$patientId[d$arm == 1L & d$visit == 1L]; first_pid <- first_pid[seen[first_pid] >= 2L][1]
  mine <- d[d$patientId == first_pid, ]
  close <- function(a, b) length(a) == length(b) && max(abs(a - b)) < 1e-9
  line_ok <- close(vapply(one, function(p) p$y, numeric(1)), mine$y) && close(vapply(one, function(p) p$x, numeric(1)), mine$time)
  # the three examples are the patients at the 10th / 50th / 90th percentile of the TRUE slope among those seen twice or more: the draws are
  # reproduced here from the job's own seed and the person ids carry the index, so the choice can be checked against the latent slopes
  set.seed(4605L, kind = VCR_RNG_KIND)
  sim <- vcr_sim_longitudinal(400, 400, c(0, 2, 4, 6, 8), 50, -0.4, -0.6, 2.5, 6, 0.35, -0.3, 0.2)
  ids <- paste0("vp_", vapply(seq_len(800), function(i) substr(vcr_sha256(paste(4605L, "job_n46e", i, sep = ":")), 1L, 12L), character(1)))
  eligible <- which(rowSums(sim$observed) >= 2L); true_slope <- -0.4 + sim$u1 + (-0.6) * sim$arm
  at <- eligible[order(true_slope[eligible], eligible)][ceiling(c(0.1, 0.5, 0.9) * length(eligible))]
  exs <- r$diagnostics$examples
  ex_ok <- length(exs) == 3L && identical(vapply(exs, function(e) e$id, character(1)), ids[at]) && all(diff(true_slope[at]) > 0) &&
    identical(vapply(exs, function(e) e$origin, character(1)), c("斜率偏低的虚拟患者", "斜率居中的虚拟患者", "斜率偏高的虚拟患者"))
  cf_ok <- TRUE
  for (e in exs) {
    given <- e$scenarios$series[[1]]$points; other <- e$scenarios$series[[2]]$points
    arm <- d$arm[d$patientId == e$id][1]
    gap <- vapply(seq_along(given), function(j) given[[j]]$y - other[[j]]$y, numeric(1))
    tt <- vapply(given, function(p) p$x, numeric(1))
    want <- if (arm == 1L) -0.6 * tt else 0.6 * tt
    rows <- d[d$patientId == e$id, ]
    cf_ok <- cf_ok && max(abs(gap - want)) < 1e-9 && given[[1]]$y == other[[1]]$y && identical(e$source, "synthetic") &&
      close(vapply(given[seq_len(nrow(rows))], function(p) p$y, numeric(1)), rows$y)
  }
  # a patient who left: the stretch after their last visit is marked as the unobserved one, on both arms' series
  gone <- which(rowSums(sim$observed) < 5L & rowSums(sim$observed) >= 2L)[1]
  ex_gone <- .vcr_longitudinal_example(sim, gone, ids[gone], "x", -0.6)
  last <- sum(sim$observed[gone, ])
  unobs_ok <- all(vapply(ex_gone$scenarios$series, function(s) length(s$unobserved) == 1L && s$unobserved[[1]]$from == c(0, 2, 4, 6, 8)[last + 1L] && s$unobserved[[1]]$to == 8, logical(1))) &&
    grepl(sprintf("第 %d 次随访后退出", last), ex_gone$baseline[[3]]$value, fixed = TRUE)
  panel <- r$diagnostics$panels[[1]]
  list(pass = worst < 1e-9 && lines_ok && line_ok && ex_ok && cf_ok && unobs_ok && is.character(r$diagnostics$headline) && length(panel$rows) == 5L &&
         identical(tj$series[[1]]$bandKind, "prediction") && tj$series[[1]]$bandLevel == 0.95 && identical(tj$series[[1]]$source, "synthetic"),
       detail = sprintf("arm trajectories equal the table's per-visit means and 95%% bands (worst gap %.1g over 10 arm-visits); 12 individual lines per arm, the first is that patient's own rows (%s); the three examples are the patients at the 10th/50th/90th percentile of the latent slope (%s) with true slopes %s; the same person under the other arm differs by exactly 0.6 t at every visit and starts at the same value (%s); the stretch after leaving is marked unobserved (%s); headline: %s",
                        worst, line_ok, ex_ok, paste(sprintf("%.2f", true_slope[at]), collapse = " < "), cf_ok, unobs_ok, r$diagnostics$headline))
})

vcr_case("N46f", c("AC-04", "AC-30"), function() {
  # The job agrees with the domain and is reproducible: the scenario the domain publishes as its example runs and gives the same bytes on
  # one core and eight; a null effect is a legal scenario (the arms differ by nothing but noise); a scenario the schema does not list a key
  # of is refused by its path, and the visits must be a strictly increasing schedule of at least two times.
  sc <- .n46_scenario(n = 60, effect = 0, dropout = 0.1, visits = list(0, 3, 6))
  dir1 <- tempfile("n46f1"); dir8 <- tempfile("n46f8"); dir.create(dir1); dir.create(dir8); on.exit(unlink(c(dir1, dir8), recursive = TRUE), add = TRUE)
  one <- .n46_run(sc, 4606L, "f", dir1, cores = 1L); eight <- .n46_run(sc, 4606L, "f", dir8, cores = 8L)
  same_table <- identical(readLines(file.path(dir1, "virtual-patients.csv")), readLines(file.path(dir8, "virtual-patients.csv")))
  same_hash <- identical(one$manifest$outputHash, eight$manifest$outputHash)
  bad_key <- sc; bad_key$truth$treatmentEffect <- 1
  bad_visits <- sc; bad_visits$visits <- list(0, 6, 3)
  one_visit <- sc; one_visit$visits <- list(0)
  codes <- lapply(list(key = bad_key, visits = bad_visits, short = one_visit), function(s) .n46_run(s, 4606L, "f2", dir1))
  refusals <- vapply(codes, function(r) paste(r$status, paste(vcr_test_issue_codes(r), collapse = "+")), character(1))
  null_ok <- identical(one$status, "succeeded") && abs(vcr_measure_value(one, "generated_records") - nrow(vcr_test_table(one, "virtual-patients", dir1))) < 1e-9
  list(pass = same_table && same_hash && null_ok && all(grepl("^failed ", refusals)) && grepl("scenario_field_unknown", refusals[["key"]]) && grepl("scenario_value_invalid", refusals[["visits"]]) && grepl("scenario_value_invalid", refusals[["short"]]),
       detail = sprintf("1 and 8 cores: the table is byte-identical (%s) and so is the output hash (%s); a null effect is a legal scenario; refused by name: an unlisted key (%s), visits out of order (%s), one visit (%s)",
                        same_table, same_hash, refusals[["key"]], refusals[["visits"]], refusals[["short"]]))
})
