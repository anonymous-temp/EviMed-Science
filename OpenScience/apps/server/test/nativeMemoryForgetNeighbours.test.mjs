import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const runARows = JSON.parse(readFileSync(new URL('./fixtures/forget-neighbours-run-a.json', import.meta.url), 'utf8'));
import { removalStatement, removalContentMatch, removalRefusals, removalText, removalAssertionKey } from '../src/nativeMemoryRejections.mjs';
import { hardTokens } from '../src/nativeMemoryHardTokens.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { duplicatesOf } from '../src/nativeMemoryForgetEverywhere.mjs';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { keepUnexplainedLines } from '../src/nativeMemoryKeepLines.mjs';

// Exact synthetic product-path bytes, 2026-11-17 run A (pp-recheck-2.json).
const night = '- 用户自述：上个月临时顶了两次夜班，属一次性事件，不是固定排班（2026-11-17 用户陈述）。';
const keys = '- 家里备用钥匙放在蓝色鞋柜第二层（用户 2026-11-17 说明）。';
const allergy = '- 对青霉素过敏，用药需避开青霉素类 (as of 2026-11-17)';
const swimming = '- 每周三晚上去游泳 (as of 2026-11-17)';
const fact = '上个月临时顶了两次夜班，属一次性事件，不是固定排班';
const row = text => ({ text: removalText(text), fingerprint: lineFingerprint(removalText(text)), rejectedAt: '2026-11-17T07:23:30.672Z', origin: 'forget' });
const overlayFor = (...texts) => ({ removals: async () => texts.map(row), originsOf: async () => new Map(), instructionCheck: async () => null });

test('provenance annotations in either statement never supply content tokens; actual event dates stay', () => {
  for (const note of ['as of 2026-11-17', 'said on 2026-11-17', 'reported on 2026-11-17', 'User said on 2026-11-17', '2026-11-17 用户陈述',
    '用户 2026-11-17 说明', '用户于2026年11月17日确认', 'source: interview-132', '来源：用户对话 2026-11-17']) {
    for (const [left, right] of [['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['{', '}'], ['「', '」'], ['〈', '〉']]) {
      for (const text of [`${left}${note}${right}${fact}`, `${fact}${left}${note}${right}`, `上个月${left}${note}${right}临时顶了两次夜班，属一次性事件，不是固定排班`]) {
        assert.equal(removalStatement(text), fact.normalize('NFKC'), text);
        assert.deepEqual(hardTokens(removalStatement(text)), [], text);
        assert.equal(removalContentMatch(text, fact), true);
        assert.equal(removalContentMatch(fact, text), true);
      }
    }
  }
  for (const label of ['用户自述：', 'User believes: ', 'User reports: ', 'Source: interview; ', '助手建议（用户未采用）：', 'Assistant suggested (not adopted): ']) assert.equal(removalStatement(label + fact), fact.normalize('NFKC'));
  assert.deepEqual(hardTokens(removalStatement('手术日期为 2026-11-17（用户 2026-11-18 说明）')), ['2026-11-17']);
  assert.match(removalStatement('曾为：成都（截至 2026-11-02）'), /2026-11-02/);
});

test('run A: withdrawal hides restatements and cross-file copies, never the same-date neighbours', async () => {
  const copies = [night, fact, `User believes: ${fact} [said on 2026-12-01]`, `${fact}（用户 2026-12-02 说明）。`];
  const candidates = [...copies, keys, allergy, swimming].map(text => ({ text }));
  const refused = await removalRefusals({ userId: 'run-a', overlay: overlayFor(night), candidates });
  assert.deepEqual([...refused.keys()].sort(), copies.map(lineFingerprint).sort());
  const duplicates = await duplicatesOf({ userId: 'run-a', removed: [night], files: [
    { uri: 'copy.md', type: 'notes', statements: copies }, { uri: 'keys.md', type: 'notes', statements: [keys] },
  ] });
  assert.deepEqual(duplicates.get('copy.md'), copies);
  assert.equal(duplicates.has('keys.md'), false, 'physical copy sweep cannot delete a neighbour');
  const before = [night, keys, allergy, swimming].join('\n');
  const withdrawn = new Set([...refused.keys(), ...copies.map(removalText).map(lineFingerprint)]);
  const kept = keepUnexplainedLines({ enabled: true, before, after: '', neverKept: () => false, withdrawn });
  assert.match(kept.after, /备用钥匙/); assert.doesNotMatch(kept.after, /夜班/);
});

test('number-bearing facts require their subject, and dates/years/small integers never suffice', async () => {
  const pairs = [
    ['血肌酐 132', '血肌酐为 132（用户 2026-11-17 说明）', true],
    ['**血肌酐:** 132', '血肌酐为 132（用户 2026-11-17 说明）', true],
    ['血肌酐 132', '我的血钠是 132（用户 2026-11-17 说明）', false],
    ['血肌酐 132', '血肌酐为 133', false],
    ['我平时骑车通勤，单程约 40 分钟', '通勤时我平时坐地铁，单程约 40 分钟', false],
    ['诊断日期 2026-11-17', '钥匙记录日期 2026-11-17', false],
    ['2026-11-17', '游泳 (2026-11-17)', false], ['2026', '2026 次游泳', false],
    ['2', '参加 2 次活动', false], ['2026年', '2026年', false],
    ['用户自述：（2026-11-17 用户陈述）', keys, false],
    ['用户自述：（2026-11-17 用户陈述）', '用户自述：（2026-11-17 用户陈述）', false],
    ['Source: interview-132', 'Source: interview-132', false],
  ];
  for (const [removed, candidate, expected] of pairs) {
    const refused = await removalRefusals({ userId: 'u', overlay: overlayFor(removed), candidates: [{ text: candidate }] });
    assert.equal(refused.size > 0, expected, `${removed} / ${candidate}`);
  }
});

test('already-stored run-A rejection rows heal through the native fence without rewriting bytes or rows', async () => {
  const uri = runARows.native_line_origins[0].uri;
  const removals = runARows.native_rejections.map(row => ({ ...row, rejectedAt: row.rejected_at }));
  const origins = new Map(runARows.native_line_origins.map(row => [row.uri, new Map(runARows.native_line_origins
    .filter(other => other.uri === row.uri).map(origin => [origin.fingerprint, { archiveUri: origin.archive_uri }]))]));
  const overlay = { removals: async () => removals, originsOf: async () => origins, removalOrigins: async () => [] };
  const authority = JSON.stringify(await overlay.removals());
  const ledger = new MemoryHistoryLedger({ overlay, database: { query: async (sql, values) => {
    if (sql.includes('history_fences')) return { rows: runARows.history_fences };
    if (sql.includes('history_message_rejections')) return { rows: runARows.history_message_rejections
      .filter(row => row.message_hash === row.fingerprint && values[3].includes(row.archive_uri)) };
    if (sql.includes('history_write_messages')) return { rows: runARows.history_write_messages.filter(row => values[3].includes(row.archive_uri)) };
    throw new Error(`Unexpected query ${sql}`);
  } } });
  ledger.migrate = async () => {};
  const history = new MemoryHistory({ config: {}, contexts: {}, ledger });
  const context = { ownerId: 'run-a', ownerCreatedAt: '2026-11-17', namespaceId: 'run-a', kind: 'owned' };
  assert.equal(await history.fenceNativeBody(context, uri, keys), keys);
  assert.equal(await history.fenceNativeBody(context, uri, [allergy, swimming].join('\n')), [allergy, swimming].join('\n'));
  for (const copy of [night, fact, `${fact}（用户 2026-12-01 说明）`]) assert.equal(await history.fenceNativeBody(context, 'copy.md', copy), null);
  assert.equal(JSON.stringify(await overlay.removals()), authority, 'no migration or receipt is needed');
});

test('history pending-scan fences use content, not dates or timestamp provenance', async () => {
  for (const scan_pending of [true, false]) {
    const ledger = new MemoryHistoryLedger({ overlay: overlayFor(night), database: { query: async () => ({ rows: [{
      memory_type: 'notes', fingerprint: row(night).fingerprint, text: row(night).text, scan_pending,
    }] }) } });
    ledger.migrate = async () => {};
    const context = { ownerId: 'u', kind: 'owned', namespaceId: 'u' };
    assert.equal(await ledger.rejected(context, [keys]), false);
    assert.equal(await ledger.rejected(context, [fact]), true);
    const history = new MemoryHistory({ config: {}, contexts: {}, ledger });
    const messages = [{ text: keys, created_at: '2026-11-17' }, { text: fact }];
    const judge = { same: async () => ({ same: new Map(), stated: new Set() }) };
    assert.deepEqual(await history.matchRemoved(context, night, messages, judge), [messages[1]]);
    assert.deepEqual(await history.matchRemoved(context, '血肌酐 132', [{ text: '血肌酐为 132' }, { text: '血钠 132' }], judge), [{ text: '血肌酐为 132' }]);
  }
});

// Fixed digest from the pre-fix receipt normalization, not the new content comparator.
test('existing source-bound assertion receipts retain their identities', () => {
  assert.equal(removalAssertionKey(null, row(night), night, { role: 'user', text: removalText(night), created_at: '2099-01-01T00:00:00Z' }),
    'd616f4ab1e7eb5ed03e913662b1c59be94021fd26e4533b0fde0f2171c20fcfb');
});

test('native export projections share the provenance-free containment rule', async () => {
  const { projectNativeMemoryAccountData } = await import('../src/nativeMemoryAccountExport.mjs');
  const root = 'viking://user/test';
  const projected = projectNativeMemoryAccountData({ commits: [], revisions: [], imports: [],
    admissions: [{ state: 'pending', pendingText: `${keys}\n${night.replace('2026-11-17', '2026-12-01')}` }],
    rejections: [{ ...row(night), memoryType: 'notes' }] }, [root]);
  assert.match(JSON.stringify(projected), /蓝色鞋柜第二层/);
  assert.doesNotMatch(JSON.stringify(projected), /夜班/);
});

test('history literal fences retain short withdrawals, format characters, titles and fragment boundaries', async () => {
  const cases = [
    ['我吃素', '我吃素，希望聚餐时准备蔬菜。'],
    ['青霉素过敏', 'Legacy title says 青霉素过敏 only'],
    ['青霉素过敏', `${'普通'.repeat(899)}青霉素过敏，请记住。`],
    ['我\u200b吃素', '平时我吃素，需要准备蔬菜。'],
    ['我吃素', '平时我\u200b吃素，需要准备蔬菜。'],
  ];
  for (const [removed, message] of cases) {
    for (const scan_pending of [true, false]) {
      const ledger = new MemoryHistoryLedger({ overlay: overlayFor(removed), database: { query: async () => ({ rows: [{
        memory_type: 'notes', fingerprint: row(removed).fingerprint, text: removed, scan_pending,
      }] }) } });
      ledger.migrate = async () => {};
      const context = { ownerId: 'u', kind: 'owned', namespaceId: 'u' };
      assert.equal(await ledger.rejected(context, [message]), true, message);
      assert.equal(await ledger.rejected(context, ['I prefer trial tables.']), false);
      const history = new MemoryHistory({ config: {}, contexts: {}, ledger });
      const messages = [{ text: message }];
      assert.deepEqual(await history.matchRemoved(context, removed, messages, null), messages);
    }
  }
});

test('content identifiers fence paraphrases without a judge, but provenance identifiers do not', async () => {
  const cases = [
    ['My withdrawn booking number is T-92516.', 'The appointment was filed under T-92516.'],
    ['M-41633', 'My old project is M-41633.'],
    ['M-41633', 'Forget M-41633.'],
    ...['M-31025', 'ｍ＿３１０２５', 'm 31025'].map(id => [
      'Parked at M-31025 (2026-11-11 03:30).', `Please remember: I parked at ${id}.`, '2026-11-11T03:30:01.687Z',
    ]),
  ];
  const history = new MemoryHistory({ config: {}, contexts: {}, ledger: {} });
  for (const [removed, text, createdAt] of cases) {
    assert.equal(removalContentMatch(text, removed, { createdAt }), true);
    const message = { text, created_at: createdAt };
    assert.deepEqual(await history.matchRemoved({ ownerId: 'u' }, removed, [message], null), [message]);
    if (!createdAt) assert.equal((await removalRefusals({ userId: 'u', overlay: overlayFor(removed), candidates: [{ text }] })).size, 1);
  }
  for (const [removed, text] of [
    ['Source: T-92516', 'The appointment was filed under T-92516.'],
    ['My booking is T-92516.', 'My booking is T-92516-4.'],
    ['My booking is T-92516.', 'My booking is T-92517.'],
    ['Dose for T-92516 is 12 mg.', 'Dose for T-92516 is 112 mg.'],
  ]) assert.equal(removalContentMatch(text, removed), false);
  assert.equal(removalContentMatch('Please remember: I parked at M-31025.', 'Parked at M-31025 (2026-11-11 03:30).'), false, 'an unbound timestamp cannot be assumed to be provenance');
  assert.equal(removalContentMatch('Appointment (2026-11-12 03:30).', 'Appointment (2026-11-11 03:30).'), false);
  assert.equal(removalContentMatch('Independent note.', '2026-11-11', { createdAt: '2026-11-11T03:30:00Z' }), false);
  assert.equal(removalContentMatch('Appointment.', 'Appointment (2026-11-11 03:30).', { createdAt: '2026-11-11T03:30:00Z' }), false);
  assert.match(removalStatement('Appointment (2026-11-11 03:30)'), /2026-11-11 03:30/);
  assert.match(removalStatement('Appointment date (2026-11-11)'), /2026-11-11/);
});


test('settled history scans retain unrelated statements with the same identifier', async () => {
  const removed = 'The locker code is F-25429.';
  const context = { ownerId: 'u', kind: 'owned', namespaceId: 'u' };
  for (const scan_pending of [true, false]) {
    const ledger = new MemoryHistoryLedger({ overlay: overlayFor(removed), database: { query: async () => ({ rows: [{
      memory_type: 'notes', fingerprint: row(removed).fingerprint, text: removed, scan_pending,
    }] }) } });
    ledger.migrate = async () => {};
    assert.equal(await ledger.rejected(context, ['The unrelated invoice is F-25429.']), scan_pending);
    assert.equal(await ledger.rejected(context, [removed]), true);
  }
});

test('complete quoted filenames are withdrawn independently of digest prefix and removal row order', async () => {
  for (const name of ['b1f451362d0d41c63661c044', '1c389473a2e9dd215586c660']) {
    for (const texts of [[`Project identifier "${name}".`, 'Project "Edited".'], ['Project "Edited".', `Project identifier "${name}".`]]) {
      const refused = await removalRefusals({ userId: 'u', overlay: overlayFor(...texts), candidates: [
        { text: name }, { text: `${name}-4` }, { text: `${name.slice(0, -1)}9` }, { text: '- Independent replacement.' },
      ] });
      assert.deepEqual([...refused.keys()], [lineFingerprint(name)]);
    }
  }
  assert.equal(removalContentMatch('2026-11-17', 'Date "2026-11-17".'), false);
  assert.equal(removalContentMatch('132', 'Creatinine "132".'), false);
  assert.equal(removalContentMatch('Sodium 132', 'Creatinine "132".'), false);
});
