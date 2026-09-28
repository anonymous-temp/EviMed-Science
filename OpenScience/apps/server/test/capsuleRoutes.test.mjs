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
  // Only a document's publication writes the document layer; an entry the
  // researcher put there would be recalled nowhere and listed nowhere.
  const document = await request({ factKind: "project_fact", content: "据资料《指南》：…", layer: "sources" });
  assert.equal(document.status, 400);
  assert.equal((await document.json()).code, "capsule_payload_invalid");
  assert.equal(calls.length, 1, "the service never saw it");
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

test("transfer routes bind export/import to the live user and require explicit body fields",async(t)=>{
  const calls=[];
  const store={ensureSessionUser:async()=>({user:{id:"transfer-owner",accountCreatedAt:"test-only-account-epoch"}}),assertCsrf:async()=>{}};
  const transferService={preview:async(user,input,context)=>{calls.push({user,input,context});return{canImport:true};},export:async(user,id,input)=>{calls.push({user,id,input});return{archive:"ciphertext"};}};
  const handle=createCapsuleRoutes({store,service:{},transferService,maxJsonBytes:100000});
  const server=createServer((req,res)=>{handle(req,res).catch(error=>sendError(res,error));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const options={method:"POST",headers:{"content-type":"application/json"}};
  assert.equal((await fetch(`${base}/api/capsules/transfers/preview`,{...options,body:JSON.stringify({archive:"fixture",password:"test-only-transfer"})})).status,200);
  assert.equal(calls[0].user,"transfer-owner");
  // The project the scan is metered to rides along; this store has none selected.
  assert.deepEqual(calls[0].context,{accountCreatedAt:"test-only-account-epoch",projectId:null});
  assert.equal((await fetch(`${base}/api/capsules/cap-one/exports`,{...options,body:JSON.stringify({password:"test-only-transfer",userId:"other"})})).status,400);
});

test("a received pack: shelf, one-click enable and disable, and a trial marked on the conversation in the current project", async (t) => {
  const calls = [];
  const service = {
    received: async (user, options) => { calls.push(["received", user, options]); return []; },
    enableReceived: async (user, id, options) => { calls.push(["enable", user, id, options]); return { id, enabled: true }; },
    disable: async (user, id) => { calls.push(["disable", user, id]); return { disabled: true, lists: 1 }; },
    prepareTrial: async (user, id, options) => { calls.push(["prepare", user, id, options]); return { id }; },
  };
  const marked = [];
  const store = {
    ensureSessionUser: async () => ({ user: { id: "owner" } }),
    assertCsrf: async () => {},
    selectedProject: async () => ({ id: "current-project" }),
  };
  const handle = createCapsuleRoutes({ store, service, maxJsonBytes: 262144,
    trials: { mark: async (...args) => { marked.push(args); } } });
  const server = createServer((req, res) => { handle(req, res).catch((error) => sendError(res, error)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/capsules`;
  const post = (path, body = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await fetch(`${base}/received`)).status, 200);
  assert.equal((await post("/pack-1/enable")).status, 200);
  assert.equal((await post("/pack-1/disable")).status, 200);
  assert.equal((await post("/pack-1/enable", { mode: "own" })).status, 400, "a received pack is a reference; nothing else can be asked for");
  const trial = await post("/pack-1/trial", { sessionId: "ses-new-1" });
  assert.equal(trial.status, 200);
  assert.deepEqual((await trial.json()).data, { capsuleId: "pack-1", sessionId: "ses-new-1" });
  assert.deepEqual(marked, [["owner", "current-project", "ses-new-1", "pack-1"]]);
  assert.equal((await post("/pack-1/trial", { sessionId: "bad id" })).status, 400);
  assert.deepEqual(calls.map((call) => call[0]), ["received", "enable", "disable", "prepare"]);
  assert.deepEqual(calls[1][3], { projectId: "current-project" }, "the scan an old pack needs is metered to the project the researcher is in");

  const noTrials = createCapsuleRoutes({ store, service, maxJsonBytes: 262144 });
  const other = createServer((req, res) => { noTrials(req, res).catch((error) => sendError(res, error)); });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { other.closeAllConnections(); other.close(resolve); }));
  const unavailable = await fetch(`http://127.0.0.1:${other.address().port}/api/capsules/pack-1/trial`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "ses-new-2" }) });
  assert.equal(unavailable.status, 503);
});

// Build spec §9.4 #6: 「启用范围可选账号或某个项目」. Until 2026-09-28 the
// route took no body and every enable was account-wide.
test("a received pack can be enabled for one project the account opens, and only for such a project", async (t) => {
  const calls = [];
  const audited = [];
  const service = {
    enableReceived: async (user, id, options) => { calls.push(options); return { id, enabled: true, enabledIn: options.onlyProject ? "project" : "account" }; },
  };
  const store = {
    ensureSessionUser: async () => ({ user: { id: "owner" } }),
    assertCsrf: async () => {},
    selectedProject: async () => ({ id: "current-project" }),
    requireProject: async (_user, id) => {
      if (id !== "owned-project") throw new HttpError(404, "project_not_found", "Project unavailable.");
      return { id };
    },
  };
  const handle = createCapsuleRoutes({ store, service, maxJsonBytes: 262144,
    audit: async (_user, action, details) => { audited.push({ action, details }); } });
  const server = createServer((req, res) => { handle(req, res).catch((error) => sendError(res, error)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/capsules/pack-1/enable`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const scoped = await post({ projectId: "owned-project" });
  assert.equal(scoped.status, 200);
  assert.equal((await scoped.json()).data.enabledIn, "project");
  assert.deepEqual(calls[0], { projectId: "owned-project", onlyProject: true });
  assert.deepEqual(audited[0], { action: "capsule.pack.enable", details: { capsuleId: "pack-1", projectId: "owned-project" } });

  assert.equal((await post({ projectId: "someone-elses" })).status, 404, "a project the account cannot open is refused, not enabled");
  assert.equal((await post({ projectId: "" })).status, 400);
  assert.equal((await post({ projectId: 7 })).status, 400);
  assert.equal(calls.length, 1, "nothing refused reached the service");

  assert.equal((await post({})).status, 200);
  assert.deepEqual(calls[1], { projectId: "current-project" }, "no project named: every project, the scan metered where the researcher is");
});

// 2026-09-26 audit (M-6): no pack action wrote an audit row (build spec §12).
test("every action on a pack writes an audit row with ids and counts, and a preview writes none", async (t) => {
  const audited = [];
  const service = {
    enableReceived: async (_user, id) => ({ id, enabled: true }),
    disable: async () => ({ disabled: true, lists: 1 }),
    prepareTrial: async (_user, id) => ({ id }),
  };
  const transferService = {
    exportPreview: async (_user, id, input) => ({ empty: false, scopes: input.scopes ?? ["workstyle"], card: null, entries: [] }),
    export: async () => ({ archive: "ciphertext", filename: "capsule-s1.evimedcap",
      snapshot: { id: "snap-1", entryCount: 3, scopes: ["workstyle"], recipientCount: 1, supersedes: null } }),
    revoke: async (_user, _capsule, id) => ({ id, status: "revoked" }),
    import: async () => ({ id: "pack-2", payload: { transfer: { snapshotId: "snap-9", issuerTrust: "verified", upgradedAt: "2026-09-27T00:00:00Z" },
      scan: { dropped: [{ id: "x" }] } } }),
  };
  const store = { ensureSessionUser: async () => ({ user: { id: "owner", accountCreatedAt: "epoch" } }), assertCsrf: async () => {},
    selectedProject: async () => ({ id: "current-project" }) };
  const handle = createCapsuleRoutes({ store, service, transferService, maxJsonBytes: 262144,
    trials: { mark: async () => {} }, audit: async (user, action, details) => { audited.push({ user: user.id, action, details }); } });
  const server = createServer((req, res) => { handle(req, res).catch((error) => sendError(res, error)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/capsules`;
  const call = (method, path, body = {}) => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await call("POST", "/mine-1/exports/preview", { scopes: ["workstyle"] })).status, 200);
  assert.deepEqual(audited, [], "reading what a pack would carry is not an action on one");
  assert.equal((await call("POST", "/mine-1/exports", { password: "test-only-transfer", recipients: ["colleague"] })).status, 201);
  assert.equal((await call("DELETE", "/mine-1/exports/snap-1", { expectedRevision: 1 })).status, 200);
  assert.equal((await call("POST", "/transfers/import", { archive: "x", expectedDigest: "d", confirmed: true })).status, 201);
  assert.equal((await call("POST", "/pack-2/enable")).status, 200);
  assert.equal((await call("POST", "/pack-2/disable")).status, 200);
  assert.equal((await call("POST", "/pack-2/trial", { sessionId: "ses-1" })).status, 200);
  assert.deepEqual(audited.map((row) => row.action), [
    "capsule.pack.export", "capsule.pack.revoke", "capsule.pack.upgrade", "capsule.pack.enable", "capsule.pack.disable", "capsule.pack.trial",
  ]);
  assert.ok(audited.every((row) => row.user === "owner"));
  assert.deepEqual(audited[0].details, { capsuleId: "mine-1", snapshotId: "snap-1", entries: 3, scopes: ["workstyle"], recipients: 1, supersedes: null });
  assert.equal(audited[2].details.dropped, 1);
  assert.ok(!JSON.stringify(audited).includes("test-only-transfer"), "no password, no content");
});
