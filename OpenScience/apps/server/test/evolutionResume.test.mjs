import test from "node:test";
import assert from "node:assert/strict";
import { createEvolutionRuns } from "../src/evolutionRuns.mjs";
import { evolutionKey } from "../src/evolutionService.mjs";

test("recovery admission requires the exact durable job, owner and real dispatch ledger", async () => {
  const row = { payload: { jobId: "job", userId: "operator", projectId: "eval-paper-build-one", dispatchId: "dispatch" } };
  let recorded = [];
  const reads = [];
  const runs = createEvolutionRuns({ service: { get: async id => { reads.push(id); return row; } },
    store: { userById: async id => ({ id }), requireProject: async (user, id) => ({ userId: user.id, id }) },
    agentRuns: { list: async project => { assert.equal(project.userId, "operator"); assert.equal(project.id, "eval-paper-build-one"); return recorded; } } });
  assert.equal(await runs.canResume({ id: "job", userId: "operator" }), false);
  recorded = [{ dispatchId: "dispatch", status: "running" }];
  assert.equal(await runs.canResume({ id: "job", userId: "operator" }), true);
  assert.equal(await runs.canResume({ id: "different-job", userId: "operator" }), false);
  assert.equal(await runs.canResume({ id: "job", userId: "other-owner" }), false);
  recorded = [{ dispatchId: "different-dispatch", status: "running" }];
  assert.equal(await runs.canResume({ id: "job", userId: "operator" }), false);
  assert.equal(reads[0], `evolution-runtime-work-${evolutionKey("job")}`);
});

test('completed protected dispatch binds exact existing run before return without new execution', async () => {
  const calls = [], existing = { id: 'sealed-run', dispatchId: 'dispatch', status: 'succeeded' };
  const runs = createEvolutionRuns({ config: { evolutionEnabled: true, operatorUsers: ['operator'] }, store: { userById: async id => ({ id }), projectFor: async (user, id) => ({ userId: user.id, id }) }, agentRuns: { list: async () => [existing] }, evaluationIsolation: { registerPending: async (...args) => calls.push(['pending', ...args]), bindRun: async (...args) => calls.push(['binding', ...args]) } });
  assert.equal(await runs.dispatch({ userId: 'operator', projectId: 'eval-paper-probe', dispatchId: 'dispatch', evaluationPolicy: { aliases: ['target'] } }), existing);
  assert.deepEqual(calls[1], ['binding', { userId: 'operator', projectId: 'eval-paper-probe' }, 'sealed-run']);
});
