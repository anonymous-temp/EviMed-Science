import assert from 'node:assert/strict';
import test from 'node:test';
import { startSubagent } from '../index.mjs';

test('native activation carries explicit model options instead of silently inheriting the parent model', async () => {
  /** @type {any} */
  let captured;
  const parent = { id: 'parent', options: { provider: 'deepseek', model: 'deepseek-v4-pro' } };
  const options = { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 8000 };
  const ctx = { subagents: { async startActivation(/** @type {any} */ input) {
    captured = input;
    return { childId: input.childId, messageId: 'm1', result: Promise.resolve({ stopReason: 'completed', structured: {} }), async dispose() {} };
  } } };
  const run = await startSubagent(ctx, { capability: 'patient-matching', label: 'Matching', prompt: 'Read the supplied case.', tools: [], persona: '', outputSchema: { type: 'object', properties: {} }, maxDepth: 1, agentOptions: options }, parent, new AbortController().signal);
  assert.deepEqual(captured.request.agentOptions, options);
  assert.equal(captured.request.parent, parent);
  assert.notEqual(captured.request.agentOptions, options);
  await run.result;
  await run.dispose();
});
