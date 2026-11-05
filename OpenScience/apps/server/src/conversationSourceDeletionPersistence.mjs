import { HttpError, safeId } from './security.mjs';

const migrations = new WeakMap();
const sql = `CREATE SCHEMA IF NOT EXISTS evimed_source_deletion;
CREATE TABLE IF NOT EXISTS evimed_source_deletion.conversations (
 id uuid PRIMARY KEY, user_id text NOT NULL, account_created_at timestamptz NOT NULL,
 project_id text NOT NULL, project_created_at timestamptz NOT NULL, root_session_id text NOT NULL,
 session_ids jsonb NOT NULL, frozen jsonb NOT NULL, memory_user_root text, cleanup text NOT NULL DEFAULT 'pending' CHECK(cleanup IN ('pending','complete')),
 source_removed boolean NOT NULL DEFAULT false, reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,account_created_at,project_id,project_created_at,root_session_id)
);
ALTER TABLE evimed_source_deletion.conversations ADD COLUMN IF NOT EXISTS memory_user_root text;`;
const stamp = value => typeof value === 'string' ? value : new Date(value).toISOString();
const identityColumns = "*, account_created_at::text AS account_created_at, project_created_at::text AS project_created_at";
const rowOf = r => r ? { id: r.id, userId: r.user_id, accountCreatedAt: stamp(r.account_created_at), projectId: r.project_id,
  projectCreatedAt: stamp(r.project_created_at), rootSessionId: r.root_session_id, sessionIds: r.session_ids,
  frozen: r.frozen, memoryUserRoot: r.memory_user_root, cleanup: r.cleanup, sourceRemoved: r.source_removed, reason: r.reason } : null;

/** No foreign keys: deleting an owner or project cannot discard a physical cleanup obligation. */
export class ConversationSourceDeletionLedger {
  constructor(database) { this.database = database; }
  async migrate() {
    if (!migrations.has(this.database)) migrations.set(this.database, this.database.transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('source-conversation-delete-v1'))"); await c.query(sql);
    }).catch(error => { migrations.delete(this.database); throw error; }));
    await migrations.get(this.database);
  }
  async scope(project) {
    const result = await this.database.query(`SELECT u.created_at::text AS account,p.created_at::text AS project FROM evimed_control.users u
      JOIN evimed_control.projects p ON p.user_id=u.id WHERE u.id=$1 AND p.id=$2`, [project.userId, project.id]);
    if (!result.rows[0]) throw new HttpError(404, 'project_not_found', 'Project not found.');
    return { accountCreatedAt: stamp(result.rows[0].account), projectCreatedAt: stamp(result.rows[0].project) };
  }
  async get(project, sessionId) {
    await this.migrate(); const scope = await this.scope(project);
    const rows = await this.database.query(`SELECT ${identityColumns} FROM evimed_source_deletion.conversations WHERE user_id=$1 AND account_created_at=$2
      AND project_id=$3 AND project_created_at=$4 AND session_ids ? $5`, [project.userId, scope.accountCreatedAt, project.id, scope.projectCreatedAt, sessionId]);
    return rowOf(rows.rows[0]);
  }
  async deletedIds(project) {
    await this.migrate(); const scope = await this.scope(project);
    const rows = await this.database.query(`SELECT session_ids FROM evimed_source_deletion.conversations WHERE user_id=$1 AND account_created_at=$2
      AND project_id=$3 AND project_created_at=$4`, [project.userId, scope.accountCreatedAt, project.id, scope.projectCreatedAt]);
    return [...new Set(rows.rows.flatMap(r => r.session_ids))];
  }
  /** Whole affected files are temporarily excluded until their deleted lines have been physically removed. */
  async hiddenMemoryUris(userId) {
    await this.migrate();
    const result = await this.database.query(`WITH RECURSIVE deleted AS (
      SELECT d.* FROM evimed_source_deletion.conversations d JOIN evimed_control.users u ON u.id=d.user_id AND u.created_at=d.account_created_at
      WHERE d.user_id=$1 AND d.memory_user_root IS NOT NULL
    ), sources AS (
      SELECT c.archive_uri,c.engine_session,c.replayed_as,d.id AS deletion_id FROM evimed_memory.native_commits c JOIN deleted d
      ON c.user_id=d.user_id AND c.project_id=d.project_id AND left(c.engine_session,4)='dsh-' AND d.session_ids ? substring(c.engine_session from 5)
      AND left(c.archive_uri,length(d.memory_user_root)+10)=d.memory_user_root||'/sessions/'
      UNION SELECT c.archive_uri,c.engine_session,c.replayed_as,d.id FROM evimed_memory.native_commits c JOIN sources s ON c.archive_uri=s.replayed_as
      JOIN deleted d ON d.id=s.deletion_id WHERE c.user_id=d.user_id AND c.project_id=d.project_id
        AND left(c.archive_uri,length(d.memory_user_root)+10)=d.memory_user_root||'/sessions/'
    ) SELECT DISTINCT o.uri FROM evimed_memory.native_line_origins o LEFT JOIN evimed_memory.native_commits original ON original.user_id=o.user_id AND original.archive_uri=o.archive_uri AND original.engine_session=o.engine_session
      JOIN deleted d ON d.user_id=o.user_id AND d.project_id=COALESCE(o.project_id,original.project_id)
      AND left(o.uri,length(d.memory_user_root)+1)=d.memory_user_root||'/'
      WHERE (left(o.engine_session,4)='dsh-' AND d.session_ids ? substring(o.engine_session from 5)) OR EXISTS (
        SELECT 1 FROM sources s WHERE s.deletion_id=d.id AND s.archive_uri=o.archive_uri AND s.engine_session=o.engine_session)`, [userId]);
    return result.rows.map(row => row.uri);
  }
  /** A request-local disclosure guard; never infer stability from a cached list of source exclusions. */
  async version(userId) {
    await this.migrate();
    const result = await this.database.query(`SELECT count(*)::text AS count,max(d.created_at)::text AS latest
      FROM evimed_source_deletion.conversations d JOIN evimed_control.users u ON u.id=d.user_id AND u.created_at=d.account_created_at
      WHERE d.user_id=$1`, [userId]);
    return JSON.stringify(result.rows[0]);
  }
  async put(row) {
    await this.migrate();
    const result = await this.database.query(`INSERT INTO evimed_source_deletion.conversations
      (id,user_id,account_created_at,project_id,project_created_at,root_session_id,session_ids,frozen,memory_user_root)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,account_created_at,project_id,project_created_at,root_session_id)
      DO UPDATE SET updated_at=evimed_source_deletion.conversations.updated_at RETURNING ${identityColumns}`,
    [row.id, row.userId, row.accountCreatedAt, row.projectId, row.projectCreatedAt, row.rootSessionId, JSON.stringify(row.sessionIds), JSON.stringify(row.frozen), row.memoryUserRoot ?? null]);
    return rowOf(result.rows[0]);
  }
  async pending() { await this.migrate(); return (await this.database.query(`SELECT ${identityColumns} FROM evimed_source_deletion.conversations WHERE cleanup='pending' OR updated_at < clock_timestamp()-interval '60 seconds' ORDER BY updated_at LIMIT 30`)).rows.map(rowOf); }
  /** Only the privileged maintenance result may extend the deleted managed-child closure. */
  async extendSessions(row, ids) {
    const sessionIds = [...new Set([...row.sessionIds, ...ids.map(id => safeId(id, 'managed source session'))])];
    if (sessionIds.length > 10000) throw new HttpError(409, 'source_deletion_limit', 'The source closure is too large.');
    await this.database.query('UPDATE evimed_source_deletion.conversations SET session_ids=$2,updated_at=clock_timestamp() WHERE id=$1', [row.id, JSON.stringify(sessionIds)]);
    return sessionIds;
  }
  async update(row, change) {
    const result = await this.database.query(`UPDATE evimed_source_deletion.conversations SET cleanup=$2,source_removed=$3,reason=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${identityColumns}`,
      [row.id, change.cleanup ?? row.cleanup, change.sourceRemoved ?? row.sourceRemoved, change.reason ?? null]); return rowOf(result.rows[0]);
  }
  async assertIdentity(row) {
    const current = await this.scope({ userId: row.userId, id: row.projectId });
    if (current.accountCreatedAt !== row.accountCreatedAt || current.projectCreatedAt !== row.projectCreatedAt) throw new HttpError(409, 'source_deletion_identity_changed', 'The source ownership changed.');
    return true;
  }
  async exclusive(project, operation) {
    return this.database.transaction(async client => {
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`plugin-project:${project.userId}:${project.id}`]);
      if (!lock.rows[0]?.acquired) return;
      return this.database.withTransactionClient(client, operation);
    });
  }
}
