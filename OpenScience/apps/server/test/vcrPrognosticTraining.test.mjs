// The comparison page's card of a prognostic model trained on the person's own table (algorithm round P3): the engine's real results (tests/numeric N98 hold their
// numbers to references) read into the payload the page shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_METHODS, VCR_RESULT_KIND_TABS } from "@evimed/domain";
import { prognosticCard, presentPrognosticModels, vcrPrognosticSubjectId } from "../src/vcrPrognosticTraining.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";

const fixture = (name) => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/vcr-prognostic-training/${name}.json`, import.meta.url), "utf8")), id: "res_1", version: 2, kind: "prognostic_training", createdAt: "2026-11-04T00:00:00Z" });
const strings = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === "object" ? Object.values(node).flatMap(strings) : []);

test("a trained model is a result of its own kind, read on the comparison tab", () => {
  assert.equal(VCR_JOB_METHODS.train_prognostic_model, "model.prognostic_train");
  assert.equal(vcrResultKindFor("train_prognostic_model"), "prognostic_training");
  assert.equal(VCR_RESULT_KIND_TABS.prognostic_training, "comparator");
});

test("the same configuration is the same key and another outcome is another", () => {
  const scenario = { inputId: "a", endpoint: { type: "binary", outcomeColumn: "y" }, predictors: [{ column: "age", unit: "years" }] };
  assert.equal(vcrPrognosticSubjectId(scenario), vcrPrognosticSubjectId(structuredClone(scenario)));
  assert.notEqual(vcrPrognosticSubjectId(scenario), vcrPrognosticSubjectId({ ...scenario, endpoint: { type: "binary", outcomeColumn: "z" } }));
});

test("the card says what the model is, shows the out-of-fold figures and the table of savings under each discount", () => {
  const card = prognosticCard(fixture("cox"));
  assert.equal(card.form, "trained");
  assert.equal(card.label, "用你自己的数据训练，没有在别的人群验证过");
  assert.deepEqual(card.headline.map((entry) => entry.key), ["out_of_fold_c_index", "calibration_slope", "calibration_in_the_large", "prognostic_correlation"]);
  assert.ok(card.headline[0].value.interval.low < card.headline[0].value.value && card.headline[0].value.value < card.headline[0].value.interval.high);
  assert.equal(card.savings.rows.length, 4 * 3, "four discounts on the correlation and three on the control SD");
  const full = card.savings.rows.find((row) => row.lambda === 1 && row.gamma === 1);
  const heavy = card.savings.rows.find((row) => row.lambda === 0.5 && row.gamma === 1.25);
  assert.equal(full.estimate.saving.unit, "%");
  assert.ok(full.estimate.saving.value > full.lower.saving.value, "the lower end of the correlation saves less");
  assert.ok(heavy.estimate.saving.value < full.estimate.saving.value, "a harsher discount saves less");
  assert.ok(full.estimate.saving.value > 0 && full.estimate.saving.value < 40);
  assert.equal(card.comparison.difference.source, "calculated");
  assert.equal(card.trainedOn.folds, 5);
});

test("the premises are the data, the cross-fitting, the definition of the correlation and the discounts, with the defaults said", () => {
  const card = prognosticCard(fixture("cox"));
  const byKey = Object.fromEntries(card.premises.map((entry) => [entry.key, entry]));
  assert.ok(byKey.prognosticTraining.decisive && byKey.prognosticTraining.value.includes("没有在别的人群验证过"));
  assert.ok(byKey.prognosticFolds.decisive && byKey.prognosticFolds.value.includes("5 折"));
  assert.ok(byKey.prognosticRho.value.includes("近似"), "the time-to-event correlation says it is an approximation");
  assert.equal(byKey.prognosticDiscount.source, "default");
  assert.ok(card.premises.filter((entry) => entry.decisive).length <= 5);
});

test("a coefficient is shown as the effect a reader knows: a ratio for Cox, a change for a linear model", () => {
  const cox = prognosticCard(fixture("cox"));
  const lin = prognosticCard(fixture("linear"));
  assert.equal(cox.effectWords, "每增加 1 个单位，风险比");
  assert.equal(lin.effectWords, "每增加 1 个单位，结局的变化");
  assert.ok(cox.terms.every((term) => term.effect.value > 0), "a ratio is positive");
  assert.ok(lin.terms.some((term) => term.effect.value < 0), "a coefficient of the truth's sign");
  assert.ok(lin.headline.some((entry) => entry.key === "out_of_fold_r_squared"));
});

test("a model that was not estimated says why in a sentence and shows no number", () => {
  const card = prognosticCard(fixture("too-few-events"));
  assert.equal(card.form, "refused");
  assert.match(card.refusal, /太少/);
  assert.deepEqual(card.headline, []);
  assert.equal(card.savings, null);
});

test("the cards of the tab are the current results, newest first, and no back-office word is in a sentence", () => {
  const bundle = { allResults: [fixture("cox"), { ...fixture("linear"), id: "res_2", createdAt: "2026-11-05T00:00:00Z" }, { ...fixture("cox"), id: "res_3", supersededBy: "res_4" }], stale: [] };
  const cards = presentPrognosticModels(bundle, { nodeOf: (result) => `result:${result.id}` });
  assert.deepEqual(cards.map((card) => card.id), ["res_2", "res_1"]);
  for (const card of cards) {
    const words = strings({ title: card.title, question: card.question, label: card.label, notes: card.correlationNote, premises: card.premises.map((p) => [p.label, p.value]), terms: card.terms.map((t) => t.label) });
    for (const word of words) assert.ok(!/[a-z]+_[a-z_]+/.test(word), word);
  }
});
