// The daily archive carries the schedule the issue is published by, so the page names
// the time and the zone from the deployment's own setting instead of a copy of it
// written into the interface (design reference §12.6, E-3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { FrontierDaily } from "../src/frontierDaily.mjs";
import { FrontierService } from "../src/frontierService.mjs";

test("the archive reply names the time and the time zone the daily is configured to publish by", async () => {
  const daily = new FrontierDaily({ database: {}, config: { frontierDailyTime: "08:15", frontierTimeZone: "Asia/Shanghai" } });
  daily.list = async () => [{ day: "2026-10-07", title: null, itemCount: 12, generatedAt: null }];
  daily.publicationStatus = async () => ({ day: '2026-10-07', state: 'published' });
  const reply = await FrontierService.prototype.dailies.call({ daily }, new URLSearchParams());
  assert.deepEqual(reply.schedule, { time: "08:15", timeZone: "Asia/Shanghai" });
  assert.equal(reply.dailies.length, 1);
});

test("a deployment that sets nothing publishes at 07:30 Beijing time, and the reply says so", async () => {
  const daily = new FrontierDaily({ database: {}, config: {} });
  daily.list = async () => [];
  daily.publicationStatus = async () => ({ day: '2026-10-07', state: 'pending' });
  const reply = await FrontierService.prototype.dailies.call({ daily }, new URLSearchParams("limit=5"));
  assert.deepEqual(reply, { dailies: [], schedule: { time: "07:30", timeZone: "Asia/Shanghai" }, publication: { day: '2026-10-07', state: 'pending' } });
});

test("a bad limit is still refused, and a deployment without the daily still answers 404", async () => {
  const daily = new FrontierDaily({ database: {}, config: {} });
  await assert.rejects(FrontierService.prototype.dailies.call({ daily }, new URLSearchParams("limit=0")), { status: 400, code: "frontier_query_invalid" });
  await assert.rejects(FrontierService.prototype.dailies.call({ daily: null }, new URLSearchParams()), { status: 404 });
});

test('a missing issue is empty only after the durable job completed empty, and a failed generation stays failed', async () => {
  let job = null;
  const daily = new FrontierDaily({ database: { query: async () => ({ rows: job ? [job] : [] }) }, owner: () => ({ userId: 'operator' }) });
  daily.ready = async () => {};
  daily.read = async () => null;
  assert.equal((await daily.publicationStatus('2026-10-09')).state, 'pending');
  job = { status: 'succeeded', result: { empty: true } };
  assert.equal((await daily.publicationStatus('2026-10-09')).state, 'empty');
  job = { status: 'failed', error: { code: 'failed' } };
  assert.equal((await daily.publicationStatus('2026-10-09')).state, 'failed');
});
