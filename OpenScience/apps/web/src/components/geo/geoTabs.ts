/**
 * What a GEO project's page is divided into — by the question a reader has,
 * not by the order the platform does its work (fusion plan §8.1, appendix E
 * §3.1: of seventeen products surveyed, none makes its workflow the
 * navigation).
 *
 * The eight steps are still there. They are the rail in the page header, with
 * what each one produced and which one is waiting for the reader; and 「监测」
 * is no longer a place at all — it is the time dimension of every number on
 * every page, which is why the trend chart is on 可见度 and the pilot-against-
 * control chart is on 行动, beside the placements they measure.
 *
 * Old addresses keep working. A bookmark, a link in a delivered report and
 * the conversation frame's own 「打开诊断」 all name a step, and each resolves
 * to the tab that now holds it.
 */
import { GEO_STEP_KEYS, type GeoStepKey } from "@/lib/geoClient";

export type GeoTabKey = "overview" | "visibility" | "accuracy" | "questions" | "sources" | "actions" | "plan";

export const GEO_TABS: ReadonlyArray<{ key: GeoTabKey; label: string }> = Object.freeze([
  { key: "overview", label: "总览" },
  { key: "visibility", label: "可见度" },
  { key: "accuracy", label: "准确与安全" },
  { key: "questions", label: "问题与回答" },
  { key: "sources", label: "信源" },
  { key: "actions", label: "行动" },
  { key: "plan", label: "方案" },
]);

/**
 * Where each of the nine old tabs went. 「问题」 and 「信源」 kept their
 * addresses because they kept their subject; the rest moved, and the two
 * process pages — 诊断 and 监测 — stopped being pages.
 */
export const GEO_TAB_REDIRECTS: Readonly<Record<string, GeoTabKey>> = Object.freeze({
  evidence: "plan",
  journey: "plan",
  diagnosis: "accuracy",
  content: "actions",
  distribution: "actions",
  monitoring: "visibility",
  // Kept, so a step key always resolves whichever list it is read from.
  questions: "questions",
  sources: "sources",
  overview: "overview",
});

export function isGeoTab(value: string | null | undefined): boolean {
  return !!value && (GEO_TABS.some((tab) => tab.key === value) || value in GEO_TAB_REDIRECTS);
}

/**
 * The tab an address means, and whether the address itself has moved. A page
 * that gets `moved` replaces the entry in the history, so a reader who came
 * in on an old link leaves with the new one.
 */
export function resolveGeoTab(value: string | null | undefined): { tab: GeoTabKey; moved: boolean } {
  if (!value) return { tab: "overview", moved: false };
  if (GEO_TABS.some((tab) => tab.key === value)) return { tab: value as GeoTabKey, moved: false };
  const moved = GEO_TAB_REDIRECTS[value];
  return moved ? { tab: moved, moved: true } : { tab: "overview", moved: true };
}

/** The path of one tab; 总览 is the project's own address. */
export function geoTabPath(geoId: string, tab: GeoTabKey): string {
  const base = `/app/geo/${encodeURIComponent(geoId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/** Every step id, for the walk and for tests that assert no old link dies. */
export const GEO_LEGACY_TABS: readonly string[] = Object.freeze(["overview", ...GEO_STEP_KEYS] as Array<GeoStepKey | "overview">);
