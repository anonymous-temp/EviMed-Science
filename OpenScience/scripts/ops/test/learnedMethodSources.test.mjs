import assert from "node:assert/strict";
import test from "node:test";

import { EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON } from "@evimed/domain";

import { SOURCE_KINDS, learnedMethodSources, parseArguments, sourceKind } from "../learned-method-sources.mjs";

/** A method ledger that answers what the report asks of it: the methods, and the lessons each was learnt from. */
function fakeLearning(methods) {
  return {
    pages: 0,
    async listMethods(_userId, { cursor } = {}) {
      this.pages += 1;
      // Two pages, to prove the report follows the cursor.
      return cursor ? { items: methods.slice(2), nextCursor: null } : { items: methods.slice(0, 2), nextCursor: "next" };
    },
    async sourceLessons(_userId, id) { return methods.find((method) => method.id === id).lessons; },
  };
}
const method = (id, lessons, payload = {}) => ({ id, payload: { status: "approved", ...payload }, lessons });
const ledger = (runs) => async (_userId, projectId, runId) => runs[`${projectId}/${runId}`] ?? null;

test("the arguments name an account, and may ask for the flagged methods only", () => {
  assert.deepEqual(parseArguments(["--user", "u1"]), { user: "u1", onlyFlagged: false });
  assert.deepEqual(parseArguments(["--user", "u1", "--only-flagged"]), { user: "u1", onlyFlagged: true });
  assert.throws(() => parseArguments([]), /--user/);
  assert.throws(() => parseArguments(["--user", "u1", "--apply"]), /unknown argument/);
});

test("a source run is told apart by the route reason the control plane wrote and the trigger that queued the lesson", () => {
  assert.equal(sourceKind(null, "delivered"), "unresolved");
  assert.equal(sourceKind({ effectiveRouteReason: "autopilot-verify" }, "delivered"), "verification");
  assert.equal(sourceKind({ effectiveRouteReason: EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON }, null), "verification");
  assert.equal(sourceKind({ effectiveRouteReason: "unrouted:open-domain" }, "repair_accepted"), "gate-repair");
  assert.equal(sourceKind({ effectiveRouteReason: "unrouted:open-domain", repairRounds: { content: 1, structural: 0 } }, "delivered"), "gate-repair");
  assert.equal(sourceKind({ effectiveRouteReason: "autopilot:literature-sentinel" }, "delivered"), "other");
  assert.equal(sourceKind({ effectiveRouteReason: "unrouted:open-domain" }, "correction"), "other");
  assert.deepEqual([...SOURCE_KINDS], ["verification", "gate-repair", "unresolved", "other"]);
});

test("each method lists its source runs by id with their kinds and counts, and says which were learnt only from the platform's own work", async () => {
  const learning = fakeLearning([
    method("clean", [{ projectId: "p1", runId: "r1", trigger: "correction" }]),
    method("checked", [{ projectId: "p1", runId: "v1", trigger: "delivered" }, { projectId: "p1", runId: "v2", trigger: "delivered" }]),
    method("mixed", [{ projectId: "p1", runId: "v3", trigger: "delivered" }, { projectId: "p1", runId: "r2", trigger: "repair_accepted" }, { projectId: "p1", runId: "r3", trigger: "correction" }]),
    method("gone", [{ projectId: "deleted", runId: "r9", trigger: null }]),
    method("merge", [], { provenance: { consolidatedBy: "consolidate:job_1" } }),
  ]);
  const resolveRun = ledger({
    "p1/r1": { id: "r1", effectiveRouteReason: "unrouted:open-domain" },
    "p1/v1": { id: "v1", effectiveRouteReason: "autopilot-verify" },
    "p1/v2": { id: "v2", effectiveRouteReason: "autopilot-verify:evidence" },
    "p1/v3": { id: "v3", effectiveRouteReason: "autopilot-verify" },
    "p1/r2": { id: "r2", effectiveRouteReason: "unrouted:open-domain" },
    "p1/r3": { id: "r3", effectiveRouteReason: "choice:literature-search" },
  });
  const report = await learnedMethodSources({ learning, resolveRun, userId: "u1" });
  assert.equal(learning.pages, 2);
  assert.deepEqual([report.methods, report.withSources, report.flagged, report.onlyFlagged], [5, 4, 2, 1]);
  assert.deepEqual(report.sourceRuns, { verification: 3, "gate-repair": 1, unresolved: 1, other: 2 });
  const by = Object.fromEntries(report.items.map((item) => [item.methodId, item]));
  assert.deepEqual(by.checked.counts, { verification: 2, "gate-repair": 0, unresolved: 0, other: 0 });
  assert.equal(by.checked.onlyFlagged, true);
  assert.deepEqual([by.mixed.flagged, by.mixed.onlyFlagged], [true, false]);
  assert.deepEqual(by.mixed.sources.map((source) => [source.runId, source.kind, source.trigger, source.routeReason]), [
    ["v3", "verification", "delivered", "autopilot-verify"],
    ["r2", "gate-repair", "repair_accepted", "unrouted:open-domain"],
    ["r3", "other", "correction", "choice:literature-search"],
  ]);
  assert.deepEqual([by.gone.sources[0].kind, by.gone.flagged], ["unresolved", false]);
  assert.deepEqual([by.merge.consolidated, by.merge.sources], [true, []]);
  // Ids, reasons, triggers and counts only: nothing of a method's text, title or question is in the report.
  assert.doesNotMatch(JSON.stringify(report), /title|question|body|summary/);

  const flagged = await learnedMethodSources({ learning, resolveRun, userId: "u1", onlyFlagged: true });
  assert.deepEqual(flagged.items.map((item) => item.methodId), ["checked", "mixed"]);
  assert.equal(flagged.methods, 5, "the account's totals are the same; only the list is cut");
});

test("a run that cannot be read is unresolved, not an error", async () => {
  const learning = fakeLearning([method("a", [{ projectId: "p1", runId: "r1", trigger: "delivered" }]), method("b", []), method("c", [])]);
  const report = await learnedMethodSources({ learning, resolveRun: async () => { throw new Error("ledger unreadable"); }, userId: "u1" });
  assert.equal(report.sourceRuns.unresolved, 1);
});
