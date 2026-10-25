import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createVcrModelSources } from "../src/vcrModelSources.mjs";
const sha = text => createHash("sha256").update(text).digest("hex");
function fixture(text = "Control response was 40%; intervention response was 60%.") {
  const source = { id: `src_${"a".repeat(32)}`, userId: "u1", projectId: "project1", payload: { title: "Trial source", generation: 2, status: "ready", analysis: { textSha256: sha(text) } } };
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

async function equationFixture(extra = "") {
  const text = "Adults receiving standard care were evaluated at 12 months. Logistic model: logit(p) = −3 + 0.02 * age (years), with no centering." + extra;
  const f = fixture(text);
  const read = await f.port.preview(f.user, f.study, f.source.id);
  const candidate = value => read.parameters.find(row => row.value === value).id;
  const card = { literatureSource: read, executionProfile: "model.prognostic_apply",
    equation: { sourceCondition: "standard_care", endpoint: { type: "binary", horizon: 999, timeUnit: "months" },
      model: { family: "logistic", intercept: 999, terms: [{ column: "age", coefficient: 999, transform: "identity", unit: "years", center: 0, scale: 1 }] } },
    parameterBindings: [{ field: "model.intercept", candidateId: candidate(-3) }, { field: "model.terms.0.coefficient", candidateId: candidate(0.02) }, { field: "endpoint.horizon", candidateId: candidate(12) }],
    semanticBindings: ["endpoint", "population", "sourceCondition", "model.terms.0"].map(field => ({ field, quote: text, start: 0, end: text.length })) };
  return { ...f, read, card, text };
}
test("published equations bind exact literals, Unicode minus and semantic quotations rather than caller coefficients", async () => {
  const f = await equationFixture();
  const card = await f.port.prepare(f.user, f.study, f.card);
  assert.equal(card.registrationState, "source_bound_equation");
  assert.equal(card.executionSpec.scenario.model.intercept, -3);
  assert.equal(card.executionSpec.scenario.model.terms[0].coefficient, 0.02);
  assert.equal(card.executionSpec.scenario.endpoint.horizon, 12);
  assert.equal(card.type, "published_prognostic_equation");
  assert.equal(card.semanticBindings.length, 4);
  assert.equal(Object.hasOwn(card.executionSpec.scenario, "inputId"), false);
  assert.ok(card.knownLimits.some(line => line.includes("not automatically validated")));
});
test("equation adoption rejects invented quotations and retains incomplete metadata without making it executable", async () => {
  const f = await equationFixture();
  const forged = structuredClone(f.card); forged.semanticBindings[0].quote = "not in the source";
  await assert.rejects(f.port.prepare(f.user, f.study, forged), { code: "vcr_model_invalid" });
  const incomplete = await f.port.prepare(f.user, f.study, { ...f.card, parameterBindings: f.card.parameterBindings.slice(0, 1) });
  assert.equal(incomplete.executionSpec, null); assert.equal(incomplete.registrationState, "incomplete_specification");
  const executable = structuredClone(f.card); executable.equation.model.expression = "system('no')";
  assert.equal((await f.port.prepare(f.user, f.study, executable)).executionSpec, null);
});
test("immutable equation execution rechecks the source and rejects changed coefficients or prediction horizon", async () => {
  const { VcrService } = await import("../src/vcrService.mjs");
  const f = await equationFixture(); const card = await f.port.prepare(f.user, f.study, f.card);
  const study = { ...f.study, id: "std_model", userId: f.user.id };
  const service = new VcrService({ config: {}, store: /** @type {any} */ ({
    async getStudy(userId, id) { return userId === f.user.id && id === study.id ? study : null; },
    async models() { return [{ id: "mdl_bound", version: "1.0.0", studyId: study.id, card }]; },
  }) });
  service.attach({ modelSources: f.port });
  const scenario = { ...card.executionSpec.scenario, inputId: "snp_1:subject", idColumn: "USUBJID", inputUnits: { age: "years" } };
  assert.equal((await service.modelExecution(f.user, study, "mdl_bound", "apply_prognostic_model", scenario)).version, "1.0.0");
  const changed = structuredClone(scenario); changed.model.terms[0].coefficient = 0.2;
  await assert.rejects(service.modelExecution(f.user, study, "mdl_bound", "apply_prognostic_model", changed), { code: "vcr_model_invalid" });
  await assert.rejects(service.modelExecution(f.user, study, "mdl_bound", "apply_prognostic_model", { ...scenario, endpoint: { ...scenario.endpoint, horizon: 24 } }), { code: "vcr_model_invalid" });
  f.source.payload.generation = 3;
  await assert.rejects(service.modelExecution(f.user, study, "mdl_bound", "apply_prognostic_model", scenario), { code: "source_changed" });
});
test('a numeric predictor unit absent from its preserved interpretation cannot become executable', async()=>{
  const f=await equationFixture();f.card.equation.model.terms[0].unit='months';
  const prepared=await f.port.prepare(f.user,f.study,f.card);
  assert.equal(prepared.executionSpec,null);assert.ok(prepared.specificationMissing.some(issue=>issue.includes('predictor unit')));
});
test('categorical encoding requires its declared levels in the preserved interpretation, not a fabricated physical unit',async()=>{
  const f=await equationFixture();const term=f.card.equation.model.terms[0];
  Object.assign(term,{transform:'indicator',unit:'category',category:'male',levels:['female','male']});
  const prepared=await f.port.prepare(f.user,f.study,f.card);
  assert.equal(prepared.executionSpec,null);assert.ok(prepared.specificationMissing.some(issue=>issue.includes('category encoding')));
});

test('preserved categorical levels execute as a structural indicator without a physical unit',async()=>{
  const f=await equationFixture(' Sex is encoded female=0 and male=1.');
  Object.assign(f.card.equation.model.terms[0],{transform:'indicator',unit:'category',category:'male',levels:['female','male']});
  const prepared=await f.port.prepare(f.user,f.study,f.card);assert.equal(prepared.registrationState,'source_bound_equation');
});

test('a literal 12-month source horizon cannot become a 12-year prediction or Cox baseline',async()=>{
  const f=await equationFixture();f.card.equation.endpoint.timeUnit='years';const prepared=await f.port.prepare(f.user,f.study,f.card);
  assert.equal(prepared.executionSpec,null);assert.ok(prepared.specificationMissing.some(issue=>issue.includes('horizon unit')));
});

test('source time-unit literals remain stable when an adopted equation is prepared again',async()=>{
  const f=await equationFixture();f.card.equation.model.terms[0].unit='year';
  const adopted=await f.port.prepare(f.user,f.study,f.card);assert.equal(adopted.registrationState,'source_bound_equation');assert.equal(adopted.equation.model.terms[0].unit,'year');
  const again=await f.port.prepare(f.user,f.study,adopted);assert.equal(again.registrationState,'source_bound_equation');assert.equal(again.executionSpec.scenarioHash,adopted.executionSpec.scenarioHash);
});
