# C2-08 - C2-14 — the model side: applicability, the twin label, variability
# versus uncertainty, virtual-population selection, calibration, leakage and
# the model card.

.c2_card <- function(...) utils::modifyList(list(
  id = "mdl_reference_tte", provider = "EviMed", version = "1.0.0",
  modelKind = "mathematical_simulation", contextOfUse = "design support for a two-arm trial",
  population = "adults 18-90 with stage III disease", treatment = "any", endpoint = "overall survival",
  timeHorizon = "36 months",
  inputRanges = list(age = c(18, 90), egfr = c(15, 140)),
  requiredFields = c("age", "egfr"),
  trainingDataHash = strrep("a", 64), validationDataHash = strrep("b", 64),
  validationTable = list(calibrationInTheLarge = 0.01, slope = 0.98, ici = 0.02, coverage = 0.94),
  uncertaintyMethod = "parametric_bootstrap", outOfDistributionBehaviour = "refuse",
  modelRisk = "low", modelTier = "literature",
  twinEvidence = c("individual_conditioned", "calibrated_uncertainty")), list(...))

vcr_case("C2-08", c("AC-13"), function() {
  card <- .c2_card()
  predictor <- function(inputs) rep(0.5, length(inputs$age))
  ok_in <- vcr_model_predict(card, list(age = c(40, 55), egfr = c(60, 90)), predictor)
  out_of_range <- vcr_model_predict(card, list(age = c(40, 95), egfr = c(60, 90)), predictor)
  missing_field <- vcr_model_predict(card, list(age = c(40, 55)), predictor)
  codes <- c(vapply(out_of_range$issues, function(i) i$code, character(1)),
             vapply(missing_field$issues, function(i) i$code, character(1)))
  ok <- ok_in$applicable && !is.null(ok_in$prediction) &&
    !out_of_range$applicable && is.null(out_of_range$prediction) &&
    !missing_field$applicable && is.null(missing_field$prediction) &&
    identical(sort(unique(codes)), sort(c("input_out_of_range", "required_field_missing")))
  list(pass = ok,
       detail = sprintf("in range -> prediction produced; age 95 outside [18,90] -> %s, prediction NULL; egfr omitted -> %s, prediction NULL",
                        out_of_range$issues[[1]]$code, missing_field$issues[[1]]$code))
})

vcr_case("C2-09", c("AC-33"), function() {
  full <- c("individual_conditioned", "updates_with_new_data", "calibrated_uncertainty", "validation_record")
  labels <- vapply(list(full, full[-2], full[-4], character(0)), vcr_twin_label, character(1))
  # The domain derives the same label from the same evidence.
  domain_agrees <- TRUE
  if (nzchar(Sys.which("node"))) {
    src <- file.path(VCR_ROOT, "..", "..", "OpenScience", "packages", "domain", "src", "vcrVocabulary.mjs")
    if (file.exists(src)) {
      script <- sprintf("import('%s').then(m=>console.log([%s].map(e=>m.twinLabel(e)).join(',')))",
                        normalizePath(src),
                        paste(vapply(list(full, full[-2], full[-4], character(0)), function(e)
                          sprintf("[%s]", paste(sprintf("'%s'", e), collapse = ",")), character(1)), collapse = ","))
      out <- suppressWarnings(system2("node", c("--input-type=module", "-e", shQuote(script)), stdout = TRUE, stderr = FALSE))
      domain_agrees <- identical(strsplit(paste(out, collapse = ""), ",")[[1]], labels)
    }
  }
  card <- .c2_card(twinEvidence = full, label = "digital_twin")
  issues_ok <- length(vcr_model_card_issues(card)) == 0L
  ok <- identical(labels, c("digital_twin", "baseline_conditioned_prediction",
                            "baseline_conditioned_prediction", "baseline_conditioned_prediction")) &&
    domain_agrees && issues_ok
  list(pass = ok,
       detail = sprintf("all four -> %s; missing updates_with_new_data -> %s; missing validation_record -> %s; none -> %s; domain twinLabel agrees: %s",
                        labels[1], labels[2], labels[3], labels[4], domain_agrees))
})

vcr_case("C2-10", c("AC-33"), function() {
  # A toy one-compartment PK model. Parameter uncertainty (the interval of the
  # interval) and between-subject variability (Omega) are stored apart, so
  # switching Omega off must collapse the between-subject spread and leave the
  # parameter-uncertainty interval exactly where it was.
  suppressMessages(library(deSolve))
  dose <- 100; cl_typ <- 5; v_typ <- 50
  # Verify the ODE solver against the closed form once, so the analytic form
  # can carry the population loop.
  ode <- function(t, y, p) list(c(-p$cl / p$v * y[1]))
  sol <- deSolve::ode(y = c(A = dose), times = c(0, 2, 6, 12, 24), func = ode,
                      parms = list(cl = cl_typ, v = v_typ), rtol = 1e-12, atol = 1e-12)
  closed <- dose * exp(-cl_typ / v_typ * sol[, "time"])
  ode_ok <- max(abs(sol[, "A"] - closed)) < 1e-6
  auc <- function(cl) dose / cl
  draw <- function(omega_sd, n_subject = 500L, n_param = 400L) {
    per_param <- vapply(seq_len(n_param), function(k) {
      cl_k <- cl_typ * exp(stats::rnorm(1, 0, 0.15))          # parameter uncertainty
      # Scale a standard normal rather than passing sd = 0: R's `rnorm` returns
      # the mean *without consuming a uniform* when sd is exactly 0, so
      # "switch Omega off" would otherwise reshuffle every later draw and the
      # two runs would not be comparable at all -- which looks exactly like the
      # uncertainty interval having changed.
      subj <- cl_k * exp(stats::rnorm(n_subject, 0, 1) * omega_sd) # between-subject
      c(typical = auc(cl_k), spread = stats::sd(auc(subj)))
    }, numeric(2))
    list(typicalInterval = stats::quantile(per_param["typical", ], c(0.025, 0.975), names = FALSE),
         betweenSubjectSpread = mean(per_param["spread", ]))
  }
  set.seed(1010L, kind = VCR_RNG_KIND)
  with_omega <- draw(0.3)
  set.seed(1010L, kind = VCR_RNG_KIND)
  without <- draw(0)
  width <- function(x) diff(x$typicalInterval)
  collapsed <- without$betweenSubjectSpread == 0 && with_omega$betweenSubjectSpread > 1
  preserved <- abs(width(with_omega) - width(without)) < 1e-9
  spec_issues <- vcr_mechanistic_spec_issues(list(
    modelKind = "mechanistic-ode", engine = "desolve", engineVersion = "1.40", modelHash = strrep("c", 64),
    parameters = list(cl = 5), parameterUncertainty = list(sd = 0.15), betweenSubject = list(sd = 0.3),
    residual = list(sd = 0.1), covariatePopulation = list(kind = "scenario"),
    events = list(dose = 100), outputs = c("auc"), vpopSelection = "allen_2016",
    validation = list(vpc = TRUE)))
  list(pass = ode_ok && collapsed && preserved && length(spec_issues) == 0L,
       detail = sprintf("ODE vs closed form max|d| %.2e; Omega on: between-subject sd %.4f, uncertainty interval width %.4f; Omega off: between-subject sd %.4f, width %.4f (unchanged: %s); mechanistic spec issues %d",
                        max(abs(sol[, "A"] - closed)), with_omega$betweenSubjectSpread, width(with_omega),
                        without$betweenSubjectSpread, width(without), preserved, length(spec_issues)))
})

vcr_case("C2-11", c("AC-13"), function() {
  # Allen (2016): plausible patients drawn from a wide parameter prior, then
  # accepted so the selected-on output matches the observed clinical
  # distribution. KS distance to the target below 0.05, acceptance rate stored.
  set.seed(1111L, kind = VCR_RNG_KIND)
  dose <- 100
  cl <- 5 * exp(stats::rnorm(30000L, 0, 0.55))    # plausible patients: wide
  out <- dose / cl                                # AUC
  target_mean <- 21; target_sd <- 4
  sel <- vcr_vpop_select(out, target_mean, target_sd)
  accepted <- out[sel$accepted]
  d <- vcr_ks_to_normal(accepted, target_mean, target_sd)
  d_before <- vcr_ks_to_normal(out, target_mean, target_sd)
  ok <- d < 0.05 && d_before > 0.05 && sel$acceptanceRate > 0 && sel$acceptanceRate < 1
  list(pass = ok,
       detail = sprintf("KS to target: plausible %.4f -> selected %.4f (tol 0.05); acceptance rate %.4f recorded; %d of %d accepted",
                        d_before, d, sel$acceptanceRate, sum(sel$accepted), length(out)))
})

vcr_case("C2-12", c("AC-23"), function() {
  # A known simulator is the truth. A model with a +10% systematic bias must
  # be caught by calibration-in-the-large and by interval coverage; the
  # correct model's coverage must sit inside the binomial 99% interval for the
  # nominal 0.95.
  set.seed(1212L, kind = VCR_RNG_KIND)
  n <- 4000L
  x <- stats::rnorm(n, 60, 10)
  mu <- 10 + 0.5 * x
  sigma <- 4
  y <- stats::rnorm(n, mu, sigma)
  correct <- vcr_calibration(y, mu)
  biased <- vcr_calibration(y, 1.1 * mu)
  cov_correct <- vcr_interval_coverage(y, mu - 1.96 * sigma, mu + 1.96 * sigma, 0.95)
  cov_biased <- vcr_interval_coverage(y, 1.1 * mu - 1.96 * sigma, 1.1 * mu + 1.96 * sigma, 0.95)
  crps_correct <- vcr_crps_normal(y, mu, sigma)
  crps_biased <- vcr_crps_normal(y, 1.1 * mu, sigma)
  se_itl <- sigma / sqrt(n)
  caught <- abs(biased$inTheLarge) > 3 * se_itl && !cov_biased$withinBinomialInterval &&
    crps_biased > crps_correct
  clean <- abs(correct$inTheLarge) <= 3 * se_itl && cov_correct$withinBinomialInterval
  list(pass = caught && clean,
       detail = sprintf("correct model: in-the-large %+.4f (%.2f SE), slope %.4f, ICI %.4f, coverage %.4f in [%.4f, %.4f] (nominal .95 inside: %s), CRPS %.4f; +10%% biased: in-the-large %+.4f (%.1f SE), slope %.4f, coverage %.4f (nominal inside: %s), CRPS %.4f",
                        correct$inTheLarge, abs(correct$inTheLarge) / se_itl, correct$slope,
                        correct$integratedCalibrationIndex, cov_correct$coverage,
                        cov_correct$binomialInterval[1], cov_correct$binomialInterval[2],
                        cov_correct$withinBinomialInterval, crps_correct,
                        biased$inTheLarge, abs(biased$inTheLarge) / se_itl, biased$slope,
                        cov_biased$coverage, cov_biased$withinBinomialInterval, crps_biased))
})

vcr_case("C2-13", c("AC-15"), function() {
  # Leakage travels on `visible_at`, not `occurred_at`. A laboratory value
  # that happened before the cut-off but was recorded after it was not
  # available to a decision made at the cut-off.
  cutoff <- as.Date("2026-06-30")
  facts <- data.frame(
    feature = c("ldh", "ecog", "biopsy_grade", "post_hoc_label", "creatinine"),
    occurred_at = as.Date(c("2026-05-01", "2026-06-10", "2026-04-20", "2026-07-20", "2026-06-29")),
    recorded_at = as.Date(c("2026-05-02", "2026-06-11", "2026-07-15", "2026-08-01", "2026-06-30")),
    visible_at = as.Date(c("2026-05-02", "2026-06-11", "2026-07-15", "2026-08-01", "2026-06-30")),
    stringsAsFactors = FALSE)
  naive <- vcr_temporal_leakage(facts, cutoff, used = facts$feature)
  # biopsy_grade *occurred* before the cut-off, so an occurred_at filter keeps it.
  occurred_filter <- facts$feature[facts$occurred_at <= cutoff]
  filtered_by_occurred <- vcr_temporal_leakage(facts, cutoff, used = occurred_filter)
  correct_filter <- facts$feature[facts$visible_at <= cutoff]
  clean <- vcr_temporal_leakage(facts, cutoff, used = correct_filter)
  ok <- naive$count == 2L && filtered_by_occurred$count == 1L &&
    identical(filtered_by_occurred$leaked$feature, "biopsy_grade") && clean$clean
  list(pass = ok,
       detail = sprintf("all features: %d leaked (%s); filtering on occurred_at still leaks %d (%s -- happened %s, visible %s); filtering on visible_at leaks %d",
                        naive$count, paste(naive$leaked$feature, collapse = ","),
                        filtered_by_occurred$count, paste(filtered_by_occurred$leaked$feature, collapse = ","),
                        filtered_by_occurred$leaked$occurred_at[1], filtered_by_occurred$leaked$visible_at[1],
                        clean$count))
})

vcr_case("C2-14", c("AC-33"), function() {
  complete <- .c2_card()
  no_cou <- .c2_card(contextOfUse = NULL)
  no_hash <- .c2_card(validationDataHash = NULL)
  bad_risk <- .c2_card(modelRisk = "extreme")
  mislabelled <- .c2_card(twinEvidence = c("individual_conditioned", "updates_with_new_data",
                                           "calibrated_uncertainty", "validation_record"),
                          label = "baseline_conditioned_prediction")
  fields <- function(card) vapply(vcr_model_card_issues(card), function(i) i$field, character(1))
  ok <- length(vcr_model_card_issues(complete)) == 0L &&
    identical(fields(no_cou), "contextOfUse") &&
    identical(fields(no_hash), "validationDataHash") &&
    "modelRisk" %in% fields(bad_risk) &&
    "label" %in% fields(mislabelled)
  list(pass = ok,
       detail = sprintf("complete card: %d issues; missing contextOfUse -> [%s]; missing validationDataHash -> [%s]; modelRisk='extreme' -> [%s]; evidence says twin but label says otherwise -> [%s]",
                        length(vcr_model_card_issues(complete)), paste(fields(no_cou), collapse = ","),
                        paste(fields(no_hash), collapse = ","), paste(fields(bad_risk), collapse = ","),
                        paste(fields(mislabelled), collapse = ",")))
})
