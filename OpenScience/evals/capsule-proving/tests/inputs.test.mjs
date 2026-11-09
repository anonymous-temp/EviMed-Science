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

// --- public general-memory corpora ------------------------------------------

const locomoSample = () => ({
  sample_id: 'conv-1',
  conversation: {
    speaker_a: 'Caroline', speaker_b: 'Melanie',
    session_1_date_time: '1:56 pm on 8 May, 2023',
    session_1: [
      { speaker: 'Caroline', dia_id: 'D1:1', text: 'I went to a support group yesterday.' },
      { speaker: 'Melanie', dia_id: 'D1:2', text: 'That sounds powerful.', blip_caption: 'a photo of a poster', img_url: 'https://example.invalid/x.jpg' },
    ],
    session_2_date_time: '9 pm on 20 May, 2023',
    session_2: [{ speaker: 'Caroline', dia_id: 'D2:1', text: '' }],
    session_1_observation: 'GENERATED OBSERVATION MUST NOT BE HISTORY',
  },
  observation: { session_1_observation: 'LEAK' }, session_summary: { session_1_summary: 'LEAK' },
  qa: [
    { question: 'When did Caroline go to the group?', answer: '7 May 2023', evidence: ['D1:1'], category: 2 },
    { question: 'What did Caroline realize after the race?', evidence: ['D1:2'], category: 5, adversarial_answer: 'self-care is important' },
    { question: 'Both fields row?', answer: 'x', adversarial_answer: 'decoy', evidence: [], category: 5 },
  ],
});

test('LoCoMo maps the two named speakers to roles deterministically, orders sessions numerically and never leaks answers or generated summaries', async () => {
  const api = await subject();
  const sample = locomoSample();
  const input = api.locomoRuntimeInput(sample, 0);
  assert.equal(input.benchmark, 'locomo');
  assert.equal(input.id, 'conv-1:q0');
  assert.deepEqual(input.roleMapping, { rule: 'speaker_a=user, speaker_b=assistant', user: 'Caroline', assistant: 'Melanie' });
  assert.deepEqual(input.histories.map(item => [item.sourceSessionId, item.at]), [['session_1', '1:56 pm on 8 May, 2023'], ['session_2', '9 pm on 20 May, 2023']]);
  assert.deepEqual(input.histories[0].messages.map(item => [item.role, item.speaker, item.turnId]), [['user', 'Caroline', 'D1:1'], ['assistant', 'Melanie', 'D1:2']]);
  assert.equal(input.histories[0].messages[1].imageCaption, 'a photo of a poster');
  assert.equal(input.histories[1].messages[0].text, '', 'an empty source turn stays an empty turn');
  assert.equal(input.question.asOf, null, 'LoCoMo has no question date and none is invented');
  assert.doesNotMatch(JSON.stringify(input), /7 May 2023|adversarial|category|evidence|OBSERVATION|LEAK|img_url/);
  assert.equal(api.locomoRuntimeInput(sample, 0, { benchmark: 'locomo-refined' }).benchmark, 'locomo-refined');
  assert.throws(() => api.locomoRuntimeInput(sample, 0, { benchmark: 'other' }), /benchmark/);
  assert.throws(() => api.locomoRuntimeInput(sample, 9), /range/);
  sample.conversation.session_2[0].speaker = 'Someone Else';
  assert.throws(() => api.locomoRuntimeInput(sample, 0), /speaker/);
});

test('LoCoMo gold keeps adversarial rows and their decoy answer under a flag instead of dropping or answering them', async () => {
  const api = await subject();
  const sample = locomoSample();
  const plain = api.locomoGold(sample, 0);
  assert.equal(plain.answer, '7 May 2023'); assert.equal(plain.categoryName, 'temporal'); assert.equal(plain.adversarial, false); assert.equal(plain.hasAnswer, true);
  const adversarial = api.locomoGold(sample, 1);
  assert.equal(adversarial.adversarial, true); assert.equal(adversarial.hasAnswer, false);
  assert.equal(adversarial.adversarial_answer, 'self-care is important');
  assert.equal(Object.hasOwn(adversarial, 'answer'), false);
  const both = api.locomoGold(sample, 2);
  assert.equal(both.answer, 'x'); assert.equal(both.adversarial_answer, 'decoy'); assert.equal(both.adversarial, true);
  assert.equal(api.locomoRuntimeInput(sample, 1).question.text, 'What did Caroline realize after the race?');
});

const haluUser = () => ({
  uuid: 'u-1', persona_info: 'Name: SECRET PERSONA', sessions: [
    { start_time: 'Sep 04, 2025, 18:00:00', end_time: 'Sep 04, 2025, 19:00:00', memory_points: [{ index: 1, memory_content: 'MEMORY POINT ONE' }], questions: [],
      dialogue: [{ role: 'user', content: 'I am Martin.', timestamp: 'Sep 04, 2025, 18:00:00', dialogue_turn: 0 }, { role: 'assistant', content: '', timestamp: 'Sep 04, 2025, 18:01:00', dialogue_turn: 0 }] },
    { start_time: 'Sep 05, 2025, 18:00:00', end_time: 'Sep 05, 2025, 19:00:00', memory_points: [{ index: 2, memory_content: 'MEMORY POINT TWO' }],
      questions: [{ question: 'What is his name?', answer: 'Martin', evidence: [{ memory_content: 'EVIDENCE TEXT' }], difficulty: 'easy', question_type: 'Basic Fact Recall' }],
      dialogue: [{ role: 'user', content: 'More.', timestamp: 'Sep 05, 2025, 18:00:00' }] },
    { start_time: 'Sep 06, 2025, 18:00:00', end_time: 'Sep 06, 2025, 19:00:00', memory_points: [], questions: [], dialogue: [{ role: 'user', content: 'FUTURE SESSION MUST NOT BE SEEN' }] },
  ],
});

test('HaluMem questions see sessions up to their own, keep timestamps and empty turns, and hide persona, memory points and evidence', async () => {
  const api = await subject();
  const input = api.haluMemRuntimeInput(haluUser(), 1, 0);
  assert.equal(input.id, 'u-1:s1:q0');
  assert.deepEqual(input.histories.map(item => item.sourceSessionId), ['session_0', 'session_1']);
  assert.equal(input.question.asOf, 'Sep 05, 2025, 19:00:00');
  assert.deepEqual(input.histories[0].messages[1], { role: 'assistant', text: '', at: 'Sep 04, 2025, 18:01:00' });
  assert.doesNotMatch(JSON.stringify(input), /SECRET|MEMORY POINT|EVIDENCE|FUTURE|Martin"|answer|difficulty|question_type/);
  const gold = api.haluMemGold(haluUser(), 1, 0);
  assert.equal(gold.answer, 'Martin'); assert.equal(gold.memory_points[0].memory_content, 'MEMORY POINT TWO'); assert.match(gold.persona_info, /SECRET/);
  assert.equal(api.haluMemUserGold(haluUser()).sessions[0].memory_points[0].memory_content, 'MEMORY POINT ONE');
  assert.throws(() => api.haluMemRuntimeInput(haluUser(), 0, 0), /question index/);
  assert.throws(() => api.haluMemRuntimeInput(haluUser(), 7, 0), /session index/);
});

const realPersona = () => ({
  _metadata: { person_name: 'Lin_Wanyu', total_sessions: 3 },
  dialogues: [
    { session_identifier: 'S1', session_uuid: 'aaa', current_time: '2025-12-15 (Monday)', dialogue_turns: [
      { speaker: 'User', content: 'Start of the project.', is_query: false, query_id: null },
      { speaker: 'Assistant', content: 'Noted.', is_query: false, query_id: null }] },
    { session_identifier: 'S2', session_uuid: 'bbb', current_time: '2025-12-20 (Saturday)', dialogue_turns: [
      { speaker: 'User', content: 'EARLIER TURN OF THE SAME SESSION', is_query: false },
      { speaker: 'User', content: 'Where did the project stand?', is_query: true, query_id: 'Q-0001', topic: 'Project', category_name: 'Dynamic', session_type: 'single_session' },
      { speaker: 'Assistant', content: 'REFERENCE ANSWER', is_query: false, memory_used: [{ session_uuid: 'aaa', content: 'GOLD MEMORY' }], memory_session_uuids: ['aaa'] }] },
    { session_identifier: 'S3', session_uuid: 'ccc', current_time: '2025-12-21 (Sunday)', dialogue_turns: [{ speaker: 'User', content: 'LATER SESSION', is_query: 'True', query_id: 'Q-0002' }] },
  ],
});

test('RealMem answers a query before its own session is ingested and keeps session dates, string-true queries and the generated gold apart', async () => {
  const api = await subject();
  const persona = realPersona();
  assert.deepEqual(api.realMemQueryRefs(persona), [{ sessionIndex: 1, turnIndex: 1 }, { sessionIndex: 2, turnIndex: 0 }]);
  const input = api.realMemRuntimeInput(persona, { sessionIndex: 1, turnIndex: 1 });
  assert.equal(input.id, 'Lin_Wanyu:Q-0001');
  assert.deepEqual(input.histories.map(item => [item.sourceSessionId, item.at]), [['aaa', '2025-12-15 (Monday)']]);
  assert.deepEqual(input.histories[0].messages, [{ role: 'user', text: 'Start of the project.' }, { role: 'assistant', text: 'Noted.' }]);
  assert.deepEqual(input.protocol, { order: 'query-before-own-session', lastIngestedSessionIndex: 0, ingestedSessions: 1, queryTurnIndex: 1 });
  assert.equal(input.question.asOf, '2025-12-20 (Saturday)');
  assert.doesNotMatch(JSON.stringify(input), /EARLIER TURN|REFERENCE ANSWER|GOLD MEMORY|LATER SESSION|memory_used|topic/);
  const first = api.realMemRuntimeInput(persona, { sessionIndex: 2, turnIndex: 0 });
  assert.equal(first.protocol.lastIngestedSessionIndex, 1);
  assert.equal(first.histories.length, 2);
  const gold = api.realMemGold(persona, { sessionIndex: 1, turnIndex: 1 });
  assert.equal(gold.reference_answer, 'REFERENCE ANSWER'); assert.equal(gold.goldKind, 'llm-generated'); assert.equal(gold.memory_used[0].content, 'GOLD MEMORY');
  assert.equal(api.realMemGold(persona, { sessionIndex: 2, turnIndex: 0 }).reference_answer, null);
  assert.throws(() => api.realMemRuntimeInput(persona, { sessionIndex: 0, turnIndex: 0 }), /query turn/);
  persona.dialogues[1].dialogue_turns[1].content = '';
  assert.throws(() => api.realMemRuntimeInput(persona, { sessionIndex: 1, turnIndex: 1 }), /nonempty/);
});

const personaRow = () => ({ persona_id: '521', user_query: "{'role': 'user', 'content': 'What\\'s a calm routine? It\\u2019s for me.'}", correct_answer: 'CORRECT ANSWER', incorrect_answers: '["WRONG ONE", "WRONG TWO"]', preference: 'PREFERENCE', pref_type: 'neutral_preferences', who: 'self', updated: 'False' });
const personaHistory = () => ({ metadata: { persona_id: 521 }, chat_history: [
  { role: 'system', content: 'You are an AI assistant helping a user with the following persona: PERSONA SECRET' },
  { role: 'user', content: 'Help me with an email.' }, { role: 'assistant', content: 'Sure.' }, { role: 'assistant' }, { role: 'user', content: '' }] });

test('PersonaMem-v2 strips the leading persona system message into gold, records that no session structure exists, and keeps empty and contentless turns', async () => {
  const api = await subject();
  const input = api.personaMemRuntimeInput(personaRow(), personaHistory(), { index: 7 });
  assert.equal(input.id, 'persona521:q7');
  assert.equal(input.question.text, 'What\'s a calm routine? It’s for me.');
  assert.deepEqual(input.structure, { sessionBoundaries: false, timestamps: false });
  assert.equal(input.histories.length, 1); assert.equal(input.histories[0].at, null);
  assert.deepEqual(input.histories[0].messages, [{ role: 'user', text: 'Help me with an email.' }, { role: 'assistant', text: 'Sure.' }, { role: 'assistant', text: '' }, { role: 'user', text: '' }]);
  assert.doesNotMatch(JSON.stringify(input), /PERSONA SECRET|CORRECT ANSWER|WRONG|PREFERENCE|system/);
  const gold = api.personaMemGold(personaRow(), personaHistory(), { index: 7 });
  assert.match(gold.persona_system_message, /PERSONA SECRET/); assert.equal(gold.correct_answer, 'CORRECT ANSWER'); assert.deepEqual(gold.incorrect_answers, ['WRONG ONE', 'WRONG TWO']);
  const noSystem = personaHistory(); noSystem.chat_history.shift();
  assert.throws(() => api.personaMemRuntimeInput(personaRow(), noSystem, { index: 0 }), /system message/);
  const second = personaHistory(); second.chat_history[2].role = 'system';
  assert.throws(() => api.personaMemRuntimeInput(personaRow(), second, { index: 0 }), /unexpected system/);
  assert.throws(() => api.personaMemRuntimeInput(personaRow(), personaHistory()), /row index/);
});

test('the Python-literal reader handles quote styles, escapes, None and refuses anything that is not one flat dict', async () => {
  const api = await subject();
  assert.deepEqual(api.pythonLiteralDict(`{'role': 'user', 'content': "it's \\"fine\\"\\n\\x41\\U0001F600", 'n': None, 'ok': True, 'k': 3}`), { role: 'user', content: 'it\'s "fine"\nA\u{1F600}', n: null, ok: true, k: 3 });
  assert.deepEqual(api.pythonLiteralDict('{}'), {});
  for (const bad of ["{'a': [1]}", "{'a': 'x'} trailing", "{'a': 'unterminated}", 'not a dict', "{'a' 'b'}"]) assert.throws(() => api.pythonLiteralDict(bad), TypeError);
});

test('MemSyco-Bench keeps one dated-less dialogue per sample and moves the memory policy and rubric into gold', async () => {
  const api = await subject();
  const row = { id: 'v11_000321', task: 'valid_memory_selection', dialogue: [{ role: 'assistant', content: 'Social mixers can feel forced.' }, { role: 'user', content: 'I played board games.' }],
    question: 'Which cooking class?', memory: { policy: 'update', items: [{ content: 'IDEAL MEMORY ITEM', type: 'x', status: 'current' }] },
    evaluation: { reference_answer: 'REFERENCE', rubric: { expected_behavior: 'RUBRIC' } }, metadata: { source: 'META' } };
  const input = api.memSycoRuntimeInput(row);
  assert.deepEqual(input.histories, [{ sourceSessionId: 'v11_000321', at: null, messages: [{ role: 'assistant', text: 'Social mixers can feel forced.' }, { role: 'user', text: 'I played board games.' }] }]);
  assert.deepEqual(input.harnessMeta, { task: 'valid_memory_selection' });
  assert.deepEqual(input.structure, { sessionBoundaries: false, timestamps: false });
  assert.doesNotMatch(JSON.stringify(input), /IDEAL MEMORY|update|REFERENCE|RUBRIC|META/);
  const gold = api.memSycoGold(row);
  assert.equal(gold.memory.policy, 'update'); assert.equal(gold.evaluation.reference_answer, 'REFERENCE');
  row.dialogue[0].role = 'tool';
  assert.throws(() => api.memSycoRuntimeInput(row), /role/);
});

test('pools take a benchmark name without changing the LongMemEval default, and a source-set digest needs real file digests', async () => {
  const api = await subject();
  const cases = [{ question_id: 'a', haystack_session_ids: ['x'] }, { question_id: 'b', haystack_session_ids: ['y'] }];
  const options = { seed: 'frozen-v1', developmentCount: 1, sourceSha256: 'a'.repeat(64) };
  assert.equal(api.registerQuestionPools(cases, options).benchmark, 'longmemeval-s');
  const named = api.registerQuestionPools(cases, { ...options, benchmark: 'locomo' });
  assert.equal(named.benchmark, 'locomo');
  assert.notEqual(named.digest, api.registerQuestionPools(cases, options).digest);
  assert.equal(api.validateFrozenPools(named).ok, true);
  const files = [{ path: 'b', sha256: 'b'.repeat(64) }, { path: 'a', sha256: 'a'.repeat(64) }];
  assert.equal(api.sourceSetSha256(files), api.sourceSetSha256([...files].reverse()));
  assert.throws(() => api.sourceSetSha256([{ path: 'a', sha256: 'short' }]), /SHA256/);
});
