import { isStudyChatPath, studyIdFromPath, VCR_HOME_PATH, vcrChatPath } from "./studyLocation";

/** The five entrances a person chooses between; `VCR_STEPS` stays internal vocabulary and is no rail. */
export const VCR_ENTRANCES = ["virtual-population", "patient-trajectory", "virtual-lab", "synthetic-control", "patient-matching"] as const;
/** `records` is the retained study archive: readable at its address, but not one of the five. */
export const VCR_WORKSPACE_AREAS = [...VCR_ENTRANCES, "records"] as const;
export type VcrWorkspaceArea = typeof VCR_WORKSPACE_AREAS[number];
/** Older area ids stay readable and resolve to the entrance that replaced them. */
const AREA_ALIASES: Record<string, VcrWorkspaceArea> = { "virtual-cohort": "virtual-population", "virtual-patient": "patient-trajectory", "virtual-trial": "virtual-lab" };
const resultDestinations = {
  "virtual-population": { tab: "population", level: "cohort" },
  "patient-trajectory": { tab: "population", level: "individual" },
  "synthetic-control": { tab: "comparator" },
  "virtual-lab": { tab: "trial" },
  "patient-matching": { tab: "matching" },
} as const;

/**
 * Module directories use query addresses so they cannot be mistaken for study ids. An address with no (or an unknown) area is the
 * module root, which opens the laboratory's entry surface; it never creates a study or a run.
 */
export function parseVcrWorkspaceArea(search: string): VcrWorkspaceArea {
  const area = new URLSearchParams(search).get("area") ?? "";
  return AREA_ALIASES[area] ?? VCR_WORKSPACE_AREAS.find(value => value === area) ?? "virtual-lab";
}
export function vcrWorkspaceAreaPath(area: VcrWorkspaceArea): string {
  return `${VCR_HOME_PATH}?${new URLSearchParams({ area })}`;
}

/**
 * The matching owner's destination, today the module's own address. A descriptor the matching owner can later replace: a contextual
 * handoff is unavailable (no contract has been published), so nothing from the current study is carried and no matching request is sent.
 */
export interface VcrMatchingDestination { path: (from: { pathname: string; search: string }) => string; handoff: "unavailable" }
export const vcrMatchingDestination: VcrMatchingDestination = {
  path: from => entranceDestinationPath("patient-matching", from),
  handoff: "unavailable",
};

/** Carry only conversation context within the same explicitly addressed study. */
export function vcrContextPath(path: string, from: { pathname: string; search: string }): string {
  const target = new URL(path, "https://vcr.invalid");
  const studyId = studyIdFromPath(from.pathname);
  if (!studyId || studyId !== studyIdFromPath(target.pathname)) return path;
  const source = new URLSearchParams(from.search);
  const query = new URLSearchParams();
  for (const key of ["session", "conversation"]) {
    const value = source.get(key);
    if (value) query.set(key, value);
  }
  for (const [key, value] of target.searchParams) query.set(key, value);
  if (isStudyChatPath(from.pathname)) {
    query.set("result", target.pathname.split("/")[4] || "overview");
    return `${vcrChatPath(studyId)}?${query}${target.hash}`;
  }
  return `${target.pathname}${query.size ? `?${query}` : ""}${target.hash}`;
}

export function vcrWorkspaceDestinationPath(area: VcrWorkspaceArea, from: { pathname: string; search: string }): string {
  return area === "patient-matching" ? vcrMatchingDestination.path(from) : entranceDestinationPath(area, from);
}
function entranceDestinationPath(area: VcrWorkspaceArea, from: { pathname: string; search: string }): string {
  const studyId = studyIdFromPath(from.pathname);
  if (area === "records" || !studyId) return vcrWorkspaceAreaPath(area);
  const destination = resultDestinations[area];
  const level = "level" in destination ? `?level=${destination.level}` : "";
  return vcrContextPath(`${VCR_HOME_PATH}/${encodeURIComponent(studyId)}/${destination.tab}${level}`, from);
}

/** Libraries, drafts, the archive and a study preview do not masquerade as an entrance. */
export function vcrWorkspaceCurrentArea(pathname: string, search: string): VcrWorkspaceArea | null {
  const params = new URLSearchParams(search);
  if (pathname.replace(/\/$/, "") === VCR_HOME_PATH) {
    if (params.get("new") === "1" || ["precedents", "definitions", "models"].includes(params.get("tab") ?? "")) return null;
    if (!params.has("area") && params.get("study")) return null;
    const area = parseVcrWorkspaceArea(search);
    return area === "records" ? null : area;
  }
  if (!studyIdFromPath(pathname)) return null;
  const tab = isStudyChatPath(pathname) ? params.get("result") : pathname.split("/")[4];
  if (tab === "population" || tab === "patients") return tab === "patients" || params.get("level") === "individual" ? "patient-trajectory" : "virtual-population";
  return VCR_ENTRANCES.find(area => area !== "virtual-population" && area !== "patient-trajectory" && resultDestinations[area].tab === tab) ?? null;
}
