// Pulling the plugin into evimed_frontier against a real PostgreSQL, through
// the real client over an in-memory plugin: paging, one transaction per page,
// the cursor, unknown vocabulary, the resync gap and the defensive re-check.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_FACT_KEYS } from "@evimed/domain";
import { FRONTIER_FACT_RULES, FrontierIngest, whitelistFacts } from "../src/frontierIngest.mjs";
import { frontierMetricFamilies } from "../src/frontierService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { KnowledgePluginClient } from "../src/knowledgePluginClient.mjs";
import { TEST_VOCABULARY, memoryPlugin, pluginEntry, pluginSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

let database;
let dir;
let tokenFile;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-ingest-"));
  tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, "test-only-ingest-token\n", { mode: 0o600 });
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
});

after(async () => {
  await database?.close();
  await rm(dir, { recursive: true, force: true });
});

/** Every test starts from an empty mirror and a cursor at 0. */
beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key IN ('plugin_cursor','content_version')");
  await database.query("DELETE FROM evimed_frontier.meta WHERE key='plugin_manifest'");
});

/** @param {ReturnType<typeof memoryPlugin>} plugin @param {Record<string, any>} [overrides] */
function ingestFor(plugin, overrides = {}) {
  const client = new KnowledgePluginClient({ baseUrl: "http://plugin.test:8080", tokenFile, fetchImpl: plugin.fetchImpl, sleep: async () => {} });
  return new FrontierIngest({ database, plugin: client, vocabulary: TEST_VOCABULARY, pageLimit: 2, ...overrides });
}

const cursor = async () => Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key='plugin_cursor'")).rows[0].value);
const states = async () => Object.fromEntries((await database.query("SELECT state, count(*)::integer AS n FROM evimed_frontier.entries GROUP BY state")).rows.map((row) => [row.state, row.n]));

test("a pull pages through the stream, one committed page at a time, and a second pull stores nothing twice", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm"), pluginSource("lancet")],
    entries: [1, 2, 3, 4, 5].map((seq) => pluginEntry(seq % 2 ? "nejm" : "lancet", seq)) });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  const first = await ingest.pull();
  assert.equal(first.pages, 3, "five entries at two a page is three pages");
  assert.equal(first.inserted, 5);
  assert.equal(await cursor(), 5);
  assert.deepEqual(await states(), { received: 5 });
  // Every request carried the token, except health.
  assert.ok(plugin.requests.filter((request) => request.path !== "/v1/health").every((request) => request.authorization === "Bearer test-only-ingest-token"));

  // Nothing new: one empty page, nothing stored.
  const second = await ingest.pull();
  assert.equal(second.inserted, 0);
  assert.equal(second.pages, 1);

  // The same page read again — a cursor put back by hand — is a no-op by key.
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key='plugin_cursor'");
  const replay = await ingest.pull();
  assert.equal(replay.inserted, 0);
  assert.equal(replay.duplicates, 5);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.entries")).rows[0].n, 5);

  // A revision is a new row with a new seq.
  plugin.entries.push({ ...pluginEntry("nejm", 1), seq: 6, revision: 2, content_sha256: "b".repeat(64), title: "Trial 1, revised" });
  const revised = await ingest.pull();
  assert.equal(revised.inserted, 1);
  const rows = (await database.query("SELECT revision, title_raw FROM evimed_frontier.entries WHERE plugin_entry_id=$1 ORDER BY revision",
    [pluginEntry("nejm", 1).entry_id])).rows;
  assert.deepEqual(rows.map((row) => row.revision), [1, 2]);
  const status = ingest.status();
  assert.equal(status.state, "ok");
  assert.equal(status.cursor, 6);
  assert.equal(status.latestSeq, 6);
  assert.equal(status.lag, 0);
});

test("a failure mid-pull keeps the pages already committed and resumes after them", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [1, 2, 3, 4].map((seq) => pluginEntry("nejm", seq)) });
  const ingest = ingestFor(plugin, { pollMs: 1_000 });
  await ingest.mirrorSources();
  // Let the manifest, the health check and the first page through, then fail.
  const fetchImpl = plugin.fetchImpl;
  let entryPages = 0;
  ingest.plugin.fetch = async (input, init) => {
    if (String(input).includes("/v1/entries")) {
      entryPages += 1;
      if (entryPages === 2) throw new TypeError("fetch failed");
      if (entryPages === 3) throw new TypeError("fetch failed");
    }
    return fetchImpl(input, init);
  };
  await assert.rejects(ingest.pull(), { code: "knowledge_plugin_unreachable" });
  assert.equal(await cursor(), 2, "the committed first page stands");
  assert.equal(ingest.status().state, "unreachable");
  assert.equal(ingest.due(), false, "a failed pull backs off");
  assert.match(ingest.status().backoffUntil, /^\d{4}-/);
  ingest.backoffUntil = 0;
  ingest.plugin.fetch = fetchImpl;
  const resumed = await ingest.pull();
  assert.equal(resumed.inserted, 2);
  assert.equal(await cursor(), 4);
  assert.deepEqual(await states(), { received: 4 });
});

test("unknown vocabulary falls back and is counted, and never rejects a row", options, async () => {
  const plugin = memoryPlugin({
    sources: [
      pluginSource("news-cn", { lane: "news", source_type: "blog", health: "sleepy", access: "carrier-pigeon", owner_entity: undefined }),
      pluginSource("fda", { lane: "regulatory", source_type: "regulator", safety_feed: true, authority: 5 }),
    ],
    entries: [pluginEntry("news-cn", 1, { lane_hint: "gossip", date_precision: "fortnight" })],
  });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  const source = (await database.query("SELECT * FROM evimed_frontier.sources WHERE id='news-cn'")).rows[0];
  assert.equal(source.lane, "mixed");
  assert.equal(source.source_type, "media");
  assert.equal(source.plugin_health, "sleepy", "an unknown health word is kept verbatim and served as degraded");
  assert.equal(source.access, "carrier-pigeon");
  assert.equal(source.owner_entity, "news-cn", "no operating entity counts as its own");
  const fda = (await database.query("SELECT safety_feed, authority FROM evimed_frontier.sources WHERE id='fda'")).rows[0];
  assert.deepEqual(fda, { safety_feed: true, authority: 5 });
  await ingest.pull();
  const entry = (await database.query("SELECT lane_hint, date_precision, state FROM evimed_frontier.entries")).rows[0];
  assert.deepEqual(entry, { lane_hint: "mixed", date_precision: "inferred", state: "received" });
  const counted = ingest.status().unknownVocabulary;
  for (const vocabulary of ["lane", "source_type", "health", "access", "lane_hint", "date_precision"]) {
    assert.ok(counted[vocabulary] >= 1, `${vocabulary} was not counted: ${JSON.stringify(counted)}`);
  }
  assert.ok(ingest.status().unknownValues.lane.includes("news"));
});

test("a cursor behind what the plugin still holds resumes from there and counts the gap", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [48, 49, 50, 51].map((seq) => pluginEntry("nejm", seq)), oldest: 50 });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  await database.query("UPDATE evimed_frontier.meta SET value='5'::jsonb WHERE key='plugin_cursor'");
  const pulled = await ingest.pull();
  assert.equal(pulled.inserted, 2, "only what the plugin still holds arrives");
  assert.deepEqual(ingest.status().gaps, { count: 1, entries: 44 });
  assert.equal(await cursor(), 51);

  // A fresh platform starting from 0 has lost nothing.
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key='plugin_cursor'");
  const fresh = ingestFor(plugin);
  await fresh.pull();
  assert.deepEqual(fresh.status().gaps, { count: 0, entries: 0 });
});

/** Health answers rewritten on their way: `latest` is called with the real answer and returns the one the ingest sees, or throws. */
function interceptHealth(ingest, latest) {
  const fetchImpl = ingest.plugin.fetch;
  ingest.plugin.fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!String(input).includes("/v1/health")) return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, latest_seq: latest(body.latest_seq) }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("D-03: a cursor ahead of the plugin's latest seq (a restored plugin database) is rewound and flagged, and what the plugin numbers is not skipped", options, async () => {
  // The review's seq_probe: the platform consumed up to seq 2000 of the old plugin database; the plugin was restored from
  // a backup (its sequence is back near 1,400) and has numbered ten new entries. The pull asked for "after 2000", got an
  // empty page, and reported ok with lag 0 — and every entry the plugin numbered up to 2000 would never have been asked for.
  await database.query("UPDATE evimed_frontier.meta SET value='2000'::jsonb WHERE key='plugin_cursor'");
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: Array.from({ length: 10 }, (_, index) => pluginEntry("nejm", 1401 + index)) });
  const ingest = ingestFor(plugin, { pageLimit: 50 });
  await ingest.mirrorSources();
  const pulled = await ingest.pull();
  assert.deepEqual(pulled.rewound, { from: 2000, to: 0 }, "the plugin's whole stream is read again: the keys make a replay a no-op");
  assert.equal(pulled.inserted, 10, "the entries the restored plugin already numbered are delivered");
  assert.equal(await cursor(), 1410);
  let status = ingest.status();
  assert.equal(status.state, "degraded");
  assert.equal(status.lastError, "knowledge_plugin_cursor_ahead");
  assert.equal(status.cursorAhead, true);
  assert.equal(status.rewinds.count, 1);
  assert.equal(status.rewinds.from, 2000);

  // What the restored plugin numbers from now on sits below the old cursor and used to be skipped.
  plugin.entries.push(...[1411, 1412, 1413].map((seq) => pluginEntry("nejm", seq)));
  const next = await ingest.pull();
  assert.equal(next.inserted, 3);
  assert.equal(next.rewound, undefined);
  status = ingest.status();
  assert.deepEqual([status.state, status.lastError, status.cursorAhead, status.rewinds.count], ["ok", null, false, 1], "caught up: the flag clears, the count stays");
  assert.equal(await cursor(), 1413);
  // A replay of what the platform already holds stores nothing twice.
  await database.query("UPDATE evimed_frontier.meta SET value='2000'::jsonb WHERE key='plugin_cursor'");
  const again = await ingest.pull();
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 13);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.entries")).rows[0].n, 13);
});

test("D-03: a replay the page budget splits stays flagged until the cursor has caught up, and starts at what the plugin still holds", options, async () => {
  await database.query("UPDATE evimed_frontier.meta SET value='2000'::jsonb WHERE key='plugin_cursor'");
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [5, 6, 7, 8, 9, 10].map((seq) => pluginEntry("nejm", seq)), oldest: 5 });
  const ingest = ingestFor(plugin, { pageLimit: 2, maxPagesPerPull: 1 });
  await ingest.mirrorSources();
  const first = await ingest.pull();
  assert.deepEqual(first.rewound, { from: 2000, to: 4 }, "from just below the oldest seq the plugin holds");
  assert.deepEqual(ingest.status().gaps, { count: 0, entries: 0 }, "a rewind is not a purge gap");
  assert.deepEqual([ingest.status().cursorAhead, ingest.status().lag, ingest.status().state], [true, 4, "degraded"]);
  await ingest.pull();
  assert.deepEqual([ingest.status().cursorAhead, ingest.status().lag, ingest.status().state], [true, 2, "degraded"]);
  await ingest.pull();
  assert.deepEqual([ingest.status().cursorAhead, ingest.status().lag, ingest.status().state, ingest.status().lastError], [false, 0, "ok", null]);
  assert.equal(ingest.status().rewinds.count, 1);
  assert.equal(await cursor(), 10);
});

test("D-03: a stale health answer, or one that a second control plane has already outrun, does not rewind a healthy cursor", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [1, 2, 3, 4, 5].map((seq) => pluginEntry("nejm", seq)) });
  const ingest = ingestFor(plugin, { pageLimit: 50 });
  await ingest.mirrorSources();
  await ingest.pull();
  assert.equal(ingest.status().latestSeq, 5);
  // The health read fails while the stream still answers: latestSeq stays at 5 as the cursor moves past it.
  plugin.entries.push(...[6, 7, 8, 9].map((seq) => pluginEntry("nejm", seq)));
  const fetchImpl = ingest.plugin.fetch;
  ingest.plugin.fetch = async (input, init) => {
    if (String(input).includes("/v1/health")) throw new TypeError("fetch failed");
    return fetchImpl(input, init);
  };
  assert.equal((await ingest.pull()).inserted, 4);
  assert.equal(await cursor(), 9);
  assert.equal(ingest.status().latestSeq, 5, "the last answer is stale");
  // The next pull finds the cursor (9) past that stale answer (5) and the health read still failing.
  assert.equal((await ingest.pull()).rewound, undefined);
  assert.equal(await cursor(), 9);
  assert.equal(ingest.status().rewinds.count, 0, "a stale answer is not evidence");
  ingest.plugin.fetch = fetchImpl;
  // The first health answer is behind the cursor (another control plane moved it a moment after the answer was read);
  // the second read, which a rewind needs, is not.
  plugin.entries.push(...[10, 11, 12].map((seq) => pluginEntry("nejm", seq)));
  let reads = 0;
  interceptHealth(ingest, (real) => (reads++ === 0 ? 3 : real));
  const pulled = await ingest.pull();
  assert.equal(reads, 2, "the suspicion was checked against a second answer");
  assert.equal(pulled.rewound, undefined);
  assert.equal(pulled.inserted, 3);
  assert.deepEqual([ingest.status().rewinds.count, ingest.status().cursorAhead, ingest.status().state], [0, false, "ok"]);
});

test("D-10: the plugin's host budget is kept from each health answer, and a plugin that does not say leaves no table", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [1, 2].map((seq) => pluginEntry("nejm", seq)) });
  const ingest = ingestFor(plugin, { pageLimit: 50 });
  await ingest.mirrorSources();
  await ingest.pull();
  assert.equal(ingest.status().pluginHealthDetail?.hostBudget, null, "not a table of zeros: a plugin of an older minor does not report it");
  plugin.hostBudget = { "api.crossref.org": { used: 2750, cap: 3000 }, "api.fda.gov": { used: 0, cap: 300 } };
  await ingest.pull();
  assert.deepEqual(ingest.status().pluginHealthDetail?.hostBudget, plugin.hostBudget);
  plugin.hostBudget = { "api.crossref.org": { used: 3000, cap: 3000 }, "api.fda.gov": { used: 0, cap: 300 } };
  await ingest.pull();
  assert.equal(ingest.status().pluginHealthDetail?.hostBudget?.["api.crossref.org"]?.used, 3000, "the spend moves with the plugin's own count");
  // ...and the metrics endpoint's families are made from exactly that status: the plugin's answer reaches the gauges the alert reads.
  const families = frontierMetricFamilies(true, { tables: null, composer: null, actions: null, editor: null, budget: { spentCny: 0, budgetCny: 10, state: "ok" },
    worker: { pipeline: {}, loops: {} }, client: { counters: { requests: 0, retries: 0, failures: 0 } }, service: {}, plugin: ingest.status() });
  const series = (/** @type {string} */ name) => families.find((family) => family.name === name)?.series;
  assert.deepEqual(series("open_science_frontier_plugin_host_budget_used"), [{ labels: { host: "api.crossref.org" }, value: 3000 }, { labels: { host: "api.fda.gov" }, value: 0 }]);
  assert.deepEqual(series("open_science_frontier_plugin_host_budget_cap"), [{ labels: { host: "api.crossref.org" }, value: 3000 }, { labels: { host: "api.fda.gov" }, value: 300 }]);
});

const entryRequests = (/** @type {ReturnType<typeof memoryPlugin>} */ plugin) => plugin.requests.filter((request) => request.path === "/v1/entries").map((request) => Number(request.query.limit));

test("D-17: a page over the client's response cap halves the page limit for the next request, and the limit comes back once a page is stored", options, async () => {
  // The review's page_probe: 200 entries with summaries of the contract's maximum 20,000 characters are about 12 MB of JSON, more
  // than the client's 8 MiB cap. The ingest asked for 500 every time, so the same request failed for ever: cursor 0, nothing stored,
  // and every source of the feed blocked behind the one page.
  const fat = "中".repeat(20_000);
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: Array.from({ length: 200 }, (_, index) => pluginEntry("nejm", index + 1, { summary: fat, language: "zh" })) });
  const ingest = ingestFor(plugin, { pageLimit: 500 });
  await ingest.mirrorSources();
  const pulled = await ingest.pull();
  assert.equal(pulled.inserted, 200);
  assert.equal(await cursor(), 200);
  // 500 and 250 both return all 200 (too large), 125 fits, and the page after it is asked for at the configured limit again.
  assert.deepEqual(entryRequests(plugin), [500, 250, 125, 500]);
  assert.equal(ingest.status().counters.pageShrinks, 2);
  assert.equal(ingest.status().state, "ok");
});

test("D-17: the page limit halves down to one entry and no further: a single entry over the cap still fails the pull, by its code", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1, { summary: "x".repeat(5_000) })] });
  const client = new KnowledgePluginClient({ baseUrl: "http://plugin.test:8080", tokenFile, fetchImpl: plugin.fetchImpl, sleep: async () => {}, maxResponseBytes: 2048 });
  const ingest = new FrontierIngest({ database, plugin: client, vocabulary: TEST_VOCABULARY, pageLimit: 500, pollMs: 1_000 });
  await ingest.mirrorSources();
  await assert.rejects(ingest.pull(), { code: "knowledge_plugin_response_too_large" });
  assert.deepEqual(entryRequests(plugin), [500, 250, 125, 62, 31, 15, 7, 3, 1], "nine requests, the last at one entry, then it stops");
  assert.equal(await cursor(), 0);
  assert.equal(ingest.status().lastError, "knowledge_plugin_response_too_large");
});

test("the defensive re-check drops unsafe rows with a reason and filters facts to the whitelist", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [
    pluginEntry("nejm", 1, { url: "javascript:alert(1)" }),
    pluginEntry("nejm", 2, { identity_key: "isbn:12345" }),
    pluginEntry("nejm", 3, { facts: { journal: "NEJM", contact_email: "someone@example.org", author_count: "many", is_masthead: true,
      update_to: [{ type: "retraction", doi: "10.1/x", date: "2026-09-01", extra: "dropped" }, "junk"] } }),
    { ...pluginEntry("nejm", 4, { backfill: true }), deliverBackfill: true },
  ] });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  await ingest.pull();
  const rows = (await database.query("SELECT plugin_seq, state, state_reason, facts FROM evimed_frontier.entries ORDER BY plugin_seq")).rows;
  assert.deepEqual(rows.map((row) => [Number(row.plugin_seq), row.state, row.state_reason]), [
    [1, "dropped", "url_scheme_invalid"], [2, "dropped", "identity_key_invalid"], [3, "received", null], [4, "backfill", null],
  ]);
  assert.deepEqual(rows[2].facts, { journal: "NEJM", is_masthead: true, update_to: [{ type: "retraction", doi: "10.1/x", date: "2026-09-01" }] });
  assert.equal(ingest.status().counters.dropped, 2);
  assert.ok(ingest.status().counters.factKeysDropped >= 2);
});

test("an entry from a source the registry does not list keeps its row under a placeholder source", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("ghost", 1), pluginEntry("nejm", 2)] });
  const ingest = ingestFor(plugin);
  const pulled = await ingest.pull();
  assert.equal(pulled.inserted, 2);
  const ghost = (await database.query("SELECT name, lane, source_type, plugin_health FROM evimed_frontier.sources WHERE id='ghost'")).rows[0];
  assert.deepEqual(ghost, { name: "ghost", lane: "mixed", source_type: "media", plugin_health: "degraded" });
  assert.equal(ingest.status().counters.placeholders, 1);
  // `nejm` was unknown too before the pull, and the one re-mirror brought it in.
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.sources WHERE id='nejm' AND registry_sha256 IS NOT NULL")).rows[0].n, 1);
  // The next hourly mirror retires the placeholder the plugin never listed.
  await ingest.mirrorSources();
  assert.ok((await database.query("SELECT retired_at FROM evimed_frontier.sources WHERE id='ghost'")).rows[0].retired_at);
});

test("the mirror keeps the platform's own switch, retires what the plugin dropped, and never retires from an incomplete list", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm"), pluginSource("jama"), pluginSource("bmj")], sourcePage: 2 });
  const ingest = ingestFor(plugin);
  assert.deepEqual(await ingest.mirrorSources(), { mirrored: 3, skipped: 0, retired: 0, complete: true });
  await database.query("UPDATE evimed_frontier.sources SET enabled=false WHERE id='jama'");
  plugin.sources = [pluginSource("nejm", { name: "NEJM (renamed)" }), pluginSource("jama")];
  const version = async () => Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key='content_version'")).rows[0].value);
  const before = await version();
  assert.equal((await ingest.mirrorSources()).retired, 1);
  assert.equal(await version(), before + 1, "a renamed source is a change a card shows");
  const rows = Object.fromEntries((await database.query("SELECT id, name, enabled, retired_at FROM evimed_frontier.sources")).rows.map((row) => [row.id, row]));
  assert.equal(rows.jama.enabled, false, "the platform's display override survives a mirror");
  assert.ok(rows.bmj.retired_at, "a source the plugin no longer lists is retired, not deleted");
  assert.equal(rows.nejm.name, "NEJM (renamed)");

  // A row the client cannot read makes the list incomplete: nothing is retired.
  plugin.sources = [pluginSource("nejm"), { name: "no id" }];
  const partial = await ingest.mirrorSources();
  assert.equal(partial.complete, false);
  assert.equal(partial.retired, 0);
  assert.equal((await database.query("SELECT retired_at FROM evimed_frontier.sources WHERE id='jama'")).rows[0].retired_at, null);

  // And it comes back from retirement when the plugin lists it again.
  plugin.sources = [pluginSource("nejm"), pluginSource("jama"), pluginSource("bmj")];
  await ingest.mirrorSources();
  assert.equal((await database.query("SELECT retired_at FROM evimed_frontier.sources WHERE id='bmj'")).rows[0].retired_at, null);
});

test("enabled follows the plugin's own switch and keeps the platform's display switch otherwise", options, async () => {
  // fr-sources 2026-10-22: the mirror said 753 sources were on while the plugin polled 521.
  const plugin = memoryPlugin({ sources: [pluginSource("nejm"), pluginSource("planned", { enabled: false, health: "disabled" }), pluginSource("jama")] });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  const enabled = async () => Object.fromEntries((await database.query("SELECT id, enabled, plugin_enabled FROM evimed_frontier.sources")).rows
    .map((row) => [row.id, [row.enabled, row.plugin_enabled]]));
  assert.deepEqual(await enabled(), { nejm: [true, true], planned: [false, false], jama: [true, true] }, "a row the plugin never polls is off from the start");

  // The platform's display switch stands while the plugin's does not move.
  await database.query("UPDATE evimed_frontier.sources SET enabled=false WHERE id='jama'");
  await ingest.mirrorSources();
  assert.deepEqual((await enabled()).jama, [false, true]);

  // The plugin turns a source on or off: the mirror follows.
  plugin.sources = [pluginSource("nejm", { enabled: false, health: "disabled" }), pluginSource("planned"), pluginSource("jama")];
  await ingest.mirrorSources();
  const after = await enabled();
  assert.deepEqual(after.nejm, [false, false]);
  assert.deepEqual(after.planned, [true, true]);
  assert.deepEqual(after.jama, [false, true], "the display switch is untouched when the plugin's does not change");

  // A row mirrored before the column existed: off if either side says off, on only if both do.
  await database.query("UPDATE evimed_frontier.sources SET plugin_enabled = NULL, enabled = true");
  plugin.sources = [pluginSource("nejm", { enabled: false, health: "disabled" }), pluginSource("planned"), pluginSource("jama")];
  await database.query("UPDATE evimed_frontier.sources SET enabled = false WHERE id = 'planned'");
  await ingest.mirrorSources();
  assert.deepEqual(await enabled(), { nejm: [false, false], planned: [false, true], jama: [true, true] });
});

test("after the mirror the screen's verdicts per source go back to the plugin", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm"), pluginSource("techfeed")],
    entries: [1, 2, 3, 4, 5, 6].map((seq) => pluginEntry(seq <= 2 ? "nejm" : "techfeed", seq)) });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  await ingest.pull();
  // What the screen decided, as the pipeline records it.
  await database.query(`UPDATE evimed_frontier.entries SET state = CASE
      WHEN source_id = 'nejm' THEN 'promoted'
      WHEN plugin_seq = 3 THEN 'screened-out' ELSE 'screened-out' END,
    state_reason = CASE WHEN source_id = 'techfeed' AND plugin_seq < 6 THEN 'not-medical' WHEN source_id = 'techfeed' THEN 'not-news' ELSE NULL END`);
  await ingest.mirrorSources();
  assert.equal(plugin.screening.window_days, 14);
  assert.deepEqual(plugin.screening.sources, [{ id: "nejm", screened: 2, off_topic: 0, selected: 0 }, { id: "techfeed", screened: 4, off_topic: 3, selected: 0 }]);
  assert.equal(ingest.counters.screeningReports, 1);

  // A plugin without the route costs the report only: the mirror itself succeeds.
  plugin.fetchImpl = ((original) => async (/** @type {any} */ input, /** @type {any} */ init) => (String(input).endsWith("/v1/sources/screening")
    ? new Response(JSON.stringify({ code: "not_found", message: "x", retryable: false }), { status: 404 }) : original(input, init)))(plugin.fetchImpl);
  const failing = ingestFor(plugin);
  assert.equal((await failing.mirrorSources()).complete, true);
  assert.equal(failing.counters.screeningReportFailures, 1);
});

test("an incompatible contract is recorded and nothing is pulled until it is compatible again", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1)], contract: "2.0.0" });
  const ingest = ingestFor(plugin);
  const skipped = await ingest.pull();
  assert.deepEqual(skipped, { skipped: "incompatible", contract: "2.0.0" });
  assert.equal(plugin.requests.filter((request) => request.path === "/v1/entries").length, 0, "an incompatible stream is not consumed");
  assert.equal(ingest.status().state, "incompatible");
  const stored = (await database.query("SELECT value FROM evimed_frontier.meta WHERE key='plugin_manifest'")).rows[0].value;
  assert.equal(stored.compatible, false);
  assert.equal(stored.manifest.contract.version, "2.0.0");

  plugin.contract = "1.1.0";
  const pulled = await ingest.pull();
  assert.equal(pulled.inserted, 1);
  assert.equal(ingest.status().state, "ok");
  assert.equal(ingest.status().contract, "1.1.0");
});

test("a second puller that moved the cursor first wins; this page is discarded, not written backwards", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [1, 2].map((seq) => pluginEntry("nejm", seq)) });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  const fetchImpl = plugin.fetchImpl;
  ingest.plugin.fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    // The other control plane commits its own copy of this page meanwhile.
    if (String(input).includes("/v1/entries")) await database.query("UPDATE evimed_frontier.meta SET value='2'::jsonb WHERE key='plugin_cursor'");
    return response;
  };
  await ingest.pull();
  assert.equal(ingest.status().counters.cursorConflicts, 1);
  assert.equal(await cursor(), 2);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.entries")).rows[0].n, 0);
});

test("whitelistFacts keeps the contract's keys with their types and names what it dropped", () => {
  assert.deepEqual(whitelistFacts({ journal: " NEJM ", wx_original: "yes", phone: "123", trial_event: "results-posted" }),
    { facts: { journal: "NEJM", trial_event: "results-posted" }, dropped: ["wx_original", "phone"] });
  assert.deepEqual(whitelistFacts(null), { facts: {}, dropped: [] });
});

test("the facts whitelist is the domain's, key for key", () => {
  // A key the contract (and the domain) adds but this module forgets would be
  // dropped from every entry without a word.
  assert.deepEqual(Object.keys(FRONTIER_FACT_RULES).sort(), [...FRONTIER_FACT_KEYS].sort());
});

test("defects the vocabulary does not know are dropped and counted", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1, { defects: ["no-date", "made-up-defect"] })] });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  await ingest.pull();
  assert.deepEqual((await database.query("SELECT defects FROM evimed_frontier.entries")).rows[0].defects, ["no-date"]);
  assert.equal(ingest.status().unknownVocabulary.defect, 1);
});

// fr-social 2026-10-22: contract 1.5.0 — a social post's fields are stored on the entry; unknown vocabulary is null and counted.
test("a post's channel, platform, author, media, quote and counts are stored on its entry; an unknown channel is counted, not dropped", options, async () => {
  const photo = { id: "b".repeat(64), kind: "image", width: 800, height: 600, alt: null, original_url: "https://pbs.twimg.com/media/a.jpg" };
  const plugin = memoryPlugin({ sources: [pluginSource("x-us_fda"), pluginSource("nejm")], entries: [
    pluginEntry("x-us_fda", 1, { channel: "x", platform: "x", author: { name: "U.S. FDA", handle: "US_FDA", url: "https://x.com/US_FDA", role: "organisation" },
      media: [photo], quoted: { author: { name: "FDA Drug Info", handle: "FDA_Drug_Info" }, text: "Label update.", url: "https://x.com/FDA_Drug_Info/status/1" },
      metrics: { likes: 120, replies: 4, observed_at: "2026-10-22T06:00:00Z" } }),
    pluginEntry("nejm", 2, { channel: "podcast", platform: "myspace" }),
    pluginEntry("nejm", 3),
  ] });
  const ingest = ingestFor(plugin);
  await ingest.mirrorSources();
  await ingest.pull();
  const rows = (await database.query("SELECT source_id, plugin_seq, channel, platform, author, media, quoted, metrics FROM evimed_frontier.entries ORDER BY plugin_seq")).rows;
  assert.equal(rows[0].channel, "x");
  assert.equal(rows[0].platform, "x");
  assert.deepEqual(rows[0].author, { name: "U.S. FDA", handle: "US_FDA", url: "https://x.com/US_FDA", role: "organisation" });
  assert.deepEqual(rows[0].media, [photo]);
  assert.equal(rows[0].quoted.author.handle, "FDA_Drug_Info");
  assert.deepEqual(rows[0].metrics, { likes: 120, reposts: null, replies: 4, views: null, observed_at: "2026-10-22T06:00:00.000Z" });
  assert.deepEqual([rows[1].channel, rows[1].platform], [null, null], "a channel the domain does not know is stored as unknown");
  assert.equal(ingest.status().unknownVocabulary.channel, 1);
  assert.equal(ingest.status().unknownVocabulary.platform, 1);
  assert.deepEqual([rows[2].channel, rows[2].author, rows[2].media, rows[2].metrics], [null, null, [], null], "an older entry has none of them");
});
