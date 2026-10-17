// 循证 GEO's programme runs are quiet (R19, 2026-10-17; the second instance of what 虚拟临床研究 had on 2026-10-14): in the real hosted app,
// over HTTP, on a real PostgreSQL. A step the platform runs for the person is no conversation of theirs — what is shown of the run is the
// step's sentence, the instruction the model works from rides in the run's context, no conversation list draws the run, the header's
// 「对话」 is the person's own conversation and never a step's, and the run is read in the AI-run record.
//
// Only what leaves the process is replaced: the run store's dispatch and the runtime's reservation and prompt are recorders (a run needs a
// kernel — `vcrStartsWork.integration.test.mjs` and `serverComposition.test.mjs` do the same); the ledger rows the record and the lists
// read are written through the store's own `reserveRun`, as a dispatch would.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
const PASSWORD = "test-only-geo-password";
const OWNER = `own${suffix}`;

/** @type {any} */ let context = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */ let isolated = null;
/** What the runtime was asked, in order. */
const record = { reserved: /** @type {any[]} */ ([]), prompts: /** @type {any[]} */ ([]), dispatches: /** @type {any[]} */ ([]) };

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoq");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-geo-q-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    rateLimitMaxRequests: 100_000, authRateLimitMaxRequests: 1_000, modelGatewaySigningSecret: randomBytes(32).toString("hex"),
    geoEnabled: true, geoAudience: "all", geoPollMs: 3_600_000,
  });
  // The worker is the module's own timer; the test drives the orchestrator by hand.
  await app.geo.worker.close();
  app.residentProfiles.forDispatch = async () => ({ text: "", due: false, memories: [], delivered: async () => {} });
  app.runtimeManager.reserveBoundedRuntimeSession = async (/** @type {any} */ _project, /** @type {any} */ scope) => {
    record.reserved.push(scope);
    return { id: `session_reserved_${record.reserved.length}`, kernel: "dsh" };
  };
  app.runtimeManager.endBoundedRuntime = async () => true;
  app.runtimeManager.dispatchPrompt = async (/** @type {any} */ _project, /** @type {string} */ session, /** @type {any} */ request) => {
    record.prompts.push({ session, ...request });
    return { accepted: true };
  };
  app.agentRuns.dispatch = async (/** @type {any} */ _project, /** @type {any} */ input, /** @type {any} */ sendPrompt) => {
    record.dispatches.push(input);
    const id = `run_geo_${record.dispatches.length}`;
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
    context.app.runtimeManager.runtimes.clear();
    await context.app.close();
    await rm(context.dataDir, { recursive: true, force: true });
  }
  await isolated?.drop();
});

/** @param {string} method @param {string} route @param {unknown} [body] @param {string} [inProject] the control-plane project a project-scoped route reads */
async function call(method, route, body, inProject) {
  const response = await fetch(`${context.base}${route}`, { method,
    headers: inProject ? { ...context.headers, "x-open-science-project": inProject } : context.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** A GEO project of the owner, and the control-plane project it lives in. */
async function newProject(brandName = "玛仕度肽") {
  const created = await call("POST", "/api/geo/projects", { brandName, coverageDays: 90, engines: ["deepseek"] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return /** @type {{ id: string, projectId: string, sessionId: string, bound: boolean }} */ (created.body.data);
}

/** Forget everything the runtime was asked. */
function reset() {
  context.app.runtimeManager.runtimes.clear();
  for (const list of [record.reserved, record.prompts, record.dispatches]) list.length = 0;
}

test("a press answers that the step was taken and which run it started — and carries no session to go to", options, async () => {
  reset();
  const project = await newProject("按下一步");
  const answer = await call("POST", `/api/geo/projects/${project.id}/run`, { step: "evidence" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.data, { accepted: true, runId: "run_geo_1", step: "evidence" });
  const exported = await call("POST", `/api/geo/projects/${project.id}/export`, { kind: "proposal" });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.deepEqual(Object.keys(exported.body.data).sort(), ["accepted", "runId", "step"], "no session in an export's answer either");
  assert.equal(exported.body.data.accepted, true);
  assert.equal(exported.body.data.step, null);
});

test("what a person is shown of the run is the step's sentence; the instruction the model works from is the run's context", options, async () => {
  reset();
  const project = await newProject("可见问句");
  await call("POST", `/api/geo/projects/${project.id}/run`, { step: "evidence" });
  const [dispatch] = record.dispatches;
  assert.equal(dispatch.question, "整理产品证据", "the run is listed and titled by what a person would say");
  assert.equal(dispatch.effectiveRouteReason, "geo:evidence");
  assert.match(String(dispatch.brief), /^“循证 GEO”自动运行/, "the instruction is kept as the brief, for the delivery gate and the model");
  assert.match(String(dispatch.brief), /geo_read/);
  const [prompt] = record.prompts;
  assert.match(String(prompt.text), /^整理产品证据\n\n<evimed-geo-run>geo-insight-a1<\/evimed-geo-run>/, "the first message of the session is the sentence, under the module's mark");
  assert.doesNotMatch(String(prompt.text), /geo_read|循证 GEO|产品：/, "none of the instruction is a message anybody sent");
  assert.match(String(prompt.system), /<evimed-geo-brief>\n“循证 GEO”自动运行[\s\S]*geo_read[\s\S]*<\/evimed-geo-brief>/, "the instruction is in the run's context");
  // The documents the platform writes are asked for in the same way (a project's one run slot is taken until the first ends, so another project's).
  const other = await newProject("可见问句二");
  await call("POST", `/api/geo/projects/${other.id}/export`, { kind: "weekly" });
  assert.equal(record.dispatches.at(-1).question, "生成周报");
  assert.equal(record.dispatches.at(-1).effectiveRouteReason, "geo:export-weekly");
  assert.match(String(record.prompts.at(-1).text), /^生成周报\n\n<evimed-geo-run>/);
});

/** A run the way a dispatch records it: in the project, in a session of its own, under the route reason the orchestrator wrote. */
async function ledgerRun(/** @type {{ projectId: string }} */ geo, /** @type {Record<string, any>} */ input) {
  const owner = await context.app.store.userById(OWNER);
  const project = await context.app.store.requireProject(owner, geo.projectId);
  const sessionId = input.sessionId;
  await context.app.researchSessions.put(project, sessionId, { mode: "specialist", agentId: input.agentId ?? "geo-insight", agentVersion: input.agentVersion });
  const session = await context.app.researchSessions.get(project, sessionId);
  const { run } = await context.app.agentRuns.reserveRun(project, session, {
    baselineCursor: null, dispatchId: input.dispatchId ?? null, automated: input.automated ?? false, question: input.question ?? null,
    effectiveRouteReason: input.reason ?? "session-binding",
  });
  return run;
}

test("a programme step is no conversation: the run list marks it, the header's 「对话」 is the person's own, and the record lists it", options, async () => {
  reset();
  const geo = await newProject("安静的步骤");
  const agent = (await context.app.agentRegistry)?.get?.("geo-insight");
  assert.ok(agent, "this build's registry has the GEO capabilities");
  // The person's own conversation: the one the project was made with (bound to geo-insight).
  assert.equal(geo.bound, true);
  const own = geo.sessionId;
  // Three steps the platform ran, each in a session of its own and each newer than the person's conversation.
  await ledgerRun(geo, { sessionId: "step-session-1", agentVersion: agent.version, dispatchId: "geo-insight-a1", automated: true, reason: "geo:evidence", question: "整理产品证据" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await ledgerRun(geo, { sessionId: "step-session-2", agentVersion: agent.version, dispatchId: "geo-export-weekly-2026-10-12-a1", automated: true, reason: "geo:export-weekly", question: "生成周报" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await ledgerRun(geo, { sessionId: "step-session-3", agentVersion: agent.version, dispatchId: "geo-content-1-a1", automated: true, reason: "geo:content", question: "写第 1 批稿件" });

  // The newest session of the project is a step's; the project's page does not send the person there.
  const page = await call("GET", `/api/geo/projects/${geo.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.data.sessionId, own, "the header's 「对话」 opens the person's conversation, never the latest run");

  // A conversation the person has since begun is theirs, and is the newest of theirs.
  await ledgerRun(geo, { sessionId: "chat-session-1", agentVersion: agent.version, automated: false, reason: "session-binding", question: "这个药的核心卖点是什么" });
  assert.equal((await call("GET", `/api/geo/projects/${geo.id}`)).body.data.sessionId, "chat-session-1");

  // The record: what the programme did, by what it was, newest first, with no way into a conversation and nothing of the instruction.
  const listed = await call("GET", `/api/geo/projects/${geo.id}/runs`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.data.runs.map((/** @type {any} */ run) => [run.sessionId, run.label]), [
    ["step-session-3", "写一批稿件"], ["step-session-2", "生成周报"], ["step-session-1", "整理产品证据"],
  ]);
  for (const run of listed.body.data.runs) {
    assert.ok(["running", "finished", "stopped"].includes(run.state), run.state);
    assert.ok(Number.isFinite(Date.parse(run.startedAt)), "a time the page can say");
  }
  assert.equal(JSON.stringify(listed.body.data).includes("geo:"), false, "no route reason, no brief");

  // The ledger says what each run is, once: the list of runs carries the mark, so no conversation list matches a route reason of its own.
  const runs = (await call("GET", "/api/agent-runs", undefined, geo.projectId)).body.data;
  const roles = Object.fromEntries(runs.map((/** @type {any} */ run) => [run.sessionId, run.role ?? null]));
  assert.deepEqual([roles["step-session-1"], roles["step-session-2"], roles["step-session-3"], roles["chat-session-1"]], ["programme", "programme", "programme", null]);
});

test("a GEO project whose only sessions are steps' has no conversation of the person's yet: the page begins one", options, async () => {
  reset();
  const geo = await newProject("只有步骤");
  const agent = (await context.app.agentRegistry)?.get?.("geo-insight");
  assert.ok(agent);
  await ledgerRun(geo, { sessionId: "step-only-1", agentVersion: agent.version, dispatchId: "geo-insight-a1", automated: true, reason: "geo:evidence", question: "整理产品证据" });
  const owner = await context.app.store.userById(OWNER);
  const project = await context.app.store.requireProject(owner, geo.projectId);
  // The conversation the project was made with is not among its sessions any more (a project whose rows were cleaned): only a step's is.
  const real = context.app.researchSessions.list.bind(context.app.researchSessions);
  context.app.researchSessions.list = async (/** @type {any} */ scoped) => (await real(scoped)).filter((/** @type {any} */ entry) => entry.sessionId === "step-only-1");
  try {
    assert.deepEqual((await context.app.researchSessions.list(project)).map((/** @type {any} */ entry) => entry.sessionId), ["step-only-1"]);
    assert.equal((await call("GET", `/api/geo/projects/${geo.id}`)).body.data.sessionId, null, "a step's session is nobody's conversation");
  } finally {
    context.app.researchSessions.list = real;
  }
});
