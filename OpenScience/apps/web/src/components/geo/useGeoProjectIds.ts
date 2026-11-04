import { useEffect, useState, useSyncExternalStore } from "react";
import { useProjectStore } from "@/lib/projects";
import { listGeoProjects, type GeoProjectSummary } from "@/lib/geoClient";
import { sessionGeneration, subscribeSessionBoundary } from "@/lib/sessionLifecycle";

let associations = new Map<string, GeoProjectSummary>();
let controlNames = new Map<string, string>();
const listeners = new Set<() => void>();

/** Reuses an authorized lookup the native GEO options already needed. */
export function rememberGeoProject(project: GeoProjectSummary, controlName: string | undefined): void {
  if (project.access?.owner === false) return;
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
export function useGeoProjectClassification(enabled: boolean, projectsKey: string): { ids: ReadonlySet<string>; ready: boolean; error: boolean; retry: () => void } {
  const generation = useSyncExternalStore(subscribeSessionBoundary, sessionGeneration, sessionGeneration);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([enabled, projectsKey, generation, attempt]);
  const retry = () => setAttempt(value => value + 1);
  const [state, setState] = useState<{ key: string; ids: ReadonlySet<string>; ready: boolean; error: boolean }>({ key: "", ids: NONE, ready: false, error: false });
  useEffect(() => {
    if (!enabled) {
      associations = new Map();
      listeners.forEach((listener) => listener());
      setState({ key, ids: NONE, ready: true, error: false });
      return undefined;
    }
    let live = true;
    const changed = () => setState(previous => previous.key === key && previous.ready ? { ...previous, ids: new Set(associations.keys()) } : previous);
    listeners.add(changed);
    const names = new Map(useProjectStore.getState().projects.map((project) => [project.id, project.name]));
    void listGeoProjects().then((projects) => {
      if (!live || sessionGeneration() !== generation) return;
      controlNames = names;
      const owned = projects.filter(project => project.access?.owner !== false);
      associations = new Map(owned.map(project => [project.projectId, project]));
      listeners.forEach(listener => listener());
      setState({ key, ids: new Set(owned.map(project => project.projectId)), ready: true, error: false });
    }).catch(() => { if (live && sessionGeneration() === generation) setState({ key, ids: NONE, ready: false, error: true }); });
    return () => { live = false; listeners.delete(changed); };
  }, [enabled, projectsKey, generation, key]);
  return state.key === key ? { ...state, retry } : { ids: NONE, ready: !enabled, error: false, retry };
}

export function useGeoProjectIds(enabled: boolean, projectsKey: string): ReadonlySet<string> {
  return useGeoProjectClassification(enabled, projectsKey).ids;
}
