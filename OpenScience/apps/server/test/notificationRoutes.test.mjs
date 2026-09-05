import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createNotificationRoutes } from "../src/notificationRoutes.mjs";
import { HttpError, sendError } from "../src/security.mjs";

async function fixture(t) {
  const calls = [];
  const service = {
    list: async (user, options) => { calls.push({ action: "list", user, options }); return { items: [], nextCursor: null }; },
    markRead: async (user, id, revision) => { calls.push({ action: "read", user, id, revision }); return { id, revision: revision + 1 }; },
    resolve: async (user, id, body) => { calls.push({ action: "resolve", user, id, body }); return { id, resolution: body }; },
    preferences: async (user) => { calls.push({ action: "preferences", user }); return { revision: 1, channels: ["in-app"] }; },
    updatePreferences: async (user, body, revision) => { calls.push({ action: "update-preferences", user, body, revision }); return { ...body, revision: revision + 1 }; },
  };
  const store = {
    ensureSessionUser: async (req) => {
      if (req.headers.cookie !== "fixture=active") throw new HttpError(401, "unauthorized", "Authentication required.");
      return { user: { id: "owner" } };
    },
    assertCsrf: async (req) => {
      if (!["GET", "HEAD"].includes(req.method) && req.headers["x-open-science-csrf"] !== "csrf") throw new HttpError(403, "csrf_required", "CSRF required.");
    },
  };
  const handle = createNotificationRoutes({ store, service, maxJsonBytes: 64 * 1024 });
  const server = createServer((req, res) => { void handle(req, res).then((done) => {
    if (!done) { res.writeHead(404); res.end(); }
  }).catch((error) => sendError(res, error)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/inbox`;
  const headers = { cookie: "fixture=active", "x-open-science-csrf": "csrf", "content-type": "application/json" };
  return { base, headers, calls };
}

test("inbox routes require authentication and CSRF while preserving typed filters", async (t) => {
  const { base, headers, calls } = await fixture(t);
  assert.equal((await fetch(`${base}?unread=true`)).status, 401);
  const page = await fetch(`${base}?noticeType=review&unread=true&unresolved=true&limit=20`, { headers: { cookie: headers.cookie } });
  assert.equal(page.status, 200);
  assert.deepEqual(calls[0].options, { noticeType: "review", unreadOnly: true, unresolvedOnly: true, limit: 20, cursor: null });
  assert.equal((await fetch(`${base}/notice-one/read`, { method: "POST", headers: { cookie: headers.cookie }, body: '{"expectedRevision":1}' })).status, 403);
  assert.equal((await fetch(`${base}/notice-one/read`, { method: "POST", headers, body: '{"expectedRevision":1,"userId":"other"}' })).status, 400);
  assert.equal((await fetch(`${base}/notice-one/read`, { method: "POST", headers, body: '{"expectedRevision":1}' })).status, 200);
  assert.deepEqual(calls.at(-1), { action: "read", user: "owner", id: "notice-one", revision: 1 });
});

test("resolution and preference updates accept only their closed contracts", async (t) => {
  const { base, headers, calls } = await fixture(t);
  assert.equal((await fetch(`${base}/notice-one/resolve`, { method: "POST", headers,
    body: '{"actionId":"approve","expectedRevision":2}' })).status, 200);
  assert.deepEqual(calls.at(-1).body, { actionId: "approve", expectedRevision: 2 });
  assert.equal((await fetch(`${base}/preferences`, { headers: { cookie: headers.cookie } })).status, 200);
  const settings = { quietHours: { start: "23:00", end: "07:00" }, digestTime: "08:30",
    switches: { notify: true, question: true, review: true }, channels: ["in-app"], expectedRevision: 1 };
  assert.equal((await fetch(`${base}/preferences`, { method: "PATCH", headers, body: JSON.stringify(settings) })).status, 200);
  assert.equal(calls.at(-1).revision, 1);
  assert.equal((await fetch(`${base}/preferences`, { method: "PATCH", headers, body: JSON.stringify({ ...settings, email: true }) })).status, 400);
});
