// The daily and its push against a real PostgreSQL (build spec D.2, D.3): one
// issue per day through the `frontier-daily` job, its window and sections, the
// empty day and the missing one; the push to each reader at their digest time,
// once, only to readers it is for; the notification switch.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierDaily } from "../src/frontierDaily.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FRONTIER_PROJECT_ID } from "../src/internalProjects.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { insertSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem, metaValue, resetFrontier } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = randomUUID().slice(0, 8);
const users = Object.fromEntries(["operator", "reader", "follower", "stale", "off", "late", "pushed", "preview"].map((role) => [role, `${role}_${suffix}`]));
const DAY = "2026-09-22";
/** 07:31 in Beijing on the issue's day. */
const FINALIZED = new Date("2026-09-21T23:31:00Z");
let database;
let jobs;
let notifications;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateProductStore(database);
  for (const id of Object.values(users)) await database.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $1, 'development')", [id]);
  await database.query("INSERT INTO evimed_control.projects(user_id, id, name, quota_bytes) VALUES ($1, $2, 'EviMed 前沿动态', 1000000)", [users.operator, FRONTIER_PROJECT_ID]);
  jobs = new ProductJobs(database);
  notifications = new NotificationService(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [Object.values(users)]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await resetFrontier(database);
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id = $1", [users.operator]);
  await database.query("DELETE FROM evimed_inbox.notifications WHERE user_id = ANY($1::text[])", [Object.values(users)]).catch(() => {});
  await insertSource(database, "nejm", { authority: 5 });
  await insertSource(database, "fda", { name: "FDA", lane: "regulatory", source_type: "regulator", authority: 5 });
  await insertSource(database, "stat", { name: "STAT", source_type: "media", authority: 3 });
  await insertSource(database, "hidden", { name: "Hidden", source_type: "media", enabled: false });
});

function daily({ now = () => FINALIZED, editor = aiEditor(), config = {} } = {}) {
  return new FrontierDaily({ database, jobs, notifications, editor, config: { frontierDailyTime: "07:30", frontierTimeZone: "Asia/Shanghai",
    frontierAudience: "all", operatorUsers: [users.operator], frontierPreviewUsers: [users.preview], ...config },
  owner: () => ({ userId: users.operator, projectId: FRONTIER_PROJECT_ID }), budget: async () => ({ state: "ok" }), now, workerId: "test-daily" });
}

function aiEditor({ fail = false } = {}) {
  const calls = [];
  return {
    calls, available: true, model: "deepseek-flash",
    writeDaily: async (input) => {
      calls.push(input);
      if (fail) throw Object.assign(new Error("model down"), { code: "frontier_model_timeout" });
      return { verification: "passed", aiMinuteZh: "今天与临床相关的 AI 进展有 1 条。", error: null };
    },
  };
}

/** Items in and around the window of the issue of 2026-09-22 (2026-09-20T23:00Z to 2026-09-21T23:00Z). */
async function seedWindow() {
  const summary = { summaryZh: "导读。", verification: "passed", selected: true };
  const lead = await insertComposedItem(database, { ...summary, sourceId: "nejm", title: "Lead paper", titleZh: "头条论文", scoreTotal: 92, visibleAt: "2026-09-21T10:00:00Z" });
  const second = await insertComposedItem(database, { ...summary, sourceId: "nejm", title: "Second paper", scoreTotal: 80, visibleAt: "2026-09-21T02:00:00Z" });
  const regulatory = await insertComposedItem(database, { ...summary, sourceId: "fda", lane: "regulatory", sourceType: "regulator", title: "Approval", scoreTotal: 75,
    visibleAt: "2026-09-21T05:00:00Z" });
  const safety = await insertComposedItem(database, { ...summary, sourceId: "fda", lane: "safety", sourceType: "regulator", title: "Safety alert", safetyAlert: true,
    visibleAt: "2026-09-21T06:00:00Z" });
  const ai = await insertComposedItem(database, { ...summary, sourceId: "stat", lane: "ai", sourceType: "media", title: "AI tool", selected: false, scoreTotal: 50,
    visibleAt: "2026-09-21T07:00:00Z" });
  const outside = [
    await insertComposedItem(database, { ...summary, sourceId: "nejm", title: "After the cut", scoreTotal: 99, visibleAt: "2026-09-21T23:05:00Z" }),
    await insertComposedItem(database, { ...summary, sourceId: "nejm", title: "Before the window", scoreTotal: 99, visibleAt: "2026-09-20T22:59:00Z" }),
    await insertComposedItem(database, { ...summary, sourceId: "nejm", title: "Title only", verification: "title-only", summaryZh: null, scoreTotal: 99, visibleAt: "2026-09-21T08:00:00Z" }),
    await insertComposedItem(database, { ...summary, sourceId: "hidden", sourceType: "media", title: "Hidden source", scoreTotal: 99, visibleAt: "2026-09-21T09:00:00Z" }),
  ];
  return { lead, second, regulatory, safety, ai, outside };
}

test("one issue a day through the frontier-daily job: its window, its sections without padding, the AI minute, the Markdown", options, async () => {
  const seeded = await seedWindow();
  const early = daily({ now: () => new Date("2026-09-21T23:10:00Z") });
  assert.equal((await early.runDue()).ran, false, "07:10 is before the daily time");
  const editor = aiEditor();
  const writer = daily({ editor });
  const before = await metaValue(database, "daily_version");
  assert.deepEqual(await writer.runDue(), { day: DAY, ran: true, empty: false });
  assert.equal(await metaValue(database, "daily_version"), before + 1);
  const job = (await database.query("SELECT status, result FROM evimed_product.jobs WHERE user_id = $1 AND idempotency_key = $2", [users.operator, `frontier-daily:${DAY}`])).rows;
  assert.deepEqual(job, [{ status: "succeeded", result: { day: DAY, items: 4 } }]);
  assert.deepEqual(await writer.runDue(), { day: DAY, ran: false }, "the day's issue is written once");
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_product.jobs WHERE user_id = $1", [users.operator])).rows[0].n, 1);

  const issue = await writer.read(DAY);
  assert.equal(issue.windowStart, "2026-09-20T23:00:00.000Z");
  assert.equal(issue.windowEnd, "2026-09-21T23:00:00.000Z");
  assert.equal(issue.lead.itemId, seeded.lead.publicId);
  assert.equal(issue.lead.title, "头条论文");
  assert.equal(issue.lead.text, "导读。");
  assert.equal(issue.lead.eventId, null, "an item alone in its event links to no event page");
  assert.deepEqual(issue.sections, [
    { lane: "evidence", itemIds: [seeded.second.publicId] },
    { lane: "regulatory", itemIds: [seeded.regulatory.publicId] },
  ], "no section for a lane with nothing selected, and the AI lane's unselected item is not padding");
  assert.deepEqual(issue.safety, [seeded.safety.publicId]);
  assert.equal(issue.aiMinute, "今天与临床相关的 AI 进展有 1 条。");
  assert.equal(editor.calls[0].items.length, 1, "the AI minute read the AI lane's verified item");
  assert.equal(issue.itemCount, 4);
  assert.match(issue.markdown, /^# EviMed 医学前沿日报 · 2026年9月22日/);
  assert.match(issue.markdown, /## 头条\n\n\*\*头条论文\*\*（NEJM Journal）/);
  for (const title of ["After the cut", "Before the window", "Title only", "Hidden source"]) assert.doesNotMatch(issue.markdown, new RegExp(title));
  assert.deepEqual(await writer.list(), [{ day: DAY, title: "头条论文", itemCount: 4, generatedAt: FINALIZED.toISOString() }]);
  assert.equal(await writer.read("2026-09-21"), null);
  assert.equal(await writer.read("not-a-day"), null);
});

test("an issue names every source by its institution — the safety block, the Markdown, the AI minute's input — never by its feed", options, async () => {
  await insertSource(database, "openfda-drug-enforcement-api", { name: "openFDA 药品召回（enforcement）API", lane: "safety", source_type: "regulator",
    authority: 5, owner_entity: "U.S. Food and Drug Administration" });
  await insertSource(database, "stat-health-tech", { name: "STAT · Health Tech 频道", lane: "ai", source_type: "media", owner_entity: "Boston Globe Media" });
  const summary = { summaryZh: "导读。", verification: "passed", selected: true };
  const recall = await insertComposedItem(database, { ...summary, sourceId: "openfda-drug-enforcement-api", lane: "safety", sourceType: "regulator",
    title: "Class I recall", titleZh: "I 级召回：葡萄糖注射液", safetyAlert: true, visibleAt: "2026-09-21T06:00:00Z" });
  await insertComposedItem(database, { ...summary, sourceId: "stat-health-tech", lane: "ai", sourceType: "media", title: "AI scribe study", selected: false,
    scoreTotal: 50, visibleAt: "2026-09-21T07:00:00Z" });
  const editor = aiEditor();
  const issue = await daily({ editor }).compose(DAY);
  assert.deepEqual(issue.safety, [recall.publicId]);
  assert.match(issue.markdown, /## 安全警示\n\n- \*\*I 级召回：葡萄糖注射液\*\*（FDA）：导读。/);
  assert.doesNotMatch(issue.markdown, /（[^）\n]*(openFDA|enforcement|API|频道)/, "no feed's or interface's name where a source is named");
  assert.match(issue.markdown, /来源：EviMed 前沿动态\n$/);
  assert.deepEqual(editor.calls[0].items.map((item) => item.sourceName), ["STAT"], "the AI minute is written from institution names");
});

test("an issue knows the issues on either side of it: the nearest, since a quiet day has none", options, async () => {
  for (const day of ["2026-09-18", "2026-09-20", "2026-09-22"]) {
    await database.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety, markdown, item_ids, model)
      VALUES ($1::date, now(), now(), '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '# 日报', '{}', 'deepseek-flash')`, [day]);
  }
  const reader = daily();
  assert.deepEqual([(await reader.read("2026-09-20")).previousDay, (await reader.read("2026-09-20")).nextDay], ["2026-09-18", "2026-09-22"]);
  assert.deepEqual([(await reader.read("2026-09-18")).previousDay, (await reader.read("2026-09-22")).nextDay], [null, null]);
});

test("a day with nothing to publish is no issue and no alert; a failed one is retried and, past 07:45, an alert", options, async () => {
  const quiet = daily();
  assert.deepEqual(await quiet.runDue(), { day: DAY, ran: true, empty: true });
  assert.equal(await quiet.read(DAY), null);
  const later = daily({ now: () => new Date("2026-09-21T23:50:00Z") });
  await later.runDue();
  assert.equal(later.state.missing, false, "an empty day is not a missing issue");

  await database.query("DELETE FROM evimed_product.jobs WHERE user_id = $1", [users.operator]);
  await seedWindow();
  const failing = daily({ now: () => new Date("2026-09-21T23:50:00Z"), editor: aiEditor({ fail: true }) });
  await assert.rejects(failing.runDue(), { code: "frontier_model_timeout" });
  assert.equal(failing.state.missing, true);
  assert.equal(failing.state.lastError, "frontier_model_timeout");
  const job = (await database.query("SELECT status, attempts FROM evimed_product.jobs WHERE user_id = $1", [users.operator])).rows[0];
  assert.deepEqual(job, { status: "queued", attempts: 1 }, "the job is queued again on its own schedule");
  assert.equal(await failing.read(DAY), null, "yesterday's issue stays the latest");
});

async function preferences(userId, { digestTime = "08:00", switches = { notify: true, question: true, review: true } } = {}) {
  await notifications.preferences(userId);
  await database.query("UPDATE evimed_inbox.preferences SET digest_time = $2, switches = $3::jsonb WHERE user_id = $1", [userId, digestTime, JSON.stringify(switches)]);
}

test("the push: one inbox item per reader at their own digest time, only to readers who came or follow, once, never personal", options, async () => {
  const seeded = await seedWindow();
  await daily().runDue();
  const at = new Date("2026-09-22T00:30:00Z"); // 08:30 in Beijing
  const seen = (days) => new Date(at.getTime() - days * 86_400_000);
  for (const [role, lastSeen] of [["reader", seen(1)], ["stale", seen(20)], ["off", seen(1)], ["late", seen(1)], ["pushed", seen(1)], ["preview", seen(2)]]) {
    await database.query("INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ($1, $2)", [users[role], lastSeen]);
  }
  await database.query("INSERT INTO evimed_frontier.user_prefs (user_id) VALUES ($1)", [users.follower]);
  await database.query("INSERT INTO evimed_frontier.user_follows (user_id, kind, key, label) VALUES ($1, 'drug', 'semaglutide', '司美格鲁肽')", [users.follower]);
  await database.query("UPDATE evimed_frontier.user_prefs SET last_push_day = $2 WHERE user_id = $1", [users.pushed, DAY]);
  await preferences(users.off, { switches: { frontier: false, notify: true, question: true, review: true } });
  await preferences(users.late, { digestTime: "09:00" });

  const pusher = daily({ now: () => at });
  assert.deepEqual(await pusher.pushDue(), { pushed: 3 });
  const pushed = (await database.query(`SELECT user_id, title, body, source, notice_type, group_key FROM evimed_inbox.notifications
    WHERE user_id = ANY($1::text[]) ORDER BY user_id`, [Object.values(users)])).rows;
  assert.deepEqual(pushed.map((row) => row.user_id).sort(), [users.follower, users.preview, users.reader].sort(),
    "seen in 14 days or following; not the stale, the switched off, the later digest time, or the already pushed");
  assert.equal(pushed[0].title, "今日前沿 · 9月22日 · 3 条精选");
  assert.equal(pushed[0].body, "头条论文\n安全警示 1 条", "the headline and the safety count: no lane counts, no instructions");
  assert.deepEqual(pushed[0].source, { type: "digest", id: `frontier-daily:${DAY}` });
  assert.equal(pushed[0].group_key, `frontier-daily:${DAY}`);
  assert.doesNotMatch(pushed[0].body, /因为|与你相关/);
  assert.equal((await database.query("SELECT last_push_day::text AS day FROM evimed_frontier.user_prefs WHERE user_id = $1", [users.reader])).rows[0].day, DAY);
  assert.deepEqual(await pusher.pushDue(), { pushed: 0 }, "once a day");
  await database.query("UPDATE evimed_frontier.user_prefs SET last_push_day = NULL WHERE user_id = $1", [users.reader]);
  assert.deepEqual(await pusher.pushDue(), { pushed: 1 });
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_inbox.notifications WHERE user_id = $1", [users.reader])).rows[0].n, 1,
    "a second push of the same day is the same inbox item");
  const later = daily({ now: () => new Date("2026-09-22T01:05:00Z") });
  assert.deepEqual(await later.pushDue(), { pushed: 1 }, "the reader with a 09:00 digest time is told at 09:05");
  void seeded;
});

test("the push under the operators audience reaches operators and the preview list only; no issue, no push", options, async () => {
  await seedWindow();
  await daily().runDue();
  for (const role of ["reader", "preview", "operator"]) {
    await database.query("INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ($1, $2)", [users[role], new Date("2026-09-21T12:00:00Z")]);
  }
  const at = new Date("2026-09-22T00:30:00Z");
  const dryRun = daily({ now: () => at, config: { frontierAudience: "operators" } });
  assert.deepEqual(await dryRun.pushDue(), { pushed: 2 });
  const told = (await database.query("SELECT user_id FROM evimed_inbox.notifications WHERE user_id = ANY($1::text[])", [Object.values(users)])).rows.map((row) => row.user_id);
  assert.deepEqual(told.sort(), [users.operator, users.preview].sort());
  assert.deepEqual(await daily({ now: () => new Date("2026-09-23T00:30:00Z") }).pushDue(), { pushed: 0 }, "the next day has no issue yet");
});

test("the notification switch: frontier reads on by default, a page that sends three switches keeps it, four set it, others are refused", options, async () => {
  const fresh = await notifications.preferences(users.reader);
  assert.deepEqual(fresh.switches, { notify: true, question: true, review: true, frontier: true });
  const off = await notifications.updatePreferences(users.reader, { quietHours: fresh.quietHours, digestTime: "08:00",
    switches: { notify: true, question: true, review: true, frontier: false }, channels: ["in-app"] }, fresh.revision);
  assert.equal(off.switches.frontier, false);
  const kept = await notifications.updatePreferences(users.reader, { quietHours: fresh.quietHours, digestTime: "08:30",
    switches: { notify: true, question: false, review: true }, channels: ["in-app"] }, off.revision);
  assert.deepEqual(kept.switches, { notify: true, question: false, review: true, frontier: false }, "an older page keeps what it did not send");
  await assert.rejects(notifications.updatePreferences(users.reader, { quietHours: fresh.quietHours, digestTime: "08:30",
    switches: { notify: true, question: true, review: true, frontier: "yes" }, channels: ["in-app"] }, kept.revision), { code: "notification_preferences_invalid" });
  await assert.rejects(notifications.updatePreferences(users.reader, { quietHours: fresh.quietHours, digestTime: "08:30",
    switches: { notify: true, question: true, review: true, email: true }, channels: ["in-app"] }, kept.revision), { code: "notification_preferences_invalid" });
});
