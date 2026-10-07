// The frontier pipeline's notices as source changes (plan 2026-10-05 B5): a retraction, correction, concern or withdrawal
// notice that links a work in `evimed_frontier.item_links` is also recorded in the one source-change record, once the link
// is committed — and a record that is absent or cannot be written costs the pipeline nothing.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { createSourceChanges } from "../src/sourceChanges.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const DIMENSION = 16;
const operator = `frontier_source_change_op_${randomUUID()}`;
const platformAccount = `frontier_source_change_platform_${randomUUID()}`;
const secondPlatformAccount = `frontier_source_change_platform_${randomUUID()}`;
/** @type {any} */ let database; /** @type {any} */ let documents;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 2_000 });
  for (const id of [operator, platformAccount, secondPlatformAccount]) await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Frontier source change','development')", [id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
  await migrateUsageLedger(database);
  await migrateFrontier(database, { dimension: DIMENSION });
  await migrateProductStore(database);
  documents = new ProductDocuments(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[operator, platformAccount, secondPlatformAccount]]);
  await database.close();
});

let seq = 0;
/** @param {Record<string, any>} values */
async function deliver(values) {
  seq += 1;
  const canonical = `https://example.org/${values.source_id}/${seq}`;
  const identity = `doi:${values.doi.toLowerCase()}`;
  const result = await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url,
      doi, registry_ids, title_raw, facts, lang, first_seen_at, content_sha256, backfill, defects, state)
    VALUES ($1,$2,1,$3,$4,$5,$5,$6,'{}',$7,$8::jsonb,'en',$9,$10,false,'{}','received') RETURNING id`,
  [`${values.source_id}:${createHash("sha256").update(`${identity}:${seq}`).digest("hex").slice(0, 32)}`, 900000 + seq, values.source_id, identity, canonical,
    values.doi, values.title, JSON.stringify(values.facts), new Date("2026-09-22T10:00:00Z"), createHash("sha256").update(`${seq}`).digest("hex")]);
  return Number(result.rows[0].id);
}

async function reset() {
  await database.query(`TRUNCATE evimed_frontier.item_vectors, evimed_frontier.item_texts, evimed_frontier.item_keys, evimed_frontier.item_mentions,
    evimed_frontier.item_links, evimed_frontier.item_changes, evimed_frontier.user_state, evimed_frontier.event_items, evimed_frontier.items,
    evimed_frontier.entries, evimed_frontier.sources, evimed_frontier.glossary, evimed_frontier.dailies RESTART IDENTITY CASCADE`);
  await database.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region)
    VALUES ('j-nejm','NEJM','evidence','journal','crossref-issn','api',5,false,'MMS','P0','US')`);
}

/** A pipeline that only ever meets notices: the editor and the plugin are never asked for anything. */
function pipelineWith(sourceChanges) {
  const editor = { owner: { userId: operator, projectId: "evimed-frontier" }, available: true,
    async screen() { throw new Error("a notice is not screened"); }, async edit() { throw new Error("a notice is not edited"); } };
  const plugin = { async text() { throw new Error("a notice has no text"); } };
  return new FrontierPipeline({ database, editor, plugin, embedder: null, sourceChanges, now: () => new Date("2026-09-22T12:00:00Z"), workerId: `test-${randomUUID()}`,
    glossary: new FrontierGlossary([]), config: { kbEmbeddingDimension: DIMENSION, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 10 } });
}

const entryOf = async (/** @type {number} */ id) => (await database.query("SELECT state, state_reason FROM evimed_frontier.entries WHERE id=$1", [id])).rows[0];

test("Postgres: each kind of notice the pipeline links is recorded as a change of the work it names, with the notice's own DOI and date", options, async () => {
  await reset();
  const store = createSourceChanges({ documents, ownerUserId: platformAccount });
  const notices = {
    retraction: { doi: "10.1056/NEJMx22", work: "10.1056/NEJMoa1000003", type: "retraction", date: "2026-09-22" },
    correction: { doi: "10.1056/NEJMx21", work: "10.1056/NEJMoa1000002", type: "erratum", date: "2026-09-21" },
    concern: { doi: "10.1056/NEJMx23", work: "10.1056/NEJMoa1000004", type: "expression_of_concern", date: null },
    withdrawal: { doi: "10.1056/NEJMx24", work: "10.1056/NEJMoa1000005", type: "withdrawal", date: "2026-09-20" },
  };
  const delivered = {};
  for (const [kind, notice] of Object.entries(notices)) {
    delivered[kind] = await deliver({ source_id: "j-nejm", doi: notice.doi, title: `Notice: ${kind}`,
      facts: { is_correction_notice: true, update_to: [{ type: notice.type, doi: notice.work, ...(notice.date ? { date: notice.date } : {}) }] } });
  }
  await pipelineWith(store).processBatch();

  for (const [kind, notice] of Object.entries(notices)) {
    const fact = await store.get(notice.work);
    assert.equal(fact.state, "changed", kind);
    assert.deepEqual(fact.changes.map(change => [change.kind, change.noticeIdentifier, change.date, change.assertedBy]), [[kind, notice.doi.toLowerCase(), notice.date, ["crossref"]]], kind);
    assert.equal((await entryOf(delivered[kind])).state, "dropped", "the notice is dropped from the feed as it always was");
  }
  const links = (await database.query("SELECT count(*)::int AS n FROM evimed_frontier.item_links")).rows[0].n;
  assert.equal(links, 4, "and the frontier's own relation is kept");
  assert.equal((await store.changedSince(0, 10)).items.length, 4, "four works, announced on the feed");
  assert.equal(store.stats().recorded.crossref, 4);
});

test("Postgres: a notice that names no work records nothing, and a pipeline without a record, or with one that cannot be written, finishes its notices as before", options, async () => {
  await reset();
  const store = createSourceChanges({ documents, ownerUserId: secondPlatformAccount });
  const unlinked = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx31", title: "Correction: nothing to link", facts: { is_correction_notice: true, update_to: [] } });
  await pipelineWith(store).processBatch();
  assert.deepEqual((await entryOf(unlinked)).state, "dropped");
  assert.equal((await store.changedSince(0, 10)).items.length, 0);

  const bare = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx32", title: "Retraction: without a record", facts: { update_to: [{ type: "retraction", doi: "10.1056/NEJMoa1000032" }] } });
  await pipelineWith(null).processBatch();
  assert.equal((await entryOf(bare)).state, "dropped");
  assert.equal((await store.get("10.1056/NEJMoa1000032")).state, "unknown", "no record was given, so nothing was written");

  const broken = createSourceChanges({ documents, ownerUserId: () => null });
  const failing = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx33", title: "Retraction: record down", facts: { update_to: [{ type: "retraction", doi: "10.1056/NEJMoa1000033" }] } });
  await pipelineWith(broken).processBatch();
  assert.deepEqual([(await entryOf(failing)).state, (await entryOf(failing)).state_reason], ["dropped", "retraction-notice"]);
  assert.equal(broken.stats().writeFailures, 1, "the failure is counted, not thrown");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.item_links WHERE to_doi='10.1056/nejmoa1000033'")).rows[0].n, 1);
});
