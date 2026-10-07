// 循证进化 reads the frontier's entries in arrival order, resuming from the cursor its last read returned
// (moduleEvolutionCurator, 2026-10-07), and keeps the AI discovery channel apart from the medical feed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createFrontierEvolutionDiscovery } from "../src/frontierEvolution.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const database = databaseUrl ? new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 }) : null;
after(async () => { await database?.close(); });

test("a read resumes after its cursor, ties on the arrival instant included, and the AI discovery channel is read apart", options, async () => {
  const db = /** @type {ControlPlaneDatabase} */ (database);
  await migrateFrontier(db, { dimension: 1024 });
  await db.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region) VALUES
    ('evo-journal','Journal','evidence','journal','rss','direct',3,false,'J','P0','US'),
    ('arxiv-agent-self-improvement','arXiv agents','ai','preprint','api','direct',2,false,'arXiv','P2','US') ON CONFLICT (id) DO NOTHING`);
  const base = Date.parse("2033-05-01T00:00:00.000Z");
  // Seven medical entries, three of them arriving at one instant; two AI entries, one of them marked in its facts.
  const rows = [
    ["evo-journal", 0, {}], ["evo-journal", 1, {}], ["evo-journal", 1, {}], ["evo-journal", 1, {}],
    ["arxiv-agent-self-improvement", 2, {}], ["evo-journal", 3, { discovery_only: true }],
    ["evo-journal", 4, {}], ["evo-journal", 5, {}], ["evo-journal", 6, {}],
  ];
  const ids = [];
  for (const [index, [source, offset, facts]] of rows.entries()) {
    const key = `evo-discovery-${index}`;
    const inserted = await db.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url,
        title_raw, summary_raw, facts, first_seen_at, received_at, content_sha256)
      VALUES ($1,$2,$3,$1,$4,$4,$5,$6,$7::jsonb,$8,$8,$9) RETURNING id`,
      [key, index + 1, source, `https://example.org/${key}`, `Entry ${index}`, `Summary ${index}`, JSON.stringify(facts),
        new Date(base + Number(offset) * 1000), createHash("sha256").update(key).digest("hex")]);
    ids.push(String(inserted.rows[0].id));
  }
  const discovery = createFrontierEvolutionDiscovery({ database: db });
  const since = new Date(base - 1000).toISOString();
  const medical = [0, 1, 2, 3, 6, 7, 8].map((index) => ids[index]);

  const first = await discovery.discover({ since, limit: 2, discovery: "exclude" });
  assert.deepEqual(first.map((entry) => entry.id), medical.slice(0, 2));
  const cursor = first.at(-1)?.cursor;
  assert.equal(cursor?.id, medical[1]);
  // The cursor sits inside the three entries of one instant: the next read takes the other two and nothing again.
  const second = await discovery.discover({ since: cursor.receivedAt, afterId: cursor.id, limit: 3, discovery: "exclude" });
  assert.deepEqual(second.map((entry) => entry.id), medical.slice(2, 5));
  const rest = await discovery.discover({ since: second.at(-1).cursor.receivedAt, afterId: second.at(-1).cursor.id, limit: 100, discovery: "exclude" });
  assert.deepEqual(rest.map((entry) => entry.id), medical.slice(5));
  assert.equal(new Set([...first, ...second, ...rest].map((entry) => entry.id)).size, medical.length);

  assert.deepEqual((await discovery.discover({ since, limit: 100, discovery: "only" })).map((entry) => entry.id), [ids[4], ids[5]]);
  assert.equal((await discovery.discover({ since, limit: 100 })).length, rows.length, "without a channel every entry is read");
  // Without a cursor the read keeps its old meaning: everything after the instant.
  assert.deepEqual((await discovery.discover({ since: new Date(base + 1000).toISOString(), limit: 100, discovery: "exclude" })).map((entry) => entry.id), medical.slice(4));
});
