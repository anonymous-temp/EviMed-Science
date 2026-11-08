import assert from 'node:assert/strict';
import { test } from 'node:test';
import { segmentSentences } from '@evimed/domain';
import { buildRecordIndex, chunkPassages, denseChunkRanking, headingOf, initialEvidenceIds, LruCache, recordDateOf, searchRecordIndex, sentenceContexts, stem, tokenize } from '../src/patientMatchingRecordIndex.mjs';

function passagesOf(records) {
  const out = [];
  records.forEach((text, r) => {
    const record = { text, sentences: segmentSentences(text) };
    const contexts = sentenceContexts(record, r + 1);
    record.sentences.forEach((sentence, s) => out.push({ evidenceId: `e:${r + 1}.${s + 1}`, text: sentence.text, ...contexts[s] }));
  });
  return out;
}

test('record dates are read by format from the first lines only', () => {
  assert.equal(recordDateOf('Record date: 2093-04-07\nbody'), '2093-04-07');
  assert.equal(recordDateOf('Seen 2091/3/9 in clinic'), '2091-03-09');
  assert.equal(recordDateOf('Visit 12/25/2080'), '2080-12-25');
  assert.equal(recordDateOf('Datum 07.04.2093'), '2093-04-07');
  assert.equal(recordDateOf('Note\n\nno date here'), null);
  assert.equal(recordDateOf('a\nb\nc\nd\ne\nDate 2090-01-01'), null, 'beyond the first five lines');
  assert.equal(recordDateOf('Date 2090-13-45'), null, 'not a calendar date');
});

test('headings are short lines ending in a colon or in upper case', () => {
  assert.equal(headingOf('Family history:'), 'Family history');
  assert.equal(headingOf('HISTORY OF PRESENT ILLNESS'), 'HISTORY OF PRESENT ILLNESS');
  assert.equal(headingOf('The patient reports chest pain.'), null);
  assert.equal(headingOf(`${'x'.repeat(61)}:`), null);
  assert.equal(headingOf('123 - 456'), null, 'no letters');
});

test('sentences carry record index, date and nearest preceding heading', () => {
  const [one, two] = [passagesOf(['Record date: 2093-04-07\nFAMILY HISTORY:\nFather had a myocardial infarction.\nPast medical history:\nHypertension.', 'Second record without date.'])].map(list => list);
  assert.equal(one.find(item => /Father/.test(item.text)).section, 'FAMILY HISTORY');
  assert.equal(one.find(item => /Hypertension/.test(item.text)).section, 'Past medical history');
  assert.ok(one.filter(item => item.recordIndex === 1).every(item => item.recordDate === '2093-04-07'));
  const last = one[one.length - 1];
  assert.equal(last.recordIndex, 2); assert.equal(last.recordDate, null); assert.equal(last.section, null);
  assert.equal(two, undefined);
});

test('chunks stay inside one record, near the size limit, and prefer section changes', () => {
  const sentence = n => ({ evidenceId: `e:1.${n}`, text: `Sentence ${n} ${'x'.repeat(200)}.`, recordIndex: 1, section: n <= 8 ? 'A' : 'B' });
  const list = Array.from({ length: 30 }, (_, i) => sentence(i + 1));
  const chunks = chunkPassages(list, 1000);
  assert.ok(chunks.every(chunk => chunk.text.length <= 1000));
  assert.deepEqual(chunks.flatMap(chunk => chunk.evidenceIds), list.map(item => item.evidenceId));
  const other = [...list.slice(0, 2), { evidenceId: 'e:2.1', text: 'Next record.', recordIndex: 2 }];
  const crossed = chunkPassages(other);
  assert.equal(crossed.length, 2); assert.equal(crossed[1].recordIndex, 2);
  // a section change cuts a chunk that already holds enough
  const sectioned = chunkPassages([{ evidenceId: 'e:1.1', text: 'a'.repeat(1600), recordIndex: 1, section: 'A' }, { evidenceId: 'e:1.2', text: 'b'.repeat(100), recordIndex: 1, section: 'B' }]);
  assert.equal(sectioned.length, 2);
  assert.equal(sectioned[0].chunkId, 'c:1.1');
});

test('stemming folds plurals, -ing and -ed; CJK runs become bigrams', () => {
  assert.equal(stem('infarctions'), stem('infarction'));
  assert.equal(stem('smoking'), stem('smoked'));
  assert.equal(stem('smoke'), stem('smoking'));
  assert.equal(stem('diseases'), stem('disease'));
  assert.equal(stem('boxes'), 'box');
  assert.equal(stem('studies'), 'study');
  assert.equal(stem('mi'), 'mi'); assert.equal(stem('2093'), '2093');
  assert.deepEqual(tokenize('心肌梗死 MI'), ['心肌', '肌梗', '梗死', 'mi']);
  assert.deepEqual(tokenize('心'), ['心']);
  assert.deepEqual(tokenize('Heart-attack, 2 stents'), ['heart', 'attack', '2', 'stent']);
});

test('search fuses the queries by reciprocal rank and returns nothing when nothing matches', () => {
  const index = buildRecordIndex(passagesOf(['Heart attack in 2088 treated with stenting.\nPatient likes tea.\nSTEMI admission, troponin raised.\nAsthma controlled.']));
  const hits = searchRecordIndex(index, ['myocardial infarction', 'STEMI', 'heart attack']);
  assert.deepEqual(hits.map(item => item.text).sort(), ['Heart attack in 2088 treated with stenting.', 'STEMI admission, troponin raised.']);
  assert.deepEqual(searchRecordIndex(index, ['quantum chromodynamics']), []);
  assert.deepEqual(searchRecordIndex(index, []), []);
  assert.equal(searchRecordIndex(index, ['heart attack', 'stemi'], { limit: 1 }).length, 1);
  const chunks = searchRecordIndex(index, ['stemi'], { unit: 'chunk' });
  assert.equal(chunks.length, 1); assert.ok(chunks[0].evidenceIds.length >= 3);
  assert.deepEqual(searchRecordIndex(index, ['heart attack']), searchRecordIndex(index, ['heart attack']), 'deterministic');
});

test('ties keep stored order', () => {
  const index = buildRecordIndex([{ evidenceId: 'e:1.1', text: 'aspirin daily' }, { evidenceId: 'e:1.2', text: 'aspirin daily' }]);
  assert.deepEqual(searchRecordIndex(index, ['aspirin']).map(item => item.evidenceId), ['e:1.1', 'e:1.2']);
});

test('the initial window keeps the newest records and retrieves per criterion from older ones within the cap', () => {
  const records = [];
  records.push('Record date: 2080-01-01\nPAST HISTORY:\nPrior myocardial infarction with stent placement.');
  for (let i = 0; i < 40; i++) records.push(`Record date: 2085-01-${String((i % 28) + 1).padStart(2, '0')}\nFiller visit ${i} ${'unrelated routine text. '.repeat(80)}`);
  records.push('Record date: 2093-01-01\nNewest visit.');
  const index = buildRecordIndex(passagesOf(records));
  const { window, retrieved } = initialEvidenceIds(index, ['Prior myocardial infarction', 'Prior revascularisation'], { windowCharacters: 5000, retrievedCharacters: 3000 });
  assert.ok(window.has(index.passages.at(-1).evidenceId));
  assert.ok(!window.has('e:1.2'));
  assert.ok(retrieved.has('e:1.2'), 'the old record is reached by criterion text');
  assert.ok([...retrieved].every(id => !window.has(id)));
  const size = [...retrieved].reduce((sum, id) => sum + index.passages.find(item => item.evidenceId === id).text.length, 0);
  assert.ok(size <= 3000);
  assert.deepEqual(initialEvidenceIds(index, ['Prior myocardial infarction', 'Prior revascularisation'], { windowCharacters: 5000, retrievedCharacters: 3000 }), { window, retrieved }, 'same inputs, same bundle');
  const whole = initialEvidenceIds(index, ['x'], { windowCharacters: 10_000_000 });
  assert.equal(whole.retrieved.size, 0);
});

test('the dense channel embeds chunks once per index and ranks by cosine', async () => {
  const index = buildRecordIndex(passagesOf(['Alpha beta.\nGamma delta.']));
  let calls = 0;
  const embed = async texts => { calls++; return texts.map(text => (/alpha/i.test(text) ? [1, 0] : [0, 1])); };
  assert.deepEqual(await denseChunkRanking(index, ['alpha'], embed), [0]);
  await denseChunkRanking(index, ['alpha'], embed);
  assert.equal(calls, 3, 'chunks embedded once, queries twice');
});

test('the LRU keeps its capacity and the most recently used entry', () => {
  const cache = new LruCache(2);
  cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), 1); assert.equal(cache.get('c'), 3);
});
