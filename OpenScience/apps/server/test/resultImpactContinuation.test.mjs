import assert from "node:assert/strict";
import test from "node:test";
import { ResultImpactService } from "../src/resultImpact.mjs";
import { AutopilotService, verificationIdFor } from "../src/autopilotService.mjs";
import { AutopilotWorker } from "../src/autopilotWorker.mjs";
import { HttpError } from "../src/security.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

// Actual services/worker with revision-aware documents and a deterministic leased
// queue. These are authorization race tests, not Postgres or live-runtime evidence.
async function fixture() {
  const documents = productDocumentsDouble();
  const rows = new Map();
  let availability = "captured", afterEnqueue = async () => {}, selected = null;
  const jobs = {
    async enqueue(userId, kind, payload, options) {
      let row = [...rows.values()].find(item => item.options.idempotencyKey === options.idempotencyKey);
      if (!row) { row = { id: `job-${rows.size}`, userId, kind, projectId: options.projectId, payload, options,
        status: "queued", leaseToken: "lease", attempts: 1, maxAttempts: 10 }; rows.set(row.id, row); }
      await afterEnqueue(row);
      return row;
    },
    async cancel(userId, id) { const row = rows.get(id); assert.equal(row.userId, userId); if (["queued", "running"].includes(row.status)) row.status = "canceled"; return row; },
    async claim() { const row = selected ? rows.get(selected) : [...rows.values()].find(item => item.status === "queued"); selected = null; if (!row || row.status !== "queued") return null; row.status = "running"; return row; },
    async renew(_user, id) { return rows.get(id).status === "running"; },
    async finish(_user, id, _lease, result) { const row = rows.get(id); if (row.status !== "running") throw new HttpError(409, "product_job_lease_lost", "Lease lost"); row.status = "succeeded"; row.result = result; return row; },
    async fail(_user, id, _lease, error, options) { const row = rows.get(id); if (row.status !== "running") throw new HttpError(409, "product_job_lease_lost", "Lease lost"); row.status = options.retry ? "queued" : "failed"; row.error = error; return row; },
  };
  const results = {
    async scope() { return { userId: "alice", id: "p" }; },
    async list() { return { items: [await this.get()], nextCursor: null }; },
    async get() { return { versionId: "rv_one", inputs: availability === "absent" ? [] : [{ kind: "source", id: "source-one", digest: "digest-one", availability }] }; },
  };
  let impacts;
  const autopilot = new AutopilotService({ documents, jobs, now: () => new Date("2026-10-02T00:00:00Z"),
    authorizeContinuation: (...args) => impacts.assertContinuation(...args) });
  impacts = new ResultImpactService({ documents, results, autopilot });
  let agenda = await autopilot.create("alice", { projectId: "p", title: "Continuation race", topics: ["synthetic"],
    taskTypes: ["evidence-update"], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 1, timeZone: "UTC" });
  agenda = await autopilot.start("alice", agenda.id, { expectedRevision: agenda.revision });
  const impact = (await impacts.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-one", digest: "digest-one" },
    status: { state: "changed", checkedAt: "2026-10-02T00:00:00Z", updates: [{ kind: "correction", noticeDoi: "10.9999/correction", source: "crossref" }] } })).items[0];
  const proceed = () => impacts.continueImpact("alice", "p", impact.id, { agendaId: agenda.id });
  const episode = async () => (await documents.list("alice", "episode", { projectId: "p" })).items.find(item => item.payload.continuationBinding);
  return { documents, rows, jobs, results, impacts, autopilot, agenda, impact, proceed, episode,
    revoke: (state = "restricted") => { availability = state; },
    onEnqueue: callback => { afterEnqueue = callback; }, select: id => { selected = id; } };
}

for (const state of ["restricted", "deleted", "absent"]) test(`${state} during actual schedule enqueue cancels only the bound continuation and cannot retry`, async () => {
  const f = await fixture();
  const ordinary = await f.autopilot.schedule("alice", f.agenda.id, { trigger: "manual", requestId: "unrelated" });
  f.onEnqueue(async row => { if (row.payload.continuationBinding) f.revoke(state); });
  await assert.rejects(f.proceed(), { code: "result_impact_source_unavailable" });
  const episode = await f.episode();
  assert.equal(episode.payload.status, "canceled");
  assert.equal(f.rows.get(episode.payload.continuationJobId).status, "canceled");
  assert.equal(f.rows.get(ordinary.job.id).status, "queued");
  assert.equal((await f.autopilot.get("alice", f.agenda.id)).payload.status, "active");
  await assert.rejects(f.proceed(), { code: "result_impact_source_unavailable" });
  assert.equal(f.rows.size, 2);
  assert.equal((await f.impacts.get("alice", "p", f.impact.id)).payload.source.id, "unavailable-source");
});

test("same-request concurrent continuation deduplicates the actual episode and queue binding", async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([f.proceed(), f.proceed()]);
  assert.ok(outcomes.some(item => item.status === "fulfilled"));
  assert.equal(f.rows.size, 1);
  const episode = await f.episode();
  const binding = episode.payload.continuationBinding;
  assert.deepEqual(binding, [...f.rows.values()][0].payload.continuationBinding);
  assert.equal(binding.impactId, f.impact.id);
  assert.equal(binding.source.digest, "digest-one");
  await f.proceed();
  assert.equal(f.rows.size, 1);
});

test("worker rechecks the stored source binding immediately before dispatch after queued revocation", async () => {
  const f = await fixture(); await f.proceed(); f.revoke();
  let prompts = 0;
  const worker = new AutopilotWorker({ jobs: f.jobs, service: f.autopilot, dispatchEpisode: async () => { prompts++; return { runId: "run", sessionId: "session" }; } });
  await worker.tick();
  assert.equal(prompts, 0);
  assert.equal((await f.episode()).payload.status, "canceled");
  assert.equal([...f.rows.values()][0].status, "canceled");
});

test("final dispatch guard rejects source revocation after worker admission without sending a prompt", async () => {
  const f = await fixture(); await f.proceed();
  let sent = false;
  const worker = new AutopilotWorker({ jobs: f.jobs, service: f.autopilot, dispatchEpisode: async input => {
    f.revoke(); await input.assertDispatchAllowed(); sent = true; return { runId: "run", sessionId: "session" };
  } });
  await worker.tick();
  assert.equal(sent, false);
  assert.equal((await f.episode()).payload.status, "canceled");
});

test("a revocation after accepted dispatch queues exact run cancellation while preserving partial claims", async () => {
  const f = await fixture(); await f.proceed();
  const worker = new AutopilotWorker({ jobs: f.jobs, service: f.autopilot, dispatchEpisode: async () => {
    const episode = await f.episode();
    await f.documents.put("alice", "episode", episode.id, { ...episode.payload, claims: [{ id: "partial", statement: "Preserved partial work" }] }, { expectedRevision: episode.revision, projectId: "p" });
    await f.autopilot.markEpisodeDispatched("alice", episode.id, { runId: "accepted-run", sessionId: "accepted-session" });
    f.revoke(); return { runId: "accepted-run", sessionId: "accepted-session" };
  } });
  await worker.tick();
  const episode = await f.episode();
  assert.equal(episode.payload.status, "canceled");
  assert.equal(episode.payload.claims[0].id, "partial");
  const cancel = [...f.rows.values()].find(item => item.payload.action === "cancel");
  assert.equal(cancel.payload.runId, "accepted-run");
  assert.equal(cancel.payload.sessionId, "accepted-session");
  let canceled = false;
  const cancellationWorker = new AutopilotWorker({ jobs: f.jobs, service: f.autopilot, dispatchEpisode: async () => assert.fail("must not dispatch"),
    cancelDispatched: async input => { assert.equal(input.runId, "accepted-run"); canceled = true; } });
  await cancellationWorker.tick();
  assert.equal(canceled, true);
  assert.equal((await f.episode()).payload.cancellation.status, "completed");
});

test("fast completed main work retains merged state and cancels only its active verification", async () => {
  const f = await fixture(); await f.proceed();
  let episode = await f.episode();
  const verificationId = verificationIdFor(episode.id, 0);
  const verification = { verificationId, dispatchId: verificationId, runId: "verify-run", sessionId: "verify-session", status: "running" };
  const completion = { status: "succeeded", resultPath: "report.md" };
  episode = await f.documents.put("alice", "episode", episode.id, { ...episode.payload, status: "merged", runId: "finished-main", sessionId: "main-session",
    completion, claims: [{ id: "finished-claim" }], verificationDispatches: [verification] }, { expectedRevision: episode.revision, projectId: "p" });
  f.revoke();
  await assert.rejects(f.autopilot.assertEpisodeContinuation("alice", episode.id, { runId: "finished-main", sessionId: "main-session" }), { code: "result_impact_source_unavailable" });
  const final = await f.episode();
  assert.equal(final.payload.status, "merged");
  assert.deepEqual(final.payload.completion, completion);
  assert.deepEqual(final.payload.claims, episode.payload.claims);
  const cancels = [...f.rows.values()].filter(item => item.payload.action === "cancel");
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].payload.runId, "verify-run");
});

test("verification rechecks original episode binding after source deletion and never promotes a claim", async () => {
  const f = await fixture(); await f.proceed();
  const episode = await f.episode();
  const verificationId = verificationIdFor(episode.id, 0);
  const verify = await f.jobs.enqueue("alice", "verify", { agendaId: f.agenda.id, episodeId: episode.id, verificationId }, { idempotencyKey: "verify-one", projectId: "p" });
  f.select(verify.id); f.revoke("deleted");
  let sent = false;
  const worker = new AutopilotWorker({ jobs: f.jobs, service: f.autopilot, dispatchEpisode: async () => assert.fail("episode not selected"),
    dispatchVerification: async () => { sent = true; return { runId: "verify-run", sessionId: "verify-session" }; } });
  await worker.tick();
  assert.equal(sent, false);
  assert.equal(verify.status, "failed");
  assert.equal(verify.error.code, "result_impact_source_unavailable");
  assert.deepEqual((await f.episode()).payload.claims, []);
});

test("temporary result storage outage does not revoke authorization or cancel useful work", async () => {
  const f = await fixture(); await f.proceed();
  f.results.get = async () => { throw new Error("temporary storage outage"); };
  const episode = await f.episode();
  await assert.rejects(f.autopilot.assertEpisodeContinuation("alice", episode.id), /temporary storage outage/);
  assert.equal((await f.episode()).payload.status, "queued");
  assert.equal([...f.rows.values()][0].status, "queued");
});

test("completed main work during worker return is not retroactively canceled on source revocation", async () => {
  const f = await fixture(); await f.proceed();
  const worker = new AutopilotWorker({ jobs: f.jobs, service: f.autopilot, dispatchEpisode: async () => {
    const episode = await f.episode();
    await f.documents.put("alice", "episode", episode.id, { ...episode.payload, status: "verifying", completion: { outcomeStatus: "succeeded" },
      runId: "finished-main", sessionId: "finished-session", claims: [{ id: "finished" }] }, { expectedRevision: episode.revision, projectId: "p" });
    f.revoke(); return { runId: "finished-main", sessionId: "finished-session" };
  } });
  await worker.tick();
  const final = await f.episode();
  assert.equal(final.payload.status, "verifying");
  assert.equal(final.payload.completion.outcomeStatus, "succeeded");
  assert.equal(final.payload.claims[0].id, "finished");
  assert.equal([...f.rows.values()].some(row => row.payload.action === "cancel"), false);
});

test("accepted verification revoked during dispatch is recorded and canceled by exact verification identity", async () => {
  const f = await fixture(); await f.proceed();
  const episode = await f.episode(); const verificationId = verificationIdFor(episode.id, 0);
  await f.jobs.enqueue("alice", "verify", { agendaId: f.agenda.id, episodeId: episode.id, verificationId }, { idempotencyKey: "verify", projectId: "p" });
  f.select("job-1");
  const worker = new AutopilotWorker({ jobs: f.jobs, service: f.autopilot, dispatchEpisode: async () => assert.fail("not selected"),
    dispatchVerification: async () => { f.revoke(); return { runId: "accepted-verify", sessionId: "verify-session" }; } });
  await worker.tick();
  const final = await f.episode();
  assert.equal(final.payload.verificationDispatches[0].runId, "accepted-verify");
  const cancel = [...f.rows.values()].find(row => row.payload.action === "cancel");
  assert.equal(cancel.payload.verificationId, verificationId);
  assert.equal(cancel.payload.runId, "accepted-verify");
  assert.deepEqual(final.payload.claims, []);
});

test("JSONB key ordering does not turn a replayed source binding into another request", async () => {
  const f = await fixture(); await f.proceed();
  const episode = await f.episode();
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const binding = reorder(episode.payload.continuationBinding);
  const row = await f.documents.get("alice", "result-impact", f.impact.id);
  await f.documents.put("alice", "result-impact", row.id, { ...row.payload, continuation: { status: "preparing", agendaId: f.agenda.id }, source: reorder(row.payload.source) },
    { expectedRevision: row.revision, projectId: "p" });
  await f.autopilot.assertEpisodeContinuation("alice", episode.id);
  await f.autopilot.schedule("alice", f.agenda.id, { trigger: "follow-up", requestId: f.impact.id,
    note: episode.payload.followUpNote, continuationBinding: binding });
  assert.equal(f.rows.size, 1);
  f.revoke();
  await assert.rejects(f.autopilot.assertEpisodeContinuation("alice", episode.id), { code: "result_impact_source_unavailable" });
  assert.equal((await f.episode()).payload.status, "canceled");
});

test("source revocation during the final impact CAS cancels queued work before returning source context", async () => {
  const f = await fixture(); const put = f.documents.put.bind(f.documents);
  f.documents.put = async (...args) => { const row = await put(...args); if (args[1] === "result-impact" && args[3].continuation.status === "scheduled") f.revoke(); return row; };
  await assert.rejects(f.proceed(), { code: "result_impact_source_unavailable" });
  const episode = await f.episode();
  assert.equal(episode.payload.status, "canceled");
  assert.equal(f.rows.get(episode.payload.continuationJobId).status, "canceled");
  await assert.rejects(f.proceed(), { code: "result_impact_source_unavailable" });
  assert.equal(f.rows.size, 1);
});

test("periodic reconciliation stops bound queued work after source revocation without another user request", async () => {
  const f = await fixture(); await f.proceed(); f.revoke();
  const episode = await f.episode();
  f.documents.database = { query: async sql => ({ rows: sql.includes("payload->'continuationBinding'") ? [{ user_id: "alice", id: episode.id }] : [] }) };
  const outcome = await f.autopilot.reconcileStopWork();
  assert.equal(outcome.scanned, 1);
  assert.equal((await f.episode()).payload.status, "canceled");
  assert.equal(f.rows.get(episode.payload.continuationJobId).status, "canceled");
});

test("cancellation queue outage retains the exact accepted target for existing durable recovery", async () => {
  const f = await fixture(); await f.proceed();
  const enqueue = f.jobs.enqueue.bind(f.jobs);
  f.jobs.enqueue = async (...args) => { if (args[2].action === "cancel") throw new Error("queue temporarily unavailable"); return enqueue(...args); };
  const worker = new AutopilotWorker({ jobs: f.jobs, service: f.autopilot, dispatchEpisode: async () => {
    f.revoke(); return { runId: "accepted-late", sessionId: "session-late" };
  } });
  await worker.tick();
  let episode = await f.episode();
  assert.equal(episode.payload.cancellation.runId, "accepted-late");
  assert.equal(episode.payload.cancellation.status, "queued");
  assert.equal(f.rows.size, 1);
  f.jobs.enqueue = enqueue;
  f.documents.database = { query: async sql => ({ rows: sql.includes("payload->'cancellation'->>'status'='queued'")
    ? [{ user_id: "alice", id: episode.id, project_id: "p", payload: episode.payload, revision: episode.revision }] : [] }) };
  const outcome = await f.autopilot.reconcileStopWork();
  assert.equal(outcome.enqueued, 1);
  assert.equal([...f.rows.values()].find(row => row.payload.action === "cancel").payload.runId, "accepted-late");
  episode = await f.episode();
  assert.equal(episode.payload.status, "canceled");
});
