// A project the platform makes for itself is not a place a signed-in browser can start work in (evidence-flywheel review fix 1,
// 2026-10-06). `server.mjs` waives the credit hold, the settlement and the spend caps for such a project because the work in it
// is the platform's own; the learning loop makes `evimed-learning` in every account and the evidence upkeep makes
// `evimed-evidence` in an ordinary one, so a researcher who named either in a request header ran research the platform paid for.
// Driven through the composed app, the way a browser reaches it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EVIDENCE_PROJECT_ID, FRONTIER_PROJECT_ID, LEARNING_PROJECT_ID, SOURCES_PROJECT_ID } from "../src/internalProjects.mjs";
import { createAutopilotRoutes } from "../src/autopilotRoutes.mjs";
import { sendError } from "../src/security.mjs";
import { createWebApiApp } from "../src/server.mjs";

const SERVER_MADE = [LEARNING_PROJECT_ID, SOURCES_PROJECT_ID, FRONTIER_PROJECT_ID, EVIDENCE_PROJECT_ID, `methodeval-${"ab".repeat(12)}`];

/** @param {(context: { app: any, base: string, user: any }) => Promise<void>} run @param {Record<string, any>} [overrides] */
async function withApp(run, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-internal-dispatch-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, memoryExtractionEnabled: false, autopilotEnabled: true, ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const me = await (await fetch(`${base}/api/me`)).json();
    await run({ app, base, user: await app.store.userById(me.data.user.id) });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** @param {string} base @param {string} project @param {string} method @param {string} route @param {any} [body] */
async function ask(base, project, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { "content-type": "application/json", "x-open-science-project": project },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** The ways a browser starts work in the project named by its header. */
const STARTS = (/** @type {string} */ tag) => [
  ["research-session", "PUT", `/api/research-sessions/s-${tag}`, { mode: "open-domain" }],
  ["dispatch", "POST", "/api/agent-runs/dispatch", { sessionId: `s-${tag}`, dispatchId: `d-${tag}`, text: "How is anticoagulant bleeding risk assessed?" }],
  ["runtime session", "POST", "/api/runtime/sessions", {}],
  ["upload", "POST", "/api/files/upload", { root: "workspace", path: "notes.txt", data: "hello" }],
];

test("an ordinary account cannot start work in a project the platform made for itself, and is answered as if it did not exist", async () => {
  await withApp(async ({ app, base, user }) => {
    for (const id of SERVER_MADE) await app.store.createProject(user, id, id);
    const missing = await ask(base, "no-such-project", "POST", "/api/runtime/sessions", {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "project_not_found");
    for (const id of SERVER_MADE) {
      for (const [label, method, route, body] of STARTS(id.slice(0, 12))) {
        const answered = await ask(base, id, method, route, body);
        assert.equal(answered.status, 404, `${label} in ${id}: ${JSON.stringify(answered.body)}`);
        assert.equal(answered.body.code, "project_not_found", `${label} in ${id}`);
      }
    }
    // The same routes still work in the researcher's own projects, including a name that only looks like the platform's.
    await app.store.createProject(user, "audit-trial", "Audit trial");
    for (const id of ["default", "audit-trial"]) {
      assert.equal((await ask(base, id, "PUT", `/api/research-sessions/own-${id}`, { mode: "open-domain" })).status, 200, id);
      const dispatched = await ask(base, id, "POST", "/api/agent-runs/dispatch", { sessionId: `own-${id}`, dispatchId: `own-d-${id}`, text: "How is anticoagulant bleeding risk assessed?" });
      assert.equal(dispatched.status, 202, `${id}: ${JSON.stringify(dispatched.body)}`);
    }
  });
});

test("a proactive agenda is refused in a platform-made project the same way, before anything is made", async () => {
  /** @type {string[]} */
  const created = [];
  const routes = createAutopilotRoutes({
    store: { ensureSessionUser: async () => ({ user: { id: "u1" } }), assertCsrf: async () => {}, requireProject: async () => ({}) },
    service: { create: async (/** @type {string} */ _user, /** @type {any} */ body) => { created.push(body.projectId); return {}; }, projectAgenda: () => ({}) },
    maxJsonBytes: 65_536,
  });
  const server = createServer((req, res) => { routes(req, res).then((handled) => { if (!handled) res.end("{}"); }, (error) => sendError(res, error, {})); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  try {
    const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
    for (const id of SERVER_MADE) {
      const answered = await fetch(`${base}/api/autopilot/agendas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: id, title: "Watch" }) });
      assert.equal(answered.status, 404, id);
      assert.equal((await answered.json()).code, "project_not_found", id);
    }
    assert.deepEqual(created, [], "no agenda was made in a project the platform keeps for itself");
    const own = await fetch(`${base}/api/autopilot/agendas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "default", title: "Watch" }) });
    assert.equal(own.status, 201);
    assert.deepEqual(created, ["default"]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
