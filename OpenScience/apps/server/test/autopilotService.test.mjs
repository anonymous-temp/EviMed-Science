import assert from "node:assert/strict";
import test from "node:test";
import { AutopilotService } from "../src/autopilotService.mjs";

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

function fixture() {
  const documents = new MemoryDocuments();
  const jobs = new MemoryJobs();
  const usage = { assertWithinLimits: async () => ({ allowed: true }) };
  const notifications = { created: [], create: async (userId, input) => { notifications.created.push({ userId, input }); } };
  const service = new AutopilotService({ documents, jobs, usage, notifications,
    now: () => new Date("2026-09-06T01:00:00.000Z"), id: (() => { let i = 0; return (prefix) => `${prefix}${++i}`; })() });
  return { documents, jobs, usage, notifications, service };
}

const agendaInput = {
  projectId: "project-one", title: "心衰证据追踪", topics: ["heart failure", "SGLT2"],
  taskTypes: ["literature-sentinel", "evidence-update"], dailyBudgetCny: 20, weeklyBudgetCny: 80,
  maxEpisodeCny: 8, scheduleHour: 1, timeZone: "Asia/Shanghai",
};

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
