// A real population is its rules on ONE snapshot. Three snapshots (A, B, C of the same source family) and one population on A:
// the population's result, counts and progress come from computations that read A and nothing else, and a computation that
// would read B or C beside it is refused before it is queued with the way out. An evaluation on PhysioNet 2012 once filed a
// cohort of all three sets under a population of set A (6,557 people where set A alone has 2,181).
import assert from "node:assert/strict";
import test from "node:test";

import { VcrJobs } from "../src/vcrJobs.mjs";
import { presentResearchProgress } from "../src/vcrResearchProgress.mjs";
import {
  VCR_COHORT_BINDING_CODE, vcrCohortBinding, vcrCohortInputIssue, vcrExecutionInputs, vcrPopulationsWithOwnResults, vcrSnapshotIdsOf,
} from "../src/vcrSnapshotBinding.mjs";
import { prepareVcrSubjectPopulation, resolveJobSubject } from "../src/vcrSubjects.mjs";

const RULES = [{ name: "icu24", rule: { op: "compare", column: "age", comparator: "gte", value: 18 } }];
const A = "snp_physionet_a";
const B = "snp_physionet_b";
const C = "snp_physionet_c";
const table = (/** @type {string} */ snapshot, shape = "subject") => ({ kind: "analysis_table", id: `${snapshot}:${shape}`, shape, location: `snapshots/${snapshot}/${shape}.csv`, hash: "a".repeat(64) });
const population = (/** @type {Record<string, any>} */ extra = {}) => ({ id: "pop_a", version: 1, kind: "real", snapshotId: A, definition: { rules: RULES }, resultId: "res_pop", ...extra });

test("the snapshots a computation read are the prefixes of its input ids, and a derived table names none", () => {
  assert.deepEqual(vcrSnapshotIdsOf([table(A), table(A, "long"), { kind: "snapshot_file", id: `${B}:1` }]), [A, B]);
  assert.deepEqual(vcrSnapshotIdsOf([{ kind: "snapshot", id: C }, { kind: "snapshot_file", id: "res_9:population", location: "derived/study/job/x.csv" }]), [C]);
  assert.deepEqual(vcrSnapshotIdsOf(null), []);
});

test("a result reads as the population's own only when every snapshot it read is the population's", () => {
  assert.equal(vcrCohortBinding(population(), [table(A)]).state, "matches");
  assert.equal(vcrCohortBinding(population(), [table(A), table(B), table(C)]).state, "other_snapshot");
  assert.deepEqual(vcrCohortBinding(population(), [table(B)]).snapshotIds, [B]);
  assert.equal(vcrCohortBinding(population(), []).state, "unverified", "unknown is not a mismatch");
  assert.equal(vcrCohortBinding(population({ snapshotId: null }), [table(A)]).state, "unbound");
  assert.equal(vcrCohortBinding(population({ kind: "scenario", snapshotId: null }), [table(A)]).state, "not_required");
});

test("a cohort job is refused before queueing when it reads another snapshot or other rules, and says how to go on", () => {
  assert.equal(vcrCohortInputIssue(population(), [{ kind: "snapshot", id: A }], { rules: RULES }), null);
  assert.equal(vcrCohortInputIssue(population({ kind: "scenario" }), [{ kind: "snapshot", id: B }]), null, "only a real population has a snapshot");
  const other = vcrCohortInputIssue(population(), [{ kind: "snapshot", id: A }, { kind: "snapshot", id: B }, { kind: "snapshot", id: C }]);
  assert.equal(other?.code, VCR_COHORT_BINDING_CODE);
  assert.match(other?.message ?? "", new RegExp(`${A}.*${B}.*${C}`), "names the population's snapshot and the ones it must not read");
  assert.match(other?.message ?? "", /新人群版本/, "names the way out");
  const rules = vcrCohortInputIssue(population(), [{ kind: "snapshot", id: A }], { rules: [{ ...RULES[0], rule: { ...RULES[0].rule, value: 65 } }] });
  assert.equal(rules?.code, VCR_COHORT_BINDING_CODE);
  assert.match(rules?.message ?? "", /规则/);
  assert.equal(vcrCohortInputIssue(population({ snapshotId: null }), [{ kind: "snapshot", id: A }])?.code, VCR_COHORT_BINDING_CODE);
});

test("a cohort job whose time zero or end of follow-up is another column than the population's is refused, as other rules are", () => {
  const defined = population({ definition: { rules: RULES, timeZero: { column: "ICUADMIT" }, exit: { column: "DEATHDATE" } } });
  const inputs = [{ kind: "snapshot", id: A }];
  assert.equal(vcrCohortInputIssue(defined, inputs, { rules: RULES, timeZero: { column: "ICUADMIT" }, exit: { column: "DEATHDATE" } }), null, "the same columns are the same definition");
  assert.equal(vcrCohortInputIssue(defined, inputs, { rules: RULES }), null, "a scenario that states neither takes the definition's");
  assert.equal(vcrCohortInputIssue(defined, inputs, {}), null);
  const zero = vcrCohortInputIssue(defined, inputs, { rules: RULES, timeZero: { column: "HOSPADMIT" } });
  assert.equal(zero?.code, VCR_COHORT_BINDING_CODE);
  assert.match(zero?.message ?? "", /时间零点列/);
  assert.match(zero?.message ?? "", /HOSPADMIT.*ICUADMIT/, "names the column asked for and the one saved");
  assert.match(zero?.message ?? "", /新的人群版本/, "names the way out");
  const exit = vcrCohortInputIssue(defined, inputs, { exit: { column: "DISCHARGE" } });
  assert.equal(exit?.code, VCR_COHORT_BINDING_CODE, "without rules too: the merge of the definition would let the caller's column win");
  assert.match(exit?.message ?? "", /随访结束列/);
  // a definition that names no such column has nothing for the scenario to disagree with
  assert.equal(vcrCohortInputIssue(population(), inputs, { rules: RULES, timeZero: { column: "ICUADMIT" } }), null);
  // only a real population's definition is held to it
  assert.equal(vcrCohortInputIssue({ ...defined, kind: "scenario" }, inputs, { timeZero: { column: "HOSPADMIT" } }), null);
});

/** A store that knows one population, as far as `resolveJobSubject` and the queue read it. */
const storeWith = (/** @type {Record<string, any>} */ row) => ({
  async populations() { return [row]; },
  async patientSets() { return []; }, async comparatorDesigns() { return []; }, async trialScenarios() { return []; }, async latestDesignGrid() { return null; },
});

test("the conversation's and the page's preparation pins a cohort to its population", async () => {
  const row = population();
  const store = storeWith(row);
  const study = { id: "study_1", userId: "u1" };
  const subject = await resolveJobSubject({ store, study, kind: "build_cohort", subjectId: row.id, scenario: {} });
  const prepare = (/** @type {any[]} */ inputs, /** @type {Record<string, any>} */ scenario = {}) =>
    prepareVcrSubjectPopulation({ store, study, kind: "build_cohort", subject, scenario, inputs });
  // nothing named: the population's snapshot and rules
  const own = await prepare([]);
  assert.deepEqual(own.inputs, [{ kind: "snapshot", id: A }]);
  assert.deepEqual(own.scenario, { rules: RULES });
  // the population's own snapshot named, and a scenario with the same rules plus run parameters, is the same cohort
  const same = await prepare([{ kind: "snapshot", id: A }], { rules: RULES, idColumn: "RecordID" });
  assert.deepEqual(same.inputs, [{ kind: "snapshot", id: A }]);
  assert.equal(same.scenario.idColumn, "RecordID");
  // A and B and C: refused, not narrowed to A (a run that asked for three sets is not answered with one, silently)
  await assert.rejects(prepare([{ kind: "snapshot", id: A }, { kind: "snapshot", id: B }, { kind: "snapshot", id: C }]), { code: VCR_COHORT_BINDING_CODE });
  await assert.rejects(prepare([{ kind: "snapshot", id: B }]), { code: VCR_COHORT_BINDING_CODE });
  await assert.rejects(prepare([], { rules: [{ name: "elderly", rule: { op: "compare", column: "age", comparator: "gte", value: 65 } }] }), { code: VCR_COHORT_BINDING_CODE });
});

test("the preparation does not let a caller's time zero win over the population's, and keeps the population's own when none is named", async () => {
  const row = population({ definition: { rules: RULES, timeZero: { column: "ICUADMIT" } } });
  const store = storeWith(row);
  const study = { id: "study_1", userId: "u1" };
  const subject = await resolveJobSubject({ store, study, kind: "build_cohort", subjectId: row.id, scenario: {} });
  const prepare = (/** @type {Record<string, any>} */ scenario) => prepareVcrSubjectPopulation({ store, study, kind: "build_cohort", subject, scenario, inputs: [] });
  await assert.rejects(prepare({ timeZero: { column: "HOSPADMIT" } }), { code: VCR_COHORT_BINDING_CODE });
  assert.deepEqual((await prepare({})).scenario.timeZero, { column: "ICUADMIT" });
  assert.deepEqual((await prepare({ timeZero: { column: "ICUADMIT" } })).scenario.timeZero, { column: "ICUADMIT" });
});

test("the queue refuses a cohort filed under a population that reads a snapshot beside its own, whoever asks", async () => {
  const row = population();
  const requested = [];
  const dataPlane = { async resolveEngineInputs(/** @type {any} */ request) { requested.push(request.snapshotId); return [table(request.snapshotId)]; } };
  const jobs = new VcrJobs({ store: storeWith(row), config: {}, dataPlane });
  const enqueue = (/** @type {any[]} */ inputs) => jobs.enqueue({ studyId: "study_1", userId: "u1", kind: "build_cohort", scenario: { rules: RULES }, inputs,
    detail: { subjectId: row.id, resultKind: "population" } });
  await assert.rejects(enqueue([{ kind: "snapshot", id: A }, { kind: "snapshot", id: B }, { kind: "snapshot", id: C }]), { code: VCR_COHORT_BINDING_CODE, status: 400 });
  await assert.rejects(enqueue([{ kind: "snapshot", id: C }]), { code: VCR_COHORT_BINDING_CODE });
  assert.deepEqual(requested, [A, B, C, C], "each snapshot was resolved for its own tables and none was queued");
});

// --- what the pages read -----------------------------------------------------------------------------------------------

/** The study as the progress presenter reads it: one population on A, the results of three computations and their executions. */
function study({ cohortInputs = [table(A)] } = {}) {
  const profile = (/** @type {string} */ snapshot, /** @type {number} */ patients, /** @type {string} */ id, /** @type {string} */ execution) => ({
    id, version: 1, kind: "snapshot_profile", subjectId: null, executionId: execution, counts: { realPatients: patients },
    diagnostics: { tables: [{ input: `${snapshot}:subject`, shape: "subject", valueSource: "observed", rows: patients, columns: [] }] },
  });
  // newest first, as the store hands them: the profile of C was the last profile written, so it superseded those of B and A
  const results = [
    profile(C, 4000, "profile_c", "ex_pc"), profile(B, 4000, "profile_b", "ex_pb"), profile(A, 4000, "profile_a", "ex_pa"),
    { id: "res_pop", version: 1, kind: "population", subjectId: "pop_a", executionId: "ex_cohort", conclusion: "estimable", counts: { realPatients: cohortInputs.length > 1 ? 6557 : 2181 }, diagnostics: {} },
  ];
  const profileExecution = (/** @type {string} */ snapshot) => ({ method: "profile.snapshot", methodVersion: "1.1.0", inputs: [{ kind: "analysis_table", id: `${snapshot}:subject` }] });
  return {
    populations: [population()], results, allResults: results, stale: [], jobs: [],
    taskInputs: { cohort: { status: "available", sources: [{ snapshotId: A }, { snapshotId: B }, { snapshotId: C }] } },
    executions: new Map([
      ["ex_pa", profileExecution(A)], ["ex_pb", profileExecution(B)], ["ex_pc", profileExecution(C)],
      ["ex_cohort", { method: "cohort.build", methodVersion: "1.1.0", inputs: cohortInputs.map(({ kind, id }) => ({ kind, id })) }],
    ]),
  };
}

test("the progress of a population on A counts A's computation and A's profile, wherever the other profiles sit", () => {
  const bundle = study();
  const progress = presentResearchProgress(bundle);
  assert.equal(progress.calculation, "available");
  assert.equal(progress.resultId, "res_pop");
  assert.equal("resultNotCounted" in progress, false);
  assert.equal(progress.counts.realPatients, 2181);
  assert.equal(progress.counts.sourcePatients, 4000, "A's own profile, though two later profiles superseded it in the current list");
  // the same study, with the current list as the store holds it (superseded results are not in it)
  const current = { ...bundle, results: bundle.results.filter(row => row.id !== "profile_a" && row.id !== "profile_b"), allResults: bundle.results };
  assert.equal(presentResearchProgress(current).counts.sourcePatients, 4000);
});

test("a result computed on A, B and C is not counted under the population on A, and the page says why", () => {
  const bundle = study({ cohortInputs: [table(A), table(B), table(C)] });
  const progress = presentResearchProgress(bundle);
  assert.equal(progress.calculation, "none", "no result of its own yet");
  assert.equal(progress.resultId, null);
  assert.equal(progress.counts.realPatients, null, "not 6,557, and not a zero");
  assert.deepEqual(progress.resultNotCounted, { reason: "other_snapshot", resultId: "res_pop", snapshotIds: [A, B, C] });
  assert.equal(progress.counts.sourcePatients, 4000, "the source table of A is still A's");
});

test("the service takes a result of another snapshot off the population before any page reads it, and keeps it in the record", () => {
  const bundle = study({ cohortInputs: [table(A), table(B), table(C)] });
  const [bound] = vcrPopulationsWithOwnResults(bundle.populations, bundle.allResults, bundle.executions);
  assert.equal(bound.resultId, null);
  assert.deepEqual(bound.resultOtherSnapshot, { resultId: "res_pop", snapshotIds: [A, B, C] });
  assert.ok(bundle.allResults.some(row => row.id === "res_pop"), "history is kept");
  const read = presentResearchProgress({ ...bundle, populations: [bound] });
  assert.equal(read.calculation, "none");
  assert.equal(read.resultNotCounted?.reason, "other_snapshot");
  // a result that read only A is left alone
  const own = study();
  assert.equal(vcrPopulationsWithOwnResults(own.populations, own.allResults, own.executions)[0].resultId, "res_pop");
  // a recomputation on B is a new version of the population: the old version still has its own result
  const next = { ...population({ id: "pop_b", version: 2, snapshotId: B, resultId: "res_b" }) };
  const results = [...own.allResults, { id: "res_b", executionId: "ex_b", kind: "population", subjectId: "pop_b" }];
  const executions = new Map([...own.executions, ["ex_b", { inputs: [{ kind: "analysis_table", id: `${B}:subject` }] }]]);
  const both = vcrPopulationsWithOwnResults([next, ...own.populations], results, executions);
  assert.deepEqual(both.map(row => row.resultId), ["res_b", "res_pop"]);
});

test("a result with no recorded execution is not guessed to be another snapshot's", () => {
  const bundle = study();
  const [kept] = vcrPopulationsWithOwnResults(bundle.populations, bundle.allResults, new Map());
  assert.equal(kept.resultId, "res_pop");
});

// The service reads an execution's inputs from its row and keeps only what a reader needs. A derived table's input id
// (`<result id>:<table>`) reads like a snapshot's, so dropping the location made a valid result look like it had read a second snapshot.
test("an execution keeps where each input sat, so a derived table beside the population's snapshot is not taken for another snapshot", () => {
  const derived = { kind: "snapshot_file", id: "res_9:population", location: "derived/study_1/job_1/population.csv", hash: "d".repeat(64), valueSource: "synthetic" };
  const stored = [table(A), derived, { kind: "reference", id: "asm_1" }, { kind: "analysis_table", id: 5 }];
  const kept = vcrExecutionInputs(stored);
  assert.deepEqual(kept, [
    { kind: "analysis_table", id: `${A}:subject`, location: `snapshots/${A}/subject.csv` },
    { kind: "snapshot_file", id: "res_9:population", location: "derived/study_1/job_1/population.csv" },
  ], "table inputs only, with their kind, id and location and nothing else (no hash, no value source)");
  assert.deepEqual(vcrSnapshotIdsOf(kept), [A], "the derived table names no snapshot");
  // a stored row from before the location was recorded still reads
  assert.deepEqual(vcrExecutionInputs([{ kind: "analysis_table", id: `${A}:subject` }]), [{ kind: "analysis_table", id: `${A}:subject` }]);
  assert.deepEqual(vcrExecutionInputs(null), []);
  // the result is kept on its population
  const results = [{ id: "res_pop", executionId: "ex_cohort", kind: "population", subjectId: "pop_a" }];
  const executions = new Map([["ex_cohort", { method: "cohort.build", inputs: kept }]]);
  assert.equal(vcrPopulationsWithOwnResults([population()], results, executions)[0].resultId, "res_pop", "a valid result is not hidden");
  // and without the location (as the service used to hold it) the same result was hidden
  const stripped = new Map([["ex_cohort", { method: "cohort.build", inputs: kept.map(({ kind, id }) => ({ kind, id })) }]]);
  assert.equal(vcrPopulationsWithOwnResults([population()], results, stripped)[0].resultId, null);
});
