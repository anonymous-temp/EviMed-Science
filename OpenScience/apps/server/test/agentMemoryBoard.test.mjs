/**
 * The memory dashboard an integrator draws, and the acts a person takes on it,
 * without a database. What the rows say — source, basis, 「曾经如此」,
 * what waits, what changed and how to take it back — is derived from the
 * memory files and methods these doubles hold; `agentMemoryBoard.integration.test.mjs`
 * drives the same thing through the real stores.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BOARD_SOURCES, memoryBoard, methodAction, methodDetail, noteAction, recordAction } from "../src/agentMemoryBoard.mjs";

const NOW = new Date("2026-09-27T00:00:00.000Z");

/** A memory file as the engine's store returns one. @param {Record<string, any>} overrides */
function record(overrides) {
  return {
    id: "r1", kind: "preference", scope: "user", scopeId: "", key: "preference.x", value: "v", summary: "s",
    origin: "explicit", status: "active", version: 1, sensitive: false,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    supersededBy: null, invalidSince: null, provenance: { basis: "stated", observations: 1, runs: 1, conversations: 1 },
    evidence: [{ quote: "原话", observedAt: "2026-09-01T00:00:00.000Z", sourceRef: "sessions/s1/messages/0" }], revisions: [],
    ...overrides,
  };
}

function memoryDouble(records) {
  const calls = [];
  const memorySettings = { async settings() { return { learningPaused: false, recallPaused: true }; } };
  const nativeMemory = {
    calls,
    configured: true,
    async listRecords(userId, input) { calls.push(["listRecords", userId, input]); return records; },
    async changes(userId, input) {
      calls.push(["changes", userId, input]);
      return [{ id: "r3", kind: "preference", change: "created", summary: "新记下的", changedAt: "2026-09-26T00:00:00.000Z", version: 1 }];
    },
    overlay: { async admission() { return null; } },
    async update(userId, id, input) { calls.push(["update", userId, id, input]); return { id, ...input, version: input.expectedVersion + 1 }; },
    async undo(userId, id, options) { calls.push(["undo", userId, id, options]); return { undone: "removed", record: null }; },
  };
  return { memorySettings, nativeMemory, calls };
}

const method = (overrides = {}) => ({
  id: "method:learned:habit-a", revision: 3, createdAt: "2026-09-20T00:00:00.000Z",
  payload: {
    status: "approved", statusChangedAt: "2026-09-20T00:00:00.000Z", contentDigest: "d2",
    display: { title: "脾胃气虚证：太子参易党参", summary: "你常以太子参替代党参。" },
    frontmatter: { name: "habit-a" }, provenance: { origin: "inferred", source: "observations" }, learning: { counts: { loaded: 4 } },
    ...overrides,
  },
});

test("a record row says where it came from, how established it is, and what it used to say", async () => {
  const records = [
    record({
      id: "r1", summary: "RCT 优先，接受高质量队列研究", value: "RCT 优先，接受高质量队列研究", version: 2,
      revisions: [{ version: 1, summary: "选证据只看 RCT", value: "选证据只看 RCT", status: "active", changedAt: "2026-09-20T14:32:00.000Z", by: "extraction" }],
    }),
    record({ id: "r4", status: "archived" }),
    record({ id: "r5", kind: "run_summary" }),
  ];
  const { memorySettings, nativeMemory } = memoryDouble(records);
  const board = await memoryBoard({ memorySettings, nativeMemory, now: () => NOW }, { id: "u1" });
  assert.deepEqual(board.switches, { learningPaused: false, recallPaused: true });
  assert.deepEqual(board.records.map((row) => row.id), ["r1"], "in force only; a run summary is never a row");
  const [row] = board.records;
  assert.equal(row.source, "self");
  assert.equal(row.sourceLabel, BOARD_SOURCES.self);
  assert.deepEqual(row.basis, { kind: "stated", observations: 1, runs: 1, conversations: 1 });
  assert.deepEqual(row.usage, { count: 0, lastUsedAt: null }, "the engine counts no use");
  assert.deepEqual(row.wasTrue.map((item) => [item.summary, item.from, item.until]), [
    ["选证据只看 RCT", "2026-09-01T00:00:00.000Z", "2026-09-20T14:32:00.000Z"],
  ], "an earlier value, with when it held");
  assert.deepEqual(board.pending, [], "the engine's files wait for nothing");
  assert.deepEqual(board.forgotten.map((item) => item.id), ["r4"]);
  assert.deepEqual(board.recentChanges[0].undo, { action: "undo", path: "records/r3/undo", expectedVersion: 1 });
});

test("a note an outside agent proposed waits in the dashboard, and a received pack's entry does not", async () => {
  const capsules = {
    documents: {
      async list(_userId, kind, { filter }) {
        assert.equal(kind, "fact");
        assert.deepEqual(filter, { status: "candidate" });
        return { items: [
          { id: "runtime-note:1", revision: 1, createdAt: "2026-09-26T00:00:00.000Z", payload: { capsuleId: "c1", factKind: "preference", content: "药味不超过 12 味", status: "candidate" } },
          { id: "imported", revision: 1, payload: { capsuleId: "c2", factKind: "preference", content: "x", status: "candidate", transfer: {} } },
        ] };
      },
    },
  };
  const board = await memoryBoard({ ...memoryDouble([]), capsules, now: () => NOW }, { id: "u1" });
  assert.deepEqual(board.pending.map((item) => [item.type, item.id, item.summary, item.revision]), [["note", "runtime-note:1", "药味不超过 12 味", 1]]);
});

test("a habit is new for fourteen days, says it was learned from prescription edits, and 最近变化 offers to stop it", async () => {
  const learning = {
    async listMethods() {
      return { items: [
        method(),
        method({ status: "retired", statusChangedAt: "2026-09-25T00:00:00.000Z", statusReason: "你在看板上停用了它" }),
        method({ status: "candidate" }),
      ].map((document, index) => ({ ...document, id: `m${index}` })) };
    },
  };
  const basis = new Map([["m0", { observed: 9, related: 12 }]]);
  const observations = { basis: async () => basis, neverLearned: async () => [{ herb: "附子", count: 3 }] };
  const board = await memoryBoard({ ...memoryDouble([]), learning, observations, now: () => NOW }, { id: "u1" });
  assert.deepEqual(board.neverLearned, [{ herb: "附子", count: 3 }], "「不学习」: what was seen and never learned from");
  assert.deepEqual(board.habits.map((habit) => [habit.id, habit.status, habit.isNew]), [["m0", "approved", true], ["m1", "retired", false]]);
  assert.equal(board.habits[0].source, "observed");
  assert.equal(board.habits[0].sourceLabel, "从改方学习");
  assert.deepEqual(board.habits[0].basis, { observed: 9, related: 12 });
  const changes = board.recentChanges.filter((change) => change.type === "habit");
  assert.deepEqual(changes.map((change) => [change.methodId, change.undo.action]), [["m1", "restore"], ["m0", "retire"]]);
  const old = await memoryBoard({ ...memoryDouble([]), learning, now: () => new Date("2026-10-20T00:00:00.000Z") }, { id: "u1" });
  assert.equal(old.habits[0].isNew, false, "past fourteen days it is not new");
});

test("a subject with no memory yet reads an empty dashboard and nothing is created", async () => {
  const board = await memoryBoard({ memorySettings: { settings() { throw new Error("must not read"); } } }, null);
  assert.deepEqual(board, { switches: { learningPaused: false, recallPaused: false }, records: [], pending: [], forgotten: [], habits: [], neverLearned: [], recentChanges: [] });
});

test("an act on a memory file is the page's act on the file: forget and edit write it, undo takes the last act back, nothing waits to be confirmed", async () => {
  const id = `nm_${"a".repeat(24)}`;
  const { nativeMemory } = memoryDouble([record({ id })]);
  const user = { id: "u1" };
  await assert.rejects(() => recordAction({ nativeMemory }, user, id, "confirm", { expectedVersion: 1 }), (error) => error.code === "memory_not_pending");
  await assert.rejects(() => recordAction({ nativeMemory }, user, id, "restore", { expectedVersion: 1 }), (error) => error.code === "memory_engine_unsupported");

  const forgotten = await recordAction({ nativeMemory }, user, id, "forget", { expectedVersion: 1 });
  assert.deepEqual(nativeMemory.calls.at(-1), ["update", "u1", id, { status: "archived", expectedVersion: 1 }]);
  assert.equal(forgotten.event, "memory.record.forget");
  const edited = await recordAction({ nativeMemory }, user, id, "edit", { expectedVersion: 2, value: "  改过的一句  " });
  assert.deepEqual(nativeMemory.calls.at(-1), ["update", "u1", id, { value: "改过的一句", expectedVersion: 2 }]);
  assert.equal(edited.event, "memory.record.edit");
  await assert.rejects(() => recordAction({ nativeMemory }, user, id, "edit", { expectedVersion: 2, summary: "只改摘要" }), (error) => error.code === "memory_engine_unsupported");
  await assert.rejects(() => recordAction({ nativeMemory }, user, id, "edit", { expectedVersion: 2, value: "x", origin: "explicit" }),
    (error) => error.code === "agent_memory_payload_invalid", "no field says whose it is");
  const undone = await recordAction({ nativeMemory }, user, id, "undo", { expectedVersion: 3 });
  assert.deepEqual(nativeMemory.calls.at(-1), ["undo", "u1", id, { expectedVersion: 3 }]);
  assert.equal(undone.event, "memory.record.undo.removed");

  // An id the engine did not mint is nobody's memory, and a deployment without the engine answers by name.
  await assert.rejects(() => recordAction({ nativeMemory }, user, "rec_legacy", "forget", { expectedVersion: 1 }), (error) => error.code === "memory_not_found");
  await assert.rejects(() => recordAction({ nativeMemory: { configured: false } }, user, id, "forget", { expectedVersion: 1 }), (error) => error.code === "memory_engine_unavailable");
});

test("taking a stop back is the ledger's rollback from where the method stands, and its versions are its bodies", async () => {
  const calls = [];
  let status = "retired";
  const learning = {
    async getMethod(_userId, id) { return { id, revision: 5, payload: { status, body: "## Purpose", bodyVersion: 2 } }; },
    async rollback(userId, id, input) { calls.push(["rollback", id, input]); return { id, revision: 6, payload: { status: "approved" } }; },
    async retire(userId, id, input) { calls.push(["retire", id, input]); return { id, revision: 6, payload: { status: "retired" } }; },
    async history() {
      return [
        { version: 2, revision: 3, contentDigest: "d2", at: "2026-09-25T00:00:00.000Z", title: "B", current: true },
        { version: 1, revision: 1, contentDigest: "d1", at: "2026-09-20T00:00:00.000Z", title: "A", current: false },
      ];
    },
  };
  await methodAction({ learning }, { id: "u1" }, "m", "restore", { expectedRevision: 5 });
  assert.deepEqual(calls[0], ["rollback", "m", { expectedRevision: 5, targetRevision: 5 }],
    "the ledger walks back past the stop to the last state in use; the dashboard does not guess a revision");
  await methodAction({ learning }, { id: "u1" }, "m", "retire", { expectedRevision: 5 });
  assert.equal(calls[1][2].reason, "你在看板上停用了它");
  const detail = await methodDetail({ learning }, { id: "u1" }, "m");
  assert.equal(detail.version, 2);
  assert.deepEqual(detail.versions.map((version) => [version.version, version.title, version.wasTrue]), [[2, "B", false], [1, "A", true]],
    "the earlier body is 曾经如此");
  status = "approved";
  await assert.rejects(() => methodAction({ learning }, { id: "u1" }, "m", "restore", { expectedRevision: 5 }), (error) => error.code === "method_not_retired");
});

test("a proposed note is admitted to the engine when confirmed and retired as the capsule entry it is when rejected, and nothing else is", async () => {
  const updates = [];
  const admitted = [];
  const capsules = {
    documents: { async get(_userId, _kind, id) { return id === "n1" ? { id, revision: 1, projectId: null, payload: { capsuleId: "c1", status: "candidate", content: "引用写到页码。" } } : null; } },
    async updateEntry(userId, capsuleId, entryId, input) { updates.push([capsuleId, entryId, input]); return { id: entryId, revision: 2, payload: { status: input.status } }; },
  };
  const nativeMemory = { configured: true, async admitCandidate(userId, input) { admitted.push([userId, input]); return { state: "pending" }; } };
  await assert.rejects(() => noteAction({ capsules, nativeMemory }, { id: "u1" }, "n1", "confirm", { expectedRevision: 2 }), { code: "product_revision_conflict" });
  assert.equal(admitted.length, 0, "a stale confirmation admits nothing");
  const confirmed = await noteAction({ capsules, nativeMemory }, { id: "u1" }, "n1", "confirm", { expectedRevision: 1 });
  assert.deepEqual(admitted, [["u1", { candidateId: "n1", revision: 1, projectId: null, text: "引用写到页码。" }]]);
  assert.equal(confirmed.admission.state, "pending");
  assert.equal(updates.length, 0, "the note stays a candidate until the engine has written it");
  await noteAction({ capsules, nativeMemory }, { id: "u1" }, "n1", "reject", { expectedRevision: 1 });
  assert.deepEqual(updates.map((entry) => entry[2].status), ["retired"]);
  await assert.rejects(() => noteAction({ capsules, nativeMemory }, { id: "u1" }, "other", "confirm", { expectedRevision: 1 }), (error) => error.code === "note_not_found");
  await assert.rejects(() => noteAction({ capsules, nativeMemory: { configured: false } }, { id: "u1" }, "n1", "confirm", { expectedRevision: 1 }), (error) => error.code === "memory_engine_unavailable");
});
