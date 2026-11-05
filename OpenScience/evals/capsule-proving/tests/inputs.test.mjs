import assert from 'node:assert/strict';
import test from 'node:test';

async function subject() {
  try { return await import('../inputs.mjs'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    assert.fail('The proving pipeline has no role-preserving, gold-isolated input adapter.');
  }
}

const longCase = () => ({
  question_id: 'q-1', question_type: 'temporal-reasoning', question: 'What dose was last reported?',
  question_date: '2026-06-03', answer: '2.5 mg', answer_session_ids: ['s-2'],
  haystack_session_ids: ['s-1', 's-2'], haystack_dates: ['2026-06-01', '2026-06-02'],
  haystack_sessions: [
    [{ role: 'user', content: 'My dose was 5 mg.' }, { role: 'assistant', content: 'That is user-reported.' }],
    [{ role: 'user', content: 'My dose is now 2.5 mg; I am allergic to penicillin.' }],
  ],
});

const medData = () => ({
  sessions: [
    { session_id: 's-1', event_info: { date: '2026-01-01' }, knowledge_points: ['HIDDEN GOLD'], messages: [{ role: 'user', content: '我对青霉素过敏。', agent_type: 'patient', turn: 1 }] },
    { session_id: 's-2', event_info: { date: '2026-01-03' }, messages: [{ role: 'assistant', content: '助手建议过复诊，尚未确认。', agent_type: 'doctor', turn: 2 }, { role: 'user', content: '记录剂量 2.5 mg，NCT01234567。' }] },
    { session_id: 's-3', event_info: { date: '2026-01-10' }, messages: [{ role: 'user', content: 'FUTURE FACT MUST NOT BE SEEN.' }] },
  ],
});

const medQuery = () => ({
  query_id: 'q-med-1', session_id: 's-2', query_type: 'state_update', question: '目前报告的剂量是什么？',
  answers: [{ content: '2.5 mg', is_correct: true }], source_key_points: ['GOLD LOCATION'],
  metadata: { solution: 'PRIVATE ANSWER', rationale: 'PRIVATE REASON' },
});

test('LongMemEval runtime input preserves original roles, dates and literal clinical values without gold', async () => {
  const api = await subject();
  const input = api.longMemRuntimeInput(longCase());
  assert.deepEqual(input, {
    schema: 'capsule-proving-input/1', benchmark: 'longmemeval-s', id: 'q-1',
    question: { text: 'What dose was last reported?', asOf: '2026-06-03' },
    histories: [
      { sourceSessionId: 's-1', at: '2026-06-01', messages: [{ role: 'user', text: 'My dose was 5 mg.' }, { role: 'assistant', text: 'That is user-reported.' }] },
      { sourceSessionId: 's-2', at: '2026-06-02', messages: [{ role: 'user', text: 'My dose is now 2.5 mg; I am allergic to penicillin.' }] },
    ],
  });
  assert.doesNotMatch(JSON.stringify(input), /answer_session_ids|question_type|"answer"/);
  assert.equal(api.longMemGold(longCase()).answer, '2.5 mg');
  assert.equal(api.longMemGold(longCase()).question, longCase().question);
});

test('a malformed source alignment fails instead of silently shifting dates', async () => {
  const api = await subject();
  const short = longCase(); short.haystack_dates.pop();
  assert.throws(() => api.longMemRuntimeInput(short), /alignment/);
});

test('LongMemEval source-ID collisions preserve both original parts without inventing independent conversations', async () => {
  const api = await subject();
  const source = longCase(); source.haystack_session_ids[1] = 's-1';
  const input = api.longMemRuntimeInput(source);
  assert.deepEqual(input.histories.map(item => ({ id: item.sourceSessionId, part: item.sourcePart, at: item.at })), [
    { id: 's-1', part: 0, at: '2026-06-01' }, { id: 's-1', part: 1, at: '2026-06-02' },
  ]);
  assert.equal(input.histories[0].messages[0].text, 'My dose was 5 mg.');
  assert.equal(input.histories[1].messages[0].text, 'My dose is now 2.5 mg; I am allergic to penicillin.');
  assert.deepEqual(source.haystack_session_ids, ['s-1', 's-1']);
  const nonadjacent = longCase();
  nonadjacent.haystack_session_ids.push('s-1'); nonadjacent.haystack_dates.push('2026-06-03');
  nonadjacent.haystack_sessions.push([{ role: 'user', content: 'Later source part.' }]);
  assert.deepEqual(api.longMemRuntimeInput(nonadjacent).histories.map(item => item.sourcePart), [0, undefined, 2]);
});

test('tool/system records are not silently converted into the person speaking', async () => {
  const api = await subject();
  for (const role of ['tool', 'system', 'patient']) {
    const source = longCase(); source.haystack_sessions[0][0].role = role;
    assert.throws(() => api.longMemRuntimeInput(source), /role/);
  }
});

test('medical questions see only the source session prefix and keep assistant attribution intact', async () => {
  const api = await subject();
  const input = api.medMemoryRuntimeInput(medData(), medQuery(), { language: 'zh', persona: 'persona_1' });
  assert.equal(input.id, 'zh:persona_1:q-med-1');
  assert.equal(input.question.asOf, '2026-01-03');
  assert.deepEqual(input.histories.map(item => item.sourceSessionId), ['s-1', 's-2']);
  assert.deepEqual(input.histories[1].messages, [{ role: 'assistant', text: '助手建议过复诊，尚未确认。' }, { role: 'user', text: '记录剂量 2.5 mg，NCT01234567。' }]);
  assert.doesNotMatch(JSON.stringify(input), /FUTURE|HIDDEN GOLD|GOLD LOCATION|PRIVATE ANSWER|PRIVATE REASON|is_correct|knowledge_points|source_key_points|agent_type/);
  assert.equal(api.medMemoryGold(medQuery()).answers[0].is_correct, true);
});

test('medical anchoring never defaults to all future history when the source session is missing', async () => {
  const api = await subject();
  const query = medQuery(); query.session_id = 'missing';
  assert.throws(() => api.medMemoryRuntimeInput(medData(), query, { language: 'en', persona: 'persona_1' }), /anchor/);
  const data = medData(); data.sessions[2].session_id = 's-2';
  assert.throws(() => api.medMemoryRuntimeInput(data, medQuery(), { language: 'en', persona: 'persona_1' }), /duplicate/);
});

test('official medical numeric session IDs have one exact canonical anchor without losing zero or accepting ambiguous aliases', async () => {
  const api = await subject();
  const data = medData(); data.sessions.forEach((session, index) => { session.session_id = index; });
  const query = medQuery(); query.session_id = 1;
  const input = api.medMemoryRuntimeInput(data, query, { language: 'zh', persona: 'persona_1' });
  assert.deepEqual(input.histories.map(item => item.sourceSessionId), ['0', '1']);
  assert.equal(input.question.asOf, '2026-01-03');
  assert.equal(api.medMemoryGold(query).session_id, 1);
  assert.equal(api.medMemoryGold(query).question, query.question);
  const ambiguous = medData(); ambiguous.sessions[0].session_id = 1; ambiguous.sessions[1].session_id = '1';
  assert.throws(() => api.medMemoryRuntimeInput(ambiguous, query, { language: 'zh', persona: 'persona_1' }), /duplicate/);
  query.session_id = 1.5;
  assert.throws(() => api.medMemoryRuntimeInput(data, query, { language: 'zh', persona: 'persona_1' }), /identifier/);
});

test('empty or null original message text is not fabricated and does not discard an entire official question', async () => {
  const api = await subject();
  const source = longCase(); source.haystack_sessions[0] = [{ role: 'assistant', content: '' }, { role: 'user', content: null }];
  const input = api.longMemRuntimeInput(source);
  assert.deepEqual(input.histories[0].messages, [{ role: 'assistant', text: '' }, { role: 'user', text: '' }]);
  assert.equal(input.question.text, source.question);
  source.question = '';
  assert.throws(() => api.longMemRuntimeInput(source), /nonempty/);
});

test('frozen question pools are deterministic, disjoint and report shared history instead of claiming source independence', async () => {
  const api = await subject();
  const cases = [
    { question_id: 'a', haystack_session_ids: ['shared', 'only-a'] },
    { question_id: 'b', haystack_session_ids: ['shared', 'only-b'] },
    { question_id: 'c', haystack_session_ids: ['shared'] },
    { question_id: 'd', haystack_session_ids: ['shared'] },
  ];
  const options = { seed: 'frozen-v1', developmentCount: 2, sourceSha256: 'a'.repeat(64) };
  const first = api.registerQuestionPools(cases, options);
  assert.deepEqual(api.registerQuestionPools([...cases].reverse(), options), first);
  assert.equal(first.pools.development.length, 2);
  assert.equal(first.pools.confirmation.length, 2);
  assert.equal(new Set([...first.pools.development, ...first.pools.confirmation]).size, 4);
  assert.equal(first.confirmationScope, 'question-only');
  assert.equal(first.sourceOverlap.sharedSessionIds, 1);
  assert.equal(first.sourceOverlap.sourceContextDisjoint, false);
  assert.equal(api.validateFrozenPools(first).ok, true);
});

test('pool integrity catches changed membership, overlapping IDs, duplicate sources and unknown source digest', async () => {
  const api = await subject();
  const cases = [{ question_id: 'a', haystack_session_ids: ['a'] }, { question_id: 'b', haystack_session_ids: ['b'] }];
  const options = { seed: 'frozen-v1', developmentCount: 1, sourceSha256: 'a'.repeat(64) };
  const frozen = api.registerQuestionPools(cases, options);
  const tampered = structuredClone(frozen); tampered.pools.confirmation[0] = tampered.pools.development[0];
  assert.equal(api.validateFrozenPools(tampered).ok, false);
  assert.throws(() => api.registerQuestionPools([...cases, cases[0]], options), /duplicate/);
  assert.throws(() => api.registerQuestionPools(cases, { ...options, sourceSha256: '' }), /digest/);
  assert.throws(() => api.registerQuestionPools(cases, { ...options, developmentCount: 2 }), /confirmation/);
});

test('an unknown historical date stays unknown rather than being rewritten to the execution clock', async () => {
  const api = await subject();
  const data = medData(); delete data.sessions[0].event_info.date;
  const input = api.medMemoryRuntimeInput(data, medQuery(), { language: 'zh', persona: 'persona_1' });
  assert.equal(input.histories[0].at, null);
  assert.equal(input.histories[1].at, '2026-01-03');
});
