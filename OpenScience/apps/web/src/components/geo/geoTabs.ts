/**
 * Compatibility addresses for the result components inside GEO's eight business workbenches.
 * The visible workflow rail is the business navigation; only diagnosis and sources expose related result views locally.
 *
 * GEO_STEP_HOME maps each step to its existing component/address. GEO_TAB_STEPS records which workbenches can reuse it.
 * geoViewedStep resolves the inspected workbench from its view and anchor, independently of background programme progress.
 * Existing report links and bookmarks retain their objects, filters and conversation context.
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
 * The anchors workflow destinations and a 「需要你」 row scroll to, by the name the server and this table use. A block of a tab that is a
 * destination carries `id={geoSectionId(name)}`; a destination whose block is not on the page scrolls to nothing, and the tab opens
 * at its top.
 */
export function geoSectionId(section: string): string {
  return `geo-${section.replace(/_/g, "-")}`;
}

/* -------------------------------------------------------- destinations */

/** Where an address, a workflow step or a to-do lands: a tab, the view of it that is open, and the block it scrolls to. */
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
 *  - 内容 → 行动 (the articles), 投放 → 行动 (the placing, a block of its own);
 *  - 监测 → 可见度 (the trend), seen as the work's effect on 行动.
 */
export const GEO_STEP_HOME: Readonly<Record<GeoStepKey, GeoDestination>> = Object.freeze({
  evidence: { tab: "evidence" },
  journey: { tab: "questions", view: "journey" },
  questions: { tab: "questions" },
  diagnosis: { tab: "accuracy", section: "errors" },
  sources: { tab: "sources" },
  content: { tab: "actions" },
  distribution: { tab: "actions", section: "delivery" },
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
 * The blocks a tab is promised to have — what a workflow selection, a 「需要你」 row and the server's `needsYou[].target.section` scroll
 * to, by the id `geoSectionId(name)` gives them. A tab that is rebuilt keeps them: `pageComposition.test.tsx` renders every tab and
 * reads this table, so a block that loses its id is a failing test and not a link that quietly lands at the top.
 *
 *  - 可见度 `trend` — the trend card (监测);
 *  - 准确与安全 `errors` — the wrong-statement list (诊断, a severe error);
 *  - 行动 `review` — the articles, the ones held for release among them; `delivery` — the placing (投放); `budget` — its budget line;
 *  - 方案 `targets` (the three tiers), `battlefield`, `engines`, `client_actions` — the client's to-dos.
 */
export const GEO_TAB_SECTIONS: Readonly<Record<GeoTabKey, readonly string[]>> = Object.freeze({
  overview: [],
  visibility: ["trend"],
  accuracy: ["errors"],
  questions: [],
  sources: [],
  actions: ["review", "delivery", "budget"],
  plan: ["targets", "battlefield", "engines", "client_actions"],
  evidence: [],
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

/** The path of one result; 总览 is the project's own address. */
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
  params: Readonly<Record<string, string | null | undefined>> | URLSearchParams = {},
): string {
  const search = new URLSearchParams();
  if (destination.view) search.set(GEO_VIEW_PARAM, destination.view);
  const entries = params instanceof URLSearchParams ? params.entries() : Object.entries(params);
  for (const [name, value] of entries) if (value && !(name === GEO_VIEW_PARAM && destination.view)) search.append(name, value);
  const query = search.toString();
  return `${geoTabPath(geoId, destination.tab)}${query ? `?${query}` : ""}${destination.section ? `#${geoSectionId(destination.section)}` : ""}`;
}

/** The viewed workbench, independent from the programme's currently running step. Old result addresses remain valid. */
export function geoViewedStep(tab: GeoTabKey, { step = null, view = null, section = null, conversation = false }: {
  step?: string | null; view?: string | null; section?: string | null; conversation?: boolean;
}): GeoStepKey | null {
  const requested = GEO_STEP_KEYS.find(key => key === step) ?? null;
  if (conversation && requested) return requested;
  if (tab === "overview") return null;
  if (tab === "questions") return view === "journey" ? "journey" : "questions";
  if (tab === "visibility") return section?.replace(/^geo-/, "") === "trend" || requested === "monitoring" ? "monitoring" : "diagnosis";
  if (tab === "actions") {
    const block = section?.replace(/^geo-/, "");
    if (block === "delivery" || block === "budget") return "distribution";
    if (block === "effect") return "monitoring";
    if (block === "review") return "content";
    if (requested && GEO_TAB_STEPS.actions.includes(requested)) return requested;
    return "content";
  }
  return GEO_TAB_STEPS[tab][0] ?? null;
}

/** Every step id, for the walk and for tests that assert no old link dies. */
export const GEO_LEGACY_TABS: readonly string[] = Object.freeze(["overview", ...GEO_STEP_KEYS] as Array<GeoStepKey | "overview">);
