import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  VCR_IDENTIFIER_FORMATS, VCR_IDENTIFIER_KINDS, VCR_IDENTIFIER_SUGGESTION_LIMIT, isResidentIdNumber, suggestIdentifierSpans,
} from '../index.mjs'

/** The suggestions of a text as [format, the text the span holds].
 * @param {string} text */
const found = (text) => suggestIdentifierSpans(text).map((span) => [span.format, text.slice(span.start, span.end)])

// 11010519491231002X is the specimen number of the standard's own example; the others are built from it.
const VALID_ID = '11010519491231002X'

test('a resident identity number is suggested when its region, its birth date and its check character all hold', () => {
  assert.equal(isResidentIdNumber(VALID_ID), true)
  assert.equal(isResidentIdNumber(VALID_ID.toLowerCase()), true, 'the check character may be written x')
  const text = `身份证号 ${VALID_ID}，随访。`
  assert.deepEqual(found(text), [['resident_id', VALID_ID]])
  assert.deepEqual(suggestIdentifierSpans(text)[0], { start: 5, end: 23, format: 'resident_id', kind: 'identifier' })
  // Two more, built with the standard's weights: a leap-year birth date, and a check character of 9 (440106...).
  for (const another of ['320102199202291525', '440106198503150839', '510107197601010047']) assert.equal(isResidentIdNumber(another), true, another)
})

test('a number that only looks like an identity number is not suggested', () => {
  for (const wrong of [
    '110105194912310021', // the check character is wrong
    '110105194912310020',
    '990105194912310028', // no such region
    '110105194913310027', // month 13
    '110105194902300025', // 30 February
    '110105194912310', // 15 digits: no check character to decide it
    '1101051949123100281', // 19 digits
    '01010519491231002X', // cannot start with 0
  ]) {
    assert.equal(isResidentIdNumber(wrong), false, wrong)
    assert.deepEqual(found(`编号 ${wrong} 备注`).filter(([format]) => format === 'resident_id'), [], wrong)
  }
  // Part of a longer run of digits or letters it is not whole.
  assert.deepEqual(found(`A${VALID_ID}`), [])
  assert.deepEqual(found(`${VALID_ID}9`), [])
  assert.deepEqual(found(`9${VALID_ID}`), [])
})

test('a mainland mobile number is suggested in the shapes a chart writes it, and an 11-digit number that is not one is not', () => {
  for (const [text, number] of [
    ['电话13812345678。', '13812345678'], ['电话 138 1234 5678。', '138 1234 5678'], ['电话138-1234-5678。', '138-1234-5678'],
    ['电话 +86 13812345678。', '+86 13812345678'], ['电话8613812345678', '8613812345678'], ['联系 19912345678 回访', '19912345678'],
  ]) assert.deepEqual(found(text), [['mobile', number]], text)
  assert.equal(VCR_IDENTIFIER_KINDS.mobile, 'contact')
  for (const not of [
    '1381234567', // 10 digits
    '138123456789', // 12 digits
    '12345678901', // does not start 13-19
    '10086123456', '20260101123', // an accession number
    '13812345678a', 'a13812345678', // part of a longer token
    '138 1234 56789',
  ]) assert.deepEqual(found(`标本 ${not} 已送检`).filter(([format]) => format === 'mobile'), [], not)
})

test('a record number is the number after one of the labels a hospital writes, and the label stays', () => {
  for (const [text, number] of [
    ['住院号：20261234', '20261234'], ['病案号 A0012345', 'A0012345'], ['MRN: 00123456', '00123456'], ['门诊号#2026-012345', '2026-012345'],
    ['Patient ID 123456', '123456'], ['住院登记号:AB-0098765', 'AB-0098765'], ['医保号 330123456789', '330123456789'], ['就诊卡号＝778899', '778899'],
  ]) {
    const [suggestion] = suggestIdentifierSpans(text)
    assert.equal(suggestion?.format, 'record_number', text)
    assert.equal(text.slice(suggestion.start, suggestion.end), number, text)
    assert.equal(suggestion.kind, 'identifier')
  }
  for (const not of [
    '住院号待补', // no number
    '住院号：123', // too short to be one
    '住院号：1234567890123', // too long
    '病案号 A12', '肌酐：120', '血压 120/80', '床号 12', // other labels and other numbers
    '编号 20261234', // a label outside the list
  ]) assert.deepEqual(found(not), [], not)
  // An 11-digit number written after a label is a record number, not also a phone number.
  assert.deepEqual(found('住院号：13812345678'), [['record_number', '13812345678']])
})

test('a date is suggested whole, in the shapes a chart writes it, and a date of birth says so', () => {
  for (const [text, date] of [
    ['入院 2026-10-01 查体', '2026-10-01'], ['入院2026/10/1', '2026/10/1'], ['入院 2026.10.01。', '2026.10.01'],
    ['2026年10月1日入院', '2026年10月1日'], ['2026年10月1号入院', '2026年10月1号'], ['2026 年 10 月 1 日', '2026 年 10 月 1 日'], ['2026年10月复查', '2026年10月'],
    ['2024-02-29 查', '2024-02-29'],
  ]) assert.deepEqual(found(text), [['date', date]], text)
  assert.equal(VCR_IDENTIFIER_KINDS.date, 'date')
  const [birth] = suggestIdentifierSpans('出生日期：1980-02-29，入院 2026-10-01')
  assert.equal(birth.birth, true)
  assert.equal(suggestIdentifierSpans('出生日期：1980-02-29，入院 2026-10-01')[1].birth, undefined, 'only the date written after a word for birth is one')
  for (const not of [
    '2026-02-30', '2025-02-29', '2026-13-01', '2026-10-32', // not a calendar date
    '2026年13月', '2026年10月32日',
    'v2026.10.1.2', '2026-10-01-5', '1.2026-10-01', // part of a longer number
    '1980年', '10月1日', '10/1', // without a year and a month
    '120/80', '5 mg', '2026', // not dates
  ]) assert.deepEqual(found(`记录 ${not} 备注`).filter(([format]) => format === 'date'), [], not)
})

test('suggestions never overlap, carry offsets and no replacement, and count UTF-16 units', () => {
  const text = `😀病案号 A0012345，${VALID_ID}，13812345678，出生日期 1949-12-31，2026年10月1日。`
  const suggestions = suggestIdentifierSpans(text)
  assert.deepEqual(suggestions.map((span) => span.format), ['record_number', 'resident_id', 'mobile', 'date', 'date'])
  for (const span of suggestions) assert.deepEqual(Object.keys(span).filter((key) => !['start', 'end', 'format', 'kind', 'birth'].includes(key)), [], 'a span, never a replacement')
  for (let index = 1; index < suggestions.length; index += 1) assert.ok(suggestions[index - 1].end <= suggestions[index].start)
  assert.equal(text.slice(suggestions[0].start, suggestions[0].end), 'A0012345', 'a code point outside the BMP before it counts as two units')
  assert.deepEqual(VCR_IDENTIFIER_FORMATS, ['resident_id', 'record_number', 'mobile', 'date'])
  // The more specific reading of a place wins: an identity number holds a birth date and digits that are no date and no phone.
  assert.deepEqual(found(`${VALID_ID}`), [['resident_id', VALID_ID]])
  assert.deepEqual(found('没有任何标识，血压 120/80，肌酐 1.2 mg/dL。'), [])
  assert.deepEqual(found(''), [])
  assert.deepEqual(suggestIdentifierSpans(/** @type {any} */ (null)), [])
})

test('a text of thousands of dates yields a bounded list', () => {
  const text = Array.from({ length: VCR_IDENTIFIER_SUGGESTION_LIMIT + 500 }, (_, index) => `2026-${String(index % 12 + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`).join(' ')
  assert.equal(suggestIdentifierSpans(text).length, VCR_IDENTIFIER_SUGGESTION_LIMIT)
})
