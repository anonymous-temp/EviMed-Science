// The job queue's rules without a database: how a scenario is frozen and
// hashed, how a seed and a replicate count follow from the scenario rather than
// from a habit, what makes one job the same job as another, how a staged result
// is folded together, and which columns of a table a scenario reads. The engine
// channel has its own file (`vcrEngineClient.test.mjs`).
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_DERIVED_SOURCES, VCR_JOB_OPEN_STATES, VCR_JOB_TERMINAL_STATES, vcrIdempotencyKey, vcrMergeStageResult, vcrReplicatesForJob,
  VCR_RECONSTRUCTION_REFERENCE, vcrBindReconstruction, vcrEngineStoppedError, vcrErrorFromIssues, vcrFailureReason, vcrResultKindFor, vcrScenarioColumns, vcrScenarioHash, vcrSeedFor,
} from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_ENGINE_METHODS, VCR_REPLICATES_ALT_MIN, VCR_REPLICATES_NULL_MIN, canonicalScenarioJson, replicatesForMcse, vcrReplicateFloorFor } from "@evimed/domain";

const scenario = {
  design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 },
  endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.7, controlMedian: 6 },
  analysis: { method: "logrank", alpha: 0.025, sided: 1 },
  accrual: { kind: "uniform", duration: 12, followup: 12 },
  performance: ["power", "type_one_error"],
};

test("a time-to-event MAIC's comparator is named by the platform from a reconstruction result, and from nothing else", () => {
  const entry = { resultId: "res_1", table: "reconstructed-ipd", bindTo: "pseudoIpdInputId" };
  const resolved = { kind: "snapshot_file", id: "res_1:reconstructed-ipd", valueSource: "reconstructed" };
  const kind = VCR_RECONSTRUCTION_REFERENCE.kind;
  const bound = vcrBindReconstruction(kind, { covariates: ["age"] }, [entry], [resolved]);
  assert.deepEqual(bound, { ok: true, scenario: { covariates: ["age"], pseudoIpdInputId: "res_1:reconstructed-ipd" } });
  // no entry asks to be bound: the scenario is returned as it is
  assert.deepEqual(vcrBindReconstruction("weight_comparator", { a: 1 }, [{ resultId: "r", table: "population" }], [{ id: "r:population", valueSource: "synthetic" }]), { ok: true, scenario: { a: 1 } });
  const refused = (/** @type {any} */ result, /** @type {string} */ code) => { assert.equal(result.ok, false); assert.equal(result.code, code); };
  // only that job, only that table, only a reconstruction: a synthetic table cannot stand in for a published curve's pseudo-patients
  refused(vcrBindReconstruction("weight_comparator", {}, [entry], [resolved]), "vcr_derived_table_unsupported");
  refused(vcrBindReconstruction(kind, {}, [{ ...entry, table: "population" }], [resolved]), "vcr_derived_table_unsupported");
  refused(vcrBindReconstruction(kind, {}, [{ ...entry, bindTo: "weightColumn" }], [resolved]), "vcr_derived_table_unsupported");
  refused(vcrBindReconstruction(kind, {}, [entry], [{ ...resolved, valueSource: "synthetic" }]), "vcr_derived_table_unsupported");
  // a scenario that already names the input is the run's attempt to choose it, and is refused by its path
  const typed = /** @type {any} */ (vcrBindReconstruction(kind, { pseudoIpdInputId: "anything" }, [entry], [resolved]));
  refused(typed, "vcr_job_scenario_invalid");
  assert.equal(typed.invalid[0].field, "scenario.pseudoIpdInputId");
});

test("the columns a scenario reads include both models' covariate lists and every covariate set", () => {
  assert.deepEqual(vcrScenarioColumns({ propensityCovariates: ["age"], outcomeCovariates: ["age", "ecog"], outcomeColumn: "response", treatmentColumn: "arm" }).sort(),
    ["age", "arm", "ecog", "response"]);
  assert.deepEqual(vcrScenarioColumns({ covariateSets: [{ name: "a", covariates: ["x1", "x2"] }, { name: "b", covariates: ["x1"] }], treatmentColumn: "arm" }).sort(), ["arm", "x1", "x2"]);
});

test("every job kind files under a result kind the read models know, and every comparator method files under comparator", () => {
  assert.ok(VCR_JOB_KINDS.length >= 28, "the walk proves it walked");
  for (const kind of VCR_JOB_KINDS) assert.ok(VCR_RESULT_KINDS.includes(vcrResultKindFor(kind)), `${kind} files under ${vcrResultKindFor(kind)}`);
  for (const [kind, method] of Object.entries(VCR_JOB_METHODS)) {
    if (method.startsWith("comparator.")) assert.equal(vcrResultKindFor(kind), "comparator", `${kind} (${method})`);
  }
  assert.equal(vcrResultKindFor("procova"), "comparator");
  assert.equal(vcrResultKindFor("profile_snapshot"), "snapshot_profile");
  assert.equal(vcrResultKindFor("design_simulation"), "trial_scenario");
  assert.equal(vcrResultKindFor("reconstruct_km"), "evidence_pool");
  // every patient generator files under the patient set, the trajectory model with the others
  for (const kind of ["generate_patients", "generate_patients_continuous", "generate_patients_binary", "generate_patients_longitudinal"]) assert.equal(vcrResultKindFor(kind), "patient_set", kind);
});

test("a scenario's hash is over its canonical bytes, so key order and undefined never change it", () => {
  const base = vcrScenarioHash(scenario);
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(vcrScenarioHash(Object.fromEntries([...Object.entries(scenario)].reverse())), base);
  assert.equal(vcrScenarioHash({ ...scenario, nothing: undefined }), base);
  assert.notEqual(vcrScenarioHash({ ...scenario, truth: { hazardRatio: 0.65, controlMedian: 6 } }), base);
  // The engine hashes exactly these bytes: the domain produces them, the
  // control plane hashes them, and neither side has its own canonicaliser.
  assert.equal(canonicalScenarioJson(scenario).includes('"accrual"'), true);
});

test("the seed is derived from the scenario, so the same frozen scenario is the same run", () => {
  const hash = vcrScenarioHash(scenario);
  const seed = vcrSeedFor(hash);
  assert.equal(vcrSeedFor(hash), seed, "deterministic");
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 2_147_483_647, "inside the protocol's range");
  assert.notEqual(vcrSeedFor(vcrScenarioHash({ ...scenario, truth: { hazardRatio: 1, controlMedian: 6 } })), seed);
});

test("the idempotency key names what is computed: the same question is one job, a changed scenario or input is another", () => {
  const hash = vcrScenarioHash(scenario);
  const inputs = [{ kind: "assumption", id: "assumption:dropout_rate@1", value: { pointValue: 0.1 } }];
  const key = vcrIdempotencyKey({ key: "vcr:std_1:trial_scenario:scn_1@1", kind: "design_simulation", scenarioHash: hash, inputs, seed: 5 });
  assert.equal(vcrIdempotencyKey({ key: "vcr:std_1:trial_scenario:scn_1@1", kind: "design_simulation", scenarioHash: hash, inputs, seed: 5 }), key);
  // A changed assumption is a changed scenario (and a changed input): a second enqueue must not return the first job's stale result.
  assert.notEqual(vcrIdempotencyKey({ key: "vcr:std_1:trial_scenario:scn_1@1", kind: "design_simulation",
    scenarioHash: vcrScenarioHash({ ...scenario, truth: { hazardRatio: 0.65, controlMedian: 6 } }), inputs, seed: 5 }), key);
  assert.notEqual(vcrIdempotencyKey({ key: "vcr:std_1:trial_scenario:scn_1@1", kind: "design_simulation", scenarioHash: hash,
    inputs: [{ ...inputs[0], id: "assumption:dropout_rate@2" }], seed: 5 }), key);
  assert.notEqual(vcrIdempotencyKey({ key: "vcr:std_1:trial_scenario:scn_1@1", kind: "design_simulation", scenarioHash: hash, inputs, seed: 6 }), key);
  assert.ok(key.length <= 200, "and it fits the column");
  assert.match(vcrIdempotencyKey({ kind: "assurance", scenarioHash: hash, inputs: [], seed: 1 }), /^vcr-job:assurance:/);
});

test("replicates follow from the precision asked for, on top of the domain's floors, and the null is what the scenario says it is", () => {
  // Under the null the floor is 20,000 unless the asked-for precision needs more (`truth.null`, the one spelling).
  const nullCase = { ...scenario, truth: { ...scenario.truth, null: true } };
  assert.equal(vcrReplicatesForJob("design_simulation", nullCase, null), VCR_REPLICATES_NULL_MIN);
  assert.equal(vcrReplicatesForJob("design_simulation", { ...scenario, truth: { hazardRatio: 1, controlMedian: 6 } }, null), VCR_REPLICATES_NULL_MIN,
    "a hazard ratio of 1 is derived as the null when nobody said so");
  assert.equal(vcrReplicatesForJob("design_simulation", scenario, null), VCR_REPLICATES_ALT_MIN);
  // A one-sided 0.025 type-I error measured to a tenth of a point needs 24,375 (case N05): p is alpha under the null,
  // so 24,375 and not the 250,000 that p = 0.5 would ask for.
  const precise = vcrReplicatesForJob("design_simulation", { ...nullCase, targetMcse: 0.001 }, null);
  assert.equal(precise, 24_375);
  assert.equal(precise, replicatesForMcse({ measure: "proportion", target: 0.001, p: 0.025 }));
  assert.equal(precise, vcrReplicateFloorFor({ ...nullCase, targetMcse: 0.001 }));
  // What the caller asked for can raise the number and never lower it below the floor.
  assert.equal(vcrReplicatesForJob("design_simulation", scenario, 100_000), 100_000);
  assert.equal(vcrReplicatesForJob("design_simulation", scenario, 10), VCR_REPLICATES_ALT_MIN);
  // A grid is held to its worst cell.
  const grid = { ...scenario, truths: [{ hazardRatio: 0.7, controlMedian: 6 }, { null: true, hazardRatio: 1, controlMedian: 6 }] };
  assert.equal(vcrReplicatesForJob("design_grid", grid, null), VCR_REPLICATES_NULL_MIN);
  // A method with no replicates has none.
  assert.equal(vcrReplicatesForJob("design_analytic", scenario, null), null);
  assert.equal(vcrReplicatesForJob("weight_comparator", scenario, 3000), 3000);
});

test("the job states a queue may still move out of are the three open ones", () => {
  assert.deepEqual([...VCR_JOB_OPEN_STATES], ["queued", "running", "awaiting_budget"]);
  assert.deepEqual([...VCR_JOB_TERMINAL_STATES], ["succeeded", "failed", "canceled"]);
});

test("a result made of several stages is one result: measures of both, the weaker conclusion, and a record of which job made what", () => {
  const stage = (/** @type {string} */ name, /** @type {string} */ jobId) => ({ stage: name, jobId, method: `m.${name}`, methodVersion: "1.0.0" });
  const analytic = vcrMergeStageResult(null, { conclusion: "estimable", notEstimableRule: null, counts: { realPatients: null, events: 247 },
    measures: [{ name: "required_events", value: 246.2 }], diagnostics: { powerCurve: { series: [] } }, tables: [] }, stage("analytic", "job_1"));
  assert.deepEqual(analytic.diagnostics.stages.map((entry) => entry.stage), ["analytic"]);
  const prior = { id: "res_1", conclusion: analytic.conclusion, notEstimableRule: null, counts: analytic.counts, measures: analytic.measures,
    diagnostics: analytic.diagnostics, tables: analytic.tables };
  const merged = vcrMergeStageResult(/** @type {any} */ (prior), { conclusion: "limited", notEstimableRule: null, counts: { realPatients: 0, generatedRecords: 5000 },
    measures: [{ name: "power", value: 0.8, mcse: 0.005 }, { name: "required_events", value: 250 }], diagnostics: { analyticCheck: { withinThreeMcse: true } },
    tables: [{ name: "replicates", sha256: "a".repeat(64) }] }, stage("simulation", "job_2"));
  assert.equal(merged.conclusion, "limited", "the weaker of the two");
  assert.deepEqual(merged.measures.map((measure) => measure.name).sort(), ["power", "required_events"]);
  assert.equal(merged.measures.find((measure) => measure.name === "required_events").value, 250, "the later stage wins a name they share");
  assert.deepEqual(merged.counts, { realPatients: 0, events: 247, generatedRecords: 5000 }, "a stage that does not know a count leaves the other's alone");
  assert.ok(merged.diagnostics.powerCurve && merged.diagnostics.analyticCheck, "both stages' summaries survive");
  assert.deepEqual(merged.diagnostics.stages.map((entry) => `${entry.stage}:${entry.jobId}`), ["analytic:job_1", "simulation:job_2"]);
  // A stage run again replaces its own entry and no other.
  const again = vcrMergeStageResult(/** @type {any} */ ({ ...prior, diagnostics: merged.diagnostics, measures: merged.measures, counts: merged.counts, tables: merged.tables }),
    { conclusion: "estimable", notEstimableRule: null, counts: {}, measures: [], diagnostics: {}, tables: [] }, stage("simulation", "job_3"));
  assert.deepEqual(again.diagnostics.stages.map((entry) => `${entry.stage}:${entry.jobId}`), ["analytic:job_1", "simulation:job_3"]);
  const notEstimable = vcrMergeStageResult(/** @type {any} */ (prior), { conclusion: "not_estimable", notEstimableRule: "tau_beyond_followup", counts: {}, measures: [], diagnostics: {}, tables: [] }, stage("rmst", "job_4"));
  assert.equal(notEstimable.conclusion, "not_estimable");
  assert.equal(notEstimable.notEstimableRule, "tau_beyond_followup");
});

test("the columns a scenario reads are named for the access judgment, and only real column names", () => {
  assert.deepEqual(vcrScenarioColumns({ covariates: ["age", "ecog"], treatmentColumn: "arm", outcomeColumn: "y", tau: 12, targets: { age: 60 },
    cohortRules: [{ name: "成年", rule: { op: "compare", column: "age", comparator: "gte", value: 18 } }], parameterCode: "OS" }).sort(),
  ["age", "arm", "ecog", "y"]);
  assert.deepEqual(vcrScenarioColumns({}), []);
  assert.deepEqual(vcrScenarioColumns({ covariates: ["age; DROP TABLE"] }), [], "a name that is not a column is not one");
});

test("only synthetic and reconstructed tables are handed from one job to the next, and each carries the source its method earns", () => {
  for (const [method, source] of Object.entries(VCR_DERIVED_SOURCES)) {
    assert.ok(method in VCR_ENGINE_METHODS, `${method} is an engine method`);
    assert.ok(["synthetic", "reconstructed"].includes(source));
  }
  assert.equal(VCR_DERIVED_SOURCES["evidence.reconstruct_km"], "reconstructed");
  assert.equal(VCR_DERIVED_SOURCES["comparator.entropy_balance"], undefined, "a patient-level table reaches the engine by grant and snapshot alone");
});

test("null and alternative stages retain their own operating characteristics, Monte Carlo errors and tables", () => {
  const stage = (name) => ({ stage: name, jobId: `job_${name}`, method: "design.simulate", methodVersion: "1.1.0" });
  const result = (pet, expected, law) => ({ conclusion: "estimable", notEstimableRule: null, counts: { realPatients: 0 },
    measures: [{ name: "early_stop_probability", value: pet, mcse: 0.001 }, { name: "expected_sample_size", value: expected, mcse: 0.01 }],
    diagnostics: { isNullScenario: law === "null", analyticCheck: { withinThreeMcse: true, law } },
    tables: [{ name: "replicates", sha256: (law === "null" ? "a" : "b").repeat(64) }] });
  const nullResult = vcrMergeStageResult(null, result(0.7361, 15.014, "null"), stage("simulation_null"));
  const merged = vcrMergeStageResult(/** @type {any} */ (nullResult), result(0.1493, 26.163, "alternative"), stage("simulation"));
  const phases = merged.diagnostics.stageResults;
  assert.equal(phases.simulation_null.measures[0].value, 0.7361);
  assert.equal(phases.simulation.measures[0].value, 0.1493);
  assert.equal(phases.simulation_null.measures[1].mcse, 0.01);
  assert.equal(phases.simulation_null.diagnostics.analyticCheck.law, "null");
  assert.equal(phases.simulation.diagnostics.analyticCheck.law, "alternative");
  assert.notEqual(phases.simulation_null.tables[0].sha256, phases.simulation.tables[0].sha256);
});

// --- robustness methods ---

test("a robustness stage that cannot be computed does not turn the comparison into one that could not be estimated", () => {
  const stage = (/** @type {string} */ name, /** @type {string} */ jobId) => ({ stage: name, jobId, method: `m.${name}`, methodVersion: "1.0.0" });
  const primary = { conclusion: "estimable", notEstimableRule: null, counts: { realPatients: 120 }, measures: [{ name: "hazard_ratio", value: 0.7 }], diagnostics: { balance: [] }, tables: [] };
  const screenless = { conclusion: "not_estimable", notEstimableRule: "negative_controls_not_estimable", counts: {}, measures: [], diagnostics: { detail: "no control had an estimate" }, tables: [] };
  const asFiled = (/** @type {any} */ merged) => ({ id: "res_1", conclusion: merged.conclusion, notEstimableRule: merged.notEstimableRule, counts: merged.counts, measures: merged.measures,
    diagnostics: merged.diagnostics, tables: merged.tables });

  // the comparison lands first, then the screen
  const first = vcrMergeStageResult(null, primary, stage("primary", "job_1"));
  const merged = vcrMergeStageResult(/** @type {any} */ (asFiled(first)), screenless, stage("negative_control", "job_2"));
  assert.equal(merged.conclusion, "limited", "the comparison's own numbers stand; one analysis beside it is missing");
  assert.equal(merged.notEstimableRule, null, "and the object does not carry the screen's rule as its own");
  assert.deepEqual(merged.measures.map((measure) => measure.name), ["hazard_ratio"]);
  assert.equal(merged.diagnostics.stageResults.negative_control.conclusion, "not_estimable", "the stage's own verdict stays whole");
  assert.equal(merged.diagnostics.stageResults.negative_control.notEstimableRule, "negative_controls_not_estimable");

  // the screen lands first (the queue may run them in either order): until the comparison lands the object is what the screen says, then it is the same as above
  const screenFirst = vcrMergeStageResult(null, screenless, stage("negative_control", "job_2"));
  assert.equal(screenFirst.conclusion, "not_estimable");
  const settled = vcrMergeStageResult(/** @type {any} */ (asFiled(screenFirst)), primary, stage("primary", "job_1"));
  assert.equal(settled.conclusion, "limited");
  assert.equal(settled.notEstimableRule, null);

  // stress tests with no comparison beside them are not an estimated comparison: limited until the comparison lands, then whatever the two say together
  const lone = vcrMergeStageResult(null, { conclusion: "estimable", notEstimableRule: null, counts: {}, measures: [{ name: "primary_p_value", value: 0.03 }], diagnostics: {}, tables: [] }, stage("tipping_point", "job_5"));
  assert.equal(lone.conclusion, "limited");
  assert.equal(lone.diagnostics.stageResults.tipping_point.conclusion, "estimable", "the stage's own verdict is not edited");
  const landed = vcrMergeStageResult(/** @type {any} */ (asFiled(lone)), primary, stage("primary", "job_1"));
  assert.equal(landed.conclusion, "estimable");
  assert.equal(landed.notEstimableRule, null);

  // a comparison that is itself not estimable stays so, with its own rule, whatever the screen found
  const refusedPrimary = { conclusion: "not_estimable", notEstimableRule: "overlap_below_floor", counts: {}, measures: [], diagnostics: {}, tables: [] };
  const screen = { conclusion: "estimable", notEstimableRule: null, counts: {}, measures: [{ name: "negative_controls_analysed", value: 12 }], diagnostics: {}, tables: [] };
  const both = vcrMergeStageResult(/** @type {any} */ (asFiled(vcrMergeStageResult(null, refusedPrimary, stage("primary", "job_1")))), screen, stage("negative_control", "job_2"));
  assert.equal(both.conclusion, "not_estimable");
  assert.equal(both.notEstimableRule, "overlap_below_floor");
  // and one that is limited stays limited when the screen is estimable
  const limited = vcrMergeStageResult(/** @type {any} */ (asFiled(vcrMergeStageResult(null, { ...primary, conclusion: "limited" }, stage("primary", "job_1")))), screen, stage("tipping_point", "job_3"));
  assert.equal(limited.conclusion, "limited");

  // stages that are not robustness stages merge exactly as before: the weaker conclusion, and the rule of the stage that landed
  const analytic = vcrMergeStageResult(null, primary, stage("analytic", "job_1"));
  const simulated = vcrMergeStageResult(/** @type {any} */ (asFiled(analytic)), screenless, stage("simulation", "job_2"));
  assert.equal(simulated.conclusion, "not_estimable");
  assert.equal(simulated.notEstimableRule, "negative_controls_not_estimable");
});

test("the columns the robustness methods read are named for the access judgment: the score, each control column, the primary and the tipping outcome", () => {
  assert.deepEqual(vcrScenarioColumns({ prognosticScoreColumn: "prog", covariates: ["age"], treatmentColumn: "arm", outcomeColumn: "y" }).sort(), ["age", "arm", "prog", "y"]);
  assert.deepEqual(vcrScenarioColumns({ covariates: ["age"], controls: [{ name: "a", column: "nc_a" }, { name: "b", estimate: 0.1, se: 0.2 }], primary: { column: "y" } }).sort(),
    ["age", "nc_a", "y"]);
  assert.deepEqual(vcrScenarioColumns({ outcomeColumn: "response", treatmentColumn: "arm", design: { kind: "two_arm" } }).sort(), ["arm", "response"]);
});

test("the robustness job kinds are filed under the comparator", () => {
  for (const kind of ["negative_control_comparator", "tipping_point", "prognostic_adjustment_comparator"]) assert.equal(vcrResultKindFor(kind), "comparator", kind);
});

// --- end robustness methods ---

test("a failed job's reason is read from the engine's refusal first, then from what the engine found wrong with its own result, and is always a code and a sentence", () => {
  const refusal = { diagnostics: { issues: [{ code: "design_effect_null", field: "scenario.truth.hazardRatio", detail: "The scenario has no effect (hazardRatio 1)." }] } };
  const validation = { diagnostics: { resultValidationIssues: [
    { code: "measure_value_invalid", field: "measures[0].value", detail: "A measure carries a finite number." },
    { code: "measure_value_invalid", field: "measures[1].value", detail: "A measure carries a finite number." }] } };
  const both = { diagnostics: { ...refusal.diagnostics, ...validation.diagnostics } };

  const refused = /** @type {any} */ (vcrErrorFromIssues(refusal));
  assert.equal(refused.code, "design_effect_null");
  assert.equal(refused.field, "scenario.truth.hazardRatio");
  assert.match(refused.message, /这个情景没有效应.*hazardRatio 1/, "the domain's sentence, then the engine's own words");

  const checked = /** @type {any} */ (vcrErrorFromIssues(validation));
  assert.equal(checked.code, "measure_value_invalid");
  assert.match(checked.message, /measures\[0\]\.value: A measure carries a finite number/, "a validator's sentence is the same for every field, so the field is in it");
  assert.deepEqual(checked.issues.map((/** @type {any} */ issue) => issue.field), ["measures[0].value", "measures[1].value"]);

  assert.deepEqual(/** @type {any} */ (vcrErrorFromIssues(both)).issues.map((/** @type {any} */ issue) => issue.code), ["design_effect_null", "measure_value_invalid", "measure_value_invalid"], "refusal first");
  const long = { diagnostics: { resultValidationIssues: Array.from({ length: 30 }, (_, index) => ({ code: "measure_value_invalid", field: `measures[${index}].value`, detail: "x".repeat(900) })) } };
  const bounded = /** @type {any} */ (vcrErrorFromIssues(long));
  assert.equal(bounded.issues.length, 10, "bounded as the record always was");
  assert.ok(bounded.issues.every((/** @type {any} */ issue) => issue.detail.length <= 400) && bounded.message.length < 600);
  assert.equal(vcrErrorFromIssues({ diagnostics: {} }), null);
  assert.equal(/** @type {any} */ (vcrErrorFromIssues({ diagnostics: {} }, [{ code: "result_not_object", field: "", detail: "A result is an object." }])).code, "result_not_object", "the control plane's own validation of an answer");

  // vcrFailureReason: the caller's error wins, then the result's issues, then the honest unknown; never nothing.
  assert.equal(vcrFailureReason({ code: "engine_unavailable", message: "m" }, validation).code, "engine_unavailable");
  assert.equal(vcrFailureReason(null, validation).code, "measure_value_invalid");
  assert.equal(vcrFailureReason(undefined, refusal).code, "design_effect_null");
  for (const nothing of [null, undefined, {}, { partial: true }, { code: "", message: "" }, { message: "  " }]) {
    const reason = vcrFailureReason(nothing, { diagnostics: {} });
    assert.equal(reason.code, "vcr_job_failed");
    assert.ok(reason.message.trim().length > 0, "an unknown reason is said as unknown");
  }
  assert.equal(vcrFailureReason({ partial: true }, { diagnostics: {} }).partial, true, "what the caller already said is kept");
  assert.match(vcrFailureReason({ code: "vcr_engine_rejected", message: "" }, {}).message, /./, "a code with no sentence gets the registry's");
});

test("an engine that ended a job with no result is named in the sentence, and an engine word that is not a code is never echoed", () => {
  for (const code of ["engine_crashed", "cpu_limit_exceeded", "memory_limit_exceeded", "spawn_failed", "result_unreadable"]) {
    const error = vcrEngineStoppedError(code);
    assert.equal(error.code, "vcr_job_failed");
    assert.equal(error.engineError, code);
    assert.ok(error.message.includes(`（${code}）`), code);
  }
  const strange = vcrEngineStoppedError("Not A Code; drop table");
  assert.equal(strange.engineError, undefined);
  assert.ok(!/drop table/.test(strange.message));
  assert.ok(strange.message.length > 0);
});

test("the jobs that are about one of the study's objects are told from those that are not", async () => {
  const { VCR_SUBJECT_KINDS, vcrJobObjectKind } = await import("../src/vcrJobs.mjs");
  assert.deepEqual([...VCR_SUBJECT_KINDS], ["population", "patient_set", "comparator", "trial_scenario", "design_grid"]);
  for (const kind of ["design_analytic", "design_simulation", "assurance", "design_grid", "generate_population", "generate_patients", "weight_comparator"]) {
    assert.ok(vcrJobObjectKind(kind), `${kind} is about an object`);
  }
  // a job that is about no object of these five is not asked for one
  for (const kind of ["pool_evidence", "reconstruct_km", "accrual_forecast", "match_criteria", "profile_snapshot"]) assert.equal(vcrJobObjectKind(kind), null, kind);
});
