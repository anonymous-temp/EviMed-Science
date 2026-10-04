// The routes of a personal skill's package and update: the supply is a read, the preview is a read, and the update is a
// POST that names the revision it is based on. Closed queries and bodies, the authenticated actor captured.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createSkillLibraryRoutes } from "../src/skillLibraryRoutes.mjs";

function fixture() {
  /** @type {any[]} */ const calls = [];
  const user = { id: "authenticated-actor", accountCreatedAt: "epoch" };
  const record = (/** @type {string} */ name) => async (/** @type {any[]} */ ...args) => { calls.push([name, ...args]); return { ok: name }; };
  const handler = createSkillLibraryRoutes({
    store: { ensureSessionUser: async () => ({ user }), assertCsrf: async () => {}, requireProject: async () => ({}) },
    service: { supplyOf: record("supplyOf"), updatePreview: record("updatePreview"), applyUpdate: record("applyUpdate") },
    maxJsonBytes: 4096,
  });
  return { handler, calls, user };
}
async function request(/** @type {any} */ f, /** @type {string} */ url, method = "GET", body = null) {
  const req = /** @type {any} */ (Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []));
  req.url = url; req.method = method; req.headers = { "content-type": "application/json" };
  /** @type {any} */ let answer; const res = { status: 0, setHeader() {}, writeHead(/** @type {number} */ status) { this.status = status; }, end(/** @type {any} */ value) { answer = JSON.parse(String(value)); } };
  await f.handler(req, res);
  return { status: res.status, answer };
}

test("the supply route reads the current revision or a named one and takes no other query", async () => {
  const f = fixture();
  assert.equal((await request(f, "/api/skills/skill%3Aone/supply")).answer.data.ok, "supplyOf");
  assert.deepEqual(f.calls.at(-1).slice(0, 4), ["supplyOf", f.user, "skill:one", null]);
  await request(f, "/api/skills/skill%3Aone/supply?revision=3");
  assert.equal(f.calls.at(-1)[3], 3);
  await assert.rejects(request(f, "/api/skills/skill%3Aone/supply?path=/private"), { status: 400 });
  await assert.rejects(request(f, "/api/skills/skill%3Aone/supply?revision=1&revision=2"), { status: 400 });
});

test("the update preview and the update are POSTs by the authenticated actor; the update answers 201 with a new revision", async () => {
  const f = fixture();
  assert.equal((await request(f, "/api/skills/skill%3Aone/update-preview", "POST", { resourceId: "upload:x" })).status, 200);
  assert.deepEqual(f.calls.at(-1).slice(0, 4), ["updatePreview", f.user, "skill:one", { resourceId: "upload:x" }]);
  const body = { resourceId: "upload:x", expectedRevision: 2, resolutions: { instructions: "local" } };
  assert.equal((await request(f, "/api/skills/skill%3Aone/update", "POST", body)).status, 201);
  assert.deepEqual(f.calls.at(-1).slice(0, 4), ["applyUpdate", f.user, "skill:one", body]);
  await assert.rejects(request(f, "/api/skills/skill%3Aone/update-preview", "GET"), { status: 404 });
});
