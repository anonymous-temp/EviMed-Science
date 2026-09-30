// The job queue's rules without a database: how a scenario is frozen and
// hashed, how a seed and a replicate count follow from the scenario rather than
// from a habit, what makes one job the same job as another, how a staged result
// is folded together, and which columns of a table a scenario reads. The engine
// channel has its own file (`vcrEngineClient.test.mjs`).
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_DERIVED_SOURCES, VCR_JOB_OPEN_STATES, VCR_JOB_TERMINAL_STATES, vcrIdempotencyKey, vcrMergeStageResult, vcrReplicatesForJob,
  vcrScenarioColumns, vcrScenarioHash, vcrSeedFor,
} from "../src/vcrJobs.mjs";
import { VCR_ENGINE_METHODS, VCR_REPLICATES_ALT_MIN, VCR_REPLICATES_NULL_MIN, canonicalScenarioJson, replicatesForMcse, vcrReplicateFloorFor } from "@evimed/domain";

const scenario = {
  design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 },
  endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.7, controlMedian: 6 },
  analysis: { method: "logrank", alpha: 0.025, sided: 1 },
  accrual: { kind: "uniform", duration: 12, followup: 12 },
  performance: ["power", "type_one_error"],
};

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
