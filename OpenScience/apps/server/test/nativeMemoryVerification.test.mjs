import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLines, hardTokens, createVerificationJudge, parseVerificationJudgement, verificationJudgeRequest } from '../src/nativeMemoryVerification.mjs';
import { parseNativeMemoryConsolidationMode } from '../src/config.mjs';

const line = text => ({ text, uri: 'viking://user/test/memories/profile.md', fingerprint: text });
const source = (text, role = 'user', created_at = '2026-11-01') => ({ text, role, created_at });
const response = results => ({ choices: [{ message: { content: JSON.stringify({ results }) } }] });

test('literal verification reuses quotation normalisation for English and Chinese, numbers, dates, identifiers and quoted names', () => {
  const cases = [
    ['Current dose 12 mg.', 'Current dose 21 mg.', 'contradicted_or_unsupported', '12 mg'],
    ['负责人是“王青”。', '负责人是“李明”。', 'contradicted_or_unsupported', '王青'],
    ['Study GSE12345 starts 2026-11-10.', 'Study GSE54321 starts 2026-11-12.', 'contradicted_or_unsupported', 'gse12345'],
    ['Weight is ７０ kg.', 'Weight is 70 kg.', 'supported'],
    ['项目名是“北斗”。', '项目名是「北斗」。', 'supported'],
    ['Prefers concise answers.', 'Please keep replies brief.', 'needs_reading'],
    ['Dose 12 mg.', 'Dose 112 mg.', 'contradicted_or_unsupported', '12 mg'],
    ['Dose 12 mg.', 'Dose 12 kg.', 'contradicted_or_unsupported', '12 mg'],
    ['Dose 12 mg.', 'Concentration 12 mg/dL.', 'contradicted_or_unsupported', '12 mg'],
    ['Change 12 kg.', 'Change -12 kg.', 'contradicted_or_unsupported', '12 kg'],
    ['Study ABC123.', 'Study ABC123-4.', 'contradicted_or_unsupported', 'abc123'],
  ];
  for (const [text, said, status, missing] of cases) {
    const [row] = verifyLines({ lines: [line(text)], sources: [source(said)] });
    assert.equal(row.status, status, text);
    if (missing) assert.ok(row.missingTokens.includes(missing), JSON.stringify(row));
  }
  assert.ok(hardTokens('研究在2026年11月10日开始').includes('2026年11月10日'));
});

test('one line cannot borrow tokens from another line’s sources', () => {
  const a = line('Weight 70 kg.'), b = line('Weight 90 kg.');
  const results = verifyLines({ lines: [a, b], sources: new Map([[a.fingerprint, [source('Weight 90 kg.')]], [b.fingerprint, [source('Weight 70 kg.')]]]) });
  assert.ok(results.every(row => row.status === 'contradicted_or_unsupported'));
});

test('strict judge checks outdated values and wrong attribution in one batch, with grounded corrections', async () => {
  const lines = [
    { text: 'Weight 70 kg.', sources: [source('Weight 70 kg.', 'user', '2026-10-01'), source('Now weight 68 kg.', 'user', '2026-11-01')] },
    { text: 'The user follows a vegetarian diet.', sources: [source('You could try a vegetarian diet.', 'assistant')] },
    { text: '负责人是“王青”。', sources: [source('负责人是“李明”。')] },
    { text: 'Dose 99 mg.', sources: [source('Dose 12 mg.')] },
  ];
  let calls = 0;
  const judge = createVerificationJudge({ config: { deepseekModel: 'test', deepseekApiKey: 'test', nativeMemoryVerifyDailyCalls: 1 }, callModel: async (_deps, request) => {
    calls++;
    assert.equal(request.body.response_format.json_schema.strict, true);
    return response([
      { index: 0, verdict: 'corrected', corrected: 'Weight 68 kg.' },
      { index: 1, verdict: 'attribution_wrong', corrected: 'The assistant suggested trying a vegetarian diet.' },
      { index: 2, verdict: 'corrected', corrected: '负责人是“李明”。' },
      { index: 3, verdict: 'unsupported', corrected: null },
    ]);
  } });
  const result = await judge.judge({ userId: 'user', lines });
  assert.equal(result.calls, 1);
  assert.equal(result.results.get(0).corrected, 'Weight 68 kg.');
  assert.equal(result.results.get(1).verdict, 'attribution_wrong');
  assert.equal(result.results.get(3).verdict, 'unsupported');
  assert.equal((await judge.judge({ userId: 'user', lines })).calls, 0);
  assert.equal(calls, 1);
  assert.equal(verificationJudgeRequest('test', lines).messages.length, 2);
});

test('invalid JSON, duplicate indexes, extra fields and invented correction tokens fail open', async () => {
  const lines = [{ text: 'Dose 99 mg.', sources: [source('Dose 12 mg.')] }];
  for (const value of [
    'invalid',
    JSON.stringify({ results: [{ index: 0, verdict: 'corrected', corrected: 'Dose 13 mg.' }] }),
    JSON.stringify({ results: [{ index: 0, verdict: 'unsupported', corrected: null, extra: true }] }),
    JSON.stringify({ results: [] }),
  ]) assert.equal(parseVerificationJudgement(value, lines), null);
  const judge = createVerificationJudge({ config: { deepseekModel: 'test', deepseekApiKey: 'test' }, callModel: async () => { throw new Error('unavailable'); } });
  assert.equal((await judge.judge({ userId: 'user', lines })).results.size, 0);
});

test('consolidation modes default to merge and reject invalid configuration', () => {
  assert.equal(parseNativeMemoryConsolidationMode(undefined), 'merge');
  assert.equal(parseNativeMemoryConsolidationMode('verify'), 'verify');
  assert.throws(() => parseNativeMemoryConsolidationMode('verfiy'));
});

test('the daily cap counts failed calls before asking and resets on the next UTC day', async () => {
  let date = new Date('2026-11-10T23:59:59Z'), calls = 0;
  const judge = createVerificationJudge({ config: { deepseekModel: 'test', deepseekApiKey: 'test', nativeMemoryVerifyDailyCalls: 1 }, now: () => date,
    callModel: async () => { calls++; throw new Error('provider unavailable'); } });
  const request = { userId: 'daily-budget', lines: [{ text: 'Prefers brief answers.', sources: [source('Please be brief.')] }] };
  assert.equal((await judge.judge(request)).calls, 1);
  assert.equal((await judge.judge(request)).calls, 0);
  date = new Date('2026-11-11T00:00:01Z');
  assert.equal((await judge.judge(request)).calls, 1);
  assert.equal(calls, 2);
});
