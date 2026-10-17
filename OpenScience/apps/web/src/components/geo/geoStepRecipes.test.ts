import { describe, expect, it } from "vitest";
import { GEO_STEP_ACTION_LABELS_ZH, geoVisibleQuestion } from "@evimed/domain";
import { GEO_STEP_KEYS } from "@/lib/geoClient";
import { GEO_STEP_RECIPES } from "./geoStepRecipes";

describe("a step's button and the sentence its run is asked in", () => {
  it("are one table: the verb on the step's button is the domain's, and so is the question of the run it starts", () => {
    expect(GEO_STEP_KEYS.length).toBe(8);
    for (const step of GEO_STEP_KEYS) {
      expect(GEO_STEP_RECIPES[step].verb).toBe(GEO_STEP_ACTION_LABELS_ZH[step]);
      expect(geoVisibleQuestion({ purpose: step, steps: [step] })).toBe(GEO_STEP_RECIPES[step].verb);
    }
  });

  it("keeps the words the page was reviewed with", () => {
    expect(GEO_STEP_KEYS.map((step) => GEO_STEP_RECIPES[step].verb)).toEqual([
      "整理产品证据", "绘制患者旅程", "列出测量问题", "测一轮 AI 回答", "分析引用的信源", "写第一批稿件", "安排投放", "开始每周复测",
    ]);
  });
});
