/**
 * What the conversation frame's GEO chip draws, from a GEO project.
 *
 * Its own module, and loaded by `useFrameGeoOptions` only once a conversation
 * is bound to a GEO capability: the engines, the starters and the domain's
 * GEO vocabulary behind them were otherwise in the bundle every page loads
 * before its first paint.
 */
import type { GeoProjectSummary } from "@/lib/geoClient";
import {
  engineName,
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

/** Whether a coverage window is one the chip offers. */
export function isCoverageOption(days: number): boolean {
  return GEO_COVERAGE_DAYS.includes(days);
}
