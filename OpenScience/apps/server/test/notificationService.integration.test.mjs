import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { NotificationService } from "../src/notificationService.mjs";

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
});

test("same-group notices aggregate for five minutes without swallowing blocking items", options, async () => {
  const now = new Date("2026-09-06T01:00:00Z");
  const first = await service.create(owner, { noticeType: "notify", title: "Index update", body: "One source indexed.", groupKey: "thread-one" }, { now });
  const merged = await service.create(owner, { noticeType: "notify", title: "Index update", body: "Another source indexed.", groupKey: "thread-one" }, { now: new Date(now.getTime() + 4 * 60_000) });
  assert.equal(merged.id, first.id);
  assert.equal(merged.count, 2);
  const later = await service.create(owner, { noticeType: "notify", title: "Index update", body: "A later source indexed.", groupKey: "thread-one" }, { now: new Date(now.getTime() + 6 * 60_000) });
  assert.notEqual(later.id, first.id);
  const review = await service.create(owner, { noticeType: "review", title: "Do not aggregate", body: "Decision one.", groupKey: "thread-one",
    actions: [{ id: "ok", label: "OK" }] }, { now });
  const secondReview = await service.create(owner, { noticeType: "review", title: "Do not aggregate", body: "Decision two.", groupKey: "thread-one",
    actions: [{ id: "ok", label: "OK" }] }, { now: new Date(now.getTime() + 60_000) });
  assert.notEqual(review.id, secondReview.id);
});

test("due defaults settle once and preferences preserve quiet hours and in-app delivery", options, async () => {
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
