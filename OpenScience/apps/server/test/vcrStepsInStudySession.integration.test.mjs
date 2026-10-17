// A step of a 虚拟临床研究 study as a turn of the study's own conversation (R19 phase 2, `OPEN_SCIENCE_VCR_STEPS_IN_STUDY_SESSION`): in the
// real hosted app, over HTTP, on a real PostgreSQL, with the real run ledger.
//
// What leaves the process is replaced: the runtime's start, reservation, session minting, prompt and stop are recorders (a run needs a
// kernel — the live checks are in the hand-off), the engine's `fetch` answers its health, and the run monitor is not started. The study's
// dispatch (`dispatchVcrRun`), the run ledger, the research sessions and the orchestrator are the real ones — which is the point: the
// first prototype was green against a recorder and poisoned the project's ledger on a real kernel, because the ledger's fold refused a
// row whose capability was not the conversation's binding.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createWebApiApp } from "../src/server.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
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
const record = { starts: /** @type {any[]} */ ([]), reserved: /** @type {any[]} */ ([]), prompts: /** @type {any[]} */ ([]),
  stops: /** @type {string[]} */ ([]), minted: /** @type {string[]} */ ([]), noRoom: false };

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrturn");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-vcr-turn-"));
  const plane = path.join(dataDir, "plane");
  await mkdir(plane, { recursive: true });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    rateLimitMaxRequests: 100_000, authRateLimitMaxRequests: 1_000, modelGatewaySigningSecret: randomBytes(32).toString("hex"),
    vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3_600_000, vcrDataPlaneDir: plane, vcrStepsInStudySession: true,
    vcrEngineUrl: "http://engine.test:8080", vcrEngineToken: "t".repeat(40), vcrEngineReceiptKey: "r".repeat(40),
    vcrFetch: async (/** @type {any} */ url) => {
      const body = new URL(String(url)).pathname === "/health" ? { ok: true, engineVersion: "test", rVersion: "test", methods: [], packageLockHash: "" } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
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
  app.runtimeManager.createRuntimeSession = async () => {
    if (record.noRoom) throw Object.assign(new Error("full"), { status: 429, code: "runtime_capacity_full" });
    record.minted.push(`kernel-session-${record.minted.length + 1}`);
    return { id: record.minted.at(-1), kernel: "dsh" };
  };
  app.runtimeManager.dispatchPrompt = async (/** @type {any} */ _project, /** @type {string} */ session, /** @type {any} */ request) => {
    record.prompts.push({ session, ...request });
    return { accepted: true };
  };
  app.runtimeManager.cancelRuntimeSession = async (/** @type {any} */ _project, /** @type {string} */ session) => { record.stops.push(session); return true; };
  // The run ledger is the real one. The kernel it reads a session's history from is not there, and no run is watched to its end here.
  app.agentRuns.readSessionHistory = async () => [];
  app.agentRuns.scheduleMonitor = () => {};
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
    context.app.runtimeManager.runtimes.clear();
    await context.app.close();
    await rm(context.dataDir, { recursive: true, force: true });
  }
  await isolated?.drop();
});

/** @param {string} method @param {string} route @param {unknown} [body] @param {string} [project] */
async function call(method, route, body, project) {
  const response = await fetch(`${context.base}${route}`, { method, headers: { ...context.headers, ...(project ? { "x-open-science-project": project } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function newStudy(name = "EV-201 虚拟患者") {
  const created = await call("POST", "/api/vcr/studies", { name, question: "在二线 NSCLC 中，试验药相对多西他赛的无进展生存", dataTier: "T0", intendedUse: "exploratory" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return /** @type {{ id: string, projectId: string, sessionId: string }} */ (created.body.data);
}

/** The study's project's runs, as the page's own reads list them. @param {string} projectId */
async function runsOf(projectId) {
  const listed = await call("GET", "/api/agent-runs", undefined, projectId);
  assert.equal(listed.status, 200, `the project's runs are readable: ${JSON.stringify(listed.body)}`);
  return /** @type {any[]} */ (listed.body.data);
}

/** What the definition run writes through the gateway's `vcr_write`: the step reads done once it is on file. @param {string} studyId */
async function writeDefinition(studyId) {
  const study = await context.app.vcr.store.studyById(studyId);
  const written = await vcrRuntimeWrite({ store: context.app.vcr.store, service: context.app.vcr.service, orchestrator: context.app.vcr.orchestrator, study, what: "definition", items: null,
    data: { pico: { population: "二线 NSCLC", intervention: "EV", comparator: "化疗", outcome: "PFS" }, endpointType: "time_to_event",
      estimand: { population: "二线 NSCLC", variable: "PFS", treatment: "EV 单药", intercurrentEvents: [{ event: "后续抗肿瘤治疗", strategy: "treatment_policy" }], summary: "风险比" },
      fieldSources: { endpointType: "AI 设定：按主要终点的测量方式" } } });
  assert.equal(written.ok, true, JSON.stringify(written.issues));
}

/** A run that ends on its own, as the monitor ends it: the module's completion hook runs and the programme goes on. @param {string} projectId @param {string} runId */
async function finishRun(projectId, runId) {
  const project = await context.app.store.requireProject(await context.app.store.userById(OWNER), projectId);
  await context.app.agentRuns.finishInternal(project, runId, { status: "succeeded", artifacts: [] });
}

/** Forget everything the runtime was asked, and the stand-in runtimes of an earlier test. */
function reset() {
  context.app.runtimeManager.runtimes.clear();
  for (const list of [record.starts, record.reserved, record.prompts, record.stops]) list.length = 0;
  record.noRoom = false;
}

test("a step a person asked for is a turn of the study's own conversation, recorded as the step's capability, and the conversation keeps its binding", options, async () => {
  reset();
  const study = await newStudy("会话里的一步");
  const view = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  const conversation = view.conversation.sessionId;
  assert.equal(view.conversation.exists, true);
  const answer = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(Object.keys(answer.body.data).sort(), ["accepted", "queuedBehind", "runId", "step"], "the press answers as it always did: nothing to go to");

  // Where it took place: the researcher's runtime, in the conversation the study has — no session of its own, nothing reserved.
  assert.deepEqual(record.starts, [{ opening: true }]);
  assert.deepEqual(record.reserved, []);
  assert.equal(record.prompts.length, 1);
  assert.equal(record.prompts[0].session, conversation, "the prompt goes into the study's conversation");
  assert.equal(record.prompts[0].allowBounded, false);
  assert.match(String(record.prompts[0].text), /^整理研究定义\n\n<evimed-vcr-run>/, "what the person reads is the step's sentence under the module's mark");
  assert.doesNotMatch(String(record.prompts[0].text), /vcr_read|vcr_write|exploratory|数据档位/, "none of the machine's words");
  assert.match(String(record.prompts[0].system), /<evimed-vcr-brief>[\s\S]*vcr_read[\s\S]*<\/evimed-vcr-brief>/, "the instruction travels in the run's context");
  assert.equal(record.prompts[0].routedCapability, "vcr-protocol", "the index states the capability the turn is of");

  // The ledger: one run, in that conversation, of the step's capability, a turn of the conversation and not one of the hidden programme's.
  const runs = await runsOf(study.projectId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, answer.body.data.runId);
  assert.equal(runs[0].sessionId, conversation);
  assert.equal(runs[0].effectiveAgentId, "vcr-protocol");
  assert.equal(runs[0].effectiveRouteReason, "vcr:turn:definition");
  assert.equal(runs[0].question, "整理研究定义");
  assert.equal(runs[0].automated, true);
  assert.equal(runs[0].role ?? null, null, "listed with the person's conversation, not left out of it");
  // The conversation is what it was: bound to the analyst, still the one the study records.
  const sessions = (await call("GET", "/api/research-sessions", undefined, study.projectId)).body.data;
  const bound = sessions.find((/** @type {any} */ item) => item.sessionId === conversation);
  assert.deepEqual([bound.mode, bound.agentId], ["specialist", "vcr-protocol"]);
  assert.equal(sessions.length, 1, "and nothing else was bound for the step");
  const after = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.deepEqual(after.conversation, view.conversation);
  // The page's read model follows the turn as it follows a hidden run.
  assert.equal(after.activity.run.placement, "open-runtime");
  assert.equal(after.activity.run.id, answer.body.data.runId);
  assert.equal(after.steps.definition.status, "running");
});

test("the next step is a turn of its own capability in the same conversation, and the ledger reads after it", options, async () => {
  reset();
  const study = await newStudy("两步");
  const conversation = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data.conversation.sessionId;
  const first = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  // Asked for while the first is out: it waits behind it, and goes out as the next turn when the first ends.
  const second = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "evidence" });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.runId, null);
  assert.deepEqual(second.body.data.queuedBehind, [{ step: "evidence", waitingFor: "definition" }]);
  assert.equal(record.prompts.length, 1);
  await writeDefinition(study.id);
  await finishRun(study.projectId, first.body.data.runId);
  // The incident of the first prototype: the second capability is not the conversation's binding, and the ledger refused the row for it.
  assert.equal(record.prompts.length, 2, "the queued step is sent when the first one ends");
  assert.equal(record.prompts[1].session, conversation, "into the same conversation");
  assert.equal(record.prompts[1].routedCapability, "vcr-evidence");
  assert.match(String(record.prompts[1].text), /^找证据、整理假设卡\n\n<evimed-vcr-run>/);
  const runs = await runsOf(study.projectId);
  assert.equal(runs.length, 2);
  const evidence = runs.find((/** @type {any} */ run) => run.effectiveRouteReason === "vcr:turn:evidence");
  assert.equal(evidence.sessionId, conversation);
  assert.equal(evidence.effectiveAgentId, "vcr-evidence");
  assert.equal(evidence.effectiveRuntimeAgent, "evimed-vcr-evidence");
  assert.equal(runs.every((/** @type {any} */ run) => (run.role ?? null) === null), true, "both are turns of the conversation");
  const view = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.equal(view.activity.run.step, "evidence");
  assert.equal(view.activity.run.id, evidence.id);
});

test("a person's stop of a step that is a turn of the conversation stops the conversation's turn, and the conversation stays usable", options, async () => {
  reset();
  const study = await newStudy("取消");
  const conversation = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data.conversation.sessionId;
  assert.equal((await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" })).status, 200);
  const stopped = await call("POST", `/api/vcr/studies/${study.id}/cancel`, {});
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.deepEqual(record.stops, [conversation], "the kernel is asked to stop the conversation's turn");
  const runs = await runsOf(study.projectId);
  assert.equal(runs[0].status, "canceled");
  // What the stopped step left in the conversation is let go (found live: the question typed next resumed the step that was stopped):
  // the dispatch's files are replaced by a revision that routes nowhere and carries nothing, under a run of the conversation's own.
  const sessionDir = path.join(context.dataDir, "users", OWNER, "projects", study.projectId, "workspace", ".evimed-brief", "sessions", conversation);
  const index = JSON.parse(await readFile(path.join(sessionDir, "index.json"), "utf8"));
  assert.equal(index.capability, undefined, "the next turn is routed by the conversation's binding, not by the step");
  assert.match(String(index.runId), /^native_[0-9a-f]{32}$/);
  assert.match(String(index.contextRevision), /^release_/);
  assert.equal(index.sessionId, conversation);
  for (const file of ["context.md", "memory.md", "research-brief.md"]) assert.equal(await readFile(path.join(sessionDir, file), "utf8"), "", `${file} carries nothing`);
  const view = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.equal(view.conversation.sessionId, conversation, "the conversation is the same one");
  // The next press is a turn in it again: a stop leaves the conversation as it found it.
  const again = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(record.prompts.at(-1).session, conversation);
});

test("a step nobody is present for, with the runtime closed, keeps the hidden programme session and the bounded runtime", options, async () => {
  reset();
  const study = await newStudy("无人在场");
  const conversation = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data.conversation.sessionId;
  // The worker's pass: no press, and the researcher's runtime is not open.
  context.app.runtimeManager.runtimes.clear();
  await context.app.vcr.orchestrator.advance(study.id);
  assert.deepEqual(record.starts, [], "nobody is present: no runtime is opened for anybody");
  assert.equal(record.reserved.length, 1);
  assert.equal(record.prompts.length, 1);
  assert.notEqual(record.prompts[0].session, conversation, "the study's conversation is not written into while nobody is there");
  assert.equal(record.prompts[0].allowBounded, true);
  const runs = await runsOf(study.projectId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].effectiveRouteReason, "vcr:definition");
  assert.equal(runs[0].role, "programme");
  assert.notEqual(runs[0].sessionId, conversation);
  // It is the study's record of background work, and the conversation's own turns are not.
  const background = (await call("GET", `/api/vcr/studies/${study.id}/runs`)).body.data.runs;
  assert.equal(background.length, 1);
});

test("a pass that finds the researcher's runtime open runs in their conversation, whoever started it", options, async () => {
  reset();
  const study = await newStudy("接着做");
  const conversation = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data.conversation.sessionId;
  const first = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  await writeDefinition(study.id);
  // The run's end hands the programme to the orchestrator unattended (`onRunFinished` → `advance`): nobody pressed anything now, and the
  // runtime is the one the person has open, so the next step is the next turn of their conversation.
  await finishRun(study.projectId, first.body.data.runId);
  assert.equal(record.prompts.length, 2, "the next step is sent without a press");
  assert.equal(record.prompts[1].session, conversation);
  assert.deepEqual(record.reserved, []);
  const runs = await runsOf(study.projectId);
  assert.deepEqual(runs.map((/** @type {any} */ run) => run.effectiveRouteReason).sort(), ["vcr:turn:definition", "vcr:turn:evidence"]);
  // The first step let go of the conversation before the next one was sent into it: the next dispatch's files are the ones that stand.
  assert.equal(record.prompts[1].routedCapability, "vcr-evidence");
  // None of it is in the study's list of background work: it is all in the conversation.
  assert.deepEqual((await call("GET", `/api/vcr/studies/${study.id}/runs`)).body.data.runs, []);
});

test("a study whose conversation cannot be made runs the step in a session of its own, as it did before", options, async () => {
  reset();
  record.noRoom = true;
  const study = await newStudy("没有会话");
  const view = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.deepEqual(view.conversation, { sessionId: null, exists: false });
  const answer = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(record.prompts.length, 1);
  assert.match(String(record.prompts[0].session), /^session_/, "a session the platform made for the step");
  const runs = await runsOf(study.projectId);
  assert.equal(runs[0].effectiveRouteReason, "vcr:definition");
  assert.equal(runs[0].role, "programme");
  record.noRoom = false;
});
