import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAutopilotRoutes } from "../src/autopilotRoutes.mjs";
import { HttpError, sendError } from "../src/security.mjs";

async function fixture(t, digestProjectId = "owned-project") {
  const calls = [];
  const agenda = { id: "agenda-one", projectId: "owned-project", revision: 2 };
  const digest = { id: "digest-one", projectId: digestProjectId, revision: 1 };
  const service = {
    projectAgenda: agenda => agenda,
    assertNotArchived: () => {},
    list: async (userId, options) => { calls.push({ method: "list", userId, options }); return { items: [agenda], nextCursor: null }; },
    create: async (userId, body) => { calls.push({ method: "create", userId, body }); return agenda; },
    get: async (_user, id) => {
      if (id !== agenda.id) throw new HttpError(404, "autopilot_agenda_not_found", "Agenda unavailable.");
      return agenda;
    },
    update: async (userId, id, body) => { calls.push({ method: "update", userId, id, body }); return agenda; },
    archive: async (userId, id, body) => { calls.push({ method: "archive", userId, id, body }); return agenda; },
    runNow: async (userId, id, body) => { calls.push({ method: "runNow", userId, id, body }); return { episode: { id: "episode-manual" } }; },
    followUp: async (userId, id, body) => { calls.push({ method: "followUp", userId, id, body }); return { episode: { id: "episode-follow-up" } }; },
    start: async (userId, id, body) => { calls.push({ method: "start", userId, id, body }); return agenda; },
    stop: async (userId, id, body) => { calls.push({ method: "stop", userId, id, body }); return agenda; },
    schedule: async (userId, id, body) => { calls.push({ method: "schedule", userId, id, body }); return { episode: { id: "episode-one" } }; },
    listDigests: async (userId, options) => { calls.push({ method: "digests", userId, options }); return { items: [digest], nextCursor: null }; },
    listEpisodes: async (userId, options) => { calls.push({ method: "episodes", userId, options }); return { items: [], nextCursor: null }; },
    getDigest: async () => digest,
    markDigestOpened: async (userId, id) => { calls.push({ method: "opened", userId, id }); return digest; },
    decide: async (userId, id, body) => { calls.push({ method: "decide", userId, id, body }); return digest; },
    researchState: async (userId, id) => { calls.push({ method: "researchState", userId, id }); return { found: [], unresolved: [], materials: [] }; },
    addMaterials: async (userId, id, body) => { calls.push({ method: "addMaterials", userId, id, body }); return agenda; },
    removeMaterial: async (userId, id, sourceId) => { calls.push({ method: "removeMaterial", userId, id, sourceId }); return agenda; },
  };
  const store = {
    ensureSessionUser: async (req) => {
      if (req.headers.cookie !== "fixture=active") throw new HttpError(401, "unauthorized", "Authentication required.");
      return { user: { id: "owner" } };
    },
    assertCsrf: async (req) => {
      if (!["GET", "HEAD"].includes(req.method) && req.headers["x-open-science-csrf"] !== "csrf") throw new HttpError(403, "csrf_required", "CSRF required.");
    },
    requireProject: async (_user, id) => {
      if (id !== "owned-project") throw new HttpError(404, "project_not_found", "Project unavailable.");
      return { id };
    },
  };
  const route = createAutopilotRoutes({ store, service, maxJsonBytes: 64 * 1024 });
  const server = createServer((req, res) => route(req, res).then((handled) => {
    if (!handled) { res.writeHead(404); res.end(); }
  }).catch((error) => sendError(res, error)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`,
    headers: { cookie: "fixture=active", "content-type": "application/json", "x-open-science-csrf": "csrf" }, calls };
}

test("agenda endpoints bind ownership and reject browser identity fields", async (t) => {
  const { base, headers, calls } = await fixture(t);
  assert.equal((await fetch(`${base}/api/autopilot/agendas?projectId=other`, { headers })).status, 404);
  const response = await fetch(`${base}/api/autopilot/agendas`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", title: "Agenda", topics: ["topic"], taskTypes: ["evidence-update"],
      dailyBudgetCny: 5, weeklyBudgetCny: 20, maxEpisodeCny: 3, scheduleHour: 1, timeZone: "Asia/Shanghai" }) });
  assert.equal(response.status, 201);
  assert.equal(calls.find((call) => call.method === "create").userId, "owner");
  assert.equal((await fetch(`${base}/api/autopilot/agendas`, { method: "POST", headers,
    body: JSON.stringify({ projectId: "owned-project", userId: "other" }) })).status, 400);
});

test("start, stop and schedule are explicit CSRF-guarded operations", async (t) => {
  const { base, headers, calls } = await fixture(t);
  for (const [action, body] of [["start", { expectedRevision: 2 }], ["stop", { expectedRevision: 2 }], ["schedule", { date: "2026-09-06" }]]) {
    const response = await fetch(`${base}/api/autopilot/agendas/agenda-one/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls.filter((call) => ["start", "stop", "schedule"].includes(call.method)).map((call) => call.method), ["start", "stop", "schedule"]);
});

test("digest decisions are scoped and accept only declared fields", async (t) => {
  const { base, headers, calls } = await fixture(t);
  assert.equal((await fetch(`${base}/api/autopilot/digests?projectId=owned-project`, { headers })).status, 200);
  // A task's history is read per project, optionally per agenda, and only
  // for a project the account owns.
  assert.equal((await fetch(`${base}/api/autopilot/episodes?projectId=other`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/autopilot/episodes?projectId=owned-project&agendaId=agenda-one`, { headers })).status, 200);
  assert.deepEqual(calls.find((call) => call.method === "episodes"), { method: "episodes", userId: "owner", options: { projectId: "owned-project", agendaId: "agenda-one" } });
  const response = await fetch(`${base}/api/autopilot/digests/digest-one/decisions`, { method: "POST", headers,
    body: JSON.stringify({ action: "adopt", claimId: "claim-one", note: "continue" }) });
  assert.equal(response.status, 200);
  assert.equal(calls.find((call) => call.method === "decide").userId, "owner");
});

test("an individual digest loads without activity and records an explicit authenticated open", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const url = `${base}/api/autopilot/digests/digest-one`;
  assert.equal((await fetch(url)).status, 401);
  const loaded = await fetch(url, { headers });
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).data.projectId, "owned-project");
  assert.equal(calls.some(call => call.method === "opened"), false);
  assert.equal((await fetch(`${url}/opened`, { method: "POST", headers: { cookie: headers.cookie }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${url}/opened`, { method: "POST", headers, body: '{"openedAt":"2099-01-01"}' })).status, 400);
  assert.equal((await fetch(`${url}/opened`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.deepEqual(calls.at(-1), { method: "opened", userId: "owner", id: "digest-one" });
});

test("a digest read or open still requires access to its actual project", async (t) => {
  const { base, headers, calls } = await fixture(t, "other-project");
  assert.equal((await fetch(`${base}/api/autopilot/digests/digest-one`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/autopilot/digests/digest-one/opened`, { method: "POST", headers, body: "{}" })).status, 404);
  assert.equal(calls.some(call => call.method === "opened"), false);
});

test('task detail, edit, deletion and immediate follow-ups enforce auth, CSRF and field allowlists', async t => {
  const { base, headers, calls } = await fixture(t);
  const url = `${base}/api/autopilot/agendas/agenda-one`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/autopilot/agendas/foreign`, { headers })).status, 404);
  for (const [suffix, method, body] of [
    ['', 'PATCH', { expectedRevision: 2, prompt: 'An exact edited instruction', schedule: { kind: 'weekly', weekdays: [1], time: '07:35', timeZone: 'Asia/Shanghai' } }],
    ['', 'DELETE', { expectedRevision: 2 }],
    ['/run-now', 'POST', { requestId: 'click-one' }],
    ['/follow-ups', 'POST', { requestId: 'message-one', note: 'Explain this result', episodeId: 'episode-one' }],
  ]) {
    assert.equal((await fetch(url + suffix, { method, headers: { cookie: headers.cookie }, body: JSON.stringify(body) })).status, 403);
    assert.equal((await fetch(url + suffix, { method, headers, body: JSON.stringify({ ...body, enabled: true }) })).status, 400);
    assert.equal((await fetch(url + suffix, { method, headers, body: JSON.stringify(body) })).status, 200);
  }
  assert.deepEqual(calls.filter(call => ['update', 'archive', 'runNow', 'followUp'].includes(call.method)).map(call => [call.method, call.userId]),
    [['update', 'owner'], ['archive', 'owner'], ['runNow', 'owner'], ['followUp', 'owner']]);
});

test("the question's progress and material are read and changed only through an owned agenda, with CSRF and declared fields", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const { cookie } = headers;
  assert.equal((await fetch(`${base}/api/autopilot/agendas/agenda-one/progress`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/autopilot/agendas/agenda-other/progress`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/autopilot/agendas/agenda-one/progress`)).status, 401);
  assert.deepEqual(calls.filter((call) => call.method === "researchState"), [{ method: "researchState", userId: "owner", id: "agenda-one" }]);

  const add = (body, extra = {}) => fetch(`${base}/api/autopilot/agendas/agenda-one/materials`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await add({ sha256: ["a".repeat(64)] })).status, 200);
  assert.equal((await add({ sourceIds: ["src_" + "a".repeat(32)] })).status, 200);
  assert.deepEqual(calls.filter((call) => call.method === "addMaterials").map((call) => call.body), [{ sha256: ["a".repeat(64)] }, { sourceIds: ["src_" + "a".repeat(32)] }]);
  assert.equal((await add({ sourceIds: [], projectId: "other" })).status, 400, "a project is never named by the browser: the question's own is used");
  assert.equal((await add({ sha256: ["a".repeat(64)] }, { "x-open-science-csrf": "wrong" })).status, 403);
  assert.equal((await fetch(`${base}/api/autopilot/agendas/agenda-other/materials`, { method: "POST", headers, body: JSON.stringify({ sha256: ["a".repeat(64)] }) })).status, 404);

  const remove = await fetch(`${base}/api/autopilot/agendas/agenda-one/materials/${encodeURIComponent("src_" + "a".repeat(32))}`, { method: "DELETE", headers });
  assert.equal(remove.status, 200);
  assert.deepEqual(calls.find((call) => call.method === "removeMaterial"), { method: "removeMaterial", userId: "owner", id: "agenda-one", sourceId: "src_" + "a".repeat(32) });
  assert.equal((await fetch(`${base}/api/autopilot/agendas/agenda-one/materials`, { method: "GET", headers })).status, 404);
});
