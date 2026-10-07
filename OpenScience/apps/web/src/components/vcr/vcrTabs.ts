/**
 * What a study's page is divided into, and where each address lands.
 *
 * The seven tabs and their names are **not** written here: they are
 * `@evimed/domain`'s `VCR_TABS` and `VCR_TAB_LABELS_ZH`, the same list the
 * schema's CHECK, the routes and the runtime gateway read. A second copy in
 * the browser is the one that drifts, and the drift shows up as a tab that
 * answers 404.
 *
 * The seven steps of the programme are a different list (`VCR_STEPS`): they
 * are the rail in the page header, with what each one produced, and never the
 * navigation (appendix E §3.2 — no product surveyed makes its workflow the
 * navigation).
 */
import { VCR_STEP_LABELS_ZH, VCR_STEPS, VCR_TAB_LABELS_ZH } from "@evimed/domain";
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

/**
 * Which tab holds a step's result. Five steps are a tab of their own; 定义 and
 * 证据 are both read on 定义与证据 — a research definition and the assumption
 * cards it produced are the same page for a reader, which is why there are
 * seven tabs for seven steps and not fourteen for both. The step rail that
 * used to repeat this as a second navigation is gone: each tab carries its
 * own state as a dot (`tabDot`).
 */
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
