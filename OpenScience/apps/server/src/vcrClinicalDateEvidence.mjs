/** Exact calendar-date binding for newly extracted facts. It does not infer clinical dates from metadata. */

import { createHash } from 'node:crypto';

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
/** Year first, with a separator or the Chinese year/month/day marks: 2067-05-03, 2067/5/3, 2067年5月3日. */
const NUMERIC_DATE = /(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日)?(?!\d)/gu;
/** A month named in English, with the day and the year: May 3, 2067 / 3 May 2067. */
const NAMED_DATE = new RegExp(`(?<![A-Za-z0-9])(?:${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+\\d{4}|(\\d{1,2})\\s+${MONTH}\\.?[,]?\\s+\\d{4})(?!\\d)`, 'gi');

/** A calendar date as `YYYY-MM-DD` only when it exists: 2067-02-30 is no date. @param {number} year @param {number} month @param {number} day */
function isoOf(year, month, day) {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at.toISOString().slice(0, 10);
}

/**
 * Every date a text prints whole, with its year, in the forms the evidence check accepts (numeric year-first, Chinese year/month/day,
 * a month named in English): the calendar date as `YYYY-MM-DD` and where it stands. A short form (`3/14`), a bare year and a date that
 * does not exist print nothing here.
 * @param {string} text @returns {Array<{ iso: string, start: number, end: number }>} in the order of the text
 */
export function clinicalDatesPrinted(text) {
  /** @type {Array<{ iso: string, start: number, end: number }>} */
  const found = [];
  const body = String(text ?? '');
  for (const match of body.matchAll(NUMERIC_DATE)) {
    const iso = isoOf(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) found.push({ iso, start: match.index, end: match.index + match[0].length });
  }
  for (const match of body.matchAll(NAMED_DATE)) {
    const parsed = Date.parse(match[0].replace(/(\d)(st|nd|rd|th)/gi, '$1') + ' UTC');
    if (!Number.isFinite(parsed)) continue;
    const at = new Date(parsed);
    // The engine rolls an impossible day over (30 February is 2 March): the day it prints must be the day it parsed to.
    if (at.getUTCDate() !== Number(match[1] ?? match[2])) continue;
    found.push({ iso: at.toISOString().slice(0, 10), start: match.index, end: match.index + match[0].length });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** @param {string} value @param {string} quote */
export function clinicalDateInQuote(value, quote) {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(String(value));
  if (!date || !Number.isFinite(Date.parse(value))) return false;
  const wanted = `${date[1]}-${date[2]}-${date[3]}`;
  if (new Date(Date.UTC(Number(date[1]), Number(date[2])-1, Number(date[3]))).toISOString().slice(0,10) !== wanted) return false;
  return clinicalDatesPrinted(String(quote)).some((printed) => printed.iso === wanted);
}

/** A relative interval needs a quoted calendar anchor and an explicitly selected literal duration.
 * @param {{start:string,end:string}} interval @param {string} quote @param {string|null|undefined} dateSurface */
export function clinicalIntervalInQuote(interval, quote, dateSurface) {
  if (!interval) return true;
  const startKnown = clinicalDateInQuote(interval.start, quote), endKnown = clinicalDateInQuote(interval.end, quote);
  if (startKnown && endKnown) return true;
  if ((!startKnown && !endKnown) || !dateSurface || !quote.includes(dateSurface)) return false;
  const duration = /^(\d+)\s*(days?|weeks?|months?|years?|天|周|月|年)$/iu.exec(dateSurface.trim());
  if (!duration || !Number.isSafeInteger(Number(duration[1]))) return false;
  const value = Number(duration[1]); const unit = duration[2].toLowerCase();
  const anchor = new Date(endKnown ? interval.end : interval.start); const direction = endKnown ? -1 : 1;
  if (/^(?:months?|月)$/u.test(unit)) anchor.setUTCMonth(anchor.getUTCMonth()+direction*value);
  else if (/^(?:years?|年)$/u.test(unit)) anchor.setUTCFullYear(anchor.getUTCFullYear()+direction*value);
  else anchor.setUTCDate(anchor.getUTCDate()+direction*value*(/^(?:weeks?|周)$/u.test(unit)?7:1));
  return Number.isFinite(anchor.getTime()) && anchor.getTime() === Date.parse(endKnown ? interval.start : interval.end);
}

/** The longest second quotation a date may rest on: a header line, not a paragraph. */
export const DATE_QUOTE_MAX = 200;

/**
 * A date the fact's own quotation does not print may rest on a second verbatim quotation from the same document that prints it whole,
 * with its year: the stated date of the record the fact was read in (`dateQuote`). The date is still found in text the document holds
 * word for word; nothing outside the document (an upload time, a dataset year, a file's date) and no short form (`3/14`) supplies it.
 * @param {string} value the claimed date @param {...(string|null|undefined)} quotes the fact's quotation, then its date quotation
 */
export function clinicalDateInEvidence(value, ...quotes) {
  return quotes.some((quote) => typeof quote === 'string' && quote !== '' && clinicalDateInQuote(value, quote));
}

/**
 * The longest line a record header may be, and the most that may stand on it besides its date: a header is a label and a date, not a sentence.
 * Read off the 202 n2c2 training files: of the 1,197 lines that print exactly one date, 1,125 have 24 characters or fewer besides it (the record
 * headers are 12), and the lines with 25 or more are, all but one, five words or longer.
 */
export const RECORD_HEADER_LINE_MAX = 80;
export const RECORD_HEADER_LABEL_MAX = 24;

/** A birth date has a header's shape and dates nothing: the one label a header's format cannot tell apart, and a closed list of its names. */
const BIRTH_LABEL = /\b(?:d\.?o\.?b\.?|birth\s*date|date\s+of\s+birth|born)\b|出生|生日/i;

/**
 * One line of a document read as a record header: it prints exactly one complete date, with its year, and what is left of the line once the
 * date is taken out is a short label that is not a birth label. `null` for any other line. The line is trimmed as the document holds it.
 * @param {string} body @param {number} start where the line starts @param {number} lineEnd where it ends (its newline, or the end of the text)
 * @returns {{ date: string, start: number, end: number, quote: string, lineStart: number, dateEnd: number } | null} `dateEnd`: where the date ends in the document
 */
function headerOfLine(body, start, lineEnd) {
  const line = body.slice(start, lineEnd);
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > RECORD_HEADER_LINE_MAX) return null;
  const printed = clinicalDatesPrinted(trimmed);
  if (printed.length !== 1) return null;
  const label = `${trimmed.slice(0, printed[0].start)} ${trimmed.slice(printed[0].end)}`.replace(/\s+/g, ' ').trim();
  if (label.length > RECORD_HEADER_LABEL_MAX || BIRTH_LABEL.test(label)) return null;
  const from = start + line.indexOf(trimmed);
  return { date: printed[0].iso, start: from, end: from + trimmed.length, quote: trimmed, lineStart: start, dateEnd: from + printed[0].end };
}

/**
 * The header lines of a document, in the order of the text, leaving out the ones dated after `notAfter`. Built once per document and
 * kept (a write of two hundred facts of one chart reads the chart's lines once, not once for each fact): the key is the length and the
 * digest of the text, so the cache holds no patient text, only the header lines themselves (each at most `RECORD_HEADER_LINE_MAX`).
 * @param {string} body @param {number | null} notAfter
 */
function headerIndex(body, notAfter) {
  const base = `${body.length}:${createHash('sha1').update(body).digest('hex')}`;
  const key = notAfter === null ? base : `${base}:${notAfter}`;
  const kept = headerIndexes.get(key);
  if (kept) return kept;
  let all = headerIndexes.get(base);
  if (!all) {
    all = [];
    for (let start = 0; start <= body.length;) {
      const found = body.indexOf('\n', start);
      const lineEnd = found < 0 ? body.length : found;
      const header = headerOfLine(body, start, lineEnd);
      if (header) all.push(header);
      start = lineEnd + 1;
    }
    headerIndexes.set(base, all);
  }
  const index = notAfter === null ? all : all.filter((header) => Date.parse(header.date) <= notAfter);
  headerIndexes.set(key, index);
  // A write reads one or a few charts; the cache never holds more than a handful.
  while (headerIndexes.size > HEADER_INDEXES_KEPT) headerIndexes.delete(/** @type {string} */ (headerIndexes.keys().next().value));
  return index;
}
/** @type {Map<string, Array<NonNullable<ReturnType<typeof headerOfLine>>>>} */
const headerIndexes = new Map();
const HEADER_INDEXES_KEPT = 8;

/**
 * The record header above a position in a document: the nearest preceding line that prints one complete date, with its year, and
 * little else, so that what is left of the line once the date is taken out is a short label (「Record date: 2067-05-03」, 「记录日期：2026-07-01」,
 * 「2026-07-01 门诊记录」, 「入院日期：2026年3月4日 10:20」). It is a matter of the line's format, not of what the label says: a line that
 * prints two dates, or runs longer than a label, is a body sentence and is passed over, and nothing above the position means no header.
 * A fact with no date of its own takes this date (the owner's ruling of 2026-11-02): the header is the date of the record the fact sits in.
 * The line the position is on counts when it is header-shaped and prints its date before the position (「2067-05-03 HbA1c 8.5%」): that
 * line dates what follows its date, and a position in or before the date looks above, as it always did.
 * A line that prints a date later than the moment the document entered the platform (`notAfter`, an instant) is not a record's: it is a date
 * ahead (「下次复诊：2026-12-15」), and the scan passes over it like any body line.
 * @param {string} text the document @param {number} position where the fact's quotation starts
 * @param {{ notAfter?: number | null }} [moment]
 * @returns {{ date: string, start: number, end: number, quote: string } | null} the line, trimmed, as the document holds it
 */
export function clinicalRecordHeader(text, position, { notAfter = null } = {}) {
  const body = String(text ?? '');
  if (!Number.isInteger(position) || position <= 0) return null;
  const lineStart = body.lastIndexOf('\n', Math.min(position, body.length) - 1) + 1;
  const headers = headerIndex(body, typeof notAfter === 'number' && Number.isFinite(notAfter) ? notAfter : null);
  // The last header line that starts above the line the position is in: the lines are in the order of the text.
  let low = 0;
  let high = headers.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (headers[middle].lineStart < lineStart) low = middle + 1; else high = middle;
  }
  const own = headers[low]?.lineStart === lineStart && headers[low].dateEnd <= position ? headers[low] : null;
  const found = own ?? (low ? headers[low - 1] : null);
  if (!found) return null;
  const { date, start, end, quote } = found;
  return { date, start, end, quote };
}
