// Keeping the evidence cards current (evidence-flywheel plan 2026-10-05 §5.4, F13, F14, §8) against a real PostgreSQL: the watch that finds new
// evidence by keys and labels a card, who answers by who made the card, the source-change feed that marks every card citing a retracted work,
// readers' challenges, the append-only public change log, retirement, and the three monthly figures. The model is a double; everything else —
// the verbatim check, the inbox, the source-change record, the zone service, the editor — is the real one.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID, evidenceUpkeepRoute } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createEvidenceChangeLog } from "../src/evidenceChangeLog.mjs";
import { createEvidenceChallenges } from "../src/evidenceChallenges.mjs";
import { cardIdentifierKeys, createEvidenceUpkeep, staleOfficialCards, zoneMatchKeys } from "../src/evidenceCurrency.mjs";
import { evidenceContentHash, evidenceHash } from "../src/evidenceCardContent.mjs";
import { EvidenceEditorial } from "../src/evidenceEditorial.mjs";
import { monthlyEvidenceFigures } from "../src/evidenceFigures.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { createSourceChanges } from "../src/sourceChanges.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const PUBLISHER = { id: PLATFORM_PUBLISHER_USER_ID };
const alice = { id: "up_alice" };
const bob = { id: "up_bob" };
const carol = { id: "up_carol" };
const AI = { kind: "ai", name: "Test AI editor", model: "test-model" };
const SOURCE_TEXT = "In this randomized trial, 7 of 100 adults on the drug had a stroke, against 12 of 100 on usual care. Major bleeding occurred in 3 of 100 on the drug.";

/** @type {any} */ let isolated, db, service, documents, sourceChanges, notifications, changeLog;
/** The clock the loops read: tests move it, the database's own clock is real. */
const clock = { at: Date.now() };
const now = () => new Date(clock.at);
const DAY = 86_400_000;
let counter = 0;
const unique = (/** @type {string} */ prefix) => `${prefix}${++counter}`;

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "upkeep");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await migrateProductStore(db);
  for (const user of [alice, bob, carol]) await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$2,'development')", [user.id, user.id]);
  service = new EvidenceZoneService({ database: db, platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID });
  await service.ready();
  documents = new ProductDocuments(db);
  sourceChanges = createSourceChanges({ documents, ownerUserId: PLATFORM_PUBLISHER_USER_ID });
  notifications = new NotificationService(db);
  changeLog = createEvidenceChangeLog({ database: db });
  await insertSource(db, "upkeep-journal");
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  clock.at = Date.now();
  // The editor claims the oldest due job of any zone, so one test's jobs must not stand in front of the next test's.
  if (db) await db.query("DELETE FROM evimed_frontier.evidence_editorial_jobs");
});

/** The loops and the editor over the real service, with the model and the network as doubles. */
function build({ resultImpacts = null, knowledgeChange = null, judge = null, budget = null, readSource = async () => ({ text: SOURCE_TEXT, receipt: { sha256: evidenceHash(SOURCE_TEXT) } }), editor = null, followers = /** @type {any[]} */ ([]), levers = {}, withUpkeep = true } = {}) {
  const log = createEvidenceChangeLog({ database: db });
  const upkeep = createEvidenceUpkeep({ database: db, changeLog: log, sourceChanges, notifications, resultImpacts, knowledgeChange, levers: { intervalHours: 24, batch: 200, ...levers }, now,
    notifyZoneFollowers: async (/** @type {any} */ event) => { followers.push(event); } });
  const challenges = createEvidenceChallenges({ database: db, service, changeLog: log, notifications, judge, budget, levers, now,
    notifyZoneFollowers: async (/** @type {any} */ event) => { followers.push(event); } });
  service.onCardSaved = async (/** @type {any} */ event) => { await upkeep.onCardRevision(event); await challenges.onCardRevision(event); };
  const worker = new EvidenceEditorial({ database: db, service, editor: editor ?? { available: true, model: "test-model", evidenceTarget: async () => null, evidenceCard: async () => ({}), evidenceReview: async () => ({ findings: [] }) },
    readSource, budget: async () => ({ state: "ok" }), now, sourceChanges, ...(withUpkeep ? { upkeep, challenges } : {}) });
  return { changeLog: log, upkeep, challenges, worker, followers };
}

/** A published zone: a user's, a product zone's, or the platform's. */
async function zoneOf(owner, { kind = "user", title = unique("Zone ") } = /** @type {any} */ ({})) {
  if (kind === "official") {
    const made = (await service.saveEditorial(PUBLISHER, { title, kind: "official", state: "published" }, null, null, false, "programme")).zone;
    return made;
  }
  return (await service.save(owner, { title, ...(kind === "product" ? { kind: "product" } : {}), state: "published" })).zone;
}

/** A published card with its keys; `ai` makes it the editor's (written and reviewed by the model, so the automation owns it). */
async function cardOf(zone, owner, { ai = false, entityKeys = /** @type {string[]} */ ([]), url: sourceUrl = unique("https://example.org/src-"), claims = /** @type {any[]} */ ([]), extra = /** @type {any} */ ({}), origin = ai ? "model" : "owner" } = {}) {
  const body = {
    title: unique("Card "), subtype: "academic", summary: "Fewer strokes", body: "The trial reports fewer strokes.", limitations: "One trial.",
    sources: [{ title: "The cited trial", url: sourceUrl, excerpt: SOURCE_TEXT, ...(ai || origin !== "owner" ? { documentText: SOURCE_TEXT, sha256: evidenceHash(SOURCE_TEXT), coverage: "abstract" } : {}) }],
    content: { question: "Does it prevent stroke?", answer: "Fewer strokes.", population: "Adults" },
    state: "published", entityKeys, claims, ...extra,
  };
  if (!ai && origin === "owner") return (await service.save(owner, body, zone.id, null, true)).evidence;
  const saved = (await service.saveEditorial(owner, { ...body, ...(ai ? { editorial: { author: AI, status: "review-pending", sourceCheckedAt: new Date().toISOString(), findings: [] } } : {}) }, zone.id, null, true, origin)).evidence;
  if (!ai) return saved;
  return (await service.saveEditorial(owner, { expectedRevision: saved.revision, editorial: { ...saved.editorial, status: "ai-reviewed", reviewer: { ...AI, name: "Reviewer" }, contentHash: evidenceContentHash(saved), findings: [], reviewedAt: new Date().toISOString() } }, zone.id, saved.id, false, origin)).evidence;
}

/** A frontier item that arrived after `afterMs` of the clock, with its entity keys. */
async function itemOf({ title = unique("Frontier item "), doi = null, entityKeys = /** @type {string[]} */ ([]), registryIds = /** @type {string[]} */ ([]), minutesAfter = 5 } = {}) {
  const made = await insertItem(db, { sourceId: "upkeep-journal", title, doi, timelineAt: new Date(clock.at + minutesAfter * 60_000).toISOString() });
  await db.query("UPDATE evimed_frontier.items SET entity_keys=$2,registry_ids=$3 WHERE id=$1", [made.id, entityKeys, registryIds]);
  return made;
}

const rows = async (/** @type {string} */ sql, /** @type {any[]} */ values = []) => (await db.query(sql, values)).rows;
const cardRow = async (/** @type {string} */ id) => (await rows("SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1", [id]))[0];
const inbox = async (/** @type {string} */ userId) => (await notifications.list(userId, { limit: 100 })).items;
/** The notices of a kind that name a card: the inbox is shared by every test in this file. */
const noticesAbout = async (/** @type {string} */ userId, /** @type {any} */ card, /** @type {RegExp} */ title) => (await inbox(userId)).filter((notice) => title.test(notice.title) && notice.body.includes(card.title));
const logOf = async (/** @type {string} */ cardId) => (await changeLog.list({ cardId, limit: 100 })).items;
/** A drug key no other test shares, so one test's items never bear on another test's cards. */
const drug = () => `drug:${unique("d")}`;

test("a frontier item that shares a DOI with a card's source marks it as the same work, and one that only shares a drug marks it as new evidence", options, async () => {
  const { upkeep } = build();
  const [mine, other] = [drug(), drug()];
  const zone = await zoneOf(alice);
  const doi = `10.1000/${unique("cited.")}`;
  const card = await cardOf(zone, alice, { entityKeys: [mine], url: `https://doi.org/${doi}` });
  const sameWork = await itemOf({ doi, title: "A new report of the cited trial" });
  const sameDrug = await itemOf({ entityKeys: [mine], title: "Another study of the drug" });
  const unrelated = await itemOf({ entityKeys: [other], title: "A study of another drug" });
  assert.equal(await upkeep.watchTick(), 1);
  const row = await cardRow(card.id);
  assert.equal(row.currency, "new_evidence_pending");
  assert.deepEqual([...row.pending_item_ids].sort(), [sameWork.publicId, sameDrug.publicId].sort(), "the warfarin item shares nothing with the card");
  assert.ok(!row.pending_item_ids.includes(unrelated.publicId));
  const kinds = Object.fromEntries(row.currency_detail.pending.map((/** @type {any} */ item) => [item.itemId, item.kind]));
  assert.equal(kinds[sameWork.publicId], "same_work", "an identifier match names a study the card cites");
  assert.equal(kinds[sameDrug.publicId], "new_evidence", "an entity match is the same subject");
  const view = (await service.detail(alice, zone.id, card.id)).evidence;
  assert.equal(view.currency, "new_evidence_pending");
  assert.equal(view.currencyLabel, "有新证据，尚未纳入");
  assert.equal(view.pendingItemIds.length, 2);
  assert.ok(view.lastCheckedAt);
  assert.equal((await service.detail(alice, zone.id)).zone.currencyCounts.new_evidence_pending, 1, "the zone view counts its cards by label");
});

test("one shared entity is not evidence for a card about two: an item must carry as many of the card's keys as the card has, up to two", options, async () => {
  const { upkeep } = build();
  const [first, second] = [drug(), `disease:${unique("dz")}`];
  const zone = await zoneOf(alice);
  const card = await cardOf(zone, alice, { entityKeys: [first, second], url: `https://doi.org/10.1000/${unique("two.")}` });
  await itemOf({ entityKeys: [first], title: "The drug in something else" });
  await upkeep.watchTick();
  assert.equal((await cardRow(card.id)).currency, "current", "one of two shared keys does not make news");
  await db.query("UPDATE evimed_frontier.evidence_cards SET last_checked_at=NULL WHERE id=$1", [card.id]);
  const both = await itemOf({ entityKeys: [first, second], title: "The drug in the disease" });
  await upkeep.watchTick();
  const row = await cardRow(card.id);
  assert.equal(row.currency, "new_evidence_pending");
  assert.deepEqual(row.pending_item_ids, [both.publicId]);
  // The frontier item the card was made from is its own source, not news.
  const own = await itemOf({ entityKeys: [first, second] });
  await db.query("UPDATE evimed_frontier.evidence_cards SET source_item_id=$2,pending_item_ids='{}',currency='current',currency_detail=NULL,last_checked_at=NULL WHERE id=$1", [card.id, own.publicId]);
  await db.query("UPDATE evimed_frontier.items SET timeline_at=timeline_at+interval '1 hour'");
  await upkeep.watchTick();
  assert.ok(!(await cardRow(card.id)).pending_item_ids.includes(own.publicId));
});

test("a zone whose words share nothing with a matching item still finds it by key, and its owner's query only orders what was found", options, async () => {
  const key = drug();
  const resolver = async (/** @type {any} */ input) => (input.texts.some((/** @type {string} */ text) => text.includes("anticoagulation")) ? [key] : []);
  const keyed = new EvidenceZoneService({ database: db, platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID, entityKeysFor: resolver });
  const zone = (await keyed.save(alice, { title: "Stroke anticoagulation", state: "published" })).zone;
  const { worker } = build();
  worker.service = keyed;
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run) VALUES($1,true,'warfarin','{journal}',24,1)", [zone.id]);
  const plain = await itemOf({ title: "Factor Xa inhibitors for stroke prevention", entityKeys: [key], minutesAfter: 5 });
  assert.equal(await worker.schedule(), 1, "the item shares no substring with the zone's title or query and is found by its entity key");
  assert.equal((await rows("SELECT source_item_id FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1", [zone.id]))[0].source_item_id, plain.publicId);
  assert.equal(worker.counters.discoveryByKeys, 1);
  assert.deepEqual((await zoneMatchKeys({ database: db, service: keyed, zone })).entityKeys, [key]);
  // Two matches and room for one: the item that also carries the owner's wording comes first although it is older, but it is not the only way in.
  await db.query("DELETE FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1", [zone.id]);
  const worded = await itemOf({ title: "Warfarin versus the new drug after valve surgery", entityKeys: [key], minutesAfter: 1 });
  await db.query("UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1", [zone.id]);
  await worker.schedule();
  assert.equal((await rows("SELECT source_item_id FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1", [zone.id]))[0].source_item_id, worded.publicId);
  // A zone nothing can say anything about falls back to the query it always had.
  const bare = (await service.save(alice, { title: "Unlabelled zone", state: "published" })).zone;
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run) VALUES($1,true,'valve surgery','{journal}',24,2)", [bare.id]);
  const plainWorker = build().worker;
  await plainWorker.schedule();
  assert.equal((await rows("SELECT count(*)::int AS n FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1", [bare.id]))[0].n, 1);
  assert.equal(plainWorker.counters.discoveryByQuery, 1);
});

test("an AI-written card gets a follow-up revision from the editor and is current again, with an entry that says whether its conclusion moved", options, async () => {
  const followers = /** @type {any[]} */ ([]);
  let judged = 0;
  const editor = {
    available: true, model: "test-model",
    evidenceTarget: async (/** @type {any} */ input) => { judged += 1; return input.cards[0].id; },
    evidenceCard: async () => ({ title: "Updated card", summary: "No clear difference", body: "A newer study found no clear difference.", limitations: "Abstract only.",
      content: { question: "Does it prevent stroke?", answer: "No clear difference.", population: "Adults" } }),
    evidenceReview: async () => ({ findings: [] }),
  };
  const { upkeep, worker } = build({ editor, followers });
  const zone = await zoneOf(PUBLISHER, { kind: "official" });
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run) VALUES($1,true,'x','{journal}',24,2)", [zone.id]);
  const mine = drug();
  const card = await cardOf(zone, PUBLISHER, { ai: true, entityKeys: [mine], url: `https://doi.org/10.1000/${unique("brief.")}` });
  const item = await itemOf({ entityKeys: [mine], title: "A newer trial of the drug" });
  await db.query("UPDATE evimed_frontier.items SET canonical_url=$2 WHERE id=$1", [item.id, "https://example.org/newer-trial"]);
  await upkeep.watchTick();
  assert.equal((await cardRow(card.id)).currency, "new_evidence_pending", "labelled first");
  const job = (await rows("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1", [card.id]))[0];
  assert.equal(job.state, "pending");
  assert.equal(job.source_url, "https://example.org/newer-trial", "the editor is asked to read the new study");
  assert.equal(job.payload.upkeep.kind, "new_evidence");
  await worker.tick();
  const after = await cardRow(card.id);
  assert.ok(after.revision >= card.revision + 2, "a follow-up revision was written and reviewed");
  assert.equal(after.title, "Updated card");
  assert.equal(after.currency, "current");
  assert.deepEqual(after.pending_item_ids, []);
  assert.equal(after.sources.length, 2, "the new study was taken in as a source");
  assert.equal(judged, 1, "the editor judged the new item against the card before taking it in");
  const [entry] = await logOf(card.id);
  assert.equal(entry.category, "new_evidence_conclusion_changed");
  assert.equal(entry.trigger, "new_evidence");
  assert.match(entry.summary, /1 项.*结论有变化/);
  assert.deepEqual(entry.refs.frontierItemIds, [item.publicId]);
  assert.deepEqual(followers.map((event) => [event.cardId, event.kind]), [[card.id, "updated"]], "the zone's followers are told through the injected push");
  assert.equal((await rows("SELECT payload->'upkeep' AS u FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1", [card.id]))[0].u, null, "the job is told once");
});

test("an item the editor judges not to bear on the card is handled, never added as a source, and the card is as current as it was", options, async () => {
  const editor = { available: true, model: "test-model", evidenceTarget: async () => ({ skip: true, reason: "不是同一个问题" }), evidenceCard: async () => { throw new Error("no rewrite"); }, evidenceReview: async () => ({ findings: [] }) };
  const { upkeep, worker } = build({ editor });
  const zone = await zoneOf(PUBLISHER, { kind: "official" });
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run) VALUES($1,true,'x','{journal}',24,2)", [zone.id]);
  const mine = drug();
  const sourceUrl = `https://doi.org/10.1000/${unique("brief.")}`;
  const card = await cardOf(zone, PUBLISHER, { ai: true, entityKeys: [mine], url: sourceUrl });
  const item = await itemOf({ entityKeys: [mine] });
  await db.query("UPDATE evimed_frontier.items SET canonical_url=$2 WHERE id=$1", [item.id, `https://example.org/${unique("other-question-")}`]);
  await upkeep.watchTick();
  await worker.tick();
  const after = await cardRow(card.id);
  assert.equal(after.currency, "current");
  assert.equal(after.sources.length, 1, "a rejected source is not added");
  assert.equal(after.revision, card.revision, "nothing was rewritten");
  assert.ok(after.currency_detail.handled.includes(item.publicId));
  assert.equal((await rows("SELECT source_url FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1", [card.id]))[0].source_url, sourceUrl, "the job returned to the card's own source");
  // The same item is not raised again.
  await db.query("UPDATE evimed_frontier.evidence_cards SET last_checked_at=NULL WHERE id=$1", [card.id]);
  await upkeep.watchTick();
  assert.equal((await cardRow(card.id)).currency, "current");
});

test("a user's, a company's or a doctor's card is never rewritten: its producer gets one notice per batch of items, and a product zone's automation is refused", options, async () => {
  const { upkeep, worker } = build();
  const mine = drug();
  const zone = await zoneOf(alice);
  // The owner keeps AI upkeep on in this zone; a card they wrote themselves is still theirs.
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run) VALUES($1,true,'x','{journal}',24,2)", [zone.id]);
  const card = await cardOf(zone, alice, { entityKeys: [mine], url: `https://doi.org/10.1000/${unique("own.")}` });
  const first = await itemOf({ entityKeys: [mine], title: "First new study" });
  await upkeep.watchTick();
  let notices = await noticesAbout(alice.id, card, /新研究可能影响你的卡片/);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "有 1 项新研究可能影响你的卡片");
  assert.match(notices[0].body, new RegExp(card.title));
  assert.match(notices[0].body, /First new study/);
  assert.equal((await cardRow(card.id)).revision, card.revision, "the card is not rewritten");
  assert.equal((await rows("SELECT count(*)::int AS n FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1", [card.id]))[0].n, 0, "no editor job exists for it");
  // The same batch announced again (the card's state lost, the check run again) says nothing again; a new item is a new batch.
  await db.query("UPDATE evimed_frontier.evidence_cards SET last_checked_at=NULL,currency='current',pending_item_ids='{}',currency_detail=NULL WHERE id=$1", [card.id]);
  await upkeep.watchTick();
  assert.equal((await rows("SELECT currency FROM evimed_frontier.evidence_cards WHERE id=$1", [card.id]))[0].currency, "new_evidence_pending");
  assert.equal((await noticesAbout(alice.id, card, /新研究可能影响你的卡片/)).length, 1, "one notice per card and batch");
  await itemOf({ entityKeys: [mine], title: "Second new study", minutesAfter: 10 });
  await db.query("UPDATE evimed_frontier.evidence_cards SET last_checked_at=NULL WHERE id=$1", [card.id]);
  await upkeep.watchTick();
  notices = await noticesAbout(alice.id, card, /新研究可能影响你的卡片/);
  assert.equal(notices.length, 2);
  assert.ok(notices.some((notice) => notice.title === "有 2 项新研究可能影响你的卡片"), "the new batch names every item still waiting");
  assert.equal(first.publicId.length > 0, true);
  // The producer's own edit is their answer to the notice.
  await service.save(alice, { expectedRevision: card.revision, limitations: "Read both new studies; the answer stands." }, zone.id, card.id);
  const answered = await cardRow(card.id);
  assert.equal(answered.currency, "current");
  assert.deepEqual(answered.pending_item_ids, []);
  const [edit] = await logOf(card.id);
  assert.equal(edit.trigger, "producer_edit");
  assert.equal(edit.category, "new_evidence_conclusion_unchanged");
  // Automation on a product zone is refused by name, with the notice named as the way.
  const product = await zoneOf(carol, { kind: "product" });
  await assert.rejects(worker.automation(carol, product.id, { enabled: true, query: "apixaban", sourceTypes: ["journal"], intervalHours: 24, maxCardsPerRun: 1, expectedRevision: product.revision }, "PUT"),
    { code: "evidence_automation_product_zone", status: 409 });
  assert.equal((await rows("SELECT count(*)::int AS n FROM evimed_frontier.evidence_automation WHERE zone_id=$1", [product.id]))[0].n, 0);
  const off = await worker.automation(carol, product.id, { enabled: false, query: "apixaban", sourceTypes: ["journal"], intervalHours: 24, maxCardsPerRun: 1, expectedRevision: product.revision }, "PUT");
  assert.equal(off.automation.enabled, false, "switching it off is always allowed");
});

test("a card in a product zone is watched and its producer told, though no editor may write there", options, async () => {
  const { upkeep } = build();
  const zone = await zoneOf(carol, { kind: "product" });
  const mine = drug();
  const card = await cardOf(zone, carol, {
    entityKeys: [mine], url: `https://doi.org/10.1000/${unique("product.")}`,
    extra: { producer: { kind: "enterprise", name: "Acme Pharma", relation: "own_product", products: ["Drug A"] }, journeyStage: { key: "treatment-choice", label: "治疗选择" },
      disclosure: { authors: [{ name: "Dr. Li" }], reviewers: [{ name: "Dr. Wang" }] } },
  });
  await itemOf({ entityKeys: [mine], title: "A study about the product" });
  await upkeep.watchTick();
  assert.equal((await cardRow(card.id)).currency, "new_evidence_pending");
  assert.equal((await noticesAbout(carol.id, card, /新研究可能影响/)).length, 1);
});

test("an official synthesis stays pending for the topic programme and is handed to it by staleOfficialCards, an AI brief of the same zone is the editor's", options, async () => {
  const { upkeep } = build();
  const zone = await zoneOf(PUBLISHER, { kind: "official" });
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run) VALUES($1,true,'x','{journal}',24,2)", [zone.id]);
  const [first, second] = [drug(), drug()];
  // The programme's own work is written by a model too; what makes it the programme's is what it is — a synthesis, stamped with its agenda.
  const synthesis = await cardOf(zone, PUBLISHER, { ai: true, entityKeys: [first], extra: { originality: "synthesis", lineage: { agendaId: "ag_one" } }, url: `https://doi.org/10.1000/${unique("synthesis.")}` });
  const brief = await cardOf(zone, PUBLISHER, { ai: true, entityKeys: [second], url: `https://doi.org/10.1000/${unique("brief.")}` });
  await itemOf({ entityKeys: [first], title: "New trial of the first drug" });
  await itemOf({ entityKeys: [second], title: "New trial of the second drug" });
  assert.equal(evidenceUpkeepRoute({ zoneKind: "official", producerKind: "platform", authorKind: "human", originality: "synthesis", lineage: { agendaId: "ag_one" } }), "programme");
  await upkeep.watchTick();
  assert.equal((await cardRow(synthesis.id)).currency, "new_evidence_pending");
  assert.equal((await rows("SELECT count(*)::int AS n FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1", [synthesis.id]))[0].n, 0, "the editor does not rewrite an official synthesis");
  assert.equal((await rows("SELECT count(*)::int AS n FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1", [brief.id]))[0].n, 1, "the brief is queued for the editor");
  const stale = await upkeep.staleOfficialCards({ limit: 10 });
  assert.ok(stale.some((entry) => entry.cardId === synthesis.id) && !stale.some((entry) => entry.cardId === brief.id), "only a card the programme is to take up is returned");
  assert.equal(stale.length, stale.filter((entry) => entry.currency === "new_evidence_pending" || entry.currency === "source_changed").length);
  const mine = stale.find((entry) => entry.cardId === synthesis.id);
  assert.deepEqual([mine?.zoneId, mine?.currency, mine?.pendingItemIds.length], [zone.id, "new_evidence_pending", 1]);
  assert.ok(mine?.lastCheckedAt);
  assert.equal((await staleOfficialCards(db, { limit: 1 })).length, 1, "the same list, read without the loops, and bounded by its limit");
});

test("a retraction recorded in the source-change record marks every card citing it and appends a log entry, with no request to anyone", options, async () => {
  const readSource = async () => { throw new Error("the retraction feed makes no network call"); };
  const { upkeep } = build({ readSource });
  const doi = unique("10.1000/retracted.").toLowerCase();
  const zoneA = await zoneOf(alice);
  const zoneB = await zoneOf(bob);
  const cardA = await cardOf(zoneA, alice, { url: `https://doi.org/${doi}`, entityKeys: [] });
  const cardB = await cardOf(zoneB, bob, { url: `https://doi.org/${doi.toUpperCase()}`, entityKeys: [] });
  const other = await cardOf(zoneA, alice, { url: "https://doi.org/10.1000/untouched.work", entityKeys: [] });
  await sourceChanges.record(doi, { kind: "retraction", noticeIdentifier: "10.1000/retraction.notice", date: "2026-10-01" }, { assertedBy: "crossref" });
  let marked = 0;
  for (let pass = 0; pass < 3 && marked < 2; pass += 1) marked += await upkeep.sourcePollTick();
  assert.equal(marked, 2);
  for (const card of [cardA, cardB]) {
    const row = await cardRow(card.id);
    assert.equal(row.currency, "source_changed");
    assert.equal((await service.detail(card === cardA ? alice : bob, card.zoneId, card.id)).evidence.currencyLabel, "来源已撤稿或更正");
    const [entry] = await logOf(card.id);
    assert.equal(entry.category, "correction");
    assert.equal(entry.trigger, "source_change");
    assert.match(entry.summary, /已撤稿/);
    assert.equal(entry.refs.sourceChanges[0].identifier, `doi:${doi}`);
    assert.ok(entry.refs.sourceChanges[0].firstSeenAt, "when the change was first seen is kept, so the correction's latency can be computed");
  }
  assert.equal((await cardRow(other.id)).currency, "current", "a card that cites something else is untouched");
  assert.equal((await noticesAbout(alice.id, cardA, /^你的卡片引用的来源出现了变更$/)).length, 1, "its producer is told once");
  // Read again from the start, the same change is neither marked nor logged twice.
  await db.query("UPDATE evimed_frontier.evidence_upkeep_state SET cursor=0 WHERE name='source_changes'");
  await upkeep.sourcePollTick();
  assert.equal((await logOf(cardA.id)).filter((entry) => entry.trigger === "source_change").length, 1);
});

test("the editor writes what Europe PMC says of a source into the one source-change record", options, async () => {
  const doi = "10.1000/epmc.status";
  const status = { kind: "retracted", notices: ["Retraction of publication · Retraction in · MED:123456"] };
  const editor = { available: true, model: "test-model", evidenceTarget: async () => null, evidenceCard: async () => ({}), evidenceReview: async () => ({ findings: [] }) };
  const { worker } = build({ editor, readSource: async () => ({ text: "", publicationStatus: status, coverage: "abstract" }) });
  await worker.noteStatus(`https://doi.org/${doi}`, { publicationStatus: status });
  const fact = await sourceChanges.get(doi);
  assert.equal(fact.state, "changed");
  assert.deepEqual(fact.changes.map((change) => [change.kind, change.assertedBy]), [["retraction", ["europepmc"]]]);
  await worker.noteStatus("https://doi.org/10.1000/epmc.clear", { publicationStatus: null });
  assert.equal((await sourceChanges.get("10.1000/epmc.clear")).state, "clean", "a clear status is an answered check");
  await worker.noteStatus("https://doi.org/10.1000/epmc.silent", {});
  assert.equal((await sourceChanges.get("10.1000/epmc.silent")).state, "unknown", "a missing status records nothing");
  assert.equal(worker.counters.statusRecorded, 2);
});

/** A platform card whose first claim's quotation is not in its source, and a second claim whose quotation is. */
async function platformCardWithClaims() {
  const zone = await zoneOf(PUBLISHER, { kind: "official" });
  return cardOf(zone, PUBLISHER, {
    origin: "programme", entityKeys: [], url: unique("https://example.org/trial-"),
    claims: [
      { claimId: "CLM-1", claimType: "direct", claim: "Major bleeding occurred in 9 of 100 on the drug.", sourceIndexes: [1], supportQuote: "Major bleeding occurred in 9 of 100 on the drug." },
      { claimId: "CLM-2", claimType: "direct", claim: "Stroke fell with the drug.", sourceIndexes: [1], supportQuote: "7 of 100 adults on the drug had a stroke" },
    ],
  });
}

test("a challenge on a platform card whose quotation is not in the source is judged, the claim withdrawn, and the log and the reader told", options, async () => {
  const calls = /** @type {any[]} */ ([]);
  const judge = async (/** @type {any} */ input) => { calls.push(input); return { outcome: "withdraw", reason: "原文里没有出血 9/100 这个数字。" }; };
  const { challenges, changeLog: log, followers } = build({ judge });
  const card = await platformCardWithClaims();
  assert.equal((await service.detail(bob, card.zoneId, card.id)).evidence.claims[0].verification.mark, "⚠");
  const filed = await challenges.submit(bob, card.id, { claimId: "CLM-1", reason: "原文里找不到这个数字" });
  assert.equal(filed.challenge.state, "open");
  assert.equal(filed.challenge.route, "platform_recheck");
  assert.equal(await challenges.recheckTick(), "resolved");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.verbatimCheck, "quote_not_found", "the model is told what code found");
  assert.match(calls[0].scope, /^evch_/);
  const after = (await service.detail(bob, card.zoneId, card.id)).evidence;
  assert.deepEqual(after.claims.map((claim) => claim.claimId), ["CLM-2"], "only that claim is removed");
  assert.equal(after.revision, card.revision + 1);
  assert.equal(after.withdrawn, null, "the card keeps a claim, so it stands");
  const [entry] = (await log.list({ cardId: card.id })).items;
  assert.equal(entry.category, "withdrawal");
  assert.equal(entry.trigger, "challenge");
  assert.match(entry.summary, /CLM-1.*撤回该条结论/);
  assert.equal(entry.revisionBefore, card.revision);
  assert.equal(entry.revisionAfter, card.revision + 1);
  const mine = (await challenges.listFor(bob, card.id)).items[0];
  assert.deepEqual([mine.state, mine.outcome, mine.explanation, mine.changeLogId], ["resolved", "withdraw", "原文里没有出血 9/100 这个数字。", entry.id]);
  const told = (await inbox(bob.id)).filter((notice) => /已复核/.test(notice.title));
  assert.equal(told.length, 1);
  assert.match(told[0].title, /撤回/);
  assert.deepEqual(followers.map((event) => event.kind), ["corrected"]);
});

test("a challenge ending in withdrawal of the card's only claim takes the card back with a readable explanation and no claims", options, async () => {
  const judge = async () => ({ outcome: "withdraw", reason: "原文不支持这条结论。" });
  const { challenges, followers } = build({ judge });
  const zone = await zoneOf(PUBLISHER, { kind: "official" });
  const card = await cardOf(zone, PUBLISHER, { origin: "programme", entityKeys: [], url: unique("https://example.org/only-"),
    claims: [{ claimId: "CLM-1", claimType: "direct", claim: "The drug cures everything.", sourceIndexes: [1], supportQuote: "The drug cures everything." }] });
  await challenges.submit(bob, card.id, { claimId: "CLM-1", reason: "这个说法太绝对了" });
  await challenges.recheckTick();
  const view = (await service.detail(bob, zone.id, card.id)).evidence;
  assert.deepEqual(view.claims, []);
  assert.equal(view.claimCount, 0);
  assert.equal(view.views, null);
  assert.equal(view.currency, "no_longer_updated");
  assert.equal(view.withdrawn.reason, "原文不支持这条结论。");
  assert.ok(view.withdrawn.at);
  const [entry] = (await changeLog.list({ cardId: card.id })).items;
  assert.equal(view.withdrawn.changeLogId, entry.id, "the card's explanation points at the log entry that says so");
  assert.match(entry.summary, /本卡因没有保留任何结论而一并撤回/);
  assert.deepEqual(followers.map((event) => event.kind), ["withdrawn"]);
  await assert.rejects(challenges.submit(carol, card.id, { claimId: "CLM-1", reason: "再质疑一次吧" }), { code: "evidence_card_withdrawn" });
  assert.deepEqual((await service.list(bob, new URLSearchParams(), zone.id)).items.find((item) => item.id === card.id)?.claimCount, 0, "the list says so too");
});

test("an amendment changes only that claim's wording and repairs its quotation with a passage code found in the source", options, async () => {
  const passage = "Major bleeding occurred in 3 of 100 on the drug";
  const judge = async () => ({ outcome: "amend", sourceIndex: 1, passage, amendedClaim: "Major bleeding occurred in 3 of 100 on the drug.", reason: "原文是 3/100，不是 9/100。" });
  const { challenges } = build({ judge });
  const card = await platformCardWithClaims();
  await challenges.submit(bob, card.id, { claimId: "CLM-1", reason: "数字和原文不一致" });
  assert.equal(await challenges.recheckTick(), "resolved");
  const after = (await service.detail(bob, card.zoneId, card.id)).evidence;
  const amended = after.claims.find((claim) => claim.claimId === "CLM-1");
  assert.equal(amended.claim, "Major bleeding occurred in 3 of 100 on the drug.");
  assert.equal(amended.supportQuote, passage);
  assert.equal(amended.verification.mark, "✓", "the repaired quotation is in the source");
  const untouched = after.claims.find((claim) => claim.claimId === "CLM-2");
  assert.equal(untouched.claim, "Stroke fell with the drug.");
  assert.equal(after.title, card.title);
  assert.equal(after.content.answer, card.content.answer);
  const [entry] = (await changeLog.list({ cardId: card.id })).items;
  assert.equal(entry.category, "correction");
  assert.match(entry.summary, /CLM-1.*修正/);
});

test("an upheld claim writes no revision, and a judgement that cannot be had or cannot be checked leaves the challenge open instead of becoming an outcome", options, async () => {
  const answers = /** @type {any[]} */ ([
    () => { throw new Error("provider down"); },
    () => ({ outcome: "maybe", reason: "不确定" }),
    () => ({ outcome: "uphold", sourceIndex: 1, passage: "a sentence the source never contained", reason: "编造的原文" }),
    () => ({ outcome: "uphold", sourceIndex: 1, passage: "7 of 100 adults on the drug had a stroke", reason: "原文支持这条结论。" }),
  ]);
  let asked = 0;
  const judge = async () => answers[asked++]();
  const { challenges } = build({ judge });
  const card = await platformCardWithClaims();
  const filed = await challenges.submit(bob, card.id, { claimId: "CLM-2", reason: "这条结论证据不足" });
  const state = async () => (await rows("SELECT state,outcome,attempts,last_error,available_at FROM evimed_frontier.evidence_challenges WHERE id=$1", [filed.challenge.id]))[0];
  const free = () => db.query("UPDATE evimed_frontier.evidence_challenges SET available_at=clock_timestamp() WHERE id=$1", [filed.challenge.id]);
  assert.equal(await challenges.recheckTick(), "open");
  assert.deepEqual([(await state()).state, (await state()).outcome, (await state()).last_error], ["open", null, "evidence_challenge_failed"], "a model failure is not an outcome");
  assert.equal((await state()).attempts, 1);
  assert.equal(await challenges.recheckTick(), "idle", "a challenge that was just tried waits out its back-off");
  await free();
  assert.equal(await challenges.recheckTick(), "open");
  assert.equal((await state()).last_error, "evidence_judgement_outcome_unknown", "an answer outside the closed set is dropped");
  await free();
  assert.equal(await challenges.recheckTick(), "open");
  assert.equal((await state()).last_error, "evidence_judgement_passage_not_in_source", "a passage the source does not contain is dropped");
  assert.equal((await rows("SELECT count(*)::int AS n FROM evimed_frontier.evidence_change_log WHERE card_id=$1", [card.id]))[0].n, 0, "nothing was written to the log while it was open");
  assert.equal((await cardRow(card.id)).revision, card.revision);
  await free();
  assert.equal(await challenges.recheckTick(), "resolved");
  assert.equal((await state()).outcome, "uphold");
  assert.equal((await cardRow(card.id)).revision, card.revision, "an upheld claim writes no revision");
  const [entry] = (await changeLog.list({ cardId: card.id })).items;
  assert.equal(entry.category, "searched_no_change");
  assert.match(entry.summary, /维持原结论/);
});

test("an upheld claim whose quotation is not in the source cannot stand as written: its bond is repaired, and a spent budget or no judge leaves the challenge waiting", options, async () => {
  const passage = "Major bleeding occurred in 3 of 100 on the drug";
  const calls = { n: 0 };
  const judge = async () => { calls.n += 1; return { outcome: "uphold", sourceIndex: 1, passage, reason: "原文支持这条结论的大意。" }; };
  let granted = false;
  const budget = { tryAcquireSlot: () => ({ release: () => {} }), reserve: async () => (granted ? { granted: true } : { granted: false, reason: "exhausted" }) };
  const { challenges } = build({ judge, budget });
  const card = await platformCardWithClaims();
  const filed = await challenges.submit(bob, card.id, { claimId: "CLM-1", reason: "引文找不到" });
  assert.equal(await challenges.recheckTick(), "open", "the evidence programme's day is spent");
  assert.equal(calls.n, 0, "no model call without budget");
  const waiting = (await rows("SELECT attempts,last_error FROM evimed_frontier.evidence_challenges WHERE id=$1", [filed.challenge.id]))[0];
  assert.deepEqual([waiting.attempts, waiting.last_error], [0, "evidence_budget_exhausted"], "waiting for the budget is not an attempt at the judgement");
  assert.equal((await build({ judge: null }).challenges.recheckTick()), "idle", "with no judge nothing is attempted");
  granted = true;
  await db.query("UPDATE evimed_frontier.evidence_challenges SET available_at=clock_timestamp() WHERE id=$1", [filed.challenge.id]);
  assert.equal(await challenges.recheckTick(), "resolved");
  const [entry] = (await changeLog.list({ cardId: card.id })).items;
  assert.equal(entry.category, "correction", "an uphold of a claim with no quotation in the source becomes an amendment");
  assert.equal((await service.detail(bob, card.zoneId, card.id)).evidence.claims[0].verification.mark, "✓");
});

test("a challenge on a user's card changes nothing: the verbatim check runs, its producer is told, and the producer's own later edit closes it", options, async () => {
  let judged = 0;
  const { challenges } = build({ judge: async () => { judged += 1; return {}; } });
  const zone = await zoneOf(alice);
  const card = await cardOf(zone, alice, { entityKeys: [], url: unique("https://example.org/users-"), claims: [{ claimId: "CLM-1", claimType: "direct", claim: "Major bleeding occurred in 9 of 100.", sourceIndexes: [1], supportQuote: "Major bleeding occurred in 9 of 100 on the drug" }] });
  await assert.rejects(challenges.submit(alice, card.id, { claimId: "CLM-1", reason: "我自己的卡片" }), { code: "evidence_challenge_own_card" });
  const filed = await challenges.submit(bob, card.id, { claimId: "CLM-1", reason: "原文是 3/100" });
  assert.deepEqual([filed.challenge.state, filed.challenge.route], ["notified", "producer_notice"]);
  assert.equal(await challenges.recheckTick(), "idle", "the platform judges nothing about a person's card");
  assert.equal(judged, 0);
  assert.equal((await cardRow(card.id)).revision, card.revision, "nothing was changed");
  assert.equal((await rows("SELECT count(*)::int AS n FROM evimed_frontier.evidence_change_log WHERE card_id=$1", [card.id]))[0].n, 0);
  const notices = await noticesAbout(alice.id, card, /^有读者质疑了你卡片里的一条结论$/);
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /Major bleeding occurred in 9 of 100/);
  assert.match(notices[0].body, /原文是 3\/100/);
  assert.match(notices[0].body, /没有找到这条结论的引文/, "the result of the free check is in the notice");
  await service.save(alice, { expectedRevision: card.revision, summary: "Corrected after the challenge" }, zone.id, card.id);
  assert.equal((await challenges.listFor(bob, card.id)).items[0].state, "closed");
});

test("one open challenge per reader per claim, a daily limit, and a claim the card does not have are each refused by name", options, async () => {
  const [one, two] = [{ id: "up_rate_one" }, { id: "up_rate_two" }];
  for (const reader of [one, two]) await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$1,'development')", [reader.id]);
  const { challenges } = build({ judge: async () => ({}), levers: { challengesPerDay: 3 } });
  const card = await platformCardWithClaims();
  await challenges.submit(one, card.id, { claimId: "CLM-1", reason: "第一次质疑" });
  await assert.rejects(challenges.submit(one, card.id, { claimId: "CLM-1", reason: "又质疑一次" }), { code: "evidence_challenge_exists", status: 409 });
  await challenges.submit(two, card.id, { claimId: "CLM-1", reason: "另一位读者可以提" });
  await assert.rejects(challenges.submit(one, card.id, { claimId: "CLM-9", reason: "没有这条结论" }), { code: "evidence_challenge_claim_unknown" });
  await assert.rejects(challenges.submit(one, card.id, { claimId: "CLM-2", reason: "x" }), { code: "evidence_challenge_invalid" });
  await assert.rejects(challenges.submit(one, card.id, { claimId: "CLM-2", reason: "理由", extra: 1 }), { code: "evidence_challenge_invalid" });
  await challenges.submit(one, card.id, { claimId: "CLM-2", reason: "第二条也有问题" });
  const other = await platformCardWithClaims();
  await challenges.submit(one, other.id, { claimId: "CLM-1", reason: "第三次提出" });
  await assert.rejects(challenges.submit(one, other.id, { claimId: "CLM-2", reason: "今天第四次" }), { code: "evidence_challenge_rate_limited", status: 429 });
  await challenges.submit(two, other.id, { claimId: "CLM-2", reason: "别的读者不受影响" });
  await assert.rejects(challenges.submit(one, "ec_missing", { claimId: "CLM-1", reason: "没有这张卡" }), { code: "evidence_not_found" });
  const draftZone = await zoneOf(alice);
  const draft = await service.save(alice, { title: "Draft card", subtype: "academic", summary: "s", body: "b", sources: [{ title: "t", url: unique("https://example.org/draft-"), excerpt: SOURCE_TEXT }] }, draftZone.id, null, true);
  await assert.rejects(challenges.submit(two, draft.evidence.id, { claimId: "CLM-1", reason: "还没发布的卡片" }), { code: "evidence_not_found" }, "an unpublished card is not readable, so not challengeable");
});

test("the change log cannot be updated or deleted: the database refuses, and the module has no way to ask", options, async () => {
  const log = createEvidenceChangeLog({ database: db });
  const entry = await log.append({ zoneId: "z", cardId: "c", category: "retired", trigger: "scheduled_check", facts: { lastCheckedAt: "2026-10-05" } });
  assert.match(entry.summary, /不再更新/);
  await assert.rejects(db.query("UPDATE evimed_frontier.evidence_change_log SET summary_zh='rewritten' WHERE id=$1", [entry.id]), { code: "55000", message: /append-only/ });
  await assert.rejects(db.query("DELETE FROM evimed_frontier.evidence_change_log WHERE id=$1", [entry.id]), { code: "55000" });
  await assert.rejects(db.query("TRUNCATE evimed_frontier.evidence_change_log"), { code: "55000" });
  assert.equal((await rows("SELECT summary_zh FROM evimed_frontier.evidence_change_log WHERE id=$1", [entry.id]))[0].summary_zh, entry.summary);
  assert.deepEqual(Object.keys(log).sort(), ["append", "list", "stats"], "append, read and count — nothing that rewrites");
  await assert.rejects(log.append({ zoneId: "z", cardId: "c", category: "rewritten", trigger: "scheduled_check" }), TypeError);
  await assert.rejects(log.append({ zoneId: "z", cardId: "c", category: "retired", trigger: "whim" }), TypeError);
  // Its categories and triggers are closed in the table too.
  await assert.rejects(db.query("INSERT INTO evimed_frontier.evidence_change_log(zone_id,card_id,category,trigger,summary_zh) VALUES('z','c','invented','scheduled_check','x')"), { code: "23514" });
  // Reading: newest first, in pages.
  for (let n = 0; n < 3; n += 1) await log.append({ zoneId: "paged", cardId: "pc", category: "searched_no_change", trigger: "scheduled_check" });
  const first = await log.list({ zoneId: "paged", limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextBefore);
  const second = await log.list({ zoneId: "paged", limit: 2, before: first.nextBefore });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextBefore, null);
  assert.ok(Number(first.items[0].id) > Number(first.items[1].id));
});

test("an AI-kept card nobody follows is retired after enough quiet checks over enough days, leaves the rotation, and a new matching item re-opens it", options, async () => {
  const { upkeep, worker } = build({ levers: { retireAfterChecks: 2, retireAfterDays: 7 } });
  const zone = await zoneOf(PUBLISHER, { kind: "official" });
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run) VALUES($1,true,'x','{journal}',24,5)", [zone.id]);
  const mine = drug();
  const card = await cardOf(zone, PUBLISHER, { ai: true, entityKeys: [mine], url: `https://doi.org/10.1000/${unique("quiet.")}` });
  const followed = await zoneOf(PUBLISHER, { kind: "official" });
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run) VALUES($1,true,'x','{journal}',24,5)", [followed.id]);
  const watched = await cardOf(followed, PUBLISHER, { ai: true, entityKeys: [drug()], url: unique("https://example.org/followed-") });
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id,zone_id) VALUES($1,$2)", [bob.id, followed.id]);
  const checks = async (/** @type {number} */ days) => { clock.at += days * DAY; await upkeep.watchTick(); return cardRow(card.id); };
  assert.equal((await checks(0)).no_change_checks, 1);
  assert.equal((await checks(2)).retired_at, null, "two checks over two days are not enough");
  const retired = await checks(8);
  assert.ok(retired.retired_at, "enough checks over enough days with nobody following");
  assert.equal(retired.currency, "no_longer_updated");
  assert.ok(retired.last_checked_at, "its last-checked date is kept to be shown");
  assert.equal((await service.detail(bob, zone.id, card.id)).evidence.currencyLabel, "不再更新");
  const retiredEntry = (await logOf(card.id)).find((entry) => entry.category === "retired");
  assert.ok(retiredEntry);
  assert.match(retiredEntry.summary, /不再更新.*最后核对日期/);
  assert.equal((await cardRow(watched.id)).retired_at, null, "a card whose zone someone follows is not retired");
  // It leaves the editor's rotation.
  await db.query("UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1", [zone.id]);
  await worker.schedule();
  assert.equal((await rows("SELECT count(*)::int AS n FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1", [card.id]))[0].n, 0);
  // A new matching item re-opens it.
  clock.at += 2 * DAY;
  await itemOf({ entityKeys: [mine], title: "A study after retirement", minutesAfter: 60 });
  await upkeep.watchTick();
  const reopened = await cardRow(card.id);
  assert.equal(reopened.retired_at, null);
  assert.equal(reopened.currency, "new_evidence_pending");
  assert.equal(reopened.no_change_checks, 0);
});

test("a producer retires and re-opens their own card, and says they have read the new studies; no one else may", options, async () => {
  const { upkeep } = build();
  const mine = drug();
  const zone = await zoneOf(alice);
  const card = await cardOf(zone, alice, { entityKeys: [mine], url: `https://doi.org/10.1000/${unique("mine.")}` });
  await assert.rejects(upkeep.setUpkeep(bob, card.id, { action: "retire" }), { code: "evidence_not_found" });
  await assert.rejects(upkeep.setUpkeep(alice, card.id, { action: "delete" }), { code: "evidence_upkeep_action_invalid" });
  await assert.rejects(upkeep.setUpkeep(alice, card.id, { action: "reviewed" }), { code: "evidence_upkeep_action_invalid" }, "there is nothing waiting to have been read");
  const retired = await upkeep.setUpkeep(alice, card.id, { action: "retire" });
  assert.equal(retired.currency, "no_longer_updated");
  const [entry] = await logOf(card.id);
  assert.equal(entry.category, "retired");
  assert.equal(entry.trigger, "producer_edit");
  assert.match(entry.summary, /出品方说明/);
  const reopened = await upkeep.setUpkeep(alice, card.id, { action: "reopen" });
  assert.equal(reopened.currency, "current");
  await itemOf({ entityKeys: [mine], title: "To be read" });
  await upkeep.watchTick();
  assert.equal((await cardRow(card.id)).currency, "new_evidence_pending");
  const read = await upkeep.setUpkeep(alice, card.id, { action: "reviewed" });
  assert.equal(read.currency, "current");
  const latest = (await logOf(card.id))[0];
  assert.equal(latest.category, "new_evidence_conclusion_unchanged");
  assert.match(latest.summary, /认为不影响本卡/);
});

test("the three monthly figures are computed from the tables: verification pass rate, median correction latency, and the challenges and their outcomes", options, async () => {
  // Fixed data in March 2026, Asia/Shanghai; nothing here depends on today's date.
  const figures = monthlyEvidenceFigures;
  const isolatedZone = await zoneOf(alice, { title: "Figures zone" });
  const card = await cardOf(isolatedZone, alice, { entityKeys: [], url: unique("https://example.org/figures-"), claims: [
    { claimId: "CLM-1", claimType: "direct", claim: "Stroke fell.", sourceIndexes: [1], supportQuote: "7 of 100 adults on the drug had a stroke" },
    { claimId: "CLM-2", claimType: "direct", claim: "Bleeding.", sourceIndexes: [1], supportQuote: "Major bleeding occurred in 3 of 100 on the drug" },
    { claimId: "CLM-3", claimType: "direct", claim: "Bleeding rose.", sourceIndexes: [1], supportQuote: "Major bleeding occurred in 90 of 100 on the drug" },
  ] });
  await db.query("UPDATE evimed_frontier.evidence_card_revisions SET recorded_at='2026-03-05T04:00:00Z' WHERE card_id=$1", [card.id]);
  const month = async () => figures(db, { month: "2026-03" });
  // The fixed log of the month: two corrections that started with a signal (12 h and 24 h), one that did not, and one of the next month.
  const challengeAt = (/** @type {string} */ id, /** @type {string} */ created, /** @type {string} */ state, /** @type {string | null} */ outcome, /** @type {string} */ route = "platform_recheck") =>
    db.query(`INSERT INTO evimed_frontier.evidence_challenges(id,card_id,zone_id,claim_id,user_id,reason,card_revision,route,state,outcome,created_at) VALUES($1,$2,$3,$4,$5,'r',1,$6,$7,$8,$9)`,
      [id, card.id, card.zoneId, `CLM-${id.slice(-1)}`, bob.id, route, state, outcome, created]);
  await challengeAt("ch_fixed_1", "2026-03-10T00:00:00Z", "resolved", "uphold");
  await challengeAt("ch_fixed_2", "2026-03-12T00:00:00Z", "resolved", "amend");
  await challengeAt("ch_fixed_3", "2026-03-14T00:00:00Z", "resolved", "withdraw");
  await challengeAt("ch_fixed_4", "2026-03-15T00:00:00Z", "notified", null, "producer_notice");
  await challengeAt("ch_fixed_5", "2026-02-28T15:00:00Z", "resolved", "uphold");
  await challengeAt("ch_fixed_6", "2026-03-31T16:30:00Z", "resolved", "uphold");
  const entry = (/** @type {string} */ category, /** @type {string} */ trigger, /** @type {string} */ at, /** @type {any} */ refs = {}) =>
    db.query("INSERT INTO evimed_frontier.evidence_change_log(zone_id,card_id,category,trigger,summary_zh,refs,occurred_at) VALUES($1,$2,$3,$4,'x',$5::jsonb,$6)", [card.zoneId, card.id, category, trigger, JSON.stringify(refs), at]);
  await entry("correction", "source_change", "2026-03-10T12:00:00Z", { sourceChanges: [{ identifier: "doi:10.1/x", kind: "retraction", firstSeenAt: "2026-03-10T00:00:00Z" }] });
  await entry("withdrawal", "challenge", "2026-03-13T00:00:00Z", { challengeId: "ch_fixed_2" });
  await entry("correction", "producer_edit", "2026-03-20T00:00:00Z");
  await entry("searched_no_change", "scheduled_check", "2026-03-21T00:00:00Z");
  await entry("correction", "source_change", "2026-04-02T00:00:00Z", { sourceChanges: [{ identifier: "doi:10.1/y", kind: "correction", firstSeenAt: "2026-04-01T00:00:00Z" }] });
  const march = await month();
  assert.deepEqual(march.verification, { cards: 1, claims: 3, verified: 2, passRate: 0.6667 }, "the claim whose quotation is not in its source is the one that fails");
  assert.equal(march.corrections.entries, 2, "a correction with no signal behind it, a no-change and another month's are not latencies");
  assert.equal(march.corrections.medianLatencyHours, 18, "12 hours from the first sighting and 24 hours from the challenge");
  assert.deepEqual(march.corrections.bySource, { source_change: { entries: 1, medianLatencyHours: 12 }, challenge: { entries: 1, medianLatencyHours: 24 } });
  assert.deepEqual(march.challenges, { filed: 4, upheld: 1, amended: 1, withdrawn: 1, producerNotified: 1, closed: 0, open: 0, upheldShare: 0.3333 });
  assert.equal(march.month, "2026-03");
  assert.equal(march.from, "2026-02-28T16:00:00.000Z", "a month begins at midnight in Shanghai");
  // A month with nothing in it has no median and no rate: null, never zero.
  const empty = await figures(db, { month: "2020-01" });
  assert.deepEqual([empty.verification.passRate, empty.corrections.medianLatencyHours, empty.challenges.upheldShare, empty.challenges.filed], [null, null, null, 0]);
  await assert.rejects(figures(db, { month: "2026-13" }), { code: "evidence_query_invalid" });
  await assert.rejects(figures(db, { month: "March" }), { code: "evidence_query_invalid" });
});

test("a changed source reaches the result impact path and the memory labels from the same feed: the accounts that cite it, a bounded number a tick, the position kept until all were asked", options, async () => {
  const impacts = /** @type {any[]} */ ([]);
  const labels = /** @type {any[]} */ ([]);
  const resultImpacts = { reconcileSince: async (/** @type {string} */ userId, /** @type {any} */ input) => { impacts.push([userId, input.projectId, input.since, input.limit]); return { items: [] }; } };
  const knowledgeChange = { labelSince: async (/** @type {string} */ ownerId, /** @type {string} */ projectId, /** @type {any} */ input) => { labels.push([ownerId, projectId, input.since]); return { items: [] }; } };
  const { upkeep } = build({ resultImpacts, knowledgeChange });
  const doi = `10.1000/${unique("downstream.")}`;
  const accounts = Array.from({ length: 22 }, (_, index) => `up_res_${index}_${counter}`);
  for (const [index, id] of accounts.entries()) {
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$1,'development')", [id]);
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p1','P',1048576)", [id]);
    // Every spelling a result may record a DOI in is one source; an account that cites another work is not asked.
    const cited = index % 2 ? `https://doi.org/${doi.toUpperCase()}` : doi;
    await documents.put(id, "result-version", "rv_1", { recordType: "result-version", versionId: "rv_1", inputs: [{ kind: "source", id: index === 21 ? "10.1000/another.work" : cited }] }, { expectedRevision: 0, projectId: "p1" });
  }
  await db.query("CREATE SCHEMA IF NOT EXISTS evimed_memory");
  await db.query("CREATE TABLE IF NOT EXISTS evimed_memory.record_sources(user_id text, record_id text, source_type text, source_id text)");
  const rememberer = `up_mem_${counter}`;
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$1,'development')", [rememberer]);
  await db.query("INSERT INTO evimed_memory.record_sources(user_id,record_id,source_type,source_id) VALUES($1,'m1','doi',$2)", [rememberer, doi]);
  await sourceChanges.record(doi, { kind: "retraction", noticeIdentifier: "10.1000/downstream.notice" }, { assertedBy: "crossref" });
  // 21 accounts name the work (22 minus the one that cites another) and one holds a memory of it: 22 to ask, 20 a tick.
  assert.equal(await upkeep.downstreamTick(), 20);
  assert.equal(impacts.length, 20);
  const position = (await rows("SELECT cursor::int AS cursor,payload FROM evimed_frontier.evidence_upkeep_state WHERE name='downstream'"))[0];
  assert.deepEqual(position.payload, { offset: 20 }, "the page is not left behind until every account of it was asked");
  assert.equal(await upkeep.downstreamTick(), 2);
  const finished = (await rows("SELECT cursor::int AS cursor,payload FROM evimed_frontier.evidence_upkeep_state WHERE name='downstream'"))[0];
  assert.deepEqual(finished.payload, {});
  assert.ok(finished.cursor > position.cursor, "now the position moved past the page");
  const asked = new Set(impacts.map((call) => call[0]));
  assert.equal(asked.size, 21, "each account that cites the work was asked once");
  assert.ok(!asked.has(accounts[21]), "the account that cites another work was not");
  assert.deepEqual(new Set(impacts.map((call) => call[1])), new Set(["p1"]));
  assert.ok(impacts.every((call) => call[3] > 0 && call[2] === 0), "each is given the position of the feed it is to read from, and a bounded page");
  assert.deepEqual(labels.filter((call) => call[0] === rememberer), [[rememberer, "-", 0]], "an account with only a memory of it is asked for the labels, with no project");
  assert.ok(labels.length >= 22, "the memory labels are driven for the accounts with results too");
  const again = impacts.length;
  assert.equal(await upkeep.downstreamTick(), 0);
  assert.equal(impacts.length, again, "nothing new on the feed, nothing asked");
  assert.equal(await build().upkeep.downstreamTick(), 0, "built without the readers it asks no one");
});

test("the card's identifier keys are the sources' and the verified study's, in the one record's form", () => {
  assert.deepEqual(cardIdentifierKeys({
    sources: [{ url: "https://doi.org/10.1000/ABC" }, { url: "https://pubmed.ncbi.nlm.nih.gov/12345/" }, { url: "https://clinicaltrials.gov/study/NCT01234567" }, { url: "https://example.org/page" }],
    lineage: { verifiedStudy: { doi: "10.1000/other", registryId: "NCT07654321" } },
  }), ["doi:10.1000/abc", "doi:10.1000/other", "pmid:12345", "reg:NCT01234567", "reg:NCT07654321"]);
});
