// The tag tree's upkeep prompts (frontierTagUpkeep.mjs): what the judge is told about specialties is the editor's own wording.
import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_SPECIALTIES, FRONTIER_SPECIALTY_SCOPES_ZH } from "@evimed/domain";
import { FRONTIER_TAG_JUDGE_INSTRUCTIONS } from "../src/frontierTagUpkeep.mjs";

test("the promotion judge reads each specialty with what it takes, so a method or a population is not filed under 全科 or 药学", () => {
  for (const key of FRONTIER_SPECIALTIES) assert.ok(FRONTIER_TAG_JUDGE_INSTRUCTIONS.includes(`${key} `) && FRONTIER_TAG_JUDGE_INSTRUCTIONS.includes(FRONTIER_SPECIALTY_SCOPES_ZH[key]), key);
  assert.match(FRONTIER_TAG_JUDGE_INSTRUCTIONS, /药学只给药学实践本身，全科与基层只给基层与家庭医学的内容/);
  assert.match(FRONTIER_TAG_JUDGE_INSTRUCTIONS, /跨很多专科的给空数组/);
});
