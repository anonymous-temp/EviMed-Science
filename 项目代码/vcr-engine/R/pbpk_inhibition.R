# ---------------------------------------------------------------------------
# pbpk_inhibition.R — pk.interaction, the inhibitor side: a published semi-physiological model of midazolam with reversible CYP3A4 inhibition by
# repeated oral ketoconazole (plan R38 second half, round 2, B4).
#
# Hidden knowledge:
#
# - **The model is Chien et al. 2006 as Quinney et al. 2013 wrote it as R code, not a re-derivation.** Chien JY, Lucksiri A, Ernest CS 2nd, Gorski JC,
#   Wrighton SA, Hall SD. Drug Metab Dispos 2006;34(7):1208-1219 (midazolam and ketoconazole in a gut-wall / portal / liver / central / peripheral
#   structure with an "enzyme compartment" that carries ketoconazole's hepatic exposure); Quinney SK, Zhang X, Lucksiri A, Gorski JC, Li L, Hall SD.
#   CPT Pharmacometrics Syst Pharmacol 2013;2:e75 (doi 10.1038/psp.2013.50) reran it with three inhibition models whose constants they re-estimated
#   from the in-vitro data of six laboratories corrected for microsomal binding. The paper's Supplement (PSP-2013-0039-s06.txt, the three right-hand
#   sides; -s07.txt, the parameter vector and a worked 200 mg x 6 days example) is open on Europe PMC (PMC4026634) and is the only open copy of the
#   equations (the paper prints them as images). Every number below is a row of -s07 (which names Chien 2006 for most of them) except the inhibition
#   constants, which are the paper's Table 3, binding model "BIM" (independent binding, metabolite binding), the column the paper's simulation uses.
# - **Table 4 of the paper is what holds it**: the area ratio of 1 mg intravenous midazolam given with the sixth of 200 mg ketoconazole daily doses,
#   against midazolam alone, is 4.5 (competitive, Kic 4.2 nM), 2.0 (noncompetitive, Kin 33.5 nM) and 2.5 (mixed, Kic 19.2 and Kin 39.8 nM); the
#   observed value the paper quotes is 3.1 (2.8-3.3). The three published predictions are three inhibition models, not three confidence levels: the
#   engine runs the one the scenario names (default the mixed model, the paper's best fit) and says which. Nothing is tuned to the observation.
# - **The noncompetitive model is the mixed model with Kic = Kin** (the supplement writes it that way: the Km term carries the same factor); the
#   competitive model is the mixed model with Kin infinite. One right-hand side, two constants.
# - **The equations are mass balances in mg and litres**, as the supplement writes them, including its conventions: the gut-wall term uses the amount
#   of ketoconazole in the gut lumen over the gut-wall volume (Vgw = 1 L) as the inhibitor concentration there, and the liver term uses the amount in
#   the enzyme compartment (the supplement's y[10]) over its volume times the unbound fraction fukddi. Ketoconazole is dosed to the gut lumen and
#   reaches the liver compartment directly (it has no portal vein). The supplement's twelfth state is a placeholder with a zero derivative and is not
#   kept; the area under the midazolam curve is a state, as in the rifampicin model.
# - **No weight and no variability.** The volumes and flows are the typical adult's (the supplement gives none per kilogram); a stated weight is
#   not a model input here and the engine says that. Midazolam is oral (gut lumen) or intravenous (a bolus into the central compartment).
# - **What is not here, and why** (RES-PBPK.md): itraconazole (with its hydroxy metabolite) and the mechanism-based inhibitor clarithromycin have no
#   published model whose equations and constants can be read in full from open text; a request for them is refused by name by the schema.
#   Ketoconazole's oral-midazolam prediction is an extrapolation: the model's authors validated it on intravenous midazolam (Table 4) and the
#   engine states that with the number.
# ---------------------------------------------------------------------------

.vcr_inhib_params <- function() {
  list(
    # midazolam (supplement -s07, rows para[1:8], [18], [22], [23], [26:33]; Chien 2006). Volumes in L, flows in L/h, Vmax in mg/h, km in mg/L.
    ka = 1.17, kpv = 1400, V4 = 43, V5 = 88.4, Q4 = 14.73, Vmaxg = 2549, Vmaxh = 2549 + 206, km = 5.8 * 0.362,
    fm = 0.93, fum = 0.04, fukddi = 0.01, Vpv = 0.07, Qpv = 67.5, Qh = 90, Vh = 1.5, Vgw = 1, CLren = 0.06,
    # ketoconazole (rows para[9:16], [24], [25], [30], [34], [35])
    ka1 = 1.10, V51 = 32.1, V61 = 19.6, keff = 5, k2e = 1, Q5 = 2.39, Vmaxh1 = 41.1, km1 = 0.810, fukCL = 1, fukEff = 1,
    Vhk = 0.825, Tmax = 1, Ve = 0.825,
    # molecular weight of ketoconazole used for nM -> mg/L (rows para[17], [37], [38]: x 531.4 / 1e6)
    MW_ktz = 531.4,
    # Table 3 (BIM column), nmol/L: the three inhibition models
    Kic_competitive_nM = 4.2, Kin_noncompetitive_nM = 33.5, Kic_mixed_nM = 19.2, Kin_mixed_nM = 39.8
  )
}

.vcr_inhib_states <- c("Mgut", "Mgutwall", "Mportal", "Mliver", "Mcentral", "Mperiph", "Kgut", "Kliver", "Kenzyme", "Kcentral", "Kperiph", "AUC")

#' The inhibition constants of a model, in mg/L: `kic` (competitive part) and `kin` (noncompetitive part); Inf where the model has none.
.vcr_inhib_constants <- function(P, model) {
  mg <- P$MW_ktz / 1e6
  switch(model,
    competitive = list(kic = P$Kic_competitive_nM * mg, kin = Inf),
    noncompetitive = list(kic = P$Kin_noncompetitive_nM * mg, kin = P$Kin_noncompetitive_nM * mg),
    mixed = list(kic = P$Kic_mixed_nM * mg, kin = P$Kin_mixed_nM * mg),
    stop("unknown inhibition model"))
}

#' The right-hand side for one inhibition model. `inf_rate` is a midazolam infusion into the central compartment (mg/h).
.vcr_inhib_rhs <- function(P, model) {
  K <- .vcr_inhib_constants(P, model)
  with(c(P, K), {
    inv_kin <- if (is.finite(kin)) 1 / kin else 0
    function(t, y, inf_rate = 0) {
      Ag <- y[1]; Agw <- y[2]; Apv <- y[3]; Ah <- y[4]; A4 <- y[5]; A5 <- y[6]
      Kg <- y[7]; Kh <- y[8]; Ke <- y[9]; K4 <- y[10]; K5 <- y[11]
      d <- numeric(12L)
      d[1] <- -ka * Ag
      d[2] <- ka * Ag - kpv * Agw - Vmaxg * Agw / (km * (Vgw + Kg / kic) + Agw * (1 + Kg / Vgw * inv_kin))
      d[3] <- kpv * Agw - Qpv * (Apv / Vpv - A4 / V4)
      d[4] <- Qpv * (Apv / Vpv - A4 / V4) + Qh * (A4 / V4 - Ah / Vh) -
        fm * Vmaxh * fum * Ah / (km * (Vh + fukddi * Ke * Vh / (kic * Ve)) + fum * Ah * (1 + fukddi * Ke / Ve * inv_kin)) -
        (1 - fm) * Vmaxh * fum * Ah / (Vh * km + fum * Ah)
      d[5] <- inf_rate - Qh * (A4 / V4 - Ah / Vh) - Q4 * (A4 / V4 - A5 / V5) - CLren * A4 / V4
      d[6] <- Q4 * (A4 / V4 - A5 / V5)
      d[7] <- -ka1 * Kg
      d[8] <- ka1 * Kg + Qh * (K4 / V51 - Kh / Vhk) - Vmaxh1 * fukCL * Kh / (Vhk * km1 + Kh * fukCL) - fukEff * k2e * Kh + Tmax * Ke / (Ve * keff + Ke)
      d[9] <- fukEff * k2e * Kh - Tmax * Ke / (Ve * keff + Ke)
      d[10] <- -Qh * (K4 / V51 - Kh / Vhk) - Q5 * (K4 / V51 - K5 / V61)
      d[11] <- Q5 * (K4 / V51 - K5 / V61)
      d[12] <- A4 / V4
      d
    }
  })
}

#' One interaction under the inhibition model: the victim alone and with the perpetrator's repeated doses. Same return shape as vcr_pbpk_interaction.
vcr_pbpk_inhibition <- function(victim, perpetrator, model = "mixed", horizon, grid = NULL, P = .vcr_inhib_params(), rtol = 1e-6, atol = 1e-9) {
  f <- .vcr_inhib_rhs(P, model)
  y0 <- numeric(length(.vcr_inhib_states)); names(y0) <- .vcr_inhib_states
  n_p <- as.integer(perpetrator$doses); interval <- perpetrator$intervalH
  t_v <- (n_p - 1L) * interval + perpetrator$gapH
  ktz_events <- data.frame(time = (seq_len(n_p) - 1L) * interval, state = match("Kgut", .vcr_inhib_states), amount = perpetrator$doseMg)
  v_state <- match(if (identical(victim$route, "oral")) "Mgut" else "Mcentral", .vcr_inhib_states)
  inf_h <- victim$infusionH %||% 0
  mdz_event <- function(t0) if (identical(victim$route, "iv") && inf_h > 0) NULL else data.frame(time = t0, state = v_state, amount = victim$doseMg)
  mdz_inf <- function(t0) if (identical(victim$route, "iv") && inf_h > 0) list(list(start = t0, end = t0 + inf_h, rate = victim$doseMg / inf_h)) else list()
  rel <- if (is.null(grid)) sort(unique(c(pmin(c(0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48, 72, 96), horizon), horizon))) else unique(c(seq(0, horizon, by = grid), horizon))
  run <- function(t0, with_perp) {
    ev <- rbind(if (with_perp) ktz_events, mdz_event(t0), data.frame(time = numeric(), state = integer(), amount = numeric()))
    ev <- ev[order(ev$time), , drop = FALSE]
    t_out <- sort(unique(c(t0, t0 + rel)))
    if (with_perp) t_out <- sort(unique(c(t_out, ktz_events$time)))
    .vcr_pbpk_integrate(f, y0, ev, mdz_inf(t0), t_out, rtol, atol, states = .vcr_inhib_states)
  }
  alone <- run(0, FALSE); with_p <- run(t_v, TRUE)
  vol <- P$V4
  pick <- function(m, t0) {
    base <- m[abs(m[, "time"] - t0) < 1e-9, "AUC"]
    m2 <- m[m[, "time"] >= t0 - 1e-9, , drop = FALSE]
    list(time = m2[, "time"] - t0, conc = 1000 * m2[, "Mcentral"] / vol, auc = 1000 * (m2[nrow(m2), "AUC"] - base), m2 = m2)
  }
  peak <- function(res) {
    k <- which.max(res$conc)
    if (k == 1L || k == length(res$conc) || identical(victim$route, "iv")) return(max(res$conc))
    m2 <- res$m2; start <- m2[k - 1L, ]
    at <- function(tt) {
      yy <- .vcr_radau_segment(f, start[-1], start[1], tt, rtol = rtol, atol = atol)
      1000 * yy[["Mcentral"]] / vol
    }
    o <- stats::optimize(at, c(m2[k - 1L, 1], m2[k + 1L, 1]), maximum = TRUE, tol = 1e-4)
    max(res$conc[k], o$objective)
  }
  a <- pick(alone, 0); w <- pick(with_p, t_v)
  a$cmax <- peak(a); w$cmax <- peak(w)
  ktz <- with_p[with_p[, "time"] <= t_v + 1e-9, c("time", "Kcentral")]
  list(rel_time = a$time, alone = a$conc, with = w$conc, auc_alone = a$auc, auc_with = w$auc, cmax_alone = a$cmax, cmax_with = w$cmax,
       cyp_liver = NA_real_, cyp_gut = NA_real_, rif = ktz, weight = NA_real_, victimTime = t_v, model = model)
}

.vcr_inhib_citation <- paste0(
  "Quinney SK, Zhang X, Lucksiri A, Gorski JC, Li L, Hall SD. Physiologically based pharmacokinetic model of the interaction of midazolam and ketoconazole: ",
  "competitive, noncompetitive and mixed inhibition. CPT Pharmacometrics Syst Pharmacol 2013;2:e75 (doi 10.1038/psp.2013.50), the model of Chien JY et al. ",
  "Drug Metab Dispos 2006;34:1208-1219; equations and parameters as in the paper's supplementary R code.")
