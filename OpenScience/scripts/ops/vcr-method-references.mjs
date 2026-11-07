/**
 * Which numeric acceptance case holds which engine method to a reference that is
 * not the method's own code, and the rule that every dispatched method has one.
 *
 * Hidden knowledge:
 *
 * - **The evidence a deployment reads is built from this table, and a method with
 *   no entry used to read "unmeasured" without anyone being told.** The deployed
 *   evidence file covered 12 of the 24 methods because only 15 cases were listed
 *   here; the other twelve methods had cases that compare against an independent
 *   computation (a truth table, a closed form, an integral, a regression on the
 *   output) and nobody had written them down. Nothing failed: `produceMethodValidation`
 *   emitted a row for every method that had an entry and silently left out the rest.
 * - **The list of methods is not written here.** It is the engine's dispatch: the
 *   methods of `R/domain-snapshot.json`, which the engine's own start-up check holds
 *   equal to its handler table (`vcr_engine_self_check`). `methodsWithoutReference`
 *   answers for whatever that registry says, so a method added later (this stream's
 *   three, the comparator-effect stream's four) fails the generator and the CI step
 *   `scripts/vcr/check-method-references.mjs` until it has a reference case, instead
 *   of reading "unmeasured" in the module.
 * - **An entry is reviewed text, not a guess.** Each names the case, the methods
 *   that case holds to its reference (a case may run others only incidentally) and
 *   the anchors: literal lines of the case body that show the comparison is there
 *   (the independent reference named, the comparison written). An anchor that is no
 *   longer in the case fails the generator (`numeric_reference_missing`): a case that
 *   was rewritten has to be reviewed again before it speaks for a method.
 * - **An entry for a case this tree does not have is inert.** The comparator-effect
 *   methods' cases (N33a, N34a/b, N35a, N36a) are listed so that merging that stream
 *   needs no edit here; until the cases exist the entries do nothing, and the
 *   completeness check, which only counts entries whose case exists, still fails
 *   a registry that has their methods without their cases.
 *
 * No dependency: Node's own modules only (the CI job that checks this has no
 * `pnpm install`).
 *
 * @module vcr-method-references
 */

const requireValue = (ok, code) => { if (!ok) throw new Error(code); };

/**
 * @typedef {{ methods: string[], anchors: string[] }} MethodReference
 * @type {Record<string, MethodReference>}
 */
export const REQUIRED_CURRENT_REFERENCES = {
  'design.analytic': ['N53a', 'N53c', 'N53e'],
  'model.survival_fit': ['N52a', 'N52b', 'N52k'],
  'model.prognostic_apply': ['N52d'],
};
export const NUMERIC_REFERENCES = {
  N53e: { methods: ['design.analytic'], anchors: ['Independently integrate arm event probabilities', 'abs(at$y-checked)<1e-10'] },
  N60a: { methods: ['model.prognostic_apply'], anchors: ['full <- stats::optim(c(0, 1), nll, method = "BFGS", hessian = TRUE', 'abs(cal[["intercept"]]$value - off$par) < 2e-5'] },
  N57a: { methods: ['population.check'], anchors: ['smd_age <- (g_age$mean - 61.5) / 10', 'abs(row("age")$standardizedDifference - smd_age) < 1e-12'] },
  N52b: { methods: ['model.survival_fit'], anchors: ['Independent likelihood optimized from base-R density/survival functions', 'reference$convergence != 0', 'all(errors < 2e-4)'] },
  N52k: { methods: ['model.survival_fit'], anchors: ['Mandatory locked flexsurv oracle: transformations, median, survival, AIC and delta spread.', 'flexsurv::flexsurvreg', 'numDeriv::grad', 'all(errors < 2e-3)'] },
  N53a: { methods: ['design.analytic'], anchors: ['Reference: noncentral t, not the normal quantiles', 'abs(basis$powerAtAllocatedN - exact_t) < 1e-12'] },
  N53c: { methods: ['design.analytic'], anchors: ['Independent pooled-null / alternative-variance normal formula.', 'vcr_measure_value(r,"required_total")==nt+nc'] },
  N52a: { methods: ['model.survival_fit'], anchors: ['Censored exponential MLE: events / total time at risk.', 'delta < 1e-8'] },
  N52d: { methods: ['model.prognostic_apply'], anchors: ['mean(1 - 0.8^exp(c(-0.5,0.5)))', 'delta < 1e-12'] },
  // --- the first fifteen: reviewed against a numerical comparison in the case body ---
  N01b: { methods: ['design.analytic'], anchors: ['rpact::getDesignGroupSequential(', 'd_rp < 1e-4 && d_g4 < 1e-4'] },
  N06b: { methods: ['design.analytic'], anchors: ['Required patients (Lachin-Foulkes) against rpact', 'rpact::getSampleSizeSurvival(', 'abs(r$events - r$want_events) < 1e-3'] },
  N06c: { methods: ['design.analytic'], anchors: ["Simon (1989)'s published designs", 'all(a$opt == c(1, 10, 5, 29))'] },
  N06f: { methods: ['design.analytic'], anchors: ['References that share no code with the engine', 'x$d_ref < 1e-8 && x$z_mc < 4.5'] },
  N09c: { methods: ['comparator.entropy_balance', 'comparator.propensity_weight'], anchors: ['against WeightIt and', 'abs(est$value - att_wi) / abs(att_wi) < 1e-6', 'abs(est_p$value - att_pw) / abs(att_pw) < 1e-6'] },
  N11b: { methods: ['comparator.rmst'], anchors: ['against survRM2', 'abs(est$value - ref_est) < 1e-9'] },
  N12: { methods: ['comparator.evalue'], anchors: ['against the EValue package', 'g$d < 1e-6'] },
  N14b: { methods: ['comparator.maic'], anchors: ['one binary covariate at', 'abs(ess - 450^2 / 787.5) < 1e-6'] },
  N14e: { methods: ['comparator.maic'], anchors: ['ESS = (sum w)^2 / sum w^2 -- no code of the engine', 'abs(ess_job - ess_ref) / ess_ref < 1e-6'] },
  N17b: { methods: ['evidence.reconstruct_km'], anchors: ['Cox on the original rows', 'abs(lhr_rec - lhr_true) <= 0.05'] },
  N21b: { methods: ['comparator.map_prior'], anchors: ['against independent references', 'abs(vcr_measure_value(r, "map_mean") - pm) < 1e-4', 'abs(vcr_measure_value(r, "map_effective_sample_size_elir") - rb_elir) < 1e-3'] },
  N21c: { methods: ['comparator.map_prior'], anchors: ['edges[i], edges[i + 1L], rel.tol = 1e-12', 'ok_rows <- all(vapply(rows, function(x) x$ok, logical(1)))'] },
  N22b: { methods: ['design.procova'], anchors: ['N = (z_a + z_b)^2 (s1^2/p + s0^2/(1-p)) / delta^2', 'abs(g(full, "variance_ratio") - want_full / want_unadj) < 1e-12'] },
  N27a: { methods: ['accrual.poisson_gamma'], anchors: ['10/50/90% = 16.20 / 20.13 / 25.30 months', 'abs(m$value - 20.13) < 0.01'] },
  N27b: { methods: ['accrual.poisson_gamma'], anchors: ['INDEPENDENT constructions that use no accrual code', 'all(abs(z1[c("median")]) <= 3)'] },
  N27c: { methods: ['accrual.poisson_gamma'], anchors: ['an independent gamma construction', 'abs(z_med) <= 3 && abs(z_ev) <= 3.5'] },
  N27f: { methods: ['accrual.poisson_gamma'], anchors: ["by convolving the sites' binomials", 'abs(z_b) <= 3.5'] },
  N27d: { methods: ['evidence.pool'], anchors: ['Against metafor to 1e-8', 'r$d < r$tol'] },
  N31b: { methods: ['design.simulate'], anchors: ['Independent full joint binomial table', 'abs(m$value-ref[i]) <= 3*m$mcse'] },

  // --- the twelve methods that had no entry (2026-10-04): a case that compares against something outside the method ---
  // cohort.build: the waterfall, the impact of each rule and the sizes against counts made from the table with plain logic
  N25b: { methods: ['cohort.build'], anchors: ['The waterfall equals an independent count', 'ok_wf <- s1$kept == sum(a)'] },
  // population.scenario: declared marginals and correlations against truncated-normal moments and a Gauss-Hermite integral
  'C2-02': { methods: ['population.scenario'], anchors: ['Recover the declared marginals and correlations from N = 20,000 draws', 'all(ratios <= 4)'] },
  // population.literature: every moment of a published table against closed forms, in Monte-Carlo errors
  N28a: { methods: ['population.literature'], anchors: ['with every moment recovered from', 'all(abs(z) <= 4)'] },
  // patients.*: the stated effect recovered by regression on the output table (lm, glm, survival::coxph)
  N28c: { methods: ['patients.continuous', 'patients.binary', 'patients.time_to_event'], anchors: ['Recovered by regression on the OUTPUT table', 'all(abs(z) <= 4)'] },
  // population.quality: a memorising generator and an ideal one, whose answers are known (replication 1 and 0, membership AUC 0.5)
  'C2-15': { methods: ['population.quality'], anchors: ['The identity', 'abs(ri$membershipAuc - 0.5) < 0.06'] },
  // design.grid: a cell equals the single design.simulate job at that cell's seed, and the null cell's type-I error is the nominal alpha
  N06d: { methods: ['design.grid'], anchors: ['cells that are immutable runs: cell k equals the design.simulate job', 'abs(null_row$value - 0.025) <= 3 * null_row$mcse'] },
  // design.assurance: numerical integration written in the case, and a Monte-Carlo run of the actual z-test
  N19b: { methods: ['design.assurance'], anchors: ['against numerical integration written here', 'abs(vcr_measure_value(cont, "assurance") - int1) < 1e-8'] },
  // matching.evaluate: the Kleene truth table, every verdict asserted
  N29: { methods: ['matching.evaluate'], anchors: ['Every verdict of the three-valued eligibility logic is asserted', 'identical(got, want) && tb_ok'] },
  // profile.snapshot and population.synthpop had no case that compared a figure with anything: these are new (N41)
  N41i: { methods: ['comparator.maic_time_to_event'], anchors: ['MAIC missing=%s pseudo unknown=%s mixed=%s common declaration=%s legacy=%s'] },
  N41h: { methods: ['comparator.weighted_cox', 'comparator.covariate_sets'], anchors: ['weighted Cox and covariate-set RMST both refuse missing/conflicting units'] },
  N41d: { methods: ['cohort.build'], anchors: ['80 -> 52 -> 40'] },
  N41e: { methods: ['comparator.rmst'], anchors: ['missing=%s explicit=%s mapped=%s conflict=%s legacy=%s'] },
  N41c: { methods: ['profile.snapshot'], anchors: ['4407 observations and 78 distinct patients'] },
  N41a: { methods: ['profile.snapshot'], anchors: ['Every figure the profile prints is recomputed from its', 'worst < 1e-9'] },
  N41b: { methods: ['population.synthpop'], anchors: ['The synthesis against the table it was fitted to', 'ok_syn <- all(within(fs))'] },

  // --- the three robustness methods (2026-10-04) ---
  N37a: { methods: ['comparator.negative_control'], anchors: ["EmpiricalCalibration 3.1.4's sccs example", 'abs(p_cal - 0.8389142) < 5e-4', 'abs(mu - as.numeric(ml$beta)) < 1e-5'] },
  N37d: { methods: ['comparator.negative_control'], anchors: ['The point of the method, on data whose bias is known', 'abs(mu - b) < 3 * se_mu'] },
  N38a: { methods: ['comparator.tipping_point'], anchors: ["Fisher's one-sided exact p at the four ways", 'max(abs(got - want)) < 1e-12', 'grid_ok <- all(unlist(maxdiff) < 1e-12)'] },
  N38c: { methods: ['comparator.tipping_point'], anchors: ['(2) a large delta reaches the worst-case limit', 'abs(a[["mi"]] - lim(fail_arm = 1L)) < 1e-6'] },
  N38d: { methods: ['comparator.tipping_point'], anchors: ['(3) The reported Monte-Carlo standard error is the real one', 'stats::sd(tips) / mean(mcses) > 0.5'] },
  N39a: { methods: ['comparator.prognostic_adjustment'], anchors: ['FDA 2023 covariate-adjustment guidance, Table 1', 'abs(g("conditional_odds_ratio") - 8) < 1e-6', 'abs(g("marginal_odds_ratio") - 4.8) < 0.02'] },
  N39b: { methods: ['comparator.prognostic_adjustment'], anchors: ['The influence-function standard errors equal an M-estimation sandwich', 'rel < 1e-6 && rel_cond < 1e-6'] },
  N39c: { methods: ['comparator.prognostic_adjustment'], anchors: ['Against the truth. 300 randomized trials', 'all(abs(bias_z) < 3)'] },
  N39d: { methods: ['comparator.prognostic_adjustment'], anchors: ['The time-to-event half against survival', 'abs(g("rmst_treatment_standardised") - a1$rmst) < 1e-8'] },

  // --- the 2026-10-07 extensions: each held to a reference that is not the method's own code ---
  // patients.longitudinal: a linear mixed model fitted to the OUTPUT table by nlme, and the model's closed-form mean and SD at every visit
  N46a: { methods: ['patients.longitudinal'], anchors: ['fit <- suppressWarnings(nlme::lme(y ~ time * arm', 'ci <- nlme::intervals(fit, level = 0.999)', 'z_worst < 4'] },
  // design.assurance (group sequential): rpact's group-sequential power per effect integrated over the prior by a quadrature written in the case, and rpact per stage
  N47a: { methods: ['design.assurance'], anchors: ['every stage\'s rejection probability agrees with rpact::getPowerSurvival', 'worst_rp < 1e-6'] },
  N47b: { methods: ['design.assurance'], anchors: ['rpact::getPowerSurvival(design = des', 'abs(a - ref) < 1e-6', 'abs(s$value - a) <= 3 * s$mcse'] },
  // design.simulate / design.grid (single-arm mean): the exact non-central t from stats::power.t.test and a normal closed form; (survival time): an independent plain-R simulation
  N48a: { methods: ['design.simulate'], anchors: ['stats::power.t.test(n = 40, delta = 5, sd = 12, sig.level = 0.025', 'abs(m$value - rows[[i]]$ref) <= 3 * m$mcse'] },
  N48c: { methods: ['design.simulate'], anchors: ['against an independent simulation written in plain R', 'abs(z) <= 3.5'] },
  N48d: { methods: ['design.grid'], anchors: ['a grid cell equals the single job at the cell\'s own seed', 'identical(cell$value, vcr_measure_value(one, "power"))'] },

  // --- the algorithm round's verification debts (2026-11-03): each held to a cross-check package that the case really calls ---
  // evidence.reconstruct_km: IPDfromKM::getIPD on the same digitized curve, risk table and event total; medians and the Cox log hazard ratio
  N17e: { methods: ['evidence.reconstruct_km'], anchors: ['IPDfromKM::getIPD(prep, armID = arm, tot.events = a$totalEvents)$IPD', 'abs(lhr_eng - lhr_pkg) <= 0.02'] },
  // patients.time_to_event: simsurv::simsurv at the same parameters, Kaplan-Meier survival and the Cox log hazard ratio within their joint error
  N28h: { methods: ['patients.time_to_event'], anchors: ['simsurv::simsurv(dist = s$dist', 'worst <= 4'] },
  // design.simulate (MaxCombo): simtrial's four statistics, their correlation and the p-value on the same data
  N58e: { methods: ['design.simulate'], anchors: ['simtrial::maxcombo(st, rho = c(0, 0, 1, 1), gamma = c(0, 1, 0, 1), return_corr = TRUE)', 'abs(r$p - r$p_pkg) < 1e-4'] },
  // design.simulate (delayed effect): gsDesign2's asymptotic MaxCombo power and expected events against the simulated ones, in Monte-Carlo errors
  N58f: { methods: ['design.simulate'], anchors: ['gsDesign2::fixed_design_maxcombo(alpha = 0.025', 'abs(pw$value - ref_power) <= 3 * pw$mcse'] },

  // design.simulate: every simulated measure and its Monte-Carlo error (power, type I error, bias, empirical SE, mse, coverage) against rsimsum::simsum on the job's own replicate table
  N63: { methods: ['design.simulate'], anchors: ['vs rsimsum::simsum on the replicate table the job summarised', 'r$worst < 1e-9'] },

  // --- the algorithm round's confirmatory designs (2026-11-03) ---
  // design.analytic (non-inferiority, T1): sample sizes of a margin against rpact's thetaH0 for means, rates (Farrington-Manning) and events
  N64a: { methods: ['design.analytic'], anchors: ['rpact::getSampleSizeRates(alpha = 0.025, beta = 0.1, sided = 1, pi1 = 0.8, pi2 = 0.8, thetaH0 = -0.1)$numberOfSubjects', 'all(d < 1e-6)'] },
  // design.simulate (non-inferiority): the simulated power equals the closed form and the rejection probability on the margin is alpha
  N64c: { methods: ['design.simulate'], anchors: ['power vs closed form: continuous', 'b_t1 = within(t1(b_t1), alpha)'] },
  N64e: { methods: ['design.simulate'], anchors: ['g_t1 = within(t1(g_t1), alpha)', 'isTRUE(t_pow$diagnostics$analyticCheck$withinTolerance)'] },
  N64f: { methods: ['design.analytic', 'design.simulate'], anchors: ['ref <- rpact::getSampleSizeRates(alpha = 0.025, beta = 0.1, sided = 1, pi1 = cfg$p1, pi2 = cfg$p0, thetaH0 = null, allocationRatioPlanned = cfg$a / (1 - cfg$a))$numberOfSubjects', 'ref_low <- rpact::getPowerRates(alpha = 0.025, sided = 1, pi1 = 0.08, pi2 = 0.1, thetaH0 = 0.03, directionUpper = FALSE'] },
  N64g: { methods: ['design.analytic'], anchors: ['refused <- c(', '"non_inferiority_effect_beyond_margin", "scenario.truth.effect"'] },
  N64h: { methods: ['design.simulate'], anchors: ['g_far <- run("g_far", gsd("group_sequential", 130, 1.8, 2), 5000L, 6431L)', 'g_t1 = within(m(g_t1), 0.025)'] },

  // design.confirmatory (T2-T6): rpact computes, so every anchor is a reference that is not rpact
  N66a: { methods: ['design.confirmatory'], anchors: ['ref <- gsDesign::gsDesign(k = 3, test.type = if (binding) 3 else 4', 'd_infl <- abs(r$diagnostics$confirmatory$inflation - ref$n.I[3])'] },
  N66b: { methods: ['design.confirmatory'], anchors: ['a known-truth simulation: the statistic at look k is N(Delta sqrt(t_k), 1)', 'worst <- max(worst, z_eff, z_size)'] },
  N66h: { methods: ['design.confirmatory'], anchors: ['bit_cont <- c(multi = identical(ma("lower_better", c(-0.3, -0.5)), ma("higher_better", c(0.3, 0.5)))', 'z_bin <- c(multi = gap(power_of(ma("lower_better", c(-0.1, -0.15), 0.7, "binary"))'] },
  N66i: { methods: ['design.confirmatory'], anchors: ['infl <- gsDesign::gsDesign(k = 2, test.type = 4, alpha = 0.025, beta = 0.1, timing = c(0.5, 1), sfu = gsDesign::sfLDOF, sfl = gsDesign::sfLDOF, n.fix = 1)$n.I[2]', 'all(abs(got - want) <= 1)'] },
  N67a: { methods: ['design.confirmatory'], anchors: ['ref <- vcr_group_sequential_power(gs, drift)', 'power = abs(pw$value - ref$power) <= 3 * pw$mcse + 0.003'] },
  N67b: { methods: ['design.confirmatory'], anchors: ['need <- ifelse(est > 0, (2 * ((c2 - w1 * z1) / w2 + stats::qnorm(0.8)) / pmax(est, 1e-12))^2, Inf)', 'worst <- max(worst, z)'] },
  // the promising zone (1.1.0): the rule in plain R on the statistic, the level, rpact's own rule as the zone's limit, and the binary and event-time forms
  N67d: { methods: ['design.confirmatory'], anchors: ['cp_plan <- stats::pnorm(est / 2 * sqrt(n2_plan) - cc)', 'level = abs(t1$value - 0.025) <= 3 * t1$mcse'] },
  N67e: { methods: ['design.confirmatory'], anchors: ['ok <<- c(ok, identical(plain, wide), grew(plain) > 0, grew(none) == 0L)', 'zone 0..1 %s the plain rule'] },
  N67f: { methods: ['design.confirmatory'], anchors: ['cp_plan <- stats::pnorm((eff * sqrt(n2_plan / 2) - cc * sqrt(v0)) / sqrt(v1))', 'drift <- -log(hr) / 2'] },
  N68a: { methods: ['design.confirmatory'], anchors: ['mvtnorm::pmvnorm(lower = rep(-Inf, length(others)), upper = rep(0, length(others))', 'ok <- jobs <= selection + 3 * mcse & jobs >= selection - early$value - 3 * mcse'] },
  N68c: { methods: ['design.confirmatory'], anchors: ['closed <- stats::pnorm((s$subset - s$rest) / sqrt(v_s + v_r))', 'worst <- max(worst, z)'] },
  N68d: { methods: ['design.confirmatory'], anchors: ['n0 <- (za + zb)^2 * ((1 / (lambda0 * t) + k) + (1 / (lambda1 * t) + k) / r) / log(lambda1 / lambda0)^2', 'abs(inflation - ref) < 0.01'] },
  // the event-time selection and enrichment (1.1.0): closed forms and patient-level simulations in plain R
  N68e: { methods: ['design.confirmatory'], anchors: ['mvtnorm::pmvnorm(lower = rep(0, arms - 1L), upper = rep(Inf, arms - 1L)', 'model = all(abs(plain - closed) <= 4 * plain_se)'] },
  N68f: { methods: ['design.confirmatory'], anchors: ['ok <- c(ok, t1$value <= alpha + 3 * t1$mcse, arm_max <= alpha + 3 * t1$mcse, null$cells$expected_events$value > 0)'] },
  N68g: { methods: ['design.confirmatory'], anchors: ['closed <- stats::pnorm((log(s$rest) - log(s$subset)) / sqrt(4 / events[1] + 4 / events[2]))', 'model <- max(model, abs(plain - closed) / plain_se)'] },
  N68h: { methods: ['design.confirmatory'], anchors: ['pops <- max(null$cells$reject_subset$value, null$cells$reject_full$value)'] },
  N68i: { methods: ['design.confirmatory'], anchors: ['ref <- sim$earlyStop[1L, 1L]', 'list(pass = worst < 4 && bound'] },
  // the comparator patches (algorithm round C14, C8, C1, C2, C9): trimming, the time-to-event doubly robust estimate, bias analysis, the G-computation STC
  N70a: { methods: ['comparator.propensity_weight'], anchors: ['hb <- .n70_by_hand(d, 0.1)', 'abs(v("weighted_difference") - hb$est) < 1e-10'] },
  N70b: { methods: ['comparator.propensity_weight'], anchors: ['root <- stats::uniroot(function(a) 1 / (a * (1 - a)) - 4 * log((1 - a) / a) / (1 - 2 * a), c(1e-4, 0.3), tol = 1e-13)$root', 'abs(alpha - root) < 2e-5'] },
  N70c: { methods: ['comparator.propensity_weight'], anchors: ['truth_kept <- mean(0.5 + 0.6 * d$x1[tr_kept])', 'abs(e1 - truth_kept) < 3 * se1'] },
  N70d: { methods: ['comparator.weighted_cox', 'comparator.aipw'], anchors: ['fit <- survival::coxph(survival::Surv(time, status) ~ arm, data = k, weights = w, ties = "efron")', 'abs(vcr_measure_value(ra, "aipw_difference") - aipw_hand) < 1e-10'] },
  N71a: { methods: ['comparator.aipw'], anchors: ['r2 <- survRM2::rmst2(c(s1$time, s1$time + 1)', 'jk <- vapply(seq_len(n), function(i) n * full - (n - 1) * est(s$time[-i], s$status[-i]), numeric(1))'] },
  N71b: { methods: ['comparator.aipw'], anchors: ['rm <- survRM2::rmst2(d$time, d$status, d$arm, tau = tau)', 'abs(v(r, "aipw_difference") - hand) < 1e-10'] },
  N71c: { methods: ['comparator.aipw'], anchors: ['truth <- sum(w * pt * (Rm(0.6 * .n71_p(x1, x2)) - Rm(.n71_p(x1, x2)))) / sum(w * pt)', 'ok <- all(abs(z[c("rr", "rw", "wr")]) < 3.5) && abs(z[["ww"]]) > 5 && abs(bias[["ww"]]) > 0.04'] },
  N71d: { methods: ['comparator.aipw'], anchors: ['rm3 <- survRM2::rmst2(d2$time, d2$status, d2$arm, tau = 3)', 'sf2 <- summary(survival::survfit(survival::Surv(time, status) ~ 1, data = d2[d2$arm == 1L, ]), times = 3)$surv'] },
  N78a: { methods: ['comparator.entropy_balance', 'comparator.propensity_weight', 'comparator.weighted_cox', 'comparator.aipw'], anchors: ['ref <- mice::pool.scalar(Q, U, n = n, k = 1)', 'mice::nelsonaalen(data.frame(tm = tm, st = st), tm, st)'] },
  N78b: { methods: ['comparator.entropy_balance', 'comparator.propensity_weight', 'comparator.weighted_cox', 'comparator.aipw'], anchors: ['imp <- mice::mice(dm, m = M, method = c("pmm", "logreg", "polyreg", "", "", ""), maxit = 10, printFlag = FALSE, seed = 5L)', 'list(pass = all(abs(zs) < 3) && abs(ratio - 1) < 0.2,'] },
  N78c: { methods: ['comparator.entropy_balance', 'comparator.propensity_weight', 'comparator.weighted_cox', 'comparator.aipw'], anchors: ['xm <- ifelse(stats::runif(n) < stats::plogis(-1.2 + 1.0 * scale(y)[, 1]), NA, x)', 'list(pass = abs(bias_mi) < 2.5 * se_mi && abs(bias_cc) > 4 * se_cc && abs(bias_cc) > 3 * abs(bias_mi) && cover > 0.88,'] },
  N78d: { methods: ['comparator.propensity_weight'], anchors: ['abs(pooled$imputed$estimate - mean(est)) < 1e-10 && abs(est_row$value - mean(est)) < 1e-10 && abs(pooled$between - stats::var(est)) < 1e-10 &&', 'abs(cc_est$estimate - vcr_measure_value(rcc, "weighted_difference")) < 1e-10 && imp$completeCase$rows == sum(cc_rows) && identical(est_row$source, "imputed") &&'] },
  N79a: { methods: ['comparator.target_trial'], anchors: ['itt <- TrialEmulation::initiators(te, estimand_type = "ITT", outcome_cov = outcome_cov, first_period = first, last_period = last, last_followup = L - 1L, data_dir = dir, quiet = TRUE)', 'list(pass = rows_ok && gap_itt < 1e-6 && gap_pp < 1e-6 && w_gap < 1e-6 && all(gap_risk < 1e-8),'] },
  N79b: { methods: ['comparator.target_trial'], anchors: ['abs(v("risk_difference_pp") - (v("risk_treated_pp") - v("risk_control_pp"))) < 1e-12', 'list(pass = ok_run && est_ok && said && ci_ok && same && cap_ok && far_ok && none_ok && gone_ok,'] },
  N80a: { methods: ['comparator.target_trial'], anchors: ['sim <- .n80_truth_sim(.n80_par, g, H); exact <- .n80_truth_exact(.n80_par, g, H)', 'list(pass = abs(z_ccw) < 2.5 && abs(z_naive) > 10 && mean(out[, "naive"]) < truth[["difference"]] && paths,'] },
  N80b: { methods: ['comparator.target_trial'], anchors: ['est_ok <- abs(v("risk_difference_start") - (hand$risks[12, "treated"] - hand$risks[12, "control"])) < 1e-12', 'ok <- identical(r1$status, "succeeded") && est_ok && same && said && far_ok && ne_ok && cap_ok'] },
  N79d: { methods: ['comparator.target_trial'], anchors: ['up_ok <- abs(up$risk - (1 - 0.025^(1 / 200))) < 1e-12 && up$n == 200', 'list(pass = kept && alone_ok && inside_ok && bare(a) && bare(b) && up_ok,'] },
  N80d: { methods: ['comparator.target_trial'], anchors: ['sim <- .n80_truth_sim(w$par, w$g, w$H, seed = 80L + i); ex <- .n80_truth_exact(w$par, w$g, w$H); old <- .n80_truth_exact(w$par, w$g, w$H, 1L)', 'list(pass = all(vapply(rows, function(r) r$ok, logical(1))),'] },
  N80e: { methods: ['comparator.target_trial'], anchors: ['truth <- c(treated = 1 - 0.95^Tm, control = 1 - 0.90^Tm)', 'abs(run[Tm, "treated"] - km[2]) < 1e-9 && abs(run[Tm, "control"] - km[1]) < 1e-9'] },
  N80f: { methods: ['comparator.target_trial'], anchors: ['tr <- .n80_truth_sim(par, g, H, N = 500000L, seed = 90L + round(rho * 100))', 'list(pass = all(vapply(rows, function(r) abs(r$est - r$truth) < 3 * sqrt(r$se^2 + r$mcse^2) && abs(r$est - r$truth) < 0.02, logical(1))),'] },
  N80h: { methods: ['comparator.target_trial'], anchors: ['abs(vcr_measure_value(inside, "risk_treated_start") - km_all) < 1e-9', 'list(pass = ok14 && ok15 && ok17 && ok28,'] },
  // --- the algorithm round's dose-finding and Bayesian designs (T7, T15, T8, T10, 2026-11-03) ---
  // design.dose: the decision tables and final doses equal BOIN's, the keyboard package's and dfcrm's; 3+3 equals its exact enumeration and the closed form of Lin and Shih; the operating characteristics equal get.oc, get.oc.kb and crmsim
  N81a: { methods: ['design.dose'], anchors: ['BOIN::get.boundary(tg, 12, 3, p.saf = phi1, p.tox = phi2, cutoff.eli = cut)$full_boundary_tab', 'BOIN::select.mtd(0.3, N[t, ], Y[t, ])$MTD'] },
  N81b: { methods: ['design.dose'], anchors: ['Keyboard::get.boundary.kb(s[1], 12, 3, marginL = s[2], marginR = s[2])$full_boundary_tab'] },
  N81c: { methods: ['design.dose'], anchors: ['ref <- dfcrm::crm(sk, 0.25, tox, lev, var.est = FALSE)', 'dfcrm::getprior(0.05, 0.25, 3, 5)'] },
  N81d: { methods: ['design.dose'], anchors: ['exact <- .n81_exact_three_plus_three(p)', 'exact = (1 - q)^3 + 3 * q * (1 - q)^5'] },
  N81e: { methods: ['design.dose'], anchors: ['oc <- BOIN::get.oc(target, p, 10, 3, ntrial = nb, p.saf = 0.18, p.tox = 0.42)', 'cs <- dfcrm::crmsim(p, vcr_crm_skeleton(0.05, target, 1L, K), target, 30, 1, nsim = nc, mcohort = 3, restrict = TRUE, count = FALSE)'] },
  // design.dose (randomized_selection): an enumeration of every outcome, the two-dose closed form and a simulation
  N83a: { methods: ['design.dose'], anchors: ['ref <- .n83_brute(n, rates, cut)', 'worst <- max(worst, abs(mine - ref)); checked <- checked + 1L'] },
  N83b: { methods: ['design.dose'], anchors: ['higher <- sum(outer(ph, pl)[outer(0:n, 0:n, function(h, l) h - l >= cut)])'] },
  N83c: { methods: ['design.dose'], anchors: ['pick <- ifelse(x3 - xc >= cut, 3L, cand)', 'z <- max(abs(sim - mine) / sqrt(mine * (1 - mine) / draws))'] },
  // design.bayesian (bop2): BOP2FE's bounds and its own simulation, an enumeration of every response sequence, Simon's published design
  N84a: { methods: ['design.bayesian'], anchors: ['ref <- tryCatch(BOP2FE::get_boundary_binary(p0, a, b, sizes, lambda = lambda, gamma = gamma, eta = eta, method = "power"), error = function(e) NULL)'] },
  N84b: { methods: ['design.bayesian'], anchors: ['ref <- .n84_enumerate(p, looks, a, b, 0.2, setup$lambda, setup$gamma, setup$eta)', 'worst <- max(worst, abs(got - want))'] },
  N84c: { methods: ['design.bayesian'], anchors: ['oc <- BOP2FE::get_boundary_oc_binary(p0, p1, c(10, 10, 10, 10), nsim, lambda = 0.9, gamma = 1, eta = 1, method = "power", seed = 8403)'] },
  N84d: { methods: ['design.bayesian'], anchors: ['published <- simon$n1 == 10 && simon$r1 == 1 && simon$n == 29 && simon$r == 5 && abs(simon$expectedN0 - 15.0) < 0.05'] },
  // design.bayesian (predictive_monitoring): the predictive probability by integration, an enumeration, a simulation of the rule
  N85a: { methods: ['design.bayesian'], anchors: ['ref <- if (need > N - n) 0 else sum(.n85_predictive(x, n, N, a, b, s))'] },
  N85b: { methods: ['design.bayesian'], anchors: ['ref <- .n85_enumerate(p, looks, 0.2, 0.8, 0.2, setup$theta, setup$futility, setup$efficacy)'] },
  N85c: { methods: ['design.bayesian'], anchors: ['decision <- lapply(looks[-length(looks)], function(n) vapply(0:n, function(x) {', 'z <- c(abs(n0["rate"] - m0$type_one_error$value) / n0["se_rate"]'] },
  // design.bayesian (threshold_calibration): RBesT's exact operating characteristics and posterior differences, QUADPACK, and a simulation of the estimate
  N86a: { methods: ['design.bayesian'], anchors: ['oc <- RBesT::oc2S(RBesT::mixbeta(c(1, setup$pt[1], setup$pt[2])), RBesT::mixbeta(c(1, setup$pc[1], setup$pc[2])), setup$n[1], setup$n[2],'] },
  N86b: { methods: ['design.bayesian'], anchors: ['ref <- RBesT::pmixdiff(RBesT::mixbeta(c(1, priors[[1]][1] + xt, priors[[1]][2] + nT - xt))', 'worst_int <- max(worst_int, abs(post[xt + 1L, xc + 1L] - exact(xt, xc, nT, nC, priors[[1]], priors[[2]], margin)))'] },
  N86c: { methods: ['design.bayesian'], anchors: ['oc <- function(c) RBesT::oc2S(RBesT::mixbeta(c(1, 1, 1)), RBesT::mixbeta(c(1, 1, 1)), nT, nC, RBesT::decision2S(c, 0, lower.tail = FALSE))(0.3, 0.3)'] },
  N86d: { methods: ['design.bayesian'], anchors: ['p_null <- rule(s$null + s$se * z); p_alt <- rule(s$alt + s$se * z)'] },
  // design.win_ratio: a plain-R loop over every pair (all three levels, dropout), hce::calcWO on the same uncensored people, exact pair probabilities of independent levels, hce::sizeWR, the permutation variance
  N87a: { methods: ['design.win_ratio'], anchors: ['ref <- .n87_loop_pairs(p, d)', 'same <- same && identical(unname(mine), unname(ref)) && all(mine == -t(mine))'] },
  N87b: { methods: ['design.win_ratio'], anchors: ['ref <- hce::calcWO(df, AVAL = "AVAL", TRTP = "TRTP", ref = "P")', 'worst <- max(worst, abs(ref$WP - wp), abs(ref$WO - wo))'] },
  N87c: { methods: ['design.win_ratio'], anchors: ['ex <- .n87_exact(cfg$risk, cfg$hr, 12, 0.1, cfg$rr, cfg$theta, cfg$shift, 1, cfg$thr)', 'z <- abs(got - ex[names(got)]) / pmax(se, 1e-12)'] },
  N87d: { methods: ['design.win_ratio'], anchors: ['perm <- vapply(seq_len(40000L), function(i) sum(u[sample.int(N, 70L)]), numeric(1))', 'v_formula <- 70 * 70 / (N * (N - 1)) * sum(u^2)'] },
  N87e: { methods: ['design.win_ratio'], anchors: ['need <- Filter(function(x) identical(x$name, "required_per_arm"), sr$measures)[[1]]$value', 'abs(pw$value - 0.8) < 4 * pw$mcse + 0.03'] },
  N87f: { methods: ['design.win_ratio'], anchors: ['f <- hce::sizeWR(WR = want_wr, power = 0.8, Pties = want_ties, alpha = 0.05)', 'abs(pw$value - 0.8) < 4 * pw$mcse + 0.1'] },
  N87g: { methods: ['design.win_ratio'], anchors: ['score_ref <- rho * stats::dnorm(cut) / (1 - stats::pnorm(cut))', 'z_pw <- (pw$value - pw_ref) / sqrt(pw$mcse^2 + pw_se^2)'] },
  N87i: { methods: ['design.win_ratio'], anchors: ['size[[1]]$value == free_size && identical(kept$diagnostics$winRatio$search$verified, FALSE) &&'] },
  // design.simulate (the modestly weighted log-rank test): simtrial's statistic to the last bit, its own generator and test, and the middle road against a late-weighted test and the log-rank test
  N88a: { methods: ['design.simulate'], anchors: ['ref <- simtrial::wlr(data.frame(tte = d$time, event = d$status, treatment = ifelse(d$arm == 1L, "experimental", "control")), weight = simtrial::mb(delay = Inf, w_max = 1 / s))', 'worst <- max(worst, abs(mine + ref$z)); checked <- checked + 1L'] },
  N88b: { methods: ['design.simulate'], anchors: ['z[i] <- simtrial::wlr(cut, weight = simtrial::mb(delay = Inf, w_max = 2))$z', 'gap <- abs(m$value - p_ref) / sqrt(m$mcse^2 + se_ref^2)'] },
  // design.simulate (group-sequential MaxCombo and modestly weighted designs): the simulated boundaries against the analytic Lan-DeMets ones, a separate run's type I error, gsDesign2::gs_power_combo
  N90a: { methods: ['design.simulate'], anchors: ['gs <- vcr_group_sequential(rates, 0.025, "obrien_fleming")', 'z <- (b$bounds - gs$criticalValues) / se'] },
  N90b: { methods: ['design.simulate'], anchors: ['v <- .n90_trials(sc, 9003L, 6000L, list(bounds = b$bounds, logrank = TRUE))', 'same <- identical(one$bounds, two$bounds)'] },
  N90c: { methods: ['design.simulate'], anchors: ['ref <- suppressMessages(gsDesign2::gs_power_combo(enroll_rate = enroll, fail_rate = fail, fh_test = fh, ratio = 1, binding = FALSE,', 'z_law <- (alt_cal - ups$probability) / binom_se(alt_cal, 6000L)', 'ok <- c(law = all(abs(z_law) < 3.5), pipeline = all(abs(z_pipe) < 3.5)'] },
  N90e: { methods: ['design.simulate'], anchors: ['ref1 <- vcr_analyse_logrank(look1, 0.025, 1, 1); refK <- vcr_analyse_logrank(d, 0.025, 1, 1)', 'z_bias <- abs(bw[1] - bl[1]) / sqrt(bw[2]^2 + bl[2]^2)'] },
  // patients.longitudinal 1.2.0: output hashes of the previous release, a mixed model and a plain comparison against the known effect under MCAR, MAR and MNAR dropout, the two estimands of a rescue medication
  N89a: { methods: ['patients.longitudinal'], anchors: ['recorded <- c("1.0.0|0" = "230ba3da3e3b6117b1f8c73757f74b7dd1ca5ccc4da00575dbf6771b583fc97a"', 'same <- same && identical(fp, recorded[[key]])'] },
  N89b: { methods: ['patients.longitudinal'], anchors: ['fit <- .n89_lme(d); co <- summary(fit)$tTable["time:arm", ]', 'abs(z(rows$mnar)) > 4 && rows$mnar$lme > truth_slope'] },
  N89c: { methods: ['patients.longitudinal'], anchors: ['hyp_truth <- -0.6 * 8', 'abs(hyp_hat - hyp_truth) < 3.5 * hyp_se && abs(est$treatmentPolicy$effect - hyp_truth) > 5 * all_se'] },
  N89e: { methods: ['patients.longitudinal'], anchors: ['mean_ref <- 20 + (-0.5 + -0.25 * zz) * g[j]', 'worst <- max(worst, abs(mean(v) - mean_ref) / (sd_ref / sqrt(length(v)))'] },
  N89g: { methods: ['patients.longitudinal'], anchors: ['completers <- mean(last$y[last$arm == 1L]) - mean(last$y[last$arm == 0L])', 'abs(head_value - completers) < 0.01 && abs(hyp - (-4.8)) < 1e-9 && abs(completers - hyp) > 0.5'] },
  N72a: { methods: ['comparator.bias_analysis'], anchors: ['want_limit <- if (lim > 0) back(lim) else if (ratio) 1 else 0', 'abs(rows[[i]]$z - zz) < 1e-12 && abs(rows[[i]]$p - (1 - stats::pnorm(zz))) < 1e-12'] },
  N72b: { methods: ['comparator.bias_analysis'], anchors: ['tip_bin <- function(b, g, p_other) tipr::tip_with_binary(', 'tn <- tipr::tip_rr(1.6, confounder_outcome_effect = 2, verbose = FALSE)$exposure_confounder_effect'] },
  N72c: { methods: ['comparator.bias_analysis'], anchors: ['abs(row1$carrierPrevalence / 0.05 - 9) < 1e-4'] },
  N72d: { methods: ['comparator.bias_analysis'], anchors: ['cdf_comb <- function(x) stats::integrate(', 'abs(m$value - want_med) < 3 * m$mcse'] },
  N72e: { methods: ['comparator.bias_analysis'], anchors: ['bf <- (g * p1 + 1 - p1) / (g * p0 + 1 - p0)', 'abs(pa$systematic$median - 1) < 1e-12'] },
  N72g: { methods: ['comparator.bias_analysis'], anchors: ['tipr::tip_with_binary(b, unexposed_confounder_prev = base, confounder_outcome_effect = g, verbose = FALSE)$exposed_confounder_prev', 'worst_back <- max(worst_back, abs(back(row$estimate, k$g, k$base) - k$est))'] },
  N73a: { methods: ['comparator.stc'], anchors: ['fit <- stats::glm(y ~ x1 + x2 + arm + arm:x1, data = d, family = stats::binomial())', 'abs(v(r, "marginal_contrast_ipd") - hand) < 1e-9'] },
  N73b: { methods: ['comparator.stc'], anchors: ['tr <- .n73_truth(TRUE)', 'ok <- abs(bias[["g"]]) < 3.5 * mcse[["g"]] && abs(bias[["cv"]]) > 8 * mcse[["cv"]] && abs(bias[["cv"]]) > 0.04'] },
  N73c: { methods: ['comparator.stc'], anchors: ['maic <- vcr_test_run(vcr_test_job("comparator.maic"', 'abs(e_s$value - e_m$value) < sqrt(se_s^2 + se_m^2)'] },
  N74a: { methods: ['evidence.pool'], anchors: ['bm <- suppressWarnings(bayesmeta(y = yy, sigma = ss, tau.prior = bm_prior, delta = 1e-5, epsilon = 1e-5))', 'identical(pe$interval$kind, "credible") && identical(pr$interval$kind, "prediction") && max(d) < 6e-5'] },
  N74b: { methods: ['evidence.pool'], anchors: ['cdf <- function(q) stats::integrate(function(u) stats::pnorm((q - y1) / sqrt(v1 + 2 * u)) * stats::dlnorm(u, m, sg), 0, Inf, rel.tol = 1e-10, subdivisions = 2000L)$value', 'abs(pe$value - fe)'] },
  N74c: { methods: ['evidence.pool'], anchors: ['want <- list(all_cause_mortality = c(0.019, 0.76, 1.31), surgical_device_success = c(0.12, 0.51, 1.97), biological_markers = c(0.17, 0.45, 2.24))', 'b$log_odds_ratio$shape == 1.77 && b$log_odds_ratio$scale == 0.55'] },
  N74e: { methods: ['evidence.pool'], anchors: ['q <- (c(-0.5, -0.1, -0.3) - mean(c(-0.5, -0.1, -0.3)))^2 / 0.01; Q <- sum(q); want <- max(0, (Q - 2) / Q)', 'abs(vcr_measure_value(three, "i_squared") - want) < 1e-9'] },
  N75a: { methods: ['evidence.network'], anchors: ['net <- netmeta(TE, seTE, treat1, treat2, studlab, data = Senn2013, sm = "MD", reference.group = "plac", common = TRUE, random = TRUE)', 'cmp <- .n75_compare(r$diagnostics$network, net, rownames(net$TE.random), "good")'] },
  N75b: { methods: ['evidence.network'], anchors: ['pw <- pairwise(list(treat1, treat2, treat3), event = list(event1, event2, event3), n = list(n1, n2, n3), data = sm, sm = "OR")', 'cmp <- .n75_compare(dn, net, rownames(net$TE.random), "bad")'] },
  N75c: { methods: ['evidence.network'], anchors: ['tau2 <- max(0, (Q - df) / (sum(w) - sum(w^2) / sum(w)))', 'abs(cl_r$estimate - re)'] },
  N75e: { methods: ['evidence.network'], anchors: ['pw <- suppressWarnings(pairwise(list(t1, t2), event = list(e1, e2), n = list(n1, n2), data = d, sm = "OR", studlab = id))', 'cmp <- .n75_compare(dn, net, rownames(net$TE.random), "good")'] },
  N76a: { methods: ['evidence.dose_response'], anchors: ['want <- c(coef = 0.0064, se = 0.0014, Q = 4.7797, ratio = 1.080313, lo = 1.0465, hi = 1.115218)'] },
  N76b: { methods: ['evidence.dose_response'], anchors: ['d_est <- max(abs(est - c(-0.0097, 0.1274, -0.2144)))', 'abs(ov$chi2 - 28.3632) < 6e-5'] },
  N76c: { methods: ['evidence.dose_response'], anchors: ['S <- matrix(1 / a[1] + 1 / b[1], k - 1L, k - 1L) + diag(1 / a[-1] + 1 / b[-1], k - 1L)', 'v <- 1 / as.numeric(t(x) %*% solve(S) %*% x); beta <- v * as.numeric(t(x) %*% solve(S) %*% lor)'] },
  N76f: { methods: ['evidence.dose_response'], anchors: ['m <- metafor::rma(vapply(fits, `[`, numeric(1), 1L), vapply(fits, `[`, numeric(1), 2L), method = "REML")', 'list(pass = mixed && ok21 && ok20 && ok6,'] },
  N77a: { methods: ['evidence.shrinkage'], anchors: ['rows <- c(d$table2, d$table3)', 's <- .n77_stratum(as.numeric(row$p[[1]]), as.numeric(row$p[[2]]), mix)'] },
  N77b: { methods: ['evidence.shrinkage'], anchors: ['folded_med <- stats::uniroot(', 'sign_int <- stats::integrate(dens, 0, Inf, rel.tol = 1e-11)$value'] },

  // comparator.borrowing (power prior): the definition integrated numerically, RBesT, a closed form for a mean, an enumeration decided by RBesT and a simulation
  N91a: { methods: ['comparator.borrowing'], anchors: ['ref <- .n91_definition(a0); r <- .n91_rows(a0)[[2L]]', 'worst <- max(worst, d)'] },
  N91b: { methods: ['comparator.borrowing'], anchors: ['ref <- 1 - RBesT::pmixdiff(mixbeta(c(1, 1 + .n91_trt$x, 1 + .n91_trt$n - .n91_trt$x)), mixbeta(c(1, post$alpha, post$beta)), 0)', 'ess_ref <- RBesT::ess(mixbeta(c(1, pr$mix$alpha, pr$mix$beta)), method = "moment") - 2'] },
  N91c: { methods: ['comparator.borrowing'], anchors: ['z <- stats::integrate(dens, 5, 15, rel.tol = 1e-13)$value', 'better <- stats::integrate(function(t) dens(t) / z * stats::pnorm((trt$mean - t) / (hist$sd / sqrt(trt$n))), 5, 15, rel.tol = 1e-13)$value'] },
  N91d: { methods: ['comparator.borrowing'], anchors: ['D[xt + 1L, xc + 1L] <- as.numeric(1 - RBesT::pmixdiff(mixbeta(c(1, 1 + xt, 1 + n_t - xt)), mixbeta(c(1, post$alpha, post$beta)), 0) > 1 - alpha) }', 'sim_null <- mean(Dc[cbind(xt_null + 1L, xc + 1L)])'] },
  N91e: { methods: ['comparator.borrowing'], anchors: ['mu_mean <- (A * hist$mean + n_c * tc) / (A + n_c)', 'worst <- max(vapply(oc, function(r) max(abs(r$perPrior$chosen$typeOneError - closed(r$controlValue, 0))'] },
  // comparator.borrowing (SAM prior): SAMprior's weight, prior and exact operating characteristics, RBesT's posterior mixtures
  N92a: { methods: ['comparator.borrowing'], anchors: ['ref <- suppressMessages(SAM_weight(if.prior = mixbeta(inf = c(1, 1 + xh, 1 + nh - xh)), theta.h = th, method.w = "LRT", n = n, r = x, delta = dl))', 'ref <- suppressMessages(SAM_weight(if.prior = mixnorm(inf = c(1, 0, 1 / sqrt(100)), sigma = 1), theta.h = 0, method.w = "LRT", delta = dl, m = m, n = n, sigma = 1))'] },
  N92b: { methods: ['comparator.borrowing'], anchors: ['ref_prior <- SAM_prior(if.prior = mixbeta(inf = c(1, 91, 211)), nf.prior = mixbeta(nf = c(1, 1, 1)), weight = pr$weight)', 'p_ref <- 1 - pmixdiff(mixbeta(c(1, 1 + trt$x, 1 + trt$n - trt$x)), ref_post, 0)'] },
  N92c: { methods: ['comparator.borrowing'], anchors: ['null <- eval_oc_bin_2arm(ifp, nfp, nfp, theta = tc, theta.t = tc, n.t = n_t, n = n_c, delta = dl, method = c("SAM", "NP"), cutoff = 1 - alpha)', 'abs(r$perPrior$chosen$weight - null$mean_weight[1])'] },
  N92d: { methods: ['comparator.borrowing'], anchors: ['null <- eval_oc_cont_2arm(ifp, nfp, flat, theta = tc, theta.t = tc, n.t = n_t, n = n_c, delta = 2, method = "SAM", cutoff = 1 - alpha, sigma = 4, sigma.t = 4)'] },
  N92e: { methods: ['comparator.borrowing'], anchors: ['rob <- vcr_robustify(data.frame(weight = 1, mean = 0, sd = 1 / sqrt(100)), 1 - pr$weight, vague_mean = 0, vague_sd = 1)'] },
  // comparator.borrowing (elastic prior): chisq.test, the paper's closed form for the two constants, simulations of the congruence measure and of the whole procedure
  N93a: { methods: ['comparator.borrowing'], anchors: ['ref <- suppressWarnings(unname(stats::chisq.test(matrix(c(x, n - x, xh, nh - xh), 2), correct = FALSE)$statistic))', 'sim <- vcr_bw_chisq_binary(stats::rbinom(K, nc, p), nc, .n93_hist$x, .n93_hist$n)'] },
  N93b: { methods: ['comparator.borrowing'], anchors: ['a_paper <- log((1 - C1) / C1) - L * lq0 / (lq0 - lq1); b_paper <- L / (lq0 - lq1)', 'worst_c <- max(worst_c, abs(g(fit$tq0) - 0.99), abs(g(fit$tq1) - 0.01))'] },
  N93c: { methods: ['comparator.borrowing'], anchors: ['worst <- max(worst, abs(pr$weight - g), abs(pr$mix$alpha - max(g * (0.1 + hist$x), 0.1)), abs(pr$mix$beta - max(g * (0.1 + hist$n - hist$x), 0.1)))'] },
  N93d: { methods: ['comparator.borrowing'], anchors: ['D[xt + 1L, xc + 1L] <- as.numeric(1 - RBesT::pmixdiff(mixbeta(c(1, 1 + xt, 1 + n_t - xt)), mixbeta(c(1, post$alpha, post$beta)), 0) > 1 - alpha) }', 'rej <- stats::pnorm((yt - mu) / sqrt(16 / nt2 + 1 / prec)) > 1 - alpha'] },
  N93e: { methods: ['comparator.borrowing'], anchors: ['fall_up <- all(diff(w[centre:length(w)]) <= 1e-12); fall_down <- all(diff(w[centre:1]) <= 1e-12)'] },
  // comparator.borrowing as a job: the protocol validators, determinism, exact (non-simulated) measures and the named refusals
  N94a: { methods: ['comparator.borrowing'], anchors: ['abs(.n94_m(r, "borrowing_weight") - 0.3) < 1e-12 && abs(.n94_m(r, "borrowed_sample_size") - 0.3 * 300) < 1e-9'] },
  N94b: { methods: ['comparator.borrowing'], anchors: ['abs(.n94_m(r, "type_one_error_worst") - worst_rows) < 1e-15 && length(oc) == 3L'] },
  N94c: { methods: ['comparator.borrowing'], anchors: ['identical(vcr_output_hash(r1), vcr_output_hash(r2)) && abs(g_chk - 0.99) < 1e-12'] },
  N94d: { methods: ['comparator.borrowing'], anchors: ['all(c(drift$code, over$code, tiny$code) == "scenario_value_invalid") && identical(schema$code, "scenario_field_missing")'] },

  // model.survival_fit (spline): flexsurv::flexsurvspline for the fit, flexsurv's own survival, quantile and restricted-mean functions and numDeriv's Jacobian for the delta-method errors, a known log-logistic truth
  N95a: { methods: ['model.survival_fit'], anchors: ['ref <- flexsurv::flexsurvspline(survival::Surv(time, status) ~ 1, data = d, k = k, scale = "hazard")', 'above <- above && mine$logLikelihood >= ref$loglik - 1e-9'] },
  N95b: { methods: ['model.survival_fit'], anchors: ['surv_ref <- flexsurv::psurvspline(horizons, gamma = g, knots = kn, scale = "hazard", lower.tail = FALSE)', 'J <- numDeriv::jacobian(lh, g); se_h <- sqrt(rowSums((J %*% V) * J)); z <- stats::qnorm(0.975)'] },
  N95c: { methods: ['model.survival_fit'], anchors: ['truth_s <- function(t) flexsurv::pllogis(t, shape = 2.2, scale = 10, lower.tail = FALSE)', 'err(sp) < 0.01 && err(w) > 0.03'] },
  N95d: { methods: ['model.survival_fit'], anchors: ['identical(unname(est), c(TRUE, TRUE, FALSE, FALSE, FALSE)) && all(rules == "nuisance_model_not_estimable")'] },
  N95e: { methods: ['model.survival_fit'], anchors: ['identical(vcr_output_hash(r1), vcr_output_hash(r2))', 'identical(r_old$status, "failed") && "method_version_mismatch" %in% vcr_test_issue_codes(r_old)'] },
  N95f: { methods: ['model.survival_fit'], anchors: ['closed <- function(tau) scale * gamma(1 + 1 / shape) * stats::pgamma((tau / scale)^shape, 1 / shape)', 'list(pass = all(flagged) && all(meds > longest) && isTRUE(weib$medianBeyondData) && !isTRUE(inside$medianBeyondData) && said && rel < 1e-7,'] },

  // population.synthpop / population.quality 1.1.0 (P1): the combining rules of Raab, Nowok and Dibben against synthpop's own summary of a fit to five copies, the closed-form false-positive rate of an uncorrected analysis, the log-rank / Cox / restricted-mean analyses against survival and survRM2
  N96a: { methods: ['population.synthpop', 'population.quality'], anchors: ['ref <- summary(synthpop::lm.synds(y ~ x1 + x2, data = sds), population.inference = TRUE)$coefficients["x2", ]', 'max(worst) < 1e-9'] },
  N96b: { methods: ['population.synthpop', 'population.quality'], anchors: ['closed <- 2 * (1 - stats::pnorm(stats::qnorm(0.975) / sqrt(2)))', 'within(nc$syntheticNaive, closed, 0.006)'] },
  N96c: { methods: ['population.synthpop', 'population.quality'], anchors: ['closed_simple <- 2 * (1 - stats::pnorm(stats::qnorm(0.975) / sqrt(1.4 / 1.2)))'] },
  N96d: { methods: ['population.synthpop', 'population.quality'], anchors: ['rm_ref <- survRM2::rmst2(d$time, d$status, as.numeric(d$arm == "b"), tau = 15)$unadjusted.result[1, ]', 'abs(lr$estimate - unname(stats::coef(one))) < 1e-8'] },
  N96e: { methods: ['population.synthpop'], anchors: ['fits <- lapply(copies, function(cp) summary(survival::coxph(survival::Surv(os, death) ~ arm + age, data = cp))$coefficients["arm", ])', 'abs(sp$hr$combined$estimate - h$estimate) < 1e-9'] },
  N96f: { methods: ['population.synthpop', 'population.quality'], anchors: ['identical(r$diagnostics$quality$inference$nullCalibration$reason, "generator_not_rerunnable")'] },
  N96g: { methods: ['population.synthpop', 'population.quality'], anchors: ['want_syn <- "5ba6c6cefec2d3d215748c4922dba1d9f1e0f87268b866acff927382577a4ef2"'] },
  N96h: { methods: ['population.synthpop', 'population.quality'], anchors: ['hand <- rbind(c((0 + 0 + 0.4) / 3, (3 / 4 + 0 + 0.4) / 3), c((1 / 4 + 1 + 0) / 2, (2 / 4 + 1 + 0) / 2), c((0 + 0.8 / 1) / 2, (0 + 0) / 2))', 'list(pass = gower_ok && identical(miss$status, "succeeded") && q_ok && rates_ok && job_ok && cancel_ok && smooth_ok,'] },
  N96i: { methods: ['population.quality'], anchors: ['sqrt(ubar * k / n * (if (redrawn) 1 + (n / k + 1) / m else 1 + n / k / m))', 'cr$se > cp$se && isTRUE(plain$diagnostics$quality$inference$nullCalibration$available)'] },
  // per-record privacy and attribute inference (P2): the closed form of a copied record's risk, the independent nearest-neighbour search, prop.test's Wilson interval
  N97a: { methods: ['population.synthpop', 'population.quality'], anchors: ['closed <- (copied + 1) / (copied + 2)', 'all(abs(r_tr[m_tr$dcr == 0] - closed) < 1e-12)'] },
  N97b: { methods: ['population.synthpop', 'population.quality'], anchors: ['share_tr(0.9) >= copied / n && share_tr(0.9) < copied / n + 0.03'] },
  N97c: { methods: ['population.synthpop', 'population.quality'], anchors: ['!grepl("1234.5678", json, fixed = TRUE)'] },
  N97d: { methods: ['population.synthpop', 'population.quality'], anchors: ['wil <- stats::prop.test(round(one$successControl * one$attacksControl), one$attacksControl, correct = FALSE)$conf.int', 'abs(one$successControl - control_hand) < 1e-12'] },
  N97e: { methods: ['population.synthpop', 'population.quality'], anchors: ['identical(rep_copy$bands$inferenceRisk, "red") && identical(rep_fresh$bands$inferenceRisk, "green")'] },
  N97f: { methods: ['population.quality'], anchors: ['identical(vcr_output_hash(r1), vcr_output_hash(r2)) && q$release$copies == 5L'] },
  N97g: { methods: ['population.quality'], anchors: ['by_hand <- function(r) max(vapply(ai(r)$secrets, function(s) (s$successMain - s$successControl) / (1 - s$successControl), numeric(1)))'] },

  // model.prognostic_train (P3): coxph and lm on every row, the job's own folds rebuilt by hand, the population C and R squared of a known truth, DeLong against every pair, design.procova's formula and a closed form for the savings, model.prognostic_apply reproducing the saved model
  N98a: { methods: ['model.prognostic_train'], anchors: ['full <- survival::coxph(survival::Surv(os, death) ~ x1 + x2 + x3 + x4, data = d, ties = "efron")', 'abs(.n98_m(r, "out_of_fold_c_index") - c_hand) < 1e-10'] },
  N98b: { methods: ['model.prognostic_train'], anchors: ['r2_pop <- sum(b^2) / (sum(b^2) + sigma^2)', 'abs(.n98_m(r, "out_of_fold_r_squared") - r2_hand) < 1e-10'] },
  N98c: { methods: ['model.prognostic_train'], anchors: ['closed <- function(rho, l, g) (1 - (l * rho)^2) * (1 + g^2) / 2', 'abs(ratio_job - one$sampleSizeRatio$value) < 1e-12'] },
  N98d: { methods: ['model.prognostic_train'], anchors: ['psi <- outer(pos, neg, function(a, b) (a > b) + 0.5 * (a == b))', 'abs(dl$se - se_pairs) < 1e-12'] },
  N98e: { methods: ['model.prognostic_train'], anchors: ['identical(r_few$conclusion, "not_estimable") && identical(r_few$notEstimableRule, "too_few_events")', '!grepl("St-Rare-Genotype-X", json3, fixed = TRUE)'] },
  N98f: { methods: ['model.prognostic_train'], anchors: ['identical(vcr_output_hash(r1), vcr_output_hash(r2)) && identical(rf$model, "random_forest")'] },
  N98g: { methods: ['model.prognostic_train'], anchors: ['joined <- vcr_test_run(vcr_test_job("model.prognostic_train", sc, list(in_subj, in_ev), seed = 9801L))', 'max(abs(b1 - b2)) < 1e-12'] },
  N98h: { methods: ['model.prognostic_train'], anchors: ['ref <- stats::cor(lp, as.numeric(full$os <= 24 & full$death == 1))', 'list(pass = ok10 && ok19 && all(gap < 0.045) && is.finite(rho_full) && rho_full > 0.3'] },

  // patients.progression (P4): the unit shapes against their own rates integrated numerically, the moments of 200,000 simulated people per family against the closed form, the closed-form power of the Welch test (noncentral t) and stats::power.t.test for equal variances, the clock slowed by a stated share
  N99a: { methods: ['patients.progression'], anchors: ['stats::integrate(rate_of, 0, t, rel.tol = 1e-12)$value', 'mo <- vcr_progression_moments(par, 3, 1.2, 0.7, 0.3, visits, scale)'] },
  N99b: { methods: ['patients.progression'], anchors: ['pt <- stats::power.t.test(n = 60, delta = delta, sd = sd_change, sig.level = 0.05, type = "two.sample", strict = TRUE)$power', 'want <- r$diagnostics$progression$approximation$power'] },
  N99c: { methods: ['patients.progression'], anchors: ['ctl_at <- function(t) 3 + 5 * t / (12 + t)', 'sd18 <- sqrt(1.2^2 + 1.2^2 * u18^2 + 2 * 0.3 * 1.2 * 1.2 * u18 + 0.7^2)'] },
  N99d: { methods: ['patients.progression'], anchors: ['identical(vcr_output_hash(r1), vcr_output_hash(r2)) && identical(vcr_output_hash(r1), vcr_output_hash(r3))'] },
  N99e: { methods: ['patients.progression'], anchors: ['identical(code(unsourced), "scenario_field_missing")'] },
  // the people of an adaptive design whose answer is in events (live check 2026-11-04, design.confirmatory 1.2.0): patient-level simulations and the Lachin-Foulkes chance of an event written out
  N100a: { methods: ['design.confirmatory'], anchors: ['sim <- lapply(c(0.5, 1), function(rate) .n100_enrolled(n, 0.5, hr, rate * max_events))', 'expected <- ended[1] * got[1] + (1 - ended[1]) * got[2]'] },
  N100b: { methods: ['design.confirmatory'], anchors: ['closed <- p1$value * at_interim[["mean"]] + (1 - p1$value) * n0', 'n0 <- ceiling(plan / per_head); cap <- ceiling(1.0001 * plan)'] },
  N100c: { methods: ['design.confirmatory'], anchors: ['head_multi <- .n100_per_head(0.6)', 'ev <- t_event < t_drop & entry + t_event <= 30'] },
  N100d: { methods: ['design.confirmatory'], anchors: ['recorded <- c(futility_tte = "f079dc9b9383b2335d62025a8b8b8b0b19fb7cb4a75f722c5f458a786f60c749"', 'identical(unname(got), unname(recorded))'] },
  // the campaign's screening precision (design search, plan T10): exact t-test power, exact Clopper-Pearson bounds, the bitset against the measure
  N110a: { methods: ['design.simulate'], anchors: ['"scenario_value_invalid@scenario.evaluation.screeningReplicates" %in% codes(at_floor) &&'] },
  N110b: { methods: ['design.simulate'], anchors: ['exact <- stats::power.t.test(n = 64, delta = 0.5, sd = 1, sig.level = 0.025, type = "two.sample", alternative = "one.sided", strict = TRUE)$power'] },
  N110c: { methods: ['design.simulate'], anchors: ['counts_agree <- sum(ra) == round(pa$value * 800) && sum(rb) == round(pb$value * 800)'] },
  N110d: { methods: ['design.simulate'], anchors: ['upper <- stats::qbeta(0.975, k + 1, n - k); lower <- if (k > 0) stats::qbeta(0.025, k, n - k + 1) else 0'] },
  N110e: { methods: ['design.simulate'], anchors: ['same <- identical(one$manifest$outputHash, two$manifest$outputHash) && identical(one$diagnostics$evaluation, two$diagnostics$evaluation) &&'] },

  // --- the comparator-effect stream's cases (listed so that merging it needs no edit here; inert until the cases exist) ---
  N33a: { methods: ['comparator.weighted_cox'], anchors: ['Cross-software: the weights are WeightIt', 'rel(m(j_ebal, "hazard_ratio"), r_ebal$hr) < 1e-6'] },
  N34a: { methods: ['comparator.maic_time_to_event'], anchors: ['The unanchored vignette: 500 patients of arm A matched', 'abs(m("hazard_ratio_robust")$value - 0.2834780) < 1e-6'] },
  N34b: { methods: ['comparator.maic_time_to_event'], anchors: ['The anchored vignette: arms A and C in the study', 'close(m(r, "hazard_ratio_ac_adjusted")$value, 0.1527378)'] },
  N35a: { methods: ['comparator.aipw'], anchors: ['The estimator from its formula, outside the engine', 'abs(v(rb, "aipw_difference") - hb$tau) < 1e-10'] },
  N36a: { methods: ['comparator.covariate_sets'], anchors: ['Four sets of a confounded design with a true effect of 0.5', 'all(abs(est - refs) < 1e-7)'] },
};

/**
 * Extract the literal case declarations and their source lines, without running R.
 * @param {{ path: string, bytes: Buffer }[]} files
 * @returns {Map<string, { path: string, line: number, lines: string[] }>}
 */
export function sourceCases(files) {
  const cases = new Map();
  for (const file of files) {
    const lines = file.bytes.toString('utf8').split(/\r?\n/);
    const starts = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^vcr_case\(/.test(lines[index])) continue;
      const id = /^vcr_case\("([A-Za-z0-9-]+)"\s*,/.exec(lines[index])?.[1];
      requireValue(id && !cases.has(id), 'case_source_invalid');
      starts.push({ id, index });
    }
    for (let n = 0; n < starts.length; n += 1) {
      const { id, index } = starts[n];
      requireValue(!cases.has(id), 'case_source_duplicate');
      cases.set(id, { path: file.path, line: index + 1, lines: lines.slice(index, starts[n + 1]?.index ?? lines.length) });
    }
  }
  requireValue(cases.size > 0, 'case_source_missing');
  return cases;
}

/**
 * The methods (of the registry given, which is the engine's dispatch) that no
 * reference case of this source holds: an entry counts only when its case exists.
 * @param {Iterable<string>} methodIds
 * @param {Map<string, any>} definitions the cases `sourceCases` found
 * @returns {string[]}
 */
export function methodsWithoutReference(methodIds, definitions) {
  const held = new Set();
  for (const [caseId, spec] of Object.entries(NUMERIC_REFERENCES)) {
    if (definitions.has(caseId)) for (const method of spec.methods) held.add(method);
  }
  return [...methodIds].filter(method => !held.has(method));
}

/**
 * The anchors of an entry that are not in its case, and the methods an entry
 * names that the registry does not have: what the generator would refuse, said
 * before the 40-minute numerical run.
 * @param {Iterable<string>} methodIds
 * @param {Map<string, { lines: string[] }>} definitions
 * @returns {{ caseId: string, problem: string }[]}
 */
export function referenceProblems(methodIds, definitions) {
  const known = new Set(methodIds);
  const problems = [];
  for (const [method, cases] of Object.entries(REQUIRED_CURRENT_REFERENCES)) {
    if (known.has(method)) for (const caseId of cases) if (!definitions.has(caseId)) problems.push({caseId, problem: `${method} requires its current-version numerical reference`});
  }
  for (const [caseId, spec] of Object.entries(NUMERIC_REFERENCES)) {
    const definition = definitions.get(caseId);
    if (!definition) continue;
    for (const method of spec.methods) if (!known.has(method)) problems.push({ caseId, problem: `names ${method}, which the engine does not dispatch` });
    for (const anchor of spec.anchors) {
      if (!definition.lines.some(line => line.includes(anchor))) problems.push({ caseId, problem: `its anchor is no longer in the case: ${JSON.stringify(anchor)}` });
    }
  }
  return problems;
}

/**
 * The R package names a free-text label mentions: every word of it (letters, digits and dots) that is, character for
 * character, the name of a package in a lock. `pkg::fn` and "pkg (a vignette)" both name `pkg`; a word that merely
 * resembles a name does not, so "meta engine" names `meta` (the package) and has to be true of it or be dropped.
 * @param {string} label
 * @param {ReadonlySet<string>} packages
 * @returns {string[]}
 */
export function packagesNamedBy(label, packages) {
  return [...new Set(String(label).split(/[^A-Za-z0-9.]+/).filter(word => packages.has(word)))];
}

/**
 * Whether the numeric cases call a package: `pkg::` (not in a comment line), `library(pkg)` or `requireNamespace("pkg"`.
 * @param {string} name
 * @param {string} source the cases' text with whole-line comments removed
 */
function callsPackage(name, source) {
  const escaped = name.replace(/[.]/g, '\\.');
  return new RegExp(`(?<![A-Za-z0-9._])${escaped}::|library\\(\\s*["']?${escaped}["']?\\s*[,)]|requireNamespace\\(\\s*["']${escaped}["']`).test(source);
}

/**
 * Hidden knowledge: a method's `crossChecks` says what its numeric cases are held against, and a label that names a package no
 * case calls is a claim nothing checks (`patients.time_to_event` said `simsurv` and `evidence.reconstruct_km` said `IPDfromKM`
 * while no case ran either). A label that names a package in either lock (the runtime one or the cross-check one) is therefore
 * a problem unless `tests/numeric` calls that package. The rule asks only that the call exists; whether the case compares the
 * method against it is what the case's own `detail` and the reviewer say. A label that names no package (a closed form, a
 * published table) is not this rule's business.
 * @param {Record<string, { crossChecks?: readonly string[] | string }>} methods the registry as the engine's snapshot holds it
 * @param {Iterable<string>} packages the names of the packages in the locks
 * @param {{ path: string, bytes: Buffer | string }[]} files the files of `tests/numeric`
 * @returns {{ method: string, label: string, packageName: string }[]}
 */
export function crossCheckLabelProblems(methods, packages, files) {
  const names = new Set(packages);
  const source = files.map(file => String(file.bytes).split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')).join('\n');
  const problems = [];
  for (const [method, spec] of Object.entries(methods)) {
    const labels = Array.isArray(spec?.crossChecks) ? spec.crossChecks : spec?.crossChecks ? [spec.crossChecks] : [];
    for (const label of labels) {
      for (const packageName of packagesNamedBy(label, names)) {
        if (!callsPackage(packageName, source)) problems.push({ method, label, packageName });
      }
    }
  }
  return problems;
}
