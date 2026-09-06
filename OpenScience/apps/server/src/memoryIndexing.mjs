import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function provenanceIds(provenance) {
  if (!Array.isArray(provenance)) return [];
  return provenance.map((item) => `${item.type}:${item.id}`);
}

function accountLockName(userId) {
  return `memory-index-account:${userId}`;
}

/** Canonical PostgreSQL remains authoritative; MemOS supplies ranking only. */
export class MemoryIndexing {
  /** @param {{database:any,engine:any,jobs:any}} dependencies */
  constructor({ database, engine, jobs }) {
    this.database = database;
    this.engine = engine;
    this.jobs = jobs;
  }

  /** @param {string} userId */
  async accountGeneration(userId) {
    const account = await this.database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId]);
    return account.rows[0]?.generation ?? null;
  }

  /** Acquire before the account row lock so rebuild, FK checks and deletion share one lock order.
   * @param {string} userId @param {any} client */
  async lockAccountDeletion(userId, client) {
    if (!client || typeof client.query !== "function") {
      throw new HttpError(503, "memory_index_delete_unavailable", "Memory index account deletion requires the transactional database client.");
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [accountLockName(userId)]);
  }

  /** Purge every registered capsule namespace while the caller holds the account deletion transaction.
   * Taking the same capsule locks as rebuild prevents an index worker from restoring data after purge.
   * @param {string} userId @param {string} accountCreatedAt @param {any} client */
  async prepareAccountDeletion(userId, accountCreatedAt, client) {
    if (!client || typeof client.query !== "function") {
      throw new HttpError(503, "memory_index_delete_unavailable", "Memory index account deletion requires the transactional database client.");
    }
    const account = await client.query(
      "SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1",
      [userId],
    );
    if (account.rows[0]?.generation !== accountCreatedAt) {
      throw new HttpError(409, "memory_account_changed", "The account changed before memory index deletion completed.");
    }
    const result = await client.query(`SELECT id AS capsule_id FROM evimed_product.documents
      WHERE user_id=$1 AND kind='capsule'
      UNION SELECT capsule_id FROM evimed_product.memory_index_state WHERE user_id=$1
      ORDER BY capsule_id`, [userId]);
    const capsuleIds = result.rows.map((row) => row.capsule_id);
    for (const capsuleId of capsuleIds) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`memory-index:${userId}:${capsuleId}`]);
    }
    for (const capsuleId of capsuleIds) {
      await this.engine.deleteScope(userId, { accountCreatedAt, capsuleId });
    }
    return { scopes: capsuleIds.length, verified: true };
  }

  /** @param {string} userId @param {string} capsuleId @param {{client?:any,lock?:boolean}} [options] */
  async snapshot(userId, capsuleId, { client = this.database, lock = false } = {}) {
    const lockClause = lock ? " FOR SHARE" : "";
    // Account generation is immutable. Do not lock its row here: rebuild holds
    // the capsule advisory lock, while account deletion holds the user row and
    // then requests that advisory lock. Locking both in the opposite order
    // creates a real PostgreSQL deadlock. Capsule and fact rows still receive
    // FOR SHARE below, which is the mutable canonical state being published.
    const account = await client.query(
      "SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1",
      [userId],
    );
    if (!account.rows[0]) return null;
    const capsule = await client.query(`SELECT id,revision,payload,deleted_at
      FROM evimed_product.documents WHERE user_id=$1 AND kind='capsule' AND id=$2${lockClause}`, [userId, capsuleId]);
    const row = capsule.rows[0] ?? null;
    const facts = row && row.deleted_at == null
      ? await client.query(`SELECT id,revision,payload FROM evimed_product.documents
          WHERE user_id=$1 AND kind='fact' AND deleted_at IS NULL
          AND payload->>'capsuleId'=$2 AND payload->>'status'='approved' ORDER BY id${lockClause}`, [userId, capsuleId])
      : { rows: [] };
    const entries = facts.rows.map((fact) => ({
      id: fact.id,
      revision: fact.revision,
      content: fact.payload.content,
      provenanceIds: provenanceIds(fact.payload.provenance),
    }));
    const generation = account.rows[0].generation;
    const live = Boolean(row && row.deleted_at == null);
    return {
      userId, capsuleId, generation, live, capsuleRevision: row?.revision ?? 0, entries,
      fingerprint: digest([generation, capsuleId, live, row?.revision ?? 0, entries]),
    };
  }

  /** @param {any} snapshot */
  async readback(snapshot) {
    const records = [];
    for (let page = 1; ; page++) {
      const result = await this.engine.export(snapshot.userId, {
        accountCreatedAt: snapshot.generation, capsuleId: snapshot.capsuleId, page, pageSize: 100,
      });
      records.push(...result.records);
      if (result.nextPage === null) break;
      if (page >= 10_000) throw new HttpError(502, "memory_index_readback_invalid", "Memory index readback did not terminate.");
    }
    const expected = new Map(snapshot.entries.map((entry) => [entry.id, entry.revision]));
    const found = new Set();
    for (const record of records) {
      if (!record.entryId || expected.get(record.entryId) !== record.revision) {
        throw new HttpError(502, "memory_index_readback_mismatch", "Memory index readback contained a stale or unowned revision.");
      }
      found.add(record.entryId);
    }
    if (found.size !== expected.size) {
      throw new HttpError(502, "memory_index_readback_incomplete", "Memory index readback did not contain every canonical fact.");
    }
    return records;
  }

  /** Rebuild one capsule as a unit. A later writer changes the fingerprint and prevents publication.
   * @param {any} job */
  async rebuild(job) {
    const capsuleId = job.payload?.capsuleId;
    const accountCreatedAt = job.payload?.accountCreatedAt;
    if (typeof capsuleId !== "string" || typeof accountCreatedAt !== "string") {
      throw new HttpError(400, "memory_index_job_invalid", "Memory index job payload is invalid.");
    }
    const lock = await this.database.pool.connect();
    const accountLock = accountLockName(job.userId);
    const lockName = `memory-index:${job.userId}:${capsuleId}`;
    let accountLocked = false;
    let capsuleLocked = false;
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [accountLock]);
      accountLocked = true;
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockName]);
      capsuleLocked = true;
      const snapshot = await this.snapshot(job.userId, capsuleId);
      if (!snapshot || snapshot.generation !== accountCreatedAt) {
        return this.jobs.finish(job.userId, job.id, job.leaseToken, { status: "superseded_account_generation" });
      }
      const verifySnapshot = async (client) => {
        const current = await this.snapshot(job.userId, capsuleId, { client, lock: true });
        if (!current || current.fingerprint !== snapshot.fingerprint) {
          throw new HttpError(409, "memory_index_snapshot_changed", "Canonical memory changed while its index was being verified.");
        }
      };
      const published = await this.database.query(`SELECT fingerprint,account_created_at FROM evimed_product.memory_index_state
        WHERE user_id=$1 AND capsule_id=$2`, [job.userId, capsuleId]);
      if (published.rows[0]?.fingerprint === snapshot.fingerprint
        && published.rows[0]?.account_created_at === snapshot.generation) {
        let verified = false;
        try {
          await this.readback(snapshot);
          verified = true;
        } catch (error) {
          // An old SQL receipt cannot prove that the engine still has its
          // records. Only observed record drift justifies replacing a scope;
          // transport and malformed-response failures retain ordinary retries.
          if (!["memory_index_readback_incomplete", "memory_index_readback_mismatch"].includes(error?.code)) throw error;
        }
        if (verified) {
          return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken,
            { status: "already_current", capsuleId, fingerprint: snapshot.fingerprint }, verifySnapshot);
        }
      }
      await this.engine.deleteScope(job.userId, { accountCreatedAt, capsuleId });
      const memoryIds = [];
      for (let offset = 0; offset < snapshot.entries.length; offset += 20) {
        const batch = snapshot.entries.slice(offset, offset + 20).map((entry) => ({
          entryId: entry.id, content: entry.content, provenanceIds: entry.provenanceIds, revision: entry.revision,
        }));
        const stored = await this.engine.add(job.userId, batch, { accountCreatedAt, capsuleId });
        for (const record of stored.records) memoryIds.push(...record.memoryIds);
      }
      const readback = await this.readback(snapshot);
      const status = snapshot.live ? "published" : "retired";
      return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken,
        { status, capsuleId, entries: snapshot.entries.length, fingerprint: snapshot.fingerprint },
        async (client) => {
          await verifySnapshot(client);
          await client.query(`INSERT INTO evimed_product.memory_index_state
            (user_id,capsule_id,account_created_at,fingerprint,entry_count,status,engine_memory_ids,last_job_id,published_at,verified_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,clock_timestamp(),clock_timestamp())
            ON CONFLICT(user_id,capsule_id) DO UPDATE SET account_created_at=excluded.account_created_at,
              fingerprint=excluded.fingerprint,entry_count=excluded.entry_count,status=excluded.status,
              engine_memory_ids=excluded.engine_memory_ids,last_job_id=excluded.last_job_id,
              published_at=clock_timestamp(),verified_at=clock_timestamp()`,
          [job.userId, capsuleId, accountCreatedAt, snapshot.fingerprint, snapshot.entries.length,
            status, JSON.stringify(memoryIds.length ? memoryIds : readback.map((record) => record.id)), job.id]);
        });
    } finally {
      try {
        if (capsuleLocked) await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockName]);
      } finally {
        try {
          if (accountLocked) await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [accountLock]);
        } finally { lock.release(); }
      }
    }
  }

  /** MemOS ranks opaque references; every delivered value is reloaded from PostgreSQL.
   * @param {string} userId @param {string} accountCreatedAt @param {{capsuleId:string,mode:string}[]} selections
   * @param {string} query @param {number} limit @param {string|null} projectId */
  async recall(userId, accountCreatedAt, selections, query, limit, projectId = null) {
    const current = await this.database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId]);
    if (current.rows[0]?.generation !== accountCreatedAt) throw new HttpError(409, "memory_account_changed", "The account changed during memory recall.");
    const ranked = await Promise.all(selections.map(async (selection, scopeRank) => {
      const records = await this.engine.search(userId, query, { accountCreatedAt, capsuleId: selection.capsuleId, limit });
      return records.map((record) => ({ ...record, scopeRank, selection }));
    }));
    const candidates = ranked.flat().sort((a, b) => a.rank - b.rank || a.scopeRank - b.scopeRank).slice(0, limit * 4);
    const ids = [...new Set(candidates.map((item) => item.entryId).filter(Boolean))];
    if (!ids.length) return [];
    const activationIds = ["active-capsules:account", ...(projectId ? [`active-capsules:project:${projectId}`] : [])];
    const preferences = await this.database.query(`SELECT id,payload FROM evimed_product.documents
      WHERE user_id=$1 AND kind='preferences' AND id=ANY($2::text[]) AND deleted_at IS NULL`, [userId, activationIds]);
    const localId = projectId ? `active-capsules:project:${projectId}` : "active-capsules:account";
    const orderedPreferences = [...preferences.rows].sort((a, b) => (a.id === localId ? -1 : b.id === localId ? 1 : 0));
    const active = new Map();
    for (const preference of orderedPreferences) {
      for (const item of preference.payload.items ?? []) {
        if (!active.has(item.capsuleId)) active.set(item.capsuleId, item.mode);
      }
    }
    const canonical = await this.database.query(`SELECT id,revision,payload,created_at FROM evimed_product.documents
      WHERE user_id=$1 AND kind='fact' AND id=ANY($2::text[]) AND deleted_at IS NULL`, [userId, ids]);
    const byId = new Map(canonical.rows.map((row) => [row.id, row]));
    const delivered = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const row = byId.get(candidate.entryId);
      if (!row || seen.has(row.id) || row.revision !== candidate.revision
        || row.payload.status !== "approved" || row.payload.capsuleId !== candidate.selection.capsuleId
        || !active.has(candidate.selection.capsuleId)) continue;
      seen.add(row.id);
      delivered.push({ row, selection: { capsuleId: candidate.selection.capsuleId, mode: active.get(candidate.selection.capsuleId) } });
      if (delivered.length === limit) break;
    }
    return delivered;
  }

  /** Detect canonical changes and engine loss without manufacturing recurring duplicate jobs. */
  async reconcile(limit = 25) {
    const rows = await this.database.query(`SELECT d.user_id,d.id,s.fingerprint,s.status,s.published_at
      FROM evimed_product.documents d LEFT JOIN evimed_product.memory_index_state s
        ON s.user_id=d.user_id AND s.capsule_id=d.id
      WHERE d.kind='capsule' ORDER BY coalesce(s.verified_at,'epoch'::timestamptz),d.user_id,d.id LIMIT $1`, [limit]);
    let enqueued = 0;
    for (const row of rows.rows) {
      const snapshot = await this.snapshot(row.user_id, row.id);
      if (!snapshot) continue;
      let drift = row.fingerprint !== snapshot.fingerprint;
      if (!drift) {
        try { await this.readback(snapshot); }
        catch { drift = true; }
      }
      if (drift) {
        await this.jobs.enqueue(row.user_id, "memory-index", { capsuleId: row.id, accountCreatedAt: snapshot.generation,
          reason: row.fingerprint === snapshot.fingerprint ? "engine_drift" : "canonical_change" }, {
          idempotencyKey: `memory-index:reconcile:${snapshot.fingerprint}:${row.published_at?.toISOString?.() ?? "new"}`,
          maxAttempts: 10, rearmFailed: true,
        });
        enqueued++;
      } else {
        await this.database.query("UPDATE evimed_product.memory_index_state SET verified_at=clock_timestamp() WHERE user_id=$1 AND capsule_id=$2", [row.user_id, row.id]);
      }
    }
    return { scanned: rows.rowCount, enqueued };
  }
}
