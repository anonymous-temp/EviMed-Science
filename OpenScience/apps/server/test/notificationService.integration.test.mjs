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
  await assert.rejects(service.create(owner, { noticeType: "notify", title: "Index update", body: "Wrong project.",
    groupKey: "thread-one", projectId: "missing-project" }, { now: new Date(now.getTime() + 2 * 60_000) }), { code: "23503" });
  const concurrent = await Promise.all([
    service.create(other, { noticeType: "notify", title: "Concurrent", body: "First.", groupKey: "same-group", projectId: "default" }, { now }),
    service.create(other, { noticeType: "notify", title: "Concurrent", body: "Second.", groupKey: "same-group", projectId: "default" }, { now }),
  ]);
  assert.equal(new Set(concurrent.map((item) => item.id)).size, 1);
  assert.equal((await service.list(other)).items.find((item) => item.id === concurrent[0].id).count, 2);
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
