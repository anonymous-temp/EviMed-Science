/**
 * The scorers a capability-skill campaign may name (2026-10-31). `registration.scorer` holds an id from the frozen table
 * below (absent means `medcalc`, which is what every campaign before this file was). This is the "Closed consumer registry"
 * of campaign_runner.mjs applied inside the consumer: no executable path, no dynamic import, no function handed in by the
 * caller, and an id that is not a key of SKILL_SCORERS is refused with `campaign_scorer_not_qualified`. The scorer id is
 * bound into the consumer identity (skill_campaign.mjs), so a registration made for one scorer cannot be replayed under
 * another, and a change to this file is a new identity.
 *
 * Every scorer here is deterministic code over a recorded final answer and the row's gold, with no model call and no
 * network: a re-run gives the same bytes. A surface that needs a model judge (open-ended answers, rubrics, research
 * reports) does not belong in this table; evals/rsi-campaigns/README.md says what such a consumer would have to bring.
 *
 * A scorer returns a number in [0, 1] for one run: 0 for a run that has no answer. Rows are `{id, <slice field>, gold}`.
 * The ports below follow the published Python scorers of evals/public-benchmarks/tools (score_bixbench.py, score_arb.py)
 * and tests/fixtures/scorer-vectors.json holds their outputs on synthetic inputs, checked from both sides.
 */

/** Calculator ids by output type, as MedCalc-Bench's evaluate.py lists them. */
const DATE_IDS = new Set([13, 68]);
const WEEKS_DAYS_IDS = new Set([69]);
const INTEGER_IDS = new Set([4, 15, 16, 17, 18, 20, 21, 25, 27, 28, 29, 32, 33, 36, 43, 45, 48, 51]);
const DECIMAL_IDS = new Set([2, 3, 5, 6, 7, 8, 9, 10, 11, 19, 22, 23, 24, 26, 30, 31, 38, 39, 40, 44, 46, 49, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67]);

// ------------------------------------------------------------------------------------------------------------ medcalc

/**
 * The value a free-text answer states: the last line carrying 「最终答案」 or "Final answer", else the last line of the
 * answer. Markdown emphasis and a trailing unit are dropped; what is left is parsed by the row's output type.
 * @param {string | null} text @returns {string | null}
 */
export function statedAnswer(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[*_`#>]/g, '').trim()).filter(Boolean);
  const marked = lines.filter((line) => /最终答案|final\s*answer/i.test(line));
  const line = (marked.at(-1) ?? lines.at(-1) ?? '').replace(/^.*?(最终答案|final\s*answer)\s*[:：]?\s*/i, '');
  return line.trim() || null;
}

const firstNumber = (text) => {
  const match = String(text).replace(/,(?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/i);
  return match ? Number(match[0]) : null;
};

/**
 * evaluate.py's check_correctness over a stated answer. An answer that cannot be read as the row's type is wrong, as a
 * failed eval() is in the original harness.
 * @param {string | null} answerText the run's final answer (free text)
 * @param {{ calculatorId: number, gold: { answer: string, lower: string | null, upper: string | null } }} row
 * @returns {0 | 1}
 */
export function medcalcCorrect(answerText, row) {
  const stated = statedAnswer(answerText);
  if (stated === null) return 0;
  const id = Number(row.calculatorId);
  if (DATE_IDS.has(id)) {
    const date = (value) => { const m = String(value).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${Number(m[1])}/${Number(m[2])}/${m[3]}` : null; };
    const got = date(stated);
    return got !== null && got === date(row.gold.answer) ? 1 : 0;
  }
  if (WEEKS_DAYS_IDS.has(id)) {
    const pair = (value) => { const m = String(value).match(/\(?["']?(\d+)\s*(?:weeks?|周)?["']?,?\s*["']?(\d+)\s*(?:days?|天)?["']?\s*\)?/i); return m ? `${Number(m[1])},${Number(m[2])}` : null; };
    const got = pair(stated);
    return got !== null && got === pair(row.gold.answer) ? 1 : 0;
  }
  const value = firstNumber(stated);
  if (value === null || !Number.isFinite(value)) return 0;
  if (INTEGER_IDS.has(id)) return Math.round(value) === Math.round(Number(row.gold.answer)) ? 1 : 0;
  if (DECIMAL_IDS.has(id)) {
    const lower = Number(row.gold.lower), upper = Number(row.gold.upper);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return 0;
    return value >= lower && value <= upper ? 1 : 0;
  }
  throw new Error(`unknown calculator id ${id}`);
}

const medcalcRow = (row) => {
  const id = Number(row?.calculatorId);
  return (DATE_IDS.has(id) || WEEKS_DAYS_IDS.has(id) || INTEGER_IDS.has(id) || DECIMAL_IDS.has(id)) && typeof row?.gold?.answer === 'string';
};

// ---------------------------------------------------------------------------------------------------------- text helpers

/** Python's str.splitlines(): the separators it splits on, so a port reads the same lines. @param {string} text */
const splitLines = (text) => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
const isText = (value) => typeof value === 'string';
const isTexts = (value) => Array.isArray(value) && value.every(isText);

// -------------------------------------------------------------------------------------------------------------- bixbench

const BIX_FINAL = /final\s*answers?\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*$/gim;
const BIX_LINE = /^\s*(?:[-*>]\s*)?\**\s*(\d{1,2})\s*[.):]\s*\**\s*(.*)$/;
// Python's \w (letters, digits and the underscore of any script) in the look-behind. Digits are ASCII only: Python also reads another script's digits
// ("١٢" is 12 to its \d and float()), the port does not, which can only miss a credit and never grants one.
const BIX_NUMBER = /(?<![\p{L}\p{N}_.])[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?/gu;
const BIX_MODES = new Set(['range_verifier', 'str_verifier', 'llm_verifier']);
const stripMarkdown = (text) => String(text ?? '').replace(/[*`_]+/g, '').trim();

/**
 * score_bixbench.py parse_answers: the text after the LAST line "Final answers:" (the whole reply when there is none),
 * lines "<n>. <answer>" / "<n>) <answer>" / "<n>: <answer>" start answer n and unnumbered lines continue it.
 * @param {string | null} text @returns {{ answers: Map<number, string>, extraction: 'final' | 'fallback' }}
 */
export function bixbenchAnswers(text) {
  const reply = isText(text) ? text : '';
  const last = [...reply.matchAll(BIX_FINAL)].at(-1);
  const region = last ? reply.slice(last.index + last[0].length) : reply;
  /** @type {Map<number, string>} */ const raw = new Map();
  let current = null;
  for (const line of splitLines(region)) {
    const numbered = BIX_LINE.exec(line);
    if (numbered) { current = Number(numbered[1]); raw.set(current, numbered[2].trim()); }
    else if (current !== null && line.trim()) raw.set(current, `${raw.get(current)} ${line.trim()}`);
  }
  return { answers: new Map([...raw].map(([n, answer]) => [n, stripMarkdown(answer)])), extraction: last ? 'final' : 'fallback' };
}

const numbersIn = (text) => [...String(text ?? '').replace(/\u2212/g, '-').matchAll(BIX_NUMBER)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => !Number.isNaN(n));
const alnum = (text) => String(text ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

/** A question the deterministic verifiers can settle: a string match, or a range the dataset gave in full. @param {any} question */
export const bixbenchDeterministic = (question) => question.eval_mode === 'str_verifier' || (question.eval_mode === 'range_verifier' && Array.isArray(question.range));

/**
 * The verdict for one question under the benchmark's own graders (Future-House/BixBench, bixbench/graders.py):
 *  - str_verifier, open answers (`partial_match=True`): the answer and the ideal compared after keeping only [a-zA-Z0-9]
 *    lower-cased, equal -> correct, or the answer a substring of the ideal -> correct; the official code then asks an LLM,
 *    here that is `needs_judge`. An EMPTY cleaned answer is never correct (official code: "" in target is true, so a reply
 *    with no answer would score) — the one deliberate deviation. The partial rule is the official one and lets a short
 *    answer ("1") match a longer ideal ("166"); it is reported as it is.
 *  - range_verifier: the official deterministic check is lower <= float(answer) <= upper; the open-answer harness gives a
 *    free-text answer to an LLM instead, so the number is read out of the text (the FIRST number, as score_bixbench.py
 *    does): inside the range -> correct; outside but a later number inside -> needs_judge; else incorrect.
 *  - llm_verifier (and a range the dataset did not give): needs_judge, never decided here.
 * @param {{ eval_mode: string, ideal: string, range?: number[] | null }} question @param {string | undefined} answer
 * @returns {'correct' | 'incorrect' | 'needs_judge'}
 */
export function bixbenchVerdict(question, answer) {
  if (answer === undefined || !answer.trim()) return 'incorrect';
  if (question.eval_mode === 'str_verifier') {
    const got = alnum(answer), want = alnum(question.ideal);
    if (!got) return 'incorrect';
    return got === want || want.includes(got) ? 'correct' : 'needs_judge';
  }
  if (question.eval_mode === 'range_verifier' && Array.isArray(question.range)) {
    const [lower, upper] = question.range, found = numbersIn(answer);
    if (!found.length) return 'incorrect';
    if (found[0] >= lower && found[0] <= upper) return 'correct';
    return found.slice(1).some((n) => n >= lower && n <= upper) ? 'needs_judge' : 'incorrect';
  }
  return 'needs_judge';
}

/**
 * A capsule run's score: the share of its deterministic questions answered correctly. A question a judge would have to
 * settle counts as not correct here, so this is a floor of the judged score and moves only with what code can see.
 * @param {string | null} answerText @param {{ gold: { questions: any[] } }} row
 */
export function bixbenchScore(answerText, row) {
  const { answers } = bixbenchAnswers(answerText);
  const questions = row.gold.questions.filter(bixbenchDeterministic);
  return questions.filter((question) => bixbenchVerdict(question, answers.get(question.n)) === 'correct').length / questions.length;
}

const bixbenchRow = (row) => isText(row?.topic) && Array.isArray(row?.gold?.questions) && row.gold.questions.some(bixbenchDeterministic)
  && new Set(row.gold.questions.map((q) => q?.n)).size === row.gold.questions.length && row.gold.questions.every((q) => Number.isInteger(q?.n) && isText(q?.qid) && BIX_MODES.has(q?.eval_mode) && isText(q?.ideal)
    && (q.range === null || q.range === undefined || (Array.isArray(q.range) && q.range.length === 2 && q.range.every(Number.isFinite) && q.range[0] <= q.range[1])));

// ------------------------------------------------------------------------------------------------------ autoresearchbench

const ARB_NEW_ID = /(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d])/g;
const ARB_OLD_ID = /(?<![A-Za-z-])([a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/gi;
const ARB_FINAL = /final\s*answer\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?/gi;
const ARB_NONE = /^(none|no paper(?:s)?(?: found| satisfies?.*)?|none found|n\/?a)\.?$/i;
const arbWords = (text) => text.split(/\s+/).filter(Boolean).length;

/** score_arb.py norm_title / norm_id / ids_in / clean_title, rule for rule. */
export const arbNormTitle = (text) => String(text ?? '').replace(/[*_`]+/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export function arbNormId(text) {
  let s = String(text ?? '').replace(/arxiv:/gi, '').trim().replace(/v\d+$/, '');
  const modern = new RegExp(ARB_NEW_ID.source).exec(s);
  if (modern) return modern[1];
  const old = new RegExp(ARB_OLD_ID.source, 'i').exec(s);
  return old ? old[1].toLowerCase() : s.trim().toLowerCase();
}
function arbIds(line) {
  const found = [...line.matchAll(ARB_NEW_ID)].map((m) => m[1]);
  for (const m of line.matchAll(ARB_OLD_ID)) {
    const id = m[1].toLowerCase();
    if (id.includes('/') && !id.startsWith('http') && !id.startsWith('arxiv.org')) found.push(id);
  }
  return [...new Set(found)];
}
function arbCleanTitle(line) {
  let s = line.trim();
  const link = /\[([^\]]+)\]\((?:https?:\/\/)?arxiv[^)]*\)/.exec(s);
  if (link) return link[1].trim();
  s = s.replace(/^[\s>*\-•#]*(?:\d+[.)]\s*)?/, '').replace(/\(?\s*arxiv\s*[:/].*$/i, '').replace(/\s[-–—|]\s*arxiv.*$/i, '').replace(/https?:\/\/\S+/g, '');
  return s.replace(/[*_`"“”]+/g, '').replace(/^[ .,;:\-–—[\]]+|[ .,;:\-–—[\]]+$/g, '');
}

/**
 * Python's difflib.SequenceMatcher(None, a, b).ratio() — longest-matching-block recursion with the default autojunk (a
 * character that is more than 1% of a 200+ character `b` no longer starts a match). Not symmetric: `a` is the candidate.
 * @param {string} a @param {string} b
 */
export function sequenceRatio(a, b) {
  /** @type {Map<string, number[]>} */ const b2j = new Map();
  for (let j = 0; j < b.length; j += 1) { const at = b2j.get(b[j]); if (at) at.push(j); else b2j.set(b[j], [j]); }
  if (b.length >= 200) { const popular = Math.floor(b.length / 100) + 1; for (const [char, at] of [...b2j]) if (at.length > popular) b2j.delete(char); }
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0, previous = new Map();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const size = (previous.get(j - 1) ?? 0) + 1;
        next.set(j, size);
        if (size > bestsize) { besti = i - size + 1; bestj = j - size + 1; bestsize = size; }
      }
      previous = next;
    }
    // Extend by equal characters on both sides (no isjunk, so nothing is junk and the popular ones extend too).
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti -= 1; bestj -= 1; bestsize += 1; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize += 1;
    return [besti, bestj, bestsize];
  };
  const queue = [[0, a.length, 0, b.length]];
  let matches = 0;
  while (queue.length) {
    const [alo, ahi, blo, bhi] = /** @type {number[]} */ (queue.pop());
    const [i, j, size] = longest(alo, ahi, blo, bhi);
    if (!size) continue;
    matches += size;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + size < ahi && j + size < bhi) queue.push([i + size, ahi, j + size, bhi]);
  }
  const total = a.length + b.length;
  return total ? (2 * matches) / total : 1;
}

/** score_arb.py titles_equal: equal, a prefix of five or more words (the official judge accepts truncation), or similarity >= 0.92. */
export function arbTitlesEqual(candidate, gold) {
  const a = arbNormTitle(candidate), b = arbNormTitle(gold);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (arbWords(short) >= 5 && long.startsWith(short)) return true;
  return sequenceRatio(a, b) >= 0.92;
}

/**
 * score_arb.py parse_answer: the region after the last "Final answer:" (no marker: the last 40 lines for deep, the whole
 * reply for wide), an explicit "None", and one candidate per line with the arXiv ids on it.
 * @param {string | null} text @param {'deep' | 'wide'} kind
 * @returns {{ isNone: boolean, candidates: Array<{ title: string, ids: string[] }>, extraction: 'final' | 'fallback' | 'empty' }}
 */
export function arbCandidates(text, kind) {
  const reply = isText(text) ? text : '';
  const last = [...reply.matchAll(ARB_FINAL)].at(-1);
  const extraction = last ? 'final' : 'fallback';
  const region = last ? reply.slice(last.index + last[0].length) : kind === 'deep' ? splitLines(reply.trim()).slice(-40).join('\n') : reply;
  const lines = splitLines(region).filter((line) => line.trim());
  if (!lines.length) return { isNone: false, candidates: [], extraction: 'empty' };
  if (ARB_NONE.test(lines[0].replace(/[*_`]+/g, '').trim()) && last) return { isNone: true, candidates: [], extraction };
  const candidates = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped === '---' || stripped === '***' || (/^#+\s/.test(stripped) && !arbIds(stripped).length)) continue;
    const ids = arbIds(line), title = arbCleanTitle(line);
    if (!ids.length && arbWords(title) < 3) continue;
    candidates.push({ title, ids });
  }
  // The "Final answer:" line itself may be followed by explanation lines; for deep only the first line is the answer.
  return { isNone: false, candidates: kind === 'deep' && last ? candidates.slice(0, 1) : candidates, extraction };
}

/**
 * score_deep: gold None is right only for an explicit None; otherwise the candidate's arXiv id equals the gold id, or its
 * title is the gold title (equal, truncated, or >= 0.92 similar). The official judge also sees titles between 0.50 and 0.92
 * similar (`needs_judge` in score_arb.py): this deterministic consumer does not, they count as not matched.
 * @param {string | null} answerText @param {{ gold: { titles: string[], arxiv_ids: string[], is_none: boolean } }} row @returns {0 | 1}
 */
export function arbDeepScore(answerText, row) {
  const parsed = arbCandidates(answerText, 'deep'), gold = row.gold;
  if (gold.is_none) return parsed.isNone ? 1 : 0;
  if (parsed.isNone || !parsed.candidates.length) return 0;
  const [candidate] = parsed.candidates, goldId = gold.arxiv_ids.length ? arbNormId(gold.arxiv_ids[0]) : '';
  if (goldId && candidate.ids.map(arbNormId).includes(goldId)) return 1;
  return arbTitlesEqual(candidate.title, gold.titles[0]) ? 1 : 0;
}

/**
 * score_wide: the IoU between the gold arXiv-id set and the ids of the answer's candidates; a line whose id is missing or
 * not in the gold set but whose title is a gold title is mapped to that gold id (the `iou` of score_arb.py, not `iou_strict`).
 * @param {string | null} answerText @param {{ gold: { titles: string[], arxiv_ids: string[] } }} row
 */
export function arbWideScore(answerText, row) {
  const parsed = arbCandidates(answerText, 'wide'), gold = row.gold;
  const goldSet = new Set(gold.arxiv_ids.filter(Boolean).map(arbNormId));
  const predicted = new Set();
  for (const candidate of parsed.candidates) {
    const ids = new Set(candidate.ids.map(arbNormId)), hit = [...ids].filter((id) => goldSet.has(id));
    if (hit.length) { for (const id of hit) predicted.add(id); continue; }
    const index = candidate.title && arbWords(candidate.title) >= 3 ? gold.titles.findIndex((title, at) => gold.arxiv_ids[at] && arbTitlesEqual(candidate.title, title)) : -1;
    if (index >= 0) predicted.add(arbNormId(gold.arxiv_ids[index]));
    else for (const id of ids) predicted.add(id);
  }
  if (!goldSet.size && !predicted.size) return 1;
  const common = [...goldSet].filter((id) => predicted.has(id)).length, union = new Set([...goldSet, ...predicted]).size;
  return union ? common / union : 0;
}

const arbRow = (kind) => (row) => isText(row?.category) && row?.gold?.type === kind && isTexts(row.gold.titles) && isTexts(row.gold.arxiv_ids)
  && row.gold.titles.length === row.gold.arxiv_ids.length && row.gold.titles.length > 0
  && (kind === 'deep' ? typeof row.gold.is_none === 'boolean' : row.gold.is_none !== true && row.gold.arxiv_ids.some(Boolean));

// --------------------------------------------------------------------------------------------------------------- registry

const stratum = Object.freeze({ registration: 'failureSlice', key: String, valid: (id) => isText(id) && id.length > 0 });
/**
 * id -> { benchmark: the `benchmark` a source must say, family: the statistics family label, baselineRevision, slice: where
 * the failure slice is registered (`registration[slice.registration]`) and which row field it names (`row[slice.row]`),
 * validRow, score }.
 */
export const SKILL_SCORERS = Object.freeze({
  medcalc: Object.freeze({ id: 'medcalc', benchmark: 'medcalc-bench', family: 'medcalc', baselineRevision: 'medcalc-open-domain-answer-no-personal-skill',
    slice: Object.freeze({ registration: 'failureCalculators', row: 'calculatorId', key: Number, valid: Number.isInteger }), validRow: medcalcRow, score: medcalcCorrect }),
  'bixbench-deterministic': Object.freeze({ id: 'bixbench-deterministic', benchmark: 'bixbench', family: 'bixbench', baselineRevision: 'bixbench-deterministic-open-domain-answer-no-personal-skill',
    slice: Object.freeze({ ...stratum, row: 'topic' }), validRow: bixbenchRow, score: bixbenchScore }),
  'arb-deep': Object.freeze({ id: 'arb-deep', benchmark: 'autoresearchbench-deep', family: 'arb-deep', baselineRevision: 'arb-deep-open-domain-answer-no-personal-skill',
    slice: Object.freeze({ ...stratum, row: 'category' }), validRow: arbRow('deep'), score: arbDeepScore }),
  'arb-wide': Object.freeze({ id: 'arb-wide', benchmark: 'autoresearchbench-wide', family: 'arb-wide', baselineRevision: 'arb-wide-open-domain-answer-no-personal-skill',
    slice: Object.freeze({ ...stratum, row: 'category' }), validRow: arbRow('wide'), score: arbWideScore }),
});

/** The scorer a registration names (`medcalc` when it names none), or null for an id outside the registry. @param {any} [registration] */
export function skillScorer(registration) {
  const id = registration?.scorer === undefined ? 'medcalc' : registration.scorer;
  return typeof id === 'string' && Object.hasOwn(SKILL_SCORERS, id) ? SKILL_SCORERS[id] : null;
}
