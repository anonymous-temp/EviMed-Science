import { isStudyChatPath, studyIdFromPath, VCR_HOME_PATH, vcrChatPath } from "./studyLocation";

export const VCR_WORKSPACE_AREAS = ["records", "virtual-cohort", "virtual-patient", "synthetic-control", "virtual-trial", "patient-matching"] as const;
export type VcrWorkspaceArea = typeof VCR_WORKSPACE_AREAS[number];
const resultDestinations = {
  "virtual-cohort": { tab: "population", level: "cohort" },
  "virtual-patient": { tab: "population", level: "individual" },
  "synthetic-control": { tab: "comparator" },
  "virtual-trial": { tab: "trial" },
  "patient-matching": { tab: "matching" },
} as const;

/** Module directories use query addresses so they cannot be mistaken for study ids. */
export function parseVcrWorkspaceArea(search: string): VcrWorkspaceArea {
  const area = new URLSearchParams(search).get("area");
  return VCR_WORKSPACE_AREAS.find(value => value === area) ?? "records";
}
export function vcrWorkspaceAreaPath(area: VcrWorkspaceArea): string {
  return area === "records" ? VCR_HOME_PATH : `${VCR_HOME_PATH}?${new URLSearchParams({ area })}`;
}

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
  const studyId = studyIdFromPath(from.pathname);
  if (area === "records" || !studyId) return vcrWorkspaceAreaPath(area);
  const destination = resultDestinations[area];
  const level = "level" in destination ? `?level=${destination.level}` : "";
  return vcrContextPath(`${VCR_HOME_PATH}/${encodeURIComponent(studyId)}/${destination.tab}${level}`, from);
}

/** Libraries, drafts and the study's overview/data do not masquerade as a directory. */
export function vcrWorkspaceCurrentArea(pathname: string, search: string): VcrWorkspaceArea | null {
  const params = new URLSearchParams(search);
  if (pathname.replace(/\/$/, "") === VCR_HOME_PATH) {
    if (params.get("new") === "1" || ["precedents", "definitions", "models"].includes(params.get("tab") ?? "")) return null;
    return parseVcrWorkspaceArea(search);
  }
  if (!studyIdFromPath(pathname)) return null;
  const tab = isStudyChatPath(pathname) ? params.get("result") : pathname.split("/")[4];
  if (tab === "population" || tab === "patients") return tab === "patients" || params.get("level") === "individual" ? "virtual-patient" : "virtual-cohort";
  return VCR_WORKSPACE_AREAS.find(area => area !== "records" && resultDestinations[area].tab === tab) ?? null;
}
