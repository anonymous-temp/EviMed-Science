import { productRequest } from "./productClient";
import {
  geoReadScopeQuery,
  type GeoReadScope,
  type GeoMetricMembers,
} from "./geoReadScope";
import type { GeoCell } from "./geoClient";
export type GeoAnalysisId =
  | "V01"
  | "V02"
  | "V03"
  | "V08"
  | "V04"
  | "V05"
  | "V06"
  | "V07"
  | "V11"
  | "V12"
  | "V14";
export interface GeoAnalysisDescriptor {
  viewId: GeoAnalysisId;
  metricId?: string | null;
  dimension?: "project" | "engine" | "group";
  timeGrain?: "day" | "round";
  entityKind?: "brand" | "generic";
  entityKey?: string;
  categoryMode?: "original_group" | "client_tags";
}
export interface GeoAnalysisMembers {
  selectionRef: string;
  view: GeoAnalysisDescriptor;
  rowKey: string;
  columnKey: string;
  expectedDigest: string;
  unit: string;
  total: number;
  exact: true;
}
export interface GeoAnalysisValue {
  value: number | null;
  state: string;
  reason?: string | null;
  unit?: string;
  metric: GeoCell | null;
  members: GeoMetricMembers | GeoAnalysisMembers | null;
}
export interface GeoAnalysisRow {
  key: string;
  label: string;
  metricId: string | null;
  dimensions: {
    period?: string;
    date?: string | null;
    engine?: string | null;
    groupId?: string | null;
    groupName?: string | null;
    setVersion?: number | null;
    roundId?: string | null;
    roundLabel?: string | null;
    roundKind?: string | null;
    pool?: string | null;
    entityKind?: "brand" | "generic";
    entityName?: string;
    entityKey?: string | null;
    own?: boolean;
    unit?: string;
    basis?: string;
    conditions?: unknown;
  };
  values: Record<string, GeoAnalysisValue>;
}
export interface GeoAnalysisChartCell {
  rowKey: string; columnKey: string; label: string;
  groupId: string | null; setVersion: number | null; engine: string | null; pool?: string | null;
  groupName?: string | null;
  entityName?: string; own?: boolean; comparisonKey?: string | null; comparisonLabel?: string | null;
  value: number | null; state: string; reason?: string | null; unit?: string; members?: GeoAnalysisMembers | null;
}
export interface GeoAnalysisView {
  chart?: {
    kind?: "bars" | "matrix" | "comparison" | "rivals";
    cells?: GeoAnalysisChartCell[];
    labels: string[];
    series: Array<{
      key: string;
      label: string;
      engine?: string | null;
      own?: boolean;
      comparisonKey?: string | null;
      comparisonLabel?: string | null;
      unit?: string;
      values: Array<number | null>;
    }>;
  };
  view: GeoAnalysisDescriptor;
  selection: {
    reference: string;
    timeCoverage?: {
      unknownTime: number;
      plannedRounds?: number;
      unknownTimeScope?: string;
    };
  };
  digest: string;
  columns: Array<{ key: string; label: string }>;
  rows: GeoAnalysisRow[];
  page: { total: number; shown: number; nextOffset: number | null };
  availability: { status: string; reasons?: string[] };
}
export interface GeoAnalysisMemberItem {
  id: string;
  unit: string;
  snapshotId?: string;
  questionId?: string;
  text?: string;
  originalId?: string | null;
  originalRow?: number | null;
  originalGroup?: string | null;
  clientTags?: string[];
  engine?: string;
  roundId?: string;
  repeatIndex?: number;
  status?: string;
  reason?: string;
  askedAt?: string | null;
  extraction?: {genericMentions: unknown; parserVersion: string | null; registryKey?: string | null; judgedAt: string | null} | null;
  statement?: {
    text: string;
    verdict: string;
    evidence?: string;
    applicability?: unknown;
    claimId?: string;
    claimVersion?: number;
  };
  answer?: {
    answer_text: string;
    asked_at: string | null;
    surface: unknown;
    citations: Array<{ url?: string }>;
  };
  question?: {
    text: string;
    originalId?: string | null;
    originalRow?: number | null;
    originalGroup?: string | null;
    clientTags?: string[];
  };
}
export interface GeoAnalysisMemberPage {
  unit: string;
  total: number;
  items: GeoAnalysisMemberItem[];
  nextOffset: number | null;
  digest: string;
}
function analysisQuery(
  scope: GeoReadScope | undefined,
  view: GeoAnalysisDescriptor,
  offset: number,
  expectedDigest?: string,
) {
  const query = new URLSearchParams(geoReadScopeQuery(scope));
  for (const [key, value] of Object.entries({
    ...view,
    offset,
    limit: 20,
    expectedDigest,
  }))
    if (value != null) query.set(key, String(value));
  return query;
}
export function getGeoAnalysis(
  geoId: string,
  scope: GeoReadScope | undefined,
  view: GeoAnalysisDescriptor,
  offset = 0,
  expectedDigest?: string,
) {
  return productRequest<GeoAnalysisView>(
    `/geo/projects/${encodeURIComponent(geoId)}/analysis?${analysisQuery(scope, view, offset, expectedDigest)}`,
  );
}
export function getGeoAnalysisMembers(
  geoId: string,
  members: GeoAnalysisMembers,
  offset = 0,
) {
  const query = analysisQuery(
    { selectionRef: members.selectionRef },
    members.view,
    offset,
    members.expectedDigest,
  );
  query.set("rowKey", members.rowKey);
  query.set("columnKey", members.columnKey);
  return productRequest<GeoAnalysisMemberPage>(
    `/geo/projects/${encodeURIComponent(geoId)}/analysis/members?${query}`,
  );
}
