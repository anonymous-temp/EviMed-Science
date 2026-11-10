// Live D8, phase 3 (2026-11-07, conversation a): to the follow-up 「能不能确认一类错误不超过 2.5%？」 the reply said 「能确认这类错误不超过 2.5%」 for a
// design grid's null check of 2.32% and 2.44% ± 0.11% (upper bounds 2.53% and 2.65%). The turn read those numbers through `vcr_read results`
// three times; that answer carried no verdict (F5b's verdict rode only `vcr_simulate status`, and only a result's own type I error, never a
// grid cell's). Every answer that carries a simulated type I error now carries its verdict.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createVcrGatewayHandler } from "../src/vcrGateway.mjs";
import { VcrService } from "../src/vcrService.mjs";

/** The null check of the live conversation: 250 and 306 per arm under HR 1, 20,000 replicates each. */
const nullCheck = { id: "res_null", version: 1, kind: "design_grid", subjectId: "grd_3", executionId: "exe_null", conclusion: "estimable", reviewState: "ai_set",
  counts: {}, tables: [], createdAt: "2026-11-07T21:07:00.000Z", supersededBy: null,
  measures: [{ name: "cells", value: 2, source: "calculated" }],
  diagnostics: { cellsPlanned: 2, cellsRun: 2, cells: [
    { designIndex: 1, truthIndex: 1, status: "succeeded", measures: [{ name: "type_one_error", value: 0.0232, mcse: 0.00107 }] },
    { designIndex: 2, truthIndex: 1, status: "succeeded", measures: [{ name: "type_one_error", value: 0.02435, mcse: 0.0011 }] }] } };
const nullDesign = { ...nullCheck, id: "res_design", kind: "trial_scenario", executionId: "exe_design", diagnostics: {},
  measures: [{ name: "type_one_error", value: 0.0228, mcse: 0.0011, simulated: true }] };
const powered = { ...nullCheck, id: "res_power", kind: "trial_scenario", executionId: "exe_power", diagnostics: {},
  measures: [{ name: "power", value: 0.836, mcse: 0.005, simulated: true }] };
/** What each result's job stated: the grid and the design at one-sided 2.5%. */
const scenarios = { res_null: { analysis: { alpha: 0.025, sided: 1 }, designs: [{ nTreat: 250, nControl: 250 }, { nTreat: 306, nControl: 306 }], truths: [{ hazardRatio: 1 }] },
  res_design: { analysis: { alpha: 0.025, sided: 1 } }, res_power: { analysis: { alpha: 0.025, sided: 1 } } };

const study = { id: "std_1", userId: "u1", projectId: "prj_1", name: "n", scope: "conversation", conversationSessionId: "root", status: "active", steps: {}, budget: {} };
const runtimeManager = { boundedRuntimeScope: () => ({ runId: "dispatch" }), assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "prj_1" }) };
const config = { vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:8788/internal/models/v1" };

/** A gateway over the real service; the store holds the three results and the scenarios of their jobs. */
function gateway({ jobs = {}, results = [nullCheck, nullDesign, powered] } = {}) {
  /** @type {any[]} */
  const asked = [];
  const store = {
    async studyByRuntimeDispatch() { return study; },
    async studyByControlProject() { return study; },
    async results() { return results; },
    async allResults() { return results; },
    async resultForExecution(_study, executionId) { return (results).find((row) => row?.executionId === executionId) ?? null; },
    async staleMarks() { return []; },
    async one() { return { id: "exe_null" }; },
    async rows(/** @type {string} */ sql, /** @type {any[]} */ values) {
      asked.push(sql);
      return /JOIN .*jobs j ON j\.id = e\.job_id/s.test(sql) ? values[1].filter((/** @type {string} */ id) => id in scenarios).map((/** @type {string} */ id) => ({ id, scenario: /** @type {any} */ (scenarios)[id] })) : [];
    },
  };
  const service = new VcrService({ store: /** @type {any} */ (store), config: { vcrEnabled: true, vcrAudience: "all" } });
  const handler = createVcrGatewayHandler(config, runtimeManager, { vcr: { service, store, jobs, orchestrator: null } });
  const call = async (/** @type {string} */ operation, /** @type {Record<string, any>} */ body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: `/internal/vcr/v1/${operation}`, headers: { authorization: "Bearer token" } });
    const res = { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; }, end(/** @type {string} */ chunk = "") { this.body = String(chunk); } };
    await handler(req, res);
    assert.equal(res.status, 200, res.body);
    return JSON.parse(res.body).data;
  };
  return { call, asked };
}

test("the follow-up's vcr_read results: each grid cell's type I error and a design's own carry the verdict the page says", async () => {
  const { call } = gateway();
  const data = await call("read", { what: "results" });
  const byId = Object.fromEntries(data.results.map((/** @type {any} */ result) => [result.id, result]));
  assert.deepEqual(byId.res_null.diagnostics.cells.map((/** @type {any} */ cell) => cell.typeOneError), [
    { verdict: "inconclusive", text: "I 类错误无法确定是否不超过 2.5%（模拟 2.32% ± 0.11%）" },
    { verdict: "inconclusive", text: "I 类错误无法确定是否不超过 2.5%（模拟 2.44% ± 0.11%）" },
  ], "neither can be confirmed: the upper bounds are 2.53% and 2.65%");
  assert.deepEqual(byId.res_design.typeOneError, { verdict: "pass", text: "I 类错误不超过 2.5%（模拟 2.28% ± 0.11%）" });
  assert.equal("typeOneError" in byId.res_power, false, "a power carries no verdict");
  assert.equal(byId.res_null.diagnostics.cells[0].measures[0].value, 0.0232, "the numbers are as they were");
});

test("a result whose level cannot be read keeps its number and gets no verdict; a grid job's status carries its cells' verdicts", async () => {
  const unknown = { ...nullDesign, id: "res_unknown", executionId: "exe_unknown" };
  const { call } = gateway({ results: [unknown] });
  assert.equal("typeOneError" in (await call("read", { what: "results" })).results[0], false);
  const done = { id: "job_null", state: "succeeded", kind: "design_grid", method: "design.grid", methodVersion: "1.3.0", progress: {}, cpuSecondsUsed: 100, error: null };
  const status = await gateway({ jobs: { async get() { return done; }, async configuration() { return { scenario: scenarios.res_null, inputRefs: [], scenarioHash: "h" }; } } })
    .call("simulate", { action: "status", jobId: "job_null" });
  assert.deepEqual(status.result.diagnostics.cells.map((/** @type {any} */ cell) => cell.typeOneError?.verdict), ["inconclusive", "inconclusive"]);
});
