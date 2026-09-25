// 「循证 GEO」's worker: one timer, many loops, each isolated — a failing
// loop never stops the others; a loop without its function is reported, not
// run; cadences hold; a leased loop held elsewhere is skipped; readiness
// hears about all of it as warnings.
import assert from "node:assert/strict";
import test from "node:test";
import { GEO_WORKER_LOOPS, GeoWorker, withGeoWorkerWarnings, zonedDayHour } from "../src/geoWorker.mjs";

/** A clock the test moves. @param {string} iso */
function clock(iso) {
  let at = Date.parse(iso);
  return { now: () => new Date(at), advance: (/** @type {number} */ ms) => { at += ms; } };
}

test("a failing loop records its code and failures; every other loop still runs, and runs again next tick", async () => {
  const time = clock("2026-09-28T02:00:00Z");
  /** @type {Record<string, number>} */
  const ran = {};
  const count = (/** @type {string} */ name) => async () => { ran[name] = (ran[name] ?? 0) + 1; return { asked: 1, rows: [1, 2] }; };
  /** @type {string[]} */
  const reported = [];
  const worker = new GeoWorker({
    now: time.now, report: (loop, code) => reported.push(`${loop}:${code}`),
    loops: {
      probe: async () => { throw Object.assign(new Error("probe host down"), { code: "geo_probe_unavailable" }); },
      parse: count("parse"), metrics: count("metrics"), errors: async () => { throw new Error("no code"); },
      orchestrator: count("orchestrator"), schedules: count("schedules"), orders: count("orders"), poll: count("poll"),
    },
  });
  await worker.tick();
  time.advance(5_000);
  await worker.tick();
  assert.deepEqual(ran, { parse: 2, metrics: 2, orchestrator: 1, schedules: 1, orders: 1, poll: 1 },
    "every-tick loops ran twice, minute and ten-minute loops once, whatever the probe and errors loops did");
  const status = worker.status();
  assert.equal(status.loops.probe.lastError, "geo_probe_unavailable");
  assert.equal(status.loops.probe.failures, 2);
  assert.equal(status.loops.errors.lastError, "geo_loop_failed", "a failure without a code gets the loop's own");
  assert.deepEqual(status.failing, ["probe", "errors"]);
  assert.deepEqual(status.loops.parse.last, { asked: 1, rows: 2 }, "a tick's counts, never its rows");
  assert.deepEqual(status.missing, ["catalogue", "verify", "reconcile", "topups"], "loops without their function are listed, not run");
  assert.deepEqual(reported, ["probe:geo_probe_unavailable", "errors:geo_loop_failed", "probe:geo_probe_unavailable", "errors:geo_loop_failed"]);
  // Readiness: warnings on a green check.
  const readiness = withGeoWorkerWarnings({ required: true, enabled: true, warnings: ["geo_market_unconfigured"], warning: "geo_market_unconfigured" }, worker);
  assert.deepEqual(readiness.warnings, ["geo_market_unconfigured", "geo_worker_loop_missing", "geo_worker_loop_failing"]);
  assert.equal(readiness.warning, "geo_market_unconfigured");
  assert.deepEqual(withGeoWorkerWarnings({ required: false, enabled: false }, worker), { required: false, enabled: false }, "off stays as it was");
});

test("a loop never overlaps itself; one running past the lease is reported stalled", async () => {
  const time = clock("2026-09-28T02:00:00Z");
  /** @type {() => void} */
  let release = () => {};
  let starts = 0;
  const worker = new GeoWorker({ now: time.now, leaseMs: 60_000, loops: {
    probe: () => { starts += 1; return new Promise((resolve) => { release = () => resolve({ asked: 1 }); }); },
  } });
  const first = worker.tick();
  await worker.tick();
  assert.equal(starts, 1, "a second tick while the loop runs does not start it again");
  time.advance(61_000);
  assert.deepEqual(worker.status().stalled, ["probe"]);
  assert.deepEqual(withGeoWorkerWarnings({ enabled: true, warnings: [] }, worker).warnings, ["geo_worker_loop_missing", "geo_worker_loop_stalled"]);
  release();
  await first;
  assert.deepEqual(worker.status().stalled, []);
});

test("daily loops run once a day at their local hour; the day is claimed across processes", async () => {
  // 2026-09-28 03:30 in Shanghai.
  const time = clock("2026-09-27T19:30:00Z");
  assert.deepEqual(zonedDayHour(time.now(), "Asia/Shanghai"), { day: "2026-09-28", hour: 3 });
  /** @type {Set<string>} */
  const claimed = new Set(["catalogue:2026-09-28"]);
  let reconciles = 0;
  let catalogues = 0;
  const worker = new GeoWorker({
    now: time.now,
    claimDay: async (loop, day) => { const key = `${loop}:${day}`; if (claimed.has(key)) return false; claimed.add(key); return true; },
    loops: { reconcile: async () => { reconciles += 1; return {}; }, catalogue: async () => { catalogues += 1; return {}; } },
  });
  await worker.tick();
  assert.equal(reconciles, 0, "04:00 has not come");
  time.advance(31 * 60_000); // 04:01
  await worker.tick();
  await worker.tick();
  assert.equal(reconciles, 1, "once for the day");
  time.advance(60 * 60_000); // 05:01
  await worker.tick();
  assert.equal(catalogues, 0, "another process (or this one before a restart) already claimed today's catalogue");
  time.advance(24 * 3_600_000); // tomorrow 05:01
  await worker.tick();
  assert.deepEqual([reconciles, catalogues], [2, 1]);
});

test("a leased loop runs inside its lease; held elsewhere it is skipped, not failed", async () => {
  const time = clock("2026-09-28T02:00:00Z");
  /** @type {string[]} */
  const leased = [];
  let heldElsewhere = true;
  let orders = 0;
  let parses = 0;
  const worker = new GeoWorker({
    now: time.now,
    lease: async (loop, work) => { leased.push(loop); if (heldElsewhere) return { acquired: false }; return { acquired: true, value: await work() }; },
    loops: { orders: async () => { orders += 1; return { planned: 2 }; }, parse: async () => { parses += 1; return {}; } },
  });
  await worker.tick();
  assert.deepEqual([orders, parses], [0, 1], "the measurement loop takes its own lock; the market loop waits for its lease");
  assert.deepEqual(leased, ["orders"]);
  assert.deepEqual(worker.status().loops.orders.last, { held: "elsewhere" });
  assert.equal(worker.status().loops.orders.lastError, null);
  heldElsewhere = false;
  time.advance(10 * 60_000);
  await worker.tick();
  assert.equal(orders, 1);
  assert.deepEqual(worker.status().loops.orders.last, { planned: 2 });
});

test("maintenance stops the loops; close waits for the running ones; the table is the build spec's", async () => {
  let allowed = false;
  let runs = 0;
  const worker = new GeoWorker({ canRun: () => allowed, loops: { parse: async () => { runs += 1; return {}; } } });
  await worker.tick();
  assert.equal(runs, 0);
  allowed = true;
  await worker.tick();
  assert.equal(runs, 1);
  worker.start();
  assert.ok(worker.timer, "one timer");
  await worker.close();
  assert.equal(worker.timer, null);
  assert.throws(() => new GeoWorker({ loops: { nonsense: async () => ({}) } }), /Unknown GEO worker loop/);
  assert.deepEqual(GEO_WORKER_LOOPS.map((loop) => loop.name), ["probe", "parse", "metrics", "errors", "orchestrator", "schedules", "catalogue", "orders",
    "poll", "verify", "reconcile", "topups"]);
  assert.deepEqual(GEO_WORKER_LOOPS.filter((loop) => loop.leased).map((loop) => loop.name), ["orchestrator", "schedules", "catalogue", "orders", "poll",
    "verify", "reconcile", "topups"], "every market tick and the orchestrator's two are leased across processes");
});
