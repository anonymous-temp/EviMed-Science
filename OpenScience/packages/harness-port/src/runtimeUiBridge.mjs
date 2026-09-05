/** Native client services, injected only in the kernel's browser application. */
export const inject = ['sessions', 'conversation', 'connection'];

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
  let outgoing = 0;
  let incoming = 0;
  let ready = false;
  let activated = false;
  /** @type {string | null} */ let selectedSession = null;
  let disposed = false;
  let refreshing = false;
  /** @type {string | null | undefined} */ let previousSession;
  let actions = Promise.resolve();
  const requests = new Map();
  /** @param {string} type @param {any} [fields] */
  function post(type, fields = {}) {
    if (disposed) return;
    parent.postMessage({ type: `evimed.runtime-ui.${type}`, version: 1, frameId: frame.frameId,
      projectId: frame.projectId, seq: ++outgoing, ...fields }, frame.shellOrigin);
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
    if (!generation) { ready = false; return; }
    refreshing = true;
    ready = false;
    try {
      await ctx.sessions.refresh();
      if (disposed || ctx.connection.generation.getSnapshot() !== generation) return;
      if (activated && selectedSession) ctx.sessions.open(selectedSession);
      ready = true;
      post('ready'); sessionChanged();
    } catch { post('error', { error: 'NATIVE_NOT_READY' }); }
    finally {
      refreshing = false;
      if (!disposed && ctx.connection.generation.getSnapshot() && ctx.connection.generation.getSnapshot() !== generation) void establish();
    }
  }
  /** @param {any} event */
  function message(event) {
    if (disposed || !ready || event.source !== parent || event.origin !== frame.shellOrigin) return;
    const data = event.data;
    if (!data || data.type !== 'evimed.runtime-ui.navigate' || data.version !== 1
      || data.frameId !== frame.frameId || data.projectId !== frame.projectId
      || !Number.isSafeInteger(data.seq) || data.seq <= incoming
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
      return;
    }
    if (requests.size >= 128) { post('ack', { requestId: data.requestId, ok: false, error: 'NAVIGATION_CAPACITY' }); return; }
    /** @type {{ signature: string, ack: any }} */
    const request = { signature, ack: undefined };
    requests.set(data.requestId, request);
    actions = actions.then(async () => {
      if (disposed) return;
      try {
        let sessionId = intent.sessionId;
        if (intent.kind === 'create') sessionId = await ctx.sessions.create({ sessionId });
        else await ctx.sessions.refresh();
        if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new Error('Invalid native session identity');
        if (disposed) return;
        ctx.sessions.open(sessionId);
        if (intent.draft !== undefined) {
          const scope = ctx.sessions.scope(sessionId);
          if (!scope) throw new Error('Native session scope unavailable');
          ctx.conversation.input.for(scope).setDraft(intent.draft);
        }
        activated = true; selectedSession = sessionId; previousSession = sessionId;
        request.ack = { requestId: data.requestId, ok: true, sessionId };
      } catch { request.ack = { requestId: data.requestId, ok: false, error: 'NAVIGATION_FAILED' }; }
      post('ack', request.ack); sessionChanged();
    });
  }
  target.addEventListener('message', message);
  const unsubscribe = ctx.sessions.list.subscribe(sessionChanged);
  const unsubscribeGeneration = ctx.connection.generation.subscribe(() => {
    if (!ctx.connection.generation.getSnapshot()) ready = false;
    void establish();
  });
  const boot = ctx.loader?.await?.() ?? Promise.resolve();
  void boot.then(() => establish(), () => post('error', { error: 'NATIVE_NOT_READY' }));
  ctx.effect(() => () => {
    disposed = true; ready = false;
    target.removeEventListener('message', message); unsubscribe(); unsubscribeGeneration();
    requests.clear(); target.__DSH_TRANSPORT__?.dispose?.();
  }, 'evimed.runtime-ui.bridge');
}
