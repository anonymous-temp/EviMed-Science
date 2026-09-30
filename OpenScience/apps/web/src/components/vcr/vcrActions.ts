/**
 * The four things this module does, as the four cards on its home page
 * (plan §9.2) — and the one sentence each of them puts in the composer.
 *
 * A card is **not** a form. Pressing one creates the study, lands in its
 * conversation with the module's chip attached and this line already typed,
 * and leaves it to the reader to press return or to say something else
 * (plan §9.3: 没有表单). Everything a form would have asked for — the
 * population, the endpoint, the comparator, the scenario — the platform sets
 * itself and labels 「AI 设定」, and the reader changes it in one sentence or
 * on the card itself.
 *
 * The ids are `@evimed/domain`'s `VCR_ACTIONS`; the names are its
 * `VCR_ACTION_LABELS_ZH`. Only the produces line and the icon live here.
 */
import { VCR_ACTION_LABELS_ZH } from "@evimed/domain";
import type { VcrAction } from "@/lib/vcrClient";

export interface VcrActionCard {
  id: VcrAction;
  label: string;
  /** What it produces, in at most fourteen characters. */
  produces: string;
  /** The Lucide icon's name, resolved by the page. */
  icon: "users-round" | "activity" | "git-compare" | "flask-conical";
  /** What waits in the composer. */
  draft: string;
}

const LABELS = VCR_ACTION_LABELS_ZH as Record<VcrAction, string>;

export const VCR_ACTION_CARDS: readonly VcrActionCard[] = Object.freeze([
  Object.freeze({
    id: "cohort" as const,
    label: LABELS.cohort,
    produces: "人群定义与筛选流程",
    icon: "users-round" as const,
    draft: "帮我定义这项研究的人群：写出入排条件、逐条筛选的结果和人群画像。",
  }),
  Object.freeze({
    id: "patients" as const,
    label: LABELS.patients,
    produces: "个体轨迹与不确定性",
    icon: "activity" as const,
    draft: "帮我生成一组虚拟患者：说明用的是哪个模型、适用范围，以及个体轨迹的不确定性。",
  }),
  Object.freeze({
    id: "comparator" as const,
    label: LABELS.comparator,
    produces: "对照、诊断或缺口清单",
    icon: "git-compare" as const,
    draft: "帮我构建这项研究的对照：比较五条对照路线，给出可比性诊断，或者写清缺哪几项数据。",
  }),
  Object.freeze({
    id: "trial" as const,
    label: LABELS.trial,
    produces: "方案对比与成功把握",
    icon: "flask-conical" as const,
    draft: "帮我模拟几个试验方案：比较样本量、功效、成功把握、周期和成本。",
  }),
]);
