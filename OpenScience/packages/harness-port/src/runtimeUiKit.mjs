/**
 * The frame kit: what every frame body shares, built once per page.
 *
 * Hidden knowledge: the frame bodies reach the browser as source text. The
 * socket's build serializes each function in a body's `parts` with
 * `toString()` and wraps them in one closure, so nothing in them may refer to a
 * module import or to anything outside the listed functions (the kernel's
 * loader evaluates the text on another origin, where this module does not
 * exist). That rule used to be kept by keeping one 340-line function; it is
 * kept now by construction — every helper here is a named function declaration
 * listed in `KIT_PARTS`, and a test evaluates the emitted text in an empty
 * context, so a helper that closes over an import fails there and not in a
 * researcher's browser.
 *
 * What the kit carries, and why it is one object instead of five copies:
 *
 *  - the validated bootstrap object (`__EVIMED_FRAME__`), and the operator flag
 *    and body switches it carries;
 *  - React, from the loader's `require` — the kernel's own copy, never a
 *    second one;
 *  - `occupy`, the one registration path, which refuses a slot misuse loudly
 *    before the kernel can refuse it silently, and `shadowed`, the row a
 *    takeover draws before what it adds;
 *  - the hub: the in-frame channel between the navigation bridge (which owns
 *    the postMessage transport and its sequence counter) and the bodies that
 *    render what the shell sends in — theme, the bound run's progress, query
 *    answers;
 *  - the readers of what a tool call carries: arguments that may still be
 *    streaming, and results rendered as text (`ok\n<JSON>` /
 *    `failed: <code>\n- (<severity>) <code> <message>`), never bare JSON.
 *
 * @module @evimed/harness-port/runtime-ui-kit
 */

/**
 * The control plane's bootstrap object, validated, or null when this page is
 * not one the control plane served.
 *
 * Validated rather than trusted field by field: the bodies render from it, and
 * a malformed field must cost that field, not the page.
 *
 * @param {any} value
 * @returns {any}
 */
export function validFrame(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const capabilities = (Array.isArray(value.capabilities) ? value.capabilities : [])
    .filter((/** @type {any} */ entry) => entry && typeof entry.id === 'string' && entry.id
      && typeof entry.title === 'string' && entry.title
      && typeof entry.category === 'string'
      && typeof entry.brief === 'string' && entry.brief && entry.brief.length <= 100_000)
    .slice(0, 48)
    .map((/** @type {any} */ entry) => ({
      id: entry.id,
      title: entry.title,
      category: entry.category,
      brief: entry.brief,
      summary: typeof entry.summary === 'string' ? entry.summary.slice(0, 400) : '',
      minutes: Array.isArray(entry.minutes) && entry.minutes.length === 2
        && entry.minutes.every((/** @type {unknown} */ minute) => Number.isInteger(minute) && Number(minute) > 0)
        ? [Number(entry.minutes[0]), Number(entry.minutes[1])] : null,
      starters: (Array.isArray(entry.starters) ? entry.starters : [])
        .filter((/** @type {unknown} */ line) => typeof line === 'string' && line).slice(0, 3).map((/** @type {string} */ line) => line.slice(0, 400)),
      outputs: (Array.isArray(entry.outputs) ? entry.outputs : [])
        .filter((/** @type {unknown} */ line) => typeof line === 'string' && line).slice(0, 4).map((/** @type {string} */ line) => line.slice(0, 200)),
      limits: (Array.isArray(entry.limits) ? entry.limits : [])
        .filter((/** @type {unknown} */ line) => typeof line === 'string' && line).slice(0, 4).map((/** @type {string} */ line) => line.slice(0, 300)),
      materials: typeof entry.materials === 'string' ? entry.materials.slice(0, 200) : '',
      internal: entry.visibility === 'internal',
      // A capability opened by its own module (「循证 GEO」): its chip still
      // renders for a session bound to it, and it is not offered in the list.
      listed: entry.listed !== false,
    }));
  const off = (Array.isArray(value.off) ? value.off : [])
    .filter((/** @type {unknown} */ name) => typeof name === 'string' && /^[a-z]{1,32}$/.test(name));
  return {
    version: 1,
    frameId: typeof value.frameId === 'string' ? value.frameId : '',
    projectId: typeof value.projectId === 'string' ? value.projectId : '',
    shellOrigin: typeof value.shellOrigin === 'string' ? value.shellOrigin : '',
    cwd: value.cwd,
    operator: value.operator === true,
    off,
    capabilities,
  };
}

/**
 * The in-frame channel between the bridge and the bodies.
 *
 * The bridge attaches the transport (it owns the sequence counter the shell
 * validates, so a second sender would have every message dropped as a
 * replay) and delivers what the shell sends in. A body sends through the hub
 * and reads the latest state from it; with no bridge attached a send reports
 * `false` and a request rejects at once, which is exactly what a body switched
 * off must look like to the others.
 *
 * @param {any} target the browser global, for timers
 */
export function createHub(target) {
  /** @type {((type: string, fields: Record<string, any>) => void) | null} */
  let transport = null;
  /** @type {Map<string, Set<(data: any) => void>>} */
  const listeners = new Map();
  /** @type {Set<() => void>} */
  const stateListeners = new Set();
  /** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void, timer: any }>} */
  const pending = new Map();
  /** @type {{ theme: any, runState: any, session: any, evidence: any, replyChecks: any }} */
  let state = Object.freeze({ theme: null, runState: null, session: null, evidence: null, replyChecks: null });
  let sequence = 0;
  // Timers are looked up when a request is made, not when the hub is built:
  // the hub exists on every page the loader evaluates, including contexts
  // with no timer globals at all.
  /** @param {() => void} fn @param {number} ms */
  const setTimer = (fn, ms) => {
    const schedule = target?.setTimeout ?? globalThis.setTimeout;
    return typeof schedule === 'function' ? schedule.call(target ?? globalThis, fn, ms) : null;
  };
  /** @param {any} timer */
  const clearTimer = (timer) => {
    const cancel = target?.clearTimeout ?? globalThis.clearTimeout;
    if (timer != null && typeof cancel === 'function') cancel.call(target ?? globalThis, timer);
  };
  /** @param {Record<string, any>} patch */
  function publish(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...stateListeners]) {
      try { listener(); } catch (error) { target?.console?.error?.('[evimed-frame] state listener failed:', error); }
    }
  }
  return {
    /** @param {(type: string, fields: Record<string, any>) => void} send @returns {() => void} */
    attach(send) {
      transport = send;
      return () => {
        if (transport !== send) return;
        transport = null;
        for (const [id, entry] of pending) {
          clearTimer(entry.timer);
          entry.reject(new Error('frame channel closed'));
          pending.delete(id);
        }
      };
    },
    get attached() { return transport !== null; },
    /** @param {string} type @param {Record<string, any>} [fields] @returns {boolean} */
    send(type, fields = {}) {
      if (!transport) return false;
      transport(type, fields);
      return true;
    },
    /**
     * One question to the shell and its answer, correlated by request id.
     * @param {string} type @param {Record<string, any>} fields @param {number} [timeoutMs]
     * @returns {Promise<any>}
     */
    request(type, fields, timeoutMs = 8000) {
      if (!transport) return Promise.reject(new Error('frame channel unavailable'));
      const requestId = `r${Date.now().toString(36)}${(++sequence).toString(36)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          pending.delete(requestId);
          reject(new Error('frame request timed out'));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        transport?.(type, { ...fields, requestId });
      });
    },
    /**
     * What the shell sent, handed over by the bridge after it validated the
     * envelope. `theme`, `run-state`, `session`, `evidence` and `reply-check`
     * are kept as state; an answer carrying a request id settles that request.
     * @param {string} type @param {any} data
     */
    deliver(type, data) {
      if (type === 'theme') publish({ theme: data });
      else if (type === 'run-state') publish({ runState: data });
      else if (type === 'session') publish({ session: data });
      else if (type === 'evidence') publish({ evidence: data });
      else if (type === 'reply-check') publish({ replyChecks: data });
      const requestId = data && typeof data.requestId === 'string' ? data.requestId : null;
      if (requestId && pending.has(requestId)) {
        const entry = pending.get(requestId);
        pending.delete(requestId);
        clearTimer(entry?.timer);
        entry?.resolve(data);
      }
      for (const listener of [...(listeners.get(type) ?? [])]) {
        try { listener(data); } catch (error) { target?.console?.error?.(`[evimed-frame] ${type} listener failed:`, error); }
      }
    },
    /** @param {string} type @param {(data: any) => void} listener @returns {() => void} */
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => { set.delete(listener); };
    },
    getState() { return state; },
    /** @param {() => void} listener @returns {() => void} */
    subscribe(listener) {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
  };
}

/**
 * A socket tool's result as the pinned kernel renders it into a session's
 * history: `ok` and the data as two-space-indented JSON, or `failed: <code>`
 * with one `- (<severity>) <code> <message>` line per issue. Older fixtures
 * wrote `{ ok, data }` JSON, which is read too; an MCP tool's bare JSON (no
 * `ok`) is not a socket result and reads as null.
 *
 * Mirrors `socketToolResult` in the control plane (dshRuntimeAdapter.mjs),
 * which three readers once got wrong by parsing bare JSON only and finding
 * nothing on a live run; the kit's tests hold the same verbatim samples.
 *
 * @param {unknown} output
 * @returns {{ ok: true, data: any, issues?: { severity: string, code: string, message: string }[] } | { ok: false, code: string, issues: { severity: string, code: string, message: string }[] } | null}
 */
export function parseToolText(output) {
  if (typeof output !== 'string') return null;
  const text = output.replace(/^\s+/, '');
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') return null;
      return value.ok
        ? { ok: true, data: value.data ?? null }
        : { ok: false, code: String(value.code ?? 'failed'), issues: Array.isArray(value.issues) ? value.issues : [] };
    } catch {
      return null;
    }
  }
  const newline = text.indexOf('\n');
  const head = (newline < 0 ? text : text.slice(0, newline)).trim();
  const body = newline < 0 ? '' : text.slice(newline + 1);
  if (head === 'ok') {
    // An accepted result can carry issue lines after its data (a submission's
    // notes and its review's findings); they are split off before the JSON is
    // read, as the control plane's reader does.
    const lines = body.split('\n');
    /** @type {{ severity: string, code: string, message: string }[]} */
    const trailing = [];
    while (lines.length) {
      const issue = /^- \(([^)]+)\) (\S+)(?: (.*))?$/.exec(String(lines[lines.length - 1]).trim());
      if (!issue) break;
      trailing.unshift({ severity: issue[1], code: issue[2], message: issue[3] ?? '' });
      lines.pop();
    }
    const rest = lines.join('\n');
    if (!rest.trim()) return { ok: true, data: null, ...(trailing.length ? { issues: trailing } : {}) };
    try { return { ok: true, data: JSON.parse(rest), ...(trailing.length ? { issues: trailing } : {}) }; } catch { return { ok: true, data: body }; }
  }
  const failed = /^failed:\s*([A-Za-z0-9_.:-]+)/.exec(head);
  if (!failed) return null;
  /** @type {{ severity: string, code: string, message: string }[]} */
  const issues = [];
  for (const line of body.split('\n')) {
    const issue = /^- \(([^)]+)\) (\S+)(?: (.*))?$/.exec(line.trim());
    if (issue) issues.push({ severity: issue[1], code: issue[2], message: issue[3] ?? '' });
  }
  return { ok: false, code: failed[1], issues };
}

/**
 * Everything a tool view needs from the kernel's frozen call node, in one read.
 *
 * A running call carries `argsRaw` that is still growing and no result; a
 * settled one carries the call head (or null when a window cut left it out)
 * and its content blocks.
 *
 * @param {any} block `RunningToolCall | ToolResultNode`
 */
export function toolCallState(block) {
  const settled = Boolean(block && block.kind === 'tool-result');
  const argsRaw = String((settled ? block?.call?.argsRaw : block?.argsRaw) ?? '');
  /** @type {any} */
  let args = null;
  try {
    const parsed = argsRaw ? JSON.parse(argsRaw) : null;
    args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { args = null; }
  const parts = [];
  if (settled) {
    for (const item of Array.isArray(block.content) ? block.content : []) {
      if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    }
  }
  const text = parts.join('\n');
  const stopped = settled && block?.error?.code === 'interrupted';
  return {
    settled,
    running: !settled,
    argsRaw,
    args,
    text,
    result: settled ? parseToolText(text) : null,
    isError: settled && block.isError === true,
    stopped,
    /** When the call began, in epoch ms, or null when the window cut it. */
    startedAt: settled ? (Number.isFinite(block.callTime) ? Number(block.callTime) : null) : (Number.isFinite(block?.time) ? Number(block.time) : null),
    /** When the result landed, in epoch ms, or null while running. */
    settledAt: settled && Number.isFinite(block.time) ? Number(block.time) : null,
  };
}

/**
 * One string field of a JSON object that may still be arriving.
 *
 * The model streams a call's arguments; while it does, `argsRaw` is a prefix
 * that does not parse. A card that waits for the whole object shows nothing
 * for the first seconds of every call, which is when a reader looks at it.
 *
 * @param {string} argsRaw @param {string} field
 * @returns {string | null}
 */
export function partialArgField(argsRaw, field) {
  const pattern = new RegExp(`"${field.replace(/[^A-Za-z0-9_]/g, '')}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = pattern.exec(String(argsRaw ?? ''));
  if (!match) return null;
  try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
}

/**
 * The kit itself.
 *
 * @param {any} ctx the socket plugin's native client context
 * @param {any} target the browser global
 * @param {((id: string) => any) | undefined} require the loader's module resolver
 * @param {any} vocabulary build-time data: slot contracts, phase and source-type labels, tool names
 */
export function createFrameKit(ctx, target, require, vocabulary) {
  const frame = validFrame(target?.__EVIMED_FRAME__);
  /** @type {any} */
  let react = null;
  // Only on a page the control plane served: outside one no body runs, and the
  // loader is not asked for anything.
  try { react = frame && typeof require === 'function' ? require('react') : null; } catch { react = null; }
  const h = react && typeof react.createElement === 'function' ? react.createElement : null;
  const hub = createHub(target);
  const slots = vocabulary && vocabulary.slots && typeof vocabulary.slots === 'object' ? vocabulary.slots : {};
  const warn = (/** @type {string} */ message, /** @type {unknown} */ error) => target?.console?.warn?.(`[evimed-frame] ${message}`, error);

  /**
   * The one way a body registers into a slot.
   *
   * Refuses a misuse synchronously and by name — the wrong option for the
   * slot's kind, a single-slot entry that would collide with the kernel's own
   * at priority 0, a shipped key taken over at the shipped priority, a slot
   * the pinned table does not know — because every one of those, left to the
   * kernel, was a registration that "succeeded" and rendered nothing.
   *
   * The kernel's own refusal is different: it can arrive later, inside the
   * `register()` of whichever entry declares the slot. Thrown there it would
   * break THAT entry — the chat view, the composer — so it is caught and
   * logged instead, and costs only this occupant.
   *
   * @param {{ slot: string, id?: string, key?: string, priority?: number, order?: number, select?: (owner: any) => any, locale?: string, inject?: any, label?: string | (() => string) }} spec
   * @param {any} Component
   * @returns {() => void}
   */
  function occupy(spec, Component) {
    const contract = slots[spec?.slot];
    if (!contract) throw new Error(`[evimed-frame] slot "${spec?.slot}" is not in the pinned slot table; read its contract before occupying it`);
    /** @type {Record<string, any>} */
    const options = { name: spec.slot };
    if (contract.kind === 'list') {
      if (typeof spec.id !== 'string' || !spec.id) throw new Error(`[evimed-frame] list slot "${spec.slot}" needs an id (a key registers nothing here)`);
      options.id = spec.id;
      if (spec.order !== undefined) options.order = spec.order;
    } else if (contract.kind === 'keyed') {
      if (typeof spec.key !== 'string' || !spec.key) throw new Error(`[evimed-frame] keyed slot "${spec.slot}" needs a key (an id registers nothing here)`);
      options.key = spec.key;
      const shipped = Array.isArray(contract.shippedKeys) && contract.shippedKeys.includes(spec.key);
      if (shipped && !(typeof spec.priority === 'number' && spec.priority < 0)) {
        throw new Error(`[evimed-frame] "${spec.key}" in "${spec.slot}" is held by a shipped entry at priority 0; a takeover needs a priority below 0`);
      }
    } else if (contract.kind === 'single') {
      if (!(typeof spec.priority === 'number' && spec.priority < 0)) {
        throw new Error(`[evimed-frame] single slot "${spec.slot}" needs a priority below 0, under the kernel's own occupant`);
      }
    } else if (contract.kind === 'chain') {
      if (typeof spec.select !== 'function') throw new Error(`[evimed-frame] chain slot "${spec.slot}" needs a select function`);
      options.select = spec.select;
    }
    if (typeof spec.priority === 'number') options.priority = spec.priority;
    if (spec.locale) options.locale = spec.locale;
    if (spec.inject) options.inject = spec.inject;
    if (spec.label) options.label = spec.label;
    return ctx.slots.inject(spec.slot, () => {
      try {
        return ctx.slots.register(options, Component);
      } catch (error) {
        warn(`${spec.slot}${options.key ? `[${options.key}]` : options.id ? `[${options.id}]` : ''} was refused by the kernel:`, error);
        return () => {};
      }
    });
  }

  /**
   * The component a takeover shadows: in a keyed slot, the entry for the same
   * key at the next priority above the takeover's own.
   *
   * A takeover renders what it shadows first and adds its own after it, so
   * two bodies can each add something after one kernel row — the reply check
   * and the delivered files both follow an answer — without either knowing
   * about the other, and with either switched off (or retired by the renderer
   * after a crash) the other still renders the kernel's own row. Read off the
   * slot ledger's `entries()`, the documented inspection surface.
   *
   * @param {string} slot @param {string} key @param {any} component the takeover's own component
   * @returns {any} the shadowed component, or null
   */
  function shadowed(slot, key, component) {
    const entries = typeof ctx.slots?.entries === 'function' ? ctx.slots.entries(slot) : [];
    const cell = (Array.isArray(entries) ? entries : []).filter((/** @type {any} */ entry) => entry && entry.options && entry.options.key === key);
    const own = cell.find((/** @type {any} */ entry) => entry.component === component);
    if (!own) return null;
    const floor = own.options.priority ?? 0;
    /** @type {any} */
    let next = null;
    for (const entry of cell) {
      const priority = entry.options.priority ?? 0;
      if (entry.component === component || priority <= floor) continue;
      if (!next || priority < (next.options.priority ?? 0)) next = entry;
    }
    return next ? next.component : null;
  }

  /**
   * Cosmetic work must never sink the bodies that share this bundle.
   * @template T @param {string} label @param {() => T} fn @returns {T | undefined}
   */
  function guarded(label, fn) {
    try { return fn(); } catch (error) { warn(`${label} unavailable:`, error); return undefined; }
  }

  /**
   * Services a body can live without, handed to it when they exist. A
   * required service that is absent parks the whole plugin; these must not.
   * @param {string[]} services @param {(scope: any) => void} body
   */
  function withServices(services, body) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(services, (/** @type {any} */ scope) => { guarded(`services ${services.join(', ')}`, () => body(scope)); });
      return;
    }
    if (services.every((name) => ctx[name] !== undefined)) guarded(`services ${services.join(', ')}`, () => body(ctx));
  }

  /**
   * The shell-provided state, as a React hook. Selectors must return a value
   * already in the state (or a primitive) — a fresh object per call would
   * re-render forever.
   * @param {(state: any) => any} selector
   */
  function useFrameState(selector) {
    const read = () => selector(hub.getState());
    return react.useSyncExternalStore(hub.subscribe, read, read);
  }

  return {
    frame,
    ours: frame !== null,
    operator: frame?.operator === true,
    /** @param {string} name */
    isOff(name) { return Boolean(frame && frame.off.includes(name)); },
    react,
    h,
    vocabulary: vocabulary ?? {},
    hub,
    occupy,
    guarded,
    withServices,
    useFrameState,
    shadowed,
    parseToolText,
    toolCallState,
    partialArgField,
  };
}

/**
 * Every function the kit's serialized form needs, in declaration order. The
 * build emits them as one closure returning `createFrameKit`.
 */
export const KIT_PARTS = Object.freeze([
  validFrame,
  createHub,
  parseToolText,
  toolCallState,
  partialArgField,
  createFrameKit,
]);
