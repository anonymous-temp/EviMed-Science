import assert from "node:assert/strict";
import test from "node:test";
import { VCR_PREDICTION_CLAIMS, VCR_PREDICTION_CLAIM_WORDS_ZH, individualizationEvidenceSentence, predictionClaimOf, predictionClaimPremise } from "../index.mjs";

test("the claim follows what the forecast was given, and is unknown when the provider did not say", () => {
  assert.equal(predictionClaimOf({ real: false }), "virtual_cohort");
  assert.equal(predictionClaimOf({ real: true, usesOwnHistory: false }), "population_forecast");
  assert.equal(predictionClaimOf({ real: true, usesOwnHistory: true }), "individualized_forecast");
  assert.equal(predictionClaimOf({ real: true }), null);
  assert.equal(predictionClaimOf({ real: true, usesOwnHistory: null }), null);
  assert.equal(predictionClaimPremise(null), null);
});

test("each claim has its own words, in Chinese, with plain quotes and no back office", () => {
  assert.deepEqual(Object.keys(VCR_PREDICTION_CLAIM_WORDS_ZH), [...VCR_PREDICTION_CLAIMS]);
  const sentences = VCR_PREDICTION_CLAIMS.map(c => VCR_PREDICTION_CLAIM_WORDS_ZH[c].sentence);
  assert.equal(new Set(sentences).size, 3);
  for (const claim of VCR_PREDICTION_CLAIMS) {
    const w = VCR_PREDICTION_CLAIM_WORDS_ZH[claim];
    for (const text of [w.label, w.sentence, w.evidence, individualizationEvidenceSentence(true), individualizationEvidenceSentence(false), individualizationEvidenceSentence(null)]) {
      assert.match(text, /[一-鿿]/);
      assert.ok(!/[「」]/.test(text), "UI quotes are “”, not 「」");
      assert.ok(!/LOCF|EB|MAP|Laplace|nlme|job|tool|id\b|hash/i.test(text), text);
    }
  }
});

test("an individualized forecast is never called better without the frozen comparison, and the premise is one decisive row", () => {
  const none = /** @type {any} */ (predictionClaimPremise("individualized_forecast"));
  assert.equal(none.decisive, true);
  assert.equal(none.key, "claim:individualized_forecast");
  assert.ok(none.value.includes("不说它比简单做法更准"));
  const no = /** @type {any} */ (predictionClaimPremise("individualized_forecast", { helped: false }));
  assert.ok(no.value.includes("没有显示比") && !no.value.includes("小于"));
  const yes = /** @type {any} */ (predictionClaimPremise("individualized_forecast", { helped: true }));
  assert.ok(yes.value.includes("95% 区间不含 0"));
  // the other two claims say nothing about accuracy of individualizing
  assert.ok(!/** @type {any} */ (predictionClaimPremise("population_forecast", { helped: true })).value.includes("95%"));
});

test("review P2-13: a batch page never says 「这位患者」 or 「他」, the finding carries the run's scope, and the no-evaluation sentence is no process wording", () => {
  for (const claim of ["population_forecast", "individualized_forecast"]) {
    const words = VCR_PREDICTION_CLAIM_WORDS_ZH[claim].sentence;
    assert.doesNotMatch(words, /这位患者|他自己|他们的|用他/, claim);
  }
  const yes = individualizationEvidenceSentence(true, "cd4_count");
  assert.match(yes, /两个公开的试验人群/);
  assert.match(yes, /平方根/);
  assert.match(yes, /约 6 个月和约 76 周/);
  assert.match(yes, /不能直接引用/);
  const none = individualizationEvidenceSentence(null);
  assert.doesNotMatch(none, /用的方法不是评估过的那一种/);
  assert.match(none, /没有做过个体化预测的对照评估/);
  assert.match(none, /已知真值的模拟患者/);
});
