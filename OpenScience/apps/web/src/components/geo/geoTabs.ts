/**
 * What a GEO project's page is divided into — by the question a reader has,
 * not by the order the platform does its work (fusion plan §8.1, appendix E
 * §3.1: of seventeen products surveyed, none makes its workflow the
 * navigation) — and how the eight steps of the programme sit in those tabs.
 *
 * The eight steps are the rail in the band above every tab: one row, fixed,
 * the same on all eight tabs (rectification 2026-10-14, audit C A.1). The tabs
 * are not the steps, and the relation between them is written here **as data**
 * and nowhere else (A.2):
 *
 *  - `GEO_STEP_HOME` — where a step's own result is read: the tab, the view of
 *    it and the block inside it. A click on the rail goes there; so does an old
 *    address that named the step.
 *  - `GEO_TAB_STEPS` — which steps a tab is built from. The rail underlines the
 *    steps of the tab that is open; a tab may be built from more than one step,
 *    and a step may feed more than one tab (诊断 is read on 准确与安全 and, as a
 *    measurement, on 可见度; 信源 is read on 信源 and, as a strategy, on 方案).
 *
 * `geoTabs.test.ts` holds the table: every step has a home that is a tab, every
 * home tab is built from its step, and every tab but 总览 feeds a step.
 *
 * Old addresses keep working. A bookmark, a link in a delivered report and
 * the conversation frame's own “打开诊断” all name a step, and each resolves
 * to the tab that holds it.
 */
import { GEO_STEP_KEYS, type GeoStepKey } from "@/lib/geoClient";

export type GeoTabKey = "overview" | "visibility" | "accuracy" | "questions" | "sources" | "actions" | "plan" | "evidence";

export const GEO_TABS: ReadonlyArray<{ key: GeoTabKey; label: string }> = Object.freeze([
  { key: "overview", label: "总览" },
  { key: "visibility", label: "可见度" },
  { key: "accuracy", label: "准确与安全" },
  { key: "questions", label: "问题与回答" },
  { key: "sources", label: "信源" },
  { key: "actions", label: "行动" },
  { key: "plan", label: "方案" },
  { key: "evidence", label: "依据" },
]);

/* ---------------------------------------------------------------- views */

/** The query parameter a tab's own view switch is written in (`?view=journey`). One name for every tab. */
export const GEO_VIEW_PARAM = "view";

/**
 * 问题与回答's one view switch: the groups under their pools, the journey's stages with the groups in them, or every question in
 * one list. No `view` in the address is `pools`.
 */
export const GEO_QUESTIONS_VIEWS = Object.freeze(["pools", "journey", "all"] as const);
export type GeoQuestionsView = (typeof GEO_QUESTIONS_VIEWS)[number];

/** 依据's two views: the claim library, and the drug-value analysis. No `view` in the address is `claims`. */
export const GEO_EVIDENCE_VIEWS = Object.freeze(["claims", "value"] as const);
export type GeoEvidenceView = (typeof GEO_EVIDENCE_VIEWS)[number];

/** Whether a word is a view of a tab, else null: a bad `?view=` reads as the tab's first view. */
export function geoQuestionsView(value: string | null | undefined): GeoQuestionsView {
  return (GEO_QUESTIONS_VIEWS as readonly string[]).includes(value ?? "") ? (value as GeoQuestionsView) : "pools";
}
export function geoEvidenceView(value: string | null | undefined): GeoEvidenceView {
  return (GEO_EVIDENCE_VIEWS as readonly string[]).includes(value ?? "") ? (value as GeoEvidenceView) : "claims";
}

/* --------------------------------------------------------------- sections */

/**
 * The anchors the rail and a 「需要你」 row scroll to, by the name the server and this table use. A block of a tab that is a
 * destination carries `id={geoSectionId(name)}`; a destination whose block is not on the page scrolls to nothing, and the tab opens
 * at its top.
 */
export function geoSectionId(section: string): string {
  return `geo-${section.replace(/_/g, "-")}`;
}

/* -------------------------------------------------------- destinations */

/** Where an address, a rail step or a to-do lands: a tab, the view of it that is open, and the block it scrolls to. */
export interface GeoDestination {
  tab: GeoTabKey;
  view?: string;
  section?: string;
}

/**
 * Where each step's own result is read (audit C A.2, "干净的对应"): one home per step.
 *
 *  - 证据 → 依据 (the product's identity, the claim library);
 *  - 旅程 → 问题与回答 · 按旅程, 问题 → 问题与回答 · 按问句池;
 *  - 诊断 → 准确与安全 (the wrong statements), seen as a measurement on 可见度;
 *  - 信源 → 信源 (who is cited), seen as a strategy on 方案;
 *  - 内容 and 投放 → 行动;
 *  - 监测 → 可见度 (the trend), seen as the work's effect on 行动.
 */
export const GEO_STEP_HOME: Readonly<Record<GeoStepKey, GeoDestination>> = Object.freeze({
  evidence: { tab: "evidence" },
  journey: { tab: "questions", view: "journey" },
  questions: { tab: "questions" },
  diagnosis: { tab: "accuracy", section: "errors" },
  sources: { tab: "sources" },
  content: { tab: "actions" },
  distribution: { tab: "actions" },
  monitoring: { tab: "visibility", section: "trend" },
});

/** The steps a tab is built from, in the programme's order. 总览 is the summary of all of them and belongs to none. */
export const GEO_TAB_STEPS: Readonly<Record<GeoTabKey, readonly GeoStepKey[]>> = Object.freeze({
  overview: [],
  visibility: ["diagnosis", "monitoring"],
  accuracy: ["diagnosis"],
  questions: ["journey", "questions"],
  sources: ["sources"],
  actions: ["content", "distribution", "monitoring"],
  plan: ["sources"],
  evidence: ["evidence"],
});

/**
 * The tabs that show how the AI assistants answer — the module's measurement screens, named 「AI 回答监测」 in the browser tab. Read
 * off the table: a tab built from the questions or the diagnosis is one.
 */
export const GEO_MONITORING_TABS: readonly GeoTabKey[] = Object.freeze(
  GEO_TABS.map((tab) => tab.key).filter((tab) => GEO_TAB_STEPS[tab].some((step) => step === "questions" || step === "diagnosis")),
);

/**
 * Where each old address went. A step's name was a tab once; “问题” and “信源” kept their addresses because they kept their subject
 * (they are tabs, so they are not here), and 证据 is a tab of its own again (依据). The rest moved, and the two process pages — 诊断
 * and 监测 — stopped being pages.
 */
export const GEO_TAB_REDIRECTS: Readonly<Record<string, GeoDestination>> = Object.freeze({
  journey: { tab: "questions", view: "journey" },
  diagnosis: { tab: "accuracy" },
  content: { tab: "actions" },
  distribution: { tab: "actions" },
  monitoring: { tab: "visibility" },
});

export function isGeoTab(value: string | null | undefined): boolean {
  return !!value && (GEO_TABS.some((tab) => tab.key === value) || Object.hasOwn(GEO_TAB_REDIRECTS, value));
}

/**
 * The tab an address means, and whether the address itself has moved. A page that gets `moved` replaces the entry in the history, so a
 * reader who came in on an old link leaves with the new one; `view` is the view the old address means inside its tab.
 */
export function resolveGeoTab(value: string | null | undefined): { tab: GeoTabKey; moved: boolean; view?: string } {
  if (!value) return { tab: "overview", moved: false };
  if (GEO_TABS.some((tab) => tab.key === value)) return { tab: value as GeoTabKey, moved: false };
  const moved = Object.hasOwn(GEO_TAB_REDIRECTS, value) ? GEO_TAB_REDIRECTS[value] : null;
  return moved ? { tab: moved.tab, moved: true, ...(moved.view ? { view: moved.view } : {}) } : { tab: "overview", moved: true };
}

/** The path of one tab; 总览 is the project's own address. */
export function geoTabPath(geoId: string, tab: GeoTabKey): string {
  const base = `/app/geo/${encodeURIComponent(geoId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/**
 * The path of a destination: the tab, `?view=` where it names one, `#geo-<section>` where it names a block, and any further
 * parameters the caller wants kept in the address (`group` for a cluster, `show` for a status).
 */
export function geoDestinationPath(
  geoId: string,
  destination: GeoDestination,
  params: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const search = new URLSearchParams();
  if (destination.view) search.set(GEO_VIEW_PARAM, destination.view);
  for (const [name, value] of Object.entries(params)) if (value) search.set(name, value);
  const query = search.toString();
  return `${geoTabPath(geoId, destination.tab)}${query ? `?${query}` : ""}${destination.section ? `#${geoSectionId(destination.section)}` : ""}`;
}

/** Every step id, for the walk and for tests that assert no old link dies. */
export const GEO_LEGACY_TABS: readonly string[] = Object.freeze(["overview", ...GEO_STEP_KEYS] as Array<GeoStepKey | "overview">);
