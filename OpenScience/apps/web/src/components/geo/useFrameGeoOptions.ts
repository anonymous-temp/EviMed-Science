import { useCallback, useEffect, useRef, useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { listGeoProjects, patchGeoProject, type GeoProjectSummary } from "@/lib/geoClient";
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
 * When the conversation on screen is bound to a GEO capability, the shell
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
  sessionId,
  capabilityId,
  enabled,
  post,
}: {
  projectId: string;
  sessionId: string | null;
  capabilityId: string | null;
  enabled: boolean;
  post: (payload: FrameGeoOptions | { sessionId: string | null; clear: true }) => void;
}) {
  const found = useRef<{ sessionId: string; project: GeoProjectSummary | null } | null>(null);
  const geo = Boolean(capabilityId && GEO_CAPABILITY_IDS.includes(capabilityId));
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled || !geo) return undefined;
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(RUNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(RUNS_CHANGED_EVENT, refresh);
  }, [enabled, geo]);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    if (!geo) {
      if (found.current) post({ sessionId, clear: true });
      found.current = null;
      return undefined;
    }
    let live = true;
    let discovery: ReturnType<typeof setTimeout> | undefined;
    const controlName = useProjectStore.getState().projects.find((project) => project.id === projectId)?.name;
    void Promise.all([
      listGeoProjects()
        .then((projects) => projects.find((project) => project.projectId === projectId) ?? null)
        // The module refusing, or the list not answering: the chip keeps its
        // starters and has nothing to write options to.
        .catch(() => null),
      builders(),
    ])
      .then(([project, { frameGeoOptions }]) => {
        if (!live) return;
        if (project) rememberGeoProject(project, controlName);
        // A first GEO turn may create its project after the capability chip appears.
        else discovery = setTimeout(() => setRevision((value) => value + 1), 10_000);
        found.current = { sessionId, project };
        post(frameGeoOptions(sessionId, project));
      })
      // The builders' chunk would not load: the chip draws nothing extra.
      .catch(() => {});
    return () => { live = false; clearTimeout(discovery); };
  }, [enabled, geo, projectId, sessionId, post, revision]);

  return useCallback((change: { sessionId?: unknown; coverageDays?: unknown; engines?: unknown }) => {
    const current = found.current;
    const project = current?.project;
    if (!current || !project || (change.sessionId != null && change.sessionId !== current.sessionId)) return;
    // Loaded already: `found` is set only after the builders arrived.
    void builders().then(({ frameGeoOptions, isCoverageOption, offeredEngines }) => {
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
          const next = { ...project, ...patch };
          if (found.current === current) found.current = { ...current, project: next };
          post(frameGeoOptions(current.sessionId, next));
        },
        (error: unknown) => {
          toast.error(webErrorMessage(error, { fallback: "没有改成功，请稍后重试。" }));
          post(frameGeoOptions(current.sessionId, project));
        },
      );
    }, () => {});
  }, [post]);
}
