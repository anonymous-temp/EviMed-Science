import { useEffect, useState, useSyncExternalStore } from "react";
import { useProjectStore } from "@/lib/projects";
import { listGeoProjects, type GeoProjectSummary } from "@/lib/geoClient";

let associations = new Map<string, GeoProjectSummary>();
let controlNames = new Map<string, string>();
const listeners = new Set<() => void>();

/** Reuses an authorized lookup the native GEO options already needed. */
export function rememberGeoProject(project: GeoProjectSummary, controlName: string | undefined): void {
  associations = new Map(associations).set(project.projectId, project);
  if (controlName !== undefined) controlNames.set(project.projectId, controlName);
  listeners.forEach((listener) => listener());
}

/** A fresh control-plane rename wins over an older module listing. */
export function geoProjectLabel(project: { id: string; name: string }): string {
  return controlNames.get(project.id) === project.name ? associations.get(project.id)?.name ?? project.name : project.name;
}

export function geoProjectAssociation(projectId: string): GeoProjectSummary | null {
  return associations.get(projectId) ?? null;
}

/** Uses the sidebar's authorized module listing; ordinary conversations need no extra lookup. */
export function useGeoAssociation(projectId: string): GeoProjectSummary | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => associations.get(projectId) ?? null,
    () => null,
  );
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Which of the account's control-plane projects are GEO projects, so the
 * project list can give them the radar icon.
 *
 * Read only when the module is offered (`enabled`), and again whenever the
 * account's project list changes (`projectsKey`) — a GEO project is created as
 * an ordinary project first, so a new one arrives the same way any other
 * project does. A list that cannot be read costs the icons, never the list.
 */
export function useGeoProjectIds(enabled: boolean, projectsKey: string): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    if (!enabled) {
      associations = new Map();
      listeners.forEach((listener) => listener());
      setIds(NONE);
      return undefined;
    }
    let live = true;
    const changed = () => setIds(new Set(associations.keys()));
    listeners.add(changed);
    const names = new Map(useProjectStore.getState().projects.map((project) => [project.id, project.name]));
    void listGeoProjects()
      .then((projects) => {
        if (!live) return;
        controlNames = names;
        associations = new Map(projects.map((project) => [project.projectId, project]));
        listeners.forEach((listener) => listener());
        setIds(new Set(projects.map((project) => project.projectId)));
      })
      .catch(() => { /* the folders stay folders */ });
    return () => { live = false; listeners.delete(changed); };
  }, [enabled, projectsKey]);
  return ids;
}
