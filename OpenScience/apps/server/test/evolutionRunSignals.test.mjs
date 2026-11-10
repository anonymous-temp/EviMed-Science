import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionRunSignals, evolutionRunGap } from '../src/evolutionRunSignals.mjs';

test('only a run that could not use a tool or engine is a lead for the module; a spent budget, a stop or an outage is not', async () => {
  assert.equal(evolutionRunGap({ errorCode: 'runtime_tool_error' }), 'method-implementation');
  for (const errorCode of ['usage_budget_exceeded', 'runtime_spend_limit_reached', 'runtime_stopped', 'runtime_session_error', 'autopilot_daily_budget_spent', 'canceled', undefined, null])
    assert.equal(evolutionRunGap({ errorCode }), null, String(errorCode));
});

test('a tool that failed inside a run that finished is the same gap, read from the notice the run carries today (review D-E20)', async () => {
  // `runtime_tool_error` is no longer written (2026-10-04): a tool failure a run did not get past is now a `run_tool_failed` notice on a run that
  // finished, so the gap read from the error code alone never fired again.
  const notice = code => ({ code, text: 'Research tool adr_case_query failed 2 time(s) and no later call of it succeeded.' });
  assert.equal(evolutionRunGap({ status: 'succeeded', errorCode: null, qualityNotices: [notice('run_side_notice'), notice('run_tool_failed')] }), 'method-implementation');
  for (const code of ['run_tool_unavailable', 'review_unavailable', 'capsule_unavailable', 'run_side_notice'])
    assert.equal(evolutionRunGap({ status: 'succeeded', qualityNotices: [notice(code)] }), null, `${code} is not a tool that failed (an unmounted tool is a missing tool of its own)`);
  assert.equal(evolutionRunGap({ status: 'succeeded', qualityNotices: [] }), null);
  assert.equal(evolutionRunGap({ status: 'succeeded' }), null);
  assert.equal(evolutionRunGap({ status: 'failed', errorCode: 'runtime_stopped', qualityNotices: [notice('run_side_notice')] }), null);
});

const record = async (run, project = { id: 'research', userId: 'alice' }) => {
  const seen = [];
  await createEvolutionRunSignals({ signals: { record: async input => { seen.push(input); return input; } } }).record(project, run);
  return seen;
};

test('a finished run leaves closed-code signals: classifier failure, override of the suggested capability, connector need, tool gap', async () => {
  const seen = await record({ id: 'r1', effectiveAgentId: 'meta-analysis', suggestedAgentId: 'open-domain-answer', effectiveRouteReason: 'choice:picker', connectorNeeds: [{ id: 'x' }],
    qualityNotices: [{ code: 'run_tool_unavailable' }] });
  assert.deepEqual(seen.map(input => [input.kind, input.moduleId, input.eventId]), [['unmet-demand', 'tools', 'connector:r1'], ['route-override', 'runtime', 'r1'], ['unmet-demand', 'tools', 'r1']]);
  assert.equal(seen[1].fromCapability, 'open-domain-answer');
  assert.deepEqual((await record({ id: 'r2', effectiveRouteReason: 'x:classifier:timeout' })).map(input => [input.kind, input.capability]), [['classifier-failure', 'open-domain-answer']]);
  assert.deepEqual(await record({ id: 'r3' }), [], 'an ordinary run leaves nothing');
});

test('a platform project teaches nothing', async () => {
  assert.deepEqual(await record({ id: 'r4', connectorNeeds: [{ id: 'x' }] }, { id: 'evimed-evolution', userId: 'alice' }), []);
});
