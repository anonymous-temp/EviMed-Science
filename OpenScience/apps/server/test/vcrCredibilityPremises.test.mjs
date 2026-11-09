// The credibility record of an Alzheimer result (plan R27, R28): the validation sentence is computed from the committed external validation, the applicability
// checks compare the run with what it covered, and nothing is said about the model's risk that the person did not state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_CREDIBILITY_FIELDS, vcrCredibilityRecord, vcrExternalValidation } from "@evimed/domain";
import { credibilityPremises } from "../src/vcrCredibilityPremises.mjs";
import { assessmentForModel, presentProgressions, progressionCard } from "../src/vcrProgression.mjs";
import { summarise } from "../../../evals/vcr-in-silico/external-validation/summarise.mjs";

const RESULT = new URL("../../../evals/vcr-in-silico/external-validation/result-20261109.json", import.meta.url);
const diagnostics = (overrides = {}) => ({ population: { mmseRange: [16, 26] }, extrapolation: { lastVisit: 78 }, treatment: { symptomaticLogitEmax: 0, diseaseModifyingFraction: 0 },
  reproduction: { reproduced: ["EMA qualification opinion 2013 Table 7"] }, trials: 5000, effectDistributions: [], ...overrides });
const byKey = (rows) => Object.fromEntries(rows.map((row) => [row.key, row]));

test("the domain's copy of the external validation is what the committed result gives, to the byte", () => {
  const made = summarise(RESULT.pathname);
  assert.deepEqual(vcrExternalValidation(), made);
  assert.equal(made.arms, 8);
  assert.ok(Number.isFinite(made.primary.long.meanBias) && Number.isFinite(made.primary.short.meanBias));
});

test("the validation sentence carries the result's own numbers and says only placebo arms were checked", () => {
  const rows = byKey(credibilityPremises(diagnostics()));
  const v = vcrExternalValidation();
  const row = rows["credibility:validation"];
  assert.equal(row.decisive, true);
  // a validation on published placebo arms is the literature's, not “由你给的数据算出” (review P1-2); and it says the trials were published after the fit,
  // never that the model had not seen them (the frozen protocol does not establish that: review P2-9, S5)
  assert.equal(row.source, "literature");
  assert.match(row.value, new RegExp(`在 ${v.arms} 项发表时间晚于模型拟合的试验的安慰剂组上`));
  assert.doesNotMatch(`${row.label}${row.value}`, /没见过/);
  assert.match(rows["credibility:validation-scope"].value, /没有核实其中有没有哪一项已经在拟合所用的数据库里/);
  assert.equal(rows["credibility:validation-scope"].decisive, false, "the qualification is folded");
  assert.equal(rows["credibility:structure"].source, "literature");
  assert.equal(rows["credibility:applicability"].source, "default", "a range check is computed by the platform, not from the person's data");
  assert.ok(row.value.includes(String(Number(Math.abs(v.primary.long.meanBias).toPrecision(3)))));
  assert.match(row.value, new RegExp(`${v.primary.long.covered}/${v.primary.long.arms} 项`));
  assert.match(row.value, /只检验了安慰剂组/);
  assert.match(rows["credibility:structure"].value, /没有取平均/);
});

test("the applicability row is decisive only when the run leaves what was validated", () => {
  const inside = byKey(credibilityPremises(diagnostics()))["credibility:applicability"];
  assert.equal(inside.decisive, false);
  assert.match(inside.value, /基线 MMSE 16–26 分在验证过的/);
  const outsideMmse = byKey(credibilityPremises(diagnostics({ population: { mmseRange: [5, 30] } })))["credibility:applicability"];
  assert.equal(outsideMmse.decisive, true);
  assert.match(outsideMmse.value, /超出了验证过的/);
  const outsideHorizon = byKey(credibilityPremises(diagnostics({ extrapolation: { lastVisit: 104 } })))["credibility:applicability"];
  assert.equal(outsideHorizon.decisive, true);
  assert.match(outsideHorizon.value, /超过了验证过的最长 78 周/);
  const drug = byKey(credibilityPremises(diagnostics({ treatment: { symptomaticLogitEmax: -0.3 } })))["credibility:applicability"];
  assert.match(drug.value, /药物效果没有被这些检验覆盖/);
  assert.equal(drug.decisive, false);
});

test("the model risk comes only from a stored assessment's two ratings, by M15's rule, and is never defaulted", () => {
  const record = vcrCredibilityRecord({});
  assert.deepEqual(record.items.map((item) => item.field), [...VCR_CREDIBILITY_FIELDS]);
  const field = (name, r = record) => r.items.find((item) => item.field === name);
  assert.equal(field("model_risk").basis, "not_stated");
  assert.equal(field("question_of_interest").basis, "not_stated");
  assert.equal(field("validation").basis, "computed");
  assert.match(byKey(credibilityPremises(diagnostics()))["credibility:risk"].value, /研究里没有记下评估时，这里不给模型风险等级/);
  const given = vcrCredibilityRecord({ assessment: { questionOfInterest: "第 78 周检验的把握", contextOfUse: "设计一项试验", influence: "low", consequence: "high" } });
  assert.equal(field("question_of_interest", given).basis, "stated");
  assert.deepEqual(field("model_risk", given).data, { level: "high", rule: "driven_by_consequence" });
  assert.equal(field("model_risk", given).decisive, true);
  const onlyOne = vcrCredibilityRecord({ assessment: { influence: "low" } });
  assert.equal(field("model_risk", onlyOne).basis, "not_stated");
});

test("the Alzheimer page carries the validation as one of at most five decisive premises, and no back-office word", () => {
  const fixture = { ...JSON.parse(readFileSync(new URL("./fixtures/vcr-progression/alzheimer-beta-logit.json", import.meta.url), "utf8")), id: "res_1", version: 1, kind: "progression_simulation", createdAt: "2026-11-09T00:00:00Z" };
  const card = progressionCard(fixture);
  const rows = byKey(card.premises);
  assert.ok(rows["credibility:validation"]);
  assert.ok(card.premises.filter((premise) => premise.decisive).length <= 5);
  for (const key of ["credibility:validation", "credibility:structure", "credibility:applicability", "credibility:verification", "credibility:risk"]) {
    if (rows[key]) assert.doesNotMatch(`${rows[key].label} ${rows[key].value}`, /[a-z]+_[a-z_]+|patients\.progression|N\d{3}/);
  }
  // no English table name of the engine reaches the page (review P1-13), and the verification row is one fold of the card, not a third copy of the replicate sentence
  assert.equal(rows["credibility:verification"], undefined);
  assert.doesNotMatch(card.premises.map((premise) => premise.value).join(" "), /EMA qualification opinion|Table \d/);
});

test("a stored assessment of the model the result runs on shows the computed model risk on the page; one about another model, or none, shows nothing", () => {
  const fixture = { ...JSON.parse(readFileSync(new URL("./fixtures/vcr-progression/alzheimer-beta-logit.json", import.meta.url), "utf8")), id: "res_1", version: 1, kind: "progression_simulation", createdAt: "2026-11-09T00:00:00Z" };
  const record = (over) => ({ key: "q1", version: 1, modelName: "camd-adas-cog-11", modelVersion: "", influence: "low", consequence: "high", createdAt: "2026-11-09T01:00:00Z", ...over });
  const bundle = (assessments) => ({ allResults: [fixture], assessments, stale: [] });
  const risk = (assessments) => byKey(presentProgressions(bundle(assessments), { nodeOf: () => "n" })[0].premises)["credibility:risk"];
  const bound = risk([record({})]);
  // the record may be the assistant's own (nothing says whose it is), so it is not “你给的数据” (review P1-1)
  assert.equal(bound.source, "assumed");
  assert.match(bound.value, /^按研究里记下的评估：/);
  assert.match(bound.value, /影响低，决定出错的后果高，模型风险高/);
  assert.match(bound.value, /错误决策的后果/);
  // the page keeps at most five decisive rows, so the shared builder may fold this one; the row itself asks to be decisive when the risk is high
  assert.equal(byKey(credibilityPremises(diagnostics(), record({})))["credibility:risk"].decisive, true);
  // the newest record about the model wins; a version that is not the parameter set's, and another model's record, bind nothing
  assert.match(risk([record({ key: "old", influence: "high", createdAt: "2026-11-01T00:00:00Z" }), record({ influence: "low", consequence: "low", createdAt: "2026-11-09T02:00:00Z" })]).value, /模型风险低/);
  for (const none of [[], [record({ modelName: "other-model" })], [record({ modelVersion: "adsim-9" })], [record({ influence: "", consequence: "" })]]) {
    assert.match(risk(none).value, /研究里没有记下评估时，这里不给模型风险等级/);
  }
  assert.equal(assessmentForModel([record({ modelVersion: "adsim-3.0" })], "camd-adas-cog-11")?.key, "q1");
  assert.equal(assessmentForModel([record({})], null), null);
});
