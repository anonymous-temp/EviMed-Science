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

test("a paper that does not report a parameter is a state of its own: stored without a value, never pooled, read back as not reported (C8)", options, async () => {
  const study = await studies.createStudy({ userId: "u8", projectId: "p8", name: "Synthetic not-reported parameter", question: "q", dataTier: "T0" });
  const text = "Table 2: Mean change -4.1 (n 100) in the treated arm and -1.9 (n 98) in the control arm.";
  const hash = createHash("sha256").update(text).digest("hex");
  const sources = { async get(userId, id) { return { id, userId, projectId: "p8", payload: { generation: 1, analysis: { textSha256: hash } } }; },
    async loadCapture() { return { input: { text } }; } };
  const pipeline = createVcrEvidencePipeline({ store }); pipeline.attachSources(createVcrEvidenceSources({ sources }));
  const source = { sourceId: "src_paper", generation: 1, textSha256: hash };
  const mention = "Mean change -4.1 (n 100) in the treated arm";
  const reported = { literatureSource: source, parameter: "mean_value", arm: "treated", armRole: "treatment", value: -4.1, sampleSize: 100, unit: "points",
    quote: mention, locator: { start: text.indexOf(mention), end: text.indexOf(mention) + mention.length }, endpointKey: "change" };
  // The paper gives no SD: the run says so, with the source and the parameter and with no number.
  const none = { literatureSource: source, parameter: "outcome_sd", arm: "control", armRole: "control", notReported: true, endpointKey: "change" };
  const write = await vcrRuntimeWrite({ store: studies, service: { config: {} }, study, orchestrator: null, what: "evidence_item", items: [none], evidence: pipeline, evidenceStore: store });
  assert.equal(write.ids.length, 1, JSON.stringify(write.issues));
  assert.deepEqual(write.issues, [], "it is an answer, not a refusal and not a reminder");
  const [row] = await store.itemsById({ userId: "u8", studyId: study.id, ids: write.ids });
  assert.equal(row.locator.verification, "not_reported");
  assert.equal(row.value, null);
  assert.equal(row.value_text, "not_reported");
  assert.equal(row.detail.notReported, true);
  assert.equal(row.locator.sourceId, "src_paper", "the source it was read from is still named");
  // It never reaches a pool or a card, and a later 「not reported」 never replaces a value that was verified.
  assert.deepEqual(await store.verifiedItemsById({ userId: "u8", studyId: study.id, ids: write.ids }), []);
  assert.equal((await store.listEvidenceItems({ userId: "u8", studyId: study.id, verifiedOnly: true })).length, 0);
  const coverage = (await store.evidenceCoverage({ userId: "u8", studyId: study.id })).find((entry) => entry.parameter === "outcome_sd");
  assert.deepEqual([coverage.extracted, coverage.verified, coverage.refused, coverage.not_reported], [1, 0, 0, 1]);
  const read = await pipeline.evidenceRead(study, {});
  const shown = read.items.find((entry) => entry.parameter === "outcome_sd");
  assert.equal(shown.notReported, true);
  assert.equal(shown.value, null);
  assert.equal(shown.missing, undefined);
  // A number written beside 「not reported」 is the contradiction it is, and is refused by name.
  const withValue = await vcrRuntimeWrite({ store: studies, service: { config: {} }, study, orchestrator: null, what: "evidence_item",
    items: [{ ...none, value: 8 }, { ...none, valueText: "unclear" }, { ...none, notReported: "yes" }], evidence: pipeline, evidenceStore: store });
  assert.equal(withValue.ids.length, 0);
  assert.deepEqual(new Set(withValue.issues.map((entry) => entry.field)), new Set(["notReported", "quote", "value", "valueText"]));
  assert.ok(withValue.issues.some((entry) => entry.index === 0 && entry.field === "value"), "the value beside 「not reported」 is refused by name");
  // A value that lacks what the pool reads (an interval for a difference) is saved and reminded, not refused.
  const incomplete = await vcrRuntimeWrite({ store: studies, service: { config: {} }, study, orchestrator: null, what: "evidence_item", items: [reported], evidence: pipeline, evidenceStore: store });
  assert.equal(incomplete.ids.length, 1, JSON.stringify(incomplete.issues));
  assert.deepEqual(incomplete.issues.map((entry) => entry.code), ["vcr_evidence_item_incomplete"]);
  assert.match(incomplete.issues[0].message, /置信区间下限、置信区间上限/);
  const afterwards = await store.listEvidenceItems({ userId: "u8", studyId: study.id, latestOnly: true });
  assert.equal(afterwards.filter((entry) => entry.locator.verification === "verified").length, 1);
  const again = await pipeline.evidenceRead(study, {});
  assert.deepEqual(again.items.find((entry) => entry.parameter === "mean_value").missing, ["ciLow", "ciHigh"]);
});
