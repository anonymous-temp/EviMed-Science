/**
 * Prescription edits, read, counted and worded — without a database. What may
 * be observed at all, what a habit is, the method it becomes, and the one
 * model pass whose line is kept only when code can check it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { validateMethodSkill } from "@evimed/domain";

import {
  HABIT_MIN_OCCURRENCES,
  HabitWriter,
  countHabits,
  habitMethod,
  habitName,
  neverLearned,
  readObservation,
  templateDisplay,
} from "../src/agentMemoryObservations.mjs";

const replace = { type: "replace", from: "党参", to: "太子参" };

test("an observation is herb names and a syndrome, and a dose or a patient field has nowhere to go", () => {
  const read = readObservation({ syndrome: "脾胃气虚证", lineage: "经方思路", changes: [replace, { type: "add", herb: "酸枣仁" }, replace] });
  assert.deepEqual(read.changes, [replace, { type: "add", herb: "酸枣仁" }], "the same change twice in one edit is one change");
  assert.equal(read.stage, "M04");
  for (const [body, pattern] of [
    [{ syndrome: "脾胃气虚证", changes: [{ type: "replace", from: "党参", to: "太子参", dose: "15g" }] }, /dose is never observed/],
    [{ syndrome: "脾胃气虚证", changes: [{ type: "add", herb: "黄芪30g" }] }, /no digits/],
    [{ syndrome: "脾胃气虚证", patientName: "张三", changes: [replace] }, /no dose and no patient field/],
    [{ syndrome: "患者姓名张三", changes: [replace] }, /no patient information/],
    [{ syndrome: "脾胃气虚证", changes: [] }, /1–30 changes/],
    [{ syndrome: "脾胃气虚证", stage: "M02", changes: [replace] }, /stage M04/],
    [{ syndrome: "脾胃气虚证", changes: [{ type: "replace", from: "党参", to: "党参" }] }, /with itself/],
  ]) {
    assert.throws(() => readObservation(body), (error) => error.code === "agent_observation_invalid" && pattern.test(error.message), JSON.stringify(body));
  }
});

test("a change naming a toxic herb is kept aside and never counted", () => {
  const read = readObservation({ syndrome: "阳虚寒凝证", changes: [{ type: "add", herb: "制附子" }, { type: "replace", from: "肉桂", to: "细辛" }, { type: "add", herb: "干姜" }] });
  assert.deepEqual(read.changes, [{ type: "add", herb: "干姜" }]);
  assert.deepEqual(read.neverLearned.map((change) => change.type), ["add", "replace"]);
  assert.ok(neverLearned("生川乌") && neverLearned("朱砂") && !neverLearned("太子参"));
});

test("a habit is a change seen three times and in at least half of the recent edits, with the lineage most of them had", () => {
  const edit = (changes, lineage = "经方思路") => ({ syndrome: "脾胃气虚证", lineage, changes });
  const twice = countHabits([edit([replace]), edit([replace]), edit([])]);
  assert.equal(twice[0].observed, 2);
  assert.ok(twice[0].observed < HABIT_MIN_OCCURRENCES, "two is not a habit");
  const counts = countHabits([edit([replace]), edit([replace, { type: "add", herb: "酸枣仁" }]), edit([replace], null), edit([])]);
  assert.deepEqual(counts.map((count) => [count.key, count.observed, count.related]), [["replace:党参>太子参", 3, 4], ["add:酸枣仁", 1, 4]]);
  assert.equal(counts[0].share, 0.75);
  assert.equal(counts[0].lineage, "经方思路");
  assert.equal(habitName("脾胃气虚证", replace), habitName("脾胃气虚证", { ...replace }), "one change under one syndrome is one habit");
  assert.notEqual(habitName("脾胃气虚证", replace), habitName("肝郁脾虚证", replace));
});

test("the method a habit becomes is a valid method, written from the facts, and never carries a count", () => {
  const display = templateDisplay("脾胃气虚证", replace);
  assert.deepEqual(display, { title: "脾胃气虚证：太子参易党参", summary: "脾胃气虚证的候选方中，你常以太子参替代党参。" });
  const method = habitMethod("脾胃气虚证", replace, "经方思路", display);
  const verdict = validateMethodSkill({ ...method, directoryName: method.frontmatter.name, requireProvenance: true });
  assert.deepEqual(verdict.issues, [], "a method the ledger accepts");
  assert.ok(!/\d+\s*次/.test(method.body) && !/\d/.test(method.frontmatter.description + display.summary),
    "no count in the text, so it is not rewritten when a count moves and its digest never does");
  assert.match(method.frontmatter.whenToUse, /所选诊疗思路为“经方思路”/);
  for (const change of [{ type: "add", herb: "酸枣仁" }, { type: "remove", herb: "甘草" }]) {
    const other = habitMethod("心脾两虚证", change, null, templateDisplay("心脾两虚证", change));
    assert.deepEqual(validateMethodSkill({ ...other, directoryName: other.frontmatter.name, requireProvenance: true }).issues, []);
  }
});

test("the wording pass is kept only when it names what it is about and states no number", async () => {
  const config = { deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekModel: "deepseek-v4-flash" };
  const calls = [];
  const answer = (display) => new HabitWriter(config, {
    callModel: async (_context, call) => {
      calls.push(call);
      return { choices: [{ message: { content: JSON.stringify(display) } }] };
    },
  });
  const owner = { userId: "u1", projectId: "default" };
  assert.deepEqual(await answer({ title: "脾胃气虚证常用太子参", summary: "脾胃气虚证的候选方里，你多把党参换成太子参。" }).write(owner, "脾胃气虚证", replace),
    { title: "脾胃气虚证常用太子参", summary: "脾胃气虚证的候选方里，你多把党参换成太子参。" });
  assert.equal(calls[0].purpose, "learning", "metered as learning, like every other method line");
  assert.equal(await answer({ title: "脾胃气虚证：太子参", summary: "12 次里有 9 次把党参换成太子参。" }).write(owner, "脾胃气虚证", replace), null, "a number is code's to render");
  assert.equal(await answer({ title: "补气药替换", summary: "你常把党参换成别的补气药。" }).write(owner, "脾胃气虚证", replace), null, "it must name the herbs and the syndrome");
  assert.equal(await new HabitWriter({ deepseekProviderEnabled: false }).write(owner, "脾胃气虚证", replace), null, "no model, no pass");
});
