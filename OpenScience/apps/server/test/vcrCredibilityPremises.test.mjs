// The credibility record of an Alzheimer result (plan R27, R28): the validation sentence is computed from the committed external validation, the applicability
// checks compare the run with what it covered, and nothing is said about the model's risk that the person did not state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_CREDIBILITY_FIELDS, vcrCredibilityRecord, vcrExternalValidation } from "@evimed/domain";
import { credibilityPremises } from "../src/vcrCredibilityPremises.mjs";
import { progressionCard } from "../src/vcrProgression.mjs";
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
  assert.equal(row.source, "derived");
  assert.match(row.value, new RegExp(`在 ${v.arms} 项模型没见过的试验的安慰剂组上`));
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
  assert.match(byKey(credibilityPremises(diagnostics()))["credibility:risk"].value, /没有说明时这里不给模型风险等级/);
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
});
