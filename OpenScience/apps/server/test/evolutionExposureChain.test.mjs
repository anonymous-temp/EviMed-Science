import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateExposureAudit, priorDevelopmentRuns, worstExposureTier } from '../src/evolutionExposureChain.mjs';

test('a candidate is as exposed as the most exposed run its code passed through', async () => {
  assert.equal(worstExposureTier([]), 'unknown', 'no audited run is not evidence of absence');
  assert.equal(worstExposureTier(['unexposed', 'unexposed']), 'unexposed');
  assert.equal(worstExposureTier(['unexposed', 'unknown']), 'unknown');
  assert.equal(worstExposureTier(['unknown', 'exposed_uncited', 'unexposed']), 'exposed_uncited', 'observed exposure outranks an unknown trace');
  assert.equal(worstExposureTier(['exposed_uncited', 'cited']), 'cited');
  assert.equal(worstExposureTier(['unexposed', 'something-new']), 'unknown');
  // The reviewer's scenario: the transcript of attempt 3 named the target; attempt 4 carried its code forward.
  const tiers = { 'run-1': 'unexposed', 'run-2': 'unexposed', 'run-3': 'exposed_uncited', 'run-4': 'unexposed' }, audited = [];
  const audit = createCandidateExposureAudit({ auditRun: async ({ runId, projectId }, { policy }) => { audited.push([runId, projectId, policy.aliases[0]]); return { tier: tiers[runId] }; } });
  const lineage = { developmentRuns: ['run-1', 'run-2', 'run-3', 'run-4'], developmentRunProjects: { 'run-1': 'p1', 'run-2': 'p2', 'run-3': 'p3', 'run-4': 'p4' }, developmentProjectId: 'p4' };
  const result = await audit({ lineage }, { policy: { aliases: ['10.1/x'] } });
  assert.equal(result.tier, 'exposed_uncited');
  assert.deepEqual(audited, [['run-1', 'p1', '10.1/x'], ['run-2', 'p2', '10.1/x'], ['run-3', 'p3', '10.1/x'], ['run-4', 'p4', '10.1/x']]);
  // Auditing the last run only, as before, would have called this candidate unexposed.
  assert.equal((await audit({ lineage: { developmentRuns: ['run-4'], developmentProjectId: 'p4' } }, { policy: { aliases: ['10.1/x'] } })).tier, 'unexposed');
  assert.equal((await audit({ lineage: {} }, { policy: { aliases: [] } })).tier, 'unknown');
});

test('the chain is every earlier attempt of the same branch that left a run, whatever its status', async () => {
  const runs = { 'project-0': { id: 'run-a', dispatchId: 'dispatch-0', status: 'succeeded' }, 'project-2': { id: 'run-c', dispatchId: 'dispatch-2', status: 'failed' } }, asked = [];
  const chain = await priorDevelopmentRuns({ attempt: 3, identity: attempt => ({ projectId: `project-${attempt}`, dispatchId: `dispatch-${attempt}` }),
    find: async expected => { asked.push(expected.projectId); const run = runs[expected.projectId]; return run?.dispatchId === expected.dispatchId ? run : null; } });
  assert.deepEqual(asked, ['project-0', 'project-1', 'project-2']);
  assert.deepEqual(chain, [{ runId: 'run-a', projectId: 'project-0', attempt: 0 }, { runId: 'run-c', projectId: 'project-2', attempt: 2 }]);
  assert.deepEqual(await priorDevelopmentRuns({ attempt: 0, identity: () => { throw new Error('a first attempt has no earlier run'); }, find: async () => null }), []);
});
