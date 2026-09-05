import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { HttpError, sendError } from "../src/security.mjs";
import { createCapsuleRoutes } from "../src/capsuleRoutes.mjs";

async function fixture(t) {
  const calls = [];
  const service = {
    list: async (user) => ({ items: [{ id: "capsule-one", owner: user }] }),
    create: async (user, body) => { calls.push({ user, body }); return { id: "created", payload: body }; },
    addEntry: async (user, id, body) => { calls.push({ user, id, body }); return { id: "entry", payload: body }; },
    activate: async (user, id, body) => { calls.push({ user, id, body }); return { id, payload: body }; },
    recall: async (user, body) => { calls.push({ user, body }); return { items: [], contextOnly: true }; },
  };
  const store = {
    ensureSessionUser: async (req) => {
      if (req.headers.cookie !== "fixture_session=active") throw new HttpError(401, "unauthorized", "Authentication required.");
      return { user: { id: "owner" } };
    },
    assertCsrf: async (req) => {
      if (!["GET", "HEAD"].includes(req.method) && req.headers["x-open-science-csrf"] !== "fixture-csrf") throw new HttpError(403, "csrf_required", "CSRF required.");
    },
    requireProject: async (_user, id) => {
      if (id !== "owned-project") throw new HttpError(404, "project_not_found", "Project unavailable.");
      return { id };
    },
  };
  const handle = createCapsuleRoutes({ store, service, maxJsonBytes: 262144 });
  const server = createServer((req, res) => {
    handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }).catch((error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: "fixture_session=active", "x-open-science-csrf": "fixture-csrf", "content-type": "application/json" };
  return { base, headers, calls };
}

test("capsule APIs require a live account and CSRF for mutation", async (t) => {
  const { base, headers, calls } = await fixture(t);
  assert.equal((await fetch(`${base}/api/capsules`)).status, 401);
  assert.equal((await fetch(`${base}/api/capsules`, { method: "POST", headers: { cookie: headers.cookie }, body: JSON.stringify({ title: "Capsule" }) })).status, 403);
  const response = await fetch(`${base}/api/capsules`, { method: "POST", headers, body: JSON.stringify({ title: "Capsule" }) });
  assert.equal(response.status, 201);
  assert.equal(calls[0].user, "owner");
});

test("clients cannot impersonate an entry origin or change its account", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const request = (body) => fetch(`${base}/api/capsules/capsule-one/entries`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await request({ factKind: "preference", content: "Use concise text", origin: "system", userId: "other" })).status, 400);
  const response = await request({ factKind: "preference", content: "Use concise text", layer: "profile" });
  assert.equal(response.status, 201);
  assert.equal(calls[0].body.origin, "explicit");
  assert.deepEqual(calls[0].body.provenance, [{ type: "user", id: "owner" }]);
});

test("activation and recall reject projects the account does not own", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const foreign = await fetch(`${base}/api/capsules/capsule-one/activate`, { method: "POST", headers, body: JSON.stringify({ projectId: "other-project", mode: "own" }) });
  assert.equal(foreign.status, 404);
  assert.equal(calls.length, 0);
  const response = await fetch(`${base}/api/capsules/recall`, { method: "POST", headers, body: JSON.stringify({ query: "method", projectId: "owned-project" }) });
  assert.equal(response.status, 200);
  assert.equal(calls[0].body.projectId, "owned-project");
});
