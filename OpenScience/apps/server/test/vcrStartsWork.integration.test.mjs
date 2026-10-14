// Starting a step of a 虚拟临床研究 study does not take the person anywhere (R3, 2026-10-14): in the real hosted app, over HTTP, on a real
// PostgreSQL. The press answers that the request was taken and which run it started — no session to go to; a step a person asked for
// opens the project's runtime for them and runs in it, so the project's conversation is not refused for it, while a step nobody asked
// for just now keeps the bounded runtime it has always reserved; what a person is shown of the run is the step's sentence, and the
// instruction the model works from rides in the run's context; and the study page says what is going on.
//
// Only what leaves the process is replaced: the run store's dispatch and the runtime's prompt and reservation are recorders (a run
// needs a kernel — `serverComposition.test.mjs` does the same for a scheduled execution), the engine's `fetch` answers its health.
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
const record = { starts: /** @type {any[]} */ ([]), reserved: /** @type {any[]} */ ([]), prompts: /** @type {any[]} */ ([]), dispatches: /** @type {any[]} */ ([]) };

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrgo");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-vcr-go-"));
  const plane = path.join(dataDir, "plane");
  await mkdir(plane, { recursive: true });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    rateLimitMaxRequests: 100_000, authRateLimitMaxRequests: 1_000, modelGatewaySigningSecret: randomBytes(32).toString("hex"),
    vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3_600_000, vcrDataPlaneDir: plane,
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
  app.runtimeManager.dispatchPrompt = async (/** @type {any} */ _project, /** @type {string} */ session, /** @type {any} */ request) => {
    record.prompts.push({ session, ...request });
    return { accepted: true };
  };
  app.researchSessions.put = async (/** @type {any} */ _project, /** @type {string} */ _id, /** @type {any} */ binding) => binding;
  app.agentRuns.dispatch = async (/** @type {any} */ _project, /** @type {any} */ input, /** @type {any} */ sendPrompt) => {
    record.dispatches.push(input);
    const id = `run_vcr_${record.dispatches.length}`;
    await sendPrompt({ sessionId: input.sessionId }, { id, kernelRequestIds: [] });
    return { id, status: "running" };
  };
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

async function newStudy(name = "EV-201 虚拟患者") {
  const created = await call("POST", "/api/vcr/studies", { name, question: "在二线 NSCLC 中，试验药相对多西他赛的无进展生存", dataTier: "T0", intendedUse: "exploratory" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return /** @type {{ id: string, projectId: string }} */ (created.body.data);
}

/** Forget everything the runtime was asked, and the stand-in runtimes of an earlier test. */
function reset() {
  context.app.runtimeManager.runtimes.clear();
  for (const list of Object.values(record)) list.length = 0;
}

test("a press answers that the step was taken and which run it started — and carries no session to go to", options, async () => {
  reset();
  const study = await newStudy("按下一步");
  const answer = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const data = answer.body.data;
  assert.deepEqual(Object.keys(data).sort(), ["accepted", "queuedBehind", "runId", "step"], "the answer's whole shape");
  assert.equal(data.accepted, true);
  assert.equal(data.step, "definition");
  assert.match(String(data.runId), /^run_vcr_/);
  assert.deepEqual(data.queuedBehind, []);
});

test("a step a person asked for opens the project's runtime for them and runs in it: no bounded runtime, the conversation stays open", options, async () => {
  reset();
  const study = await newStudy("人在场");
  const answer = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  assert.equal(answer.status, 200);
  assert.deepEqual(record.starts, [{ opening: true }], "the start the shell's own frame makes: the person is opening this project's work");
  assert.deepEqual(record.reserved, [], "nothing is reserved, so nothing refuses the project's own conversation while the step runs");
  assert.equal(record.prompts.length, 1);
  assert.equal(record.prompts[0].allowBounded, false);
  assert.doesNotMatch(String(record.prompts[0].text), /evimed-budget-scope/, "an open runtime takes no budget marker (the gateway refuses one)");
  // The study says where the run took place and that the conversation is not held.
  const view = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.equal(view.activity.run.placement, "open-runtime");
  assert.equal(view.activity.run.locked, false);
  assert.equal(view.activity.run.step, "definition");
  assert.equal(view.activity.run.id, answer.body.data.runId);
});

test("what a person is shown of the run is the step's sentence; the instruction the model works from is the run's context", options, async () => {
  reset();
  const study = await newStudy("可见问句");
  await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  const [dispatch] = record.dispatches;
  assert.equal(dispatch.question, "整理研究定义", "the run is listed and titled by what a person would say");
  assert.match(String(dispatch.brief), /vcr_read/, "the brief is the model's, whole");
  assert.equal(dispatch.automated, true);
  const [prompt] = record.prompts;
  assert.match(String(prompt.text), /^整理研究定义\n\n<evimed-vcr-run>/, "the first message of the session is the sentence, under the module's mark");
  assert.doesNotMatch(String(prompt.text), /vcr_read|vcr_write|exploratory|数据档位/, "none of the machine's words");
  assert.match(String(prompt.system), /<evimed-vcr-brief>\n[\s\S]*vcr_read[\s\S]*<\/evimed-vcr-brief>/, "the instruction is in the run's context");
});

test("a pass nobody asked for keeps the bounded runtime, says why it holds the project, and the study says the conversation is held", options, async () => {
  reset();
  const study = await newStudy("无人在场");
  // A study the programme runs by itself (the worker's pass, `attended: false`).
  await context.app.vcr.orchestrator.advance(study.id);
  assert.deepEqual(record.starts, [], "nobody is present: no runtime is opened for anybody");
  assert.equal(record.reserved.length, 1);
  assert.equal(record.reserved[0].reason, "module-step", "the project is held for a step of a module, and the 423 says so");
  assert.equal(record.prompts[0].allowBounded, true);
  assert.match(String(record.prompts[0].text), /evimed-budget-scope/, "a bounded runtime is capped by the signed scope the prompt carries");
  const view = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.deepEqual([view.activity.run.placement, view.activity.run.locked], ["bounded", true]);
});

test("a step asked for while another is out is queued behind it, and the study says what waits for what", options, async () => {
  reset();
  const study = await newStudy("排队");
  assert.equal((await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" })).status, 200);
  const second = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "evidence" });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.runId, null, "the study's one run slot is held");
  assert.deepEqual(second.body.data.queuedBehind, [{ step: "evidence", waitingFor: "definition" }]);
  const view = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.deepEqual(view.activity.queue, [{ step: "evidence", waitingFor: "definition" }]);
  assert.equal(view.activity.run.step, "definition");
  assert.equal(view.steps.evidence.status, "queued");
  assert.equal(view.steps.definition.status, "running", "queued and running are two states, and the read model keeps them apart");
  assert.equal(view.next, null, "what is next waits on a step that is under way");
});

test("a person's cancel stops the run and the programme does not send it again; asking for the step again does", options, async () => {
  reset();
  const study = await newStudy("取消");
  const started = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  const runId = started.body.data.runId;
  // The ledger's own stop, as the run store ends a run a person cancelled: the module's completion hook runs with `canceled`.
  const dispatched = record.dispatches[0];
  await context.app.vcr.orchestrator.onRunFinished({ userId: OWNER, id: study.projectId }, { id: runId, dispatchId: dispatched.dispatchId, status: "canceled" });
  const settled = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.equal(settled.steps.definition.status, "none", "the step reads as not started, not as failed");
  assert.equal(settled.activity?.last?.outcome ?? "canceled", "canceled");
  const sent = record.dispatches.length;
  await context.app.vcr.orchestrator.advance(study.id);
  assert.equal(record.dispatches.length, sent, "a run a person stopped is not sent again by the programme");
  // Asking for the step is the person's decision, and runs it.
  const again = await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  assert.equal(again.status, 200);
  assert.ok(again.body.data.runId, "the step goes out again when it is asked for");
  assert.equal(record.dispatches.length, sent + 1);
});

test("a study with nothing said about it refuses a press by name, and the page reads no next step", options, async () => {
  reset();
  const created = await call("POST", "/api/vcr/studies", {});
  assert.equal(created.status, 201);
  const refused = await call("POST", `/api/vcr/studies/${created.body.data.id}/run`, { step: "definition" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "vcr_definition_missing");
  const view = (await call("GET", `/api/vcr/studies/${created.body.data.id}`)).body.data;
  assert.equal(view.next, null);
  assert.equal(view.activity, null);
  assert.equal(record.dispatches.length, 0);
});

test("the study's conversation exists from its creation, and the project list says when each project was last used", options, async () => {
  reset();
  const study = await newStudy("会话");
  const view = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.equal(typeof view.conversation.sessionId, "string");
  assert.match(view.conversation.sessionId, /^vcr-/);
  assert.equal(view.sessionId, view.conversation.sessionId);
  // The conversation is stable: read again, and after a step has run in the project, it is the same one.
  await call("POST", `/api/vcr/studies/${study.id}/run`, { step: "definition" });
  const again = (await call("GET", `/api/vcr/studies/${study.id}`)).body.data;
  assert.deepEqual(again.conversation, view.conversation);
  assert.notEqual(record.dispatches[0].sessionId, view.conversation.sessionId, "the step's own session is not the study's conversation");

  const projects = (await call("GET", "/api/projects")).body.data;
  const mine = projects.find((/** @type {any} */ project) => project.id === study.projectId);
  assert.ok(mine, "the study's project is listed");
  assert.equal(typeof mine.lastActiveAt, "string");
  assert.ok(Date.parse(mine.lastActiveAt) >= Date.now() - 60_000, "a project made a moment ago was last active a moment ago");
  const named = projects.filter((/** @type {any} */ project) => project.lastActiveAt !== null);
  assert.ok(named.length >= 1);
});
