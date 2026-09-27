/**
 * The memory dashboard an integrator draws, and the acts a person takes on it,
 * without a database. What the rows say — source, basis, usage, 「曾经如此」,
 * what waits, what changed and how to take it back — is derived from the
 * records and methods these doubles hold; `agentMemoryBoard.integration.test.mjs`
 * drives the same thing through the real stores.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BOARD_SOURCES, memoryBoard, methodAction, methodDetail, noteAction, recordAction } from "../src/agentMemoryBoard.mjs";

const NOW = new Date("2026-09-27T00:00:00.000Z");

/** A record as `researchMemory` returns one. @param {Record<string, any>} overrides */
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
  return {
    calls,
    configured: true,
    async settings() { return { learningPaused: false, recallPaused: true }; },
    async listRecords(userId, input) { calls.push(["listRecords", userId, input]); return records; },
    async recordUsage() { return { r1: { count: 7, lastUsedAt: "2026-09-26T10:12:00.000Z" } }; },
    async recentChanges(userId, input) {
      calls.push(["recentChanges", userId, input]);
      return [{ id: "r3", kind: "preference", change: "created", summary: "新记下的", changedAt: "2026-09-26T00:00:00.000Z", version: 1 }];
    },
    async getRecord(_userId, id) { return records.find((item) => item.id === id); },
    async upsertRecord(userId, next, evidence, options) { calls.push(["upsertRecord", userId, next, options]); return { ...next, version: next.version + 1 }; },
    async undo(userId, id, options) { calls.push(["undo", userId, id, options]); return { undone: "removed", record: null, previous: records[0], restored: [] }; },
  };
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

test("a record row says where it came from, how established it is, how often it was used, and what it used to say", async () => {
  const records = [
    record({
      id: "r1", summary: "RCT 优先，接受高质量队列研究", value: "RCT 优先，接受高质量队列研究", version: 2,
      revisions: [{ version: 1, summary: "选证据只看 RCT", value: "选证据只看 RCT", status: "active", changedAt: "2026-09-20T14:32:00.000Z", by: "extraction" }],
    }),
    record({ id: "r0", summary: "只用英文", status: "superseded", supersededBy: "r1", invalidSince: "2026-09-10T00:00:00.000Z" }),
    record({ id: "r2", status: "pending", origin: "inferred", provenance: { basis: "inferred", observations: 1, runs: 1, conversations: 1 } }),
    record({ id: "r4", status: "archived" }),
    record({ id: "r5", kind: "run_summary" }),
  ];
  const board = await memoryBoard({ researchMemory: memoryDouble(records), now: () => NOW }, { id: "u1" });
  assert.deepEqual(board.switches, { learningPaused: false, recallPaused: true });
  assert.deepEqual(board.records.map((row) => row.id), ["r1"], "in force only; a run summary is never a row");
  const [row] = board.records;
  assert.equal(row.source, "self");
  assert.equal(row.sourceLabel, BOARD_SOURCES.self);
  assert.deepEqual(row.basis, { kind: "stated", observations: 1, runs: 1, conversations: 1 });
  assert.deepEqual(row.usage, { count: 7, lastUsedAt: "2026-09-26T10:12:00.000Z" });
  assert.deepEqual(row.wasTrue.map((item) => [item.summary, item.from, item.until]), [
    ["选证据只看 RCT", "2026-09-01T00:00:00.000Z", "2026-09-20T14:32:00.000Z"],
    ["只用英文", "2026-09-01T00:00:00.000Z", "2026-09-10T00:00:00.000Z"],
  ], "an earlier value and a replaced record, each with when it held");
  assert.deepEqual(board.pending.map((item) => [item.type, item.id, item.source]), [["record", "r2", "inferred"]]);
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
  const board = await memoryBoard({ researchMemory: memoryDouble([]), capsules, now: () => NOW }, { id: "u1" });
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
  const board = await memoryBoard({ researchMemory: memoryDouble([]), learning, observations, now: () => NOW }, { id: "u1" });
  assert.deepEqual(board.neverLearned, [{ herb: "附子", count: 3 }], "「不学习」: what was seen and never learned from");
  assert.deepEqual(board.habits.map((habit) => [habit.id, habit.status, habit.isNew]), [["m0", "approved", true], ["m1", "retired", false]]);
  assert.equal(board.habits[0].source, "observed");
  assert.equal(board.habits[0].sourceLabel, "从改方学习");
  assert.deepEqual(board.habits[0].basis, { observed: 9, related: 12 });
  const changes = board.recentChanges.filter((change) => change.type === "habit");
  assert.deepEqual(changes.map((change) => [change.methodId, change.undo.action]), [["m1", "restore"], ["m0", "retire"]]);
  const old = await memoryBoard({ researchMemory: memoryDouble([]), learning, now: () => new Date("2026-10-20T00:00:00.000Z") }, { id: "u1" });
  assert.equal(old.habits[0].isNew, false, "past fourteen days it is not new");
});

test("a subject with no memory yet reads an empty dashboard and nothing is created", async () => {
  const board = await memoryBoard({ researchMemory: { settings() { throw new Error("must not read"); } } }, null);
  assert.deepEqual(board, { switches: { learningPaused: false, recallPaused: false }, records: [], pending: [], forgotten: [], habits: [], neverLearned: [], recentChanges: [] });
});

test("confirming makes a proposal the person's own, forgetting archives it, and each act is remembered for the extractor", async () => {
  const pending = record({ id: "r2", status: "pending", origin: "inferred", version: 3 });
  const researchMemory = memoryDouble([pending, record({ id: "r1" })]);
  const remembered = [];
  const feedbackEvents = {
    async recordMemoryUpdate(userId, input) { remembered.push(["update", userId, input.before.status, input.after.status]); },
    async recordMemoryDeletion(userId, input) { remembered.push(["deletion", userId, input.reason]); },
  };
  const confirmed = await recordAction({ researchMemory, feedbackEvents }, { id: "u1" }, "r2", "confirm", { expectedVersion: 3 });
  const write = researchMemory.calls.find((entry) => entry[0] === "upsertRecord");
  assert.equal(write[2].status, "active");
  assert.equal(write[2].origin, "explicit", "the person's own statement now");
  assert.equal(write[3].reason, "user confirmed a pending memory", "the reason the record's basis reads as 「你确认过」");
  assert.equal(write[3].by, "user");
  assert.equal(confirmed.event, "memory.record.confirm");
  await assert.rejects(() => recordAction({ researchMemory }, { id: "u1" }, "r2", "confirm", { expectedVersion: 2 }), (error) => error.code === "memory_conflict");
  await assert.rejects(() => recordAction({ researchMemory }, { id: "u1" }, "r1", "confirm", { expectedVersion: 1 }), (error) => error.code === "memory_not_pending");

  await recordAction({ researchMemory, feedbackEvents }, { id: "u1" }, "r1", "forget", { expectedVersion: 1 });
  assert.equal(researchMemory.calls.filter((entry) => entry[0] === "upsertRecord").at(-1)[2].status, "archived");
  await recordAction({ researchMemory, feedbackEvents }, { id: "u1" }, "r1", "edit", { expectedVersion: 1, summary: "改过的一句" });
  const edit = researchMemory.calls.filter((entry) => entry[0] === "upsertRecord").at(-1);
  assert.deepEqual([edit[2].summary, edit[2].origin], ["改过的一句", "manual"]);
  await recordAction({ researchMemory, feedbackEvents }, { id: "u1" }, "r1", "undo", { expectedVersion: 1 });
  assert.deepEqual(remembered.map((entry) => entry[0]), ["update", "update", "update", "deletion"]);
  assert.equal(remembered.at(-1)[2], "undone", "an undone write is a rejection the next extraction respects");
  await assert.rejects(() => recordAction({ researchMemory }, { id: "u1" }, "r1", "edit", { expectedVersion: 1, origin: "explicit" }),
    (error) => error.code === "agent_memory_payload_invalid", "no field says whose it is");
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

test("a proposed note is confirmed or rejected as the capsule entry it is, and nothing else is", async () => {
  const updates = [];
  const capsules = {
    documents: { async get(_userId, _kind, id) { return id === "n1" ? { id, payload: { capsuleId: "c1", status: "candidate" } } : null; } },
    async updateEntry(userId, capsuleId, entryId, input) { updates.push([capsuleId, entryId, input]); return { id: entryId, revision: 2, payload: { status: input.status } }; },
  };
  await noteAction({ capsules }, { id: "u1" }, "n1", "confirm", { expectedRevision: 1 });
  await noteAction({ capsules }, { id: "u1" }, "n1", "reject", { expectedRevision: 1 });
  assert.deepEqual(updates.map((entry) => entry[2].status), ["approved", "retired"]);
  await assert.rejects(() => noteAction({ capsules }, { id: "u1" }, "other", "confirm", { expectedRevision: 1 }), (error) => error.code === "note_not_found");
});
