/**
 * What the conversation frame's GEO chip draws, from a GEO project.
 *
 * Its own module, and loaded by `useFrameGeoOptions` only once a conversation
 * has an explicit GEO scope or a GEO capability: the engines, the starters and the domain's
 * GEO vocabulary behind them were otherwise in the bundle every page loads
 * before its first paint.
 */
import { geoJourney, geoActionPermission } from "./geoJourney";
import type { GeoProjectSummary, GeoProject } from "@/lib/geoClient";
import {
  engineName,
  GEO_COVERAGE_DAYS,
  GEO_DEFAULT_COVERAGE_DAYS,
  GEO_DEFAULT_ENGINES,
  GEO_OPTIONAL_ENGINES,
  GEO_STARTERS,
  GEO_STEP_NAMES,
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
  starters: Array<{ label: string; draft: string; requirement?: string }>;
  journey?: { title: string; detail: string; requested: string; nextLabel: string; nextStep: string | null; nextDraft?: string; steps: Array<{key:string;label:string;status:string}> };
  unavailable?: string;
}

/** The engines the composer offers: the default five, and those the server lists beyond them. */
export function offeredEngines(project: GeoProjectSummary | GeoProject | null): string[] {
  const extra = GEO_OPTIONAL_ENGINES.filter((engine) => project?.engines.includes(engine) || project?.availableEngines?.includes(engine));
  return [...GEO_DEFAULT_ENGINES, ...extra];
}

/** The chip's options for a conversation, from its GEO project — or, with none, the starters alone. */
export function frameGeoOptions(sessionId: string, project: GeoProjectSummary | GeoProject | null): FrameGeoOptions {
  const offered = offeredEngines(project);
  const chosen = project?.engines.filter((engine) => offered.includes(engine)) ?? [];
  const product = project?.product?.brandName || project?.product?.genericName || null;
  const journey = project ? geoJourney(project) : null;
  return {
    sessionId,
    controls: project !== null && geoActionPermission(project,"edit").allowed,
    coverageDays: project?.coverageDays ?? GEO_DEFAULT_COVERAGE_DAYS,
    coverageOptions: GEO_COVERAGE_DAYS,
    engines: chosen.length ? chosen : [...GEO_DEFAULT_ENGINES],
    offered: offered.map((id) => ({ id, name: engineName(id) })),
    starters: journey && !journey.canConverse ? [] : GEO_STARTERS.map((starter) => ({ label: starter.label, draft: starter.draft(product), requirement: starter.key === "optimize" ? "附上已有稿件，说明受众、场景与修改重点" : "产品与适用场景、目标受众、本次目标；已有资料可附在对话中" })),
    ...(journey ? {journey:{title:journey.title,detail:journey.detail,requested:journey.requested,nextLabel:journey.next.label,nextStep:journey.next.step ?? null,
      ...(journey.canConverse && journey.next.draft ? {nextDraft:journey.next.draft} : {}),
      steps:Object.values(journey.workflow.steps).map((step) => ({key:step.key,label:GEO_STEP_NAMES[step.key as keyof typeof GEO_STEP_NAMES],status:step.status}))}} : {}),
  };
}

/** Whether a coverage window is one the chip offers. */
export function isCoverageOption(days: number): boolean {
  return GEO_COVERAGE_DAYS.includes(days);
}
