/** Policy-aware bridge for DSH's native open/cancel/item/error/end mux wire. */
import WebSocket, { WebSocketServer } from "ws";
import { connect } from "node:net";
import { HttpError } from "./security.mjs";

const MAX_STREAMS = 256;
const REVALIDATE_MS = 1000;

/** @param {WebSocket} peer @param {string | Buffer} data */
function send(peer, data) {
  return new Promise((resolve, reject) => {
    if (peer.readyState !== WebSocket.OPEN) return reject(new Error("Mux peer closed."));
    peer.send(data, { binary: false }, (error) => error ? reject(error) : resolve(undefined));
  });
}

/**
 * The caller reserves capacity and authenticates before dialing. No browser
 * headers are copied: the kernel receives only its own authority and cookie.
 *
 * @param {{ req: any, socket: any, head: Buffer, runtime: any, maxPayload: number,
 * revalidate: () => Promise<void>, authorize: (endpoint: string) => Promise<void> }} options
 */
export async function proxyRuntimeUiMux({ req, socket, head, runtime, maxPayload, revalidate, authorize }) {
  const target = new URL("/api/remote.mux", runtime.url);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const headers = { host: runtime.authority || target.host, ...(runtime.cookie ? { cookie: runtime.cookie } : {}) };
  const upstream = new WebSocket(target, {
    headers,
    createConnection: runtime.socketPath ? () => connect({ path: runtime.socketPath }) : undefined,
    maxPayload, perMessageDeflate: false, handshakeTimeout: 10_000,
  });
  /** @type {WebSocket | undefined} */
  let browser;
  let closed = false;
  /** @type {NodeJS.Timeout | undefined} */
  let validationTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let closeTimer;
  const terminate = () => { browser?.terminate(); upstream.terminate(); };
  const shutdown = (code = 1001, reason = "runtime_ui_closed") => {
    if (closed) return;
    closed = true;
    clearInterval(validationTimer);
    // A paused receiver must read the peer's close response as well.
    browser?.resume();
    upstream.resume();
    for (const peer of [browser, upstream]) {
      if (peer?.readyState === WebSocket.OPEN) peer.close(code, reason);
      else if (peer?.readyState === WebSocket.CONNECTING) peer.terminate();
    }
    closeTimer = setTimeout(terminate, 1000);
    closeTimer.unref();
  };
  socket.once("close", () => {
    shutdown();
    upstream.terminate();
    clearTimeout(closeTimer);
  });
  // ws handles protocol errors, including payload overflow, with the correct
  // close code. Preserve that close frame instead of destroying its socket.
  upstream.on("error", () => shutdown(1011, "runtime_unavailable"));
  upstream.on("close", () => shutdown(1001, "runtime_unavailable"));
  try {
    await new Promise((resolve, reject) => {
      upstream.once("open", () => resolve(undefined));
      upstream.once("error", () => reject(new HttpError(502, "runtime_unavailable", "Runtime mux unavailable.")));
      upstream.once("unexpected-response", (_request, response) => {
        response.resume();
        upstream.terminate();
        reject(new HttpError(502, "runtime_ui_upgrade_refused", "Runtime mux refused the handshake."));
      });
    });
    if (socket.destroyed) { terminate(); return; }
    // Runtime start and handshake can take seconds. Never admit a cookie that
    // expired, was logged out, or lost project access during that wait.
    await revalidate();
    const wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload, perMessageDeflate: false });
    wss.handleUpgrade(req, socket, head, (peer) => { browser = peer; });
    if (!browser) { shutdown(); return; }
  } catch (error) {
    shutdown();
    throw error;
  }

  const client = browser;
  const streams = new Set();
  let queuedBytes = 0;
  let queuedFrames = 0;
  let queue = Promise.resolve();
  let validating = false;

  const rejectStream = async (streamId, error) => {
    const known = error instanceof HttpError;
    await send(client, JSON.stringify({ type: "error", streamId, error: {
      code: known ? error.code : "runtime_ui_policy_failed",
      message: known ? error.message : "The runtime UI policy could not be verified.",
    } }));
    await send(client, JSON.stringify({ type: "end", streamId }));
  };
  async function dispatch(raw, binary) {
    if (closed) return;
    let frame;
    try { frame = binary ? null : JSON.parse(raw.toString()); } catch { frame = null; }
    if (!frame || !["open", "cancel"].includes(frame.type)
      || typeof frame.streamId !== "string" || !frame.streamId || frame.streamId.length > 128) {
      shutdown(1008, "runtime_ui_frame_invalid");
      return;
    }
    try {
      await revalidate();
    } catch (error) {
      await rejectStream(frame.streamId, error);
      shutdown(1008, "runtime_ui_authorization_revoked");
      return;
    }
    if (closed) return;
    if (frame.type === "open") {
      // A duplicate ID cannot receive an independent error: it aliases an
      // already active stream, so the malformed connection is refused.
      if (streams.has(frame.streamId)) { shutdown(1008, "runtime_ui_stream_duplicate"); return; }
      try {
        if (streams.size >= MAX_STREAMS) throw new HttpError(429, "runtime_ui_stream_limit", "Too many active mux streams.");
        await authorize(frame.endpoint);
      } catch (error) {
        await rejectStream(frame.streamId, error);
        return;
      }
      if (closed) return;
      streams.add(frame.streamId);
    }
    // Preserve endpoint payloads and cancellation semantics byte-for-byte.
    await send(upstream, raw);
    if (frame.type === "cancel") streams.delete(frame.streamId);
  }
  client.on("message", (raw, binary) => {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(/** @type {ArrayBuffer} */ (raw));
    queuedBytes += data.length;
    queuedFrames++;
    if (queuedBytes > maxPayload * 2 || queuedFrames > MAX_STREAMS) {
      shutdown(1009, "runtime_ui_queue_limit");
      return;
    }
    client.pause();
    queue = queue.then(() => dispatch(data, binary)).catch(() => shutdown(1011, "runtime_ui_proxy_failed")).finally(() => {
      queuedBytes -= data.length;
      queuedFrames--;
      if (!closed && queuedFrames === 0) client.resume();
    });
  });
  upstream.on("message", (raw, binary) => {
    if (closed) return;
    if (binary) { shutdown(1003, "runtime_ui_frame_invalid"); return; }
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "end" || frame.type === "error") streams.delete(frame.streamId);
    } catch { shutdown(1008, "runtime_ui_frame_invalid"); return; }
    if (client.bufferedAmount > maxPayload * 2) { shutdown(1009, "runtime_ui_queue_limit"); return; }
    upstream.pause();
    void send(client, /** @type {Buffer} */ (raw)).then(() => {
      if (!closed) upstream.resume();
    }).catch(() => shutdown(1011, "runtime_ui_proxy_failed"));
  });
  client.on("error", () => shutdown(1008, "runtime_ui_frame_invalid"));
  client.on("close", () => shutdown());
  validationTimer = setInterval(() => {
    if (closed || validating) return;
    validating = true;
    void revalidate().catch(() => shutdown(1008, "runtime_ui_authorization_revoked")).finally(() => { validating = false; });
  }, REVALIDATE_MS);
  validationTimer.unref();
}
