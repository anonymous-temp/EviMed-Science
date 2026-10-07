// A release-5 database reads correctly after the evidence-chain migration (flywheel F21, F28, F29). The test builds the shape release 5
// had — it removes every column, index and table this work added — inserts rows as release 5 wrote them with raw SQL (claims with no card,
// a stored card-layer article with its own file, a judged answer whose statements carry no topic, a project with no producer), then runs
// the migration on a fresh connection, twice, and reads everything through the real store and service.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoCards } from "../src/geoCards.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { migrateGeo } from "../src/geoPersistence.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };

/** What this work added to the schema, by table: the columns, and the table that is new. */
const ADDED_COLUMNS = {
  claims: ["journey_stage", "clinical_question", "comparison_type", "artifact_path", "card_id", "card_claim_id", "card_revision"],
  projects: ["producer", "product_zone_id", "internal"],
  articles: ["claim_refs", "ref_status", "ref_checked_sha", "card_id", "card_revision", "placement_label"],
  facts: ["checks"],
};

/** @type {any} */ let isolated, db;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "georelease5");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5000 });
  await migrateGeo(db);
  // Back to release 5.
  await db.query("DROP TABLE evimed_geo.members");
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    for (const column of columns) await db.query(`ALTER TABLE evimed_geo.${table} DROP COLUMN ${column}`);
  }
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});

test("the release-5 shape really lacks everything this work added", options, async () => {
  const columns = (await db.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'evimed_geo'")).rows
    .map((row) => `${row.table_name}.${row.column_name}`);
  for (const [table, list] of Object.entries(ADDED_COLUMNS)) for (const column of list) assert.ok(!columns.includes(`${table}.${column}`), `${table}.${column}`);
  assert.equal((await db.query("SELECT to_regclass('evimed_geo.members') AS name")).rows[0].name, null);
});

test("rows written by release 5 read after the migration — which runs twice and changes nothing the second time", options, async () => {
  // Rows as release 5 wrote them, in its own columns.
  await db.query(`INSERT INTO evimed_geo.projects (id, user_id, project_id, product, engines) VALUES
    ('geo_old', 'alice', 'p-old', '{"brandName":"旧产品","holder":"某某制药"}'::jsonb, ARRAY['deepseek'])`);
  await db.query(`INSERT INTO evimed_geo.claims (id, user_id, geo_project_id, claim_key, version, statement, quote, source_ref, source_kind, in_label, status)
    VALUES ('gcl_old1', 'alice', 'geo_old', 'OLD-1', 1, '每周一次皮下注射', '本品每周一次皮下注射给药', '说明书', 'label', true, 'active'),
           ('gcl_old2', 'alice', 'geo_old', 'OLD-2', 1, '对本品过敏者禁用', '对本品活性成分过敏者禁用', '说明书', 'label', true, 'active')`);
  await db.query(`INSERT INTO evimed_geo.question_groups (id, user_id, geo_project_id, set_version, pool, name) VALUES ('gg_old', 'alice', 'geo_old', 1, 'P2', '用法')`);
  await db.query(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, run_id, deliverable_id, path, layer, title, group_id, claim_ids, gate, safety, content_sha256, status)
    VALUES ('gart_card', 'alice', 'geo_old', 'run_1', 'geo-content', 'deliverables/geo-content/articles/card.md', 'card', '旧的证据卡片', 'gg_old', ARRAY['gcl_old1'], 'passed', 'clear', '${"a".repeat(64)}', 'published'),
           ('gart_pop', 'alice', 'geo_old', 'run_1', 'geo-content', 'deliverables/geo-content/articles/pop.md', 'popular', '旧的科普', 'gg_old', ARRAY['gcl_old1', 'gcl_old2'], 'passed', 'clear', '${"b".repeat(64)}', 'placed')`);
  await db.query(`INSERT INTO evimed_geo.snapshots (id, user_id, geo_project_id, engine, asked_at, status, answer_text) VALUES ('snap_old', 'alice', 'geo_old', 'deepseek', now(), 'valid', '信尔美每周一次。')`);
  await db.query(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, statements, judged_at)
    VALUES ('snap_old', 'alice', 'geo_old', '[{"text":"每周一次","verdict":"correct","claimId":"gcl_old1","errorType":null,"severity":null,"evidence":"每周一次"}]'::jsonb, now())`);

  // A fresh process opens the database: the migration runs against the data, twice.
  const fresh = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5000 });
  try {
    await migrateGeo(fresh);
    const inventory = async () => JSON.stringify((await fresh.query(`SELECT table_name, column_name, data_type, column_default FROM information_schema.columns
      WHERE table_schema = 'evimed_geo' ORDER BY 1, 2`)).rows);
    const afterFirst = await inventory();
    const second = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 5000 });
    try { await migrateGeo(second); } finally { await second.close(); }
    assert.equal(await inventory(), afterFirst, "the second run changes nothing");
    assert.equal((await fresh.query("SELECT count(*)::int AS n FROM evimed_geo.claims")).rows[0].n, 2, "no row was lost or duplicated");

    const store = new GeoStore({ database: fresh });
    const cards = new GeoCards({ store, zones: null, database: fresh });
    const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" }, cards });

    // The project: nobody speaks for it yet, it has no zone, it is no one's internal project, and its owner reaches it as the owner.
    const project = /** @type {any} */ (await store.getProject("alice", "geo_old"));
    assert.deepEqual([project.producer, project.productZoneId, project.internal], [null, null, false]);
    assert.deepEqual((await store.getProjectAccess("alice", "geo_old"))?.roles, ["owner"]);
    assert.equal(await store.getProjectAccess("bob", "geo_old"), null, "another account still reads it as nonexistent");
    assert.deepEqual((await service.requireProject({ id: "alice" }, "geo_old")).access, { roles: ["owner"], abilities: ["read", "edit", "run", "review", "manage_money", "manage_members", "delete"], owner: true });

    // The claims: not yet in any card, with no stage, question, comparison type or source file.
    const claims = await store.listClaims("geo_old");
    assert.deepEqual(claims.map((claim) => claim.claimKey), ["OLD-1", "OLD-2"]);
    for (const claim of claims) {
      assert.deepEqual([claim.cardId, claim.cardClaimId, claim.cardRevision, claim.journeyStage, claim.clinicalQuestion, claim.comparisonType, claim.artifactPath],
        [null, null, null, null, null, null, null], claim.claimKey);
    }
    // Asked for cards, it says what is missing by name rather than guessing, and the claims stay as they are.
    await assert.rejects(() => cards.refresh(project, { readSource: async () => null }), { code: "geo_card_producer_required" });
    assert.deepEqual(await cards.list(project), { zoneId: null, cards: [] });
    assert.equal((await store.listClaims("geo_old")).length, 2);

    // The articles: the stored card-layer article keeps its file and its status and is unchecked, not failed; nothing is flagged.
    const articles = await store.listArticles("geo_old");
    const stored = articles.find((article) => article.layer === "card");
    assert.deepEqual([stored?.path, stored?.status, stored?.refStatus, stored?.cardId, stored?.cardRevision, stored?.placementLabel, stored?.claimRefs], [
      "deliverables/geo-content/articles/card.md", "published", "unchecked", null, null, null, []]);
    assert.equal(await cards.cardLayerText(project, /** @type {any} */ (stored)), null, "a stored article has no rendering: its file is its text");
    const listed = await service.articles({ id: "alice" }, "geo_old");
    assert.deepEqual(listed.articles.map((article) => [article.id, article.referenceStatus, article.staleReferences, article.placementLabel]), [
      ["gart_card", "unchecked", [], null], ["gart_pop", "unchecked", [], null]]);
    // And a placed article keeps the placement it was in; the market's view of it has no label until a placement says one.
    assert.equal((await store.getArticle("geo_old", "gart_pop"))?.status, "placed");

    // The judged answer: its statements carry no topic, so it has no specified-information rate — absent, not zero — and no checks.
    const view = await service.answer({ id: "alice" }, "geo_old", "snap_old");
    assert.deepEqual(view.facts.statements.map((/** @type {any} */ statement) => statement.verdict), ["correct"]);
    assert.deepEqual([view.facts.specifiedInfo.decided, view.facts.specifiedInfo.rate], [0, null]);
    assert.deepEqual(view.facts.checks, {});

    // The judge is shown the claim table, as before, with no card revision on any claim.
    const context = await new GeoMeasureStore(fresh).projectContext("geo_old");
    assert.deepEqual(context?.claims.map((claim) => [claim.key, claim.cardId, claim.cardRevision]), [["OLD-1", null, null], ["OLD-2", null, null]]);

    // No members: the list is the owner alone.
    assert.deepEqual(await store.memberRows("geo_old"), []);
    assert.deepEqual((await store.listProjectsFor("alice")).map((entry) => entry.id), ["geo_old"]);
    assert.deepEqual(await store.listProjectsFor("bob"), []);
  } finally { await fresh.close(); }
});
