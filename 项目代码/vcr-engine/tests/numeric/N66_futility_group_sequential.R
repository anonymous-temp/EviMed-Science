# N66 — the group-sequential design with a futility boundary (algorithm round T2, 2026-11-03): design.confirmatory,
# design.kind futility_group_sequential.
#
# rpact computes the boundaries and the operating characteristics, so the checks are not rpact:
#
#   a  gsDesign::gsDesign (test.type 3: a binding futility bound, test.type 4: a non-binding one, beta spending, the Lan-DeMets
#      O'Brien-Fleming function on both sides): the efficacy and futility boundaries and the inflation over the fixed design
#   b  the stopping probabilities and the expected size at every look, under the alternative and the null, against a simulation of the
#      standardized test statistic in plain R at the boundaries the job returned (a known-truth check of everything the table says)
#   c  the efficacy boundaries of the other spending functions against the engine's own recursion (O'Brien-Fleming, Pocock) and against
#      gsDesign's (Hwang-Shih-DeCani and Kim-DeMets with their gamma); a non-binding futility boundary leaves them unchanged
#   d  the fixed-design size beside it is the engine's closed form, and an event-time design carries events and, with an accrual,
#      the patients that many events take
#   h  ONE table of signs for the five kinds of design.confirmatory (2026-11-04): a mean or a risk difference is read through
#      `hypothesis.direction`, a hazard ratio and a rate ratio are a benefit below 1; the effect a size is planned for must be a benefit
#      (`effect_against_direction` otherwise, for every kind that plans one), the effects of a selection or an enrichment scenario may be harm;
#      the simulated kinds read the direction the same way (a lower-is-better problem is the higher-is-better one with the sign turned,
#      bit for bit for a mean, and the complementary rates for a risk, within the error)
#   i  an event-time design is not refused for a reason the person has no setting for: HR 0.82 to 0.9 were `design_not_computable` because
#      rpact was handed a fixed cap of 1,000 subjects; the events are Schoenfeld's times the inflation of gsDesign's design, the same for
#      the group-sequential and the re-estimation kinds

.n66_job <- function(design, endpoint = "continuous", truth = list(plannedEffect = 0.5, sd = 1), id = "job_n66", extra = list()) {
  sc <- c(list(design = design, endpoint = list(type = endpoint), truth = truth, analysis = list(alpha = 0.025, power = 0.9)), extra)
  vcr_test_run(vcr_test_job("design.confirmatory", vcr_test_conf_scenario(sc), job_id = id))
}
.n66_looks <- function(r) r$diagnostics$confirmatory$looks
.n66_vec <- function(looks, field) vapply(looks, function(l) if (is.null(l[[field]])) NA_real_ else as.numeric(l[[field]]), numeric(1))

vcr_case("N66a", c("AC-30", "AC-29"), function() {
  if (!requireNamespace("gsDesign", quietly = TRUE)) stop("N66 requires the locked gsDesign library")
  timing <- c(1 / 3, 2 / 3, 1)
  worst <- 0; text <- character()
  for (binding in c(TRUE, FALSE)) {
    r <- .n66_job(list(kind = "futility_group_sequential", informationRates = timing, spending = "obrien_fleming",
                       futility = list(spending = "obrien_fleming", binding = binding)), id = "job_n66a")
    ref <- gsDesign::gsDesign(k = 3, test.type = if (binding) 3 else 4, alpha = 0.025, beta = 0.1, timing = timing, sfu = gsDesign::sfLDOF, sfl = gsDesign::sfLDOF, n.fix = 1)
    looks <- .n66_looks(r)
    up <- .n66_vec(looks, "efficacyBound"); lo <- .n66_vec(looks, "futilityBound")
    d_up <- max(abs(up - ref$upper$bound)); d_lo <- max(abs(lo[1:2] - ref$lower$bound[1:2]))
    d_infl <- abs(r$diagnostics$confirmatory$inflation - ref$n.I[3])
    worst <- max(worst, d_up, d_lo, d_infl)
    text <- c(text, sprintf("%s: efficacy %s vs %s, futility %s vs %s, inflation %.4f vs %.4f", if (binding) "binding (type 3)" else "non-binding (type 4)",
                            paste(sprintf("%.4f", up), collapse = "/"), paste(sprintf("%.4f", ref$upper$bound), collapse = "/"),
                            paste(sprintf("%.4f", lo[1:2]), collapse = "/"), paste(sprintf("%.4f", ref$lower$bound[1:2]), collapse = "/"),
                            r$diagnostics$confirmatory$inflation, ref$n.I[3]))
  }
  list(pass = worst < 2e-3, detail = sprintf("%s; max|d| %.1e (tol 2e-3)", paste(text, collapse = " | "), worst))
})

vcr_case("N66b", c("AC-29", "AC-31"), function() {
  # a known-truth simulation: the statistic at look k is N(Delta sqrt(t_k), 1) with independent increments on the information scale;
  # Delta is the drift that the design was sized for, (z_alpha + z_beta) sqrt(inflation)
  r <- .n66_job(list(kind = "futility_group_sequential", informationRates = c(0.4, 0.7, 1), spending = "obrien_fleming",
                     futility = list(spending = "pocock", binding = FALSE)), id = "job_n66b")
  conf <- r$diagnostics$confirmatory
  t <- c(0.4, 0.7, 1); K <- 3L
  up <- .n66_vec(conf$looks, "efficacyBound"); lo <- .n66_vec(conf$looks, "futilityBound"); lo[K] <- -Inf
  delta <- (qnorm(0.975) + qnorm(0.9)) * sqrt(conf$inflation)
  max_size <- vcr_get_measure(r, "max_patients")$value
  sim <- function(drift, n = 400000L) {
    set.seed(6602, kind = "L'Ecuyer-CMRG")
    inc <- sapply(seq_len(K), function(k) stats::rnorm(n, drift * (t[k] - c(0, t)[k]), sqrt(t[k] - c(0, t)[k])))
    z <- t(apply(inc, 1, cumsum)) / matrix(sqrt(t), n, K, byrow = TRUE)
    stop_at <- rep(K, n); outcome <- rep("none", n); alive <- rep(TRUE, n)
    eff <- matrix(0, n, K); fut <- matrix(0, n, K)
    for (k in seq_len(K)) {
      hit_e <- alive & z[, k] >= up[k]; hit_f <- alive & !hit_e & z[, k] <= lo[k]
      eff[hit_e, k] <- 1; fut[hit_f, k] <- 1; alive <- alive & !hit_e & !hit_f
    }
    stopped_at <- ifelse(rowSums(eff) + rowSums(fut) > 0, max.col(eff + fut, ties.method = "first"), K)
    list(eff = colMeans(eff), fut = colMeans(fut), size = mean(t[stopped_at]) * max_size, n = n,
         se_eff = sqrt(colMeans(eff) * (1 - colMeans(eff)) / n), se_size = stats::sd(t[stopped_at]) * max_size / sqrt(n))
  }
  worst <- 0; text <- character()
  for (role in c("planned", "null")) {
    row <- Filter(function(e) identical(e$role, role), conf$effects)[[1]]
    s <- sim(if (identical(role, "planned")) delta else 0)
    stop_eff <- vapply(seq_len(K), function(i) row$cells[[sprintf("stop_efficacy_%d", i)]]$value, numeric(1))
    stop_fut <- vapply(seq_len(K), function(i) row$cells[[sprintf("stop_futility_%d", i)]]$value, numeric(1))
    size <- row$cells[[if (identical(role, "planned")) "expected_sample_size" else "expected_sample_size"]]$value
    z_eff <- max(abs(stop_eff - s$eff) / pmax(s$se_eff, 1e-4)); z_size <- abs(size - s$size) / s$se_size
    worst <- max(worst, z_eff, z_size)
    text <- c(text, sprintf("%s: efficacy stops %s vs simulated %s, expected size %.2f vs %.2f", role, paste(sprintf("%.4f", stop_eff), collapse = "/"), paste(sprintf("%.4f", s$eff), collapse = "/"), size, s$size))
  }
  list(pass = worst < 4, detail = sprintf("%s; worst %.2f standard errors (tol 4)", paste(text, collapse = " | "), worst))
})

vcr_case("N66c", c("AC-30"), function() {
  if (!requireNamespace("gsDesign", quietly = TRUE)) stop("N66 requires the locked gsDesign library")
  rates <- c(0.25, 0.5, 0.75, 1)
  eff_bounds <- function(spending, gamma = NULL) {
    d <- list(kind = "futility_group_sequential", informationRates = rates, spending = spending, futility = list(spending = "obrien_fleming", binding = FALSE))
    if (!is.null(gamma)) d$spendingGamma <- gamma
    .n66_vec(.n66_looks(.n66_job(d, id = "job_n66c")), "efficacyBound")
  }
  own <- function(name) vcr_group_sequential(rates, 0.025, name)$criticalValues
  ref <- function(sfu, param = NULL) gsDesign::gsDesign(k = 4, test.type = 1, alpha = 0.025, timing = rates, sfu = sfu, sfupar = param)$upper$bound
  d <- c(obf_engine = max(abs(eff_bounds("obrien_fleming") - own("obrien_fleming"))),
         pocock_engine = max(abs(eff_bounds("pocock") - own("pocock"))),
         hsd_gsDesign = max(abs(eff_bounds("hwang_shih_decani", -4) - ref(gsDesign::sfHSD, -4))),
         kd_gsDesign = max(abs(eff_bounds("kim_demets", 2) - ref(gsDesign::sfPower, 2))))
  list(pass = all(d < 2e-3), detail = sprintf("efficacy boundaries of a four-look design with a non-binding futility boundary: O'Brien-Fleming vs the engine's recursion %.1e, Pocock vs the engine's recursion %.1e, Hwang-Shih-DeCani (gamma -4) vs gsDesign %.1e, Kim-DeMets (gamma 2) vs gsDesign::sfPower %.1e (tol 2e-3)",
                                              d[["obf_engine"]], d[["pocock_engine"]], d[["hsd_gsDesign"]], d[["kd_gsDesign"]]))
})

vcr_case("N66d", c("AC-29", "AC-10"), function() {
  cont <- .n66_job(list(kind = "futility_group_sequential", informationRates = c(0.5, 1)), id = "job_n66d1")
  fixed_cont <- ceiling(vcr_n_means(0.5, 1, 0.025, 0.9, 0.5, 1)$total)
  bin <- .n66_job(list(kind = "futility_group_sequential", informationRates = c(0.5, 1)), "binary", list(plannedEffect = 0.15, controlRate = 0.3), id = "job_n66d2")
  fixed_bin <- ceiling(vcr_n_proportions(0.3, 0.45, 0.025, 0.9, 0.5, 1)$total)
  tte <- .n66_job(list(kind = "futility_group_sequential", informationRates = c(0.5, 1)), "time_to_event", list(plannedEffect = 0.7, controlMedian = 12), id = "job_n66d3",
                  extra = list(accrual = list(duration = 12, followup = 12, dropoutAnnual = 0.05)))
  fixed_events <- ceiling(vcr_events_schoenfeld(0.7, 0.025, 0.9, 0.5, 1))
  patients <- vcr_get_measure(tte, "max_patients")$value; events <- vcr_get_measure(tte, "max_events")$value
  # the patients that many events take, from the engine's own event probability (Lachin-Foulkes)
  p_ev <- 0.5 * vcr_event_probability(log(2) / 12, 12, 12, vcr_dropout_hazard(0.05, 12)) + 0.5 * vcr_event_probability(0.7 * log(2) / 12, 12, 12, vcr_dropout_hazard(0.05, 12))
  ok <- c(cont = identical(vcr_measure_value(cont, "required_total"), fixed_cont), bin = identical(vcr_measure_value(bin, "required_total"), fixed_bin),
          events = identical(vcr_measure_value(tte, "required_events"), fixed_events), patients = abs(patients - ceiling(events / p_ev)) <= 1,
          grows = vcr_measure_value(cont, "max_patients") >= fixed_cont && vcr_measure_value(cont, "expected_sample_size_h0") < vcr_measure_value(cont, "max_patients"))
  list(pass = all(ok), detail = sprintf("fixed size beside the design: continuous %s (closed form %s), binary %s (%s), events %s (%s); patients for %s events %s vs %s; null expected size under the maximum%s",
                                        vcr_measure_value(cont, "required_total"), fixed_cont, vcr_measure_value(bin, "required_total"), fixed_bin, vcr_measure_value(tte, "required_events"), fixed_events,
                                        events, patients, ceiling(events / p_ev), if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})


# --- the one table of signs (h) --------------------------------------------------------------------------------------

vcr_case("N66h", c("AC-29", "AC-26"), function() {
  conf <- function(design, endpoint, hyp, truth, extra = list()) {
    sc <- c(list(design = design, endpoint = list(type = endpoint), truth = truth, analysis = list(alpha = 0.025, power = 0.9)), if (!is.null(hyp)) list(hypothesis = list(direction = hyp)), extra)
    vcr_test_run(vcr_test_job("design.confirmatory", sc, job_id = "job_n66h", replicates = 200L))
  }
  refused <- function(r) identical(r$status, "failed") && "effect_against_direction" %in% vcr_test_issue_codes(r) && any(vapply(r$diagnostics$issues, function(i) i$field %in% c("scenario.truth.plannedEffect", "scenario.truth.rateRatio"), logical(1)))
  fut <- list(kind = "futility_group_sequential", informationRates = c(0.5, 1)); ssr <- list(kind = "sample_size_reestimation", informationRates = c(0.5, 1))
  tte_extra <- list(accrual = list(duration = 12, followup = 24))
  # the planned effect: the benefit side is sized, the harm side is refused by name, for both kinds that plan one
  table <- list(
    fut_cont_hi_ok = !refused(conf(fut, "continuous", "higher_better", list(plannedEffect = 0.4, sd = 1))),    fut_cont_hi_bad = refused(conf(fut, "continuous", "higher_better", list(plannedEffect = -0.4, sd = 1))),
    fut_cont_lo_ok = !refused(conf(fut, "continuous", "lower_better", list(plannedEffect = -0.4, sd = 1))),    fut_cont_lo_bad = refused(conf(fut, "continuous", "lower_better", list(plannedEffect = 0.4, sd = 1))),
    fut_bin_hi_ok = !refused(conf(fut, "binary", "higher_better", list(plannedEffect = 0.1, controlRate = 0.3))), fut_bin_hi_bad = refused(conf(fut, "binary", "higher_better", list(plannedEffect = -0.1, controlRate = 0.3))),
    fut_bin_lo_ok = !refused(conf(fut, "binary", "lower_better", list(plannedEffect = -0.1, controlRate = 0.3))),  fut_bin_lo_bad = refused(conf(fut, "binary", "lower_better", list(plannedEffect = 0.1, controlRate = 0.3))),
    fut_tte_ok = !refused(conf(fut, "time_to_event", NULL, list(plannedEffect = 0.7, controlMedian = 12), tte_extra)), fut_tte_bad = refused(conf(fut, "time_to_event", NULL, list(plannedEffect = 1.4, controlMedian = 12), tte_extra)),
    ssr_cont_hi_bad = refused(conf(ssr, "continuous", "higher_better", list(plannedEffect = -0.3, effects = list(-0.3), sd = 1))), ssr_cont_lo_bad = refused(conf(ssr, "continuous", "lower_better", list(plannedEffect = 0.3, effects = list(0.3), sd = 1))),
    ssr_bin_hi_bad = refused(conf(ssr, "binary", "higher_better", list(plannedEffect = -0.1, effects = list(-0.1), controlRate = 0.3))), ssr_bin_lo_bad = refused(conf(ssr, "binary", "lower_better", list(plannedEffect = 0.1, effects = list(0.1), controlRate = 0.3))),
    ssr_tte_bad = refused(conf(ssr, "time_to_event", NULL, list(plannedEffect = 1.4, effects = list(1.4), controlMedian = 12), tte_extra)),
    count_ok = !refused(conf(list(kind = "count_endpoint"), NULL, NULL, list(controlEventRate = 1, rateRatio = 0.7, overdispersion = 0.5))), count_bad = refused(conf(list(kind = "count_endpoint"), NULL, NULL, list(controlEventRate = 1, rateRatio = 1.4, overdispersion = 0.5))),
    # and a mean or a risk with no direction is refused by name, never read as higher-is-better
    no_direction = { r <- conf(fut, "continuous", NULL, list(plannedEffect = 0.4, sd = 1)); identical(r$status, "failed") && "scenario_field_missing" %in% vcr_test_issue_codes(r) })
  # the same size from the benefit of either direction: a lower-is-better mean of -0.4 and a higher-is-better one of +0.4 are the one design
  a <- conf(fut, "continuous", "lower_better", list(plannedEffect = -0.4, sd = 1)); b <- conf(fut, "continuous", "higher_better", list(plannedEffect = 0.4, sd = 1))
  same_cont <- identical(a$status, "succeeded") && identical(vcr_measure_value(a, "max_patients"), vcr_measure_value(b, "max_patients")) && identical(vcr_measure_value(a, "power"), vcr_measure_value(b, "power"))
  # a risk: 0.2 against 0.3 (lower is better) is 0.3 against 0.2 (higher is better), and 0.4 against 0.3 is another design altogether
  a <- conf(fut, "binary", "lower_better", list(plannedEffect = -0.1, controlRate = 0.3)); b <- conf(fut, "binary", "higher_better", list(plannedEffect = 0.1, controlRate = 0.2)); c3 <- conf(fut, "binary", "higher_better", list(plannedEffect = 0.1, controlRate = 0.3))
  same_bin <- identical(vcr_measure_value(a, "max_patients"), vcr_measure_value(b, "max_patients")) && !identical(vcr_measure_value(a, "max_patients"), vcr_measure_value(c3, "max_patients"))
  # the simulated kinds, through the adapter: continuous bit for bit, a risk against its complement within the error
  inv <- vcr_rpact_inverse_normal(c(0.5, 1), 0.025)
  ma <- function(dir, eff, cr = NULL, endpoint = "continuous", its = 3000L) vcr_rpact_sim_multiarm(endpoint, inv, eff, c(40, 80), list(rule = "best"), "simes", its, 6651L, sd = 1, control_rate = cr, direction = dir)
  en <- function(dir, s, r, cr = NULL, endpoint = "continuous", its = 3000L) vcr_rpact_sim_enrichment(endpoint, inv, s, r, 0.5, c(100, 200), list(rule = "best"), "simes", its, 6652L, sd = 1, control_rate = cr, direction = dir)
  ss <- function(dir, e, cr = NULL, endpoint = "continuous", its = 3000L) vcr_rpact_sim_reestimation(endpoint, inv, e, c(100, 200), 300, 0.8, 0.5, its, 6653L, sd = 1, control_rate = cr, direction = dir)
  bit_cont <- c(multi = identical(ma("lower_better", c(-0.3, -0.5)), ma("higher_better", c(0.3, 0.5))), enrich = identical(en("lower_better", -0.5, -0.1), en("higher_better", 0.5, 0.1)),
                ssr = identical(ss("lower_better", -0.3), ss("higher_better", 0.3)))
  power_of <- function(rows) { it <- .vcr_conf_iterations(rows, "stageNumber"); p <- mean(it$reject); c(p, sqrt(p * (1 - p) / it$n)) }
  gap <- function(x, y) abs(x[1] - y[1]) / sqrt(x[2]^2 + y[2]^2)
  z_bin <- c(multi = gap(power_of(ma("lower_better", c(-0.1, -0.15), 0.7, "binary")), power_of(ma("higher_better", c(0.1, 0.15), 0.3, "binary"))),
             enrich = gap(power_of(en("lower_better", -0.15, -0.05, 0.7, "binary")), power_of(en("higher_better", 0.15, 0.05, 0.3, "binary"))),
             ssr = gap(power_of(ss("lower_better", -0.15, 0.7, "binary")), power_of(ss("higher_better", 0.15, 0.3, "binary"))))
  # and a harm is a harm: the same differences against the direction reject almost never
  harm <- power_of(ma("higher_better", c(-0.1, -0.15), 0.3, "binary"))[1]
  # and the handler refuses the same planned harm when it is called with a scenario nobody validated
  direct <- function(sc) tryCatch({ vcr_job_design_confirmatory(list(scenario = sc, seed = 1L)); "no refusal" }, vcr_refusal = function(e) e$issue$code)
  handler <- c(direct(list(design = fut, endpoint = list(type = "continuous"), hypothesis = list(direction = "higher_better"), truth = list(plannedEffect = -0.4, sd = 1))),
               direct(list(design = fut, endpoint = list(type = "time_to_event"), truth = list(plannedEffect = 1.4, controlMedian = 12), accrual = list(duration = 12, followup = 24))),
               direct(list(design = list(kind = "count_endpoint"), truth = list(controlEventRate = 1, rateRatio = 1.4, overdispersion = 0.5))))
  ok <- c(unlist(table), same_cont = same_cont, same_bin = same_bin, bit_cont, bin_complement = all(z_bin < 4), harm = harm < 0.02, handler = all(handler == "effect_against_direction"))
  list(pass = all(ok), detail = sprintf("%d cells of the table of signs (planned effect on the benefit side sized, on the harm side refused as effect_against_direction, for futility, re-estimation and the count rate ratio; no direction refused); a lower-is-better mean equals the higher-is-better one with the sign turned in the design sizes and bit for bit in the multi-arm, enrichment and re-estimation simulations; a lower-is-better risk of 0.7 against 0.6/0.55 is its complement 0.3 against 0.4/0.45 within %.2f errors (multi-arm %.2f, enrichment %.2f, re-estimation %.2f); effects against the direction reject %.4f of the trials%s",
                                        length(table), max(z_bin), z_bin[["multi"]], z_bin[["enrich"]], z_bin[["ssr"]], harm, if (all(ok)) "" else paste0("; FAILED: ", paste(names(ok)[!ok], collapse = ","))))
})

# --- the event-time cap (i) ------------------------------------------------------------------------------------------------

vcr_case("N66i", c("AC-29", "AC-30"), function() {
  if (!requireNamespace("gsDesign", quietly = TRUE)) stop("N66 requires the locked gsDesign library")
  infl <- gsDesign::gsDesign(k = 2, test.type = 4, alpha = 0.025, beta = 0.1, timing = c(0.5, 1), sfu = gsDesign::sfLDOF, sfl = gsDesign::sfLDOF, n.fix = 1)$n.I[2]
  hrs <- c(0.75, 0.82, 0.85, 0.88, 0.9, 0.93)
  got <- vapply(hrs, function(hr) {
    r <- .n66_job(list(kind = "futility_group_sequential", informationRates = c(0.5, 1)), "time_to_event", list(plannedEffect = hr, controlMedian = 12), id = "job_n66i",
                  extra = list(accrual = list(duration = 12, followup = 24)))
    if (identical(r$status, "succeeded")) vcr_measure_value(r, "max_events") else NA_real_
  }, numeric(1))
  want <- ceiling(vapply(hrs, function(hr) vcr_events_schoenfeld(hr, 0.025, 0.9, 0.5, 1), numeric(1)) * infl)
  # re-estimation sizes its planned design with the same call, so it was refused at the same hazard ratios
  r <- vcr_test_run(vcr_test_job("design.confirmatory", list(design = list(kind = "sample_size_reestimation", informationRates = c(0.5, 1)), endpoint = list(type = "time_to_event"),
    truth = list(plannedEffect = 0.85, effects = list(0.85), controlMedian = 12), accrual = list(duration = 12, followup = 24), analysis = list(alpha = 0.025, power = 0.9)), job_id = "job_n66i2"))
  ssr_planned <- if (identical(r$status, "succeeded")) vcr_measure_value(r, "planned_events") else NA_real_
  # (its planned design has no futility boundary: Schoenfeld's events times the inflation of the efficacy-only O'Brien-Fleming design)
  infl_efficacy <- gsDesign::gsDesign(k = 2, test.type = 1, alpha = 0.025, timing = c(0.5, 1), sfu = gsDesign::sfLDOF, n.fix = 1)$n.I[2]
  want_ssr <- ceiling(vcr_events_schoenfeld(0.85, 0.025, 0.9, 0.5, 1) * infl_efficacy)
  list(pass = all(is.finite(got)) && all(abs(got - want) <= 1) && is.finite(ssr_planned) && abs(ssr_planned - want_ssr) <= 1,
       detail = sprintf("maximum events of the futility design at hazard ratios %s: %s; Schoenfeld's events times gsDesign's inflation (%.4f): %s; re-estimation at 0.85 plans %s events (gsDesign's efficacy-only inflation %.4f gives %d); the same calls were refused above hazard ratio 0.81 by a fixed cap of 1,000 subjects",
                        paste(hrs, collapse = "/"), paste(got, collapse = "/"), infl, paste(want, collapse = "/"), format(ssr_planned), infl_efficacy, as.integer(want_ssr)))
})
