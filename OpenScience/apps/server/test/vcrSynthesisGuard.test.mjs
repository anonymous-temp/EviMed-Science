// An empirical synthesis that cannot finish inside its CPU budget is refused before it is queued, with what to change; one that
// can is queued as it was. The cost model is measured (see vcrSynthesisLimits.mjs), so these tests derive their sizes from the model
// and from the budget instead of copying numbers out of it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VCR_SYNTHPOP_COST, vcrSynthpopBudgetSeconds, vcrSynthpopEstimateSeconds } from "@evimed/domain";

import { VcrJobs } from "../src/vcrJobs.mjs";
import { vcrSynthesisIssue, vcrTableShape } from "../src/vcrSynthesisGuard.mjs";


/** A CSV with `rows` records of `columns` learned columns and a USUBJID key; written once, the guard only counts. */
async function table(root, name, rows, columns) {
  const header = ["USUBJID", ...Array.from({ length: columns }, (_, index) => `v${index + 1}`)];
  const lines = [header.join(",")];
  for (let row = 0; row < rows; row += 1) lines.push([`P${row}`, ...header.slice(1).map(() => "1")].join(","));
  await mkdir(path.join(root, "snapshots", "snp_1"), { recursive: true });
  await writeFile(path.join(root, "snapshots", "snp_1", name), `${lines.join("\n")}\n`);
  return { kind: "analysis_table", id: "snp_1:subject", shape: "subject", location: `snapshots/snp_1/${name}`, hash: "a".repeat(64), valueSource: "observed" };
}

test("the shape of a table is its records and the columns it learns from, counted by reading it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vcr-shape-"));
  try {
    const input = await table(root, "subject.csv", 12, 7);
    assert.deepEqual(await vcrTableShape(path.join(root, input.location)), { rows: 12, columns: 7 }, "the subject key is not a variable of the synthesis");
    await writeFile(path.join(root, "quoted.csv"), 'USUBJID,note\nP1,"a, b\nsecond line"\nP2,plain\n');
    assert.deepEqual(await vcrTableShape(path.join(root, "quoted.csv")), { rows: 2, columns: 1 }, "a quoted comma and newline are one cell");
    assert.equal(await vcrTableShape(path.join(root, "missing.csv")), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a table that fits its budget is not refused, and one that does not is, with the three things to change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vcr-guard-"));
  try {
    const small = await table(root, "small.csv", 30, 12);
    assert.equal(await vcrSynthesisIssue({ root, inputs: [small], scenario: { m: 5 }, cpuSecondsLimit: 600 }), null);
    // the same kind of table, wider and longer, against a budget the model says it cannot meet
    const wide = await table(root, "wide.csv", 2000, 40);
    const budget = vcrSynthpopBudgetSeconds(100);
    assert.ok(vcrSynthpopEstimateSeconds({ rows: 2000, columns: 40, copies: 5 }) * VCR_SYNTHPOP_COST.margin > budget, "the model, not the test, says it does not fit");
    const refused = await vcrSynthesisIssue({ root, inputs: [wide], scenario: { m: 5 }, cpuSecondsLimit: 100 });
    assert.equal(refused?.code, "vcr_synthesis_too_large");
    assert.match(refused?.message ?? "", /2000 行 × 40 列 × 5 份/, "names the table it measured");
    assert.match(refused?.message ?? "", /没有排队，也没有替你抽样或删列/, "says nothing was queued and nothing was dropped on the caller's behalf");
    assert.match(refused?.message ?? "", /列数减到 \d+ 以内/, "names what to reduce");
    assert.match(refused?.message ?? "", /行数减到 \d+ 以内/);
    // the same table with the budget it needs is queued as it was
    assert.equal(await vcrSynthesisIssue({ root, inputs: [wide], scenario: { m: 5 }, cpuSecondsLimit: 600 }), null);
    // a subject table is read in preference to a raw file, as the engine reads it
    const raw = { kind: "snapshot_file", id: "snp_1:1", location: wide.location, hash: "b".repeat(64), valueSource: "observed" };
    assert.equal((await vcrSynthesisIssue({ root, inputs: [raw, { ...small, location: small.location }], scenario: {}, cpuSecondsLimit: 100 })), null, "the subject table decides, not the first file");
    // no data plane, or a table nobody can read: left to the engine's own budget
    assert.equal(await vcrSynthesisIssue({ root: null, inputs: [wide], scenario: { m: 5 }, cpuSecondsLimit: 100 }), null);
    assert.equal(await vcrSynthesisIssue({ root, inputs: [{ ...wide, location: "snapshots/snp_1/gone.csv" }], scenario: {}, cpuSecondsLimit: 100 }), null);
    assert.equal(await vcrSynthesisIssue({ root, inputs: [{ ...wide, location: "../../etc/passwd" }], scenario: {}, cpuSecondsLimit: 100 }), null, "a location outside the root is not read");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the queue refuses a synthesis it cannot finish before anything is stored, and names the budget the platform allows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vcr-queue-"));
  try {
    const input = await table(root, "subject.csv", 400, 10);
    const dataPlane = { async resolveEngineInputs() { return [input]; } };
    const jobs = new VcrJobs({ store: { async populations() { return []; } }, config: { vcrDataPlaneDir: root, vcrJobCpuSeconds: 10 }, dataPlane });
    // 10 seconds is the queue's floor for a job's limit; fifty copies of 400 rows × 10 columns do not fit it
    await assert.rejects(
      jobs.enqueue({ studyId: "study_1", userId: "u1", kind: "synthesize_population", scenario: { m: 50, holdoutShare: 0.2 }, inputs: [{ kind: "snapshot", id: "snp_1" }] }),
      (error) => error.status === 400 && error.code === "vcr_synthesis_too_large" && /预算是 \d+ 秒/.test(error.message),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
