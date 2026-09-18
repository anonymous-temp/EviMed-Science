/** Native client services, injected only in the kernel's browser application. */
export const inject = ['sessions', 'conversation', 'connection', 'workspaces'];

/**
 * The frame's half of the channel to the hosted shell.
 *
 * It owns the one postMessage transport and the strictly increasing sequence
 * number the shell validates per frame — which is why the other frame bodies
 * talk to the shell through the kit's hub rather than posting themselves: a
 * second sender with its own counter would have every message dropped as a
 * replay.
 *
 * The vocabulary, both ways (`evimed.runtime-ui.<type>`, every message carrying
 * `version`, `frameId`, `projectId` and `seq`):
 *
 *   shell → frame  navigate · resume · theme · run-state · evidence · kb-result ·
 *                  search
 *   frame → shell  booted · ready · connecting · error · ack · session ·
 *                  shell-navigate · shell-shortcut · open-artifact · kb-query ·
 *                  search-result
 *
 * `session` carries the lineage the shell needs to keep its ledger and its URL
 * honest: `forkedFrom` when the researcher branched a finished turn into a new
 * session (the kernel's `session/fork`, which the hosted surface allows — the
 * control plane takes forks into the run ledger), and `subagent` with
 * `rootSessionId` when the view moved into a delegated child, whose address
 * is its parent's and which the shell must not treat as a task of its own.
 *
 * The body is self-contained for browser bundling. `apply` must return
 * synchronously: the gateway starts only after `loader.await()`.
 *
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global, injectable by the contract suite.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit; without one the bridge still navigates.
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  const frame = target.__EVIMED_FRAME__;
  if (!frame || frame.version !== 1 || target.parent === target) return;
  const parent = target.parent;
  const boundCwd = frame.cwd;
  const hub = kit && kit.hub ? kit.hub : null;
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
  /** @type {Map<string, AbortController>} */ const searches = new Map();
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
  const validId = (/** @type {unknown} */ value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
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
        if (!validId(sessionId)) throw new Error('Invalid native session identity');
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

  /**
   * Where the current session sits: a fork of another session, a delegated
   * child of one, or neither.
   *
   * Read off the kernel's own list rows (`parentId`, and `origin: 'subagent'`
   * for a delegated child) and, for a child, the catalogue address the kernel
   * navigated through — a child is addressed by its parent and is not a row of
   * the ordinary list. A fork is the other kind of child: same `parentId`, no
   * subagent origin.
   *
   * @param {any} snapshot @param {string} sessionId
   * @returns {{ forkedFrom?: string, subagent?: true, rootSessionId?: string }}
   */
  function lineageOf(snapshot, sessionId) {
    const byId = snapshot?.byId ?? {};
    const row = byId[sessionId];
    const address = snapshot?.currentAddress;
    const addressed = address && address.childSessionId === sessionId && validId(address.parentSessionId);
    if (addressed || row?.origin === 'subagent') {
      // Walk up to the session the researcher started, a few levels at most:
      // a child may delegate again, and a cycle in a corrupt list must not
      // hang the page.
      let root = addressed ? address.parentSessionId : row?.parentId;
      for (let depth = 0; depth < 8 && validId(root) && byId[root]?.origin === 'subagent' && validId(byId[root]?.parentId); depth++) {
        root = byId[root].parentId;
      }
      return validId(root) ? { subagent: true, rootSessionId: root } : { subagent: true };
    }
    if (row && validId(row.parentId) && row.parentId !== sessionId) return { forkedFrom: row.parentId };
    return {};
  }
  function sessionChanged() {
    if (!ready || !activated || disposed) return;
    const snapshot = ctx.sessions.list.getSnapshot();
    const sessionId = snapshot.current ?? null;
    if (sessionId === previousSession) return;
    previousSession = sessionId;
    selectedSession = sessionId;
    const lineage = sessionId === null ? {} : lineageOf(snapshot, sessionId);
    hub?.deliver('session', { sessionId, ...lineage });
    post('session', { sessionId, ...lineage });
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

  /**
   * A full-text search over this project's sessions, asked by the shell's own
   * task list (`session/search`, which the hosted surface allows). The kernel
   * answers from its message-content index; the list snapshot supplies the
   * titles, because a result carries only an id and a snippet.
   * @param {string} requestId @param {string} query
   */
  async function search(requestId, query) {
    searches.get(requestId)?.abort();
    const controller = new globalThis.AbortController();
    searches.set(requestId, controller);
    try {
      const result = typeof ctx.sessions.search === 'function'
        ? await ctx.sessions.search(query, controller.signal)
        : { ok: false, error: { code: 'search_unavailable' } };
      if (controller.signal.aborted) return;
      if (!result || !result.ok) {
        post('search-result', { requestId, ok: false, error: String(result?.error?.code ?? 'search_failed').slice(0, 80) });
        return;
      }
      const byId = ctx.sessions.list.getSnapshot().byId ?? {};
      const items = (Array.isArray(result.value?.items) ? result.value.items : [])
        .filter((/** @type {any} */ item) => validId(item?.sessionId))
        .slice(0, 20)
        .map((/** @type {any} */ item) => ({
          sessionId: item.sessionId,
          snippet: String(item.snippet ?? '').slice(0, 240),
          title: String(byId[item.sessionId]?.displayTitle ?? byId[item.sessionId]?.title ?? '').slice(0, 200),
        }));
      post('search-result', { requestId, ok: true, items, hasMore: result.value?.hasMore === true });
    } catch {
      if (!controller.signal.aborted) post('search-result', { requestId, ok: false, error: 'search_failed' });
    } finally {
      if (searches.get(requestId) === controller) searches.delete(requestId);
    }
  }

  /**
   * What the shell may put into the frame besides navigation, validated here
   * once so no body has to. Each returns the payload to deliver, or null to
   * drop the message.
   */
  const INBOUND = {
    /** @param {any} data */
    theme(data) {
      const preference = ['light', 'dark', 'system'].includes(data.preference) ? data.preference : null;
      const resolved = ['light', 'dark'].includes(data.resolved) ? data.resolved : null;
      return preference && resolved ? { preference, resolved } : null;
    },
    /** @param {any} data */
    'run-state'(data) {
      if (data.runId !== null && !validId(data.runId)) return null;
      // Bounded: this is another origin's payload, rendered by React only
      // (never as markup), and a runaway one must not stall the page.
      let size = 0;
      try { size = JSON.stringify(data).length; } catch { return null; }
      if (size > 512_000) return null;
      const { type: _type, version: _version, frameId: _frameId, projectId: _projectId, seq: _seq, ...rest } = data;
      return rest;
    },
    /**
     * The claims and sources behind the bound run's report, read by the shell
     * from the delivered evidence matrix. Large and rare, so it travels apart
     * from the run state that changes every few seconds.
     * @param {any} data
     */
    evidence(data) {
      if (data.runId !== null && !validId(data.runId)) return null;
      let size = 0;
      try { size = JSON.stringify(data).length; } catch { return null; }
      if (size > 1_000_000) return null;
      const { type: _type, version: _version, frameId: _frameId, projectId: _projectId, seq: _seq, ...rest } = data;
      return rest;
    },
    /** @param {any} data */
    'kb-result'(data) {
      if (typeof data.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.requestId)) return null;
      const items = (Array.isArray(data.items) ? data.items : []).slice(0, 50)
        .filter((/** @type {any} */ item) => item && typeof item.id === 'string' && /^src_[A-Za-z0-9_-]{1,120}$/.test(item.id))
        .map((/** @type {any} */ item) => ({
          id: item.id,
          title: String(item.title ?? '').slice(0, 300),
          detail: String(item.detail ?? '').slice(0, 300),
        }));
      return { requestId: data.requestId, ok: data.ok !== false, items };
    },
  };

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
    const kind = typeof data.type === 'string' && data.type.startsWith('evimed.runtime-ui.') ? data.type.slice('evimed.runtime-ui.'.length) : '';
    if (kind === 'search') {
      if (typeof data.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.requestId)
        || typeof data.query !== 'string' || !data.query.trim() || data.query.length > 200) return;
      incoming = data.seq;
      void search(data.requestId, data.query.trim());
      return;
    }
    if (Object.hasOwn(INBOUND, kind)) {
      const payload = INBOUND[/** @type {'theme' | 'run-state' | 'evidence' | 'kb-result'} */ (kind)](data);
      if (!payload) return;
      incoming = data.seq;
      hub?.deliver(kind, payload);
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
  /**
   * What the shell's own navigation is called, from inside the frame.
   *
   * A closed vocabulary, not a path: the frame is third-party-composed code on
   * its own origin, and a destination it could spell freely would be a
   * redirect it could choose. The shell maps each name to a route and ignores
   * anything else.
   */
  const SHELL_DESTINATIONS = ['new-task', 'runs', 'knowledge', 'memory', 'capabilities', 'account'];

  /**
   * The channel the frame bodies leave through.
   *
   * Placed on the global rather than posted directly by the bodies because this
   * bridge owns the sequence counter: the shell validates a strictly increasing
   * `seq` per frame, and a second sender with its own counter would have every
   * one of its messages dropped as a replay.
   */
  target.__EVIMED_SHELL__ = {
    /**
     * @param {string} destination one of `SHELL_DESTINATIONS`
     * @param {string} [draft] a brief to pre-fill the composer with. Only
     *   meaningful for `new-task`; the shell sends it back in as the
     *   navigation intent's draft. Bounded here as well as there, because this
     *   side runs third-party-composed code.
     */
    navigate(destination, draft = undefined) {
      if (typeof destination !== 'string' || !SHELL_DESTINATIONS.includes(destination)) return;
      if (draft !== undefined && (typeof draft !== 'string' || !draft || draft.length > 100_000)) return;
      post('shell-navigate', draft === undefined ? { destination } : { destination, draft });
    },
  };

  /**
   * What a body may send the shell through the hub, validated at the one exit.
   * The shell validates again: it cannot trust this side any more than this
   * side trusts it.
   */
  const OUTBOUND = {
    /** @param {any} fields */
    'open-artifact'(fields) {
      if (!validId(fields.runId) || typeof fields.path !== 'string' || !fields.path || fields.path.length > 1024
        || fields.path.startsWith('/') || fields.path.includes('\\')
        || fields.path.split('/').some((/** @type {string} */ part) => part === '..' || part === '.')) return null;
      const anchor = typeof fields.anchor === 'string' && /^[A-Za-z0-9_.:=-]{1,120}$/.test(fields.anchor) ? fields.anchor : undefined;
      return { runId: fields.runId, path: fields.path, ...(anchor ? { anchor } : {}) };
    },
    /** @param {any} fields */
    'kb-query'(fields) {
      if (typeof fields.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fields.requestId)) return null;
      return { requestId: fields.requestId, query: String(fields.query ?? '').slice(0, 200) };
    },
  };
  const detachHub = hub?.attach((/** @type {string} */ type, /** @type {any} */ fields) => {
    if (!Object.hasOwn(OUTBOUND, type)) return;
    const payload = OUTBOUND[/** @type {'open-artifact' | 'kb-query'} */ (type)](fields ?? {});
    if (payload) post(type, payload);
  });

  /**
   * The shell's three shortcuts, forwarded while focus is in this document
   * (2026-09-16 review, U8). The frame is another origin, so with focus here
   * the shell's own window listeners never hear a key — and the first click on
   * the chat page puts focus here. A closed set, and only keys the kernel left
   * unhandled: a key the application used for itself stays its own, and `?`
   * typed into a field is text.
   * @param {any} event
   */
  function keydown(event) {
    if (!event || event.defaultPrevented || event.altKey) return;
    const key = String(event.key ?? '');
    const modifier = Boolean(event.metaKey || event.ctrlKey);
    let shortcut = null;
    if (modifier && !event.shiftKey && key.toLowerCase() === 'k') shortcut = 'command-palette';
    else if (modifier && !event.shiftKey && key.toLowerCase() === 'b') shortcut = 'sidebar';
    else if (!modifier && key === '?') {
      const element = event.target;
      if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)) return;
      shortcut = 'shortcuts';
    }
    if (!shortcut) return;
    event.preventDefault();
    post('shell-shortcut', { shortcut });
  }

  target.addEventListener('message', message);
  target.addEventListener('keydown', keydown);
  const unsubscribe = ctx.sessions.list.subscribe(sessionChanged);
  const unsubscribeGeneration = ctx.connection.generation.subscribe(() => {
    if (!ctx.connection.generation.getSnapshot()) unavailable();
    void establish();
  });
  // Said at once, before the kernel's session list is read: the shell answers
  // with its theme, which is the difference between the first paint following
  // the reader's choice and following the deployment default until `ready`.
  post('booted');
  const boot = ctx.loader?.await?.() ?? Promise.resolve();
  void boot.then(() => establish(), () => post('error', { error: 'NATIVE_NOT_READY' }));
  ctx.effect(() => () => {
    disposed = true; ready = false;
    target.removeEventListener('message', message); target.removeEventListener('keydown', keydown);
    unsubscribe(); unsubscribeGeneration();
    detachHub?.();
    for (const controller of searches.values()) controller.abort();
    searches.clear();
    pendingNavigation = undefined;
    if (target.__EVIMED_SHELL__) delete target.__EVIMED_SHELL__;
    requests.clear(); target.__DSH_TRANSPORT__?.dispose?.();
  }, 'evimed.runtime-ui.bridge');
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'bridge', inject, parts: Object.freeze([apply]) });
