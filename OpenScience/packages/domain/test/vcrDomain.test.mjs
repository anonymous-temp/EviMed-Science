import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_KINDS,
  CONTRACT_VALIDATOR_KINDS,
  GATE_CHECK_IDS,
  MCP_TOOL_BASE_NAMES,
  USAGE_PURPOSES,
  VCR_CHECK_IDS,
  VCR_REVIEWER_KINDS, VCR_REVIEW_LIFECYCLE, VCR_REVIEW_KINDS,
  VCR_COMPARATOR_ROUTES,
  VCR_CONCLUSIONS,
  VCR_COUNT_KEYS,
  VCR_CRITERION_STATES,
  VCR_DATA_TIERS,
  VCR_DATA_TIER_UNLOCKS_ZH,
  VCR_ENGINE_METHODS,
  VCR_ENGINE_METHOD_IDS,
  VCR_ENGINE_PROTOCOL_VERSION,
  VCR_INTENDED_USES,
  VCR_JOB_KINDS,
  VCR_JOB_METHODS,
  VCR_MIN_CELL_SIZE,
  VCR_MODEL_TIERS,
  VCR_REPLICATES_NULL_MIN,
  VCR_STEPS,
  VCR_STEP_CAPABILITIES,
  VCR_TABS,
  VCR_VALUE_SOURCES,
  affectedNodes,
  canonicalScenarioJson,
  intendedUseCeiling,
  lineageNode,
  mcseOf,
  missingModelEvidence,
  parseLineageNode,
  recomputePlan,
  replicateFloor,
  replicatesForMcse,
  reviewStateFor,
  roleAllows,
  twinLabel,
  useWithin,
  validateCounts,
  validateEngineJob,
  validateEngineResult,
  vcrCohortFindings,
  vcrMatchingFindings,
  vcrSimulationReportFindings,
  vcrStudyPackageFindings,
  vcrTierIsSupported,
  vcrTierNeedsSupport,
  vcrTierOffer,
  vcrTierSupportedBy,
} from "@evimed/domain";

// --- vocabulary -------------------------------------------------------------

test("the nine value sources include the two literature ones the v1.0 plan lacked", () => {
  assert.equal(VCR_VALUE_SOURCES.length, 9);
  assert.ok(VCR_VALUE_SOURCES.includes("aggregate"));
  assert.ok(VCR_VALUE_SOURCES.includes("reconstructed"));
});

test("the study has seven steps and seven tabs, and every step dispatches to a capability", () => {
  assert.equal(VCR_STEPS.length, 7);
  assert.equal(VCR_TABS.length, 7, "the design spec caps a page at seven tabs");
  for (const step of VCR_STEPS) assert.ok(/** @type {Record<string, string>} */ (VCR_STEP_CAPABILITIES)[step], `step ${step} has no capability`);
});

test("intended use is capped by the weakest model a result used", () => {
  assert.equal(intendedUseCeiling([]), "submission_preparation");
  assert.equal(intendedUseCeiling(["validated"]), "submission_preparation");
  assert.equal(intendedUseCeiling(["validated", "literature"]), "design_support");
  assert.equal(intendedUseCeiling(["scenario", "data"]), "exploratory");
  assert.ok(useWithin("design_support", "specified_analysis"));
  assert.ok(!useWithin("specified_analysis", "design_support"));
});

test("every model tier has a ceiling, and the four tiers are ordered weakest first", () => {
  assert.deepEqual([...VCR_MODEL_TIERS], ["scenario", "literature", "data", "validated"]);
  const ceilings = VCR_MODEL_TIERS.map((tier) => VCR_INTENDED_USES.indexOf(intendedUseCeiling([tier])));
  assert.deepEqual(ceilings, [...ceilings].sort((a, b) => a - b), "a stronger tier never carries a weaker use");
});

test("missing model evidence is listed, never thrown", () => {
  const missing = missingModelEvidence("medium", ["code_verification", "seed_reproducible"]);
  assert.ok(missing.includes("external_validation"));
  assert.ok(missing.includes("model_analysis_plan"));
  assert.deepEqual(missingModelEvidence("none", ["code_verification", "seed_reproducible"]), []);
});

test("the digital-twin label is derived from four pieces of evidence, never granted", () => {
  assert.equal(twinLabel(["individual_conditioned"]), "baseline_conditioned_prediction");
  assert.equal(
    twinLabel(["individual_conditioned", "updates_with_new_data", "calibrated_uncertainty", "validation_record"]),
    "digital_twin");
});

test("roles carry abilities, and only two may contact a patient", () => {
  assert.ok(roleAllows("lead", "contact_patients"));
  assert.ok(roleAllows("recruiter", "contact_patients"));
  assert.ok(!roleAllows("viewer", "write"));
  assert.ok(!roleAllows("statistical_reviewer", "contact_patients"));
});

test("the four counts and the suppression floor are the plan's", () => {
  assert.deepEqual([...VCR_COUNT_KEYS], ["realPatients", "events", "effectiveSampleSize", "generatedRecords"]);
  assert.equal(VCR_MIN_CELL_SIZE, 10);
});

test("the five comparator routes are named and ordered by precedent", () => {
  assert.equal(VCR_COMPARATOR_ROUTES.length, 5);
  assert.equal(VCR_COMPARATOR_ROUTES[0], "prognostic_adjustment");
  assert.ok(VCR_COMPARATOR_ROUTES.includes("literature_control"));
});

test("a criterion has three truth values plus a deferral, and not_applicable is not among them", () => {
  assert.deepEqual([...VCR_CRITERION_STATES], ["satisfied", "not_satisfied", "unknown", "pending_recheck"]);
  assert.ok(!VCR_CRITERION_STATES.includes("not_applicable"));
});

// --- the platform's shared registers ---------------------------------------

test("the module's five contract kinds are registered and each has a validator", () => {
  for (const kind of ["vcr-study-package", "vcr-simulation-report", "vcr-comparator-analysis", "vcr-cohort-snapshot", "vcr-matching-assessment"]) {
    assert.ok(CONTRACT_KINDS.includes(kind), `${kind} is not a contract kind`);
    assert.ok(CONTRACT_VALIDATOR_KINDS.includes(kind), `${kind} has no validator`);
  }
});

test("every check id the contracts raise is registered", () => {
  for (const id of VCR_CHECK_IDS) assert.ok(GATE_CHECK_IDS.includes(id), `${id} is not registered`);
});

test("the module's five tools and its usage purpose are in the platform's lists", () => {
  for (const tool of ["vcr_read", "vcr_write", "vcr_simulate", "trial_registry_record", "evidence_pool"]) {
    assert.ok(MCP_TOOL_BASE_NAMES.includes(tool), `${tool} is not a tool name`);
  }
  assert.ok(/** @type {readonly string[]} */ (USAGE_PURPOSES).includes("vcr"));
});

// --- the engine protocol ----------------------------------------------------

test("every engine method has a job kind, and every job kind a method", () => {
  // Written after the engine reported eight methods no kind could reach
  // (2026-09-28): `validateEngineJob` checks kind and method independently, so
  // the gap was invisible until a call site had to invent a pairing. One map,
  // both directions, and a new method without a kind is a red test rather than
  // a convention someone guesses.
  const mapped = new Set(/** @type {string[]} */ (Object.values(VCR_JOB_METHODS)));
  assert.deepEqual(VCR_ENGINE_METHOD_IDS.filter((id) => !mapped.has(id)), [], "a method no job kind can ask for");
  assert.equal(VCR_JOB_KINDS.length, VCR_ENGINE_METHOD_IDS.length);
});

test("every job kind maps to a method this build publishes", () => {
  for (const kind of VCR_JOB_KINDS) {
    const method = /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[kind];
    assert.ok(method, `job kind ${kind} has no method`);
    assert.ok(VCR_ENGINE_METHOD_IDS.includes(method), `method ${method} is not published`);
    assert.ok(/** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[method].version, `method ${method} has no version`);
  }
});

test("canonical scenario bytes sort keys and drop undefined, so both sides hash the same thing", () => {
  const a = canonicalScenarioJson({ b: 1, a: { d: undefined, c: [3, { f: 2, e: 1 }] } });
  const b = canonicalScenarioJson({ a: { c: [3, { e: 1, f: 2 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":[3,{"e":1,"f":2}]},"b":1}');
});

test("replicates follow from the precision asked for (plan §5.4, case N05)", () => {
  assert.equal(replicatesForMcse({ measure: "proportion", target: 0.001, p: 0.025 }), 24_375);
  assert.equal(replicatesForMcse({ measure: "proportion", target: 0.005, p: 0.95 }), 1_900);
  assert.equal(replicatesForMcse({ measure: "mean", target: 0.005, sd: 0.2 }), 1_600);
  assert.equal(mcseOf({ measure: "proportion", replicates: 20_000, p: 0.025 }).toFixed(4), "0.0011");
});

test("the replicate floor is the plan's default, raised by the asked-for precision", () => {
  assert.equal(replicateFloor({ isNull: true }), VCR_REPLICATES_NULL_MIN);
  assert.equal(replicateFloor({ isNull: false }), 5_000);
  assert.equal(replicateFloor({ isNull: true, targetMcse: 0.001, p: 0.025 }), 24_375);
});

const job = () => ({
  jobId: "job_1", studyId: "std_1", kind: "design_simulation", method: "design.simulate",
  methodVersion: "1.0.0", protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, seed: 20260928,
  replicates: 20_000, cpuSecondsLimit: 600,
  scenario: {
    design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" },
    truth: { hazardRatio: 0.6, controlMedian: 12 },
  },
  inputs: [{ kind: "assumption", id: "asm_1@3", value: { hr: 0.6 } }],
});

test("a well-formed job validates, and a mismatched protocol or unknown method does not", () => {
  assert.deepEqual(validateEngineJob(job()), []);
  assert.ok(validateEngineJob({ ...job(), protocolVersion: 99 }).some((issue) => issue.code === "protocol_version_mismatch"));
  assert.ok(validateEngineJob({ ...job(), method: "design.guess" }).some((issue) => issue.code === "method_unknown"));
  assert.ok(validateEngineJob({ ...job(), seed: -1 }).some((issue) => issue.code === "seed_invalid"));
});

test("a job that reads patient-level rows must carry the table the control plane built from the granted snapshot", () => {
  const weighting = { ...job(), kind: "weight_comparator", method: "comparator.entropy_balance", scenario: { covariates: ["age"] } };
  const issues = validateEngineJob(weighting);
  assert.ok(issues.some((issue) => issue.code === "patient_input_required"));
  // The caller's own spelling is not what the engine receives.
  assert.ok(validateEngineJob({ ...weighting, inputs: [{ kind: "snapshot", id: "snp_1", hash: "a".repeat(64) }] })
    .some((issue) => issue.code === "input_kind_caller_only"));
  const withTable = validateEngineJob({
    ...weighting,
    inputs: [{ kind: "analysis_table", id: "snp_1:subject", shape: "subject", location: "std_1/snp_1/subject.csv", hash: "a".repeat(64), valueSource: "observed" }],
  });
  assert.deepEqual(withTable, []);
});

const result = () => ({
  jobId: "job_1", protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, status: "succeeded", conclusion: "estimable",
  method: "design.simulate", methodVersion: "1.0.0", scenarioHash: "b".repeat(64), seed: 20260928, replicates: 20_000,
  measures: [{ name: "power", value: 0.81, simulated: true, mcse: 0.003, source: "calculated", interval: { kind: "monte_carlo", low: 0.8, high: 0.82 } }],
  manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "c".repeat(64), startedAt: "t", finishedAt: "t", cpuSeconds: 1, outputHash: "d".repeat(64) },
});

test("a simulated measure without a Monte-Carlo standard error is refused (AC-28)", () => {
  assert.deepEqual(validateEngineResult(result()), []);
  const bad = result();
  delete /** @type {any} */ (bad).measures[0].mcse;
  assert.ok(validateEngineResult(bad).some((issue) => issue.code === "mcse_missing"));
});

test("a not-estimable result names the rule that fired, and a manifest states its environment", () => {
  const notEstimable = { ...result(), status: "not_estimable", conclusion: "not_estimable" };
  assert.ok(validateEngineResult(notEstimable).some((issue) => issue.code === "not_estimable_rule_missing"));
  const noEnv = result();
  delete /** @type {any} */ (noEnv).manifest.rVersion;
  assert.ok(validateEngineResult(noEnv).some((issue) => issue.field === "manifest.rVersion"));
});

test("counts are checked apart: a weighted effective sample size never exceeds the real patients", () => {
  assert.deepEqual(validateCounts({ realPatients: 120, events: 80, effectiveSampleSize: 96, generatedRecords: 0 }), []);
  assert.ok(validateCounts({ realPatients: 50, effectiveSampleSize: 80, generatedRecords: 10 })
    .some((issue) => issue.code === "ess_above_real"));
  assert.ok(validateCounts({ realPatients: -1 }).some((issue) => issue.code === "count_invalid"));
});

// --- lineage ----------------------------------------------------------------

test("a lineage node carries kind, id and version", () => {
  const node = lineageNode("assumption", "asm_1", 3);
  assert.equal(node, "assumption:asm_1@3");
  assert.deepEqual(parseLineageNode(node), { kind: "assumption", id: "asm_1", version: 3 });
  assert.equal(parseLineageNode("assumption:asm_1"), null);
  assert.throws(() => lineageNode("nonsense", "x", 1));
});

test("changing an assumption reaches every result downstream of it", () => {
  const edges = [
    { from: "assumption:asm_1@3", to: "trial_scenario:scn_1@2" },
    { from: "trial_scenario:scn_1@2", to: "result:res_1@1" },
    { from: "assumption:asm_2@1", to: "population:pop_1@1" },
  ];
  assert.deepEqual(affectedNodes(edges, ["assumption:asm_1@3"]), ["trial_scenario:scn_1@2", "result:res_1@1"]);
  assert.deepEqual(affectedNodes(edges, ["assumption:asm_9@1"]), []);
});

test("a cycle in the table cannot hang the request that reads it", () => {
  const edges = [{ from: "a:1@1", to: "b:1@1" }, { from: "b:1@1", to: "a:1@1" }];
  assert.deepEqual(affectedNodes(edges, ["a:1@1"]), ["b:1@1"]);
});

test("light work is recomputed at once and heavy work queues", () => {
  const edges = [
    { from: "assumption:asm_1@3", to: "population:pop_1@2" },
    { from: "assumption:asm_1@3", to: "trial_scenario:scn_1@2" },
  ];
  const plan = recomputePlan({ edges, changed: ["assumption:asm_1@3"], reason: "assumption_changed" });
  assert.deepEqual(plan.light, ["population:pop_1@2"]);
  assert.deepEqual(plan.heavy, ["trial_scenario:scn_1@2"]);
  assert.throws(() => recomputePlan({ edges, changed: [], reason: "because" }));
});

test("a review holds only while every version it signed is still current (AC-21)", () => {
  assert.equal(reviewStateFor({ reviewedNodes: ["population:pop_1@3"], currentNodes: ["population:pop_1@3"] }), "reviewed");
  assert.equal(reviewStateFor({ reviewedNodes: ["population:pop_1@3"], currentNodes: ["population:pop_1@4"] }), "changed_after_review");
});

// --- contracts (all findings advisory) --------------------------------------

const pkg = (/** @type {any} */ results, prose = "") => ({
  files: new Map([["results.json", JSON.stringify(results)], ["report.md", prose]]),
});

test("every finding the module raises is advisory: the blocking budget is spent", () => {
  const found = vcrStudyPackageFindings(pkg({}, "对照组中位 PFS 4.1 个月。"));
  assert.ok(found.issues.length > 0);
  assert.ok(found.issues.every((issue) => issue.severity === "advisory"));
});

test("a number in the prose that no result carries is reported (AC-20)", () => {
  const good = vcrStudyPackageFindings(pkg({
    conclusion: "estimable",
    counts: { realPatients: 180, events: 138, effectiveSampleSize: 138, generatedRecords: 0 },
    measures: [{ name: "power", value: 0.81 }],
  }, "方案 B 需要 180 例、138 个事件，功效 81%。"));
  assert.deepEqual(good.issues.filter((issue) => issue.check === "vcr-number-provenance"), []);

  const bad = vcrStudyPackageFindings(pkg({
    conclusion: "estimable",
    counts: { realPatients: 180, events: 138, effectiveSampleSize: 138, generatedRecords: 0 },
    measures: [{ name: "power", value: 0.81 }],
  }, "方案 B 需要 220 例。"));
  assert.ok(bad.issues.some((issue) => issue.check === "vcr-number-provenance"));
});

test("a not-estimable package is a finished delivery, and it must name its rule", () => {
  const withRule = vcrStudyPackageFindings(pkg({
    conclusion: "not_estimable", notEstimableRule: "entropy_balance_infeasible",
    counts: { realPatients: 0, events: 0, effectiveSampleSize: null, generatedRecords: 0 },
  }));
  assert.deepEqual(withRule.issues.filter((issue) => issue.check === "vcr-conclusion-stated"), []);
  const withoutRule = vcrStudyPackageFindings(pkg({
    conclusion: "not_estimable",
    counts: { realPatients: 0, events: 0, effectiveSampleSize: null, generatedRecords: 0 },
  }));
  assert.ok(withoutRule.issues.some((issue) => issue.code === "vcr_not_estimable_rule_missing"));
});

test("an assumption labelled external evidence must carry a quote and a locator (AC-25)", () => {
  const found = vcrStudyPackageFindings(pkg({
    conclusion: "estimable", counts: { realPatients: 0, events: 0, effectiveSampleSize: null, generatedRecords: 0 },
    assumptions: [{ name: "对照组 ORR", sourceKind: "external_evidence", sources: [{ ref: "NCT099000xx" }] }],
  }));
  assert.ok(found.issues.some((issue) => issue.code === "vcr_assumption_unanchored"));
});

test("a simulation report needs a null scenario and an MCSE on every simulated row", () => {
  const files = new Map([["simulation.json", JSON.stringify({
    designSummary: {}, exampleTrial: {}, scenarios: [{ isNull: false }], replicates: 20_000,
    operatingCharacteristics: [{ name: "power", value: 0.81 }], sensitivity: [], code: {}, summary: "",
  })]]);
  const found = vcrSimulationReportFindings({ files });
  assert.ok(found.issues.some((issue) => issue.code === "vcr_null_scenario_missing"));
  assert.ok(found.issues.some((issue) => issue.code === "vcr_mcse_missing"));
});

test("a cohort package states 「无法判断」 apart at every step of the waterfall", () => {
  const found = vcrCohortFindings(pkg({
    conclusion: "estimable", counts: { realPatients: 400, events: 0, effectiveSampleSize: null, generatedRecords: 0 },
    waterfall: [{ step: "入组事件", kept: 400, excluded: 0 }],
  }));
  assert.ok(found.issues.some((issue) => issue.code === "vcr_waterfall_unknown_missing"));
});

test("a matching judgment that decides anything needs evidence with a locator", () => {
  const files = new Map([["matching.json", JSON.stringify({
    judgments: [
      { criterionId: "crt_1", state: "satisfied", evidence: [{ quote: "ECOG 1", locator: { doc: "d1", start: 10, end: 16 } }] },
      { criterionId: "crt_2", state: "not_satisfied", evidence: [] },
    ],
  })]]);
  const found = vcrMatchingFindings({ files });
  assert.equal(found.metrics.vcrJudgmentsUnanchored, 1);
  assert.ok(found.issues.some((issue) => issue.code === "vcr_judgment_unanchored"));
});

test("the conclusion vocabulary keeps 「不可估计」 as a first-class result", () => {
  assert.deepEqual([...VCR_CONCLUSIONS], ["estimable", "limited", "not_estimable"]);
});

test("review perspective, actor provenance and lifecycle are separate closed vocabularies", () => {
  assert.deepEqual(VCR_REVIEWER_KINDS, ['ai', 'human']);
  assert.deepEqual(VCR_REVIEW_LIFECYCLE, ['queued', 'running', 'done', 'failed']);
  assert.deepEqual(VCR_REVIEW_KINDS, ['clinical', 'statistical', 'data']);
});

// --- the data tier a study's frozen data can claim -----------------------------------------------

/** @param {Record<string, any>} table */
const analysisTable = (table) => ({ shape: "subject", rowCount: 240, outcomeBearing: false, valueSource: "observed", derivedFrom: {}, ...table });
const treated = { arm: { recorded: 180, unknown: 60, notApplicable: 0, missingReason: "not_recorded" } };

test("the data tier a study's frozen data supports is read from the registered analysis tables: baseline records are T1, recorded treatment and an outcome are T2", () => {
  assert.deepEqual(vcrTierSupportedBy([]), { tier: "T0", subjects: 0, treatment: false, outcomes: false });
  assert.deepEqual(vcrTierSupportedBy(null), { tier: "T0", subjects: 0, treatment: false, outcomes: false });
  // Baseline records of real people: T1. The partner's trial-period data is exactly this — treatment `not_shared`, no outcome.
  assert.deepEqual(vcrTierSupportedBy([analysisTable({ derivedFrom: { treatment: { arm: { recorded: 0, unknown: 240, notApplicable: 0, missingReason: "not_shared" } } } })]),
    { tier: "T1", subjects: 240, treatment: false, outcomes: false });
  assert.equal(vcrTierSupportedBy([analysisTable({ valueSource: "extracted" })]).tier, "T1", "an extracted, calculated or imputed row is still a real person's");
  // Treatment recorded for someone, but no outcome anywhere: not T2. And an outcome with no treatment record: not T2.
  assert.equal(vcrTierSupportedBy([analysisTable({ derivedFrom: { treatment: treated } })]).tier, "T1");
  assert.equal(vcrTierSupportedBy([analysisTable({ outcomeBearing: true })]).tier, "T1");
  // Both, on any real tables: T2.
  const events = analysisTable({ shape: "events", rowCount: 240, outcomeBearing: true });
  assert.deepEqual(vcrTierSupportedBy([analysisTable({ derivedFrom: { treatment: treated } }), events]),
    { tier: "T2", subjects: 240, treatment: true, outcomes: true });
  assert.equal(vcrTierSupportedBy([analysisTable({ derivedFrom: { treatment: treated }, outcomeBearing: true })]).tier, "T2", "the outcome may sit in the subject table itself");
  // T3 is never derived, whatever the data look like.
  for (const tables of [[analysisTable({ derivedFrom: { treatment: treated } }), events]]) assert.notEqual(vcrTierSupportedBy(tables).tier, "T3");
});

test("only the records of real people count: a synthetic, aggregate, predicted or empty table supports nothing, and an events table alone has no baseline", () => {
  for (const valueSource of ["synthetic", "aggregate", "predicted", "assumed", "reconstructed"]) {
    assert.equal(vcrTierSupportedBy([analysisTable({ valueSource, derivedFrom: { treatment: treated }, outcomeBearing: true })]).tier, "T0", valueSource);
  }
  assert.equal(vcrTierSupportedBy([analysisTable({ rowCount: 0 })]).tier, "T0");
  assert.equal(vcrTierSupportedBy([analysisTable({ rowCount: null })]).tier, "T0");
  assert.equal(vcrTierSupportedBy([analysisTable({ shape: "events", outcomeBearing: true }), analysisTable({ shape: "longitudinal" })]).tier, "T0", "no subject table, no baseline");
  // A real subject table with a synthetic outcome table beside it does not reach T2 on the synthetic one.
  assert.equal(vcrTierSupportedBy([analysisTable({ derivedFrom: { treatment: treated } }), analysisTable({ shape: "events", valueSource: "synthetic", outcomeBearing: true })]).tier, "T1");
  // Junk rows read as nothing and never throw.
  assert.equal(vcrTierSupportedBy([null, "x", 7, {}, { shape: "subject" }]).tier, "T0");
});

test("the offer is the highest tier the data supports above where the study stands, with what each step on the way unlocks — and never a lowering", () => {
  assert.deepEqual(vcrTierOffer("T0", { tier: "T1" }), { tier: "T1", unlocks: [VCR_DATA_TIER_UNLOCKS_ZH.T1] });
  assert.deepEqual(vcrTierOffer("T0", { tier: "T2" }), { tier: "T2", unlocks: [VCR_DATA_TIER_UNLOCKS_ZH.T1, VCR_DATA_TIER_UNLOCKS_ZH.T2] }, "one move, and it says everything it opens");
  assert.deepEqual(vcrTierOffer("T1", { tier: "T2" }), { tier: "T2", unlocks: [VCR_DATA_TIER_UNLOCKS_ZH.T2] });
  for (const [current, tier] of [["T1", "T1"], ["T2", "T1"], ["T2", "T2"], ["T3", "T2"], ["T0", "T0"], ["T2", "T0"]]) assert.equal(vcrTierOffer(current, { tier }), null, `${current} with ${tier}-data`);
  assert.equal(vcrTierOffer("T9", { tier: "T2" }), null);
  assert.equal(vcrTierOffer("T0", null), null);
  for (const tier of VCR_DATA_TIERS.slice(1, 3)) assert.ok(VCR_DATA_TIER_UNLOCKS_ZH[/** @type {"T1"} */ (tier)], `${tier} has words`);
});

test("a claim to a tier needs data that supports it; T3 is the lead's declaration over data that qualifies as T2", () => {
  assert.equal(vcrTierNeedsSupport("T3"), "T2");
  for (const tier of ["T0", "T1", "T2"]) assert.equal(vcrTierNeedsSupport(tier), tier);
  assert.deepEqual(["T0", "T1", "T2", "T3"].map((tier) => vcrTierIsSupported(tier, "T0")), [true, false, false, false]);
  assert.deepEqual(["T0", "T1", "T2", "T3"].map((tier) => vcrTierIsSupported(tier, "T1")), [true, true, false, false]);
  assert.deepEqual(["T0", "T1", "T2", "T3"].map((tier) => vcrTierIsSupported(tier, "T2")), [true, true, true, true]);
  assert.equal(vcrTierIsSupported("T7", "T2"), false);
});
