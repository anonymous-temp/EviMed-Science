import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createEvolutionRoutes } from "../src/evolutionRoutes.mjs";

const map = {
  schema: 1, derivedAt: "2026-10-05T00:00:00.000Z", counts: { supported: 1, partial: 0, unsupported: 0, untested: 1 }, graph: [{ id: "internal" }],
  cells: [
    { id: "c1", capabilityId: "meta-analysis", version: "1.0.0", taskFamily: { operation: "meta-analysis" }, status: "supported", dependencies: [], demand: { occurrences: 2, distinctAccounts: 1 }, newThisMonth: true, adjacent: [{ secret: "internal" }] },
    { id: "c2", capabilityId: "adr-analysis", version: "1.0.0", taskFamily: { operation: "adr-analysis" }, status: "untested", dependencies: [], demand: { occurrences: 0, distinctAccounts: 0 } },
  ],
};

function harness({ operator = false, enabled = true, persisted = map } = {}) {
  const calls = { read: 0, save: 0, rebuild: 0 };
  const service = { save: async () => { calls.save += 1; }, get: async () => ({ payload: persisted }) };
  const route = createEvolutionRoutes({
    config: { evolutionEnabled: enabled }, store: { ensureSessionUser: async () => ({ user: { id: "someone" } }), assertCsrf: async () => {} },
    isOperator: async () => operator, service,
    capabilityMap: async () => { calls.read += 1; return persisted; },
  });
  const get = async () => {
    const req = Object.assign(Readable.from([]), { method: "GET", url: "/api/evolution/capability-map", headers: {} });
    let status = 0, body = null;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(text) { body = JSON.parse(String(text)); } };
    try { await route(req, res); } catch (error) { return { error }; }
    return { status, body };
  };
  return { get, calls };
}

test("the capability map is not a researcher's page: an account that is not an operator is refused by name", async () => {
  const h = harness({ operator: false });
  const result = await h.get();
  assert.equal(result.error?.status, 403);
  assert.equal(result.error?.code, "evolution_operator_required");
  assert.equal(h.calls.read, 0, "nothing was read for them");
});

test("an operator reads the saved weekly map: only the cell fields the panel uses, and nothing is rebuilt or written", async () => {
  const h = harness({ operator: true });
  const result = await h.get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.cells.map((cell) => cell.id), ["c1", "c2"]);
  assert.equal(result.body.data.cells[0].newThisMonth, true);
  assert.equal(result.body.data.cells[1].newThisMonth, false);
  assert.equal(result.body.data.derivedAt, map.derivedAt);
  assert.equal(JSON.stringify(result.body).includes("internal"), false, "the graph and adjacency stay inside");
  assert.deepEqual(h.calls, { read: 1, save: 0, rebuild: 0 });
});

test("before the first weekly run there is no map, which is an answer and not an error", async () => {
  const h = harness({ operator: true, persisted: null });
  assert.deepEqual((await h.get()).body, { data: null });
});

test("with evolution off even an operator is told it is off", async () => {
  const h = harness({ operator: true, enabled: false });
  assert.equal((await h.get()).error?.code, "evolution_disabled");
});
