import { freezeGeoPlanBasis, geoPlanFreshness, geoPlanScopeKey, geoPlanDigest, geoPlanCanonicalScope } from "./geoPlanContext.mjs";
import { geoErrorClinicalContext } from "./geoErrors.mjs";
/**
 * What 「循证 GEO」's pages are served (build spec 2026-09-25 §3), and the
 * module's switch, readiness and metrics.
 *
 * Hidden knowledge:
 *
 * - **Metric formulas belong to the domain.** Scoped views call the same
 *   measurement computation through `geoReadScope` over one repeatable-read
 *   observation selection. Cells retain their counts, interval, status and
 *   exact member reference; historical stored readings retain their method
 *   identity. A missing reading is `absent` (「未测」), never zero. Table
 *   counts are tallies over that selection, not a second metric formula.
 * - **Which row is which** is `GEO_VIEW_METRIC_IDS` in the domain: the
 *   overview's four blocks read `M-19` (the index), `M-01S` (mention over P2
 *   and P3 only), `M-06` and `M-08`; 诊断 reads the engine- and pool-scoped
 *   `M-01`/`M-06`/`M-08`/`M-10`; 监测 draws the arms with the arm-scope `M-19`
 *   and reads the net effect from `NET` and the noise band from `NOISE`. A
 *   view reads the row whose `variant` and `rival` are null (M-01S's top1/top3
 *   and M-16/M-17's per-rival rows are other cells, listed under 更多). A row's
 *   date is its round's sample date. A cell carries the row's `reason` code
 *   when it is not a number; an `insufficient` cell keeps its value for the
 *   record, and a reader is shown 「样本不足」, never that value.
 * - **Ownership is the project lookup.** Every method resolves the GEO project
 *   for the account first and answers 404 `geo_project_not_found` for anything
 *   else — another account's project reads exactly like one that never
 *   existed. The measurement and market tables are read here by project id
 *   after that lookup.
 * - **Money is shown from the ledger, decided elsewhere.** The distribution
 *   view reads the market's ledger through its own `projectMoney`; placing,
 *   cancelling and the budget itself are the market's (`geoMarket.mjs`),
 *   handed in as hooks by the routes.
 * - **Off is invisible** (`geoAudienceAllows`): the module off, or narrowed to
 *   operators and the preview list (`OPEN_SCIENCE_GEO_AUDIENCE=operators`; the
 *   default is every account) while this account is neither, reads as a module
 *   that does not exist — the routes answer 404 `geo_not_enabled` and the
 *   runtime is given no tools.
 *
 * @module geoService
 */

import path from "node:path";
import { GEO_FAILURE_MODE_LABELS_ZH, geoAbilitiesOf, geoAnswerAccuracy, geoErrorsByClaim, geoLeanActionsPage, geoSpecifiedInfoAccuracy, geoValueActive, geoValueContext, geoValueImpacts, geoValueList,
  hardLines, parseGeoActionKey, summarizeGeoValueCoverageCounts } from "@evimed/domain";

/** A failure mode as the page says it. @param {string | null} code */
const failureModeWord = (code) => (code ? /** @type {Record<string, string>} */ (GEO_FAILURE_MODE_LABELS_ZH)[code] ?? null : null);
import {
  GEO_ARM_METRIC_ID, GEO_DEFAULT_ENGINES, GEO_ENGINE_LABELS_ZH, GEO_VIEW_METRIC_IDS, GEO_METRIC_LABELS_ZH,
  GEO_OVERVIEW_METRICS, GEO_METRIC_IDS, GEO_MEASUREMENT_METHOD_VERSION, GEO_POOLS, GEO_ROUND_KIND_LABELS_ZH, GEO_URGENT_SEVERITIES, GEO_ENGINES, geoMetricMembers, geoGroupReading, geoCoverageKey,
} from "@evimed/domain";
import { GEO_READ_PAGE_LIMIT, geoDailyReadings, geoSourcePage, geoRoundReadings, geoReadTransactionActive, withGeoReadTransaction, computeGeoSelection, geoSelectionCoverage, geoReadScopeInput, geoScopeIsFiltered, readGeoSelection, readGeoSelectionErrors } from "./geoReadScope.mjs";
import { createHash } from "node:crypto";
import { geoQuestionImportPreview, geoStartDiagnosis, geoRecoverDiagnosis, geoLockCheck, geoProgramMinimal, geoRuntimeWrite, geoRecoveryMayCharge } from "./geoWrites.mjs";
import { GeoSpine } from "./geoSpine.mjs";
import { coverageKeyOf, roundCoverages } from "./geoCoverage.mjs";
import { answersCiting, countsOf, pagesCited, roundAnswers, sentenceSource, tallySources } from "./geoSourceAnswers.mjs";
import { geoSourceFromRow, questionGroupFromRow, questionFromRow } from "./geoStore.mjs";
import { nextWeeklySlot, programSteps, wantedSteps } from "./geoOrchestrator.mjs";
import { GEO_PROBE_ENGINES } from "./geoProbeQueue.mjs";
import { HttpError } from "./security.mjs";
import { GEO_ORDER_ARTICLE_LIVE_STATES, ORDER_SELECT, mapOrder, orderCancellable, projectMoney } from "./geoMarketStore.mjs";
import { mediaMarketConfigured } from "./mediaMarketClient.mjs";
import { GEO_VALUE_OBSERVATIONS_SHOWN } from "./geoValueStore.mjs";
import { GeoDistributionView } from "./geoDistributionView.mjs";
import { readFrozenGeoAnalysisPage, hasGeoFrozenAnalysisContext } from "./geoAnalysisFrozenPages.mjs";
import { readGeoAnalysis, presentGeoAnalysis, freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } from "./geoAnalysis.mjs";
import { GEO_ROUND_ANSWERED, geoRecoveryHeldCells } from "./geoMeasureStore.mjs";
import { geoRivalMonitoringRows } from "./geoAnalysisMetrics.mjs";
import { GeoSourceOwnership } from "./geoSourceOwnership.mjs";
import { GeoOwnedPublications } from "./geoOwnedPublications.mjs";

/** @typedef {{ value: number | null, numerator: number | null, denominator: number | null, ciLow: number | null, ciHigh: number | null,
 *   status: string, dataType: string, reason: string | null, methodVersion?: string | null,
 *   assessment?: { methodVersion: string, completeAnswers: number, partialAnswers: number, unknownAnswers: number, decidableAnswers?: number } }} GeoCell */

/** The cell no row speaks for: 「未测」, never zero. */
export const GEO_ABSENT_CELL = Object.freeze({ value: null, numerator: null, denominator: null, ciLow: null, ciHigh: null, status: "absent", dataType: "measured",
  reason: null });

/** Snapshot text handed to a run, per item (spec §4). */
export const GEO_ANSWER_TEXT_LIMIT = 4_000;
/** Items one runtime read returns at most (spec §4). */
export const GEO_READ_MAX_ITEMS = GEO_READ_PAGE_LIMIT;

/** The name a new GEO project's control-plane project gets when no brand is given yet. */
export const GEO_DEFAULT_PROJECT_NAME = "新循证 GEO 项目";

/**
 * The placeholders brandless projects were made with before the module was
 * called 「循证 GEO」 again (2026-10-07): 「新 GEO 项目」 until 2026-10-06, then
 * 「新循证传播项目」. A row already holding one is still a placeholder — the
 * brand replaces it — so a rename of the product never strands a project
 * under a name nobody chose. No expiry: the rows are the user's data.
 */
const GEO_PREVIOUS_DEFAULT_PROJECT_NAMES = Object.freeze(["新 GEO 项目", "新循证传播项目"]); // retired-word-ok

/** Whether a project's name is still a brandless placeholder, current or earlier. @param {string | undefined | null} name */
export function isGeoPlaceholderName(name) {
  return name === GEO_DEFAULT_PROJECT_NAME || GEO_PREVIOUS_DEFAULT_PROJECT_NAMES.includes(/** @type {string} */ (name));
}

const DIAGNOSIS_ROUND_KINDS = Object.freeze(["baseline", "weekly", "single_step"]);
/** A rival's mention rate: the owner's M-16, over the same pools as our headline M-01S. */
const GEO_RIVAL_METRIC_ID = "M-16";
/** The measurement package writes one `NOISE` row per metric (its `variant`); the band shown is mention's. */
const NOISE_BAND_OF = GEO_VIEW_METRIC_IDS.mention;
/** …and the project-scope `NET` row of the index (pool-scope rows carry each pool's metric). */
const NET_EFFECT_OF = GEO_VIEW_METRIC_IDS.gvi;
const TREND_POINTS = 26;
const WEEK_ITEMS = 5;
const WEEK_MS = 7 * 86_400_000;
const SHA256 = /^[a-f0-9]{64}$/;
/** What the store mints for a question group's id (`geoStore.mjs`): a format, not language. */
const GROUP_ID_SHAPE = /^ggr_[0-9a-f]+$/i;

/** @param {number} status @param {string} code @param {string} message */
const failure = (status, code, message) => new HttpError(status, code, message);
/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());
/** @param {unknown} value */
const num = (value) => (value == null ? null : Number(value));
/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : null);

/**
 * Whether this account sees the module at all: on, and either open to every
 * account or this one an operator or on the preview list (ids, as the
 * operator list is). The default audience is every account (`all`).
 * @param {Record<string, any>} config @param {{ id?: string } | null | undefined} user
 */
export function geoAudienceAllows(config, user) {
  if (!config?.geoEnabled) return false;
  if (config.geoAudience === "all") return true;
  const id = String(user?.id ?? "");
  return Boolean(id) && ((config.operatorUsers ?? []).includes(id) || (config.geoPreviewUsers ?? []).includes(id));
}

/**
 * Whether the media marketplace is wired: a base URL and a usable key file
 * (compose binds /dev/null where there is none). The market's one definition.
 * @param {Record<string, any>} config
 */
export function geoMarketConfigured(config) {
  return mediaMarketConfigured(config);
}

/**
 * Where a snapshot's screenshot lives: content-addressed under the server's
 * data directory (spec §2). The measurement package writes there, and the
 * screenshot route reads there; this is the one spelling of the path.
 * @param {string} dataDir @param {string} sha256
 */
export function geoScreenshotPath(dataDir, sha256) {
  if (!SHA256.test(String(sha256))) throw new TypeError("A screenshot is addressed by its lowercase sha256.");
  return path.join(dataDir, "geo", "snapshots", sha256.slice(0, 2), `${sha256}.png`);
}

/**
 * A claim's status as a reader and a run should take it: an active claim
 * whose validity has run out (`validUntil` in the past) is `expired` — 待重核
 * on the page — until it is checked again, never silently still valid (plan
 * §3.1: 到期或说明书改版自动失效重核; `valid_until` was stored and never read).
 * Advice, not a block: the stored row is unchanged and a run re-checks it by
 * writing the claim again with a new `validUntil`.
 * @param {{ status?: string | null, validUntil?: string | null }} claim @param {Date} now
 */
export function claimStatusAt(claim, now) {
  const status = String(claim?.status ?? "active");
  const until = claim?.validUntil ? Date.parse(claim.validUntil) : Number.NaN;
  return status === "active" && Number.isFinite(until) && until < now.getTime() ? "expired" : status;
}

/** @param {any} row @returns {GeoCell} */
export function geoCellFromRow(row) {
  if (!row) return { ...GEO_ABSENT_CELL };
  return {
    value: num(row.value), numerator: num(row.numerator), denominator: num(row.denominator), ciLow: num(row.ci_low), ciHigh: num(row.ci_high),
    status: String(row.status), dataType: String(row.data_type ?? "measured"), reason: text(row.reason),
    methodVersion: text(row.method_version),
    ...(row.assessment && typeof row.assessment === "object" && !Array.isArray(row.assessment) ? { assessment: row.assessment } : {}),
  };
}

/**
 * What a GEO project is called: its project's name — a researcher's rename
 * wins — unless that is still the placeholder a brandless project was made
 * with, in which case the brand the run wrote.
 * @param {{ product?: Record<string, any> }} project @param {string | undefined} controlName
 */
export function geoProjectName(project, controlName) {
  const brand = text(project.product?.brandName);
  if (controlName && !isGeoPlaceholderName(controlName)) return controlName;
  return brand || controlName || GEO_DEFAULT_PROJECT_NAME;
}

/**
 * The conversation a GEO project made before its conversation was recorded opens: the oldest of its project's conversations that no
 * programme run opened — the one the project was created with. Never the newest: that was whichever conversation of the project was
 * touched last (a capability chosen, a document scoped), and the project's research conversation was silently replaced by it.
 * @param {ReadonlyArray<{ sessionId?: string, createdAt?: string | null }>} sessions
 * @param {ReadonlySet<string>} programme the sessions programme runs opened
 * @returns {string | null}
 */
export function oldestPersonalConversation(sessions, programme) {
  const own = sessions.filter((entry) => entry && typeof entry.sessionId === "string" && entry.sessionId && !programme.has(entry.sessionId));
  own.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  return own[0]?.sessionId ?? null;
}

/** A calendar day in a time zone, `YYYY-MM-DD`. @param {Date} date @param {string} timeZone */
function dayIn(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Prefer the round's local observation day; old stored metrics without that provenance retain their computation day.
 * @param {any} row @param {string} timeZone */
function rowDay(row, timeZone) {
  const localDay = row.selection_date ?? row.sample_date ?? row.observation_date;
  if (localDay) {
    if (typeof localDay === "string") return localDay.slice(0, 10);
    // pg represents DATE as a Date at host-local midnight. Its civil components are already the requested day, not an instant to re-zone.
    const date = new Date(localDay);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return dayIn(new Date(row.observed_at ?? row.started_at ?? row.created_at ?? row.computed_at), timeZone);
}

/** @param {unknown} value @param {number} max */
const clip = (value, max) => {
  const string = String(value ?? "").replace(/\s+/g, " ").trim();
  return string.length > max ? `${string.slice(0, max - 1)}…` : string;
};

/** @param {string} engine */
const engineLabel = (engine) => /** @type {Record<string, string>} */ (GEO_ENGINE_LABELS_ZH)[engine] ?? engine;
/** An engine's name before Chinese text: a Latin name takes a space (「Kimi 讲错」, 「豆包讲错」). @param {string} engine */
const spacedLabel = (engine) => {
  const label = engineLabel(engine);
  return /[A-Za-z0-9]$/.test(label) ? `${label} ` : label;
};

/** @param {any} row */
function errorView(row) {
  return {
    id: String(row.id),
    engine: String(row.engine),
    statement: text(row.statement),
    severity: text(row.severity),
    errorType: text(row.error_type),
    stability: row.confirm && typeof row.confirm === "object" ? text(row.confirm.stability) : null,
    citedSource: row.cited_source && typeof row.cited_source === "object" ? row.cited_source : null,
    action: text(row.action),
    status: String(row.status),
    snapshotId: text(row.last_snapshot_id) ?? text(row.first_snapshot_id),
    // The statement is the first sentence the error was seen as (one row per fingerprint, later answers repeating the claim in other
    // words only move `last_snapshot_id`): this is the answer whose text holds it word for word.
    firstSnapshotId: text(row.first_snapshot_id),
    questionId: text(row.question_id),
    // The claim the statement contradicts, stable across the engines that say it: what the errors are grouped by (`byClaim`).
    fingerprint: text(row.fingerprint),
    judgmentState: row.judgment_state ?? "active", judgmentCorrection: row.judgment_correction ?? null, judgmentHistory: row.judgment_history ?? [],
    // What the statement contradicts: the claim and its quote (对的是什么 / 依据哪份说明书).
    claimId: text(row.claim_id),
    evidenceQuote: text(row.evidence_quote),
    ...geoErrorClinicalContext(row),
    createdAt: iso(row.created_at),
  };
}

/**
 * The other engines' answers to the same question in the same round, one per
 * engine, each with what it did for us from its facts (提及 / 讲错 N 处 / 引用你);
 * an engine of the round with no answer reads `absent` (「未测」).
 * @param {any[]} rows
 */
function answerSiblings(rows) {
  const firsts = rows.filter((row, index, all) => all.findIndex((other) => other.engine === row.engine) === index);
  const siblings = firsts.map((row) => {
    const statements = Array.isArray(row.statements) ? row.statements : [];
    const judged = row.judged != null;
    return {
      engine: text(row.engine), snapshotId: String(row.id), status: text(row.status),
      mentionsOurs: judged && row.mentions_ours != null ? Boolean(row.mentions_ours) : null,
      wrongOurs: judged ? statements.filter((/** @type {any} */ statement) => statement?.verdict === "wrong").length : null,
      citesOurs: judged && row.cites_ours != null ? Boolean(row.cites_ours) : null,
    };
  });
  const roundEngines = Array.isArray(rows[0]?.round_engines) ? rows[0].round_engines.map(String) : [];
  for (const engine of roundEngines) {
    if (!siblings.some((sibling) => sibling.engine === engine)) {
      siblings.push({ engine, snapshotId: /** @type {any} */ (null), status: "absent", mentionsOurs: null, wrongOurs: null, citesOurs: null });
    }
  }
  return siblings;
}

/**
 * The rounds whose project-scope rows are the headline, the overview's blocks
 * and every trend line: full measurements of the question set. A sentinel
 * (ten questions on two engines), a post-publication check, a confirmation or
 * a noise round measures a sliver and never stands in for them.
 */
export const GEO_HEADLINE_ROUND_KINDS = Object.freeze(["baseline", "weekly", "single_step"]);

/** How many snapshot ids a cell carries at most (the first is where a click lands). */
export const GEO_CELL_SNAPSHOT_LIMIT = 200;

/**
 * Whether a project's measurement can run now, from the probe's own state (`geoProbeQueue`'s breaker, in this process): the project's
 * engines the breaker holds paused — every probe engine while the probe host cannot be reached — and `paused` when none of the
 * project's engines can be asked. An engine of the inclusion channel is not the probe's and is never held here. With no probe state
 * to read (the measurement not composed), or no probe configured (the queue's wait, not an absence), nothing is known to be paused. 2026-10-25: the probe host had been
 * unreachable for six days, every round closed with nothing asked, and the monitoring page went on naming the next re-measure.
 * @param {{ engines: readonly string[], probe?: { breaker?: { paused?: () => string[] }, hostPausedUntil?: number } | null,
 *   config: Record<string, any>, now: Date }} input
 * @returns {{ state: "measuring" | "paused", engines: string[] }}
 */
export function geoMeasurementPause({ engines, probe = null, config, now }) {
  const inclusion = new Set((config?.geoInclusionEngines ?? []).map(String));
  const probed = engines.filter((engine) => GEO_PROBE_ENGINES.includes(engine) && !inclusion.has(engine));
  const hostDown = Number(probe?.hostPausedUntil ?? 0) > now.getTime();
  const held = new Set(probe?.breaker?.paused?.() ?? []);
  const paused = probed.filter((engine) => hostDown || held.has(engine));
  const askable = engines.filter((engine) => inclusion.has(engine) || (probed.includes(engine) && !paused.includes(engine)));
  return { state: engines.length && !askable.length ? "paused" : "measuring", engines: paused };
}

/**
 * The engines this deployment can measure: the configured probe engines and
 * the inclusion channel's (the new-project control offers them).
 * @param {Record<string, any>} config
 */
export function geoAvailableEngines(config) {
  const listed = [...(config?.geoEngines?.length ? config.geoEngines : GEO_DEFAULT_ENGINES), ...(config?.geoInclusionEngines ?? [])];
  return [...new Set(listed.map(String))].filter((engine) => GEO_ENGINES.includes(engine));
}

/**
 * A failure-mode tally as a cell: the count over the round's answers in the
 * denominator (valid and refusal answers; suspect ones are out), with the
 * answers that show it.
 * @param {number} count @param {number} total @param {string[]} snapshotIds
 */
function tallyCell(count, total, snapshotIds) {
  if (!total) return { ...GEO_ABSENT_CELL, snapshotIds: [] };
  return {
    value: Math.round((count / total) * 10_000) / 100, numerator: count, denominator: total, ciLow: null, ciHigh: null,
    status: total < 30 ? "insufficient" : "ok", dataType: "measured", reason: null, snapshotIds: snapshotIds.slice(0, GEO_CELL_SNAPSHOT_LIMIT),
  };
}

/** A metric row as a runtime read lists it. @param {any} row @param {(metricId: string) => string | null} name */
function metricView(row, name) {
  return {
    metricId: String(row.metric_id), name: name(String(row.metric_id)), scope: String(row.scope), pool: text(row.pool), engine: text(row.engine),
    groupId: text(row.group_id), arm: text(row.arm), variant: text(row.variant), rival: text(row.rival), roundId: text(row.round_id),
    computedAt: iso(row.computed_at), cell: geoCellFromRow(row),
  };
}

/** The plain cell of a metric: not a top1/top3 variant, not one rival's row, not a group's. */
const PLAIN_ROW = "m.variant IS NULL AND m.rival IS NULL AND m.group_id IS NULL";
const engineMetricDescriptors = () => [...GEO_METRIC_IDS.map((metricId) => ({ metricId, variant: null })), { metricId: "M-20", variant: "refusal" }];

/**
 * An action as the runtime reads it when it asks for one (`geo_read actions` with a `key` or a `groupId`): every number the page's
 * action holds (k of n, the target, the status, the counts of what stands behind it) and the run's own words clipped — the same
 * function's output, shorter. A list is read as the domain's lean rows (`geoLeanAction`), which leave the long words out.
 * @param {Record<string, any>} action
 */
export function compactAction(action) {
  return {
    key: action.key, kind: action.kind, status: action.status,
    group: action.group ? { id: action.group.id, name: action.group.name, pool: action.group.pool } : null,
    gapId: action.need.gapId, gapClass: action.need.gapClass, errorIds: action.need.errorIds, judgment: action.need.judgment ? clip(action.need.judgment, 300) : null,
    expectedPoints: action.need.expectedPoints.slice(0, 5).map((/** @type {any} */ point) => ({ statement: clip(point.statement, 160), claimIds: point.claimIds })),
    what: action.what, engines: action.engines,
    sources: action.sources.map((/** @type {any} */ source) => ({ domain: source.domain, channel: source.channel, route: source.route, chosen: source.chosen,
      available: source.available, price: source.price, why: source.why ? clip(source.why, 160) : null })),
    expected: { metricId: action.expected.primaryMetricId, promise: action.expected.promise, from: action.expected.from, baseline: action.expected.baseline,
      target: action.expected.target, reached: action.expected.reached, horizonWeeks: action.expected.horizonWeeks, tier: action.expected.tier,
      closes: action.expected.closes },
    articleIds: action.articleIds, orderIds: action.orderIds, ownedLinkIds: action.ownedLinkIds,
    observed: { citedBy: action.observed.citedBy.length, series: action.observed.series.length, arm: action.observed.arm },
    choice: action.choice, checks: action.checks.map((/** @type {any} */ check) => check.code), reason: action.reason,
  };
}

export class GeoService {
  /** @type {any} */ planContexts = null;
  /** @type {import('./geoSignals.mjs').GeoSignals | null} */ signals = null;
  /**
   * @param {{ store: import("./geoStore.mjs").GeoStore, config: Record<string, any>, social?: any, now?: () => Date,
   *   metricName?: ((metricId: string) => string | null) | null, cards?: { staleReferences?: Function, list?: Function, blockedBy?: Function } | null,
   *   documents?: import('./productStore.mjs').ProductDocuments | null }} options
   *   `metricName` names a metric id for 「更多指标」; the metrics package can
   *   hand in its catalogue's names, and without it the domain's labels answer
   *   for the ids the platform reads and every other id is its own name.
   *   `cards` (geoCards.mjs) says which articles cite a claim the cards have since
   *   corrected; without it no article is flagged.
   */
  constructor({ store, config, social = null, now = () => new Date(), metricName = null, cards = null, documents = null }) {
    if (!store || !config) throw new TypeError("The GEO service needs its store and the config.");
    this.store = store;
    this.config = config;
    /** @type {any} The same deployment adapter the measurement worker uses. */
    this.inclusion = null;
    /** @type {ReturnType<typeof import("./geoDiagnosisReview.mjs").createGeoDiagnosisReview> | null} */
    this.diagnosisReview = null;
    this.social = social;
    /** @type {import('./geoSignalInputs.mjs').GeoSignalInputs | null} */
    this.signalInputs = null;
    this.cards = cards;
    this.now = now;
    this.distributionView = new GeoDistributionView({ store });
    this.sourceOwnership = documents ? new GeoSourceOwnership({ documents, now }) : null;
    this.ownedPublications = documents ? new GeoOwnedPublications({ store, documents, now }) : null;
    this.timeZone = String(config.geoTimeZone || "Asia/Shanghai");
    /** How many error rows 准确与安全 carries at most (`OPEN_SCIENCE_GEO_DIAGNOSIS_ERROR_LIMIT`); the counts beside them are never capped. */
    this.errorListLimit = Number.isSafeInteger(config.geoDiagnosisErrorLimit) && config.geoDiagnosisErrorLimit > 0 ? config.geoDiagnosisErrorLimit : 300;
    /** @param {string} metricId */
    this.metricName = (metricId) => metricName?.(metricId) ?? /** @type {Record<string, string>} */ (GEO_METRIC_LABELS_ZH)[metricId] ?? null;
    this.counters = { projectsCreated: 0, reads: 0, writes: 0, writeIssues: 0, notFound: 0, forbidden: 0, researchCapped: 0, declinedFields: 0, ignoredFields: 0 };
    /** @type {Map<string, number>} what a runtime write did not keep, by `what` and outcome (`ignored`: told to the run; `declined`: on the platform's own list) */
    this.fieldTotals = new Map();
    /**
     * The question group as the spine of the project: clusters, actions, the strategy read and what is asked of a person. The
     * composition gives it the market's read-only ranking (`spine.placementPreview`) when there is a market.
     */
    this.spine = new GeoSpine({ store, now: () => this.now(), marketConfigured: () => geoMarketConfigured(config) });
    /**
     * The probe's in-process state (the breaker, the host pause), set by the composition beside the measurement; what the
     * monitoring view says of a paused measurement (`geoMeasurementPause`). Null: nothing is known to be paused.
     * @type {(() => { breaker?: { paused?: () => string[] }, hostPausedUntil?: number } | null) | null}
     */
    this.probeState = null;
  }

  ready() { return this.store.ready(); }

  /** @param {{ id?: string }} user */
  allows(user) { return geoAudienceAllows(this.config, user); }

  /** @param {{ id?: string }} user */
  isOperator(user) { return (this.config.operatorUsers ?? []).includes(String(user?.id ?? "")); }

  /**
   * The project as this account may reach it, or 404 — another account's project reads exactly like one that never existed. The
   * account is the project's owner (every ability) or a member (the abilities of its roles); a member without `ability` is told by
   * the ability's name, since they know the project is there (`geo_member_forbidden`). The project is the owner's: its rows, its
   * workspace and its money are the owner's whoever acts, and `access` says who is acting and what they may do.
   * @param {{ id: string }} user @param {string} id @param {string} [ability]
   */
  async requireProject(user, id, ability = "read") {
    const access = typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? await this.store.getProjectAccess(String(user.id), id) : null;
    if (!access) {
      this.counters.notFound += 1;
      throw failure(404, "geo_project_not_found", "GEO project not found.");
    }
    const abilities = geoAbilitiesOf(access.roles);
    if (!abilities.includes(/** @type {any} */ (ability))) {
      this.counters.forbidden += 1;
      throw failure(403, "geo_member_forbidden", `Your role in this project does not allow ${ability}.`);
    }
    return { ...access.project, access: { roles: access.roles, abilities, owner: access.roles.includes("owner") } };
  }

  // --- rows the views share -------------------------------------------------------

  /**
   * The latest project-scope row of each metric id, for many projects at once.
   * @param {string[]} geoIds @param {readonly string[]} metricIds
   * @returns {Promise<Map<string, Map<string, any>>>} project → metric → row
   */
  async #latestProjectMetrics(geoIds, metricIds) {
    /** @type {Map<string, Map<string, any>>} */
    const byProject = new Map();
    if (!geoIds.length) return byProject;
    // The latest round is one that heard an answer (`GEO_ROUND_ANSWERED`): an empty week has no metrics, and as the latest it
    // emptied the headline of every project the probe host could not reach.
    const result = await this.store.query(`WITH chosen AS (
        SELECT DISTINCT ON (r.geo_project_id) r.id, r.geo_project_id, r.sample_date FROM evimed_geo.rounds r
        WHERE r.geo_project_id = ANY($1::text[]) AND r.kind = ANY($3::text[]) AND (r.status NOT IN ('done', 'partial') OR ${GEO_ROUND_ANSWERED("r")})
        ORDER BY r.geo_project_id, (r.status IN ('done', 'partial')) DESC, CASE WHEN r.status IN ('done', 'partial') THEN r.finished_at END DESC NULLS LAST, r.created_at DESC, r.id DESC
      ) SELECT DISTINCT ON (m.geo_project_id, m.metric_id) m.*, r.sample_date
      FROM evimed_geo.metrics m JOIN chosen r ON r.id = m.round_id AND r.geo_project_id = m.geo_project_id
      WHERE m.geo_project_id = ANY($1::text[]) AND m.scope = 'project' AND m.metric_id = ANY($2::text[]) AND m.arm IS NULL AND ${PLAIN_ROW}
      ORDER BY m.geo_project_id, m.metric_id, m.computed_at DESC, m.id DESC`, [geoIds, [...metricIds], [...GEO_HEADLINE_ROUND_KINDS]]);
    for (const row of result.rows) {
      const map = byProject.get(row.geo_project_id) ?? new Map();
      map.set(String(row.metric_id), row);
      byProject.set(row.geo_project_id, map);
    }
    return byProject;
  }

  /**
   * A metric's project-scope series: one point per round (its latest row),
   * oldest first, the last 26. With `coverage`, every point carries the key of
   * what its round measured (`geoCoverageKey`): two points are compared only
   * when their keys are equal (R14 N-4).
   * @param {string[]} geoIds @param {readonly string[]} metricIds
   * @param {string} [scope] @param {string} [extra] @param {{ coverage?: boolean }} [options]
   * @returns {Promise<Map<string, Map<string, Array<{ date: string, value: number | null, n: number | null, k: number | null, coverage?: string | null }>>>>}
   */
  async #series(geoIds, metricIds, scope = "project", extra = "", { coverage = false } = {}) {
    // `extra` names a column spliced into the query: only these two ever are.
    if (extra && !["arm", "engine"].includes(extra)) throw new TypeError("A series splits by arm or engine only.");
    /** @type {Map<string, Map<string, Array<{ date: string, value: number | null, n: number | null, k: number | null }>>>} */
    const byProject = new Map();
    if (!geoIds.length) return byProject;
    const result = await this.store.query(`SELECT * FROM (
        SELECT DISTINCT ON (m.geo_project_id, m.metric_id, coalesce(m.round_id, m.id)${extra ? `, m.${extra}` : ""}, m.variant)
          m.*, r.sample_date, coalesce(r.started_at, r.created_at) AS observed_at
        FROM evimed_geo.metrics m JOIN evimed_geo.rounds r ON r.id = m.round_id AND r.kind = ANY($4::text[])
        WHERE m.geo_project_id = ANY($1::text[]) AND m.scope = $3 AND m.metric_id = ANY($2::text[]) AND m.pool IS NULL AND ${scope === "engine" ? "m.rival IS NULL AND m.group_id IS NULL" : PLAIN_ROW}
        ORDER BY m.geo_project_id, m.metric_id, coalesce(m.round_id, m.id)${extra ? `, m.${extra}` : ""}, m.variant, m.computed_at DESC
      ) latest ORDER BY coalesce(sample_date::timestamp, observed_at), observed_at, round_id`, [geoIds, [...metricIds], scope, [...GEO_HEADLINE_ROUND_KINDS]]);
    const coverages = coverage ? await roundCoverages(this.store, result.rows.map((/** @type {any} */ row) => String(row.round_id ?? ""))) : null;
    for (const row of result.rows) {
      const key = extra ? `${row.metric_id}\u0000${row[extra] ?? ""}${row.variant ? `\u0000${row.variant}` : ""}` : String(row.metric_id);
      const map = byProject.get(row.geo_project_id) ?? new Map();
      const points = map.get(key) ?? [];
      points.push({
        date: rowDay(row, this.timeZone), value: num(row.value), n: num(row.denominator), k: num(row.numerator),
        // An engine's own series is of that engine alone: its rate does not move with which others answered.
        ...(coverages ? { coverage: coverageKeyOf(coverages.get(String(row.round_id ?? "")), {
          engine: extra === "engine" ? text(row.engine) : null, methodVersion: text(row.method_version),
        }) } : {}),
      });
      map.set(key, points);
      byProject.set(row.geo_project_id, map);
    }
    for (const map of byProject.values()) for (const [key, points] of map) map.set(key, points.slice(-TREND_POINTS));
    return byProject;
  }

  /**
   * Each registered rival's mention rate (M-16, P2 and P3 — the same
   * questions our headline rate M-01S is over) per full measurement, oldest
   * first, the last 26: the grey lines beside ours (G15). A rival no round
   * measured has no series.
   * @param {string} geoId @returns {Promise<Array<{ name: string, points: Array<{ date: string, value: number | null, n: number | null, k: number | null, coverage: string | null }> }>>}
   */
  async #rivalSeries(geoId) {
    const rows = (await this.store.query(`SELECT * FROM (
        SELECT DISTINCT ON (m.round_id, m.rival) m.*, r.sample_date, coalesce(r.started_at, r.created_at) AS observed_at
        FROM evimed_geo.metrics m JOIN evimed_geo.rounds r ON r.id = m.round_id AND r.kind = ANY($3::text[])
        WHERE m.geo_project_id = $1 AND m.scope = 'project' AND m.metric_id = $2 AND m.rival IS NOT NULL AND m.pool IS NULL
          AND m.variant IS NULL AND m.group_id IS NULL AND m.arm IS NULL
        ORDER BY m.round_id, m.rival, m.computed_at DESC
      ) latest ORDER BY coalesce(sample_date::timestamp, observed_at), observed_at, round_id`, [geoId, GEO_RIVAL_METRIC_ID, [...GEO_HEADLINE_ROUND_KINDS]])).rows;
    /** @type {Map<string, Array<{ date: string, value: number | null, n: number | null, k: number | null, coverage: string | null }>>} */
    const byRival = new Map();
    const coverages = await roundCoverages(this.store, rows.map((/** @type {any} */ row) => String(row.round_id ?? "")));
    for (const row of rows) {
      const points = byRival.get(String(row.rival)) ?? [];
      points.push({ date: rowDay(row, this.timeZone), value: row.status === "ok" ? num(row.value) : null, n: num(row.denominator), k: num(row.numerator),
        coverage: coverageKeyOf(coverages.get(String(row.round_id ?? "")), { methodVersion: text(row.method_version) }) });
      byRival.set(String(row.rival), points);
    }
    return [...byRival].map(([name, points]) => ({ name, points: points.slice(-TREND_POINTS) }));
  }

  /**
   * The chosen tier's project-wide target for a metric (`pool` all), or null. A pool's own target (P2's mention goal, say) is another
   * number: it never stands in for the project's — the overview once printed 「目标 12%」 beside a reading of 43% that way.
   * @param {Awaited<ReturnType<import("./geoStore.mjs").GeoStore["latestTargets"]>>} targets @param {string} tier @param {string} metricId
   */
  #target(targets, tier, metricId) {
    if (!targets) return null;
    return targets.rows.find((row) => row.tier === tier && row.metricId === metricId && row.pool === "all")?.target ?? null;
  }

  // --- the home list ------------------------------------------------------------------

  /** `GET /api/geo/projects`. @param {{ id: string }} user */
  async listProjects(user) {
    // Projects the account owns and projects it is a member of: the names of both are their owners'.
    const projects = await this.store.listProjectsFor(String(user.id));
    const ids = projects.map((project) => project.id);
    const headline = [GEO_VIEW_METRIC_IDS.gvi, GEO_VIEW_METRIC_IDS.mentionHeadline];
    const [latest, series, names, alerts, targets, started] = await Promise.all([
      this.#latestProjectMetrics(ids, headline),
      this.#series(ids, [GEO_VIEW_METRIC_IDS.gvi]),
      this.#controlProjectNames(projects.map((project) => ({ userId: project.userId, projectId: project.projectId }))),
      this.#alerts(ids),
      Promise.all(projects.map((project) => this.store.latestTargets(project.id))),
      this.#startedAt(projects),
    ]);
    const availableEngines = geoAvailableEngines(this.config);
    return {
      projects: projects.map((project, index) => {
        const metrics = latest.get(project.id) ?? new Map();
        const trend = (series.get(project.id)?.get(GEO_VIEW_METRIC_IDS.gvi) ?? []).map((point) => point.value).filter((value) => value != null);
        const alert = alerts.get(project.id) ?? { wrongOurs: 0, severe: 0, safety: 0, severity: null };
        return {
          id: project.id,
          projectId: project.projectId,
          name: geoProjectName(project, names.get(project.projectId)),
          product: { brandName: text(project.product?.brandName), genericName: text(project.product?.genericName) },
          coverageDays: project.coverageDays,
          engines: project.engines,
          status: project.status,
          steps: project.steps,
          headline: {
            gvi: { ...geoCellFromRow(metrics.get(GEO_VIEW_METRIC_IDS.gvi)), target: this.#target(targets[index], project.tier, GEO_VIEW_METRIC_IDS.gvi), trend },
            mention: geoCellFromRow(metrics.get(GEO_VIEW_METRIC_IDS.mentionHeadline)),
          },
          alert,
          startedAt: started.get(project.id) ?? project.createdAt,
          createdAt: project.createdAt,
          availableEngines,
          updatedAt: project.updatedAt,
        };
      }),
    };
  }

  /** @param {Array<{ userId: string, projectId: string }>} pairs */
  async #controlProjectNames(pairs) {
    /** @type {Map<string, string>} */
    const names = new Map();
    if (!pairs.length) return names;
    try {
      const result = await this.store.query(`SELECT p.id, p.name FROM evimed_control.projects p
        JOIN unnest($1::text[], $2::text[]) AS wanted(user_id, id) ON wanted.user_id = p.user_id AND wanted.id = p.id`,
      [pairs.map((pair) => pair.userId), pairs.map((pair) => pair.projectId)]);
      for (const row of result.rows) names.set(String(row.id), String(row.name));
    } catch {
      // A store without the control-plane schema (a unit test's double) names nothing.
    }
    return names;
  }

  /**
   * 讲错我方 still open, how many of them are severe (S3/S4), and safety stops, per project; `severity` is the worst open grade.
   * The home row says the counts in its own words — the engine's sentence is read on 总览 and 准确与安全, one click away.
   * @param {string[]} geoIds @returns {Promise<Map<string, { wrongOurs: number, severe: number, safety: number, severity: string | null }>>}
   */
  async #alerts(geoIds) {
    /** @type {Map<string, { wrongOurs: number, severe: number, safety: number, severity: string | null }>} */
    const alerts = new Map();
    if (!geoIds.length) return alerts;
    const [errors, worst, safety] = await Promise.all([
      this.store.query(`SELECT geo_project_id, count(*)::integer AS n, count(*) FILTER (WHERE severity = ANY($2::text[]))::integer AS severe
        FROM evimed_geo.errors WHERE geo_project_id = ANY($1::text[]) AND judgment_state='active' AND status <> 'closed' GROUP BY geo_project_id`, [geoIds, [...GEO_URGENT_SEVERITIES]]),
      this.store.query(`SELECT DISTINCT ON (geo_project_id) geo_project_id, severity FROM evimed_geo.errors
        WHERE geo_project_id = ANY($1::text[]) AND judgment_state='active' AND status <> 'closed'
        ORDER BY geo_project_id, severity DESC NULLS LAST, updated_at DESC`, [geoIds]),
      this.store.query(`SELECT geo_project_id, count(*)::integer AS n FROM evimed_geo.articles
        WHERE geo_project_id = ANY($1::text[]) AND safety = 'open' AND status <> 'withdrawn' GROUP BY geo_project_id`, [geoIds]),
    ]);
    const count = (/** @type {any} */ result, column = "n") => new Map(result.rows.map((/** @type {any} */ row) => [row.geo_project_id, Number(row[column])]));
    const wrong = count(errors);
    const severe = count(errors, "severe");
    const stops = count(safety);
    const severities = new Map(worst.rows.map((/** @type {any} */ row) => [row.geo_project_id, text(row.severity)]));
    for (const id of geoIds) {
      alerts.set(id, { wrongOurs: wrong.get(id) ?? 0, severe: severe.get(id) ?? 0, safety: stops.get(id) ?? 0, severity: severities.get(id) ?? null });
    }
    return alerts;
  }

  // --- creation, settings, deletion ------------------------------------------------------

  /**
   * `POST /api/geo/projects`: the control-plane project, its GEO row, and a
   * conversation bound to `geo-insight`.
   * @param {{ id: string }} user
   * @param {{ brandName?: string, coverageDays?: number, engines?: string[] }} input already validated by the route
   * @param {{ createControlProject: (user: any, name: string) => Promise<{ id: string, name: string }>,
   *   bindSession: (user: any, projectId: string, geoProject?: any) => Promise<{ sessionId: string | null, bound: boolean }> }} hooks
   */
  async createProject(user, input, hooks) {
    const name = input.brandName || GEO_DEFAULT_PROJECT_NAME;
    const control = await hooks.createControlProject(user, name);
    const engines = input.engines?.length ? input.engines : (this.config.geoEngines?.length ? this.config.geoEngines : GEO_DEFAULT_ENGINES);
    const project = await this.store.createProject({
      userId: String(user.id), projectId: control.id, engines, coverageDays: input.coverageDays ?? 90,
      product: input.brandName ? { brandName: input.brandName } : {},
    });
    const session = await hooks.bindSession(user, control.id, project);
    // The conversation made here is the project's own from now on: recorded, so the page does not drift to a later one (a project whose
    // conversation opens later is bound when it opens: `GeoNativeAuthority.descriptor`).
    if (typeof session.sessionId === "string" && session.sessionId) await this.store.setConversationSession(project.id, session.sessionId);
    this.counters.projectsCreated += 1;
    return { id: project.id, projectId: control.id, sessionId: session.sessionId, bound: session.bound };
  }

  /**
   * Record the conversation found for a project made before its conversation was recorded, or in place of a recorded one the person
   * deleted (`replacing`); otherwise the first one stands.
   * @param {string} geoId @param {string} sessionId @param {string | null} [replacing] @returns {Promise<string | null>} the conversation the project holds now
   */
  async recordConversation(geoId, sessionId, replacing = null) {
    return this.store.setConversationSession(geoId, sessionId, replacing);
  }

  /**
   * `PATCH /api/geo/projects/:id`. A `name` renames the project the module sits on: the name lives on that project (the one
   * the sidebar lists), never on the GEO row, and it belongs to the project's owner whoever with the right to edit asks — so the
   * rename is the owner's act, made through the hook the composition gives (`renameControlProject`).
   * @param {{ id: string }} user @param {string} id
   * @param {{ coverageDays?: number, engines?: string[], tier?: string, status?: string, name?: string }} patch
   * @param {{ renameControlProject?: (ownerId: string, projectId: string, name: string) => Promise<unknown> }} [hooks]
   */
  async updateProject(user, id, patch, hooks = {}) {
    const project = await this.requireProject(user, id, "edit");
    const { name, ...row } = patch;
    if (name !== undefined && !hooks.renameControlProject) throw failure(503, "geo_unavailable", "Renaming is unavailable.");
    const updated = await this.store.updateProject(project.userId, id, row);
    if (!updated) throw failure(404, "geo_project_not_found", "GEO project not found.");
    if (name !== undefined) await /** @type {NonNullable<typeof hooks.renameControlProject>} */ (hooks.renameControlProject)(project.userId, project.projectId, name);
    return name === undefined ? updated : { ...updated, name };
  }

  /** `DELETE /api/geo/projects/:id`: hidden from 循证 GEO; the project's conversations and files stay. @param {{ id: string }} user @param {string} id */
  async deleteProject(user, id) {
    const project = await this.requireProject(user, id, "delete");
    await this.store.softDeleteProject(project.userId, id);
    return { id, projectId: project.projectId, deleted: true };
  }

  // --- the project page -------------------------------------------------------------------

  /**
   * `GET /api/geo/projects/:id` without the session id (the route adds it).
   * @param {{ id: string }} user @param {string} id
   */
  async projectView(user, id, scope = {}) {
    return this.projectViewOf(await this.requireProject(user, id), scope);
  }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async projectViewOf(project, scope = {}) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.projectViewOf(project, scope));
    const selected = await readGeoSelection(this.store, project, scope);
    return this.#applySelection(project, await this.#projectViewBase(project), selected, "project", scope);
  }

  /** @param {any} project */
  async #projectViewBase(project) {
    const metricIds = GEO_OVERVIEW_METRICS.map((entry) => entry.metricId);
    const [latest, series, targets, week, names, started, cardsBlockedBy, needsYou, summaries] = await Promise.all([
      this.#latestProjectMetrics([project.id], metricIds),
      this.#series([project.id], metricIds, "project", "", { coverage: true }),
      this.store.latestTargets(project.id),
      this.#week(project),
      this.#controlProjectNames([{ userId: project.userId, projectId: project.projectId }]),
      this.#startedAt([project]),
      this.#cardsBlockedBy(project),
      this.#needsYou(project),
      this.spine.stepSummaries(project.id).catch(() => ({})),
    ]);
    // One short count per programme step, for the rail: what the step produced (「86 条结论」「25 个群」).
    const steps = Object.fromEntries(Object.entries(project.steps ?? {}).map(([step, state]) => [step,
      { ...state, summary: /** @type {Record<string, any>} */ (summaries)[step] ?? null }]));
    const rows = latest.get(project.id) ?? new Map();
    const points = series.get(project.id) ?? new Map();
    const metrics = GEO_OVERVIEW_METRICS.map(({ key, metricId }) => ({
      key,
      cell: geoCellFromRow(rows.get(metricId)),
      target: this.#target(targets, project.tier, metricId),
      // The sample size travels with each point: a thin round is not a reading, and only the page can tell from it.
      // What each round measured travels with its point: a change is stated only between points of one coverage (N-4).
      trend: (points.get(metricId) ?? []).map(({ date, value, n, coverage }) => ({ date, value, n, coverage })),
    }));
    await this.#attachSnapshotIds(project.id, GEO_OVERVIEW_METRICS.map(({ metricId }, index) => ({ cell: metrics[index].cell, row: rows.get(metricId) })));
    return {
      ...project,
      name: geoProjectName(project, names.get(project.projectId)),
      startedAt: started.get(project.id) ?? project.createdAt,
      availableEngines: geoAvailableEngines(this.config),
      // Whether step 7 can run at all on this deployment: without a market a
      // page never asks for a budget or says the reader owes one (G20).
      market: { configured: geoMarketConfigured(this.config) },
      // Why the verified claims are not becoming evidence cards: `producer` (nobody named as speaking for the product) or `reviewer`
      // (no reviewing doctor), null when nothing is in the way. The run-end import used to refuse in a log and the page said nothing (D-28).
      cards: { blockedBy: cardsBlockedBy },
      steps,
      // What the project really asks of its person — a budget not decided, articles to look at, the worst errors with their way to a
      // correction, the strategy's to-dos for the client, a step waiting on credits or one that failed. A to-do list, never a log.
      needsYou,
      signalsSupported: Boolean(this.signals),
      overview: {
        metrics,
        week,
        steps,
      },
    };
  }

  /**
   * The project's to-dos (`geoNeedsYou`), or none where they cannot be read: it decorates the page, it is not the page.
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project
   */
  async #needsYou(project) {
    try {
      const spine = await this.spine.load(project);
      return this.spine.needsYou(spine, { canReview: project.access ? project.access.abilities.includes("review") : true });
    } catch {
      return [];
    }
  }

  /**
   * Why the project's cards cannot be written now (geoCards.mjs `blockedBy`), or null. It decorates the page: a failure to ask is not a
   * failure to show the project.
   * @param {any} project @returns {Promise<"producer" | "reviewer" | null>}
   */
  async #cardsBlockedBy(project) {
    try { return (await this.cards?.blockedBy?.(project)) ?? null; } catch { return null; }
  }

  /**
   * When each project's coverage window started: its first run's work (the
   * first claim written, round enqueued or run dispatched), else its creation.
   * @param {Array<{ id: string, createdAt: string | null }>} projects @returns {Promise<Map<string, string>>}
   */
  async #startedAt(projects) {
    /** @type {Map<string, string>} */
    const started = new Map();
    if (!projects.length) return started;
    const ids = projects.map((project) => project.id);
    const result = await this.store.query(`SELECT geo_project_id, min(at) AS at FROM (
        SELECT geo_project_id, min(created_at) AS at FROM evimed_geo.claims WHERE geo_project_id = ANY($1::text[]) GROUP BY geo_project_id
        UNION ALL SELECT geo_project_id, min(created_at) FROM evimed_geo.rounds WHERE geo_project_id = ANY($1::text[]) GROUP BY geo_project_id
        UNION ALL SELECT geo_project_id, min(created_at) FROM evimed_geo.schedule_marks WHERE geo_project_id = ANY($1::text[]) AND kind = 'run'
          GROUP BY geo_project_id
      ) firsts GROUP BY geo_project_id`, [ids]).catch(() => ({ rows: [] }));
    for (const row of result.rows) if (row.at) started.set(String(row.geo_project_id), /** @type {string} */ (iso(row.at)));
    for (const project of projects) if (!started.has(project.id) && project.createdAt) started.set(project.id, project.createdAt);
    return started;
  }

  /**
   * The answers behind each cell (ruling 8: every number traces to its
   * answers): the snapshots of the cell's own round the metric counted — the
   * metrics' own selection (`geoCellRows`), valid and refusal answers only —
   * at most {@link GEO_CELL_SNAPSHOT_LIMIT}. A cell with no row gets none.
   * @param {string} geoId @param {Array<{ cell: Record<string, any>, row: any }>} entries
   */
  async #attachSnapshotIds(geoId, entries) {
    for (const { cell, row } of entries) {
      if (!row) continue;
      cell.snapshotIds = [];
      cell.members = { exact: false, total: null, shown: 0, more: false, basis: "historical_unknown", unit: null };
    }
  }

  /** Shape existing views from one exact observation selection; historical stored readings remain explicitly historical.
   * @param {any} project @param {any} view @param {Awaited<ReturnType<typeof readGeoSelection>>} selected
   * @param {string} kind @param {any} input @param {any} [clusterContext] @returns {Promise<any>}
   */
  async #applySelection(project, view, selected, kind, input, clusterContext = /** @type {any} */ (null)) {
    const { scope, selection, computed } = selected;
    const filtered = geoScopeIsFiltered(scope) || Boolean(input?.selectionRef);
    const cell = (/** @type {string} */ metricId, /** @type {Record<string, any>} */ dimensions = {}, /** @type {any} */ old = null) => {
      const current = computed.cells.find((entry) => entry.metricId === metricId && entry.scope === (dimensions.scope ?? "project")
        && Object.entries({ pool: null, engine: null, groupId: null, arm: null, variant: null, rival: null, ...dimensions })
          .every(([key, value]) => key === "scope" || /** @type {any} */ (entry)[key] === value));
      if (!filtered && old && (old.methodVersion !== GEO_MEASUREMENT_METHOD_VERSION || old.value != null && (!current || current.status === "absent"))) {
        return { ...old, snapshotIds: [], members: { exact: false, total: null, shown: 0, more: false, basis: "historical_unknown", unit: null } };
      }
      return current ?? { ...GEO_ABSENT_CELL };
    };
    const answers = this.#selectionAnswers(selected);
    const round = selected.rounds[0];
    const roundView = round ? { id: String(round.id), kind: String(round.kind), sampleDate: rowDay(round, scope.timeZone) } : null;
    const measuredEngines = selection.engines.filter((engine) => answers.some((answer) => answer.engine === engine));
    const linklessEngines = measuredEngines.filter((engine) => answers.filter((answer) => answer.engine === engine)
      .every((answer) => !answer.citations.some((citation) => citation.url || citation.domain)));
    if (kind === "project") {
      view.overview.metrics = view.overview.metrics.map((/** @type {any} */ entry) => ({ ...entry,
        cell: cell(GEO_OVERVIEW_METRICS.find((definition) => definition.key === entry.key)?.metricId ?? "", {}, entry.cell) }));
    }
    if (kind === "diagnosis") {
      const errorData = await readGeoSelectionErrors(this.store, project, selected, { errorLimit: this.errorListLimit, ...input });
      const errors = errorData.rows.map(errorView);
      const scopeErrors = await readGeoSelectionErrors(this.store, project, selected, { errorLimit: 1 });
      view.scopeErrorSummary = scopeErrors.summary;
      view.errors = errors; view.byClaim = geoErrorsByClaim(errorData.claimRows.map(errorView));
      view.byClaimPage = { ...errorData.page, total: null, shown: view.byClaim.length, unit: "page_claims", partial: errorData.page.more || errorData.page.offset > 0 };
      view.activeErrorSummary = errorData.activeSummary; view.errorCounts = errorData.counts; view.errorSummary = errorData.summary; view.errorPage = errorData.page;
      view.errorFilters = errorData.filter;
      view.byEngine = selection.engines.map((engine) => {
        const old = view.byEngine.find((/** @type {any} */ entry) => entry.engine === engine);
        return { engine, ...Object.fromEntries(["mention", "accuracy", "citation", "retrieval"].map((key) => [key,
          cell(/** @type {any} */ (GEO_VIEW_METRIC_IDS)[key], { scope: "engine", engine }, old?.[key])])) };
      });
      view.byPool = (scope.pools.length ? scope.pools : GEO_POOLS).map((pool) => {
        const old = view.byPool.find((/** @type {any} */ entry) => entry.pool === pool);
        const poolRows = selected.rows.filter((row) => row.pool === pool && ["valid", "refusal"].includes(row.status));
        /** @type {Map<string, number>} */ const rivals = new Map();
        /** @type {Map<string, number>} */ const issues = new Map();
        for (const row of /** @type {any[]} */ (poolRows)) {
          for (const brand of row.observedBrands ?? row.facts?.brands ?? []) if (brand.competitor) rivals.set(brand.name, (rivals.get(brand.name) ?? 0) + (brand.count ?? 0));
          if (["omitted", "wrong_ours", "wrong_competitor"].includes(row.failureMode) && !(pool === "P4" && row.failureMode === "omitted")) {
            issues.set(row.failureMode, (issues.get(row.failureMode) ?? 0) + 1);
          }
        }
        return { pool, mention: cell(GEO_VIEW_METRIC_IDS.mention, { scope: "pool", pool }, old?.mention),
          topCompetitor: [...rivals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, mainIssue: failureModeWord([...issues].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) };
      });
      const eligible = /** @type {any[]} */ (computed.balance.deduped).filter((row) => ["valid", "refusal"].includes(row.status));
      /** @type {Record<string, string[]>} */ const modes = { omitted: [], correct: [], wrongOurs: [], wrongCompetitor: [], unknown: [], partial: [], refused: [] };
      for (const row of eligible) {
        const accuracy = row.assessmentFacts || row.facts ? geoAnswerAccuracy(row.assessmentFacts ?? row.facts) : "unknown";
        const key = accuracy === "wrong" ? row.failureMode === "wrong_competitor" ? "wrongCompetitor" : "wrongOurs" : row.status === "refusal" ? "refused"
          : !row.facts ? "unknown" : row.mentionsOurs !== true ? "omitted" : accuracy;
        modes[key].push(row.snapshotId);
      }
      view.failureModes = Object.fromEntries(Object.entries(modes).map(([key, ids]) => [key, { ...tallyCell(ids.length, eligible.length, ids.slice(0, GEO_CELL_SNAPSHOT_LIMIT)),
        members: { total: ids.length, shown: Math.min(ids.length, GEO_CELL_SNAPSHOT_LIMIT), more: ids.length > GEO_CELL_SNAPSHOT_LIMIT, exact: true, unit: "answers" } }]));
      const accuracy = cell(GEO_VIEW_METRIC_IDS.accuracy, {}, !selected.rows.some((member) => member.facts) && view.hardLines?.accuracy ? { ...view.hardLines.accuracy, methodVersion: null } : null);
      view.hardLines = { ...hardLines([], scopeErrors.live.map((row) => ({ id: row.id, status: row.status, severity: row.severity, citedSource: row.cited_source })),
        { accuracyCell: !selected.rows.length && accuracy.status === "absent" ? null : accuracy }), roundId: roundView?.id ?? null };
      view.round = roundView ? { ...roundView, surface: round.surface, planned: selection.counts.planned, done: selection.counts.returned, engines: selection.engines,
        measuredEngines, linklessEngines, unparsed: !filtered && !selected.rows.length ? view.round?.unparsed ?? null : selection.counts.unjudged,
        absent: selection.engines.filter((engine) => !measuredEngines.includes(engine)).map((engine) => ({ engine,
          reason: selection.exclusions.skippedEngines.some((entry) => entry.engine === engine) ? "paused" : view.round?.absent?.find((/** @type {any} */ entry) => entry.engine === engine)?.reason ?? "no_answer" })) } : null;
      view.more = view.more.map((/** @type {any} */ entry) => ({ ...entry,
        cell: cell(entry.metricId, { variant: entry.variant, rival: entry.rival }, entry.cell) }));
      if (filtered) view.noise = null;
    }
    if (kind === "sources") {
      const tally = tallySources(answers);
      view.sources = view.sources.map((/** @type {any} */ source) => {
        const counted = tally.get(source.domain.toLowerCase().replace(/^www\./u, ""));
        return { ...source, cited: Object.fromEntries(Object.entries(counted?.byEngine ?? {}).map(([engine, counts]) => [engine, counts.cited])),
          mentionsOurs: counted?.mentionsOurs ?? 0, wrongOurs: counted?.wrongOurs ?? 0,
          mentionsOursByEngine: Object.fromEntries(Object.entries(counted?.byEngine ?? {}).map(([engine, counts]) => [engine, counts.mentionsOurs])),
          wrongOursByEngine: Object.fromEntries(Object.entries(counted?.byEngine ?? {}).map(([engine, counts]) => [engine, counts.wrongOurs])) };
      });
      view.expectations = view.expectations.filter((/** @type {any} */ entry) => selection.engines.includes(entry.engine)).map((/** @type {any} */ entry) => ({ ...entry,
        retrieval: cell(GEO_VIEW_METRIC_IDS.retrieval, { scope: "engine", engine: entry.engine }, entry.retrieval) }));
      view.linklessEngines = linklessEngines;
      const domains = [...tally].map(([domain, counts]) => ({ domain, ...countsOf(answersCiting(answers, domain), domain),
        kind: view.sources.find((/** @type {any} */ source) => source.domain === domain)?.kind ?? "unknown", byEngine: counts.byEngine }));
      /** @type {Map<string, Set<string>>} */ const typeAnswers = new Map();
      for (const domain of domains) {
        const set = typeAnswers.get(domain.kind) ?? new Set();
        for (const answer of answersCiting(answers, domain.domain)) set.add(answer.id);
        typeAnswers.set(domain.kind, set);
      }
      view.summary = { domains, types: [...typeAnswers].map(([sourceKind, ids]) => ({ kind: sourceKind, citedAnswers: ids.size })),
        urls: domains.flatMap(({ domain }) => pagesCited(answersCiting(answers, domain), domain, { limit: Infinity }).pages.map((page) => ({ domain, ...page }))), unit: "answers" };
    }
    if (kind === "clusters") {
      const versions = new Set(selected.rounds.map((entry) => Number(entry.set_version)).filter(Boolean));
      if (!versions.size && selected.questions.length) versions.add(scope.questionVersion ?? Math.max(...selected.questions.map((question) => Number(question.set_version))));
      const groups = (await this.store.query(`SELECT * FROM evimed_geo.question_groups WHERE geo_project_id = $1 AND user_id = $2
        AND ($3::integer[] = '{}' OR set_version = ANY($3::integer[])) ORDER BY set_version, position, id`, [project.id, project.userId, [...versions]])).rows;
      const context = clusterContext ?? await this.#scopedClusterContext(project, selected, groups);
      const complete = this.spine.clusters(context.spine, context.derived);
      view.locked = complete.locked;
      view.errorWorkCoverage = { partial: context.errorPage.more, shown: context.errorPage.shown, total: context.errorPage.total };
      const completeById = new Map(complete.groups.map((group) => [group.id, group]));
      view.groups = groups.filter((group) => completeById.has(group.id) && (!scope.groupIds.length || scope.groupIds.includes(group.id)) && (!scope.pools.length || scope.pools.includes(group.pool))
        && (!scope.clientTags.length || selected.questions.some((question) => question.group_id === group.id))).map((group) => {
        const old = completeById.get(group.id);
        const questions = selected.questions.filter((question) => question.group_id === group.id);
        const members = answers.filter((answer) => questions.some((question) => question.id === answer.questionId));
        const legacy = context.legacyReadings.filter((entry) => entry.groupId === group.id && entry.metricId === "M-01" && entry.kind !== "post_publication").at(-1);
        const historicalMention = !filtered && !selected.rows.some((row) => row.facts) && legacy?.roundId === roundView?.id
          ? { ...geoGroupReading({ k: legacy.k, n: legacy.n }), roundId: legacy.roundId, date: legacy.date, coverage: legacy.coverage } : null;
        const mention = historicalMention ?? cell("M-01", { scope: "group", pool: group.pool, groupId: group.id });
        return { ...old, errors: context.errorSummary.byGroup[group.id] ?? { total: 0, open: 0, severe: 0 }, id: group.id, name: group.name, pool: group.pool, journeyStage: group.journey_stage, audience: group.audience,
          weight: num(group.weight), isControl: group.is_control, signal: group.signal, questionCount: questions.length,
          measuredCount: questions.filter((question) => question.is_measured && !question.retired_at).length, realCount: questions.filter((question) => question.kind === "real").length,
          realPhrasings: old?.realPhrasings ?? [], mention: historicalMention ? { ...mention, members: { exact: false, basis: "historical_unknown" } } : { ...geoGroupReading({ k: mention.numerator, n: mention.denominator }), snapshotIds: mention.snapshotIds, members: mention.members, roundId: roundView?.id ?? null, coverage: selection.coverage },
          byEngine: Object.fromEntries(selection.engines.map((engine) => { const matches = members.filter((answer) => answer.engine === engine);
            return [engine, { answered: matches.length, mentioned: matches.filter((answer) => answer.mentionsOurs).length, wrong: matches.filter((answer) => answer.wrongOurs).length }]; })),
          actions: old?.actions ?? { total: 0, byStatus: {} }, articles: old?.articles ?? { total: 0, byStatus: {} } };
      });
      view.engines = selection.engines; view.round = roundView; view.version = versions.size === 1 ? [...versions][0] : null;
    }
    if (kind === "monitoring") {
      const errors = await readGeoSelectionErrors(this.store, project, selected, { errorLimit: 50 });
      view.newErrors = errors.rows.map(errorView); view.errorPage = errors.page; view.errorSummary = errors.summary;
      view.activityScope = "project_history";
    }
    if (filtered && (kind === "project" || kind === "monitoring")) {
      const ordered = [...selected.rounds].sort((a, b) => rowDay(a, scope.timeZone).localeCompare(rowDay(b, scope.timeZone)) || String(a.id).localeCompare(String(b.id)));
      const readings = scope.from || scope.to ? geoDailyReadings(selected) : ordered.map((entry) => ({
        date: rowDay(entry, scope.timeZone), roundIds: [entry.id], version: entry.set_version == null ? null : Number(entry.set_version),
        result: selected.rounds.length === 1 ? selected.computed : computeGeoSelection(selected.rows.filter((row) => row.roundId === entry.id), selected.metricOptions) }));
      const history = (/** @type {string} */ metricId, /** @type {string | null} */ engine = null, /** @type {string | null} */ variant = null) => readings.map(({ date, roundIds, version, result }) => {
        const point = result.cells.find((candidate) => candidate.metricId === metricId && candidate.scope === (engine ? "engine" : "project") && candidate.engine === engine && candidate.variant === variant && !candidate.rival);
        return { date, roundId: roundIds.length === 1 ? roundIds[0] : null, roundIds, value: point?.value ?? null, n: point?.denominator ?? null, k: point?.numerator ?? null,
          members: point?.members ?? null, snapshotIds: point?.snapshotIds ?? [],
          methodVersion: GEO_MEASUREMENT_METHOD_VERSION, coverage: geoSelectionCoverage(/** @type {any[]} */ (engine ? result.balance.deduped : result.balance.rows), version, engine) };
      });
      if (kind === "project") view.overview.metrics = view.overview.metrics.map((/** @type {any} */ entry) => ({ ...entry,
        trend: history(GEO_OVERVIEW_METRICS.find((definition) => definition.key === entry.key)?.metricId ?? "") }));
      if (kind === "monitoring") {
        view.series = GEO_OVERVIEW_METRICS.map(({ key, metricId }) => ({ key, points: history(metricId) }));
        view.byEngine = selection.engines.map((engine) => ({ engine, points: history(GEO_VIEW_METRIC_IDS.mention, engine),
          metrics: engineMetricDescriptors().map(({ metricId, variant }) => ({ metricId, variant, points: history(metricId, engine, variant) })) }));
        view.arms = { pilot: [], control: [], netEffect: { ...GEO_ABSENT_CELL, reason: "observational_selection" } };
      }
    }
    if (kind === "monitoring") {
      // Rival rates and their paired own-brand cohorts are the selected V08 analysis,
      // including pool and frozen-registry eligibility. Do not overlay global rates.
      view.rivals = geoRivalMonitoringRows(presentGeoAnalysis(selected,
        { viewId: "V08", metricId: "M-16", timeGrain: "day" },
        { allRows: true, product: project.product, competitors: project.competitors }));
    }
    return { ...view, scope, selection, comparison: selected.comparison };
  }

  /** @param {Awaited<ReturnType<typeof readGeoSelection>>} selected */
  #selectionAnswers(selected) {
    return /** @type {any[]} */ (selected.computed.balance.deduped).filter((row) => row.status === "refusal" || row.status === "valid").map((row) => ({
      id: row.snapshotId, engine: row.engine, pool: row.pool ?? "none", questionId: row.questionId, askedAt: row.askedAt,
      citations: row.citations ?? [], mentionsOurs: Boolean(row.mentionsOurs), wrongOurs: row.failureMode === "wrong_ours" }));
  }

  /**
   * 「本周」: the week's few events, most urgent first, each with where it
   * leads. Facts only — every sentence restates a row.
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project
   */
  async #week(project) {
    const since = new Date(this.now().getTime() - WEEK_MS).toISOString();
    const [errors, stops, changed, rounds, publishable, published] = await Promise.all([
      this.store.query(`SELECT id, engine, statement, severity, first_snapshot_id, last_snapshot_id, created_at FROM evimed_geo.errors
        WHERE geo_project_id = $1 AND judgment_state='active' AND status <> 'closed' AND created_at >= $2 ORDER BY severity DESC NULLS LAST, created_at DESC LIMIT 3`, [project.id, since]),
      this.store.query(`SELECT id, title, updated_at FROM evimed_geo.articles WHERE geo_project_id = $1 AND safety = 'open' AND status <> 'withdrawn'
        ORDER BY updated_at DESC LIMIT 2`, [project.id]),
      // An outlet that changed a published text this week (the market's post-publication check).
      this.store.query(`SELECT o.id, a.title, min(e.at) AS at FROM evimed_geo.order_events e JOIN evimed_geo.orders o ON o.id = e.order_id
          LEFT JOIN evimed_geo.articles a ON a.id = o.article_id
        WHERE o.geo_project_id = $1 AND e.at >= $2 AND e.detail ->> 'reason' = 'text_changed'
        GROUP BY o.id, a.title ORDER BY min(e.at) DESC LIMIT 2`, [project.id, since]),
      // A round that heard no answer is no event of the week: it read 「每周复测完成，0 次提问」 (2026-10-25).
      this.store.query(`SELECT r.id, r.kind, r.done, r.finished_at FROM evimed_geo.rounds r WHERE r.geo_project_id = $1 AND r.status IN ('done', 'partial')
        AND r.finished_at >= $2 AND r.kind IN ('baseline', 'weekly', 'single_step', 'noise')
        AND EXISTS (SELECT 1 FROM evimed_geo.snapshots s WHERE s.round_id = r.id AND s.status IN ('valid', 'refusal'))
        ORDER BY r.finished_at DESC LIMIT 2`, [project.id, since]),
      this.store.query(`SELECT count(*)::integer AS n, max(updated_at) AS at FROM evimed_geo.articles WHERE geo_project_id = $1 AND status = 'publishable'
        AND updated_at >= $2`, [project.id, since]),
      this.store.query(`SELECT count(*)::integer AS n, max(updated_at) AS at FROM evimed_geo.orders WHERE geo_project_id = $1
        AND state IN ('published', 'verified', 'settled') AND updated_at >= $2`, [project.id, since]),
    ]);
    /** @type {Array<{ kind: string, text: string, tab: string, ref: Record<string, string> | null, at: string | null }>} */
    const items = [];
    for (const row of errors.rows) {
      items.push({ kind: "wrong_ours", text: `${spacedLabel(String(row.engine))}讲错：${clip(row.statement, 60)}`, tab: "diagnosis",
        // The line quotes the sentence the error was first seen as: it opens the answer that holds that sentence.
        ref: { errorId: String(row.id), ...(row.first_snapshot_id || row.last_snapshot_id ? { snapshotId: String(row.first_snapshot_id ?? row.last_snapshot_id) } : {}) },
        at: iso(row.created_at) });
    }
    for (const row of stops.rows) {
      items.push({ kind: "safety", text: `“${clip(row.title ?? "稿件", 30)}”有安全问题待确认`, tab: "content", ref: { articleId: String(row.id) },
        at: iso(row.updated_at) });
    }
    for (const row of changed.rows) {
      items.push({ kind: "safety", text: `“${clip(row.title ?? "稿件", 30)}”发布后被媒体改动`, tab: "distribution", ref: { orderId: String(row.id) },
        at: iso(row.at) });
    }
    for (const row of rounds.rows) {
      const label = /** @type {Record<string, string>} */ (GEO_ROUND_KIND_LABELS_ZH)[String(row.kind)] ?? "测量";
      items.push({ kind: "round", text: `${label}完成，${Number(row.done)} 次提问`, tab: row.kind === "noise" ? "monitoring" : "diagnosis",
        ref: { roundId: String(row.id) }, at: iso(row.finished_at) });
    }
    const readyCount = Number(publishable.rows[0]?.n ?? 0);
    if (readyCount) items.push({ kind: "articles", text: `${readyCount} 篇稿件可发布`, tab: "content", ref: null, at: iso(publishable.rows[0]?.at) });
    const publishedCount = Number(published.rows[0]?.n ?? 0);
    if (publishedCount) items.push({ kind: "orders", text: `${publishedCount} 篇稿件已发布`, tab: "distribution", ref: null, at: iso(published.rows[0]?.at) });
    return items.slice(0, WEEK_ITEMS);
  }

  /** `GET …/:id/evidence`. @param {{ id: string }} user @param {string} id */
  async evidence(user, id) { return this.evidenceOf(await this.requireProject(user, id)); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async evidenceOf(project) {
    const claims = await this.store.listClaims(project.id);
    const now = this.now();
    return {
      product: project.product,
      competitors: project.competitors,
      claims: claims.map((claim) => ({
        id: claim.id, statement: claim.statement, quote: claim.quote, sourceRef: claim.sourceRef, sourceLabel: claim.sourceLabel, sourceKind: claim.sourceKind,
        evidenceLevel: claim.evidenceLevel, population: claim.population, inLabel: claim.inLabel, verifiedAt: claim.verifiedAt,
        validUntil: claim.validUntil, status: claimStatusAt(claim, now),
      })),
    };
  }

  /** `GET …/:id/journey`. @param {{ id: string }} user @param {string} id */
  async journey(user, id) { return this.journeyOf(await this.requireProject(user, id)); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async journeyOf(project) {
    const latest = await this.store.latestJourney(project.id);
    const data = latest?.data ?? {};
    const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);
    return {
      version: latest?.version ?? null,
      decisions: list(data.decisions), valueContext: data.valueContext ?? {},
      subtypes: list(data.subtypes), personas: list(data.personas), stages: list(data.stages), careNodes: list(data.careNodes), files: list(data.files),
    };
  }

  /** @param {{ id: string }} user @param {string} id @param {Record<string, any>} data */
  async previewQuestions(user, id, data) {
    await this.requireProject(user, id, "edit");
    return geoQuestionImportPreview(data);
  }

  /** @param {{ id: string }} user @param {string} id @param {Record<string, any>} data */
  async saveQuestions(user, id, data) {
    const project = await this.requireProject(user, id, "edit");
    return geoRuntimeWrite({ store: this.store, project, what: "questions", body: { data } });
  }

  /** @param {{ id: string }} user @param {string} id @param {Record<string, any>} data */
  async startDiagnosis(user, id, data) {
    const project = await this.requireProject(user, id, "run");
    return geoStartDiagnosis(this.store, project, data, this.inclusion);
  }

  /** @param {{ id: string }} user @param {string} id @param {string} roundId @param {Record<string, any>} data */
  async recoverDiagnosis(user, id, roundId, data) {
    const project = await this.requireProject(user, id, "run");
    return geoRecoverDiagnosis(this.store, { ...project, actorId: user.id }, { ...data, roundId });
  }

  /** @param {{ id: string }} user @param {string} id @param {string} roundId @param {Record<string, any>} [page] */
  async diagnosisProgress(user, id, roundId, page = {}) {
    const project = await this.requireProject(user, id);
    return this.diagnosisProgressOf(project, roundId, page);
  }

  /** @param {any} project @param {string} roundId @param {Record<string, any>} [input] */
  async diagnosisProgressOf(project, roundId, input = {}) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.diagnosisProgressOf(project, roundId, input));
    const limit = input.limit ?? 100, offset = input.offset ?? 0;
    if (Object.keys(input).some((key) => !["limit", "offset"].includes(key)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw failure(400, "geo_read_filter_invalid", "Progress takes limit 1–500 and offset 0–100000.");
    const round = (await this.store.query(`SELECT id, status, set_version, engines, planned, surface, ref FROM evimed_geo.rounds WHERE id=$1 AND geo_project_id=$2 AND user_id=$3`, [roundId, project.id, project.userId])).rows[0];
    if (!round) throw failure(404, "geo_round_not_found", "Diagnosis not found.");
    // A cell an earlier recovery still holds is not recoverable; one whose recovery provably never reached the provider is again.
    const recoveredIds = (await this.store.query(`SELECT ref->'recoveredJobIds' AS ids FROM evimed_geo.rounds WHERE geo_project_id=$1 AND user_id=$2 AND ref->>'recoveryOf'=$3`, [project.id, project.userId, round.id])).rows.flatMap((row) => row.ids ?? []);
    const recovered = [...await geoRecoveryHeldCells(this.store, project.id, String(round.id), [...new Set(recoveredIds.map(String))])];
    const recoverableRound = round.surface?.measurementContract?.samplingMode === "one_shot" && !round.ref?.recoveryOf;
    // `deliveryUnknown` is every cell a recovery may pay for again (`geoRecoveryMayCharge`): the acknowledgement the page asks for.
    const stats = (await this.store.query(`SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE j.status='queued')::integer AS queued, count(*) FILTER (WHERE j.status='leased')::integer AS leased,
      count(*) FILTER (WHERE j.status='done')::integer AS done, count(*) FILTER (WHERE j.status='failed')::integer AS failed,
      count(*) FILTER (WHERE j.status='skipped')::integer AS skipped,
      count(*) FILTER (WHERE j.status IN ('failed','skipped') AND (j.error_code IN ('delivery_unknown_no_automatic_retry','inclusion_hold_expired') OR j.external_ref IS NOT NULL))::integer AS delivery_unknown,
      count(*) FILTER (WHERE $3::boolean AND j.status IN ('failed','skipped') AND NOT(j.id=ANY($4::text[]))
        AND NOT EXISTS (SELECT 1 FROM evimed_geo.snapshots s WHERE s.probe_job_id=j.id AND s.status IN ('valid','refusal')))::integer AS recoverable,
      array_agg(DISTINCT j.engine) AS observed_engines FROM evimed_geo.probe_jobs j WHERE j.round_id=$1 AND j.geo_project_id=$2`,
    [roundId, project.id, recoverableRound, recovered])).rows[0];
    const jobs = (await this.store.query(`SELECT j.id, j.question_id, j.engine, j.status, j.attempts, j.error_code, j.external_ref, j.snapshot_id, s.status AS answer_status,
      EXISTS (SELECT 1 FROM evimed_geo.snapshots preserved WHERE preserved.probe_job_id=j.id AND preserved.status IN ('valid','refusal')) AS has_preserved_answer,
      q.text, q.original_id, q.original_group FROM evimed_geo.probe_jobs j JOIN evimed_geo.questions q ON q.id=j.question_id AND q.geo_project_id=j.geo_project_id
      LEFT JOIN evimed_geo.snapshots s ON s.id=j.snapshot_id WHERE j.round_id=$1 AND j.geo_project_id=$2 ORDER BY j.created_at,j.id LIMIT $3 OFFSET $4`, [roundId, project.id, limit, offset])).rows;
    const total = Number(stats.total), nextOffset = offset + jobs.length < total ? offset + jobs.length : null;
    return { roundId: round.id, status: round.status, version: Number(round.set_version), planned: Number(round.planned), contract: round.surface?.measurementContract ?? null,
      recoveryOf: round.ref?.recoveryOf ?? null, absentEngines: round.engines.filter((/** @type {string} */ engine) => !(stats.observed_engines ?? []).includes(engine)),
      total, counts: { total, queued: Number(stats.queued), leased: Number(stats.leased), done: Number(stats.done), failed: Number(stats.failed), skipped: Number(stats.skipped),
        deliveryUnknown: Number(stats.delivery_unknown), recoverable: Number(stats.recoverable) },
      page: { limit, offset, total, shown: jobs.length, more: nextOffset != null, nextOffset },
      cells: jobs.map((job) => ({ jobId: job.id, questionId: job.question_id, text: job.text, originalId: job.original_id, originalGroup: job.original_group,
        engine: job.engine, status: job.status, answerStatus: job.answer_status ?? null, attempts: Number(job.attempts), errorCode: job.error_code ?? null,
        snapshotId: job.snapshot_id ?? null, deliveryUnknown: ["failed", "skipped"].includes(job.status) && geoRecoveryMayCharge(job), recoverable: recoverableRound && !recovered.includes(job.id) && !job.has_preserved_answer && ["failed", "skipped"].includes(job.status) })) };
  }

  /**
   * `GET …/:id/questions?version=`: the named set version, the latest by default.
   * @param {{ id: string }} user @param {string} id @param {number | Record<string, any> | null} version
   */
  async questions(user, id, version = null) {
    const project = await this.requireProject(user, id);
    return version && typeof version === "object" ? this.scopedQuestionsOf(project, version) : this.questionsOf(project, /** @type {number | null} */ (version));
  }

  /** Question rows share the exact selection used by every analysis view, including planned cells without answers.
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {Record<string, any>} scope */
  async scopedQuestionsOf(project, scope) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.scopedQuestionsOf(project, scope));
    const selected = await readGeoSelection(this.store, project, scope);
    const versions = [...new Set(selected.questions.map((question) => Number(question.set_version)))];
    const views = await Promise.all(versions.map((version) => this.questionsOf(project, version)));
    const ids = new Set(selected.questions.map((question) => String(question.id)));
    const groups = views.flatMap((view) => view.groups.map((group) => ({ ...group, version: view.version,
      questions: group.questions.filter((question) => ids.has(question.id)).map((question) => ({ ...question,
        answers: [...new Map(selected.rows.filter((row) => row.questionId === question.id && ["valid", "refusal"].includes(row.status))
          .sort((a, b) => String(a.askedAt ?? "").localeCompare(String(b.askedAt ?? "")) || a.snapshotId.localeCompare(b.snapshotId))
          .map((row) => [row.engine, { engine: row.engine, snapshotId: row.snapshotId }])).values()] })) })).filter((group) => group.questions.length));
    return { sets: views[0]?.sets ?? await this.store.questionSets(project.id), version: versions.length === 1 ? versions[0] : null,
      contract: views.length === 1 ? views[0].contract : null, groups,
      scope: selected.scope, selection: selected.selection, comparison: selected.comparison };
  }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {number | null} version */
  async questionsOf(project, version = null) {
    const sets = await this.store.questionSets(project.id);
    const chosen = version ?? sets[0]?.version ?? null;
    if (version != null && !sets.some((set) => set.version === version)) throw failure(404, "geo_version_invalid", "No such question set version.");
    const groups = chosen == null ? [] : await this.store.questionMap(project.id, chosen);
    const answers = await this.#latestAnswers(project, groups.flatMap((group) => group.questions.filter((question) => question.isMeasured).map((question) => question.text)), sets.find((set) => set.version === chosen)?.contract ? chosen : null);
    return {
      sets: sets.map(({ version: setVersion, lockedAt, measuredCount, contract }) => ({ version: setVersion, lockedAt, measuredCount, contract })),
      contract: sets.find((set) => set.version === chosen)?.contract ?? null,
      version: chosen,
      groups: groups.map((group) => ({
        id: group.id, pool: group.pool, name: group.name, typicalQuestion: group.typicalQuestion, journeyStage: group.journeyStage,
        valueContext: group.valueContext, audience: group.audience, weight: group.weight, isControl: group.isControl, signal: group.signal,
        questions: group.questions.map((question) => ({
          id: question.id, text: question.text, kind: question.kind, platform: question.platform, sourceUrl: question.sourceUrl,
          originalRowIndex: question.originalRowIndex, originalId: question.originalId, originalGroup: question.originalGroup, clientTags: question.clientTags, classificationStatus: question.classificationStatus,
          collectedAt: question.collectedAt, pool: question.pool,
          isMeasured: question.isMeasured,
          // Where the question was last answered, one answer per engine, in the project's engine order: a measured question opens
          // on its answer; one that was never answered has none.
          answers: question.isMeasured ? answers.get(sets.find((set) => set.version === chosen)?.contract ? question.id : question.text.trim()) ?? [] : [],
        })),
      })),
    };
  }

  /**
   * The latest valid or refusal answer of each engine to each of these question texts, from full measurements. Matched by the
   * question's text, not its id: taking a question out of measurement writes a new set version whose questions are new rows, and
   * an id match would lose every answer link after one edit. The engines come in the project's order (the first is where a link
   * lands); an engine the project no longer lists follows.
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {string[]} texts
   * @param {number | null} [version] Imported question versions only link to their own observations.
   * @returns {Promise<Map<string, Array<{ engine: string, snapshotId: string }>>>}
   */
  async #latestAnswers(project, texts, version = null) {
    /** @type {Map<string, Array<{ engine: string, snapshotId: string }>>} */
    const byText = new Map();
    const wanted = [...new Set(texts.map((value) => value.trim()).filter(Boolean))];
    if (!wanted.length) return byText;
    const rows = (await this.store.query(`SELECT DISTINCT ON (CASE WHEN $4::integer IS NULL THEN btrim(q.text) ELSE q.id END, s.engine) CASE WHEN $4::integer IS NULL THEN btrim(q.text) ELSE q.id END AS text, s.engine, s.id
      FROM evimed_geo.snapshots s JOIN evimed_geo.rounds r ON r.id = s.round_id AND r.kind = ANY($3::text[])
        JOIN evimed_geo.questions q ON q.id = s.question_id AND q.geo_project_id = s.geo_project_id
      WHERE s.geo_project_id = $1 AND s.status IN ('valid', 'refusal') AND ($4::integer IS NOT NULL OR btrim(q.text) = ANY($2::text[])) AND ($4::integer IS NULL OR q.set_version = $4)
      ORDER BY CASE WHEN $4::integer IS NULL THEN btrim(q.text) ELSE q.id END, s.engine, s.asked_at DESC NULLS LAST, s.id DESC`, [project.id, wanted, [...GEO_HEADLINE_ROUND_KINDS], version])).rows;
    const order = (/** @type {string} */ engine) => {
      const index = project.engines.indexOf(engine);
      return index === -1 ? project.engines.length : index;
    };
    for (const row of rows) {
      const list = byText.get(String(row.text)) ?? [];
      list.push({ engine: String(row.engine), snapshotId: String(row.id) });
      byText.set(String(row.text), list);
    }
    for (const list of byText.values()) list.sort((left, right) => order(left.engine) - order(right.engine) || left.engine.localeCompare(right.engine));
    return byText;
  }

  /** `POST …/:id/questions/:qid/unmeasure`. @param {{ id: string }} user @param {string} id @param {string} questionId */
  async unmeasureQuestion(user, id, questionId) {
    const project = await this.requireProject(user, id, "edit");
    const minimal = geoProgramMinimal(project.steps);
    const written = await this.store.unmeasureQuestion(project.userId, project.id, questionId, {
      check: (groups) => geoLockCheck(groups, minimal).refusals.map((issue) => issue.message),
    });
    if (!written) throw failure(404, "geo_question_not_found", "Question not found.");
    if ("stale" in written) throw failure(409, "geo_question_not_current", "Only a question of the latest question set can be taken out of measurement.");
    if ("refused" in written) throw failure(409, "geo_question_set_invalid", `Without this question the set could not be measured: ${written.refused.join(" ")}`);
    return written;
  }

  /**
   * How many errors the project has by status, and how many of the live ones are severe (S3/S4) — `count(*)` over the table, so a
   * project with more errors than the list carries is still counted whole.
   * @param {string} geoId
   */
  async #errorCounts(geoId) {
    const rows = (await this.store.query(`SELECT status, judgment_state, severity, count(*)::integer AS n FROM evimed_geo.errors WHERE geo_project_id = $1
      GROUP BY status, judgment_state, severity`, [geoId])).rows;
    const counts = { total: 0, open: 0, acting: 0, awaiting_remeasure: 0, closed: 0, severe: 0, withdrawn: 0 };
    for (const row of rows) {
      const n = Number(row.n);
      const status = String(row.status);
      counts.total += n;
      if (row.judgment_state === "withdrawn") { counts.withdrawn += n; continue; }
      if (status in counts) counts[/** @type {"open" | "acting" | "awaiting_remeasure" | "closed"} */ (status)] += n;
      if (status !== "closed" && GEO_URGENT_SEVERITIES.includes(String(row.severity))) counts.severe += n;
    }
    return counts;
  }

  /** @param {string} geoId @param {string | null} roundId */
  async #round(geoId, roundId) {
    if (roundId) {
      const row = (await this.store.query(`SELECT * FROM evimed_geo.rounds WHERE geo_project_id = $1 AND id = $2`, [geoId, roundId])).rows[0];
      if (!row) throw failure(404, "geo_round_not_found", "Round not found.");
      return row;
    }
    // One resolver for "the latest measurement": a finished full round that heard an answer, by when it finished — the same one the
    // sources page reads — and only when none has finished, the newest one begun.
    return (await this.store.query(`SELECT * FROM evimed_geo.rounds r WHERE r.geo_project_id = $1 AND r.kind = ANY($2::text[])
        AND (r.status NOT IN ('done', 'partial') OR ${GEO_ROUND_ANSWERED("r")})
      ORDER BY (r.status IN ('done', 'partial')) DESC, CASE WHEN r.status IN ('done', 'partial') THEN r.finished_at END DESC NULLS LAST, r.created_at DESC LIMIT 1`, [geoId, [...DIAGNOSIS_ROUND_KINDS]])).rows[0] ?? null;
  }

  /** @param {{ id: string }} user @param {string} id @param {string} snapshotId */
  async readDiagnosisReview(user, id, snapshotId, page = {}) {
    const project = await this.requireProject(user, id);
    if (!this.diagnosisReview) throw failure(503, "geo_review_unavailable", "Judgment review is unavailable.");
    return this.diagnosisReview.read(project, snapshotId, page);
  }

  /** @param {{ id: string }} user @param {string} id @param {any} input */
  async submitDiagnosisFeedback(user, id, input) {
    const project = await this.requireProject(user, id, "edit");
    await this.requireProject(user, id, "run");
    if (!this.diagnosisReview) throw failure(503, "geo_review_unavailable", "Judgment review is unavailable.");
    return this.diagnosisReview.submit({ ...project, actorId: user.id }, input);
  }

  /**
   * `GET …/:id/diagnosis?round=`.
   * @param {{ id: string }} user @param {string} id @param {any} scope
   */
  async diagnosis(user, id, scope = null) { return this.diagnosisOf(await this.requireProject(user, id), scope); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {any} scope */
  async diagnosisOf(project, scope = null) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.diagnosisOf(project, scope));
    const selected = await readGeoSelection(this.store, project, scope);
    const view = await this.#diagnosisBase(project, selected.rounds[0]?.id ?? null);
    return this.#applySelection(project, view, selected, "diagnosis", scope);
  }

  /** @param {any} project @param {string | null} [roundId] */
  async #diagnosisBase(project, roundId = null) {
    const round = await this.#round(project.id, roundId);
    const rounds = (await this.store.query(`SELECT id, kind, sample_date, created_at FROM evimed_geo.rounds WHERE geo_project_id = $1
      AND kind = ANY($2::text[]) ORDER BY created_at DESC LIMIT 20`, [project.id, [...DIAGNOSIS_ROUND_KINDS]])).rows;
    const [errorRows, errorCounts, openErrors] = await Promise.all([
      this.store.query(`SELECT * FROM evimed_geo.errors WHERE geo_project_id = $1
        ORDER BY (status = 'closed'), severity DESC NULLS LAST, updated_at DESC LIMIT $2`, [project.id, this.errorListLimit]),
      this.#errorCounts(project.id),
      // Every live error, not the page of them: the hard line reads all of them.
      this.store.query(`SELECT id, status, severity, cited_source FROM evimed_geo.errors WHERE geo_project_id = $1 AND judgment_state='active' AND status <> 'closed'`, [project.id]),
    ]);
    const errors = errorRows.rows.map(errorView);
    const noiseRow = (await this.store.query(`SELECT value, computed_at FROM evimed_geo.metrics WHERE geo_project_id = $1 AND scope = 'project'
      AND metric_id = $2 AND variant = $3 ORDER BY computed_at DESC LIMIT 1`, [project.id, GEO_VIEW_METRIC_IDS.noiseBand, NOISE_BAND_OF])).rows[0];
    const engines = round && Array.isArray(round.engines) && round.engines.length ? round.engines.map(String) : project.engines;
    /** @type {Map<string, any>} */
    const cells = new Map();
    /** @type {Record<string, any>} */
    let failureModes = { omitted: tallyCell(0, 0, []), correct: tallyCell(0, 0, []), wrongOurs: tallyCell(0, 0, []), wrongCompetitor: tallyCell(0, 0, []),
      unknown: tallyCell(0, 0, []), partial: tallyCell(0, 0, []), refused: tallyCell(0, 0, []) };
    /** @type {Array<{ cell: Record<string, any>, row: any }>} */
    const traced = [];
    /** @type {Map<string, { competitor: string | null, issue: string | null }>} */
    const pools = new Map();
    /** @type {any[]} */
    let more = [];
    if (round) {
      const rows = (await this.store.query(`SELECT DISTINCT ON (m.scope, coalesce(m.pool, ''), coalesce(m.engine, ''), m.metric_id,
          coalesce(m.variant, ''), coalesce(m.rival, '')) *
        FROM evimed_geo.metrics m WHERE m.geo_project_id = $1 AND m.round_id = $2 AND m.scope IN ('project', 'engine', 'pool')
          AND m.group_id IS NULL AND m.arm IS NULL
        ORDER BY m.scope, coalesce(m.pool, ''), coalesce(m.engine, ''), m.metric_id, coalesce(m.variant, ''), coalesce(m.rival, ''), m.computed_at DESC`,
      [project.id, round.id])).rows;
      for (const row of rows) {
        if (row.variant == null && row.rival == null) cells.set(`${row.scope}\u0000${row.pool ?? ""}\u0000${row.engine ?? ""}\u0000${row.metric_id}`, row);
      }
      /** @type {Set<string>} */
      const hidden = new Set([...GEO_OVERVIEW_METRICS.map((entry) => entry.metricId), GEO_VIEW_METRIC_IDS.netEffect, GEO_VIEW_METRIC_IDS.noiseBand]);
      /** @type {Set<string>} */
      const bookkeeping = new Set([GEO_VIEW_METRIC_IDS.netEffect, GEO_VIEW_METRIC_IDS.noiseBand]);
      more = rows.filter((row) => row.scope === "project" && !bookkeeping.has(String(row.metric_id))
        && !(hidden.has(String(row.metric_id)) && row.variant == null && row.rival == null))
        .map((row) => {
          const entry = { metricId: String(row.metric_id), name: this.metricName(String(row.metric_id)), variant: text(row.variant), rival: text(row.rival),
            cell: geoCellFromRow(row) };
          traced.push({ cell: entry.cell, row });
          return entry;
        });
      // Re-read judgment eligibility with the same domain rule as accuracy. Historical labels alone do not prove completeness.
      const modes = (await this.store.query(`SELECT f.failure_mode, f.judged_at, f.statements, f.checks, f.mentions_ours,
          f.snapshot_id IS NOT NULL AS has_facts, s.id, s.status FROM evimed_geo.snapshots s
        LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id
        WHERE s.round_id = $1 AND s.geo_project_id = $2 AND s.status IN ('valid', 'refusal') ORDER BY s.asked_at NULLS LAST, s.id LIMIT 20000`,
      [round.id, project.id])).rows;
      /** @type {Map<string, string[]>} */
      const byMode = new Map();
      for (const row of modes) {
        const accuracy = geoAnswerAccuracy({ statements: row.statements ?? [], checks: row.checks ?? {}, judgedAt: iso(row.judged_at) });
        const key = accuracy === "wrong" ? row.failure_mode === "wrong_competitor" ? "wrong_competitor" : "wrong_ours"
          : row.status === "refusal" ? "refused" : !row.has_facts || row.judged_at == null ? "unknown"
            : row.mentions_ours !== true ? "omitted" : accuracy;
        const list = byMode.get(key) ?? [];
        list.push(String(row.id));
        byMode.set(key, list);
      }
      const mode = (/** @type {string} */ key) => tallyCell(byMode.get(key)?.length ?? 0, modes.length, byMode.get(key) ?? []);
      failureModes = { omitted: mode("omitted"), correct: mode("correct"), wrongOurs: mode("wrong_ours"), wrongCompetitor: mode("wrong_competitor"),
        unknown: mode("unknown"), partial: mode("partial"), refused: mode("refused") };
      const competitors = (await this.store.query(`SELECT DISTINCT ON (q.pool) q.pool, brand.value ->> 'name' AS name,
          sum(coalesce((brand.value ->> 'count')::integer, 1)) AS n
        FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id = f.snapshot_id JOIN evimed_geo.questions q ON q.id = s.question_id
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(f.brands) = 'array' THEN f.brands ELSE '[]'::jsonb END) AS brand(value)
        WHERE s.round_id = $1 AND s.geo_project_id = $2 AND s.status IN ('valid', 'refusal') AND (brand.value ->> 'competitor') = 'true'
        GROUP BY q.pool, brand.value ->> 'name' ORDER BY q.pool, n DESC, name`, [round.id, project.id])).rows;
      const issues = (await this.store.query(`SELECT DISTINCT ON (q.pool) q.pool, f.failure_mode, count(*)::integer AS n
        FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id = f.snapshot_id JOIN evimed_geo.questions q ON q.id = s.question_id
        WHERE s.round_id = $1 AND s.geo_project_id = $2 AND s.status IN ('valid', 'refusal')
          AND f.failure_mode IN ('omitted', 'wrong_ours', 'wrong_competitor')
          -- Not being named on a risk question is the aim, not the issue (G19).
          AND NOT (q.pool = 'P4' AND f.failure_mode = 'omitted')
        GROUP BY q.pool, f.failure_mode ORDER BY q.pool, n DESC, f.failure_mode`, [round.id, project.id])).rows;
      for (const pool of GEO_POOLS) {
        pools.set(pool, {
          competitor: text(competitors.find((/** @type {any} */ row) => row.pool === pool)?.name),
          issue: text(issues.find((/** @type {any} */ row) => row.pool === pool)?.failure_mode),
        });
      }
    }
    const cell = (/** @type {string} */ scope, /** @type {string} */ pool, /** @type {string} */ engine, /** @type {string} */ metricId) => {
      const row = cells.get(`${scope}\u0000${pool}\u0000${engine}\u0000${metricId}`);
      const value = geoCellFromRow(row);
      traced.push({ cell: value, row });
      return value;
    };
    const byEngine = engines.map((engine) => ({
      engine,
      mention: cell("engine", "", engine, GEO_VIEW_METRIC_IDS.mention),
      accuracy: cell("engine", "", engine, GEO_VIEW_METRIC_IDS.accuracy),
      citation: cell("engine", "", engine, GEO_VIEW_METRIC_IDS.citation),
      retrieval: cell("engine", "", engine, GEO_VIEW_METRIC_IDS.retrieval),
    }));
    const byPool = GEO_POOLS.map((pool) => ({
      pool, mention: cell("pool", pool, "", GEO_VIEW_METRIC_IDS.mention),
      topCompetitor: pools.get(pool)?.competitor ?? null,
      // The page's words, never the failure-mode code (「omitted」 reached the page on 2026-09-25).
      mainIssue: failureModeWord(pools.get(pool)?.issue ?? null),
    }));
    await this.#attachSnapshotIds(project.id, traced);
    const coverage = round ? { ...await this.#roundCoverage(round, engines), linklessEngines: await this.#linklessEngines(String(round.id)) }
      : { measuredEngines: [], absent: [], linklessEngines: [] };
    const accuracyRow = cells.get(`project\u0000\u0000\u0000${GEO_VIEW_METRIC_IDS.accuracy}`);
    const liveErrors = openErrors.rows.map((/** @type {any} */ row) => ({
      id: String(row.id), status: String(row.status), severity: text(row.severity), citedSource: row.cited_source && typeof row.cited_source === "object" ? row.cited_source : null,
    }));
    return {
      round: round ? {
        id: String(round.id), kind: String(round.kind), sampleDate: round.sample_date ? rowDay(round, this.timeZone) : null,
        surface: round.surface ?? null, planned: Number(round.planned), done: Number(round.done), engines, ...coverage,
        // Valid answers the round left out for want of a judgement (Q-11): neither counted nor read as saying nothing. Null for a round
        // measured before the count was kept.
        unparsed: Number.isInteger(round.ref?.balance?.denominators?.unparsed) ? Number(round.ref.balance.denominators.unparsed) : null,
      } : null,
      rounds: rounds.map((/** @type {any} */ row) => ({ id: String(row.id), kind: String(row.kind), sampleDate: row.sample_date ? rowDay(row, this.timeZone) : null })),
      byEngine,
      byPool,
      failureModes,
      errors,
      // The same errors one row per claim, with the engines that say it (a claim told by five engines is one row, not five); the rows
      // above keep their shape.
      byClaim: geoErrorsByClaim(errors),
      // Counted over every error of the project, not over the page of rows above: the list is capped, the counts are not.
      errorCounts,
      // The two hard lines (Q-5): accuracy (M-06) at or above the owner's line, read from the round's project cell only when it is a
      // measurement (a thin one is `null`, with its counts), and no open 讲错我方 traced to a cited source. The model's own errors are
      // listed apart and never block. `met` is null when nothing is missed and the accuracy cannot be read.
      hardLines: { ...hardLines([], liveErrors, { accuracyCell: /** @type {any} */ (accuracyRow ? geoCellFromRow(accuracyRow) : null) }), roundId: round ? String(round.id) : null },
      noise: noiseRow ? { band: num(noiseRow.value), measuredAt: iso(noiseRow.computed_at) } : null,
      more,
    };
  }

  /**
   * Which of a round's engines answered at all, and why each other one did
   * not (G13, 2026-09-26: the page said 「按 5 个引擎」 of a baseline 豆包
   * never answered, and 豆包's row said only 「未测」). The reason is a code
   * from the platform's own records, never the probe host's prose:
   * `login` — its answers were login pages (the sanity check's
   * `session_invalid`); `paused` — the breaker skipped its questions;
   * `unavailable` — this deployment has no channel for it; `no_answer` —
   * asked, and nothing came back that counts.
   * @param {any} round @param {string[]} engines
   */
  async #roundCoverage(round, engines) {
    const [answered, skipped, suspect] = await Promise.all([
      this.store.query(`SELECT engine, count(*)::integer AS n FROM evimed_geo.snapshots WHERE round_id = $1 AND status IN ('valid', 'refusal')
        GROUP BY engine`, [round.id]),
      this.store.query(`SELECT engine, error_code, count(*)::integer AS n FROM evimed_geo.probe_jobs WHERE round_id = $1 AND status = 'skipped'
        GROUP BY engine, error_code`, [round.id]),
      this.store.query(`SELECT DISTINCT engine FROM evimed_geo.snapshots WHERE round_id = $1 AND status = 'suspect'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(warnings) = 'array' THEN warnings ELSE '[]'::jsonb END) AS w(value)
          WHERE starts_with(w.value, 'sanity:session_invalid'))`, [round.id]),
    ]);
    const counts = new Map(answered.rows.map((/** @type {any} */ row) => [String(row.engine), Number(row.n)]));
    const login = new Set(suspect.rows.map((/** @type {any} */ row) => String(row.engine)));
    const codes = new Map();
    for (const row of skipped.rows) codes.set(String(row.engine), [...(codes.get(String(row.engine)) ?? []), String(row.error_code ?? "")]);
    const measuredEngines = engines.filter((engine) => (counts.get(engine) ?? 0) > 0);
    const absent = engines.filter((engine) => !measuredEngines.includes(engine)).map((engine) => ({
      engine,
      reason: login.has(engine) ? "login"
        : (codes.get(engine) ?? []).includes("engine_unavailable") ? "unavailable"
          : (codes.get(engine) ?? []).includes("engine_paused") ? "paused" : "no_answer",
    }));
    return { measuredEngines, absent };
  }

  /**
   * The engines of a round whose retrieval came back as titles without a
   * single link: whether they cited us cannot be told (G8, 千问 on 2026-09-25,
   * 1,021 of 1,021). The page says 「引用不可测」 for them rather than leaving
   * them out of the sources or showing a rate of zero.
   * @param {string} roundId @returns {Promise<string[]>}
   */
  async #linklessEngines(roundId) {
    const rows = (await this.store.query(`SELECT s.engine, count(*)::integer AS total,
        count(*) FILTER (WHERE coalesce(c.value ->> 'url', '') <> '' OR coalesce(c.value ->> 'domain', '') <> '')::integer AS linked
      FROM evimed_geo.snapshots s
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.citations) = 'array' THEN s.citations ELSE '[]'::jsonb END) AS c(value)
      WHERE s.round_id = $1 AND s.status IN ('valid', 'refusal') GROUP BY s.engine`, [roundId])).rows;
    return rows.filter((/** @type {any} */ row) => Number(row.total) > 0 && Number(row.linked) === 0).map((/** @type {any} */ row) => String(row.engine)).sort();
  }

  /**
   * `GET …/:id/answers/:snapshotId`: one answer with its question, the other
   * engines' answers to the same question in the same round, what was
   * extracted from it, its errors and its earlier dates.
   * @param {{ id: string }} user @param {string} id @param {string} snapshotId
   */
  async answer(user, id, snapshotId) {
    const project = await this.requireProject(user, id);
    const snapshot = (await this.store.query(`SELECT * FROM evimed_geo.snapshots WHERE geo_project_id = $1 AND id = $2`, [project.id, snapshotId])).rows[0];
    if (!snapshot) throw failure(404, "geo_snapshot_not_found", "Snapshot not found.");
    const [question, facts, siblings, errors, history] = await Promise.all([
      snapshot.question_id ? this.store.question(project.id, String(snapshot.question_id)) : null,
      this.store.query(`SELECT brands, statements, checks FROM evimed_geo.facts WHERE snapshot_id = $1`, [snapshot.id]),
      snapshot.round_id && snapshot.question_id
        ? this.store.query(`SELECT s.id, s.engine, s.status, f.snapshot_id AS judged, f.mentions_ours, f.cites_ours, f.statements,
              (SELECT r.engines FROM evimed_geo.rounds r WHERE r.id = s.round_id) AS round_engines
            FROM evimed_geo.snapshots s LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id
            WHERE s.geo_project_id = $1 AND s.round_id = $2 AND s.question_id = $3
            ORDER BY s.engine, s.asked_at DESC`, [project.id, snapshot.round_id, snapshot.question_id])
        : { rows: [] },
      this.store.query(`SELECT e.*,f.statements AS origin_statements,r.ref->'evaluationBasis'->'claims' AS origin_claims FROM evimed_geo.errors e
        LEFT JOIN evimed_geo.facts f ON f.snapshot_id=e.first_snapshot_id LEFT JOIN evimed_geo.snapshots original ON original.id=e.first_snapshot_id
        LEFT JOIN evimed_geo.rounds r ON r.id=original.round_id
        WHERE e.geo_project_id = $1 AND (e.first_snapshot_id = $2 OR e.last_snapshot_id = $2
          OR (e.question_id = $3 AND e.engine = $4)) ORDER BY e.severity DESC NULLS LAST, e.updated_at DESC LIMIT 20`,
      [project.id, snapshot.id, snapshot.question_id, snapshot.engine]),
      snapshot.question_id
        ? this.store.query(`SELECT s.id, s.asked_at, r.sample_date FROM evimed_geo.snapshots s LEFT JOIN evimed_geo.rounds r ON r.id = s.round_id
            WHERE s.geo_project_id = $1 AND s.question_id = $2 AND s.engine = $3 ORDER BY s.asked_at DESC NULLS LAST LIMIT 30`,
          [project.id, snapshot.question_id, snapshot.engine])
        : { rows: [] },
    ]);
    const factRow = facts.rows[0];
    return {
      question: question ? { id: question.id, text: question.text, pool: question.pool } : null,
      snapshot: {
        id: String(snapshot.id), engine: text(snapshot.engine), askedAt: iso(snapshot.asked_at), status: text(snapshot.status),
        answerText: text(snapshot.answer_text), citations: Array.isArray(snapshot.citations) ? snapshot.citations : [],
        surface: snapshot.surface ?? null, screenshot: Boolean(snapshot.screenshot_sha256),
        ...(snapshot.screenshot_sha256 ? { screenshotSha256: String(snapshot.screenshot_sha256) } : {}),
      },
      siblings: answerSiblings(siblings.rows),
      facts: {
        brands: Array.isArray(factRow?.brands) ? factRow.brands : [],
        statements: Array.isArray(factRow?.statements) ? factRow.statements : [],
        // Judged against the project's verified card claims, in order of importance: the specified information's accuracy (computed from
        // the verdicts in code), then a claim beyond the label, safety information left out, and what the cited links say.
        specifiedInfo: geoSpecifiedInfoAccuracy(Array.isArray(factRow?.statements) ? factRow.statements : []),
        checks: factRow?.checks && typeof factRow.checks === "object" && !Array.isArray(factRow.checks) ? factRow.checks : {},
      },
      errors: errors.rows.map(errorView),
      history: /** @type {any[]} */ (history.rows).map((row) => ({
        sampleDate: row.sample_date ? rowDay(row, this.timeZone) : (row.asked_at ? dayIn(new Date(row.asked_at), this.timeZone) : null),
        snapshotId: String(row.id),
      })),
    };
  }

  /**
   * The file a screenshot route serves, once the snapshot proves it is this
   * project's.
   * @param {{ id: string }} user @param {string} id @param {string} sha256
   */
  async screenshotPath(user, id, sha256) {
    const project = await this.requireProject(user, id);
    if (!SHA256.test(String(sha256))) throw failure(404, "geo_screenshot_not_found", "Screenshot not found.");
    const owned = (await this.store.query(`SELECT 1 FROM evimed_geo.snapshots WHERE geo_project_id = $1 AND screenshot_sha256 = $2 LIMIT 1`,
      [project.id, sha256])).rows.length > 0;
    if (!owned) throw failure(404, "geo_screenshot_not_found", "Screenshot not found.");
    return geoScreenshotPath(String(this.config.dataDir ?? ""), sha256);
  }

  /**
   * The rounds the sources are counted from, newest first: finished headline rounds (baseline, weekly, single step). The first is the
   * round `refreshSourceCitations` counts at its end, so a row and its detail speak of the same answers.
   * @param {string} geoId @param {number} [limit]
   */
  async #sourceRounds(geoId, limit = 1) {
    // Only rounds that heard an answer: an empty round (its engines paused, 2026-10-25) cited no site, and as the latest it would draw
    // every source at zero.
    return (await this.store.query(`SELECT r.id, r.kind, r.sample_date, r.finished_at FROM evimed_geo.rounds r WHERE r.geo_project_id = $1
      AND r.kind = ANY($2::text[]) AND r.status IN ('done', 'partial')
      AND EXISTS (SELECT 1 FROM evimed_geo.snapshots answered WHERE answered.round_id = r.id AND answered.status IN ('valid', 'refusal'))
      ORDER BY r.finished_at DESC NULLS LAST, r.created_at DESC LIMIT $3`, [geoId, [...GEO_HEADLINE_ROUND_KINDS], limit])).rows;
  }

  /** The newest of those, or null before there is one. @param {string} geoId */
  async #latestSourceRound(geoId) {
    return (await this.#sourceRounds(geoId, 1))[0] ?? null;
  }

  /**
   * `GET …/:id/sources/:sourceId[?engine=]`: what a source row stands for. The answers of the latest round that cite the site — the
   * answers the row's three numbers count — each with its question, its engine and date, whether it misstates us and whether it names
   * us; for a misstating answer, the wrong sentences, each marked when the engine's inline marker puts it on this site. Misstating
   * answers come first, then the ones that name us, then the rest. The counts are `tallySources` over those same answers.
   *
   * Two more reads on the same answers (R14 N-11): the specific pages of the site those answers cited (`pagesCited`: the address, its
   * title, how many answers cited it), and the same counts for the few rounds before this one (`history`, oldest first, the latest
   * last), each with the coverage key of its round (N-4) — the page compares two of them only when the keys are equal.
   * @param {{ id: string }} user @param {string} id @param {string} sourceId @param {any} [input]
   */
  async source(user, id, sourceId, input = {}) { return this.sourceOf(await this.requireProject(user, id), sourceId, input); }

  /** @param {any} project @param {string} sourceId @param {any} [input] */
  async sourceOf(project, sourceId, input = {}) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.sourceOf(project, sourceId, input));
    const answerPage = geoSourcePage(input);
    const selected = await readGeoSelection(this.store, project, input);
    const engine = selected.scope.engines.length === 1 ? selected.scope.engines[0] : null;
    const row = (await this.store.query(`SELECT * FROM evimed_geo.sources WHERE geo_project_id = $1 AND id = $2`, [project.id, sourceId])).rows[0];
    if (!row) throw failure(404, "geo_source_not_found", "Source not found.");
    const source = geoSourceFromRow(row);
    const domain = source.domain.toLowerCase();
    const historySelection = !selected.scope.round && !selected.scope.from && !selected.scope.to && !input.selectionRef
      ? await readGeoSelection(this.store, project, { ...selected.scope, compareFrom: null, compareTo: null }, { history: true, historyLimit: 6, persist: false }) : selected;
    const rounds = historySelection.rounds;
    const round = selected.rounds[0] ?? null;
    // Each round's answers are read once, and the latest round's are the list: the history's last point IS the detail's counts.
    const allAnswers = this.#selectionAnswers(historySelection);
    const roundBySnapshot = new Map(historySelection.rows.map((member) => [member.snapshotId, member.roundId]));
    /** @type {Map<string, typeof allAnswers>} */ const answersByRound = new Map();
    for (const answer of allAnswers) {
      const roundId = roundBySnapshot.get(answer.id);
      const batch = answersByRound.get(roundId) ?? [];
      batch.push(answer); answersByRound.set(roundId, batch);
    }
    const citingByRound = rounds.map((entry) => answersCiting(answersByRound.get(entry.id) ?? [], domain, engine));
    const citing = answersCiting(this.#selectionAnswers(selected), domain, engine);
    const sourceCoverage = (/** @type {any} */ entry) => {
      const observations = historySelection.rows.filter((member) => member.roundId === entry.id && (!engine || member.engine === engine) && ["valid", "refusal"].includes(member.status));
      const coverage = geoCoverageKey({ setVersion: entry.set_version == null ? null : Number(entry.set_version), pools: observations.map((member) => member.pool),
        engines: observations.map((member) => member.engine), surface: entry.surface });
      const questions = createHash("sha256").update(JSON.stringify([...new Set(observations.map((member) => member.questionId))].sort())).digest("hex").slice(0, 24);
      return coverage ? `${coverage};questions=${questions}` : null;
    };
    const cited = pagesCited(citing, domain, { limit: Infinity });
    const detail = new Map((citing.length === 0 ? [] : (await this.store.query(`SELECT s.id, q.text AS question_text,
        s.answer_text,
        CASE WHEN f.failure_mode = 'wrong_ours' THEN f.statements END AS statements
      FROM evimed_geo.snapshots s
        LEFT JOIN evimed_geo.facts f ON f.snapshot_id=s.id AND f.geo_project_id=s.geo_project_id AND f.user_id=s.user_id
        LEFT JOIN evimed_geo.questions q ON q.id=s.question_id AND q.geo_project_id=s.geo_project_id AND q.user_id=s.user_id
      WHERE s.geo_project_id=$1 AND s.user_id=$3 AND s.id=ANY($2::text[])`, [project.id, citing.map((answer) => answer.id),project.userId])).rows).map((/** @type {any} */ entry) => [String(entry.id), entry]));
    // Use the admitted snapshot facts only; an optional current assessment overlay cannot make an unjudged snapshot judged.
    const selectedFacts=new Map(selected.rows.map(member=>[member.snapshotId,member.facts??null]));
    const answers = citing.map((answer) => {
      const entry = detail.get(answer.id);
      const statements = Array.isArray(entry?.statements) ? entry.statements : [];
      const sentences = [...new Set(statements.filter((/** @type {any} */ statement) => statement?.verdict === "wrong" && typeof statement.text === "string")
        .map((/** @type {any} */ statement) => statement.text.trim()).filter(Boolean))];
      const view = { answerText: text(entry?.answer_text), citations: answer.citations };
      return {
        snapshotId: answer.id, engine: answer.engine, questionId: answer.questionId, question: text(entry?.question_text), askedAt: iso(answer.askedAt),
        answerText:text(entry?.answer_text), judgment:selectedFacts.get(answer.id)??null,
        mentionsOurs: answer.mentionsOurs, misstated: answer.wrongOurs,
        wrong: sentences.map((sentence) => ({ text: sentence, fromThisSite: sentenceSource(view, sentence, domain) })),
      };
    });
    const rank = (/** @type {typeof answers[number]} */ answer) => (answer.misstated ? (answer.wrong.some((sentence) => sentence.fromThisSite) ? 0 : 1) : answer.mentionsOurs ? 2 : 3);
    answers.sort((left, right) => rank(left) - rank(right) || String(right.askedAt ?? "").localeCompare(String(left.askedAt ?? "")) || left.engine.localeCompare(right.engine));
    return {
      source: {
        id: source.id, domain: source.domain, name: source.name, kind: source.kind, layer: source.layer,
        conditions: { icp: source.icpMatches, newsIndexed: source.newsIndexed, medical: source.medicalVertical },
        impostor: source.impostor,
        market: source.market ? { price: num(source.market.price ?? source.market.priceCny), resourceId: text(source.market.resourceId) } : null,
      },
      round: round ? { id: String(round.id), kind: String(round.kind), sampleDate: round.sample_date ? rowDay(round, this.timeZone) : null } : null,
      engine,
      scope: selected.scope, selection: selected.selection, comparison: selected.comparison,
      counts: countsOf(citing, domain),
      answers: answers.slice(answerPage.offset, answerPage.offset + answerPage.limit),
      answerPage: { ...answerPage, total: answers.length, shown: Math.max(0, Math.min(answers.length - answerPage.offset, answerPage.limit)),
        more: answerPage.offset + answerPage.limit < answers.length, nextOffset: answerPage.offset + answerPage.limit < answers.length ? answerPage.offset + answerPage.limit : null },
      pages: cited.pages,
      pagesTotal: cited.total,
      history: rounds.map((entry, index) => ({
        roundId: String(entry.id), kind: String(entry.kind), sampleDate: entry.sample_date ? rowDay(entry, this.timeZone) : null,
        coverage: sourceCoverage(entry), coverageBasis: "citation_observations", ...countsOf(citingByRound[index], domain),
      })).reverse(),
    };
  }

  /** `GET …/:id/sources`. @param {{ id: string }} user @param {string} id */
  async sources(user, id, scope = {}) { return this.sourcesOf(await this.requireProject(user, id), scope); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async sourcesOf(project, scope = {}) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.sourcesOf(project, scope));
    const selected = await readGeoSelection(this.store, project, scope);
    return this.#applySelection(project, await this.#sourcesBase(project), selected, "sources", scope);
  }

  /** @param {any} project */
  async #sourcesBase(project) {
    const [sources, strategy, targets, retrieval] = await Promise.all([
      this.store.listSources(project.id),
      this.store.latestStrategy(project.id),
      this.store.latestTargets(project.id),
      // Each engine's rate from the latest full measurement it was measured
      // in (G11): a sentinel's ten questions on two engines read 「样本不足」
      // for one and 「未测」 for the other, against the baseline's 99 % and 85 %.
      this.store.query(`SELECT DISTINCT ON (m.engine) m.* FROM evimed_geo.metrics m
          JOIN evimed_geo.rounds r ON r.id = m.round_id AND r.kind = ANY($3::text[])
        WHERE m.geo_project_id = $1 AND m.scope = 'engine' AND m.metric_id = $2 AND m.pool IS NULL AND m.arm IS NULL AND ${PLAIN_ROW}
          AND m.round_id = (SELECT latest.id FROM evimed_geo.rounds latest WHERE latest.geo_project_id = $1 AND latest.kind = ANY($3::text[])
              AND (latest.status NOT IN ('done', 'partial') OR ${GEO_ROUND_ANSWERED("latest")})
            ORDER BY (latest.status IN ('done', 'partial')) DESC, CASE WHEN latest.status IN ('done', 'partial') THEN latest.finished_at END DESC NULLS LAST, latest.created_at DESC, latest.id DESC LIMIT 1)
        ORDER BY m.engine, m.computed_at DESC`, [project.id, GEO_VIEW_METRIC_IDS.retrieval, [...GEO_HEADLINE_ROUND_KINDS]]),
    ]);
    const retrievalByEngine = new Map(retrieval.rows.map((/** @type {any} */ row) => [String(row.engine), row]));
    const stated = Array.isArray(strategy?.expectations) ? strategy.expectations.filter((/** @type {any} */ entry) => entry && typeof entry === "object") : [];
    const engines = [...new Set([...project.engines, ...stated.map((/** @type {any} */ entry) => String(entry.engine ?? "")).filter(Boolean)])];
    const battlefield = strategy?.battlefield && typeof strategy.battlefield === "object" ? strategy.battlefield : {};
    /** @type {Map<string, { tier: string, targets: any[], placements: number | null, budgetCny: number | null }>} */
    const tiers = new Map();
    for (const row of targets?.rows ?? []) {
      const tier = tiers.get(row.tier) ?? { tier: row.tier, targets: [], placements: null, budgetCny: null };
      tier.targets.push({ metricId: row.metricId, pool: row.pool, baseline: row.baseline, target: row.target });
      if (row.placements != null) tier.placements = Math.max(tier.placements ?? 0, row.placements);
      if (row.budgetCny != null) tier.budgetCny = Math.max(tier.budgetCny ?? 0, row.budgetCny);
      tiers.set(row.tier, tier);
    }
    const expectations = engines.map((engine) => {
      const entry = stated.find((/** @type {any} */ candidate) => candidate.engine === engine) ?? {};
      return {
        engine, retrieval: geoCellFromRow(retrievalByEngine.get(engine)), promise: text(entry.promise),
        layers: Array.isArray(entry.layers) ? entry.layers.filter((/** @type {unknown} */ layer) => typeof layer === "string") : [],
      };
    });
    await this.#attachSnapshotIds(project.id, expectations.map((entry) => ({ cell: entry.retrieval, row: retrievalByEngine.get(entry.engine) })));
    const latestFull = await this.#latestSourceRound(project.id);
    const linklessEngines = latestFull ? await this.#linklessEngines(String(latestFull.id)) : [];
    // The three numbers of a row are counted from the latest round's answers, the answers a source's detail lists (`geoSourceAnswers`).
    const tally = latestFull ? tallySources(await roundAnswers(this.store, String(latestFull.id))) : null;
    const groupNames = await this.#battlefieldNames(project.id, Array.isArray(battlefield.groups) ? battlefield.groups : []);
    return {
      linklessEngines,
      sources: sources.map((source) => {
        // Without a counted round (nothing measured yet) the counters the table holds are all there is.
        const counted = tally ? tally.get(source.domain.toLowerCase()) ?? null : undefined;
        const cited = counted === undefined ? source.cited : counted?.cited ?? {};
        const byEngine = counted?.byEngine ?? {};
        return {
          valueContext: source.valueContext, id: source.id, domain: source.domain, name: source.name, kind: source.kind, layer: source.layer,
          conditions: { icp: source.icpMatches, newsIndexed: source.newsIndexed, medical: source.medicalVertical },
          impostor: source.impostor,
          cited: Object.fromEntries(Object.entries(cited).map(([engine, pools]) => [engine,
            pools && typeof pools === "object" ? Object.values(pools).reduce((/** @type {number} */ sum, value) => sum + (Number(value) || 0), 0) : Number(pools) || 0])),
          mentionsOurs: counted === undefined ? source.mentionsOurs : counted?.mentionsOurs ?? 0,
          wrongOurs: counted === undefined ? source.wrongOurs : counted?.wrongOurs ?? 0,
          // The same two counts for one engine: the engine filter of the page narrows every column, and so does the detail it opens.
          mentionsOursByEngine: Object.fromEntries(Object.entries(byEngine).map(([engine, count]) => [engine, count.mentionsOurs])),
          wrongOursByEngine: Object.fromEntries(Object.entries(byEngine).map(([engine, count]) => [engine, count.wrongOurs])),
          market: source.market ? { price: num(source.market.price ?? source.market.priceCny), resourceId: text(source.market.resourceId) } : null,
        };
      }),
      expectations,
      // `groups` is what the run wrote (a group's id or its name — the orchestrator accepts both); `groupNames` is what a page prints.
      battlefield: { groups: Array.isArray(battlefield.groups) ? battlefield.groups : [], groupNames, reason: text(battlefield.reason) },
      tiers: [...tiers.values()].sort((left, right) => left.tier.localeCompare(right.tier)),
      chosenTier: project.tier,
    };
  }

  /**
   * The names of the main-battlefield question groups. A run writes a group's id (`ggr_…`) or its name; an id is looked up among the
   * project's groups of any set version (ids are never reused), a name stays as written, and an entry shaped like an id that matches
   * no group is dropped — a page never prints a bare identifier.
   * @param {string} geoId @param {unknown[]} entries @returns {Promise<string[]>}
   */
  async #battlefieldNames(geoId, entries) {
    const listed = entries.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => String(entry).trim());
    if (!listed.length) return [];
    const ids = listed.filter((entry) => GROUP_ID_SHAPE.test(entry));
    /** @type {Map<string, string>} */
    const names = new Map();
    if (ids.length) {
      const rows = (await this.store.query(`SELECT id, name FROM evimed_geo.question_groups WHERE geo_project_id = $1 AND id = ANY($2::text[])`,
        [geoId, ids])).rows;
      for (const row of rows) names.set(String(row.id), String(row.name));
    }
    const resolved = listed.map((entry) => (GROUP_ID_SHAPE.test(entry) ? names.get(entry) ?? null : entry)).filter((name) => name != null && name !== "");
    return [...new Set(/** @type {string[]} */ (resolved))];
  }

  /** `POST …/:id/tier`. @param {{ id: string }} user @param {string} id @param {string} tier */
  async setTier(user, id, tier) {
    const project = await this.requireProject(user, id, "edit");
    const updated = await this.store.updateProject(project.userId, id, { tier });
    return { id, tier: updated?.tier ?? tier };
  }

  /** `GET …/:id/articles`. @param {{ id: string }} user @param {string} id */
  async articles(user, id) { return this.articlesOf(await this.requireProject(user, id)); }

  /** Immutable business associations beside shared result versions. */
  async articleVersions(user, id, articleId) {
    const project = await this.requireProject(user, id);
    const article = await this.store.getArticle(project.id, articleId);
    if (!article) throw failure(404, "geo_article_not_found", "Article not found.");
    return { articleId, currentResultVersionId: article.currentResultVersionId,
      planningLinks: await this.planContexts?.outputLinks(project, articleId) ?? [],
      versions: await this.store.articleVersions(project.id, articleId) };
  }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async articlesOf(project) {
    const planningLinks = await this.planContexts?.outputLinks(project) ?? [];
    const articles = await this.store.listArticles(project.id);
    const [groups, placements, cited] = await Promise.all([
      this.store.query(`SELECT id, typical_question, is_control FROM evimed_geo.question_groups WHERE geo_project_id = $1`, [project.id]),
      this.store.query(`SELECT article_id, count(*)::integer AS n FROM evimed_geo.orders WHERE geo_project_id = $1
        AND state NOT IN ('planned', 'cancelled', 'rejected', 'refunded', 'lost') GROUP BY article_id`, [project.id]),
      this.store.citedArticles(project.id),
    ]);
    const questions = new Map(groups.rows.map((/** @type {any} */ row) => [String(row.id), text(row.typical_question)]));
    const controlGroups = new Set(groups.rows.filter((/** @type {any} */ row) => row.is_control === true).map((/** @type {any} */ row) => String(row.id)));
    const counts = new Map(placements.rows.map((/** @type {any} */ row) => [String(row.article_id), Number(row.n)]));
    const citedIds = new Set(cited.map((row) => row.articleId));
    // The articles that cite a claim of a card revision since corrected or withdrawn: a notice on the page (「被引结论已更新」),
    // read from the zone's change log. A log that cannot be read flags nothing and withholds nothing.
    const stale = await this.cards?.staleReferences?.(project, articles).catch(() => null) ?? new Map();
    return {
      articles: articles.map((article) => ({
        planningLinks: planningLinks.filter(link => link.articleId === article.id && link.resultVersionId === article.currentResultVersionId),
        valueContext: article.valueContext, id: article.id, layer: article.layer, title: article.title, groupId: article.groupId,
        // Where it is to be published and for whom, as the run said it: a closed word, or the run's own words as a note.
        channel: article.channel, channelNote: article.channelNote, audience: article.audience, audienceNote: article.audienceNote,
        question: article.groupId ? questions.get(article.groupId) ?? null : null,
        // Written for a control group: it is out of the control arm, and the platform never places for it (said once when registered).
        groupIsControl: Boolean(article.groupId && controlGroups.has(article.groupId)),
        status: article.status, gate: article.gate, currentResultVersionId: article.currentResultVersionId, onlineUpdateNeeded: article.onlineUpdateNeeded,
        safety: article.safety, contentSha256: article.contentSha256, path: article.path, runId: article.runId, claimCount: article.claimIds.length,
        placements: counts.get(article.id) ?? 0, cited: citedIds.has(article.id),
        // The evidence chain: the card a card-layer article is made from, whether the claim references the platform read in the
        // text resolve, the references a card's change log says moved since, and the label a paid placement carries.
        cardId: article.cardId, cardRevision: article.cardRevision, referenceStatus: article.refStatus, referenceCount: article.claimRefs.length,
        staleReferences: (stale.get(article.id) ?? []).map((/** @type {any} */ entry) => ({ cardId: entry.cardId, claimId: entry.claimId, revision: entry.revision,
          category: entry.category, summary: entry.summary, occurredAt: entry.occurredAt })),
        placementLabel: article.placementLabel,
      })),
    };
  }

  /**
   * `POST …/:id/articles/:aid/withdraw`: before anything was placed, or once
   * no order for it is live any more (the user cancelled it — 撤单 then 撤回).
   * @param {{ id: string }} user @param {string} id @param {string} articleId
   */
  async withdrawArticle(user, id, articleId) {
    const project = await this.requireProject(user, id, "edit");
    if (!(await this.store.getArticle(project.id, articleId))) throw failure(404, "geo_article_not_found", "Article not found.");
    const live = await this.store.query(`SELECT 1 FROM evimed_geo.orders WHERE geo_project_id = $1 AND article_id = $2
      AND state = ANY($3::text[]) LIMIT 1`, [project.id, articleId, [...GEO_ORDER_ARTICLE_LIVE_STATES, "problem"]]);
    const fromStatuses = live.rows.length ? ["draft", "publishable"] : ["draft", "publishable", "placed"];
    const changed = await this.store.changeArticle(project.id, articleId, { status: "withdrawn", fromStatuses });
    if (!changed) throw failure(409, "geo_article_state_invalid", "Only an article that has not been placed can be withdrawn.");
    return { id: changed.id, status: changed.status };
  }

  /** `POST …/:id/articles/:aid/release`: a review applies to the version the person actually observed.
   * @param {{ id: string }} user @param {string} id @param {string} articleId
   * @param {{expectedResultVersionId?:string|null,expectedDigest?:string|null}} [input] */
  async releaseArticle(user, id, articleId, input = {}) {
    const project = await this.requireProject(user, id, "review");
    const article = await this.store.getArticle(project.id, articleId);
    if (!article) throw failure(404, "geo_article_not_found", "Article not found.");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw failure(400, "geo_article_review_invalid", "Invalid article review reference.");
    const supplied = Object.hasOwn(input, "expectedResultVersionId");
    if (supplied !== Object.hasOwn(input, "expectedDigest")
      || supplied && ((input.expectedResultVersionId !== null && !/^rv_[a-f0-9]{64}$/.test(String(input.expectedResultVersionId)))
        || (input.expectedDigest !== null && !SHA256.test(String(input.expectedDigest))))) throw failure(400, "geo_article_review_invalid", "Invalid article review reference.");
    const stale = () => failure(409, "geo_article_review_stale", "The article changed. Reopen the version before releasing it.");
    if (article.currentResultVersionId && (!supplied || !input.expectedDigest)) throw stale();
    if (supplied && (input.expectedResultVersionId !== article.currentResultVersionId || input.expectedDigest !== article.contentSha256)) throw stale();
    // Unversioned legacy clients remain compatible. Their observed row is still held by SQL CAS against a newly arriving head.
    const expected = { expectedResultVersionId: supplied ? input.expectedResultVersionId : null,
      expectedDigest: supplied ? input.expectedDigest : article.contentSha256 };
    const changed = await this.store.changeArticle(project.id, articleId, { safety: "released", fromSafety: ["open"], ...expected });
    if (!changed) {
      const current = await this.store.getArticle(project.id, articleId);
      if (current?.currentResultVersionId !== expected.expectedResultVersionId || current?.contentSha256 !== expected.expectedDigest) throw stale();
      throw failure(409, "geo_article_state_invalid", "Only an article with an open safety finding can be released.");
    }
    return { id: changed.id, safety: changed.safety, status: changed.status };
  }

  /** `GET …/:id/distribution`. @param {{ id: string }} user @param {string} id @param {{ marketConfigured?: boolean }} [options] */
  async distribution(user, id, options = {}) { return this.distributionOf(await this.requireProject(user, id), options); }

  async distributionOrders(user, id, input = {}) { return this.distributionView.orders(await this.requireProject(user, id), input); }
  async distributionOrder(user, id, orderId, input = {}) { return this.distributionView.order(await this.requireProject(user, id), orderId, input); }
  async distributionLedger(user, id, input = {}) { return this.distributionView.ledger(await this.requireProject(user, id), input); }
  async ownedPublicationList(user, id, input = {}) {
    const project = await this.requireProject(user, id);
    if (!this.ownedPublications) throw failure(503, "geo_unavailable", "Publication records are unavailable.");
    return this.ownedPublications.list(project, input);
  }
  async ownedPublicationDetail(user, id, linkId, input = {}) {
    const project = await this.requireProject(user, id);
    if (!this.ownedPublications) throw failure(503, "geo_unavailable", "Publication records are unavailable.");
    return this.ownedPublications.detail(project, linkId, input);
  }
  async confirmOwnedPublication(user, id, linkId, input) {
    const project = await this.requireProject(user, id, "edit");
    if (!this.ownedPublications) throw failure(503, "geo_unavailable", "Publication records are unavailable.");
    return this.ownedPublications.confirm({ ...project, actorId: user.id }, linkId, input);
  }
  async sourceOwnershipRead(user, id, input) {
    const project = await this.requireProject(user, id);
    if (!this.sourceOwnership) throw failure(503, "geo_unavailable", "Source annotations are unavailable.");
    const [current, history] = await Promise.all([this.sourceOwnership.read(project, input.target), this.sourceOwnership.history(project, input.target, { beforeRevision: input.beforeRevision ?? null })]);
    const effective = input.target?.kind === "page" ? (await this.sourceOwnership.resolve(project, [input.target.value]))[0] : null;
    return { current, history, effective };
  }
  async sourceOwnershipWrite(user, id, input) {
    const project = await this.requireProject(user, id, "edit");
    if (!this.sourceOwnership) throw failure(503, "geo_unavailable", "Source annotations are unavailable.");
    return this.sourceOwnership.set({ ...project, actorId: user.id }, input);
  }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {{ marketConfigured?: boolean }} [options] */
  async distributionOf(project, { marketConfigured = geoMarketConfigured(this.config) } = {}) {
    const [orders, money, targets, ownedLinks, publication, earlierPublication] = await Promise.all([
      // The orders as the market reads them (its own derived times: when the send began, when the state was entered), with the names.
      this.store.query(`SELECT o.*, a.title AS article_title, a.layer AS article_layer, m.name AS media_name, m.domain AS media_domain
        FROM (${ORDER_SELECT} WHERE o.geo_project_id = $1 ORDER BY o.created_at DESC LIMIT 500) o
          LEFT JOIN evimed_geo.articles a ON a.id = o.article_id
          LEFT JOIN evimed_geo.media m ON m.media_type = o.media_type AND m.resource_id = o.resource_id
        ORDER BY o.created_at DESC`, [project.id]),
      // The money is the ledger's (projectMoney, the market's own view): a
      // rejected order still holds its reserve until the refund is in the
      // balance, and a refund after settlement is money back.
      this.store.query(`SELECT order_id, kind, sum(amount_cny) AS amount FROM evimed_geo.ledger WHERE geo_project_id = $1 GROUP BY order_id, kind`,
        [project.id]),
      this.store.latestTargets(project.id),
      // The links the brand published itself sit beside the placements: the
      // same post-publication checks, no order and no money (gap E6).
      this.store.ownedLinks(project.id),
      this.store.query(`SELECT min(at) AS first_at FROM (
        SELECT e.at FROM evimed_geo.order_events e JOIN evimed_geo.orders o ON o.id=e.order_id
          WHERE o.geo_project_id=$1 AND e.to_state='published' AND e.from_state IS DISTINCT FROM 'published'
        UNION ALL SELECT published_at AS at FROM evimed_geo.owned_links WHERE geo_project_id=$1
      ) observations`, [project.id]),
      this.ownedPublications?.firstPublishedAt(project) ?? null,
    ]);
    const suggested = (targets?.rows ?? []).filter((row) => row.tier === project.tier && row.budgetCny != null)
      .reduce((/** @type {number | null} */ max, row) => Math.max(max ?? 0, Number(row.budgetCny)), null);
    const budget = project.budget && typeof project.budget === "object"
      ? { totalCny: num(project.budget.totalCny), dailyCny: num(project.budget.dailyCny) } : null;
    const ledger = projectMoney(project, money.rows.map((/** @type {any} */ row) => ({ orderId: row.order_id ?? null, kind: String(row.kind),
      amountCny: Number(row.amount) })));
    return {
      budget,
      spentCny: ledger.spentCny,
      reservedCny: ledger.reservedCny,
      settledCny: ledger.settledCny,
      refundedCny: ledger.refundedCny,
      availableCny: ledger.availableCny,
      suggestedBudgetCny: suggested,
      firstPublishedAt: [iso(publication.rows[0]?.first_at), earlierPublication].filter(Boolean).sort()[0] ?? null,
      market: { configured: Boolean(marketConfigured) },
      orders: orders.rows.map((/** @type {any} */ row) => {
        const order = mapOrder(row);
        return {
          id: String(row.id), articleId: text(row.article_id), articleTitle: text(row.article_title), media: text(row.media_name),
          domain: text(row.media_domain), layer: text(row.article_layer), state: String(row.state),
          // What the outlet finally charged, once it has; the plan's price, then the reserve, before.
          priceCny: order.settledCny ?? order.priceCny ?? order.reserveCny,
          publishedUrl: text(row.published_url), checks: Array.isArray(row.checks) ? row.checks : [], updatedAt: iso(row.updated_at),
          articleResultVersionId: order.articleResultVersionId, articleDigest: order.articleDigest, publishedAt: order.publishedAt,
          // 撤单 is offered where the market takes it: not a send in flight, not an order the outlet has taken.
          cancellable: orderCancellable(order),
        };
      }),
      ownedLinks,
    };
  }

  /** One order of the project, for the cancel route's ownership and state check: cancelling is money, the owner's. @param {{ id: string }} user @param {string} id @param {string} orderId */
  async order(user, id, orderId) {
    const project = await this.requireProject(user, id, "manage_money");
    const row = (await this.store.query(`SELECT id, state FROM evimed_geo.orders WHERE geo_project_id = $1 AND id = $2`, [project.id, orderId])).rows[0];
    if (!row) throw failure(404, "geo_order_not_found", "Order not found.");
    return { project, order: { id: String(row.id), state: String(row.state) } };
  }

  /** `GET …/:id/monitoring`. @param {{ id: string }} user @param {string} id */
  async monitoring(user, id, scope = {}) { return this.monitoringOf(await this.requireProject(user, id), scope); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async monitoringOf(project, scope = {}) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.monitoringOf(project, scope));
    const selected = await readGeoSelection(this.store, project, scope);
    return this.#applySelection(project, await this.#monitoringBase(project), selected, "monitoring", scope);
  }

  /** @param {any} project */
  async #monitoringBase(project) {
    const metricIds = GEO_OVERVIEW_METRICS.map((entry) => entry.metricId);
    const since = new Date(this.now().getTime() - WEEK_MS).toISOString();
    const [series, arms, byEngine, net, noise, cited, newErrors, queued, baseline, rivals] = await Promise.all([
      this.#series([project.id], metricIds, "project", "", { coverage: true }),
      this.#series([project.id], [GEO_ARM_METRIC_ID], "arm", "arm", { coverage: true }),
      this.#series([project.id], GEO_METRIC_IDS, "engine", "engine", { coverage: true }),
      this.store.query(`SELECT * FROM evimed_geo.metrics WHERE geo_project_id = $1 AND scope = 'project' AND metric_id = $2 AND variant = $3
        ORDER BY computed_at DESC LIMIT 1`, [project.id, GEO_VIEW_METRIC_IDS.netEffect, NET_EFFECT_OF]),
      this.store.query(`SELECT value FROM evimed_geo.metrics WHERE geo_project_id = $1 AND scope = 'project' AND metric_id = $2 AND variant = $3
        ORDER BY computed_at DESC LIMIT 1`, [project.id, GEO_VIEW_METRIC_IDS.noiseBand, NOISE_BAND_OF]),
      this.store.citedArticles(project.id),
      this.store.query(`SELECT * FROM evimed_geo.errors WHERE geo_project_id = $1 AND created_at >= $2
        ORDER BY severity DESC NULLS LAST, created_at DESC LIMIT 50`, [project.id, since]),
      // The next measurement is a full one (G6): a confirmation, a sentinel
      // or a noise round measures a sliver and is never 「下次复测」.
      this.store.query(`SELECT kind, created_at FROM evimed_geo.rounds WHERE geo_project_id = $1 AND status IN ('queued', 'running')
        AND kind = ANY($2::text[]) ORDER BY created_at LIMIT 1`, [project.id, [...GEO_HEADLINE_ROUND_KINDS]]),
      // The baseline the weekly rest counts from is the first that heard an answer, as the schedule's (2026-10-25).
      this.store.query(`SELECT r.finished_at, (SELECT coalesce(array_agg(key), '{}') FROM evimed_geo.schedule_marks
          WHERE geo_project_id = $1 AND starts_with(key, 'weekly:')) AS taken
        FROM evimed_geo.rounds r WHERE r.geo_project_id = $1 AND r.kind IN ('baseline', 'single_step') AND r.status IN ('done', 'partial')
          AND EXISTS (SELECT 1 FROM evimed_geo.snapshots s WHERE s.round_id = r.id AND s.status IN ('valid', 'refusal'))
        ORDER BY r.finished_at LIMIT 1`, [project.id]),
      this.#rivalSeries(project.id),
    ]);
    const pause = geoMeasurementPause({ engines: project.engines, probe: this.probeState?.() ?? null, config: this.config, now: this.now() });
    // Since when, as the stored answers show it: for each paused engine, its first failed or suspect ask after its last counted
    // answer (any project's: an engine is down for all of them). A paused measurement dates from the engine that stopped last; a
    // running one with engines out, from the one out longest. Null where nothing stored says it.
    const starts = pause.engines.length ? (await this.store.query(`SELECT e.engine, (SELECT min(s.asked_at) FROM evimed_geo.snapshots s
        WHERE s.engine = e.engine AND s.status IN ('failed', 'suspect') AND coalesce(s.surface ->> 'mode', 'web') <> 'inclusion'
          AND s.asked_at > coalesce((SELECT max(a.asked_at) FROM evimed_geo.snapshots a WHERE a.engine = e.engine AND a.status IN ('valid', 'refusal')
            AND coalesce(a.surface ->> 'mode', 'web') <> 'inclusion'), '-infinity'::timestamptz)) AS since
      FROM unnest($1::text[]) AS e(engine)`, [pause.engines])).rows.map((/** @type {any} */ row) => row.since).filter(Boolean)
      .map((/** @type {any} */ at) => new Date(at).getTime()) : [];
    const measurement = { state: pause.state, engines: pause.engines,
      since: starts.length ? new Date(pause.state === "paused" ? Math.max(...starts) : Math.min(...starts)).toISOString() : null };
    const projectSeries = series.get(project.id) ?? new Map();
    const armSeries = arms.get(project.id) ?? new Map();
    const engineSeries = byEngine.get(project.id) ?? new Map();
    const points = (/** @type {string} */ key) => (armSeries.get(`${GEO_ARM_METRIC_ID}\u0000${key}`) ?? []).map(({ date, value, coverage }) => ({ date, value, coverage }));
    const netRow = net.rows[0];
    // Otherwise the weekly re-measure the schedule will run, by its own skip
    // rules, and only while the program monitors at all.
    const measured = baseline.rows[0];
    // Nothing is next while the owner has paused the project or no engine of it can be asked: the page would name a re-measure that
    // will not happen.
    const next = project.status === "paused" || measurement.state === "paused" ? null : queued.rows[0]
      ? { date: dayIn(new Date(queued.rows[0].created_at), this.timeZone), kind: String(queued.rows[0].kind) }
      : measured && wantedSteps(programSteps(project.steps)).want.has("monitoring")
        ? { date: nextWeeklySlot({ now: this.now(), timeZone: this.timeZone, baselineFinishedAt: measured.finished_at,
          taken: new Set(Array.isArray(measured.taken) ? measured.taken.map(String) : []) }).monday, kind: "weekly" }
        : null;
    return {
      series: GEO_OVERVIEW_METRICS.map(({ key, metricId }) => ({ key, points: projectSeries.get(metricId) ?? [] })),
      arms: {
        pilot: points("pilot"),
        control: points("control"),
        // The band the net effect was judged against is its own row's, with whether it was measured or the default; a row written
        // before the band was kept shows mention's measured band, as it did, and says nothing about it.
        netEffect: { ...geoCellFromRow(netRow),
          noiseBand: netRow?.noise_band != null ? num(netRow.noise_band) : noise.rows[0] ? num(noise.rows[0].value) : null,
          noiseMeasured: netRow?.noise_band != null ? netRow.noise_measured === true : null },
      },
      byEngine: project.engines.map((engine) => ({
        engine, metrics: engineMetricDescriptors().map(({ metricId, variant }) => ({ metricId, variant, points: engineSeries.get(`${metricId}\u0000${engine}${variant ? `\u0000${variant}` : ""}`) ?? [] })),
        points: (engineSeries.get(`${GEO_VIEW_METRIC_IDS.mention}\u0000${engine}`) ?? []).map(({ date, value, coverage }) => ({ date, value, coverage })),
      })),
      rivals,
      cited,
      newErrors: newErrors.rows.map(errorView),
      next,
      measurement,
    };
  }

  /**
   * `GET /api/geo/market` (operators): the platform's balance as the market
   * last read it, open top-up requests and the last reconciliation.
   * @param {{ balance?: () => Promise<any>, status?: () => Promise<any> } | null} market
   */
  async market(market) {
    await this.ready();
    if (market?.status) {
      const status = await market.status();
      return { ...status, reconciliation: status.lastReconciliation ?? null };
    }
    const [topups, reconciliation] = await Promise.all([
      this.store.query(`SELECT * FROM evimed_geo.topups ORDER BY requested_at DESC LIMIT 20`),
      this.store.query(`SELECT * FROM evimed_geo.reconciliations ORDER BY day DESC LIMIT 1`),
    ]);
    let balance = null;
    try { balance = market?.balance ? await market.balance() : null; } catch { balance = null; }
    const last = reconciliation.rows[0];
    return {
      operationsAvailable: false,
      configured: geoMarketConfigured(this.config),
      balance,
      balanceCapCny: this.config.mediaMarketBalanceCapCny ?? null,
      topups: topups.rows.map((/** @type {any} */ row) => ({
        id: String(row.id), amountCny: num(row.amount_cny), status: String(row.status), balanceBefore: num(row.balance_before),
        balanceAfter: num(row.balance_after), requestedAt: iso(row.requested_at), confirmedAt: iso(row.confirmed_at), note: text(row.note),
      })),
      reconciliation: last ? {
        day: typeof last.day === "string" ? last.day : dayIn(new Date(last.day), this.timeZone), ours: num(last.ours), vendor: num(last.vendor),
        balance: num(last.balance), diff: num(last.diff), status: text(last.status),
      } : null,
    };
  }

  /** A top-up request exists (before the market confirms it). @param {string} topupId */
  async topupExists(topupId) {
    await this.ready();
    return (await this.store.query(`SELECT 1 FROM evimed_geo.topups WHERE id = $1`, [topupId])).rows.length > 0;
  }

  // --- the question group as the spine: clusters, actions, the strategy ----------------------------

  /**
   * One read of the project and what is derived from it, shared by every view of the spine.
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project
   */
  async #spineOf(project) {
    const spine = await this.spine.load(project);
    const derived = await this.spine.actions(spine);
    return { spine, derived };
  }

  /** Build group metadata and work from the authorized selection, never by filling a missing latest-version row.
   * Metrics use the shared computation; ongoing articles and action choices retain their exact group identifiers.
   * @param {any} project @param {Awaited<ReturnType<typeof readGeoSelection>>} selected @param {any[]} groups */
  async #scopedClusterContext(project, selected, groups) {
    const base = await this.spine.load(project, { answers: false });
    const errors = await readGeoSelectionErrors(this.store, project, selected, { errorLimit: 500 });
    const snapshotGroups = new Map(selected.rows.map((row) => [row.snapshotId, row.groupId]));
    const questionGroups = new Map(selected.questions.map((question) => [String(question.id), String(question.group_id)]));
    const answers = this.#selectionAnswers(selected);
    const round = selected.rounds[0];
    const roundId = round?.id ?? null, date = round ? rowDay(round, selected.scope.timeZone) : null;
    const rows = selected.computed.cells.filter((entry) => !entry.variant && !entry.rival && !entry.arm && !entry.engine);
    const versions = [...new Set(groups.map((group) => Number(group.set_version)))];
    const sets = await this.store.questionSets(project.id);
    const currentGroups = new Map(base.groups.map((group) => [group.id, group]));
    const selectedIds = new Set(groups.map(group => String(group.id)));
    // Current groups retain the spine's established version aliases; a selected historical group keeps its own identity.
    const currentOf = new Map([...base.currentOf].filter(([, currentId]) => selectedIds.has(currentId)));
    for (const id of selectedIds) currentOf.set(id, id);
    const scoped = { ...base, project: { ...base.project, engines: selected.selection.engines },
      version: versions.length === 1 ? versions[0] : null,
      locked: versions.length === 1 && Boolean(sets.find((set) => set.version === versions[0])?.lockedAt),
      groups: groups.map((group) => ({ ...questionGroupFromRow(group), aliasIds: currentGroups.get(String(group.id))?.aliasIds ?? [],
        questions: selected.questions.filter((question) => question.group_id === group.id).map(questionFromRow) })),
      currentOf,
      errors: errors.claimRows.filter(row => row.judgment_state !== "withdrawn").map((row) => ({ ...errorView(row), groupId: questionGroups.get(String(row.question_id)) ?? snapshotGroups.get(row.last_snapshot_id) ?? snapshotGroups.get(row.first_snapshot_id) ?? snapshotGroups.get(row.closed_snapshot_id) ?? null, materials: row.materials ?? [] })),
      answersByGroup: new Map(groups.map((group) => [String(group.id), answers.filter((answer) => questionGroups.get(String(answer.questionId)) === group.id)])),
      readings: rows.filter((entry) => entry.scope === "group").map((entry) => ({ groupId: entry.groupId, metricId: entry.metricId,
        k: entry.numerator, n: entry.denominator, value: entry.value, status: entry.status, roundId, date, kind: round?.kind ?? "single_step", coverage: selected.selection.coverage })),
      poolReadings: rows.filter((entry) => entry.scope === "pool").map((entry) => ({ pool: entry.pool, metricId: entry.metricId,
        k: entry.numerator, n: entry.denominator, value: entry.value, status: entry.status, roundId })),
      arms: {},
    };
    return { spine: scoped, errorSummary: errors.summary, errorPage: errors.page, derived: await this.spine.actions(scoped), legacyReadings: base.readings, selected };
  }

  /** `GET …/:id/clusters`. @param {{ id: string }} user @param {string} id */
  async clusters(user, id, scope = {}) { return this.clustersOf(await this.requireProject(user, id), scope); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async clustersOf(project, scope = {}) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.clustersOf(project, scope));
    const selected = await readGeoSelection(this.store, project, scope);
    return this.#applySelection(project, { groups: [], locked: false, floor: 30 }, selected, "clusters", scope);
  }

  /** `GET …/:id/clusters/:groupId`. @param {{ id: string }} user @param {string} id @param {string} groupId */
  async cluster(user, id, groupId, scope = {}) { return this.clusterOf(await this.requireProject(user, id), groupId, scope); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {string} groupId */
  async clusterOf(project, groupId, scope = {}) {
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.clusterOf(project, groupId, scope));
    const row = (await this.store.query(`SELECT * FROM evimed_geo.question_groups WHERE geo_project_id = $1 AND user_id = $2 AND id = $3`,
      [project.id, project.userId, groupId])).rows[0];
    if (!row) throw failure(404, "geo_cluster_not_found", "Question group not found.");
    const selected = await readGeoSelection(this.store, project, scope);
    const filtered = geoScopeIsFiltered(selected.scope) || Boolean(scope.selectionRef);
    const context = await this.#scopedClusterContext(project, selected, [row]);
    const stored = !filtered && !selected.rows.some((member) => member.facts) ? await this.#clusterBase(project, groupId) : null;
    const historical = stored ?? await this.#clusterBase(project, groupId, context);
    const listed = await this.#applySelection(project, { groups: [], locked: false, floor: 30 }, selected, "clusters", scope, context);
    const group = listed.groups.find((/** @type {any} */ entry) => entry.id === groupId);
    if (!group) throw failure(404, "geo_cluster_not_found", "Question group is outside this selection.");
    const questions = selected.questions.filter((question) => question.group_id === groupId);
    const ids = new Set(questions.map((question) => question.id));
    const answers = this.#selectionAnswers(selected).filter((answer) => ids.has(answer.questionId));
    const sources = await this.store.listSources(project.id);
    const errorData = await readGeoSelectionErrors(this.store, project, { ...selected, rows: selected.rows.filter((member) => ids.has(member.questionId)) }, { errorLimit: this.errorListLimit });
    return { ...historical, group: { ...historical?.group, ...group }, scope: selected.scope, selection: selected.selection, comparison: selected.comparison,
      questions: questions.map((question) => ({ id: question.id, text: question.text, kind: question.kind, isMeasured: question.is_measured,
        platform: question.platform, sourceUrl: question.source_url, collectedAt: iso(question.collected_at),
        answers: selected.rows.filter((member) => member.questionId === question.id).slice(0, GEO_CELL_SNAPSHOT_LIMIT).map((member) => ({
          engine: member.engine, snapshotId: member.snapshotId, roundId: member.roundId, status: member.status, askedAt: member.askedAt,
          mentionsOurs: member.mentionsOurs, wrongOurs: member.failureMode == null ? null : member.failureMode === "wrong_ours", citesOurs: null })),
        answersTotal: selected.rows.filter((member) => member.questionId === question.id).length })),
      sources: [...tallySources(answers)].map(([domain, entry]) => { const source = sources.find((candidate) => candidate.domain === domain); return {
        domain, name: source?.name ?? null, kind: source?.kind ?? null, layer: source?.layer ?? null,
        cited: { total: Object.values(entry.byEngine).reduce((sum, count) => sum + count.cited, 0), byEngine: Object.fromEntries(Object.entries(entry.byEngine).map(([engine, count]) => [engine, count.cited])) },
        mentionsOurs: entry.mentionsOurs, wrongOurs: entry.wrongOurs }; }),
      errors: errorData.rows.map(errorView), errorPage: errorData.page,
      gaps: historical?.gaps ?? [], claims: historical?.claims ?? {}, actions: historical?.actions ?? [], articles: historical?.articles ?? [],
      orders: historical?.orders ?? [], ownedLinks: historical?.ownedLinks ?? [],
      effect: historical?.effect ? { ...historical.effect, kind: filtered ? "observational" : "historical" }
        : { metricId: "M-01", series: [], events: [], arm: null, kind: "observational" } };
  }

  /** @param {any} project @param {string} groupId */
  async #clusterBase(project, groupId, context = /** @type {any} */ (null)) {
    const { spine, derived } = context ?? await this.#spineOf(project);
    const view = await this.spine.cluster(spine, derived, groupId, {
      answersOf: async (texts) => context ? new Map(texts.map((value) => [value.trim(), context.selected.rows
        .filter((member) => context.selected.questions.some((question) => question.id === member.questionId && question.text.trim() === value.trim()))
        .map((member) => ({ engine: member.engine, snapshotId: member.snapshotId }))])) : this.#latestAnswers(project, texts),
      claimsOf: async (ids) => (await this.store.query(`SELECT id, claim_key, statement, source_label, source_kind, status FROM evimed_geo.claims
        WHERE geo_project_id = $1 AND id = ANY($2::text[])`, [project.id, ids])).rows.map((/** @type {any} */ row) => ({
        id: String(row.id), claimKey: String(row.claim_key), statement: String(row.statement), sourceLabel: text(row.source_label), sourceKind: text(row.source_kind),
        status: String(row.status) })),
      answerFacts: async (snapshotIds) => {
        const rows = snapshotIds.length ? (await this.store.query(`SELECT s.id, s.status, s.asked_at, f.mentions_ours, f.cites_ours, f.failure_mode
          FROM evimed_geo.snapshots s LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id WHERE s.geo_project_id = $1 AND s.id = ANY($2::text[])`,
        [project.id, snapshotIds])).rows : [];
        return new Map(rows.map((/** @type {any} */ row) => [String(row.id), {
          status: text(row.status), askedAt: iso(row.asked_at), mentionsOurs: row.mentions_ours == null ? null : Boolean(row.mentions_ours),
          wrongOurs: row.failure_mode == null ? null : row.failure_mode === "wrong_ours", citesOurs: row.cites_ours == null ? null : Boolean(row.cites_ours) }]));
      },
    });
    if (!view) throw failure(404, "geo_cluster_not_found", "Question group not found.");
    return view;
  }

  /** `GET …/:id/actions`. @param {{ id: string }} user @param {string} id */
  async actions(user, id) { return this.actionsOf(await this.requireProject(user, id)); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async actionsOf(project) {
    const { spine, derived } = await this.#spineOf(project);
    return {
      version: spine.strategy?.version ?? null,
      tier: project.tier,
      round: spine.rounds.latest,
      floor: 30,
      headline: derived.headline,
      counts: derived.counts,
      actions: derived.actions,
      control: derived.control,
      noAction: derived.noAction,
      unmatched: derived.unmatched,
    };
  }

  /** `GET …/:id/actions/:key`. @param {{ id: string }} user @param {string} id @param {string} key */
  async action(user, id, key) { return this.actionOf(await this.requireProject(user, id), key); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {string} key */
  async actionOf(project, key) {
    const { spine, derived } = await this.#spineOf(project);
    const action = derived.actions.find((entry) => entry.key === key);
    if (!action) throw failure(404, "geo_action_not_found", "Action not found.");
    const clusters = this.spine.clusters(spine, derived);
    return { action, group: clusters.groups.find((group) => group.id === action.group?.id) ?? null, floor: 30, round: spine.rounds.latest };
  }

  /**
   * `POST …/:id/actions/:key/skip` and `…/source`: a person's two reversible words about an action. Nothing else is written, and an
   * action that does not exist (or a to-do the strategy does not hold) is not a key a choice may be made for.
   * @param {{ id: string }} user @param {string} id @param {string} key @param {{ skipped?: boolean, sourceDomain?: string | null }} change
   */
  async chooseAction(user, id, key, change) {
    const project = await this.requireProject(user, id, "edit");
    if (!parseGeoActionKey(key) && !/^client:[0-9a-f]{8}$/.test(key)) throw failure(404, "geo_action_not_found", "Action not found.");
    let sourceDomain = change.sourceDomain;
    if (typeof sourceDomain === "string") {
      sourceDomain = sourceDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(sourceDomain)) {
        throw failure(400, "geo_action_choice_invalid", "A source is named by its website's domain.");
      }
    }
    const { spine, derived } = await this.#spineOf(project);
    if (!this.spine.knowsKey(spine, derived, key)) throw failure(404, "geo_action_not_found", "Action not found.");
    const stored = await this.store.setActionChoice({ geoId: project.id, ownerId: project.userId, key, decidedBy: String(user.id),
      ...(change.skipped === undefined ? {} : { skipped: change.skipped }), ...(sourceDomain === undefined ? {} : { sourceDomain }) });
    return { key, skipped: stored?.skipped ?? false, sourceDomain: stored?.sourceDomain ?? null, updatedAt: stored?.updatedAt ?? null, cleared: stored === null };
  }

  /**
   * `POST …/:id/owned-links`: a person pastes the address of a page they published themselves. The registration is the run's
   * (`geo_write owned_links`), through the same validator and the same rows, so the post-publication re-tests of its group and the
   * citation match pick it up with no further step. The day it went live defaults to now; the article it belongs to gives its group
   * and, unless the person says otherwise, its title.
   * @param {{ id: string }} user @param {string} id
   * @param {{ url: string, platform: string, title?: string | null, publishedAt?: string | null, articleId?: string | null, groupId?: string | null }} input
   */
  async registerOwnedLink(user, id, input) {
    const project = await this.requireProject(user, id, "edit");
    let title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : null;
    if (!title && input.articleId) title = (await this.store.listArticles(project.id)).find((article) => article.id === input.articleId)?.title ?? null;
    const item = { url: input.url, platform: input.platform, title: title ?? undefined, publishedAt: input.publishedAt ?? this.now().toISOString(),
      ...(input.articleId ? { articleId: input.articleId } : {}), ...(input.groupId ? { groupId: input.groupId } : {}) };
    const result = await geoRuntimeWrite({ store: this.store, project, what: "owned_links", body: { items: [item] } });
    if (!result.ok) {
      const refusal = result.issues.find((issue) => issue.code !== "notice");
      throw failure(400, "geo_owned_link_invalid", refusal ? `${refusal.field ? `${refusal.field}: ` : ""}${refusal.message}` : "The link was not registered.");
    }
    this.counters.writes += 1;
    return { id: result.ids[0] ?? null, registered: result.registered ?? [], notices: result.issues.map((issue) => issue.message) };
  }

  /**
   * What a runtime write answered about fields it did not keep, counted by the write's `what` (`/metrics`): fields the run wrote that
   * the platform does not know (`ignored_fields`), and those it has said it does not keep (`declined`).
   * @param {string} what @param {{ issues?: Array<{ code?: string, field?: string }>, declined?: number }} result
   */
  noteWriteFields(what, result) {
    const ignored = (result.issues ?? []).filter((issue) => issue.code === "ignored_fields")
      .reduce((total, issue) => total + String(issue.field ?? "").split(",").filter(Boolean).length * Math.max(1, Number(/** @type {any} */ (issue).count) || 1), 0);
    const declined = Number(result.declined ?? 0) || 0;
    if (ignored) this.fieldTotals.set(`${what}\u0000ignored`, (this.fieldTotals.get(`${what}\u0000ignored`) ?? 0) + ignored);
    if (declined) this.fieldTotals.set(`${what}\u0000declined`, (this.fieldTotals.get(`${what}\u0000declined`) ?? 0) + declined);
    this.counters.ignoredFields += ignored;
    this.counters.declinedFields += declined;
  }

  /** `GET …/:id/strategy`. @param {{ id: string }} user @param {string} id */
  async strategy(user, id, scope = {}) { return this.strategyOf(await this.requireProject(user, id), scope); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async strategyOf(project, input = {}) {
    const filter = /** @type {any} */ (input);
    if (filter.strategyVersion != null && (!Number.isSafeInteger(filter.strategyVersion) || filter.strategyVersion < 1)) throw new HttpError(400, "geo_strategy_version_invalid", "Choose a valid plan version.");
    if (filter.planContextRef && !this.planContexts) throw new HttpError(503, "geo_plan_context_unavailable", "Planning context is unavailable.");
    let selected = null, context = null;
    if (filter.planContextRef && this.planContexts) {
      const row = await this.planContexts.documents.get(project.userId, "geo-plan-context", filter.planContextRef);
      if (!row || row.projectId !== project.projectId || row.payload.geoId !== project.id) throw new HttpError(404, "geo_plan_context_not_found", "The plan is unavailable.");
      if (!['strategy', 'content'].includes(row.payload.mode)) throw new HttpError(409, 'geo_plan_context_mismatch', 'Choose a planning context for this strategy read.');
      context = row.payload;
    }
    const scoped = Object.entries(geoReadScopeInput(filter)).some(([key, value]) => {
      if (key === "selectionRef") return Boolean(value);
      if (["timeZone", "timezone", "comparisonMode"].includes(key)) return false;
      return Array.isArray(value) ? value.length > 0 : value != null;
    });
    let scopeKey = null;
    if ((scoped || filter.sourceId || filter.url) && filter.strategyVersion == null && !context) {
      selected = await readGeoSelection(this.store, project, geoReadScopeInput(filter));
      scopeKey = geoPlanScopeKey(geoPlanCanonicalScope(selected.scope, selected.questions), filter);
    }
    const strategy = await this.store.latestStrategy(project.id, { ...(filter.strategyVersion != null || context?.strategyVersion ? { strategyVersion: Number(filter.strategyVersion ?? context.strategyVersion) } : { scopeKey: context?.scopeKey ?? scopeKey }) });
    if (filter.strategyVersion != null && !strategy) throw new HttpError(404, "geo_strategy_not_found", "This plan version is unavailable.");
    if (context && (strategy && strategy.scopeKey !== context.scopeKey
      || context.mode === "content" && strategy?.version !== context.strategyVersion)) throw new HttpError(409, "geo_plan_context_mismatch", "Choose the plan version belonging to this selected input.");
    const basis = context?.basis ?? strategy?.basis ?? null;
    if (filter.strategyVersion != null && scoped) {
      try { selected = await readGeoSelection(this.store, project, geoReadScopeInput(filter)); } catch { /* historical basis stays available */ }
    }
    if (!selected && basis && !scoped) {
      try { selected = await readGeoSelection(this.store, project, { selectionRef: basis.selection.reference }); } catch { /* historical frozen basis remains readable */ }
    }
    const base = await this.spine.load(project, { answers: false });
    const groups = basis?.groups ?? (selected ? (await freezeGeoPlanBasis(this.store, project, { selectionRef: selected.selection.reference })).basis.groups : null);
    const spine = { ...base, strategy, ...(basis ? { targets: basis.targets } : {}),
      ...(groups ? { groups: groups.map(group => ({ ...(base.groups.find(item => item.id === group.id) ?? { ...group,
        questions: (selected?.questions ?? []).filter(question => question.group_id === group.id).map(questionFromRow), weight: null, isControl: false }), aliasIds: [] })), currentOf: new Map(groups.map(group => [group.id, group.id])) } : {}) };
    if (groups && strategy) {
      const exactIds = new Set(groups.map(group=>group.id));
      const exactGroup = entry => entry?.groupId && !exactIds.has(entry.groupId) ? {...entry,group:null,groupName:null} : entry;
      spine.strategy = {...strategy,actions:(strategy.actions ?? []).map(exactGroup),gaps:(strategy.gaps ?? []).map(exactGroup)};
    }
    const measured = basis && (filter.strategyVersion != null || context?.strategyVersion || !selected) ? { computed: { cells: basis.readings.selected.cells } } : selected;
    if (measured) {
      const rounds = basis?.readings.selected.rounds ?? selected.rounds.map(round => ({ id: round.id, date: rowDay(round, selected.scope.timeZone), kind: round.kind }));
      spine.rounds = { ...spine.rounds, baseline: null, latest: rounds.length === 1 ? { id: rounds[0].id, sampleDate: rounds[0].date, kind: rounds[0].kind } : null };
    }
    if (measured) {
      const cells = measured.computed.cells.filter(cell => !cell.engine && !cell.variant && !cell.rival && !cell.arm);
      spine.readings = cells.filter(cell => cell.scope === "group").map(cell => ({ groupId: cell.groupId, metricId: cell.metricId, k:cell.numerator, n:cell.denominator, value:cell.value, status:cell.status, roundId:spine.rounds.latest?.id ?? null, date:spine.rounds.latest?.sampleDate ?? null, kind:spine.rounds.latest?.kind ?? "single_step" }));
      spine.poolReadings = cells.filter(cell => cell.scope === "pool" || cell.scope === "project").map(cell => ({ pool:cell.pool ?? "all",metricId:cell.metricId,k:cell.numerator,n:cell.denominator,value:cell.value,status:cell.status,roundId:spine.rounds.latest?.id ?? null }));
    }
    if (selected) {
      const errorData = await readGeoSelectionErrors(this.store,project,selected,{errorLimit:1});
      const selectedErrorIds = new Set(errorData.live.map(error=>String(error.id)));
      const questionGroups = new Map(selected.questions.map(question=>[String(question.id),String(question.group_id)]));
      spine.errors = base.errors.filter(error=>selectedErrorIds.has(error.id)).map(error=>({...error,groupId:questionGroups.get(error.questionId) ?? error.groupId}));
    } else if (basis) {
      const authoredErrors = new Set([...(basis.focus.errorIds ?? []),...(strategy?.actions ?? []).flatMap(action=>action.errorIds ?? [])]);
      spine.errors = base.errors.filter(error=>authoredErrors.has(error.id));
    }
    const derived = await this.spine.actions(spine);
    const view = await this.spine.strategy(spine, derived, measured);
    const freshness = await geoPlanFreshness(this.store, project, strategy?.basis, scoped ? selected ? geoPlanCanonicalScope(selected.scope, selected.questions) : geoReadScopeInput(filter) : null, {sourceId:filter.sourceId,url:filter.url});
    return { ...view, scope: selected?.scope ?? basis?.scope ?? null, selection: selected?.selection ?? null, scopeKey: strategy?.scopeKey ?? scopeKey,
      basis, readingsKind: context ? "submitted_input" : filter.strategyVersion != null || !selected && basis ? "frozen_basis" : selected ? "selected_current" : "project_current", previousPlanBasis: context?.mode === "strategy" ? strategy?.basis ?? null : null, inputContext: context ? {referenceId:filter.planContextRef,mode:context.mode} : null, basisDigest: basis ? geoPlanDigest(basis) : null, currentComparison: selected ? {selection:selected.selection, cells:selected.computed.cells} : null, freshness, implementation: { actions: derived.actions }, actualBudget: { href: "distribution" } };
  }

  // --- the runtime's reads (geo_read) -----------------------------------------------------

  async analysis(user, id, input = {}) {
    return this.analysisOf(await this.requireProject(user, id), input);
  }
  async analysisMembers(user, id, input = {}) {
    if(!input.rowKey||!input.columnKey)throw new HttpError(400,"geo_read_filter_invalid","Choose an exact aggregate member.");
    return readGeoAnalysis(this.store,await this.requireProject(user,id),input,false,{service:this});
  }
  async analysisOf(project, input = {}) {
    if (input.planContextRef) {
      if (Object.keys(input).some(key => !["planContextRef", "limit", "offset", "rowKey", "columnKey"].includes(key))
        || (input.rowKey != null || input.columnKey != null) && (typeof input.rowKey !== "string" || !input.rowKey || input.rowKey.length > 160 || input.columnKey !== "objects"))
        throw new HttpError(400, "geo_read_filter_invalid", "Use the frozen context without replacing its selection.");
      const row = await this.planContexts?.documents.get(project.userId, "geo-plan-context", input.planContextRef);
      if (!row || row.projectId !== project.projectId || row.payload.geoId !== project.id || !hasGeoFrozenAnalysisContext(row.payload) || row.payload.state !== "bound") throw new HttpError(404, "geo_plan_context_not_found", "The selected analysis is unavailable.");
      await this.requireProject({ id: row.payload.actorId }, project.id);
      return readFrozenGeoAnalysisPage(this.planContexts.documents, project, row, input);
    }
    return readGeoAnalysis(this.store, project, input, false, {service:this});
  }
  async selectedExport(user, project, body, exporter) {
    await this.requireProject(user, project.id, "run");
    if (!body.selectionRef || !/^[a-f0-9]{64}$/.test(body.expectedDigest ?? "") || !body.view) throw new HttpError(400, "geo_read_filter_invalid", "Choose the selected analysis and its revision.");
    const view = await freezeSelectedGeoAnalysis(this.store, project, { selectionRef: body.selectionRef, view: body.view, expectedDigest: body.expectedDigest }, {service:this});
    return exporter.requestFrozen(user, { project: { id: project.projectId, userId: project.userId }, reference: { kind: "geo-selected-analysis", geoId: project.id, selectionRef: view.selection.reference, digest: view.digest, view: view.view }, ...freezeGeoAnalysisDocument(view) }, body.formats ?? ["csv"]);
  }
  /**
   * What `geo_read` answers for one `what`, in the page's shapes, cut to the
   * tool's bounds: at most 50 items, answer text at most 4,000 characters;
   * the actions of a list under the domain's character budget.
   * The filter is validated by the gateway.
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {string} what
   * @param {Record<string, any>} filter
   */
  async runtimeRead(project, what, filter = {}) {
    switch (what) {
      case "signal":
        if (!this.signalInputs) throw new HttpError(503, "geo_unavailable", "Signal inputs are unavailable.");
        return this.signalInputs.read(project, filter);
      case "analysis":
        return this.analysisOf(project, filter);
    }
    if (["project", "questions", "diagnosis", "metrics", "snapshots", "errors", "sources", "monitoring", "clusters", "targets"].includes(what)
      && !geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.runtimeRead(project, what, filter));
    this.counters.reads += 1;
    const limit = Math.min(filter.limit ?? 20, GEO_READ_MAX_ITEMS);
    const offset = filter.offset ?? 0;
    /** @template T @param {T[]} list */
    const page = (list) => ({ items: list.slice(offset, offset + limit), total: list.length, more: list.length > offset + limit });
    switch (what) {
      case "value": return this.valueOf(project, filter);
      case "research": return { items: await this.store.researchRequests(project.id) };
      case "project": {
        const view = await this.projectViewOf(project, geoReadScopeInput(filter));
        return { project: { id: view.id, name: view.name, product: view.product, competitors: view.competitors, coverageDays: view.coverageDays,
          engines: view.engines, tier: view.tier, status: view.status, steps: view.steps }, overview: view.overview, scope: view.scope, selection: view.selection, comparison: view.comparison };
      }
      case "claims": {
        const evidence = await this.evidenceOf(project);
        const claims = page(evidence.claims);
        return { product: evidence.product, competitors: evidence.competitors, claims: claims.items, total: claims.total, more: claims.more };
      }
      case "diagnosis_progress": return this.diagnosisProgressOf(project, String(filter.round ?? ""), { limit: Math.min(limit, 50), offset });
      case "questions": {
        const scope = geoReadScopeInput(filter);
        const view = Object.keys(scope).length ? await this.scopedQuestionsOf(project, scope) : await this.questionsOf(project, null);
        const groups = page(view.groups.filter((group) => (!filter.pool || group.pool === filter.pool) && (!filter.groupId || group.id === filter.groupId)));
        return { ...view, groups: groups.items, total: groups.total, more: groups.more };
      }
      case "journey": return this.journeyOf(project);
      // The product zone's evidence cards, which the lower layers cite (flywheel F21): each claim with its id, quotation, ✓/⚠ and the
      // reference to write after a sentence that stands on it. A deployment without evidence zones, or a project with no cards yet, has none.
      case "cards": {
        const view = this.cards?.list ? await this.cards.list(project) : { zoneId: null, cards: [] };
        const cards = page(view.cards);
        return { zoneId: view.zoneId, cards: cards.items, total: cards.total, more: cards.more };
      }
      // The page's diagnosis, its two lists paged like every other read: the errors it lists and the round's other metrics, one offset
      // for both. 2026-10-25: both were cut at the limit with no offset, and the second was named `more`, so the answer could never
      // say there was a next page; the errors behind a long list are read whole with `errors`, whose counts this answer keeps.
      case "diagnosis": {
        // The errors are paged where they are read (`errorPage`), the other metrics here: one `offset` for both, and the page says how
        // many there are and where the next one starts, as every other read does.
        const { more: otherList = [], ...view } = await this.diagnosisOf(project, { ...geoReadScopeInput(filter), ...filter,
          errorLimit: filter.errorLimit ?? limit, errorOffset: filter.errorOffset ?? offset });
        const metrics = page(Array.isArray(otherList) ? otherList : []);
        const errorsTotal = Number(view.errorPage?.total ?? view.errors?.length ?? 0);
        const more = Boolean(view.errorPage?.more) || metrics.more;
        return { ...view, errorsTotal, otherMetrics: metrics.items, otherMetricsTotal: metrics.total, more, ...(more ? { nextOffset: offset + limit } : {}) };
      }
      case "metrics": {
        const selected = await readGeoSelection(this.store, project, geoReadScopeInput(filter));
        const stored = (await this.store.query(`SELECT DISTINCT ON (scope, metric_id, coalesce(pool, ''), coalesce(engine, ''), coalesce(group_id, ''), coalesce(arm, ''), coalesce(variant, ''), coalesce(rival, '')) *
          FROM evimed_geo.metrics WHERE geo_project_id = $1 AND round_id = ANY($2::text[])
          ORDER BY scope, metric_id, coalesce(pool, ''), coalesce(engine, ''), coalesce(group_id, ''), coalesce(arm, ''), coalesce(variant, ''), coalesce(rival, ''), computed_at DESC, id DESC`,
        [project.id, selected.selection.roundIds])).rows;
        const fullRound = selected.rounds.length === 1 && !selected.subset && !selected.scope.from && !selected.scope.to
          && ![selected.scope.engines, selected.scope.pools, selected.scope.groupIds, selected.scope.clientTags].some((values) => values.length);
        const historic = fullRound && stored.length && stored.every((row) => row.method_version == null) && !selected.rows.some((row) => row.facts);
        const values = historic ? stored.map((row) => metricView(row, this.metricName)) : selected.computed.cells.map((entry) => ({
          metricId: entry.metricId, name: this.metricName(entry.metricId), scope: entry.scope, engine: entry.engine, pool: entry.pool, groupId: entry.groupId,
          arm: entry.arm, variant: entry.variant, rival: entry.rival, roundId: selected.rounds.length === 1 ? selected.rounds[0].id : null, computedAt: null, cell: entry }));
        const items = page(values);
        return { scope: selected.scope, selection: selected.selection, items: items.items, total: items.total, more: items.more };

      }
      case "snapshots": {
        const selected = await readGeoSelection(this.store, project, geoReadScopeInput(filter));
        let members = selected.rows.filter((row) => !filter.questionId || row.questionId === filter.questionId);
        if (filter.member) {
          const { observationDate, observationRound, ...descriptor } = filter.member;
          const computed = observationDate ? geoDailyReadings(selected, observationDate)[0]?.result : observationRound ? geoRoundReadings(selected, observationRound) : selected.computed;
          const metric = computed?.cells.find((entry) => Object.entries(descriptor).every(([key, value]) => /** @type {any} */ (entry)[key] === value));
          if (!metric) throw failure(400, "geo_read_filter_invalid", "The metric is not in this selection.");
          const inputRows = metric.scope === "engine" || metric.scope === "pool_engine" || metric.metricId === "M-20" ? computed.balance.deduped : computed.balance.rows;
          members = geoMetricMembers(/** @type {any[]} */ (inputRows), metric, selected.metricOptions).rows;
        }
        const values = [project.id, members.map((row) => row.snapshotId)];
        const where = ["s.geo_project_id = $1", "s.id = ANY($2::text[])"];
        values.push(String(limit + 1), String(offset));
        const rows = (await this.store.query(`SELECT s.*, q.text AS question_text, coalesce(q.pool, g.pool) AS question_pool, f.brands, f.statements, f.failure_mode,
            f.mentions_ours, f.retrieval_triggered, f.cites_ours
          FROM evimed_geo.snapshots s LEFT JOIN evimed_geo.questions q ON q.id = s.question_id AND q.geo_project_id = s.geo_project_id AND q.user_id = s.user_id
            LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id AND g.geo_project_id = q.geo_project_id AND g.user_id = q.user_id
            LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id AND f.geo_project_id = s.geo_project_id AND f.user_id = s.user_id
          WHERE ${where.join(" AND ")} ORDER BY s.asked_at DESC NULLS LAST, s.id
          LIMIT $${values.length - 1}::integer OFFSET $${values.length}::integer`, values)).rows;
        return {
          scope: selected.scope, selection: selected.selection, total: members.length, nextOffset: offset + limit < members.length ? offset + limit : null,
          items: rows.slice(0, limit).map((/** @type {any} */ row) => {
            const answer = text(row.answer_text) ?? "";
            return {
              id: String(row.id), roundId: text(row.round_id), questionId: text(row.question_id), question: text(row.question_text),
              pool: text(row.question_pool), engine: text(row.engine), askedAt: iso(row.asked_at), status: text(row.status),
              answerText: answer.slice(0, GEO_ANSWER_TEXT_LIMIT), answerTruncated: answer.length > GEO_ANSWER_TEXT_LIMIT,
              citations: Array.isArray(row.citations) ? row.citations.slice(0, 30) : [],
              facts: row.failure_mode == null && row.brands == null ? null : {
                failureMode: text(row.failure_mode), mentionsOurs: row.mentions_ours ?? null, retrievalTriggered: row.retrieval_triggered ?? null,
                citesOurs: row.cites_ours ?? null, brands: Array.isArray(row.brands) ? row.brands : [], statements: Array.isArray(row.statements) ? row.statements : [],
              },
            };
          }),
          more: rows.length > limit,
        };
      }
      case "errors": {
        const selected = await readGeoSelection(this.store, project, geoReadScopeInput(filter));
        const errorData = await readGeoSelectionErrors(this.store, project, selected, { ...filter, errorLimit: filter.errorLimit ?? limit, errorOffset: filter.errorOffset ?? offset });
        return { scope: selected.scope, selection: selected.selection, items: errorData.rows.map((row) => ({ ...errorView(row), evidenceQuote: text(row.evidence_quote),
          claimId: text(row.claim_id), responsible: text(row.responsible), materials: Array.isArray(row.materials) ? row.materials : [] })),
          total: errorData.page.total, more: errorData.page.more, page: errorData.page, summary: errorData.summary };
      }
      case "sources": {
        if (filter.sourceId) return this.sourceOf(project, filter.sourceId, filter);
        const view = await this.sourcesOf(project, geoReadScopeInput(filter));
        const sources = page(view.sources);
        return { ...view, sources: sources.items, total: sources.total, more: sources.more };
      }
      case "strategy": {
        const view = await this.strategyOf(project, filter);
        const strategy = view.version == null ? null : await this.store.latestStrategy(project.id, { strategyVersion: view.version });
        return { strategy, placementPlan: await this.store.latestPlacementPlan(project.id), view };
      }
      case "targets": {
        if (filter.strategyVersion || filter.planContextRef) { const plan = await this.strategyOf(project, filter); return { tiers: plan.targets, chosenTier: plan.chosenTier, basis: plan.basis }; }
        const view = await this.sourcesOf(project, geoReadScopeInput(filter));
        return { tiers: view.tiers, chosenTier: view.chosenTier };
      }
      case "articles": {
        const view = await this.articlesOf(project);
        const articles = page(view.articles);
        return { articles: articles.items, total: articles.total, more: articles.more };
      }
      case "orders": {
        const view = await this.distributionOf(project);
        const orders = page(view.orders);
        return { budget: view.budget, spentCny: view.spentCny, reservedCny: view.reservedCny, orders: orders.items, total: orders.total, more: orders.more };
      }
      case "owned_links": {
        const links = page(await this.store.ownedLinks(project.id));
        return { links: links.items, total: links.total, more: links.more };
      }
      case "monitoring": return this.monitoringOf(project, geoReadScopeInput(filter));
      // The question group as the spine: what the engines say about each, and what is being done for it and what came of it. The same
      // methods the page reads (`clustersOf`, `actionsOf`), so a number quoted from here is the page's.
      case "clusters": {
        const view = await this.clustersOf(project, geoReadScopeInput(filter));
        const groups = page(view.groups.filter((group) => (!filter.pool || group.pool === filter.pool) && (!filter.groupId || group.id === filter.groupId)));
        return { scope: view.scope, selection: view.selection, comparison: view.comparison, version: view.version, round: view.round, floor: view.floor, engines: view.engines, groups: groups.items, total: groups.total, more: groups.more };
      }
      // A list is read lean: a row per action with every number and none of the run's long words, under a character budget, and the
      // sums (`counts`, whole project) are the platform's — the model quotes them and adds nothing up. One action (`key`), or a group's
      // (`groupId`), is read whole. A page the budget cut says where the next one starts (`nextOffset`) and how many rows are left.
      case "actions": {
        const view = await this.actionsOf(project);
        const matching = view.actions.filter((action) => (!filter.pool || action.group?.pool === filter.pool) && (!filter.groupId || action.group?.id === filter.groupId)
          && (!filter.engine || action.engines.includes(filter.engine)) && (!filter.key || action.key === filter.key));
        if (filter.key && !matching.length) throw failure(404, "geo_action_not_found", "This project has no action with that key; read the list (no filter) and copy a key from it.");
        const whole = filter.key != null || filter.groupId != null;
        const head = { tier: view.tier, round: view.round, floor: view.floor, headline: view.headline, counts: view.counts, detail: whole ? "whole" : "lean" };
        const control = view.control.map((group) => group.name);
        if (whole) {
          const items = page(matching);
          return { ...head, actions: items.items.map(compactAction), total: items.total, more: items.more, control };
        }
        const lean = geoLeanActionsPage(matching, { offset, limit });
        return { ...head, actions: lean.rows, total: lean.total, more: lean.more, ...(lean.more ? { nextOffset: lean.nextOffset, omitted: lean.omitted } : {}), control };
      }
      default:
        throw failure(400, "geo_read_what_invalid", "Unknown read.");
    }
  }

  // --- metrics for the operator endpoint ----------------------------------------------------

  /** @param {any} user @param {string} id */
  async value(user, id) { return this.valueOf(await this.requireProject(user, id)); }

  /**
   * Research metadata stays behind the page's findings and actions. The coverage is counted where it is stored and the reply
   * carries at most `GEO_VALUE_OBSERVATIONS_SHOWN` of the observations behind it, with their `observationsTotal` (D-08).
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {{groupId?: string, audience?: string, engine?: string, version?: number}} [filter]
   */
  async valueOf(project, filter = {}) {
    const [profile, research, articles] = await Promise.all([
      this.store.latestValue(project.id, filter.version ?? null), this.store.researchRequests(project.id), this.store.listArticles(project.id),
    ]);
    const { counts, sample } = profile.version
      ? await this.store.valueCoverage(project.id, { engine: filter.engine ?? null, groupId: filter.groupId ?? null, audience: filter.audience ?? null })
      : { counts: [], sample: [] };
    // One value basis at a time, never two mixed. A round freezes the profile it was judged against
    // (the evaluation basis `GeoMeasureStore.startRound` freezes), so a profile written after the round — a new finding, an
    // imported research result, a source change — must not hide what that round measured until the
    // next one: without a version asked for, the observations are read against the newest basis the
    // round used, and the reply names it so the page can say the current profile is newer.
    const bases = counts.map((entry) => Number(entry.basisVersion)).filter((version) => Number.isInteger(version) && version > 0);
    const basisVersion = filter.version != null ? profile.version : (bases.length ? Math.max(...bases) : null);
    const onBasis = basisVersion == null ? [] : counts.filter((entry) => entry.basisVersion === basisVersion);
    /** @type {Record<string, number>} */
    const byStatus = {};
    for (const entry of onBasis) if (entry.status) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + entry.n;
    const assessment = { completeObservations: 0, partialObservations: 0, unknownObservations: 0 };
    for (const entry of onBasis) {
      const key = entry.judgementCoverage === "complete" ? "completeObservations"
        : entry.judgementCoverage === "partial" ? "partialObservations" : "unknownObservations";
      assessment[key] += entry.n;
    }
    const observations = basisVersion == null ? [] : sample.filter((observation) => observation.basisVersion === basisVersion).slice(0, GEO_VALUE_OBSERVATIONS_SHOWN);
    // The changed sources a reader is asked to look at are those that reach a finding that still stands: a change that names no finding
    // of the profile, or whose findings were retired since, asks for no look at anything. Nothing closes such a change, so counting every
    // standing one made the count only grow (D-19); the total is kept beside it, and every change stays in `data.sourceChanges`.
    const impacts = geoValueImpacts(profile.data, articles);
    const standing = new Set(geoValueList(profile.data.findings).filter((finding) => finding && typeof finding === "object" && geoValueActive(finding)).map((finding) => finding.id));
    // A version asked for that is not stored — pruned, since the project keeps its latest versions and its milestones, or never written —
    // is said so, not read as an empty profile (`version: 0` on its own looks like a project with nothing in it).
    const gone = filter.version != null && !profile.version
      ? { requestedVersion: filter.version, notice: `Version ${filter.version} of the value profile is not stored: a project keeps its latest versions and its milestone ones.` } : {};
    return { ...profile, data: { ...profile.data, ...geoValueContext(profile.data, filter) }, research,
      impacts: impacts.filter((impact) => impact.findingIds.some((id) => standing.has(id))), impactsTotal: impacts.length,
      coverage: { ...summarizeGeoValueCoverageCounts(byStatus), basisVersion, assessment }, observations,
      observationsTotal: onBasis.reduce((total, entry) => total + entry.n, 0), ...gone };
  }

  /** Counts for `/api/ops/metrics`, one query. */
  async metricsSnapshot() {
    await this.ready();
    const row = (await this.store.query(`SELECT
        (SELECT count(*) FROM evimed_geo.projects WHERE deleted_at IS NULL)::integer AS projects,
        (SELECT count(*) FROM evimed_geo.projects WHERE deleted_at IS NULL AND status = 'active')::integer AS active,
        (SELECT count(*) FROM evimed_geo.errors WHERE judgment_state='active' AND status <> 'closed')::integer AS open_errors,
        (SELECT count(*) FROM evimed_geo.errors WHERE judgment_state='active' AND status <> 'closed' AND severity = ANY($1::text[]))::integer AS urgent_errors,
        (SELECT count(*) FROM evimed_geo.articles WHERE safety = 'open' AND status <> 'withdrawn')::integer AS safety_stops,
        (SELECT count(*) FROM evimed_geo.rounds WHERE status IN ('queued', 'running'))::integer AS open_rounds`, [[...GEO_URGENT_SEVERITIES]])).rows[0] ?? {};
    return {
      projects: Number(row.projects ?? 0), active: Number(row.active ?? 0), openErrors: Number(row.open_errors ?? 0),
      urgentErrors: Number(row.urgent_errors ?? 0), safetyStops: Number(row.safety_stops ?? 0), openRounds: Number(row.open_rounds ?? 0),
    };
  }
}

/** A readiness failure as `readinessCheck` in `server.mjs` reads one. @param {string} code @param {Record<string, any> | null} [details] */
function readinessFailure(code, details = null) {
  /** @type {Error & Record<string, any>} */
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

/**
 * The `geo` readiness check. Red only for the module's own invariants: the
 * schema migrated and the service composed. The social channel and the
 * marketplace are outside the platform and read as warnings on a green check;
 * the worker slot is filled by the orchestration package, and until it is,
 * the check says so without going red. Off, the check is green and says so.
 * @param {{ config: Record<string, any>, geo: any, database: any }} input
 */
export async function geoReadiness({ config, geo, database }) {
  if (!config.geoEnabled) return { required: false, enabled: false };
  if (!geo || !database) throw readinessFailure("geo_unavailable", { reason: database ? "not_composed" : "no_product_database" });
  try {
    await geo.service.ready();
  } catch (error) {
    throw readinessFailure("geo_migration_failed", { reason: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "migration_error" });
  }
  const warnings = [];
  if (!geo.worker) warnings.push("geo_worker_missing");
  if (!String(config.geoSocialUrl ?? "").trim()) warnings.push("geo_social_unconfigured");
  if (!geoMarketConfigured(config)) warnings.push("geo_market_unconfigured");
  return {
    required: true, enabled: true, audience: config.geoAudience, engines: config.geoEngines,
    social: geo.social?.status?.() ?? null,
    market: { configured: geoMarketConfigured(config) },
    worker: geo.worker?.status?.() ?? null,
    ...(warnings.length ? { warning: warnings[0], warnings } : {}),
  };
}

/**
 * Everything the metrics endpoint shows about the module, read once per scrape.
 * @param {{ service: GeoService, social?: any, worker?: any, cards?: any, questionBank?: any, valueUpkeep?: { metrics?: () => Record<string, number> } | null,
 *   importDelivery?: { counters?: { imported: number, failed: number } } | null,
 *   measureState?: { checkTotals?: Record<string, number>, inclusionTotals?: Record<string, number> } | null }} geo
 */
export async function geoMetricsSnapshot(geo) {
  let tables = null;
  try { tables = await geo.service.metricsSnapshot(); } catch { tables = null; }
  return { tables, service: { ...geo.service.counters }, writeFields: [...(geo.service.fieldTotals ?? new Map())].map(([key, value]) => {
    const [what, outcome] = key.split("\u0000");
    return { what, outcome, value };
  }), social: geo.social?.status?.() ?? null, worker: geo.worker?.status?.() ?? null,
    cards: geo.cards?.metrics?.() ?? null, checks: geo.measureState?.checkTotals ?? null, inclusion: geo.measureState?.inclusionTotals ?? null,
    questionBank: geo.questionBank?.metrics?.() ?? null, valueUpkeep: geo.valueUpkeep?.metrics?.() ?? null,
    imports: geo.importDelivery?.counters ? { ...geo.importDelivery.counters } : null };
}

/**
 * The `open_science_geo_*` families, in the shape `addMetric` in `server.mjs`
 * takes. With the module off there is one line: `open_science_geo_enabled 0`.
 * @param {boolean} enabled @param {Awaited<ReturnType<typeof geoMetricsSnapshot>> | null} snapshot
 * @returns {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]}
 */
export function geoMetricFamilies(enabled, snapshot) {
  /** @type {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]} */
  const families = [{ name: "open_science_geo_enabled", help: "Whether the 循证 GEO module is composed in this process.", type: "gauge",
    series: [{ value: enabled && snapshot ? 1 : 0 }] }];
  if (!enabled || !snapshot) return families;
  /** @param {string} name @param {string} help @param {"gauge" | "counter"} type @param {{ value: number, labels?: Record<string, string> }[]} series */
  const add = (name, help, type, series) => families.push({ name: `open_science_geo_${name}`, help, type, series });
  add("tables_readable", "Whether the module's tables answered the metrics read.", "gauge", [{ value: snapshot.tables ? 1 : 0 }]);
  if (snapshot.tables) {
    const tables = snapshot.tables;
    add("projects", "GEO projects by state (not deleted).", "gauge", [
      { labels: { state: "all" }, value: tables.projects },
      { labels: { state: "active" }, value: tables.active },
    ]);
    add("open_errors", "讲错我方 findings not yet closed, and those of severity S3 or S4.", "gauge", [
      { labels: { severity: "any" }, value: tables.openErrors },
      { labels: { severity: "urgent" }, value: tables.urgentErrors },
    ]);
    add("safety_stops", "Articles held by an open clinical-safety finding.", "gauge", [{ value: tables.safetyStops }]);
    add("open_rounds", "Measurement rounds queued or running.", "gauge", [{ value: tables.openRounds }]);
  }
  const service = snapshot.service ?? {};
  add("service_total", "What the service did since this process started (researchCapped: research requests over OPEN_SCIENCE_GEO_RESEARCH_MAX_OPEN, answered with a notice).", "counter",
    ["projectsCreated", "reads", "writes", "writeIssues", "notFound", "forbidden", "researchCapped"].map((kind) => ({ labels: { kind }, value: Number(/** @type {any} */ (service)[kind] ?? 0) })));
  // Fields a run wrote that the platform does not keep, by the write (a closed list): the evidence for storing one, or for telling the
  // capability not to write it. The import of a run's files counts under what it wrote through (`run_import`).
  if (snapshot.writeFields?.length || snapshot.imports) {
    const imports = snapshot.imports ?? {};
    add("write_fields_total", "Fields of runs' writes the platform did not keep since this process started, by the write (`what`) and outcome: ignored (a key it does not know, told to the run) or declined (on its stated list of what it does not keep).", "counter",
      [...(snapshot.writeFields ?? []).map((entry) => ({ labels: { what: entry.what, outcome: entry.outcome }, value: Number(entry.value) })),
        { labels: { what: "run_files", outcome: "ignored" }, value: Number(/** @type {any} */ (imports).ignoredFields ?? 0) },
        { labels: { what: "run_files", outcome: "declined" }, value: Number(/** @type {any} */ (imports).declinedFields ?? 0) }]);
  }
  // The evidence chain (flywheel F21): the product zone's cards made from the claim table, and what was held back or refused.
  if (snapshot.cards) {
    add("cards_total", "Product-zone card writes since this process started, by what happened.", "counter",
      ["zonesMade", "cardsCreated", "cardsUpdated", "cardsUnchanged", "claimsCarded", "claimsHeld", "refused", "referencesChecked", "referencesUnresolved",
        "articlesFlagged"].map((event) => ({ labels: { event }, value: Number(/** @type {any} */ (snapshot.cards)[event] ?? 0) })));
  }
  // What a finished run delivered and the import registered (geoDeliveryImport.mjs): a failed attempt lost a write (its value profile, claims
  // or competitors) and is on the audit record as `geo.import`; the run is tried once more and then left.
  if (snapshot.imports) {
    add("run_import_total", "Finished runs' deliveries imported into their GEO projects since this process started: runs imported whole, and attempts that lost a write or threw.", "counter",
      ["imported", "failed"].map((outcome) => ({ labels: { outcome }, value: Number(/** @type {any} */ (snapshot.imports)[outcome] ?? 0) })));
  }
  // The value profiles' upkeep (geoValueUpkeep.mjs): ticks, projects looked at, and the versions pruned (OPEN_SCIENCE_GEO_VALUE_KEEP_VERSIONS); and the
  // source watch: projects whose findings' sources were looked up, the sources they rest on, and the retractions and corrections added to a profile.
  if (snapshot.valueUpkeep) {
    add("value_upkeep_total", "The value profiles' upkeep since this process started: ticks, projects over the version limit that were looked at, versions pruned and projects they were pruned from, projects whose findings' sources were looked up and the sources they rest on, changes of a source (a retraction, a correction) added to a profile or linked to a finding written since, projects that gained any, and passes that failed.", "counter",
      Object.entries(snapshot.valueUpkeep).map(([event, value]) => ({ labels: { event }, value: Number(value) })));
  }
  // The platform's own medication-question bank (flywheel F22), where the deployment has it on.
  if (snapshot.questionBank) {
    add("question_bank_total", "The medication-question bank since this process started: daily passes, rounds asked, engines answered or skipped, official claims synced, errors read for the topic selector.", "counter",
      ["ticks", "rounds", "enginesDone", "enginesSkipped", "claimsSynced", "errorsRead"].map((event) => ({ labels: { event }, value: Number(/** @type {any} */ (snapshot.questionBank)[event] ?? 0) })));
  }
  // What the judge's three checks and the cited-link checks found (counted, never decided on).
  if (snapshot.checks) {
    add("checks_total", "What the judge's checks found in measured answers since this process started: a claim beyond the label, safety information left out, and the cited links (exists, missing, unreadable, what the page says).", "counter",
      Object.entries(snapshot.checks).map(([check, value]) => ({ labels: { check }, value: Number(value) })));
  }
  // The inclusion channel (Baidu): requests taken, polled, answered, failed, and given up on after OPEN_SCIENCE_GEO_INCLUSION_MAX_HOLD_HOURS.
  if (snapshot.inclusion && Object.keys(snapshot.inclusion).length) {
    add("inclusion_total", "What the inclusion-check channel did since this process started (expired: a check still pending at OPEN_SCIENCE_GEO_INCLUSION_MAX_HOLD_HOURS, its job failed so its round can close).", "counter",
      Object.entries(snapshot.inclusion).map(([event, value]) => ({ labels: { event }, value: Number(value) })));
  }
  const social = snapshot.social;
  if (social?.counters) {
    add("social_requests_total", "Social-channel requests by outcome.", "counter",
      Object.entries(social.counters).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
  }
  // The worker, which readiness shows and nothing alerted on (2026-09-26
  // audit, I3-7: a probe host logged out, engines paused and 11 urgent
  // findings open, all visible only to someone reading /api/ready). A loop's
  // last success and whether it is past its lease, for the wired loops; and
  // how many engines the probe's breaker has paused after its last tick.
  const worker = snapshot.worker;
  const loops = Object.entries(worker?.loops ?? {}).filter(([, loop]) => loop?.wired);
  if (loops.length) {
    add("loop_last_ok_timestamp_seconds", "When each GEO worker loop last finished without an error (Unix seconds; 0 = not since this process started).", "gauge",
      loops.map(([loop, state]) => ({ labels: { loop }, value: state.lastOkAt ? Math.floor(Date.parse(state.lastOkAt) / 1000) : 0 })));
    add("loop_stalled", "Whether a GEO worker loop is still running past its lease (OPEN_SCIENCE_GEO_LEASE_MS).", "gauge",
      loops.map(([loop, state]) => ({ labels: { loop }, value: state.stalled ? 1 : 0 })));
  }
  const paused = worker?.loops?.probe?.last?.paused;
  if (typeof paused === "number") {
    add("probe_paused_engines", "Consumer AI engines the probe's circuit breaker has paused after its last tick (a login page, an empty shell or errors in a row).", "gauge",
      [{ value: paused }]);
  }
  return families;
}
