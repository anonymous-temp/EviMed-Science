import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserSessionCookie } from "../src/dshBrowserAuth.mjs";
import { DshMux, REMOTE_EVENT_STREAM_ENDPOINT, REMOTE_STREAM_MUX_PATH } from "../src/dshMux.mjs";
import { startMockDshRuntime } from "../src/mockDshRuntime.mjs";

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One unmasked server-to-client frame, any opcode. */
function serverFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
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
const serverTextFrame = (value) => serverFrame(0x1, JSON.stringify(value));

/** Decodes masked client-to-server frames — enough to read what the mux writes back. */
function decodeClientFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      len = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      len = Number(buf.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      maskKey = buf.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + len > buf.length) return frames;
    let payload = buf.subarray(cursor, cursor + len);
    if (maskKey) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    frames.push({ opcode, payload });
    offset = cursor + len;
  }
  return frames;
}

/**
 * A raw upgrade server with no protocol opinions, for byte-level control over
 * what the client receives and when.
 *
 * `http.Server` stops tracking a socket the moment an `'upgrade'` handler takes
 * it over, so neither `server.close()`'s own wait nor `closeAllConnections()`
 * ever sees it again — a server that does not destroy its upgraded sockets by
 * hand hangs its own `close()` forever the first time a test disconnects.
 */
function startRawMuxServer({ socketPath } = {}) {
  return new Promise((resolve, reject) => {
    /** @type {(socket: import("node:net").Socket, api: { open: Record<string, any>[] }) => void} */
    let onConnection = () => {};
    /** @type {Set<import("node:net").Socket>} */
    const sockets = new Set();
    /** @type {Record<string, any>[]} */
    const clientFrames = [];
    const server = createServer((_req, res) => {
      res.writeHead(426, { Connection: "Upgrade", Upgrade: "websocket" });
      res.end("upgrade required");
    });
    server.on("upgrade", (req, socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const acceptKey = String(req.headers["sec-websocket-key"] ?? "");
      const accept = createHash("sha1").update(`${acceptKey}${WS_ACCEPT_GUID}`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("data", (chunk) => {
        for (const frame of decodeClientFrames(chunk)) {
          if (frame.opcode === 0x1) {
            try {
              clientFrames.push(JSON.parse(frame.payload.toString("utf8")));
            } catch { /* a malformed frame is the test's own problem to assert */ }
          } else {
            clientFrames.push({ type: `control:${frame.opcode}`, payload: frame.payload.toString("utf8") });
          }
        }
      });
      onConnection(socket, { clientFrames });
    });
    server.once("error", reject);
    const onListening = () => {
      const address = server.address();
      resolve({
        url: socketPath ? "http://runtime.local" : `http://127.0.0.1:${address.port}`,
        socketPath: socketPath ?? null,
        clientFrames,
        onConnection: (fn) => { onConnection = fn; },
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done(undefined));
        }),
      });
    };
    if (socketPath) server.listen(socketPath, onListening);
    else server.listen(0, "127.0.0.1", onListening);
  });
}

/** Waits until `predicate` holds, or fails the test by name rather than by timeout. */
async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}.`);
}

/**
 * Drains an open logical stream into an array, in the background.
 *
 * The failure is captured rather than thrown: every test here ends by closing
 * the socket, which fails every stream still open on it by design, and an
 * uncaught background rejection would land on whichever test the runner
 * happened to be inside. A test that wants to assert a throw asserts it on the
 * generator directly, not through this.
 */
function drain(stream) {
  const seen = [];
  /** @type {{ error: Error | null }} */
  const outcome = { error: null };
  const done = (async () => {
    try {
      for await (const value of stream) seen.push(value);
    } catch (error) {
      outcome.error = /** @type {Error} */ (error);
    }
  })();
  return { seen, done, outcome };
}

/** Waits for the mux's `open` frame for `endpoint` and returns the streamId the client minted. */
async function streamIdFor(server, endpoint) {
  await waitFor(
    () => server.clientFrames.some((frame) => frame.type === "open" && frame.endpoint === endpoint),
    `the client's open frame for ${endpoint}`,
  );
  return server.clientFrames.find((frame) => frame.type === "open" && frame.endpoint === endpoint).streamId;
}

/* ------------------------------------------------------------ the socket */

test("the mux carries two logical streams over one socket, routed only by stream id", async () => {
  // The whole reason `/api/remote.mux` exists. Before 0.1.2 there was one
  // downlink per concern and the session id travelled in the frame; now one
  // socket carries every stream and the id is gone, so a mux that leaked a
  // frame from one stream into another would mis-attribute a subagent's entire
  // transcript with nothing anywhere saying so.
  const server = await startRawMuxServer();
  /** @type {import("node:net").Socket | null} */
  let peer = null;
  server.onConnection((socket) => { peer = socket; });
  const mux = new DshMux({ url: server.url });
  const controller = new AbortController();
  try {
    await mux.connect({ signal: controller.signal });
    const events = drain(mux.open(REMOTE_EVENT_STREAM_ENDPOINT, {}, { signal: controller.signal }));
    const follow = drain(mux.open("session/follow", { request: { address: { kind: "session", sessionId: "s-1" } } }, { signal: controller.signal }));

    const eventsId = await streamIdFor(server, REMOTE_EVENT_STREAM_ENDPOINT);
    const followId = await streamIdFor(server, "session/follow");
    assert.notEqual(eventsId, followId, "two logical streams must not share an id");
    assert.equal(server.clientFrames.filter((frame) => frame.type === "open").length, 2);
    // The open frame's shape, which is the 0.1.2 change: an endpoint name and
    // arguments under `payload.args`, not an RPC method with a flat payload.
    const openFollow = server.clientFrames.find((frame) => frame.endpoint === "session/follow");
    assert.deepEqual(openFollow.payload, { args: { request: { address: { kind: "session", sessionId: "s-1" } } } });

    // Interleaved on purpose: nothing about arrival order may decide routing.
    peer.write(serverTextFrame({ type: "item", streamId: followId, value: { type: "event", n: 1 } }));
    peer.write(serverTextFrame({ type: "item", streamId: eventsId, value: { type: "ready" } }));
    peer.write(serverTextFrame({ type: "item", streamId: followId, value: { type: "event", n: 2 } }));

    await waitFor(() => follow.seen.length === 2 && events.seen.length === 1, "both streams to receive their own frames");
    assert.deepEqual(follow.seen, [{ type: "event", n: 1 }, { type: "event", n: 2 }]);
    assert.deepEqual(events.seen, [{ type: "ready" }]);
  } finally {
    controller.abort();
    mux.close();
    await server.close();
  }
});

test("cancelling one logical stream leaves the other running", async () => {
  const server = await startRawMuxServer();
  let peer = null;
  server.onConnection((socket) => { peer = socket; });
  const mux = new DshMux({ url: server.url });
  const outer = new AbortController();
  const doomed = new AbortController();
  try {
    await mux.connect({ signal: outer.signal });
    const survivor = drain(mux.open("session/follow", { a: 1 }, { signal: outer.signal }));
    const cancelled = drain(mux.open("workspace/follow", {}, { signal: doomed.signal }));
    const survivorId = await streamIdFor(server, "session/follow");
    const cancelledId = await streamIdFor(server, "workspace/follow");

    peer.write(serverTextFrame({ type: "item", streamId: cancelledId, value: { baseline: true } }));
    await waitFor(() => cancelled.seen.length === 1, "the doomed stream's first frame");

    doomed.abort();
    await cancelled.done;
    await waitFor(
      () => server.clientFrames.some((frame) => frame.type === "cancel" && frame.streamId === cancelledId),
      "a cancel frame for the aborted stream",
    );
    // Negative control on the same fact: nothing cancelled the survivor.
    assert.equal(server.clientFrames.some((frame) => frame.type === "cancel" && frame.streamId === survivorId), false);

    peer.write(serverTextFrame({ type: "item", streamId: survivorId, value: { stillHere: true } }));
    await waitFor(() => survivor.seen.length === 1, "the surviving stream to keep delivering after its neighbour was cancelled");
    assert.deepEqual(survivor.seen, [{ stillHere: true }]);
    // And a frame that arrives for a stream that is gone is dropped, not
    // delivered to whoever is left listening.
    peer.write(serverTextFrame({ type: "item", streamId: cancelledId, value: { late: true } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cancelled.seen.length, 1);
    assert.equal(survivor.seen.length, 1);
  } finally {
    outer.abort();
    mux.close();
    await server.close();
  }
});

test("an error frame surfaces as a throw carrying the kernel's own code", async () => {
  const server = await startRawMuxServer();
  let peer = null;
  server.onConnection((socket) => { peer = socket; });
  const mux = new DshMux({ url: server.url });
  const controller = new AbortController();
  try {
    await mux.connect({ signal: controller.signal });
    const stream = mux.open("session/follow", { request: { address: { kind: "session", sessionId: "nope" } } }, { signal: controller.signal });
    const streamId = streamIdFor(server, "session/follow").then((id) => {
      // The live kernel's own frame for a session that does not exist.
      peer.write(serverTextFrame({
        type: "error",
        streamId: id,
        error: { code: "session/not-found", message: 'session "nope" not found', details: {} },
      }));
    });
    await assert.rejects(
      (async () => { for await (const _value of stream) { /* nothing arrives */ } })(),
      (error) => {
        assert.equal(error.code, "session/not-found", "the kernel's code must survive the throw, not be flattened");
        assert.match(error.message, /session\/follow/);
        assert.match(error.message, /not found/);
        return true;
      },
    );
    await streamId;
  } finally {
    controller.abort();
    mux.close();
    await server.close();
  }
});

test("an end frame ends the stream cleanly, which is not the same answer as an error", async () => {
  const server = await startRawMuxServer();
  let peer = null;
  server.onConnection((socket) => { peer = socket; });
  const mux = new DshMux({ url: server.url });
  const controller = new AbortController();
  try {
    await mux.connect({ signal: controller.signal });
    const stream = mux.open("$events", {}, { signal: controller.signal });
    const collected = drain(stream);
    const streamId = await streamIdFor(server, "$events");
    peer.write(serverTextFrame({ type: "item", streamId, value: { type: "ready" } }));
    peer.write(serverTextFrame({ type: "end", streamId }));
    // Resolving rather than rejecting is the assertion: "this stream finished"
    // and "this connection died" have to stay distinguishable on one socket.
    await collected.done;
    assert.deepEqual(collected.seen, [{ type: "ready" }]);
    assert.equal(mux.closed, false, "one logical stream ending must not close the socket");
  } finally {
    controller.abort();
    mux.close();
    await server.close();
  }
});

test("a ping is answered with a pong echoing its payload, because the host kills a socket that does not", async () => {
  // The host pings every two seconds and terminates a socket that did not
  // answer the previous one. A downlink that never ponged would die on a
  // two-second cycle and reconnect forever, publishing almost nothing, and the
  // symptom in the browser is a live view that is merely a bit empty.
  const server = await startRawMuxServer();
  let peer = null;
  server.onConnection((socket) => { peer = socket; });
  const mux = new DshMux({ url: server.url });
  const controller = new AbortController();
  try {
    await mux.connect({ signal: controller.signal });
    peer.write(serverFrame(0x9, "ping-body"));
    await waitFor(() => server.clientFrames.some((frame) => frame.type === "control:10"), "a pong");
    const pong = server.clientFrames.find((frame) => frame.type === "control:10");
    assert.equal(pong.payload, "ping-body", "a pong must echo the ping's payload exactly");
  } finally {
    controller.abort();
    mux.close();
    await server.close();
  }
});

test("a frame split across TCP chunks and two frames coalesced into one both decode", async () => {
  const server = await startRawMuxServer();
  let peer = null;
  server.onConnection((socket) => { peer = socket; });
  const mux = new DshMux({ url: server.url });
  const controller = new AbortController();
  try {
    await mux.connect({ signal: controller.signal });
    const collected = drain(mux.open("$events", {}, { signal: controller.signal }));
    const streamId = await streamIdFor(server, "$events");

    const one = serverTextFrame({ type: "item", streamId, value: { n: 1, pad: "x".repeat(400) } });
    const cut = Math.floor(one.length / 2);
    peer.write(one.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    peer.write(one.subarray(cut));

    peer.write(Buffer.concat([
      serverTextFrame({ type: "item", streamId, value: { n: 2 } }),
      serverTextFrame({ type: "item", streamId, value: { n: 3 } }),
    ]));

    await waitFor(() => collected.seen.length === 3, "all three frames");
    assert.deepEqual(collected.seen.map((value) => value.n), [1, 2, 3]);
  } finally {
    controller.abort();
    mux.close();
    await server.close();
  }
});

test("the mux dials over a unix socket the same way the unary path does", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "dsh-mux-uds-"));
  const socketPath = path.join(tmp, "runtime.sock");
  const server = await startRawMuxServer({ socketPath });
  let peer = null;
  server.onConnection((socket) => { peer = socket; });
  const mux = new DshMux({ url: server.url, socketPath });
  const controller = new AbortController();
  try {
    await mux.connect({ signal: controller.signal });
    const collected = drain(mux.open("$events", {}, { signal: controller.signal }));
    const streamId = await streamIdFor(server, "$events");
    peer.write(serverTextFrame({ type: "item", streamId, value: { viaUnixSocket: true } }));
    await waitFor(() => collected.seen.length === 1, "a frame over the unix socket");
    assert.deepEqual(collected.seen, [{ viaUnixSocket: true }]);
  } finally {
    controller.abort();
    mux.close();
    await server.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a socket that dies takes every stream on it with it, as a failure and not as an ending", async () => {
  const server = await startRawMuxServer();
  let peer = null;
  server.onConnection((socket) => { peer = socket; });
  const mux = new DshMux({ url: server.url });
  const controller = new AbortController();
  try {
    await mux.connect({ signal: controller.signal });
    const first = mux.open("$events", {}, { signal: controller.signal });
    const second = mux.open("session/follow", { request: {} }, { signal: controller.signal });
    const both = [
      assert.rejects((async () => { for await (const _v of first) { /* none */ } })(), /mux/i),
      assert.rejects((async () => { for await (const _v of second) { /* none */ } })(), /mux/i),
    ];
    await streamIdFor(server, "session/follow");
    peer.destroy();
    await Promise.all(both);
  } finally {
    controller.abort();
    mux.close();
    await server.close();
  }
});

/* ------------------------------------------------- authentication, live shape */

test("the mux says 'unauthenticated' when the kernel refuses it, rather than 'it did not upgrade'", async () => {
  // 0.1.2 authenticates on loopback and 0.1.1 did not, so the first form this
  // failure took in production was a downlink that simply never connected. The
  // status code is the whole change arriving, and the message has to say so.
  const mock = await startMockDshRuntime({ pingIntervalMs: 0 });
  try {
    const mux = new DshMux({ url: mock.url, authority: mock.authority });
    await assert.rejects(
      mux.connect({ signal: AbortSignal.timeout(5_000) }),
      (error) => {
        assert.match(error.message, /401/);
        assert.match(error.message, /unauthenticated/i);
        assert.match(error.message, /cookie/i);
        return true;
      },
    );

    // A cookie minted for another authority is refused the same way — it is not
    // a weaker credential, it is a different cookie the kernel never looks for.
    const wrong = new DshMux({
      url: mock.url,
      authority: mock.authority,
      cookie: browserSessionCookie({ secret: mock.secret, authority: "somewhere-else:9999" }),
    });
    await assert.rejects(wrong.connect({ signal: AbortSignal.timeout(5_000) }), /401/);

    // Negative control: the same dial with the right cookie upgrades.
    const good = new DshMux({ url: mock.url, authority: mock.authority, cookie: mock.cookie });
    await good.connect({ signal: AbortSignal.timeout(5_000) });
    assert.equal(good.closed, false);
    good.close();
  } finally {
    await mock.close();
  }
});

test("the mux path and endpoint names are the manifest's, not this file's", async () => {
  const { SEAMS } = await import("@evimed/harness-port");
  assert.equal(REMOTE_STREAM_MUX_PATH, SEAMS.wire.mux);
  assert.equal(REMOTE_STREAM_MUX_PATH, "/api/remote.mux");
  assert.equal(REMOTE_EVENT_STREAM_ENDPOINT, SEAMS.wire.streamEndpoints.events);
  assert.equal(REMOTE_EVENT_STREAM_ENDPOINT, "$events");
});

test("a plain GET on the mux answers 426, so nobody writes an SSE reader for it", async () => {
  const mock = await startMockDshRuntime({ pingIntervalMs: 0 });
  try {
    const response = await fetch(`${mock.url}${REMOTE_STREAM_MUX_PATH}`, { headers: { cookie: mock.cookie } });
    assert.equal(response.status, 426);
    assert.equal(response.headers.get("upgrade"), "websocket");
    await response.text();
  } finally {
    await mock.close();
  }
});

test("the mock kernel multiplexes real streams over one real socket", async () => {
  // The same multiplexing as the first test, but end to end against the fake
  // kernel the rest of the suite runs on: if the mock only ever served one
  // stream at a time, every pump test above it would be exercising a shape
  // production does not have.
  const mock = await startMockDshRuntime({ pingIntervalMs: 0 });
  const mux = new DshMux({ url: mock.url, authority: mock.authority, cookie: mock.cookie });
  const controller = new AbortController();
  try {
    await mux.connect({ signal: controller.signal });
    const events = drain(mux.open("$events", {}, { signal: controller.signal }));
    await waitFor(() => events.seen.some((value) => value.type === "ready"), "the $events ready frame");

    const created = await fetch(`${mock.url}/api/session/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mock.cookie },
      body: JSON.stringify({ type: "client-request", rpcId: "t1", method: "session/create", payload: { args: { request: { cwd: "/workspace", sessionId: "s-mux" } } } }),
    }).then((response) => response.json());
    assert.equal(created.result.ok, true, JSON.stringify(created));

    await waitFor(() => events.seen.some((value) => value.event === "api-session/added"), "an api-session/added emit");
    const follow = drain(mux.open("session/follow", { request: { address: { kind: "session", sessionId: "s-mux" } } }, { signal: controller.signal }));
    await waitFor(() => follow.seen.some((value) => value.type === "snapshot"), "the session/follow snapshot");

    // Both streams are alive on the same socket at the same time.
    assert.ok(events.seen.length >= 2);
    assert.ok(follow.seen.length >= 1);

    // A stream the kernel does not export errors on its own id and leaves the
    // others alone.
    await assert.rejects(
      (async () => { for await (const _v of mux.open("no/such-endpoint", {}, { signal: controller.signal })) { /* none */ } })(),
      /gateway\/invocation-unavailable/,
    );
    await fetch(`${mock.url}/api/session/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mock.cookie },
      body: JSON.stringify({ type: "client-request", rpcId: "t2", method: "session/prompt", payload: { args: { request: { requestId: "r1", sessionId: "s-mux", mode: "queue", content: [{ type: "text", text: "hi" }] } } } }),
    }).then((response) => response.json());
    await waitFor(
      () => follow.seen.some((value) => value.type === "event" && value.event?.type === "turn/end"),
      "the run's turn/end on the still-open follow stream",
    );

    // A second session, followed on the same socket, must see none of the
    // first one's events. There is no session id in a `session/follow` frame,
    // so the only thing keeping two runs apart is which stream the kernel
    // writes each event to — and a kernel (or a fake standing in for one) that
    // wrote every event to every follow stream would produce exactly the same
    // observations as a correct one for as long as only one session is open.
    await fetch(`${mock.url}/api/session/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mock.cookie },
      body: JSON.stringify({ type: "client-request", rpcId: "t3", method: "session/create", payload: { args: { request: { cwd: "/workspace", sessionId: "s-bystander" } } } }),
    }).then((response) => response.json());
    const bystander = drain(mux.open("session/follow", { request: { address: { kind: "session", sessionId: "s-bystander" } } }, { signal: controller.signal }));
    await waitFor(() => bystander.seen.some((value) => value.type === "snapshot"), "the bystander's snapshot");

    const before = follow.seen.length;
    await fetch(`${mock.url}/api/session/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mock.cookie },
      body: JSON.stringify({ type: "client-request", rpcId: "t4", method: "session/prompt", payload: { args: { request: { requestId: "r2", sessionId: "s-mux", mode: "queue", content: [{ type: "text", text: "again" }] } } } }),
    }).then((response) => response.json());
    await waitFor(() => follow.seen.length > before, "the second turn on the session that was prompted");
    assert.deepEqual(
      bystander.seen.filter((value) => value.type === "event"),
      [],
      "a session that was not prompted must receive no events at all",
    );
  } finally {
    controller.abort();
    mux.close();
    await mock.close();
  }
});

/* ------------------------------------------- the fake kernel's own fidelity */

test("the mock kernel answers 0.1.2 and refuses 0.1.1, the way the live binary does", async (t) => {
  // A mock that is more permissive than production hides exactly the bug that
  // will only appear in production. Each expectation below was observed against
  // a running 0.1.2-alpha.3 binary on 2026-09-01, not inferred.
  const mock = await startMockDshRuntime({ pingIntervalMs: 0 });
  t.after(() => mock.close());
  /** @param {string} endpoint @param {Record<string, any>} args */
  const post = (endpoint, args) => fetch(`${mock.url}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: mock.cookie },
    body: JSON.stringify({ type: "client-request", rpcId: "fidelity", method: endpoint, payload: { args } }),
  });

  // The dotted spelling is gone, and gone is a 404 — not an error envelope.
  const dotted = await post("session.list", {});
  assert.equal(dotted.status, 404);
  await dotted.text();

  const listed = await post("session/list", { _request: {} });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.ok, true);

  // Arguments live in a named descriptor, and the gateway names the field it
  // refused rather than failing generically.
  const undescribed = await post("session/list", {});
  const refusal = (await undescribed.json()).result;
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error.code, "gateway/input-invalid");
  assert.equal(refusal.error.details.field, "_request");

  await post("session/create", { request: { sessionId: "s-fid", cwd: "/workspace" } }).then((r) => r.json());
  await post("session/prompt", { request: { requestId: "r", sessionId: "s-fid", mode: "queue", content: [{ type: "text", text: "hi" }] } }).then((r) => r.json());

  // `throughSeq` is required, and a value past the end returns NOTHING rather
  // than the tail. Asking for "everything" with a large constant therefore
  // reads as an empty run — which is what the delivery gate would grade.
  // A bare array, which is what alpha.5 answers and what the mock now answers.
  // It used to be `{ items: [...] }` here, and `DshRuntimeAdapter.listSessions`
  // read that shape -- so in production it reported no sessions for a kernel
  // holding several.
  const head = (await post("session/list", { _request: {} }).then((r) => r.json())).result.value
    .find((item) => item.sessionId === "s-fid").projections.asOfSeq;
  assert.ok(head > 0);

  const unbounded = await post("session/page", { request: { address: { kind: "session", sessionId: "s-fid" } } }).then((r) => r.json());
  assert.equal(unbounded.result.ok, false);
  assert.equal(unbounded.result.error.code, "gateway/input-invalid");

  const pastTheEnd = await post("session/page", { request: { address: { kind: "session", sessionId: "s-fid" }, throughSeq: 10_000_000 } }).then((r) => r.json());
  assert.deepEqual(pastTheEnd.result.value.records, [], "past the end is nothing, not the tail");

  const real = await post("session/page", { request: { address: { kind: "session", sessionId: "s-fid" }, throughSeq: head } }).then((r) => r.json());
  assert.ok(real.result.value.records.length > 0, "reading through the published head is what returns the run");
  assert.ok(real.result.value.records.every((record) => record.type === "event"));

  // Slashed error codes, which is the other half of the 0.1.2 rename.
  const missing = await post("session/cancel", { request: { sessionId: "nobody" } }).then((r) => r.json());
  assert.equal(missing.result.error.code, "session/not-found");
});


test("nothing reads a session list by a shape the kernel does not send", async () => {
  // alpha.5 answers `session/list` with a bare array. Three shipped readers
  // took `value.items` -- the mock's shape -- so the adapter reported no
  // sessions for a kernel holding several, transcript paging could not find a
  // head sequence, and a busy session read `idle` forever. Each is a wrong
  // answer that looks exactly like a correct one about an idle runtime.
  //
  // Derived rather than a list of the three: the next reader has to go through
  // the one helper too.
  const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".mjs") && name !== "dshRuntimeAdapter.mjs");
  let scanned = 0;
  for (const name of files) {
    const text = await readFile(path.join(dir, name), "utf8");
    if (!text.includes("session/list")) continue;
    scanned += 1;
    assert.ok(
      !/\.items\b/.test(text.slice(Math.max(0, text.indexOf("session/list") - 2_000))),
      `${name} calls session/list and reads .items; the kernel sends a bare array — use sessionListItems`,
    );
  }
  assert.ok(scanned >= 2, `the scan found ${scanned} callers of session/list; it is not reading the sources`);
});
