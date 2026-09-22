// The frontier worker's loops against stubs: which loop runs when, that no loop
// overlaps itself, that maintenance stops them, that processing waits for its
// owner, and the owner's project being made when missing.
import assert from "node:assert/strict";
import test from "node:test";
import { FrontierWorker, ensureFrontierProject } from "../src/frontierWorker.mjs";
import { HttpError } from "../src/security.mjs";

/** A clock the test moves. */
function clock(start = Date.parse("2026-09-22T04:00:00Z")) {
  let at = start;
  return { now: () => new Date(at), advance: (ms) => { at += ms; } };
}

function stubs() {
  const calls = [];
  const ingest = {
    plugin: { configured: true },
    async mirrorManifest() { calls.push("manifest"); },
    async mirrorSources() { calls.push("sources"); return { mirrored: 1 }; },
    async pull() { calls.push("pull"); return { inserted: 0 }; },
  };
  const pipeline = {
    batches: 0,
    async processBatch() { calls.push("process"); this.batches += 1; return { claimed: 3, promoted: 1, published: 1, merged: 1, screenedOut: 1, held: 0, failed: 0 }; },
  };
  const database = { statements: [], async query(text) { this.statements.push(String(text)); return { rowCount: 2, rows: [] }; } };
  return { calls, ingest, pipeline, database };
}

test("a tick starts every due loop; the periodic ones wait for their interval", async () => {
  const { calls, ingest, pipeline, database } = stubs();
  const time = clock();
  let owners = 0;
  const worker = new FrontierWorker({ ingest, pipeline, database, now: time.now, pollMs: 5_000, pluginPollMs: 60_000, concurrency: 2,
    ensureOwner: async () => { owners += 1; return { userId: "ops", projectId: "evimed-frontier" }; } });
  await worker.tick();
  assert.deepEqual(calls.filter((call) => call !== "process").sort(), ["manifest", "pull", "sources"]);
  assert.equal(owners, 1);
  assert.equal(pipeline.batches, 0, "the first tick made the owner; processing starts on the next");
  assert.equal(database.statements.length, 3, "the retention pass runs at start, one statement per table");

  calls.length = 0;
  time.advance(5_000);
  await worker.tick();
  assert.deepEqual(calls, ["process", "process"], "two batches side by side, nothing periodic yet");
  assert.deepEqual(worker.status().pipeline, { batches: 2, claimed: 6, promoted: 2, published: 2, merged: 2, screenedOut: 2, held: 0, failed: 0,
    dropped: 0, waiting: 0, deferred: 0, edited: 0, rescored: 0, embedded: 0 });
  assert.equal(owners, 1, "the owner is ensured once");

  calls.length = 0;
  time.advance(60_000);
  await worker.tick();
  assert.ok(calls.includes("pull"), "the pull comes back at its own cadence");
  assert.equal(calls.includes("sources"), false, "the mirror is hourly");
  time.advance(3_600_000);
  calls.length = 0;
  await worker.tick();
  assert.ok(calls.includes("sources"));
  assert.equal(worker.status().retention.entries, 4);
});

test("a loop never overlaps itself, and a slow batch never holds the pull back", async () => {
  const { calls, ingest, database } = stubs();
  const time = clock();
  let release;
  const slow = { async processBatch() { calls.push("process"); await new Promise((resolve) => { release = resolve; }); return {}; } };
  const worker = new FrontierWorker({ ingest, pipeline: slow, database, now: time.now, concurrency: 1, pluginPollMs: 1_000 });
  const first = worker.tick();
  await new Promise((resolve) => setImmediate(resolve));
  time.advance(1_000);
  await worker.tick();
  assert.equal(calls.filter((call) => call === "process").length, 1, "the running batch is not started twice");
  assert.equal(calls.filter((call) => call === "pull").length, 2, "the pull ran on both ticks");
  assert.equal(worker.status().running, true);
  time.advance(700_000);
  assert.equal(worker.status().loops.process.stalled, true, "a batch past the lease is visible as stalled");
  release();
  await first;
  assert.equal(worker.status().loops.process.running, false);
});

test("maintenance stops every loop, and a failure is recorded by code without stopping the others", async () => {
  const { calls, ingest, pipeline, database } = stubs();
  let open = false;
  const worker = new FrontierWorker({ ingest, pipeline, database, canRun: () => open });
  await worker.tick();
  assert.deepEqual(calls, [], "nothing claims or writes during maintenance");
  open = true;
  ingest.pull = async () => { throw new HttpError(503, "knowledge_plugin_unreachable", "down"); };
  const reported = [];
  worker.report = (loop, code) => reported.push([loop, code]);
  await worker.tick();
  assert.equal(worker.status().loops.pull.lastError, "knowledge_plugin_unreachable");
  assert.equal(worker.lastError, "knowledge_plugin_unreachable");
  assert.deepEqual(reported, [["pull", "knowledge_plugin_unreachable"]]);
  assert.ok(calls.includes("process"), "processing ran while the pull failed");
  ingest.pull = async () => ({ inserted: 0 });
  worker.lastStarted.pull = 0;
  await worker.tick();
  assert.equal(worker.lastError, null, "a loop that recovers clears its error");
});

test("without an owner nothing is processed, while the collection goes on", async () => {
  const { calls, ingest, pipeline, database } = stubs();
  const worker = new FrontierWorker({ ingest, pipeline, database,
    ensureOwner: async () => { throw new HttpError(503, "frontier_operator_unconfigured", "no operator"); } });
  await worker.tick();
  await worker.tick();
  assert.equal(calls.includes("process"), false);
  assert.ok(calls.includes("pull"));
  assert.equal(worker.status().loops.owner.lastError, "frontier_operator_unconfigured");
  assert.equal(worker.status().owner, null);
});

test("an unconfigured plugin is neither mirrored nor pulled", async () => {
  const { calls, ingest, database } = stubs();
  ingest.plugin.configured = false;
  const worker = new FrontierWorker({ ingest, database });
  await worker.tick();
  assert.deepEqual(calls, []);
});

test("start arms one unref'd timer; close clears it and waits for running loops", async () => {
  const { ingest, pipeline, database } = stubs();
  const worker = new FrontierWorker({ ingest, pipeline, database, pollMs: 60_000 });
  worker.start();
  const timer = worker.timer;
  assert.ok(timer);
  worker.start();
  assert.equal(worker.timer, timer, "start twice arms one timer");
  assert.equal(worker.status().armed, true);
  await worker.close();
  assert.equal(worker.timer, null);
  assert.equal(await worker.tick().then((started) => started.length), 0, "a closed worker starts nothing");
});

test("the constructor refuses what it cannot run", () => {
  const { ingest, database } = stubs();
  assert.throws(() => new FrontierWorker({ ingest: null, database }), TypeError);
  assert.throws(() => new FrontierWorker({ ingest, database, pipeline: {} }), /processBatch/);
  assert.throws(() => new FrontierWorker({ ingest, database, composer: {} }), /tick/);
  assert.throws(() => new FrontierWorker({ ingest, database, pollMs: 10 }), /poll interval/);
  assert.throws(() => new FrontierWorker({ ingest, database, concurrency: 9 }), /concurrency/);
});

test("the owner's project is made when missing, found when present, and refused without an operator", async () => {
  const created = [];
  const store = {
    projects: new Set(),
    async userById(id) { return id === "ops" ? { id } : null; },
    async requireProject(user, id) { if (!this.projects.has(id)) throw new HttpError(404, "project_not_found", "x"); return { id }; },
    async createProject(user, id, name) { created.push([user.id, id, name]); this.projects.add(id); },
  };
  assert.deepEqual(await ensureFrontierProject({ store, config: { operatorUsers: ["ops", "other"] } }), { userId: "ops", projectId: "evimed-frontier" });
  assert.deepEqual(created, [["ops", "evimed-frontier", "EviMed 前沿动态"]]);
  await ensureFrontierProject({ store, config: { operatorUsers: ["ops"] } });
  assert.equal(created.length, 1, "an existing project is found, not made again");
  await assert.rejects(ensureFrontierProject({ store, config: { operatorUsers: [] } }), { code: "frontier_operator_unconfigured" });
  await assert.rejects(ensureFrontierProject({ store, config: { operatorUsers: ["ghost"] } }), { code: "frontier_operator_unavailable" });
});
