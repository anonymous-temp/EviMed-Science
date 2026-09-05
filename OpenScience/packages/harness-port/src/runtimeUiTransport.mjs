/**
 * Browser-only official transport hooks. Keep the installer self-contained:
 * the control plane serializes it into the parser-blocking frame bootstrap.
 * No module import, browser fetch replacement, or Host-ownership claim is used.
 * @param {{version:number, frameId:string, projectId:string, prefix:string, shellOrigin:string}} frame
 * @param {any} target Browser global, injectable for the transport contract tests.
 */
export function installRuntimeUiTransport(frame, target = globalThis) {
  if (frame?.version !== 1 || !/^\/__evimed\/f\/[A-Za-z0-9_-]+\/$/.test(frame.prefix)
    || frame.prefix !== `/__evimed/f/${frame.frameId}/`) throw new Error('Invalid runtime frame');
  if (target.__DSH_TRANSPORT__) throw new Error('Runtime transport already installed');
  const origin = target.location.origin;
  const nativeFetch = target.fetch.bind(target);
  const streams = new Map();
  const MAX_STREAMS = 128;
  const MAX_ITEMS = 128;
  const MAX_BYTES = 2 * 1024 * 1024;
  /** @type {any} */ let carrier;
  /** @type {Promise<any> | undefined} */ let connecting;
  /** @type {(() => void) | undefined} */ let cancelConnect;
  let disposed = false;

  /** @param {string} message @param {any} [remote] */
  function failure(message, remote) {
    const error = new Error(message);
    Object.defineProperty(error, 'dshRemoteStreamFailure', {
      value: remote ? { kind: 'remote', code: remote.code, details: remote.details } : { kind: 'carrier' },
    });
    return error;
  }
  /** @param {string | URL} input @param {string} root */
  function scopedUrl(input, root) {
    const url = new URL(String(input), `${origin}/`);
    if (url.origin !== origin || url.username || url.password || url.hash) throw failure('Foreign runtime URL');
    const path = url.pathname.startsWith(frame.prefix) ? url.pathname.slice(frame.prefix.length - 1) : url.pathname;
    if (!path.startsWith(root) || /%2f|%5c|%2e|\\/i.test(url.pathname)) throw failure('Unscoped runtime URL');
    url.pathname = `${frame.prefix}${path.slice(1)}`;
    return url.href;
  }
  /** @param {any} error */
  function failAll(error) {
    for (const stream of streams.values()) stream.fail(error);
  }
  /** @param {any} socket @param {any} error */
  function lose(socket, error) {
    if (carrier !== socket) return;
    carrier = undefined;
    connecting = undefined;
    const cancel = cancelConnect;
    cancelConnect = undefined;
    failAll(error);
    socket.close();
    cancel?.();
  }
  /** @param {any} socket @param {any} message */
  function send(socket, message) {
    const bytes = JSON.stringify(message);
    if (bytes.length > MAX_BYTES || socket.bufferedAmount > MAX_BYTES || socket.readyState !== 1) {
      const error = failure('Runtime carrier send limit');
      lose(socket, error);
      throw error;
    }
    try { socket.send(bytes); } catch {
      const error = failure('Runtime carrier send failed'); lose(socket, error); throw error;
    }
  }
  /** @param {any} value */
  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  /** @param {any} value @param {string[]} fields */
  function exact(value, fields) {
    return record(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
  }
  function connect() {
    if (disposed) return Promise.reject(failure('Runtime frame disposed'));
    if (carrier?.readyState === 1) return Promise.resolve(carrier);
    if (connecting) return connecting;
    const url = new URL(`${frame.prefix}api/remote.mux`, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new target.WebSocket(url.href);
    carrier = socket;
    connecting = new Promise((resolve, reject) => {
      const timer = target.setTimeout(() => stop(failure('Runtime carrier connection timeout')), 10_000);
      let opened = false;
      /** @param {any} error */
      function stop(error) {
        target.clearTimeout(timer);
        if (carrier === socket) {
          connecting = undefined;
          cancelConnect = undefined;
          lose(socket, error);
        }
        if (!opened) reject(error);
      }
      cancelConnect = () => stop(failure('Runtime frame disposed'));
      socket.addEventListener('open', () => {
        if (carrier !== socket || disposed) return;
        opened = true;
        target.clearTimeout(timer);
        connecting = undefined;
        cancelConnect = undefined;
        resolve(socket);
      });
      socket.addEventListener('error', () => stop(failure('Runtime carrier connection failed')));
      socket.addEventListener('close', () => stop(failure('Runtime carrier closed')));
      socket.addEventListener('message', (/** @type {any} */ event) => {
        if (carrier !== socket) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > MAX_BYTES) throw failure('Runtime carrier frame limit');
          const message = JSON.parse(event.data);
          const validId = record(message) && typeof message.streamId === 'string' && message.streamId.length > 0;
          const item = message?.type === 'item' && (exact(message, ['type', 'streamId']) || exact(message, ['type', 'streamId', 'value']));
          const end = message?.type === 'end' && exact(message, ['type', 'streamId']);
          const remoteError = message?.type === 'error' && exact(message, ['type', 'streamId', 'error'])
            && exact(message.error, ['code', 'message', 'details'])
            && typeof message.error.code === 'string' && typeof message.error.message === 'string' && record(message.error.details);
          if (!validId || (!item && !end && !remoteError)) throw failure('Malformed runtime carrier frame');
          streams.get(message.streamId)?.push(message, event.data.length);
        } catch { stop(failure('Malformed runtime carrier frame')); }
      });
    });
    return connecting;
  }
  const NativeEventSource = target.EventSource;
  if (NativeEventSource) {
    target.EventSource = class extends NativeEventSource {
      /** @param {string | URL} input @param {any} options */
      constructor(input, options) {
        const url = new URL(String(input), `${origin}/`);
        super(url.origin === origin && url.pathname === '/plugins/events'
          ? scopedUrl(url, '/plugins/') : input, options);
      }
    };
  }
  const hooks = {
    /** @param {URL} input @param {any} init */
    async fetch(input, init) {
      if (disposed) throw failure('Runtime frame disposed');
      return nativeFetch(scopedUrl(input, '/api/'), { ...init, credentials: 'same-origin', redirect: 'error' });
    },
    /** @param {string} input */
    async loadBundle(input) {
      if (disposed) throw failure('Runtime frame disposed');
      const src = scopedUrl(input, '/plugins/');
      await new Promise((resolve, reject) => {
        const script = target.document.createElement('script');
        const timer = target.setTimeout(() => finish(failure('Runtime bundle timeout')), 15_000);
        /** @param {any} [error] */
        function finish(error) {
          target.clearTimeout(timer); script.onload = null; script.onerror = null;
          if (error) { script.remove?.(); reject(error); } else resolve(undefined);
        }
        script.src = src; script.async = true;
        script.onload = () => finish(); script.onerror = () => finish(failure('Runtime bundle unavailable'));
        target.document.head.appendChild(script);
      });
    },
    /** @param {string} endpoint @param {any} payload @param {AbortSignal} signal */
    async *openStream(endpoint, payload, signal) {
      if (signal.aborted) throw signal.reason;
      if (disposed || streams.size >= MAX_STREAMS) throw failure('Runtime stream capacity');
      if (!/^(?:\$events|[A-Za-z][A-Za-z0-9-]*\/[A-Za-z][A-Za-z0-9_-]*)$/.test(endpoint)) throw failure('Invalid runtime endpoint');
      const id = target.crypto.randomUUID();
      /** @type {any[]} */ const queue = [];
      let queuedBytes = 0;
      /** @type {any} */ let error;
      let failed = false;
      /** @type {(() => void) | undefined} */ let wake;
      /** @type {any} */ let socket;
      let opened = false;
      let terminal = false;
      const inbox = {
        /** @param {any} reason */
        fail(reason) { failed = true; error = reason; queue.length = 0; queuedBytes = 0; wake?.(); },
        /** @param {any} message @param {number} bytes */
        push(message, bytes) {
          if (failed || terminal) return;
          if (queue.length >= MAX_ITEMS || queuedBytes + bytes > MAX_BYTES) {
            lose(socket, failure('Runtime stream receive limit')); return;
          }
          queue.push({ message, bytes }); queuedBytes += bytes; wake?.();
        },
      };
      const abort = () => inbox.fail(signal.reason ?? failure('Runtime stream cancelled'));
      streams.set(id, inbox);
      signal.addEventListener('abort', abort, { once: true });
      try {
        // Race cancellation against physical connection establishment: an
        // aborted logical request must not wait for the carrier's timeout.
        const opening = connect();
        socket = carrier;
        socket = await new Promise((resolve, reject) => {
          const cancel = () => reject(signal.reason ?? failure('Runtime stream cancelled'));
          signal.addEventListener('abort', cancel, { once: true });
          opening.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
          if (signal.aborted) cancel();
        });
        if (signal.aborted) throw signal.reason;
        send(socket, { type: 'open', streamId: id, endpoint, payload }); opened = true;
        while (true) {
          if (failed) throw error;
          if (!queue.length) await new Promise(resolve => { wake = () => resolve(undefined); });
          wake = undefined;
          if (failed) throw error;
          const { message, bytes } = queue.shift(); queuedBytes -= bytes;
          if (message.type === 'item') { yield message.value; continue; }
          terminal = true;
          if (message.type === 'error') throw failure(message.error.message, message.error);
          return;
        }
      } finally {
        streams.delete(id); signal.removeEventListener('abort', abort);
        if (opened && !terminal && socket?.readyState === 1) send(socket, { type: 'cancel', streamId: id });
        if (endpoint === '$events' && socket) lose(socket, failure('Runtime event generation ended'));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; cancelConnect?.();
      if (carrier) lose(carrier, failure('Runtime frame disposed'));
    },
  };
  Object.defineProperty(target, '__DSH_TRANSPORT__', { value: Object.freeze(hooks) });
  target.addEventListener('pagehide', hooks.dispose, { once: true });
  return hooks;
}
