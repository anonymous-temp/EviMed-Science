// Platform content enters the frontier through the same door as every external source (flywheel F09, plan §2.2, §4.3
// rule 2), against a real PostgreSQL: the source attribute `platform_produced` (contract 1.3.0) is read from the plugin,
// mirrored, shown as the label 「EviMed 出品」, and is the reason an item of such a source is a report and never first-hand —
// it never merges two events, it joins the event of the study it is about, and it is never counted as independent
// corroboration of anything: not in the institutions of an event, not in its heat, not in the hot list's two-source rule.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import {
  FrontierEvents, frontierEventCounts, frontierEventHeat, frontierEventInstitutions, frontierEventRole,
} from "../src/frontierEvents.mjs";
import { FrontierIngest } from "../src/frontierIngest.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { KnowledgePluginClient, validateSource } from "../src/knowledgePluginClient.mjs";
import { TEST_VOCABULARY, insertSource, memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { eventOf, insertComposedItem, metaValue, resetFrontier, testEmbedder, vectorAt } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const NOW = new Date("2026-09-22T04:00:00Z");
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

let database;
let dir;
let tokenFile;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-platform-"));
  tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, "test-only-ingest-token\n", { mode: 0o600 });
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
});
after(async () => {
  await database?.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  if (!database) return;
  await resetFrontier(database);
  await insertSource(database, "nejm", { authority: 5, owner_entity: "nejm-group" });
  await insertSource(database, "reuters", { name: "Reuters", source_type: "media", authority: 3, owner_entity: "reuters" });
  await insertSource(database, "ctgov", { name: "ClinicalTrials.gov", lane: "evidence", source_type: "evidence-body", authority: 4, owner_entity: "nlm" });
  await insertSource(database, "evimed-evidence", { name: "EviMed 证据中心", lane: "evidence", source_type: "evidence-body", authority: 3, owner_entity: "EviMed 证据中心" });
  await database.query("UPDATE evimed_frontier.sources SET platform_produced = true WHERE id = 'evimed-evidence'");
});

/** An editor that says every pair is the same event when asked, so that only the roles decide what merges. */
const editor = { available: true, judgeSameEvent: async (input) => ({ verdicts: input.candidates.map(() => "yes"), error: null, attempts: 1 }),
  writeEventDigest: async () => ({ verification: "passed", digestZh: "综述", latestZh: "最新", error: null }) };
const layer = (embedder = testEmbedder, now = NOW) => new FrontierEvents({ database, editor, embedder, budget: async () => ({ state: "ok" }), now: () => now, config: {} });
const platformItem = (overrides = {}) => insertComposedItem(database, { sourceId: "evimed-evidence", sourceType: "evidence-body", evidenceType: "systematic-review",
  lang: "zh", ...overrides });

// ── the attribute, read from the plugin and stored ──────────────────────────────────────────────────────────

test("the plugin's attribute is read as exactly `true`, and an older plugin that never sends it says false", () => {
  const read = (extra) => validateSource({ id: "s", name: "S", ...extra }).source.platform_produced;
  assert.equal(read({ platform_produced: true }), true);
  for (const value of [false, "true", 1, null, undefined]) assert.equal(read({ platform_produced: value }), false, String(value));
  assert.equal(read({}), false);
});

test("the mirror stores the label, a source that does not send it is false, and a change of it is a change the cards show", options, async () => {
  const plugin = memoryPlugin({ sources: [pluginSource("nejm"), pluginSource("evimed-evidence", { platform_produced: true, source_type: "evidence-body", owner_entity: "EviMed 证据中心" })], contract: "1.3.0" });
  const client = new KnowledgePluginClient({ baseUrl: "http://plugin.test:8080", tokenFile, fetchImpl: plugin.fetchImpl, sleep: async () => {} });
  await database.query("DELETE FROM evimed_frontier.sources");
  const ingest = new FrontierIngest({ database, plugin: client, vocabulary: TEST_VOCABULARY, pageLimit: 2 });
  await ingest.mirrorSources();
  const stored = async () => Object.fromEntries((await database.query("SELECT id, platform_produced FROM evimed_frontier.sources")).rows.map((row) => [row.id, row.platform_produced]));
  assert.deepEqual(await stored(), { nejm: false, "evimed-evidence": true });
  const before = await metaValue(database, "content_version");
  await ingest.mirrorSources();
  assert.equal(await metaValue(database, "content_version"), before, "the same label is no change");
  plugin.sources[0] = { ...plugin.sources[0], platform_produced: true };
  await ingest.mirrorSources();
  assert.deepEqual(await stored(), { nejm: true, "evimed-evidence": true });
  assert.equal(await metaValue(database, "content_version"), before + 1, "a card shows the label, so the lists' version moves with it");
});

// ── what the label does in the event layer ─────────────────────────────────────────────────────────────────

test("the role of a platform item is a report, whatever type its source or its evidence says", () => {
  assert.equal(frontierEventRole({ sourceType: "journal", evidenceType: "rct", platformProduced: true }), "report");
  assert.equal(frontierEventRole({ sourceType: "evidence-body", evidenceType: "guideline", platformProduced: true }), "report");
  assert.equal(frontierEventRole({ sourceType: "journal", evidenceType: "rct" }), "primary", "the same item of an outside source is first-hand");
  assert.equal(frontierEventRole({ sourceType: "journal", evidenceType: "rct", platformProduced: false }), "primary");
});

test("the platform's report adds no institution, no heat and no bilingual bonus: it is no corroboration", () => {
  const paper = { role: "primary", ownerEntity: "nejm-group", authority: 5, timelineAt: hoursAgo(2), lang: "en", sourceType: "journal" };
  const card = { role: "report", ownerEntity: "EviMed 证据中心", authority: 5, timelineAt: hoursAgo(1), lang: "zh", sourceType: "evidence-body", platformProduced: true };
  const alone = frontierEventCounts({ members: [paper], now: NOW });
  const together = frontierEventCounts({ members: [paper, card], now: NOW });
  assert.equal(together.sourceCount72h, alone.sourceCount72h, "an institution that is not independent is not counted");
  assert.equal(together.entityCount, alone.entityCount);
  assert.equal(together.bilingual, false, "a Chinese card beside an English paper is not two languages reporting it");
  assert.equal(together.reportCount, 2, "it is a report of the event all the same");
  assert.equal(frontierEventHeat({ members: [paper, card], now: NOW }), frontierEventHeat({ members: [paper], now: NOW }));
  assert.deepEqual(frontierEventInstitutions({ members: [paper, card], now: NOW }), frontierEventInstitutions({ members: [paper], now: NOW }));
  // The control: the same card from an outside institution is corroboration.
  const outside = { ...card, platformProduced: false, ownerEntity: "an-outside-institution" };
  assert.equal(frontierEventCounts({ members: [paper, outside], now: NOW }).sourceCount72h, 2);
  assert.ok(frontierEventHeat({ members: [paper, outside], now: NOW }) > frontierEventHeat({ members: [paper], now: NOW }));
});

test("a platform item never merges two events: it joins the oldest and is related to the other, even typed as a journal", options, async () => {
  const events = layer(null);
  const first = await insertComposedItem(database, { sourceId: "nejm", title: "Trial A", registryIds: ["NCT07000001"], visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  const second = await insertComposedItem(database, { sourceId: "ctgov", sourceType: "evidence-body", evidenceType: "other", title: "Trial B", registryIds: ["NCT09000001"],
    visibleAt: hoursAgo(20), timelineAt: hoursAgo(20) });
  await events.clusterPending();
  const [a, b] = await Promise.all([first, second].map((item) => eventOf(database, item.id)));
  assert.notEqual(a.id, b.id);
  // One card that is about both trials. Typed as a journal on purpose: only the label keeps it from being first-hand.
  const card = await platformItem({ sourceType: "journal", evidenceType: "rct", title: "A comparison of two trials", registryIds: ["NCT07000001", "NCT09000001"],
    clusterKeys: ["reg:NCT07000001", "reg:NCT09000001"], visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  const summary = await events.clusterPending();
  assert.equal(summary.merged, 0, "nothing was merged");
  assert.equal((await eventOf(database, card.id)).id, a.id, "it joins the oldest event it is about");
  const stillTwo = (await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.events WHERE merged_into IS NULL")).rows[0].n;
  assert.equal(stillTwo, 2, "the two events are still two");
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.event_links WHERE (from_event_id = $1 AND to_event_id = $2) OR (from_event_id = $2 AND to_event_id = $1)", [a.id, b.id])).rows[0].n, 1,
    "the other is only related");
  const member = (await database.query("SELECT role FROM evimed_frontier.event_items WHERE item_id = $1", [card.id])).rows[0];
  assert.equal(member.role, "report");
  // The control, the same shape from an outside journal, is first-hand and folds the two events into one.
  const control = await insertComposedItem(database, { sourceId: "nejm", sourceType: "journal", title: "The same comparison, from a journal", registryIds: ["NCT07000001", "NCT09000001"],
    clusterKeys: ["reg:NCT07000001x", "reg:NCT09000001x"], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  const bridged = await layer(null).clusterPending();
  assert.equal(bridged.merged, 1, "a first-hand item bridges what a platform item only relates");
  assert.ok(control.id);
});

test("an interpretation joins the event of the study it is about, and a first-hand card forms an event of its own", options, async () => {
  const events = layer(null);
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "FLOW trial", titleZh: "FLOW 试验", registryIds: ["NCT03819153"], visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  await events.clusterPending();
  const trial = await eventOf(database, paper.id);
  const interpretation = await platformItem({ title: "司美格鲁肽与肾病", registryIds: ["NCT03819153"], visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  const firstHand = await platformItem({ title: "平台复算", evidenceType: "other", visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  const summary = await events.clusterPending();
  assert.equal(summary.created, 1, "the first-hand card is an event of its own");
  assert.equal((await eventOf(database, interpretation.id)).id, trial.id, "the interpretation is one more report of the study's event");
  const own = await eventOf(database, firstHand.id);
  assert.notEqual(own.id, trial.id);
  assert.equal(own.has_primary, false, "a platform card is a report even alone");
  const after = await eventOf(database, paper.id);
  assert.equal(after.report_count, 2);
  assert.equal(after.source_count_72h, 1, "the platform's report is not a second institution");
  assert.equal(after.entity_count, 1);
  assert.equal(after.title_zh, "FLOW 试验", "the event is still named by its first-hand source");
});

test("the hot list's two-institution rule is not met by the platform: it takes a second independent source", options, async () => {
  const events = layer(null);
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "Hot trial", registryIds: ["NCT05000001"], scoreTotal: 70, visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  await platformItem({ title: "Hot trial, read by the platform", registryIds: ["NCT05000001"], visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  await events.clusterPending();
  await events.computeHot();
  let list = await events.hotList();
  assert.deepEqual(list.events, [], "one institution and the platform's own reading is one institution");
  await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Hot trial, in the news", registryIds: ["NCT05000001"], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  // A later run: two snapshots of one instant could not be told apart.
  const later = layer(null, new Date(NOW.getTime() + 60_000));
  await later.clusterPending();
  await later.computeHot();
  list = await later.hotList();
  assert.equal(list.events.length, 1, "a second independent institution makes it hot");
  assert.equal((await eventOf(database, paper.id)).source_count_72h, 2, "and the platform is still not counted");
  const period = await later.hotPeriod("week");
  assert.equal(period.events[0].period.institutions, 2);
  const page = await later.read((await eventOf(database, paper.id)).public_id);
  assert.equal(page.institutions.total, 2);
  assert.equal(page.members.length, 3, "every report is on the event's page, the platform's among them");
});

// ── what a reader is shown ─────────────────────────────────────────────────────────────────────────────────

test("a card says whether its source is the platform's own, and the platform's mention is not another institution's report", options, async () => {
  const service = new FrontierService({ database, config: { frontierEnabled: true, frontierAudience: "all", frontierTimeZone: "Asia/Shanghai" }, vocabulary: frontierVocabularyView(TEST_VOCABULARY) });
  const card = await platformItem({ title: "A platform card" });
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "A paper", mentions: [
    { sourceId: "reuters", url: "https://reuters.example.org/a", publishedAt: hoursAgo(1) },
    { sourceId: "evimed-evidence", url: "https://www.evimed.test/evidence/c/ec_1", publishedAt: hoursAgo(1) },
  ] });
  const own = (await service.getItem({ id: "reader" }, card.publicId)).body.item;
  assert.equal(own.source.platformProduced, true);
  const outside = (await service.getItem({ id: "reader" }, paper.publicId)).body.item;
  assert.equal(outside.source.platformProduced, false);
  assert.equal(outside.alsoReportedCount, 1, "Reuters is another institution; the platform's own mention is not");
  assert.deepEqual(outside.alsoReportedBy.map((mention) => mention.sourceId), ["reuters"]);
  assert.ok(vectorAt(1).length > 0);
});
