import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrEvidenceStore } from "../src/vcrEvidenceStore.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { createVcrEvidenceSources } from "../src/vcrEvidenceSources.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, store, studies;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrlit");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 2000 });
  store = new VcrEvidenceStore({ database }); studies = new VcrStore({ database }); await store.ready();
});

test("all literature population admissions require verified statistic bindings and freeze only those source versions", options, async () => {
  const study = await studies.createStudy({ userId: "u2", projectId: "p2", name: "Synthetic sourced baseline admission", question: "q", dataTier: "T0" });
  const pipeline = createVcrEvidencePipeline({ store });
  const quote = "Age: mean 62 years, SD 8 years.";
  const append = await store.appendEvidenceItems({ userId: "u2", studyId: study.id, items: [
    { parameter: "age.mean", value: 62, unit: "year", valueSource: "extracted", quote, locator: { verification: "verified" }, detail: { evidenceKind: "baseline" } },
    { parameter: "age.sd", value: 8, unit: "year", valueSource: "extracted", quote, locator: { verification: "verified" }, detail: { evidenceKind: "baseline" } },
  ] });
  const bindings = ["mean", "sd"].map((field, index) => ({ variable: "age", field, unit: "year", evidenceId: append.ids[index] }));
  const numeric = { n: 20, baselineTable: [{ variable: "age", mean: 62, sd: 8 }] };
  const config = { vcrJobCpuSeconds: 60, vcrStudyCpuBudget: 1000, vcrMaxConcurrentJobs: 1 };
  const queue = new VcrJobs({ store: studies, config, baselineVerifier: input => pipeline.verifyBaselineTable(input) });
  const request = { userId: "u2", studyId: study.id, kind: "literature_population", scenario: { ...numeric, baselineBindings: bindings },
    inputs: [{ kind: "evidence", id: "unused-evidence" }], cpuSecondsLimit: 1 };
  const admitted = await queue.enqueue(request);
  const row = await studies.one("SELECT scenario,inputs,checkpoint FROM evimed_vcr.jobs WHERE id=$1", [admitted.job.id]);
  assert.equal(row.scenario.baselineBindings, undefined);
  assert.deepEqual(row.inputs.map(input => input.id), append.ids);
  assert.equal(row.checkpoint.literatureBaseline.verification, "marginals_source_verified");
  assert.equal(row.checkpoint.literatureBaseline.bindings[0].value, 62);
  await assert.rejects(queue.enqueue({ ...request, scenario: numeric, internal: true }), { code: "vcr_job_scenario_invalid" });
  await assert.rejects(queue.enqueue({ ...request, userId: "other" }), { code: "vcr_job_scenario_invalid" });
  await assert.rejects(queue.enqueue({ ...request, scenario: { ...request.scenario, baselineTable: [{ variable: "age", mean: 63, sd: 8 }] } }), { code: "vcr_job_scenario_invalid" });
  await assert.rejects(new VcrJobs({ store: studies, config }).enqueue(request), { code: "vcr_job_scenario_invalid" });
  const internal = await queue.enqueue({ ...request, scenario: numeric, detail: { baselineBindings: bindings }, internal: true });
  assert.equal(internal.job.id, admitted.job.id);
  const assumed = await queue.enqueue({ userId: "u2", studyId: study.id, kind: "generate_population", scenario: { n: 20,
    population: { variables: [{ name: "age", family: "normal", mean: 62, sd: 8 }] } }, cpuSecondsLimit: 1 });
  assert.ok(assumed.job.id);
});
after(async () => { await database?.close(); await isolated?.drop(); });

test("article sources keep separate latest evidence rows and exact versions can back literature baseline assumptions", options, async () => {
  const study = await studies.createStudy({ userId: "u1", projectId: "p1", name: "Synthetic literature parameters", question: "q", dataTier: "T0" });
  const text = "Table 1: Mean age 62 years, SD 8, n 100.";
  const hash = createHash("sha256").update(text).digest("hex");
  const sources = { async get(userId, id) { return { id, userId, projectId: "p1", payload: { generation: 1, analysis: { textSha256: hash } } }; },
    async loadCapture() { return { input: { text } }; } };
  const pipeline = createVcrEvidencePipeline({ store }); pipeline.attachSources(createVcrEvidenceSources({ sources }));
  const item = sourceId => ({ literatureSource: { sourceId, generation: 1, textSha256: hash }, parameter: "age_mean", arm: "overall", armRole: "overall", value: 62,
    unit: "year", quote: text, locator: { start: 0, end: text.length }, historicalBaseline: true, evidenceKind: "baseline", endpointKey: "baseline_age" });
  const first = await pipeline.addEvidenceItem({ userId: "u1", studyId: study.id, projectId: "p1", item: item("src_one") });
  const second = await pipeline.addEvidenceItem({ userId: "u1", studyId: study.id, projectId: "p1", item: item("src_two") });
  const latest = await store.listEvidenceItems({ userId: "u1", studyId: study.id, parameter: "age_mean", latestOnly: true });
  assert.equal(latest.length, 2);
  assert.deepEqual(new Set(latest.map(row => row.id)), new Set([first.id, second.id]));
  const [verified] = await store.verifiedItemsById({ userId: "u1", studyId: study.id, ids: [first.id] });
  assert.equal(Number(verified.value), 62);
  assert.equal(verified.detail.evidenceKind, "baseline");
  assert.equal(verified.locator.sourceHash, hash);
  const correction = await pipeline.addEvidenceItem({ userId: "u1", studyId: study.id, projectId: "p1", item: item("src_one") });
  const corrected = await store.listEvidenceItems({ userId: "u1", studyId: study.id, latestOnly: true });
  assert.deepEqual(new Set(corrected.map(row => row.id)), new Set([correction.id, second.id]));
  assert.equal((await store.itemsById({ userId: "u1", studyId: study.id, ids: [first.id] })).length, 1, "original evidence remains immutable for historical cards");
  assert.deepEqual(await store.verifiedItemsById({ userId: "other", studyId: study.id, ids: [first.id] }), []);
  const write = await vcrRuntimeWrite({ store: studies, service: { config: {} }, study, orchestrator: null, what: "evidence_item",
    items: [item("src_gateway")], evidence: pipeline, evidenceStore: store });
  assert.equal(write.ids.length, 1, JSON.stringify(write.issues));
  assert.equal((await store.itemsById({ userId: "u1", studyId: study.id, ids: write.ids }))[0].locator.kind, "literature_text");
});
