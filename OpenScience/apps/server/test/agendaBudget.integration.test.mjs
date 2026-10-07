// An agenda's own caps against the real usage ledger (2026-10-04).
//
// On production an ordinary account created a task with ¥1.5 an episode, ¥3 a
// day and ¥6 a week, started it and pressed 立即运行. The answer was HTTP 402
// `usage_budget_exceeded`, "This account reached its spending limit", and the
// task had spent nothing: the account had spent about ¥16 that day on other
// research, and the task's own caps were being compared with that. Each case
// below runs the real scheduling path (`AutopilotService`, `UsageLedger`, the
// product store) with spend booked the way the platform books it — an episode's
// decision and run under the episode's id, a verification under its own — and
// asks what the ledger's two questions refuse and what they let through.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { AutopilotService, verificationIdFor } from "../src/autopilotService.mjs";
import { AutopilotPlanner } from "../src/autopilotNextAction.mjs";
import { callModelForControlPlane } from "../src/modelGateway.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "Local test Postgres is not configured" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const owner = `agendabudget_${randomUUID()}`;
let database;
let isolated;
let documents;
let jobs;
let usage;
/** The scheduler's clock, and the ledger's: spend is booked at the instant the test says it was made. */
let now = new Date("2026-10-04T08:00:00Z");

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "agendabudget");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Agenda budget test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Agenda budget project',1000000),($1,'project-other','Other project',1000000)", [owner]);
  documents = new ProductDocuments(database);
  jobs = new ProductJobs(database);
  usage = new UsageLedger(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

/** A planner that answers from the first eligible type and records what it was asked. */
function plannerDouble() {
  const calls = [];
  return { calls, decide: async (input) => {
    calls.push(input);
    return { action: "run", taskType: input.eligible[0], focus: "核对尚未复核的结论", reason: "上次的结论还没有独立复核", model: "deepseek-flash" };
  } };
}

/** Book one settled model call, the way a run's gateway does. */
async function spend(userId, { runId = null, projectId = "project-test", purpose = "kernel", cost, at = now }) {
  const id = randomUUID();
  return usage.recordSettled({ id, userId, projectId, runId, purpose, model: "deepseek-flash", priceVersion: "test", currency: "CNY",
    requestFingerprint: createHash("sha256").update(id).digest("hex"), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 },
    actualCost: cost, priced: true, now: at });
}

/** A fresh account of its own (the windows are per account), its project and a service on the shared clock. */
async function account(label, { caps = {}, planner = plannerDouble() } = {}) {
  const userId = `${owner}_${label}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,$2,'development')", [userId, label]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Project',1000000),($1,'project-other','Other',1000000)", [userId]);
  const service = new AutopilotService({ documents, jobs, usage, planner, accountCaps: () => caps, now: () => now });
  return { userId, service, planner };
}

async function started(service, userId, input = {}) {
  const created = await service.create(userId, { projectId: "project-test", title: "Budget", prompt: "Preserve the full instruction.",
    taskTypes: ["literature-sentinel", "evidence-update"], schedule: { kind: "daily", timeZone: "UTC", time: "07:35" },
    dailyBudgetCny: 3, weeklyBudgetCny: 6, maxEpisodeCny: 1.5, ...input });
  return service.start(userId, created.id, { expectedRevision: created.revision });
}

let requests = 0;
const requestId = () => `request-${++requests}`;

test("the incident: ¥16 spent on other research today does not touch an agenda of ¥3 a day that has spent nothing", options, async () => {
  now = new Date("2026-10-04T08:00:00Z");
  const { userId, service } = await account("incident");
  // The account's other research that day: virtual-clinical-research runs in another project, and a conversation in this one.
  await spend(userId, { projectId: "project-other", runId: "run-vcr-study", cost: 10, at: new Date(now.getTime() - 3 * HOUR) });
  await spend(userId, { runId: "run-conversation", cost: 6, at: new Date(now.getTime() - 1 * HOUR) });
  assert.equal((await usage.summary(userId, { since: new Date(now.getTime() - DAY) })).actualCost, 16);
  const agenda = await started(service, userId);

  const { episode } = await service.runNow(userId, agenda.id, { requestId: requestId() });
  assert.equal(episode.payload.status, "queued", "the episode is created");
  assert.equal(episode.payload.selection.source, "model", "and its planner decision was made, not fallen back from");
  const job = (await database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='episode'", [userId])).rows[0];
  assert.equal(job.payload.episodeId, episode.id);
  assert.equal(episode.payload.budgetCny + episode.payload.verificationBudgetCny * 3, 1.5, "funded with the episode's cap, as if the account had spent nothing");
});

test("the real planner is metered under the episode and bounded by its envelope, not refused by the account's other spend", options, async () => {
  now = new Date("2026-10-04T08:00:00Z");
  const providerConfig = { deepseekProviderEnabled: true, deepseekApiKey: "provider-key", deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-flash", modelGatewayReservationMaxOutputTokens: 4096, userDailySpendLimit: 0, userWeeklySpendLimit: 0 };
  const fetchImpl = async () => Response.json({ id: "provider-budget", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    action: "run", taskType: "evidence-update", focus: "核对尚未复核的结论", reason: "上次的结论还没有独立复核" }) } }],
  usage: { prompt_tokens: 900, completion_tokens: 60, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900 } });
  const planner = new AutopilotPlanner(providerConfig, { usageLedger: usage, fetchImpl });
  const { userId, service } = await account("planner", { planner });
  await spend(userId, { runId: "run-vcr-study", cost: 16, at: new Date() });
  const agenda = await started(service, userId, { dailyBudgetCny: 3, weeklyBudgetCny: 6, maxEpisodeCny: 1.5 });
  const { episode } = await service.runNow(userId, agenda.id, { requestId: requestId() });
  assert.equal(episode.payload.selection.source, "model", "with ¥16 spent the decision was still had: the agenda's ¥3 was not compared with it");
  const rows = (await database.query("SELECT purpose,run_id,status FROM evimed_usage.model_requests WHERE user_id=$1 AND purpose='autopilot'", [userId])).rows;
  assert.deepEqual(rows, [{ purpose: "autopilot", run_id: episode.id, status: "settled" }], "booked under the episode, so it is the agenda's own spend");
  const own = await usage.spendOfRuns(userId, { runIds: [episode.id], now: new Date() });
  assert.ok(own.day > 0 && own.day < 0.05 && own.day === own.week, "what choosing cost is the agenda's own, a fraction of a yuan");
});

test("an agenda whose own episodes spent its daily cap is refused as the task's budget, and runs again when the window has passed", options, async () => {
  now = new Date("2026-10-04T08:00:00Z");
  const { userId, service, planner } = await account("daily");
  const agenda = await started(service, userId);
  const first = await service.runNow(userId, agenda.id, { requestId: requestId() });
  const second = await service.runNow(userId, agenda.id, { requestId: requestId() });
  // The first spent ¥1.5 at 08:00; the second ¥1.0 at 10:00 and ¥0.5 on its one verification at 11:00.
  await spend(userId, { runId: first.episode.id, cost: 1.5 });
  await spend(userId, { runId: second.episode.id, cost: 1, at: new Date(now.getTime() + 2 * HOUR) });
  await spend(userId, { runId: verificationIdFor(second.episode.id, 0), cost: 0.5, at: new Date(now.getTime() + 3 * HOUR) });
  const decisions = planner.calls.length;

  now = new Date("2026-10-04T12:00:00Z");
  await assert.rejects(() => service.runNow(userId, agenda.id, { requestId: requestId() }), (error) => {
    assert.equal(error.status, 402);
    assert.equal(error.code, "autopilot_daily_budget_spent", "the task's budget, named as such — not usage_budget_exceeded, the account's");
    assert.match(error.message, /This task's own daily budget is spent: CNY 3\.00 of CNY 3\.00/);
    // The ¥1.5 from 08:00 leaves the day window at 08:00 tomorrow (+ the minute the bucket may be early by): a fundable cent of room.
    assert.equal(error.retryAfterSeconds, 20 * 3600 + 60);
    return true;
  });
  assert.equal(planner.calls.length, decisions, "no decision was paid for by a refused request");
  await assert.rejects(() => service.followUp(userId, agenda.id, { requestId: requestId(), note: "再查肾病亚组" }), { code: "autopilot_daily_budget_spent" });
  await assert.rejects(() => service.schedule(userId, agenda.id, { date: "2026-10-04" }), { code: "autopilot_daily_budget_spent" });

  // 08:02 tomorrow: the first episode's spend has left the rolling day, ¥1.5 is open again — and the week still has ¥3.
  now = new Date("2026-10-05T08:02:00Z");
  const again = await service.runNow(userId, agenda.id, { requestId: requestId() });
  assert.equal(again.episode.payload.status, "queued");
  assert.equal(planner.calls.at(-1).envelopeCny, 1.5, "¥1.5 of room, and the episode's cap is ¥1.5");
  // Both windows spent (¥3 in the day, ¥6 in the week): the week is the one named, since it frees later.
  now = new Date("2026-10-06T07:00:00Z");
  await spend(userId, { runId: again.episode.id, cost: 3, at: now });
  now = new Date("2026-10-06T07:30:00Z");
  await assert.rejects(() => service.runNow(userId, agenda.id, { requestId: requestId() }), { code: "autopilot_weekly_budget_spent" });
});

test("a refusal says when it frees, and the moment it said is the first at which a cent of room exists", options, async () => {
  now = new Date("2026-10-04T08:00:00Z");
  const { userId, service } = await account("frees");
  const agenda = await started(service, userId);
  const { episode } = await service.runNow(userId, agenda.id, { requestId: requestId() });
  await spend(userId, { runId: episode.id, cost: 2, at: new Date("2026-10-04T08:00:30Z") });
  await spend(userId, { runId: episode.id, cost: 1, at: new Date("2026-10-04T10:00:30Z") });
  now = new Date("2026-10-04T12:00:00Z");
  const error = await service.runNow(userId, agenda.id, { requestId: requestId() }).then(() => null, (caught) => caught);
  assert.equal(error.code, "autopilot_daily_budget_spent");
  const freesAt = new Date(now.getTime() + error.retryAfterSeconds * 1000);
  // The ¥2 made at 08:00:30 leaves at 08:00:30 tomorrow; the promise is the next minute boundary after that.
  assert.equal(freesAt.toISOString(), "2026-10-05T08:01:00.000Z");
  now = new Date("2026-10-05T08:00:30Z");
  await service.runNow(userId, agenda.id, { requestId: requestId() }).then(() => assert.fail("the second the spend leaves is not yet the promise; refused is acceptable"), () => {});
  now = freesAt;
  const allowed = await service.runNow(userId, agenda.id, { requestId: requestId() });
  assert.equal(allowed.episode.payload.status, "queued", "at the time it said, the same request goes through");
});

test("the weekly cap refuses as the week's budget and frees by the rolling seven days", options, async () => {
  now = new Date("2026-10-01T08:00:00Z");
  const { userId, service } = await account("weekly");
  const agenda = await started(service, userId);
  const first = await service.runNow(userId, agenda.id, { requestId: requestId() });
  await spend(userId, { runId: first.episode.id, cost: 3 });
  now = new Date("2026-10-02T09:00:00Z"); // 25 hours later: the day's window has let the first go, the week's has not
  const second = await service.runNow(userId, agenda.id, { requestId: requestId() });
  await spend(userId, { runId: second.episode.id, cost: 3 });
  now = new Date("2026-10-03T09:00:00Z"); // the day window is clear of both; the week holds ¥6 of ¥6
  const error = await service.runNow(userId, agenda.id, { requestId: requestId() }).then(() => null, (caught) => caught);
  assert.equal(error.status, 402);
  assert.equal(error.code, "autopilot_weekly_budget_spent");
  assert.match(error.message, /weekly budget is spent: CNY 6\.00 of CNY 6\.00 in the last 7 days/);
  // The first ¥3 leaves the week at 08:00 on the 8th; the day's cap was never the thing in the way.
  assert.equal(new Date(Date.parse("2026-10-03T09:00:00Z") + error.retryAfterSeconds * 1000).toISOString(), "2026-10-08T08:01:00.000Z");
  now = new Date("2026-10-08T08:02:00Z");
  const again = await service.runNow(userId, agenda.id, { requestId: requestId() });
  assert.equal(again.episode.payload.status, "queued", "seven days after the first spend the week has ¥3 of room");
});

test("what is left bounds the next episode: the envelope is the smaller of its cap and the agenda's room", options, async () => {
  now = new Date("2026-10-04T08:00:00Z");
  const { userId, service, planner } = await account("envelope");
  const agenda = await started(service, userId);
  const first = await service.runNow(userId, agenda.id, { requestId: requestId() });
  await spend(userId, { runId: first.episode.id, cost: 1.7 });
  const tight = await service.runNow(userId, agenda.id, { requestId: requestId() });
  assert.equal(planner.calls.at(-1).envelopeCny, 1.3, "¥1.30 of the day is left, less than the ¥1.50 an episode may spend, and enough for a run");
  assert.ok(tight.episode.payload.budgetCny + tight.episode.payload.verificationBudgetCny * 3 <= 1.3 + 1e-9);
  // Less than a run needs is a spent day, refused as the task's (the account has spent nothing here).
  await spend(userId, { runId: tight.episode.id, cost: 0.2 });
  const spentDay = await service.runNow(userId, agenda.id, { requestId: requestId() }).then(() => null, (caught) => caught);
  assert.equal(spentDay.code, "autopilot_daily_budget_spent", "¥1.10 left cannot make a model call: the day is spent");
});

test("an account cap is the account's, refused as the account's, whatever the agenda has left", options, async () => {
  now = new Date("2026-10-04T08:00:00Z");
  const { userId, service } = await account("account", { caps: { userDailySpendLimit: 10, userWeeklySpendLimit: 0 } });
  await spend(userId, { projectId: "project-other", runId: "run-vcr-study", cost: 16, at: new Date(now.getTime() - HOUR) });
  const agenda = await started(service, userId);
  const error = await service.runNow(userId, agenda.id, { requestId: requestId() }).then(() => null, (caught) => caught);
  assert.equal(error.status, 402);
  assert.equal(error.code, "usage_budget_exceeded", "the account's code and sentence: the account is what is over");
  assert.match(error.message, /This account reached its spending limit/);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE user_id=$1 AND kind='episode'", [userId])).rows[0].n, 0);
  // An account cap with room lets the agenda through, and its own caps still count the agenda's own spend only.
  const roomy = await account("account-roomy", { caps: { userDailySpendLimit: 100, userWeeklySpendLimit: 100 } });
  await spend(roomy.userId, { runId: "run-vcr-study", cost: 16, at: new Date(now.getTime() - HOUR) });
  const open = await started(roomy.service, roomy.userId);
  assert.equal((await roomy.service.runNow(roomy.userId, open.id, { requestId: requestId() })).episode.payload.status, "queued");
});

test("the walk: every budget field of an agenda is compared with the sum it is about, and the account's spend moves none of them", options, async () => {
  const cases = [];
  /** @param {string} field @param {string} compared @param {() => Promise<void>} run */
  const check = async (field, compared, run) => { await run(); cases.push([field, compared]); };

  // The account has spent ¥16 today and ¥30 this week on other research, in every case below.
  async function withAccountSpend(label, input, caps = {}) {
    now = new Date("2026-10-04T08:00:00Z");
    const fixture = await account(`walk-${label}`, { caps });
    await spend(fixture.userId, { projectId: "project-other", runId: "run-vcr-study", cost: 16, at: new Date(now.getTime() - 2 * HOUR) });
    await spend(fixture.userId, { projectId: "project-other", runId: "run-vcr-earlier", cost: 14, at: new Date(now.getTime() - 3 * DAY) });
    const agenda = await started(fixture.service, fixture.userId, input);
    return { ...fixture, agenda };
  }
  const refusal = (fixture) => fixture.service.runNow(fixture.userId, fixture.agenda.id, { requestId: requestId() }).then(() => null, (caught) => caught);

  await check("dailyBudgetCny", "this agenda's own spend in the last 24 hours — spent", async () => {
    const f = await withAccountSpend("daily-spent", { dailyBudgetCny: 3, weeklyBudgetCny: 60, maxEpisodeCny: 1.5 });
    const { episode } = await f.service.runNow(f.userId, f.agenda.id, { requestId: requestId() });
    await spend(f.userId, { runId: episode.id, cost: 3 });
    assert.equal((await refusal(f))?.code, "autopilot_daily_budget_spent");
  });
  await check("dailyBudgetCny", "this agenda's own spend in the last 24 hours — unspent, whatever the account spent", async () => {
    const f = await withAccountSpend("daily-open", { dailyBudgetCny: 3, weeklyBudgetCny: 60, maxEpisodeCny: 1.5 });
    assert.equal(await refusal(f), null);
  });
  await check("weeklyBudgetCny", "this agenda's own spend in the last 7 days — spent", async () => {
    const f = await withAccountSpend("weekly-spent", { dailyBudgetCny: 3, weeklyBudgetCny: 6, maxEpisodeCny: 1.5 });
    const { episode } = await f.service.runNow(f.userId, f.agenda.id, { requestId: requestId() });
    await spend(f.userId, { runId: episode.id, cost: 6, at: new Date(now.getTime() - 2 * DAY) });
    assert.equal((await refusal(f))?.code, "autopilot_weekly_budget_spent");
  });
  await check("weeklyBudgetCny", "this agenda's own spend in the last 7 days — unspent, whatever the account spent (¥30)", async () => {
    const f = await withAccountSpend("weekly-open", { dailyBudgetCny: 3, weeklyBudgetCny: 6, maxEpisodeCny: 1.5 });
    assert.equal(await refusal(f), null);
  });
  await check("maxEpisodeCny", "one episode's own funding — never a window", async () => {
    const f = await withAccountSpend("episode", { dailyBudgetCny: 30, weeklyBudgetCny: 60, maxEpisodeCny: 2 });
    const { episode } = await f.service.runNow(f.userId, f.agenda.id, { requestId: requestId() });
    assert.equal(episode.payload.budgetCny + episode.payload.verificationBudgetCny * 3, 2);
    assert.equal(f.planner.calls.at(-1).envelopeCny, 2);
  });
  await check("userDailySpendLimit", "everything the account spent in the last 24 hours (¥16)", async () => {
    const f = await withAccountSpend("account-day", { dailyBudgetCny: 30, weeklyBudgetCny: 60, maxEpisodeCny: 1.5 }, { userDailySpendLimit: 16, userWeeklySpendLimit: 0 });
    assert.equal((await refusal(f))?.code, "usage_budget_exceeded");
  });
  await check("userWeeklySpendLimit", "everything the account spent in the last 7 days (¥30)", async () => {
    const f = await withAccountSpend("account-week", { dailyBudgetCny: 30, weeklyBudgetCny: 60, maxEpisodeCny: 1.5 }, { userDailySpendLimit: 0, userWeeklySpendLimit: 30 });
    assert.equal((await refusal(f))?.code, "usage_budget_exceeded");
  });
  // The walk walked: five distinct fields, and each of the agenda's three met a sum that is the agenda's own.
  assert.equal(cases.length, 7);
  assert.deepEqual([...new Set(cases.map(([field]) => field))].sort(), ["dailyBudgetCny", "maxEpisodeCny", "userDailySpendLimit", "userWeeklySpendLimit", "weeklyBudgetCny"]);
});

test("a task's spend is counted as the ledger counts an account's: open reservations at their ceiling, lost calls at their bound, uncapped purposes and other runs not at all", options, async () => {
  now = new Date("2026-10-04T08:00:00Z");
  const userId = `${owner}_arith`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'arith','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Project',1000000)", [userId]);
  const run = "episode-" + "a".repeat(32);
  const verification = verificationIdFor(run, 1);
  await spend(userId, { runId: run, cost: 1, at: new Date(now.getTime() - 2 * HOUR) });            // in the day
  await spend(userId, { runId: run, cost: 2, at: new Date(now.getTime() - 3 * DAY) });             // in the week, not the day
  await spend(userId, { runId: run, cost: 9, at: new Date(now.getTime() - 8 * DAY) });             // in neither
  await spend(userId, { runId: verification, cost: 0.25, at: new Date(now.getTime() - HOUR) });    // the verification's
  await spend(userId, { runId: run, purpose: "engine", cost: 50, at: new Date(now.getTime() - HOUR) }); // a purpose no cap counts
  await spend(userId, { runId: "episode-" + "b".repeat(32), cost: 70, at: new Date(now.getTime() - HOUR) }); // another agenda's
  const open = await usage.reserveModel({ id: randomUUID(), userId, projectId: "project-test", runId: run, purpose: "kernel", model: "deepseek-flash",
    priceVersion: "test", currency: "CNY", requestFingerprint: createHash("sha256").update("open").digest("hex"), estimatedCost: 0.75, now });
  const lost = await usage.reserveModel({ id: randomUUID(), userId, projectId: "project-test", runId: run, purpose: "kernel", model: "deepseek-flash",
    priceVersion: "test", currency: "CNY", requestFingerprint: createHash("sha256").update("lost").digest("hex"), estimatedCost: 0.5, now });
  await usage.markUncertain(userId, lost.id, "provider_response_incomplete", { estimatedCost: 0.125 });
  const released = await usage.reserveModel({ id: randomUUID(), userId, projectId: "project-test", runId: run, purpose: "kernel", model: "deepseek-flash",
    priceVersion: "test", currency: "CNY", requestFingerprint: createHash("sha256").update("released").digest("hex"), estimatedCost: 4, now });
  await usage.release(userId, released.id, "provider_not_accepted");
  assert.ok(open.id);

  const runIds = [run, verification];
  const day = 1 + 0.25 + 0.75 + 0.125;
  const week = day + 2;
  const spent = await usage.spendOfRuns(userId, { runIds, now });
  assert.deepEqual([spent.day, spent.week], [day, week]);
  assert.deepEqual(await usage.spendOfRuns(userId, { runIds: [], now }), { day: 0, week: 0 }, "no runs, no spend, no query");
  // Counted as the account's own windows count it: the same rows, asked of the account's admission check, refuse at the same figure.
  // (The account's sum here is the task's plus what the other run and the engine purpose added, which the admission check
  // counts for the other run and not for the engine; `purposes` narrows nothing — it is the run set that does.)
  const timeline = await usage.spendTimelineOfRuns(userId, { runIds, now });
  assert.equal(Math.round(timeline.reduce((sum, entry) => sum + entry.cost, 0) * 1e6) / 1e6, week, "the timeline is the week's spend, minute by minute");
  assert.deepEqual(timeline.map((entry) => entry.at), [...timeline.map((entry) => entry.at)].sort(), "oldest first");
  assert.equal(timeline[0].at, new Date(Math.floor((now.getTime() - 3 * DAY) / 60_000) * 60_000).toISOString());
  assert.ok(timeline.every((entry) => Date.parse(entry.at) >= now.getTime() - 7 * DAY));
  // Another account never sees these rows even when it names the same run.
  assert.deepEqual(await usage.spendOfRuns(owner, { runIds, now }), { day: 0, week: 0 });
});

test("the model gateway holds a control-plane call to its run's envelope and only its run's", options, async () => {
  const userId = `${owner}_gateway`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'gateway','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Project',1000000)", [userId]);
  const config = { deepseekProviderEnabled: true, deepseekApiKey: "provider-key", deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-flash", modelGatewayReservationMaxOutputTokens: 4096, userDailySpendLimit: 0, userWeeklySpendLimit: 0 };
  const fetchImpl = async () => Response.json({ id: "provider-gateway", choices: [{ finish_reason: "stop", message: { content: "{}" } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } });
  const call = (runId, limits) => callModelForControlPlane({ config, usageLedger: usage, fetchImpl }, {
    userId, projectId: "project-test", runId, purpose: "autopilot", limits,
    body: { model: "deepseek-flash", max_tokens: 800, messages: [{ role: "user", content: "x".repeat(2000) }] } });
  // The account spent ¥50 elsewhere: a run envelope is not that sum.
  await spend(userId, { runId: "run-elsewhere", cost: 50, at: new Date() });
  await call("episode-" + "c".repeat(32), { daily: 0, weekly: 0, run: 0.05 });
  await assert.rejects(() => call("episode-" + "d".repeat(32), { daily: 0, weekly: 0, run: 0.0001 }), (error) => {
    assert.equal(error.code, "usage_budget_exceeded");
    assert.equal(error.details?.window, "run", "the run's own envelope, named as such");
    return true;
  });
  // Without an envelope the call is bounded by the account's caps only, as ever.
  await call("episode-" + "e".repeat(32), { daily: 0, weekly: 0 });
});
