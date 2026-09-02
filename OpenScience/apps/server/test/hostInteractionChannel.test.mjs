// The kernel's two questions, and what happens to a run when nobody answers.
//
// `approval/requested` and `question/requested` have been in
// `RUN_STREAM_EVENT_TYPES` and had a panel in the browser since the migration,
// with no publisher on either side: the pump called `watchHost` without an
// `onEvent`, so every waterfall frame was decoded and dropped. A hosted
// deployment runs `approval: never` and never notices; the local `evimed-web`
// profile runs `approval: ask`, where it meant the run stopped at its first
// escalation and nothing said why.
//
// The frames below are not invented. They were recorded from a running
// 0.1.2-alpha.3 kernel driven into a sandbox escalation, and the reply shape
// was probed against the same binary including its refusals — an earlier
// fixture in `packages/contracts/dsh` guessed the event name
// (`tools/pre-execute`) and would have had us build against a frame the kernel
// never sends.
import assert from "node:assert/strict";
import test from "node:test";

import { decodeHostInteraction } from "../src/dshRuntimeAdapter.mjs";
import { RuntimeEventPump } from "../src/dshEventPump.mjs";
import { RunEventHub } from "../src/runEventStream.mjs";

/** Recorded live: DSH 0.1.2-alpha.3, prompt driven into a sandbox escalation. */
const RECORDED_APPROVAL_FRAME = Object.freeze({
  type: "waterfall",
  event: "approval/request",
  eventId: "ba9a5930-0777-4a92-9f57-b7125b096a73",
  agentId: "session-acbc4383-d06e-4ab5-b86c-51983c4b0845",
  request: {
    toolName: "bash",
    callId: "call_00_KkRYuEuQwwHSHuhOSWol7177",
    reason: "escalate sandbox to danger-full-access: The user explicitly requested running `cat /etc/shadow`, which requires reading outside the workspace sandbox.",
  },
});

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}.`);
}

/**
 * A mux that also records every unary call the pump makes, because the reply
 * to a waterfall is a call and "did not answer" is the failure under test.
 */
class RecordingMux {
  constructor() {
    this.streams = [];
    this.closeCount = 0;
  }

  async *open(endpoint, args, { signal }) {
    const queue = [];
    let wake = null;
    let done = false;
    const nudge = () => { const w = wake; wake = null; w?.(); };
    const entry = {
      endpoint,
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

  host() { return this.streams.find((s) => s.endpoint === "$events" && !s.ended) ?? null; }
}

/**
 * Builds a pump whose unary calls are captured rather than sent.
 *
 * The pump constructs its own transport from the runtime record, so the seam a
 * test can reach is the module-level HTTP caller. It is replaced here through
 * the same injection point the mux uses, keeping the pump's own wiring under
 * test rather than stubbed out.
 */
function pumpWithRecordedCalls() {
  const runEvents = new RunEventHub();
  const muxes = [];
  /** @type {{ method: string, args: Record<string, any> }[]} */
  const calls = [];
  const openMux = async () => {
    const mux = new RecordingMux();
    muxes.push(mux);
    return mux;
  };
  const callUnary = async (_runtime, method, args) => {
    calls.push({ method, args });
    return { ok: true, value: undefined };
  };
  const pump = new RuntimeEventPump({ runEvents, isDshKernel: true, openMux, callUnary });
  return { runEvents, pump, muxes, calls };
}

/** Every reply the pump sent for one kernel event id. */
const repliesFor = (calls, eventId) =>
  calls.filter((call) => call.method === "$events/result" && call.args.eventId === eventId);

/** Pushes the `ready` frame the gateway always sends first, carrying the client id. */
const ready = (clientId = "client-1") => ({ type: "ready", clientId, host: { home: "/runtime/dsh-home" } });

/* ------------------------------------------------------------- decoding */

test("the recorded approval frame decodes, and its agentId is the session id", () => {
  const decoded = decodeHostInteraction(RECORDED_APPROVAL_FRAME);
  assert.equal(decoded.kind, "approval");
  assert.equal(decoded.eventId, "ba9a5930-0777-4a92-9f57-b7125b096a73");
  // The field is named `agentId`, and reading it as an opaque agent handle
  // rather than the session id is the mistake that makes every question
  // unroutable while looking decoded.
  assert.equal(decoded.sessionId, "session-acbc4383-d06e-4ab5-b86c-51983c4b0845");
  assert.equal(decoded.request.toolName, "bash");
  assert.match(decoded.request.reason, /escalate sandbox/);
});

test("the other waterfall the kernel sends is the user question", () => {
  const decoded = decodeHostInteraction({ ...RECORDED_APPROVAL_FRAME, event: "user-questions/request" });
  assert.equal(decoded.kind, "question");
});

test("a withdrawal decodes as one, and an emit or unknown waterfall decodes as nothing", () => {
  assert.deepEqual(decodeHostInteraction({ type: "cancel", eventId: "e-1" }), { kind: "withdrawn", eventId: "e-1" });
  assert.equal(decodeHostInteraction({ type: "emit", event: "api-session/status", args: ["s", true] }), null);
  // Not decoded into a guess: an unlisted waterfall gets declined by the
  // caller, which is the only answer that neither invents a decision nor
  // leaves the kernel holding the tool call open.
  assert.equal(decodeHostInteraction({ type: "waterfall", event: "future/thing", eventId: "e-2" }), null);
});

/* -------------------------------------------------------------- routing */

test("an approval on a running run's session reaches that run's stream", async () => {
  const { runEvents, pump, muxes } = pumpWithRecordedCalls();
  const project = { userId: "alice", id: "p-1" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-1", sessionId: RECORDED_APPROVAL_FRAME.agentId, status: "running" });

  await waitFor(() => muxes[0]?.host(), "the host stream");
  muxes[0].host().push(ready());
  muxes[0].host().push(RECORDED_APPROVAL_FRAME);

  await waitFor(
    () => runEvents.channel("run-1").buffer.some((e) => e.type === "approval/requested"),
    "the published approval/requested",
  );
  const published = runEvents.channel("run-1").buffer.find((e) => e.type === "approval/requested");
  assert.equal(published.data.status, "pending");
  assert.equal(published.data.eventId, RECORDED_APPROVAL_FRAME.eventId);
  assert.equal(published.data.request.toolName, "bash");
  pump.detach(project);
});

test("a question for a session belonging to no live run is declined, never dropped", async () => {
  // The kernel holds the tool call open until every client it delivered to
  // replies. Dropping an unroutable question stalls the run for as long as it
  // is ignored, which is indistinguishable from the kernel being slow.
  const { pump, muxes, calls } = pumpWithRecordedCalls();
  const project = { userId: "alice", id: "p-2" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  await waitFor(() => muxes[0]?.host(), "the host stream");

  const state = pump.projects.get("alice:p-2");
  muxes[0].host().push(ready());
  // No noteRun, so the frame's session maps to nothing.
  muxes[0].host().push(RECORDED_APPROVAL_FRAME);

  await waitFor(() => repliesFor(calls, RECORDED_APPROVAL_FRAME.eventId).length > 0, "the decline");
  const [decline] = repliesFor(calls, RECORDED_APPROVAL_FRAME.eventId);
  // `next` is the gateway's "this client declines"; it settles the waterfall
  // only once every delivered client has said it, which is what hands the
  // decision back to the kernel's own fail-closed default.
  assert.deepEqual(decline.args.outcome, { kind: "next" });
  assert.equal(decline.args.clientId, "client-1");
  assert.equal(state.pending.size, 0);
  pump.detach(project);
});

test("an unlisted waterfall event is declined rather than guessed at", async () => {
  const { pump, muxes, calls } = pumpWithRecordedCalls();
  const project = { userId: "alice", id: "p-2b" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  await waitFor(() => muxes[0]?.host(), "the host stream");
  muxes[0].host().push(ready());
  muxes[0].host().push({ type: "waterfall", event: "future/thing", eventId: "e-future", agentId: "s-x", request: {} });

  await waitFor(() => repliesFor(calls, "e-future").length > 0, "the decline for an unknown event");
  assert.deepEqual(repliesFor(calls, "e-future")[0].args.outcome, { kind: "next" });
  pump.detach(project);
});

test("a person's answer reaches the kernel in the kernel's own vocabulary", async () => {
  const { runEvents, pump, muxes, calls } = pumpWithRecordedCalls();
  const project = { userId: "alice", id: "p-2c" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-2c", sessionId: RECORDED_APPROVAL_FRAME.agentId, status: "running" });
  await waitFor(() => muxes[0]?.host(), "the host stream");
  muxes[0].host().push(ready("client-7"));
  muxes[0].host().push(RECORDED_APPROVAL_FRAME);
  await waitFor(() => pump.projects.get("alice:p-2c").pending.size === 1, "the pending question");

  await pump.answerInteraction(project, {
    runId: "run-2c",
    eventId: RECORDED_APPROVAL_FRAME.eventId,
    outcome: { kind: "result", value: "allowed-once" },
  });

  const [reply] = repliesFor(calls, RECORDED_APPROVAL_FRAME.eventId);
  assert.equal(reply.method, "$events/result");
  // Exactly these three keys: the gateway validates the result with exact-key
  // equality and refuses a fourth as "invalid Remote event result".
  assert.deepEqual(Object.keys(reply.args).sort(), ["clientId", "eventId", "outcome"]);
  // The client id comes from the `ready` frame of the connection that
  // delivered the question; a reply carrying any other is refused as
  // identifying no active event stream.
  assert.equal(reply.args.clientId, "client-7");
  assert.deepEqual(reply.args.outcome, { kind: "result", value: "allowed-once" });
  // Answered once and then forgotten, so a second click cannot re-answer an
  // event the kernel has already settled.
  assert.equal(pump.projects.get("alice:p-2c").pending.size, 0);
  assert.ok(runEvents.channel("run-2c").buffer.some((e) => e.type === "approval/requested" && e.data.status === "answered"));
  pump.detach(project);
});

test("a withdrawal clears the pending question and tells the browser", async () => {
  const { runEvents, pump, muxes } = pumpWithRecordedCalls();
  const project = { userId: "alice", id: "p-3" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-3", sessionId: RECORDED_APPROVAL_FRAME.agentId, status: "running" });
  await waitFor(() => muxes[0]?.host(), "the host stream");
  muxes[0].host().push(ready());
  muxes[0].host().push(RECORDED_APPROVAL_FRAME);
  await waitFor(() => pump.projects.get("alice:p-3").pending.size === 1, "the pending question");

  muxes[0].host().push({ type: "cancel", eventId: RECORDED_APPROVAL_FRAME.eventId });
  await waitFor(
    () => runEvents.channel("run-3").buffer.some((e) => e.type === "approval/requested" && e.data.status === "withdrawn"),
    "the withdrawal",
  );
  // The browser has a prompt on screen for a decision that can no longer be
  // delivered; leaving it there gives the user a button that fails when pressed.
  assert.equal(pump.projects.get("alice:p-3").pending.size, 0);
  pump.detach(project);
});

/* -------------------------------------------------------------- answering */

test("answering a question that is not pending fails loudly instead of reporting success", async () => {
  const { pump } = pumpWithRecordedCalls();
  const project = { userId: "alice", id: "p-4" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  await assert.rejects(
    () => pump.answerInteraction(project, { runId: "run-4", eventId: "nope", outcome: { kind: "next" } }),
    (error) => error.code === "interaction_not_pending",
  );
  pump.detach(project);
});

test("a pending question cannot be answered from a different run", async () => {
  // The event id is the kernel's, so a caller can name a real pending question
  // that belongs to somebody else's run; the route can prove the run but not
  // the question, so the pairing is checked here.
  const { pump, muxes } = pumpWithRecordedCalls();
  const project = { userId: "alice", id: "p-5" };
  pump.attach(project, { url: "http://127.0.0.1:1" });
  pump.noteRun(project, { id: "run-5", sessionId: RECORDED_APPROVAL_FRAME.agentId, status: "running" });
  await waitFor(() => muxes[0]?.host(), "the host stream");
  muxes[0].host().push(ready());
  muxes[0].host().push(RECORDED_APPROVAL_FRAME);
  await waitFor(() => pump.projects.get("alice:p-5").pending.size === 1, "the pending question");

  await assert.rejects(
    () => pump.answerInteraction(project, { runId: "someone-elses-run", eventId: RECORDED_APPROVAL_FRAME.eventId, outcome: { kind: "result", value: "allowed-once" } }),
    (error) => error.code === "interaction_not_pending",
  );
  pump.detach(project);
});

/* ------------------------------------------ the profile and the answerer */

test("a profile that asks for approval is deployed alongside something that can answer", async () => {
  // The defect this whole file exists for was not in either half. The local
  // profile correctly rendered `approval: ask`, the browser correctly rendered
  // a prompt, and the two were never connected — so a local run stopped at its
  // first sandbox escalation and nothing anywhere said why. Each half had a
  // test; the pairing had none, which is how it stayed broken.
  //
  // Asserted at the seam rather than end to end: what makes the pairing real is
  // that the run-event vocabulary the profile's questions arrive as is the same
  // vocabulary the pump publishes, and that the reply endpoint is callable.
  const { renderProfilePatch } = await import("../src/dshProfilePatch.mjs");
  const { RUN_STREAM_EVENT_TYPES } = await import("../src/runEventStream.mjs");
  const { ALLOWED_WIRE_METHODS } = await import("../src/dshRuntimeAdapter.mjs");
  const { SEAMS } = await import("@evimed/harness-port");

  const input = {
    dshVersion: "0.1.2-alpha.3",
    workspaceDir: "/workspace",
    model: { provider: "deepseek", id: "deepseek-v4-flash", baseURL: "http://gateway/v1" },
    flags: { hosted: false, askUser: true, review: true, capsule: true, requiredEnforcement: "partial" },
  };
  // Rendered, not guarded. An earlier draft wrapped this in a try/catch that
  // skipped the assertion when the renderer's input shape changed — which is
  // the same defect in miniature: the test would have gone on passing while
  // the thing it checks stopped being checked.
  const patch = renderProfilePatch(input);
  assert.match(patch, /- id: approval\n {2}config:\n {4}policy: 'ask'/, "the local profile is the one that asks");

  for (const kind of Object.keys(SEAMS.wire.hostInteractionEvents)) {
    assert.ok(
      RUN_STREAM_EVENT_TYPES.includes(`${kind}/requested`),
      `the kernel can raise a ${kind} request, but no run-stream event type carries it to a reader`,
    );
  }
  assert.ok(
    ALLOWED_WIRE_METHODS.has(SEAMS.wire.gatewayEndpoints.hostInteractionResult),
    "the control plane may be asked but may not answer: the reply endpoint is not on the allow-list",
  );
});
