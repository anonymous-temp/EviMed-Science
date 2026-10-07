// The programme composed in the real hosted app (evidence-flywheel F01/F02): built only with its switch on and the frontier beside it,
// handed to the autopilot as the owner of its own agendas, and — through the worker's own dispatch closures — an episode of its agenda is
// dispatched as the platform's money (route reason → purpose `evidence`, no wallet asked), held by the day's budget as a wait, and
// a researcher's agenda is dispatched exactly as before. A real PostgreSQL; the runtime is stubbed where the kernel would start.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID, isChargeableResearchRun, usagePurposeOfRun } from "@evimed/domain";
import { EVIDENCE_PROJECT_ID, ensureEvidenceProject } from "../src/internalProjects.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginEntry, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PUBLISHER = PLATFORM_PUBLISHER_USER_ID;
/** @type {any} */ let app;
/** @type {any} */ let isolated;
let dataDir = "";
/** @type {any[]} */ const dispatched = [];

/** The base of every test here: the real hosted app, the programme on, no worker started (nothing moves under an assertion). */
async function boot(over = {}) {
  isolated = await createGeoTestDatabase(databaseUrl, "programmeapp");
  dataDir = await mkdtemp(path.join(tmpdir(), "evimed-programme-app-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1)] });
  return createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: true, stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url,
    frontierEnabled: true, frontierAudience: "operators", knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: plugin.fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} }, autopilotEnabled: true, evidenceProgrammeEnabled: true, evidenceProgrammeDailyBudgetCny: 30,
    evidenceProgrammeMaxConcurrency: 1, operatorUsers: ["ops-programme"], operatorMetricsToken: "test-only-metrics-token", modelGatewaySigningSecret: randomBytes(32).toString("hex"), ...over,
  });
}

before(async () => {
  if (!databaseUrl) return;
  app = await boot();
  await app.listen(0, "127.0.0.1");
  // Nothing moves under an assertion: the workers that listening started are stopped, and each test ticks what it needs by hand.
  for (const worker of [app.frontierWorker, app.autopilotWorker, app.evidenceProgramme?.worker]) await worker?.close();
  await app.store.createUser("ops-programme", "test-only-programme-password", "ops-programme");
  await app.store.createUser("researcher-programme", "test-only-programme-password", "researcher-programme");
  await app.store.createProject(await app.store.userById("researcher-programme"), "default", "Default");
  await ensureEvidenceProject(app.store);
  // The runtime is not started; what the dispatch closures hand to it is what these tests read.
  app.runtimeManager.reserveBoundedRuntimeSession = async (_project, scope) => ({ id: `session-${scope.runId}`, kernel: "dsh" });
  app.runtimeManager.dispatchPrompt = async () => ({ accepted: true });
  app.runtimeManager.boundedRuntimeCleanupTarget = () => null;
  app.agentRuns.dispatch = async (_project, input, sendPrompt) => {
    dispatched.push(input);
    await sendPrompt({ sessionId: input.sessionId }, { id: `run-${dispatched.length}`, kernelRequestIds: [] });
    return { id: `run-${dispatched.length}`, status: "running" };
  };
});
after(async () => {
  if (!app) return;
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  await isolated?.drop();
});

test("the programme is composed only with its switch on and the frontier beside it, and the autopilot is told which agendas are its own", options, async () => {
  assert.ok(app.evidenceProgramme, "composed");
  assert.equal(app.evidenceProgramme.enabled, true);
  assert.equal(app.autopilotService.programme, app.evidenceProgramme, "the autopilot asks it for the day's budget and slot");
  assert.ok(app.evidenceProgramme.worker, "with its own leased worker");
  assert.equal(app.evidenceProgramme.owns(PUBLISHER, EVIDENCE_PROJECT_ID), true);
  assert.equal(app.evidenceProgramme.owns("researcher-programme", EVIDENCE_PROJECT_ID), false, "a researcher's copy of the project is not the platform's");
  assert.equal(app.evidenceProgramme.owns(PUBLISHER, "default"), false);
  // Off, or without the frontier, it is not composed at all: nothing to tick, no table read.
  for (const [what, over] of [["switched off", { evidenceProgrammeEnabled: false }], ["without the frontier", { frontierEnabled: false }]]) {
    const other = await createGeoTestDatabase(databaseUrl, "programmeappoff");
    const dir = await mkdtemp(path.join(tmpdir(), "evimed-programme-off-"));
    const built = createWebApiApp({ dataDir: dir, port: 0, runtimeMode: "mock", devAuth: true, stateStore: "postgres", requireSharedStateStore: true, databaseUrl: other.url,
      autopilotEnabled: true, evidenceProgrammeEnabled: true, ...over });
    await built.listen(0, "127.0.0.1");
    try {
      assert.equal(built.evidenceProgramme, null, what);
      assert.equal(built.autopilotService.programme, null, what);
    } finally { await built.close(); await rm(dir, { recursive: true, force: true }); await other.drop(); }
  }
});

/** A started agenda of `userId` with one queued episode, the way the service makes one. */
async function queuedEpisode(userId, projectId, over = {}) {
  const service = app.autopilotService;
  const created = await service.create(userId, { projectId, title: "Q", prompt: "Look at apixaban", taskTypes: ["evidence-update"],
    schedule: { kind: "once", timeZone: "UTC", time: "00:00", date: "2099-12-31" }, dailyBudgetCny: 30, weeklyBudgetCny: 210, maxEpisodeCny: 10, ...over });
  const started = await service.start(userId, created.id, { expectedRevision: created.revision });
  const { episode } = await service.runNow(userId, started.id, { requestId: `app-${Math.random().toString(16).slice(2)}` });
  return { agenda: started, episode };
}
const input = (agendaId, episode, userId, projectId) => ({ userId, projectId, agendaId, episodeId: episode.id, taskType: "evidence-update", budgetCny: episode.payload.budgetCny, prompt: episode.payload.prompt,
  dispatchId: episode.id, assertDispatchAllowed: async () => {} });

test("an episode of the platform's agenda is dispatched as the platform's money: its route reason makes it purpose `evidence` and unchargeable, and no wallet is asked", options, async () => {
  dispatched.length = 0;
  const { agenda, episode } = await queuedEpisode(PUBLISHER, EVIDENCE_PROJECT_ID);
  await app.autopilotWorker.dispatchEpisode(input(agenda.id, episode, PUBLISHER, EVIDENCE_PROJECT_ID));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].effectiveRouteReason, "autopilot:evidence:evidence-update");
  assert.equal(usagePurposeOfRun({ effectiveAgentId: dispatched[0].effectiveAgentId, effectiveRouteReason: dispatched[0].effectiveRouteReason }), "evidence");
  assert.equal(isChargeableResearchRun({ effectiveAgentId: dispatched[0].effectiveAgentId, effectiveRouteReason: dispatched[0].effectiveRouteReason }), false);
  const stored = await app.autopilotService.getEpisode(PUBLISHER, episode.id);
  assert.equal(stored.payload.balanceChecks, undefined, "the platform has no wallet, and none is asked");
  await app.autopilotService.markEpisodeCanceled(PUBLISHER, episode.id); // the programme's one slot is free again for the next test
});

test("a researcher's agenda is dispatched exactly as before: the autopilot route reason, a wallet question, the kernel's purpose", options, async () => {
  dispatched.length = 0;
  const { agenda, episode } = await queuedEpisode("researcher-programme", "default");
  await app.autopilotWorker.dispatchEpisode(input(agenda.id, episode, "researcher-programme", "default"));
  assert.equal(dispatched[0].effectiveRouteReason, "autopilot:evidence-update");
  assert.equal(usagePurposeOfRun({ effectiveAgentId: dispatched[0].effectiveAgentId, effectiveRouteReason: dispatched[0].effectiveRouteReason }), "kernel");
  const stored = await app.autopilotService.getEpisode("researcher-programme", episode.id);
  assert.ok(stored.payload.balanceChecks?.episode, "the balance question was asked and recorded");
});

test("when the day's budget is spent the platform's episode waits: the dispatch is refused by name, and the worker keeps its place instead of failing it", options, async () => {
  dispatched.length = 0;
  const { agenda, episode } = await queuedEpisode(PUBLISHER, EVIDENCE_PROJECT_ID, { title: "Q2" });
  // Spend the whole day on `evidence`: the ledger is the budget.
  await app.usageLedger.reserveModel({ id: "00000000-0000-4000-8000-000000000001", userId: PUBLISHER, projectId: EVIDENCE_PROJECT_ID, purpose: "evidence", model: "deepseek-v4-flash",
    priceVersion: "evimed-reference-2026-09-05", currency: "CNY", requestFingerprint: "a".repeat(64), estimatedCost: 31, dailyLimit: 0, weeklyLimit: 0, now: new Date() });
  await assert.rejects(app.autopilotWorker.dispatchEpisode(input(agenda.id, episode, PUBLISHER, EVIDENCE_PROJECT_ID)),
    { code: "evidence_programme_budget_spent" });
  assert.equal(dispatched.length, 0, "nothing was dispatched");
  // The worker's own tick (of this episode's job alone): it is requeued as a resource wait and the episode records why, rather than failing.
  await app.store.database.query("UPDATE evimed_product.jobs SET status='canceled' WHERE kind='episode' AND status='queued' AND payload->>'episodeId' <> $1", [episode.id]);
  const ticked = await app.autopilotWorker.tick();
  assert.equal(ticked, null);
  const waiting = await app.autopilotService.getEpisode(PUBLISHER, episode.id);
  assert.equal(waiting.payload.status, "queued", "not failed");
  assert.equal(waiting.payload.resourceDeferrals?.episode?.code, "evidence_programme_budget_spent");
  assert.equal(waiting.payload.resourceDeferrals?.episode?.status, "waiting");
  const job = (await app.store.database.query("SELECT status, attempts FROM evimed_product.jobs WHERE user_id=$1 AND kind='episode' AND payload->>'episodeId'=$2", [PUBLISHER, episode.id])).rows[0];
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0, "the wait does not spend an attempt");
});

test("the independent verification of the platform's claim is the platform's money too, and the day's budget does not gate it: its share was held back from the episode", options, async () => {
  dispatched.length = 0;
  // The day is spent (the test before this one), and a merged episode of the platform's agenda has a claim waiting for its independent check.
  const { agenda, episode } = await queuedEpisodeDirect();
  const verificationId = `${episode.id}-v0`;
  const result = await app.autopilotWorker.dispatchVerification({
    userId: PUBLISHER, projectId: EVIDENCE_PROJECT_ID, agendaId: agenda.id, episodeId: episode.id, digestId: "digest-none", verificationId, claimId: "CLM-001",
    statement: "A claim of the platform's own research.", sources: ["doi:10.1000/one"], effect: null, artifact: null, budgetCny: 1.25,
  });
  assert.ok(result.runId, "dispatched although the programme's budget is spent");
  assert.equal(dispatched.at(-1).effectiveRouteReason, "autopilot-verify:evidence");
  assert.equal(usagePurposeOfRun({ effectiveAgentId: dispatched.at(-1).effectiveAgentId, effectiveRouteReason: dispatched.at(-1).effectiveRouteReason }), "evidence");
  assert.equal(isChargeableResearchRun({ effectiveAgentId: dispatched.at(-1).effectiveAgentId, effectiveRouteReason: dispatched.at(-1).effectiveRouteReason }), false);
});

/** An episode made straight in the documents, for a day whose budget the service itself would refuse. */
async function queuedEpisodeDirect() {
  const service = app.autopilotService;
  const created = await service.create(PUBLISHER, { projectId: EVIDENCE_PROJECT_ID, title: "Q4", prompt: "x", taskTypes: ["evidence-update"],
    schedule: { kind: "once", timeZone: "UTC", time: "00:00", date: "2099-12-31" }, dailyBudgetCny: 30, weeklyBudgetCny: 210, maxEpisodeCny: 10 });
  const started = await service.start(PUBLISHER, created.id, { expectedRevision: created.revision });
  const episodeId = `episode-${"d".repeat(32)}`;
  await app.store.database.query(`INSERT INTO evimed_product.documents(user_id, kind, id, project_id, payload) VALUES($1,'episode',$2,$3,$4::jsonb)`,
    [PUBLISHER, episodeId, EVIDENCE_PROJECT_ID, JSON.stringify({ schemaVersion: 2, agendaId: started.id, taskType: "evidence-update", status: "merged", claims: [], budgetCny: 7.5 })]);
  return { agenda: started, episode: { id: episodeId } };
}

test("the operator's metrics carry every outcome the programme counts", options, async () => {
  const { port } = app.server.address();
  const text = await (await fetch(`http://127.0.0.1:${port}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(text, /^open_science_evidence_programme_decisions_total\{source="model"\} 0$/m);
  assert.match(text, /^open_science_evidence_programme_cards_total\{outcome="published"\} 0$/m);
  assert.match(text, /^open_science_evidence_programme_claims_excluded_total\{reason="refuted"\} 0$/m);
  assert.match(text, /^open_science_evidence_programme_admissions_total\{outcome="budget"\} \d+$/m, "the refusals the tests above caused are counted");
  assert.match(text, /^# TYPE open_science_evidence_programme_actions_total counter$/m);
});
