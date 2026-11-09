# N103 — one executable set of patients for the beta_logit family of patients.progression 1.2.0 (plan R23, 2026-11-09)
#
# The record of virtual people (`instantiate`), the people table a run reads, and the two modes that answer different questions. Every number a case holds
# a method to comes from something outside the method's own code: a closed form written here from the table's own columns and the parameter file's
# published numbers (the Bateman placebo's area, adsim's gLogitDelta, the beta's mean and variance), a count made from the table by hand, a nominal
# error rate of a test that is exact under its null. Sources of the model itself are N101's.
#
#   a  instantiate: the same seed gives the same table, to the byte, and another seed another one; the covariates are the model's (MMSE uniform over its
#      range, the Table 7 genotype shares), the table names the parameter file it was made for
#   b  the same people in every arm: a record and a seed give identical people, dropout times and baseline scores whatever the arm's drug is
#   c  the paired mode on a known truth: the mean expected contrast equals the closed form from the table to rounding, the scored contrast is within its
#      Monte Carlo error of it, and no residual is left in the expected one
#   d  the paired contrast's Monte Carlo error is smaller than the unpaired one's on the same people, and the unpaired one equals its closed form
#   e  covariates outside the fitted range are premises with their count, a covariate that cannot describe a person is refused with its count
#   f  trials drawn from the record: the null's type I error is the test's nominal level
#   g  instantiate from a generated population table: the covariates it names are that table's, byte for byte; a table of real people is refused
#   h  what is refused or said, by name: a record made for another parameter file, a population beside a people table, a stated study uncertainty, an
#      older method label, a record not made by this method

.n103_P <- function(v, basis = "assumed") list(value = v, basis = basis)
.n103_base <- function(extra = list()) utils::modifyList(list(timeUnit = "weeks", model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"))), extra)
.n103_sym <- function(pts = -2.5) list(symptomatic = list(pointsAt = .n103_P(pts), atWeek = 26, referenceAdas = 25, et50Weeks = .n103_P(8)))
.n103_instantiate <- function(n, seed, population = NULL, covariates = NULL, inputs = list(), label = NULL, uncertainty = NULL) {
  inst <- list(); if (!is.null(n)) inst$n <- as.integer(n); if (!is.null(covariates)) inst$covariates <- covariates
  sc <- .n103_base(list(instantiate = inst)); if (!is.null(population)) sc$population <- population
  if (!is.null(uncertainty)) sc$model$uncertainty <- uncertainty
  out <- tempfile("n103out"); dir.create(out)
  r <- vcr_test_run(vcr_test_job("patients.progression", sc, seed = seed, inputs = inputs, extra = if (is.null(label)) list() else list(methodVersion = label)), output_dir = out)
  list(result = r, dir = out, table = vcr_test_table(r, "progression-people", out))
}
.n103_input <- function(inst, id) vcr_test_chain_input(inst$result, "progression-people", inst$dir, id, shape = "subject")
.n103_run <- function(mode, input, treatment = list(), n = 60L, seed = 1L, replicates = NULL, extra = list(), visits = c(0, 13, 26, 52, 78)) {
  sc <- .n103_base(c(list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), visits = visits,
                          people = list(inputId = input$id, mode = mode)), if (length(treatment)) list(treatment = treatment), extra))
  if (identical(mode, "paired_counterfactual")) sc$design <- NULL
  vcr_test_run(vcr_test_job("patients.progression", sc, inputs = list(input), seed = seed, replicates = replicates))
}
.n103_issue <- function(r) { i <- c(r$diagnostics$issues %||% list(), r$issues %||% list(), r$diagnostics$resultValidationIssues %||% list()); if (length(i)) sprintf("%s@%s", i[[1]]$code, i[[1]]$field) else NA_character_ }
.n103_measure <- function(r, name) Filter(function(m) identical(m$name, name), r$measures)[[1]]
#' The internal run state of a people table, as the handler builds it: the parts a case drives without a dispatched job.
.n103_state <- function(input, treatment, n = 60L, coupling = "common", dropout = "parameter_set", placebo = TRUE) {
  set <- vcr_beta_logit_parameter_set("camd-adas-cog-11", "adsim-3.0")
  job <- list(inputs = list(input))
  rec <- .vcr_bl_read_record(job, input$id, set)
  par <- vcr_beta_logit_par(set$medians, list())
  list(set = set, p = list(par = par, population = list(), uncertainty = "typical_study", visits = c(0, 13, 26, 52, 78), at = 5L, n1 = n, n0 = n, alpha = 0.05, is_null = FALSE,
                           analysis = "change", treatment = treatment, placebo = placebo, dropout = dropout, record = rec, coupling = coupling, effects = NULL,
                           treatmentScenario = NULL, mode = "resampled_trials"))
}
#' The expected score at week `t` of every person of a table, by the closed forms of the model written out here (the Bateman placebo from the area it
#' integrates to, the Emax from adsim's gLogitDelta), for a treated person when `emax` is not NULL.
.n103_expected <- function(tab, set, t, treated = FALSE, pts = -2.5, at = 26, ref = 25, et50 = 8, placebo = TRUE) {
  m <- set$medians; kel <- m[["kel"]]; keq <- kel + m[["keqMinusKel"]]
  beta <- -m[["aucPlacebo"]] / (1 / kel - 1 / keq)
  pbo <- if (placebo) beta * (exp(-kel * t) - exp(-keq * t)) else 0
  emax <- (qlogis((ref + pts) / 70) - qlogis(ref / 70)) * (at + et50) / at
  x <- tab$ETA + tab$ALPHA * t + pbo + if (treated) emax * t / (et50 + t) else 0
  g <- 1e-5
  list(theta = plogis(x), mean = 70 * (plogis(x) + g) / (1 + 2 * g))
}

vcr_case("N103a", c("AC-04", "AC-28"), function() {
  a <- .n103_instantiate(400L, 10301L); a2 <- .n103_instantiate(400L, 10301L); b <- .n103_instantiate(400L, 10302L)
  tab <- a$table; set <- .n101_set()
  same <- identical(a$result$tables[[1]]$sha256, a2$result$tables[[1]]$sha256) && identical(tab, a2$table)
  other <- !identical(a$result$tables[[1]]$sha256, b$result$tables[[1]]$sha256)
  cols <- identical(names(tab), c("USUBJID", "MMSE", "AGE", "APOE4", "FEMALE", "ETA", "ALPHA", "MEANSLOPE", "TAU", "OMEGA", "PARAMSET_SHA256"))
  # the model's covariate model at the medians, over 20,000 people (a larger record of the same seed-free kind): MMSE uniform 16-26 (mean 21, SD 10/sqrt(12)),
  # the genotype shares of EMA Table 7 (0.42/0.44/0.14, to its rounding), and the table names the file it was made for
  big <- .n103_instantiate(20000L, 10303L, uncertainty = "typical_study")$table
  n <- nrow(big)
  mm_ok <- abs(mean(big$MMSE) - 21) <= 4 * (10 / sqrt(12)) / sqrt(n) && min(big$MMSE) >= 16 && max(big$MMSE) <= 26
  share <- tabulate(big$APOE4 + 1L, 3L) / n
  apoe_ok <- all(abs(share - c(0.42, 0.44, 0.14)) <= 0.005 + 4 * sqrt(c(0.42, 0.44, 0.14) * c(0.58, 0.56, 0.86) / n))
  # the typical study's intercept: eta ~ N(nuEta + lambda (MMSE - 21), phiEta), checked on its mean at MMSE 21 +/- 0.5
  par <- vcr_beta_logit_par(set$medians); near <- big$MMSE > 20.5 & big$MMSE < 21.5
  eta_ok <- abs(mean(big$ETA[near]) - par$nuEta) <= 4 * par$phiEta / sqrt(sum(near)) + 0.01
  file_ok <- all(tab$PARAMSET_SHA256 == set$fileSha256) && length(unique(tab$TAU)) == 1L && length(unique(tab$OMEGA)) == 1L
  ok <- identical(a$result$status, "succeeded") && same && other && cols && mm_ok && apoe_ok && eta_ok && file_ok && nrow(tab) == 400L
  list(pass = ok, detail = sprintf("instantiate n = 400: same seed, same table (sha256 %s), another seed another one; 20,000 people of the typical study: mean MMSE %.3f (21), ApoE4 shares %.4f/%.4f/%.4f (EMA Table 7 0.42/0.44/0.14), mean intercept at MMSE 21 %.4f (model %.4f); every row names parameter file %s",
                                   substr(a$result$tables[[1]]$sha256, 1, 10), mean(big$MMSE), share[1], share[2], share[3], mean(big$ETA[near]), par$nuEta, substr(set$fileSha256, 1, 10)))
})

vcr_case("N103b", c("AC-04", "AC-28"), function() {
  inst <- .n103_instantiate(300L, 10311L); input <- .n103_input(inst, "res_n103b:progression-people")
  arm <- function(treatment) {
    st <- .n103_state(input, treatment)
    vcr_with_stream(parallel::nextRNGStream(vcr_stream_bank(10312L)$state()), function(i) .vcr_bl_people(st$set, st$p), 1L)
  }
  # an effect stated at its central value is the arm's drug; the people must not depend on it
  null_arm <- arm(.vcr_bl_treatment(list(), 78)); sym_arm <- arm(.vcr_bl_treatment(.n103_sym(-4), 78))
  dm_arm <- arm(.vcr_bl_treatment(list(diseaseModifying = list(fraction = .n103_P(0.4))), 78))
  fields <- c("y0", "leaves", "mmse", "age", "apoe", "female", "eta", "alpha", "meanSlope", "treated")
  same <- vapply(list(sym_arm, dm_arm), function(x) all(vapply(fields, function(f) identical(x[[f]], null_arm[[f]]), logical(1))), logical(1))
  # the drug acts on the treated arm and nobody else: the control's score at the analysis visit is the same draw in every arm, the treated one is not
  control_same <- identical(sym_arm$ya[sym_arm$treated == 0], null_arm$ya[null_arm$treated == 0]) && !identical(sym_arm$ya[sym_arm$treated == 1], null_arm$ya[null_arm$treated == 1])
  # dispatched: two arms of one comparison at one seed observe the same number of people at every visit (both are alternatives, so both run the same trials)
  r0 <- .n103_run("resampled_trials", input, .n103_sym(-2), seed = 10313L, n = 40L, replicates = 3000L)
  r1 <- .n103_run("resampled_trials", input, .n103_sym(-4), seed = 10313L, n = 40L, replicates = 3000L)
  obs <- function(r) unlist(lapply(r$diagnostics$progression$observed, function(o) c(o$control$value, o$treated$value)))
  dispatched <- identical(r0$status, "succeeded") && identical(r1$status, "succeeded") && identical(obs(r0), obs(r1)) && length(obs(r0)) == 10L
  list(pass = all(same) && control_same && dispatched,
       detail = sprintf("one record (300 people) and one stream, three arms (no drug, 4 points symptomatic, 40%% disease-modifying): covariates, intercepts, slopes, dropout times, baseline scores and the arm assignment identical to the bit (%s); the control arm's analysis-visit score identical, the treated arm's not (%s); two dispatched arms at one seed: the observed people at all 5 visits equal (%s)",
                        paste(same, collapse = "/"), control_same, dispatched))
})

vcr_case("N103c", c("AC-04", "AC-28"), function() {
  inst <- .n103_instantiate(400L, 10321L); input <- .n103_input(inst, "res_n103c:progression-people"); tab <- inst$table; set <- .n101_set()
  r <- .n103_run("paired_counterfactual", input, .n103_sym(-2.5), seed = 10322L, replicates = 300L, extra = list(dropoutModel = "none"))
  # the closed form, from the table's columns: the expected score of each person at week 78 (the analysis visit is the last), treated less control
  ctl <- .n103_expected(tab, set, 78, FALSE); trt <- .n103_expected(tab, set, 78, TRUE)
  truth <- mean(trt$mean - ctl$mean); truth_sd <- stats::sd(trt$mean - ctl$mean)
  lat <- .n103_measure(r, "paired_latent_mean_contrast"); scored <- .n103_measure(r, "paired_mean_contrast"); sd <- .n103_measure(r, "paired_latent_sd")
  share <- .n103_measure(r, "paired_share_improved"); obs <- .n103_measure(r, "paired_observed_share")
  # the expected contrast has no residual: it is the closed form to rounding, in every replicate (zero Monte Carlo error)
  exact <- abs(lat$value - truth) < 1e-9 && lat$mcse < 1e-9 && abs(sd$value - truth_sd) < 1e-9
  within <- abs(scored$value - truth) <= 4 * scored$mcse + 1e-9
  # the calculated curves are the same closed form: the control and treated mean change at week 78 differ by the same number among everyone (no dropout)
  cur <- r$diagnostics$progression$curves[[5]]
  curve_ok <- abs((cur$treated$mean$value - cur$control$mean$value) - truth) < 1e-9
  list(pass = identical(r$status, "succeeded") && exact && within && curve_ok && abs(obs$value - 1) < 1e-12 && share$value >= 0 && share$value <= 1,
       detail = sprintf("400 people, 2.5 points symptomatic at week 26 (ET50 8 weeks), no dropout, 300 replicates: the expected mean contrast %.9f (closed form from the table %.9f), its SD across people %.6f (%.6f); the scored contrast %.4f (MCSE %.4f) is within 4 MCSE of it; the calculated curves differ by %.9f; the share improved %.3f",
                        lat$value, truth, sd$value, truth_sd, scored$value, scored$mcse, cur$treated$mean$value - cur$control$mean$value, share$value))
})

vcr_case("N103d", c("AC-04", "AC-28"), function() {
  inst <- .n103_instantiate(400L, 10331L); input <- .n103_input(inst, "res_n103d:progression-people"); tab <- inst$table
  tr <- .vcr_bl_treatment(.n103_sym(-2.5), 78)
  spread <- function(coupling) {
    st <- .n103_state(input, tr, coupling = coupling, dropout = "none")
    run <- .vcr_bl_paired_run(st$set, st$p, 300L, 10332L, 1L)
    x <- run$values[, "scored_mean"]
    c(mean = mean(x), sd = stats::sd(x))
  }
  common <- spread("common"); independent <- spread("independent")
  # the unpaired reference in closed form: the mean of the scored contrast of N people whose two scores are independent has the variance sum(v_c + v_t) / N^2
  set <- .n101_set(); par <- vcr_beta_logit_par(set$medians); tau <- tab$TAU[1]
  ctl <- .n103_expected(tab, set, 78, FALSE); trt <- .n103_expected(tab, set, 78, TRUE)
  v <- function(theta) vcr_beta_logit_score_moments(theta, tau)$var
  closed <- sqrt(sum(v(ctl$theta) + v(trt$theta))) / nrow(tab)
  truth <- mean(trt$mean - ctl$mean)
  # 300 replicates determine an SD to about 4%: the closed form is held to 20%
  closed_ok <- abs(independent[["sd"]] / closed - 1) <= 0.2
  smaller <- common[["sd"]] < independent[["sd"]]
  centred <- abs(common[["mean"]] - truth) <= 4 * common[["sd"]] / sqrt(300) + 1e-6 && abs(independent[["mean"]] - truth) <= 4 * independent[["sd"]] / sqrt(300) + 1e-6
  list(pass = smaller && closed_ok && centred,
       detail = sprintf("the same 400 people, 300 replicates, no dropout: the Monte Carlo SD of the mean contrast is %.5f with common random numbers and %.5f with independent ones (ratio %.2f; the unpaired closed form %.5f); both are centred on the true mean contrast %.4f (%.4f, %.4f)",
                        common[["sd"]], independent[["sd"]], common[["sd"]] / independent[["sd"]], closed, truth, common[["mean"]], independent[["mean"]]))
})

vcr_case("N103e", c("AC-04", "AC-28"), function() {
  # people entered 10 to 30 on the MMSE: the ones outside the 16 to 26 the trials entered with are counted, from the table, by hand
  inst <- .n103_instantiate(500L, 10341L, population = list(mmseRange = .n103_P(c(10, 30))))
  outside <- sum(inst$table$MMSE < 16 | inst$table$MMSE > 26)
  said <- inst$result$diagnostics$progression$outsideFittedMmse
  input <- .n103_input(inst, "res_n103e:progression-people")
  r <- .n103_run("paired_counterfactual", input, .n103_sym(-2.5), seed = 10342L, replicates = 100L)
  limits <- unlist(r$diagnostics$progression$limits)
  premise <- any(grepl(sprintf("%d of 500 people have a baseline MMSE outside 16 to 26", outside), limits, fixed = TRUE))
  r2 <- .n103_run("resampled_trials", input, .n103_sym(-2.5), seed = 10342L, replicates = 300L, n = 30L)
  premise2 <- any(grepl(sprintf("%d of 500 people have a baseline MMSE outside 16 to 26", outside), unlist(r2$diagnostics$progression$limits), fixed = TRUE)) &&
    identical(r2$diagnostics$progression$people$outsideFittedMmse, as.integer(outside))
  # a person no number can describe is refused with the count, not run
  refuse <- function(col, value, k) {
    t2 <- inst$table; t2[[col]][seq_len(k)] <- value
    .n103_issue(.n103_run("paired_counterfactual", vcr_test_input(t2, paste0("n103e_", col), shape = "subject", source = "synthetic"), .n103_sym(-2.5), replicates = 100L))
  }
  bad_mmse <- refuse("MMSE", 31, 7); bad_apoe <- refuse("APOE4", 3, 2)
  r_bad <- { t2 <- inst$table; t2$MMSE[1:7] <- 31; .n103_run("paired_counterfactual", vcr_test_input(t2, "n103e_msg", shape = "subject", source = "synthetic"), .n103_sym(-2.5), replicates = 100L) }
  detail_ok <- grepl("7 of 500 people have a baseline MMSE outside 0 to 30", r_bad$diagnostics$issues[[1]]$detail %||% r_bad$issues[[1]]$detail %||% "", fixed = TRUE)
  ok <- outside > 0 && identical(as.integer(outside), as.integer(said)) && premise && premise2 && identical(r$status, "succeeded") &&
    identical(bad_mmse, "input_shape_invalid@scenario.people.inputId") && identical(bad_apoe, "input_shape_invalid@scenario.people.inputId") && detail_ok
  list(pass = ok, detail = sprintf("a record of 500 people with MMSE 10-30: %d outside 16-26 counted by hand, the record says %s, and both modes carry that count in their limits; 7 people at MMSE 31 and 2 at ApoE4 3 are refused (%s, %s) with the count in the message and nothing is run",
                                   outside, said, bad_mmse, bad_apoe))
})

vcr_case("N103f", c("AC-04", "AC-28"), function() {
  # trials drawn from a record of 1,500 people, no drug: the null at the domain's floor is the test's own level
  inst <- .n103_instantiate(1500L, 10351L); input <- .n103_input(inst, "res_n103f:progression-people")
  r <- .n103_run("resampled_trials", input, list(), n = 40L, seed = 10352L, visits = c(0, 26, 52))
  t1 <- .n103_measure(r, "type_one_error")
  pg <- r$diagnostics$progression
  ok <- identical(r$status, "succeeded") && abs(t1$value - 0.05) <= 3.5 * t1$mcse && pg$trials >= 20000L && identical(pg$people$sampling, "without_replacement") && identical(pg$people$mode, "resampled_trials")
  # the same record with more people per trial than it holds: drawn with replacement, and said
  big <- .n103_run("resampled_trials", input, .n103_sym(-3), n = 1000L, seed = 10353L, replicates = 100L, visits = c(0, 26, 52))
  said <- any(grepl("drawn with replacement", unlist(big$diagnostics$progression$limits), fixed = TRUE)) && identical(big$diagnostics$progression$people$sampling, "with_replacement")
  list(pass = ok && said, detail = sprintf("40 per arm drawn without replacement from 1,500 people, no effect: type I error %.4f (MCSE %.4f) over %d trials, nominal 0.05; 1,000 per arm from the same record is drawn with replacement and the result says so (%s)",
                                           t1$value, t1$mcse, pg$trials, said))
})

vcr_case("N103g", c("AC-04", "AC-28"), function() {
  set.seed(10361)
  pop <- data.frame(Id = sprintf("S%03d", 1:250), Mmse = round(stats::runif(250, 18, 25), 1), Allele = sample(0:2, 250, TRUE, c(0.5, 0.4, 0.1)), Sex = rbinom(250, 1, 0.55))
  inp <- vcr_test_input(pop, "res_pop@1:population", source = "synthetic", kind = "snapshot_file")
  cov <- list(inputId = inp$id, columns = list(mmse = "Mmse", apoe4 = "Allele", female = "Sex"))
  a <- .n103_instantiate(NULL, 10362L, covariates = cov, inputs = list(inp)); a2 <- .n103_instantiate(NULL, 10362L, covariates = cov, inputs = list(inp))
  tab <- a$table
  verbatim <- identical(tab$MMSE, pop$Mmse) && identical(as.integer(tab$APOE4), as.integer(pop$Allele)) && identical(as.numeric(tab$FEMALE), as.numeric(pop$Sex)) && nrow(tab) == 250L
  drawn <- stats::sd(tab$AGE) > 3 && all(tab$AGE > 30 & tab$AGE < 110) && identical(a$result$tables[[1]]$sha256, a2$result$tables[[1]]$sha256) &&
    identical(as.character(unlist(a$result$diagnostics$progression$covariatesGiven)), c("mmse", "apoe", "female"))
  real <- vcr_test_input(pop, "res_real@1:population", source = "observed", kind = "snapshot_file")
  refused <- .n103_issue(.n103_instantiate(NULL, 10363L, covariates = list(inputId = real$id, columns = cov$columns), inputs = list(real))$result)
  wrong_n <- .n103_issue(.n103_instantiate(100L, 10364L, covariates = cov, inputs = list(inp))$result)
  nocol <- .n103_issue(.n103_instantiate(NULL, 10365L, covariates = list(inputId = inp$id, columns = list(mmse = "Missing")), inputs = list(inp))$result)
  list(pass = verbatim && drawn && identical(refused, "input_shape_invalid@scenario.instantiate.covariates.inputId") && identical(wrong_n, "scenario_value_invalid@scenario.instantiate.n") &&
         identical(nocol, "input_shape_invalid@scenario.instantiate.covariates.columns.mmse"),
       detail = sprintf("250 people of a generated population table: MMSE, ApoE4 and sex are the table's, byte for byte (%s); age, intercept and slope are drawn once (SD of age %.2f) and the same seed gives the same table; a table of real people is refused (%s), a wrong n (%s), a missing column (%s)",
                        verbatim, stats::sd(tab$AGE), refused, wrong_n, nocol))
})

vcr_case("N103h", c("AC-04", "AC-27"), function() {
  inst <- .n103_instantiate(200L, 10371L); input <- .n103_input(inst, "res_n103h:progression-people")
  # a record made for another parameter file runs, and says so
  tab <- inst$table; tab$PARAMSET_SHA256 <- strrep("0", 64)
  other <- .n103_run("paired_counterfactual", vcr_test_input(tab, "n103h_other", shape = "subject", source = "synthetic"), .n103_sym(-2.5), replicates = 100L)
  stale <- identical(other$status, "succeeded") && identical(other$diagnostics$progression$people$madeForCurrentModel, FALSE) &&
    any(grepl("earlier parameter file", unlist(other$diagnostics$progression$limits), fixed = TRUE))
  current <- identical(.n103_run("paired_counterfactual", input, .n103_sym(-2.5), replicates = 100L)$diagnostics$progression$people$madeForCurrentModel, TRUE)
  mk <- function(extra, mode = "resampled_trials") .n103_issue(.n103_run(mode, input, .n103_sym(-2.5), replicates = 100L, extra = extra))
  got <- c(population = mk(list(population = list(mmseRange = list(value = c(16, 26), basis = "assumed")))),
           uncertainty = .n103_issue(vcr_test_run(vcr_test_job("patients.progression", .n103_base(list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = 30L, nControl = 30L), visits = c(0, 26, 52),
                                      people = list(inputId = input$id, mode = "resampled_trials"), treatment = .n103_sym(-2.5), model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = "new_study"))), inputs = list(input), replicates = 100L))),
           posterior = .n103_issue(.n103_instantiate(100L, 1L, uncertainty = "posterior_draws")$result))
  want <- c(population = "scenario_value_invalid@scenario.population", uncertainty = "scenario_value_invalid@scenario.model.uncertainty", posterior = "scenario_value_invalid@scenario.model.uncertainty")
  labelled <- vcr_test_run(vcr_test_job("patients.progression", .n103_base(c(list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = 30L, nControl = 30L), visits = c(0, 26, 52),
                                      people = list(inputId = input$id, mode = "resampled_trials"), treatment = .n103_sym(-2.5)))), inputs = list(input), extra = list(methodVersion = "1.1.0")))
  label_issue <- .n103_issue(labelled)
  # a table of real people's rows is not a record
  real <- .n103_issue(.n103_run("resampled_trials", vcr_test_input(inst$table, "n103h_real", shape = "subject", source = "observed"), .n103_sym(-2.5), replicates = 100L))
  # a table that is not a record
  nocols <- .n103_issue(.n103_run("resampled_trials", vcr_test_input(inst$table[, 1:6], "n103h_cols", shape = "subject", source = "synthetic"), .n103_sym(-2.5), replicates = 100L))
  ok <- stale && current && identical(unname(got), unname(want)) && identical(label_issue, "method_version_mismatch@methodVersion") &&
    identical(real, "input_shape_invalid@scenario.people.inputId") && identical(nocols, "input_shape_invalid@scenario.people.inputId")
  list(pass = ok, detail = sprintf("a record made for another parameter file runs and says so (%s); a current one says it is current (%s); refused by name: %s; a people run labelled 1.1.0: %s; a table of real rows: %s; a table without the record's columns: %s",
                                   stale, current, paste(sprintf("%s -> %s", names(got), got), collapse = ", "), label_issue, real, nocols))
})
