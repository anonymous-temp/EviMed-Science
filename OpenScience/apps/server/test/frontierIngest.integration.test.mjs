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
