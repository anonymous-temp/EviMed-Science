// Tests of the n2c2 evaluation's shared files (criteria, data): the boards in evals/vcr-matching-boards read them.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ABSENT_MEANS_MET, CRITERIA, LANGUAGE_CRITERIA, TAGS, VARIABLES, criteriaIssues, languageKeysOf, variablesOf } from './criteria.mjs';
import { dataAvailable, dataPaths, dataRoot, developmentIds, evaluationDate, idsDigest, parsePatientXml, patientIds, readPatient, recordDates } from './data.mjs';

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

test('the thirteen criteria are in the official order, accepted by the grammar, and their variables and language keys are the ones the criteria name', () => {
  assert.equal(TAGS.length, 13);
  assert.deepEqual(CRITERIA.map((item) => item.tag), [...TAGS]);
  assert.deepEqual(criteriaIssues(), [], 'every requirement is one the platform would accept');
  assert.deepEqual([...variablesOf()].sort(), Object.keys(VARIABLES).sort());
  assert.deepEqual([...languageKeysOf()].sort(), Object.keys(LANGUAGE_CRITERIA).sort());
  assert.deepEqual([...ABSENT_MEANS_MET], ['ENGLISH', 'MAKES-DECISIONS']);
  assert.ok(CRITERIA.every((item) => item.kind === 'inclusion' && item.sourceText.length > 10));
});

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
