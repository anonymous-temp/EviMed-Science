import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_RECALL_SCOPES, recallAcrossMemory } from "../src/memoryRecall.mjs";
import { renderMemoryContext } from "../src/researchContext.mjs";

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
  id: "record:r1", content: "回答尽量简短", kind: "preference", scope: "user", memoryType: "structured", origin: "explicit",
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

// ---------------------------------------------------------------------------
// The time a question is about, and what is uncertain about the answer (N13).
// ---------------------------------------------------------------------------

test("a question that names a time is asked of the records at that time; one that does not is the call it always was", async () => {
  const s = services({ memory: [record()] });
  const answer = await recallAcrossMemory(s, user, { query: "简短", projectId: "p1", asOf: "2025-06-30", scope: "conversation" });
  assert.equal(s.calls[0][3].asOf, Date.parse("2025-06-30T23:59:59.999Z"), "a bare date is read at its end");
  assert.equal(answer.asOf, "2025-06-30T23:59:59.999Z", "the answer says which time it resolved the question to");
  const plain = await recallAcrossMemory(s, user, { query: "简短", projectId: "p1", scope: "conversation" });
  assert.equal("asOf" in s.calls[1][3], false);
  assert.equal("asOf" in plain, false);
  for (const asOf of ["last spring", "2025", "2025-13-45", 2025]) {
    await assert.rejects(recallAcrossMemory(s, user, { query: "x", asOf }), (error) => error.status === 400 && error.code === "memory_as_of_invalid", String(asOf));
  }
});

test("an uncertain record says why, and carries the other side or the sources; a plain one carries nothing extra", async () => {
  const uncertain = record({
    id: "record:r9", caveats: ["conflict", "source_retracted"], validity: { from: "2024-03-01T00:00:00Z", until: null },
    conflictsWith: [{ id: "r3", key: "project.dose.label", kind: "project_fact", scope: "project", summary: "说明书 20 mg" }],
    staleSources: [{ type: "doi", id: "10.1000/x", state: "retracted" }],
  });
  const s = services({ memory: [record(), uncertain] });
  const { items } = await recallAcrossMemory(s, user, { query: "剂量", scope: "conversation" });
  const [plain, flagged] = items;
  for (const field of ["uncertain", "caveats", "validity", "conflictsWith", "staleSources"]) assert.equal(field in plain, false, field);
  assert.equal(plain.origin, "explicit", "whose statement a record is travels with it");
  assert.equal(flagged.uncertain, true);
  assert.deepEqual(flagged.caveats, ["conflict", "source_retracted"]);
  assert.equal(flagged.conflictsWith[0].key, "project.dose.label");
  assert.equal(flagged.staleSources[0].state, "retracted");
  assert.equal(flagged.contextOnly, true, "uncertain or not, a record is context and never permission");
});

test("the memory block marks an uncertain memory once and says how to read the mark, and leaves a plain block as it was", () => {
  const plain = renderMemoryContext([{ id: "record:a", content: "回答尽量简短", kind: "preference", scope: "user", memoryType: "structured" }]);
  assert.doesNotMatch(plain, /caveats/);
  const flagged = renderMemoryContext([
    { id: "record:a", content: "说明书写 20 mg", kind: "project_fact", scope: "project", memoryType: "structured",
      caveats: ["conflict", "source_changed"], validity: { from: "2024-03-01T00:00:00Z", until: null },
      conflictsWith: [{ id: "b", key: "project.dose.said", origin: "explicit", summary: "研究者说 10 mg <b>" }],
      staleSources: [{ type: "doi", id: "10.1000/x", state: "changed" }] },
    { id: "record:b", content: "另一条", kind: "preference", scope: "user", memoryType: "structured", caveats: ["not_yet_valid"] },
  ]);
  assert.match(flagged, /caveats="conflict,source_changed"/);
  assert.match(flagged, /caveats="not_yet_valid"/);
  assert.equal((flagged.match(/带 caveats 属性的记忆/g) ?? []).length, 1);
  assert.match(flagged, /有效期：2024-03-01T00:00:00Z 起，至今 止/);
  assert.match(flagged, /与此冲突的另一条记忆（project\.dose\.said，用户所述）：研究者说 10 mg &lt;b&gt;/, "text out of a record is escaped, as everything in the block is; and who made the statement is said");
  assert.match(flagged, /所依据的来源 10\.1000\/x：已更正或数据已修订/);
});
