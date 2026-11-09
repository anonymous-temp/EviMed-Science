/** The research question: versioning, basis precedence, what a model can represent, what its data estimate (round-2 R22). */
import assert from "node:assert/strict";
import test from "node:test";

import {
  VCR_QUESTION_BASES, VCR_QUESTION_STRATEGIES, applyQuestionPatch, normalizeQuestionPatch, questionAnswersEarlier, questionCalibration,
  questionRepresentability,
} from "@evimed/domain";

const patch = (raw) => { const { patch: p, issues } = normalizeQuestionPatch(raw); assert.deepEqual(issues, []); return p; };

test("every field is optional: an empty patch is no version and a first field is version 1", () => {
  assert.equal(applyQuestionPatch(null, {}, "person_stated").changed, false);
  assert.equal(applyQuestionPatch(null, {}, "person_stated").version, 0);
  const first = applyQuestionPatch(null, patch({ question: "  多奈哌齐在 78 周能否延缓 ADAS-Cog 恶化？ " }), "person_stated");
  assert.equal(first.version, 1);
  assert.deepEqual(first.written, ["question"]);
  assert.equal(first.fields.question, "多奈哌齐在 78 周能否延缓 ADAS-Cog 恶化？");
  assert.equal(first.bases.question, "person_stated");
});

test("a patch writes the next version and keeps the fields it does not name; object fields merge by sub-field", () => {
  const v1 = applyQuestionPatch(null, patch({ variable: { endpoint: "ADAS-Cog 11" }, question: "q" }), "model_assembled");
  const v2 = applyQuestionPatch(v1, patch({ variable: { timePoint: "第 78 周" } }), "model_assembled");
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.fields.variable, { endpoint: "ADAS-Cog 11", timePoint: "第 78 周" });
  assert.equal(v2.fields.question, "q");
  const v3 = applyQuestionPatch(v2, patch({ variable: { endpoint: null } }), "model_assembled");
  assert.deepEqual(v3.fields.variable, { timePoint: "第 78 周" });
});

test("an identical patch is no new version and does not change the basis", () => {
  const v1 = applyQuestionPatch(null, patch({ question: "q" }), "person_edited");
  const again = applyQuestionPatch(v1, patch({ question: "q" }), "model_assembled");
  assert.equal(again.changed, false);
  assert.equal(again.version, 1);
  assert.equal(again.bases.question, "person_edited");
  assert.deepEqual(again.kept, [], "an identical value is not a conflict");
});

test("a person's edit is the stronger basis: a weaker write over it is kept, reported and not applied", () => {
  assert.deepEqual([...VCR_QUESTION_BASES], ["model_assembled", "person_stated", "person_edited"]);
  const edited = applyQuestionPatch(null, patch({ question: "页面上改的", summary: "s" }), "person_edited");
  const model = applyQuestionPatch(edited, patch({ question: "模型整理的", summary: "s2" }), "person_stated");
  assert.equal(model.fields.question, "页面上改的");
  assert.deepEqual(model.kept, [{ field: "question", basis: "person_edited" }, { field: "summary", basis: "person_edited" }]);
  assert.equal(model.changed, false);
  const stated = applyQuestionPatch(null, patch({ question: "说的" }), "person_stated");
  assert.equal(applyQuestionPatch(stated, patch({ question: "整理" }), "model_assembled").fields.question, "说的");
  assert.equal(applyQuestionPatch(stated, patch({ question: "改了" }), "person_edited").fields.question, "改了");
  assert.equal(applyQuestionPatch(stated, patch({ question: "再说一次" }), "person_stated").fields.question, "再说一次", "an equal basis writes");
});

test("an unreadable part of a patch is an issue with its field and the rest is kept", () => {
  const { patch: kept, issues } = normalizeQuestionPatch({
    question: "q", intercurrentEvents: [{ event: "停药", strategy: "ignore" }], treatment: { interventionModel: { id: "m", tier: "Z" }, text: "t" }, nope: 1,
  });
  assert.deepEqual(issues.map((entry) => entry.field).sort(), ["intercurrentEvents[0].strategy", "nope", "treatment.interventionModel"]);
  assert.equal(kept.question, "q");
  assert.deepEqual(kept.treatment, { text: "t" });
  assert.equal("intercurrentEvents" in kept, false);
});

test("intercurrent events: the five strategies, a strategy may wait, an event needs its name", () => {
  assert.deepEqual([...VCR_QUESTION_STRATEGIES], ["treatment_policy", "hypothetical", "composite", "while_on_treatment", "principal_stratum"]);
  const p = patch({ intercurrentEvents: [{ event: "因不良反应停药", strategy: "treatment_policy", mechanism: "停药后仍随访" }, { event: "死亡" }] });
  assert.deepEqual(p.intercurrentEvents[1], { event: "死亡", strategy: null, mechanism: "" });
  assert.ok(normalizeQuestionPatch({ intercurrentEvents: [{ strategy: "hypothetical" }] }).issues.length);
});

test("representability is computed from the model's capabilities, never refused", () => {
  const question = { fields: { intercurrentEvents: [
    { event: "停药", strategy: "treatment_policy" }, { event: "退出研究", strategy: "hypothetical" }, { event: "死亡", strategy: null },
  ] } };
  const states = questionRepresentability(question, "camd-adas-cog-11").map((entry) => entry.state);
  assert.deepEqual(states, ["not_representable", "representable", "strategy_not_stated"]);
  assert.deepEqual(questionRepresentability({ fields: {} }, null), []);
  assert.equal(questionRepresentability(question, "some-other-model")[0].state, "not_representable");
});

test("the calibration estimand of the AD model, and when the question differs from it", () => {
  const same = questionCalibration({ fields: { intercurrentEvents: [{ event: "退出", strategy: "hypothetical" }] } }, "camd-adas-cog-11");
  assert.equal(same.differs, false);
  assert.match(same.sentence, /混合的试验数据/);
  assert.equal(questionCalibration({ fields: { intercurrentEvents: [{ event: "停药", strategy: "treatment_policy" }] } }, "camd-adas-cog-11").differs, true);
  assert.equal(questionCalibration({ fields: {} }, "camd-adas-cog-11").differs, false, "no stated strategy, nothing to differ from");
  assert.equal(questionCalibration({ fields: {} }, "unknown"), null, "nothing is claimed about a model whose data are not described");
});

test("a result reads as answering an earlier version only when it recorded one", () => {
  const current = { id: "rq_1", version: 2 };
  assert.deepEqual(questionAnswersEarlier({ id: "rq_1", version: 1 }, current), { answeredVersion: 1, currentVersion: 2 });
  assert.equal(questionAnswersEarlier({ id: "rq_1", version: 2 }, current), null);
  assert.equal(questionAnswersEarlier(null, current), null);
  assert.equal(questionAnswersEarlier({ id: "other", version: 1 }, current), null);
});
