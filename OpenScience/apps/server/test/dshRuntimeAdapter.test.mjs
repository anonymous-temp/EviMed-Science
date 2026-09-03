import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SEAMS } from "@evimed/harness-port";

import {
  ALLOWED_WIRE_METHODS,
  DENIED_WIRE_METHODS,
  DshRuntimeAdapter,
  decodeSessionFrame,
  isAllowedWireMethod,
  mapWireError,
  normalizeTranscript,
  transcriptToLedgerMessages,
} from "../src/dshRuntimeAdapter.mjs";

const golden = JSON.parse(await readFile(new URL("./fixtures/dsh/golden-frames.json", import.meta.url), "utf8"));

/** The session the golden run actually happened in. Everything live in the fixture is this one. */
const RECORDED_SESSION = "session-ef423c0f-24cd-4fc5-8026-2d20771f6990";

/**
 * A transport that answers from a script, so the adapter is tested without a
 * kernel. `call` is keyed by method name; `stream` by endpoint name, and it is
 * handed the args so a per-session script can answer per session — which is
 * the whole shape of 0.1.2's downlink.
 */
function scriptedTransport(script) {
  const calls = [];
  const opened = [];
  return {
    calls,
    opened,
    async call(method, payload) {
      calls.push({ method, payload });
      const answer = script[method];
      if (typeof answer === "function") return answer(payload, calls.length);
      if (answer === undefined) return { ok: false, error: { code: "gateway/internal", message: `no script for ${method}` } };
      return answer;
    },
    async *stream(endpoint, args) {
      opened.push({ endpoint, args });
      const answer = script[endpoint];
      const frames = typeof answer === "function" ? answer(args) : answer;
      for (const frame of frames ?? []) yield frame;
    },
  };
}

/* ------------------------------------------ the projection into the ledger */

test("a projected tool message reaches the gate, which reads only finished assistant messages", () => {
  // The projection rewrites `tool` to `assistant` — which the ledger wants —
  // but the completion timestamp was attached only to messages that were
  // already assistant. `assistantFinished` reads `info.time.completed`, so
  // every tool message arrived looking like a message still being streamed
  // and the delivery gate filtered it out. Artifacts, evidence provenance and
  // skill loads are all derived from tool parts: the gate saw a run that had
  // called no tools, and nothing said the messages had been dropped rather
  // than never made.
  const transcript = {
    sessionId: "ses_1",
    messages: [
      {
        role: "tool", source: "system", seq: 2, time: 1_700_000_000_000, turn: 1, step: 1,
        parts: [{ type: "tool", tool: "write", callId: "c1", status: "completed", input: { file_path: "a.md" }, output: "ok", error: null }],
        usage: null, interrupted: false,
      },
      {
        role: "assistant", source: "system", seq: 3, time: 1_700_000_000_100, turn: 1, step: 2,
        parts: [{ type: "text", text: "done" }], usage: null, interrupted: false,
      },
      {
        role: "user", source: "user", seq: 1, time: 1_699_999_999_000, turn: 1, step: 0,
        parts: [{ type: "text", text: "go" }], usage: null, interrupted: false,
      },
    ],
  };
  const messages = transcriptToLedgerMessages(transcript);

  // The gate's own filter, verbatim in shape: role assistant AND finished.
  const finished = (message) => Boolean(message?.info?.time?.completed ?? message?.completed ?? message?.info?.error);
  const visible = messages.filter((message) => message.info.role === "assistant" && finished(message));

  assert.equal(visible.length, 2, "the tool message and the assistant message must both be visible to the gate");
  const toolMessage = visible.find((message) => message.parts.some((part) => part.type === "tool"));
  assert.ok(toolMessage, "the message carrying the tool part is the one the gate derives artifacts from");
  assert.equal(toolMessage.parts[0].tool, "write");
  assert.equal(toolMessage.parts[0].state.status, "completed");
  assert.equal(toolMessage.parts[0].state.input.file_path, "a.md");

  // Negative controls.
  // A user message must not become visible: widening the timestamp to every
  // role would make the gate read the question as an answer.
  assert.equal(messages.find((message) => message.info.role === "user")?.info?.time, undefined);
  // And whether the call finished still travels in the part, not in the
  // message: a pending call must stay pending while its message is readable.
  const pending = transcriptToLedgerMessages({
    sessionId: "ses_1",
    messages: [{
      role: "tool", source: "system", seq: 4, time: 1_700_000_000_200, turn: 1, step: 3,
      parts: [{ type: "tool", tool: "read", callId: "c2", status: "pending", input: {}, output: "", error: null }],
      usage: null, interrupted: false,
    }],
  })[0];
  assert.ok(finished(pending), "the record of the call is complete even when the call is not");
  assert.equal(pending.parts[0].state.status, "pending", "and the call's own status must not be overwritten by that");
});

test("how the turn ended reaches the ledger instead of being computed and dropped", () => {
  // `normalizeTranscript` decodes `turn/end` — done, refused, out of tokens,
  // errored — and this projection returned only `messages`, so the stop reason
  // was worked out on every read and thrown away. `readSessionHistory` hands
  // the control plane this array and nothing else, which is why a run that was
  // refused, a run that hit a token ceiling and a run that simply stopped all
  // reached the ledger as the same silence.
  const base = {
    sessionId: "ses_1",
    messages: [
      { role: "assistant", source: "system", seq: 1, time: 10, turn: 1, step: 1, parts: [{ type: "text", text: "a" }], usage: null, interrupted: false },
      { role: "assistant", source: "system", seq: 2, time: 20, turn: 1, step: 2, parts: [{ type: "text", text: "b" }], usage: null, interrupted: false },
    ],
  };

  const errored = transcriptToLedgerMessages({ ...base, turnEnd: { kind: "error", code: "runtime_session_error" } });
  assert.deepEqual(errored.at(-1).info.turnEnd, { kind: "error", code: "runtime_session_error" }, "the last message carries the ending");
  assert.deepEqual(errored.at(-1).info.error, { name: "error", code: "runtime_session_error" });
  assert.equal(errored[0].info.turnEnd, undefined, "only the last message ends the turn");
  assert.equal(errored[0].info.error, undefined);

  const done = transcriptToLedgerMessages({ ...base, turnEnd: { kind: "completed" } });
  assert.deepEqual(done.at(-1).info.turnEnd, { kind: "completed" });
  assert.equal(done.at(-1).info.error, undefined, "finishing is not an error");

  // Negative controls.
  const silent = transcriptToLedgerMessages({ ...base, turnEnd: null });
  assert.equal(silent.at(-1).info.turnEnd, undefined);
  const interrupted = transcriptToLedgerMessages({
    sessionId: "ses_1",
    messages: [{ ...base.messages[0], interrupted: true }],
    turnEnd: { kind: "error", code: "runtime_session_error" },
  });
  assert.deepEqual(interrupted.at(-1).info.error, { name: "interrupted" });
  assert.deepEqual(interrupted.at(-1).info.turnEnd, { kind: "error", code: "runtime_session_error" });
});

/* ------------------------------------------------------- the 0.1.2 method set */

test("the method allow-list is derived from the seam manifest, and 0.1.1's dotted names are not on it", () => {
  // The allow-list is the service methods plus the gateway's own pseudo-
  // endpoints, and the two are separate manifest fields because they are
  // different kinds of thing: `$events/result` is claimed by the gateway before
  // any method lookup, so it obeys neither the `namespace/method` grammar nor
  // the `unaryArgs` contract every typert call has. Folding it into
  // `wire.unary` would have meant relaxing the grammar assertion that proves
  // 0.1.2 renamed every method dotted-to-slashed -- trading a real guarantee
  // for one endpoint that was never of that kind.
  const gateway = Object.values(SEAMS.wire.gatewayEndpoints);
  assert.equal(ALLOWED_WIRE_METHODS.size, SEAMS.wire.unary.length + gateway.length);
  assert.equal(DENIED_WIRE_METHODS.size, SEAMS.wire.denied.length);
  for (const endpoint of gateway) assert.ok(isAllowedWireMethod(endpoint), `${endpoint} must be callable`);
  assert.ok(isAllowedWireMethod("$events/result"), "answering a kernel question is a call this control plane makes");
  // The split used to be pinned as a total ("allowed + denied === 50"). Kept,
  // adjusted, rather than dropped when the gateway endpoint arrived: the number
  // is what notices a method being added to one half without a decision about
  // the other. Disjointness is asserted beside it, because a method that is
  // both allowed and denied would keep the total right.
  assert.equal(ALLOWED_WIRE_METHODS.size + DENIED_WIRE_METHODS.size, 51);
  for (const method of ALLOWED_WIRE_METHODS) {
    assert.ok(!DENIED_WIRE_METHODS.has(method), `${method} is both allowed and denied`);
  }

  for (const method of ["session/create", "session/prompt", "session/cancel", "session/page", "session/fork", "session/list", "subagents/list", "skills/list", "agentPresets/list"]) {
    assert.ok(isAllowedWireMethod(method), method);
  }
  // The rename is the migration: a live 0.1.2 kernel answers 404 to the dotted
  // spelling, so leaving it on the allow-list would turn "this method is gone"
  // into a transport error at the far end of a container boundary.
  for (const method of ["session.create", "session.prompt", "session.list", "session.history", "subagent.list", "skill.list", "agentPreset.list"]) {
    assert.ok(!isAllowedWireMethod(method), `${method} is 0.1.1's name`);
  }
  assert.ok(!isAllowedWireMethod("host.describe"), "0.1.2 removed host.describe with the rest of ApiProxy");
  assert.ok(!isAllowedWireMethod("host/describe"), "and it did not come back under a slash");
  assert.ok(!isAllowedWireMethod("subagents/history"), "subagent history is session/page with a subagent address now");

  assert.ok(!isAllowedWireMethod("settings/update"));
  assert.ok(!isAllowedWireMethod("credentials/set"));
  assert.ok(!isAllowedWireMethod("session/selectModel"), "the model is the deployment's decision, not the run's");
  assert.ok(!isAllowedWireMethod("workspace/delete"));
  assert.ok(!isAllowedWireMethod("session/status"), "the kernel publishes no such method");
});

test("a forbidden method is refused before it reaches the container", async () => {
  const transport = scriptedTransport({});
  const adapter = new DshRuntimeAdapter(transport);
  await assert.rejects(adapter.call("settings/update", {}), /not on the allow-list/);
  await assert.rejects(adapter.call("session.list", {}), /not on the allow-list/);
  assert.deepEqual(transport.calls, [], "a refused method must not be sent");
});

test("kernel error codes map to ours, and an unknown one is named rather than folded away", () => {
  // Every code here was taken off the live 0.1.2 kernel (see the fixture's own
  // `$recorded` lines). 0.1.2 slashed its error codes along with its method
  // names — `session/not-found`, not `session-not-found` — so a map still
  // holding the dashed spellings answers `runtime_wire_protocol_mismatch` to
  // every real failure the kernel can have, and the one code the ledger acts
  // on differently (a session that does not exist yet, which is normal for a
  // run that has not begun) stops being distinguishable from a broken run.
  const byCode = Object.fromEntries(golden.errors.map((error) => [error.code, error]));

  assert.deepEqual(mapWireError(byCode["session/not-found"]), {
    code: "runtime_session_not_found",
    message: 'session "nope" not found',
  });
  assert.equal(mapWireError(byCode["agent-preset/locked"]).code, "runtime_preset_unavailable");
  assert.equal(mapWireError(byCode["gateway/input-invalid"]).code, "runtime_wire_protocol_mismatch");

  // Negative control: a code no build knows must stay named rather than
  // disappearing into a generic failure.
  const unknown = mapWireError(byCode.teleported);
  assert.equal(unknown.code, "runtime_wire_protocol_mismatch");
  assert.match(unknown.message, /teleported/);
});

/* --------------------------------------------------- the unary call shapes */

test("a session is created on the one composition, under 0.1.2's request descriptor", async () => {
  const transport = scriptedTransport({ "session/create": { ok: true, value: { sessionId: "s-1", agentPreset: "evimed-universal" } } });
  const adapter = new DshRuntimeAdapter(transport);
  const created = await adapter.createSession({ cwd: "/workspace" });
  assert.deepEqual(created, { sessionId: "s-1", agentPreset: "evimed-universal" });
  assert.equal(transport.calls[0].method, "session/create");
  // Arguments moved inside a named descriptor in 0.1.2; the flat payload is a
  // boundary-validation refusal, not a tolerated variant.
  assert.deepEqual(transport.calls[0].payload, { request: { cwd: "/workspace", agentPreset: "evimed-universal" } });

  // Shaped exactly like the request the live kernel accepted, modulo our preset.
  const [liveCreate] = golden.unary.filter((entry) => entry.method === "session/create");
  assert.deepEqual(Object.keys(transport.calls[0].payload), Object.keys(liveCreate.request.args));

  await adapter.createSession({ cwd: "/workspace", sessionId: "ses_x" });
  assert.deepEqual(transport.calls[1].payload, { request: { cwd: "/workspace", agentPreset: "evimed-universal", sessionId: "ses_x" } });
});

test("a prompt carries a request id and no system field, because the protocol has one and not the other", async () => {
  const transport = scriptedTransport({ "session/prompt": { ok: true, value: { accepted: true } } });
  const adapter = new DshRuntimeAdapter(transport);
  await adapter.prompt({ sessionId: "s-1", text: "题面" });
  await adapter.prompt({ sessionId: "s-1", text: "题面", mode: "steer" });
  const [first, second] = transport.calls;

  assert.equal(first.method, "session/prompt");
  assert.equal(first.payload.request.sessionId, "s-1");
  assert.equal(first.payload.request.mode, "queue");
  assert.equal(second.payload.request.mode, "steer");
  assert.deepEqual(first.payload.request.content, [{ type: "text", text: "题面" }]);
  assert.ok(first.payload.request.requestId, "0.1.2 requires the client's own id for the submission");
  assert.notEqual(first.payload.request.requestId, second.payload.request.requestId, "two dispatches sharing one id are indistinguishable in the queue");
  assert.ok(!("system" in first.payload.request), "research context travels as a workspace file, not a side channel");
  assert.ok(!("system" in first.payload), "and not one level up either");

  // The live request's own field set, so a field the kernel requires cannot go
  // missing without this failing.
  const [livePrompt] = golden.unary.filter((entry) => entry.method === "session/prompt");
  assert.deepEqual(Object.keys(first.payload.request).sort(), Object.keys(livePrompt.request.args.request).sort());
});

test("the readiness probe is a real wire call, so it also proves the cookie", async () => {
  // 0.1.2 removed `host.describe`, and a probe that only checked for a
  // listening port would pass against a kernel that refuses every subsequent
  // call as unauthenticated.
  const transport = scriptedTransport({ "session/list": { ok: true, value: { items: [{ sessionId: "a" }, { sessionId: "b" }] } } });
  const adapter = new DshRuntimeAdapter(transport);
  assert.deepEqual(await adapter.describe(), { sessions: 2 });
  assert.equal(transport.calls[0].method, "session/list");
  assert.deepEqual(transport.calls[0].payload, { _request: {} }, "session/list's descriptor is named `_request`, not `request`");
  assert.deepEqual(SEAMS.wire.unaryArgs["session/list"], ["_request"]);
});

test("cancel and fork travel under the request descriptor too", async () => {
  const transport = scriptedTransport({
    "session/cancel": { ok: true, value: { accepted: true } },
    "session/fork": { ok: true, value: { sessionId: "forked" } },
  });
  const adapter = new DshRuntimeAdapter(transport);
  await adapter.cancel({ sessionId: "s-1" });
  assert.deepEqual(transport.calls[0], { method: "session/cancel", payload: { request: { sessionId: "s-1" } } });
  assert.deepEqual(await adapter.fork({ sessionId: "s-1", atSeq: 12 }), { sessionId: "forked" });
  assert.deepEqual(transport.calls[1].payload, { request: { sessionId: "s-1", atSeq: 12 } });
  await adapter.fork({ sessionId: "s-1" });
  assert.deepEqual(transport.calls[2].payload, { request: { sessionId: "s-1" } }, "an absent atSeq is absent, not null");
});

test("subagents are listed by a bare parent id, which is the one method that takes no descriptor", async () => {
  const transport = scriptedTransport({ "subagents/list": { ok: true, value: { items: [{ sessionId: "child" }] } } });
  const adapter = new DshRuntimeAdapter(transport);
  assert.deepEqual(await adapter.subagents({ sessionId: "s-1" }), [{ sessionId: "child" }]);
  assert.deepEqual(transport.calls[0], { method: "subagents/list", payload: { parentSessionId: "s-1" } });
  assert.deepEqual(SEAMS.wire.unaryArgs["subagents/list"], ["parentSessionId"]);
});

/* ----------------------------------------------- normalizing a real transcript */

test("the live session/page records normalize into a transcript the gate can read", () => {
  // `session.history` returned `{events}`; `session/page` returns `{records}`,
  // and a record is `{type:'event'|'chunks', …}`. These are the 32 records the
  // pinned kernel returned for one real run.
  const transcript = normalizeTranscript(RECORDED_SESSION, golden.history);
  assert.equal(transcript.sessionId, RECORDED_SESSION);
  assert.equal(transcript.lastSeq, 62);
  assert.deepEqual(transcript.turnEnd, { kind: "completed" });

  const users = transcript.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users[0].source, "user");
  assert.match(users[0].parts[0].text, /^Create a file named recorded\.txt/);
  // The injected runtime context arrives as a `plugin`-sourced user message —
  // the distinction the injection is logged for, and the reason the research
  // context is a workspace file rather than a side channel.
  assert.equal(users[1].source, "plugin");
  assert.match(users[1].parts[0].text, /Current runtime context/);

  const assistants = transcript.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 2);
  // 0.1.2's usage is `{inputTokens, outputTokens, cacheReadTokens, …}`; the
  // 0.1.1 fixture said `promptCacheHitTokens`. Both names are read, and this is
  // the one the wire actually sends.
  assert.deepEqual(assistants[1].usage, { input: 105, output: 2, cacheHit: 8064, cacheMiss: 0 });
  // An assistant message whose only content block is a `tool-call` has no text
  // parts: the call itself arrives as its own `tool/call` event, and counting
  // it twice would double every tool in the transcript.
  assert.deepEqual(assistants[0].parts, []);
  assert.deepEqual(assistants[1].parts, [{ type: "text", text: "done" }]);

  const tools = transcript.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool, "write");
  assert.equal(tools[0].callId, "call_00_ET_TEqlvPcXbdtnR1MeXsLR0708");
  // The pairing that matters, and the one a hand-authored fixture got wrong:
  // the live call id hangs off `message.source.callId` and the text sits inside
  // a nested `tool-result` block. Read flat, every call on a real run stayed
  // `pending` with empty output.
  assert.equal(tools[0].status, "completed");
  assert.match(tools[0].output, /Created file/);
  assert.deepEqual(tools[0].input, { file_path: "/tmp/dsh-probe/home-rec/work/recorded.txt", content: "recorded" });

  // A `chunks` record is a run of deltas the following message already
  // summarises; replaying it would double the text.
  assert.ok(golden.history.some((record) => record.type === "chunks"), "the recording must still contain the chunks record this asserts about");
  assert.equal(transcript.messages.some((message) => message.parts.some((part) => part.text === "recorded")), false);
});

test("a tool call whose result never arrived stays pending, and an errored one says why", () => {
  const transcript = normalizeTranscript("s-1", golden.synthesized.history);
  const tools = transcript.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool");
  assert.equal(tools.length, 2);
  const [fullText, submit] = tools;
  assert.equal(fullText.status, "error");
  assert.equal(fullText.error.code, "full_text_not_available");
  assert.equal(submit.status, "pending", "a call whose result never arrived must not look like a success");
  assert.deepEqual(transcript.subagents, [{
    sessionId: "child-1",
    parentSessionId: "s-1",
    label: "证据综述",
    capability: "clinical-evidence-synthesis",
  }]);
});

test("an empty or malformed page is an empty transcript, not a crash", () => {
  assert.deepEqual(normalizeTranscript("s-1", []).messages, []);
  assert.deepEqual(normalizeTranscript("s-1", null).messages, []);
  const junk = normalizeTranscript("s-1", [{ event: null }, { event: { type: "unheard-of", seq: 3, data: {} } }, "nonsense"]);
  assert.deepEqual(junk.messages, []);
  assert.equal(junk.lastSeq, 3);
});

test("each turn-end kind lands on its own code, and an unknown kind is counted", () => {
  const cases = [
    ["completed", null, undefined],
    ["aborted", "runtime_canceled", undefined],
    ["blocked", "runtime_tool_error", "turn_blocked"],
    ["error", "runtime_session_error", undefined],
    ["max-tokens", "runtime_session_error", "model_max_tokens"],
    ["interrupted", "runtime_stopped", undefined],
  ];
  assert.deepEqual(cases.map(([kind]) => kind), SEAMS.turnEndKinds, "every kind the manifest publishes must be covered here");
  for (const [kind, code, subCode] of cases) {
    const transcript = normalizeTranscript("s", [{ type: "event", event: { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind } } } }]);
    assert.equal(transcript.turnEnd.kind, kind, kind);
    assert.equal(transcript.turnEnd.code, code ?? undefined, kind);
    assert.equal(transcript.turnEnd.subCode, subCode, kind);
  }
  const unknown = normalizeTranscript("s", [{ type: "event", event: { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "teleported" } } } }]);
  assert.equal(unknown.turnEnd.kind, "unknown");
  assert.equal(unknown.turnEnd.code, "runtime_turn_end_unknown");
});

/* ------------------------------------------- decoding one session's own stream */

test("every live session/follow frame decodes, and an unrecognized event is visible rather than dropped", () => {
  const decoded = golden.session.map((frame) => decodeSessionFrame(RECORDED_SESSION, frame)).filter(Boolean);
  assert.ok(decoded.length > 0, "the recording must not be empty, or this test proves nothing");

  const counts = {};
  for (const item of decoded) counts[item.event.type] = (counts[item.event.type] ?? 0) + 1;
  assert.deepEqual(counts, {
    "turn/start": 1,
    "step/start": 2,
    "step/end": 2,
    "message/user": 2,
    "message/assistant": 2,
    "assistant/delta": 1,
    "tool/call": 1,
    "tool/result": 1,
    "turn/end": 1,
    // Seven frames this build has no variant for — `agent/inbox/spliced`,
    // `session/title`, `request/header`, `request/context`,
    // `session/title-llm-request`. Counted under a named `unknown` rather than
    // dropped, which is what makes a kernel that adds a frame show up in the
    // trajectory inspector instead of disappearing.
    unknown: 7,
  });

  const call = decoded.find((item) => item.event.type === "tool/call").event;
  assert.equal(call.tool, "write");
  assert.equal(call.narration, "写入 /tmp/dsh-probe/home-rec/work/recorded.txt");
  const result = decoded.find((item) => item.event.type === "tool/result").event;
  assert.equal(result.callId, call.callId, "the result must pair with the call it answers");
  assert.equal(result.status, "completed");
  assert.match(result.output, /Created file/);
  // Recorded as observed, not as wished for: a live `tool/result` carries no
  // tool name of its own, so the narration falls back. Asserting the fallback
  // is how a kernel that starts sending one becomes visible.
  assert.equal(result.tool, "");

  const delta = decoded.find((item) => item.event.type === "assistant/delta").event;
  assert.equal(delta.kind, "text");
  assert.equal(delta.text, "done");
  assert.equal(decoded.at(-1).event.type, "turn/end");
  assert.equal(decoded.at(-1).event.endKind, "completed");

  // The snapshot is not an event: `watchSession` unwraps its records itself.
  assert.equal(golden.session[0].type, "snapshot");
  assert.equal(decodeSessionFrame(RECORDED_SESSION, golden.session[0]), null);
  // Nor is a `chunks` record, which the following message already summarises.
  assert.equal(decodeSessionFrame(RECORDED_SESSION, { type: "chunks", event: { type: "chunkrow/tool-call-chunks", seq: 1, data: {} } }), null);
  assert.equal(decodeSessionFrame(RECORDED_SESSION, null), null);
  assert.equal(decodeSessionFrame(RECORDED_SESSION, { type: "event" }), null);
});

test("the event kinds a single short run cannot produce still decode", () => {
  const decoded = golden.synthesized.session.map((frame) => decodeSessionFrame("s-1", frame)).filter(Boolean);
  assert.deepEqual(decoded.map((item) => item.event.type), ["assistant/delta", "compaction", "workflow/stage", "unknown", "turn/end"]);
  assert.equal(decoded[0].event.kind, "reasoning");
  assert.equal(decoded[1].event.replaced, 12);
  assert.equal(decoded[2].event.state, "started");
  assert.equal(decoded[3].event.rawType, "hook/invoked", "an unknown event keeps its name so it can be counted");
  assert.equal(decoded[4].event.endKind, "max-tokens");
  assert.equal(decoded[4].event.subCode, "model_max_tokens");
});

test("a session's events are attributed to the session whose stream they arrived on", async () => {
  // The 0.1.2 change with the sharpest edge. There is no all-sessions stream
  // any more and **the session id is not in the frame**: it is whichever
  // session the stream was opened for. So mis-attribution became possible for
  // the first time, and a decoder that quietly used an empty string — or, worse,
  // trusted a stray id inside the frame — would file a subagent's whole
  // transcript under the wrong run with nothing anywhere saying so.
  const frame = golden.session.find((item) => item.type === "event" && item.event.type === "turn/start");
  assert.ok(frame, "the recording must contain the frame this test decodes");

  const mine = decodeSessionFrame("s-parent", frame);
  const theirs = decodeSessionFrame("s-child", frame);
  assert.equal(mine.sessionId, "s-parent");
  assert.equal(theirs.sessionId, "s-child");
  assert.deepEqual(mine.event, theirs.event, "the same bytes decode to the same event; only the attribution differs");

  // A frame carrying its own `sessionId` must not be believed over the stream
  // it arrived on. The wire does not send one, so anything that looks like one
  // is either a subagent's inner id or a kernel change — and neither may
  // silently re-route a run's events.
  const impostor = { ...frame, sessionId: "s-somebody-else", event: { ...frame.event, sessionId: "s-somebody-else" } };
  assert.equal(decodeSessionFrame("s-parent", impostor).sessionId, "s-parent");

  // And end to end through `watchSession`, with two sessions live at once on
  // one transport, each answered from its own script.
  const transport = scriptedTransport({
    "session/follow": (args) => {
      const sessionId = args?.request?.address?.sessionId;
      return [{ type: "event", event: { type: "turn/start", seq: 1, data: { turn: sessionId === "s-parent" ? 1 : 2 } } }];
    },
  });
  const adapter = new DshRuntimeAdapter(transport);
  /** @param {string} sessionId */
  const follow = async (sessionId) => {
    const seen = [];
    for await (const item of adapter.watchSession({ sessionId, signal: AbortSignal.timeout(2_000) })) seen.push(item);
    return seen;
  };
  const [parent, child] = await Promise.all([follow("s-parent"), follow("s-child")]);
  assert.deepEqual(parent.map((item) => item.sessionId), ["s-parent"]);
  assert.deepEqual(child.map((item) => item.sessionId), ["s-child"]);
  assert.equal(parent[0].event.turn, 1);
  assert.equal(child[0].event.turn, 2, "each stream carried its own session's frame, and neither took the other's");

  // The stream this adapter opens, and the address it opens it with.
  assert.deepEqual(transport.opened.map((entry) => entry.endpoint), ["session/follow", "session/follow"]);
  assert.equal(SEAMS.wire.streamEndpoints.session, "session/follow");
  assert.deepEqual(transport.opened[0].args, { request: { address: { kind: "session", sessionId: "s-parent" } } });
});

test("the opening snapshot is replayed as events, so a tab that connects mid-run sees what it missed", async () => {
  const transport = scriptedTransport({ "session/follow": golden.session });
  const adapter = new DshRuntimeAdapter(transport);
  const seen = [];
  for await (const item of adapter.watchSession({ sessionId: RECORDED_SESSION, signal: AbortSignal.timeout(2_000) })) seen.push(item);

  const snapshot = golden.session[0];
  assert.equal(snapshot.type, "snapshot");
  assert.ok(snapshot.records.length > 0);
  // Every record inside the snapshot is decoded through the same path as the
  // frames after it, in the same vocabulary, attributed to the same session.
  assert.ok(seen.every((item) => item.sessionId === RECORDED_SESSION));
  const direct = golden.session.map((frame) => decodeSessionFrame(RECORDED_SESSION, frame)).filter(Boolean);
  const fromSnapshot = snapshot.records.map((record) => decodeSessionFrame(RECORDED_SESSION, record)).filter(Boolean);
  assert.deepEqual(seen, [...fromSnapshot, ...direct]);
  assert.ok(fromSnapshot.length > 0, "the snapshot's own records must reach the caller, not just the frames after it");
});

/* --------------------------------------------------------------- host facts */

test("running state comes from the $events stream, and 'we were not told' is not 'idle'", async () => {
  // Live emit signatures, transcribed from the recording and matched by the
  // kernel's own published list: `api-session/added(summary)` puts an object in
  // args[0], while `api-session/status(sessionId, running)` and
  // `api-session/removed(sessionId)` are **positional** — args[0] is a bare
  // string. A reader that only knows the object form drops every status change
  // and a running session reads as idle forever, which is the failure that
  // looks exactly like nothing having happened.
  const status = golden.events.filter((frame) => frame.event === "api-session/status");
  assert.ok(status.length >= 2, "the recording must contain the status emits this test replays");
  assert.equal(typeof status[0].args[0], "string", "args[0] is the session id itself, not a summary");
  assert.equal(status[0].args[1], true);

  const transport = scriptedTransport({ $events: golden.events });
  const adapter = new DshRuntimeAdapter(transport);
  assert.equal(adapter.runningStatus(RECORDED_SESSION), "unknown", "an unasked session must not read as idle");

  const seen = [];
  await adapter.watchHost({ signal: AbortSignal.timeout(2_000), onEvent: (frame) => seen.push(frame) });
  assert.equal(transport.opened[0].endpoint, "$events");
  assert.equal(SEAMS.wire.streamEndpoints.events, "$events");

  // The opening `ready` frame carries the host facts `host.describe` used to
  // answer, exactly once per connection generation.
  assert.equal(seen[0].type, "ready");
  assert.deepEqual(adapter.hostInfo, { home: "/tmp/dsh-probe/home-rec" });

  assert.equal(adapter.runningStatus(RECORDED_SESSION), "idle", "the run finished, and the last status emit said so");
  assert.equal(adapter.runningStatus("never-mentioned"), "unknown");

  // Replayed up to the first status emit only, the same session must read busy.
  const untilBusy = golden.events.slice(0, golden.events.findIndex((frame) => frame.event === "api-session/status") + 1);
  const busyAdapter = new DshRuntimeAdapter(scriptedTransport({ $events: untilBusy }));
  await busyAdapter.watchHost({ signal: AbortSignal.timeout(2_000) });
  assert.equal(busyAdapter.runningStatus(RECORDED_SESSION), "busy", "a running session must read busy, not idle and not unknown");

  // A removal forgets the session rather than pinning it to a stale answer.
  const removal = golden.synthesized.events.find((frame) => frame.event === "api-session/removed");
  const removedAdapter = new DshRuntimeAdapter(scriptedTransport({ $events: [...untilBusy, removal] }));
  await removedAdapter.watchHost({ signal: AbortSignal.timeout(2_000) });
  assert.equal(removedAdapter.runningStatus(RECORDED_SESSION), "unknown");
});

test("a waterfall the control plane cannot answer is surfaced, not swallowed", async () => {
  // The kernel asks this control plane a question and waits for a reply on
  // `POST /api/$events/result`. Nothing answers one yet; dropping it silently
  // would leave the kernel waiting for a reply that never comes.
  const transport = scriptedTransport({ $events: golden.synthesized.events });
  const adapter = new DshRuntimeAdapter(transport);
  const seen = [];
  await adapter.watchHost({ signal: AbortSignal.timeout(2_000), onEvent: (frame) => seen.push(frame) });
  assert.ok(seen.some((frame) => frame.type === "waterfall"), "the caller has to be told, because only the caller can answer");
  assert.ok(seen.some((frame) => frame.type === "cancel"));
});

/* ------------------------------------------------------------------ paging */

test("the transcript is read through to its head sequence, page by page, back to the first", async () => {
  // 0.1.2 requires the caller to name the sequence it is reading through, and a
  // value past the end returns nothing rather than the tail — so asking for
  // "everything" with a large constant reads as an empty run, which is exactly
  // what the delivery gate would then grade. The head is published per session
  // by `session/list` as `projections.asOfSeq`.
  const head = 62;
  const pages = [
    { ok: true, value: { records: golden.history.slice(20), hasMore: true } },
    { ok: true, value: { records: golden.history.slice(0, 20), hasMore: false } },
  ];
  let index = 0;
  const transport = scriptedTransport({
    "session/list": { ok: true, value: { items: [{ sessionId: RECORDED_SESSION, running: false, projections: { asOfSeq: head } }] } },
    "session/page": () => pages[index++],
  });
  const adapter = new DshRuntimeAdapter(transport);
  const transcript = await adapter.transcript({ sessionId: RECORDED_SESSION, maxMessages: 20 });

  assert.deepEqual(transport.calls.map((call) => call.method), ["session/list", "session/page", "session/page"]);
  const first = transport.calls[1].payload.request;
  assert.deepEqual(first.address, { kind: "session", sessionId: RECORDED_SESSION }, "a page is addressed, not named");
  assert.equal(first.throughSeq, head, "the head comes from the kernel, never from a constant");
  assert.equal(first.maxMessages, 20);
  assert.equal(first.beforeSeq, undefined);
  const second = transport.calls[2].payload.request;
  assert.equal(second.beforeSeq, Number(golden.history[20].event.seq), "the second page must be anchored to the first event of the first");
  assert.equal(second.throughSeq, head, "and still read through the same head");

  // The whole run survives the walk: a truncated transcript would mark the
  // earliest work as never done.
  assert.equal(transcript.lastSeq, head);
  assert.equal(transcript.messages.filter((message) => message.role === "user").length, 2);
  assert.equal(transcript.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool").length, 1);
});

test("a session the kernel never heard of is said so, not returned as an empty run", async () => {
  const transport = scriptedTransport({ "session/list": { ok: true, value: { items: [] } } });
  const adapter = new DshRuntimeAdapter(transport);
  await assert.rejects(
    adapter.transcript({ sessionId: "s-missing" }),
    (error) => error.code === "runtime_session_not_found" && error.status === 502,
  );
  assert.equal(transport.calls.some((call) => call.method === "session/page"), false, "there is no head to read through");
});

test("a page bigger than the engine's argument limit still reads", async () => {
  // Each page carries every assistant/chunk delta between its messages, and one
  // real run put 130k of them under a single page. `entries.unshift(
  // ...pageEntries)` passes every element as a call argument, so that page threw
  // `Maximum call stack size exceeded` — in the control plane's copy of this
  // loop, on every monitor poll, leaving a finished run reading `running` for an
  // hour with one identical log line each time.
  const huge = Array.from({ length: 200_000 }, (_, index) => ({
    type: "event",
    event: { seq: index + 1, type: "assistant/chunk" },
  }));
  const pages = [
    { ok: true, value: { records: huge, hasMore: true } },
    { ok: true, value: { records: golden.history, hasMore: false } },
  ];
  let index = 0;
  const transport = scriptedTransport({
    "session/list": { ok: true, value: { items: [{ sessionId: "s-1", projections: { asOfSeq: 200_000 } }] } },
    "session/page": () => pages[index++],
  });
  const adapter = new DshRuntimeAdapter(transport);
  const transcript = await adapter.transcript({ sessionId: "s-1", maxMessages: 25 });
  assert.equal(transport.calls.filter((call) => call.method === "session/page").length, 2, "the walk must reach the second page");
  assert.ok(transcript.messages.length > 0, "the real messages must survive the oversized page");
});

test("a kernel failure becomes a named control-plane error, not a thrown wire object", async () => {
  const notFound = golden.errors.find((error) => error.code === "session/not-found");
  const transport = scriptedTransport({ "session/prompt": { ok: false, error: notFound } });
  const adapter = new DshRuntimeAdapter(transport);
  await assert.rejects(
    adapter.prompt({ sessionId: "s-9", text: "x" }),
    (error) => error.code === "runtime_session_not_found" && error.status === 502,
  );
});

/* ------------------------------------------------------------- the fixture */

test("the golden fixtures are pinned to the kernel version the manifest names", () => {
  assert.equal(golden.dsh, SEAMS.dsh, "re-record the golden frames when the pin moves, and read the diff");
  assert.equal(golden.muxPath, SEAMS.wire.mux);
  assert.equal(golden.muxTransport, SEAMS.wire.downlinkTransport);
});

test("every section of the fixture says where it came from, and the live ones are not empty", () => {
  // A fixture that claims a provenance it does not have is worse than no
  // fixture: it certifies the wrong shape and defeats the audit it exists to
  // be. So each section is named here, and a section that quietly emptied out
  // fails rather than passing as "nothing to check".
  const live = ["unary", "history", "session", "events", "workspace", "mux", "errors"];
  for (const section of live) {
    assert.ok(golden.$recorded[section], `${section} must say where it came from`);
    assert.ok(Array.isArray(golden[section]) && golden[section].length > 0, `${section} must not be empty`);
  }
  // Derived from the pin, not written out. A literal here meant every repin
  // edited this assertion, and an assertion edited on every repin is one that
  // stops being read.
  assert.ok(
    golden.$recorded.procedure.includes(SEAMS.dsh),
    `the procedure must name the kernel it was taken from (${SEAMS.dsh})`,
  );
  assert.match(golden.$recorded.synthesized, /NOT recorded/);
  // The synthesized section is the one place a hand-written frame may live, and
  // it must keep saying so in its own body, not only in the index above.
  assert.match(golden.synthesized.$recorded, /NOT recorded/);
  for (const section of ["history", "session", "events", "mux"]) {
    assert.ok(golden.synthesized[section].length > 0, `synthesized.${section} must not be empty`);
  }
  // Every error entry carries its own line, because they do not share a source.
  for (const error of golden.errors) assert.ok(error.$recorded, `error ${error.code} must say where it came from`);
  assert.equal(golden.errors.filter((error) => error.$recorded.startsWith("verbatim")).length, 3);

  // The live sections are the frames of one run, in one session.
  assert.equal(golden.unary.every((entry) => entry.method.includes("/")), true, "0.1.2 has no dotted method left");
  assert.equal(golden.events[0].type, "ready");
  assert.equal(golden.session[0].type, "snapshot");
  assert.equal(golden.mux.every((frame) => frame.type === "item" && typeof frame.streamId === "string"), true);
  assert.equal(new Set(golden.mux.map((frame) => frame.streamId)).size, 3, "three logical streams shared one socket");
});
