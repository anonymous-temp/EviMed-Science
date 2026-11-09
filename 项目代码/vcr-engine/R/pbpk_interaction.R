# ---------------------------------------------------------------------------
# pbpk_interaction.R — pk.interaction: a published whole-body PBPK model of oral or intravenous midazolam with CYP3A4 induction by rifampicin
# (plan R38, round 2).
#
# Hidden knowledge:
#
# - **The model is Asaumi et al. 2018 as its authors' code states it, not a re-derivation.** Asaumi R, Toshimoto K, Tobe Y, Hashizume K, Nunoya K,
#   Imawaka H, Lee W, Sugiyama Y. CPT Pharmacometrics Syst Pharmacol 2018;7(3):186-196, doi 10.1002/psp4.12275: a rifampicin PBPK model with hepatic
#   uptake (a five-compartment dispersion liver) and enterocyte compartment, and a midazolam PBPK model that shares its physiology, with CYP3A4 (and
#   UGT) activity in the gut wall and liver following first-order turnover that rifampicin induces through an Emax function of the unbound
#   concentration in the cell. Every number below is a `[ PARAM ]` row of the published mrgsolve code of the Metrum Research Group's open vignette
#   (metrumresearchgroup/pbpk-qsp-mrgsolve, docs/models/rifampicin_midazolam.cpp), which states it was derived from the paper; the physiological values
#   of the paper's supplement (S1, S2) are in that code and nowhere else in open text. Nothing here is fitted, rounded or adapted: `.vcr_pbpk_params`
#   is the whole parameter set and RES-PBPK.md records where each row lives.
# - **The numbers that hold it to the publication are the vignette's own** (3 mg midazolam 12 h after 75 mg rifampicin daily for 7 days: 24.70 and
#   6.84 ng/mL*h over 10 h, and the dose-response of the same design). The paper prints no AUC ratio in its text (the fits are figures), so a
#   reproduction of "the published ratio" is a reproduction of the authors' code, and a comparison with a clinical study is a separate, labelled
#   thing (N160c).
# - **Weight is the one scaling input.** Every clearance, flow and volume is per kg; the code's default is 80 kg with the comment "not sure", the
#   paper's subjects are 60-80 kg adults. The engine says that weight is an assumption it took when the scenario did not state one.
# - **The solver is the engine's own implicit Runge-Kutta (Radau IIA, order 5) in base R**, with step doubling for the error. The liver
#   compartments turn over in seconds and the enzyme in days, so an explicit method would take 10^5 steps; the system is also written so that the
#   area under the midazolam curve is a state, not a quadrature of a sampled curve. `deSolve::lsoda` is the oracle in N160b (a test-only package).
# - **Doses are events**: the integration restarts at every dose and at the start and end of an infusion, so a discontinuity is never inside a step.
# - **What the model is not.** It is a typical healthy adult (no variability, no genotype, no disease), oral or intravenous midazolam given with
#   or after repeated oral rifampicin. It has no inhibitor and no other inducer: a perpetrator whose published model could not be written in full
#   from open text is not in the list (RES-PBPK.md says which and why), and a request for one is refused by name by the schema, never run on a guess.
# ---------------------------------------------------------------------------

.vcr_pbpk_params <- function() {
  list(
    # rifampicin: hepatic uptake and dispersion liver
    Rdif = 0.129, beta = 0.2, gamma = 0.778, Km_u_uptake = 0.146, SFKp = 6.65, mSFKp = 0.201,
    # induction of UGT and CYP3A4 (Emax, EC50 of the unbound concentration in ug/mL), turnover (per h) and fraction of clearance by the enzyme
    Emax_UGT_RIF = 1.34, EC50_u_UGT_RIF = 0.0526, kdeg_UGT_liver = 0.0158, kdeg_UGT_ent = 0.0288, fm_UGT_liver = 0.759, fm_UGT_ent = 0.759,
    Emax_CYP3A4_RIF = 4.57, EC50_u_CYP3A4_RIF = 0.0526, kdeg_CYP3A4_liver = 0.0158, kdeg_CYP3A4_ent = 0.0288, fm_CYP3A4_liver = 0.93, fm_CYP3A4_ent = 1.00,
    mCLperm_gut_kg = 0.151,
    fB = 0.0778, mfB = 0.0545, fH = 0.0814, fE = 0.115, Fa = 1.000, mFa = 1.000, Fg = 0.943,
    Kp_skin = 0.326, Kp_muscle = 0.0947, Kp_adipose = 0.0629, Kp_serosa = 0.200,
    mKp_liver = 6.96, mKp_muscle = 4.00, mKp_skin = 20.4, mKp_adipose = 34.4,
    fBCLint_all_kg = 0.251, mfBCLint_kg = 0.469, mfECLint_E_kg = 0.107, PSdif_E_kg = 0.161, CLrenal_kg = 0.011, mCLrenal = 0.000,
    Qvilli_kg = 0.257, Qh_kg = 1.240, Qmuscle_kg = 0.642, Qskin_kg = 0.257, Qadipose_kg = 0.223, Qserosa_kg = 0.274, Qportal_kg = 0.531,
    VHE_kg = 0.0067, VHC_kg = 0.0174, Vcentral_kg = 0.0743, mVcentral_kg = 0.571, Vskin_kg = 0.111, Vadipose_kg = 0.143, Vmuscle_kg = 0.429,
    Vserosa_kg = 0.00893, Vent_kg = 0.00739, Vmucblood_kg = 0.00099, Vportal_kg = 0.001,
    ka = 37.6, mka = 1.29
  )
}

# The state vector, in the published code's order (the area under the midazolam curve last).
.vcr_pbpk_states <- c(
  "Xgutlumen", "central", "Cmuscle", "Cskin", "Cadipose", "Cserosa", "Cmucblood", "Cent",
  paste0("CHE", 1:5), paste0("CHC", 1:5),
  paste0("UGT_HC", 1:5), "UGT_ent", paste0("CYP_HC", 1:5), "CYP_ent",
  "Mgutlumen", "mcentral", "mCmuscle", "mCskin", "mCadipose", paste0("CLIV", 1:5), "Cportal",
  "AUC"
)

#' The right-hand side as a closure over the constants of one person (weight). `inf_rate` is a midazolam infusion into the central compartment
#' (mg/h), constant within a segment.
.vcr_pbpk_rhs <- function(P, WT) {
  with(P, {
    CLint_all <- fBCLint_all_kg * WT / fB
    mfBCLint <- mfBCLint_kg * WT; mCLperm_gut <- mCLperm_gut_kg * WT; mfECLint_E <- mfECLint_E_kg * WT
    CLrenal <- CLrenal_kg * WT; PSdif_E <- PSdif_E_kg * WT
    Qvilli <- Qvilli_kg * WT; Qh <- Qh_kg * WT; Qmuscle <- Qmuscle_kg * WT; Qskin <- Qskin_kg * WT; Qadipose <- Qadipose_kg * WT
    Qserosa <- Qserosa_kg * WT; Qhart <- Qh - Qserosa - Qvilli; Qportal <- Qportal_kg * WT
    VHE <- VHE_kg * WT; VHC <- VHC_kg * WT; Vcentral <- Vcentral_kg * WT; Vskin <- Vskin_kg * WT; Vadipose <- Vadipose_kg * WT
    Vmuscle <- Vmuscle_kg * WT; Vserosa <- Vserosa_kg * WT; Vent <- Vent_kg * WT; Vmucblood <- Vmucblood_kg * WT
    mVcentral <- mVcentral_kg * WT; Vportal <- Vportal_kg * WT
    Vmax_uptake <- 1.0 / (1 + Rdif) * CLint_all / beta * Km_u_uptake
    PSdif_inf <- Rdif / (1 + Rdif) * CLint_all / beta
    PSdif_eff <- Rdif / (1 + Rdif) * CLint_all / beta / gamma
    CLint <- Rdif / (1 + Rdif) * CLint_all / (1 - beta) / gamma
    Qgut <- fE * PSdif_E * Qvilli / (Qvilli + fB * PSdif_E)
    mQgut <- Qvilli * mCLperm_gut / (Qvilli + mCLperm_gut)
    CLint_E <- (Qgut * (1.0 / Fg - 1.0) - (1.0 - Fa) * fE * PSdif_E * 20.0) / fE
    iX <- 1L; iC <- 2L; iMu <- 3L; iSk <- 4L; iAd <- 5L; iSe <- 6L; iMb <- 7L; iEn <- 8L
    iHE <- 9:13; iHC <- 14:18; iUG <- 19:23; iUGe <- 24L; iCY <- 25:29; iCYe <- 30L
    iMg <- 31L; iMc <- 32L; iMmu <- 33L; iMsk <- 34L; iMad <- 35L; iCL <- 36:40; iPo <- 41L; iAUC <- 42L
    function(t, y, inf_rate = 0) {
      central <- y[iC]; Ccentral <- central / Vcentral
      Cmuscle <- y[iMu]; Cskin <- y[iSk]; Cadipose <- y[iAd]; Cserosa <- y[iSe]; Cmucblood <- y[iMb]; Cent <- y[iEn]
      CHE <- y[iHE]; CHC <- y[iHC]; UGT <- y[iUG]; UGTe <- y[iUGe]; CYP <- y[iCY]; CYPe <- y[iCYe]
      mcentral <- y[iMc]; mCcentral <- mcentral / mVcentral
      CLIV <- y[iCL]; Cportal <- y[iPo]
      d <- numeric(42L)
      d[iC] <- Qh * CHE[5] - Qhart * Ccentral - Qserosa * Ccentral - Qvilli * Ccentral - CLrenal * Ccentral +
        Qmuscle * (Cmuscle / (SFKp * Kp_muscle) - Ccentral) + Qskin * (Cskin / (SFKp * Kp_skin) - Ccentral) +
        Qadipose * (Cadipose / (SFKp * Kp_adipose) - Ccentral)
      d[iMu] <- (1.0 / Vmuscle) * Qmuscle * (Ccentral - Cmuscle / (SFKp * Kp_muscle))
      d[iSk] <- (1.0 / Vskin) * Qskin * (Ccentral - Cskin / (SFKp * Kp_skin))
      d[iAd] <- (1.0 / Vadipose) * Qadipose * (Ccentral - Cadipose / (SFKp * Kp_adipose))
      d[iSe] <- (1.0 / Vserosa) * Qserosa * (Ccentral - Cserosa / (SFKp * Kp_serosa))
      d[iMb] <- (Qvilli * (Ccentral - Cmucblood) + fE * PSdif_E * Cent - fB * PSdif_E * Cmucblood) * (1 / Vmucblood)
      d[iX] <- -ka / Fa * y[iX] + fE * PSdif_E * 20 * Cent
      d[iEn] <- (ka * y[iX] + fB * PSdif_E * Cmucblood -
                   fE * (PSdif_E * 21 + CLint_E * (1 + fm_UGT_ent * (UGTe - 1))) * Cent) * (1 / Vent)
      d[iUG] <- kdeg_UGT_liver * (1 + Emax_UGT_RIF * fH * CHC / (fH * CHC + EC50_u_UGT_RIF) - UGT)
      d[iUGe] <- kdeg_UGT_ent * (1 + Emax_UGT_RIF * fE * Cent / (fE * Cent + EC50_u_UGT_RIF) - UGTe)
      uptake <- fB * (Vmax_uptake / (Km_u_uptake + fB * CHE) + PSdif_inf) * CHE
      upstream <- c(Qhart * Ccentral + Qvilli * Cmucblood + Qserosa * Cserosa / (SFKp * Kp_serosa) - Qh * CHE[1], Qh * (CHE[1:4] - CHE[2:5]))
      d[iHE] <- (upstream + (fH * PSdif_eff * CHC - uptake) / 5.0) * (5.0 / VHE)
      d[iHC] <- (5.0 / VHC) * (uptake - fH * PSdif_eff * CHC - fH * CLint * (1 + fm_UGT_liver * (UGT - 1)) * CHC) / 5.0
      # midazolam
      d[iMc] <- Qh * (CLIV[5] / (mSFKp * mKp_liver)) - (Qh - Qportal) * mCcentral +
        Qmuscle * (y[iMmu] / (mSFKp * mKp_muscle) - mCcentral) + Qskin * (y[iMsk] / (mSFKp * mKp_skin) - mCcentral) +
        Qadipose * (y[iMad] / (mSFKp * mKp_adipose) - mCcentral) - Qportal * mCcentral - mCLrenal * mCcentral + inf_rate
      d[iCY] <- kdeg_CYP3A4_liver * (1 + Emax_CYP3A4_RIF * fH * CHC / (fH * CHC + EC50_u_CYP3A4_RIF) - CYP)
      d[iCYe] <- kdeg_CYP3A4_ent * (1 + Emax_CYP3A4_RIF * fE * Cent / (fE * Cent + EC50_u_CYP3A4_RIF) - CYPe)
      elim <- mfBCLint * (1 + fm_CYP3A4_liver * (CYP - 1)) / 5
      d[iCL[1]] <- ((Qh - Qportal) * mCcentral + Qportal * Cportal - Qh * CLIV[1] / (mSFKp * mKp_liver) -
                      elim[1] * CLIV[1] / (mSFKp * mKp_liver)) * (5 / (VHE + VHC))
      d[iCL[2:5]] <- (Qh * (CLIV[1:4] - CLIV[2:5]) - elim[2:5] * CLIV[2:5]) / (mSFKp * mKp_liver) * (5 / (VHE + VHC))
      d[iPo] <- (Qportal * (mCcentral - Cportal) +
                   mka * mQgut / (mQgut + mfECLint_E * (1 + fm_CYP3A4_ent * (CYPe - 1))) * y[iMg]) * (1 / Vportal)
      d[iMmu] <- (1 / Vmuscle) * Qmuscle * (mCcentral - y[iMmu] / (mSFKp * mKp_muscle))
      d[iMsk] <- (1 / Vskin) * Qskin * (mCcentral - y[iMsk] / (mSFKp * mKp_skin))
      d[iMad] <- (1 / Vadipose) * Qadipose * (mCcentral - y[iMad] / (mSFKp * mKp_adipose))
      d[iMg] <- -mka / mFa * y[iMg]
      d[iAUC] <- mCcentral
      d
    }
  })
}

#' Initial state: the enzyme ratios are 1, everything else 0.
.vcr_pbpk_init <- function() {
  y <- numeric(length(.vcr_pbpk_states)); names(y) <- .vcr_pbpk_states
  y[c(paste0("UGT_HC", 1:5), "UGT_ent", paste0("CYP_HC", 1:5), "CYP_ent")] <- 1
  y
}

# --- Radau IIA (order 5), simplified-Newton free: a full Newton on the stage values with a finite-difference Jacobian -------------------------

.vcr_radau_coef <- local({
  s6 <- sqrt(6)
  list(c = c((4 - s6) / 10, (4 + s6) / 10, 1),
       A = matrix(c((88 - 7 * s6) / 360, (296 - 169 * s6) / 1800, (-2 + 3 * s6) / 225,
                    (296 + 169 * s6) / 1800, (88 + 7 * s6) / 360, (-2 - 3 * s6) / 225,
                    (16 - s6) / 36, (16 + s6) / 36, 1 / 9), 3, 3, byrow = TRUE))
})

.vcr_fd_jacobian <- function(f, t, y, f0) {
  n <- length(y); J <- matrix(0, n, n)
  for (j in seq_len(n)) {
    h <- sqrt(.Machine$double.eps) * max(1, abs(y[j]))
    yj <- y; yj[j] <- yj[j] + h
    J[, j] <- (f(t, yj) - f0) / h
  }
  J
}

#' One Radau IIA step of size `h` from (t, y). Returns the new state, or NULL when Newton did not converge.
.vcr_radau_inverse <- function(h, J) {
  n <- nrow(J)
  tryCatch(solve(diag(3L * n) - h * kronecker(.vcr_radau_coef$A, J)), error = function(e) NULL)
}

.vcr_radau_step <- function(f, t, y, h, Mi) {
  K <- .vcr_radau_coef; n <- length(y)
  if (is.null(Mi)) return(NULL)
  Z <- matrix(0, n, 3L)                       # stage increments from y
  for (it in 1:20) {
    F <- vapply(1:3, function(i) f(t + K$c[i] * h, y + Z[, i]), numeric(n))
    G <- Z - h * (F %*% t(K$A))               # Z_i - h sum_j a_ij F_j
    dz <- -as.vector(Mi %*% as.vector(G))
    Z <- Z + matrix(dz, n, 3L)
    if (max(abs(dz) / (1e-13 + 1e-11 * rep(abs(y), 3L))) < 1 || max(abs(dz)) < 1e-16) { converged <- TRUE; break }
    converged <- FALSE
  }
  if (!converged) return(NULL)
  y + Z[, 3L]
}

#' Integrate from t0 to t1 (no event inside): adaptive steps by step doubling. `rtol`/`atol` are per component.
.vcr_radau_segment <- function(f, y, t0, t1, rtol = 1e-6, atol = 1e-9, h0 = NULL, max_steps = 200000L) {
  t <- t0; h <- h0 %||% min(1e-3, t1 - t0); steps <- 0L; accepted <- 0L
  while (t1 - t > 1e-13 * max(1, abs(t1))) {
    if (steps > max_steps) stop("the PBPK solver took more steps than it is allowed")
    h <- min(h, t1 - t)
    f0 <- f(t, y); J <- .vcr_fd_jacobian(f, t, y, f0)
    Mh <- .vcr_radau_inverse(h, J); Mh2 <- .vcr_radau_inverse(h / 2, J)
    big <- .vcr_radau_step(f, t, y, h, Mh)
    half <- if (!is.null(big)) .vcr_radau_step(f, t, y, h / 2, Mh2) else NULL
    two <- if (!is.null(half)) .vcr_radau_step(f, t + h / 2, half, h / 2, Mh2) else NULL
    if (is.null(big) || is.null(two)) { h <- h / 4; steps <- steps + 1L; next }
    err <- max(abs(two - big) / (atol + rtol * pmax(abs(two), abs(y))))
    if (err <= 1) {
      y <- two + (two - big) / 31               # Richardson: the order-5 pair has a local error of h^6, 2^5 - 1 = 31
      t <- t + h; steps <- steps + 1L; accepted <- accepted + 1L
    } else steps <- steps + 1L
    h <- h * min(5, max(0.2, 0.9 * (1 / max(err, 1e-10))^(1 / 6)))
  }
  attr(y, "h") <- h; attr(y, "steps") <- steps
  y
}

#' Run an event list: `events` is a data frame of time, state index (or NA), amount (mg), and `infusions` a list of (start, end, rate). Returns the state at each of `t_out`
#' (sorted, including the times the caller wants the curve at), integrating through every dose.
.vcr_pbpk_integrate <- function(f, y0, events, infusions, t_out, rtol = 1e-6, atol = 1e-9, states = .vcr_pbpk_states) {
  marks <- sort(unique(c(0, events$time, unlist(lapply(infusions, function(i) c(i$start, i$end))), t_out)))
  y <- y0; out <- list(); t <- 0; h <- NULL
  ev_idx <- seq_len(nrow(events))
  for (k in seq_along(marks)) {
    tm <- marks[k]
    reason <- if (exists("vcr_interrupt", mode = "function")) vcr_interrupt() else NULL
    if (!is.null(reason)) stop(structure(class = c("vcr_pbpk_interrupted", "error", "condition"), list(message = reason, call = NULL)))
    if (tm > t) {
      rate <- sum(vapply(infusions, function(i) if (i$start <= t + 1e-12 && i$end >= tm - 1e-12) i$rate else 0, numeric(1)))
      g <- if (rate == 0) f else function(tt, yy) f(tt, yy, inf_rate = rate)
      y <- .vcr_radau_segment(g, y, t, tm, rtol = rtol, atol = atol, h0 = if (is.null(h)) NULL else min(h, tm - t))
      h <- attr(y, "h"); attributes(y) <- list(names = states)
      t <- tm
    }
    for (e in ev_idx[abs(events$time - tm) < 1e-12]) { y[events$state[e]] <- y[events$state[e]] + events$amount[e]; h <- NULL }
    if (any(abs(t_out - tm) < 1e-12)) out[[length(out) + 1L]] <- c(time = tm, y)
  }
  do.call(rbind, out)
}

# --- the scenario ------------------------------------------------------------------------------------------------------------------------------

.vcr_pbpk_i <- function(name) match(name, .vcr_pbpk_states)

#' One interaction: the victim given alone and after the perpetrator's repeated doses. Returns the curves and the summary numbers.
vcr_pbpk_interaction <- function(victim, perpetrator, weight, horizon, grid = NULL, P = .vcr_pbpk_params(), rtol = 1e-6, atol = 1e-9) {
  f <- .vcr_pbpk_rhs(P, weight)
  mc_vol <- P$mVcentral_kg * weight
  y0 <- .vcr_pbpk_init()
  n_p <- as.integer(perpetrator$doses); interval <- perpetrator$intervalH
  t_v <- (n_p - 1L) * interval + perpetrator$gapH
  rif_events <- data.frame(time = (seq_len(n_p) - 1L) * interval, state = .vcr_pbpk_i("Xgutlumen"), amount = perpetrator$doseMg)
  v_state <- .vcr_pbpk_i(if (identical(victim$route, "oral")) "Mgutlumen" else "mcentral")
  inf_h <- victim$infusionH %||% 0
  mdz_event <- function(t0) if (identical(victim$route, "iv") && inf_h > 0) NULL else data.frame(time = t0, state = v_state, amount = victim$doseMg)
  mdz_inf <- function(t0) if (identical(victim$route, "iv") && inf_h > 0) list(list(start = t0, end = t0 + inf_h, rate = victim$doseMg / inf_h)) else list()
  rel <- if (is.null(grid)) sort(unique(c(pmin(c(0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48, 72, 96), horizon), horizon))) else unique(c(seq(0, horizon, by = grid), horizon))
  run <- function(t0, with_perp) {
    ev <- rbind(if (with_perp) rif_events, mdz_event(t0), data.frame(time = numeric(), state = integer(), amount = numeric()))
    ev <- ev[order(ev$time), , drop = FALSE]
    t_out <- sort(unique(c(t0, t0 + rel)))
    if (with_perp) t_out <- sort(unique(c(t_out, rif_events$time)))
    m <- .vcr_pbpk_integrate(f, y0, ev, mdz_inf(t0), t_out, rtol, atol)
    m
  }
  alone <- run(0, FALSE); with_p <- run(t_v, TRUE)
  pick <- function(m, t0) {
    r <- m[abs(m[, "time"] - t0) < 1e-9, ]
    base <- r["AUC"]
    m2 <- m[m[, "time"] >= t0 - 1e-9, , drop = FALSE]
    list(time = m2[, "time"] - t0, conc = 1000 * m2[, "mcentral"] / mc_vol, auc = 1000 * (m2[nrow(m2), "AUC"] - base),
         cyp_liver = m2[1, "CYP_HC5"], cyp_gut = m2[1, "CYP_ent"], m2 = m2)
  }
  # Cmax: the largest sampled concentration, refined between its two neighbours (an oral peak lies between sample times)
  peak <- function(res, t0) {
    k <- which.max(res$conc)
    if (k == 1L || k == length(res$conc) || identical(victim$route, "iv")) return(max(res$conc))
    m2 <- res$m2; start <- m2[k - 1L, ]
    at <- function(tt) {
      yy <- .vcr_radau_segment(f, start[-1], start[1], tt, rtol = rtol, atol = atol)
      1000 * yy[["mcentral"]] / mc_vol
    }
    o <- stats::optimize(at, c(m2[k - 1L, 1], m2[k + 1L, 1]), maximum = TRUE, tol = 1e-4)
    max(res$conc[k], o$objective)
  }
  a <- pick(alone, 0); w <- pick(with_p, t_v)
  a$cmax <- peak(a, 0); w$cmax <- peak(w, t_v)
  # the area is the state at the end of the window less the state at the dose: ng/mL*h (mg/L x 1000)
  list(rel_time = a$time, alone = a$conc, with = w$conc, auc_alone = a$auc, auc_with = w$auc,
       cmax_alone = a$cmax, cmax_with = w$cmax, cyp_liver = w$cyp_liver, cyp_gut = w$cyp_gut,
       rif = with_p[with_p[, "time"] <= t_v + 1e-9, c("time", "central")], weight = weight, victimTime = t_v)
}

# --- the job -----------------------------------------------------------------------------------------------------------------------------------

#' The method's citation, as the result words it (the page shows it as the model's source).
.vcr_pbpk_citation <- paste0(
  "Asaumi R, Toshimoto K, Tobe Y, Hashizume K, Nunoya K, Imawaka H, Lee W, Sugiyama Y. Comprehensive PBPK model of rifampicin for quantitative prediction of ",
  "complex drug-drug interactions: CYP3A/2C9 induction and OATP inhibition effects. CPT Pharmacometrics Syst Pharmacol 2018;7(3):186-196 ",
  "(doi 10.1002/psp4.12275); parameters and equations as published in the open mrgsolve code of the Metrum Research Group.")

vcr_job_pk_interaction <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  assumed <- list()
  note <- function(key, value, basis) assumed[[length(assumed) + 1L]] <<- list(key = key, value = value, basis = basis)
  v <- sc$victim; pp <- sc$perpetrator
  inhibitor <- identical(as.character(pp$drug), "ketoconazole")
  mbi <- identical(as.character(pp$drug), "clarithromycin")
  route <- as.character(v$route %||% "oral")
  if (is.null(v$route)) note("victim.route", "oral", "the usual way midazolam is given in an interaction study")
  weight <- vcr_scalar(sc$weightKg, 80)
  if (is.null(sc$weightKg) && !inhibitor && !mbi) note("weightKg", 80, "the body weight of the published code (every clearance, flow and volume of the model is per kilogram)")
  horizon <- vcr_scalar(sc$horizonH, 48)
  if (is.null(sc$horizonH)) note("horizonH", 48, "long enough for the area under the curve to be complete: midazolam's half-life is a few hours")
  interval <- vcr_scalar(pp$intervalH, 24)
  if (is.null(pp$intervalH)) note("perpetrator.intervalH", 24, "once a day")
  gap <- vcr_scalar(pp$gapH, 12)
  if (is.null(pp$gapH)) note("perpetrator.gapH", 12, "midazolam is given 12 hours after the last dose of the perpetrator")
  victim <- list(drug = as.character(v$drug), doseMg = as.numeric(v$doseMg), route = route)
  if (identical(route, "iv") && !is.null(v$infusionH)) victim$infusionH <- vcr_scalar(v$infusionH)
  perp <- list(drug = as.character(pp$drug), doseMg = as.numeric(pp$doseMg), intervalH = interval, doses = as.integer(pp$doses), gapH = gap)
  inhibition <- if (inhibitor) as.character(pp$inhibition %||% "mixed") else NULL
  mbi_set <- if (mbi) as.character(pp$inactivationSet %||% "polasek_hlm") else NULL
  if (mbi && is.null(pp$inactivationSet)) note("perpetrator.inactivationSet", "polasek_hlm", "the median of the three human-liver-microsome sets of the paper's Table 2, fixed before any prediction was run")
  if (mbi && !is.null(sc$weightKg)) note("weightKg", "not used", "the published structure has fixed volumes and flows for a typical adult and no body-weight scaling")
  if (inhibitor && is.null(pp$inhibition)) note("perpetrator.inhibition", "mixed", "the model of the three that the paper found to fit the in-vitro data best")
  if (inhibitor && !is.null(sc$weightKg)) note("weightKg", "not used", "the published model has fixed volumes and flows for a typical adult and no body-weight scaling")
  run <- tryCatch(if (mbi) vcr_pbpk_mbi(victim, perp, mbi_set, horizon) else if (inhibitor) vcr_pbpk_inhibition(victim, perp, inhibition, horizon) else vcr_pbpk_interaction(victim, perp, weight, horizon),
                  vcr_pbpk_interrupted = function(e) e)
  if (inherits(run, "vcr_pbpk_interrupted")) {
    if (identical(conditionMessage(run), "canceled")) return(list(status = "canceled", measures = list(), counts = vcr_counts(realPatients = NULL, generatedRecords = 0), diagnostics = list(interrupted = "canceled during the simulation")))
    return(list(status = "failed", measures = list(), counts = vcr_counts(realPatients = NULL, generatedRecords = 0), diagnostics = list(),
                issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the simulation finished."))))
  }
  # What the authors fitted (Asaumi et al. 2018, Table 1 and the text): rifampicin 5, 10, 25, 75 mg (Kharasch 2011, midazolam 3 mg by mouth, 1 mg i.v.) and
  # 600 mg (Gorski 2003, midazolam 4 and 6 mg by mouth, 0.05 mg/kg i.v.). A request outside that runs; the result says so and the page says it as a premise.
  fitted_rif <- c(5, 600); fitted_dose <- if (identical(route, "oral")) c(3, 6) else c(1, 0.05 * weight)
  outside_fit <- if (inhibitor) {
    # Quinney et al. 2013 Table 4 is the one validation of the inhibitor model in its own paper: 200 mg daily for six days, midazolam 1 mg intravenously
    c(if (!isTRUE(all.equal(perp$doseMg, 200))) "perpetrator_dose", if (identical(route, "oral")) "victim_route" else if (!isTRUE(all.equal(victim$doseMg, 1))) "victim_dose")
  } else if (mbi) {
    # the predictions were compared with studies of clarithromycin 250 and 500 mg twice daily (N185d); any other dose is the structure extrapolated
    c(if (!perp$doseMg %in% c(250, 500)) "perpetrator_dose")
  } else c(if (perp$doseMg < fitted_rif[1] || perp$doseMg > fitted_rif[2]) "perpetrator_dose",
           if (victim$doseMg < min(fitted_dose) - 1e-9 || victim$doseMg > max(fitted_dose) + 1e-9) "victim_dose")
  ratio <- run$auc_with / run$auc_alone
  measures <- list(
    vcr_measure("victim_auc_alone", run$auc_alone, unit = "ng/mL*h", source = "calculated"),
    vcr_measure("victim_auc_with_perpetrator", run$auc_with, unit = "ng/mL*h", source = "calculated"),
    vcr_measure("auc_ratio", ratio, source = "calculated"),
    vcr_measure("victim_cmax_alone", run$cmax_alone, unit = "ng/mL", source = "calculated"),
    vcr_measure("victim_cmax_with_perpetrator", run$cmax_with, unit = "ng/mL", source = "calculated"),
    vcr_measure("cmax_ratio", run$cmax_with / run$cmax_alone, source = "calculated"),
    if (!inhibitor) vcr_measure("cyp3a4_liver_activity", run$cyp_liver, source = "calculated"),
    if (!inhibitor) vcr_measure("cyp3a4_gut_activity", run$cyp_gut, source = "calculated"))
  measures <- Filter(Negate(is.null), measures)
  curve <- lapply(seq_along(run$rel_time), function(i) list(hour = run$rel_time[i], alone = run$alone[i], withPerpetrator = run$with[i]))
  list(status = "succeeded", measures = measures, counts = vcr_counts(realPatients = NULL, generatedRecords = 0),
       diagnostics = list(pbpk = list(
         # clarithromycin: the perpetrator's own exposure over its last dosing interval, and the clinical value for the regimen it was compared with (500 mg every 12 h, a healthy-subject
         # study, clarithromycin alone, n = 23: Css,max 2327 ug/L, AUCtau 15924 ug*h/L; PMC10333645), so the page can say how far the assembled perpetrator's own exposure is from it
         perpetrator = if (mbi) c(run$perp_exposure, if (identical(perp$doseMg, 500) && identical(perp$intervalH, 12)) list(observedCmaxUgL = 2327, observedAucTauUgHL = 15924)),
         given = list(label = sc$label, victim = victim, perpetrator = c(perp, if (inhibitor) list(inhibition = inhibition), if (mbi) list(inactivationSet = mbi_set)), weightKg = if (inhibitor || mbi) NULL else weight, horizonH = horizon),
         model = list(citation = if (mbi) .vcr_mbi_citation else if (inhibitor) .vcr_inhib_citation else .vcr_pbpk_citation, mechanism = if (mbi) "inactivation" else if (inhibitor) "inhibition" else "induction",
                      population = "a typical healthy adult: no between-person variability, genotype or disease",
                      victimStartsAtHour = run$victimTime, outsideFit = as.list(outside_fit)),
         curve = curve, assumed = assumed)))
}
