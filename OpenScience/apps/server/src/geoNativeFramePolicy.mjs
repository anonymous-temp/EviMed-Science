import { NativeUiScope } from '@evimed/harness-port/runtime-ui-scope';
import { subagentAddress } from './dshRuntimeAdapter.mjs';
import { HttpError } from './security.mjs';

const denied = () => new HttpError(403, 'runtime_ui_method_denied', 'This operation is outside the GEO conversation.');

/** One signed frame's native scope; constructed only after durable GEO authority
 * and safe project-context generation have both been verified by composition.
 */
export class GeoNativeFramePolicy {
  constructor({ authority, runtimeManager, config, user, project, claims, acceptInput, nativeInputs = null }) {
    this.authority = authority; this.runtime = runtimeManager; this.user = user;
    this.nativeInputs = nativeInputs; this.nativeOperations = new WeakMap(); this.questionInputs = new Map();
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
    const generation = Symbol('native-carrier'); this.carrier = generation; this.scope.resetCarrier(); this.questionInputs.clear();
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
        const projected = this.scope.project(method, payload, value);
        // A successful MUX item is the native RPC result. The pinned gateway
        // does not echo question cancellation to the answering peer.
        if (projected.forward) { this.captureQuestion(method, value); this.completeInput(method, payload); }
        return projected;
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
    const projected = this.scope.project(method, payload, value);
    if (projected.forward) this.captureQuestion(method, value);
    return projected;
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
  completeInput(method, payload) {
    this.scope.complete(method, payload);
    if (method === '$events/result') this.questionInputs.delete(payload?.args?.eventId);
    if (method === 'userQuestions/answer') for (const [id, input] of this.questionInputs) if (input.callId === payload?.args?.callId) this.questionInputs.delete(id);
  }
  captureQuestion(method, value) {
    if (method !== '$events') return;
    if (value?.type === 'ready') this.questionInputs.clear();
    if (value?.type === 'cancel') this.questionInputs.delete(value.eventId);
    if (value?.type === 'waterfall' && value.event === 'user-questions/request' && value.agentId === this.claims.delegation.rootSessionId
      && typeof value.request?.wait?.callId === 'string' && Array.isArray(value.request.questions)
      && Buffer.byteLength(JSON.stringify(value.request.questions)) <= 65536 && this.questionInputs.size < 128) {
      this.questionInputs.set(value.eventId, { callId: value.request.wait.callId, questions: JSON.parse(JSON.stringify(value.request.questions)) });
    }
  }
  inputOperation(method) { return ['$events/result', 'userQuestions/answer', 'session/cancel'].includes(method); }
  async prepareOperation(method, payload) {
    if (!this.nativeInputs || !this.inputOperation(method)) return null;
    let interaction = null;
    if (method !== 'session/cancel') {
      // The native scope registered this exact outstanding interaction from its
      // scoped carrier. A client call/event id alone cannot create one.
      if (!this.scope.permits(method, payload)) throw denied();
      interaction = method === '$events/result' ? this.scope.interactions.get(payload.args.eventId)
        : [...this.scope.interactions.values()].find(item => item.agentId === payload.args.agentId && item.callId === payload.args.callId)
          ?? this.scope.questionCalls.get(payload.args.agentId)?.items.get(payload.args.callId);
      if (!interaction) throw denied();
      const retained = method === '$events/result' ? this.questionInputs.get(payload.args.eventId)
        : [...this.questionInputs.values()].find(item => item.callId === payload.args.callId);
      interaction = { ...interaction, ...(retained ?? {}) };
    }
    const request = await this.nativeInputs.prepareOperation({ user:this.user, project:this.project, claims:this.claims, method, payload, interaction });
    this.nativeOperations.set(payload, request);
    return request;
  }
  operationRequest(payload) { return this.nativeOperations.get(payload); }
  async runOperation(method, payload, business) {
    const request = this.operationRequest(payload);
    return request ? this.runInput(request, business) : this.withAuthority(business);
  }
  async prepareInput(request) {
    if (!this.nativeInputs) return;
    return this.nativeInputs.prepare({ user: this.user, project: this.project, claims: this.claims, request });
  }
  async runInput(request, business) {
    if (!this.nativeInputs) return this.withAuthority(business);
    const result = await this.nativeInputs.execute(request, operation => this.withAuthority(operation), business);
    if (result.error) throw result.error;
    return result.value;
  }
  inputDisposition(request) { return this.nativeInputs?.disposition(request) ?? 'unknown'; }
  /** Whether the input journal holds this input: not for a project its owner works in alone (`GeoNativeInputs.prepare`). */
  journals(request) { return Boolean(this.nativeInputs?.journals(request)); }
  beforeInputForward(request) { return this.nativeInputs ? this.nativeInputs.beforeForward(request) : Promise.resolve(); }
  observeInput(request, observation) { this.nativeInputs?.observe(request, observation); }
  observeHttpInput(request, rpcId, response) { this.nativeInputs?.observeHttp(request, rpcId, response); return Promise.resolve(); }
  afterInputAdmission(request, error) { return this.nativeInputs ? this.nativeInputs.afterAdmission(request, error) : Promise.resolve(); }
  async recordInput(request) {
    if (this.nativeInputs) return;
    if (!this.acceptInput) throw new HttpError(503, 'geo_native_context_unavailable', 'The shared input receipt is unavailable.');
    await this.acceptInput(this.user, this.project, this.claims.delegation, request);
  }
  onStreamClosed(endpoint) { if (endpoint === '$events') this.scope.closeEvents(); }
  dispose() { this.disposed = true; this.questionInputs.clear(); this.scope.dispose(); }
}

/**
 * A delegated frame's standing check. Membership and the frame's claims are resolved on every call. The runtime's shared context —
 * its launch proof, the generation's bytes and the kernel's session inventory (`verifyContext`) — is verified in full on the
 * handshake, an HTTP request and a prompt; a carrier's repeated recheck (`recheck`, one memo per carrier) verifies it again only when
 * `contextStamp`, the runtime generation and the context policy's revision, differs from the one it last verified. Re-verifying an
 * unchanged generation every second rebuilt the method tree and listed the kernel's sessions once a second per open socket.
 * @param {{ resolve: (user: any, scope: any, claims: any) => Promise<any>, contextStamp: (resolved: any) => Promise<string | null>,
 *   verifyContext: (resolved: any) => Promise<void> }} parts
 */
export function createGeoFrameResolver({ resolve, contextStamp, verifyContext }) {
  /** @param {any} user @param {any} scope @param {any} [claims] @param {{ recheck?: { verified?: string | null } | null }} [options] */
  return async (user, scope, claims = null, { recheck = null } = {}) => {
    const resolved = await resolve(user, scope, claims);
    const stamp = recheck ? await contextStamp(resolved) : null;
    if (recheck && stamp !== null && recheck.verified === stamp) return resolved;
    if (recheck) recheck.verified = null;
    await verifyContext(resolved);
    // A generation or policy that moves while it is verified gives the next recheck another stamp (neither ever moves back), so the
    // stamp read before the verification is the one it stands for.
    if (recheck) recheck.verified = stamp;
    return resolved;
  };
}
