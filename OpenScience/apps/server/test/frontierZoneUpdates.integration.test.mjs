// Zones in the daily notice and in the 日报 and 周刊 (plan 2026-10-29 §4.5, §4.6), against a real PostgreSQL: the key updates of the
// zones a reader owns or follows are one line each in the daily notice (two items a zone, three zones, one line for the rest), named
// to the reader once however many zones and sources carry them, given back when the notice cannot be made, never read from a zone the
// reader may not see; the issue's section reads the same selection without claiming; the week groups it by the fixed categories.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierDaily, frontierDailyNotice } from "../src/frontierDaily.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { FrontierWeekly } from "../src/frontierWeekly.mjs";
import {
  ZONE_NOTICE, ZONE_WEEK_CATEGORIES, claimZoneNotice, followedZoneUpdates, releaseZoneNotice, shapeZoneUpdates, zoneNoticeLines, zoneWeekCategory,
} from "../src/frontierZoneUpdates.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** 08:30 in Beijing on 2026-10-29: past the reader's digest time (08:00). */
const NOW = new Date("2026-10-29T00:30:00.000Z");
const hoursAgo = (/** @type {number} */ hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const config = { frontierDailyTime: "07:30", frontierTimeZone: "Asia/Shanghai", frontierAudience: "all", frontierEnabled: true };

/** @type {any} */ let isolated;
/** @type {any} */ let db;
/** @type {any} */ let notifications;
let failCreate = false;
/** @type {Record<string, { id: string, publicId: string }>} */
const items = {};

/** @param {Record<string, any>} zone */
async function addZone({ id, title, owner = "pub", kind = "official", state = "published", lifecycle = "active", slug = null, createdAt = hoursAgo(24 * 30) }) {
  await db.query(`INSERT INTO evimed_frontier.evidence_zones (id, user_id, title, state, kind, slug, zone_type, scope_zh, definition, definition_version, lifecycle, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,'drug-indication','范围','{"version":1}'::jsonb,1,$7,$8)`, [id, owner, title, state, kind, slug, lifecycle, createdAt]);
}

/**
 * A published item with the columns the rule reads, in zones with a relevance.
 * @param {string} name @param {{ zones?: Array<string | [string, string]>, hours?: number, patch?: Record<string, any>, role?: string, event?: string | null }} [spec]
 */
async function addItem(name, { zones = [], hours = 3, patch = {}, role = "guideline", event = null } = {}) {
  const found = await insertItem(db, { title: name, titleZh: `${name}（中文）`, summaryZh: "导读", visibleAt: hoursAgo(hours), timelineAt: hoursAgo(hours), publishedAt: hoursAgo(hours) });
  const columns = { genre: "guideline", practice_changing: false, ...patch };
  await db.query("UPDATE evimed_frontier.items SET genre = $2, practice_changing = $3, event_id = $4 WHERE id = $1",
    [found.id, columns.genre, columns.practice_changing, event]);
  items[name] = found;
  for (const entry of zones) {
    const [zone, relevance] = Array.isArray(entry) ? entry : [entry, "core"];
    await db.query(`INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, relevance, via, role, definition_version) VALUES ($1,$2,$3,$4,'tag',$5,1)`,
      [zone, found.id, relevance === "pinned" ? "pinned" : "in", relevance === "pinned" ? null : relevance, role]);
  }
  return found;
}
const follow = (/** @type {string} */ user, /** @type {string} */ zone, createdAt = hoursAgo(24 * 20)) =>
  db.query("INSERT INTO evimed_frontier.evidence_zone_follows (user_id, zone_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [user, zone, createdAt]);
const claims = async (/** @type {string} */ user) => (await db.query("SELECT item_id::text AS id FROM evimed_frontier.zone_notice_claims WHERE user_id = $1 ORDER BY item_id", [user])).rows.map((row) => row.id);
const titles = (/** @type {any} */ told) => told.zones.map((/** @type {any} */ zone) => [zone.zoneTitle, zone.items.map((/** @type {any} */ item) => item.title)]);

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "zonenotice");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await migrateProductStore(db);
  await migrateNotifications(db);
  const real = new NotificationService(db);
  notifications = { create: async (/** @type {string} */ user, /** @type {any} */ notice, /** @type {any} */ opts) => {
    if (failCreate) throw Object.assign(new Error("inbox"), { code: "inbox_down" });
    return real.create(user, notice, opts);
  }, preferences: (/** @type {string} */ user) => real.preferences(user) };
  await db.query(`INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('pub','EviMed','development'),('alice','Alice','development'),('bob','Bob','development'),
    ('carol','Carol','development'),('dave','Dave','development'),('erin','Erin','development')`);
  await insertSource(db, "nejm");
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.items, evimed_frontier.evidence_zones, evimed_frontier.user_prefs, evimed_frontier.dailies CASCADE");
  await db.query("DELETE FROM evimed_inbox.notifications").catch(() => {});
  for (const key of Object.keys(items)) delete items[key];
  failCreate = false;
});

// ───────────────────────── pure parts ─────────────────────────

test("a week category is the pair's role, a registry trial being 试验进展", () => {
  assert.deepEqual(ZONE_WEEK_CATEGORIES.map((category) => category.label), ["新证据", "指南与共识", "监管批准", "试验进展", "政策与支付", "行业动态"]);
  assert.equal(zoneWeekCategory({ role: "research", genre: "paper" }), "evidence");
  assert.equal(zoneWeekCategory({ role: "research", genre: "trial" }), "trial");
  assert.equal(zoneWeekCategory({ role: "guideline", genre: "guideline" }), "guideline");
  assert.equal(zoneWeekCategory({ role: "approval", genre: "approval" }), "regulatory");
  assert.equal(zoneWeekCategory({ role: "safety", genre: "safety" }), "regulatory");
  assert.equal(zoneWeekCategory({ role: "policy", genre: "policy" }), "policy");
  assert.equal(zoneWeekCategory({ role: "industry", genre: "industry" }), "industry");
  assert.equal(zoneWeekCategory({ role: "news", genre: "news" }), "evidence", "a news item that is a key update at all is about evidence");
  assert.equal(zoneWeekCategory({ role: "conference", genre: "conference" }), "evidence");
});

test("choosing among the updates: one item per event, a zone's share, the zones' number, the rest counted", () => {
  const row = (/** @type {string} */ zone, /** @type {string} */ id, /** @type {number} */ hours, event = id) => ({ zone_id: zone, slug: null, zone_title: `专区${zone}`, row_id: id, public_id: `p${id}`, title: `标题${id}`,
    visible_at: hoursAgo(hours), event_key: event, role: "guideline", genre: "guideline" });
  const rows = [row("a", "1", 1), row("b", "2", 2, "e"), row("a", "3", 3, "e"), row("a", "4", 4), row("a", "5", 5), row("c", "6", 6), row("d", "7", 7), row("e", "8", 8)];
  const told = shapeZoneUpdates(rows, { perZone: 2, zones: 3 });
  assert.deepEqual(titles(told), [["专区a", ["标题1", "标题4"]], ["专区b", ["标题2"]], ["专区c", ["标题6"]]], "item 3 is event e, which zone b (newer) named first; two a share");
  assert.equal(told.more, 2, "d and e had an update and are not named");
  assert.deepEqual(zoneNoticeLines(told), ["你关注的“专区a”：标题1；标题4", "你关注的“专区b”：标题2", "你关注的“专区c”：标题6", "另有 2 个专区有更新"]);
  assert.deepEqual(zoneNoticeLines({ zones: [], more: 0 }), []);
  const long = shapeZoneUpdates([row("a", "9", 1)].map((entry) => ({ ...entry, title: "长".repeat(100) })), { perZone: 2, zones: 3 });
  assert.equal(zoneNoticeLines(long)[0], `你关注的“专区a”：${"长".repeat(ZONE_NOTICE.titleChars)}…`);
  assert.equal(frontierDailyNotice({ day: "2026-10-29", lead: { title: "头条" }, sections: [], safety: ["x"], zones: ["你关注的“甲”：乙"] }).body, "头条\n安全警示 1 条\n你关注的“甲”：乙");
  assert.equal(frontierDailyNotice({ day: "2026-10-29", lead: { title: "头条" }, sections: [], safety: [] }).body, "头条", "no zones, no change");
});

// ───────────────────────── the claim ─────────────────────────

test("a notice names the key updates of the zones a reader follows or owns: two items a zone, three zones, a line for the rest, each item once", options, async () => {
  for (const [id, title] of [["z1", "GLP-1 减重"], ["z2", "SGLT2 心肾"], ["z3", "ADC 乳腺癌"], ["z4", "CAR-T 自身免疫"]]) await addZone({ id, title });
  await addZone({ id: "zmine", title: "我的房颤", owner: "bob", kind: "user", state: "draft", lifecycle: "active" });
  for (const zone of ["z1", "z2", "z3", "z4"]) await follow("bob", zone);
  // z1: three key updates (the third older), one ordinary paper that is not a key update; z2..z4: one each; the reader's own zone: one.
  await addItem("g1 新版指南", { zones: ["z1"], hours: 2 });
  await addItem("g2 获批新适应症", { zones: ["z1"], hours: 5, patch: { genre: "approval" }, role: "approval" });
  await addItem("g3 更早的指南", { zones: ["z1"], hours: 30 });
  await addItem("g4 普通研究", { zones: ["z1"], hours: 1, patch: { genre: "paper" }, role: "research" });
  await addItem("s1 改变实践的研究", { zones: ["z2"], hours: 4, patch: { genre: "paper", practice_changing: true }, role: "research" });
  await addItem("a1 指南", { zones: ["z3"], hours: 6 });
  await addItem("c1 指南", { zones: ["z4"], hours: 7 });
  await addItem("m1 我的专区更新", { zones: ["zmine"], hours: 8 });
  const told = await claimZoneNotice(db, "bob", NOW);
  assert.deepEqual(titles(told), [
    ["GLP-1 减重", ["g1 新版指南（中文）", "g2 获批新适应症（中文）"]], ["SGLT2 心肾", ["s1 改变实践的研究（中文）"]], ["ADC 乳腺癌", ["a1 指南（中文）"]],
  ]);
  assert.equal(told.more, 2, "z4 and the reader's own zone are the rest");
  assert.equal(told.claimed.length, 4);
  assert.deepEqual(await claims("bob"), told.claimed.sort((left, right) => Number(left) - Number(right)));
  assert.deepEqual(zoneNoticeLines(told).at(-1), "另有 2 个专区有更新");
  // The next notice names what was not named and nothing that was.
  const next = await claimZoneNotice(db, "bob", NOW);
  assert.deepEqual(titles(next).sort(), [["CAR-T 自身免疫", ["c1 指南（中文）"]], ["GLP-1 减重", ["g3 更早的指南（中文）"]], ["我的房颤", ["m1 我的专区更新（中文）"]]].sort(),
    "the rest come next, the older one with them");
  assert.equal(next.more, 0);
  assert.deepEqual((await claimZoneNotice(db, "bob", NOW)).zones, [], "nothing is named twice");
  assert.deepEqual((await claimZoneNotice(db, "dave", NOW)).zones, [], "a reader of no zone is told nothing");
});

test("an item that is in two zones, or reported by two sources, is named to a reader once", options, async () => {
  await addZone({ id: "z1", title: "GLP-1 减重" });
  await addZone({ id: "z2", title: "SGLT2 心肾" });
  const event = (await db.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at) VALUES ('evt1abcdefgh','一件事','evidence',$1,$1) RETURNING id`, [hoursAgo(5)])).rows[0].id;
  await follow("bob", "z1");
  await follow("bob", "z2");
  await addItem("两个专区共有的指南", { zones: ["z1", "z2"], hours: 2 });
  await addItem("同一件事的另一家报道", { zones: ["z2"], hours: 3, event });
  await addItem("同一件事的第一家报道", { zones: ["z1"], hours: 4, event });
  const told = await claimZoneNotice(db, "bob", NOW);
  const named = told.zones.flatMap((zone) => zone.items.map((item) => item.title));
  assert.equal(named.length, 2, `two things: ${named.join(" / ")}`);
  assert.equal(new Set(named).size, 2);
  assert.equal(named.filter((title) => title.startsWith("同一件事")).length, 1, "one report of the event");
  assert.deepEqual((await claimZoneNotice(db, "bob", NOW)).zones, [], "the other report of the event is the same thing, already told");
});

test("what a reader may not see is never told: a zone its owner took back, an archived one, an item they hid, a follow made after the news", options, async () => {
  await addZone({ id: "pub1", title: "公开专区" });
  await addZone({ id: "private1", title: "卡洛的私人专区", owner: "carol", kind: "user", state: "draft" });
  await addZone({ id: "shared1", title: "卡洛公开的专区", owner: "carol", kind: "user", state: "published" });
  await addZone({ id: "old1", title: "已归档", lifecycle: "archived" });
  await addZone({ id: "card1", title: "没有主题的专区", lifecycle: "none" });
  for (const zone of ["pub1", "private1", "shared1", "old1", "card1"]) await follow("bob", zone);
  await addItem("p 公开", { zones: ["pub1"], hours: 2 });
  await addItem("x 私人", { zones: ["private1"], hours: 2 });
  await addItem("sh 公开的用户专区", { zones: ["shared1"], hours: 2 });
  await addItem("o 归档", { zones: ["old1"], hours: 2 });
  await addItem("c 没有主题", { zones: ["card1"], hours: 2 });
  await addItem("h 被隐藏", { zones: ["pub1"], hours: 3 });
  await addItem("r 只是相关", { zones: [["pub1", "related"]], hours: 3 });
  await addItem("n 太旧", { zones: ["pub1"], hours: 24 * 5 });
  await db.query("INSERT INTO evimed_frontier.user_prefs (user_id) VALUES ('bob') ON CONFLICT DO NOTHING");
  await db.query("INSERT INTO evimed_frontier.user_state (user_id, item_id, hidden_at) VALUES ('bob', $1, clock_timestamp())", [items["h 被隐藏"].id]);
  const told = await claimZoneNotice(db, "bob", NOW);
  assert.deepEqual(titles(told).sort(), [["公开专区", ["p 公开（中文）"]], ["卡洛公开的专区", ["sh 公开的用户专区（中文）"]]].sort(),
    "not the draft zone of another reader, not an archived zone, not a zone with no topic, not a hidden or older or merely related item");
  // Carol, who owns both of hers, is told of the private one and of nothing that is not hers.
  const carols = await claimZoneNotice(db, "carol", NOW);
  assert.deepEqual(carols.zones.map((zone) => zone.zoneTitle).sort(), ["卡洛公开的专区", "卡洛的私人专区"].sort());
  // A follow made after the news has no news in it; a follow before it does.
  await follow("erin", "pub1", hoursAgo(1));
  assert.deepEqual((await claimZoneNotice(db, "erin", NOW)).zones, [], "erin followed an hour ago and the news is older");
  await db.query("UPDATE evimed_frontier.evidence_zone_follows SET created_at = $1 WHERE user_id = 'erin'", [hoursAgo(10)]);
  assert.equal((await claimZoneNotice(db, "erin", NOW)).zones.length, 1);
});

test("a pinned item counts as core, a key update is a retraction or a correction too, and a zone made today is not news", options, async () => {
  await addZone({ id: "z1", title: "GLP-1 减重" });
  await follow("bob", "z1");
  await addItem("pinned 研究", { zones: [["z1", "pinned"]], hours: 3, patch: { genre: "paper", practice_changing: true }, role: "research" });
  const retracted = await addItem("撤稿的论文", { zones: ["z1"], hours: 4, patch: { genre: "paper" }, role: "research" });
  await db.query("UPDATE evimed_frontier.items SET flags = ARRAY['retracted'] WHERE id = $1", [retracted.id]);
  const told = await claimZoneNotice(db, "bob", NOW);
  assert.deepEqual(told.zones[0].items.map((item) => item.title), ["pinned 研究（中文）", "撤稿的论文（中文）"]);
  // A reader's own zone made an hour ago has backfilled items older than itself: they are history, not news.
  await addZone({ id: "mine", title: "刚建的专区", owner: "carol", kind: "user", state: "draft", createdAt: hoursAgo(1) });
  await addItem("m 回填的旧指南", { zones: ["mine"], hours: 20 });
  assert.deepEqual((await claimZoneNotice(db, "carol", NOW)).zones, []);
});

test("a notice that cannot be made gives its items back", options, async () => {
  await addZone({ id: "z1", title: "GLP-1 减重" });
  await follow("bob", "z1");
  await addItem("g1 指南", { zones: ["z1"], hours: 2 });
  const told = await claimZoneNotice(db, "bob", NOW);
  assert.equal((await claims("bob")).length, 1);
  await releaseZoneNotice(db, "bob", told.claimed);
  assert.deepEqual(await claims("bob"), []);
  assert.equal((await claimZoneNotice(db, "bob", NOW)).zones.length, 1, "told again");
  await releaseZoneNotice(db, "bob", []);
  // Another process that took the item first wins: this call names nothing it did not write.
  const rival = await claimZoneNotice(db, "dave", NOW);
  assert.deepEqual(rival.zones, []);
});

// ───────────────────────── the push ─────────────────────────

/** @param {Date} [now] */
const daily = (now = NOW) => new FrontierDaily({ database: db, jobs: null, notifications, config, now: () => now });
async function issue(day = "2026-10-29") {
  await db.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety, markdown, item_ids, model)
    VALUES ($1::date, $2, $3, '{"title":"头条论文","itemId":"x"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '#', '{}', 'test')`, [day, hoursAgo(24), NOW.toISOString()]);
}
const told = async (/** @type {string} */ user) => (await db.query("SELECT title, body FROM evimed_inbox.notifications WHERE user_id = $1 ORDER BY created_at DESC", [user])).rows;
async function reader(/** @type {string} */ user, seen = true) {
  await db.query("INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, last_push_day = NULL",
    [user, seen ? hoursAgo(5) : hoursAgo(24 * 40)]);
}

test("the daily notice carries one line per zone with news and one for the rest, and the same items are not named the next day", options, async () => {
  for (const [id, title] of [["z1", "GLP-1 减重"], ["z2", "SGLT2 心肾"], ["z3", "ADC 乳腺癌"], ["z4", "CAR-T 自身免疫"]]) { await addZone({ id, title }); await follow("bob", id); }
  await addItem("g1 新版指南", { zones: ["z1"], hours: 2 });
  await addItem("s1 指南", { zones: ["z2"], hours: 3 });
  await addItem("a1 指南", { zones: ["z3"], hours: 4 });
  await addItem("c1 指南", { zones: ["z4"], hours: 5 });
  await reader("bob", false);
  await reader("dave");
  await issue();
  const pusher = daily();
  assert.deepEqual(await pusher.pushDue(), { pushed: 2 }, JSON.stringify(pusher.status()));
  assert.equal((await told("bob"))[0].body, ["头条论文", "你关注的“GLP-1 减重”：g1 新版指南（中文）", "你关注的“SGLT2 心肾”：s1 指南（中文）", "你关注的“ADC 乳腺癌”：a1 指南（中文）", "另有 1 个专区有更新"].join("\n"),
    "bob has not opened the page in 40 days but follows zones, so he is a reader of the notice");
  assert.equal((await told("dave"))[0].body, "头条论文", "a reader of no zone gets the notice it was");
  assert.equal(pusher.status().counters.zoneLines, 4);
  // The next day: the three told are not told again; the one left is.
  const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
  await issue("2026-10-30");
  await db.query("UPDATE evimed_frontier.user_prefs SET last_push_day = NULL");
  assert.deepEqual(await daily(tomorrow).pushDue(), { pushed: 2 });
  assert.equal((await told("bob"))[0].body, "头条论文\n你关注的“CAR-T 自身免疫”：c1 指南（中文）");
});

test("a reader who owns a zone is a reader of the notice though they have not opened the page in a long time", options, async () => {
  await addZone({ id: "mine", title: "我的专区", owner: "bob", kind: "user", state: "draft" });
  await addItem("m1 指南", { zones: ["mine"], hours: 2 });
  await reader("bob", false);
  await issue();
  assert.deepEqual(await daily().pushDue(), { pushed: 1 });
  assert.equal((await told("bob"))[0].body, "头条论文\n你关注的“我的专区”：m1 指南（中文）");
});

test("a notice that fails gives its updates back and the next scan tells them", options, async () => {
  await addZone({ id: "z1", title: "GLP-1 减重" });
  await follow("bob", "z1");
  await addItem("g1 指南", { zones: ["z1"], hours: 2 });
  await reader("bob");
  await issue();
  failCreate = true;
  assert.deepEqual(await daily().pushDue(), { pushed: 0 });
  assert.deepEqual(await claims("bob"), [], "not used up");
  assert.equal((await told("bob")).length, 0);
  failCreate = false;
  assert.deepEqual(await daily().pushDue(), { pushed: 1 });
  assert.equal((await told("bob"))[0].body, "头条论文\n你关注的“GLP-1 减重”：g1 指南（中文）");
});

test("a notice that was made keeps its updates told when the push day's record fails after it, and the next scan does not make it again", options, async () => {
  await addZone({ id: "z1", title: "GLP-1 减重" });
  await follow("bob", "z1");
  await addItem("g1 指南", { zones: ["z1"], hours: 2 });
  await reader("bob");
  await issue();
  let refuse = true;
  const failing = new Proxy(db, { get(target, name) {
    if (name !== "query") return Reflect.get(target, name);
    return async (/** @type {string} */ sql, /** @type {unknown[]} */ values) => {
      if (refuse && /last_push_day/.test(sql) && /INSERT/.test(sql)) throw Object.assign(new Error("lost"), { code: "57P01" });
      return target.query(sql, values);
    };
  } });
  const first = new FrontierDaily({ database: failing, jobs: null, notifications, config, now: () => NOW });
  assert.deepEqual(await first.pushDue(), { pushed: 0 });
  assert.equal((await told("bob")).length, 1, "the notice went out");
  assert.equal((await claims("bob")).length, 1, "its updates stay told");
  // A new key update arrives before the retry: the retry would word another body, which the inbox refuses; it must not try.
  await addItem("g2 又一条指南", { zones: ["z1"], hours: 1 });
  refuse = false;
  assert.deepEqual(await daily().pushDue(), { pushed: 1 });
  const rows = await told("bob");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "头条论文\n你关注的“GLP-1 减重”：g1 指南（中文）");
  assert.equal((await db.query("SELECT last_push_day::text AS day FROM evimed_frontier.user_prefs WHERE user_id = 'bob'")).rows[0].day, "2026-10-29");
  assert.equal((await claims("bob")).length, 1, "the newer update is for tomorrow");
});

test("a reader who turned the frontier notice off is told nothing and nothing is claimed", options, async () => {
  await addZone({ id: "z1", title: "GLP-1 减重" });
  await follow("bob", "z1");
  await addItem("g1 指南", { zones: ["z1"], hours: 2 });
  await reader("bob");
  await issue();
  await notifications.preferences("bob");
  await db.query("UPDATE evimed_inbox.preferences SET switches = '{\"frontier\": false, \"notify\": true}'::jsonb WHERE user_id = 'bob'");
  assert.deepEqual(await daily().pushDue(), { pushed: 0 });
  assert.deepEqual(await claims("bob"), []);
});

// ───────────────────────── the issues ─────────────────────────

test("the 日报 lists the reader's zone updates over the issue's window, for that reader only, claiming nothing", options, async () => {
  const day = "2026-10-29";
  const windowStart = hoursAgo(24);
  const windowEnd = NOW.toISOString();
  await addZone({ id: "z1", title: "GLP-1 减重", slug: "glp1-weight" });
  await addZone({ id: "z2", title: "SGLT2 心肾" });
  await addZone({ id: "z3", title: "没人关注的专区" });
  await follow("bob", "z1");
  await follow("bob", "z2");
  await follow("carol", "z1");
  await addItem("g1 新版指南", { zones: ["z1"], hours: 2 });
  await addItem("g2 获批新适应症", { zones: ["z1"], hours: 5, patch: { genre: "approval" }, role: "approval" });
  await addItem("g3 第三条", { zones: ["z1"], hours: 6 });
  await addItem("g4 窗口之前", { zones: ["z1"], hours: 40 });
  await addItem("s1 普通研究", { zones: ["z2"], hours: 2, patch: { genre: "paper" }, role: "research" });
  await addItem("x1 无人关注", { zones: ["z3"], hours: 2 });
  await db.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety, markdown, item_ids, model)
    VALUES ($1::date, $2, $3, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '# 日报', '{}', 'deepseek-flash')`, [day, windowStart, windowEnd]);
  const dailyProducer = new FrontierDaily({ database: db, config });
  const frontier = new FrontierService({ database: db, config, vocabulary: frontierVocabularyView(TEST_VOCABULARY), daily: dailyProducer });
  const bobs = (await frontier.dailyIssue({ id: "bob" }, day)).daily;
  const carols = (await frontier.dailyIssue({ id: "carol" }, day)).daily;
  const daves = (await frontier.dailyIssue({ id: "dave" }, day)).daily;
  assert.deepEqual(bobs.followedZones.map((zone) => [zone.zoneId, zone.slug, zone.zoneTitle, zone.entries.map((entry) => entry.item.titleRaw ?? entry.item.title)]),
    [["z1", "glp1-weight", "GLP-1 减重", ["g1 新版指南", "g2 获批新适应症"]]], "two a zone in the daily, the ordinary paper is not a key update, the old one is outside the window");
  assert.deepEqual(bobs.followedZones[0].entries.map((entry) => [entry.category, entry.categoryLabel]), [["guideline", "指南与共识"], ["regulatory", "监管批准"]]);
  assert.equal(carols.followedZones.length, 1);
  assert.deepEqual(daves.followedZones, []);
  assert.equal(bobs.markdown, daves.markdown, "the issue's text is the same for everyone; the section is the reader's own");
  assert.deepEqual(await claims("bob"), [], "reading an issue tells nothing");
  // A muted entity or a hidden item leaves it out.
  await db.query("INSERT INTO evimed_frontier.user_prefs (user_id) VALUES ('bob') ON CONFLICT DO NOTHING");
  await db.query("INSERT INTO evimed_frontier.user_state (user_id, item_id, hidden_at) VALUES ('bob', $1, clock_timestamp())", [items["g1 新版指南"].id]);
  assert.deepEqual((await frontier.dailyIssue({ id: "bob" }, day)).daily.followedZones[0].entries.length, 2, "g1 is hidden and g3 takes its place");
});

test("the 周刊 lists the week's updates, three a zone, in the order of the week's categories", options, async () => {
  const start = new Date(NOW.getTime() - 7 * 24 * 3_600_000).toISOString();
  await addZone({ id: "z1", title: "GLP-1 减重" });
  await follow("bob", "z1");
  await addItem("e 试验注册", { zones: ["z1"], hours: 30, patch: { genre: "trial", practice_changing: true }, role: "research" });
  await addItem("d 政策", { zones: ["z1"], hours: 50, patch: { genre: "policy", practice_changing: true }, role: "policy" });
  await addItem("b 指南", { zones: ["z1"], hours: 70, patch: { genre: "guideline" }, role: "guideline" });
  await addItem("a 研究", { zones: ["z1"], hours: 90, patch: { genre: "paper", practice_changing: true }, role: "research" });
  const weekly = new FrontierWeekly({ database: db, config });
  const week = await weekly.followedZones("bob", { windowStart: start, windowEnd: NOW.toISOString() });
  assert.deepEqual(week.map((zone) => zone.items.map((item) => [item.title, item.category])), [[["e 试验注册（中文）", "trial"], ["d 政策（中文）", "policy"], ["b 指南（中文）", "guideline"]]
    .sort((left, right) => ZONE_WEEK_CATEGORIES.findIndex((category) => category.key === left[1]) - ZONE_WEEK_CATEGORIES.findIndex((category) => category.key === right[1]))],
  "the newest three, listed by category");
  assert.deepEqual(await weekly.followedZones("dave", { windowStart: start, windowEnd: NOW.toISOString() }), []);
  assert.deepEqual(await followedZoneUpdates(db, { userId: "bob", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", weekly: true }), []);
});
