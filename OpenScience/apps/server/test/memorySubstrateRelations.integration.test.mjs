import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { MemorySubstrate } from "../src/memorySubstrate.mjs";
import { openVikingPeerId } from "../src/openVikingClient.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { renderMemoryContext } from "../src/researchContext.mjs";
import { recallAcrossMemory } from "../src/memoryRecall.mjs";

/**
 * The index arm of recall, held to the same decision as the term matcher (N13).
 *
 * The real store and the real substrate against a real database, with an index
 * double that keeps real bounds: it answers only for the targets it is asked
 * about, never returns more than `limit`, and learns its content only from the
 * substrate's own writes. What it must never learn is validity, replacement or
 * conflict — those are decided at hydration, from the authority — and the whole
 * index must stay rebuildable from the records.
 */
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const owner = `memidx_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let store;

/** An OpenViking with real bounds and no knowledge of anything but what it was written. */
function indexDouble() {
  /** @type {Map<string, string>} */
  const leaves = new Map();
  const calls = { find: [], write: [], remove: [] };
  return {
    leaves, calls, configured: true,
    async status() { return { configured: true, connected: true, code: null }; },
    async write(_user, uri, content) { calls.write.push({ uri, content }); leaves.set(uri, content); return { ok: true }; },
    async remove(_user, uri, { recursive } = {}) {
      calls.remove.push(uri);
      let removed = false;
      for (const key of [...leaves.keys()]) {
        if (key === uri || (recursive && key.startsWith(`${uri}/`))) { leaves.delete(key); removed = true; }
      }
      return removed;
    },
    async find(_user, query, { targets = [], limit = 10 } = {}) {
      calls.find.push({ query, targets, limit });
      const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      return [...leaves.entries()]
        .filter(([uri]) => targets.some((target) => uri.startsWith(`${target}/`)))
        .map(([uri, content]) => ({ uri, content, level: 2, score: terms.filter((term) => content.toLowerCase().includes(term)).length / Math.max(1, terms.length) }))
        .filter((hit) => hit.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    },
  };
}

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Memory owner','development')", [owner]);
  await migrateProductStore(database);
  store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
});

beforeEach(async () => { if (store) await store.purgeRecords(owner); });

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
});

const day = (text) => Date.parse(`${text}T00:00:00Z`);
const proof = (quote = "said in the conversation") => ({ sourceType: "conversation_message", sourceRef: "sessions/ses_1/messages/1", quote });

function fact(overrides = {}) {
  return {
    scope: "project", scopeId: "prj_a", kind: "project_fact", key: "project.dose", value: "rivaroxaban dose is 20 mg once daily",
    summary: "", origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false, ...overrides,
  };
}

/** A substrate over the real store and a fresh index that has been rebuilt from it. */
async function indexed() {
  const index = indexDouble();
  const substrate = new MemorySubstrate({ memoryIndexProvider: "openviking", memoryContextLimit: 8, memoryContextMaxChars: 20_000 },
    { store, openViking: index });
  assert.equal(substrate.active, true);
  await substrate.rebuild(owner);
  return { index, substrate };
}
const idsOf = (memos) => memos.map((memo) => memo.id.replace(/^record:/, ""));

test("the index holds text and nothing else: a rebuild publishes only what a recall would hand over, with no relation in it", options, async () => {
  const resting = await store.upsertRecord(owner, fact({ key: "project.cites", value: "rivaroxaban cites a document", validFrom: "2025-01-01T00:00:00Z" }), proof(),
    { sourceLinks: [{ type: "doi", id: "10.1000/x" }] });
  const other = await store.upsertRecord(owner, fact({ key: "project.other", value: "rivaroxaban disagrees with it" }), proof());
  await store.markConflict(owner, resting.id, other.id);
  await store.markSourceLinks(owner, { type: "doi", id: "10.1000/x" }, { state: "retracted" });
  const { index } = await indexed();
  assert.deepEqual([...index.leaves.values()].sort(), ["rivaroxaban cites a document", "rivaroxaban disagrees with it"],
    "the copy is the memory's text: no date, no label, no conflict, no source");
  assert.equal([...index.leaves.keys()].every((uri) => uri.endsWith(".md")), true);
});

test("a recall through the index returns the version in force and the labels the authority holds, as the term matcher does", options, async () => {
  const said = await store.upsertRecord(owner, fact({ key: "project.dose.said", value: "the researcher says the rivaroxaban dose is 10 mg" }), proof());
  const label = await store.upsertRecord(owner, fact({ key: "project.dose.label", value: "the label says the rivaroxaban dose is 20 mg", origin: "system" }), proof("label"));
  await store.markConflict(owner, said.id, label.id);
  const { substrate, index } = await indexed();

  const viaIndex = await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", countUsage: false });
  const viaMatcher = await store.relevant(owner, "rivaroxaban dose", { projectId: "prj_a" });
  assert.ok(index.calls.find.length >= 1, "the index was asked");
  assert.deepEqual(new Set(idsOf(viaIndex)), new Set([said.id, label.id]));
  const labels = (memos) => Object.fromEntries(memos.map((memo) => [memo.id, [memo.caveats, memo.conflictsWith?.map((other) => other.id)]]));
  assert.deepEqual(labels(viaIndex), labels(viaMatcher), "one decision, whichever arm nominated the records");
  assert.deepEqual(labels(viaIndex)[`record:${said.id}`], [["conflict"], [label.id]]);
});

test("a stale index copy of a replaced or forgotten fact cannot put it back in front of the model", options, async () => {
  const old = await store.upsertRecord(owner, fact({ key: "project.dose.20", value: "rivaroxaban dose 20 mg", validFrom: "2025-01-01T00:00:00Z" }), proof());
  const { substrate, index } = await indexed();
  const { record: replacement } = await store.supersede(owner, old.id, fact({ key: "project.dose.15", value: "rivaroxaban dose 15 mg" }), proof("new"));
  // The index has not heard of the replacement: its copy of the old fact is still there.
  assert.equal([...index.leaves.values()].includes("rivaroxaban dose 20 mg"), true);
  assert.deepEqual(idsOf(await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", countUsage: false })), [],
    "the stale copy is nominated and dropped at hydration; nothing else is known to the index yet");
  await substrate.rebuild(owner);
  assert.deepEqual(idsOf(await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", countUsage: false })), [replacement.id]);

  // Forgotten: archived in the authority while the index still holds its text.
  const live = await store.getRecord(owner, replacement.id);
  await store.upsertRecord(owner, { ...live, status: "archived" }, null, { expectedVersion: live.version, by: "user" });
  assert.deepEqual(idsOf(await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", countUsage: false })), []);
});

test("a copy in another project's subtree is never asked for, and one that is found there is refused by its own scope", options, async () => {
  const other = await store.upsertRecord(owner, fact({ key: "project.b", value: "rivaroxaban dose in project b", scopeId: "prj_b" }), proof());
  const mine = await store.upsertRecord(owner, fact({ key: "project.a", value: "rivaroxaban dose in project a", scopeId: "prj_a" }), proof());
  const { substrate, index } = await indexed();
  const recalled = await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", countUsage: false });
  assert.deepEqual(idsOf(recalled), [mine.id]);
  assert.equal(index.calls.find.at(-1).targets.some((target) => target.endsWith(`/${openVikingPeerId("prj_b")}`)), false);
  // An index that mislaid the other project's copy under this project's subtree is not believed.
  const misplaced = [...index.leaves.keys()].find((uri) => uri.includes(mine.id));
  index.leaves.set(misplaced.replace(mine.id, other.id), "rivaroxaban dose in project b");
  assert.deepEqual(idsOf(await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", countUsage: false })), [mine.id]);
});

test("a question about another time is answered from the authority, because the index holds only what is in force now", options, async () => {
  const old = await store.upsertRecord(owner, fact({ key: "project.dose.20", value: "rivaroxaban dose 20 mg", validFrom: "2025-01-01T00:00:00Z" }), proof());
  const { record: replacement } = await store.supersede(owner, old.id, fact({ key: "project.dose.15", value: "rivaroxaban dose 15 mg" }), proof("new"));
  const { substrate, index } = await indexed();
  const finds = index.calls.find.length;
  const then = await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", countUsage: false, asOf: day("2025-06-15") });
  assert.deepEqual(idsOf(then), [old.id]);
  assert.equal(index.calls.find.length, finds, "the index was not consulted for a time it holds nothing about");
  assert.deepEqual(idsOf(await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", countUsage: false })), [replacement.id]);
});

test("the paused researcher is handed nothing, as a question about any time", options, async () => {
  await store.upsertRecord(owner, fact({ value: "rivaroxaban dose" }), proof());
  await store.updateSettings(owner, { recallPaused: true });
  const { substrate } = await indexed();
  assert.deepEqual(await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a", asOf: day("2025-06-15") }), []);
  assert.deepEqual(await substrate.recall(owner, "rivaroxaban dose", { projectId: "prj_a" }), []);
  await store.updateSettings(owner, { recallPaused: false });
});

test("the recall tool answers with what is uncertain and why, and renders it to the model once", options, async () => {
  const resting = await store.upsertRecord(owner, fact({ key: "project.cites", value: "rivaroxaban reduces stroke risk" }), proof(),
    { sourceLinks: [{ type: "knowledge_source", id: `src_${"c".repeat(32)}` }] });
  await store.markSourceLinks(owner, { type: "knowledge_source", id: `src_${"c".repeat(32)}` }, { state: "changed", reason: "revised" });
  const { substrate } = await indexed();
  const answer = await recallAcrossMemory({ capsules: null, memorySubstrate: substrate }, { id: owner }, { query: "rivaroxaban stroke", projectId: "prj_a", scope: "conversation" });
  assert.equal(answer.items.length, 1);
  assert.deepEqual([answer.items[0].uncertain, answer.items[0].caveats, answer.items[0].staleSources.map((source) => source.state)], [true, ["source_changed"], ["changed"]]);
  const rendered = renderMemoryContext(await substrate.recall(owner, "rivaroxaban stroke", { projectId: "prj_a", countUsage: false }));
  assert.match(rendered, /caveats="source_changed"/);
  assert.match(rendered, /已更正或数据已修订/);
  assert.equal((rendered.match(/带 caveats 属性的记忆/g) ?? []).length, 1, "how to read a label is said once");
  assert.equal(resting.id.length > 0, true);
  await assert.rejects(() => recallAcrossMemory({ capsules: null, memorySubstrate: substrate }, { id: owner }, { query: "x", asOf: "last spring" }),
    { status: 400, code: "memory_as_of_invalid" });
});
