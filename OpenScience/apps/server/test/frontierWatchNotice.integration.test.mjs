// The daily notice and the typed follows (c3-watch, W4): one line per typed follow that matched something new since the reader
// last looked, an item named once, nothing added on a day with nothing new, and a notice that fails gives its matches back.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierDaily, frontierDailyNotice } from "../src/frontierDaily.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { FrontierFollowWatch } from "../src/frontierFollowMatches.mjs";
import { followNoticeLine, followNoticeLines, FRONTIER_FOLLOW_NOTICE_LINES } from "../src/frontierFollowQuery.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { createTypedFollow } from "./helpers/typedFollows.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
/** 08:30 in Beijing on 2026-10-26: the reader's digest time (08:00) has passed. */
const MORNING = new Date("2026-10-26T00:30:00.000Z");
const at = (/** @type {number} */ minutes, /** @type {Date} */ from = MORNING) => new Date(from.getTime() + minutes * 60_000).toISOString();
const glossary = new FrontierGlossary([{ kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽" }, { kind: "disease", termEn: "pancreatitis", termZh: "胰腺炎" }]);

let db, isolated, service, watch, clock, notifications, answer, failCreate;
const editor = { available: true, async callJson() { return answer; } };

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "watchnotice");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await migrateProductStore(db);
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development'),('bob','Bob','development')");
  notifications = new NotificationService(db);
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.items, evimed_frontier.user_follows, evimed_frontier.user_prefs, evimed_frontier.follow_matches, evimed_frontier.dailies CASCADE");
  await db.query("DELETE FROM evimed_frontier.sources");
  await db.query("DELETE FROM evimed_inbox.notifications").catch(() => {});
  await db.query("DELETE FROM evimed_inbox.preferences").catch(() => {});
  await insertSource(db, "nejm");
  clock = new Date(MORNING.getTime() - 20 * 3_600_000);
  failCreate = false;
  answer = { kind: "drug", concepts: [{ type: "drug", zh: ["司美格鲁肽"], en: ["semaglutide"] }] };
  watch = new FrontierFollowWatch({ database: db, editor, glossary: { current: async () => glossary }, now: () => clock, dimension: 1024 });
  service = new FrontierService({ database: db, vocabulary: frontierVocabularyView(TEST_VOCABULARY), config: { frontierEnabled: true, frontierAudience: "all" },
    profiles: null, watch, now: () => clock });
  await db.query("INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ('alice', $1)", [at(-60 * 24)]);
});

/** A published item, visible `minutes` from the clock's start of the test. */
async function publish(visible, title, keys = []) {
  const item = await insertItem(db, { title, summaryZh: "导读", visibleAt: visible, timelineAt: visible, publishedAt: visible });
  if (keys.length) await db.query("UPDATE evimed_frontier.items SET entity_keys = $2 WHERE id = $1", [item.id, keys]);
  return item;
}
const daily = () => new FrontierDaily({ database: db, jobs: null, watch, notifications: {
  async create(userId, notice, opts) {
    if (failCreate) throw Object.assign(new Error("inbox"), { code: "inbox_down" });
    return notifications.create(userId, notice, opts);
  },
}, config: { frontierDailyTime: "07:30", frontierTimeZone: "Asia/Shanghai", frontierAudience: "all" }, now: () => MORNING });

async function issue(day = "2026-10-26") {
  await db.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety, markdown, item_ids, model)
    VALUES ($1::date, $2, $3, '{"title":"头条论文","itemId":"x"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '#', '{}', 'test')`,
  [day, at(-60 * 24), MORNING.toISOString()]);
}
const told = async () => (await db.query("SELECT title, body FROM evimed_inbox.notifications WHERE user_id = 'alice' ORDER BY created_at DESC")).rows;
async function follow(label, concept) {
  answer = { kind: "drug", concepts: [concept] };
  return (await createTypedFollow({ db, watch, service, now: () => clock }, alice, label)).follow;
}
const drug = (/** @type {string} */ zh, /** @type {string} */ en) => ({ type: "drug", zh: [zh], en: [en] });

test("the lines: one per follow with news, the busiest first, three at most and one for the rest, nothing for a follow without news", () => {
  assert.equal(followNoticeLine("GLP-1 和胰腺炎", 3), "你关注的“GLP-1 和胰腺炎”有 3 条新动态");
  assert.deepEqual(followNoticeLines([]), []);
  assert.deepEqual(followNoticeLines([{ label: "甲", count: 0 }]), []);
  assert.deepEqual(followNoticeLines([{ label: "甲", count: 1 }, { label: "乙", count: 4 }]), ["你关注的“乙”有 4 条新动态", "你关注的“甲”有 1 条新动态"]);
  const five = ["甲", "乙", "丙", "丁", "戊"].map((label, index) => ({ label, count: index + 1 }));
  const lines = followNoticeLines(five);
  assert.equal(lines.length, FRONTIER_FOLLOW_NOTICE_LINES + 1);
  assert.equal(lines.at(-1), "另有 2 个关注有新动态");
  const notice = frontierDailyNotice({ day: "2026-10-26", lead: { title: "头条" }, sections: [], safety: [], follows: ["你关注的“甲”有 2 条新动态"] });
  assert.equal(notice.body, "头条\n你关注的“甲”有 2 条新动态");
  assert.equal(frontierDailyNotice({ day: "2026-10-26", lead: { title: "头条" }, sections: [], safety: [] }).body, "头条", "no follows, no change");
});

test("the notice names each typed follow with news once, and the next day's names only what came after", options, async () => {
  const semaglutide = await follow("司美格鲁肽", drug("司美格鲁肽", "semaglutide"));
  const quiet = await follow("胰腺炎", { type: "disease", zh: ["胰腺炎"], en: ["pancreatitis"] });
  for (let index = 0; index < 3; index += 1) await publish(at(-300 + index), `Semaglutide report ${index}`, ["drug:semaglutide"]);
  clock = new Date(at(-120));
  await watch.sweep();
  await issue();
  assert.deepEqual(await daily().pushDue(), { pushed: 1 });
  const [first] = await told();
  assert.equal(first.title, "今日前沿 · 10月26日 · 1 条精选");
  assert.equal(first.body, "头条论文\n你关注的“司美格鲁肽”有 3 条新动态", "the follow with nothing new adds no line");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches WHERE notified_at IS NOT NULL")).rows[0].n, 3);
  assert.ok(semaglutide.id && quiet.id);

  // The next day: one new item, and the three told before are not told again.
  await publish(at(60), "Semaglutide report 4", ["drug:semaglutide"]);
  clock = new Date(at(120));
  await watch.sweep();
  const tomorrow = new Date(MORNING.getTime() + 24 * 3_600_000);
  await issue("2026-10-27");
  await db.query("UPDATE evimed_frontier.user_prefs SET last_seen_at = $1 WHERE user_id = 'alice'", [tomorrow.toISOString()]);
  const nextDay = new FrontierDaily({ database: db, jobs: null, watch, notifications, config: { frontierDailyTime: "07:30", frontierTimeZone: "Asia/Shanghai", frontierAudience: "all" }, now: () => tomorrow });
  assert.deepEqual(await nextDay.pushDue(), { pushed: 1 });
  const rows = await told();
  assert.equal(rows[0].body, "头条论文\n你关注的“司美格鲁肽”有 1 条新动态");
  assert.equal(rows.length, 2);
});

test("a day with nothing new is the notice it was: the same words, no line, nothing claimed", options, async () => {
  await follow("司美格鲁肽", drug("司美格鲁肽", "semaglutide"));
  await publish(at(-60 * 24 * 2), "Semaglutide, long ago", ["drug:semaglutide"]);
  clock = new Date(at(-120));
  await watch.sweep();
  await issue();
  assert.deepEqual(await daily().pushDue(), { pushed: 1 });
  const [row] = await told();
  assert.equal(row.body, "头条论文");
  const plain = frontierDailyNotice({ day: "2026-10-26", lead: { title: "头条论文" }, sections: [], safety: [] });
  assert.deepEqual(row, { title: plain.title, body: plain.body });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches WHERE notified_at IS NOT NULL")).rows[0].n, 0);
});

test("an item the reader already looked at, hid, or that is older than three days is not told", options, async () => {
  const feed = await follow("司美格鲁肽", drug("司美格鲁肽", "semaglutide"));
  const hidden = await publish(at(-300), "Semaglutide hidden", ["drug:semaglutide"]);
  await publish(at(-290), "Semaglutide before they looked", ["drug:semaglutide"]);
  await publish(at(-280), "Semaglutide shown", ["drug:semaglutide"]);
  clock = new Date(at(-250));
  await watch.sweep();
  await service.setItemState(alice, hidden.publicId, "hide");
  await db.query("UPDATE evimed_frontier.user_follows SET seen_at = $2 WHERE id = $1", [feed.id, at(-285)]);
  clock = new Date(at(-120));
  await issue();
  assert.deepEqual(await daily().pushDue(), { pushed: 1 });
  assert.equal((await told())[0].body, "头条论文\n你关注的“司美格鲁肽”有 1 条新动态", "only the one published after they last opened the follow, and not hidden");
  // An old match is never told.
  await db.query("UPDATE evimed_frontier.follow_matches SET notified_at = NULL");
  await db.query("UPDATE evimed_frontier.items SET visible_at = $1, timeline_at = $1", [at(-60 * 24 * 5)]);
  await db.query("UPDATE evimed_frontier.user_follows SET seen_at = NULL, created_at = $1", [at(-60 * 24 * 9)]);
  await db.query("UPDATE evimed_frontier.user_prefs SET last_push_day = NULL");
  await db.query("DELETE FROM evimed_inbox.notifications");
  assert.deepEqual(await daily().pushDue(), { pushed: 1 });
  assert.equal((await told())[0].body, "头条论文");
});

test("a notice that cannot be made gives its matches back, and the next try tells them", options, async () => {
  await follow("司美格鲁肽", drug("司美格鲁肽", "semaglutide"));
  await publish(at(-300), "Semaglutide report", ["drug:semaglutide"]);
  clock = new Date(at(-120));
  await watch.sweep();
  await issue();
  failCreate = true;
  assert.deepEqual(await daily().pushDue(), { pushed: 0 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches WHERE notified_at IS NOT NULL")).rows[0].n, 0, "not used up");
  assert.equal((await told()).length, 0);
  failCreate = false;
  assert.deepEqual(await daily().pushDue(), { pushed: 1 });
  assert.equal((await told())[0].body, "头条论文\n你关注的“司美格鲁肽”有 1 条新动态");
});

test("c3 review: a notice that was made keeps its matches told even when recording the push day fails after it", options, async () => {
  await follow("司美格鲁肽", drug("司美格鲁肽", "semaglutide"));
  await publish(at(-300), "Semaglutide report", ["drug:semaglutide"]);
  clock = new Date(at(-120));
  await watch.sweep();
  await issue();
  // The database refuses the push day's record once, after the inbox took the notice.
  const failing = new Proxy(db, { get(target, name) {
    if (name !== "query") return Reflect.get(target, name);
    return async (/** @type {string} */ sql, /** @type {unknown[]} */ values) => {
      if (/last_push_day/.test(sql) && /INSERT/.test(sql)) throw Object.assign(new Error("lost"), { code: "57P01" });
      return target.query(sql, values);
    };
  } });
  const push = new FrontierDaily({ database: failing, jobs: null, watch, notifications, config: { frontierDailyTime: "07:30", frontierTimeZone: "Asia/Shanghai", frontierAudience: "all" }, now: () => MORNING });
  assert.deepEqual(await push.pushDue(), { pushed: 0 });
  assert.equal((await told()).length, 1, "the notice went out");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches WHERE notified_at IS NOT NULL")).rows[0].n, 1, "its items stay told");
});

test("a reader who turned the frontier notice off is told nothing and nothing is claimed", options, async () => {
  await follow("司美格鲁肽", drug("司美格鲁肽", "semaglutide"));
  await publish(at(-300), "Semaglutide report", ["drug:semaglutide"]);
  clock = new Date(at(-120));
  await watch.sweep();
  await issue();
  await notifications.preferences("alice");
  await db.query("UPDATE evimed_inbox.preferences SET switches = '{\"frontier\": false, \"notify\": true}'::jsonb WHERE user_id = 'alice'");
  assert.deepEqual(await daily().pushDue(), { pushed: 0 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches WHERE notified_at IS NOT NULL")).rows[0].n, 0);
});

test("a day with no issue sends nothing, with or without follows", options, async () => {
  await follow("司美格鲁肽", drug("司美格鲁肽", "semaglutide"));
  await publish(at(-300), "Semaglutide report", ["drug:semaglutide"]);
  clock = new Date(at(-120));
  await watch.sweep();
  assert.deepEqual(await daily().pushDue(), { pushed: 0 });
  assert.equal((await told()).length, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches WHERE notified_at IS NOT NULL")).rows[0].n, 0);
});

test("many follows with news: three lines and one for the rest", options, async () => {
  for (const [index, name] of ["alpha", "beta", "gamma", "delta", "epsilon"].entries()) {
    await follow(`${name} study`, { type: "topic", zh: [], en: [`${name} study`] });
    for (let n = 0; n <= index; n += 1) await publish(at(-300 + n * 3 + index), `The ${name} study reports ${n}`);
  }
  clock = new Date(at(-120));
  await watch.sweep();
  await issue();
  const pusher = daily();
  const result = await pusher.pushDue();
  assert.deepEqual(result, { pushed: 1 }, JSON.stringify(pusher.status()));
  assert.equal((await told())[0].body, ["头条论文", "你关注的“epsilon study”有 5 条新动态", "你关注的“delta study”有 4 条新动态", "你关注的“gamma study”有 3 条新动态",
    "另有 2 个关注有新动态"].join("\n"));
});
