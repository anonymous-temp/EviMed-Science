// Live D6, phase 3 (2026-11-07, conversation c): twelve Alzheimer runs were read with vcr_simulate status, and the reply's table of
// 对症−安慰剂 and 疾修−安慰剂 at every visit was subtracted by the model from the means. The answers a conversation reads of a progression
// run now say the difference between its arms at each visit (the card's 治疗减对照), through the real gateway and service.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { createVcrGatewayHandler } from "../src/vcrGateway.mjs";
import { VcrService } from "../src/vcrService.mjs";

const run = { ...JSON.parse(readFileSync(new URL("./fixtures/vcr-progression/alzheimer-beta-logit.json", import.meta.url), "utf8")),
  id: "res_ad", version: 1, kind: "progression_simulation", subjectId: "pg:0123456789", executionId: "exe_ad", reviewState: "ai_set", supersededBy: null, createdAt: "2026-11-07T21:10:39.000Z" };
const study = { id: "std_1", userId: "u1", projectId: "prj_1", name: "n", scope: "conversation", conversationSessionId: "root", status: "active", steps: {}, budget: {} };

function gateway() {
  const store = {
    async studyByRuntimeDispatch() { return study; }, async studyByControlProject() { return study; },
    async results() { return [run]; }, async allResults() { return [run]; }, async resultForExecution(_study, executionId) { return ([run]).find((row) => row?.executionId === executionId) ?? null; }, async staleMarks() { return []; },
    async one() { return { id: "exe_ad" }; }, async rows() { return []; },
  };
  const done = { id: "job_ad", state: "succeeded", kind: "generate_progression", method: "patients.progression", methodVersion: "1.1.0", progress: {}, cpuSecondsUsed: 30, error: null };
  const jobs = { async get() { return done; }, async configuration() { return { scenario: { treatment: {} }, inputRefs: [], scenarioHash: "h" }; } };
  const service = new VcrService({ store: /** @type {any} */ (store), config: { vcrEnabled: true, vcrAudience: "all" } });
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:8788/internal/models/v1" },
    { boundedRuntimeScope: () => ({ runId: "dispatch" }), assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "prj_1" }) }, { vcr: { service, store, jobs, orchestrator: null } });
  return async (/** @type {string} */ operation, /** @type {Record<string, any>} */ body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: `/internal/vcr/v1/${operation}`, headers: { authorization: "Bearer token" } });
    const res = { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; }, end(/** @type {string} */ chunk = "") { this.body = String(chunk); } };
    await handler(req, res);
    assert.equal(res.status, 200, res.body);
    return JSON.parse(res.body).data;
  };
}

test("a progression run's status and its read both say the difference between its arms at each visit", async () => {
  const call = gateway();
  const curvesOf = (/** @type {any} */ result) => result.diagnostics.progression.curves;
  for (const curves of [curvesOf((await call("simulate", { action: "status", jobId: "job_ad" })).result), curvesOf((await call("read", { what: "results" })).results[0])]) {
    assert.equal(curves.length, run.diagnostics.progression.curves.length);
    for (const curve of curves) {
      assert.equal(curve.difference.value, curve.treated.mean.value - curve.control.mean.value);
      assert.equal(curve.difference.source, "calculated");
    }
    assert.ok(curves.at(-1).difference.value < 0, "a drug that helps lowers the ADAS-cog score");
  }
});
