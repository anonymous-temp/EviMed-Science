// 循证 GEO in the real hosted app over HTTP, against a real PostgreSQL:
// creating a GEO project makes a real control-plane project (the same path as
// `POST /api/projects`), a brand written by the run names it, the audience
// decides who sees the module, readiness and metrics report it, and deleting
// the control-plane project or the account takes the GEO rows with it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { geoScreenshotFile } from "../src/geoScreenshots.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
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
const accounts = { operator: `ops${suffix}`, preview: `preview${suffix}`, reader: `reader${suffix}`, leaver: `leaver${suffix}`,
  lastLeaver: `lastleaver${suffix}` };
const PASSWORD = "test-only-geo-password";
/** @type {any} */
let context = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoapp");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-geo-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    operatorUsers: [accounts.operator], geoEnabled: true, geoAudience: "operators", geoPreviewUsers: [accounts.preview, accounts.leaver, accounts.lastLeaver] });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
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
  await isolated?.drop();
});

/** @param {string} role @param {string} method @param {string} route @param {unknown} [body] */
async function call(role, method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.sessions[role], body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

/** @param {string} sql @param {unknown[]} values */
const rows = async (sql, values) => (await context.app.store.database.query(sql, values)).rows;

test("a new GEO project is a real control-plane project, bound as far as this build's registry allows, and listed", options, async () => {
  const created = await call("preview", "POST", "/api/geo/projects", { brandName: "Wegovy", coverageDays: 60 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, projectId, sessionId, bound } = created.body.data;
  const [control] = await rows("SELECT id, name FROM evimed_control.projects WHERE user_id = $1 AND id = $2", [accounts.preview, projectId]);
  assert.deepEqual(control, { id: projectId, name: "Wegovy" });
  assert.equal(projectId, "wegovy", "derived from the name the way POST /api/projects derives it");
  const registry = await context.app.agentRegistry;
  const capability = registry?.get?.("geo-insight") ?? null;
  assert.equal(bound, Boolean(capability), "bound to geo-insight exactly when this build's registry has it");
  const page = await call("preview", "GET", `/api/geo/projects/${id}`);
  assert.equal(page.body.data.sessionId, bound ? sessionId : null, "the latest conversation is the bound one, or none yet");
  assert.equal(page.body.data.coverageDays, 60);
  const project = await context.app.store.requireProject(await context.app.store.userById(accounts.preview), projectId);
  const sessions = await context.app.researchSessions.list(project);
  assert.equal(sessions.some((/** @type {any} */ entry) => entry.sessionId === sessionId && entry.agentId === "geo-insight"), bound);
  // The same account naming a second project alike gets its own id.
  const second = await call("preview", "POST", "/api/geo/projects", { brandName: "Wegovy" });
  assert.equal(second.body.data.projectId, "wegovy-2");
  const listed = await call("preview", "GET", "/api/geo/projects");
  assert.deepEqual(listed.body.data.projects.map((/** @type {any} */ row) => row.name).sort(), ["Wegovy", "Wegovy"]);
  assert.equal(listed.body.data.projects.some((/** @type {any} */ row) => row.id === id), true);
});

test("a project made before its brand is known is named by the brand the run writes; a chosen name is kept", options, async () => {
  const created = await call("preview", "POST", "/api/geo/projects", {});
  const { id, projectId } = created.body.data;
  assert.deepEqual((await rows("SELECT name FROM evimed_control.projects WHERE user_id = $1 AND id = $2", [accounts.preview, projectId]))[0], { name: "新 GEO 项目" });
  const geo = context.app.geo;
  const project = await geo.store.getProject(accounts.preview, id);
  const written = await geoRuntimeWrite({ store: geo.store, project, what: "product", body: { data: { brandName: "玛仕度肽" } }, renameProject: geo.renameProject });
  assert.equal(written.ok, true);
  assert.deepEqual((await rows("SELECT name FROM evimed_control.projects WHERE user_id = $1 AND id = $2", [accounts.preview, projectId]))[0], { name: "玛仕度肽" });
  const named = await call("preview", "POST", "/api/geo/projects", { brandName: "司美格鲁肽" });
  const namedProject = await geo.store.getProject(accounts.preview, named.body.data.id);
  await geoRuntimeWrite({ store: geo.store, project: namedProject, what: "product", body: { data: { brandName: "诺和盈" } }, renameProject: geo.renameProject });
  assert.deepEqual((await rows("SELECT name FROM evimed_control.projects WHERE user_id = $1 AND id = $2", [accounts.preview, named.body.data.projectId]))[0],
    { name: "司美格鲁肽" });
  const page = await call("preview", "GET", `/api/geo/projects/${named.body.data.id}`);
  assert.equal(page.body.data.name, "司美格鲁肽", "the project's own name, not the brand written after it");
  // A researcher's rename of the project is what 循证 GEO calls it from then on.
  const renamed = await call("preview", "PATCH", `/api/projects/${named.body.data.projectId}`, { name: "司美格鲁肽 2026 H1" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal((await call("preview", "GET", `/api/geo/projects/${named.body.data.id}`)).body.data.name, "司美格鲁肽 2026 H1");
});

test("under the operators audience a reader sees nothing of it; operators and the preview list do", options, async () => {
  const reader = await call("reader", "GET", "/api/geo/projects");
  assert.deepEqual([reader.status, reader.body.code], [404, "geo_not_enabled"]);
  assert.equal((await call("reader", "GET", "/api/me")).body.data.features.geo, false);
  for (const role of ["operator", "preview"]) {
    assert.equal((await call(role, "GET", "/api/geo/projects")).status, 200, role);
    assert.equal((await call(role, "GET", "/api/me")).body.data.features.geo, true, role);
  }
  const anonymous = await fetch(`${context.base}/api/geo/projects`);
  assert.equal(anonymous.status, 401);
});

test("readiness names the module and what it is waiting for; the metrics say it is on", options, async () => {
  const ready = await (await fetch(`${context.base}/api/ready`)).json();
  const geo = ready.data.checks.geo;
  assert.equal(geo.ok, true, JSON.stringify(geo));
  assert.equal(geo.audience, "operators");
  assert.equal(geo.warnings.includes("geo_worker_missing"), false, "the worker is composed with the module");
  assert.deepEqual(geo.worker.missing, [], "every loop of the worker has its function");
  assert.ok(geo.warnings.includes("geo_market_unconfigured"), "what lives outside the platform is still a warning");
  const text = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(text, /^open_science_geo_enabled 1$/m);
  assert.match(text, /^open_science_geo_tables_readable 1$/m);
});

test("deleting the control-plane project takes its GEO rows; deleting the account takes the account's", options, async () => {
  const created = await call("preview", "POST", "/api/geo/projects", { brandName: "Deleted Brand" });
  const { id, projectId } = created.body.data;
  const geo = context.app.geo;
  const project = await geo.store.getProject(accounts.preview, id);
  await geoRuntimeWrite({ store: geo.store, project, what: "claims", body: { items: [{ claimKey: "c", statement: "s", quote: "q", sourceRef: "r" }] } });
  const deleted = await call("preview", "DELETE", `/api/projects/${projectId}`, { confirm: projectId });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(await rows("SELECT id FROM evimed_geo.projects WHERE id = $1", [id]), []);
  assert.deepEqual(await rows("SELECT id FROM evimed_geo.claims WHERE geo_project_id = $1", [id]), []);

  const leaving = await call("leaver", "POST", "/api/geo/projects", { brandName: "Leaving" });
  assert.equal(leaving.status, 201);
  const gone = await call("leaver", "DELETE", "/api/account", { confirm: accounts.leaver, password: PASSWORD });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(await rows("SELECT id FROM evimed_geo.projects WHERE user_id = $1", [accounts.leaver]), []);
});

test("an article's gate is read from the project's run ledger: the newest run holding its deliverable", options, async () => {
  const created = await call("preview", "POST", "/api/geo/projects", { brandName: "Ledger Brand" });
  const geo = context.app.geo;
  const project = await geo.store.getProject(accounts.preview, created.body.data.id);
  const map = await geoRuntimeWrite({ store: geo.store, project, what: "questions",
    body: { data: { groups: [{ pool: "P1", name: "g", questions: [{ text: "q", isMeasured: true }] }] } } });
  const item = (/** @type {string} */ deliverable) => ({ path: `deliverables/${deliverable}/card.md`, layer: "card", groupId: map.ids[0], claimIds: [],
    safety: "clear", contentSha256: "d".repeat(64), gate: "passed" });
  const listed = /** @type {any[]} */ ([]);
  const original = context.app.agentRuns.list;
  context.app.agentRuns.list = async (/** @type {any} */ controlProject) => {
    listed.push(controlProject.id);
    return [
      { id: "run_old", status: "succeeded", startedAt: "2026-09-24T01:00:00.000Z", deliverables: [{ id: "geo-content", status: "delivered", lastVerdict: "pass" }] },
      { id: "run_new", status: "succeeded", startedAt: "2026-09-25T01:00:00.000Z", deliverables: [{ id: "geo-content", status: "delivered", lastVerdict: "unverified" }] },
      { id: "run_other", status: "failed", startedAt: "2026-09-25T02:00:00.000Z", deliverables: [{ id: "geo-other", status: "failed" }] },
    ];
  };
  try {
    const written = await geoRuntimeWrite({ store: geo.store, project, what: "articles", body: { items: [item("geo-content"), item("geo-other"), item("geo-missing")] },
      articleGate: geo.articleGate });
    assert.deepEqual(written.articles.map((/** @type {any} */ entry) => entry.gate), ["unverified", "failed", "unverified"],
      "the newest run's verdict, a failed run's, and a deliverable no run holds — never the run's own 'passed'");
    const named = await geoRuntimeWrite({ store: geo.store, project, what: "articles",
      body: { items: [{ ...item("geo-content"), path: "deliverables/geo-content/card-2.md", runId: "run_old" }] }, articleGate: geo.articleGate });
    assert.deepEqual(named.articles.map((/** @type {any} */ entry) => entry.gate), ["passed"], "a named run is the one asked");
    assert.ok(listed.every((id) => id === created.body.data.projectId), "the ledger read is the GEO project's own");
  } finally {
    context.app.agentRuns.list = original;
  }
});

test("deleting a project or an account removes the screenshots only its answers showed", options, async () => {
  const { dataDir } = context;
  const own = "1".repeat(56) + suffix;
  const shared = "2".repeat(56) + suffix;
  const leaverOwn = "3".repeat(56) + suffix;
  for (const sha of [own, shared, leaverOwn]) {
    await mkdir(path.dirname(geoScreenshotFile(dataDir, sha)), { recursive: true });
    await writeFile(geoScreenshotFile(dataDir, sha), "png");
  }
  const snapshot = async (/** @type {string} */ user, /** @type {string} */ geoId, /** @type {string} */ sha) => context.app.store.database.query(
    `INSERT INTO evimed_geo.snapshots (id, user_id, geo_project_id, status, screenshot_sha256) VALUES ($1, $2, $3, 'valid', $4)`,
    [`s-${randomUUID()}`, user, geoId, sha]);
  const first = (await call("preview", "POST", "/api/geo/projects", { brandName: "Shots One" })).body.data;
  const second = (await call("preview", "POST", "/api/geo/projects", { brandName: "Shots Two" })).body.data;
  await snapshot(accounts.preview, first.id, own);
  await snapshot(accounts.preview, first.id, shared);
  await snapshot(accounts.preview, second.id, shared);
  const deleted = await call("preview", "DELETE", `/api/projects/${first.projectId}`, { confirm: first.projectId });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  await assert.rejects(stat(geoScreenshotFile(dataDir, own)), { code: "ENOENT" }, "a screenshot only the deleted project showed is gone");
  assert.ok(await stat(geoScreenshotFile(dataDir, shared)), "one another project still shows is kept");

  const leaving = await call("lastLeaver", "POST", "/api/geo/projects", { brandName: "Leaving Shots" });
  assert.equal(leaving.status, 201, JSON.stringify(leaving.body));
  await snapshot(accounts.lastLeaver, leaving.body.data.id, leaverOwn);
  const gone = await call("lastLeaver", "DELETE", "/api/account", { confirm: accounts.lastLeaver, password: PASSWORD });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  await assert.rejects(stat(geoScreenshotFile(dataDir, leaverOwn)), { code: "ENOENT" });
});
