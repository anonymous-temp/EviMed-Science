// A batch of independent items used to settle only if every item did: the batch's confidence was the minimum over all
// of its questions, so one unsure item among twenty sent all twenty back to the model that had been doing the job
// (J5 settled 0 of 9 batches in its exploratory measurement). Each item now meets the same threshold on its own, and
// only the items that do not go back; a batch with every item sure settles whole, exactly as before.
import assert from "node:assert/strict";
import test from "node:test";

import { FRONTIER_SPECIALTIES } from "@evimed/domain";
import { FrontierEditor } from "../src/frontierEditor.mjs";
import { createJudgeService } from "../src/judgeService.mjs";

const config = { reviewJevEnabled: true, typesafeApiKey: "test-not-secret", reviewJevModel: "jev-1.13.0", reviewJevSupportConfidence: 0.8 };
const LANES = ["evidence", "news"];

/** A choice answer that puts `weights` on the options, in the order the question lists them. */
const answer = (/** @type {Record<string, number>} */ weights, /** @type {string} */ choice) => ({ type: "choice", choice, confidence: 1, probabilities: weights });
const sure = (/** @type {any} */ question, /** @type {string} */ option) => answer(Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === option ? 1 : 0])), option);
/** Item `unsure` (0-based) cannot choose its lane; every other answer is certain. */
function answers(/** @type {Record<string, any>} */ questions, /** @type {number | null} */ unsure) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const index = Number(/\d+$/.exec(id)?.[0]);
    if (id.startsWith("category")) {
      return [id, index === unsure ? answer({ none: 0.2, evidence: 0.45, news: 0.35 }, "evidence") : sure(question, "evidence")];
    }
    if (id.startsWith("medical") || id.startsWith("news")) return [id, sure(question, "yes")];
    if (id.startsWith("roundup")) return [id, sure(question, "no")];
    return [id, sure(question, "none")];
  }));
}
const batch = (/** @type {number} */ size) => ({ items: Array.from({ length: size }, (_, i) => ({
  id: String(i + 1), title: `Title ${i + 1}`, summary: `Summary ${i + 1}`, allowedCategories: LANES, allowedSpecialties: [...FRONTIER_SPECIALTIES],
})) });
const serviceWith = (/** @type {number | null} */ unsure) => createJudgeService({ calibrationMode: true, config,
  callImpl: async (_deps, call) => ({ model: config.reviewJevModel, cost: 0, answers: answers(call.questions, unsure) }) });
const itemCount = (/** @type {any} */ service, /** @type {string} */ outcome) => service.metrics().find((/** @type {any} */ row) => row.site === "J5" && row.outcome === `item_${outcome}`)?.value ?? 0;

test("one unsure item no longer sends the whole batch back: the sure items come with the answer", async () => {
  const service = serviceWith(1);
  const result = await service.judge("J5", batch(3), { userId: "u", projectId: "p" });
  assert.equal(result.outcome, "escalated", "the batch as a whole is still not settled");
  assert.equal(result.value, null, "so a caller that knows nothing of partial batches falls back for all of it, as before");
  assert.deepEqual(result.partial.items.map((/** @type {any} */ item) => item.id), ["1", "3"]);
  assert.deepEqual(result.partial.unsettledIds, ["2"]);
  assert.equal(result.partial.items[0].category, "evidence");
  assert.equal(itemCount(service, "settled"), 2);
  assert.equal(itemCount(service, "escalated"), 1);
  const family = (await service.metricFamilies()).find((candidate) => candidate.name === "open_science_jev_items_total");
  assert.deepEqual(family?.series.map((row) => [row.labels.site, row.labels.outcome, row.value]).sort(), [["J5", "escalated", 1], ["J5", "settled", 2]]);
  await service.close();
});

test("a batch whose every item is sure still settles whole, and a batch with none sure has no partial", async () => {
  const whole = serviceWith(null);
  const settled = await whole.judge("J5", batch(3), { userId: "u", projectId: "p" });
  assert.equal(settled.outcome, "settled");
  assert.equal(settled.value.items.length, 3);
  assert.equal(settled.partial, undefined);
  assert.equal(itemCount(whole, "settled"), 3);
  const single = serviceWith(0);
  const none = await single.judge("J5", batch(1), { userId: "u", projectId: "p" });
  assert.equal(none.outcome, "escalated");
  assert.equal(none.partial, undefined, "nothing to adopt");
  assert.equal(itemCount(single, "escalated"), 1);
  await whole.close();
  await single.close();
});

test("the batch rule of the sites that are not batches of independent items is unchanged", async () => {
  // J2's three questions are one decision about one message: unsure on one, unsure on all.
  const service = createJudgeService({ calibrationMode: true, config, callImpl: async (_deps, call) => ({ model: config.reviewJevModel, cost: 0, answers: Object.fromEntries(Object.entries(call.questions).map(([id, question]) => [id,
    id === "has_request" ? answer({ no: 0.45, yes: 0.55 }, "yes") : sure(question, Object.keys(question.criteria)[0])])) }) });
  const result = await service.judge("J2", { message: "切到项目甲", currentProjectId: "a", projects: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }] }, { userId: "u", projectId: "p" });
  assert.equal(result.outcome, "escalated");
  assert.equal(result.partial, undefined);
  await service.close();
});

const entries = [1, 2, 3].map((n) => ({ key: `entry-${n}`, title: `糖尿病新研究 ${n}`, sourceName: "Journal", excerpt: `Preserved source text ${n}`, allowedLanes: LANES }));
const editorConfig = { deepseekProviderEnabled: true, deepseekApiKey: "test-placeholder", operatorUsers: ["operator"] };
const owner = { userId: "operator", projectId: "evimed-frontier" };

test("the frontier screen adopts the items J5 is sure of and asks the model only about the rest", async () => {
  const flash = [];
  const editor = new FrontierEditor(editorConfig, { owner,
    judgeService: { judge: async () => ({ outcome: "escalated", code: "judge_uncertain", value: null, partial: {
      items: [
        { id: "1", isMedical: true, isNews: true, category: "evidence", roundup: false, specialties: ["endocrinology"] },
        { id: "3", isMedical: true, isNews: false, category: "news", roundup: true, specialties: [] },
      ],
      unsettledIds: ["2"],
    } }) },
    callModel: async (_deps, call) => {
      flash.push(JSON.parse(call.body.messages[1].content));
      return { choices: [{ message: { content: JSON.stringify({ items: [{ id: "1", medical: false, news: true, lane: "news", specialties: [], language: "zh", digest: false }] }) } }] };
    } });
  const result = await editor.screen(entries);
  assert.equal(result.errors.size, 0);
  assert.equal(flash.length, 1, "one model call, for the leftover");
  assert.deepEqual(flash[0].items.map((/** @type {any} */ item) => [item.id, item.title]), [["1", "糖尿病新研究 2"]], "only the unsure item, numbered afresh");
  assert.equal(result.verdicts.size, 3);
  assert.deepEqual(result.verdicts.get("entry-1")?.specialties, ["endocrinology"]);
  assert.equal(result.verdicts.get("entry-1")?.medical, true, "the settled item keeps J5's answer");
  assert.equal(result.verdicts.get("entry-2")?.medical, false, "the unsure item has the model's");
  assert.equal(result.verdicts.get("entry-3")?.digest, true);
  assert.equal(result.verdicts.get("entry-3")?.lane, "news");
});

test("an invalid model answer for the leftover is asked again like an invalid answer for a whole batch", async () => {
  let calls = 0;
  const editor = new FrontierEditor(editorConfig, { owner,
    judgeService: { judge: async () => ({ outcome: "escalated", value: null, partial: { items: [{ id: "1", isMedical: true, isNews: true, category: "evidence", roundup: false, specialties: [] }], unsettledIds: ["2", "3"] } }) },
    callModel: async (_deps, call) => {
      calls += 1;
      const sent = JSON.parse(call.body.messages[1].content).items;
      if (calls === 1) return { choices: [{ message: { content: JSON.stringify({ items: [] }) } }] };
      return { choices: [{ message: { content: JSON.stringify({ items: sent.map((/** @type {any} */ item) => ({ id: item.id, medical: true, news: true, lane: "evidence", specialties: [], language: "zh", digest: false })) }) } }] };
    } });
  const result = await editor.screen(entries);
  assert.equal(result.errors.size, 0);
  assert.equal(result.verdicts.size, 3, "every entry ends with a verdict");
  assert.ok(calls >= 2, "the invalid answer for the leftover was asked again, as an invalid whole-batch answer is");
});
