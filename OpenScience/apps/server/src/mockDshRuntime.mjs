/**
 * A fake agent kernel that speaks the real wire protocol.
 *
 * Hidden knowledge: what a kernel looks like from the control plane's side.
 * The point of it is not to simulate an agent — it is to let the entire server
 * test suite exercise the *adapter*, the ledger, the delivery decision and the
 * event stream against the protocol they will meet in production, without a
 * container, a model, or a network.
 *
 * That the previous kernel already had one of these is why swapping kernels was
 * tractable at all: the runtime layer had been proven to hold more than one
 * implementation before it had to.
 *
 * Everything below is DSH 0.1.2-alpha.3's wire, established by booting the real
 * binary and probing it rather than read off a type declaration:
 *
 * - `POST /api/<slashed/endpoint>` with `{type:"client-request", rpcId, method,
 *   payload:{args:{…}}}`; the dotted 0.1.1 spelling is a 404, not an error
 *   envelope, so the mock 404s it too;
 * - one WebSocket at `/api/remote.mux` carrying `open`/`cancel` from the client
 *   and `item`/`error`/`end` back, with the logical stream id as the only
 *   routing key;
 * - `$events`, `session/follow` and `workspace/follow` as stream endpoints —
 *   `/api/events.mux` and `/api/events.host` are gone with the rest of ApiProxy;
 * - **a cookie on every request, loopback included.**
 *
 * That last one is the reason this file refuses rather than tolerates. 0.1.1
 * needed no credential and 0.1.2 answers 401 without one; a mock that stayed
 * permissive would let every test in this suite pass against a control plane
 * that sends nothing, and the first thing to find out would be a container in
 * production. So the mock verifies the cookie with its own HMAC — not by
 * calling the minting code back, which would only prove the minter agrees with
 * itself — and answers `401 unauthorized`, the same status and body the live
 * kernel does.
 *
 * It produces a session event log — turn, step, user message, tool call, tool
 * result, assistant message, turn end — rather than a message list, because
 * that is what the adapter has to normalize.
 *
 * @module mockDshRuntime
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { browserSessionCookie } from "./dshBrowserAuth.mjs";

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The one WebSocket route carrying every Remote stream in 0.1.2. */
export const MOCK_MUX_PATH = "/api/remote.mux";

/**
 * The host pings every two seconds and terminates a socket that did not answer
 * the previous one. Reproduced rather than dropped: a mock that never pinged
 * would let a client with no pong path look healthy for as long as any test
 * cares to watch it, and the failure in production is a socket that dies every
 * two seconds with nothing said about why.
 */
export const MOCK_PING_INTERVAL_MS = 2_000;

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Record<string, any>>}
 */
async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4 * 1024 * 1024) return {};
    chunks.push(buffer);
  }
  if (!bytes) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** @param {Buffer} value @returns {string} */
function base64url(value) {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** @param {string} text @returns {Buffer} */
function fromBase64url(text) {
  const padded = String(text).replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * The kernel's own check, written out here instead of imported.
 *
 * Verifying with the minting module would prove only that the minter agrees
 * with itself; the point of the mock is to be a second implementation of the
 * same rule, so a change on one side shows up as a 401 rather than as two
 * modules quietly agreeing on a format the kernel does not accept.
 *
 * @param {{ secret: string, authority: string, cookieHeader: string | undefined, now?: number }} input
 * @returns {boolean}
 */
export function mockAcceptsBrowserSession({ secret, authority, cookieHeader, now = Date.now() }) {
  const host = String(authority ?? "").trim();
  if (!host || !cookieHeader) return false;
  const name = `dsh-auth-${base64url(createHash("sha256").update(host).digest())}`;
  /** @type {string | null} */
  let value = null;
  for (const pair of String(cookieHeader).split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    value = pair.slice(index + 1).trim();
  }
  if (!value) return false;
  const [version, body, signature] = value.split(".");
  if (version !== "v1" || !body || !signature) return false;
  const expected = base64url(createHmac("sha256", fromBase64url(secret)).update(body).digest());
  const got = Buffer.from(signature, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  /** @type {Record<string, any>} */
  let payload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return false;
  }
  if (payload?.version !== 1) return false;
  // The authority binding the live kernel enforces: a cookie signed for another
  // host is not a weaker credential, it is a different one.
  if (String(payload.authority) !== host) return false;
  return Number(payload.expiresAt) > now;
}

/**
 * Starts the fake kernel.
 *
 * @param {{ pingIntervalMs?: number }} [options]
 * @returns {Promise<{ url: string, authority: string, secret: string, cookie: string, close: () => Promise<void> }>}
 */
export function startMockDshRuntime(options = {}) {
  const pingIntervalMs = Number(options.pingIntervalMs ?? MOCK_PING_INTERVAL_MS);
  // The kernel reads this out of `$DSH_HOME/.credentials.yaml`; here it is just
  // held in memory and handed back to the caller, never logged.
  const secret = base64url(randomBytes(32));

  /** @type {Map<string, { id: string, cwd: string, agentPreset: string, events: Record<string, any>[], seq: number, running: boolean, createdAt: number, updatedAt: number }>} */
  const sessions = new Map();

  /**
   * @typedef {object} MuxConnection
   * @property {import("node:stream").Duplex} socket
   * @property {Map<string, { endpoint: string, sessionId: string | null }>} streams
   * @property {boolean} awaitingPong
   * @property {NodeJS.Timeout | null} pingTimer
   */
  /** @type {Set<MuxConnection>} */
  const connections = new Set();
  let counter = 0;

  /** @param {MuxConnection} connection @param {Record<string, any>} frame */
  const sendFrame = (connection, frame) => {
    // isolated: a dead socket must not stop the other watchers.
    try {
      connection.socket.write(serverFrame(0x1, Buffer.from(JSON.stringify(frame), "utf8")));
    } catch {
      dropConnection(connection);
    }
  };

  /** @param {string} streamId @param {any} value @param {MuxConnection} connection */
  const sendItem = (connection, streamId, value) => sendFrame(connection, { type: "item", streamId, value });

  /**
   * Every open logical stream on the given endpoint, across every connection.
   * @param {string} endpoint @param {string | null} [sessionId]
   * @returns {{ connection: MuxConnection, streamId: string }[]}
   */
  const streamsFor = (endpoint, sessionId = null) => {
    /** @type {{ connection: MuxConnection, streamId: string }[]} */
    const found = [];
    for (const connection of connections) {
      for (const [streamId, stream] of connection.streams) {
        if (stream.endpoint !== endpoint) continue;
        if (sessionId !== null && stream.sessionId !== sessionId) continue;
        found.push({ connection, streamId });
      }
    }
    return found;
  };

  /**
   * One Gateway `$events` emit.
   *
   * `args` is positional and stays positional: the live kernel's own signatures
   * are `api-session/added(summary)`, `api-session/status(sessionId, running)`,
   * `api-session/removed(sessionId)` and `api-session/activity(sessionId, at)`
   * — three of the four put the session id in `args[0]` as a bare string, and a
   * mock that wrapped them all in an object would hide every reader that only
   * knows the object form.
   * @param {string} event @param {any[]} args
   */
  const emit = (event, args) => {
    for (const { connection, streamId } of streamsFor("$events")) {
      sendItem(connection, streamId, { type: "emit", event, args });
    }
  };

  /** @param {any} session @returns {Record<string, any>} */
  const summaryOf = (session) => ({
    sessionId: session.id,
    updatedAt: session.updatedAt,
    running: session.running,
    blank: session.events.length === 0,
    cwd: session.cwd,
    projections: { asOfSeq: session.seq - 1, values: { agentPreset: session.agentPreset, title: null } },
  });

  /**
   * @param {any} session
   * @param {string} type
   * @param {Record<string, any>} data
   */
  const append = (session, type, data) => {
    const event = { type, seq: session.seq++, time: Date.now(), data };
    session.events.push(event);
    session.updatedAt = event.time;
    // A session's events go only to the streams opened for that session. There
    // is no all-sessions stream in 0.1.2 and no session id inside the frame, so
    // routing here by anything other than which stream asked for it would be
    // inventing a field the wire does not carry.
    for (const { connection, streamId } of streamsFor("session/follow", session.id)) {
      sendItem(connection, streamId, { type: "event", event });
    }
    return event;
  };

  /** @param {string} rpcId @param {any} value */
  const ok = (rpcId, value) => ({ type: "server-response", rpcId, result: { ok: true, value } });
  /** @param {string} rpcId @param {string} code @param {string} message @param {Record<string, any>} [details] */
  const fail = (rpcId, code, message, details = {}) => ({
    type: "server-response",
    rpcId,
    result: { ok: false, error: { code, message, details } },
  });

  /**
   * Runs one turn: writes the artifact, logs the tool calls the ledger looks
   * for, and closes the turn. Synchronous on purpose — a test that has to wait
   * for a fake is a test that is flaky about something that never happens in
   * production.
   * @param {any} session @param {string} text
   */
  const runTurn = async (session, text) => {
    session.running = true;
    emit("api-session/status", [session.id, true]);
    const turn = 1;
    append(session, "turn/start", { turn });
    append(session, "user/message", {
      content: [{ type: "text", text }],
      source: { kind: "user", rpcId: randomUUID() },
      role: "user",
      id: randomUUID(),
    });
    append(session, "step/start", { turn, step: 1 });

    if (session.cwd) {
      // isolated: a fake that cannot write must still complete its turn, or a
      // read-only test directory turns into a protocol failure.
      try {
        await fs.mkdir(session.cwd, { recursive: true });
        await fs.writeFile(
          path.join(session.cwd, "mock-agent-artifact.md"),
          "# Mock agent artifact\n\nGenerated by the hosted mock runtime.\n",
          "utf8",
        );
      } catch { /* isolated: evimed_mock_kernel_write_failures_total */ }
    }

    const callId = `call_mock_${++counter}`;
    append(session, "assistant/chunk", { turn, step: 1, chunk: { type: "block-start", index: 0, blockType: "tool-call" } });
    append(session, "tool/call", {
      turn,
      step: 1,
      callId,
      name: "write",
      arguments: JSON.stringify({ file_path: path.join(session.cwd || "/workspace", "mock-agent-artifact.md"), content: "mock" }),
    });
    // The live nesting: the call id hangs off `message.source.callId` and the
    // text sits inside a `tool-result` block. The flat `message.callId` shape
    // the first fixture guessed at cost a whole run's tool results.
    append(session, "tool/result", {
      turn,
      step: 1,
      message: {
        source: { kind: "tool", callId },
        content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "Wrote mock-agent-artifact.md" }], isError: false }],
        role: "user",
        id: randomUUID(),
      },
      meta: { diffs: [] },
    });
    append(session, "step/end", { turn, step: 1 });
    append(session, "step/start", { turn, step: 2 });

    const answer = "EviMed 测试运行时已生成 mock-agent-artifact.md；生产环境将由服务端托管的科研智能体执行任务。";
    append(session, "assistant/chunk", { turn, step: 2, chunk: { type: "text-delta", index: 0, text: answer } });
    append(session, "assistant/message", {
      turn,
      step: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
        source: { kind: "model", provider: "mock", model: "mock-v1" },
        id: randomUUID(),
      },
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: 100, reasoningTokens: 0 },
    });
    append(session, "step/end", { turn, step: 2 });
    append(session, "turn/end", { turn, reason: { kind: "completed" } });
    session.running = false;
    emit("api-session/status", [session.id, false]);
  };

  /* ----------------------------------------------------- the mux WebSocket */

  /** @param {MuxConnection} connection */
  const dropConnection = (connection) => {
    if (!connections.has(connection)) return;
    connections.delete(connection);
    if (connection.pingTimer) clearInterval(connection.pingTimer);
    connection.streams.clear();
    try { connection.socket.destroy(); } catch { /* already gone */ }
  };

  /** @param {MuxConnection} connection @param {Record<string, any>} frame */
  const onClientFrame = (connection, frame) => {
    const streamId = String(frame?.streamId ?? "");
    if (!streamId) return;
    if (frame.type === "cancel") {
      // Cancelling one logical stream leaves every other stream on the same
      // socket running. That is the whole reason the mux exists, so the mock
      // has to actually implement it rather than close the socket.
      connection.streams.delete(streamId);
      sendFrame(connection, { type: "end", streamId });
      return;
    }
    if (frame.type !== "open") return;
    const endpoint = String(frame.endpoint ?? "");
    const args = frame?.payload?.args && typeof frame.payload.args === "object" ? frame.payload.args : {};

    if (endpoint === "$events") {
      connection.streams.set(streamId, { endpoint, sessionId: null });
      sendItem(connection, streamId, { type: "ready", clientId: randomUUID(), host: { home: "/mock/dsh-home" } });
      for (const session of sessions.values()) {
        sendItem(connection, streamId, { type: "emit", event: "api-session/added", args: [summaryOf(session)] });
      }
      return;
    }
    if (endpoint === "workspace/follow") {
      connection.streams.set(streamId, { endpoint, sessionId: null });
      sendItem(connection, streamId, { type: "baseline", value: { items: [], archivedSessionIds: [] } });
      return;
    }
    if (endpoint === "session/follow") {
      const address = args?.request?.address ?? {};
      const sessionId = String(address?.sessionId ?? "");
      const session = sessions.get(sessionId);
      if (!session) {
        // The live kernel's own code and message, verbatim in shape.
        sendFrame(connection, {
          type: "error",
          streamId,
          error: { code: "session/not-found", message: `session "${sessionId}" not found`, details: { sessionId } },
        });
        return;
      }
      connection.streams.set(streamId, { endpoint, sessionId });
      sendItem(connection, streamId, {
        type: "snapshot",
        header: { version: 0, id: session.id, createdAt: session.createdAt, cwd: session.cwd, agentPreset: session.agentPreset },
        cursor: session.seq - 1,
        records: session.events.map((event) => ({ type: "event", event })),
        hasMore: false,
        projections: { asOfSeq: session.seq - 1, values: { agentPreset: session.agentPreset } },
      });
      return;
    }
    sendFrame(connection, {
      type: "error",
      streamId,
      error: {
        code: "gateway/invocation-unavailable",
        message: `typert gateway: ${endpoint}: no active Remote method exports this endpoint`,
        details: { endpoint },
      },
    });
  };

  /** @param {import("node:http").Server} server */
  const attachMux = (server) => {
    server.on("upgrade", (req, socket) => {
      const url = new URL(req.url ?? "/", "http://runtime.local");
      const key = String(req.headers["sec-websocket-key"] ?? "");
      if (url.pathname !== MOCK_MUX_PATH || !key) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      // The mux is authenticated exactly like the unary surface. Letting an
      // upgrade through without a cookie would leave the one code path that
      // has to hold a credential for hours as the only one never asked for it.
      if (!mockAcceptsBrowserSession({ secret, authority: String(req.headers.host ?? ""), cookieHeader: req.headers.cookie })) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\nConnection: close\r\n\r\nunauthorized");
        return;
      }
      const accept = createHash("sha1").update(`${key}${WS_ACCEPT_GUID}`).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      /** @type {MuxConnection} */
      const connection = { socket, streams: new Map(), awaitingPong: false, pingTimer: null };
      connections.add(connection);
      const reader = new ClientFrameReader({
        onText: (text) => {
          /** @type {Record<string, any>} */
          let frame;
          try {
            frame = JSON.parse(text);
          } catch {
            return;
          }
          onClientFrame(connection, frame);
        },
        onPong: () => { connection.awaitingPong = false; },
        onClose: () => dropConnection(connection),
      });
      socket.on("data", (chunk) => {
        try {
          reader.push(/** @type {Buffer} */ (chunk));
        } catch {
          dropConnection(connection);
        }
      });
      socket.once("close", () => dropConnection(connection));
      socket.once("error", () => dropConnection(connection));
      if (pingIntervalMs > 0) {
        connection.pingTimer = setInterval(() => {
          if (connection.awaitingPong) {
            // Exactly what the host does, and the reason a client's pong path
            // is load-bearing rather than polite.
            dropConnection(connection);
            return;
          }
          connection.awaitingPong = true;
          try { socket.write(serverFrame(0x9, Buffer.from("dsh", "utf8"))); } catch { dropConnection(connection); }
        }, pingIntervalMs);
        connection.pingTimer.unref?.();
      }
    });
  };

  /* ------------------------------------------------------- the unary surface */

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://runtime.local");
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      if (!mockAcceptsBrowserSession({ secret, authority: String(req.headers.host ?? ""), cookieHeader: req.headers.cookie })) {
        // Status and body both copied from the live 0.1.2 kernel, which says
        // nothing about *why* — a cookie minted for the wrong authority and no
        // cookie at all are the same answer, which is exactly the failure this
        // mock has to be able to reproduce.
        res.writeHead(401, { "Content-Type": "text/plain;charset=UTF-8" });
        res.end("unauthorized");
        return;
      }
    }

    if (req.method === "GET" && pathname === MOCK_MUX_PATH) {
      // What a live kernel answers a plain GET on the mux. Serving
      // `text/event-stream` here — as an earlier mock did — would let someone
      // write an SSE reader against a protocol the kernel does not speak.
      res.writeHead(426, { "Content-Type": "text/plain;charset=UTF-8", Connection: "Upgrade", Upgrade: "websocket" });
      res.end("upgrade required");
      return;
    }

    if (req.method === "POST" && pathname.startsWith("/api/")) {
      const endpoint = pathname.slice("/api/".length);
      const envelope = await readJsonBody(req);
      const rpcId = String(envelope.rpcId ?? `rpc_${++counter}`);
      const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
      const args = payload.args && typeof payload.args === "object" ? payload.args : {};

      if (endpoint === "$events/result") {
        // The answer channel for a `waterfall` frame. Nothing in the control
        // plane answers one yet; the route exists so that when something does,
        // it is not discovering the path for the first time in production.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ok(rpcId, { accepted: true })));
        return;
      }

      if (!MOCK_ENDPOINTS.includes(endpoint)) {
        // The live kernel 404s an endpoint it does not export — including every
        // dotted 0.1.1 name. It is not an error envelope, and a mock that
        // answered one would make `session.list` look merely unhappy instead of
        // gone.
        res.writeHead(404, { "Content-Type": "text/plain;charset=UTF-8" });
        res.end("not found");
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });

      /** @param {string} field @returns {Record<string, any> | null} */
      const descriptor = (field) => {
        const value = args[field];
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
      };
      /** @param {string} field */
      const invalid = (field) => JSON.stringify(fail(
        rpcId,
        "gateway/input-invalid",
        `typert gateway: ${endpoint}: wire field "${field}" failed boundary validation`,
        { endpoint, field },
      ));

      if (endpoint === "agentPresets/list") {
        res.end(JSON.stringify(ok(rpcId, { presets: [{ name: "evimed-universal", description: "EviMed unified composition" }] })));
        return;
      }
      if (endpoint === "session/list") {
        if (!descriptor("_request")) {
          res.end(invalid("_request"));
          return;
        }
        res.end(JSON.stringify(ok(rpcId, { items: [...sessions.values()].map(summaryOf) })));
        return;
      }
      if (endpoint === "subagents/list") {
        res.end(JSON.stringify(ok(rpcId, { items: [] })));
        return;
      }
      if (endpoint === "skills/list") {
        if (!descriptor("request")) {
          res.end(invalid("request"));
          return;
        }
        res.end(JSON.stringify(ok(rpcId, { skills: [] })));
        return;
      }

      const request = descriptor("request");
      if (!request) {
        res.end(invalid("request"));
        return;
      }

      if (endpoint === "session/create") {
        const id = String(request.sessionId ?? `web_mock_${++counter}`);
        const cwd = String(request.cwd ?? "");
        const existing = sessions.get(id);
        if (existing && existing.cwd !== (cwd || existing.cwd)) {
          res.end(JSON.stringify(fail(rpcId, "session/conflict", "session id already exists with a different cwd", { sessionId: id })));
          return;
        }
        if (!existing) {
          const now = Date.now();
          sessions.set(id, {
            id,
            cwd,
            agentPreset: String(request.agentPreset ?? "evimed-universal"),
            events: [],
            seq: 0,
            running: false,
            createdAt: now,
            updatedAt: now,
          });
          emit("api-session/added", [summaryOf(sessions.get(id))]);
        }
        res.end(JSON.stringify(ok(rpcId, { sessionId: id, agentPreset: sessions.get(id).agentPreset })));
        return;
      }

      const addressed = endpoint === "session/page"
        ? String(request?.address?.sessionId ?? "")
        : String(request.sessionId ?? "");
      const session = sessions.get(addressed);
      if (!session) {
        res.end(JSON.stringify(fail(rpcId, "session/not-found", `session "${addressed}" not found`, { sessionId: addressed })));
        return;
      }

      if (endpoint === "session/prompt") {
        if (!request.requestId) {
          // 0.1.2 requires the client's own id for the submission; without it
          // two dispatches are indistinguishable in the queue.
          res.end(invalid("request"));
          return;
        }
        const text = (Array.isArray(request.content) ? request.content : [])
          .filter((part) => part?.type === "text")
          .map((part) => String(part.text ?? ""))
          .join("\n") || "web prompt";
        res.end(JSON.stringify(ok(rpcId, { accepted: true })));
        await runTurn(session, text);
        return;
      }
      if (endpoint === "session/cancel") {
        if (session.running) append(session, "turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } });
        session.running = false;
        res.end(JSON.stringify(ok(rpcId, { accepted: true })));
        return;
      }
      if (endpoint === "session/page") {
        const throughSeq = Number(request.throughSeq);
        if (!Number.isFinite(throughSeq)) {
          // Required in 0.1.2, and the gateway names the field it refused.
          res.end(invalid("request"));
          return;
        }
        const head = session.seq - 1;
        // A value past the end returns nothing, not the tail. Reproduced
        // deliberately: asking for "everything" with a large constant reads as
        // an empty run, and an empty run is what the delivery gate grades.
        const inRange = throughSeq > head
          ? []
          : session.events.filter((event) => event.seq <= throughSeq);
        const before = Number(request.beforeSeq);
        const bounded = Number.isFinite(before) ? inRange.filter((event) => event.seq < before) : inRange;
        const maxMessages = Number.isFinite(Number(request.maxMessages)) ? Number(request.maxMessages) : bounded.length;
        const page = bounded.slice(Math.max(0, bounded.length - maxMessages));
        res.end(JSON.stringify(ok(rpcId, {
          records: page.map((event) => ({ type: "event", event })),
          hasMore: page.length < bounded.length,
        })));
        return;
      }
      if (endpoint === "session/fork") {
        const id = `web_mock_${++counter}`;
        const now = Date.now();
        sessions.set(id, {
          id,
          cwd: session.cwd,
          agentPreset: session.agentPreset,
          events: [...session.events],
          seq: session.seq,
          running: false,
          createdAt: now,
          updatedAt: now,
        });
        emit("api-session/added", [summaryOf(sessions.get(id))]);
        res.end(JSON.stringify(ok(rpcId, { sessionId: id })));
        return;
      }
      res.end(JSON.stringify(fail(rpcId, "gateway/method-unavailable", `mock kernel does not serve ${endpoint}`, { endpoint })));
      return;
    }

    // The non-protocol routes the proxy hardening tests exercise. A live kernel
    // has none of them: what they test is our proxy, not the kernel, which is
    // also why they are outside `/api` and outside the cookie check.
    if (req.method === "GET" && pathname === "/echo") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "runtime_cookie=secret",
        "WWW-Authenticate": "Basic realm=\"runtime\"",
        "Proxy-Authenticate": "Basic realm=\"runtime\"",
        "Connection": "keep-alive, x-runtime-hop",
        "X-Runtime-Hop": "drop-me",
      });
      res.end(JSON.stringify({
        query: Object.fromEntries(url.searchParams.entries()),
        headers: {
          authorization: req.headers.authorization ?? null,
          cookie: req.headers.cookie ?? null,
          acceptEncoding: req.headers["accept-encoding"] ?? null,
        },
      }));
      return;
    }
    if (req.method === "GET" && pathname === "/redirect") {
      const runtimeOrigin = `http://${req.headers.host ?? "runtime.local"}`;
      res.writeHead(302, {
        Location: `${runtimeOrigin}/echo?directory=/etc&auth_token=secret&keep=1`,
        "Set-Cookie": "runtime_redirect=secret",
        "WWW-Authenticate": "Basic realm=\"runtime\"",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && pathname === "/slow-body") {
      const delayMs = Math.max(0, Math.min(Number(url.searchParams.get("delay") ?? 200), 2_000));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders?.();
      setTimeout(() => {
        if (!res.destroyed) res.end(JSON.stringify({ ok: true }));
      }, delayMs);
      return;
    }
    if (req.method === "GET" && pathname === "/large-response") {
      const bytes = Math.max(0, Math.min(Number(url.searchParams.get("bytes") ?? 1024), 1024 * 1024));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: "x".repeat(bytes) }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "mock kernel route not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    attachMux(server);
    server.listen(0, "127.0.0.1", () => {
      const address = /** @type {import("node:net").AddressInfo} */ (server.address());
      const authority = `127.0.0.1:${address.port}`;
      resolve({
        url: `http://${authority}`,
        authority,
        secret,
        // Minted with the production minter against the mock's own authority,
        // so a caller gets a working credential without learning the format —
        // and the mock still verifies it with its own independent check.
        cookie: browserSessionCookie({ secret, authority }),
        close: () => new Promise((done) => {
          for (const connection of [...connections]) dropConnection(connection);
          server.close(() => done(undefined));
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

/** The unary endpoints this fake serves, so a test can assert the allow-list is covered. */
export const MOCK_ENDPOINTS = Object.freeze([
  "session/create",
  "session/prompt",
  "session/cancel",
  "session/page",
  "session/fork",
  "session/list",
  "subagents/list",
  "skills/list",
  "agentPresets/list",
]);

/** The stream endpoints this fake serves over the mux. */
export const MOCK_STREAM_ENDPOINTS = Object.freeze(["$events", "session/follow", "workspace/follow"]);

/**
 * One unmasked server-to-client frame, any opcode.
 *
 * Written out rather than pulled in: a dependency for twenty lines of framing
 * would be a dependency in the control plane's test path, and the three length
 * forms below are the whole of what the mux needs.
 *
 * @param {number} opcode
 * @param {Buffer} body
 * @returns {Buffer}
 */
function serverFrame(opcode, body) {
  /** @type {Buffer} */
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

/**
 * Decodes masked client-to-server frames, incrementally.
 *
 * The mock never had to read this direction before: 0.1.1's downlink was
 * server-push only, and 0.1.2's mux is a conversation. A chunk carries no
 * promise about frame boundaries either way, so the same partial/coalesced
 * handling the client side needs is needed here.
 */
class ClientFrameReader {
  /** @param {{ onText: (text: string) => void, onPong: () => void, onClose: () => void }} handlers */
  constructor({ onText, onPong, onClose }) {
    this.onText = onText;
    this.onPong = onPong;
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
      const { fin, opcode, payload } = frame;
      if (opcode === 0xa) {
        this.onPong();
        continue;
      }
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
      }
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
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("mock mux received a frame too large to decode.");
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
}
