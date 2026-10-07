// What happens to a published card goes back into learning (evidence-flywheel F15, 2026-10-06), against a real PostgreSQL: each correction and withdrawal in the
// public change log becomes one incident document in the platform's evidence project and, where a researcher's own method wrote the card, one observation on
// the methods the producing run read; the cursor, the lease, a failing entry, a replay and the export script.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { exportEvidenceIncidents } from "../../../scripts/evals/export-evidence-incidents.mjs";
import { createEvidenceChangeLog } from "../src/evidenceChangeLog.mjs";
import { EVIDENCE_INCIDENT_CLASSES, MAX_ENTRY_ATTEMPTS, createEvidenceOutcomes, evidenceIncidentCase, evidenceIncidentClass, evidenceOutcomeMetricFamilies } from "../src/evidenceIncidents.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { ensureEvidenceProject } from "../src/internalProjects.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { createStore } from "../src/store.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const publisher = { id: PLATFORM_PUBLISHER_USER_ID };
const alice = { id: "alice" };
const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
const BETTER = "Among 100 adults on the drug, 9 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
const VERSION = `rv_${"1".repeat(64)}`;
const DIGEST = "a".repeat(64);
const claim = (statement, quote) => ({ claimId: "CLM-001", claimType: "direct", claim: statement, sourceIndexes: [1], supportQuote: quote });
const card = (title, claims, text = TEXT) => ({
  title, subtype: "academic", summary: `${title} summary.`, body: "The body.", state: "published", limitations: "One trial.", provenance: "p",
  sources: [{ title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: text, documentText: text, coverage: "full-text" }],
  content: { question: "Does it prevent stroke?", answer: "Fewer strokes were seen." }, claims,
});

/** @type {any} */ let isolated, store, db, zones, changeLog, documents, official, userZone, closedZone, owner, dataDir, baseline;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "outcomes");
  dataDir = await mkdtemp(join(tmpdir(), "evidence-outcomes-"));
  store = createStore({ stateStore: "postgres", databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000, dataDir, maxProjectBytes: 1_048_576 });
  db = store.database;
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development') ON CONFLICT DO NOTHING");
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('alice','p1','Alice project',1048576) ON CONFLICT DO NOTHING");
  await migrateProductStore(db);
  documents = new ProductDocuments(db);
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID });
  changeLog = createEvidenceChangeLog({ database: db });
  owner = await ensureEvidenceProject(store);
});
after(async () => {
  await store?.close();
  await isolated?.drop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
  await db.query("DELETE FROM evimed_product.documents WHERE kind IN ('knowledge','result-version')");
  // The change log is append-only (the database refuses a truncate), so an earlier test's entries stay: each test starts the consumer after them.
  baseline = Number((await db.query("SELECT coalesce(max(id),0) AS id FROM evimed_frontier.evidence_change_log")).rows[0].id);
  await db.query("DELETE FROM evimed_frontier.evidence_upkeep_state");
  await resetCursor();
  const made = (await zones.saveEditorial(publisher, { title: "Official", description: "d", background: "b", kind: "official" }, null, null, false, "programme")).zone;
  official = (await zones.saveEditorial(publisher, { expectedRevision: made.revision, state: "published" }, made.id, null, false, "programme")).zone;
  const open = (await zones.save(alice, { title: "Open zone", description: "d", background: "b" })).zone;
  const live = (await zones.save(alice, { expectedRevision: open.revision, state: "published" }, open.id)).zone;
  userZone = (await zones.setVisibility(alice, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
  const shut = (await zones.save(alice, { title: "Platform-only zone", description: "d", background: "b" })).zone;
  closedZone = (await zones.save(alice, { expectedRevision: shut.revision, state: "published" }, shut.id)).zone;
});

/** A user's result card, as the publisher stamps it: the lineage names the run and the result version. */
async function resultCard(zone, title, claims, lineage = { resultVersionId: VERSION, runId: "run-1" }) {
  const saved = (await zones.saveEditorial(alice, card(title, claims), zone.id, null, true, "result")).evidence;
  await db.query("UPDATE evimed_frontier.evidence_cards SET lineage=$2::jsonb WHERE id=$1", [saved.id, JSON.stringify(lineage)]);
  return saved;
}
const programmeCard = async (title, claims) => (await zones.saveEditorial(publisher, card(title, claims), official.id, null, true, "programme")).evidence;
/** Revise a card's claim, so there are two revisions to read a claim's before and after from. */
async function revise(saved, zone, claims, text) {
  return (await zones.saveEditorial(alice, { ...card(saved.title, claims, text), expectedRevision: saved.revision }, zone.id, saved.id, false, "owner")).evidence;
}
const append = (saved, zone, entry) => changeLog.append({ zoneId: zone.id, cardId: saved.id, ...entry });
async function resultVersion() {
  await documents.put("alice", "result-version", VERSION, { recordType: "result-version", versionId: VERSION, digest: DIGEST, projectId: "p1" }, { expectedRevision: 0, projectId: "p1" });
}
/** The consumer's position, back to where this test's own entries begin. */
const resetCursor = () => db.query("INSERT INTO evimed_frontier.evidence_upkeep_state(name,cursor,payload) VALUES('learning-evidence-outcomes',$1,'{}') ON CONFLICT(name) DO UPDATE SET cursor=$1,payload='{}',lease_owner=NULL,lease_until=NULL", [baseline]);
const incidents = async () => (await db.query("SELECT id,payload FROM evimed_product.documents WHERE kind='knowledge' AND payload->>'recordType'='evidence-incident' ORDER BY id")).rows;
/** A feedback double that records what it was asked and answers as the real service does. */
function feedbackDouble(answer = {}) {
  /** @type {any[]} */ const calls = [];
  return { calls, fromEvidenceOutcome: async (project, outcome) => { calls.push({ project, outcome }); return { recorded: [{ kind: "method", id: "m1", digest: "sha256:x", added: true }, { kind: "handbook", id: "h1", digest: "sha256:y", added: true }], unresolved: [], skipped: null, capabilityId: "clinical-evidence-synthesis", ...answer }; } };
}
const consumer = (extra = {}) => createEvidenceOutcomes({ database: db, documents, ensureOwner: async () => owner, ...extra });

test("the closed class of a log entry comes from its category and trigger, and everything else is not an outcome", () => {
  assert.deepEqual([
    evidenceIncidentClass({ category: "correction", trigger: "challenge" }), evidenceIncidentClass({ category: "withdrawal", trigger: "challenge", refs: { claimId: "CLM-1" } }),
    evidenceIncidentClass({ category: "withdrawal", trigger: "challenge", refs: {} }), evidenceIncidentClass({ category: "withdrawal", trigger: "producer_edit" }),
    evidenceIncidentClass({ category: "correction", trigger: "producer_edit" }), evidenceIncidentClass({ category: "correction", trigger: "source_change" }),
  ], ["claim_amended", "claim_withdrawn", "card_withdrawn", "card_withdrawn", "producer_correction", "source_changed"]);
  for (const entry of [{ category: "searched_no_change", trigger: "scheduled_check" }, { category: "retired", trigger: "scheduled_check" }, { category: "correction", trigger: "scheduled_check" }, { category: "new_evidence_conclusion_changed", trigger: "new_evidence" }])
    assert.equal(evidenceIncidentClass(entry), null, JSON.stringify(entry));
});

test("a challenge that amended a claim becomes one incident with the claim and its quotation before and after, and one observation on the researcher's methods", options, async () => {
  await resultVersion();
  const first = await resultCard(userZone, "Stroke card", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")]);
  const second = await revise(first, userZone, [claim("Stroke was somewhat less frequent on the drug.", "Among 100 adults on the drug, 9 had a stroke")], BETTER);
  await append(first, userZone, { category: "correction", trigger: "challenge", revisionBefore: 1, revisionAfter: second.revision, refs: { claimId: "CLM-001", challengeId: "ch_1", outcome: "amend" } });
  const feedback = feedbackDouble();
  const subject = consumer({ methodFeedback: feedback, resolveProject: async (userId, projectId) => ({ userId, id: projectId }) });
  assert.deepEqual(await subject.tick(), { read: 1, leased: true });
  const [row] = await incidents();
  assert.equal(row.id, `evidence-incident-${(await db.query("SELECT id FROM evimed_frontier.evidence_change_log")).rows[0].id}`);
  assert.deepEqual([row.payload.class, row.payload.caughtBy, row.payload.claimId, row.payload.exportable], ["claim_amended", "reader", "CLM-001", true]);
  assert.deepEqual(row.payload.claimBefore, { text: "Stroke was less frequent on the drug.", quote: "Among 100 adults on the drug, 7 had a stroke" });
  assert.deepEqual(row.payload.claimAfter, { text: "Stroke was somewhat less frequent on the drug.", quote: "Among 100 adults on the drug, 9 had a stroke" });
  assert.deepEqual(row.payload.produced, { runId: "run-1", capabilityId: "clinical-evidence-synthesis", resultVersionId: VERSION });
  assert.deepEqual(row.payload.observation, { state: "recorded", methods: 1, handbooks: 1 });
  assert.equal(row.payload.card.zoneKind, "user");
  // The observation names the project of the result version, its digest, the closed class and the log entry — and nothing the researcher wrote.
  assert.equal(feedback.calls.length, 1);
  assert.deepEqual(feedback.calls[0].project, { userId: "alice", id: "p1" });
  assert.deepEqual(feedback.calls[0].outcome, { runId: "run-1", result: { versionId: VERSION, digest: DIGEST }, at: feedback.calls[0].outcome.at, logEntryId: row.payload.logEntryId, outcomeClass: "claim_amended" });
  // The incident lives in the platform's evidence project, under the publisher, and nowhere in the researcher's account.
  const stored = await documents.get(PLATFORM_PUBLISHER_USER_ID, "knowledge", row.id);
  assert.equal(stored.projectId, owner.projectId);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE user_id='alice' AND kind='knowledge'")).rows[0].n, 0);
  assert.deepEqual(subject.stats().incidents.claim_amended, 1);
  assert.deepEqual(subject.stats().observations.recorded, 1);
});

test("every class writes its incident; a source change is an incident and no observation, and the platform's own cards have no researcher's method to observe", options, async () => {
  await resultVersion();
  const mine = await resultCard(userZone, "Mine", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")]);
  const platform = await programmeCard("Platform card", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")]);
  await append(mine, userZone, { category: "withdrawal", trigger: "challenge", refs: { claimId: "CLM-001" } });
  await append(mine, userZone, { category: "correction", trigger: "producer_edit" });
  await append(mine, userZone, { category: "withdrawal", trigger: "producer_edit" });
  await append(mine, userZone, { category: "correction", trigger: "source_change", refs: { sourceChanges: [{ identifier: "doi:10.1000/stroke.1", kind: "retraction", firstSeenAt: "2026-10-01T00:00:00Z" }] } });
  await append(platform, official, { category: "correction", trigger: "challenge", refs: { claimId: "CLM-001" } });
  await append(platform, official, { category: "searched_no_change", trigger: "scheduled_check" });
  const feedback = feedbackDouble();
  const subject = consumer({ methodFeedback: feedback, resolveProject: async (userId, projectId) => ({ userId, id: projectId }) });
  await subject.tick();
  const rows = await incidents();
  assert.deepEqual(rows.map((row) => row.payload.class).sort(), ["card_withdrawn", "claim_amended", "claim_withdrawn", "producer_correction", "source_changed"]);
  assert.equal(rows.length, 5, "the scheduled check that found nothing is not an incident");
  const by = Object.fromEntries(rows.map((row) => [row.payload.class === "claim_amended" ? "platform" : row.payload.class, row.payload]));
  assert.deepEqual(by.source_changed.sourceChanges, [{ kind: "retraction", identifier: "doi:10.1000/stroke.1" }]);
  assert.equal(by.source_changed.observation.reason, "source_change_is_not_the_methods");
  assert.deepEqual([by.platform.observation.state, by.platform.observation.reason, by.platform.exportable, by.platform.card.producerKind], ["skipped", "not_a_researchers_card", true, "platform"]);
  assert.equal(feedback.calls.length, 3, "claim_withdrawn, producer_correction and card_withdrawn of the researcher's card");
  assert.deepEqual(subject.stats().skippedBecause, { source_change_is_not_the_methods: 1, not_a_researchers_card: 1 });
  assert.deepEqual(Object.keys(subject.stats().incidents).sort(), [...EVIDENCE_INCIDENT_CLASSES].sort());
});

test("a card visible only inside the platform keeps its incident as a ledger row: it is never exportable", options, async () => {
  const hidden = await resultCard(closedZone, "Platform-only card", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")]);
  const open = await resultCard(userZone, "Open card", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")], {});
  await append(hidden, closedZone, { category: "withdrawal", trigger: "challenge", refs: { claimId: "CLM-001" } });
  await append(open, userZone, { category: "withdrawal", trigger: "challenge", refs: { claimId: "CLM-001" } });
  const subject = consumer();
  await subject.tick();
  const exportable = Object.fromEntries((await incidents()).map((row) => [row.payload.card.title, row.payload.exportable]));
  assert.deepEqual(exportable, { "Platform-only card": false, "Open card": true });
  assert.deepEqual((await subject.pendingExports()).map((row) => row.payload.card.title), ["Open card"]);
  assert.equal((await incidents()).find((row) => row.payload.card.title === "Open card").payload.observation.reason, "learning_off");
});

test("the cursor moves past what was read, a replay of the log changes nothing, and two ticks at once do not both read", options, async () => {
  await resultVersion();
  const mine = await resultCard(userZone, "Mine", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")]);
  await append(mine, userZone, { category: "withdrawal", trigger: "challenge", refs: { claimId: "CLM-001" } });
  const feedback = feedbackDouble();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const subject = consumer({ methodFeedback: feedback, resolveProject: async (userId, projectId) => {
    entered.resolve();
    await release.promise;
    return { userId, id: projectId };
  } });
  // Pause after acquisition: two ticks merely started together can legitimately run one after the other (the first released
  // before the second asked), which is no overlap and made this test flaky on CI. The race keeps a first tick that never
  // reaches the pause from hanging the test: the contender's answer then fails the assertion instead.
  const first = subject.tick();
  let contender;
  try {
    await Promise.race([entered.promise, first]);
    contender = await consumer({ methodFeedback: feedback, resolveProject: async () => null }).tick();
    assert.equal(contender.leased, false, "the contender cannot acquire a lease still held by the first tick");
  } finally {
    release.resolve();
  }
  const both = [await first, contender];
  assert.deepEqual(both.map((result) => result.leased).sort(), [false, true], "one holds the lease");
  assert.deepEqual(await subject.tick(), { read: 0, leased: true }, "nothing new after the cursor");
  // The log read again from the start: the incident is not written twice and the observation is asked for again only to find it already there.
  await resetCursor();
  await subject.tick();
  assert.equal((await incidents()).length, 1);
  assert.equal(subject.stats().incidents.claim_withdrawn, 1);
});

test("an entry that cannot be handled holds the cursor and is tried again; after the allowed attempts it is skipped, counted and reported, and the next entries go on", options, async () => {
  const first = await programmeCard("First", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")]);
  await append(first, official, { category: "withdrawal", trigger: "producer_edit" });
  await append(first, official, { category: "withdrawal", trigger: "challenge", refs: { claimId: "CLM-001" } });
  const reported = [];
  let broken = true;
  const subject = consumer({ ensureOwner: async () => { if (broken) throw Object.assign(new Error("unavailable"), { code: "evidence_account_unavailable" }); return owner; }, report: (code) => reported.push(code) });
  for (let attempt = 1; attempt < MAX_ENTRY_ATTEMPTS; attempt += 1) {
    assert.deepEqual(await subject.tick(), { read: 2, leased: true });
    assert.equal(Number((await db.query("SELECT cursor FROM evimed_frontier.evidence_upkeep_state WHERE name='learning-evidence-outcomes'")).rows[0].cursor), baseline, `held at attempt ${attempt}`);
  }
  assert.equal((await incidents()).length, 0);
  broken = false;
  await subject.tick();
  assert.equal((await incidents()).length, 2, "the failure was transient: both entries are written, the earlier first");
  assert.ok(reported.every((code) => code === "evidence_outcome_evidence_account_unavailable"));
  assert.equal(subject.stats().abandoned, 0);
  // A permanent failure is abandoned after the allowed attempts, and does not stall the entry after it.
  await db.query("DELETE FROM evimed_product.documents WHERE kind='knowledge'");
  await resetCursor();
  const selective = createEvidenceOutcomes({ database: db, documents: Object.assign(Object.create(documents), { put: async (user, kind, id, payload, opts) => {
    if (payload.trigger === "producer_edit") throw Object.assign(new Error("bad"), { code: "product_document_invalid" });
    return documents.put(user, kind, id, payload, opts);
  } }), ensureOwner: async () => owner, report: (code) => reported.push(code) });
  for (let attempt = 0; attempt < MAX_ENTRY_ATTEMPTS; attempt += 1) await selective.tick();
  assert.equal(selective.stats().abandoned, 1);
  assert.deepEqual((await incidents()).map((row) => row.payload.trigger), ["challenge"], "the entry after the abandoned one was handled");
  assert.ok(reported.includes("evidence_outcome_product_document_invalid"));
});

test("the export script writes one case file per pending exportable incident, marks it exported, and a second run writes nothing", options, async () => {
  await resultVersion();
  const first = await resultCard(userZone, "Stroke card", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")]);
  const second = await revise(first, userZone, [claim("Stroke was somewhat less frequent on the drug.", "Among 100 adults on the drug, 9 had a stroke")], BETTER);
  await append(first, userZone, { category: "correction", trigger: "challenge", revisionBefore: 1, revisionAfter: second.revision, refs: { claimId: "CLM-001" } });
  const hidden = await resultCard(closedZone, "Platform-only card", [claim("Stroke was less frequent on the drug.", "Among 100 adults on the drug, 7 had a stroke")]);
  await append(hidden, closedZone, { category: "withdrawal", trigger: "challenge", refs: { claimId: "CLM-001" } });
  await consumer({ methodFeedback: feedbackDouble(), resolveProject: async (userId, projectId) => ({ userId, id: projectId }) }).tick();
  const outDir = await mkdtemp(join(tmpdir(), "evidence-incident-cases-"));
  try {
    const dry = await exportEvidenceIncidents({ database: db, outDir, dryRun: true });
    assert.deepEqual([dry.written.length, dry.existing.length, dry.pending], [1, 0, 1]);
    assert.deepEqual(await readdir(outDir), [], "a dry run writes and marks nothing");
    const done = await exportEvidenceIncidents({ database: db, outDir, now: () => new Date("2026-10-06T10:00:00.000Z") });
    assert.deepEqual([done.written.length, done.pending], [1, 1]);
    const [file] = await readdir(outDir);
    const made = JSON.parse(await readFile(join(outDir, file), "utf8"));
    assert.equal(file, `${made.id}.json`);
    assert.match(made.id, /^\d{4}-\d{2}-\d{2}-evidence-ec_[A-Za-z0-9]+-\d+-claim-amended$/);
    assert.deepEqual([made.genre, made.caughtBy, made.verbatim, made.claimAfter, made.quoteBefore, made.quoteAfter], [
      "evidence-claim-amended", "reader", "Stroke was less frequent on the drug.", "Stroke was somewhat less frequent on the drug.",
      "Among 100 adults on the drug, 7 had a stroke", "Among 100 adults on the drug, 9 had a stroke"]);
    assert.match(made.whyItIsWrong, /challenged by a reader/);
    assert.equal(made.cardId, first.id);
    const again = await exportEvidenceIncidents({ database: db, outDir });
    assert.deepEqual([again.written.length, again.existing.length, again.pending], [0, 0, 0]);
    assert.equal((await readdir(outDir)).length, 1);
    const marked = (await incidents()).filter((row) => row.payload.exportedAt);
    assert.deepEqual(marked.map((row) => row.payload.exportedAt), ["2026-10-06T10:00:00.000Z"]);
    assert.equal((await incidents()).find((row) => !row.payload.exportable).payload.exportedAt, null, "the platform-only card's incident was never touched");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("the case is made from the incident's own fields: the claim copied, the words fixed by class, a card's title for an incident with no claim", () => {
  const base = { class: "card_withdrawn", cardId: "ec_abc12345", logEntryId: "7", occurredAt: "2026-10-06T01:00:00.000Z", caughtBy: "producer", trigger: "producer_edit", card: { title: "The card", producerKind: "platform" }, produced: {} };
  const made = evidenceIncidentCase(base);
  assert.equal(made.verbatim, "The card");
  assert.equal(made.id, "2026-10-06-evidence-ec_abc12345-7-card-withdrawn");
  assert.equal(made.capabilityId, null);
  for (const name of EVIDENCE_INCIDENT_CLASSES) assert.match(evidenceIncidentCase({ ...base, class: name }).whyItIsWrong, /\S/, name);
});

test("the counters are exported as families, and nothing is exported for a consumer that was not composed", options, async () => {
  const subject = consumer();
  const names = evidenceOutcomeMetricFamilies(subject.stats()).map((family) => family.name);
  assert.deepEqual(names, ["open_science_learning_evidence_incidents_total", "open_science_learning_evidence_observations_total", "open_science_learning_evidence_observations_skipped_total", "open_science_learning_evidence_outcomes_total"]);
  assert.deepEqual(evidenceOutcomeMetricFamilies(null), []);
  assert.deepEqual(evidenceOutcomeMetricFamilies(subject.stats())[0].series.map((entry) => entry.labels.class), [...EVIDENCE_INCIDENT_CLASSES]);
});
