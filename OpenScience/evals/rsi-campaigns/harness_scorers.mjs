/**
 * The scorers a harness-patch campaign may name (2026-11-01): the four of skill_scorers.mjs, unchanged and by reference, and
 * two more. `registration.scorer` holds an id of the frozen table below (there is no default: a harness registration names
 * its scorer), and an id outside it is refused with `campaign_scorer_not_qualified`. The table is closed in the same sense
 * as skill_scorers.mjs: no executable path, no dynamic import, no function handed in by the caller. The scorer id is bound
 * into the consumer identity (harness_campaign.mjs), so a registration made for one scorer cannot be replayed under another.
 *
 *  - `mbc-normalized`  MedBrowseComp, the deterministic part of evals/public-benchmarks/tools/score_shortanswer.py, rule for
 *                      rule. A case the rules cannot settle (`needs_judge`: a salt form, a near-typo, a date or a price that
 *                      is not on the labelled line) counts as NOT correct, so the score is a floor of the judged one — the
 *                      same rule bixbench-deterministic applies.
 *  - `judged-verdicts` a run's score comes from digested verdict records written by a judge outside the solver's family
 *                      (the source's `judged` section, checked by harness_campaign.mjs), averaged over the judge's passes;
 *                      no code reads an answer. A run that did not deliver scores 0 and has no verdict.
 *
 * `tests/fixtures/scorer-vectors.json` holds synthetic inputs with score_shortanswer.py's outputs; tests/harnessScorers.test.mjs
 * asserts the JS port reproduces them.
 */
import { SKILL_SCORERS, sequenceRatio } from './skill_scorers.mjs';

const isText = (value) => typeof value === 'string';
/** Python's str.splitlines(), as skill_scorers.mjs reads lines. @param {string} text */
const splitLines = (text) => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);

// ---------------------------------------------------------------------------------------------------------------- mbc

const LEGAL = new Set(['INC', 'LTD', 'LLC', 'LP', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LIMITED', 'PLC', 'AG', 'GMBH', 'SA', 'US', 'USA', 'THE', 'OF', 'AND']);
const MONTHS = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });
const NA_WORDS = ['NA', 'N/A', 'N-A', 'NONE', 'NOT AVAILABLE', 'NOT APPLICABLE', 'NO EXCLUSIVITY', 'NULL'];

/** score_shortanswer.strip_md. @param {any} text */
const stripMd = (text) => String(text ?? '').replace(/[*`_]{1,3}/g, '').trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '').trim();
/** score_shortanswer.normalise. @param {any} text */
const normalise = (text) => stripMd(text).toUpperCase().replaceAll('&', ' AND ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** @param {any} text @param {Set<string>} [drop] @returns {Set<string>} */
const tokenSet = (text, drop = new Set()) => new Set(normalise(text).split(' ').filter((token) => token && !drop.has(token)));
const subset = (a, b) => [...a].every((token) => b.has(token));
const sameSet = (a, b) => a.size === b.size && subset(a, b);
const bestRatio = (a, b) => sequenceRatio(normalise(a), normalise(b));
const tail = (text, n) => String(text ?? '').slice(-n);
const verdictOf = (verdict, extraction, extracted, why) => ({ verdict, extraction, extracted, why });

/** The text after the last `<label>:` on a line, or null. @param {string} text @param {string} labelPattern */
function lastLabel(text, labelPattern) {
  const pattern = new RegExp(`^[\\s>*\\-#\\d.)]*\\**\\s*(?:${labelPattern})\\s*\\**\\s*[:：]\\s*\\**\\s*(.+)$`, 'gim');
  const hits = [...String(text ?? '').matchAll(pattern)].map((match) => match[1]);
  for (const hit of hits.reverse()) { const cleaned = stripMd(hit); if (cleaned) return cleaned; }
  return null;
}

/** One calendar date in a string as [year, month, day], or null. @param {any} text @returns {number[] | null} */
function parseDate(text) {
  const s = stripMd(text);
  let m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(s);
  if (m) { const a = Number(m[1]), b = Number(m[2]); if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return [Number(m[3]), a, b]; }
  m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s);
  if (m && Object.hasOwn(MONTHS, m[1].toLowerCase())) return [Number(m[3]), MONTHS[/** @type {keyof typeof MONTHS} */ (m[1].toLowerCase())], Number(m[2])];
  m = /\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})\b/.exec(s);
  if (m && Object.hasOwn(MONTHS, m[2].toLowerCase())) return [Number(m[3]), MONTHS[/** @type {keyof typeof MONTHS} */ (m[2].toLowerCase())], Number(m[1])];
  return null;
}
const sameDate = (a, b) => a !== null && b !== null && a.join('-') === b.join('-');
const NA_NORMALISED = new Set(NA_WORDS.map(normalise));
const isNa = (text) => { const n = normalise(text); return NA_NORMALISED.has(n) || /^(DATE )?N ?\/? ?A$/.test(n) || n.startsWith('NA '); };
/** Python's \w is letters, digits and the underscore of any script. */
const NUMBER = /(?<![\p{L}\p{N}_.])\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/gu;
const numbers = (text) => [...String(text ?? '').matchAll(NUMBER)].map((match) => Number(match[1].replaceAll(',', '')));

function scoreName(text, gold, labelPattern, drop) {
  let extracted = lastLabel(text, labelPattern), extraction = 'label';
  if (extracted === null) {
    const lines = splitLines(String(text ?? '').trim()).filter((line) => line.trim());
    extracted = lines.length ? stripMd(lines.at(-1)) : '';
    extraction = 'fallback';
  }
  const g = tokenSet(gold, drop), a = tokenSet(extracted, drop);
  if (!a.size || ['UNKNOWN', 'NONE', 'NA', 'N A'].includes(normalise(extracted))) return verdictOf('incorrect', extraction, extracted, 'no answer / unknown');
  if (extraction === 'label') {
    if (sameSet(a, g)) return verdictOf('correct', extraction, extracted, 'token sets equal');
    if (subset(a, g) || subset(g, a) || bestRatio(extracted, gold) >= 0.85) return verdictOf('needs_judge', extraction, extracted, 'partial overlap (salt/legal form or near-typo)');
    return verdictOf('incorrect', extraction, extracted, 'different name');
  }
  if (g.size && subset(g, tokenSet(tail(text, 400), drop))) return verdictOf('needs_judge', extraction, extracted, 'gold tokens appear in the closing text but no labelled answer line');
  return verdictOf('incorrect', extraction, extracted, 'no labelled answer and gold not in the closing text');
}

function scorePatentYear(text, gold) {
  const goldDate = parseDate(gold), goldYear = goldDate ? goldDate[0] : null;
  let extracted = lastLabel(text, 'date|YYYY|year|patent expiration(?: date)?|patent expiry'), extraction = 'label';
  if (extracted === null) { extracted = tail(text, 300); extraction = 'fallback'; }
  const years = [...extracted.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((match) => match[1]);
  if (!years.length) return verdictOf('incorrect', extraction, extracted.slice(0, 120), 'no year given');
  if (extraction === 'label') {
    const date = parseDate(extracted);
    const year = date ? date[0] : Number(new Set(years).size === 1 ? years.at(-1) : years[0]);
    return verdictOf(year === goldYear ? 'correct' : 'incorrect', extraction, extracted.slice(0, 120), `answer year ${year} vs gold year ${goldYear}`);
  }
  if (years.includes(String(goldYear))) return verdictOf('needs_judge', extraction, extracted.slice(0, 120), "gold year appears in the closing text but no 'date:' line");
  return verdictOf('incorrect', extraction, extracted.slice(0, 120), 'no labelled date and gold year not in the closing text');
}

function scoreExclusivity(text, gold) {
  let extracted = lastLabel(text, 'date|exclusivity date|exclusivity'), extraction = 'label';
  if (extracted === null) { extracted = tail(text, 300); extraction = 'fallback'; }
  if (gold === '') {
    if (extraction === 'label') return verdictOf(isNa(extracted) && !parseDate(extracted) ? 'correct' : 'incorrect', extraction, extracted.slice(0, 120), 'gold: no exclusivity date');
    return verdictOf(/\bN\/?A\b|no exclusivity|not available/i.test(extracted) ? 'needs_judge' : 'incorrect', extraction, extracted.slice(0, 120), "gold: no exclusivity date; no 'date:' line");
  }
  const goldDate = parseDate(gold), answered = parseDate(extracted);
  if (answered === null) return verdictOf('incorrect', extraction, extracted.slice(0, 120), isNa(extracted) ? 'answered NA, gold has a date' : 'no date given');
  if (extraction === 'label') return verdictOf(sameDate(answered, goldDate) ? 'correct' : 'incorrect', extraction, extracted.slice(0, 120), 'dated answer');
  return verdictOf(sameDate(answered, goldDate) ? 'needs_judge' : 'incorrect', extraction, extracted.slice(0, 120), 'unlabelled date');
}

function scoreOpenPrice(text, gold) {
  const region = tail(text, 500), notListed = /not[\s_-]*listed/i.test(region);
  if (gold.toLowerCase().replaceAll('_', ' ') === 'not listed') {
    const inRegion = numbers(region).filter((n) => n !== 0);
    if (notListed && !/\$\s?\d|price/i.test(region)) return verdictOf('correct', 'label', region.slice(-160), 'NOT LISTED');
    if (notListed) return verdictOf('needs_judge', 'label', region.slice(-160), 'NOT LISTED mentioned together with a price');
    return verdictOf(inRegion.length ? 'incorrect' : 'needs_judge', 'fallback', region.slice(-160), 'gold NOT LISTED; answer gives a price or nothing clear');
  }
  const g = Number(gold), tolerance = Math.max(0.011, 0.005 * g);
  if (numbers(region).some((n) => Math.abs(n - g) <= tolerance)) return verdictOf('correct', 'label', region.slice(-160), 'price within tolerance');
  if (notListed) return verdictOf('incorrect', 'label', region.slice(-160), 'answered NOT LISTED; gold has a price');
  if (numbers(text).some((n) => Math.abs(n - g) <= tolerance)) return verdictOf('needs_judge', 'fallback', region.slice(-160), 'gold price appears earlier in a long answer, not in the closing region');
  return verdictOf('incorrect', 'label', region.slice(-160), 'no number within tolerance');
}

const MBC_TASKS = Object.freeze({
  Ingredient: (text, gold) => scoreName(text, gold, 'INGREDIENT|ACTIVE INGREDIENT', new Set()),
  Applicant_Full_Name: (text, gold) => scoreName(text, gold, 'COMPANY|APPLICANT', LEGAL),
  Patent_Expire_Date_Text: scorePatentYear,
  Exclusivity_Date: scoreExclusivity,
  Open_on_Approval: scoreOpenPrice,
});

/**
 * score_shortanswer.score: `correct | incorrect | needs_judge` with how the answer was read.
 * @param {string | null} text @param {{ task_name: string, answer: string }} gold
 */
export function mbcVerdict(text, gold) {
  return MBC_TASKS[/** @type {keyof typeof MBC_TASKS} */ (gold.task_name)](String(text ?? ''), gold.answer);
}
/** The run's score: 1 when the rules settle it as correct, else 0 (a case for a judge is a floor, not a credit). @param {string | null} text @param {{ gold: { task_name: string, answer: string } }} row */
export const mbcScore = (text, row) => (mbcVerdict(text, row.gold).verdict === 'correct' ? 1 : 0);

const mbcRow = (row) => isText(row?.task) && isText(row?.gold?.task_name) && Object.hasOwn(MBC_TASKS, row.gold.task_name) && row.task === row.gold.task_name && isText(row.gold.answer)
  && (row.gold.task_name !== 'Open_on_Approval' || row.gold.answer.toLowerCase().replaceAll('_', ' ') === 'not listed' || Number.isFinite(Number(row.gold.answer)) && row.gold.answer.trim() !== '');

// ------------------------------------------------------------------------------------------------------------- judged

/**
 * What a judged run scores: the mean of its passes' verdict scores (harness_campaign.mjs `judgedVerdicts`). A run that did not
 * deliver scores 0. In a pairwise comparison the baseline is the reference of every comparison and scores 0.5 by definition
 * (a candidate's score is its preference share, 0.5 being parity). A run that delivered and has no verdict is an error, never
 * a zero: the source validation refuses it before this is called.
 * @param {string | null} _answer @param {any} _row @param {{ arm: string, status: string, row: string, repeat: number }} run
 * @param {{ form: string, get: (run: any) => number | undefined }} verdicts
 */
export function judgedScore(_answer, _row, run, verdicts) {
  if (verdicts.form === 'pairwise' && run.arm === 'baseline') return 0.5;
  if (run.status !== 'succeeded') return 0;
  const score = verdicts.get(run);
  if (score === undefined) throw new Error('harness_verdict_missing');
  return score;
}
const judgedRow = (row) => isText(row?.id) && row.id.length > 0 && isText(row?.category) && row.category.length > 0;

// -------------------------------------------------------------------------------------------------------------- registry

const stratum = Object.freeze({ registration: 'failureSlice', key: String, valid: (id) => isText(id) && id.length > 0 });

/**
 * id -> { id, benchmark, benchmarks (the `benchmark` a source may say), family (the statistics family label; null: the
 * registration names it), baselineRevision, slice, validRow, score[, judged] }. The first four are skill_scorers.mjs's own
 * entries, the same objects.
 */
export const HARNESS_SCORERS = Object.freeze({
  ...SKILL_SCORERS,
  'mbc-normalized': Object.freeze({ id: 'mbc-normalized', benchmark: 'medbrowsecomp', benchmarks: Object.freeze(['medbrowsecomp']), family: 'mbc', baselineRevision: 'mbc-normalized-no-harness-patch',
    slice: Object.freeze({ ...stratum, row: 'task' }), validRow: mbcRow, score: mbcScore }),
  'judged-verdicts': Object.freeze({ id: 'judged-verdicts', benchmark: null, benchmarks: Object.freeze(['deepresearchbench', 'researchclawbench', 'bixbench']), family: null, baselineRevision: 'judged-verdicts-no-harness-patch',
    slice: Object.freeze({ ...stratum, row: 'category' }), validRow: judgedRow, score: judgedScore, judged: true }),
});

/** The benchmarks a scorer's sources may say. @param {{ benchmark: string | null, benchmarks?: readonly string[] }} scorer */
export const scorerBenchmarks = (scorer) => scorer.benchmarks ?? [scorer.benchmark];

/**
 * The scorer a harness registration names; a harness registration always names one. An id outside the table, or a
 * registration that names none, is null.
 * @param {any} [registration]
 */
export function harnessScorer(registration) {
  const id = registration?.scorer;
  return typeof id === 'string' && Object.hasOwn(HARNESS_SCORERS, id) ? HARNESS_SCORERS[/** @type {keyof typeof HARNESS_SCORERS} */ (id)] : null;
}
