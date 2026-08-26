import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SEAMS } from "@evimed/harness-port";

import {
  ALLOWED_WIRE_METHODS,
  DENIED_WIRE_METHODS,
  DshRuntimeAdapter,
  decodeMuxFrame,
  isAllowedWireMethod,
  mapWireError,
  normalizeTranscript,
  transcriptToLedgerMessages,
} from "../src/dshRuntimeAdapter.mjs";

const golden = JSON.parse(await readFile(new URL("./fixtures/dsh/golden-frames.json", import.meta.url), "utf8"));

/** A transport that answers from a script, so the adapter is tested without a kernel. */
function scriptedTransport(script) {
  const calls = [];
  return {
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      const answer = script[method];
      if (typeof answer === "function") return answer(payload, calls.length);
      if (answer === undefined) return { ok: false, error: { code: "internal", message: `no script for ${method}` } };
      return answer;
    },
    async *stream(path) {
      for (const frame of script[path] ?? []) yield frame;
    },
  };
}

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
  // reached the ledger as the same silence. Run 7 stopped after writing its
  // whole deliverable set and there was no way to say why.
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

  // An ordinary completion is carried too — "it finished normally" is an answer
  // and must be distinguishable from "nothing was recorded".
  const done = transcriptToLedgerMessages({ ...base, turnEnd: { kind: "completed" } });
  assert.deepEqual(done.at(-1).info.turnEnd, { kind: "completed" });
  assert.equal(done.at(-1).info.error, undefined, "finishing is not an error");

  // Negative controls.
  // No ending recorded must stay distinguishable from an ending that says so.
  const silent = transcriptToLedgerMessages({ ...base, turnEnd: null });
  assert.equal(silent.at(-1).info.turnEnd, undefined);
  // An interrupted message keeps its own error rather than having it replaced:
  // "the container went away mid-message" and "the turn ended with an error"
  // are different facts and the first is the more specific one.
  const interrupted = transcriptToLedgerMessages({
    sessionId: "ses_1",
    messages: [{ ...base.messages[0], interrupted: true }],
    turnEnd: { kind: "error", code: "runtime_session_error" },
  });
  assert.deepEqual(interrupted.at(-1).info.error, { name: "interrupted" });
  assert.deepEqual(interrupted.at(-1).info.turnEnd, { kind: "error", code: "runtime_session_error" });
});

test("the method allow-list is derived from the seam manifest and covers every published method", () => {
  assert.equal(ALLOWED_WIRE_METHODS.size + DENIED_WIRE_METHODS.size, 52);
  assert.ok(isAllowedWireMethod("session.prompt"));
  assert.ok(isAllowedWireMethod("host.describe"));
  assert.ok(!isAllowedWireMethod("settings.update"));
  assert.ok(!isAllowedWireMethod("credentials.set"));
  assert.ok(!isAllowedWireMethod("session.selectModel"), "the model is the deployment's decision, not the run's");
  assert.ok(!isAllowedWireMethod("workspace.delete"));
  assert.ok(!isAllowedWireMethod("session.status"), "the kernel publishes no such method");
});

test("a forbidden method is refused before it reaches the container", async () => {
  const transport = scriptedTransport({});
  const adapter = new DshRuntimeAdapter(transport);
  await assert.rejects(adapter.call("settings.update", {}), /not on the allow-list/);
  assert.deepEqual(transport.calls, [], "a refused method must not be sent");
});

test("kernel error codes map to ours, and an unknown one is named rather than folded away", () => {
  const [notFound, locked, unknown] = golden.errors;
  assert.deepEqual(mapWireError(notFound), { code: "runtime_session_not_found", message: "no such session" });
  assert.deepEqual(mapWireError(locked), { code: "runtime_preset_unavailable", message: "preset locked" });
  const mapped = mapWireError(unknown);
  assert.equal(mapped.code, "runtime_wire_protocol_mismatch");
  assert.match(mapped.message, /teleported/);
});

test("a session is created on the one composition, and the preset is not a caller's choice", async () => {
  const transport = scriptedTransport({ "session.create": { ok: true, value: { sessionId: "s-1", agentPreset: "evimed-universal" } } });
  const adapter = new DshRuntimeAdapter(transport);
  const created = await adapter.createSession({ cwd: "/workspace" });
  assert.deepEqual(created, { sessionId: "s-1", agentPreset: "evimed-universal" });
  assert.deepEqual(transport.calls[0].payload, { cwd: "/workspace", agentPreset: "evimed-universal" });
});

test("a prompt carries no system field, because the protocol has none", async () => {
  const transport = scriptedTransport({ "session.prompt": { ok: true, value: { accepted: true } } });
  const adapter = new DshRuntimeAdapter(transport);
  await adapter.prompt({ sessionId: "s-1", text: "题面" });
  const [call] = transport.calls;
  assert.deepEqual(call.payload, { sessionId: "s-1", mode: "queue", content: [{ type: "text", text: "题面" }] });
  assert.ok(!("system" in call.payload), "research context travels as a workspace file, not a side channel");
});

test("the golden history page normalizes into a transcript the gate can read", () => {
  const transcript = normalizeTranscript("s-1", golden.history);
  assert.equal(transcript.sessionId, "s-1");
  assert.equal(transcript.lastSeq, 11);
  assert.deepEqual(transcript.turnEnd, { kind: "completed" });

  const user = transcript.messages.find((message) => message.role === "user");
  assert.equal(user.parts[0].text, "分析这个问题的证据现状");
  assert.equal(user.source, "user");

  const assistant = transcript.messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistant.usage, { input: 1000, output: 42, cacheHit: 900, cacheMiss: 100 });
  assert.deepEqual(assistant.parts.map((part) => part.type), ["reasoning", "text"]);

  const tools = transcript.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool");
  assert.equal(tools.length, 3);
  const [search, fullText, submit] = tools;
  assert.equal(search.status, "completed");
  assert.deepEqual(search.input, { query: "metformin lactic acidosis" });
  assert.equal(search.output, "12 results");
  assert.equal(fullText.status, "error");
  assert.equal(fullText.error.code, "full_text_not_available");
  assert.equal(submit.status, "pending", "a call whose result never arrived must not look like a success");

  assert.deepEqual(transcript.subagents, [{ sessionId: "child-1", parentSessionId: "s-1", label: "证据综述", capability: "clinical-evidence-synthesis" }]);
});

test("an empty or malformed history is an empty transcript, not a crash", () => {
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
  for (const [kind, code, subCode] of cases) {
    const transcript = normalizeTranscript("s", [{ event: { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind } } } }]);
    assert.equal(transcript.turnEnd.kind, kind, kind);
    assert.equal(transcript.turnEnd.code, code ?? undefined, kind);
    assert.equal(transcript.turnEnd.subCode, subCode, kind);
  }
  const unknown = normalizeTranscript("s", [{ event: { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "teleported" } } } }]);
  assert.equal(unknown.turnEnd.kind, "unknown");
  assert.equal(unknown.turnEnd.code, "runtime_turn_end_unknown");
});

test("every golden mux frame decodes, and an unrecognized event is visible rather than dropped", () => {
  const decoded = golden.mux.map(decodeMuxFrame).filter(Boolean);
  const types = decoded.map((item) => item.event.type);
  assert.deepEqual(types, [
    "turn/start",
    "assistant/delta",
    "assistant/delta",
    "tool/call",
    "tool/result",
    "compaction",
    "workflow/stage",
    "unknown",
    "turn/end",
  ]);
  assert.equal(decoded[1].event.kind, "text");
  assert.equal(decoded[2].event.kind, "reasoning");
  assert.equal(decoded[3].event.narration, "检索指南：「房颤」");
  assert.equal(decoded[7].event.rawType, "hook/invoked", "an unknown event keeps its name so it can be counted");
  assert.equal(decoded[8].event.endKind, "max-tokens");
  assert.equal(decoded[8].event.subCode, "model_max_tokens");
});

test("non-session frames are not mistaken for run events", () => {
  // Every downlink frame arrives inside a `server-request` envelope, so the
  // question is what the envelope carries, not what the envelope is.
  const inner = (item) => (item.type === "server-request" ? item.payload : item);
  for (const frame of golden.mux.filter((item) => inner(item).type !== "session/event")) {
    assert.equal(decodeMuxFrame(frame), null, inner(frame).type);
  }
  assert.equal(decodeMuxFrame(null), null);
  assert.equal(decodeMuxFrame({ type: "stream/error", error: { code: "internal" } }), null);
  assert.equal(decodeMuxFrame({ type: "server-request", rpcId: "x", method: "session/jobs", payload: { type: "session/jobs", jobs: [] } }), null);
});

// Recorded against a running kernel, because the shape below is exactly what
// the synthetic fixtures got wrong: the frame the control plane must decode is
// nested one level down, and the envelope's `method` mirrors the inner `type`,
// so every name matched while nothing decoded.
test("the frame shape is the one a live kernel actually sends", () => {
  const recorded = golden.mux.find((frame) => frame.$recorded);
  assert.ok(recorded, "the fixture must keep at least one verbatim frame");
  assert.equal(recorded.type, "server-request");
  assert.equal(recorded.method, recorded.payload.type);
  assert.ok(recorded.rpcId, "every downlink frame carries an rpcId");
  assert.equal(golden.muxTransport, SEAMS.wire.downlinkTransport, "the fixture and the seam manifest must agree on the downlink transport");
  assert.equal(SEAMS.wire.downlinkTransport, "websocket", "a plain GET on the downlink answers 426 Upgrade Required");
  assert.equal(decodeMuxFrame(recorded), null, "session/subscribed is a subscription ack, not a run event");
});

test("running state comes from the host stream, and 'we were not told' is not 'idle'", async () => {
  const transport = scriptedTransport({ "/api/events.host": golden.host });
  const adapter = new DshRuntimeAdapter(transport);
  assert.equal(adapter.runningStatus("s-1"), "unknown", "an unasked session must not read as idle");
  const seen = [];
  await adapter.watchHost({ signal: AbortSignal.timeout(1000), onEvent: (frame) => seen.push(frame.type) });
  assert.equal(adapter.runningStatus("s-1"), "idle");
  assert.equal(adapter.runningStatus("s-2"), "unknown");
  assert.ok(seen.includes("host/agent-error"));
});

test("history paging walks back to the first page so the gate reads the whole run", async () => {
  const pages = [
    { ok: true, value: { events: golden.history.slice(6), hasMore: true } },
    { ok: true, value: { events: golden.history.slice(0, 6), hasMore: false } },
  ];
  let index = 0;
  const transport = scriptedTransport({ "session.history": () => pages[index++] });
  const adapter = new DshRuntimeAdapter(transport);
  const transcript = await adapter.transcript({ sessionId: "s-1", maxMessages: 6 });
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0].payload.beforeSeq, undefined);
  assert.equal(transport.calls[1].payload.beforeSeq, 6, "the second page must be anchored to the first event of the first");
  const tools = transcript.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool");
  assert.equal(tools.length, 3, "a truncated transcript would mark the earliest work as never done");
});

test("a kernel failure becomes a named control-plane error, not a thrown wire object", async () => {
  const transport = scriptedTransport({ "session.prompt": { ok: false, error: golden.errors[0] } });
  const adapter = new DshRuntimeAdapter(transport);
  await assert.rejects(
    adapter.prompt({ sessionId: "s-9", text: "x" }),
    (error) => error.code === "runtime_session_not_found" && error.status === 502,
  );
});

test("the golden fixtures are pinned to the kernel version the manifest names", async () => {
  const { SEAMS } = await import("@evimed/harness-port");
  assert.equal(golden.dsh, SEAMS.dsh, "re-record the golden frames when the pin moves, and read the diff");
});
