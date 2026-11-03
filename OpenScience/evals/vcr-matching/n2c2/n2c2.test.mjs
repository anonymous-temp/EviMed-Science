// Tests of the n2c2 evaluation harness, on fabricated notes only: no patient text, no model call, no network.
// The tests that need the local n2c2 data (and the official scorer) skip when it is not unpacked, so they pass in CI without it.
//
//   node --test evals/vcr-matching/n2c2/n2c2.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { priceUsage } from '@evimed/domain';
import { assessPatient } from './assess.mjs';
import { ABSENT_MEANS_MET, CRITERIA, LANGUAGE_CRITERIA, TAGS, VARIABLES, criteriaIssues, languageKeysOf, variablesOf } from './criteria.mjs';
import { dataAvailable, dataPaths, dataRoot, developmentIds, evaluationDate, idsDigest, parsePatientXml, patientIds, readPatient, recordDates } from './data.mjs';
import { BudgetExceeded, createDeepSeek, priceOf, redact } from './deepseek.mjs';
import { labelsFor, majorityStates, patientCounts, randomStream, statistics, sumCounts, summarize, summarizePaired } from './metrics.mjs';
import { readSkill, skillExcerpts, systemPrompt, userMessage } from './prompt.mjs';
import { parseScorerOutput, predict, scoreHeldout, scoreHeldoutFourth, scoreTest } from './run_n2c2.mjs';

const here = import.meta.dirname;
const root = dataRoot();
const haveData = dataAvailable(root);
const RULE = '*'.repeat(100);

/** A made-up two-record file. Nothing in it is, or comes from, a patient. */
const NOTE = [
  '', 'Record date: 2100-01-10', '', 'Mr. Example is seen for review of type 2 diabetes.', 'Last hemoglobin A1c 7.2 %.',
  'He drinks no alcohol. Denies illicit drug use.', 'Takes aspirin 81 mg daily to prevent heart attack.', 'Takes a multivitamin every morning.', '', RULE,
  'Record date: 2100-03-01', '', 'Admitted with myocardial infarction on 2100-02-20 and chest pain on exertion.',
  'Speaks English fluently and decides about his care himself.', 'Serum creatinine 2.1 (0.6-1.2) H.', RULE, '',
].join('\n');
const PATIENT = { id: '900', text: NOTE, asOf: evaluationDate(NOTE) };
const fact = (/** @type {Record<string, any>} */ over) => ({ polarity: 'affirmed', ...over });
const answer = (/** @type {any[]} */ facts, /** @type {any[]} */ language = []) => ({ facts, language_judgments: language });

// ---------------------------------------------------------------------------------------------------------------------------
// criteria, skill, prompt
// ---------------------------------------------------------------------------------------------------------------------------

test('the thirteen criteria are in the official order, accepted by the grammar, and their variables and language keys are the ones the prompt lists', () => {
  assert.equal(TAGS.length, 13);
  assert.deepEqual(CRITERIA.map((item) => item.tag), [...TAGS]);
  assert.deepEqual(criteriaIssues(), [], 'every requirement is one the platform would accept');
  assert.deepEqual([...variablesOf()].sort(), Object.keys(VARIABLES).sort());
  assert.deepEqual([...languageKeysOf()].sort(), Object.keys(LANGUAGE_CRITERIA).sort());
  assert.deepEqual([...ABSENT_MEANS_MET], ['ENGLISH', 'MAKES-DECISIONS']);
  assert.ok(CRITERIA.every((item) => item.kind === 'inclusion' && item.sourceText.length > 10));
});

test('the prompt quotes the shipping skill unchanged, and a skill that lost a quoted stretch is refused by name', async () => {
  const skill = await readSkill();
  const prompt = systemPrompt(skill);
  assert.equal(skill.excerpts.length, 3);
  for (const excerpt of skill.excerpts) {
    assert.ok(excerpt.text.length > 200, excerpt.name);
    assert.ok(skill.text.includes(excerpt.text), `${excerpt.name} is a stretch of the skill file, byte for byte`);
    assert.ok(prompt.includes(excerpt.text), `${excerpt.name} is in the prompt, byte for byte`);
  }
  assert.ok(prompt.includes('dateQuote'), 'the skill and the answer shape both name the second quotation');
  for (const key of Object.keys(LANGUAGE_CRITERIA)) assert.ok(prompt.includes(key));
  for (const variable of Object.keys(VARIABLES)) assert.ok(prompt.includes(variable));
  assert.throws(() => skillExcerpts(skill.text.replace('Keep three questions separate for every criterion', 'Keep the questions')), /no longer holds the "evidence-decisions" stretch/);
  assert.throws(() => skillExcerpts(skill.text.replace('## 三、只回答需要语言的条件', '## 三')), /no longer holds the "writing-a-fact" stretch/);
  assert.match(userMessage(PATIENT), /Now \(the date of the most recent record\): 2100-03-01/);
});

// ---------------------------------------------------------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------------------------------------------------------

test('a patient file is read for its text, its tags and the date of its most recent record', () => {
  const tags = TAGS.map((tag, index) => `<${tag} met="${index % 2 ? 'met' : 'not met'}" />`).join('\n');
  const parsed = parsePatientXml(`<?xml version="1.0"?>\n<PatientMatching>\n<TEXT><![CDATA[${NOTE}]]></TEXT>\n<TAGS>\n${tags}\n</TAGS>\n</PatientMatching>`);
  assert.equal(parsed.text, NOTE, 'the text is exactly the CDATA content');
  assert.equal(parsed.tags?.ABDOMINAL, 'not met');
  assert.equal(parsed.tags?.['ADVANCED-CAD'], 'met');
  assert.equal(parsePatientXml(`<PatientMatching><TEXT><![CDATA[${NOTE}]]></TEXT></PatientMatching>`).tags, null, 'an unannotated file has no tags');
  assert.throws(() => parsePatientXml(`<TEXT><![CDATA[x]]></TEXT><TAGS><ABDOMINAL met="possible" /></TAGS>`), /only met and not met/);
  assert.throws(() => parsePatientXml(`<TEXT><![CDATA[x]]></TEXT><TAGS><ABDOMINAL met="met" /></TAGS>`), /lacks tags/);
  assert.deepEqual(recordDates(NOTE), ['2100-01-10', '2100-03-01']);
  assert.equal(evaluationDate(NOTE), '2100-03-01');
  assert.equal(evaluationDate('Record date: 2100-13-45\nno other'), null, 'a header that is not a date is not read');
});

test('the development split is fixed by a hash, is forty, a subset, and does not depend on the order of the ids', () => {
  const ids = Array.from({ length: 202 }, (_, index) => String(100 + index));
  const first = developmentIds(ids);
  assert.equal(first.length, 40);
  assert.equal(new Set(first).size, 40);
  assert.ok(first.every((id) => ids.includes(id)));
  assert.deepEqual(developmentIds([...ids].reverse()), first);
  assert.notDeepEqual(developmentIds(ids, { salt: 'another', size: 40 }), first);
  assert.equal(idsDigest(['b', 'a']), idsDigest(['a', 'b']));
});

// ---------------------------------------------------------------------------------------------------------------------------
// from the model's answer to the verdicts
// ---------------------------------------------------------------------------------------------------------------------------

test('a quotation that is in the note is kept, one that is not is dropped and its criterion stays unknown', () => {
  const result = assessPatient(PATIENT, answer([
    fact({ variable: 'drug_abuse', polarity: 'negated', surface: 'Denies illicit drug use', quote: 'He drinks no alcohol. Denies illicit drug use.' }),
    fact({ variable: 'intra_abdominal_surgery', surface: 'appendectomy', quote: 'Status post appendectomy in 2090.' }),
  ]));
  assert.equal(result.states['DRUG-ABUSE'], 'not_satisfied', 'an explicit denial is a known not-satisfied');
  assert.equal(result.states.ABDOMINAL, 'unknown', 'the fabricated quotation never reached the evaluator');
  assert.equal(result.facts.proposed, 2);
  assert.equal(result.facts.kept, 1);
  assert.equal(result.facts.dropped.quote_not_found, 1);
  assert.equal(result.decidedBy['DRUG-ABUSE'], 'code');
  assert.equal(result.decidedBy.ENGLISH, 'model');
});

test('an answer the model did not give leaves every criterion unknown, and silence is never read as not met', () => {
  for (const nothing of [null, {}, { facts: [] }, { facts: 'x' }]) {
    const result = assessPatient(PATIENT, nothing);
    assert.deepEqual(Object.values(result.states), Array(13).fill('unknown'));
    assert.equal(result.reasons['DRUG-ABUSE'], 'not_recorded');
  }
});

test('a window is counted back from the most recent record, and an event with no printed date takes its record header\'s date', () => {
  const MI = 'Admitted with myocardial infarction on 2100-02-20 and chest pain on exertion.';
  const dated = (/** @type {string} */ date, /** @type {string} */ quote) => answer([fact({ variable: 'myocardial_infarction', occurredAt: date, dateSurface: date, surface: 'myocardial infarction', quote })]);
  const inside = assessPatient(PATIENT, dated('2100-02-20', MI));
  assert.equal(inside.states['MI-6MOS'], 'satisfied');
  // No date of its own written: the header of the record the sentence is in, 2100-03-01, dates it (the 2026-11-02 ruling).
  const byHeader = assessPatient(PATIENT, answer([fact({ variable: 'myocardial_infarction', surface: 'myocardial infarction', quote: MI })]));
  assert.equal(byHeader.states['MI-6MOS'], 'satisfied');
  assert.deepEqual([byHeader.facts.datedByHeader, byHeader.facts.datedByRecordDateLine, byHeader.facts.boundedByHeader], [1, 1, 0]);
  // A date nobody printed is dropped, and the header date stands in its place: never the claimed one.
  const claimed = assessPatient(PATIENT, answer([fact({ variable: 'myocardial_infarction', occurredAt: '2099-01-05', surface: 'myocardial infarction', quote: MI })]));
  assert.deepEqual([claimed.facts.kept, claimed.facts.dateDropped, claimed.facts.dropped.date_not_in_span ?? 0, claimed.facts.datedByHeader], [1, 1, 0, 1], 'a date the quotation does not print is dropped; the fact is kept');
  assert.equal(claimed.states['MI-6MOS'], 'satisfied');
  // A note with no header above the sentence leaves the event undated, and an undated event decides nothing.
  const headerless = { ...PATIENT, text: `${NOTE.split('\n').filter((line) => !line.startsWith('Record date')).join('\n')}\nRecord date: 2100-03-01\n` };
  const none = assessPatient(headerless, answer([fact({ variable: 'myocardial_infarction', surface: 'myocardial infarction', quote: MI })]));
  assert.deepEqual([none.states['MI-6MOS'], none.reasons['MI-6MOS'], none.facts.datedByHeader], ['unknown', 'undated', 0]);
});

test('a past event the model marks historical is dated by its record header only as the latest it could be; the literal ruling dates it at the header', () => {
  const past = (/** @type {Record<string, any>} */ over = {}) => answer([fact({ variable: 'myocardial_infarction', surface: 'myocardial infarction', quote: 'Admitted with myocardial infarction on 2100-02-20 and chest pain on exertion.', temporality: 'historical', ...over })]);
  // The header is 2100-03-01, inside the six months before it: a bound inside the window says nothing, the literal ruling says satisfied.
  const inside = assessPatient(PATIENT, past());
  assert.deepEqual([inside.states['MI-6MOS'], inside.reasons['MI-6MOS'], inside.facts.boundedByHeader], ['unknown', 'undated', 1]);
  const literal = assessPatient(PATIENT, past(), undefined, { pastGuard: false });
  assert.deepEqual([literal.states['MI-6MOS'], literal.facts.boundedByHeader], ['satisfied', 0]);
  // The event is outside the window, but does not establish that no later event occurred.
  const later = assessPatient({ ...PATIENT, asOf: '2101-01-01' }, past());
  assert.equal(later.states['MI-6MOS'], 'unknown');
  // The literal ruling also lacks complete later history.
  assert.equal(assessPatient({ ...PATIENT, asOf: '2101-01-01' }, past(), undefined, { pastGuard: false }).states['MI-6MOS'], 'unknown');
  // A negated finding is not an event that happened: the word is not carried and the denial stands as it did.
  const denied = assessPatient(PATIENT, answer([fact({ variable: 'drug_abuse', polarity: 'negated', temporality: 'historical', surface: 'Denies illicit drug use', quote: 'He drinks no alcohol. Denies illicit drug use.' })]));
  assert.deepEqual([denied.states['DRUG-ABUSE'], denied.facts.boundedByHeader], ['not_satisfied', 0]);
});

test('a current state takes its record\'s header date; a date nobody printed is dropped, and the header date stands where the file has one', () => {
  const supplement = { variable: 'dietary_supplement', surface: 'multivitamin', quote: 'Takes a multivitamin every morning.' };
  const first = assessPatient(PATIENT, answer([fact({ ...supplement, occurredAt: '2100-01-10', dateSurface: '2100-01-10', dateQuote: 'Record date: 2100-01-10' })]));
  assert.equal(first.states['DIETSUPP-2MOS'], 'satisfied', 'two months back from the latest record reaches the first record\'s date');
  assert.deepEqual([first.facts.kept, first.facts.datedByQuote, first.facts.dateDropped, first.facts.datedByHeader], [1, 1, 0, 0], 'a date the model quoted is not said to come from the header');
  const old = assessPatient({ ...PATIENT, asOf: '2100-09-01' }, answer([fact({ ...supplement, occurredAt: '2100-01-10', dateQuote: 'Record date: 2100-01-10' })]));
  assert.equal(old.states['DIETSUPP-2MOS'], 'unknown', 'an older occurrence is dated, but does not prove no later occurrence within the window');
  assert.deepEqual([old.facts.kept, old.facts.datedByQuote], [1, 1], 'the original date remains grounded while later history stays incomplete');
  // A date no quotation prints is absent, not the reason the fact is refused: the fact stays, the window stays unknown.
  /** @param {ReturnType<typeof assessPatient>} result @param {string} label */
  const byHeader = (result, label) => {
    assert.deepEqual([result.facts.kept, result.facts.dateDropped, result.facts.dropped.date_not_in_span ?? 0, result.facts.datedByHeader], [1, 1, 0, 1], label);
    assert.equal(result.states['DIETSUPP-2MOS'], 'satisfied', label);
  };
  byHeader(assessPatient(PATIENT, answer([fact({ ...supplement, occurredAt: '2100-01-12' })])), 'the date alone, printed nowhere the fact points to');
  byHeader(assessPatient(PATIENT, answer([fact({ ...supplement, occurredAt: '2100-02-01', dateQuote: 'Record date: 2100-01-10' })])), 'a second quotation that prints another date');
  byHeader(assessPatient({ ...PATIENT, text: `${NOTE}\nSeen 3/14 for review.` }, answer([fact({ ...supplement, occurredAt: '2100-03-14', dateQuote: 'Seen 3/14 for review.' })])), 'a date with no year');
  const absent = assessPatient(PATIENT, answer([fact({ ...supplement, occurredAt: '2100-02-01', dateQuote: 'Record date: 2100-02-01' })]));
  byHeader(absent, 'a second quotation the file does not hold');
  assert.equal(absent.facts.dateQuoteUnfound, 1);
  assert.equal(assessPatient(PATIENT, answer([fact({ ...supplement })])).states['DIETSUPP-2MOS'], 'satisfied', 'no date written: the header dates it');
  // The same fact in a file with no header above it stays undated, and the window stays unknown.
  const bare = { ...PATIENT, text: 'Takes a multivitamin every morning.\n\nRecord date: 2100-03-01\n' };
  const undated = assessPatient(bare, answer([fact({ ...supplement, occurredAt: '2100-01-12' })]));
  assert.deepEqual([undated.states['DIETSUPP-2MOS'], undated.reasons['DIETSUPP-2MOS'], undated.facts.datedByHeader], ['unknown', 'undated', 0]);
  // Where no date is asked for, the same fact counts.
  const presence = assessPatient(PATIENT, answer([fact({ variable: 'drug_abuse', surface: 'illicit drug use', quote: 'He drinks no alcohol. Denies illicit drug use.', polarity: 'negated', occurredAt: '2081-01-01' })]));
  assert.deepEqual([presence.states['DRUG-ABUSE'], presence.facts.dateDropped], ['not_satisfied', 1]);
});

test('two of four parts make advanced CAD, and one part with the rest unknown does not', () => {
  const infarction = fact({ variable: 'myocardial_infarction', surface: 'myocardial infarction', quote: 'Admitted with myocardial infarction on 2100-02-20 and chest pain on exertion.' });
  const angina = fact({ variable: 'current_angina', surface: 'chest pain on exertion', quote: 'Admitted with myocardial infarction on 2100-02-20 and chest pain on exertion.' });
  assert.equal(assessPatient(PATIENT, answer([infarction, angina])).states['ADVANCED-CAD'], 'satisfied');
  assert.equal(assessPatient(PATIENT, answer([infarction])).states['ADVANCED-CAD'], 'unknown');
  const denied = (/** @type {string} */ variable) => fact({ variable, polarity: 'negated', surface: 'Denies illicit drug use', quote: 'He drinks no alcohol. Denies illicit drug use.' });
  const three = assessPatient(PATIENT, answer([denied('myocardial_infarction'), denied('current_angina'), denied('ischemia')], [
    { criterionKey: 'cad_two_or_more_medications', state: 'not_satisfied', evidence: [{ quote: 'Takes aspirin 81 mg daily to prevent heart attack.' }] }]));
  assert.equal(three.states['ADVANCED-CAD'], 'not_satisfied', 'all four parts known not to hold');
  assert.equal(three.decidedBy['ADVANCED-CAD'], 'model', 'a criterion with a language part is decided by the model and the evaluator together');
});

test('a language answer needs a quotation that is in the note; without one it is unknown', () => {
  const quote = 'Speaks English fluently and decides about his care himself.';
  const result = assessPatient(PATIENT, answer([], [
    { criterionKey: 'speaks_english', state: 'satisfied', evidence: [{ quote }] },
    { criterionKey: 'makes_own_medical_decisions', state: 'satisfied', evidence: [{ quote: 'Is capable of making decisions.' }] },
    { criterionKey: 'serum_creatinine_above_upper_limit_of_normal', state: 'satisfied', evidence: [] },
    { criterionKey: 'not_asked', state: 'satisfied', evidence: [{ quote }] },
  ]));
  assert.equal(result.states.ENGLISH, 'satisfied');
  assert.equal(result.states['MAKES-DECISIONS'], 'unknown');
  assert.equal(result.states.CREATININE, 'unknown');
  assert.equal(result.facts.dropped.language_quote_not_found, 1);
  assert.equal(result.facts.dropped.language_answer_without_evidence, 2);
  assert.equal(result.facts.dropped.language_key_not_asked, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------------------------------------------------------

const allGold = (/** @type {'met' | 'not met'} */ label) => Object.fromEntries(TAGS.map((tag) => [tag, label]));
const allStates = (/** @type {string} */ state) => Object.fromEntries(TAGS.map((tag) => [tag, state]));

test('the three readings of unknown are fixed: wrong, not met, and met only where the guide says silence means met', () => {
  const states = { ...allStates('unknown'), ABDOMINAL: 'satisfied' };
  const counts = sumCounts([patientCounts(states, allGold('met')), patientCounts(states, allGold('not met'))]);
  const s = statistics(counts);
  assert.equal(s['ABDOMINAL.accuracyA'], 0.5);
  assert.equal(s['ABDOMINAL.metToNotMetExplicit'], 0);
  assert.equal(s['ABDOMINAL.notMetToMet'], 1);
  assert.equal(s['DRUG-ABUSE.accuracyA'], 0, 'unknown is wrong and stays in the denominator');
  assert.equal(s['DRUG-ABUSE.unknownShare'], 1);
  assert.equal(s['DRUG-ABUSE.accuracyB'], 0.5, 'unknown read as not met is right for the not-met patient only');
  assert.equal(s['DRUG-ABUSE.metToNotMetExplicit'], 0, 'the system never said not satisfied');
  assert.equal(s['DRUG-ABUSE.metToNotMetB'], 1, 'but read as not met it misses the met patient');
  assert.equal(s['ENGLISH.accuracyC'], 0.5);
  assert.equal(s['ENGLISH.notMetToMetC'], 1, 'for ENGLISH an unknown is met, so the not-met patient is a false met');
  assert.equal(s['DRUG-ABUSE.notMetToMetC'], 0);
  assert.equal(s['ALL.n'], 26);
  assert.deepEqual(labelsFor({ ...allStates('unknown') }, 'b'), allGold('not met'));
  assert.deepEqual(labelsFor({ ...allStates('unknown') }, 'c'), { ...allGold('not met'), ENGLISH: 'met', 'MAKES-DECISIONS': 'met' });
  assert.equal(labelsFor(allStates('satisfied'), 'b').HBA1C, 'met');
});

test('F1 is the official scorer\'s: the mean of the F1 of met and of not met, zero where a ratio has no denominator', () => {
  // ABDOMINAL: three patients predicted met (two right), one gold-met patient missed, two right rejections.
  const gold = ['met', 'met', 'met', 'not met', 'not met', 'not met'];
  const pred = ['satisfied', 'satisfied', 'not_satisfied', 'satisfied', 'not_satisfied', 'not_satisfied'];
  const patients = gold.map((label, i) => patientCounts({ ...allStates('not_satisfied'), ABDOMINAL: pred[i] }, { ...allGold('not met'), ABDOMINAL: label }));
  const s = statistics(sumCounts(patients));
  const f1 = (/** @type {number} */ tp, /** @type {number} */ fp, /** @type {number} */ fn) => (2 * tp) / (2 * tp + fp + fn);
  assert.ok(Math.abs(s['ABDOMINAL.f1B'] - (f1(2, 1, 1) + f1(2, 1, 1)) / 2) < 1e-12);
  // DIETSUPP-2MOS has no met patient and none predicted: both met-class ratios are undefined, which the scorer reads as zero.
  assert.equal(statistics(sumCounts(patients))['DIETSUPP-2MOS.f1B'], 0.5);
});

test('the bootstrap resamples whole patients, is repeatable, and brackets the point estimate', () => {
  const next = randomStream(7);
  const patients = Array.from({ length: 30 }, () => patientCounts(
    Object.fromEntries(TAGS.map((tag) => [tag, next() < 0.4 ? 'unknown' : next() < 0.5 ? 'satisfied' : 'not_satisfied'])),
    Object.fromEntries(TAGS.map((tag) => [tag, next() < 0.3 ? 'met' : 'not met']))));
  const one = summarize(patients, { resamples: 200, seed: 11 });
  const two = summarize(patients, { resamples: 200, seed: 11 });
  assert.deepEqual(one, two);
  for (const name of ['ALL.accuracyA', 'ALL.accuracyB', 'ALL.unknownShare', 'ALL.f1MicroB']) {
    const { value, low, high } = one[name];
    assert.ok(low !== null && high !== null && value !== null);
    assert.ok(low <= value + 0.05 && high >= value - 0.05 && low < high, `${name}: ${low} ${value} ${high}`);
    assert.ok(low >= 0 && high <= 1);
  }
  assert.notDeepEqual(summarize(patients, { resamples: 200, seed: 12 })['ALL.accuracyA'], one['ALL.accuracyA']);
});

test('a paired comparison resamples the same patients on both sides: no change reads as zero, a real one has an interval that excludes it', () => {
  const next = randomStream(5);
  const gold = Array.from({ length: 60 }, () => Object.fromEntries(TAGS.map((tag) => [tag, next() < 0.4 ? 'met' : 'not met'])));
  const before = gold.map((label) => patientCounts(Object.fromEntries(TAGS.map((tag) => [tag, 'unknown'])), label));
  const same = summarizePaired(before, before, { resamples: 200, seed: 1 });
  assert.deepEqual([same['ALL.accuracyA'].value, same['ALL.accuracyA'].low, same['ALL.accuracyA'].high], [0, 0, 0]);
  const after = gold.map((label) => patientCounts(Object.fromEntries(TAGS.map((tag) => [tag, label[tag] === 'met' ? 'satisfied' : 'not_satisfied'])), label));
  const better = summarizePaired(after, before, { resamples: 200, seed: 1 });
  assert.equal(better['ALL.accuracyA'].value, 1);
  assert.equal(better['ALL.unknownShare'].value, -1);
  assert.ok((better['ALL.accuracyA'].low ?? 0) > 0.9);
  assert.throws(() => summarizePaired(after, before.slice(1)), /same patients/);
});

test('the majority baseline predicts the class most training patients have, and ignores the note', () => {
  const train = [allGold('met'), allGold('met'), allGold('not met')];
  assert.deepEqual(majorityStates(train), allStates('satisfied'));
  assert.deepEqual(majorityStates([allGold('met'), allGold('not met')]), allStates('not_satisfied'), 'a tie goes to not met');
});

test('the scorer\'s printed table is read into numbers', () => {
  const table = [
    '******************************************* TRACK 1 ********************************************',
    '           Abdominal  0.6167  0.6916  0.7459  0.6520    0.8036  0.7459  0.7736    0.7128  0.7187',
    '     Overall (micro)  0.6952  0.7546  0.7493  0.7237    0.8012  0.7493  0.7744    0.7490  0.7520',
    '     Overall (macro)  0.5855  0.7749  0.7529  0.5931    0.7192  0.7529  0.6950    0.6440  0.7639',
    '                      288 files found', '',
  ].join('\n');
  const parsed = parseScorerOutput(table);
  assert.equal(parsed.files, 288);
  assert.equal(parsed.micro?.overallF1, 0.749);
  assert.equal(parsed.macro?.overallF1, 0.644);
  assert.equal(parsed.perCriterion.ABDOMINAL, 0.7128);
});

// ---------------------------------------------------------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------------------------------------------------------

const KEY = ['s', 'k-test-0123456789abcdef'].join('');
const reply = (/** @type {any} */ content, /** @type {Record<string, any>} */ extra = {}) => new Response(JSON.stringify({ model: 'deepseek-flash',
  choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop', ...extra }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 } }), { status: 200 });

test('the client sends only the key and the body, strips the key from errors, prices at the reference list, and bounds retries and budget', async () => {
  /** @type {any[]} */
  const seen = [];
  const sleep = async () => {};
  const ok = createDeepSeek({ key: KEY, sleep, fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => { seen.push({ url, init }); return reply({ facts: [] }); }) });
  const result = await ok.ask({ system: 's', user: 'u', label: 't' });
  assert.deepEqual(Object.keys(seen[0].init.headers).sort(), ['authorization', 'content-type'], 'no identity header of any kind');
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual({ model: body.model, temperature: body.temperature, thinking: body.thinking, format: body.response_format }, { model: 'deepseek-v4-flash', temperature: 0, thinking: { type: 'disabled' }, format: { type: 'json_object' } });
  assert.equal(result.cost, priceUsage({ resourceType: 'model', model: 'deepseek-v4-flash', cacheHit: 400, cacheMiss: 600, output: 200, peak: true }).cost);
  assert.equal(result.cost, priceOf({ cacheHit: 400, cacheMiss: 600, completionTokens: 200 }).cost);

  let attempts = 0;
  const leaking = createDeepSeek({ key: KEY, sleep, retries: 2, fetchImpl: /** @type {any} */ (async () => { attempts += 1; throw new Error(`socket closed for Bearer ${KEY}`); }) });
  await assert.rejects(leaking.ask({ system: 's', user: 'u', label: 't' }), (error) => {
    assert.ok(error instanceof Error && !error.message.includes(KEY) && !error.message.includes('0123456789'), error.message);
    return true;
  });
  assert.equal(attempts, 3, 'one try and two retries, then it gives up');
  const rejected = createDeepSeek({ key: KEY, sleep, fetchImpl: /** @type {any} */ (async () => new Response(`bad key ${KEY}`, { status: 401 })) });
  await assert.rejects(rejected.ask({ system: 's', user: 'u', label: 't' }), (error) => !(/** @type {Error} */ (error)).message.includes(KEY) && /401/.test((/** @type {Error} */ (error)).message));
  assert.equal(redact(`x ${KEY} y ${['s', 'k-abcdefghijkl'].join('')}`, KEY), 'x [redacted] y [redacted]');

  const unreadable = createDeepSeek({ key: KEY, sleep, retries: 2, fetchImpl: /** @type {any} */ (async () => reply('{"facts": [ "broken')) });
  const bad = await unreadable.ask({ system: 's', user: 'u', label: 't' });
  assert.equal(bad.unreadable, true);
  assert.equal(bad.answer, null);
  assert.equal(bad.attempts, 2, 'an unreadable answer is tried once more and then it is the patient\'s result');

  const poor = createDeepSeek({ key: KEY, sleep, budget: 0.05, fetchImpl: /** @type {any} */ (async () => reply({})) });
  await assert.rejects(poor.ask({ system: 's', user: 'u', label: 't' }), BudgetExceeded);
});

// ---------------------------------------------------------------------------------------------------------------------------
// the seal
// ---------------------------------------------------------------------------------------------------------------------------

test('only gold.mjs knows where the sealed gold is, and the runner imports it nowhere but in score-test', async () => {
  const files = (await readdir(here)).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'));
  const knowing = [];
  for (const name of files) if (/['"`]sealed['"`]/.test(await readFile(path.join(here, name), 'utf8'))) knowing.push(name);
  assert.deepEqual(knowing, ['gold.mjs']);
  const runner = await readFile(path.join(here, 'run_n2c2.mjs'), 'utf8');
  assert.doesNotMatch(runner, /from '\.\/gold\.mjs'/, 'no static import');
  assert.equal([...runner.matchAll(/import\('\.\/gold\.mjs'\)/g)].length, 1, 'one dynamic import');
  const scoring = runner.slice(runner.indexOf('export async function scoreTest'), runner.indexOf('async function main'));
  assert.ok(scoring.includes("import('./gold.mjs')"), 'and it is inside scoreTest');
});

test('score-heldout refuses a run that was never predicted, and never reaches for the sealed gold', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'n2c2-test-'));
  try {
    await assert.rejects(scoreHeldout({ root: scratch, run: 'never-predicted' }), /FROZEN-2|Frozen files|No predictions/);
    await assert.rejects(scoreHeldout({ root: scratch, run: 'never-predicted', manifest: 3 }), /FROZEN-3|Frozen files|No predictions/);
    const names = { controlRun: 'c', secondRun: 's', previousRun: 'p', priorReplayRun: 'r', replayRun: 'y', literalRun: 'l' };
    await assert.rejects(scoreHeldoutFourth({ root: scratch, run: 'never-predicted', ...names }), /FROZEN-4|Frozen files|No predictions|is not the run the fourth manifest names/);
    assert.equal(existsSync(path.join(scratch, 'sealed')), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const runner = await readFile(path.join(here, 'run_n2c2.mjs'), 'utf8');
  const held = runner.slice(runner.indexOf('export async function scoreHeldout'), runner.indexOf('async function main'));
  assert.doesNotMatch(held, /gold\.mjs|openSealedGold|sealedDigest/, 'the held-out patients are unsealed training patients and the sealed archive is not their business');
});

test('the literal ruling only reads answers again: it is refused without a run whose answers it reads, and never calls the model', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'n2c2-test-'));
  try {
    await assert.rejects(predict({ split: 'dev', run: 'literal', root: scratch, pastGuard: false }), /--no-past-guard|reuse-run/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('score-test refuses a run that was never predicted, before it looks at any gold', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'n2c2-test-'));
  try {
    await assert.rejects(scoreTest({ root: scratch, run: 'never-predicted' }), /FROZEN|Frozen files|No predictions/);
    assert.equal(existsSync(path.join(scratch, 'sealed')), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// with the local data (skipped when it is not unpacked)
// ---------------------------------------------------------------------------------------------------------------------------

test('the training and test files are the 202 and 86 the task says, every file has a record date, and the split is forty of the training patients', { skip: !haveData && 'the n2c2 data are not unpacked here' }, async () => {
  const paths = dataPaths(root);
  const train = await patientIds(paths.trainDir);
  const test_ = await patientIds(paths.testDir);
  assert.equal(train.length, 202);
  assert.equal(test_.length, 86);
  assert.equal(train.filter((id) => test_.includes(id)).length, 0, 'no patient is in both');
  for (const id of [...train.slice(0, 20), ...test_.slice(0, 20)]) assert.ok((await readPatient(path.join(paths.root, 'work', train.includes(id) ? 'train/train' : 'test/test_notags'), id)).asOf, id);
  const dev = developmentIds(train);
  assert.equal(dev.length, 40);
  assert.ok(dev.every((id) => train.includes(id)));
  // The second measurement's patients are the other 162: none of them was used to tune, and together with the 40 they are the training set.
  const heldout = train.filter((id) => !dev.includes(id));
  assert.equal(heldout.length, 162);
  assert.deepEqual([...heldout, ...dev].sort(), [...train].sort());
});

test('my F1 equals the official scorer\'s on made-up predictions against real gold files', { skip: (!haveData || !existsSync(dataPaths(root).scorer)) && 'the n2c2 data or scorer are not here' }, async () => {
  const paths = dataPaths(root);
  const dev = developmentIds(await patientIds(paths.trainDir)).slice(0, 12);
  const gold = await mkdtemp(path.join(os.tmpdir(), 'n2c2-g-'));
  const system = await mkdtemp(path.join(os.tmpdir(), 'n2c2-s-'));
  try {
    const next = randomStream(3);
    /** @type {any[]} */
    const counts = [];
    for (const id of dev) {
      const patient = await readPatient(paths.trainDir, id);
      const labels = Object.fromEntries(TAGS.map((tag) => [tag, next() < 0.5 ? 'met' : 'not met']));
      const states = Object.fromEntries(TAGS.map((tag) => [tag, next() < 0.3 ? 'unknown' : next() < 0.5 ? 'satisfied' : 'not_satisfied']));
      counts.push(patientCounts(states, /** @type {any} */ (patient.tags)));
      await writeFile(path.join(gold, `${id}.xml`), await readFile(path.join(paths.trainDir, `${id}.xml`), 'utf8'));
      const body = TAGS.map((tag) => `<${tag} met="${labelsFor(/** @type {any} */ (states), 'b')[tag]}" />`).join('');
      await writeFile(path.join(system, `${id}.xml`), `<PatientMatching><TAGS>${body}</TAGS></PatientMatching>`);
    }
    const ran = spawnSync('python3', ['-I', path.join(here, 'run_official_scorer.py'), paths.scorer, gold, system], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    const official = parseScorerOutput(ran.stdout);
    const mine = statistics(sumCounts(counts));
    assert.ok(Math.abs((official.micro?.overallF1 ?? NaN) - mine['ALL.f1MicroB']) < 6e-5, `${official.micro?.overallF1} vs ${mine['ALL.f1MicroB']}`);
    assert.ok(Math.abs((official.macro?.overallF1 ?? NaN) - mine['ALL.f1MacroB']) < 6e-5);
    for (const tag of TAGS) assert.ok(Math.abs((official.perCriterion[tag] ?? NaN) - mine[`${tag}.f1B`]) < 6e-5, tag);
  } finally {
    await rm(gold, { recursive: true, force: true });
    await rm(system, { recursive: true, force: true });
  }
});
