// What a population version is for (in silico plan T07, A03, A13): its origin, the model it is bound to, what that allows, and which
// results a change of the model or the population leaves behind. No database: the page's own bundle fields go in.
import assert from "node:assert/strict";
import test from "node:test";
import { bindingUseFindings, memberAccounting, modelReadiness, populationBindingPremises, populationBindingView, populationOrigin, realizationAccounting }
  from "../src/vcrPopulationBinding.mjs";
import { modelUseOf, modelUsePremisesOf } from "../src/vcrModelUsePage.mjs";

const model = (/** @type {Record<string, any>} */ over = {}) => ({ id: "mdl_1", name: "ad-progression", version: "1", createdAt: "2026-11-01T00:00:00Z",
  card: { title: "阿尔茨海默病进展模型", executable: true, executableModes: ["factual_forecast", "conditional_forecast", "intervention_comparison"], ...over.card }, ...over, });
const population = (/** @type {Record<string, any>} */ over = {}) => ({ id: "pop_2", version: 2, kind: "literature", counts: {}, ...over });
const set = (/** @type {Record<string, any>} */ over = {}) => ({ id: "ps_1", version: 1, populationId: "pop_2", modelId: "ad-progression", modelVersion: "1", scenario: { endpoint: "ADAS-cog 11" }, resultId: "res_1", ...over });

test("origin comes from the kind and an unknown kind has none", () => {
  assert.equal(populationOrigin({ kind: "literature" }), "literature_constrained");
  assert.equal(populationOrigin({ kind: "scenario" }), "built_in");
  assert.equal(populationOrigin({ kind: "real" }), "observed");
  assert.equal(populationOrigin({ kind: "empirical_synthetic" }), "data_derived");
  assert.equal(populationOrigin({ kind: "mystery" }), null);
});

test("A03: a descriptive population is a valid object and does not claim to be experiment-ready", () => {
  const view = populationBindingView(population(), { patientSets: [], models: [model()] });
  assert.equal(view.readiness, "descriptive_only");
  const rows = populationBindingPremises(view);
  assert.deepEqual(rows.map((row) => row.key), ["binding:origin", "binding:readiness"]);
  assert.match(rows[1].value, /还没有接上能往后推演的模型/);
  assert.equal(rows[1].decisive, true);
  assert.match(rows[0].value, /不是真实患者/);
  // a real cohort is its data: no origin sentence and no readiness sentence
  assert.deepEqual(populationBindingPremises(populationBindingView(population({ kind: "real" }), {})), []);
});

test("readiness follows what the model declares it can execute, never its validation", () => {
  assert.equal(modelReadiness(model()), "intervention_mapping_available");
  assert.equal(modelReadiness(model({ card: { executableModes: ["conditional_forecast"] } })), "transition_model_bound");
  assert.equal(modelReadiness(model({ card: { executableModes: [] } })), "descriptive_only");
  assert.equal(modelReadiness(model({ card: { executable: false } })), "descriptive_only");
  assert.equal(modelReadiness({ card: { interfaceShape: "baseline_to_outcome" } }), "transition_model_bound");
  assert.equal(modelReadiness({ card: {} }), "descriptive_only");
  assert.equal(modelReadiness(null), "descriptive_only");
  const view = populationBindingView(population(), { patientSets: [set()], models: [model()] });
  assert.equal(view.readiness, "intervention_mapping_available");
  assert.equal(view.bound?.title, "阿尔茨海默病进展模型");
  assert.match(populationBindingPremises(view).find((row) => row.key === "binding:readiness")?.value ?? "", /不是疗效的证明/);
});

test("A13: a new model version or a new population version leaves only the results that read the old one", () => {
  const other = set({ id: "ps_2", modelId: "other-model", modelVersion: "1", resultId: "res_2" });
  const models = [model({ id: "mdl_1b", version: "2", createdAt: "2026-11-05T00:00:00Z" }), model(), { id: "mdl_o", name: "other-model", version: "1", createdAt: "2026-11-01T00:00:00Z", card: { executableModes: ["conditional_forecast"] } }];
  const view = populationBindingView(population(), { patientSets: [set(), other], models });
  const byId = Object.fromEntries(view.bindings.map((binding) => [binding.patientSetId, binding.state]));
  assert.deepEqual(byId, { ps_1: "model_changed", ps_2: "current" }, "only the set of the changed model is behind");
  assert.equal(view.readiness, "transition_model_bound", "a binding that no longer holds is not counted towards readiness");
  assert.match(populationBindingPremises(view).find((row) => row.key === "binding:stale_model")?.value ?? "", /1 个用这批人算出的结果用的是模型的旧版本/);

  // the model retired from the library: its set says so; the other is untouched
  const gone = populationBindingView(population(), { patientSets: [set(), other], models: [models[2]] });
  assert.deepEqual(gone.bindings.map((binding) => binding.state), ["model_missing", "current"]);

  // a newer population version: the set made from the earlier one is reported, not the current one's binding
  const next = populationBindingView(population({ id: "pop_3", version: 3 }), { patientSets: [set()], models, populations: [population(), population({ id: "pop_3", version: 3 })] });
  assert.equal(next.bindings.length, 0);
  assert.equal(next.earlier.length, 1);
  assert.equal(next.earlier[0].state, "population_changed");
  assert.match(populationBindingPremises(next).find((row) => row.key === "binding:stale_population")?.value ?? "", /更早版本/);
  // a set of an unrelated population (another study's object) is neither
  assert.equal(populationBindingView(population({ id: "pop_9" }), { patientSets: [set()], models, populations: [population({ id: "pop_9" })] }).earlier.length, 0);
});

test("members are accounting, never people: realizations share a parent", () => {
  assert.deepEqual(realizationAccounting([{ parent: "A" }, { parent: "A" }, { parent: "B" }, { parent: "" }], "parent"), { members: 4, parents: 2 });
  assert.deepEqual(memberAccounting({ kind: "literature", counts: { generatedRecords: 1000, realPatients: 40 }, diagnostics: { constraintEnforcement: { rowsRedrawn: 12 }, constraintViolations: [{ rule: "r", violations: 0 }] } }),
    { observedPeople: null, virtualMembers: 1000, redrawn: 12, stillBreaking: 0 }, "a virtual population has no observed people, whatever else a count says");
  assert.equal(memberAccounting({ kind: "real", counts: { realPatients: 40, generatedRecords: 9 } }).virtualMembers, null);
  assert.equal(memberAccounting({ kind: "real", counts: { realPatients: 40 } }).observedPeople, 40);
  const view = populationBindingView(population(), { diagnostics: { constraintEnforcement: { rowsRedrawn: 12 }, constraintViolations: [{ rule: "r", violations: 0 }] } });
  assert.match(populationBindingPremises(view).find((row) => row.key === "binding:members")?.value ?? "", /12 条记录违反设定的限定，已重新抽取；最后没有记录违反限定/);
});

test("A04: a use the model was not validated for runs and says so in the premises, a model with nothing declared says nothing", () => {
  const validated = model({ card: { useEvidence: [{ mode: "factual_forecast", endpoint: "ADAS-cog 11", horizonHours: 8000, evidenceRef: "paper-1", independent: true }] } });
  const findings = modelUseOf([validated], { name: "ad-progression", version: "1" }, { mode: "conditional_forecast", endpoint: "ADAS-cog 11" });
  assert.deepEqual(findings.map((finding) => finding.code), ["use_not_validated"]);
  const rows = modelUsePremisesOf([validated], validated, { mode: "conditional_forecast", endpoint: "ADAS-cog 11" });
  assert.equal(rows.length, 1);
  assert.match(rows[0].value, /没有为这种用途验证过/);
  assert.equal(rows[0].decisive, true);
  assert.deepEqual(modelUseOf([model()], { name: "ad-progression" }, { mode: "conditional_forecast" }), [], "no validation list: nothing to be held against");
  assert.deepEqual(modelUseOf([], { name: "ad-progression" }), []);
  assert.deepEqual(modelUseOf([validated], null), []);
  // through the binding of a population
  const view = populationBindingView(population(), { patientSets: [set()], models: [validated] });
  assert.deepEqual(bindingUseFindings(view, [validated]).map((finding) => finding.code), ["use_not_validated"]);
  assert.deepEqual(bindingUseFindings(populationBindingView(population(), {}), [validated]), []);
  // the population's own range against the range the bound model was fitted on (review stats P1-5)
  const fitted = model({ card: { ...validated.card, inputRanges: { age: [50, 85] } } });
  const wide = population({ definition: { population: { variables: [{ name: "age", min: 40, max: 90 }] } } });
  const bound = populationBindingView(wide, { patientSets: [set()], models: [fitted] });
  assert.ok(bindingUseFindings(bound, [fitted], wide).some((finding) => finding.code === "input_out_of_range"));
  assert.ok(!bindingUseFindings(bound, [fitted]).some((finding) => finding.code === "input_out_of_range"), "with no population named, no range is held against it");
});

test("no back-office word reaches a premise sentence", () => {
  const view = populationBindingView(population(), { patientSets: [set(), set({ id: "ps_2", modelId: "gone" })], models: [model()], diagnostics: { constraintEnforcement: { rowsRedrawn: 3 } } });
  for (const row of populationBindingPremises(view)) assert.doesNotMatch(row.value + row.label, /patient_set|ps_\d|mdl_|descriptive_only|readiness|adapter|job/i);
});
