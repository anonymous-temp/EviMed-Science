import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLines, hardTokens, createVerificationJudge, parseVerificationJudgement, verificationJudgeRequest } from '../src/nativeMemoryVerification.mjs';
import { parseMemoryTemplatesDirectory, parseNativeMemoryConsolidationMode } from '../src/config.mjs';

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
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.equal(JSON.stringify(request.body).includes('json_schema'), false);
    assert.deepEqual(request.body.thinking, { type: 'disabled' });
    assert.ok(request.body.messages[0].content.includes('JSON'));
    assert.ok(request.body.messages[0].content.includes('{"results":[{"index":0,"verdict":"supported","corrected":null}]}'));
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
    'null',
    '[]',
    JSON.stringify({ results: [{ verdict: 'unsupported', corrected: null }] }),
    JSON.stringify({ results: [{ index: 0, verdict: 'invented', corrected: null }] }),
    JSON.stringify({ results: [{ index: 0, verdict: 'corrected' }] }),
    JSON.stringify({ results: [{ index: 1, verdict: 'supported', corrected: null }] }),
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


test('invalid judge output retries once, charging both attempts and accepting only a valid batch', async () => {
  const lines = [{ text: 'Dose 99 mg.', sources: [source('Dose 12 mg.')] }];
  const fixed = [{ index: 0, verdict: 'corrected', corrected: 'Dose 12 mg.' }];
  for (const first of ['not JSON', JSON.stringify({ results: [{ index: 0, verdict: 'corrected', corrected: 'Dose 13 mg.' }] })]) {
    let calls = 0;
    const judge = createVerificationJudge({ config: { deepseekModel: 'test', deepseekApiKey: 'test', nativeMemoryVerifyDailyCalls: 2 },
      callModel: async (_deps, request) => {
        assert.deepEqual(request.body.response_format, { type: 'json_object' });
        return ++calls === 1 ? { choices: [{ message: { content: first } }] } : response(fixed);
      } });
    const result = await judge.judge({ userId: 'retry', lines });
    assert.equal(result.calls, 2);
    assert.equal(result.results.get(0).corrected, 'Dose 12 mg.');
    assert.equal((await judge.judge({ userId: 'retry', lines })).calls, 0);
    assert.equal(calls, 2);
  }
});

test('malformed batches exhaust at most two attempts and the retry obeys the daily cap', async () => {
  const lines = [{ text: 'Dose 99 mg.', sources: [source('Dose 12 mg.')] }];
  for (const cap of [1, 3]) {
    let calls = 0;
    const judge = createVerificationJudge({ config: { deepseekModel: 'test', deepseekApiKey: 'test', nativeMemoryVerifyDailyCalls: cap },
      callModel: async () => { calls++; return response([{ index: 0, verdict: 'unknown', corrected: null }]); } });
    const result = await judge.judge({ userId: 'retry-cap', lines });
    assert.equal(result.results.size, 0);
    assert.equal(result.calls, Math.min(cap, 2));
    assert.equal(calls, Math.min(cap, 2));
  }
});

test('duplicate or omitted ids invalidate the entire batch', () => {
  const lines = [{ text: 'Dose 99 mg.', sources: [source('Dose 12 mg.')] }, { text: 'Weight 90 kg.', sources: [source('Weight 70 kg.')] }];
  assert.equal(parseVerificationJudgement(JSON.stringify({ results: [
    { index: 0, verdict: 'supported', corrected: null }, { index: 0, verdict: 'unsupported', corrected: null },
  ] }), lines), null);
});


test('source timestamps ground calendar dates without lending their numbers to a correction', () => {
  const lines = [{ text: 'Dose 99 mg (2026-11-01).', sources: [source('Dose 12 mg.', 'user', '2026-11-01T12:00:00.000Z')] }];
  const content = corrected => JSON.stringify({ results: [{ index: 0, verdict: 'corrected', corrected }] });
  assert.equal(parseVerificationJudgement(content('Dose 12 mg (2026-11-01).'), lines).get(0).corrected, 'Dose 12 mg (2026-11-01).');
  assert.equal(verifyLines({ lines: [line('Dose 12 mg (2026-11-01).')], sources: lines[0].sources })[0].status, 'supported');
  assert.equal(parseVerificationJudgement(content('Dose 12 mg (2026-11-02).'), lines), null, 'an absent date still invalidates the batch');
  assert.equal(parseVerificationJudgement(content('Dose 11 mg (2026-11-01).'), lines), null, 'timestamp digits cannot ground a dose');
  assert.equal(parseVerificationJudgement(content('Dose 12 mg (2026-11-01).'), [{ ...lines[0], sources: [source('Dose 12 mg.', 'user', '2026-11-01 invalid')] }]), null);
});

test('extraction-v2 verification preserves historical labels and leaves the default request unchanged', () => {
  assert.doesNotMatch(verificationJudgeRequest('model', []).messages[0].content, /An earlier:/);
  assert.match(verificationJudgeRequest('model', [], { memoryTemplatesDirectory: 'memory-templates-extraction-v2' }).messages[0].content, /An earlier:/);
});

test('the single template setting defaults to current and refuses an unknown directory', () => {
  assert.equal(parseMemoryTemplatesDirectory(undefined), 'memory-templates');
  assert.equal(parseMemoryTemplatesDirectory(''), 'memory-templates');
  assert.equal(parseMemoryTemplatesDirectory('memory-templates-extraction-v2'), 'memory-templates-extraction-v2');
  assert.equal(parseMemoryTemplatesDirectory('memory-templates-next'), 'memory-templates-next');
  assert.throws(() => parseMemoryTemplatesDirectory('../elsewhere'), /OPEN_SCIENCE_MEMORY_TEMPLATES_DIR/);
});

// F03/F06 and XV P01-x07/P03-x10 are synthetic reproductions of recorded classes.
test('commit source review repairs only grounded attribution and leaves unsupported lines visible', async () => {
  const { NativeMemoryVerification } = await import('../src/nativeMemoryVerification.mjs');
  const original = '- 回复先结论后依据，200 字以内；需要展开时先问。\n- 用户使用 REDCap。\n- 用户认为患者依从性最难，项目已经启动。\n- Unverifiable statement.';
  const sources = [source('回复先结论后依据，200 字以内。'), source('可以试试 REDCap。', 'assistant'), source('我认为患者依从性最难。')];
  const fixes = ['回复先结论后依据，200 字以内。', 'Assistant suggested REDCap; the user has not adopted it.', '用户认为患者依从性最难。'];
  let calls = 0;
  const verification = new NativeMemoryVerification({ config: {}, sessions: {}, overlay: {}, judge: { judge: async ({ lines, maxAttempts }) => {
    calls++; assert.equal(maxAttempts, 1); assert.deepEqual(lines[0].sources, sources);
    return { calls: 1, results: new Map(lines.map((_, index) => [index, { index, verdict: index === 3 ? 'unsupported' : 'attribution_wrong', corrected: fixes[index] ?? null }])) };
  } } });
  const reviewed = await verification.assessCommit('u', [{ uri: 'profile', before: '', after: original }], sources);
  assert.equal(calls, 1);
  for (const fix of fixes) assert.ok(reviewed.rewrites[0].after.includes(fix));
  assert.ok(reviewed.rewrites[0].after.includes('Unverifiable statement.'));
  assert.equal(reviewed.rewrites[0].after.includes('项目已经启动'), false);
});

test('commit review keeps own statements, corrections, adopted suggestions and confirmed document facts', async () => {
  const { NativeMemoryVerification } = await import('../src/nativeMemoryVerification.mjs');
  const texts = ['我对青霉素过敏。', '更正：我现在住迎泽区。', '就用你建议的 REDCap。', '文档里说的每周游泳也是我本人的情况。'];
  const verification = new NativeMemoryVerification({ config: {}, sessions: {}, overlay: {}, judge: { judge: async ({ lines }) => ({ calls: 1,
    results: new Map(lines.map((_, index) => [index, { index, verdict: 'supported', corrected: null }])) }) } });
  const after = texts.map(text => `- ${text}`).join('\n');
  const result = await verification.assessCommit('u', [{ uri: 'profile', before: '', after }], texts.map(text => source(text)));
  assert.equal(result.rewrites[0].after, after);
});

test('commit review is bounded, missing-source and unavailable/malformed judge results never change bytes', async () => {
  const { NativeMemoryVerification } = await import('../src/nativeMemoryVerification.mjs');
  for (const sources of [[], [source('Dose 12 mg.')]]) for (const mode of ['invalid', 'throws']) {
    let calls = 0;
    const judge = createVerificationJudge({ config: { deepseekModel: 'fake', deepseekApiKey: 'fake' }, callModel: async () => {
      calls++; if (mode === 'throws') throw Error('unavailable'); return response([]);
    } });
    const verification = new NativeMemoryVerification({ config: {}, sessions: {}, overlay: {}, judge });
    const after = Array.from({ length: 100 }, (_, index) => `- Dose ${index} mg.`).join('\n');
    const result = await verification.assessCommit('u', [{ uri: 'profile', before: '', after }], sources);
    assert.equal(result.rewrites[0].after, after);
    assert.ok(calls <= 1); assert.equal(result.omitted, 68);
  }
});

test('a commit correction cannot invent a number or borrow another conversation', async () => {
  const { NativeMemoryVerification } = await import('../src/nativeMemoryVerification.mjs');
  const verification = new NativeMemoryVerification({ config: {}, sessions: {}, overlay: {}, judge: { judge: async () => ({ calls: 1,
    results: new Map([[0, { index: 0, verdict: 'corrected', corrected: 'Dose 99 mg.' }]]) }) } });
  const after = '- Dose 12 mg.';
  assert.equal((await verification.assessCommit('u', [{ uri: 'profile', after }], [source('Dose 12 mg.')])).rewrites[0].after, after);
});

test('a malformed partial injected commit verdict cannot rewrite even its apparently valid row', async () => {
  const { NativeMemoryVerification } = await import('../src/nativeMemoryVerification.mjs');
  const verification = new NativeMemoryVerification({ config: {}, sessions: {}, overlay: {}, judge: { judge: async () => ({ calls: 1,
    results: new Map([[0, { index: 0, verdict: 'corrected', corrected: 'Dose 12 mg.' }]]) }) } });
  const after = '- Dose 21 mg.\n- Prefers concise replies.';
  assert.equal((await verification.assessCommit('u', [{ uri: 'profile', after }], [source('Dose 12 mg. Prefers concise replies.')])).rewrites[0].after, after);
});

test('commit judge requires every retained clause to cite verbatim user evidence from its own indexed source', async () => {
  const sources = [source('I use WPS.'), source('Ask before expanding.', 'assistant')];
  const text = 'I use WPS. Ask before expanding.';
  const first = { clause: 'I use WPS.', source: 0, quote: 'I use WPS.' };
  const second = { clause: 'Ask before expanding.', source: 1, quote: 'Ask before expanding.' };
  for (const [corrected, evidence, valid] of [[text, [first], false], [text, [first, second], false],
    [first.clause, [{ ...first, quote: 'Invented' }], false], [first.clause, [first], true]]) {
    const judge = createVerificationJudge({ config: { deepseekApiKey: 'fake', deepseekModel: 'test' },
      callModel: async (_deps, request) => {
        assert.match(request.body.messages[0].content, /project stage requires a user-reported progress event/);
        return response([{ index: 0, verdict: 'corrected', corrected, evidence }]);
      } });
    const result = await judge.judge({ userId: 'u', commit: true, maxAttempts: 1, lines: [{ text, sources }] });
    assert.equal(result.results.size, valid ? 1 : 0);
  }
});

test('stock verification cannot apply even a schema-valid wrong verdict, across 24 sourced rows', async () => {
  const { readFile } = await import('node:fs/promises');
  const { NativeMemoryVerification } = await import('../src/nativeMemoryVerification.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const rows = JSON.parse(await readFile(new URL('./fixtures/memory-verification-24.json', import.meta.url), 'utf8'));
  const root = 'viking://user/synthetic/memories';
  const files = new Map(), origins = new Map(), byText = new Map(), archives = new Map();
  for (const [i, row] of rows.entries()) {
    const uri = root + '/notes/' + i + '.md', archive = 'viking://user/synthetic/sessions/dsh-case' + i + '/history/archive_001';
    files.set(uri, '- ' + row.text); byText.set(row.text, row);
    origins.set(uri, new Map([[lineFingerprint(row.text), { archiveUri: archive }]]));
    archives.set(archive, row.sources);
  }
  const before = [...files];
  const sessions = { memoryRoot: () => root, tree: () => before.map(([uri]) => ({ uri })), read: (_u, uri) => files.get(uri),
    replace: () => assert.fail('stock report must never write') };
  const overlay = { files: () => new Map(), originsOf: () => origins,
    memoryForgetBody: (_u, _uri, body) => byText.get(body.slice(2)).group === 'withdrawn' ? null : body };
  const checked = new Set();
  const reviewer = new NativeMemoryVerification({ sessions, overlay, config: { nativeMemoryConsolidationEnabled: true,
    memoryEngineEnabled: true, nativeMemoryConsolidationMode: 'verify' }, judge: { judge: async ({ lines }) => ({
      calls: 1, results: new Map(lines.map(({ index, text, sources }) => {
        const row = byText.get(text);
        assert.deepEqual(sources, row.sources);
        checked.add(text);
        // This swaps the meaning without introducing any hard token; the old writer accepted it.
        return [index, { index, verdict: 'corrected', corrected: 'User declined.' }];
      })),
    }) } });
  reviewer.readSources = async (_user, sources) => archives.get(sources[0].archiveUri);
  const report = await reviewer.verifyExisting('synthetic');
  assert.equal(rows.length, 24);
  assert.equal(checked.size, 23);
  assert.equal(report.suggested, 23);
  assert.equal(report.corrected, 0);
  assert.equal(report.calls, 3);
  assert.deepEqual([...files], before);
});

test('a correction in the stage section cannot overwrite identical words in an untouched section', async () => {
  const { NativeMemoryVerification } = await import('../src/nativeMemoryVerification.mjs');
  const before = '## Opinion\n- Difficult.', added = '\n## Stage\n- Difficult.';
  const reviewer = new NativeMemoryVerification({ config: {}, overlay: {}, sessions: {}, judge: { judge: async ({ lines }) => {
    assert.deepEqual(lines.map(l => l.heading), ['## Stage']);
    return { calls: 1, results: new Map([[0, { index: 0, verdict: 'corrected', corrected: 'User believes: this is difficult.' }]]) };
  } } });
  const result = await reviewer.assessCommit('u', [{ uri: 'p', type: 'project_context', before, after: before + added }], [source('I believe this is difficult.')]);
  assert.equal(result.rewrites[0].after, '- User believes: this is difficult.\n' + before + '\n## Stage');
});
