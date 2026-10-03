import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTranscript } from "../src/dshRuntimeAdapter.mjs";
import { methodObservationSessionsForRun, runMethodObservations } from "../src/methodObservations.mjs";
import { learnedMethodDirectoryName } from "../src/learnedMethodMount.mjs";

const method = { id: "method:learned:turn-reading", name: "turn-reading", digest: `sha256:${"a".repeat(64)}`, contentDigest: `sha256:${"b".repeat(64)}` };
const skillPath = `/runtime/capsule-methods/${learnedMethodDirectoryName(method.id)}/SKILL.md`;
const projection = {
  mountedMethods: [{ name: method.name, digest: method.digest }],
  plan: { items: [{ id: "report", status: "accepted", attempts: 1 }] },
  subagents: [],
};
function transcript({ currentRead = false, currentRequest = "current", pluginInput = false } = {}) {
  const event = (type, seq, data) => ({ type, seq, time: 1_000 + seq, data });
  return normalizeTranscript("root", [
    event("turn/start", 0, { turn: 1 }),
    event("user/message", 1, { source: { kind: "user", rpcId: "old" }, content: [{ type: "text", text: "previous subject" }] }),
    event("tool/call", 2, { name: "read", callId: "old-read", arguments: { path: skillPath } }),
    event("tool/result", 3, { callId: "old-read", content: "old method body" }),
    event("turn/end", 4, { kind: "completed" }),
    event("turn/start", 10, { turn: 2 }),
    event("user/message", 11, { source: { kind: pluginInput ? "plugin" : "user", rpcId: currentRequest }, content: [{ type: "text", text: "changed subject" }] }),
    ...(currentRead ? [event("tool/call", 12, { name: "read", callId: "current-read", arguments: { path: skillPath } }),
      event("tool/result", 13, { callId: "current-read", content: "current method body" })] : []),
    event("turn/end", 14, { kind: "completed" }),
  ]);
}
function observe({ run = { id: "run-current", sessionId: "root", kernelRequestIds: ["current"] }, state = projection, sessions = [{ sessionId: "root", transcript: transcript() }] } = {}) {
  return runMethodObservations({ run, projection: state, methods: [method], sessions: methodObservationSessionsForRun({ run, projection: state, sessions }) });
}

test("a previous root read is not a current invocation or outcome use, while current mount remains visible", () => {
  const result = observe();
  assert.deepEqual(result.methodsLoaded, [{ name: method.name, digest: method.digest }]);
  assert.deepEqual(result.methodsInvoked, []);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].observation.invoked, false);
  assert.equal(result.observations[0].observation.contentDigest, method.contentDigest);
});

test("an actual current native request read is attributed to its exact mounted digest and deliverable", () => {
  const result = observe({ sessions: [{ sessionId: "root", transcript: transcript({ currentRead: true }) }] });
  assert.deepEqual(result.methodsInvoked, [{ name: method.name, digest: method.digest }]);
  assert.equal(result.observations[0].observation.family, "run-current:report");
  assert.equal(result.observations[0].observation.invoked, true);
});

test("lost or plugin-only input identity and timestamps alone cannot prove a current read", () => {
  for (const current of [transcript({ currentRead: true, currentRequest: "unrelated" }), transcript({ currentRead: true, pluginInput: true }),
    { messages: [{ role: "tool", time: 1_012, parts: [{ type: "tool", tool: "read", status: "completed", input: { path: skillPath } }] }] }]) {
    const result = observe({ sessions: [{ sessionId: "root", transcript: current }] });
    assert.deepEqual(result.methodsInvoked, []); assert.equal(result.observations[0].observation.invoked, false);
  }
});

test("only a child assigned to a current deliverable can contribute a read or attribution", () => {
  const childRead = { messages: [{ role: "tool", parts: [{ type: "tool", tool: "read", status: "completed", input: { path: skillPath } }] }] };
  const assigned = { ...projection, subagents: [{ deliverableId: "report", childSessionId: "current-child", methods: [{ name: method.name, digest: method.digest }] },
    { deliverableId: "previous-deliverable", childSessionId: "old-child", methods: [{ name: method.name, digest: method.digest }] }] };
  const result = observe({ state: assigned, sessions: [{ sessionId: "root", transcript: transcript() },
    { sessionId: "old-child", transcript: childRead }, { sessionId: "unassigned-child", transcript: childRead },
    { sessionId: "current-child", transcript: { messages: [] } }] });
  assert.deepEqual(result.methodsInvoked, []);
  assert.equal(result.observations.length, 1); assert.equal(result.observations[0].observation.invoked, false);
  const used = observe({ state: assigned, sessions: [{ sessionId: "current-child", transcript: childRead }] });
  assert.deepEqual(used.methodsInvoked, [{ name: method.name, digest: method.digest }]);
  assert.equal(used.observations[0].observation.invoked, true);
});

test("a recorded native turn identity works only when there is no conflicting request identity", () => {
  const sessions = [{ sessionId: "root", transcript: transcript({ currentRead: true }) }];
  const proven = observe({ run: { id: "run-current", sessionId: "root", nativeTurn: { startSeq: 10 } }, sessions });
  assert.equal(proven.observations[0].observation.invoked, true);
  const unknown = observe({ run: { id: "run-current", sessionId: "root", nativeTurn: { startSeq: 10 }, kernelRequestIds: ["missing"] }, sessions });
  assert.equal(unknown.observations[0].observation.invoked, false);
});

test("a supplement request sharing the owned turn remains included without claiming another turn", () => {
  const base = transcript({ currentRead: true });
  const current = { ...base, messages: [...base.messages,
    { role: "user", source: "user", sourceRequestId: "supplement", turnStartSeq: 10, seq: 15, parts: [] }] };
  const sessions = methodObservationSessionsForRun({ run: { sessionId: "root", kernelRequestIds: ["supplement"] }, projection, sessions: [{ sessionId: "root", transcript: current }] });
  assert.ok(sessions[0].transcript.messages.every(message => message.turnStartSeq === 10));
  assert.ok(sessions[0].transcript.messages.some(message => message.role === "tool"));
  assert.equal(current.messages[0].turnStartSeq, 0, "the preserved conversation is not trimmed in place");
});
