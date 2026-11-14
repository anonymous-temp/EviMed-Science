import assert from 'node:assert/strict';
import test from 'node:test';
import { lineRefusal } from '../src/nativeMemoryWorker.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { removalAssertionKey, removalLines, removalRefusals } from '../src/nativeMemoryRejections.mjs';
import { hardTokens, sourceHasToken } from '../src/nativeMemoryHardTokens.mjs';

const removal = { fingerprint: lineFingerprint('Project M-41633.'), text: 'Project M-41633.', rejectedAt: '2026-11-10T10:00:00.000Z' };
const affirmed = { same: async ({ candidates, said }) => ({ same: new Map(candidates.map((candidate, index) => [index, candidate.removed[0].fingerprint])), stated: new Set(said.length ? candidates.map((_candidate, index) => index) : []), witnesses: new Map(said.length ? candidates.map((_candidate, index) => [index, 0]) : []) }) };
const overlay = { removals: async () => [removal] };
const source = (text, at = '2026-11-10T11:00:00.000Z', role = 'user') => ({ text, created_at: at, role });

test('hard tokens are uncapped code; old, undated and assistant messages cannot authorize a rewrite', async () => {
  const candidates = Array.from({ length: 24 }, (_, n) => ({ text: `Project M-41633: detail ${n}`, sources: [
    source('M-41633', '2026-11-10T09:00:00.000Z'), source('M-41633', null), source('M-41633', undefined, 'assistant'),
  ] }));
  const refused = await removalRefusals({ userId: 'u', overlay, candidates, judge: { same: () => { throw new Error('must not spend the judge budget'); } } });
  assert.equal(refused.size, 24);
  assert.equal((await removalRefusals({ userId: 'u', overlay, judge: affirmed, candidates: [{ text: 'M-41633', sources: [source('My project M-41633.')] }] })).size, 0);
  assert.equal((await removalRefusals({ userId: 'u', overlay, judge: affirmed, candidates: [{ text: 'M-41633', sources: [source('A different project M-41634.')] }] })).size, 1);
  assert.equal((await removalRefusals({ userId: 'u', overlay, judge: affirmed, candidates: [{ text: 'M-416330' }] })).size, 0, 'whole identifiers only');
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
  const judge = { same: async request => { requests.push(request); return { same: new Map([[0, removal.fingerprint]]), stated: new Set([0]), witnesses: new Map([[0, 0]]) }; } };
  const text = 'Likes comparisons presented as tables.';
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge, candidates: [{ text, sources: [source(text, '2026-11-10T09:00:00.000Z')] }] })).size, 1);
  assert.deepEqual(requests[0].said, []);
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge, candidates: [{ text, sources: [source(text)] }] })).size, 0);
});

test('a message timestamp grounds its provenance date when relearning, without lending any other token', async () => {
  const guard = { removals: async () => [{ ...removal, text: 'Project M-41633 (user told us on 2026-11-10).' }] };
  const text = 'Project M-41633 (2026-11-10, user stated).';
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge: affirmed, candidates: [{ text, sources: [source('My project is M-41633.')] }] })).size, 0);
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge: affirmed, candidates: [{ text, sources: [source('My project is M-41633.', '2026-11-10T09:00:00.000Z')] }] })).size, 1);
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge: affirmed, candidates: [{ text, sources: [source('My project is M-41634.')] }] })).size, 1);
});


test('removal refusals preserve the existing never-kept precedence for secret-shaped body lines', () => {
  const text = 'ID 110101199001011237';
  assert.equal(lineRefusal(text, new Map([[lineFingerprint(text), 'rejected_reworded']])), 'identifier_shape');
});

for (const spelling of ['M-41633', 'm_41633', 'm 41633', 'Ｍ＿４１６３３', 'Ｍ－４１６３３']) {
  test(`hard-token removal and source authority share normalized identifier spelling: ${spelling}`, async () => {
    const candidate = { text: `Project ${spelling}.` };
    assert.equal((await removalRefusals({ userId: 'u', overlay, judge: affirmed, candidates: [candidate] })).size, 1);
    assert.equal((await removalRefusals({ userId: 'u', overlay, judge: affirmed, candidates: [{ ...candidate, sources: [source(`Project ${spelling}.`)] }] })).size, 0);
    const reverse = { removals: async () => [{ ...removal, text: candidate.text }] };
    assert.equal((await removalRefusals({ userId: 'u', overlay: reverse, candidates: [{ text: 'Project M-41633.' }] })).size, 1);
  });
}

test('extraction-added clock time is grounded only by the matching original timestamp', async () => {
  const guard = { removals: async () => [{ ...removal, text: 'Parked at M-41633 (2026-11-10 11:00).' }] };
  const text = 'Parked at M-41633 (2026-11-10 11:00).';
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge: affirmed, candidates: [{ text, sources: [source('Parked at M-41633.')] }] })).size, 0);
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge: affirmed, candidates: [{ text, sources: [source('Parked at M-41633.', '2026-11-10T11:01:00.000Z')] }] })).size, 1);
});

test('a clock time before Chinese provenance words remains one token, grounded in the original message', () => {
  const tokens = hardTokens('用户把车停在 M-31025 车位（2026-11-11 03:30 会话中告知）。');
  assert.deepEqual(tokens, ['m-31025', '2026-11-11', '03:30']);
  const original = { text: '请帮我记住：我把车停在M-31025车位，回来的时候提醒我带伞。', created_at: '2026-11-11T03:30:01.687Z' };
  assert.ok(tokens.every(token => sourceHasToken(token, original)));
});

for (const text of ['Did I use project M-41633?', 'The earlier chat said "Project M-41633."', 'Please forget Project M-41633.']) {
  test(`a later message containing removed words is not its own assertion: ${text}`, async () => {
    const judge = { same: async () => ({ same: new Map([[0, removal.fingerprint]]), stated: new Set() }) };
    assert.equal((await removalRefusals({ userId: 'u', overlay, judge,
      candidates: [{ text: 'Project M-41633.', sources: [source(text)] }] })).size, 1);
  });
}
test('the exact swimming line cannot return through a question and an assistant quotation', async () => {
  const text = '每周三晚上去游泳 (as of 2026-11-14)';
  const guard = { removals: async () => [{ ...removal, text }] };
  const judge = { same: async () => ({ same: new Map(), stated: new Set() }) };
  assert.equal((await removalRefusals({ userId: 'u', overlay: guard, judge, candidates: [{ text,
    sources: [source('我每周哪天去游泳？'), source('每周三晚上。这条来自早前对话：“每周三晚上我去游泳”。需要我补进笔记吗？', undefined, 'assistant')] }] })).size, 1);
});

test('a literal no-token quote still needs affirmative human authorization', async () => {
  const text = '每周三晚上去游泳', rejectedAt = removal.rejectedAt;
  const guard = {removals:async()=>[{text,fingerprint:lineFingerprint(text),rejectedAt}]};
  const judge = {same:async()=>({same:new Map(),stated:new Set()})};
  assert.equal((await removalRefusals({userId:'u',overlay:guard,judge,candidates:[{text,sources:[source(`The earlier chat said “${text}”.`)]}]})).size,1);
});

test('a checked later assertion survives read-only recall, but never a different source or a newer removal', async () => {
  const checks = new Map(), text = '每周三晚上去游泳';
  let rejectedAt = removal.rejectedAt;
  const guard = {removals:async()=>[{text,fingerprint:lineFingerprint(text),rejectedAt}],
    instructionCheck:async(_owner,key)=>checks.get(key),recordInstructionCheck:async(_owner,key,value)=>checks.set(key,value)};
  const candidates = [{text,sources:[source('每周三晚上我去游泳。')]}];
  const judge = {same:async()=>({same:new Map(),stated:new Set([0]),witnesses:new Map([[0,0]])})};
  assert.equal((await removalRefusals({userId:'u',overlay:guard,judge,candidates})).size,0);
  assert.equal((await removalRefusals({userId:'u',overlay:guard,candidates})).size,0);
  assert.equal((await removalRefusals({userId:'u',overlay:guard,candidates:[{text,sources:[source('我每周哪天去游泳？')]}]})).size,1);
  rejectedAt = '2026-11-10T12:00:00Z';
  assert.equal((await removalRefusals({userId:'u',overlay:guard,candidates})).size,1);
});

for (const witnesses of [undefined, new Map([[0, 8]])]) test('a stated index without an in-range source witness cannot authorize a write', async () => {
  const judge = { same: async () => ({ same: new Map([[0, removal.fingerprint]]), stated: new Set([0]), witnesses }) };
  assert.equal((await removalRefusals({ userId: 'u', overlay, judge,
    candidates: [{ text: removal.text, sources: [source('Did I use project M-41633?')] }] })).size, 1);
});

test('FT12 a later message that is exactly the removed statement re-admits it without a model; a question, quote, assistant or old message never does', async () => {
  const text = 'Private source A.', rejectedAt = removal.rejectedAt, receipts = new Map();
  const guard = { removals: async () => [{ text, fingerprint: lineFingerprint(text), rejectedAt }],
    instructionCheck: async (/** @type {string} */ _owner, /** @type {string} */ key) => receipts.get(key),
    recordInstructionCheck: async (/** @type {string} */ _owner, /** @type {string} */ key, /** @type {unknown} */ value) => { receipts.set(key, value); } };
  const refused = async (/** @type {any[]} */ sources, candidate = `${text} (as of 2026-11-14)`) =>
    (await removalRefusals({ userId: 'u', overlay: guard, candidates: [{ text: candidate, sources }] })).size;
  for (const other of [source('Is it Private source A.?'), source(`The earlier chat said “${text}”`), source(text, '2026-11-10T11:00:00.000Z', 'assistant'),
    source(text, '2026-11-10T09:00:00.000Z'), source(`${text} And B.`)]) assert.equal(await refused([other]), 1, `${other.role}: ${other.text}`);
  assert.equal(receipts.size, 0, 'no refused source leaves a receipt');
  assert.equal(await refused([source(text)]), 0, 'the person said it again, as a whole message, in a new conversation');
  assert.equal(receipts.get(removalAssertionKey(null, { fingerprint: lineFingerprint(text), rejectedAt }, text, source(text)))?.removalAssertion, true,
    'the history reader shares the same receipt for that new message');
  assert.equal(await refused([source(text)], `${text} Also B.`), 1, 'a line that adds to the restated words is not authorized by them');
});
