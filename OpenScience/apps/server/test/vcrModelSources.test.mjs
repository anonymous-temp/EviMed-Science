import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createVcrModelSources } from "../src/vcrModelSources.mjs";
const sha = text => createHash("sha256").update(text).digest("hex");
function fixture(text = "Control response was 40%; intervention response was 60%.") {
  const source = { id: `src_${"a".repeat(64)}`, userId: "u1", projectId: "project1", payload: { title: "Trial source", generation: 2, status: "ready", analysis: { textSha256: sha(text) } } };
  const sources = { async get(userId, id) { if (userId !== source.userId || id !== source.id) throw Object.assign(new Error("missing"), { status: 404 }); return source; },
    async loadCapture() { return { input: { text } }; }, async getUnderstanding() { return { current: { methods: [], units: [{ text: "Do not send the whole capture" }] } }; }, async getMaterials() { return { materials: { coverage: { tables: { extracted: 0 } } } }; } };
  return { port: createVcrModelSources({ sources }), source, sources, user: { id: "u1" }, study: { projectId: "project1" } };
}
test("source preview checks the account and exact study project and returns anchored literals", async () => {
  const f = fixture();
  const read = await f.port.preview(f.user, f.study, f.source.id);
  assert.equal(read.parameters[0].value, 40);
  assert.equal(read.parameters[0].unit, "%");
  assert.ok(read.parameters[0].quote.includes("Control response was 40%"));
  assert.equal(read.understanding.units, undefined);
  await assert.rejects(f.port.preview({ id: "other" }, f.study, f.source.id), { status: 404 });
  await assert.rejects(f.port.preview(f.user, { projectId: "other" }, f.source.id), { status: 404 });
});
test("mapping re-reads trusted occurrences, converts percent explicitly and never accepts caller values or executable claims", async () => {
  const f = fixture();
  const read = await f.port.preview(f.user, f.study, f.source.id);
  const card = await f.port.prepare(f.user, f.study, { literatureSource: read, executionProfile: "patients.binary", executionSpec: { forged: true }, parameterBindings: [
    { field: "truth.controlRate", candidateId: read.parameters[0].id, value: 0.99 }, { field: "truth.treatmentRate", candidateId: read.parameters[1].id, value: 0.99 },
  ] });
  assert.equal(card.registrationState, "parameterized_reference");
  assert.deepEqual(card.executionSpec.scenario, { endpoint: { type: "binary" }, truth: { controlRate: 0.4, treatmentRate: 0.6 } });
  assert.equal(card.parameterBindings[0].conversion, "percent_to_proportion");
  assert.equal(card.parameterBindings[0].textSha256, sha("Control response was 40%; intervention response was 60%."));
  assert.ok(!Object.hasOwn(card.executionSpec.scenario, "design"), "validation placeholders never become execution parameters");
});
test("changed generations and forged occurrences cannot become source parameters", async () => {
  const f = fixture();
  const read = await f.port.preview(f.user, f.study, f.source.id);
  await assert.rejects(f.port.prepare(f.user, f.study, { literatureSource: { ...read, generation: 1 } }), { code: "source_changed" });
  await assert.rejects(f.port.prepare(f.user, f.study, { literatureSource: read, executionProfile: "patients.binary", parameterBindings: [{ field: "truth.controlRate", candidateId: "invented" }] }), { code: "vcr_model_invalid" });
});
test("missing source content remains an incomplete registration and never gains an executable spec", async () => {
  const f = fixture();
  f.sources.loadCapture = async () => null;
  const read = await f.port.preview(f.user, f.study, f.source.id);
  const card = await f.port.prepare(f.user, f.study, { literatureSource: read });
  assert.equal(card.registrationState, "incomplete_specification");
  assert.equal(card.executionSpec, null);
  assert.ok(card.specificationMissing.length);
});
test("time-to-event parameterization retains the declared time unit and names missing units", async () => {
  const f = fixture("Hazard ratio was 0.7. Control median was 6 months.");
  const read = await f.port.preview(f.user, f.study, f.source.id);
  const card = await f.port.prepare(f.user, f.study, { literatureSource: read, executionProfile: "patients.time_to_event", parameterBindings: [
    { field: "truth.hazardRatio", candidateId: read.parameters[0].id }, { field: "truth.controlMedian", candidateId: read.parameters[1].id },
  ] });
  assert.equal(card.executionSpec.scenario.timeUnit, "months");
});
