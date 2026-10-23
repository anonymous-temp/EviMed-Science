/** Browser projection of the server's closed GEO observation scope. Navigation never enters a data query. */
export interface GeoReadScope {
  round?: string | null;
  from?: string | null;
  to?: string | null;
  compareFrom?: string | null;
  compareTo?: string | null;
  comparisonMode?: "common" | "separate";
  timeZone?: string;
  engines?: string[];
  questionVersion?: number | null;
  groupIds?: string[];
  pools?: string[];
  clientTags?: string[];
  selectionRef?: string | null;
}

const SCALARS = ["round", "from", "to", "compareFrom", "compareTo", "comparisonMode", "timeZone", "questionVersion", "selectionRef"] as const;
const LISTS = ["engines", "groupIds", "pools", "clientTags"] as const;
const ALIASES = { engines: "engine", groupIds: "cluster", pools: "pool" } as const;
const distinct = (values: string[], trim = true) => [...new Set(values.filter(value => value.trim()).map(value => trim ? value.trim() : value))].sort();

/** Existing single-choice links and repeated multi-choice filters share one representation. */
export function geoReadScopeFromSearch(search: string): GeoReadScope {
  const params = new URLSearchParams(search);
  const scope: GeoReadScope = {};
  for (const name of SCALARS) {
    const value = params.get(name);
    if (value == null || value === "") continue;
    if (name === "questionVersion") scope.questionVersion = Number(value);
    else if (name === "comparisonMode") {
      // Unsupported URL values remain invalid at the API boundary rather than changing the comparison silently.
      scope.comparisonMode = value as GeoReadScope["comparisonMode"];
    } else scope[name] = value;
  }
  for (const name of LISTS) {
    const values = params.getAll(name);
    const raw = values.length || name === "clientTags" ? values : params.getAll(ALIASES[name]);
    const selected = distinct(name === "clientTags" ? raw : raw.flatMap(value => value.split(",")), name !== "clientTags");
    if (selected.length) scope[name] = selected;
  }
  return scope;
}

/** Stable query/cache identity. A label is repeated verbatim, never split at a comma. */
export function geoReadScopeQuery(scope?: GeoReadScope | null): string {
  const query = new URLSearchParams();
  if (!scope) return "";
  for (const name of SCALARS) {
    const value = scope[name];
    if (value != null && value !== "") query.set(name, String(value));
  }
  for (const name of LISTS) for (const value of distinct(scope[name] ?? [], name !== "clientTags")) query.append(name, value);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Replace the analytical scope, retaining the view, conversation and open object. */
export function geoSearchWithScope(search: string, scope: GeoReadScope): string {
  const query = new URLSearchParams(search);
  for (const name of [...SCALARS, ...LISTS, ...Object.values(ALIASES), "errorOffset", "answerOffset"]) query.delete(name);
  for (const [key, value] of new URLSearchParams(geoReadScopeQuery(scope))) query.append(key, value);
  return query.toString();
}

export interface GeoSelection {
  reference: string;
  dataRevision: string;
  memberDigest: string;
  methodVersion: string | null;
  roundIds: string[];
  questionIds: string[];
  counts: { observations: number; questions: number; snapshots: number; planned: number | null; [key: string]: number | null };
  engines: string[];
  pools: string[];
  coverage?: Record<string, unknown>;
  exclusions?: Record<string, unknown>;
  timeCoverage?: { basis: string; observedFrom: string | null; observedTo: string | null; unknownTime: number; plannedRounds: number };
}

export interface GeoScopedView {
  scope?: GeoReadScope;
  selection?: GeoSelection;
  comparison?: {
    mode: "common" | "separate";
    comparable: boolean;
    commonQuestionEngineModes: number;
    currentSelection: GeoSelection;
    previousSelection: GeoSelection;
    cells: Array<GeoMetricSelector & { current: import("./geoClient").GeoCell; previous: import("./geoClient").GeoCell | null;
      comparable: boolean; reason: string | null; delta: number | null }>;
  } | null;
}

export interface GeoMetricSelector {
  observationDate?: string;
  metricId: string;
  scope: string;
  engine: string | null;
  pool: string | null;
  groupId: string | null;
  arm: string | null;
  variant: string | null;
  rival: string | null;
}

export interface GeoMetricMembers {
  total: number;
  shown: number;
  more: boolean;
  nextOffset: number | null;
  unit: string;
  basis: string;
  exact: boolean;
  digest: string;
  selectionRef: string;
  metric: GeoMetricSelector;
}
