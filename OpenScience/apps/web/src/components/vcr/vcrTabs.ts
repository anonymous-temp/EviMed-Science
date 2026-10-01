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
import { VCR_STEP_LABELS_ZH, VCR_STEPS, VCR_TAB_LABELS_ZH, VCR_TABS } from "@evimed/domain";
import type { VcrStepKey, VcrTabKey } from "@/lib/vcrClient";

export const VCR_TAB_ITEMS: ReadonlyArray<{ key: VcrTabKey; label: string }> = Object.freeze(
  (VCR_TABS as readonly VcrTabKey[]).map((key) => Object.freeze({
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
 * 证据 are both read on 数据与证据 — a research definition and the assumption
 * cards it produced are the same page for a reader, which is why there are
 * seven tabs for seven steps and not fourteen for both.
 */
export const VCR_STEP_TABS: Readonly<Record<VcrStepKey, VcrTabKey>> = Object.freeze({
  definition: "overview",
  evidence: "data",
  population: "population",
  patients: "patients",
  comparator: "comparator",
  trial: "trial",
  matching: "matching",
});

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
