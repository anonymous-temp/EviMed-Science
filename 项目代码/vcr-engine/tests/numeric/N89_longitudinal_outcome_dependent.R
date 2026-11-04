# N89 — patients.longitudinal 1.2.0 (algorithm round T11, 2026-11-03): dropout that depends on the outcome, a rescue medication, a curved trajectory.
#
# "15% 用救援药时，效应和样本量变成多少": the generator runs every person through the visits under both arms, so the effect under each
# estimand (treatment policy: the outcome as it comes; hypothetical: the outcome had there been no rescue) is a known truth, and so is the
# bias of an analysis that ignores what happened. Held to:
#
#   a  the old bits: a scenario that states none of the new keys is the 1.1.0 generator to the bit (output hashes recorded from the code of
#      the previous release), under the 1.0.0, 1.1.0 and 1.2.0 labels alike
#   b  known-truth bias of the naive analyses under MCAR, MAR and MNAR dropout: nlme's mixed model (fitted to the output table, a likelihood
#      analysis that is right when what is missing is explained by what was seen) recovers the effect under MAR and is biased under MNAR; a plain comparison
#      of the people still in at the last visit is biased under both
#   c  rescue: the hypothetical effect is the model's own effect times the time scale, exactly; the plain comparison of all outcomes estimates
#      the treatment-policy effect (the generated people's own mean difference of potential outcomes); the mixed model fitted with the values after
#      rescue left out recovers the hypothetical effect (rescue depends on the previous value, which that analysis sees); and the two estimands differ
#   d  the draws: dropout depending on the outcome with a zero slope is the MCAR mask of the same seed, a curved trajectory is the same people,
#      and nobody's draws depend on how many people come after them, rescue included
#   e  the curved mean: the arm means at every visit are the closed form on g(t), and the arms start alike
#   f  the job: the estimands, the rescue column of the table, the panel rows, a population column named like it refused

.n89_scenario <- function(n = 300, effect = -0.3, dropout = 0.1, visits = list(0, 2, 4, 6, 8), ...) {
  c(list(design = list(nTreat = n, nControl = n), endpoint = list(type = "continuous"), visits = visits,
         truth = list(intercept = 50, slope = -0.4, effect = effect, sd = 2.5, randomEffects = list(sdIntercept = 6, sdSlope = 0.35, correlation = -0.3)), dropoutPerVisit = dropout), list(...))
}
.n89_fingerprint <- function(r, dir) {
  d <- vcr_test_table(r, "virtual-patients", dir)
  vcr_sha256(vcr_canonical_json(list(table = as.list(d), measures = r$measures, summary = r$diagnostics[c("trajectories", "expected", "observed", "panels", "model", "dropoutPerVisit")])))
}
.n89_run <- function(sc, seed, tag = "x", version = NULL, dir = NULL) {
  job <- vcr_test_job("patients.longitudinal", sc, seed = seed, job_id = paste0("job_n89", tag))
  if (!is.null(version)) job$methodVersion <- version
  vcr_test_run(job, output_dir = dir)
}
.n89_lme <- function(d) {
  d$patientId <- factor(d$patientId)
  suppressWarnings(nlme::lme(y ~ time * arm, random = ~ time | patientId, data = d, method = "REML", control = nlme::lmeControl(opt = "optim", maxIter = 200, msMaxIter = 200)))
}

vcr_case("N89a", c("AC-31", "AC-04"), function() {
  # recorded with the code of the release before this one (git: the generator at 1.1.0), scenario .n89_scenario(300, -0.3, dropout), seed 8901, one job id
  recorded <- c("1.0.0|0" = "230ba3da3e3b6117b1f8c73757f74b7dd1ca5ccc4da00575dbf6771b583fc97a", "1.0.0|0.1" = "17f5c7b95cd0277a5d2d8e47ddb5b39f9b77709c96bc932a3e0a5ec3eaeecb24",
                "1.1.0|0" = "7eef72ad4448d9e1f8bde390ca9e24b69bf7007bddf228836fba63b532276ab6", "1.1.0|0.1" = "b13b192caa6a06d8fbe8d17a11d5706dcf5db762834703571def0c3e980fb961")
  got <- character(0); same <- TRUE
  for (key in names(recorded)) {
    parts <- strsplit(key, "|", fixed = TRUE)[[1]]
    dir <- tempfile("n89a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
    r <- .n89_run(.n89_scenario(dropout = as.numeric(parts[2])), 8901L, "", parts[1], dir)
    fp <- .n89_fingerprint(r, dir); got[key] <- fp
    same <- same && identical(fp, recorded[[key]])
  }
  # the current label replays what 1.1.0 did
  newer <- vapply(c(0, 0.1), function(dr) { dir <- tempfile("n89a2"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE); .n89_fingerprint(.n89_run(.n89_scenario(dropout = dr), 8901L, "", "1.2.0", dir), dir) }, character(1))
  list(pass = same && identical(unname(newer), unname(recorded[c("1.1.0|0", "1.1.0|0.1")])),
       detail = sprintf("a scenario with none of the new keys, labelled 1.0.0 and 1.1.0, with and without dropout: %d of %d output hashes (table, measures, trajectories, moments, panels, model) equal those recorded from the previous release's code; labelled 1.2.0 it equals 1.1.0 (%s)",
                        sum(got == recorded[names(got)]), length(recorded), identical(unname(newer), unname(recorded[c("1.1.0|0", "1.1.0|0.1")]))))
})

vcr_case("N89b", c("AC-11", "AC-29"), function() {
  if (!requireNamespace("nlme", quietly = TRUE)) return(list(pass = FALSE, detail = "error: nlme (R's recommended package, the cross-check of the mixed model) is not installed (the run must not skip silently)"))
  # 6,000 per arm, 5 visits (0 to 8), effect -0.6 on the slope: the mean difference at the last visit is -4.8. Dropout starts at 6% per visit at an
  # average outcome and rises by a factor of e^5 per standard deviation (higher values leave sooner); MAR reads the previous value, MNAR the value at the visit.
  truth_slope <- -0.6; truth_last <- -4.8
  rows <- list(); out <- character(0)
  for (mech in c("mcar", "mar", "mnar")) {
    sc <- .n89_scenario(6000, truth_slope, 0.06)
    if (!identical(mech, "mcar")) sc$dropoutModel <- list(mechanism = mech, logOddsPerSd = 5)
    dir <- tempfile("n89b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
    r <- .n89_run(sc, 8902L, mech, NULL, dir)
    d <- vcr_test_table(r, "virtual-patients", dir)
    fit <- .n89_lme(d); co <- summary(fit)$tTable["time:arm", ]
    last <- d[d$visit == 5L, ]; a <- last$y[last$arm == 1L]; b <- last$y[last$arm == 0L]
    naive <- mean(a) - mean(b); naive_se <- sqrt(stats::var(a) / length(a) + stats::var(b) / length(b))
    rows[[mech]] <- list(lme = co[[1]], lme_se = co[[2]], naive = naive, naive_se = naive_se, stay = nrow(last) / 12000)
    out <- c(out, sprintf("%s: mixed model slope effect %.4f (error %.4f; truth %.1f), people still in at the last visit differ by %.3f (error %.3f; truth %.1f), %.0f%% stay", mech, co[[1]], co[[2]], truth_slope, naive, naive_se, truth_last, 100 * nrow(last) / 12000))
  }
  z <- function(x) (x$lme - truth_slope) / x$lme_se
  zn <- function(x) (x$naive - truth_last) / x$naive_se
  list(pass = abs(z(rows$mcar)) < 3.5 && abs(zn(rows$mcar)) < 3.5 && abs(z(rows$mar)) < 3.5 && abs(zn(rows$mar)) > 4 && abs(rows$mar$naive - truth_last) > 0.4 &&
         abs(z(rows$mnar)) > 4 && rows$mnar$lme > truth_slope && abs(zn(rows$mnar)) > 4 && rows$mar$stay < 0.7 && rows$mnar$stay < 0.7,
       detail = paste(out, collapse = "; "))
})

vcr_case("N89c", c("AC-11", "AC-29"), function() {
  if (!requireNamespace("nlme", quietly = TRUE)) return(list(pass = FALSE, detail = "error: nlme (R's recommended package, the cross-check of the mixed model) is not installed (the run must not skip silently)"))
  n <- 8000L
  sc <- .n89_scenario(n, -0.6, 0, rescue = list(perVisit = 0.05, effect = -6, logOddsPerSd = 3))
  dir <- tempfile("n89c"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- .n89_run(sc, 8903L, "c", NULL, dir)
  d <- vcr_test_table(r, "virtual-patients", dir)
  est <- r$diagnostics$estimands
  hyp_truth <- -0.6 * 8                                          # the model's own effect times the time scale: nothing else
  last <- d[d$visit == 5L, ]
  a <- last$y[last$arm == 1L]; b <- last$y[last$arm == 0L]
  all_data <- mean(a) - mean(b); all_se <- sqrt(stats::var(a) / length(a) + stats::var(b) / length(b))
  # the hypothetical analysis: the values from the visit rescue started are left out, a mixed model on what remains
  keep <- d[d$rescue == 0L, ]
  fit <- .n89_lme(keep); co <- summary(fit)$tTable["time:arm", ]
  hyp_hat <- co[[1]] * 8; hyp_se <- co[[2]] * 8
  # the generated people carry both potential outcomes: the plain difference of arm means at the last visit is unbiased for their own mean of y1 - y0
  pot <- mean(last$y1 - last$y0)
  share <- tapply(last$rescue, last$arm, mean)
  list(pass = abs(est$hypothetical$effect - hyp_truth) < 1e-9 && abs(est$treatmentPolicy$effect - pot) < 1e-9 && abs(all_data - est$treatmentPolicy$effect) < 4 * all_se &&
         abs(hyp_hat - hyp_truth) < 3.5 * hyp_se && abs(est$treatmentPolicy$effect - hyp_truth) > 5 * all_se && all(share > 0.2) && share[["0"]] > share[["1"]] &&
         est$treatmentPolicy$perArm90 != est$hypothetical$perArm90,
       detail = sprintf("%d + %d people, rescue 5%% a visit at an average value (more when the previous value is high), lowering the outcome by 6 from the visit it starts: %.0f%% of the control arm and %.0f%% of the treated arm are on it at the last visit; hypothetical effect %.4f = -0.6 x 8 (exact); treatment-policy effect %.3f = the people's own mean of y1 - y0 %.3f, and the plain difference of arm means is %.3f (error %.3f); a mixed model with the post-rescue values left out gives %.3f (error %.3f) for the hypothetical effect; people per arm for 90%% power: %d under treatment policy, %d under the hypothetical strategy",
                        n, n, 100 * share[["0"]], 100 * share[["1"]], est$hypothetical$effect, est$treatmentPolicy$effect, pot, all_data, all_se, hyp_hat, hyp_se, as.integer(est$treatmentPolicy$perArm90), as.integer(est$hypothetical$perArm90)))
})

vcr_case("N89d", c("AC-31", "AC-11"), function() {
  vs <- c(0, 2, 4, 6, 8)
  draw <- function(n1, n0, seed, ..., shape = NULL, dropout_model = NULL, rescue = NULL, dropout = 0.1) {
    set.seed(seed, kind = VCR_RNG_KIND)
    vcr_sim_longitudinal(n1, n0, vs, 50, -0.4, -0.3, 2.5, 6, 0.35, -0.3, dropout, shape = shape, dropout_model = dropout_model, rescue = rescue)
  }
  mcar <- draw(300, 300, 8904L)
  mar0 <- draw(300, 300, 8904L, dropout_model = list(kind = "mar", slope = 0))
  mnar0 <- draw(300, 300, 8904L, dropout_model = list(kind = "mnar", slope = 0))
  zero_slope <- identical(mcar$observed, mar0$observed) && identical(mcar$observed, mnar0$observed) && identical(mcar$y, mar0$y)
  curved <- draw(300, 300, 8904L, shape = list(kind = "plateau", halfTime = 3))
  same_people <- identical(curved$u0, mcar$u0) && identical(curved$u1, mcar$u1) && identical(curved$observed, mcar$observed) && !identical(curved$y, mcar$y)
  # nobody's draws depend on how many people come after them, with the rescue block in the row
  feat <- list(dropout_model = list(kind = "mar", slope = 2), rescue = list(perVisit = 0.1, effect = -2, slope = 1))
  small <- do.call(draw, c(list(50, 50, 8905L), feat)); big <- do.call(draw, c(list(100, 100, 8905L), feat))
  first <- seq_len(50)
  prefix <- identical(small$u0[first], big$u0[first]) && identical(small$y[first, ], big$y[first, ]) && identical(small$observed[first, ], big$observed[first, ]) &&
    identical(small$rescue[first, ], big$rescue[first, ]) && identical(small$y_nr[first, ], big$y_nr[first, ])
  # the no-rescue world of a person with rescue is the person: the same model without rescue (and with an outcome-dependent dropout of zero slope) has the same values
  with_rescue <- do.call(draw, c(list(200, 200, 8906L), list(rescue = list(perVisit = 0.1, effect = -2, slope = 1), dropout_model = list(kind = "mar", slope = 0))))
  list(pass = zero_slope && same_people && prefix && all(with_rescue$rescue[, 1] == 0L) && all(with_rescue$rescue[, 5] >= with_rescue$rescue[, 4]) && mean(with_rescue$rescue[, 5]) > 0.1,
       detail = sprintf("a dropout model with slope 0 (MAR and MNAR) is the MCAR mask and the MCAR values of the same seed (%s); a plateau trajectory is the same people with other values (%s); with a rescue and a dropout model, the first 50 people of a 50 + 50 run are those of a 100 + 100 run, bit for bit (%s); rescue starts after the first visit and, once started, stays on (%.0f%% by the last visit)",
                        zero_slope, same_people, prefix, 100 * mean(with_rescue$rescue[, 5])))
})

vcr_case("N89e", c("AC-11", "AC-29"), function() {
  vs <- c(0, 1, 2, 4, 6, 9)
  worst <- 0; arms_alike <- TRUE; parts <- character(0)
  for (shape in list(list(kind = "plateau", halfTime = 2.5), list(kind = "quadratic", curvature = -0.02), list(kind = "quadratic", curvature = 0.03))) {
    set.seed(8907L, kind = VCR_RNG_KIND)
    n <- 4000L
    sim <- vcr_sim_longitudinal(n, n, vs, 20, -0.5, -0.25, 1.5, 3, 0.2, 0.1, 0, shape = shape)
    g <- .vcr_longitudinal_shape(vs, shape)
    for (zz in 0:1) for (j in seq_along(vs)) {
      v <- sim$y[sim$arm == zz, j]
      mean_ref <- 20 + (-0.5 + -0.25 * zz) * g[j]; sd_ref <- sqrt(3^2 + 2 * 0.1 * 3 * 0.2 * g[j] + 0.2^2 * g[j]^2 + 1.5^2)
      worst <- max(worst, abs(mean(v) - mean_ref) / (sd_ref / sqrt(length(v))), abs(stats::sd(v) - sd_ref) / (sd_ref / sqrt(2 * (length(v) - 1))))
    }
    arms_alike <- arms_alike && g[1] == 0 && abs(mean(sim$y[sim$arm == 1L, 1]) - mean(sim$y[sim$arm == 0L, 1])) < 4 * sqrt(2 * (9 + 1.5^2) / n)
    parts <- c(parts, sprintf("%s g(9) = %.3f", shape$kind, g[length(g)]))
  }
  # through the job: the stated moments of the result (the page draws them under the generated trajectory) are the formula on g
  sc <- .n89_scenario(200, -0.25, 0, visits = as.list(vs), trajectory = list(kind = "plateau", halfTime = 2.5))
  r <- .n89_run(sc, 8908L, "e")
  ex <- r$diagnostics$expected
  g <- .vcr_longitudinal_shape(vs, list(kind = "plateau", halfTime = 2.5))
  expected_ok <- max(abs(unlist(ex$control$mean) - (50 + -0.4 * g)), abs(unlist(ex$treated$mean) - (50 + (-0.4 + -0.25) * g))) < 1e-12 && identical(unlist(ex$visits), vs)
  list(pass = worst < 4.5 && arms_alike && expected_ok && identical(r$status, "succeeded"),
       detail = sprintf("three curved trajectories (%s), 4,000 + 4,000 people, six visits: the mean and SD of every arm and visit are the closed form on g(t) within %.2f Monte-Carlo errors; the arms start alike (g(0) = 0); the result's stated moments equal the formula on g(t) (%s)", paste(parts, collapse = ", "), worst, expected_ok))
})

vcr_case("N89f", c("AC-04", "AC-26"), function() {
  sc <- .n89_scenario(120, -0.4, 0.08, trajectory = list(kind = "plateau", halfTime = 3), dropoutModel = list(mechanism = "mar", logOddsPerSd = 1), rescue = list(perVisit = 0.05, effect = -2, logOddsPerSd = 0.5))
  dir <- tempfile("n89f"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- .n89_run(sc, 8909L, "f", NULL, dir)
  d <- vcr_test_table(r, "virtual-patients", dir)
  est <- r$diagnostics$estimands
  rows <- unlist(lapply(r$diagnostics$panels, function(p) vapply(p$rows, function(x) x$label, character(1))))
  # a rescue-free scenario has no estimand block and no rescue column
  plain <- .n89_run(.n89_scenario(60), 8910L, "f2", NULL, dir)
  d2 <- vcr_test_table(plain, "virtual-patients", dir)
  clash <- vcr_test_input(data.frame(rescue = 1, x = seq_len(40)), "pop_n89f@1", source = "synthetic", kind = "snapshot_file")
  sc_pop <- .n89_scenario(20, -0.4, 0.05, rescue = list(perVisit = 0.05, effect = -2)); sc_pop$design <- list(nTreat = 20, nControl = 20)
  refused <- vcr_test_run(vcr_test_job("patients.longitudinal", sc_pop, list(clash), seed = 1L))
  list(pass = identical(r$status, "succeeded") && "rescue" %in% names(d) && !("rescue" %in% names(d2)) && is.null(plain$diagnostics$estimands) && !is.null(est$treatmentPolicy) && !is.null(est$hypothetical) &&
         any(grepl("假想策略", rows)) && any(grepl("治疗策略", rows)) && r$counts$realPatients == 0 && identical(refused$status, "failed") &&
         identical(unique(d$source), "synthetic") && all(d$rescue %in% c(0L, 1L)),
       detail = sprintf("a job with a plateau, a MAR dropout model and a rescue medication: the table carries a 0/1 rescue column (a scenario without one has none), the result carries both estimands with the people each needs and the page's panel names the treatment-policy and the hypothetical strategy; a population column called rescue is refused; %d rows, all synthetic, no real patient", nrow(d)))
})
