/**
 * One WebSocket to a runtime's kernel, carrying every logical stream on it.
 *
 * DSH 0.1.2 removed `/api/events.mux` and `/api/events.host` outright — the
 * ApiProxy interface they belonged to is gone — and replaced both with one
 * Gateway-owned WebSocket at `/api/remote.mux` that multiplexes independently
 * cancellable logical streams. Confirmed against a running 0.1.2-alpha.3
 * binary, not inferred: the old paths answer nothing and the new one answers
 * 401 without a cookie.
 *
 * The frame vocabulary, also transcribed from the live wire:
 *
 *   out  {"type":"open","streamId":<id>,"endpoint":<name>,"payload":{"args":{...}}}
 *        {"type":"cancel","streamId":<id>}
 *   in   {"type":"item","streamId":<id>,"value":<endpoint-owned>}
 *        {"type":"error","streamId":<id>,"error":{"code","message","details"}}
 *        {"type":"end","streamId":<id>}
 *
 * Two consequences the old single-stream downlink did not have. First, a
 * session's events arrive on the stream opened for that session, so the
 * session id is no longer *in* the frame — it is whatever we opened the stream
 * for, and this module is what remembers the pairing. Second, the host sends
 * WebSocket Ping control frames every two seconds and terminates a socket that
 * did not answer the previous one, so the pong path below is load-bearing
 * rather than politeness.
 *
 * The client stays hand-rolled over `http.request`'s `upgrade` event for the
 * reason the previous downlink recorded: Node's native `WebSocket` threw
 * inside undici's own close handler against this exact handshake, and a live
 * event pipeline is the wrong place to depend on an edge a stdlib client has
 * not proven it handles.
 *
 * @module dshMux
 */

import { randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The one WebSocket route carrying every Remote stream (0.1.2). */
export const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";

/** The Gateway-internal logical stream carrying forwarded host events. */
export const REMOTE_EVENT_STREAM_ENDPOINT = "$events";


/**
 * One masked client-to-server frame. Only pongs use this — nothing else on
 * this downlink writes back — but a pong must echo the ping's payload
 * exactly, and a client frame must be masked or a strict server may close on
 * it, so both rules live here rather than being approximated.
 *
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeClientFrame(opcode, payload) {
  const maskKey = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ maskKey[i % 4];
  /** @type {Buffer} */
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, maskKey, masked]);
}

/**
 * Decodes a byte stream into WebSocket frames, incrementally.
 *
 * A single `data` event carries no guarantee about how many frames — or how
 * much of one — it holds: a slow link can split one frame across several
 * chunks, and a fast one can coalesce several frames into a single chunk.
 * Handling only the second and assuming the first cannot happen is how a
 * parser passes every quick test and misdecodes the first frame that lands on
 * a chunk boundary in production.
 *
 * Fragmented text messages (a `FIN`-less frame followed by continuations) are
 * reassembled; control frames are unmasked-or-masked either way tolerated,
 * because nothing here needs an interoperability failure with a peer that
 * masked when the spec did not require it, only a correct decode.
 */
class WebSocketFrameReader {
  /**
   * @param {{ onText: (text: string) => void, onPing: (payload: Buffer) => void, onClose: () => void }} handlers
   */
  constructor({ onText, onPing, onClose }) {
    this.onText = onText;
    this.onPing = onPing;
    this.onClose = onClose;
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    /** @type {Buffer[] | null} */
    this.fragments = null;
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.#readOne();
      if (!frame) return;
      this.#dispatch(frame);
    }
  }

  /** @returns {{ fin: boolean, opcode: number, payload: Buffer } | null} */
  #readOne() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Runtime downlink sent a frame too large to decode.");
      len = Number(big);
      offset += 8;
    }
    /** @type {Buffer | null} */
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (maskKey) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  /** @param {{ fin: boolean, opcode: number, payload: Buffer }} frame */
  #dispatch({ fin, opcode, payload }) {
    if (opcode === 0x9) {
      this.onPing(payload);
      return;
    }
    if (opcode === 0xa) return; // pong: nothing here ever awaits one
    if (opcode === 0x8) {
      this.onClose();
      return;
    }
    if (opcode === 0x1 || opcode === 0x0) {
      this.fragments = this.fragments ? [...this.fragments, payload] : [payload];
      if (fin) {
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = null;
        this.onText(text);
      }
      return;
    }
    // Binary (0x2) or anything else: the protocol is JSON text only, so an
    // unrecognized opcode is dropped rather than guessed at.
  }
}

/**
 * One multiplexed connection. `open()` yields an endpoint's values until that
 * logical stream ends, errors, or its signal aborts; the socket itself outlives
 * any one of them.
 */
export class DshMux {
  /**
   * @param {{ url: string, socketPath?: string|null, cookie?: string|null, authority?: string|null }} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    /** @type {import("node:net").Socket | null} */
    this.socket = null;
    this.frames = new EventEmitter();
    // Node's default of ten would start warning at the eleventh concurrent
    // logical stream, and a run with subagents opens one per session.
    this.frames.setMaxListeners(0);
    this.closed = false;
    this.nextStreamId = 0;
    /** @type {Error | null} */
    this.failure = null;
  }

  /** @returns {string} */
  #mintStreamId() {
    this.nextStreamId += 1;
    return `s${this.nextStreamId}-${randomBytes(4).toString("hex")}`;
  }

  /**
   * Dials the mux and completes the WebSocket handshake.
   * @param {{ signal: AbortSignal }} options
   * @returns {Promise<void>}
   */
  async connect({ signal }) {
    if (signal.aborted) throw new Error("aborted before the mux was dialled");
    const target = new URL(REMOTE_STREAM_MUX_PATH, this.runtime.url);
    const key = randomBytes(16).toString("base64");
    /** @type {Record<string, string>} */
    const headers = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
    };
    // The kernel derives its cookie name from the `Host` header it receives,
    // so a cookie minted for a different authority is not a weaker credential
    // — it is a different cookie the kernel never looks for, and the request
    // reads as unauthenticated with nothing said about a name mismatch.
    if (this.runtime.cookie) headers.cookie = this.runtime.cookie;
    // Left to Node, which sets `Host` from the URL — the same value the cookie
    // was minted against. An override exists only for a caller that must dial
    // one address and be seen as another; setting it by hand in the ordinary
    // case would be a second copy of a value that must not diverge.
    if (this.runtime.authority) headers.host = this.runtime.authority;

    const request = this.runtime.socketPath
      ? http.request({ method: "GET", headers, socketPath: this.runtime.socketPath, path: `${target.pathname}${target.search}` })
      : http.request(target, { method: "GET", headers });

    await new Promise((resolve, reject) => {
      const onAbort = () => { request.destroy(new Error("aborted while dialling the mux")); };
      signal.addEventListener("abort", onAbort, { once: true });
      request.once("error", (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
      request.once("response", (res) => {
        signal.removeEventListener("abort", onAbort);
        res.resume();
        // 401 here is the whole 0.1.2 auth change arriving as a status code.
        // Saying so beats "the downlink did not upgrade", which is what an
        // unauthenticated 0.1.2 kernel looked like before the cookie existed.
        reject(new Error(
          res.statusCode === 401
            ? "Runtime mux refused the connection as unauthenticated (HTTP 401); the browser-session cookie is missing or was minted for another authority."
            : `Runtime mux answered HTTP ${res.statusCode} instead of upgrading.`,
        ));
      });
      request.once("upgrade", (res, sock) => {
        signal.removeEventListener("abort", onAbort);
        const expected = createHash("sha1").update(`${key}${WS_ACCEPT_GUID}`).digest("base64");
        if (res.statusCode !== 101 || res.headers["sec-websocket-accept"] !== expected) {
          sock.destroy();
          reject(new Error("Runtime mux handshake did not return the expected WebSocket accept."));
          return;
        }
        this.socket = sock;
        const reader = new WebSocketFrameReader({
          onText: (text) => {
            let frame;
            try {
              frame = JSON.parse(text);
            } catch {
              // isolated: evimed_runtime_mux_decode_failures_total — one
              // malformed frame must not end a socket every other frame on it
              // decodes fine.
              return;
            }
            const streamId = String(frame?.streamId ?? "");
            if (streamId) this.frames.emit(streamId, frame);
          },
          onPing: (payload) => {
            // Answered, not ignored: the host terminates a socket that did
            // not answer the previous ping, at two-second intervals.
            try { sock.write(encodeClientFrame(0xa, payload)); } catch { /* the close handler covers it */ }
          },
          onClose: () => this.#fail(new Error("Runtime mux closed by the peer.")),
        });
        sock.on("data", (chunk) => {
          try {
            reader.push(/** @type {Buffer} */ (chunk));
          } catch (error) {
            this.#fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
        sock.once("close", () => this.#fail(new Error("Runtime mux socket closed.")));
        sock.once("error", (error) => this.#fail(error));
        resolve(undefined);
      });
      request.end();
    });
  }

  /** @param {Error} error */
  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.frames.emit("mux:closed", error);
  }

  /** Closes the socket and ends every logical stream on it. */
  close() {
    this.#fail(new Error("Runtime mux closed by this control plane."));
    try { this.socket?.destroy(); } catch { /* already gone */ }
  }

  /** @param {Record<string, unknown>} message */
  #send(message) {
    if (!this.socket || this.closed) throw this.failure ?? new Error("Runtime mux is not connected.");
    this.socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify(message), "utf8")));
  }

  /**
   * Opens one logical stream and yields its values.
   *
   * Ends cleanly on the host's `end` frame or on `signal` abort, and throws on
   * an `error` frame or a socket failure — so a caller can tell "this stream
   * finished" from "this connection died", which one shared socket makes a
   * distinction worth keeping.
   *
   * @param {string} endpoint
   * @param {Record<string, unknown>} args
   * @param {{ signal: AbortSignal }} options
   * @returns {AsyncGenerator<any>}
   */
  async *open(endpoint, args, { signal }) {
    const streamId = this.#mintStreamId();
    /** @type {any[]} */
    const pending = [];
    /** @type {(() => void) | null} */
    let wake = null;
    /** @type {Error | null} */
    let error = null;
    let done = false;
    const nudge = () => { const w = wake; wake = null; w?.(); };
    const onFrame = (/** @type {Record<string, any>} */ frame) => {
      if (frame.type === "item") pending.push(frame.value);
      else if (frame.type === "end") done = true;
      else if (frame.type === "error") {
        const wire = frame.error ?? {};
        error = new Error(`mux stream ${endpoint} failed: ${wire.code ?? "unknown"}: ${wire.message ?? ""}`);
        /** @type {any} */ (error).code = wire.code;
      }
      nudge();
    };
    const onClosed = (/** @type {Error} */ cause) => { error = cause; nudge(); };
    const onAbort = () => { done = true; nudge(); };
    this.frames.on(streamId, onFrame);
    this.frames.once("mux:closed", onClosed);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.#send({ type: "open", streamId, endpoint, payload: { args } });
      for (;;) {
        while (pending.length > 0) yield pending.shift();
        if (error) throw error;
        if (done || signal.aborted) return;
        await new Promise((resolve) => { wake = () => resolve(undefined); });
      }
    } finally {
      this.frames.off(streamId, onFrame);
      this.frames.off("mux:closed", onClosed);
      signal.removeEventListener("abort", onAbort);
      // Cancelling a stream the socket already lost would throw over the
      // failure the caller is about to see.
      if (!this.closed) {
        try { this.#send({ type: "cancel", streamId }); } catch { /* the socket went away */ }
      }
    }
  }
}
