// A progression run on a record of virtual people is presented as what it is (round-2 review P0-1): its study is the record's, fixed, so the chance it states
// is conditional on that one study and no premise says a new study is drawn each time; the paired mode's answer is the contrast of the same people under both
// arms (the model's reading, never an observed individual effect); the record's out-of-range people and its being made for an earlier model reach the premises.
// The shapes are the engine's own (`.vcr_bl_record_report`, `.vcr_bl_paired_result` in patients_progression_people.R) laid over its committed Alzheimer fixture.
// The same file holds the rest of the card's source words (P1-1 to P1-3, P1-9, P1-12): nothing reads 你给的数据 without a checked record of the person's messages,
// a computed check is never 由你给的数据算出, the effect row ends by its tier, and a closed quantity has one name on every page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_RESULT_QUANTITY_LABELS_ZH } from "@evimed/domain";
import { powerQuantityLabel, presentProgressions, progressionCard, progressionPowerQuantity, scenarioPowerQuantity, PEOPLE_MODE_TEXT_ZH } from "../src/vcrProgression.mjs";
import { measureLabel, measureValue } from "../src/vcrViewsKit.mjs";

const fixture = (name) => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/vcr-progression/${name}.json`, import.meta.url), "utf8")), id: "res_1", version: 1, kind: "progression_simulation", createdAt: "2026-11-09T00:00:00Z" });
const row = (card, key) => card.premises.find((premise) => premise.key === key);
const strings = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === "object" ? Object.values(node).flatMap(strings) : []);
const people = (mode, extra = {}) => ({ mode, inputId: "res_people:progression-people", tableSha256: "a".repeat(64), people: 400, madeForParameterSetSha256: "b".repeat(64), madeForCurrentModel: true,
  outsideFittedMmse: 0, fittedMmse: [14, 26], study: { tau: 0.1, omega: 0.2 }, sampling: "without_replacement", ...extra });

/** What a resampled run on a record reports: the engine states `uncertainty: fixed_study` (until round 2 it kept the model's default, new_study, although the study is fixed). */
function resampled(extra = {}) {
  const result = fixture("alzheimer-beta-logit");
  result.diagnostics.progression.isNull = false;
  result.diagnostics.progression.people = people("resampled_trials", extra);
  result.diagnostics.progression.uncertainty = "fixed_study";
  return result;
}
/** The paired result: no `power`, `uncertainty` is `fixed_study`, `calculatedFor` is `people_of_record`. */
function paired(extra = {}) {
  const result = fixture("alzheimer-beta-logit");
  const measure = (name, value, unit = "points") => ({ name, value, mcse: 0.02, simulated: true, source: "synthetic", ...(unit ? { unit } : {}) });
  result.measures = [measure("paired_mean_contrast", -1.9), measure("paired_latent_mean_contrast", -2.1), measure("paired_latent_sd", 0.6), measure("paired_latent_q10", -2.9),
    measure("paired_latent_q50", -2.1), measure("paired_latent_q90", -1.4), measure("paired_share_improved", 0.97, null), measure("paired_observed_share", 0.82, null)];
  Object.assign(result.diagnostics.progression, { isNull: false, uncertainty: "fixed_study", calculatedFor: "people_of_record", people: people("paired_counterfactual", extra) });
  return result;
}

test("P0-1 a resampled run on a record states a chance conditional on the record's one study, and says no new study is drawn", () => {
  const card = progressionCard(resampled({ outsideFittedMmse: 12, madeForCurrentModel: false }));
  assert.equal(card.powerQuantity, "conditional_power_fixed_study");
  assert.equal(card.powerName, VCR_RESULT_QUANTITY_LABELS_ZH.conditional_power_fixed_study);
  const all = strings({ title: card.title, question: card.question, powerName: card.powerName, premises: card.premises }).join("\n");
  assert.doesNotMatch(all, /考虑研究之间差异后的预期把握度/, "the between-study quantity is not the name of this number");
  assert.doesNotMatch(all, /每次模拟的试验都按一项新研究抽取/);
  assert.match(row(card, "progression:ad:uncertainty").value, /固定的研究.*没有研究之间的差异/);
  assert.equal(row(card, "progression:ad:uncertainty").source, "default", "the engine's rule, not the person's data");
  assert.match(card.title, /在这批虚拟患者所属的研究里/);
});

test("P0-1 the record's size, out-of-range people and earlier model reach the premises as decisive rows", () => {
  const card = progressionCard(resampled({ outsideFittedMmse: 12, madeForCurrentModel: false }));
  assert.match(row(card, "progression:ad:people").value, /400 个虚拟患者/);
  assert.match(row(card, "progression:ad:people").value, /不是真人/);
  assert.equal(row(card, "progression:ad:people").source, "default", "the engine drew these people from the model, not the person");
  assert.match(row(card, "progression:ad:people-range").value, /400 个人里有 12 个人的基线 MMSE 在模型拟合所用试验的入组范围（14–26 分）之外，他们的结果是外推/);
  assert.match(row(card, "progression:ad:people-model").value, /更早的一版模型参数/);
  assert.ok(card.premises.filter((p) => p.decisive).length <= 5);
  for (const key of ["progression:ad:people", "progression:ad:people-range", "progression:ad:people-model"]) assert.ok(row(card, key), key);
  assert.ok(row(card, "progression:ad:people").decisive, "who the people are is decisive");
  assert.equal(row(card, "progression:ad:mmse"), undefined, "the entry range is the record's, not 按模型默认的入组范围");
  // a record inside the range and made for this model says neither
  const clean = progressionCard(resampled());
  assert.equal(row(clean, "progression:ad:people-range"), undefined);
  assert.equal(row(clean, "progression:ad:people-model"), undefined);
});

test("P0-1 the paired mode shows the per-person contrast as the result, model-implied, with no power section", () => {
  const card = progressionCard(paired({ outsideFittedMmse: 3 }));
  assert.equal(card.power, null);
  assert.equal(card.powerQuantity, null);
  assert.ok(card.paired, "the paired block is the headline");
  assert.deepEqual(card.paired.measures.map((m) => m.key), ["paired_mean_contrast", "paired_latent_mean_contrast", "paired_latent_sd", "paired_latent_q10", "paired_latent_q50", "paired_latent_q90", "paired_share_improved", "paired_observed_share"]);
  assert.equal(card.paired.measures.find((m) => m.key === "paired_share_improved").value.unit, "%", "a share is a percentage");
  assert.equal(card.paired.sentence, PEOPLE_MODE_TEXT_ZH.paired_counterfactual);
  assert.match(card.paired.sentence, /不是任何试验观察到的个体疗效/);
  assert.match(card.question, /同一批虚拟患者，用药和不用药各会怎样/);
  assert.doesNotMatch(card.question, /检验判出有效的把握/);
  assert.doesNotMatch(card.powerName, /把握度/);
  assert.match(row(card, "progression:ad:people").value, /同一批虚拟患者：每个人在各组里个体特征/);
  assert.match(row(card, "progression:ad:people-range").value, /3 个人/);
  assert.doesNotMatch(strings(card.premises).join(""), /每次模拟的试验都按一项新研究抽取|在典型研究条件下的把握度/);
});

test("P0-1 a run that is not on a record keeps its mode's name and the entry-range row", () => {
  const card = progressionCard(fixture("alzheimer-beta-logit"));
  assert.equal(card.paired, null);
  assert.ok(row(card, "progression:ad:mmse"));
  assert.equal(row(card, "progression:ad:people"), undefined);
  assert.equal(progressionPowerQuantity({ uncertainty: "posterior_draws" }), "expected_power_over_parameters");
  assert.equal(progressionPowerQuantity({ isNull: true }), null);
  assert.equal(progressionPowerQuantity({ uncertainty: "fixed_study" }), "conditional_power_fixed_study", "the engine's own word names the quantity, with or without the people block");
  assert.equal(progressionPowerQuantity({ effectDistributions: [{}], people: { mode: "x" } }), "assurance");
  assert.equal(progressionPowerQuantity({ people: { mode: "resampled_trials" } }), "conditional_power_fixed_study");
  assert.equal(scenarioPowerQuantity({ model: { uncertainty: "new_study" } }), "expected_power_over_studies");
  assert.equal(scenarioPowerQuantity({}), "conditional_power_typical_study");
  assert.equal(scenarioPowerQuantity({ treatment: { symptomatic: { pointsAt: { distribution: { family: "normal" } } } } }), "assurance");
  assert.equal(powerQuantityLabel("expected_power_over_studies"), VCR_RESULT_QUANTITY_LABELS_ZH.expected_power_over_studies);
});

test("P1-1 and P1-2 no row of an Alzheimer card reads 你给的数据 without a record, and a computed check is never 由你给的数据算出", () => {
  for (const name of ["alzheimer-beta-logit", "alzheimer-reference-inhibitor", "alzheimer-mechanism-chain"]) {
    const card = progressionCard(fixture(name));
    for (const premise of card.premises) {
      assert.notEqual(premise.source, "derived", `${name}: ${premise.key} is not computed from the person's data`);
      if (premise.source === "given") assert.fail(`${name}: ${premise.key} reads 你给的数据 with no record of the person's messages`);
    }
  }
  const card = progressionCard(fixture("alzheimer-reference-inhibitor"));
  assert.equal(row(card, "credibility:validation").source, "literature");
  assert.equal(row(card, "credibility:structure").source, "literature");
});

test("P1-3 the effect row of each tier ends by its tier, and the question follows the quantity", () => {
  const stated = progressionCard(fixture("alzheimer-beta-logit"));
  assert.match(row(stated, "progression:ad:effect").value, /这是你设定的假设，不是对某个药物疗效的预测|没有设定药物效果/);
  const chain = progressionCard(fixture("alzheimer-mechanism-chain"));
  assert.doesNotMatch(row(chain, "progression:ad:effect").value, /这是你设定的假设/);
  assert.equal(chain.powerQuantity, "assurance");
  assert.match(chain.question, /按药效的不确定性平均后/);
});

test("P1-12 the estimand table's numbers have names a person reads and percentages that agree with the premise", () => {
  for (const name of ["ci_coverage", "estimand_truth", "estimator_bias", "realized_share", "exposure_patient_time", "people_forecast", "people_without_forecast"]) {
    assert.notEqual(measureLabel(name), name, `${name} has a label`);
    assert.doesNotMatch(measureLabel(name), /[a-z]+_[a-z_]+/);
  }
  const coverage = measureValue({ name: "ci_coverage", value: 0.947, mcse: 0.004, simulated: true, source: "synthetic" }, { kind: "patient_set", result: { id: "res_1", version: 1 }, tab: "patients" });
  assert.equal(coverage.unit, "%");
  assert.equal(coverage.value, 94.7, "the table shows 94.7%, as the premise row says it");
  assert.equal(coverage.detail.title, "95% 区间覆盖率");
});

test("P1-12 the table marks the strategy the research question wants, not the run's own aim, and says which", () => {
  const result = fixture("alzheimer-beta-logit");
  const estimand = (strategy) => ({ strategy, truth: { name: "estimand_truth", value: -2, mcse: 0.02, unit: "points", source: "synthetic", simulated: true }, bias: { name: "estimator_bias", value: -0.1, mcse: 0.02, source: "synthetic", simulated: true }, coverage: { name: "ci_coverage", value: 0.947, mcse: 0.004, source: "synthetic", simulated: true } });
  result.diagnostics.progression.intercurrent = { claimed: "hypothetical", estimator: "mmrm", data: "all_observed", configuration: {}, estimands: [estimand("treatment_policy"), estimand("hypothetical")] };
  const asked = (strategies) => presentProgressions({ allResults: [result], stale: [], researchQuestion: { id: "main", version: 1, fields: { intercurrentEvents: strategies.map((strategy) => ({ event: "停药", strategy })) }, bases: {} } }, { nodeOf: () => "n" })[0];
  const fromQuestion = asked(["treatment_policy"]);
  assert.deepEqual(fromQuestion.estimands.rows.map((r) => [r.key, r.claimed, r.claimedBy]), [["treatment_policy", true, "question"], ["hypothetical", false, "question"]]);
  const fromRun = asked([]);
  assert.deepEqual(fromRun.estimands.rows.map((r) => [r.key, r.claimed, r.claimedBy]), [["treatment_policy", false, "run"], ["hypothetical", true, "run"]]);
  assert.equal(row(fromRun, "progression:ad:estimand").source, "default");
});
