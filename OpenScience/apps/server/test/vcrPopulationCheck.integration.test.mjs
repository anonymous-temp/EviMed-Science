// Queueing a population check (remediation plan D2): the second table is verified against quoted sources like a literature population's,
// the generated side is copied from the population's own result, a caller's own `generated` is refused, and the job records whether
// the two tables share evidence. PostgreSQL; the population's result is a double on the store.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { validateEngineJob } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrEvidenceStore } from "../src/vcrEvidenceStore.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, evidenceStore, studies;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrchk");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 2000 });
  evidenceStore = new VcrEvidenceStore({ database }); studies = new VcrStore({ database }); await evidenceStore.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); });

const PROFILE = [
  { variable: "age", kind: "continuous", n: 400, missing: 0, mean: 62.1, sd: 9.4 },
  { variable: "male", kind: "binary", n: 400, missing: 0, levels: [{ level: "0", n: 180, p: 0.45 }, { level: "1", n: 220, p: 0.55 }] },
];

/** The population the check is about: a literature population whose own baseline rests on `evidenceIds`. */
async function withPopulation(populationEvidence, body) {
  const original = { populations: studies.populations, result: studies.result };
  studies.populations = async () => [{ id: "pop_1", version: 3, kind: "literature", resultId: "res_pop" }];
  studies.result = async (_study, id) => (id === "res_pop" ? { id, kind: "population", diagnostics: { profile: PROFILE, literatureBaseline: { evidenceIds: populationEvidence } } } : null);
  try { return await body(); } finally { studies.populations = original.populations; studies.result = original.result; }
}

test("a population check copies the population's profile, verifies the second table, and records whether the evidence is shared", options, async () => {
  const study = await studies.createStudy({ userId: "u9", projectId: "p9", name: "Synthetic population check", question: "q", dataTier: "T0" });
  const pipeline = createVcrEvidencePipeline({ store: evidenceStore });
  const quote = "Age: mean 63 years, SD 10 years.";
  const append = await evidenceStore.appendEvidenceItems({ userId: "u9", studyId: study.id, items: [
    { parameter: "age.mean", value: 63, unit: "year", valueSource: "extracted", quote, locator: { verification: "verified" }, detail: { evidenceKind: "baseline" } },
    { parameter: "age.sd", value: 10, unit: "year", valueSource: "extracted", quote, locator: { verification: "verified" }, detail: { evidenceKind: "baseline" } },
  ] });
  const bindings = ["mean", "sd"].map((field, index) => ({ variable: "age", field, unit: "year", evidenceId: append.ids[index] }));
  const second = { baselineTable: [{ variable: "age", mean: 63, sd: 10 }], referenceN: 412 };
  const config = { vcrJobCpuSeconds: 60, vcrStudyCpuBudget: 1000, vcrMaxConcurrentJobs: 1 };
  const queue = new VcrJobs({ store: studies, config, baselineVerifier: input => pipeline.verifyBaselineTable(input) });
  const request = { userId: "u9", studyId: study.id, kind: "population_check", scenario: { ...second, baselineBindings: bindings }, cpuSecondsLimit: 1, detail: { subjectId: "pop_1" } };

  // another source than the population's: independent
  const admitted = await withPopulation(["ev_other"], () => queue.enqueue(request));
  const row = await studies.one("SELECT scenario,inputs,checkpoint,method,method_version FROM evimed_vcr.jobs WHERE id=$1", [admitted.job.id]);
  assert.equal(row.method, "population.check");
  assert.equal(row.scenario.baselineBindings, undefined, "the bindings are checked and removed, as for a literature population");
  assert.deepEqual(row.scenario.generated, [
    { variable: "age", kind: "continuous", n: 400, mean: 62.1, sd: 9.4 },
    { variable: "male", kind: "binary", n: 400, levels: [{ level: "0", p: 0.45 }, { level: "1", p: 0.55 }] },
  ]);
  assert.deepEqual(row.inputs.map((input) => input.id), append.ids, "the evidence the second table rests on is the job's lineage");
  assert.deepEqual(row.checkpoint.populationCheck, { populationId: "pop_1", populationVersion: 3, populationResultId: "res_pop", populationKind: "literature", independent: true,
    populationSourced: true, sharedEvidenceIds: [], referenceEvidenceIds: append.ids });
  assert.equal(row.checkpoint.literatureBaseline, undefined, "it is not a literature population");
  assert.deepEqual(validateEngineJob({ jobId: "job_x", studyId: study.id, kind: "population_check", method: "population.check", methodVersion: row.method_version, protocolVersion: 1,
    seed: 1, cpuSecondsLimit: 60, scenario: row.scenario, inputs: [] }), []);

  // the same evidence the population rests on: not independent, and which items are shared
  const shared = await withPopulation([append.ids[0], "ev_other"], () => queue.enqueue({ ...request, scenario: { ...request.scenario, referenceN: 500 } }));
  const sharedRow = await studies.one("SELECT checkpoint FROM evimed_vcr.jobs WHERE id=$1", [shared.job.id]);
  assert.equal(sharedRow.checkpoint.populationCheck.independent, false);
  assert.deepEqual(sharedRow.checkpoint.populationCheck.sharedEvidenceIds, [append.ids[0]]);

  // a caller's own generated numbers, an unbound table, a population with no result and no population at all are each refused by name
  await withPopulation([], async () => {
    await assert.rejects(queue.enqueue({ ...request, cpuSecondsLimit: 3, scenario: { ...request.scenario, generated: [{ variable: "age", kind: "continuous", mean: 63, sd: 10 }] } }), { code: "vcr_job_scenario_invalid" });
    await assert.rejects(queue.enqueue({ ...request, cpuSecondsLimit: 3, scenario: second }), { code: "vcr_job_scenario_invalid" });
    await assert.rejects(queue.enqueue({ ...request, cpuSecondsLimit: 3, scenario: { ...second, baselineTable: [{ variable: "age", mean: 64, sd: 10 }], baselineBindings: bindings } }), { code: "vcr_job_scenario_invalid" });
    await assert.rejects(queue.enqueue({ ...request, cpuSecondsLimit: 3, detail: { subjectId: "pop_missing" } }), { code: "vcr_population_profile_missing", status: 409 });
  });
  studies.populations = async () => [{ id: "pop_1", version: 3, kind: "literature", resultId: "res_pop" }];
  studies.result = async () => ({ id: "res_pop", diagnostics: {} });
  try { await assert.rejects(queue.enqueue({ ...request, cpuSecondsLimit: 3 }), { code: "vcr_population_profile_missing" }); }
  finally { delete studies.populations; delete studies.result; }
});
