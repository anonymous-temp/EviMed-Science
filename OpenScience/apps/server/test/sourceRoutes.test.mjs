import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSourceRoutes } from "../src/sourceRoutes.mjs";
import { HttpError, sendError } from "../src/security.mjs";

async function fixture(t, { withOpenList = false } = {}) {
  const calls = [];
  const service = {
    list: async (userId, options) => { calls.push({ method: "list", userId, options }); return { items: [], nextCursor: null }; },
    get: async (userId, id) => { calls.push({ method: "get", userId, id }); return { id, projectId: "owned-project", revision: 2 }; },
    override: async (userId, id, body) => { calls.push({ method: "override", userId, id, body }); return { id, payload: body }; },
    retry: async (userId, id, body) => { calls.push({ method: "retry", userId, id, body }); return { id, status: "queued" }; },
    cancel: async (userId, id, body) => { calls.push({ method: "cancel", userId, id, body }); return { id, status: "canceled" }; },
    remove: async (userId, id, body) => { calls.push({ method: "remove", userId, id, body }); return { id, deletedAt: "now" }; },
    register: async (userId, input) => { calls.push({ method: "register", userId, input }); return { source: { id: "source-openlist" }, job: { id: "job-openlist" } }; },
    getUnderstanding: async (userId, id) => { calls.push({ method: "getUnderstanding", userId, id }); return { sourceId: id, generation: 1, depth: "structured", status: "parsing", current: null }; },
    understandingHistory: async (userId, id, options) => { calls.push({ method: "understandingHistory", userId, id, options }); return { items: [], nextCursor: null }; },
  };
  const store = {
    ensureSessionUser: async (req) => {
      if (req.headers.cookie !== "fixture=active") throw new HttpError(401, "unauthorized", "Authentication required.");
      return { user: { id: "owner" } };
    },
    assertCsrf: async (req) => {
      if (!["GET", "HEAD"].includes(req.method) && req.headers["x-open-science-csrf"] !== "csrf") {
        throw new HttpError(403, "csrf_required", "CSRF required.");
      }
    },
    requireProject: async (_user, id) => {
      if (id !== "owned-project") throw new HttpError(404, "project_not_found", "Project unavailable.");
      return { id };
    },
  };
  const openList = withOpenList ? {
    list: async (userId, selected, options) => { calls.push({ method: "openList", userId, selected, options }); return { entries: [], nextCursor: null }; },
    stat: async () => ({ path: "/paper.pdf", name: "paper.pdf", entryType: "file", size: 7,
      mtime: "2026-09-06T00:00:00.000Z", providerHash: `sha256:${"a".repeat(64)}` }),
  } : null;
  const route = createSourceRoutes({ store, service, openList, maxJsonBytes: 64 * 1024 });
  const server = createServer((req, res) => {
    route(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }).catch((error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    headers: { cookie: "fixture=active", "x-open-science-csrf": "csrf", "content-type": "application/json" },
    calls,
    service,
  };
}

test("source listing is project scoped before the service sees the request", async (t) => {
  const { base, headers, calls } = await fixture(t);
  assert.equal((await fetch(`${base}/api/sources?projectId=other`, { headers })).status, 404);
  const response = await fetch(`${base}/api/sources?projectId=owned-project&status=needs_attention`, { headers });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: "list", userId: "owner", options: {
    projectId: "owned-project", status: "needs_attention", limit: 50, cursor: null,
  } });
});

test("understanding current and history use the authenticated source project and bounded page contract", async t => {
  const { base, headers, calls, service } = await fixture(t);
  const current = await fetch(`${base}/api/sources/source-one/understanding`, { headers });
  assert.equal(current.status, 200); assert.equal((await current.json()).data.current, null);
  const history = await fetch(`${base}/api/sources/source-one/understanding/history?limit=8&cursor=opaque`, { headers });
  assert.equal(history.status, 200);
  assert.deepEqual(calls.find(call => call.method === "understandingHistory"), {
    method: "understandingHistory", userId: "owner", id: "source-one", options: { limit: 8, cursor: "opaque" },
  });
  service.get = async () => ({ id: "source-other", projectId: "other-project" });
  assert.equal((await fetch(`${base}/api/sources/source-other/understanding`, { headers })).status, 404);
});

test("source routes never expose runtime binding paths or cancellation work items", async t => {
  const { base, headers, service } = await fixture(t);
  service.get = async () => ({ id: "source-one", kind: "source", projectId: "owned-project", payload: {
    generation: 1, outputs: { summary: "Notes", artifactPath: "knowledge-base/.evimed-derived/source-one/index.md" }, pendingRunCancellations: [{ id: "private" }],
    analysis: { phase: "understanding", generation: 1, run: { id: "run1", sessionId: "session1", dispatchId: "dispatch1", workspaceName: "private", artifactDirectory: "private/path" } },
  } });
  const response = await fetch(`${base}/api/sources/source-one`, { headers });
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes("private"), false);
  assert.equal(body.data.payload.analysis.run.id, "run1");
  assert.equal(body.data.payload.outputs.artifactPath, "knowledge-base/.evimed-derived/source-one/index.md");
});

test("source mutations require CSRF and reject browser-supplied ownership", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const url = `${base}/api/sources/source-one`;
  assert.equal((await fetch(url, { method: "PATCH", headers: { cookie: headers.cookie, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 2, docType: "lecture-slides", depth: "deep", reason: "mine" }) })).status, 403);
  assert.equal((await fetch(url, { method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: 2, docType: "lecture-slides", depth: "deep", reason: "mine", userId: "other" }) })).status, 400);
  assert.equal(calls.some((call) => call.method === "override"), false);

  const response = await fetch(url, { method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: 2, docType: "lecture-slides", depth: "deep", reason: "mine" }) });
  assert.equal(response.status, 200);
  assert.equal(calls.find((call) => call.method === "override").userId, "owner");
});

test("retry, cancel and delete are explicit revision-guarded operations", async (t) => {
  const { base, headers, calls } = await fixture(t);
  for (const action of ["retry", "cancel"]) {
    const response = await fetch(`${base}/api/sources/source-one/${action}`, {
      method: "POST", headers, body: JSON.stringify({ expectedRevision: 2 }),
    });
    assert.equal(response.status, 200);
  }
  assert.equal((await fetch(`${base}/api/sources/source-one`, {
    method: "DELETE", headers, body: JSON.stringify({ expectedRevision: 2 }),
  })).status, 200);
  assert.deepEqual(calls.filter((call) => call.method !== "get").map((call) => call.method), ["retry", "cancel", "remove"]);
});

test("OpenList browse and import stay account and project scoped", async (t) => {
  const { base, headers, calls } = await fixture(t, { withOpenList: true });
  const browse = await fetch(`${base}/api/sources/openlist?projectId=owned-project&path=%2Fpapers`, { headers });
  assert.equal(browse.status, 200);
  assert.equal(calls.find((call) => call.method === "openList").userId, "owner");
  const imported = await fetch(`${base}/api/sources/openlist/import`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", path: "/paper.pdf" }) });
  assert.equal(imported.status, 201);
  const registered = calls.find((call) => call.method === "register");
  assert.equal(registered.userId, "owner");
  assert.deepEqual(registered.input.connector, { type: "openlist", id: "/paper.pdf" });
  assert.equal(registered.input.sha256, "a".repeat(64));
});
