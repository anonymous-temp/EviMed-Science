/** Native client services, injected only in the kernel's browser application. */
export const inject = ['sessions', 'conversation', 'connection', 'workspaces'];

/**
 * Native navigation bridge. The body is self-contained for browser bundling.
 * apply must return synchronously: Gateway starts only after loader.await().
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global, injectable by the contract suite.
 */
export function apply(ctx, _config, target = globalThis) {
  const frame = target.__EVIMED_FRAME__;
  if (!frame || frame.version !== 1 || target.parent === target) return;
  const parent = target.parent;
  const boundCwd = frame.cwd;
  let outgoing = 0;
  let incoming = 0;
  let ready = false;
  let activated = false;
  /** @type {string | null} */ let selectedSession = null;
  let disposed = false;
  let refreshing = false;
  let resumeRequested = false;
  /** @type {string | null | undefined} */ let previousSession;
  let actions = Promise.resolve();
  const requests = new Map();
  /** @type {any} */ let pendingNavigation;
  /** @param {string} type @param {any} [fields] */
  function post(type, fields = {}) {
    if (disposed) return;
    parent.postMessage({ type: `evimed.runtime-ui.${type}`, version: 1, frameId: frame.frameId,
      projectId: frame.projectId, seq: ++outgoing, ...fields }, frame.shellOrigin);
  }
  function unavailable() {
    const wasReady = ready;
    ready = false;
    if (wasReady) post('connecting');
  }
  /** @param {any} command */
  function retain(command) {
    if (!pendingNavigation || command.seq >= pendingNavigation.seq) pendingNavigation = command;
  }
  /** @param {any} workspace @param {string} sessionId */
  const workspaceContains = (workspace, sessionId) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId);
  /** @param {string} requestedId */
  async function createBoundSession(requestedId) {
    if (typeof boundCwd !== 'string' || !boundCwd.startsWith('/') || boundCwd.startsWith('//')
      || boundCwd.length > 4096 || boundCwd.includes('\\')
      || [...boundCwd].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || boundCwd.split('/').some(part => part === '.' || part === '..')) throw new Error('Native frame workspace unavailable');
    const workspace = await ctx.workspaces.create({ path: boundCwd });
    if (typeof workspace?.workspaceId !== 'string' || !workspace.workspaceId) throw new Error('Native workspace unavailable');
    const sessionId = await ctx.sessions.create({ sessionId: requestedId, workspaceId: workspace.workspaceId });
    // create(path) idempotently resolves and publishes the authoritative row.
    // The public facade has no refresh verb; resolve again if its follow stream
    // has not yet published the session attachment, before claiming readiness.
    const listed = ctx.workspaces.list.getSnapshot().items.find((/** @type {any} */ item) => item.workspaceId === workspace.workspaceId);
    const attached = workspaceContains(listed, sessionId) ? listed : await ctx.workspaces.create({ path: boundCwd });
    if (attached.workspaceId !== workspace.workspaceId || !workspaceContains(attached, sessionId)) throw new Error('Native workspace attachment unavailable');
    return sessionId;
  }
  /** @param {any} command */
  function schedule(command) {
    const { requestId, intent, request } = command;
    if (disposed || request.queued || request.ack) return;
    if (!ready) { retain(command); return; }
    request.queued = true;
    actions = actions.then(async () => {
      if (disposed) return;
      if (!ready) { request.queued = false; retain(command); return; }
      try {
        let sessionId = intent.sessionId;
        if (intent.kind === 'create') sessionId = await createBoundSession(sessionId);
        else {
          await ctx.sessions.refresh();
          const known = ctx.sessions.list.getSnapshot().byId?.[sessionId];
          // Older control-plane sessions may have no Workspace Registry account.
          // Native create with an existing identity idempotently adopts it; its
          // transcript and identity survive while the registry attaches it.
          if (known && known.cwd === boundCwd
            && !ctx.workspaces.list.getSnapshot().items.some((/** @type {any} */ item) => workspaceContains(item, sessionId))) {
            const attachedId = await createBoundSession(sessionId);
            if (attachedId !== sessionId) throw new Error('Existing native session identity changed');
          }
        }
        if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new Error('Invalid native session identity');
        if (disposed) return;
        ctx.sessions.open(sessionId);
        if (intent.draft !== undefined) {
          const scope = ctx.sessions.scope(sessionId);
          if (!scope) throw new Error('Native session scope unavailable');
          ctx.conversation.input.for(scope).setDraft(intent.draft);
        }
        activated = true; selectedSession = sessionId; previousSession = sessionId;
        request.ack = { requestId, ok: true, sessionId };
      } catch { request.ack = { requestId, ok: false, error: 'NAVIGATION_FAILED' }; }
      request.queued = false;
      post('ack', request.ack); sessionChanged();
    });
  }
  function sessionChanged() {
    if (!ready || !activated || disposed) return;
    const sessionId = ctx.sessions.list.getSnapshot().current ?? null;
    if (sessionId === previousSession) return;
    previousSession = sessionId;
    selectedSession = sessionId;
    post('session', { sessionId });
  }
  async function establish() {
    if (disposed || refreshing) return;
    const generation = ctx.connection.generation.getSnapshot();
    if (!generation) { unavailable(); return; }
    refreshing = true;
    resumeRequested = false;
    unavailable();
    try {
      await ctx.sessions.refresh();
      if (disposed || ctx.connection.generation.getSnapshot() !== generation) return;
      if (activated && selectedSession) ctx.sessions.open(selectedSession);
      ready = true;
      post('ready'); sessionChanged();
      const pending = pendingNavigation;
      pendingNavigation = undefined;
      if (pending) schedule(pending);
    } catch {
      if (ctx.connection.generation.getSnapshot() === generation) post('error', { error: 'NATIVE_NOT_READY' });
    }
    finally {
      refreshing = false;
      if (!disposed && ctx.connection.generation.getSnapshot()
        && (ctx.connection.generation.getSnapshot() !== generation || (!ready && resumeRequested))) void establish();
    }
  }
  /** @param {any} event */
  function message(event) {
    if (disposed || event.source !== parent || event.origin !== frame.shellOrigin) return;
    const data = event.data;
    if (!data || data.version !== 1
      || data.frameId !== frame.frameId || data.projectId !== frame.projectId
      || !Number.isSafeInteger(data.seq) || data.seq <= incoming) return;
    if (data.type === 'evimed.runtime-ui.resume') {
      incoming = data.seq;
      // Cookie renewal need not replace the carrier generation. Retry only
      // the readiness read, preserving native input and pending navigation.
      if (!ready) { resumeRequested = true; void establish(); }
      return;
    }
    if (data.type !== 'evimed.runtime-ui.navigate'
      || typeof data.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.requestId)) return;
    const intent = data.intent;
    if (!intent || !['create', 'open'].includes(intent.kind)
      || typeof intent.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(intent.sessionId)
      || (intent.draft !== undefined && (typeof intent.draft !== 'string' || intent.draft.length > 100_000))) return;
    incoming = data.seq;
    const signature = JSON.stringify([intent.kind, intent.sessionId, intent.draft ?? null]);
    const existing = requests.get(data.requestId);
    if (existing) {
      if (existing.signature !== signature) return;
      if (existing.ack) post('ack', existing.ack);
      else schedule({ requestId: data.requestId, intent, request: existing, seq: data.seq });
      return;
    }
    if (requests.size >= 128) { post('ack', { requestId: data.requestId, ok: false, error: 'NAVIGATION_CAPACITY' }); return; }
    const request = { signature, ack: undefined, queued: false };
    requests.set(data.requestId, request);
    schedule({ requestId: data.requestId, intent, request, seq: data.seq });
  }
  target.addEventListener('message', message);
  const unsubscribe = ctx.sessions.list.subscribe(sessionChanged);
  const unsubscribeGeneration = ctx.connection.generation.subscribe(() => {
    if (!ctx.connection.generation.getSnapshot()) unavailable();
    void establish();
  });
  const boot = ctx.loader?.await?.() ?? Promise.resolve();
  void boot.then(() => establish(), () => post('error', { error: 'NATIVE_NOT_READY' }));
  ctx.effect(() => () => {
    disposed = true; ready = false;
    target.removeEventListener('message', message); unsubscribe(); unsubscribeGeneration();
    pendingNavigation = undefined;
    requests.clear(); target.__DSH_TRANSPORT__?.dispose?.();
  }, 'evimed.runtime-ui.bridge');
}
