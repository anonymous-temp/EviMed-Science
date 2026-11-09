import assert from 'node:assert/strict';
import test from 'node:test';
import { containsNormalized, matchesAny, normalizeAnswer } from '../normalize.mjs';

const MU = '\u03bc'; // Greek mu is the normalized micro prefix.

/** [reply, expected, shouldMatch] — containsNormalized runs the same normalization on both sides. */
const CASES = [
  // 1. Unicode NFKC: full-width digits, letters, punctuation and percent become half-width.
  ['血压 １２０／８０ mmHg', '120/80 mmHg', true],
  ['剂量 ５ ｍｇ', '5 mg', true],
  ['浓度 50％', '50%', true],

  // 2. ASCII lower-case.
  ['HbA1c 7.8%', 'hba1c 7.8%', true],

  // 3. Chinese numerals, every maximal run, including inside a word.
  ['十二', '12', true],
  ['二十', '20', true],
  ['一百零五', '105', true],
  ['两千', '2000', true],
  ['三万五千', '35000', true],
  ['两', '2', true],
  ['十', '10', true],
  ['周三', '周3', true],
  ['二零二四年', '2024年', true],

  // 4. Times.
  ['6点半', '6:30', true],
  ['6点30分', '6:30', true],
  ['6点5分', '6:05', true],
  ['6点', '6:00', true],
  ['6点钟', '6:00', true],
  ['6:30', '6:30', true],
  ['下午三点半', '3:30', true],

  // 5. Thousands separators: only a comma between groups of exactly three digits.
  ['1,000 mg', '1000 mg', true],
  ['12,500', '12500', true],
  ['1,234,567', '1234567', true],
  ['1,00', '100', false],
  ['12,34', '1234', false],
  ['1,0000', '10000', false],

  // 6. Units, directly after a number, plus space removal before a unit or percent.
  ['500 毫克', '500mg', true],
  ['500mg', '500 毫克', true],
  ['25 微克', `25 ${MU}g`, true],
  ['25 mcg', `25 ${MU}g`, true],
  ['25 ug', `25 ${MU}g`, true],
  ['25 \u00b5g', `25 ${MU}g`, true],
  ['5 克', '5 g', true],
  ['250 毫升', '250 ml', true],
  ['1.5 升', '1.5 l', true],
  ['70 公斤', '70 kg', true],
  ['70 千克', '70 kg', true],
  ['三千克', '3 kg', true],
  ['10 厘米', '10 cm', true],
  ['10 毫米', '10 mm', true],
  ['5 毫摩尔/升', '5 mmol/L', true],
  ['5 mmol/L', '5 毫摩尔/升', true],
  ['2000 国际单位', '2000 IU', true],
  ['2000 IU', '2000 国际单位', true],
  ['2 mg', '2mg', true],
  ['7.8 %', '7.8%', true],

  // 7. Whitespace collapse and trim.
  ['  blood   pressure\t120/80  ', 'blood pressure 120/80', true],
  ['2   毫克', '2mg', true],

  // Must never match: a different numeric value, a lost digit, a shifted percent, a prefix dose.
  ['0.25', '0.5', false],
  ['12', '1.2', false],
  ['NCT01234567', 'NCT0123467', false],
  ['PMID: 12345678', 'PMID: 12345670', false],
  ['7.8%', '78%', false],
  ['2 mg', '20 mg', false],

  // Empty and whitespace-only needles never match.
  ['anything', '', false],
  ['anything', '   ', false],
  ['anything', '\n\t', false],
  ['', '', false],
];

test('each normalization step produces the documented form', () => {
  // 1 + 2: NFKC first, then only ASCII letters are lower-cased.
  assert.equal(normalizeAnswer('ＡＢＣ　１２３％'), 'abc 123%');
  assert.equal(normalizeAnswer('ÉCOLE ＡＢＣ'), 'École abc');

  // 3: positional runs, digit-only runs (a year), and runs inside words.
  assert.equal(
    normalizeAnswer('十二 二十 一百零五 两千 三万五千 两 十 周三 二零二四'),
    '12 20 105 2000 35000 2 10 周3 2024',
  );

  // 4: half past, minutes padded to two digits, a bare hour, and an existing H:MM time.
  assert.equal(
    normalizeAnswer('6点半 6点30分 6点5分 6点 6点钟 6:30'),
    '6:30 6:30 6:05 6:00 6:00 6:30',
  );

  // 5: commas removed only between exactly three-digit groups.
  assert.equal(
    normalizeAnswer('1,000 12,500 1,234,567 1,00 12,34 1,0000'),
    '1000 12500 1234567 1,00 12,34 1,0000',
  );

  // 6: every listed unit, with the micro prefix normalized to Greek mu.
  assert.equal(
    normalizeAnswer(
      '500 毫克 25 微克 25 mcg 25 ug 25 \u00b5g 5 克 250 毫升 1.5 升 70 公斤 70 千克 '
        + '10 厘米 10 毫米 5 毫摩尔/升 2000 国际单位',
    ),
    `500mg 25${MU}g 25${MU}g 25${MU}g 25${MU}g 5g 250ml 1.5l 70kg 70kg 10cm 10mm 5mmol/l 2000iu`,
  );

  // 7: runs of any whitespace collapse to one space and the ends are trimmed.
  assert.equal(normalizeAnswer('  blood \n\t pressure  '), 'blood pressure');
});

test('the reply/expected table agrees with containsNormalized', () => {
  assert.ok(CASES.length >= 30, `need at least 30 cases, got ${CASES.length}`);
  for (const [reply, expected, shouldMatch] of CASES) {
    assert.equal(
      containsNormalized(reply, expected),
      shouldMatch,
      `${JSON.stringify(reply)} vs ${JSON.stringify(expected)}`,
    );
  }
});

test('identifiers and decimals keep every digit', () => {
  assert.equal(normalizeAnswer('NCT01234567'), 'nct01234567');
  assert.equal(normalizeAnswer('PMID: 12345678'), 'pmid: 12345678');
  assert.equal(normalizeAnswer('0.25'), '0.25');
  assert.equal(normalizeAnswer('12'), '12');
});

test('units convert only immediately after a number', () => {
  assert.equal(normalizeAnswer('bug package'), 'bug package');
  assert.equal(normalizeAnswer('5 good'), '5 good');
  assert.equal(normalizeAnswer('5 毫克'), '5mg');
});

test('empty and whitespace-only needles never match', () => {
  for (const needle of ['', ' ', '   ', '\n\t']) {
    assert.equal(containsNormalized('anything', needle), false);
  }
  assert.equal(containsNormalized('', ''), false);
});

test('matchesAny is true for any matching needle and false otherwise', () => {
  assert.equal(matchesAny('HbA1c 7.8%', ['nope', 'hba1c 7.8%']), true);
  assert.equal(matchesAny('HbA1c 7.8%', ['78%']), false);
  assert.equal(matchesAny('2 mg', ['0.5', '20 mg']), false);
  assert.equal(matchesAny('anything', []), false);
  assert.equal(matchesAny('anything', ['', '   ']), false);
});

test('spoken shorthand after 百/千/万 is the next place down, never a units digit', async () => {
  const { normalizeAnswer, containsNormalized } = await import('../normalize.mjs');
  for (const [zh, n] of [['一万二', '12000'], ['三千五', '3500'], ['两百五', '250'], ['两千三百五', '2350'], ['一百零五', '105'], ['十二', '12'], ['三万五千', '35000'], ['二十', '20']]) assert.equal(normalizeAnswer(zh), n, zh);
  assert.equal(containsNormalized('每月一万二左右', '12000'), true);
  assert.equal(containsNormalized('每月一万二左右', '10002'), false);
});
