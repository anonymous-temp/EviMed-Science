import assert from "node:assert/strict";
import test from "node:test";
import { OpenVikingSourceSync } from "../src/openVikingSourceSync.mjs";

function fixture() {
  const records = new Map();
  const documents = {
    async get(userId, kind, id) { return records.get(`${userId}:${kind}:${id}`) ?? null; },
    async put(userId, kind, id, payload, options) {
      const key = `${userId}:${kind}:${id}`;
      const previous = records.get(key);
      assert.equal(previous?.revision ?? 0, options.expectedRevision);
      const value = { id, payload, revision: options.expectedRevision + 1 };
      records.set(key, value);
      return value;
    },
  };
  const seen = [];
  const libraries = [];
  const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, sources: { documents }, resources: { configured: true }, jobs: {} });
  sync.reconcileProject = async (userId, projectId) => {
    assert.ok(projectId, "library-only scopes must not reconcile a nonexistent project");
    seen.push(`${userId}:${projectId}`);
    return { pushed: 0, removed: 0, failed: [] };
  };
  sync.reconcileLibrary = async (userId) => { libraries.push(userId); return { pushed: 0, removed: 0, failed: [] }; };
  return { sync, records, seen, libraries };
}

test("periodic reconciliation persists attempts so more than fifty projects make progress", async () => {
  const { sync, records, seen } = fixture();
  const scopes = Array.from({ length: 201 }, (_, i) => ({ userId: "u1", projectId: `p${String(i).padStart(3, "0")}` }));
  const projects = async () => [...scopes].sort((a, b) => {
    const at = (scope) => records.get(`${scope.userId}:preferences:ov-resource-check:${scope.projectId}`)?.payload.checkedAt ?? "";
    return at(a).localeCompare(at(b)) || a.projectId.localeCompare(b.projectId);
  }).slice(0, 200);
  for (let pass = 0; pass < 5; pass++) await sync.reconcileAll({ projects });
  assert.equal(new Set(seen).size, 201);
  assert.equal(records.size, 201);
});

test("library-only owners remain in the reconciliation pass", async () => {
  const { sync, libraries, seen } = fixture();
  const result = await sync.reconcileAll({ projects: async () => [{ userId: "library-only", projectId: null }] });
  assert.equal(result.error, null);
  assert.deepEqual(seen, []);
  assert.deepEqual(libraries, ["library-only"]);
});
