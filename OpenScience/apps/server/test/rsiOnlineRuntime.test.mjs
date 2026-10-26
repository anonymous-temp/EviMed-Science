import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRsiAuthorizedTranscriptReader, createRsiOnlineRuntime, rsiIncidentRunEligible } from '../src/rsiOnlineRuntime.mjs';
import { createRsiOnlineWorker } from '../src/rsiOnlineWorker.mjs';
import { rsiOnlineConfigurationIssues } from '../src/rsiOnlineConfiguration.mjs';
import { PRODUCT_JOB_KINDS } from '../src/productPersistence.mjs';

const source = { userId: 'researcher', projectId: 'research', sourceRunId: 'run-1', sourceRevision: 'a'.repeat(64), authorizationId: 'agreement-1' };
function fixture(options = {}) {
  const project = { userId: source.userId, id: source.projectId };
  const run = { id: source.sourceRunId, sessionId: 'session-1', transcript: { sha256: source.sourceRevision } };
  const calls = [];
  const reader = createRsiAuthorizedTranscriptReader({
    store: { userById: async id => options.deleted ? null : { id }, requireProject: async user => { assert.equal(user.id, source.userId); if (options.denied) throw new Error('denied'); return project; } },
    agentRuns: { list: async () => [run] }, agreementId: source.authorizationId,
    authority: { authorizeIncident: async () => options.revoked !== true },
    assertModelAccess: async (caller, body) => { calls.push({ caller, body }); if (options.clinicalDenied) throw new Error('clinical denied'); },
    readTranscript: async () => { if (options.digestFailed) throw new Error('digest'); return { header: { completeness: 'complete' }, messages: [
      { sessionId: 'child', seq: 1, role: 'assistant', parts: [{ type: 'text', text: 'child private' }] },
      { sessionId: 'session-1', seq: 2, role: 'user', source: 'user', parts: [{ type: 'text', text: 'Expected a table.' }] },
      { sessionId: 'session-1', seq: 3, role: 'assistant', parts: [{ type: 'text', text: 'Actual prose.' }] },
      { sessionId: 'session-1', seq: 4, role: 'tool', parts: [{ type: 'text', text: 'tool private' }] },
    ] }; },
  });
  return { reader, calls };
}
test('source rights, canonical digest and live agreement fail closed without archive fallback', async () => {
  for (const option of ['deleted', 'denied', 'revoked', 'digestFailed']) assert.equal(await fixture({ [option]: true }).reader(source), null, option);
  assert.equal(await fixture().reader({ ...source, sourceRevision: 'b'.repeat(64) }), null);
  assert.equal(await fixture().reader({ ...source, authorizationId: 'client-assertion' }), null);
});
test('only verified root prose is offered, with stable identities and source clinical egress scope', async () => {
  const { reader, calls } = fixture();
  const result = await reader(source);
  assert.deepEqual(result.messages.map(row => row.id), ['run-1:2', 'run-1:3']);
  assert.deepEqual(calls[0].caller, { userId: 'researcher', projectId: 'research', runId: 'run-1', sessionId: 'session-1' });
  assert.equal(await fixture({ clinicalDenied: true }).reader(source), null);
});
test('normal and automated conversations do not become incident exports', () => {
  assert.equal(rsiIncidentRunEligible({ status: 'delivered' }), false);
  assert.equal(rsiIncidentRunEligible({ status: 'failed', automated: true }), false);
  assert.equal(rsiIncidentRunEligible({ status: 'failed' }), true);
  assert.equal(rsiIncidentRunEligible({ status: 'delivered', qualityNotices: [{ code: 'run_tool_failed' }] }), true);
});
test('unbound runtime never requires a publisher account or provisions its project', async () => {
  const runtime = await createRsiOnlineRuntime({ config: {}, store: { userById: () => assert.fail('publisher lookup') },
    documents: {}, jobs: {}, database: {}, agentRuns: {}, servingAdapters: null });
  assert.equal(runtime.configured(), false);
  await runtime.worker.close();
});
test('unconfigured online worker never claims, extracts, imports or touches transport', async () => {
  const worker = createRsiOnlineWorker({ configured: () => false, jobs: { claim: () => assert.fail('claimed') }, incidents: { processPending: () => assert.fail('extracted') }, pollBundles: () => assert.fail('imported'), owner: 'publisher' });
  assert.equal(await worker.tick(), null);
  await worker.close();
  assert.ok(rsiOnlineConfigurationIssues(null).length);
});
test('maintenance admission is checked both before and inside the online queue claim', async () => {
  let allowed = false, claimed = 0;
  const worker = createRsiOnlineWorker({ configured: () => true, canRun: async () => allowed, owner: 'publisher',
    jobs: { claim: async (_kinds, _id, options) => { claimed++; assert.equal(await options.admission({}), allowed); return null; } } });
  await worker.tick(); assert.equal(claimed, 0);
  allowed = true; await worker.tick(); assert.equal(claimed, 1);
  await worker.close();
});
test('production server composes only serving evolution and declares dedicated online queues', async () => {
  const code = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /import\s*\{\s*createEvolution\s*\}|evolution\.model\(|evolution\.loops|evolution\.budgeted\(|evolution\.runtimeSession/);
  assert.match(code, /createEvolutionServing\(/);
  assert.ok(PRODUCT_JOB_KINDS.includes('rsi-incident-export'));
  assert.ok(PRODUCT_JOB_KINDS.includes('rsi-bundle-poll'));
});
