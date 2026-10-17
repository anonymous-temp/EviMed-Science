// The orchestrator's hooks live in the real hosted app over HTTP, on a real
// PostgreSQL of its own: 「让 AI 做」 dispatches the step's run in the project,
// 导出 waits for the project's one run and then goes, a paused project refuses
// by name, the market's operator routes are an operator's, and readiness
// knows the worker is whole. Only the run dispatch itself is faked.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const PASSWORD = "test-only-geo-password";
const accounts = { ops: "geoops", reader: "georeader" };
/** @type {any} */
let context = null;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";
/** @type {any[]} */
const dispatched = [];

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_geoapp_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-geo-orch-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: source.href, operatorMetricsToken: "test-only-metrics-token",
    operatorUsers: [accounts.ops], geoEnabled: true, geoAudience: "all",
    geoDispatchRun: async (/** @type {any} */ input) => {
      dispatched.push(input);
      return { runId: `run-${dispatched.length}`, sessionId: `session-${dispatched.length}`, status: "running" };
    } });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  // The tick is driven by the test, not by the timer.
  await app.geo.worker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0],
      "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, dataDir };
});

after(async () => {
  if (context) {
    await context.app.close();
    await rm(context.dataDir, { recursive: true, force: true });
  }
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`);
    await admin.end();
  }
});

/** @param {string} role @param {string} method @param {string} route @param {unknown} [body] */
async function call(role, method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.sessions[role], body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("「让 AI 做」 dispatches the step's run in the project; 导出 waits for it, then goes; paused refuses by name", options, async () => {
  const created = await call("reader", "POST", "/api/geo/projects", { brandName: "玛仕度肽" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, projectId } = created.body.data;
  const run = await call("reader", "POST", `/api/geo/projects/${id}/run`, { step: "evidence" });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(run.body.data, { accepted: true, runId: "run-1", step: "evidence" }, "the run it started, and no session to go to");
  // What a person is shown of it is the step's sentence; the instruction is the model's.
  assert.equal(dispatched[0].question, "整理产品证据");
  assert.deepEqual([dispatched[0].capabilityId, dispatched[0].projectId, dispatched[0].userId, dispatched[0].dispatchId],
    ["geo-insight", projectId, accounts.reader, "geo-insight-a1"]);
  assert.match(dispatched[0].brief, /玛仕度肽/);
  const page = (await call("reader", "GET", `/api/geo/projects/${id}`)).body.data;
  assert.equal(page.steps.evidence.status, "running");
  assert.equal(page.steps.evidence.requested, true);

  const exported = await call("reader", "POST", `/api/geo/projects/${id}/export`, { kind: "proposal" });
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.body.data, { accepted: true, runId: null, step: null }, "one GEO run per project: the export is taken and waits");
  assert.equal(dispatched.length, 1);
  // The ledger says the insight run ended; the next advance sends the export.
  await context.app.geo.orchestrator.onRunFinished({ userId: accounts.reader, id: projectId },
    { id: "run-1", dispatchId: "geo-insight-a1", status: "failed" });
  await context.app.geo.orchestrator.advance(id);
  assert.equal(dispatched[1].capabilityId, "geo-proposal");
  assert.match(dispatched[1].brief, /提案资料包/);
  assert.equal(dispatched[1].question, "生成提案资料包");

  const paused = await call("reader", "PATCH", `/api/geo/projects/${id}`, { status: "paused" });
  assert.equal(paused.status, 200);
  const refused = await call("reader", "POST", `/api/geo/projects/${id}/run`, { step: "journey" });
  assert.deepEqual([refused.status, refused.body.code], [409, "geo_project_paused"]);
  const foreign = await call("ops", "POST", `/api/geo/projects/${id}/run`, { step: "journey" });
  assert.deepEqual([foreign.status, foreign.body.code], [404, "geo_project_not_found"]);
});

test("the market's operator routes are live and an operator's; readiness knows the worker is whole", options, async () => {
  for (const [method, route, body] of /** @type {const} */ ([["POST", "/api/geo/market/clear-stop", {}],
    ["POST", "/api/geo/market/orders/o-1/resolve", { created: false }], ["POST", "/api/geo/market/orders/o-1/lost", { reason: "window missed" }]])) {
    const refused = await call("reader", method, route, body);
    assert.deepEqual([refused.status, refused.body.code], [403, "geo_operator_required"], route);
  }
  const cleared = await call("ops", "POST", "/api/geo/market/clear-stop", { note: "looked" });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body.data, { cleared: false }, "no stop to clear");
  const unknown = await call("ops", "POST", "/api/geo/market/orders/o-missing/resolve", { created: false });
  assert.deepEqual([unknown.status, unknown.body.code], [404, "geo_order_not_found"]);
  const lost = await call("ops", "POST", "/api/geo/market/orders/o-missing/lost", { reason: "window missed" });
  assert.deepEqual([lost.status, lost.body.code], [404, "geo_order_not_found"]);
  const invalid = await call("ops", "POST", "/api/geo/market/orders/o-missing/resolve", { created: true });
  assert.deepEqual([invalid.status, invalid.body.code], [400, "geo_payload_invalid"], "a created order names the vendor's number");

  const ready = await (await fetch(`${context.base}/api/ready`)).json();
  const geo = ready.data.checks.geo;
  assert.equal(geo.ok, true, JSON.stringify(geo));
  assert.deepEqual(geo.worker.missing, []);
  assert.equal((geo.warnings ?? []).includes("geo_worker_loop_missing"), false);
});

test("what a run delivered is imported before the programme folds it, through the app's own wiring (D-24)", options, async () => {
  const created = await call("reader", "POST", "/api/geo/projects", { brandName: "诺和盈" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, projectId } = created.body.data;
  const asked = await call("reader", "POST", `/api/geo/projects/${id}/run`, { step: "evidence" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const dispatch = dispatched.at(-1);
  assert.equal(dispatch.capabilityId, "geo-insight");
  // The run delivered its claim library into the project's workspace; the control plane heard nothing of its end.
  const owner = await context.app.store.userById(accounts.reader);
  const control = await context.app.store.requireProject(owner, projectId);
  await mkdir(path.join(control.workspaceDir, "deliverables", "geo-insight"), { recursive: true });
  await writeFile(path.join(control.workspaceDir, "deliverables", "geo-insight", "claims.json"), JSON.stringify({ claims: [
    { claimKey: "dosing", statement: "每周一次皮下注射", quote: "本品每周一次皮下注射给药。", sourceRef: "说明书 2025 版", sourceKind: "label" }] }));
  const claims = async () => Number((await context.app.store.database.query("SELECT count(*) AS n FROM evimed_geo.claims WHERE geo_project_id = $1", [id])).rows[0].n);
  assert.equal(await claims(), 0);
  // The next tick finds the run ended in the ledger: it imports the delivery, and only then decides the step.
  const original = context.app.agentRuns.list;
  context.app.agentRuns.list = async () => [{ id: `run-${dispatched.length}`, dispatchId: dispatch.dispatchId, status: "succeeded",
    deliverables: [{ id: "geo-insight", capability: "geo-insight" }] }];
  try {
    await context.app.geo.orchestrator.advance(id);
  } finally {
    context.app.agentRuns.list = original;
  }
  assert.equal(await claims(), 1, "the delivered claim is registered");
  const page = (await call("reader", "GET", `/api/geo/projects/${id}`)).body.data;
  assert.equal(page.steps.evidence.status, "done", "the step is decided on what the import wrote");
  const metrics = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(metrics, /^open_science_geo_run_import_total\{outcome="imported"\} [1-9]\d*$/m, "and the import is counted");
});
