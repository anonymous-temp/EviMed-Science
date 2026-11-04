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

test('clauses: a heading that names both sides puts neither side on what follows, and is no clause', () => {
  for (const heading of ['Inclusion and Exclusion Criteria:', 'INCLUSION & EXCLUSION CRITERIA', 'Key Inclusion and Exclusion Criteria:', 'Inclusion/Exclusion Criteria:', 'Inclusion / Exclusion:', '* Inclusion and exclusion criteria:', 'Inclusion and/or exclusion criteria:', '纳入与排除标准：', '入选和排除标准', '纳入/排除标准：', '入排标准：']) {
    const text = `${heading}\n\n* Age >= 18 years\n* No pregnancy`
    const clauses = segmentCriteria(text)
    holds(text, clauses)
    assert.deepEqual(clauses.map((row) => [row.kind, row.text]), [['unsectioned', 'Age >= 18 years'], ['unsectioned', 'No pregnancy']], heading)
  }
  const later = segmentCriteria('Exclusion Criteria:\n* Pregnancy\nInclusion/Exclusion Criteria - Sample 2:\n* Age >= 18')
  assert.deepEqual(later.map((row) => [row.kind, row.lead ?? null, row.text]), [['exclusion', null, 'Pregnancy'], ['unsectioned', 'Inclusion/Exclusion Criteria - Sample 2:', 'Age >= 18']])
  const sentence = 'Inclusion Criteria:\n* Age >= 18\n* Other protocol-defined inclusion/exclusion criteria may apply.'
  assert.deepEqual(segmentCriteria(sentence).map((row) => [row.kind, row.text]), [['inclusion', 'Age >= 18'], ['inclusion', 'Other protocol-defined inclusion/exclusion criteria may apply.']], 'a sentence about the criteria is a clause')
})

test('clauses: a line that opens with a side word and is about something else leaves the side alone', () => {
  const text = 'Inclusion Criteria:\n* Age >= 18\n\nExclusion Criteria:\n* Inclusion in another clinical study: within the past 30 days\n* Pregnancy\nInclusion of Women and Minorities:\nExclusion from a prior study: any reason\n* Active infection'
  const clauses = segmentCriteria(text)
  holds(text, clauses)
  assert.ok(clauses.slice(1).every((row) => row.kind === 'exclusion'), JSON.stringify(clauses))
  assert.equal(clauses[1].text, 'Inclusion in another clinical study: within the past 30 days', 'its words stay whole')
  for (const heading of ['Inclusion of vulnerable participants:', 'Inclusion is possible for patients with:']) {
    const under = segmentCriteria(`Exclusion Criteria:\n* Pregnancy\n${heading}\n* Active infection`)
    assert.equal(under[under.length - 1].kind, 'exclusion', heading)
  }
})

test('clauses: a section heading is read whatever list it names, a slip of the pen and a sentence about the criteria are told apart', () => {
  /** @param {string} heading the second heading, after an inclusion section */
  const after = (heading) => segmentCriteria(`Inclusion Criteria:\n* Age >= 18\n${heading}\n* Pregnancy`).map((row) => [row.kind, row.lead ?? null, row.text])
  for (const heading of ['Exclusion Criteria', 'exclusion criteria.', 'Exclusion:', 'Exclusions', 'Key Exclusion Criteria:', 'Non-inclusion criteria:', 'Non inclusion criteria', 'Criteria for exclusion:', 'Exclusion critieria:', 'Exlusion criteria:', 'Exculsion Criteria', '-Exclusion Criteria:', 'b. Exclusion', '2.1 Exclusion criteria:', 'The exclusion criteria are:', 'Exclusion criteria include', '排除标准如下：', '排除标准（符合任一项即排除）：', '非入选标准：']) {
    const rows = after(heading)
    assert.equal(rows.length, 2, heading)
    assert.equal(rows[1][0], 'exclusion', heading)
    assert.equal(rows[1][2], 'Pregnancy', heading)
  }
  // A heading whose words are a premise of its items carries them; one whose words add nothing does not.
  assert.deepEqual(after('Donor exclusion criteria:')[1], ['exclusion', 'Donor exclusion criteria:', 'Pregnancy'])
  assert.deepEqual(after('Angiographic Exclusion Criteria')[1], ['exclusion', 'Angiographic Exclusion Criteria', 'Pregnancy'])
  assert.deepEqual(after('Part 2 exclusion criteria:')[1], ['exclusion', 'Part 2 exclusion criteria:', 'Pregnancy'])
  assert.deepEqual(after('Phase A Exclusion Criteria:')[1], ['exclusion', 'Phase A Exclusion Criteria:', 'Pregnancy'])
  assert.deepEqual(after('EXCLUSION RELATED TO THE METABOLIC STATUS:')[1], ['exclusion', 'EXCLUSION RELATED TO THE METABOLIC STATUS:', 'Pregnancy'])
  assert.deepEqual(after('Phase 2: Exclusion Criteria:')[1], ['exclusion', 'Phase 2: Exclusion Criteria:', 'Pregnancy'])
  assert.deepEqual(after('HEALTHY SUBJECT CRITERIA\nExclusion Criteria:')[1], ['exclusion', 'HEALTHY SUBJECT CRITERIA Exclusion Criteria:', 'Pregnancy'])
  assert.deepEqual(after('Criteria for exclusion from randomization')[1], ['exclusion', 'Criteria for exclusion from randomization', 'Pregnancy'])
  assert.deepEqual(after('试验组排除标准：')[1], ['exclusion', '试验组排除标准：', 'Pregnancy'])
  assert.deepEqual(after('Phase 1 Exclusions')[1], ['exclusion', 'Phase 1 Exclusions', 'Pregnancy'])
  assert.deepEqual(after('Prevention Trial, Exclusion Criteria:')[1], ['exclusion', 'Prevention Trial, Exclusion Criteria:', 'Pregnancy'])
  assert.deepEqual(after('EXCLUSION STUDY CRITERIA:')[1].slice(0, 1), ['exclusion'])
  assert.deepEqual(after('EXCLUSION/DEFERRAL CRITERIA:')[1].slice(0, 1), ['exclusion'])
  assert.deepEqual(after('Exclusion-Criteria:')[1].slice(0, 1), ['exclusion'])
  assert.deepEqual(after('Summary of Exclusion Criteria:')[1].slice(0, 1), ['exclusion'])
  assert.deepEqual(segmentCriteria('1. Global Inclusion Criteria\n\n   * Age >= 18\n2. Specific Exclusion Criteria\n\n   * Pregnancy').map((row) => row.kind), ['inclusion', 'exclusion'], 'a numbered heading with a list under it')
  assert.deepEqual(segmentCriteria('Inclusion of Subjects with Hepatitis:\n* Age >= 18\nExclusion of Subjects with Hepatitis:\n* Pregnancy').map((row) => row.kind), ['inclusion', 'exclusion'], 'where no side is open yet, this does open one')
  assert.equal(after('【排除标准】')[1][0], 'exclusion')
  assert.equal(after('排除标准 Exclusion criteria：')[1][0], 'exclusion')
  // A last item in capitals is an item.
  assert.deepEqual(segmentCriteria('Inclusion Criteria:\nAge >= 18\nECOG 0-1\nExclusion Criteria:\nPregnancy').map((row) => [row.kind, row.lead ?? null, row.text]), [['inclusion', null, 'Age >= 18'], ['inclusion', null, 'ECOG 0-1'], ['exclusion', null, 'Pregnancy']])
  assert.deepEqual(after('Major exclusion criteria:')[1], ['exclusion', null, 'Pregnancy'])
  assert.deepEqual(after('研究对象的排除标准：')[1], ['exclusion', null, 'Pregnancy'])
  // A sentence about the criteria is a clause of the section it is in.
  for (const sentence of ['* Standard MRI exclusion criteria', 'Other protocol-specified exclusion criteria.', '* no exclusion criteria', '* does not meet inclusion criteria', '* failure to meet exclusion criteria', '* none of the exclusion criteria', '* other protocol-defined exclusion criteria may apply.', '* further exclusion criteria apply', '不符合纳入标准者', '符合排除标准的患者']) {
    assert.deepEqual(segmentCriteria(`Inclusion Criteria:\n* Age >= 18\n${sentence}\n* Stage IV`).map((row) => row.kind), ['inclusion', 'inclusion', 'inclusion'], sentence)
  }
  // A plain line that says the following are the criteria of a side opens that side, and what it says travels; a bullet saying so is one clause.
  const opened = segmentCriteria('Inclusion Criteria:\n* Age >= 18\nPatients meeting any of the following exclusion criteria are not to be enrolled:\n* Pregnancy')
  assert.deepEqual(opened.map((row) => [row.kind, row.text]), [['inclusion', 'Age >= 18'], ['exclusion', 'Pregnancy']])
  assert.match(String(opened[1].lead), /not to be enrolled/)
  assert.equal(segmentCriteria('Exclusion Criteria:\n* Pregnancy\nStandard MRI exclusion criteria').length, 2, 'a heading has something under it')
  const bullet = segmentCriteria('Inclusion Criteria:\n* Age >= 18\n* Patients who meet none of the following exclusion criteria: see below\n* Stage IV')
  assert.deepEqual(bullet.map((row) => row.kind), ['inclusion', 'inclusion', 'inclusion'])
  assert.equal(bullet.length, 3)
  assert.match(bullet[1].text, /see below$/)
  // Words about both sides, or pointing back at a side, open neither.
  for (const line of ['Subjects who meet the following inclusion and exclusion criteria will be eligible:', 'Anyone who does not fit the criteria stated under "Inclusion Criteria" and anyone included in the following criteria:', 'Any causes other than which mentioned in the inclusion criteria as:']) {
    const rows = segmentCriteria(`Exclusion Criteria:\n* Pregnancy\n${line}\n* Active infection`)
    assert.deepEqual(rows.map((row) => row.kind), ['exclusion', 'exclusion'], line)
  }
  assert.deepEqual(segmentCriteria('Exclusion Criteria:\n* Pregnancy\nHealthy controls must meet the following inclusion criteria:\n* Age >= 18').map((row) => row.kind), ['exclusion', 'inclusion'], 'a new cohort after the exclusions')
  assert.deepEqual(segmentCriteria('Inclusion Criteria\n* Age >= 18\nExclusion criteria included;\n* Pregnancy').map((row) => row.kind), ['inclusion', 'exclusion'])
  assert.deepEqual(segmentCriteria('Inclusion Criteria Informed Consent and Willingness\n* Consent\nExclusion Criteria Prior and concomitant therapies\n* Warfarin').map((row) => [row.kind, row.text]), [['inclusion', 'Consent'], ['exclusion', 'Warfarin']])
  assert.deepEqual(segmentCriteria('Inclusion Criteria: Asthma\n\nExclusion Criteria:COPD\n\n\\-').map((row) => [row.kind, row.text]), [['inclusion', 'Asthma'], ['exclusion', 'COPD']], 'an empty bullet is nothing to introduce')
  assert.deepEqual(segmentCriteria('* General Inclusion Criteria\n* Age >= 18\n* General Exclusion Criteria\n* Pregnancy').map((row) => row.kind), ['inclusion', 'exclusion'], 'a heading written as a bullet among its own items')
  const back = segmentCriteria('Inclusion Criteria:\n* Age >= 18\nPatients must meet at least 2 of the above inclusion criteria and the following:\n* Stage IV\nExclusion Criteria:\n* Pregnancy')
  assert.deepEqual(back.map((row) => row.kind), ['inclusion', 'inclusion', 'exclusion'], 'the words point back, so the side stays')
})

test('clauses: a heading in the middle of a line is cut only where a heading can stand', () => {
  /** @param {string} text */
  const read = (text) => { const rows = segmentCriteria(text); holds(text, rows); return rows.map((row) => [row.kind, row.text]) }
  assert.deepEqual(read('Inclusion Criteria: Age >= 18 Exclusion Criteria: pregnancy'), [['inclusion', 'Age >= 18'], ['exclusion', 'pregnancy']])
  assert.deepEqual(read('Key Inclusion Criteria: Age >= 18. Key Exclusion Criteria: pregnancy'), [['inclusion', 'Age >= 18.'], ['exclusion', 'pregnancy']])
  assert.deepEqual(read('Medical exclusion criteria: known renal insufficiency').map((row) => row[0]), ['exclusion'])
  assert.deepEqual(read('Medical exclusion criteria: known renal insufficiency').map((row) => row[1]), ['known renal insufficiency'])
  assert.deepEqual(read('Inclusion Criteria:\n* Any of the exclusion criteria: see the protocol\n* Stage IV'), [['inclusion', 'Any of the exclusion criteria: see the protocol'], ['inclusion', 'Stage IV']])
})

test('clauses: a number inside an item does not start the next one', () => {
  /** @param {string} text */
  const read = (text) => { const rows = segmentCriteria(text); holds(text, rows); return rows.map((row) => row.text) }
  assert.deepEqual(read('Inclusion Criteria:\n1. ECOG performance status of 0, 1, or 2.\n2. Age >= 18\n3. Adequate organ function'), ['ECOG performance status of 0, 1, or 2.', 'Age >= 18', 'Adequate organ function'])
  assert.deepEqual(read('Inclusion Criteria:\n1. ECOG performance status of 0, 1, or 2.'), ['ECOG performance status of 0, 1, or 2.'])
  assert.deepEqual(read('Inclusion Criteria:\n1. Stage 1 or 2. Histology confirmed'), ['Stage 1 or 2. Histology confirmed'])
  assert.deepEqual(read('Inclusion Criteria:\n1. ECOG <= 2. Age >= 18\n2. Consent'), ['ECOG <= 2. Age >= 18', 'Consent'], 'the list runs down the lines, so a 2. on this line is its own words')
  assert.deepEqual(read('Inclusion Criteria:\n1. ECOG score of 2. Age >= 18'), ['ECOG score of 2. Age >= 18'])
  assert.deepEqual(read('Inclusion Criteria:\n1. Age >= 18. 2. ECOG 0-1. 3. Stage IV'), ['Age >= 18.', 'ECOG 0-1.', 'Stage IV'], 'a real list on one line is still read')
  assert.deepEqual(read('纳入标准：1、年龄≥18岁，2、确诊肺癌，3、ECOG 0-2。'), ['年龄≥18岁，', '确诊肺癌，', 'ECOG 0-2。'])
  assert.deepEqual(reasonList('1. ECOG 0, 1, or 2. 2. Age is met'), ['ECOG 0, 1, or 2.', 'Age is met'], 'the reasons of an answer are read the same way')
  assert.deepEqual(reasonList('1. Age is met 2. Stage is met'), ['Age is met', 'Stage is met'], 'a model\'s numbered reasons need no stop between them')
})

test('clauses: alternatives written across lines stay one clause, and a bare AND is no clause', () => {
  /** @param {string} text */
  const read = (text) => { const rows = segmentCriteria(text); holds(text, rows); return rows.map((row) => [row.kind, row.text]) }
  assert.deepEqual(read('Inclusion Criteria:\n* Adenocarcinoma, or\n* Squamous cell carcinoma\n* Age >= 18'), [['inclusion', 'Adenocarcinoma, or\n* Squamous cell carcinoma'], ['inclusion', 'Age >= 18']])
  assert.deepEqual(read('Inclusion Criteria:\n1. Adenocarcinoma; or\n2. Squamous cell carcinoma; or\n3. Large cell carcinoma\n4. Age >= 18\n5. Consent'), [['inclusion', 'Adenocarcinoma; or\n2. Squamous cell carcinoma; or\n3. Large cell carcinoma'], ['inclusion', 'Age >= 18'], ['inclusion', 'Consent']])
  assert.deepEqual(read('Inclusion Criteria:\n* Adenocarcinoma\nOR\n* Squamous cell carcinoma\n* Age >= 18'), [['inclusion', 'Adenocarcinoma\nOR\n* Squamous cell carcinoma'], ['inclusion', 'Age >= 18']])
  assert.deepEqual(read('Inclusion Criteria:\n* Adenocarcinoma\n* or squamous cell carcinoma\n* Age >= 18'), [['inclusion', 'Adenocarcinoma\n* or squamous cell carcinoma'], ['inclusion', 'Age >= 18']])
  assert.deepEqual(read('Inclusion Criteria:\n* Adenocarcinoma and/or\n* Squamous cell carcinoma'), [['inclusion', 'Adenocarcinoma and/or\n* Squamous cell carcinoma']])
  assert.deepEqual(read('纳入标准：\n1. 腺癌或\n2. 鳞癌\n3. 年龄≥18岁'), [['inclusion', '腺癌或\n2. 鳞癌'], ['inclusion', '年龄≥18岁']])
  assert.deepEqual(read('Exclusion Criteria:\n* Pregnant, or\n* Breastfeeding\n* Active infection'), [['exclusion', 'Pregnant, or\n* Breastfeeding'], ['exclusion', 'Active infection']])
  // Both of two requirements are two clauses; the word between them is said on the first, and no clause is the word alone.
  assert.deepEqual(read('Inclusion Criteria:\n* Age >= 18\nAND\n* Stage IV'), [['inclusion', 'Age >= 18\nAND'], ['inclusion', 'Stage IV']])
  assert.deepEqual(read('Inclusion Criteria:\n* Age >= 18, and\n* Stage IV'), [['inclusion', 'Age >= 18, and'], ['inclusion', 'Stage IV']])
  assert.deepEqual(read('Inclusion Criteria:\nOR\n* Stage IV'), [['inclusion', 'Stage IV']], 'a bare word under a heading joins nothing')
  // A heading ends the alternatives.
  assert.deepEqual(read('Inclusion Criteria:\n* Adenocarcinoma or\nExclusion Criteria:\n* Pregnancy'), [['inclusion', 'Adenocarcinoma or'], ['exclusion', 'Pregnancy']])
})

test('clauses: an escaped bullet or number is a bullet or a number', () => {
  const text = 'Inclusion Criteria:\n\\- Age >= 18\n\\- Stage IV\n\\* Consent'
  assert.deepEqual(segmentCriteria(text).map((row) => row.text), ['Age >= 18', 'Stage IV', 'Consent'])
  assert.deepEqual(segmentCriteria('Exclusion Criterion.\n\n1\\) Enrolled elsewhere\n2\\) Pregnant\n3\\. Infection').map((row) => [row.kind, row.text]), [['exclusion', 'Enrolled elsewhere'], ['exclusion', 'Pregnant'], ['exclusion', 'Infection']])
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

test('a number comes from a key or a number field, never out of a clause\'s words', () => {
  const clauses = Array.from({ length: 20 }, (_, index) => ({ number: index + 1, kind: index < 10 ? 'inclusion' : 'exclusion', text: index === 2 ? 'Age >= 18 years' : `Clause ${String.fromCharCode(97 + index)}` }))
  const sentences = [{ id: 0, text: 's0' }, { id: 1, text: 's1' }]
  /** @param {unknown} raw */
  const read = (raw) => parseCriteriaAnswer(raw, { criteria: clauses, sentences })
  // The words of the clause find the clause; the 18 in them is no clause number.
  const worded = read({ results: [{ criterion: 'Age >= 18 years', reason: 'r', sentence_ids: [0], label: 'included' }] })
  assert.deepEqual(worded.rows.map((row) => [row.number, row.kind, row.label]), [[3, 'inclusion', 'included']])
  assert.ok(worded.issues.some((issue) => issue.code === 'criterion_by_words'))
  assert.ok(!worded.issues.some((issue) => issue.code === 'label_other_side'))
  // Words that find no clause, or more than one, answer none, and nothing lands by a number inside them.
  const unknown = read([{ criterion: 'Weight below 18 kg', reason: 'r', sentence_ids: [0], label: 'included' }])
  assert.deepEqual(unknown.rows, [])
  assert.ok(unknown.issues.some((issue) => issue.code === 'criterion_unmatched'))
  assert.deepEqual(read([{ criterion: 'Clause', reason: 'r', sentence_ids: [], label: 'included' }]).rows, [], 'words that fit many clauses name none')
  // A key that is words is the same.
  assert.deepEqual(read({ 'Age >= 18 years': ['r', [0], 'included'] }).rows.map((row) => row.number), [3])
  assert.deepEqual(read({ 'Weight below 18 kg': ['r', [0], 'included'] }).rows, [])
  // A number in any of the shapes a number is written.
  for (const key of ['3', ' 3 ', '#3', '3.', 'C3', 'criterion 3', 'criterion_3', 'inclusion_3', 'Criterion #3', '3)']) {
    assert.deepEqual(read({ [key]: ['r', [0], 'included'] }).rows.map((row) => row.number), [3], key)
    assert.deepEqual(read([{ criterion: key, reason: 'r', sentence_ids: [0], label: 'included' }]).rows.map((row) => row.number), [3], `criterion field ${key}`)
    assert.deepEqual(read([{ number: key, reason: 'r', sentence_ids: [0], label: 'included' }]).rows.map((row) => row.number), [3], `number field ${key}`)
  }
  assert.deepEqual(read([{ criterion: 3, reason: 'r', sentence_ids: [0], label: 'included' }]).rows.map((row) => row.number), [3])
  assert.deepEqual(read({ [`${' '.repeat(60000)}x`]: ['r', [0], 'included'] }).rows, [], 'a long key takes no time to refuse')
  assert.deepEqual(read([[3, 'r', [0], 'included']]).rows.map((row) => row.number), [3])
  assert.deepEqual(read([['3', 'r', [0], 'included']]).rows.map((row) => row.number), [3])
})

test('a list with no numbers follows the order of the prompt, and only when it answers every clause', () => {
  // Exclusion first in the text: the prompt lists inclusion first, so the model's first row is the inclusion.
  const criteria = segmentCriteria('Exclusion Criteria:\n* Pregnancy\nInclusion Criteria:\n* Age >= 18')
  assert.deepEqual(criteria.map((row) => [row.number, row.kind]), [[1, 'exclusion'], [2, 'inclusion']])
  const sentences = [{ id: 0, text: 's0' }]
  const both = parseCriteriaAnswer({ rows: [{ reason: 'adult', sentence_ids: [0], label: 'included' }, { reason: 'male', sentence_ids: [0], label: 'not excluded' }] }, { criteria, sentences })
  assert.deepEqual(both.rows.map((row) => [row.number, row.kind, row.label, row.reason]), [[1, 'exclusion', 'not_excluded', 'male'], [2, 'inclusion', 'included', 'adult']])
  assert.equal(both.issues.filter((issue) => issue.code === 'criterion_by_position').length, 2)
  // A list shorter than the clauses cannot say which it answers.
  const short = parseCriteriaAnswer([{ reason: 'x', sentence_ids: [0], label: 'included' }], { criteria, sentences })
  assert.deepEqual(short.rows, [])
  assert.equal(short.missing.length, 2)
  assert.ok(short.issues.some((issue) => issue.code === 'criterion_unmatched'))
})

test('a label is the word in the label place: a reason that reads like one is a reason', () => {
  const answer = parseCriteriaAnswer({ 1: ['N/A', [], 'included'], 2: ['not applicable', [0], 'not included'], 3: ['excluded', [], 'not excluded'], 4: ['included', [0]] }, context())
  assert.deepEqual(answer.rows.map((row) => [row.number, row.label]), [[1, 'included'], [2, 'not_included'], [3, 'not_excluded'], [4, 'excluded']], 'with the third element a word that is no label, the only label is the label')
  assert.equal(answer.rows[2].reason, 'excluded', 'the word stays what it is, a reason')
})

test('sentence ids: words around them are read, a number in a sentence is not an id', () => {
  const sentences = Array.from({ length: 70 }, (_, id) => ({ id, text: `s${id}` }))
  const criteria = [{ number: 1, kind: 'inclusion', text: 'Age' }]
  /** @param {unknown} written */
  const ids = (written) => parseCriteriaAnswer({ 1: ['r', written, 'included'] }, { criteria, sentences }).rows[0].sentenceIds
  assert.deepEqual(ids('0, 1'), [0, 1])
  assert.deepEqual(ids(['1', 2]), [1, 2])
  assert.deepEqual(ids('sentence 3'), [3])
  assert.deepEqual(ids('Sentence 3 and sentence 4'), [3, 4])
  assert.deepEqual(ids('S3; S4'), [3, 4])
  assert.deepEqual(ids(['Sentence 1 says age 62']), [1], 'the 62 is the age')
  assert.deepEqual(ids('the patient is 62'), [])
})

test('numbers counted from zero are moved up only when they fit every clause, otherwise they name nothing', () => {
  const criteria = segmentCriteria('Inclusion Criteria:\n* Age\n* Stage\nExclusion Criteria:\n* Pregnancy')
  const sentences = [{ id: 0, text: 's0' }]
  const moved = parseCriteriaAnswer({ 0: ['a', [0], 'included'], 1: ['b', [], 'not included'], 2: ['c', [], 'not excluded'] }, { criteria, sentences })
  assert.deepEqual(moved.rows.map((row) => [row.number, row.label]), [[1, 'included'], [2, 'not_included'], [3, 'not_excluded']])
  assert.ok(moved.issues.some((issue) => issue.code === 'criterion_counted_from_zero'))
  const partial = parseCriteriaAnswer({ 0: ['a', [0], 'included'], 1: ['b', [], 'not included'] }, { criteria, sentences })
  assert.deepEqual(partial.rows, [], 'a zero means the numbers are shifted, so 1 is not clause 1')
  assert.equal(partial.missing.length, 3)
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

test('a verdict: a low score that says why it does not fit, with nothing missing, reads as not fitting', () => {
  const reasons = ['1. 成人试验，患者 8 岁']
  assert.equal(trialVerdict({ fit: 25, ineligibleReasons: reasons, missingReasons: [] }).verdict, 'ineligible')
  assert.equal(trialVerdict({ fit: 25, ineligibleReasons: reasons, missingReasons: [] }).because, 'stated_reasons')
  // Something still missing is what the band says; so is a score with no reason against it.
  assert.equal(trialVerdict({ fit: 25, ineligibleReasons: reasons, missingReasons: ['1. 分期'] }).verdict, 'insufficient')
  assert.equal(trialVerdict({ fit: 25, ineligibleReasons: [], missingReasons: [] }).verdict, 'insufficient')
  assert.equal(trialVerdict({ fit: 60, ineligibleReasons: reasons, missingReasons: [] }).verdict, 'possible', 'a score the model holds open stays open')
  // Clause rows speak for themselves.
  assert.equal(trialVerdict({ fit: 25, criteria: [{ label: 'not_enough_information', basis: 'silent' }], ineligibleReasons: reasons, missingReasons: [] }).verdict, 'insufficient')
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
