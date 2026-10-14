// Whose words a stored memory's evidence is, read from the run ledger and the stored transcripts: the person's, the assistant's,
// the platform's dispatch, or nothing anyone can place. Structure only; no message is judged by its wording.
import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceProvenance } from "../src/memoryEvidenceProvenance.mjs";

const SESSION = "autopilot-task";
const ref = (seq, session = SESSION) => `sessions/${session}/messages/seq_${seq}`;
const record = (evidence, fields = {}) => ({ scope: "user", scopeId: "", evidence: evidence.map((sourceRef) => ({ sourceRef })), ...fields });

/** One task conversation after three executions and one turn the person typed, and what the reader asked of the ledger and the disk. */
function world({ transcripts = true, person = true } = {}) {
  const runs = [
    ...(person ? [{ id: "run_person", sessionId: SESSION, effectiveRouteReason: "adopted:runtime-ui", kernelRequestIds: ["req_person"], startedAt: "2026-10-12T00:00:00Z" }] : []),
    { id: "run_2", sessionId: SESSION, effectiveRouteReason: "autopilot:routine", kernelRequestIds: ["req_2"], startedAt: "2026-10-11T00:00:00Z" },
    { id: "run_1", sessionId: SESSION, effectiveRouteReason: "autopilot:routine", kernelRequestIds: ["req_1"], startedAt: "2026-10-10T00:00:00Z" },
  ];
  const messages = [
    { sessionId: SESSION, seq: 8, role: "user", source: "user", sourceRequestId: "req_1", parts: [{ type: "text", text: "每天早上检索新文献，整理成简报。" }] },
    { sessionId: SESSION, seq: 9, role: "assistant", parts: [{ type: "text", text: "今天新增 12 篇。" }] },
    { sessionId: SESSION, seq: 12, role: "user", source: "user", sourceRequestId: "req_2", parts: [{ type: "text", text: "每天早上检索新文献，整理成简报。" }] },
    { sessionId: SESSION, seq: 20, role: "user", source: "user", sourceRequestId: "req_person", parts: [{ type: "text", text: "以后简报按日期倒序。" }] },
    { sessionId: SESSION, seq: 21, role: "user", source: "plugin:evimed-run-policy", sourceRequestId: "req_person", parts: [{ type: "text", text: "context" }] },
    { sessionId: SESSION, seq: 22, role: "tool", parts: [{ type: "text", text: "result" }] },
    { sessionId: "another", seq: 8, role: "user", source: "user", sourceRequestId: "req_x", parts: [{ type: "text", text: "not this conversation" }] },
  ];
  const reads = [];
  const project = { id: "prj_1" };
  const provenance = createEvidenceProvenance({
    projectsFor: async (_user, scopeId) => (scopeId && scopeId !== "prj_1" ? [] : [project]),
    runIndex: async () => new Map([[SESSION, runs]]),
    readTranscript: async (_project, runId) => { reads.push(runId); return transcripts ? { messages } : null; },
  });
  return { provenance, reads };
}

test("a message is the assistant's by its role, a dispatch by the request it came in, the person's otherwise", async () => {
  const { provenance } = world();
  assert.deepEqual(await provenance("u1", record([ref(8), ref(12)])), ["dispatched", "dispatched"], "every execution's instruction, first or later");
  assert.deepEqual(await provenance("u1", record([ref(9), ref(22)])), ["assistant", "assistant"]);
  assert.deepEqual(await provenance("u1", record([ref(20)])), ["person"], "what the person typed into the task's conversation is theirs");
  assert.deepEqual(await provenance("u1", record([ref(21)])), ["dispatched"], "platform text in the user slot is the platform's, by the sender it records");
});

test("a transcript is read newest run first, once, and only as far as the message is found", async () => {
  const { provenance, reads } = world();
  await provenance("u1", record([ref(8)]));
  await provenance("u1", record([ref(12), ref(20)]));
  assert.deepEqual(reads, ["run_person"], "the newest transcript holds the whole conversation");
});

test("what nothing can place is unknown, except in a conversation the platform alone ever spoke in", async () => {
  const { provenance } = world({ transcripts: false });
  assert.deepEqual(await provenance("u1", record([ref(8)])), ["unknown"], "a person also typed in this conversation");
  assert.deepEqual(await provenance("u1", record(["runs/run_1", "sessions/s/messages/m4", ref(99, "no-such-conversation")])), ["unknown", "unknown", "unknown"]);
  const only = world({ transcripts: false, person: false });
  assert.deepEqual(await only.provenance("u1", record([ref(8)])), ["dispatched"], "the platform alone started every turn there");
  // A project-scoped memory looks only in its own project.
  assert.deepEqual(await world().provenance("u1", record([ref(8)], { scope: "project", scopeId: "prj_other" })), ["unknown"]);
  assert.deepEqual(await world().provenance("u1", record([ref(8)], { scope: "project", scopeId: "prj_1" })), ["dispatched"]);
});

test("a ledger or a transcript that cannot be read leaves the evidence unknown rather than failing the reading", async () => {
  const broken = createEvidenceProvenance({
    projectsFor: async () => [{ id: "p" }],
    runIndex: async () => { throw new Error("ledger"); },
    readTranscript: async () => { throw new Error("disk"); },
  });
  assert.deepEqual(await broken("u1", record([ref(8)])), ["unknown"]);
  const noDisk = createEvidenceProvenance({
    projectsFor: async () => [{ id: "p" }],
    runIndex: async () => new Map([[SESSION, [{ id: "r", sessionId: SESSION, effectiveRouteReason: "adopted:runtime-ui", kernelRequestIds: [] }]]]),
    readTranscript: async () => { throw new Error("disk"); },
  });
  assert.deepEqual(await noDisk("u1", record([ref(8)])), ["unknown"]);
});
