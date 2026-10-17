import { GEO_STEP_ACTION_LABELS_ZH } from "@evimed/domain";
import type { GeoStepKey } from "@/lib/geoClient";

/**
 * What a step that has not produced anything says on its tab (R19, plan §2.2 rule 8: an empty state is a recipe). A recipe is
 * what the step **uses** (each one a way to the thing itself), what it **gives**, and the one button that names the work as a verb
 * and its object — never 「让 AI 做」. The sentences are about what the step produces, never how the system works.
 *
 *  - `verb` — the button, and after 「正在」 the running line: 整理产品证据, 测一轮 AI 回答. It is the domain's one table
 *    (`GEO_STEP_ACTION_LABELS_ZH`), which is also the sentence the step's run is asked in and titled by, so the two cannot drift;
 *  - `noun` — the empty title is 「还没有{noun}」;
 *  - `uses` — the steps whose results this one reads: a link each to where that result is read;
 *  - `gives` — what it produces, as a noun phrase;
 *  - `after` — the step it waits for when it was asked for early (「“证据”做完后自动开始」).
 */
export interface GeoStepRecipe {
  verb: string;
  noun: string;
  uses: ReadonlyArray<{ label: string; step: GeoStepKey }>;
  gives: string;
  after: string | null;
}

export const GEO_STEP_RECIPES: Readonly<Record<GeoStepKey, GeoStepRecipe>> = Object.freeze({
  evidence: {
    verb: GEO_STEP_ACTION_LABELS_ZH.evidence,
    noun: "产品证据",
    uses: [],
    gives: "产品身份和结论库，每条结论带原文出处",
    after: null,
  },
  journey: {
    verb: GEO_STEP_ACTION_LABELS_ZH.journey,
    noun: "患者与医生的旅程",
    uses: [{ label: "结论库", step: "evidence" }],
    gives: "患者与医生从起疑到用药的各个阶段，和每个阶段会问 AI 的问题",
    after: "证据",
  },
  questions: {
    verb: GEO_STEP_ACTION_LABELS_ZH.questions,
    noun: "测量问题",
    uses: [{ label: "结论库", step: "evidence" }, { label: "旅程", step: "journey" }],
    gives: "按问句池分组的问题和真实问法",
    after: "证据",
  },
  diagnosis: {
    verb: GEO_STEP_ACTION_LABELS_ZH.diagnosis,
    noun: "AI 回答的测量",
    uses: [{ label: "测量问题", step: "questions" }],
    gives: "各家 AI 怎么回答这个产品，哪里讲对了、哪里讲错了",
    after: "问题",
  },
  sources: {
    verb: GEO_STEP_ACTION_LABELS_ZH.sources,
    noun: "信源分析",
    uses: [{ label: "AI 回答", step: "diagnosis" }],
    gives: "AI 引用了哪些信源、各引擎能做到什么程度和三档目标",
    after: "诊断",
  },
  content: {
    verb: GEO_STEP_ACTION_LABELS_ZH.content,
    noun: "稿件",
    uses: [{ label: "信源分析", step: "sources" }, { label: "结论库", step: "evidence" }],
    gives: "面向各问题群的稿件",
    after: "信源",
  },
  distribution: {
    verb: GEO_STEP_ACTION_LABELS_ZH.distribution,
    noun: "投放",
    uses: [{ label: "稿件", step: "content" }],
    gives: "投放订单，和发布之后的核对",
    after: "内容",
  },
  monitoring: {
    verb: GEO_STEP_ACTION_LABELS_ZH.monitoring,
    noun: "持续监测",
    uses: [{ label: "AI 回答的测量", step: "diagnosis" }],
    gives: "每周复测和趋势",
    after: "投放",
  },
});
