import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { PostgresStore } from "../src/store.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultImpactService } from "../src/resultImpact.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { AutopilotWorker } from "../src/autopilotWorker.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { productIntegrationTests } from "../../../scripts/ops/test-product-state.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl && "Local test Postgres is not configured", timeout: 30000 };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("source continuation transaction regression belongs to the required durable CI inventory", () => {
  assert.ok(productIntegrationTests().some(file => path.basename(file) === "resultImpactContinuation.integration.test.mjs"));
});

async function fixture(t) {
  const isolated = await createGeoTestDatabase(databaseUrl, "impact");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "result-impact-pg-"));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: "postgres", devAuth: true, maxProjectBytes: 1024 * 1024 });
  const store = new PostgresStore(config);
  t.after(async () => { await store.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await store.devUser(); const project = await store.requireProject(user, "default");
  const documents = new ProductDocuments(store.database), jobs = new ProductJobs(store.database);
  let source = await documents.put(user.id, "source", "src_owned", { access: "allowed" }, { expectedRevision: 0, projectId: project.id });
  const results = new ResultProvenanceService({ documents, config,
    authorizeProject: async (actor, id) => store.requireProject(await store.userById(actor), id),
    authorizeReference: async (_actor, _project, ref) => {
      const current = await documents.get(user.id, "source", ref.id);
      return !current ? { ...ref, availability: "deleted" } : current.payload.access !== "allowed" ? null : ref;
    } });
  await writeFile(path.join(project.workspaceDir, "report.md"), "Preserved synthetic report.");
  const version = await results.captureFile({ userId: user.id, project, relativePath: "report.md", expectedDigest: sha("Preserved synthetic report."),
    producer: { kind: "tool", sessionId: "session", callId: "call" },
    inputs: [{ kind: "source", id: source.id, digest: sha("synthetic source"), availability: "captured" }] });
  let impacts;
  const autopilot = new AutopilotService({ documents, jobs, authorizeContinuation: (...args) => impacts.assertContinuation(...args) });
  impacts = new ResultImpactService({ documents, results, autopilot });
  let agenda = await autopilot.create(user.id, { projectId: project.id, title: "Owned transaction regression", topics: ["synthetic"], taskTypes: ["evidence-update"],
    dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, timeZone: "UTC", scheduleHour: 1 });
  agenda = await autopilot.start(user.id, agenda.id, { expectedRevision: agenda.revision });
  const impact = (await impacts.reconcileSourceUpdate(user.id, { projectId: project.id, source: { id: source.id, digest: sha("synthetic source") },
    status: { state: "changed", checkedAt: new Date().toISOString(), updates: [{ kind: "correction", noticeDoi: "10.9999/test", source: "crossref" }] } })).items[0];
  const proceed = () => impacts.continueImpact(user.id, project.id, impact.id, { agendaId: agenda.id });
  const episode = async () => (await documents.list(user.id, "episode", { projectId: project.id })).items.find(row => row.payload.continuationBinding);
  const revoke = async (deleted = false) => {
    source = deleted ? await documents.remove(user.id, "source", source.id, source.revision)
      : await documents.put(user.id, "source", source.id, { access: "restricted" }, { expectedRevision: source.revision, projectId: project.id });
  };
  return { store, user, project, documents, jobs, results, version, impacts, autopilot, agenda, impact, proceed, episode, revoke };
}

for (const deleted of [false, true]) test(`Postgres enqueue commits then ${deleted ? "deleted" : "restricted"} source stops only its bound episode/job`, options, async t => {
  const f = await fixture(t);
  const ordinary = await f.autopilot.schedule(f.user.id, f.agenda.id, { trigger: "manual", requestId: "unrelated" });
  const enqueue = f.jobs.enqueue.bind(f.jobs);
  f.jobs.enqueue = async (...args) => { const job = await enqueue(...args); if (job.payload.continuationBinding) await f.revoke(deleted); return job; };
  await assert.rejects(f.proceed(), { code: "result_impact_source_unavailable" });
  const episode = await f.episode();
  assert.equal(episode.payload.status, "canceled");
  assert.equal((await f.jobs.get(f.user.id, episode.payload.continuationJobId)).status, "canceled");
  assert.equal((await f.jobs.get(f.user.id, ordinary.job.id)).status, "queued");
  assert.equal((await f.autopilot.get(f.user.id, f.agenda.id)).payload.status, "active");
  assert.equal((await f.results.get(f.user.id, f.project.id, f.version.versionId)).digest, f.version.digest);
  await assert.rejects(f.proceed(), { code: "result_impact_source_unavailable" });
});

test("Postgres restart reconstruction retains source binding and final dispatch reauthorization", options, async t => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled([f.proceed(), f.proceed()]);
  assert.ok(attempts.some(item => item.status === "fulfilled"));
  await f.proceed();
  const episode = await f.episode();
  const stored = await f.jobs.get(f.user.id, episode.payload.continuationJobId);
  assert.deepEqual(stored.payload.continuationBinding, episode.payload.continuationBinding);
  const restarted = new AutopilotService({ documents: new ProductDocuments(f.store.database), jobs: new ProductJobs(f.store.database),
    authorizeContinuation: (...args) => f.impacts.assertContinuation(...args) });
  let sent = false;
  const worker = new AutopilotWorker({ jobs: restarted.jobs, service: restarted, dispatchEpisode: async input => {
    await f.revoke(); await input.assertDispatchAllowed(); sent = true; return { runId: "forbidden", sessionId: "session" };
  } });
  await worker.tick();
  assert.equal(sent, false);
  assert.equal((await f.episode()).payload.status, "canceled");
  assert.equal((await f.jobs.get(f.user.id, stored.id)).status, "canceled");
  assert.equal(await f.jobs.claim(["episode"], "post-revocation", { leaseMs: 1000 }), null);
});

test("Postgres periodic source reauthorization stops queued continuation while preserving unrelated agenda work", options, async t => {
  const f = await fixture(t); await f.proceed();
  const ordinary = await f.autopilot.schedule(f.user.id, f.agenda.id, { trigger: "manual", requestId: "independent" });
  await f.revoke();
  const outcome = await f.autopilot.reconcileStopWork();
  assert.ok(outcome.scanned >= 1);
  const episode = await f.episode();
  assert.equal(episode.payload.status, "canceled");
  assert.equal((await f.jobs.get(f.user.id, episode.payload.continuationJobId)).status, "canceled");
  assert.equal((await f.jobs.get(f.user.id, ordinary.job.id)).status, "queued");
});
