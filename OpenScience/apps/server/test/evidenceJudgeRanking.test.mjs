import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankEvidenceCards } from '../src/evidenceJudgeRanking.mjs';

test('J13 reorders only visible first fifteen cards and retains every object and trailing card', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: 'card', secret: 'source bytes' }));
  const service = { judge: async (site, input, context) => {
    assert.equal(site, 'J13'); assert.equal(input.cards.length, 15);
    assert.equal(JSON.stringify(input).includes('source bytes'), false);
    assert.deepEqual(context, { userId: 'reader', projectId: 'project' });
    return { outcome: 'settled', value: { rankedIds: input.cards.map(c => c.id).reverse() } };
  } };
  const ranked = await rankEvidenceCards(rows, 'question', service, { userId: 'reader', projectId: 'project' });
  assert.deepEqual(ranked.slice(15), rows.slice(15));
  assert.deepEqual(new Set(ranked), new Set(rows));
  assert.equal(ranked[0], rows[14]);
});

test('J13 refuses partial, duplicate, invented and uncertain rankings without dropping cards', async () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  for (const decision of [
    { outcome: 'settled', value: { rankedIds: ['a'] } },
    { outcome: 'settled', value: { rankedIds: ['a', 'a'] } },
    { outcome: 'settled', value: { rankedIds: ['a', 'private-card'] } },
    { outcome: 'escalated', value: { rankedIds: ['b', 'a'] } },
  ]) assert.equal(await rankEvidenceCards(rows, 'q', { judge: async () => decision }, { projectId: "p" }), rows);
  assert.equal(await rankEvidenceCards(rows, 'q', { judge: async () => { throw Error('down'); } }, { projectId: "p" }), rows);
});

test('J14 production service asks both orders and disagreement cannot merge a vote', async () => {
  const { createJudgeService } = await import('../src/judgeService.mjs');
  const states = [];
  const service = createJudgeService({ calibrationMode: true, config: {
    reviewJevEnabled: true, typesafeApiKey: 'test-not-secret', reviewJevModel: 'jev-1.13.0',
  }, callImpl: async (_deps, call) => {
    states.push(call.state);
    const selected = states.length === 1 ? 'same' : 'related';
    return { model: 'jev-1.13.0', cost: 0, answers: { relation: {
      type: 'choice', choice: selected, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(call.questions.relation.criteria).map(key => [key, key === selected ? 1 : 0])),
    } } };
  } });
  try {
    assert.equal((await service.judge('J14', { left: 'Topic A', right: 'Topic B' })).outcome, 'escalated');
    assert.deepEqual(states, [{ left: 'Topic A', right: 'Topic B' }, { left: 'Topic B', right: 'Topic A' }]);
  } finally { await service.close(); }
});

test('J13 without an actual project preserves ranking without attempting paid work', async () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  let calls = 0;
  assert.equal(await rankEvidenceCards(rows, 'query', { judge: async () => { calls++; throw Error('must not call'); } }, { userId: 'reader' }), rows);
  assert.equal(calls, 0);
});

test('trusted workflow deadline shortens provider work and an expired deadline never dispatches', async () => {
  const { createJudgeService } = await import('../src/judgeService.mjs');
  let calls = 0;
  const service = createJudgeService({ calibrationMode: true, config: { typesafeApiKey: 'test-only-key', reviewJevModel: 'jev-1.13.0', reviewJevTimeoutMs: 10000 },
    callImpl: async (_deps, call) => {
      calls++; assert.ok(call.timeoutMs <= 30);
      return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
    } });
  try {
    assert.equal((await service.judge('J14', { left: 'A', right: 'B' }, { deadlineMs: Date.now() - 1 })).code, 'judge_timeout');
    assert.equal(calls, 0);
    assert.equal((await service.judge('J14', { left: 'A', right: 'B' }, { deadlineMs: Date.now() + 30 })).code, 'judge_timeout');
    assert.equal(calls, 1);
  } finally { await service.close(); }
});
