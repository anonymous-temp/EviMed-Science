/**
 * Stopping an agenda leaves no verification in limbo, against the real ledger.
 *
 * Observed on production: an agenda was stopped right after an episode merged.
 * One re-check was already dispatched and was cancelled by the stop; two had not
 * started. Afterwards the episode's claims read `queued`, `verification_result_missing`
 * and `queued` -- for ever, because the stop's sweep ran before (or without) the
 * claims, the job that would have run them was skipped without telling the claim,
 * and the reconcile timer only looked at stopped agendas whose sweep was still open.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { AutopilotService, verificationIdFor } from "../src/autopilotService.mjs";
import { AutopilotWorker } from "../src/autopilotWorker.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "Local test Postgres is not configured" };
const owner = `stopper_${randomUUID()}`;
let database;
let isolated;
let documents;
let jobs;
let service;
let now = new Date("2026-09-30T01:00:00Z");

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "autostop");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Stop test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Stop project',1000000)", [owner]);
  documents = new ProductDocuments(database);
  jobs = new ProductJobs(database);
  service = new AutopilotService({ documents, jobs, now: () => now });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

/** An agenda with one merged episode whose three claims each booked a re-check. */
async function mergedEpisode() {
  now = new Date("2026-09-30T01:00:00Z");
  const created = await service.create(owner, { projectId: "project-test", title: "Stop test", prompt: "Preserve the instruction.",
    taskTypes: ["evidence-update"], schedule: { kind: "daily", timeZone: "UTC", time: "07:35" },
    dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 16 });
  const active = await service.start(owner, created.id, { expectedRevision: created.revision });
  const { episode } = await service.runNow(owner, active.id, { requestId: `request-${randomUUID()}` });
  const runId = `run-${randomUUID()}`;
  await service.markEpisodeDispatched(owner, episode.id, { runId, sessionId: `session-${runId}` });
  const digest = await service.completeRun(owner, { projectId: "project-test", runId, status: "succeeded", deltaSchemaVersion: 1,
    artifacts: ["reports/evidence.md"], costCny: 2, claims: [0, 1, 2].map((index) => ({
      id: `claim-${index}`, statement: `结论 ${index}`, type: "direct", tier: "unverified", sources: [`doi:10.1000/stop-${index}`],
      provenance: { episodeId: episode.id, artifact: "reports/evidence.md" } })) });
  return { agendaId: active.id, episodeId: episode.id, digestId: digest.id };
}

const claimsOf = async (episodeId) => (await documents.get(owner, "episode", episodeId)).payload.claims.map((claim) => claim.verification);

test("a stopped agenda whose sweep is over still has its waiting re-checks ended by the reconcile timer, and a restart revives none", options, async () => {
  const { agendaId, episodeId, digestId } = await mergedEpisode();
  assert.deepEqual((await claimsOf(episodeId)).map((item) => item.status), ["queued", "queued", "queued"]);
  const verifyJobs = await database.query("SELECT status FROM evimed_product.jobs WHERE user_id=$1 AND kind='verify' AND payload->>'episodeId'=$2", [owner, episodeId]);
  assert.equal(verifyJobs.rows.length, 3);

  // The stop, as production had it: the agenda is stopped and its sweep is recorded complete, so the
  // reconcile query that looked for an open sweep (or a running dispatch) never selected it again.
  const agenda = await service.get(owner, agendaId);
  await documents.put(owner, "agenda", agendaId, { ...agenda.payload, enabled: false, status: "stopped",
    stopSweep: { status: "completed", requestedAt: now.toISOString(), completedAt: now.toISOString() } }, { expectedRevision: agenda.revision, projectId: agenda.projectId });

  await service.reconcileStopWork();
  const ended = await claimsOf(episodeId);
  assert.deepEqual(ended.map((item) => [item.status, item.reason]), [["unscheduled", "agenda_stopped"], ["unscheduled", "agenda_stopped"], ["unscheduled", "agenda_stopped"]],
    "no claim reads queued for work that will never run");
  const digest = await documents.get(owner, "digest", digestId);
  assert.deepEqual([...digest.payload.headlines, ...digest.payload.leads].map((claim) => claim.verification.status), ["unscheduled", "unscheduled", "unscheduled"]);

  // The reconcile is replayable and finds nothing more to do: the agenda is not selected for ever.
  const settled = await documents.get(owner, "episode", episodeId);
  await service.reconcileStopWork();
  assert.equal((await documents.get(owner, "episode", episodeId)).revision, settled.revision);

  // The researcher starts the agenda again. The jobs the stop left in the queue are not run for the old episode.
  const stopped = await service.get(owner, agendaId);
  await service.start(owner, stopped.id, { expectedRevision: stopped.revision });
  const dispatched = [];
  const worker = new AutopilotWorker({ jobs, service, pollMs: 100, leaseMs: 5000,
    dispatchEpisode: async () => assert.fail("the episode is done: nothing dispatches it again"),
    dispatchVerification: async (input) => { dispatched.push(input.verificationId); return { runId: "run", sessionId: "session" }; } });
  for (let tick = 0; tick < 8; tick += 1) await worker.tick();
  assert.deepEqual(dispatched, [], "a re-check the stop ended is not dispatched because the agenda is active again");
  const after = await database.query("SELECT status, result FROM evimed_product.jobs WHERE user_id=$1 AND kind='verify' AND payload->>'episodeId'=$2", [owner, episodeId]);
  assert.deepEqual(after.rows.map((row) => [row.status, row.result?.reason]), Array(3).fill(["succeeded", "verification_settled"]), "each job is retired with its reason");
  assert.deepEqual((await claimsOf(episodeId)).map((item) => item.reason), ["agenda_stopped", "agenda_stopped", "agenda_stopped"]);
  assert.equal(await service.verificationPending(owner, episodeId, verificationIdFor(episodeId, 0)), false);
});

test("a verify job claimed while the agenda is stopped ends its claim before it is skipped", options, async () => {
  const { agendaId, episodeId } = await mergedEpisode();
  const stopped = await service.get(owner, agendaId);
  await documents.put(owner, "agenda", agendaId, { ...stopped.payload, enabled: false, status: "stopped" }, { expectedRevision: stopped.revision, projectId: stopped.projectId });
  const worker = new AutopilotWorker({ jobs, service, pollMs: 100, leaseMs: 5000,
    dispatchEpisode: async () => assert.fail("no episode work"),
    dispatchVerification: async () => assert.fail("a stopped agenda spends nothing on re-checks") });
  for (let tick = 0; tick < 8; tick += 1) await worker.tick();
  const states = await claimsOf(episodeId);
  assert.deepEqual(states.map((item) => [item.status, item.reason]), Array(3).fill(["unscheduled", "agenda_stopped"]),
    "the worker's skip is what ended them here, with the stop named as the stop");
});
