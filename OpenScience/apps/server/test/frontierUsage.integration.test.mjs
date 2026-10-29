// The operators' figures for the feed against a real PostgreSQL (fr-ops, 2026-10-22): readers and reads per day in the feed's own time zone,
// the frontier's notices by outcome, the sources by state, the model's spend, the plugin's discovery and provider blocks, a part that cannot
// be read saying so, and the Prometheus families made from the same snapshot.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createFrontierUsage, usageDiscovery, usageProviders } from "../src/frontierUsage.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** 14:00 in Beijing on 2026-10-22. */
const NOW = new Date("2026-10-22T06:00:00Z");
const config = { frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300 };
const PLUGIN = {
  pluginHealthDetail: {
    providers: [
      { name: "SocialData", calls_24h: 410, spend_24h: { amount: 0.082, currency: "usd" }, remaining: { amount: 4.7, currency: "usd" }, last_error: null },
      { name: "dajiala", calls_24h: 12, spend_24h: { amount: 1.68, currency: "CNY" }, remaining: { amount: 27.1, currency: "CNY" }, last_error: { code: "balance_low" } },
      { name: "!!", calls_24h: 1 },
      { name: "crawler", calls_24h: "x", spend_24h: { amount: -1, currency: "CNY" } },
    ],
    discovery: [
      { day: "2026-10-21", candidates: 120, validated: 60, trial: 30, admitted: 14, retired: 3, failed: 7 },
      { day: "2026-10-22", candidates: 40, validated: 22, trial: 12, admitted: 6, retired: 1, failed: 2 },
    ],
  },
};

/** @type {any} */ let isolated;
/** @type {any} */ let db;
/** @type {any} */ let bare;
/** @type {any} */ let bareDb;
const ids = { alice: "alice", bob: "bob", carol: "carol", dave: "dave" };

/** @param {string} at */ const iso = (at) => new Date(at).toISOString();
const fingerprint = (/** @type {number} */ n) => String(n).padStart(64, "0");

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "frusage");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await migrateProductStore(db);
  await migrateNotifications(db);
  await migrateUsageLedger(db);
  for (const id of Object.values(ids)) await db.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $1, 'development')", [id]);
  await insertSource(db, "nejm");
  const [one, two, three] = [await insertItem(db), await insertItem(db), await insertItem(db)];
  const state = (/** @type {string} */ user, /** @type {string} */ item, /** @type {string | null} */ readAt, /** @type {string | null} */ starredAt) =>
    db.query("INSERT INTO evimed_frontier.user_state(user_id, item_id, read_at, starred_at) VALUES ($1, $2, $3, $4)", [user, item, readAt && iso(readAt), starredAt && iso(starredAt)]);
  // 2026-10-21T17:30Z is 01:30 on the 22nd in Beijing: the day is the feed's, not UTC's.
  await state(ids.alice, one.id, "2026-10-22T01:00:00Z", null);
  await state(ids.alice, two.id, "2026-10-21T17:30:00Z", null);
  await state(ids.bob, one.id, "2026-10-21T05:00:00Z", "2026-10-21T05:01:00Z");
  await state(ids.carol, three.id, null, "2026-10-22T02:00:00Z");
  await state(ids.dave, one.id, "2026-10-18T05:00:00Z", null);
  await db.query("INSERT INTO evimed_frontier.user_follows(user_id, kind, key, label, created_at) VALUES ($1, 'topic', 'oncology', 'Oncology', $2)", [ids.dave, iso("2026-10-21T10:00:00Z")]);
  await db.query("INSERT INTO evimed_frontier.event_reads(user_id, event_id, read_at) VALUES ($1, 'ev_1', $2)", [ids.bob, iso("2026-10-22T03:00:00Z")]);
  await db.query(`INSERT INTO evimed_frontier.exposures(user_id, surface, policy_revision_id, items, candidate_ids, exposed_at)
    VALUES ($1, 'feed', 'p1', '[]'::jsonb, '[]'::jsonb, $2)`, [ids.alice, iso("2026-10-20T04:00:00Z")]);
  const notice = (/** @type {string} */ id, /** @type {string} */ user, /** @type {any} */ source, /** @type {string} */ createdAt, /** @type {string | null} */ readAt, /** @type {any} */ sent) =>
    db.query(`INSERT INTO evimed_inbox.notifications(id, user_id, notice_type, priority, title, body, source, created_at, read_at, channels_sent)
      VALUES ($1, $2, 'notify', 1, 't', 'b', $3::jsonb, $4, $5, $6::jsonb)`, [id, user, JSON.stringify(source), iso(createdAt), readAt && iso(readAt), JSON.stringify(sent)]);
  await notice("n1", ids.alice, { type: "digest", id: "frontier-daily:2026-10-22" }, "2026-10-22T00:00:00Z", "2026-10-22T01:10:00Z", { feishu: "2026-10-22T00:00:30Z" });
  await notice("n2", ids.bob, { type: "digest", id: "frontier-daily:2026-10-22" }, "2026-10-22T00:00:00Z", null, {});
  await notice("n3", ids.carol, { type: "digest", id: "frontier-daily:2026-10-21" }, "2026-10-21T00:00:00Z", "2026-10-22T02:00:00Z", {});
  await notice("n4", ids.alice, { type: "digest", id: "frontier-weekly:2026-10-19" }, "2026-10-22T00:30:00Z", null, {});
  await notice("n5", ids.dave, { type: "run", id: "run_1" }, "2026-10-22T00:30:00Z", "2026-10-22T00:40:00Z", { feishu: "2026-10-22T00:31:00Z" });
  const request = (/** @type {number} */ n, /** @type {string} */ purpose, /** @type {string} */ status, /** @type {string} */ at, /** @type {number | null} */ cost) =>
    db.query(`INSERT INTO evimed_usage.model_requests(id, user_id, model, price_version, currency, request_fingerprint, status, reserved_cost, actual_cost,
      reservation_expires_at, created_at, purpose) VALUES ($1, $2, 'deepseek-flash', 'v1', 'CNY', $3, $4, 1, $5, $6, $6, $7)`,
    [`req_${n}`, ids.alice, fingerprint(n), status, cost, iso(at), purpose]);
  await request(1, "frontier", "settled", "2026-10-22T02:00:00Z", 1.5);
  await request(2, "frontier", "settled", "2026-10-22T03:00:00Z", 2.25);
  await request(3, "frontier", "settled", "2026-10-21T02:00:00Z", 0.5);
  await request(4, "frontier", "reserved", "2026-10-21T03:00:00Z", null);
  await request(5, "other", "settled", "2026-10-22T02:00:00Z", 99);
  // The sources, one of each state (the mirror's own columns).
  await insertSource(db, "a", { plugin_health: "healthy" });
  await insertSource(db, "b", { plugin_health: "degraded" });
  await insertSource(db, "c", { plugin_health: "new", source_type: "x" });
  await insertSource(db, "d", { enabled: false });
  await insertSource(db, "e", { retired_at: iso("2026-10-10T00:00:00Z") });
  await db.query("UPDATE evimed_frontier.sources SET last_ok_at = $2, last_new_entry_at = $3 WHERE id = $1", ["a", iso("2026-10-22T05:00:00Z"), iso("2026-10-21T06:00:00Z")]);
  await db.query("UPDATE evimed_frontier.sources SET last_ok_at = $2, last_new_entry_at = $3 WHERE id = $1", ["b", iso("2026-10-20T06:00:00Z"), iso("2026-10-12T06:00:00Z")]);
  await db.query("UPDATE evimed_frontier.sources SET enabled = false WHERE id = 'nejm'");
  // A deployment that migrated only the feed: no inbox, no usage ledger.
  bare = await createGeoTestDatabase(url, "frusagebare");
  bareDb = new ControlPlaneDatabase({ databaseUrl: bare.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(bareDb, { dimension: 1024 });
});
after(async () => {
  await db?.close();
  await bareDb?.close();
  await isolated?.drop();
  await bare?.drop();
});

const usage = (/** @type {any} */ extra = {}) => createFrontierUsage({ database: db, config, plugin: () => PLUGIN, now: () => NOW, ...extra });

test("a day is the feed's own: readers, item and event reads, stars and follows per day, newest first, with an empty day written as zeros", options, async () => {
  const { days } = await usage().snapshot({ days: 4 });
  assert.deepEqual(days.map((/** @type {any} */ row) => row.day), ["2026-10-22", "2026-10-21", "2026-10-20", "2026-10-19"]);
  const figures = (/** @type {any} */ row) => ({ readers: row.readers, itemReads: row.itemReads, eventReads: row.eventReads, stars: row.stars, follows: row.follows });
  // 22nd: alice read two items (one at 01:30 Beijing, 17:30 UTC the day before), bob opened an event, carol starred and opened the daily.
  assert.deepEqual(figures(days[0]), { readers: 3, itemReads: 2, eventReads: 1, stars: 1, follows: 0 });
  // 21st: bob read and starred, dave followed.
  assert.deepEqual(figures(days[1]), { readers: 2, itemReads: 1, eventReads: 0, stars: 1, follows: 1 });
  // 20th: only the feed was shown to alice. 19th: nothing at all, which is a fact and not a missing day.
  assert.deepEqual(figures(days[2]), { readers: 1, itemReads: 0, eventReads: 0, stars: 0, follows: 0 });
  assert.deepEqual(figures(days[3]), { readers: 0, itemReads: 0, eventReads: 0, stars: 0, follows: 0 });
  assert.ok(!JSON.stringify(days).includes("alice") && !JSON.stringify(days).includes("carol"), "no account appears in a figure");
});

test("the frontier's notices are counted by family and outcome; a Feishu open is an item sent there and read, and another product's notice is not counted", options, async () => {
  const { days } = await usage().snapshot({ days: 2 });
  assert.deepEqual(days[0].notices.daily, { delivered: 2, opened: 2, feishu_delivered: 1, feishu_opened: 1 });
  assert.deepEqual(days[0].notices.weekly, { delivered: 1, opened: 0, feishu_delivered: 0, feishu_opened: 0 });
  assert.deepEqual(days[0].notices.safety, { delivered: 0, opened: 0, feishu_delivered: 0, feishu_opened: 0 });
  // The 21st's daily was delivered that day and opened the next.
  assert.deepEqual(days[1].notices.daily, { delivered: 1, opened: 0, feishu_delivered: 0, feishu_opened: 0 });
});

test("the model's spend per day is the settled cost of purpose frontier, with every request counted and the budget beside it", options, async () => {
  const { days } = await usage().snapshot({ days: 2 });
  assert.deepEqual(days[0].model, { requests: 2, costCny: 3.75, budgetCny: 300 });
  assert.deepEqual(days[1].model, { requests: 2, costCny: 0.5, budgetCny: 300 }, "a reserved request counts as a request and costs nothing until settled");
});

test("sources are counted by state, health and type: a retired source is only retired, a source that never produced is silent and never read", options, async () => {
  const { sources } = await usage().snapshot({ days: 1 });
  assert.deepEqual(sources, {
    enabled: 3, disabled: 2, retired: 1, silent7d: 2, neverRead: 1,
    byHealth: { degraded: 1, healthy: 1, new: 1 }, byType: { journal: 2, x: 1 },
  });
});

test("the plugin's providers and discovery are read as reported, tolerant of its spelling, with an unreadable value dropped", options, async () => {
  const snapshot = await usage().snapshot({ days: 1 });
  assert.deepEqual(snapshot.providers.map((/** @type {any} */ row) => row.name), ["socialdata", "dajiala", "crawler"], "a name with no usable character is dropped, the rest are lower-cased");
  assert.deepEqual(snapshot.providers[0], { name: "socialdata", calls24h: 410, spend24h: { amount: 0.082, currency: "USD" }, remaining: { amount: 4.7, currency: "USD" }, lastError: null });
  assert.equal(snapshot.providers[1].lastError, "balance_low");
  assert.deepEqual(snapshot.providers[2], { name: "crawler", calls24h: null, spend24h: null, remaining: null, lastError: null });
  assert.equal(snapshot.discovery.today.day, "2026-10-22");
  assert.deepEqual([snapshot.discovery.today.admitted, snapshot.discovery.today.retired, snapshot.discovery.today.net], [6, 1, 5]);
  assert.deepEqual(snapshot.discovery.days.map((/** @type {any} */ row) => row.day), ["2026-10-22", "2026-10-21"]);
  // The camelCase spelling, an object of providers keyed by name, a single row of discovery and the object form with its history all read.
  assert.deepEqual(usageProviders({ providers: { Dajiala: { calls24h: 3, spend24h: 0.42 } } }), [{ name: "dajiala", calls24h: 3, spend24h: { amount: 0.42, currency: "UNKNOWN" }, remaining: null, lastError: null }]);
  assert.equal(usageProviders({}), null);
  assert.equal(usageDiscovery({ discovery: { day: "2026-10-22", admitted: 2, retired: 0 } })?.today?.net, 2);
  assert.deepEqual(usageDiscovery({ discovery: { today: { day: "2026-10-22", admitted: 1 }, days: [{ day: "2026-10-21", admitted: 4 }] } })?.days.map((/** @type {any} */ row) => row.day), ["2026-10-22", "2026-10-21"]);
  assert.equal(usageDiscovery({ discovery: "x" }), null);
  assert.equal(usageDiscovery({ discovery: [] }), null);
});

test("a figure that cannot be read is null with its reason, never 0: no inbox, no ledger, a plugin that does not report, a table that fails", options, async () => {
  const plain = createFrontierUsage({ database: bareDb, config, plugin: () => ({ pluginHealthDetail: {} }), now: () => NOW });
  const snapshot = await plain.snapshot({ days: 2 });
  assert.equal(snapshot.days[0].notices, null);
  assert.equal(snapshot.days[0].model, null);
  assert.equal(snapshot.noticesReason, "inbox_unavailable");
  assert.equal(snapshot.modelReason, "usage_ledger_unavailable");
  assert.equal(snapshot.days[0].readers, 0, "the reader figures that do not depend on them are still there");
  assert.deepEqual(snapshot.discovery, { value: null, reason: "plugin_does_not_report_discovery" });
  assert.deepEqual(snapshot.providers, { value: null, reason: "plugin_does_not_report_providers" });
  const unreachable = await createFrontierUsage({ database: bareDb, config, plugin: null, now: () => NOW }).snapshot({ days: 1 });
  assert.deepEqual(unreachable.providers, { value: null, reason: "plugin_health_unavailable" });
  // One part failing costs that part and nothing else.
  const flaky = { query: (/** @type {string} */ text, /** @type {any[]} */ params) => (/FROM evimed_frontier\.sources/.test(text) ? Promise.reject(Object.assign(new Error("boom"), { code: "XX000" })) : db.query(text, params)) };
  const partial = createFrontierUsage({ database: flaky, config, plugin: () => PLUGIN, now: () => NOW });
  const result = await partial.snapshot({ days: 1 });
  assert.deepEqual(result.sources, { value: null, reason: "XX000" });
  assert.equal(result.days[0].readers, 3);
  assert.equal(partial.stats().partFailures, 1);
});

test("the window is validated and bounded", options, async () => {
  for (const days of [0, -1, 1.5, 91, Number.NaN]) await assert.rejects(() => usage().snapshot({ days }), { code: "usage_report_days_invalid", status: 400 }, String(days));
  assert.equal((await usage().snapshot({ days: 90 })).days.length, 90);
  assert.equal((await usage().snapshot()).days.length, 14, "two weeks unless asked");
});

test("the Prometheus families carry today and yesterday as gauges, are made from one snapshot kept for a minute, and have no series for what could not be read", options, async () => {
  let at = NOW.getTime();
  const metered = usage({ now: () => new Date(at) });
  const families = await metered.metricFamilies();
  const one = (/** @type {string} */ name, /** @type {Record<string, string>} */ labels) => {
    const family = families.find((entry) => entry.name === name);
    assert.ok(family, name);
    return family.series.find((row) => Object.entries(labels).every(([key, value]) => row.labels?.[key] === value))?.value;
  };
  assert.equal(one("open_science_frontier_usage_snapshot", {}), 1);
  assert.equal(one("open_science_frontier_usage_readers", { window: "today" }), 3);
  assert.equal(one("open_science_frontier_usage_readers", { window: "yesterday" }), 2);
  assert.equal(one("open_science_frontier_usage_item_reads", { window: "today" }), 2);
  assert.equal(one("open_science_frontier_usage_notices", { kind: "daily", outcome: "opened", window: "today" }), 2);
  assert.equal(one("open_science_frontier_usage_notices", { kind: "daily", outcome: "feishu_delivered", window: "today" }), 1);
  assert.equal(one("open_science_frontier_usage_model_spend_cny", { provider: "deepseek", window: "today" }), 3.75);
  assert.equal(one("open_science_frontier_usage_sources", { state: "silent_7d" }), 2);
  assert.equal(one("open_science_frontier_usage_sources_by_type", { type: "x" }), 1);
  assert.equal(one("open_science_frontier_discovery_today", { stage: "net" }), 5);
  assert.equal(one("open_science_frontier_discovery_today", { stage: "admitted" }), 6);
  assert.equal(one("open_science_frontier_provider_calls_24h", { provider: "socialdata" }), 410);
  assert.equal(one("open_science_frontier_provider_spend_24h", { provider: "socialdata", currency: "USD" }), 0.082);
  assert.equal(one("open_science_frontier_provider_remaining", { provider: "dajiala", currency: "CNY" }), 27.1);
  assert.equal(one("open_science_frontier_provider_error", { provider: "dajiala" }), 1);
  assert.equal(one("open_science_frontier_provider_error", { provider: "socialdata" }), 0);
  for (const family of families) for (const row of family.series) {
    assert.ok(Number.isFinite(row.value), family.name);
    assert.ok(Object.keys(row.labels ?? {}).every((key) => !["user", "user_id", "account", "day", "id"].includes(key)), `${family.name}: no account or day in a label`);
  }
  await metered.metricFamilies();
  assert.equal(metered.stats().snapshots, 1, "the second scrape inside the minute reads nothing");
  assert.equal(metered.stats().cacheHits, 1);
  at += 61_000;
  await metered.metricFamilies();
  assert.equal(metered.stats().snapshots, 2);
  // A plugin that reports nothing and an inbox that is not there leave those families out rather than writing zeros.
  const plain = await createFrontierUsage({ database: bareDb, config, plugin: () => ({ pluginHealthDetail: {} }), now: () => NOW }).metricFamilies();
  const names = new Set(plain.map((family) => family.name));
  for (const absent of ["open_science_frontier_usage_notices", "open_science_frontier_usage_model_spend_cny", "open_science_frontier_discovery_today", "open_science_frontier_provider_calls_24h"]) assert.equal(names.has(absent), false, absent);
  assert.ok(names.has("open_science_frontier_usage_readers"));
  // A database that cannot answer at all costs the scrape its series and the platform nothing: one family, saying it could not be read.
  const down = await createFrontierUsage({ database: { query: () => Promise.reject(new Error("down")) }, config, now: () => NOW }).metricFamilies();
  assert.deepEqual(down.map((family) => [family.name, family.series[0].value]), [["open_science_frontier_usage_snapshot", 0]]);
});
