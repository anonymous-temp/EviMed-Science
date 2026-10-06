// The flywheel's figures against a real PostgreSQL (evidence-flywheel plan §11, 2026-10-06): the north star counts verified cards once however many
// ways they were used, leaves out what is not a verified published card, says null with a reason where a signal's table does not exist, and the
// guardrails read the rows.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { FLYWHEEL_MAX_WEEKS, createEvidenceFlywheelMetrics, flywheelWeekOf } from "../src/evidenceFlywheelMetrics.mjs";
import { EvidenceOrigins } from "../src/evidenceOrigins.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createStore } from "../src/store.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const publisher = { id: PLATFORM_PUBLISHER_USER_ID };
const alice = { id: "alice" };
const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
// 2026-10-07 is a Wednesday: the week is 2026-10-05 (Monday) to 2026-10-11.
const WEDNESDAY = new Date("2026-10-07T04:00:00.000Z");
const MONDAY = "2026-10-05";

const card = (title, claims, extra = {}) => ({
  title, subtype: "academic", summary: `${title} summary.`, body: "The body.", state: "published", limitations: "One trial.", provenance: "p",
  sources: [{ title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: TEXT, coverage: "full-text" }],
  content: { question: "Does it prevent stroke?", answer: "Fewer strokes were seen." },
  claims, ...extra,
});
const found = { claimId: "CLM-001", claimType: "direct", claim: "Stroke was less frequent on the drug.", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" };
const lost = { claimId: "CLM-002", claimType: "direct", claim: "Nobody died.", sourceIndexes: [1], supportQuote: "No one died in either group" };

/** @type {any} */ let isolated, store, db, zones, ledger, dataDir, official, userZone, productZone;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "flywheel");
  dataDir = await mkdtemp(join(tmpdir(), "evidence-flywheel-"));
  store = createStore({ stateStore: "postgres", databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000, dataDir, maxProjectBytes: 1_048_576 });
  db = store.database;
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development') ON CONFLICT DO NOTHING");
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_control.users WHERE id=$1", [PLATFORM_PUBLISHER_USER_ID])).rows[0].n, 1, "the store seeds the publisher account");
  await migrateUsageLedger(db);
  ledger = new UsageLedger(db);
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID });
});
after(async () => {
  await store?.close();
  await isolated?.drop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
  await db.query("DROP SCHEMA IF EXISTS evimed_geo CASCADE");
  await db.query("DELETE FROM evimed_usage.model_requests");
  const made = (await zones.saveEditorial(publisher, { title: "Official", description: "d", background: "b", kind: "official" }, null, null, false, "programme")).zone;
  official = (await zones.saveEditorial(publisher, { expectedRevision: made.revision, state: "published" }, made.id, null, false, "programme")).zone;
  const owned = (await zones.save(alice, { title: "Alice zone", description: "d", background: "b" })).zone;
  const live = (await zones.save(alice, { expectedRevision: owned.revision, state: "published" }, owned.id)).zone;
  userZone = (await zones.setVisibility(alice, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
  const product = (await zones.save(alice, { title: "Alice product zone", description: "d", background: "b", kind: "product" })).zone;
  productZone = (await zones.save(alice, { expectedRevision: product.revision, state: "published" }, product.id)).zone;
});

const officialCard = (input) => zones.saveEditorial(publisher, input, official.id, null, true, "programme").then((result) => result.evidence);
const aliceCard = (input, zone = userZone, origin = "result") => zones.saveEditorial(alice, input, zone.id, null, true, /** @type {any} */ (origin)).then((result) => result.evidence);
const metrics = (extra = {}) => createEvidenceFlywheelMetrics({ database: db, platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID, now: () => WEDNESDAY, ...extra });
const read = (cardId, zoneId, day = MONDAY, reads = 3) => db.query("INSERT INTO evimed_frontier.evidence_page_reads(zone_id,card_id,day,reads) VALUES($1,$2,$3,$4)", [zoneId, cardId, day, reads]);

test("a week is Monday to Monday in Asia/Shanghai: a Sunday-night instant UTC is already Monday there", () => {
  assert.equal(flywheelWeekOf(WEDNESDAY).week, MONDAY);
  assert.equal(flywheelWeekOf(WEDNESDAY).from.toISOString(), "2026-10-04T16:00:00.000Z");
  assert.equal(flywheelWeekOf(new Date("2026-10-04T16:00:00.000Z")).week, MONDAY, "Sunday 16:00 UTC is Monday 00:00 in Shanghai");
  assert.equal(flywheelWeekOf(new Date("2026-10-04T15:59:59.000Z")).week, "2026-09-28");
  assert.equal(flywheelWeekOf(new Date("2026-10-11T15:59:59.000Z")).week, MONDAY, "the week's last instant");
});

test("verified cards used: counted once however many ways name them, and only a published, non-product, non-withdrawn card with a ✓ counts", options, async () => {
  const both = await officialCard(card("Read and cited", [found]));
  const researched = await aliceCard(card("Researched by Bob", [found, lost]));
  const own = await aliceCard(card("Only its author researched it", [found]));
  const warned = await officialCard(card("Nothing found", [lost]));
  const taken = await officialCard(card("Withdrawn later", [found]));
  const product = await aliceCard(card("A product card", [found], { producer: { kind: "enterprise", name: "Acme", relation: "own_product", products: ["Drug A"] },
    journeyStage: { key: "treatment-choice", label: "治疗选择" }, disclosure: { authors: [{ name: "Dr. Li", affiliation: "PUMCH", title: "主任医师" }], reviewers: [{ name: "Dr. Wang", title: "Pharmacist" }] } }), productZone, "owner");
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn=jsonb_build_object('at',now(),'reason','r') WHERE id=$1", [taken.id]);
  // Readings: the first card on two days (one card), the warned, withdrawn and product cards, and a reading outside the week.
  await read(both.id, official.id, MONDAY); await read(both.id, official.id, "2026-10-06");
  for (const entry of [warned, taken]) await read(entry.id, official.id);
  await read(product.id, productZone.id);
  await read(researched.id, userZone.id, "2026-10-04");
  const origins = new EvidenceOrigins({ database: db });
  await origins.runStarted({ userId: "bob", id: "p1" }, { id: "r1", originCardId: both.id });
  await origins.runStarted({ userId: "bob", id: "p1" }, { id: "r2", originCardId: researched.id });
  await origins.runStarted({ userId: "alice", id: "p1" }, { id: "r3", originCardId: own.id });
  const view = await metrics().snapshot({ weeks: 2 });
  const star = view.northStar[0];
  assert.equal(star.week, MONDAY);
  assert.deepEqual(star.verifiedCardsUsed, { value: 2, deduplicated: true, signalsAnswering: 2, signalsAsked: 5 }, "read∪research: the first card twice, Bob's research of the second; not the author's own, not ⚠, not withdrawn, not product");
  assert.deepEqual(star.ways.read, { value: 1, basis: "page_open" });
  assert.deepEqual(star.ways.research, { value: 2 });
  for (const way of ["communication", "vcr", "assistant"]) {
    assert.equal(star.ways[way].value, null, way);
    assert.match(star.ways[way].reason, /\S/, `${way} says why`);
  }
  assert.equal(view.northStar[1].week, "2026-09-28");
  assert.equal(view.northStar[1].verifiedCardsUsed.value, 1, "the Sunday reading of the second card belongs to the week before");
});

test("a reading on the Sunday before the week belongs to the earlier week", options, async () => {
  const entry = await officialCard(card("Sunday card", [found]));
  await read(entry.id, official.id, "2026-10-04");
  const view = await metrics().snapshot({ weeks: 2 });
  assert.equal(view.northStar[0].ways.read.value, 0);
  assert.equal(view.northStar[1].ways.read.value, 1);
});

test("a signal another package adds is read once its columns exist, and its failure is left out rather than counted as zero", options, async () => {
  const entry = await officialCard(card("Cited by an article", [found]));
  const other = await officialCard(card("Cited in an article's text", [found]));
  await db.query("CREATE SCHEMA evimed_geo");
  await db.query("CREATE TABLE evimed_geo.articles (card_id text, claim_refs jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now())");
  await db.query("INSERT INTO evimed_geo.articles(card_id,created_at) VALUES($1,$2)", [entry.id, WEDNESDAY]);
  await db.query("INSERT INTO evimed_geo.articles(claim_refs,created_at) VALUES($1,$2)", [JSON.stringify([{ cardId: other.id, claimId: "CLM-001" }]), WEDNESDAY]);
  await db.query("INSERT INTO evimed_geo.articles(card_id,created_at) VALUES($1,$2)", [entry.id, "2026-09-01T00:00:00Z"]);
  let failures = 0;
  const view = await metrics({
    citationReaders: { vcr: async () => ({ cards: [entry.id] }), assistant: async () => { failures += 1; throw new Error("down"); } },
  }).snapshot({ weeks: 1 });
  const star = view.northStar[0];
  assert.equal(star.ways.communication.value, 2, "the article's card and the card its text references, inside the week only");
  assert.equal(star.ways.vcr.value, 1);
  assert.equal(star.ways.assistant.value, null);
  assert.match(star.ways.assistant.reason, /failed/);
  assert.equal(failures, 1);
  assert.equal(star.verifiedCardsUsed.value, 2);
  assert.equal(star.verifiedCardsUsed.signalsAnswering, 4, "page reads, research, communication and vcr answered; the failed one is not an answer");
});

test("the guardrails read the rows: a card without a producer, a card its zone's owner did not write, a simulated value", options, async () => {
  const fine = await officialCard(card("Fine", [found]));
  const clean = await metrics().snapshot({ weeks: 1 });
  assert.equal(clean.guardrails.cardsWithoutProducer.value, 0);
  assert.equal(clean.guardrails.writesOutsideAllowList.value, 0);
  assert.equal(clean.guardrails.simulatedValuesInCards.value, 0);
  await db.query("UPDATE evimed_frontier.evidence_cards SET producer=NULL WHERE id=$1", [fine.id]);
  const mine = await aliceCard(card("Alice's", [found]));
  await db.query("UPDATE evimed_frontier.evidence_cards SET user_id='bob' WHERE id=$1", [mine.id]);
  // The writer refuses a simulated value, so a stored one is made the way a defect would make it: past the writer.
  const mixed = await officialCard(card("Mixed", [found]));
  const derived = await officialCard(card("Derived", [found]));
  await db.query("UPDATE evimed_frontier.evidence_cards SET claims=$2::jsonb WHERE id=$1", [mixed.id, JSON.stringify([{ ...found, valueSource: "predicted" }])]);
  await db.query("UPDATE evimed_frontier.evidence_cards SET claims=$2::jsonb WHERE id=$1", [derived.id, JSON.stringify([{ ...found, valueSource: "imputed" }])]);
  const bad = await metrics().snapshot({ weeks: 1 });
  assert.equal(bad.guardrails.cardsWithoutProducer.value, 1);
  assert.equal(bad.guardrails.writesOutsideAllowList.value, 1, "Bob's card in Alice's zone");
  assert.equal(bad.guardrails.simulatedValuesInCards.value, 1, "the predicted value; an imputed one outside a derived claim is counted apart");
  assert.equal(bad.guardrails.simulatedValuesInCards.derivedOnlyValuesOutsideDerivedClaims, 1);
  // An official zone whose card is not the publisher's is outside the allow-list; with no publisher configured the check is silent.
  await db.query("UPDATE evimed_frontier.evidence_cards SET user_id='alice' WHERE id=$1", [fine.id]);
  assert.equal((await metrics().snapshot({ weeks: 1 })).guardrails.writesOutsideAllowList.value, 2);
  const unconfigured = await createEvidenceFlywheelMetrics({ database: db, now: () => WEDNESDAY }).snapshot({ weeks: 1 });
  assert.equal(unconfigured.guardrails.writesOutsideAllowList.value, 1, "no publisher configured: only the zone-owner half is checked");
});

test("a platform card withdrawn after a reader's challenge is a share of the platform cards that were challenged", options, async () => {
  const none = await metrics().snapshot({ weeks: 1 });
  assert.equal(none.guardrails.platformCardsWithdrawnAfterChallenge.value, null);
  assert.match(none.guardrails.platformCardsWithdrawnAfterChallenge.reason, /challenged/);
  const kept = await officialCard(card("Kept", [found]));
  const taken = await officialCard(card("Taken back", [found]));
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn=jsonb_build_object('at',now(),'reason','r') WHERE id=$1", [taken.id]);
  const file = (cardId, outcome) => db.query(
    `INSERT INTO evimed_frontier.evidence_challenges(id,card_id,zone_id,claim_id,user_id,reason,card_revision,route,state,outcome)
     VALUES($1,$2,$3,'CLM-001','bob','r',1,'platform_recheck','resolved',$4)`, [`ch_${randomUUID().replaceAll("-", "")}`, cardId, official.id, outcome]);
  await file(kept.id, "uphold");
  await file(taken.id, "withdraw");
  const view = await metrics().snapshot({ weeks: 1 });
  assert.deepEqual(view.guardrails.platformCardsWithdrawnAfterChallenge, { value: 0.5, numerator: 1, denominator: 2 });
});

test("cost per verified claim is the programme's spend over the ✓ claims its revisions added to platform cards in the week, net of the week before", options, async () => {
  const spendAt = async (cost, at) => {
    const id = randomUUID();
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-evidence','Evidence',1048576) ON CONFLICT DO NOTHING", [PLATFORM_PUBLISHER_USER_ID]);
    const reserved = await ledger.reserveModel({ id, userId: PLATFORM_PUBLISHER_USER_ID, projectId: "evimed-evidence", purpose: "evidence", model: "deepseek-v4-flash", priceVersion: "evimed-reference-2026-09-05",
      currency: "CNY", requestFingerprint: createHash("sha256").update(id).digest("hex"), estimatedCost: Math.max(cost, 0.01), dailyLimit: 0, weeklyLimit: 0, now: at });
    await ledger.settleModel(PLATFORM_PUBLISHER_USER_ID, reserved.id, { usage: { cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 5 }, actualCost: cost, priced: true });
  };
  const empty = await metrics().snapshot({ weeks: 1 });
  assert.equal(empty.guardrails.costPerVerifiedClaim.value, null);
  const entry = await officialCard(card("Costed", [found, { ...found, claimId: "CLM-004", supportQuote: "Among 100 adults on usual care, 12 had a stroke" }]));
  await db.query("UPDATE evimed_frontier.evidence_card_revisions SET recorded_at=$2 WHERE card_id=$1", [entry.id, WEDNESDAY]);
  await spendAt(1.5, WEDNESDAY);
  await spendAt(0.5, new Date("2026-09-20T00:00:00Z"));
  const view = await metrics().snapshot({ weeks: 1 });
  assert.deepEqual(view.guardrails.costPerVerifiedClaim, { value: 0.75, unit: "CNY per ✓ claim", spendCny: 1.5, verifiedClaimsAdded: 2 }, "the earlier week's spend is not this week's");
  // Revising the card the next week to add nothing adds nothing: the figure is the net.
  const later = new Date(WEDNESDAY.getTime() + 7 * 86_400_000);
  await db.query("INSERT INTO evimed_frontier.evidence_card_revisions(card_id,revision,snapshot,recorded_at) SELECT card_id,revision+1,snapshot,$2 FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1 ORDER BY revision DESC LIMIT 1", [entry.id, later]);
  await spendAt(0.4, later);
  const next = await createEvidenceFlywheelMetrics({ database: db, platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID, now: () => later }).snapshot({ weeks: 1 });
  assert.equal(next.guardrails.costPerVerifiedClaim.value, null, "money was spent and no ✓ claim was added");
  assert.equal(next.guardrails.costPerVerifiedClaim.spendCny, 0.4);
  assert.match(next.guardrails.costPerVerifiedClaim.reason, /spent money/);
});

test("the asset groups report what exists and say null with a reason for what does not", options, async () => {
  await officialCard(card("Base card", [found, lost]));
  await aliceCard(card("Alice's card", [found]));
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id,zone_id) VALUES('bob',$1)", [userZone.id]);
  const view = await metrics({ evolutionTools: async () => [{ status: "active", validationLevel: "V2" }, { status: "active", validationLevel: "V1" }, { status: "retired", validationLevel: "V3" }],
    predictionCalibration: async () => ({ available: false, scored: 3 }) }).snapshot({ weeks: 1 });
  assert.deepEqual(view.assets.evidenceBase.currentCards, { value: 2, byZoneKind: { official: 1, user: 1 } });
  assert.deepEqual(view.assets.evidenceBase.currentShare, { value: 1, numerator: 2, denominator: 2 });
  assert.equal(view.assets.evidenceBase.verifiedClaims.value, 2, "one ✓ claim on each card; the ⚠ one is not counted");
  assert.deepEqual(view.assets.toolLibrary.toolsAtV2OrAbove, { value: 1, activeTools: 2 });
  assert.equal(view.assets.publicRecord.predictionBrier.value, null);
  assert.match(view.assets.publicRecord.predictionBrier.reason, /3 predictions/);
  assert.deepEqual([view.assets.network.publicAuthors.value, view.assets.network.userPublishedCards.value, view.assets.network.follows.value], [1, 1, 1]);
  assert.equal(view.assets.measurement.questionBankRounds.value, null);
  const bare = await metrics().snapshot({ weeks: 1 });
  assert.equal(bare.assets.toolLibrary.toolsAtV2OrAbove.value, null);
  assert.match(bare.assets.toolLibrary.toolsAtV2OrAbove.reason, /not enabled/);
  assert.deepEqual(bare.definition.notOutcomes, ["card count", "page views", "words generated"]);
});

test("weeks is a whole number from 1 to the cap, and the scrape reuses one snapshot and exports no series for a figure it cannot compute", options, async () => {
  for (const weeks of [0, 27, 1.5, Number.NaN]) await assert.rejects(metrics().snapshot({ weeks }), { code: "evidence_query_invalid", status: 400 }, String(weeks));
  assert.equal(FLYWHEEL_MAX_WEEKS, 26);
  let clock = WEDNESDAY.getTime();
  const subject = createEvidenceFlywheelMetrics({ database: db, platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID, now: () => new Date(clock) });
  const first = await subject.metricFamilies();
  const names = first.map((family) => family.name);
  assert.deepEqual(names, ["open_science_evidence_flywheel_snapshots_total", "open_science_evidence_flywheel_verified_cards_used", "open_science_evidence_flywheel_guardrail", "open_science_evidence_flywheel_assets"]);
  const used = first.find((family) => family.name === "open_science_evidence_flywheel_verified_cards_used");
  assert.deepEqual(used?.series.map((entry) => entry.labels?.way), ["any", "read", "research"], "the three signals with no input have no series, not a zero");
  const guard = first.find((family) => family.name === "open_science_evidence_flywheel_guardrail");
  assert.deepEqual(guard?.series.map((entry) => entry.labels?.guard), ["cardsWithoutProducer", "writesOutsideAllowList", "simulatedValuesInCards"]);
  await subject.metricFamilies();
  assert.equal(subject.stats().snapshots, 1, "a second scrape inside the keeping time reuses the snapshot");
  clock += 11 * 60_000;
  await subject.metricFamilies();
  assert.equal(subject.stats().snapshots, 2);
});
