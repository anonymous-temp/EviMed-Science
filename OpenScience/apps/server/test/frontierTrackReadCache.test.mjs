import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FRONTIER_CONGRESSES } from "@evimed/domain";
import { FrontierTrack } from "../src/frontierTrack.mjs";

// The congress list is one regex count per open congress (13.9 s for 17 on production, 2026-10-27): the service's reader answers
// from its last result and refreshes behind the read; a reader built without `readCacheMs` (the pipeline's) reads every time.
const congress = FRONTIER_CONGRESSES.find((entry) => entry.id === "esmo-2026") ?? FRONTIER_CONGRESSES[0];
const now = () => new Date(`${congress.start}T08:00:00Z`);

function countingDatabase() {
  const state = { queries: 0, count: 5, fail: false };
  return {
    state,
    async query(/** @type {string} */ sql) {
      state.queries += 1;
      if (state.fail) throw new Error("database down");
      assert.match(sql, /count\(\*\)::int AS count/);
      return { rows: [{ count: state.count }] };
    },
  };
}

test("the service's congress list is read once per window, refreshed behind a stale read, and kept when a refresh fails", async () => {
  const database = countingDatabase();
  const track = new FrontierTrack({ database, now, calendar: [congress], readCacheMs: 40 });
  const [first, together] = await Promise.all([track.congresses(), track.congresses()]);
  assert.equal(first[0].itemCount, 5);
  assert.deepEqual(together, first);
  assert.equal(database.state.queries, 1, "callers that arrive together share one read");
  await track.congresses();
  assert.equal(database.state.queries, 1, "a fresh result is answered without a query");
  await sleep(50);
  database.state.count = 7;
  assert.equal((await track.congresses())[0].itemCount, 5, "a stale result is answered at once");
  await sleep(5);
  assert.equal(database.state.queries, 2, "and one refresh ran behind it");
  assert.equal((await track.congresses())[0].itemCount, 7);
  await sleep(50);
  database.state.fail = true;
  assert.equal((await track.congresses())[0].itemCount, 7, "a failing refresh leaves the last result standing");
  await sleep(5);
  database.state.fail = false;
  await sleep(50);
  await track.congresses();
  await sleep(5);
  assert.equal((await track.congresses())[0].itemCount, 7);
});

test("without readCacheMs every read goes to the database", async () => {
  const database = countingDatabase();
  const track = new FrontierTrack({ database, now, calendar: [congress] });
  await track.congresses();
  await track.congresses();
  assert.equal(database.state.queries, 2);
});

test("warming reads the list, then the hub of each congress that has something in it, one at a time", async () => {
  const database = countingDatabase();
  const track = new FrontierTrack({ database, now, calendar: [congress], readCacheMs: 40 });
  const read = [];
  const hub = track.congress.bind(track);
  track.congress = async (id) => { read.push(id); return hub(id); };
  track.congresses = async () => [{ id: "a", itemCount: 2 }, { id: "b", itemCount: 0 }, { id: "c", itemCount: 1 }];
  await track.warmCongresses();
  assert.deepEqual(read, ["a", "c"]);
});
