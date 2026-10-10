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
  assert.ok(calls.includes("cluster") && calls.includes("daily"), "the compose loops reached the composer");
  assert.deepEqual(Object.keys(worker.status().loops).filter((loop) => loop.startsWith("compose")).sort(),
    ["compose-editorial", "compose-issue", "compose-notifications", "compose-profiles"], "each chain is a loop of the worker's own");
  assert.equal(worker.status().loops["compose-editorial"].runs, 1);
  assert.ok(worker.status().composer.loops.cluster, "the worker's status carries the composer's");
});

test("D-01: a slow editorial chain holds back no other chain — the notices run when they are due — no chain runs twice at once, and a failure is its own loop's", async () => {
  // The review's toy: clustering takes 600 ms in a busy round while notices are due every 20 ms; with every chain awaited together
  // the notices ran 5 times in 3 s instead of about 150. Here the editorial chain stays inside clustering across ticks.
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let now = new Date("2026-09-22T00:00:00Z");
  let noticeFailure = false;
  const events = { clusterPending: async () => { calls.push("cluster"); await gate; }, computeHot: async () => { calls.push("hot"); }, writeDigests: async () => { calls.push("digests"); }, status: () => ({ counters: {} }) };
  const notifications = { queueWeekly: async () => { calls.push("weeklyPush"); }, scanSafety: async () => { calls.push("safety"); },
    deliverDue: async () => { calls.push("notices"); if (noticeFailure) throw Object.assign(new Error("notices"), { code: "test_notices_failed" }); return { delivered: 0 }; }, status: () => ({ counters: {} }) };
  const daily = { state: { missing: false, day: "2026-09-22" }, runDue: async () => { calls.push("daily"); }, pushDue: async () => { calls.push("push"); }, status: () => ({}) };
  const reports = [];
  const composer = new FrontierComposer({ events, daily, notifications, now: () => now, report: (loop, code) => reports.push([loop, code]) });
  const worker = new FrontierWorker({ ingest: { plugin: { configured: false }, status: () => ({}) }, database: { query: async () => ({ rowCount: 0, rows: [] }) },
    composer, cleanupMs: 3_600_000, now: () => now });

  const first = worker.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((name) => name === "cluster"), ["cluster"]);
  for (const name of ["daily", "push", "weeklyPush", "safety", "notices"]) assert.ok(calls.includes(name), `${name} ran while clustering was still going`);
  assert.equal(calls.includes("hot"), false, "the hot list waits for clustering inside its own chain");

  // Ten seconds on, clustering is still running: the notices are due again and run; the editorial chain is not started a second time.
  now = new Date(now.getTime() + FRONTIER_COMPOSER_CADENCES.notices);
  calls.length = 0;
  noticeFailure = true;
  await worker.tick();
  assert.deepEqual(calls, ["notices"], "the notices ran at their own pace, and nothing else started");
  assert.equal(worker.status().loops["compose-notifications"].lastError, "test_notices_failed", "the failure is the notification chain's loop's");
  assert.equal(worker.status().loops["compose-editorial"].lastError, null);
  assert.equal(worker.status().running, true, "a running chain is visible to the maintenance window");
  assert.deepEqual(reports, [["notices", "test_notices_failed"]]);

  release();
  await first;
  assert.ok(calls.includes("hot") && calls.includes("digests"), "the editorial chain went on in order once clustering ended");
  assert.equal(worker.status().running, false);
  assert.equal(worker.status().loops["compose-editorial"].runs, 1, "one run, however many ticks it spanned");
});

test("D-01: a composer that only offers tick() is still one loop, compose", async () => {
  let ticks = 0;
  const composer = { tick: async () => { ticks += 1; return []; }, status: () => ({}) };
  const worker = new FrontierWorker({ ingest: { plugin: { configured: false }, status: () => ({}) }, database: { query: async () => ({ rowCount: 0, rows: [] }) },
    composer, cleanupMs: 3_600_000 });
  await worker.tick();
  assert.equal(ticks, 1);
  assert.equal(worker.status().loops.compose.runs, 1);
  assert.equal(Object.keys(worker.status().loops).some((loop) => loop.startsWith("compose-")), false);
});
