import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RunEventHub } from "../src/runEventStream.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { openRuntimeDownlink, RuntimeEventPump } from "../src/dshEventPump.mjs";
import { startMockDshRuntime } from "../src/mockDshRuntime.mjs";

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for the expected event pump state.");
}

/** One unmasked server-to-client frame, any opcode — generalizes the mock's own text-only encoder so a test can also send pings. */
function serverFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
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
const serverTextFrame = (text) => serverFrame(0x1, text);

/** Decodes exactly one masked client-to-server frame — enough to check a pong's payload. */
function decodeClientFrame(buf) {
  const opcode = buf[0] & 0x0f;
  const len = buf[1] & 0x7f;
  const maskKey = buf.subarray(2, 6);
  const payload = buf.subarray(6, 6 + len);
  const unmasked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
  return { opcode, payload: unmasked };
}

/**
 * A raw upgrade server with no protocol opinions, for byte-level control over
 * what the client receives and when.
 *
 * `http.Server` stops tracking a socket the moment an `'upgrade'` handler
 * takes it over, so neither `server.close()`'s own wait nor
 * `closeAllConnections()` ever sees it again — `mockDshRuntime.mjs` tracks its
 * own upgraded sockets and destroys them by hand for exactly this reason, and
 * a server that does not do the same here hangs its own `close()` forever the
 * moment a test's client disconnects.
 */
function startRawDownlinkServer({ socketPath } = {}) {
  return new Promise((resolve, reject) => {
    let onConnection = () => {};
    /** @type {Set<import("node:net").Socket>} */
    const sockets = new Set();
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
      onConnection(socket);
    });
    server.once("error", reject);
    const onListening = () => {
      const address = server.address();
      resolve({
        url: socketPath ? "http://runtime.local" : `http://127.0.0.1:${address.port}`,
        socketPath: socketPath ?? null,
        onConnection: (fn) => {
          onConnection = fn;
        },
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    };
    if (socketPath) server.listen(socketPath, onListening);
    else server.listen(0, "127.0.0.1", onListening);
  });
}

/* --------------------------------------------------------- frame decoding */

// Every scenario below reads through `for await...of` and stops with `break`
// rather than calling `.next()` directly and walking away: `break` (like a
// thrown error) makes the runtime call the generator's own `return()`, which
// is what actually runs its `finally` and tears the socket down. A bare
// `.next()` leaves the generator merely suspended mid-loop, forever, and nothing
// after it in the test — including the server's own `close()` — ever resolves.

test("openRuntimeDownlink decodes a single small text frame", async () => {
  const server = await startRawDownlinkServer();
  server.onConnection((socket) => socket.write(serverTextFrame(JSON.stringify({ hello: "world" }))));
  const controller = new AbortController();
  try {
    for await (const frame of openRuntimeDownlink({ url: server.url }, "/api/events.mux", { signal: controller.signal })) {
      assert.deepEqual(frame, { hello: "world" });
      break;
    }
  } finally {
    controller.abort();
    await server.close();
  }
});

test("openRuntimeDownlink decodes a frame using the 16-bit extended length form", async () => {
  const server = await startRawDownlinkServer();
  const big = { padding: "x".repeat(400) };
  server.onConnection((socket) => socket.write(serverTextFrame(JSON.stringify(big))));
  const controller = new AbortController();
  try {
    for await (const frame of openRuntimeDownlink({ url: server.url }, "/api/events.mux", { signal: controller.signal })) {
      assert.deepEqual(frame, big);
      break;
    }
  } finally {
    controller.abort();
    await server.close();
  }
});

test("openRuntimeDownlink decodes two frames coalesced into one TCP chunk", async () => {
  const server = await startRawDownlinkServer();
  server.onConnection((socket) => {
    socket.write(Buffer.concat([serverTextFrame(JSON.stringify({ n: 1 })), serverTextFrame(JSON.stringify({ n: 2 }))]));
  });
  const controller = new AbortController();
  try {
    const seen = [];
    for await (const frame of openRuntimeDownlink({ url: server.url }, "/api/events.mux", { signal: controller.signal })) {
      seen.push(frame);
      if (seen.length === 2) break;
    }
    assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  } finally {
    controller.abort();
    await server.close();
  }
});

test("openRuntimeDownlink decodes one frame split across multiple TCP chunks", async () => {
  const server = await startRawDownlinkServer();
  const frame = serverTextFrame(JSON.stringify({ split: true, tail: "y".repeat(50) }));
  const cut = Math.floor(frame.length / 2);
  server.onConnection((socket) => {
    socket.write(frame.subarray(0, cut));
    setTimeout(() => socket.write(frame.subarray(cut)), 20);
  });
  const controller = new AbortController();
  try {
    for await (const value of openRuntimeDownlink({ url: server.url }, "/api/events.mux", { signal: controller.signal })) {
      assert.deepEqual(value, { split: true, tail: "y".repeat(50) });
      break;
    }
  } finally {
    controller.abort();
    await server.close();
  }
});

test("openRuntimeDownlink answers a ping with a pong echoing the same payload", async () => {
  const server = await startRawDownlinkServer();
  /** @type {(frame: { opcode: number, payload: Buffer }) => void} */
  let onClientFrame = () => {};
  server.onConnection((socket) => {
    socket.once("data", (chunk) => onClientFrame(decodeClientFrame(chunk)));
    socket.write(serverFrame(0x9, "ping-body"));
  });
  const pong = new Promise((resolve) => {
    onClientFrame = resolve;
  });
  const controller = new AbortController();
  const iterator = openRuntimeDownlink({ url: server.url }, "/api/events.mux", { signal: controller.signal })[Symbol.asyncIterator]();
  try {
    // No frame is coming, only a ping — the generator stays suspended
    // awaiting one until this test is done asserting. It is suspended on an
    // internal `await`, not on a `yield`, so unlike the `break` pattern the
    // other tests use, `.return()` here cannot interrupt it directly: `abort()`
    // is what actually unblocks the pending `next()` below.
    const framePromise = iterator.next();
    const received = await pong;
    assert.equal(received.opcode, 0xa);
    assert.equal(received.payload.toString("utf8"), "ping-body");
    controller.abort();
    const { done } = await framePromise;
    assert.equal(done, true);
  } finally {
    controller.abort();
    await server.close();
  }
});

test("openRuntimeDownlink ends cleanly, without throwing, when the peer closes the connection", async () => {
  const server = await startRawDownlinkServer();
  server.onConnection((socket) => {
    socket.write(serverTextFrame(JSON.stringify({ first: true })));
    setTimeout(() => socket.end(), 20);
  });
  const controller = new AbortController();
  try {
    const seen = [];
    for await (const frame of openRuntimeDownlink({ url: server.url }, "/api/events.mux", { signal: controller.signal })) {
      seen.push(frame);
    }
    assert.deepEqual(seen, [{ first: true }]);
  } finally {
    controller.abort();
    await server.close();
  }
});

test("openRuntimeDownlink throws when the peer answers HTTP instead of upgrading", async () => {
  const mock = await startMockDshRuntime();
  const controller = new AbortController();
  try {
    await assert.rejects(async () => {
      // A GET carrying upgrade headers at a path the mock does not treat as a
      // downlink — its own upgrade handler answers a raw, non-101 response,
      // exactly what a misrouted or misconfigured runtime URL would produce.
      for await (const _frame of openRuntimeDownlink({ url: mock.url }, "/api/host.describe", { signal: controller.signal })) {
        assert.fail("expected no frames");
      }
    });
  } finally {
    controller.abort();
    await mock.close();
  }
});

test("openRuntimeDownlink stops without hanging when the signal aborts before any frame arrives", async () => {
  const server = await startRawDownlinkServer();
  server.onConnection(() => {}); // never sends anything
  const controller = new AbortController();
  const iterator = openRuntimeDownlink({ url: server.url }, "/api/events.mux", { signal: controller.signal })[Symbol.asyncIterator]();
  const next = iterator.next();
  controller.abort();
  const { done } = await next;
  assert.equal(done, true);
  await server.close();
});

test("openRuntimeDownlink dials over a unix socket the same way requestRuntime does", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "dsh-downlink-uds-"));
  const socketPath = path.join(tmp, "runtime.sock");
  const server = await startRawDownlinkServer({ socketPath });
  server.onConnection((socket) => socket.write(serverTextFrame(JSON.stringify({ viaUnixSocket: true }))));
  const controller = new AbortController();
  try {
    for await (const frame of openRuntimeDownlink({ url: server.url, socketPath }, "/api/events.mux", { signal: controller.signal })) {
      assert.deepEqual(frame, { viaUnixSocket: true });
      break;
    }
  } finally {
    controller.abort();
    await server.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- RuntimeEventPump */

function fakeRunEvents() {
  const hub = new RunEventHub();
  return hub;
}

test("RuntimeEventPump routes a decoded run/event to the run its session belongs to", async () => {
  const runEvents = fakeRunEvents();
  /** @type {(sessionId: string, event: Record<string, any>) => void} */
  let push = () => {};
  const fakeOpenDownlink = async function* fakeOpenDownlink(_runtime, _path, { signal }) {
    /** @type {any[]} */
    const queue = [];
    push = (frame) => queue.push(frame);
    while (!signal.aborted) {
      if (queue.length) yield queue.shift();
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, openDownlink: fakeOpenDownlink });
  const project = { userId: "alice", id: "paper-1" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-1", sessionId: "s-1", status: "running" });

  push({ type: "server-request", rpcId: "x", method: "session/event", payload: { type: "session/event", sessionId: "s-1", event: { type: "turn/start", seq: 1, data: { turn: 1 } } } });

  await waitFor(() => runEvents.channel("run-1").buffer.some((entry) => entry.type === "run/event"));
  const published = runEvents.channel("run-1").buffer.find((entry) => entry.type === "run/event");
  assert.deepEqual(published.data.event, { type: "turn/start", seq: 1, turn: 1 });
  pump.detach(project);
});

test("RuntimeEventPump drops an event for a session it has not been told about, without throwing", async () => {
  const runEvents = fakeRunEvents();
  let push = () => {};
  const fakeOpenDownlink = async function* fakeOpenDownlink(_runtime, _path, { signal }) {
    const queue = [];
    push = (frame) => queue.push(frame);
    while (!signal.aborted) {
      if (queue.length) yield queue.shift();
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, openDownlink: fakeOpenDownlink });
  const project = { userId: "alice", id: "paper-2" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  // Deliberately no noteRun(): "s-unknown" is not routable yet.
  push({ type: "session/event", sessionId: "s-unknown", event: { type: "turn/start", seq: 1, data: { turn: 1 } } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runEvents.channel("run-2").buffer.length, 0);
  pump.detach(project);
});

test("RuntimeEventPump publishes subagent/update when a subagent's own session ends", async () => {
  const runEvents = fakeRunEvents();
  let push = () => {};
  const fakeOpenDownlink = async function* fakeOpenDownlink(_runtime, _path, { signal }) {
    const queue = [];
    push = (frame) => queue.push(frame);
    while (!signal.aborted) {
      if (queue.length) yield queue.shift();
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, openDownlink: fakeOpenDownlink });
  const project = { userId: "alice", id: "paper-3" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-3", sessionId: "s-root", status: "running" });

  push({
    type: "session/event",
    sessionId: "s-root",
    event: { type: "subagent/descriptor", seq: 1, data: { sessionId: "s-child", capability: "adr-analysis", label: "ADR 分析" } },
  });
  await waitFor(() => runEvents.channel("run-3").buffer.some((entry) => entry.type === "run/event" && entry.data.event.type === "subagent/started"));

  // The root session's own turn ending must not be mistaken for a subagent update.
  push({ type: "session/event", sessionId: "s-root", event: { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runEvents.channel("run-3").buffer.some((entry) => entry.type === "subagent/update"), false);

  push({ type: "session/event", sessionId: "s-child", event: { type: "turn/end", seq: 3, data: { reason: { kind: "completed" } } } });
  await waitFor(() => runEvents.channel("run-3").buffer.some((entry) => entry.type === "subagent/update"));
  const update = runEvents.channel("run-3").buffer.find((entry) => entry.type === "subagent/update");
  assert.deepEqual(update.data, { childSessionId: "s-child", label: "ADR 分析", capability: "adr-analysis", status: "completed" });
  pump.detach(project);
});

test("RuntimeEventPump never dials when the OpenCode kernel is selected", async () => {
  const runEvents = fakeRunEvents();
  let called = false;
  const fakeOpenDownlink = async function fakeOpenDownlink() {
    called = true;
  };
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: false, openDownlink: fakeOpenDownlink });
  pump.attach({ userId: "alice", id: "paper-4" }, { url: "http://127.0.0.1:1" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(called, false);
});

test("RuntimeEventPump stops publishing once a project is detached", async () => {
  const runEvents = fakeRunEvents();
  let push = () => {};
  let aborted = false;
  const fakeOpenDownlink = async function* fakeOpenDownlink(_runtime, _path, { signal }) {
    const queue = [];
    push = (frame) => queue.push(frame);
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    while (!signal.aborted) {
      if (queue.length) yield queue.shift();
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, openDownlink: fakeOpenDownlink });
  const project = { userId: "alice", id: "paper-5" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-5", sessionId: "s-1", status: "running" });
  push({ type: "session/event", sessionId: "s-1", event: { type: "turn/start", seq: 1, data: { turn: 1 } } });
  await waitFor(() => runEvents.channel("run-5").buffer.length > 0);

  pump.detach(project);
  await waitFor(() => aborted);
  const countAfterDetach = runEvents.channel("run-5").buffer.length;
  push({ type: "session/event", sessionId: "s-1", event: { type: "turn/start", seq: 2, data: { turn: 2 } } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runEvents.channel("run-5").buffer.length, countAfterDetach);
});

test("RuntimeEventPump reconnects after a dropped downlink instead of giving up", async () => {
  const runEvents = fakeRunEvents();
  let attempt = 0;
  const fakeOpenDownlink = async function* fakeOpenDownlink(_runtime, _path, { signal }) {
    attempt += 1;
    if (attempt === 1) throw new Error("simulated first-connection failure");
    yield { type: "session/event", sessionId: "s-1", event: { type: "turn/start", seq: 1, data: { turn: 1 } } };
    await new Promise((resolve) => {
      signal.addEventListener("abort", resolve, { once: true });
    });
  };
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, openDownlink: fakeOpenDownlink, reconnectDelayMs: 10 });
  const project = { userId: "alice", id: "paper-6" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-6", sessionId: "s-1", status: "running" });
  await waitFor(() => runEvents.channel("run-6").buffer.length > 0);
  assert.ok(attempt >= 2, "the second attempt is what actually delivered the event");
  pump.detach(project);
});

/* -------------------------------------------- end to end, via the mock kernel */

test("a real turn through the mock DSH kernel reaches the SSE channel as run/event", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "dsh-event-pump-e2e-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const project = {
    id: "paper-e2e",
    userId: "alice",
    rootDir,
    metaDir: path.join(rootDir, ".openscience"),
    workspaceDir: path.join(rootDir, "workspace"),
    runtimeDir: path.join(rootDir, "runtime"),
  };

  const runEvents = new RunEventHub();
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, reconnectDelayMs: 20 });
  const manager = new RuntimeManager(
    { runtimeKernel: "dsh", allowMockRuntime: true, production: false },
    { onRuntimeStart: (proj, runtime) => pump.attach(proj, runtime) },
  );
  t.after(async () => {
    pump.detach(project);
    await manager.closeAll();
  });

  await manager.start(project);
  pump.noteRun(project, { id: "run-e2e", sessionId: "s-e2e", status: "running" });

  await manager.dshDispatchPrompt(project, "s-e2e", { text: "hello from the pump test" });

  await waitFor(() => runEvents.channel("run-e2e").buffer.some((entry) => entry.type === "run/event" && entry.data.event.type === "message/assistant"));
  const kinds = runEvents.channel("run-e2e").buffer.filter((entry) => entry.type === "run/event").map((entry) => entry.data.event.type);
  assert.ok(kinds.includes("turn/start"), kinds.join(","));
  assert.ok(kinds.includes("message/user"), kinds.join(","));
  assert.ok(kinds.includes("tool/call"), kinds.join(","));
  assert.ok(kinds.includes("tool/result"), kinds.join(","));
  assert.ok(kinds.includes("turn/end"), kinds.join(","));
});
