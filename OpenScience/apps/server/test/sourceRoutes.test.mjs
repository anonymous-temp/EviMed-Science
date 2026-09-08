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
    family: async (userId, id, options) => { calls.push({ method: "family", userId, id, options }); return { sourceId: id, familyId: "fam_one", currentVersion: 2, items: [], nextCursor: null }; },
    useConnector: (type, client) => { calls.push({ method: "useConnector", type, hasList: typeof client?.list === "function" }); },
    listFolders: async (userId, options) => { calls.push({ method: "listFolders", userId, options }); return { items: [], nextCursor: null }; },
    getFolder: async (userId, id) => { calls.push({ method: "getFolder", userId, id }); return { id, kind: "preferences", projectId: "owned-project", revision: 4, payload: { recordType: "source-folder" } }; },
    registerFolder: async (userId, input) => { calls.push({ method: "registerFolder", userId, input }); return { folder: { id: "srcdir_one" }, created: true, job: { id: "job-folder" } }; },
    setFolderStatus: async (userId, id, body) => { calls.push({ method: "setFolderStatus", userId, id, body }); return { folder: { id }, job: null }; },
    syncFolder: async (userId, id, body) => { calls.push({ method: "syncFolder", userId, id, body }); return { folder: { id }, job: { id: "job-sync" } }; },
    duplicateCandidates: async (userId, options) => { calls.push({ method: "duplicateCandidates", userId, options }); return { items: [], scanned: 0, truncated: false }; },
    decideDuplicate: async (userId, input) => { calls.push({ method: "decideDuplicate", userId, input }); return { id: "srcdup_one", payload: input }; },
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
    stat: async (_userId, selected) => (selected === "/papers"
      ? { path: "/papers", name: "papers", entryType: "dir", size: 0, mtime: null, providerHash: null }
      : { path: "/paper.pdf", name: "paper.pdf", entryType: "file", size: 7,
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
    projectId: "owned-project", status: "needs_attention", familyId: null, limit: 50, cursor: null,
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

test("the OpenList connector is handed to the service the ingestion worker shares", async (t) => {
  const { calls } = await fixture(t, { withOpenList: true });
  assert.deepEqual(calls.filter(call => call.method === "useConnector"), [{ method: "useConnector", type: "openlist", hasList: true }],
    "without this wiring a leased folder sync has no client for the account namespace");
  const { calls: withoutOpenList } = await fixture(t);
  assert.equal(withoutOpenList.some(call => call.method === "useConnector"), false);
});

test("the version chain is a real read route scoped to the source's project", async (t) => {
  const { base, headers, calls, service } = await fixture(t);
  const response = await fetch(`${base}/api/sources/source-one/family?limit=7`, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.familyId, "fam_one");
  assert.deepEqual(calls.find(call => call.method === "family"), { method: "family", userId: "owner", id: "source-one", options: { limit: 7 } });
  const filtered = await fetch(`${base}/api/sources?projectId=owned-project&familyId=fam_one`, { headers });
  assert.equal(filtered.status, 200);
  assert.equal(calls.find(call => call.method === "list").options.familyId, "fam_one");
  service.get = async () => ({ id: "source-other", projectId: "other-project" });
  assert.equal((await fetch(`${base}/api/sources/source-other/family`, { headers })).status, 404);
});

test("folder registration requires a directory, a project and CSRF", async (t) => {
  const { base, headers, calls } = await fixture(t, { withOpenList: true });
  assert.equal((await fetch(`${base}/api/sources/folders`, { method: "POST", headers: { cookie: headers.cookie, "content-type": "application/json" },
    body: JSON.stringify({ projectId: "owned-project", path: "/papers" }) })).status, 403);
  assert.equal((await fetch(`${base}/api/sources/folders`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "other", path: "/papers" }) })).status, 404);
  assert.equal((await fetch(`${base}/api/sources/folders`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", path: "/paper.pdf" }) })).status, 400, "a file is not a syncable folder");
  const created = await fetch(`${base}/api/sources/folders`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", path: "/papers" }) });
  assert.equal(created.status, 201);
  assert.deepEqual(calls.find(call => call.method === "registerFolder").input,
    { projectId: "owned-project", connectorType: "openlist", path: "/papers" });
  assert.equal(calls.some(call => call.method === "registerFolder" && call.userId !== "owner"), false);
});

test("folder listing, status and sync are project-scoped revision-guarded operations", async (t) => {
  const { base, headers, calls, service } = await fixture(t, { withOpenList: true });
  assert.equal((await fetch(`${base}/api/sources/folders?projectId=owned-project`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/sources/folders?projectId=other`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/sources/folders/srcdir_one`, { method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: 4, status: "paused" }) })).status, 200);
  assert.equal((await fetch(`${base}/api/sources/folders/srcdir_one/sync`, { method: "POST", headers,
    body: JSON.stringify({ expectedRevision: 4 }) })).status, 200);
  assert.deepEqual(calls.find(call => call.method === "setFolderStatus").body, { expectedRevision: 4, status: "paused" });
  assert.deepEqual(calls.find(call => call.method === "syncFolder").body, { expectedRevision: 4 });
  service.getFolder = async (userId, id) => ({ id, kind: "preferences", projectId: "other-project", revision: 4, payload: { recordType: "source-folder" } });
  assert.equal((await fetch(`${base}/api/sources/folders/srcdir_other/sync`, { method: "POST", headers,
    body: JSON.stringify({ expectedRevision: 4 }) })).status, 404, "another project's folder is not reachable by id");
});

test("the duplicate desk reads and decides only inside the caller's project", async (t) => {
  const { base, headers, calls } = await fixture(t);
  assert.equal((await fetch(`${base}/api/sources/duplicates?projectId=owned-project`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/sources/duplicates?projectId=other`, { headers })).status, 404);
  const decided = await fetch(`${base}/api/sources/duplicates`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", groupKey: `version-family:${"a".repeat(32)}`, sourceIds: ["source-one"], decision: "linked" }) });
  assert.equal(decided.status, 201);
  assert.equal(calls.find(call => call.method === "decideDuplicate").userId, "owner");
  assert.equal((await fetch(`${base}/api/sources/duplicates`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", groupKey: "k", sourceIds: [], decision: "linked", userId: "other" }) })).status, 400);
});

test("folder replies say a sync is scheduled without handing the browser worker identity", async (t) => {
  const { base, headers, service } = await fixture(t, { withOpenList: true });
  service.registerFolder = async () => ({ folder: { id: "srcdir_one" }, created: true,
    job: { id: "job-folder", payload: { accountCreatedAt: "2026-01-01 00:00:00+00", folderId: "srcdir_one" } } });
  const created = await fetch(`${base}/api/sources/folders`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", path: "/papers" }) });
  const body = await created.json();
  assert.deepEqual(body.data, { folder: { id: "srcdir_one" }, created: true, scheduled: true });
  assert.equal(JSON.stringify(body).includes("accountCreatedAt"), false);
});

test("an imported file and a synced file register under the same connector-resolved path", async (t) => {
  const { base, headers, calls } = await fixture(t, { withOpenList: true });
  const imported = await fetch(`${base}/api/sources/openlist/import`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", path: "//paper.pdf/" }) });
  assert.equal(imported.status, 201);
  const registered = calls.find((call) => call.method === "register");
  assert.deepEqual(registered.input.connector, { type: "openlist", id: "/paper.pdf" },
    "the family id must not depend on how the browser spelled the path");
  assert.equal(registered.input.path, "openlist/paper.pdf");
});
