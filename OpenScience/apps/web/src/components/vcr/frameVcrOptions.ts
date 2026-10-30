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
  starters: Array<{ label: string; draft: string; requirement?: string; minimumFields?: string; inputLabel?: string }>;
}

/** The five starting points, in the plan's order (§9.3), by the words the pill uses. */
export const VCR_START_OPTIONS: ReadonlyArray<{ id: VcrStart; label: string }> = Object.freeze([
  { id: "auto", label: "自动" },
  { id: "cohort", label: "队列" },
  { id: "patients", label: "患者" },
  { minimumFields: "效果分析需治疗组别、结局定义、观察时间、混杂协变量与可比对照；无结局数据可先开展可行性设计。", indicators: [{ key: "comparator", label: "纵向结局与对照资料" }] as const, id: "comparator", label: "对照" },
  { minimumFields: "设计需终点类型、效应与变异度、显著性水平、目标把握度、入组和随访假设，并保留参数来源。", indicators: [{ key: "trial", label: "文献／设计假设" }] as const, id: "trial", label: "试验" },
]);

/**
 * The six starting points of a new study (plan §9.3, R10 mockup v02): a short name on the pill, and the sentence it puts in the
 * composer — never sent. Each ends where the reader continues. They only fill the box: pressing one is not a request, and the
 * study stays a draft until the researcher has said what it is about.
 */
export const VCR_TASKS = Object.freeze([
  { minimumFields: "个体病例需年龄、关键诊断和分期、既往治疗、与入排条件有关的检查及其时间。未知信息保留为未知。", indicators: [{ key: "matching", label: "原始病例／患者数据集" }] as const, id: "matching", label: "患者匹配", summary: "按试验条件核对患者，逐条查看证据与未知项", inputLabel: "需患者资料", draft: "帮我做患者与临床试验的匹配，逐条说明符合、不符合和缺失证据。我的需求是：", requirement: "需要患者资料；批量匹配需上传或连接患者数据集。试验方案可上传或检索。" },
  { minimumFields: "真实队列需稳定的去标识化编号、筛选字段与数据字典；合成人群需文献分布与假设；个体轨迹需适用模型和所需协变量。", indicators: [{ key: "cohort", label: "真实患者数据集" }, { key: "patient", label: "适用模型与个体资料" }] as const, id: "population", label: "人群与患者", summary: "构建研究队列，或模拟一位虚拟患者", inputLabel: "可先用文献", draft: "帮我开展人群或个体研究。请区分真实队列、合成人群和个体预测，并按我的需求选择规模，需求是：", requirement: "文献驱动的合成人群无需患者数据集；真实队列需患者数据，个体轨迹还需适用的模型。" },
  { minimumFields: "效果分析需治疗组别、结局定义、观察时间、混杂协变量与可比对照；无结局数据可先开展可行性设计。", indicators: [{ key: "comparator", label: "纵向结局与对照资料" }] as const, id: "comparator", label: "合成对照", summary: "评估外部对照、文献基准和模型预测的可用性", inputLabel: "效果分析需结局数据", draft: "帮我评估并构建合适的对照，区分真实外部对照、模型预测和文献基准，研究是：", requirement: "估计治疗效果需试验组结局和可比对照证据；没有数据时先做可行性与方案设计。" },
  { minimumFields: "设计需终点类型、效应与变异度、显著性水平、目标把握度、入组和随访假设，并保留参数来源。", indicators: [{ key: "trial", label: "文献／设计假设" }] as const, id: "trial", label: "虚拟试验", summary: "模拟并比较试验设计的样本量、把握度和周期", inputLabel: "可先用文献", draft: "帮我比较几个临床试验设计的样本量、把握度与周期。先查找参数证据，再模拟不确定性，研究是：", requirement: "设计仿真可先用文献参数，无需患者数据集；个体数据用于校准与验证。" },
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
