import assert from "node:assert/strict";
import test from "node:test";
import {
  AFFECTED_LIST_LIMIT, METHOD_SOURCE_CHANGE_LIMIT, SOURCE_CHANGE_LINK_STATES, SOURCE_REPLACED_KIND, affectedClass, affectedCounts,
  foldSourceChange, linkReasonOf, linkStateOf, linkStatesLeftFor, methodSourceChanges, projectAffected,
} from "../index.mjs";

const VERSION = `rv_${"a".repeat(64)}`;
/** @param {...string} kinds */
const changed = (...kinds) => ({ state: "changed", updates: kinds.map(kind => ({ kind, noticeDoi: null, date: null, source: null })) });

test("a check moves a link to the state it found, and a check that could not answer is never clean", () => {
  assert.equal(linkStateOf(changed("correction")), "changed");
  assert.equal(linkStateOf(changed("expression_of_concern")), "changed");
  assert.equal(linkStateOf(changed(SOURCE_REPLACED_KIND)), "changed");
  assert.equal(linkStateOf(changed("correction", "retraction")), "retracted");
  assert.equal(linkStateOf(changed("partial_retraction")), "retracted");
  assert.equal(linkStateOf({ state: "no_update", updates: [] }), "current");
  for (const status of [{ state: "unknown" }, { state: "unavailable", reason: "timeout" }, { state: "something_new" }, null, undefined]) {
    assert.equal(linkStateOf(status), "unknown");
  }
  for (const state of ["current", "changed", "retracted", "unknown"]) assert.ok(SOURCE_CHANGE_LINK_STATES.includes(state));
});

test("a check lowers nothing: a retraction outranks a correction and an unanswered check never undoes either", () => {
  assert.deepEqual(linkStatesLeftFor("unknown"), ["current"], "only a link nobody had found a change on");
  assert.ok(!linkStatesLeftFor("changed").includes("retracted"));
  assert.ok(linkStatesLeftFor("retracted").includes("changed"));
  assert.ok(!linkStatesLeftFor("retracted").includes("retracted"));
  assert.deepEqual(linkStatesLeftFor("current"), ["unknown"], "a clean answer sets right an unanswered check and nothing else");
  assert.deepEqual(linkStatesLeftFor("falsified"), []);
});

test("the label's reason is the kind of notice or the reason the check could not answer", () => {
  assert.equal(linkReasonOf(changed("correction", "retraction")), "retraction");
  assert.equal(linkReasonOf(changed(SOURCE_REPLACED_KIND)), "replaced");
  assert.equal(linkReasonOf({ state: "unavailable", reason: "timeout" }), "check_timeout");
  assert.equal(linkReasonOf({ state: "unknown", reason: "Not In Crossref!" }), "check_unavailable", "a reason that is not a code is not carried");
  assert.equal(linkReasonOf({ state: "no_update" }), "no_update");
});

test("what depends on a source is a closed, bounded record and an absent one is unknown, not empty", () => {
  assert.equal(projectAffected(undefined), null);
  assert.equal(projectAffected({ schemaVersion: 2 }), null);
  const many = Array.from({ length: AFFECTED_LIST_LIMIT + 5 }, (_, index) => ({ recordId: `m${index}`, scope: "project", kind: "fact", state: "changed", key: "never copied" }));
  const record = /** @type {any} */ (projectAffected({ schemaVersion: 1, via: "calculation",
    calculations: { status: "found", items: [{ versionId: VERSION, path: "results/pool.json", boundValues: 3, keys: ["a", "b"], secret: "dropped" }] },
    dependents: { status: "none", items: [] },
    memories: { status: "found", total: 40, items: many },
    methods: { status: "unknown", reason: "lookup_failed", items: [{ id: "should not be read" }] } }));
  assert.equal(record.via, "calculation");
  assert.deepEqual(record.calculations.items, [{ versionId: VERSION, path: "results/pool.json", boundValues: 3, keys: ["a", "b"] }]);
  assert.equal(record.memories.items.length, AFFECTED_LIST_LIMIT);
  assert.equal(record.memories.total, 40, "the total survives the cut");
  assert.ok(!("key" in record.memories.items[0]));
  assert.deepEqual(record.methods, { status: "unknown", reason: "lookup_failed", total: 0, items: [] });
  assert.equal(record.dependents.status, "none");
  const bare = /** @type {any} */ (projectAffected({ schemaVersion: 1 }));
  assert.equal(bare.memories.status, "unknown");
  assert.equal(bare.memories.reason, "not_recorded");
});

test("a class built from lookups says found, none or unknown and keeps an unmade lookup out of the counts", () => {
  assert.equal(affectedClass({ items: [] }, "memories").status, "none");
  assert.equal(affectedClass({ unknown: "lookup_failed" }, "methods").status, "unknown");
  const found = affectedClass({ items: [{ recordId: "m1", scope: "user", kind: "fact", state: "changed" }] }, "memories");
  assert.equal(found.status, "found");
  const affected = projectAffected({ schemaVersion: 1, via: "input", calculations: { status: "unknown", reason: "lookup_failed" },
    dependents: { status: "none" }, memories: found, methods: { status: "unknown", reason: "lookup_failed" } });
  const counts = affectedCounts(affected);
  assert.deepEqual(counts.unknown, ["calculations", "methods"], "a lookup that was not made is not a count of zero");
  assert.deepEqual(affectedCounts(null).unknown, ["calculations", "dependents", "memories", "methods"]);
  assert.equal(counts.found.memories, 1);
});

test("a method keeps the changes of sources it rests on once each, bounded, and only as a label", () => {
  /** @param {number} n @param {Record<string, any>} [over] */
  const entry = (n, over = {}) => ({ id: `sc_${String(n).padStart(32, "0")}`, source: { id: "10.1000/x", doi: "10.1000/x" }, state: "changed",
    reason: "correction", versionId: VERSION, relation: "learnt_from", at: "2026-10-04T00:00:00Z", ...over });
  const one = foldSourceChange(undefined, entry(1));
  assert.equal(one.length, 1);
  assert.equal(foldSourceChange(one, entry(1)), one, "the same change is not added twice, and the caller can tell");
  assert.equal(foldSourceChange(one, entry(2, { state: "current" })), one, "a state that is not a change is not a label");
  assert.equal(foldSourceChange(one, entry(3, { versionId: "rv_not_one" })), one);
  assert.equal(foldSourceChange(one, entry(4, { id: "x" })), one);
  /** @type {any[]} */
  let list = [];
  for (let n = 1; n <= METHOD_SOURCE_CHANGE_LIMIT + 3; n += 1) list = foldSourceChange(list, entry(n));
  assert.equal(list.length, METHOD_SOURCE_CHANGE_LIMIT);
  assert.equal(list[0].id, entry(4).id, "the oldest go first");
  assert.deepEqual(methodSourceChanges([...list, { junk: true }]).map(item => item.id), list.map(item => item.id));
  assert.equal(foldSourceChange(undefined, entry(5, { state: "retracted", relation: "unheard" }))[0].relation, "used_for");
});
