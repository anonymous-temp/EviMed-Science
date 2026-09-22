// The worker against a real PostgreSQL: one tick pulls the plugin into the
// tables and hands the pipeline its batch, and the hourly retention removes
// exactly what the plan says it may.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierIngest } from "../src/frontierIngest.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierWorker } from "../src/frontierWorker.mjs";
import { KnowledgePluginClient } from "../src/knowledgePluginClient.mjs";
import { TEST_VOCABULARY, insertSource, memoryPlugin, pluginEntry, pluginSource, sha256 } from "./helpers/frontierFixtures.mjs";

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
  dir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-worker-"));
  tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, "test-only-worker-token\n", { mode: 0o600 });
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
});

after(async () => {
  await database?.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await database.query("DELETE FROM evimed_frontier.item_changes");
  await database.query("DELETE FROM evimed_frontier.hot_snapshots");
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key='plugin_cursor'");
});

test("one tick pulls the plugin into the tables and runs the pipeline's batches", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [1, 2, 3].map((seq) => pluginEntry("nejm", seq)) });
  const client = new KnowledgePluginClient({ baseUrl: "http://plugin.test:8080", tokenFile, fetchImpl: plugin.fetchImpl, sleep: async () => {} });
  const ingest = new FrontierIngest({ database, plugin: client, vocabulary: TEST_VOCABULARY });
  let batches = 0;
  const pipeline = { async processBatch() { batches += 1; return { claimed: 0, promoted: 0, published: 0, merged: 0, screenedOut: 0, held: 0, failed: 0 }; } };
  const worker = new FrontierWorker({ ingest, pipeline, database, concurrency: 2 });
  await worker.tick();
  const stored = await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.entries WHERE state='received'");
  assert.equal(stored.rows[0].n, 3);
  assert.equal(batches, 2);
  assert.equal(worker.status().loops.pull.lastError, null);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.sources")).rows[0].n, 1);
});

test("the retention pass removes what produced nothing after 30 days and the logs after 90, and nothing else", options, async () => {
  await insertSource(database, "nejm");
  const now = Date.parse("2026-09-22T04:00:00Z");
  const daysAgo = (days) => new Date(now - days * 86_400_000).toISOString();
  let serial = 0;
  const entry = async (state, age) => {
    serial += 1;
    await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url,
        title_raw, first_seen_at, content_sha256, state, received_at)
      VALUES ($1, $2, 'nejm', $3, 'https://nejm.example.org/x', 'https://nejm.example.org/x', 'x', $4, $5, $6, $4)`,
    [`nejm:${sha256(String(serial)).slice(0, 32)}`, serial, `url:${sha256(String(serial))}`, daysAgo(age), sha256(`c${serial}`), state]);
  };
  for (const state of ["screened-out", "dropped", "backfill", "failed"]) {
    await entry(state, 31);
    await entry(state, 29);
  }
  for (const state of ["received", "held", "merged", "promoted"]) await entry(state, 45);
  await database.query(`INSERT INTO evimed_frontier.item_changes (item_id, op, reason, changed_at) VALUES (1, 'upsert', 'published', $1), (2, 'remove', 'withdrawn', $2)`,
    [daysAgo(91), daysAgo(89)]);
  await database.query(`INSERT INTO evimed_frontier.hot_snapshots (taken_at, ranking) VALUES ($1, '[]'::jsonb), ($2, '[]'::jsonb)`, [daysAgo(91), daysAgo(1)]);
  const worker = new FrontierWorker({ ingest: { plugin: { configured: false } }, database, now: () => new Date(now) });
  assert.deepEqual(await worker.cleanup(), { entries: 4, itemChanges: 1, hotSnapshots: 1 });
  const left = (await database.query("SELECT state, count(*)::integer AS n FROM evimed_frontier.entries GROUP BY state ORDER BY state")).rows;
  assert.deepEqual(Object.fromEntries(left.map((row) => [row.state, row.n])),
    { backfill: 1, dropped: 1, failed: 1, held: 1, merged: 1, promoted: 1, received: 1, "screened-out": 1 },
    "young rows and every row behind an item stay");
  assert.deepEqual(await worker.cleanup(), { entries: 0, itemChanges: 0, hotSnapshots: 0 }, "a second pass finds nothing left");
});
