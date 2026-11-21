import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { addedLines, score } from './write-pair.mjs';

test('paired review requires both complete extractions and evidence for all four recovered targets', () => {
  const targets = ['history','miss','miss','miss','miss'].map((kind, i) => ({ id: String(i), kind, user: 'x' }));
  assert.deepEqual(addedLines({ a: '- First' }, { a: '- First\n- Second' }), [{ file: 'a', line: 'Second' }]);
  const record = { rows: [{ id: 'a', arm: 'old' }, { id: 'b', arm: 'next' }], targets, final: { old: { x: { a: 'First' } }, next: { x: { a: targets.map(t => '- Value ' + t.id).join('\n') } } } };
  const review = { digest: createHash('sha256').update(JSON.stringify(record)).digest('hex'), labels: { a: 'assistant_as_user', b: 'user' },
    targets: { old: Object.fromEntries(targets.map(t => [t.id, false])), next: Object.fromEntries(targets.map(t => [t.id, { file: 'a', line: 'Value ' + t.id }])) } };
  assert.equal(score(record, review).pass, true);
  review.labels.b = 'material';
  assert.equal(score(record, review).pass, false);
  delete review.labels.b;
  assert.throws(() => score(record, review), /incomplete/);
});
