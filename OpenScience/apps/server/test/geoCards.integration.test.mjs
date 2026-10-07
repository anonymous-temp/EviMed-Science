// 「循证 GEO」's product zone and its cards (flywheel F21, F28): a project's verified claims become the cards of the one product
// zone its owner holds, on the real zone service and the real tables — only what the card ruler verifies, one card per clinical
// question, idempotent, the claim table kept and marked with the card each claim became, and every refusal named and narrow.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { GeoCards } from "../src/geoCards.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };

const LABEL = "【用法用量】成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg。【禁忌】对本品活性成分或辅料过敏者禁用。";
const TRIAL = "In the randomized trial, participants on the drug lost 14.1% of body weight at week 48 versus 2.3% with placebo.";
const FILES = new Map([[".evimed-sources/label.txt", LABEL], [".evimed-sources/trial.txt", TRIAL]]);
const readSource = async (/** @type {{ artifactPath: string | null }} */ claim) => (claim.artifactPath ? FILES.get(claim.artifactPath) ?? null : null);
const claims = {
  dose: { claimKey: "dose", statement: "成人推荐起始剂量为每周一次 2.5 mg。", quote: "成人推荐起始剂量为每周一次 2.5 mg", sourceRef: "信尔美说明书 2025 版",
    sourceLabel: "信尔美说明书", sourceKind: "label", inLabel: true, artifactPath: ".evimed-sources/label.txt" },
  contra: { claimKey: "contra", statement: "对本品活性成分或辅料过敏者禁用。", quote: "对本品活性成分或辅料过敏者禁用", sourceRef: "信尔美说明书 2025 版",
    sourceLabel: "信尔美说明书", sourceKind: "label", inLabel: true, artifactPath: ".evimed-sources/label.txt" },
  weight: { claimKey: "trial:weight", statement: "第 48 周体重下降 14.1%。", quote: "lost 14.1% of body weight at week 48", sourceRef: "10.1056/NEJMoa0000000",
    sourceKind: "trial", journeyStage: { key: "治疗选择", label: "治疗选择" }, clinicalQuestion: "用药后体重能降多少？", comparisonType: "head_to_head", artifactPath: ".evimed-sources/trial.txt" },
  // Not verifiable: the quotation is not in its source, and a source that cannot be read.
  wrong: { claimKey: "wrong", statement: "每日三次。", quote: "每日三次，每次 10 mg", sourceRef: "信尔美说明书 2025 版", sourceKind: "label", artifactPath: ".evimed-sources/label.txt" },
  lost: { claimKey: "lost", statement: "另一个结论。", quote: "另一个引文", sourceRef: "某指南", sourceKind: "guideline", artifactPath: ".evimed-sources/gone.txt" },
};

/** @type {any} */ let isolated, db, store, zones, cards;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "geocards");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice Li','development'),('bob','Bob','development')");
  store = new GeoStore({ database: db });
  await store.ready();
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
  cards = new GeoCards({ store, zones, database: db, ownerName: async (id) => (id === "alice" ? "Alice Li" : "Bob"),
    now: () => new Date("2026-10-06T08:00:00Z") });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_geo.projects CASCADE");
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
});

/** A GEO project of `alice`, with its claims written. @param {Record<string, any>} [over] @param {(keyof typeof claims)[]} [keys] */
async function project(over = {}, keys = ["dose", "contra", "weight", "wrong", "lost"]) {
  const created = await store.createProject({ userId: "alice", projectId: `p-${Math.random().toString(36).slice(2, 8)}`, engines: ["deepseek"], coverageDays: 90,
    product: { brandName: "信尔美", genericName: "玛仕度肽注射液", holder: "某某制药有限公司" } });
  await store.updateProject("alice", created.id, { producer: { kind: "enterprise", relation: "own_product" }, ...over });
  await store.upsertClaims("alice", created.id, keys.map((key) => claims[key]));
  return /** @type {any} */ (store.getProject("alice", created.id));
}
const reviewing = { people: async () => ({ authors: [{ name: "王编辑" }], reviewers: [{ name: "李医生", affiliation: "某某医院 内分泌科" }] }) };
const withPeople = () => new GeoCards({ store, zones, database: db, ...reviewing, now: () => new Date("2026-10-06T08:00:00Z") });
const refused = (code, status) => (error) => {
  assert.equal(error.code, code, `refused as ${code}, not ${error.code}`);
  if (status) assert.equal(error.status, status);
  return true;
};

test("the project's verified claims become the cards of its one product zone, a card per clinical question", options, async () => {
  const geo = await project();
  const result = await withPeople().refresh(geo, { readSource });
  // The label stage (说明书与基本信息) and the treatment-choice stage: two cards, each in the stage its claims named or defaulted to.
  assert.deepEqual(result.cards.map((card) => card.journeyStage.key).sort(), ["label", "治疗选择"]);
  assert.deepEqual(result.cards.map((card) => card.change), ["created", "created"]);
  assert.deepEqual(result.held.map((entry) => [entry.claimKey, entry.reason]).sort(), [["lost", "source_unavailable"], ["wrong", "quote_not_found"]]);
  const zone = (await db.query("SELECT * FROM evimed_frontier.evidence_zones WHERE id=$1", [result.zoneId])).rows[0];
  assert.equal(zone.kind, "product");
  assert.equal(zone.user_id, "alice");
  assert.equal(zone.state, "draft", "reading it on the open internet is the owner's own click");
  const refreshed = await store.getProject("alice", geo.id);
  assert.equal(refreshed.productZoneId, result.zoneId, "the project knows its zone");
  const rows = (await db.query("SELECT * FROM evimed_frontier.evidence_cards WHERE zone_id=$1 ORDER BY title", [result.zoneId])).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.state, "draft");
    assert.equal(row.user_id, "alice");
    assert.deepEqual(row.producer, { kind: "enterprise", name: "某某制药有限公司", relation: "own_product", products: ["信尔美", "玛仕度肽注射液"] });
    assert.deepEqual(row.disclosure.authors, [{ name: "王编辑" }]);
    assert.deepEqual(row.disclosure.reviewers, [{ name: "李医生", affiliation: "某某医院 内分泌科" }]);
    assert.ok(row.journey_stage.key);
    assert.equal(row.originality, "synthesis");
  }
  const treatment = rows.find((row) => row.journey_stage.key === "治疗选择");
  assert.equal(treatment.title, "用药后体重能降多少？");
  assert.equal(treatment.claims[0].supportQuote, "lost 14.1% of body weight at week 48");
  assert.match(treatment.claims[0].applicability, /头对头比较/);
  assert.equal(treatment.sources[0].url, "https://doi.org/10.1056/NEJMoa0000000");
  // Only the verified claims are in a card; the two the ruler marks ⚠ are not.
  const inCards = rows.flatMap((row) => row.claims.map((claim) => claim.claimId)).sort();
  assert.deepEqual(inCards, ["contra", "dose", "trial-weight"]);
  // The claim table is kept, and each claim that became a card claim records the card, the claim and the revision it became.
  const table = (await db.query("SELECT claim_key, card_id, card_claim_id, card_revision FROM evimed_geo.claims WHERE geo_project_id=$1 ORDER BY claim_key", [geo.id])).rows;
  assert.equal(table.length, 5);
  const byKey = Object.fromEntries(table.map((row) => [row.claim_key, row]));
  assert.equal(byKey.dose.card_claim_id, "dose");
  assert.equal(byKey.dose.card_revision, 1);
  assert.equal(byKey["trial:weight"].card_claim_id, "trial-weight", "the card claim id is a legal one made from the claim key");
  assert.equal(byKey["trial:weight"].card_id, treatment.id);
  assert.equal(byKey.wrong.card_id, null, "a claim the ruler marks ⚠ stays in the project and is not published");
  assert.equal(byKey.lost.card_id, null);
  // Written by the project, through the zone's own origin rule: a draft the zone's owner can read.
  const shown = await zones.detail({ id: "alice" }, result.zoneId, treatment.id);
  assert.deepEqual(shown.evidence.claims.map((claim) => claim.verification.mark), ["✓"]);
});

test("a second refresh finds every card as planned and writes nothing: no new revision", options, async () => {
  const geo = await project();
  const service = withPeople();
  const first = await service.refresh(geo, { readSource });
  const again = await service.refresh(await store.getProject("alice", geo.id), { readSource });
  assert.deepEqual(again.cards.map((card) => card.change), ["unchanged", "unchanged"]);
  assert.deepEqual(again.cards.map((card) => card.revision), [1, 1]);
  assert.equal(again.zoneId, first.zoneId);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.evidence_zones")).rows[0].n, 1, "one zone, however often it is asked for");
});

test("a changed claim is the card's next revision, and the claim records the revision it stands in", options, async () => {
  const geo = await project({}, ["dose", "contra"]);
  const service = withPeople();
  await service.refresh(geo, { readSource });
  await store.upsertClaims("alice", geo.id, [{ ...claims.dose, statement: "成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg。", quote: "成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg" }]);
  const again = await service.refresh(await store.getProject("alice", geo.id), { readSource });
  assert.deepEqual(again.cards.map((card) => [card.change, card.revision]), [["updated", 2]]);
  const table = (await db.query("SELECT claim_key, version, card_revision FROM evimed_geo.claims WHERE geo_project_id=$1 ORDER BY claim_key, version", [geo.id])).rows;
  assert.deepEqual(table.filter((row) => row.claim_key === "dose").map((row) => [row.version, row.card_revision]), [[1, 1], [2, 2]],
    "the new version stands in the new revision; the old row keeps the revision it was in");
  assert.equal(table.find((row) => row.claim_key === "contra").card_revision, 2);
});

test("a claim the ruler stops verifying leaves its card, and the card keeps the ones that stand", options, async () => {
  const geo = await project({}, ["dose", "contra"]);
  const service = withPeople();
  await service.refresh(geo, { readSource });
  const edited = new Map(FILES);
  edited.set(".evimed-sources/label.txt", "【用法用量】成人推荐起始剂量为每周一次 2.5 mg。");
  const result = await service.refresh(await store.getProject("alice", geo.id), { readSource: async (claim) => edited.get(claim.artifactPath) ?? null });
  assert.deepEqual(result.held.map((entry) => [entry.claimKey, entry.reason]), [["contra", "quote_not_found"]]);
  assert.deepEqual(result.cards.map((card) => [card.change, card.claims]), [["updated", 1]]);
  const row = (await db.query("SELECT claims FROM evimed_frontier.evidence_cards")).rows[0];
  assert.deepEqual(row.claims.map((claim) => claim.claimId), ["dose"]);
  assert.equal((await db.query("SELECT card_id FROM evimed_geo.claims WHERE claim_key='contra'")).rows[0].card_id, null);
});

test("a project that says no producer, or has no reviewer, writes no card and loses nothing", options, async () => {
  const noProducer = await project({ producer: null });
  await assert.rejects(() => withPeople().refresh(noProducer, { readSource }), refused("geo_card_producer_required", 409));
  const enterprise = await project();
  // The owner alone is an author, not a reviewing doctor: a company names one, and the default people do not invent one.
  await assert.rejects(() => cards.refresh(enterprise, { readSource }), refused("geo_card_reviewer_required", 409));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.evidence_cards")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_geo.claims")).rows[0].n, 10, "every claim of both projects is still there");
});

test("a doctor project's doctor is the author and the reviewer, shown by hospital, department and specialty", options, async () => {
  const geo = await project({ producer: { kind: "doctor", name: "张医生", hospital: "某某医院", department: "内分泌科", specialty: "糖尿病", relation: "user_of_therapy" } }, ["dose"]);
  const result = await cards.refresh(geo, { readSource });
  const row = (await db.query("SELECT producer, disclosure FROM evimed_frontier.evidence_cards WHERE id=$1", [result.cards[0].cardId])).rows[0];
  assert.deepEqual(row.producer, { kind: "doctor", name: "张医生", relation: "user_of_therapy", products: ["信尔美", "玛仕度肽注射液"] });
  assert.deepEqual(row.disclosure.authors, [{ name: "张医生", affiliation: "某某医院 内分泌科", title: "糖尿病" }]);
  assert.deepEqual(row.disclosure.reviewers, row.disclosure.authors);
});

test("another account's write into the zone is refused, and so is a write from any origin the product zone does not take", options, async () => {
  const geo = await project();
  const result = await withPeople().refresh(geo, { readSource });
  const cardRow = (await db.query("SELECT * FROM evimed_frontier.evidence_cards LIMIT 1")).rows[0];
  const body = { title: "x", subtype: "knowledge", summary: "s", body: "b", sources: [{ title: "t", url: "https://example.org/a" }], limitations: "",
    producer: { kind: "enterprise", name: "某公司", relation: "own_product" }, journeyStage: { key: "label", label: "x" },
    disclosure: { authors: [{ name: "a" }], reviewers: [{ name: "r" }] } };
  // Bob has no way to write into alice's zone (it is not published, so to him it does not exist).
  await assert.rejects(() => zones.saveEditorial({ id: "bob" }, { ...body, expectedRevision: cardRow.revision }, result.zoneId, cardRow.id, true, "geo"), (error) => ["evidence_not_found", "evidence_owner_required", "evidence_write_origin_refused"].includes(error.code));
  // The owner herself cannot write it from the origins that belong to other zones.
  for (const origin of ["import", "model", "programme", "result"]) {
    await assert.rejects(() => zones.saveEditorial({ id: "alice" }, { ...body, expectedRevision: cardRow.revision }, result.zoneId, cardRow.id, true, origin), refused("evidence_write_origin_refused", 403));
  }
});

test("another account reads none of it: the cards are listed by the project's owner and zone", options, async () => {
  const geo = await project();
  const service = withPeople();
  await service.refresh(geo, { readSource });
  const listed = await service.list(await store.getProject("alice", geo.id));
  assert.equal(listed.cards.length, 2);
  const treatment = listed.cards.find((card) => card.journeyStage.key === "治疗选择");
  assert.deepEqual(treatment.claims.map((claim) => [claim.claimId, claim.claimKey, claim.mark, claim.comparisonType]), [["trial-weight", "trial:weight", "✓", "head_to_head"]]);
  assert.equal(treatment.claims[0].quote, "lost 14.1% of body weight at week 48");
  // A project object that names bob as its owner finds none of alice's cards, even with her zone id.
  const forged = { ...(await store.getProject("alice", geo.id)), userId: "bob" };
  assert.deepEqual((await service.list(forged)).cards, []);
});

test("release-5 rows read as claims not yet written into a card, and the migration is a no-op the second time", options, async () => {
  // A claim row shaped as it was before the columns existed: nothing of the chain on it.
  const created = await store.createProject({ userId: "alice", projectId: "p-old", engines: ["deepseek"], coverageDays: 90, product: { brandName: "旧产品" } });
  await db.query(`INSERT INTO evimed_geo.claims (id, user_id, geo_project_id, claim_key, version, statement, quote, source_ref, source_kind, status)
    VALUES ('gcl_old1', 'alice', $1, 'OLD-1', 1, '旧结论', '旧引文', '旧来源', 'label', 'active')`, [created.id]);
  const { migrateGeo } = await import("../src/geoPersistence.mjs");
  const before = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='evimed_geo' ORDER BY table_name, column_name")).rows.length;
  // A fresh process opens the same database: the migration runs again against the existing data.
  const second = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  try {
    await migrateGeo(second);
    await migrateGeo(second);
    const after = (await second.query("SELECT column_name FROM information_schema.columns WHERE table_schema='evimed_geo' ORDER BY table_name, column_name")).rows.length;
    assert.equal(after, before);
  } finally { await second.close(); }
  const [old] = await store.listClaims(created.id);
  assert.equal(old.claimKey, "OLD-1");
  assert.deepEqual([old.cardId, old.cardClaimId, old.cardRevision, old.journeyStage, old.clinicalQuestion, old.comparisonType, old.artifactPath], [null, null, null, null, null, null, null]);
  const project = /** @type {any} */ (await store.getProject("alice", created.id));
  assert.equal(project.productZoneId, null);
  assert.equal(project.producer, null);
  // And it is still a project that can be asked for cards: it just has no producer yet, and says so by name.
  await assert.rejects(() => cards.refresh(project, { readSource }), refused("geo_card_producer_required"));
  // Its card list is empty, not an error.
  assert.deepEqual(await cards.list(project), { zoneId: null, cards: [] });
});

test("two callers racing to make the zone get the same one", options, async () => {
  const geo = await project();
  const [first, second] = await Promise.all([cards.ensureProductZone(geo), cards.ensureProductZone(geo)]);
  assert.equal(first.id, second.id);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.evidence_zones")).rows[0].n, 1);
});

test("a zone the owner deleted is made again, and a taken-back card is not written over", options, async () => {
  const geo = await project({}, ["dose"]);
  const service = withPeople();
  const first = await service.refresh(geo, { readSource });
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn = '{\"at\":\"2026-10-06T00:00:00Z\",\"reason\":\"撤回\"}'::jsonb WHERE id=$1", [first.cards[0].cardId]);
  const skipped = await service.refresh(await store.getProject("alice", geo.id), { readSource });
  assert.deepEqual(skipped.skipped.map((entry) => entry.reason), ["card_withdrawn"]);
  assert.deepEqual(skipped.cards, []);
  await db.query("DELETE FROM evimed_frontier.evidence_zones WHERE id=$1", [first.zoneId]);
  const again = await service.refresh(await store.getProject("alice", geo.id), { readSource });
  assert.equal(again.zoneId, first.zoneId, "the same project makes the same zone again");
  assert.equal(again.cards.length, 1);
});
