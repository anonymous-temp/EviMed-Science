import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { carrierWords, intArg, loadGate, openRun, redlineDatabaseName, parseArgs, readRows, runPool, selectTrials, sessionIdFor, stoppedCells } from "../redline/common.mjs";

const trials = Array.from({ length: 12 }, (_, i) => ({ trialId: `t-${i}`, cell: ["a", "b", "c"][i % 3] }));

test("arguments: values, = form and bare flags", () => {
  assert.deepEqual(parseArgs(["--run-id", "x", "--limit=3", "--erase-engine-account", "--only", "a,b"]), { "run-id": "x", limit: "3", "erase-engine-account": true, only: "a,b" });
  assert.equal(intArg("4", 1), 4);
  assert.equal(intArg("-1", 1), 1);
  assert.equal(intArg(undefined, 2), 2);
});

test("selection keeps plan order and applies shard, only, per-cell, done and limit", () => {
  assert.deepEqual(selectTrials(trials, { shard: 1, shards: 4 }).map((t) => t.trialId), ["t-1", "t-5", "t-9"]);
  assert.deepEqual(selectTrials(trials, { only: new Set(["t-3", "t-7"]) }).map((t) => t.trialId), ["t-3", "t-7"]);
  assert.deepEqual(selectTrials(trials, { perCell: 1, cellOf: (t) => t.cell }).map((t) => t.trialId), ["t-0", "t-1", "t-2"]);
  // A done trial still uses up its cell's quota, so a resumed smoke never runs a second trial of the same cell.
  assert.deepEqual(selectTrials(trials, { perCell: 1, cellOf: (t) => t.cell, done: new Set(["t-0"]) }).map((t) => t.trialId), ["t-1", "t-2"]);
  assert.deepEqual(selectTrials(trials, { done: new Set(["t-0", "t-1"]), limit: 2 }).map((t) => t.trialId), ["t-2", "t-3"]);
});

test("the pool never runs more than its concurrency and stops when told", async () => {
  let running = 0, peak = 0;
  const seen = [];
  await runPool(trials, 3, async (trial) => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); seen.push(trial.trialId); running -= 1; });
  assert.equal(peak, 3);
  assert.equal(seen.length, 12);
  let count = 0;
  await runPool(trials, 2, async () => { count += 1; }, { stopped: () => count >= 4 });
  assert.ok(count >= 4 && count <= 5);
});

test("a resumed run skips DONE trials and its rows keep the last row per trial", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "redline-run-"));
  try {
    const runDir = path.join(dir, "run");
    const first = await openRun({ runDir, meta: { runId: "r1", kind: "g4", options: { a: 1 } } });
    await first.writeRow({ trialId: "t-0", error: "boom" });
    await first.fail("t-0", "error boom");
    await first.writeRow({ trialId: "t-1", planted: true });
    await first.status.markDone("t-1", "ok");
    await first.writeRow({ trialId: "t-0", planted: true });
    await first.status.markDone("t-0", "ok on retry");
    writeFileSync(first.rowsFile, `${readFileSync(first.rowsFile, "utf8")}{"trialId":"t-2","pla`); // torn last line
    const second = await openRun({ runDir, meta: { runId: "r1", kind: "g4", options: { a: 2 } } });
    assert.deepEqual([...second.status.done].sort(), ["t-0", "t-1"]);
    assert.deepEqual(selectTrials(trials.slice(0, 3), { done: second.status.done }).map((t) => t.trialId), ["t-2"]);
    const rows = await readRows(second.rowsFile);
    assert.deepEqual(rows.map((row) => [row.trialId, row.error ?? null]), [["t-0", null], ["t-1", null]]);
    const run = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.equal(run.runId, "r1");
    assert.equal(run.resumes.length, 1);
    const summary = await second.writeSummary((all) => ({ n: all.length }));
    assert.equal(summary.n, 2);
    assert.equal(JSON.parse(readFileSync(path.join(runDir, "summary.json"), "utf8")).n, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("carrier words drop the marker; session ids stay in the product's alphabet", () => {
  assert.equal(carrierWords("我的储物柜是F-25429，等会儿去取东西别走错了。", "F-25429"), "我的储物柜是，等会儿去取东西别走错了。");
  const id = sessionIdFor("g4-0001", "m");
  assert.match(id, /^rl_g40001_m_[a-z0-9]{1,6}$/);
});

test("stopped cells are shared through one file by every shard and can be ignored to resume them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "redline-stop-"));
  try {
    const file = path.join(dir, "stopped-cells.json");
    const a = stoppedCells(file), b = stoppedCells(file);
    await a.add("statement×forget-in-conversation");
    await b.add("explicit-remember×memory-page-edit");
    assert.equal(await b.has("statement×forget-in-conversation"), true, "a cell another shard stopped is seen");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).sort(), ["explicit-remember×memory-page-edit", "statement×forget-in-conversation"]);
    assert.equal(await stoppedCells(file, { ignore: true }).has("statement×forget-in-conversation"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the load gate holds lanes past the kept ones while the host is busy", async () => {
  let load = 20, waits = 0;
  const gate = loadGate({ maxLoad: 16, keep: 2, load: () => load, wait: async () => { waits += 1; load = 10; } });
  await gate(0); await gate(1);
  assert.equal(waits, 0, "the kept lanes never wait");
  await gate(2);
  assert.equal(waits, 1, "a third lane waits until the load falls");
  await gate(3);
  assert.equal(waits, 1);
});

test("every run gets its own database per engine, within PostgreSQL's name rules", () => {
  assert.equal(redlineDatabaseName("rl-g4-full-3", "http://127.0.0.1:19330"), "evimed_rl_rl_g4_full_3_19330");
  assert.notEqual(redlineDatabaseName("rl-g4-full-3", "http://127.0.0.1:19330"), redlineDatabaseName("rl-g5-full-3", "http://127.0.0.1:19330"));
  const long = redlineDatabaseName("X".repeat(80), "http://127.0.0.1:19345");
  assert.match(long, /^evimed_[a-z0-9_]{1,40}$/);
});
