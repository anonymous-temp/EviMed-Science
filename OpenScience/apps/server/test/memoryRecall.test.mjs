import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_RECALL_SCOPES, recallAcrossMemory } from "../src/memoryRecall.mjs";

// What these cases pin down is not the merge arithmetic but the promise the
// two callers' schemas already made: `scope: all` means both stores. Before
// this module, a recall through the runtime tool or the external API reached
// the capsule facts and never the records the extractor writes — so a child
// asking "what does this researcher prefer?" got a different answer from the
// root, which had the records pushed into its prompt.

const user = { id: "u1", accountCreatedAt: "2026-01-01T00:00:00.000Z" };

function services({ memory = [], facts = [] } = {}) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    capsules: {
      async recall(userId, input) { calls.push(["capsule", userId, input]); return { items: facts, mode: "lexical", contextOnly: true }; },
    },
    memorySubstrate: {
      async recall(userId, query, scope) { calls.push(["memory", userId, query, scope]); return memory; },
    },
  };
}

const record = (over = {}) => ({
  id: "record:r1", content: "回答尽量简短", kind: "preference", scope: "user", memoryType: "structured",
  updatedAt: "2026-09-01T00:00:00.000Z", confidence: 0.9, importance: 0.6, ...over,
});
const fact = (over = {}) => ({ id: "fact_1", capsuleId: "cap_1", factKind: "preference", content: "偏好中文", origin: "explicit", ...over });

test("scope all searches both stores, records first, and tags every item with its source", async () => {
  const s = services({ memory: [record()], facts: [fact()] });
  const result = await recallAcrossMemory(s, user, { query: "简短", projectId: "p1" });
  assert.deepEqual(result.items.map((item) => [item.source, item.id]), [["memory", "record:r1"], ["capsule", "fact_1"]]);
  assert.equal(result.items[0].kind, "preference");
  assert.equal(result.items[0].scope, "user");
  assert.equal(result.items[0].contextOnly, true, "a record is context, never permission");
  assert.equal(result.items[1].contextOnly, true);
  assert.deepEqual(result.sources, { memory: 1, capsule: 1 });
  assert.equal(result.mode, "lexical");
  assert.equal(result.contextOnly, true);
  // The capsule half is asked for the capsule only — `all` is decided here,
  // not re-interpreted by the service — with the account generation it needs.
  assert.equal(s.calls[0][2].scope, "capsule");
  assert.equal(s.calls[0][2].projectId, "p1");
  assert.equal(s.calls[0][2].accountCreatedAt, user.accountCreatedAt);
  // `countUsage` says whether this read is a run being handed memories: the
  // memory page's own search goes through the same port and must not move
  // 「用过 N 次」 (memoryRoutes.mjs).
  assert.deepEqual(s.calls[1].slice(1), ["u1", "简短", { projectId: "p1", sessionId: null, countUsage: true }]);
});

test("conversation leaves the capsule alone and capsule leaves the records alone", async () => {
  const s = services({ memory: [record()], facts: [fact()] });
  const conversation = await recallAcrossMemory(s, user, { query: "简短", scope: "conversation" });
  assert.deepEqual(conversation.items.map((item) => item.source), ["memory"]);
  assert.deepEqual(s.calls.map((call) => call[0]), ["memory"]);
  assert.equal(conversation.mode, "none", "no capsule answered, so no capsule mode is claimed");
  s.calls.length = 0;
  const capsule = await recallAcrossMemory(s, user, { query: "简短", scope: "capsule" });
  assert.deepEqual(capsule.items.map((item) => item.source), ["capsule"]);
  assert.deepEqual(s.calls.map((call) => call[0]), ["capsule"]);
});

test("limit bounds the union; since and factKinds narrow the records the way they narrow the facts", async () => {
  const older = record({ id: "record:r2", kind: "behavior", updatedAt: "2026-08-01T00:00:00.000Z" });
  const s = services({ memory: [record(), older], facts: [fact()] });
  const bounded = await recallAcrossMemory(s, user, { query: "简短", limit: 2 });
  assert.deepEqual(bounded.items.map((item) => item.id), ["record:r1", "record:r2"], "records fill the budget before facts do");
  assert.deepEqual(bounded.sources, { memory: 2, capsule: 1 }, "sources count what each store answered, not what fit");
  const recent = await recallAcrossMemory(s, user, { query: "简短", since: "2026-08-15T00:00:00.000Z" });
  assert.deepEqual(recent.items.map((item) => item.id), ["record:r1", "fact_1"]);
  const kinds = await recallAcrossMemory(s, user, { query: "简短", factKinds: ["preference"] });
  assert.deepEqual(kinds.items.map((item) => item.id), ["record:r1", "fact_1"]);
  assert.deepEqual(s.calls.at(-2)[2].factKinds, ["preference"], "the capsule half gets the same narrowing");
});

test("agenda is refused by name, and a store that is not deployed is an empty half rather than an error", async () => {
  const s = services({ memory: [record()], facts: [fact()] });
  await assert.rejects(
    recallAcrossMemory(s, user, { query: "x", scope: "agenda" }),
    (error) => error.status === 400 && error.code === "capsule_scope_unavailable",
  );
  const capsuleOnly = await recallAcrossMemory({ capsules: s.capsules, memorySubstrate: null }, user, { query: "x" });
  assert.deepEqual(capsuleOnly.items.map((item) => item.source), ["capsule"]);
  assert.deepEqual(capsuleOnly.sources, { memory: 0, capsule: 1 });
  const recordsOnly = await recallAcrossMemory({ capsules: null, memorySubstrate: s.memorySubstrate }, user, { query: "x" });
  assert.deepEqual(recordsOnly.items.map((item) => item.source), ["memory"]);
  assert.equal(recordsOnly.mode, "none");
  assert.deepEqual([...MEMORY_RECALL_SCOPES], ["all", "capsule", "conversation"]);
});
