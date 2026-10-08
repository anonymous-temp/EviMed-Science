// A scheduled task's execution in the researcher's own runtime (R13, E-20), against the real ledger, the real service and the real
// gateway.
//
// A bounded runtime is capped by its token. An execution started inside the researcher's open runtime has no such token, and the
// plan was explicit that "a task episode must never run without a cap". These cases hold the mechanism that replaces the token
// (`autopilotEpisodeScope.mjs`): the cap is the episode's own record, read by the model gateway for every call it attributes to the
// execution's running ledger run — never a marker in the conversation, which would cap what the researcher says next.
//
// Also here, on the same database: canceling one execution on its own — a waiting one, a going one (its run stopped, its result
// folded as canceled), one that is over — and that none of it pauses the task or counts as a failure.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { AutopilotService, agendaRunIds, autopilotAttemptDispatchId } from "../src/autopilotService.mjs";
import { createAutopilotRunScope } from "../src/autopilotEpisodeScope.mjs";
import { createModelGatewayHandler } from "../src/modelGateway.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "Local test Postgres is not configured" };
const owner = `interactive_${randomUUID()}`;
const signingSecret = "test-only-model-gateway-signing-secret-32-bytes";
let database;
let isolated;
let documents;
let jobs;
let usage;
const now = new Date("2026-10-08T08:00:00Z");

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "interactive");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Interactive test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Interactive project',1000000)", [owner]);
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

const planner = { decide: async (/** @type {any} */ input) => ({ action: "run", taskType: input.eligible[0], focus: "核对尚未复核的结论", reason: "ok", model: "deepseek-flash" }) };

async function startedAgenda(/** @type {any} */ service, /** @type {Record<string, any>} */ input = {}) {
  const created = await service.create(owner, { projectId: "project-test", title: "心衰证据", prompt: "每周检索 SGLT2 抑制剂心衰再入院的新证据。",
    taskTypes: ["literature-sentinel"], schedule: { kind: "weekly", timeZone: "UTC", time: "07:35", weekdays: [5] },
    dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 16, ...input });
  return service.start(owner, created.id, { expectedRevision: created.revision });
}

let requests = 0;
const requestId = () => `request-${++requests}`;

async function book(/** @type {{ runId: string, cost: number }} */ { runId, cost }) {
  const id = randomUUID();
  return usage.recordSettled({ id, userId: owner, projectId: "project-test", runId, purpose: "kernel", model: "deepseek-flash", priceVersion: "test", currency: "CNY",
    requestFingerprint: createHash("sha256").update(id).digest("hex"), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 },
    actualCost: cost, priced: true, now });
}

/** The gateway settles a call after the last byte has gone out, so the ledger is read once the settlement has landed. */
async function settled(/** @type {string} */ runId, /** @type {number} */ calls) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const summary = await usage.summaryRun(owner, runId);
    if (summary.settledCalls >= calls) return summary;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return usage.summaryRun(owner, runId);
}

async function listen(/** @type {import("node:http").Server} */ server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
}

test("an execution in the researcher's runtime is held to its own cap by the gateway, booked under its episode, and a later turn of the same conversation is neither", options, async (t) => {
  const service = new AutopilotService({ documents, jobs, usage, planner, now: () => now });
  const agenda = await startedAgenda(service);
  const { episode } = await service.runNow(owner, agenda.id, { requestId: requestId() });
  const runLimit = 2.5;
  await service.markEpisodeDispatched(owner, episode.id, { runId: "run_episode", sessionId: "session_episode", interactive: true, runLimitCny: runLimit });
  const dispatched = (await documents.get(owner, "episode", episode.id)).payload;
  assert.equal(dispatched.interactive, true);
  assert.equal(dispatched.runLimitCny, runLimit);
  assert.equal(dispatched.status, "running");

  // The run ledger as the control plane keeps it: the execution's run, running, in the session the kernel stamps on its calls; and the
  // researcher's conversation, a run of its own once the execution is over.
  /** @type {any[]} */
  let ledger = [{ id: "run_episode", sessionId: "session_episode", status: "running", effectiveRouteReason: "autopilot:literature-sentinel",
    dispatchId: autopilotAttemptDispatchId(episode.id, 1) }];
  const store = { userById: async (/** @type {string} */ id) => ({ id }), requireProject: async (/** @type {any} */ user, /** @type {string} */ id) => ({ userId: user.id, id }) };
  const agentRuns = { list: async () => ledger };
  const runScope = createAutopilotRunScope({ store, agentRuns, service });
  const attributeRun = async (/** @type {{ sessionId?: string | null }} */ { sessionId }) => ledger.find((run) => run.sessionId === sessionId && run.status === "running")?.id ?? null;

  /** @type {any[]} */ const upstreamCalls = [];
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    upstreamCalls.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"p","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":10}}');
  });
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const gateway = createServer(createModelGatewayHandler({
    deepseekApiKey: "test-provider-key", deepseekBaseUrl: upstreamBase, deepseekModel: "deepseek-v4-flash",
    modelGatewayMaxBodyBytes: 64 * 1024, modelGatewayMaxResponseBytes: 1024 * 1024, modelGatewayTimeoutMs: 2_000,
    modelGatewayReservationMaxOutputTokens: 4096, userDailySpendLimit: 0, userWeeklySpendLimit: 0, userRunSpendLimit: 0,
    modelGatewaySigningSecret: signingSecret,
  // An interactive runtime's token names no run.
  }, { assertActiveModelGatewayToken: () => ({ userId: owner, projectId: "project-test" }) }, {
    usageLedger: usage, attributeRun, runPurpose: async () => "kernel", runScope,
  }));
  const gatewayBase = await listen(gateway);
  t.after(() => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(resolve); }));
  const call = (/** @type {string} */ session, /** @type {string} */ content = "Next step.") => fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime", "content-type": "application/json", "x-deepseek-harness-session-id": session },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });

  // The execution's calls are booked under the episode, which is where the task's own caps and the episode's cost read them.
  const first = await call("session_episode");
  assert.equal(first.status, 200, await first.clone().text());
  await first.text();
  const booked = await settled(episode.id, 1);
  assert.equal(booked.settledCalls, 1, "the call is the episode's");
  assert.equal((await usage.summaryRun(owner, "run_episode")).calls, 0, "and not an unnamed run's");
  const task = await usage.spendOfRuns(owner, { runIds: agendaRunIds([episode.id]), now });
  assert.ok(task.day > 0, "so the task's own daily cap counts what its interactive execution spent");

  // The cap: with all but a hair of ¥2.5 already spent under the episode (its planner decision and earlier steps), the next call cannot
  // be reserved — the reservation is part of what the cap is held against.
  await book({ runId: episode.id, cost: 2.49 });
  const before = upstreamCalls.length;
  const refused = await call("session_episode");
  assert.equal(refused.status, 402, "the execution is refused at its own limit");
  const refusal = await refused.json();
  assert.equal(refusal.error.code, "usage_budget_exceeded");
  assert.match(refusal.error.message, /spending limit of this run/);
  assert.equal(upstreamCalls.length, before, "nothing was sent to the provider");

  // A turn the researcher types into the same conversation after the execution ended is another run: not capped, not charged to it.
  ledger = [
    { ...ledger[0], status: "succeeded" },
    { id: "run_chat", sessionId: "session_episode", status: "running", effectiveRouteReason: "unrouted:open-domain", dispatchId: "dispatch-chat" },
  ];
  const spentBefore = (await usage.summaryRun(owner, episode.id)).actualCost;
  const later = await call("session_episode", "再帮我看一下这个结论。");
  assert.equal(later.status, 200, "the researcher's own turn is not held to the execution's cap");
  await later.text();
  assert.equal((await settled("run_chat", 1)).settledCalls, 1, "it is the turn's own run's");
  assert.equal((await usage.summaryRun(owner, episode.id)).actualCost, spentBefore, "and is not charged to the execution");

  // Fail closed: a run the ledger says is a scheduled execution, whose episode cannot be read, is not run.
  ledger = [{ id: "run_orphan", sessionId: "session_orphan", status: "running", effectiveRouteReason: "autopilot:literature-sentinel", dispatchId: "episode-0000000000000000000000000000dead" }];
  const unreadable = await call("session_orphan");
  assert.equal(unreadable.status, 503);
  assert.equal((await unreadable.json()).error.code, "model_gateway_run_scope_unavailable");
  assert.equal(upstreamCalls.length, before + 1, "the provider saw only the researcher's own turn");
});

test("a waiting execution is canceled on its own: its job is canceled, the task keeps its schedule, and asking again changes nothing", options, async () => {
  const service = new AutopilotService({ documents, jobs, usage, planner, now: () => now });
  const agenda = await startedAgenda(service, { title: "排队中的任务" });
  const before = service.projectAgenda(await service.get(owner, agenda.id)).payload;
  const { episode } = await service.runNow(owner, agenda.id, { requestId: requestId() });
  const queued = async () => (await database.query("SELECT status FROM evimed_product.jobs WHERE user_id=$1 AND kind='episode' AND payload->>'episodeId'=$2", [owner, episode.id])).rows.map((row) => row.status);
  assert.deepEqual(await queued(), ["queued"]);

  const canceled = await service.cancelEpisode(owner, agenda.id, episode.id);
  assert.equal(canceled.payload.status, "canceled");
  assert.deepEqual(await queued(), ["canceled"], "nothing will claim it");
  const after = service.projectAgenda(await service.get(owner, agenda.id)).payload;
  assert.equal(after.scheduleState, "scheduled", "this is not a pause");
  assert.equal(after.nextRunAt, before.nextRunAt);
  assert.equal(after.enabled, true);
  assert.equal(after.consecutiveFailures ?? 0, 0, "and not a failure of the task");

  const again = await service.cancelEpisode(owner, agenda.id, episode.id);
  assert.equal(again.revision, canceled.revision, "asking twice is asking once");
  await assert.rejects(() => service.cancelEpisode(owner, agenda.id, "episode-unknown"), { status: 404, code: "autopilot_episode_not_found" });
  const other = await startedAgenda(service, { title: "另一个任务" });
  await assert.rejects(() => service.cancelEpisode(owner, other.id, episode.id), { status: 404, code: "autopilot_episode_not_found" },
    "an execution of another task is not this task's to cancel");
  await assert.rejects(() => service.cancelEpisode(owner, "agenda-unknown", episode.id), { status: 404, code: "autopilot_agenda_not_found" });
});

test("a going execution is stopped through the run's own stop and folds as canceled, with its digest and without pausing the task", options, async () => {
  const service = new AutopilotService({ documents, jobs, usage, planner, now: () => now });
  const agenda = await startedAgenda(service, { title: "进行中的任务" });
  const { episode } = await service.runNow(owner, agenda.id, { requestId: requestId() });
  const runId = `run-${randomUUID()}`;
  await service.markEpisodeDispatched(owner, episode.id, { runId, sessionId: `session-${runId}`, interactive: true, runLimitCny: 4 });

  /** @type {any[]} */ const stopped = [];
  // What the control plane's stop does to the run is end it as the researcher's cancel; the run-finish hook then folds the result
  // into the episode (`completeOwnedAutopilotRun` → `completeRun`). The double does that, in that order.
  const stopRun = async (/** @type {{ runId: string, sessionId: string | null }} */ input) => {
    stopped.push(input);
    await service.completeRun(owner, { projectId: "project-test", runId: input.runId, episodeId: episode.id, sessionId: input.sessionId,
      status: "canceled", artifacts: [], costCny: 0.4 });
  };
  const canceled = await service.cancelEpisode(owner, agenda.id, episode.id, { stopRun });
  assert.deepEqual(stopped, [{ runId, sessionId: `session-${runId}` }], "the run was stopped, once");
  assert.equal(canceled.payload.status, "canceled", "the episode folded as canceled");
  assert.equal(canceled.payload.interactive, true, "and still says where it ran");
  assert.ok(canceled.payload.digestId, "with the briefing every ended execution has");
  const folded = await service.get(owner, agenda.id);
  assert.equal(folded.payload.outcomes.at(-1).status, "canceled");
  assert.equal(folded.payload.consecutiveFailures ?? 0, 0, "a cancel is not a failure, so a task whose executions are canceled by hand is not paused");
  assert.equal(service.projectAgenda(folded).payload.scheduleState, "scheduled");

  // Replayable and idempotent: the reconcile finds nothing to fold again, and a second cancel does not stop anything.
  const settled = await documents.get(owner, "episode", episode.id);
  await service.reconcileStopWork();
  assert.equal((await documents.get(owner, "episode", episode.id)).revision, settled.revision);
  const second = await service.cancelEpisode(owner, agenda.id, episode.id, { stopRun });
  assert.equal(second.revision, settled.revision);
  assert.equal(stopped.length, 1);
});

test("an execution whose agenda is stopped while it is being canceled still ends canceled, and its re-checks end with it", options, async () => {
  const service = new AutopilotService({ documents, jobs, usage, planner, now: () => now });
  const agenda = await startedAgenda(service, { title: "被停止的任务" });
  const { episode } = await service.runNow(owner, agenda.id, { requestId: requestId() });
  const runId = `run-${randomUUID()}`;
  await service.markEpisodeDispatched(owner, episode.id, { runId, sessionId: `session-${runId}`, interactive: false, runLimitCny: 4 });
  // The researcher pauses the whole task in the middle of the cancel: the run stops, and the stop's sweep meets the episode
  // before the run's result has been folded into it.
  const stopRun = async (/** @type {{ runId: string, sessionId: string | null }} */ input) => {
    const latest = await service.get(owner, agenda.id);
    await service.stop(owner, agenda.id, { expectedRevision: latest.revision });
    await service.completeRun(owner, { projectId: "project-test", runId: input.runId, episodeId: episode.id, sessionId: input.sessionId, status: "canceled", artifacts: [], costCny: 0 });
  };
  const result = await service.cancelEpisode(owner, agenda.id, episode.id, { stopRun });
  assert.equal(result.payload.status, "canceled");
  await service.reconcileStopWork();
  assert.equal((await documents.get(owner, "episode", episode.id)).payload.status, "canceled", "the stop's decision stands and nothing is left half-folded");
  assert.equal((await service.get(owner, agenda.id)).payload.status, "stopped");
});
