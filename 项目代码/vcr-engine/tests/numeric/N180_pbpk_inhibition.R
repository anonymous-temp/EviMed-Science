# N180 — pk.interaction, the inhibitor side: midazolam with reversible CYP3A4 inhibition by ketoconazole (in-silico round 2, R38 second half, B4, 2026-11-09).
#
# References that are not the method's own code: (1) the model's authors' own table (Quinney et al. 2013, CPT Pharmacometrics Syst Pharmacol 2:e75,
# Table 4: the area ratio of intravenous midazolam 1 mg given with the sixth of ketoconazole 200 mg daily doses, 4.5 competitive, 2.0 noncompetitive, 2.5
# mixed; observed 3.1 (2.8-3.3)): the mixed and noncompetitive predictions are reproduced to the printed digit, the competitive one is not (see N180a);
# (2) a closed form of the same equations: with the inhibitor held constant and the victim at a trace dose, the model is linear and its area is the dose
# over the well-stirred clearance (and, for the oral dose, times the gut-wall and hepatic availabilities): the classical static mechanistic ratio, worked
# by hand from the parameter values and compared with the dynamic model (N180b); (3) `deSolve::lsoda` (a test-only package) on the same right-hand side
# (N180c); (4) published clinical studies as a labelled comparison, never as the reproduction and never tuned to (N180d). Cases run 1-10 s at 2 cores.

.n180_run <- function(victim, perpetrator, ...) {
  jr <- vcr_test_run(vcr_test_job("pk.interaction", c(list(victim = victim, perpetrator = perpetrator), list(...)), NULL, job_id = "job_n180"))
  list(jr = jr, ratio = vcr_measure_value(jr, "auc_ratio"), cmax_ratio = vcr_measure_value(jr, "cmax_ratio"))
}
.n180_ratio <- function(route, mdz_mg, ktz_mg, doses, model, gap = 0) {
  .n180_run(list(drug = "midazolam", doseMg = mdz_mg, route = route),
            list(drug = "ketoconazole", doseMg = ktz_mg, doses = as.integer(doses), gapH = gap, inhibition = model), horizonH = 96)$ratio
}

vcr_case("N180a", c("AC-08", "AC-30"), function() {
  # Quinney et al. 2013 Table 4 (iv midazolam 1 mg with the sixth of ketoconazole 200 mg daily doses; AUC to infinity, the engine's horizon is 96 h)
  r <- vapply(c("competitive", "noncompetitive", "mixed"), function(m) .n180_ratio("iv", 1, 200, 6, m), numeric(1))
  printed <- c(competitive = 4.5, noncompetitive = 2.0, mixed = 2.5)
  # printed to one decimal: half a unit of it for the two the supplement's code reproduces; the competitive one is held only to 1.25-fold of the printed value
  ok <- abs(r[["mixed"]] - 2.5) <= 0.05 && abs(r[["noncompetitive"]] - 2.0) <= 0.05 && max(r[["competitive"]] / 4.5, 4.5 / r[["competitive"]]) <= 1.25
  list(pass = ok,
       detail = sprintf("intravenous midazolam 1 mg with ketoconazole 200 mg x 6 d: mixed %.3f (the paper prints 2.5), noncompetitive %.3f (2.0), competitive %.3f (4.5: not reproduced to the digit, %.1f%% below it, the supplement states no other constants for it; held to 1.25-fold); observed 3.1 (2.8-3.3)",
                        r[["mixed"]], r[["noncompetitive"]], r[["competitive"]], 100 * (1 - r[["competitive"]] / 4.5)))
})

# The closed form. With the inhibitor held constant (derivatives of the five ketoconazole states zeroed, the gut-lumen and enzyme-compartment amounts
# fixed) and a trace dose of midazolam (0.01 mg: fum * A << km * V, so the Michaelis terms are linear), the equations give
#   x_h  = fukddi * Ke / (kic * Ve),  CLint = Vmaxh * fum / km * (fm / (1 + x_h) + (1 - fm)),  CL = Qh * CLint / (Qh + CLint) + CLren,
#   AUC_iv = D / CL                                  (the liver is one well-stirred compartment fed by the flow Qh),
#   x_g  = Kg / (Vgw * kic),  CLg = Vmaxg / (km * Vgw * (1 + x_g)),  Fg = kpv / (kpv + CLg),  Fh = Qh / (Qh + CLint),  AUC_po = D * Fg * Fh / CL.
.n180_static <- function(P, kic, Kg, Ke, dose, route) {
  xh <- P$fukddi * Ke / (kic * P$Ve)
  clint <- P$Vmaxh * P$fum / P$km * (P$fm / (1 + xh) + (1 - P$fm))
  cl <- P$Qh * clint / (P$Qh + clint) + P$CLren
  if (identical(route, "iv")) return(dose / cl)
  clg <- P$Vmaxg / (P$km * P$Vgw * (1 + Kg / (P$Vgw * kic)))
  dose * (P$kpv / (P$kpv + clg)) * (P$Qh / (P$Qh + clint)) / cl
}
.n180_frozen_auc <- function(P, model, route, dose, Kg, Ke) {
  f <- .vcr_inhib_rhs(P, model); g <- function(t, y, inf_rate = 0) { d <- f(t, y, inf_rate); d[7:11] <- 0; d }
  y0 <- numeric(length(.vcr_inhib_states)); names(y0) <- .vcr_inhib_states; y0[["Kgut"]] <- Kg; y0[["Kenzyme"]] <- Ke
  y0[[if (identical(route, "oral")) "Mgut" else "Mcentral"]] <- dose
  m <- .vcr_pbpk_integrate(g, y0, data.frame(time = numeric(), state = integer(), amount = numeric()), list(), c(0, 400), states = .vcr_inhib_states)
  m[nrow(m), "AUC"]
}

vcr_case("N180b", c("AC-08", "AC-30"), function() {
  P <- .vcr_inhib_params(); mg <- P$MW_ktz / 1e6
  out <- list(); worst <- 0
  for (model in c("competitive", "mixed")) {
    kic <- .vcr_inhib_constants(P, model)$kic
    for (route in c("iv", "oral")) for (ik in list(c(Kg = 0, Ke = 0), c(Kg = 0.02, Ke = 0.2), c(Kg = 0.3, Ke = 2))) {
      dyn <- .n180_frozen_auc(P, model, route, 0.01, ik[["Kg"]], ik[["Ke"]])
      hand <- .n180_static(P, kic, ik[["Kg"]], ik[["Ke"]], 0.01, route)
      worst <- max(worst, abs(dyn / hand - 1))
      out[[length(out) + 1L]] <- sprintf("%s %s Kg=%g Ke=%g: dynamic %.6g, closed form %.6g", model, route, ik[["Kg"]], ik[["Ke"]], dyn, hand)
    }
  }
  # the ratio at the strongest setting against none: the static mechanistic ratio of the oral dose
  base <- .n180_static(P, 1, 0, 0, 0.01, "oral"); hit <- .n180_static(P, .vcr_inhib_constants(P, "competitive")$kic, 0.3, 2, 0.01, "oral")
  list(pass = worst < 2e-3 && hit / base > 10,
       detail = sprintf("with the inhibitor held constant and a 0.01 mg midazolam dose the dynamic model's area equals the hand-worked static mechanistic area (Fg, Fh and the well-stirred clearance) within %.1e over 12 settings (held to 2e-3: the Michaelis terms are linear only to about 1e-4); for example %s; the static oral ratio at the strongest setting is %.1f-fold", worst, out[[length(out)]], hit / base))
})

.n180_lsoda <- function(model, victim_route, dose, ktz_dose, doses, gap, horizon, times_rel) {
  P <- .vcr_inhib_params(); f <- .vcr_inhib_rhs(P, model)
  y <- numeric(length(.vcr_inhib_states)); names(y) <- .vcr_inhib_states
  t_v <- (doses - 1L) * 24 + gap
  ev <- rbind(data.frame(time = (seq_len(doses) - 1L) * 24, state = match("Kgut", .vcr_inhib_states), amount = ktz_dose),
              data.frame(time = t_v, state = match(if (identical(victim_route, "iv")) "Mcentral" else "Mgut", .vcr_inhib_states), amount = dose))
  marks <- sort(unique(c(0, ev$time, t_v + times_rel))); out <- list(); t <- 0
  for (tm in marks) {
    if (tm > t) { y <- deSolve::lsoda(y, c(t, tm), function(tt, yy, parms) list(f(tt, yy)), NULL, rtol = 1e-10, atol = 1e-14)[2, -1]; names(y) <- .vcr_inhib_states; t <- tm }
    for (e in which(abs(ev$time - tm) < 1e-12)) y[ev$state[e]] <- y[ev$state[e]] + ev$amount[e]
    if (any(abs(t_v + times_rel - tm) < 1e-12)) out[[length(out) + 1L]] <- c(time = tm - t_v, y)
  }
  m <- do.call(rbind, out)
  list(conc = 1000 * m[, "Mcentral"] / P$V4, auc = 1000 * (m[nrow(m), "AUC"] - m[1, "AUC"]), time = m[, "time"])
}

vcr_case("N180c", c("AC-08", "AC-30"), function() {
  if (!requireNamespace("deSolve", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the cross-check package deSolve is not installed (the run must not skip silently)"))
  rel <- c(0, 0.5, 1, 2, 4, 8, 12); worst <- 0; lines <- character()
  for (sc in list(list(m = "mixed", r = "iv", d = 1, k = 200, n = 3L, g = 0), list(m = "competitive", r = "oral", d = 3, k = 400, n = 2L, g = 1), list(m = "noncompetitive", r = "oral", d = 2, k = 200, n = 4L, g = 12))) {
    mine <- vcr_pbpk_inhibition(list(route = sc$r, doseMg = sc$d), list(doseMg = sc$k, intervalH = 24, doses = sc$n, gapH = sc$g), sc$m, 12)
    ref <- .n180_lsoda(sc$m, sc$r, sc$d, sc$k, sc$n, sc$g, 12, rel)
    at <- function(key) vapply(rel, function(r) mine[[key]][which.min(abs(mine$rel_time - r))], numeric(1))
    dd <- c(max(abs(at("with") - ref$conc) / pmax(ref$conc, 1e-3)), abs(mine$auc_with - ref$auc) / ref$auc)
    worst <- max(worst, dd)
    lines <- c(lines, sprintf("%s %s %g mg after %d x %g mg: area %.6f against %.6f, curve largest relative difference %.1e", sc$m, sc$r, sc$d, sc$n, sc$k, mine$auc_with, ref$auc, max(dd)))
  }
  list(pass = worst < 1e-6, detail = sprintf("lsoda (rtol 1e-10) on the same equations with the doses as events: %s; largest %.1e (held to 1e-6)", paste(lines, collapse = "; "), worst))
})

# Observed ratios of midazolam AUC with ketoconazole, from open text: route, midazolam dose (mg), ketoconazole dose (mg), days, observed (a range is given as its two bounds);
# the midazolam dose and the course length of the Guo rows, and the dose and timing of the oral 15-fold study, are NOT in the open text (the abstract and the
# introduction) and are the assumptions of this case: the model is linear in the midazolam dose at these concentrations (N180e), so the dose is not a free choice
# that matters, and the ratio changes by under 7% between 4 and 6 days of ketoconazole 400 mg (and by under 0.1% at 200 mg).
.n180_clinical <- list(
  list("Quinney 2013, Table 4 (iv, 200 mg x 6 d)", "iv", 1, 200, 6L, 3.1),
  list("Guo 2020, iv, 200 mg", "iv", 1, 200, 6L, c(2.7, 3.4)), list("Guo 2020, iv, 400 mg", "iv", 1, 400, 6L, c(3.9, 4.7)),
  list("Guo 2020, oral, 200 mg", "oral", 3, 200, 6L, c(11.4, 13.4)), list("Guo 2020, oral, 400 mg", "oral", 3, 400, 6L, c(17.0, 19.7)),
  list("Marok 2023 introduction (400 mg x 4 d, oral)", "oral", 7.5, 400, 4L, 15))

vcr_case("N180d", c("AC-08", "AC-30"), function() {
  # A labelled prediction, bottom-up, with the published constants and nothing tuned: six observed ratios from three open sources, the paper's best-fitting (mixed)
  # model; the fold error is the larger of predicted/observed and observed/predicted (for a range, observed = the geometric mean of its bounds).
  rows <- lapply(.n180_clinical, function(r) {
    obs <- exp(mean(log(r[[6]]))); pred <- .n180_ratio(r[[2]], r[[3]], r[[4]], r[[5]], "mixed")
    list(name = r[[1]], pred = pred, obs = obs, fold = max(pred / obs, obs / pred))
  })
  fold <- vapply(rows, function(r) r$fold, numeric(1)); gm <- exp(mean(log(fold)))
  line <- paste(vapply(rows, function(r) sprintf("%s: predicted %.1f, observed %.1f, fold error %.2f", r$name, r$pred, r$obs, r$fold), character(1)), collapse = "; ")
  # the usual bar is 2-fold per study; the case holds the prediction to it and reports the geometric mean fold error
  list(pass = all(fold <= 2) && gm < 1.6,
       detail = sprintf("mixed inhibition model, midazolam after repeated ketoconazole, predicted before comparison and not adjusted: %s; geometric mean fold error %.2f, %d of %d within 2-fold", line, gm, sum(fold <= 2), length(fold)))
})

vcr_case("N180e", c("AC-08", "AC-30"), function() {
  # the job's own structure and its refusals: measures and curve, no enzyme-activity measure (nothing is induced), the model named in the premises, a weight that is not
  # an input said so, an inhibitor outside the model refused by name, a ratio of 1 with no ketoconazole, and the midazolam dose linearity the clinical rows rely on
  jr <- vcr_test_run(vcr_test_job("pk.interaction", list(victim = list(drug = "midazolam", doseMg = 1, route = "iv"), perpetrator = list(drug = "ketoconazole", doseMg = 200, doses = 6L, gapH = 0), weightKg = 70, horizonH = 96), NULL, job_id = "job_n180e"))
  none <- vcr_test_run(vcr_test_job("pk.interaction", list(victim = list(drug = "midazolam", doseMg = 1, route = "iv"), perpetrator = list(drug = "ketoconazole", doseMg = 1e-12, doses = 1L, gapH = 0), horizonH = 48), NULL, job_id = "job_n180e1"))
  bad <- vcr_test_run(vcr_test_job("pk.interaction", list(victim = list(drug = "midazolam", doseMg = 1), perpetrator = list(drug = "clarithromycin", doseMg = 500, doses = 3L)), NULL, job_id = "job_n180e2"))
  nm <- vapply(jr$measures, function(m) m$name, character(1))
  pk <- jr$diagnostics$pbpk
  keys <- vapply(pk$assumed, function(a) a$key, character(1))
  lin <- c(.n180_ratio("oral", 1, 400, 4, "mixed"), .n180_ratio("oral", 7.5, 400, 4, "mixed"))
  list(pass = identical(jr$status, "succeeded") && all(c("auc_ratio", "cmax_ratio", "victim_auc_alone") %in% nm) && !any(grepl("cyp3a4", nm)) && identical(pk$model$mechanism, "inhibition") &&
         identical(pk$given$perpetrator$inhibition, "mixed") && "weightKg" %in% keys && "perpetrator.inhibition" %in% keys && length(pk$curve) >= 10L &&
         abs(vcr_measure_value(none, "auc_ratio") - 1) < 1e-6 && !identical(bad$status, "succeeded") && "scenario_value_invalid" %in% vcr_test_issue_codes(bad) && abs(lin[2] / lin[1] - 1) < 0.02,
       detail = sprintf("the job succeeds (status %s) with the area and peak ratios and no enzyme-activity measure, names the mixed model and states the unused weight and the default model as assumptions (%s); a ketoconazole dose of 1e-12 mg leaves the ratio at %.8f; clarithromycin (a mechanism-based inhibitor with no published model in open text) is refused (%s); the oral ratio after ketoconazole 400 mg x 4 d is %.3f for midazolam 1 mg and %.3f for 7.5 mg (linear to %.2f%%)",
                        jr$status, paste(keys, collapse = ", "), vcr_measure_value(none, "auc_ratio"), paste(vcr_test_issue_codes(bad), collapse = ", "), lin[1], lin[2], 100 * abs(lin[2] / lin[1] - 1)))
})
