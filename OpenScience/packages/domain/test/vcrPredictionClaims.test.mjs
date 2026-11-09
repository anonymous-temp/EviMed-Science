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
  const none = predictionClaimPremise("individualized_forecast");
  assert.equal(none.decisive, true);
  assert.equal(none.key, "claim:individualized_forecast");
  assert.ok(none.value.includes("不说它比简单做法更准"));
  const no = predictionClaimPremise("individualized_forecast", { helped: false });
  assert.ok(no.value.includes("没有显示比") && !no.value.includes("小于"));
  const yes = predictionClaimPremise("individualized_forecast", { helped: true });
  assert.ok(yes.value.includes("95%区间不含0"));
  // the other two claims say nothing about accuracy of individualizing
  assert.ok(!predictionClaimPremise("population_forecast", { helped: true }).value.includes("95%"));
});
