import assert from "node:assert/strict";
import test from "node:test";
import { tickProbe } from "../src/geoProbeQueue.mjs";

/** Exercise a leased probe through snapshot persistence, without a provider. @param {any} project */
async function probe(project) {
  const calls = [], snapshots = [], finished = [], projectReads = [];
  const job = { id: "probe-job", userId: "researcher", geoProjectId: "geo-study", roundId: "round", questionId: "question", engine: "deepseek", attempts: 1 };
  const store = {
    ready: async () => {},
    withProbeLock: async (work) => ({ acquired: true, value: await work() }),
    recoverExpiredLeases: async () => {}, recentProbeStatuses: async () => [],
    leaseNextJob: async () => job, startRound: async () => {},
    questions: async () => [{ text: "A public measurement question" }],
    project: async (id) => { projectReads.push(id); if (project instanceof Error) throw project; return project; },
    insertSnapshot: async (value) => { snapshots.push(value); },
    finishJob: async (id, value) => { finished.push({ id, ...value }); },
    openRoundProgress: async () => [],
  };
  const counts = await tickProbe({
    store: /** @type {any} */ (store),
    config: { geoProbeUrl: "https://probe.example.com", operatorUsers: ["wrong-operator"] },
    now: () => new Date("2026-10-07T12:00:00Z"),
    upstream: /** @type {any} */ ({ ask: async () => ({
      results: [{ status: "ok", answer: "抱歉，我无法提供医疗建议，请咨询专业医生。", answerDigest: null }],
      raw: [{ status: "ok" }], integrity: { transport: "tls", signed: true, responseDigest: "test" },
    }) }),
    judgeService: { judge: async (site, input, context) => {
      calls.push({ site, input, context });
      return { outcome: "settled", value: { status: "normal" } };
    } },
  });
  return { calls, snapshots, finished, projectReads, counts };
}

test("J21 bills the current GEO owner's ordinary project, never the operator or GEO id", async () => {
  const result = await probe({ userId: "researcher", projectId: "ordinary-project" });
  assert.deepEqual(result.projectReads, ["geo-study"]);
  assert.deepEqual(result.calls[0].context, { userId: "researcher", projectId: "ordinary-project", taskId: "probe-job", module: "geo" });
  assert.equal(result.calls[0].site, "J21");
  assert.equal(result.snapshots[0].status, "valid");
  assert.equal(result.finished[0].status, "done");
});

for (const [name, project] of [
  ["deleted project", null], ["different owner", { userId: "other", projectId: "ordinary-project" }],
  ["missing ordinary project", { userId: "researcher" }], ["project read failure", new Error("database unavailable")],
]) {
  test(`J21 keeps original sanity without a semantic call for ${name}`, async () => {
    const result = await probe(project);
    assert.equal(result.calls.length, 0);
    assert.equal(result.snapshots[0].status, "refusal");
    assert.equal(result.finished[0].status, "done");
    assert.equal(result.counts.refusal, 1);
  });
}
