import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `notice_${randomUUID()}`;
const other = `notice_${randomUUID()}`;
let database;
let service;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Notice owner','development'),($2,'Other','development')", [owner, other]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Notice',1048576),($2,'default','Other',1048576)", [owner, other]);
  service = new NotificationService(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
  await database.close();
});

test("a real proactive digest persists one actionable inbox item under its owner", options, async (t) => {
  const digestOwner = `digest_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Digest owner','development')", [digestOwner]);
  t.after(() => database.query("DELETE FROM evimed_control.users WHERE id=$1", [digestOwner]));
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Digest',1048576)", [digestOwner]);
  const autopilot = new AutopilotService({ documents: new ProductDocuments(database),
    jobs: new ProductJobs(database), notifications: service });
  const agenda = await autopilot.create(digestOwner, { projectId: "default", title: "Digest integration",
    topics: ["research updates"], taskTypes: ["literature-sentinel"], dailyBudgetCny: 2,
    weeklyBudgetCny: 10, maxEpisodeCny: 1, scheduleHour: 1, timeZone: "UTC" });
  const input = { digestId: "digest-inbox-contract", date: "2026-09-06", episodeIds: ["episode-contract"], costCny: 0, claims: [] };
  const digest = await autopilot.createDigest(digestOwner, agenda.id, input);
  await autopilot.createDigest(digestOwner, agenda.id, input);
  const notices = (await service.list(digestOwner)).items.filter(item => item.source?.id === digest.id);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].source, { type: "digest", id: digest.id });
  assert.deepEqual(notices[0].actions.map(action => action.id), ["open"]);
  assert.equal(notices[0].projectId, "default");
  assert.equal((await service.list(other)).items.some(item => item.source?.id === digest.id), false);
});

test("inbox ordering puts reviews and questions before informational notices", options, async () => {
  await service.create(owner, { noticeType: "notify", title: "Result ready", body: "A run completed." });
  const question = await service.create(owner, { noticeType: "question", title: "Choose scope", body: "Which outcome matters?",
    actions: [{ id: "outcome-a", label: "Outcome A" }] });
  const review = await service.create(owner, { noticeType: "review", title: "Review finding", body: "A conflict needs a decision.",
    actions: [{ id: "adopt", label: "Adopt" }, { id: "reject", label: "Reject" }] });
  const page = await service.list(owner, { limit: 2 });
  assert.deepEqual(page.items.map((item) => item.id), [review.id, question.id]);
  assert.ok(page.nextCursor);
  assert.equal((await service.list(owner, { limit: 2, cursor: page.nextCursor })).items.length, 1);
  assert.equal((await service.list(other)).items.length, 0);
  const once = await service.create(owner, { noticeType: "notify", title: "One result", body: "This event is idempotent.",
    source: { type: "run", id: "run-one" }, idempotencyKey: "run-one" });
  const retried = await service.create(owner, { noticeType: "notify", title: "One result", body: "This event is idempotent.",
    source: { type: "run", id: "run-one" }, idempotencyKey: "run-one" });
  assert.equal(retried.id, once.id);
  assert.equal(retried.count, 1);
  await assert.rejects(service.create(owner, { noticeType: "notify", title: "One result", body: "This event is idempotent.",
    actions: [{ id: "different", label: "Different" }], idempotencyKey: "run-one" }), { code: "notification_idempotency_conflict" });
  const grouped = await service.create(owner, { noticeType: "notify", title: "Grouped once", body: "One event.",
    groupKey: "idempotent-group", idempotencyKey: "grouped-run" });
  const groupedRetry = await service.create(owner, { noticeType: "notify", title: "Grouped once", body: "One event.",
    groupKey: "idempotent-group", idempotencyKey: "grouped-run" });
  assert.equal(groupedRetry.id, grouped.id);
  assert.equal(groupedRetry.count, 1);
});

test("read and resolution updates are revision guarded and account scoped", options, async () => {
  const notice = await service.create(owner, { noticeType: "review", title: "Candidate memory", body: "Use this preference?",
    actions: [{ id: "approve", label: "Approve" }, { id: "retire", label: "Retire" }] });
  await assert.rejects(service.markRead(other, notice.id, notice.revision), { code: "notification_not_found" });
  const read = await service.markRead(owner, notice.id, notice.revision);
  assert.ok(read.readAt);
  await assert.rejects(service.resolve(owner, notice.id, { actionId: "approve", expectedRevision: notice.revision }), { code: "notification_revision_conflict" });
  const resolved = await service.resolve(owner, notice.id, { actionId: "approve", expectedRevision: read.revision });
  assert.equal(resolved.resolution.actionId, "approve");
  assert.ok(resolved.resolvedAt);
  await assert.rejects(service.resolve(owner, notice.id, { actionId: "unknown", expectedRevision: resolved.revision }), { code: "notification_action_invalid" });
  await assert.rejects(service.resolve(owner, notice.id, { actionId: "retire", expectedRevision: resolved.revision }), { code: "notification_already_resolved" });
});

test("a group key names one item: later events fold into it and bring it back, and blocking items never fold", options, async () => {
  // The key carries its own period (a run-finished key names the project and
  // the day), so there is no time window: six hours later is the same item.
  const now = new Date("2026-09-06T01:00:00Z");
  const open = [{ id: "open", label: "查看" }];
  const first = await service.create(owner, { noticeType: "notify", title: "Index update", body: "One source indexed.", groupKey: "thread-one", actions: open }, { now });
  const merged = await service.create(owner, { noticeType: "notify", title: "Index update", body: "Another source indexed.", groupKey: "thread-one", actions: open }, { now: new Date(now.getTime() + 4 * 60_000) });
  assert.equal(merged.id, first.id);
  assert.equal(merged.count, 2);
  // Read and opened, then another event: the same item comes back unread and
  // moves to where a new item would be, rather than a second item appearing.
  const read = await service.markRead(owner, merged.id, merged.revision);
  const opened = await service.resolve(owner, merged.id, { actionId: "open", expectedRevision: read.revision });
  assert.ok(opened.resolvedAt);
  const later = await service.create(owner, { noticeType: "notify", title: "Index update", body: "A later source indexed.", groupKey: "thread-one", actions: open }, { now: new Date(now.getTime() + 6 * 3_600_000) });
  assert.equal(later.id, first.id);
  assert.equal(later.count, 3);
  assert.equal(later.readAt, null, "a folded event brings a read item back");
  assert.equal(later.resolvedAt, null);
  assert.equal(later.body, "A later source indexed.", "the item says what the latest event says");
  assert.ok(Date.parse(later.createdAt) > Date.parse(opened.createdAt), "it sorts where a new item would");
  const review = await service.create(owner, { noticeType: "review", title: "Do not aggregate", body: "Decision one.", groupKey: "thread-one",
    actions: [{ id: "ok", label: "OK" }] }, { now });
  const secondReview = await service.create(owner, { noticeType: "review", title: "Do not aggregate", body: "Decision two.", groupKey: "thread-one",
    actions: [{ id: "ok", label: "OK" }] }, { now: new Date(now.getTime() + 60_000) });
  assert.notEqual(review.id, secondReview.id);
  // Nothing joins a group quietly any more (plan 2026-09-23 §5.8): a caller
  // that asks for a silent record is refused, not turned into a notice that
  // lights the bell, and the group is left as it was.
  await assert.rejects(service.create(owner, { noticeType: "notify", title: "Index update", body: "A background source indexed.",
    groupKey: "thread-one", actions: open, silent: true }, { now: new Date(now.getTime() + 7 * 3_600_000) }), { code: "notification_payload_invalid" });
  const unchanged = await service.get(owner, later.id);
  assert.equal(unchanged.count, 3);
  assert.equal("silent" in unchanged, false, "an item has no quiet flag to report");
  await assert.rejects(service.create(owner, { noticeType: "notify", title: "Index update", body: "Wrong project.",
    groupKey: "thread-one", projectId: "missing-project" }, { now: new Date(now.getTime() + 2 * 60_000) }), { code: "23503" });
  const concurrent = await Promise.all([
    service.create(other, { noticeType: "notify", title: "Concurrent", body: "First.", groupKey: "same-group", projectId: "default" }, { now }),
    service.create(other, { noticeType: "notify", title: "Concurrent", body: "Second.", groupKey: "same-group", projectId: "default" }, { now }),
  ]);
  assert.equal(new Set(concurrent.map((item) => item.id)).size, 1);
  assert.equal((await service.list(other)).items.find((item) => item.id === concurrent[0].id).count, 2);
});

test("a replayed event is recognised after its group has moved on, and folds once", options, async () => {
  const user = `group_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Group owner','development')", [user]);
  try {
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Group',1048576)", [user]);
    const event = (run, body) => ({ noticeType: "notify", title: "研究已完成", body, projectId: "default",
      source: { type: "run", id: run }, groupKey: "run-finished:default:2026-09-18", idempotencyKey: `run-finished:${run}` });
    const one = await service.create(user, event("run-1", "第一项。"));
    const two = await service.create(user, event("run-2", "两项。"));
    const three = await service.create(user, event("run-3", "三项。"));
    assert.equal(three.id, one.id);
    assert.equal(three.count, 3);
    // Each member's replay returns the group as it stands, not a conflict with
    // the content that member once wrote, and does not count again.
    for (const replay of [event("run-1", "第一项。"), event("run-2", "两项。"), event("run-3", "三项。")]) {
      const again = await service.create(user, replay);
      assert.equal(again.id, one.id);
      assert.equal(again.count, 3);
    }
    assert.equal(two.id, one.id);
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});

test("the unread count is every unread item, severity is stored, a quiet record is refused, and read-all clears the scope", options, async () => {
  const user = `count_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Count owner','development')", [user]);
  try {
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Count',1048576),($1,'second','Second',1048576)", [user]);
    // More than a page, so a count that measured the page would be caught.
    for (let index = 0; index < 55; index += 1) {
      await service.create(user, { noticeType: "notify", title: `Result ${index}`, body: "A run completed.", projectId: "default" });
    }
    const safety = await service.create(user, { noticeType: "notify", title: "涉及临床安全", body: "请核对。", projectId: "second", severity: "safety",
      actions: [{ id: "open", label: "打开对话" }] });
    const question = await service.create(user, { noticeType: "question", title: "Choose", body: "Which?", actions: [{ id: "a", label: "A" }] });
    assert.equal(safety.severity, "safety");
    assert.equal(question.severity, "attention", "a blocking item defaults to attention");
    await assert.rejects(service.create(user, { noticeType: "notify", title: "x", body: "y", severity: "urgent" }), { code: "notification_payload_invalid" });
    // An evaluation's quiet 「自动运行已完成」 used to arrive read here; work
    // nobody asked about now leaves no item, and asking for one is refused.
    await assert.rejects(service.create(user, { noticeType: "notify", title: "自动运行已完成", body: "评测。", projectId: "default", silent: true }),
      { code: "notification_payload_invalid" });
    assert.equal((await service.list(user)).items.some((item) => item.title === "自动运行已完成"), false);

    assert.deepEqual(await service.unreadCount(user), { unreadTotal: 57, safetyUnread: 1 });
    const page = await service.list(user, { unreadOnly: true, limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.unreadTotal, 57, "the total, not the page");
    // A project scope counts that project and the account-wide items.
    assert.deepEqual(await service.unreadCount(user, { projectId: "second" }), { unreadTotal: 2, safetyUnread: 1 });
    // Any unread item can be marked read, the ones with actions included.
    const readSafety = await service.markRead(user, safety.id, safety.revision);
    assert.ok(readSafety.readAt);
    assert.equal(readSafety.resolvedAt, null, "reading is not resolving");
    assert.deepEqual(await service.markAllRead(user, { projectId: "default" }), { updated: 56 }, "the project's items and the account-wide question");
    assert.deepEqual(await service.unreadCount(user), { unreadTotal: 0, safetyUnread: 0 });
    assert.deepEqual(await service.markAllRead(user), { updated: 0 }, "idempotent");
    assert.equal((await service.get(user, question.id)).resolvedAt, null, "a question marked read is still a question");
    await assert.rejects(service.markAllRead(user, { noticeType: "digest" }), { code: "notification_filter_invalid" });
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});

test("read items leave ninety days after they were read, and unread or still-asking items stay", options, async () => {
  const user = `retain_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Retention owner','development')", [user]);
  try {
    const old = new Date("2026-01-01T00:00:00Z");
    const readOld = await service.create(user, { noticeType: "notify", title: "Old and read", body: "x" }, { now: old });
    await service.markRead(user, readOld.id, readOld.revision);
    const unreadOld = await service.create(user, { noticeType: "notify", title: "Old and unread", body: "x" }, { now: old });
    const askingOld = await service.create(user, { noticeType: "question", title: "Old question", body: "x", actions: [{ id: "a", label: "A" }] }, { now: old });
    await service.markRead(user, askingOld.id, askingOld.revision);
    // Read "now" in the database's clock; backdate the two reads.
    await database.query("UPDATE evimed_inbox.notifications SET read_at=$2 WHERE id=ANY($1::text[])", [[readOld.id, askingOld.id], old]);
    const before = (await service.list(user)).items.length;
    const deleted = await service.pruneRead({ now: new Date("2026-04-02T00:00:00Z") });
    assert.ok(deleted >= 1, `the sweep deleted ${deleted}`);
    const left = new Set((await service.list(user)).items.map((item) => item.id));
    assert.equal(left.has(readOld.id), false, "a notice read more than ninety days ago leaves");
    assert.equal(left.has(unreadOld.id), true, "an unread item is never swept");
    assert.equal(left.has(askingOld.id), true, "a question that is read but unanswered is still asking");
    assert.equal(before - left.size, 1);
    // Read yesterday: kept.
    const recent = await service.create(user, { noticeType: "notify", title: "Recent", body: "x" }, { now: old });
    await service.markRead(user, recent.id, recent.revision);
    await service.pruneRead({ now: new Date(Date.now() + 86_400_000) });
    assert.ok((await service.list(user)).items.some((item) => item.id === recent.id));
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});

test("the quiet records an earlier release stored are gone after the next start, and nothing else is", options, async () => {
  const user = `legacy_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Legacy owner','development')", [user]);
  // A second connection object is a second start: the inbox migration runs
  // once per database handle.
  const restarted = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try {
    const kept = await service.create(user, { noticeType: "notify", title: "问题 A 已完成", body: "报告和 1 个文件已在对话里" });
    // What the release before 2026-09-24 stored for an evaluation run or the
    // method library's housekeeping: read on arrival, shown only under the
    // 「自动运行 N 条」 fold.
    const legacy = `legacy-${randomUUID()}`;
    await database.query(`INSERT INTO evimed_inbox.notifications(id,user_id,notice_type,priority,title,body,severity,silent,read_at)
      VALUES($1,$2,'notify',$3,'方法库整理：核对剂量','x','info',true,clock_timestamp())`, [legacy, user, kept.priority]);
    const items = (await new NotificationService(restarted).list(user)).items.map((item) => item.id);
    assert.deepEqual(items, [kept.id]);
    assert.equal((await database.query("SELECT 1 FROM evimed_inbox.notifications WHERE id=$1", [legacy])).rowCount, 0,
      "the row itself is gone, not only hidden");
  } finally {
    await restarted.close();
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});

test("due defaults settle once and preferences preserve quiet hours and in-app delivery", options, async () => {
  await assert.rejects(service.create(owner, { noticeType: "question", title: "Missing due time", body: "This default cannot run.",
    actions: [{ id: "pause", label: "Pause" }], defaultAction: "pause" }), { code: "notification_payload_invalid" });
  const due = await service.create(owner, { noticeType: "question", title: "Timed choice", body: "Keep the task queued?",
    actions: [{ id: "pause", label: "Pause" }, { id: "continue", label: "Continue" }], defaultAction: "pause",
    dueAt: "2026-09-06T01:00:00Z" });
  assert.equal((await service.applyDueDefaults(new Date("2026-09-06T00:59:59Z"))).length, 0);
  const applied = await service.applyDueDefaults(new Date("2026-09-06T01:00:01Z"));
  assert.equal(applied[0].id, due.id);
  assert.equal(applied[0].resolution.actionId, "pause");
  assert.equal((await service.applyDueDefaults(new Date("2026-09-06T02:00:00Z"))).length, 0);
  const defaults = await service.preferences(owner);
  assert.deepEqual(defaults.channels, ["in-app"]);
  assert.deepEqual(defaults.quietHours, { start: "22:00", end: "08:00" });
  const saved = await service.updatePreferences(owner, { quietHours: { start: "23:00", end: "07:30" }, digestTime: "08:30",
    switches: { notify: true, question: true, review: true }, channels: ["in-app"] }, defaults.revision);
  assert.equal(saved.digestTime, "08:30");
});
