import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { knownErrorCodeMessage } from "@evimed/domain";
import { OpenListClient } from "../src/openListClient.mjs";
import { OpenListSourceConnector } from "../src/openListSourceConnector.mjs";
import { createSourceRoutes } from "../src/sourceRoutes.mjs";
import { HttpError, sendError } from "../src/security.mjs";
import { startFakeOpenList } from "./fakeOpenList.mjs";

async function fixture(t, { withOpenList = false, connector = null, withKnowledge = true, uses = null, passages = null } = {}) {
  const calls = [];
  const service = {
    list: async (userId, options) => { calls.push({ method: "list", userId, options }); return { items: [], nextCursor: null }; },
    get: async (userId, id) => { calls.push({ method: "get", userId, id }); return { id, projectId: "owned-project", revision: 2 }; },
    isShared: async (userId, source) => { calls.push({ method: "isShared", userId, id: source.id }); return null; },
    override: async (userId, id, body) => { calls.push({ method: "override", userId, id, body }); return { id, payload: body }; },
    retry: async (userId, id, body) => { calls.push({ method: "retry", userId, id, body }); return { id, status: "queued" }; },
    cancel: async (userId, id, body) => { calls.push({ method: "cancel", userId, id, body }); return { id, status: "canceled" }; },
    remove: async (userId, id, body) => { calls.push({ method: "remove", userId, id, body }); return { id, deletedAt: "now" }; },
    register: async (userId, input) => { calls.push({ method: "register", userId, input }); return { source: { id: "source-openlist" }, job: { id: "job-openlist" } }; },
    getUnderstanding: async (userId, id) => { calls.push({ method: "getUnderstanding", userId, id }); return { sourceId: id, generation: 1, depth: "structured", status: "parsing", current: null }; },
    understandingHistory: async (userId, id, options) => { calls.push({ method: "understandingHistory", userId, id, options }); return { items: [], nextCursor: null }; },
    getMaterials: async (userId, id) => { calls.push({ method: "getMaterials", userId, id }); return { sourceId: id, generation: 1, materials: null, reason: "not_extracted" }; },
    getMaterialTable: async (userId, id, tableId) => { calls.push({ method: "getMaterialTable", userId, id, tableId }); return { sourceId: id, generation: 1, table: { id: tableId } }; },
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
  const openList = connector ?? (withOpenList ? {
    list: async (userId, selected, options) => { calls.push({ method: "openList", userId, selected, options }); return { entries: [], nextCursor: null }; },
    stat: async (_userId, selected) => (selected === "/papers"
      ? { path: "/papers", name: "papers", entryType: "dir", size: 0, mtime: null, providerHash: null }
      : { path: "/paper.pdf", name: "paper.pdf", entryType: "file", size: 7,
        mtime: "2026-09-06T00:00:00.000Z", providerHash: `sha256:${"a".repeat(64)}` }),
  } : null);
  const knowledge = withKnowledge ? {
    addLink: async (input) => { calls.push({ method: "addLink", userId: input.user.id, projectId: input.project.id, url: input.url }); return { source: { id: "src_link", kind: "source", payload: { status: "queued", paths: [], reasons: [] } }, duplicate: false, changed: true, job: { id: "job-link", leaseToken: "secret" } }; },
    addNote: async (input) => { calls.push({ method: "addNote", userId: input.user.id, projectId: input.project.id, title: input.title, body: input.body }); return { source: { id: "src_note", kind: "source", payload: { status: "queued", paths: [], reasons: [] } }, duplicate: false, job: { id: "job-note" } }; },
    readNote: async (input) => { calls.push({ method: "readNote", sourceId: input.source.id, projectId: input.project.id }); return { title: "组会", body: "确定分组。" }; },
    saveNote: async (input) => { calls.push({ method: "saveNote", sourceId: input.source.id, title: input.title, body: input.body }); return { source: { id: "src_note_2", kind: "source", payload: { status: "queued", paths: [], reasons: [] } }, duplicate: false, changed: true, job: null }; },
    refetchLink: async (input) => { calls.push({ method: "refetchLink", sourceId: input.source.id }); return { source: { id: "src_link", kind: "source", payload: { status: "queued", paths: [], reasons: [] } }, duplicate: true, changed: false, job: null }; },
  } : null;
  const route = createSourceRoutes({ store, service, openList, knowledge, uses, passages, maxJsonBytes: 64 * 1024 });
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
    projectId: "owned-project", shared: false, status: "needs_attention", kind: null, q: null, familyId: null, limit: 50, cursor: null,
  } });
});

test("the list takes a search, a chip and a page, and the shared scope belongs to no project", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const searched = await fetch(`${base}/api/sources?projectId=owned-project&q=${encodeURIComponent("幽门螺杆菌")}&kind=literature&limit=20&cursor=opaque`, { headers });
  assert.equal(searched.status, 200);
  assert.deepEqual(calls.at(-1).options, { projectId: "owned-project", shared: false, status: null, kind: "literature", q: "幽门螺杆菌", familyId: null, limit: 20, cursor: "opaque" });
  // The account's own shared documents are listed without naming a project, and a project is not checked for them.
  const shared = await fetch(`${base}/api/sources?scope=shared&kind=table`, { headers });
  assert.equal(shared.status, 200);
  assert.deepEqual(calls.at(-1).options, { projectId: null, shared: true, status: null, kind: "table", q: null, familyId: null, limit: 50, cursor: null });
  assert.equal((await fetch(`${base}/api/sources?scope=everything`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/sources`, { headers })).status, 400, "a project scope still names its project");
  assert.equal((await fetch(`${base}/api/sources?scope=shared`)).status, 401);
});

test("adding a page or a note names a project the caller owns, and the worker's job never reaches the browser", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const link = await post("/api/sources/links", { projectId: "owned-project", url: "https://www.nmpa.gov.cn/notice" });
  assert.equal(link.status, 201);
  const linked = (await link.json()).data;
  assert.equal(linked.source.id, "src_link");
  assert.equal(linked.job, undefined);
  assert.deepEqual(calls.find((call) => call.method === "addLink"), { method: "addLink", userId: "owner", projectId: "owned-project", url: "https://www.nmpa.gov.cn/notice" });
  assert.equal((await post("/api/sources/links", { projectId: "other", url: "https://example.org" })).status, 404);
  assert.equal((await post("/api/sources/links", { projectId: "owned-project", url: "https://example.org", userId: "other" })).status, 400);
  const note = await post("/api/sources/notes", { projectId: "owned-project", title: "组会", body: "确定分组。" });
  assert.equal(note.status, 201);
  assert.equal((await note.json()).data.job, undefined);
  assert.deepEqual(calls.find((call) => call.method === "addNote"), { method: "addNote", userId: "owner", projectId: "owned-project", title: "组会", body: "确定分组。" });
  assert.equal((await post("/api/sources/notes", { projectId: "other", title: "x", body: "" })).status, 404);
  assert.equal((await fetch(`${base}/api/sources/links`, { method: "POST", body: "{}" })).status, 401);
});

test("a note is read and saved, and a link is read again, through the source's own project", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const read = await fetch(`${base}/api/sources/src_note/note`, { headers });
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).data, { title: "组会", body: "确定分组。" });
  const saved = await fetch(`${base}/api/sources/src_note/note`, { method: "PUT", headers, body: JSON.stringify({ title: "组会记录", body: "新的正文" }) });
  assert.equal(saved.status, 200);
  const savedBody = (await saved.json()).data;
  assert.equal(savedBody.source.id, "src_note_2");
  assert.equal(savedBody.changed, true);
  assert.deepEqual(calls.find((call) => call.method === "saveNote"), { method: "saveNote", sourceId: "src_note", title: "组会记录", body: "新的正文" });
  const again = await fetch(`${base}/api/sources/src_link/refetch`, { method: "POST", headers, body: "{}" });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).data.changed, false);
  assert.ok(calls.some((call) => call.method === "refetchLink" && call.sourceId === "src_link"));
  // Nothing else is writable on a note, and an unauthenticated caller reads nothing.
  assert.equal((await fetch(`${base}/api/sources/src_note/note`, { method: "DELETE", headers })).status, 404);
  assert.equal((await fetch(`${base}/api/sources/src_note/note`)).status, 401);
});

test("without the knowledge base's storage a page or a note says so by name", async (t) => {
  const { base, headers } = await fixture(t, { withKnowledge: false });
  const response = await fetch(`${base}/api/sources/links`, { method: "POST", headers, body: JSON.stringify({ projectId: "owned-project", url: "https://example.org" }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "source_state_unavailable");
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

test("structured materials are read through the source's own project: the ledger, then one table by its id", async t => {
  const { base, headers, calls } = await fixture(t);
  const ledger = await fetch(`${base}/api/sources/src_one/materials`, { headers });
  assert.equal(ledger.status, 200);
  assert.deepEqual((await ledger.json()).data, { sourceId: "src_one", generation: 1, materials: null, reason: "not_extracted" });
  const table = await fetch(`${base}/api/sources/src_one/materials/tbl-3`, { headers });
  assert.deepEqual((await table.json()).data.table, { id: "tbl-3" });
  assert.deepEqual(calls.filter(call => call.method.startsWith("getMaterial")).map(call => [call.method, call.userId, call.id, call.tableId]),
    [["getMaterials", "owner", "src_one", undefined], ["getMaterialTable", "owner", "src_one", "tbl-3"]]);
  // A read only: a mutation of the materials is not a route, and a deeper path is not either.
  assert.equal((await fetch(`${base}/api/sources/src_one/materials`, { method: "POST", headers, body: "{}" })).status, 404);
  assert.equal((await fetch(`${base}/api/sources/src_one/materials/tbl-3/cells`, { headers })).status, 404);
  // Unauthenticated, nothing is read.
  assert.equal((await fetch(`${base}/api/sources/src_one/materials`)).status, 401);
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

test("one document is read with whether the account library holds it, which the reader page needs and a list row already carries", async t => {
  const { base, headers, calls, service } = await fixture(t);
  service.get = async (_userId, id) => ({ id, kind: "source", projectId: "owned-project", revision: 4, createdAt: "2026-10-05T08:00:00Z", updatedAt: "2026-10-05T08:00:00Z", deletedAt: null,
    payload: { paths: ["knowledge-base/guideline.pdf"], status: "complete", docType: "review-guideline", fingerprint: { size: 100, sha256: "a".repeat(64) }, outputs: {} } });
  service.isShared = async (userId, source) => { calls.push({ method: "isShared", userId, id: source.id }); return true; };
  const shared = await (await fetch(`${base}/api/sources/src_one`, { headers })).json();
  assert.equal(shared.data.display.shared, true);
  assert.deepEqual(calls.filter(call => call.method === "isShared"), [{ method: "isShared", userId: "owner", id: "src_one" }]);
  service.isShared = async () => false;
  assert.equal((await (await fetch(`${base}/api/sources/src_one`, { headers })).json()).data.display.shared, false);
  // Nothing to look up (no durable store, no fingerprint): not known, never a guess.
  service.isShared = async () => null;
  assert.equal((await (await fetch(`${base}/api/sources/src_one`, { headers })).json()).data.display.shared, null);
  // The source's own project is still checked before anything is asked about it.
  service.get = async () => ({ id: "src_other", projectId: "other-project" });
  service.isShared = async () => { throw new Error("must not be asked for a project the caller does not own"); };
  assert.equal((await fetch(`${base}/api/sources/src_other`, { headers })).status, 404);
});

test("a document's page asks which conversations used it, through the account that holds it", async t => {
  const asked = [];
  const { base, headers, service } = await fixture(t, { uses: { list: async (user, sourceId) => { asked.push([user.id, sourceId]); return [{ sessionId: "s1", projectId: "owned-project", runId: "r1", title: "对话", kinds: ["read"] }]; } } });
  const response = await fetch(`${base}/api/sources/src_one/uses`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.items.map((item) => item.sessionId), ["s1"]);
  assert.deepEqual(asked, [["owner", "src_one"]]);
  // A read only, and unauthenticated nothing is asked.
  assert.equal((await fetch(`${base}/api/sources/src_one/uses`, { method: "POST", headers, body: "{}" })).status, 404);
  assert.equal((await fetch(`${base}/api/sources/src_one/uses`)).status, 401);
  assert.equal(asked.length, 1);
  // The document's own project is checked before the uses are read: a source of a project the caller does not own is not found.
  service.get = async () => ({ id: "src_other", projectId: "other-project" });
  assert.equal((await fetch(`${base}/api/sources/src_other/uses`, { headers })).status, 404);
  assert.equal(asked.length, 1);
});

test("without a store of uses a document's page is told there are none", async t => {
  const { base, headers } = await fixture(t);
  assert.deepEqual((await (await fetch(`${base}/api/sources/src_one/uses`, { headers })).json()).data, { items: [] });
});

test("the box's search of the documents' text decides which documents the list holds, and says where each match is", async t => {
  const found = [];
  const passages = { find: async request => { found.push(request); return { shas: ["a".repeat(64), "b".repeat(64)], bySha: { ["a".repeat(64)]: [{ page: 2, snippet: "…达比加群酯…", start: 10, end: 20 }] } }; } };
  const { base, headers, calls, service } = await fixture(t, { passages });
  service.list = async (userId, options) => { calls.push({ method: "list", userId, options });
    return { items: [{ id: "src_a", kind: "source", projectId: "owned-project", payload: { fingerprint: { sha256: "a".repeat(64) }, paths: [], status: "complete" } },
      { id: "src_c", kind: "source", projectId: "owned-project", payload: { fingerprint: { sha256: "c".repeat(64) }, paths: [], status: "complete" } }], nextCursor: null, counts: { all: 2 } }; };
  const body = await (await fetch(`${base}/api/sources?projectId=owned-project&q=${encodeURIComponent("达比加群")}`, { headers })).json();
  assert.deepEqual(found, [{ userId: "owner", projectId: "owned-project", shared: false, q: "达比加群" }]);
  const listed = calls.filter(call => call.method === "list").at(-1).options;
  assert.deepEqual(listed.bodyShas, ["a".repeat(64), "b".repeat(64)]);
  assert.equal(listed.q, "达比加群");
  // The passages are those of the rows of this page, by their ids; a row with no match has none.
  assert.deepEqual(body.data.passages, { src_a: [{ page: 2, snippet: "…达比加群酯…", start: 10, end: 20 }] });
  assert.equal(body.data.counts.all, 2);
  // The shared scope is asked for with no project.
  await fetch(`${base}/api/sources?scope=shared&q=x`, { headers });
  assert.deepEqual(found.at(-1), { userId: "owner", projectId: null, shared: true, q: "x" });
  // No box, no search of the text; a box the index cannot answer is the list's own search.
  const before = found.length;
  const plain = await (await fetch(`${base}/api/sources?projectId=owned-project`, { headers })).json();
  assert.equal(found.length, before);
  assert.equal("passages" in plain.data, false);
  passages.find = async () => { throw new Error("index down"); };
  const degraded = await fetch(`${base}/api/sources?projectId=owned-project&q=abc`, { headers });
  assert.equal(degraded.status, 200);
  assert.equal("passages" in (await degraded.json()).data, false);
  assert.equal("bodyShas" in calls.filter(call => call.method === "list").at(-1).options, false);
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

test("an account with no drive mounted is told so by name; a mounted one lists its root", async (t) => {
  // Audit I3-4: production answered this browse with an anonymous 502
  // `openlist_request_failed`, because OpenList had no storage at all.
  const openList = await startFakeOpenList(t);
  const connector = new OpenListSourceConnector(new OpenListClient({ baseUrl: openList.url, token: openList.token }), { tenantRoot: "/tenants" });
  const { base, headers } = await fixture(t, { connector });
  const browse = () => fetch(`${base}/api/sources/openlist?projectId=owned-project&path=%2F`, { headers });
  const unmounted = await browse();
  assert.equal(unmounted.status, 404);
  const refused = await unmounted.json();
  assert.equal(refused.code, "openlist_storage_missing");
  assert.equal(JSON.stringify(refused).includes("/tenants"), false, "the namespace path stays server-side");
  assert.ok(knownErrorCodeMessage(refused.code), "the browse toast has a sentence for it");
  assert.deepEqual(openList.requests.map((request) => request.path), ["/tenants/owner"]);

  openList.mount("/tenants/owner", ["paper.txt"]);
  const mounted = await browse();
  assert.equal(mounted.status, 200);
  assert.deepEqual((await mounted.json()).data.entries.map((entry) => [entry.path, entry.entryType]), [["/paper.txt", "file"]]);
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
