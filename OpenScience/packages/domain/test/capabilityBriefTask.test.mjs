import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_DISPLAY, capabilityBrief, capabilityBriefTask } from "../index.mjs";

test("every capability card's brief reads back as the task it carries and the capability it names", () => {
  const cards = Object.values(CAPABILITY_DISPLAY);
  assert.ok(cards.length >= 15, `only ${cards.length} capability cards — the walk read nothing`);
  for (const card of cards) {
    for (const prompt of card.starterPrompts) {
      assert.deepEqual(capabilityBriefTask(capabilityBrief(card.title, prompt)), { task: prompt, capability: card.title });
    }
  }
});

test("only the exact preamble is read; a question that merely resembles it is left alone", () => {
  // The older two-newline form still reads.
  assert.deepEqual(capabilityBriefTask("请以「临床证据深度分析」能力完成以下任务：\n\n原题"), { task: "原题", capability: "临床证据深度分析" });
  for (const text of [
    "为什么要请以「X」能力完成以下任务？",
    "请以「X」能力完成以下任务：",
    "请以「」能力完成以下任务：原题",
    "请以「两行\n标题」能力完成以下任务：原题",
    `请以「${"长".repeat(41)}」能力完成以下任务：原题`,
    "",
  ]) {
    assert.deepEqual(capabilityBriefTask(text), { task: text, capability: null }, JSON.stringify(text));
  }
  assert.deepEqual(capabilityBriefTask(null), { task: "", capability: null });
});
