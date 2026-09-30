import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierPipeline, entryKeys } from "../src/frontierPipeline.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";

// The plugin's fixture-replay test re-generates these DTOs through normalize.prepare.
const fixture = JSON.parse(readFileSync(new URL("../../../../项目代码/knowledge-plugin/tests/fixtures/source-expansion-20260930/normalized-fda-table.json", import.meta.url), "utf8"));
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /^\/evimed_test(?:[_-][A-Za-z0-9_-]+)?$/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const operator = `fda_table_${randomUUID()}`;
const owner = { userId: operator, projectId: "evimed-frontier" };
let database;
let userCreated = false;
let frontierReady = false;

async function cleanFixture() {
  // Keep the real prepared DTO identities; this fixture owns this source only.
  await database.transaction(async (client) => {
    await client.query("DELETE FROM evimed_frontier.entries WHERE source_id=$1", [fixture.source.id]);
    await client.query("DELETE FROM evimed_frontier.items WHERE primary_source_id=$1", [fixture.source.id]);
    await client.query("DELETE FROM evimed_frontier.sources WHERE id=$1", [fixture.source.id]);
  });
}

async function fixtureItemCount() {
  return Number((await database.query("SELECT count(*) FROM evimed_frontier.items WHERE primary_source_id=$1", [fixture.source.id])).rows[0].count);
}

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 2_000 });
  await database.migrate();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'FDA table test','development')", [operator]);
  userCreated = true;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Frontier',1048576)", [operator, owner.projectId]);
  await migrateUsageLedger(database);
  await migrateFrontier(database, { dimension: 16 });
  frontierReady = true;
  await cleanFixture();
  const source = fixture.source;
  await database.query(`INSERT INTO evimed_frontier.sources(id,name,lane,source_type,access,egress,authority,safety_feed,owner_entity,launch_tier,region)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [source.id, source.name, source.lane, source.source_type, source.access,
    source.egress, source.authority, source.safety_feed, source.owner_entity, source.launch_tier, source.region]);
});

after(async () => {
  if (!database) return;
  try {
    if (frontierReady) await cleanFixture();
  } finally {
    try {
      if (userCreated) await database.query("DELETE FROM evimed_control.users WHERE id=$1", [operator]);
    } finally {
      await database.close();
    }
  }
});

async function deliver(entry, seq, revision = 1) {
  await database.query(`INSERT INTO evimed_frontier.entries(plugin_entry_id,plugin_seq,revision,source_id,identity_key,url,canonical_url,
    doi,pmid,registry_ids,title_raw,summary_raw,facts,lang,published_at,date_precision,first_seen_at,content_sha256,backfill,defects,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'2026-09-30T00:00:00Z',$17,false,$18,'received')
    ON CONFLICT(plugin_entry_id,revision) DO NOTHING`,
  [entry.entry_id, seq, revision, entry.source_id, entry.identity_key, entry.url, entry.canonical_url, entry.doi, entry.pmid,
    entry.registry_ids, entry.title, entry.summary, JSON.stringify(entry.facts), entry.language, entry.raw_published_at,
    entry.raw_precision, entry.content_sha256, entry.defects]);
}

test("prepared FDA rows survive shared-page dedupe, revisions and duplicate stories", options, async () => {
  assert.equal(new Set(fixture.entries.map((entry) => entry.canonical_url)).size, 1);
  assert.equal(new Set(fixture.entries.flatMap((entry) => entryKeys(entry).dedupe)).size, 44);
  const editor = {
    owner, available: true,
    async screen(inputs) {
      return { verdicts: new Map(inputs.map((input) => [input.key, { medical: true, news: true, lane: "regulatory", specialties: [], language: "en", digest: false }])), errors: new Map(), calls: 1 };
    },
    async edit(item) {
      const modelInput = buildModelInput(item);
      return { verification: "passed", modelInput, modelInputSha256: sha256(modelInput), attempts: 1, issues: [], numbers: null,
        error: null, model: "test", editorVersion: FRONTIER_EDITOR_VERSION, output: {
          titleZh: item.titleRaw, summaryZh: "FDA source table record.", reasonZh: "Regulatory record.", lane: "regulatory", specialties: [],
          evidenceType: "regulatory-decision", entities: { drugs: [], trials: [], orgs: [], diseases: [] },
          scores: { impact: 20, novelty: 10, relevance: 10 }, flags: [],
        } };
    },
  };
  const pipeline = new FrontierPipeline({ database, editor,
    plugin: { async text(entryId) { return { entry_id: entryId, revision: 1, status: "unavailable", abstract: null, body_excerpt: null, enrichment: {} }; } },
    embedder: { configured: false }, glossary: new FrontierGlossary([]), workerId: operator,
    now: () => new Date("2026-09-30T00:00:00Z"),
    config: { kbEmbeddingDimension: 16, frontierTimeZone: "UTC", frontierDailyBudgetCny: 10, frontierSelectThreshold: 70 },
  });
  for (const [index, entry] of fixture.entries.entries()) await deliver(entry, index + 1);
  for (let index = 0; index < 4; index += 1) await pipeline.processBatch();
  const beforeRows = (await database.query("SELECT plugin_entry_id,item_id FROM evimed_frontier.entries WHERE source_id=$1 ORDER BY plugin_entry_id", [fixture.source.id])).rows;
  assert.equal(new Set(beforeRows.map((row) => row.item_id)).size, 44);
  assert.ok(beforeRows.every((row) => row.item_id !== null));
  assert.equal(await fixtureItemCount(), 44);
  await deliver(fixture.updated, 100, 2);
  await pipeline.processBatch();
  const revised = (await database.query("SELECT item_id,revision FROM evimed_frontier.entries WHERE source_id=$1 AND plugin_entry_id=$2 AND revision=2", [fixture.source.id, fixture.updated.entry_id])).rows[0];
  assert.equal(revised.item_id, beforeRows.find((row) => row.plugin_entry_id === fixture.updated.entry_id).item_id);
  assert.equal(Number(revised.revision), 2);
  assert.equal(await fixtureItemCount(), 44);
  const repeated = { ...fixture.entries[0], title: `${fixture.entries[0].title}: ${fixture.entries[0].summary}`,
    entry_id: "fda-novel-drug-approvals:00000000000000000000000000000000", identity_key: "fda:novel-approvals:0000000000000000000000000000000000000000" };
  await deliver(repeated, 101);
  await pipeline.processBatch();
  await deliver({ ...repeated, entry_id: "fda-novel-drug-approvals:11111111111111111111111111111111",
    identity_key: "fda:novel-approvals:1111111111111111111111111111111111111111" }, 102);
  await pipeline.processBatch();
  assert.equal(await fixtureItemCount(), 45,
    "event keys preserve distinct records without disabling duplicate-title consolidation");
});
