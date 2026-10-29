/** Canonical result destinations and the seven-step workflow share the domain vocabulary. */
import { VCR_STEP_LABELS_ZH, VCR_STEPS, VCR_TAB_LABELS_ZH } from "@evimed/domain";
import type { StepRailStep } from "@/components/ui/StepRail";
import type { TabDot } from "@/components/ui/Tabs";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import type { VcrStepKey, VcrStudy, VcrTabKey } from "@/lib/vcrClient";

/**
 * The order the tabs are read in: the study's own overview, then what it rests on (the definition and the evidence), then the five
 * things computed from it. The set is the domain's `VCR_TABS` — the order is the page's, because the domain's list is the order the
 * schema was written in.
 */
export const VCR_TAB_ORDER: readonly VcrTabKey[] = Object.freeze(["overview", "data", "population", "patients", "comparator", "trial", "matching"]);

export const VCR_TAB_ITEMS: ReadonlyArray<{ key: VcrTabKey; label: string }> = Object.freeze(
  VCR_TAB_ORDER.map((key) => Object.freeze({
    key,
    label: (VCR_TAB_LABELS_ZH as Record<string, string>)[key],
  })),
);

/** The step ids, in order, with their names. */
export const VCR_RAIL_STEPS: ReadonlyArray<{ key: VcrStepKey; label: string }> = Object.freeze(
  (VCR_STEPS as readonly VcrStepKey[]).map((key) => Object.freeze({
    key,
    label: (VCR_STEP_LABELS_ZH as Record<string, string>)[key],
  })),
);

/** Definition and evidence keep separate workflow identities while sharing one evidence workspace. */
export const VCR_STEP_TABS: Readonly<Record<VcrStepKey, VcrTabKey>> = Object.freeze({
  definition: "data",
  evidence: "data",
  population: "population",
  patients: "patients",
  comparator: "comparator",
  trial: "trial",
  matching: "matching",
});

/** The steps a tab is the state of. 总览 is the study as a whole and has none. */
export function stepsOfTab(tab: VcrTabKey): readonly VcrStepKey[] {
  return (VCR_STEPS as readonly VcrStepKey[]).filter((step) => VCR_STEP_TABS[step] === tab);
}

/**
 * The dot a tab wears: how far the steps it holds have come. A step that did not finish, a result gone stale and a start the
 * allowance refused all need the reader (`attention`); one under way is `active`, and only that; a tab whose every step is done is
 * `done`; one with some done and the rest not started is `partial` (「部分完成」 — it used to read 「进行中」 beside a done definition
 * with nothing running, which the 2026-10-07 audit took for a state the page contradicted) and one with nothing is `todo`.
 */
export function tabDot(study: Pick<VcrStudy, "steps">, tab: VcrTabKey): TabDot | undefined {
  const steps = stepsOfTab(tab);
  if (!steps.length) return undefined;
  const records = steps.map((step) => study.steps[step]);
  if (records.some((record) => record?.status === "failed" || record?.status === "stale" || stepAllowanceWait(record))) return "attention";
  if (records.some((record) => record?.status === "running" || record?.status === "queued")) return "active";
  const done = records.filter((record) => record?.status === "done" || record?.status === "minimal").length;
  if (done === steps.length) return "done";
  return done > 0 ? "partial" : "todo";
}

/**
 * Whether the study has a definition: the one thing every other step reads. Said by the definition step's own status, which the
 * programme reads off the data (a definition version exists), never off a run's word. A tab that is empty for want of it says so
 * and sends the reader to the conversation, where the definition is written.
 */
export function hasDefinition(study: Pick<VcrStudy, "steps">): boolean {
  const status = study.steps.definition?.status;
  return status === "done" || status === "minimal" || status === "stale";
}

export function isVcrTab(value: string | null | undefined): value is VcrTabKey {
  return !!value && VCR_TAB_ITEMS.some((tab) => tab.key === value);
}

/**
 * The tab an address means, and whether the address itself has moved. A study
 * page that gets `moved` replaces the entry in the history, so a reader who
 * came in on a step name leaves with a tab that will keep working.
 */
export function resolveVcrTab(value: string | null | undefined): { tab: VcrTabKey; moved: boolean } {
  if (!value) return { tab: "overview", moved: false };
  if (isVcrTab(value)) return { tab: value, moved: false };
  const step = VCR_STEP_TABS[value as VcrStepKey];
  return step ? { tab: step, moved: true } : { tab: "overview", moved: true };
}

/** The path of one tab; 总览 is the study's own address. */
export function vcrTabPath(studyId: string, tab: VcrTabKey): string {
  const base = `/app/virtual-research/${encodeURIComponent(studyId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/** The module's home. */
export const VCR_HOME_PATH = "/app/virtual-research";

/** The canonical steps stay separate even when two results share one addressed view. */
export function vcrStepPath(studyId: string, step: VcrStepKey): string {
  return `${vcrTabPath(studyId, VCR_STEP_TABS[step])}?step=${step}`;
}
export function vcrWorkflowSteps(study: Pick<VcrStudy, "id" | "steps" | "stepSummaries"> & Partial<Pick<VcrStudy, "conversation">>): StepRailStep[] {
  return VCR_RAIL_STEPS.map(({ key, label }) => {
    const record = study.steps[key];
    const status = record?.status ?? "none";
    const needsInput = key === "definition" && study.conversation?.awaitingInput === true;
    const waiting = stepAllowanceWait(record) || needsInput;
    const state: StepRailStep["state"] = waiting ? "waiting" : status === "done" ? "done" : status === "minimal" ? "partial" : status === "running" || status === "queued" ? "active" : status === "failed" || status === "stale" ? "attention" : "todo";
    const stateLabel = needsInput ? "待补充信息" : waiting ? "等待额度" : status === "none" ? record?.requested === true ? "待开始" : record?.requested === false ? "未请求" : "未开始" : status === "queued" ? "排队中" : status === "stale" ? "待更新" : status === "failed" ? "未完成" : status === "minimal" ? "已有初步结果" : undefined;
    return { id: key, label, state, stateLabel, summary: study.stepSummaries[key]?.note, href: vcrStepPath(study.id, key) };
  });
}
