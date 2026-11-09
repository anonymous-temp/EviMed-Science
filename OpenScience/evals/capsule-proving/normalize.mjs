/**
 * Surface-form normalization for code-decided answer checks: the same dose, lab value, time or id written another way.
 * Both the reply and the expected string go through the same deterministic rules, so a check never fails on form alone
 * and never turns one value into a different value.
 * @module capsule-proving/normalize
 */

const CHINESE_DIGITS = new Map([
  ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4],
  ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
]);
const CHINESE_UNITS = new Map([['十', 10], ['百', 100], ['千', 1000], ['万', 10000]]);
const CHINESE_NUMERAL_RUN = /[零〇一二两三四五六七八九十百千万]+/g;
const MICRO_GRAM = '\u03bcg';
// 千克 is a unit but its second character is a numeral. Shield it from step 3 so step 6 can still produce kg;
// unlike a placeholder this leaves 三千克 as 3 kg rather than 3000 g.
const KILOGRAM_TOKEN = '\u0000kilogram-unit\u0000';

/**
 * Convert one maximal run of Chinese numerals. Runs with units use positional values (三万五千 → 35000); runs made only
 * of digits concatenate, so a year such as 二零二四 becomes 2024 rather than 4.
 * @param {string} run
 * @returns {string}
 */
function chineseRunToArabic(run) {
  if (![...run].some((char) => CHINESE_UNITS.has(char))) {
    return [...run].map((char) => CHINESE_DIGITS.get(char)).join('');
  }
  let total = 0;
  let section = 0;
  let number = 0;
  let lastUnit = 0;
  const chars = [...run];
  for (const char of chars) {
    if (CHINESE_DIGITS.has(char)) {
      number = CHINESE_DIGITS.get(char);
      continue;
    }
    lastUnit = CHINESE_UNITS.get(char);
    const unit = CHINESE_UNITS.get(char);
    if (unit === 10000) {
      section += number;
      total += (section || 1) * unit;
      section = 0;
    } else {
      section += (number || 1) * unit;
    }
    number = 0;
  }
  // Spoken shorthand: a digit straight after 百/千/万 is the next place down (一万二 → 12000, 三千五 → 3500, 两百五 → 250);
  // after 零 it is the units (一百零五 → 105).
  const trailing = chars.length >= 2 && CHINESE_UNITS.has(chars.at(-2)) && lastUnit >= 100 ? number * (lastUnit / 10) : number;
  return String(total + section + trailing);
}

// Chinese units are listed before their suffixes so 毫克/毫升/千克 are never read as 克/升. Latin units carry a word
// boundary so "bug" is not rewritten as "bμg".
const UNIT_VALUES = new Map([
  ['毫摩尔/升', 'mmol/l'], ['毫克', 'mg'], ['毫升', 'ml'], ['千克', 'kg'], ['公斤', 'kg'],
  ['微克', MICRO_GRAM], ['厘米', 'cm'], ['毫米', 'mm'], ['克', 'g'], ['升', 'l'], ['国际单位', 'iu'],
  ['mcg', MICRO_GRAM], ['ug', MICRO_GRAM], ['\u00b5g', MICRO_GRAM], [MICRO_GRAM, MICRO_GRAM],
  ['mmol/l', 'mmol/l'],
]);
const UNIT_SOURCE = '毫摩尔\\/升|毫克|毫升|千克|公斤|微克|厘米|毫米|克|升|国际单位'
  + '|mcg(?![a-z])|ug(?![a-z])|\\u00b5g(?![a-z])|\\u03bcg(?![a-z])|mmol\\/l(?![a-z])';
const UNIT_RE = new RegExp(`(\\d)[ \\t]*(${UNIT_SOURCE})`, 'g');

// After conversion, drop horizontal space between a number and a unit or %. The unit needs a word boundary so
// "5 good" is not glued into "5good".
const UNIT_LOOKAHEAD = 'mg|mcg|ug|\\u03bcg|\\u00b5g|g|ml|l|kg|cm|mm|mmol\\/l|iu';
const SPACE_BEFORE_UNIT_RE = new RegExp(`(\\d)[ \\t]+(?=(?:${UNIT_LOOKAHEAD})(?![a-z])|%)`, 'g');

/**
 * Normalize answer text to a comparable surface form: NFKC, ASCII lower-case, Chinese numerals, times, thousands
 * separators, units and whitespace, in that order.
 * @param {string} text
 * @returns {string}
 */
export function normalizeAnswer(text) {
  let out = String(text ?? '').normalize('NFKC');
  out = out.replace(/[A-Z]/g, (char) => char.toLowerCase());
  out = out.replaceAll('千克', KILOGRAM_TOKEN);
  out = out.replace(CHINESE_NUMERAL_RUN, chineseRunToArabic);
  out = out.replaceAll(KILOGRAM_TOKEN, '千克');
  out = out
    .replace(/(\d{1,2})点半/g, (_, hours) => `${hours}:30`)
    .replace(/(\d{1,2})点(\d{1,2})分?/g, (_, hours, minutes) => `${hours}:${String(Number(minutes)).padStart(2, '0')}`)
    .replace(/(\d{1,2})点(?:钟)?/g, (_, hours) => `${hours}:00`);
  out = out.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  out = out.replace(UNIT_RE, (_, digit, unit) => digit + UNIT_VALUES.get(unit));
  out = out.replace(SPACE_BEFORE_UNIT_RE, '$1');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Whether `haystack` contains `needle` once both are normalized; an empty or whitespace-only needle never matches.
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
export function containsNormalized(haystack, needle) {
  const wanted = normalizeAnswer(needle);
  return wanted.length > 0 && normalizeAnswer(haystack).includes(wanted);
}

/**
 * Whether any needle occurs in `haystack` once both are normalized.
 * @param {string} haystack
 * @param {string[]} needles
 * @returns {boolean}
 */
export function matchesAny(haystack, needles) {
  return (needles ?? []).some((needle) => containsNormalized(haystack, needle));
}
