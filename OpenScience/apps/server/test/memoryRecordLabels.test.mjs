// What the memory page labels a stored record with (`recordLabels`): the
// interval it holds over, the open disagreements it is a side of and the
// sources it rests on that are no longer as they were. The same vocabulary
// recall serves, read for the page — so these cases are the page's, and the
// recall cases stay in `memoryValidity.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";

import { recordLabels } from "../src/memoryValidity.mjs";

const NOW = Date.parse("2026-10-04T00:00:00Z");

function record(overrides = {}) {
  return {
    id: "r1", scope: "project", scopeId: "prj_a", kind: "project_fact", key: "project.dose", value: "20 mg qd",
    summary: "20 mg qd", origin: "explicit", status: "active", sensitive: false, evidenceCount: 1,
    createdAt: "2026-01-01T00:00:00Z", validFrom: null, invalidSince: null, supersededBy: null, ...overrides,
  };
}

function other(overrides = {}) {
  return {
    id: "r2", scope: "project", scopeId: "prj_a", kind: "project_fact", key: "project.dose2", status: "active", origin: "inferred",
    sensitive: false, summary: "15 mg qd", value: "15 mg qd", ...overrides,
  };
}

const conflictWith = (peer, state = "open") => new Map([["r1", [{ otherId: peer.id, state, createdAt: "2026-09-01T00:00:00Z", other: peer }]]]);

test("a record with nothing to say has an empty interval and no label", () => {
  assert.deepEqual(recordLabels(record(), {}, { now: NOW }), {
    validity: { from: null, until: null }, caveats: [], conflicts: [], sources: [],
  });
});

test("an open disagreement is a label with the other statement's text, and a settled or forgotten one is not", () => {
  const open = recordLabels(record(), { conflicts: conflictWith(other()) }, { now: NOW });
  assert.deepEqual(open.caveats, ["conflict"]);
  assert.deepEqual(open.conflicts, [{
    id: "r2", status: "active", scope: "project", scopeId: "prj_a", origin: "inferred", sensitive: false,
    text: "15 mg qd", createdAt: "2026-09-01T00:00:00Z",
  }]);
  assert.deepEqual(recordLabels(record(), { conflicts: conflictWith(other(), "resolved") }, { now: NOW }).caveats, []);
  assert.deepEqual(recordLabels(record(), { conflicts: conflictWith(other({ status: "archived" })) }, { now: NOW }).conflicts, [],
    "a statement the researcher forgot is no longer one side of anything");
  assert.deepEqual(recordLabels(record({ status: "superseded" }), { conflicts: conflictWith(other()) }, { now: NOW }).conflicts, [],
    "a replaced statement is history, not a party");
});

test("a sensitive statement is named and never handed over as text", () => {
  const [side] = recordLabels(record(), { conflicts: conflictWith(other({ sensitive: true, summary: "HIV positive" })) }, { now: NOW }).conflicts;
  assert.equal(side.sensitive, true);
  assert.equal(side.text, "");
  assert.equal(side.id, "r2");
});

test("only a source that is no longer as it was is a label; an unanswered check is neither a finding nor clean", () => {
  const sources = new Map([["r1", [
    { type: "doi", id: "10.1/a", state: "retracted" },
    { type: "doi", id: "10.1/b", state: "changed" },
    { type: "doi", id: "10.1/c", state: "expired" },
    { type: "doi", id: "10.1/d", state: "current" },
    { type: "doi", id: "10.1/e", state: "unknown" },
  ]]]);
  const found = recordLabels(record(), { sources }, { now: NOW });
  assert.deepEqual(found.caveats, ["source_retracted", "source_expired", "source_changed"], "most serious first, as recall orders them");
  assert.deepEqual(found.sources.map((source) => source.id), ["10.1/a", "10.1/b", "10.1/c"]);
  assert.deepEqual(recordLabels(record({ status: "archived" }), { sources }, { now: NOW }).caveats, [], "a forgotten memory is not labelled");
});

test("not yet valid is a record in force whose stated start has not come; an unstated start is not one", () => {
  assert.deepEqual(recordLabels(record({ validFrom: "2026-12-01T00:00:00Z" }), {}, { now: NOW }).caveats, ["not_yet_valid"]);
  assert.deepEqual(recordLabels(record({ validFrom: "2026-01-01T00:00:00Z" }), {}, { now: NOW }).caveats, []);
  assert.deepEqual(recordLabels(record({ validFrom: null, createdAt: "2026-12-01T00:00:00Z" }), {}, { now: NOW }).caveats, [],
    "the recording clock never makes a memory not yet valid");
  assert.deepEqual(recordLabels(record({ status: "pending", validFrom: "2026-12-01T00:00:00Z" }), {}, { now: NOW }).caveats, [],
    "a memory waiting for confirmation is not in force, so it has not 'not begun'");
});

test("a replaced record says when it held and nothing else", () => {
  const found = recordLabels(record({ status: "superseded", supersededBy: "r9", validFrom: "2026-03-02T00:00:00Z", invalidSince: "2026-09-01T00:00:00Z" }), {}, { now: NOW });
  assert.deepEqual(found.validity, { from: "2026-03-02T00:00:00Z", until: "2026-09-01T00:00:00Z" });
  assert.deepEqual(found.caveats, []);
});
