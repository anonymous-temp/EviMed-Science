import { NativeUiScope } from '@evimed/harness-port/runtime-ui-scope';
import { subagentAddress } from './dshRuntimeAdapter.mjs';
import { HttpError } from './security.mjs';

const denied = () => new HttpError(403, 'runtime_ui_method_denied', 'This operation is outside the GEO conversation.');

/** One signed frame's native scope; constructed only after durable GEO authority
 * and safe project-context generation have both been verified by composition.
 */
export class GeoNativeFramePolicy {
  constructor({ authority, runtimeManager, config, user, project, claims, acceptInput }) {
    this.authority = authority; this.runtime = runtimeManager; this.user = user;
    this.project = project; this.claims = claims; this.acceptInput = acceptInput;
    this.scope = new NativeUiScope({ rootSessionId: claims.delegation.rootSessionId,
      workspacePath: runtimeManager.runtimeWorkspaceRoot(project), provider: 'deepseek-official', model: config.deepseekModel });
    this.generation = runtimeManager.runtimeGeneration(project);
    this.disposed = false;
    this.carrier = null;
  }

  async refresh() {
    if (this.disposed) throw denied();
    const generation = this.runtime.runtimeGeneration(this.project);
    if (generation !== this.generation) { this.scope.dispose(); this.generation = generation; }
    const root = this.claims.delegation.rootSessionId;
    const rows = await this.runtime.subagentCatalogue(this.project, root);
    this.scope.setChildren(rows.map(row => subagentAddress(root, row)).filter(Boolean));
  }
  access() { return this.scope.access(); }
  openCarrier() {
    const generation = Symbol('native-carrier'); this.carrier = generation; this.scope.closeEvents();
    let eventsId = null;
    const assertCurrent = () => { if (this.disposed || this.carrier !== generation) throw denied(); };
    return {
      assertCurrent,
      authorize: async (method, payload, context) => {
        assertCurrent();
        if (method === '$events' && (eventsId !== null || !context?.streamId)) throw denied();
        await this.authorize(method, payload); assertCurrent();
        if (context?.signal.aborted) throw denied();
        if (method === '$events') eventsId = context.streamId;
      },
      projectItem: async (method, payload, value, context) => {
        assertCurrent();
        if (['session/list', 'session/control', '$events'].includes(method)) await this.refresh();
        assertCurrent();
        if (context.signal.aborted || method === '$events' && eventsId !== context.streamId) return { forward: false };
        return this.scope.project(method, payload, value);
      },
      onStreamClosed: (endpoint, streamId) => { if (this.carrier === generation && endpoint === '$events' && eventsId === streamId) { eventsId = null; this.scope.closeEvents(); } },
    };
  }
  async authorize(method, payload) {
    await this.refresh();
    if (!this.scope.permits(method, payload)) throw denied();
  }
  authorizeUpload(url) {
    if (this.disposed || url.searchParams.getAll('sessionId').length !== 1
      || url.searchParams.get('sessionId') !== this.claims.delegation.rootSessionId
      || url.searchParams.getAll('name').length > 1 || [...url.searchParams.keys()].some(key => !['sessionId', 'name'].includes(key))) throw denied();
  }
  async projectItem(method, payload, value) {
    if (['session/list', 'session/control', '$events'].includes(method)) await this.refresh();
    return this.scope.project(method, payload, value);
  }
  async httpResponse(call, response) {
    if (!String(response.contentType).toLowerCase().includes('application/json')) throw denied();
    let value;
    try { value = JSON.parse(response.body.toString('utf8')); } catch { throw denied(); }
    if (value?.type !== 'server-response' || value.rpcId !== call.rpcId || typeof value.result?.ok !== 'boolean') throw denied();
    if (!value.result.ok) return response.body;
    const projected = await this.projectItem(call.method, call.payload, value.result.value);
    if (!projected.forward) throw denied();
    this.scope.complete(call.method, call.payload);
    return Buffer.from(JSON.stringify({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, ...('value' in projected ? { value: projected.value } : {}) } }));
  }
  /** The existing plugin admission remains outside this membership lock. */
  withAuthority(operation) {
    if (this.disposed) throw denied();
    return this.authority.withFrame(this.user, this.claims.delegation, async identity => {
      if (identity.project.id !== this.project.id || identity.project.userId !== this.project.userId) throw denied();
      return operation();
    });
  }
  async recordInput(request) {
    if (!this.acceptInput) throw new HttpError(503, 'geo_native_context_unavailable', 'The shared input receipt is unavailable.');
    await this.acceptInput(this.user, this.project, this.claims.delegation, request);
  }
  onStreamClosed(endpoint) { if (endpoint === '$events') this.scope.closeEvents(); }
  dispose() { this.disposed = true; this.scope.dispose(); }
}
