import assert from "node:assert/strict";
import test from "node:test";

import { averagePrecision, bootstrapMean, genericTerms, labelOf, metricsOf, ndcgAt, pairedDifference, precisionAt, recordOf, reciprocalRank, seeded } from "../score.mjs";

const study = (/** @type {string} */ id, /** @type {{ cond?: string[], drug?: string[], ancestors?: string[] }} */ { cond = ["Breast Neoplasms"], drug = ["Carboplatin"], ancestors = ["Coordination Complexes"] } = {}) => ({
  protocolSection: { identificationModule: { nctId: id, briefTitle: `Trial ${id}` }, conditionsModule: { conditions: ["Breast Cancer"] },
    designModule: { phases: ["PHASE2"], designInfo: { allocation: "RANDOMIZED" } },
    armsInterventionsModule: { interventions: [{ type: "DRUG", name: "Carbo" }, { type: "OTHER", name: "Survey" }] } },
  derivedSection: { conditionBrowseModule: { meshes: cond.map((term) => ({ term })) }, interventionBrowseModule: { meshes: drug.map((term) => ({ term })), ancestors: ancestors.map((term) => ({ term })) } },
  hasResults: id.endsWith("R"),
});

test("a record without MeSH terms cannot be labelled and is left out, never counted as a negative", () => {
  assert.equal(recordOf({ protocolSection: { identificationModule: { nctId: "NCT0" } }, derivedSection: {} }), null);
  assert.equal(recordOf(study("NCT1", { drug: [] })), null);
  const record = recordOf(study("NCT2R"));
  assert.deepEqual([record?.id, record?.hasResults, record?.drugNames, record?.interventions], ["NCT2R", true, ["Carbo"], ["Carbo", "Survey"]]);
});

test("the label: the same drug under any name is 2, the same narrow family is 1, a generic term never counts, another condition is 0", () => {
  const q = /** @type {any} */ (recordOf(study("NCT1")));
  const same = /** @type {any} */ (recordOf(study("NCT2", { drug: ["Carboplatin", "Paclitaxel"] })));
  const family = /** @type {any} */ (recordOf(study("NCT3", { drug: ["Cisplatin"], ancestors: ["Coordination Complexes", "Organic Chemicals"] })));
  const elsewhere = /** @type {any} */ (recordOf(study("NCT4", { cond: ["Diabetes Mellitus"] })));
  const placebo = /** @type {any} */ (recordOf(study("NCT5", { drug: ["Placebos"], ancestors: [] })));
  const generic = new Set(["Placebos", "Organic Chemicals"]);
  assert.equal(labelOf(q, same, generic), 2);
  assert.equal(labelOf(q, family, generic), 1);
  assert.equal(labelOf(q, elsewhere, generic), 0, "the same drug family in another condition is not a precedent");
  assert.equal(labelOf(q, placebo, generic), 0);
  assert.equal(labelOf(q, q, generic), 0, "a record is not its own precedent");
  // Placebos is generic only if the corpus says so.
  const qPlacebo = /** @type {any} */ (recordOf(study("NCT6", { drug: ["Placebos"], ancestors: [] })));
  assert.equal(labelOf(qPlacebo, placebo, new Set()), 2);
  assert.equal(labelOf(qPlacebo, placebo, generic), 0);
});

test("generic terms are the ones more than a share of the corpus holds, as a descriptor or as an ancestor", () => {
  const records = Array.from({ length: 100 }, (_, at) => recordOf(study(`NCT${at}`, { drug: at < 10 ? ["Placebos"] : [`Drug ${at}`], ancestors: at < 2 ? ["Rare Family"] : ["Organic Chemicals"] })));
  const generic = genericTerms(records, 0.03);
  assert.ok(generic.has("Placebos") && generic.has("Organic Chemicals"));
  assert.ok(!generic.has("Rare Family") && !generic.has("Drug 50"));
});

test("the metrics are the textbook ones, worked by hand", () => {
  // Ranked gains [2, 0, 1, 0, 0, 2]: DCG@10 = 3/log2(2) + 0 + 1/log2(4) + 0 + 0 + 3/log2(7) = 3 + 0.5 + 1.068 = 4.568; ideal [2,2,1,0..] = 3 + 3/log2(3) + 1/2 = 3 + 1.893 + 0.5 = 5.393.
  const ranked = [2, 0, 1, 0, 0, 2];
  assert.ok(Math.abs(ndcgAt(ranked, 10) - 4.5683 / 5.3928) < 1e-3, String(ndcgAt(ranked, 10)));
  assert.equal(precisionAt(ranked, 5), 2 / 5);
  assert.ok(Math.abs(averagePrecision(ranked) - (1 / 1 + 2 / 3 + 3 / 6) / 3) < 1e-12);
  assert.equal(reciprocalRank([0, 0, 1]), 1 / 3);
  assert.equal(reciprocalRank([0, 0]), 0);
  assert.equal(ndcgAt([0, 0], 10), 0, "nothing relevant: no credit");
  assert.equal(ndcgAt([2, 1, 0], 10), 1, "the ideal order is 1");
  assert.deepEqual(Object.keys(metricsOf(ranked)), ["ndcg10", "p5", "map", "mrr"]);
});

test("the bootstrap is seeded and its interval brackets the mean; a paired difference of equal lists is zero", () => {
  const values = Array.from({ length: 50 }, (_, at) => (at % 5) / 4);
  const a = bootstrapMean(values, { seed: 3 });
  assert.deepEqual(a, bootstrapMean(values, { seed: 3 }));
  assert.ok(a.low <= a.mean && a.mean <= a.high && a.n === 50);
  assert.ok(a.high - a.low < 0.25);
  assert.deepEqual(pairedDifference(values, values), { mean: 0, low: 0, high: 0, n: 50 });
  assert.equal(seeded(1)(), seeded(1)());
  assert.notEqual(seeded(1)(), seeded(2)());
});
