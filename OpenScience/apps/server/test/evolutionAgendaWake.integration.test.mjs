// What waking a waiting agenda is, against the real product store and the real autopilot service: an ordinary
// scheduled continuation. Every stopping rule that governs the agenda's other episodes still governs it, a refusal
// for budget is a wait and not an error, and the researcher's own start time is never written by the platform.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "Local test Postgres is not configured" };
const owner = `wake_${randomUUID()}`;
let database, isolated, documents, jobs;
let now = new Date("2026-10-01T06:00:00Z");

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "wake");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Wake test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Wake project',1000000)", [owner]);
  documents = new ProductDocuments(database);
  jobs = new ProductJobs(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

const need = { kind: "tool", capabilityId: "statistical-analysis", methodId: "decision-net-benefit" };
/** A planner that runs the first episode and then stops asking for a tool, then answers whatever `later` says. */
function planner(later = (input) => ({ action: "run", taskType: input.eligible[0], focus: "继续", reason: "新工具已就绪", model: "deepseek-flash" })) {
  const calls = [];
  return { calls, decide: async (input) => {
    calls.push(input);
    if (calls.length === 1) return { action: "run", taskType: input.eligible[0], focus: "开始", reason: "第一轮", model: "deepseek-flash" };
    if (calls.length === 2) return { action: "stop", stopKind: "needs_input", reason: "缺少计算工具", resourceNeed: need, model: "deepseek-flash" };
    return later(input);
  } };
}
const evolution = { availableTools: async () => [], plannerStopped: async () => {} };
const tick = (iso) => { now = new Date(iso); };

/** An agenda that ran one episode to success and was then stopped by the planner, waiting for a tool. */
async function waiting(service) {
  tick("2026-10-01T06:00:00Z");
  let row = await service.create(owner, { projectId: "project-test", title: "Wake", prompt: "Preserve the full instruction.", taskTypes: ["literature-sentinel", "evidence-update"],
    schedule: { kind: "daily", timeZone: "UTC", time: "07:35" }, dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8 });
  row = await service.start(owner, row.id, { expectedRevision: row.revision });
  const startedAt = (await service.get(owner, row.id)).payload.lastStartedAt;
  tick("2026-10-01T07:35:00Z");
  const first = await service.scheduleDue(owner, row.id);
  await service.recordOutcome(owner, row.id, { expectedRevision: (await service.get(owner, row.id)).revision, episodeId: first.episode.id, status: "succeeded", gatedClaims: 1 });
  tick("2026-10-02T07:35:00Z");
  const stopped = await service.scheduleDue(owner, row.id);
  assert.equal(stopped.stopped.kind, "needs_input");
  const paused = await service.get(owner, row.id);
  assert.equal(paused.payload.status, "paused");
  return { id: row.id, startedAt, sourceEpisodeId: paused.payload.evolutionWaiting.sourceEpisodeId };
}
const wake = (service, agenda, id = "tool-ready-1") => service.wakeForEvolution({ userId: owner, agendaId: agenda.id, sourceEpisodeId: agenda.sourceEpisodeId,
  event: { id, type: "tool-ready", toolId: "tool-new" } });

test("a wake is a scheduled continuation: the researcher's start time is untouched, the stop is remembered, and the planner may stop again", options, async () => {
  const brain = planner(); const service = new AutopilotService({ documents, jobs, planner: brain, evolution, now: () => now });
  const agenda = await waiting(service);
  tick("2026-10-03T09:00:00Z");
  const timerWatermark = (await service.get(owner, agenda.id)).payload.lastScheduledDate;
  const result = await wake(service, agenda);
  assert.equal(result.resumed, true);
  const woken = await service.get(owner, agenda.id);
  assert.equal(woken.payload.lastStartedAt, agenda.startedAt, "the platform does not start an agenda on a researcher's behalf");
  assert.equal(woken.payload.enabled, true);
  assert.equal(woken.payload.plannerStop, null);
  assert.equal(woken.payload.lastStop.kind, "needs_input", "the next decision still sees why the agenda had stopped");
  const episode = await service.getEpisode(owner, result.episode.id);
  assert.equal(episode.payload.trigger, "scheduled", "not a request of the researcher's: the planner may stop and priority is honoured");
  const decision = brain.calls.at(-1);
  assert.equal(decision.stopAllowed, true);
  // The same event again resumes nothing new.
  const again = await wake(service, agenda);
  assert.equal(again.episode.id, result.episode.id);
  assert.equal(brain.calls.length, 3);
  // It is not one of the timer's occurrences: the timer's own watermark stays where the timer left it.
  assert.equal((await service.get(owner, agenda.id)).payload.lastScheduledDate, timerWatermark);
});

test("a researcher who stopped reading, or who rejected the direction, is not woken by the platform", options, async () => {
  const service = new AutopilotService({ documents, jobs, planner: planner(), evolution, now: () => now });
  const quiet = await waiting(service);
  await documents.put(owner, "digest", `unread-${randomUUID()}`, { agendaId: quiet.id, openedAt: null, createdAt: "2026-09-01T00:00:00.000Z" }, { expectedRevision: 0, projectId: "project-test" });
  tick("2026-10-20T09:00:00Z");
  assert.equal((await wake(service, quiet)).resumed, false);
  const stillPaused = await service.get(owner, quiet.id);
  assert.equal(stillPaused.payload.enabled, false);
  assert.equal(stillPaused.payload.lastStartedAt, quiet.startedAt);
  const rejecting = await waiting(new AutopilotService({ documents, jobs, planner: planner(), evolution, now: () => now }));
  const row = await documents.get(owner, "agenda", rejecting.id);
  await documents.put(owner, "agenda", rejecting.id, { ...row.payload, userSignal: { rejected: true } }, { expectedRevision: row.revision, projectId: "project-test" });
  tick("2026-10-03T09:00:00Z");
  assert.equal((await wake(service, rejecting)).resumed, false);
  assert.equal((await service.get(owner, rejecting.id)).payload.enabled, false);
});

test("a wake refused for the task's budget leaves the agenda active for its own schedule and is not an error", options, async () => {
  const usage = { assertWithinLimits: async () => ({ allowed: true }), spendOfRuns: async () => ({ day: 25, week: 25 }), spendTimelineOfRuns: async () => [] };
  const service = new AutopilotService({ documents, jobs, usage, planner: planner(), evolution, now: () => now });
  const agenda = await waiting(new AutopilotService({ documents, jobs, planner: planner(), evolution, now: () => now }));
  tick("2026-10-03T09:00:00Z");
  const result = await wake(service, agenda);
  assert.equal(result.resumed, true);
  assert.equal(result.deferred, "autopilot_daily_budget_spent");
  const woken = await service.get(owner, agenda.id);
  assert.equal(woken.payload.enabled, true);
  assert.equal(woken.payload.lastStartedAt, agenda.startedAt);
});

test("an evolution read that fails does not cost the agenda its planner decision", options, async () => {
  const calls = [];
  const brain = { decide: async (input) => { calls.push(input); return { action: "run", taskType: input.eligible[0], focus: "继续", reason: "新证据", model: "deepseek-flash" }; } };
  const failing = { availableTools: async () => { throw Object.assign(new Error("tool list unavailable"), { code: "product_store_unavailable" }); }, plannerStopped: async () => {} };
  const service = new AutopilotService({ documents, jobs, planner: brain, evolution: failing, now: () => now });
  tick("2026-10-01T06:00:00Z");
  let row = await service.create(owner, { projectId: "project-test", title: "Read fails", prompt: "Preserve the full instruction.", taskTypes: ["literature-sentinel"],
    schedule: { kind: "daily", timeZone: "UTC", time: "07:35" }, dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8 });
  row = await service.start(owner, row.id, { expectedRevision: row.revision });
  tick("2026-10-01T07:35:00Z");
  const scheduled = await service.scheduleDue(owner, row.id);
  assert.equal(calls.length, 1, "the planner was asked");
  assert.equal(scheduled.episode.payload.selection.source, "model", "and its decision stands, not the date rotation");
  assert.equal(scheduled.episode.payload.selection.fallbackReason, undefined);
});
