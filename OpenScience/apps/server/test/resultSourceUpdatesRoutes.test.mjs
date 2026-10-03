import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createResultSourceUpdatesRoutes } from "../src/resultSourceUpdatesRoutes.mjs";

const versionId = `rv_${"a".repeat(64)}`;
const digest = "b".repeat(64);
function fixture({ lookupState = "changed", disabled = false, lookupFails = false } = {}) {
  const calls = [];
  const sourceInputs = [
    { kind: "source", id: "10.1234/OLD", digest: "c".repeat(64), versionId: `rv_${"d".repeat(64)}`, availability: "captured" },
    { kind: "source", id: "evidence/no-doi.md", digest: "e".repeat(64), availability: "reference" },
    { kind: "source", id: "10.1234/private", availability: "restricted" },
    { kind: "code", id: "10.1234/not-source", availability: "captured" },
  ];
  const store = {
    ensureSessionUser: async (_req, _res, options) => { assert.equal(options.allowDevAuth, false); calls.push(["session"]); return { user: { id: "actor" } }; },
    assertCsrf: async () => { calls.push(["csrf"]); },
    requireProject: async (_user, projectId) => { calls.push(["project", projectId]); if (projectId !== "p") throw Object.assign(new Error("denied"), { code: "project_forbidden" }); },
  };
  const results = { get: async (...args) => { calls.push(["result", ...args]); return { versionId, digest, inputs: sourceInputs }; } };
  const status = { state: lookupState, checkedAt: "2026-10-02T00:00:00Z", updates: lookupState === "changed" ? [{ kind: "correction", noticeDoi: "10.1234/fix", date: null, source: "publisher" }] : [] };
  const lookup = disabled ? null : { lookupStatuses: async (dois) => { calls.push(["lookup", dois]); if (lookupFails) throw new Error("timeout"); return new Map([["10.1234/old", status]]); } };
  const impacts = { reconcileSourceUpdate: async (...args) => { calls.push(["reconcile", ...args]); return { items: [{ id: "impact", payload: { versionId } }] }; },
    get: async () => ({ id: "impact", payload: { versionId } }) };
  const route = createResultSourceUpdatesRoutes({ store, results, lookup, impacts, maxJsonBytes: 16384 });
  const invoke = async (body = { projectId: "p" }, method = "POST", url = `/api/results/${versionId}/source-updates`) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(req, { url, method, headers: {} });
    let output;
    const res = { writeHead(code) { assert.equal(code, 200); }, end(bytes) { output = JSON.parse(bytes); } };
    assert.equal(await route(req, res), true);
    return output.data;
  };
  return { calls, store, results, sourceInputs, impacts, invoke };
}
test("source checks authenticate and bind recorded immutable inputs, without caller evidence or workspace fallback", async () => {
  const f = fixture(); const reply = await f.invoke();
  assert.deepEqual(f.calls.slice(0, 4), [["session"], ["csrf"], ["project", "p"], ["result", "actor", "p", versionId]]);
  assert.deepEqual(f.calls.find(call => call[0] === "lookup"), ["lookup", ["10.1234/old"]]);
  assert.equal(f.calls.filter(call => call[0] === "result").length, 3);
  assert.deepEqual(f.calls.find(call => call[0] === "reconcile")[2].source, { id: f.sourceInputs[0].id, digest: f.sourceInputs[0].digest, versionId: f.sourceInputs[0].versionId });
  assert.equal(reply.versionId, versionId); assert.equal(reply.digest, digest);
  assert.deepEqual(reply.statuses.map(row => row.updateStatus.state), ["changed", "unknown", "unavailable"]);
  assert.equal(reply.statuses[1].updateStatus.reason, "not_identified");
  assert.equal(reply.statuses[2].updateStatus.reason, "restricted");
  assert.equal(f.calls.filter(call => call[0] === "reconcile").length, 2);
  assert.equal(reply.impacts.items.length, 1);
  await assert.rejects(f.invoke({ projectId: "p", dois: ["10.1234/injected"] }), { code: "result_source_updates_payload_invalid" });
  await assert.rejects(f.invoke({ projectId: "p", source: { id: "forged" } }), { code: "result_source_updates_payload_invalid" });
});
test("disabled, failed and unknown lookups are explicit and never reported clean", async () => {
  for (const [options, state, reason] of [[{ disabled: true }, "unavailable", "disabled"], [{ lookupFails: true }, "unavailable", "lookup_failed"], [{ lookupState: "unknown" }, "unknown", undefined], [{ lookupState: "unavailable" }, "unavailable", undefined], [{ lookupState: "no_update" }, "no_update", undefined]]) {
    const reply = await fixture(options).invoke();
    assert.equal(reply.statuses[0].updateStatus.state, state);
    assert.equal(reply.statuses[0].updateStatus.reason, reason);
  }
});
test("failed auth, CSRF, project access and stale version never invoke external lookup", async () => {
  for (const boundary of ["session", "csrf", "project", "version"]) {
    const f = fixture();
    const reject = async () => { throw Object.assign(new Error("denied"), { code: "denied" }); };
    if (boundary === "session") f.store.ensureSessionUser = reject;
    if (boundary === "csrf") f.store.assertCsrf = reject;
    if (boundary === "project") f.store.requireProject = reject;
    if (boundary === "version") f.results.get = async () => ({ versionId: `rv_${"f".repeat(64)}`, inputs: [] });
    await assert.rejects(f.invoke());
    assert.equal(f.calls.some(call => call[0] === "lookup"), false);
  }
  const f = fixture(); await assert.rejects(f.invoke({ projectId: "p" }, "GET"), { code: "method_not_allowed" });
  await assert.rejects(f.invoke({ projectId: "p" }, "POST", "/api/results/rv_invalid/source-updates"), { code: "result_identifier_invalid" });
});
test("revocation during lookup is rechecked before publishing statuses or impacts", async () => {
  const f = fixture(); let reads = 0; const get = f.results.get;
  f.results.get = async (...args) => { if (++reads === 2) throw Object.assign(new Error("revoked"), { code: "project_forbidden" }); return get(...args); };
  await assert.rejects(f.invoke(), { code: "project_forbidden" });
  assert.equal(f.calls.some(call => call[0] === "reconcile"), false);
  const stale = fixture(); let checks = 0; const original = stale.results.get;
  stale.results.get = async (...args) => { const reply = await original(...args); return ++checks === 2 ? { ...reply, digest: "changed" } : reply; };
  await assert.rejects(stale.invoke(), { code: "result_version_conflict" });
  assert.equal(stale.calls.some(call => call[0] === "reconcile"), false);
});
test("a source restricted or deleted during lookup releases no prior identity, notice or impact", async () => {
  for (const availability of ["restricted", "deleted"]) {
    const f = fixture(); let reads = 0; const get = f.results.get;
    f.results.get = async (...args) => {
      const reply = await get(...args);
      return ++reads >= 2 ? { ...reply, inputs: [{ ...reply.inputs[0], availability }] } : reply;
    };
    const reply = await f.invoke();
    assert.deepEqual(reply.statuses, [{ source: { id: "unavailable-source" }, doi: null,
      updateStatus: { state: "unavailable", checkedAt: null, reason: availability, updates: [] } }]);
    assert.deepEqual(reply.impacts.items, []);
    assert.equal(f.calls.some(call => call[0] === "reconcile"), false);
    assert.equal(JSON.stringify(reply).includes("10.1234/OLD"), false);
    assert.equal(JSON.stringify(reply).includes("10.1234/fix"), false);
  }
});
test("access narrowed while recording impacts cannot publish the earlier source-check status", async () => {
  const f = fixture();
  const reconcile = f.impacts.reconcileSourceUpdate;
  f.impacts.reconcileSourceUpdate = async (...args) => { const reply = await reconcile(...args); f.sourceInputs[0].availability = "restricted"; return reply; };
  f.impacts.get = async () => ({ id: "impact", payload: { versionId, source: { id: "unavailable-source" }, sourceStatus: {
    state: "unavailable", checkedAt: null, reason: "restricted", updates: [] } } });
  const reply = await f.invoke();
  assert.deepEqual(reply.statuses[0], { source: { id: "unavailable-source" }, doi: null,
    updateStatus: { state: "unavailable", checkedAt: null, reason: "restricted", updates: [] } });
  assert.equal(JSON.stringify(reply).includes("10.1234/OLD"), false);
  assert.equal(JSON.stringify(reply).includes("10.1234/fix"), false);
});
