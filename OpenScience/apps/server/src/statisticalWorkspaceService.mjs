/** Dedicated native analysis conversations reuse ordinary projects, sessions and the run ledger. */
import { isStatisticalWorkspaceProjectId } from '@evimed/domain';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
import { analysisFields, analysisString } from './dataAnalysisInputs.mjs';

const DOCUMENT_KIND = 'data-analysis';
const PAYLOAD_KIND = 'statistical-workspace';

/** Reserved identity, not an internal-project classification or quota exemption. @param {any} project */
export function isStatisticalWorkspaceProject(project) {
  return isStatisticalWorkspaceProjectId(typeof project === 'string' ? project : project?.id);
}

export class StatisticalWorkspaceService {
  /** @param {{documents:any,store:any,registry:any,sessions:any,createProject:(user:any,body:any)=>Promise<any>}} dependencies */
  constructor({ documents, store, registry, sessions, createProject }) {
    this.documents = documents;
    this.store = store;
    this.registry = registry;
    this.sessions = sessions;
    this.createProject = createProject;
  }

  /** The immutable root admission covers native prompts and internal run reservations. Managed children stay in the root run.
   * @param {any} project @param {string} sessionId */
  async authorizeSession(project, sessionId) {
    if (!isStatisticalWorkspaceProject(project)) return;
    const record = await this.documents.get(project.userId, DOCUMENT_KIND, `gui_${project.id.slice(5)}`);
    if (record?.payload.kind !== PAYLOAD_KIND || record.payload.projectId !== project.id ||
        record.payload.phase !== 'ready' || record.payload.sessionId !== sessionId) {
      throw new HttpError(409, 'statistical_workspace_session_reserved', 'Continue the original analysis conversation or start a new analysis from Research Tools.');
    }
  }

  /** Persist the identity before effects so an interrupted bind and concurrent requests recover the same conversation.
   * @param {any} user @param {any} body */
  async create(user, body) {
    analysisFields(body, ['requestId', 'name']);
    const requestId = analysisString(body.requestId, 100);
    if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) throw new HttpError(400, 'analysis_payload_invalid', 'requestId must use letters, digits, dot, colon, underscore or hyphen.');
    const name = body.name === undefined ? '数据分析' : analysisString(body.name, 120);
    const digest = createHash('sha256').update(JSON.stringify([user.id, requestId])).digest('hex').slice(0, 40);
    const id = `gui_${digest}`, projectId = `stat-${digest}`;
    let record = await this.documents.get(user.id, DOCUMENT_KIND, id);
    if (!record) {
      const agent = (await this.registry).get('statistical-analysis');
      if (!agent) throw new HttpError(503, 'analysis_capability_unavailable', 'The analysis capability is unavailable.');
      try {
        record = await this.documents.put(user.id, DOCUMENT_KIND, id, {
          kind: PAYLOAD_KIND, projectId, requestId, name, phase: 'creating',
          sessionId: `ses_${randomUUID().replaceAll('-', '')}`, agentId: agent.id, agentVersion: agent.version,
        }, { expectedRevision: 0 });
      } catch (error) {
        if (error?.code !== 'product_revision_conflict') throw error;
        record = await this.documents.get(user.id, DOCUMENT_KIND, id);
      }
    }
    if (record?.payload.kind !== PAYLOAD_KIND || record.payload.name !== name || record.payload.requestId !== requestId) {
      throw new HttpError(409, 'analysis_request_conflict', 'This requestId was used with different content.');
    }
    const payload = record.payload;
    if (payload.phase !== 'ready') {
      try { await this.createProject(user, { id: projectId, name }); }
      catch (error) { if (error?.code !== 'project_exists') throw error; }
      const project = await this.store.requireProject(user, projectId);
      await this.sessions.put(project, payload.sessionId, { mode: 'specialist', agentId: payload.agentId, agentVersion: payload.agentVersion });
      try {
        record = await this.documents.put(user.id, DOCUMENT_KIND, id, { ...payload, phase: 'ready' }, { expectedRevision: record.revision, projectId });
      } catch (error) {
        if (error?.code !== 'product_revision_conflict') throw error;
        record = await this.documents.get(user.id, DOCUMENT_KIND, id);
        if (record?.payload.phase !== 'ready') throw error;
      }
    } else {
      // Revalidate ownership before returning an existing navigation identity.
      await this.store.requireProject(user, projectId);
    }
    return { projectId, sessionId: record.payload.sessionId };
  }
}
