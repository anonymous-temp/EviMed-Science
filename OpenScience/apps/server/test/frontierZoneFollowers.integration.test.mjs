// Following a zone tells you (flywheel F10), against a real PostgreSQL: a card published or revised in a followed
// zone is one inbox event per card revision for each follower the `frontier` switch lets through, the issues of the
// daily and the weekly list the new and changed cards of a reader's own followed zones for that reader only, and the
// text of an issue is the same for everyone.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { FrontierDaily, followedZoneCards } from "../src/frontierDaily.mjs";
import { FRONTIER_ZONE_FANOUT_MAX, FrontierNotifications, frontierZoneNotice } from "../src/frontierNotifications.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { FrontierWeekly } from "../src/frontierWeekly.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { frontierNoticeHref, frontierNoticeTarget } from "@evimed/domain";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { TEST_VOCABULARY } from "./helpers/frontierFixtures.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const config = { frontierEnabled: true, frontierAudience: "all", frontierTimeZone: "Asia/Shanghai", frontierDailyTime: "07:30", frontierNotifyBatch: 50 };
const alice = { id: "alice" };
const readers = ["bob", "carol", "dave", "eve"];

let isolated, db, jobs, notices, delivery, service, calls;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "zonefollow");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await migrateProductStore(db);
  await migrateNotifications(db);
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development'),('carol','Carol','development'),('dave','Dave','development'),('eve','Eve','development')");
  jobs = new ProductJobs(db);
  notices = new NotificationService(db);
  delivery = new FrontierNotifications({ database: db, jobs, notifications: notices, config });
  // The same hook the server composes: told after a write has committed.
  calls = [];
  service = new EvidenceZoneService({ database: db, onCardPublished: async (event) => { calls.push(event); await delivery.notifyZoneFollowers(event); } });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones, evimed_product.jobs CASCADE");
  await db.query("DELETE FROM evimed_inbox.notifications");
  for (const id of readers) {
    await notices.preferences(id);
    await db.query("UPDATE evimed_inbox.preferences SET switches=$2::jsonb WHERE user_id=$1", [id, JSON.stringify({ notify: true, review: true, question: true, frontier: true })]);
  }
  calls.length = 0;
});

const cardInput = {
  title: "Does apixaban prevent stroke?", subtype: "academic", summary: "A randomized trial summary.", body: "The trial reports fewer strokes.",
  sources: [{ title: "Trial", url: "https://example.org/trial", excerpt: "Among 100 adults on the drug, 7 had a stroke." }], limitations: "One trial.", provenance: "Authored synthesis",
};
const makeZone = async (title = "Stroke prevention", { published = true } = {}) => {
  const { zone } = await service.save(alice, { title, description: "d", background: "b" });
  return published ? (await service.save(alice, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone : zone;
};
const follow = async (userId, zone) => service.act({ id: userId }, zone.id, "follow", { expectedRevision: (await service.detail({ id: userId }, zone.id)).zone.revision });
const publish = (zone, fields = {}) => service.save(alice, { ...cardInput, state: "published", ...fields }, zone.id, null, true).then((result) => result.evidence);
const revise = (zone, card, fields) => service.save(alice, { expectedRevision: card.revision, ...fields }, zone.id, card.id).then((result) => result.evidence);
const deliverAll = async () => { for (let round = 0; round < 3; round += 1) await delivery.deliverDue(); };
const inbox = async (userId) => (await db.query("SELECT title, body, event_count, source, group_key, read_at FROM evimed_inbox.notifications WHERE user_id=$1 ORDER BY created_at", [userId])).rows;

test("the notice of a card revision is told by name and opens the card", () => {
  const notice = frontierZoneNotice({ zoneId: "ez_1", cardId: "ec_1", cardTitle: "标题".repeat(100), zoneTitle: "专区", revision: 3, change: "revised" });
  assert.equal(notice.noticeType, "notify");
  assert.ok(notice.title.length <= 120, "within the inbox's own bound");
  assert.equal(notice.body, "专区 · 证据卡已更新（第 3 版）");
  assert.equal(frontierZoneNotice({ zoneId: "ez_1", cardId: "ec_1", cardTitle: "t", zoneTitle: "专区", revision: 1, change: "published" }).body, "专区 · 新证据卡");
  // What the upkeep of a card reports (a challenge upheld, a card withdrawn) is the same notice, worded as what happened.
  assert.equal(frontierZoneNotice({ zoneId: "ez_1", cardId: "ec_1", cardTitle: "t", zoneTitle: "专区", revision: 4, change: "corrected" }).body, "专区 · 证据卡已更正（第 4 版）");
  assert.equal(frontierZoneNotice({ zoneId: "ez_1", cardId: "ec_1", cardTitle: "t", zoneTitle: "专区", revision: 4, change: "withdrawn" }).body, "专区 · 证据卡已撤回");
  assert.equal(notice.idempotencyKey, "frontier-zone:ec_1:3");
  assert.equal(notice.groupKey, "frontier-zone:ec_1");
  assert.deepEqual(frontierNoticeTarget(notice.source), { kind: "zone", key: "ez_1:ec_1", switch: "frontier" });
  assert.equal(frontierNoticeHref(notice.source), "/app/frontier/zones/ez_1/evidence/ec_1");
});

test("a card published in a followed zone is one notice for each follower the switch lets through, and for nobody else", options, async () => {
  const zone = await makeZone();
  const other = await makeZone("Another zone");
  await follow("bob", zone);
  await follow("carol", zone);
  await follow("eve", other);
  await db.query("UPDATE evimed_inbox.preferences SET switches=$1::jsonb WHERE user_id='carol'", [JSON.stringify({ notify: true, review: true, question: true, frontier: false })]);
  const card = await publish(zone);
  assert.deepEqual(calls.map((event) => [event.zoneId, event.cardId, event.revision, event.change]), [[zone.id, card.id, 1, "published"]]);
  await deliverAll();
  const [notice, ...rest] = await inbox("bob");
  assert.equal(rest.length, 0);
  assert.equal(notice.title, "Does apixaban prevent stroke?");
  assert.equal(notice.body, "Stroke prevention · 新证据卡");
  assert.equal(notice.event_count, 1);
  assert.deepEqual(notice.source, { type: "system", id: `frontier-zone:${zone.id}:${card.id}` });
  for (const quiet of ["carol", "dave", "eve", "alice"]) assert.deepEqual(await inbox(quiet), [], `${quiet} follows nothing here, or turned the switch off`);
});

test("one event per card revision: a replay is nothing, a new revision is one more event on the same inbox item", options, async () => {
  const zone = await makeZone();
  await follow("bob", zone);
  const card = await publish(zone);
  await deliverAll();
  assert.equal((await delivery.notifyZoneFollowers({ zoneId: zone.id, cardId: card.id, revision: 1, change: "published" })).queued, 0, "the same revision is the same event");
  await deliverAll();
  assert.equal((await inbox("bob"))[0].event_count, 1);
  await db.query("UPDATE evimed_inbox.notifications SET read_at=clock_timestamp() WHERE user_id='bob'");
  const revised = await revise(zone, card, { body: "The trial reports fewer strokes and more bleeding." });
  assert.equal(revised.revision, 2);
  await deliverAll();
  const items = await inbox("bob");
  assert.equal(items.length, 1, "a burst of edits to one card is one row, not one per edit");
  assert.equal(items[0].event_count, 2);
  assert.equal(items[0].body, "Stroke prevention · 证据卡已更新（第 2 版）");
  assert.equal(items[0].read_at, null, "a card changed again after it was read is news again");
  const jobsCount = Number((await db.query("SELECT count(*) AS n FROM evimed_product.jobs WHERE kind='frontier-notify'")).rows[0].n);
  assert.equal(jobsCount, 2, "one job per follower per revision");
});

test("only a change to what a reader can read is a revision: a refresh of the provenance, a draft or a withdrawal tells nobody", options, async () => {
  const zone = await makeZone();
  await follow("bob", zone);
  const draft = await publish(zone, { title: "A draft", state: "draft" });
  assert.deepEqual(calls, [], "a draft is not published");
  const card = await publish(zone);
  assert.equal(calls.length, 1);
  const refreshed = await revise(zone, card, { provenance: "Checked again on a later day" });
  assert.equal(refreshed.revision, 2);
  assert.equal(calls.length, 1, "the provenance is not what a follower reads");
  const edited = await revise(zone, refreshed, { summary: "A new summary." });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].change, "revised");
  const withdrawn = await revise(zone, edited, { state: "draft" });
  assert.equal(withdrawn.state, "draft");
  assert.equal(calls.length, 2, "taking a card back is not news");
  const republished = await revise(zone, withdrawn, { state: "published" });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].change, "published", "a card that was a draft and is published again is published");
  assert.ok(draft.id);
  // A card in a zone that is not published is no one's news, though a follow outlived the publication.
  await service.save(alice, { expectedRevision: (await service.detail(alice, zone.id)).zone.revision, state: "draft" }, zone.id);
  const before = calls.length;
  await revise(zone, republished, { summary: "Edited while the zone is a draft." });
  assert.equal(calls.length, before, "an unpublished zone's card is not published");
  assert.equal((await delivery.notifyZoneFollowers({ zoneId: zone.id, cardId: republished.id, revision: 9, change: "revised" })).queued, 0, "the notifier checks for itself");
});

test("a follow taken back, or a card withdrawn, before delivery is no notice; the audience and the master switch hold too", options, async () => {
  const zone = await makeZone();
  await follow("bob", zone);
  await follow("carol", zone);
  await follow("dave", zone);
  const card = await publish(zone);
  await service.act({ id: "bob" }, zone.id, "follow", { expectedRevision: (await service.detail(alice, zone.id)).zone.revision }, null, true);
  await db.query("UPDATE evimed_inbox.preferences SET switches=$1::jsonb WHERE user_id='carol'", [JSON.stringify({ notify: false, review: true, question: true, frontier: true })]);
  await deliverAll();
  assert.deepEqual(await inbox("bob"), [], "unfollowed before delivery");
  assert.deepEqual(await inbox("carol"), [], "the account's notices are off");
  assert.equal((await inbox("dave")).length, 1);
  assert.equal(delivery.status().counters.skipped >= 2, true);
  const withdrawnBeforeDelivery = await publish(zone, { title: "Withdrawn at once" });
  await revise(zone, withdrawnBeforeDelivery, { state: "draft" });
  await deliverAll();
  assert.deepEqual((await inbox("dave")).map((item) => item.title), ["Does apixaban prevent stroke?"], "a card taken back before its notice was delivered is no notice");
  const preview = new FrontierNotifications({ database: db, jobs, notifications: notices, config: { ...config, frontierAudience: "operators", operatorUsers: ["alice"] } });
  assert.equal(await preview.eligible("dave", { kind: "zone", key: `${zone.id}:${card.id}` }), false, "a reader outside the module's audience is not told");
});

test("the fan-out is bounded and says when it was", options, async () => {
  assert.ok(FRONTIER_ZONE_FANOUT_MAX >= 1000);
  const zone = await makeZone();
  const card = await publish(zone);
  const result = await delivery.notifyZoneFollowers({ zoneId: zone.id, cardId: card.id, revision: 1, change: "published" });
  assert.deepEqual(result, { queued: 0 }, "no follower, no job");
  await assert.rejects(delivery.notifyZoneFollowers({ zoneId: zone.id, cardId: card.id, revision: 0, change: "published" }), TypeError);
  await assert.rejects(delivery.notifyZoneFollowers({ zoneId: zone.id, cardId: card.id, revision: 1, change: "deleted" }), TypeError);
  const unwired = new FrontierNotifications({ database: db, config });
  assert.deepEqual(await unwired.notifyZoneFollowers({ zoneId: zone.id, cardId: card.id, revision: 1, change: "published" }), { queued: 0, unavailable: true });
});

/** A card's two clocks set by hand: when its revision was recorded, and when it last changed. */
async function stamp(card, revision, recordedAt, updatedAt = null) {
  await db.query("UPDATE evimed_frontier.evidence_card_revisions SET recorded_at=$3 WHERE card_id=$1 AND revision=$2", [card.id, revision, recordedAt]);
  if (updatedAt) await db.query("UPDATE evimed_frontier.evidence_cards SET updated_at=$2 WHERE id=$1", [card.id, updatedAt]);
}

test("the daily's section lists the new and changed cards of the reader's own followed zones, for that reader only", options, async () => {
  const day = "2026-09-22";
  const windowStart = "2026-09-21T23:00:00Z";
  const windowEnd = "2026-09-22T23:00:00Z";
  const zone = await makeZone("Stroke prevention");
  const quiet = await makeZone("Quiet zone");
  const draftZone = await makeZone("Draft zone", { published: false });
  await follow("bob", zone);
  await follow("bob", quiet);
  await follow("carol", zone);
  await follow("eve", quiet);
  // An older card that changed in the window, a card published in it, a card whose provenance alone moved in it, and one
  // that did not move.
  const older = await publish(zone, { title: "Older card" });
  await stamp(older, 1, "2026-09-10T00:00:00Z");
  const olderEdited = await revise(zone, older, { body: "The trial reports fewer strokes, and the follow-up confirms it." });
  await stamp(olderEdited, 2, "2026-09-22T05:00:00Z", "2026-09-22T05:00:00Z");
  const fresh = await publish(zone, { title: "Fresh card" });
  await stamp(fresh, 1, "2026-09-22T06:00:00Z", "2026-09-22T06:00:00Z");
  const checked = await publish(zone, { title: "Checked card" });
  await stamp(checked, 1, "2026-09-10T00:00:00Z");
  const checkedAgain = await revise(zone, checked, { provenance: "Sources checked again" });
  await stamp(checkedAgain, 2, "2026-09-22T07:00:00Z", "2026-09-22T07:00:00Z");
  const still = await publish(zone, { title: "Unmoved card" });
  await stamp(still, 1, "2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z");
  await publish(draftZone, { title: "In a draft zone" });
  const asked = (userId) => followedZoneCards(db, { userId, from: windowStart, to: windowEnd });
  const forBob = await asked("bob");
  assert.deepEqual(forBob.map((entry) => [entry.zoneTitle, entry.cards.map((card) => [card.title, card.change])]),
    [["Stroke prevention", [["Fresh card", "new"], ["Older card", "updated"]]]], "newest first; bob follows two zones and the quiet one has nothing");
  assert.equal(JSON.stringify(forBob).includes("Checked card"), false, "a refreshed check date is not an update");
  assert.equal(JSON.stringify(forBob).includes("Unmoved card"), false);
  assert.equal(JSON.stringify(forBob).includes("In a draft zone"), false);
  assert.equal((await asked("carol")).length, 1);
  assert.deepEqual(await asked("dave"), [], "a reader who follows nothing is listed nothing");
  assert.deepEqual(await asked("eve"), [], "eve follows the quiet zone only");

  // Through the issue the reader opens: the same stored issue, a different section, and the same text.
  await db.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety, markdown, item_ids, model)
    VALUES ($1::date, $2, $3, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '# 日报', '{}', 'deepseek-flash')`, [day, windowStart, windowEnd]);
  const daily = new FrontierDaily({ database: db, config });
  const frontier = new FrontierService({ database: db, config, vocabulary: frontierVocabularyView(TEST_VOCABULARY), daily });
  const bobsIssue = (await frontier.dailyIssue({ id: "bob" }, day)).daily;
  const davesIssue = (await frontier.dailyIssue({ id: "dave" }, day)).daily;
  assert.deepEqual(bobsIssue.followedZones.map((entry) => entry.cards.map((card) => card.title)), [["Fresh card", "Older card"]]);
  assert.deepEqual(davesIssue.followedZones, []);
  assert.equal(bobsIssue.markdown, davesIssue.markdown, "the issue's text is the same for everyone; the section is the reader's own");
  assert.equal(bobsIssue.markdown.includes("Fresh card"), false);
  const [entry] = bobsIssue.followedZones;
  assert.equal(entry.zoneId, zone.id);
  assert.equal(entry.cards[0].id, fresh.id);
  assert.ok(Date.parse(entry.cards[0].updatedAt));

  // The weekly reads the same, over its own window.
  const weekly = new FrontierWeekly({ database: db, config });
  assert.deepEqual((await weekly.followedZones("bob", { windowStart, windowEnd })).map((zoneEntry) => zoneEntry.zoneTitle), ["Stroke prevention"]);
  assert.deepEqual(await weekly.followedZones("dave", { windowStart, windowEnd }), []);
  assert.deepEqual(await weekly.followedZones("bob", { windowStart: "2026-08-01T00:00:00Z", windowEnd: "2026-08-02T00:00:00Z" }), []);
});
