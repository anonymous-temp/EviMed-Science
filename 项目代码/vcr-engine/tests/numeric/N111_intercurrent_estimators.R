# N111 — intercurrent events and estimators aligned to the estimand, in the beta_logit family of patients.progression 1.2.0 (plan R26, 2026-11-09)
#
# Each method is held to something outside its own code: the MMRM to `nlme::gls` and to the `mmrm` package (the cross-check lock), the conditional-mean
# imputation to a hand-computed small case and to an independent per-person implementation built on `mmrm`'s own fitted coefficients, the true value of
# each estimand to the model's exact moments and to closed limits, and each estimator's bias and coverage to that true value.
#
#   a  the factored maximum-likelihood fast path = `mmrm::mmrm(reml = FALSE)` on fixed monotone data (effects 5e-4, standard errors 5e-4 relative,
#      covariance 1e-3 of the largest variance) and = `nlme::gls(method = "ML")` (effects 5e-4, covariance 1e-3 of the largest variance); the engine's gls path (REML) = `mmrm` REML
#   b  non-monotone data: `auto` takes the gls path and matches `mmrm` REML; the factored path refuses it
#   c  conditional-mean imputation: jump to reference and copy reference on a hand-computed person (two visits, known coefficients and covariance), the
#      delta shifts only the treated arm's imputed values, and on fixed data the point estimate equals an independent per-person implementation built on
#      `mmrm`'s fitted coefficients and covariance
#   d  the tipping point: the estimate is linear in delta, and `vcr_cmi_tipping` returns the delta at which the jackknife result stops being significant
#   e  the drug of a person who stops: the engine's per-person drug equals the family's `vcr_beta_logit_drug` for any common stop time
#   f  the true values: the hypothetical one equals the exact moments of the model; the treatment-policy one equals it when nobody stops, and is the
#      untreated arm's when everybody stops before the dose begins; a death scores 70
#   g  bias and coverage per strategy x estimator against the true values: where the estimator is aligned the bias is within its Monte Carlo error and the
#      interval covers within its own, where it is not the bias is the stated size (everyone followed; a retrieved share of one half; progression-dependent stopping)
#   h  no intercurrent event, no change: an MMRM with nobody stopping or leaving is the one-visit ANCOVA's estimate when there is one post-baseline visit
#   i  the null: the type I error of the MMRM with independent stopping is the test's level within 3 Monte Carlo errors (it was 4 plus 0.002, a band of +/- 0.8 points)
#   l  the MMRM's small-sample standard error against `mmrm` Kenward-Roger, and its type I error at 30 people per arm with dropout (it was 5.4 to 5.9% at 5%)
#   j  the same seed gives the same result on one core and on two
#   k  what is refused, by name

.n111_P <- function(v, basis = "assumed") list(value = v, basis = basis)
# fixed monotone data: n people, three post-baseline visits, an unstructured covariance, the last visit observed by pattern
.n111_data <- function(seed = 110L, n = 90L, J = 3L, monotone = TRUE, effect = 1) {
  set.seed(seed)
  arm <- rep(0:1, each = n / 2); base <- stats::rnorm(n, 25, 6)
  S <- matrix(c(25, 12, 10, 12, 36, 20, 10, 20, 49), 3L)
  mu <- cbind(1 + 0.05 * (base - 25) - 1 * effect * arm, 2.5 + 0.1 * (base - 25) - 2 * effect * arm, 4.5 + 0.12 * (base - 25) - 3.4 * effect * arm)
  e <- t(chol(S)) %*% matrix(stats::rnorm(3L * n), 3L, n)
  chg <- mu + t(e)
  last <- sample.int(3L, n, replace = TRUE, prob = c(0.2, 0.25, 0.55)); last[arm == 1 & stats::runif(n) < 0.1] <- 1L
  mask <- outer(seq_len(n), 1:3, function(i, j) j <= last[i])
  if (!monotone) { mask[c(3, 10, 21, 37, 44, 52, 66, 80), 2L] <- FALSE; mask[c(5, 30, 70), 1L] <- FALSE; mask[c(12, 40), 3L] <- FALSE }
  list(chg = chg, mask = mask, arm = arm, base = base, n = n, J = 3L)
}
.n111_long <- function(d) {
  x <- data.frame(id = factor(rep(seq_len(d$n), d$J)), vi = rep(seq_len(d$J), each = d$n), chg = as.vector(d$chg), arm = rep(d$arm, d$J), base = rep(d$base, d$J), use = as.vector(d$mask))
  x <- x[x$use, , drop = FALSE]; x$visit <- factor(x$vi); x[order(x$id, x$vi), , drop = FALSE]
}
.n111_arm_names <- function(J) paste0("visit", seq_len(J), ":arm")
.n111_mmrm <- function(d, reml) mmrm::mmrm(chg ~ 0 + visit + visit:arm + visit:base + us(visit | id), data = .n111_long(d), reml = reml)
.n111_rel <- function(a, b) max(abs(a - b) / pmax(abs(b), 1e-12))
.n111_scaled <- function(a, b) max(abs(a - b)) / max(abs(b))

vcr_case("N111a", c("AC-04", "AC-28"), function() {
  d <- .n111_data(); nm <- .n111_arm_names(d$J)
  fast <- vcr_mmrm_fit(d$chg, d$mask, d$arm, d$base, "factored", small_sample = FALSE)
  mml <- .n111_mmrm(d, FALSE)
  gl <- nlme::gls(chg ~ 0 + visit + visit:arm + visit:base, data = .n111_long(d), correlation = nlme::corSymm(form = ~ vi | id), weights = nlme::varIdent(form = ~ 1 | visit),
                  method = "ML", control = nlme::glsControl(tolerance = 1e-10, msTol = 1e-10, maxIter = 500L, msMaxIter = 500L))
  gls_sigma <- {
    sdv <- c(1, as.numeric(stats::coef(gl$modelStruct$varStruct, unconstrained = FALSE))) * gl$sigma
    r <- diag(d$J); r[lower.tri(r)] <- as.numeric(stats::coef(gl$modelStruct$corStruct, unconstrained = FALSE)); r <- r + t(r) - diag(d$J)
    diag(sdv) %*% r %*% diag(sdv)
  }
  eff_mm <- max(abs(fast$effect - stats::coef(mml)[nm])); se_mm <- .n111_rel(fast$se, sqrt(diag(stats::vcov(mml)))[nm])
  sig_mm <- .n111_scaled(fast$sigma, unclass(mml$cov)); eff_gl <- max(abs(fast$effect - stats::coef(gl)[nm])); sig_gl <- .n111_scaled(fast$sigma, gls_sigma)
  reml_engine <- vcr_mmrm_fit(d$chg, d$mask, d$arm, d$base, "gls"); reml_mm <- .n111_mmrm(d, TRUE)
  eff_r <- max(abs(reml_engine$effect - stats::coef(reml_mm)[nm])); se_r <- .n111_rel(reml_engine$se, sqrt(diag(stats::vcov(reml_mm)))[nm])
  list(pass = identical(fast$path, "factored") && identical(reml_engine$path, "gls") && eff_mm < 5e-4 && se_mm < 5e-4 && sig_mm < 1e-3 && eff_gl < 5e-4 && sig_gl < 1e-3 && eff_r < 5e-4 && se_r < 5e-4,
       detail = sprintf("90 people, three visits, monotone missing (%s observed at visits 1, 2, 3): the factored ML fit against mmrm (reml = FALSE): effects %.1e, standard errors %.1e relative, covariance %.1e of the largest variance; against nlme::gls (ML): effects %.1e, covariance %.1e of the largest variance; the engine's gls path against mmrm REML: effects %.1e, standard errors %.1e relative; the last visit's effect %.4f (SE %.4f)",
                        paste(colSums(d$mask), collapse = "/"), eff_mm, se_mm, sig_mm, eff_gl, sig_gl, eff_r, se_r, fast$effect[3L], fast$se[3L]))
})

vcr_case("N111b", c("AC-04", "AC-28"), function() {
  d <- .n111_data(seed = 111L, n = 100L, monotone = FALSE); nm <- .n111_arm_names(d$J)
  auto <- vcr_mmrm_fit(d$chg, d$mask, d$arm, d$base, "auto"); mm <- .n111_mmrm(d, TRUE)
  refused <- tryCatch({ vcr_mmrm_fit(d$chg, d$mask, d$arm, d$base, "factored"); "not refused" }, error = function(e) "refused")
  eff <- max(abs(auto$effect - stats::coef(mm)[nm])); se <- .n111_rel(auto$se, sqrt(diag(stats::vcov(mm)))[nm])
  list(pass = identical(auto$path, "gls") && identical(refused, "refused") && eff < 5e-4 && se < 5e-4,
       detail = sprintf("100 people with values missing between observed ones: auto takes the %s path and matches mmrm REML (effects %.1e, standard errors %.1e relative); the factored path %s", auto$path, eff, se, refused))
})

vcr_case("N111c", c("AC-04", "AC-28"), function() {
  # the hand case: one treated person who stopped after visit 1 with y1 = 3; own-arm means (1, 2), reference means (0.5, 0.8), covariance [[4, 2], [2, 3]]
  # jump: mean (1, 0.8): y2 = 0.8 + (2 / 4) (3 - 1) = 1.8; copy: mean (0.5, 0.8): y2 = 0.8 + (2 / 4) (3 - 0.5) = 2.05; delta 1 adds 1 for the treated arm only
  coef <- cbind(c(0.5, 0.8), c(0.5, 1.2), c(0, 0))
  S <- matrix(c(4, 2, 2, 3), 2L)
  chg <- rbind(c(3, NA), c(0.2, 1.1)); mask <- !is.na(chg); chg[is.na(chg)] <- 0
  arm <- c(1, 0); base <- c(0, 0); ice <- c(1, Inf)
  jr <- vcr_cmi_impute(chg, mask, arm, base, ice, coef, S, "jump"); cr <- vcr_cmi_impute(chg, mask, arm, base, ice, coef, S, "copy")
  jd <- vcr_cmi_impute(chg, mask, arm, base, ice, coef, S, "jump", delta = 1)
  # the same person with no reference to jump to (a control person who left) is imputed under their own arm's means: (0.5, 0.8), y1 = 3 -> 2.05 as well
  ctl <- vcr_cmi_impute(chg, mask, c(0, 0), base, c(Inf, Inf), coef, S, "jump")
  ok_hand <- abs(jr[1, 2] - 1.8) < 1e-12 && abs(cr[1, 2] - 2.05) < 1e-12 && abs(jd[1, 2] - 2.8) < 1e-12 && jd[2, 2] == chg[2, 2] && abs(ctl[1, 2] - 2.05) < 1e-12 && jr[1, 1] == 3
  # an independent per-person implementation of the same estimate on mmrm's own fitted coefficients and covariance (fixed data, jump to reference)
  d <- .n111_data(seed = 112L, n = 120L); mm <- .n111_mmrm(d, FALSE); co <- stats::coef(mm); J <- d$J
  coef_mm <- cbind(co[paste0("visit", 1:J)], co[paste0("visit", 1:J, ":arm")], co[paste0("visit", 1:J, ":base")]); Sg <- unclass(mm$cov)
  ice_v <- ifelse(rowSums(d$mask) < J, rowSums(d$mask), Inf)
  done <- d$chg
  for (i in seq_len(d$n)) {
    r <- d$mask[i, ]; if (all(r)) next
    mu <- coef_mm[, 1] + coef_mm[, 3] * d$base[i] + coef_mm[, 2] * d$arm[i]
    if (d$arm[i] == 1 && is.finite(ice_v[i])) { l <- ice_v[i]; mu[(l + 1L):J] <- (coef_mm[, 1] + coef_mm[, 3] * d$base[i])[(l + 1L):J] }
    o <- which(r); m <- which(!r)
    done[i, m] <- mu[m] + Sg[m, o, drop = FALSE] %*% solve(Sg[o, o, drop = FALSE], d$chg[i, o] - mu[o])
  }
  theta_ref <- unname(stats::lm.fit(cbind(1, d$arm, d$base), done[, J])$coefficients[2L])
  theta <- .vcr_cmi_point(d$chg, d$mask, d$arm, d$base, ice_v, "jump", 0)
  # with nothing missing the imputation is the ANCOVA of the last visit
  full <- matrix(TRUE, d$n, J); full_theta <- .vcr_cmi_point(d$chg, full, d$arm, d$base, rep(Inf, d$n), "jump", 0)
  anc <- unname(stats::lm.fit(cbind(1, d$arm, d$base), d$chg[, J])$coefficients[2L])
  list(pass = ok_hand && abs(theta - theta_ref) < 1e-3 && abs(full_theta - anc) < 1e-10,
       detail = sprintf("hand case: jump imputes %.4f (hand 1.8), copy %.4f (2.05), delta 1 gives %.4f (2.8), the control person is untouched and a control person who left is imputed under their own arm; 120 people: the point estimate %.5f against the per-person implementation on mmrm's coefficients %.5f (difference %.1e); nothing missing gives the ANCOVA (%.1e)",
                        jr[1, 2], cr[1, 2], jd[1, 2], theta, theta_ref, abs(theta - theta_ref), abs(full_theta - anc)))
})

vcr_case("N111d", c("AC-04", "AC-28"), function() {
  d <- .n111_data(seed = 113L, n = 300L, effect = 1.8)
  J <- d$J; ice_v <- ifelse(rowSums(d$mask) < J, rowSums(d$mask), Inf)
  est <- function(delta) .vcr_cmi_point(d$chg, d$mask, d$arm, d$base, ice_v, "jump", delta)
  e0 <- est(0); e1 <- est(1); e3 <- est(3)
  linear <- abs((e3 - e0) - 3 * (e1 - e0)) < 1e-9 && e1 > e0
  r0 <- vcr_cmi_jackknife(d$chg, d$mask, d$arm, d$base, ice_v, "jump", 0, 10L)
  tip <- vcr_cmi_tipping(d$chg, d$mask, d$arm, d$base, ice_v, "jump", alpha = 0.05, groups = 10L, upper = 20, tol = 1e-3)
  tstat <- function(delta) { r <- vcr_cmi_jackknife(d$chg, d$mask, d$arm, d$base, ice_v, "jump", delta, 10L); sign(e0) * r$estimate / r$se - stats::qt(0.975, r$df) }
  sig0 <- tstat(0) > 0
  list(pass = linear && sig0 && is.finite(tip) && tstat(max(tip - 0.01, 0)) > 0 && tstat(tip + 0.01) < 0,
       detail = sprintf("300 people: the estimate at delta 0, 1 and 3 is %.5f, %.5f, %.5f (linear in delta, treated arm only); significant at delta 0: %s; the tipping delta %s (the result is significant just below it and not just above it)",
                        e0, e1, e3, sig0, if (is.finite(tip)) sprintf("%.3f", tip) else format(tip)))
})

vcr_case("N111e", c("AC-04", "AC-28"), function() {
  par <- vcr_beta_logit_par(vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0")$medians)
  tr <- list(begin = 0, end = 52, emax = -0.4, et50 = 8, halfLife = 6, fraction = 0.2)
  visits <- c(0, 13, 26, 39, 52, 65)
  ok <- TRUE; worst <- 0
  for (stop in c(0, 10, 26, 40, 52, 70)) {
    ref <- vcr_beta_logit_drug(modifyList(tr, list(end = min(stop, 52))), visits)
    mine <- .vcr_ice_drug(tr, visits, rep(min(stop, 52), 3L))
    worst <- max(worst, abs(mine$symptomatic[2L, ] - ref$symptomatic), abs(mine$onDrug[2L, ] - ref$onDrug))
  }
  list(pass = worst < 1e-12,
       detail = sprintf("a person's own stop time through .vcr_ice_drug against the family's vcr_beta_logit_drug with the dose ending then (stops at weeks 0, 10, 26, 40, 52 and later): worst difference %.1e", worst))
})

# a scenario with the chosen estimator; typical study, no study-level dropout unless asked
.n111_sc <- function(n = 150L, kind = "mmrm", data = NULL, share_c = 0.1, share_t = 0.3, retrieved = 0.5, gamma = 0, dm = 0, pts = -3, dropout = "none", visits = c(0, 13, 26, 39, 52),
                     extra_ic = NULL, strategy = NULL, delta = NULL, groups = NULL) {
  tr <- list(symptomatic = list(pointsAt = .n111_P(pts), atWeek = 26, referenceAdas = 25, et50Weeks = .n111_P(8), washoutHalfLifeWeeks = .n111_P(4)))
  if (dm > 0) tr$diseaseModifying <- list(fraction = .n111_P(dm))
  ic <- list(discontinuation = list(shareControl = .n111_P(share_c), shareTreated = .n111_P(share_t), retrievedShare = .n111_P(retrieved)))
  if (gamma != 0) ic$discontinuation$progressionLogHazardPerSd <- .n111_P(gamma)
  ic <- c(ic, extra_ic)
  an <- list(kind = kind); if (!is.null(data)) an$data <- data; if (!is.null(delta)) an$delta <- .n111_P(delta); if (!is.null(groups)) an$jackknifeGroups <- groups
  s <- list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), timeUnit = "weeks", visits = visits, dropoutModel = dropout,
            model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = "typical_study"), treatment = tr, intercurrent = ic, analysis = an)
  if (!is.null(strategy)) s$estimand <- list(strategy = strategy)
  s
}
.n111_run <- function(sc, seed, cores = 2L, replicates = NULL) vcr_test_run(vcr_test_job("patients.progression", sc, seed = seed, replicates = replicates, cores = cores))
.n111_est <- function(r, strategy) Filter(function(e) identical(e$strategy, strategy), r$diagnostics$progression$intercurrent$estimands)[[1]]

vcr_case("N111f", c("AC-04", "AC-27", "AC-28"), function() {
  set <- vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0"); par <- vcr_beta_logit_par(set$medians)
  mk <- function(sc_) { s <- sc_; p <- list(par = par, treatment = .vcr_bl_treatment(s$treatment, 52), placebo = TRUE, visits = s$visits, at = length(s$visits),
                                           ice = .vcr_ice_read(s$intercurrent, 52)); p }
  # hypothetical truth = the exact moments' difference in mean change (no dropout), up to the Monte Carlo error over people
  p0 <- mk(.n111_sc(share_t = 0, share_c = 0, dm = 0.25)); t0 <- vcr_ice_truth(p0, 11001L)
  study <- vcr_beta_logit_typical_study(par); drug <- vcr_beta_logit_drug(p0$treatment, p0$visits)
  ctl <- vcr_beta_logit_moments(par, study, p0$visits, NULL, TRUE, FALSE); trt <- vcr_beta_logit_moments(par, study, p0$visits, drug, TRUE, FALSE)
  exact <- trt$change[p0$at] - ctl$change[p0$at]
  ok_exact <- abs(t0$hypothetical$value - exact) <= 4 * t0$hypothetical$mcse && abs(t0$treatment_policy$value - t0$hypothetical$value) < 1e-12
  # everybody stops before the dose begins (a huge hazard): the treated person never takes the drug, the two arms are alike, and the truth is zero
  p1 <- mk(.n111_sc(share_t = 0.999999, share_c = 0.1, dm = 0.25)); p1$ice$discontinuation$rate[["treated"]] <- 1e9; t1 <- vcr_ice_truth(p1, 11002L)
  # a stop halfway lies between the two truths, and a death scores 70 from the day it happens in both arms (the truth moves toward 0 by the same alive share)
  p2 <- mk(.n111_sc(share_t = 0.5, dm = 0.25)); t2 <- vcr_ice_truth(p2, 11003L)
  between <- t2$treatment_policy$value > t2$hypothetical$value && t2$treatment_policy$value < 0
  p3 <- mk(.n111_sc(share_t = 0, share_c = 0, dm = 0.25, extra_ic = list(death = list(share = .n111_P(0.3))))); t3 <- vcr_ice_truth(p3, 11004L)
  # the same people die in both arms and are scored 70 in both: the difference among them is zero, so the truth is the alive share's (about 0.7 at the end for an
  # exponential with 30% by the last visit) times the difference among the alive
  alive_share <- 0.7
  ok_death <- abs(t3$hypothetical$value - alive_share * exact) <= 4 * t3$hypothetical$mcse + 0.03
  list(pass = ok_exact && abs(t1$treatment_policy$value) < 1e-9 && abs(t1$hypothetical$value - exact) <= 4 * t1$hypothetical$mcse + 1e-9 && between && ok_death,
       detail = sprintf("hypothetical truth %.4f (MCSE %.4f) against the exact moments %.4f, equal to the treatment-policy truth when nobody stops; everybody stopping before the dose: %.1e; half stopping: %.4f (between %.4f and 0); 30%% dying: %.4f against %.4f x the alive share",
                        t0$hypothetical$value, t0$hypothetical$mcse, exact, abs(t1$treatment_policy$value), t2$treatment_policy$value, t2$hypothetical$value, t3$hypothetical$value, exact))
})

# ---- g: bias and coverage per strategy x estimator -----------------------------------------------------------------------------------------------------
# Two settings of the data-generating process (a symptomatic drug that fades in about four weeks, a drug that also changes the slope) and what each
# estimator answers. 150 per arm, 5,000 trials, everyone followed (retrievedShare 1) unless the case says otherwise.
.n111_row <- function(r, strategy) { e <- .n111_est(r, strategy); list(truth = e$truth$value, bias = e$bias$value, mcse = e$bias$mcse, cover = e$coverage$value, cover_se = e$coverage$mcse) }
.n111_aligned <- function(row) abs(row$bias) <= 4 * row$mcse + 0.03 && abs(row$cover - 0.95) <= 4 * row$cover_se + 0.01

vcr_case("N111g1", c("AC-04", "AC-28"), function() {
  # everyone followed (retrievedShare 1), stopping independent of the outcome: the treatment-policy estimand is estimated by the analysis of everything
  # collected (completers' ANCOVA and the MMRM) and the hypothetical one by the analyses of the on-treatment values (ANCOVA, MMRM)
  a <- .n111_run(.n111_sc(kind = "ancova", data = "all_observed", retrieved = 1), 11011L)
  m <- .n111_run(.n111_sc(kind = "mmrm", data = "all_observed", retrieved = 1), 11012L)
  ao <- .n111_run(.n111_sc(kind = "ancova", data = "on_treatment", retrieved = 1), 11013L)
  mo <- .n111_run(.n111_sc(kind = "mmrm", data = "on_treatment", retrieved = 1), 11014L)
  tp_a <- .n111_row(a, "treatment_policy"); tp_m <- .n111_row(m, "treatment_policy"); hy_ao <- .n111_row(ao, "hypothetical"); hy_mo <- .n111_row(mo, "hypothetical")
  tp_ao <- .n111_row(ao, "treatment_policy"); hy_a <- .n111_row(a, "hypothetical")
  fmt <- function(x) sprintf("bias %.3f (MCSE %.3f), coverage %.3f", x$bias, x$mcse, x$cover)
  # not aligned: the on-treatment analysis against the treatment-policy truth, and everything-collected against the hypothetical truth: the stated bias is the gap
  gap <- hy_ao$truth - tp_ao$truth
  list(pass = .n111_aligned(tp_a) && .n111_aligned(tp_m) && .n111_aligned(hy_ao) && .n111_aligned(hy_mo) && abs(tp_ao$bias - gap) <= 4 * tp_ao$mcse + 0.05 && abs(hy_a$bias + gap) <= 4 * hy_a$mcse + 0.05 && gap < -0.5,
       detail = sprintf("symptomatic drug fading in 4 weeks, 30%% vs 10%% stop, all followed: treatment-policy truth %.3f, hypothetical %.3f. ANCOVA on everything vs treatment policy: %s; MMRM on everything: %s; ANCOVA on-treatment vs hypothetical: %s; MMRM on-treatment: %s. Not aligned: the on-treatment ANCOVA against treatment policy %s (the gap of the two truths is %.3f); ANCOVA on everything against hypothetical %s",
                        tp_a$truth, hy_ao$truth, fmt(tp_a), fmt(tp_m), fmt(hy_ao), fmt(hy_mo), fmt(tp_ao), gap, fmt(hy_a)))
})

vcr_case("N111g2", c("AC-04", "AC-28"), function() {
  # a retrieved share of one half: the people who stopped and were not followed are missing because of what they stopped, so no analysis of what was
  # collected recovers the treatment-policy truth; the bias is the stated size (the stopper is under-represented 0.5 to 1)
  a <- .n111_run(.n111_sc(kind = "mmrm", data = "all_observed", retrieved = 0.5), 11021L)
  row <- .n111_row(a, "treatment_policy"); hy <- .n111_row(a, "hypothetical")
  # the treated arm's observed share at the last visit, from the run: the weights are 0.70 never stopping + 0.15 retrieved; the stoppers' weight is 0.15 / 0.85 rather than 0.30
  w_obs <- 0.15 / 0.85; w_true <- 0.30
  list(pass = row$bias < -0.2 && abs(row$cover - 0.95) > 0.01 && hy$bias > row$bias,
       detail = sprintf("retrieved share one half, MMRM on everything collected: treatment-policy truth %.3f, bias %.3f (MCSE %.3f), coverage %.3f, a stated bias because the treated stoppers weigh %.2f of the observed treated people instead of %.2f; against the hypothetical truth %.3f the bias is %.3f",
                        row$truth, row$bias, row$mcse, row$cover, w_obs, w_true, hy$truth, hy$bias))
})

vcr_case("N111g3", c("AC-04", "AC-28"), function() {
  # jump to reference with a symptomatic effect that fades within a visit: the reference-based estimate is the treatment-policy truth up to its own
  # small bias (the effect really is gone at the next visit); with a disease-modifying effect that persists, it is biased against the treatment-policy truth
  sym <- .n111_run(.n111_sc(n = 70L, kind = "cmi_jump_to_reference", retrieved = 1, strategy = "treatment_policy", groups = 6L), 11031L, replicates = 5000L)
  dm <- .n111_run(.n111_sc(n = 70L, kind = "cmi_jump_to_reference", retrieved = 1, dm = 0.4, strategy = "treatment_policy", groups = 6L), 11032L, replicates = 5000L)
  rs <- .n111_row(sym, "treatment_policy"); rd <- .n111_row(dm, "treatment_policy")
  # the interval of the delete-a-group jackknife (G - 1 df) is conservative by design: where the estimator is nearly aligned it covers at or above its level
  # and not wildly above it (review S17: this case held no coverage before)
  list(pass = abs(rs$bias) <= 0.15 && rs$cover >= 0.94 && rs$cover <= 0.98 && rd$cover < rs$cover && rd$bias > 0.2 && rd$bias > rs$bias + 0.1 && identical(sym$diagnostics$progression$intercurrent$estimator, "cmi_jump_to_reference"),
       detail = sprintf("jump to reference against the treatment-policy truth: symptomatic effect fading in 4 weeks bias %.3f (MCSE %.3f), coverage %.3f; with a disease-modifying share of 0.4 held after stopping the truth is %.3f and the imputation, which gives the person the reference's course, understates the effect by %.3f (MCSE %.3f)",
                        rs$bias, rs$mcse, rs$cover, rd$truth, rd$bias, rd$mcse))
})

vcr_case("N111g4", c("AC-04", "AC-28"), function() {
  # stopping that depends on the person's own decline (MNAR on the latent progression): the people who stay on treatment are the slow decliners, so the
  # on-treatment analyses are biased against the hypothetical truth even though every stop is independent of anything observed at the time
  m0 <- .n111_run(.n111_sc(kind = "mmrm", data = "on_treatment", retrieved = 1, gamma = 0, dm = 0.3), 11041L)
  m1 <- .n111_run(.n111_sc(kind = "mmrm", data = "on_treatment", retrieved = 1, gamma = 1.2, dm = 0.3), 11042L)
  r0 <- .n111_row(m0, "hypothetical"); r1 <- .n111_row(m1, "hypothetical")
  list(pass = .n111_aligned(r0) && abs(r1$bias) > 4 * r1$mcse + 0.03 && abs(r1$bias) > abs(r0$bias) + 0.1,
       detail = sprintf("MMRM on the on-treatment values against the hypothetical truth: independent stopping bias %.3f (MCSE %.3f), coverage %.3f; stopping 1.2 log hazard per SD of the person's own slope bias %.3f (MCSE %.3f), coverage %.3f",
                        r0$bias, r0$mcse, r0$cover, r1$bias, r1$mcse, r1$cover))
})

vcr_case("N111h", c("AC-04", "AC-28"), function() {
  # one post-baseline visit analysed and nobody leaving or stopping: the MMRM is the ANCOVA of that visit (the estimate is identical for the same seed; the standard
  # error differs by the divisor only, so the power is the same within a hair)
  base <- list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = 60L, nControl = 60L), timeUnit = "weeks", visits = c(0, 13, 26), dropoutModel = "none",
               model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = "typical_study"),
               treatment = list(symptomatic = list(pointsAt = .n111_P(-3), atWeek = 26, referenceAdas = 25, et50Weeks = .n111_P(8))))
  empty <- stats::setNames(list(), character(0))
  a <- base; a$analysis <- list(kind = "ancova", visit = 13); m <- base; m$analysis <- list(kind = "mmrm", visit = 13)
  # an empty intercurrent block takes the intercurrent path with nothing happening, so both draw the same people and scores
  a$intercurrent <- empty; m$intercurrent <- empty
  ra <- .n111_run(a, 11051L, cores = 1L, replicates = 5000L); rm <- .n111_run(m, 11051L, cores = 1L, replicates = 5000L)
  est <- function(r) Filter(function(x) identical(x$name, "simulated_difference"), r$measures)[[1]]$value
  pw <- function(r) r$measures[[1]]$value
  list(pass = identical(ra$status, "succeeded") && identical(rm$status, "succeeded") && abs(est(ra) - est(rm)) < 1e-9 && abs(pw(ra) - pw(rm)) < 0.01,
       detail = sprintf("one post-baseline visit analysed, nobody leaving or stopping: the simulated difference is %.9f for the ANCOVA and %.9f for the MMRM; power %.4f and %.4f (the MMRM's maximum-likelihood variance divides by n, the ANCOVA's by n - 3)", est(ra), est(rm), pw(ra), pw(rm)))
})

vcr_case("N111i", c("AC-04", "AC-27", "AC-28"), function() {
  # no drug at all (a null scenario: both arms alike, only stopping and the placebo response), everyone followed, stopping independent of the outcome
  s <- .n111_sc(n = 100L, kind = "mmrm", data = "all_observed", retrieved = 1); s$treatment <- stats::setNames(list(), character(0))
  null <- .n111_run(s, 11061L)
  m <- null$measures[[1]]
  list(pass = identical(null$status, "succeeded") && identical(m$name, "type_one_error") && abs(m$value - 0.05) <= 3 * m$mcse && abs(null$diagnostics$progression$intercurrent$estimands[[1]]$truth$value) < 1e-9,
       detail = sprintf("no drug, everyone followed, independent stopping: the MMRM's type I error %.4f (MCSE %.4f) at level 0.05 over %d trials; the true value of both estimands is %.1e",
                        m$value, m$mcse, null$diagnostics$progression$trials, abs(null$diagnostics$progression$intercurrent$estimands[[1]]$truth$value)))
})

vcr_case("N111j", c("AC-04", "AC-27", "AC-28"), function() {
  s <- .n111_sc(n = 60L, kind = "cmi_jump_to_reference", retrieved = 0.5, strategy = "treatment_policy", groups = 5L)
  a <- .n111_run(s, 11071L, cores = 1L, replicates = 5000L); b <- .n111_run(s, 11071L, cores = 2L, replicates = 5000L)
  same <- identical(a$measures[[1]]$value, b$measures[[1]]$value) && identical(a$manifest$outputHash, b$manifest$outputHash)
  list(pass = same, detail = sprintf("a reference-based imputation with intercurrent events, seed 11071: one core and two cores give the same result to the bit (power %.4f, output hash %s)", a$measures[[1]]$value, substr(a$manifest$outputHash, 1, 12)))
})

vcr_case("N111k", c("AC-04", "AC-27", "AC-28"), function() {
  code <- function(sc_) { r <- .n111_run(sc_, 11081L, cores = 1L, replicates = 100L); i <- c(r$issues %||% list(), r$diagnostics$issues %||% list()); if (length(i)) sprintf("%s@%s", i[[1]]$code, i[[1]]$field) else NA_character_ }
  no_half_life <- .n111_sc(); no_half_life$treatment$symptomatic$washoutHalfLifeWeeks <- NULL
  bad_share <- .n111_sc(share_t = 1.2)
  distributed <- .n111_sc(); distributed$treatment$symptomatic$pointsAt <- list(distribution = list(family = "normal", parameters = list(mean = -3, sd = 1), source = list(kind = "stated"), tier = "stated"))
  old_family <- list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = 50L, nControl = 50L), timeUnit = "weeks", visits = c(0, 12, 24),
                     model = list(family = "linear", slope = list(value = 0.5, basis = "assumed"), betweenPersonSd = list(value = 0.2, basis = "assumed")), baseline = list(mean = list(value = 20, basis = "assumed"), sd = list(value = 4, basis = "assumed")),
                     residualSd = list(value = 2, basis = "assumed"), treatment = list(slowing = list(value = 0.2, basis = "assumed")), analysis = list(kind = "mmrm"))
  got <- c(no_half_life = code(no_half_life), bad_share = code(bad_share), distributed = code(distributed), old_family = code(old_family))
  list(pass = grepl("washoutHalfLifeWeeks", got[["no_half_life"]], fixed = TRUE) && !is.na(got[["bad_share"]]) && grepl("scenario.treatment", got[["distributed"]], fixed = TRUE) && !is.na(got[["old_family"]]),
       detail = sprintf("refused by name: a stop with no fade-out time (%s), a share of 1.2 (%s), an effect stated as a distribution (%s), an MMRM for a linear-family scenario (%s)", got[["no_half_life"]], got[["bad_share"]], got[["distributed"]], got[["old_family"]]))
})

vcr_case("N111l", c("AC-04", "AC-27", "AC-28"), function() {
  # review S6: the factored fast path inside power loops. Four visits, monotone MCAR dropout of 10% per visit, no effect, 30 per arm.
  S <- matrix(c(25, 12, 10, 8, 12, 36, 20, 15, 10, 20, 49, 30, 8, 15, 30, 64), 4L); J <- 4L; L <- t(chol(S))
  data_at <- function(n) {
    arm <- rep(0:1, each = n); base <- stats::rnorm(2 * n, 25, 6)
    chg <- matrix(0.1 * (base - 25), 2 * n, J) + t(L %*% matrix(stats::rnorm(J * 2 * n), J, 2 * n))
    last <- pmin(J, stats::rgeom(2 * n, 0.1) + 1L)
    list(chg = chg, mask = outer(seq_len(2 * n), seq_len(J), function(i, j) j <= last[i]), arm = arm, base = base, n = 2 * n, J = J)
  }
  set.seed(11101L)
  nsim <- 25000L; rej <- 0L; tot <- 0L
  for (s in seq_len(nsim)) {
    d <- data_at(30L); f <- vcr_mmrm_fit(d$chg, d$mask, d$arm, d$base, "factored")
    if (is.null(f)) next
    tot <- tot + 1L; if (abs(f$effect[J] / f$se[J]) > stats::qt(0.975, f$df)) rej <- rej + 1L
  }
  tie <- rej / tot; mcse <- sqrt(0.05 * 0.95 / tot)
  # the same data through mmrm (REML, Kenward-Roger): the standard error of the last visit's arm effect
  ratio <- numeric(0)
  for (s in seq_len(120L)) {
    d <- data_at(30L); f <- vcr_mmrm_fit(d$chg, d$mask, d$arm, d$base, "factored")
    kr <- tryCatch(mmrm::mmrm(chg ~ 0 + visit + visit:arm + visit:base + us(visit | id), data = .n111_long(d), reml = TRUE, method = "Kenward-Roger"), error = function(e) NULL)
    if (is.null(f) || is.null(kr)) next
    ratio <- c(ratio, f$se[J] / summary(kr)$coef[paste0("visit", J, ":arm"), "Std. Error"])
  }
  # the old maximum-likelihood standard error and df, read from the same fit, for the record of what changed
  list(pass = tie <= 0.05 + 0.0045 && tie >= 0.05 - 0.0045 && length(ratio) >= 100L && mean(ratio) >= 0.97 && mean(ratio) <= 1.06,
       detail = sprintf("no effect, 30 per arm, four visits, 10%% dropout per visit: the type I error %.4f (MCSE %.4f) over %d fits, held to 0.05 +/- 0.0045 (the maximum-likelihood variance with the conditional df gave 0.054 to 0.059); the standard error against mmrm REML Kenward-Roger on %d datasets: mean ratio %.3f (range %.3f to %.3f)",
                        tie, mcse, tot, length(ratio), mean(ratio), min(ratio), max(ratio)))
})

vcr_case("N111m", c("AC-04", "AC-27", "AC-28"), function() {
  # review S7: in the engine's default mode (a new study per trial) the effect differs between studies, so bias and coverage are read against each
  # trial's OWN true value. An aligned estimator (everything collected, everyone followed, the MMRM, treatment-policy truth) covers within its own error
  # in every mode; against the typical study's value it read 0.923 to 0.927 where the typical-study mode reads 0.944.
  one <- function(unc, seed) {
    s <- .n111_sc(kind = "mmrm", data = "all_observed", retrieved = 1); s$model$uncertainty <- unc; s$treatment$diseaseModifying <- list(fraction = .n111_P(0.3)); s$estimand <- list(strategy = "treatment_policy")
    .n111_row(.n111_run(s, seed, cores = 2L, replicates = 3000L), "treatment_policy")
  }
  typ <- one("typical_study", 11091L); new <- one("new_study", 11092L); post <- one("posterior_draws", 11093L)
  ok <- function(r) abs(r$cover - 0.95) <= 4 * r$cover_se + 0.005 && abs(r$bias) <= 4 * r$mcse + 0.03
  fmt <- function(r) sprintf("bias %.3f (MCSE %.3f), coverage %.3f (MCSE %.3f)", r$bias, r$mcse, r$cover, r$cover_se)
  list(pass = ok(typ) && ok(new) && ok(post),
       detail = sprintf("MMRM on everything collected, 150 per arm, 3,000 trials, against each trial's own treatment-policy truth: typical study %s; new study %s; posterior draws %s (against the typical study's value the last two were 0.927 and 0.923)", fmt(typ), fmt(new), fmt(post)))
})
