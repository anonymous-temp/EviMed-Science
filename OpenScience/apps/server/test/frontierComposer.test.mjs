// The composer's schedule with a fake clock (build spec D): which loops are due
// on a tick, in which order, that a failing loop fails alone and is still
// reported, that maintenance stops everything, and that a missing daily is
// said once a day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FRONTIER_COMPOSER_CADENCES, FrontierComposer } from "../src/frontierComposer.mjs";
import { FrontierWorker } from "../src/frontierWorker.mjs";

function fixture({ failing = null } = {}) {
  const calls = [];
  let now = new Date("2026-09-22T00:00:00Z");
  const step = (name) => async () => {
    calls.push(name);
    if (failing === name) throw Object.assign(new Error(name), { code: `test_${name}_failed` });
    return { name };
  };
  const events = { clusterPending: step("cluster"), computeHot: step("hot"), writeDigests: step("digests"), status: () => ({ counters: {} }) };
  const daily = { state: { missing: false, day: "2026-09-22" }, runDue: step("daily"), pushDue: step("push"), status: () => ({}) };
  const profiles = { refreshDue: step("profiles"), status: () => ({ state: "off" }) };
  const reports = [];
  let open = true;
  const composer = new FrontierComposer({ events, daily, profiles, now: () => now, canRun: () => open,
    report: (loop, code) => reports.push([loop, code]) });
  return {
    composer, calls, reports, daily,
    advance: (ms) => { now = new Date(now.getTime() + ms); },
    close: () => { open = false; },
  };
}

test("the first tick runs every loop, the editorial ones in order; later ticks only what is due", async () => {
  const { composer, calls, advance } = fixture();
  await composer.tick();
  assert.deepEqual(calls.filter((name) => ["cluster", "hot", "digests"].includes(name)), ["cluster", "hot", "digests"]);
  assert.deepEqual(calls.filter((name) => ["daily", "push"].includes(name)), ["daily", "push"], "the push follows the day's issue");
  assert.ok(calls.includes("profiles"));
  calls.length = 0;
  advance(5_000);
  await composer.tick();
  assert.deepEqual(calls, [], "nothing is due five seconds later");
  advance(FRONTIER_COMPOSER_CADENCES.cluster);
  await composer.tick();
  assert.deepEqual(calls, ["cluster"]);
  calls.length = 0;
  advance(FRONTIER_COMPOSER_CADENCES.daily);
  await composer.tick();
  assert.deepEqual(calls.sort(), ["cluster", "daily", "push"]);
  calls.length = 0;
  advance(FRONTIER_COMPOSER_CADENCES.hot);
  await composer.tick();
  assert.deepEqual(calls.sort(), ["cluster", "daily", "digests", "hot", "profiles", "push"]);
  const status = composer.status();
  assert.equal(status.loops.hot.runs, 2);
  assert.equal(status.loops.cluster.dueInMs, FRONTIER_COMPOSER_CADENCES.cluster);
});

test("a failing loop fails alone: the others run, it is reported by code, and the tick rejects so the worker sees it", async () => {
  const { composer, calls, reports } = fixture({ failing: "hot" });
  await assert.rejects(composer.tick(), { code: "test_hot_failed" });
  assert.ok(calls.includes("digests"), "the digests still ran after the hot list failed");
  assert.ok(calls.includes("push") && calls.includes("profiles"));
  assert.deepEqual(reports, [["hot", "test_hot_failed"]]);
  assert.equal(composer.status().loops.hot.lastError, "test_hot_failed");
  assert.equal(composer.status().loops.cluster.lastError, null);
});

test("maintenance stops every loop; a missing daily is reported once that day", async () => {
  const closed = fixture();
  closed.close();
  assert.deepEqual(await closed.composer.tick(), []);
  assert.deepEqual(closed.calls, []);
  const { composer, reports, daily, advance } = fixture();
  daily.state.missing = true;
  await composer.tick();
  advance(FRONTIER_COMPOSER_CADENCES.daily);
  await composer.tick();
  assert.deepEqual(reports, [["daily", "frontier_daily_missing"]]);
  daily.state.day = "2026-09-23";
  advance(FRONTIER_COMPOSER_CADENCES.daily);
  await composer.tick();
  assert.equal(reports.length, 2, "the next day's missing issue is said again");
});

test("the worker's compose hook ticks the composer and its status carries the loops", async () => {
  const { composer, calls } = fixture();
  const worker = new FrontierWorker({ ingest: { plugin: { configured: false }, status: () => ({}) }, database: { query: async () => ({ rowCount: 0, rows: [] }) },
    composer, cleanupMs: 3_600_000 });
  await worker.tick();
  assert.ok(calls.includes("cluster") && calls.includes("daily"), "the compose loop reached the composer");
  assert.equal(worker.status().loops.compose.runs, 1);
  assert.ok(worker.status().composer.loops.cluster, "the worker's status carries the composer's");
});
