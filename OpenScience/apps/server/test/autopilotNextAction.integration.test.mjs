// The next-action decision against the real product store: what is persisted on
// the episode and the agenda survives JSONB, a stop and a replay are exactly-once
// under the store's own optimistic concurrency, and a type's pause outlives the
// episode that caused it.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { AutopilotPlanner } from "../src/autopilotNextAction.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "Local test Postgres is not configured" };
const owner = `nextaction_${randomUUID()}`;
let database;
let isolated;
let documents;
let jobs;
let now = new Date("2026-10-01T06:00:00Z");

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "nextaction");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Next action test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Next action project',1000000)", [owner]);
  documents = new ProductDocuments(database);
  jobs = new ProductJobs(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

const reply = (value) => ({ action: "run", focus: "核对尚未复核的结论", reason: "上次的结论还没有独立复核", model: "deepseek-flash", ...value });
function plannerDouble(handler) {
  const calls = [];
  return { calls, decide: async (input) => { calls.push(input); return handler(input, calls.length); } };
}
async function started(service, taskTypes = ["literature-sentinel", "evidence-update"]) {
  now = new Date("2026-10-01T06:00:00Z");
  let row = await service.create(owner, { projectId: "project-test", title: "Next action", prompt: "Preserve the full instruction.", taskTypes,
    schedule: { kind: "daily", timeZone: "UTC", time: "07:35" }, dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8 });
  row = await service.start(owner, row.id, { expectedRevision: row.revision });
  now = new Date("2026-10-01T07:35:00Z");
  return row;
}

test("the chosen action and its reason are persisted on the episode, read back unchanged, and a replay of the occurrence asks nothing", options, async () => {
  const planner = plannerDouble((input) => reply({ taskType: input.eligible.at(-1) }));
  const service = new AutopilotService({ documents, jobs, planner, now: () => now });
  const row = await started(service);
  const scheduled = await service.scheduleDue(owner, row.id);
  const stored = await service.getEpisode(owner, scheduled.episode.id);
  assert.equal(stored.payload.taskType, "evidence-update");
  assert.deepEqual(stored.payload.selection, { eligibleTypes: ["literature-sentinel", "evidence-update"], priority: "normal",
    decidedAt: stored.payload.selection.decidedAt, source: "model", model: "deepseek-flash", action: "run", taskType: "evidence-update",
    focus: "核对尚未复核的结论", reason: "上次的结论还没有独立复核" });
  assert.match(stored.payload.prompt, /Planned focus for this episode/);
  assert.equal(planner.calls.length, 1);
  assert.equal(planner.calls[0].episodeId, stored.id);
  // The same occurrence again (the watermark is already past it) and the same request by date: one episode, one decision.
  assert.equal(await service.scheduleDue(owner, row.id), null);
  const again = await service.schedule(owner, row.id, { date: "2026-10-01" });
  assert.equal(again.episode.id, stored.id);
  assert.equal(planner.calls.length, 1);
});

test("a type's pause is persisted by the outcome that earned it and shapes the next decision; a start lifts it", options, async () => {
  const planner = plannerDouble((input) => reply({ taskType: input.eligible[0] }));
  const service = new AutopilotService({ documents, jobs, planner, now: () => now });
  const row = await started(service);
  const types = [];
  for (const date of ["2026-10-01", "2026-10-02"]) {
    now = new Date(`${date}T07:35:00Z`);
    const result = await service.scheduleDue(owner, row.id);
    types.push(result.episode.payload.taskType);
    const current = await service.get(owner, row.id);
    await service.recordOutcome(owner, row.id, { expectedRevision: current.revision, episodeId: result.episode.id, status: "failed", gatedClaims: 0 });
  }
  assert.deepEqual(types, ["literature-sentinel", "literature-sentinel"], "the planner double always takes the first offered type");
  const paused = await service.get(owner, row.id);
  assert.equal(paused.payload.status, "active", "the other type is still allowed");
  assert.ok(paused.payload.taskTypeState["literature-sentinel"].pausedAt);
  assert.equal(paused.payload.episodesWithoutGatedClaim, 0, "two failures to run are not two episodes that found nothing");
  now = new Date("2026-10-03T07:35:00Z");
  const next = await service.scheduleDue(owner, row.id);
  assert.deepEqual(planner.calls.at(-1).eligible, ["evidence-update"]);
  assert.equal(next.episode.payload.taskType, "evidence-update");
  const resumed = await service.start(owner, row.id, { expectedRevision: (await service.get(owner, row.id)).revision });
  assert.deepEqual(resumed.payload.taskTypeState, {});
});

test("a stop pauses the agenda in place, spends no episode, and the occurrence is not asked about again", options, async () => {
  const planner = plannerDouble((input, n) => n === 1 ? reply({ taskType: input.eligible[0] })
    : { action: "stop", stopKind: "exhausted", reason: "可查的证据已经用尽", model: "deepseek-flash" });
  const service = new AutopilotService({ documents, jobs, planner, now: () => now });
  const row = await started(service, ["evidence-update"]);
  const first = await service.scheduleDue(owner, row.id);
  let current = await service.get(owner, row.id);
  await service.recordOutcome(owner, row.id, { expectedRevision: current.revision, episodeId: first.episode.id, status: "succeeded", gatedClaims: 1 });
  now = new Date("2026-10-02T07:35:00Z");
  const before = (await database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE user_id=$1 AND kind='episode' AND payload->>'agendaId'=$2", [owner, row.id])).rows[0].n;
  const stopped = await service.scheduleDue(owner, row.id);
  assert.equal(stopped.stopped.kind, "exhausted");
  current = await service.get(owner, row.id);
  assert.equal(current.payload.status, "paused");
  assert.equal(current.payload.plannerStop.reason, "可查的证据已经用尽");
  assert.equal(current.payload.outcomes.length, 1, "history is untouched");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE user_id=$1 AND kind='episode' AND payload->>'agendaId'=$2", [owner, row.id])).rows[0].n, before);
  assert.equal(await service.scheduleDue(owner, row.id), null, "a paused agenda is not scheduled, so the occurrence is not asked about again");
  assert.equal(planner.calls.length, 2);
});

test("the decision is metered under purpose autopilot against the episode it chooses for, and a spent envelope falls back to the rotation", options, async () => {
  const usage = new UsageLedger(database);
  const providerConfig = { deepseekProviderEnabled: true, deepseekApiKey: "provider-key", deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-flash", modelGatewayReservationMaxOutputTokens: 4096, userDailySpendLimit: 0, userWeeklySpendLimit: 0 };
  const fetchImpl = async () => Response.json({ id: "provider-next-action", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    action: "run", taskType: "evidence-update", focus: "核对尚未复核的结论", reason: "上次的结论还没有独立复核" }) } }],
  usage: { prompt_tokens: 900, completion_tokens: 60, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900 } });
  const planner = new AutopilotPlanner(providerConfig, { usageLedger: usage, fetchImpl });
  const service = new AutopilotService({ documents, jobs, usage, planner, now: () => now });
  const row = await started(service);
  const scheduled = await service.scheduleDue(owner, row.id);
  assert.equal(scheduled.episode.payload.selection.source, "model");
  const rows = await database.query("SELECT purpose,run_id,status,project_id,model FROM evimed_usage.model_requests WHERE user_id=$1 ORDER BY created_at", [owner]);
  assert.deepEqual(rows.rows, [{ purpose: "autopilot", run_id: scheduled.episode.id, status: "settled", project_id: "project-test", model: "deepseek-flash" }]);
  const run = await usage.summaryRun(owner, scheduled.episode.id);
  assert.equal(run.calls, 1, "what choosing cost is part of the episode's own price");
  assert.ok(run.actualCost > 0);
  assert.ok(run.actualCost < 0.05, "a decision is fractions of a yuan, not a run");

  // (The gateway reads the wall clock, so the spend is booked on it, whatever day the scheduler thinks it is.)
  // The agenda's own daily cap is half a yuan with five hundredths of a fen left of it: the episode is still admitted, the decision's reservation no longer fits.
  now = new Date("2026-10-02T06:00:00Z");
  let tight = await service.create(owner, { projectId: "project-test", title: "Tight envelope", prompt: "Preserve the full instruction.",
    taskTypes: ["literature-sentinel", "evidence-update"], schedule: { kind: "daily", timeZone: "UTC", time: "07:35" },
    dailyBudgetCny: 0.5, weeklyBudgetCny: 80, maxEpisodeCny: 0.5 });
  tight = await service.start(owner, tight.id, { expectedRevision: tight.revision });
  await usage.recordSettled({ id: randomUUID(), userId: owner, projectId: "project-test", purpose: "kernel", model: "deepseek-flash",
    priceVersion: "test", currency: "CNY", requestFingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
    usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, actualCost: Math.round((0.4999 - run.actualCost) * 1e8) / 1e8, priced: true, now: new Date() });
  now = new Date("2026-10-02T07:35:00Z");
  const refused = await service.scheduleDue(owner, tight.id);
  assert.equal(refused.episode.payload.selection.source, "date-rotation");
  assert.equal(refused.episode.payload.selection.fallbackReason, "usage_budget_exceeded");
  assert.equal(refused.episode.payload.status, "queued", "the research itself is not held back by the decision's budget");
  assert.equal((await usage.summaryRun(owner, refused.episode.id)).calls, 0, "a refused reservation leaves no row");
});
