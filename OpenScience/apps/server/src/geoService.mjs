/**
 * What 「循证 GEO」's pages are served (build spec 2026-09-25 §3), and the
 * module's switch, readiness and metrics.
 *
 * Hidden knowledge:
 *
 * - **Numbers are read, never computed here.** Every rate, index and interval
 *   on a page is a row of `evimed_geo.metrics` the measurement package wrote,
 *   with its numerator, denominator, interval, status and data type. A cell
 *   no row speaks for is `absent` (「未测」), never zero; the counts shown
 *   beside a table (failure modes, the most-mentioned competitor) are tallies
 *   of fact rows, not metrics. So the pages and the weekly report can never
 *   disagree about a number: they read the same row.
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
 * - **Off is invisible** (`geoAudienceAllows`): the module off, or on for
 *   operators and the preview list only while this account is neither, reads
 *   as a module that does not exist — the routes answer 404 `geo_not_enabled`
 *   and the runtime is given no tools.
 *
 * @module geoService
 */

import path from "node:path";
import {
  GEO_ARM_METRIC_ID, GEO_DEFAULT_ENGINES, GEO_ENGINE_LABELS_ZH, GEO_VIEW_METRIC_IDS, GEO_METRIC_LABELS_ZH, GEO_ORDER_CANCELLABLE_STATES,
  GEO_OVERVIEW_METRICS, GEO_POOLS, GEO_ROUND_KIND_LABELS_ZH, GEO_URGENT_SEVERITIES, GEO_ENGINES, geoCellRows,
} from "@evimed/domain";
import { geoLockCheck, geoProgramMinimal } from "./geoWrites.mjs";
import { HttpError } from "./security.mjs";
import { GEO_ORDER_ARTICLE_LIVE_STATES, projectMoney } from "./geoMarketStore.mjs";
import { mediaMarketConfigured } from "./mediaMarketClient.mjs";

/** @typedef {{ value: number | null, numerator: number | null, denominator: number | null, ciLow: number | null, ciHigh: number | null,
 *   status: string, dataType: string, reason: string | null }} GeoCell */

/** The cell no row speaks for: 「未测」, never zero. */
export const GEO_ABSENT_CELL = Object.freeze({ value: null, numerator: null, denominator: null, ciLow: null, ciHigh: null, status: "absent", dataType: "measured",
  reason: null });

/** Snapshot text handed to a run, per item (spec §4). */
export const GEO_ANSWER_TEXT_LIMIT = 4_000;
/** Items one runtime read returns at most (spec §4). */
export const GEO_READ_MAX_ITEMS = 50;

/** The name a new GEO project's control-plane project gets when no brand is given yet. */
export const GEO_DEFAULT_PROJECT_NAME = "新 GEO 项目";

const DIAGNOSIS_ROUND_KINDS = Object.freeze(["baseline", "weekly", "single_step"]);
/** The measurement package writes one `NOISE` row per metric (its `variant`); the band shown is mention's. */
const NOISE_BAND_OF = GEO_VIEW_METRIC_IDS.mention;
/** …and the project-scope `NET` row of the index (pool-scope rows carry each pool's metric). */
const NET_EFFECT_OF = GEO_VIEW_METRIC_IDS.gvi;
const TREND_POINTS = 26;
const WEEK_ITEMS = 5;
const WEEK_MS = 7 * 86_400_000;
const SHA256 = /^[a-f0-9]{64}$/;

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
 * operator list is). The default audience is `operators`.
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

/** @param {any} row @returns {GeoCell} */
export function geoCellFromRow(row) {
  if (!row) return { ...GEO_ABSENT_CELL };
  return {
    value: num(row.value), numerator: num(row.numerator), denominator: num(row.denominator), ciLow: num(row.ci_low), ciHigh: num(row.ci_high),
    status: String(row.status), dataType: String(row.data_type ?? "measured"), reason: text(row.reason),
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
  if (controlName && controlName !== GEO_DEFAULT_PROJECT_NAME) return controlName;
  return brand || controlName || GEO_DEFAULT_PROJECT_NAME;
}

/** A calendar day in a time zone, `YYYY-MM-DD`. @param {Date} date @param {string} timeZone */
function dayIn(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** A metric row's day: its round's sample date, else the day it was computed in the module's zone. @param {any} row @param {string} timeZone */
function rowDay(row, timeZone) {
  if (row.sample_date) return typeof row.sample_date === "string" ? row.sample_date.slice(0, 10) : dayIn(new Date(row.sample_date), timeZone);
  return dayIn(new Date(row.computed_at), timeZone);
}

/** The next Monday on or after tomorrow, in the zone. @param {Date} now @param {string} timeZone */
function nextMonday(now, timeZone) {
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 86_400_000);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(candidate);
    if (weekday === "Mon") return dayIn(candidate, timeZone);
  }
  return dayIn(now, timeZone);
}

/** @param {unknown} value @param {number} max */
const clip = (value, max) => {
  const string = String(value ?? "").replace(/\s+/g, " ").trim();
  return string.length > max ? `${string.slice(0, max - 1)}…` : string;
};

/** @param {string} engine */
const engineLabel = (engine) => /** @type {Record<string, string>} */ (GEO_ENGINE_LABELS_ZH)[engine] ?? engine;

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
    questionId: text(row.question_id),
    // What the statement contradicts: the claim and its quote (对的是什么 / 依据哪份说明书).
    claimId: text(row.claim_id),
    evidenceQuote: text(row.evidence_quote),
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

/** How many snapshot ids a cell carries at most (the first is where a click lands). */
export const GEO_CELL_SNAPSHOT_LIMIT = 200;

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

export class GeoService {
  /**
   * @param {{ store: import("./geoStore.mjs").GeoStore, config: Record<string, any>, social?: any, now?: () => Date,
   *   metricName?: ((metricId: string) => string | null) | null }} options
   *   `metricName` names a metric id for 「更多指标」; the metrics package can
   *   hand in its catalogue's names, and without it the domain's labels answer
   *   for the ids the platform reads and every other id is its own name.
   */
  constructor({ store, config, social = null, now = () => new Date(), metricName = null }) {
    if (!store || !config) throw new TypeError("The GEO service needs its store and the config.");
    this.store = store;
    this.config = config;
    this.social = social;
    this.now = now;
    this.timeZone = String(config.geoTimeZone || "Asia/Shanghai");
    /** @param {string} metricId */
    this.metricName = (metricId) => metricName?.(metricId) ?? /** @type {Record<string, string>} */ (GEO_METRIC_LABELS_ZH)[metricId] ?? null;
    this.counters = { projectsCreated: 0, reads: 0, writes: 0, writeIssues: 0, notFound: 0 };
  }

  ready() { return this.store.ready(); }

  /** @param {{ id?: string }} user */
  allows(user) { return geoAudienceAllows(this.config, user); }

  /** @param {{ id?: string }} user */
  isOperator(user) { return (this.config.operatorUsers ?? []).includes(String(user?.id ?? "")); }

  /** The account's GEO project, or 404. @param {{ id: string }} user @param {string} id */
  async requireProject(user, id) {
    const project = typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? await this.store.getProject(String(user.id), id) : null;
    if (!project) {
      this.counters.notFound += 1;
      throw failure(404, "geo_project_not_found", "GEO project not found.");
    }
    return project;
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
    const result = await this.store.query(`SELECT DISTINCT ON (m.geo_project_id, m.metric_id) m.*, r.sample_date
      FROM evimed_geo.metrics m LEFT JOIN evimed_geo.rounds r ON r.id = m.round_id
      WHERE m.geo_project_id = ANY($1::text[]) AND m.scope = 'project' AND m.metric_id = ANY($2::text[]) AND m.arm IS NULL AND ${PLAIN_ROW}
      ORDER BY m.geo_project_id, m.metric_id, m.computed_at DESC`, [geoIds, [...metricIds]]);
    for (const row of result.rows) {
      const map = byProject.get(row.geo_project_id) ?? new Map();
      map.set(String(row.metric_id), row);
      byProject.set(row.geo_project_id, map);
    }
    return byProject;
  }

  /**
   * A metric's project-scope series: one point per round (its latest row),
   * oldest first, the last 26.
   * @param {string[]} geoIds @param {readonly string[]} metricIds
   * @returns {Promise<Map<string, Map<string, Array<{ date: string, value: number | null, n: number | null, k: number | null }>>>>}
   */
  async #series(geoIds, metricIds, scope = "project", extra = "") {
    // `extra` names a column spliced into the query: only these two ever are.
    if (extra && !["arm", "engine"].includes(extra)) throw new TypeError("A series splits by arm or engine only.");
    /** @type {Map<string, Map<string, Array<{ date: string, value: number | null, n: number | null, k: number | null }>>>} */
    const byProject = new Map();
    if (!geoIds.length) return byProject;
    const result = await this.store.query(`SELECT * FROM (
        SELECT DISTINCT ON (m.geo_project_id, m.metric_id, coalesce(m.round_id, m.id)${extra ? `, m.${extra}` : ""})
          m.*, r.sample_date
        FROM evimed_geo.metrics m LEFT JOIN evimed_geo.rounds r ON r.id = m.round_id
        WHERE m.geo_project_id = ANY($1::text[]) AND m.scope = $3 AND m.metric_id = ANY($2::text[]) AND m.pool IS NULL AND ${PLAIN_ROW}
        ORDER BY m.geo_project_id, m.metric_id, coalesce(m.round_id, m.id)${extra ? `, m.${extra}` : ""}, m.computed_at DESC
      ) latest ORDER BY computed_at`, [geoIds, [...metricIds], scope]);
    for (const row of result.rows) {
      const key = extra ? `${row.metric_id}\u0000${row[extra] ?? ""}` : String(row.metric_id);
      const map = byProject.get(row.geo_project_id) ?? new Map();
      const points = map.get(key) ?? [];
      points.push({ date: rowDay(row, this.timeZone), value: num(row.value), n: num(row.denominator), k: num(row.numerator) });
      map.set(key, points);
      byProject.set(row.geo_project_id, map);
    }
    for (const map of byProject.values()) for (const [key, points] of map) map.set(key, points.slice(-TREND_POINTS));
    return byProject;
  }

  /** The chosen tier's target for a metric, project-wide first. @param {Awaited<ReturnType<import("./geoStore.mjs").GeoStore["latestTargets"]>>} targets @param {string} tier @param {string} metricId */
  #target(targets, tier, metricId) {
    if (!targets) return null;
    const rows = targets.rows.filter((row) => row.tier === tier && row.metricId === metricId);
    const row = rows.find((candidate) => candidate.pool === "all") ?? rows[0];
    return row?.target ?? null;
  }

  // --- the home list ------------------------------------------------------------------

  /** `GET /api/geo/projects`. @param {{ id: string }} user */
  async listProjects(user) {
    const projects = await this.store.listProjects(String(user.id));
    const ids = projects.map((project) => project.id);
    const headline = [GEO_VIEW_METRIC_IDS.gvi, GEO_VIEW_METRIC_IDS.mentionHeadline];
    const [latest, series, names, alerts, targets, started] = await Promise.all([
      this.#latestProjectMetrics(ids, headline),
      this.#series(ids, [GEO_VIEW_METRIC_IDS.gvi]),
      this.#controlProjectNames(String(user.id), projects.map((project) => project.projectId)),
      this.#alerts(ids),
      Promise.all(projects.map((project) => this.store.latestTargets(project.id))),
      this.#startedAt(projects),
    ]);
    const availableEngines = geoAvailableEngines(this.config);
    return {
      projects: projects.map((project, index) => {
        const metrics = latest.get(project.id) ?? new Map();
        const trend = (series.get(project.id)?.get(GEO_VIEW_METRIC_IDS.gvi) ?? []).map((point) => point.value).filter((value) => value != null);
        const alert = alerts.get(project.id) ?? { wrongOurs: 0, safety: 0, text: null };
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

  /** @param {string} userId @param {string[]} projectIds */
  async #controlProjectNames(userId, projectIds) {
    /** @type {Map<string, string>} */
    const names = new Map();
    if (!projectIds.length) return names;
    try {
      const result = await this.store.query(`SELECT id, name FROM evimed_control.projects WHERE user_id = $1 AND id = ANY($2::text[])`, [userId, projectIds]);
      for (const row of result.rows) names.set(String(row.id), String(row.name));
    } catch {
      // A store without the control-plane schema (a unit test's double) names nothing.
    }
    return names;
  }

  /**
   * 讲错我方 still open and safety stops, per project, with the one sentence
   * the home row shows in red: the most severe open error, in the engine's name.
   * @param {string[]} geoIds @returns {Promise<Map<string, { wrongOurs: number, safety: number, text: string | null }>>}
   */
  async #alerts(geoIds) {
    /** @type {Map<string, { wrongOurs: number, safety: number, text: string | null }>} */
    const alerts = new Map();
    if (!geoIds.length) return alerts;
    const [errors, worst, safety] = await Promise.all([
      this.store.query(`SELECT geo_project_id, count(*)::integer AS n FROM evimed_geo.errors
        WHERE geo_project_id = ANY($1::text[]) AND status <> 'closed' GROUP BY geo_project_id`, [geoIds]),
      this.store.query(`SELECT DISTINCT ON (geo_project_id) geo_project_id, engine, statement FROM evimed_geo.errors
        WHERE geo_project_id = ANY($1::text[]) AND status <> 'closed'
        ORDER BY geo_project_id, severity DESC NULLS LAST, updated_at DESC`, [geoIds]),
      this.store.query(`SELECT geo_project_id, count(*)::integer AS n FROM evimed_geo.articles
        WHERE geo_project_id = ANY($1::text[]) AND safety = 'open' AND status <> 'withdrawn' GROUP BY geo_project_id`, [geoIds]),
    ]);
    const count = (/** @type {any} */ result) => new Map(result.rows.map((/** @type {any} */ row) => [row.geo_project_id, Number(row.n)]));
    const wrong = count(errors);
    const stops = count(safety);
    const sentences = new Map(worst.rows.map((/** @type {any} */ row) => [row.geo_project_id,
      row.statement ? `${engineLabel(String(row.engine))}：${clip(row.statement, 60)}` : null]));
    for (const id of geoIds) {
      alerts.set(id, { wrongOurs: wrong.get(id) ?? 0, safety: stops.get(id) ?? 0, text: sentences.get(id) ?? (stops.get(id) ? "有稿件的安全问题待确认" : null) });
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
   *   bindSession: (user: any, projectId: string) => Promise<{ sessionId: string, bound: boolean }> }} hooks
   */
  async createProject(user, input, hooks) {
    const name = input.brandName || GEO_DEFAULT_PROJECT_NAME;
    const control = await hooks.createControlProject(user, name);
    const engines = input.engines?.length ? input.engines : (this.config.geoEngines?.length ? this.config.geoEngines : GEO_DEFAULT_ENGINES);
    const project = await this.store.createProject({
      userId: String(user.id), projectId: control.id, engines, coverageDays: input.coverageDays ?? 90,
      product: input.brandName ? { brandName: input.brandName } : {},
    });
    const session = await hooks.bindSession(user, control.id);
    this.counters.projectsCreated += 1;
    return { id: project.id, projectId: control.id, sessionId: session.sessionId, bound: session.bound };
  }

  /**
   * `PATCH /api/geo/projects/:id`.
   * @param {{ id: string }} user @param {string} id @param {{ coverageDays?: number, engines?: string[], tier?: string, status?: string }} patch
   */
  async updateProject(user, id, patch) {
    await this.requireProject(user, id);
    const updated = await this.store.updateProject(String(user.id), id, patch);
    if (!updated) throw failure(404, "geo_project_not_found", "GEO project not found.");
    return updated;
  }

  /** `DELETE /api/geo/projects/:id`: hidden from 循证 GEO; the project's conversations and files stay. @param {{ id: string }} user @param {string} id */
  async deleteProject(user, id) {
    const project = await this.requireProject(user, id);
    await this.store.softDeleteProject(String(user.id), id);
    return { id, projectId: project.projectId, deleted: true };
  }

  // --- the project page -------------------------------------------------------------------

  /**
   * `GET /api/geo/projects/:id` without the session id (the route adds it).
   * @param {{ id: string }} user @param {string} id
   */
  async projectView(user, id) {
    return this.projectViewOf(await this.requireProject(user, id));
  }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async projectViewOf(project) {
    const metricIds = GEO_OVERVIEW_METRICS.map((entry) => entry.metricId);
    const [latest, series, targets, week, names, started] = await Promise.all([
      this.#latestProjectMetrics([project.id], metricIds),
      this.#series([project.id], metricIds),
      this.store.latestTargets(project.id),
      this.#week(project),
      this.#controlProjectNames(project.userId, [project.projectId]),
      this.#startedAt([project]),
    ]);
    const rows = latest.get(project.id) ?? new Map();
    const points = series.get(project.id) ?? new Map();
    const metrics = GEO_OVERVIEW_METRICS.map(({ key, metricId }) => ({
      key,
      cell: geoCellFromRow(rows.get(metricId)),
      target: this.#target(targets, project.tier, metricId),
      trend: (points.get(metricId) ?? []).map(({ date, value }) => ({ date, value })),
    }));
    await this.#attachSnapshotIds(project.id, GEO_OVERVIEW_METRICS.map(({ metricId }, index) => ({ cell: metrics[index].cell, row: rows.get(metricId) })));
    return {
      ...project,
      name: geoProjectName(project, names.get(project.projectId)),
      startedAt: started.get(project.id) ?? project.createdAt,
      availableEngines: geoAvailableEngines(this.config),
      overview: {
        metrics,
        week,
        steps: project.steps,
      },
    };
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
    const rounds = [...new Set(entries.map((entry) => entry.row?.round_id).filter(Boolean).map(String))];
    for (const entry of entries) if (entry.row) entry.cell.snapshotIds = [];
    if (!rounds.length) return;
    const rows = (await this.store.query(`SELECT s.id, s.round_id, s.engine, s.status, s.surface, q.pool, q.group_id,
        coalesce(g.is_control, false) AS is_control, r.kind AS round_kind
      FROM evimed_geo.snapshots s JOIN evimed_geo.rounds r ON r.id = s.round_id
        LEFT JOIN evimed_geo.questions q ON q.id = s.question_id LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id
      WHERE s.geo_project_id = $1 AND s.round_id = ANY($2::text[]) AND s.status IN ('valid', 'refusal')
      ORDER BY s.asked_at NULLS LAST, s.id LIMIT 20000`, [geoId, rounds])).rows;
    /** @type {Map<string, any[]>} */
    const byRound = new Map();
    for (const row of rows) {
      const list = byRound.get(String(row.round_id)) ?? [];
      list.push({ snapshotId: String(row.id), engine: String(row.engine ?? ""), roundId: String(row.round_id), roundKind: text(row.round_kind),
        status: String(row.status), surface: row.surface ?? null, pool: text(row.pool), groupId: text(row.group_id), isControl: row.is_control === true });
      byRound.set(String(row.round_id), list);
    }
    for (const { cell, row } of entries) {
      if (!row?.round_id) continue;
      const selected = geoCellRows(byRound.get(String(row.round_id)) ?? [], /** @type {any} */ ({
        metricId: String(row.metric_id), scope: String(row.scope), pool: text(row.pool), engine: text(row.engine), groupId: text(row.group_id),
        arm: text(row.arm), rival: text(row.rival), variant: text(row.variant),
      }));
      cell.snapshotIds = selected.slice(0, GEO_CELL_SNAPSHOT_LIMIT).map((entry) => entry.snapshotId);
    }
  }

  /**
   * 「本周」: the week's few events, most urgent first, each with where it
   * leads. Facts only — every sentence restates a row.
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project
   */
  async #week(project) {
    const since = new Date(this.now().getTime() - WEEK_MS).toISOString();
    const [errors, stops, changed, rounds, publishable, published] = await Promise.all([
      this.store.query(`SELECT id, engine, statement, severity, last_snapshot_id, created_at FROM evimed_geo.errors
        WHERE geo_project_id = $1 AND status <> 'closed' AND created_at >= $2 ORDER BY severity DESC NULLS LAST, created_at DESC LIMIT 3`, [project.id, since]),
      this.store.query(`SELECT id, title, updated_at FROM evimed_geo.articles WHERE geo_project_id = $1 AND safety = 'open' AND status <> 'withdrawn'
        ORDER BY updated_at DESC LIMIT 2`, [project.id]),
      // An outlet that changed a published text this week (the market's post-publication check).
      this.store.query(`SELECT o.id, a.title, min(e.at) AS at FROM evimed_geo.order_events e JOIN evimed_geo.orders o ON o.id = e.order_id
          LEFT JOIN evimed_geo.articles a ON a.id = o.article_id
        WHERE o.geo_project_id = $1 AND e.at >= $2 AND e.detail ->> 'reason' = 'text_changed'
        GROUP BY o.id, a.title ORDER BY min(e.at) DESC LIMIT 2`, [project.id, since]),
      this.store.query(`SELECT id, kind, done, finished_at FROM evimed_geo.rounds WHERE geo_project_id = $1 AND status IN ('done', 'partial')
        AND finished_at >= $2 AND kind IN ('baseline', 'weekly', 'single_step', 'noise') ORDER BY finished_at DESC LIMIT 2`, [project.id, since]),
      this.store.query(`SELECT count(*)::integer AS n, max(updated_at) AS at FROM evimed_geo.articles WHERE geo_project_id = $1 AND status = 'publishable'
        AND updated_at >= $2`, [project.id, since]),
      this.store.query(`SELECT count(*)::integer AS n, max(updated_at) AS at FROM evimed_geo.orders WHERE geo_project_id = $1
        AND state IN ('published', 'verified', 'settled') AND updated_at >= $2`, [project.id, since]),
    ]);
    /** @type {Array<{ kind: string, text: string, tab: string, ref: Record<string, string> | null, at: string | null }>} */
    const items = [];
    for (const row of errors.rows) {
      items.push({ kind: "wrong_ours", text: `${engineLabel(String(row.engine))}讲错：${clip(row.statement, 60)}`, tab: "diagnosis",
        ref: { errorId: String(row.id), ...(row.last_snapshot_id ? { snapshotId: String(row.last_snapshot_id) } : {}) }, at: iso(row.created_at) });
    }
    for (const row of stops.rows) {
      items.push({ kind: "safety", text: `「${clip(row.title ?? "稿件", 30)}」有安全问题待确认`, tab: "content", ref: { articleId: String(row.id) },
        at: iso(row.updated_at) });
    }
    for (const row of changed.rows) {
      items.push({ kind: "safety", text: `「${clip(row.title ?? "稿件", 30)}」发布后被媒体改动`, tab: "distribution", ref: { orderId: String(row.id) },
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
    return {
      product: project.product,
      competitors: project.competitors,
      claims: claims.map((claim) => ({
        id: claim.id, statement: claim.statement, quote: claim.quote, sourceRef: claim.sourceRef, sourceKind: claim.sourceKind,
        evidenceLevel: claim.evidenceLevel, population: claim.population, inLabel: claim.inLabel, verifiedAt: claim.verifiedAt,
        validUntil: claim.validUntil, status: claim.status,
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
      subtypes: list(data.subtypes), personas: list(data.personas), stages: list(data.stages), careNodes: list(data.careNodes), files: list(data.files),
    };
  }

  /**
   * `GET …/:id/questions?version=`: the named set version, the latest by default.
   * @param {{ id: string }} user @param {string} id @param {number | null} version
   */
  async questions(user, id, version = null) { return this.questionsOf(await this.requireProject(user, id), version); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {number | null} version */
  async questionsOf(project, version = null) {
    const sets = await this.store.questionSets(project.id);
    const chosen = version ?? sets[0]?.version ?? null;
    if (version != null && !sets.some((set) => set.version === version)) throw failure(404, "geo_version_invalid", "No such question set version.");
    const groups = chosen == null ? [] : await this.store.questionMap(project.id, chosen);
    return {
      sets: sets.map(({ version: setVersion, lockedAt, measuredCount }) => ({ version: setVersion, lockedAt, measuredCount })),
      version: chosen,
      groups: groups.map((group) => ({
        id: group.id, pool: group.pool, name: group.name, typicalQuestion: group.typicalQuestion, journeyStage: group.journeyStage,
        audience: group.audience, weight: group.weight, isControl: group.isControl, signal: group.signal,
        questions: group.questions.map((question) => ({
          id: question.id, text: question.text, kind: question.kind, platform: question.platform, sourceUrl: question.sourceUrl,
          isMeasured: question.isMeasured,
        })),
      })),
    };
  }

  /** `POST …/:id/questions/:qid/unmeasure`. @param {{ id: string }} user @param {string} id @param {string} questionId */
  async unmeasureQuestion(user, id, questionId) {
    const project = await this.requireProject(user, id);
    const minimal = geoProgramMinimal(project.steps);
    const written = await this.store.unmeasureQuestion(String(user.id), project.id, questionId, {
      check: (groups) => geoLockCheck(groups, minimal).refusals.map((issue) => issue.message),
    });
    if (!written) throw failure(404, "geo_question_not_found", "Question not found.");
    if ("stale" in written) throw failure(409, "geo_question_not_current", "Only a question of the latest question set can be taken out of measurement.");
    if ("refused" in written) throw failure(409, "geo_question_set_invalid", `Without this question the set could not be measured: ${written.refused.join(" ")}`);
    return written;
  }

  /** @param {string} geoId @param {string | null} roundId */
  async #round(geoId, roundId) {
    if (roundId) {
      const row = (await this.store.query(`SELECT * FROM evimed_geo.rounds WHERE geo_project_id = $1 AND id = $2`, [geoId, roundId])).rows[0];
      if (!row) throw failure(404, "geo_round_not_found", "Round not found.");
      return row;
    }
    return (await this.store.query(`SELECT * FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind = ANY($2::text[])
      ORDER BY (status IN ('done', 'partial')) DESC, created_at DESC LIMIT 1`, [geoId, [...DIAGNOSIS_ROUND_KINDS]])).rows[0] ?? null;
  }

  /**
   * `GET …/:id/diagnosis?round=`.
   * @param {{ id: string }} user @param {string} id @param {string | null} roundId
   */
  async diagnosis(user, id, roundId = null) { return this.diagnosisOf(await this.requireProject(user, id), roundId); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {string | null} roundId */
  async diagnosisOf(project, roundId = null) {
    const round = await this.#round(project.id, roundId);
    const rounds = (await this.store.query(`SELECT id, kind, sample_date, created_at FROM evimed_geo.rounds WHERE geo_project_id = $1
      AND kind = ANY($2::text[]) ORDER BY created_at DESC LIMIT 20`, [project.id, [...DIAGNOSIS_ROUND_KINDS]])).rows;
    const errors = (await this.store.query(`SELECT * FROM evimed_geo.errors WHERE geo_project_id = $1
      ORDER BY (status = 'closed'), severity DESC NULLS LAST, updated_at DESC LIMIT 100`, [project.id])).rows.map(errorView);
    const noiseRow = (await this.store.query(`SELECT value, computed_at FROM evimed_geo.metrics WHERE geo_project_id = $1 AND scope = 'project'
      AND metric_id = $2 AND variant = $3 ORDER BY computed_at DESC LIMIT 1`, [project.id, GEO_VIEW_METRIC_IDS.noiseBand, NOISE_BAND_OF])).rows[0];
    const engines = round && Array.isArray(round.engines) && round.engines.length ? round.engines.map(String) : project.engines;
    /** @type {Map<string, any>} */
    const cells = new Map();
    /** @type {Record<string, any>} */
    let failureModes = { omitted: tallyCell(0, 0, []), correct: tallyCell(0, 0, []), wrongOurs: tallyCell(0, 0, []), wrongCompetitor: tallyCell(0, 0, []) };
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
      // The four failure modes as cells: the count over the round's answers
      // (valid and refusal; suspect ones are out), with the answers behind it.
      const modes = (await this.store.query(`SELECT f.failure_mode, s.id FROM evimed_geo.facts f
        JOIN evimed_geo.snapshots s ON s.id = f.snapshot_id
        WHERE s.round_id = $1 AND s.geo_project_id = $2 AND s.status IN ('valid', 'refusal') ORDER BY s.asked_at NULLS LAST, s.id LIMIT 20000`,
      [round.id, project.id])).rows;
      /** @type {Map<string, string[]>} */
      const byMode = new Map();
      for (const row of modes) {
        const list = byMode.get(String(row.failure_mode)) ?? [];
        list.push(String(row.id));
        byMode.set(String(row.failure_mode), list);
      }
      const mode = (/** @type {string} */ key) => tallyCell(byMode.get(key)?.length ?? 0, modes.length, byMode.get(key) ?? []);
      failureModes = { omitted: mode("omitted"), correct: mode("correct"), wrongOurs: mode("wrong_ours"), wrongCompetitor: mode("wrong_competitor") };
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
      topCompetitor: pools.get(pool)?.competitor ?? null, mainIssue: pools.get(pool)?.issue ?? null,
    }));
    await this.#attachSnapshotIds(project.id, traced);
    return {
      round: round ? {
        id: String(round.id), kind: String(round.kind), sampleDate: round.sample_date ? rowDay(round, this.timeZone) : null,
        surface: round.surface ?? null, planned: Number(round.planned), done: Number(round.done), engines,
      } : null,
      rounds: rounds.map((/** @type {any} */ row) => ({ id: String(row.id), kind: String(row.kind), sampleDate: row.sample_date ? rowDay(row, this.timeZone) : null })),
      byEngine,
      byPool,
      failureModes,
      errors,
      noise: noiseRow ? { band: num(noiseRow.value), measuredAt: iso(noiseRow.computed_at) } : null,
      more,
    };
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
      this.store.query(`SELECT brands, statements FROM evimed_geo.facts WHERE snapshot_id = $1`, [snapshot.id]),
      snapshot.round_id && snapshot.question_id
        ? this.store.query(`SELECT s.id, s.engine, s.status, f.snapshot_id AS judged, f.mentions_ours, f.cites_ours, f.statements,
              (SELECT r.engines FROM evimed_geo.rounds r WHERE r.id = s.round_id) AS round_engines
            FROM evimed_geo.snapshots s LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id
            WHERE s.geo_project_id = $1 AND s.round_id = $2 AND s.question_id = $3
            ORDER BY s.engine, s.asked_at DESC`, [project.id, snapshot.round_id, snapshot.question_id])
        : { rows: [] },
      this.store.query(`SELECT * FROM evimed_geo.errors WHERE geo_project_id = $1 AND (first_snapshot_id = $2 OR last_snapshot_id = $2
          OR (question_id = $3 AND engine = $4)) ORDER BY severity DESC NULLS LAST, updated_at DESC LIMIT 20`,
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
      facts: { brands: Array.isArray(factRow?.brands) ? factRow.brands : [], statements: Array.isArray(factRow?.statements) ? factRow.statements : [] },
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

  /** `GET …/:id/sources`. @param {{ id: string }} user @param {string} id */
  async sources(user, id) { return this.sourcesOf(await this.requireProject(user, id)); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async sourcesOf(project) {
    const [sources, strategy, targets, retrieval] = await Promise.all([
      this.store.listSources(project.id),
      this.store.latestStrategy(project.id),
      this.store.latestTargets(project.id),
      this.store.query(`SELECT DISTINCT ON (m.engine) * FROM evimed_geo.metrics m WHERE m.geo_project_id = $1 AND m.scope = 'engine' AND m.metric_id = $2
        AND m.pool IS NULL AND ${PLAIN_ROW} ORDER BY m.engine, m.computed_at DESC`, [project.id, GEO_VIEW_METRIC_IDS.retrieval]),
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
    return {
      sources: sources.map((source) => ({
        id: source.id, domain: source.domain, name: source.name, kind: source.kind, layer: source.layer,
        conditions: { icp: source.icpMatches, newsIndexed: source.newsIndexed, medical: source.medicalVertical },
        impostor: source.impostor,
        cited: Object.fromEntries(Object.entries(source.cited).map(([engine, pools]) => [engine,
          pools && typeof pools === "object" ? Object.values(pools).reduce((/** @type {number} */ sum, value) => sum + (Number(value) || 0), 0) : Number(pools) || 0])),
        mentionsOurs: source.mentionsOurs, wrongOurs: source.wrongOurs,
        market: source.market ? { price: num(source.market.price ?? source.market.priceCny), resourceId: text(source.market.resourceId) } : null,
      })),
      expectations,
      battlefield: { groups: Array.isArray(battlefield.groups) ? battlefield.groups : [], reason: text(battlefield.reason) },
      tiers: [...tiers.values()].sort((left, right) => left.tier.localeCompare(right.tier)),
      chosenTier: project.tier,
    };
  }

  /** `POST …/:id/tier`. @param {{ id: string }} user @param {string} id @param {string} tier */
  async setTier(user, id, tier) {
    await this.requireProject(user, id);
    const updated = await this.store.updateProject(String(user.id), id, { tier });
    return { id, tier: updated?.tier ?? tier };
  }

  /** `GET …/:id/articles`. @param {{ id: string }} user @param {string} id */
  async articles(user, id) { return this.articlesOf(await this.requireProject(user, id)); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async articlesOf(project) {
    const articles = await this.store.listArticles(project.id);
    const [groups, placements, cited] = await Promise.all([
      this.store.query(`SELECT id, typical_question FROM evimed_geo.question_groups WHERE geo_project_id = $1`, [project.id]),
      this.store.query(`SELECT article_id, count(*)::integer AS n FROM evimed_geo.orders WHERE geo_project_id = $1
        AND state NOT IN ('planned', 'cancelled', 'rejected', 'refunded', 'lost') GROUP BY article_id`, [project.id]),
      this.store.citedArticles(project.id),
    ]);
    const questions = new Map(groups.rows.map((/** @type {any} */ row) => [String(row.id), text(row.typical_question)]));
    const counts = new Map(placements.rows.map((/** @type {any} */ row) => [String(row.article_id), Number(row.n)]));
    const citedIds = new Set(cited.map((row) => row.articleId));
    return {
      articles: articles.map((article) => ({
        id: article.id, layer: article.layer, title: article.title, groupId: article.groupId,
        question: article.groupId ? questions.get(article.groupId) ?? null : null, status: article.status, gate: article.gate,
        safety: article.safety, path: article.path, runId: article.runId, claimCount: article.claimIds.length,
        placements: counts.get(article.id) ?? 0, cited: citedIds.has(article.id),
      })),
    };
  }

  /**
   * `POST …/:id/articles/:aid/withdraw`: before anything was placed, or once
   * no order for it is live any more (the user cancelled it — 撤单 then 撤回).
   * @param {{ id: string }} user @param {string} id @param {string} articleId
   */
  async withdrawArticle(user, id, articleId) {
    const project = await this.requireProject(user, id);
    if (!(await this.store.getArticle(project.id, articleId))) throw failure(404, "geo_article_not_found", "Article not found.");
    const live = await this.store.query(`SELECT 1 FROM evimed_geo.orders WHERE geo_project_id = $1 AND article_id = $2
      AND state = ANY($3::text[]) LIMIT 1`, [project.id, articleId, [...GEO_ORDER_ARTICLE_LIVE_STATES, "problem"]]);
    const fromStatuses = live.rows.length ? ["draft", "publishable"] : ["draft", "publishable", "placed"];
    const changed = await this.store.changeArticle(project.id, articleId, { status: "withdrawn", fromStatuses });
    if (!changed) throw failure(409, "geo_article_state_invalid", "Only an article that has not been placed can be withdrawn.");
    return { id: changed.id, status: changed.status };
  }

  /** `POST …/:id/articles/:aid/release`: 「放行」 an open safety finding after a person looked. @param {{ id: string }} user @param {string} id @param {string} articleId */
  async releaseArticle(user, id, articleId) {
    const project = await this.requireProject(user, id);
    if (!(await this.store.getArticle(project.id, articleId))) throw failure(404, "geo_article_not_found", "Article not found.");
    const changed = await this.store.changeArticle(project.id, articleId, { safety: "released", fromSafety: ["open"] });
    if (!changed) throw failure(409, "geo_article_state_invalid", "Only an article with an open safety finding can be released.");
    return { id: changed.id, safety: changed.safety, status: changed.status };
  }

  /** `GET …/:id/distribution`. @param {{ id: string }} user @param {string} id @param {{ marketConfigured?: boolean }} [options] */
  async distribution(user, id, options = {}) { return this.distributionOf(await this.requireProject(user, id), options); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {{ marketConfigured?: boolean }} [options] */
  async distributionOf(project, { marketConfigured = geoMarketConfigured(this.config) } = {}) {
    const [orders, money, targets] = await Promise.all([
      this.store.query(`SELECT o.*, a.title AS article_title, a.layer AS article_layer, m.name AS media_name, m.domain AS media_domain
        FROM evimed_geo.orders o LEFT JOIN evimed_geo.articles a ON a.id = o.article_id
          LEFT JOIN evimed_geo.media m ON m.media_type = o.media_type AND m.resource_id = o.resource_id
        WHERE o.geo_project_id = $1 ORDER BY o.created_at DESC LIMIT 500`, [project.id]),
      // The money is the ledger's (projectMoney, the market's own view): a
      // rejected order still holds its reserve until the refund is in the
      // balance, and a refund after settlement is money back.
      this.store.query(`SELECT order_id, kind, sum(amount_cny) AS amount FROM evimed_geo.ledger WHERE geo_project_id = $1 GROUP BY order_id, kind`,
        [project.id]),
      this.store.latestTargets(project.id),
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
      suggestedBudgetCny: suggested,
      market: { configured: Boolean(marketConfigured) },
      orders: orders.rows.map((/** @type {any} */ row) => ({
        id: String(row.id), articleId: text(row.article_id), articleTitle: text(row.article_title), media: text(row.media_name),
        domain: text(row.media_domain), layer: text(row.article_layer), state: String(row.state), priceCny: num(row.price_cny ?? row.reserve_cny),
        publishedUrl: text(row.published_url), checks: Array.isArray(row.checks) ? row.checks : [], updatedAt: iso(row.updated_at),
        cancellable: GEO_ORDER_CANCELLABLE_STATES.includes(String(row.state)),
      })),
    };
  }

  /** One order of the project, for the cancel route's ownership and state check. @param {{ id: string }} user @param {string} id @param {string} orderId */
  async order(user, id, orderId) {
    const project = await this.requireProject(user, id);
    const row = (await this.store.query(`SELECT id, state FROM evimed_geo.orders WHERE geo_project_id = $1 AND id = $2`, [project.id, orderId])).rows[0];
    if (!row) throw failure(404, "geo_order_not_found", "Order not found.");
    return { project, order: { id: String(row.id), state: String(row.state) } };
  }

  /** `GET …/:id/monitoring`. @param {{ id: string }} user @param {string} id */
  async monitoring(user, id) { return this.monitoringOf(await this.requireProject(user, id)); }

  /** @param {Awaited<ReturnType<GeoService["requireProject"]>>} project */
  async monitoringOf(project) {
    const metricIds = GEO_OVERVIEW_METRICS.map((entry) => entry.metricId);
    const since = new Date(this.now().getTime() - WEEK_MS).toISOString();
    const [series, arms, byEngine, net, noise, cited, newErrors, queued, baseline] = await Promise.all([
      this.#series([project.id], metricIds),
      this.#series([project.id], [GEO_ARM_METRIC_ID], "arm", "arm"),
      this.#series([project.id], [GEO_VIEW_METRIC_IDS.mention], "engine", "engine"),
      this.store.query(`SELECT * FROM evimed_geo.metrics WHERE geo_project_id = $1 AND scope = 'project' AND metric_id = $2 AND variant = $3
        ORDER BY computed_at DESC LIMIT 1`, [project.id, GEO_VIEW_METRIC_IDS.netEffect, NET_EFFECT_OF]),
      this.store.query(`SELECT value FROM evimed_geo.metrics WHERE geo_project_id = $1 AND scope = 'project' AND metric_id = $2 AND variant = $3
        ORDER BY computed_at DESC LIMIT 1`, [project.id, GEO_VIEW_METRIC_IDS.noiseBand, NOISE_BAND_OF]),
      this.store.citedArticles(project.id),
      this.store.query(`SELECT * FROM evimed_geo.errors WHERE geo_project_id = $1 AND created_at >= $2
        ORDER BY severity DESC NULLS LAST, created_at DESC LIMIT 50`, [project.id, since]),
      this.store.query(`SELECT kind, created_at FROM evimed_geo.rounds WHERE geo_project_id = $1 AND status = 'queued'
        ORDER BY created_at LIMIT 1`, [project.id]),
      this.store.query(`SELECT 1 FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind = 'baseline' AND status IN ('done', 'partial') LIMIT 1`, [project.id]),
    ]);
    const projectSeries = series.get(project.id) ?? new Map();
    const armSeries = arms.get(project.id) ?? new Map();
    const engineSeries = byEngine.get(project.id) ?? new Map();
    const points = (/** @type {string} */ key) => (armSeries.get(`${GEO_ARM_METRIC_ID}\u0000${key}`) ?? []).map(({ date, value }) => ({ date, value }));
    const netRow = net.rows[0];
    const next = queued.rows[0]
      ? { date: dayIn(new Date(queued.rows[0].created_at), this.timeZone), kind: String(queued.rows[0].kind) }
      : baseline.rows.length ? { date: nextMonday(this.now(), this.timeZone), kind: "weekly" } : null;
    return {
      series: GEO_OVERVIEW_METRICS.map(({ key, metricId }) => ({ key, points: projectSeries.get(metricId) ?? [] })),
      arms: {
        pilot: points("pilot"),
        control: points("control"),
        netEffect: { ...geoCellFromRow(netRow), noiseBand: noise.rows[0] ? num(noise.rows[0].value) : null },
      },
      byEngine: project.engines.map((engine) => ({
        engine, points: (engineSeries.get(`${GEO_VIEW_METRIC_IDS.mention}\u0000${engine}`) ?? []).map(({ date, value }) => ({ date, value })),
      })),
      cited,
      newErrors: newErrors.rows.map(errorView),
      next,
    };
  }

  /**
   * `GET /api/geo/market` (operators): the platform's balance as the market
   * last read it, open top-up requests and the last reconciliation.
   * @param {{ balance?: () => Promise<any> } | null} market
   */
  async market(market) {
    await this.ready();
    const [topups, reconciliation] = await Promise.all([
      this.store.query(`SELECT * FROM evimed_geo.topups ORDER BY requested_at DESC LIMIT 20`),
      this.store.query(`SELECT * FROM evimed_geo.reconciliations ORDER BY day DESC LIMIT 1`),
    ]);
    let balance = null;
    try { balance = market?.balance ? await market.balance() : null; } catch { balance = null; }
    const last = reconciliation.rows[0];
    return {
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

  // --- the runtime's reads (geo_read) -----------------------------------------------------

  /**
   * What `geo_read` answers for one `what`, in the page's shapes, cut to the
   * tool's bounds: at most 50 items, answer text at most 4,000 characters.
   * The filter is validated by the gateway.
   * @param {Awaited<ReturnType<GeoService["requireProject"]>>} project @param {string} what
   * @param {{ round?: string, engine?: string, pool?: string, groupId?: string, questionId?: string, limit?: number, offset?: number }} filter
   */
  async runtimeRead(project, what, filter = {}) {
    this.counters.reads += 1;
    const limit = Math.min(filter.limit ?? 20, GEO_READ_MAX_ITEMS);
    const offset = filter.offset ?? 0;
    /** @template T @param {T[]} list */
    const page = (list) => ({ items: list.slice(offset, offset + limit), total: list.length, more: list.length > offset + limit });
    switch (what) {
      case "project": {
        const view = await this.projectViewOf(project);
        return { project: { id: view.id, name: view.name, product: view.product, competitors: view.competitors, coverageDays: view.coverageDays,
          engines: view.engines, tier: view.tier, status: view.status, steps: view.steps }, overview: view.overview };
      }
      case "claims": {
        const evidence = await this.evidenceOf(project);
        const claims = page(evidence.claims);
        return { product: evidence.product, competitors: evidence.competitors, claims: claims.items, total: claims.total, more: claims.more };
      }
      case "questions": {
        const view = await this.questionsOf(project, null);
        const groups = page(view.groups.filter((group) => (!filter.pool || group.pool === filter.pool) && (!filter.groupId || group.id === filter.groupId)));
        return { sets: view.sets, version: view.version, groups: groups.items, total: groups.total, more: groups.more };
      }
      case "journey": return this.journeyOf(project);
      case "diagnosis": {
        const view = await this.diagnosisOf(project, filter.round ?? null);
        return { ...view, errors: view.errors.slice(0, limit), more: view.more.slice(0, limit) };
      }
      case "metrics": {
        const values = [project.id];
        const where = ["geo_project_id = $1"];
        const add = (/** @type {string} */ column, /** @type {string | undefined} */ value) => {
          if (value == null) return;
          values.push(value);
          where.push(`${column} = $${values.length}`);
        };
        add("round_id", filter.round);
        add("engine", filter.engine);
        add("pool", filter.pool);
        add("group_id", filter.groupId);
        values.push(String(limit + 1), String(offset));
        const rows = (await this.store.query(`SELECT * FROM evimed_geo.metrics WHERE ${where.join(" AND ")}
          ORDER BY computed_at DESC, metric_id, id LIMIT $${values.length - 1}::integer OFFSET $${values.length}::integer`, values)).rows;
        return { items: rows.slice(0, limit).map((row) => metricView(row, this.metricName)), more: rows.length > limit };
      }
      case "snapshots": {
        const values = [project.id];
        const where = ["s.geo_project_id = $1"];
        const add = (/** @type {string} */ column, /** @type {string | undefined} */ value) => {
          if (value == null) return;
          values.push(value);
          where.push(`${column} = $${values.length}`);
        };
        add("s.round_id", filter.round);
        add("s.engine", filter.engine);
        add("s.question_id", filter.questionId);
        add("q.pool", filter.pool);
        add("q.group_id", filter.groupId);
        values.push(String(limit + 1), String(offset));
        const rows = (await this.store.query(`SELECT s.*, q.text AS question_text, q.pool AS question_pool, f.brands, f.statements, f.failure_mode,
            f.mentions_ours, f.retrieval_triggered, f.cites_ours
          FROM evimed_geo.snapshots s LEFT JOIN evimed_geo.questions q ON q.id = s.question_id LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id
          WHERE ${where.join(" AND ")} ORDER BY s.asked_at DESC NULLS LAST, s.id
          LIMIT $${values.length - 1}::integer OFFSET $${values.length}::integer`, values)).rows;
        return {
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
        const values = [project.id];
        const where = ["geo_project_id = $1"];
        if (filter.engine) { values.push(filter.engine); where.push(`engine = $${values.length}`); }
        if (filter.questionId) { values.push(filter.questionId); where.push(`question_id = $${values.length}`); }
        values.push(String(limit + 1), String(offset));
        const rows = (await this.store.query(`SELECT * FROM evimed_geo.errors WHERE ${where.join(" AND ")}
          ORDER BY (status = 'closed'), severity DESC NULLS LAST, updated_at DESC
          LIMIT $${values.length - 1}::integer OFFSET $${values.length}::integer`, values)).rows;
        return {
          items: rows.slice(0, limit).map((/** @type {any} */ row) => ({ ...errorView(row), evidenceQuote: text(row.evidence_quote), claimId: text(row.claim_id),
            responsible: text(row.responsible), materials: Array.isArray(row.materials) ? row.materials : [] })),
          more: rows.length > limit,
        };
      }
      case "sources": {
        const view = await this.sourcesOf(project);
        const sources = page(view.sources);
        return { ...view, sources: sources.items, total: sources.total, more: sources.more };
      }
      case "strategy": {
        const [strategy, plan] = await Promise.all([this.store.latestStrategy(project.id), this.store.latestPlacementPlan(project.id)]);
        return { strategy, placementPlan: plan };
      }
      case "targets": {
        const view = await this.sourcesOf(project);
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
      case "monitoring": return this.monitoringOf(project);
      default:
        throw failure(400, "geo_read_what_invalid", "Unknown read.");
    }
  }

  // --- metrics for the operator endpoint ----------------------------------------------------

  /** Counts for `/api/ops/metrics`, one query. */
  async metricsSnapshot() {
    await this.ready();
    const row = (await this.store.query(`SELECT
        (SELECT count(*) FROM evimed_geo.projects WHERE deleted_at IS NULL)::integer AS projects,
        (SELECT count(*) FROM evimed_geo.projects WHERE deleted_at IS NULL AND status = 'active')::integer AS active,
        (SELECT count(*) FROM evimed_geo.errors WHERE status <> 'closed')::integer AS open_errors,
        (SELECT count(*) FROM evimed_geo.errors WHERE status <> 'closed' AND severity = ANY($1::text[]))::integer AS urgent_errors,
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
 * @param {{ service: GeoService, social?: any, worker?: any }} geo
 */
export async function geoMetricsSnapshot(geo) {
  let tables = null;
  try { tables = await geo.service.metricsSnapshot(); } catch { tables = null; }
  return { tables, service: { ...geo.service.counters }, social: geo.social?.status?.() ?? null };
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
  add("service_total", "What the service did since this process started.", "counter",
    ["projectsCreated", "reads", "writes", "writeIssues", "notFound"].map((kind) => ({ labels: { kind }, value: Number(/** @type {any} */ (service)[kind] ?? 0) })));
  const social = snapshot.social;
  if (social?.counters) {
    add("social_requests_total", "Social-channel requests by outcome.", "counter",
      Object.entries(social.counters).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
  }
  return families;
}
