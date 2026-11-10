import assert from 'node:assert/strict';
import test from 'node:test';
import { lineRefusal } from '../src/nativeMemoryWorker.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { removalLines, removalRefusals } from '../src/nativeMemoryRejections.mjs';

const removal = { fingerprint: lineFingerprint('Project M-41633.'), text: 'Project M-41633.', rejectedAt: '2026-11-10T10:00:00.000Z' };
const overlay = { removals: async () => [removal] };
const source = (text, at = '2026-11-10T11:00:00.000Z', role = 'user') => ({ text, created_at: at, role });

test('hard tokens are uncapped code; old, undated and assistant messages cannot authorize a rewrite', async () => {
  const candidates = Array.from({ length: 24 }, (_, n) => ({ text: `Project M-41633: detail ${n}`, sources: [
    source('M-41633', '2026-11-10T09:00:00.000Z'), source('M-41633', null), source('M-41633', undefined, 'assistant'),
  ] }));
  const refused = await removalRefusals({ userId: 'u', overlay, candidates, judge: { same: () => { throw new Error('must not spend the judge budget'); } } });
  assert.equal(refused.size, 24);
  assert.equal((await removalRefusals({ userId: 'u', overlay, candidates: [{ text: 'M-41633', sources: [source('My project M-41633.')] }] })).size, 0);
  assert.equal((await removalRefusals({ userId: 'u', overlay, candidates: [{ text: 'M-41633', sources: [source('A different project M-41634.')] }] })).size, 1);
  assert.equal((await removalRefusals({ userId: 'u', overlay, candidates: [{ text: 'M-416330' }] })).size, 0, 'whole identifiers only');
});

test('every hard token is required, using shared number/unit and quotation normalization', async () => {
  const text = 'The “North Star” project uses 12 mg.';
  const guard = { removals: async () => [{ ...removal, text }] };
  const candidates = [{ text: 'North Star, 12 mg' }, { text: 'North Star, 112 mg' }, { text: 'Other, 12 mg' }];
  const refused = await removalRefusals({ userId: 'u', overlay: guard, candidates });
  assert.deepEqual([...refused.keys()], [lineFingerprint(candidates[0].text)]);
});

test('headings are changed lines, and a judge cannot authorize a no-token rewrite with an old message', async () => {
  assert.deepEqual(removalLines('# New title\n- New value\n## Old section', '# Old title\n## Old section'), ['New title', 'New value']);
  const guard = { removals: async () => [{ ...removal, text: 'Prefers tables for comparisons.' }] };
  const requests = [];
  const judge = { same: async request => { requests.push(request); return { same: new Map([[0, removal.fingerprint]]), stated: new Set([0]) }; } };
  const text = 'Likes comparisons presented as tables.';
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge, candidates: [{ text, sources: [source(text, '2026-11-10T09:00:00.000Z')] }] })).size, 1);
  assert.deepEqual(requests[0].said, []);
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge, candidates: [{ text, sources: [source(text)] }] })).size, 0);
});

test('a message timestamp grounds its provenance date when relearning, without lending any other token', async () => {
  const guard = { removals: async () => [{ ...removal, text: 'Project M-41633 (user told us on 2026-11-10).' }] };
  const text = 'Project M-41633 (2026-11-10, user stated).';
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, candidates: [{ text, sources: [source('My project is M-41633.')] }] })).size, 0);
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, candidates: [{ text, sources: [source('My project is M-41633.', '2026-11-10T09:00:00.000Z')] }] })).size, 1);
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, candidates: [{ text, sources: [source('My project is M-41634.')] }] })).size, 1);
});


test('removal refusals preserve the existing never-kept precedence for secret-shaped body lines', () => {
  const text = 'ID 110101199001011237';
  assert.equal(lineRefusal(text, new Map([[lineFingerprint(text), 'rejected_reworded']])), 'identifier_shape');
});
