import assert from "node:assert/strict";
import http from "node:http";
import { before, after, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { createEvidenceZoneRoutes } from "../src/evidenceZoneRoutes.mjs";
import { EVIDENCE_ZONE_SQL } from "../src/evidenceZonePersistence.mjs";
import { evidenceCardMetricFamilies, resetEvidenceCardMetrics } from "../src/evidenceCardMetrics.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
const bob = { id: "bob" };
const publisher = { id: "publisher" };

const DOCUMENT = "In this randomized trial, 12 of 100 adults on usual care had a stroke. Among 100 adults on the drug, 7 had a stroke. Major bleeding occurred in 3 of 100 on the drug and 1 of 100 on usual care.";
const comparisons = [
  {
    title: "Stroke", outcome: "Stroke", timeframe: "2 years", denominator: 100,
    control: { label: "Usual care", events: 12 }, intervention: { label: "Drug", events: 7 },
    relativeEffect: "RR 0.58", certainty: "moderate", participants: 4200, studies: 3, outcomeRole: "benefit", sourceIndexes: [1],
  },
  {
    title: "Bleeding", outcome: "Major bleeding", timeframe: "2 years", denominator: 100,
    control: { label: "Usual care", events: 1 }, intervention: { label: "Drug", events: 3 }, outcomeRole: "harm", sourceIndexes: [1],
  },
];
const cardInput = {
  title: "Does the drug prevent stroke?",
  subtype: "academic",
  summary: "A randomized trial summary.",
  body: "The trial reports fewer strokes and more bleeding.",
  sources: [{ title: "Trial", url: "https://example.org/trial", excerpt: DOCUMENT }],
  limitations: "One trial.",
  provenance: "Authored synthesis",
  content: { question: "Does it prevent stroke?", answer: "Fewer strokes, more bleeding.", population: "Adults", comparisons },
  claims: [
    { claimId: "CLM-001", claimType: "direct", claim: "Stroke was less frequent on the drug.", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" },
    { claimId: "CLM-002", claimType: "direct", claim: "Bleeding was more frequent.", sourceIndexes: [1], supportQuote: "Major bleeding occurred in 3 of 100 on the drug and 9 of 100 on usual care" },
  ],
};
const productFields = {
  producer: { kind: "enterprise", name: "Acme Pharma", relation: "own_product", products: ["Drug A"] },
  journeyStage: { key: "treatment-choice", label: "治疗选择" },
  disclosure: { authors: [{ name: "Dr. Li", affiliation: "PUMCH" }], reviewers: [{ name: "Dr. Wang", title: "Pharmacist" }] },
};

let isolated, db, service, legacy, resolver;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "evidencecard");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development'),('publisher','Platform publisher','development')");
  resolver = { calls: [], answer: /** @type {any} */ (null), fail: false };
  service = new EvidenceZoneService({
    database: db,
    platformPublisherUserId: "publisher",
    entityKeysFor: async (input) => {
      resolver.calls.push(input);
      if (resolver.fail) throw new Error("glossary unavailable");
      return resolver.answer ?? [];
    },
  });
  // The state before flywheel B2: no publisher account is configured.
  legacy = new EvidenceZoneService({ database: db });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones,evimed_frontier.items,evimed_frontier.sources CASCADE");
  resolver.calls = [];
  resolver.answer = null;
  resolver.fail = false;
  resetEvidenceCardMetrics();
});

const makeZone = async (user = alice, { kind, published = true } = /** @type {any} */ ({})) => {
  const { zone } = await service.save(user, { title: "A zone", description: "d", background: "b", ...(kind ? { kind } : {}) });
  return published ? (await service.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone : zone;
};
const officialZone = async () => {
  const { zone } = await service.saveEditorial(publisher, { title: "Official", description: "d", background: "b", kind: "official" }, null, null, false, "programme");
  return (await service.saveEditorial(publisher, { expectedRevision: zone.revision, state: "published" }, zone.id, null, false, "programme")).zone;
};
const saveCard = (zone, fields = {}, user = alice) => service.save(user, { ...cardInput, ...fields }, zone.id, null, true).then((result) => result.evidence);
// ✓ means the platform read the source: its own writers keep the receipt of the bytes it read beside the excerpt, and a writer's
// session cannot send one. `saveCard` is the account's own write; this is a card whose sources the platform has read.
const PLATFORM_READ = [{ ...cardInput.sources[0], fetchedSha256: "f".repeat(64) }];
const saveReadCard = (zone, fields = {}, user = alice) => service.saveEditorial(user, { ...cardInput, sources: PLATFORM_READ, ...fields }, zone.id, null, true, "result").then((result) => result.evidence);
const metric = (name, labels = {}) => {
  const family = evidenceCardMetricFamilies({ cardsWithoutProducer: 0 }).find((entry) => entry.name === name);
  const series = family?.series.find((entry) => Object.entries(labels).every(([key, value]) => entry.labels?.[key] === value));
  return series?.value;
};

test("a card built from claims returns each claim with ✓ or ⚠ and both views, the numbers computed by code", options, async () => {
  const zone = await makeZone();
  // The same card as the account itself writes it has only an excerpt it typed, which the platform has not read.
  const typed = await saveCard(zone, { requestId: "typed-excerpt-card" });
  assert.deepEqual(typed.claims.map((claim) => claim.verification.status), ["author_excerpt_only", "source_unavailable"]);
  assert.deepEqual(typed.claims.map((claim) => claim.verification.mark), ["⚠", "⚠"]);
  assert.equal(typed.claimVerification.verified, 0);
  const card = await saveReadCard(zone);
  assert.equal(card.claims.length, 2);
  assert.equal(card.claims[0].verification.status, "verified");
  assert.equal(card.claims[0].verification.mark, "✓");
  assert.equal(card.claims[1].verification.status, "quote_not_found");
  assert.equal(card.claims[1].verification.mark, "⚠");
  assert.equal(card.claimCount, 2);
  assert.deepEqual(card.claimVerification, { total: 2, verified: 1, quote_not_found: 1, source_unavailable: 0, no_quote: 0, derived: 0 });
  // The author typed no absolute number; the clinical view's are the code's: 12/100 and 7/100 per 1000.
  const [stroke, bleeding] = card.views.clinical.rows;
  assert.deepEqual(stroke.absoluteEffect, { status: "computed", per: 1000, unit: "people", control: 120, intervention: 70, difference: -50 });
  assert.equal(bleeding.absoluteEffect.difference, 20);
  assert.equal(stroke.participants, 4200);
  assert.deepEqual(card.views.clinical.claims.map((claim) => claim.claimId), ["CLM-001"]);
  assert.equal(card.views.clinical.header.producer.name, "Alice");
  assert.equal(card.views.public.factBox.status, "available");
  assert.equal(card.views.public.factBox.benefits[0].control.per1000, 120);
  assert.equal(card.views.public.factBox.harms[0].intervention.per1000, 30);
  assert.equal(card.views.public.panels.find((panel) => panel.key === "oneLineAnswer").status, "missing");
  // What is stored survives a reload, and the list is light: a count, not the verdicts.
  const detail = (await service.detail(alice, zone.id, card.id)).evidence;
  assert.deepEqual(detail.claims.map((claim) => claim.verification.status), ["verified", "quote_not_found"]);
  const page = await service.list(alice, new URLSearchParams({ scope: "owned" }), zone.id);
  assert.equal(page.items[0].claimCount, 2);
  assert.deepEqual(page.items[0].claims, []);
  assert.equal(page.items[0].views, null);
});

test("a claim quotes the preserved document text of an internal write and the reader never gets that text", options, async () => {
  const zone = await makeZone();
  const documentText = `${DOCUMENT} A later passage says the subgroup of 40 patients showed no difference.`;
  const { evidence } = await service.saveEditorial(alice, {
    ...cardInput,
    sources: [{ title: "Trial", url: "https://example.org/trial", excerpt: "Among 100 adults on the drug, 7 had a stroke", documentText, coverage: "full-text" }],
    claims: [{ claimId: "CLM-001", claimType: "direct", claim: "No subgroup difference.", sourceIndexes: [1], supportQuote: "the subgroup of 40 patients showed no difference" }],
    editorial: { author: { kind: "ai", name: "Editor AI", model: "flash" }, status: "review-pending", findings: [] },
  }, zone.id, null, true, "model");
  assert.equal(evidence.claims[0].verification.status, "verified");
  assert.equal(JSON.stringify(evidence).includes("A later passage"), false, "the retained document text stays server-side");
  assert.equal(evidence.originality, "brief");
  assert.equal(evidence.primary, false);
  assert.equal(evidence.producer.kind, "user");
  assert.equal(evidence.disclosure.model, "flash");
  assert.deepEqual(evidence.disclosure.aiSteps, ["screen", "extract", "synthesize"]);
});

test("claims are refused when they do not fit the card, and the card's sources cannot shrink out from under them", options, async () => {
  const zone = await makeZone();
  await assert.rejects(saveCard(zone, { claims: [{ ...cardInput.claims[0], sourceIndexes: [2] }] }), { code: "evidence_invalid" });
  await assert.rejects(saveCard(zone, { claims: [cardInput.claims[0], cardInput.claims[0]] }), { code: "evidence_invalid" });
  const card = await saveCard(zone);
  // The card has claims on its first source; dropping every source would leave them quoting nothing.
  await assert.rejects(service.save(alice, { expectedRevision: card.revision, sources: [] }, zone.id, card.id), { code: "evidence_invalid" });
  const withNone = await service.save(alice, { expectedRevision: card.revision, claims: [] }, zone.id, card.id);
  assert.deepEqual(withNone.evidence.claims, []);
});

test("a value labelled predicted, assumed or synthetic is refused by name, and nothing is stored", options, async () => {
  const zone = await makeZone();
  for (const label of ["predicted", "assumed", "synthetic"]) {
    await assert.rejects(
      saveCard(zone, { content: { ...cardInput.content, comparisons: [{ ...comparisons[0], valueSource: label }] } }),
      (error) => error.code === "evidence_value_source_refused" && error.message.includes(label) && error.message.includes("content.comparisons[0]"),
      label,
    );
    await assert.rejects(
      saveCard(zone, { claims: [{ ...cardInput.claims[0], valueSource: label }] }),
      (error) => error.code === "evidence_value_source_refused" && error.message.includes("CLM-001") && error.message.includes(label),
      label,
    );
  }
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_cards")).rows[0].n), 0);
  assert.equal(metric("open_science_evidence_cards_refused_simulated_total", { value_source: "predicted" }), 2);
  assert.equal(metric("open_science_evidence_cards_refused_simulated_total", { value_source: "synthetic" }), 2);
  // An imputed value is allowed only inside a derived claim that states its method.
  await assert.rejects(saveCard(zone, { claims: [{ ...cardInput.claims[0], valueSource: "imputed" }] }), { code: "evidence_value_source_refused" });
  const derived = { claimId: "CLM-003", claimType: "derived", claim: "About 5 fewer strokes per 100.", derivedFrom: ["CLM-001"], method: "12/100 minus 7/100 with multiple imputation of missing outcomes", assumptions: "MAR", sensitivity: "Moves with the control rate", valueSource: "imputed" };
  const accepted = await saveCard(zone, { claims: [cardInput.claims[0], derived] });
  assert.equal(accepted.claims[1].verification.status, "derived");
  assert.equal(accepted.claims[1].verification.mark, null);
  // Observed and extracted values pass.
  await saveCard(zone, { content: { ...cardInput.content, comparisons: [{ ...comparisons[0], valueSource: "extracted" }] } });
});

test("an official zone is written only by the platform's own origins, as its publisher, and the refusal names the origin and the kind", options, async () => {
  const official = await officialZone();
  assert.equal(official.kind, "official");
  for (const origin of ["owner", "result", "geo"]) {
    await assert.rejects(
      service.saveEditorial(publisher, { ...cardInput }, official.id, null, true, /** @type {any} */ (origin)),
      (error) => error.code === "evidence_write_origin_refused" && error.status === 403 && error.message.includes(`"${origin}"`) && error.message.includes("official"),
      origin,
    );
  }
  // The same account over HTTP is the `owner` origin: an official zone refuses it too.
  await assert.rejects(service.save(publisher, { ...cardInput }, official.id, null, true), { code: "evidence_write_origin_refused" });
  // A user who is not the publisher cannot write as `programme`.
  await assert.rejects(service.saveEditorial(alice, { ...cardInput }, official.id, null, true, "programme"), { code: "evidence_owner_required" });
  const own = await service.saveEditorial(publisher, { ...cardInput }, official.id, null, true, "programme");
  assert.equal(own.evidence.producer.kind, "platform");
  assert.equal(own.evidence.producer.name, "EviMed 证据中心");
  // Import and the AI editor are the platform's too.
  assert.equal((await service.saveEditorial(publisher, { ...cardInput, title: "Imported" }, official.id, null, true, "import")).evidence.producer.kind, "platform");
  assert.equal((await service.saveEditorial(publisher, { ...cardInput, title: "Edited" }, official.id, null, true, "model")).evidence.producer.kind, "platform");
  assert.equal(metric("open_science_evidence_writes_refused_total", { origin: "geo", zone_kind: "official" }), 1);
  assert.equal(metric("open_science_evidence_writes_refused_total", { origin: "owner", zone_kind: "official" }), 2);
  assert.equal(metric("open_science_evidence_card_writes_total", { origin: "programme" }), 1);
  // A user zone refuses the origins that are not its own, and a product zone the AI.
  const userZone = await makeZone(alice);
  await assert.rejects(service.saveEditorial(alice, { ...cardInput }, userZone.id, null, true, "programme"), { code: "evidence_write_origin_refused" });
  await assert.rejects(service.saveEditorial(alice, { ...cardInput }, userZone.id, null, true, "geo"), { code: "evidence_write_origin_refused" });
  await assert.rejects(service.saveEditorial(alice, { ...cardInput }, userZone.id, null, true, "import"), { code: "evidence_write_origin_refused" });
  const product = await makeZone(alice, { kind: "product" });
  await assert.rejects(service.saveEditorial(alice, { ...cardInput, ...productFields }, product.id, null, true, "model"), { code: "evidence_write_origin_refused" });
  await assert.rejects(service.saveEditorial(alice, { ...cardInput, ...productFields }, product.id, null, true, "result"), { code: "evidence_write_origin_refused" });
  assert.equal((await service.saveEditorial(alice, { ...cardInput, ...productFields }, product.id, null, true, "geo")).evidence.producer.kind, "enterprise");
  assert.equal((await service.saveEditorial(alice, { ...cardInput, title: "From a result" }, userZone.id, null, true, "result")).evidence.producer.kind, "user");
});

test("an unknown write origin is refused before it touches a zone", options, async () => {
  const zone = await makeZone();
  await assert.rejects(service.saveEditorial(alice, cardInput, zone.id, null, true, /** @type {any} */ ("batch")), { code: "evidence_invalid" });
});

test("only an internal operation makes an official zone, and a zone's kind never changes", options, async () => {
  await assert.rejects(service.save(alice, { title: "Mine", kind: "official" }), { code: "evidence_zone_kind_forbidden" });
  await assert.rejects(service.save(publisher, { title: "Mine", kind: "official" }), { code: "evidence_zone_kind_forbidden" });
  await assert.rejects(service.saveEditorial(alice, { title: "Mine", kind: "official" }, null, null, false, "programme"), { code: "evidence_zone_kind_forbidden" }, "not the publisher");
  await assert.rejects(service.saveEditorial(publisher, { title: "Mine", kind: "official" }, null, null, false, "owner"), { code: "evidence_zone_kind_forbidden" });
  await assert.rejects(service.save(alice, { title: "Mine", kind: "nonsense" }), { code: "evidence_invalid" });
  const mine = (await service.save(alice, { title: "Mine" })).zone;
  assert.equal(mine.kind, "user");
  assert.equal(mine.visibility, "platform");
  await assert.rejects(service.save(alice, { expectedRevision: mine.revision, kind: "product" }, mine.id), { code: "evidence_zone_kind_forbidden" });
  assert.equal((await service.save(alice, { expectedRevision: mine.revision, kind: "user", title: "Renamed" }, mine.id)).zone.title, "Renamed");
  const product = (await service.save(alice, { title: "Product", kind: "product" })).zone;
  assert.equal(product.kind, "product");
  const official = await officialZone();
  assert.equal((await service.detail(bob, official.id)).zone.kind, "official");
  // An official zone is read by every account and edited by none over HTTP.
  await assert.rejects(service.save(publisher, { expectedRevision: official.revision, title: "Edited" }, official.id), { code: "evidence_write_origin_refused" });
  const edited = await service.saveEditorial(publisher, { expectedRevision: official.revision, title: "Edited by the platform" }, official.id, null, false, "programme");
  assert.equal(edited.zone.title, "Edited by the platform");
});

test("a product-zone card needs its producer, its journey stage and the people behind it, each refused by name", options, async () => {
  const zone = await makeZone(alice, { kind: "product" });
  const send = (fields) => service.save(alice, { ...cardInput, ...fields }, zone.id, null, true);
  await assert.rejects(send({ ...productFields, producer: undefined }), { code: "evidence_producer_required" });
  await assert.rejects(send({ ...productFields, journeyStage: undefined }), { code: "evidence_journey_stage_required" });
  await assert.rejects(send({ ...productFields, disclosure: undefined }), { code: "evidence_disclosure_required" });
  await assert.rejects(send({ ...productFields, disclosure: { authors: [{ name: "Dr. Li" }], reviewers: [] } }), { code: "evidence_disclosure_required" });
  await assert.rejects(send({ ...productFields, disclosure: { reviewers: [{ name: "Dr. Wang" }] } }), { code: "evidence_disclosure_required" });
  await assert.rejects(send({ ...productFields, producer: { kind: "platform", name: "EviMed", relation: "none" } }), { code: "evidence_producer_mismatch" });
  await assert.rejects(send({ ...productFields, producer: { kind: "user", name: "Alice", relation: "none" } }), { code: "evidence_producer_mismatch" });
  await assert.rejects(send({ ...productFields, producer: { kind: "enterprise", name: "Acme", relation: "paid" } }), { code: "evidence_invalid" });
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_cards")).rows[0].n), 0);
  const { evidence } = await send(productFields);
  assert.deepEqual(evidence.producer, { kind: "enterprise", name: "Acme Pharma", relation: "own_product", products: ["Drug A"] });
  assert.deepEqual(evidence.journeyStage, { key: "treatment-choice", label: "治疗选择" });
  assert.equal(evidence.disclosure.authors[0].affiliation, "PUMCH");
  assert.equal(evidence.views.clinical.header.disclosure.reviewers[0].title, "Pharmacist");
  // A later edit that keeps them keeps them; one that drops the stage is refused.
  const kept = await service.save(alice, { expectedRevision: evidence.revision, summary: "Edited" }, zone.id, evidence.id);
  assert.equal(kept.evidence.journeyStage.key, "treatment-choice");
  await assert.rejects(service.save(alice, { expectedRevision: kept.evidence.revision, journeyStage: null }, zone.id, evidence.id), { code: "evidence_journey_stage_required" });
  // A user zone needs no stage, and a user cannot sign as the platform in it.
  const mine = await makeZone(alice);
  await assert.rejects(service.save(alice, { ...cardInput, producer: { kind: "platform", name: "EviMed", relation: "none" } }, mine.id, null, true), { code: "evidence_producer_mismatch" });
  const card = await saveCard(mine, { journeyStage: { key: "diagnosis", label: "诊断" } });
  assert.equal(card.journeyStage.key, "diagnosis");
});

test("visibility on the internet is the owner's separate choice, and only a published zone has it", options, async () => {
  const draft = await makeZone(alice, { published: false });
  const published = await makeZone(alice);
  assert.equal(published.visibility, "platform");
  await assert.rejects(service.setVisibility(alice, draft.id, { visibility: "internet", expectedRevision: draft.revision }), { code: "evidence_visibility_requires_publication" });
  await assert.rejects(service.setVisibility(bob, published.id, { visibility: "internet", expectedRevision: published.revision }), { code: "evidence_owner_required" });
  await assert.rejects(service.setVisibility(alice, published.id, { visibility: "world", expectedRevision: published.revision }), { code: "evidence_invalid" });
  await assert.rejects(service.setVisibility(alice, published.id, { visibility: "internet", expectedRevision: published.revision + 5 }), { code: "evidence_revision_conflict" });
  await assert.rejects(service.setVisibility(alice, published.id, { visibility: "internet", expectedRevision: published.revision, kind: "official" }), { code: "evidence_invalid" });
  const open = (await service.setVisibility(alice, published.id, { visibility: "internet", expectedRevision: published.revision })).zone;
  assert.equal(open.visibility, "internet");
  // Publishing and editing never move it; withdrawing the zone takes it back.
  const edited = (await service.save(alice, { expectedRevision: open.revision, title: "Edited" }, published.id)).zone;
  assert.equal(edited.visibility, "internet");
  const withdrawn = (await service.save(alice, { expectedRevision: edited.revision, state: "draft" }, published.id)).zone;
  assert.equal(withdrawn.visibility, "platform");
  // A zone whose owner never chose stays where it was.
  assert.equal((await service.detail(bob, (await makeZone(alice)).id)).zone.visibility, "platform");
});

test("lineage links a card to what it grew from, and only the platform's writers stamp a run", options, async () => {
  const zone = await makeZone();
  await insertSource(db, "nejm");
  const item = await insertItem(db, { title: "Origin trial" });
  const linked = await saveCard(zone, { lineage: { frontierItemId: item.publicId, verifiedStudy: { doi: "10.1056/NEJMoa1", registryId: "NCT01234567" } } });
  assert.equal(linked.sourceItemId, item.publicId);
  assert.equal(linked.lineage.frontierItemId, item.publicId);
  assert.deepEqual(linked.lineage.verifiedStudy, { doi: "10.1056/nejmoa1", registryId: "NCT01234567" });
  await assert.rejects(saveCard(zone, { sourceItemId: item.publicId, lineage: { frontierItemId: "abcdefabcdef12" } }), { code: "evidence_invalid" });
  await assert.rejects(saveCard(zone, { lineage: { runId: "run-1" } }), { code: "evidence_invalid" });
  await assert.rejects(saveCard(zone, { lineage: { resultVersionId: "rv_abc" } }), { code: "evidence_invalid" });
  await assert.rejects(saveCard(zone, { lineage: { previousCardId: "zone_1" } }), { code: "evidence_invalid" });
  const stamped = (await service.saveEditorial(alice, { ...cardInput, lineage: { resultVersionId: "rv_0123abcd", runId: "run-9" } }, zone.id, null, true, "result")).evidence;
  assert.deepEqual(stamped.lineage, { resultVersionId: "rv_0123abcd", runId: "run-9" });
  // A session's edit keeps what the platform stamped and can still add what it may.
  const edited = (await service.save(alice, { expectedRevision: stamped.revision, lineage: { previousCardId: linked.id } }, zone.id, stamped.id)).evidence;
  assert.deepEqual(edited.lineage, { resultVersionId: "rv_0123abcd", runId: "run-9", previousCardId: linked.id });
  assert.equal(edited.revision, stamped.revision + 1);
});

test("a session may link a card only to a card of its own (previous) or a published card it can read (origin); the platform's writers stamp their own", options, async () => {
  const mine = await makeZone();
  const theirs = await makeZone(bob);
  const hidden = await makeZone(bob, { published: false });
  const own = await saveCard(mine, { requestId: "lineage-own-card" });
  const bobs = await saveCard(theirs, { requestId: "lineage-bob-card", state: "published" }, bob);
  const bobDraft = await saveCard(hidden, { requestId: "lineage-bob-draft", state: "draft" }, bob);
  // Another author's card is not a card this one follows: the field is refused by name, whatever the id.
  await assert.rejects(saveCard(mine, { lineage: { previousCardId: bobs.id } }), { code: "evidence_lineage_previous_not_own" });
  await assert.rejects(saveCard(mine, { lineage: { previousCardId: "ec_0123456789abcdef" } }), { code: "evidence_lineage_previous_not_own" });
  assert.equal((await saveCard(mine, { lineage: { previousCardId: own.id } })).lineage.previousCardId, own.id, "the writer's own card");
  // An origin is a published card the writer can read: another author's published card, not their draft nor a card that is not there.
  assert.equal((await saveCard(mine, { requestId: "lineage-origin-ok", lineage: { originCardId: bobs.id } })).lineage.originCardId, bobs.id);
  await assert.rejects(saveCard(mine, { lineage: { originCardId: bobDraft.id } }), { code: "evidence_lineage_origin_unreadable" });
  await assert.rejects(saveCard(mine, { lineage: { originCardId: "ec_0123456789abcdef" } }), { code: "evidence_lineage_origin_unreadable" });
  // An edit of a card that already carries a link does not ask again (the card is what it was), and a link may be changed to one that is allowed.
  const linked = await saveCard(mine, { requestId: "lineage-keep", lineage: { originCardId: bobs.id } });
  assert.equal((await service.save(alice, { expectedRevision: linked.revision, summary: "Edited" }, mine.id, linked.id)).evidence.lineage.originCardId, bobs.id);
  await assert.rejects(service.save(alice, { expectedRevision: linked.revision + 1, lineage: { originCardId: bobs.id, previousCardId: bobs.id } }, mine.id, linked.id), { code: "evidence_lineage_previous_not_own" });
  // The result publisher is the platform's writer: it stamps the earlier card of the researcher and the card a session began from, and is not asked.
  const stamped = (await service.saveEditorial(alice, { ...cardInput, requestId: "lineage-platform", lineage: { previousCardId: own.id, originCardId: bobs.id } }, mine.id, null, true, "result")).evidence;
  assert.deepEqual(stamped.lineage, { previousCardId: own.id, originCardId: bobs.id });
});

test("the platform's own producer name is refused for any writer that is not the publisher: typed, spelled differently, or the account's own default", options, async () => {
  const zone = await makeZone();
  for (const name of ["EviMed 证据中心", "evimed 证据中心", "ＥｖｉＭｅｄ证据中心", "EviMed\u200b证据中心"]) {
    await assert.rejects(saveCard(zone, { requestId: `reserved-${name.length}-${name.charCodeAt(0)}`, producer: { kind: "user", name, relation: "none" } }), { code: "evidence_producer_name_reserved", status: 400 }, JSON.stringify(name));
  }
  // The default producer is the owner's display name: an account that came to be named so (before the registration check, or by an
  // identity provider) cannot sign a card with it either.
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('namesake','EviMed 证据中心','development') ON CONFLICT DO NOTHING");
  const namesake = await makeZone({ id: "namesake" });
  await assert.rejects(saveCard(namesake, { requestId: "reserved-default" }, { id: "namesake" }), { code: "evidence_producer_name_reserved" });
  assert.equal(metric("open_science_evidence_cards_without_producer"), 0, "a refused card left nothing behind");
  // Other names, including one that merely contains it, are the writer's own.
  assert.equal((await saveCard(zone, { requestId: "reserved-ok", producer: { kind: "user", name: "EviMed 证据中心 研究组", relation: "none" } })).producer.name, "EviMed 证据中心 研究组");
  // The platform's own writers sign as it: the publisher in an official zone, by its default and by name.
  const official = await officialZone();
  assert.equal((await service.saveEditorial(publisher, { ...cardInput, requestId: "reserved-platform" }, official.id, null, true, "programme")).evidence.producer.name, "EviMed 证据中心");
  assert.equal((await service.saveEditorial(publisher, { ...cardInput, requestId: "reserved-platform-2", producer: { kind: "platform", name: "evimed 证据中心", relation: "none" } }, official.id, null, true, "import")).evidence.producer.kind, "platform");
  // A card that already carries the producer is not asked again when its other fields are edited.
  const kept = await service.saveEditorial(publisher, { ...cardInput, requestId: "reserved-keep" }, official.id, null, true, "programme");
  assert.equal((await service.saveEditorial(publisher, { expectedRevision: kept.evidence.revision, summary: "Edited" }, official.id, kept.evidence.id, false, "model")).evidence.summary, "Edited");
});

test("entity keys are filled by the injected resolver from the card's words and identifiers, and a resolver that fails leaves the card as written", options, async () => {
  const zone = await makeZone();
  resolver.answer = ["drug:warfarin", "disease:atrial fibrillation"];
  const card = await saveCard(zone, { entityKeys: ["trial:rely"], sources: [{ title: "Trial", url: "https://doi.org/10.1000/Trial.1", excerpt: DOCUMENT }], lineage: { verifiedStudy: { registryId: "NCT01234567" } } });
  assert.deepEqual(card.entityKeys, ["trial:rely", "drug:warfarin", "disease:atrial fibrillation"]);
  assert.equal(resolver.calls.length, 1);
  assert.ok(resolver.calls[0].texts.includes("Does the drug prevent stroke?"));
  assert.ok(resolver.calls[0].texts.includes("Stroke was less frequent on the drug."));
  assert.deepEqual(resolver.calls[0].identifiers, ["doi:10.1000/trial.1", "registry:nct01234567"]);
  resolver.fail = true;
  const kept = (await service.save(alice, { expectedRevision: card.revision, summary: "Edited while the glossary is down" }, zone.id, card.id)).evidence;
  assert.deepEqual(kept.entityKeys, card.entityKeys);
  await assert.rejects(saveCard(zone, { entityKeys: ["x".repeat(200)] }), { code: "evidence_invalid" });
  // With no resolver injected, what the author gave is kept as given.
  const plain = await legacy.save(alice, { ...cardInput, entityKeys: ["drug:a"] }, zone.id, null, true);
  assert.deepEqual(plain.evidence.entityKeys, ["drug:a"]);
});

test("the operator import keeps its reach into the nominated owner's zone until a publisher account exists, and is refused once one does", options, async () => {
  const zone = await makeZone();
  const imported = await legacy.saveEditorial(alice, { ...cardInput, editorial: { author: { kind: "ai", name: "Editor AI", model: "flash" }, status: "review-pending", findings: [] } }, zone.id, null, true, "import");
  assert.equal(imported.evidence.producer.kind, "user", "the zone owner, since the zone is not official");
  assert.equal(imported.evidence.originality, "brief");
  await assert.rejects(service.saveEditorial(alice, { ...cardInput, title: "Again" }, zone.id, null, true, "import"), { code: "evidence_write_origin_refused" });
  // Official content written for the owner stands in for the publisher only while none is configured.
  const { zone: official } = await legacy.saveEditorial(alice, { title: "Official", kind: "official" }, null, null, false, "import");
  assert.equal(official.kind, "official");
  const model = await legacy.saveEditorial(alice, { ...cardInput, title: "Edited" }, official.id, null, true, "model");
  assert.equal(model.evidence.producer.kind, "platform");
  await assert.rejects(legacy.save(alice, { ...cardInput, title: "By hand" }, official.id, null, true), { code: "evidence_write_origin_refused" });
});

test("the card's new fields are in every revision snapshot", options, async () => {
  const zone = await makeZone();
  resolver.answer = ["drug:warfarin"];
  const card = await saveReadCard(zone, { originality: "original_research", journeyStage: { key: "follow-up", label: "随访" }, publicView: { oneLineAnswer: { text: "一句话", claimIds: ["CLM-001"] } } });
  await service.save(alice, { expectedRevision: card.revision, summary: "Second" }, zone.id, card.id);
  const rows = (await db.query("SELECT revision,snapshot FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1 ORDER BY revision", [card.id])).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.snapshot.claims.length, 2);
    assert.equal(row.snapshot.producer.name, "Alice");
    assert.equal(row.snapshot.originality, "original_research");
    assert.deepEqual(row.snapshot.entity_keys, ["drug:warfarin"]);
    assert.equal(row.snapshot.journey_stage.key, "follow-up");
    assert.equal(row.snapshot.public_view.oneLineAnswer.claimIds[0], "CLM-001");
  }
  assert.equal(card.primary, true);
  assert.equal(card.views.public.panels.find((panel) => panel.key === "oneLineAnswer").traced, true);
  await assert.rejects(saveCard(zone, { publicView: { whatItIs: { text: "x", claimIds: ["CLM-404"] } } }), { code: "evidence_invalid" });
  await assert.rejects(saveCard(zone, { originality: "marketing" }), { code: "evidence_invalid" });
});

test("the migration runs twice on a database that holds release-5 cards, backfills them and keeps the closed lists", options, async () => {
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('legacy-owner','Legacy Owner','development'),('blank','   ','development') ON CONFLICT DO NOTHING");
  // Rows as release 5 wrote them: none of the card contract's columns carries a value.
  await db.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES('ez_imported','legacy-owner','Imported zone','published'),('ez_plain','legacy-owner','Plain zone','published')");
  const card = (id, zone, user, editorial) => db.query(
    "INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,body,sources,state,editorial) VALUES($1,$2,$3,'T','academic','b','[]','published',$4)",
    [id, zone, user, editorial ? JSON.stringify(editorial) : null],
  );
  await card("ec_importedai1", "ez_imported", "legacy-owner", { author: { kind: "ai", name: "Editor AI", model: "m" }, status: "ai-reviewed", reviewOrigin: "import" });
  await card("ec_importedai2", "ez_imported", "legacy-owner", { author: { kind: "ai", name: "Editor AI", model: "m" }, status: "review-pending" });
  await card("ec_importedhum", "ez_imported", "legacy-owner", null);
  await card("ec_modelai1", "ez_plain", "legacy-owner", { author: { kind: "ai", name: "Editor AI", model: "m" }, status: "ai-reviewed", reviewOrigin: "model" });
  await card("ec_human1", "ez_plain", "legacy-owner", null);
  await card("ec_blankname", "ez_plain", "blank", null);
  // …and a schema from before the contract existed: its columns are not there at all.
  await db.query(`ALTER TABLE evimed_frontier.evidence_cards DROP COLUMN claims, DROP COLUMN producer, DROP COLUMN originality, DROP COLUMN lineage,
    DROP COLUMN entity_keys, DROP COLUMN journey_stage, DROP COLUMN disclosure, DROP COLUMN public_view`);
  await db.query("ALTER TABLE evimed_frontier.evidence_zones DROP COLUMN kind, DROP COLUMN visibility");
  const run = () => db.transaction(async (client) => { await client.query(EVIDENCE_ZONE_SQL); });
  await run();
  assert.equal((await service.metrics()).cardsWithoutProducer, 0);
  await run();
  const read = async () => Object.fromEntries((await db.query("SELECT id,producer,originality,claims,entity_keys FROM evimed_frontier.evidence_cards ORDER BY id")).rows.map((row) => [row.id, row]));
  const rows = await read();
  assert.deepEqual(rows.ec_importedai1.producer, { kind: "platform", name: "EviMed 证据中心", relation: "none" });
  assert.deepEqual(rows.ec_importedai2.producer, { kind: "platform", name: "EviMed 证据中心", relation: "none" });
  assert.deepEqual(rows.ec_importedhum.producer, { kind: "user", name: "Legacy Owner", relation: "none" });
  assert.deepEqual(rows.ec_modelai1.producer, { kind: "user", name: "Legacy Owner", relation: "none" });
  assert.deepEqual(rows.ec_human1.producer, { kind: "user", name: "Legacy Owner", relation: "none" });
  assert.equal(rows.ec_blankname.producer.name, "blank");
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.originality])), {
    ec_importedai1: "brief", ec_importedai2: "brief", ec_importedhum: "synthesis", ec_modelai1: "brief", ec_human1: "synthesis", ec_blankname: "synthesis",
  });
  for (const row of Object.values(rows)) {
    assert.deepEqual(row.claims, []);
    assert.deepEqual(row.entity_keys, []);
  }
  // A value the backfill chose is not chosen again, and a zone that existed is a user zone readable by the platform.
  await db.query("UPDATE evimed_frontier.evidence_cards SET producer='{\"kind\":\"user\",\"name\":\"Edited\",\"relation\":\"own_product\"}' WHERE id='ec_human1'");
  await run();
  assert.equal((await read()).ec_human1.producer.name, "Edited");
  const zones = (await db.query("SELECT kind,visibility FROM evimed_frontier.evidence_zones ORDER BY id")).rows;
  assert.deepEqual(zones, [{ kind: "user", visibility: "platform" }, { kind: "user", visibility: "platform" }]);
  // The closed lists are the table's own checks.
  await assert.rejects(db.query("UPDATE evimed_frontier.evidence_zones SET kind='sponsored' WHERE id='ez_plain'"));
  await assert.rejects(db.query("UPDATE evimed_frontier.evidence_zones SET visibility='world' WHERE id='ez_plain'"));
  await assert.rejects(db.query("UPDATE evimed_frontier.evidence_cards SET originality='advert' WHERE id='ec_human1'"));
  // The pre-contract cards keep working through the service: they read, and their hash-bound review still holds.
  const read1 = (await service.detail(bob, "ez_imported", "ec_importedai1")).evidence;
  assert.equal(read1.producer.kind, "platform");
  assert.deepEqual(read1.claims, []);
  assert.equal(read1.views.clinical.rows.length, 0);
  assert.equal(read1.views.public.factBox.reason, "no_comparisons");
});

test("the guardrail families export the card counters and the cards-without-a-producer gauge", options, async () => {
  const zone = await makeZone();
  await saveCard(zone);
  assert.deepEqual(await service.metrics(), { cardsWithoutProducer: 0 });
  await db.query("UPDATE evimed_frontier.evidence_cards SET producer=NULL");
  assert.deepEqual(await service.metrics(), { cardsWithoutProducer: 1 });
  const families = evidenceCardMetricFamilies(await service.metrics());
  assert.deepEqual(families.map((family) => family.name), [
    "open_science_evidence_cards_without_producer",
    "open_science_evidence_writes_refused_total",
    "open_science_evidence_card_writes_total",
    "open_science_evidence_cards_refused_simulated_total",
  ]);
  assert.equal(families[0].series[0].value, 1);
  assert.equal(metric("open_science_evidence_card_writes_total", { origin: "owner" }), 1);
  // Every origin and zone kind has a series from the start, at zero; an unreadable gauge is no series, not a made-up zero.
  assert.equal(families[1].series.length, 18);
  assert.equal(metric("open_science_evidence_writes_refused_total", { origin: "model", zone_kind: "product" }), 0);
  assert.deepEqual(evidenceCardMetricFamilies(null)[0].series, []);
});

test("a retried request identity returns the same card, and reuse for different content is a conflict", options, async () => {
  const zone = await makeZone();
  const body = { ...cardInput, sources: [], claims: [], content: null, state: "draft", requestId: "retry-request-0001", producer: { kind: "user", name: "Alice", relation: "user_of_therapy" }, entityKeys: ["drug:a", "drug:b"] };
  const first = (await service.save(alice, body, zone.id, null, true)).evidence;
  const second = (await service.save(alice, { ...body }, zone.id, null, true)).evidence;
  assert.equal(second.id, first.id);
  assert.equal(second.producer.relation, "user_of_therapy");
  await assert.rejects(service.save(alice, { ...body, producer: { kind: "user", name: "Alice", relation: "none" } }, zone.id, null, true), { code: "evidence_request_conflict" });
  await assert.rejects(service.save(alice, { ...body, entityKeys: ["drug:c"] }, zone.id, null, true), { code: "evidence_request_conflict" });
});

test("over HTTP a product zone is the owner's to make, an official one is not, and visibility is its own route", options, async () => {
  const users = { alice, bob };
  const handler = createEvidenceZoneRoutes({
    store: { ensureSessionUser: async (/** @type {any} */ req) => ({ user: users[/** @type {"alice"|"bob"} */ (req.headers["x-test-user"])] }), assertCsrf: async () => {} },
    service,
    frontier: { allows: () => true },
    config: { frontierEnabled: true },
    maxJsonBytes: 1_000_000,
  });
  const server = http.createServer(async (req, res) => {
    try {
      if (!(await handler(req, res))) { res.statusCode = 404; res.end("{}"); }
    } catch (/** @type {any} */ failure) {
      res.statusCode = failure.status ?? 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: failure.code } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const call = async (/** @type {string} */ method, /** @type {string} */ path, /** @type {string} */ as, /** @type {any} */ body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "x-test-user": as, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const official = await call("POST", "/api/frontier/zones", "alice", { title: "Mine", kind: "official" });
    assert.equal(official.status, 403);
    assert.equal(official.body.error.code, "evidence_zone_kind_forbidden");
    const made = await call("POST", "/api/frontier/zones", "alice", { title: "Product zone", kind: "product" });
    assert.equal(made.status, 200);
    assert.equal(made.body.data.zone.kind, "product");
    const zone = made.body.data.zone;
    const refused = await call("POST", `/api/frontier/zones/${zone.id}/evidence`, "alice", cardInput);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "evidence_producer_required");
    const card = await call("POST", `/api/frontier/zones/${zone.id}/evidence`, "alice", { ...cardInput, ...productFields });
    assert.equal(card.status, 200);
    assert.equal(card.body.data.evidence.claims[0].verification.status, "author_excerpt_only", "over HTTP the excerpt is the author's, not the platform's reading");
    assert.equal(card.body.data.evidence.claims[0].text, cardInput.claims[0].claim);
    assert.equal(card.body.data.evidence.views.clinical.rows[0].absoluteEffect.control, 120);
    // The default is the platform's audience until the owner chooses; the choice is a route of its own.
    const early = await call("PUT", `/api/frontier/zones/${zone.id}/visibility`, "alice", { visibility: "internet", expectedRevision: zone.revision });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "evidence_visibility_requires_publication");
    const published = (await call("PATCH", `/api/frontier/zones/${zone.id}`, "alice", { expectedRevision: zone.revision, state: "published" })).body.data.zone;
    assert.equal((await call("PUT", `/api/frontier/zones/${zone.id}/visibility`, "bob", { visibility: "internet", expectedRevision: published.revision })).body.error.code, "evidence_owner_required");
    const open = await call("PUT", `/api/frontier/zones/${zone.id}/visibility`, "alice", { visibility: "internet", expectedRevision: published.revision });
    assert.equal(open.status, 200);
    assert.equal(open.body.data.zone.visibility, "internet");
    assert.equal((await call("GET", `/api/frontier/zones/${zone.id}`, "bob")).body.data.zone.visibility, "internet");
    assert.equal((await call("POST", `/api/frontier/zones/${zone.id}/visibility`, "alice", {})).status, 404, "visibility is set by PUT only");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
