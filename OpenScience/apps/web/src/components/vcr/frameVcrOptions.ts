/**
 * What the conversation frame's 虚拟临床研究 chip draws, from a study.
 *
 * Its own module, and loaded by `useFrameVcrOptions` only once a conversation
 * is bound to one of the module's capabilities: every other conversation never
 * needs it (the same arrangement as `components/geo/frameGeoOptions.ts`).
 *
 * The new-study composer (plan §9.3) has no form. It has the module's chip,
 * three optional controls — 起点 (自动 / 队列 / 患者 / 对照 / 试验), 预期用途
 * (默认“探索”) and 数据 — and a row of six starting points. Everything the
 * reader does not say, the platform sets (the ledger records it as AI-set; no page labels it). 数据 is not a
 * control here: attaching data is the composer's own 「+」, and the study's
 * sources are read and registered on 定义与证据.
 */
import { VCR_ACTIONS, VCR_INTENDED_USES, VCR_INTENDED_USE_LABELS_ZH, VCR_STEP_LABELS_ZH, VCR_TAB_LABELS_ZH } from "@evimed/domain";
import type { VcrAction, VcrFrameStudy, VcrIntendedUse, VcrStepKey } from "@/lib/vcrClient";

/** Where a study starts: everything, or one of the four workspaces. */
export type VcrStart = "auto" | VcrAction;

/** What the frame's 虚拟临床研究 chip draws beside itself (the bridge's `vcr` message). */
export interface FrameVcrOptions {
  sessionId: string;
  /** Whether there is a study to write the options to. */
  controls: boolean;
  /** The reader may change the intended use (the lead's, `manage_study`). */
  canSetUse: boolean;
  start: VcrStart;
  /** Empty when the reader may not change where the study starts. */
  startOptions: Array<{ id: VcrStart; label: string }>;
  intendedUse: VcrIntendedUse;
  useOptions: Array<{ id: VcrIntendedUse; label: string }>;
  starters: Array<{ label: string; draft: string; requirement?: string }>;
}

/**
 * The five starting points, in the plan's order (§9.3), by the words the pill uses. A starting point is a step, and is named as the
 * step is everywhere (`VCR_STEP_LABELS_ZH`): the pill said 队列 for what the page calls 人群, and the home said 合成对照 for what the tab
 * is called 对照 (module workspace audit, 2026-11-01, unranked note on task names).
 */
export const VCR_START_OPTIONS: ReadonlyArray<{ id: VcrStart; label: string }> = Object.freeze([
  { id: "auto", label: "自动" },
  { id: "cohort", label: VCR_STEP_LABELS_ZH.population },
  { id: "patients", label: VCR_STEP_LABELS_ZH.patients },
  { minimumFields: "效果分析需治疗组别、结局定义、观察时间、混杂协变量与可比对照；无结局数据可先开展可行性设计。", indicators: [{ key: "comparator", label: "纵向结局与对照资料" }] as const, id: "comparator", label: VCR_STEP_LABELS_ZH.comparator },
  { minimumFields: "设计需终点类型、效应与变异度、显著性水平、目标把握度、入组和随访假设，并保留参数来源。", indicators: [{ key: "trial", label: "文献／设计假设" }] as const, id: "trial", label: VCR_STEP_LABELS_ZH.trial },
]);

/**
 * The examples a new study begins from (plan §9.3, R10 mockup v02; the home's four examples, VCR remediation F5): the name of the tab where the work lands,
 * what the example button says, the sentence it puts in the composer — never sent — and the one sentence of what is enough to begin
 * (`requirement`; a field name or a statistic is never in it). Each draft ends where the reader continues. They only fill the box:
 * pressing one is not a request, and no study exists until the first result is saved.
 */
export const VCR_TASKS = Object.freeze([
  { id: "matching", label: VCR_TAB_LABELS_ZH.matching, example: "让 AI 匹配患者和试验", summary: "查找适合患者的试验，核对入排条件。", draft: "帮我匹配患者和临床试验。资料是：", requirement: "给一份病例就能开始。批量匹配需要患者数据表。" },
  { id: "population", label: VCR_TAB_LABELS_ZH.population, example: "让 AI 研究人群或个体患者", summary: "建立研究队列，查看个体的模拟结果。", draft: "帮我研究人群或个体患者。需求是：", requirement: "说清目标人群就能开始，AI 从文献取基线。用真实队列需要患者数据表。" },
  { id: "comparator", label: VCR_TAB_LABELS_ZH.comparator, example: "让 AI 构建对照并比较结局", summary: "构建对照人群，比较两组结局。", draft: "帮我构建对照并比较结局。研究是：", requirement: "说清研究就能先做可行性判断。估计治疗效果需要两组的结局数据。" },
  { id: "trial", label: VCR_TAB_LABELS_ZH.trial, example: "让 AI 比较试验设计", summary: "比较不同试验方案的样本量、把握度和周期。", draft: "帮我比较临床试验设计。研究是：", requirement: "说清研究问题和终点就能开始，参数 AI 先从文献找，你可以随时改。" },
]);

/** Task starters fill the native composer without submitting or creating a study. */
export const VCR_STARTERS = VCR_TASKS;

/** The one step each action asks for (`VCR_ACTION_STEPS` on the server). */
const ACTION_STEPS: Readonly<Record<VcrAction, VcrStepKey>> = Object.freeze({
  cohort: "population", patients: "patients", comparator: "comparator", trial: "trial",
});

/**
 * Where the study starts, as its own `requested` flags say: a single requested
 * step that one of the four actions asks for is that action; anything else —
 * all seven, or none yet — is 自动.
 */
export function startOf(study: Pick<VcrFrameStudy, "steps">): VcrStart {
  const requested = Object.entries(study.steps).filter(([, step]) => step?.requested === true).map(([key]) => key);
  if (requested.length !== 1) return "auto";
  return (VCR_ACTIONS as readonly VcrAction[]).find((action) => ACTION_STEPS[action] === requested[0]) ?? "auto";
}

/** Whether an id is one of the five starting points. */
export function isStart(value: unknown): value is VcrStart {
  return VCR_START_OPTIONS.some((option) => option.id === value);
}

/** Whether an id is one of the four intended uses. */
export function isIntendedUse(value: unknown): value is VcrIntendedUse {
  return (VCR_INTENDED_USES as readonly string[]).includes(String(value));
}

/** The chip's options for a conversation, from its study — or, with none, the starters alone. */
export function frameVcrOptions(sessionId: string, study: VcrFrameStudy | null): FrameVcrOptions {
  const labels = VCR_INTENDED_USE_LABELS_ZH as Record<string, string>;
  return {
    sessionId,
    controls: study !== null,
    canSetUse: Boolean(study?.abilities.includes("manage_study")),
    start: study ? startOf(study) : "auto",
    // Where the study starts is anybody's who may write to it.
    startOptions: [],
    intendedUse: study?.intendedUse ?? "exploratory",
    useOptions: (VCR_INTENDED_USES as readonly VcrIntendedUse[]).map((id) => ({ id, label: labels[id] ?? id })),
    starters: VCR_STARTERS.map((starter) => ({ ...starter })),
  };
}
