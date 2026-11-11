import { randomBytes } from 'node:crypto';
import { secretHash } from './memoryHistorySecrets.mjs';
import { migrateMemorySettings } from './memorySettingsPersistence.mjs';
import { migrateNativeMemory } from './nativeMemoryPersistence.mjs';
import { lineFingerprint, normalisedStatement, nativeMemoryRejectionType } from './nativeMemoryOverlay.mjs';
import { OPENVIKING_KNOWN_MEMORY_TYPES, OPENVIKING_PROJECT_MEMORY_TYPES } from './openVikingLayout.mjs';
import { compact } from './nativeMemoryRejections.mjs';

const migrations = new WeakMap();
const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_memory;
-- A session URI with an empty-text hash owes resolution to original messages
-- when that conversation archives. It never acts as a wildcard during recall.
CREATE TABLE IF NOT EXISTS evimed_memory.history_message_rejections (
  owner_id text NOT NULL, owner_created_at text NOT NULL, namespace_id text NOT NULL,
  memory_type text NOT NULL, fingerprint text NOT NULL, archive_uri text NOT NULL, message_hash text NOT NULL,
  PRIMARY KEY(owner_id,owner_created_at,namespace_id,memory_type,fingerprint,archive_uri,message_hash)
);
CREATE TABLE IF NOT EXISTS evimed_memory.history_write_messages (
  owner_id text NOT NULL, owner_created_at text NOT NULL, namespace_id text NOT NULL,
  archive_uri text NOT NULL, message_hash text NOT NULL,
  PRIMARY KEY(owner_id,owner_created_at,namespace_id,archive_uri,message_hash)
);
CREATE TABLE IF NOT EXISTS evimed_memory.history_write_session_deletes (
  owner_id text NOT NULL, namespace_id text NOT NULL, uri text PRIMARY KEY,
  cleaned_at timestamptz
);

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
-- Version zero rows may have spent their attempts on the missing project stamp.
-- Give those generic lookup failures one fresh, bounded window after the fix.
ALTER TABLE evimed_memory.history_archives ADD COLUMN IF NOT EXISTS source_lookup_version integer NOT NULL DEFAULT 0;
ALTER TABLE evimed_memory.history_fences ADD COLUMN IF NOT EXISTS project_created_at text NOT NULL DEFAULT '';
-- The key is rebuilt only while it still has the old shape (before project_created_at joined it), never at every start.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
      WHERE c.conrelid='evimed_memory.history_fences'::regclass AND c.contype='p' AND a.attname='project_created_at') THEN
    ALTER TABLE evimed_memory.history_fences DROP CONSTRAINT IF EXISTS history_fences_pkey;
    ALTER TABLE evimed_memory.history_fences ADD PRIMARY KEY(owner_id,owner_created_at,project_id,project_created_at,session_id);
  END IF;
END $$;
-- A withdrawn chunk's address is re-checked a few times after its removal (a slow engine write can still land), not hourly forever.
ALTER TABLE evimed_memory.history_chunks ADD COLUMN IF NOT EXISTS sweeps integer NOT NULL DEFAULT 0;
ALTER TABLE evimed_memory.history_archives ADD COLUMN IF NOT EXISTS secret_review_version integer NOT NULL DEFAULT 0;
ALTER TABLE evimed_memory.history_archives ADD COLUMN IF NOT EXISTS secret_review_requested boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS evimed_memory.history_secret_salts (
  owner_id text NOT NULL, owner_created_at text NOT NULL, salt text NOT NULL,
  PRIMARY KEY(owner_id,owner_created_at)
);
CREATE TABLE IF NOT EXISTS evimed_memory.history_secrets (
  owner_id text NOT NULL, owner_created_at text NOT NULL, archive_uri text NOT NULL,
  fingerprint text NOT NULL, length integer NOT NULL CHECK(length>0), count integer NOT NULL DEFAULT 1,
  PRIMARY KEY(owner_id,owner_created_at,archive_uri,fingerprint)
);
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
      AND namespace_id=$4 AND ($5::text IS NULL OR project_id=$5) AND ($6::text IS NULL OR project_created_at=$6) AND state='ready'
      AND EXISTS (SELECT 1 FROM evimed_control.users u WHERE u.id=h.owner_id AND u.created_at::text=h.owner_created_at)
      AND NOT EXISTS (SELECT 1 FROM evimed_memory.history_fences f WHERE f.owner_id=h.owner_id AND f.owner_created_at=h.owner_created_at
        AND (f.project_id='' OR f.project_id=h.project_id) AND (f.project_created_at='' OR f.project_created_at=h.project_created_at) AND (f.session_id='' OR f.session_id=h.session_id)
        AND (f.permanent OR h.minimum_date IS NULL OR f.cutoff>h.minimum_date))`,
    [uri, ownerId, ownerCreatedAt, namespaceId, projectId, projectCreatedAt]);
    return result.rows[0] ?? null;
  }
  /** Exact shared JS normalization on both sides, including legacy rejection
   * rows. Keyset pages cover the complete namespace; overflow is unavailable,
   * never a truncated privacy list. No PostgreSQL character-class substitute.
   */
  async rejected(context, texts, archiveUri = null, messages = []) {
    await this.migrate();
    const types = (context.kind === 'geo-project' ? OPENVIKING_PROJECT_MEMORY_TYPES : OPENVIKING_KNOWN_MEMORY_TYPES)
      .map(type => nativeMemoryRejectionType(type, context.kind === 'geo-project' ? context.namespaceId : null));
    // A one-shot remember/page archive can duplicate a conversation capture.
    // Only exact complete-message hashes bridge those copies; a shared number never does.
    const freshlyStated = (text, at) => messages.some(message => message.role === 'user'
      && lineFingerprint(message.text) === lineFingerprint(text)
      && Date.parse(message.created_at ?? '') > Date.parse(at instanceof Date ? at.toISOString() : at));
    if (archiveUri) for (const row of (await this.database.query(`SELECT h.archive_uri,h.message_hash,r.rejected_at FROM evimed_memory.history_message_rejections h
      JOIN evimed_memory.native_rejections r ON r.user_id=h.owner_id AND r.memory_type=h.memory_type AND r.fingerprint=h.fingerprint
      WHERE h.owner_id=$1 AND h.owner_created_at=$2 AND h.namespace_id=$3 AND (h.archive_uri=$4 OR h.archive_uri ~ '/sessions/(mcp-store-|evimed-page-)')
      AND h.message_hash=ANY($5::text[])`,
      [context.ownerId,context.ownerCreatedAt,context.namespaceId,archiveUri,texts.map(lineFingerprint)])).rows) {
      // Exact old-archive fences never move. A synthetic copy's hash cannot fence a new human
      // statement forever: use the verified original message's date, never commit/scan time.
      if (row.archive_uri === archiveUri || texts.some(text => lineFingerprint(text) === row.message_hash
        && !freshlyStated(text, row.rejected_at))) return true;
    }
    const prints = new Set(texts.flatMap(text => text.split('\n')).map(normalisedStatement).filter(Boolean).map(lineFingerprint));
    const candidates = texts.map(compact);
    let type = '', fingerprint = '', count = 0;
    for (;;) {
      const result = await this.database.query(`SELECT memory_type,fingerprint,text,rejected_at FROM evimed_memory.native_rejections
        WHERE user_id=$1 AND memory_type=ANY($2::text[]) AND (memory_type,fingerprint)>($3,$4)
        ORDER BY memory_type,fingerprint LIMIT 500`, [context.ownerId,types,type,fingerprint]);
      for (const row of result.rows) {
        if (++count > 10000) throw new Error('memory_history_privacy_unavailable');
        const removed = typeof row.text === 'string' ? compact(row.text) : '';
        if ((prints.has(row.fingerprint) || removed && candidates.some(candidate => candidate.includes(removed)))
          && texts.some(text => !freshlyStated(text,row.rejected_at)
            && (text.split('\n').some(line => lineFingerprint(normalisedStatement(line)) === row.fingerprint)
              || removed && compact(text).includes(removed)))) return true;
      }
      if (result.rows.length < 500) return false;
      const last = result.rows.at(-1); type = last.memory_type; fingerprint = last.fingerprint;
    }
  }
  async rejectMessages(context, memoryType, fingerprint, messages) {
    await this.migrate();
    for (const message of messages) await this.database.query(`INSERT INTO evimed_memory.history_message_rejections
      (owner_id,owner_created_at,namespace_id,memory_type,fingerprint,archive_uri,message_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [context.ownerId,context.ownerCreatedAt,context.namespaceId,memoryType,fingerprint,message.archiveUri,message.messageHash??lineFingerprint(message.text)]);
  }
  async boundRejections(context, sessionUri) {
    await this.migrate();
    return (await this.database.query(`SELECT DISTINCT r.memory_type,r.fingerprint,r.text FROM evimed_memory.history_message_rejections h
      JOIN evimed_memory.native_rejections r ON r.user_id=h.owner_id AND r.memory_type=h.memory_type AND r.fingerprint=h.fingerprint
      WHERE h.owner_id=$1 AND h.owner_created_at=$2 AND h.namespace_id=$3 AND h.archive_uri=$4 AND r.text IS NOT NULL`,
      [context.ownerId,context.ownerCreatedAt,context.namespaceId,sessionUri])).rows;
  }
  async registerWriteMessages(context, archiveUri, texts) {
    await this.migrate();
    await this.overlay.linkSourceCopies(context.ownerId,archiveUri);
    await this.database.query(`INSERT INTO evimed_memory.history_write_messages(owner_id,owner_created_at,namespace_id,archive_uri,message_hash)
      SELECT $1,$2,$3,$4,unnest($5::text[]) ON CONFLICT DO NOTHING`,
      [context.ownerId,context.ownerCreatedAt,context.namespaceId,archiveUri,texts.length ? texts.map(lineFingerprint) : ['']]);
    await this.database.query(`INSERT INTO evimed_memory.native_source_copies(user_id,source_archive_uri,copy_archive_uri)
      SELECT DISTINCT a.owner_id,a.archive_uri,b.archive_uri FROM evimed_memory.history_write_messages a
      JOIN evimed_memory.history_write_messages b ON b.owner_id=a.owner_id AND b.owner_created_at=a.owner_created_at
        AND b.namespace_id=a.namespace_id AND b.message_hash=a.message_hash
      JOIN evimed_memory.native_commits s ON s.user_id=a.owner_id AND s.archive_uri=a.archive_uri
      JOIN evimed_memory.native_commits c ON c.user_id=b.owner_id AND c.archive_uri=b.archive_uri
      WHERE a.owner_id=$1 AND a.owner_created_at=$2 AND a.namespace_id=$3 AND (a.archive_uri=$4 OR b.archive_uri=$4)
        AND a.message_hash<>'' AND s.state<>'abandoned' AND c.state<>'abandoned' AND s.engine_session LIKE 'dsh-%' AND c.engine_session ~ '^(mcp-store-|evimed-page-)'
        AND c.project_id=s.project_id AND c.project_created_at::timestamptz=s.project_created_at::timestamptz
      ON CONFLICT DO NOTHING`,[context.ownerId,context.ownerCreatedAt,context.namespaceId,archiveUri]);
  }
  async writeCopies(context, fingerprints) {
    await this.migrate();
    return (await this.database.query(`SELECT DISTINCT w.archive_uri FROM evimed_memory.history_write_messages w
      JOIN evimed_memory.history_message_rejections h ON h.owner_id=w.owner_id AND h.owner_created_at=w.owner_created_at
        AND h.namespace_id=w.namespace_id AND h.message_hash=w.message_hash
      WHERE h.owner_id=$1 AND h.owner_created_at=$2 AND h.namespace_id=$3 AND h.fingerprint=ANY($4::text[])`,
      [context.ownerId,context.ownerCreatedAt,context.namespaceId,fingerprints])).rows.map(row=>row.archive_uri);
  }
  /** Durable exact-address removal for one-shot sessions and edited-away memory paths. */
  async queueWriteSession(context, uri) {
    await this.migrate();
    await this.database.query(`INSERT INTO evimed_memory.history_write_session_deletes(owner_id,namespace_id,uri) VALUES($1,$2,$3)
      ON CONFLICT(uri) DO UPDATE SET cleaned_at=NULL`, [context.ownerId,context.namespaceId,uri]);
  }
  /** Only salted fingerprints and lengths leave transient model response memory. */
  async recordSecrets(commit, context, secrets) {
    await this.locked(context.ownerId, async c => {
      await c.query(`INSERT INTO evimed_memory.history_secret_salts(owner_id,owner_created_at,salt) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING`, [context.ownerId,context.ownerCreatedAt,randomBytes(32).toString('hex')]);
      const salt = (await c.query(`SELECT salt FROM evimed_memory.history_secret_salts WHERE owner_id=$1 AND owner_created_at=$2`,
        [context.ownerId,context.ownerCreatedAt])).rows[0].salt;
      for (const secret of secrets) await c.query(`INSERT INTO evimed_memory.history_secrets(owner_id,owner_created_at,archive_uri,fingerprint,length)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [context.ownerId,context.ownerCreatedAt,commit.archiveUri,secretHash(salt,secret),secret.length]);
      await c.query(`UPDATE evimed_memory.history_archives SET secret_review_version=1,secret_review_requested=true
        WHERE owner_id=$1 AND owner_created_at=$2 AND archive_uri=$3 AND state<>'withdrawn'`, [context.ownerId,context.ownerCreatedAt,commit.archiveUri]);
    });
  }
  async secretRecords(ownerId) {
    await this.migrate();
    // One snapshot binds salt and hashes to the same live account incarnation.
    const rows = (await this.database.query(`SELECT DISTINCT a.salt,s.fingerprint,s.length FROM evimed_control.users u
      LEFT JOIN evimed_memory.history_secret_salts a ON a.owner_id=u.id AND a.owner_created_at=u.created_at::text
      LEFT JOIN evimed_memory.history_secrets s ON s.owner_id=u.id AND s.owner_created_at=u.created_at::text
      WHERE u.id=$1 LIMIT 10001`, [ownerId])).rows;
    const salt = rows[0]?.salt ?? '';
    const records = rows.filter(row=>row.fingerprint).map(row=>({fingerprint:row.fingerprint,length:row.length}));
    if (!rows.length || records.length>10000 || records.length && !salt) throw new Error('memory_history_secret_review_unavailable');
    return { salt, records };
  }
  async secretReviewed(context, archiveUri) {
    await this.migrate();
    return Boolean((await this.database.query(`SELECT 1 FROM evimed_memory.history_archives WHERE owner_id=$1 AND owner_created_at=$2
      AND archive_uri=$3 AND secret_review_version=1 AND state NOT IN ('withdrawn','excluded')`, [context.ownerId,context.ownerCreatedAt,archiveUri])).rows.length);
  }
  /** Retire legacy addresses before review. New redacted resources use a new
   * digest, so a slow old write can never become searchable again. */
  async retireSecretChunks(commit, context) {
    await this.locked(context.ownerId, async c => {
      await c.query(`UPDATE evimed_memory.history_archives SET secret_review_requested=true WHERE owner_id=$1 AND owner_created_at=$2 AND archive_uri=$3`, [context.ownerId,context.ownerCreatedAt,commit.archiveUri]);
      await c.query(`UPDATE evimed_memory.history_chunks SET state='withdrawn',cleaned_at=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE owner_id=$1 AND owner_created_at=$2 AND archive_uri=$3 AND state<>'withdrawn'
        AND EXISTS(SELECT 1 FROM evimed_memory.history_archives a WHERE a.owner_id=$1 AND a.owner_created_at=$2 AND a.archive_uri=$3 AND a.secret_review_version=0)`, [context.ownerId,context.ownerCreatedAt,commit.archiveUri]);
    });
  }
  async queueSecretReviews(limit = 4) {
    await this.migrate();
    return this.database.query(`UPDATE evimed_memory.history_archives SET state='queued',secret_review_requested=true,attempts=0,
      next_attempt_at=clock_timestamp(),lease_until=NULL WHERE (owner_id,owner_created_at,archive_uri) IN
      (SELECT a.owner_id,a.owner_created_at,a.archive_uri FROM evimed_memory.history_archives a JOIN evimed_control.users u
        ON u.id=a.owner_id AND u.created_at::text=a.owner_created_at
        WHERE a.secret_review_version=0 AND NOT a.secret_review_requested AND a.state IN ('complete','partial','unavailable')
        AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp()) ORDER BY a.commit_created_at NULLS LAST LIMIT $1 FOR UPDATE OF a SKIP LOCKED)`, [limit]);
  }
  async archiveSourceHash(context, archiveUri) {
    await this.migrate();
    const result = await this.database.query(`SELECT source_hash FROM evimed_memory.history_archives
      WHERE owner_id=$1 AND owner_created_at=$2 AND archive_uri=$3 AND namespace_id=$4 AND state NOT IN ('withdrawn','excluded')`,
    [context.ownerId,context.ownerCreatedAt,archiveUri,context.namespaceId]);
    return result.rows[0]?.source_hash ?? null;
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
              AND ($5='' OR project_created_at=$5) AND state<>'withdrawn'`, [ownerId, stamp, projectId, sessionId, projectStamp]);
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
  async pendingDeletes(ownerId = null) {
    await this.migrate();
    const result = await this.database.query(`UPDATE evimed_memory.history_chunks SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp(),
        sweeps=CASE WHEN cleaned_at IS NULL THEN 0 ELSE sweeps+1 END
      WHERE uri IN (SELECT uri FROM evimed_memory.history_chunks WHERE state='withdrawn' AND ($1::text IS NULL OR owner_id=$1) AND (cleaned_at IS NULL OR (cleaned_at<clock_timestamp()-interval '1 hour' AND sweeps<3))
        AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY updated_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING *`, [ownerId]);
    return result.rows;
  }
  async discoverArchives(limit = 100) {
    await this.migrate();
    const result = await this.database.query(`INSERT INTO evimed_memory.history_archives
      (owner_id,owner_created_at,archive_uri,engine_session,project_id,commit_created_at,source_lookup_version)
      SELECT c.user_id,u.created_at::text,c.archive_uri,c.engine_session,c.project_id,c.created_at,1
      FROM evimed_memory.native_commits c JOIN evimed_control.users u ON u.id=c.user_id
      LEFT JOIN evimed_memory.history_archives h ON h.owner_id=c.user_id AND h.owner_created_at=u.created_at::text AND h.archive_uri=c.archive_uri
      WHERE c.state='completed' AND h.archive_uri IS NULL
      ORDER BY c.created_at,c.user_id,c.archive_uri LIMIT $1 ON CONFLICT DO NOTHING RETURNING archive_uri`, [Math.max(1, Math.min(100, limit))]);
    return result.rows.length;
  }
  async claimArchives(limit = 4, secretReview = false) {
    await this.migrate();
    const result = await this.database.query(`WITH claimed AS (UPDATE evimed_memory.history_archives h SET state='indexing',
      attempts=CASE WHEN h.source_lookup_version=0 AND h.state='unavailable' AND h.reason='memory_history_index_unavailable' THEN 1 ELSE h.attempts+1 END,
      source_lookup_version=1,
      lease_until=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()
      WHERE (owner_id,owner_created_at,archive_uri) IN (
        SELECT a.owner_id,a.owner_created_at,a.archive_uri FROM evimed_memory.history_archives a
        JOIN evimed_control.users u ON u.id=a.owner_id AND u.created_at::text=a.owner_created_at
        WHERE a.state IN ('queued','indexing','unavailable','partial')
        AND ((a.next_attempt_at<=clock_timestamp() AND (a.state<>'unavailable' OR a.attempts<8 OR ($2 AND a.reason='memory_history_secret_review_unavailable')))
          OR (a.source_lookup_version=0 AND a.state='unavailable' AND a.reason='memory_history_index_unavailable'))
        AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp())
        ORDER BY a.commit_created_at NULLS LAST,a.updated_at,a.owner_id,a.archive_uri LIMIT $1 FOR UPDATE OF a SKIP LOCKED) RETURNING h.*)
      SELECT * FROM claimed ORDER BY commit_created_at NULLS LAST,owner_id,archive_uri`, [Math.max(1, Math.min(4, limit)),secretReview]);
    return result.rows;
  }
  async startArchive(commit, context) {
    await this.migrate();
    const result = await this.database.query(`INSERT INTO evimed_memory.history_archives
      (owner_id,owner_created_at,archive_uri,engine_session,namespace_id,project_id,commit_created_at,source_lookup_version)
      VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,1) ON CONFLICT(owner_id,owner_created_at,archive_uri)
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
      lease_until=NULL,next_attempt_at=clock_timestamp()+CASE WHEN $4='partial' THEN interval '1 day'
        WHEN $4='unavailable' AND attempts>=8 THEN interval '7 days'
        WHEN $4='unavailable' THEN LEAST(interval '1 day',interval '1 minute'*power(2,LEAST(attempts,10)))
        ELSE interval '1 minute' END,
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
    const pending = await this.database.query(`SELECT count(*)::integer AS n FROM evimed_memory.native_commits c
      JOIN evimed_control.users u ON u.id=c.user_id
      WHERE c.state='completed' AND ($1::text IS NULL OR c.user_id=$1) AND NOT EXISTS
        (SELECT 1 FROM evimed_memory.history_archives h WHERE h.owner_id=c.user_id AND h.owner_created_at=u.created_at::text AND h.archive_uri=c.archive_uri)`, [ownerId]);
    return { ...counts, undiscovered: Number(pending.rows[0]?.n ?? 0) };
  }
  async removeResource(row) {
    if (/\/sessions\/(?:evimed-page-|mcp-store-)[^/]+$/.test(row.uri)) {
      const session = row.uri.slice(row.uri.lastIndexOf('/')+1);
      try { await this.client.request({method:'DELETE',path:`/api/v1/sessions/${session}`,userId:row.owner_id,openVikingUser:row.namespace_id}); }
      catch (error) { if (error?.code !== 'memory_index_not_found') throw error; }
      await this.client.remove(row.owner_id,row.uri,{recursive:true,openVikingUser:row.namespace_id});
    } else await this.client.remove(row.owner_id, row.uri, { openVikingUser: row.namespace_id });
  }
}
