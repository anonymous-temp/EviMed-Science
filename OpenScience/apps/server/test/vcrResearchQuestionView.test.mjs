// What a reader makes of the research question: the card's gaps and events, and the rows it adds to a result's premises block (R22).
import assert from "node:assert/strict";
import test from "node:test";

import { presentResearchQuestion, questionModelId, researchQuestionPremises, resultQuestionInput } from "../src/vcrResearchQuestionView.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { presentProgressions } from "../src/vcrProgression.mjs";

const question = (fields, version = 1, bases = {}) => ({ id: "main", version, studyId: "s", fields, bases, written: [], by: "u", createdAt: null });

test("the card lists what is written with its basis and what is open as gaps, not errors", () => {
  const card = presentResearchQuestion(question({ question: "q", intercurrentEvents: [{ event: "停药", strategy: "principal_stratum", mechanism: "仍随访" }, { event: "死亡", strategy: null, mechanism: "" }] }, 2,
    { question: "person_edited", intercurrentEvents: "model_assembled" }), { modelId: "camd-adas-cog-11" });
  // who wrote a field decides which write wins and is the model's to read; the card the person reads carries no label and no author (owner ruling 2026-10-10,
  // review P1-6), and no user id leaks through `by`
  assert.equal(card.bases.question, "person_edited");
  assert.equal(JSON.stringify(card).includes("你在页面上改的"), false);
  assert.equal(JSON.stringify(card).includes("你在对话里说的"), false);
  assert.equal("by" in card, false);
  assert.deepEqual(card.gaps.map((gap) => gap.field), ["population", "treatment", "variable", "summary", "decisionContext", "assumptions"]);
  assert.deepEqual(card.events.map((event) => [event.state, event.stateLabel, event.mechanism]), [["not_representable", "这个模拟表示不了", "仍随访"], ["strategy_not_stated", "还没有写处理方式", ""]]);
  assert.equal(card.calibration.differs, true);
  assert.equal(presentResearchQuestion(null), null);
});

test("review P1-5: with no model the events are shown with their strategy and no tag, and no premise says one cannot be represented", () => {
  const q = question({ intercurrentEvents: [{ event: "停药", strategy: "treatment_policy", mechanism: "" }, { event: "死亡", strategy: null, mechanism: "" }] }, 2);
  const card = presentResearchQuestion(q);
  assert.deepEqual(card.events.map((event) => [event.state, event.stateLabel]), [["not_judged", null], ["strategy_not_stated", "还没有写处理方式"]]);
  assert.equal(card.calibration, null);
  assert.deepEqual(researchQuestionPremises({ question: q, ref: { id: "main", version: 2 } }), [], "no model: nothing is called unrepresentable, nothing is said of a default handling (P1-4, P2-18)");
  // the Alzheimer model judges the same event: treatment policy is representable there since the engine generates stopping the drug
  assert.equal(presentResearchQuestion(q, { modelId: "camd-adas-cog-11" }).events[0].state, "representable");
});

test("review P1-5: the study's model is the one its treatment names, else the Alzheimer parameter set when a simulation on it exists, else none", () => {
  const ad = { kind: "progression_simulation", diagnostics: { progression: { family: "beta_logit" } } };
  assert.equal(questionModelId(question({}), [ad]), "camd-adas-cog-11");
  assert.equal(questionModelId(question({}), [{ ...ad, supersededBy: "x" }]), null);
  assert.equal(questionModelId(question({}), [{ kind: "progression_simulation", diagnostics: { progression: { family: "linear" } } }]), null);
  assert.equal(questionModelId(question({ treatment: { interventionModel: { id: "camd-adas-cog-11" } } }), []), "camd-adas-cog-11");
  assert.equal(questionModelId(question({ treatment: { interventionModel: { id: "default" } } }), []), null);
});

test("review P2-6: an edit marks a result decisive only when it changes that result's estimand", () => {
  const withHistory = (written) => ({ ...question({ question: "q" }, 3), history: [{ version: 1, written: ["question", "summary"] }, { version: 2, written: ["assumptions"] }, { version: 3, written }] });
  const earlier = (written) => researchQuestionPremises({ question: withHistory(written), ref: { id: "main", version: 1 } }).find((row) => row.key === "question:earlier");
  assert.equal(earlier(["assumptions"]).decisive, false, "a typo in an assumption's source and a note on the decision change no estimand");
  assert.match(earlier(["assumptions"]).value, /改动不影响这个结果要回答的效应/);
  assert.equal(earlier(["decisionContext"]).decisive, false);
  assert.equal(earlier(["intercurrentEvents"]).decisive, true);
  assert.equal(earlier(["treatment"]).decisive, true);
  // a version written between the answered one and the current one counts too
  const old = { ...question({}, 3), history: [{ version: 1, written: [] }, { version: 2, written: ["population"] }, { version: 3, written: ["assumptions"] }] };
  assert.equal(researchQuestionPremises({ question: old, ref: { id: "main", version: 1 } })[0].decisive, true);
  // a question with no history of its own (an older reader) stays decisive: what changed is not known
  assert.equal(researchQuestionPremises({ question: question({}, 3), ref: { id: "main", version: 1 } })[0].decisive, true);
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
  assert.equal(rows[0].value, "这个结果回答的是研究问题的第 2 版；问题已经改到第 4 版，改动涉及要估计的效应，需要时重新计算。");
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
