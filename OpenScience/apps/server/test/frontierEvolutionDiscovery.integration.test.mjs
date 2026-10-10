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
  // The entries this test owns are cleared first, so that it can be run again against the same database.
  await db.query("DELETE FROM evimed_frontier.entries WHERE plugin_entry_id LIKE 'evo-%'");
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
  // A feed date not after the freeze cannot be fresh; an undated entry is still read.
  const dated = [];
  for (const [key, published] of [["evo-dated-old", "2033-04-01T00:00:00Z"], ["evo-dated-new", "2033-05-02T00:00:00Z"]]) {
    const inserted = await db.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url,
        title_raw, summary_raw, published_at, first_seen_at, received_at, content_sha256)
      VALUES ($1,$2,'evo-journal',$1,$3,$3,$1,$1,$4,$5,$5,$6) RETURNING id`,
      [key, 100 + dated.length, `https://example.org/${key}`, published, new Date(base + 10_000), createHash("sha256").update(key).digest("hex")]);
    dated.push(String(inserted.rows[0].id));
  }
  const fresh = await discovery.discover({ since: new Date(base + 9_000).toISOString(), limit: 100, discovery: "exclude", publishedAfter: "2033-04-30T00:00:00.000Z" });
  assert.deepEqual(fresh.map((entry) => entry.id), [dated[1]]);
  const undated = await discovery.discover({ since, limit: 100, discovery: "exclude", publishedAfter: "2033-04-30T00:00:00.000Z" });
  assert.deepEqual(undated.map((entry) => entry.id), [...medical, dated[1]]);
  // Without a cursor the read keeps its old meaning: everything after the instant.
  assert.deepEqual((await discovery.discover({ since: new Date(base + 1000).toISOString(), limit: 100, discovery: "exclude" })).map((entry) => entry.id), [...medical.slice(4), ...dated]);
});

test("the AI discovery channel is the plugin's ai-discovery rows, the self-research channel adds the shared lab feeds, and the medical channel has neither", options, async () => {
  const db = /** @type {ControlPlaneDatabase} */ (database);
  try {
    await migrateFrontier(db, { dimension: 1024 });
    await db.query("DELETE FROM evimed_frontier.entries WHERE plugin_entry_id LIKE 'evo2-%'");
    await db.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region, plugin_health, enabled, last_ok_at) VALUES
      ('evo2-journal','Journal','evidence','journal','rss','direct',3,false,'J','P0','US','healthy',true,NULL),
      ('ai-discovery-arxiv-agents-memory','arXiv agents and memory','ai','preprint','atom','direct',2,false,'arXiv','P0','US','healthy',true,'2034-01-01T00:00:00Z'),
      ('ai-discovery-hf-daily-papers','Daily Papers','ai','preprint','json-api','relay',2,false,'Hugging Face','P0','US','new',false,NULL),
      ('openai-news','OpenAI news','ai','company','rss','direct',2,false,'OpenAI','P0','US','degraded',true,NULL),
      ('lookalike-ai-discovery','Not the channel','ai','company','rss','direct',2,false,'X','P0','US','healthy',true,NULL) ON CONFLICT (id) DO NOTHING`);
    const base = Date.parse("2034-01-01T00:00:00.000Z");
    const rows = [["evo2-journal", {}], ["ai-discovery-arxiv-agents-memory", {}], ["openai-news", {}], ["ai-discovery-hf-daily-papers", {}], ["lookalike-ai-discovery", {}], ["evo2-journal", { discovery_only: true }]];
    const ids = [];
    for (const [index, [source, facts]] of rows.entries()) {
      const key = `evo2-discovery-${index}`;
      const inserted = await db.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url, doi,
          title_raw, summary_raw, facts, published_at, first_seen_at, received_at, content_sha256)
        VALUES ($1,$2,$3,$1,$4,$4,$5,$6,$7,$8::jsonb,$9,$10,$10,$11) RETURNING id`,
        [key, 1000 + index, source, `https://example.org/${key}`, `10.48550/arxiv.2601.0000${index}`, `Entry ${index}`, `Summary ${index}`, JSON.stringify(facts),
          new Date(base - 86_400_000), new Date(base + index * 1000), createHash("sha256").update(key).digest("hex")]);
      ids.push(String(inserted.rows[0].id));
    }
    const discovery = createFrontierEvolutionDiscovery({ database: db });
    const since = new Date(base - 1000).toISOString();
    const read = async (/** @type {any} */ channel) => (await discovery.discover({ since, limit: 100, discovery: channel })).map((entry) => entry.id);
    assert.deepEqual(await read("only"), [ids[1], ids[3], ids[5]], "the rows that exist for self-research, and an entry marked in its facts; not a row that merely contains the words");
    assert.deepEqual(await read("self-research"), [ids[1], ids[2], ids[3], ids[5]], "and the lab feed the medical feed also reads");
    assert.deepEqual(await read("exclude"), [ids[0], ids[2], ids[4]], "the medical channel keeps the lab feed, and loses the discovery rows");
    assert.equal((await read("any")).length, rows.length);

    const [first] = await discovery.discover({ since, limit: 1, discovery: "self-research" });
    assert.equal(first.sourceId, "ai-discovery-arxiv-agents-memory");
    assert.equal(first.publishedAt, new Date(base - 86_400_000).toISOString());
    assert.equal(first.receivedAt, new Date(base + 1000).toISOString());
    assert.equal(first.doi, "10.48550/arxiv.2601.00001");
    assert.ok(first.identityKey);

    // The mirror the funnel counts sources from: the discovery rows and the lab feeds, with how the plugin finds them.
    const sources = await discovery.sources();
    assert.deepEqual(sources.filter((source) => source.id.endsWith("-news") || source.id.startsWith("ai-discovery-")).map((source) => [source.id, source.enabled, source.health]), [
      ["ai-discovery-arxiv-agents-memory", true, "healthy"], ["ai-discovery-hf-daily-papers", false, "new"], ["openai-news", true, "degraded"]]);
    assert.equal(sources.some((source) => source.id === "lookalike-ai-discovery" || source.id === "evo2-journal"), false);
    assert.equal(sources.find((source) => source.id === "ai-discovery-arxiv-agents-memory")?.lastOkAt, "2034-01-01T00:00:00.000Z");
  } finally {
    // Its entries sit later in time than the other test's reads; they are not left for the next run to find.
    await db.query("DELETE FROM evimed_frontier.entries WHERE plugin_entry_id LIKE 'evo2-%'");
  }
});
