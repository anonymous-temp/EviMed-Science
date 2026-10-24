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
  | "V09"
  | "V04"
  | "V05"
  | "V06"
  | "V07"
  | "V11"
  | "V12"
  | "V14"
  | "V17"
  | "V18"
  | "V19"
  | "V20"
  | "V21"
  | "V22";
export interface GeoAnalysisDescriptor {
  viewId: GeoAnalysisId;
  metricId?: string | null;
  dimension?: "project" | "engine" | "group";
  timeGrain?: "day" | "round";
  entityKind?: "brand" | "generic";
  entityKey?: string;
  sourceType?: string;
  sourceSearch?: string;
  sourceRelationship?: "all" | "wrong" | "mentions";
  sourceLevel?: "domain" | "page";
  sourceFacet?: "engine" | "group";
  topN?: number;
  ownedMetricId?: "M-08" | "M-08S";
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
  value: number | string | null;
  numerator?: number;
  denominator?: number;
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
    ownershipBasis?: string;
    relationship?: string;
    temporalBasis?: string;
    configureAction?: {step:string;action:string};
    annotationContext?: {pages:Array<{url:string;recordIndex:number}>;records:Array<{relation:string;origin?:string;reference:{id:string;revision:number}|null}>};
    annotations?: Array<{url:string;relation:string;origin?:string;reference:{id:string;revision:number}|null}>;
    gaps?: Record<"evidence"|"source"|"content",{state:string;items:Array<{id?:string;url?:string;version?:number;resultVersionId?:string|null;status?:string;digest?:string|null;quote?:string;statement?:string;sourceRef?:string;verifiedAt?:string|null;sourceKey?:string;annotation?:unknown}>;publications?:Array<{id:string;url:string;articleId:string;resultVersionId:string|null}>;action:{step:string;groupId:string|null;setVersion:number|null}}> ;
    sourceFacet?: "engine" | "group";
    groupState?: "known" | "unmapped" | "unknown";
    questionId?: string | null;
    mode?: string | null;
    comparisonCohortKey?: string;
    firstObservedBasis?: "selected_scope";
    previousRoundId?: string | null;
    observation?: string | null;
    transition?: string | null;
    sourceType?: string;
    domain?: string;
    sourceKey?: string | null;
    sourceId?: string | null;
    originalUrls?: string[];
    firstObserved?: string | null;
    lastObserved?: string | null;
    history?: Array<{roundId:string;kind:string|null;citedAnswers:number}>;
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
    kind?: string;
    category?: string;
    quote?: string;
    entity?: string;
    conditionQuote?: string | null;
    explicitPosition?: number | null;
    positionQuote?: string | null;
    assessmentVersion?: string | null;
    snapshotId?: string;
  };
  values: Record<string, GeoAnalysisValue>;
}
export interface GeoAnalysisChartCell {
  x?: number | null; y?: number | null; sampleSize?: number; yState?: string; xDenominator?: number | null; yDenominator?: number | null;
  sourceKey?: string | null; sourceLabel?: string; facetKey?: string | null;
  roundId?: string; roundLabel?: string; comparisonCohortKey?: string; questionId?: string | null; observation?: string | null; transition?: string | null;
  rowKey: string; columnKey: string; label: string;
  groupId: string | null; setVersion: number | null; engine: string | null; pool?: string | null;
  groupName?: string | null;
  entityName?: string; own?: boolean; comparisonKey?: string | null; comparisonLabel?: string | null;
  value: number | null; state: string; reason?: string | null; unit?: string; members?: GeoAnalysisMembers | null;
}
export interface GeoAnalysisView {
  definition?: {sourceTypes?: string[]};
  chart?: {
    kind?: "bars" | "matrix" | "comparison" | "rivals" | "recommendations" | "sources" | "source_facets" | "source_history" | "source_relationships" | "opportunities";
    mode?: "type_coverage" | "source_concentration";
    denominator?: number;
    topN?: number;
  ownedMetricId?: "M-08" | "M-08S";
    totalCategories?: number;
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
  judgment?: unknown;
  comparisonCohortKey?: string;
  source?: {sourceKey?: string;domain?: string;originalUrls?: string[];pages:Array<{sourceKey:string;domain:string;sourceType:string;originalUrls:string[];titles:string[];snapshotIds:string[];annotations?:Array<{url:string;relation:string;origin?:string;reference:{id:string;revision:number}|null;reviewedAt?:string|null}>;preservedCitations?: Array<{url?:string;marker?:unknown;position?:unknown;inBody?:boolean|null;[key:string]:unknown}>}>;cooccurrenceOnly:true};
  citingAnswers?: GeoAnalysisMemberItem[];
  extraction?: {genericMentions: unknown; parserVersion: string | null; registryKey?: string | null; judgedAt: string | null} | null;
  assessmentVersion?: string | null;
  questionVersion?: number;
  registryKey?: string | null;
  expression?: { rationale?: string | null; quote: string; entity: string | null; state: string; conditionQuote: string | null; explicitPosition: number | null; positionQuote: string | null;
    positionToken?: string | null;
    positionKind?: "explicit_recommendation_order" | null;
    nonrecommendationBasis?: {statementQuote:string;entity:string;conditionQuote:string|null;claimId:string;claimVersion:number;evidenceQuote:string;evidenceConditionQuote:string|null;relation:"supports_nonrecommendation"} | null;
    claimRefs: Array<{claimId: string; claimVersion: number}> };
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
