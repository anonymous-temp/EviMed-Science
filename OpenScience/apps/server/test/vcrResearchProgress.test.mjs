import assert from "node:assert/strict";
import { test } from "node:test";
import { presentResearchProgress } from "../src/vcrResearchProgress.mjs";

const population = { id: "p1", version: 1, snapshotId: "s1", resultId: null };
const base = () => ({ populations: [population], results: [], stale: [], jobs: [], taskInputs: { cohort: { status: "unknown" } } });
test("a saved definition and unknown input do not become a computed result", () => {
  const result = presentResearchProgress(base());
  assert.equal(result.definition, "saved"); assert.equal(result.input, "unknown"); assert.equal(result.calculation, "none");
});
test("input failure and a failed calculation stay separate from files", () => {
  const bundle = base(); bundle.taskInputs.cohort.status = "missing"; bundle.jobs = [{ state: "failed", checkpoint: { subjectId: "p1" } }];
  assert.equal(presentResearchProgress(bundle).calculation, "failed"); assert.equal(presentResearchProgress(bundle).input, "missing");
});
test("a matched snapshot profile and a generated result keep distinct counts", () => {
  const bundle = base(); bundle.populations = [{ ...population, resultId: "r1" }];
  bundle.results = [
    { id: "r1", version: 1, kind: "population", subjectId: "p1", conclusion: "estimable", counts: { generatedRecords: 200 }, diagnostics: {} },
    { id: "r2", version: 1, kind: "snapshot_profile", subjectId: null, executionId: "ep", counts: { realPatients: 78 }, diagnostics: { tables: [{ input: "s1:longitudinal", shape: "long", valueSource: "observed", rows: 4407, columns: [{ column: "age", mean: 66, median: 71, meanMedianDirection: "mean_below_median" }] }] } },
    { id: "other", version: 1, kind: "snapshot_profile", subjectId: "other", counts: { realPatients: 999 } },
  ];
  bundle.executions = new Map([["ep", { method: "profile.snapshot", methodVersion: "1.1.0", inputs: [{ kind: "analysis_table", id: "s1:longitudinal" }] }]]);
  const p = presentResearchProgress(bundle); assert.equal(p.calculation, "available"); assert.deepEqual(p.counts, { sourcePatients: 78, realPatients: null, observations: 4407, generatedRecords: 200, reconstructedPseudoPatients: null }); assert.equal(p.profileStatistics[0].median, 71);
  bundle.stale = [{ node: "result:r1@1" }]; assert.equal(presentResearchProgress(bundle).calculation, "stale");
  bundle.stale = []; bundle.results[0].conclusion = "not_estimable"; assert.equal(presentResearchProgress(bundle).calculation, "not_estimable");
  bundle.results[0].conclusion = "limited"; assert.equal(presentResearchProgress(bundle).calculation, "limited");
});

test("available input must match the current population snapshot", () => {
  const b = base(); b.taskInputs.cohort = { status: "available", sources: [{ snapshotId: "other" }] };
  assert.equal(presentResearchProgress(b).input, "missing");
  b.taskInputs.cohort.partial = true; assert.equal(presentResearchProgress(b).input, "unknown");
  b.taskInputs.cohort.sources = [{ snapshotId: "s1" }]; assert.equal(presentResearchProgress(b).input, "available");
  b.populations = [{ ...population, snapshotId: null }]; assert.equal(presentResearchProgress(b).input, "unknown");
});

test("source and selected cohort counts remain separate, and mismatched result and job versions do not attach", () => {
  const b = base(); b.populations = [{ ...population, kind: "real", version: 2, resultId: "r1" }];
  b.results = [{ id: "r1", version: 1, kind: "population", subjectId: "p1", executionId: "ec", counts: { realPatients: 52 }, conclusion: "estimable" },
    { id: "r2", version: 1, kind: "snapshot_profile", subjectId: null, executionId: "ep", counts: { realPatients: 80 }, diagnostics: { tables: [{ input: "s1:subject" }] } }];
  b.executions = new Map([["ep", { method: "profile.snapshot", methodVersion: "1.1.0", inputs: [{ kind: "analysis_table", id: "s1:subject" }] }], ["ec", { method: "cohort.build", methodVersion: "1.1.0" }]]);
  b.jobs = [{ state: "failed", checkpoint: { subjectId: "p1", configurationVersion: 1 } }];
  const p = presentResearchProgress(b); assert.equal(p.counts.sourcePatients, 80); assert.equal(p.counts.realPatients, 52); assert.equal(p.calculation, "available");
  b.executions.get("ec").methodVersion = "1.0.0"; assert.equal(presentResearchProgress(b).counts.realPatients, null);
  b.executions.get("ec").methodVersion = "1.1.0";
  b.results[0].subjectId = "other"; assert.equal(presentResearchProgress(b).calculation, "none");
  b.results[0].subjectId = "p1"; b.results[0].executionId = "e1";
  b.executions = new Map([["e1", { jobId: "j1" }]]); b.jobs = [{ id: "j1", state: "succeeded", checkpoint: { subjectId: "p1", configurationVersion: 1 } }];
  assert.equal(presentResearchProgress(b).calculation, "none");
  b.jobs[0].checkpoint.configurationVersion = 2; b.populations[0].kind = "scenario"; assert.equal(presentResearchProgress(b).input, "not_required");
});

test("a profile requires a real execution binding for the first reported table", () => {
  const b = base(); b.results = [{ id: "r2", version: 1, kind: "snapshot_profile", subjectId: null, executionId: "e", counts: { realPatients: 80 }, diagnostics: { tables: [{ input: "s1:1", rows: 80 }] } }];
  b.executions = new Map([["e", { method: "profile.snapshot", methodVersion: "1.1.0", inputs: [{ kind: "snapshot_file", id: "s1:1" }] }]]);
  assert.equal(presentResearchProgress(b).counts.sourcePatients, 80);
  b.executions.get("e").methodVersion = "1.0.0"; assert.equal(presentResearchProgress(b).counts.sourcePatients, null);
  b.executions.get("e").methodVersion = "1.1.0"; b.executions.get("e").inputs[0].id = "other:1"; assert.equal(presentResearchProgress(b).counts.sourcePatients, null);
  b.executions.get("e").inputs[0].id = "s1:1"; b.results[0].diagnostics.tables.unshift({ input: "other:1" });
  assert.equal(presentResearchProgress(b).counts.sourcePatients, null);
});
