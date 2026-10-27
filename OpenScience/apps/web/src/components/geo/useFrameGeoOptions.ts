import { useCallback, useEffect, useRef, useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { getGeoProject, listGeoProjects, patchGeoProject, type GeoProjectSummary, type GeoProject } from "@/lib/geoClient";
import { useProjectStore } from "@/lib/projects";
import { RUNS_CHANGED_EVENT } from "@/lib/runPresentation";
import { rememberGeoProject } from "./useGeoProjectIds";
import { toast } from "@/lib/toast";
import type { FrameGeoOptions } from "./frameGeoOptions";
import { GEO_CAPABILITY_IDS } from "./geoCapabilities";

export type { FrameGeoOptions } from "./frameGeoOptions";

/** The chip's option builders, a chunk of their own (`frameGeoOptions.ts`). */
const builders = () => import("./frameGeoOptions");

/**
 * Where the frame's `geo` destination lands: the tab's project's GEO page at
 * the named tab, or the GEO home when the project is not a GEO project (or
 * the list cannot be read).
 */
export async function geoProjectPath(projectId: string, tab: string | null): Promise<string> {
  const project = await listGeoProjects().then((projects) => projects.find((entry) => entry.projectId === projectId) ?? null, () => null);
  if (!project) return "/app/geo";
  const base = `/app/geo/${encodeURIComponent(project.id)}`;
  return tab && tab !== "overview" ? `${base}/${tab}` : base;
}

/**
 * 循证 GEO's options in the conversation frame.
 *
 * When the conversation has an explicit GEO scope or a GEO capability, the shell
 * finds the GEO project the tab's project is (a GEO project is an ordinary
 * project plus a GEO row) and tells the frame what to draw beside the chip:
 * 覆盖周期, AI 引擎 and the single-step starters. A change the reader makes
 * there comes back as `geo-options` and is written to the project with
 * `PATCH`; the frame is then told what the project holds, so a refused write
 * puts the old value back rather than leaving the control lying.
 *
 * What the chip draws is built by `frameGeoOptions.ts`, loaded the first time
 * a GEO conversation is on screen: every other conversation never needs it.
 *
 * Returns the handler for `geo-options`.
 */
export function useFrameGeoOptions({
  projectId,
  geoId,
  sessionId,
  capabilityId,
  enabled,
  post,
}: {
  projectId: string;
  geoId?: string;
  sessionId: string | null;
  capabilityId: string | null;
  enabled: boolean;
  post: (payload: FrameGeoOptions | { sessionId: string | null; clear: true }) => void;
}) {
  const found = useRef<{ scopeKey: string; sessionId: string; project: GeoProjectSummary | GeoProject | null } | null>(null);
  const scopeKey = JSON.stringify([projectId, geoId ?? null, sessionId]);
  const geo = Boolean(geoId || (capabilityId && GEO_CAPABILITY_IDS.includes(capabilityId)));
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled || !geo) return undefined;
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(RUNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(RUNS_CHANGED_EVENT, refresh);
  }, [enabled, geo]);

  useEffect(() => {
    if (!enabled || !sessionId) { found.current = null; return undefined; }
    if (!geo) {
      if (found.current) post({ sessionId, clear: true });
      found.current = null;
      return undefined;
    }
    // Refreshes keep the current conversation's confirmed settings writable;
    // a changed project, GEO scope or session immediately drops that authority.
    if (found.current?.scopeKey !== scopeKey) found.current = null;
    const refreshing = found.current;
    let live = true;
    let discovery: ReturnType<typeof setTimeout> | undefined;
    const controlName = useProjectStore.getState().projects.find((project) => project.id === projectId)?.name;
    void Promise.all([
      (geoId ? getGeoProject(geoId) : listGeoProjects().then(projects => projects.filter(project => project.projectId === projectId).length === 1 ? projects.find(project => project.projectId === projectId) ?? null : null))
        // The module refusing, or the list not answering: the chip keeps its
        // starters and has nothing to write options to.
        .catch(() => null),
      builders(),
    ])
      .then(([project, { frameGeoOptions }]) => {
        if (!live) return;
        // A read begun before a successful edit cannot reset its saved options.
        if (project && refreshing && found.current !== refreshing) return;
        if (project && !geoId) rememberGeoProject(project as GeoProjectSummary, controlName);
        // A first GEO turn may create its project after the capability chip appears.
        else if (!project) discovery = setTimeout(() => setRevision((value) => value + 1), 10_000);
        found.current = { scopeKey, sessionId, project };
        post(frameGeoOptions(sessionId, project));
      })
      // The builders' chunk would not load: the chip draws nothing extra.
      .catch(() => {});
    return () => { live = false; clearTimeout(discovery); };
  }, [enabled, geo, projectId, geoId, sessionId, scopeKey, post, revision]);

  return useCallback((change: { sessionId?: unknown; coverageDays?: unknown; engines?: unknown }) => {
    const current = found.current;
    const project = current?.project;
    if (!current || !project || (change.sessionId != null && change.sessionId !== current.sessionId)) return;
    const sameConversation = () => found.current?.scopeKey === current.scopeKey && found.current?.project?.id === project.id;
    // Loaded already: `found` is set only after the builders arrived.
    void builders().then(({ frameGeoOptions, isCoverageOption, offeredEngines }) => {
      if (!sameConversation()) return;
      const patch: { coverageDays?: number; engines?: string[] } = {};
      if (typeof change.coverageDays === "number" && isCoverageOption(change.coverageDays)) patch.coverageDays = change.coverageDays;
      if (Array.isArray(change.engines)) {
        const offered = offeredEngines(project);
        const engines = change.engines.filter((engine): engine is string => typeof engine === "string" && offered.includes(engine));
        if (engines.length) patch.engines = engines;
      }
      if (patch.coverageDays === undefined && patch.engines === undefined) return;
      void patchGeoProject(project.id, patch).then(
        () => {
          if (!sameConversation()) return;
          const next = { ...project, ...found.current?.project, ...patch };
          found.current = { ...current, project: next };
          post(frameGeoOptions(current.sessionId, next));
        },
        (error: unknown) => {
          if (!sameConversation()) return;
          toast.error(webErrorMessage(error, { fallback: "没有改成功，请稍后重试。" }));
          post(frameGeoOptions(current.sessionId, found.current?.project ?? project));
        },
      );
    }, () => {});
  }, [post]);
}
