// The seams between the seven packages, which is where a parallel build
// breaks. Each package's own tests pass against its own idea of the other
// side; these assert the two sides actually fit — above all the suppression
// adapter, whose failure mode is a model receiving a wrapper object *and*
// losing the suppression the plan requires (AC-26).
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_MIN_CELL_SIZE, validateEngineResult } from "@evimed/domain";

import { suppressSmallCells } from "../src/vcrDataPlane.mjs";
import { composeVcr, vcrDataPlaneSeam, vcrMatchingExecutor, vcrMatchingSeam } from "../src/vcrComposition.mjs";

const AS_OF = "2026-09-28T00:00:00.000Z";

/** A data-plane double with only what the seam reads. */
function dataPlaneDouble({ root = "/data/vcr" } = {}) {
  return {
    root: () => root,
    async snapshotProfileForModel({ snapshotId }) {
      return { snapshotId, columns: [{ name: "AGE", type: "number", fill: 0.99 }], quality: { completeness: 0.99 } };
    },
  };
}

function dataStoreDouble() {
  return {
    async listSources() { return [{ id: "src_1", name: "合作方样例" }]; },
    async listSnapshots() {
      return [{ id: "snp_1", sourceId: "src_1", version: 1, sha256: "a".repeat(64), rowCount: 412, columnCount: 18,
        frozenAt: AS_OF, sealedFields: ["OS_EVENT"], sealedUntil: null, quality: { completeness: 0.98 } }];
    },
  };
}

const allowAll = { async judge() { return { allowed: true }; } };
const denyAll = { async judge() { return { allowed: false, code: "vcr_no_grant", reason: "没有这个数据源的授权。" }; } };

// ---------------------------------------------------------------------------
// The suppression seam (AC-26)
// ---------------------------------------------------------------------------

test("AC-26 the seam hands a model the aggregate, not the suppressor's wrapper", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const answer = seam.suppressSmallCells({ cells: [{ key: "A", n: 3 }, { key: "B", n: 4 }, { key: "C", n: 90 }] });
  assert.ok(Array.isArray(answer.cells), "the aggregate itself comes back — a wrapper here would be handed to the model");
  assert.equal(answer.aggregate, undefined, "the `{ aggregate, suppression }` wrapper must not survive the seam");
  const suppressed = answer.cells.filter((cell) => cell.suppressed);
  assert.ok(suppressed.length >= 2, "cells below the floor are withheld");
  assert.equal(answer.suppression.minCellSize, VCR_MIN_CELL_SIZE);
  assert.ok(answer.suppression.cellsSuppressed >= 2, "the reader is told what was withheld");
});

test("AC-26 an aggregate with nothing to withhold comes back unchanged and unannotated", () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const answer = seam.suppressSmallCells({ cells: [{ key: "A", n: 40 }, { key: "B", n: 90 }] });
  assert.equal(answer.suppression, undefined, "no note where nothing was withheld");
  assert.deepEqual(answer.cells.map((cell) => cell.n), [40, 90]);
});

test("the seam and the data plane agree on the floor", () => {
  const direct = suppressSmallCells({ cells: [{ key: "A", n: 9 }, { key: "B", n: 90 }] }, { minCellSize: VCR_MIN_CELL_SIZE });
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const through = seam.suppressSmallCells({ cells: [{ key: "A", n: 9 }, { key: "B", n: 90 }] });
  assert.equal(direct.suppression.cellsSuppressed, through.suppression.cellsSuppressed);
});

// ---------------------------------------------------------------------------
// The data-plane tab and note
// ---------------------------------------------------------------------------

test("AC-17 a caller the access judge refuses gets a named unavailable, never the rows", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: denyAll });
  const tab = await seam.tab({ id: "std_1", userId: "u1" }, { id: "u2" });
  assert.equal(tab.available, false);
  assert.equal(tab.unavailable.code, "vcr_no_grant");
  assert.equal(tab.sources, undefined);
});

test("a study at T0 is told the data plane is absent rather than shown an error", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: { root: () => "", async snapshotProfileForModel() { return {}; } },
    dataStore: dataStoreDouble(), access: allowAll });
  const note = await seam.note({ id: "std_1", dataTier: "T0" });
  assert.equal(note.available, false);
  assert.equal(note.code, "vcr_data_plane_unconfigured");
  assert.match(note.message, /T0/);
});

test("what a model may read of a snapshot is structure and quality, never a row", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const profile = await seam.runtimeProfile({ id: "std_1" }, { snapshotId: "snp_1" });
  assert.equal(profile.available, true);
  assert.ok(Array.isArray(profile.columns));
  assert.equal(JSON.stringify(profile).includes("rows"), false);
  const unnamed = await seam.runtimeProfile({ id: "std_1" }, {});
  assert.equal(unnamed.code, "vcr_snapshot_not_named");
});

// ---------------------------------------------------------------------------
// The matching seam and its local executor
// ---------------------------------------------------------------------------

const CRITERIA = [
  { id: "crt_age", kind: "inclusion", criterionType: "demographic",
    requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
  { id: "crt_mi", kind: "exclusion", criterionType: "time_window",
    requirement: { op: "absent", variable: "myocardial_infarction", window: { months: 6 } } },
];

function matchStoreDouble() {
  return {
    async listCriteria() { return CRITERIA; },
    async listAssessments() { return [{ id: "mas_1", subjectKey: "P-001", summary: "eligible", judgments: [] }]; },
    async listReferrals() { return [{ id: "ref_1", subjectKey: "P-001", state: "candidate" }]; },
    async listSites() { return [{ id: "ste_1", name: "中心 A", verifiedAt: AS_OF }]; },
    async screenFailureCounts() { return []; },
    async siteFunnel() { return []; },
  };
}
const storeDouble = { async latestProtocolVersion() { return { id: "prt_1", version: 1 }; } };

test("the matching tab is assembled from the package's store and its pure judgments", async () => {
  const seam = vcrMatchingSeam({ matchStore: matchStoreDouble(), store: storeDouble });
  const tab = await seam.tab({ id: "std_1", userId: "u1" }, { id: "u1" });
  assert.equal(tab.available, true);
  assert.equal(tab.criteria.length, 2);
  assert.equal(tab.protocol.id, "prt_1");
  assert.ok(tab.funnel, "the referral funnel is computed, not stored");
  assert.ok(Array.isArray(tab.sites));
  assert.ok(tab.assessments[0].counts, "an assessment carries its deterministic counts");
});

test("a run reads judgments and criteria, and nothing else the store holds", async () => {
  const seam = vcrMatchingSeam({ matchStore: matchStoreDouble(), store: storeDouble });
  assert.equal((await seam.runtimeRead({ id: "std_1" }, { what: "criteria" })).criteria.length, 2);
  assert.equal((await seam.runtimeRead({ id: "std_1" }, { what: "referrals" })).referrals.length, 1);
  assert.ok((await seam.runtimeRead({ id: "std_1" }, {})).assessments);
});

test("AC-14 the local executor decides in code and answers a valid engine result", async () => {
  const run = vcrMatchingExecutor({ matchStore: matchStoreDouble() });
  const progress = [];
  const result = await run({
    job: { id: "job_1", studyId: "std_1", scenarioHash: "b".repeat(64), seed: 7,
      scenario: { asOf: AS_OF, criteria: CRITERIA, subjects: [
        // Age known and adult; no MI evidence at all, so the exclusion is
        // `unknown` and the subject cannot read eligible (AC-14).
        { subjectKey: "P-001", facts: [{ variable: "age", value: 62, visibleAt: "2026-09-01T00:00:00.000Z" }] },
        // Nothing known at all.
        { subjectKey: "P-002", facts: [] },
      ] } },
    onProgress: async (value) => { progress.push(value); },
  });
  assert.deepEqual(validateEngineResult(result), [], "the control plane's own executor answers the engine's contract");
  assert.equal(result.status, "succeeded");
  assert.equal(result.counts.realPatients, 2);
  assert.equal(result.counts.generatedRecords, 0);
  assert.ok(progress.length >= 1, "progress is reported even for a short job");
  const summaries = result.assessments.map((row) => row.summary);
  assert.ok(!summaries.includes("eligible"), "an exclusion nobody has evidence for never reads as eligible");
  assert.equal(result.assessments[0].counts.total, 2);
  assert.equal(result.manifest.engineVersion, "control-plane");
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test("the module is absent — not broken — where it is off or has no database", () => {
  assert.equal(composeVcr({ config: { vcrEnabled: false }, productDatabase: {} }), null);
  assert.equal(composeVcr({ config: { vcrEnabled: true }, productDatabase: null }), null);
});

test("composed, every package is present and the optional ones are honestly null", () => {
  const database = { async transaction(run) { return run({ async query() { return { rows: [] }; } }); }, async query() { return { rows: [] }; } };
  const vcr = composeVcr({ config: { vcrEnabled: true, vcrEngineUrl: "", vcrDataPlaneDir: "" }, productDatabase: database });
  assert.ok(vcr.store && vcr.service && vcr.jobs && vcr.access && vcr.members && vcr.evidence && vcr.matching);
  assert.equal(vcr.engine, null, "no engine URL means no engine, and the steps that need it say so");
  assert.equal(vcr.dataPlane, null, "no data-plane directory means no data plane");
  assert.equal(vcr.dataPlaneSeam, null);
  assert.equal(vcr.orchestrator, null, "the orchestrator and worker are composed beside the other modules'");
  assert.ok(vcr.jobs.localExecutors["matching.evaluate"], "the one method that runs in the control plane is registered");
});
