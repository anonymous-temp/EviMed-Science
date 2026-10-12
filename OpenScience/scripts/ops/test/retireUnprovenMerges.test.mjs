import assert from "node:assert/strict";
import test from "node:test";

import { RETIRE_REASON, parseArguments, retireUnprovenMerges } from "../retire-unproven-merges.mjs";
import { unprovenMerge } from "../../../apps/server/src/methodConsolidation.mjs";

const method = (id, provenance, status = "approved") => ({ id, revision: 3,
  payload: { recordType: "learned-method", status, provenance, contentDigest: `sha256:${id}`, display: { title: `标题 ${id}` }, learning: { digest: `sha256:${id}`, observations: [] } } });

function fakeLearning(items) {
  return {
    items, calls: /** @type {any[]} */ ([]),
    async listMethods() { return { items: this.items }; },
    async retire(user, id, input) { this.calls.push(["retire", id, input]); const item = this.items.find((entry) => entry.id === id); item.payload = { ...item.payload, status: "retired", statusReason: input.reason }; return item; },
    async rollback(user, id, input) { this.calls.push(["rollback", id, input]); const item = this.items.find((entry) => entry.id === id); item.payload = { ...item.payload, status: "approved", statusReason: null }; return item; },
  };
}

test("the arguments name an account and at most one of apply and restore", () => {
  assert.deepEqual(parseArguments(["--user", "u1"]), { user: "u1", apply: false, restore: false });
  assert.throws(() => parseArguments([]), /--user/);
  assert.throws(() => parseArguments(["--user", "u1", "--apply", "--restore"]), /two runs/);
});

test("only unused merges are put away, a report changes nothing, and a restore puts back exactly what was put away", async () => {
  const learning = fakeLearning([
    method("taught", { origin: "inferred", runId: "run_1" }),
    method("amended", { origin: "inferred", runId: "run_2", consolidatedBy: "consolidate:job_1" }),
    method("merge-a", { origin: "inferred", consolidatedBy: "consolidate:job_1", pendingRetirements: [] }),
    method("merge-b", { origin: "inferred", consolidatedBy: "consolidate:job_2", pendingRetirements: [] }),
    method("retired-by-hand", { origin: "inferred", consolidatedBy: "consolidate:job_0" }, "retired"),
  ]);
  const report = await retireUnprovenMerges(learning, unprovenMerge, { user: "u1", apply: false, restore: false });
  assert.deepEqual([report.retired, report.kept, report.items.map((item) => item.id)], [2, 2, ["merge-a", "merge-b"]]);
  assert.equal(learning.calls.length, 0, "a report writes nothing");

  const applied = await retireUnprovenMerges(learning, unprovenMerge, { user: "u1", apply: true, restore: false });
  assert.equal(applied.retired, 2);
  assert.deepEqual(learning.calls.map(([action, id, input]) => [action, id, input.reason, input.expectedRevision]),
    [["retire", "merge-a", RETIRE_REASON, 3], ["retire", "merge-b", RETIRE_REASON, 3]]);

  learning.calls.length = 0;
  const restored = await retireUnprovenMerges(learning, unprovenMerge, { user: "u1", apply: false, restore: true });
  assert.deepEqual(restored.items.map((item) => item.id), ["merge-a", "merge-b"], "a method retired for another reason stays retired");
  assert.deepEqual(learning.items.filter((item) => item.payload.status === "approved").map((item) => item.id), ["taught", "amended", "merge-a", "merge-b"]);
});
