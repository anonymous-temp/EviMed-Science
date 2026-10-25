// 追踪 against a real PostgreSQL (frontierTrack.mjs + the service's reads): the pipeline's extraction round on the item lease, the
// approval and guideline lists, the congress list on the feed's calendar day, a congress's items, the day's recap, and what a reader
// is served.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { frontierCongressById } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { frontierItemGenre, frontierReaderText } from "../src/frontierPipeline.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { FRONTIER_RECAP_LIMITS, FrontierTrack, frontierCongressPatterns } from "../src/frontierTrack.mjs";
import { FRONTIER_TRACK_FACTS_VERSION } from "../src/frontierTrackFacts.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const vocabulary = frontierVocabularyView(TEST_VOCABULARY);
// 25 October 2026, 12:00 in Asia/Shanghai: ESMO 2026 (23–27 October) is on.
const NOW = new Date("2026-10-25T04:00:00Z");
const sha = (/** @type {string} */ value) => createHash("sha256").update(value).digest("hex");

/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development')", [reader.id]);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id = $1", [reader.id]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.congress_recaps");
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.events");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await insertSource(database, "fda-news", { name: "FDA news", owner_entity: "U.S. Food and Drug Administration", source_type: "regulator", lane: "regulatory" });
  await insertSource(database, "wire", { name: "A wire", owner_entity: "Cision PR Newswire", source_type: "news", lane: "news" });
  await insertSource(database, "guide-news", { name: "Guideline news", owner_entity: "Some society", source_type: "news", lane: "news" });
});

/**
 * An item the pipeline would extract from: published, its text settled (`reader_tidy` with the hash of what it is read from).
 * @param {Record<string, any>} [overrides] genre, text, publishedAt, track (a stored record), tags, leadZh, eventId, selected, specialties, …
 */
async function item({ genre = "approval", text = "Some text of the item.", track = null, tags = [], leadZh = null, eventId = null, trackVersion = null, publishedAt = "2026-10-24T04:00:00Z", ...rest } = {}) {
  const made = await insertItem(database, { sourceId: "wire", title: "An item", publishedAt, timelineAt: publishedAt, visibleAt: publishedAt, abstract: text, evidenceType: "other", ...rest });
  await database.query(`UPDATE evimed_frontier.items SET genre = $2, track_facts = $3::jsonb, track_facts_version = $4, tags = $5, lead_zh = $6, event_id = $7 WHERE id = $1`,
    [made.id, genre, track ? JSON.stringify(track) : null, track ? trackVersion ?? FRONTIER_TRACK_FACTS_VERSION : trackVersion, tags, leadZh, eventId]);
  await database.query("UPDATE evimed_frontier.item_texts SET reader_tidy = $2::jsonb WHERE item_id = $1", [made.id, JSON.stringify({ source: "abstract", sha: sha(text), drop: [] })]);
  return made;
}

/** A stored approval record. @param {Record<string, any>} [over] */
const approvalRecord = (over = {}) => ({ version: FRONTIER_TRACK_FACTS_VERSION, basis: "x", kind: "approval", approval: "new-drug", agency: { key: "fda", label: "FDA", from: "source" },
  drug: { text: "Hibsago", quote: "Hibsago" }, indication: { text: "慢性乙型肝炎", quote: "chronic hepatitis B" }, date: null, ...over });
/** A stored guideline record. @param {Record<string, any>} [over] */
const guidelineRecord = (over = {}) => ({ version: FRONTIER_TRACK_FACTS_VERSION, basis: "x", kind: "guideline", body: { text: "美国内科医师学会", quote: "ACP" },
  scope: { text: "绝经症状", quote: "menopausal" }, recommendations: [{ text: "使用雌激素", grade: "strong", quote: "recommends estrogen therapy" }], ...over });

/** @param {Record<string, any>} [over] */
function round(over = {}) {
  const calls = /** @type {string[]} */ ([]);
  const base = {
    editor: { available: true, model: "deepseek-flash", callJson: async () => null, writeJson: async () => null }, workerId: "w-test", leaseMs: 600_000, now: NOW,
    budget: { state: "ok" }, providerPaused: () => false, onProviderRefused: (/** @type {string} */ code) => { calls.push(code); },
    readerText: frontierReaderText, itemGenre: frontierItemGenre,
    sources: async (/** @type {string[]} */ ids) => new Map((await database.query("SELECT * FROM evimed_frontier.sources WHERE id = ANY($1::text[])", [ids])).rows.map((/** @type {any} */ row) => [row.id, row])),
  };
  return { ...base, ...over, calls };
}
const track = () => new FrontierTrack({ database, now: () => NOW, timeZone: "Asia/Shanghai" });
const record = async (/** @type {string} */ id) => (await database.query("SELECT track_facts, track_facts_version, lease_owner FROM evimed_frontier.items WHERE id = $1", [id])).rows[0];

test("the extraction round writes the approval, the guideline and a none record, newest first, and leaves an item of another genre alone", options, async () => {
  const text = "FDA approved Hibsago (bepirovirsen) for chronic hepatitis B on October 20, 2026.";
  const older = await item({ text, publishedAt: "2026-10-20T04:00:00Z" });
  const newer = await item({ text: "FDA approved Hibsago (bepirovirsen) for chronic hepatitis B on October 24, 2026.", publishedAt: "2026-10-24T04:00:00Z" });
  const noise = await item({ text: "A school lunch box inspection.", publishedAt: "2026-10-23T04:00:00Z" });
  const guideline = await item({ genre: "guideline", text: "ACP recommends estrogen therapy for menopausal vasomotor symptoms.", publishedAt: "2026-10-22T04:00:00Z" });
  const paper = await item({ genre: "paper", text: "A trial of something." });
  const asked = /** @type {string[]} */ ([]);
  const editor = { available: true, model: "deepseek-flash", callJson: async (/** @type {any[]} */ messages) => {
    const input = String(messages[1].content);
    asked.push(input.split("\n").find((line) => line.startsWith("标题：")) ?? "");
    if (/lunch box/.test(input)) return { decision: false };
    if (/ACP recommends/.test(input)) return { guideline: true, body: { text: "ACP", quote: "ACP" }, scope: null, recommendations: [{ text: "使用雌激素治疗绝经血管舒缩症状", grade: null, quote: "ACP recommends estrogen therapy" }] };
    return { decision: true, approval: "new-drug", agency: null, drug: { text: "Hibsago (bepirovirsen)", quote: "Hibsago (bepirovirsen)" },
      indication: { text: "慢性乙型肝炎", quote: "chronic hepatitis B" }, date: null };
  } };
  const written = await track().extractRound(round({ editor }));
  assert.equal(written, 4);
  assert.equal(asked.length, 4, "the paper is not asked");
  const approvalFacts = (await record(newer.id)).track_facts;
  assert.equal(approvalFacts.kind, "approval");
  assert.equal(approvalFacts.drug.text, "Hibsago (bepirovirsen)");
  assert.equal(approvalFacts.agency, null, "an owner that is no agency leaves the model's null");
  assert.equal(approvalFacts.basis, sha("FDA approved Hibsago (bepirovirsen) for chronic hepatitis B on October 24, 2026."));
  assert.equal((await record(older.id)).track_facts.kind, "approval");
  assert.equal((await record(noise.id)).track_facts.none, true);
  assert.equal((await record(guideline.id)).track_facts.recommendations.length, 1);
  assert.equal((await record(paper.id)).track_facts, null);
  assert.equal((await record(newer.id)).lease_owner, null, "the lease is released with the write");
});

test("a round is newest first and bounded: six items a round, two once the budget is past 80 %, none when it is spent or the provider is paused", options, async () => {
  for (let index = 0; index < 8; index += 1) await item({ text: `Text number ${index}.`, publishedAt: `2026-10-${String(10 + index).padStart(2, "0")}T04:00:00Z` });
  const order = /** @type {string[]} */ ([]);
  const editor = { available: true, model: "m", callJson: async (/** @type {any[]} */ messages) => { order.push(/Text number (\d)/.exec(String(messages[1].content))?.[1] ?? "?"); return { decision: false }; } };
  const instance = track();
  assert.equal(await instance.extractRound(round({ editor, budget: { state: "exhausted" } })), 0);
  assert.equal(await instance.extractRound(round({ editor, providerPaused: () => true })), 0);
  assert.equal(await instance.extractRound(round({ editor: { ...editor, available: false } })), 0);
  assert.deepEqual(order, []);
  assert.equal(await instance.extractRound(round({ editor, budget: { state: "throttled" } })), 2);
  assert.deepEqual([...order].sort(), ["6", "7"], "the newest two");
  order.length = 0;
  assert.equal(await instance.extractRound(round({ editor })), 6);
  assert.equal(order.length, 6);
  assert.equal(await instance.extractRound(round({ editor })), 0, "everything has its record");
});

test("an item with a record for its text and the current instructions is not asked again; a changed text or other instructions ask again", options, async () => {
  const text = "FDA approved Hibsago for chronic hepatitis B.";
  const made = await item({ text });
  let asks = 0;
  const editor = { available: true, model: "m", callJson: async () => { asks += 1; return { decision: false }; } };
  const instance = track();
  await instance.extractRound(round({ editor }));
  await instance.extractRound(round({ editor }));
  assert.equal(asks, 1);
  // The text changed after the record was written: its settled hash is another.
  await database.query("UPDATE evimed_frontier.item_texts SET reader_tidy = $2::jsonb WHERE item_id = $1", [made.id, JSON.stringify({ source: "abstract", sha: sha("another text"), drop: [] })]);
  await instance.extractRound(round({ editor }));
  assert.equal(asks, 2);
  // The instructions changed: the record carries the version it was written under.
  await database.query("UPDATE evimed_frontier.items SET track_facts_version = 'track-0.00000000' WHERE id = $1", [made.id]);
  await instance.extractRound(round({ editor }));
  assert.equal(asks, 3);
});

test("a call the provider refused records nothing, says so, and the item is asked again; so is one the budget refused", options, async () => {
  const made = await item({ text: "FDA approved Hibsago." });
  const instance = track();
  const refused = round({ editor: { available: true, model: "m", callJson: async () => { throw Object.assign(new Error("x"), { code: "model_gateway_rate_limited" }); } } });
  assert.equal(await instance.extractRound(refused), 0);
  assert.deepEqual(refused.calls, ["model_gateway_rate_limited"]);
  assert.equal((await record(made.id)).track_facts, null);
  assert.equal((await record(made.id)).lease_owner, null);
  const spent = round({ editor: { available: true, model: "m", callJson: async () => { throw Object.assign(new Error("x"), { code: "usage_budget_exceeded" }); } } });
  assert.equal(await instance.extractRound(spent), 0);
  assert.deepEqual(spent.calls, [], "a spent budget is not a provider outage");
  assert.equal((await record(made.id)).track_facts, null);
  assert.equal(await instance.extractRound(round({ editor: { available: true, model: "m", callJson: async () => ({ decision: false }) } })), 1, "asked again, and written");
});

test("an item older than the backfill window, an unsettled text and an item another worker holds are not claimed", options, async () => {
  await item({ text: "Old approval text.", publishedAt: "2026-08-01T04:00:00Z" });
  const unsettled = await item({ text: "Unsettled text." });
  await database.query("UPDATE evimed_frontier.item_texts SET reader_tidy = NULL WHERE item_id = $1", [unsettled.id]);
  const held = await item({ text: "Held by another worker." });
  await database.query("UPDATE evimed_frontier.items SET lease_owner = 'someone', lease_until = $2 WHERE id = $1", [held.id, new Date(NOW.getTime() + 600_000)]);
  let asks = 0;
  assert.equal(await track().extractRound(round({ editor: { available: true, model: "m", callJson: async () => { asks += 1; return { decision: false }; } } })), 0);
  assert.equal(asks, 0);
});

test("the approval list: the last 90 days by the decision's day, `other` left out, an agency's own, a page at a time, the year's count by agency", options, async () => {
  await item({ track: approvalRecord(), text: "a1", publishedAt: "2026-10-24T04:00:00Z" });
  await item({ track: approvalRecord({ agency: { key: "ema", label: "EMA", from: "source" }, drug: { text: "Ximluci", quote: "Ximluci" } }), text: "a2", publishedAt: "2026-10-10T04:00:00Z" });
  // Dated by the decision, not the day it was reported.
  await item({ track: approvalRecord({ agency: { key: "nmpa", label: "NMPA", from: "text" }, drug: { text: "优赫得", quote: "优赫得" }, date: { value: "2026-09-29", quote: "x" } }), text: "a3", publishedAt: "2026-10-08T04:00:00Z" });
  await item({ track: approvalRecord({ approval: "other" }), text: "a4" });
  await item({ track: { ...approvalRecord(), none: true }, text: "a5" });
  await item({ track: approvalRecord({ agency: null, drug: { text: "Unlabelled", quote: "Unlabelled" } }), text: "a6", publishedAt: "2026-08-20T04:00:00Z" });
  await item({ track: approvalRecord({ drug: { text: "Too old", quote: "Too old" } }), text: "a7", publishedAt: "2026-05-01T04:00:00Z" });
  await item({ genre: "guideline", track: guidelineRecord(), text: "a8" });
  const instance = track();
  const all = await instance.approvals();
  assert.deepEqual(all.rows.map((row) => row.facts.drug.text), ["Hibsago", "Ximluci", "优赫得", "Unlabelled"]);
  assert.deepEqual(all.rows.map((row) => row.at), ["2026-10-24", "2026-10-10", "2026-09-29", "2026-08-20"]);
  assert.equal(all.from, "2026-07-27");
  assert.deepEqual(all.agencies.map((entry) => [entry.key, entry.count]).sort(), [["ema", 1], ["fda", 1], ["nmpa", 1], ["none", 1]]);
  assert.equal(all.ytd.total, 5, "the year's count reaches back to January: the old one is in it");
  assert.equal(all.ytd.since, "2026-05-01");
  // `since` is how far back the tracker has seen anything, the day it was reported: a decision dated long before it was reported
  // (a late report of a February approval) counts in the year and does not move the start.
  await item({ track: approvalRecord({ drug: { text: "Late report", quote: "Late report" }, date: { value: "2026-02-03", quote: "x" } }), text: "a9", publishedAt: "2026-10-09T04:00:00Z" });
  const later = await instance.approvals();
  assert.equal(later.ytd.total, 6);
  assert.equal(later.ytd.since, "2026-05-01");
  assert.deepEqual((await instance.approvals({ agency: "ema" })).rows.map((row) => row.facts.drug.text), ["Ximluci"]);
  assert.deepEqual((await instance.approvals({ agency: "none" })).rows.map((row) => row.facts.drug.text), ["Unlabelled"]);
  assert.deepEqual((await instance.approvals({ kind: "new-indication" })).rows, []);
  const first = await instance.approvals({ limit: 2 });
  assert.equal(first.rows.length, 2);
  assert.ok(first.next);
  const second = await instance.approvals({ limit: 2, cursor: first.next });
  assert.deepEqual([...first.rows, ...second.rows].map((row) => row.facts.drug.text), ["Hibsago", "Ximluci", "优赫得", "Unlabelled"]);
  assert.equal(second.next, null);
  assert.deepEqual((await instance.approvals({ cursor: "not-a-cursor" })).rows.length, 4, "an unreadable cursor reads from the top");
});

test("the guideline list: newest first, a specialty's own, the specialties it holds, none records left out", options, async () => {
  await item({ genre: "guideline", track: guidelineRecord(), text: "g1", publishedAt: "2026-10-24T04:00:00Z", specialties: ["oncology"], title: "A new guideline" });
  await item({ genre: "guideline", track: guidelineRecord({ recommendations: [] }), text: "g2", publishedAt: "2026-10-12T04:00:00Z", specialties: ["cardiology", "oncology"] });
  await item({ genre: "guideline", track: { ...guidelineRecord(), none: true }, text: "g3", specialties: ["oncology"] });
  await item({ genre: "guideline", track: guidelineRecord(), text: "g4", publishedAt: "2026-05-12T04:00:00Z", specialties: ["oncology"] });
  const instance = track();
  const all = await instance.guidelines();
  assert.deepEqual(all.rows.map((row) => row.at), ["2026-10-24", "2026-10-12"]);
  assert.deepEqual(all.specialties, [{ key: "oncology", count: 2 }, { key: "cardiology", count: 1 }]);
  assert.deepEqual((await instance.guidelines({ specialty: "cardiology" })).rows.length, 1);
  assert.equal((await instance.guidelines({ days: 400 })).rows.length, 3);
});

test("the congress list is read on the feed's day: the status moves at midnight in Asia/Shanghai, and a congress is listed from 60 days before to 30 after", options, async () => {
  const at = (/** @type {string} */ iso) => new FrontierTrack({ database, now: () => new Date(iso), timeZone: "Asia/Shanghai" });
  const ids = async (/** @type {FrontierTrack} */ instance) => (await instance.congresses()).map((congress) => `${congress.id}:${congress.status}`);
  const onTheDay = await ids(at("2026-10-25T04:00:00Z"));
  assert.ok(onTheDay.includes("esmo-2026:ongoing"));
  assert.ok(onTheDay.includes("aha-2026:upcoming"));
  assert.ok(onTheDay.includes("gw-icc-2026:recent"));
  assert.ok(onTheDay.includes("ash-2026:upcoming"), "ASH opens on 12 December: 48 days ahead");
  assert.ok(!onTheDay.some((entry) => entry.startsWith("jpm-2027")), "JPM opens in January: more than 60 days ahead");
  assert.ok(onTheDay.indexOf("esmo-2026:ongoing") < onTheDay.indexOf("aha-2026:upcoming"), "on now first");
  assert.ok(onTheDay.indexOf("aha-2026:upcoming") < onTheDay.indexOf("gw-icc-2026:recent"));
  // 15:30 UTC on the 22nd is 23:30 on the 22nd in Shanghai; 16:30 UTC is already the 23rd there.
  assert.ok((await ids(at("2026-10-22T15:30:00Z"))).includes("esmo-2026:upcoming"));
  assert.ok((await ids(at("2026-10-22T16:30:00Z"))).includes("esmo-2026:ongoing"));
  assert.ok((await ids(at("2026-10-27T15:30:00Z"))).includes("esmo-2026:ongoing"));
  assert.ok((await ids(at("2026-10-27T16:30:00Z"))).includes("esmo-2026:recent"));
  assert.ok(!(await ids(at("2026-11-27T04:00:00Z"))).some((entry) => entry.startsWith("esmo-2026")), "past 30 days after its end it is gone");
});

test("a congress's items are those that name it by the calendar's words or by its code with the year in either order, within three days of the meeting", options, async () => {
  const patterns = frontierCongressPatterns(/** @type {any} */ (frontierCongressById("esmo-2026")));
  assert.ok(patterns.length >= 5);
  const day = (/** @type {number} */ d) => `2026-10-${String(d).padStart(2, "0")}T04:00:00Z`;
  const named = [
    await item({ text: "t1", publishedAt: day(24), title: "Trial results presented at ESMO 2026" }),
    await item({ text: "t2", publishedAt: day(24), title: "信达在2026 ESMO首次公布 I 期数据" }),
    await item({ text: "t3", publishedAt: day(23), title: "Phase 3 data", summaryZh: "在 ESMO Congress 上公布的结果" }),
    await item({ text: "t4", publishedAt: day(25), title: "Late-breaking abstract", tags: ["ESMO大会"] }),
    await item({ text: "t5", publishedAt: day(24), title: "Plain title", leadZh: "欧洲肿瘤内科学会年会上的一项研究" }),
  ];
  await item({ text: "n1", publishedAt: day(24), title: "Chest pain in the emergency department" });
  await item({ text: "n2", publishedAt: day(24), title: "Pulmonary edema after surgery" });
  await item({ text: "n3", publishedAt: day(10), title: "Looking ahead to ESMO 2026" });
  await item({ text: "n4", publishedAt: day(31), title: "ESMO 2026 revisited" });
  const before = await item({ text: "w1", publishedAt: day(20), title: "ESMO 2026 starts in three days" });
  // Another report of the same event is the congress's too, even where it does not name the meeting.
  const event = (await database.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at) VALUES ('esmoevent0000001', '一项研究', 'evidence', now(), now()) RETURNING id`)).rows[0].id;
  await database.query("UPDATE evimed_frontier.items SET event_id = $2 WHERE id = ANY($1::bigint[])", [[named[0].id], event]);
  const sibling = await item({ text: "e1", publishedAt: day(24), title: "The same study from another outlet", eventId: event });
  const instance = track();
  const hub = await instance.congress("esmo-2026");
  assert.ok(hub);
  const found = new Set(hub.days.flatMap((entry) => entry.items.map((row) => row.rowId)));
  for (const made of [...named, sibling, before]) assert.ok(found.has(String(made.id)), `${made.publicId} is a congress item`);
  assert.equal(found.size, named.length + 2, "nothing else: not a chest pain, an edema, a day outside the window");
  assert.equal(hub.itemCount, named.length + 2);
  assert.deepEqual(hub.days.map((entry) => entry.day), ["2026-10-25", "2026-10-24", "2026-10-23", "2026-10-20"], "newest day first");
  const list = (await instance.congresses()).find((congress) => congress.id === "esmo-2026");
  assert.equal(list?.itemCount, named.length + 2);
  assert.equal(await instance.congress("no-such-congress"), null);
});

test("an item with no publication moment is dated by when it became visible, and the window is cut by instants before days are read", options, async () => {
  const undated = await item({ text: "u1", publishedAt: "2026-10-24T04:00:00Z", title: "Late-breaking result at ESMO 2026" });
  await database.query("UPDATE evimed_frontier.items SET published_at = NULL WHERE id = $1", [undated.id]);
  const hub = await track().congress("esmo-2026");
  assert.deepEqual(hub?.days.map((entry) => [entry.day, entry.items.map((row) => row.rowId)]), [["2026-10-24", [String(undated.id)]]]);
  // A day the zone moves across: 23:30 UTC on the 29th is the 30th in Shanghai, still inside ESMO's window (to 30 October); 16:30 UTC
  // on the 30th is already the 31st there, outside.
  const edge = await item({ text: "u2", publishedAt: "2026-10-29T23:30:00Z", title: "ESMO 2026 follow-up" });
  const beyond = await item({ text: "u3", publishedAt: "2026-10-30T16:30:00Z", title: "ESMO 2026 follow-up too late" });
  const found = new Set((await track().congress("esmo-2026"))?.days.flatMap((entry) => entry.items.map((row) => row.rowId)));
  assert.ok(found.has(String(edge.id)));
  assert.ok(!found.has(String(beyond.id)));
});

test("an upcoming congress has no items to count and an empty hub", options, async () => {
  await item({ text: "x", publishedAt: "2026-10-24T04:00:00Z", title: "AHA 2026 abstracts" });
  const hub = await track().congress("aha-2026");
  assert.deepEqual(hub?.days, []);
  assert.equal((await track().congresses()).find((congress) => congress.id === "aha-2026")?.itemCount, 0);
});

test("a day's recap is written from its best items, again only when they change and three hours have passed, and empty is stored", options, async () => {
  const day = "2026-10-24T04:00:00Z";
  const selected = await item({ text: "r1", publishedAt: day, title: "ESMO 2026: drug A beats chemotherapy", selected: true, summaryZh: "药物 A 对比化疗显著延长生存，随机对照试验。" });
  await item({ text: "r2", publishedAt: day, title: "ESMO 2026: drug B early data", summaryZh: "药物 B 的早期数据来自少量患者，非随机。" });
  const prompts = /** @type {string[]} */ ([]);
  const editor = { available: true, model: "deepseek-flash", writeJson: async (/** @type {string} */ _instructions, /** @type {string} */ input, /** @type {number} */ _max, /** @type {any} */ { verify }) => {
    prompts.push(input);
    const answer = { recap_zh: "药物 A 在随机对照试验中对比化疗显著延长了患者的生存期，是这一天公布的重要结果之一[1]。药物 B 的早期数据来自少量患者，属非随机研究，结论还需要更大样本验证[2]。两项结果均为会议报告的初步内容，尚需等待完整发表和同行评议，才能判断对临床实践的影响[1][2]。" };
    const checked = verify(answer);
    return checked.issues.length ? { verification: "dropped", output: null, issues: checked.issues } : { verification: "passed", output: checked.output };
  } };
  const instance = track();
  assert.equal(await instance.recapRound(round({ editor })), 1);
  assert.match(prompts[0], /\[1\] .*ESMO 2026: drug A beats chemotherapy/s);
  assert.ok(prompts[0].indexOf("drug A") < prompts[0].indexOf("drug B"), "the selected item is [1]");
  const stored = (await database.query("SELECT day::text AS day, recap_zh, refs, item_ids, model FROM evimed_frontier.congress_recaps WHERE congress_id = 'esmo-2026'")).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].day, "2026-10-24");
  assert.equal(stored[0].refs.length, 2);
  assert.equal(stored[0].refs[0].itemId, selected.publicId);
  assert.equal(stored[0].model, "deepseek-flash");
  // Nothing changed: not asked again.
  assert.equal(await instance.recapRound(round({ editor })), 0);
  assert.equal(prompts.length, 1);
  // A new item for a day already past is written at once (a closed day is final but its late items still count)...
  await item({ text: "r3", publishedAt: day, title: "ESMO 2026: drug C", summaryZh: "药物 C 的结果。" });
  assert.equal(await instance.recapRound(round({ editor })), 1);
  assert.equal(prompts.length, 2);
  // ...but today's recap is not rewritten within three hours of its last writing.
  const today = "2026-10-25T01:00:00Z";
  await item({ text: "r4", publishedAt: today, title: "ESMO 2026: drug D", summaryZh: "药物 D 的结果。" });
  await item({ text: "r5", publishedAt: today, title: "ESMO 2026: drug E", summaryZh: "药物 E 的结果。" });
  assert.equal(await instance.recapRound(round({ editor })), 1);
  await item({ text: "r6", publishedAt: today, title: "ESMO 2026: drug F", summaryZh: "药物 F 的结果。" });
  const asked = prompts.length;
  assert.equal(await instance.recapRound(round({ editor })), 0);
  assert.equal(prompts.length, asked);
  assert.equal(await instance.recapRound(round({ editor, now: new Date(NOW.getTime() + FRONTIER_RECAP_LIMITS.refreshMs + 60_000) })), 1);
  // The model's own "nothing to say" is stored, with the items it saw, so it is not asked again.
  await database.query("DELETE FROM evimed_frontier.congress_recaps");
  const empty = { available: true, model: "m", writeJson: async () => ({ verification: "passed", output: { recap_zh: null } }) };
  await instance.recapRound(round({ editor: empty }));
  const rows = (await database.query("SELECT recap_zh, item_ids FROM evimed_frontier.congress_recaps")).rows;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.recap_zh === null && row.item_ids.length >= 2));
  assert.equal(await instance.recapRound(round({ editor: empty })), 0);
});

test("a recap needs two items, and a failed call or an exhausted budget writes nothing", options, async () => {
  await item({ text: "only", publishedAt: "2026-10-24T04:00:00Z", title: "ESMO 2026: one item only", summaryZh: "只有一条。" });
  let asked = 0;
  const editor = { available: true, model: "m", writeJson: async () => { asked += 1; return { verification: "pending", output: null, error: "model_gateway_timeout" }; } };
  const instance = track();
  assert.equal(await instance.recapRound(round({ editor })), 0);
  assert.equal(asked, 0, "one item is no recap");
  await item({ text: "second", publishedAt: "2026-10-24T04:00:00Z", title: "ESMO 2026: a second item", summaryZh: "第二条。" });
  const refused = round({ editor });
  assert.equal(await instance.recapRound(refused), 0);
  assert.equal(asked, 1);
  assert.deepEqual(refused.calls, ["model_gateway_timeout"]);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.congress_recaps")).rows[0].n, 0);
  assert.equal(await instance.recapRound(round({ editor, budget: { state: "exhausted" } })), 0);
  assert.equal(asked, 1);
});

/** @param {Record<string, any>} [overrides] */
function serviceFor(overrides = {}) {
  const config = { frontierEnabled: true, frontierAudience: "all", operatorUsers: [], frontierPreviewUsers: [], frontierDailyBudgetCny: 10, frontierTimeZone: "Asia/Shanghai" };
  return new FrontierService({ database, vocabulary, now: () => NOW, config, ...overrides });
}

test("the service serves the approvals with the feed's cards, the reader's own hidden ones left out, and the filters checked", options, async () => {
  const shown = await item({ track: approvalRecord(), text: "s1", title: "FDA approval: Hibsago", publishedAt: "2026-10-24T04:00:00Z" });
  const hidden = await item({ track: approvalRecord({ drug: { text: "Hidden drug", quote: "Hidden drug" } }), text: "s2", publishedAt: "2026-10-23T04:00:00Z" });
  await database.query("INSERT INTO evimed_frontier.user_state (user_id, item_id, hidden_at) VALUES ($1, $2, now())", [reader.id, hidden.id]);
  const service = serviceFor();
  const page = await service.trackApprovals(reader, new URLSearchParams());
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].item.id, shown.publicId);
  assert.equal(page.items[0].drug, "Hibsago");
  assert.equal(page.items[0].approvalLabel, "首次获批");
  assert.deepEqual(page.items[0].agency, { key: "fda", label: "FDA" });
  assert.equal(page.items[0].indication, "慢性乙型肝炎");
  assert.equal(page.agencies[0].regionLabel, "美国");
  assert.equal(page.ytd.total, 2);
  assert.equal(page.listId, null, "no interaction record is kept in this service");
  for (const bad of ["from=2026-13", "agency=Bad Agency", "kind=weird", `cursor=${"x".repeat(300)}`]) {
    await assert.rejects(service.trackApprovals(reader, new URLSearchParams(bad)), (error) => /** @type {any} */ (error).status === 400, bad);
  }
});

test("the service serves the guidelines with their key recommendations, and a specialty it does not know is refused", options, async () => {
  const made = await item({ genre: "guideline", track: guidelineRecord(), text: "gs", title: "ACP guidance", specialties: ["oncology"], publishedAt: "2026-10-24T04:00:00Z" });
  const service = serviceFor();
  const page = await service.trackGuidelines(reader, new URLSearchParams());
  assert.equal(page.items[0].item.id, made.publicId);
  assert.equal(page.items[0].body, "美国内科医师学会");
  assert.deepEqual(page.items[0].recommendations, [{ text: "使用雌激素", grade: "strong" }]);
  assert.equal(page.specialties[0].key, "oncology");
  assert.ok(page.specialties[0].label);
  assert.equal((await service.trackGuidelines(reader, new URLSearchParams("specialty=cardiology"))).items.length, 0);
  await assert.rejects(service.trackGuidelines(reader, new URLSearchParams("specialty=astrology")), (error) => /** @type {any} */ (error).status === 400);
});

test("the service serves a congress's hub: its days newest first with the recap's references resolved and a conference result's design caveat", options, async () => {
  const brief = { genre: "conference", points: [{ key: "design", label: "设计", text: "随机、双盲，300 例" }, { key: "limits", label: "局限", text: "期中分析，总生存尚不成熟" }] };
  const result = await item({ text: "h1", publishedAt: "2026-10-24T04:00:00Z", title: "ESMO 2026: drug A phase 3", selected: true, genre: "conference" });
  await database.query("UPDATE evimed_frontier.items SET brief = $2::jsonb WHERE id = $1", [result.id, JSON.stringify(brief)]);
  const second = await item({ text: "h2", publishedAt: "2026-10-24T05:00:00Z", title: "ESMO 2026: drug B", genre: "conference" });
  await database.query(`INSERT INTO evimed_frontier.congress_recaps (congress_id, day, recap_zh, refs, item_ids, generated_at)
    VALUES ('esmo-2026', '2026-10-24', '药物 A 的三期结果公布[1]，药物 B 的数据同日发布[2]，另有一条已下线的报道[3]。', $1::jsonb, $2::bigint[], now())`,
  [JSON.stringify([{ n: 1, itemId: result.publicId }, { n: 2, itemId: second.publicId }, { n: 3, itemId: "gone0000000000000" }]), [result.id, second.id]]);
  await database.query(`INSERT INTO evimed_frontier.congress_recaps (congress_id, day, recap_zh, refs, item_ids, generated_at) VALUES ('esmo-2026', '2026-10-23', NULL, '[]'::jsonb, '{}', now())`);
  const service = serviceFor();
  const hub = await service.trackCongress(reader, "esmo-2026");
  assert.equal(hub.congress.code, "ESMO 2026");
  assert.equal(hub.congress.status, "ongoing");
  assert.equal(hub.congress.specialtyLabel, vocabulary.specialties.oncology);
  assert.equal(hub.itemCount, 2);
  assert.deepEqual(hub.days.map((entry) => entry.day), ["2026-10-24"], "a day with no recap and no item is not a section");
  const day = hub.days[0];
  assert.equal(day.items[0].item.id, result.publicId, "the selected one first");
  assert.equal(day.items[0].caveat, "随机、双盲，300 例；期中分析，总生存尚不成熟");
  assert.equal(day.items[1].caveat, null);
  assert.deepEqual(day.recap?.refs.map((ref) => ref.n), [1, 2], "a reference to an item that is gone is not offered");
  assert.equal(day.recap?.refs[0].itemId, result.publicId);
  await assert.rejects(service.trackCongress(reader, "nope"), (error) => /** @type {any} */ (error).status === 404 && /** @type {any} */ (error).code === "frontier_congress_not_found");
  await assert.rejects(service.trackCongress(reader, "Bad Id!"), (error) => /** @type {any} */ (error).status === 404);
  const list = await service.trackCongresses();
  assert.equal(list.congresses.find((congress) => congress.id === "esmo-2026")?.itemCount, 2);
  assert.deepEqual(list.congresses.filter((congress) => congress.status === "ongoing").map((congress) => congress.id).sort(), ["asn-kidney-week-2026", "esmo-2026"]);
});
