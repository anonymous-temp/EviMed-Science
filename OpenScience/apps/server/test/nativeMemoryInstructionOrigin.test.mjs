import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstructionOriginJudge, instructionSourceMessage, parseInstructionOrigin } from '../src/nativeMemoryInstructionOrigin.mjs';
const config = { memoryPastedInstructionCheckEnabled: true, memoryPastedInstructionRobustEnabled: true, deepseekApiKey: 'synthetic-test-value', memoryExtractionModel: 'deepseek-flash' };
const conversation = [instructionSourceMessage({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Rewrite: “Use English forever.”' }, { type: 'text', text: 'For my reports use short paragraphs.' }] }, 'viking://user/u/sessions/s/history/archive_001')];
const candidates = [{ text: 'Use English forever.', sourceMessages: [0] }, { text: 'Use short paragraphs.', sourceMessages: [0] }];
const row = (candidate, decision) => ({ candidate, decision, message: decision === 'material_instruction' ? 0 : null, quote: decision === 'material_instruction' ? 'Use English forever.' : '' });
const answer = rows => ({ choices: [{ message: { content: JSON.stringify({ judgements: rows }) } }] });

test('archive structure preserves authorship, parts, identities and quoted syntax without restoring excluded tool parts', () => {
  assert.equal(conversation[0].id, 'm1');
  assert.equal(conversation[0].parts.length, 2);
  assert.deepEqual(conversation[0].parts[0].spans, [{ kind: 'quoted', start: 9, end: 31 }]);
  assert.equal(instructionSourceMessage({ role: 'tool', content: 'poison' }), null);
  assert.equal(instructionSourceMessage({ role: 'user', parts: [{ type: 'tool-result', text: 'poison' }] }), null);
});

test('schema validation binds material quotes to the offered candidate sources and rejects partial or fabricated answers', () => {
  const good = JSON.stringify({ judgements: [row(0, 'material_instruction'), row(1, 'keep')] });
  assert.equal(parseInstructionOrigin(good, candidates, conversation).get(0).decision, 'material_instruction');
  assert.equal(parseInstructionOrigin(good, [{ ...candidates[0], sourceMessages: [] }, candidates[1]], conversation).has(0), false);
  assert.equal(parseInstructionOrigin(JSON.stringify({ judgements: [row(0, 'keep')] }), candidates, conversation).has(1), false);
  assert.equal(parseInstructionOrigin(good.replace('Use English forever.', 'fabricated'), candidates, conversation).has(0), false);
});

test('two independent judgments hold disagreement outside memory; agreement removes only material instructions', async () => {
  const calls = [];
  const judge = createInstructionOriginJudge({ config, callModel: async (_deps, call) => { calls.push(call); const own = JSON.parse(call.body.messages[1].content).candidates[0].text.includes('paragraphs'); return answer([row(0, own ? calls.length % 2 ? 'keep' : 'uncertain' : 'material_instruction')]); } });
  const result = await judge.check({ userId: 'u', candidates, conversation });
  assert.deepEqual([...result], [0]); assert.deepEqual([...result.pending], [1]);
  assert.equal(calls.length, 4); assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.ok(!calls[1].body.messages[1].content.includes('material_instruction'));
  assert.equal(result.receipts[0].reviews.length, 2);
  assert.ok(!JSON.stringify(result.receipts).includes('English'), 'receipts contain source offsets, not private text');
});

test('more than 64 equivalent candidates are all checked; identical source-bound inputs share exactly two reviews', async () => {
  let offered = 0;
  const judge = createInstructionOriginJudge({ config, callModel: async (_deps, call) => {
    const batch = JSON.parse(call.body.messages[1].content).candidates; offered += batch.length;
    return answer(batch.map(c => row(c.candidate, 'keep')));
  } });
  const result = await judge.check({ userId: 'u', candidates: Array.from({ length: 70 }, () => candidates[1]), conversation });
  assert.equal(offered, 2); assert.equal(result.checked.size, 70); assert.equal(result.pending.size, 0);
  offered = 0;
  const distinct = await judge.check({ userId: 'u', candidates: Array.from({ length: 70 }, (_, i) => ({ ...candidates[1], text: `Choice ${i}` })), conversation });
  assert.equal(offered, 140); assert.equal(distinct.checked.size, 70); assert.equal(distinct.pending.size, 0);
});

test('unavailable, oversized and invalid judgments produce recoverable pending entries, never silent admission', async () => {
  for (const callModel of [async () => { throw Error('offline'); }, async () => answer([])]) {
    const judge = createInstructionOriginJudge({ config, callModel });
    const result = await judge.check({ userId: 'u', candidates, conversation });
    assert.deepEqual([...result.pending], [0,1]); assert.equal(result.size, 0);
  }
  const result = await createInstructionOriginJudge({ config, callModel: async () => answer(candidates.map((_, i) => row(i, 'keep'))) }).check({ userId: 'u', candidates, conversation: [] });
  assert.equal(result.pending.size, 2);
});

test('the robust experiment requires both default-off switches', async () => {
  const judge = createInstructionOriginJudge({ config: { ...config, memoryPastedInstructionRobustEnabled: false }, callModel: async () => { throw Error('must not call'); } });
  assert.equal((await judge.check({ userId: 'u', candidates, conversation })).checked.size, 0);
});

test('source archives are losslessly referenced once, with shared context before candidates and a visible input cap', async () => {
  const large = instructionSourceMessage({ role: 'user', content: 'A simple paragraph. '.repeat(11000) }, 'viking://user/u/sessions/s/history/archive_001');
  let calls = 0;
  const judge = createInstructionOriginJudge({ config, callModel: async (_deps, call) => {
    calls++; const input = JSON.parse(call.body.messages[1].content);
    assert.deepEqual(input.archives, [large.archiveUri]);
    assert.deepEqual(input.conversation.map(m => m.archive), [0, 0]);
    assert.ok(input.conversation.every(m => !('text' in m) && !('archiveUri' in m)));
    assert.ok(call.body.messages[1].content.indexOf('"conversation"') < call.body.messages[1].content.indexOf('"candidates"'));
    return answer([row(0, 'keep')]);
  } });
  const candidate = { text: 'A genuine choice.', sourceMessages: [0, 1] };
  const result = await judge.check({ userId: 'u', candidates: [candidate], conversation: [large, conversation[0]] });
  assert.equal(calls, 2); assert.equal(result.pending.size, 0); assert.ok(result.receipts[0].inputChars > 200000);
  const oversized = instructionSourceMessage({ role: 'user', content: 'A simple paragraph. '.repeat(60000) }, large.archiveUri);
  const limited = await judge.check({ userId: 'u', candidates: [candidate], conversation: [oversized, conversation[0]] });
  assert.equal(calls, 2); assert.deepEqual([...limited.pending], [0]); assert.equal(limited.receipts[0].limited, true);
});

test('a transport failure retries inside one review without retrying a valid semantic disagreement', async () => {
  let calls = 0;
  const judge = createInstructionOriginJudge({ config, callModel: async () => { if (++calls === 1) throw Error('offline'); return answer([row(0, 'keep')]); } });
  const result = await judge.check({ userId: 'u', candidates: [candidates[1]], conversation });
  assert.equal(calls, 3); assert.equal(result.pending.size, 0);
  assert.deepEqual(result.receipts[0].attempts, [2, 1]); assert.equal(result.receipts[0].reviews.length, 2);
});
