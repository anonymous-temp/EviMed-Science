/**
 * SQL for 「循证 GEO」's measurement tables (build spec §2): rounds, probe
 * jobs, snapshots, facts, errors and metrics, plus the reads of the content
 * tables the measurement needs (projects, questions, claims, sources, the
 * journey's care nodes, published order URLs).
 *
 * Hidden knowledge:
 *
 * - **The DDL is package A's** (`geoPersistence.mjs`, `migrateGeo`). `ready()`
 *   runs it and then adds, `IF NOT EXISTS`, the columns this package writes
 *   that the build spec's table list does not name — so the measurement works
 *   on A's DDL whether or not it has caught up: `facts.red_flag_expected`,
 *   `red_flag_hits`, `safety_terms_hit` (M-11, M-12), `metrics.variant`,
 *   `rival`, `reason` (a cell's variant, competitor and not-measurable reason),
 *   `snapshots.probe_job_id` (which job — so which repeat — asked),
 *   `probe_jobs.external_ref` (the inclusion channel's request id) and
 *   `errors.notified_at` (an urgent error is notified exactly once).
 * - **One prober at a time, across processes.** The probe host serves one
 *   request at a time; `withProbeLock` holds the session advisory lock
 *   `hashtext('evimed_geo_probe')` on a dedicated connection for the length of
 *   the work and releases it in `finally` (a dropped connection releases it
 *   too). A second process gets `{ acquired: false }` and asks nothing.
 * - **Leases survive crashes.** A job is leased with an owner and an expiry;
 *   an expired lease goes back to the queue, except an inclusion job that
 *   already holds a vendor request id, which is polled rather than resubmitted
 *   (each submission costs the platform's account).
 * - **Every read is scoped by the GEO project**, and every row written carries
 *   the project's `user_id`.
 *
 * @module geoMeasureStore
 */

import { migrateGeo } from "./geoPersistence.mjs";
import { randomId } from "./security.mjs";

/** The advisory lock key text; `hashtext` of it is the lock. */
export const GEO_PROBE_LOCK_KEY = "evimed_geo_probe";

/** Rounds whose big versions wait for the night window. */
export const GEO_NIGHT_ROUND_KINDS = Object.freeze(["baseline", "weekly", "noise"]);

const ENSURE_COLUMNS = `
ALTER TABLE evimed_geo.facts ADD COLUMN IF NOT EXISTS red_flag_expected jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_geo.facts ADD COLUMN IF NOT EXISTS red_flag_hits jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_geo.facts ADD COLUMN IF NOT EXISTS safety_terms_hit jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_geo.metrics ADD COLUMN IF NOT EXISTS variant text;
ALTER TABLE evimed_geo.metrics ADD COLUMN IF NOT EXISTS rival text;
ALTER TABLE evimed_geo.metrics ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE evimed_geo.snapshots ADD COLUMN IF NOT EXISTS probe_job_id text;
ALTER TABLE evimed_geo.probe_jobs ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE evimed_geo.errors ADD COLUMN IF NOT EXISTS notified_at timestamptz;
CREATE INDEX IF NOT EXISTS geo_snapshots_parse_idx ON evimed_geo.snapshots (asked_at) WHERE status IN ('valid', 'refusal');
CREATE INDEX IF NOT EXISTS geo_snapshots_job_idx ON evimed_geo.snapshots (probe_job_id);
CREATE INDEX IF NOT EXISTS geo_probe_jobs_round_idx ON evimed_geo.probe_jobs (round_id, status);
`;

const ready = new WeakMap();

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());
/** @param {unknown} value */
const num = (value) => (value == null ? null : Number(value));
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * @typedef {object} GeoProjectRow
 * @property {string} id
 * @property {string} userId
 * @property {string} projectId
 * @property {Record<string, any>} product
 * @property {Array<Record<string, any>>} competitors
 * @property {string[]} engines
 * @property {string} status
 */

/** @param {any} row @returns {GeoProjectRow} */
function projectRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    projectId: String(row.project_id),
    product: row.product && typeof row.product === "object" ? row.product : {},
    competitors: list(row.competitors),
    engines: list(row.engines).map(String),
    status: String(row.status),
  };
}

/** @param {any} row */
export function jobRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    roundId: String(row.round_id),
    geoProjectId: String(row.geo_project_id),
    questionId: String(row.question_id),
    engine: String(row.engine),
    repeatIndex: Number(row.repeat_index ?? 0),
    status: String(row.status),
    attempts: Number(row.attempts ?? 0),
    runAfter: iso(row.run_after),
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: iso(row.lease_until),
    snapshotId: row.snapshot_id ?? null,
    errorCode: row.error_code ?? null,
    externalRef: row.external_ref ?? null,
  };
}

/** @param {any} row */
export function snapshotRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    roundId: row.round_id ?? null,
    geoProjectId: String(row.geo_project_id),
    questionId: row.question_id ?? null,
    engine: String(row.engine ?? ""),
    askedAt: iso(row.asked_at),
    status: String(row.status),
    answerText: row.answer_text ?? null,
    answerSha256: row.answer_sha256 ?? null,
    citations: list(row.citations),
    screenshotSha256: row.screenshot_sha256 ?? null,
    surface: row.surface && typeof row.surface === "object" ? row.surface : null,
    latencyMs: num(row.latency_ms),
    warnings: list(row.warnings),
    probeJobId: row.probe_job_id ?? null,
  };
}

/** @param {any} row */
export function errorRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    geoProjectId: String(row.geo_project_id),
    fingerprint: String(row.fingerprint),
    engine: String(row.engine),
    questionId: row.question_id ?? null,
    firstSnapshotId: row.first_snapshot_id ?? null,
    lastSnapshotId: row.last_snapshot_id ?? null,
    statement: row.statement ?? null,
    errorType: row.error_type ?? null,
    severity: row.severity ?? null,
    severityBasis: row.severity_basis ?? "initial",
    claimId: row.claim_id ?? null,
    evidenceQuote: row.evidence_quote ?? null,
    confirm: row.confirm && typeof row.confirm === "object" ? row.confirm : null,
    citedSource: row.cited_source && typeof row.cited_source === "object" ? row.cited_source : null,
    action: row.action ?? null,
    responsible: row.responsible ?? null,
    status: String(row.status),
    closedSnapshotId: row.closed_snapshot_id ?? null,
    materials: list(row.materials),
    notifiedAt: iso(row.notified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class GeoMeasureStore {
  /** @param {{ query: (text: string, values?: unknown[]) => Promise<any>, transaction: (operation: (client: any) => Promise<any>) => Promise<any>, withClient: (operation: (client: any) => Promise<any>) => Promise<any> }} database  a ControlPlaneDatabase */
  constructor(database) {
    if (!database || typeof database.query !== "function" || typeof database.transaction !== "function") {
      throw new TypeError("The GEO measurement store needs the control-plane database.");
    }
    this.database = database;
  }

  /** The schema, and the columns this package writes. Once per database object. */
  async ready() {
    const cached = ready.get(this.database);
    if (cached) return cached;
    const attempt = (async () => {
      await migrateGeo(this.database);
      await this.database.transaction(async (/** @type {any} */ client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-geo-measure-v1'))");
        await client.query(ENSURE_COLUMNS);
      });
      return true;
    })();
    ready.set(this.database, attempt);
    try { return await attempt; }
    catch (error) { ready.delete(this.database); throw error; }
  }

  /** @param {string} text @param {unknown[]} [values] */
  async query(text, values = []) {
    await this.ready();
    return this.database.query(text, values);
  }

  /** @template T @param {(client: any) => Promise<T>} operation @returns {Promise<T>} */
  async transaction(operation) {
    await this.ready();
    return this.database.transaction(operation);
  }

  /**
   * Run `operation` while holding the probe lock; `{ acquired: false }` when
   * another process holds it.
   * @template T @param {() => Promise<T>} operation
   * @returns {Promise<{ acquired: false } | { acquired: true, value: T }>}
   */
  async withProbeLock(operation) {
    await this.ready();
    return this.database.withClient(async (/** @type {any} */ client) => {
      const locked = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [GEO_PROBE_LOCK_KEY]);
      if (!locked.rows[0]?.ok) return { acquired: /** @type {const} */ (false) };
      try {
        return { acquired: /** @type {const} */ (true), value: await operation() };
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [GEO_PROBE_LOCK_KEY]).catch(() => {});
      }
    });
  }

  // ───────────────────────── projects and context ─────────────────────────

  /** @param {string} geoProjectId @returns {Promise<GeoProjectRow | null>} */
  async project(geoProjectId) {
    const result = await this.query("SELECT * FROM evimed_geo.projects WHERE id = $1 AND deleted_at IS NULL", [geoProjectId]);
    return result.rows[0] ? projectRow(result.rows[0]) : null;
  }

  /**
   * Everything the parser and the judge read about a project: the product and
   * competitors, the active claims (latest version of each), the care red
   * flags of the latest journey, and what counts as our source.
   * @param {string} geoProjectId
   */
  async projectContext(geoProjectId) {
    const project = await this.project(geoProjectId);
    if (!project) return null;
    const [claims, journey, owned, published] = await Promise.all([
      this.query(`SELECT DISTINCT ON (claim_key) id, claim_key, statement, quote, source_ref, source_kind, in_label
        FROM evimed_geo.claims WHERE geo_project_id = $1 AND status = 'active'
        ORDER BY claim_key, version DESC LIMIT 400`, [geoProjectId]),
      this.query(`SELECT data FROM evimed_geo.journeys WHERE geo_project_id = $1 ORDER BY version DESC LIMIT 1`, [geoProjectId]),
      this.query(`SELECT domain FROM evimed_geo.sources WHERE geo_project_id = $1 AND layer = 'owned'`, [geoProjectId]),
      this.query(`SELECT DISTINCT published_url FROM evimed_geo.orders WHERE geo_project_id = $1 AND published_url IS NOT NULL
        AND state IN ('published', 'verified', 'settled')`, [geoProjectId]),
    ]);
    /** @type {Array<{ id: string, text: string, node: string | null }>} */
    const careFlags = [];
    for (const node of list(journey.rows[0]?.data?.careNodes)) {
      for (const flag of list(node?.redFlags)) {
        const text = String(flag ?? "").trim();
        if (text && careFlags.length < 40 && !careFlags.some((entry) => entry.text === text)) {
          careFlags.push({ id: `F${careFlags.length + 1}`, text, node: node?.node ? String(node.node) : null });
        }
      }
    }
    return {
      project,
      claims: claims.rows.map((row) => ({
        id: String(row.id), key: String(row.claim_key), statement: String(row.statement), quote: String(row.quote),
        sourceRef: String(row.source_ref ?? ""), sourceKind: row.source_kind ?? null, inLabel: row.in_label ?? null,
      })),
      careFlags,
      owned: {
        domains: owned.rows.map((row) => String(row.domain).toLowerCase()).filter(Boolean),
        urls: published.rows.map((row) => String(row.published_url)).filter(Boolean),
      },
    };
  }

  /**
   * Questions of a project with their pool, group and weight.
   * @param {string} geoProjectId @param {{ ids?: string[] | null, measuredOnly?: boolean }} [options]
   */
  async questions(geoProjectId, { ids = null, measuredOnly = false } = {}) {
    const result = await this.query(`SELECT q.id, q.text, q.set_version, q.is_measured, q.retired_at, coalesce(q.pool, g.pool) AS pool,
        q.group_id, g.weight, g.is_control, g.journey_stage, g.audience
      FROM evimed_geo.questions q JOIN evimed_geo.question_groups g ON g.id = q.group_id
      WHERE q.geo_project_id = $1 AND ($2::text[] IS NULL OR q.id = ANY($2::text[]))
        AND (NOT $3::boolean OR (q.is_measured AND q.retired_at IS NULL))
      ORDER BY g.weight DESC NULLS LAST, q.created_at, q.id`, [geoProjectId, ids, measuredOnly]);
    return result.rows.map((row) => ({
      id: String(row.id), text: String(row.text), setVersion: Number(row.set_version), measured: Boolean(row.is_measured),
      retired: row.retired_at != null, pool: row.pool ?? null, groupId: String(row.group_id), weight: num(row.weight),
      isControl: Boolean(row.is_control), journeyStage: row.journey_stage ?? null, audience: row.audience ?? null,
    }));
  }

  /**
   * The measured questions of the project's current question set: the latest
   * locked set, else (no set locked yet) the latest version any measured
   * question carries.
   * @param {string} geoProjectId
   */
  async measuredQuestions(geoProjectId) {
    const rows = await this.questions(geoProjectId, { measuredOnly: true });
    if (!rows.length) return { setVersion: null, questions: [] };
    let setVersion = Math.max(...rows.map((row) => row.setVersion));
    const locked = await this.query(`SELECT max(version) AS version FROM evimed_geo.question_sets WHERE geo_project_id = $1 AND locked_at IS NOT NULL`,
      [geoProjectId]);
    if (locked.rows[0]?.version != null) setVersion = Number(locked.rows[0].version);
    return { setVersion, questions: rows.filter((row) => row.setVersion === setVersion) };
  }

  // ───────────────────────── rounds and jobs ─────────────────────────

  /**
   * Write a round and its jobs in one transaction. Jobs are stamped a
   * millisecond apart in the order given, which is the order they are asked.
   * @param {{ id: string, userId: string, geoProjectId: string, kind: string, setVersion: number | null, engines: string[],
   *   surface: Record<string, unknown>, planned: number, ref: Record<string, unknown> | null, now: Date }} round
   * @param {Array<{ questionId: string, engine: string, repeatIndex: number }>} jobs
   */
  async createRound(round, jobs) {
    await this.transaction(async (client) => {
      await client.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, set_version, engines, surface, status, planned, done, failed, ref, created_at)
        VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, 'queued', $8, 0, 0, $9::jsonb, $10)`,
      [round.id, round.userId, round.geoProjectId, round.kind, round.setVersion, round.engines, JSON.stringify(round.surface), round.planned,
        round.ref ? JSON.stringify(round.ref) : null, round.now.toISOString()]);
      const base = round.now.getTime();
      for (let offset = 0; offset < jobs.length; offset += 200) {
        const batch = jobs.slice(offset, offset + 200);
        /** @type {unknown[]} */
        const values = [];
        const tuples = batch.map((job, index) => {
          const at = new Date(base + offset + index).toISOString();
          values.push(randomId("gj_"), round.userId, round.id, round.geoProjectId, job.questionId, job.engine, job.repeatIndex, at);
          const n = values.length;
          return `($${n - 7}, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, 'queued', 0, $${n}, $${n})`;
        });
        await client.query(`INSERT INTO evimed_geo.probe_jobs (id, user_id, round_id, geo_project_id, question_id, engine, repeat_index, status, attempts, created_at, updated_at)
          VALUES ${tuples.join(", ")}`, values);
      }
    });
  }

  /** @param {string} roundId */
  async round(roundId) {
    const result = await this.query("SELECT * FROM evimed_geo.rounds WHERE id = $1", [roundId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id), userId: String(row.user_id), geoProjectId: String(row.geo_project_id), kind: String(row.kind),
      setVersion: num(row.set_version), engines: list(row.engines).map(String), surface: row.surface ?? {}, status: String(row.status),
      planned: Number(row.planned), done: Number(row.done), failed: Number(row.failed),
      sampleDate: row.sample_date ? (typeof row.sample_date === "string" ? row.sample_date.slice(0, 10) : iso(row.sample_date)?.slice(0, 10) ?? null) : null,
      ref: row.ref ?? null, createdAt: iso(row.created_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at),
    };
  }

  /**
   * An open round of this kind for this project whose `ref` contains `ref`.
   * @param {string} geoProjectId @param {string} kind @param {Record<string, unknown>} ref
   */
  async openRoundWithRef(geoProjectId, kind, ref) {
    const result = await this.query(`SELECT id FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind = $2 AND status IN ('queued', 'running')
      AND ref @> $3::jsonb ORDER BY created_at LIMIT 1`, [geoProjectId, kind, JSON.stringify(ref)]);
    return result.rows[0] ? String(result.rows[0].id) : null;
  }

  /**
   * Leases whose holder died go back to the queue. An inclusion job that holds
   * a vendor request id keeps its lease and is polled instead.
   * @param {Date} now
   */
  async recoverExpiredLeases(now) {
    const result = await this.query(`UPDATE evimed_geo.probe_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = $1
      WHERE status = 'leased' AND lease_until < $1 AND external_ref IS NULL RETURNING id`, [now.toISOString()]);
    return result.rowCount ?? result.rows.length;
  }

  /**
   * Lease the next job the probe may ask now: queued and due, on an engine
   * this channel serves and that is not paused, in an open round of an active
   * project, inside the night window when the round is a big baseline, weekly
   * or noise round, and not past the project's weekly ask cap.
   * @param {{ now: Date, owner: string, leaseUntil: Date, engines: string[], paused: string[], nightOpen: boolean,
   *   nightMinAsks: number, weekStart: Date, weeklyCap: number }} options
   */
  async leaseNextJob({ now, owner, leaseUntil, engines, paused, nightOpen, nightMinAsks, weekStart, weeklyCap }) {
    const result = await this.query(`WITH candidate AS (
        SELECT j.id FROM evimed_geo.probe_jobs j
          JOIN evimed_geo.rounds r ON r.id = j.round_id
          JOIN evimed_geo.projects p ON p.id = j.geo_project_id
        WHERE j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= $1)
          AND j.engine = ANY($2::text[]) AND NOT (j.engine = ANY($3::text[]))
          AND r.status IN ('queued', 'running') AND p.status = 'active' AND p.deleted_at IS NULL
          AND ($4::boolean OR NOT (r.kind = ANY($5::text[])) OR r.planned <= $6)
          AND ($7::integer <= 0 OR (SELECT count(*) FROM evimed_geo.snapshots s
                WHERE s.geo_project_id = j.geo_project_id AND s.asked_at >= $8) < $7)
        ORDER BY r.created_at, j.created_at, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE evimed_geo.probe_jobs j SET status = 'leased', lease_owner = $9, lease_until = $10, attempts = j.attempts + 1, updated_at = $1
      FROM candidate WHERE j.id = candidate.id RETURNING j.*`,
    [now.toISOString(), engines, paused, nightOpen, [...GEO_NIGHT_ROUND_KINDS], nightMinAsks, weeklyCap, weekStart.toISOString(),
      owner, leaseUntil.toISOString()]);
    return result.rows[0] ? jobRow(result.rows[0]) : null;
  }

  /**
   * Why nothing was leased, for the tick's counters: queued jobs held by the
   * night window and by the weekly cap right now.
   * @param {{ now: Date, engines: string[], nightOpen: boolean, nightMinAsks: number, weekStart: Date, weeklyCap: number }} options
   */
  async heldJobs({ now, engines, nightOpen, nightMinAsks, weekStart, weeklyCap }) {
    const result = await this.query(`SELECT
        count(*) FILTER (WHERE NOT $3::boolean AND r.kind = ANY($4::text[]) AND r.planned > $5)::integer AS night,
        count(*) FILTER (WHERE $6::integer > 0 AND (SELECT count(*) FROM evimed_geo.snapshots s
          WHERE s.geo_project_id = j.geo_project_id AND s.asked_at >= $7) >= $6)::integer AS cap
      FROM evimed_geo.probe_jobs j JOIN evimed_geo.rounds r ON r.id = j.round_id
      WHERE j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= $1) AND j.engine = ANY($2::text[]) AND r.status IN ('queued', 'running')`,
    [now.toISOString(), engines, nightOpen, [...GEO_NIGHT_ROUND_KINDS], nightMinAsks, weeklyCap, weekStart.toISOString()]);
    return { night: Number(result.rows[0]?.night ?? 0), cap: Number(result.rows[0]?.cap ?? 0) };
  }

  /**
   * Inclusion jobs that hold a vendor request and are due to be polled.
   * @param {{ now: Date, engines: string[], limit: number }} options
   */
  async inclusionJobsToPoll({ now, engines, limit }) {
    const result = await this.query(`SELECT * FROM evimed_geo.probe_jobs WHERE status = 'leased' AND external_ref IS NOT NULL
      AND engine = ANY($2::text[]) AND (run_after IS NULL OR run_after <= $1) ORDER BY run_after NULLS FIRST, id LIMIT $3`,
    [now.toISOString(), engines, limit]);
    return result.rows.map(jobRow);
  }

  /** @param {string} jobId @param {string} externalRef @param {{ now: Date, leaseUntil: Date, runAfter: Date }} at */
  async holdInclusionJob(jobId, externalRef, { now, leaseUntil, runAfter }) {
    await this.query(`UPDATE evimed_geo.probe_jobs SET external_ref = $2, lease_until = $3, run_after = $4, updated_at = $5 WHERE id = $1`,
      [jobId, externalRef, leaseUntil.toISOString(), runAfter.toISOString(), now.toISOString()]);
  }

  /**
   * Put a leased job back in the queue. `refundAttempt` when the ask never
   * happened (the probe was busy), so a busy probe cannot use up a job.
   * @param {string} jobId @param {{ now: Date, runAfter?: Date | null, refundAttempt?: boolean, errorCode?: string | null }} options
   */
  async requeueJob(jobId, { now, runAfter = null, refundAttempt = false, errorCode = null }) {
    await this.query(`UPDATE evimed_geo.probe_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, external_ref = NULL,
        run_after = $2, attempts = CASE WHEN $3::boolean THEN greatest(attempts - 1, 0) ELSE attempts END,
        error_code = coalesce($4, error_code), updated_at = $5
      WHERE id = $1`, [jobId, runAfter ? runAfter.toISOString() : null, refundAttempt, errorCode, now.toISOString()]);
  }

  /**
   * A job's final state, and the round's counters recounted from its jobs.
   * @param {string} jobId @param {{ now: Date, status: "done" | "failed" | "skipped", snapshotId?: string | null, errorCode?: string | null }} outcome
   */
  async finishJob(jobId, { now, status, snapshotId = null, errorCode = null }) {
    await this.transaction(async (client) => {
      const result = await client.query(`UPDATE evimed_geo.probe_jobs SET status = $2, snapshot_id = coalesce($3, snapshot_id), error_code = $4,
          lease_owner = NULL, lease_until = NULL, updated_at = $5
        WHERE id = $1 RETURNING round_id`, [jobId, status, snapshotId, errorCode, now.toISOString()]);
      const roundId = result.rows[0]?.round_id;
      if (roundId) await recount(client, roundId);
    });
  }

  /**
   * A round's first job was leased: running, started now, sampled today.
   * @param {string} roundId @param {Date} now @param {string} sampleDate
   */
  async startRound(roundId, now, sampleDate) {
    await this.query(`UPDATE evimed_geo.rounds SET status = 'running', started_at = coalesce(started_at, $2), sample_date = coalesce(sample_date, $3::date)
      WHERE id = $1 AND status = 'queued'`, [roundId, now.toISOString(), sampleDate]);
  }

  /**
   * Open rounds and what is left in each: jobs still to ask, and how many of
   * those are on engines that are paused or have no channel.
   * @param {{ paused: string[], channels: string[] }} options
   */
  async openRoundProgress({ paused, channels }) {
    const result = await this.query(`SELECT r.id, r.kind, r.geo_project_id,
        count(j.id) FILTER (WHERE j.status IN ('queued', 'leased'))::integer AS open,
        count(j.id) FILTER (WHERE j.status = 'leased')::integer AS leased,
        count(j.id) FILTER (WHERE j.status = 'queued' AND j.engine = ANY($1::text[]))::integer AS paused,
        count(j.id) FILTER (WHERE j.status = 'queued' AND NOT (j.engine = ANY($2::text[])))::integer AS unchanneled
      FROM evimed_geo.rounds r LEFT JOIN evimed_geo.probe_jobs j ON j.round_id = r.id
      WHERE r.status IN ('queued', 'running') GROUP BY r.id ORDER BY r.created_at`, [paused, channels]);
    return result.rows.map((row) => ({
      id: String(row.id), kind: String(row.kind), geoProjectId: String(row.geo_project_id),
      open: Number(row.open), leased: Number(row.leased), paused: Number(row.paused), unchanneled: Number(row.unchanneled),
    }));
  }

  /**
   * Skip a round's queued jobs on the named engines, then close the round:
   * `done` when every job was answered, `partial` otherwise.
   * @param {string} roundId @param {{ now: Date, skip: Array<{ engines: string[], code: string }> }} options
   * @returns {Promise<{ status: string, skipped: number } | null>}
   */
  async finishRound(roundId, { now, skip }) {
    return this.transaction(async (client) => {
      let skipped = 0;
      for (const { engines, code } of skip) {
        if (!engines.length) continue;
        const result = await client.query(`UPDATE evimed_geo.probe_jobs SET status = 'skipped', error_code = $3, updated_at = $4
          WHERE round_id = $1 AND status = 'queued' AND engine = ANY($2::text[])`, [roundId, engines, code, now.toISOString()]);
        skipped += result.rowCount ?? 0;
      }
      const open = await client.query(`SELECT count(*)::integer AS n FROM evimed_geo.probe_jobs WHERE round_id = $1 AND status IN ('queued', 'leased')`, [roundId]);
      if (Number(open.rows[0]?.n) > 0) return null;
      const counts = await recount(client, roundId);
      const status = counts.failed > 0 ? "partial" : "done";
      const closed = await client.query(`UPDATE evimed_geo.rounds SET status = $2, finished_at = $3, started_at = coalesce(started_at, $3)
        WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`, [roundId, status, now.toISOString()]);
      return closed.rows.length ? { status, skipped } : null;
    });
  }

  /** Asks a project made since `since` (every snapshot is one request). @param {string} geoProjectId @param {Date} since */
  async asksSince(geoProjectId, since) {
    const result = await this.query(`SELECT count(*)::integer AS n FROM evimed_geo.snapshots WHERE geo_project_id = $1 AND asked_at >= $2`,
      [geoProjectId, since.toISOString()]);
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * The newest probe snapshot statuses per engine, newest first — what the
   * circuit breaker is seeded with after a restart.
   * @param {string[]} engines @param {number} limit
   */
  async recentProbeStatuses(engines, limit) {
    const result = await this.query(`SELECT engine, status FROM (
        SELECT engine, status, row_number() OVER (PARTITION BY engine ORDER BY asked_at DESC, id DESC) AS n
        FROM evimed_geo.snapshots WHERE engine = ANY($1::text[]) AND coalesce(surface ->> 'mode', 'web') <> 'inclusion'
      ) recent WHERE n <= $2 ORDER BY engine, n`, [engines, limit]);
    /** @type {Record<string, string[]>} */
    const byEngine = {};
    for (const row of result.rows) (byEngine[String(row.engine)] ??= []).push(String(row.status));
    return byEngine;
  }

  /**
   * @param {{ id: string, userId: string, roundId: string | null, geoProjectId: string, questionId: string | null, engine: string,
   *   askedAt: Date, status: string, answerText: string | null, answerSha256: string | null, citations: unknown[],
   *   screenshotSha256: string | null, surface: Record<string, unknown>, latencyMs: number | null, warnings: unknown[], probeJobId: string | null }} row
   */
  async insertSnapshot(row) {
    await this.query(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, question_id, engine, asked_at, status, answer_text,
        answer_sha256, citations, screenshot_sha256, surface, latency_ms, warnings, probe_job_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14, $15::jsonb, $16)`,
    [row.id, row.userId, row.roundId, row.geoProjectId, row.questionId, row.engine, row.askedAt.toISOString(), row.status, row.answerText,
      row.answerSha256, JSON.stringify(row.citations), row.screenshotSha256, JSON.stringify(row.surface),
      // latency_ms is an integer column; the probe reports fractions.
      row.latencyMs === null || !Number.isFinite(Number(row.latencyMs)) ? null : Math.round(Number(row.latencyMs)),
      JSON.stringify(row.warnings), row.probeJobId]);
  }

  /** @param {string} snapshotId */
  async snapshot(snapshotId) {
    const result = await this.query("SELECT * FROM evimed_geo.snapshots WHERE id = $1", [snapshotId]);
    return result.rows[0] ? snapshotRow(result.rows[0]) : null;
  }

  /** @param {string} snapshotId @param {unknown[]} warnings */
  async appendSnapshotWarnings(snapshotId, warnings) {
    if (!warnings.length) return;
    await this.query(`UPDATE evimed_geo.snapshots SET warnings = warnings || $2::jsonb WHERE id = $1`, [snapshotId, JSON.stringify(warnings)]);
  }

  // ───────────────────────── parse ─────────────────────────

  /**
   * Answers that have not been parsed yet (valid or refusal, no facts row),
   * oldest first, from rounds of active projects.
   * @param {number} limit
   */
  async snapshotsToParse(limit) {
    const result = await this.query(`SELECT s.* FROM evimed_geo.snapshots s
        JOIN evimed_geo.projects p ON p.id = s.geo_project_id AND p.deleted_at IS NULL
      WHERE s.status IN ('valid', 'refusal') AND NOT EXISTS (SELECT 1 FROM evimed_geo.facts f WHERE f.snapshot_id = s.id)
      ORDER BY s.asked_at, s.id LIMIT $1`, [limit]);
    return result.rows.map(snapshotRow);
  }

  /**
   * Write a snapshot's facts row (once), and the snapshot's status when the
   * judge found a refusal.
   * @param {{ id: string, userId: string, geoProjectId: string }} snapshot
   * @param {Record<string, any>} facts @param {{ status?: string | null }} [options]
   * @returns {Promise<boolean>} false when a facts row already existed
   */
  async writeFacts(snapshot, facts, { status = null } = {}) {
    return this.transaction(async (client) => {
      const result = await client.query(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, brands, mentions_ours, first_ours,
          recommended_ours, position_ours, brands_mentioned, retrieval_triggered, cites_ours, cites_ours_in_body, care_hint, statements,
          failure_mode, parser_version, judged_at, red_flag_expected, red_flag_hits, safety_terms_hit)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb)
        ON CONFLICT (snapshot_id) DO NOTHING RETURNING snapshot_id`,
      [snapshot.id, snapshot.userId, snapshot.geoProjectId, JSON.stringify(facts.brands ?? []), facts.mentionsOurs ?? null, facts.firstOurs ?? null,
        facts.recommendedOurs ?? null, facts.positionOurs ?? null, facts.brandsMentioned ?? null, facts.retrievalTriggered ?? null,
        facts.citesOurs ?? null, facts.citesOursInBody ?? null, facts.careHint ?? null, JSON.stringify(facts.statements ?? []),
        facts.failureMode ?? null, facts.parserVersion ?? null, facts.judgedAt ?? null, JSON.stringify(facts.redFlagExpected ?? []),
        JSON.stringify(facts.redFlagHits ?? []), JSON.stringify(facts.safetyTermsHit ?? [])]);
      if (!result.rows.length) return false;
      if (status) await client.query(`UPDATE evimed_geo.snapshots SET status = $2 WHERE id = $1`, [snapshot.id, status]);
      return true;
    });
  }

  /**
   * What `geo`-purpose model calls cost since `since`, across every account:
   * settled cost plus what is still reserved or uncertain. Null when the usage
   * ledger has no table here (nothing can be measured, so nothing is spent).
   * @param {Date} since
   */
  async geoSpendSince(since) {
    const table = await this.query("SELECT to_regclass('evimed_usage.model_requests') AS name");
    if (!table.rows[0]?.name) return null;
    const result = await this.query(`SELECT coalesce(sum(CASE WHEN status = 'settled' THEN coalesce(actual_cost, 0)
        WHEN status IN ('reserved', 'uncertain') THEN reserved_cost ELSE 0 END), 0) AS spent
      FROM evimed_usage.model_requests WHERE purpose = 'geo' AND created_at >= $1`, [since.toISOString()]);
    return Math.round(Number(result.rows[0]?.spent ?? 0) * 10_000) / 10_000;
  }

  // ───────────────────────── errors ─────────────────────────

  /** @param {string} errorId */
  async error(errorId) {
    const result = await this.query("SELECT * FROM evimed_geo.errors WHERE id = $1", [errorId]);
    return result.rows[0] ? errorRow(result.rows[0]) : null;
  }

  /**
   * Record one sighting of a wrong statement: a new error, or the existing
   * one's latest snapshot (reopened when it had been closed). Severity only
   * rises. Returns the row and whether it was created.
   * @param {Record<string, any>} row
   */
  async upsertError(row) {
    const result = await this.query(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, question_id, first_snapshot_id,
        last_snapshot_id, statement, error_type, severity, severity_basis, claim_id, evidence_quote, confirm, cited_source, action, responsible,
        status, materials, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, 'initial', $11, $12, $13::jsonb, $14::jsonb, $15, $16, 'open', '[]'::jsonb, $17, $17)
      ON CONFLICT (geo_project_id, fingerprint, engine) DO UPDATE SET
        last_snapshot_id = CASE WHEN errors.last_snapshot_id IS NULL OR $18::timestamptz >= coalesce(
            (SELECT asked_at FROM evimed_geo.snapshots WHERE id = errors.last_snapshot_id), '-infinity'::timestamptz)
          THEN EXCLUDED.last_snapshot_id ELSE errors.last_snapshot_id END,
        severity = greatest(errors.severity, EXCLUDED.severity),
        status = CASE WHEN errors.status = 'closed' AND $18::timestamptz > coalesce(
            (SELECT asked_at FROM evimed_geo.snapshots WHERE id = errors.closed_snapshot_id), '-infinity'::timestamptz)
          THEN 'open' ELSE errors.status END,
        closed_snapshot_id = CASE WHEN errors.status = 'closed' AND $18::timestamptz > coalesce(
            (SELECT asked_at FROM evimed_geo.snapshots WHERE id = errors.closed_snapshot_id), '-infinity'::timestamptz)
          THEN NULL ELSE errors.closed_snapshot_id END,
        notified_at = CASE WHEN errors.status = 'closed' AND $18::timestamptz > coalesce(
            (SELECT asked_at FROM evimed_geo.snapshots WHERE id = errors.closed_snapshot_id), '-infinity'::timestamptz)
          THEN NULL ELSE errors.notified_at END,
        updated_at = $17
      RETURNING *, (xmax = 0) AS inserted`,
    [row.id, row.userId, row.geoProjectId, row.fingerprint, row.engine, row.questionId, row.snapshotId, row.statement, row.errorType,
      row.severity, row.claimId, row.evidenceQuote, row.confirm ? JSON.stringify(row.confirm) : null,
      row.citedSource ? JSON.stringify(row.citedSource) : null, row.action, row.responsible, row.now.toISOString(), row.askedAt.toISOString()]);
    const out = result.rows[0];
    return { error: errorRow(out), created: Boolean(out.inserted) };
  }

  /** @param {string} errorId @param {Record<string, unknown>} fields  column → value (jsonb columns as objects) */
  async updateError(errorId, fields) {
    const columns = Object.keys(fields);
    if (!columns.length) return;
    const allowed = new Set(["confirm", "cited_source", "action", "responsible", "status", "closed_snapshot_id", "materials", "notified_at", "updated_at"]);
    const json = new Set(["confirm", "cited_source", "materials"]);
    const sets = columns.map((column, index) => {
      if (!allowed.has(column)) throw new TypeError(`errors.${column} is not written here`);
      return `${column} = $${index + 2}${json.has(column) ? "::jsonb" : ""}`;
    });
    const values = columns.map((column) => {
      const value = fields[column];
      if (json.has(column)) return value == null ? null : JSON.stringify(value);
      return value instanceof Date ? value.toISOString() : value;
    });
    await this.query(`UPDATE evimed_geo.errors SET ${sets.join(", ")} WHERE id = $1`, [errorId, ...values]);
  }

  /** Urgent errors not yet notified. @param {string[]} severities @param {number} limit */
  async errorsToNotify(severities, limit) {
    const result = await this.query(`SELECT * FROM evimed_geo.errors WHERE notified_at IS NULL AND status <> 'closed' AND severity = ANY($1::text[])
      ORDER BY created_at LIMIT $2`, [severities, limit]);
    return result.rows.map(errorRow);
  }

  /** Errors whose confirmation round has not been read yet. @param {number} limit */
  async errorsAwaitingConfirm(limit) {
    const result = await this.query(`SELECT e.*, r.status AS round_status FROM evimed_geo.errors e
        JOIN evimed_geo.rounds r ON r.id = e.confirm ->> 'roundId'
      WHERE e.confirm ->> 'status' = 'pending' AND r.status IN ('done', 'partial', 'cancelled')
      ORDER BY e.created_at LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ ...errorRow(row), roundStatus: String(row.round_status) }));
  }

  /**
   * Errors with no confirmation round yet (created while one could not be
   * queued), created before `before`: the parse loop queues a new error's
   * round itself right after creating it, and must not race a second one.
   * @param {number} limit @param {Date} before
   */
  async errorsWithoutConfirm(limit, before) {
    const result = await this.query(`SELECT * FROM evimed_geo.errors WHERE confirm IS NULL AND status <> 'closed' AND created_at < $2
      ORDER BY created_at LIMIT $1`, [limit, before.toISOString()]);
    return result.rows.map(errorRow);
  }

  /**
   * A round's answers with their facts: every snapshot, and for each whether
   * it is judged and the fingerprints of its wrong statements are computed by
   * the caller.
   * @param {string} roundId
   */
  async roundAnswers(roundId) {
    const result = await this.query(`SELECT s.id, s.status, s.question_id, s.engine, s.asked_at, f.snapshot_id IS NOT NULL AS parsed, f.judged_at,
        f.statements FROM evimed_geo.snapshots s LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id WHERE s.round_id = $1 ORDER BY s.asked_at`, [roundId]);
    return result.rows.map((row) => ({
      id: String(row.id), status: String(row.status), questionId: row.question_id ?? null, engine: String(row.engine), askedAt: iso(row.asked_at),
      parsed: Boolean(row.parsed), judged: row.judged_at != null, statements: list(row.statements),
    }));
  }

  /** Open errors that have been acted on. @param {number} limit */
  async errorsToClose(limit) {
    const result = await this.query(`SELECT * FROM evimed_geo.errors WHERE status IN ('acting', 'awaiting_remeasure') ORDER BY updated_at LIMIT $1`, [limit]);
    return result.rows.map(errorRow);
  }

  /**
   * The judged answers to one question on one engine asked after `after`, newest first.
   * @param {string} geoProjectId @param {string} questionId @param {string} engine @param {Date} after
   */
  async laterJudgedAnswers(geoProjectId, questionId, engine, after) {
    const result = await this.query(`SELECT s.id, s.status, s.asked_at, f.statements FROM evimed_geo.snapshots s
        JOIN evimed_geo.facts f ON f.snapshot_id = s.id
      WHERE s.geo_project_id = $1 AND s.question_id = $2 AND s.engine = $3 AND s.asked_at > $4 AND f.judged_at IS NOT NULL
      ORDER BY s.asked_at DESC LIMIT 20`, [geoProjectId, questionId, engine, after.toISOString()]);
    return result.rows.map((row) => ({ id: String(row.id), status: String(row.status), askedAt: iso(row.asked_at), statements: list(row.statements) }));
  }

  /** Open errors whose cited source is not attributed yet. @param {number} limit */
  async errorsToTrace(limit) {
    const result = await this.query(`SELECT * FROM evimed_geo.errors WHERE status <> 'closed' AND cited_source IS NOT NULL
      AND cited_source ->> 'domain' IS NOT NULL AND cited_source ->> 'attribute' IS NULL ORDER BY updated_at LIMIT $1`, [limit]);
    return result.rows.map(errorRow);
  }

  /** @param {string} geoProjectId @param {string} domain */
  async sourceForDomain(geoProjectId, domain) {
    const result = await this.query(`SELECT domain, kind, layer, impostor, blacklist_reason FROM evimed_geo.sources WHERE geo_project_id = $1
      AND ($2 = domain OR $2 LIKE '%.' || domain) ORDER BY length(domain) DESC LIMIT 1`, [geoProjectId, domain]);
    const row = result.rows[0];
    return row ? { domain: String(row.domain), kind: row.kind ?? null, layer: row.layer ?? null, impostor: Boolean(row.impostor),
      blacklistReason: row.blacklist_reason ?? null } : null;
  }

  /** Whether the project has a published order on this domain (a partner outlet). @param {string} geoProjectId @param {string} domain */
  async placedOnDomain(geoProjectId, domain) {
    const result = await this.query(`SELECT 1 FROM evimed_geo.orders WHERE geo_project_id = $1 AND published_url IS NOT NULL
      AND (published_url ILIKE $2 OR published_url ILIKE $3) LIMIT 1`, [geoProjectId, `%://${domain}/%`, `%.${domain}/%`]);
    return result.rows.length > 0;
  }

  // ───────────────────────── metrics ─────────────────────────

  /**
   * Finished rounds whose metrics are missing or older than their newest
   * facts, and whose answers are all parsed.
   * @param {string[]} kinds @param {number} limit
   */
  async roundsToMeasure(kinds, limit) {
    const result = await this.query(`SELECT r.id FROM evimed_geo.rounds r
        JOIN evimed_geo.projects p ON p.id = r.geo_project_id AND p.deleted_at IS NULL
      WHERE r.status IN ('done', 'partial') AND r.kind = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM evimed_geo.snapshots s WHERE s.round_id = r.id AND s.status IN ('valid', 'refusal')
          AND NOT EXISTS (SELECT 1 FROM evimed_geo.facts f WHERE f.snapshot_id = s.id))
        AND (NOT EXISTS (SELECT 1 FROM evimed_geo.metrics m WHERE m.round_id = r.id)
          OR (SELECT max(f.created_at) FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id = f.snapshot_id WHERE s.round_id = r.id)
             > (SELECT max(m.computed_at) FROM evimed_geo.metrics m WHERE m.round_id = r.id))
      ORDER BY r.finished_at NULLS LAST, r.created_at LIMIT $2`, [kinds, limit]);
    return result.rows.map((row) => String(row.id));
  }

  /**
   * One round's rows in the shape `computeGeoMetrics` reads (`GeoFactRow`).
   * A valid answer whose facts were never judged is passed without facts, so
   * the metrics leave it out as unparsed rather than read it as saying nothing.
   * @param {string} roundId
   */
  async roundFactRows(roundId) {
    const result = await this.query(`SELECT s.id, s.question_id, s.engine, s.round_id, s.asked_at, s.status, s.surface, s.citations,
        r.kind AS round_kind, coalesce(j.repeat_index, 0) AS repeat_index, coalesce(q.pool, g.pool) AS pool, q.group_id, g.is_control,
        f.snapshot_id IS NOT NULL AS has_facts, f.judged_at, f.brands, f.first_ours, f.position_ours, f.recommended_ours, f.retrieval_triggered,
        f.statements, f.red_flag_expected, f.red_flag_hits, f.safety_terms_hit, f.failure_mode, f.mentions_ours
      FROM evimed_geo.snapshots s
        JOIN evimed_geo.rounds r ON r.id = s.round_id
        LEFT JOIN evimed_geo.probe_jobs j ON j.id = s.probe_job_id
        LEFT JOIN evimed_geo.questions q ON q.id = s.question_id
        LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id
        LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id
      WHERE s.round_id = $1 ORDER BY s.asked_at, s.id`, [roundId]);
    return result.rows.map((row) => {
      const inclusion = row.surface?.mode === "inclusion";
      const usable = row.has_facts && (row.judged_at != null || inclusion);
      return {
        snapshotId: String(row.id), questionId: row.question_id ?? null, engine: String(row.engine), roundId: String(row.round_id),
        roundKind: String(row.round_kind), repeatIndex: Number(row.repeat_index ?? 0), askedAt: iso(row.asked_at), status: String(row.status),
        surface: row.surface ?? { mode: "web" }, citations: list(row.citations), pool: row.pool ?? null, groupId: row.group_id ?? null,
        isControl: Boolean(row.is_control),
        facts: usable ? {
          brands: list(row.brands), firstOurs: row.first_ours ?? null, positionOurs: num(row.position_ours),
          recommendedOurs: row.recommended_ours ?? null, retrievalTriggered: row.retrieval_triggered ?? null, statements: list(row.statements),
          redFlagExpected: list(row.red_flag_expected), redFlagHits: list(row.red_flag_hits),
          // An inclusion answer has no text to read safety terms from: not extracted, never "none".
          ...(inclusion ? {} : { safetyTermsHit: list(row.safety_terms_hit) }),
        } : null,
        failureMode: row.failure_mode ?? null,
        mentionsOurs: row.mentions_ours ?? null,
      };
    });
  }

  /**
   * Record on the round how its cross-engine cells were balanced: questions
   * asked, questions kept (answered on every engine), and those dropped.
   * @param {string} roundId @param {Record<string, unknown>} balance
   */
  async noteRoundBalance(roundId, balance) {
    await this.query(`UPDATE evimed_geo.rounds SET ref = coalesce(ref, '{}'::jsonb) || jsonb_build_object('balance', $2::jsonb) WHERE id = $1`,
      [roundId, JSON.stringify(balance)]);
  }

  /** Engines whose jobs a round skipped because the engine was paused or unreachable (not a single missing question). @param {string} roundId */
  async roundSkippedEngines(roundId) {
    const result = await this.query(`SELECT DISTINCT engine FROM evimed_geo.probe_jobs WHERE round_id = $1 AND status = 'skipped'
      AND error_code IN ('engine_paused', 'engine_unavailable')`, [roundId]);
    return result.rows.map((row) => String(row.engine));
  }

  /**
   * Control groups that articles, plans or orders have touched: they leave the
   * control arm (net_effect.control_exclusion).
   * @param {string} geoProjectId
   */
  async contaminatedControlGroups(geoProjectId) {
    const result = await this.query(`SELECT DISTINCT g.id FROM evimed_geo.question_groups g
        JOIN evimed_geo.articles a ON a.group_id = g.id AND a.geo_project_id = g.geo_project_id AND a.status <> 'withdrawn'
      WHERE g.geo_project_id = $1 AND g.is_control`, [geoProjectId]);
    return result.rows.map((row) => String(row.id));
  }

  /**
   * Replace a round's metric rows with a new computation, in one transaction.
   * @param {{ roundId: string | null, geoProjectId: string, userId: string, computedAt: Date, rows: Array<Record<string, any>>,
   *   replace?: { scope?: string, metricId?: string } }} batch
   */
  async writeMetrics({ roundId, geoProjectId, userId, computedAt, rows, replace = {} }) {
    await this.transaction(async (client) => {
      await client.query(`DELETE FROM evimed_geo.metrics WHERE geo_project_id = $1 AND round_id IS NOT DISTINCT FROM $2
        AND ($3::text IS NULL OR scope = $3) AND ($4::text IS NULL OR metric_id = $4)`,
      [geoProjectId, roundId, replace.scope ?? null, replace.metricId ?? null]);
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100);
        /** @type {unknown[]} */
        const values = [];
        const tuples = batch.map((row) => {
          values.push(randomId("gm_"), userId, geoProjectId, roundId, row.scope, row.pool ?? null, row.engine ?? null, row.groupId ?? null,
            row.arm ?? null, row.metricId, row.variant ?? null, row.rival ?? null, row.reason ?? null, row.numerator ?? null,
            row.denominator ?? null, row.value ?? null, row.ciLow ?? null, row.ciHigh ?? null, row.status, row.dataType ?? "measured",
            row.snapshotCount ?? null, computedAt.toISOString());
          const n = values.length;
          return `(${Array.from({ length: 22 }, (_, index) => `$${n - 21 + index}`).join(", ")})`;
        });
        await client.query(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, round_id, scope, pool, engine, group_id, arm, metric_id,
            variant, rival, reason, numerator, denominator, value, ci_low, ci_high, status, data_type, snapshot_count, computed_at)
          VALUES ${tuples.join(", ")}`, values);
      }
    });
  }

  /**
   * The project's earlier arm-scope cells of one metric, one per comparable
   * round (same question set version, baseline or weekly), oldest first.
   * @param {{ geoProjectId: string, setVersion: number | null, metricId: string, pool: string | null, variant?: string | null }} key
   */
  async armSeries({ geoProjectId, setVersion, metricId, pool, variant = null }) {
    const result = await this.query(`SELECT m.arm, m.value, m.numerator, m.denominator, m.status, r.sample_date, r.id AS round_id
      FROM evimed_geo.metrics m JOIN evimed_geo.rounds r ON r.id = m.round_id
      WHERE m.geo_project_id = $1 AND m.scope = 'arm' AND m.metric_id = $2 AND m.pool IS NOT DISTINCT FROM $3
        AND m.variant IS NOT DISTINCT FROM $4 AND m.rival IS NULL AND r.kind IN ('baseline', 'weekly')
        AND r.set_version IS NOT DISTINCT FROM $5 AND r.sample_date IS NOT NULL
      ORDER BY r.sample_date, r.created_at`, [geoProjectId, metricId, pool, variant, setVersion]);
    /** @type {Record<"pilot" | "control", Array<{ date: string, value: number | null, numerator: number | null, denominator: number | null }>>} */
    const series = { pilot: [], control: [] };
    for (const row of result.rows) {
      const arm = row.arm === "control" ? "control" : row.arm === "pilot" ? "pilot" : null;
      if (!arm) continue;
      const measurable = row.status === "ok" || row.status === "insufficient";
      const date = typeof row.sample_date === "string" ? row.sample_date.slice(0, 10) : /** @type {string} */ (iso(row.sample_date)).slice(0, 10);
      series[arm].push({ date, value: measurable ? num(row.value) : null, numerator: measurable ? num(row.numerator) : null,
        denominator: measurable ? num(row.denominator) : null });
    }
    return series;
  }

  /** The latest noise band of a metric for the project (a `NOISE` row). @param {string} geoProjectId @param {string} metricId */
  async latestNoiseBand(geoProjectId, metricId) {
    const result = await this.query(`SELECT value, status FROM evimed_geo.metrics WHERE geo_project_id = $1 AND metric_id = 'NOISE' AND variant = $2
      ORDER BY computed_at DESC LIMIT 1`, [geoProjectId, metricId]);
    const row = result.rows[0];
    return row ? { value: num(row.value), measured: row.status === "ok" } : null;
  }

  /** The first baseline round's sample date. @param {string} geoProjectId @param {number | null} setVersion */
  async baselineDate(geoProjectId, setVersion) {
    const result = await this.query(`SELECT sample_date FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind = 'baseline'
      AND status IN ('done', 'partial') AND set_version IS NOT DISTINCT FROM $2 AND sample_date IS NOT NULL ORDER BY sample_date LIMIT 1`, [geoProjectId, setVersion]);
    const value = result.rows[0]?.sample_date;
    return value == null ? null : (typeof value === "string" ? value.slice(0, 10) : /** @type {string} */ (iso(value)).slice(0, 10));
  }

  /**
   * Refresh `sources.cited`, `mentions_ours` and `wrong_ours` from one round's
   * answers: every cited domain gets a row (the strategy run fills in what it
   * is), and the counts are this round's.
   * @param {{ roundId: string, geoProjectId: string, userId: string, now: Date }} input
   */
  async refreshSourceCitations({ roundId, geoProjectId, userId, now }) {
    const result = await this.query(`SELECT s.engine, coalesce(q.pool, g.pool) AS pool, s.citations, f.mentions_ours, f.failure_mode
      FROM evimed_geo.snapshots s JOIN evimed_geo.facts f ON f.snapshot_id = s.id
        LEFT JOIN evimed_geo.questions q ON q.id = s.question_id LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id
      WHERE s.round_id = $1 AND s.status IN ('valid', 'refusal')`, [roundId]);
    /** @type {Map<string, { cited: Record<string, Record<string, number>>, mentionsOurs: number, wrongOurs: number }>} */
    const byDomain = new Map();
    for (const row of result.rows) {
      // `www.` is the same site; any other subdomain is kept as cited.
      const domains = new Set(list(row.citations).map((citation) => String(citation?.domain ?? "").toLowerCase().replace(/^www\./u, "")).filter(Boolean));
      for (const domain of domains) {
        const entry = byDomain.get(domain) ?? { cited: {}, mentionsOurs: 0, wrongOurs: 0 };
        const engine = String(row.engine);
        const pool = String(row.pool ?? "none");
        entry.cited[engine] ??= {};
        entry.cited[engine][pool] = (entry.cited[engine][pool] ?? 0) + 1;
        if (row.mentions_ours) entry.mentionsOurs += 1;
        if (row.failure_mode === "wrong_ours") entry.wrongOurs += 1;
        byDomain.set(domain, entry);
      }
    }
    await this.transaction(async (client) => {
      // A domain this round did not cite has no citations in it.
      await client.query(`UPDATE evimed_geo.sources SET cited = '{}'::jsonb, mentions_ours = 0, wrong_ours = 0, updated_at = $2
        WHERE geo_project_id = $1 AND NOT (domain = ANY($3::text[])) AND cited <> '{}'::jsonb`, [geoProjectId, now.toISOString(), [...byDomain.keys()]]);
      for (const [domain, entry] of byDomain) {
        await client.query(`INSERT INTO evimed_geo.sources (id, user_id, geo_project_id, domain, cited, mentions_ours, wrong_ours, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $8)
          ON CONFLICT (geo_project_id, domain) DO UPDATE SET cited = EXCLUDED.cited, mentions_ours = EXCLUDED.mentions_ours,
            wrong_ours = EXCLUDED.wrong_ours, updated_at = EXCLUDED.updated_at`,
        [randomId("gsrc_"), userId, geoProjectId, domain, JSON.stringify(entry.cited), entry.mentionsOurs, entry.wrongOurs, now.toISOString()]);
      }
    });
    return byDomain.size;
  }
}

/**
 * Recount a round's done and failed jobs (skipped counts as not answered).
 * @param {any} client @param {string} roundId
 */
async function recount(client, roundId) {
  const counts = await client.query(`SELECT count(*) FILTER (WHERE status = 'done')::integer AS done,
      count(*) FILTER (WHERE status IN ('failed', 'skipped'))::integer AS failed
    FROM evimed_geo.probe_jobs WHERE round_id = $1`, [roundId]);
  const done = Number(counts.rows[0]?.done ?? 0);
  const failed = Number(counts.rows[0]?.failed ?? 0);
  await client.query("UPDATE evimed_geo.rounds SET done = $2, failed = $3 WHERE id = $1", [roundId, done, failed]);
  return { done, failed };
}
