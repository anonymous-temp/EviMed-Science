// The job queue's rules without a database: how a scenario is frozen and
// hashed, how a seed and a replicate count follow from the scenario rather than
// from a habit, what makes one job the same job as another, how a staged result
// is folded together, and which columns of a table a scenario reads. The engine
// channel has its own file (`vcrEngineClient.test.mjs`).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { vcrBiasEstimateOf } from "../src/vcrBiasAnalysis.mjs";
import {
  VcrJobs, VCR_DERIVED_SOURCES, VCR_JOB_OPEN_STATES, VCR_JOB_TERMINAL_STATES, vcrIdempotencyKey, vcrMergeStageResult, vcrReplicatePlanForJob, vcrReplicatesForJob,
  VCR_RECONSTRUCTION_REFERENCE, vcrBindReconstruction, vcrBindScientificInputUnits, vcrEngineStoppedError, vcrErrorFromIssues, vcrFailureReason, vcrResultKindFor, vcrScenarioColumns, vcrScenarioHash, vcrSeedFor,
} from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { VCR_MINIMAL_TEMPLATES, VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_ENGINE_METHODS, VCR_REPLICATES_ALT_MIN, VCR_REPLICATES_NULL_MIN, canonicalScenarioJson, replicatesForMcse, vcrReplicateFloorFor } from "@evimed/domain";

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

test("a zero-effect check belongs to the simulation it was run for: it does not land beside another's power, and a simulation that lands takes an earlier one's check away", () => {
  const stage = (/** @type {string} */ name, /** @type {string} */ jobId, /** @type {Record<string, any>} */ over = {}) => ({ stage: name, jobId, method: "design.simulate", methodVersion: "1.2.0", ...over });
  const simulated = (/** @type {number} */ power) => ({ conclusion: "estimable", notEstimableRule: null, counts: { realPatients: 0, generatedRecords: 5000 },
    measures: [{ name: "power", value: power, mcse: 0.005 }], diagnostics: {}, tables: [] });
  const checked = (/** @type {number} */ error) => ({ conclusion: "estimable", notEstimableRule: null, counts: { realPatients: 0, generatedRecords: 20000 },
    measures: [{ name: "type_one_error", value: error, mcse: 0.001 }], diagnostics: {}, tables: [] });
  const filed = (/** @type {any} */ merged) => ({ id: "res_1", ...merged });
  const names = (/** @type {any} */ merged) => merged.measures.map((/** @type {any} */ measure) => `${measure.name}=${measure.value}`).sort();
  const first = vcrMergeStageResult(null, simulated(0.81), stage("simulation", "job_a"));
  const withCheck = vcrMergeStageResult(/** @type {any} */ (filed(first)), checked(0.0243), stage("simulation_null", "job_a0", { checkOf: "job_a" }));
  assert.deepEqual(names(withCheck), ["power=0.81", "type_one_error=0.0243"], "the check of the simulation beside it lands");
  // another simulation lands: the figure of the first one's check leaves with it, and the stage record too
  const second = vcrMergeStageResult(/** @type {any} */ (filed(withCheck)), simulated(0.9), stage("simulation", "job_b"));
  assert.deepEqual(names(second), ["power=0.9"], "a type I error computed for another scenario is not shown beside this power");
  assert.deepEqual(second.diagnostics.stages.map((/** @type {any} */ entry) => entry.stage), ["simulation"]);
  assert.deepEqual(Object.keys(second.diagnostics.stageResults), ["simulation"]);
  // the check of the first simulation lands late, after the second: it is not a figure of this result
  const late = vcrMergeStageResult(/** @type {any} */ (filed(second)), checked(0.0243), stage("simulation_null", "job_a0", { checkOf: "job_a" }));
  assert.deepEqual(names(late), ["power=0.9"]);
  assert.deepEqual(late.diagnostics.stages.map((/** @type {any} */ entry) => entry.stage), ["simulation"]);
  // and the check of the second one does
  const own = vcrMergeStageResult(/** @type {any} */ (filed(second)), checked(0.0251), stage("simulation_null", "job_b0", { checkOf: "job_b" }));
  assert.deepEqual(names(own), ["power=0.9", "type_one_error=0.0251"]);
  // a check that names no simulation (the programme's, or one made before checks named theirs) is kept as it always was
  const unnamed = vcrMergeStageResult(/** @type {any} */ (filed(first)), checked(0.0243), stage("simulation_null", "job_n"));
  assert.deepEqual(names(vcrMergeStageResult(/** @type {any} */ (filed(unnamed)), simulated(0.9), stage("simulation", "job_b"))), ["power=0.9", "type_one_error=0.0243"]);
});

test("a zero-effect check that lands after the result adds its figure and never replaces the result's (A1)", () => {
  const stage = (name) => ({ stage: name, jobId: `job_${name}`, method: "design.simulate", methodVersion: "1.2.0" });
  const alternative = vcrMergeStageResult(null, { conclusion: "estimable", notEstimableRule: null, counts: { realPatients: 0, generatedRecords: 5000 },
    measures: [{ name: "power", value: 0.81, mcse: 0.0055 }, { name: "expected_sample_size", value: 180, mcse: 0 }],
    diagnostics: { isNullScenario: false, replicatesPlanned: 5000, powerCurve: { series: [] }, analyticCheck: { name: "power", value: 0.8, withinThreeMcse: true } },
    tables: [{ name: "replicates", sha256: "a".repeat(64) }] }, stage("simulation"));
  const filed = (/** @type {any} */ merged) => ({ id: "res_1", ...merged });
  const check = (/** @type {Record<string, any>} */ over = {}) => ({ conclusion: "estimable", notEstimableRule: null, counts: { realPatients: 0, generatedRecords: 20000 },
    measures: [{ name: "type_one_error", value: 0.0243, mcse: 0.0011 }, { name: "expected_sample_size", value: 175, mcse: 0 }],
    diagnostics: { isNullScenario: true, replicatesPlanned: 20000, analyticCheck: { name: "type_one_error", value: 0.025, basis: "nominal_alpha", withinThreeMcse: true } },
    tables: [{ name: "replicates", sha256: "b".repeat(64) }], ...over });
  const merged = vcrMergeStageResult(/** @type {any} */ (filed(alternative)), check(), stage("simulation_null"));
  // The figure the check is for is added; the result's own are not taken over by the null run's.
  assert.deepEqual(merged.measures.map((measure) => measure.name).sort(), ["expected_sample_size", "power", "type_one_error"]);
  assert.equal(merged.measures.find((measure) => measure.name === "expected_sample_size").value, 180, "the alternative's, not the null run's");
  assert.equal(merged.diagnostics.isNullScenario, false, "the result's own summaries stand");
  assert.equal(merged.diagnostics.replicatesPlanned, 5000);
  assert.deepEqual(merged.counts, { realPatients: 0, generatedRecords: 5000 });
  assert.equal(merged.conclusion, "estimable");
  assert.ok(merged.diagnostics.powerCurve, "and so is the power curve");
  // The check keeps its own record: its measures, its summaries, its closed-form check, its table.
  const own = merged.diagnostics.stageResults.simulation_null;
  assert.equal(own.measures.find((measure) => measure.name === "type_one_error").mcse, 0.0011);
  assert.equal(own.diagnostics.analyticCheck.basis, "nominal_alpha");
  assert.equal(own.measures.find((measure) => measure.name === "expected_sample_size").value, 175);
  assert.equal(merged.diagnostics.stageResults.simulation.diagnostics.analyticCheck.name, "power", "the alternative's check is its own");
  // A check that could not be estimated limits the result and does not void it; one that was limited does the same.
  const broken = vcrMergeStageResult(/** @type {any} */ (filed(alternative)), check({ conclusion: "not_estimable", notEstimableRule: "design_effect_null", measures: [] }), stage("simulation_null"));
  assert.equal(broken.conclusion, "limited");
  assert.equal(broken.notEstimableRule, null, "the check's rule is not the result's");
  assert.deepEqual(broken.measures.map((measure) => measure.name).sort(), ["expected_sample_size", "power"]);
  // A cancelled check (a partial run) is a stage record like any other, flagged, and the result is the alternative's still.
  const partial = vcrMergeStageResult(/** @type {any} */ (filed(alternative)), check({ conclusion: "limited", diagnostics: { partial: true, canceled: true, replicatesCompleted: 8000 } }), stage("simulation_null"));
  assert.equal(partial.diagnostics.partial, undefined, "the result is not marked partial because its check was");
  assert.equal(partial.diagnostics.stageResults.simulation_null.diagnostics.partial, true);
  assert.equal(partial.conclusion, "limited");
});

test("the null floor rises with the intended use and for a borrowing design; the alternative's does not (decision 3)", () => {
  const nullCase = { ...scenario, truth: { hazardRatio: 1, controlMedian: 6 } };
  for (const use of ["exploratory", "design_support"]) assert.equal(vcrReplicatesForJob("design_simulation", nullCase, null, { intendedUse: use }), VCR_REPLICATES_NULL_MIN, use);
  for (const use of ["specified_analysis", "submission_preparation"]) assert.equal(vcrReplicatesForJob("design_simulation", nullCase, null, { intendedUse: use }), 100_000, use);
  assert.equal(vcrReplicatesForJob("design_simulation", nullCase, null), VCR_REPLICATES_NULL_MIN, "no use stated is an exploration");
  // Only the null case is held to the larger number.
  assert.equal(vcrReplicatesForJob("design_simulation", scenario, null, { intendedUse: "submission_preparation" }), VCR_REPLICATES_ALT_MIN);
  // An external-control design borrows, whatever it is for; so does the MAP prior's table of operating characteristics.
  const external = { design: { kind: "single_arm_external", n: 100 }, endpoint: { type: "binary" },
    truth: { controlRates: [0.3, 0.4], treatmentRates: [0.3, 0.4] }, external: { targetPrevalence: 0.5 } };
  assert.equal(vcrReplicatesForJob("design_simulation", external, null, { intendedUse: "exploratory" }), 100_000);
  assert.equal(vcrReplicatesForJob("map_prior", { operatingCharacteristics: { nControl: 100, nTreatment: 100, drifts: [0, 0.5], effect: 0.8 } }, null, { intendedUse: "exploratory" }), 100_000);
  assert.equal(vcrReplicatesForJob("map_prior", { operatingCharacteristics: {} }, 150_000, { intendedUse: "exploratory" }), 150_000, "what was asked can raise it");
  assert.equal(vcrReplicatesForJob("map_prior", { historical: {} }, null), null, "a MAP prior with no table has no replicates");
  // What set the number is kept with the job, and a precision the scenario asked for outranks the use when it needs more.
  assert.deepEqual(vcrReplicatePlanForJob("design_simulation", nullCase, null, { intendedUse: "specified_analysis" }),
    { replicates: 100_000, floor: 100_000, basis: "intended_use", intendedUse: "specified_analysis", targetMcse: null });
  assert.equal(vcrReplicatePlanForJob("design_simulation", nullCase, null, { intendedUse: "exploratory" })?.basis, "default");
  assert.equal(vcrReplicatePlanForJob("design_simulation", { ...nullCase, targetMcse: 0.0004 }, null, { intendedUse: "specified_analysis" })?.basis, "target_mcse");
  assert.equal(vcrReplicatePlanForJob("map_prior", { operatingCharacteristics: {} }, null)?.basis, "borrowing");
  // A grid is held to its worst cell, at the use's floor.
  const grid = { ...scenario, truths: [{ hazardRatio: 0.7, controlMedian: 6 }, { hazardRatio: 1, controlMedian: 6 }] };
  assert.equal(vcrReplicatesForJob("design_grid", grid, null, { intendedUse: "specified_analysis" }), 100_000);
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


test("a survival-baseline fit binds a verified reconstruction to inputId without widening comparator sources", () => {
  const entry = { resultId: "res_1", table: "reconstructed-ipd", bindTo: "inputId" };
  const resolved = { id: "res_1:reconstructed-ipd", valueSource: "reconstructed" };
  assert.deepEqual(vcrBindReconstruction("fit_survival_model", { distribution: "weibull" }, [entry], [resolved]),
    { ok: true, scenario: { distribution: "weibull", inputId: resolved.id } });
  assert.equal(vcrBindReconstruction("fit_survival_model", { inputId: "forged" }, [entry], [resolved]).ok, false);
  assert.equal(vcrBindReconstruction("weight_comparator", {}, [entry], [resolved]).ok, false);
  assert.equal(vcrBindReconstruction("fit_survival_model", {}, [entry], [{ ...resolved, valueSource: "synthetic" }]).ok, false);
  assert.equal(vcrResultKindFor("fit_survival_model"), "model_fit");
  assert.equal(vcrResultKindFor("apply_prognostic_model"), "model_prediction");
});

test('frozen observed-table units replace caller labels, while synthetic units stay declared assumptions',()=>{
  const scenario={inputId:'snp:1',inputUnits:{age:'years'},model:{terms:[{column:'age',unit:'years',transform:'identity'}]}};
  const input={id:'snp:1',valueSource:'observed',columnUnits:{age:'months'}};
  const bound=vcrBindScientificInputUnits('model.prognostic_apply',scenario,[input]);assert.equal(bound.scenario.inputUnits.age,'months');assert.equal(bound.detail.basis,'frozen_snapshot_field_map');
  const missing=vcrBindScientificInputUnits('model.prognostic_apply',scenario,[{...input,columnUnits:{}}]);assert.equal(missing.scenario.inputUnits.age,'unknown');
  const synthetic=vcrBindScientificInputUnits('model.prognostic_apply',scenario,[{...input,valueSource:'synthetic'}]);assert.equal(synthetic.scenario.inputUnits.age,'years');assert.equal(synthetic.detail.basis,'declared_synthetic_scenario');
  assert.throws(()=>vcrBindScientificInputUnits('model.survival_fit',{inputId:'snp:1',timeColumn:'age',timeUnit:'years'},[input]),{code:'vcr_model_not_applicable'});
});

// --- the check that queues nothing (C1) ----------------------------------------------------------------------------------------

/** A queue that cannot reach a database: `validate` must not need one beyond the study's intended use. @param {string | null} [intendedUse] */
const queue = (intendedUse = null) => {
  /** @type {string[]} */
  const touched = [];
  const store = new Proxy({}, { get: (_target, name) => async () => { touched.push(String(name)); if (name === "studyById") return { intendedUse }; throw new Error(`validate reached ${String(name)}`); } });
  return Object.assign(new VcrJobs({ store, config: { vcrJobCpuSeconds: 600 } }), { touched });
};

test("validate answers a valid scenario with its defaults, its replicate count and what set it, its cost class, and reaches no store", async () => {
  const jobs = queue();
  const answer = await jobs.validate({ kind: "design_simulation", scenario });
  assert.deepEqual([answer.action, answer.queued, answer.checked, answer.valid, answer.issues], ["validate", false, true, true, []]);
  assert.deepEqual(answer.scenario, scenario, "a scenario with nothing to canonicalise is returned as stated");
  assert.equal(answer.replicates.count, 5000);
  assert.match(answer.replicates.reason, /the default floor for an alternative/);
  assert.deepEqual(answer.cost, { class: "heavy", cpuSecondsLimit: 600 });
  assert.equal(answer.seed, vcrSeedFor(vcrScenarioHash(scenario)));
  // The same list a started job carries as `applied`: the dropout nobody wrote is there.
  const applied = Object.fromEntries(answer.applied.map((entry) => [entry.field, entry.value]));
  assert.equal(applied["accrual.dropoutAnnual"], 0);
  assert.deepEqual(jobs.touched, [], "nothing was read or written");
  // A zero-effect scenario carries the floor of its case; the study's intended use raises it; what the run asked for raises it again.
  const nullCase = { ...scenario, truth: { hazardRatio: 1, controlMedian: 6 } };
  assert.equal((await jobs.validate({ kind: "design_simulation", scenario: nullCase })).replicates.count, VCR_REPLICATES_NULL_MIN);
  const specified = queue("specified_analysis");
  const sized = await specified.validate({ kind: "design_simulation", scenario: nullCase, studyId: "std_1" });
  assert.equal(sized.replicates.count, 100_000);
  assert.match(sized.replicates.reason, /intended use \(specified_analysis\)/);
  assert.match((await jobs.validate({ kind: "design_simulation", scenario, replicates: 20_000 })).replicates.reason, /the count you asked for/);
  // A closed-form size has no replicates.
  const analytic = await jobs.validate({ kind: "design_analytic", scenario: { design: { kind: "two_arm_fixed" }, endpoint: { type: "binary" }, truth: { controlRate: 0.3, treatmentRate: 0.45 } } });
  assert.equal(analytic.valid, true);
  assert.equal(analytic.replicates, undefined);
  assert.deepEqual(analytic.cost, { class: "light", cpuSecondsLimit: 600 });
});

test("validate refuses by path what a start would refuse, and an unknown key or a missing fact is the same refusal in both", async () => {
  const jobs = queue();
  const refused = await jobs.validate({ kind: "design_simulation", scenario: { ...scenario, accrual: { kind: "uniform", duration: 12, followup: 12, months: 18 } } });
  assert.equal(refused.valid, false);
  assert.deepEqual(refused.queued, false);
  assert.ok(refused.issues.some((issue) => issue.field === "scenario.accrual.months" && issue.code === "scenario_field_unknown"), JSON.stringify(refused.issues));
  const missing = await jobs.validate({ kind: "design_simulation", scenario: { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "time_to_event" }, truth: { controlMedian: 12 } } });
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((issue) => /hazardRatio/.test(issue.field)), JSON.stringify(missing.issues));
  // The check an enqueue makes of the inputs a caller names is made here too.
  const forged = await jobs.validate({ kind: "weight_comparator", scenario: { covariates: ["age"] }, inputs: [{ kind: "snapshot", id: "snp_1", location: "../x" }] });
  assert.equal(forged.valid, false);
  assert.ok(forged.issues.some((issue) => issue.code === "input_location_forbidden"));
  assert.ok(forged.issues.length <= 20);
  await assert.rejects(jobs.validate({ kind: "no_such_kind", scenario: {} }), { code: "vcr_job_kind_invalid" });
});

test("a kind the platform completes at start is not checked and says so rather than guessing", async () => {
  const jobs = queue();
  for (const kind of ["literature_population", "reconstruct_km", "maic_time_to_event_comparator", "apply_prognostic_model", "pool_evidence", "match_criteria", "forecast_trajectories"]) {
    const answer = await jobs.validate({ kind, scenario: {} });
    assert.deepEqual([answer.checked, answer.queued, answer.valid], [false, false, undefined], kind);
    assert.match(answer.message, /启动时/, kind);
  }
});

test("validate and enqueue agree on a scenario: what validate accepts, the engine's own validator accepts", async () => {
  const jobs = queue();
  for (const [kind, method] of [["design_simulation", "design.simulate"], ["design_analytic", "design.analytic"]]) {
    for (const template of VCR_MINIMAL_TEMPLATES[method]) {
      const answer = await jobs.validate({ kind, scenario: template.scenario });
      assert.equal(answer.valid, true, `${kind} ${template.name}: ${JSON.stringify(answer.issues)}`);
    }
  }
});

test("validate leaves the names of a job's inputs to the start that resolves them, and judges everything else of the scenario", async () => {
  const jobs = queue();
  // `inputId` names the snapshot's table, which the platform resolves at start: the key being absent from an empty list is not a refusal.
  const survival = await jobs.validate({ kind: "fit_survival_model", scenario: { inputId: "snp_1", idColumn: "USUBJID", timeColumn: "AVAL", statusColumn: "CNSR", statusEncoding: "censor", distribution: "weibull", timeUnit: "months", horizons: [6, 12] }, inputs: [{ kind: "snapshot", id: "snp_1" }] });
  assert.deepEqual([survival.valid, survival.issues], [true, []]);
  const bad = await jobs.validate({ kind: "fit_survival_model", scenario: { inputId: "snp_1", idColumn: "USUBJID", timeColumn: "AVAL", statusColumn: "CNSR", statusEncoding: "censor", distribution: "gamma", timeUnit: "months", horizons: [6, 12] }, inputs: [{ kind: "snapshot", id: "snp_1" }] });
  assert.equal(bad.valid, false);
  assert.ok(bad.issues.every((issue) => issue.field !== "scenario.inputId"));
});

/** A committed real engine result, filed as the primary stage of a comparison. */
const primaryOf = (/** @type {string} */ name, /** @type {string} */ jobId, /** @type {string} */ method) => {
  const result = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  const incoming = { conclusion: result.conclusion, notEstimableRule: result.notEstimableRule ?? null, counts: result.counts, measures: result.measures, diagnostics: result.diagnostics, tables: result.tables ?? [] };
  return { incoming, stage: { stage: "primary", jobId, method, methodVersion: "1.5.0" } };
};

test("a stage landing again replaces what that stage wrote before: a rerun without the trimming keeps none of its measures, limit or sentence (review RF2 P0-3)", () => {
  const first = primaryOf("vcr-bias-analysis/trim-weighting", "job_1", "comparator.propensity_weight");
  const landed = vcrMergeStageResult(null, first.incoming, first.stage);
  assert.ok(landed.measures.some((measure) => measure.name === "trimmed_treated") && landed.diagnostics.trim && landed.conclusion === "limited");
  const prior = /** @type {any} */ ({ id: "res_1", ...landed });
  // the same scenario without a trimming: the weighted comparison of everybody, which the engine leaves without `trim`, the trimmed_* measures and the limit
  const untrimmed = structuredClone(first.incoming);
  untrimmed.measures = untrimmed.measures.filter((measure) => !String(measure.name).startsWith("trimmed_"));
  delete untrimmed.diagnostics.trim;
  untrimmed.diagnostics.limitedBy = [];
  untrimmed.conclusion = "estimable";
  const rerun = vcrMergeStageResult(prior, untrimmed, { ...first.stage, jobId: "job_2" });
  assert.deepEqual(rerun.measures.map((measure) => measure.name), untrimmed.measures.map((measure) => measure.name), "the measures of this run and nothing of the last");
  assert.equal(rerun.diagnostics.trim, undefined, "the restatement of a trimming that did not happen is gone");
  assert.deepEqual(rerun.diagnostics.limitedBy, []);
  assert.equal(rerun.conclusion, "estimable", "the replaced stage's limit is not a vote");
  assert.deepEqual(rerun.diagnostics.stages.map((entry) => `${entry.stage}:${entry.jobId}`), ["primary:job_2"]);
  assert.deepEqual(Object.keys(rerun.diagnostics.stageResults), ["primary"]);
  // a stage that is not this one is left alone: a bias analysis landed beside the primary stays through a rerun of the primary
  const bias = JSON.parse(readFileSync(new URL("./fixtures/vcr-bias-analysis/bias-ratio.json", import.meta.url), "utf8"));
  const withBias = vcrMergeStageResult(/** @type {any} */ ({ id: "res_1", ...rerun }), { conclusion: bias.conclusion, notEstimableRule: null, counts: bias.counts, measures: bias.measures, diagnostics: bias.diagnostics, tables: [] },
    { stage: "bias_analysis", jobId: "job_3", method: "comparator.bias_analysis", methodVersion: "1.0.0" });
  const again = vcrMergeStageResult(/** @type {any} */ ({ id: "res_1", ...withBias }), untrimmed, { ...first.stage, jobId: "job_4" });
  assert.ok(again.diagnostics.biasAnalysis && again.measures.some((measure) => measure.name === "bias_tipping_limit"), "the other stage's record and numbers stand");
  assert.deepEqual(again.diagnostics.stages.map((entry) => entry.stage).sort(), ["bias_analysis", "primary"]);
});

test("a different method landing as the primary stage of a comparison leaves nothing of the first method's numbers, and a bias analysis reads the current primary (review RF2 P0-3)", () => {
  const first = primaryOf("vcr-bias-analysis/trim-weighting", "job_1", "comparator.propensity_weight");
  const weighting = vcrMergeStageResult(null, first.incoming, first.stage);
  const emulation = primaryOf("vcr-target-trial/sequential", "job_2", "comparator.target_trial");
  const merged = vcrMergeStageResult(/** @type {any} */ ({ id: "res_1", ...weighting }), emulation.incoming, emulation.stage);
  assert.deepEqual(merged.measures.map((measure) => measure.name), emulation.incoming.measures.map((measure) => measure.name));
  const leftOver = Object.keys(first.incoming.diagnostics).filter((key) => !(key in emulation.incoming.diagnostics) && key in merged.diagnostics);
  assert.deepEqual(leftOver, [], "no diagnostics key of the weighting is left beside the emulation's");
  assert.equal(merged.diagnostics.trim, undefined);
  assert.ok(merged.diagnostics.targetTrial);
  assert.equal(merged.conclusion, emulation.incoming.conclusion);
  assert.equal(merged.counts.effectiveSampleSize, emulation.incoming.counts.effectiveSampleSize ?? undefined, "a count the weighting wrote and the emulation does not is not left");
  // the estimate a bias analysis takes is the target trial's, not the weighted difference of the method that was there
  const taken = vcrBiasEstimateOf({ ...merged });
  assert.equal(taken?.measure, "risk_ratio_itt");
  assert.notEqual(taken?.measure, "weighted_difference");
  // and a result that still holds both (written before stages were kept apart) is read by its primary stage only
  const stale = { measures: [...weighting.measures, ...emulation.incoming.measures], diagnostics: { stageResults: { primary: { measures: emulation.incoming.measures, diagnostics: emulation.incoming.diagnostics } } } };
  assert.equal(vcrBiasEstimateOf(stale)?.measure, "risk_ratio_itt");
});
