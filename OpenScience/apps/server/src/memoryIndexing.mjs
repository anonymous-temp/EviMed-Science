import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";
import { capsuleFactUri, capsuleMemoryRoot, capsuleSegment, capsuleTreeUri, parseCapsuleFactUri } from "./openVikingClient.mjs";

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

/** How many facts are written at once, and how long a write may wait for its
 *  vector before the server answers 504. The wait bound stays below the
 *  client's own request timeout so that a slow embedding is reported by the
 *  server, which knows whether the content was written, rather than by an
 *  aborted socket, which does not. */
const WRITE_CONCURRENCY = 4;
const WRITE_WAIT_SECONDS = 5;

/** What one fact looks like as a file. The kind and the layer lead, because
 *  they are the words a reader (and an embedding) needs to place the sentence
 *  that follows. Provenance is deliberately absent: it is delivered from the
 *  canonical row at recall time and has no business being embedded. */
function factDocument(entry) {
  const header = entry.layer ? `${entry.factKind} / ${entry.layer}` : entry.factKind;
  return `${header}\n\n${entry.content}`;
}

/**
 * The capsule index: canonical PostgreSQL stays authoritative, OpenViking ranks.
 *
 * The index holds a derived copy of approved capsule facts, one file per fact,
 * under a path bound to the account generation. Nothing is ever delivered from
 * it: a hit names a fact, that fact is reloaded from PostgreSQL, and a hit
 * whose row is gone, retired, superseded or in a deactivated capsule is
 * dropped. That is what makes a stale index harmless and a rebuild always safe.
 */
export class MemoryIndexing {
  /** @param {{database:any,openViking:any,jobs:any,rerank?:any}} dependencies */
  constructor({ database, openViking, jobs, rerank = null }) {
    this.database = database;
    this.openViking = openViking;
    this.jobs = jobs;
    this.rerank = rerank;
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

  /** Purge every registered capsule subtree while the caller holds the account deletion transaction.
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
      await this.openViking.remove(userId, capsuleMemoryRoot(userId, { accountCreatedAt, capsuleId }), { recursive: true });
    }
    // Then the whole capsule tree, which is the only thing that also removes a
    // subtree this ledger never recorded — an earlier account generation's, or
    // one whose publication row was lost.
    await this.openViking.remove(userId, capsuleTreeUri(userId), { recursive: true });
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
      // The kind is part of the path and the layer part of the file, so both
      // belong to the fingerprint: editing either has to force a rebuild.
      factKind: String(fact.payload.factKind ?? ""),
      layer: String(fact.payload.layer ?? ""),
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

  /** What the index actually holds for this capsule, read from the paths.
   *
   * The leaf name carries the fact id and its revision, so this compares exact
   * pairs without reading a single file: OpenViking drops unknown frontmatter,
   * which means a header inside the file could not be trusted to survive the
   * round trip, while the path it was written to always does.
   *
   * @param {any} snapshot
   */
  async readback(snapshot) {
    const root = capsuleMemoryRoot(snapshot.userId, { accountCreatedAt: snapshot.generation, capsuleId: snapshot.capsuleId });
    const segment = capsuleSegment(snapshot.generation, snapshot.capsuleId);
    const expected = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const mismatch = () => new HttpError(502, "memory_index_readback_mismatch", "Memory index readback contained a stale or unowned leaf.");
    const found = [];
    const seen = new Set();
    for (const directory of await this.#list(snapshot.userId, root)) {
      if (!directory?.isDir) throw mismatch();
      for (const leaf of await this.#list(snapshot.userId, String(directory.uri ?? ""))) {
        const parsed = parseCapsuleFactUri(String(leaf?.uri ?? ""));
        const entry = parsed ? expected.get(parsed.factId) : null;
        if (!parsed || parsed.capsuleSegment !== segment || !entry || seen.has(parsed.factId)
          || entry.revision !== parsed.revision || entry.factKind !== parsed.factKind) {
          throw mismatch();
        }
        seen.add(parsed.factId);
        found.push({ factId: parsed.factId, factKind: parsed.factKind, revision: parsed.revision, uri: String(leaf.uri) });
      }
    }
    if (seen.size !== expected.size) {
      throw new HttpError(502, "memory_index_readback_incomplete", "Memory index readback did not contain every canonical fact.");
    }
    return found;
  }

  /** A directory as it is, where "not there" and "empty" mean the same thing.
   *  A capsule that was never indexed, or whose subtree was removed, must read
   *  as an empty index rather than as an error, or rebuild could never be the
   *  thing that repairs it.
   *  @param {string} userId @param {string} uri */
  async #list(userId, uri) {
    try {
      return await this.openViking.listAll(userId, uri);
    } catch (error) {
      if (error instanceof HttpError && error.code === "memory_index_not_found") return [];
      throw error;
    }
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
          // An old SQL receipt cannot prove that the index still has its files.
          // Only observed drift justifies rewriting a subtree; transport and
          // malformed-response failures retain ordinary retries.
          if (!["memory_index_readback_incomplete", "memory_index_readback_mismatch"].includes(error?.code)) throw error;
        }
        if (verified) {
          return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken,
            { status: "already_current", capsuleId, fingerprint: snapshot.fingerprint }, verifySnapshot);
        }
      }
      await this.openViking.remove(job.userId, capsuleMemoryRoot(job.userId, { accountCreatedAt, capsuleId }), { recursive: true });
      await this.#writeEntries(job.userId, accountCreatedAt, capsuleId, snapshot.entries);
      await this.readback(snapshot);
      const status = snapshot.live ? "published" : "retired";
      return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken,
        { status, capsuleId, entries: snapshot.entries.length, fingerprint: snapshot.fingerprint },
        async (client) => {
          await verifySnapshot(client);
          await client.query(`INSERT INTO evimed_product.memory_index_state
            (user_id,capsule_id,account_created_at,fingerprint,entry_count,status,last_job_id,published_at,verified_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp())
            ON CONFLICT(user_id,capsule_id) DO UPDATE SET account_created_at=excluded.account_created_at,
              fingerprint=excluded.fingerprint,entry_count=excluded.entry_count,status=excluded.status,
              last_job_id=excluded.last_job_id,published_at=clock_timestamp(),verified_at=clock_timestamp()`,
          [job.userId, capsuleId, accountCreatedAt, snapshot.fingerprint, snapshot.entries.length, status, job.id]);
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

  /** Write every fact of one capsule, a few at a time.
   *
   * There is no batch write, and `wait: true` is not optional here: a file the
   * server has accepted but not yet embedded is invisible to `find`, so a
   * rebuild that did not wait would publish a fingerprint for an index that
   * cannot answer yet, and the readback that follows would fail at random.
   * Concurrency is bounded because each write costs one embedding call.
   *
   * @param {string} userId @param {string} accountCreatedAt @param {string} capsuleId @param {any[]} entries
   */
  async #writeEntries(userId, accountCreatedAt, capsuleId, entries) {
    const pending = [...entries];
    /** @type {any} */
    let failure = null;
    const worker = async () => {
      for (let entry = pending.shift(); entry && !failure; entry = pending.shift()) {
        try {
          await this.openViking.write(userId, capsuleFactUri(userId, {
            accountCreatedAt, capsuleId, factKind: entry.factKind, factId: entry.id, revision: entry.revision,
          }), factDocument(entry), { wait: true, timeoutSeconds: WRITE_WAIT_SECONDS });
        } catch (error) {
          // Stop taking new work, but let the writers already in flight settle
          // before the failure is raised: a rebuild that abandoned them would
          // race its own retry.
          failure ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, entries.length) }, worker));
    if (failure) throw failure;
  }

  /** The index nominates; PostgreSQL decides. Every value delivered here is
   *  read from the canonical row, so the worst a stale index can do is name a
   *  fact that is then dropped.
   * @param {string} userId @param {string} accountCreatedAt @param {{capsuleId:string,mode:string}[]} selections
   * @param {string} query @param {number} limit @param {string|null} projectId */
  async recall(userId, accountCreatedAt, selections, query, limit, projectId = null) {
    const current = await this.database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId]);
    if (current.rows[0]?.generation !== accountCreatedAt) throw new HttpError(409, "memory_account_changed", "The account changed during memory recall.");
    if (!selections.length) return [];
    const targets = [];
    /** @type {Map<string,{capsuleId:string,scopeRank:number}>} */
    const owners = new Map();
    for (const [scopeRank, selection] of selections.entries()) {
      targets.push(capsuleMemoryRoot(userId, { accountCreatedAt, capsuleId: selection.capsuleId }));
      owners.set(capsuleSegment(accountCreatedAt, selection.capsuleId), { capsuleId: selection.capsuleId, scopeRank });
    }
    // One search over every active capsule's subtree. No peer header: it filters
    // nothing outside `peers/`, and the isolation that matters is the target
    // list plus the canonical re-check below.
    const hits = await this.openViking.find(userId, query, { targets, limit: Math.max(1, Math.min(100, Number(limit) || 1)) });
    const candidates = [];
    const nominated = new Set();
    for (const [rank, hit] of hits.entries()) {
      const parsed = parseCapsuleFactUri(hit.uri);
      // A hit we did not write, or one from a capsule this recall did not ask
      // for: it names nothing we can hydrate, so it is not a candidate.
      if (!parsed || nominated.has(parsed.factId)) continue;
      const owner = owners.get(parsed.capsuleSegment);
      if (!owner) continue;
      nominated.add(parsed.factId);
      candidates.push({ ...parsed, rank, score: hit.score, capsuleId: owner.capsuleId, scopeRank: owner.scopeRank });
    }
    if (!candidates.length) return [];
    candidates.sort((a, b) => b.score - a.score || a.scopeRank - b.scopeRank || a.rank - b.rank);
    const ids = candidates.map((candidate) => candidate.factId);
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
    const eligible = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const row = byId.get(candidate.factId);
      if (!row || seen.has(row.id) || row.revision !== candidate.revision
        || row.payload.status !== "approved" || row.payload.capsuleId !== candidate.capsuleId
        || !active.has(candidate.capsuleId)) continue;
      seen.add(row.id);
      eligible.push({ row, selection: { capsuleId: candidate.capsuleId, mode: active.get(candidate.capsuleId) } });
    }
    const ordered = await this.#reranked(query, eligible);
    return ordered.slice(0, limit);
  }

  /** Reorder the hydrated candidates, if a reranker is configured.
   *
   * The candidates are already the surviving canonical rows, so this reorders
   * the text the researcher would actually see. Anything unexpected keeps the
   * vector order: a reranker is an improvement, never a dependency.
   *
   * @param {string} query @param {{row:any,selection:any}[]} candidates
   */
  async #reranked(query, candidates) {
    if (!this.rerank?.configured || candidates.length < 2) return candidates;
    try {
      const order = await this.rerank.order(query, candidates.map((candidate) => String(candidate.row.payload.content ?? "")));
      if (!Array.isArray(order) || order.length !== candidates.length) return candidates;
      const reordered = [];
      const used = new Set();
      for (const index of order) {
        if (!Number.isInteger(index) || index < 0 || index >= candidates.length || used.has(index)) return candidates;
        used.add(index);
        reordered.push(candidates[index]);
      }
      return reordered;
    } catch {
      return candidates;
    }
  }

  /** Detect canonical changes and index loss without manufacturing recurring duplicate jobs. */
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
          reason: row.fingerprint === snapshot.fingerprint ? "index_drift" : "canonical_change" }, {
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
