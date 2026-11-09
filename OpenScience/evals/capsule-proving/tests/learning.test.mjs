import assert from 'node:assert/strict';
import test from 'node:test';
import { registerQuestionPools, validateFrozenPools } from '../inputs.mjs';
import { brandGenericGold, brandGenericRuntimeInput, brandGenericScore, buildBrandGenericItems, medMemoryHfGold, medMemoryHfKey, medMemoryHfRuntimeInput,
  medLoCoMoGold, medLoCoMoRuntimeInput, rabbitsPairs, templateOk, wildChatPseudoUserRuntimeInput } from '../inputsLearning.mjs';

const turn = (persona, session, n, role, content, date = '2024-01-05') => ({ persona_id: persona, session_id: session, turn: n, role, content,
  event_info: JSON.stringify({ event: 'PRIVATE EVENT TEXT', type: 'health', date }), knowledge_points: 'HIDDEN GOLD' });
const dialogue = () => [
  turn(1, 2, 2, 'assistant', 'Doctor reply'), turn(1, 2, 1, 'user', 'Patient is allergic to penicillin.', '2024-02-01'),
  turn(1, 1, 1, 'user', 'First visit', '2024-01-05'), turn(1, 3, 1, 'user', 'FUTURE FACT MUST NOT BE SEEN', '2024-03-01'),
];
const hfQuery = () => ({ persona_id: 1, query_id: 'session_2_eem_1', session_id: 2, query_type: 'entity_exact_match', question: 'Which drug allergy?',
  answers: '[{"content":"penicillin","is_correct":true}]', source_key_points: '[{"content":"HIDDEN KEY POINT"}]', metadata: '{"difficulty":"hard"}' });

test('MedMemoryBench HF input sees sessions up to the anchor in order, with dates and no hidden fields; gold keeps answers apart', () => {
  const input = medMemoryHfRuntimeInput(dialogue(), hfQuery(), { language: 'en' });
  assert.equal(input.id, 'en:persona_1:session_2_eem_1');
  assert.deepEqual(input.histories.map(h => h.sourceSessionId), ['session_1', 'session_2']);
  assert.deepEqual(input.histories[1].messages, [{ role: 'user', text: 'Patient is allergic to penicillin.' }, { role: 'assistant', text: 'Doctor reply' }]);
  assert.equal(input.question.asOf, '2024-02-01');
  assert.doesNotMatch(JSON.stringify(input), /FUTURE|HIDDEN|PRIVATE EVENT|penicillin"\}/);
  const gold = medMemoryHfGold(hfQuery(), { language: 'en' });
  assert.equal(gold.id, input.id); assert.equal(gold.answers[0].content, 'penicillin'); assert.equal(gold.source_key_points[0].content, 'HIDDEN KEY POINT');
  assert.equal(medMemoryHfKey(hfQuery()), 'persona_1:session_2_eem_1');
});

test('MedMemoryBench HF refuses a missing anchor, a foreign persona and an unknown role instead of defaulting to all history', () => {
  assert.throws(() => medMemoryHfRuntimeInput(dialogue(), { ...hfQuery(), session_id: 9 }, { language: 'en' }), /anchor/);
  assert.throws(() => medMemoryHfRuntimeInput([...dialogue(), turn(2, 1, 1, 'user', 'x')], hfQuery(), { language: 'en' }), /another persona/);
  assert.throws(() => medMemoryHfRuntimeInput([...dialogue(), turn(1, 2, 3, 'tool', 'x')], hfQuery(), { language: 'en' }), /role/);
  assert.throws(() => medMemoryHfRuntimeInput(dialogue(), hfQuery(), { language: 'fr' }), /zh or en/);
});

test('the language-neutral key gives zh and en one frozen split, and the pool passes its own integrity check', () => {
  const rows = Array.from({ length: 10 }, (_x, i) => ({ question_id: medMemoryHfKey({ persona_id: i, query_id: `q${i}` }), haystack_session_ids: [`persona_${i}/session_1`] }));
  const options = { seed: 'capsule-proving-20261109-v1', developmentCount: 3, sourceSha256: 'a'.repeat(64), benchmark: 'medmemorybench-hf' };
  const a = registerQuestionPools(rows, options); const b = registerQuestionPools([...rows].reverse(), options);
  assert.deepEqual(a.pools, b.pools); assert.equal(validateFrozenPools(a).ok, true);
});

test('WildChat pseudo-user input orders conversations by time, has no question or gold and rejects other roles', () => {
  const user = { pseudoUserId: 'abc', conversations: [
    { conversationHash: 'h2', timestamp: '2023-05-02T10:00:00', messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '' }] },
    { conversationHash: 'h1', timestamp: '2023-05-01T09:00:00', messages: [{ role: 'user', text: '第一次' }] }] };
  const input = wildChatPseudoUserRuntimeInput(user);
  assert.deepEqual(input.histories.map(h => h.sourceSessionId), ['h1', 'h2']);
  assert.equal(input.question, null); assert.equal(input.id, 'wildchat:abc'); assert.equal(input.structure.timestampMeaning, 'last-turn');
  assert.equal(input.histories[1].messages[1].text, '');
  assert.throws(() => wildChatPseudoUserRuntimeInput({ ...user, conversations: [{ ...user.conversations[0], messages: [{ role: 'system', text: 'x' }] }] }), /role/);
  assert.throws(() => wildChatPseudoUserRuntimeInput({ pseudoUserId: 'abc', conversations: [] }), /no conversations/);
});

const csv = 'generic,brand\nabatacept,[[\'orencia\']]\nacarbose,"[[\'precose\', \'glucobay\']]"\nfoo,[[\'dup\']]\nbar,[[\'dup\']]\nab,[[\'xy\']]\nsame,[[\'same\']]\nzolpidem,[[\'ambien\']]\n';
const templates = { statements: ['I take {drug} every morning.', 'My refill of {drug} is due.'], questions: ['Can I drink coffee with {drug}?', 'What if I miss a dose of {drug}?'] };

test('RABBITS pairs: single words only, an ambiguous brand drops both generics, order follows the file', () => {
  assert.deepEqual(rabbitsPairs(csv), [{ generic: 'abatacept', brand: 'orencia' }, { generic: 'acarbose', brand: 'precose' }, { generic: 'zolpidem', brand: 'ambien' }]);
  assert.throws(() => rabbitsPairs('a,b\n1,2'), /header/);
});

test('templates need exactly one {drug} slot', () => {
  assert.equal(templateOk('I take {drug}.'), true);
  assert.equal(templateOk('I take {drug} and {drug}.'), false);
  assert.equal(templateOk('I take it.'), false);
  assert.equal(templateOk('I take {drug} {x}.'), false);
  assert.throws(() => buildBrandGenericItems(rabbitsPairs(csv), { statements: ['no slot'], questions: ['{drug}?'] }, { seed: 's' }), /slot/);
});

test('brand/generic items are deterministic, the runtime input hides pair, direction and gold, and scoring is code', () => {
  const pairs = rabbitsPairs(csv);
  const items = buildBrandGenericItems(pairs, templates, { seed: 'capsule-proving-20261109-v1' });
  assert.deepEqual(items, buildBrandGenericItems(pairs, templates, { seed: 'capsule-proving-20261109-v1' }));
  for (const item of items) {
    const input = brandGenericRuntimeInput(item);
    assert.equal(input.histories[0].messages.length, 1); assert.equal(input.histories[0].messages[0].role, 'user');
    assert.doesNotMatch(JSON.stringify(input), /direction|accept|bridge/);
    const stated = item.statedKind === 'brand' ? item.stated[0].toUpperCase() + item.stated.slice(1) : item.stated;
    assert.ok(input.histories[0].messages[0].text.includes(stated)); assert.ok(!input.histories[0].messages[0].text.toLowerCase().includes(item.asked));
    assert.ok(input.question.text.toLowerCase().includes(item.asked)); assert.ok(!input.question.text.toLowerCase().includes(item.stated));
    const gold = brandGenericGold(item);
    assert.deepEqual(brandGenericScore(gold, `Yes, ${item.stated} is fine.`), { containsStated: true, containsAsked: false, pass: true, bridged: true });
    assert.deepEqual(brandGenericScore(gold, `The drug ${item.asked} works.`), { containsStated: false, containsAsked: true, pass: true, bridged: false });
    assert.equal(brandGenericScore(gold, 'No idea.').pass, false);
  }
  assert.equal(new Set(items.map(item => item.direction)).size >= 1, true);
  const gold = brandGenericGold({ ...items[0], stated: 'ambien', asked: 'zolpidem' });
  assert.equal(brandGenericScore(gold, 'preambient zolpidemx').pass, false); // whole words only
});

const patient = () => ({ subject_id: '1001', admissions: [
  { hadm_id: '22', admission_start: '2145-05-01 08:00:00', admission_end: '2145-05-02', conversation_lines: [{ turn_number: 1, time: '2145-05-01 08:01:00', speaker: 'Doctor', text: 'How are you?' }, { turn_number: 2, time: '2145-05-01 08:02:00', speaker: 'Patient', text: 'Pain again.' }] },
  { hadm_id: '11', admission_start: '2145-04-01 08:00:00', admission_end: '2145-04-02', conversation_lines: [{ turn_number: 1, time: '2145-04-01 08:01:00', speaker: 'Patient', text: 'I take metoclopramide.' }] }] });
const qa = () => ({ qa_id: '1001_cross_q01', scope: 'cross_admission', question_type: 'adversarial', question: 'Did drug X help?', answer: 'the question is not answerable', evidence: { admissions: ['11', '22'] } });

test('MedLoCoMo maps patient to user and doctor to assistant, orders admissions by start, and keeps evidence and the abstention answer in gold', () => {
  const input = medLoCoMoRuntimeInput(patient(), qa());
  assert.deepEqual(input.histories.map(h => h.sourceSessionId), ['11', '22']);
  assert.deepEqual(input.histories[1].messages.map(m => m.role), ['assistant', 'user']);
  assert.equal(input.roleMapping.rule, 'Patient=user, Doctor=assistant'); assert.equal(input.question.asOf, null);
  assert.doesNotMatch(JSON.stringify(input), /not answerable|evidence|adversarial/);
  const gold = medLoCoMoGold(qa());
  assert.equal(gold.adversarial, true); assert.equal(gold.answer, 'the question is not answerable'); assert.deepEqual(gold.evidence.admissions, ['11', '22']);
  const bad = patient(); bad.admissions[0].conversation_lines[0].speaker = 'Nurse';
  assert.throws(() => medLoCoMoRuntimeInput(bad, qa()), /speaker/);
});

test('every pinned learning file has a sha256, or is large-only with the git blob sha1 of its commit; the fetcher plans all of them', async () => {
  const { readFileSync } = await import('node:fs');
  const { plan } = await import('../fetch-public.mjs');
  const sources = JSON.parse(readFileSync(new URL('../sources.json', import.meta.url), 'utf8'));
  const entries = plan(sources);
  const learning = entries.filter(entry => Object.hasOwn(sources.learning, entry.set));
  assert.ok(learning.length > 4000);
  for (const entry of learning) {
    if (entry.large) assert.match(entry.sha256 ?? entry.gitBlobSha1, /^[a-f0-9]{40,64}$/);
    else assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
  for (const [key, info] of Object.entries(sources.learning)) {
    if (!info.files.length) continue;
    assert.match(info.revision, /^[a-f0-9]{40}$/, key);
    assert.equal(info.totalBytes, info.files.reduce((sum, file) => sum + file.bytes, 0), key);
  }
  assert.equal(entries.filter(entry => entry.set === 'cl-bench' && entry.path === 'LICENSE').length, 1);
});
