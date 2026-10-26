/** Canonical result destinations and the seven-step workflow share the domain vocabulary. */
import { VCR_TAB_LABELS_ZH } from "@evimed/domain";
import type { VcrStepKey, VcrStudy, VcrTabKey } from "@/lib/vcrClient";

/**
 * The order the tabs are read in: the study's own overview, then what it rests on (the definition and the evidence), then the five
 * things computed from it. The set is the domain's `VCR_TABS` — the order is the page's, because the domain's list is the order the
 * schema was written in.
 */
export const VCR_TAB_ORDER: readonly VcrTabKey[] = Object.freeze(["overview", "matching", "population", "comparator", "trial", "data"]);

export const VCR_TAB_ITEMS: ReadonlyArray<{ key: VcrTabKey; label: string }> = Object.freeze(
  VCR_TAB_ORDER.map((key) => Object.freeze({
    key,
    label: (VCR_TAB_LABELS_ZH as Record<string, string>)[key],
  })),
);

/** Definition and evidence keep separate workflow identities while sharing one evidence workspace. */
export const VCR_STEP_TABS: Readonly<Record<VcrStepKey, VcrTabKey>> = Object.freeze({
  definition: "data",
  evidence: "data",
  population: "population",
  patients: "population",
  comparator: "comparator",
  trial: "trial",
  matching: "matching",
});

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
  return value === "patients" || !!value && VCR_TAB_ITEMS.some((tab) => tab.key === value);
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
  return `${vcrTabPath(studyId, VCR_STEP_TABS[step])}?${new URLSearchParams({ step, ...(step === "patients" ? { level: "individual" } : {}) })}`;
}
