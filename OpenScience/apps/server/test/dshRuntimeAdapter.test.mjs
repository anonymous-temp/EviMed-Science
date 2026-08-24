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
