// Real HTTP, PostgreSQL and run ledger; only the native runtime and provider-independent context are replaced.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "test-only-vcr-password";
const OWNER = `own${suffix}`;

/** @type {any} */ let context = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */ let isolated = null;
/** What the runtime was asked, in order. */
const record = { starts: /** @type {any[]} */ ([]), reserved: /** @type {any[]} */ ([]), prompts: /** @type {any[]} */ ([]), dispatches: /** @type {any[]} */ ([]),
  minted: /** @type {string[]} */ ([]), noRoom: false, busy: false, failPrompt: "", nativeQueued: false };

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrintake");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-vcr-go-"));
  const plane = path.join(dataDir, "plane");
  await mkdir(plane, { recursive: true });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    rateLimitMaxRequests: 100_000, authRateLimitMaxRequests: 1_000, modelGatewaySigningSecret: randomBytes(32).toString("hex"),
    llmRoutingEnabled: false, vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3_600_000, vcrDataPlaneDir: plane,
    vcrEngineUrl: "http://engine.test:8080", vcrEngineToken: "t".repeat(40), vcrEngineReceiptKey: "r".repeat(40),
    vcrFetch: async (/** @type {any} */ url) => {
      const body = new URL(String(url)).pathname === "/health" ? { ok: true, engineVersion: "test", rVersion: "test", methods: [], packageLockHash: "" } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  // The run store's dispatch and the runtime's start, reservation and prompt are recorders: the real dispatch function of the module
  // (`dispatchVcrRun`) is what runs between them.
  app.residentProfiles.forDispatch = async () => ({ text: "", due: false, memories: [], delivered: async () => {} });
  app.runtimeManager.start = async (/** @type {any} */ project, /** @type {any} */ opts) => {
    record.starts.push(opts);
    app.runtimeManager.runtimes.set(app.runtimeManager.key(project), { workspaceDir: project.workspaceDir, project });
    return app.runtimeManager.runtimes.get(app.runtimeManager.key(project));
  };
  app.runtimeManager.reserveBoundedRuntimeSession = async (/** @type {any} */ _project, /** @type {any} */ scope) => {
    record.reserved.push(scope);
    return { id: `session_reserved_${record.reserved.length}`, kernel: "dsh" };
  };
  app.runtimeManager.endBoundedRuntime = async () => true;
  // The kernel mints a conversation's id (`session/create`): a stand-in that numbers them, and can be made to find no room.
  app.runtimeManager.createRuntimeSession = async () => {
    if (record.noRoom) throw Object.assign(new Error("full"), { status: 429, code: "runtime_capacity_full" });
    record.minted.push(`kernel-session-${record.minted.length + 1}`);
    return { id: record.minted.at(-1), kernel: "dsh" };
  };
  app.runtimeManager.dispatchPrompt = async (/** @type {any} */ _project, /** @type {string} */ session, /** @type {any} */ request) => {
    const bound = await app.vcr.store.one("SELECT run_id,session_id FROM evimed_vcr.schedule_marks WHERE run_id=$1", [request.runId]);
    assert.equal(bound?.run_id, request.runId, "the first reserved run is bound before native execution");
    assert.equal(bound?.session_id, session);
    record.prompts.push({ session, ...request, nativeQueued: record.nativeQueued });
    if (record.failPrompt) throw Object.assign(new Error(record.failPrompt), { code: record.failPrompt });
    return { accepted: true };
  };
  app.runtimeManager.sessionInbox = async () => ({ running: record.busy, queued: 0 });
  app.agentRuns.readSessionHistory = async () => [];
  await app.store.createUser(OWNER, PASSWORD, OWNER);
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: OWNER, password: PASSWORD }) });
  const body = await login.json();
  const headers = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  context = { app, base, headers, dataDir };
});

after(async () => {
  if (context) {
    // The stand-in runtimes the harness put in place are taken away before the app's own shutdown meets them.
    context.app.runtimeManager.runtimes.clear();
    await context.app.close();
    await rm(context.dataDir, { recursive: true, force: true });
  }
  await isolated?.drop();
});

/** @param {string} method @param {string} route @param {unknown} [body] */
async function call(method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}


test("explicit Start enters the real run ledger and canonical native conversation once, then awaits clarification", options, async () => {
  const created = await call("POST", "/api/vcr/studies", { draft: true, name: "Partial study", question: "A saved idea" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const study = created.body.data;
  const brief = "  Can this intervention help?\nI have not chosen a population yet.  ";
  const input = { brief, requestId: "intake_request_123" };
  const started = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.data.sessionId, study.sessionId);
  assert.equal(started.body.data.state, "accepted");
  assert.deepEqual(record.prompts.map(row => [row.session, row.text]), [[study.sessionId, brief]]);
  const mark = await context.app.vcr.store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND key='run:definition'", [study.id]);
  assert.equal(mark.run_id, started.body.data.runId);
  const owner = await context.app.store.userById((await context.app.vcr.store.studyById(study.id)).userId);
  const project = await context.app.store.requireProject(owner, study.projectId);
  const run = (await context.app.agentRuns.list(project))[0];
  assert.equal(run.sessionId, study.sessionId);
  await context.app.agentRuns.finishInternal(project, run.id, { status: "succeeded", artifacts: [] });
  await context.app.vcr.orchestrator.onRunFinished(project, { ...run, status: "succeeded" });
  const reread = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
  assert.equal(reread.status, 200, JSON.stringify(reread.body));
  assert.equal(reread.body.data.state, "awaiting_input");
  assert.equal(record.prompts.length, 1);
  const saved = await context.app.vcr.store.studyById(study.id);
  assert.equal(saved.question, brief);
  assert.equal(saved.steps.definition.requested, true);
  assert.equal(saved.steps.definition.held, true);
  assert.equal(Object.values(saved.steps).filter(step => step.requested).length, 1);
  const conflict = await call("POST", `/api/vcr/studies/${study.id}/start`, { ...input, brief: brief + "change" });
  assert.equal(conflict.status, 409);
  assert.equal((await context.app.vcr.store.studyById(study.id)).question, brief);
  await context.app.vcr.store.saveDefinition({ studyId: study.id, userId: saved.userId,
    pico: { population: "Adults", intervention: "Intervention" }, endpointType: "continuous", intendedUse: "exploratory" });
  const followup = { id: "native_followup", sessionId: study.sessionId, status: "succeeded" };
  assert.equal(await context.app.vcr.orchestrator.onRunFinished(project, followup), true);
  assert.equal(await context.app.vcr.orchestrator.onRunFinished(project, followup), false);
  const defined = await context.app.vcr.store.studyById(study.id);
  assert.equal(defined.steps.definition.held, false);
  assert.equal(defined.steps.definition.requested, true);
  assert.equal(Object.values(defined.steps).filter(step => step.requested).length, 1);
  assert.equal(record.prompts.length, 1, "a native followup definition does not dispatch a hidden definition");
});


test("busy refuses without saving; unknown and rejected dispatches reread without another native prompt", options, async () => {
  const created = await call("POST", "/api/vcr/studies", { draft: true, name: "Boundary study", question: "Saved question" });
  const study = created.body.data;
  const input = { brief: "Original partial research brief", name: "Edited title", requestId: "boundary_request_1" };
  record.busy = true;
  const busy = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
  assert.equal(busy.status, 409);
  assert.equal((await context.app.vcr.store.studyById(study.id)).question, "Saved question");
  assert.equal((await context.app.vcr.store.studyById(study.id)).name, "Boundary study");
  record.busy = false; record.failPrompt = "runtime_prompt_acceptance_unknown";
  const before = record.prompts.length;
  const unknown = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
  assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
  assert.equal(unknown.body.data.state, "confirming");
  assert.equal((await context.app.vcr.store.studyById(study.id)).question, input.brief);
  record.busy = true;
  const again = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
  assert.equal(again.body.data.runId, unknown.body.data.runId);
  assert.equal(again.body.data.state, "confirming");
  assert.equal(record.prompts.length, before + 1);
  record.busy = false; record.failPrompt = "runtime_prompt_rejected";
  const other = (await call("POST", "/api/vcr/studies", { draft: true, name: "Rejected study" })).body.data;
  const rejected = await call("POST", `/api/vcr/studies/${other.id}/start`, input);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.data.state, "rejected");
  const replay = await call("POST", `/api/vcr/studies/${other.id}/start`, input);
  assert.equal(replay.body.data.runId, rejected.body.data.runId);
  assert.equal(replay.body.data.state, "rejected");
  assert.equal(record.prompts.length, before + 2);
  assert.equal((await context.app.vcr.store.studyById(other.id)).status, "draft");
  record.failPrompt = "";
});

test("ordinary followup cannot release an intake canceled after clarification", options, async () => {
  const created = await call("POST", "/api/vcr/studies", { draft: true, name: "Canceled intake" });
  const study = created.body.data;
  const start = await call("POST", `/api/vcr/studies/${study.id}/start`, { brief: "Partial idea", requestId: "cancel_request_1", action: "trial" });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const saved = await context.app.vcr.store.studyById(study.id);
  const project = await context.app.store.requireProject(await context.app.store.userById(saved.userId), study.projectId);
  const run = (await context.app.agentRuns.list(project)).find(row => row.id === start.body.data.runId);
  await context.app.agentRuns.finishInternal(project, run.id, { status: "succeeded", artifacts: [] });
  await context.app.vcr.orchestrator.onRunFinished(project, { ...run, status: "succeeded" });
  await context.app.vcr.orchestrator.holdProgramme(study.id);
  await context.app.vcr.store.saveDefinition({ studyId: study.id, userId: saved.userId,
    pico: { population: "Adults", intervention: "Intervention" }, endpointType: "continuous", intendedUse: "exploratory" });
  assert.equal(await context.app.vcr.orchestrator.onRunFinished(project, { id: "ordinary", sessionId: study.sessionId, status: "succeeded" }), false);
  assert.equal((await context.app.vcr.store.studyById(study.id)).steps.trial.held, true);
});


test("a native input racing after the idle check keeps Start submitted once in the canonical queue without completing definition", options, async () => {
  const created = await call("POST", "/api/vcr/studies", { draft: true, name: "Native queue race" });
  const study = created.body.data;
  record.nativeQueued = true;
  const before = record.prompts.length;
  const input = { brief: "Partial brief awaiting the native turn", requestId: "native_queue_race" };
  try {
    const accepted = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.state, "accepted", "accepted means submitted, not definition completed or computation started");
    const replay = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
    assert.equal(replay.body.data.runId, accepted.body.data.runId);
    assert.equal(record.prompts.length, before + 1);
    assert.equal(record.prompts.at(-1).session, study.sessionId);
    assert.equal(record.prompts.at(-1).text, input.brief);
    assert.equal(record.prompts.at(-1).nativeQueued, true);
    const saved = await context.app.vcr.store.studyById(study.id);
    assert.equal(await context.app.vcr.store.latestDefinition(study.id), null);
    assert.equal(saved.steps.definition.held, true);
    assert.notEqual(saved.steps.definition.status, "done");
    assert.equal(Object.values(saved.steps).filter(step => step.requested).length, 1);
    assert.equal((await context.app.vcr.orchestrator.advance(study.id)).skipped, "paused");
    assert.equal(record.prompts.length, before + 1, "a queued native intake never launches a second definition");
  } finally { record.nativeQueued = false; }
});

test("a delayed identical Start after completion preserves terminal intake state and newly expanded goals", options, async () => {
  const app = context.app;
  const created = (await call("POST", "/api/vcr/studies", { draft: true, name: "Delayed replay" })).body.data;
  const initial = await app.vcr.store.studyById(created.id);
  const project = await app.store.requireProject(await app.store.userById(initial.userId), created.projectId);
  const originalList = app.agentRuns.list;
  const originalClaim = app.vcr.orchestrator.claimIntake;
  let reads = 0; let claims = 0; let releaseReads; let releaseClaim;
  const readsReady = new Promise(resolve => { releaseReads = resolve; });
  const completed = new Promise(resolve => { releaseClaim = resolve; });
  app.agentRuns.list = async function (current) {
    if (current.id === project.id && ++reads <= 2) { if (reads === 2) releaseReads(); await readsReady; return []; }
    return originalList.call(this, current);
  };
  app.vcr.orchestrator.claimIntake = async function (study, input) {
    if (study.id === created.id && ++claims === 2) await completed;
    return originalClaim.call(this, study, input);
  };
  const before = record.prompts.length;
  try {
    const input = { brief: "Partial delayed replay", requestId: "delayed_replay_1" };
    const requests = [call("POST", `/api/vcr/studies/${created.id}/start`, input), call("POST", `/api/vcr/studies/${created.id}/start`, input)];
    const first = await Promise.race(requests);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await app.agentRuns.finishInternal(project, first.body.data.runId, { status: "succeeded", artifacts: [] });
    const run = (await originalList.call(app.agentRuns, project)).find(row => row.id === first.body.data.runId);
    await app.vcr.orchestrator.onRunFinished(project, run);
    await app.vcr.store.setStep(created.id, "evidence", { requested: true, held: false });
    const snapshot = await app.vcr.store.studyById(created.id);
    const mark = await app.vcr.store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND key='run:definition'", [created.id]);
    releaseClaim();
    const results = await Promise.all(requests);
    assert.ok(results.every(result => result.status === 200 && result.body.data.runId === first.body.data.runId));
    assert.deepEqual((await app.vcr.store.studyById(created.id)).steps, snapshot.steps);
    const after = await app.vcr.store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND key='run:definition'", [created.id]);
    assert.equal(after.state, "done"); assert.deepEqual(after.detail, mark.detail);
    assert.equal(record.prompts.length, before + 1);
  } finally { releaseClaim(); app.agentRuns.list = originalList; app.vcr.orchestrator.claimIntake = originalClaim; }
});

test("terminal intake recovery repairs an interrupted old terminal mark with and without an actual definition", options, async () => {
  const app = context.app;
  for (const defined of [false, true]) {
    const study = (await call("POST", "/api/vcr/studies", { draft: true, name: `Crash recovery ${defined}` })).body.data;
    const input = { brief: "Recover the same submitted research brief", requestId: `recover_request_${defined}` };
    const started = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
    const saved = await app.vcr.store.studyById(study.id);
    const project = await app.store.requireProject(await app.store.userById(saved.userId), study.projectId);
    if (defined) await app.vcr.store.saveDefinition({ studyId: study.id, userId: saved.userId,
      pico: { population: "Adults", intervention: "Intervention" }, endpointType: "continuous", intendedUse: "exploratory" });
    await app.agentRuns.finishInternal(project, started.body.data.runId, { status: "succeeded", artifacts: [] });
    const run = (await app.agentRuns.list(project)).find(row => row.id === started.body.data.runId);
    await app.vcr.orchestrator.onRunFinished(project, run);
    // Simulate the previous two-commit crash point: terminal mark persisted, but its intake settlement did not.
    await app.vcr.store.query("UPDATE evimed_vcr.schedule_marks SET state='done', detail=detail-'awaitingInput'-'intakeReleased'-'runStatus' WHERE study_id=$1 AND key='run:definition'", [study.id]);
    await app.vcr.store.setStep(study.id, "definition", { requested: true, held: true });
    const count = record.prompts.length;
    const recovered = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    const current = await app.vcr.store.studyById(study.id);
    const mark = await app.vcr.store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND key='run:definition'", [study.id]);
    assert.equal(current.steps.definition.held, !defined);
    assert.equal(mark.detail.awaitingInput, !defined);
    assert.equal(mark.detail.intakeReleased === true, defined);
    assert.equal(record.prompts.length, count);
    assert.equal(recovered.body.data.state, defined ? "accepted" : "awaiting_input");
  }
});

test("pre-send capacity and late-busy refusals preserve an active study's existing programme goals", options, async () => {
  const app = context.app;
  for (const reason of ["capacity", "late-busy"]) {
    const created = (await call("POST", "/api/vcr/studies", { draft: true, name: `Existing goals ${reason}` })).body.data;
    await app.vcr.store.updateStudy(created.id, { status: "active" });
    await app.vcr.store.setStep(created.id, "definition", { requested: false, held: false });
    await app.vcr.store.setStep(created.id, "trial", { requested: true, held: false });
    const before = await app.vcr.store.studyById(created.id);
    const originalStart = app.runtimeManager.start;
    const originalInbox = app.runtimeManager.sessionInbox;
    let inboxCalls = 0;
    try {
      if (reason === "capacity") app.runtimeManager.start = async () => { throw Object.assign(new Error("capacity"), { code: "runtime_capacity_full", status: 429 }); };
      else app.runtimeManager.sessionInbox = async () => ({ running: ++inboxCalls > 1, queued: 0 });
      const count = record.prompts.length;
      const refused = await call("POST", `/api/vcr/studies/${created.id}/start`, { brief: "A new idea", requestId: `preserve_goals_${reason.replaceAll("-", "_")}` });
      assert.ok(refused.status === 409 || refused.status === 429 || refused.body.data?.state === "rejected", JSON.stringify(refused.body));
      assert.deepEqual((await app.vcr.store.studyById(created.id)).steps, before.steps);
      assert.equal(record.prompts.length, count);
    } finally { app.runtimeManager.start = originalStart; app.runtimeManager.sessionInbox = originalInbox; }
  }
});

test("terminal intake state and goal release roll back together when the PostgreSQL settlement fails", options, async () => {
  const app = context.app;
  const study = (await call("POST", "/api/vcr/studies", { draft: true, name: "Atomic terminal settlement" })).body.data;
  const input = { brief: "Atomic intake research", requestId: "atomic_intake_1" };
  const started = await call("POST", `/api/vcr/studies/${study.id}/start`, input);
  const saved = await app.vcr.store.studyById(study.id);
  const project = await app.store.requireProject(await app.store.userById(saved.userId), study.projectId);
  const run = (await app.agentRuns.list(project)).find(row => row.id === started.body.data.runId);
  await app.vcr.store.saveDefinition({ studyId: study.id, userId: saved.userId,
    pico: { population: "Adults", intervention: "Intervention" }, endpointType: "continuous", intendedUse: "exploratory" });
  const before = await app.vcr.store.studyById(study.id);
  const transaction = app.vcr.store.transaction;
  let injected = false;
  app.vcr.store.transaction = work => transaction.call(app.vcr.store, client => work(new Proxy(client, {
    get(target, key) {
      if (key !== "query") return Reflect.get(target, key);
      return async (sql, values) => {
        if (!injected && /UPDATE evimed_vcr\.schedule_marks SET run_id/.test(sql) && values?.[6] === true) {
          injected = true; throw new Error("injected terminal commit failure");
        }
        return target.query(sql, values);
      };
    },
  })));
  try {
    await assert.rejects(app.vcr.orchestrator.onRunFinished(project, { ...run, status: "succeeded" }), /injected terminal commit failure/);
  } finally { app.vcr.store.transaction = transaction; }
  assert.equal(injected, true);
  const mark = await app.vcr.store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND key='run:definition'", [study.id]);
  assert.equal(mark.state, "running");
  assert.equal(mark.detail.intakeReleased, undefined);
  assert.deepEqual((await app.vcr.store.studyById(study.id)).steps, before.steps);
  await app.vcr.orchestrator.onRunFinished(project, { ...run, status: "succeeded" });
  assert.equal((await app.vcr.store.studyById(study.id)).steps.definition.held, false);
});
