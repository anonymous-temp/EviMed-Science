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
export const NUMERIC_REFERENCES = {
  // --- the first fifteen: reviewed against a numerical comparison in the case body ---
  N01b: { methods: ['design.analytic'], anchors: ['rpact::getDesignGroupSequential(', 'd_rp < 1e-4 && d_g4 < 1e-4'] },
  N06b: { methods: ['design.analytic'], anchors: ['Required patients (Lachin-Foulkes) against rpact', 'rpact::getSampleSizeSurvival(', 'abs(r$events - r$want_events) < 1e-3'] },
  N06c: { methods: ['design.analytic'], anchors: ["Simon (1989)'s published designs", 'all(a$opt == c(1, 10, 5, 29))'] },
  N09c: { methods: ['comparator.entropy_balance', 'comparator.propensity_weight'], anchors: ['against WeightIt and', 'abs(est$value - att_wi) / abs(att_wi) < 1e-6', 'abs(est_p$value - att_pw) / abs(att_pw) < 1e-6'] },
  N11b: { methods: ['comparator.rmst'], anchors: ['against survRM2', 'abs(est$value - ref_est) < 1e-9'] },
  N12: { methods: ['comparator.evalue'], anchors: ['against the EValue package', 'g$d < 1e-6'] },
  N14b: { methods: ['comparator.maic'], anchors: ['one binary covariate at', 'abs(ess - 450^2 / 787.5) < 1e-6'] },
  N17b: { methods: ['evidence.reconstruct_km'], anchors: ['Cox on the original rows', 'abs(lhr_rec - lhr_true) <= 0.05'] },
  N21b: { methods: ['comparator.map_prior'], anchors: ['against independent references', 'abs(vcr_measure_value(r, "map_mean") - pm) < 1e-4', 'abs(vcr_measure_value(r, "map_effective_sample_size_elir") - rb_elir) < 1e-3'] },
  N22b: { methods: ['design.procova'], anchors: ['N = (z_a + z_b)^2 (s1^2/p + s0^2/(1-p)) / delta^2', 'abs(g(full, "variance_ratio") - want_full / want_unadj) < 1e-12'] },
  N27a: { methods: ['accrual.poisson_gamma'], anchors: ['10/50/90% = 16.20 / 20.13 / 25.30 months', 'abs(m$value - 20.13) < 0.01'] },
  N27b: { methods: ['accrual.poisson_gamma'], anchors: ['INDEPENDENT constructions that use no accrual code', 'all(abs(z1[c("median")]) <= 3)'] },
  N27c: { methods: ['accrual.poisson_gamma'], anchors: ['an independent gamma construction', 'abs(z_med) <= 3 && abs(z_ev) <= 3.5'] },
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
