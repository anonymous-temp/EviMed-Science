// An empirical synthesis that could not finish inside its CPU budget even at the cost model's best measured case is refused before
// it is queued, with what to change; one that fits is queued as it was; one the model cannot tell from finishing is queued with a
// notice. The cost model is measured (see vcrSynthesisLimits.mjs), so these tests derive their sizes from the model and from the
// budget instead of copying numbers out of it.
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
    assert.ok(vcrSynthpopEstimateSeconds({ rows: 2000, columns: 40, copies: 5 }) / VCR_SYNTHPOP_COST.worstOverPrediction > budget, "the model, not the test, says it could not finish");
    const refused = await vcrSynthesisIssue({ root, inputs: [wide], scenario: { m: 5 }, cpuSecondsLimit: 100 });
    assert.equal(refused?.code, "vcr_synthesis_too_large");
    assert.equal(refused?.refused, true);
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

/** A table size the model puts between "certain to finish" and "could not finish", for a budget: found on the model, never copied out of it. */
function inTheBand(cpuSecondsLimit) {
  const budget = vcrSynthpopBudgetSeconds(cpuSecondsLimit);
  for (let rows = 300; rows <= 3000; rows += 100) {
    for (let columns = 5; columns <= 80; columns += 1) {
      const seconds = vcrSynthpopEstimateSeconds({ rows, columns, copies: 5 });
      if (seconds * VCR_SYNTHPOP_COST.margin > budget && seconds / VCR_SYNTHPOP_COST.worstOverPrediction <= budget) return { rows, columns };
    }
  }
  throw new Error("no table in the band");
}

test("a table the model cannot tell from finishing is not refused: it comes back as a notice with what to reduce", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vcr-band-"));
  try {
    const { rows, columns } = inTheBand(100);
    const input = await table(root, "band.csv", rows, columns);
    const noticed = await vcrSynthesisIssue({ root, inputs: [input], scenario: { m: 5 }, cpuSecondsLimit: 100 });
    assert.equal(noticed?.refused, false);
    assert.equal(noticed?.code, "vcr_synthesis_may_not_finish");
    assert.match(noticed?.message ?? "", new RegExp(`${rows} 行 × ${columns} 列 × 5 份`));
    assert.match(noticed?.message ?? "", /可能在预算内完不成/);
    assert.match(noticed?.message ?? "", /已经排队/);
    assert.match(noticed?.message ?? "", /列数减到 \d+ 以内/);
    assert.match(noticed?.message ?? "", /预算是 \d+ 秒/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the queue stores a synthesis in the band and hands the notice back beside the job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vcr-band-queue-"));
  try {
    const { rows, columns } = inTheBand(100);
    const input = await table(root, "band.csv", rows, columns);
    /** @type {any[]} */
    const inserted = [];
    const client = { async query(/** @type {string} */ sql, /** @type {any[]} */ values) {
      if (/FROM evimed_vcr\.studies/.test(sql)) return { rows: [{ budget: {}, status: "active" }] };
      if (/INSERT INTO evimed_vcr\.jobs/.test(sql)) {
        inserted.push(values);
        return { rows: [{ id: values[0], study_id: values[1], kind: values[3], method: values[4], state: values[6], inserted: true, cpu_seconds_limit: values[12] }] };
      }
      return { rows: [{ used: 0, unknown: 0, in_flight: 0 }] };
    } };
    const store = { async populations() { return []; }, async audit() {}, async transaction(/** @type {Function} */ work) { return work(client); } };
    const dataPlane = { async resolveEngineInputs() { return [input]; } };
    const jobs = new VcrJobs({ store: /** @type {any} */ (store), config: { vcrDataPlaneDir: root, vcrJobCpuSeconds: 100 }, dataPlane });
    const queued = await jobs.enqueue({ studyId: "study_1", userId: "u1", kind: "synthesize_population", scenario: { m: 5, holdoutShare: 0.2 }, inputs: [{ kind: "snapshot", id: "snp_1" }] });
    assert.equal(inserted.length, 1, "it was stored");
    assert.equal(queued.job.state, "queued");
    assert.equal(queued.notice?.code, "vcr_synthesis_may_not_finish");
    assert.match(queued.notice?.message ?? "", /可能在预算内完不成/);
    // a table the budget holds comes back with no notice
    const small = await table(root, "small.csv", 30, 6);
    const calm = new VcrJobs({ store: /** @type {any} */ (store), config: { vcrDataPlaneDir: root, vcrJobCpuSeconds: 100 }, dataPlane: { async resolveEngineInputs() { return [small]; } } });
    const plain = await calm.enqueue({ studyId: "study_1", userId: "u1", kind: "synthesize_population", scenario: { m: 5, holdoutShare: 0.2 }, inputs: [{ kind: "snapshot", id: "snp_1" }] });
    assert.equal("notice" in plain, false);
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
