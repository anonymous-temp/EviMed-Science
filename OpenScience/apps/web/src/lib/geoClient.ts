/**
 * 「循证 GEO」 — the browser's side of `/api/geo/*` (build spec 2026-09-25 §3).
 *
 * Hidden knowledge:
 *
 *  - Every route answers in the platform's `{ data }` envelope, so every call
 *    goes through `productRequest`, which unwraps it and turns a refusal into a
 *    `WebApiError` carrying the named code.
 *  - The module can be off, or offered only to operators; either way every
 *    route answers 404 `geo_not_enabled` (`isGeoOff`). A page that gets it
 *    renders the off page rather than an error.
 *  - A GEO project is an ordinary control-plane project plus one GEO row. The
 *    GEO id (`id`) addresses these routes; the control-plane id (`projectId`)
 *    is the project the shell switches to before it opens a conversation. The
 *    routes are account-scoped, not project-scoped, so none of them depends on
 *    which project the tab is in.
 *  - A number is never a bare number. Every rate and index arrives as a cell
 *    (`GeoCell`) carrying its numerator, denominator and status; `readGeoCell`
 *    normalises whatever the server sent into that shape, so a missing or
 *    malformed cell reads as 「—」 and never as zero. Values are on the
 *    metric's own scale: percent 0–100, index 0–100.
 *  - `insufficient` keeps its value for the record; the UI must show
 *    「样本不足」, never the number (`GeoCellText` enforces it).
 */
import { useEffect, useState } from "react";
import { fetchWebMe, WebApiError, webApiBase, type WebMe } from "./apiClient";
import { productRequest } from "./productClient";

/* ---------------------------------------------------------------- vocabulary */

/** Engine ids the probe host knows (display names in `components/geo/geoText.ts`). */
export type GeoEngine = "deepseek" | "doubao" | "yuanbao" | "qianwen" | "kimi" | "baidu" | (string & {});
export type GeoPool = "P1" | "P2" | "P3" | "P4";
export type GeoCellStatus = "ok" | "insufficient" | "not_measurable" | "absent";
export type GeoDataType = "measured" | "client_provided" | "derived" | "forecast" | "commercial";
export type GeoTierId = "1" | "2" | "3";
export type GeoProjectStatus = "active" | "paused" | "archived";
/** The eight steps of the program, in order (`projects.steps` keys). */
export type GeoStepKey = "evidence" | "journey" | "questions" | "diagnosis" | "sources" | "content" | "distribution" | "monitoring";
export const GEO_STEP_KEYS: readonly GeoStepKey[] = Object.freeze([
  "evidence", "journey", "questions", "diagnosis", "sources", "content", "distribution", "monitoring",
]);
export type GeoStepStatus = "none" | "queued" | "running" | "done" | "minimal" | "failed";
export type GeoSeverity = "S0" | "S1" | "S2" | "S3" | "S4";
export type GeoErrorType = "label_conflict" | "number" | "dropped_condition" | "unfounded" | "attribute_swap";
export type GeoErrorStatus = "open" | "acting" | "awaiting_remeasure" | "closed";
export type GeoErrorAction = "own_edit" | "correction_letter" | "encyclopedia_fix" | "report_and_cover" | "no_contact" | "continuous_supply";
export type GeoArticleLayer = "deep" | "card" | "popular" | "qa" | "correction";
export type GeoArticleStatus = "draft" | "publishable" | "placed" | "published" | "withdrawn";
export type GeoOrderState =
  | "planned" | "reserved" | "submitted" | "accepted" | "published" | "verified" | "settled" | "unknown"
  | "rejected" | "cancelled" | "refunded" | "problem" | "lost";
export type GeoSourceLayer = "anchor" | "coverage" | "owned";
export type GeoSnapshotStatus = "valid" | "suspect" | "refusal" | "failed";
/** What a project can be told to export (`POST …/export`). */
export type GeoExportKind = "weekly" | "proposal";

/* --------------------------------------------------------------------- shapes */

/** One number and what it rests on (SPEC §3 "Number cell shape"). */
export interface GeoCell {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  status: GeoCellStatus;
  dataType: GeoDataType;
  /**
   * The answers the number rests on (build spec §0 ruling 8), when the server
   * sends them: the first is where a click on the number lands.
   */
  snapshotIds?: string[];
}

/** One step of the program (`projects.steps[key]`, SPEC §2.2). */
export interface GeoStep {
  status: GeoStepStatus;
  requested: boolean;
  runId?: string | null;
  roundId?: string | null;
  updatedAt?: string | null;
  note?: string | null;
}
export type GeoSteps = Partial<Record<GeoStepKey, GeoStep>>;

export interface GeoProductIdentity {
  brandName?: string | null;
  genericName?: string | null;
  aliases?: string[];
  misspellings?: string[];
  approvalNo?: string | null;
  holder?: string | null;
  form?: string | null;
  strength?: string | null;
  rx?: "rx" | "otc" | null;
  tcm?: boolean;
  indication?: string | null;
  labelRef?: string | null;
  variants?: string[];
  identityStatus?: "confirmed" | "ambiguous" | "unknown";
}
export interface GeoCompetitor {
  brandName?: string | null;
  genericName?: string | null;
  holder?: string | null;
  indication?: string | null;
  reason?: string | null;
}

/** One row of the home list (`GET /api/geo/projects`). */
export interface GeoProjectSummary {
  id: string;
  projectId: string;
  name: string;
  product: { brandName: string | null; genericName: string | null };
  coverageDays: number;
  engines: GeoEngine[];
  status: GeoProjectStatus;
  steps: GeoSteps;
  headline: {
    gvi: GeoCell & { target: number | null; trend: number[] };
    /** 品牌提及率 over P2 + P3 only. */
    mention: GeoCell;
  };
  alert: { wrongOurs: number; safety: number; text: string | null };
  /** Engines the probe host can measure beyond the default five (e.g. `baidu`), when the server lists them. */
  availableEngines?: GeoEngine[];
  /** When the coverage window started, if the server says (for 「10月1日 – 12月31日」). */
  startedAt?: string | null;
  createdAt?: string | null;
  updatedAt: string;
}

export type GeoOverviewMetricKey = "gvi" | "mention" | "accuracy" | "citation";
export interface GeoOverviewMetric {
  key: GeoOverviewMetricKey;
  cell: GeoCell;
  /** The chosen tier's target on the metric's own scale, or null before there is one. */
  target: number | null;
  trend: Array<{ date: string; value: number | null }>;
}
/** Which tab a 「本周」 line jumps to, and what inside it. */
export interface GeoWeekItem {
  kind: string;
  text: string;
  tab: GeoStepKey | "overview" | "answers";
  ref: { snapshotId?: string; errorId?: string; articleId?: string; orderId?: string; sourceId?: string; round?: string } | null;
  /** When it happened, if the server says. */
  at?: string | null;
}
export interface GeoOverview {
  metrics: GeoOverviewMetric[];
  week: GeoWeekItem[];
  steps: GeoSteps;
}

/** One project (`GET /api/geo/projects/:id`). */
export interface GeoProject {
  id: string;
  projectId: string;
  name: string;
  product: GeoProductIdentity;
  competitors: GeoCompetitor[];
  coverageDays: number;
  engines: GeoEngine[];
  tier: GeoTierId;
  budget: { totalCny: number; dailyCny: number; setAt?: string | null } | null;
  status: GeoProjectStatus;
  steps: GeoSteps;
  /** The latest conversation in the project; null before there is one. */
  sessionId: string | null;
  overview: GeoOverview;
  startedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface GeoClaim {
  id: string;
  statement: string;
  quote: string;
  sourceRef: string;
  sourceKind: "label" | "guideline" | "trial" | "review" | "literature" | "regulator" | "other" | null;
  evidenceLevel: string | null;
  population: string | null;
  inLabel: boolean | null;
  verifiedAt: string | null;
  validUntil: string | null;
  status: "active" | "expired" | "retired";
}
export interface GeoEvidence {
  product: GeoProductIdentity;
  competitors: GeoCompetitor[];
  claims: GeoClaim[];
}

export interface GeoJourney {
  subtypes: string[];
  personas: string[];
  stages: Array<{ stage: string; emotion: string; thinking: string; questions: string[]; infoSources: string[] }>;
  careNodes: Array<{ node: string; redFlags: string[] }>;
  files: Array<{ path: string; title: string }>;
}

export interface GeoQuestion {
  id: string;
  text: string;
  kind: "typical" | "real" | "label_safety" | "client";
  platform: string | null;
  sourceUrl: string | null;
  isMeasured: boolean;
}
export interface GeoQuestionGroup {
  id: string;
  pool: GeoPool;
  name: string;
  typicalQuestion: string;
  journeyStage: string | null;
  audience: "patient" | "physician" | null;
  weight: number | null;
  isControl: boolean;
  signal: "collected" | "partial" | "no_signal" | "client" | null;
  questions: GeoQuestion[];
}
export interface GeoQuestions {
  sets: Array<{ version: number; lockedAt: string | null; measuredCount: number | null }>;
  version: number | null;
  groups: GeoQuestionGroup[];
}

export interface GeoCitedSource {
  url: string | null;
  domain: string | null;
  attribute: "owned" | "partner" | "encyclopedia" | "farm" | "impostor" | "none" | null;
}
export interface GeoErrorRow {
  id: string;
  engine: GeoEngine;
  statement: string;
  severity: GeoSeverity;
  errorType: GeoErrorType;
  stability: "stable" | "sporadic" | "unconfirmed" | null;
  citedSource: GeoCitedSource | null;
  action: GeoErrorAction | null;
  status: GeoErrorStatus;
  snapshotId: string | null;
  /** Present on the answer page's rows: the claim's quote the statement contradicts. */
  evidenceQuote?: string | null;
  claimId?: string | null;
  questionId?: string | null;
}
export interface GeoRoundRef {
  id: string;
  kind: string;
  sampleDate: string | null;
}
export interface GeoDiagnosis {
  round: (GeoRoundRef & { surface: Record<string, unknown> | null; planned: number | null; done: number | null; engines: GeoEngine[] }) | null;
  rounds: GeoRoundRef[];
  byEngine: Array<{ engine: GeoEngine; mention: GeoCell; accuracy: GeoCell; citation: GeoCell; retrieval: GeoCell }>;
  byPool: Array<{ pool: GeoPool; mention: GeoCell; topCompetitor: string | null; mainIssue: string | null }>;
  failureModes: { omitted: GeoCell; correct: GeoCell; wrongOurs: GeoCell; wrongCompetitor: GeoCell };
  errors: GeoErrorRow[];
  noise: { band: number; measuredAt: string | null } | null;
  more: Array<{ metricId: string; name: string; cell: GeoCell }>;
}

export interface GeoCitation {
  url: string;
  domain: string | null;
  title: string | null;
  inBody: boolean;
}
export interface GeoBrandFact {
  name: string;
  ours: boolean;
  competitor: boolean;
  position: number | null;
  inRecommendation: boolean;
  count: number;
}
export interface GeoStatementFact {
  text: string;
  verdict: "correct" | "wrong" | "unverifiable";
  claimId: string | null;
  errorType: GeoErrorType | null;
  severity: GeoSeverity | null;
  evidence: string | null;
}
export interface GeoAnswer {
  question: { id: string; text: string; pool: GeoPool | null };
  snapshot: {
    id: string;
    engine: GeoEngine;
    askedAt: string;
    status: GeoSnapshotStatus;
    answerText: string | null;
    citations: GeoCitation[];
    surface: Record<string, unknown> | null;
    /** Whether a screenshot is on file (`geoScreenshotUrl`). */
    screenshot: boolean;
    /** The screenshot's content address, when the server sends it. */
    screenshotSha256?: string | null;
  };
  siblings: Array<{
    engine: GeoEngine;
    snapshotId: string | null;
    status: GeoSnapshotStatus | "absent";
    /** What that engine's answer did for us, when the server says: 「提及」「讲错 1 处」「引用你」. */
    mentionsOurs?: boolean | null;
    wrongOurs?: number | null;
    citesOurs?: boolean | null;
  }>;
  facts: { brands: GeoBrandFact[]; statements: GeoStatementFact[] } | null;
  errors: GeoErrorRow[];
  history: Array<{ sampleDate: string; snapshotId: string }>;
}

export interface GeoSourceRow {
  id: string;
  domain: string;
  name: string | null;
  kind: string | null;
  layer: GeoSourceLayer | null;
  /** The three conditions: ICP owner matches, news-grade indexed, medical category or vertical. */
  conditions: { icp: boolean | null; newsIndexed: boolean | null; medical: boolean | null };
  impostor: boolean;
  cited: Record<string, number>;
  mentionsOurs: number;
  wrongOurs: number;
  market: { price: number | null; resourceId: string } | null;
}
export interface GeoTier {
  tier: GeoTierId;
  targets: Array<{ metricId: string; pool: GeoPool | null; baseline: number | null; target: number | null }>;
  placements: number | null;
  budgetCny: number | null;
}
export interface GeoSources {
  sources: GeoSourceRow[];
  expectations: Array<{ engine: GeoEngine; retrieval: GeoCell; promise: string | null; layers: string[] }>;
  battlefield: { groups: string[]; reason: string | null } | null;
  tiers: GeoTier[];
  chosenTier: GeoTierId | null;
}

export interface GeoArticle {
  id: string;
  layer: GeoArticleLayer;
  title: string;
  groupId: string | null;
  question: string | null;
  status: GeoArticleStatus;
  gate: "passed" | "unverified" | "failed" | null;
  safety: "clear" | "open" | "released" | null;
  path: string | null;
  runId: string | null;
  claimCount: number;
  placements: number;
  cited: boolean;
}
export interface GeoArticles {
  articles: GeoArticle[];
}

export interface GeoOrderCheck {
  at?: string | null;
  kind?: string | null;
  ok?: boolean | null;
  [key: string]: unknown;
}
export interface GeoOrder {
  id: string;
  articleTitle: string;
  media: string;
  domain: string | null;
  layer: GeoArticleLayer | null;
  state: GeoOrderState;
  priceCny: number | null;
  publishedUrl: string | null;
  checks: GeoOrderCheck[];
  updatedAt: string;
}
export interface GeoDistribution {
  budget: { totalCny: number; dailyCny: number } | null;
  spentCny: number;
  reservedCny: number;
  suggestedBudgetCny: number | null;
  market: { configured: boolean };
  orders: GeoOrder[];
}

export interface GeoSeriesPoint {
  date: string;
  value: number | null;
  /** Denominator — how many answers the point rests on. */
  n: number | null;
  /** Numerator. */
  k: number | null;
}
export interface GeoMonitoring {
  series: Array<{ key: string; points: GeoSeriesPoint[] }>;
  arms: {
    pilot: Array<{ date: string; value: number | null }>;
    control: Array<{ date: string; value: number | null }>;
    netEffect: GeoCell & { noiseBand: number | null };
  };
  byEngine: Array<{ engine: GeoEngine; points: GeoSeriesPoint[] }>;
  cited: Array<{ articleId: string; title: string; engine: GeoEngine; firstSeen: string }>;
  newErrors: GeoErrorRow[];
  next: { date: string; kind: string } | null;
}

/* ------------------------------------------------------------------- readers */

const CELL_STATUSES: ReadonlySet<string> = new Set(["ok", "insufficient", "not_measurable", "absent"]);
const DATA_TYPES: ReadonlySet<string> = new Set(["measured", "client_provided", "derived", "forecast", "commercial"]);

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Any value as a cell. Nothing the server did not send becomes a number: a
 * missing cell is `not_measurable` with no value, which the UI shows as 「—」.
 */
export function readGeoCell(raw: unknown): GeoCell {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const status = typeof value.status === "string" && CELL_STATUSES.has(value.status) ? value.status as GeoCellStatus : "not_measurable";
  return {
    value: finite(value.value),
    numerator: finite(value.numerator),
    denominator: finite(value.denominator),
    ciLow: finite(value.ciLow),
    ciHigh: finite(value.ciHigh),
    status,
    dataType: typeof value.dataType === "string" && DATA_TYPES.has(value.dataType) ? value.dataType as GeoDataType : "measured",
    ...(Array.isArray(value.snapshotIds)
      ? { snapshotIds: value.snapshotIds.filter((snapshot): snapshot is string => typeof snapshot === "string" && snapshot.length > 0) }
      : {}),
  };
}

function readSummary(raw: GeoProjectSummary): GeoProjectSummary {
  const headline = (raw?.headline ?? {}) as Partial<GeoProjectSummary["headline"]>;
  const gvi = (headline.gvi ?? {}) as Partial<GeoProjectSummary["headline"]["gvi"]>;
  return {
    ...raw,
    engines: Array.isArray(raw?.engines) ? raw.engines : [],
    steps: raw?.steps && typeof raw.steps === "object" ? raw.steps : {},
    headline: {
      gvi: {
        ...readGeoCell(gvi),
        target: finite(gvi.target),
        trend: Array.isArray(gvi.trend) ? gvi.trend.filter((point): point is number => finite(point) !== null) : [],
      },
      mention: readGeoCell(headline.mention),
    },
    alert: {
      wrongOurs: finite(raw?.alert?.wrongOurs) ?? 0,
      safety: finite(raw?.alert?.safety) ?? 0,
      text: typeof raw?.alert?.text === "string" && raw.alert.text ? raw.alert.text : null,
    },
  };
}

function readProject(raw: GeoProject): GeoProject {
  const overview = (raw?.overview ?? {}) as Partial<GeoOverview>;
  const steps = raw?.steps && typeof raw.steps === "object" ? raw.steps : (overview.steps ?? {});
  return {
    ...raw,
    product: raw?.product ?? {},
    competitors: Array.isArray(raw?.competitors) ? raw.competitors : [],
    engines: Array.isArray(raw?.engines) ? raw.engines : [],
    tier: raw?.tier ?? "2",
    budget: raw?.budget ?? null,
    steps,
    sessionId: typeof raw?.sessionId === "string" && raw.sessionId ? raw.sessionId : null,
    overview: {
      metrics: (Array.isArray(overview.metrics) ? overview.metrics : []).map((metric) => ({
        key: metric.key,
        cell: readGeoCell(metric.cell),
        target: finite(metric.target),
        trend: Array.isArray(metric.trend)
          ? metric.trend.filter((point) => point && typeof point.date === "string").map((point) => ({ date: point.date, value: finite(point.value) }))
          : [],
      })),
      week: Array.isArray(overview.week) ? overview.week.filter((item) => item && typeof item.text === "string" && item.text) : [],
      steps: overview.steps && typeof overview.steps === "object" ? overview.steps : steps,
    },
  };
}

/** Whether a refusal says the module is off for this account. */
export function isGeoOff(error: unknown): boolean {
  return error instanceof WebApiError && error.status === 404 && error.code === "geo_not_enabled";
}

const id = (value: string) => encodeURIComponent(value);
const project = (geoId: string) => `/geo/projects/${id(geoId)}`;

/* -------------------------------------------------------------------- routes */

export async function listGeoProjects(): Promise<GeoProjectSummary[]> {
  const data = await productRequest<{ projects?: GeoProjectSummary[] }>("/geo/projects");
  return (Array.isArray(data?.projects) ? data.projects : []).map(readSummary);
}

export function createGeoProject(input: { brandName?: string; coverageDays?: number; engines?: string[] } = {}) {
  return productRequest<{ id: string; projectId: string; sessionId: string }>("/geo/projects", "POST", input);
}

export async function getGeoProject(geoId: string): Promise<GeoProject> {
  return readProject(await productRequest<GeoProject>(project(geoId)));
}

export function patchGeoProject(geoId: string, input: { coverageDays?: number; engines?: string[]; tier?: GeoTierId; status?: GeoProjectStatus }) {
  return productRequest<unknown>(project(geoId), "PATCH", input);
}

export function deleteGeoProject(geoId: string) {
  return productRequest<unknown>(project(geoId), "DELETE");
}

export function getGeoEvidence(geoId: string) {
  return productRequest<GeoEvidence>(`${project(geoId)}/evidence`);
}

export function getGeoJourney(geoId: string) {
  return productRequest<GeoJourney>(`${project(geoId)}/journey`);
}

export function getGeoQuestions(geoId: string, version?: number | null) {
  return productRequest<GeoQuestions>(`${project(geoId)}/questions${version == null ? "" : `?version=${id(String(version))}`}`);
}

/** 「移出测量问句」: the server writes a new question-set version without it. */
export function unmeasureGeoQuestion(geoId: string, questionId: string) {
  return productRequest<unknown>(`${project(geoId)}/questions/${id(questionId)}/unmeasure`, "POST", {});
}

export function getGeoDiagnosis(geoId: string, round?: string | null) {
  return productRequest<GeoDiagnosis>(`${project(geoId)}/diagnosis${round ? `?round=${id(round)}` : ""}`);
}

export function getGeoAnswer(geoId: string, snapshotId: string) {
  return productRequest<GeoAnswer>(`${project(geoId)}/answers/${id(snapshotId)}`);
}

/**
 * Where a snapshot's screenshot is served. An `<img>` or a link can use it
 * directly: the session is a cookie, and the route checks ownership itself.
 */
export function geoScreenshotUrl(geoId: string, sha256: string): string {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  return `${root}${project(geoId)}/screenshots/${id(sha256)}`;
}

export function getGeoSources(geoId: string) {
  return productRequest<GeoSources>(`${project(geoId)}/sources`);
}

export function setGeoTier(geoId: string, tier: GeoTierId) {
  return productRequest<unknown>(`${project(geoId)}/tier`, "POST", { tier });
}

export function getGeoArticles(geoId: string) {
  return productRequest<GeoArticles>(`${project(geoId)}/articles`);
}

export function withdrawGeoArticle(geoId: string, articleId: string) {
  return productRequest<unknown>(`${project(geoId)}/articles/${id(articleId)}/withdraw`, "POST", {});
}

/** 「放行」: the safety stop, after a person has looked at the article. */
export function releaseGeoArticle(geoId: string, articleId: string) {
  return productRequest<unknown>(`${project(geoId)}/articles/${id(articleId)}/release`, "POST", {});
}

export function getGeoDistribution(geoId: string) {
  return productRequest<GeoDistribution>(`${project(geoId)}/distribution`);
}

export function setGeoBudget(geoId: string, budget: { totalCny: number; dailyCny: number }) {
  return productRequest<unknown>(`${project(geoId)}/budget`, "PUT", budget);
}

/** 「撤单」: only before the outlet accepted it. */
export function cancelGeoOrder(geoId: string, orderId: string) {
  return productRequest<unknown>(`${project(geoId)}/orders/${id(orderId)}/cancel`, "POST", {});
}

export function getGeoMonitoring(geoId: string) {
  return productRequest<GeoMonitoring>(`${project(geoId)}/monitoring`);
}

/** 「让 AI 做」: dispatches one step now, in the project's own conversation. */
export function runGeoStep(geoId: string, step: GeoStepKey) {
  return productRequest<{ sessionId: string; runId?: string | null }>(`${project(geoId)}/run`, "POST", { step });
}

export function exportGeo(geoId: string, kind: GeoExportKind) {
  return productRequest<{ sessionId: string; runId: string | null }>(`${project(geoId)}/export`, "POST", { kind });
}

/* -------------------------------------------------------------------- feature */

/** Whether `/api/me` offers this account the module. A missing `features` is off. */
export function geoOffered(me: WebMe | null): boolean {
  const features = (me as (WebMe & { features?: unknown }) | null)?.features;
  return !!features && typeof features === "object" && (features as Record<string, unknown>).geo === true;
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type GeoFeature = "loading" | "on" | "off" | "error";

/**
 * The account's answer, read once per mount from the shared `/api/me`.
 *
 * Presentation only, like `useFrontierFeature`: the routes authorize
 * themselves, so a browser that flips this gains a navigation row, never the
 * data behind it.
 */
export function useGeoFeature(): GeoFeature {
  const [feature, setFeature] = useState<GeoFeature>("loading");
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => fetchWebMe())
      .then(
        (me) => { if (active) setFeature(geoOffered(me) ? "on" : "off"); },
        () => { if (active) setFeature("error"); },
      );
    return () => { active = false; };
  }, []);
  return feature;
}
