import { HttpError, readJson, sendJson } from './security.mjs';
import { assertClientProject } from './internalProjects.mjs';
import { openResearchDb } from './researchDbTransport.mjs';
import { admittedResearchDbAddresses } from './researchDbNetwork.mjs';
import { researchDbSnapshotFingerprint } from './researchDbCredentials.mjs';
import { listResearchTables, snapshotResearchTable } from './researchDbSnapshot.mjs';
import { withResearchDbCapacity } from './researchDbCapacity.mjs';

/** @param {any} value @param {string[]} keys */
function body(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new HttpError(400, 'research_db_payload_invalid', 'The database request is invalid.');
  return value;
}

/** @param {{store:any,credentials:any,agenda:any,policy:string,maxJsonBytes:number,publish:any,open?:any}} dependencies */
export function createResearchDbRoutes({ store, credentials, agenda, policy, maxJsonBytes, publish, open = openResearchDb }) {
  /** @type {Promise<any> | null} */ let ready = null;
  // The tables, then the proof that every saved credential's key is in the keyring: an incomplete keyring answers
  // research_db_keyring_incomplete on every route until an operator restores the missing version.
  const migrate = () => { ready ??= credentials.migrate().then(() => credentials.assertKeyCoverage()).catch((/** @type {any} */ error) => { ready = null; throw error; }); return ready; };
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
        assertClientProject(input.projectId); await store.requireProject(user, input.projectId);
        const { projectId, requestId, ...connection } = input;
        admittedResearchDbAddresses(connection.host, connection.port, policy);
        const id = await credentials.save(user.id, projectId, connection, requestId);
        sendJson(res, 201, { data: { id } }); return true;
      }
      if (parts.length === 1 && method === 'DELETE') {
        const input = body(await readJson(req, maxJsonBytes), ['projectId']);
        assertClientProject(input.projectId); await store.requireProject(user, input.projectId);
        const removed = await credentials.remove(user.id, input.projectId, parts[0]);
        sendJson(res, 200, { data: { removed } }); return true;
      }
      if (parts.length === 2 && parts[1] === 'tables' && method === 'GET') {
        const projectId = url.searchParams.get('projectId'); assertClientProject(projectId);
        const project = await store.requireProject(user, projectId);
        const connection = await credentials.open(user.id, project.id, parts[0]);
        const listing = await withResearchDbCapacity(credentials.database, user.id, async () => {
          const transport = await open(connection, policy);
          try { return await listResearchTables(transport.client); }
          catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'research_db_unavailable', 'The database tables could not be read.'); }
          finally { await transport.close(); }
        });
        sendJson(res, 200, { data: listing }); return true;
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
        if (previous) { sendJson(res, 200, { data: previous }); return true; }
        const connection = await credentials.open(user.id, project.id, parts[0]);
        const snapshot = await withResearchDbCapacity(credentials.database, user.id, async () => {
          const transport = await open(connection, policy);
          try { return await snapshotResearchTable(transport.client, { schema: input.schema, table: input.table, columns: input.columns }); }
          catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'research_db_unavailable', 'The database snapshot could not be read.'); }
          finally { await transport.close(); }
        });
        const result = await publish({ user, project, connectionId: parts[0], agendaId: question.id, requestId: input.requestId, fingerprint, snapshot });
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
  return Object.assign(handler, { prepare: () => (credentials ? migrate() : Promise.resolve()) });
}
