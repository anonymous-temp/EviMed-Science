# N160 — pk.interaction: a published whole-body PBPK model of midazolam with CYP3A4 induction by rifampicin (in-silico round 2, R38, 2026-11-09).
#
# References that are not the method's own code: (1) the model's authors' own simulation (Asaumi et al. 2018 as run in the Metrum Research Group's open
# mrgsolve vignette, rifampicin_midazolam.cpp: its printed areas for 3 mg midazolam 12 h after the last of seven daily rifampicin doses, and the
# dose-response of the same design, 10 to 90 mg). The paper prints no interaction ratio in its text (its fits are figures), so this is the published
# number there is; the vignette prints 4 significant figures (3 for the dose-response), so the held tolerance is half a unit of the last printed digit;
# (2) `deSolve::lsoda` (a test-only package) on the same right-hand side with events handled the same way: it holds the engine's own implicit solver to
# 1e-6 on every state it reports; it cannot hold the equations (the authors' simulation does that); (3) published clinical studies (Hanke et al. 2018,
# Table 1: observed midazolam AUC ratios after rifampicin 600 mg daily) as a labelled comparison, never as the reproduction: the model was fitted to
# other data (Kharasch 2011; Gorski 2003) and these ratios scatter eight-fold between studies. Cases run 6-40 s at 2 cores; none depends on machine speed.

.n160_run <- function(victim, perpetrator, ...) {
  jr <- vcr_test_run(vcr_test_job("pk.interaction", c(list(victim = victim, perpetrator = perpetrator), list(...)), NULL, job_id = "job_n160"))
  list(jr = jr, auc_alone = vcr_measure_value(jr, "victim_auc_alone"), auc_with = vcr_measure_value(jr, "victim_auc_with_perpetrator"),
       ratio = vcr_measure_value(jr, "auc_ratio"))
}

vcr_case("N160a", c("AC-08", "AC-30"), function() {
  # printed by the vignette (ng/mL*h over 10 h, 3 mg midazolam, 12 h after the last of 7 daily doses): alone 24.70 and 6.84 after 75 mg; the dose-response
  # rows 10 mg 13.9 (56.3%), 30 mg 9.74 (39.4%), 90 mg 6.33 (25.6%)
  v <- list(drug = "midazolam", doseMg = 3)
  r75 <- .n160_run(v, list(drug = "rifampicin", doseMg = 75, doses = 7L), horizonH = 10)
  want <- list(`10` = c(13.9, 56.3, 0.05), `30` = c(9.74, 39.4, 0.005), `90` = c(6.33, 25.6, 0.005))   # area, percent of the area alone, half a unit of the area's last digit
  dr <- lapply(names(want), function(k) .n160_run(v, list(drug = "rifampicin", doseMg = as.numeric(k), doses = 7L), horizonH = 10))
  names(dr) <- names(want)
  d75 <- c(abs(r75$auc_alone - 24.70), abs(r75$auc_with - 6.84), abs(100 * (1 - r75$ratio) - 72.32))
  dd <- unlist(lapply(names(want), function(k) c(abs(dr[[k]]$auc_with - want[[k]][1]) / want[[k]][3], abs(100 * dr[[k]]$ratio - want[[k]][2]) / 0.05)))
  ok75 <- identical(r75$jr$status, "succeeded") && d75[1] <= 0.005 && d75[2] <= 0.005 && d75[3] <= 0.02
  list(pass = ok75 && all(dd <= 1),
       detail = sprintf("75 mg x 7 days: area alone %.4f (the vignette prints 24.70) and after %.4f (6.84), reduction %.3f%% (72.32%%); dose-response after 10, 30 and 90 mg: %.3f, %.3f, %.3f (13.9, 9.74, 6.33) = %.2f, %.2f, %.2f%% of the area alone (56.3, 39.4, 25.6); every difference within half a unit of the last printed digit (largest, as a share of it: %.2f)",
                        r75$auc_alone, r75$auc_with, 100 * (1 - r75$ratio), dr[["10"]]$auc_with, dr[["30"]]$auc_with, dr[["90"]]$auc_with,
                        100 * dr[["10"]]$ratio, 100 * dr[["30"]]$ratio, 100 * dr[["90"]]$ratio, max(dd)))
})

# deSolve on the same right-hand side, with the doses as events (lsoda restarts at each); the oracle for the engine's solver
.n160_lsoda <- function(victim, perpetrator, weight, horizon, times_rel) {
  P <- .vcr_pbpk_params(); f <- .vcr_pbpk_rhs(P, weight)
  y <- .vcr_pbpk_init(); vol <- P$mVcentral_kg * weight
  t_v <- (perpetrator$doses - 1L) * perpetrator$intervalH + perpetrator$gapH
  ev <- rbind(data.frame(time = (seq_len(perpetrator$doses) - 1L) * perpetrator$intervalH, state = .vcr_pbpk_i("Xgutlumen"), amount = perpetrator$doseMg),
              if (!(identical(victim$route, "iv") && !is.null(victim$infusionH))) data.frame(time = t_v, state = .vcr_pbpk_i(if (identical(victim$route, "iv")) "mcentral" else "Mgutlumen"), amount = victim$doseMg))
  inf <- if (identical(victim$route, "iv") && !is.null(victim$infusionH)) list(start = t_v, end = t_v + victim$infusionH, rate = victim$doseMg / victim$infusionH)
  marks <- sort(unique(c(0, ev$time, if (!is.null(inf)) c(inf$start, inf$end), t_v + times_rel)))
  out <- list(); t <- 0
  for (tm in marks) {
    if (tm > t) {
      rate <- if (!is.null(inf) && inf$start <= t + 1e-12 && inf$end >= tm - 1e-12) inf$rate else 0
      fun <- function(tt, yy, parms) list(f(tt, yy, inf_rate = rate))
      y <- deSolve::lsoda(y, c(t, tm), fun, NULL, rtol = 1e-10, atol = 1e-14)[2, -1]
      names(y) <- .vcr_pbpk_states
      t <- tm
    }
    for (e in which(abs(ev$time - tm) < 1e-12)) y[ev$state[e]] <- y[ev$state[e]] + ev$amount[e]
    if (any(abs(t_v + times_rel - tm) < 1e-12)) out[[length(out) + 1L]] <- c(time = tm - t_v, y)
  }
  m <- do.call(rbind, out)
  list(conc = 1000 * m[, "mcentral"] / vol, auc = 1000 * (m[nrow(m), "AUC"] - m[1, "AUC"]), cyp = m[1, c("CYP_HC5", "CYP_ent")], time = m[, "time"])
}

vcr_case("N160b", c("AC-08", "AC-30"), function() {
  if (!requireNamespace("deSolve", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the cross-check package deSolve is not installed (the run must not skip silently)"))
  rel <- c(0, 0.5, 1, 2, 4, 8)
  worst <- 0; lines <- character()
  for (sc in list(list(v = list(drug = "midazolam", doseMg = 3, route = "oral"), p = list(doseMg = 75, intervalH = 24, doses = 3L, gapH = 12), w = 80),
                  list(v = list(drug = "midazolam", doseMg = 2, route = "iv", infusionH = 0.5), p = list(doseMg = 600, intervalH = 24, doses = 2L, gapH = 6), w = 65))) {
    mine <- vcr_pbpk_interaction(sc$v, sc$p, sc$w, 8)
    ref_with <- .n160_lsoda(sc$v, sc$p, sc$w, 8, rel)
    ref_alone <- .n160_lsoda(sc$v, list(doseMg = 1e-300, intervalH = 24, doses = 1L, gapH = sc$p$gapH), sc$w, 8, rel)
    # the curves at the common times (the engine's grid contains them), the areas to 8 h, and the enzyme activities at the dose
    at <- function(res, key) vapply(rel, function(r) res[[key]][which.min(abs(mine$rel_time - r))], numeric(1))
    d <- c(max(abs(at(mine, "with") - ref_with$conc) / pmax(ref_with$conc, 1e-3)), max(abs(at(mine, "alone") - ref_alone$conc) / pmax(ref_alone$conc, 1e-3)),
           abs(mine$auc_with - ref_with$auc) / ref_with$auc, abs(mine$cyp_liver - ref_with$cyp[[1]]) / ref_with$cyp[[1]], abs(mine$cyp_gut - ref_with$cyp[[2]]) / ref_with$cyp[[2]])
    worst <- max(worst, d)
    lines <- c(lines, sprintf("%s %.1f mg after %d doses: area %.6f against %.6f, curve and enzyme activities largest relative difference %.1e", sc$v$route, sc$v$doseMg, sc$p$doses, mine$auc_with, ref_with$auc, max(d)))
  }
  list(pass = worst < 1e-6, detail = sprintf("lsoda (rtol 1e-10) on the same equations with the doses as events: %s; largest %.1e (held to 1e-6)", paste(lines, collapse = "; "), worst))
})

# Hanke et al. 2018, Table 1 (midazolam after rifampicin 600 mg daily): study, route, dose (mg; the mg/kg doses at 80 kg), gap after the last dose (h), observed AUC ratio
.n160_clinical <- list(
  oral = list(list("Kharasch 2004", 3, 8, 0.053), list("Gorski 2003", 4, 12, 0.032), list("Backman 1996", 15, 17, 0.041), list("Link 2008", 7.5, 24, 0.016),
              list("Chung 2006", 6, 22, 0.124), list("Reitman 2011", 2, 0, 0.123)),
  iv = list(list("Gorski 2003", 4, 12, 0.512, 0.5), list("Kharasch 2004", 1, 8, 0.521, 0), list("Link 2008", 2, 24, 0.655, 0)))

.n160_fold <- function(rows, route, days = 7L) {
  vapply(rows, function(r) {
    v <- list(drug = "midazolam", doseMg = r[[2]], route = route)
    if (identical(route, "iv") && r[[5]] > 0) v$infusionH <- r[[5]]
    x <- .n160_run(v, list(drug = "rifampicin", doseMg = 600, doses = days, gapH = r[[3]]))
    c(pred = x$ratio, obs = r[[4]], fold = max(x$ratio / r[[4]], r[[4]] / x$ratio))
  }, numeric(3))
}

vcr_case("N160c", c("AC-08", "AC-30"), function() {
  # A labelled comparison with six published studies of oral midazolam after seven days of rifampicin 600 mg (the length of the course is the paper's
  # table's omission: the ratio changes by under 4% between 7 and 14 days, shown in the second line). The model was not fitted to these studies except Gorski 2003.
  m <- .n160_fold(.n160_clinical$oral, "oral")
  gm <- exp(mean(log(m["fold", ])))
  within2 <- sum(m["fold", ] <= 2)
  late <- .n160_run(list(drug = "midazolam", doseMg = 3, route = "oral"), list(drug = "rifampicin", doseMg = 600, doses = 14L, gapH = 8))$ratio
  early <- m["pred", 1]
  lo <- min(m["obs", ]); hi <- max(m["obs", ])
  # the model's predictions sit inside the observed range (the studies disagree with one another more than the model disagrees with their middle)
  list(pass = all(m["pred", ] >= lo & m["pred", ] <= hi) && gm < 2.5 && within2 >= 3L && abs(late / early - 1) < 0.04,
       detail = sprintf("oral midazolam after rifampicin 600 mg x 7 d: predicted ratios %s against observed %s (%d of 6 within 2-fold, geometric mean fold error %.2f; the observed ratios span %.3f to %.3f, the predictions %.3f to %.3f); Kharasch 2004 after 14 days instead of 7: %.4f against %.4f (%.1f%% apart). The model is held to the authors' own simulation (N160a), not to these studies: it over-predicts the two strongest inductions (Link 2008, Gorski 2003) by 2.5- and 6-fold",
                        paste(sprintf("%.3f", m["pred", ]), collapse = ", "), paste(sprintf("%.3f", m["obs", ]), collapse = ", "), within2, gm, lo, hi, min(m["pred", ]), max(m["pred", ]), late, early, 100 * abs(late / early - 1)))
})

vcr_case("N160d", c("AC-08", "AC-30"), function() {
  # The intravenous studies: hepatic induction only, so the ratio is less scattered between studies; the same labelled comparison.
  m <- .n160_fold(.n160_clinical$iv, "iv")
  gm <- exp(mean(log(m["fold", ])))
  list(pass = all(m["fold", ] <= 2) && gm < 1.6,
       detail = sprintf("intravenous midazolam after rifampicin 600 mg x 7 d: predicted ratios %s against observed %s (all within 2-fold, geometric mean fold error %.2f)",
                        paste(sprintf("%.3f", m["pred", ]), collapse = ", "), paste(sprintf("%.3f", m["obs", ]), collapse = ", "), gm))
})

vcr_case("N160e", c("AC-08", "AC-30"), function() {
  # the job's own structure: the result carries the measures and the curve, a victim or perpetrator outside the model is refused by the schema, and a
  # run without the perpetrator's effect (a dose 1e-300 times smaller than any induction) returns ratio 1 (induction is the only thing that moves it)
  jr <- vcr_test_run(vcr_test_job("pk.interaction", list(victim = list(drug = "midazolam", doseMg = 1, route = "iv"), perpetrator = list(drug = "rifampicin", doseMg = 1e-12, doses = 1L), horizonH = 12), NULL, job_id = "job_n160e"))
  bad <- vcr_test_run(vcr_test_job("pk.interaction", list(victim = list(drug = "midazolam", doseMg = 1), perpetrator = list(drug = "ketoconazole", doseMg = 200, doses = 3L)), NULL, job_id = "job_n160e2"))
  names_ok <- all(c("victim_auc_alone", "victim_auc_with_perpetrator", "auc_ratio", "victim_cmax_alone", "cmax_ratio", "cyp3a4_liver_activity", "cyp3a4_gut_activity") %in% vapply(jr$measures, function(m) m$name, character(1)))
  ratio <- vcr_measure_value(jr, "auc_ratio"); cmax_ratio <- vcr_measure_value(jr, "cmax_ratio")
  curve <- jr$diagnostics$pbpk$curve
  refused <- !identical(bad$status, "succeeded") && "scenario_value_invalid" %in% vcr_test_issue_codes(bad)
  list(pass = identical(jr$status, "succeeded") && names_ok && abs(ratio - 1) < 1e-6 && abs(cmax_ratio - 1) < 1e-6 && length(curve) >= 10L && refused &&
         length(jr$diagnostics$pbpk$assumed) >= 3L,
       detail = sprintf("a rifampicin dose of 1e-12 mg leaves the area ratio at %.8f and the peak ratio at %.8f; the curve has %d points; %d defaults are stated as assumptions; a perpetrator outside the model (ketoconazole) is refused by the schema (%s)",
                        ratio, cmax_ratio, length(curve), length(jr$diagnostics$pbpk$assumed), paste(vcr_test_issue_codes(bad), collapse = ", ")))
})
