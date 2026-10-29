import { geoPlanDigest } from './geoPlanContext.mjs';
import { HttpError } from './security.mjs';
import { preservedConversationHistory } from './conversationHistory.mjs';

const missing = () => new HttpError(404, 'geo_signal_not_found', 'This handling record is unavailable.');

/** A GEO read capability for one proved handling or programme run. It never grants access to the owner's ordinary project. */
export class GeoSignalResults {
  constructor({ signals, contexts, results, controlProject, programmeRuns = async (_project) => [], readHistory = preservedConversationHistory }) {
    this.signals = signals; this.contexts = contexts; this.results = results; this.controlProject = controlProject; this.readHistory = readHistory;
    this.programmeRuns = programmeRuns;
  }

  async scope(user, geoId, signalId, runId) {
    const project = await this.signals.service.requireProject(user, geoId);
    const signal = signalId ? await this.signals.row(project, signalId) : null;
    const runs = await this.contexts.runs(project);
    const run = runs.find(candidate => candidate.id === runId);
    if (!run || !run.sessionId) throw missing();
    if (!signal && (await this.programmeRuns(project)).some(entry => entry.runId === run.id && entry.sessionId === run.sessionId)) return { project, signal, context: null, run };
    if (!Array.isArray(run.kernelRequestIds)) throw missing();
    const contexts = await this.signals.all(project, 'geo-plan-context', { recordType: 'geo-plan-context', geoId, ...(signal ? { mode: 'signal' } : {}), state: 'bound', sessionId: run.sessionId });
    const candidates = contexts.filter(row => run.kernelRequestIds.includes(row.payload.requestId)
      && (!signal || row.payload.basis?.signal?.id === signal.id && row.payload.basis.signal.basisDigest === signal.payload.basisDigest)
      && row.payload.basisDigest === geoPlanDigest(row.payload.basis));
    if (candidates.length !== 1) throw missing();
    const context = candidates[0];
    const [request, handling] = await Promise.all([
      this.contexts.documents.get(project.userId, 'geo-plan-context', `gpcbind_${geoPlanDigest([context.payload.actorId, project.projectId, context.payload.requestId])}`),
      context.payload.mode === 'signal' ? this.contexts.documents.get(project.userId, 'geo-plan-context', `gpcsignal_${geoPlanDigest([project.id, context.payload.basis.handlingKey])}`) : null,
    ]);
    for (const [receipt, type] of [[request, 'geo-plan-request'], [handling, 'geo-signal-request']]) {
      if (type === 'geo-signal-request' && context.payload.mode !== 'signal') continue;
      if (!receipt || receipt.projectId !== project.projectId || receipt.payload.recordType !== type || receipt.payload.geoId !== project.id
        || receipt.payload.referenceId !== context.id || receipt.payload.actorId !== context.payload.actorId
        || receipt.payload.sessionId !== run.sessionId || receipt.payload.requestId !== context.payload.requestId
        || receipt.payload.requestDigest !== context.payload.requestDigest) throw missing();
    }
    return { project, signal, context, run };
  }

  async record(user, geoId, signalId, runId) {
    const scope = await this.scope(user, geoId, signalId, runId);
    const control = await this.controlProject(scope.project);
    const history = await this.readHistory(control, scope.run.sessionId, [scope.run], undefined, { runId: scope.run.id });
    const files = [];
    let cursor = null;
    do {
      const page = await this.results.list(scope.project.userId, { projectId: scope.project.projectId, runId, limit: 100, cursor });
      for (const version of page.items) if (this.belongs(scope, version)) files.push({ versionId: version.versionId, path: version.path, runId, sessionId: scope.run.sessionId });
      cursor = page.nextCursor;
    } while (cursor);
    return { runId, sessionId: scope.run.sessionId, history, files };
  }

  belongs(scope, version) {
    return version?.projectId === scope.project.projectId && version.producer?.kind !== 'workspace'
      && version.producer?.runId === scope.run.id && version.producer?.sessionId === scope.run.sessionId;
  }

  async version(user, geoId, signalId, runId, versionId, { raw = false } = {}) {
    const scope = await this.scope(user, geoId, signalId, runId);
    if (!/^rv_[a-f0-9]{64}$/.test(versionId ?? '')) throw missing();
    const version = await this.results.get(scope.project.userId, scope.project.projectId, versionId);
    if (!this.belongs(scope, version)) throw missing();
    if (!raw) return version;
    const content = await this.results.raw(scope.project.userId, scope.project.projectId, versionId);
    if (!this.belongs(scope, content.version) || content.version.versionId !== versionId || content.version.digest !== version.digest) throw missing();
    return content;
  }
}
