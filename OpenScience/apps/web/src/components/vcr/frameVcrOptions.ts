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
 * reader does not say, the platform sets and labels 「AI 设定」. 数据 is not a
 * control here: attaching data is the composer's own 「+」, and the study's
 * sources are read and registered on 定义与证据.
 */
import { VCR_ACTIONS, VCR_INTENDED_USES, VCR_INTENDED_USE_LABELS_ZH } from "@evimed/domain";
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
  starters: Array<{ label: string; draft: string }>;
}

/** The five starting points, in the plan's order (§9.3), by the words the pill uses. */
export const VCR_START_OPTIONS: ReadonlyArray<{ id: VcrStart; label: string }> = Object.freeze([
  { id: "auto", label: "自动" },
  { id: "cohort", label: "队列" },
  { id: "patients", label: "患者" },
  { id: "comparator", label: "对照" },
  { id: "trial", label: "试验" },
]);

/**
 * The six starting points of a new study (plan §9.3, R10 mockup v02): a short name on the pill, and the sentence it puts in the
 * composer — never sent. Each ends where the reader continues. They only fill the box: pressing one is not a request, and the
 * study stays a draft until the researcher has said what it is about.
 */
export const VCR_STARTERS: ReadonlyArray<{ label: string; draft: string }> = Object.freeze([
  { label: "估算样本量", draft: "帮我估算这项研究的样本量和成功把握，研究是：" },
  { label: "生成合成人群", draft: "帮我按这项研究的人群生成一批合成人群，研究是：" },
  { label: "外部对照可行性", draft: "帮我判断这项单臂研究能不能用外部对照，还是必须做随机，研究是：" },
  { label: "模拟试验方案", draft: "帮我模拟几个试验方案：比较样本量、功效、成功把握、周期和成本，研究是：" },
  { label: "找先例与参数", draft: "帮我找同类试验的先例，整理出对照组的中位生存期、入组速度和脱落率，研究是：" },
  { label: "匹配患者", draft: "帮我用这项研究的入排条件匹配可能合适的患者，研究是：" },
]);

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
    startOptions: study?.abilities.includes("write") ? VCR_START_OPTIONS.map((option) => ({ ...option })) : [],
    intendedUse: study?.intendedUse ?? "exploratory",
    useOptions: (VCR_INTENDED_USES as readonly VcrIntendedUse[]).map((id) => ({ id, label: labels[id] ?? id })),
    starters: VCR_STARTERS.map((starter) => ({ ...starter })),
  };
}
