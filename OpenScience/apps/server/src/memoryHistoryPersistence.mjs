import { migrateMemorySettings } from './memorySettingsPersistence.mjs';
import { migrateNativeMemory } from './nativeMemoryPersistence.mjs';
import { lineFingerprint, normalisedStatement, nativeMemoryRejectionType } from './nativeMemoryOverlay.mjs';
import { OPENVIKING_MEMORY_TYPES, OPENVIKING_PROJECT_MEMORY_TYPES } from './openVikingLayout.mjs';
import { compact } from './nativeMemoryRejections.mjs';

const migrations = new WeakMap();
const sql = `
-- No cascading owner FK: physical deletion remains owed after account erasure.
-- Text is held only by the engine. These are provenance, hashes and outbox state.
CREATE TABLE IF NOT EXISTS evimed_memory.history_chunks (
  uri text PRIMARY KEY, owner_id text NOT NULL, owner_created_at text NOT NULL,
  namespace_id text NOT NULL, project_id text NOT NULL, project_created_at text NOT NULL,
  session_id text NOT NULL, archive_uri text NOT NULL, digest text NOT NULL,
  minimum_date timestamptz, state text NOT NULL CHECK(state IN ('pending','ready','withdrawn')),
  cleaned_at timestamptz, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS history_chunks_scope ON evimed_memory.history_chunks(owner_id,owner_created_at,namespace_id,project_id,project_created_at);
CREATE INDEX IF NOT EXISTS history_chunks_cleanup ON evimed_memory.history_chunks(updated_at) WHERE state='withdrawn';
CREATE TABLE IF NOT EXISTS evimed_memory.history_fences (
  owner_id text NOT NULL, owner_created_at text NOT NULL, project_id text NOT NULL DEFAULT '', project_created_at text NOT NULL DEFAULT '', session_id text NOT NULL DEFAULT '',
  permanent boolean NOT NULL, cutoff timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,owner_created_at,project_id,project_created_at,session_id)
);
-- Discovery/retry progress is metadata only. Completed archives do not need
-- another memory extraction; this queue indexes their existing original text.
CREATE TABLE IF NOT EXISTS evimed_memory.history_archives (
  owner_id text NOT NULL, owner_created_at text NOT NULL, archive_uri text NOT NULL,
  engine_session text NOT NULL, namespace_id text NOT NULL DEFAULT '', project_id text,
  project_created_at text, commit_created_at timestamptz, source_hash text,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','indexing','complete','excluded','partial','unavailable','withdrawn')),
  reason text NOT NULL DEFAULT '', message_count integer NOT NULL DEFAULT 0,
  indexed_chunks integer NOT NULL DEFAULT 0, archive_bytes integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,owner_created_at,archive_uri)
);
CREATE INDEX IF NOT EXISTS history_archives_due ON evimed_memory.history_archives(next_attempt_at,updated_at)
  WHERE state IN ('queued','indexing','unavailable','partial');
ALTER TABLE evimed_memory.history_fences ADD COLUMN IF NOT EXISTS project_created_at text NOT NULL DEFAULT '';
ALTER TABLE evimed_memory.history_fences DROP CONSTRAINT IF EXISTS history_fences_pkey;
ALTER TABLE evimed_memory.history_fences ADD PRIMARY KEY(owner_id,owner_created_at,project_id,project_created_at,session_id);
`;

/** Exact URI authority and durable cleanup obligations, never raw messages. */
export class MemoryHistoryLedger {
  constructor({ database, overlay, client = null }) { this.database = database; this.overlay = overlay; this.client = client; }
  async migrate() {
    if (!migrations.has(this.database)) {
      const attempt = (async () => {
        await migrateMemorySettings(this.database); await migrateNativeMemory(this.database);
        await this.database.transaction(async c => { await c.query("SELECT pg_advisory_xact_lock(hashtext('evimed-memory-history-v1'))"); await c.query(sql); });
      })().catch(error => { migrations.delete(this.database); throw error; });
      migrations.set(this.database, attempt);
    }
    await migrations.get(this.database);
  }
  async locked(ownerId, operation) {
    await this.migrate();
    return this.database.transaction(async c => { await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`memory-history:${ownerId}`]); return operation(c); });
  }
  async blocked(c, meta) {
    const result = await c.query(`SELECT 1 FROM evimed_memory.history_fences WHERE owner_id=$1 AND owner_created_at=$2
      AND (project_id='' OR project_id=$3) AND (project_created_at='' OR project_created_at=$6) AND (session_id='' OR session_id=$4)
      AND (permanent OR $5::timestamptz IS NULL OR cutoff>$5::timestamptz) LIMIT 1`,
    [meta.ownerId, meta.ownerCreatedAt, meta.projectId, meta.sessionId, meta.minimumDate, meta.projectCreatedAt]);
    return result.rows.length > 0;
  }
  async reserve(meta, digest) {
    return this.locked(meta.ownerId, async c => {
      // The exact database incarnation, not a supplied header, chooses a root.
      const owner = await c.query('SELECT 1 FROM evimed_control.users WHERE id=$1 AND created_at::text=$2', [meta.ownerId, meta.ownerCreatedAt]);
      if (!owner.rows.length || await this.blocked(c, meta)) return false;
      const result = await c.query(`INSERT INTO evimed_memory.history_chunks
        (uri,owner_id,owner_created_at,namespace_id,project_id,project_created_at,session_id,archive_uri,digest,minimum_date,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,'pending') ON CONFLICT(uri) DO UPDATE SET updated_at=clock_timestamp()
        WHERE history_chunks.state<>'withdrawn' AND history_chunks.digest=EXCLUDED.digest RETURNING uri`,
      [meta.uri, meta.ownerId, meta.ownerCreatedAt, meta.namespaceId, meta.projectId, meta.projectCreatedAt, meta.sessionId, meta.archiveUri, digest, meta.minimumDate]);
      return result.rows.length > 0;
    });
  }
  async ready(meta) {
    return this.locked(meta.ownerId, async c => {
      if (await this.blocked(c, meta)) return false;
      const result = await c.query("UPDATE evimed_memory.history_chunks SET state='ready',updated_at=clock_timestamp() WHERE uri=$1 AND state<>'withdrawn' RETURNING uri", [meta.uri]);
      return result.rows.length > 0;
    });
  }
  async lookup(ownerId, ownerCreatedAt, namespaceId, projectId, projectCreatedAt, uri) {
    await this.migrate();
    const result = await this.database.query(`SELECT h.* FROM evimed_memory.history_chunks h WHERE uri=$1 AND owner_id=$2 AND owner_created_at=$3
      AND namespace_id=$4 AND project_id=$5 AND project_created_at=$6 AND state='ready'
      AND EXISTS (SELECT 1 FROM evimed_control.users u WHERE u.id=h.owner_id AND u.created_at::text=h.owner_created_at)
      AND NOT EXISTS (SELECT 1 FROM evimed_memory.history_fences f WHERE f.owner_id=h.owner_id AND f.owner_created_at=h.owner_created_at
        AND (f.project_id='' OR f.project_id=h.project_id) AND (f.project_created_at='' OR f.project_created_at=h.project_created_at) AND (f.session_id='' OR f.session_id=h.session_id)
        AND (f.permanent OR h.minimum_date IS NULL OR f.cutoff>h.minimum_date))`,
    [uri, ownerId, ownerCreatedAt, namespaceId, projectId, projectCreatedAt]);
    return result.rows[0] ?? null;
  }
  /** This query has no recency window. It probes every rejection in the exact
   * namespace against the finite candidate, including old edited text. A short
   * removed statement is conservatively suppressed when contained as well.
   */
  async rejected(context, texts) {
    await this.migrate();
    const types = (context.kind === 'geo-project' ? OPENVIKING_PROJECT_MEMORY_TYPES : OPENVIKING_MEMORY_TYPES)
      .map(type => nativeMemoryRejectionType(type, context.kind === 'geo-project' ? context.namespaceId : null));
    const lines = texts.flatMap(text => text.split('\n')).map(normalisedStatement).filter(Boolean);
    const result = await this.database.query(`SELECT 1 FROM evimed_memory.native_rejections r WHERE user_id=$1 AND memory_type=ANY($2::text[])
      AND (fingerprint=ANY($3::text[]) OR (r.text IS NOT NULL AND r.text<>'' AND EXISTS
        (SELECT 1 FROM unnest($4::text[]) candidate WHERE position(regexp_replace(lower(normalize(r.text,NFKC)), '[[:space:][:punct:]]', '', 'g') in candidate)>0))) LIMIT 1`,
    [context.ownerId, types, lines.map(lineFingerprint), texts.map(compact)]);
    return result.rows.length > 0;
  }
  async fence(ownerId, { ownerCreatedAt = null, projectId = '', projectCreatedAt = null, sessionId = '', permanent }) {
    await this.locked(ownerId, async c => {
      const owners = ownerCreatedAt ? [ownerCreatedAt] : (await c.query(`SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1
        UNION SELECT owner_created_at AS stamp FROM evimed_memory.history_chunks WHERE owner_id=$1`, [ownerId])).rows.map(row => row.stamp);
      for (const stamp of owners) {
        const projects = !projectId ? [''] : projectCreatedAt ? [projectCreatedAt] : (await c.query(`
          SELECT created_at::text AS stamp FROM evimed_control.projects WHERE user_id=$1 AND id=$2
          UNION SELECT project_created_at AS stamp FROM evimed_memory.history_chunks WHERE owner_id=$1 AND owner_created_at=$3 AND project_id=$2`,
        [ownerId, projectId, stamp])).rows.map(row => row.stamp);
        for (const projectStamp of projects) {
          await c.query(`INSERT INTO evimed_memory.history_fences(owner_id,owner_created_at,project_id,project_created_at,session_id,permanent)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,owner_created_at,project_id,project_created_at,session_id) DO UPDATE SET
            permanent=history_fences.permanent OR EXCLUDED.permanent,cutoff=clock_timestamp()`, [ownerId, stamp, projectId, projectStamp, sessionId, permanent]);
          await c.query(`UPDATE evimed_memory.history_archives SET state='withdrawn',reason='lifecycle_fence',lease_until=NULL,updated_at=clock_timestamp()
            WHERE owner_id=$1 AND owner_created_at=$2 AND ($3='' OR project_id=$3)
              AND ($4='' OR engine_session='dsh-' || $4) AND ($5='' OR project_created_at IS NULL OR project_created_at=$5)`,
          [ownerId,stamp,projectId,sessionId,projectStamp]);
          await c.query(`UPDATE evimed_memory.history_chunks SET state='withdrawn',cleaned_at=NULL,lease_until=NULL,updated_at=clock_timestamp()
            WHERE owner_id=$1 AND owner_created_at=$2 AND ($3='' OR project_id=$3) AND ($4='' OR session_id=$4)
              AND ($5='' OR project_created_at=$5)`, [ownerId, stamp, projectId, sessionId, projectStamp]);
        }
      }
    });
  }
  async markCleanup(uri) {
    await this.database.query("UPDATE evimed_memory.history_chunks SET state='withdrawn',cleaned_at=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE uri=$1", [uri]);
  }
  // Retain the tombstone even after success: an already accepted slow engine
  // write can land after deletion, including after its writer crashed. The
  // fair hourly sweep checks these exact addresses again, never a new root.
  async cleaned(uri) { await this.database.query('UPDATE evimed_memory.history_chunks SET cleaned_at=clock_timestamp(),lease_until=NULL WHERE uri=$1', [uri]); }
  async pendingDeletes() {
    await this.migrate();
    const result = await this.database.query(`UPDATE evimed_memory.history_chunks SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
      WHERE uri IN (SELECT uri FROM evimed_memory.history_chunks WHERE state='withdrawn' AND (cleaned_at IS NULL OR cleaned_at<clock_timestamp()-interval '1 hour')
        AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY updated_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING *`);
    return result.rows;
  }
  async discoverArchives(limit = 100) {
    await this.migrate();
    const result = await this.database.query(`INSERT INTO evimed_memory.history_archives
      (owner_id,owner_created_at,archive_uri,engine_session,project_id,commit_created_at)
      SELECT c.user_id,u.created_at::text,c.archive_uri,c.engine_session,c.project_id,c.created_at
      FROM evimed_memory.native_commits c JOIN evimed_control.users u ON u.id=c.user_id
      LEFT JOIN evimed_memory.history_archives h ON h.owner_id=c.user_id AND h.owner_created_at=u.created_at::text AND h.archive_uri=c.archive_uri
      WHERE c.state='completed' AND h.archive_uri IS NULL
      ORDER BY c.created_at,c.user_id,c.archive_uri LIMIT $1 ON CONFLICT DO NOTHING RETURNING archive_uri`, [Math.max(1, Math.min(100, limit))]);
    return result.rows.length;
  }
  async claimArchives(limit = 4) {
    await this.migrate();
    const result = await this.database.query(`UPDATE evimed_memory.history_archives h SET state='indexing',attempts=h.attempts+1,
      lease_until=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()
      WHERE (owner_id,owner_created_at,archive_uri) IN (
        SELECT a.owner_id,a.owner_created_at,a.archive_uri FROM evimed_memory.history_archives a
        JOIN evimed_control.users u ON u.id=a.owner_id AND u.created_at::text=a.owner_created_at
        WHERE a.state IN ('queued','indexing','unavailable','partial') AND a.next_attempt_at<=clock_timestamp()
        AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp())
        ORDER BY a.next_attempt_at,a.updated_at,a.owner_id,a.archive_uri LIMIT $1 FOR UPDATE OF a SKIP LOCKED) RETURNING h.*`, [Math.max(1, Math.min(4, limit))]);
    return result.rows;
  }
  async startArchive(commit, context) {
    await this.migrate();
    const result = await this.database.query(`INSERT INTO evimed_memory.history_archives
      (owner_id,owner_created_at,archive_uri,engine_session,namespace_id,project_id,commit_created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz) ON CONFLICT(owner_id,owner_created_at,archive_uri)
      DO UPDATE SET namespace_id=EXCLUDED.namespace_id,project_id=COALESCE(history_archives.project_id,EXCLUDED.project_id)
      RETURNING *`, [context.ownerId,context.ownerCreatedAt,commit.archiveUri,commit.engineSession,context.namespaceId,commit.projectId,commit.createdAt ?? null]);
    return result.rows[0];
  }
  async bindArchive(commit, context, source, sourceHash, bytes) {
    return this.locked(context.ownerId, async c => {
      const result = await c.query(`UPDATE evimed_memory.history_archives SET source_hash=COALESCE(source_hash,$4),project_created_at=$5,archive_bytes=$6
        WHERE owner_id=$1 AND owner_created_at=$2 AND archive_uri=$3 AND (source_hash IS NULL OR source_hash=$4) AND state<>'withdrawn' RETURNING archive_uri`,
      [context.ownerId,context.ownerCreatedAt,commit.archiveUri,sourceHash,source.projectCreatedAt,bytes]);
      if (result.rows.length) return true;
      await c.query(`UPDATE evimed_memory.history_chunks SET state='withdrawn',cleaned_at=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE owner_id=$1 AND owner_created_at=$2 AND archive_uri=$3`, [context.ownerId,context.ownerCreatedAt,commit.archiveUri]);
      return false;
    });
  }
  async finishArchive(commit, context, state, { reason = '', messages = 0, chunks = 0 } = {}) {
    await this.migrate();
    await this.database.query(`UPDATE evimed_memory.history_archives SET state=$4,reason=$5,message_count=$6,indexed_chunks=$7,
      lease_until=NULL,next_attempt_at=clock_timestamp()+CASE WHEN $4='partial' THEN interval '1 day' ELSE interval '1 minute' END,
      updated_at=clock_timestamp() WHERE owner_id=$1 AND owner_created_at=$2 AND archive_uri=$3 AND state<>'withdrawn'`,
    [context.ownerId,context.ownerCreatedAt,commit.archiveUri,state,String(reason).slice(0,100),messages,chunks]);
  }
  async alreadyIndexed(meta, digest) {
    const row = await this.lookup(meta.ownerId,meta.ownerCreatedAt,meta.namespaceId,meta.projectId,meta.projectCreatedAt,meta.uri);
    return row?.digest === digest;
  }
  async archiveCoverage(ownerId = null) {
    await this.migrate();
    const result = await this.database.query(`SELECT h.state,count(*)::integer AS n FROM evimed_memory.history_archives h
      JOIN evimed_control.users u ON u.id=h.owner_id AND u.created_at::text=h.owner_created_at
      WHERE ($1::text IS NULL OR h.owner_id=$1) GROUP BY h.state`, [ownerId]);
    const counts = { queued: 0, indexing: 0, complete: 0, excluded: 0, partial: 0, unavailable: 0, withdrawn: 0 };
    for (const row of result.rows) counts[row.state] = Number(row.n);
    return counts;
  }
  async removeResource(row) {
    await this.client.remove(row.owner_id, row.uri, { openVikingUser: row.namespace_id });
  }
}
