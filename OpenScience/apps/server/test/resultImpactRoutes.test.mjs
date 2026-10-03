import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createResultImpactRoutes } from "../src/resultImpactRoutes.mjs";

test("impact routes require session, CSRF and project access before reading or continuing", async () => {
  const seen = [];
  const service = { list: async (...args) => { seen.push(["list", ...args]); return { items: [], nextCursor: null }; },
    continueImpact: async (...args) => { seen.push(["continue", ...args]); return { id: "impact" }; } };
  const store = { ensureSessionUser: async () => { seen.push(["session"]); return { user: { id: "alice" } }; },
    assertCsrf: async () => { seen.push(["csrf"]); }, requireProject: async (_user, id) => { seen.push(["project", id]); if (id !== "p") throw Object.assign(new Error("denied"), { code: "project_forbidden" }); } };
  const route = createResultImpactRoutes({ store, service, maxJsonBytes: 1000 });
  const invoke = async (url, method = "GET", body = null) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); Object.assign(req, { url, method, headers: {} });
    let output;
    const res = { writeHead(status) { assert.equal(status, 200); }, end(value) { output = JSON.parse(value); } };
    await route(req, res); return output;
  };
  await invoke("/api/projects/p/result-impacts?versionId=rv_1");
  assert.deepEqual(seen.slice(0, 3), [["session"], ["csrf"], ["project", "p"]]);
  assert.equal(seen[3][2].versionId, "rv_1");
  await invoke("/api/projects/p/result-impacts/impact/continue", "POST", { agendaId: "agenda", expectedRevision: 1 });
  assert.deepEqual(seen.at(-1), ["continue", "alice", "p", "impact", { agendaId: "agenda", expectedRevision: 1 }]);
  await assert.rejects(invoke("/api/projects/foreign/result-impacts"), { code: "project_forbidden" });
  await assert.rejects(invoke("/api/projects/p/result-impacts/impact/continue", "POST", { agendaId: "agenda", sourceUpdate: { state: "changed" } }), { code: "result_impact_payload_invalid" });
  assert.equal(seen.filter(item => item[0] === "continue").length, 1);
});
