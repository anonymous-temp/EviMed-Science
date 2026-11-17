import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, answerState, snapshotFor } from '../run/score.mjs';
import { checkStore } from '../run/scoreChecks.mjs';
import { answerTrace, buildJudgePacket, mergeJudgeResults, rowKey } from '../run/judgePackets.mjs';

const base = { runId: 'r', set: 'synthetic-users', split: 'dev', caseId: 'A', kind: 'store', id: 'store:x', expectedStored: true };
test('unintroduced stores are a separate outcome, outside recall, with members', () => {
  const s = summarize([{ ...base, verdict: 'not_ingested_yet', stored: false },
    { ...base, caseId: 'B', verdict: 'pass', stored: true },
    { ...base, caseId: 'C', verdict: 'fail', stored: false }]);
  assert.equal(s.storeRecall.n, 2); assert.equal(s.storeRecall.pass, 1);
  assert.equal(s.storeRecall.notIngestedYet.count, 1);
  assert.equal(s.storeRecall.notIngestedYet.members[0].caseId, 'A');
  assert.equal(s.sets['synthetic-users'].store.n, 2);
});
test('literal absence is not a confirmed failed retention and missing snapshots are unobserved', () => {
  const item = { plantId: 'x', current: 'comparison table', expectStored: true };
  const outcome = checkStore(item, { files: { 'a.md': 'Use rows and columns to compare choices.' } });
  assert.equal(outcome.verdict, 'needs-judge'); assert.equal(outcome.stored, undefined);
  assert.equal(checkStore(item, null).verdict, 'unobserved');
  const row = { ...base, ...outcome }, packet = buildJudgePacket(row, { snapshot: { files: {} }, gold: item });
  const result = { id: packet.id, hash: packet.hash, model: 'qwen3.8-max', verdict: 'incorrect', reason: 'Captured memory is empty.', failureStep: 'not_stored' };
  const merged = mergeJudgeResults([row], [packet], [result])[0];
  assert.equal(merged.verdict, 'fail'); assert.equal(merged.stored, false);
});
test('failed collection names the absent record, a completed empty reply remains an answer failure', () => {
  const failed = { verdict: 'fail', checks: [], rubric: [] };
  assert.equal(answerState(null, failed).verdict, 'unobserved');
  assert.deepEqual(answerState({ error: 'collection_timeout', answer: '' }, failed).missingRecords, ['answer-text']);
  assert.equal(answerState({ answer: '' }, failed).verdict, 'fail');
  const traced = answerTrace({ toolCalls: [{ name: 'search', args: { query: 'x' } }] }, null, ['x']);
  assert.equal(traced.retrieved, null); assert.equal(traced.stored, null);
  assert.ok(traced.missingRecords.includes('tool-result:0'));
});
test('checkpoint is part of row identity; snapshot selection never picks a future snapshot', () => {
  assert.notEqual(rowKey({ ...base, checkpoint: 1 }), rowKey({ ...base, checkpoint: 2 }));
  const snapshots = [{ afterSession: 1 }, { afterSession: 3 }];
  assert.equal(snapshotFor({ snapshots, snapshot: snapshots[1] }, { checkpoint: 2 }), null);
});
test('redline aggregates carry the members counted, including place counters', () => {
  const rows = [{ ...base, kind: 'redline', set: 'g6', category: 'password', redLine: 'secret-retained', verdict: 'fail', places: ['memory-file'] }];
  const s = summarize(rows);
  assert.equal(s.redLines.members[0].caseId, 'A');
  assert.equal(s.redLines.byType.password.members.length, s.redLines.count);
  assert.equal(s.sets.g6.redlineMembers['secret-retained'][0].id, 'store:x');
  assert.equal(s.redLines.byType.password.byPlaceMembers['memory-file'].length, 1);
});

test('self scope includes the profile and named-person scope never borrows another person facts', async () => {
  const { scopeMemory } = await import('../run/score.mjs');
  const snapshot = { files: { 'profile.md': 'Maintains dialysis three days weekly.\nAlice takes aspirin.',
    'preferences/self/format.md': 'Use tables.', 'people/Bob.md': 'Dose 8 mg nightly.' } };
  const self = scopeMemory(snapshot, { subject: 'self' });
  assert.equal(checkStore({ plantId: 'x', subject: 'self', current: 'dialysis', expectStored: true }, self).stored, true);
  assert.ok(self.scope.files.includes('profile.md'));
  const alice = scopeMemory(snapshot, { subject: 'Alice' });
  assert.ok(alice.files['profile.md'].includes('Alice takes aspirin'));
  assert.equal(alice.files['people/Bob.md'], undefined);
  assert.equal(checkStore({ plantId: 'x', subject: 'Alice', current: '8 mg', expectStored: true }, alice).stored, undefined);
  assert.equal(alice.scope.fallback, false);
  const wrongPerson = { ...base, ...checkStore({ plantId: 'x', subject: 'Alice', current: '8 mg', expectStored: true }, alice) };
  const p = buildJudgePacket(wrongPerson, { snapshot: alice, gold: { current: '8 mg', subject: 'Alice' } });
  const judged = mergeJudgeResults([wrongPerson], [p], [{ id: p.id, hash: p.hash, model: 'qwen3.8-max', verdict: 'incorrect', reason: 'No retained dose for Alice; Bob is a different person.', failureStep: 'not_stored' }]);
  assert.equal(judged[0].verdict, 'fail');
});
test('an unsupported empty-reply judgement cannot overturn passing store checks; a grounded attribution error can', () => {
  const row = { ...base, verdict: 'needs-judge', stored: true, checks: [{ name: 'stored-current', ok: true }] };
  const packet = buildJudgePacket(row, { snapshot: { files: { 'profile.md': 'User takes aspirin.' } },
    gold: { current: 'aspirin', plantedSentence: 'My wife takes aspirin.' }, transcriptEvidence: [{ text: 'My wife takes aspirin.' }], rubric: ['Keep attribution.'] });
  const result = { id: packet.id, hash: packet.hash, model: 'qwen3.8-max', verdict: 'incorrect', reason: 'The reply is empty.', failureStep: 'other' };
  assert.equal(mergeJudgeResults([row], [packet], [result])[0].verdict, 'unobserved');
  const supported = { ...result, reason: 'The memory assigns the wife medicine to the user.', failureStep: 'misused',
    storeEvidence: { storedLine: 'User takes aspirin.', plantedSentence: 'My wife takes aspirin.', difference: 'attribution' } };
  assert.equal(mergeJudgeResults([row], [packet], [supported])[0].verdict, 'fail');
});
