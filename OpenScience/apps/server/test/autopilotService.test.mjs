import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AutopilotService } from "../src/autopilotService.mjs";
import { AutopilotWorker } from "../src/autopilotWorker.mjs";
import { createAutopilotRoutes } from "../src/autopilotRoutes.mjs";
import { HttpError, sendError } from "../src/security.mjs";

class MemoryDocuments {
  constructor() { this.rows = new Map(); }
  key(userId, kind, id) { return `${userId}:${kind}:${id}`; }
  async get(userId, kind, id) { return this.rows.get(this.key(userId, kind, id)) ?? null; }
  async list(userId, kind, { projectId, filter = {} } = {}) {
    const items = [...this.rows.values()].filter((row) => row.userId === userId && row.kind === kind
      && (projectId === undefined || row.projectId === projectId)
      && Object.entries(filter).every(([key, value]) => row.payload[key] === value));
    return { items, nextCursor: null };
  }
  async put(userId, kind, id, payload, { expectedRevision, projectId = null }) {
    const key = this.key(userId, kind, id);
    const current = this.rows.get(key);
    if ((current?.revision ?? 0) !== expectedRevision) { const error = new Error("conflict"); error.code = "product_revision_conflict"; throw error; }
    const row = { id, kind, userId, projectId, payload, revision: expectedRevision + 1,
      createdAt: current?.createdAt ?? "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
    this.rows.set(key, row); return row;
  }
}

class MemoryJobs {
  constructor() { this.items = []; }
  async enqueue(userId, kind, payload, options) {
    const existing = this.items.find((item) => item.userId === userId && item.options.idempotencyKey === options.idempotencyKey);
    if (existing) return existing;
    const job = { id: `job-${this.items.length + 1}`, userId, kind, payload, options, status: "queued" };
    this.items.push(job); return job;
  }
}

function fixture({ notificationCreate = null, now = () => new Date("2026-09-06T01:00:00.000Z") } = {}) {
  const documents = new MemoryDocuments();
  const jobs = new MemoryJobs();
  const usage = { assertWithinLimits: async () => ({ allowed: true }) };
  const notifications = { created: [], create: async (userId, input) => {
    if (notificationCreate) return notificationCreate(userId, input, notifications);
    notifications.created.push({ userId, input });
  } };
  const service = new AutopilotService({ documents, jobs, usage, notifications,
    now, id: (() => { let i = 0; return (prefix) => `${prefix}${++i}`; })() });
  return { documents, jobs, usage, notifications, service };
}

const agendaInput = {
  projectId: "project-one", title: "心衰证据追踪", topics: ["heart failure", "SGLT2"],
  taskTypes: ["literature-sentinel", "evidence-update"], dailyBudgetCny: 20, weeklyBudgetCny: 80,
  maxEpisodeCny: 8, scheduleHour: 1, timeZone: "Asia/Shanghai",
};

test("opening an owned digest records reading without treating list or get as activity", async () => {
  let at = new Date("2026-09-06T01:00:00Z");
  const { service } = fixture({ now: () => at });
  const agenda = await service.create("user-one", agendaInput);
  const digest = await service.createDigest("user-one", agenda.id, {
    date: "2026-09-06", episodeIds: ["episode-read"], costCny: 0, claims: [],
  });
  const before = await service.get("user-one", agenda.id);
  assert.equal(before.payload.lastDigestOpenedAt, null, "creating an agenda is not a digest read");
  at = new Date("2026-09-12T01:00:00Z");
  await service.listDigests("user-one", { projectId: agenda.projectId });
  await service.getDigest("user-one", digest.id);
  assert.equal((await service.get("user-one", agenda.id)).payload.lastDigestOpenedAt, before.payload.lastDigestOpenedAt);
  assert.equal((await service.getDigest("user-one", digest.id)).payload.openedAt, null);
  await assert.rejects(() => service.markDigestOpened("other-user", digest.id), { code: "autopilot_digest_not_found" });
  const opened = await service.markDigestOpened("user-one", digest.id);
  assert.equal(opened.payload.openedAt, at.toISOString());
  assert.equal((await service.get("user-one", agenda.id)).payload.lastDigestOpenedAt, at.toISOString());
});

test("the real digest route and service use the digest's project and persist explicit viewing", async (t) => {
  let at = new Date("2026-09-06T01:00:00Z");
  const { service } = fixture({ now: () => at });
  const agenda = await service.create("user-one", agendaInput);
  const digest = await service.createDigest("user-one", agenda.id, { date: "2026-09-06", episodeIds: ["episode-route"], costCny: 0, claims: [] });
  const route = createAutopilotRoutes({ service, maxJsonBytes: 8192, store: {
    ensureSessionUser: async (req) => ({ user: { id: req.headers["x-test-user"] } }),
    assertCsrf: async () => {},
    requireProject: async (_user, id) => {
      if (id !== "project-one") throw new HttpError(404, "project_not_found", "Project unavailable.");
    },
  } });
  const server = createServer((req, res) => route(req, res).catch((error) => sendError(res, error)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/autopilot/digests/${digest.id}`;
  const headers = { "x-test-user": "user-one", "x-open-science-project-id": "another-project", "content-type": "application/json" };
  at = new Date("2026-09-12T01:00:00Z");
  const loaded = await fetch(endpoint, { headers });
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).data.projectId, "project-one");
  assert.equal((await service.get("user-one", agenda.id)).payload.lastDigestOpenedAt, null);
  assert.equal((await fetch(`${endpoint}/opened`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal((await service.getDigest("user-one", digest.id)).payload.openedAt, at.toISOString());
  assert.equal((await service.get("user-one", agenda.id)).payload.lastDigestOpenedAt, at.toISOString());
  assert.equal((await fetch(`${endpoint}/opened`, { method: "POST", headers: { ...headers, "x-test-user": "other-user" }, body: "{}" })).status, 404);
});

test("an interrupted digest activity update can be retried without losing intervening decisions", async () => {
  const { service, documents } = fixture();
  const agenda = await service.create("user-one", agendaInput);
  const digest = await service.createDigest("user-one", agenda.id, {
    date: "2026-09-06", episodeIds: ["episode-retry"], costCny: 0,
    claims: [{ id: "claim-one", statement: "A finding", tier: "unverified", type: "direct" }],
  });
  const put = documents.put.bind(documents);
  let interrupted = false;
  documents.put = async (...args) => {
    if (args[1] === "agenda" && !interrupted) { interrupted = true; throw new Error("database unavailable"); }
    return put(...args);
  };
  await assert.rejects(() => service.markDigestOpened("user-one", digest.id), /database unavailable/);
  await service.decide("user-one", digest.id, { action: "adopt", claimId: "claim-one" });
  const opened = await service.markDigestOpened("user-one", digest.id);
  assert.equal(opened.payload.decisions.length, 1);
  assert.equal(opened.payload.openedAt, (await service.get("user-one", agenda.id)).payload.lastDigestOpenedAt);
});

test("activity retries preserve a concurrent stop and a newer open timestamp", async () => {
  const { service, documents } = fixture();
  const agenda = await service.create("user-one", agendaInput);
  const digest = await service.createDigest("user-one", agenda.id, { date: "2026-09-06", episodeIds: ["episode-one"], costCny: 0, claims: [] });
  const put = documents.put.bind(documents);
  let conflicted = false;
  documents.put = async (...args) => {
    if (args[1] === "agenda" && !conflicted) {
      conflicted = true;
      const current = await service.get("user-one", agenda.id);
      await put("user-one", "agenda", agenda.id, { ...current.payload, enabled: false, status: "stopped",
        lastDigestOpenedAt: "2026-09-06T02:00:00.000Z" }, { expectedRevision: current.revision, projectId: agenda.projectId });
    }
    return put(...args);
  };
  await service.markDigestOpened("user-one", digest.id);
  const current = await service.get("user-one", agenda.id);
  assert.equal(current.payload.lastDigestOpenedAt, "2026-09-06T02:00:00.000Z");
  assert.equal(current.payload.status, "stopped");
  assert.equal(current.payload.enabled, false);
});

test("seven days without reading pauses before scheduling or checking the spending allowance", async () => {
  let at = new Date("2026-09-06T01:00:00Z");
  const { service, jobs, usage } = fixture({ now: () => at });
  const agenda = await service.create("user-one", agendaInput);
  const active = await service.start("user-one", agenda.id, { expectedRevision: agenda.revision });
  let allowances = 0;
  usage.assertWithinLimits = async () => { allowances++; };
  at = new Date("2026-09-13T01:00:00Z");
  await assert.rejects(() => service.schedule("user-one", active.id, { date: "2026-09-13" }), { code: "autopilot_paused" });
  assert.equal(allowances, 0);
  assert.equal(jobs.items.length, 0);
  assert.equal((await service.get("user-one", agenda.id)).payload.status, "paused");
});

test("the real worker and service stop a queued episode that becomes inactive before dispatch", async () => {
  let at = new Date("2026-09-06T01:00:00Z");
  const { service, jobs } = fixture({ now: () => at });
  const agenda = await service.create("user-one", agendaInput);
  await service.start("user-one", agenda.id, { expectedRevision: agenda.revision });
  const scheduled = await service.schedule("user-one", agenda.id, { date: "2026-09-06" });
  at = new Date("2026-09-13T01:00:00Z");
  let dispatched = 0;
  let result;
  const worker = new AutopilotWorker({ service, jobs: {
    claim: async () => ({ ...scheduled.job, projectId: agenda.projectId, leaseToken: "lease", attempts: 1 }),
    renew: async () => true,
    finish: async (_user, _id, _lease, value) => { result = value; },
    fail: async () => assert.fail("inactivity must settle the queued job without a retry or failed episode"),
  }, dispatchEpisode: async () => { dispatched++; return { runId: "run", sessionId: "session" }; } });
  await worker.tick();
  assert.equal(dispatched, 0, "runtime and billing reservation must never start");
  assert.equal(result?.skipped, true);
  assert.equal((await service.get("user-one", agenda.id)).payload.status, "paused");
  assert.equal(jobs.items.length, 1);
});

test("a real digest open extends the window while explicit resume does not invent a read", async () => {
  let at = new Date("2026-09-06T01:00:00Z");
  const { service } = fixture({ now: () => at });
  const agenda = await service.create("user-one", agendaInput);
  await service.start("user-one", agenda.id, { expectedRevision: agenda.revision });
  const digest = await service.createDigest("user-one", agenda.id, { date: "2026-09-06", episodeIds: ["episode-one"], costCny: 0, claims: [] });
  at = new Date("2026-09-12T01:00:00Z");
  await service.markDigestOpened("user-one", digest.id);
  at = new Date("2026-09-13T01:00:00Z");
  assert.ok(await service.schedule("user-one", agenda.id, { date: "2026-09-13" }));
  at = new Date("2026-09-19T01:00:00Z");
  await assert.rejects(() => service.schedule("user-one", agenda.id, { date: "2026-09-19" }), { code: "autopilot_paused" });
  const paused = await service.get("user-one", agenda.id);
  await service.start("user-one", agenda.id, { expectedRevision: paused.revision });
  assert.equal((await service.get("user-one", agenda.id)).payload.lastDigestOpenedAt, "2026-09-12T01:00:00.000Z");
  assert.ok(await service.schedule("user-one", agenda.id, { date: "2026-09-19" }));
});

test("an agenda is persistent, bounded and disabled until the user starts it", async () => {
  const { service } = fixture();
  const agenda = await service.create("user-one", agendaInput);
  assert.equal(agenda.payload.enabled, false);
  assert.equal(agenda.payload.status, "paused");
  assert.deepEqual(agenda.payload.taskTypes, agendaInput.taskTypes);
  assert.equal(agenda.payload.maxEpisodeCny, 8);
  await assert.rejects(() => service.create("user-one", { ...agendaInput, maxEpisodeCny: 21 }),
    (error) => error.code === "autopilot_budget_invalid");
});

test("starting and scheduling creates one idempotent bounded episode per day", async () => {
  const { service, jobs } = fixture();
  const created = await service.create("user-one", agendaInput);
  const active = await service.start("user-one", created.id, { expectedRevision: created.revision });
  const first = await service.schedule("user-one", active.id, { date: "2026-09-06" });
  const second = await service.schedule("user-one", active.id, { date: "2026-09-06" });
  assert.equal(first.episode.id, second.episode.id);
  assert.equal(jobs.items.filter((job) => job.kind === "episode").length, 1);
  assert.equal(first.episode.payload.budgetCny <= active.payload.maxEpisodeCny, true);
  assert.equal(first.episode.payload.status, "queued");
  assert.ok(first.episode.payload.prompt.includes("heart failure"));
  assert.ok(first.episode.payload.prompt.includes(`Episode ID: ${first.episode.id}.`));
});

test("inactivity, repeated failure and the stop switch prevent further spending", async () => {
  const { service, jobs } = fixture();
  const created = await service.create("user-one", agendaInput);
  let agenda = await service.start("user-one", created.id, { expectedRevision: created.revision });
  agenda = await service.recordOutcome("user-one", agenda.id, {
    expectedRevision: agenda.revision, episodeId: "episode-one", status: "failed", gatedClaims: 0,
  });
  agenda = await service.recordOutcome("user-one", agenda.id, {
    expectedRevision: agenda.revision, episodeId: "episode-two", status: "failed", gatedClaims: 0,
  });
  assert.equal(agenda.payload.status, "paused");
  assert.match(agenda.payload.pauseReason, /连续失败/);
  await assert.rejects(() => service.schedule("user-one", agenda.id, { date: "2026-09-07" }),
    (error) => error.code === "autopilot_paused");

  agenda = await service.start("user-one", agenda.id, { expectedRevision: agenda.revision });
  agenda = await service.stop("user-one", agenda.id, { expectedRevision: agenda.revision });
  assert.equal(agenda.payload.status, "stopped");
  await assert.rejects(() => service.schedule("user-one", agenda.id, { date: "2026-09-08" }),
    (error) => error.code === "autopilot_stopped");
  assert.equal(jobs.items.length, 0, "recording outcomes and stopping must not enqueue replacement work");
});

test("a digest separates headlines from leads and records user decisions", async () => {
  const { service, notifications } = fixture();
  const created = await service.create("user-one", agendaInput);
  const active = await service.start("user-one", created.id, { expectedRevision: created.revision });
  const digest = await service.createDigest("user-one", active.id, {
    date: "2026-09-06", episodeIds: ["episode-one"], costCny: 3.25,
    claims: [
      { id: "claim-one", statement: "Direct finding", type: "direct", tier: "gated", refutation: "stands" },
      { id: "claim-two", statement: "Unverified lead", type: "synthesized", tier: "unverified", what_would_change: "New trial" },
    ],
  });
  assert.equal(digest.payload.headlines.length, 1);
  assert.equal(digest.payload.leads.length, 1);
  assert.equal(notifications.created.length, 1);
  const decision = await service.decide("user-one", digest.id, { action: "reject", claimId: "claim-two", note: "Out of scope" });
  assert.equal(decision.payload.decisions[0].action, "reject");
  assert.equal(decision.payload.decisions[0].claimId, "claim-two");
});

test("a completed episode admits only contract-valid claims tied to accepted run artifacts", async () => {
  const { service } = fixture();
  const created = await service.create("user-one", agendaInput);
  const active = await service.start("user-one", created.id, { expectedRevision: created.revision });
  const scheduled = await service.schedule("user-one", active.id, { date: "2026-09-06" });
  await service.markEpisodeDispatched("user-one", scheduled.episode.id, { runId: "run-one", sessionId: "session-one" });
  const report = "reports/evidence.md";
  const digest = await service.completeRun("user-one", {
    projectId: "project-one", runId: "run-one", status: "succeeded", deltaSchemaVersion: 1,
    artifacts: [report, "agenda-delta.json"], costCny: 1.25,
    claims: [
      { id: "accepted", statement: "The cited trial reported the endpoint.", type: "direct", tier: "unverified",
        sources: ["doi:10.1000/example"], provenance: { episodeId: scheduled.episode.id, artifact: report } },
      { id: "self-graded", statement: "This claim graded itself.", type: "direct", tier: "reproduced",
        sources: ["doi:10.1000/example"], provenance: { episodeId: scheduled.episode.id, artifact: report } },
      { id: "foreign-artifact", statement: "This points outside the accepted receipt.", type: "direct", tier: "unverified",
        sources: ["doi:10.1000/example"], provenance: { episodeId: scheduled.episode.id, artifact: "scratch.txt" } },
    ],
  });
  assert.equal(digest.payload.headlines.length, 0);
  assert.equal(digest.payload.leads.length, 1);
  assert.equal(digest.payload.leads[0].tier, "gated");
  const episode = await service.getEpisode("user-one", scheduled.episode.id);
  assert.equal(episode.payload.rejectedClaims.length, 2);
  assert.equal(episode.payload.costCny, 1.25);
});

test("stopping an agenda durably cancels its running sessions without replacing work", async () => {
  const { service, jobs } = fixture();
  const created = await service.create("user-one", agendaInput);
  const active = await service.start("user-one", created.id, { expectedRevision: created.revision });
  const scheduled = await service.schedule("user-one", active.id, { date: "2026-09-06" });
  await service.markEpisodeDispatched("user-one", scheduled.episode.id, { runId: "run-stop", sessionId: "session-stop" });
  const currentAgenda = await service.get("user-one", active.id);
  await service.stop("user-one", currentAgenda.id, { expectedRevision: currentAgenda.revision });
  const episode = await service.getEpisode("user-one", scheduled.episode.id);
  assert.equal(episode.payload.status, "canceled");
  assert.equal(episode.payload.cancellation.status, "queued");
  const cancellation = jobs.items.find((job) => job.payload.action === "cancel");
  assert.equal(cancellation.payload.sessionId, "session-stop");
});

test("completion resumes after digest notification fails without duplicating the outcome", async () => {
  let attempts = 0;
  const { service, documents } = fixture({ notificationCreate: async (userId, input, notifications) => {
    attempts += 1;
    if (attempts === 1) throw new Error("inbox offline");
    notifications.created.push({ userId, input });
  } });
  const created = await service.create("user-one", agendaInput);
  const active = await service.start("user-one", created.id, { expectedRevision: created.revision });
  const scheduled = await service.schedule("user-one", active.id, { date: "2026-09-06" });
  await service.markEpisodeDispatched("user-one", scheduled.episode.id, { runId: "run-recover", sessionId: "session-recover" });
  const input = { projectId: "project-one", runId: "run-recover", status: "succeeded", deltaSchemaVersion: 1,
    artifacts: ["report.md"], costCny: 2, claims: [] };
  await assert.rejects(() => service.completeRun("user-one", input), /inbox offline/);
  assert.equal((await service.getEpisode("user-one", scheduled.episode.id)).payload.status, "verifying");
  const digest = await service.completeRun("user-one", input);
  assert.ok(digest.id.startsWith("digest-"));
  assert.equal((await service.getEpisode("user-one", scheduled.episode.id)).payload.status, "merged");
  const agenda = await service.get("user-one", active.id);
  assert.equal(agenda.payload.outcomes.filter((outcome) => outcome.episodeId === scheduled.episode.id).length, 1);
  assert.equal((await documents.list("user-one", "digest", { projectId: "project-one" })).items.length, 1);
});

test("a failed episode with terminal completion evidence cannot be rebound as running", async () => {
  const { service, documents } = fixture();
  const created = await service.create("user-one", agendaInput);
  const active = await service.start("user-one", created.id, { expectedRevision: created.revision });
  const scheduled = await service.schedule("user-one", active.id, { date: "2026-09-06" });
  const failed = await documents.put("user-one", "episode", scheduled.episode.id, {
    ...scheduled.episode.payload, status: "failed", runId: "run-terminal", digestId: "digest-terminal",
  }, { expectedRevision: scheduled.episode.revision, projectId: "project-one" });
  assert.equal(failed.payload.status, "failed");
  await assert.rejects(() => service.markEpisodeDispatched("user-one", failed.id, {
    runId: "run-terminal", sessionId: "session-terminal",
  }), { code: "autopilot_episode_state_conflict" });
});
