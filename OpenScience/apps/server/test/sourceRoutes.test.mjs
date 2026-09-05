import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSourceRoutes } from "../src/sourceRoutes.mjs";
import { HttpError, sendError } from "../src/security.mjs";

async function fixture(t) {
  const calls = [];
  const service = {
    list: async (userId, options) => { calls.push({ method: "list", userId, options }); return { items: [], nextCursor: null }; },
    get: async (userId, id) => { calls.push({ method: "get", userId, id }); return { id, revision: 2 }; },
    override: async (userId, id, body) => { calls.push({ method: "override", userId, id, body }); return { id, payload: body }; },
    retry: async (userId, id, body) => { calls.push({ method: "retry", userId, id, body }); return { id, status: "queued" }; },
    cancel: async (userId, id, body) => { calls.push({ method: "cancel", userId, id, body }); return { id, status: "canceled" }; },
    remove: async (userId, id, body) => { calls.push({ method: "remove", userId, id, body }); return { id, deletedAt: "now" }; },
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
  const route = createSourceRoutes({ store, service, maxJsonBytes: 64 * 1024 });
  const server = createServer((req, res) => {
    route(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }).catch((error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    headers: { cookie: "fixture=active", "x-open-science-csrf": "csrf", "content-type": "application/json" },
    calls,
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

test("source mutations require CSRF and reject browser-supplied ownership", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const url = `${base}/api/sources/source-one`;
  assert.equal((await fetch(url, { method: "PATCH", headers: { cookie: headers.cookie, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 2, docType: "lecture-slides", depth: "deep", reason: "mine" }) })).status, 403);
  assert.equal((await fetch(url, { method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: 2, docType: "lecture-slides", depth: "deep", reason: "mine", userId: "other" }) })).status, 400);
  assert.equal(calls.length, 0);

  const response = await fetch(url, { method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: 2, docType: "lecture-slides", depth: "deep", reason: "mine" }) });
  assert.equal(response.status, 200);
  assert.equal(calls[0].userId, "owner");
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
  assert.deepEqual(calls.map((call) => call.method), ["retry", "cancel", "remove"]);
});
