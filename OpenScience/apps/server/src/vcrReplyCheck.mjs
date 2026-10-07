/**
 * The numbers a 虚拟临床研究 conversation says it computed (R10, 2026-10-07; plan §8.4 item 7).
 *
 * The write path refuses a model any number it did not compute, and the delivered files are held to the same rule — but a reply in the
 * conversation is read by no code, so the analyst could say 「需要 850 例事件」 for an engine that computed 845. This is the reply
 * check's second look at a study's conversation: after the turn was shown, the numbers it reports as computed are held against the
 * study's own engine results. It is a notice and never a stop: a number not found gets the ⚠ the reply check already draws, with the
 * reason 「这个数没有在本研究的计算结果里找到」, and the reply stands as it was.
 *
 * Hidden knowledge:
 *
 * - **Which numbers are results is language; whether they are in the results is arithmetic.** The reviewer model reads the reply and
 *   lists, per sentence, the numbers it presents as something the platform computed (a sample size, events, power, assurance, an effect
 *   estimate, a count of generated records) — not a year, an ordinal, a citation marker, an id, or a setting the researcher gave. Code
 *   then re-verifies the checkable part twice: the number the model lists must be written in that sentence, and its value must (or
 *   must not) be in the study's results within rounding. A model that lists a number nobody wrote, or answers off the schema, has said
 *   nothing: a dropped verdict, never a softened one.
 * - **Found means within rounding.** 91.5% is 0.915; 11,800 is 11,799 to three significant digits; 91 is 91.5 to the unit it is
 *   printed in. The tolerance is half a unit of the last place printed, or of the third significant digit if that is coarser, and
 *   nothing else — no number is found because it is close in some other sense.
 * - **What the researcher set is not what the engine computed, and is not a violation.** The assumption cards, the designs' own sizes
 *   and the populations' parameters are the study's inputs: a reply that repeats them (「HR 0.7 的设定下」) reports a setting, and a
 *   number found among them is found. So are the differences between two designs' results, the way a comparison is said.
 * - **Failure keeps the reply.** No judgement means no verdict; the check is tried again within its attempts and, failing, says
 *   nothing about the reply.
 *
 * @module vcrReplyCheck
 */

/** Sentences of one reply the reviewer is shown. */
export const VCR_REPLY_SENTENCE_LIMIT = 40;
/** The reason on the ⚠ of a number the study's results do not hold. */
export const VCR_REPLY_NUMBER_REASON = "这个数没有在本研究的计算结果里找到";
/** What marks a verdict as this check's own (beside the reply check's `jev` and the reviewer's). */
export const VCR_REPLY_VERDICT_SOURCE = "vcr-results";

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);

const SENTENCE_END = /(?<=[。！？!?；;])|(?<=\.)(?=\s)|\n+/u;

/**
 * The sentences of a reply that contain a number, as the reviewer is shown them (the reference list and fenced code are not prose).
 * @param {string} replyText
 * @returns {Array<{ index: number, sentence: string }>}
 */
export function replyNumberSentences(replyText) {
  const prose = String(replyText ?? "").replace(/```[\s\S]*?```/g, " ");
  /** @type {Array<{ index: number, sentence: string }>} */
  const found = [];
  let index = 0;
  for (const part of prose.split(SENTENCE_END)) {
    const sentence = part.replace(/\s+/g, " ").trim();
    if (!sentence) continue;
    if (/\d/.test(sentence) && sentence.length <= 600) found.push({ index, sentence });
    index += 1;
    if (found.length >= VCR_REPLY_SENTENCE_LIMIT) break;
  }
  return found;
}

/**
 * A number as written: its value, how many decimals it was printed to, and whether it was a percentage.
 * @param {string} written
 * @returns {{ value: number, decimals: number, percent: boolean } | null}
 */
export function parseWrittenNumber(written) {
  const trimmed = String(written ?? "").trim();
  const match = /^[-+±]?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(%|％)?$/.exec(trimmed);
  if (!match) return null;
  const value = Number(`${match[1].replaceAll(",", "")}${match[2] ? `.${match[2]}` : ""}`);
  return Number.isFinite(value) ? { value, decimals: match[2]?.length ?? 0, percent: Boolean(match[3]) } : null;
}

/** @param {number} value */
const exponentOf = (value) => (value === 0 ? 0 : Math.floor(Math.log10(Math.abs(value))));

/**
 * Whether a number as written is one of the study's numbers, within rounding. A percentage is also read as the proportion it is.
 * @param {{ value: number, decimals: number, percent: boolean }} written @param {readonly number[]} candidates
 */
export function numberIsFound({ value, decimals, percent }, candidates) {
  // Half a unit of the last place printed, or of the third significant digit when that is coarser (11,800 is 11,799 to three digits).
  const tolerance = (/** @type {number} */ of, /** @type {number} */ places) => Math.max(0.5 * 10 ** -places, 0.5 * 10 ** (exponentOf(of) - 2)) + 1e-9;
  const wanted = percent ? [[value, decimals], [value / 100, decimals + 2]] : [[value, decimals]];
  return candidates.some((candidate) => wanted.some(([target, places]) => Math.abs(candidate - target) <= tolerance(target, places)));
}

/**
 * Every finite number in a stored value, to a bounded depth and count: what an engine result holds.
 * @param {unknown} value @param {number[]} out @param {number} [depth]
 */
export function collectNumbers(value, out, depth = 0) {
  if (out.length >= 20_000 || depth > 7) return out;
  if (typeof value === "number") { if (Number.isFinite(value)) out.push(value); return out; }
  if (Array.isArray(value)) { for (const item of value) collectNumbers(item, out, depth + 1); return out; }
  if (value && typeof value === "object") { for (const item of Object.values(value)) collectNumbers(item, out, depth + 1); }
  return out;
}

/**
 * The numbers a study holds: what its engine computed, what was set as an input, and the differences between designs' results.
 * Every proportion is held as the percentage a reader says it in as well.
 *
 * @param {{ results?: ReadonlyArray<Record<string, any>>, inputs?: ReadonlyArray<unknown>, executions?: ReadonlyArray<Record<string, any>> }} facts
 *   `results`: stored results (measures, counts, diagnostics); `inputs`: assumption cards, scenarios, populations and the like, as stored;
 *   `executions`: what each job ran (replicates)
 * @returns {number[]}
 */
export function studyNumbers({ results = [], inputs = [], executions = [] }) {
  /** @type {number[]} */
  const held = [];
  /** @type {Map<string, number[]>} */
  const byMeasure = new Map();
  for (const result of results) {
    collectNumbers(result.measures, held);
    collectNumbers(result.counts, held);
    collectNumbers(result.diagnostics, held);
    for (const measure of list(result.measures).map(object)) {
      if (typeof measure.name !== "string" || !Number.isFinite(measure.value)) continue;
      byMeasure.set(measure.name, [...(byMeasure.get(measure.name) ?? []), Number(measure.value)]);
    }
  }
  for (const input of inputs) collectNumbers(input, held);
  for (const execution of executions) collectNumbers([execution.replicates, execution.seed], held);
  // A comparison of two designs is said as a difference (「多 105 例事件」) of two numbers the engine computed.
  for (const values of byMeasure.values()) {
    const distinct = [...new Set(values)].slice(0, 40);
    for (let at = 0; at < distinct.length; at += 1) for (let other = at + 1; other < distinct.length; other += 1) held.push(Math.abs(distinct[at] - distinct[other]));
  }
  const withPercent = held.flatMap((number) => (Number.isFinite(number) && Math.abs(number) <= 1 && number !== 0 ? [number, number * 100] : [number]));
  return [...new Set(withPercent)];
}

/** What the reviewer is asked, and the one shape it answers in. */
export function vcrReplySystemPrompt() {
  return [
    "你核对一段「虚拟临床研究」对话里的回答。这个平台的统计引擎替研究算出样本量、事件数、功效、成功把握、效应估计、生成的记录数这类数；回答里应该只转述它们，不能自己心算。",
    "你拿到的是回答里含数字的句子（S0、S1…）。对每一句，列出它当作「平台算出的结果」讲的那些数，按它在句子里写的样子逐字抄出（例如 91.5%、11,799、845）。",
    "不要列：年份和日期、序号和步骤号、方括号里的引用编号、各种编号和代号、数据档位（T0–T3）、研究者自己给的设定（例如「HR 0.7」「α 0.025」「每组 100 人」这类说成假设或设定的数），也不要列问句里的数。句子没有把任何数当作算出来的结果，就不要列它。",
    "numbers 里每个数必须是句子里原样出现的文字。只输出这个结构。",
  ].join("\n");
}

/** @param {ReadonlyArray<{ index: number, sentence: string }>} sentences */
export function vcrReplyMessage(sentences) {
  return ["<sentences>", ...sentences.map((entry) => `S${entry.index}：${entry.sentence}`), "</sentences>"].join("\n");
}

/** The answer's shape: per sentence, the numbers it reports as computed. */
export const VCR_REPLY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      maxItems: VCR_REPLY_SENTENCE_LIMIT,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sentence", "numbers"],
        properties: { sentence: { type: "integer", minimum: 0 }, numbers: { type: "array", maxItems: 12, items: { type: "string", maxLength: 40 } } },
      },
    },
  },
});

/**
 * The model's claims, held to what code can re-read: a sentence it was shown, and numbers that are written in it. Anything else is dropped.
 * @param {unknown} answer @param {ReadonlyArray<{ index: number, sentence: string }>} sentences
 * @returns {Array<{ index: number, sentence: string, numbers: Array<{ written: string, parsed: { value: number, decimals: number, percent: boolean } }> }>}
 */
export function acceptReplyClaims(answer, sentences) {
  const shown = new Map(sentences.map((entry) => [entry.index, entry.sentence]));
  /** @type {Map<number, Array<{ written: string, parsed: { value: number, decimals: number, percent: boolean } }>>} */
  const claimed = new Map();
  for (const claim of list(object(answer).claims).map(object)) {
    const sentence = Number.isInteger(claim.sentence) ? shown.get(claim.sentence) : undefined;
    if (sentence === undefined) continue;
    for (const written of list(claim.numbers)) {
      if (typeof written !== "string") continue;
      const parsed = parseWrittenNumber(written);
      if (!parsed || !sentence.includes(written.trim())) continue;
      const own = claimed.get(claim.sentence) ?? [];
      if (!own.some((entry) => entry.written === written.trim())) own.push({ written: written.trim(), parsed });
      claimed.set(claim.sentence, own);
    }
  }
  return [...claimed.entries()].sort((a, b) => a[0] - b[0]).map(([index, numbers]) => ({ index, sentence: /** @type {string} */ (shown.get(index)), numbers }));
}

/**
 * The reply check's verdicts for a reply's computed numbers: a ⚠ (`unsupported`, the verdict the ⚠ is drawn for) on each sentence that
 * reports a number the study does not hold, carrying the reason and the numbers; nothing for a sentence whose numbers are all found.
 *
 * @param {{ claims: ReturnType<typeof acceptReplyClaims>, candidates: readonly number[], indexOffset?: number }} input
 *   `indexOffset` keeps these sentences' indexes apart from the citation check's own, which counts sentences differently
 */
export function vcrReplyVerdicts({ claims, candidates, indexOffset = 1000 }) {
  /** @type {any[]} */
  const verdicts = [];
  for (const claim of claims) {
    const missing = claim.numbers.filter((entry) => !numberIsFound(entry.parsed, candidates));
    if (!missing.length) continue;
    verdicts.push({
      sentence: indexOffset + claim.index, verdict: "unsupported", reason: `${VCR_REPLY_NUMBER_REASON}：${missing.map((entry) => entry.written).join("、")}`,
      evidence: "", safety: "none", by: VCR_REPLY_VERDICT_SOURCE, text: claim.sentence, numbers: [], source: null,
    });
  }
  return verdicts;
}
