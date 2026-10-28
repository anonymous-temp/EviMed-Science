import { createHash } from 'node:crypto';
import path from 'node:path';
import { SOURCE_FOLDERS } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { researchTableCsv } from './researchDbSnapshot.mjs';
import { RESEARCH_DB_LIMIT_DEFAULTS } from './researchDbConfig.mjs';
import { researchDbImportFacts, researchDbImportTitle, researchDbLogicalPath, researchDbSidecar, researchDbSidecarPath, researchDbSourceFacts } from './researchDbImport.mjs';

/**
 * Publishing a snapshot: the CSV as a source of the project, the sidecar that says how much of the table it holds, and the
 * association with the study's question -- one transaction's worth of work, recoverable from a crash by the staging marker.
 *
 * The CSV keeps one identity per connection + schema + table (`researchDbLogicalPath`): a second import of the same table is
 * a new VERSION of the same source (the registry retires the old version and tells what rests on it), and it takes the
 * place of the old version in the question's material instead of joining it.
 *
 * @param {{
 *   sourceService: any, database: any, credentials: any, staging: any, agenda: any, store: any,
 *   write: (ctx: {user: any, project: any}, file: {root: string, rel: string, buffer: Buffer, meta?: Record<string, any>, register?: boolean, createAlias?: boolean}) => Promise<any>,
 *   limits?: import('./researchDbConfig.mjs').ResearchDbLimits, now?: () => Date,
 * }} dependencies
 */
export function createResearchDbPublisher({ sourceService, database, credentials, staging, agenda, store, write, limits = RESEARCH_DB_LIMIT_DEFAULTS, now = () => new Date() }) {
  /** @param {{user: any, project: any, connectionId: string, target: {host:string,port:number,database:string}, agendaId: string, requestId: string, fingerprint: string, snapshot: any}} request */
  return async function publish({ user, project, connectionId, target, agendaId, requestId, fingerprint, snapshot }) {
    const capturedAt = now().toISOString();
    const logicalPath = researchDbLogicalPath(target, snapshot.schema, snapshot.table);
    const bytes = researchTableCsv(snapshot);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const stagePath = `${SOURCE_FOLDERS.databases}/.evimed-revisions/${sha256}/${path.posix.basename(logicalPath)}`;
    const sidecarPath = researchDbSidecarPath(stagePath);
    const facts = researchDbImportFacts({ snapshot, connection: target, capturedAt, limits });
    const sourceFacts = researchDbSourceFacts(facts, { sidecar: sidecarPath });
    const stageId = await staging.reserve(user.id, project.id, stagePath);
    return sourceService.withRegistrationLocks([`publication:${user.id}:${project.id}:${logicalPath}`], async () => {
      const current = await store.requireProject(user, project.id);
      const locked = await database.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2 FOR SHARE', [user.id, current.id]);
      if (!locked.rows.length || current.userId !== user.id) throw new HttpError(404, 'project_not_found', 'Project not found.');
      await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`research-db-snapshot:${JSON.stringify([user.id, current.id, requestId])}`]);
      const previous = await credentials.snapshotResult(user.id, current.id, requestId, fingerprint, database);
      await staging.lock(user.id, current.id, stageId, stagePath);
      if (previous) { await staging.complete(user.id, current.id, stageId); return previous; }
      await credentials.open(user.id, current.id, connectionId, database, true);
      const question = await agenda.get(user.id, agendaId);
      if (question.projectId !== current.id) throw new HttpError(404, 'autopilot_material_not_found', 'The research question was not found.');
      agenda.assertNotArchived(question);
      const ctx = { user, project: current };
      // The sidecar first, so a CSV is never visible without the note that says what it is. Neither is a source until the
      // CSV registers; a failure before that leaves both under the marker, and recovery removes both.
      await write(ctx, { root: 'base', rel: sidecarPath, buffer: researchDbSidecar(facts), register: false, createAlias: false });
      // A failed COMMIT can mean the server committed but its acknowledgment
      // was lost. Never remove bytes from that ambiguous outcome here: the
      // durable staging sweep checks the source ledger before deletion.
      const saved = await write(ctx, { root: 'base', rel: logicalPath, buffer: bytes, meta: { title: researchDbImportTitle(facts), snapshot: sourceFacts }, createAlias: false });
      if (!saved?.source?.id) throw new HttpError(503, 'research_db_unavailable', 'The database snapshot could not be published.');
      await agenda.addMaterials(user.id, question.id, { sourceIds: [saved.source.id] }, { replacingLogicalPath: logicalPath });
      const result = {
        sourceId: saved.source.id, capturedAt, title: researchDbImportTitle(facts), rowCount: snapshot.rows.length, columns: snapshot.columns.length,
        truncated: snapshot.truncated, oversizedValuesWithheld: snapshot.oversizedValuesWithheld,
        totalRows: facts.rows.total, totalRowsExact: facts.rows.totalExact, stoppedBy: facts.rows.stoppedBy,
        withheldCells: facts.withheldCells.count, droppedColumnCount: facts.droppedColumnCount, droppedColumns: sourceFacts.droppedColumns,
        partial: facts.partial, sidecar: sidecarPath, version: Number(saved.source?.payload?.version) || 1,
      };
      await credentials.recordSnapshot(user.id, current.id, requestId, fingerprint, result);
      await staging.complete(user.id, current.id, stageId);
      return result;
    });
  };
}
