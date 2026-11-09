// The record of virtual people and the assurance a distributed effect reports (round 2, R23, R25), without a database: what the control plane asks the
// engine for, what a made record reads as, and how an assurance reads on the patients page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_RESULT_QUANTITY_LABELS_ZH } from "@evimed/domain";
import { VCR_PEOPLE_TABLE, vcrPeopleInstantiateRequest, vcrPeopleRecordView } from "../src/vcrPeople.mjs";
import { progressionCard } from "../src/vcrProgression.mjs";

const generation = { populationId: "pop_1", populationVersion: 3, resultId: "res_pop", table: "population", inputId: "res_pop:population" };
const codes = (issues) => issues.map((issue) => `${issue.code}@${issue.field}`);

test("a request for n people states n and the model, and keeps the table", () => {
  const { request, issues } = vcrPeopleInstantiateRequest({ n: 400 }, null);
  assert.deepEqual(issues, []);
  assert.deepEqual(request.scenario, { timeUnit: "weeks", model: { family: "beta_logit", parameterSet: { id: "camd-adas-cog-11", version: "adsim-3.0" } }, instantiate: { n: 400 } });
  assert.deepEqual(request.derived, []);
  assert.deepEqual(request.detail.keepTables, [VCR_PEOPLE_TABLE]);
  assert.match(request.detail.subjectId, /^people:[0-9a-f]{24}$/);
});

test("the seed is drawn once: the same request has the same seed, another request another, and a stated seed is kept", () => {
  const a = vcrPeopleInstantiateRequest({ n: 400 }, null).request, b = vcrPeopleInstantiateRequest({ n: 400 }, null).request, c = vcrPeopleInstantiateRequest({ n: 401 }, null).request;
  assert.equal(a.seed, b.seed);
  assert.equal(a.identity, b.identity);
  assert.notEqual(a.seed, c.seed);
  assert.ok(Number.isInteger(a.seed) && a.seed >= 0 && a.seed < 2 ** 31 - 1);
  assert.equal(vcrPeopleInstantiateRequest({ n: 400, seed: 7 }, null).request.seed, 7);
  assert.equal(vcrPeopleInstantiateRequest({ n: 400, seed: 7 }, null).request.identity, a.identity, "a stated seed is not part of what the record is made from");
});

test("a population version brings its generated table, by the columns named, and the population's own version is part of the identity", () => {
  const { request } = vcrPeopleInstantiateRequest({ populationId: "pop_1", columns: { mmse: "Mmse", female: "Sex" } }, generation);
  assert.deepEqual(request.scenario.instantiate, { covariates: { inputId: "res_pop:population", columns: { mmse: "Mmse", female: "Sex" } } });
  assert.deepEqual(request.derived, [{ resultId: "res_pop", table: "population" }]);
  const next = vcrPeopleInstantiateRequest({ populationId: "pop_1", columns: { mmse: "Mmse", female: "Sex" } }, { ...generation, populationVersion: 4, resultId: "res_pop4", inputId: "res_pop4:population" }).request;
  assert.notEqual(next.identity, request.identity);
  assert.notEqual(next.seed, request.seed, "another version of the population is another draw");
});

test("what cannot be made is refused by name and nothing is asked of the engine", () => {
  const refuse = (input, population = null) => codes(vcrPeopleInstantiateRequest(input, population).issues);
  assert.deepEqual(refuse({}), ["people_field_missing@n"]);
  assert.deepEqual(refuse({ n: 1 }), ["people_value_invalid@n"]);
  assert.deepEqual(refuse({ n: 60000 }), ["people_value_invalid@n"]);
  assert.deepEqual(refuse({ n: 10, seed: -3 }), ["people_value_invalid@seed"]);
  assert.deepEqual(refuse({ n: 10, uncertainty: "posterior_draws" }), ["people_value_invalid@uncertainty"]);
  assert.deepEqual(refuse({ n: 10, columns: { mmse: "x" } }), ["people_field_unknown@columns"]);
  assert.deepEqual(refuse({ n: 10, path: "/etc" }), ["people_field_unknown@path"]);
  assert.deepEqual(refuse({ populationId: "pop_1", columns: { mmse: "Mmse" } }, null), ["people_population_unusable@populationId"], "an observed cohort has no generated table");
  assert.deepEqual(refuse({ populationId: "pop_1" }, generation), ["people_field_missing@columns"]);
  assert.deepEqual(refuse({ populationId: "pop_1", columns: { height: "H" } }, generation), ["people_field_unknown@columns.height"]);
  assert.equal(vcrPeopleInstantiateRequest({ n: 1 }, null).request, null);
});

test("a made record reads with its people, its parameter set and whether the engine still carries that set", () => {
  const made = (version) => ({ id: "res_rec", createdAt: "2026-11-09T00:00:00Z", tables: [{ name: VCR_PEOPLE_TABLE, location: "derived/s/j/progression-people.csv", sha256: "c".repeat(64) }],
    diagnostics: { progression: { instantiate: true, people: 400, uncertainty: "new_study", covariatesFrom: "model", outsideFittedMmse: 12, fittedMmse: [16, 26], parameterSet: { id: "camd-adas-cog-11", version } } } });
  const view = vcrPeopleRecordView(made("adsim-3.0"));
  assert.deepEqual(view, { id: "res_rec", createdAt: "2026-11-09T00:00:00Z", people: 400, uncertainty: "new_study", parameterSet: { id: "camd-adas-cog-11", version: "adsim-3.0" }, current: true,
    outsideFittedMmse: 12, fittedMmse: [16, 26], covariatesFrom: "model", tableSha256: "c".repeat(64) });
  assert.equal(vcrPeopleRecordView(made("adsim-2.0")).current, false, "made for an earlier parameter file");
  // not a record: an ordinary simulation, a result whose table was not filed, nothing
  assert.equal(vcrPeopleRecordView({ id: "x", diagnostics: { progression: { people: 3 } }, tables: [] }), null);
  assert.equal(vcrPeopleRecordView({ ...made("adsim-3.0"), tables: [{ name: VCR_PEOPLE_TABLE, sha256: "c".repeat(64) }] }), null);
  assert.equal(vcrPeopleRecordView(null), null);
});

test("a result whose effect is a distribution reads as an assurance on the patients page, never as a power", () => {
  const base = JSON.parse(readFileSync(new URL("./fixtures/vcr-progression/alzheimer-beta-logit.json", import.meta.url), "utf8"));
  const card = (rename, distributed) => progressionCard({ ...structuredClone(base), id: "res_1", version: 1, kind: "progression_simulation", createdAt: "2026-11-09T00:00:00Z",
    measures: base.measures.map((measure) => (measure.name === "power" ? { ...measure, name: rename } : measure)),
    diagnostics: { ...base.diagnostics, progression: { ...base.diagnostics.progression, isNull: false, ...(distributed ? { effectDistributions: [{ key: "treatment.symptomatic.pointsAt", family: "normal", tier: "A" }] } : {}) } } });
  const assurance = card("assurance", true);
  assert.ok(assurance.power, "the assurance is the headline number");
  assert.equal(assurance.powerName, VCR_RESULT_QUANTITY_LABELS_ZH.assurance);
  assert.equal(assurance.powerQuantity, "assurance");
  assert.equal(card("power", false).powerQuantity === "assurance", false);
});
