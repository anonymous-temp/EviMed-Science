// Judging a patient against a trial's eligibility text: where sentences and clauses are, what a model's answer is once code has read
// it, and what a person is shown. Nothing here calls a model.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  VCR_CRITERION_LABELS, VCR_FIT_BANDS, criteriaMessages, criterionDisplay, fitMessages, mergeCriteriaAnswers, mergeFitAnswers, parseCriteriaAnswer, parseFitAnswer,
  rankJudgments, reasonList, segmentCriteria, segmentSentences, splitNoteParts, trialVerdict,
} from '../index.mjs'

/** @param {string} text @param {Array<{ text: string, start: number, end: number }>} rows */
const holds = (text, rows) => { for (const row of rows) assert.equal(text.slice(row.start, row.end), row.text) }

test('sentences are numbered from 0 and hold their own place in the original, Chinese and English', () => {
  const note = '患者男，62岁。诊断为肺腺癌！未见转移？\nECOG 1\n\nEGFR L858R positive. No prior therapy.  \r\nNo pregnancy'
  const sentences = segmentSentences(note)
  holds(note, sentences)
  assert.deepEqual(sentences.map((row) => row.id), sentences.map((_, index) => index))
  assert.deepEqual(sentences.map((row) => row.text), ['患者男，62岁。', '诊断为肺腺癌！', '未见转移？', 'ECOG 1', 'EGFR L858R positive.', 'No prior therapy.', 'No pregnancy'])
})

test('a line break separates sentences, an empty note has none, and a locale can be named', () => {
  assert.deepEqual(segmentSentences('BP 120/80\nHR 72').map((row) => row.text), ['BP 120/80', 'HR 72'])
  assert.deepEqual(segmentSentences(''), [])
  assert.deepEqual(segmentSentences(null), [])
  assert.deepEqual(segmentSentences('  \n \n'), [])
  assert.equal(segmentSentences('A b. C d.', { locale: 'en' }).length, 2)
})

test('clauses: sections, bullets and what is under a bullet, with exact offsets', () => {
  const text = 'Inclusion Criteria:\n\n* Age >= 18 years\n* Adequate organ function, defined as:\n\n  * ANC >= 1500/uL\n  * Hemoglobin >= 9 g/dL\n* Signed consent\n\nExclusion Criteria:\n\n* Pregnancy\n* E. coli bacteremia'
  const clauses = segmentCriteria(text)
  holds(text, clauses)
  assert.deepEqual(clauses.map((row) => [row.number, row.kind]), [[1, 'inclusion'], [2, 'inclusion'], [3, 'inclusion'], [4, 'exclusion'], [5, 'exclusion']])
  assert.match(clauses[1].text, /defined as:[\s\S]*ANC[\s\S]*Hemoglobin/, 'a list stays with the words that introduce it')
  assert.equal(clauses[4].text, 'E. coli bacteremia', 'an abbreviation is no marker: the clause keeps its first word')
})

test('clauses: Chinese headings, numbered lines and a list written on one line', () => {
  const lines = '入选标准：\n1、年龄≥18岁；\n2、经组织学确诊的非小细胞肺癌；\n排除标准：\n1、妊娠或哺乳期妇女；\n2、严重肝肾功能不全。'
  const first = segmentCriteria(lines)
  holds(lines, first)
  assert.deepEqual(first.map((row) => [row.kind, row.text]), [['inclusion', '年龄≥18岁；'], ['inclusion', '经组织学确诊的非小细胞肺癌；'], ['exclusion', '妊娠或哺乳期妇女；'], ['exclusion', '严重肝肾功能不全。']])
  const oneLine = '纳入标准：1、年龄18-75岁；2、确诊2型糖尿病；3、HbA1c 7.0%-10.0%。排除标准：1、1型糖尿病；2、妊娠。'
  const second = segmentCriteria(oneLine)
  holds(oneLine, second)
  assert.deepEqual(second.map((row) => [row.kind, row.text]), [['inclusion', '年龄18-75岁；'], ['inclusion', '确诊2型糖尿病；'], ['inclusion', 'HbA1c 7.0%-10.0%。'], ['exclusion', '1型糖尿病；'], ['exclusion', '妊娠。']])
})

test('clauses: key sections and a nested list under a numbered one', () => {
  const text = 'Key Inclusion Criteria:\n1. Age 18-75\n2. ECOG 0-1\n   a. measured at screening\n3. Signed consent\nKey Exclusion Criteria:\n1. Prior therapy\n2. HIV'
  assert.deepEqual(segmentCriteria(text).map((row) => [row.kind, row.text]), [['inclusion', 'Age 18-75'], ['inclusion', 'ECOG 0-1\n   a. measured at screening'],
    ['inclusion', 'Signed consent'], ['exclusion', 'Prior therapy'], ['exclusion', 'HIV']])
})

test('clauses: a text with no structure stays one, and blank lines divide it when they are all it has', () => {
  const paragraph = 'Patients with severe heart failure who are 18 or older and able to consent. Patients on dialysis are not eligible.'
  assert.deepEqual(segmentCriteria(paragraph).map((row) => [row.kind, row.text]), [['unsectioned', paragraph]])
  const wrapped = 'Patients with severe heart failure\nwho are 18 or older'
  assert.deepEqual(segmentCriteria(wrapped).map((row) => row.text), [wrapped], 'a line break alone divides nothing in an unsectioned text')
  assert.deepEqual(segmentCriteria('Age 18 or older\n\nDiagnosed with asthma').map((row) => [row.kind, row.text]), [['unsectioned', 'Age 18 or older'], ['unsectioned', 'Diagnosed with asthma']])
  assert.deepEqual(segmentCriteria(''), [])
  assert.deepEqual(segmentCriteria(' \n\n '), [])
})

test('clauses: a heading is no clause, and what a heading says of the items under it travels with them', () => {
  const text = 'DISEASE CHARACTERISTICS:\n\nHistologically confirmed breast cancer\n\nPATIENT CHARACTERISTICS:\n\nAge:\n\n  * 18 and over\n\nPRIOR CONCURRENT THERAPY:\n\n  * No prior chemotherapy'
  const clauses = segmentCriteria(text)
  assert.deepEqual(clauses.map((row) => [row.lead, row.text]), [['DISEASE CHARACTERISTICS:', 'Histologically confirmed breast cancer'], ['PATIENT CHARACTERISTICS: Age:', '18 and over'], ['PRIOR CONCURRENT THERAPY:', 'No prior chemotherapy']])
  const parts = segmentCriteria('Inclusion criteria for Part A:\n- Age > 18\nInclusion criteria for Part B:\n- Age > 12\nEligibility Criteria:\n- Consent')
  assert.deepEqual(parts.map((row) => [row.kind, row.lead ?? null, row.text]), [['inclusion', 'Inclusion criteria for Part A:', 'Age > 18'], ['inclusion', 'Inclusion criteria for Part B:', 'Age > 12'], ['inclusion', null, 'Consent']])
})

test('clauses: words that only look like a heading stay clauses, and a one-paragraph text finds its sections', () => {
  const text = 'Exclusion criteria:\n- Exclusion of brain metastases is required by MRI\n- Inclusion criteria are met only after screening'
  assert.deepEqual(segmentCriteria(text).map((row) => [row.kind, row.text]), [['exclusion', 'Exclusion of brain metastases is required by MRI'], ['exclusion', 'Inclusion criteria are met only after screening']])
  assert.deepEqual(segmentCriteria('Inclusion Criteria: Age >= 18, ECOG 0-1. Exclusion Criteria: pregnancy; active infection.').map((row) => [row.kind, row.text]),
    [['inclusion', 'Age >= 18, ECOG 0-1.'], ['exclusion', 'pregnancy; active infection.']])
})

test('clauses: the registry shapes of the criteria-parse cases keep every clause, on its own side', () => {
  const { cases } = JSON.parse(readFileSync(new URL('../../../evals/vcr-matching/criteria-parse/cases.json', import.meta.url), 'utf8'))
  assert.ok(cases.length > 30)
  for (const entry of cases) {
    const clauses = segmentCriteria(entry.text)
    holds(entry.text, clauses)
    for (const expected of entry.expected) {
      const clause = clauses.find((row) => row.text.includes(expected.sourceText))
      assert.ok(clause, `${entry.id}: ${expected.sourceText}`)
      assert.equal(clause.kind, expected.kind, `${entry.id}: ${expected.sourceText}`)
    }
  }
})

test('the fit prompt: the note comes before the trial, the method is carried and reasons follow the note', () => {
  const [system, user] = fitMessages({ title: 'T', summary: 'S', eligibility: 'Inclusion Criteria:\n* Age >= 18', note: 'NOTE TEXT' })
  assert.equal(system.role, 'system')
  assert.match(system.content, /well-documented patient note would omit it/)
  assert.match(system.content, /CLINICAL RELEVANCE WEIGHTING/)
  assert.match(system.content, /ASSUME-AT-SCREENING POLICY/)
  assert.match(system.content, /"confidence"/)
  assert.match(system.content, /language of the patient note/)
  assert.ok(user.content.indexOf('NOTE TEXT') < user.content.indexOf('Title: T'), 'the note leads, so the prefix cache holds across a patient\'s trials')
  const [, again] = fitMessages({ title: 'Other', summary: 'S2', eligibility: 'x', note: 'NOTE TEXT' })
  const prefix = 'Patient note/summary:\nNOTE TEXT'
  assert.ok(user.content.startsWith(prefix) && again.content.startsWith(prefix))
  const [, none] = fitMessages({ title: 'T', conditions: ['Asthma'], note: 'N' })
  assert.match(none.content, /carries none/)
  assert.match(none.content, /Target conditions: Asthma/)
})

test('the per-criterion prompt: numbered sentences, numbered clauses, the omission question and not applicable', () => {
  const criteria = segmentCriteria('Inclusion Criteria:\n* Age >= 18\nExclusion Criteria:\n* Pregnancy')
  const sentences = segmentSentences('78-year-old woman. Lung cancer.')
  const [system, user] = criteriaMessages({ title: 'T', summary: 'S', criteria, sentences })
  assert.match(system.content, /is it possible that a good patient note will miss such information/)
  assert.match(system.content, /where the patient does not meet the premise of the criterion/)
  assert.match(system.content, /"not excluded"/)
  assert.match(system.content, /"not included"/)
  assert.match(system.content, /language of the patient note/)
  assert.match(user.content, /^Here is the patient note/)
  assert.match(user.content, /0\. 78-year-old woman\./)
  assert.match(user.content, /1\. Age >= 18/)
  assert.match(user.content, /2\. Pregnancy/)
  const [systemOne, userOne] = criteriaMessages({ kind: 'exclusion', title: 'T', criteria, sentences })
  assert.doesNotMatch(systemOne.content, /"not included"/, 'one side asks one label set')
  assert.doesNotMatch(userOne.content, /Age >= 18/)
  assert.match(userOne.content, /2\. Pregnancy/)
})

test('a lead-in reaches the model with the clause it belongs to', () => {
  const criteria = segmentCriteria('Inclusion Criteria:\nCohort 2 must also have:\n* Prior surgery')
  assert.equal(criteria[0].lead, 'Cohort 2 must also have:')
  const [, user] = criteriaMessages({ criteria, sentences: [] })
  assert.match(user.content, /1\. Cohort 2 must also have: Prior surgery/)
})

test('a fit answer in the shapes models really write', () => {
  const plain = parseFitAnswer('{"score": 85, "confidence": 0.7, "eligible_reasons": "1. age fits 2. NSCLC confirmed", "ineligible_reasons": "", "missing_information": "1. ECOG", "rationale": "1. Good match"}')
  assert.deepEqual(plain, { fit: 85, confidence: 0.7, reasons: { eligible: ['age fits', 'NSCLC confirmed'], ineligible: [], missing: ['ECOG'], rationale: 'Good match' }, issues: [] })
  const fenced = parseFitAnswer('Here you go:\n```json\n{"score":"85","confidence":"80%","eligible_reasons":["a","b"],"missing_information":null,}\n```')
  assert.deepEqual([fenced.fit, fenced.confidence, fenced.reasons.eligible, fenced.reasons.missing], [85, 0.8, ['a', 'b'], []])
  assert.equal(parseFitAnswer({ score: '85/100', confidence: 80 }).confidence, 0.8)
  assert.equal(parseFitAnswer('words {"score": 12} after').fit, 12)
  assert.deepEqual(parseFitAnswer('{"score": 120}').issues, [{ code: 'fit_out_of_range' }])
  assert.equal(parseFitAnswer('{"score": 120}').fit, 100)
})

test('a fit answer that holds nothing is said to, and never throws', () => {
  for (const raw of ['', null, undefined, 'not json', '[]', 42]) {
    const parsed = parseFitAnswer(raw)
    assert.equal(parsed.fit, null)
    assert.deepEqual(parsed.issues, [{ code: 'answer_unreadable' }], String(raw))
  }
  assert.deepEqual(parseFitAnswer('{"eligible_reasons":"x"}').issues, [{ code: 'fit_missing' }])
  assert.deepEqual(parseFitAnswer('{"score":50,"confidence":"high"}').issues, [{ code: 'confidence_unreadable' }])
  assert.equal(parseFitAnswer('{"score":50,"confidence":"high"}').confidence, null)
})

test('reasons as lists, however they came', () => {
  assert.deepEqual(reasonList('1、年龄符合 2、确诊肺癌'), ['年龄符合', '确诊肺癌'])
  assert.deepEqual(reasonList('one reason'), ['one reason'])
  assert.deepEqual(reasonList(['a', ['b'], { x: 'c' }]), ['a', 'b', 'c'])
  assert.deepEqual(reasonList('N/A'), [])
  assert.deepEqual(reasonList('无'), [])
  assert.deepEqual(reasonList(null), [])
})

const NOTE = '男性，70 岁。肺腺癌 IV 期。ECOG 1。'
const TRIAL = 'Inclusion Criteria:\n* Age >= 18\n* Stage IV NSCLC\nExclusion Criteria:\n* Pregnancy\n* Brain metastases'
const context = () => ({ criteria: segmentCriteria(TRIAL), sentences: segmentSentences(NOTE).map((row) => ({ ...row, documentId: 'doc_1' })) })

test('evidence is resolved by code, from the ids to the exact source text and offsets', () => {
  const parsed = parseCriteriaAnswer('{"1":["年龄 70 岁",[0],"included"],"2":["肺腺癌 IV 期",[1],"included"],"3":["男性，不适用",[0],"not applicable"],"4":["未提及脑转移",[],"not excluded"]}', context())
  assert.deepEqual(parsed.missing, [])
  assert.equal(parsed.rows[0].basis, 'stated')
  assert.deepEqual(parsed.rows[0].evidence, [{ sentenceId: 0, text: '男性，70 岁。', start: 0, end: 8, documentId: 'doc_1' }])
  assert.equal(NOTE.slice(parsed.rows[0].evidence[0].start, parsed.rows[0].evidence[0].end), parsed.rows[0].evidence[0].text)
  assert.deepEqual([parsed.rows[3].label, parsed.rows[3].basis, parsed.rows[3].evidence], ['not_excluded', 'silent', []])
})

test('an id that does not exist is dropped and counted, and the label stands', () => {
  const parsed = parseCriteriaAnswer({ 1: ['x', [0, 99], 'included'], 2: ['y', [99], 'not included'] }, context())
  assert.equal(parsed.droppedSentenceIds, 2)
  assert.deepEqual(parsed.rows[0].sentenceIds, [0])
  assert.deepEqual([parsed.rows[1].label, parsed.rows[1].basis], ['not_included', 'silent'], 'the label stands; with nothing resolved it is silent')
  assert.ok(parsed.issues.some((issue) => issue.code === 'sentence_ids_dropped' && issue.count === 2))
})

test('a clause the model did not answer is missing, not guessed', () => {
  const parsed = parseCriteriaAnswer('{"1":["x",[0],"included"]}', context())
  assert.deepEqual(parsed.rows.map((row) => row.number), [1])
  assert.deepEqual(parsed.missing.map((row) => row.number), [2, 3, 4])
  const none = parseCriteriaAnswer('nonsense', context())
  assert.deepEqual(none.rows, [])
  assert.equal(none.missing.length, 4)
  assert.deepEqual(none.issues, [{ code: 'answer_unreadable' }])
})

test('adversarial answers: unknown labels and numbers, repeats, wrong types, words where ids belong', () => {
  const parsed = parseCriteriaAnswer(JSON.stringify({
    1: ['x', '0, 1', 'INCLUDED.'], 2: { reasoning: 'y', sentence_ids: ['1'], label: 'Not Enough Information' }, 3: ['z', 'none', 'maybe'], 4: 7, 77: ['q', [], 'included'], '4 ': ['r', [2], 'excluded'],
  }), context())
  assert.deepEqual(parsed.rows.map((row) => [row.number, row.label]), [[1, 'included'], [2, 'not_enough_information'], [4, 'excluded']], 'a key with stray spaces is read; a number where a row belongs answers nothing')
  assert.deepEqual(parsed.rows[0].sentenceIds, [0, 1], 'ids written as text are read')
  assert.deepEqual(parsed.missing.map((row) => row.number), [3])
  assert.ok(parsed.issues.some((issue) => issue.code === 'criterion_unknown' && issue.number === 77))
  assert.ok(parsed.issues.some((issue) => issue.code === 'label_unknown' && issue.number === 3))
  for (const raw of [[], {}, 'null', '[1,2,3]', '{"a":{"b":{}}}', [null, 0, 'x']]) assert.doesNotThrow(() => parseCriteriaAnswer(raw, context()))
})

test('answers as a list of rows, nested under a side, and the other side\'s label', () => {
  const listed = parseCriteriaAnswer([{ number: 1, reason: 'a', sentence_ids: [0], label: 'included' }, { criterion_number: '2', reason: 'b', ids: [], label: 'not included' }], context())
  assert.deepEqual(listed.rows.map((row) => [row.number, row.label]), [[1, 'included'], [2, 'not_included']])
  const nested = parseCriteriaAnswer({ inclusion: { 1: ['a', [0], 'included'] }, exclusion: { 3: ['b', [], 'not excluded'] } }, context())
  assert.deepEqual(nested.rows.map((row) => row.number), [1, 3])
  const other = parseCriteriaAnswer({ 3: ['met', [0], 'included'], 1: ['fine', [0], 'not excluded'] }, context())
  assert.deepEqual(other.rows.map((row) => [row.number, row.label]), [[1, 'included'], [3, 'excluded']], 'an exclusion that is met is an exclusion')
  assert.equal(other.issues.filter((issue) => issue.code === 'label_other_side').length, 2)
  assert.ok(VCR_CRITERION_LABELS.includes(other.rows[1].label))
})

test('a clause under no section keeps the label as written', () => {
  const criteria = segmentCriteria('Patients must not be pregnant.')
  const parsed = parseCriteriaAnswer({ 1: ['x', [], 'not excluded'] }, { criteria, sentences: [] })
  assert.deepEqual([parsed.rows[0].kind, parsed.rows[0].label], ['unsectioned', 'not_excluded'])
})

test('what a person reads names no internal term, and silence says it is silence', () => {
  assert.equal(criterionDisplay({ label: 'not_excluded', basis: 'silent' }), '未见记载，按未排除')
  assert.equal(criterionDisplay({ label: 'not_enough_information', basis: 'silent' }), '未见记载，需确认')
  assert.equal(criterionDisplay({ label: 'not_applicable', basis: 'silent' }), '不适用')
  assert.equal(criterionDisplay({ label: 'not_applicable', basis: 'stated' }), '不适用')
  assert.equal(criterionDisplay({ label: 'included', basis: 'stated' }), '符合')
  assert.equal(criterionDisplay({ label: 'not_included', basis: 'stated' }), '不符合')
  assert.equal(criterionDisplay({ label: 'excluded', basis: 'stated' }), '符合排除条件')
  assert.equal(criterionDisplay({ label: 'not_excluded', basis: 'stated' }), '未符合排除条件')
  assert.equal(criterionDisplay({ label: null }), '未判断')
  for (const label of VCR_CRITERION_LABELS) {
    for (const basis of ['stated', 'silent']) assert.doesNotMatch(criterionDisplay({ label, basis }), /[a-z_]/, `${label}/${basis}`)
  }
})

/** @param {string} label @param {string} basis */
const row = (label, basis, number = 1) => ({ label, basis, number })

test('a verdict: what the note states against the patient is ineligible, whatever the score', () => {
  const said = trialVerdict({ fit: 95, criteria: [row('included', 'stated', 1), row('excluded', 'stated', 2)] })
  assert.deepEqual([said.verdict, said.label, said.disqualifiers], ['ineligible', '不符合', [2]])
  assert.equal(trialVerdict({ fit: 95, criteria: [row('not_included', 'stated')] }).verdict, 'ineligible')
})

test('a verdict: silence does not block', () => {
  assert.equal(trialVerdict({ fit: 90, criteria: [row('included', 'stated'), row('not_excluded', 'silent')] }).verdict, 'eligible', 'a favourable judgement of silence resolves the clause')
  assert.equal(trialVerdict({ fit: 90, criteria: [row('included', 'stated'), row('not_enough_information', 'silent')] }).verdict, 'possible')
  assert.equal(trialVerdict({ fit: 90, criteria: [row('not_included', 'silent')] }).verdict, 'possible', 'silent against the patient is open, never a conflict')
  assert.equal(trialVerdict({ fit: 90, criteria: [row('excluded', 'silent')] }).verdict, 'possible')
  assert.equal(trialVerdict({ fit: 90, criteria: [row('included', 'stated')], missing: [{ number: 2 }] }).verdict, 'possible', 'a clause not answered is open')
  assert.equal(trialVerdict({ criteria: [row('not_applicable', 'silent')] }).verdict, 'eligible')
})

test('a verdict: an open prerequisite the score reads against is insufficient', () => {
  assert.equal(trialVerdict({ fit: 30, criteria: [row('not_enough_information', 'silent')] }).verdict, 'insufficient')
  assert.equal(trialVerdict({ fit: VCR_FIT_BANDS.possible, criteria: [row('not_enough_information', 'silent')] }).verdict, 'possible')
})

test('a verdict: the score alone uses its bands', () => {
  assert.equal(trialVerdict({ fit: 80 }).verdict, 'eligible')
  assert.equal(trialVerdict({ fit: 80, missingReasons: ['ECOG'] }).verdict, 'possible', 'to be confirmed at screening')
  assert.equal(trialVerdict({ fit: 79 }).verdict, 'possible')
  assert.equal(trialVerdict({ fit: 50 }).verdict, 'possible')
  assert.equal(trialVerdict({ fit: 49 }).verdict, 'insufficient')
  assert.equal(trialVerdict({ fit: 20 }).verdict, 'insufficient')
  assert.equal(trialVerdict({ fit: 19 }).verdict, 'ineligible')
  assert.equal(trialVerdict({ fit: 0 }).verdict, 'ineligible')
  assert.equal(trialVerdict({}).verdict, 'insufficient')
  assert.equal(trialVerdict({ fit: null, criteria: [] }).because, 'no_judgment')
})

test('an order: by fit, then confidence, then id; a clause-level disqualifier moves only rows with no score; deterministic', () => {
  const items = [
    { id: 'c', fit: 90, confidence: 0.5 },
    { id: 'a', fit: 90, confidence: 0.9 },
    { id: 'b', fit: 90, confidence: 0.9 },
    { id: 'd', fit: 99, confidence: 0.9, criteria: [row('excluded', 'stated')] },
    { id: 'e', fit: 10, confidence: 0.1, criteria: [row('not_excluded', 'silent')] },
    { id: 'f', fit: null, confidence: null },
  ]
  const before = JSON.stringify(items)
  assert.deepEqual(rankJudgments(items).map((item) => item.id), ['d', 'a', 'b', 'c', 'e', 'f'])
  assert.equal(JSON.stringify(items), before, 'the input is not touched')
  assert.deepEqual(rankJudgments([...items].reverse()).map((item) => item.id), ['d', 'a', 'b', 'c', 'e', 'f'])
  assert.deepEqual(rankJudgments([{ id: 'x', criteria: [row('excluded', 'stated')] }, { id: 'y' }]).map((item) => item.id), ['y', 'x'], 'with no score the disqualifier still goes last')
})

test('a silent item does not sort as a disqualifier', () => {
  assert.deepEqual(rankJudgments([{ id: 'a', fit: 50, criteria: [row('excluded', 'silent')] }, { id: 'b', fit: 40 }]).map((item) => item.id), ['a', 'b'])
})

/** @param {string} documentId @param {string} text */
const record = (documentId, text, first = 0) => ({ documentId, text, sentences: segmentSentences(text).map((sentence, index) => ({ ...sentence, id: first + index, documentId })) })

test('a long record is divided between records first, at blank lines next, and never inside a sentence', () => {
  const a = record('a', 'A1 one. A2 two.')
  const b = record('b', 'B1 one.\n\nB2 two.', a.sentences.length)
  assert.equal(splitNoteParts([a, b], 1000).length, 1, 'what fits is one part')
  const parts = splitNoteParts([a, b], 20)
  assert.deepEqual(parts.map((part) => part.text), ['A1 one. A2 two.', 'B1 one.\n\nB2 two.'])
  assert.deepEqual(parts.flatMap((part) => part.sentences.map((sentence) => sentence.id)), [0, 1, 2, 3])
  const long = record('c', 'One sentence here.\n\nAnother one here.\n\nThird one is here.')
  assert.deepEqual(splitNoteParts([long], 25).map((part) => part.text), ['One sentence here.', 'Another one here.', 'Third one is here.'])
  const sentences = record('d', 'One two three four. Five six seven eight. Nine ten eleven twelve.')
  assert.deepEqual(splitNoteParts([sentences], 45).map((part) => part.text), ['One two three four. Five six seven eight.', 'Nine ten eleven twelve.'])
  assert.deepEqual(splitNoteParts([record('e', 'x'.repeat(100))], 10).map((part) => part.text.length), [100], 'a sentence longer than the cap is a part by itself, uncut')
})

/** @param {number} score @param {string[]} [ineligible] @param {string[]} [eligible] @param {string[]} [missing] */
const fit = (score, ineligible = [], eligible = [], missing = []) => ({ fit: score, confidence: 0.5, reasons: { eligible, ineligible, missing, rationale: `r${score}` }, issues: [] })

test('the parts of a long record: a stated conflict is the most specific, otherwise the part that found the most', () => {
  const conflict = mergeFitAnswers([fit(90, [], ['a'], ['ecog']), fit(5, ['妊娠'], ['b']), fit(40, ['x'])])
  assert.deepEqual([conflict.fit, conflict.reasons.rationale], [5, 'r5'])
  assert.deepEqual(conflict.reasons.eligible, ['a', 'b'])
  assert.deepEqual(conflict.reasons.ineligible, ['妊娠', 'x'])
  assert.deepEqual(conflict.reasons.missing, [], 'what is missing is what the chosen part still misses')
  const found = mergeFitAnswers([fit(30, [], [], ['diagnosis']), fit(85, [], ['肺癌'])])
  assert.deepEqual([found.fit, found.reasons.missing], [85, []])
  assert.equal(mergeFitAnswers([fit(70)]).fit, 70)
})

test('the parts of a long record: per clause, a statement over silence, against over for, silence over nothing', () => {
  const criteria = segmentCriteria('Inclusion Criteria:\n* Age\n* Stage\nExclusion Criteria:\n* Pregnancy\n* HIV')
  const sentences = segmentSentences('One. Two. Three.')
  const one = parseCriteriaAnswer({ 1: ['a', [0], 'included'], 2: ['b', [], 'not enough information'], 3: ['c', [], 'not excluded'] }, { criteria, sentences })
  const two = parseCriteriaAnswer({ 1: ['d', [1], 'not included'], 2: ['e', [], 'included'], 3: ['f', [2], 'not excluded'] }, { criteria, sentences })
  const merged = mergeCriteriaAnswers([one, two])
  assert.deepEqual(merged.rows.map((entry) => [entry.number, entry.label, entry.reason]), [[1, 'not_included', 'd'], [2, 'included', 'e'], [3, 'not_excluded', 'f']])
  assert.deepEqual(merged.missing.map((entry) => entry.number), [4], 'missing only if every part left it out')
  assert.equal(mergeCriteriaAnswers([one]), one)
})
