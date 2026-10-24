// What each list served and what the page reported, without a database (ct-track 2026-10-24): the genre reading rule, a
// serve entry's closed shape, a serve that cannot be written answered without a list id, the per-reader minute, and the
// families the scrape reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FrontierInteractions, frontierItemGenre, frontierServeEntry } from "../src/frontierInteractions.mjs";

test("an item's genre is the stored one where written and code's fallback otherwise (contract A)", () => {
  assert.equal(frontierItemGenre({ genre: "commentary", source_type: "journal" }), "commentary");
  assert.equal(frontierItemGenre({ genre: null, source_type: "journal" }), "paper");
  assert.equal(frontierItemGenre({ genre: "not-a-genre", safety_alert: true }), "safety", "an unknown stored word is no genre: code's answer");
  assert.equal(frontierItemGenre({ safetyAlert: true }), "safety", "camel case as well");
  assert.equal(frontierItemGenre(null), "news");
});

test("a serve entry keeps an item or an event, a closed slot, a rounded score and a propensity in (0, 1], nothing else", () => {
  assert.deepEqual(frontierServeEntry({ item: "abc", slot: "explore", score: 0.123456789, propensity: 1 / 3, title: "dropped" }),
    { item: "abc", slot: "explore", score: 0.1235, propensity: 0.333333 });
  assert.deepEqual(frontierServeEntry({ event: "e1", slot: "sponsored", score: "high", propensity: 0 }), { event: "e1", slot: null, score: null, propensity: null });
  assert.deepEqual(frontierServeEntry({ item: "abc", propensity: 2 }), { item: "abc", slot: null, score: null, propensity: null });
});

test("a serve that cannot be written is answered without a list id and counted; an unknown surface is a programming error", async () => {
  const failing = new FrontierInteractions({ database: { query: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } } });
  assert.equal(await failing.serve("reader", { surface: "feed", policy: "feed:selected:timeline", entries: [{ item: "abc" }] }), null);
  assert.deepEqual([failing.counters.serveFailures, failing.lastError], [1, "ECONNREFUSED"]);
  await assert.rejects(failing.serve("reader", { surface: "home", policy: "x", entries: [] }), TypeError);
  const statements = [];
  const working = new FrontierInteractions({ database: { query: async (sql, values) => { statements.push(values); return { rows: [], rowCount: 1 }; } } });
  const listId = await working.serve("reader", { surface: "for-you", policy: "for-you-2026-10-24.1", editorial: "e:threshold:82",
    entries: [{ item: "a", slot: "personal", score: 1.2 }, { item: "b", slot: "explore", score: 0.3, propensity: 0.25 }] });
  assert.match(listId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(statements[0][5]), [{ item: "a", slot: "personal", score: 1.2, propensity: null }, { item: "b", slot: "explore", score: 0.3, propensity: 0.25 }]);
});

test("a reader's minute: past the limit the whole batch is refused with when to try again, and the next minute takes events again", async () => {
  let now = Date.parse("2026-10-24T08:00:00Z");
  const database = { query: async (sql) => (sql.includes("INSERT INTO evimed_frontier.interactions") ? { rowCount: 3, rows: [] } : { rows: [] }) };
  const interactions = new FrontierInteractions({ database, config: { frontierEventsPerMinute: 5 }, now: () => new Date(now) });
  const batch = (count) => ({ events: Array.from({ length: count }, (_, index) => ({ id: `evt_${now}_${index}`, type: "filter-change", surface: "feed", detail: "view",
    session: "ses_00000001", at: now })) });
  assert.equal((await interactions.record({ id: "reader" }, batch(3))).accepted, 3);
  await assert.rejects(interactions.record({ id: "reader" }, batch(3)), (error) => error.code === "frontier_events_rate_limited" && error.status === 429
    && error.retryAfterSeconds === 60);
  assert.equal(interactions.counters.events["rate-limited"], 3);
  await assert.rejects(interactions.record({ id: "reader" }, { events: [] }), { code: "frontier_events_invalid" });
  now += 61_000;
  assert.equal((await interactions.record({ id: "reader" }, batch(3))).accepted, 3, "a new minute");
  const family = interactions.metricFamilies().find((entry) => entry.name === "open_science_frontier_events_total");
  assert.deepEqual(family.series.find((series) => series.labels.outcome === "accepted").value, 6);
  assert.ok(family.series.every((series) => !/reader/.test(JSON.stringify(series.labels))), "no account in any label");
});
