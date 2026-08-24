/**
 * The live wire from a project's kernel to the browser's SSE stream.
 *
 * Hidden knowledge: nothing in this control plane used to open the kernel's
 * downlink. `DshRuntimeAdapter.watchSessions()` decoded it and was tested
 * against a scripted transport, but no production code ever constructed a
 * real one — so `run/event`, and everything a browser reads that only rides
 * `run/event` (the live transcript, tool calls, subagent starts), had no
 * publisher. `run/state` alone kept working because it is published from the
 * ledger's own state machine, not from the kernel's stream.
 *
 * The client here is hand-rolled over `http.request`'s own `upgrade` event —
 * the same primitive `requestRuntime` already uses for unix-socket and TCP
 * dialing — rather than Node's native `WebSocket`. That was not a style
 * choice: the native client threw an internal `TypeError` inside undici's own
 * close handler against this exact handshake (confirmed against
 * `mockDshRuntime.mjs` before writing this), and a live-event pipeline is the
 * wrong place to depend on an edge a stdlib client has not proven it handles.
 * `mockDshRuntime.mjs` hand-rolls the write side of the same frame format for
 * the same reason: sixteen lines of framing does not justify a dependency in
 * the control plane's request path, and here it does not justify one in the
 * control plane's socket path either.
 *
 * A dropped downlink reconnects rather than failing the run: `session.prompt`
 * and `session.history` are unary calls this pump never touches, so a run
 * keeps working from the request/response side even while this side is
 * between connections. What is lost during a gap is made whole again by the
 * transcript endpoint any (re)connecting tab reads first — this pump is the
 * addition for a tab that is already open, never the source of truth.
 *
 * @module dshEventPump
 */

import { randomBytes, createHash } from "node:crypto";
import { EventEmitter, on } from "node:events";
import http from "node:http";

import { DshRuntimeAdapter } from "./dshRuntimeAdapter.mjs";

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** How long to wait before retrying a dropped or refused downlink connection. */
export const RUNTIME_DOWNLINK_RECONNECT_MS = 2_000;

/**
 * @param {string} password
 * @returns {string}
 */
function basicAuth(password) {
  return `Basic ${Buffer.from(`:${password}`, "utf8").toString("base64")}`;
}

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
 * Opens one connection to a runtime's downlink and yields decoded JSON
 * frames until the peer closes it, it errors, or `signal` aborts.
 *
 * This is the `WireTransport.stream` half `DshRuntimeAdapter` has always
 * expected and never had a production implementation of. It ends cleanly
 * (no throw) on a peer close or on `signal` abort, and throws on a genuine
 * failure — a refused connection, a handshake that did not upgrade, an
 * undecodable frame — so a caller's reconnect loop can tell "try again" from
 * "stop".
 *
 * @param {{ url: string, socketPath?: string|null, password?: string|null }} runtime
 * @param {string} downlinkPath
 * @param {{ signal: AbortSignal }} options
 * @returns {AsyncGenerator<Record<string, any>>}
 */
export async function* openRuntimeDownlink(runtime, downlinkPath, { signal }) {
  if (signal.aborted) return;
  const target = new URL(downlinkPath, runtime.url);
  const key = randomBytes(16).toString("base64");
  /** @type {Record<string, string>} */
  const headers = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
  };
  if (runtime.password) headers.authorization = basicAuth(runtime.password);

  const request = runtime.socketPath
    ? http.request({ method: "GET", headers, socketPath: runtime.socketPath, path: `${target.pathname}${target.search}` })
    : http.request(target, { method: "GET", headers });

  const frames = new EventEmitter();
  // A second controller, not `signal` itself: a peer closing the socket ends
  // this generator so the caller's loop can reconnect, but it must not also
  // abort the caller's own signal, which governs whether to reconnect at all.
  const local = new AbortController();
  const stop = () => local.abort();
  signal.addEventListener("abort", stop, { once: true });
  // `EventEmitter` throws an emitted `"error"` that has no listener left to
  // catch it — and `on()` removes its internal listener the moment this
  // generator's own loop below exits. `request.destroy()` in the `finally`
  // block can still raise a deferred socket-hang-up after that point, so
  // every emit past teardown is dropped here rather than left to find out.
  let finished = false;

  /** @type {import("node:net").Socket | null} */
  let socket = null;
  request.once("error", (error) => {
    if (!finished) frames.emit("error", error);
  });
  request.once("response", (res) => {
    // The seam manifest's own contract for this path: a plain GET where a
    // WebSocket is expected answers 426, so anything else answering here
    // means the peer is not the kernel this pump was told to expect.
    if (!finished) frames.emit("error", new Error(`Runtime downlink answered HTTP ${res.statusCode} instead of upgrading.`));
    res.resume();
  });
  request.once("upgrade", (res, sock, head) => {
    socket = sock;
    const expectedAccept = createHash("sha1").update(`${key}${WS_ACCEPT_GUID}`).digest("base64");
    if (res.statusCode !== 101 || res.headers["sec-websocket-accept"] !== expectedAccept) {
      if (!finished) frames.emit("error", new Error("Runtime downlink handshake did not return the expected WebSocket accept."));
      sock.destroy();
      return;
    }
    const reader = new WebSocketFrameReader({
      onText: (text) => {
        try {
          frames.emit("frame", JSON.parse(text));
        } catch {
          // isolated: evimed_runtime_downlink_decode_failures_total — one
          // malformed frame must not end a connection every other frame on
          // it decodes fine.
        }
      },
      onPing: (payload) => {
        try {
          sock.write(encodeClientFrame(0xa, payload));
        } catch {
          // The socket is already gone; the close/error handler covers it.
        }
      },
      onClose: stop,
    });
    sock.on("data", (chunk) => {
      if (finished) return;
      try {
        // The socket is never put into a string encoding mode, so this is
        // always a Buffer in practice; the event's own type is the union
        // every `'data'` listener carries regardless.
        reader.push(/** @type {Buffer} */ (chunk));
      } catch (error) {
        frames.emit("error", error);
        sock.destroy();
      }
    });
    sock.once("close", stop);
    sock.once("error", (error) => {
      if (!finished) frames.emit("error", error);
    });
    // Bytes the server sent right after the 101 response arrive bundled into
    // this event rather than as a first `data` event — Node hands them back
    // once, here, and never replays them. A downlink that pushes a frame
    // before the handshake's own network round-trip completes (the common
    // case: kernel and control plane on the same host) would otherwise lose
    // exactly that frame, silently, every time.
    if (head?.length) reader.push(head);
  });
  request.end();

  try {
    for await (const [frame] of on(frames, "frame", { signal: local.signal })) yield frame;
  } catch (error) {
    if (local.signal.aborted && (!error || error.name === "AbortError")) return;
    throw error;
  } finally {
    finished = true;
    signal.removeEventListener("abort", stop);
    socket?.destroy();
    request.destroy();
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * @typedef {object} PumpProjectState
 * @property {AbortController} controller
 * @property {Map<string, string>} rootSessions - kernel sessionId -> run id, for a run's own top-level session
 * @property {Map<string, { runId: string, label: string, capability: string }>} childSessions - kernel sessionId -> owning run, for a subagent's session
 */

/**
 * Subscribes to each attached project's kernel downlink and republishes what
 * it decodes onto that run's SSE channel.
 *
 * One instance is shared across every project a server process serves, the
 * same way `RunEventHub` is: `attach`/`detach` mirror a runtime's own start
 * and stop, and `noteRun` mirrors the ledger's own state-change notification
 * — this class adds no lifecycle a caller does not already have a hook for.
 */
export class RuntimeEventPump {
  /**
   * @param {{ runEvents: import("./runEventStream.mjs").RunEventHub, isDshKernel: boolean, openDownlink?: typeof openRuntimeDownlink, reconnectDelayMs?: number }} options
   */
  constructor({ runEvents, isDshKernel, openDownlink = openRuntimeDownlink, reconnectDelayMs = RUNTIME_DOWNLINK_RECONNECT_MS }) {
    this.runEvents = runEvents;
    this.isDshKernel = isDshKernel;
    this.openDownlink = openDownlink;
    this.reconnectDelayMs = reconnectDelayMs;
    /** @type {Map<string, PumpProjectState>} */
    this.projects = new Map();
  }

  /** @param {{ userId: string, id: string }} project @returns {string} */
  #key(project) {
    return `${project.userId}:${project.id}`;
  }

  /**
   * Starts watching a project's runtime, once. A second attach for a project
   * already attached is a no-op — the runtime that is up is the runtime this
   * pump is already reading.
   * @param {{ userId: string, id: string }} project
   * @param {{ url: string, socketPath?: string|null, password?: string|null }} runtime
   */
  attach(project, runtime) {
    // The downlink and `decodeMuxFrame` are DSH's wire shapes; the OpenCode
    // kernel this build can still select publishes no such stream, and
    // dialing it would just be a permanent, silently-retrying connection
    // failure for no reader.
    if (!this.isDshKernel) return;
    const key = this.#key(project);
    if (this.projects.has(key)) return;
    const controller = new AbortController();
    /** @type {PumpProjectState} */
    const state = { controller, rootSessions: new Map(), childSessions: new Map() };
    this.projects.set(key, state);
    this.#run(project, runtime, state, controller.signal).catch(() => {
      // isolated: evimed_runtime_event_pump_fatal_total — the loop below
      // isolates every reconnect attempt already; reaching here at all means
      // it exited some other way, and neither the run's own state stream nor
      // its request/response calls depend on this pump.
    });
  }

  /** Stops watching a project's runtime and forgets its session map. @param {{ userId: string, id: string }} project */
  detach(project) {
    const key = this.#key(project);
    const state = this.projects.get(key);
    if (!state) return;
    state.controller.abort();
    this.projects.delete(key);
  }

  /**
   * Keeps a project's session map current. Called from the same hook that
   * already publishes `run/state` on every run transition, so a fresh run's
   * session becomes routable the moment the ledger knows it, and a finished
   * run's stops being routed rather than silently accepting a kernel session
   * id a later, unrelated run might reuse.
   * @param {{ userId: string, id: string }} project
   * @param {{ id: string, sessionId?: string, status: string }} run
   */
  noteRun(project, run) {
    const state = this.projects.get(this.#key(project));
    if (!state || !run?.sessionId) return;
    if (run.status === "running") state.rootSessions.set(run.sessionId, run.id);
    else state.rootSessions.delete(run.sessionId);
  }

  /**
   * @param {{ userId: string, id: string }} project
   * @param {{ url: string, socketPath?: string|null, password?: string|null }} runtime
   * @param {PumpProjectState} state
   * @param {AbortSignal} signal
   */
  async #run(project, runtime, state, signal) {
    const transport = {
      async call() {
        throw new Error("dshEventPump's transport does not support unary calls.");
      },
      stream: (path, options) => this.openDownlink(runtime, path, options),
    };
    const adapter = new DshRuntimeAdapter(transport);
    while (!signal.aborted) {
      try {
        for await (const { sessionId, event } of adapter.watchSessions({ signal })) {
          this.#handle(state, sessionId, event);
        }
        if (signal.aborted) return;
      } catch {
        // isolated: evimed_runtime_event_pump_reconnect_total — a dropped
        // downlink reconnects; it never fails the run, which does not read
        // through this pump for anything the request/response path needs.
      }
      await delay(this.reconnectDelayMs, signal);
    }
  }

  /**
   * @param {PumpProjectState} state
   * @param {string} sessionId
   * @param {import('@evimed/domain').RunEvent} event
   */
  #handle(state, sessionId, event) {
    const runId = state.rootSessions.get(sessionId) ?? state.childSessions.get(sessionId)?.runId;
    if (event.type === "subagent/started" && runId) {
      // Registered under the parent's run, one hop at a time: a
      // grandchild's own `subagent/started` arrives on the child's session,
      // which by then is already in this map, so nesting resolves without
      // the ledger ever having to enumerate it.
      state.childSessions.set(event.childSessionId, { runId, label: event.label, capability: event.capability });
    }
    if (!runId) return; // isolated: evimed_runtime_event_pump_unrouted_total
    this.runEvents.publish(runId, "run/event", { event });
    if (event.type === "turn/end") {
      // The one lifecycle fact the mux stream carries that `run/event` alone
      // does not surface as a status: nothing else marks a subagent's own
      // session as finished, running or otherwise.
      const child = state.childSessions.get(sessionId);
      if (child) {
        this.runEvents.publish(runId, "subagent/update", {
          childSessionId: sessionId,
          label: child.label,
          capability: child.capability,
          status: event.endKind,
        });
      }
    }
  }
}
