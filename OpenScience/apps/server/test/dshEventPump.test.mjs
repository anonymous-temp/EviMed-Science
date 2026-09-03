import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DshMux } from "../src/dshMux.mjs";
import { openRuntimeMux, RUNTIME_DOWNLINK_RECONNECT_MS, RuntimeEventPump } from "../src/dshEventPump.mjs";
import { startMockDshRuntime } from "../src/mockDshRuntime.mjs";
import { RunEventHub } from "../src/runEventStream.mjs";

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}.`);
}

/**
 * A mux whose logical streams a test drives by hand.
 *
 * It is the whole 0.1.2 change in miniature: `open()` is called once per
 * logical stream, the caller says which session it wants in the arguments, and
 * nothing that comes back afterwards carries a session id. A fake that answered
 * one shared stream — as the 0.1.1 downlink did — would let a pump that never
 * opened a second one look correct.
 */
class FakeMux {
  constructor() {
    /** @type {{ endpoint: string, sessionId: string | null, push: (value: any) => void, finish: () => void, ended: boolean }[]} */
    this.streams = [];
    this.closeCount = 0;
  }

  /** @param {string} endpoint @param {Record<string, any>} args @param {{ signal: AbortSignal }} options */
  async *open(endpoint, args, { signal }) {
    const sessionId = args?.request?.address?.sessionId ?? null;
    /** @type {any[]} */
    const queue = [];
    /** @type {(() => void) | null} */
    let wake = null;
    let done = false;
    const nudge = () => { const w = wake; wake = null; w?.(); };
    const entry = {
      endpoint,
      sessionId,
      ended: false,
      push: (value) => { queue.push(value); nudge(); },
      finish: () => { done = true; nudge(); },
    };
    this.streams.push(entry);
    const onAbort = () => { done = true; nudge(); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        if (done || signal.aborted) return;
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      entry.ended = true;
    }
  }

  close() { this.closeCount += 1; }

  /** @param {string} sessionId */
  follow(sessionId) {
    return this.streams.find((stream) => stream.endpoint === "session/follow" && stream.sessionId === sessionId && !stream.ended) ?? null;
  }

  get followedSessions() {
    return this.streams.filter((stream) => stream.endpoint === "session/follow" && !stream.ended).map((stream) => stream.sessionId);
  }
}

/** One `session/follow` frame, in the wire's own shape: no session id inside it. */
const sessionEvent = (event) => ({ type: "event", event });

/**
 * Attaches a pump backed by one FakeMux and gives the test the mux back.
 * @param {{ reconnectDelayMs?: number, onOpen?: (mux: FakeMux, attempt: number) => void }} [options]
 */
function pumpOnFakeMux(options = {}) {
  const runEvents = new RunEventHub();
  /** @type {FakeMux[]} */
  const muxes = [];
  let attempts = 0;
  const openMux = async () => {
    attempts += 1;
    const mux = new FakeMux();
    options.onOpen?.(mux, attempts);
    muxes.push(mux);
    return mux;
  };
  const pump = new RuntimeEventPump({
    runEvents,
    isDshKernel: true,
    openMux,
    ...(options.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: options.reconnectDelayMs }),
  });
  return { runEvents, pump, muxes, attemptCount: () => attempts };
}

const eventsOf = (runEvents, runId) => runEvents.channel(runId).buffer.filter((entry) => entry.type === "run/event").map((entry) => entry.data.event);

/* ---------------------------------------------------------------- routing */

test("a decoded run/event reaches the run whose session's stream it arrived on", async () => {
  const { runEvents, pump, muxes } = pumpOnFakeMux();
  const project = { userId: "alice", id: "paper-1" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-1", sessionId: "s-1", status: "running" });

  await waitFor(() => muxes[0]?.follow("s-1"), "a follow stream for the run's session");
  // The host stream is opened too, on the same mux, and it is the only stream
  // that is not a session's.
  assert.ok(muxes[0].streams.some((stream) => stream.endpoint === "$events"));

  muxes[0].follow("s-1").push(sessionEvent({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }));
  await waitFor(() => eventsOf(runEvents, "run-1").length > 0, "the published run/event");
  assert.deepEqual(eventsOf(runEvents, "run-1")[0], { type: "turn/start", seq: 1, turn: 1 });
  pump.detach(project);
});

test("two runs on one mux never receive each other's events", async () => {
  // The attribution is the pump's now: the frame does not say which session it
  // came from, only which stream did.
  const { runEvents, pump, muxes } = pumpOnFakeMux();
  const project = { userId: "alice", id: "paper-2" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-a", sessionId: "s-a", status: "running" });
  pump.noteRun(project, { id: "run-b", sessionId: "s-b", status: "running" });

  await waitFor(() => muxes[0]?.follow("s-a") && muxes[0]?.follow("s-b"), "a follow stream for each run");
  muxes[0].follow("s-a").push(sessionEvent({ type: "turn/start", seq: 1, data: { turn: 7 } }));
  muxes[0].follow("s-b").push(sessionEvent({ type: "turn/start", seq: 1, data: { turn: 9 } }));

  await waitFor(() => eventsOf(runEvents, "run-a").length && eventsOf(runEvents, "run-b").length, "both runs' events");
  assert.equal(eventsOf(runEvents, "run-a")[0].turn, 7);
  assert.equal(eventsOf(runEvents, "run-b")[0].turn, 9);
  assert.equal(eventsOf(runEvents, "run-a").length, 1, "one run's channel must not also carry the other's");
  assert.equal(eventsOf(runEvents, "run-b").length, 1);
  pump.detach(project);
});

test("a run the ledger notes after the mux is already up gets its own follow stream", async () => {
  // The reconciliation, which is new in 0.1.2 and has no 0.1.1 equivalent.
  // Before, one stream carried every session and the map was only a routing
  // table, so a run that started after the connection was made needed nothing.
  // Now a stream has to be opened per session, and a pump that only followed
  // what existed at connect time would publish **nothing at all** for every run
  // started afterwards — which is every run, on a long-lived runtime.
  const { runEvents, pump, muxes } = pumpOnFakeMux();
  const project = { userId: "alice", id: "paper-3" };
  pump.attach(project, { url: "http://127.0.0.1:1" });

  // Wait for the connection to be fully up with no session known to it.
  await waitFor(() => muxes[0]?.streams.some((stream) => stream.endpoint === "$events"), "the host stream");
  assert.deepEqual(muxes[0].followedSessions, [], "nothing to follow yet, which is the state this test starts from");

  pump.noteRun(project, { id: "run-late", sessionId: "s-late", status: "running" });
  await waitFor(() => muxes[0].follow("s-late"), "a follow stream opened for the run noted mid-connection");
  assert.deepEqual(muxes[0].followedSessions, ["s-late"]);

  muxes[0].follow("s-late").push(sessionEvent({ type: "assistant/message", seq: 4, data: { message: { content: [{ type: "text", text: "迟到但在" }] } } }));
  await waitFor(() => eventsOf(runEvents, "run-late").length > 0, "the late run's first event");
  assert.equal(eventsOf(runEvents, "run-late")[0].text, "迟到但在");

  // And the reverse edge of the same reconciliation: a run that stops is
  // unfollowed, rather than leaving a stream open on a session id a later,
  // unrelated run might reuse.
  const stream = muxes[0].follow("s-late");
  pump.noteRun(project, { id: "run-late", sessionId: "s-late", status: "succeeded" });
  await waitFor(() => stream.ended, "the follow stream to be closed when the run stops");
  assert.deepEqual(muxes[0].followedSessions, []);
  pump.detach(project);
});

test("a subagent discovered mid-run is followed, and its own turn ending becomes a subagent/update", async () => {
  const { runEvents, pump, muxes } = pumpOnFakeMux();
  const project = { userId: "alice", id: "paper-4" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-4", sessionId: "s-root", status: "running" });
  await waitFor(() => muxes[0]?.follow("s-root"), "the root session's stream");

  muxes[0].follow("s-root").push(sessionEvent({
    type: "subagent/descriptor",
    seq: 1,
    data: { sessionId: "s-child", capability: "adr-analysis", label: "ADR 分析" },
  }));
  // The subagent's session is not in the ledger; it is discovered on the
  // parent's stream, so only this reconciliation can ever open a stream for it.
  await waitFor(() => muxes[0].follow("s-child"), "a follow stream for the subagent's own session");

  // The root session's own turn ending must not be mistaken for a subagent update.
  muxes[0].follow("s-root").push(sessionEvent({ type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } }));
  await waitFor(() => eventsOf(runEvents, "run-4").some((event) => event.type === "turn/end"), "the root turn/end");
  assert.equal(runEvents.channel("run-4").buffer.some((entry) => entry.type === "subagent/update"), false);

  muxes[0].follow("s-child").push(sessionEvent({ type: "turn/end", seq: 3, data: { reason: { kind: "completed" } } }));
  await waitFor(() => runEvents.channel("run-4").buffer.some((entry) => entry.type === "subagent/update"), "the subagent update");
  const update = runEvents.channel("run-4").buffer.find((entry) => entry.type === "subagent/update");
  assert.deepEqual(update.data, { childSessionId: "s-child", label: "ADR 分析", capability: "adr-analysis", status: "completed" });
  pump.detach(project);
});

test("a session the pump was never told about is not followed, and its events go nowhere", async () => {
  const { runEvents, pump, muxes } = pumpOnFakeMux();
  const project = { userId: "alice", id: "paper-5" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  await waitFor(() => muxes[0]?.streams.some((stream) => stream.endpoint === "$events"), "the host stream");
  // Deliberately no noteRun(): nothing opens a stream for "s-unknown" at all,
  // which in 0.1.2 is what "not routable" means.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(muxes[0].follow("s-unknown"), null);
  assert.equal(runEvents.channel("run-5").buffer.length, 0);
  pump.detach(project);
});

test("detaching a project ends every stream on its mux and closes the socket", async () => {
  const { runEvents, pump, muxes } = pumpOnFakeMux();
  const project = { userId: "alice", id: "paper-6" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-6", sessionId: "s-1", status: "running" });
  await waitFor(() => muxes[0]?.follow("s-1"), "the follow stream");
  const stream = muxes[0].follow("s-1");
  stream.push(sessionEvent({ type: "turn/start", seq: 1, data: { turn: 1 } }));
  await waitFor(() => eventsOf(runEvents, "run-6").length > 0, "the first event");

  pump.detach(project);
  await waitFor(() => stream.ended, "the follow stream to end");
  await waitFor(() => muxes[0].closeCount > 0, "the mux to be closed");

  const before = runEvents.channel("run-6").buffer.length;
  stream.push(sessionEvent({ type: "turn/start", seq: 2, data: { turn: 2 } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runEvents.channel("run-6").buffer.length, before, "a detached project publishes nothing further");
});

test("a dropped mux reconnects and reopens a stream for every session still wanted", async () => {
  // A run does not fail because this side dropped: `session/prompt` and
  // `session/page` are unary calls this pump never touches. What it does have
  // to do is come back with the same set of follows, since the sessions did not
  // go anywhere while the socket was down.
  const { runEvents, pump, muxes, attemptCount } = pumpOnFakeMux({
    reconnectDelayMs: 10,
    onOpen: (_mux, attempt) => {
      if (attempt === 1) throw new Error("simulated first-connection failure");
    },
  });
  const project = { userId: "alice", id: "paper-7" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-7", sessionId: "s-1", status: "running" });

  await waitFor(() => muxes[0]?.follow("s-1"), "a follow stream on the second attempt");
  assert.ok(attemptCount() >= 2, "the second attempt is what actually opened the stream");
  muxes[0].follow("s-1").push(sessionEvent({ type: "turn/start", seq: 1, data: { turn: 1 } }));
  await waitFor(() => eventsOf(runEvents, "run-7").length === 1, "the first event");

  // Kill the connection under it: every stream on that generation ends.
  for (const stream of muxes[0].streams) stream.finish();
  await waitFor(() => muxes.length >= 2 && muxes[1].follow("s-1"), "a rebuilt follow stream after the drop");
  muxes[1].follow("s-1").push(sessionEvent({ type: "turn/start", seq: 2, data: { turn: 2 } }));
  await waitFor(() => eventsOf(runEvents, "run-7").length === 2, "an event over the rebuilt connection");
  assert.deepEqual(eventsOf(runEvents, "run-7").map((event) => event.turn), [1, 2]);
  pump.detach(project);
});

test("the pump never dials when the OpenCode kernel is selected", async () => {
  const runEvents = new RunEventHub();
  let called = false;
  const pump = new RuntimeEventPump({
    runEvents,
    isDshKernel: false,
    openMux: async () => { called = true; return new FakeMux(); },
  });
  pump.attach({ userId: "alice", id: "paper-8" }, { url: "http://127.0.0.1:1" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(called, false, "the OpenCode kernel publishes no such stream; dialling it is a permanent retry for no reader");
});

test("attaching a project twice does not open a second mux", async () => {
  const { pump, muxes, attemptCount } = pumpOnFakeMux();
  const project = { userId: "alice", id: "paper-9" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.attach(project, { url: "http://127.0.0.1:1" });
  await waitFor(() => muxes.length >= 1, "the first mux");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attemptCount(), 1);
  pump.detach(project);
});

test("the reconnect delay is a named constant, not a number in a loop", () => {
  assert.equal(RUNTIME_DOWNLINK_RECONNECT_MS, 2_000);
});

/* -------------------------------------------- end to end, via the mock kernel */

test("a real turn through the mock DSH kernel reaches the SSE channel as run/event", async (t) => {
  // Everything above this line runs on a fake mux. This one runs on a real
  // WebSocket to a kernel that speaks 0.1.2 and refuses an unauthenticated
  // connection — so the cookie, the handshake, the frame codec, the stream
  // multiplexing, the per-session attribution and the decode are all in the
  // path exactly once.
  const rootDir = await mkdtemp(path.join(tmpdir(), "dsh-event-pump-e2e-"));
  const mock = await startMockDshRuntime();
  t.after(async () => {
    await mock.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  /** @param {string} method @param {Record<string, any>} args */
  const callKernel = async (method, args) => {
    const response = await fetch(`${mock.url}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mock.cookie },
      body: JSON.stringify({ type: "client-request", rpcId: `e2e_${method}`, method, payload: { args } }),
    });
    assert.equal(response.status, 200, `${method} answered HTTP ${response.status}`);
    const envelope = await response.json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope));
    return envelope.result.value;
  };

  const workspaceDir = path.join(rootDir, "workspace");
  await callKernel("session/create", { request: { sessionId: "s-e2e", cwd: workspaceDir, agentPreset: "evimed-universal" } });

  const runEvents = new RunEventHub();
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, reconnectDelayMs: 20 });
  const project = { userId: "alice", id: "paper-e2e" };
  t.after(() => pump.detach(project));

  pump.attach(project, { url: mock.url, authority: mock.authority, cookie: mock.cookie });
  pump.noteRun(project, { id: "run-e2e", sessionId: "s-e2e", status: "running" });

  await callKernel("session/prompt", {
    request: { requestId: "req-e2e", sessionId: "s-e2e", mode: "queue", content: [{ type: "text", text: "hello from the pump test" }] },
  });

  await waitFor(
    () => eventsOf(runEvents, "run-e2e").some((event) => event.type === "message/assistant"),
    "the assistant message to arrive over the real mux",
  );
  const kinds = eventsOf(runEvents, "run-e2e").map((event) => event.type);
  for (const expected of ["turn/start", "message/user", "tool/call", "tool/result", "turn/end"]) {
    assert.ok(kinds.includes(expected), `${expected} missing from ${kinds.join(",")}`);
  }
  const toolResult = eventsOf(runEvents, "run-e2e").find((event) => event.type === "tool/result");
  assert.equal(toolResult.status, "completed");
  assert.match(toolResult.output, /mock-agent-artifact\.md/);
});

test("the pump refuses to publish anything when its cookie is wrong, rather than reconnecting in silence", async (t) => {
  // A pump whose credential is wrong looks, from the browser, exactly like a
  // run that produced nothing. The assertion here is narrow and deliberate: no
  // events, and the mux never upgraded — so the reconnect loop is doing its
  // job and the fix is a credential, not a decoder.
  const mock = await startMockDshRuntime();
  t.after(() => mock.close());
  const runEvents = new RunEventHub();
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, reconnectDelayMs: 20 });
  const project = { userId: "alice", id: "paper-401" };
  t.after(() => pump.detach(project));

  pump.attach(project, { url: mock.url, authority: mock.authority, cookie: null });
  pump.noteRun(project, { id: "run-401", sessionId: "s-401", status: "running" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(runEvents.channel("run-401").buffer.length, 0);

  // Negative control on the same setup: with the cookie, the dial succeeds.
  const mux = await openRuntimeMux({ url: mock.url, authority: mock.authority, cookie: mock.cookie }, { signal: AbortSignal.timeout(5_000) });
  assert.equal(mux.closed, false);
  mux.close();
});

test("the mock refuses the arguments the live kernel refuses on workspace/follow", async (t) => {
  // 0.1.2-alpha.5 answers `gateway/arguments-invalid: unexpected "request"` and
  // kills the stream; through alpha.3 the same call was accepted. This mock
  // ignored args entirely, so the old spelling passed here and died on frame
  // one against a real kernel — the recorder found it, not the suite.
  const mock = await startMockDshRuntime();
  t.after(() => mock.close());
  const mux = new DshMux({ url: mock.url, cookie: mock.cookie ?? null });
  const controller = new AbortController();
  t.after(() => { controller.abort(); mux.close(); });
  await mux.connect({ signal: controller.signal });

  // Bounded by its own signal, so "the mock accepted it" fails as a red
  // assertion rather than as a test that waits for a frame nobody will send.
  const probe = new AbortController();
  const giveUp = setTimeout(() => probe.abort(), 2_000);
  let refusal = null;
  try {
    for await (const value of mux.open("workspace/follow", { request: { cwd: "/workspace" } }, { signal: probe.signal })) {
      void value;
    }
  } catch (error) {
    refusal = /** @type {any} */ (error)?.code ?? null;
  } finally {
    clearTimeout(giveUp);
  }
  assert.equal(
    refusal,
    "gateway/arguments-invalid",
    "an argument the descriptor does not have must fail here, not only in production",
  );

  /** @type {any[]} */
  const accepted = [];
  for await (const value of mux.open("workspace/follow", {}, { signal: controller.signal })) {
    accepted.push(value);
    break;
  }
  assert.equal(accepted[0]?.type, "baseline", "the call the descriptor does accept still yields its baseline");
});
