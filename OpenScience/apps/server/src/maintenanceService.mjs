import { HttpError } from "./security.mjs";
import { migrateProductStore } from "./productPersistence.mjs";

const ADVISORY_LOCK = "evimed-maintenance-v1";
const MAX_TTL_SECONDS = 3600;

function maintenanceError(status, code, message) {
  return new HttpError(status, code, message);
}

function requestId(value) {
  if (typeof value !== "string" || !value || value.length > 200 || [...value].some((char) => char.charCodeAt(0) < 32)) {
    throw maintenanceError(400, "maintenance_request_invalid", "A valid maintenance request id is required.");
  }
  return value;
}

function ttlSeconds(value) {
  if (!Number.isSafeInteger(value) || value < 5 || value > MAX_TTL_SECONDS) {
    throw maintenanceError(400, "maintenance_request_invalid", `Maintenance ttlSeconds must be between 5 and ${MAX_TTL_SECONDS}.`);
  }
  return value;
}

function leaseFromRow(row) {
  if (!row) return null;
  const requestedAt = new Date(row.requested_at);
  const expiresAt = new Date(row.expires_at);
  let id;
  try { id = requestId(row.request_id); } catch { /* Stored corruption is an operational failure. */ }
  if (!id || !Number.isFinite(requestedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= requestedAt) {
    throw maintenanceError(503, "maintenance_state_invalid", "Maintenance state is unavailable.");
  }
  if (row.durable_hold !== undefined && typeof row.durable_hold !== 'boolean') {
    throw maintenanceError(503, "maintenance_state_invalid", "Maintenance state is unavailable.");
  }
  return { requestId: id, requestedAt: requestedAt.toISOString(), expiresAt: expiresAt.toISOString(),
    ...(row.durable_hold ? { durableHold: true } : {}) };
}

async function activeLease(client) {
  const result = await client.query(`SELECT request_id,requested_at,expires_at,durable_hold
    FROM evimed_product.maintenance_lease WHERE singleton=true AND (durable_hold OR expires_at>clock_timestamp())`);
  if (result.rows.length > 1) throw maintenanceError(503, "maintenance_state_invalid", "Maintenance state is unavailable.");
  return leaseFromRow(result.rows[0]);
}

async function sharedLock(client) {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [ADVISORY_LOCK]);
}

async function exclusiveLock(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ADVISORY_LOCK]);
}

/** Serialize a worker claim with maintenance activation. The caller owns the transaction. */
export async function maintenanceAllowsClaims(client) {
  await sharedLock(client);
  return (await activeLease(client)) === null;
}

function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizedActivity(raw, activeMutations, databaseActivity) {
  const runtimes = raw?.runtimes;
  const values = {
    activeMutations: count(activeMutations),
    activeCommands: count(raw?.activeCommands),
    activeTasks: count(raw?.activeTasks),
    backgroundOperations: count(raw?.backgroundOperations),
    runningAgentRuns: count(raw?.runningAgentRuns),
    runningProductJobs: count(databaseActivity?.running_jobs) === null || count(raw?.heavyWorkJobs ?? 0) === null
      ? null : count(databaseActivity.running_jobs) + count(raw?.heavyWorkJobs ?? 0),
    pendingPromptAdmissions: count(databaseActivity?.pending_prompts),
    activeDatabaseSessions: count(databaseActivity?.active_sessions),
    busyRuntimes: count(runtimes?.busy),
    unknownRuntimes: count(runtimes?.unknown),
  };
  if (Object.values(values).some((value) => value === null) || count(runtimes?.idle) === null) {
    return {
      activeMutations: count(activeMutations) ?? 0,
      activeCommands: 0,
      activeTasks: 0,
      backgroundOperations: 0,
      runningAgentRuns: 0,
      runningProductJobs: count(databaseActivity?.running_jobs) ?? 0,
      pendingPromptAdmissions: count(databaseActivity?.pending_prompts) ?? 0,
      activeDatabaseSessions: count(databaseActivity?.active_sessions) ?? 0,
      busyRuntimes: 0,
      unknownRuntimes: 0,
      unknown: 1,
    };
  }
  return { ...values, unknown: 0 };
}

/** Expiring maintenance with an explicit protective hold for physical operations.
 * Admission locks are short; customer work runs outside them. */
export class MaintenanceService {
  constructor(database, {
    inspectActivity = async () => ({
      activeCommands: 0,
      activeTasks: 0,
      backgroundOperations: 0,
      runningAgentRuns: 0,
      runtimes: { busy: 0, idle: 0, unknown: 0 },
    }),
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    migrate = migrateProductStore,
  } = {}) {
    if (!database || typeof database.query !== "function" || typeof database.transaction !== "function") {
      throw new TypeError("MaintenanceService requires a transactional database.");
    }
    if (typeof inspectActivity !== "function") throw new TypeError("Maintenance activity inspector must be a function.");
    if (typeof migrate !== "function") throw new TypeError("Maintenance migration must be a function.");
    this.database = database;
    this.inspectActivity = inspectActivity;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.migrate = migrate;
    this.timer = null;
    this.cachedState = "unknown";
    this.activeMutations = 0;
    this.listeners = new Set();
  }

  async initialize() {
    await this.migrate(this.database);
    await this.refresh();
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Maintenance listener must be a function.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  claimingAllowed() {
    return this.cachedState === "open";
  }

  notify() {
    for (const listener of this.listeners) listener(this.cachedState);
  }

  scheduleExpiry(lease) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (!lease) return;
    // A protective hold has no expiry. Poll for an explicit release by
    // another replica using the existing timer; never infer release from age.
    const delay = lease.durableHold ? 1000 : Math.max(1, Date.parse(lease.expiresAt) - this.now().getTime());
    this.timer = this.setTimer(async () => {
      this.timer = null;
      try { await this.refresh(); }
      catch { this.failClosedAndRetry(); }
    }, delay);
    this.timer?.unref?.();
  }

  failClosedAndRetry() {
    this.cachedState = "unknown";
    this.notify();
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(async () => {
      this.timer = null;
      try { await this.refresh(); } catch { this.failClosedAndRetry(); }
    }, 1000);
    this.timer?.unref?.();
  }

  updateCache(lease) {
    const state = lease ? "maintenance" : "open";
    const changed = state !== this.cachedState;
    this.cachedState = state;
    this.scheduleExpiry(lease);
    if (changed) this.notify();
  }

  async refresh() {
    await this.migrate(this.database);
    const lease = await activeLease(this.database);
    this.updateCache(lease);
    return lease;
  }

  async request(input) {
    const id = requestId(input?.requestId);
    const ttl = ttlSeconds(input?.ttlSeconds);
    await this.migrate(this.database);
    const lease = await this.database.transaction(async (client) => {
      await exclusiveLock(client);
      const result = await client.query(`INSERT INTO evimed_product.maintenance_lease(singleton,request_id,requested_at,expires_at)
        VALUES (true,$1,clock_timestamp(),clock_timestamp()+($2::integer*interval '1 second'))
        ON CONFLICT(singleton) DO UPDATE SET request_id=excluded.request_id,requested_at=excluded.requested_at,expires_at=excluded.expires_at
        WHERE (NOT evimed_product.maintenance_lease.durable_hold AND evimed_product.maintenance_lease.expires_at<=clock_timestamp())
          OR evimed_product.maintenance_lease.request_id=excluded.request_id
        RETURNING request_id,requested_at,expires_at,durable_hold`, [id, ttl]);
      if (!result.rows[0]) throw maintenanceError(409, "maintenance_conflict", "Another maintenance request owns the active lease.");
      return leaseFromRow(result.rows[0]);
    });
    this.updateCache(lease);
    return this.status();
  }

  /** Establish before starting a physical capture. Renewal cannot clear it;
   * the authenticated owner releases only after physical stop is proved. */
  async hold(input) {
    const id = requestId(input?.requestId);
    await this.migrate(this.database);
    const lease = await this.database.transaction(async client => {
      await exclusiveLock(client);
      const current = await activeLease(client);
      if (!current || current.requestId !== id) throw maintenanceError(409, 'maintenance_conflict', 'The active maintenance request does not match.');
      const result = await client.query(`UPDATE evimed_product.maintenance_lease SET durable_hold=true
        WHERE singleton=true AND request_id=$1 RETURNING request_id,requested_at,expires_at,durable_hold`, [id]);
      if (!result.rows[0]) throw maintenanceError(409, 'maintenance_conflict', 'Maintenance changed before the protective hold.');
      return leaseFromRow(result.rows[0]);
    });
    this.updateCache(lease);
    return this.status();
  }

  async release(input) {
    const id = requestId(input?.requestId);
    await this.migrate(this.database);
    await this.database.transaction(async (client) => {
      await exclusiveLock(client);
      const current = await activeLease(client);
      if (current && current.requestId !== id) {
        throw maintenanceError(409, "maintenance_conflict", "Another maintenance request owns the active lease.");
      }
      if (current) {
        const deleted = await client.query(`DELETE FROM evimed_product.maintenance_lease
          WHERE singleton=true AND request_id=$1 RETURNING request_id,requested_at,expires_at`, [id]);
        if (!deleted.rows[0]) throw maintenanceError(409, "maintenance_conflict", "Maintenance lease changed before release.");
      } else {
        await client.query("DELETE FROM evimed_product.maintenance_lease WHERE singleton=true AND NOT durable_hold AND expires_at<=clock_timestamp()");
      }
    });
    this.updateCache(null);
    return { state: "open", lease: null };
  }

  async withMutation(operation) {
    if (typeof operation !== "function") throw new TypeError("Maintenance mutation operation must be a function.");
    const release = await this.admitMutation();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async admitMutation() {
    await this.migrate(this.database);
    let admitted = false;
    try {
      await this.database.transaction(async (client) => {
        await sharedLock(client);
        const lease = await activeLease(client);
        if (lease) throw maintenanceError(503, "maintenance_active", "The service is temporarily draining for maintenance.");
        this.activeMutations += 1;
        admitted = true;
      });
    } catch (error) {
      if (admitted) this.activeMutations -= 1;
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeMutations -= 1;
    };
  }

  async status() {
    await this.migrate(this.database);
    const lease = await activeLease(this.database);
    this.updateCache(lease);
    if (!lease) return { state: "open", lease: null };
    const blockers = await this.#blockers();
    const blocked = Object.values(blockers).some((value) => value > 0);
    return { state: blocked ? "draining" : "idle", lease, blockers };
  }

  /**
   * What is running now, whether or not a lease is held. The release switch
   * reads it before it moves `current`: a switch reaps the runtimes runs work
   * in, and on 2026-09-25 one took a GEO run with it mid-step. Draining would
   * refuse every new request for as long as the longest run takes; this only
   * lets the operator see that there is something to wait for.
   */
  async activity() {
    await this.migrate(this.database);
    return this.#blockers();
  }

  /**
   * What a release switch asks about instead of everything: the agent runs and busy runtimes of projects a researcher
   * owns. A switch reaps runtimes, and a run in one dies; the platform's own background projects are scratch and their
   * runs are retried, and a leased product job is re-claimed when its lease runs out, so neither is a reason to refuse
   * a release. `null` when the composition does not say (an older one, or an inspection that failed): the caller then
   * asks about everything, as before. A drained maintenance window never uses this — it needs the platform quiet.
   * @returns {Promise<{ runningAgentRuns: number, busyRuntimes: number } | null>}
   */
  async interactiveActivity() {
    await this.migrate(this.database);
    try {
      const interactive = (await this.inspectActivity())?.interactive;
      const runs = count(interactive?.runningAgentRuns);
      const busy = count(interactive?.busyRuntimes);
      return runs === null || busy === null ? null : { runningAgentRuns: runs, busyRuntimes: busy };
    } catch { return null; }
  }

  async #blockers() {
    let activity;
    let databaseActivity = null;
    let inspectionFailed = false;
    try {
      activity = await this.inspectActivity();
      databaseActivity = (await this.database.query(`SELECT
        (SELECT count(*)::text FROM evimed_product.jobs
          WHERE status='running' AND lease_expires_at>clock_timestamp()) AS running_jobs,
        (SELECT count(*)::text FROM evimed_product.plugin_prompt_admissions) AS pending_prompts,
        (SELECT count(*)::text FROM pg_catalog.pg_stat_activity
          WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid()
            AND state IS DISTINCT FROM 'idle') AS active_sessions`)).rows[0];
    } catch {
      inspectionFailed = true;
    }
    const blockers = inspectionFailed
      ? normalizedActivity(null, this.activeMutations, databaseActivity)
      : normalizedActivity(activity, this.activeMutations, databaseActivity);
    if (inspectionFailed) blockers.unknown = 1;
    return blockers;
  }

  async close() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
