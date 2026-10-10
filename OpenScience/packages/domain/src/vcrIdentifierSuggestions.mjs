/**
 * Suggestions for the reviewer of a patient record: the identifiers that have a closed format, found in the text as spans the
 * reviewer may accept (2026-10-10 owner ruling; OpenMed review E, decision 2).
 *
 * Hidden knowledge:
 *
 * - **A suggestion is a span and nothing more.** Nothing here masks anything. The reviewer of the projection sees each span with
 *   its words around it and accepts it or does not; a span that is not accepted stays in the text, and the projection is built
 *   only from what was accepted. No date is shifted: an accepted date is replaced by a surrogate like any other identifier, and a
 *   date nobody accepted is the date the chart wrote.
 * - **Closed formats only (development principle 5).** The four things found are formats a program can decide: an 18-digit
 *   mainland resident identity number (region, a calendar birth date, and the ISO 7064 MOD 11-2 check character), an 11-digit
 *   mainland mobile number, the number written after one of a closed list of record-number labels (住院号, 病案号, MRN ...),
 *   and a date written as a year, a month and optionally a day. A name, an address or a hospital's own wording is language, and
 *   language is the reviewer's judgement; nothing here tries to read it. The old 15-digit identity number has no check
 *   character and is any 15 digits to a program, so it is not suggested.
 * - **A format that is not whole is not found.** A run of digits is taken only when it is not part of a longer run of digits or
 *   letters, so a 12-digit number is not a mobile number with a digit to spare and an 18-digit identity number is not a mobile
 *   number and a date.
 * - **When two readings overlap, the more specific wins**: an identity number over a record number over a mobile number over a
 *   date. Spans never overlap, so every suggestion can be accepted on its own.
 * - Offsets are UTF-16 code units of the text as given, the unit the projection counts in (`buildCloudProjection`).
 *
 * @module @evimed/domain/vcrIdentifierSuggestions
 */

/** What a suggestion is, in the order the more specific reading wins. */
export const VCR_IDENTIFIER_FORMATS = Object.freeze(['resident_id', 'record_number', 'mobile', 'date'])

/** The projection kind each format is replaced as (`kinds` of `buildCloudProjection`). */
export const VCR_IDENTIFIER_KINDS = Object.freeze({
  resident_id: 'identifier', record_number: 'identifier', mobile: 'contact', date: 'date',
})

/** The most suggestions one text yields: a record is read by a person, and a thousand dates is a text of its own. */
export const VCR_IDENTIFIER_SUGGESTION_LIMIT = 2_000

/** Region codes (the first two digits of a resident identity number): the provinces, the municipalities, and 71, 81, 82. */
const REGION_CODES = new Set([
  11, 12, 13, 14, 15, 21, 22, 23, 31, 32, 33, 34, 35, 36, 37, 41, 42, 43, 44, 45, 46, 50, 51, 52, 53, 54, 61, 62, 63, 64, 65, 71, 81, 82,
])
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECK_CHARACTERS = '10X98765432'

/** @param {number} year @param {number} month @param {number} day */
function isCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]
}

/**
 * Whether 18 characters are a resident identity number: the region, a real birth date, and the check character the first 17
 * digits compute.
 * @param {string} value
 */
export function isResidentIdNumber(value) {
  if (!/^[1-9]\d{16}[0-9Xx]$/.test(value)) return false
  if (!REGION_CODES.has(Number(value.slice(0, 2)))) return false
  if (!isCalendarDate(Number(value.slice(6, 10)), Number(value.slice(10, 12)), Number(value.slice(12, 14)))) return false
  let sum = 0
  for (let index = 0; index < 17; index += 1) sum += Number(value[index]) * ID_WEIGHTS[index]
  return ID_CHECK_CHARACTERS[sum % 11] === value[17].toUpperCase()
}

/** Not inside a longer run of digits or letters. */
const NOT_AFTER_WORD = '(?<![0-9A-Za-z])'
const NOT_BEFORE_WORD = '(?![0-9A-Za-z])'

const RESIDENT_ID = new RegExp(`${NOT_AFTER_WORD}[1-9]\\d{16}[0-9Xx]${NOT_BEFORE_WORD}`, 'g')
// 11 digits starting 13-19, alone or grouped 3-4-4 with a space or a hyphen, with an optional country code.
const MOBILE = new RegExp(`${NOT_AFTER_WORD}(?:(?:\\+|00)?86[- ]?)?1[3-9]\\d[- ]?\\d{4}[- ]?\\d{4}${NOT_BEFORE_WORD}`, 'g')
/** The labels a hospital writes before a record number: a closed list, so the format is the label and the number after it. */
const RECORD_LABELS = [
  '住院登记号', '住院病历号', '住院号', '门诊病历号', '门诊号', '病案号', '病历号', '就诊卡号', '诊疗卡号', '就诊号', '登记号', '检查号',
  '医保号', '患者编号', '病人编号', '患者ID', '病人ID', 'Medical Record No\\.?', 'Hospital No\\.?', 'Patient ID', 'PatientID', 'MRN',
]
// A number of 5 to 12 digits, with a prefix of up to three letters, or a year and a sequence (2026-012345).
const RECORD_NUMBER = new RegExp(`(?<![A-Za-z])(?:${RECORD_LABELS.join('|')})\\s*[:：=＝#＃]?\\s*((?:[A-Za-z]{1,3}-?)?\\d{5,12}|20\\d{2}-\\d{3,8})${NOT_BEFORE_WORD}`, 'gi')
// A date is whole: not inside a longer number, and not the front of a version like 2026.10.1.2.
const DATE_AFTER = '(?<![0-9]|[0-9][-/.])'
const DATE_BEFORE = '(?![0-9]|[-/.][0-9])'
const DATE_SEPARATED = new RegExp(`${DATE_AFTER}((?:19|20)\\d{2})([-/.])(0?[1-9]|1[0-2])\\2(0?[1-9]|[12]\\d|3[01])${DATE_BEFORE}`, 'g')
const DATE_WRITTEN = new RegExp(`${DATE_AFTER}((?:19|20)\\d{2}) ?年 ?(0?[1-9]|1[0-2]) ?月(?: ?(0?[1-9]|[12]\\d|3[01]) ?[日号])?(?! ?\\d{1,2} ?[日号])`, 'g')
/** Words that say a date is the date of birth, looked for just before it. */
const BIRTH_WORDS = ['出生日期', '出生于', '出生', '生日', 'DOB', 'Date of Birth', 'Birth']

/**
 * @typedef {{ start: number, end: number, format: 'resident_id' | 'record_number' | 'mobile' | 'date', kind: string, birth?: true }} IdentifierSuggestion
 */

/**
 * The identifiers of closed formats in a text, as non-overlapping spans in order. Never applied: the reviewer accepts them.
 * @param {string} text
 * @returns {IdentifierSuggestion[]}
 */
export function suggestIdentifierSpans(text) {
  const value = String(text ?? '')
  /** @type {IdentifierSuggestion[]} */
  const found = []
  /** @param {IdentifierSuggestion['format']} format @param {number} start @param {number} end @param {boolean} [birth] */
  const add = (format, start, end, birth = false) => found.push({ start, end, format, kind: VCR_IDENTIFIER_KINDS[format], ...(birth ? { birth: /** @type {const} */ (true) } : {}) })
  for (const match of value.matchAll(RESIDENT_ID)) if (isResidentIdNumber(match[0])) add('resident_id', match.index, match.index + match[0].length)
  for (const match of value.matchAll(RECORD_NUMBER)) add('record_number', match.index + match[0].length - match[1].length, match.index + match[0].length)
  for (const match of value.matchAll(MOBILE)) add('mobile', match.index, match.index + match[0].length)
  /** @param {RegExpMatchArray} match @param {string} year @param {string} month @param {string | undefined} day */
  const addDate = (match, year, month, day) => {
    if (day !== undefined && !isCalendarDate(Number(year), Number(month), Number(day))) return
    const before = value.slice(Math.max(0, /** @type {number} */ (match.index) - 12), match.index)
    add('date', /** @type {number} */ (match.index), /** @type {number} */ (match.index) + match[0].length, BIRTH_WORDS.some((word) => before.includes(word)))
  }
  for (const match of value.matchAll(DATE_SEPARATED)) addDate(match, match[1], match[3], match[4])
  for (const match of value.matchAll(DATE_WRITTEN)) addDate(match, match[1], match[2], match[3])

  // The more specific reading of a place wins, then the earlier; spans never overlap.
  const rank = (/** @type {IdentifierSuggestion} */ suggestion) => VCR_IDENTIFIER_FORMATS.indexOf(suggestion.format)
  /** @type {IdentifierSuggestion[]} */
  const chosen = []
  for (const suggestion of [...found].sort((left, right) => rank(left) - rank(right) || left.start - right.start || right.end - left.end)) {
    if (chosen.some((other) => suggestion.start < other.end && other.start < suggestion.end)) continue
    chosen.push(suggestion)
    if (chosen.length >= VCR_IDENTIFIER_SUGGESTION_LIMIT) break
  }
  return chosen.sort((left, right) => left.start - right.start)
}
