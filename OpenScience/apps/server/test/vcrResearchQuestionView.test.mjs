// What a reader makes of the research question: the card's gaps and events, and the rows it adds to a result's premises block (R22).
import assert from "node:assert/strict";
import test from "node:test";

import { presentResearchQuestion, researchQuestionPremises, resultQuestionInput } from "../src/vcrResearchQuestionView.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { presentProgressions } from "../src/vcrProgression.mjs";

const question = (fields, version = 1, bases = {}) => ({ id: "main", version, studyId: "s", fields, bases, written: [], by: "u", createdAt: null });

test("the card lists what is written with its basis and what is open as gaps, not errors", () => {
  const card = presentResearchQuestion(question({ question: "q", intercurrentEvents: [{ event: "停药", strategy: "principal_stratum", mechanism: "仍随访" }, { event: "死亡", strategy: null, mechanism: "" }] }, 2,
    { question: "person_edited", intercurrentEvents: "model_assembled" }), { modelId: "camd-adas-cog-11" });
  assert.equal(card.bases.question.label, "你在页面上改的");
  assert.deepEqual(card.gaps.map((gap) => gap.field), ["population", "treatment", "variable", "summary", "decisionContext", "assumptions"]);
  assert.deepEqual(card.events.map((event) => [event.state, event.stateLabel, event.mechanism]), [["not_representable", "这个模拟表示不了", "仍随访"], ["strategy_not_stated", "还没有写处理方式", ""]]);
  assert.equal(card.calibration.differs, true);
  assert.equal(presentResearchQuestion(null), null);
});

test("a study with no question adds no premise at all", () => {
  assert.deepEqual(researchQuestionPremises(null), []);
  assert.deepEqual(researchQuestionPremises({ question: null, ref: { id: "main", version: 1 } }), []);
});

test("a question with no events says what the default handling is, and nothing is claimed about a result that recorded no version", () => {
  const rows = researchQuestionPremises({ question: question({ question: "q" }, 3), ref: null, modelId: "camd-adas-cog-11" });
  assert.deepEqual(rows.map((row) => row.key), ["question:events_unstated"]);
  assert.equal(rows[0].decisive, false);
  assert.match(rows[0].value, /随机缺失/);
});

test("a result of an earlier version is marked, an event the simulation cannot represent is said in the event's words, and neither is a refusal", () => {
  const rows = researchQuestionPremises({
    question: question({ intercurrentEvents: [{ event: "因不良反应停药", strategy: "principal_stratum", mechanism: "" }, { event: "退出研究", strategy: "hypothetical", mechanism: "" }] }, 4),
    ref: { id: "main", version: 2 }, modelId: "camd-adas-cog-11",
  });
  assert.deepEqual(rows.map((row) => [row.key, row.decisive]), [["question:earlier", true], ["question:not_representable", true], ["question:calibration", false]]);
  assert.equal(rows[0].value, "这个结果回答的是研究问题的第 2 版；问题已经改到第 4 版，需要时重新计算。");
  assert.match(rows[1].value, /“因不良反应停药”按“只看一类人：事件会发生（或不会发生）的人（主层）”处理，这个模拟表示不了/);
  assert.doesNotMatch(rows[1].value, /退出研究/, "an event the model can represent is not listed as one it cannot");
  assert.match(rows[2].value, /混合的试验数据，大多数人在用药期间/);
});

test("the premises block of a result page carries the rows inside its five-decisive limit", () => {
  const premises = vcrPremises("trial", { configuration: {}, researchQuestion: { question: question({}, 2), ref: { id: "main", version: 1 }, modelId: null } });
  assert.ok(premises.some((row) => row.key === "question:earlier" && row.decisive));
  assert.ok(premises.filter((row) => row.decisive).length <= 5);
});

test("an Alzheimer progression card names the question it answered, through the job its execution ran", () => {
  const result = { id: "res_1", version: 1, kind: "progression_simulation", executionId: "exe_1", measures: [], counts: {},
    diagnostics: { progression: { family: "beta_logit", isNull: false, analysis: { kind: "change", visit: 78, alpha: 0.05 }, treatment: {}, outcomeUnit: "points",
      curves: [{ visit: 0, timeUnit: "weeks", control: { mean: { value: 20 } }, treated: { mean: { value: 20 } } }, { visit: 78, timeUnit: "weeks", control: { mean: { value: 25 } }, treated: { mean: { value: 23 } } }], given: [], assumed: [] } } };
  const bundle = { results: [result], stale: [], researchQuestion: question({ question: "q" }, 3),
    jobs: [{ id: "job_1", checkpoint: { questionRef: { id: "main", version: 1 } } }], executions: new Map([["exe_1", { jobId: "job_1" }]]) };
  const [card] = presentProgressions(bundle, { nodeOf: () => "result:res_1@1" });
  assert.ok(card, "the card is drawn");
  assert.ok(card.premises.some((row) => row.key === "question:earlier" && /第 1 版.*第 3 版/.test(row.value)));
  assert.deepEqual(resultQuestionInput(bundle, { executionId: "nope" }).ref, null);
});
