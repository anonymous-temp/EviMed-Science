import { useCallback, useEffect, useRef } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { listGeoProjects, patchGeoProject, type GeoProjectSummary } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import {
  engineName,
  GEO_CAPABILITY_IDS,
  GEO_COVERAGE_DAYS,
  GEO_DEFAULT_COVERAGE_DAYS,
  GEO_DEFAULT_ENGINES,
  GEO_OPTIONAL_ENGINES,
  GEO_STARTERS,
} from "./geoText";

/** What the frame's GEO chip draws beside itself (the bridge's `geo` message). */
export interface FrameGeoOptions {
  sessionId: string;
  /** Whether there is a GEO project to write the two options to. */
  controls: boolean;
  coverageDays: number;
  coverageOptions: readonly number[];
  engines: string[];
  offered: Array<{ id: string; name: string }>;
  starters: Array<{ label: string; draft: string }>;
}

/** The engines the composer offers: the default five, and those the server lists beyond them. */
export function offeredEngines(project: GeoProjectSummary | null): string[] {
  const extra = GEO_OPTIONAL_ENGINES.filter((engine) => project?.engines.includes(engine) || project?.availableEngines?.includes(engine));
  return [...GEO_DEFAULT_ENGINES, ...extra];
}

/** The chip's options for a conversation, from its GEO project — or, with none, the starters alone. */
export function frameGeoOptions(sessionId: string, project: GeoProjectSummary | null): FrameGeoOptions {
  const offered = offeredEngines(project);
  const chosen = project?.engines.filter((engine) => offered.includes(engine)) ?? [];
  const product = project?.product.brandName || project?.product.genericName || null;
  return {
    sessionId,
    controls: project !== null,
    coverageDays: project?.coverageDays ?? GEO_DEFAULT_COVERAGE_DAYS,
    coverageOptions: GEO_COVERAGE_DAYS,
    engines: chosen.length ? chosen : [...GEO_DEFAULT_ENGINES],
    offered: offered.map((id) => ({ id, name: engineName(id) })),
    starters: GEO_STARTERS.map((starter) => ({ label: starter.label, draft: starter.draft(product) })),
  };
}

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

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    if (!geo) {
      if (found.current) post({ sessionId, clear: true });
      found.current = null;
      return undefined;
    }
    let live = true;
    void listGeoProjects()
      .then((projects) => projects.find((project) => project.projectId === projectId) ?? null)
      // The module refusing, or the list not answering: the chip keeps its
      // starters and has nothing to write options to.
      .catch(() => null)
      .then((project) => {
        if (!live) return;
        found.current = { sessionId, project };
        post(frameGeoOptions(sessionId, project));
      });
    return () => { live = false; };
  }, [enabled, geo, projectId, sessionId, post]);

  return useCallback((change: { sessionId?: unknown; coverageDays?: unknown; engines?: unknown }) => {
    const current = found.current;
    const project = current?.project;
    if (!current || !project || (change.sessionId != null && change.sessionId !== current.sessionId)) return;
    const patch: { coverageDays?: number; engines?: string[] } = {};
    if (typeof change.coverageDays === "number" && GEO_COVERAGE_DAYS.includes(change.coverageDays)) patch.coverageDays = change.coverageDays;
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
  }, [post]);
}
