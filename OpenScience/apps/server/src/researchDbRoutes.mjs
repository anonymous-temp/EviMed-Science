import { HttpError, readJson, sendJson } from './security.mjs';
import { assertClientProject } from './internalProjects.mjs';
import { openResearchDb } from './researchDbTransport.mjs';
import { admittedResearchDbAddresses } from './researchDbNetwork.mjs';
import { researchDbSnapshotFingerprint } from './researchDbCredentials.mjs';
import { listResearchTables, snapshotResearchTable } from './researchDbSnapshot.mjs';
import { createResearchDbCapacity } from './researchDbCapacity.mjs';
import { RESEARCH_DB_LIMIT_DEFAULTS } from './researchDbConfig.mjs';
import { researchDbLogicalPath } from './researchDbImport.mjs';
import { recordResearchDbImport, recordResearchDbRefusal, researchDbRefusalReason } from './researchDbMetrics.mjs';

/** @param {any} value @param {string[]} keys */
function body(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new HttpError(400, 'research_db_payload_invalid', 'The database request is invalid.');
  return value;
}

/** The code a failure is written under in the audit line: a named code, never a driver's message or a SQLSTATE.
 * @param {unknown} error */
const auditCode = error => {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,80}$/.test(code) ? code : 'research_db_unavailable';
};

/**
 * `/api/research-databases/*`.
 *
 * `audit(user, project, action, status, details)` writes the project's audit line (`research_db.connection.save`,
 * `.remove` and `research_db.import`: the connection's or the source's id, never a password, host or user name).
 * Every limit is `limits` (`researchDbConfig.mjs`) and every refusal or limit that bit is counted
 * (`researchDbMetrics.mjs`); neither can fail a request.
 * @param {{store:any,credentials:any,agenda:any,policy:string,caDir?:string,limits?:import('./researchDbConfig.mjs').ResearchDbLimits,maxJsonBytes:number,publish:any,open?:any,
 *   audit?:(user:any,project:any,action:string,status:string,details?:Record<string,any>)=>Promise<unknown>}} dependencies
 */
export function createResearchDbRoutes({ store, credentials, agenda, policy, caDir = '', limits = RESEARCH_DB_LIMIT_DEFAULTS, maxJsonBytes, publish, open = openResearchDb, audit = async () => {} }) {
  /** @type {Promise<any> | null} */ let ready = null;
  const capacity = createResearchDbCapacity({ slots: limits.slots, perUser: limits.perUser });
  const record = (/** @type {any} */ user, /** @type {any} */ project, /** @type {string} */ action, /** @type {string} */ status, /** @type {Record<string, any>} */ details) =>
    Promise.resolve().then(() => audit(user, project, action, status, details)).catch(() => {});
  // The tables, then the proof that every saved credential's key is in the keyring: an incomplete keyring answers
  // research_db_keyring_incomplete on every route until an operator restores the missing version.
  const migrate = () => { ready ??= credentials.migrate().then(() => credentials.assertKeyCoverage()).catch((/** @type {any} */ error) => { ready = null; throw error; }); return ready; };
  /**
   * One operation on the remote database: counted when it is refused, audited when it is an import, and the error given back
   * as it is. `work` is the part that talks to the remote database or publishes what it returned.
   * @template T @param {any} user @param {any} project @param {string | null} action @param {string} target @param {() => Promise<T>} work @returns {Promise<T>} */
  const guarded = async (user, project, action, target, work) => {
    try { return await work(); }
    catch (error) {
      recordResearchDbRefusal(researchDbRefusalReason(/** @type {any} */ (error)?.code));
      if (action) { recordResearchDbImport('refused'); await record(user, project, action, 'failed', { target, error: auditCode(error) }); }
      throw error;
    }
  };
  const handler = async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? '/', 'http://evimed.local');
    if (url.pathname !== '/api/research-databases' && !url.pathname.startsWith('/api/research-databases/')) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    const parts = url.pathname.slice('/api/research-databases'.length).split('/').filter(Boolean);
    const method = req.method ?? 'GET';
    const configured = Boolean(credentials && agenda && publish && policy);
    if (parts.length === 1 && parts[0] === 'status' && method === 'GET') {
      // Answers even when the connector is off, so a page can hide its entry instead of offering a dead one.
      const projectId = url.searchParams.get('projectId'); assertClientProject(projectId);
      await store.requireProject(user, projectId);
      let available = configured;
      if (available) { try { await migrate(); } catch { available = false; } }
      sendJson(res, 200, { data: { available } }); return true;
    }
    if (!configured) throw new HttpError(503, 'research_db_unavailable', 'Database snapshots are unavailable.');
    try {
      await migrate();
      if (parts.length === 0 && method === 'GET') {
        const projectId = url.searchParams.get('projectId'); assertClientProject(projectId);
        await store.requireProject(user, projectId);
        sendJson(res, 200, { data: { items: await credentials.list(user.id, projectId) } }); return true;
      }
      if (parts.length === 0 && method === 'POST') {
        const input = body(await readJson(req, maxJsonBytes), ['projectId', 'host', 'port', 'database', 'username', 'password', 'requestId']);
        assertClientProject(input.projectId); const project = await store.requireProject(user, input.projectId);
        const { projectId, requestId, ...connection } = input;
        admittedResearchDbAddresses(connection.host, connection.port, policy);
        const id = await credentials.save(user.id, projectId, connection, requestId);
        await record(user, project, 'research_db.connection.save', 'completed', { target: id });
        sendJson(res, 201, { data: { id } }); return true;
      }
      if (parts.length === 1 && method === 'DELETE') {
        const input = body(await readJson(req, maxJsonBytes), ['projectId']);
        assertClientProject(input.projectId); const project = await store.requireProject(user, input.projectId);
        const removed = await credentials.remove(user.id, input.projectId, parts[0]);
        await record(user, project, 'research_db.connection.remove', removed ? 'completed' : 'refused', { target: parts[0] });
        sendJson(res, 200, { data: { removed } }); return true;
      }
      if (parts.length === 2 && parts[1] === 'tables' && method === 'GET') {
        const projectId = url.searchParams.get('projectId'); assertClientProject(projectId);
        const project = await store.requireProject(user, projectId);
        const connection = await credentials.open(user.id, project.id, parts[0]);
        const listing = await guarded(user, project, null, parts[0], () => capacity.run(user.id, async () => {
          const transport = await open(connection, policy, { caDir, limits });
          try { return await listResearchTables(transport.client, { limits }); }
          catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'research_db_unavailable', 'The database tables could not be read.'); }
          finally { await transport.close(); }
        }));
        sendJson(res, 200, { data: { ...listing, limits: { rows: limits.rows, columns: limits.columns, cellBytes: limits.cellBytes } } }); return true;
      }
      if (parts.length === 2 && parts[1] === 'snapshot' && method === 'POST') {
        const posted = body(await readJson(req, maxJsonBytes), ['projectId', 'agendaId', 'schema', 'table', 'columns', 'requestId']);
        // No columns, or an empty list, means every supported column; both forms are one request to the fingerprint.
        const input = { ...posted, columns: posted.columns ?? [] };
        assertClientProject(input.projectId);
        const project = await store.requireProject(user, input.projectId);
        const question = await agenda.get(user.id, input.agendaId);
        if (question.projectId !== project.id) throw new HttpError(404, 'autopilot_material_not_found', 'The research question was not found.');
        agenda.assertNotArchived(question);
        const fingerprint = researchDbSnapshotFingerprint({ connectionId: parts[0], ...input });
        const previous = await credentials.snapshotResult(user.id, project.id, input.requestId, fingerprint);
        if (previous) { recordResearchDbImport('replayed'); sendJson(res, 200, { data: previous }); return true; }
        const connection = await credentials.open(user.id, project.id, parts[0]);
        const target = { host: connection.host, port: connection.port, database: connection.database };
        const result = await guarded(user, project, 'research_db.import', `${input.schema}.${input.table}`, async () => {
          // A full list of material refuses a new document BEFORE the remote database is read; a new version of a table
          // the question already holds takes that one's place and needs no room.
          await agenda.assertMaterialRoom(user.id, question.id, researchDbLogicalPath(target, String(input.schema), String(input.table)));
          const snapshot = await capacity.run(user.id, async () => {
            const transport = await open(connection, policy, { caDir, limits });
            try { return await snapshotResearchTable(transport.client, { schema: input.schema, table: input.table, columns: input.columns }, { limits }); }
            catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'research_db_unavailable', 'The database snapshot could not be read.'); }
            finally { await transport.close(); }
          });
          return publish({ user, project, connectionId: parts[0], target, agendaId: question.id, requestId: input.requestId, fingerprint, snapshot });
        });
        recordResearchDbImport(result.partial ? 'partial' : 'complete');
        if (result.truncated) recordResearchDbRefusal('truncated');
        if (result.withheldCells > 0) recordResearchDbRefusal('cells_withheld');
        if (result.droppedColumnCount > 0) recordResearchDbRefusal('columns_dropped');
        await record(user, project, 'research_db.import', 'completed', { target: result.sourceId });
        sendJson(res, 201, { data: result }); return true;
      }
      throw new HttpError(404, 'not_found', 'Database operation not found.');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'research_db_unavailable', 'Database snapshots are unavailable.');
    }
  };
  // Start-up runs the same preparation, so a keyring that does not cover the saved credentials is reported when the
  // process starts and not at the first request.
  return Object.assign(handler, {
    prepare: () => (credentials ? migrate() : Promise.resolve()),
    /**
     * The connector's readiness fact (`/api/ready`, check `researchDb`): off, or on with the answer to the one question that
     * can make it useless -- whether the keyring holds the key of every saved credential. Never red: a connector that cannot
     * open its credentials is a feature that is down, and the platform ships on green readiness.
     * @returns {Promise<{required: false, enabled: boolean, warning?: string}>}
     */
    async readiness() {
      if (!(credentials && agenda && publish && policy)) return { required: false, enabled: false };
      try { await migrate(); return { required: false, enabled: true }; }
      catch (error) { return { required: false, enabled: true, warning: auditCode(error) === 'research_db_keyring_incomplete' ? 'research_db_keyring_incomplete' : 'research_db_unavailable' }; }
    },
  });
}
