import { FRONTIER_PROJECT_ID, FRONTIER_PROJECT_NAME } from "./internalProjects.mjs";
import { HttpError } from "./security.mjs";

/**
 * The frontier feed's leased background work (「前沿动态」, plan §7.2, §10.4.4).
 *
 * Hidden knowledge:
 *
 * - One timer, five loops. The base tick (`OPEN_SCIENCE_FRONTIER_POLL_MS`)
 *   starts whichever loop is due: the pull every
 *   `OPEN_SCIENCE_KNOWLEDGE_PLUGIN_POLL_MS`, the registry and manifest mirror
 *   at start and hourly, the processing batches every tick
 *   (`OPEN_SCIENCE_FRONTIER_PROCESS_CONCURRENCY` of them side by side), the
 *   wave-two composer every tick, and the retention cleanup hourly. One timer
 *   because the maintenance pause stops recurring work by clearing each
 *   worker's `timer` (`pauseRecurringWork` in `server.mjs`): a second timer
 *   here would be a loop maintenance could not stop.
 * - Loops never overlap themselves and never wait for each other: a model
 *   batch that takes a minute must not delay the next pull, and a slow pull
 *   must not stack a second one behind it. A loop still running past the lease
 *   is reported as stalled — a promise cannot be cancelled, but it can be seen.
 * - Every loop checks `canRun` (the maintenance lease's `claimingAllowed`)
 *   before it claims or writes anything, like every other worker of this
 *   control plane; a maintenance window waits for the loops already running
 *   (`inspectActivity` reads `status().running`).
 * - The queue is the module's own tables (plan §10.4.4), not the platform's
 *   job ledger: seven thousand fetches and a thousand entries a day would drown
 *   a ledger that holds a few thousand rows. The pipeline claims entries and
 *   items with `FOR UPDATE SKIP LOCKED` and its own lease columns.
 * - The model calls are billed to the first operator account's internal
 *   project `evimed-frontier` (`internalProjects.mjs`), which this worker
 *   makes if it is missing before the first batch runs. Without an operator
 *   the pull and the mirror still run — collecting costs nothing — and
 *   processing waits, named in the status and in readiness.
 * - Retention is bounded deletes, one statement per table per hour, and what
 *   one pass leaves the next takes (plan §10.4.5): entries that produced
 *   nothing after 30 days, the change log after 90, hot snapshots after 90.
 *   The same hourly pass recounts each source's selected items of the last
 *   thirty days (`sources.selected_30d`, the sources list's 「近 30 天精选」),
 *   here and not in the mirror because it is the platform's own number and
 *   must move while the plugin is down.
 *
 * @module frontierWorker
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Rows one retention statement removes at most. */
const RETENTION_BATCH = 5_000;
const LOOPS = Object.freeze(["owner", "mirror", "pull", "process", "compose", "cleanup"]);
/** What one `processBatch()` reports (package E's pipeline), summed per worker
 *  for the status and the metrics. A key it does not report stays 0. */
export const PIPELINE_OUTCOMES = Object.freeze(["claimed", "promoted", "published", "merged", "screenedOut", "held", "failed",
  "dropped", "waiting", "deferred", "edited", "rescored", "embedded"]);

/**
 * The internal project the feed's model calls are billed to, under the first
 * operator account, made when missing.
 * @param {{ store: any, config: Record<string, any> }} dependencies
 * @returns {Promise<{ userId: string, projectId: string }>}
 */
export async function ensureFrontierProject({ store, config }) {
  const operatorId = String((config.operatorUsers ?? [])[0] ?? "");
  if (!operatorId) {
    throw new HttpError(503, "frontier_operator_unconfigured", "The frontier feed needs an operator account (OPEN_SCIENCE_OPERATOR_USERS) to bill its model calls to.");
  }
  const user = await store.userById(operatorId);
  if (!user) throw new HttpError(503, "frontier_operator_unavailable", "The frontier feed's operator account does not exist.");
  try {
    await store.requireProject(user, FRONTIER_PROJECT_ID);
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== "project_not_found" && /** @type {any} */ (error)?.status !== 404) throw error;
    try {
      await store.createProject(user, FRONTIER_PROJECT_ID, FRONTIER_PROJECT_NAME);
    } catch (conflict) {
      // Another control plane made it first; that is the project we wanted.
      if (/** @type {any} */ (conflict)?.code !== "project_exists") throw conflict;
    }
  }
  return { userId: operatorId, projectId: FRONTIER_PROJECT_ID };
}

/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "frontier_worker_failed");

export class FrontierWorker {
  /**
   * @param {{ ingest: any, pipeline?: any, composer?: any, database: any, ensureOwner?: (() => Promise<{ userId: string, projectId: string }>) | null,
   *   pollMs?: number, leaseMs?: number, pluginPollMs?: number, mirrorMs?: number, cleanupMs?: number, concurrency?: number,
   *   canRun?: () => boolean, now?: () => Date, report?: (loop: string, code: string) => void }} dependencies
   */
  constructor({ ingest, pipeline = null, composer = null, database, ensureOwner = null, pollMs = 5_000, leaseMs = 600_000,
    pluginPollMs = 60_000, mirrorMs = HOUR_MS, cleanupMs = HOUR_MS, concurrency = 2, canRun = () => true,
    now = () => new Date(), report = () => {} }) {
    if (!ingest || !database) throw new TypeError("The frontier worker needs the ingest and the product database.");
    if (pipeline !== null && typeof pipeline?.processBatch !== "function") throw new TypeError("The frontier pipeline must offer processBatch().");
    if (composer !== null && typeof composer?.tick !== "function") throw new TypeError("The frontier composer must offer tick().");
    for (const [name, value, min, max] of /** @type {const} */ ([["poll", pollMs, 100, 3_600_000], ["lease", leaseMs, 1_000, 86_400_000],
      ["plugin poll", pluginPollMs, 1_000, 86_400_000], ["mirror", mirrorMs, 1_000, 7 * DAY_MS], ["cleanup", cleanupMs, 1_000, 7 * DAY_MS]])) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid frontier worker ${name} interval.`);
    }
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError("Invalid frontier processing concurrency.");
    this.ingest = ingest;
    this.pipeline = pipeline;
    this.composer = composer;
    this.database = database;
    this.ensureOwner = ensureOwner;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.pluginPollMs = pluginPollMs;
    this.mirrorMs = mirrorMs;
    this.cleanupMs = cleanupMs;
    this.concurrency = concurrency;
    this.canRun = canRun;
    this.now = now;
    this.report = report;
    /** @type {ReturnType<typeof setInterval> | null} cleared by the maintenance pause */
    this.timer = null;
    this.closed = false;
    /** @type {{ userId: string, projectId: string } | null} */
    this.owner = null;
    /** @type {Record<string, Promise<unknown> | null>} */
    this.running = Object.fromEntries(LOOPS.map((loop) => [loop, null]));
    /** @type {Record<string, { startedAt: number | null, lastRunAt: string | null, lastOkAt: string | null, lastError: string | null, runs: number, failures: number }>} */
    this.loops = Object.fromEntries(LOOPS.map((loop) => [loop, { startedAt: null, lastRunAt: null, lastOkAt: null, lastError: null, runs: 0, failures: 0 }]));
    /** When each periodic loop last started (epoch ms); 0 = due now. */
    this.lastStarted = { mirror: 0, pull: 0, cleanup: 0 };
    /** What the pipeline's batches have done since start (plan §10.3.1's outcomes). */
    this.pipelineTotals = Object.fromEntries([["batches", 0], ...PIPELINE_OUTCOMES.map((key) => [key, 0])]);
    this.retentionTotals = { entries: 0, itemChanges: 0, hotSnapshots: 0 };
  }

  /** The code of a loop whose last run failed, or null when every loop's last run succeeded. */
  get lastError() {
    return Object.values(this.loops).find((state) => state.lastError)?.lastError ?? null;
  }

  start() {
    this.closed = false;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  /**
   * Run one loop unless it is already running; record how it ended.
   * @param {string} loop @param {() => Promise<unknown>} work
   */
  #run(loop, work) {
    if (this.running[loop]) return this.running[loop];
    const state = this.loops[loop];
    state.startedAt = this.now().getTime();
    state.lastRunAt = new Date(state.startedAt).toISOString();
    state.runs += 1;
    const running = (async () => {
      try {
        const result = await work();
        state.lastError = null;
        state.lastOkAt = this.now().toISOString();
        return result;
      } catch (error) {
        const code = codeOf(error);
        state.lastError = code;
        state.failures += 1;
        this.report(loop, code);
        return null;
      } finally {
        state.startedAt = null;
        this.running[loop] = null;
      }
    })();
    this.running[loop] = running;
    return running;
  }

  /** @param {"mirror" | "pull" | "cleanup"} loop @param {number} interval */
  #due(loop, interval) {
    const at = this.now().getTime();
    if (this.lastStarted[loop] && at - this.lastStarted[loop] < interval) return false;
    this.lastStarted[loop] = at;
    return true;
  }

  /**
   * Start every loop that is due. Resolves when the loops started by this
   * tick have finished — which is what a test awaits; the timer does not.
   */
  async tick() {
    if (this.closed || !this.canRun()) return [];
    /** @type {Promise<unknown>[]} */
    const started = [];
    if (!this.owner && this.ensureOwner && !this.running.owner) {
      started.push(this.#run("owner", async () => { this.owner = await this.ensureOwner(); return this.owner; }));
    }
    if (this.ingest.plugin?.configured !== false) {
      // A mirror that failed (the plugin started after us) is retried at the
      // pull's cadence, not an hour later.
      if (!this.running.mirror && this.#due("mirror", this.loops.mirror.lastError ? this.pluginPollMs : this.mirrorMs)) {
        started.push(this.#run("mirror", async () => {
          await this.ingest.mirrorManifest();
          return this.ingest.mirrorSources();
        }));
      }
      if (!this.running.pull && this.#due("pull", this.pluginPollMs)) started.push(this.#run("pull", () => this.ingest.pull()));
    }
    // Processing spends model money under the owner's project, so it waits
    // for the owner; with no owner configured it never starts at all.
    if (this.pipeline && (this.owner || !this.ensureOwner) && !this.running.process) {
      started.push(this.#run("process", () => this.#process()));
    }
    if (this.composer && !this.running.compose) started.push(this.#run("compose", () => this.composer.tick()));
    if (!this.running.cleanup && this.#due("cleanup", this.cleanupMs)) {
      started.push(this.#run("cleanup", async () => ({ ...(await this.cleanup()), recounted: await this.recountSelected() })));
    }
    return Promise.all(started);
  }

  /** `processBatch` side by side, `concurrency` of them; the outcomes are summed. */
  async #process() {
    const results = await Promise.allSettled(Array.from({ length: this.concurrency }, () => {
      if (!this.canRun()) return Promise.resolve(null);
      return this.pipeline.processBatch();
    }));
    const failure = results.find((result) => result.status === "rejected");
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value || typeof result.value !== "object") continue;
      this.pipelineTotals.batches += 1;
      for (const key of PIPELINE_OUTCOMES) {
        const value = Number(/** @type {any} */ (result.value)[key]);
        if (Number.isSafeInteger(value) && value > 0) this.pipelineTotals[key] += value;
      }
    }
    // One batch failing is reported; the others' outcomes still count.
    if (failure) throw /** @type {PromiseRejectedResult} */ (failure).reason;
    return results;
  }

  /** The hourly retention pass (plan §10.4.5): bounded, one statement per table. */
  async cleanup() {
    const at = this.now().getTime();
    const before = (/** @type {number} */ days) => new Date(at - days * DAY_MS).toISOString();
    const entries = await this.database.query(`DELETE FROM evimed_frontier.entries WHERE id IN (
      SELECT id FROM evimed_frontier.entries WHERE state IN ('screened-out', 'dropped', 'backfill', 'failed') AND received_at < $1::timestamptz
      ORDER BY received_at LIMIT ${RETENTION_BATCH})`, [before(30)]);
    const itemChanges = await this.database.query(`DELETE FROM evimed_frontier.item_changes WHERE seq IN (
      SELECT seq FROM evimed_frontier.item_changes WHERE changed_at < $1::timestamptz ORDER BY changed_at LIMIT ${RETENTION_BATCH})`, [before(90)]);
    const hotSnapshots = await this.database.query(`DELETE FROM evimed_frontier.hot_snapshots WHERE taken_at IN (
      SELECT taken_at FROM evimed_frontier.hot_snapshots WHERE taken_at < $1::timestamptz ORDER BY taken_at LIMIT ${RETENTION_BATCH})`, [before(90)]);
    const removed = { entries: entries.rowCount ?? 0, itemChanges: itemChanges.rowCount ?? 0, hotSnapshots: hotSnapshots.rowCount ?? 0 };
    for (const [key, value] of Object.entries(removed)) this.retentionTotals[key] += value;
    return removed;
  }

  /**
   * Each source's published, selected items whose day is within the last
   * thirty (`sources.selected_30d`), in one statement; only a source whose
   * count moved is written. Returns how many were.
   * @returns {Promise<number>}
   */
  async recountSelected() {
    const since = new Date(this.now().getTime() - 30 * DAY_MS).toISOString();
    const result = await this.database.query(`UPDATE evimed_frontier.sources s SET selected_30d = counted.n
      FROM (SELECT src.id, count(i.id)::integer AS n FROM evimed_frontier.sources src
        LEFT JOIN evimed_frontier.items i ON i.primary_source_id = src.id AND i.state = 'published' AND i.selected
          AND i.timeline_at >= $1::timestamptz
        GROUP BY src.id) counted
      WHERE s.id = counted.id AND s.selected_30d IS DISTINCT FROM counted.n`, [since]);
    return result.rowCount ?? 0;
  }

  status() {
    const at = this.now().getTime();
    const loops = Object.fromEntries(Object.entries(this.loops).map(([loop, state]) => [loop, {
      running: Boolean(this.running[loop]),
      // A loop past the lease is stuck on something it never returned from.
      stalled: state.startedAt != null && at - state.startedAt > this.leaseMs,
      lastRunAt: state.lastRunAt, lastOkAt: state.lastOkAt, lastError: state.lastError, runs: state.runs, failures: state.failures,
    }]));
    return {
      running: Object.values(this.running).some(Boolean),
      armed: Boolean(this.timer),
      owner: this.owner,
      lastError: this.lastError,
      loops,
      pipeline: { ...this.pipelineTotals },
      retention: { ...this.retentionTotals },
      // The editorial loops the compose hook drives (frontierComposer.mjs).
      composer: this.composer?.status?.() ?? null,
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(Object.values(this.running).filter(Boolean));
  }
}
