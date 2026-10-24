import { RUNTIME_UI_WORKSPACE_PATH_METHODS } from '@evimed/domain';

/** @param {any} value */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {any} value @returns {any[]} */
const rows = value => { if (!Array.isArray(value)) throw new Error('Malformed native scoped collection'); return value; };
/** @param {any} value @param {string[]} fields */
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
/** @param {any} value */
const kept = value => ({ forward: true, value });
const dropped = () => ({ forward: false });
const DISCOVERY = new Set(['$events', 'session/list', 'session/control', 'session/modelCatalog', 'workspace/follow', 'remoteAccess/follow']);
const WORKSPACE_READS = new Set(RUNTIME_UI_WORKSPACE_PATH_METHODS);
const SUMMARY_FIELDS = ['agentAvailable', 'formatStatus', 'sessionId', 'updatedAt', 'running', 'blank', 'parentSessionId', 'origin', 'cwd', 'projections'];
const JOB_FIELDS = ['id', 'kind', 'label', 'owner', 'outputLimitBytes', 'status', 'progress', 'detail', 'startedAt', 'finishedAt'];
const SESSION_EMITS = new Set(['api-session/status', 'api-session/activity', 'api-session/error', 'api-session/removed']);

/**
 * Thin projection of the pinned native wire. The control plane supplies proven
 * roots/children and checks current membership; rows on this wire cannot grant
 * authority. One instance belongs to one signed frame and native generation.
 */
export class NativeUiScope {
  /** @param {{rootSessionId:string,workspacePath:string,provider:string,model:string}} options */
  constructor({ rootSessionId, workspacePath, provider, model }) {
    this.rootSessionId = rootSessionId; this.workspacePath = workspacePath;
    this.provider = provider; this.model = model;
    /** @type {Map<string,any>} */ this.children = new Map();
    /** @type {Set<string>} */ this.workspaces = new Set();
    /** @type {Map<string,Set<string>>} */ this.jobs = new Map();
    /** @type {Map<string,{agentId:string,event:string,callId?:string}>} */ this.interactions = new Map();
    /** @type {string|null} */ this.clientId = null;
  }

  /** Only server-verified catalogue addresses may enter here. @param {any[]} addresses */
  setChildren(addresses) {
    this.children.clear();
    // Current production delegation depth is one. Reject broader graphs here
    // until the control plane also supplies their bounded ancestry proof.
    for (const address of addresses) if (record(address) && address.kind === 'subagent'
      && address.parentSessionId === this.rootSessionId && typeof address.childSessionId === 'string'
      && address.childSessionId !== this.rootSessionId && ['one-shot', 'continuable', 'unknown'].includes(address.mode)) {
      this.children.set(address.childSessionId, pick(address, ['kind', 'parentSessionId', 'childSessionId', 'mode']));
    }
    for (const [id, interaction] of this.interactions) if (!this.readable(interaction.agentId)) this.interactions.delete(id);
    for (const id of this.jobs.keys()) if (!this.readable(id)) this.jobs.delete(id);
  }
  /** @param {any} id */
  readable(id) { return id === this.rootSessionId || this.children.has(id); }
  /** @param {any} address */
  addressAllowed(address) {
    if (!record(address)) return false;
    if (address.kind === 'session') return Object.keys(address).length === 2 && address.sessionId === this.rootSessionId;
    const child = this.children.get(address.childSessionId);
    return Boolean(child && Object.keys(address).length === 4 && Object.entries(child).every(([key, value]) => address[key] === value));
  }
  /** Keep proof registries no longer than their actual transport generation. */
  closeEvents() { this.clientId = null; this.interactions.clear(); }
  dispose() { this.closeEvents(); this.jobs.clear(); this.children.clear(); this.workspaces.clear(); }
  /** The pinned gateway removes the answering peer before broadcasting cancel
   * to other peers. Only a confirmed successful response consumes this proof.
   * @param {string} method @param {any} payload */
  complete(method, payload) {
    if (method === '$events/result' && payload?.args?.clientId === this.clientId) this.interactions.delete(payload.args.eventId);
    if (method === 'userQuestions/answer') for (const [id, item] of this.interactions) {
      if (item.agentId === payload?.args?.agentId && item.callId === payload?.args?.callId) this.interactions.delete(id);
    }
  }

  /** Authorization ceiling, additional to ordinary hosted methods/path/body limits. @param {string} method @param {any} payload */
  permits(method, payload) {
    const args = payload?.args, request = args?.request;
    if (!record(payload) || Object.keys(payload).length !== 1 || !record(args)) return false;
    if (DISCOVERY.has(method)) return method === 'session/list' ? record(args._request) && Object.keys(args).length === 1 && Object.keys(args._request).length === 0 : Object.keys(args).length === 0;
    if (WORKSPACE_READS.has(method)) return true; // Existing workspace/no-symlink guard must also pass.
    if (method === 'workspace/create') return record(request) && Object.keys(args).length === 1 && Object.keys(request).length === 1 && request.path === this.workspacePath;
    if (['session/page', 'session/follow'].includes(method)) return this.addressAllowed(request?.address);
    if (['session/prompt', 'session/cancel', 'session/attachment', 'session/projections'].includes(method)) return request?.sessionId === this.rootSessionId;
    if (['fileReferences/list', 'fileUploads/upload'].includes(method)) return args.agentId === this.rootSessionId;
    if (method === 'job/list') return this.readable(request?.sessionId);
    if (['job/follow', 'job/kill'].includes(method)) return this.readable(request?.sessionId) && Boolean(this.jobs.get(request.sessionId)?.has(request.jobId));
    if (method === '$events/result') return this.clientId !== null && args.clientId === this.clientId && this.interactions.has(args.eventId);
    if (['userQuestions/answer', 'userQuestions/attachWait'].includes(method)) return typeof args.callId === 'string'
      && [...this.interactions.values()].some(item => item.agentId === args.agentId && item.event === 'user-questions/request' && item.callId === args.callId);
    return false;
  }

  /** UI hints mirror the server ceiling; they never grant server authority. */
  access() {
    return { type: 'baseline', owner: false, grants: [
      { resource: { kind: 'global' }, actions: [...DISCOVERY, 'workspace/create', ...WORKSPACE_READS] },
      { resource: { kind: 'session', id: this.rootSessionId }, actions: ['session/page', 'session/follow', 'session/projections', 'session/prompt', 'session/cancel', 'session/attachment', 'fileUploads/upload', 'fileReferences/list', 'job/list', 'job/follow', 'job/kill', 'userQuestions/answer', 'userQuestions/attachWait'] },
      ...[...this.children.keys()].map(id => ({ resource: { kind: 'session', id }, actions: ['session/page', 'session/follow', 'job/list', 'job/follow', 'job/kill', 'userQuestions/answer', 'userQuestions/attachWait'] })),
    ] };
  }

  /** @param {any} value @returns {any} */
  workspace(value) {
    if (!record(value) || value.path !== this.workspacePath || typeof value.workspaceId !== 'string' || !Array.isArray(value.sessionIds)) return null;
    this.workspaces.add(value.workspaceId);
    return { ...pick(value, ['workspaceId', 'path', 'title', 'createdAt', 'updatedAt']), sessionIds: rows(value.sessionIds).filter(id => this.readable(id)) };
  }
  /** @param {any} value */
  job(value) { return { ...pick(value, JOB_FIELDS), output: pick(value.output ?? {}, ['total', 'earliest']) }; }

  /** @param {string} method @param {any} payload @param {any} value @returns {{forward:boolean,value?:any}} */
  project(method, payload, value) {
    if (!this.permits(method, payload)) return dropped();
    if (method === 'session/list') return kept({ items: rows(value?.items).filter(item => this.readable(item.sessionId)).map(item => pick(item, SUMMARY_FIELDS)) });
    if (method === 'session/control') {
      if (value?.type === 'baseline' && record(value.value?.projections)) return kept({ type: 'baseline', value: { projections: Object.fromEntries(Object.entries(value.value.projections).filter(([id]) => this.readable(id))) } });
      if (value?.type === 'projection' && this.readable(value.sessionId)) return kept(pick(value, ['type', 'sessionId', 'key', 'value', 'seq']));
      return dropped();
    }
    if (method === 'workspace/create') {
      const item = this.workspace(value?.workspace);
      if (!item) throw new Error('Native workspace response does not match its bound path');
      return kept({ workspace: item, created: value.created });
    }
    if (method === 'workspace/follow') return this.workspaceFrame(value);
    if (method === 'remoteAccess/follow') return value?.type === 'baseline' ? kept(this.access()) : dropped();
    if (method === 'session/modelCatalog') return kept(this.modelCatalog(value));
    if (method === '$events') return this.event(value);
    if (method === 'job/list') {
      if (value?.type !== 'rows' || !Array.isArray(value.jobs)) return dropped();
      const jobs = rows(value.jobs).filter(job => job.owner === payload.args.request.sessionId);
      this.jobs.set(payload.args.request.sessionId, new Set(jobs.map(job => job.id)));
      return kept({ type: 'rows', jobs: jobs.map(job => this.job(job)) });
    }
    if (method === 'job/follow' && ['opened', 'status'].includes(value?.type)) {
      if (value.job?.owner !== payload.args.request.sessionId || value.job?.id !== payload.args.request.jobId) return dropped();
      return kept({ ...pick(value, ['type', 'from']), job: this.job(value.job) });
    }
    // Authorized transcript/output records retain their native sequencing.
    return kept(value);
  }

  /** @param {any} value @returns {{forward:boolean,value?:any}} */
  workspaceFrame(value) {
    if (['baseline', 'replace'].includes(value?.type) && record(value.value) && Array.isArray(value.value.items)) {
      const items = rows(value.value.items).map(item => this.workspace(item)).filter(Boolean);
      this.workspaces = new Set(items.map(item => item.workspaceId));
      return kept({ type: value.type, value: { items, archivedSessionIds: rows(value.value.archivedSessionIds).filter(id => this.readable(id)), pinnedSessionIds: rows(value.value.pinnedSessionIds).filter(id => this.readable(id)) } });
    }
    if (value?.type === 'upsert') { const item = this.workspace(value.workspace); return item ? kept({ type: 'upsert', workspace: item }) : dropped(); }
    if (value?.type === 'remove' && this.workspaces.delete(value.workspaceId)) return kept({ type: 'remove', workspaceId: value.workspaceId });
    if (value?.type === 'order') return kept({ type: 'order', workspaceIds: rows(value.workspaceIds).filter(id => this.workspaces.has(id)) });
    if (value?.type === 'archived') return kept({ type: 'archived', archivedSessionIds: rows(value.archivedSessionIds).filter(id => this.readable(id)) });
    if (value?.type === 'pinned') return kept({ type: 'pinned', pinnedSessionIds: rows(value.pinnedSessionIds).filter(id => this.readable(id)) });
    return dropped();
  }

  /** @param {any} value */
  modelCatalog(value) {
    if (value?.default?.provider !== this.provider || value.default.model !== this.model || !Array.isArray(value.groups)) throw new Error('Native default model is not the certified model');
    const groups = rows(value.groups).filter(group => group.id === this.provider).map(group => ({ id: group.id, name: group.name,
      models: rows(group.models).filter(model => model.id === this.model).map(model => pick(model, ['id', 'name', 'reasoning'])) })).filter(group => group.models.length);
    if (groups.length !== 1 || groups[0].models.length !== 1) throw new Error('Native certified model catalogue is unavailable');
    return { default: pick(value.default, ['provider', 'model', 'reasoningEffort']), groups, routableProviders: [this.provider], failures: [] };
  }

  /** @param {any} value @returns {{forward:boolean,value?:any}} */
  event(value) {
    if (value?.type === 'ready' && typeof value.clientId === 'string' && value.clientId) {
      this.closeEvents(); this.clientId = value.clientId;
      return kept({ type: 'ready', clientId: value.clientId, host: { home: this.workspacePath } });
    }
    if (!this.clientId) return dropped();
    if (value?.type === 'emit' && Array.isArray(value.args)) {
      if (value.event === 'api-session/added' && this.readable(value.args[0]?.sessionId)) return kept({ type: 'emit', event: value.event, args: [pick(value.args[0], SUMMARY_FIELDS)] });
      if (SESSION_EMITS.has(value.event) && this.readable(value.args[0])) return kept({ type: 'emit', event: value.event, args: value.args });
    }
    if (value?.type === 'waterfall' && value.event === 'user-questions/request' && this.readable(value.agentId)
      && typeof value.eventId === 'string' && record(value.request)) {
      if (this.interactions.size >= 128 || this.interactions.has(value.eventId)) throw new Error('Native interaction registry capacity or duplicate');
      this.interactions.set(value.eventId, { agentId: value.agentId, event: value.event, ...(typeof value.request.wait?.callId === 'string' ? { callId: value.request.wait.callId } : {}) });
      return kept(pick(value, ['type', 'event', 'eventId', 'agentId', 'request']));
    }
    if (value?.type === 'cancel' && this.interactions.delete(value.eventId)) return kept({ type: 'cancel', eventId: value.eventId });
    // Hosted approval remains auto-refused; unrelated owner/global events have
    // no delegated disclosure path, including events without a session field.
    return dropped();
  }
}
