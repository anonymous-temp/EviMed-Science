import pg from 'pg';
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
ALTER TABLE evimed_source_deletion.conversations ADD COLUMN IF NOT EXISTS memory_user_root text;
ALTER TABLE evimed_source_deletion.conversations ADD COLUMN IF NOT EXISTS history_prints jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE evimed_source_deletion.conversations ADD COLUMN IF NOT EXISTS native_roots jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_source_deletion.conversations ADD COLUMN IF NOT EXISTS lineage_roots jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_source_deletion.conversations ADD COLUMN IF NOT EXISTS cleaned_revision_id bigint;`;
const stamp = value => typeof value === 'string' ? value : new Date(value).toISOString();
const identityColumns = "*, account_created_at::text AS account_created_at, project_created_at::text AS project_created_at";
const rowOf = r => r ? { id: r.id, userId: r.user_id, accountCreatedAt: stamp(r.account_created_at), projectId: r.project_id,
  projectCreatedAt: stamp(r.project_created_at), rootSessionId: r.root_session_id, sessionIds: r.session_ids,
  frozen: r.frozen, cleanedRevisionId:r.cleaned_revision_id==null?null:String(r.cleaned_revision_id), memoryUserRoot: r.memory_user_root, historyPrints:r.history_prints??{}, lineageRoots:r.lineage_roots??[], nativeRoots:r.native_roots?.length?r.native_roots:r.memory_user_root?[r.memory_user_root]:[], cleanup: r.cleanup, sourceRemoved: r.source_removed, reason: r.reason } : null;

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
  async recordsForOwner(userId,{pendingOnly=false}={}) {
    await this.migrate();
    const result=await this.database.query(`SELECT d.*,d.account_created_at::text AS account_created_at,d.project_created_at::text AS project_created_at
      FROM evimed_source_deletion.conversations d JOIN evimed_control.users u ON u.id=d.user_id AND u.created_at=d.account_created_at
      WHERE d.user_id=$1 AND ($2=false OR d.cleanup='pending')`,[userId,pendingOnly]);
    return result.rows.map(rowOf);
  }
  async rememberHistory(row,contributions) {
    for(const contribution of contributions) {
      if(contribution.unverifiedRoot)await this.database.query(`UPDATE evimed_source_deletion.conversations SET lineage_roots=to_jsonb(ARRAY(SELECT DISTINCT value FROM (
        SELECT jsonb_array_elements_text(lineage_roots) AS value UNION SELECT $2::text) roots)) WHERE id=$1`,[row.id,contribution.unverifiedRoot]);
      await this.database.query(`UPDATE evimed_source_deletion.conversations SET history_prints=jsonb_set(history_prints,ARRAY[$2],
      to_jsonb(ARRAY(SELECT DISTINCT print FROM (SELECT jsonb_array_elements_text(COALESCE(history_prints->$2,'[]'::jsonb)) AS print UNION SELECT unnest($3::text[])) combined)),true)
      WHERE id=$1`,[row.id,contribution.uri,contribution.prints]);
    }
  }
  async pendingCleanupForProject(project) {
    await this.migrate();const scope=await this.scope(project);
    const result=await this.database.query(`SELECT 1 FROM evimed_source_deletion.conversations WHERE user_id=$1 AND account_created_at=$2
      AND project_id=$3 AND project_created_at=$4 AND cleanup='pending' LIMIT 1`,[project.userId,scope.accountCreatedAt,project.id,scope.projectCreatedAt]);
    return result.rows.length>0;
  }
  async withProjectDisclosure(project,operation) {
    const scope=await this.scope(project);
    return this.database.transaction(async client=>{
      const owner=await client.query('SELECT id FROM evimed_control.users WHERE id=$1 AND created_at=$2::timestamptz FOR SHARE',[project.userId,scope.accountCreatedAt]);
      const present=await client.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2 AND created_at=$3::timestamptz FOR SHARE',[project.userId,project.id,scope.projectCreatedAt]);
      if(!owner.rows.length||!present.rows.length)throw new HttpError(404,'project_not_found','Project not found.');
      return this.database.withTransactionClient(client,operation);
    });
  }
  async pendingForProject(project) {
    await this.migrate(); const scope=await this.scope(project);
    const rows=await this.database.query(`SELECT ${identityColumns} FROM evimed_source_deletion.conversations WHERE user_id=$1 AND account_created_at=$2
      AND project_id=$3 AND project_created_at=$4 AND source_removed=false AND cleanup='pending'`,[project.userId,scope.accountCreatedAt,project.id,scope.projectCreatedAt]);
    return rows.rows.map(rowOf);
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
      SELECT d.*,jsonb_array_elements_text(CASE WHEN jsonb_array_length(d.native_roots)>0 THEN d.native_roots ELSE jsonb_build_array(d.memory_user_root) END) AS native_root FROM evimed_source_deletion.conversations d JOIN evimed_control.users u ON u.id=d.user_id AND u.created_at=d.account_created_at
      WHERE d.user_id=$1 AND d.memory_user_root IS NOT NULL
    ), sources AS (
      SELECT c.archive_uri,c.engine_session,c.replayed_as,c.native_ingested_at,c.ingested_at,c.state,d.id AS deletion_id FROM evimed_memory.native_commits c JOIN deleted d
      ON c.user_id=d.user_id AND c.project_id=d.project_id AND left(c.engine_session,4)='dsh-' AND d.session_ids ? substring(c.engine_session from 5)
      AND left(c.archive_uri,length(d.native_root)+10)=d.native_root||'/sessions/'
      UNION SELECT c.archive_uri,c.engine_session,c.replayed_as,c.native_ingested_at,c.ingested_at,c.state,d.id FROM evimed_memory.native_commits c JOIN sources s ON c.archive_uri=s.replayed_as
      JOIN deleted d ON d.id=s.deletion_id WHERE c.user_id=d.user_id AND c.project_id=d.project_id
        AND left(c.archive_uri,length(d.native_root)+10)=d.native_root||'/sessions/'
    ) SELECT DISTINCT o.uri FROM evimed_memory.native_line_origins o LEFT JOIN evimed_memory.native_commits original ON original.user_id=o.user_id AND original.archive_uri=o.archive_uri AND original.engine_session=o.engine_session
      JOIN deleted d ON d.user_id=o.user_id AND d.project_id=COALESCE(o.project_id,original.project_id)
      AND left(o.uri,length(d.native_root)+1)=d.native_root||'/'
      WHERE (left(o.engine_session,4)='dsh-' AND d.session_ids ? substring(o.engine_session from 5)) OR EXISTS (
        SELECT 1 FROM sources s WHERE s.deletion_id=d.id AND s.archive_uri=o.archive_uri AND s.engine_session=o.engine_session)
      UNION SELECT d.native_root AS uri FROM sources s JOIN deleted d ON s.deletion_id=d.id
      WHERE s.native_ingested_at IS NULL AND s.ingested_at IS NULL AND s.state<>'completed'
      UNION SELECT f.uri FROM deleted d JOIN evimed_memory.native_files f ON f.user_id=d.user_id AND left(f.uri,length(d.native_root)+1)=d.native_root||'/'
      JOIN LATERAL(SELECT r.id,r.actor,r.reason FROM evimed_memory.native_revisions r WHERE r.user_id=f.user_id AND r.uri=f.uri ORDER BY r.id DESC LIMIT 1) latest ON latest.actor='user' AND latest.reason LIKE 'undo%'
      WHERE (d.cleaned_revision_id IS NULL OR latest.id<=d.cleaned_revision_id)
      AND (latest.reason LIKE '%[source-deleted]%' OR d.cleanup='pending')
      AND (d.history_prints ? f.uri OR EXISTS(SELECT 1 FROM evimed_memory.native_revisions r JOIN sources s ON s.archive_uri=r.archive_uri AND s.engine_session=r.engine_session
        WHERE s.deletion_id=d.id AND r.user_id=d.user_id AND r.uri=f.uri))`, [userId]);
    const roots=(await this.recordsForOwner(userId)).flatMap(row=>row.lineageRoots??[]);
    return [...new Set([...result.rows.map(row=>row.uri),...roots])];
  }
  async quarantinedUris(userId) {
    const fences=await this.recordsForOwner(userId),hidden=new Set(await this.hiddenMemoryUris(userId));
    const roots=[...new Set(fences.flatMap(row=>[...(row.lineageRoots??[]),...(row.nativeRoots??[]).filter(root=>hidden.has(root))]))];if(!roots.length)return [];
    const rows=await this.database.query(`SELECT DISTINCT uri FROM (SELECT uri FROM evimed_memory.native_files WHERE user_id=$1 UNION SELECT uri FROM evimed_memory.native_revisions WHERE user_id=$1) files
      WHERE EXISTS(SELECT 1 FROM unnest($2::text[]) root WHERE left(uri,length(root)+1)=root||'/')`,[userId,roots]);
    return rows.rows.map(row=>row.uri);
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
    return this.database.transaction(async client=>{
    // Account exports hold this owner tuple FOR SHARE through response handoff. A version touch also rejects a stale RR snapshot that started while waiting.
    await client.query('UPDATE evimed_control.users SET updated_at=updated_at WHERE id=$1 AND created_at=$2::timestamptz',[row.userId,row.accountCreatedAt]);
    const result = await client.query(`INSERT INTO evimed_source_deletion.conversations
      (id,user_id,account_created_at,project_id,project_created_at,root_session_id,session_ids,frozen,memory_user_root,native_roots)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,account_created_at,project_id,project_created_at,root_session_id)
      DO UPDATE SET updated_at=evimed_source_deletion.conversations.updated_at RETURNING ${identityColumns}`,
    [row.id, row.userId, row.accountCreatedAt, row.projectId, row.projectCreatedAt, row.rootSessionId, JSON.stringify(row.sessionIds), JSON.stringify(row.frozen), row.memoryUserRoot ?? null,JSON.stringify(row.nativeRoots??(row.memoryUserRoot?[row.memoryUserRoot]:[]))]);
    return rowOf(result.rows[0]);
    });
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
    const result = await this.database.query(`UPDATE evimed_source_deletion.conversations SET cleanup=$2,source_removed=$3,reason=$4,cleaned_revision_id=CASE WHEN $2='complete' THEN COALESCE(cleaned_revision_id,(SELECT COALESCE(max(id),0) FROM evimed_memory.native_revisions WHERE user_id=conversations.user_id)) ELSE cleaned_revision_id END,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${identityColumns}`,
      [row.id, change.cleanup ?? row.cleanup, change.sourceRemoved ?? row.sourceRemoved, change.reason ?? null]); return rowOf(result.rows[0]);
  }
  async assertIdentity(row) {
    const current = await this.scope({ userId: row.userId, id: row.projectId });
    if (current.accountCreatedAt !== row.accountCreatedAt || current.projectCreatedAt !== row.projectCreatedAt) throw new HttpError(409, 'source_deletion_identity_changed', 'The source ownership changed.');
    return true;
  }
  async exclusive(project, operation) {
    const outcome=await this.database.transaction(async client => {
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`plugin-project:${project.userId}:${project.id}`]);
      if (!lock.rows[0]?.acquired) return {value:undefined};
      try{return {value:await this.database.withTransactionClient(client,operation)};}
      catch(error){if(error instanceof pg.DatabaseError)throw error;return {error};}
    });
    if(outcome.error)throw outcome.error;return outcome.value;
  }
}
