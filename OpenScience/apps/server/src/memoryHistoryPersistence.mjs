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
  async removeResource(row) {
    await this.client.remove(row.owner_id, row.uri, { openVikingUser: row.namespace_id });
  }
}
